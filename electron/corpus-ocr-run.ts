/**
 * corpus-ocr-run — an OCR pass over a training book that outlives the window.
 *
 * This is the same fix `rubric-run.ts` made for Detect, for the same reason.
 * OCR was a `for` loop in the renderer: the modal rendered each page, called
 * Tesseract, and held every result in memory until the last page, at which
 * point it handed the lot over to be written. That made the renderer the run's
 * owner, and the renderer is the part of the app that gets thrown away — an
 * `ng serve` reload, a closed window, a crash on page 400 and thirty minutes of
 * a 532-page book was gone with nothing on disk to show for it.
 *
 * It also could not be paused. "Continue in background" cancelled the loop and
 * started a SECOND run over the remaining pages, which is why the progress
 * counter restarted from zero — and, worse, why the results were split into two
 * batches. See the global-context note below for what that cost.
 *
 * So a run lives here, in main:
 *
 *   start    begin (or resume) a run over a book; returns immediately
 *   attach   "is there a run for this book?" -> current state
 *   cancel   stop it; everything already recognized stays on disk
 *
 * Minimizing the panel is then nothing but hiding a window. Nothing restarts,
 * nothing is re-recognized, and the counter keeps counting because it is
 * reporting the run's progress rather than some window's.
 *
 * ── THE JOURNAL, and why blocks are not written page by page ────────────────
 *
 * The obvious design — recognize a page, classify it, append it to blocks.json —
 * is wrong, and measurably so. `processOcrPageResults` runs a GLOBAL pass before
 * it classifies anything: the body font size is the mode across every page in
 * the document, deliberately, so that a title page full of 40pt type cannot
 * drag the baseline. Feed it one page and "global" means that page.
 *
 * That is not theoretical. Splitting a real book's run at page 4 left the first
 * four pages classified against a four-page document: same 38 blocks, same
 * geometry, same font sizes, three different categories.
 *
 * So the durable per-page record is RAW RECOGNITION — Tesseract's lines and
 * paragraphs, before any classification — appended to `ocr-journal.jsonl` as
 * each page lands. blocks.json is then DERIVED from the whole journal, every
 * time, so it is always the product of one global pass over everything known so
 * far. Recognition is the expensive half (~3.5s/page); classification over
 * already-recognized lines is milliseconds, so rebuilding the whole book's
 * blocks after every page is affordable and keeps blocks.json continuously
 * correct rather than correct-only-at-the-end.
 *
 * The journal is append-only JSONL: a crash can lose at most the line being
 * written, never the file. It also makes re-classification free — if the
 * post-processor improves, blocks can be rebuilt without re-running Tesseract.
 *
 * Resume reads the journal, subtracts the pages already in it from the pages
 * asked for, and recognizes only the difference. Gaps in the middle are just
 * pages not in the set, so a book OCR'd 0-99 and 200-299 resumes by doing
 * 100-199 and nothing else.
 */
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import { getHeadlessOcrService, HeadlessOcrPageResult } from './headless-ocr';
import { processOcrPageResults } from '../shared/ocr/ocr-post-processing';
import type { PageDimension } from '../shared/ocr/text-block';
import { claimBookForOcr, writeTrainingBlocksFile, loadCorpusBook } from './corpus-book';

/** One page of raw recognition, as it is stored in the journal. */
interface JournalPage {
  page: number;
  text: string;
  confidence: number;
  textLines?: HeadlessOcrPageResult['textLines'];
  paragraphs?: HeadlessOcrPageResult['paragraphs'];
  pageWidth?: number;
  pageHeight?: number;
  /** ISO time this page was recognized, for reading the file by eye. */
  at: string;
}

export interface CorpusOcrRunState {
  bookDir: string;
  status: 'running' | 'done' | 'cancelled' | 'error';
  /** Pages this run was asked to cover. */
  requested: number;
  /** Pages of `requested` already recognized, including ones a previous run did. */
  done: number;
  /** Pages in the book, so the UI can say "412 of 532" rather than "of 335". */
  bookPages: number;
  /** Pages of the whole book present in the journal. */
  journalPages: number;
  currentPage: number | null;
  startedAt: number;
  error?: string;
}

export interface CorpusOcrRunStart {
  bookDir: string;
  engine: string;
  language?: string;
  /** Pages to cover, zero-based. Omitted means the whole book. */
  pages?: number[];
  /**
   * Re-recognize pages the journal already has. Off by default — the point of
   * the journal is that a resumed run does not redo work.
   */
  redo?: boolean;
  concurrency?: number;
  /** Accept orphaning the labels of a book that has been marked reviewed. */
  force?: boolean;
}

const JOURNAL_FILE = 'ocr-journal.jsonl';

interface ActiveRun {
  state: CorpusOcrRunState;
  cancelled: boolean;
  /** Resolves when the run has stopped, however it stopped. */
  finished: Promise<void>;
}

/** At most one run per book. Keyed by resolved corpus directory. */
const runs = new Map<string, ActiveRun>();

type ProgressListener = (state: CorpusOcrRunState) => void;
const listeners = new Set<ProgressListener>();

export function onCorpusOcrProgress(listener: ProgressListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(state: CorpusOcrRunState): void {
  for (const listener of listeners) {
    try {
      listener({ ...state });
    } catch (err) {
      console.error('[corpus-ocr] progress listener threw:', err);
    }
  }
}

function journalPath(dir: string): string {
  return path.join(dir, JOURNAL_FILE);
}

/**
 * Read the journal, keeping the LAST entry for any page written more than once.
 *
 * Re-recognizing a page appends rather than rewriting — an append cannot corrupt
 * the file, a rewrite can — so duplicates are expected and the newest wins.
 * A truncated final line (killed mid-write) is dropped, which is the whole
 * reason this format was chosen over a JSON array.
 */
export async function readOcrJournal(dir: string): Promise<Map<number, JournalPage>> {
  const file = journalPath(dir);
  let raw: string;
  try {
    raw = await fsPromises.readFile(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw err;
  }

  const pages = new Map<number, JournalPage>();
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: JournalPage;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Only the final line may be a torn write. Anything earlier means the file
      // is damaged in a way that would silently drop recognized pages, so say so.
      if (i === lines.length - 1 || lines.slice(i + 1).every(l => !l.trim())) {
        console.warn(`[corpus-ocr] ${file}: dropping torn final line (${line.length} bytes)`);
        continue;
      }
      throw new Error(
        `${file} line ${i + 1} is not valid JSON, and it is not the last line — the journal is ` +
        'damaged. Move it aside and re-run OCR rather than losing pages silently.'
      );
    }
    if (typeof parsed.page !== 'number') {
      throw new Error(`${file} line ${i + 1} has no page number.`);
    }
    pages.set(parsed.page, parsed);
  }
  return pages;
}

async function appendJournal(dir: string, entry: JournalPage): Promise<void> {
  await fsPromises.appendFile(journalPath(dir), JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Rebuild blocks.json from every page the journal holds.
 *
 * Whole-journal, never incremental: see the global-context note at the top.
 */
async function rebuildBlocks(
  dir: string,
  journal: Map<number, JournalPage>,
  pageDimensions: PageDimension[],
  sourceFile: string,
  engine: string,
): Promise<number> {
  const results = [...journal.values()]
    .sort((a, b) => a.page - b.page)
    .map(p => ({ page: p.page, text: p.text, confidence: p.confidence, textLines: p.textLines ?? [] }));

  const processed = processOcrPageResults(results, pageDimensions);
  if (processed.blocks.length === 0) return 0;

  const written = await writeTrainingBlocksFile(dir, {
    blocks: processed.blocks,
    pageDimensions,
    sourceFile,
    ocrEngine: engine,
  });
  return written.blocks;
}

/**
 * Page sizes in POINTS for the whole book, indexed by page.
 *
 * `processOcrPageResults` refuses a page it has no dimension for, and a resumed
 * run classifies pages it did not itself recognize, so this must cover the book
 * rather than only the pages in flight.
 */
async function bookPageDimensions(pdfPath: string, pageCount: number): Promise<PageDimension[]> {
  const service = getHeadlessOcrService();
  const all = Array.from({ length: pageCount }, (_, i) => i);
  const sizes = await service.getPageSizes(pdfPath, all);
  const dims: PageDimension[] = [];
  for (let i = 0; i < pageCount; i++) {
    const size = sizes.get(i);
    if (!size) {
      throw new Error(`Could not read the size of page ${i + 1} of ${pdfPath}; blocks cannot be placed.`);
    }
    dims.push({ width: size.width, height: size.height });
  }
  return dims;
}

export function attachCorpusOcrRun(bookDir: string): CorpusOcrRunState | null {
  const run = runs.get(path.resolve(bookDir));
  return run ? { ...run.state } : null;
}

export async function cancelCorpusOcrRun(bookDir: string): Promise<void> {
  const key = path.resolve(bookDir);
  const run = runs.get(key);
  if (!run) return;
  run.cancelled = true;
  await run.finished;
}

/**
 * Start (or resume) a run. Returns as soon as the run is registered; progress
 * arrives through `onCorpusOcrProgress` and the final state through `attach`.
 */
export async function startCorpusOcrRun(opts: CorpusOcrRunStart): Promise<CorpusOcrRunState> {
  const book = await loadCorpusBook(opts.bookDir);
  const dir = book.dir;
  const key = path.resolve(dir);

  const existing = runs.get(key);
  if (existing && existing.state.status === 'running') {
    throw new Error(
      `OCR is already running on ${path.basename(dir)} (${existing.state.done} of ` +
      `${existing.state.requested} pages). Attach to it rather than starting a second run.`
    );
  }

  const service = getHeadlessOcrService();
  const pdfPath = book.pdfPath;
  const bookPages = await service.getPageCount(pdfPath);
  if (bookPages <= 0) {
    throw new Error(`${pdfPath} reports ${bookPages} pages; there is nothing to OCR.`);
  }

  const requested = opts.pages && opts.pages.length > 0
    ? [...new Set(opts.pages)].sort((a, b) => a - b)
    : Array.from({ length: bookPages }, (_, i) => i);

  for (const p of requested) {
    if (p < 0 || p >= bookPages) {
      throw new Error(`Page ${p + 1} is outside ${path.basename(pdfPath)}, which has ${bookPages} pages.`);
    }
  }

  const journal = await readOcrJournal(dir);
  const todo = opts.redo ? requested : requested.filter(p => !journal.has(p));

  // Once per run, not once per flush: moving labels aside is a judgement about
  // the run, and doing it on every write would mint a new orphan file per page.
  await claimBookForOcr(dir, { force: opts.force });

  const pageDimensions = await bookPageDimensions(pdfPath, bookPages);

  const state: CorpusOcrRunState = {
    bookDir: dir,
    status: 'running',
    requested: requested.length,
    done: requested.length - todo.length,
    bookPages,
    journalPages: journal.size,
    currentPage: null,
    startedAt: Date.now(),
  };

  console.log(`[corpus-ocr] ${path.basename(dir)}: ${todo.length} page(s) to recognize`
    + ` (${state.done} already in the journal, ${bookPages} in the book)`);

  if (todo.length === 0) {
    // Nothing to recognize, but the journal may predate the current
    // post-processor, so blocks.json is still rebuilt from it.
    if (journal.size > 0) {
      await rebuildBlocks(dir, journal, pageDimensions, pdfPath, opts.engine);
    }
    state.status = 'done';
    runs.set(key, { state, cancelled: false, finished: Promise.resolve() });
    emit(state);
    return { ...state };
  }

  const run: ActiveRun = { state, cancelled: false, finished: Promise.resolve() };
  runs.set(key, run);
  emit(state);

  run.finished = (async () => {
    try {
      await service.processPdf(pdfPath, {
        engine: opts.engine,
        language: opts.language,
        pages: todo,
        concurrency: opts.concurrency,
        // The journal is the record; holding a second copy of the book's lines in
        // memory for a return value nobody reads is the memory cost this design
        // exists to remove.
        collect: false,
        shouldStop: () => run.cancelled,
        onPage: async (result) => {
          await appendJournal(dir, {
            page: result.page,
            text: result.text,
            confidence: result.confidence,
            textLines: result.textLines,
            paragraphs: result.paragraphs,
            pageWidth: result.pageWidth,
            pageHeight: result.pageHeight,
            at: new Date().toISOString(),
          });
          journal.set(result.page, {
            page: result.page,
            text: result.text,
            confidence: result.confidence,
            textLines: result.textLines,
            paragraphs: result.paragraphs,
            pageWidth: result.pageWidth,
            pageHeight: result.pageHeight,
            at: '',
          });

          // Every page, so a run killed at any moment leaves a blocks.json that
          // agrees with the journal. Classification over already-recognized
          // lines is cheap next to the ~3.5s the recognition itself cost.
          await rebuildBlocks(dir, journal, pageDimensions, pdfPath, opts.engine);

          state.done++;
          state.journalPages = journal.size;
          state.currentPage = result.page;
          emit(state);
        },
      });
      state.status = run.cancelled ? 'cancelled' : 'done';
    } catch (err) {
      state.status = 'error';
      state.error = err instanceof Error ? err.message : String(err);
      console.error(`[corpus-ocr] ${path.basename(dir)} failed:`, err);
    } finally {
      state.currentPage = null;
      emit(state);
    }
  })();

  return { ...state };
}

/**
 * Rebuild blocks.json from an existing journal without recognizing anything.
 *
 * The reason the journal stores raw recognition: when the post-processor
 * changes, every book that has one can be re-derived in seconds instead of
 * re-running Tesseract over the whole corpus.
 */
export async function rebuildBlocksFromJournal(bookDir: string, engine = 'tesseract'): Promise<number> {
  const book = await loadCorpusBook(bookDir);
  const journal = await readOcrJournal(book.dir);
  if (journal.size === 0) {
    throw new Error(`${path.basename(book.dir)} has no ${JOURNAL_FILE}; there is nothing to rebuild from.`);
  }
  const service = getHeadlessOcrService();
  const bookPages = await service.getPageCount(book.pdfPath);
  const dims = await bookPageDimensions(book.pdfPath, bookPages);
  return rebuildBlocks(book.dir, journal, dims, book.pdfPath, engine);
}

/** Present so a test can start from a known state. */
export function __resetCorpusOcrRunsForTest(): void {
  runs.clear();
}

/** Does this book have a journal, and how much of it? */
export async function corpusOcrJournalSummary(dir: string): Promise<{ pages: number[]; exists: boolean }> {
  const journal = await readOcrJournal(dir);
  return { exists: fs.existsSync(journalPath(dir)), pages: [...journal.keys()].sort((a, b) => a - b) };
}
