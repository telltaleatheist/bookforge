/**
 * editor-layout (main process) — the layout THIS BUILD lays an EPUB out in, and
 * the reading of a project's stamp against it.
 *
 * The identity itself and every sentence said about one are in
 * `shared/document/editor-layout.ts`, which is pure and testable without a
 * project. This is the half that knows what the running build actually does:
 * the paginator's own name and version, the analysis version its stamps were
 * minted under, and the page box `analyzeEpubWithQuire` measures in.
 *
 * ── One source, three readers ──────────────────────────────────────────────
 *
 * The three facts are not restated here. `QUIRE_ANALYSIS_VERSION` and
 * `QUIRE_ANALYSIS_GEOMETRY` come from `quire-page-map.ts` — the module that
 * already refuses a cached page map whose geometry differs — and the strategy
 * name is rebuilt from `PAGEDJS_VERSION` exactly as `epub-quire-analysis.ts`
 * rebuilds it, from the same constant, for the same reason: the cache key has
 * to be knowable without a document open. If those three ever disagree with
 * what a book was actually laid out by, the page map cache would already be
 * serving one build's map to another, which is a bug those modules own.
 */
import {
  censusLayoutKeyedRecords,
  describeStaleLayoutRecords,
  editorLayoutStatus,
  layoutKeyedRecordTotal,
  EDITOR_LAYOUT_MANIFEST_KEY,
  type EditorLayoutIdentity,
  type EditorLayoutStatus,
  type LayoutKeyedRecordCensus,
} from '../shared/document/editor-layout';
import { QUIRE_ANALYSIS_GEOMETRY, QUIRE_ANALYSIS_VERSION } from './quire-page-map';

export type { EditorLayoutIdentity, EditorLayoutStatus, LayoutKeyedRecordCensus };
export { EDITOR_LAYOUT_MANIFEST_KEY };

/**
 * The fragmenter this build paginates EPUBs with, by name.
 *
 * `require`d rather than imported for the reason `epub-quire-analysis.ts` gives:
 * the strategy module is safe to load anywhere (fs, path and types only), and a
 * static import would tie this module's load order to quire's.
 */
function pagedStrategyName(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { PAGEDJS_VERSION } = require('../packages/quire/src/paginate/paged') as {
    PAGEDJS_VERSION: string;
  };
  return `pagedjs-${PAGEDJS_VERSION}`;
}

/**
 * The layout an EPUB analyzed by this build comes back in.
 *
 * `recordedAt` is stamped at the moment a save writes the identity down, not
 * here, so calling this twice in one save cannot produce two timestamps.
 */
export function currentEpubEditorLayout(recordedAt: string): EditorLayoutIdentity {
  return {
    engine: 'quire',
    strategy: pagedStrategyName(),
    version: QUIRE_ANALYSIS_VERSION,
    width: QUIRE_ANALYSIS_GEOMETRY.width,
    height: QUIRE_ANALYSIS_GEOMETRY.height,
    fontSize: QUIRE_ANALYSIS_GEOMETRY.fontSize,
    recordedAt,
  };
}

/**
 * Enough of a manifest to answer the layout question, and no more.
 *
 * Declared structurally rather than imported as `ProjectManifest` because both
 * manifest declarations are behind what the picker's save actually writes —
 * twelve of the sixteen `editor` fields it persists appear in neither — so
 * reading through either type would hide the very records this has to count.
 */
export interface LayoutBearingManifest {
  source?: unknown;
  editor?: unknown;
  chapters?: unknown;
}

/** A manifest sub-object as a bag of keys, or null when it is not one. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** The stamp a manifest carries, or null when it carries none. */
export function readEditorLayout(
  manifest: LayoutBearingManifest,
): EditorLayoutIdentity | null {
  const stamped = asRecord(manifest.source)?.[EDITOR_LAYOUT_MANIFEST_KEY];
  if (!stamped || typeof stamped !== 'object') return null;
  const l = stamped as Record<string, unknown>;
  // Every field is checked, because a half-written stamp read as an identity
  // would compare unequal to the current layout and refuse a project forever
  // for a reason nobody could act on. A malformed stamp is no stamp.
  if (
    (l.engine !== 'quire' && l.engine !== 'mupdf')
    || typeof l.strategy !== 'string'
    || typeof l.version !== 'number'
    || typeof l.width !== 'number'
    || typeof l.height !== 'number'
    || typeof l.fontSize !== 'number'
  ) {
    return null;
  }
  return {
    engine: l.engine,
    strategy: l.strategy,
    version: l.version,
    width: l.width,
    height: l.height,
    fontSize: l.fontSize,
    recordedAt: typeof l.recordedAt === 'string' ? l.recordedAt : '',
  };
}

/** What a project's layout-keyed records are, and whether they may be used. */
export interface EditorLayoutReading {
  status: EditorLayoutStatus;
  /** The stamp found on the manifest, or null. */
  recorded: EditorLayoutIdentity | null;
  /** The layout this build produces. */
  current: EditorLayoutIdentity;
  census: LayoutKeyedRecordCensus;
  /**
   * Why these records cannot be applied, or null when they can.
   *
   * Non-null exactly when `status` is `legacy` or `foreign`. Never non-null for
   * a PDF: mupdf's pagination of a PDF is the PDF's own pages and has not
   * changed, so nothing about the cutover touches one.
   */
  refusal: string | null;
}

/**
 * Read a manifest's layout stamp against this build's, and say what follows.
 *
 * The one entry point. Every caller that is about to hand a page number or a
 * block id to something that will resolve it against a freshly analyzed book
 * goes through here first, and a `refusal` is a hard stop rather than a warning
 * — the whole point being that resolving page 140 of a layout with 218 pages
 * against one with 183 strikes out real paragraphs the user never touched.
 */
export function readEditorLayoutState(
  bookName: string,
  sourceType: string,
  manifest: LayoutBearingManifest,
  now: string = new Date().toISOString(),
): EditorLayoutReading {
  const current = currentEpubEditorLayout(now);
  const recorded = readEditorLayout(manifest);
  const census = censusLayoutKeyedRecords(
    asRecord(manifest.source),
    asRecord(manifest.editor),
    Array.isArray(manifest.chapters)
      ? manifest.chapters.filter((c): c is Record<string, unknown> => asRecord(c) !== null)
      : null,
  );
  const status = editorLayoutStatus(
    sourceType, recorded, current, layoutKeyedRecordTotal(census) > 0,
  );
  const refusal = (status === 'legacy' || status === 'foreign')
    ? describeStaleLayoutRecords(bookName, census, recorded, current)
    : null;
  return { status, recorded, current, census, refusal };
}
