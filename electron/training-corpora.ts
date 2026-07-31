/**
 * The three training corpora, inventoried from disk.
 *
 * BookForge fine-tunes three models, each with its own corpus, its own unit of
 * work and its own store — and until now only one of them was visible anywhere
 * in the app:
 *
 *   rubric  page layout      a BOOK of labelled blocks   training/<slug>/
 *   dagger  footnote markers a BOOK of before/after pairs training/dagger/*.jsonl
 *   galley  OCR correction   a public corpus + scan pairs training/galley/
 *
 * Only rubric books open in the editor: they are pages with rectangles on them.
 * Dagger examples are line-level text rewrites and galley's are OCR/ground-truth
 * string pairs, so those two report inventory and nothing more. Saying that
 * plainly is the point — a tab that looks clickable and is not would be worse
 * than one that states what it is.
 *
 * Everything here READS. No function in this file creates, moves or deletes
 * anything: the corpora are the expensive artifact and the app has no business
 * editing two of them.
 */

import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { trainingRootDir } from './training-data';

/** One book's worth of dagger training pairs, summed across its files. */
export interface DaggerBookSummary {
  book: string;
  /** Lines with a marker to strip — the positive examples. */
  draft: number;
  /** Lines that must come back UNCHANGED; the guard against over-firing. */
  negatives: number;
  /** Lines the builder could not decide; excluded from training by design. */
  ambiguous: number;
  /** Which corpus generation these came from. v2 superseded v1. */
  versions: string[];
  total: number;
}

/** A public post-OCR corpus, as downloaded. */
export interface GalleyCorpusSummary {
  name: string;
  files: number;
  bytes: number;
}

export interface TrainingCorpora {
  dagger: {
    books: DaggerBookSummary[];
    /** Totals across every book, so the tab can lead with the corpus size. */
    draft: number; negatives: number; ambiguous: number;
  };
  galley: {
    corpora: GalleyCorpusSummary[];
    /**
     * Rubric books that also carry a source EPUB — the scan+markup pairs galley
     * needs. Reported because the pairing is the scarce thing, not the scan.
     */
    pairs: Array<{ slug: string; pdf: string; epub: string }>;
  };
}

async function exists(p: string): Promise<boolean> {
  try { await fsPromises.access(p); return true; } catch { return false; }
}

/** Count lines without holding the file: these run to tens of MB. */
async function countLines(file: string): Promise<number> {
  const handle = await fsPromises.open(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let lines = 0;
    let last = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 10) lines++;
      last = buf[bytesRead - 1];
    }
    // A final line with no trailing newline still counts.
    return lines + (last !== 10 && lines >= 0 ? 1 : 0);
  } finally {
    await handle.close();
  }
}

/**
 * `<Book-Name>.<kind>[.v2].jsonl` — the naming the corpus builder writes.
 *
 * Files that do not match are the builder's own bookkeeping (`_report.json`,
 * `garble-inventory.json`, `build_corpus.py`) and are skipped rather than
 * guessed at.
 */
const DAGGER_FILE = /^(.*?)\.(draft|negatives|ambiguous)(\.v\d+)?\.jsonl$/;

async function listDagger(root: string): Promise<TrainingCorpora['dagger']> {
  const dir = path.join(root, 'dagger');
  const empty = { books: [], draft: 0, negatives: 0, ambiguous: 0 };
  if (!await exists(dir)) return empty;

  const byBook = new Map<string, DaggerBookSummary>();
  for (const name of (await fsPromises.readdir(dir)).sort()) {
    const m = DAGGER_FILE.exec(name);
    if (!m) continue;
    const [, book, kind, version] = m;
    if (!byBook.has(book)) {
      byBook.set(book, { book, draft: 0, negatives: 0, ambiguous: 0, versions: [], total: 0 });
    }
    const row = byBook.get(book)!;
    const n = await countLines(path.join(dir, name));
    row[kind as 'draft' | 'negatives' | 'ambiguous'] += n;
    row.total += n;
    const v = version ? version.slice(1) : 'v1';
    if (!row.versions.includes(v)) row.versions.push(v);
  }

  const books = [...byBook.values()].sort((a, b) => b.total - a.total);
  return {
    books,
    draft: books.reduce((s, b) => s + b.draft, 0),
    negatives: books.reduce((s, b) => s + b.negatives, 0),
    ambiguous: books.reduce((s, b) => s + b.ambiguous, 0),
  };
}

/** Recursive file count and byte total, for a corpus measured in tens of thousands. */
async function measureTree(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try { entries = await fsPromises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        files++;
        try { bytes += (await fsPromises.stat(p)).size; } catch { /* raced; not worth failing for */ }
      }
    }
  };
  await walk(dir);
  return { files, bytes };
}

async function listGalley(root: string): Promise<TrainingCorpora['galley']> {
  const corpora: GalleyCorpusSummary[] = [];
  const publicDir = path.join(root, 'galley', 'public-corpora');
  if (await exists(publicDir)) {
    for (const name of (await fsPromises.readdir(publicDir)).sort()) {
      if (name.startsWith('.')) continue;
      const p = path.join(publicDir, name);
      try { if (!(await fsPromises.stat(p)).isDirectory()) continue; } catch { continue; }
      corpora.push({ name, ...(await measureTree(p)) });
    }
  }

  // A pair is a book folder holding BOTH a PDF and an EPUB. That co-location is
  // what makes it usable: galley learns from the same page read two ways, and a
  // scan whose markup lives in another project is not a pair anyone can use.
  const pairs: Array<{ slug: string; pdf: string; epub: string }> = [];
  for (const name of (await fsPromises.readdir(root)).sort()) {
    if (name.startsWith('.')) continue;
    const dir = path.join(root, name);
    let files: string[];
    try {
      if (!(await fsPromises.stat(dir)).isDirectory()) continue;
      files = await fsPromises.readdir(dir);
    } catch { continue; }
    const pdf = files.find(f => f.toLowerCase().endsWith('.pdf') && !f.startsWith('._'));
    const epub = files.find(f => f.toLowerCase().endsWith('.epub') && !f.startsWith('._'));
    if (pdf && epub) pairs.push({ slug: name, pdf: path.join(dir, pdf), epub: path.join(dir, epub) });
  }

  return { corpora, pairs };
}

/** Inventory dagger and galley. Rubric books come from `listTrainingBooks`. */
export async function listTrainingCorpora(): Promise<TrainingCorpora> {
  const root = trainingRootDir();
  const [dagger, galley] = await Promise.all([listDagger(root), listGalley(root)]);
  return { dagger, galley };
}
