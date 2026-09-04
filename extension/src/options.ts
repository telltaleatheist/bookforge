/**
 * Options page — connection settings (host / port / token), the recordings folder,
 * the "Buffer before playing" switch, and a "Test connection" that authenticates
 * against the server and reports engine state + discovered voices. Voice and CPU
 * worker count are configured in the popup (under "Engine settings"), since it has
 * live engine state.
 *
 * "Buffer before playing" is duplicated in the popup ON PURPOSE (Owen's ruling of
 * 2026-09-04): it is a thing to try mid-read — turn it off, listen, turn it back on
 * — and here is where you go to read what it actually does. Both pickers write the
 * same chrome.storage key, so neither is the master.
 */

import { DEFAULT_SETTINGS, Settings, loadSettings } from './messages';
import { CLOSE_AUTH, ServerEvent } from './protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const hostEl = $('host') as HTMLInputElement;
const portEl = $('port') as HTMLInputElement;
const tokenEl = $('token') as HTMLInputElement;
const recordingsDirEl = $('recordingsDir') as HTMLInputElement;
const bufferEl = $('bufferBeforePlaying') as HTMLInputElement;
const testBtn = $('test') as HTMLButtonElement;
const testResult = $('testResult') as HTMLSpanElement;
const savedNote = $('saved') as HTMLSpanElement;

async function restore(): Promise<void> {
  const s = await loadSettings();
  hostEl.value = s.host;
  portEl.value = String(s.port);
  tokenEl.value = s.token;
  recordingsDirEl.value = s.recordingsDir;
  bufferEl.checked = s.bufferBeforePlaying;
}

function current(): Pick<Settings, 'host' | 'port' | 'token' | 'recordingsDir' | 'bufferBeforePlaying'> {
  return {
    // The checkbox IS the setting — no `|| default` here. A default would only ever
    // fire for a box that is genuinely unchecked, i.e. it would refuse to let the
    // user turn fast start on.
    bufferBeforePlaying: bufferEl.checked,
    host: hostEl.value.trim() || DEFAULT_SETTINGS.host,
    port: Number(portEl.value) || DEFAULT_SETTINGS.port,
    token: tokenEl.value.trim(),
    // Blank means the default. The path is NOT validated here — this machine's
    // filesystem is not the one it names, so the server is the only thing that
    // can honestly answer whether it exists, and it does so by name at record
    // time rather than guessing now.
    recordingsDir: recordingsDirEl.value.trim() || DEFAULT_SETTINGS.recordingsDir
  };
}

async function save(): Promise<void> {
  await chrome.storage.local.set(current());
  savedNote.textContent = 'Saved';
  setTimeout(() => { savedNote.textContent = ''; }, 1200);
}

for (const el of [hostEl, portEl, tokenEl, recordingsDirEl, bufferEl]) {
  el.addEventListener('change', () => void save());
}

testBtn.addEventListener('click', () => {
  const host = hostEl.value.trim() || DEFAULT_SETTINGS.host;
  const port = Number(portEl.value) || DEFAULT_SETTINGS.port;
  const token = tokenEl.value.trim();
  if (!token) { setResult('Enter the token first.', 'bad'); return; }

  setResult('Connecting…', 'pending');
  let settled = false;
  let socket: WebSocket;
  try {
    socket = new WebSocket(`ws://${host}:${port}`);
  } catch {
    setResult("Can't open a socket — check host/port.", 'bad');
    return;
  }

  const timeout = setTimeout(() => {
    if (settled) return;
    settled = true;
    try { socket.close(); } catch { /* ignore */ }
    setResult('No response — is BookForge running?', 'bad');
  }, 6000);

  socket.onopen = () => socket.send(JSON.stringify({ action: 'hello', token }));
  socket.onmessage = (e) => {
    if (settled) return;
    let msg: ServerEvent;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type !== 'hello') return;
    settled = true;
    clearTimeout(timeout);
    void save();
    const engine = msg.state === 'running' ? 'engine running' : `engine ${msg.state}`;
    setResult(`Connected — ${engine}, ${msg.voices.length} voices.`, 'good');
    socket.close(1000);
  };
  socket.onclose = (e) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    setResult(
      e.code === CLOSE_AUTH
        ? 'Token rejected — re-copy it from tts-api.json.'
        : "Can't reach BookForge — is the app running?",
      'bad'
    );
  };
});

function setResult(text: string, cls: 'good' | 'bad' | 'pending'): void {
  testResult.textContent = text;
  testResult.className = `result ${cls}`;
}

void restore();
