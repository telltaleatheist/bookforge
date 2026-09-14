/**
 * THE HISS PASS ON SOMEBODY ELSE'S CARD — the `denoise` door.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `electron/denoise-bridge.ts` strips the hiss bed out of a session's rendered
 * sentences by concatenating them into ~22-minute blocks at 44.1 kHz, running
 * ONE resident `audio-separator` process (`separator_worker.py` in the rvc-env)
 * over each block, and slicing the `(dry)` stem back at the recorded sample
 * offsets. A Crucible `denoise` job is the middle step of that and nothing else
 * (crucible `docs/PHASE4-AUDIO.md` §4.2): one audio input, every stem back as an
 * artifact, and `done` naming which one is primary.
 *
 * **Blocking stays in the client, by contract.** §4.2: "The app concatenates a
 * book's sentences into ~22-minute blocks, denoises each, and slices the stems
 * back at recorded offsets. Crucible denoises one thing at a time." So this
 * module is deliberately NOT a whole-pass door: it is a {@link BlockSeparator},
 * the same three methods the resident local worker offers, so `denoise-bridge`
 * builds the blocks, checks the invariants and slices the result identically
 * whichever machine ran the model.
 *
 * ── `params` is empty, and that is the contract ────────────────────────────
 *
 * Every knob audio-separator takes is an engine default BookForge measured and
 * left alone, and `use_autocast` is read off the BACKEND rather than off a
 * request. The server validates `params` with `extra="forbid"`, so a key added
 * here would be a named refusal rather than an ignored field — which is the
 * point: `{}` is a statement, not an omission. The local pass has no per-run
 * knob to lose, so nothing is dropped and nothing needs refusing.
 *
 * ── Two names for one model, both stated ───────────────────────────────────
 *
 * Locally the model is a CHECKPOINT FILENAME inside the pinned
 * `audio-separator-models` directory (`denoise_mel_band_roformer_aufr33_sdr_27.9959.ckpt`),
 * because that is how audio-separator resolves one. On a Crucible it is a
 * MANIFEST ID (`denoise-roformer`), whose `crucible denoise pull` places that
 * same checkpoint and its config by pinned digest. Neither is derived from the
 * other, so both are written down (§4.2: "audio-separator resolves a model by
 * filename … while the bytes come from paths that are named differently").
 *
 * ── The primary stem is the SERVER's to name ───────────────────────────────
 *
 * The local pass finds the denoised audio by looking for `(dry)` in the stem's
 * filename. This door does NOT re-do that: `done` names the primary stem, and
 * §4.2 makes "exactly one output names the primary stem" an invariant the
 * server enforces (zero means the model produced something other than what the
 * manifest says; two means nothing can say which one is the denoised audio).
 * Reading the name back off the filename here would be a second owner of a fact
 * the server states — and the day the manifest's primary marker changes, the
 * local spelling would silently pick a different stem. A `done` that names no
 * primary is refused by name rather than guessed at.
 *
 * The 44.1 kHz rate and the sample-exact length are still checked by
 * `denoise-bridge` on the file that lands, because those are ITS invariants:
 * the offsets it is about to slice at are only safe if the block came back the
 * length it went up.
 */

import * as fs from 'fs';
import * as path from 'path';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import { assertCrucibleModelOffered, runCrucibleJob } from './job';
import type { VenueHost } from './generation-venue';
import { venueForRunStep, type RunVenue, type StepVenue } from './step-venue';

/**
 * The Crucible `denoise` manifest id. One model ships (`crucible denoise list`),
 * and it is the same checkpoint the local pass uses.
 */
export const CRUCIBLE_DENOISE_MODEL = 'denoise-roformer';

/** A job, a server or a `done` frame this door cannot work with, named. */
export class CrucibleDenoiseRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleDenoiseRefused';
    this.code = code;
  }
}

/**
 * ONE BLOCK IN, THE PRIMARY STEM OUT — the seam `denoise-bridge` drives.
 *
 * The local implementation is a resident `separator_worker.py` whose model is
 * read once for the whole book; the Crucible implementation is one job per
 * block, where residency is the server's business. Both answer the same three
 * questions, so the block building, the invariant checks and the offset slicing
 * around them are written once.
 */
export interface BlockSeparator {
  /**
   * The line to log BEFORE `start`, which can take 10-25 s locally while the
   * checkpoint is read. Without it that silence reads as a hang — the note
   * `denoise-bridge`'s own `onLog` doc makes, kept as a method so the sentence
   * names the venue rather than asserting a model load that a remote pass does
   * not do here.
   */
  starting(blocks: number): string;
  /**
   * Ready the engine. Returns the line for the job log — the local one reports
   * how long the checkpoint took to become resident, which is the whole reason
   * that class exists; the remote one reports which server will do the work.
   */
  start(workDir: string, blocks: number): Promise<string>;
  /** Separate ONE block into `outDir`; resolves with the PRIMARY stem's path. */
  separate(inputPath: string, outDir: string): Promise<string>;
  /** Release whatever `start` took. Safe to call twice. */
  dispose(): Promise<void>;
}

export interface CrucibleBlockSeparatorOptions {
  readonly server: string;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

/**
 * A {@link BlockSeparator} whose worker is a Crucible `denoise` job per block.
 *
 * `start` asks the server ONCE whether it offers `denoise` and this model — a
 * host with the rvc env but no separator checkpoint has `enable_denoise` off,
 * and finding that out after a book's blocks have been built and one has
 * crossed the wire is twenty minutes of ffmpeg for a named refusal that could
 * have arrived first.
 *
 * There is no residency to hold between blocks and none is asked for: each job
 * is its own admission, and if another client takes the lane between block 3 and
 * block 4 the refusal is `server_busy` with the holder's name, which is a real
 * answer. Nothing here waits or retries.
 */
export function crucibleBlockSeparator(options: CrucibleBlockSeparatorOptions): BlockSeparator {
  const { server } = options;
  const log = options.onLog ?? (() => undefined);
  let checked = false;

  return {
    starting(blocks: number): string {
      return `Final denoise: ${blocks} block(s) will be denoised on crucible "${server}" — `
        + 'one job each, nothing is loaded on this machine.';
    },

    async start(_workDir: string, blocks: number): Promise<string> {
      const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
      await assertCrucibleModelOffered(client, server, 'denoise', CRUCIBLE_DENOISE_MODEL);
      checked = true;
      return `Final denoise: crucible "${server}" offers ${CRUCIBLE_DENOISE_MODEL} — `
        + `${blocks} block(s) will each be one job.`;
    },

    async separate(inputPath: string, outDir: string): Promise<string> {
      if (!checked) {
        throw new CrucibleDenoiseRefused(
          'crucible_denoise_not_started',
          'a block was sent before the server was asked whether it offers denoise. start() is '
          + 'what asks, and skipping it would put the refusal after the upload.',
        );
      }
      if (!fs.existsSync(outDir)) {
        throw new CrucibleDenoiseRefused(
          'crucible_denoise_out_dir_missing',
          `the stems were to land in ${outDir}, which does not exist. The caller creates it.`,
        );
      }
      const name = path.basename(inputPath);
      const outcome = await runCrucibleJob({
        server,
        type: 'denoise',
        model: CRUCIBLE_DENOISE_MODEL,
        // EMPTY BY CONTRACT — see the header. Not an omission.
        params: {},
        inputs: { [name]: inputPath },
        artifactsTo: outDir,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onLog: log,
      });

      if (outcome.artifacts.where !== 'disk') {
        throw new CrucibleDenoiseRefused(
          'crucible_denoise_stems_not_on_disk', 'the stems were not written to disk',
        );
      }
      const primary = outcome.done.extra['primary'];
      if (typeof primary !== 'string' || primary === '') {
        throw new CrucibleDenoiseRefused(
          'crucible_denoise_primary_unnamed',
          `crucible "${server}" job ${outcome.jobId} ended done without naming the primary stem `
          + `(done.extra.primary = ${JSON.stringify(primary ?? null)}). PHASE4-AUDIO.md §4.2 makes `
          + '"exactly one output names the primary stem" the server\'s invariant, and picking one '
          + 'here by its filename would make this side a second owner of which stem is the '
          + 'denoised audio.',
        );
      }
      const written = outcome.artifacts.files.get(primary);
      if (written === undefined) {
        throw new CrucibleDenoiseRefused(
          'crucible_denoise_primary_missing',
          `crucible "${server}" job ${outcome.jobId} named "${primary}" as the primary stem and did `
          + `not write it (it wrote: ${[...outcome.artifacts.files.keys()].join(', ') || 'nothing'}).`,
        );
      }
      log(`crucible "${server}" denoised ${name}: primary stem "${primary}" of `
        + `${outcome.artifacts.files.size} artifact(s)`);
      return written.path;
    },

    async dispose(): Promise<void> {
      // Nothing is held between blocks: each job is its own admission and the
      // server owns the model's residency. Present so the caller's `finally`
      // does not have to know which separator it has.
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The door: where this denoise runs
// ─────────────────────────────────────────────────────────────────────────────

export interface DenoiseAtVenueOptions<T> {
  /** THE RUN'S ALREADY-RESOLVED VENUE, when the caller has one. A later step follows its run. */
  readonly runVenue?: RunVenue;
  /** Where `runVenue` was read from, for the log. */
  readonly runVenueSource?: string;
  /** The caller's own server name, when it named one. Must AGREE with `runVenue`. */
  readonly crucible?: { readonly server: string };
  /** The routing record and the network — `processVenueHost()` in the app, a fixture in a keeper. */
  readonly host: VenueHost;
  readonly onLog?: (line: string) => void;
  /**
   * The pass with its blocks separated HERE — the resident `separator_worker.py`
   * in the rvc-env, exactly as it has always run. Called only when the legacy
   * switch is on; never as a fallback.
   */
  readonly legacyLocal: () => Promise<T>;
  /**
   * The same pass with its blocks separated on `server`.
   *
   * Two callbacks rather than one arm built here because the block machinery —
   * the ffmpeg transcodes, the concat, the offsets manifest, the frame-exact
   * checks, the slicing — lives in `denoise-bridge.ts`, which imports THIS
   * module for {@link crucibleBlockSeparator}. Building the remote arm here
   * would make that import a cycle; this way the dependency runs one way and
   * the venue decision still has one home.
   */
  readonly onCrucibleServer: (server: string) => Promise<T>;
}

export interface DenoiseAtVenueOutcome<T> {
  readonly venue: StepVenue;
  /** Whatever the arm that ran produced — the caller's own type, carried through. */
  readonly outcome: T;
}

/**
 * Where this denoise runs, and run it there. The run's venue when it has one,
 * else the ONE decision every other GPU door makes. No second switch, no
 * fallback: with the legacy switch off and no server reachable this THROWS with
 * the reason.
 */
export async function denoiseAtVenue<T>(
  options: DenoiseAtVenueOptions<T>,
): Promise<DenoiseAtVenueOutcome<T>> {
  const log = options.onLog ?? (() => undefined);
  const venue = await venueForRunStep({
    ...(options.runVenue === undefined ? {} : { runVenue: options.runVenue }),
    ...(options.runVenueSource === undefined ? {} : { runVenueSource: options.runVenueSource }),
    ...(options.crucible === undefined ? {} : { callerNamed: options.crucible }),
    host: options.host,
  });
  if (venue.where === 'legacy-local-narrator') {
    log(`the denoise runs on the local audio-separator spawn — ${venue.origin}: ${venue.because}`);
    return { venue, outcome: await options.legacyLocal() };
  }
  log(`the denoise runs on crucible "${venue.server}" — ${venue.origin}: ${venue.because}`);
  return { venue, outcome: await options.onCrucibleServer(venue.server) };
}
