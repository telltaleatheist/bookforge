/**
 * Options page — the Crucible server registry, the voice, the idle-unload
 * window, the playback gate and speed, and the tab recorder's BookForge
 * address.
 *
 * ── What changed in Phase 16 ────────────────────────────────────────────────
 *
 * The page used to be three fields pointing at BookForge's WebSocket and a
 * "Test connection" that said hello to it. Speech is a Crucible's now
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md), so the top of this page is a REGISTRY:
 * paste a `crucible://` connect code, pick one server, Test it, Remove it.
 *
 * The BookForge host/port/token rows are still here and are labelled for what
 * they are — the tab RECORDER's, which needs a machine with a filesystem to
 * write its FLAC. See protocol.ts for the conflict that leaves in the plan's
 * step 6.
 *
 * ── The permission prompt is deliberate, and it has to be here ──────────────
 *
 * `fetch` from an extension needs a host permission for the origin, the set of
 * servers is the user's, and Chrome only grants an optional permission from a
 * USER GESTURE. So Add and Test call `chrome.permissions.request` synchronously
 * inside the click handler — the offscreen document has no gesture to spend and
 * would simply be refused, which is why it never asks.
 *
 * ── What is NOT on this page, and why ───────────────────────────────────────
 *
 * The engine selector (a voice implies its engine — plan §4a), the generation
 * device (always the Crucible's), the CPU worker count (XTTS-only; XTTS is
 * gone), and engine start/stop/restart (they ARE the popup's Load/Unload).
 */

import { DEFAULT_SETTINGS, Settings, loadSettings } from './messages';
import {
  addFromPairing,
  clientFor,
  hasOriginPermission,
  loadRegistry,
  removeServer,
  requestOriginPermission,
  selectServer,
  type Registry,
  type ServerEntry,
} from './servers';
import { describeRefusal, probe } from './crucible';
import { addClip, listClips, removeClip, type ClipSummary } from './clips';
import { VoiceReferenceRefused } from '../../shared/crucible/voice-reference';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const serversEl = $('servers') as HTMLDivElement;
const pairingEl = $('pairing') as HTMLTextAreaElement;
const addBtn = $('add') as HTMLButtonElement;
const addResult = $('addResult') as HTMLSpanElement;
const voiceEl = $('voice') as HTMLSelectElement;
const voiceHint = $('voiceHint') as HTMLParagraphElement;
const clipsEl = $('clips') as HTMLDivElement;
const clipFileEl = $('clipFile') as HTMLInputElement;
const clipNameEl = $('clipName') as HTMLInputElement;
const clipTranscriptEl = $('clipTranscript') as HTMLTextAreaElement;
const clipAddBtn = $('clipAdd') as HTMLButtonElement;
const clipResult = $('clipResult') as HTMLSpanElement;
const idleEl = $('idleMinutes') as HTMLSelectElement;
const bufferEl = $('bufferBeforePlaying') as HTMLInputElement;
const rateEl = $('rate') as HTMLSelectElement;
const hostEl = $('host') as HTMLInputElement;
const portEl = $('port') as HTMLInputElement;
const tokenEl = $('token') as HTMLInputElement;
const recordingsDirEl = $('recordingsDir') as HTMLInputElement;
const savedNote = $('saved') as HTMLSpanElement;

/** The windows offered for the idle unload. 0 is "never", and it is last. */
const IDLE_CHOICES = [5, 10, 15, 30, 60, 120, 0];
/** Playback speeds, pitch preserved. */
const RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

function idleLabel(minutes: number): string {
  if (minutes === 0) return 'Never';
  if (minutes < 60) return `${minutes} minutes idle`;
  return minutes === 60 ? '1 hour idle' : `${minutes / 60} hours idle`;
}

for (const m of IDLE_CHOICES) {
  const o = document.createElement('option');
  o.value = String(m);
  o.textContent = idleLabel(m);
  idleEl.appendChild(o);
}
for (const r of RATES) {
  const o = document.createElement('option');
  o.value = String(r);
  o.textContent = r === 1 ? 'Normal (1x)' : `${r}x`;
  rateEl.appendChild(o);
}

// ─── The registry ─────────────────────────────────────────────────────────────

let registry: Registry = { servers: [], selected: null };
/** The per-server line Test writes. Keyed by name so a redraw keeps it. */
const says = new Map<string, { text: string; cls: 'good' | 'bad' }>();

async function drawServers(): Promise<void> {
  try {
    registry = await loadRegistry();
  } catch (err) {
    // A corrupt registry is REFUSED, never repaired — it holds every token.
    serversEl.textContent = '';
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = err instanceof Error ? err.message : String(err);
    serversEl.appendChild(p);
    return;
  }
  serversEl.textContent = '';
  if (registry.servers.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No servers yet. Paste a connect code below.';
    serversEl.appendChild(p);
    voiceEl.textContent = '';
    voiceHint.textContent = 'Add a Crucible above, then its voices appear here.';
    return;
  }
  for (const entry of registry.servers) serversEl.appendChild(serverRow(entry));
  await drawVoices();
}

function serverRow(entry: ServerEntry): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'server';

  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'selected';
  radio.checked = registry.selected === entry.name;
  radio.title = 'Read from this server';
  radio.addEventListener('change', () => {
    void selectServer(entry.name).then(drawServers);
  });
  row.appendChild(radio);

  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = entry.name;
  const where = document.createElement('div');
  where.className = 'where';
  // The URL, never the token. Nothing on this page renders a token, masked or
  // otherwise: a masked secret on screen is still a secret in a screenshot.
  where.textContent = entry.url;
  who.append(name, where);
  const said = says.get(entry.name);
  if (said) {
    const say = document.createElement('div');
    say.className = `say ${said.cls}`;
    say.textContent = said.text;
    who.appendChild(say);
  }
  row.appendChild(who);

  const test = document.createElement('button');
  test.className = 'quiet';
  test.textContent = 'Test';
  test.addEventListener('click', () => { void testServer(entry, test); });
  row.appendChild(test);

  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    says.delete(entry.name);
    void removeServer(entry.name).then(drawServers);
  });
  row.appendChild(remove);

  return row;
}

/**
 * `/v1/ping` + `/v1/info` (+ `/v1/health` for what is on the card).
 *
 * The permission request comes FIRST and from inside this click: without the
 * origin granted, the fetch fails with a browser-level error that says nothing
 * about the server, and the user would be debugging the wrong machine.
 */
async function testServer(entry: ServerEntry, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  says.set(entry.name, { text: 'Testing…', cls: 'good' });
  await drawServers();
  try {
    if (!(await hasOriginPermission(entry.url)) && !(await requestOriginPermission(entry.url))) {
      says.set(entry.name, {
        text: 'Chrome was not given permission to reach that address, so nothing was asked of it.',
        cls: 'bad',
      });
      return;
    }
    const answer = await probe(clientFor(entry));
    const resident = answer.resident === null
      ? 'nothing loaded'
      : `${answer.resident} (${answer.residentKind ?? 'unknown kind'}) loaded`;
    says.set(entry.name, {
      text: answer.servesTts
        ? `${answer.name} ${answer.version} on ${answer.backend} — ${resident}.`
        : `${answer.name} ${answer.version} on ${answer.backend} does NOT serve speech.`,
      cls: answer.servesTts ? 'good' : 'bad',
    });
  } catch (err) {
    says.set(entry.name, { text: describeRefusal(err, entry.name), cls: 'bad' });
  } finally {
    button.disabled = false;
    await drawServers();
  }
}

addBtn.addEventListener('click', async () => {
  const line = pairingEl.value.trim();
  if (!line) { setAddResult('Paste a connect code first.', 'bad'); return; }
  addBtn.disabled = true;
  setAddResult('Adding…', 'pending');
  try {
    const entry = await addFromPairing(line);
    // Ask for the origin while the click's gesture is still live. A refusal is
    // NOT fatal — the server is registered and Test can ask again — but it is
    // said, because nothing will read from it until the answer is yes.
    const granted = await hasOriginPermission(entry.url) || await requestOriginPermission(entry.url);
    pairingEl.value = '';
    setAddResult(
      granted
        ? `Added ${entry.name}.`
        : `Added ${entry.name}, but Chrome has not been given permission to reach it. Press Test.`,
      granted ? 'good' : 'bad',
    );
    await drawServers();
  } catch (err) {
    setAddResult(err instanceof Error ? err.message : String(err), 'bad');
  } finally {
    addBtn.disabled = false;
  }
});

function setAddResult(text: string, cls: 'good' | 'bad' | 'pending'): void {
  addResult.textContent = text;
  addResult.className = `result ${cls}`;
}

// ─── The voice ────────────────────────────────────────────────────────────────

/**
 * The selected server's voices.
 *
 * THE ENGINE IS A COLUMN, NEVER A SELECTOR (plan §4a). It appears in the label
 * only when the list spans more than one narrator engine, because a voice
 * implies its engine and there is nothing to pick apart from a voice.
 */
async function drawVoices(): Promise<void> {
  const chosen = (await loadSettings()).voice;
  const entry = registry.servers.find((s) => s.name === registry.selected);
  if (entry === undefined) {
    voiceEl.textContent = '';
    voiceHint.textContent = 'Select a server above to see its voices.';
    return;
  }
  if (!(await hasOriginPermission(entry.url))) {
    voiceEl.textContent = '';
    voiceHint.textContent = `Press Test on "${entry.name}" — Chrome has not been given permission `
      + 'to reach it yet, so its voices cannot be read.';
    return;
  }
  let rows;
  try {
    rows = await clientFor(entry).voices();
  } catch (err) {
    voiceEl.textContent = '';
    voiceHint.textContent = describeRefusal(err, entry.name);
    return;
  }
  const engines = new Set(rows.map((v) => v.narratorEngine));
  voiceEl.textContent = '';
  for (const v of rows) {
    const o = document.createElement('option');
    const label = engines.size > 1 ? `${v.display} — ${v.narratorEngine}` : v.display;
    o.value = v.id;
    // A voice that is cloned from a clip says so IN THE LIST. Its row is the
    // authority (`needsReference`), never the id: picking it without a clip is
    // refused `reference_required`, and knowing that before the press beats
    // finding out after it.
    o.textContent = v.needsReference ? `${label} (needs a reference clip)` : label;
    o.disabled = !v.loadable && !v.resident;
    if (v.reason) o.title = v.reason;
    voiceEl.appendChild(o);
  }
  if (rows.some((v) => v.id === chosen)) voiceEl.value = chosen;
  const cloned = rows.filter((v) => v.needsReference).length;
  const clipLine = cloned === 0 ? ''
    : ` ${cloned === 1 ? 'One voice is' : `${cloned} voices are`} cloned from a reference clip — `
      + 'pick which of yours under the voice in the popup.';
  voiceHint.textContent = (engines.size > 1
    ? `${rows.length} voices on "${entry.name}", across ${engines.size} engines. A voice brings its `
      + 'engine with it — there is nothing else to choose.'
    : `${rows.length} voices on "${entry.name}". Load one from the toolbar popup.`) + clipLine;
}

// ─── Zero-shot clips ──────────────────────────────────────────────────────────
//
// A `zeroshot` voice is the base weights plus somebody's recording (plan §4b,
// crucible PHASE3-TTS.md §5's amendment). The WEIGHTS are the server's; the
// CLIP is this browser's, and it stays here until that voice is loaded. Two
// clients, two clip stores, one voice subject.
//
// EVERY REFUSAL IS THE SERVER'S OWN WORD, MADE EARLY. `reference_malformed`
// covers a file that is not a RIFF/WAVE container, a clip over narrator's
// 30-second budget, one over the 32 MiB ceiling, and a blank transcript —
// all four answerable from the bytes on this side, all four refused here
// rather than uploaded so a server can read the same header and say the same
// thing. Nothing is trimmed, converted or transcribed.

async function drawClips(): Promise<void> {
  let stored: ClipSummary[];
  try {
    stored = await listClips();
  } catch (err) {
    clipsEl.textContent = '';
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = err instanceof Error ? err.message : String(err);
    clipsEl.appendChild(p);
    return;
  }
  clipsEl.textContent = '';
  if (stored.length === 0) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No clips yet. A zero-shot voice cannot be loaded without one.';
    clipsEl.appendChild(p);
    return;
  }
  for (const clip of stored) clipsEl.appendChild(clipRow(clip));
}

function clipRow(clip: ClipSummary): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'server';

  const who = document.createElement('div');
  who.className = 'who';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = `${clip.name} — ${clip.seconds.toFixed(1)}s, `
    + `${clip.sampleRate} Hz, ${clip.channels === 1 ? 'mono' : `${clip.channels} ch`}`;
  const said = document.createElement('div');
  said.className = 'where';
  // The transcript IS the row's second line: it is the half of a clip that
  // cannot be heard, and a store that hid it would let a wrong one sit there.
  said.textContent = clip.transcript;
  who.append(name, said);
  row.appendChild(who);

  const remove = document.createElement('button');
  remove.className = 'danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    void removeClip(clip.id).then(drawClips);
  });
  row.appendChild(remove);

  return row;
}

clipAddBtn.addEventListener('click', async () => {
  const file = clipFileEl.files?.[0];
  if (file === undefined) { setClipResult('Choose a WAV file first.', 'bad'); return; }
  clipAddBtn.disabled = true;
  setClipResult('Reading…', 'pending');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const added = await addClip({
      name: clipNameEl.value,
      transcript: clipTranscriptEl.value,
      bytes,
    });
    clipFileEl.value = '';
    clipNameEl.value = '';
    clipTranscriptEl.value = '';
    setClipResult(`Added "${added.name}" (${added.seconds.toFixed(1)}s).`, 'good');
    await drawClips();
  } catch (err) {
    // A VoiceReferenceRefused already carries the server's code in front of
    // its sentence, which is the whole point of using the server's names.
    setClipResult(
      err instanceof VoiceReferenceRefused ? err.message
        : err instanceof Error ? err.message : String(err),
      'bad',
    );
  } finally {
    clipAddBtn.disabled = false;
  }
});

function setClipResult(text: string, cls: 'good' | 'bad' | 'pending'): void {
  clipResult.textContent = text;
  clipResult.className = `result ${cls}`;
}

// ─── The rest of the settings ─────────────────────────────────────────────────

async function restore(): Promise<void> {
  const s = await loadSettings();
  hostEl.value = s.host;
  portEl.value = String(s.port);
  tokenEl.value = s.token;
  recordingsDirEl.value = s.recordingsDir;
  bufferEl.checked = s.bufferBeforePlaying;
  idleEl.value = String(s.idleMinutes);
  rateEl.value = String(s.rate);
  await drawServers();
  await drawClips();
}

function current(): Pick<Settings, 'host' | 'port' | 'token' | 'recordingsDir'
  | 'bufferBeforePlaying' | 'idleMinutes' | 'rate' | 'voice'> {
  return {
    // The checkbox IS the setting — no `|| default` here. A default would only ever
    // fire for a box that is genuinely unchecked, i.e. it would refuse to let the
    // user turn fast start on.
    bufferBeforePlaying: bufferEl.checked,
    idleMinutes: Number(idleEl.value),
    rate: Number(rateEl.value),
    voice: voiceEl.value,
    host: hostEl.value.trim() || DEFAULT_SETTINGS.host,
    port: Number(portEl.value) || DEFAULT_SETTINGS.port,
    token: tokenEl.value.trim(),
    // Blank means the default. The path is NOT validated here — this machine's
    // filesystem is not the one it names, so the server is the only thing that
    // can honestly answer whether it exists, and it does so by name at record
    // time rather than guessing now.
    recordingsDir: recordingsDirEl.value.trim() || DEFAULT_SETTINGS.recordingsDir,
  };
}

async function save(): Promise<void> {
  await chrome.storage.local.set(current());
  savedNote.textContent = 'Saved';
  setTimeout(() => { savedNote.textContent = ''; }, 1200);
}

// Typed as HTMLElement because the list mixes <input> and <select>: a union of
// the two has two incompatible `addEventListener` overload sets and TypeScript
// refuses the call on it.
const SAVED_ON_CHANGE: HTMLElement[] =
  [hostEl, portEl, tokenEl, recordingsDirEl, bufferEl, idleEl, rateEl, voiceEl];
for (const el of SAVED_ON_CHANGE) {
  el.addEventListener('change', () => void save());
}

// A voice picked here is the one the popup's Load button will make resident,
// and the offscreen document reads it back out of storage — so it is saved and
// then announced, rather than sent as a command from a page that may be closed
// before the load finishes.
voiceEl.addEventListener('change', () => {
  chrome.runtime
    .sendMessage({ target: 'background', cmd: 'set-voice', voice: voiceEl.value })
    .catch(() => { /* nothing is playing; the stored value is read at the next start */ });
});

idleEl.addEventListener('change', () => {
  chrome.runtime
    .sendMessage({ target: 'background', cmd: 'set-idle', minutes: Number(idleEl.value) })
    .catch(() => { /* nothing is playing; the stored value is read at the next start */ });
});

void restore();
