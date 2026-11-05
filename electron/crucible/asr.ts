/**
 * "GENERATE SENTENCES" ON SOMEBODY ELSE'S CARD — the `asr` door.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `electron/generate-sentences-bridge.ts` transcribes an audiobook into a
 * synced WebVTT and then embeds the VTT into the m4b. The transcription is a
 * Crucible `asr` job (crucible `docs/PHASE4-AUDIO.md` §3): the m4b goes up,
 * `transcript.json` — the model's segments in absolute book time — comes back,
 * and the VTT lands at the path the bridge embeds from. It used to be
 * `electron/scripts/transcribe_audiobook.py` (faster-whisper on this machine's
 * card); that spawn is deleted (docs/REORG-PLAN.md, B2), and this door is the
 * only way a book is transcribed.
 *
 * ── Two things stay on this side, on purpose ───────────────────────────────
 *
 * **Sentence-cue grouping and the WebVTT.** PHASE4 §3: "Sentence-cue grouping
 * and the WebVTT stay in BookForge … Crucible returns what the model said and
 * asserts nothing about the client's units." {@link transcriptToVtt} is that
 * grouping — words into a cue at sentence-final punctuation or 240 characters,
 * a word-less segment as one cue, then the boundary dedupe — a translation of
 * the deleted `transcribe_audiobook.py`'s `group_segments`, rule for rule, and
 * now its only copy. `tools/test-crucible-asr.js` pins it.
 *
 * **ONE MODEL: Qwen3-ASR-1.7B** (Owen, 2026-09-24: ASR is Qwen3-ASR, whisper is
 * retiring — "ums matter"). It is the model the epub-align path already
 * transcribes with (`sentence-align.ts`), named once here as
 * {@link CRUCIBLE_ASR_MODEL}. The whisper SIZE table that stood here
 * (`tiny` … `large-v3` → `faster-whisper-<size>`) is gone: no Crucible ships
 * those manifests, so every Whisper-method row was refused at the server.
 * Qwen's rules are not whisper's, and {@link crucibleAsrParams} states them:
 * no VAD, the language always told (there is no auto-detect).
 *
 * ── What is NOT here ───────────────────────────────────────────────────────
 *
 * **No CPU substitution.** The local script retries a failed CUDA load once on
 * CPU at int8; Crucible refuses instead, and so does this door — a transcript
 * quietly produced under different rules is the failure PHASE4 §3 names.
 *
 * **No GPU lease on this machine.** The local path takes the arbiter lease
 * inside `transcribeAudiobook`; this door does not, because admission is the
 * server's (`accelerator.guard` refuses `accelerator_busy` / `insufficient_memory`
 * by name) and the queue already holds the row's gpu slot. RULING OWED, the
 * same one 2.4 records for renders: does a job on a REMOTE Crucible hold this
 * machine's lease at all, and does one on `local` (this very card) need it to
 * coordinate with a local Ollama? Until ruled, the server's refusal is the
 * answer.
 *
 * **No provenance persisted.** The SDK writes `transcript.json.provenance.json`
 * beside the artifact, but the VTT is an intermediate the bridge deletes after
 * the embed and the m4b has no sidecar slot for it. RULING OWED: where a
 * transcript's provenance (server, model fingerprint) lives once the VTT is
 * inside the m4b. Tonight it goes on the job log, which is a record and not a
 * home.
 *
 * **NO LEASE HERE.** This is ONE job on the lane, and a job already holds
 * everything a Crucible lease would hold — see `job.ts`'s header for the whole
 * argument, and `lease.ts` for the chat-shaped doors that do lease.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import {
  assertCrucibleModelOffered,
  runCrucibleJob,
  type CrucibleJobProgress,
} from './job';
import type { VenueHost } from './generation-venue';
import { venueForRunStep, type RunVenue, type StepVenue } from './step-venue';
import { renameSyncWithRetry } from '../fs-retry';

// ─────────────────────────────────────────────────────────────────────────────
// The model, its language and its params
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE asr model BookForge transcribes with — on the Whisper method and on the
 * epub-align path alike (`sentence-align.ts` re-exports it as
 * `SENTENCE_ASR_MODEL`). The server decides whether it has it
 * (`assertCrucibleModelOffered` reads `GET /v1/info`'s `asr` rows before a
 * 900 MB upload, and the submit refuses `model_not_installed` by name).
 */
export const CRUCIBLE_ASR_MODEL = 'qwen3-asr-1.7b';

/** A model this door cannot ask for, or a document it cannot read, named. */
export class CrucibleAsrRefused extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CrucibleAsrRefused';
    this.code = code;
  }
}

/**
 * The language code Qwen is told. Qwen3-ASR has NO auto-detect: Crucible
 * refuses `auto` by name (`language_unsupported_by_engine`), and its language
 * set is ISO 639-1 codes (`en`, `de`, `fr`, … `yue` — crucible
 * `jobs/align/__init__.py:QWEN3_LANGUAGES`).
 *
 *  - The "not known" values a book or a media tag carries — empty, `auto`,
 *    and the ISO 639-2 sentinels `und` / `undetermined` / `unknown` / `mul` —
 *    are sent as `en`. That is the rule the epub-align path has always used
 *    (`language && language !== 'auto' ? language : 'en'`), and English is what
 *    an untagged book in this library is.
 *  - A region tag is dropped (`en-US` → `en`): the model is per language.
 *  - Anything else is sent as given, lower-cased, and the SERVER is the
 *    authority on whether Qwen speaks it — it refuses an unsupported code by
 *    name before the job is queued.
 */
export function crucibleAsrLanguage(language: string | undefined): string {
  const raw = (language ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'auto' || raw === 'und' || raw === 'undetermined'
      || raw === 'unknown' || raw === 'mul') {
    return 'en';
  }
  return raw.split(/[-_]/)[0];
}

/**
 * The asr params, exactly what `sentence-align.ts` sends Qwen.
 *
 * `vad_filter: false` because Qwen refuses VAD by name
 * (`vad_unsupported_by_engine`). `speech_only: false` SAID OUT LOUD because from
 * Crucible 1.0.52 an unset `speech_only` resolves to `not vad_filter` — it would
 * switch on Crucible's own silence detector, which nothing here has been
 * measured against. `word_timestamps: true` because the cue grouping is word by
 * word.
 */
export function crucibleAsrParams(language: string | undefined): Record<string, unknown> {
  return { language: crucibleAsrLanguage(language), vad_filter: false, speech_only: false, word_timestamps: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// transcript.json → WebVTT
// ─────────────────────────────────────────────────────────────────────────────

/** One whisper word, as `transcript.json` carries it. */
interface TranscriptWord {
  readonly start: number;
  readonly end: number;
  readonly word: string;
}

/** One whisper segment in absolute book time. `words` is absent without `word_timestamps`. */
interface TranscriptSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly words?: readonly TranscriptWord[];
}

/** The document Crucible's `asr` job writes (`crucible/jobs/asr/__init__.py`, `_transcript`). */
export interface CrucibleTranscript {
  readonly model: string;
  readonly revision: string;
  readonly language: string;
  readonly language_requested: string;
  readonly duration_s: number;
  readonly segments: readonly TranscriptSegment[];
  /**
   * STRETCHES THE MODEL LOOPED ON, in the submitted audio's time (Crucible 1.0.58). Such a piece
   * comes back with NO words rather than failing the job, so a caller that reads the words alone
   * sees silence where the reader spoke. Empty when the server reported none - including every
   * server before 1.0.58, where a loop failed the job instead of arriving here.
   */
  readonly decodeLoops: readonly { readonly start: number; readonly end: number; readonly reason: string | null }[];
}

/** Sentence-final punctuation, with closing quotes/brackets after the mark. Same as the script's. */
const SENTENCE_END_RE = /[.!?…]["”’')\]]*$/;
/** A cue that grew this long without punctuation is flushed. The script's `_MAX_CUE_CHARS`. */
const MAX_CUE_CHARS = 240;
/** Boundary duplicates: a cue starting inside a kept one by more than this. The script's 0.1. */
const OVERLAP_TOLERANCE_S = 0.1;

function num(obj: Record<string, unknown>, key: string, where: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `${where}.${key} is not a number`);
  }
  return value;
}

function str(obj: Record<string, unknown>, key: string, where: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `${where}.${key} is not a string`);
  }
  return value;
}

/**
 * Read `transcript.json` strictly. A document missing a field this side reads
 * is refused by name rather than patched: a segment with no `end` is a server
 * that changed, and a VTT built around it would be a transcript with a hole.
 */
export function readCrucibleTranscript(parsed: unknown): CrucibleTranscript {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', 'transcript.json is not an object');
  }
  const doc = parsed as Record<string, unknown>;
  const rawSegments = doc['segments'];
  if (!Array.isArray(rawSegments)) {
    throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', 'transcript.json has no segments list');
  }
  const segments: TranscriptSegment[] = rawSegments.map((raw, i) => {
    const where = `segments[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `${where} is not an object`);
    }
    const seg = raw as Record<string, unknown>;
    const row: { start: number; end: number; text: string; words?: TranscriptWord[] } = {
      start: num(seg, 'start', where),
      end: num(seg, 'end', where),
      text: str(seg, 'text', where),
    };
    if ('words' in seg) {
      const rawWords = seg['words'];
      if (!Array.isArray(rawWords)) {
        throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `${where}.words is not a list`);
      }
      row.words = rawWords.map((w, j) => {
        const wwhere = `${where}.words[${j}]`;
        if (typeof w !== 'object' || w === null) {
          throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `${wwhere} is not an object`);
        }
        const word = w as Record<string, unknown>;
        return { start: num(word, 'start', wwhere), end: num(word, 'end', wwhere), word: str(word, 'word', wwhere) };
      });
    }
    return row;
  });
  return {
    model: str(doc, 'model', 'transcript'),
    revision: str(doc, 'revision', 'transcript'),
    language: str(doc, 'language', 'transcript'),
    language_requested: str(doc, 'language_requested', 'transcript'),
    duration_s: num(doc, 'duration_s', 'transcript'),
    segments,
    decodeLoops: readDecodeLoops(doc['decode_loop']),
  };
}

/** `decode_loop` [{start, end, reason, ...}], or [] when absent. A malformed entry is refused. */
function readDecodeLoops(raw: unknown): CrucibleTranscript['decodeLoops'] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', 'transcript.json decode_loop is not a list');
  }
  return raw.map((r, i) => {
    const where = `decode_loop[${i}]`;
    if (typeof r !== 'object' || r === null) {
      throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', `${where} is not an object`);
    }
    const o = r as Record<string, unknown>;
    return { start: num(o, 'start', where), end: num(o, 'end', where),
      reason: typeof o['reason'] === 'string' ? o['reason'] as string : null };
  });
}

/**
 * `HH:MM:SS.mmm`, the script's `_fmt` — rounded to the millisecond FIRST and
 * then split, so 59.9996 s carries into the minute. The script formats the
 * seconds with `f'{s:06.3f}'` and would print `00:00:60.000` there, which no
 * WebVTT parser accepts; the one place this deliberately does not mirror it.
 */
export function vttTimestamp(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export interface VttCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * The model's segments → sentence cues, the way the deleted
 * `transcribe_audiobook.py`'s `group_segments` did it: words accumulate into a cue that ends at a word
 * carrying sentence-final punctuation or once the cue holds 240 characters; a
 * segment with no word timings is one cue of its own text; then cues are
 * sorted by start and any cue beginning inside an already-kept cue's span
 * (past a 0.1 s tolerance) is a boundary duplicate and dropped.
 *
 * Crucible already dropped the window-overlap duplicates at the SEGMENT level
 * with the same rule (PHASE4 §3 says the boundary behaviour is therefore close
 * but not identical); applying the cue-level rule again is the local script's
 * own last step and is kept so the two doors produce the same file from the
 * same words.
 */
export function groupTranscriptCues(segments: readonly TranscriptSegment[]): VttCue[] {
  const cues: VttCue[] = [];
  let words: string[] = [];
  let start: number | null = null;
  let end: number | null = null;
  const flush = (): void => {
    if (words.length > 0 && start !== null && end !== null) {
      const text = words.join('').replace(/\s+/g, ' ').trim();
      if (text !== '') cues.push({ start, end, text });
    }
    words = [];
    start = null;
    end = null;
  };
  for (const segment of segments) {
    if (segment.words !== undefined && segment.words.length > 0) {
      for (const w of segment.words) {
        if (start === null) start = w.start;
        end = w.end;
        words.push(w.word);
        const chars = words.reduce((n, x) => n + x.length, 0);
        if (SENTENCE_END_RE.test(w.word.trim()) || chars >= MAX_CUE_CHARS) flush();
      }
    } else {
      flush();
      const text = segment.text.replace(/\s+/g, ' ').trim();
      if (text !== '') cues.push({ start: segment.start, end: segment.end, text });
    }
  }
  flush();

  cues.sort((a, b) => a.start - b.start);
  const merged: VttCue[] = [];
  for (const cue of cues) {
    const last = merged[merged.length - 1];
    if (last !== undefined && cue.start < last.end - OVERLAP_TOLERANCE_S) continue;
    merged.push(cue);
  }
  return merged;
}

/** The WebVTT text the local script writes, from the cues. */
export function renderVtt(cues: readonly VttCue[]): string {
  const lines: string[] = ['WEBVTT', ''];
  for (const cue of cues) {
    lines.push(`${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}`);
    lines.push(cue.text);
    lines.push('');
  }
  return lines.join('\n');
}

/** `transcript.json` (parsed) → the VTT text and its cue count. Refuses an empty transcript by name. */
export function transcriptToVtt(parsed: unknown): { vtt: string; cues: number; transcript: CrucibleTranscript } {
  const transcript = readCrucibleTranscript(parsed);
  const cues = groupTranscriptCues(transcript.segments);
  if (cues.length === 0) {
    throw new CrucibleAsrRefused(
      'crucible_asr_no_text',
      'the transcription produced no text — the same refusal the local script makes for a book '
      + 'whisper heard nothing in.',
    );
  }
  return { vtt: renderVtt(cues), cues: cues.length, transcript };
}

// ─────────────────────────────────────────────────────────────────────────────
// The job
// ─────────────────────────────────────────────────────────────────────────────

/** What the server said about the transcription, as the bridge shows it. */
export interface CrucibleAsrProgress {
  /** `warming` while the model loads; then the server's `stage`: `decoding` or `transcribing`. */
  readonly stage: 'warming' | 'decoding' | 'transcribing';
  /** The SERVER's fraction. Zero throughout the decode (PHASE4 §3: the decode drives no fraction). */
  readonly fraction: number;
  readonly message: string;
  /** Off the frame's `extra`, when the server sent them. */
  readonly processedSec: number | null;
  readonly totalSec: number | null;
  readonly cues: number | null;
}

export interface RunCrucibleAsrOptions {
  readonly server: string;
  /** The audiobook. Its EXTENSION is load-bearing: it becomes the file's name on the server and ffmpeg reads the container off it. */
  readonly audioPath: string;
  /** ISO code, `auto`, or one of the tag sentinels; see {@link crucibleAsrLanguage}. */
  readonly language?: string;
  /** Where the local script would have written the VTT. Written whole, then renamed into place. */
  readonly outVttPath: string;
  readonly onProgress?: (progress: CrucibleAsrProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface CrucibleAsrOutcome {
  readonly jobId: string;
  readonly cues: number;
  /** The model the server ran and its pinned revision — what the job log records. */
  readonly model: string;
  readonly revision: string;
  /** The language the model was told. */
  readonly language: string;
  readonly durationSec: number;
}

/**
 * Transcribe one audiobook on a Crucible and write the VTT where the local
 * script would have.
 *
 * The transcript lands in a scratch directory of its own (the SDK's writer
 * puts the provenance sidecar beside it), is read strictly, grouped into cues,
 * and written to `outVttPath`. The scratch directory is removed afterwards
 * whatever happened, because a book's worth of segments in %TEMP% is not a
 * record anybody reads.
 */
export async function runCrucibleAsr(options: RunCrucibleAsrOptions): Promise<CrucibleAsrOutcome> {
  const { server, audioPath, outVttPath } = options;
  const log = options.onLog ?? (() => undefined);

  if (typeof audioPath !== 'string' || audioPath === '' || !fs.existsSync(audioPath)) {
    throw new CrucibleAsrRefused('crucible_asr_audio_missing', `audiobook not found: ${audioPath}`);
  }
  if (typeof outVttPath !== 'string' || outVttPath === '') {
    throw new CrucibleAsrRefused(
      'crucible_asr_out_not_named',
      'a Crucible transcription writes its VTT where the local script writes it, and no path was given.',
    );
  }
  const model = CRUCIBLE_ASR_MODEL;
  const params = crucibleAsrParams(options.language);
  // The name the server stores the upload under. Only the basename crosses —
  // the server writes it into the job's scratch — and its extension is what
  // ffmpeg reads the container from (`AsrOptions.filename`).
  const filename = path.basename(audioPath);

  // BEFORE the upload: a server with no asr, or without this manifest, says so
  // now rather than after 900 MB have crossed (`crucible_asr_not_offered`,
  // `crucible_asr_model_not_offered`).
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  await assertCrucibleModelOffered(client, server, 'asr', model);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-crucible-asr-'));
  try {
    const outcome = await runCrucibleJob({
      server,
      type: 'asr',
      model,
      params,
      inputs: { [filename]: audioPath },
      artifactsTo: scratch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onLog: log,
      onProgress: (p: CrucibleJobProgress) => {
        if (options.onProgress === undefined) return;
        if (p.kind !== 'progress') { // warming, or waiting in the server's line: nothing has run yet
          options.onProgress({
            stage: 'warming', fraction: 0, message: p.message,
            processedSec: null, totalSec: null, cues: null,
          });
          return;
        }
        const stage = p.extra['stage'] === 'decoding' ? 'decoding' : 'transcribing';
        const numberOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        options.onProgress({
          stage,
          fraction: p.fraction,
          message: p.message,
          processedSec: numberOrNull(p.extra['processed_s']),
          totalSec: numberOrNull(p.extra['total_s']),
          cues: numberOrNull(p.extra['cues']),
        });
      },
    });

    if (outcome.artifacts.where !== 'disk') {
      throw new CrucibleAsrRefused('crucible_asr_transcript_unreadable', 'artifacts were not written to disk');
    }
    const written = outcome.artifacts.files.get('transcript.json');
    if (written === undefined) {
      throw new CrucibleAsrRefused(
        'crucible_asr_transcript_missing',
        `crucible "${server}" job ${outcome.jobId} ended done without a transcript.json artifact `
        + `(it wrote: ${[...outcome.artifacts.files.keys()].join(', ') || 'nothing'}).`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(written.path, 'utf-8'));
    } catch (err) {
      throw new CrucibleAsrRefused(
        'crucible_asr_transcript_unreadable',
        `${written.path} is not JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const { vtt, cues, transcript } = transcriptToVtt(parsed);

    // Whole file, then rename: the bridge's embed reads this path, and a VTT
    // that exists half-written is a track that verifies short.
    const tmp = `${outVttPath}.${process.pid}.part`;
    fs.writeFileSync(tmp, vtt, 'utf-8');
    renameSyncWithRetry(tmp, outVttPath);

    const fingerprint = written.provenance.model?.fingerprint ?? `${transcript.model}@${transcript.revision}`;
    log(`crucible "${server}" transcribed ${filename}: ${cues} cue(s), ${transcript.duration_s.toFixed(0)}s, `
      + `language ${transcript.language} (asked ${transcript.language_requested}), model ${fingerprint}, `
      + `server ${written.provenance.server.name} `
      + `${written.provenance.server.version} (${written.provenance.backend})`);

    return {
      jobId: outcome.jobId,
      cues,
      model: transcript.model,
      revision: transcript.revision,
      language: transcript.language,
      durationSec: transcript.duration_s,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The door: where this transcription runs
// ─────────────────────────────────────────────────────────────────────────────

export interface TranscribeAtVenueOptions {
  /**
   * THE RUN'S ALREADY-RESOLVED VENUE, when the caller has one — the queue row's
   * `waitForResolved`. A later step FOLLOWS its run (PHASE7-LANES.md §4.4, one
   * book = one GPU) and decides only when the run has no venue yet.
   */
  readonly runVenue?: RunVenue;
  /** Where `runVenue` was read from, for the log. */
  readonly runVenueSource?: string;
  /** The caller's own server name, when it named one (the CLI's `--crucible-server`). Must agree with `runVenue`. */
  readonly crucible?: { readonly server: string };
  /** The routing record and the network — `processVenueHost()` in the app, a fixture in a keeper. */
  readonly host: VenueHost;
  readonly audioPath: string;
  readonly language?: string;
  readonly outVttPath: string;
  readonly onProgress?: (progress: CrucibleAsrProgress) => void;
  readonly onLog?: (line: string) => void;
  readonly signal?: AbortSignal;
}

export interface TranscribeAtVenueOutcome {
  /** Where it ran, and whether that was the run's answer or one decided here. */
  readonly venue: StepVenue;
  readonly cues: number;
  /** Present when a Crucible did the work. */
  readonly crucible?: CrucibleAsrOutcome;
}

/**
 * Where this transcription runs, and run it there.
 *
 * The run's venue when it has one (`venueForRunStep`), else ONE decision, the
 * same one the render and the Listen path make (`decideWhereGenerationRuns`:
 * the caller named it → the routing record), so the machine that transcribes a
 * book is chosen the way the machine that renders one is. There is no local
 * spawn and no fallback to one: with no server reachable this THROWS with the
 * reason, and the row fails saying which server it could not reach.
 */
export async function transcribeAtVenue(options: TranscribeAtVenueOptions): Promise<TranscribeAtVenueOutcome> {
  const log = options.onLog ?? (() => undefined);
  const venue = await venueForRunStep({
    ...(options.runVenue === undefined ? {} : { runVenue: options.runVenue }),
    ...(options.runVenueSource === undefined ? {} : { runVenueSource: options.runVenueSource }),
    ...(options.crucible === undefined ? {} : { callerNamed: options.crucible }),
    host: options.host,
  });
  log(`transcription runs on crucible "${venue.server}" — ${venue.origin}: ${venue.because}`);
  const crucible = await runCrucibleAsr({
    server: venue.server,
    audioPath: options.audioPath,
    ...(options.language === undefined ? {} : { language: options.language }),
    outVttPath: options.outVttPath,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    onLog: log,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { venue, cues: crucible.cues, crucible };
}
