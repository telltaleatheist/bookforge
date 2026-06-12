/**
 * Toolbar popup — the remote: TTS-server start/stop, "show controls on page",
 * basic transport, and the live play queue (current + upcoming, removable).
 *
 * It reads the authoritative QueueSnapshot the offscreen player mirrors into
 * chrome.storage.session and live-updates via storage.onChanged. Commands go up
 * through the background relay. On open it pokes a 'sync' so the offscreen doc
 * refreshes engine state (and connects if needed).
 */

import { QueueSnapshot, RuntimeMessage, SNAPSHOT_KEY } from './messages';

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
    statusText.textContent = 'BookForge not running';
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

  const playing = snapshot?.playback.state === 'playing';
  playPauseBtn.textContent = playing ? 'Pause' : 'Play';
  const hasCurrent = !!snapshot?.current;
  playPauseBtn.disabled = !hasCurrent;
  skipBtn.disabled = !snapshot?.upcoming.length;
  clearBtn.disabled = !snapshot?.upcoming.length;

  renderQueue();
}

function renderQueue(): void {
  queueEl.textContent = '';
  if (!snapshot || (!snapshot.current && snapshot.upcoming.length === 0)) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Queue is empty. Use ▶ / ＋ on a page, or select text.';
    queueEl.appendChild(li);
    return;
  }
  if (snapshot.current) queueEl.appendChild(itemRow(snapshot.current.id, snapshot.current.label, true));
  for (const item of snapshot.upcoming) queueEl.appendChild(itemRow(item.id, item.label, false));
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

playPauseBtn.addEventListener('click', () => send({ target: 'background', cmd: 'transport', op: 'toggle-pause' }));
skipBtn.addEventListener('click', () => send({ target: 'background', cmd: 'queue', op: 'skip' }));
clearBtn.addEventListener('click', () => send({ target: 'background', cmd: 'queue', op: 'clear' }));
$('openOptions').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// ─── Live snapshot ────────────────────────────────────────────────────────────

async function load(): Promise<void> {
  const stored = await chrome.storage.session.get(SNAPSHOT_KEY);
  snapshot = (stored[SNAPSHOT_KEY] as QueueSnapshot) ?? null;
  render();
  send({ target: 'background', cmd: 'sync' }); // refresh engine state
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[SNAPSHOT_KEY]) {
    snapshot = changes[SNAPSHOT_KEY].newValue as QueueSnapshot;
    render();
  }
});

void load();
