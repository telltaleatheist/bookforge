/**
 * quire — a sandboxed, browser-based paginator for EPUBs.
 *
 * A quire is the gathering of leaves that gets folded and sewn into a book: the
 * thing that turns a text into pages.
 *
 * ```ts
 * import { Quire } from '../packages/quire/src';
 *
 * Quire.registerScheme();            // at module scope, BEFORE app.whenReady()
 *
 * const doc = await Quire.openDocument(stampedEpubPath);
 * await doc.layout({ width: 600, height: 900, fontSize: 18 });
 * doc.countPages();
 * const page = doc.loadPage(0);
 * page.getBlocks();                  // -> QuireBlock[], each carrying the caller's id
 * page.getMount();                   // -> what a display surface needs, as plain data
 * await doc.close();
 * ```
 *
 * See the package README for the contract, the identity rule, and the sandbox
 * guarantees.
 */
import { QuireDocument, type QuireOpenOptions } from './document';
import { registerQuireScheme } from './host/protocol';

export const Quire = {
  /**
   * Register the `quire://` scheme as privileged. MUST run at module scope in
   * the main process, before `app.whenReady()` — the same constraint
   * `bookforge-page` is under in `electron/main.ts`. `openDocument` refuses
   * rather than falling back to an unprivileged scheme if this was skipped.
   */
  registerScheme: registerQuireScheme,

  /** Open a stamped EPUB. Call `await doc.layout(...)` before asking about pages. */
  openDocument(epubPath: string, options: QuireOpenOptions = {}): Promise<QuireDocument> {
    return QuireDocument.open(epubPath, options);
  },
};

export { QuireDocument, QuirePage } from './document';
export type { QuireOpenOptions } from './document';
export { QuireError } from './errors';
export { QuireArchive, normalizeEntryName } from './epub/archive';
export { buildPaginationShell } from './epub/shell';
export { QuireZipReader } from './epub/zip-reader';
export {
  QUIRE_SCHEME, quireCsp, quireCspMeta, registerQuireScheme, resolveQuireRequest, contentTypeFor,
} from './host/protocol';
export type { QuireResolution } from './host/protocol';
export { QUIRE_REQUIRED_WEB_PREFERENCES, assertSandboxed } from './host/host';
export type { QuireHost } from './host/host';
export { OffscreenWindowHost, QUIRE_ISOLATED_WORLD_ID } from './host/offscreen-host';
export { AttachedWebContentsHost } from './host/attached-host';
export { PagedStrategy, PAGEDJS_VERSION, MONOLITHIC_OVERFLOW_RULE } from './paginate/paged';
export type { PagedConfig } from './paginate/paged';
/** The adversarial test fixture, NOT a runtime fallback. See its module doc. */
export { MultiColumnStrategy } from './paginate/multi-column';
export type {
  QuireStrategy, StrategyMeasurement, StrategyPlacement, StrategyUnplaced,
} from './paginate/strategy';
export { mountQuirePage } from './mount';
export type { MountedQuirePage, MountQuirePageOptions } from './mount';
export {
  QUIRE_COLUMN_GAP, QUIRE_ID_ATTRIBUTE, QUIRE_ID_SEPARATOR,
} from './types';
export type {
  QuireBlock, QuireBox, QuireGeometry, QuireLayoutOptions, QuireOverflow,
  QuirePageBoxModel, QuirePageMapSnapshot, QuirePageMount, QuireReport, QuireSpineWarning,
  QuireUnplaced,
} from './types';
