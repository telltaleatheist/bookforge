/**
 * One EPUB to one prepared session: the spine walked into chapters of generation chunks, and the three
 * files every later stage reads. Higgs only. The Orpheus prep went with its engine.
 *
 * `process_dir` and `epub_content_hash` hash PATH STRINGS, never the book's bytes. The second is called a
 * content hash and is not one; every reader knows it by that name, so it keeps it.
 */

import { randomUUID } from 'crypto';
import { promises as fsp } from 'fs';
import * as path from 'path';

import { getSanitized } from '../assemble/run';
import { PY_REGEX_SPACE, pyFloat, pyJsonDumps, pyJsonDumpsAscii, pyLen, pyRepr } from '../py-compat';
import { saveSessionState } from '../session/session-store';
import { DEFAULT_SENTENCE_GAP, classifyGap } from './gaps';
import type { Libxml2 } from './html/lxml';
import {
  EpubBook, EpubItem, TocEntry, UnsupportedInput, acceptEpub, flattenToc, normalizeDocKey, pathMd5, readEpub,
  readMetadata, resolveSourceKind,
} from './epub';
import { ISO639 } from './iso639-data';
import { DEFAULT_FINE_TUNED, DEFAULT_LANGUAGE_CODE, DEFAULT_OUTPUT_FORMAT, UnsupportedLanguage } from './lang';
import { normalizeText } from './normalize';
import { DEFAULT_WALLS, SourceKind, chunkDocument } from './paragraph-packer';

export const HIGGS_V3 = 'higgs-v3';
const STATE_VERSION = 2;
const PREPARED_STATUS = 'prepared';
const GAPS_FILENAME = 'gaps.json';
const GAPS_VERSION = 1;
const DEVICES = new Set(['CPU', 'CUDA', 'MPS', 'ROCM', 'XPU', 'JETSON']);
const SENTENCE_END = new RegExp(`[.!?…]+["'”’)\\]]*(?:[${PY_REGEX_SPACE}]|$)`, 'gu');
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class PrepError extends Error {}
export class UnsupportedEngine extends Error {}

export interface PrepOptions {
  readonly session?: string | null;
  readonly language?: string;
  readonly ttsEngine: string;
  readonly fineTuned?: string;
  readonly voice?: string | null;
  readonly device?: string | null;
  readonly outputFormat?: string;
  readonly audiobooksDir?: string | null;
  readonly customModel?: string | null;
  readonly customModelDir?: string | null;
  readonly higgsVoice?: string | null;
  readonly orpheusModelDir?: string | null;
  readonly orpheusAdapterDir?: string | null;
  readonly orpheusBaseDir?: string | null;
  readonly sentencePerParagraph?: boolean;
  readonly skipHeadings?: boolean;
  readonly bookforgeMetadata?: Record<string, unknown>;
  /** The voice's band, as the rendering Crucible states it. */
  readonly maxChars: number;
  readonly floorChars: number;
  /**
   * The voice's join silence, in seconds, for `gaps.json`. The Python read it from NARRATOR_SENTENCE_GAP on
   * its own spawn; a worker thread has no spawn of its own, so the door states it. Absent reads the environment.
   */
  readonly sentenceGap?: number;
  readonly sourceKind?: SourceKind | null;
}

export interface PrepOutcome {
  readonly state: Record<string, unknown>;
  readonly statePath: string;
  readonly processDir: string;
  readonly sessionDir: string;
}

export const countRealSentences = (chunk: string): number => Math.max(1, (chunk.match(SENTENCE_END) ?? []).length);

const firstTwo = (code: string): string => (pyLen(code) >= 2 ? Array.from(code).slice(0, 2).join('') : 'en');

/** `(pt3, pt1)`. A code that is neither 2 nor 3 characters passes through, as it always has. */
export function resolveLanguage(language: string): [string, string] {
  const length = pyLen(language);
  if (length === 2 || length === 3) {
    const found = Object.prototype.hasOwnProperty.call(ISO639, language) ? ISO639[language] : null;
    if (!found) {
      throw new PrepError(
        `Could not resolve ISO-639-1 code for language ${pyRepr(language)}: ${pyRepr(language)} is not a valid Lang argument.`);
    }
    const [pt3, pt1] = found;
    return [pt3, pt1 || firstTwo(pt3)];
  }
  return [language, firstTwo(language)];
}

export function normalizeDevice(device: string | null | undefined): string {
  if (!device) return 'cpu';
  const upper = device.toUpperCase();
  return DEVICES.has(upper) ? upper.toLowerCase() : 'cpu';
}

/** The sentence-gap floor. Zero is meaningful: it butts chunks together on the model's own pauses. */
function sentenceGapFromEnv(): number {
  for (const name of ['NARRATOR_SENTENCE_GAP', 'ORPHEUS_SENTENCE_GAP']) {
    const raw = process.env[name];
    if (raw !== undefined) {
      const value = Number(raw.trim());
      if (raw.trim() === '' || Number.isNaN(value)) throw new PrepError(`could not convert string to float: ${pyRepr(raw)}`);
      return value;
    }
  }
  return DEFAULT_SENTENCE_GAP;
}

async function writeGapsFile(sentencesDir: string, chapters: readonly string[][], stated: number | undefined, log: (line: string) => void): Promise<void> {
  const floor = stated ?? sentenceGapFromEnv();
  const gaps: Record<string, unknown> = {};
  let index = 0;
  for (const chapter of chapters) {
    for (const chunk of chapter) {
      const [before, after] = classifyGap(chunk, floor);
      gaps[String(index)] = { before: pyFloat(before), after: pyFloat(after) };
      index += 1;
    }
  }
  await fsp.mkdir(sentencesDir, { recursive: true });
  const file = path.join(sentencesDir, GAPS_FILENAME);
  await fsp.writeFile(file, pyJsonDumpsAscii({ version: GAPS_VERSION, engine: HIGGS_V3, gaps }));
  log(`[gaps] ${HIGGS_V3} does not pad its own audio: wrote ${index} gap(s) to ${file}`);
}

interface Chapters {
  readonly chapters: string[][];
  readonly titles: string[];
  readonly titlesByDoc: Map<string, string>;
  readonly docs: string[];
}

async function saveProvenance(processDir: string, c: Chapters, log: (line: string) => void): Promise<void> {
  const file = path.join(processDir, 'chapter-provenance.json');
  try {
    await fsp.writeFile(file, pyJsonDumps({
      chapter_docs: c.docs,
      chapter_titles_by_doc: c.titlesByDoc,
      chapter_titles: c.titles,
    }));
    log(`[TOC] Chapter provenance for ${c.docs.length} chapters saved to ${file}`);
  } catch (err) {
    log(`save_chapter_provenance() error: ${(err as Error).message}`);
  }
}

function readToc(book: EpubBook, language: string, log: (line: string) => void): { titles: string[]; byHref: Map<string, string> } {
  const titles: string[] = [];
  const byHref = new Map<string, string>();
  try {
    const entries: TocEntry[] = flattenToc(book.toc, log);
    for (const entry of entries) {
      const title = normalizeText(entry.title === null ? 'None' : entry.title, language);
      titles.push(title);
      const key = normalizeDocKey(entry.href);
      // Several entries can point into one document. The first in reading order names it.
      if (key && !byHref.has(key)) byHref.set(key, title);
    }
    log(`[TOC] Extracted ${titles.length} chapter titles from TOC (${byHref.size} distinct documents)`);
    return { titles, byHref };
  } catch (err) {
    if (!(err instanceof UnsupportedLanguage)) throw err;
    log(`Error extracting Table of Content: ${err.message}`);
    return { titles: [], byHref };
  }
}

/** A title's `None` is a crash in `get_ebook_title`, which the walk reports as no chapters at all. */
function checkTitleReadable(book: EpubBook): void {
  const titles = book.getMetadata('title');
  if (titles.length > 0 && titles[0] === null) throw new Error("'NoneType' object has no attribute 'strip'");
}

function mapTitles(docs: readonly EpubItem[], byHref: ReadonlyMap<string, string>, log: (line: string) => void): Map<string, string> {
  const titlesByDoc = new Map<string, string>();
  const byBasename = new Map<string, string[]>();
  for (const key of byHref.keys()) {
    const base = key.slice(key.lastIndexOf('/') + 1);
    byBasename.set(base, [...(byBasename.get(base) ?? []), key]);
  }
  for (const doc of docs) {
    const key = normalizeDocKey(doc.fileName);
    if (!key) continue;
    const direct = byHref.get(key);
    if (direct !== undefined) {
      titlesByDoc.set(doc.fileName, direct);
    } else {
      const candidates = byBasename.get(key.slice(key.lastIndexOf('/') + 1)) ?? [];
      if (candidates.length === 1) {
        titlesByDoc.set(doc.fileName, byHref.get(candidates[0]) as string);
        log(`[TOC] Matched document '${doc.fileName}' to TOC href '${candidates[0]}' by basename`);
      }
    }
  }
  const unmatched = docs.map((doc) => doc.fileName).filter((name) => !titlesByDoc.has(name));
  log(`[TOC] Mapped ${titlesByDoc.size}/${docs.length} spine documents to a TOC title`);
  if (unmatched.length > 0) log(`[TOC] No TOC entry for: ${pyRepr(unmatched)} (these use their own first sentence as title)`);
  return titlesByDoc;
}

/**
 * `get_chapters`. Null is the Python's empty answer: any failure in the walk, a book's refusal of one sentence
 * included, comes back as no chapters rather than a partial book. `chapters` and `docs` stay index-aligned,
 * because a document that yields nothing consumes no title.
 */
async function getChapters(
  book: EpubBook,
  processDir: string,
  language: string,
  chunkOptions: Parameters<typeof chunkDocument>[3],
  log: (line: string) => void,
): Promise<Chapters | null> {
  try {
    const { titles, byHref } = readToc(book, language, log);
    const docs = book.spineDocuments();
    if (docs.length === 0) {
      log('No document body found!');
      return null;
    }
    checkTitleReadable(book);
    const titlesByDoc = mapTitles(docs, byHref, log);
    const chapters: string[][] = [];
    const chapterDocs: string[] = [];
    for (const [index, doc] of docs.entries()) {
      const html = UTF8.decode(await doc.bodyContent());
      const chunks = chunkDocument(index, html, doc.fileName, chunkOptions);
      if (chunks.length > 0) {
        chapters.push(chunks);
        chapterDocs.push(doc.fileName);
      }
    }
    const result: Chapters = { chapters, titles, titlesByDoc, docs: chapterDocs };
    await saveProvenance(processDir, result, log);
    if (chapters.length === 0) {
      log('No chapters found! possible reason: file corrupted or need to convert images to text with OCR');
      return null;
    }
    return result;
  } catch (err) {
    if (err instanceof UnsupportedInput || err instanceof UnsupportedEngine) throw err;
    const message = (err as Error).message;
    log(`Error extracting main content pages: ${message}`);
    log(`Caught DependencyError: Error extracting main content pages: ${message}`);
    return null;
  }
}

const isoNow = (): string => {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}000`;
};

export async function prepSession(
  epubPathInput: string,
  sessionDir: string,
  options: PrepOptions,
  libxml2: Libxml2,
  writeCover: (book: EpubBook, processDir: string, filenameNoExt: string, log: (line: string) => void) => Promise<string | boolean>,
  log: (line: string) => void,
): Promise<PrepOutcome> {
  if (options.ttsEngine !== HIGGS_V3) {
    throw new UnsupportedEngine(`narrator preps for ['${HIGGS_V3}'], not '${options.ttsEngine}'. The Orpheus prep was retired with its engine.`);
  }
  const epubPath = path.resolve(epubPathInput);
  await acceptEpub(epubPath);

  const sessionId = options.session || randomUUID();
  const fineTuned = options.fineTuned ?? DEFAULT_FINE_TUNED;
  const voice = options.voice ?? null;
  const onePerRow = Boolean(options.sentencePerParagraph);
  const skipHeadings = Boolean(options.skipHeadings);
  const outputFormat = options.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  const [language, languageIso1] = resolveLanguage(options.language ?? DEFAULT_LANGUAGE_CODE);
  const device = normalizeDevice(options.device);
  const pyBool = (value: boolean): string => (value ? 'True' : 'False');
  log(`[PREP] fine_tuned=${fineTuned}, voice=${voice === null ? 'None' : voice}, tts_engine=${options.ttsEngine}, `
    + `sentence_per_paragraph=${pyBool(onePerRow)}, skip_headings=${pyBool(skipHeadings)}`);

  const processDir = path.join(sessionDir, pathMd5(epubPath));
  const chaptersDir = path.join(processDir, 'chapters');
  const sentencesDir = path.join(chaptersDir, 'sentences');
  await fsp.mkdir(sentencesDir, { recursive: true });

  const internalEpub = path.join(processDir, path.basename(epubPath));
  await fsp.copyFile(epubPath, internalEpub);
  const stem = path.basename(internalEpub);
  const dot = stem.lastIndexOf('.');
  const filenameNoExt = dot > 0 && /[^.]/.test(stem.slice(0, dot)) ? stem.slice(0, dot) : stem;
  const finalName = getSanitized(`${filenameNoExt}.${outputFormat}`);
  log(`Input is already an EPUB - using it directly, no Calibre pass: ${internalEpub}`);

  const book = await readEpub(internalEpub, libxml2);
  try {
    const metadata = readMetadata(book, filenameNoExt);
    let cover: string | boolean | null;
    try {
      cover = await writeCover(book, processDir, filenameNoExt, log);
    } catch (err) {
      log(`Warning: Could not get cover: ${(err as Error).message}`);
      cover = null;
    }

    const sourceKind = options.sourceKind || await resolveSourceKind(book, log);
    const higgsVoice = options.higgsVoice ?? null;
    const budget = { voice: higgsVoice, max_chars: options.maxChars, max_chars_per_sec: pyFloat(0) };
    const chunking: Record<string, unknown> = {
      policy: 'paragraph',
      engine: options.ttsEngine,
      floor_chars: onePerRow ? 0 : options.floorChars,
      source_kind: sourceKind,
      walls: [...DEFAULT_WALLS].sort(),
      budget,
    };
    if (onePerRow) {
      chunking['sentence_per_paragraph'] = true;
      chunking['why'] = 'sentence_per_paragraph: each source row is exactly one generation chunk, so no merge floor '
        + "and no cap split ran at prep. The budget below is the voice's certificate, recorded because the render still "
        + "guards every take against it; a row longer than the cap is the operator's chunk and the engine's truncation guard answers for it.";
      log('[chunking] paragraph policy, ONE CHUNK PER SOURCE ROW (sentence_per_paragraph): no merge floor, no cap split; '
        + `cap=${options.maxChars} chars is the render's guard, source=${sourceKind}`);
    } else {
      log(`[chunking] paragraph policy: floor=${options.floorChars} chars, cap=${options.maxChars} chars, source=${sourceKind}`);
    }

    const walked = await getChapters(book, processDir, language, {
      cap: options.maxChars,
      floorChars: options.floorChars,
      sourceKind,
      skipHeadings,
      sentencePerParagraph: onePerRow,
      log,
    }, log);
    if (!walked) {
      throw new PrepError(
        `No chapters produced from ${internalEpub}. get_chapters() printed the reason above (no spine documents, `
        + 'an extraction failure on one document, or every document skipped as front/back matter).');
    }
    const { chapters } = walked;

    const chapterInfo: Array<Record<string, number>> = [];
    let offset = 0;
    for (const [i, chapter] of chapters.entries()) {
      chapterInfo.push({
        chapter_num: i + 1,
        sentence_count: chapter.length,
        raw_sentence_count: chapter.reduce((sum, chunk) => sum + countRealSentences(chunk), 0),
        sentence_start: offset,
        sentence_end: offset + chapter.length - 1,
      });
      offset += chapter.length;
    }

    const now = isoNow();
    const state: Record<string, unknown> = {
      version: STATE_VERSION,
      session_id: sessionId,
      epub_path: internalEpub,
      source_epub_path: epubPath,
      epub_content_hash: pathMd5(internalEpub),
      total_sentences: offset,
      total_chapters: chapters.length,
      chapters: chapterInfo,
      chapter_sentences: chapters,
      language,
      language_iso1: languageIso1,
      voice,
      fine_tuned: fineTuned,
      custom_model: options.customModel ?? null,
      custom_model_dir: options.customModelDir ?? null,
      higgs_voice: higgsVoice,
      orpheus_model_dir: options.orpheusModelDir ?? null,
      orpheus_adapter_dir: options.orpheusAdapterDir ?? null,
      orpheus_base_dir: options.orpheusBaseDir ?? null,
      tts_engine: options.ttsEngine,
      device,
      output_format: outputFormat,
      audiobooks_dir: options.audiobooksDir ?? null,
      created_at: now,
      updated_at: now,
      status: PREPARED_STATUS,
      metadata: { title: metadata['title'], creator: metadata['creator'], language: metadata['language'] },
      session_dir: sessionDir,
      process_dir: processDir,
      chapters_dir: chaptersDir,
      chapters_dir_sentences: sentencesDir,
      epub_path_internal: internalEpub,
      filename_noext: filenameNoExt,
      cover,
      final_name: finalName,
      chapter_titles: walked.titles,
      chapter_docs: walked.docs,
      chapter_titles_by_doc: walked.titlesByDoc,
      bookforge_metadata: options.bookforgeMetadata ?? {},
      bookforge_chunking: chunking,
    };

    // Before the state, so a session is never left promising an engine whose gap file failed to appear.
    await writeGapsFile(sentencesDir, chapters, options.sentenceGap, log);
    const statePath = await saveSessionState(processDir, state);
    log(`Session state saved to ${statePath}`);
    return { state, statePath, processDir, sessionDir };
  } finally {
    await book.close();
  }
}
