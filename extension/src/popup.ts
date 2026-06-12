/**
 * Toolbar popup — the remote: TTS-server start/stop, "show controls on page",
 * basic transport, and the live play queue (current + upcoming, removable).
 *
 * It reads the authoritative QueueSnapshot the offscreen player mirrors into
 * chrome.storage.session and live-updates via storage.onChanged. Commands go up
 * through the background relay. On open it pokes a 'sync' so the offscreen doc
 * refreshes engine state (and connects if needed).
 */

import { PlaybackStatus, QueueSnapshot, RuntimeMessage } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dot = $('dot');
const statusText = $('statusText');
const serverBtn = $('server') as HTMLButtonElement;
const toggleUiBtn = $('toggleUi') as HTMLButtonElement;
const playPauseBtn = $('playPause') as HTMLButtonElement;
const skipBtn = $('skip') as HTMLButtonElement;
const clearBtn = $('clear') as HTMLButtonElement;
const queueEl = $('queue') as HTMLOListElement;

let snapshot: QueueSnapshot | null = null;

function send(msg: RuntimeMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => { /* background wakes */ });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render(): void {
  const connected = snapshot?.connected ?? false;
  const engine = snapshot?.engineState ?? 'stopped';

  // Connection / engine indicator
  if (!connected) {
    dot.className = 'dot off';
    // snapshot present but not connected ⇒ mid-connect; null ⇒ still waiting on the player
    statusText.textContent = snapshot ? (snapshot.connectionError ?? 'Connecting…') : 'Checking…';
  } else if (engine === 'running') {
    dot.className = 'dot on';
    statusText.textContent = 'TTS server running';
  } else if (engine === 'starting') {
    dot.className = 'dot warn';
    statusText.textContent = 'TTS server starting…';
  } else {
    dot.className = 'dot warn';
    statusText.textContent = 'Connected — server stopped';
  }

  // Server start/stop button
  if (engine === 'running') {
    serverBtn.textContent = 'Stop TTS server';
    serverBtn.className = 'danger';
    serverBtn.disabled = false;
  } else if (engine === 'starting') {
    serverBtn.textContent = 'Starting…';
    serverBtn.className = 'primary';
    serverBtn.disabled = true;
  } else {
    serverBtn.textContent = 'Start TTS server';
    serverBtn.className = 'primary';
    serverBtn.disabled = false;
  }

  setPlayPause(snapshot?.playback.state ?? 'idle', !!snapshot?.current);
  skipBtn.disabled = !snapshot?.upcoming.length;
  clearBtn.disabled = !snapshot?.upcoming.length;

  renderQueue();
}

const LOADING_STATES = new Set<PlaybackStatus['state']>(['connecting', 'starting-engine', 'buffering']);

/**
 * Same rule as the on-page bar: playing ⇒ Pause (enabled); a loading/buffering
 * state ⇒ a disabled spinner; otherwise ⇒ Play. Keyed by mode so the spinner isn't
 * rebuilt (and its animation restarted) on every snapshot.
 */
function setPlayPause(state: PlaybackStatus['state'], hasCurrent: boolean): void {
  const loading = LOADING_STATES.has(state);
  const mode = loading ? 'loading' : state === 'playing' ? 'pause' : 'play';
  if (playPauseBtn.dataset.mode !== mode) {
    playPauseBtn.dataset.mode = mode;
    if (loading) {
      playPauseBtn.textContent = '';
      const sp = document.createElement('span');
      sp.className = 'spinner';
      playPauseBtn.append(sp, document.createTextNode(' Stop'));
    } else {
      playPauseBtn.textContent = mode === 'pause' ? 'Pause' : 'Play';
    }
  }
  // Stays clickable while loading so you can abort a stuck buffer (→ stop).
  playPauseBtn.disabled = !hasCurrent;
}

function renderQueue(): void {
  queueEl.textContent = '';
  if (!snapshot || (!snapshot.current && snapshot.upcoming.length === 0)) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing playing. Hover a paragraph and press ▶ (or click a word) to read from there.';
    queueEl.appendChild(li);
    return;
  }
  if (snapshot.current) queueEl.appendChild(itemRow(snapshot.current.id, snapshot.current.label, true));
  // A "play to end of page" run can queue hundreds of paragraphs — show a window
  // and summarize the rest instead of rendering them all every snapshot.
  const MAX_ROWS = 25;
  for (const item of snapshot.upcoming.slice(0, MAX_ROWS)) queueEl.appendChild(itemRow(item.id, item.label, false));
  const extra = snapshot.upcoming.length - MAX_ROWS;
  if (extra > 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `+${extra} more queued`;
    queueEl.appendChild(li);
  }
}

function itemRow(id: string, label: string, isCurrent: boolean): HTMLLIElement {
  const li = document.createElement('li');
  if (isCurrent) li.className = 'current';

  const text = document.createElement('span');
  text.className = 'label';
  text.textContent = label;
  text.title = label;

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = isCurrent ? playbackBadge() : '';

  const rm = document.createElement('button');
  rm.className = 'rm';
  rm.textContent = '−';
  rm.title = isCurrent ? 'Stop and skip' : 'Remove from queue';
  rm.addEventListener('click', () => send({ target: 'background', cmd: 'queue', op: 'remove', id }));

  li.append(text, badge, rm);
  return li;
}

function playbackBadge(): string {
  switch (snapshot?.playback.state) {
    case 'playing': return '▶ playing';
    case 'paused': return '⏸ paused';
    case 'connecting': return 'connecting…';
    case 'starting-engine': return 'starting…';
    case 'buffering': return 'buffering…';
    case 'ended': return '✓ done';
    case 'error': return '! error';
    default: return '';
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

serverBtn.addEventListener('click', () => {
  const op = snapshot?.engineState === 'running' ? 'stop' : 'start';
  send({ target: 'background', cmd: 'engine', op });
});

toggleUiBtn.addEventListener('click', async () => {
  const tab = await activeTab();
  if (tab?.id === undefined) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { target: 'content', cmd: 'toggle-ui' });
  } catch {
    // Not injected yet — inject; the content script comes up visible.
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (err) {
      console.warn('[BFR] cannot inject into this page:', err);
    }
  }
  window.close();
});

playPauseBtn.addEventListener('click', () => {
  const op = playPauseBtn.dataset.mode === 'loading' ? 'stop' : 'toggle-pause';
  send({ target: 'background', cmd: 'transport', op });
});
skipBtn.addEventListener('click', () => send({ target: 'background', cmd: 'queue', op: 'skip' }));
clearBtn.addEventListener('click', () => send({ target: 'background', cmd: 'queue', op: 'clear' }));
$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Live snapshot ────────────────────────────────────────────────────────────

// Live updates are pushed from background (reliable across contexts).
chrome.runtime.onMessage.addListener((raw: RuntimeMessage) => {
  if (!raw || (raw as { target?: string }).target !== 'popup') return;
  if (raw.cmd === 'snapshot') { snapshot = raw.snapshot; render(); }
});

// Ask background for current state; it replies via a 'snapshot' push (and the
// offscreen player broadcasts a fresh one right after).
render();
send({ target: 'background', cmd: 'sync' });
