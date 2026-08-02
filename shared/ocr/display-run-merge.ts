/**
 * display-run-merge — the ONE definition of when consecutive display blocks on a
 * page are really one unit.
 *
 * Block formation splits a chapter opening into pieces: a tracked-out
 * `CHAPTER 1` kicker, the title set over two or three lines, a subtitle. Each
 * arrives as its own block, so the classifier sees three things where the page
 * has one, and the corpus records three labels for one heading. This module
 * decides, from geometry alone, which of those pieces belong together.
 *
 * ── THIS FILE EXISTS TWICE, VERBATIM ────────────────────────────────────────
 *
 *   foundry      src/blocks/display-run-merge.ts
 *   BookForgeApp shared/ocr/display-run-merge.ts
 *
 * The two repositories are separate, so the copies are kept honest by a SHARED
 * FIXTURE — `display-run-merge.fixture.json`, checked into both — and a test in
 * each repo that replays it. A change made to one copy and not the other turns
 * that test red on the side that was not changed. Same discipline as the blocks
 * encoder: one implementation, proved by replay, never two that "agree".
 *
 * ── WHAT THE RULE IS ────────────────────────────────────────────────────────
 *
 * A run is a maximal sequence of blocks, in reading order on one page, that are
 * all DISPLAY-SHAPED and are not separated by anything else.
 *
 * Adjacency is INTERVENING CONTENT, not distance (owner's rule, Aug 2 2026):
 *
 *   "If there's a block vertically between them that doesn't match, they don't
 *    merge. If a chapter header starts at the top, has body text under it, and
 *    there's another chapter header under that body text, they don't merge. But
 *    if there's a chapter header at the top and another at the bottom with
 *    NOTHING between them, they SHOULD merge — it means the chapter header takes
 *    up the whole page, not that it's two different chapters."
 *
 * So a half-page of white space does not break a run; one body paragraph does.
 * This replaced a gap window of 2.2 line-heights, which split every chapter
 * opening whose kicker sat a little further above the title than average.
 *
 * ── THE FOUR MEMBERSHIP TESTS ───────────────────────────────────────────────
 *
 * 1. DISPLAY — type at least DISPLAY_RATIO x the book's modal body size, at most
 *    MAX_LINES lines. The size floor is what separates a heading from body; the
 *    line cap is what stops a large-print block of prose from reading as one.
 *
 * 2. CAPS KICKER — the display floor alone cannot be the only gate, because the
 *    `CHAPTER 1` line above a chapter title is routinely set SMALLER than body
 *    text (tracked small capitals: 9pt over a 10pt body in Twisted Cross, 6-8pt
 *    over 9pt in Gospel of Lies). A short all-capitals line may therefore join a
 *    run even below the floor — bounded so a body line can never qualify: at
 *    most KICKER_MAX_LINES lines, at least KICKER_MIN_FSIZE_RATIO of body size,
 *    and no wider than KICKER_MAX_WIDTH_FRAC of the body column.
 *
 *    All-capitals is the load-bearing part. Dropping it — admitting any short
 *    sub-display line — merged table-of-contents rows into their `Contents`
 *    heading and index rows into `Index`, and took the corpus conflict count
 *    from 10 to 52. Measured, not assumed.
 *
 * 3. NOT PAGE FURNITURE — with the gap window gone, a running head at the top of
 *    a chapter opening has nothing between it and the title, so it would fuse
 *    with it. Furniture is found the way it always is at inference, WITHOUT
 *    labels: a page-edge band that carries a block at the same height on a
 *    quarter of the book's pages is a running head or a folio. Position, not
 *    text — OCR spells a running head differently on every page but never moves
 *    it.
 *
 * 4. HORIZONTALLY COMPATIBLE with the run so far — x-ranges overlap, or both the
 *    run and the candidate are centred on the page. This is what keeps two
 *    columns from fusing into one heading, and a marginal note out of a title.
 *
 * Plus a size-ratio ceiling between the run and the candidate (FSIZE_RATIO), and
 * the requirement that a run contain at least one true display block, so that
 * two bare kickers — a folio next to a running head — are never a title.
 *
 * ── CATEGORY-BLIND ON PURPOSE ───────────────────────────────────────────────
 *
 * Nothing here reads a category, because at inference there is none: this runs
 * BEFORE the blocks model classifies anything. The corpus-side applier adds a
 * label gate on top (merge only where every member already carries the same
 * human label, and it is `title` or `chapter`), and that asymmetry is
 * deliberate — training data must never launder a label disagreement, while
 * inference has nothing to launder.
 *
 * ── MEASUREMENT ─────────────────────────────────────────────────────────────
 *
 * Every constant below was chosen against the corpus-wide LABEL CONFLICT count:
 * runs the geometry proposes whose members carry different human labels. Over
 * the 13 hand-labelled books this rule proposes 113 merged units swallowing 176
 * blocks, with 10 conflicts — of which 4 are unlabelled collage pages in Satanic
 * Panic and 5 are stale labels on the punch list. Loosening any constant past
 * these values raised conflicts without buying units; see the report in the
 * commit that introduced this file.
 */

/** A block as this rule needs it. Geometry in page points, page-local. */
export interface DisplayRunBlock {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /**
   * Type size. Zero is legal and means "no type" — an image placeholder. Such a
   * block is never a run member, so it always breaks a run, which is right: a
   * figure between two headings means they are two headings.
   */
  fontSize: number;
  /** Lines of type. Zero is legal for the same reason as `fontSize`. */
  lineCount: number;
  pageWidth: number;
  pageHeight: number;
  text: string;
}

/** What the rule decided, and the book-global quantities it decided it from. */
export interface DisplayRunPlan {
  /** Member ids in reading order. Every run has at least two members. */
  runs: string[][];
  /** Mode of type size over multi-line blocks — the book's body size. */
  modalFontSize: number;
  /** Median width of body-size multi-line blocks — the book's text measure. */
  bodyColumnWidth: number;
  /** Ids suppressed as running heads or folios, sorted. */
  furnitureIds: string[];
}

/** Malformed geometry. Loud, and it names the block. */
export class DisplayRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DisplayRunInputError';
  }
}

/**
 * The tuned constants. Changing one changes the corpus, the labelling tool and
 * inference at once — that is the point — so re-run the conflict measurement
 * (`merge-experiment/measure_all_books.py`) before and after.
 */
export const DISPLAY_RUN_RULE = {
  version: 'display-run-v1',
  /** Display type starts here, as a multiple of modal body size. */
  DISPLAY_RATIO: 1.3,
  /** A display block is a heading, not a page of large print. */
  MAX_LINES: 4,
  /** Ceiling on the size step between the run and the next candidate. */
  FSIZE_RATIO: 2.6,
  /** Both boxes count as centred within this fraction of the page width. */
  CENTER_TOL: 0.15,
  /** Caps kicker: a heading's small tracked label line. */
  KICKER_MAX_LINES: 2,
  KICKER_MIN_FSIZE_RATIO: 0.6,
  KICKER_MAX_WIDTH_FRAC: 0.9,
  /** Fraction of a letter's characters that must be capitals to read as caps. */
  KICKER_CAPS_SHARE: 0.8,
  /** Furniture: page-edge band, as a fraction of page height, top and bottom. */
  FURNITURE_BAND: 0.1,
  /** Height buckets within that band, as a fraction of page height. */
  FURNITURE_Y_BUCKET: 0.02,
  /** A bucket is furniture at this share of the book's pages... */
  FURNITURE_MIN_PAGE_FRAC: 0.25,
  /** ...and never below this many pages, so a 6-page excerpt cannot trip it. */
  FURNITURE_MIN_PAGES: 5,
  /** Safety stop on the fixed-point loop; convergence is normally 2-3 passes. */
  MAX_PASSES: 10,
} as const;

const R = DISPLAY_RUN_RULE;

/** A block plus the original ids it stands for while the plan converges. */
interface WorkingBlock extends DisplayRunBlock {
  members: string[];
}

/**
 * Plan the merges for a whole book's blocks.
 *
 * Pure: no I/O, no mutation of the input. Deterministic and independent of the
 * input array's order (everything is sorted internally). Idempotent — running it
 * over its own output produces no further runs — because the walk is repeated to
 * a fixed point rather than run once.
 */
export function planDisplayRuns(blocks: readonly DisplayRunBlock[]): DisplayRunPlan {
  validate(blocks);

  const modalFontSize = modalBodyFontSize(blocks);
  const bodyColumnWidth = bodyMeasure(blocks, modalFontSize);
  const furniture = findFurniture(blocks);

  let working: WorkingBlock[] = blocks.map((b) => ({ ...b, members: [b.id] }));
  let passes = 0;
  for (;;) {
    if (++passes > R.MAX_PASSES) {
      throw new DisplayRunInputError(
        `display-run merge did not converge in ${R.MAX_PASSES} passes — the walk is `
        + 'supposed to shrink the block count every pass, so this is a bug in the rule.',
      );
    }
    const byPage = new Map<number, WorkingBlock[]>();
    for (const b of working) {
      const list = byPage.get(b.page);
      if (list) list.push(b);
      else byPage.set(b.page, [b]);
    }

    const next: WorkingBlock[] = [];
    let mergedAny = false;
    for (const page of [...byPage.keys()].sort((a, b) => a - b)) {
      const pageBlocks = byPage.get(page)!;
      const runs = walkPage(pageBlocks, modalFontSize, bodyColumnWidth, furniture);
      const consumed = new Set<string>();
      for (const run of runs) {
        for (const m of run) consumed.add(m.id);
        next.push(mergeWorking(run));
        mergedAny = true;
      }
      for (const b of pageBlocks) if (!consumed.has(b.id)) next.push(b);
    }
    working = next;
    if (!mergedAny) break;
  }

  const runs = working
    .filter((b) => b.members.length > 1)
    .sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x || cmp(a.id, b.id))
    .map((b) => b.members);

  return {
    runs,
    modalFontSize,
    bodyColumnWidth,
    furnitureIds: [...furniture].sort(cmp),
  };
}

// ── input contract ──────────────────────────────────────────────────────────

function validate(blocks: readonly DisplayRunBlock[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const at = `block at index ${i}`;
    if (!b || typeof b.id !== 'string' || b.id === '') {
      throw new DisplayRunInputError(`${at} has no id; a merge plan is a list of ids.`);
    }
    if (seen.has(b.id)) {
      throw new DisplayRunInputError(`block id ${b.id} appears twice; ids must be unique.`);
    }
    seen.add(b.id);
    requireInt(b.page, 0, b.id, 'page');
    requireFinite(b.x, b.id, 'x');
    requireFinite(b.y, b.id, 'y');
    requireNonNegative(b.width, b.id, 'width');
    requireNonNegative(b.height, b.id, 'height');
    requireNonNegative(b.fontSize, b.id, 'fontSize');
    requireInt(b.lineCount, 0, b.id, 'lineCount');
    requirePositive(b.pageWidth, b.id, 'pageWidth');
    requirePositive(b.pageHeight, b.id, 'pageHeight');
    if (typeof b.text !== 'string') {
      throw new DisplayRunInputError(`block ${b.id}: text must be a string, got ${typeof b.text}.`);
    }
  }
}

function requireFinite(v: number, id: string, field: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new DisplayRunInputError(`block ${id}: ${field} must be a finite number, got ${String(v)}.`);
  }
}

function requireNonNegative(v: number, id: string, field: string): void {
  requireFinite(v, id, field);
  if (v < 0) throw new DisplayRunInputError(`block ${id}: ${field} is negative (${v}).`);
}

function requirePositive(v: number, id: string, field: string): void {
  requireFinite(v, id, field);
  if (v <= 0) throw new DisplayRunInputError(`block ${id}: ${field} must be greater than zero, got ${v}.`);
}

function requireInt(v: number, min: number, id: string, field: string): void {
  requireFinite(v, id, field);
  if (!Number.isInteger(v) || v < min) {
    throw new DisplayRunInputError(`block ${id}: ${field} must be an integer >= ${min}, got ${v}.`);
  }
}

// ── book-global quantities, all derived without labels ──────────────────────

/**
 * The book's body type size: the most common size among MULTI-LINE blocks.
 *
 * Multi-line, because a block that wrapped is prose by construction — that is
 * what stops a title page full of 40pt type from setting the baseline. Ties go
 * to the smaller size so the answer never depends on iteration order.
 */
function modalBodyFontSize(blocks: readonly DisplayRunBlock[]): number {
  let pool = blocks.filter((b) => b.lineCount >= 3 && b.fontSize > 0);
  if (pool.length === 0) pool = blocks.filter((b) => b.fontSize > 0);
  if (pool.length === 0) {
    throw new DisplayRunInputError(
      'no block carries a type size; the modal body size is undefined and every '
      + 'display test is relative to it.',
    );
  }
  const freq = new Map<number, number>();
  for (const b of pool) freq.set(b.fontSize, (freq.get(b.fontSize) ?? 0) + 1);
  let best = Infinity;
  let bestCount = -1;
  for (const [size, count] of freq) {
    if (count > bestCount || (count === bestCount && size < best)) {
      best = size;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The book's text measure: the median width of body-size multi-line blocks.
 *
 * The caps kicker is bounded against this rather than against page width,
 * because page width includes the margins and varies with the trim, while what
 * makes a kicker a kicker is that it is short next to a line of text.
 */
function bodyMeasure(blocks: readonly DisplayRunBlock[], modal: number): number {
  const atModal = blocks
    .filter((b) => b.lineCount >= 3 && b.width > 0 && Math.abs(b.fontSize - modal) < 0.51)
    .map((b) => b.width);
  const pool = atModal.length > 0 ? atModal : blocks.filter((b) => b.width > 0).map((b) => b.width);
  if (pool.length === 0) {
    throw new DisplayRunInputError('no block has a width; the body measure is undefined.');
  }
  return median(pool);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Running heads and folios, by POSITION.
 *
 * A block whose vertical centre falls in a page-edge band is bucketed by that
 * centre; a bucket carrying blocks on a quarter of the book's pages is
 * furniture, and every block in it is suppressed. Text is deliberately not
 * consulted: OCR misspells a running head differently on every page, and a
 * folio has no text worth matching at all.
 *
 * The threshold is a SHARE of pages on purpose. A chapter kicker also lands in
 * the same bucket on every chapter opening — 11 pages of Twisted Cross's 354 —
 * and a fixed count would have swallowed it.
 */
function findFurniture(blocks: readonly DisplayRunBlock[]): Set<string> {
  const totalPages = new Set(blocks.map((b) => b.page)).size;
  const minPages = Math.max(R.FURNITURE_MIN_PAGES, R.FURNITURE_MIN_PAGE_FRAC * totalPages);

  const buckets = new Map<string, Set<number>>();
  for (const b of blocks) {
    const key = furnitureKey(b);
    if (key === null) continue;
    const pages = buckets.get(key);
    if (pages) pages.add(b.page);
    else buckets.set(key, new Set([b.page]));
  }

  const out = new Set<string>();
  for (const b of blocks) {
    const key = furnitureKey(b);
    if (key === null) continue;
    if ((buckets.get(key)?.size ?? 0) >= minPages) out.add(b.id);
  }
  return out;
}

/** Bucket key for a block in a page-edge band, or null when it is inland. */
function furnitureKey(b: DisplayRunBlock): string | null {
  const centre = (b.y + b.height / 2) / b.pageHeight;
  if (centre > R.FURNITURE_BAND && centre < 1 - R.FURNITURE_BAND) return null;
  // floor, never round: JavaScript rounds .5 up and Python rounds it to even,
  // and this key has to be identical in both implementations.
  return `${centre < 0.5 ? 't' : 'b'}:${Math.floor(centre / R.FURNITURE_Y_BUCKET)}`;
}

// ── membership ──────────────────────────────────────────────────────────────

function isDisplay(b: DisplayRunBlock, modal: number): boolean {
  return b.fontSize >= R.DISPLAY_RATIO * modal && b.lineCount <= R.MAX_LINES && b.lineCount > 0;
}

function isCapsKicker(b: DisplayRunBlock, modal: number, bodyWidth: number): boolean {
  if (isDisplay(b, modal)) return false;
  return b.lineCount > 0
    && b.lineCount <= R.KICKER_MAX_LINES
    && b.fontSize >= R.KICKER_MIN_FSIZE_RATIO * modal
    && b.width > 0
    && b.width <= R.KICKER_MAX_WIDTH_FRAC * bodyWidth
    && isAllCaps(b.text);
}

/**
 * Set in capitals, tolerating OCR noise (`FAcING DICTATORSHIPS`).
 *
 * A character counts as a letter when it HAS distinct cases, which is the same
 * test in JavaScript and in Python and does not depend on a Unicode table
 * version the two might disagree about.
 */
function isAllCaps(text: string): boolean {
  let letters = 0;
  let upper = 0;
  for (const ch of text) {
    if (ch.toLowerCase() === ch.toUpperCase()) continue;
    letters++;
    if (ch === ch.toUpperCase()) upper++;
  }
  if (letters < 2) return false;
  return upper / letters >= R.KICKER_CAPS_SHARE;
}

// ── the walk ────────────────────────────────────────────────────────────────

/**
 * One pass over one page: reading order, runs broken by anything that is not a
 * member. Returns only runs of two or more.
 */
function walkPage(
  pageBlocks: readonly WorkingBlock[],
  modal: number,
  bodyWidth: number,
  furniture: ReadonlySet<string>,
): WorkingBlock[][] {
  const ordered = [...pageBlocks].sort((a, b) => a.y - b.y || a.x - b.x || cmp(a.id, b.id));

  const runs: WorkingBlock[][] = [];
  let run: WorkingBlock[] = [];
  let left = 0;
  let right = 0;

  const flush = (): void => {
    if (run.length > 1) runs.push(run);
    run = [];
  };

  for (const b of ordered) {
    const member = !furniture.has(b.id)
      && (isDisplay(b, modal) || isCapsKicker(b, modal, bodyWidth));
    if (!member) {
      flush();
      continue;
    }
    if (run.length > 0 && joins(run, left, right, b, modal)) {
      run.push(b);
      left = Math.min(left, b.x);
      right = Math.max(right, b.x + b.width);
      continue;
    }
    flush();
    run = [b];
    left = b.x;
    right = b.x + b.width;
  }
  flush();
  return runs;
}

/** Can `b` extend the run? Horizontal sanity, size step, and a real heading. */
function joins(
  run: readonly WorkingBlock[],
  left: number,
  right: number,
  b: WorkingBlock,
  modal: number,
): boolean {
  // x-ranges overlap, or the run and the candidate are both centred. The run's
  // ACCUMULATED span is used, not the previous member's, so that rejecting a
  // candidate is a decision the merged unit would make the same way — which is
  // what makes the fixed point stable.
  const overlaps = Math.min(right, b.x + b.width) - Math.max(left, b.x) > 0;
  if (!overlaps) {
    const pw = b.pageWidth;
    const runCentred = Math.abs((left + right) / 2 - pw / 2) <= R.CENTER_TOL * pw;
    const bCentred = Math.abs(b.x + b.width / 2 - pw / 2) <= R.CENTER_TOL * pw;
    if (!(runCentred && bCentred)) return false;
  }

  let hi = b.fontSize;
  let lo = b.fontSize;
  for (const m of run) {
    if (m.fontSize > hi) hi = m.fontSize;
    if (m.fontSize < lo) lo = m.fontSize;
  }
  if (!(lo > 0) || hi / lo > R.FSIZE_RATIO) return false;

  // A run needs at least one true display block: two bare kickers, a folio next
  // to a running head, are not a title.
  return isDisplay(b, modal) || run.some((m) => isDisplay(m, modal));
}

/** Collapse a run into the block the next pass will see. */
function mergeWorking(run: readonly WorkingBlock[]): WorkingBlock {
  const first = run[0];
  const x0 = Math.min(...run.map((r) => r.x));
  const y0 = Math.min(...run.map((r) => r.y));
  const x1 = Math.max(...run.map((r) => r.x + r.width));
  const y1 = Math.max(...run.map((r) => r.y + r.height));
  return {
    ...first,
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    fontSize: Math.max(...run.map((r) => r.fontSize)),
    lineCount: run.reduce((n, r) => n + r.lineCount, 0),
    text: run.map((r) => r.text).join(' ').trim(),
    members: run.flatMap((r) => r.members),
  };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
