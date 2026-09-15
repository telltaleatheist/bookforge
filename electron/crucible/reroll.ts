/**
 * A SENTENCE RE-ROLL ON SOMEBODY ELSE'S CARD — the "Correct Sentences" door.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `electron/correct-sentences-bridge.ts` re-renders a scattered handful of
 * sentence indices so a person can audition fresh takes and approve one. It
 * does it through `parallel-tts-bridge.regenerateSentenceIndices`, which spawns
 * the same narrator worker a book render spawns, with `--sentence_indices` and
 * a scratch `--sentences_dir`, and the worker writes `take<k>/<index>.flac`.
 *
 * A Crucible `tts` render job does exactly that shape already: **a named list of
 * chunks, one `<index>.flac` artifact each.** Unlike the streaming door this
 * path HAS a denominator — the operator picked the indices — so the server can
 * report a real percentage and the take dirs fill in the same order they do
 * locally. This module is that swap.
 *
 * ── ONE KNOB HAS NO CHANNEL, AND IT IS REFUSED, NOT DROPPED ────────────────
 *
 * The local path spreads the takes across sampling temperatures
 * (`computeTakeTemperatures`: 0.4 / 0.8 / 1.0 around Orpheus's 0.6) because
 * "temp 0.6 alone barely moves the reading" — that is `--take_temperatures` on
 * the worker's argv. **`RenderOptions` carries no sampling channel at all.**
 * PHASE6-REMOTE-RENDER.md §1 took `take` out of the client's business
 * altogether: the ladder's rungs are engine config, `take: 0` means "the
 * engine's own sampling", and there is no per-request temperature, top-p or
 * seed on the wire.
 *
 * So {@link runCrucibleReroll} REFUSES a caller that hands it temperatures
 * (`crucible_reroll_take_temperatures_unsupported`) instead of sending the job
 * without them and calling it the same thing. What it offers instead is N takes
 * as N jobs at take 0: genuinely different readings, because narrator's sampling
 * is unseeded — which is what makes a re-roll a re-roll — but NOT the widened
 * spread the local path gets. A caller that wants the spread has the legacy
 * switch and must take it knowingly.
 *
 * **RULING OWED** (already recorded in docs/CRUCIBLE_ROLLOUT_PLAN.md's 01:20
 * entry as *"take>0 needs a per-request sampling channel"*): does `tts` grow a
 * per-request sampling block, so a re-roll can ask for its spread; or is the
 * spread engine config keyed off the take rung, so `take: 1..3` IS the spread?
 * Until one of those exists, a remote re-roll and a local one are not the same
 * pass, and this module says so rather than hiding it.
 *
 * ── What travels, and what does not ────────────────────────────────────────
 *
 * **The TEXT travels.** A local re-roll sends no text: the worker reads
 * `chapter_sentences` out of the session itself and applies
 * `--sentence_overrides` on top. A Crucible has no session, so the caller sends
 * each chunk's STORED text — markers and all, with an edit already folded back
 * into the row's own marker runs by `storedTextForCorrection`. That is the exact
 * string `render/worker.py:_text_for` would have used, which is what keeps the
 * take a drop-in for the file it replaces.
 *
 * **The verdicts travel, into the existing sink.** Every `chunk` event's guard
 * goes to `electron/chunk-guard-ledger.ts` through `render-artifacts.ts` — the
 * same writer the book render feeds — keyed `<renderId>#take<k>`. Its own key
 * per take, because each take is a separate render of the same index and a
 * summary that pooled three takes of one sentence would report three chunks.
 *
 * **The sample-format match does not travel and must not.** The bridge
 * transcodes every candidate to the book's own `sample_fmt` before it can enter
 * the cache (a mixed-bit-depth `-c:a flac` concat SILENTLY DROPS the sentence).
 * That is the bridge's step, after this one, unchanged.
 *
 * **NO LEASE HERE.** This is ONE job on the lane, and a job already holds
 * everything a Crucible lease would hold — see `job.ts`'s header for the whole
 * argument, and `lease.ts` for the chat-shaped doors that do lease.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RenderChunk, RenderResult } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import {
  assertCrucibleVoiceAvailable,
  crucibleVoiceFor,
  describeCrucibleRefusal,
  CRUCIBLE_RENDER_TAKE,
} from './render';
import { downloadRenderArtifacts } from './render-artifacts';
import type { ChunkGuardSummary } from '../chunk-guard-ledger';
import type { VenueHost } from './generation-venue';
import { venueForRunStep, type RunVenue, type StepVenue } from './step-venue';

/** A re-roll this door cannot ask a Crucible for, named. */
export class CrucibleRerollRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleRerollRefused';
    this.code = code;
  }
}

/** How the local worker names a take's directory under the scratch root. */
export function takeDirName(take: number): string {
  return `take${take}`;
}

export interface CrucibleRerollProgress {
  /** 0-based take this frame belongs to. */
  readonly take: number;
  /** The SERVER's own fraction for that take's job. Never re-derived here. */
  readonly fraction: number;
  readonly message: string;
  /** `<index>.flac` files landed across EVERY take so far. */
  readonly written: number;
  /** Indices × takes — the denominator this pass actually has. */
  readonly total: number;
}

export interface CrucibleRerollTake {
  readonly take: number;
  readonly jobId: string;
  /** `<targetDir>/take<k>`, where its `<index>.flac` landed. */
  readonly dir: string;
  readonly written: number;
  readonly result: RenderResult;
  /** Keyed `<renderId>#take<k>` in the ledger. */
  readonly guard: ChunkGuardSummary;
}

export interface RunCrucibleRerollOptions {
  readonly server: string;
  /**
   * BookForge's own id for this correction pass — the session id. Keys the guard
   * ledger (suffixed per take), so a re-roll's verdicts are their own record and
   * never merge into the book render's summary.
   */
  readonly renderId: string;
  /** The session's engine. Only `higgs` maps; see `crucibleVoiceFor`. */
  readonly ttsEngine: string;
  /** BookForge's catalog voice id for the session (`higgsModelForJob(settings).id`). */
  readonly voiceId: string;
  /** The session's language tag. Never guessed. */
  readonly language: string;
  /** Exactly the indices being re-rolled, with the STORED text each should speak. */
  readonly chunks: readonly RenderChunk[];
  /** The scratch root the bridge made. `take<k>/` subdirectories are created inside it. */
  readonly targetDir: string;
  /** How many fresh takes per index. Default 1. */
  readonly takes?: number;
  /**
   * The local path's per-take sampling temperatures. REFUSED BY NAME — the `tts`
   * wire has no sampling channel. See the header.
   */
  readonly takeTemperatures?: readonly number[];
  readonly onProgress?: (progress: CrucibleRerollProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface CrucibleRerollOutcome {
  readonly takes: readonly CrucibleRerollTake[];
  /** `<index>.flac` files written across every take. */
  readonly written: number;
}

/**
 * Re-roll exactly these chunks on a Crucible, landing `take<k>/<index>.flac`
 * under `targetDir` the way the local worker does.
 *
 * One `tts` job per take. Each job carries the whole index list, so the server
 * has a denominator and the voice is loaded once per take rather than once per
 * sentence. A chunk the server could not render has no file and is named in
 * that take's `result.failed` — the bridge already treats a missing take as
 * "this take missing for this index" and shows the ones that did land.
 */
export async function runCrucibleReroll(
  options: RunCrucibleRerollOptions,
): Promise<CrucibleRerollOutcome> {
  const { server, renderId, targetDir } = options;
  const log = options.onLog ?? (() => undefined);

  if (typeof server !== 'string' || server.trim() === '') {
    throw new CrucibleRerollRefused(
      'crucible_server_not_named',
      'a Crucible re-roll needs the NAME of a registered server (or "local"). It is not a URL and '
      + 'there is no default server.',
    );
  }
  if (typeof renderId !== 'string' || renderId === '') {
    throw new CrucibleRerollRefused(
      'crucible_reroll_not_identified',
      'a Crucible re-roll needs BookForge\'s own id for the pass: it keys the guard ledger, and an '
      + 'empty one would pool every correction\'s chunks into a single summary.',
    );
  }
  if (options.takeTemperatures !== undefined) {
    throw new CrucibleRerollRefused(
      'crucible_reroll_take_temperatures_unsupported',
      `this re-roll asked for per-take sampling temperatures (${[...options.takeTemperatures].join(', ')}), `
      + 'which a Crucible tts render has no channel for: RenderOptions carries voice, language, take '
      + 'and chunks, and PHASE6-REMOTE-RENDER.md §1 removed the rung from the client\'s business '
      + 'entirely — there is no per-request temperature, top-p or seed on the wire. Sending the job '
      + 'without them and calling it the same pass would be a silent substitution. Ask for N takes '
      + 'instead (N jobs at take 0, genuinely different because narrator\'s sampling is unseeded, but '
      + 'NOT the widened spread), or re-roll with the local narrator. RULING OWED: a per-request '
      + 'sampling channel on tts, or the spread as engine config keyed off the take rung.',
    );
  }
  if (typeof targetDir !== 'string' || targetDir === '' || !fs.existsSync(targetDir)) {
    throw new CrucibleRerollRefused(
      'crucible_reroll_target_missing',
      `the takes were to land under ${JSON.stringify(targetDir)}, which does not exist. The bridge `
      + 'creates the scratch root; creating it here would turn a typo into an empty directory that '
      + 'reads as a re-roll which produced nothing.',
    );
  }
  if (!Array.isArray(options.chunks) || options.chunks.length === 0) {
    throw new CrucibleRerollRefused(
      'crucible_reroll_no_chunks',
      'a Crucible re-roll was asked for with no chunks. An empty list is not "nothing to correct" — '
      + 'it is a caller that computed the wrong set.',
    );
  }
  for (const chunk of options.chunks) {
    if (typeof chunk.index !== 'number' || !Number.isInteger(chunk.index) || chunk.index < 0) {
      throw new CrucibleRerollRefused(
        'crucible_reroll_index_unreadable',
        `a chunk carries index ${JSON.stringify(chunk.index)}, which is not a sentence ordinal. The `
        + 'index is the artifact\'s whole name (<index>.flac) and the file the take replaces.',
      );
    }
    if (typeof chunk.text !== 'string' || chunk.text.trim() === '') {
      throw new CrucibleRerollRefused(
        'crucible_reroll_text_missing',
        `chunk ${chunk.index} has no text. A Crucible has no session to read chapter_sentences out `
        + 'of, so the caller sends the stored row; an empty one would render silence into a file the '
        + 'operator is about to approve.',
      );
    }
  }
  if (typeof options.language !== 'string' || options.language.trim() === '') {
    throw new CrucibleRerollRefused(
      'crucible_reroll_language_not_named',
      'a Crucible re-roll needs the language tag the session was rendered in. The server refuses a '
      + 'missing one rather than picking.',
    );
  }
  const takes = options.takes ?? 1;
  if (!Number.isInteger(takes) || takes < 1) {
    throw new CrucibleRerollRefused(
      'crucible_reroll_takes_unreadable',
      `takes is ${JSON.stringify(options.takes)}; it must be a whole number of fresh readings, at least one.`,
    );
  }

  // Throws CrucibleRenderRefused by name for a non-Higgs engine, an override
  // checkpoint that lives only on this machine, and a zero-shot voice.
  const voice = crucibleVoiceFor(options.ttsEngine, options.voiceId);
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  // Before the first submit: does this server serve that voice, and can it load
  // it. One GET for the whole pass rather than one per take.
  await assertCrucibleVoiceAvailable(client, server, voice);

  const total = options.chunks.length * takes;
  let written = 0;
  const results: CrucibleRerollTake[] = [];

  for (let take = 0; take < takes; take += 1) {
    if (options.signal?.aborted) {
      throw new CrucibleRerollRefused(
        'crucible_reroll_cancelled',
        `the re-roll was cancelled after ${take} of ${takes} take(s); what landed is on disk.`,
      );
    }
    const dir = path.join(targetDir, takeDirName(take));
    fs.mkdirSync(dir, { recursive: true });

    log(`crucible "${server}": submitting take ${take} of ${takes} — ${options.chunks.length} `
      + `chunk(s) as voice "${voice}"`);
    let jobId: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- takes are serial: one exclusive lane at a time
      jobId = await client.render({
        voice,
        language: options.language.trim(),
        take: CRUCIBLE_RENDER_TAKE,
        chunks: options.chunks,
      });
    } catch (err) {
      throw describeCrucibleRefusal(err, server);
    }

    // CANCELLATION IS A CANCEL, NOT A HANG-UP — abandoning the stream would
    // leave the job running and holding the lane. The stream then runs on to
    // the `cancelled` frame, which is what makes this a reported cancellation.
    const onAbort = (): void => {
      void client.cancel(jobId).catch((err) => {
        log(`cancel of crucible "${server}" job ${jobId} was not accepted: `
          + `${err instanceof Error ? err.message : String(err)}`);
      });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      // eslint-disable-next-line no-await-in-loop -- serial, as above
      const outcome = await downloadRenderArtifacts({
        server,
        jobId,
        // Its OWN ledger key per take: three takes of one sentence are three
        // renders, not three chunks of one render.
        renderId: `${renderId}#${takeDirName(take)}`,
        sentencesDir: dir,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onWritten: (file) => {
          if (/^\d+\.flac$/.test(file.name)) written += 1;
        },
        onEvent: (event) => {
          if (event.event !== 'progress' || options.onProgress === undefined) return;
          options.onProgress({
            take, fraction: event.data.fraction, message: event.data.message, written, total,
          });
        },
      }).catch((err) => {
        throw describeCrucibleRefusal(err, server);
      });
      if (outcome.result.failed.length > 0) {
        log(`crucible job ${jobId} (take ${take}): ${outcome.result.failed.length} chunk(s) produced `
          + `no audio — ${outcome.result.failed.slice(0, 8).map((f) => `${f.index}: ${f.message}`).join('; ')}`);
      }
      results.push({
        take, jobId, dir, written: outcome.written, result: outcome.result, guard: outcome.guard,
      });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  log(`crucible "${server}" re-rolled ${options.chunks.length} sentence(s) × ${takes} take(s): `
    + `${written} file(s) under ${path.basename(targetDir)}`);
  return { takes: results, written };
}

// ─────────────────────────────────────────────────────────────────────────────
// The door: where this re-roll runs
// ─────────────────────────────────────────────────────────────────────────────

export interface RerollAtVenueOptions {
  /** THE RUN'S ALREADY-RESOLVED VENUE — the session's own `settings.crucible.server`. */
  readonly runVenue?: RunVenue;
  /** Where `runVenue` was read from, for the log. */
  readonly runVenueSource?: string;
  /** The caller's own server name, when it named one. Must AGREE with `runVenue`. */
  readonly crucible?: { readonly server: string };
  /** The routing record and the network — `processVenueHost()` in the app, a fixture in a keeper. */
  readonly host: VenueHost;
  readonly renderId: string;
  readonly ttsEngine: string;
  readonly voiceId: string;
  readonly language: string;
  readonly chunks: readonly RenderChunk[];
  readonly targetDir: string;
  readonly takes?: number;
  readonly takeTemperatures?: readonly number[];
  readonly onProgress?: (progress: CrucibleRerollProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface RerollAtVenueOutcome {
  readonly venue: StepVenue;
  /** Present when a Crucible did the work. */
  readonly crucible?: CrucibleRerollOutcome;
}

/**
 * Where this re-roll runs, and run it there. The run's venue when it has one,
 * else the ONE decision every other GPU door makes. No local narrator spawn and
 * no fallback to one.
 */
export async function rerollAtVenue(options: RerollAtVenueOptions): Promise<RerollAtVenueOutcome> {
  const log = options.onLog ?? (() => undefined);
  const venue = await venueForRunStep({
    ...(options.runVenue === undefined ? {} : { runVenue: options.runVenue }),
    ...(options.runVenueSource === undefined ? {} : { runVenueSource: options.runVenueSource }),
    ...(options.crucible === undefined ? {} : { callerNamed: options.crucible }),
    host: options.host,
  });
  log(`the sentence re-roll runs on crucible "${venue.server}" — ${venue.origin}: ${venue.because}`);
  const crucible = await runCrucibleReroll({
    server: venue.server,
    renderId: options.renderId,
    ttsEngine: options.ttsEngine,
    voiceId: options.voiceId,
    language: options.language,
    chunks: options.chunks,
    targetDir: options.targetDir,
    ...(options.takes === undefined ? {} : { takes: options.takes }),
    ...(options.takeTemperatures === undefined ? {} : { takeTemperatures: options.takeTemperatures }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    onLog: log,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { venue, crucible };
}
