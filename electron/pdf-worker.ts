/**
 * PDF Worker Thread
 *
 * Runs PDFAnalyzer in a worker_threads Worker so the main Electron process
 * stays responsive during heavy mupdf WASM operations (analyze, render, export).
 *
 * Protocol (parentPort messages):
 *   Receive: { type: 'call', requestId: string, method: string, args: any[] }
 *   Send:    { type: 'result', requestId: string, result: any }
 *           | { type: 'error',  requestId: string, error: string }
 *           | { type: 'progress', channel: string, data: any }
 */
import { parentPort } from 'worker_threads';
import { PDFAnalyzer } from './pdf-analyzer.js';

if (!parentPort) {
  throw new Error('pdf-worker.ts must be run as a worker_threads Worker');
}

const pdfAnalyzer = new PDFAnalyzer();

// Suppress benign mupdf WASM FinalizationRegistry errors (same as main.ts).
process.on('uncaughtException', (err) => {
  if (err instanceof WebAssembly.RuntimeError && err.stack?.includes('FinalizationRegistry')) {
    return;
  }
  console.error('[pdf-worker] Uncaught exception:', err);
});

// ---------------------------------------------------------------------------
// Progress helpers — send fire-and-forget messages to the main thread which
// forwards them to the correct BrowserWindow WebContents.
// ---------------------------------------------------------------------------

function sendProgress(channel: string, data: any): void {
  parentPort!.postMessage({ type: 'progress', channel, data });
}

// ---------------------------------------------------------------------------
// Dispatch table — maps method name → (args) => Promise<result>.
// Each entry mirrors the corresponding IPC handler in main.ts, converting
// progress callbacks into postMessage progress events.
// ---------------------------------------------------------------------------

type Dispatcher = (args: any[]) => Promise<any>;

const dispatch: Record<string, Dispatcher> = {
  // ── Analysis ──────────────────────────────────────────────────────────────
  async analyze(args) {
    const [pdfPath, maxPages] = args;
    return pdfAnalyzer.analyze(pdfPath, maxPages, (phase: string, message: string) => {
      sendProgress('pdf:analyze-progress', { phase, message });
    });
  },

  async analyzeQuick(args) {
    const [pdfPath, maxPages] = args;
    return pdfAnalyzer.analyzeQuick(pdfPath, maxPages, (phase: string, message: string) => {
      sendProgress('pdf:analyze-progress', { phase, message });
    });
  },

  async analyzeText(args) {
    const [pdfPath, maxPages] = args;
    const result = await pdfAnalyzer.analyzeText(pdfPath, maxPages, (phase: string, message: string) => {
      sendProgress('pdf:analyze-progress', { phase, message });
    });
    // Fire text-ready event so the renderer can update without waiting for invoke return.
    // Include the source pdfPath so the renderer can tell which document this
    // background extraction result belongs to.
    sendProgress('pdf:text-ready', { ...result, pdfPath });
    return result;
  },

  // ── Single-page renders ──────────────────────────────────────────────────
  async renderPage(args) {
    const [pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground] = args;
    return pdfAnalyzer.renderPage(pageNum, scale, pdfPath, redactRegions, fillRegions, removeBackground);
  },

  async renderBlankPage(args) {
    const [pageNum, scale] = args;
    return pdfAnalyzer.renderBlankPage(pageNum, scale);
  },

  // ── Batch renders ─────────────────────────────────────────────────────────
  async renderAllPagesToFiles(args) {
    const [pdfPath, scale, concurrency] = args;
    return pdfAnalyzer.renderAllPagesToFiles(pdfPath, scale, concurrency, (current: number, total: number) => {
      sendProgress('pdf:render-progress', { current, total });
    });
  },

  async renderAllPagesWithPreviews(args) {
    const [pdfPath, concurrency] = args;
    return pdfAnalyzer.renderAllPagesWithPreviews(
      pdfPath,
      concurrency,
      // previewCallback
      (current: number, total: number) => {
        sendProgress('pdf:render-progress', { current, total, phase: 'preview' });
      },
      // fullCallback (per-page upgrade)
      (pageNum: number, pagePath: string) => {
        sendProgress('pdf:page-upgraded', { pageNum, path: pagePath });
      },
      // progressCallback (combined)
      (current: number, total: number, phase: 'preview' | 'full') => {
        sendProgress('pdf:render-progress', { current, total, phase });
      }
    );
  },

  async renderPages(args) {
    const [pdfPath, pageNumbers, quality] = args;
    return pdfAnalyzer.renderPages(pdfPath, pageNumbers, quality);
  },

  // ── Render doc management ─────────────────────────────────────────────────
  async getRenderedPagePath(args) {
    const [pageNum] = args;
    return pdfAnalyzer.getRenderedPagePath(pageNum);
  },

  async closeRenderDoc(_args) {
    pdfAnalyzer.closeRenderDoc();
    return undefined;
  },

  async close(_args) {
    pdfAnalyzer.close();
    return undefined;
  },

  // ── Outline / chapters ────────────────────────────────────────────────────
  async extractOutline(_args) {
    return pdfAnalyzer.extractOutline();
  },

  async outlineToChapters(args) {
    const [outline, deletedPages] = args;
    const deletedSet = deletedPages?.length ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.outlineToChapters(outline, deletedSet);
  },

  async detectChaptersHeuristic(args) {
    const [deletedPages] = args;
    const deletedSet = deletedPages?.length ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.detectChaptersHeuristic(deletedSet);
  },

  async detectChaptersFromExamples(args) {
    const [exampleBlockIds, deletedPages] = args;
    const deletedSet = deletedPages?.length ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.detectChaptersFromExamples(exampleBlockIds, deletedSet);
  },

  async mapTocEntriesToChapters(args) {
    const [tocBlockIds, deletedPages] = args;
    const deletedSet = deletedPages?.length ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.mapTocEntriesToChapters(tocBlockIds, deletedSet);
  },

  async splitTocBlocks(args) {
    const [tocBlockIds] = args;
    return pdfAnalyzer.splitTocBlocks(tocBlockIds);
  },

  async mapTitlesToChapters(args) {
    const [titles, tocPages, deletedPages] = args;
    const deletedSet = deletedPages?.length ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.mapTitlesToChapters(titles, tocPages, deletedSet);
  },

  // ── Export ────────────────────────────────────────────────────────────────
  async exportText(args) {
    const [enabledCategories] = args;
    return pdfAnalyzer.exportText(enabledCategories);
  },

  async exportPdf(args) {
    const [pdfPath, deletedRegions, ocrBlocks, deletedPages, chapters] = args;
    const deletedPagesSet = deletedPages ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.exportPdf(pdfPath, deletedRegions, ocrBlocks, deletedPagesSet, chapters);
  },

  async exportPdfWithBackgroundsRemoved(args) {
    const [scale, deletedRegions, ocrBlocks, deletedPages] = args;
    const deletedPagesSet = deletedPages ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.exportPdfWithBackgroundsRemoved(scale, (current: number, total: number) => {
      sendProgress('pdf:export-progress', { current, total });
    }, deletedRegions, ocrBlocks, deletedPagesSet);
  },

  async exportPdfWysiwyg(args) {
    const [deletedRegions, deletedPages, scale, ocrPages] = args;
    const deletedPagesSet = deletedPages ? new Set<number>(deletedPages) : undefined;
    return pdfAnalyzer.exportPdfWysiwyg(deletedRegions, deletedPagesSet, scale, (current: number, total: number) => {
      sendProgress('pdf:export-progress', { current, total });
    }, ocrPages);
  },

  // ── Search / spans ────────────────────────────────────────────────────────
  async findSimilar(args) {
    const [blockId] = args;
    return pdfAnalyzer.findSimilar(blockId);
  },

  async findSpansInRect(args) {
    const [page, x, y, width, height] = args;
    return pdfAnalyzer.findSpansInRect(page, x, y, width, height);
  },

  async analyzesamples(args) {
    const [sampleSpans] = args;
    return pdfAnalyzer.analyzesamples(sampleSpans);
  },

  async findMatchingSpans(args) {
    const [fingerprint] = args;
    return pdfAnalyzer.findMatchingSpans(fingerprint);
  },

  async findSpansByRegex(args) {
    const [pattern, minFontSize, maxFontSize, minBaseline, maxBaseline, caseSensitive] = args;
    return pdfAnalyzer.findSpansByRegex(pattern, minFontSize, maxFontSize, minBaseline ?? null, maxBaseline ?? null, caseSensitive ?? false);
  },

  async getSpans(_args) {
    return pdfAnalyzer.getSpans();
  },

  async updateSpansForOcrPage(args) {
    const [pageNum, ocrBlocks] = args;
    pdfAnalyzer.updateSpansForOcrPage(pageNum, ocrBlocks);
    return undefined;
  },

  // ── Bookmarks / assembly ──────────────────────────────────────────────────
  async addBookmarksToPdf(args) {
    const [pdfBase64, chapters] = args;
    const pdfData = Buffer.from(pdfBase64, 'base64');
    const result = await pdfAnalyzer.addBookmarksToPdf(pdfData, chapters);
    return Buffer.from(result).toString('base64');
  },

  async assembleFromImages(args) {
    const [pages, chapters] = args;
    return pdfAnalyzer.assembleFromImages(pages, chapters);
  },

  // ── Cache management ──────────────────────────────────────────────────────
  async clearCache(args) {
    const [fileHash] = args;
    pdfAnalyzer.clearCache(fileHash);
    return undefined;
  },

  async clearAllCache(_args) {
    return pdfAnalyzer.clearAllCache();
  },

  async getCacheSize(args) {
    const [fileHash] = args;
    return pdfAnalyzer.getCacheSize(fileHash);
  },

  async getTotalCacheSize(_args) {
    return pdfAnalyzer.getTotalCacheSize();
  },

  async cleanupTempFiles(_args) {
    pdfAnalyzer.cleanupTempFiles();
    return undefined;
  },
};

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

parentPort.on('message', async (msg: { type: string; requestId: string; method: string; args: any[] }) => {
  if (msg.type !== 'call') return;

  const { requestId, method, args } = msg;
  const handler = dispatch[method];

  if (!handler) {
    parentPort!.postMessage({
      type: 'error',
      requestId,
      error: `Unknown method: ${method}`,
    });
    return;
  }

  try {
    const result = await handler(args);
    parentPort!.postMessage({ type: 'result', requestId, result });
  } catch (err) {
    parentPort!.postMessage({
      type: 'error',
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
