/**
 * A session directory to a Manifest. A port of narrator's `session_v1.py`, which step 8 deleted.
 *
 * THE ONE RULE ABOUT PATHS. `session-state.json` was written by whichever machine rendered
 * the book, and every path inside it is that machine's. None are trusted: everything is
 * derived from the directory this was handed.
 *
 * A missing FLAC, a bad header, a chapter with no chunks, ranges that disagree with the
 * text: refused, naming the path. Nothing here defaults a gap or a sample rate.
 */

import * as fs from 'fs';
import * as path from 'path';

import { profileFor } from '../assemble/engine-profiles';
import { SML_HEADING_PATTERN, SML_ITEM_PATTERN } from '../text/sml';
import { pyInt, pyRepr, pyTruthy } from '../py-compat';
import { checkExpected, FlacHeaderError, readStreaminfo, type StreamInfo } from './flac-header';
import { validate, type Chapter, type Chunk, type Engine, type Manifest } from './manifest';

const AUDIO_PROC_FORMAT = 'flac';
/** Written by prep, for engines that do not pad. A `.json` cannot shift a chunk index. */
export const GAPS_FILENAME = 'gaps.json';
/** What the engines render at. A derived set has its own rate, which is reported, not refused. */
const ENGINE_SAMPLE_RATE = 24000;
/** A requirement: the assembler's silence is mono, and concat drops mismatched frames silently. */
const CHANNELS = 1;
/** One read per chunk across a share; bounded so a 2,700-chunk book does not open them all at once. */
const HEADER_READS_AT_ONCE = 16;

/** Matched anywhere in a row: `[break][heading]Chapter 8.` is a heading. */

export class SessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionError';
  }
}

type State = Record<string, unknown>;
export type SessionLog = (line: string) => void;

const isFile = (file: string): boolean => {
  try { return fs.statSync(file).isFile(); } catch { return false; }
};
const isDir = (dir: string): boolean => {
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
};
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asDoc = (value: unknown): State => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as State : {});

/** Heading wins over item: a list item inside a heading row is still a heading. */
export function chunkKind(text: string): string {
  if (SML_HEADING_PATTERN.test(text)) return 'heading';
  if (SML_ITEM_PATTERN.test(text)) return 'item';
  return 'prose';
}

/** Note the hyphen: `session_state.json` beside it is BookForge's own sidecar, not this. */
export function loadSessionState(processDir: string): State {
  const file = path.join(processDir, 'session-state.json');
  if (!isFile(file)) throw new SessionError(`session-state.json not found: ${file}`);
  let state: State;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
  } catch (err) {
    throw new SessionError(`session-state.json is not valid JSON: ${file}: ${(err as Error).message}`);
  }
  const version = state['version'] ?? null;
  if (version !== 2) {
    throw new SessionError(`session-state.json is version ${pyRepr(version)}; this reader implements layout v1 / state version 2 only: ${file}`);
  }
  return state;
}

/** `--chapters`: 1-based numbers, or null for `auto`. An unparseable part refuses. */
export function parseChaptersArg(chapters: string | null | undefined, total: number): number[] | null {
  if (!chapters) return Array.from({ length: total }, (_, i) => i + 1);
  const text = chapters.trim().toLowerCase();
  if (text === 'auto') return null;
  const result = new Set<number>();
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (part === '') continue;
    const dash = part.indexOf('-');
    const lo = pyInt(dash >= 0 ? part.slice(0, dash) : part);
    const hi = dash >= 0 ? pyInt(part.slice(dash + 1)) : lo;
    if (lo === null || hi === null) throw new SessionError(`--chapters: ${pyRepr(part)} is not a chapter number or range`);
    for (let ch = lo; ch <= hi; ch += 1) {
      if (ch < 1 || ch > total) throw new SessionError(`--chapters: chapter ${ch} is outside this book's 1..${total}`);
      result.add(ch);
    }
  }
  if (result.size === 0) throw new SessionError(`--chapters: ${pyRepr(chapters)} selected no chapters`);
  return [...result].sort((a, b) => a - b);
}

/** Stops at the FIRST incomplete chapter: a later one over a gap is a book with a hole in it. */
export function detectCompletedChapters(sentencesDir: string, chapterSentences: readonly unknown[][]): number[] {
  const completed: number[] = [];
  let offset = 0;
  for (let i = 0; i < chapterSentences.length; i += 1) {
    const count = chapterSentences[i].length;
    for (let j = 0; j < count; j += 1) {
      if (!isFile(path.join(sentencesDir, `${offset + j}.${AUDIO_PROC_FORMAT}`))) return completed;
    }
    completed.push(i + 1);
    offset += count;
  }
  return completed;
}

/**
 * The rate of the set being assembled, read off its first chunk. A derived set has its own
 * (RVC v2 runs at 48 kHz), a FLAC declares its rate, and a uniform set plays at the right
 * speed. Every chunk is held to this, so a set that disagrees with itself is still refused.
 */
async function detectSampleRate(resolved: string, log: SessionLog): Promise<number> {
  const first = path.join(resolved, `0.${AUDIO_PROC_FORMAT}`);
  if (!isFile(first)) {
    throw new SessionError(`the set has no chunk 0 (${first}), so there is nothing to read a sample rate off; a manifest's chunk indices are global and start at 0`);
  }
  let rate: number;
  try {
    rate = (await readStreaminfo(first)).sampleRate;
  } catch (err) {
    throw new SessionError(`could not read the sample rate off ${first}: ${(err as Error).message}`);
  }
  if (rate !== ENGINE_SAMPLE_RATE) {
    log(`[ASSEMBLE] This set is ${rate} Hz, not the ${ENGINE_SAMPLE_RATE} Hz the engines render at - a derived set (a voice conversion runs at its model's rate). `
      + `Assembling at ${rate} Hz; every chunk is held to it, and the AAC encode resamples to 44.1 kHz as always.`);
  }
  return rate;
}

/** Beside the audio first, then the canonical copy: the gaps come from the TEXT, so they are the same document. */
function findGapsFile(resolved: string, processDir: string): string | null {
  const beside = path.join(resolved, GAPS_FILENAME);
  if (isFile(beside)) return beside;
  const canonical = path.join(processDir, 'chapters', 'sentences', GAPS_FILENAME);
  return isFile(canonical) ? canonical : null;
}

/** Complete coverage or refused: a file that stops early would silently unpause the rest of a book. */
function loadGaps(file: string, engineId: string, totalChunks: number): Map<number, readonly [number, number]> {
  let doc: State;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8')) as State;
  } catch (err) {
    throw new SessionError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const version = doc['version'] ?? null;
  if (version !== 1) throw new SessionError(`${file} is version ${pyRepr(version)}; this reader implements gaps.json v1 only`);
  const declared = doc['engine'] ?? null;
  if (declared !== engineId) {
    throw new SessionError(`${file} was written for engine ${pyRepr(declared)} but this session was rendered by ${pyRepr(engineId)}. The pause structure of one engine is not the other's.`);
  }
  const raw = doc['gaps'];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new SessionError(`${file} has no 'gaps' object`);

  const out = new Map<number, readonly [number, number]>();
  for (const [key, entry] of Object.entries(raw as State)) {
    const index = pyInt(key);
    if (index === null) throw new SessionError(`${file}: ${pyRepr(key)} is not a chunk index`);
    if (index < 0 || index >= totalChunks) throw new SessionError(`${file}: chunk index ${index} is outside this book's 0..${totalChunks - 1}`);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new SessionError(`${file}: entry for chunk ${index} is not an object`);
    const pair: number[] = [];
    for (const name of ['before', 'after']) {
      const value = name in (entry as State) ? (entry as State)[name] : 0;
      if (typeof value !== 'number') throw new SessionError(`${file}: chunk ${index} ${pyRepr(name)} must be a number, got ${pyRepr(value)}`);
      if (value < 0) throw new SessionError(`${file}: chunk ${index} ${pyRepr(name)} is negative: ${pyRepr(value)}`);
      pair.push(value);
    }
    out.set(index, [pair[0], pair[1]]);
  }
  const missing: number[] = [];
  for (let i = 0; i < totalChunks; i += 1) if (!out.has(i)) missing.push(i);
  if (missing.length > 0) {
    const shown = missing.slice(0, 10).join(', ');
    const more = missing.length > 10 ? ` (and ${missing.length - 10} more)` : '';
    throw new SessionError(`${file} covers ${out.size} of ${totalChunks} chunks; no entry for ${shown}${more}. Every chunk needs one - a partial file would silently leave the rest of the book unpaused.`);
  }
  return out;
}

function engineBlock(engineId: string): Engine {
  const profile = profileFor(engineId);
  return { id: profile.id, pads: profile.pads, edgeFadeMs: { in: profile.fadeInMs, out: profile.fadeOutMs } };
}

function requiredStr(state: State, key: string, processDir: string): string {
  const value = state[key] ?? null;
  if (typeof value !== 'string' || value === '') {
    throw new SessionError(`session-state.json ${pyRepr(key)} is required and must be a non-empty string, got ${pyRepr(value)} (${processDir})`);
  }
  return value;
}

function readProvenance(processDir: string): State | null {
  const file = path.join(processDir, 'chapter-provenance.json');
  return isFile(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as State : null;
}

/**
 * Chapter titles, bound by DOCUMENT IDENTITY and never by position: the TOC and the chapter
 * list describe different sets, and their counts can match while the sets differ. An
 * unmatched chapter takes its own first chunk, which is right by construction. Kept raw.
 */
function resolveChapterTitles(processDir: string, state: State, chapterSentences: readonly string[][], log: SessionLog): string[] {
  const ownTitles = chapterSentences.map((chapter, i) => (chapter.length > 0 ? chapter[0] : `Chapter ${i + 1}`));
  let docs = asList(state['chapter_docs']) as string[];
  let byDoc = asDoc(state['chapter_titles_by_doc']);
  if (docs.length !== chapterSentences.length) {
    const provenance = readProvenance(processDir);
    if (provenance !== null) {
      docs = asList(provenance['chapter_docs']) as string[];
      byDoc = asDoc(provenance['chapter_titles_by_doc']);
    }
  }
  if (docs.length !== chapterSentences.length) {
    log(`[ASSEMBLE] Chapter provenance unusable: ${docs.length} chapter_docs entries for ${chapterSentences.length} chapters. Using each chapter's OWN first chunk as its marker title. `
      + 'TOC titles are deliberately NOT paired by position - that pairing is what mislabelled chapters.');
    return ownTitles;
  }
  let fromToc = 0;
  const titles = docs.map((doc, i) => {
    const toc = byDoc[doc];
    if (pyTruthy(toc)) {
      fromToc += 1;
      return toc as string;
    }
    return ownTitles[i];
  });
  log(`[ASSEMBLE] ${fromToc}/${chapterSentences.length} chapter titles resolved from the TOC by document identity; ${chapterSentences.length - fromToc} from the chapter's own first chunk`);
  return titles;
}

function resolveChapterDocs(processDir: string, state: State, count: number): Array<string | null> {
  let docs = asList(state['chapter_docs']) as string[];
  if (docs.length !== count) {
    const provenance = readProvenance(processDir);
    if (provenance !== null) docs = asList(provenance['chapter_docs']) as string[];
  }
  return docs.length === count ? [...docs] : Array.from({ length: count }, () => null);
}

/**
 * The cover as a path or null. A string means the epub had art and it must be there; `true`
 * or null means BookForge may have staged `cover.jpg`, and if not the book ships bare, which
 * is the answer and not an error.
 */
function resolveCover(processDir: string, state: State, log: SessionLog): string | null {
  const raw = state['cover'] ?? null;
  const noext = state['filename_noext'];
  if (typeof raw === 'string' && pyTruthy(noext)) {
    const candidate = path.join(processDir, `${String(noext)}.jpg`);
    if (isFile(candidate)) return candidate;
    throw new SessionError(`session-state.json says the epub carried a cover, but the staged image is not there: ${candidate}`);
  }
  if (raw === null || typeof raw === 'boolean') {
    const staged = path.join(processDir, 'cover.jpg');
    if (isFile(staged)) {
      log(`[ASSEMBLE] Using staged cover ${staged}`);
      return staged;
    }
    log(`[ASSEMBLE] No cover: the epub carried none and none is staged at ${staged}. This audiobook ships without artwork.`);
    return null;
  }
  throw new SessionError(`session-state.json 'cover' must be a path string, a bool sentinel, or null - got ${typeof raw === 'number' ? 'int' : 'str'}: ${pyRepr(raw)}`);
}

/** Relative to the session where it can be. A set on another drive keeps its absolute path. */
function relativeFile(processDir: string, file: string): string {
  if (path.parse(processDir).root.toLowerCase() !== path.parse(file).root.toLowerCase()) return path.resolve(file);
  return path.relative(processDir, file).split(path.sep).join('/');
}

async function readHeaders(files: readonly string[]): Promise<Array<StreamInfo | Error>> {
  const out: Array<StreamInfo | Error> = new Array(files.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const at = next;
      next += 1;
      try {
        out[at] = await readStreaminfo(files[at]);
      } catch (err) {
        out[at] = err as Error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HEADER_READS_AT_ONCE, files.length) }, worker));
  return out;
}

export interface BuildManifestOptions {
  /** The `--sentences_dir` of a derived set. Overrides only the audio source. */
  readonly sentencesDir?: string | null;
  /** Absent for the whole book, `auto`, or a contiguous selection from chapter 1. */
  readonly chapters?: string | null;
  readonly log?: SessionLog;
}

/** Build a schema-v1 Manifest from a session's `<hash>` directory. */
export async function buildManifest(processDirIn: string, options: BuildManifestOptions = {}): Promise<Manifest> {
  const log = options.log ?? ((line: string) => console.log(line));
  const processDir = path.resolve(processDirIn);
  if (!isDir(processDir)) throw new SessionError(`process_dir is not a directory: ${processDir}`);

  const state = loadSessionState(processDir);
  if (pyTruthy(state['bilingual'])) {
    throw new SessionError(`this is a bilingual session, which e2a assembles by interleaving source/target chunks with inserted pauses. narrator's assembler realizes no silence of its own and would produce the wrong timings (${processDir})`);
  }
  let chapterSentences = state['chapter_sentences'] as string[][] | undefined;
  if (!pyTruthy(chapterSentences)) {
    throw new SessionError(`session-state.json has no chapter_sentences: there is no book to assemble (${processDir})`);
  }
  let sentences = chapterSentences as string[][];

  let resolved: string;
  if (options.sentencesDir) {
    resolved = path.resolve(options.sentencesDir);
    if (!isDir(resolved)) throw new SessionError(`sentences directory not found: ${resolved}`);
    log(`[ASSEMBLE] Using overridden sentences_dir: ${resolved}`);
  } else {
    resolved = path.join(processDir, 'chapters', 'sentences');
    if (!isDir(resolved)) throw new SessionError(`sentences directory not found: ${resolved}`);
  }

  // Two independent records of one fact. A disagreement slides later chapters onto the wrong audio.
  if (!('chapters' in state)) {
    throw new SessionError(`session-state.json has no 'chapters' ranges to cross-check chapter_sentences against (${processDir})`);
  }
  const declared = state['chapters'] as Array<{ sentence_start: number; sentence_end: number }>;
  if (declared.length !== sentences.length) {
    throw new SessionError(`session-state.json disagrees with itself: 'chapters' has ${declared.length} entries but 'chapter_sentences' has ${sentences.length} (${processDir})`);
  }
  let offset = 0;
  declared.forEach((entry, i) => {
    const wantStart = offset;
    const wantEnd = offset + sentences[i].length - 1;
    if (entry.sentence_start !== wantStart || entry.sentence_end !== wantEnd) {
      throw new SessionError(`session-state.json chapter ${i + 1} declares sentences ${entry.sentence_start}-${entry.sentence_end} but its chapter_sentences run ${wantStart}-${wantEnd} (${processDir})`);
    }
    offset += sentences[i].length;
  });
  if (!('total_sentences' in state)) throw new SessionError(`session-state.json has no 'total_sentences' (${processDir})`);
  const flatCount = sentences.reduce((sum, chapter) => sum + chapter.length, 0);
  if (state['total_sentences'] !== flatCount) {
    throw new SessionError(`session-state.json declares total_sentences=${pyRepr(state['total_sentences'])} but its chapter_sentences hold ${flatCount} chunks (${processDir})`);
  }

  const engineId = requiredStr(state, 'tts_engine', processDir);
  const profile = profileFor(engineId);
  const gapsPath = findGapsFile(resolved, processDir);
  let gaps = new Map<number, readonly [number, number]>();
  if (profile.pads) {
    if (gapsPath !== null) {
      throw new SessionError(`${gapsPath} exists, but ${pyRepr(engineId)} BAKES its inter-chunk silence into each chunk's own audio. Honouring this file would add that silence a second time, on top of the silence already in the FLACs.`);
    }
  } else {
    if (gapsPath === null) {
      throw new SessionError(`${pyRepr(engineId)} does not pad its chunks, so the inter-chunk silence lives in ${GAPS_FILENAME} - and there is none at ${path.join(resolved, GAPS_FILENAME)} or ${path.join(processDir, 'chapters', 'sentences', GAPS_FILENAME)}. Assembling without it would ship the book with no pauses at all; prep writes it.`);
    }
    gaps = loadGaps(gapsPath, engineId, flatCount);
    log(`[ASSEMBLE] Inter-chunk gaps from ${gapsPath}`);
  }

  let titles = resolveChapterTitles(processDir, state, sentences, log);
  let docs = resolveChapterDocs(processDir, state, sentences.length);

  let selected = parseChaptersArg(options.chapters, sentences.length);
  if (selected === null) {
    log('[ASSEMBLE] Auto-detecting completed chapters...');
    selected = detectCompletedChapters(resolved, sentences);
    if (selected.length === 0) {
      throw new SessionError(`no completed chapters found in ${resolved}: the render has not finished a single chapter`);
    }
    log(`[ASSEMBLE] Found ${selected.length} completed chapters: ${selected[0]}-${selected[selected.length - 1]}`);
  }
  if (selected.some((chapter, i) => chapter !== i + 1)) {
    throw new SessionError(`chapter selection ${pyRepr(selected)} is not a contiguous run from chapter 1. A manifest's chunk indices are GLOBAL and must cover 0..N-1, and e2a's own VTT is wrong for a mid-book selection (it pairs files from index 0 with the selected chapters' texts). Refusing rather than reproducing that.`);
  }
  if (selected.length < sentences.length) {
    log(`[ASSEMBLE] Partial assembly: chapters ${selected[0]}-${selected[selected.length - 1]} of ${sentences.length}`);
    sentences = sentences.slice(0, selected.length);
    titles = titles.slice(0, selected.length);
    docs = docs.slice(0, selected.length);
  }

  // After the selection: "has not finished a single chapter" is the sentence an operator needs.
  const sampleRate = await detectSampleRate(resolved, log);

  const chunkFiles: string[] = [];
  let counted = 0;
  for (const texts of sentences) {
    for (let i = 0; i < texts.length; i += 1) {
      chunkFiles.push(path.join(resolved, `${counted}.${AUDIO_PROC_FORMAT}`));
      counted += 1;
    }
  }
  const headers = await readHeaders(chunkFiles);

  const chaptersOut: Chapter[] = [];
  let globalIndex = 0;
  sentences.forEach((texts, ci) => {
    if (texts.length === 0) {
      throw new SessionError(`chapter ${ci + 1} has no chunks in session-state.json: a chapter with no audio would produce a chapter marker over silence (${processDir})`);
    }
    const chunks: Chunk[] = texts.map((text) => {
      const audio = chunkFiles[globalIndex];
      const header = headers[globalIndex];
      if (header instanceof FlacHeaderError && header.message.startsWith('FLAC not found')) {
        throw new SessionError(`chapter ${ci + 1} is missing chunk audio ${audio}`);
      }
      if (header instanceof Error) throw header;
      const info = checkExpected(header, sampleRate, CHANNELS);
      const gap = gaps.get(globalIndex) ?? [0, 0];
      const chunk: Chunk = {
        index: globalIndex,
        text,
        kind: chunkKind(text),
        file: relativeFile(processDir, audio),
        gapBefore: gap[0],
        gapAfter: gap[1],
        samples: info.samples,
        take: 1,
      };
      globalIndex += 1;
      return chunk;
    });
    chaptersOut.push({ index: ci + 1, title: titles[ci], doc: docs[ci], chunks });
  });

  const metadata = asDoc(state['metadata']);
  const bf = asDoc(state['bookforge_metadata']);
  const firstTruthy = (...values: unknown[]): unknown => values.find(pyTruthy);

  let title = firstTruthy(bf['title'], metadata['title']) as string | undefined;
  if (!title) {
    const noext = state['filename_noext'];
    if (!pyTruthy(noext)) {
      throw new SessionError(`session-state.json has neither a title nor a filename_noext to build one from (${processDir})`);
    }
    title = String(noext).replace(/_/g, ' ');
  }
  const author = firstTruthy(bf['author'], metadata['creator']) as string | undefined;
  if (!author) {
    throw new SessionError(`session-state.json has no author: neither bookforge_metadata.author nor metadata.creator is set. The author is part of the output filename and of the m4b's artist tag (${processDir})`);
  }
  let year: unknown = firstTruthy(bf['year'], metadata['year']);
  if (!pyTruthy(year)) {
    const published = metadata['published'];
    if (typeof published === 'string' && [...published].length >= 4) year = [...published].slice(0, 4).join('');
  }
  const noext = state['filename_noext'];
  let epubPath: string | null = null;
  if (pyTruthy(noext)) {
    const candidate = path.join(processDir, `${String(noext)}.epub`);
    if (isFile(candidate)) epubPath = candidate;
  }

  const manifest: Manifest = {
    version: 1,
    source: {
      kind: 'e2a-session-v1',
      processDir,
      sessionId: state['session_id'] as string,
      epubContentHash: state['epub_content_hash'] as string,
    },
    book: {
      epubPath,
      title,
      author,
      year: pyTruthy(year) ? String(year) : null,
      language: requiredStr(state, 'language_iso1', processDir),
      language3: requiredStr(state, 'language', processDir),
      cover: resolveCover(processDir, state, log),
      // Empty strings are dropped rather than written as empty tags.
      description: pyTruthy(metadata['description']) ? metadata['description'] as string : null,
      publisher: pyTruthy(metadata['publisher']) ? metadata['publisher'] as string : null,
    },
    engine: engineBlock(engineId),
    voice: {
      engine: engineId,
      // Never defaulted: e2a's own default is the literal 'internal', which crashes three layers away.
      fineTuned: requiredStr(state, 'fine_tuned', processDir),
      modelDir: (state['orpheus_model_dir'] ?? null) as string | null,
      adapterDir: (state['orpheus_adapter_dir'] ?? null) as string | null,
      baseDir: (state['orpheus_base_dir'] ?? null) as string | null,
    },
    sampleRate,
    sentencesDir: resolved,
    chapters: chaptersOut,
  };
  validate(manifest);
  return manifest;
}
