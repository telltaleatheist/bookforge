/**
 * GENERATE SENTENCES, EXACT — BookForge's logic, Crucible's models.
 *
 * Owen, 2026-09-24: "all gpu use in bookforge should run through crucible, not
 * through bookforge. bookforge manages the logic, but we dont ever directly call
 * the qwen model. we call it through the crucible api and get files back." And
 * the goal: "as exact as possible, word-wise and timestamp-wise."
 *
 * The flow (every model call is a Crucible job; everything else is here):
 *
 *   1. ASR     Crucible `asr`, model `qwen3-asr-1.7b`, word timestamps on — every
 *              spoken word with its time (the aligner stamps the ASR's own words).
 *   2. DIFF    shared/sentence-align/book-diff.ts: the EPUB's words against the
 *              heard words. The EPUB text always wins; a misheard proper noun sits
 *              where the real one was said and lends it its times.
 *   3. ALIGN   Crucible `align`, model `qwen3-aligner`, ONE job holding every
 *              window where the two sides disagree, each window's audio cut from
 *              the book and told the EPUB's own text.
 *   4. EDGES   shared/sentence-align/cue-edges.ts: each cue starts and ends at the
 *              centre of the real pause beside its first and last word, from the
 *              book's own waveform — never at the next sentence's first word.
 *   5. WRITE   the VTT (EPUB text, pause-centred times) and a report: what was
 *              placed, what went to the aligner, what was never spoken, what was
 *              heard that the book does not contain, and every edge that found
 *              no pause.
 *
 * WHAT THIS REPLACES. `align-longform` (crucible jobs/alignlongform) ran all five
 * of these on the server with faster-whisper `small` as its locator. The logic is
 * BookForge's now; that job is not called from here and is left alone.
 *
 * NO FALLBACK. A server that cannot run a step fails the run by name; nothing is
 * transcribed or aligned on this machine.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readAlignment } from '@crucible/client';

import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import { assertCrucibleModelOffered, runCrucibleJob, type CrucibleJobProgress } from './job';
import { readCrucibleTranscript, vttTimestamp } from './asr';
import {
  diffBookAgainstHeard, placeWindow, planAlignWindows,
  type BookSentence, type HeardWord, type SentencePlacement,
} from '../../shared/sentence-align/book-diff';
import { endEdge, FRAME_S, startEdge, type LevelEnvelope } from '../../shared/sentence-align/cue-edges';
import { findDiscrepancies } from '../../shared/sentence-align/discrepancies';
import { compactedLength, keepPieces, mapWordsBack, type KeptPiece } from '../../shared/sentence-align/silence-compact';
import { correctToHeard, MIN_AGREEMENT } from '../../shared/sentence-align/correct-to-heard';
import { recheckPieces } from '../../shared/sentence-align/recheck';

export const SENTENCE_ASR_MODEL = 'qwen3-asr-1.7b';
export const SENTENCE_ALIGN_MODEL = 'qwen3-aligner';
/**
 * THE SECOND OPINION (Owen 2026-09-27: "Have whisper large turbo or something run on the problematic spots"). A
 * different ASR family re-hears every cue the correction would still change, and votes REGION by region: a run of
 * Qwen's changes stands when the second listen sides with Qwen (sim to Qwen >= sim to the book), else the book keeps it
 * (correct-to-heard.ts CorrectOptions.secondOpinion). Names and the book's unusual words are never replaced at all -
 * "this will really be about finding paraphrasing, not superseding the book" (Owen).
 */
export const SECOND_OPINION_MODEL = 'whisper-large-v3-turbo';
/** A heard word whose 20 ms frames never exceed this (dBFS) was heard in digital silence: a hallucination. */
export const SILENT_WORD_DB = -80;

export const SENTENCE_ALIGN_STAGES = ['transcribe', 'diff', 'align', 'edges', 'write'] as const;
export type SentenceAlignStage = (typeof SENTENCE_ALIGN_STAGES)[number];

export interface RunSentenceAlignOptions {
  /** A registered Crucible server's NAME. */
  readonly server: string;
  /** The audiobook as it is (m4b); uploaded once, for the ASR. */
  readonly audioPath: string;
  /** The EPUB's sentences in reading order. */
  readonly sentences: readonly BookSentence[];
  /** ISO code. Qwen is always told the language; there is no auto-detect. */
  readonly language: string;
  readonly ffmpegPath: string;
  readonly outVttPath: string;
  readonly reportPath: string;
  /**
   * Keep (or reuse) the ASR transcript here. The ASR is the one long GPU pass; a
   * re-run of the logic on the same audio reads this instead of transcribing again.
   * Reused only when it names this model and this audio's size and mtime.
   */
  readonly transcriptCachePath?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: { stage: SentenceAlignStage; fraction: number; message: string }) => void;
  readonly onLog?: (line: string) => void;
}

export interface SentenceAlignOutcome {
  readonly vttPath: string;
  readonly reportPath: string;
  readonly cues: number;
  readonly stats: Record<string, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. ASR
// ─────────────────────────────────────────────────────────────────────────────

interface CachedTranscript {
  readonly model: string;
  readonly audio: { readonly size: number; readonly mtimeMs: number };
  readonly durationS: number;
  readonly words: HeardWord[];
}

/** What the transcription reads of a run's options — shared with the clips run (clip-sentence-align.ts). */
export type TranscribeOptions = Pick<RunSentenceAlignOptions,
  'server' | 'audioPath' | 'language' | 'transcriptCachePath' | 'signal' | 'onProgress' | 'onLog'>;

export async function transcribe(o: TranscribeOptions, scratch: string, model: string = SENTENCE_ASR_MODEL): Promise<{ words: HeardWord[]; durationS: number }> {
  const log = o.onLog ?? (() => undefined);
  const st = fs.statSync(o.audioPath);
  if (o.transcriptCachePath && fs.existsSync(o.transcriptCachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(o.transcriptCachePath, 'utf-8')) as CachedTranscript;
      if (c.model === model && c.audio.size === st.size && c.audio.mtimeMs === st.mtimeMs && c.words.length > 0) {
        log(`transcript reused from ${o.transcriptCachePath} (${c.words.length} words)`);
        return { words: c.words, durationS: c.durationS };
      }
      log(`transcript cache ${o.transcriptCachePath} is for other audio or another model; transcribing`);
    } catch (err) {
      log(`transcript cache ${o.transcriptCachePath} unreadable (${(err as Error).message}); transcribing`);
    }
  }
  const client = await crucibleClientFor(o.server, CRUCIBLE_CLIENT_NAME);
  await assertCrucibleModelOffered(client, o.server, 'asr', model);
  const dir = path.join(scratch, 'asr'); fs.mkdirSync(dir, { recursive: true });
  const outcome = await runCrucibleJob({
    server: o.server,
    type: 'asr',
    model,
    // Qwen has no VAD (true is refused by name) and no auto-detect; Whisper's VAD stops it inventing words in silence.
    params: { language: o.language, vad_filter: model.startsWith('whisper'), word_timestamps: true },
    inputs: { [path.basename(o.audioPath)]: o.audioPath },
    artifactsTo: dir,
    ...(o.signal ? { signal: o.signal } : {}),
    onLog: log,
    onProgress: (p: CrucibleJobProgress) => o.onProgress?.({
      stage: 'transcribe', fraction: p.kind === 'warming' ? 0 : p.fraction, message: p.message,
    }),
  });
  if (outcome.artifacts.where !== 'disk') throw new Error('crucible asr: artifacts were not written to disk');
  const written = outcome.artifacts.files.get('transcript.json');
  if (!written) throw new Error(`crucible "${o.server}" asr job ${outcome.jobId} ended done without transcript.json`);
  const t = readCrucibleTranscript(JSON.parse(fs.readFileSync(written.path, 'utf-8')));
  const words: HeardWord[] = [];
  for (const seg of t.segments) {
    if (!seg.words) throw new Error(`crucible asr: a segment has no word timestamps (${seg.start.toFixed(1)} s); asked for them`);
    for (const w of seg.words) words.push({ word: w.word, start: w.start, end: w.end });
  }
  words.sort((a, b) => a.start - b.start);
  if (o.transcriptCachePath) {
    const c: CachedTranscript = { model, audio: { size: st.size, mtimeMs: st.mtimeMs }, durationS: t.duration_s, words };
    fs.writeFileSync(o.transcriptCachePath, JSON.stringify(c));
  }
  log(`transcribed ${path.basename(o.audioPath)}: ${words.length} words over ${t.duration_s.toFixed(0)} s (job ${outcome.jobId})`);
  return { words, durationS: t.duration_s };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio on this side: the level envelope and window cuts (ffmpeg, CPU)
// ─────────────────────────────────────────────────────────────────────────────

/** 20 ms RMS in dBFS over the whole book, from one streaming 16 kHz mono decode. */
export function levelEnvelope(ffmpeg: string, audio: string, signal?: AbortSignal): Promise<LevelEnvelope> {
  return new Promise((resolve, reject) => {
    const SR = 16000; const per = Math.round(FRAME_S * SR);
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', audio, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = (): void => { p.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const out: number[] = []; let acc = 0; let n = 0; let carry: Buffer | null = null; let err = '';
    p.stdout.on('data', (chunk: Buffer) => {
      const buf = carry ? Buffer.concat([carry, chunk]) : chunk;
      const whole = buf.length - (buf.length % 2);
      for (let i = 0; i < whole; i += 2) {
        const s = buf.readInt16LE(i) / 32768; acc += s * s; n++;
        if (n === per) { out.push(10 * Math.log10(acc / per + 1e-18)); acc = 0; n = 0; }
      }
      carry = whole < buf.length ? buf.subarray(whole) : null;
    });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${audio} for its levels (exit ${code}): ${err.trim().slice(-400)}`));
      resolve({ db: Float32Array.from(out) });
    });
  });
}

/**
 * One window's audio. The ✕ reaches it: a cancel kills the running ffmpeg, and the
 * caller checks the signal before each cut, so a run with hundreds of disputed
 * windows stops within one cut rather than after all of them.
 */
export function cutWindow(ffmpeg: string, audio: string, start: number, end: number, out: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-ss', start.toFixed(3), '-i', audio, '-t', (end - start).toFixed(3),
      '-ac', '1', '-ar', '16000', '-c:a', 'flac', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    const onAbort = (): void => { p.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let err = '';
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      return code === 0 ? resolve() : reject(new Error(`ffmpeg could not cut ${start.toFixed(2)}-${end.toFixed(2)} s: ${err.trim().slice(-300)}`));
    });
  });
}

/**
 * EVERY window's audio from ONE streaming 16 kHz mono decode (2026-09-26), written as 16-bit WAV.
 *
 * This replaced one ffmpeg per window (cutWindow in a loop - 955 for HoA, 1,434 for The Coming of the Third Reich).
 * Twice in a day one of those processes finished writing its file and then WEDGED AT EXIT on Windows: 0 CPU, one
 * thread in Wait, 96 handles held, Stop-Process could not make node see `close` - and the whole book stopped with
 * no log line. A book's window cuts are now one child process, as the level envelope and the compaction already
 * were, and the windows are sliced out of the stream in memory. Windows may overlap and arrive in any order; only
 * the windows currently open are held (each ~15 s = ~0.5 MB), never the book.
 */
export function cutWindowsStreamed(ffmpeg: string, audio: string, windows: readonly { index: number; start: number; end: number }[],
  dir: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const SR = 16000;
  type Open = { name: string; s0: number; s1: number; buf: Buffer };
  const todo = windows.map((w) => ({ name: `${w.index}.wav`, s0: Math.max(0, Math.round(w.start * SR)), s1: Math.max(0, Math.round(w.end * SR)) }))
    .filter((w) => w.s1 > w.s0).sort((a, b) => a.s0 - b.s0);
  const inputs: Record<string, string> = {};
  const writeWav = (w: Open): void => {
    const n = w.s1 - w.s0;
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + n * 2, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(SR, 24);
    hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(n * 2, 40);
    const f = path.join(dir, w.name);
    fs.writeFileSync(f, Buffer.concat([hdr, w.buf]));
    inputs[w.name] = f;
  };
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', audio, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = (): void => { p.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let n = 0; let next = 0; let open: Open[] = []; let carry: Buffer | null = null; let err = '';
    p.stdout.on('data', (chunk: Buffer) => {
      const b = carry ? Buffer.concat([carry, chunk]) : chunk;
      const whole = b.length - (b.length % 2);
      const hi = n + whole / 2;                            // this chunk holds samples [n, hi)
      while (next < todo.length && todo[next].s0 < hi) {
        const t = todo[next++]; open.push({ ...t, buf: Buffer.alloc((t.s1 - t.s0) * 2) });
      }
      const still: Open[] = [];
      for (const w of open) {
        const from = Math.max(n, w.s0); const to = Math.min(hi, w.s1);
        if (to > from) b.copy(w.buf, (from - w.s0) * 2, (from - n) * 2, (to - n) * 2);
        if (w.s1 <= hi) writeWav(w); else still.push(w);
      }
      open = still; n = hi;
      carry = whole < b.length ? b.subarray(whole) : null;
    });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${audio} for the aligner windows (exit ${code}): ${err.trim().slice(-400)}`));
      // a window running past the decoded end keeps its zero tail; one that never opened lies wholly past the end
      for (const w of open) writeWav(w);
      while (next < todo.length) { const t = todo[next++]; writeWav({ ...t, buf: Buffer.alloc((t.s1 - t.s0) * 2) }); }
      resolve(inputs);
    });
  });
}

/**
 * The audio with its digital silence cut out: one streaming 16 kHz mono decode, only the samples inside `pieces`
 * written, KEEP_GAP_S of silence between them (their dstStart already carries it). 16-bit WAV.
 */
function writeCompacted(ffmpeg: string, audio: string, pieces: readonly KeptPiece[], out: string, signal?: AbortSignal): Promise<void> {
  // STREAMED to disk, never held whole (HoA's 12.8 h would be ~1.5 GB in memory on a machine that is short of it):
  // the pieces are in timeline order, so the output only ever grows - write each kept sample at its place and pad
  // the gaps between pieces with zeros as they are reached.
  return new Promise((resolve, reject) => {
    const SR = 16000;
    const last = pieces[pieces.length - 1];
    const total = Math.ceil((last.dstStart + (last.srcEnd - last.srcStart)) * SR);
    const tmp = `${out}.${process.pid}.part`;
    const fd = fs.openSync(tmp, 'w');
    const hdr = Buffer.alloc(44);
    hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + total * 2, 4); hdr.write('WAVE', 8); hdr.write('fmt ', 12);
    hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(SR, 24);
    hdr.writeUInt32LE(SR * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(total * 2, 40);
    fs.writeSync(fd, hdr);
    let written = 0;                                   // samples written so far
    const zeros = Buffer.alloc(SR * 2 * 10);
    const padTo = (d: number): void => { while (written < d) { const k = Math.min(d - written, zeros.length / 2); fs.writeSync(fd, zeros, 0, k * 2); written += k; } };
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', audio, '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = (): void => { p.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    let n = 0; let k = 0; let carry: Buffer | null = null; let err = '';
    p.stdout.on('data', (chunk: Buffer) => {
      const b = carry ? Buffer.concat([carry, chunk]) : chunk;
      const whole = b.length - (b.length % 2);
      const outBuf = Buffer.alloc(whole); let o = 0; let runStart = -1;
      const flush = (): void => { if (o > 0) { fs.writeSync(fd, outBuf, 0, o); written += o / 2; o = 0; } };
      for (let i = 0; i < whole; i += 2, n++) {
        const t = n / SR;
        while (k < pieces.length && t >= pieces[k].srcEnd) k++;
        if (k >= pieces.length) break;
        const pc = pieces[k];
        if (t < pc.srcStart) continue;
        const d = Math.round((pc.dstStart + (t - pc.srcStart)) * SR);
        if (d >= total) continue;
        if (d !== written + o / 2) { flush(); if (d > written) padTo(d); else continue; }
        outBuf[o] = b[i]; outBuf[o + 1] = b[i + 1]; o += 2; runStart = d;
      }
      flush(); void runStart;
      carry = whole < b.length ? b.subarray(whole) : null;
    });
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', (e) => { fs.closeSync(fd); reject(e); });
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      try { padTo(total); } finally { fs.closeSync(fd); }
      if (signal?.aborted) { fs.rmSync(tmp, { force: true }); return reject(new Error('cancelled')); }
      if (code !== 0) { fs.rmSync(tmp, { force: true }); return reject(new Error(`ffmpeg could not decode ${audio} to compact it (exit ${code}): ${err.trim().slice(-300)}`)); }
      fs.renameSync(tmp, out); resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

export async function runSentenceAlign(o: RunSentenceAlignOptions): Promise<SentenceAlignOutcome> {
  const log = o.onLog ?? (() => undefined);
  const progress = (stage: SentenceAlignStage, fraction: number, message: string): void => o.onProgress?.({ stage, fraction, message });
  if (!fs.existsSync(o.audioPath)) throw new Error(`audiobook not found: ${o.audioPath}`);
  if (o.sentences.length === 0) throw new Error('no sentences to place: the ebook extraction produced none');
  if (!o.language || o.language === 'auto') {
    throw new Error('Qwen3 is always told the language and has no auto-detect; the run needs an ISO code (e.g. en)');
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-sentence-align-'));
  /*
   * THE LEVEL DECODE HAS AN OWNER. It runs beside the ASR and used to stop only on
   * the user's cancel, so a run that failed or was abandoned mid-ASR left its
   * ffmpeg decoding a whole book with no one reading it (found orphaned
   * 2026-09-25, from a keeper run). Its own stop, fired by the `finally` below on
   * every exit and by the caller's cancel.
   */
  const envStop = new AbortController();
  const onCallerAbort = (): void => envStop.abort();
  o.signal?.addEventListener('abort', onCallerAbort, { once: true });
  try {
    // 1. The level envelope FIRST (it says where the silence is), then the ASR on the audio only.
    // Owen 2026-09-25: "we should never send silence to the ASR tool" - Qwen3-ASR has no VAD and transcribes a
    // partial recording's silent stretches (83 min of an invented sentence on WoA's website master). So digital
    // silence >= MIN_SILENT_S is cut out before the upload and every word is mapped back (silence-compact.ts).
    progress('transcribe', 0, 'Measuring the audio (where the silence is)');
    const env = await levelEnvelope(o.ffmpegPath, o.audioPath, envStop.signal);
    const pieces = keepPieces(env, env.db.length * FRAME_S);
    let asr: { words: HeardWord[]; durationS: number };
    if (pieces === null) {
      progress('transcribe', 0, 'Transcribing with Qwen3-ASR on Crucible');
      asr = await transcribe(o, scratch);
    } else {
      const kept = compactedLength(pieces); const whole = env.db.length * FRAME_S;
      log(`cutting ${((whole - kept) / 3600).toFixed(2)} h of digital silence out of ${(whole / 3600).toFixed(2)} h before the ASR `
        + `(${pieces.length} piece(s), ${(kept / 3600).toFixed(2)} h sent)`);
      // Kept beside the transcript cache and rebuilt only when the pieces change, so a re-run reuses the ASR.
      const compact = o.transcriptCachePath ? `${o.transcriptCachePath}.compact.wav` : path.join(scratch, 'compact.wav');
      const sig = JSON.stringify(pieces); const sigPath = `${compact}.pieces.json`;
      if (!fs.existsSync(compact) || !fs.existsSync(sigPath) || fs.readFileSync(sigPath, 'utf-8') !== sig) {
        await writeCompacted(o.ffmpegPath, o.audioPath, pieces, compact, envStop.signal);
        fs.writeFileSync(sigPath, sig);
      }
      progress('transcribe', 0, 'Transcribing the audio (silence cut out) with Qwen3-ASR on Crucible');
      const heard = await transcribe({ ...o, audioPath: compact }, scratch);
      const back = mapWordsBack(heard.words, pieces);
      if (back.dropped) log(`dropped ${back.dropped} word(s) heard in the gaps between kept pieces`);
      asr = { words: back.words, durationS: whole };
    }
    const audioS = Math.max(asr.durationS, env.db.length * FRAME_S);
    /*
     * WORDS HEARD IN DIGITAL SILENCE ARE NOT WORDS (2026-09-25). Qwen3-ASR runs with no VAD (Crucible refuses
     * vad_filter for it) and, handed a partial recording's silent stretches, it transcribes them: WoA's website
     * master gave 83 minutes of "The first thing that you need to do is to get a good quality of light" on repeat.
     * A heard word whose audio never rises above SILENT_WORD_DB is dropped before anything reads it; a real
     * recording's room tone sits far above that, so this only ever removes words over true silence.
     */
    const heardAll = asr.words.length;
    asr.words = asr.words.filter((w) => {
      const f0 = Math.max(0, Math.floor(w.start / FRAME_S)); const f1 = Math.min(env.db.length, Math.ceil(w.end / FRAME_S) + 1);
      for (let f = f0; f < f1; f++) if (env.db[f] > SILENT_WORD_DB) return true;
      return false;
    });
    if (asr.words.length < heardAll) log(`dropped ${heardAll - asr.words.length} heard word(s) over digital silence (ASR hallucination)`);

    // 2. DIFF
    progress('diff', 0, 'Matching the book to what was heard');
    const diff = diffBookAgainstHeard(o.sentences, asr.words);
    log(`diff: ${diff.stats.bookTokens} book words, ${diff.stats.heardTokens} heard; exact ${diff.stats.exact}, `
      + `near-miss ${diff.stats.fuzzy}, substituted ${diff.stats.sub}; sentences placed ${diff.stats.placed}, `
      + `disputed ${diff.stats.disputed}, unspoken ${diff.stats.unspoken}; extra-audio runs ${diff.extraAudio.length}`);
    const placements: SentencePlacement[] = diff.sentences.slice();

    // 3. ALIGN the disputed windows, one job
    const { windows, tooLong } = planAlignWindows(diff, o.sentences, audioS);
    const alignFailed: { index: number; sentences: readonly number[]; error: string }[] = [];
    if (windows.length > 0) {
      progress('align', 0, `Cutting ${windows.length} window(s) for the aligner`);
      const wdir = path.join(scratch, 'windows'); fs.mkdirSync(wdir);
      // one streaming decode for every window (never one ffmpeg per window - see cutWindowsStreamed)
      const inputs = await cutWindowsStreamed(o.ffmpegPath, o.audioPath, windows, wdir, o.signal);
      if (Object.keys(inputs).length !== windows.length) {
        throw new Error(`cut ${Object.keys(inputs).length} aligner window(s) of ${windows.length} (a window with no length?)`);
      }
      const client = await crucibleClientFor(o.server, CRUCIBLE_CLIENT_NAME);
      await assertCrucibleModelOffered(client, o.server, 'align', SENTENCE_ALIGN_MODEL);
      const adir = path.join(scratch, 'align'); fs.mkdirSync(adir);
      // The wire `client.align()` sends (sdk align(): params {language, chunks}, inputs `<index>.<ext>`),
      // through BookForge's job runner so the queue's cancel, progress and artifact landing apply.
      const outcome = await runCrucibleJob({
        server: o.server,
        type: 'align',
        model: SENTENCE_ALIGN_MODEL,
        params: { language: o.language, chunks: windows.map((w) => ({ index: w.index, text: w.text })) },
        inputs,
        artifactsTo: adir,
        ...(o.signal ? { signal: o.signal } : {}),
        onLog: log,
        onProgress: (p: CrucibleJobProgress) => progress('align', p.kind === 'warming' ? 0 : p.fraction, p.message),
      });
      if (outcome.artifacts.where !== 'disk') throw new Error('crucible align: artifacts were not written to disk');
      const written = outcome.artifacts.files.get('alignment.json');
      if (!written) throw new Error(`crucible "${o.server}" align job ${outcome.jobId} ended done without alignment.json`);
      const alignment = readAlignment(fs.readFileSync(written.path));
      const byIndex = new Map(windows.map((w) => [w.index, w]));
      for (const r of alignment.windows) {
        const w = byIndex.get(r.index);
        if (!w) throw new Error(`crucible align returned window ${r.index}, which was never sent`);
        if (r.items === null) { alignFailed.push({ index: w.index, sentences: w.sentences, error: r.error ?? 'no reason given' }); continue; }
        for (const p of placeWindow(w, o.sentences, r.items)) placements[p.index] = p;
      }
      log(`align: ${windows.length} window(s), ${alignFailed.length} failed (job ${outcome.jobId})`);
    }

    // 4. EDGES — every placed sentence, in time order
    progress('edges', 0, 'Putting every cue edge in a pause');
    const placed = placements.filter((p) => p.status === 'placed' && p.start !== null && p.end !== null)
      .sort((a, b) => a.start! - b.start!);
    const cues: { index: number; start: number; end: number; flagged: string[]; heardEnd: number }[] = [];
    let noPause = 0; let collapsed = 0; let prevEdgeEnd = 0; let absorbed = 0;
    // TRAILING ADDITIONS ARE THE CUE'S OWN WORDS (Owen's spot check, 2026-09-26: the reader says "Ephesians 5 verse 21"
    // where the book prints "(Eph. 5:21)"). Words heard between a sentence's last word and the next sentence's first
    // belonged to NO cue: the edge landed in the pause before "verse", the clip ended on "ver-", and a long row that
    // joined the two cues carried "verse 21" as audio with no text. Up to MAX_TRAILING_WORDS such words, starting within
    // TRAILING_GAP_S of the sentence's end, are the reader's own addition: the sentence is heard through them, its end
    // edge moves past them, and the correction inserts them. A longer run is an unplaced passage, left alone.
    const MAX_TRAILING_WORDS = 4; const TRAILING_GAP_S = 1.5;
    const heardByTime = asr.words.slice().sort((a, b) => a.start - b.start);
    const heardFrom = (t: number): number => { let lo = 0; let hi = heardByTime.length; while (lo < hi) { const m = (lo + hi) >> 1; if ((heardByTime[m].start + heardByTime[m].end) / 2 <= t) lo = m + 1; else hi = m; } return lo; };
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const prevEnd = i > 0 ? placed[i - 1].end! : null;
      const nextStart = i + 1 < placed.length ? placed[i + 1].start! : null;
      let pEnd = p.end!;
      {
        const gap: HeardWord[] = [];
        for (let k = heardFrom(p.end!); k < heardByTime.length; k++) {
          const w = heardByTime[k]; const mid = (w.start + w.end) / 2;
          if (nextStart !== null && mid >= nextStart) break;
          gap.push(w); if (gap.length > MAX_TRAILING_WORDS) break;
        }
        // NOT THE NEXT SENTENCE'S OPENING (Owen, spot check 2: "...replaced in 1994. He", "Hurry. I", "I said. Why"):
        // when the next sentence's placement starts a word late, its first word sits in this gap - that word is not
        // this sentence's addition. Any gap word that the next sentence's first three book words hold stops the take.
        const norm = (t: string): string => t.toLowerCase().replace(/[‘’ʼ'`]/g, '').replace(/[^a-z0-9]/g, '');
        const nextOpen = i + 1 < placed.length
          ? new Set(o.sentences[placed[i + 1].index].text.split(/\s+/).slice(0, 3).map(norm).filter(Boolean)) : new Set<string>();
        const opensNext = gap.some((w) => nextOpen.has(norm(w.word)));
        if (gap.length > 0 && gap.length <= MAX_TRAILING_WORDS && gap[0].start - p.end! <= TRAILING_GAP_S && !opensNext
            && (nextStart === null || gap[gap.length - 1].end < nextStart)) { pEnd = gap[gap.length - 1].end; absorbed++; }
      }
      const s = startEdge(env, p.start!, prevEnd !== null && prevEnd <= p.start! ? prevEnd : null);
      const e = endEdge(env, pEnd, nextStart !== null && nextStart >= pEnd ? nextStart : null);
      const flagged: string[] = [];
      if (!s.inSilence) { flagged.push('start-not-in-a-pause'); noPause++; }
      if (!e.inSilence) { flagged.push('end-not-in-a-pause'); noPause++; }
      let a = Math.max(s.t, prevEdgeEnd); let b = e.t;
      if (b <= a) { collapsed++; flagged.push('collapsed-to-word-times'); a = Math.max(p.start!, prevEdgeEnd); b = Math.max(p.end!, a + 0.05); }
      cues.push({ index: p.index, start: a, end: b, flagged, heardEnd: pEnd });
      prevEdgeEnd = b;
    }
    if (absorbed) log(`${absorbed} sentence(s) carry the reader's trailing addition (<= ${MAX_TRAILING_WORDS} words heard before the next sentence)`);

    // 4b. THE CUE SAYS WHAT THE READER SAID (Owen 2026-09-25: "correct the vtt so it reflects the real audio so we
    // arent losing training data" - and "a normal part of the process of prepping a book"). Word by word against the
    // words heard in the cue's span: the BOOK's word wherever the reader said it (near-miss spellings and proper
    // nouns included), the READER's word where it differs, insertions kept, omissions removed; a cue that barely
    // matches is left as the book has it (more likely misplaced than reworded). Every change is recorded.
    progress('write', 0, 'Correcting each sentence to what the reader said');
    const heardSorted = asr.words.slice().sort((a, b) => a.start - b.start);
    const heardIn = (a: number, b: number): string[] => {
      let lo = 0; let hi = heardSorted.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if ((heardSorted[m].start + heardSorted[m].end) / 2 < a) lo = m + 1; else hi = m; }
      const out: string[] = [];
      for (let k = lo; k < heardSorted.length && (heardSorted[k].start + heardSorted[k].end) / 2 <= b; k++) out.push(heardSorted[k].word);
      return out;
    };
    const cueText = new Map<number, string>();
    const corrections: { index: number; start: number; end: number; book: string; heard: string; heardLong?: string; text: string; agreement: number; edits: unknown[] }[] = [];
    let barelyMatched = 0; const barelyIdx: number[] = [];
    // THE BOOK'S NAMES (Owen's spot check: "Chantal" became "Gentile"): a word the book capitalises mid-sentence and
    // never writes lower-case is a name, and the correction never replaces it.
    const properNouns = new Set<string>(); const lower = new Set<string>();
    for (const snt of o.sentences) {
      const ws = snt.text.split(/\s+/).filter(Boolean);
      ws.forEach((w, k) => {
        const core = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''); if (!core) return;
        const kk = core.toLowerCase().replace(/[‘’ʼ'`]/g, '').replace(/[^a-z0-9]/g, '');
        if (/^\p{Ll}/u.test(core)) lower.add(kk);
        else if (k > 0 && /^\p{Lu}\p{Ll}/u.test(core) && !/[.!?:"“”]$/.test(ws[k - 1])) properNouns.add(kk);
      });
    }
    for (const k of lower) properNouns.delete(k);
    // THE BOOK'S UNUSUAL WORDS (Owen 2026-09-27: "the books proper nouns and unusual words should be trusted"): lower-case
    // words of >= 6 letters the whole book uses at most twice. Trusted like names (correct-to-heard CorrectOptions.rareWords).
    const wordCount = new Map<string, number>();
    for (const snt of o.sentences) for (const w of snt.text.split(/\s+/)) {
      const core = w.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (!/^\p{Ll}/u.test(core)) continue;
      const kk = core.toLowerCase().replace(/[‘’ʼ'`]/g, '').replace(/[^a-z0-9]/g, '');
      if (kk.length >= 6) wordCount.set(kk, (wordCount.get(kk) ?? 0) + 1);
    }
    const rareWords = new Set<string>([...wordCount].filter(([, n]) => n <= 2).map(([k]) => k));
    // First pass on the book-length transcript: which cues the correction WOULD change (or finds barely matching).
    const first = new Map<number, { book: string; heard: string[]; r: ReturnType<typeof correctToHeard> }>();
    for (const c of cues) {
      const book = o.sentences[c.index].text.replace(/\s+/g, ' ').trim();
      const p = placements[c.index];
      if (!p || p.start === null || p.end === null) continue;
      const heard = heardIn(p.start, Math.max(p.end, c.heardEnd));
      first.set(c.index, { book, heard, r: correctToHeard(book, heard, { properNouns, rareWords }) });
    }
    // RE-HEAR every such cue on its own audio (shared/sentence-align/recheck.ts): the long pass drops a sentence's
    // opening words at its piece boundaries, and a correction built on that absence deletes words the clip contains.
    const suspects = cues.filter((c) => { const f = first.get(c.index); return f && (f.r.changed || f.r.agreement < MIN_AGREEMENT); });
    const reheard = new Map<number, string[]>();
    if (suspects.length > 0) {
      progress('write', 0, `Re-hearing ${suspects.length} corrected cue(s) on their own audio`);
      const rp = recheckPieces(suspects.map((c) => ({ start: c.start, end: c.end })), audioS);
      const rwav = o.transcriptCachePath ? `${o.transcriptCachePath}.recheck.wav` : path.join(scratch, 'recheck.wav');
      const rsig = JSON.stringify(rp); const rsigPath = `${rwav}.pieces.json`;
      if (!fs.existsSync(rwav) || !fs.existsSync(rsigPath) || fs.readFileSync(rsigPath, 'utf-8') !== rsig) {
        await writeCompacted(o.ffmpegPath, o.audioPath, rp, rwav, envStop.signal);
        fs.writeFileSync(rsigPath, rsig);
      }
      const rdir = path.join(scratch, 'recheck'); fs.mkdirSync(rdir, { recursive: true });
      const rh = await transcribe({ ...o, audioPath: rwav, transcriptCachePath: o.transcriptCachePath ? `${o.transcriptCachePath}.recheck.json` : undefined }, rdir);
      const back = mapWordsBack(rh.words, rp).words.filter((w) => {
        const f0 = Math.max(0, Math.floor(w.start / FRAME_S)); const f1 = Math.min(env.db.length, Math.ceil(w.end / FRAME_S) + 1);
        for (let f = f0; f < f1; f++) if (env.db[f] > SILENT_WORD_DB) return true;
        return false;
      }).sort((a, b) => a.start - b.start);
      // the cue's own EDGES (pause centres, the audio a slicer cuts), not the placement: that is the clip's audio
      for (const c of suspects) {
        const ws: string[] = [];
        for (const w of back) { const m = (w.start + w.end) / 2; if (m < c.start) continue; if (m > c.end) break; ws.push(w.word); }
        reheard.set(c.index, ws);
      }
    }
    let withdrawn = 0; let recovered = 0;
    // Qwen's verdict per cue: the long pass, or its own-audio re-hear where there was one
    const qwen = new Map<number, { heard: string[]; r: ReturnType<typeof correctToHeard> }>();
    for (const c of cues) {
      const f = first.get(c.index); if (!f) continue;
      const again = reheard.get(c.index);
      const r = again ? correctToHeard(f.book, again, { properNouns, rareWords }) : f.r;
      if (again && f.r.changed && !r.changed) withdrawn++;
      if (again && f.r.agreement < MIN_AGREEMENT && r.agreement >= MIN_AGREEMENT) recovered++;
      qwen.set(c.index, { heard: again ?? f.heard, r });
    }
    if (suspects.length > 0) log(`re-heard ${suspects.length} cue(s) on their own audio: ${withdrawn} correction(s) withdrawn (the long pass had missed words the clip holds), ${recovered} misplaced cue(s) recovered`);

    // THE SECOND OPINION (SECOND_OPINION_MODEL): every cue Qwen would still change is heard by a different ASR family on
    // its own audio (padded like the re-hear); an edit stands only where both make it. Disagreements keep the book's
    // word and are listed in discrepancies.json `disputed` for a human.
    const contested = cues.filter((c) => qwen.get(c.index)?.r.changed);
    const secondHeard = new Map<number, string[]>();
    if (contested.length > 0) {
      progress('write', 0, `Second opinion: ${SECOND_OPINION_MODEL} on ${contested.length} corrected cue(s)`);
      const sp = recheckPieces(contested.map((c) => ({ start: c.start, end: c.end })), audioS);
      const swav = o.transcriptCachePath ? `${o.transcriptCachePath}.second.wav` : path.join(scratch, 'second.wav');
      const ssig = JSON.stringify(sp); const ssigPath = `${swav}.pieces.json`;
      if (!fs.existsSync(swav) || !fs.existsSync(ssigPath) || fs.readFileSync(ssigPath, 'utf-8') !== ssig) {
        await writeCompacted(o.ffmpegPath, o.audioPath, sp, swav, envStop.signal);
        fs.writeFileSync(ssigPath, ssig);
      }
      const sdir = path.join(scratch, 'second'); fs.mkdirSync(sdir, { recursive: true });
      const sh = await transcribe({ ...o, audioPath: swav, transcriptCachePath: o.transcriptCachePath ? `${o.transcriptCachePath}.second.json` : undefined }, sdir, SECOND_OPINION_MODEL);
      const back = mapWordsBack(sh.words, sp).words.sort((a, b) => a.start - b.start);
      for (const c of contested) {
        const ws: string[] = [];
        for (const w of back) { const m = (w.start + w.end) / 2; if (m < c.start) continue; if (m > c.end) break; ws.push(w.word); }
        secondHeard.set(c.index, ws);
      }
    }
    let vetoed = 0; const disputedCues: { index: number; start: number; end: number; book: string; qwen: string; second: string; disputed: unknown[] }[] = [];
    for (const c of cues) {
      const f = first.get(c.index); const q = qwen.get(c.index);
      if (!f || !q) { cueText.set(c.index, o.sentences[c.index].text.replace(/\s+/g, ' ').trim()); continue; }
      const two = secondHeard.get(c.index);
      const r = two ? correctToHeard(f.book, q.heard, { properNouns, rareWords, secondOpinion: two }) : q.r;
      if (two && r.disputed && r.disputed.length > 0) {
        vetoed += r.disputed.length;
        disputedCues.push({ index: c.index, start: c.start, end: c.end, book: f.book, qwen: q.heard.join(' '), second: two.join(' '), disputed: r.disputed as unknown[] });
      }
      if (r.agreement < MIN_AGREEMENT) { barelyMatched++; barelyIdx.push(c.index); }
      cueText.set(c.index, r.changed ? r.text : f.book);
      if (r.changed) corrections.push({ index: c.index, start: c.start, end: c.end, book: f.book, heard: q.heard.join(' '),
        ...(reheard.has(c.index) ? { heardLong: f.heard.join(' ') } : {}), ...(two ? { second: two.join(' ') } : {}),
        text: r.text, agreement: +r.agreement.toFixed(3), edits: r.edits as unknown[] });
    }
    if (contested.length > 0) log(`second opinion (${SECOND_OPINION_MODEL}) on ${contested.length} cue(s): ${vetoed} edit(s) the two models did not share kept the book's word; ${disputedCues.length} cue(s) listed for review`);
    log(`corrected ${corrections.length} of ${cues.length} cue(s) to what the reader said; ${barelyMatched} misplaced (heard words agree on < ${Math.round(MIN_AGREEMENT * 100)} %) - not written`);

    // 5. WRITE
    progress('write', 0, 'Writing the sentences');
    const lines = ['WEBVTT', ''];
    // A cue whose heard words agree on < MIN_AGREEMENT of its text is NOT in the audio where it was put: the forced
    // aligner places whatever it is told (WoA 2026-09-25: the EPUB's review blurbs, "Contents" and "Acknowledgments"
    // were laid over the spoken title - 707 of 5,631 cues). Such a cue is not written; discrepancies.json lists it.
    const misplaced = new Set(barelyIdx);
    let written = 0;
    for (const c of cues) {
      if (misplaced.has(c.index)) continue;
      lines.push(String(c.index + 1));
      lines.push(`${vttTimestamp(c.start)} --> ${vttTimestamp(c.end)}`);
      lines.push(cueText.get(c.index) ?? o.sentences[c.index].text.replace(/\s+/g, ' ').trim());
      lines.push('');
      written++;
    }
    const tmp = `${o.outVttPath}.${process.pid}.part`;
    fs.writeFileSync(tmp, lines.join('\n'), 'utf-8'); fs.renameSync(tmp, o.outVttPath);

    const stats = {
      ...diff.stats,
      alignWindows: windows.length, alignWindowsFailed: alignFailed.length,
      tooLongForAligner: tooLong.reduce((n, t) => n + t.sentences.length, 0),
      cues: cues.length, notPlaced: placements.length - cues.length, correctedToHeard: corrections.length,
      edgesWithoutPause: noPause, collapsed,
    };
    const report = {
      generator: 'bookforge sentence-align', asrModel: SENTENCE_ASR_MODEL, alignModel: SENTENCE_ALIGN_MODEL,
      server: o.server, audio: o.audioPath, language: o.language, stats,
      notPlaced: placements.filter((p) => p.status !== 'placed').map((p) => ({
        index: p.index, status: p.status, reason: p.reason ?? null, coverage: +p.coverage.toFixed(3),
        text: o.sentences[p.index].text.slice(0, 200),
      })),
      extraAudio: diff.extraAudio,
      alignFailed, tooLong,
      flaggedCues: cues.filter((c) => c.flagged.length).map((c) => ({ index: c.index, start: c.start, end: c.end, flagged: c.flagged })),
      words: placements.map((p) => ({ index: p.index, status: p.status, words: p.words })),
    };
    fs.writeFileSync(o.reportPath, JSON.stringify(report));

    // WHERE THE AUDIO AND THE BOOK DISAGREE (Owen 2026-09-25): audio the text does not hold,
    // text the audio does not hold, paraphrase, pace outliers, loud non-speech, a bed under the
    // voice - one file a person reads after the run, beside the report.
    const discrepancies = findDiscrepancies({
      sentences: o.sentences, placements,
      placedByDiff: new Set(diff.sentences.filter((p) => p.status === 'placed').map((p) => p.index)),
      cues, heard: asr.words, extraAudio: diff.extraAudio, env,
    });
    const discrepanciesPath = path.join(path.dirname(o.reportPath), 'discrepancies.json');
    fs.writeFileSync(discrepanciesPath, JSON.stringify({ audio: o.audioPath, ...discrepancies,
      corrections: { count: corrections.length, note: 'cue text corrected to the words heard; the book word is kept wherever the reader said it (near-miss spellings included)', items: corrections },
      disputed: { count: disputedCues.length, model: SECOND_OPINION_MODEL, note: 'edits qwen made that the second opinion did not share: the book kept its word; listed for a human (book / qwen / second heard, and each disputed edit)', items: disputedCues },
      // cues whose heard words agree on < 30 % of the book's: more likely misplaced than reworded - exclusion candidates
      barelyMatched: { count: barelyIdx.length, note: 'misplaced: the heard words in the span agree on < 30 % of the text - not written to the VTT', sentences: barelyIdx } }, null, 1));
    log(`discrepancies: ${Object.entries(discrepancies.summary).map(([k, v]) => `${k} ${v.count} (${v.seconds} s)`).join(', ') || 'none'} -> ${discrepanciesPath}`);
    log(`wrote ${cues.length} cue(s) to ${o.outVttPath}; ${stats.notPlaced} sentence(s) not placed, `
      + `${noPause} edge(s) without a pause, ${collapsed} collapsed; report ${o.reportPath}`);
    progress('write', 1, 'Done');
    return { vttPath: o.outVttPath, reportPath: o.reportPath, cues: cues.length, stats };
  } finally {
    envStop.abort();
    o.signal?.removeEventListener('abort', onCallerAbort);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
