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
 * ── THE SPREAD IS THE LADDER, AND THE FIRST CANDIDATE IS ON RUNG 1 ─────────
 *
 * The local path spread the takes across sampling temperatures
 * (`computeTakeTemperatures`: 0.4 / 0.8 / 1.0 around Orpheus's 0.6) because
 * "temp 0.6 alone barely moves the reading" — that is `--take_temperatures` on
 * the worker's argv. **`RenderOptions` carries no sampling channel at all**, and
 * it is not getting one: PHASE6-REMOTE-RENDER.md §1 took sampling out of the
 * client's business altogether, and the division-of-knowledge ruling says
 * tuning is engine config, never a wire field. So {@link runCrucibleReroll}
 * still REFUSES a caller that hands it temperatures
 * (`crucible_reroll_take_temperatures_unsupported`) instead of sending the job
 * without them and calling it the same thing.
 *
 * What stands in their place is the RUNG. Owen ruled on this exact door,
 * 2026-09-14: *"i just know if a sentence/chunk was problematic before, itll
 * likely be problematic again with the same settings used to originally
 * generate it"* — so **takes = the spread; a retake never reuses the failing
 * settings; the first candidate is on rung 1**
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md §2). Candidate k (0-based) is submitted
 * at `take: k + 1`. Rung 0 is the boson default — the draw the sentence the
 * person is correcting was ALREADY rendered at — and no candidate is ever asked
 * for there again.
 *
 * ── WHY THAT IS A FIX AND NOT A PREFERENCE ────────────────────────────────
 *
 * This module used to submit `take: 0` for every candidate and call that
 * enough, "because narrator's sampling is unseeded — which is what makes a
 * re-roll a re-roll". **That premise was false and the feature was broken by
 * it.** `HiggsConfig.seed` defaults to 1234
 * (`python/narrator/engine/higgs/config.py`) and `_seed_for` returns
 * `seed + index`, so every chunk is seeded deterministically; the only thing
 * that moves the draw is the rung, which shifts the seed by
 * `TAKE_SEED_STRIDE * take` (`engine/higgs/truncation.py:in_take_lane`).
 * narrator's own `CONTRACTS.md` says it outright — "two take-0 re-rolls always
 * were" byte-identical. A person who asked for three alternative readings got
 * three copies of the one they had just rejected.
 *
 * ── PAST THE LADDER IS A REFUSAL, NOT A CLAMP ─────────────────────────────
 *
 * A ladder is per voice and it is SHORT: `[[voice.takes]]` in
 * `crucible/voices/*.toml` declares two rungs for every shipped fine-tune
 * (rung 0, the boson default; rung 1 at temperature 0.7, with the measurement
 * that chose it written beside it), and a voice that declares none has rung 0
 * alone. Its length arrives on the voice row this door already fetches
 * (`VoiceInfo.takes`, whose own words are "ask before you submit"), so a pass
 * that wants more candidates than the ladder has rungs above 0 is refused BY
 * NAME, with both numbers, before a single job is submitted. It is not clamped
 * to the top rung and it does not quietly render fewer: cycling back down the
 * rungs would put two candidates in one seed lane — the byte-identical pair
 * this whole change exists to remove — and a clamp is "a retake ladder that
 * stops climbing without telling anyone".
 *
 * **CORRECTED 2026-09-19: the refusal is now THIS DOOR'S ALONE.** It used to
 * lean on the server — a take past the ladder was `unknown_take` — and that
 * refusal is retired (crucible docs/PHASE18-UNCERTIFIED.md section 5): rung N
 * above the ladder is a legal request meaning "the voice's OWN sampling in take
 * N's seed lane", which is what a screening sweep wants. It is not what an
 * audition wants. A candidate rendered at the voice's own sampling is a
 * candidate rendered at THE SETTINGS THAT PRODUCED THE READING BEING CORRECTED,
 * differing from it only by seed, and offering a person that as a different
 * reading is the thing Owen ruled out ("a retake never reuses the failing
 * settings"). So the refusal stays, and it is stated here rather than borrowed.
 *
 * ── THE DIRECTORY IS THE CANDIDATE'S, THE RUNG IS THE ENGINE'S ────────────
 *
 * `take<k>/` still means CANDIDATE k, unchanged: it is the name the bridge
 * collects (`correct-sentences-bridge.ts` walks `take0 .. take<takes-1>`) and
 * the order the audition list plays. The rung that produced it rides on the
 * outcome ({@link CrucibleRerollTake.rung}) and is named in the log, so the two
 * numbers are never mistaken for each other: candidate 0 lands in `take0/` and
 * was rendered at rung 1.
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
  assertVoiceRowLoadable,
  crucibleVoiceFor,
  describeCrucibleRefusal,
} from './render';
import { crucibleVoiceBand, renderBandFor } from './voice-band';
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

/**
 * How the local worker names a take's directory under the scratch root.
 *
 * The argument is the CANDIDATE's 0-based ordinal, not the ladder rung it was
 * rendered at — see the header's last section. `take0/` is the first candidate
 * and it holds rung 1's render.
 */
export function takeDirName(take: number): string {
  return `take${take}`;
}

export interface CrucibleRerollProgress {
  /** 0-based CANDIDATE this frame belongs to; `take<k>/` is its directory. */
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
  /** The 0-based CANDIDATE — what `take<k>/` counts and what the audition plays. */
  readonly take: number;
  /**
   * The RUNG of the voice's take ladder this candidate was rendered at, always
   * `take + 1`. Recorded rather than re-derived because it is the provenance a
   * person needs to read the audition list: "this one came from rung 1, the
   * measured alternative", and never from rung 0, which is what the sentence
   * they rejected was already rendered at.
   */
  readonly rung: number;
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
  /**
   * How many fresh candidates per index. Default 1. Each one is rendered at its
   * own rung of the voice's take ladder — candidate k at `take: k + 1` — so
   * this number may not exceed the rungs the voice declares ABOVE rung 0, and
   * a pass that asks for more is refused by name rather than clamped.
   */
  readonly takes?: number;
  /**
   * The local path's per-take sampling temperatures. REFUSED BY NAME — the `tts`
   * wire has no sampling channel, and the ladder is what replaced them. See the
   * header.
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
 * One `tts` job per candidate, **each at its own rung of the voice's take
 * ladder** — candidate k at `take: k + 1`, the first one on rung 1. Each job
 * carries the whole index list, so the server has a denominator and the voice
 * is loaded once per candidate rather than once per sentence. A chunk the
 * server could not render has no file and is named in that candidate's
 * `result.failed` — the bridge already treats a missing take as "this take
 * missing for this index" and shows the ones that did land.
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
      + 'and chunks, and PHASE6-REMOTE-RENDER.md §1 removed sampling from the client\'s business '
      + 'entirely — there is no per-request temperature, top-p or seed on the wire, because tuning '
      + 'is engine config. Sending the job without them and calling it the same pass would be a '
      + 'silent substitution. Ask for N candidates instead: they are spread across the voice\'s own '
      + 'take ladder, candidate k at rung k + 1, never twice at the same rung and never at rung 0. '
      + 'That ladder IS the spread — Owen\'s ruling of 2026-09-14, "a retake must not reuse the '
      + 'settings that produced the problem" — and it is the answer to what this door used to call '
      + 'a RULING OWED.',
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
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  // Before the first submit: does this server serve that voice, can it load it,
  // HOW LONG IS ITS LADDER, and WHAT BAND has it measured. One GET for the whole
  // pass rather than one per candidate, and the row answers all four.
  //
  // It reads the row through `crucibleVoiceBand` since 2026-09-19, where it used
  // to call `assertCrucibleVoiceAvailable`: same single GET, same two booleans
  // asserted below, and the row now also has to yield the three rates every
  // candidate states on its own request. A second call to ask for them would be
  // one fact with two fetches.
  const { row: voiceRow, band } = await crucibleVoiceBand(client, server, voice);
  assertVoiceRowLoadable(voiceRow, server, voice);
  // A RETAKE IS A RENDER, SO IT IS GUARDED TOO, and against this voice's own
  // measured band echoed straight back (Owen, 2026-09-19). A candidate rendered
  // with nothing judged would be auditioned against candidates that were, and
  // the truncation/runaway re-roll is exactly what a person re-rolling a
  // sentence is asking the engine for. Refused by name here
  // (`crucible_voice_states_no_band`) for a voice nobody has measured, before
  // any job is submitted, rather than a band invented for it.
  const retakeBand = renderBandFor(band);

  // THE LADDER, ASKED BEFORE ANYTHING IS SUBMITTED. `takes` on the row is the
  // number of rungs the voice declares, `0 .. takes - 1`; rung 0 is the boson
  // default the rejected reading was already rendered at, so the rungs actually
  // available to a candidate are the ones above it. Asking for more than there
  // are is refused here by name with both numbers — and since 2026-09-19 it is
  // refused ONLY here: the server retired `unknown_take` and would render rung
  // N above the ladder at the voice's own sampling, which for an audition is
  // the settings the rejected reading already used. See this file's header.
  const rungs = voiceRow.takes;
  /*
   * A VOICE THAT STATES NO LADDER CANNOT BE AUDITIONED. Crucible 1.0.25 reads an
   * absent `takes` as null (Owen, 2026-09-24: any Crucible that answers works),
   * and every candidate here is a rung OF that ladder — there is no rung to
   * send without knowing how many exist, and a guessed count would be renders
   * at settings nobody chose. So it is refused by name, before any job is
   * submitted; an ordinary render of the voice is unaffected.
   */
  if (rungs === null) {
    throw new CrucibleRerollRefused(
      'crucible_voice_states_no_ladder',
      `crucible "${server}" does not state a take ladder for voice "${voice}", so there are no rungs `
      + 'to render re-roll candidates at. Rendering with this voice still works; re-rolling a sentence '
      + 'needs a server that declares takes for the voice.',
    );
  }
  const spread = rungs - 1;
  if (takes > spread) {
    throw new CrucibleRerollRefused(
      'crucible_reroll_ladder_too_short',
      `this re-roll asked for ${takes} candidate(s), but crucible "${server}" declares a take ladder `
      + `of ${rungs} rung(s) for voice "${voice}" — `
      + `${spread === 0 ? 'none at all' : `only ${spread}`} above rung 0, and rung 0 is the draw the `
      + 'sentence being corrected was already rendered at. Candidate k goes to rung k + 1, so this '
      + `would have asked for rung ${takes}, which that server would render at the voice's OWN `
      + 'sampling in that rung\'s seed lane — the very settings the reading being corrected was '
      + 'already read at, differing only by seed, which is not a different reading to offer '
      + 'somebody. Nothing is '
      + 'clamped to the top rung and nothing is quietly rendered fewer times: two candidates on one '
      + 'rung share a seed lane (narrator shifts the seed by TAKE_SEED_STRIDE × take) and would be '
      + `byte-identical, which is the whole defect this door was fixed for. Ask for at most ${spread}`
      + `, or measure another rung into ${voice}'s [[voice.takes]] on that server.`,
    );
  }

  const total = options.chunks.length * takes;
  let written = 0;
  const results: CrucibleRerollTake[] = [];

  for (let take = 0; take < takes; take += 1) {
    if (options.signal?.aborted) {
      throw new CrucibleRerollRefused(
        'crucible_reroll_cancelled',
        `the re-roll was cancelled after ${take} of ${takes} candidate(s); what landed is on disk.`,
      );
    }
    // The rung, and the one line that decides this whole module's behaviour:
    // candidate k renders at rung k + 1, so the first candidate is already on a
    // rung the rejected reading was not, and no two candidates share one.
    const rung = take + 1;
    const dir = path.join(targetDir, takeDirName(take));
    fs.mkdirSync(dir, { recursive: true });

    log(`crucible "${server}": submitting candidate ${take + 1} of ${takes} at take rung ${rung} `
      + `of ${rungs} — ${options.chunks.length} chunk(s) as voice "${voice}"`);
    let jobId: string;
    try {
      // eslint-disable-next-line no-await-in-loop -- takes are serial: one exclusive lane at a time
      jobId = await client.render({
        voice,
        language: options.language.trim(),
        take: rung,
        chunks: options.chunks,
        retake: true,
        band: retakeBand,
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
        // Its OWN ledger key per CANDIDATE — and keyed by the candidate rather
        // than the rung, because the key must match the directory a person is
        // auditioning: three candidates of one sentence are three renders, not
        // three chunks of one render.
        renderId: `${renderId}#${takeDirName(take)}`,
        sentencesDir: dir,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onWritten: (file) => {
          if (/^\d+\.flac$/.test(file.name)) written += 1;
        },
        onEvent: (event) => {
          if (event.event !== 'progress' || options.onProgress === undefined) return;
          // Display only — the rule job.ts and render.ts follow (Crucible 1.0.25):
          // no fraction, nothing moved; no words, described by the fraction.
          const fraction = event.data.fraction;
          if (fraction === null) return;
          options.onProgress({
            take, fraction,
            message: event.data.message === null ? `${Math.round(fraction * 100)}%` : event.data.message,
            written, total,
          });
        },
      }).catch((err) => {
        throw describeCrucibleRefusal(err, server);
      });
      if (outcome.result.failed.length > 0) {
        log(`crucible job ${jobId} (candidate ${take}, rung ${rung}): ${outcome.result.failed.length} `
          + `chunk(s) produced no audio — ${outcome.result.failed.slice(0, 8).map((f) => `${f.index}: ${f.message}`).join('; ')}`);
      }
      results.push({
        take, rung, jobId, dir, written: outcome.written, result: outcome.result, guard: outcome.guard,
      });
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  log(`crucible "${server}" re-rolled ${options.chunks.length} sentence(s) × ${takes} take(s) at `
    + `${takes === 1 ? 'rung 1' : `rungs 1-${takes}`} of ${voice}'s ${rungs}-rung ladder: `
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
