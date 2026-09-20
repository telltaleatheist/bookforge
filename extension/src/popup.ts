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
  EngineStatus,
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
import { listClips, type ClipSummary } from './clips';
import { unreadableBecause } from './voice-band';

/**
 * What the tooltip calls the server before one is picked.
 *
 * It is never shown in practice — there are no voice rows without a server to
 * have fetched them — and it is a LABEL rather than a fallback: nothing is
 * derived from it and no request is made with it.
 */
const NO_SERVER_PICKED = 'the selected server';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const dot = $('dot');
const statusText = $('statusText');
const serverBtn = $('server') as HTMLButtonElement;
const workBox = $('work') as HTMLElement;
const workSay = $('workSay') as HTMLElement;

/**
 * WHAT THIS POPUP ITSELF JUST ASKED FOR, before any answer has come back.
 *
 * Owen, 2026-09-15: *"i hit unload and it took a minute to actually do
 * anything. maybe show that it was clicked and its working on it."*
 *
 * The button's busy states were already here and already correct — and every
 * one of them was read off the SNAPSHOT, which arrives when the background
 * next publishes one. So between the press and that publication the button sat
 * there looking unpressed, which reads as a click that missed. Pressing again
 * is the natural thing to do and the worst thing to do.
 *
 * So the press is recorded HERE, immediately, and the snapshot takes over when
 * it arrives. This is not a second opinion about the engine's state: it says
 * only "this popup has asked and has not been answered yet", which is a fact
 * about this window that no snapshot can carry.
 */
let asked: 'loading' | 'unloading' | null = null;
let askedTimer: number | null = null;

/**
 * How long this window will claim a press the background never acknowledged.
 *
 * NOT A GUESS AT HOW LONG A LOAD TAKES — a cold Higgs load is 85 seconds on
 * Owen's own card, and a timer racing that would flip the button back to "Load
 * voice" while the voice was still loading, which is a worse lie than the one
 * this whole change is fixing. What it bounds is the OTHER failure: the message
 * never reached the background at all, so `busy` is never coming and nothing
 * would ever clear the spinner. `busy` appears as soon as the job is posted, so
 * if it has not appeared by now the press did not take.
 */
const ASKED_GIVE_UP_MS = 12000;

function stopAskedTimer(): void {
  if (askedTimer === null) return;
  clearTimeout(askedTimer);
  askedTimer = null;
}

/**
 * Stop waiting locally once the server's own state accounts for the press.
 *
 * `busy` is the background saying the job is in flight — the moment the truth
 * arrives, this window's guess must get out of its way, including when the
 * answer is "it failed" or "it was already loaded". A local flag that outlived
 * the fact it stood in for would be a spinner nothing could stop.
 */
/**
 * The mark a working button wears.
 *
 * A DISABLED BUTTON ALONE IS AMBIGUOUS: greyed out reads as "you cannot do this
 * right now", which is what an unconnected server's Load button also looks like.
 * The spinner is what separates "not available" from "already working on it",
 * and it is the difference between waiting and pressing again.
 */
function spinner(): HTMLElement {
  const mark = document.createElement('span');
  mark.className = 'spin';
  mark.setAttribute('aria-hidden', 'true');
  return mark;
}

function settleAsked(engine: EngineStatus | null | undefined): void {
  if (asked === null) return;
  // `busy` is the background saying it has the job. From here the SNAPSHOT is
  // the truth and this window's guess must get out of its way.
  if (engine?.busy) { asked = null; stopAskedTimer(); return; }
  if (asked === 'loading' && engine?.resident) { asked = null; stopAskedTimer(); return; }
  if (asked === 'unloading' && !engine?.resident) { asked = null; stopAskedTimer(); }
}
const toggleUiBtn = $('toggleUi') as HTMLButtonElement;
const playPauseBtn = $('playPause') as HTMLButtonElement;
const stopBtn = $('stopBtn') as HTMLButtonElement;
const nowNote = $('nowNote') as HTMLDivElement;
const voiceEl = $('voice') as HTMLSelectElement;
const clipRow = $('clipRow') as HTMLDivElement;
const clipEl = $('clip') as HTMLSelectElement;
const clipNote = $('clipNote') as HTMLDivElement;
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
  //
  // THIS WINDOW'S OWN PRESS COMES FIRST. `asked` is set by the click handler and
  // cleared the moment the server's state accounts for it; until then it is the
  // only thing that knows a press happened, because `busy` cannot arrive before
  // the background has published a snapshot.
  settleAsked(engine);
  const working: 'loading' | 'unloading' | null = engine?.busy ?? asked;

  // THE BAR, for both directions. An unload is usually quick and sometimes is
  // not — Owen pressed one and waited a minute — so it gets the same treatment
  // as a load rather than being assumed fast.
  workBox.hidden = working === null;
  if (working !== null) {
    // The SERVER'S words when there are any, and a plain statement when there
    // are none yet. Not "please wait": that says nothing this does not.
    workSay.textContent = engine?.note
      ?? (working === 'loading' ? 'Asking the server to load it…' : 'Asking the server to unload…');
  }

  if (working === 'unloading') {
    serverBtn.replaceChildren(spinner(), document.createTextNode('Unloading…'));
    serverBtn.className = 'danger';
    serverBtn.disabled = true;
  } else if (working === 'loading') {
    serverBtn.replaceChildren(spinner(), document.createTextNode('Loading…'));
    serverBtn.className = 'primary';
    serverBtn.disabled = true;
  } else if (state === 'running') {
    serverBtn.textContent = 'Unload';
    serverBtn.className = 'danger';
    serverBtn.disabled = false;
  } else if (state === 'starting') {
    serverBtn.replaceChildren(spinner(), document.createTextNode('Loading…'));
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
function buildVoiceOptions(rows: VoiceRow[], serverName: string): void {
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
    const label = engines.size > 1 ? `${v.display} — ${v.engine}` : v.display;
    // A voice that cannot be loaded on that host stays VISIBLE and disabled with
    // the server's own reason as its title: "not installed" is something you can
    // act on, a missing row is not.
    //
    // SO DOES ONE WITH NO MEASURED LENGTH, and for the same reason. Since
    // Crucible 1.0.7 a row may state no cap and no safe band at all — a
    // checkpoint being screened, whose numbers are what the screening run
    // exists to produce (`crucible/docs/PHASE18-UNCERTIFIED.md` §4). It is a
    // real voice and it loads; it is not one a web page can be packed against,
    // and saying so HERE is the difference between a greyed row with a reason
    // and a green Load followed by a refusal at the moment you press play.
    // `unreadableBecause` is the same function the offscreen document's packer
    // refuses through, so what this picker offers and what can be read are one
    // answer rather than two.
    const unreadable = unreadableBecause(v.id, serverName, v.lengths);
    o.textContent = unreadable === null ? label : `${label} — no measured length`;
    o.disabled = (!v.loadable && !v.resident) || unreadable !== null;
    if (unreadable !== null) o.title = unreadable;
    else if (v.reason) o.title = v.reason;
    voiceEl.appendChild(o);
  }
  voiceEl.value = selectedVoice;
}

function renderEngine(): void {
  const s = snapshot;
  const rows = s?.voiceRows ?? [];
  const engine = s?.engine ?? null;
  const connected = !!s?.connected;

  // The server's registered name is IN the signature because it is in a
  // tooltip the options carry ("Crucible X states no measured chunk length…"),
  // and so are the lengths: a voice that gains a measured cap — which is what
  // finishing a screening run DOES to it — has to stop being greyed out
  // without waiting for something else about the row to change.
  const serverName = engine?.server ?? NO_SERVER_PICKED;
  const sig = [serverName].concat(rows.map((v) => `${v.id}:${v.engine}:${v.loadable}:`
    + `${v.resident}:${v.needsReference}:${v.lengths.maxChars}:${v.lengths.safeMinChars}:`
    + `${v.lengths.safeMaxChars}`)).join('|');
  if (sig !== voicesSig) { voicesSig = sig; buildVoiceOptions(rows, serverName); }
  renderClipPicker(rows);

  // Mirror the resident voice so the popup stays in lockstep with whatever the
  // server is actually holding. Don't clobber while the dropdown is open.
  const cv = s?.currentVoice ?? null;
  if (cv && cv !== selectedVoice && document.activeElement !== voiceEl) {
    selectedVoice = cv;
    try { void chrome.storage.local.set({ voice: selectedVoice }); } catch { /* orphaned context */ }
    if (!rows.some((v) => v.id === cv)) buildVoiceOptions(rows, serverName); else voiceEl.value = cv;
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
  /*
   * WHICH CLIP, BESIDE WHICH VOICE. `zeroshot` is one voice id and any number
   * of recordings, so "zeroshot on mac-studio" is not an answer to "whose
   * voice will this be read in" — and this extension is not the only client
   * that can put one there. `residentClipNote` is the case where the server
   * could not be asked; it is SHOWN rather than left blank, because a blank
   * where a clip name goes reads as "no clip", which would be a lie.
   */
  if (engine?.resident && engine.residentClipNote) {
    setNote(`${engine.resident} on ${engine.server} — ${engine.residentClipNote}`, 'bad');
    return;
  }
  const clonedFrom = engine?.residentClip ? `, cloned from "${engine.residentClip}"` : '';
  setNote(
    engine?.resident
      ? `${engine.resident} on ${engine.server}${clonedFrom} `
        + `(${engine.backend ?? 'backend unknown'}).`
      : `${engine?.server ?? 'No server'} — nothing loaded. Press Load voice.`,
    '',
  );
}

// ─── The zero-shot clip ───────────────────────────────────────────────────────
//
// A `zeroshot` voice is the base weights plus somebody's recording, and the
// RECORDING is this browser's (plan §4b). So the picker for it sits directly
// under the voice, appears only for a row whose `needsReference` is true, and
// is a choice with NO default: loading with nothing picked is refused
// `reference_required` — the server's own word — before anything is sent.

/** The clips in this browser's store, read once when the popup opens. */
let clips: ClipSummary[] = [];
/** The one the Load button will send, or '' for none. */
let selectedClip = '';
/** Rebuild the <option>s only when something actually changed. */
let clipSig: string | null = null;

function renderClipPicker(rows: VoiceRow[]): void {
  const row = rows.find((v) => v.id === selectedVoice);
  const wanted = row?.needsReference === true;
  clipRow.classList.toggle('hidden', !wanted);
  if (!wanted) return;

  const sig = `${clips.map((c) => `${c.id}:${c.name}`).join('|')}#${selectedClip}`;
  if (sig !== clipSig) {
    clipSig = sig;
    clipEl.textContent = '';
    // "No clip" is a real, named state and it is FIRST, so a picker that has
    // not been touched says what it is rather than silently nominating a
    // recording the user did not choose.
    const none = document.createElement('option');
    none.value = '';
    none.textContent = clips.length === 0 ? 'No clips in this browser' : 'No clip picked';
    clipEl.appendChild(none);
    for (const c of clips) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${c.name} — ${c.seconds.toFixed(1)}s`;
      o.title = c.transcript;
      clipEl.appendChild(o);
    }
    clipEl.value = clips.some((c) => c.id === selectedClip) ? selectedClip : '';
  }
  clipNote.textContent = clips.length === 0
    ? 'This voice is cloned from a recording and there are none here. Add one in Options → '
      + 'Zero-shot clips (a WAV and the book-exact text it says).'
    : selectedClip === ''
      ? 'reference_required — pick a clip. The base weights with no recording are the model\'s '
        + 'OWN speaker, not the voice you chose.'
      : 'Loading this voice clones it from that recording.';
}

clipEl.addEventListener('change', () => {
  // Picking a clip IS the instruction to use it, exactly as picking a voice
  // is: a different recording is a different speaker under the same id.
  selectedClip = clipEl.value;
  clipSig = null;
  void chrome.storage.local.set({ zeroshotClipId: selectedClip });
  send({ target: 'background', cmd: 'set-clip', clipId: selectedClip });
  renderEngine();
});

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
  /*
   * RECORDED BEFORE THE MESSAGE GOES, and rendered immediately.
   *
   * `send` is fire-and-forget across a port; the answer comes back as a
   * snapshot whenever the background next publishes one, and on a cold server
   * that was a minute. Setting this first is what makes the press visible in
   * the same frame as the click.
   */
  asked = op === 'unload' ? 'unloading' : 'loading';
  stopAskedTimer();
  askedTimer = window.setTimeout(() => {
    // Only reached when `busy` never arrived — see ASKED_GIVE_UP_MS. Said
    // rather than silently reverted: a button that quietly un-pressed itself
    // is how somebody ends up loading a voice twice.
    if (asked !== null) {
      asked = null;
      render();
      /*
       * AFTER the render, not before: `render()` hides the work box when
       * nothing is in flight, and it would take this line down with it. The
       * note is the surface that survives a redraw — and it is the one the
       * engine's own refusals already use, so this reads where those read.
       */
      setNote('The extension did not hear back about that press — try it again.', 'bad');
    }
  }, ASKED_GIVE_UP_MS);
  render();
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
// The clip store is IndexedDB and is the same store the Options page writes
// and the offscreen document reads — one store, three windows onto it.
void listClips().then((found) => {
  clips = found;
  clipSig = null;
  render();
}, (err: unknown) => {
  clips = [];
  clipSig = null;
  clipNote.textContent = err instanceof Error ? err.message : String(err);
});

void loadSettings().then((s) => {
  selectedVoice = s.voice;
  selectedClip = s.zeroshotClipId;
  clipSig = null;
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
