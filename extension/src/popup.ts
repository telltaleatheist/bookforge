/**
 * Toolbar popup — the remote: which voice, Load / Unload on the selected
 * Crucible, "show controls on page", basic transport, and the tab recorder.
 *
 * The voice sits directly above the Load button on purpose: loading puts that
 * voice on somebody's card, so you can see which one before you press it.
 *
 * ── Phase 16 ───────────────────────────────────────────────────────────────
 *
 * The one button was "Start / Stop TTS server" and it started a process inside
 * BookForge. It is "Load voice / Unload" now (plan §0): a `load-voice` job on
 * the Crucible selected in Options, with the job's own events driving the
 * button's state, and "engine up" is that server's RESIDENT voice rather than
 * anything this extension owns.
 *
 * Gone with it: the engine selector (a voice implies its engine — §4a), the CPU
 * worker count (XTTS-only, and XTTS is removed) and "Restart to apply" (there
 * is no process here to restart).
 *
 * PREEMPT IS NEVER SILENT. When the card is held by someone else the refusal
 * says WHO, from /v1/activity, and this popup offers no way to take it — that
 * is an explicit act through the engine, not a second press of Load.
 *
 * It renders the QueueSnapshot the offscreen player broadcasts; commands go up
 * through the background relay. On open it pokes a 'sync' so the offscreen doc
 * re-reads the server. The queue itself is no longer surfaced — reading is
 * driven from the page's own controls now.
 */

import {
  IDLE_RECORDING,
  PlaybackStatus,
  QueueSnapshot,
  RecordingStatus,
  RuntimeMessage,
  VoiceRow,
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
  const state = snapshot?.engineState ?? 'stopped';
  const engine = snapshot?.engine ?? null;
  const where = engine?.server ?? null;

  // Which Crucible, and what is on its card.
  if (!connected) {
    dot.className = 'dot off';
    // snapshot present but not connected ⇒ mid-read of the server; null ⇒ still
    // waiting on the offscreen player to come up.
    statusText.textContent = snapshot ? (snapshot.connectionError ?? 'Connecting…') : 'Checking…';
  } else if (state === 'running') {
    dot.className = 'dot on';
    statusText.textContent = `${engine?.resident} loaded on ${where}`;
  } else if (state === 'starting') {
    dot.className = 'dot warn';
    statusText.textContent = `Loading on ${where}…`;
  } else {
    dot.className = 'dot warn';
    statusText.textContent = `${where} — nothing loaded`;
  }

  // Load / Unload
  if (engine?.busy === 'unloading') {
    serverBtn.textContent = 'Unloading…';
    serverBtn.className = 'danger';
    serverBtn.disabled = true;
  } else if (state === 'running') {
    serverBtn.textContent = 'Unload';
    serverBtn.className = 'danger';
    serverBtn.disabled = false;
  } else if (state === 'starting') {
    serverBtn.textContent = 'Loading…';
    serverBtn.className = 'primary';
    serverBtn.disabled = true;
  } else {
    serverBtn.textContent = 'Load voice';
    serverBtn.className = 'primary';
    // Nothing to load onto: say so with the button rather than with a failure
    // after the press.
    serverBtn.disabled = !connected;
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

// ─── The voice, and what is on the card ───────────────────────────────────────

// The voice the Load button will make resident (chrome.storage `voice`).
// Loaded once, then owned by the dropdown.
let selectedVoice = '';
// Rebuild the <option>s only when the voice list actually changes (null = never
// built yet) so a 300 ms snapshot tick can't reset the dropdown mid-interaction.
let voicesSig: string | null = null;

/**
 * THE ENGINE IS A COLUMN, NEVER A SELECTOR (plan §4a).
 *
 * Every `/v1/voices` row names its own `narratorEngine`. A voice implies its
 * engine, so no client ever picks an engine apart from a voice — which is why
 * the engine `<select>` and its "Restart to apply" are deleted rather than
 * hidden, and why the next voice engine costs this file nothing. The engine
 * appears in the label only when the list actually spans more than one.
 */
function buildVoiceOptions(rows: VoiceRow[]): void {
  const engines = new Set(rows.map((v) => v.engine));
  voiceEl.textContent = '';
  // Keep the saved voice selectable even if the server has not answered yet.
  if (selectedVoice && !rows.some((v) => v.id === selectedVoice)) {
    const o = document.createElement('option');
    o.value = selectedVoice;
    o.textContent = selectedVoice;
    voiceEl.appendChild(o);
  }
  // No "engine default" entry on purpose: it meant "send no voice and let the
  // server pick", which is exactly how a block ended up read by a model the user
  // never chose. The listed voice is the voice.
  for (const v of rows) {
    const o = document.createElement('option');
    o.value = v.id;
    o.textContent = engines.size > 1 ? `${v.display} — ${v.engine}` : v.display;
    // A voice that cannot be loaded on that host stays VISIBLE and disabled with
    // the server's own reason as its title: "not installed" is something you can
    // act on, a missing row is not.
    o.disabled = !v.loadable && !v.resident;
    if (v.reason) o.title = v.reason;
    voiceEl.appendChild(o);
  }
  voiceEl.value = selectedVoice;
}

function renderEngine(): void {
  const s = snapshot;
  const rows = s?.voiceRows ?? [];
  const engine = s?.engine ?? null;
  const connected = !!s?.connected;

  const sig = rows.map((v) => `${v.id}:${v.engine}:${v.loadable}:${v.resident}`).join('|');
  if (sig !== voicesSig) { voicesSig = sig; buildVoiceOptions(rows); }

  // Mirror the resident voice so the popup stays in lockstep with whatever the
  // server is actually holding. Don't clobber while the dropdown is open.
  const cv = s?.currentVoice ?? null;
  if (cv && cv !== selectedVoice && document.activeElement !== voiceEl) {
    selectedVoice = cv;
    try { void chrome.storage.local.set({ voice: selectedVoice }); } catch { /* orphaned context */ }
    if (!rows.some((v) => v.id === cv)) buildVoiceOptions(rows); else voiceEl.value = cv;
  }
  voiceEl.disabled = !connected;

  // The note, in order of what a person needs to know first.
  if (!connected) { setNote(s?.connectionError ?? 'Pick a Crucible in Options.', 'bad'); return; }
  if (engine?.holder) { setNote(engine.holder, 'bad'); return; }
  if (engine?.note) { setNote(engine.note, engine.busy ? '' : 'bad'); return; }
  if (s?.switchingVoice) { setNote(`Loading ${s.switchingVoice}…`, ''); return; }
  if (engine?.residentKind && engine.residentKind !== 'tts') {
    setNote(`${engine.server} is holding a ${engine.residentKind}, not a voice. Loading a voice `
      + 'here would take the card from whatever put it there.', 'bad');
    return;
  }
  setNote(
    engine?.resident
      ? `${engine.resident} on ${engine.server} (${engine.backend ?? 'backend unknown'}).`
      : `${engine?.server ?? 'No server'} — nothing loaded. Press Load voice.`,
    '',
  );
}

function setNote(text: string, cls: '' | 'good' | 'bad'): void {
  engineNote.textContent = text;
  engineNote.className = cls ? `note ${cls}` : 'note';
}

// ─── The idle unload ──────────────────────────────────────────────────────────
//
// THIS EXTENSION'S TIMER, not the server's. A Crucible's residency is the
// operator's and its own idle rule is the server's; what a client can honestly
// say is "I am finished with it", and this is how long it waits before saying
// so. It used to be `config.set {idleMinutes}` against BookForge's own pool.

const IDLE_CHOICES = [5, 10, 15, 30, 60, 120, 0];
let idleBuilt = false;

function idleLabel(minutes: number): string {
  if (minutes === 0) return 'Never';
  if (minutes < 60) return `${minutes} minutes idle`;
  return minutes === 60 ? '1 hour idle' : `${minutes / 60} hours idle`;
}

function renderIdle(): void {
  if (!idleBuilt) {
    idleBuilt = true;
    idleEl.textContent = '';
    for (const m of IDLE_CHOICES) {
      const o = document.createElement('option');
      o.value = String(m);
      o.textContent = idleLabel(m);
      idleEl.appendChild(o);
    }
  }
  const current = snapshot?.engine.idleMinutes;
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
// long. It takes effect on the NEXT block that starts: a block already generating
// was judged under the bargain it started with, and the gate cannot change its
// mind about audio already in the buffer.
//
// SINCE PHASE 16 IT ASKS THE SERVER FOR NOTHING. Crucible's streaming door
// always emits sub-sentence frames; the switch picks whether this extension
// plays them as they land or holds each row until it is whole.

function renderBuffering(): void {
  bufferNote.textContent = bufferEl.checked
    ? 'Waits for a cushion, then plays through without gaps.'
    : 'Fast start: plays after ~1s. May pause if the server falls behind.';
}

bufferEl.addEventListener('change', () => {
  void chrome.storage.local.set({ bufferBeforePlaying: bufferEl.checked });
  renderBuffering();
});

voiceEl.addEventListener('change', () => {
  // Picking a voice IS the instruction to use it: generation stops, the server
  // is asked to make that voice resident, and playback restarts in it once it
  // is. No confirmation prompt — the user just told us what they want.
  selectedVoice = voiceEl.value;
  void chrome.storage.local.set({ voice: selectedVoice });
  send({ target: 'background', cmd: 'set-voice', voice: selectedVoice });
  setNote(`Loading ${selectedVoice}…`, '');
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
  // Load makes the PICKED voice resident; Unload gives the card back. Neither
  // starts or stops a process, and neither takes the card from anyone: a
  // refusal names the holder and stops there.
  const op = snapshot?.engineState === 'running' ? 'unload' : 'load';
  send({ target: 'background', cmd: 'engine', op, voice: selectedVoice || undefined });
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
