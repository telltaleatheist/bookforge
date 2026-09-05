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

import {
  IDLE_RECORDING,
  PlaybackStatus,
  QueueSnapshot,
  RecordingStatus,
  RuntimeMessage,
  loadSettings
} from './messages';
import {
  DEFAULT_RECORDINGS_DIR,
  RECORD_SPEEDS,
  RECORDER,
  WAITING_FOR_AUDIO_MESSAGE,
  formatBytes,
  formatElapsed,
  minimumCaptureRateFor
} from '../../shared/audio/tab-recording';

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
const bufferEl = $('bufferBeforePlaying') as HTMLInputElement;
const bufferNote = $('bufferNote') as HTMLDivElement;
const workersEl = $('workers') as HTMLInputElement;
const engineEl = $('engine') as HTMLSelectElement;
const applyEngineBtn = $('applyEngine') as HTMLButtonElement;
const engineNote = $('engineNote') as HTMLDivElement;
const recStartBtn = $('recStart') as HTMLButtonElement;
const recStopBtn = $('recStop') as HTMLButtonElement;
const recDiscardBtn = $('recDiscard') as HTMLButtonElement;
const recIdleRow = $('recIdleRow') as HTMLDivElement;
const recLiveBox = $('recLiveBox') as HTMLDivElement;
const recTabTitle = $('recTabTitle') as HTMLDivElement;
const recClock = $('recClock') as HTMLSpanElement;
const recSize = $('recSize') as HTMLSpanElement;
const recMeter = $('recMeter') as HTMLSpanElement;
const recPath = $('recPath') as HTMLDivElement;
const recMsg = $('recMsg') as HTMLDivElement;
const recDot = $('recDot') as HTMLSpanElement;
const recTimes = $('recTimes') as HTMLSpanElement;
const recSpeedEl = $('recSpeed') as HTMLSelectElement;
const recSpeedNote = $('recSpeedNote') as HTMLDivElement;

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
  renderRecorder();
}

// ─── Recorder ─────────────────────────────────────────────────────────────────
//
// State comes down inside the QueueSnapshot, exactly like playback: the offscreen
// document owns the capture, so the popup only draws what it is told and sends
// three commands. The one thing the popup genuinely OWNS is the gesture —
// chrome.tabCapture.getMediaStreamId requires one, and only a real click is one.

/** The tab shown under the Record button, resolved once when the popup opens. */
let recorderTab: chrome.tabs.Tab | null = null;
/** The chosen capture speed, remembered between popups. */
let recordSpeed = 1;
/** Where the server will save it — the Options setting, shown so the answer to
 *  "where did it go" is on screen BEFORE the recording, not only after. */
let recordingsDir = DEFAULT_RECORDINGS_DIR;

for (const speed of RECORD_SPEEDS) {
  const o = document.createElement('option');
  o.value = String(speed);
  o.textContent = `${speed}x`;
  recSpeedEl.appendChild(o);
}

recSpeedEl.addEventListener('change', () => {
  recordSpeed = Number(recSpeedEl.value) || 1;
  void chrome.storage.local.set({ recordSpeed });
  renderRecorder();
});

function recorderState(): RecordingStatus {
  return snapshot?.recording ?? IDLE_RECORDING;
}

function renderRecorder(): void {
  const rec = recorderState();
  const live = rec.state === 'recording' || rec.state === 'starting' || rec.state === 'stopping';

  recIdleRow.classList.toggle('hidden', live);
  recLiveBox.classList.toggle('hidden', !live);
  recTabTitle.classList.toggle('hidden', live);

  recSpeedEl.disabled = live;
  recSpeedEl.value = String(recordSpeed);

  if (!live) {
    // Deliberately NOT gated on the connection: pressing Record with BookForge
    // shut is answered by name ("Can't reach BookForge…") from the offscreen
    // document, which is more useful than a button that silently does nothing.
    recStartBtn.disabled = !recorderTab;
    recTabTitle.textContent = recorderTab?.title
      ? `Captures: ${recorderTab.title} → ${recordingsDir}`
      : 'Open the tab you want to record, then reopen this popup.';
    // The capture rate isn't knowable until capture starts, so say up front what
    // each speed needs — the refusal at start time then never comes as a surprise.
    recSpeedNote.textContent = recordSpeed > 1
      ? `${recordSpeed}x needs a ${minimumCaptureRateFor(recordSpeed) / 1000} kHz capture; ` +
        `the file is written at capture ÷ ${recordSpeed}.`
      : '';
  } else {
    // BOOK time is the headline — it is the length of the file being made.
    recClock.textContent = rec.state === 'starting' ? '0:00:00' : formatElapsed(rec.seconds);
    // At speed, the wall clock is the other number the user cares about ("how
    // much longer do I have to leave this running").
    recTimes.textContent = rec.speed > 1 ? `book · ${formatElapsed(rec.seconds / rec.speed)} elapsed` : '';
    recSize.textContent = rec.bytes > 0 ? formatBytes(rec.bytes) : '';
    // RMS is small for speech even at a healthy level; the square root opens the
    // bottom of the meter so it reads as a level and not as a flat line.
    recMeter.style.width = `${Math.min(100, Math.round(Math.sqrt(Math.max(0, rec.level)) * 140))}%`;
    recStopBtn.disabled = rec.state !== 'recording';
    recDiscardBtn.disabled = rec.state === 'stopping';
    // Amber while nothing has been heard yet — the recording IS running, it just
    // has nothing to record.
    recDot.className = rec.waiting ? 'reddot waiting' : 'reddot';
    recClock.classList.toggle('waiting', rec.waiting);
  }

  // The destination is worth showing WHILE recording (so you know where it is
  // going) as well as after.
  const showPath = !!rec.path && (live || rec.state === 'done');
  recPath.classList.toggle('hidden', !showPath);
  recPath.textContent = rec.path ?? '';

  let msg = '';
  let cls: 'bad' | 'warn' | 'good' | '' = '';
  if (rec.state === 'error') { msg = rec.error ?? 'Recording failed'; cls = 'bad'; }
  else if (rec.state === 'done') {
    msg = rec.warning ? `Saved — ${rec.warning}` : `Saved (${formatElapsed(rec.seconds)})`;
    cls = rec.warning ? 'warn' : 'good';
  } else if (rec.state === 'stopping') { msg = 'Finishing the FLAC…'; }
  else if (rec.waiting) {
    // Nothing heard yet. Not a fault — but the same 30 s silence rule is running,
    // so the budget for pressing play is shown rather than sprung.
    msg = `${WAITING_FOR_AUDIO_MESSAGE} (stops in ${Math.ceil(rec.silenceRemaining)}s)`;
    cls = 'warn';
  } else if (rec.state === 'recording' && rec.silenceRemaining < RECORDER.SILENCE_STOP_SECONDS) {
    // Audio HAS been heard and has now gone quiet: same countdown, same rule.
    msg = `Silence — stops in ${Math.ceil(rec.silenceRemaining)}s`;
    cls = 'warn';
  } else if (rec.warning) { msg = rec.warning; cls = 'warn'; }
  else if (rec.state === 'starting') { msg = 'Asking BookForge for a file…'; }
  else if (rec.speed > 1 && rec.captureSampleRate > 0) {
    msg = `${rec.speed}x — writing a ${Math.round(rec.captureSampleRate / rec.speed)} Hz file`;
  }
  recMsg.classList.toggle('hidden', !msg);
  recMsg.textContent = msg;
  recMsg.className = cls ? `msg ${cls}` : 'msg';
}

/**
 * chrome.tabCapture.getMediaStreamId in its callback form — the only form every
 * Chrome build supports (the promise overload is newer than the @types package,
 * and this API was promisified late). A refusal arrives as runtime.lastError, not
 * a throw, so it is turned into one here rather than resolving with nothing.
 */
function tabStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? 'Chrome returned no capture stream'));
      else resolve(id);
    });
  });
}

recStartBtn.addEventListener('click', async () => {
  const tab = recorderTab ?? (await activeTab()) ?? null;
  recorderTab = tab;
  if (!tab || tab.id === undefined) return;
  recStartBtn.disabled = true;
  let streamId = '';
  try {
    // THE gesture. Chrome mints an id bound to this tab; the offscreen document
    // turns it into a MediaStream. A tab Chrome refuses to capture (chrome://,
    // the Web Store) throws here, and that is the honest message to show.
    streamId = await tabStreamId(tab.id);
  } catch (err) {
    recMsg.classList.remove('hidden');
    recMsg.className = 'msg bad';
    recMsg.textContent = `Chrome would not capture this tab: ${(err as Error).message}`;
    recStartBtn.disabled = false;
    return;
  }
  send({
    target: 'background',
    cmd: 'record',
    op: 'start',
    streamId,
    tabId: tab.id,
    speed: recordSpeed,
    title: tab.title ?? '',
    url: tab.url ?? ''
  });
});

recStopBtn.addEventListener('click', () => {
  recStopBtn.disabled = true;
  send({ target: 'background', cmd: 'record', op: 'stop' });
});

recDiscardBtn.addEventListener('click', () => {
  recDiscardBtn.disabled = true;
  send({ target: 'background', cmd: 'record', op: 'discard' });
});

// Which tab the Record button will capture — the active tab of THIS window, which
// may itself be a popup window (Audible opens its player in one; that is still a
// tab and captures the same way).
void activeTab().then((tab) => { recorderTab = tab ?? null; renderRecorder(); });

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

// The engine list, rebuilt only when it actually changes — same reason the voice
// list is: a 300 ms snapshot tick must not reset a dropdown mid-interaction.
let enginesSig: string | null = null;

function buildEngineOptions(engines: EngineInfo[], current: string | null): void {
  engineEl.textContent = '';
  for (const e of engines) {
    const o = document.createElement('option');
    o.value = e.id;
    // The reason rides in the label as well as the tooltip. A popup is 300px wide
    // and a title attribute is invisible on a touchpad; "Higgs (unavailable)" at
    // least says why the click did nothing.
    o.textContent = e.available ? e.name : `${e.name} (unavailable)`;
    o.disabled = !e.available;
    if (e.reason) o.title = e.reason;
    engineEl.appendChild(o);
  }
  if (current) engineEl.value = current;
}

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

  // The engine chooser is only drawn when the server advertises one — an older
  // server sends no `engines`, and a chooser with nothing in it is worse than none.
  const engines = s?.engines ?? [];
  engineEl.parentElement?.toggleAttribute('hidden', engines.length === 0);
  const eSig = engines.map((e) => `${e.id}:${e.available}`).join('|') + `|${s?.engine ?? ''}`;
  if (eSig !== enginesSig) { enginesSig = eSig; buildEngineOptions(engines, s?.engine ?? null); }
  engineEl.disabled = !connected || restarting;

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

// ─── Buffer before playing (fast start) ───────────────────────────────────────
//
// The same switch as the one on the Options page, on the same chrome.storage key —
// duplicated because Owen's ruling of 2026-09-04 is that this is a thing you try
// mid-read, and the popup is what is already open when you decide the wait is too
// long. It takes effect on the NEXT block that starts generating: a session was
// launched with (or without) fastStart on the wire and the server cannot change
// its mind about a batch already in flight.

function renderBuffering(): void {
  bufferNote.textContent = bufferEl.checked
    ? 'Waits for a cushion, then plays through without gaps.'
    : 'Fast start: plays after ~1s. May pause if the engine falls behind.';
}

bufferEl.addEventListener('change', () => {
  void chrome.storage.local.set({ bufferBeforePlaying: bufferEl.checked });
  renderBuffering();
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

engineEl.addEventListener('change', () => {
  // AN ENGINE SWITCH IS A RESTART, always. The two engines are one resident
  // process whose engine was fixed by NARRATOR_ENGINE when it was spawned, so a
  // selection that did not restart would leave the old engine answering while
  // every picker showed the new one — audio that is fine, in the wrong voice, with
  // nothing saying so.
  //
  // The voice is deliberately NOT sent along: it belongs to the OUTGOING engine's
  // catalog and means nothing in the incoming one. The server picks that engine's
  // own default and reports it back, and the voice list redraws from the `config`
  // reply.
  const engine = engineEl.value;
  if (!engine || engine === snapshot?.engine) return;
  restarting = true;
  engineEl.disabled = true;
  applyEngineBtn.disabled = true;
  setNote(`Switching to ${engine}\u2026 (can take ~a minute)`, '');
  send({ target: 'background', cmd: 'restart-engine', engine });
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
void loadSettings().then((s) => {
  selectedVoice = s.voice;
  recordSpeed = (RECORD_SPEEDS as readonly number[]).includes(s.recordSpeed) ? s.recordSpeed : 1;
  recordingsDir = s.recordingsDir || DEFAULT_RECORDINGS_DIR;
  bufferEl.checked = s.bufferBeforePlaying;
  renderBuffering();
  voicesSig = null;
  render();
});

// Ask background for current state; it replies via a 'snapshot' push (and the
// offscreen player broadcasts a fresh one right after).
renderBuffering();  // matches the markup's default until settings land
render();
send({ target: 'background', cmd: 'sync' });
