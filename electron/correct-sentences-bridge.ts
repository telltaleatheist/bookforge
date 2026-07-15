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
 * Gate: only books that went through e2a have a per-sentence FLAC cache AND an e2a VTT
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
  /** Spoken text (the e2a VTT cue payload). */
  text: string;
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
 * Parse an e2a VTT into cues in file order. Cue N (0-based) corresponds to {N}.flac —
 * the e2a builder emits exactly one cue per sentence FLAC, in index order.
 */
export function parseE2aVtt(content: string): SentenceCue[] {
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
    const text = lines.slice(timingIdx + 1).join(' ').trim();
    cues.push({ index, text, startMs: startMs || 0, endMs: endMs || 0 });
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
 * through e2a (no cache), lacks the e2a VTT, uses the legacy sentence_{i} naming, or
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
  // e2a VTT rebuild (int(stem) glob sort) can't handle legacy sentence_{i}.flac.
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
  // {i}.flac. NOT the e2a VTT: that gets embedded into the M4B at assembly time and
  // moved out of processDir, so it's not a reliable sidecar. We still pick up a VTT if
  // one happens to be present (unused for now).
  const cues = await buildCuesFromSessionState(processDir);
  if (!cues || !cues.length) {
    return unavailable('This book’s sentence text wasn’t found in the session, so it can’t be shown for correction.');
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
 *  (the worker still feeds the raw text with tokens to TTS on regeneration). */
const SML_RE = /\[(?:break|pause|music|sfx|silence)(?::[^\]]+)?\]/gi;

/**
 * Build index-keyed cues from the session's own sentence list (session-state.json →
 * chapter_sentences, flattened in chapter order). Cue N corresponds to {N}.flac. No
 * timings (Phase 1 sequences the FLACs directly, so it doesn't need them).
 */
async function buildCuesFromSessionState(processDir: string): Promise<SentenceCue[] | null> {
  try {
    const raw = await fs.promises.readFile(path.join(processDir, 'session-state.json'), 'utf-8');
    const state = JSON.parse(raw);
    const chapters = state?.chapter_sentences;
    if (!Array.isArray(chapters)) return null;
    const cues: SentenceCue[] = [];
    let index = 0;
    for (const chapter of chapters) {
      if (!Array.isArray(chapter)) continue;
      for (const s of chapter) {
        const text = String(s ?? '').replace(SML_RE, ' ').replace(/\s+/g, ' ').trim();
        cues.push({ index, text, startMs: 0, endMs: 0 });
        index += 1;
      }
    }
    return cues;
  } catch {
    return null;
  }
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
 * Spread of per-take sampling temperatures so re-rolls are genuinely varied rather than
 * near-identical (temp 0.6 alone barely moves the reading). Base is the temperature the
 * book was rendered at (Orpheus default 0.6); offsets give one cooler take (can clean up a
 * glitchy read) and hotter takes that rephrase more freely. Only Orpheus honors these; XTTS
 * ignores them and just renders `count` stochastic takes at its own temperature.
 */
function computeTakeTemperatures(settings: ParallelTtsSettings, count: number): number[] {
  const base = typeof settings.temperature === 'number' ? settings.temperature : 0.6;
  const OFFSETS = [-0.2, 0.2, 0.4];
  const clamp = (t: number) => Math.max(0.1, Math.min(1.5, Math.round(t * 100) / 100));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const off = i < OFFSETS.length ? OFFSETS[i] : 0.2 + 0.2 * (i - 1);
    out.push(clamp(base + off));
  }
  return out;
}

export interface GenerateCandidatesParams {
  projectDir: string;
  indices: number[];
  /** Number of fresh takes per sentence (default 3). */
  takes?: number;
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

  const totalUnits = indices.length * takes;
  let done = 0;

  // ONE worker call, ONE model load: the worker generates every (index × take) at its
  // take's temperature and writes take{k}/{i}.flac under `base`.
  const takeTemperatures = computeTakeTemperatures(settings, takes);
  const res = await regenerateSentenceIndices({
    sessionId: session.sessionId,
    sessionDir: session.sessionDir!,
    settings,
    indices,
    targetSentencesDir: base,
    takeTemperatures,
    onProgress: () => { done += 1; onProgress?.(done, totalUnits); },
    signal,
  });

  // Collect + sample_fmt-match every produced candidate from its take dir.
  const takePathsByIndex = new Map<number, string[]>();
  indices.forEach((i) => takePathsByIndex.set(i, []));
  for (let k = 0; k < takes; k++) {
    const takeDir = takes > 1 ? path.join(base, `take${k}`) : base;
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
    return { success: false, candidates: [], error: res.error || 'Regeneration produced no audio.' };
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

export interface CommitParams {
  projectDir: string;
  index: number;
  /** The chosen candidate FLAC (already matched to the book's sample_fmt). If this is
   *  the original cache path, the commit is a no-op (user kept the original). */
  sourceFlacPath: string;
}

/**
 * Replace the cached {index}.flac with the approved candidate. The original is backed up
 * once to .orig-backup/ (so a later revert is possible), and the candidate is re-matched
 * to the book's sample_fmt defensively before the atomic swap.
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
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Restore a sentence's original audio from the backup (undo a commit). */
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
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

/** Remove the scratch candidate dirs for a session (call when the flow ends). */
export async function cleanupCandidates(sessionId: string): Promise<void> {
  try {
    await fs.promises.rm(scratchRoot(sessionId.replace(/^ebook-/, '')), { recursive: true, force: true });
  } catch { /* best effort */ }
}
