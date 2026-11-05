/**
 * THE RENDER MANIFEST (schema v1), the one source of truth for a book render. A port of
 * `narrator/manifest.py`; `python/narrator/CONTRACTS.md` fixes the schema.
 *
 * `file` is relative to `source.processDir`, which is absolute and lives inside the
 * document, so a manifest resolves to the same audio wherever it is written.
 *
 * A required key is read as required: a manifest missing `sampleRate` is a bug to surface,
 * not a 24000 to assume. `null` is legal only where the schema says so.
 */

import * as fs from 'fs';
import * as path from 'path';

import { pyFloat, pyJsonDumps, pyRepr } from '../py-compat';

export const SCHEMA_VERSION = 1;

/** The `kind` values a chunk may carry, derived from its leading SML marker. */
export const CHUNK_KINDS = ['prose', 'heading', 'item'] as const;
export type ChunkKind = (typeof CHUNK_KINDS)[number];

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export interface Source {
  kind: string;
  processDir: string;
  sessionId: string;
  epubContentHash: string;
}

/** `description` and `publisher` are additive: an untagged book's document has neither key. */
export interface Book {
  title: string;
  author: string;
  language: string;
  language3: string;
  epubPath: string | null;
  year: string | null;
  cover: string | null;
  description?: string | null;
  publisher?: string | null;
}

export interface Voice {
  engine: string;
  fineTuned: string;
  modelDir: string | null;
  adapterDir: string | null;
  baseDir: string | null;
}

/** Absent on a manifest means Orpheus semantics: the silence is baked into the chunks. */
export interface Engine {
  id: string;
  pads: boolean;
  edgeFadeMs: { in: number; out: number };
}

export interface Chunk {
  /** The GLOBAL 0-based index across the book, and the FLAC's stem. */
  index: number;
  /** Exactly as the session stored it, markers kept. */
  text: string;
  kind: string;
  file: string;
  gapBefore: number;
  gapAfter: number;
  /** STREAMINFO total samples: exact. Null means not rendered yet. */
  samples: number | null;
  take: number;
}

export interface Chapter {
  index: number;
  title: string;
  doc: string | null;
  chunks: Chunk[];
}

export interface Manifest {
  version: number;
  source: Source;
  book: Book;
  voice: Voice;
  engine: Engine | null;
  sampleRate: number;
  sentencesDir: string;
  chapters: Chapter[];
}

type Doc = Record<string, unknown>;

function typeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'object') return 'dict';
  if (typeof value === 'string') return 'str';
  if (typeof value === 'boolean') return 'bool';
  return Number.isInteger(value) ? 'int' : 'float';
}

function need(d: unknown, key: string, where: string): unknown {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    throw new ManifestError(`${where}: expected an object, got ${typeName(d)}`);
  }
  if (!(key in (d as Doc))) throw new ManifestError(`${where}: missing required key ${pyRepr(key)}`);
  return (d as Doc)[key];
}

/** A decoded document to a Manifest. Types are `validate`'s to check. */
export function fromDict(data: unknown): Manifest {
  const version = need(data, 'version', 'manifest') as number;
  if (version !== SCHEMA_VERSION) {
    throw new ManifestError(`manifest.version is ${pyRepr(version)}, this build only reads schema v${SCHEMA_VERSION}`);
  }
  const doc = data as Doc;
  const s = need(doc, 'source', 'manifest');
  const b = need(doc, 'book', 'manifest');
  const v = need(doc, 'voice', 'manifest');

  let engine: Engine | null = null;
  if (doc['engine'] !== null && doc['engine'] !== undefined) {
    const e = doc['engine'] as Doc;
    const fade = (e['edgeFadeMs'] || {}) as unknown;
    if (typeof fade !== 'object' || Array.isArray(fade)) {
      throw new ManifestError(`engine.edgeFadeMs must be an object with 'in' and 'out', got ${pyRepr(fade)}`);
    }
    const rows = fade as Doc;
    engine = {
      id: need(e, 'id', 'engine') as string,
      pads: need(e, 'pads', 'engine') as boolean,
      edgeFadeMs: {
        in: ('in' in rows ? rows['in'] : 0) as number,
        out: ('out' in rows ? rows['out'] : 0) as number,
      },
    };
  }

  const rawChapters = need(doc, 'chapters', 'manifest');
  if (!Array.isArray(rawChapters)) throw new ManifestError('manifest.chapters must be a list');
  const chapters = rawChapters.map((rc: unknown, ci: number): Chapter => {
    const where = `chapters[${ci}]`;
    const rawChunks = need(rc, 'chunks', where);
    if (!Array.isArray(rawChunks)) throw new ManifestError(`${where}.chunks must be a list`);
    const chunks = rawChunks.map((rk: unknown, ki: number): Chunk => {
      const kwhere = `${where}.chunks[${ki}]`;
      return {
        index: need(rk, 'index', kwhere) as number,
        text: need(rk, 'text', kwhere) as string,
        kind: need(rk, 'kind', kwhere) as string,
        file: need(rk, 'file', kwhere) as string,
        gapBefore: need(rk, 'gapBefore', kwhere) as number,
        gapAfter: need(rk, 'gapAfter', kwhere) as number,
        samples: need(rk, 'samples', kwhere) as number | null,
        take: need(rk, 'take', kwhere) as number,
      };
    });
    return {
      index: need(rc, 'index', where) as number,
      title: need(rc, 'title', where) as string,
      doc: need(rc, 'doc', where) as string | null,
      chunks,
    };
  });

  const bookDoc = b as Doc;
  return {
    version,
    source: {
      kind: need(s, 'kind', 'source') as string,
      processDir: need(s, 'processDir', 'source') as string,
      sessionId: need(s, 'sessionId', 'source') as string,
      epubContentHash: need(s, 'epubContentHash', 'source') as string,
    },
    book: {
      title: need(b, 'title', 'book') as string,
      author: need(b, 'author', 'book') as string,
      language: need(b, 'language', 'book') as string,
      language3: need(b, 'language3', 'book') as string,
      epubPath: need(b, 'epubPath', 'book') as string | null,
      year: need(b, 'year', 'book') as string | null,
      cover: need(b, 'cover', 'book') as string | null,
      // Not required: every manifest written before they existed omits them.
      description: (bookDoc['description'] ?? null) as string | null,
      publisher: (bookDoc['publisher'] ?? null) as string | null,
    },
    voice: {
      engine: need(v, 'engine', 'voice') as string,
      fineTuned: need(v, 'fineTuned', 'voice') as string,
      modelDir: need(v, 'modelDir', 'voice') as string | null,
      adapterDir: need(v, 'adapterDir', 'voice') as string | null,
      baseDir: need(v, 'baseDir', 'voice') as string | null,
    },
    engine,
    sampleRate: need(doc, 'sampleRate', 'manifest') as number,
    sentencesDir: need(doc, 'sentencesDir', 'manifest') as string,
    chapters,
  };
}

/** The document, in the schema's key order. Gaps and fades are floats, as Python holds them. */
export function toDict(manifest: Manifest): Doc {
  const book: Doc = {
    epubPath: manifest.book.epubPath,
    title: manifest.book.title,
    author: manifest.book.author,
    year: manifest.book.year,
    language: manifest.book.language,
    language3: manifest.book.language3,
    cover: manifest.book.cover,
  };
  // Only when the book has one, so an untagged book's document is unchanged.
  if (manifest.book.description !== null && manifest.book.description !== undefined) book['description'] = manifest.book.description;
  if (manifest.book.publisher !== null && manifest.book.publisher !== undefined) book['publisher'] = manifest.book.publisher;

  const doc: Doc = {
    version: manifest.version,
    source: { ...manifest.source },
    book,
    voice: { ...manifest.voice },
  };
  if (manifest.engine !== null) {
    doc['engine'] = {
      id: manifest.engine.id,
      pads: manifest.engine.pads,
      edgeFadeMs: { in: pyFloat(manifest.engine.edgeFadeMs.in), out: pyFloat(manifest.engine.edgeFadeMs.out) },
    };
  }
  doc['sampleRate'] = manifest.sampleRate;
  doc['sentencesDir'] = manifest.sentencesDir;
  doc['chapters'] = manifest.chapters.map((c) => ({
    index: c.index,
    title: c.title,
    doc: c.doc,
    chunks: c.chunks.map((k) => ({
      index: k.index,
      text: k.text,
      kind: k.kind,
      gapBefore: pyFloat(k.gapBefore),
      gapAfter: pyFloat(k.gapAfter),
      file: k.file,
      samples: k.samples,
      take: k.take,
    })),
  }));
  return doc;
}

export function renderManifest(manifest: Manifest): string {
  return `${pyJsonDumps(toDict(manifest))}\n`;
}

/** Write it as UTF-8 JSON. Writing never changes the manifest. */
export function saveManifest(manifest: Manifest, file: string): string {
  validate(manifest);
  const target = path.resolve(file);
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new ManifestError(`cannot save manifest: ${parent} is not a directory`);
  }
  fs.writeFileSync(target, renderManifest(manifest), 'utf8');
  return target;
}

export function loadManifest(file: string): Manifest {
  const target = path.resolve(file);
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new ManifestError(`manifest not found: ${target}`);
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    throw new ManifestError(`manifest is not valid JSON: ${target}: ${(err as Error).message}`);
  }
  const manifest = fromDict(data);
  validate(manifest);
  return manifest;
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** Strict. Refuses on the first problem, naming the chapter and chunk it is in. */
export function validate(manifest: Manifest): void {
  if (manifest.version !== SCHEMA_VERSION) {
    throw new ManifestError(`manifest.version is ${pyRepr(manifest.version)}, expected ${SCHEMA_VERSION}`);
  }
  if (!isInt(manifest.sampleRate)) throw new ManifestError(`manifest.sampleRate must be an int, got ${pyRepr(manifest.sampleRate)}`);
  if (manifest.sampleRate <= 0) throw new ManifestError(`manifest.sampleRate must be > 0, got ${manifest.sampleRate}`);
  if (typeof manifest.sentencesDir !== 'string' || manifest.sentencesDir === '') {
    throw new ManifestError('manifest.sentencesDir must be a non-empty string');
  }
  if (manifest.chapters.length === 0) throw new ManifestError('manifest.chapters is empty: there is no book to assemble');

  if (manifest.engine !== null) {
    const e = manifest.engine;
    if (typeof e.id !== 'string' || e.id === '') throw new ManifestError(`engine.id must be a non-empty string, got ${pyRepr(e.id)}`);
    if (typeof e.pads !== 'boolean') throw new ManifestError(`engine.pads must be a bool, got ${pyRepr(e.pads)}`);
    for (const [name, value] of [['in', e.edgeFadeMs.in], ['out', e.edgeFadeMs.out]] as const) {
      if (!isNumber(value)) throw new ManifestError(`engine.edgeFadeMs.${name} must be a number, got ${pyRepr(value)}`);
      if (!Number.isFinite(value)) throw new ManifestError(`engine.edgeFadeMs.${name} is not finite: ${pyRepr(value)}`);
      if (value < 0) throw new ManifestError(`engine.edgeFadeMs.${name} is negative: ${pyRepr(value)}`);
    }
    if (e.pads && (e.edgeFadeMs.in !== 0 || e.edgeFadeMs.out !== 0)) {
      throw new ManifestError(
        `engine ${pyRepr(e.id)} declares pads=True and a non-zero edgeFadeMs (${pyFloatWords(e.edgeFadeMs.in)} in / ${pyFloatWords(e.edgeFadeMs.out)} out). `
        + "A padded engine's chunks are joined untouched, so that fade would never be applied.",
      );
    }
  }

  // No engine block means Orpheus semantics: padded chunks, no gaps.
  const padsEngine = manifest.engine === null || manifest.engine.pads;
  const engineLabel = manifest.engine !== null ? manifest.engine.id : 'absent, so Orpheus';

  let expectedIndex = 0;
  const seenFiles = new Map<string, number>();
  manifest.chapters.forEach((chapter, pos) => {
    const want = pos + 1;
    if (!isInt(chapter.index)) throw new ManifestError(`chapters[${pos}].index must be an int, got ${pyRepr(chapter.index)}`);
    if (chapter.index !== want) {
      throw new ManifestError(`chapters[${pos}].index is ${chapter.index}, expected ${want}: chapter numbers must be 1-based and contiguous`);
    }
    if (typeof chapter.title !== 'string') throw new ManifestError(`chapters[${pos}].title must be a string, got ${typeName(chapter.title)}`);
    if (chapter.doc !== null && typeof chapter.doc !== 'string') {
      throw new ManifestError(`chapters[${pos}].doc must be a string or null, got ${pyRepr(chapter.doc)}`);
    }
    if (chapter.chunks.length === 0) {
      throw new ManifestError(`chapter ${chapter.index} has no chunks: a chapter with no audio would produce a chapter marker over silence`);
    }
    chapter.chunks.forEach((chunk, kpos) => {
      const where = `chapter ${chapter.index} chunk[${kpos}]`;
      if (!isInt(chunk.index)) throw new ManifestError(`${where}.index must be an int, got ${pyRepr(chunk.index)}`);
      if (chunk.index !== expectedIndex) {
        throw new ManifestError(`${where}.index is ${chunk.index}, expected ${expectedIndex}: chunk indices must cover 0..N-1 across the book with no holes and no repeats`);
      }
      expectedIndex += 1;
      if (typeof chunk.text !== 'string') throw new ManifestError(`${where}.text must be a string, got ${typeName(chunk.text)}`);
      if (!(CHUNK_KINDS as readonly string[]).includes(chunk.kind)) {
        throw new ManifestError(`${where}.kind is ${pyRepr(chunk.kind)}, expected one of ('prose', 'heading', 'item')`);
      }
      if (typeof chunk.file !== 'string' || chunk.file === '') throw new ManifestError(`${where}.file must be a non-empty string`);
      for (const gapName of ['gapBefore', 'gapAfter'] as const) {
        const gap = chunk[gapName];
        if (!isNumber(gap)) throw new ManifestError(`${where}.${gapName} must be a number, got ${pyRepr(gap)}`);
        if (!Number.isFinite(gap)) throw new ManifestError(`${where}.${gapName} is not finite: ${pyRepr(gap)}`);
        if (gap < 0) throw new ManifestError(`${where}.${gapName} is negative: ${pyRepr(gap)}`);
        if (gap !== 0 && padsEngine) {
          throw new ManifestError(
            `${where}.${gapName} is ${pyRepr(gap)}, but this manifest's engine (${engineLabel}) BAKES its silence into each chunk's own audio. `
            + 'A gap here would be added on top of silence that is already in the FLAC.',
          );
        }
      }
      if (chunk.samples !== null) {
        if (!isInt(chunk.samples)) throw new ManifestError(`${where}.samples must be an int or null, got ${pyRepr(chunk.samples)}`);
        if (chunk.samples <= 0) {
          throw new ManifestError(`${where}.samples is ${chunk.samples}: a rendered chunk of zero length is a damaged file, not silence (${chunk.file})`);
        }
      }
      if (!isInt(chunk.take)) throw new ManifestError(`${where}.take must be an int, got ${pyRepr(chunk.take)}`);
      if (chunk.take < 1) throw new ManifestError(`${where}.take must be >= 1, got ${chunk.take}`);
      // Separators only, not case: `0.flac` and `0.FLAC` are two files on the machines that render.
      const key = chunk.file.replace(/\\/g, '/');
      const other = seenFiles.get(key);
      if (other !== undefined) {
        throw new ManifestError(`${where}.file ${pyRepr(chunk.file)} is already used by chunk ${other}: two chunks cannot share one audio file`);
      }
      seenFiles.set(key, chunk.index);
    });
  });
}

function pyFloatWords(value: number): string {
  return pyRepr(pyFloat(value));
}

/** Every chunk in the book, in global index order. */
export function flatChunks(manifest: Manifest): Chunk[] {
  return manifest.chapters.flatMap((chapter) => chapter.chunks);
}

/** The absolute path of a chunk's audio. The only resolver. */
export function chunkPath(manifest: Manifest, chunk: Chunk): string {
  if (path.isAbsolute(chunk.file)) return path.normalize(chunk.file);
  if (!manifest.source.processDir) {
    throw new ManifestError(`chunk ${chunk.index} has the relative path ${pyRepr(chunk.file)} but the manifest's source.processDir is empty, so there is nothing to resolve it against`);
  }
  return path.normalize(path.join(manifest.source.processDir, chunk.file));
}

/** Refuses if any chunk is unrendered: every consumer would draw a confidently short conclusion. */
export function totalSamples(manifest: Manifest): number {
  let total = 0;
  for (const chunk of flatChunks(manifest)) {
    if (chunk.samples === null) throw new ManifestError(`chunk ${chunk.index} has no sample count (${chunk.file}): the book is not fully rendered`);
    total += chunk.samples;
  }
  return total;
}
