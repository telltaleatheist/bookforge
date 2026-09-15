#!/usr/bin/env node
/**
 * BOOKFORGE HAS NO TTS SERVER — AND THE EXTENSION HAS EVERY OPTION THAT LEFT.
 *
 *   node tools/test-no-tts-server-doors.js
 *
 * Owen, 2026-09-15: *"i think the right way to do this is to connect directly to
 * crucible with the extension, fully. cut bookforge out of the picture. right?
 * that means we need to remove the tts server button from bookforge, and we need
 * to rework the settings \u2026 there shouldnt be tts server logic in bookforge
 * anymore at all, including the settings."*
 *
 * That is step 8 of `docs/EXTENSION-TO-CRUCIBLE-PLAN.md`, and its §0 table is the
 * shape of this file. The plan says the keeper that pins the deletion **lists
 * both columns by name**, so this one has two halves and neither works alone:
 *
 *   FORBIDDEN \u2014 BookForge's speak relay and the surface that drove it. The
 *     WebSocket verbs (`speak`, `playhead`, `cancel`, `config.get/set`,
 *     `engine.start/stop/restart`), the `tts-api-server.ts` module, the
 *     `tts-api:*` IPC pair, the nav-rail "TTS Server" button, and the Settings
 *     section's voice and voice-engine pickers.
 *
 *   REQUIRED \u2014 the rows that CARRIED, still present in the extension. Deleting
 *     BookForge's copy is only correct because the extension has them; a keeper
 *     that forbade without insisting would go green on an extension that had
 *     silently lost the voice picker, and the feature would be gone with nothing
 *     red.
 *
 * ── AND THREE THINGS THIS FILE EXISTS TO STOP BEING SWEPT UP ───────────────
 *
 * A grep for "tts server" would take out more than the relay, so the third half
 * asserts what STAYS:
 *
 *   1. THE TAB RECORDER'S ENDPOINT. Owen split the plan's step 6 on 2026-09-14:
 *      the speak relay goes, this does not. A browser can capture a tab but has
 *      no filesystem and no ffmpeg, and nothing in Crucible owns anybody's
 *      Downloads folder.
 *   2. THE STREAMING TAB, in the main process, on `streamScheduler` \u2014 which is
 *      why deleting the relay did not take the scheduler with it.
 *   3. `src/app/core/listen/` MUST NOT EXIST. Step 4's own words: *"not a
 *      directory that is owed. It is a directory that is not wanted."* Moving
 *      the client into the renderer needs a bearer token there, and
 *      `electron/crucible/servers.ts` refuses to hand one out by design.
 *
 * It reads SOURCE, not a running app: every fact below is something a file
 * states.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(REPO, ...p), 'utf-8');
const exists = (...p) => fs.existsSync(path.join(REPO, ...p));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
  }
}

/**
 * Source with its comments removed.
 *
 * The absence checks are about CODE. This repository's comments carry the
 * history of what was removed and why \u2014 the verbs that left, the button that
 * was deleted, the reason the config file kept its name \u2014 and a check that
 * could not tell a comment from a call would either go red on an accurate note
 * or drive the notes out, which is worse than the drift it guards. (String
 * literals are left alone: a deleted verb spelled in a string is still
 * something the code says.)
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every .ts under a directory, recursively, as one string of CODE. */
function codeUnder(...rel) {
  const root = path.join(REPO, ...rel);
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(full);
      } else if (entry.name.endsWith('.ts')) {
        out.push(code(fs.readFileSync(full, 'utf-8')));
      }
    }
  })(root);
  return out.join('\n');
}

console.log('no TTS server in BookForge (plan step 8)');

const electronCode = codeUnder('electron');
const rendererCode = codeUnder('src', 'app');

// ═══════════════════════════════════════════════════════════════════════════
// FORBIDDEN \u2014 the relay, and the surface that drove it
// ═══════════════════════════════════════════════════════════════════════════

check('THE MODULE: electron/tts-api-server.ts does not exist', () => {
  if (exists('electron', 'tts-api-server.ts')) {
    throw new Error('electron/tts-api-server.ts is back. The speak relay is deleted; what is '
      + 'left of that socket is electron/tab-record-server.ts and it carries record.* only.');
  }
  if (/tts-api-server/.test(electronCode + rendererCode)) {
    throw new Error('something in electron/ or src/app/ imports or names tts-api-server again');
  }
});

check('THE SPEAK VERBS: no handler in the main process answers any of them', () => {
  const server = read('electron', 'tab-record-server.ts');
  const serverCode = code(server);
  for (const method of [
    'handleSpeak', 'handleConfigSet', 'handleRestart',
    'ensureEngine', 'applyClientWorkerCount', 'refreshInstalledVoices',
    'statusPayload', 'configPayload',
  ]) {
    if (new RegExp(`(private |public |async )?${method}\\s*\\(`).test(serverCode)) {
      throw new Error(`tab-record-server.ts has ${method} again \u2014 that is the speak relay `
        + 'growing back inside the recorder\'s server');
    }
  }
  // The recorder's socket must not reach the engine at all. If it imports the
  // scheduler or the engine facade, it is relaying again whatever it is called.
  for (const forbidden of ['stream-scheduler', 'streaming-engine', 'orpheus-worker-pool', 'stream-idle']) {
    if (new RegExp(`from '\\./${forbidden}'`).test(server)) {
      throw new Error(`tab-record-server.ts imports ${forbidden} again. The recorder hands PCM `
        + 'to ffmpeg; it has no business holding a TTS engine.');
    }
  }
});

check('THE SPEAK VERBS ARE ANSWERED BY NAME, not with "unknown action"', () => {
  // NO SILENT REMOVAL. An old extension build still says `speak` here, and a
  // bare "unknown action" would not tell its user that speech moved to their own
  // Crucible. The refusal names where it went.
  const server = read('electron', 'tab-record-server.ts');
  for (const verb of ['speak', 'engine.start', 'config.set']) {
    if (!server.includes(`'${verb}'`)) {
      throw new Error(`the server no longer recognises '${verb}' well enough to refuse it by `
        + 'name. A client that still sends it gets a bare "unknown action" and no idea why.');
    }
  }
  if (!/Crucible/.test(server)) {
    throw new Error('the refusal does not say where speech went');
  }
});

check('THE IPC: tts-api:status / tts-api:configure are gone', () => {
  const main = code(read('electron', 'main.ts'));
  const preload = code(read('electron', 'preload.ts'));
  for (const channel of ['tts-api:status', 'tts-api:configure']) {
    if ((main + preload).includes(channel)) {
      throw new Error(`${channel} is back. The recorder's address rides tab-record:* now; a `
        + 'channel named for TTS on a socket that carries none is a lie a reader believes.');
    }
  }
  if (/electron\.ttsApi\b/.test(rendererCode)) {
    throw new Error('the renderer reaches window.electron.ttsApi again');
  }
  // …and the recorder's own pair must still be there, or the section above it
  // is a form bound to nothing.
  for (const channel of ['tab-record:status', 'tab-record:configure']) {
    if (!main.includes(channel)) throw new Error(`main.ts lost ${channel}`);
  }
});

check('THE BUTTON: the nav rail has no TTS Server button', () => {
  const nav = read('src', 'app', 'components', 'nav-rail', 'nav-rail.component.ts');
  const navCode = code(nav);
  for (const gone of ['toggleTtsServer', 'openTtsSettings', 'ttsServerTitle', 'tts-popover']) {
    if (navCode.includes(gone)) {
      throw new Error(`the nav rail has ${gone} again. The button pinned BookForge's engine as a `
        + 'resident service so an external client always had an endpoint; the extension holds a '
        + 'Crucible\'s card itself and nothing outside this app asks for that pin.');
    }
  }
  if (/TtsServerService/.test(navCode)) {
    throw new Error('the nav rail injects TtsServerService again \u2014 it has no button to drive');
  }
});

check('THE SECTION: Settings has no TTS Server section', () => {
  const settingsSvc = code(read('src', 'app', 'core', 'services', 'settings.service.ts'));
  if (/id: 'tts-api'/.test(settingsSvc)) {
    throw new Error("the 'tts-api' settings section is back");
  }
  if (/name: 'TTS Server'/.test(settingsSvc)) {
    throw new Error('a section named "TTS Server" is back');
  }
  const settings = code(read('src', 'app', 'features', 'settings', 'settings.component.ts'));
  for (const gone of [
    'setStreamEngine', 'setStreamVoice', 'voiceOptions', 'streamEngineBlurb',
    'streamEngineInfo', 'streamEngineError', 'HIGGS_STREAM_GROUP',
    'ttsApiStatus', 'ttsApiConfigure', 'saveTtsServer', 'ttsServerDirty',
  ]) {
    if (settings.includes(gone)) {
      throw new Error(`settings.component.ts has ${gone} again. The voice and the voice engine `
        + "are the extension's (from its selected server's GET /v1/voices), and a BookForge-side "
        + 'picker for a client BookForge no longer serves is a second owner of one fact.');
    }
  }
});

check('THE CLI: --mode streaming and its adapter are gone', () => {
  if (exists('cli', 'orpheus-stream.js')) {
    throw new Error('cli/orpheus-stream.js is back. Its own docblock said it "talks the '
      + 'documented WebSocket protocol \u2026 exactly as the BookForge Reader extension does", and '
      + 'both halves of that are false: there is no protocol and the extension is elsewhere.');
  }
  const cli = read('cli', 'bookforge-tts.py');
  if (/ORPHEUS_STREAM/.test(cli)) throw new Error('the CLI still points at the deleted adapter');
  // NO SILENT REMOVAL here either: a script that still passes --mode streaming
  // is told what happened, not handed an argparse error.
  if (!/--mode streaming/.test(cli)) {
    throw new Error('--mode streaming is not refused BY NAME. Somebody with it in a shell script '
      + 'deserves the reason, not "invalid choice".');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQUIRED \u2014 the carried column, in the extension
// ═══════════════════════════════════════════════════════════════════════════
//
// The plan's condition on this whole step: *"Nothing is removed from BookForge
// until the extension has every row in the left column."* These five are that
// column. `tools/test-extension-option-columns.js` checks each in depth (how
// the list is fetched, what the hint says, which module owns the registry);
// what this file adds is the LINK \u2014 the reason BookForge's copy could go.

check('CARRIED: voice \u2014 the extension picks one, from its server', () => {
  const optionsHtml = read('extension', 'static', 'options.html');
  const popupHtml = read('extension', 'static', 'popup.html');
  if (!/id="voice"/.test(optionsHtml) || !/id="voice"/.test(popupHtml)) {
    throw new Error('the extension lost its voice picker. BookForge deleted ITS voice picker on '
      + 'the strength of this one existing (Owen: "voice is important and must be available on '
      + 'the extension"); with neither, a user cannot choose a narrator at all.');
  }
  const ext = read('extension', 'src', 'options.ts') + read('extension', 'src', 'offscreen.ts');
  if (!/\.voices\(\)/.test(ext)) {
    throw new Error("the list no longer comes from the server's GET /v1/voices");
  }
});

check('CARRIED: speed', () => {
  if (!/id="rate"/.test(read('extension', 'static', 'options.html'))) {
    throw new Error('the extension lost its speed row');
  }
});

check('CARRIED: Buffer before playing \u2014 the client gate', () => {
  const optionsHtml = read('extension', 'static', 'options.html');
  const popupHtml = read('extension', 'static', 'popup.html');
  if (!/id="bufferBeforePlaying"/.test(optionsHtml) || !/id="bufferBeforePlaying"/.test(popupHtml)) {
    throw new Error('the extension lost "Buffer before playing"');
  }
});

check('CARRIED: the idle-unload window', () => {
  if (!/id="idleMinutes"/.test(read('extension', 'static', 'options.html'))) {
    throw new Error('the extension lost the idle-unload window');
  }
  if (!/function idleUnload/.test(read('extension', 'src', 'offscreen.ts'))) {
    throw new Error('the idle timer is gone \u2014 the window is a number nobody acts on, and a voice '
      + 'on a card is a card nobody else can use');
  }
});

check('CARRIED: the server picker \u2014 registry, connect code, ONE selection', () => {
  const optionsHtml = read('extension', 'static', 'options.html');
  if (!/id="servers"/.test(optionsHtml) || !/id="pairing"/.test(optionsHtml)) {
    throw new Error('the extension lost the server registry or the place to paste a connect code. '
      + 'That pair REPLACED BookForge\'s LAN host/port/token rows for speech; without it the '
      + 'extension cannot reach any server at all.');
  }
  const servers = read('extension', 'src', 'servers.ts');
  if (!/parsePairing/.test(servers)) {
    throw new Error("the registry no longer uses the SDK's parsePairing");
  }
  // SIMPLE IS NOT LOOSE (Owen: "i dont think we need to overcomplicate the token
  // logic"). A pasted connect code IS the token-passing mechanism; nothing may
  // invent a second one, and no token may be printed.
  const extCode = codeUnderExtension();
  if (/console\.(log|info|warn|error)\([^)]*\btoken\b/.test(extCode)) {
    throw new Error('something logs a token. Simple means one mechanism, not a visible secret.');
  }
});

function codeUnderExtension() {
  const dir = path.join(REPO, 'extension', 'src');
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => code(fs.readFileSync(path.join(dir, f), 'utf-8')))
    .join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// KEPT \u2014 the three things a tidy-up would take by accident
// ═══════════════════════════════════════════════════════════════════════════

check('KEPT: the tab recorder\u2019s endpoint, and the rows that reach it', () => {
  if (!exists('electron', 'tab-record-server.ts')) {
    throw new Error('electron/tab-record-server.ts is gone. Owen SPLIT step 6 on 2026-09-14 so '
      + 'this endpoint would outlive the speak relay: a browser has no filesystem and no ffmpeg, '
      + 'and nothing in Crucible owns anybody\'s Downloads folder.');
  }
  const server = read('electron', 'tab-record-server.ts');
  for (const verb of ['record.start', 'record.stop', 'record.cancel', 'record.mark']) {
    if (!server.includes(`'${verb}'`)) throw new Error(`the server lost ${verb}`);
  }
  const optionsHtml = read('extension', 'static', 'options.html');
  for (const id of ['host', 'port', 'token', 'recordingsDir']) {
    if (!new RegExp(`id="${id}"`).test(optionsHtml)) {
      throw new Error(`Options lost the recorder's ${id} row. The plan calls host/port/token `
        + '"replaced by the server picker", and they are \u2014 FOR SPEECH. These reach the recorder, '
        + 'and they are permanent, not a remnant.');
    }
  }
  if (!/id="recStart"/.test(read('extension', 'static', 'popup.html'))) {
    throw new Error('the popup lost Record this tab');
  }
});

check('KEPT: the Streaming tab, in the main process, on the scheduler', () => {
  if (!exists('electron', 'stream-scheduler.ts')) {
    throw new Error('stream-scheduler.ts is gone. It did NOT exist only to serve the 8766 relay '
      + '\u2014 the Streaming tab and the phone\u2019s reader bridge both drive it \u2014 which is exactly why '
      + 'the relay could be deleted without it.');
  }
  const tab = read('src', 'app', 'features', 'live-tts', 'live-tts.component.ts');
  for (const verb of ['streamStart', 'streamStop', 'onStreamEvent']) {
    if (!tab.includes(verb)) {
      throw new Error(`the Streaming tab no longer calls ${verb}. It reaches main by IPC, never `
        + 'by WebSocket, and that is what made it safe to delete the socket.');
    }
  }
  const main = code(read('electron', 'main.ts'));
  for (const channel of ['stream:start', 'stream:stop', 'stream:playhead']) {
    if (!main.includes(channel)) throw new Error(`main.ts lost ${channel}`);
  }
  if (!/streamScheduler/.test(code(read('electron', 'reader-stream-bridge.ts')))) {
    throw new Error('the phone\u2019s reader bridge no longer drives the scheduler in-process');
  }
});

check('KEPT OUT: src/app/core/listen/ is not created', () => {
  if (exists('src', 'app', 'core', 'listen')) {
    throw new Error('src/app/core/listen/ exists. The plan (step 4): "not a directory that is '
      + 'owed. It is a directory that is not wanted." Moving the Crucible client into the '
      + 'RENDERER needs a bearer token there, and electron/crucible/servers.ts refuses to hand '
      + 'one out by design (every listing carries tokenMasked). The alternative \u2014 an IPC byte '
      + 'pipe for the session\u2019s five verbs \u2014 is a relay, and this phase exists to delete one.');
  }
});

console.log(failures === 0 ? '\nBookForge has no TTS server, and the extension has every row.'
  : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
