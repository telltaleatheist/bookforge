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

export const SENTENCE_ASR_MODEL = 'qwen3-asr-1.7b';
export const SENTENCE_ALIGN_MODEL = 'qwen3-aligner';
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

export async function transcribe(o: TranscribeOptions, scratch: string): Promise<{ words: HeardWord[]; durationS: number }> {
  const log = o.onLog ?? (() => undefined);
  const st = fs.statSync(o.audioPath);
  if (o.transcriptCachePath && fs.existsSync(o.transcriptCachePath)) {
    try {
      const c = JSON.parse(fs.readFileSync(o.transcriptCachePath, 'utf-8')) as CachedTranscript;
      if (c.model === SENTENCE_ASR_MODEL && c.audio.size === st.size && c.audio.mtimeMs === st.mtimeMs && c.words.length > 0) {
        log(`transcript reused from ${o.transcriptCachePath} (${c.words.length} words)`);
        return { words: c.words, durationS: c.durationS };
      }
      log(`transcript cache ${o.transcriptCachePath} is for other audio or another model; transcribing`);
    } catch (err) {
      log(`transcript cache ${o.transcriptCachePath} unreadable (${(err as Error).message}); transcribing`);
    }
  }
  const client = await crucibleClientFor(o.server, CRUCIBLE_CLIENT_NAME);
  await assertCrucibleModelOffered(client, o.server, 'asr', SENTENCE_ASR_MODEL);
  const dir = path.join(scratch, 'asr'); fs.mkdirSync(dir);
  const outcome = await runCrucibleJob({
    server: o.server,
    type: 'asr',
    model: SENTENCE_ASR_MODEL,
    // Qwen has no VAD (true is refused by name) and no auto-detect.
    params: { language: o.language, vad_filter: false, word_timestamps: true },
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
    const c: CachedTranscript = { model: SENTENCE_ASR_MODEL, audio: { size: st.size, mtimeMs: st.mtimeMs }, durationS: t.duration_s, words };
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
    // 1. ASR (and, beside it, this side's level envelope for the edges)
    progress('transcribe', 0, 'Transcribing with Qwen3-ASR on Crucible');
    // The envelope decodes beside the ASR, but its failure is raised only AFTER the
    // ASR settles: a Promise.all would reject on a bad decode while the GPU job was
    // still being submitted, leaving it running with nothing holding its cancel.
    const envP = levelEnvelope(o.ffmpegPath, o.audioPath, envStop.signal)
      .then((v) => ({ v, e: null as Error | null }), (e: Error) => ({ v: null as LevelEnvelope | null, e }));
    const asr: { words: HeardWord[]; durationS: number } = await transcribe(o, scratch);
    const envR = await envP;
    if (envR.e) throw envR.e;
    const env = envR.v!;
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
      const inputs: Record<string, string> = {};
      for (const w of windows) {
        if (o.signal?.aborted) throw new Error('cancelled');
        const f = path.join(wdir, `${w.index}.flac`);
        await cutWindow(o.ffmpegPath, o.audioPath, w.start, w.end, f, o.signal);
        inputs[`${w.index}.flac`] = f;
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
    const cues: { index: number; start: number; end: number; flagged: string[] }[] = [];
    let noPause = 0; let collapsed = 0; let prevEdgeEnd = 0;
    for (let i = 0; i < placed.length; i++) {
      const p = placed[i];
      const prevEnd = i > 0 ? placed[i - 1].end! : null;
      const nextStart = i + 1 < placed.length ? placed[i + 1].start! : null;
      const s = startEdge(env, p.start!, prevEnd !== null && prevEnd <= p.start! ? prevEnd : null);
      const e = endEdge(env, p.end!, nextStart !== null && nextStart >= p.end! ? nextStart : null);
      const flagged: string[] = [];
      if (!s.inSilence) { flagged.push('start-not-in-a-pause'); noPause++; }
      if (!e.inSilence) { flagged.push('end-not-in-a-pause'); noPause++; }
      let a = Math.max(s.t, prevEdgeEnd); let b = e.t;
      if (b <= a) { collapsed++; flagged.push('collapsed-to-word-times'); a = Math.max(p.start!, prevEdgeEnd); b = Math.max(p.end!, a + 0.05); }
      cues.push({ index: p.index, start: a, end: b, flagged });
      prevEdgeEnd = b;
    }

    // 5. WRITE
    progress('write', 0, 'Writing the sentences');
    const lines = ['WEBVTT', ''];
    for (const c of cues) {
      lines.push(String(c.index + 1));
      lines.push(`${vttTimestamp(c.start)} --> ${vttTimestamp(c.end)}`);
      lines.push(o.sentences[c.index].text.replace(/\s+/g, ' ').trim());
      lines.push('');
    }
    const tmp = `${o.outVttPath}.${process.pid}.part`;
    fs.writeFileSync(tmp, lines.join('\n'), 'utf-8'); fs.renameSync(tmp, o.outVttPath);

    const stats = {
      ...diff.stats,
      alignWindows: windows.length, alignWindowsFailed: alignFailed.length,
      tooLongForAligner: tooLong.reduce((n, t) => n + t.sentences.length, 0),
      cues: cues.length, notPlaced: placements.length - cues.length,
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
    fs.writeFileSync(discrepanciesPath, JSON.stringify({ audio: o.audioPath, ...discrepancies }, null, 1));
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
