/**
 * Toolbar popup — the remote: which voice, TTS-server start/stop, "show controls
 * on page", and basic transport.
 *
 * The voice sits directly above the start button on purpose: starting the server
 * loads a model (on Orpheus a custom voice IS a model), so you can see what you're
 * about to start before you press it.
 *
 * It renders the QueueSnapshot the offscreen player broadcasts; commands go up
 * through the background relay. On open it pokes a 'sync' so the offscreen doc
 * refreshes engine state (and connects if needed). The queue itself is no longer
 * surfaced — reading is driven from the page's own controls now.
 */

import { PlaybackStatus, QueueSnapshot, RuntimeMessage, loadSettings } from './messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dot = $('dot');
const statusText = $('statusText');
const serverBtn = $('server') as HTMLButtonElement;
const toggleUiBtn = $('toggleUi') as HTMLButtonElement;
const playPauseBtn = $('playPause') as HTMLButtonElement;
const stopBtn = $('stopBtn') as HTMLButtonElement;
const nowNote = $('nowNote') as HTMLDivElement;
const voiceEl = $('voice') as HTMLSelectElement;
const idleEl = $('idle') as HTMLSelectElement;
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

  // Not a queue — just enough to say whether anything is being read, and how to
  // start if not.
  nowNote.textContent = snapshot?.current
    ? `${playbackBadge()} ${snapshot.current.label}`
    : 'Hover a paragraph and press ▶ (or click a word) to read from there.';

  renderEngine();
  renderIdle();
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
  // No "engine default" entry on purpose: it meant "send no voice and let the
  // server pick", which is exactly how a block ended up read by a model the user
  // never chose. The listed voice is the voice.
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

  if (s?.switchingVoice) { setNote(`Loading ${s.switchingVoice}… (a custom voice is a whole model)`, ''); return; }
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

// ─── Idle shutdown ────────────────────────────────────────────────────────────

// Rebuilt only when the server offers a different ladder (it sends the choices so
// the app and the extension can't drift apart).
const DEFAULT_IDLE_CHOICES = [5, 10, 15, 30, 60, 0];
let idleSig = '';

function idleLabel(minutes: number): string {
  if (minutes === 0) return 'Never';
  if (minutes < 60) return `${minutes} minutes idle`;
  return minutes === 60 ? '1 hour idle' : `${minutes / 60} hours idle`;
}

function renderIdle(): void {
  const config = snapshot?.config;
  const choices = config?.idleChoices?.length ? config.idleChoices : DEFAULT_IDLE_CHOICES;
  const sig = choices.join('|');
  if (sig !== idleSig) {
    idleSig = sig;
    idleEl.textContent = '';
    for (const m of choices) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = idleLabel(m);
      idleEl.appendChild(o);
    }
  }
  idleEl.disabled = !snapshot?.connected;
  const current = config?.idleMinutes;
  if (typeof current === 'number' && document.activeElement !== idleEl) {
    idleEl.value = String(current);
  }
}

idleEl.addEventListener('change', () => {
  send({ target: 'background', cmd: 'set-idle', minutes: Number(idleEl.value) });
});

voiceEl.addEventListener('change', () => {
  // Picking a voice IS the instruction to use it: generation stops, the engine
  // loads that model, and playback restarts in it once the engine confirms. No
  // confirmation prompt — the user just told us what they want.
  selectedVoice = voiceEl.value;
  void chrome.storage.local.set({ voice: selectedVoice });
  send({ target: 'background', cmd: 'set-voice', voice: selectedVoice });
  if (!restarting) setNote(`Loading ${selectedVoice}…`, '');
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
