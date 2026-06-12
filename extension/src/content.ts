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

import { PlaybackStatus, RuntimeMessage, Settings, UiState, loadSettings } from './messages';

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
const SPEED_STEP = 0.25;
// Seconds of within-item read-ahead audio that counts as a "healthy" buffer for the
// ring display. This is just the health-meter scale (the cross-block prefetch goes
// much deeper); 45s of headroom on the current block already means no underrun risk.
const PREBUFFER_TARGET = 45;

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
// While the user is adjusting the speed slider (and briefly after, while the new
// rate round-trips through the background to the player), renderBar must not snap
// the thumb back to the player's still-stale rate — the periodic UiState ticks
// would fight the drag.
let speedThumbHeld = false;
let speedHoldUntil = 0;
const SPEED_HOLD_MS = 1000;
let rescanTimer: number | null = null;
let rescanFirstScheduled = 0; // when the current pending rescan was first requested
let watchdog: number | null = null;
let observer: MutationObserver | null = null;

// Single hover control (▶ play-from-here / − exclude) that follows the hovered
// block, instead of a fixed button beside every block.
let hoverWrap: HTMLDivElement;
let hoverPlay: HTMLButtonElement;
let hoverMinus: HTMLButtonElement;
let hoveredBlockId: string | null = null;
let hoveredEl: HTMLElement | null = null;
let overControl = false;
let hideTimer: number | null = null;

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
  buildHoverControl();
  buildSelectionControl();
  buildBar();
  chrome.runtime.onMessage.addListener(onMessage);
  rescan();
  requestSync();

  observer = new MutationObserver(() => scheduleRescan());
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => { scheduleViewportSync(); }, { passive: true });
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', () => { hideSelControl(); scheduleViewportSync(); }, { passive: true });
  // Hover reveals the per-block control; click in body text starts reading there.
  document.addEventListener('mouseover', onPointerOver, { passive: true });
  document.addEventListener('click', onDocClick, true);
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
  // Drop the hover control if its block disappeared in a re-render.
  if (hoveredEl && !blockElToId.has(hoveredEl)) hideHover();
  drawExcludeOverlays();
  if (lastUi) applyUi(lastUi);
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

function positionHover(el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  hoverWrap.style.left = `${Math.max(2, r.left + window.scrollX - 30)}px`;
  hoverWrap.style.top = `${r.top + window.scrollY + 2}px`;
}

// ─── Hover control (▶ play-from-here / − exclude) ──────────────────────────────

function buildHoverControl(): void {
  hoverWrap = document.createElement('div');
  hoverWrap.className = 'bfr-group';
  hoverWrap.style.display = 'none';

  hoverPlay = document.createElement('button');
  hoverPlay.className = 'bfr-play';
  hoverPlay.title = 'Play from here to the end of the page';
  hoverPlay.textContent = '▶';
  hoverPlay.addEventListener('click', (e) => { stop(e); if (hoveredBlockId) playFrom(hoveredBlockId); });

  hoverMinus = document.createElement('button');
  hoverMinus.className = 'bfr-minus';
  hoverMinus.textContent = '−';
  hoverMinus.addEventListener('click', (e) => { stop(e); if (hoveredBlockId) toggleExclude(hoveredBlockId); });

  hoverWrap.append(hoverPlay, hoverMinus);
  hoverWrap.addEventListener('mouseenter', () => { overControl = true; cancelHideHover(); });
  hoverWrap.addEventListener('mouseleave', () => { overControl = false; scheduleHideHover(); });
  root.appendChild(hoverWrap);
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

function onPointerOver(e: MouseEvent): void {
  if (dead || !uiVisible) return;
  const target = e.target as HTMLElement | null;
  if (!target || root.contains(target)) return; // over our own UI ⇒ keep showing
  const hit = resolveBlockAt(target);
  if (hit) { cancelHideHover(); showHoverFor(hit.id, hit.el); }
  else scheduleHideHover();
}

function showHoverFor(id: string, el: HTMLElement): void {
  hoveredBlockId = id;
  hoveredEl = el;
  updateMinusButton(id);
  positionHover(el);
  hoverWrap.style.display = 'flex';
}

function hideHover(): void {
  hoverWrap.style.display = 'none';
  hoveredBlockId = null;
  hoveredEl = null;
}

function scheduleHideHover(): void {
  if (hideTimer !== null) return;
  // Small delay so moving from the block to the margin control doesn't dismiss it.
  hideTimer = setTimeout(() => { hideTimer = null; if (!overControl) hideHover(); }, 180) as unknown as number;
}

function cancelHideHover(): void {
  if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null; }
}

function updateMinusButton(id: string): void {
  const ex = excluded.has(id);
  hoverMinus.textContent = ex ? '↺' : '−';
  hoverMinus.title = ex ? 'Include this block again' : 'Skip this block (e.g. an ad)';
  hoverMinus.classList.toggle('bfr-restore', ex);
}

function blockText(el: HTMLElement): string {
  return (el.innerText || '').replace(/\s+/g, ' ').trim();
}

// ─── Continuous "play from here" + exclusions ──────────────────────────────────

/**
 * Play from a block (or a partial start, when clicked mid-paragraph) through the
 * rest of the page, skipping excluded blocks. The queue + prefetch auto-advance.
 */
function playFrom(startId: string, firstPartial?: { text: string; range: Range }): void {
  const startIdx = blocks.findIndex((b) => b.id === startId);
  if (startIdx < 0) return;

  const items: { blockId: string; text: string; label: string }[] = [];
  for (let i = startIdx; i < blocks.length; i++) {
    const b = blocks[i];
    if (excluded.has(b.id)) continue;
    if (i === startIdx && firstPartial) {
      const id = `start-${++selCounter}`;
      selRanges.set(id, firstPartial.range);
      items.push({ blockId: id, text: firstPartial.text, label: preview(firstPartial.text) });
    } else {
      const text = blockText(b.el);
      if (text) items.push({ blockId: b.id, text, label: preview(text) });
    }
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
  updateMinusButton(id);
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
  const partial = caret ? partialFromCaret(caret, hit.el) : null;
  stop(e);
  playFrom(hit.id, partial ?? undefined);
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

/** A range from the start of the clicked word to the end of the block, plus its text. */
function partialFromCaret(caret: Range, el: HTMLElement): { text: string; range: Range } | null {
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
    if (!text) return null;
    return { text, range };
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
  rewind: HTMLButtonElement;
  playPause: HTMLButtonElement;
  stop: HTMLButtonElement;
  forward: HTMLButtonElement;
  skip: HTMLButtonElement;
  label: HTMLSpanElement;
  buffer: HTMLSpanElement;
  bufferRing: HTMLSpanElement;
  sentence: HTMLSpanElement;
  speed: HTMLInputElement;
  speedVal: HTMLSpanElement;
  status: HTMLSpanElement;
  close: HTMLButtonElement;
}

function buildBar(): void {
  bar = document.createElement('div');
  bar.id = 'bfr-bar';
  bar.style.display = 'none';

  const rewind = ctl('« 5', () => send({ target: 'background', cmd: 'transport', op: 'seek', delta: -5 }));
  // Always play/pause — even while buffering, pausing just holds playback while the
  // buffer keeps filling. Stop (below) is the way to abort generation entirely.
  const playPause = ctl('⏸', () => send({ target: 'background', cmd: 'transport', op: 'toggle-pause' }));
  playPause.classList.add('bfr-playpause'); // fixed width so glyph swaps don't shift neighbors
  // Dedicated stop: cancels generation and clears the queue (the bar hides on idle).
  const stopBtn = ctl('■', () => send({ target: 'background', cmd: 'transport', op: 'stop' }));
  stopBtn.classList.add('bfr-stop');
  stopBtn.title = 'Stop (cancel buffering)';
  const forward = ctl('5 »', () => send({ target: 'background', cmd: 'transport', op: 'seek', delta: 5 }));
  const skip = ctl('⏭', () => send({ target: 'background', cmd: 'queue', op: 'skip' }));
  skip.title = 'Next in queue';

  const label = document.createElement('span');
  label.className = 'bfr-label';
  // Buffer "health" ring: fills clockwise with green as the read-ahead buffer
  // approaches PREBUFFER_TARGET seconds (offscreen's PREFETCH_LOOKAHEAD_SECONDS).
  // Full ring ⇒ fully buffered / no underrun risk. Replaces the old position/total
  // time readout.
  const buffer = document.createElement('span');
  buffer.className = 'bfr-buffer';
  buffer.title = 'Buffer health';
  const bufferRing = document.createElement('span');
  bufferRing.className = 'bfr-buffer-ring';
  bufferRing.style.setProperty('--bfr-fill', '0');
  buffer.appendChild(bufferRing);
  const sentence = document.createElement('span');
  sentence.className = 'bfr-sentence';

  const speed = document.createElement('input');
  speed.type = 'range';
  speed.className = 'bfr-speed';
  speed.min = String(SPEED_MIN);
  speed.max = String(SPEED_MAX);
  speed.step = String(SPEED_STEP);
  speed.value = String(settings.rate);
  speed.title = 'Playback speed';
  const speedVal = document.createElement('span');
  speedVal.className = 'bfr-speed-val';
  speedVal.textContent = speedLabel(settings.rate);
  speed.addEventListener('pointerdown', () => { speedThumbHeld = true; });
  const releaseThumb = () => { speedThumbHeld = false; speedHoldUntil = Date.now() + SPEED_HOLD_MS; };
  speed.addEventListener('pointerup', releaseThumb);
  speed.addEventListener('pointercancel', releaseThumb);
  speed.addEventListener('input', () => {
    // Covers keyboard adjustment too, where no pointerdown fires.
    speedHoldUntil = Date.now() + SPEED_HOLD_MS;
    speedVal.textContent = speedLabel(Number(speed.value));
  });
  speed.addEventListener('change', () => {
    speedHoldUntil = Date.now() + SPEED_HOLD_MS;
    settings.rate = Number(speed.value);
    try { void chrome.storage.local.set({ rate: settings.rate }); } catch { /* orphaned context */ }
    send({ target: 'background', cmd: 'transport', op: 'rate', rate: settings.rate });
  });

  const status = document.createElement('span');
  status.className = 'bfr-status';

  const close = ctl('✕', () => { send({ target: 'background', cmd: 'transport', op: 'stop' }); hideBar(); });
  close.classList.add('bfr-close');

  for (const el of [rewind, playPause, stopBtn, forward, skip, label, buffer, sentence, speed, speedVal, status, close]) bar.appendChild(el);
  barEls = { rewind, playPause, stop: stopBtn, forward, skip, label, buffer, bufferRing, sentence, speed, speedVal, status, close };
  root.appendChild(bar);
}

function ctl(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'bfr-ctl';
  b.textContent = text;
  b.addEventListener('click', (e) => { stop(e); onClick(); });
  return b;
}

function showBar(): void { bar.style.display = 'flex'; }
function hideBar(): void { bar.style.display = 'none'; }

function renderBar(ui: UiState): void {
  const p = ui.playback;
  barEls.label.textContent = ui.currentLabel ? `“${ui.currentLabel}”` : '';
  barEls.sentence.textContent =
    p.sentenceCount > 0 && p.sentenceIndex >= 0 ? `${p.sentenceIndex + 1}/${p.sentenceCount}` : '';
  setPlayPause(barEls.playPause, p);
  const headroom = Math.max(0, p.buffered - p.position);
  // Once the whole clip is generated (totalKnown) there's nothing left to buffer —
  // a short item that's fully ready reads as a full ring even if its tail is < 45s.
  const frac = p.totalKnown ? 1 : Math.min(1, headroom / PREBUFFER_TARGET);
  const pct = Math.round(frac * 100);
  barEls.bufferRing.style.setProperty('--bfr-fill', String(pct));
  barEls.buffer.title = p.totalKnown ? 'Fully buffered' : `Buffer: ${Math.round(headroom)}s ready (${pct}%)`;
  barEls.rewind.disabled = p.position <= 0.3;
  barEls.forward.disabled = headroom <= (p.totalKnown ? 0.6 : 5.2);
  barEls.status.textContent = statusText(ui);
  const speedHeld = speedThumbHeld || Date.now() < speedHoldUntil;
  if (!speedHeld && Number(barEls.speed.value) !== p.rate) {
    barEls.speed.value = String(p.rate);
    barEls.speedVal.textContent = speedLabel(p.rate);
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
  if (mode === 'loading') {
    btn.title = 'Pause (keeps buffering)';
    btn.textContent = '';
    const glyph = document.createElement('span');
    glyph.className = 'bfr-pp-glyph';
    glyph.textContent = '⏸';
    const sp = document.createElement('span');
    sp.className = 'bfr-spinner';
    btn.append(glyph, sp);
  } else {
    btn.textContent = mode === 'pause' ? '⏸' : '▶';
    btn.title = mode === 'pause' ? 'Pause' : 'Play';
  }
}

function statusText(ui: UiState): string {
  const p = ui.playback;
  let base: string;
  switch (p.state) {
    case 'connecting': base = 'Connecting…'; break;
    case 'starting-engine': base = 'Starting TTS engine (about a minute)…'; break;
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
  if (raw.cmd === 'ui') { clearWatchdog(); lastUi = raw.ui; applyUi(raw.ui); }
}

function applyUi(ui: UiState): void {
  if (ui.playback.state === 'idle') hideBar();
  else { showBar(); renderBar(ui); }
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
    if (hoveredEl && hoverWrap.style.display !== 'none') positionHover(hoveredEl);
  }) as unknown as number;
}

// ─── Watchdog: surface a dead player pipe instead of hanging ───────────────────

function armWatchdog(): void {
  clearWatchdog();
  watchdog = setTimeout(() => {
    showBar();
    barEls.status.textContent =
      'No response from the player — reload BookForge Reader at chrome://extensions, then reload this page.';
  }, 3000) as unknown as number;
}
function clearWatchdog(): void {
  if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
}

// ─── Visibility + plumbing ────────────────────────────────────────────────────

function toggleUi(show?: boolean): void {
  uiVisible = show === undefined ? !uiVisible : show;
  if (uiVisible) { root.style.display = ''; rescan(); requestSync(); }
  else { hideBar(); hideSelControl(); hideHover(); clearHighlight(); root.style.display = 'none'; }
}

function requestSync(): void {
  send({ target: 'background', cmd: 'sync' });
}

function buildRoot(): void {
  root = document.createElement('div');
  root.id = 'bfr-root';
  excludeLayer = document.createElement('div');
  excludeLayer.className = 'bfr-excluded-layer';
  highlightLayer = document.createElement('div');
  highlightLayer.className = 'bfr-hl-layer';
  root.append(excludeLayer, highlightLayer);
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
  if (hideTimer !== null) clearTimeout(hideTimer);
  selRanges.clear();
  excluded.clear();
  try { root?.remove(); } catch { /* ignore */ }
  window.__bfrInjected = false; // let a re-injection take over cleanly
}
