/**
 * Content script — finds readable text blocks and draws a play (▶) + enqueue (＋)
 * button beside each, offers a floating control on text selection, and owns the
 * transport bar. It renders the per-tab UiState pushed down from the offscreen
 * player (via background) and sends play/enqueue/transport commands up.
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
const RESCAN_DEBOUNCE_MS = 1500;
const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2];

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
const groupById = new Map<string, { play: HTMLButtonElement; add: HTMLButtonElement }>();
let lastUi: UiState | null = null;
let rescanTimer: number | null = null;
let watchdog: number | null = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  settings = await loadSettings();
  buildRoot();
  buildSelectionControl();
  buildBar();
  chrome.runtime.onMessage.addListener(onMessage);
  rescan();
  requestSync();

  new MutationObserver(() => scheduleRescan()).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', repositionAll, { passive: true });
  document.addEventListener('selectionchange', onSelectionChange);
  window.addEventListener('scroll', () => hideSelControl(), { passive: true });
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
  // Rebuild groups, preserving the bar + selection control (separate children).
  for (const g of groupById.values()) { g.play.parentElement?.remove(); }
  groupById.clear();
  for (const { id, el } of blocks) {
    const group = makeGroup(id, el);
    root.appendChild(group.wrap);
    groupById.set(id, { play: group.play, add: group.add });
    positionGroup(group.wrap, el);
  }
  if (lastUi) applyUi(lastUi);
}

function scheduleRescan(): void {
  if (rescanTimer !== null) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => { rescanTimer = null; rescan(); }, RESCAN_DEBOUNCE_MS) as unknown as number;
}

function positionGroup(wrap: HTMLElement, el: HTMLElement): void {
  const r = el.getBoundingClientRect();
  wrap.style.left = `${Math.max(2, r.left + window.scrollX - 30)}px`;
  wrap.style.top = `${r.top + window.scrollY + 2}px`;
}

function repositionAll(): void {
  for (const { id, el } of blocks) {
    const g = groupById.get(id);
    if (g) positionGroup(g.play.parentElement as HTMLElement, el);
  }
}

// ─── Per-block button group ───────────────────────────────────────────────────

function makeGroup(id: string, el: HTMLElement): { wrap: HTMLDivElement; play: HTMLButtonElement; add: HTMLButtonElement } {
  const wrap = document.createElement('div');
  wrap.className = 'bfr-group';

  const play = document.createElement('button');
  play.className = 'bfr-play';
  play.dataset.state = 'idle';
  play.title = 'Play now';
  play.textContent = '▶';
  play.addEventListener('click', (e) => { stop(e); blockAction('play', id, el); });

  const add = document.createElement('button');
  add.className = 'bfr-add';
  add.dataset.state = 'idle';
  add.title = 'Add to queue';
  add.textContent = '＋';
  add.addEventListener('click', (e) => { stop(e); blockAction('enqueue', id, el); });

  wrap.append(play, add);
  return { wrap, play, add };
}

function blockText(el: HTMLElement): string {
  return (el.innerText || '').replace(/\s+/g, ' ').trim();
}

function blockAction(cmd: 'play' | 'enqueue', id: string, el: HTMLElement): void {
  const text = blockText(el);
  if (!text) return;
  if (cmd === 'play') { showBar(); barEls.status.textContent = 'Connecting…'; armWatchdog(); }
  send({ target: 'background', cmd, blockId: id, text, label: preview(text), source: 'block' });
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

function onSelectionChange(): void {
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
  selControl.style.left = `${r.left + window.scrollX}px`;
  selControl.style.top = `${r.bottom + window.scrollY + 6}px`;
  selControl.style.display = 'flex';
}

function hideSelControl(): void { selControl.style.display = 'none'; }

function selectionAction(cmd: 'play' | 'enqueue'): void {
  const text = pendingSelectionText;
  if (!text) return;
  if (cmd === 'play') { showBar(); barEls.status.textContent = 'Connecting…'; armWatchdog(); }
  send({ target: 'background', cmd, blockId: `sel-${++selCounter}`, text, label: preview(text), source: 'selection' });
  hideSelControl();
  window.getSelection()?.removeAllRanges();
}

// ─── Transport bar ────────────────────────────────────────────────────────────

interface BarEls {
  rewind: HTMLButtonElement;
  playPause: HTMLButtonElement;
  forward: HTMLButtonElement;
  skip: HTMLButtonElement;
  label: HTMLSpanElement;
  time: HTMLSpanElement;
  sentence: HTMLSpanElement;
  speed: HTMLSelectElement;
  status: HTMLSpanElement;
  close: HTMLButtonElement;
}

function buildBar(): void {
  bar = document.createElement('div');
  bar.id = 'bfr-bar';
  bar.style.display = 'none';

  const rewind = ctl('« 5', () => send({ target: 'background', cmd: 'transport', op: 'seek', delta: -5 }));
  const playPause = ctl('⏸', () => send({ target: 'background', cmd: 'transport', op: 'toggle-pause' }));
  const forward = ctl('5 »', () => send({ target: 'background', cmd: 'transport', op: 'seek', delta: 5 }));
  const skip = ctl('⏭', () => send({ target: 'background', cmd: 'queue', op: 'skip' }));
  skip.title = 'Next in queue';

  const label = document.createElement('span');
  label.className = 'bfr-label';
  const time = document.createElement('span');
  time.className = 'bfr-time';
  time.textContent = '0:00 / 0:00';
  const sentence = document.createElement('span');
  sentence.className = 'bfr-sentence';

  const speed = document.createElement('select');
  speed.className = 'bfr-speed';
  for (const s of SPEEDS) {
    const opt = document.createElement('option');
    opt.value = String(s);
    opt.textContent = `${s}×`;
    if (s === settings.rate) opt.selected = true;
    speed.appendChild(opt);
  }
  speed.addEventListener('change', () => {
    settings.rate = Number(speed.value);
    void chrome.storage.local.set({ rate: settings.rate });
    send({ target: 'background', cmd: 'transport', op: 'rate', rate: settings.rate });
  });

  const status = document.createElement('span');
  status.className = 'bfr-status';

  const close = ctl('✕', () => { send({ target: 'background', cmd: 'transport', op: 'stop' }); hideBar(); });
  close.classList.add('bfr-close');

  for (const el of [rewind, playPause, forward, skip, label, time, sentence, speed, status, close]) bar.appendChild(el);
  barEls = { rewind, playPause, forward, skip, label, time, sentence, speed, status, close };
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
  const plus = p.totalKnown ? '' : '+';
  barEls.time.textContent = `${fmt(p.position)} / ${fmt(p.buffered)}${plus}`;
  barEls.sentence.textContent =
    p.sentenceCount > 0 && p.sentenceIndex >= 0 ? `${p.sentenceIndex + 1}/${p.sentenceCount}` : '';
  barEls.playPause.textContent = p.state === 'playing' ? '⏸' : '▶';
  const headroom = p.buffered - p.position;
  barEls.rewind.disabled = p.position <= 0.3;
  barEls.forward.disabled = headroom <= (p.totalKnown ? 0.6 : 5.2);
  barEls.status.textContent = statusText(ui);
  if (Number(barEls.speed.value) !== p.rate) barEls.speed.value = String(p.rate);
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

function fmt(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Incoming messages ────────────────────────────────────────────────────────

function onMessage(raw: RuntimeMessage): void {
  if (!raw || (raw as { target?: string }).target !== 'content') return;
  if (raw.cmd === 'toggle-ui') { toggleUi(raw.show); return; }
  if (raw.cmd === 'ui') { clearWatchdog(); lastUi = raw.ui; applyUi(raw.ui); }
}

function applyUi(ui: UiState): void {
  for (const [id, g] of groupById) {
    if (id === ui.currentBlockId) {
      g.play.dataset.state = playStateClass(ui.playback.state);
      g.play.textContent = ui.playback.state === 'playing' ? '⏸' : ui.playback.state === 'ended' ? '✓' : '▶';
    } else {
      g.play.dataset.state = 'idle';
      g.play.textContent = '▶';
    }
    g.add.dataset.state = ui.upcomingBlockIds.includes(id) ? 'queued' : 'idle';
    g.add.textContent = ui.upcomingBlockIds.includes(id) ? '✓' : '＋';
  }
  if (ui.playback.state === 'idle') hideBar();
  else { showBar(); renderBar(ui); }
}

function playStateClass(state: PlaybackStatus['state']): string {
  switch (state) {
    case 'connecting': return 'connecting';
    case 'starting-engine':
    case 'buffering': return 'loading';
    case 'playing': return 'playing';
    case 'paused': return 'paused';
    case 'ended': return 'done';
    case 'error': return 'error';
    default: return 'idle';
  }
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
  else { hideBar(); hideSelControl(); root.style.display = 'none'; }
}

function requestSync(): void {
  send({ target: 'background', cmd: 'sync' });
}

function buildRoot(): void {
  root = document.createElement('div');
  root.id = 'bfr-root';
  document.documentElement.appendChild(root);
}

function preview(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

function stop(e: Event): void { e.preventDefault(); e.stopPropagation(); }

function send(msg: RuntimeMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => { /* background wakes on next */ });
}
