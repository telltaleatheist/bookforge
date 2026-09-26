/**
 * GENERATE SENTENCES FOR CLIPS — the book's own text for each of many short clips.
 *
 * Owen, 2026-09-25: "make sure bookforge-cli's generate-sentences can run on clips
 * and find the original text if given the source epub." The use: a folder of
 * training clips cut from a book whose places in the book are unknown. Each clip
 * gets the EPUB's exact words for what it holds, with per-sentence times, and the
 * sentences cut by its edges are reported as partial rather than passed off.
 *
 * The same five steps as the whole-book run (sentence-align.ts), with the same
 * models on Crucible and the same shared logic, and ONE difference: each clip is
 * LOCATED in the book on its own before it is diffed (shared/sentence-align/
 * clip-locate.ts), because the whole-book diff assumes one recording in book order.
 *
 *   1. STITCH  every clip decoded to 16 kHz mono, joined with STITCH_GAP_S of
 *              silence, into one file; the ASR runs ONCE over it (Crucible batches).
 *   2. ASR     Crucible `asr`, qwen3-asr-1.7b, word timestamps; the words dealt
 *              back to their clips by time.
 *   3. LOCATE  each clip's unique heard word runs vote for its place in the book.
 *   4. DIFF    each clip against its own stretch of the book (book-diff.ts).
 *   5. ALIGN   every clip's disputed windows in ONE Crucible `align` job, each
 *              window cut from its own clip.
 *   6. EDGES   pause centres from each clip's own waveform (cue-edges.ts).
 *   7. WRITE   clips.json (everything), clips.tsv (id, status, text) and one VTT
 *              per located clip.
 *
 * NO FALLBACK: a step a server cannot run fails the run by name.
 */

import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readAlignment } from '@crucible/client';

import { CRUCIBLE_CLIENT_NAME, crucibleClientFor } from './servers';
import { assertCrucibleModelOffered, runCrucibleJob, type CrucibleJobProgress } from './job';
import { vttTimestamp } from './asr';
import { cutWindow, SENTENCE_ALIGN_MODEL, SENTENCE_ASR_MODEL, transcribe } from './sentence-align';
import {
  diffBookAgainstHeard, placeWindow, planAlignWindows,
  type AlignWindowPlan, type BookSentence, type HeardWord, type SentencePlacement,
} from '../../shared/sentence-align/book-diff';
import { buildBookIndex, locateClip, splitHeardByClip, stitchPlan, STITCH_GAP_S, type ClipLocation } from '../../shared/sentence-align/clip-locate';
import { endEdge, FRAME_S, startEdge, type LevelEnvelope } from '../../shared/sentence-align/cue-edges';

export const CLIP_ALIGN_STAGES = ['stitch', 'transcribe', 'locate', 'align', 'edges', 'write'] as const;
export type ClipAlignStage = (typeof CLIP_ALIGN_STAGES)[number];

export interface ClipInput {
  /** The clip's id in every output (its file name without the extension, by default). */
  readonly id: string;
  readonly path: string;
}

export interface RunClipSentenceAlignOptions {
  readonly server: string;
  readonly clips: readonly ClipInput[];
  /** The EPUB's sentences in reading order. */
  readonly sentences: readonly BookSentence[];
  readonly language: string;
  readonly ffmpegPath: string;
  /** clips.json, clips.tsv, vtt/<id>.vtt, and the stitched audio + transcript kept for a re-run. */
  readonly outDir: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: { stage: ClipAlignStage; fraction: number; message: string }) => void;
  readonly onLog?: (line: string) => void;
}

/** One sentence the clip holds. Times are clip-local seconds. */
export interface ClipSentence {
  readonly index: number;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly flagged: readonly string[];
}

/** A sentence the clip holds only part of - cut by the clip's edge, or not heard clearly. */
export interface ClipPartial {
  readonly index: number;
  readonly text: string;
  readonly coverage: number;
  readonly status: string;
  readonly reason: string | null;
  /** The heard part's clip-local span, when any of it was heard. */
  readonly start: number | null;
  readonly end: number | null;
}

export type ClipStatus = 'complete' | 'partial' | 'unlocated' | 'silent';

export interface ClipResult {
  readonly id: string;
  readonly path: string;
  readonly duration: number;
  /**
   * complete: every heard word is inside a placed sentence (no partial sentence, no
   * unmatched audio). partial: the clip also holds part-sentences or audio the book
   * does not contain. unlocated: no run of its words is unique in the book.
   * silent: the ASR heard nothing in it.
   */
  readonly status: ClipStatus;
  /** The placed sentences' EPUB text, in book order, joined with a space. */
  readonly text: string;
  readonly location: ClipLocation | null;
  readonly sentences: readonly ClipSentence[];
  readonly partial: readonly ClipPartial[];
  /** Heard words the book stretch does not contain (a phrase read differently, an ad). */
  readonly extraAudio: readonly { readonly start: number; readonly end: number; readonly words: number; readonly text: string }[];
  readonly heardWords: number;
}

export interface ClipSentenceAlignOutcome {
  readonly jsonPath: string;
  readonly tsvPath: string;
  readonly vttDir: string;
  readonly clips: readonly ClipResult[];
  readonly stats: Record<string, number>;
}

const SR = 16000;

/** One clip, decoded to 16 kHz mono float. */
function decodeClip(ffmpeg: string, file: string, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = (): void => { p.kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const chunks: Buffer[] = []; let err = '';
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new Error('cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${file} (exit ${code}): ${err.trim().slice(-300)}`));
      const b = Buffer.concat(chunks);
      const f = new Float32Array(b.length >> 2);
      for (let i = 0; i < f.length; i++) f[i] = b.readFloatLE(i * 4);
      resolve(f);
    });
  });
}

/** The 20 ms dBFS envelope the edge search reads, from samples already in hand. */
function envelopeOf(x: Float32Array): LevelEnvelope {
  const per = Math.round(FRAME_S * SR); const n = Math.floor(x.length / per);
  const db = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    let acc = 0; for (let i = k * per; i < (k + 1) * per; i++) acc += x[i] * x[i];
    db[k] = 10 * Math.log10(acc / per + 1e-18);
  }
  return { db };
}

/** 16-bit mono WAV of the stitched clips (the ASR's one upload). */
function writeStitched(file: string, clips: readonly Float32Array[], gapS: number): void {
  const gap = Math.round(gapS * SR);
  const total = clips.reduce((n, c) => n + c.length, 0) + gap * Math.max(0, clips.length - 1);
  const buf = Buffer.alloc(44 + total * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + total * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(total * 2, 40);
  let o = 44;
  clips.forEach((c, k) => {
    for (let i = 0; i < c.length; i++) { buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(c[i] * 32767))), o); o += 2; }
    if (k < clips.length - 1) o += gap * 2;   // Buffer.alloc zero-fills: the gap is digital silence
  });
  const tmp = `${file}.${process.pid}.part`;
  fs.writeFileSync(tmp, buf); fs.renameSync(tmp, file);
}

export async function runClipSentenceAlign(o: RunClipSentenceAlignOptions): Promise<ClipSentenceAlignOutcome> {
  const log = o.onLog ?? (() => undefined);
  const progress = (stage: ClipAlignStage, fraction: number, message: string): void => o.onProgress?.({ stage, fraction, message });
  if (o.clips.length === 0) throw new Error('no clips to place');
  if (o.sentences.length === 0) throw new Error('no sentences to place: the ebook extraction produced none');
  if (!o.language || o.language === 'auto') {
    throw new Error('Qwen3 is always told the language and has no auto-detect; the run needs an ISO code (e.g. en)');
  }
  const ids = new Set<string>();
  for (const c of o.clips) {
    if (!fs.existsSync(c.path)) throw new Error(`clip not found: ${c.path}`);
    if (ids.has(c.id)) throw new Error(`two clips share the id "${c.id}"; ids name the outputs, so each must be unique`);
    ids.add(c.id);
  }
  fs.mkdirSync(o.outDir, { recursive: true });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bookforge-clip-align-'));
  try {
    // 1. STITCH
    progress('stitch', 0, `Decoding ${o.clips.length} clip(s)`);
    const pcm: Float32Array[] = [];
    for (let i = 0; i < o.clips.length; i++) {
      if (o.signal?.aborted) throw new Error('cancelled');
      pcm.push(await decodeClip(o.ffmpegPath, o.clips[i].path, o.signal));
      if (i % 50 === 0) progress('stitch', i / o.clips.length, `Decoded ${i}/${o.clips.length}`);
    }
    const plan = stitchPlan(pcm.map((x) => x.length / SR));
    // The stitched file and its transcript stay in outDir, so a re-run over the SAME clips
    // (same paths, sizes and mtimes) reuses the one GPU pass. A different clip list rebuilds both.
    const digest = crypto.createHash('sha256').update(JSON.stringify(o.clips.map((c) => {
      const st = fs.statSync(c.path); return [c.id, path.resolve(c.path), st.size, st.mtimeMs];
    }))).digest('hex').slice(0, 16);
    const stitched = path.join(o.outDir, `clips.stitched.${digest}.wav`);
    if (!fs.existsSync(stitched)) {
      for (const f of fs.readdirSync(o.outDir)) if (/^clips\.stitched\.[0-9a-f]+\.(wav|transcript\.json)$/.test(f)) fs.rmSync(path.join(o.outDir, f));
      writeStitched(stitched, pcm, STITCH_GAP_S);
    }
    const total = plan.length ? plan[plan.length - 1].offset + plan[plan.length - 1].duration : 0;
    log(`stitched ${o.clips.length} clip(s), ${(total / 60).toFixed(1)} min with ${STITCH_GAP_S} s gaps -> ${stitched}`);

    // 2. ASR, once
    progress('transcribe', 0, 'Transcribing with Qwen3-ASR on Crucible');
    const asr = await transcribe({
      server: o.server, audioPath: stitched, language: o.language,
      transcriptCachePath: stitched.replace(/\.wav$/, '.transcript.json'),
      ...(o.signal ? { signal: o.signal } : {}),
      onLog: log,
      onProgress: (p) => progress('transcribe', p.fraction, p.message),
    }, scratch);
    const { perClip, inGaps } = splitHeardByClip(asr.words, plan);
    if (inGaps > 0) log(`${inGaps} heard word(s) fell in the silence between clips and belong to none`);

    // 3. LOCATE + 4. DIFF, per clip
    progress('locate', 0, 'Finding each clip in the book');
    const book = buildBookIndex(o.sentences);
    interface Work {
      loc: ClipLocation | null; sub: BookSentence[]; from: number;
      placements: SentencePlacement[]; extra: ClipResult['extraAudio']; windows: AlignWindowPlan[];
    }
    const work: Work[] = [];
    const allWindows: { clip: number; w: AlignWindowPlan; global: number }[] = [];
    let tooLongSentences = 0;
    for (let k = 0; k < o.clips.length; k++) {
      const loc = perClip[k].length ? locateClip(book, perClip[k]) : null;
      if (!loc) { work.push({ loc, sub: [], from: 0, placements: [], extra: [], windows: [] }); continue; }
      const sub = o.sentences.slice(loc.sentenceFrom, loc.sentenceTo + 1);
      const diff = diffBookAgainstHeard(sub, perClip[k]);
      const { windows, tooLong } = planAlignWindows(diff, sub, plan[k].duration);
      tooLongSentences += tooLong.reduce((n, t) => n + t.sentences.length, 0);
      for (const w of windows) allWindows.push({ clip: k, w, global: allWindows.length });
      work.push({ loc, sub, from: loc.sentenceFrom, placements: diff.sentences.slice(), extra: diff.extraAudio, windows });
      if (k % 100 === 0) progress('locate', k / o.clips.length, `Located ${k}/${o.clips.length}`);
    }
    const located = work.filter((w) => w.loc).length;
    log(`located ${located} of ${o.clips.length} clip(s); ${allWindows.length} disputed window(s) for the aligner`);

    // 5. ALIGN, one job for every clip's windows
    let alignFailed = 0;
    if (allWindows.length > 0) {
      progress('align', 0, `Cutting ${allWindows.length} window(s) for the aligner`);
      const wdir = path.join(scratch, 'windows'); fs.mkdirSync(wdir);
      const inputs: Record<string, string> = {};
      for (const a of allWindows) {
        if (o.signal?.aborted) throw new Error('cancelled');
        const f = path.join(wdir, `${a.global}.flac`);
        await cutWindow(o.ffmpegPath, o.clips[a.clip].path, a.w.start, a.w.end, f, o.signal);
        inputs[`${a.global}.flac`] = f;
      }
      const client = await crucibleClientFor(o.server, CRUCIBLE_CLIENT_NAME);
      await assertCrucibleModelOffered(client, o.server, 'align', SENTENCE_ALIGN_MODEL);
      const adir = path.join(scratch, 'align'); fs.mkdirSync(adir);
      const outcome = await runCrucibleJob({
        server: o.server, type: 'align', model: SENTENCE_ALIGN_MODEL,
        params: { language: o.language, chunks: allWindows.map((a) => ({ index: a.global, text: a.w.text })) },
        inputs, artifactsTo: adir,
        ...(o.signal ? { signal: o.signal } : {}),
        onLog: log,
        onProgress: (p: CrucibleJobProgress) => progress('align', p.kind === 'warming' ? 0 : p.fraction, p.message),
      });
      if (outcome.artifacts.where !== 'disk') throw new Error('crucible align: artifacts were not written to disk');
      const written = outcome.artifacts.files.get('alignment.json');
      if (!written) throw new Error(`crucible "${o.server}" align job ${outcome.jobId} ended done without alignment.json`);
      const byGlobal = new Map(allWindows.map((a) => [a.global, a]));
      for (const r of readAlignment(fs.readFileSync(written.path)).windows) {
        const a = byGlobal.get(r.index);
        if (!a) throw new Error(`crucible align returned window ${r.index}, which was never sent`);
        if (r.items === null) { alignFailed++; continue; }
        for (const p of placeWindow(a.w, work[a.clip].sub, r.items)) work[a.clip].placements[p.index] = p;
      }
      log(`align: ${allWindows.length} window(s), ${alignFailed} failed (job ${outcome.jobId})`);
    }

    // 6. EDGES + 7. per-clip results
    progress('edges', 0, 'Putting every cue edge in a pause');
    const results: ClipResult[] = [];
    let noPause = 0;
    for (let k = 0; k < o.clips.length; k++) {
      const c = o.clips[k]; const w = work[k]; const dur = plan[k].duration;
      if (!w.loc) {
        results.push({ id: c.id, path: c.path, duration: dur, status: perClip[k].length ? 'unlocated' : 'silent', text: '',
          location: null, sentences: [], partial: [], extraAudio: [], heardWords: perClip[k].length });
        continue;
      }
      const env = envelopeOf(pcm[k]);
      const placed = w.placements.filter((p) => p.status === 'placed' && p.start !== null && p.end !== null).sort((a, b) => a.start! - b.start!);
      const sentences: ClipSentence[] = []; let prevEdgeEnd = 0;
      for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        const prevEnd = i > 0 ? placed[i - 1].end! : null; const nextStart = i + 1 < placed.length ? placed[i + 1].start! : null;
        const s = startEdge(env, p.start!, prevEnd !== null && prevEnd <= p.start! ? prevEnd : null);
        const e = endEdge(env, p.end!, nextStart !== null && nextStart >= p.end! ? nextStart : null);
        const flagged: string[] = [];
        if (!s.inSilence) { flagged.push('start-not-in-a-pause'); noPause++; }
        if (!e.inSilence) { flagged.push('end-not-in-a-pause'); noPause++; }
        let a = Math.max(0, s.t, prevEdgeEnd); let b = Math.min(dur, e.t);
        if (b <= a) { flagged.push('collapsed-to-word-times'); a = Math.max(p.start!, prevEdgeEnd); b = Math.min(dur, Math.max(p.end!, a + 0.05)); }
        sentences.push({ index: w.from + p.index, text: w.sub[p.index].text.replace(/\s+/g, ' ').trim(), start: a, end: b, flagged });
        prevEdgeEnd = b;
      }
      // Partial: any sentence of the stretch the clip holds SOME of, but not all. The
      // stretch reaches past the clip on purpose, so a sentence with nothing heard is
      // simply outside the clip and is not listed.
      const partial: ClipPartial[] = w.placements.filter((p) => p.status !== 'placed' && p.coverage > 0).map((p) => {
        const heardW = p.words.filter((x) => x.start !== null);
        return { index: w.from + p.index, text: w.sub[p.index].text.replace(/\s+/g, ' ').trim(), coverage: +p.coverage.toFixed(3),
          status: p.status, reason: p.reason ?? null,
          start: heardW.length ? heardW.reduce((m, x) => Math.min(m, x.start!), Infinity) : null,
          end: heardW.length ? heardW.reduce((m, x) => Math.max(m, x.end!), -Infinity) : null };
      });
      const status: ClipStatus = partial.length === 0 && w.extra.length === 0 && sentences.length > 0 ? 'complete' : 'partial';
      results.push({ id: c.id, path: c.path, duration: dur, status, text: sentences.map((s) => s.text).join(' '),
        location: w.loc, sentences, partial, extraAudio: w.extra, heardWords: perClip[k].length });
    }

    // WRITE
    progress('write', 0, 'Writing the clips');
    const vttDir = path.join(o.outDir, 'vtt'); fs.mkdirSync(vttDir, { recursive: true });
    for (const r of results) {
      if (r.sentences.length === 0) continue;
      const lines = ['WEBVTT', ''];
      for (const s of r.sentences) { lines.push(String(s.index + 1)); lines.push(`${vttTimestamp(s.start)} --> ${vttTimestamp(s.end)}`); lines.push(s.text); lines.push(''); }
      fs.writeFileSync(path.join(vttDir, `${r.id}.vtt`), lines.join('\n'), 'utf-8');
    }
    const count = (s: ClipStatus): number => results.filter((r) => r.status === s).length;
    const stats = {
      clips: results.length, complete: count('complete'), partial: count('partial'), unlocated: count('unlocated'), silent: count('silent'),
      sentencesPlaced: results.reduce((n, r) => n + r.sentences.length, 0),
      partialSentences: results.reduce((n, r) => n + r.partial.length, 0),
      alignWindows: allWindows.length, alignWindowsFailed: alignFailed, tooLongForAligner: tooLongSentences,
      edgesWithoutPause: noPause, heardWordsInGaps: inGaps,
    };
    const jsonPath = path.join(o.outDir, 'clips.json');
    fs.writeFileSync(jsonPath, JSON.stringify({
      generator: 'bookforge clip-sentence-align', asrModel: SENTENCE_ASR_MODEL, alignModel: SENTENCE_ALIGN_MODEL,
      server: o.server, language: o.language, stitched, stats, clips: results,
    }, null, 1));
    const tsvPath = path.join(o.outDir, 'clips.tsv');
    fs.writeFileSync(tsvPath, ['id\tstatus\ttext', ...results.map((r) => `${r.id}\t${r.status}\t${r.text}`)].join('\n') + '\n', 'utf-8');
    log(`clips: ${stats.complete} complete, ${stats.partial} partial, ${stats.unlocated} unlocated, ${stats.silent} silent; `
      + `${stats.sentencesPlaced} sentence(s) placed; ${jsonPath}`);
    progress('write', 1, 'Done');
    return { jsonPath, tsvPath, vttDir, clips: results, stats };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
