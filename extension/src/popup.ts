/**
 * Toolbar popup — the remote: TTS-server start/stop, "show controls on page",
 * basic transport, and the live play queue (current + upcoming, removable).
 *
 * It reads the authoritative QueueSnapshot the offscreen player mirrors into
 * chrome.storage.session and live-updates via storage.onChanged. Commands go up
 * through the background relay. On open it pokes a 'sync' so the offscreen doc
 * refreshes engine state (and connects if needed).
 */

import { PlaybackStatus, QueueSnapshot, RuntimeMessage, isPlaybackActive, loadSettings } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dot = $('dot');
const statusText = $('statusText');
const serverBtn = $('server') as HTMLButtonElement;
const toggleUiBtn = $('toggleUi') as HTMLButtonElement;
const playPauseBtn = $('playPause') as HTMLButtonElement;
const stopBtn = $('stopBtn') as HTMLButtonElement;
const skipBtn = $('skip') as HTMLButtonElement;
const clearBtn = $('clear') as HTMLButtonElement;
const queueEl = $('queue') as HTMLOListElement;
const voiceEl = $('voice') as HTMLSelectElement;
const workersEl = $('workers') as HTMLInputElement;
const applyEngineBtn = $('applyEngine') as HTMLButtonElement;
const engineNote = $('engineNote') as HTMLDivElement;

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

  setPlayPause(snapshot?.playback.state ?? 'idle', !!snapshot?.playback.paused, !!snapshot?.current);
  stopBtn.disabled = !snapshot?.current;
  skipBtn.disabled = !snapshot?.upcoming.length;
  clearBtn.disabled = !snapshot?.upcoming.length;

  renderQueue();
  renderEngine();
}

// ─── Engine settings (voice + CPU workers) ─────────────────────────────────────

// The voice the extension uses for every speak (chrome.storage `voice`); '' means
// "use whatever the engine has loaded". Loaded once, then owned by the dropdown.
let selectedVoice = '';
// Rebuild the <option>s only when the voice list actually changes (null = never
// built yet) so a 300 ms snapshot tick can't reset the dropdown mid-interaction.
let voicesSig: string | null = null;
// True between "Restart to apply" and the engine coming back up, so the note shows
// progress instead of the restimed live topology.
let restarting = false;

function buildVoiceOptions(voices: string[]): void {
  // Keep the saved voice selectable even if the engine hasn't reported voices yet.
  const list = selectedVoice && !voices.includes(selectedVoice) ? [selectedVoice, ...voices] : voices;
  voiceEl.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Engine default (keep loaded voice)';
  voiceEl.appendChild(def);
  for (const v of list) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v;
    voiceEl.appendChild(o);
  }
  voiceEl.value = selectedVoice;
}

function renderEngine(): void {
  const s = snapshot;
  const voices = s?.voices ?? [];
  const config = s?.config ?? null;
  const connected = !!s?.connected;

  const sig = voices.join('|');
  if (sig !== voicesSig) { voicesSig = sig; buildVoiceOptions(voices); }

  // Mirror the server's current voice (the shared default) so the popup stays in
  // lockstep with the app Settings + in-page pickers — any of them changing it
  // broadcasts a fresh snapshot. Don't clobber while the dropdown is open.
  const cv = s?.currentVoice ?? null;
  if (cv && cv !== selectedVoice && document.activeElement !== voiceEl) {
    selectedVoice = cv;
    try { void chrome.storage.local.set({ voice: selectedVoice }); } catch { /* orphaned context */ }
    if (!voices.includes(cv)) buildVoiceOptions(voices); else voiceEl.value = cv;
  }

  const cuda = config?.device === 'cuda';
  // Multiple workers are an opt-in capability set inside BookForge. When off (or
  // on CUDA, where it's moot), the worker control is hidden — there's nothing to
  // tune, the engine runs a single worker.
  const tunable = !!config && config.enabled && !cuda;
  if (config) {
    workersEl.min = String(config.minWorkers);
    workersEl.max = String(config.maxWorkers);
    if (document.activeElement !== workersEl) {
      workersEl.value = String(tunable ? config.count : config.deviceWorkers);
    }
  }
  workersEl.disabled = !tunable;
  // Hide the whole worker row when there's nothing to tune.
  workersEl.closest('.field')?.classList.toggle('hidden', !!config && !tunable);
  applyEngineBtn.disabled = !connected || !tunable || restarting;
  voiceEl.disabled = !connected;

  if (restarting) {
    if (s?.engineState === 'running') { restarting = false; setNote('Restarted ✓', 'good'); }
    else { setNote('Restarting engine… (can take ~a minute)', ''); return; }
  }
  if (!connected) { setNote(s?.connectionError ?? 'Connect to BookForge to configure the engine.', ''); return; }
  if (!config) { setNote('', ''); return; }
  const device = config.device ? config.device.toUpperCase() : 'engine';
  const active = config.activeWorkers > 0 ? `${config.activeWorkers} running` : 'engine stopped';
  setNote(
    cuda
      ? `${device}: one worker (the GPU serializes decode). ${active}.`
      : !config.enabled
        ? `${device}: single worker. ${active}. Enable multiple workers in BookForge if your machine benefits (mainly Apple Silicon).`
        : `${device}: ${config.count} configured, ${active}. Range ${config.minWorkers}–${config.maxWorkers}. More is faster but uses more memory.`,
    ''
  );
}

function setNote(text: string, cls: '' | 'good' | 'bad'): void {
  engineNote.textContent = text;
  engineNote.className = cls ? `note ${cls}` : 'note';
}

voiceEl.addEventListener('change', () => {
  const v = voiceEl.value;
  // Mid-playback, switching discards the in-flight (old-voice) audio and
  // re-renders the current item — confirm first. Idle ⇒ just switch.
  const active = isPlaybackActive(snapshot?.playback.state);
  if (active && !confirm('Switch voice now? This restarts buffering and re-renders the current text in the new voice.')) {
    voiceEl.value = selectedVoice; // revert
    return;
  }
  selectedVoice = v;
  void chrome.storage.local.set({ voice: selectedVoice });
  // Warms the new voice immediately if the engine is running; otherwise it just
  // becomes the default for the next speak (offscreen reads storage per request).
  send({ target: 'background', cmd: 'set-voice', voice: selectedVoice, rerender: active });
  if (!restarting) setNote(selectedVoice ? `Voice set to ${selectedVoice}.` : 'Using the engine default voice.', 'good');
});

applyEngineBtn.addEventListener('click', () => {
  const config = snapshot?.config;
  const min = config?.minWorkers ?? 1;
  const max = config?.maxWorkers ?? 4;
  const cpuWorkers = Math.min(max, Math.max(min, Math.round(Number(workersEl.value) || min)));
  workersEl.value = String(cpuWorkers);
  restarting = true;
  applyEngineBtn.disabled = true;
  setNote('Restarting engine… (can take ~a minute)', '');
  send({ target: 'background', cmd: 'restart-engine', cpuWorkers, voice: selectedVoice || undefined });
});

const LOADING_STATES = new Set<PlaybackStatus['state']>(['connecting', 'starting-engine', 'buffering']);

/**
 * Same rule as the on-page bar: playing ⇒ Pause; loading/buffering ⇒ Pause with a
 * spinner (clicking pauses but keeps buffering); a user pause or stopped ⇒ Play.
 * Stop is a separate button. Keyed by mode so the spinner isn't rebuilt (and its
 * animation restarted) on every snapshot.
 */
function setPlayPause(state: PlaybackStatus['state'], paused: boolean, hasCurrent: boolean): void {
  const loading = LOADING_STATES.has(state);
  const mode = paused ? 'play' : loading ? 'loading' : state === 'playing' ? 'pause' : 'play';
  if (playPauseBtn.dataset.mode !== mode) {
    playPauseBtn.dataset.mode = mode;
    if (loading) {
      playPauseBtn.textContent = '';
      const sp = document.createElement('span');
      sp.className = 'spinner';
      playPauseBtn.append(sp, document.createTextNode(' Pause'));
    } else {
      playPauseBtn.textContent = mode === 'pause' ? 'Pause' : 'Play';
    }
  }
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

playPauseBtn.addEventListener('click', () => send({ target: 'background', cmd: 'transport', op: 'toggle-pause' }));
stopBtn.addEventListener('click', () => send({ target: 'background', cmd: 'transport', op: 'stop' }));
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

// Seed the voice selection from storage before the first snapshot arrives.
void loadSettings().then((s) => { selectedVoice = s.voice; voicesSig = null; render(); });

// Ask background for current state; it replies via a 'snapshot' push (and the
// offscreen player broadcasts a fresh one right after).
render();
send({ target: 'background', cmd: 'sync' });
