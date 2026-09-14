/**
 * VOICE CONVERSION ON SOMEBODY ELSE'S CARD — the `rvc` door.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `electron/rvc-bridge.ts` re-renders a session's sentence FLACs through an RVC
 * voice by spawning the BookForge fork of ultimate-rvc
 * (`python -m ultimate_rvc.cli.main generate convert-dir`) out of the rvc-env,
 * in batches of 96 files so the OS reclaims what urvc leaks. A Crucible `rvc`
 * job runs the same fork, at a pinned commit, on a server (crucible
 * `docs/PHASE4-AUDIO.md` §4): one input per file, one artifact per input under
 * the SAME NAME, and the recycling happens inside the server because it is a
 * memory bound rather than a throughput choice. This module is the swap — the
 * FLACs go up, the converted FLACs land in the directory the local pass would
 * have written, and `rvc-job.ts`'s staging, manifest and commit behind it
 * cannot tell which machine converted the book.
 *
 * ── The model id table ─────────────────────────────────────────────────────
 *
 * BookForge names an RVC voice by ASSET id (`rvc-voice-sigma`), whose
 * `modelName` is the urvc FOLDER name (`Sigma Male Narrator`). Crucible names
 * the same weights by MANIFEST id (`sigma`). Three spellings of one voice, none
 * derivable from the others — `us-female-1` is `US_Female_1` is
 * `rvc-voice-us-female-1` — so the correspondence is DECLARED below and an
 * unmapped voice is refused by name. In particular every LOCAL or USER-ADDED
 * voice (`rvc-local-*`, `rvc-user-*`, and the four published-nowhere models
 * PHASE4 §4 lists) has no manifest anywhere and cannot: those weights are a
 * folder on this machine, and a Crucible pulls a published archive at a pinned
 * revision by sha256. Convert them locally.
 *
 * ── Every knob crosses, or is refused by name ──────────────────────────────
 *
 * `index_rate`, `protect_rate`, `n_semitones`, `f0_method` and `hop_length` are
 * the job's params and are sent exactly as the local argv sends them, ABSENCE
 * INCLUDED: PHASE4 §4 says an absent `f0_method` or `hop_length` means the flag
 * is omitted and urvc keeps its own tuned default, which is the one place on
 * this wire where absent is a meaningful value rather than a refusal. The two
 * knobs the local path has that the job type does NOT take are refused rather
 * than dropped:
 *
 *  - **`batchSize`** — the 96-file worker recycle. PHASE4 §4: "Batching is a
 *    memory bound, not a throughput choice. The server does it, the client never
 *    sees it." A caller that names one is telling this side to bound a memory
 *    envelope it does not own, and answering "yes" while ignoring it would be
 *    the silent substitution this whole seam refuses.
 *  - **a mixed-extension input set** — `convert-dir` takes ONE `--input-glob`
 *    and ONE `--output-ext`, so "one artifact per input, same name" is only true
 *    when every input shares an extension. A mixed set is refused here rather
 *    than half converted there.
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * **No index-rate clamp.** BookForge clamps a non-zero index rate to 0 for a
 * voice with no usable `.index` (`resolveRvcIndexRate`'s `forceIndexRate0`);
 * Crucible refuses `model_has_no_index` instead, and PHASE4 §4 says why — a
 * caller who asked for 0.5 and silently got 0 has an output that sounds wrong
 * for a reason nothing in it explains. All seven manifests ship WITH an index,
 * so the two behaviours cannot differ today. RULING OWED if one ever ships
 * without: does BookForge stop clamping, or does this door refuse the clamp?
 *
 * **No GPU lease on this machine.** `rvc-job.ts` takes the arbiter lease around
 * its whole pass; this door does not take a second one, because admission is the
 * server's. The same RULING OWED `asr.ts` records stands: does a job on a REMOTE
 * Crucible hold this machine's lease at all?
 *
 * **No gap pass, no staging, no manifest.** Those are `rvc-job.ts`'s and stay
 * there. This door converts a directory into a directory.
 *
 * **NO LEASE HERE.** This is ONE job on the lane, and a job already holds
 * everything a Crucible lease would hold — see `job.ts`'s header for the whole
 * argument, and `lease.ts` for the chat-shaped doors that do lease.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JobEvent } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import {
  assertCrucibleModelOffered,
  runCrucibleJob,
  type CrucibleJobProgress,
} from './job';
import type { VenueHost } from './generation-venue';
import { venueForRunStep, type RunVenue, type StepVenue } from './step-venue';

// ─────────────────────────────────────────────────────────────────────────────
// The model id table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BookForge RVC asset id (`electron/data/rvc-voice-assets.json`, read through
 * `electron/rvc-models.ts`) → Crucible `rvc` manifest id (`crucible/rvc/*.toml`,
 * seven of them). Every built-in voice BookForge ships has a manifest and every
 * manifest has a built-in voice; the two catalogs agree today and the table is
 * what makes that an assertion rather than a coincidence.
 *
 * The table decides WHICH id to ask for; the server decides whether it has it
 * (`assertCrucibleModelOffered` reads `GET /v1/info`'s `rvc` rows before a
 * book's worth of FLACs go up, and the submit refuses `model_not_installed` by
 * name for a manifest whose archive was never pulled).
 */
export const CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE: Readonly<Record<string, string>> = {
  'rvc-voice-owen-morgan': 'owen-morgan',
  'rvc-voice-sigma': 'sigma',
  'rvc-voice-us-female-1': 'us-female-1',
  'rvc-voice-girlfriend': 'girlfriend',
  'rvc-voice-mistborn': 'mistborn-rvc-v1',
  'rvc-voice-deathstalker-v3': 'deathstalker-rvc-v3',
  'rvc-voice-deathstalker-d3000-v1': 'deathstalker-rvc-v1',
};

/** A voice, a knob or an input set this door cannot ask for, named. */
export class CrucibleRvcRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleRvcRefused';
    this.code = code;
  }
}

/** Which Crucible rvc manifest converts with this BookForge voice asset. */
export function crucibleRvcModelFor(voiceId: string): string {
  const id = (voiceId ?? '').trim();
  if (id === '') {
    throw new CrucibleRvcRefused(
      'crucible_rvc_voice_not_named',
      'a Crucible voice conversion needs the RVC voice the run selected. There is no default '
      + 'voice: a book converted through a voice nobody chose is a book nobody asked for.',
    );
  }
  const mapped = CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE[id];
  if (mapped === undefined) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_voice_unmapped',
      `RVC voice "${id}" has no Crucible manifest in CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE `
      + `(mapped: ${Object.keys(CRUCIBLE_RVC_MODEL_BY_BOOKFORGE_VOICE).join(', ')}). A locally `
      + 'dropped model (rvc-local-*), a user-added source (rvc-user-*) and the models published '
      + 'nowhere (deathstalker_rvc_v2, mistborn_rvc_v2, mistborn_rvc_v3_aol, the training-only '
      + 'checkpoints — PHASE4-AUDIO.md §4) are deliberately absent: a Crucible pulls a published '
      + 'archive at a pinned revision by sha256 and cannot be handed a folder on this machine. '
      + 'Convert with the local engine, or publish the model and add a manifest on the server '
      + 'and a row here.',
    );
  }
  return mapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// The params
// ─────────────────────────────────────────────────────────────────────────────

/** The per-conversion knobs, exactly as `buildConvertDirArgs` spells them. */
export interface CrucibleRvcKnobs {
  /** `--index-rate`. Always sent: the local argv always sends it. */
  readonly indexRate: number;
  /** `--protect-rate`. INVERTED — lower protects more, 0.5 is off. Always sent. */
  readonly protectRate: number;
  /** `--n-semitones`. Always sent, including 0 (the local argv omits a 0 because
   *  0 is urvc's own default; stating it here is the same conversion). */
  readonly nSemitones: number;
  /** `--f0-method`. ABSENT STAYS ABSENT — urvc keeps its own default. */
  readonly f0Method?: string;
  /** `--hop-length`, crepe-family only. ABSENT STAYS ABSENT. */
  readonly hopLength?: number;
  /**
   * The local pass's 96-file worker recycle. NOT a wire parameter — naming one
   * is refused rather than dropped. See the header.
   */
  readonly batchSize?: number;
}

/**
 * The `rvc` job's `params`, from the knobs the local spawn would have used.
 *
 * `extra="forbid"` on the server's side means a key it does not know is a named
 * refusal rather than an ignored field, so this builds exactly the five keys
 * PHASE4 §4 declares and nothing else.
 */
export function crucibleRvcParams(knobs: CrucibleRvcKnobs): Record<string, unknown> {
  if (knobs.batchSize !== undefined) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_batch_size_is_the_servers',
      `this conversion asked for a worker batch size (${knobs.batchSize}), which the rvc job type `
      + 'does not take. Recycling the urvc process every N files is a MEMORY BOUND on the machine '
      + 'that runs it (PHASE4-AUDIO.md §4: "the server does it, the client never sees it"), and '
      + 'this side cannot bound a memory envelope it does not own. Drop the knob, or convert '
      + 'locally where it means something.',
    );
  }
  for (const [name, value] of [
    ['indexRate', knobs.indexRate], ['protectRate', knobs.protectRate], ['nSemitones', knobs.nSemitones],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CrucibleRvcRefused(
        'crucible_rvc_knob_unreadable',
        `${name} is ${JSON.stringify(value)}, which is not a number. The local argv always spells `
        + 'this flag, so an absent one here is a caller that lost it rather than a default to pick.',
      );
    }
  }
  return {
    index_rate: knobs.indexRate,
    protect_rate: knobs.protectRate,
    n_semitones: knobs.nSemitones,
    // ABSENT STAYS ABSENT. Substituting `rmvpe` here would put a method THIS
    // side chose onto every conversion, which is the bug `enhanceSentences`'s
    // own comment warns about on the local argv.
    ...(knobs.f0Method === undefined ? {} : { f0_method: knobs.f0Method }),
    ...(knobs.hopLength === undefined ? {} : { hop_length: knobs.hopLength }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The input set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The files a conversion of `dir` sends, sorted, with their one extension.
 *
 * `glob` is the local pass's `--input-glob` and only `*` wildcards are honoured,
 * exactly as `rvc-bridge.listDirGlob` honours them — the same matcher, so the
 * two venues convert the same set of files out of the same directory.
 */
export function crucibleRvcInputs(dir: string, glob: string): { names: string[]; ext: string } {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_source_missing',
      `the sentences to convert are not on disk (${dir}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rx = new RegExp(`^${glob.split('*').map(esc).join('.*')}$`, 'i');
  const names = entries.filter((n) => rx.test(n)).sort();
  if (names.length === 0) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_no_inputs',
      `no file matching '${glob}' in ${dir}. An empty set is not an empty book — it is a caller `
      + 'that computed the wrong directory, and submitting it would produce a job that finishes '
      + 'instantly having converted nothing.',
    );
  }
  const exts = new Set(names.map((n) => path.extname(n).toLowerCase()));
  if (exts.size !== 1) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_mixed_extensions',
      `${dir} holds ${exts.size} different extensions (${[...exts].join(', ')}) matching '${glob}'. `
      + 'A Crucible rvc job takes ONE --input-glob and ONE --output-ext, so "one artifact per input, '
      + 'same name" only holds for a single extension (PHASE4-AUDIO.md §4). A mixed job is refused '
      + 'rather than half converted.',
    );
  }
  return { names, ext: [...exts][0] };
}

// ─────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────

export interface CrucibleRvcProgress {
  /** `warming` while the engine loads its model; then `converting`. */
  readonly stage: 'warming' | 'converting';
  /** The SERVER's own fraction. Never re-derived here. */
  readonly fraction: number;
  readonly message: string;
  /** How many artifacts the server has ANNOUNCED so far, counted on this side. */
  readonly announced: number;
  /** How many inputs went up. The denominator this pass actually has. */
  readonly total: number;
}

export interface RunCrucibleRvcOptions {
  readonly server: string;
  /** Directory of sentence files to convert. */
  readonly sentencesDir: string;
  /** Where the converted files land, under the SAME names. Must already exist. */
  readonly outputDir: string;
  /** BookForge's RVC asset id, mapped through {@link crucibleRvcModelFor}. */
  readonly voiceId: string;
  readonly knobs: CrucibleRvcKnobs;
  /** The local pass's `--input-glob`. Default `*.flac`, as `enhanceSentences` defaults it. */
  readonly inputGlob?: string;
  readonly onProgress?: (progress: CrucibleRvcProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface CrucibleRvcOutcome {
  readonly jobId: string;
  /** The Crucible manifest that did the conversion. */
  readonly model: string;
  /** How many files went up. */
  readonly inputs: number;
  /** How many converted files landed in `outputDir`. */
  readonly written: number;
}

/**
 * Convert every matching file in `sentencesDir` on a Crucible, landing the
 * results in `outputDir` under their own names.
 *
 * ONE job for the whole set, for `align`'s reason: one lane admission is one
 * admission, and the server's own recycling is what bounds memory inside it.
 * Artifacts are written by the SDK's atomic writer, so each converted file only
 * ever exists complete and only ever beside its `.provenance.json` sidecar —
 * which the sentence-set readers downstream ignore (`listSentenceFiles` matches
 * `*.flac`/`*.wav` only), so the record rides along for free.
 *
 * EVERY INPUT MUST HAVE PRODUCED AN OUTPUT before this resolves, exactly as the
 * local batched pass verifies after every batch. The server already treats a
 * missing one as a failed job; this is the second half of that check, on the
 * files that actually landed on this disk.
 */
export async function runCrucibleRvc(options: RunCrucibleRvcOptions): Promise<CrucibleRvcOutcome> {
  const { server, sentencesDir, outputDir } = options;
  const log = options.onLog ?? (() => undefined);

  if (typeof outputDir !== 'string' || outputDir === '' || !fs.existsSync(outputDir)) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_output_dir_missing',
      `the converted sentences were to land in ${JSON.stringify(outputDir)}, which does not exist. `
      + 'The caller creates it; creating it here would turn a typo into an empty directory that '
      + 'reads as a conversion which produced nothing.',
    );
  }
  const model = crucibleRvcModelFor(options.voiceId);
  const params = crucibleRvcParams(options.knobs);
  const { names } = crucibleRvcInputs(sentencesDir, options.inputGlob ?? '*.flac');

  // BEFORE a book's worth of FLACs crosses: a server with no `rvc` (the type is
  // off, or its env was never installed) or without this manifest says so now
  // (`crucible_rvc_not_offered`, `crucible_rvc_model_not_offered`).
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  await assertCrucibleModelOffered(client, server, 'rvc', model);

  const inputs: Record<string, string> = {};
  for (const name of names) inputs[name] = path.join(sentencesDir, name);

  let announced = 0;
  const outcome = await runCrucibleJob({
    server,
    type: 'rvc',
    model,
    params,
    inputs,
    artifactsTo: outputDir,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onLog: log,
    onEvent: (event: JobEvent) => {
      if (event.event === 'artifact') announced += 1;
    },
    onProgress: (p: CrucibleJobProgress) => {
      if (options.onProgress === undefined) return;
      if (p.kind === 'warming') {
        options.onProgress({
          stage: 'warming', fraction: 0, message: p.message, announced, total: names.length,
        });
        return;
      }
      options.onProgress({
        stage: 'converting',
        fraction: p.fraction,
        message: p.message,
        announced,
        total: names.length,
      });
    },
  });

  if (outcome.artifacts.where !== 'disk') {
    throw new CrucibleRvcRefused(
      'crucible_rvc_artifacts_not_on_disk', 'the converted files were not written to disk',
    );
  }
  const missing = names.filter((name) => !fs.existsSync(path.join(outputDir, name)));
  if (missing.length > 0) {
    throw new CrucibleRvcRefused(
      'crucible_rvc_output_missing',
      `crucible "${server}" job ${outcome.jobId} ended done, but ${missing.length} of `
      + `${names.length} input(s) produced no converted file in ${outputDir} `
      + `(${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}). Every input must `
      + 'produce an output; a short answer would hand assembly a gapped sentence set.',
    );
  }
  log(`crucible "${server}" converted ${names.length} file(s) through "${model}" `
    + `(${options.voiceId}) into ${path.basename(outputDir)}`);

  return { jobId: outcome.jobId, model, inputs: names.length, written: names.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// The door: where this conversion runs
// ─────────────────────────────────────────────────────────────────────────────

export interface ConvertSentencesAtVenueOptions {
  /**
   * THE ANSWER THIS CALLER ALREADY GOT, from this same `venueForRunStep`.
   *
   * `rvc-job.ts` has to know the venue BEFORE it does anything else, because the
   * LOCAL engine's readiness (`rvcEnhancementReady`: the rvc-env, its python,
   * the base models) is a precondition of one venue and irrelevant to the other
   * — a machine with no rvc-env must still be able to convert on a Crucible, and
   * refusing it up front would be the local engine gating a remote job. So the
   * decision is made once, up there, and handed down here rather than asked
   * again: two calls could answer differently (an `any` ping that flaps) and
   * then the readiness check and the run would be about different machines.
   */
  readonly decided?: StepVenue;
  /** THE RUN'S ALREADY-RESOLVED VENUE, when the caller has one. A later step follows its run. */
  readonly runVenue?: RunVenue;
  /** Where `runVenue` was read from, for the log. */
  readonly runVenueSource?: string;
  /** The caller's own server name, when it named one. Must AGREE with `runVenue`. */
  readonly crucible?: { readonly server: string };
  /** The routing record and the network — `processVenueHost()` in the app, a fixture in a keeper. */
  readonly host: VenueHost;
  readonly sentencesDir: string;
  readonly outputDir: string;
  readonly voiceId: string;
  readonly knobs: CrucibleRvcKnobs;
  readonly inputGlob?: string;
  readonly onProgress?: (progress: CrucibleRvcProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
  /**
   * The local urvc spawn, EXACTLY as it has always run — `enhanceSentences`,
   * the rvc-env, the 96-file recycle. Called only when the legacy switch is on;
   * never as a fallback.
   */
  readonly legacyLocal: () => Promise<{ outputDir: string }>;
}

export interface ConvertSentencesAtVenueOutcome {
  readonly venue: StepVenue;
  readonly outputDir: string;
  /** Present when a Crucible did the work. */
  readonly crucible?: CrucibleRvcOutcome;
}

/**
 * Where this voice conversion runs, and run it there.
 *
 * The run's venue when it has one (`venueForRunStep`), else the ONE decision the
 * render, the Listen path and the alignment make. There is no second switch and
 * no fallback: with the legacy switch off and no server reachable this THROWS
 * with the reason, and the row fails saying which server it could not reach.
 */
export async function convertSentencesAtVenue(
  options: ConvertSentencesAtVenueOptions,
): Promise<ConvertSentencesAtVenueOutcome> {
  const log = options.onLog ?? (() => undefined);
  const venue = options.decided ?? await venueForRunStep({
    ...(options.runVenue === undefined ? {} : { runVenue: options.runVenue }),
    ...(options.runVenueSource === undefined ? {} : { runVenueSource: options.runVenueSource }),
    ...(options.crucible === undefined ? {} : { callerNamed: options.crucible }),
    host: options.host,
  });
  if (venue.where === 'legacy-local-narrator') {
    log(`the voice conversion runs on the local urvc spawn — ${venue.origin}: ${venue.because}`);
    const local = await options.legacyLocal();
    return { venue, outputDir: local.outputDir };
  }
  log(`the voice conversion runs on crucible "${venue.server}" — ${venue.origin}: ${venue.because}`);
  const crucible = await runCrucibleRvc({
    server: venue.server,
    sentencesDir: options.sentencesDir,
    outputDir: options.outputDir,
    voiceId: options.voiceId,
    knobs: options.knobs,
    ...(options.inputGlob === undefined ? {} : { inputGlob: options.inputGlob }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    onLog: log,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { venue, outputDir: options.outputDir, crucible };
}
