/**
 * Options page — connection settings (host / port / token), voice, auto-advance,
 * and a "Test connection" that authenticates against the server and reports
 * engine state + discovered voices.
 */

import { DEFAULT_SETTINGS, Settings, loadSettings } from './messages';
import { CLOSE_AUTH, ServerEvent } from './protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const hostEl = $('host') as HTMLInputElement;
const portEl = $('port') as HTMLInputElement;
const tokenEl = $('token') as HTMLInputElement;
const voiceEl = $('voice') as HTMLSelectElement;
const testBtn = $('test') as HTMLButtonElement;
const testResult = $('testResult') as HTMLSpanElement;
const savedNote = $('saved') as HTMLSpanElement;

async function restore(): Promise<void> {
  const s = await loadSettings();
  hostEl.value = s.host;
  portEl.value = String(s.port);
  tokenEl.value = s.token;
  setVoiceOptions(s.voice ? [s.voice] : [], s.voice);
}

function setVoiceOptions(voices: string[], selected: string): void {
  const have = new Set(voices);
  if (selected && !have.has(selected)) voices = [selected, ...voices];
  voiceEl.textContent = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'Engine default (keep loaded voice)';
  voiceEl.appendChild(def);
  for (const v of voices) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    voiceEl.appendChild(opt);
  }
  voiceEl.value = selected;
}

function current(): Pick<Settings, 'host' | 'port' | 'token' | 'voice'> {
  return {
    host: hostEl.value.trim() || DEFAULT_SETTINGS.host,
    port: Number(portEl.value) || DEFAULT_SETTINGS.port,
    token: tokenEl.value.trim(),
    voice: voiceEl.value
  };
}

async function save(): Promise<void> {
  // rate is owned by the transport bar; never written here.
  await chrome.storage.local.set(current());
  savedNote.textContent = 'Saved';
  setTimeout(() => { savedNote.textContent = ''; }, 1200);
}

for (const el of [hostEl, portEl, tokenEl, voiceEl]) {
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
    const engine = msg.state === 'running' ? 'engine running' : `engine ${msg.state}`;
    if (msg.voices.length) {
      setVoiceOptions(msg.voices, voiceEl.value);
      void save();
      setResult(`Connected — ${engine}, ${msg.voices.length} voices loaded.`, 'good');
    } else {
      setResult(`Connected — ${engine}. Voices appear once the engine starts.`, 'good');
    }
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
