/**
 * THE WHOLE-AUDIOBOOK ALIGN, ON SOMEBODY ELSE'S CARD — the `align-longform` door.
 *
 * ── What this replaces, and what it does not ───────────────────────────────
 *
 * `electron/whisperx-align-bridge.ts` spawns `electron/scripts/align_audiobook.py`
 * on THIS machine: faster-whisper over the whole m4b, a DTW of the book's
 * sentences onto that rough transcript, Qwen3 per chunk on the card, then the
 * gate, the clamps and the VTT. It is the last in-app GPU consumer, and the
 * reason the bench still draws a row that is not a registered server.
 *
 * Crucible gained a job of that exact shape on 2026-09-15 (`align-longform`,
 * crucible `jobs/alignlongform/`), so this module is the door to it. The
 * server's stages are the same four and its two heavy ones are the SAME code:
 * `coarse_align` and `snap_boundaries` were ported verbatim from that script and
 * are held to it by a differential test over 27 books and 200 seam layouts.
 *
 * ── THE WHOLE STEP TRAVELS, CPU STAGES INCLUDED ────────────────────────────
 *
 * Owen's TTS ruling applied by the same reasoning: *"the entire tts step goes to
 * the other system. That includes anything the step needs to do even if it's
 * cpu."* `transcribe` and `coarse-align` are CPU and are most of the wall clock;
 * they run on the server, and the job charges ONE slot for its whole duration.
 * Slicing locally to send only the GPU stage is what this forbids.
 *
 * ── ONE INPUT, AND IT IS THE M4B ───────────────────────────────────────────
 *
 * The audiobook as it is. A 16 h book is roughly 460 MB at 64 kbps where the
 * 16 kHz mono wav the script makes internally would be ~1.84 GB; the server does
 * that conversion. The EPUB never crosses — it is the client's book, and the
 * sentences it extracted are text, in `params`.
 *
 * ── WHAT COMES BACK ────────────────────────────────────────────────────────
 *
 * `alignment.vtt` — the same VTT the local script writes — and
 * `align-report.json`. Both land in the directory the caller names, beside where
 * the local path would have put them, so nothing downstream has to know which
 * road the cues came by.
 */

import * as path from 'path';

import {
  runCrucibleJob,
  type CrucibleJobProgress,
  type CrucibleJobOutcome,
} from './job';

/** One sentence of the book, in reading order. `kind` is carried, never inferred. */
export interface LongformSentence {
  readonly index: number;
  readonly text: string;
  /** `heading` where the extractor stamped one; `prose` otherwise. */
  readonly kind?: string;
}

/**
 * The stages the server reports, in order. Matched VERBATIM against the
 * server's own names — BookForge's generate-sentences row draws a stacked bar
 * per stage, so a rename on either side blanks a bar rather than erroring.
 */
export const LONGFORM_STAGES = ['transcribe', 'coarse-align', 'align', 'write'] as const;
export type LongformStage = (typeof LONGFORM_STAGES)[number];

export interface RunLongformAlignOptions {
  /** A registered server's NAME. Never a URL. */
  readonly server: string;
  /** The audiobook, as it is. Not a wav. */
  readonly audioPath: string;
  /** The book's sentences, in reading order. */
  readonly sentences: readonly LongformSentence[];
  /** ISO code. The server refuses one Qwen3 was not trained on, before the pool. */
  readonly language: string;
  /** Where `alignment.vtt` and `align-report.json` land. */
  readonly outputDir: string;
  /** The faster-whisper size for the rough pass. The server's default is `small`. */
  readonly roughModel?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: {
    readonly stage: LongformStage | null;
    readonly fraction: number;
    readonly message: string;
  }) => void;
  readonly onLog?: (line: string) => void;
}

export interface LongformAlignOutcome {
  readonly vttPath: string;
  readonly reportPath: string;
  readonly jobId: string;
}

/**
 * The aligner this job runs on. One id, stated here rather than taken from a
 * caller: the whole point of the job is that the SERVER owns how it aligns, and
 * a model name on this side would be a second opinion about that.
 */
const ALIGNER_MODEL = 'qwen3-aligner';

/** Artifact names, the server's own. Two, and both are required. */
const VTT = 'alignment.vtt';
const REPORT = 'align-report.json';

export async function runLongformAlign(
  options: RunLongformAlignOptions,
): Promise<LongformAlignOutcome> {
  if (options.sentences.length === 0) {
    throw new Error(
      'runLongformAlign was given no sentences, so there is nothing to place in the audio. '
      + 'The server refuses this too, by name — but sending it would spend an upload of the '
      + 'whole audiobook to learn it.',
    );
  }

  let outcome: CrucibleJobOutcome;
  try {
    outcome = await runCrucibleJob({
      server: options.server,
      type: 'align-longform',
      model: ALIGNER_MODEL,
      params: {
        language: options.language.trim(),
        sentences: options.sentences.map((s) => ({
          index: s.index,
          text: s.text,
          ...(s.kind === undefined ? {} : { kind: s.kind }),
        })),
        ...(options.roughModel === undefined ? {} : { rough_model: options.roughModel }),
      },
      // ONE input. The name is the server's to read; the extension is the
      // audiobook's own, because the server decodes with ffmpeg and a renamed
      // container is a lie about what the bytes are.
      inputs: { [`audio${path.extname(options.audioPath) || '.m4b'}`]: options.audioPath },
      artifactsTo: options.outputDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
      onProgress: (p: CrucibleJobProgress) => {
        if (options.onProgress === undefined) return;
        if (p.kind === 'warming') {
          options.onProgress({ stage: null, fraction: 0, message: p.message });
          return;
        }
        /*
         * THE STAGE IS THE SERVER'S WORD, passed through unchanged and only
         * when it is one this build knows. An unrecognised stage becomes
         * `null` rather than being coerced into a known one: a newer server
         * that adds a fifth stage should leave the bar where it was, not move
         * it to whichever name happened to sort first.
         */
        const stage = readStage(p);
        options.onProgress({
          stage,
          fraction: typeof p.fraction === 'number' ? p.fraction : 0,
          message: p.message ?? '',
        });
      },
    });
  } catch (err) {
    // The server's refusals are already sentences that name the machine and the
    // cause (`qwen3_language_unsupported`, `rough_model_not_installed`, …).
    // Rethrown untouched: dressing one in this module's words would lose which
    // of the two stages it came from.
    throw err;
  }

  /*
   * `artifacts` is a DISCRIMINATED UNION, not a list of names: `disk` carries a
   * directory and a map of written files, `memory` carries the bytes. This door
   * asked for `artifactsTo`, so `disk` is what it gets — and the other arm is
   * refused by name rather than coerced, because a caller that wanted files on
   * disk and got bytes in hand has a different bug from a missing artifact.
   */
  if (outcome.artifacts.where !== 'disk') {
    throw new Error(
      `crucible "${options.server}" returned the alignment in memory, but this door asked for `
      + 'it on disk (`artifactsTo`). Nothing has been written.',
    );
  }
  const landed = new Set(outcome.artifacts.files.keys());
  for (const required of [VTT, REPORT]) {
    if (!landed.has(required)) {
      throw new Error(
        `crucible "${options.server}" finished the alignment and did not return ${required} `
        + `(it returned: ${[...landed].join(', ') || 'nothing'}). A run that reports success `
        + 'with no transcript is not a success, and nothing downstream can tell the two apart.',
      );
    }
  }

  return {
    vttPath: path.join(options.outputDir, VTT),
    reportPath: path.join(options.outputDir, REPORT),
    jobId: outcome.jobId,
  };
}

/** The server's stage name, when it is one this build draws a bar for. */
function readStage(progress: CrucibleJobProgress): LongformStage | null {
  const value = (progress as unknown as { stage?: unknown }).stage;
  return typeof value === 'string' && (LONGFORM_STAGES as readonly string[]).includes(value)
    ? (value as LongformStage)
    : null;
}
