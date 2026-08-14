/**
 * Close chapters WHILE the TTS engine is still rendering.
 *
 * WHY: assembly's two most expensive steps — normalizing every sentence's gap and
 * encoding the audio to AAC — depend only on the sentences of ONE chapter, not on
 * the whole book. A chapter is finished the moment its last sentence lands on disk,
 * which for a 20-hour book is typically an hour before the render ends. Meanwhile
 * TTS is GPU-bound with a single worker and nineteen of twenty cores sit idle.
 *
 * Measured on the Nuremberg render (78 chapters, 20.07 h, 2740 sentences): the
 * chapter concat and AAC encode were 57 s + 312 s of the 517 s that assembly still
 * costs after the parallel-encode work. Closing chapters during generation moves
 * both off the critical path.
 *
 * WHAT IT PRODUCES, under `<e2a tmp>/closed-<sessionId>/`:
 *   gap/      the gap-normalized sentences, accumulated chapter by chapter. By the
 *             end this is the COMPLETE set, byte-identical to what the whole-set
 *             pass would have written, and assembly consumes it as --sentences_dir
 *             (the VTT needs every sentence, so this must be whole, not partial).
 *   encoded/  <chapterNum>.m4a, ready for e2a's --encoded_chapters_dir.
 *   stamps/   <chapterNum>.json, the staleness stamp for that chapter.
 *   manifest.json
 *
 * STALENESS IS THE WHOLE RISK. Resume, Continue and single-sentence regeneration
 * all rewrite sentences after a chapter may already have been closed, and shipping
 * a stale chapter would be silent — the audiobook would simply contain the old
 * take. The stamp is the FLAC MD5 of each sentence's DECODED audio, which the
 * format already stores in STREAMINFO: it is content-derived, free to read (42
 * bytes), and — unlike size+mtime — survives normalizeWslSessionToWindows()
 * copying the whole session from ext4 onto a Windows path between close time and
 * assembly time. A copy preserves it; a re-render changes it.
 */
import { spawn } from 'child_process';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';

import { getFfmpegPath } from './tool-paths';
import { normalizeSentenceGaps } from './denoise-bridge';

/** One chapter's sentence range, as e2a's prepare phase reported it. */
export interface CloserChapter {
  chapterNum: number;
  sentenceStart: number;
  sentenceEnd: number;
}

export interface ChapterCloserOptions {
  jobId: string;
  /** Stable across the TTS job and the reassembly job that follows it. */
  sessionId: string;
  /** Raw rendered sentences. May be a \\wsl$ UNC path while Orpheus is running. */
  sentencesDir: string;
  chapters: CloserChapter[];
  /** Root under which `closed-<sessionId>` is created (e2a's tmp path). */
  tmpRoot: string;
  gapSeconds: number;
  minGapSeconds: number;
  outputChannels: 1 | 2;
  onLog?: (message: string) => void;
}

export interface CloserManifest {
  version: 1;
  sessionId: string;
  /** Every chapter closed, and therefore `gap/` holds every sentence. */
  complete: boolean;
  gapSeconds: number;
  minGapSeconds: number;
  outputChannels: 1 | 2;
  closedChapters: number[];
  totalChapters: number;
}

/** Per-sentence content identity: FLAC's own MD5 of the decoded audio. */
type SentenceStamp = Record<string, string>;

interface ChapterStamp {
  chapterNum: number;
  sentenceStart: number;
  sentenceEnd: number;
  sentences: SentenceStamp;
}

const POLL_MS = 8000;

interface CloserState {
  opts: ChapterCloserOptions;
  root: string;
  gapDir: string;
  encodedDir: string;
  stampsDir: string;
  closed: Set<number>;
  /** Last poll's observed stamps, so a chapter must look identical twice running. */
  lastSeen: Map<number, string>;
  stopping: boolean;
  timer: NodeJS.Timeout | null;
  /** In-flight close work, so stop() can wait for it rather than racing it. */
  inFlight: Promise<void>;
  failed: string | null;
}

const states = new Map<string, CloserState>();

/**
 * Read the 16-byte MD5 of the decoded audio out of the FLAC STREAMINFO block.
 *
 * Layout: 'fLaC' magic, a 4-byte metadata block header whose type must be 0
 * (STREAMINFO is mandatory and must come first), then 34 bytes of which the last
 * 16 are the MD5 of the unencoded audio.
 *
 * Throws rather than returning a placeholder: a sentence we cannot identify is a
 * sentence we cannot vouch for, and the entire point of this stamp is to refuse to
 * ship audio we are not certain about.
 */
async function flacAudioMd5(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(42);
    const { bytesRead } = await handle.read(buf, 0, 42, 0);
    if (bytesRead < 42) throw new Error(`truncated FLAC header (${bytesRead} bytes): ${filePath}`);
    if (buf.subarray(0, 4).toString('latin1') !== 'fLaC') {
      throw new Error(`not a FLAC file (bad magic): ${filePath}`);
    }
    if ((buf[4] & 0x7f) !== 0) {
      throw new Error(`first FLAC metadata block is not STREAMINFO: ${filePath}`);
    }
    return buf.subarray(26, 42).toString('hex');
  } finally {
    await handle.close();
  }
}

/**
 * max_blocksize and samplerate from STREAMINFO.
 *
 * ffmpeg's concat demuxer silently drops every FLAC frame whose blocksize exceeds
 * the FIRST list entry's declared max-blocksize, and still exits 0 — a mixed-encoder
 * sentence set therefore produces a SHORT chapter with no error anywhere. e2a's
 * combine_audio_sentences refuses a non-homogeneous set for exactly this reason
 * (it is the fix for a real dropped-audio incident); this path concatenates the
 * same files, so it has to make the same check rather than inherit the bug.
 */
async function flacConcatShape(filePath: string): Promise<{ maxBlocksize: number; sampleRate: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(42);
    const { bytesRead } = await handle.read(buf, 0, 42, 0);
    if (bytesRead < 42) throw new Error(`truncated FLAC header (${bytesRead} bytes): ${filePath}`);
    const info = buf.subarray(8);
    return {
      maxBlocksize: info.readUInt16BE(2),
      sampleRate: (info[10] << 12) | (info[11] << 4) | (info[12] >> 4),
    };
  } finally {
    await handle.close();
  }
}

function sentenceNames(ch: CloserChapter): string[] {
  const out: string[] = [];
  for (let i = ch.sentenceStart; i <= ch.sentenceEnd; i++) out.push(`${i}.flac`);
  return out;
}

function runProcess(cmd: string, args: string[], what: string, cwd?: string, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const capture = (b: Buffer) => { tail = (tail + b.toString()).slice(-4000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.on('error', (e) => reject(new Error(`${what} failed to spawn: ${e.message}`)));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${what} exited ${code}: ${tail.trim().slice(-1200)}`));
    });
  });
}

/**
 * Close one chapter: stamp it, gap-normalize its sentences, encode it to AAC.
 *
 * The stamp is taken from the RAW sources BEFORE any work, so a sentence that gets
 * rewritten mid-close is caught at validation time rather than baked in silently.
 */
async function closeChapter(st: CloserState, ch: CloserChapter, observed: SentenceStamp): Promise<void> {
  const { opts } = st;
  const names = sentenceNames(ch);
  const work = path.join(st.root, 'work', `ch-${ch.chapterNum}`);
  const inDir = path.join(work, 'in');
  const outDir = path.join(work, 'out');
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(inDir, { recursive: true });

  // normalize_gaps.py processes an entire directory, so this chapter's sentences
  // need one of their own. For Orpheus this copy is also what pulls the bytes off
  // the \\wsl$ 9p mount — bounded to one chapter, not a standing read of the book.
  const shapes: Array<{ maxBlocksize: number; sampleRate: number }> = [];
  for (const name of names) {
    const src = path.join(opts.sentencesDir, name);
    await fs.copyFile(src, path.join(inDir, name));
    shapes.push(await flacConcatShape(src));
  }
  const blocksizes = new Set(shapes.map((s) => s.maxBlocksize));
  const rates = new Set(shapes.map((s) => s.sampleRate));
  if (blocksizes.size > 1) {
    throw new Error(
      `chapter ${ch.chapterNum}: FLAC max-blocksize is not homogeneous (${[...blocksizes].join(', ')}) — ` +
      `ffmpeg's concat demuxer would silently drop frames from the odd ones out`,
    );
  }
  if (rates.size > 1) {
    throw new Error(
      `chapter ${ch.chapterNum}: FLAC samplerate is not homogeneous (${[...rates].join(', ')}) — ` +
      `concatenating these would corrupt the chapter's timing`,
    );
  }

  // Same normalizer the whole-set pass uses, on one chapter's worth of input — so
  // the bytes it writes here are the bytes assembly would have got either way.
  await normalizeSentenceGaps({
    sentencesDir: inDir,
    outputDir: outDir,
    gapSeconds: opts.gapSeconds,
    minGapSeconds: opts.minGapSeconds,
  });

  // Encode straight from the normalized sentences — there is no reason to
  // materialize an intermediate chapter FLAC just to hand it to the encoder.
  const listPath = path.join(work, 'concat.txt');
  await fs.writeFile(
    listPath,
    names.map((n) => `file '${path.join(outDir, n).replace(/\\/g, '/')}'`).join('\n') + '\n',
    'utf8',
  );
  const tmpM4a = path.join(work, 'chapter.m4a');
  await runProcess(getFfmpegPath(), [
    '-hide_banner', '-nostats', '-v', 'error',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', String(opts.outputChannels),
    '-y', tmpM4a,
  ], `ffmpeg encode (chapter ${ch.chapterNum})`);

  const stat = await fs.stat(tmpM4a);
  if (stat.size === 0) throw new Error(`chapter ${ch.chapterNum}: encoder produced a zero-length file`);

  // Publish: the normalized sentences join the shared set, then the encoded chapter
  // and its stamp appear together. The stamp is written LAST and renamed into place,
  // so a stamp existing always means its .m4a is complete — a crash mid-close leaves
  // an unstamped .m4a, which validation ignores.
  for (const name of names) {
    await fs.copyFile(path.join(outDir, name), path.join(st.gapDir, name));
  }
  const finalM4a = path.join(st.encodedDir, `${ch.chapterNum}.m4a`);
  await fs.rename(tmpM4a, finalM4a);

  const stamp: ChapterStamp = {
    chapterNum: ch.chapterNum,
    sentenceStart: ch.sentenceStart,
    sentenceEnd: ch.sentenceEnd,
    sentences: observed,
  };
  const tmpStamp = path.join(work, 'stamp.json');
  await fs.writeFile(tmpStamp, JSON.stringify(stamp), 'utf8');
  await fs.rename(tmpStamp, path.join(st.stampsDir, `${ch.chapterNum}.json`));

  await fs.rm(work, { recursive: true, force: true });
  st.closed.add(ch.chapterNum);
  opts.onLog?.(`chapter ${ch.chapterNum} closed (${names.length} sentences) — ${st.closed.size}/${opts.chapters.length}`);
}

/** Stamp every sentence of a chapter, or null when any is not yet on disk. */
async function observeChapter(st: CloserState, ch: CloserChapter, present: Set<string>): Promise<SentenceStamp | null> {
  const names = sentenceNames(ch);
  if (!names.every((n) => present.has(n))) return null;
  const out: SentenceStamp = {};
  for (const name of names) {
    out[name] = await flacAudioMd5(path.join(st.opts.sentencesDir, name));
  }
  return out;
}

async function pollOnce(st: CloserState): Promise<void> {
  if (st.stopping || st.failed) return;
  let entries: string[];
  try {
    entries = await fs.readdir(st.opts.sentencesDir);
  } catch {
    // The directory can legitimately not exist yet at the very start of a render.
    return;
  }
  const present = new Set(entries);
  for (const ch of st.opts.chapters) {
    if (st.stopping || st.failed) return;
    if (st.closed.has(ch.chapterNum)) continue;
    let observed: SentenceStamp | null;
    try {
      observed = await observeChapter(st, ch, present);
    } catch {
      // A sentence still being written reads as a bad header; try again next poll.
      continue;
    }
    if (!observed) continue;
    const fingerprint = Object.values(observed).join('');
    // Require two identical observations before closing: a worker can be midway
    // through rewriting a sentence it already wrote once (Continue, regeneration),
    // and a single glimpse of a complete-looking chapter is not proof it is settled.
    if (st.lastSeen.get(ch.chapterNum) !== fingerprint) {
      st.lastSeen.set(ch.chapterNum, fingerprint);
      continue;
    }
    try {
      await closeChapter(st, ch, observed);
    } catch (err) {
      // One chapter failing is not worth failing the render over — assembly simply
      // builds that chapter itself. Record it and stop closing, so the failure is
      // visible rather than silently degrading into "some chapters were slow".
      st.failed = `chapter ${ch.chapterNum}: ${(err as Error).message || String(err)}`;
      st.opts.onLog?.(`chapter closer stopped: ${st.failed}`);
      return;
    }
  }
}

function schedule(st: CloserState): void {
  if (st.stopping) return;
  st.timer = setTimeout(() => {
    st.inFlight = st.inFlight
      .then(() => pollOnce(st))
      .catch((e) => { st.failed = (e as Error).message || String(e); })
      .then(() => { schedule(st); });
  }, POLL_MS);
}

/**
 * Begin closing chapters in the background. Idempotent per jobId.
 *
 * The caller decides eligibility (no denoise/RVC pass scheduled, MP4-family output);
 * this function assumes it has already been decided.
 */
export async function startChapterCloser(opts: ChapterCloserOptions): Promise<void> {
  if (states.has(opts.jobId)) return;
  const root = path.join(opts.tmpRoot, `closed-${opts.sessionId}`);
  // A previous attempt on this session is not reusable: its gap parameters or its
  // sentence set may differ, and sorting out which chapters still hold is more
  // fragile than simply closing them again.
  await fs.rm(root, { recursive: true, force: true });
  const st: CloserState = {
    opts,
    root,
    gapDir: path.join(root, 'gap'),
    encodedDir: path.join(root, 'encoded'),
    stampsDir: path.join(root, 'stamps'),
    closed: new Set(),
    lastSeen: new Map(),
    stopping: false,
    timer: null,
    inFlight: Promise.resolve(),
    failed: null,
  };
  await fs.mkdir(st.gapDir, { recursive: true });
  await fs.mkdir(st.encodedDir, { recursive: true });
  await fs.mkdir(st.stampsDir, { recursive: true });
  states.set(opts.jobId, st);
  opts.onLog?.(`chapter closer started: ${opts.chapters.length} chapters, output ${root}`);
  schedule(st);
}

/**
 * Stop closing and finish what can still be finished.
 *
 * Called once generation ends. Any chapter not yet closed is closed now — by this
 * point every sentence exists, so this is the last chance to keep work off the
 * critical path. `complete` in the manifest is the assembly-side gate: `gap/` is
 * only a valid --sentences_dir if it holds EVERY sentence, because the VTT needs
 * all of them.
 */
export async function stopChapterCloser(jobId: string): Promise<CloserManifest | null> {
  const st = states.get(jobId);
  if (!st) return null;
  st.stopping = true;
  if (st.timer) clearTimeout(st.timer);
  try {
    await st.inFlight;
  } catch {
    // Recorded on st.failed by the scheduler; nothing to add here.
  }
  st.stopping = false;
  if (!st.failed) {
    // Final sweep: everything is on disk now, so a chapter that never settled during
    // the render settles here. One pass, then a second for chapters whose first
    // observation happened only just now.
    try {
      await pollOnce(st);
      await pollOnce(st);
    } catch (err) {
      st.failed = (err as Error).message || String(err);
    }
  }
  st.stopping = true;
  states.delete(jobId);

  const closedChapters = [...st.closed].sort((a, b) => a - b);
  const complete = !st.failed && closedChapters.length === st.opts.chapters.length;
  const manifest: CloserManifest = {
    version: 1,
    sessionId: st.opts.sessionId,
    complete,
    gapSeconds: st.opts.gapSeconds,
    minGapSeconds: st.opts.minGapSeconds,
    outputChannels: st.opts.outputChannels,
    closedChapters,
    totalChapters: st.opts.chapters.length,
  };
  try {
    await fs.writeFile(path.join(st.root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    await fs.rm(path.join(st.root, 'work'), { recursive: true, force: true });
  } catch {
    return null;
  }
  st.opts.onLog?.(
    complete
      ? `chapter closer finished: all ${closedChapters.length} chapters pre-encoded`
      : `chapter closer finished INCOMPLETE: ${closedChapters.length}/${st.opts.chapters.length} chapters` +
        (st.failed ? ` (stopped by: ${st.failed})` : ''),
  );
  return manifest;
}

export interface ClosedSessionUse {
  /** The complete gap-normalized sentence set, for --sentences_dir. */
  gapDir: string;
  /** Directory of <chapterNum>.m4a, for --encoded_chapters_dir. */
  encodedDir: string;
  chapters: number[];
}

/**
 * Validate what the closer produced and decide whether assembly may use it.
 *
 * Returns null — and says why through `onReject` — whenever anything does not line
 * up. Every rejection here costs only the time the closer saved; accepting a stale
 * chapter would cost a silently wrong audiobook, so this errs hard toward null.
 */
export async function resolveClosedSession(params: {
  tmpRoot: string;
  sessionId: string;
  /** The raw sentences assembly is about to work from (post-WSL-normalization). */
  sentencesDir: string;
  gapSeconds: number;
  minGapSeconds: number;
  onReject?: (reason: string) => void;
}): Promise<ClosedSessionUse | null> {
  const root = path.join(params.tmpRoot, `closed-${params.sessionId}`);
  const reject = (reason: string): null => { params.onReject?.(reason); return null; };

  let manifest: CloserManifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8')) as CloserManifest;
  } catch {
    return reject('no chapter-closer manifest for this session');
  }
  if (manifest.version !== 1) return reject(`unrecognised closer manifest version ${manifest.version}`);
  if (!manifest.complete) {
    return reject(`closer did not finish (${manifest.closedChapters.length}/${manifest.totalChapters} chapters)`);
  }
  // The gap parameters are part of the AUDIO, not just bookkeeping: a different
  // floor means different trailing silence on every lifted clip.
  if (manifest.gapSeconds !== params.gapSeconds || manifest.minGapSeconds !== params.minGapSeconds) {
    return reject(
      `gap parameters changed since the render ` +
      `(closed with gap=${manifest.gapSeconds}/floor=${manifest.minGapSeconds}, ` +
      `assembling with gap=${params.gapSeconds}/floor=${params.minGapSeconds})`,
    );
  }

  const gapDir = path.join(root, 'gap');
  const encodedDir = path.join(root, 'encoded');
  const stampsDir = path.join(root, 'stamps');

  for (const chapterNum of manifest.closedChapters) {
    let stamp: ChapterStamp;
    try {
      stamp = JSON.parse(await fs.readFile(path.join(stampsDir, `${chapterNum}.json`), 'utf8')) as ChapterStamp;
    } catch {
      return reject(`chapter ${chapterNum} has no stamp`);
    }
    const m4a = path.join(encodedDir, `${chapterNum}.m4a`);
    try {
      if ((await fs.stat(m4a)).size === 0) return reject(`chapter ${chapterNum}: encoded file is empty`);
    } catch {
      return reject(`chapter ${chapterNum}: encoded file is missing`);
    }
    for (const [name, expectedMd5] of Object.entries(stamp.sentences)) {
      let actual: string;
      try {
        actual = await flacAudioMd5(path.join(params.sentencesDir, name));
      } catch (err) {
        return reject(`chapter ${chapterNum}: cannot read ${name} to verify it (${(err as Error).message})`);
      }
      if (actual !== expectedMd5) {
        return reject(`chapter ${chapterNum}: ${name} was re-rendered after the chapter was closed`);
      }
      if (!fsSync.existsSync(path.join(gapDir, name))) {
        return reject(`chapter ${chapterNum}: ${name} missing from the normalized set`);
      }
    }
  }

  return { gapDir, encodedDir, chapters: manifest.closedChapters };
}

/** Drop a session's closer output once assembly has consumed (or rejected) it. */
export async function discardClosedSession(tmpRoot: string, sessionId: string): Promise<void> {
  await fs.rm(path.join(tmpRoot, `closed-${sessionId}`), { recursive: true, force: true });
}
