/**
 * The three training corpora, inventoried from disk.
 *
 * BookForge fine-tunes three models, each with its own corpus, its own unit of
 * work and its own store — and until now only one of them was visible anywhere
 * in the app:
 *
 *   blocks     page layout      a BOOK of labelled blocks    training/<slug>/
 *   footnotes  footnote markers a BOOK of before/after pairs training/dagger/*.jsonl
 *   ocr        OCR correction   a public corpus + scan pairs training/galley/
 *
 * THE DIRECTORY NAMES ARE PERSISTED, THE STAGE NAMES ARE NOT. The models were
 * called rubric / dagger / galley until Aug 2026 and are now blocks / footnotes /
 * ocr, but the corpus master on disk still carries the old folder names and this
 * file does not rename a user's corpus to tidy up a word. Every 'dagger' and
 * 'galley' literal below is an ON-DISK name, not a stage name.
 *
 * Only blocks books open in the editor: they are pages with rectangles on them.
 * Footnote examples are line-level text rewrites and ocr's are OCR/ground-truth
 * string pairs, so those two report inventory and nothing more. Saying that
 * plainly is the point — a tab that looks clickable and is not would be worse
 * than one that states what it is.
 *
 * Everything here READS. No function in this file creates, moves or deletes
 * anything: the corpora are the expensive artifact and the app has no business
 * editing two of them.
 *
 * It reads ONE thing outside the corpus master: the OCR lab next door
 * (`<training>/ocr-lab/`), because that is where the PDF+EPUB pairs actually
 * live — `gold/<book>/` holds the files and `gold/manifest.json` holds their
 * provenance. `listPairedBooks` merges those with any pair placed straight into
 * the corpus root and says, per book, whether it is already labelled.
 */

import * as path from 'path';
import * as fsPromises from 'fs/promises';
import { ocrLabRootDir, trainingRootDir } from './training-data';

/** One book's worth of footnote-marker training pairs, summed across its files. */
export interface FootnotesBookSummary {
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
export interface OCRCorpusSummary {
  name: string;
  files: number;
  bytes: number;
}

/** One file of a pair, checked rather than assumed. */
export interface PairedFile {
  /** Absolute path. Present even when the file is not — that is the report. */
  path: string;
  exists: boolean;
  /** Size in bytes, or null when it is not there to measure. */
  bytes: number | null;
}

/**
 * A book that exists as BOTH a PDF and an EPUB, wherever those two actually sit.
 *
 * The pairing is the scarce thing in this corpus: the same pages read two ways
 * is what turns a scan into supervised OCR correction, and it is also the
 * shortlist of books worth hand-labelling for blocks — a labelled book with a
 * clean EPUB beside it pays for itself twice.
 */
export interface PairedBook {
  /**
   * The corpus slug: the directory under the corpus master this book labels
   * into. The OCR lab's own run-directory name where there is one (that is the
   * established name for the book — `michelle-remembers` is already in the
   * corpus under it), otherwise the gold folder name slugified.
   */
  slug: string;
  /** The book as a human names it — the gold folder / manifest key. */
  title: string;
  /** Where the pair was found. Both are real; neither is a fallback for the other. */
  source: 'ocr-lab' | 'corpus-root';
  /** `ocr-lab/gold/<book>/`, which is where the source files live. */
  goldDir: string | null;
  /** `ocr-lab/<slug>/` — renders, bands, ocr-bands, scores. Null when never run. */
  labDir: string | null;
  /** The scan (or born-digital PDF). Null when the folder holds none at all. */
  pdf: PairedFile | null;
  /** The clean book. Null for the tier-3 books, which have a reference instead. */
  epub: PairedFile | null;
  /** `pdfelement.pdf` — the OCR-derived reference the no-EPUB books arbitrate on. */
  reference: PairedFile | null;
  /** 1 exact truth, 2 dual-OCR agreement, 3 PDFelement-only. From gold/manifest.json. */
  truthTier: number | null;
  /** The manifest's own words about the scan / pdf / epub / reference. */
  quality: string | null;
  /** The manifest's `notes`, verbatim. */
  notes: string | null;
  /** `<corpus>/<slug>/` — where labelling this book writes, whether or not it exists. */
  corpusDir: string;
  /** True when that directory holds labels.json: this book is in the blocks corpus. */
  labelled: boolean;
  /** When labels.json was last written, so a stale corpus entry is visible. */
  labelledAt: string | null;
  /**
   * How the corpus entry was recognised as THIS book, or null when there is none.
   *
   * 'slug' is the corpus directory named for the book. The rest are for the books
   * that entered the corpus from the library instead, under the library's project
   * name (`Nuremberg_-_Infamy_on_Trial_-_…`): a recorded PDF at the same PATH is
   * the same file, the same SIZE is a copy of it, and failing both, a corpus
   * directory whose own name STARTS with this book's slug is the same title
   * held as a different render. That last one is a name match and nothing more —
   * which is why it is reported by name and ranked last.
   */
  matchedBy: 'slug' | 'recorded-pdf-path' | 'recorded-pdf-size' | 'corpus-dir-name' | null;
  /** The corpus directory that actually carries the labels, when not `corpusDir`. */
  labelledIn: string | null;
  /**
   * `{library}/projects/<id>/` — the project this book is held as, or null.
   *
   * The detect-first prep step (`cli/blocks-detect.js`) runs against a LIBRARY
   * PROJECT: it reads that project's manifest for `editor.ocrBlocks` and paints
   * the model's answers back into it. So a paired book only has a detect command
   * when it is also a project, and the connection is its corpus book's recorded
   * PDF sitting in that project's `archive/`. Null means there is nothing to run
   * detect against yet — which is a fact about the book, not a missing feature.
   */
  projectDir: string | null;
  /**
   * Everything wrong with this book, in the words of the thing that is wrong.
   *
   * A book with problems is still LISTED — dropping it would hide exactly the
   * books that need attention. Missing files name their full path.
   */
  problems: string[];
}

export interface TrainingCorpora {
  footnotes: {
    books: FootnotesBookSummary[];
    /** Totals across every book, so the tab can lead with the corpus size. */
    draft: number; negatives: number; ambiguous: number;
  };
  ocr: {
    corpora: OCRCorpusSummary[];
    /**
     * Blocks books that also carry a source EPUB — the scan+markup pairs ocr
     * needs. Reported because the pairing is the scarce thing, not the scan.
     */
    pairs: Array<{ slug: string; pdf: string; epub: string }>;
    /**
     * Every PDF+EPUB pair on this machine, from the OCR lab AND from the corpus
     * root, with its label status. This is the work list.
     */
    paired: PairedBook[];
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
const FOOTNOTES_FILE = /^(.*?)\.(draft|negatives|ambiguous)(\.v\d+)?\.jsonl$/;

async function listFootnotes(root: string): Promise<TrainingCorpora['footnotes']> {
  // 'dagger' is the corpus's ON-DISK name — see the header. Not a stage name.
  const dir = path.join(root, 'dagger');
  const empty = { books: [], draft: 0, negatives: 0, ambiguous: 0 };
  if (!await exists(dir)) return empty;

  const byBook = new Map<string, FootnotesBookSummary>();
  for (const name of (await fsPromises.readdir(dir)).sort()) {
    const m = FOOTNOTES_FILE.exec(name);
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

async function listOCR(root: string): Promise<TrainingCorpora['ocr']> {
  const corpora: OCRCorpusSummary[] = [];
  // 'galley' is the corpus's ON-DISK name — see the header. Not a stage name.
  // (This read 'ocr' between the partial rename and Aug 3 2026, which made the
  // public-corpora panel report nothing on a corpus that had them.)
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
  // what makes it usable: ocr learns from the same page read two ways, and a
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

  return { corpora, pairs, paired: await listPairedBooks(root, pairs) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paired books — the PDF+EPUB shortlist, from the OCR lab and the corpus root
// ─────────────────────────────────────────────────────────────────────────────

/** Directory name → the slug a corpus directory would be called. */
function slugifyBookName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** Stat a candidate into a PairedFile. Never throws — absence is the answer. */
async function pairedFile(file: string): Promise<PairedFile> {
  try {
    const stat = await fsPromises.stat(file);
    return { path: file, exists: true, bytes: stat.size };
  } catch {
    return { path: file, exists: false, bytes: null };
  }
}

async function readdirSafe(dir: string): Promise<string[] | null> {
  try { return await fsPromises.readdir(dir); } catch { return null; }
}

/** Directories only, no dotfiles, sorted. */
async function subdirectories(dir: string): Promise<string[]> {
  let entries;
  try { entries = await fsPromises.readdir(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** What `gold/manifest.json` says about one book. Every field is optional there. */
interface GoldEntry {
  scan?: string; pdf?: string; epub?: string; reference?: string;
  truthTier?: number; notes?: string;
}

/**
 * The manifest's per-book provenance, keyed case-insensitively by folder name.
 *
 * Returns null when there is no manifest — that is a different thing from an
 * empty one, and the caller says so.
 */
async function readGoldManifest(
  goldRoot: string,
): Promise<{ entries: Map<string, GoldEntry>; error: string | null } | null> {
  const file = path.join(goldRoot, 'manifest.json');
  let raw: string;
  try { raw = await fsPromises.readFile(file, 'utf-8'); } catch { return null; }
  try {
    const parsed = JSON.parse(raw) as { books?: Record<string, GoldEntry> };
    const entries = new Map<string, GoldEntry>();
    for (const [name, entry] of Object.entries(parsed.books ?? {})) {
      entries.set(name.toLowerCase(), entry);
    }
    return { entries, error: null };
  } catch (err) {
    return { entries: new Map(), error: `${file}: ${(err as Error).message}` };
  }
}

/** The manifest's own words about this book's material, joined for one line of UI. */
function qualityOf(entry: GoldEntry | undefined): string | null {
  if (!entry) return null;
  const parts: string[] = [];
  if (entry.scan) parts.push(`scan: ${entry.scan}`);
  if (entry.pdf) parts.push(`pdf: ${entry.pdf}`);
  if (entry.epub) parts.push(`epub: ${entry.epub}`);
  if (entry.reference) parts.push(`reference: ${entry.reference}`);
  return parts.length ? parts.join(' · ') : null;
}

/**
 * A corpus directory, and the PDF it was minted from.
 *
 * Gathered so a paired book can be recognised in the corpus even when it entered
 * it under a different name — which is the normal case for the books added from
 * the library, whose directories carry the library's project slug.
 */
interface CorpusBookRef {
  dir: string;
  /** When labels.json was last written, or null for a book that has none yet. */
  labelledAt: string | null;
  /** book.json's recorded PDF, resolved. Null for a book that predates book.json. */
  pdfPath: string | null;
  /** That PDF's size, filled in only if a size comparison is actually needed. */
  pdfBytes: number | null | undefined;
}

/** Every corpus directory that is a book at all — book.json or labels.json. */
async function listCorpusBooks(root: string): Promise<CorpusBookRef[]> {
  const books: CorpusBookRef[] = [];
  for (const name of await subdirectories(root)) {
    const dir = path.join(root, name);
    let labelledAt: string | null = null;
    try { labelledAt = (await fsPromises.stat(path.join(dir, 'labels.json'))).mtime.toISOString(); }
    catch { /* not labelled yet — still a book if it has a record */ }
    let pdfPath: string | null = null;
    try {
      const record = JSON.parse(await fsPromises.readFile(path.join(dir, 'book.json'), 'utf-8'));
      if (typeof record?.pdfPath === 'string') pdfPath = path.resolve(record.pdfPath);
    } catch { /* no book.json, or unreadable — the slug/size routes still apply */ }
    if (labelledAt === null && pdfPath === null) continue;
    books.push({ dir, labelledAt, pdfPath, pdfBytes: undefined });
  }
  return books;
}

/**
 * The library project a recorded PDF sits in, or null.
 *
 * `{library}/projects/<id>/archive/<file>.pdf` is where a library book's source
 * lives, and `cli/blocks-detect.js` wants that `<id>` directory — it reads the
 * project's manifest, not the PDF. So the corpus book's own record is what
 * connects a paired book to the project detect can be run against. A PDF
 * anywhere else (the OCR lab's own gold folder, a loose file) has no project and
 * says so by returning null.
 */
function libraryProjectOf(pdfPath: string | null): string | null {
  if (!pdfPath) return null;
  const archive = path.dirname(pdfPath);
  if (path.basename(archive).toLowerCase() !== 'archive') return null;
  const projectDir = path.dirname(archive);
  if (path.basename(path.dirname(projectDir)).toLowerCase() !== 'projects') return null;
  return projectDir;
}

/**
 * Attach label status to a book: is it already in the blocks corpus, and where?
 *
 * Four routes, in order of how much they prove. The slug is the intended layout
 * and is checked first; a recorded PDF at the same PATH is the same file; a
 * recorded PDF of the same SIZE is a copy of it (these PDFs run to tens of
 * megabytes, so an accidental byte-for-byte size collision is not a thing that
 * happens). Last and weakest, a corpus directory whose NAME starts with this
 * book's slug — the case where the same title entered the corpus from the
 * library as a different render, so no file comparison can ever connect them
 * (`for the soul of the people`: 28 MB in the lab, 137 MB in the library).
 *
 * Which route answered is reported, and the directory that answered is named.
 * A match that cannot be explained is a match nobody should trust.
 */
async function resolveCorpusEntry(
  corpusDir: string,
  pdf: PairedFile | null,
  corpusBooks: CorpusBookRef[],
): Promise<Pick<PairedBook,
  'labelled' | 'labelledAt' | 'matchedBy' | 'labelledIn' | 'projectDir'>> {
  const answer = (
    book: CorpusBookRef | null,
    matchedBy: PairedBook['matchedBy'],
  ): Pick<PairedBook, 'labelled' | 'labelledAt' | 'matchedBy' | 'labelledIn' | 'projectDir'> => ({
    labelled: !!book?.labelledAt,
    labelledAt: book?.labelledAt ?? null,
    matchedBy: book ? matchedBy : null,
    labelledIn: book && book.dir !== corpusDir ? book.dir : null,
    projectDir: libraryProjectOf(book?.pdfPath ?? null),
  });

  const bySlug = corpusBooks.find(b => b.dir === corpusDir);
  if (bySlug) return answer(bySlug, 'slug');

  if (pdf?.exists) {
    const target = path.resolve(pdf.path);
    const byPath = corpusBooks.find(b => b.pdfPath === target);
    if (byPath) return answer(byPath, 'recorded-pdf-path');

    for (const book of corpusBooks) {
      if (!book.pdfPath) continue;
      if (book.pdfBytes === undefined) {
        try { book.pdfBytes = (await fsPromises.stat(book.pdfPath)).size; }
        catch { book.pdfBytes = null; }
      }
      if (book.pdfBytes !== null && book.pdfBytes === pdf.bytes) {
        return answer(book, 'recorded-pdf-size');
      }
    }
  }

  const slug = path.basename(corpusDir);
  const byName = corpusBooks.find(b => {
    const name = slugifyBookName(path.basename(b.dir));
    return name === slug || name.startsWith(`${slug}-`);
  });
  if (byName) return answer(byName, 'corpus-dir-name');

  return answer(null, null);
}

/**
 * Every PDF+EPUB pair on this machine, with what is known about it.
 *
 * TWO SOURCES, MERGED, because the pairs really do live in two places and
 * neither is going away:
 *
 *   ocr-lab/gold/<book>/   the staged truth corpus — scan.pdf / source.pdf,
 *                          source.epub, pdfelement.pdf — plus its provenance in
 *                          gold/manifest.json and its run directory beside it.
 *   <corpus>/<slug>/       a corpus book someone dropped both files into.
 *
 * De-duped by slug, lab first: a book present in both is one book, and the lab
 * entry is the one carrying the provenance.
 *
 * NOTHING IS DROPPED FOR BEING BROKEN. A manifest entry whose folder is gone, a
 * folder with no PDF, an EPUB the manifest promises and the disk does not have —
 * each is listed with the reason and the full path, because a book that silently
 * vanishes from a work list is a book nobody ever fixes.
 */
export async function listPairedBooks(
  corpusRoot: string,
  rootPairs: Array<{ slug: string; pdf: string; epub: string }>,
): Promise<PairedBook[]> {
  const labRoot = ocrLabRootDir();
  const goldRoot = path.join(labRoot, 'gold');
  const corpusBooks = await listCorpusBooks(corpusRoot);

  const books: PairedBook[] = [];
  const seen = new Set<string>();

  const goldDirs = await subdirectories(goldRoot);
  const manifest = await readGoldManifest(goldRoot);

  // Run directories, so a gold book can say whether the lab has ever read it.
  // 'gold' itself is not a book.
  const labDirs = (await subdirectories(labRoot)).filter(n => n !== 'gold');
  const claimedLabDirs = new Set<string>();
  const goldSlugs = new Map<string, string>();   // gold folder → slugified name
  for (const name of goldDirs) goldSlugs.set(name, slugifyBookName(name));

  // Exact slug matches first, so `deathstalker` cannot be claimed as the prefix
  // of `deathstalker-coda` before its own book asks for it.
  const labFor = new Map<string, string>();
  for (const [name, slug] of goldSlugs) {
    if (labDirs.includes(slug)) { labFor.set(name, slug); claimedLabDirs.add(slug); }
  }
  // Then the shortened run names (`rise-and-fall` for "rise and fall of the
  // third reich"). Longest wins; a tie is ambiguous and matches nothing.
  for (const [name, slug] of goldSlugs) {
    if (labFor.has(name)) continue;
    const candidates = labDirs
      .filter(d => !claimedLabDirs.has(d) && (slug.startsWith(`${d}-`) || d.startsWith(`${slug}-`)))
      .sort((a, b) => b.length - a.length);
    if (candidates.length === 1 || (candidates.length > 1 && candidates[0].length !== candidates[1].length)) {
      labFor.set(name, candidates[0]);
      claimedLabDirs.add(candidates[0]);
    }
  }

  for (const name of goldDirs) {
    const dir = path.join(goldRoot, name);
    const entry = manifest?.entries.get(name.toLowerCase());
    const labDirName = labFor.get(name) ?? null;
    const slug = labDirName ?? goldSlugs.get(name)!;
    const problems: string[] = [];

    if (!manifest) {
      problems.push(`No ${path.join(goldRoot, 'manifest.json')} — provenance unknown for every book here.`);
    } else if (manifest.error) {
      problems.push(`gold/manifest.json could not be read: ${manifest.error}`);
    } else if (!entry) {
      problems.push(`No entry for "${name}" in ${path.join(goldRoot, 'manifest.json')} — quality and truth tier unknown.`);
    }

    const files = await readdirSafe(dir);
    if (files === null) {
      problems.push(`Could not read ${dir}.`);
    }
    const real = (files ?? []).filter(f => !f.startsWith('.') && !f.startsWith('._'));

    // scan.pdf / source.pdf are the lab's names; pdfelement.pdf is never the
    // scan — it is the OCR-derived reference and is reported separately.
    const pdfName =
      real.find(f => f.toLowerCase() === 'scan.pdf') ??
      real.find(f => f.toLowerCase() === 'source.pdf') ??
      real.find(f => f.toLowerCase().endsWith('.pdf') && f.toLowerCase() !== 'pdfelement.pdf') ??
      null;
    const epubName = real.find(f => f.toLowerCase().endsWith('.epub')) ?? null;
    const referenceName = real.find(f => f.toLowerCase() === 'pdfelement.pdf') ?? null;

    const pdf = pdfName ? await pairedFile(path.join(dir, pdfName)) : null;
    const epub = epubName ? await pairedFile(path.join(dir, epubName)) : null;
    const reference = referenceName ? await pairedFile(path.join(dir, referenceName)) : null;

    if (!pdf) problems.push(`No PDF in ${dir} — nothing to label or render.`);
    // A missing EPUB is only a fault when the manifest says there is one. The
    // tier-3 books genuinely have none and carry a PDFelement reference instead,
    // and calling that "missing" would be crying wolf on three of nineteen books.
    if (!epub && entry?.epub) {
      problems.push(`gold/manifest.json records an EPUB for "${name}" but ${dir} holds none.`);
    }
    if (!epub && !entry?.epub && !reference) {
      problems.push(`No EPUB and no PDFelement reference in ${dir} — this book has no truth to compare against.`);
    }

    books.push({
      slug,
      title: name,
      source: 'ocr-lab',
      goldDir: dir,
      labDir: labDirName ? path.join(labRoot, labDirName) : null,
      pdf, epub, reference,
      truthTier: typeof entry?.truthTier === 'number' ? entry.truthTier : null,
      quality: qualityOf(entry),
      notes: entry?.notes ?? null,
      corpusDir: path.join(corpusRoot, slug),
      ...(await resolveCorpusEntry(path.join(corpusRoot, slug), pdf, corpusBooks)),
      problems,
    });
    seen.add(slug);
  }

  // A manifest entry whose folder is not there at all: the provenance survived
  // and the files did not, which is worth more noise than less.
  for (const [key, entry] of manifest?.entries ?? []) {
    if (goldDirs.some(name => name.toLowerCase() === key)) continue;
    const slug = slugifyBookName(key);
    if (seen.has(slug)) continue;
    books.push({
      slug, title: key, source: 'ocr-lab',
      goldDir: null, labDir: null, pdf: null, epub: null, reference: null,
      truthTier: typeof entry.truthTier === 'number' ? entry.truthTier : null,
      quality: qualityOf(entry), notes: entry.notes ?? null,
      corpusDir: path.join(corpusRoot, slug),
      ...(await resolveCorpusEntry(path.join(corpusRoot, slug), null, corpusBooks)),
      problems: [`gold/manifest.json lists "${key}" but ${path.join(goldRoot, key)} does not exist.`],
    });
    seen.add(slug);
  }

  // Books genuinely placed in the corpus root still count. Merged, not replaced.
  for (const pair of rootPairs) {
    if (seen.has(pair.slug)) continue;
    const pdf = await pairedFile(pair.pdf);
    const epub = await pairedFile(pair.epub);
    books.push({
      slug: pair.slug, title: pair.slug, source: 'corpus-root',
      goldDir: null, labDir: null, pdf, epub, reference: null,
      truthTier: null, quality: null, notes: null,
      corpusDir: path.join(corpusRoot, pair.slug),
      ...(await resolveCorpusEntry(path.join(corpusRoot, pair.slug), pdf, corpusBooks)),
      problems: [],
    });
    seen.add(pair.slug);
  }

  // Unlabelled first — the list is a work queue — then tier (exact truth is
  // worth labelling before OCR-derived truth), then name for a stable position.
  return books.sort((a, b) =>
    (a.labelled ? 1 : 0) - (b.labelled ? 1 : 0) ||
    (a.truthTier ?? 9) - (b.truthTier ?? 9) ||
    a.title.localeCompare(b.title)
  );
}

/** Inventory footnotes and ocr. Blocks books come from `listTrainingBooks`. */
export async function listTrainingCorpora(): Promise<TrainingCorpora> {
  const root = trainingRootDir();
  const [footnotes, ocr] = await Promise.all([listFootnotes(root), listOCR(root)]);
  return { footnotes, ocr };
}
