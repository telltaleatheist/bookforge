/**
 * Correct Sentences — backend bridge.
 *
 * Lets a user regenerate individual TTS sentences that sound wrong, audition a few
 * fresh takes in context, approve one, and reassemble. It reuses the SAME lightweight
 * e2a worker a normal book render uses (via parallel-tts-bridge.regenerateSentenceIndices),
 * so each regenerated FLAC is a true drop-in: identical engine/voice/model, and the
 * worker's own _save_audio applies the normal peak-normalize + inter-clip gaps. Because
 * sampling is unseeded, each take is a genuinely different reading of the same sentence —
 * which is the whole point.
 *
 * Gate: only books that went through e2a have a per-sentence FLAC cache AND an narrator VTT
 * (exact 1:1 cue↔sentence-index mapping). Both are required; no cache/VTT → no feature.
 *
 * Drop-in caveat handled here (validated 2026-07-14): older books were rendered at 16-bit
 * FLAC while current e2a emits 24-bit. A mixed-bit-depth `-c:a flac` concat fails
 * ("switching bps mid-stream is not supported") and SILENTLY DROPS the sentence. So every
 * candidate is transcoded to the book's existing sample_fmt before it can enter the cache.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getFfmpegPath, getFfprobePath } from './tool-paths';
import { getBfpCachedSession } from './reassembly-bridge';
import { readVttCueText } from './vtt-cue-text';
import {
  regenerateSentenceIndices,
  ParallelTtsSettings,
} from './parallel-tts-bridge';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SentenceCue {
  /** 0-based sentence index — same ordinal as {index}.flac. */
  index: number;
  /** Spoken text (the narrator VTT cue payload), inline tags removed. */
  text: string;
  /** True when e2a bold-wrapped the payload, i.e. this sentence is a heading. */
  heading: boolean;
  /** Whole-book absolute cue bounds, milliseconds. */
  startMs: number;
  endMs: number;
}

export interface CorrectSentencesSession {
  available: boolean;
  /** Why the feature is unavailable (only when available === false). */
  reason?: string;
  sessionId?: string;          // bare UUID (no "ebook-" prefix)
  sessionDir?: string;         // the ebook-{uuid} dir (worker --session_dir)
  processDir?: string;         // the {hash} dir holding session-state.json + the VTT
  sentencesDir?: string;       // {processDir}/chapters/sentences
  vttPath?: string;
  cues?: SentenceCue[];
  totalSentences?: number;
  /** The book's per-sentence FLAC sample format (e.g. "s16"/"s32") — every candidate
   *  is matched to this so it drops into the cache without breaking assembly. */
  sampleFmt?: string;
  /** Engine + voice that produced the cache (shown in the UI). */
  ttsEngine?: string;
  voice?: string;
}

export interface CandidateSet {
  index: number;
  /** The current cache file for this index (the "Original", option #1). */
  originalPath: string;
  /** Freshly generated takes (already matched to the book's sample_fmt). */
  takePaths: string[];
  /** Indices that failed to regenerate this round (empty on full success). */
  failed?: boolean;
}

export interface GenerateCandidatesResult {
  success: boolean;
  candidates: CandidateSet[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// VTT parsing (e2a's plain WebVTT: no cue ids, absolute timestamps, text payload)
// ─────────────────────────────────────────────────────────────────────────────

function parseTimestamp(ts: string): number {
  // HH:MM:SS.mmm  or  MM:SS.mmm
  const m = ts.trim().match(/(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})/);
  if (!m) return NaN;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = parseInt(m[4].padEnd(3, '0'), 10);
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/**
 * Parse a narrator VTT into cues in file order. Cue N (0-based) corresponds to
 * {N}.flac — the builder emits exactly one cue per sentence FLAC, in index order.
 *
 * RENAMED, NOT REWRITTEN. narrator's assembler writes the same bytes e2a's did
 * (`assemble/` ports the builder cue-for-cue), so this function is unchanged; the
 * name is the only thing that was still claiming an e2a session. A VTT written by
 * either side parses here identically, which matters because every cached session
 * on Owen's machines today was written by e2a.
 */
export function parseNarratorVtt(content: string): SentenceCue[] {
  const cues: SentenceCue[] = [];
  // Normalize newlines, drop the WEBVTT header, split into blocks on blank lines.
  const body = content.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  const blocks = body.split(/\n\s*\n/);
  let index = 0;
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    if (!lines.length) continue;
    // Skip the WEBVTT header block and any NOTE blocks.
    if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;
    // Find the timing line (some cues may carry an optional identifier line first).
    const timingIdx = lines.findIndex((l) => l.includes('-->'));
    if (timingIdx === -1) continue;
    const [startRaw, endRaw] = lines[timingIdx].split('-->');
    const startMs = parseTimestamp(startRaw);
    const endMs = parseTimestamp(endRaw?.split(/\s+/)[0] ?? '');
    // A heading arrives as `<b>Chapter Eight.</b>`: the tags are markup, so the
    // QA list shows the words and remembers that they were a header.
    const { text, heading } = readVttCueText(lines.slice(timingIdx + 1).join(' '));
    cues.push({ index, text, heading, startMs: startMs || 0, endMs: endMs || 0 });
    index += 1;
  }
  return cues;
}

// ─────────────────────────────────────────────────────────────────────────────
// FLAC format helpers (ffprobe/ffmpeg)
// ─────────────────────────────────────────────────────────────────────────────

/** The sentence-file name for an index in the new e2a naming (matches the VTT rebuild). */
function sentenceFile(dir: string, index: number): string {
  return path.join(dir, `${index}.flac`);
}

async function probeSampleFmt(flacPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(getFfprobePath(), [
      '-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=sample_fmt',
      '-of', 'default=nk=1:nw=1', flacPath,
    ]);
    const fmt = stdout.trim();
    return fmt || null;
  } catch {
    return null;
  }
}

/**
 * Transcode a FLAC to the target sample_fmt (24 kHz mono) IN PLACE. Lossless flac→flac;
 * only the sample quantization changes — the waveform, the peak-normalize, and the
 * inter-clip gaps the worker baked in are all preserved. No-op fast path when the file
 * already matches. Guarantees the candidate can drop into the cache without breaking the
 * `-c:a flac` chapter concat.
 */
async function matchSampleFmtInPlace(flacPath: string, targetFmt: string): Promise<void> {
  const current = await probeSampleFmt(flacPath);
  if (current === targetFmt) return;
  const tmp = `${flacPath}.match.tmp.flac`;
  await execFileAsync(getFfmpegPath(), [
    '-v', 'error', '-y',
    '-i', flacPath,
    '-c:a', 'flac', '-sample_fmt', targetFmt, '-ar', '24000', '-ac', '1',
    tmp,
  ]);
  await fs.promises.rename(tmp, flacPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// Session discovery + gate
// ─────────────────────────────────────────────────────────────────────────────

function unavailable(reason: string): CorrectSentencesSession {
  return { available: false, reason };
}

/**
 * Locate the cached e2a session for a project and assemble everything the Correct
 * Sentences UI needs. Returns { available: false, reason } when the book didn't go
 * through e2a (no cache), lacks the narrator VTT, uses the legacy sentence_{i} naming, or
 * is missing render settings.
 */
export async function getCorrectSentencesSession(projectDir: string): Promise<CorrectSentencesSession> {
  const session = await getBfpCachedSession(projectDir);
  if (!session) return unavailable('No TTS sentence cache found for this book.');

  const sessionId = session.sessionId.replace(/^ebook-/, '');
  const processDir = session.processDir;
  const sessionDir = session.sessionDir;
  const sentencesDir = path.join(processDir, 'chapters', 'sentences');

  // Gate: the sentence cache must exist and use the NEW numeric {i}.flac naming — the
  // narrator VTT rebuild (int(stem) glob sort) can't handle legacy sentence_{i}.flac.
  let files: string[];
  try {
    files = await fs.promises.readdir(sentencesDir);
  } catch {
    return unavailable('Sentence cache folder is missing.');
  }
  const hasNumeric = files.some((f) => /^\d+\.flac$/.test(f));
  const hasLegacy = files.some((f) => /^sentence_\d+\.flac$/.test(f));
  if (!hasNumeric && hasLegacy) {
    return unavailable('This book uses the legacy sentence cache format, which is not supported for correction.');
  }
  if (!hasNumeric) return unavailable('No per-sentence audio found in the cache.');

  // Sentence text comes from the session's own chapter_sentences (session-state.json,
  // hyphen) — the exact list the worker flattens to all_sentences, same ordinal as
  // {i}.flac. NOT the narrator VTT: that gets embedded into the M4B at assembly time and
  // moved out of processDir, so it's not a reliable sidecar. We still pick up a VTT if
  // one happens to be present (unused for now).
  //
  // narrator's prep writes this file, once, at prep (`text/prep.py:521` →
  // `render/session_store.save_session_state`), exactly where and when e2a's prep wrote
  // it (`bookforge_ext/parallel/session.py:553`). So a session that reaches here without
  // one is not "a book we cannot show" — it is a DAMAGED session, and the message has to
  // say which file is missing rather than describing the symptom.
  let cues: SentenceCue[];
  try {
    cues = await readSessionCues(processDir);
  } catch (err) {
    return unavailable((err as Error).message);
  }
  let vttPath: string | undefined;
  try {
    const procFiles = await fs.promises.readdir(processDir);
    const vtt = procFiles.find((f) => f.toLowerCase().endsWith('.vtt'));
    if (vtt) vttPath = path.join(processDir, vtt);
  } catch { /* optional */ }

  // Render settings drive exact-match regeneration. Read the full settings from
  // BookForge's session_state.json (underscore).
  const settings = await readSessionSettings(processDir);
  if (!settings?.ttsEngine) {
    return unavailable('This book’s render settings weren’t recorded, so it can’t be regenerated identically.');
  }

  // Detect the book's per-sentence FLAC format so candidates can be matched to it.
  const firstFlac = files.filter((f) => /^\d+\.flac$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))[0];
  const sampleFmt = (await probeSampleFmt(path.join(sentencesDir, firstFlac))) || 's16';

  return {
    available: true,
    sessionId,
    sessionDir,
    processDir,
    sentencesDir,
    vttPath,
    cues,
    totalSentences: session.totalSentences || cues.length,
    sampleFmt,
    ttsEngine: settings.ttsEngine,
    voice: settings.fineTuned,
  };
}

/** SML tokens the engines insert for pauses/effects — stripped from the DISPLAY text
 *  (the worker still feeds the raw text with tokens to TTS on regeneration).
 *
 *  [heading] joined the set on 2026-08-27 and has to be listed here too: this
 *  path reads chapter_sentences straight out of session-state.json, where the
 *  markers are still literal, so without it a chapter title would show up in the
 *  QA list as "[heading]Chapter Eight.". Same drift e2a fixed on its own side by
 *  collapsing five hand-rolled copies into one pattern.
 *
 *  [item] joined on 2026-09-01 for the same reason: e2a marks each <li> so it is
 *  read as its own chunk (Orpheus re-speaks the last item of a packed list
 *  instead of stopping), and the marker is literal in session-state.json. This
 *  regex mirrors e2a's SML_UNSPOKEN_PATTERN in lib/conf_models.py — keep them
 *  in step. */
const SML_RE = /\[\/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]/gi;

/** The marker that says the row was a section header — read before SML_RE eats it. */
const SML_HEADING_RE = /\[\/?heading\]/i;

/** The run of SML markers a stored row OPENS with, e.g. `[break][heading]`. */
const SML_LEAD_RUN_RE = /^(?:\s*\[\/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\])+/i;
/** The run of SML markers a stored row ENDS with. */
const SML_TAIL_RUN_RE = /(?:\[\/?(?:break|pause|heading|item|music|sfx|silence)(?::[^\]]+)?\]\s*)+$/i;

/** The display form of a stored chunk: the words, with every marker removed. */
export function displayTextForStoredChunk(stored: string): string {
  return stored.replace(SML_RE, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * A corrected sentence, put back into the STORED form of its chunk.
 *
 * The QA list shows a chunk's words with its SML markers stripped, so the text a
 * user edits carries none. The markers are not decoration: `[heading]` is what
 * makes the row a chapter marker and bolds its VTT cue, `[item]` is a list-item
 * run boundary, and `[pause:X]`/`[break]` are the chunk's realized silence
 * (`python/narrator/engine/orpheus/prompt.py:_classify_gap`, and `gaps.json` for
 * an engine that does not pad). They belong to the chunk, not to the words, so a
 * correction keeps the row's opening and closing marker runs and replaces only
 * what lies between them.
 *
 * This is what makes an edit ROUND-TRIP: the same string is handed to the worker
 * as the `--sentence_overrides` value AND written back into `chapter_sentences`
 * on commit, so a later resume, retake or reassembly of that index renders and
 * transcribes exactly what was approved.
 */
export function storedTextForCorrection(stored: string, edited: string): string {
  const lead = stored.match(SML_LEAD_RUN_RE)?.[0].trim() ?? '';
  const afterLead = stored.slice(stored.match(SML_LEAD_RUN_RE)?.[0].length ?? 0);
  const tail = afterLead.match(SML_TAIL_RUN_RE)?.[0].trim() ?? '';
  return `${lead}${edited.trim()}${tail}`;
}

/**
 * Every chunk's text, in {i}.flac order, out of the session's own record.
 *
 * `<processDir>/session-state.json` → `chapter_sentences`, flattened in chapter
 * order: the exact list `render/worker.py:flatten_sentences` indexes, so cue N is
 * {N}.flac. No timings (Phase 1 sequences the FLACs directly).
 *
 * THROWS, naming the file. Every failure here used to collapse into `null` and
 * then into one sentence about the book, which is the same answer for "no such
 * file", "not JSON" and "a session with no chapters" — three different repairs.
 */
async function readSessionCues(processDir: string): Promise<SentenceCue[]> {
  const stored = await readStoredChunks(processDir);
  return stored.map((s, index) => ({
    index,
    text: displayTextForStoredChunk(s),
    heading: SML_HEADING_RE.test(s),
    startMs: 0,
    endMs: 0,
  }));
}

/** Where a session's chunk text lives. Named once so every message says the same path. */
function sessionStatePath(processDir: string): string {
  return path.join(processDir, 'session-state.json');
}

/**
 * The STORED form of every chunk (markers and all), flattened in {i}.flac order.
 *
 * This is the record narrator's prep writes and every text consumer reads: the
 * VTT builder, `render/session_v1.py`'s manifest, `render/worker.py`'s
 * `flatten_sentences`, and this door. Failures name the file.
 */
async function readStoredChunks(processDir: string): Promise<string[]> {
  const statePath = sessionStatePath(processDir);
  let raw: string;
  try {
    raw = await fs.promises.readFile(statePath, 'utf-8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(
        `This session has audio but no text: ${statePath} is missing. Prep writes that `
        + `file when the render starts, so the cache was published without it — re-render `
        + `the book (or re-run its narration) to rebuild the session.`
      );
    }
    throw new Error(`${statePath} could not be read: ${err?.message || err}`);
  }
  let state: any;
  try {
    state = JSON.parse(raw);
  } catch (err: any) {
    throw new Error(`${statePath} is not valid JSON: ${err?.message || err}`);
  }
  const chapters = state?.chapter_sentences;
  if (!Array.isArray(chapters)) {
    throw new Error(`${statePath} has no chapter_sentences, so this book has no sentence text to correct.`);
  }
  const stored: string[] = [];
  for (let ci = 0; ci < chapters.length; ci++) {
    const chapter = chapters[ci];
    if (!Array.isArray(chapter)) {
      throw new Error(`${statePath}: chapter_sentences[${ci}] is not a list of chunks.`);
    }
    for (const s of chapter) stored.push(String(s ?? ''));
  }
  if (!stored.length) {
    throw new Error(`${statePath} holds no chunks: there is nothing to correct.`);
  }
  return stored;
}

/**
 * Replace ONE chunk's text in `session-state.json`, in place, keeping the
 * chapter shape. The flat index is walked back into (chapter, position) exactly
 * as `flatten_sentences` walks the other way.
 *
 * Written atomically (temp file beside it, then rename) for the same reason
 * `render/session_store.save_session_state` is: a truncated state file is
 * refused by every reader, permanently, and this write happens while a user is
 * clicking through a correction pass.
 */
async function writeStoredChunk(processDir: string, index: number, storedText: string): Promise<void> {
  const statePath = sessionStatePath(processDir);
  const raw = await fs.promises.readFile(statePath, 'utf-8');
  const state = JSON.parse(raw);
  const chapters = state?.chapter_sentences;
  if (!Array.isArray(chapters)) {
    throw new Error(`${statePath} has no chapter_sentences to correct.`);
  }
  let offset = 0;
  for (const chapter of chapters) {
    if (!Array.isArray(chapter)) {
      throw new Error(`${statePath}: chapter_sentences holds a non-list chapter.`);
    }
    if (index < offset + chapter.length) {
      chapter[index - offset] = storedText;
      const tmp = `${statePath}.correct.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
      await fs.promises.rename(tmp, statePath);
      return;
    }
    offset += chapter.length;
  }
  throw new Error(
    `Sentence ${index} is past the end of ${statePath}, which holds ${offset} chunks.`
  );
}

/** Read the FULL ParallelTtsSettings persisted with the cache (session_state.json). */
async function readSessionSettings(processDir: string): Promise<ParallelTtsSettings | null> {
  try {
    const raw = await fs.promises.readFile(path.join(processDir, 'session_state.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    return (parsed?.settings ?? null) as ParallelTtsSettings | null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Candidate generation
// ─────────────────────────────────────────────────────────────────────────────

function scratchRoot(sessionId: string): string {
  return path.join(app.getPath('userData'), 'correct-sentences', sessionId);
}

/**
 * Orpheus's own generation temperature, and the base every re-roll spreads around.
 *
 * It used to be read off `settings.temperature` with `?? 0.6` behind it. That
 * field was XTTS's — the ONLY writer was the Pipeline Defaults temperature
 * slider, which no engine this build renders in ever honoured — so on every real
 * Orpheus book the base WAS 0.6, arrived at through the fallback rather than
 * stated. The setting left with XTTS on 2026-09-05; the number that always
 * applied is now written down.
 */
const ORPHEUS_BASE_TEMPERATURE = 0.6;

/**
 * Spread of per-take sampling temperatures so re-rolls are genuinely varied rather than
 * near-identical (temp 0.6 alone barely moves the reading). Offsets give one cooler take
 * (can clean up a glitchy read) and hotter takes that rephrase more freely. Only Orpheus
 * honors these.
 */
function computeTakeTemperatures(count: number): number[] {
  const base = ORPHEUS_BASE_TEMPERATURE;
  const OFFSETS = [-0.2, 0.2, 0.4];
  const clamp = (t: number) => Math.max(0.1, Math.min(1.5, Math.round(t * 100) / 100));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = i < OFFSETS.length ? OFFSETS[i] : 0.2 + 0.2 * (i - 1);
    out.push(clamp(base + off));
  }
  return out;
}

/** Edits longer than this (chars) span multiple chunks: generated as ONE take (the engine
 *  still splits + re-merges them into a single {i}.flac), instead of 3 varied takes. */
const LONG_OVERRIDE_CHARS = 280;

export interface GenerateCandidatesParams {
  projectDir: string;
  indices: number[];
  /** Number of fresh takes per sentence (default 3). */
  takes?: number;
  /** Optional per-index replacement text (edited sentences). Long edits get a single take. */
  overrides?: Record<number, string>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/**
 * Generate `takes` fresh candidates for each requested index into scratch take{k}/ dirs,
 * each transcoded to the book's sample_fmt. The live cache is NOT touched. Returns, per
 * index, the original cache path plus the candidate take paths (audition order:
 * [original, take0, take1, take2]).
 *
 * Note: this runs the worker once per take (one model load each). A single generate of N
 * sentences ×3 takes is ~3 model loads; re-rolling one sentence is also ~3. Acceptable for
 * a deliberate QA pass; a future --num_takes worker option could fold it to one load.
 */
export async function generateCandidates(params: GenerateCandidatesParams): Promise<GenerateCandidatesResult> {
  const { projectDir, indices, onProgress, signal } = params;
  const takes = params.takes ?? 3;

  const session = await getCorrectSentencesSession(projectDir);
  if (!session.available || !session.sessionId) {
    return { success: false, candidates: [], error: session.reason || 'Session unavailable.' };
  }
  if (!indices.length) return { success: true, candidates: [] };

  const settings = await readSessionSettings(session.processDir!);
  if (!settings) return { success: false, candidates: [], error: 'Render settings unavailable.' };

  const base = path.join(scratchRoot(session.sessionId), 'candidates');
  // Fresh base each generate so nothing is skipped as "already rendered".
  await fs.promises.rm(base, { recursive: true, force: true });
  await fs.promises.mkdir(base, { recursive: true });

  // Write edited-text overrides (if any) to a JSON file the worker reads.
  //
  // The edit arrives as DISPLAY text (markers stripped by the QA list), and the
  // worker substitutes an override verbatim for the stored row
  // (`render/worker.py:_text_for`). Handing it the bare words would render this
  // one take under different rules than the row itself — no `[heading]` gap, no
  // `[pause:X]` — so the take would not match what a resume or a reassembly of
  // the same index produces. The row's own marker runs are restored first, and
  // the SAME string is what `commitSentence` writes back into
  // `chapter_sentences`, which is what closes the loop.
  const storedChunks = await readStoredChunks(session.processDir!);
  const overrideMap: Record<number, string> = {};
  for (const [k, v] of Object.entries(params.overrides ?? {})) {
    if (!v || !v.trim()) continue;
    const i = Number(k);
    if (!(i >= 0 && i < storedChunks.length)) {
      return {
        success: false,
        candidates: [],
        error: `Sentence ${i} is outside this book's 0..${storedChunks.length - 1}.`,
      };
    }
    overrideMap[i] = storedTextForCorrection(storedChunks[i], v);
  }
  let overridesPath: string | undefined;
  if (Object.keys(overrideMap).length) {
    overridesPath = path.join(base, 'overrides.json');
    await fs.promises.writeFile(overridesPath, JSON.stringify(overrideMap), 'utf-8');
  }

  // Partition: long (multi-chunk) edits get ONE take; everything else gets `takes`
  // temperature-varied takes. Both write take{k}/{i}.flac under `base`.
  const isLong = (i: number) => ((overrideMap[i]?.trim().length ?? 0) > LONG_OVERRIDE_CHARS);
  const longIdx = indices.filter(isLong);
  const normalIdx = indices.filter((i) => !isLong(i));

  const temps = computeTakeTemperatures(takes);
  const baseTemp = ORPHEUS_BASE_TEMPERATURE;
  const totalUnits = normalIdx.length * temps.length + longIdx.length;
  let done = 0;
  const onProg = () => { done += 1; onProgress?.(done, totalUnits); };

  let anyError: string | undefined;
  if (normalIdx.length) {
    const r = await regenerateSentenceIndices({
      sessionId: session.sessionId, sessionDir: session.sessionDir!, settings,
      indices: normalIdx, targetSentencesDir: base, takeTemperatures: temps,
      sentenceOverridesPath: overridesPath, onProgress: onProg, signal,
    });
    if (!r.success) anyError = r.error;
  }
  if (longIdx.length && !signal?.aborted) {
    const r = await regenerateSentenceIndices({
      sessionId: session.sessionId, sessionDir: session.sessionDir!, settings,
      indices: longIdx, targetSentencesDir: base, takeTemperatures: [baseTemp],
      sentenceOverridesPath: overridesPath, onProgress: onProg, signal,
    });
    if (!r.success) anyError = r.error;
  }

  // Collect + sample_fmt-match every produced candidate. take{k}/ subdirs always exist
  // (temps are always set); long-override indices only produced take0.
  const takePathsByIndex = new Map<number, string[]>();
  indices.forEach((i) => takePathsByIndex.set(i, []));
  for (let k = 0; k < takes; k++) {
    const takeDir = path.join(base, `take${k}`);
    for (const i of indices) {
      const candidate = sentenceFile(takeDir, i);
      try {
        await fs.promises.access(candidate);
        await matchSampleFmtInPlace(candidate, session.sampleFmt || 's16');
        takePathsByIndex.get(i)!.push(candidate);
      } catch { /* this take missing for this index */ }
    }
  }

  // Surface a total failure (model load / voice error) only when nothing was produced.
  const produced = [...takePathsByIndex.values()].reduce((n, arr) => n + arr.length, 0);
  if (produced === 0) {
    return { success: false, candidates: [], error: anyError || 'Regeneration produced no audio.' };
  }

  const candidates: CandidateSet[] = indices.map((i) => ({
    index: i,
    originalPath: sentenceFile(session.sentencesDir!, i),
    takePaths: takePathsByIndex.get(i) || [],
    failed: (takePathsByIndex.get(i) || []).length === 0,
  }));

  return { success: true, candidates };
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit / revert
// ─────────────────────────────────────────────────────────────────────────────

/** Where original sentence FLACs are backed up before first replacement. A subdir, so
 *  it never matches the top-level *.flac glob the assembler/VTT builder use. */
function backupDir(sentencesDir: string): string {
  return path.join(sentencesDir, '.orig-backup');
}

/** Where a corrected chunk's ORIGINAL stored text is kept, beside its original audio. */
function storedTextBackupPath(sentencesDir: string, index: number): string {
  return path.join(backupDir(sentencesDir), `${index}.txt`);
}

export interface CommitParams {
  projectDir: string;
  index: number;
  /** The chosen candidate FLAC (already matched to the book's sample_fmt). If this is
   *  the original cache path, the commit is a no-op (user kept the original). */
  sourceFlacPath: string;
  /** The DISPLAY text the take was rendered from, when the user edited the words.
   *  Absent when the take is a plain re-roll of the stored sentence. */
  text?: string;
}

/**
 * Replace the cached {index}.flac with the approved candidate. The original is backed up
 * once to .orig-backup/ (so a later revert is possible), and the candidate is re-matched
 * to the book's sample_fmt defensively before the atomic swap.
 *
 * WHEN THE WORDS CHANGED, THE SESSION'S TEXT CHANGES WITH THEM. `chapter_sentences` is
 * the single record of what a chunk says — the VTT builder, the assembler's manifest,
 * the worker's own resume, and this door all read it — so committing new audio without
 * it left the audio saying one thing and the transcript another, permanently, and a
 * later re-render of that index silently restored the OLD reading. e2a had this hole
 * too (`python/narrator/render/retake.py`, "AN EDITED SENTENCE'S TEXT IS NOT WRITTEN
 * BACK ANYWHERE"); it is closed here, at the one moment a take becomes the book.
 *
 * The audio is swapped FIRST and the text second: a failed text write leaves a
 * correction that is audible but not yet transcribed, and says so, where the reverse
 * order would leave a transcript describing audio that was never committed.
 */
export async function commitSentence(params: CommitParams): Promise<{ success: boolean; error?: string }> {
  const { projectDir, index, sourceFlacPath } = params;
  const session = await getCorrectSentencesSession(projectDir);
  if (!session.available || !session.sentencesDir) {
    return { success: false, error: session.reason || 'Session unavailable.' };
  }
  const dest = sentenceFile(session.sentencesDir, index);

  // Keeping the original = no-op.
  if (path.resolve(sourceFlacPath) === path.resolve(dest)) return { success: true };

  try {
    await fs.promises.access(sourceFlacPath);
  } catch {
    return { success: false, error: `Chosen take no longer exists: ${sourceFlacPath}` };
  }

  try {
    // Back up the original once (don't clobber an existing backup from a prior correction).
    const backups = backupDir(session.sentencesDir);
    await fs.promises.mkdir(backups, { recursive: true });
    const backupPath = path.join(backups, `${index}.flac`);
    if (!fs.existsSync(backupPath) && fs.existsSync(dest)) {
      await fs.promises.copyFile(dest, backupPath);
    }

    // Stage → match → atomic rename into the cache.
    const staged = `${dest}.new.tmp.flac`;
    await fs.promises.copyFile(sourceFlacPath, staged);
    await matchSampleFmtInPlace(staged, session.sampleFmt || 's16');
    await fs.promises.rename(staged, dest);
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }

  if (params.text !== undefined) {
    const edited = params.text.trim();
    if (!edited) {
      return {
        success: false,
        error: `Sentence ${index}: the corrected text is empty. The audio was committed; `
          + `re-open the correction and give the sentence its words.`,
      };
    }
    try {
      const storedChunks = await readStoredChunks(session.processDir!);
      if (!(index >= 0 && index < storedChunks.length)) {
        throw new Error(`Sentence ${index} is outside this book's 0..${storedChunks.length - 1}.`);
      }
      const next = storedTextForCorrection(storedChunks[index], edited);
      if (next !== storedChunks[index]) {
        // The text backup is the twin of the FLAC backup two blocks up: written
        // ONCE, never clobbered by a second correction, so revert puts the book
        // back to what prep produced rather than to an intermediate edit.
        const textBackup = storedTextBackupPath(session.sentencesDir!, index);
        if (!fs.existsSync(textBackup)) {
          await fs.promises.writeFile(textBackup, storedChunks[index], 'utf-8');
        }
        await writeStoredChunk(session.processDir!, index, next);
      }
    } catch (err: any) {
      return {
        success: false,
        error: `Sentence ${index}: the new audio was committed but its text could not be `
          + `written back (${err?.message || err}). The book's transcript still says the old words.`,
      };
    }
  }

  return { success: true };
}

/** Restore a sentence's original audio — AND its original text — from the backup. */
export async function revertSentence(projectDir: string, index: number): Promise<{ success: boolean; error?: string }> {
  const session = await getCorrectSentencesSession(projectDir);
  if (!session.available || !session.sentencesDir) {
    return { success: false, error: session.reason || 'Session unavailable.' };
  }
  const backupPath = path.join(backupDir(session.sentencesDir), `${index}.flac`);
  const dest = sentenceFile(session.sentencesDir, index);
  try {
    await fs.promises.access(backupPath);
  } catch {
    return { success: false, error: 'No backup exists for this sentence.' };
  }
  try {
    const staged = `${dest}.revert.tmp.flac`;
    await fs.promises.copyFile(backupPath, staged);
    await fs.promises.rename(staged, dest);
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }

  // A commit that changed the words left the pre-edit row here. Undoing the audio
  // without undoing the text would leave the same audio/transcript split the
  // write-back exists to prevent.
  const textBackup = storedTextBackupPath(session.sentencesDir, index);
  if (fs.existsSync(textBackup)) {
    try {
      const original = await fs.promises.readFile(textBackup, 'utf-8');
      await writeStoredChunk(session.processDir!, index, original);
      await fs.promises.rm(textBackup, { force: true });
    } catch (err: any) {
      return {
        success: false,
        error: `Sentence ${index}: the original audio was restored but its original text `
          + `could not be (${err?.message || err}).`,
      };
    }
  }
  return { success: true };
}

/** Remove the scratch candidate dirs for a session (call when the flow ends). */
export async function cleanupCandidates(sessionId: string): Promise<void> {
  try {
    await fs.promises.rm(scratchRoot(sessionId.replace(/^ebook-/, '')), { recursive: true, force: true });
  } catch { /* best effort */ }
}
