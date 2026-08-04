/**
 * document-stages — the pipeline's stages, as transformations of one document.
 *
 * The rule (docs/DOCUMENT_PIPELINE.md): **every stage is document-in →
 * document-out.** A stage ends by writing a real file in the project folder that
 * any external tool can open, and the next stage reads that file. This module
 * sequences those file transformations; it keeps no pipeline state, and there is
 * nothing here for a later step to "apply".
 *
 *   Get Text   archive/<Original>.pdf → <Original>.working.pdf
 *              A scan: Tesseract over page renders, then the recognized lines
 *              written back as a real invisible text layer. A text PDF: the
 *              publisher's own layer read in one pass. Either way the working
 *              document comes out carrying its words, selectable in any reader.
 *   Blocks     working.pdf → working.pdf + one /Square annotation per block.
 *              Open it in Acrobat and the boxes are there, coloured and named.
 *   Footnotes  working.pdf → working.pdf with the markers gone from its text
 *              layer. (Scanned class only — foundry refuses to re-lay-out a
 *              publisher's page description from a parse of it.)
 *   Reflow     working.pdf → <Original>.epub. The one exporter.
 *
 * Every stage after Get Text is a PDF INCREMENTAL UPDATE, so it appends and
 * moves nothing. That is what makes a stage completion a byte offset — recorded
 * in the binding here, and truncated back to by `resetDocumentTo`.
 *
 * ── How a boundary is obtained ──────────────────────────────────────────────
 *
 * By stat'ing the working document after foundry exits. Not by parsing a number
 * out of foundry's output, and not because that would be harder: it would be
 * WORSE. foundry builds each update completely in memory, writes it in one
 * positional write at the old end, fsyncs, and truncates back to where it
 * started if any part of that throws (`appendUpdate`, foundry src/pdf/document.ts).
 * So when the process exits zero the file's length IS the boundary, and it is
 * the boundary as the filesystem has it rather than as a program said it would
 * be. A reported offset could disagree with the file; a measured one cannot.
 *
 * ── The scratch run directory ───────────────────────────────────────────────
 *
 * foundry's `blocks` stage still reads the scan's line geometry out of a run
 * directory (its own docs/DOCUMENT_MODES.md, "Known limits"), so one exists —
 * but it is SCRATCH, not state. Nothing here reads a stage status out of it,
 * nothing persists a BookForge record into it, and its location is DERIVED from
 * the original's sha256 rather than remembered. A book re-imported with
 * different bytes therefore gets a different directory without anything having
 * to notice; a scratch directory that has been cleaned away is an error naming
 * the stage that writes it, which is Get Text.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  ensureFoundryPath,
  foundryVersion,
  runFoundry,
} from './foundry-bridge';
import {
  boundaryFor,
  createDocumentBinding,
  documentBindingPath,
  reconcileBoundaries,
  recordExportedEpub,
  recordStageBoundary,
  readDocumentBinding,
  resetToStage,
  verifyPrimary,
  workingDocumentPath,
  writeDocumentBinding,
  type DocumentBinding,
  type DocumentStage,
  type ResetTarget,
} from './document-binding';
import {
  readWorkingDocumentState,
  type DocumentClass,
  type WorkingDocumentState,
} from './working-document';
import { FOUNDRY_CATEGORY_IDS, blockCategoryColor } from '../shared/ocr/block-categories';

/**
 * The dpi foundry's Tesseract is pinned at.
 *
 * Not configurable and not read from anywhere else: the three models were
 * trained against this Tesseract's segmentation at this resolution, and a
 * different number changes how lines and paragraphs come out without erroring
 * anywhere.
 */
export const FOUNDRY_DPI = 200;

/** The documents of one book, and where they live. */
export interface DocumentProject {
  /** The manifest project's folder slug. */
  projectId: string;
  /** Absolute path to the project directory. */
  projectDir: string;
  /**
   * The archive original, project-relative and slash-separated —
   * `archive/<Original>.pdf`. Immutable: nothing in this module writes to it,
   * and every stage re-proves it has not moved.
   */
  primaryRelPath: string;
}

export interface DocumentStageProgress {
  stage: DocumentStage | 'reflow' | 'render';
  /** foundry's own most recent line, verbatim. */
  message: string;
  done: number;
  total: number;
}

export interface DocumentStageOptions {
  project: DocumentProject;
  signal?: AbortSignal;
  onProgress?: (progress: DocumentStageProgress) => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

export function primaryAbsPath(project: DocumentProject): string {
  return path.join(project.projectDir, project.primaryRelPath.split('/').join(path.sep));
}

export function workingAbsPath(project: DocumentProject): string {
  return workingDocumentPath(project.projectDir, project.primaryRelPath);
}

export function bindingAbsPath(project: DocumentProject): string {
  return documentBindingPath(project.projectDir, project.primaryRelPath);
}

/**
 * Where foundry's scan artifacts go — MACHINE-LOCAL, like the page render cache
 * and for the same reason: the library folder is Syncthing-synced and this is
 * hundreds of megabytes of page rasters and intermediate JSON that mean nothing
 * on another machine. Only the working document and the book go in the project.
 *
 * Keyed by the ORIGINAL's hash, so the name is derived rather than recorded and
 * two books can never share one.
 */
export function documentScratchDir(primarySha256: string): string {
  return path.join(
    os.homedir(), 'Documents', 'BookForge', 'foundry-runs', `doc-${primarySha256.slice(0, 16)}`
  );
}

function scratchPagesDir(scratchDir: string): string {
  return path.join(scratchDir, 'pages');
}

// ─────────────────────────────────────────────────────────────────────────────
// Talking to foundry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pull an `n/total` out of a foundry progress line.
 *
 * foundry writes progress to stderr in one shape across stages — `page 3/50`,
 * `ocr: 100/2120 lines` — so one regex serves them all. The LAST pair on the
 * line wins, because `page 1/2: 20/20 blocks labelled` carries the page counter
 * first and the interesting number second. A line with no pair still becomes the
 * message: those are the lines that explain a run, and dropping them for lack of
 * a number would hide the one saying a book's paragraph convention is DEGRADED.
 */
export function parseProgress(line: string): { done: number; total: number } | null {
  const matches = [...line.matchAll(/(\d+)\s*\/\s*(\d+)/g)];
  const last = matches[matches.length - 1];
  if (!last) return null;
  const done = Number(last[1]);
  const total = Number(last[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return { done, total };
}

/**
 * VRAM needed to run foundry's model stages fully on the GPU, in MB.
 *
 * foundry's `-ngl` policy is all-or-none (a partial offload of a 4B spends PCIe
 * traffic per token to save little), and it leaves the number to the caller
 * "because only the caller knows what probing was done". This is that probing.
 * The working set is knowable because the weights are foundry's own catalog:
 * base f16 ~7.7 GB, adapter <=130 MB, KV cache at foundry's 16K context ~2.4 GB,
 * plus compute buffers and whatever the desktop is holding. Under-budgeting does
 * not error — NVIDIA's sysmem fallback silently spills over PCIe and generation
 * crawls — so the number errs high, and a machine under it runs on CPU exactly
 * as if it had no GPU.
 */
const FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB = 12000;

/**
 * The arguments EVERY model stage carries: the llama-server this app ships, and
 * — when this machine's GPU holds foundry's whole working set — the
 * `--gpu-layers` that says to use it.
 *
 * The offload flag is BookForge's to send. foundry defaults `-ngl` to 99 on
 * Apple Silicon (unified memory) and 0 everywhere else, deferring to the
 * caller's probing; a caller that sends nothing has therefore chosen CPU
 * inference, and a 4B f16 on CPU turned one book's OCR stage into a 23-hour ETA
 * on a machine with a 24 GB GPU sitting idle. On darwin nothing is sent, because
 * foundry's own default is already the right call there.
 *
 * Exported because a foundry model stage is not always a stage of the document
 * pipeline: `foundry footnotes --epub` is the same binary and the same server
 * pointed at a finished book.
 */
export async function foundryLlamaServerArgs(): Promise<string[]> {
  const { resolveLlamaServerBinary } =
    require('./llama-bridge') as typeof import('./llama-bridge');
  const llamaServer = resolveLlamaServerBinary();
  if (!llamaServer) {
    throw new Error(
      'foundry needs a llama-server binary to run its model stages, and BookForge could not '
      + 'find the one it ships (resources/bin/llama-server*). Reinstall the app, or run '
      + '`npm run download:llama` in a dev checkout.'
    );
  }
  const args = ['--llama-server', llamaServer];
  if (process.platform === 'darwin') return args;

  const { systemProbe } =
    require('./components/system-probe') as typeof import('./components/system-probe');
  const prof = await systemProbe.profile();
  const vramMB = prof.cuda.available ? prof.cuda.vramMB : undefined;
  if (vramMB !== undefined && vramMB >= FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB) {
    args.push('--gpu-layers', '99');
    console.log(
      `[foundry] llama-server offload: full (${vramMB} MB VRAM holds the `
      + `~${FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB} MB working set)`
    );
  } else if (prof.cuda.available) {
    console.log(
      `[foundry] llama-server offload: none — CPU inference `
      + `(VRAM ${vramMB === undefined ? 'unreadable' : `${vramMB} MB`}, `
      + `working set needs ~${FOUNDRY_FULL_OFFLOAD_MIN_VRAM_MB} MB)`
    );
  } else {
    console.log('[foundry] llama-server offload: none — CPU inference (no CUDA GPU)');
  }
  return args;
}

/** The foundry build in use, asked once per process — every stage records it. */
let cachedFoundryVersion: string | null = null;
async function resolvedFoundryVersion(): Promise<string> {
  if (cachedFoundryVersion === null) cachedFoundryVersion = (await foundryVersion()).version;
  return cachedFoundryVersion;
}

async function invokeFoundry(
  stage: DocumentStageProgress['stage'],
  args: string[],
  opts: DocumentStageOptions
): Promise<void> {
  const started = Date.now();
  const result = await runFoundry(args, {
    signal: opts.signal,
    onProgress: (line) => {
      const progress = parseProgress(line);
      opts.onProgress?.({
        stage,
        message: line.trim(),
        done: progress?.done ?? 0,
        total: progress?.total ?? 0,
      });
    },
  });
  if (result.code !== 0) {
    // foundry's stderr IS the message a user needs — every throw in that program
    // is written to name the missing thing. Never summarized.
    throw new Error(
      `foundry ${stage} failed (exit ${result.code}):\n${(result.stderr || result.stdout).trim()}`
    );
  }
  console.log(`[document-stages] ${stage} finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

/**
 * The category colours, written where foundry can read them.
 *
 * `shared/ocr/block-categories.ts` is the ONE palette in this app, and foundry's
 * `--palette` exists precisely so it does not have to be a second one: a block
 * is the same colour in the picker and in the PDF a user opens in Acrobat.
 * `table` is excluded because foundry's exporter has no rule for it.
 */
function writePaletteFile(scratchDir: string): string {
  const palette: Record<string, string> = {};
  for (const id of FOUNDRY_CATEGORY_IDS) palette[id] = blockCategoryColor(id);
  const file = path.join(scratchDir, 'bookforge-palette.json');
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(palette, null, 2)}\n`);
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the state — off the document, never off a record of it
// ─────────────────────────────────────────────────────────────────────────────

export interface DocumentPipelineState {
  binding: DocumentBinding | null;
  /** Null when no working document has been cast. */
  working: WorkingDocumentState | null;
  /** From the working document's own marker. Null before the cast. */
  documentClass: DocumentClass | null;
  stages: {
    /** A working document exists, carries a marker, and it names THIS original. */
    getText: boolean;
    /** It carries a block layer. */
    blocks: boolean;
    /** A footnotes boundary is recorded — the only stage whose work is invisible. */
    footnotes: boolean;
    /** The binding vouches for a book that is still on disk. */
    reflow: boolean;
  };
}

/**
 * What has happened to this book's documents, read off the documents.
 *
 * Three of the four stages are answered by the file itself: a marker means Get
 * Text has run, block annotations mean Blocks has, and a book on disk that the
 * binding vouches for means Reflow has. Only Footnotes needs the binding, and it
 * needs it because its work is a rewrite of an invisible text layer — there is
 * nothing to count. That is the one place a recorded boundary is the evidence
 * rather than a convenience.
 *
 * A working document whose marker names a DIFFERENT original is not this book's
 * working document, and every stage reads as un-run rather than as done. Silently
 * reflowing it would build one book out of another one's pages.
 */
export async function readDocumentPipelineState(
  project: DocumentProject
): Promise<DocumentPipelineState> {
  const workingPath = workingAbsPath(project);
  const bindingPath = bindingAbsPath(project);
  // Throws when the record is there and unreadable — see readDocumentBinding.
  let binding = readDocumentBinding(bindingPath);

  if (!fs.existsSync(workingPath)) {
    return {
      binding,
      working: null,
      documentClass: null,
      stages: { getText: false, blocks: false, footnotes: false, reflow: false },
    };
  }

  const working = await readWorkingDocumentState(workingPath);
  if (binding) {
    const reconciled = reconcileBoundaries(binding, working.bytes);
    if (reconciled.dropped.length > 0) {
      binding = reconciled.binding;
      await writeDocumentBinding(bindingPath, binding);
    }
  }

  const castMatchesThisBook =
    binding !== null && binding.primary.sha256 === working.marker.sourceSha256;
  if (binding !== null && !castMatchesThisBook) {
    console.warn(
      `[document-stages] ${workingPath} was cast from ${working.marker.sourceSha256}, and this `
      + `project's archive original is ${binding.primary.sha256}. Reading every stage as not having `
      + 'run: it is a working document, but not this book\'s.'
    );
  }

  const epubAbs = binding?.epub
    ? path.join(project.projectDir, binding.epub.path.split('/').join(path.sep))
    : null;

  return {
    binding,
    working,
    documentClass: working.marker.documentClass,
    stages: {
      getText: castMatchesThisBook,
      blocks: castMatchesThisBook && working.blockCount > 0,
      footnotes: castMatchesThisBook && binding !== null && boundaryFor(binding, 'footnotes') !== null,
      reflow: castMatchesThisBook && epubAbs !== null && fs.existsSync(epubAbs),
    },
  };
}

/**
 * The binding a stage after the cast requires, with the archive original
 * re-proved.
 *
 * Every failure here names the stage that writes what is missing, because that
 * is the only useful thing to say: a missing input is never a reason to invent
 * one, and it is never a reason to fall back to whatever else is on disk.
 */
async function requireCastBinding(
  project: DocumentProject,
  stage: string
): Promise<{ binding: DocumentBinding; bindingPath: string; workingPath: string }> {
  const bindingPath = bindingAbsPath(project);
  const binding = readDocumentBinding(bindingPath);
  if (!binding) {
    throw new Error(
      `The ${stage} stage reads this book's working document, and none has been cast for it. `
      + 'Run Get Text — it is what turns the archive original into a working document.'
    );
  }
  const workingPath = workingAbsPath(project);
  if (!fs.existsSync(workingPath)) {
    throw new Error(
      `The ${stage} stage reads ${workingPath}, and it is not there — although this book has a `
      + 'binding record that says it was cast. Run Get Text to cast it again from the archive '
      + 'original, which is untouched.'
    );
  }
  await verifyPrimary(binding, project.projectDir);
  return { binding, bindingPath, workingPath };
}

/** Record the boundary a stage just made, and land the binding. */
async function landBoundary(
  project: DocumentProject,
  binding: DocumentBinding,
  bindingPath: string,
  stage: DocumentStage
): Promise<DocumentBinding> {
  const updated = await recordStageBoundary({
    binding,
    projectDir: project.projectDir,
    stage,
    foundryVersion: await resolvedFoundryVersion(),
  });
  await writeDocumentBinding(bindingPath, updated);
  console.log(
    `[document-stages] ${stage} boundary for ${project.projectId}: ${updated.working.bytes} bytes`
  );
  return updated;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Get Text — the cast
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which pipeline this PDF belongs to, MEASURED.
 *
 * `pdf-analyzer` samples pages and counts the characters the document's own text
 * layer yields. A book that carries text is read through it; one that does not
 * is read by Tesseract. Nothing is assumed from the filename, the producer
 * string or how the file got here — the two answers send a model over somebody's
 * prose or leave it alone, and that decision is worth a measurement.
 */
export async function measureDocumentClass(pdfPath: string): Promise<DocumentClass> {
  const { pdfAnalyzer } = require('./pdf-analyzer') as typeof import('./pdf-analyzer');
  const report = await pdfAnalyzer.measureTextLayer(pdfPath);
  return report.hasTextLayer ? 'text' : 'scanned';
}

/**
 * Cast the archive original into `<Original>.working.pdf`.
 *
 * Two routes, one output shape:
 *
 *  - **text** — `foundry scan --pdf` reads the publisher's own layer and casts
 *    the working document in the same pass. There is nothing to decide between
 *    "read it" and "make this the working document"; the text is already there.
 *  - **scanned** — every page is rendered at the pinned dpi, `foundry scan
 *    --pages` runs Tesseract over the renders, and `foundry get-text` writes the
 *    recognized lines back into the PDF as a real invisible text layer. The
 *    tangible test is that `working.pdf` opens in any reader and the text
 *    selects.
 *
 * EVERY PAGE, always. The working document is the book, so a page subset would
 * make it a different book — and foundry refuses a text layer whose scan does
 * not cover the document page for page, because a scan of the same book with its
 * cover stripped would put every page's words on some other page.
 *
 * Casting REPLACES whatever working document was there. That is the honest
 * reading of a person asking to read the pages again: handing them this
 * morning's document would answer a different question than the one they asked,
 * silently and instantly, which reads as success.
 */
export async function runGetTextStage(
  opts: DocumentStageOptions
): Promise<{ binding: DocumentBinding; documentClass: DocumentClass }> {
  const { project } = opts;
  const primary = primaryAbsPath(project);
  if (!fs.existsSync(primary)) {
    throw new Error(
      `The archive original is not at ${primary}. Get Text casts the working document from it, and `
      + 'there is nothing to cast.'
    );
  }
  await ensureFoundryPath();

  const { sha256File } = require('./sidecar-binding') as typeof import('./sidecar-binding');
  const { sha256 } = await sha256File(primary);
  const scratchDir = documentScratchDir(sha256);
  const workingPath = workingAbsPath(project);
  const documentClass = await measureDocumentClass(primary);

  // The scan is the text base every later artifact stands on — line ids, blocks,
  // the annotations' geometry — so a re-cast starts the scratch directory over
  // rather than resuming into it. foundry itself refuses a run directory built
  // from different input; this makes that case unreachable instead of survivable.
  await fs.promises.rm(scratchDir, { recursive: true, force: true });
  await fs.promises.mkdir(scratchDir, { recursive: true });

  if (documentClass === 'text') {
    await invokeFoundry('get-text', [
      'scan', '--pdf', primary, '--run', scratchDir, '--out', workingPath,
    ], opts);
  } else {
    const { countPages } = await pageCounter();
    const pageCount = await countPages(primary);
    if (pageCount <= 0) {
      throw new Error(`${primary} reports ${pageCount} pages; there is nothing to read.`);
    }
    const pages = Array.from({ length: pageCount }, (_, i) => i);
    const pagesDir = scratchPagesDir(scratchDir);
    await fs.promises.mkdir(pagesDir, { recursive: true });

    const { callRenderPagesToPgm } =
      require('./pdf-worker-proxy') as typeof import('./pdf-worker-proxy');
    await callRenderPagesToPgm(primary, pages, pagesDir, FOUNDRY_DPI, (done, total) => {
      opts.onProgress?.({
        stage: 'render',
        message: `render: ${done}/${total} pages at ${FOUNDRY_DPI} dpi`,
        done,
        total,
      });
    });
    if (opts.signal?.aborted) throw new Error('Get Text was cancelled.');

    await invokeFoundry('get-text', ['scan', '--pages', pagesDir, '--run', scratchDir], opts);
    await invokeFoundry('get-text', [
      'get-text', '--pdf', primary, '--run', scratchDir, '--out', workingPath,
    ], opts);

    // The renders exist only to be scanned — ~3.6 MB a page, ~1.4 GB for a full
    // book — while everything downstream reads the working document and the ~1 MB
    // of line geometry, which stay.
    await fs.promises.rm(pagesDir, { recursive: true, force: true });
  }

  // The cast is a full rewrite, so the document that came out is the whole
  // boundary. Read the class back OUT of it rather than trusting what was asked
  // for: the marker is the authority on what a document is, and a disagreement
  // here would mean foundry cast something other than what was requested.
  const state = await readWorkingDocumentState(workingPath);
  if (state.marker.sourceSha256 !== sha256) {
    throw new Error(
      `The working document foundry cast at ${workingPath} declares it came from `
      + `${state.marker.sourceSha256}, and the archive original is ${sha256}. Refusing to bind them: `
      + 'this document is not a reading of this book.'
    );
  }

  const binding = await createDocumentBinding({
    projectId: project.projectId,
    projectDir: project.projectDir,
    primaryRelPath: project.primaryRelPath,
    workingAbsPath: workingPath,
    documentClass: state.marker.documentClass,
    foundryVersion: await resolvedFoundryVersion(),
  });
  await writeDocumentBinding(bindingAbsPath(project), binding);
  console.log(
    `[document-stages] cast ${workingPath} (${binding.working.bytes} bytes, `
    + `class ${state.marker.documentClass})`
  );
  return { binding, documentClass: state.marker.documentClass };
}

async function pageCounter(): Promise<{ countPages: (pdfPath: string) => Promise<number> }> {
  const { pdfAnalyzer } = require('./pdf-analyzer') as typeof import('./pdf-analyzer');
  return { countPages: (pdfPath: string) => pdfAnalyzer.countPages(pdfPath) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Blocks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Label every block and write the answer into the document as annotations.
 *
 * Detect REPLACES: foundry removes every annotation carrying `/FoundryCategory`
 * and writes the new set as one incremental update, leaving a publisher's links
 * and a reader's own highlights alone. Results are never staged, previewed or
 * held — if it ran, the annotations in the PDF are the new truth. There is one
 * detect.
 */
export async function runBlocksStage(opts: DocumentStageOptions): Promise<DocumentBinding> {
  const { project } = opts;
  const { binding, bindingPath, workingPath } = await requireCastBinding(project, 'Blocks');

  // Checked BEFORE the binary is resolved, which on a machine with no foundry is
  // a 38 MB download: an input that is not there is not a reason to fetch
  // anything, and the useful answer is available in the first second.
  const scratchDir = documentScratchDir(binding.primary.sha256);
  if (!fs.existsSync(path.join(scratchDir, 'scan', 'lines.json'))) {
    throw new Error(
      `The Blocks stage reads the line geometry the scan measured, and it is not at ${scratchDir}. `
      + 'That directory is machine-local scratch and is not synced between machines. Run Get Text '
      + 'over this book — it is what reads the pages and writes the geometry blocks are formed from.'
    );
  }
  await ensureFoundryPath();

  await invokeFoundry('blocks', [
    'blocks',
    '--run', scratchDir,
    '--pdf', workingPath,
    '--palette', writePaletteFile(scratchDir),
    ...await foundryLlamaServerArgs(),
  ], opts);

  return landBoundary(project, binding, bindingPath, 'blocks');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Footnotes, on the PDF
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove inline footnote reference markers from the working document's text
 * layer.
 *
 * Scanned class only, and foundry is the one that says so: a text document's
 * layer is the publisher's page description, and rewriting that from a parse of
 * it would re-lay-out the book. Refused HERE as well, before the model is
 * loaded, so the answer arrives in the first second rather than after the
 * weights.
 *
 * The default for a scanned book is still the EPUB reading of this stage, run
 * after Reflow — the adapter measures 97.0% applied / 0.5% false-fire on clean
 * text against 90.5% / 2.1% on raw OCR text. This is the reading for a user who
 * chose the PDF.
 */
export async function runFootnotesPdfStage(
  opts: DocumentStageOptions & { reportPath: string }
): Promise<DocumentBinding> {
  const { project } = opts;
  const { binding, bindingPath, workingPath } = await requireCastBinding(project, 'Footnotes');
  if (binding.documentClass !== 'scanned') {
    throw new Error(
      "This book carries the publisher's own text layer, and footnotes-on-the-PDF rewrites that "
      + 'layer — which would re-lay-out the book. Run the footnote pass on the EPUB instead: export '
      + 'the book with Reflow first, then remove the markers from it, where they are markup.'
    );
  }
  await ensureFoundryPath();

  await fs.promises.mkdir(path.dirname(opts.reportPath), { recursive: true });
  await invokeFoundry('footnotes', [
    'footnotes',
    '--pdf', workingPath,
    '--report', opts.reportPath,
    ...await foundryLlamaServerArgs(),
  ], opts);

  return landBoundary(project, binding, bindingPath, 'footnotes');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Reflow — the one exporter
// ─────────────────────────────────────────────────────────────────────────────

export interface ReflowRequest extends DocumentStageOptions {
  /**
   * Absolute destination for the book, named after the original FROM BIRTH —
   * the manifest's own export target. `book.epub` never exists on disk.
   */
  outputPath: string;
  /** Whole categories to drop from this export, e.g. `footnote`. */
  excludeCategories?: string[];
  /**
   * The book's cover (JPEG/PNG). Absent means the book has no cover, which is
   * ordinary — never a placeholder.
   */
  coverPath?: string;
}

/**
 * The working document in, `<Original>.epub` out. In one pass foundry drops
 * deleted blocks, pages and excluded categories; OCR-corrects the KEPT lines
 * (scanned class only, so culled blocks cost zero GPU); reflows lines into
 * paragraphs, dehyphenating under the corpus-attestation rules; and takes each
 * chapter's title from its chapter block's own annotation text.
 *
 * There is no second exporter and no gate choosing between them. Reflow reads
 * documents; it consults no run state, and if the documents it needs are missing
 * the error names the stage that writes them.
 *
 * ── Why it is staged ────────────────────────────────────────────────────────
 *
 * The library folder is Syncthing-synced, and a file written in place is visible
 * to Syncthing while it is still half-written — a half-EPUB propagated to
 * another machine is a corrupt book that looks like a real one. So foundry
 * writes a SIBLING of the destination (same filesystem, so the rename is atomic)
 * and the finished file is moved into place in one operation.
 */
export async function runReflowStage(req: ReflowRequest): Promise<{
  epubPath: string;
  binding: DocumentBinding;
}> {
  const { project } = req;
  const { binding, bindingPath, workingPath } = await requireCastBinding(project, 'Reflow');

  const state = await readWorkingDocumentState(workingPath);
  if (state.blockCount === 0) {
    throw new Error(
      'This book\'s working document carries no block layer, so there is nothing to say which of '
      + 'its lines are the prose and which are running heads. Run the Blocks stage over it, then '
      + 'export again.'
    );
  }
  await ensureFoundryPath();

  await fs.promises.mkdir(path.dirname(req.outputPath), { recursive: true });
  const staged = `${req.outputPath}.bookforge-tmp`;
  await fs.promises.rm(staged, { force: true });

  const args = ['reflow', '--pdf', workingPath, '--out', staged];
  for (const category of [...new Set(req.excludeCategories ?? [])]) {
    args.push('--exclude', category);
  }
  // Passed straight through. An installed foundry too old to know --cover fails
  // with its own message; retrying without the flag would ship a coverless book
  // that looks like a success.
  if (req.coverPath) args.push('--cover', req.coverPath);
  // The ocr adapter is resolved lazily by foundry, and only for a scanned
  // document — a book that carries its own text never starts a server.
  if (binding.documentClass === 'scanned') args.push(...await foundryLlamaServerArgs());

  try {
    await invokeFoundry('reflow', args, req);
    if (!fs.existsSync(staged)) {
      throw new Error(`foundry reflow reported success but wrote no file at ${staged}.`);
    }
    await fs.promises.rename(staged, req.outputPath);
  } catch (err) {
    await fs.promises.rm(staged, { force: true });
    throw err;
  }

  const updated = await recordExportedEpub(binding, project.projectDir, req.outputPath);
  await writeDocumentBinding(bindingPath, updated);
  console.log(`[document-stages] reflowed ${req.outputPath} (${updated.epub?.bytes} bytes)`);
  return { epubPath: req.outputPath, binding: updated };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Put the working document back to how it stood at the end of a stage.
 *
 * Costs one truncate: zero GPU, no re-run, and the result is not an
 * approximation of that document but that document. `none` removes the working
 * document outright, and the next Get Text casts it again from the archive
 * original — which is what "re-copies the archive primary" means when the cast
 * is also what writes the text layer.
 */
export async function resetDocumentTo(
  project: DocumentProject,
  target: ResetTarget
): Promise<DocumentBinding | null> {
  const bindingPath = bindingAbsPath(project);
  const binding = readDocumentBinding(bindingPath);
  if (!binding) {
    throw new Error(
      'This book has no working document to reset — nothing has been cast for it yet. Run Get Text '
      + 'to cast one from the archive original.'
    );
  }
  const updated = await resetToStage({ binding, projectDir: project.projectDir, target });
  await writeDocumentBinding(bindingPath, updated);
  return updated;
}

/**
 * Everything this book's document pipeline put on disk, gone — including the
 * machine-local scratch, which is the whole of its recovery model.
 *
 * The archive original is not touched, and it is what everything is rebuilt
 * from.
 */
export async function discardDocumentPipeline(project: DocumentProject): Promise<void> {
  const bindingPath = bindingAbsPath(project);
  const binding = readDocumentBinding(bindingPath);
  await fs.promises.rm(workingAbsPath(project), { force: true });
  await fs.promises.rm(bindingPath, { force: true });
  if (binding) {
    await fs.promises.rm(documentScratchDir(binding.primary.sha256), {
      recursive: true,
      force: true,
    });
  }
}
