/**
 * Content script — finds readable text blocks. Hovering a block reveals a small
 * margin control: ▶ "play from here to the end of the page" (continuous, the queue
 * auto-advances) and − "exclude this block" (skip ads/junk). Clicking a word starts
 * reading from exactly there. It also offers a selection control, owns the transport
 * bar, highlights the sentence being read (auto-scrolling to follow), and renders
 * the per-tab UiState pushed down from the offscreen player.
 *
 * No audio or networking here. Injected/toggled from the toolbar popup.
 */

import { EMPTY_RUN, PlaybackStatus, RuntimeMessage, Settings, UiState, loadSettings } from './messages';

declare global {
  interface Window { __bfrInjected?: boolean; }
}
if (window.__bfrInjected) {
  // already running; the toggle-ui message drives re-show
} else {
  window.__bfrInjected = true;
  void init();
}

// ─── State ────────────────────────────────────────────────────────────────────

const SELECTOR = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, figcaption';
const EXCLUDE =
  'nav, header, footer, aside, form, [role="navigation"], [aria-hidden="true"], [contenteditable], #bfr-root';
const RESCAN_DEBOUNCE_MS = 1200;
// Busy SPAs (analytics, lazy images, intersection observers) mutate the DOM
// continuously, which would keep resetting a pure trailing debounce so a rescan
// never fires. Cap the deferral: once mutations started, rescan within this long
// no matter how much churn keeps coming.
const RESCAN_MAX_WAIT_MS = 4000;
const SPEED_MIN = 0.5;
const SPEED_MAX = 4;

const idMap = new WeakMap<HTMLElement, string>();
let idCounter = 0;
let selCounter = 0;

let settings: Settings;
let uiVisible = true;
let root: HTMLDivElement;
let bar: HTMLDivElement;
let barEls: BarEls;
let selControl: HTMLDivElement;
let blocks: { id: string; el: HTMLElement }[] = [];
let blockElToId = new Map<HTMLElement, string>(); // O(1) hover hit-testing
let lastUi: UiState | null = null;
// Briefly after a local speed change, while the new rate round-trips through the
// background to the player, renderBar must not snap the label back to the
// still-stale rate the periodic UiState ticks are reporting.
let speedHoldUntil = 0;
const SPEED_HOLD_MS = 1000;
let rescanTimer: number | null = null;
let rescanFirstScheduled = 0; // when the current pending rescan was first requested
let watchdog: number | null = null;
let observer: MutationObserver | null = null;

// Per-block controls (▶ play-from-here / − exclude) in the left margin of every
// detected block. One group per block exists at all times (so nothing has to be
// built on hover), but only the one under the pointer is visible — the page stays
// clean until you point at a paragraph.
let controlsLayer: HTMLDivElement;
const blockControls = new Map<string, HTMLDivElement>(); // blockId → its margin group
let lastControlsWidth = 0; // viewport width at last reposition (reflow detector)
let hoveredBlockId: string | null = null;

// Blocks whose audio is rendered, marked with a blue rule in the margin so the
// page shows at a glance how far the reader has got ahead of the listener.
let renderLayer: HTMLDivElement;
let renderedBlockIds: string[] = [];

// Blocks the user excluded from continuous reading (ads, captions, junk).
const excluded = new Set<string>();
let excludeLayer: HTMLDivElement;
// Set once the extension is reloaded/updated out from under this injected script
// (chrome.* APIs go dead). We stop all work instead of throwing on every event.
let dead = false;

// Reading-sentence highlight (overlay rects drawn over the active block; never
// touches the page DOM). Ranges are matched once per (block, segmentation) and
// cached; the live Range is redrawn on scroll/resize.
let highlightLayer: HTMLDivElement;
let hlSig = '';
let hlSource: HTMLElement | Range | null = null;
let hlPos: CharPos[] | null = null;
let hlRanges: (CharRange | null)[] | null = null;
let hlCurrentRange: Range | null = null;
let hlKey = ''; // `${blockId}#${sentenceIndex}` currently drawn
let hlRaf = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  settings = await loadSettings();
  buildRoot();
  buildSelectionControl();
  buildBar();
  await restoreBarLayout();
  chrome.runtime.onMessage.addListener(onMessage);
  rescan();
  requestSync();

  observer = new MutationObserver(() => scheduleRescan());
  observer.observe(document.body, { childList: true, subtree: true });
  // A resize reflows the page, so re-detect blocks (rescan redraws their margin
  // controls); scroll only needs the highlight/exclude overlays refreshed.
  window.addEventListener('resize', () => { clampBarPos(); scheduleViewportSync(); scheduleRescan(); }, { passive: true });
  document.addEventListener('selectionchange', onSelectionChange);
  // Hover reveals a block's ▶/− controls; leaving the page hides them.
  document.addEventListener('mousemove', onPointerMove, { passive: true });
  document.addEventListener('mouseleave', () => setHoveredBlock(null), { passive: true });
  window.addEventListener('scroll', () => { hideSelControl(); scheduleViewportSync(); }, { passive: true });
  // Click in body text starts reading there; the margin controls handle play/skip.
  document.addEventListener('click', onDocClick, true);
  // A click anywhere outside an open shelf (or its own tool button) closes it.
  // Capture, so it still runs when the target's handler stops propagation.
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement | null;
    if (!t?.closest?.('.bfr-shelf, .bfr-tool')) closeShelves();
  }, true);
}

// ─── Block detection ──────────────────────────────────────────────────────────

function idFor(el: HTMLElement): string {
  let id = idMap.get(el);
  if (!id) { id = `b${++idCounter}`; idMap.set(el, id); }
  return id;
}

function detectBlocks(): { id: string; el: HTMLElement }[] {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));
  const kept = candidates.filter((el) => {
    if (el.closest(EXCLUDE)) return false;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const min = /^H[1-6]$/.test(el.tagName) ? 12 : 60;
    if (text.length < min) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  });
  const keptSet = new Set(kept);
  const leaves = kept.filter((el) => {
    if (!el.querySelector(SELECTOR)) return true;
    for (const other of keptSet) if (other !== el && el.contains(other)) return false;
    return true;
  });
  return leaves.slice(0, 500).map((el) => ({ id: idFor(el), el }));
}

function rescan(): void {
  if (!uiVisible) return;
  blocks = detectBlocks();
  blockElToId = new Map(blocks.map((b) => [b.el, b.id]));
  drawBlockControls();
  drawExcludeOverlays();
  drawRenderMarks();
  if (lastUi) applyUi(lastUi);
}

/** Blue rule down the margin of every block whose audio is rendered. */
function drawRenderMarks(): void {
  if (!renderLayer) return;
  renderLayer.textContent = '';
  for (const id of renderedBlockIds) {
    const el = blockElFor(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const div = document.createElement('div');
    div.className = 'bfr-rendered';
    // In the gutter between the ▶/− controls (which sit at left-30, 24px wide)
    // and the text itself, so it reads as a rule against the paragraph.
    div.style.left = `${Math.max(0, r.left + window.scrollX - 5)}px`;
    div.style.top = `${r.top + window.scrollY}px`;
    div.style.height = `${r.height}px`;
    renderLayer.appendChild(div);
  }
}

function scheduleRescan(): void {
  if (dead) return;
  const now = Date.now();
  if (rescanTimer === null) rescanFirstScheduled = now;
  else clearTimeout(rescanTimer);
  // Trailing debounce, but never wait longer than RESCAN_MAX_WAIT_MS from the
  // first request — so constant DOM churn can't starve the rescan indefinitely.
  const wait = Math.min(RESCAN_DEBOUNCE_MS, Math.max(0, rescanFirstScheduled + RESCAN_MAX_WAIT_MS - now));
  rescanTimer = setTimeout(() => { rescanTimer = null; rescan(); }, wait) as unknown as number;
}

// ─── Per-block controls (▶ play-from-here / − exclude) ─────────────────────────
//
// One persistent control group sits in each block's left margin. They're built
// to mirror the current block set on every rescan and positioned in document
// coordinates, so they ride the page on scroll with no per-frame work — only a
// reflow (resize, or DOM change via the observer) re-detects and repositions.

/** Build/refresh the margin controls so there's exactly one per detected block. */
function drawBlockControls(): void {
  if (!controlsLayer) return;
  const seen = new Set<string>();
  for (const b of blocks) {
    seen.add(b.id);
    let group = blockControls.get(b.id);
    if (!group) {
      group = makeBlockControl(b.id);
      blockControls.set(b.id, group);
      controlsLayer.appendChild(group);
    }
    updateBlockMinus(group, b.id);
    positionBlockControl(group, b.el);
  }
  // Drop controls whose block vanished in a re-render.
  for (const [id, group] of blockControls) {
    if (!seen.has(id)) { group.remove(); blockControls.delete(id); }
  }
  lastControlsWidth = window.innerWidth;
}

function makeBlockControl(id: string): HTMLDivElement {
  const group = document.createElement('div');
  group.className = 'bfr-group';

  const play = document.createElement('button');
  play.className = 'bfr-play';
  play.title = 'Play from here to the end of the page';
  play.textContent = '▶';
  play.addEventListener('click', (e) => { stop(e); playFrom(id); });

  const minus = document.createElement('button');
  minus.className = 'bfr-minus';
  minus.dataset.role = 'minus';
  minus.addEventListener('click', (e) => { stop(e); toggleExclude(id); });

  group.append(play, minus);
  return group;
}

function positionBlockControl(group: HTMLDivElement, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  // Visibility is the hover class's job — display only hides collapsed blocks.
  if (r.width === 0 && r.height === 0) { group.style.display = 'none'; return; }
  group.style.display = 'flex';
  group.style.left = `${Math.max(2, r.left + window.scrollX - 30)}px`;
  group.style.top = `${r.top + window.scrollY + 2}px`;
}

/**
 * Reveal only the control group for the block under the pointer.
 *
 * Hiding is DELAYED: the controls sit out in the left margin, so reaching them
 * means crossing a strip of bare page that belongs to no block. Hiding the instant
 * the pointer leaves the text would pull the buttons away exactly as the user
 * moves to click them. Any hover on the block or on the group itself cancels the
 * pending hide.
 */
const HOVER_HIDE_DELAY_MS = 400;
let hoverHideTimer: number | null = null;

function setHoveredBlock(id: string | null): void {
  if (hoverHideTimer !== null) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  if (id === hoveredBlockId) return;
  if (id === null) {
    // Leaving: give the pointer time to reach the margin controls.
    const leaving = hoveredBlockId;
    hoverHideTimer = setTimeout(() => {
      hoverHideTimer = null;
      if (hoveredBlockId !== leaving) return;
      if (leaving) blockControls.get(leaving)?.classList.remove('bfr-hovered');
      hoveredBlockId = null;
    }, HOVER_HIDE_DELAY_MS) as unknown as number;
    return;
  }
  if (hoveredBlockId) blockControls.get(hoveredBlockId)?.classList.remove('bfr-hovered');
  hoveredBlockId = id;
  blockControls.get(id)?.classList.add('bfr-hovered');
}

function onPointerMove(e: MouseEvent): void {
  if (dead || !uiVisible) return;
  const target = e.target as HTMLElement | null;
  // Over our own controls: keep whatever is showing, so moving onto a button
  // doesn't make it vanish underneath the pointer.
  if (target && root.contains(target)) {
    if (hoverHideTimer !== null) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
    return;
  }
  setHoveredBlock(detectedBlockAt(target)?.id ?? null);
}

/** Reposition existing controls after a width change (reflow). */
function positionBlockControls(): void {
  for (const b of blocks) {
    const group = blockControls.get(b.id);
    if (group) positionBlockControl(group, b.el);
  }
}

/** Detected block at/above a node, or null. */
function detectedBlockAt(node: HTMLElement | null): { id: string; el: HTMLElement } | null {
  let el = node;
  while (el && el !== document.body) {
    const id = blockElToId.get(el);
    if (id) return { id, el };
    el = el.parentElement;
  }
  return null;
}

/**
 * True if a node at/above `node` would qualify as a readable block, applying the
 * same predicate as detectBlocks() (selector match, not excluded, enough text).
 * Used as a cheap per-hover check so we can refresh blocks the instant the user
 * points at text the last rescan hadn't captured yet — without paying for a full
 * scan on every mouse move.
 */
function looksLikeBlock(node: HTMLElement | null): boolean {
  let el = node;
  while (el && el !== document.body) {
    if (!root.contains(el) && el.matches(SELECTOR) && !el.closest(EXCLUDE)) {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      const min = /^H[1-6]$/.test(el.tagName) ? 12 : 60;
      if (text.length >= min) return true;
    }
    el = el.parentElement;
  }
  return false;
}

/**
 * Block at/above a node, refreshing the block set first if the node looks like
 * readable text the current scan missed (late-rendered SPA content). Keeps hover
 * and click responsive without waiting on the debounced rescan.
 */
function resolveBlockAt(node: HTMLElement | null): { id: string; el: HTMLElement } | null {
  let hit = detectedBlockAt(node);
  if (!hit && looksLikeBlock(node)) { rescan(); hit = detectedBlockAt(node); }
  return hit;
}

function updateBlockMinus(group: HTMLDivElement, id: string): void {
  const minus = group.querySelector('[data-role="minus"]') as HTMLButtonElement | null;
  if (!minus) return;
  const ex = excluded.has(id);
  minus.textContent = ex ? '↺' : '−';
  minus.title = ex ? 'Include this block again' : 'Skip this block (e.g. an ad)';
  minus.classList.toggle('bfr-restore', ex);
}

function blockText(el: HTMLElement): string {
  return (el.innerText || '').replace(/\s+/g, ' ').trim();
}

// ─── Continuous "play from here" + exclusions ──────────────────────────────────

/**
 * Play from a block (or a partial start, when clicked mid-paragraph) through the
 * rest of the page, skipping excluded blocks. The queue + prefetch auto-advance.
 */
function playFrom(startId: string, startChar = 0): void {
  const startIdx = blocks.findIndex((b) => b.id === startId);
  if (startIdx < 0) return;

  const items: { blockId: string; text: string; label: string; startChar?: number }[] = [];
  for (let i = startIdx; i < blocks.length; i++) {
    const b = blocks[i];
    if (excluded.has(b.id)) continue;
    const text = blockText(b.el);
    if (!text) continue;
    // The start block always carries its full text (so it's cacheable and matches
    // any existing cache entry); a mid-paragraph click rides along as startChar,
    // resolved to a sentence and reached by seeking the buffer instead of re-TTS.
    if (i === startIdx && startChar > 0) items.push({ blockId: b.id, text, label: preview(text), startChar });
    else items.push({ blockId: b.id, text, label: preview(text) });
  }
  if (!items.length) return;

  showBar();
  barEls.status.textContent = 'Connecting…';
  armWatchdog();
  send({ target: 'background', cmd: 'play-from', source: 'block', items });
}

function toggleExclude(id: string): void {
  if (excluded.has(id)) {
    excluded.delete(id);
  } else {
    excluded.add(id);
    // If it's already queued, drop it so the running read skips it now.
    send({ target: 'background', cmd: 'exclude-block', blockId: id });
  }
  const group = blockControls.get(id);
  if (group) updateBlockMinus(group, id);
  drawExcludeOverlays();
}

/** Dim/outline overlays over excluded blocks so the user sees what's skipped. */
function drawExcludeOverlays(): void {
  if (!excludeLayer) return;
  excludeLayer.textContent = '';
  for (const id of excluded) {
    const el = blockElFor(id);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const div = document.createElement('div');
    div.className = 'bfr-excluded';
    div.style.left = `${r.left + window.scrollX}px`;
    div.style.top = `${r.top + window.scrollY}px`;
    div.style.width = `${r.width}px`;
    div.style.height = `${r.height}px`;
    excludeLayer.appendChild(div);
  }
}

// ─── Click a word to start reading there ───────────────────────────────────────

function onDocClick(e: MouseEvent): void {
  if (dead || !uiVisible || e.button !== 0) return;
  const target = e.target as HTMLElement | null;
  if (!target || root.contains(target)) return; // our own buttons handle themselves
  // Don't hijack links/controls or an in-progress text selection.
  if (target.closest('a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="link"]')) return;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
  const hit = resolveBlockAt(target);
  if (!hit || excluded.has(hit.id)) return;

  const caret = caretRangeAt(e.clientX, e.clientY);
  const suffix = caret ? suffixFromCaret(caret, hit.el) : null;
  stop(e);
  // The suffix from the clicked word to the block end, measured against the full
  // block text, gives the char offset where playback should start. Offscreen maps
  // that to a sentence boundary and seeks the buffered/cached audio there.
  const full = blockText(hit.el);
  const startChar = suffix ? Math.max(0, full.length - suffix.length) : 0;
  playFrom(hit.id, startChar);
}

function caretRangeAt(x: number, y: number): Range | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (!pos) return null;
  const r = document.createRange();
  r.setStart(pos.offsetNode, pos.offset);
  return r;
}

/** The text from the start of the clicked word to the end of the block. Its length
 *  against the full block text gives the char offset where playback should begin. */
function suffixFromCaret(caret: Range, el: HTMLElement): string | null {
  try {
    const node = caret.startContainer;
    let offset = caret.startOffset;
    if (node.nodeType === Node.TEXT_NODE) {
      const v = node.nodeValue ?? '';
      while (offset > 0 && !/\s/.test(v[offset - 1])) offset--; // back up to the word start
    }
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(el, el.childNodes.length);
    const text = range.toString().replace(/\s+/g, ' ').trim();
    return text || null;
  } catch {
    return null;
  }
}

// ─── Selection control ────────────────────────────────────────────────────────

function buildSelectionControl(): void {
  selControl = document.createElement('div');
  selControl.className = 'bfr-sel';
  selControl.style.display = 'none';

  const play = document.createElement('button');
  play.className = 'bfr-ctl';
  play.textContent = '▶ Play';
  play.addEventListener('click', (e) => { stop(e); selectionAction('play'); });

  const add = document.createElement('button');
  add.className = 'bfr-ctl';
  add.textContent = '＋ Queue';
  add.addEventListener('click', (e) => { stop(e); selectionAction('enqueue'); });

  selControl.append(play, add);
  root.appendChild(selControl);
}

let pendingSelectionText = '';
let pendingSelectionRange: Range | null = null;
// DOM ranges for selection-sourced queue items (id → where the text lives), so we
// can highlight the reading sentence even though selections aren't detected blocks.
const selRanges = new Map<string, Range>();

function onSelectionChange(): void {
  if (dead) return;
  const sel = window.getSelection();
  if (!uiVisible || !sel || sel.isCollapsed || sel.rangeCount === 0) { hideSelControl(); return; }
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (text.length < 1) { hideSelControl(); return; }
  const range = sel.getRangeAt(0);
  // Skip selections inside our own UI.
  if (root.contains(range.commonAncestorContainer.parentElement)) { hideSelControl(); return; }
  const r = range.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) { hideSelControl(); return; }
  pendingSelectionText = text;
  pendingSelectionRange = range.cloneRange();
  selControl.style.left = `${r.left + window.scrollX}px`;
  selControl.style.top = `${r.bottom + window.scrollY + 6}px`;
  selControl.style.display = 'flex';
}

function hideSelControl(): void { selControl.style.display = 'none'; }

function selectionAction(cmd: 'play' | 'enqueue'): void {
  const text = pendingSelectionText;
  if (!text) return;
  const blockId = `sel-${++selCounter}`;
  // Remember where this text lives so the highlight can follow it as it's read.
  if (pendingSelectionRange) selRanges.set(blockId, pendingSelectionRange.cloneRange());
  if (cmd === 'play') { showBar(); barEls.status.textContent = 'Connecting…'; armWatchdog(); }
  send({ target: 'background', cmd, blockId, text, label: preview(text), source: 'selection' });
  hideSelControl();
  window.getSelection()?.removeAllRanges();
}

// ─── Transport bar ────────────────────────────────────────────────────────────

interface BarEls {
  voice: HTMLSelectElement;
  status: HTMLSpanElement;
  close: HTMLButtonElement;
  scrub: HTMLDivElement;
  renderedFill: HTMLDivElement;
  playedFill: HTMLDivElement;
  dot: HTMLSpanElement;
  timeLeft: HTMLSpanElement;
  timeRight: HTMLSpanElement;
  rewind: HTMLButtonElement;
  playPause: HTMLButtonElement;
  forward: HTMLButtonElement;
  speedPill: HTMLButtonElement;
  volume: HTMLInputElement;
  stop: HTMLButtonElement;
}

/**
 * 24×24 icon paths lifted from the Bookshelf player's icon set, so the two
 * transports read as the same product. Emoji glyphs (▶ ⏸ ↺) render inconsistently
 * across platforms — notably on Windows — which is why that app moved to inline SVG.
 */
const ICONS: Record<string, string> = {
  replay: 'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
  play: 'M8 5v14l11-7z',
  pause: 'M6 5h4v14H6zm8 0h4v14h-4z',
  stop: 'M6 6h12v12H6z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  minus: 'M19 13H5v-2h14v2z',
  volume: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z'
};

// Speed presets, same set the Bookshelf player offers, with ± for fine adjustment
// between them. Volume is a slider instead — it's a continuous "a bit louder"
// dial, not a set of values you'd name; 100% is normal and anything above is the
// Web Audio gain boosting past system volume.
const SPEED_PRESETS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75];
const SPEED_NUDGE = 0.05;

function icon(name: keyof typeof ICONS | string, size = 24): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', ICONS[name]);
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);
  return svg;
}

/**
 * One bar, always this shape — two rows and nothing to fold away:
 *
 *   progress   elapsed  ‹4px track, rendered overlay, position dot›  total
 *   controls   status · speed · volume │ ⏪ ▶ ⏩ │ voice · stop · ✕
 *
 * The transport sits between two rules with the progress bar directly above it,
 * so the two things you actually reach for are together in the middle. The bar is
 * sized to its contents rather than to a fixed width — that's what keeps the
 * settings from crowding the transport at one end and leaving a hole at the other.
 * The skip buttons are the Bookshelf player's replay glyph with
 * the seconds centred in it (mirrored for forward), and speed opens the same kind
 * of preset shelf that app uses.
 */
function buildBar(): void {
  bar = document.createElement('div');
  bar.id = 'bfr-bar';
  bar.style.display = 'none';

  // Voice picking is binding: generation stops, the engine loads that model, and
  // the read restarts in it once the engine confirms. No prompt; choosing from the
  // list IS the instruction.
  const voice = document.createElement('select');
  voice.className = 'bfr-voice';
  voice.title = 'Voice';
  voice.addEventListener('change', () => {
    const v = voice.value;
    try { void chrome.storage.local.set({ voice: v }); } catch { /* orphaned context */ }
    send({ target: 'background', cmd: 'set-voice', voice: v });
  });

  const status = document.createElement('span');
  status.className = 'bfr-status';

  // ✕ dismisses the whole on-page UI — the bar AND the per-block play/− buttons —
  // and releases the rendered audio. The toolbar popup brings it all back.
  const close = iconBtn('close', 18, 'Close reader controls', () => {
    send({ target: 'background', cmd: 'transport', op: 'close' });
    toggleUi(false);
  });
  close.classList.add('bfr-close');

  // ── Scrub — one bar for the whole read ──
  // Dim track = the rest of the page; the translucent overlay is how much has been
  // rendered; the solid fill is what's been played. Dragging seeks, but only within
  // the rendered part — there's nothing to play past it.
  const scrub = document.createElement('div');
  scrub.className = 'bfr-scrub';
  scrub.setAttribute('role', 'slider');
  scrub.setAttribute('aria-label', 'Position');
  const scrubTrack = document.createElement('div');
  scrubTrack.className = 'bfr-scrub-track';
  const renderedFill = document.createElement('div');
  renderedFill.className = 'bfr-seg-rendered';
  const playedFill = document.createElement('div');
  playedFill.className = 'bfr-seg-played';
  scrubTrack.append(renderedFill, playedFill);
  const dot = document.createElement('span');
  dot.className = 'bfr-scrub-dot';
  scrub.append(scrubTrack, dot);
  wireScrub(scrub);

  // Times flank the track rather than sitting on their own line — the point of the
  // single bar is that the progress row is as short as a row can be.
  const timeLeft = document.createElement('span');
  timeLeft.className = 'bfr-time';
  const timeRight = document.createElement('span');
  timeRight.className = 'bfr-time bfr-time-right';
  const progress = document.createElement('div');
  progress.className = 'bfr-progress';
  progress.append(timeLeft, scrub, timeRight);

  // ── Transport ──
  const transport = document.createElement('div');
  transport.className = 'bfr-transport';
  const rewind = skipBtn(-5, 'Back 5 seconds');
  // Always play/pause — even while buffering, pausing just holds playback while the
  // buffer keeps filling.
  const playPause = iconBtn('pause', 30, 'Pause', () =>
    send({ target: 'background', cmd: 'transport', op: 'toggle-pause' }));
  playPause.classList.add('bfr-tbtn', 'bfr-play');
  const forward = skipBtn(5, 'Forward 5 seconds');
  transport.append(rewind, playPause, forward);

  // ── Settings, right of the divider ──
  const speedPill = document.createElement('button');
  speedPill.className = 'bfr-tool bfr-speed-pill';
  speedPill.title = 'Playback speed';
  speedPill.textContent = speedLabel(settings.rate);

  // Volume amplifies above system volume via the offscreen GainNode (1 = normal,
  // up to 3×). A plain <audio>.volume can't exceed 1, hence Web Audio.
  const { el: volumeEl, input: volume } = buildVolumeSlider();

  // Stop is not a playback control — it ends the read and cancels rendering — so
  // it sits over here with the settings rather than beside play/pause. Audio
  // already rendered is kept, so replaying costs nothing.
  const stopBtn = iconBtn('stop', 18, 'Stop reading (keeps what has been rendered)', () =>
    send({ target: 'background', cmd: 'transport', op: 'stop' }));
  stopBtn.classList.add('bfr-tool', 'bfr-stop');

  const rule = () => {
    const d = document.createElement('div');
    d.className = 'bfr-divider';
    return d;
  };

  // Speed and volume are the two settings you reach for mid-read, so they sit on
  // the near side of the transport; voice/stop/✕ are the ones you touch once, and
  // they stay on the far side. A rule on each side brackets the transport.
  const lead = document.createElement('div');
  lead.className = 'bfr-lead';
  lead.append(status, speedPill, volumeEl, rule());

  const trail = document.createElement('div');
  trail.className = 'bfr-trail';
  trail.append(rule(), voice, stopBtn, close);

  const row = document.createElement('div');
  row.className = 'bfr-row';
  row.append(lead, transport, trail);

  // Speed opens a shelf under the bar: the values you actually pick, as buttons,
  // with ± for the gaps between them. A 4px target you have to land precisely on
  // is a bad way to ask for "1.5×" — but it's exactly right for "a bit louder",
  // which is why volume is the slider and speed isn't.
  speedShelf = makeShelf({
    title: 'Speed',
    presets: SPEED_PRESETS,
    min: SPEED_MIN,
    max: SPEED_MAX,
    nudge: SPEED_NUDGE,
    format: speedLabel,
    get: () => settings.rate,
    set: (v) => {
      settings.rate = v;
      speedHoldUntil = Date.now() + SPEED_HOLD_MS; // don't let a stale tick snap it back
      speedPill.textContent = speedLabel(v);
      try { void chrome.storage.local.set({ rate: v }); } catch { /* orphaned context */ }
      send({ target: 'background', cmd: 'transport', op: 'rate', rate: v });
    }
  });
  wireShelfToggle(speedPill, speedShelf);

  bar.append(progress, row, speedShelf.el);
  wireDrag();
  barEls = {
    voice, status, close,
    scrub, renderedFill, playedFill, dot,
    timeLeft, timeRight,
    rewind, playPause, forward,
    speedPill, volume, stop: stopBtn
  };
  root.appendChild(bar);
}

/**
 * Volume as a slider: a speaker glyph and a short track. The fill is painted with
 * a gradient driven by --bfr-vol rather than a second element, so there's nothing
 * to keep in sync with the thumb. Changes go out on every input event — the
 * offscreen player just sets a gain value, so dragging is live, not stepped.
 */
function buildVolumeSlider(): { el: HTMLDivElement; input: HTMLInputElement } {
  const el = document.createElement('div');
  el.className = 'bfr-volume';
  el.appendChild(icon('volume', 16));

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'bfr-volume-slider';
  input.min = '0';
  input.max = String(VOLUME_MAX);
  input.step = '0.05';
  input.value = String(settings.volume);

  const paint = (v: number) => {
    input.style.setProperty('--bfr-vol', `${(v / VOLUME_MAX) * 100}%`);
    input.title = `Volume ${volumeLabel(v)} (100% is normal; above that boosts past system volume)`;
    el.classList.toggle('bfr-muted', v <= 0);
  };
  paint(settings.volume);

  input.addEventListener('input', () => {
    const v = Math.min(VOLUME_MAX, Math.max(0, Number(input.value)));
    settings.volume = v;
    paint(v);
    try { void chrome.storage.local.set({ volume: v }); } catch { /* orphaned context */ }
    send({ target: 'background', cmd: 'transport', op: 'volume', volume: v });
  });

  el.appendChild(input);
  return { el, input };
}

// ─── Drag ─────────────────────────────────────────────────────────────────────
//
// What keeps this from taking over someone's page is that it's one short bar and
// that it can be dragged anywhere — a fixed bottom-centre panel WILL sit on top of
// the one paragraph you're trying to read otherwise. Where it's put is remembered.

/** Where the bar sits once dragged: distance from the viewport's left and BOTTOM
 *  edges. Anchoring to the bottom (not the top) keeps the bar put when the speed
 *  shelf opens — it grows upward instead of shoving the bar down off the edge.
 *  null = default spot. */
let barPos: { left: number; bottom: number } | null = null;
const BAR_MARGIN = 8; // keep this much of the bar on screen when clamping

function applyBarPos(): void {
  if (!barPos) {
    bar.classList.remove('bfr-placed');
    bar.style.removeProperty('--bfr-x');
    bar.style.removeProperty('--bfr-b');
    return;
  }
  bar.classList.add('bfr-placed');
  bar.style.setProperty('--bfr-x', `${barPos.left}px`);
  bar.style.setProperty('--bfr-b', `${barPos.bottom}px`);
}

/** Keep the bar reachable after a drag, a resize, or a shelf that resized it. */
function clampBarPos(): void {
  if (!barPos) return;
  const r = bar.getBoundingClientRect();
  const maxLeft = Math.max(BAR_MARGIN, window.innerWidth - r.width - BAR_MARGIN);
  const maxBottom = Math.max(BAR_MARGIN, window.innerHeight - r.height - BAR_MARGIN);
  barPos = {
    left: Math.min(maxLeft, Math.max(BAR_MARGIN, barPos.left)),
    bottom: Math.min(maxBottom, Math.max(BAR_MARGIN, barPos.bottom))
  };
  applyBarPos();
}

/**
 * Drag from anywhere on the bar — it's almost entirely buttons, so a "grab the
 * chrome" handle would be a few stray pixels. A press only becomes a drag once the
 * pointer has moved past a threshold; below that it's still a click, so the buttons
 * keep working. The click that follows a real drag is swallowed.
 */
const DRAG_THRESHOLD_PX = 4;

function wireDrag(): void {
  let press: { x: number; y: number; grabX: number; grabY: number; id: number } | null = null;
  let dragging = false;
  let swallowClick = false;
  // Captured once per drag: the panel can't change size mid-drag, and measuring
  // every pointermove would force a layout on each frame.
  let dragHeight = 0;

  bar.addEventListener('pointerdown', (e) => {
    // The scrubber and the volume slider own their own pointer handling, and a
    // native <select> needs its press to open the dropdown.
    const t = e.target as HTMLElement | null;
    if (t?.closest('.bfr-scrub, select, input[type="range"]')) return;
    const r = bar.getBoundingClientRect();
    press = { x: e.clientX, y: e.clientY, grabX: e.clientX - r.left, grabY: e.clientY - r.top, id: e.pointerId };
  });

  bar.addEventListener('pointermove', (e) => {
    if (!press) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      // The first drag converts from the bottom-centre anchor to real coordinates.
      const r = bar.getBoundingClientRect();
      dragHeight = r.height;
      barPos = { left: r.left, bottom: window.innerHeight - r.bottom };
      applyBarPos();
      bar.classList.add('bfr-dragging');
      try { bar.setPointerCapture(press.id); } catch { /* not captureable */ }
    }
    const top = e.clientY - press.grabY;
    barPos = { left: e.clientX - press.grabX, bottom: window.innerHeight - top - dragHeight };
    applyBarPos();
  });

  const end = (e: PointerEvent) => {
    if (!press) return;
    const moved = dragging;
    press = null;
    dragging = false;
    bar.classList.remove('bfr-dragging');
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    if (!moved) return;
    clampBarPos();
    try { void chrome.storage.local.set({ barPos }); } catch { /* orphaned context */ }
    // Don't let the drag's terminating click also press whatever is under it.
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 0);
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('click', (e) => {
    if (!swallowClick) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/** Restore where the bar was dragged to. */
async function restoreBarLayout(): Promise<void> {
  let stored: { barPos?: { left?: number; bottom?: number } } = {};
  try { stored = await chrome.storage.local.get('barPos'); } catch { /* orphaned */ }
  const pos = stored.barPos;
  // Positions written before the switch to bottom-anchoring have no `bottom`;
  // drop them rather than guessing — it costs one re-drag, once.
  if (pos && typeof pos.left === 'number' && typeof pos.bottom === 'number') {
    barPos = { left: pos.left, bottom: pos.bottom };
    applyBarPos();
    clampBarPos();
  }
}

// ─── Speed shelf ──────────────────────────────────────────────────────────────

interface Shelf {
  el: HTMLDivElement;
  pill: HTMLButtonElement | null;
  sync: () => void;
}
let speedShelf: Shelf;

interface ShelfSpec {
  title: string;
  presets: number[];
  min: number;
  max: number;
  nudge: number;
  format: (v: number) => string;
  get: () => number;
  set: (v: number) => void;
}

/**
 * A disclosure shelf under the bar: the presets as real buttons, the current value
 * called out, and −/+ for the values in between. Modelled on the player's speed
 * sheet, which uses the same preset row.
 */
function makeShelf(spec: ShelfSpec): Shelf {
  const el = document.createElement('div');
  el.className = 'bfr-shelf';

  const head = document.createElement('div');
  head.className = 'bfr-shelf-head';
  const title = document.createElement('span');
  title.className = 'bfr-shelf-title';
  title.textContent = spec.title;
  const value = document.createElement('span');
  value.className = 'bfr-shelf-val';
  head.append(title, value);

  const apply = (v: number) => {
    const clamped = Math.min(spec.max, Math.max(spec.min, Math.round(v * 100) / 100));
    spec.set(clamped);
    shelf.sync();
  };

  const row = document.createElement('div');
  row.className = 'bfr-shelf-row';
  const minus = iconBtn('minus', 18, `Less ${spec.title.toLowerCase()}`, () => apply(spec.get() - spec.nudge));
  minus.classList.add('bfr-round');
  const plus = iconBtn('plus', 18, `More ${spec.title.toLowerCase()}`, () => apply(spec.get() + spec.nudge));
  plus.classList.add('bfr-round');

  const grid = document.createElement('div');
  grid.className = 'bfr-preset-grid';
  const buttons = spec.presets.map((p) => {
    const b = document.createElement('button');
    b.className = 'bfr-preset';
    b.textContent = spec.format(p);
    b.addEventListener('click', (e) => { stop(e); apply(p); });
    grid.appendChild(b);
    return b;
  });
  row.append(minus, grid, plus);
  el.append(head, row);

  const shelf: Shelf = {
    el,
    pill: null,
    sync: () => {
      const v = spec.get();
      value.textContent = spec.format(v);
      buttons.forEach((b, i) => b.classList.toggle('bfr-on', Math.abs(spec.presets[i] - v) < 0.001));
    }
  };
  shelf.sync();
  return shelf;
}

/** Clicking the tool that opened a shelf closes it again. */
function wireShelfToggle(pill: HTMLButtonElement, shelf: Shelf): void {
  shelf.pill = pill;
  pill.addEventListener('click', (e) => {
    stop(e);
    const opening = !shelf.el.classList.contains('bfr-open');
    closeShelves();
    if (opening) {
      shelf.sync();
      shelf.el.classList.add('bfr-open');
      pill.classList.add('bfr-active');
    }
  });
}

function closeShelves(): void {
  for (const s of [speedShelf]) {
    if (!s) continue;
    s.el.classList.remove('bfr-open');
    s.pill?.classList.remove('bfr-active');
  }
}

/** A round icon button. */
function iconBtn(name: string, size: number, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'bfr-ctl';
  b.title = title;
  b.appendChild(icon(name, size));
  b.addEventListener('click', (e) => { stop(e); onClick(); });
  return b;
}

/** ±N-second skip: the replay glyph with the seconds inside it, mirrored forward. */
function skipBtn(delta: number, title: string): HTMLButtonElement {
  const b = iconBtn('replay', 30, title, () =>
    send({ target: 'background', cmd: 'transport', op: 'seek', delta }));
  b.classList.add('bfr-tbtn', 'bfr-skip');
  if (delta > 0) b.classList.add('bfr-fwd');
  const num = document.createElement('span');
  num.className = 'bfr-skip-num';
  num.textContent = String(Math.abs(delta));
  b.appendChild(num);
  return b;
}

// ─── Scrubber: drag/click to seek ─────────────────────────────────────────────

// While the user is dragging, renderBar must not fight them with the 300 ms
// status ticks; the dot follows the pointer and the seek is sent on release.
let scrubbing = false;
let scrubFraction = 0;

function wireScrub(scrub: HTMLDivElement): void {
  const fractionAt = (clientX: number): number => {
    const r = scrub.getBoundingClientRect();
    if (r.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  // Never let a seek land past what's rendered — there's no audio out there yet.
  const clamp = (f: number): number => {
    const run = lastUi?.run;
    if (!run || run.total <= 0) return 0;
    const limit = Math.min(1, run.rendered / run.total);
    return Math.min(f, limit);
  };

  const move = (e: PointerEvent) => {
    if (!scrubbing) return;
    scrubFraction = clamp(fractionAt(e.clientX));
    paintScrub(scrubFraction);
  };
  const end = (e: PointerEvent) => {
    if (!scrubbing) return;
    scrubbing = false;
    try { scrub.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    const total = lastUi?.run.total ?? 0;
    send({ target: 'background', cmd: 'transport', op: 'seek-run', position: scrubFraction * total });
  };

  // The whole track is the grab target — pointerdown seeks to the touch point and
  // every pointer drives the seek, so a drag can start anywhere on it.
  scrub.addEventListener('pointerdown', (e) => {
    if (!lastUi || lastUi.run.total <= 0) return;
    scrubbing = true;
    scrubFraction = clamp(fractionAt(e.clientX));
    paintScrub(scrubFraction);
    try { scrub.setPointerCapture(e.pointerId); } catch { /* not captureable */ }
    e.preventDefault();
  });
  scrub.addEventListener('pointermove', move);
  scrub.addEventListener('pointerup', end);
  scrub.addEventListener('pointercancel', end);
}

/** Paint the played fill + position dot at a fraction of the track. */
function paintScrub(fraction: number): void {
  const pct = `${(fraction * 100).toFixed(2)}%`;
  barEls.playedFill.style.width = pct;
  barEls.dot.style.left = pct;
}

const VOLUME_MAX = 3;
function volumeLabel(v: number): string {
  return `${Math.round(v * 100)}%`;
}


// The bar floats up into place rather than blinking on. `display` still does the
// real hiding (so a hidden bar can't be hovered or tabbed into), but it's flipped
// on either side of the transition: shown a frame BEFORE the animation so there's
// a laid-out element to animate, and hidden a beat AFTER it so the exit is seen.
const BAR_EXIT_MS = 260;
let barVisible = false;
let barHideTimer: number | null = null;

function showBar(): void {
  if (barHideTimer !== null) { clearTimeout(barHideTimer); barHideTimer = null; }
  if (barVisible) return;
  barVisible = true;
  bar.style.display = 'flex';
  void bar.offsetWidth; // flush layout so the transition starts from the down state
  bar.classList.add('bfr-in');
}

function hideBar(): void {
  if (barHideTimer !== null) { clearTimeout(barHideTimer); barHideTimer = null; }
  if (!barVisible) { bar.style.display = 'none'; return; }
  barVisible = false;
  bar.classList.remove('bfr-in');
  barHideTimer = setTimeout(() => {
    barHideTimer = null;
    if (!barVisible) bar.style.display = 'none';
  }, BAR_EXIT_MS) as unknown as number;
}

function renderBar(ui: UiState): void {
  const p = ui.playback;
  const run = ui.run;
  setPlayPause(barEls.playPause, p);

  // One bar for the whole read: how much has been rendered, and where we are in it.
  const total = run.total > 0 ? run.total : 0;
  const renderedFrac = total > 0 ? Math.min(1, run.rendered / total) : 0;
  barEls.renderedFill.style.width = `${(renderedFrac * 100).toFixed(2)}%`;
  if (!scrubbing) paintScrub(total > 0 ? Math.min(1, run.position / total) : 0);
  barEls.scrub.classList.toggle('bfr-idle', total <= 0);

  // Elapsed left, total right. How far rendering has got ahead is the translucent
  // overlay on the track itself — the number that used to say it lived on a third
  // row, and the bar is one row shorter without it. It's on the track's tooltip.
  const shown = scrubbing ? scrubFraction * total : run.position;
  barEls.timeLeft.textContent = total > 0 ? formatTime(shown) : '';
  barEls.timeRight.textContent = total > 0 ? `${run.estimated ? '~' : ''}${formatTime(total)}` : '';
  const fullyRendered = total > 0 && renderedFrac >= 0.999;
  barEls.scrub.title = total > 0 && !fullyRendered ? `${formatTime(run.rendered)} rendered` : '';

  const headroom = Math.max(0, p.buffered - p.position);
  barEls.rewind.disabled = run.position <= 0.3;
  barEls.forward.disabled = headroom <= (p.totalKnown ? 0.6 : 5.2);

  const status = statusText(ui);
  barEls.status.textContent = status;
  // The pill ellipsises rather than shoving the transport off centre, so the whole
  // message — an error or the watchdog's reload instructions — lives on the tooltip.
  barEls.status.title = status;
  // Collapse the pill when there's nothing to report, so a playing bar is just
  // voice, progress and transport.
  barEls.status.style.display = status ? '' : 'none';
  // Make working states (connecting / starting engine / loading a voice /
  // buffering) obvious — a prominent pill with a spinner.
  barEls.status.classList.toggle('bfr-working', !!ui.switchingVoice || LOADING_STATES.has(p.state));

  // Adopt the player's rate, but not while a just-made local change is still
  // round-tripping — the 300ms ticks would snap the label back to the old value.
  if (Date.now() >= speedHoldUntil && settings.rate !== p.rate) {
    settings.rate = p.rate;
    barEls.speedPill.textContent = speedLabel(p.rate);
    speedShelf?.sync();
  }
  syncVoiceOptions(ui.voices, ui.switchingVoice ?? ui.currentVoice);
}

function formatTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

// Rebuild the voice <option>s only when the list changes, and reflect the shared
// current voice — so the in-page picker stays in lockstep with the app Settings
// and popup pickers (the server broadcasts every change). Hidden until voices exist.
let barVoicesSig: string | null = null;
function syncVoiceOptions(voices: string[], currentVoice: string | null): void {
  const sig = voices.join('|');
  if (sig !== barVoicesSig) {
    barVoicesSig = sig;
    barEls.voice.textContent = '';
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = v;
      barEls.voice.appendChild(o);
    }
  }
  barEls.voice.classList.toggle('bfr-hidden', voices.length === 0);
  // Don't clobber the dropdown while the user has it open.
  if (currentVoice && document.activeElement !== barEls.voice && barEls.voice.value !== currentVoice) {
    barEls.voice.value = currentVoice;
  }
}

function speedLabel(rate: number): string {
  // Trim trailing zeros: 1 → "1×", 1.25 → "1.25×", 1.5 → "1.5×".
  return `${Number(rate.toFixed(2))}×`;
}

/**
 * "Working" states where playback hasn't started or has stalled. The play/pause
 * control shows a disabled spinner-on-pause for these — never a play arrow — so a
 * brief boundary reload or engine spin-up doesn't flip the button to ▶.
 */
const LOADING_STATES = new Set<PlaybackStatus['state']>(['connecting', 'starting-engine', 'buffering']);

/**
 * Drive the play/pause button: playing ⇒ ⏸; stopped/ended ⇒ ▶; while
 * loading/buffering ⇒ ⏸ with a spinner ring over it (clicking pauses but keeps the
 * buffer filling). A user pause wins over a loading state — it shows ▶ so you can
 * resume, even while generation continues ahead. Keyed by mode so the spinner's
 * animation isn't restarted on every 300 ms render tick.
 */
function setPlayPause(btn: HTMLButtonElement, p: PlaybackStatus): void {
  const loading = LOADING_STATES.has(p.state);
  const mode = p.paused ? 'play' : loading ? 'loading' : p.state === 'playing' ? 'pause' : 'play';
  if (btn.dataset.mode === mode) return;
  btn.dataset.mode = mode;
  btn.classList.toggle('bfr-loading', mode === 'loading');
  btn.disabled = false;
  btn.textContent = '';
  btn.appendChild(icon(mode === 'pause' || mode === 'loading' ? 'pause' : 'play', 30));
  if (mode === 'loading') {
    btn.title = 'Pause (keeps buffering)';
    const sp = document.createElement('span');
    sp.className = 'bfr-spinner';
    btn.appendChild(sp);
  } else {
    btn.title = mode === 'pause' ? 'Pause' : 'Play';
  }
}

function statusText(ui: UiState): string {
  // A voice switch is a model load — say so, it's the slowest thing here.
  if (ui.switchingVoice) return `Loading ${ui.switchingVoice}…`;
  const p = ui.playback;
  let base: string;
  switch (p.state) {
    case 'connecting': base = 'Connecting…'; break;
    case 'starting-engine': base = 'Starting engine (~1 min)…'; break;
    case 'buffering': base = 'Buffering…'; break;
    case 'paused': base = 'Paused'; break;
    case 'ended': base = 'Done'; break;
    case 'error': base = p.error || 'Error'; break;
    default: base = '';
  }
  return p.note ? (base ? `${base} — ${p.note}` : p.note) : base;
}

// ─── Incoming messages ────────────────────────────────────────────────────────

function onMessage(raw: RuntimeMessage): void {
  if (!raw || (raw as { target?: string }).target !== 'content') return;
  if (raw.cmd === 'toggle-ui') { toggleUi(raw.show); return; }
  if (raw.cmd === 'ui') { clearWatchdog(); lastUi = normalizeUi(raw.ui); applyUi(lastUi); }
}

/**
 * The four extension contexts reload independently — Chrome can leave an old
 * service worker or offscreen document running while a page gets a freshly
 * injected content script — so a UiState can arrive missing fields this build
 * expects. Fill them in rather than throwing: an exception in renderBar takes the
 * WHOLE toolbar down (no voice list, no progress bar, no block marks) for what is
 * a transient mismatch that a reload resolves.
 */
function normalizeUi(ui: UiState): UiState {
  return {
    ...ui,
    run: ui.run ?? { ...EMPTY_RUN },
    renderedBlockIds: ui.renderedBlockIds ?? [],
    upcomingBlockIds: ui.upcomingBlockIds ?? [],
    voices: ui.voices ?? [],
    switchingVoice: ui.switchingVoice ?? null
  };
}

function applyUi(ui: UiState): void {
  // Closed stays closed. Status keeps arriving after the ✕ (a stop still has to
  // report itself), and showing the bar for it is what made ✕ blink the bar away
  // and put it straight back. Nothing to draw while hidden — toggling the UI back
  // on re-syncs, so the redraw isn't lost.
  if (!uiVisible) { hideBar(); return; }
  // The bar is part of the on-page controls: it stays up whenever they're shown,
  // idle included (that just renders an idle transport).
  showBar();
  renderBar(ui);
  const renderedSig = ui.renderedBlockIds.join('|');
  if (renderedSig !== renderedBlockIds.join('|')) {
    renderedBlockIds = ui.renderedBlockIds;
    drawRenderMarks();
  }
  updateHighlight(ui);
}

// ─── Reading-sentence highlight ───────────────────────────────────────────────

interface CharPos { node: Text; offset: number; }
interface CharRange { start: number; end: number; } // indices into the block's raw text

const HL_STATES = new Set<PlaybackStatus['state']>(['playing', 'buffering', 'paused']);
const ALNUM = /[\p{L}\p{N}]/u;

function blockElFor(blockId: string): HTMLElement | null {
  return blocks.find((b) => b.id === blockId)?.el ?? null;
}

function updateHighlight(ui: UiState): void {
  const p = ui.playback;
  const blockId = ui.currentBlockId;
  pruneSelRanges(ui);
  if (!blockId || !HL_STATES.has(p.state) || p.sentenceIndex < 0 || p.sentences.length === 0) {
    clearHighlight();
    return;
  }
  // Block reads highlight inside the detected element; selection reads highlight
  // inside the DOM range we stored when the user queued the selection.
  const source: HTMLElement | Range | null = selRanges.get(blockId) ?? blockElFor(blockId);
  if (!source) { clearHighlight(); return; }
  ensureSentenceRanges(blockId, source, p.sentences);
  const key = `${blockId}#${p.sentenceIndex}`;
  if (key === hlKey && hlCurrentRange) return; // same sentence still showing
  const range = rangeForSentence(p.sentenceIndex);
  if (!range) { clearHighlight(); return; }
  hlKey = key;
  hlCurrentRange = range;
  drawHighlightRects(range);
  maybeAutoScroll(range);
}

/** Keep the reading sentence on screen as it advances down the page (only scrolls
 *  when it drifts out of a comfortable band, so it doesn't fight manual scrolling). */
function maybeAutoScroll(range: Range): void {
  try {
    const r = range.getBoundingClientRect();
    if (r.height === 0) return;
    const margin = 96;
    if (r.top >= margin && r.bottom <= window.innerHeight - margin) return; // already comfortably in view
    const targetY = window.scrollY + r.top - window.innerHeight * 0.4;
    window.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
  } catch { /* ignore */ }
}

function clearHighlight(): void {
  hlCurrentRange = null;
  hlKey = '';
  if (highlightLayer) highlightLayer.textContent = '';
}

/** Forget stored selection ranges no longer in the queue, to bound the map. */
function pruneSelRanges(ui: UiState): void {
  if (selRanges.size === 0) return;
  const keep = new Set<string>(ui.upcomingBlockIds);
  if (ui.currentBlockId) keep.add(ui.currentBlockId);
  for (const id of selRanges.keys()) if (!keep.has(id)) selRanges.delete(id);
}

interface TextIndex { pos: CharPos[]; alnum: string; alnumToRaw: number[]; }

/** Rebuild the per-sentence DOM ranges when the source or its segmentation changes. */
function ensureSentenceRanges(key: string, source: HTMLElement | Range, sentences: string[]): void {
  const sig = `${key}|${sentences.length}|${sentences[0]?.slice(0, 16) ?? ''}|${sentences[sentences.length - 1]?.slice(-16) ?? ''}`;
  if (hlSig === sig && hlSource === source) return;
  hlSig = sig;
  hlSource = source;

  // Flatten the source's text into one string with a char→(node,offset) map, plus
  // an alphanumeric-only projection (so abbreviation normalization, smart quotes,
  // and whitespace differences between the server's text and the DOM don't break
  // the match). Each sentence is located by its alnum fingerprint, searching
  // forward so repeated phrases land in reading order.
  const idx = source instanceof Range ? indexRange(source) : indexElement(source);

  const ranges: (CharRange | null)[] = [];
  let cursor = 0;
  for (const sentence of sentences) {
    const fp = fingerprint(sentence);
    if (!fp) { ranges.push(null); continue; }
    let at = idx.alnum.indexOf(fp, cursor);
    if (at === -1) at = idx.alnum.indexOf(fp); // retry from start if a gap was skipped
    if (at === -1) { ranges.push(null); continue; }
    ranges.push({ start: idx.alnumToRaw[at], end: idx.alnumToRaw[at + fp.length - 1] });
    cursor = at + fp.length;
  }

  hlPos = idx.pos;
  hlRanges = ranges;
}

function pushChars(idx: TextIndex, node: Text, from: number, to: number): void {
  const v = node.nodeValue ?? '';
  for (let i = from; i < to; i++) {
    idx.pos.push({ node, offset: i });
    if (ALNUM.test(v[i])) { idx.alnum += v[i].toLowerCase(); idx.alnumToRaw.push(idx.pos.length - 1); }
  }
}

function indexElement(el: HTMLElement): TextIndex {
  const idx: TextIndex = { pos: [], alnum: '', alnumToRaw: [] };
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    pushChars(idx, node, 0, (node.nodeValue ?? '').length);
  }
  return idx;
}

function indexRange(range: Range): TextIndex {
  const idx: TextIndex = { pos: [], alnum: '', alnumToRaw: [] };
  const rootNode = range.commonAncestorContainer;
  const scope: Node = rootNode.nodeType === Node.TEXT_NODE ? (rootNode.parentNode ?? rootNode) : rootNode;
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (!range.intersectsNode(node)) continue;
    const len = (node.nodeValue ?? '').length;
    const from = node === range.startContainer && range.startContainer.nodeType === Node.TEXT_NODE ? range.startOffset : 0;
    const to = node === range.endContainer && range.endContainer.nodeType === Node.TEXT_NODE ? range.endOffset : len;
    pushChars(idx, node, from, to);
  }
  return idx;
}

function fingerprint(text: string): string {
  let out = '';
  for (const ch of text) if (ALNUM.test(ch)) out += ch.toLowerCase();
  return out;
}

function rangeForSentence(index: number): Range | null {
  if (!hlRanges || !hlPos) return null;
  const r = hlRanges[index];
  if (!r) return null;
  const startPos = hlPos[r.start];
  const endPos = hlPos[r.end];
  if (!startPos || !endPos) return null;
  try {
    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset + 1);
    return range;
  } catch {
    return null;
  }
}

/** Paint one translucent rect per visual line of the range, in document coords. */
function drawHighlightRects(range: Range): void {
  highlightLayer.textContent = '';
  let rects: DOMRectList;
  try { rects = range.getClientRects(); } catch { return; }
  for (const rect of Array.from(rects)) {
    if (rect.width === 0 || rect.height === 0) continue;
    const div = document.createElement('div');
    div.className = 'bfr-hl';
    div.style.left = `${rect.left + window.scrollX}px`;
    div.style.top = `${rect.top + window.scrollY}px`;
    div.style.width = `${rect.width}px`;
    div.style.height = `${rect.height}px`;
    highlightLayer.appendChild(div);
  }
}

/** Redraw position-dependent overlays (highlight, exclusions, hover control) after
 *  a scroll/resize, throttled to one animation frame. */
function scheduleViewportSync(): void {
  if (dead || hlRaf) return;
  hlRaf = requestAnimationFrame(() => {
    hlRaf = 0;
    if (hlCurrentRange) drawHighlightRects(hlCurrentRange);
    if (excluded.size) drawExcludeOverlays();
    if (renderedBlockIds.length) drawRenderMarks();
    // Margin controls use document coordinates (scroll-invariant); only a width
    // change reflows the text, so reposition them just then.
    if (window.innerWidth !== lastControlsWidth) { lastControlsWidth = window.innerWidth; positionBlockControls(); }
  }) as unknown as number;
}

// ─── Watchdog: surface a dead player pipe instead of hanging ───────────────────

function armWatchdog(): void {
  clearWatchdog();
  watchdog = setTimeout(() => {
    showBar();
    const msg = 'No response from the player — reload BookForge Reader at chrome://extensions, then reload this page.';
    barEls.status.textContent = msg;
    barEls.status.title = msg; // too long for the pill; the tooltip carries it whole
  }, 3000) as unknown as number;
}
function clearWatchdog(): void {
  if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
}

// ─── Visibility + plumbing ────────────────────────────────────────────────────

function toggleUi(show?: boolean): void {
  uiVisible = show === undefined ? !uiVisible : show;
  // Showing the on-page UI brings up the transport bar alongside the per-block
  // controls (rescan rebuilds those) — not just the play buttons.
  if (uiVisible) { root.style.display = ''; showBar(); rescan(); requestSync(); }
  else { hideBar(); hideSelControl(); clearHighlight(); root.style.display = 'none'; }
}

function requestSync(): void {
  send({ target: 'background', cmd: 'sync' });
}

function buildRoot(): void {
  root = document.createElement('div');
  root.id = 'bfr-root';
  excludeLayer = document.createElement('div');
  excludeLayer.className = 'bfr-excluded-layer';
  renderLayer = document.createElement('div');
  renderLayer.className = 'bfr-render-layer';
  highlightLayer = document.createElement('div');
  highlightLayer.className = 'bfr-hl-layer';
  controlsLayer = document.createElement('div');
  controlsLayer.className = 'bfr-controls-layer';
  root.append(excludeLayer, renderLayer, highlightLayer, controlsLayer);
  document.documentElement.appendChild(root);
}

function preview(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function stop(e: Event): void { e.preventDefault(); e.stopPropagation(); }

/** False once this script has been orphaned by an extension reload/update. */
function contextOk(): boolean {
  // Accessing chrome.runtime.id throws ("context invalidated") when orphaned.
  try { return !dead && !!chrome.runtime?.id; } catch { return false; }
}

function send(msg: RuntimeMessage): void {
  if (!contextOk()) { teardown(); return; }
  try {
    // Orphaned contexts throw synchronously here, so the .catch alone isn't enough.
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => { /* background wakes on next */ });
  } catch {
    teardown();
  }
}

/** Stop all work and remove our UI; the page keeps a clean slate for the reloaded
 *  extension to re-inject into. */
function teardown(): void {
  if (dead) return;
  dead = true;
  observer?.disconnect();
  if (rescanTimer !== null) clearTimeout(rescanTimer);
  if (watchdog !== null) clearTimeout(watchdog);
  if (hlRaf) cancelAnimationFrame(hlRaf);
  selRanges.clear();
  excluded.clear();
  blockControls.clear();
  try { root?.remove(); } catch { /* ignore */ }
  window.__bfrInjected = false; // let a re-injection take over cleanly
}
