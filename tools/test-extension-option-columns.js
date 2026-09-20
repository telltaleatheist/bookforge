#!/usr/bin/env node
/**
 * THE TWO COLUMNS, BY NAME — what the extension carried, and what was dropped.
 *
 *   node tools/test-extension-option-columns.js
 *
 * ── Why a keeper for a table in a plan ──────────────────────────────────────
 *
 * docs/EXTENSION-TO-CRUCIBLE-PLAN.md §0 records Owen's ruling of 2026-09-14:
 * *"we should remove the tts server button and its options from bookforge. we
 * need to make sure those options are added to the extension though"* — then,
 * narrowing it: *"every IMPORTANT option. some of these options are
 * unimportant and dont need to carry over"*. The plan's table is the answer,
 * in two columns, and the sentence under it is the condition on step 8:
 * **nothing is removed from BookForge until the extension has every row in the
 * left column.**
 *
 * A promise in a markdown table is not a guard. This is: the carried column has
 * to be PRESENT in the extension's own surfaces, and the dropped column has to
 * be ABSENT from them — which is the half that rots, because a dropped control
 * comes back one helpful commit at a time.
 *
 * It reads SOURCE, not a running browser. A control in an HTML page, an id its
 * TypeScript binds, and a wire field nobody sends are all things a file states.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const EXT = path.join(REPO, 'extension');
const read = (...p) => fs.readFileSync(path.join(EXT, ...p), 'utf-8');

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

console.log('extension option columns (plan §0)');

const optionsHtml = read('static', 'options.html');
const popupHtml = read('static', 'popup.html');
const optionsTs = read('src', 'options.ts');
const popupTs = read('src', 'popup.ts');
const offscreenTs = read('src', 'offscreen.ts');
const messagesTs = read('src', 'messages.ts');
const protocolTs = read('src', 'protocol.ts');
const serversTs = read('src', 'servers.ts');
const allSrc = fs.readdirSync(path.join(EXT, 'src'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => read('src', f))
  .join('\n');

/**
 * Source with its comments removed.
 *
 * The absence checks below are about CODE. This repository's comments are full
 * of the history of what was removed and why — measured Orpheus throughput
 * numbers, the name of the field that used to carry the worker count — and a
 * check that could not tell a comment from a call would either go red on an
 * accurate note or force the notes out, which is worse than the drift it
 * guards. (Strings are left alone: a dropped wire field spelled in a string
 * literal is still something the extension says.)
 */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const allCode = code(allSrc);
const protocolCode = code(protocolTs);
const popupCode = code(popupTs);

// ═══════════════════════════════════════════════════════════════════════════
// CARRIED — every row of the plan's left column, present
// ═══════════════════════════════════════════════════════════════════════════

check('VOICE — a picker, fed by the SERVER\'s /v1/voices', () => {
  if (!/id="voice"/.test(popupHtml)) throw new Error('the popup has no voice picker');
  if (!/id="voice"/.test(optionsHtml)) throw new Error('the Options page has no voice picker');
  if (!/\.voices\(\)/.test(optionsTs + offscreenTs)) {
    throw new Error('nothing calls GET /v1/voices — the list is coming from somewhere else');
  }
});

check('VOICE — the engine is a COLUMN, shown only when the list spans more than one', () => {
  // plan §4a: a voice implies its engine, so a client shows the engine beside
  // the voice and never as a thing to pick.
  for (const [where, src] of [['popup.ts', popupTs], ['options.ts', optionsTs]]) {
    if (!/engines\.size > 1/.test(src)) {
      throw new Error(`${where} no longer draws the engine column conditionally on the list `
        + 'carrying more than one engine');
    }
  }
});

check('SPEED — a playback-rate row, and it is honest about what it is', () => {
  if (!/id="rate"/.test(optionsHtml)) throw new Error('the Options page has no speed row');
  if (!/rate: Number\(rateEl\.value\)/.test(optionsTs)) {
    throw new Error('the speed row is not bound to the stored rate');
  }
  // It is a PLAYBACK rate. Nothing in Crucible's streaming wire carries a
  // speaking rate (StreamOptions is {voice, language}; say is {id, text, take}),
  // so a row that claimed to slow the VOICE down would be a lie.
  if (!/not a request to the\s*\n?\s*server|speaking rate/i.test(optionsHtml)) {
    throw new Error('the speed row no longer says that it is playback, not a request to the server');
  }
});

check('BUFFER BEFORE PLAYING — the client gate, in both surfaces', () => {
  if (!/id="bufferBeforePlaying"/.test(optionsHtml)) throw new Error('missing from Options');
  if (!/id="bufferBeforePlaying"/.test(popupHtml)) throw new Error('missing from the popup');
  if (!/bufferBeforePlaying: boolean/.test(messagesTs)) throw new Error('not a stored setting');
  // And it is a CLIENT gate now: Crucible's door always emits sub-sentence
  // frames, so there is nothing to ask the server for.
  if (/fastStart:\s*true/.test(allCode)) {
    throw new Error('something still sends fastStart on a wire. Crucible\'s streaming door is '
      + 'always sub-sentence; the switch is a client gate (plan §0).');
  }
});

check('IDLE-UNLOAD WINDOW — a client timer that posts unload-voice', () => {
  if (!/id="idle"/.test(popupHtml)) throw new Error('the popup has no idle row');
  if (!/id="idleMinutes"/.test(optionsHtml)) throw new Error('the Options page has no idle row');
  if (!/idleMinutes: number/.test(messagesTs)) throw new Error('not a stored setting');
  if (!/function idleUnload/.test(offscreenTs)) {
    throw new Error('the offscreen document has no idle timer — the window is a number nobody acts on');
  }
  if (!/unloadVoiceJob|unloadVoice\(/.test(offscreenTs)) {
    throw new Error('the idle timer does not reach an unload-voice job');
  }
});

check('THE SERVER PICKER — a registry fed by pasted connect codes', () => {
  if (!/id="servers"/.test(optionsHtml)) throw new Error('the Options page has no registry list');
  if (!/id="pairing"/.test(optionsHtml)) throw new Error('there is nowhere to paste a connect code');
  if (!/parsePairing/.test(serversTs)) {
    throw new Error('the registry does not use the SDK\'s parsePairing — a hand-rolled reader of a '
      + 'line carrying a percent-encoded name and a secret is exactly what the SDK exists to stop');
  }
  for (const verb of ['addFromPairing', 'removeServer', 'selectServer', 'selectedServer']) {
    if (!new RegExp(`export (async )?function ${verb}`).test(serversTs)) {
      throw new Error(`the registry has no ${verb} — Add / Remove / Select / read-the-selection `
        + 'are the four things the plan names');
    }
  }
  if (!/id="add"/.test(optionsHtml)) throw new Error('no Add button');
  if (!/textContent = 'Test'/.test(optionsTs)) throw new Error('no Test button');
  if (!/textContent = 'Remove'/.test(optionsTs)) throw new Error('no Remove button');
  if (!/\.ping\(\)/.test(read('src', 'crucible.ts')) || !/\.info\(\)/.test(read('src', 'crucible.ts'))) {
    throw new Error('Test is not /v1/ping + /v1/info');
  }
});

check('LOAD / UNLOAD — the popup\'s one button, driven by the job\'s events', () => {
  if (!/Load voice/.test(popupHtml)) throw new Error('the popup button is not Load voice');
  if (!/cmd: 'engine', op, voice/.test(popupTs)) {
    throw new Error('the button does not send the load/unload command with the picked voice');
  }
  const crucibleTs = read('src', 'crucible.ts');
  if (!/client\.loadVoice\(/.test(crucibleTs) || !/client\.unloadVoice\(/.test(crucibleTs)) {
    throw new Error('load/unload do not go through the SDK\'s voice jobs');
  }
  if (!/client\.events\(jobId\)/.test(crucibleTs)) {
    throw new Error('the job\'s events do not drive anything — the button would be guessing');
  }
});

check('ENGINE_IN_USE names the holder, and nothing takes the card', () => {
  const crucibleTs = read('src', 'crucible.ts');
  if (!/describeHolder/.test(crucibleTs)) throw new Error('nothing reads /v1/activity for the holder');
  if (!/activity\.streaming/.test(crucibleTs)) throw new Error('the holder line ignores the open session');
  // PREEMPT IS NEVER SILENT (plan §1). There must be no client-side take-over.
  if (/cancelOtherSession|forceTakeover|stealSession/.test(allCode)) {
    throw new Error('something in the extension takes another client\'s session');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DROPPED — every row of the plan's right column, absent
// ═══════════════════════════════════════════════════════════════════════════

check('DROPPED: the voice-engine selector', () => {
  if (/id="engine"\s*>\s*<\/select>|<select id="engine"/.test(popupHtml)) {
    throw new Error('the popup has an engine <select> again. A voice implies its engine (§4a); '
      + 'the engine is a column of the voice list and never a control of its own.');
  }
  if (/engineEl\s*=/.test(popupCode)) throw new Error('popup.ts still binds an engine selector');
});

check('DROPPED: generation device', () => {
  // The backend is REPORTED (cuda-linux / mlx-darwin) and never chosen: "always
  // chosen by the crucible server".
  if (/devicePref|id="device"/.test(allCode + popupHtml + optionsHtml)) {
    throw new Error('a generation-device control is back. The backend is the server\'s.');
  }
});

check('DROPPED: the CPU worker count', () => {
  if (/cpuWorkers/.test(allCode)) throw new Error('cpuWorkers is back in the extension source');
  if (/id="workers"/.test(popupHtml)) throw new Error('the popup has a worker-count input again');
  if (/deviceWorkers|minWorkers|maxWorkers/.test(allCode)) {
    throw new Error('the server-topology fields are back. They were XTTS\'s, and XTTS is removed.');
  }
});

check('DROPPED: engine start / stop / restart', () => {
  for (const verb of ['engine.start', 'engine.stop', 'engine.restart']) {
    if (allCode.includes(`'${verb}'`)) {
      throw new Error(`the extension still speaks ${verb}. Those rows ARE the popup's `
        + 'Load / Unload now.');
    }
  }
  if (/restart-engine|RestartEngineCmd/.test(allCode)) {
    throw new Error('the restart-engine command is back — there is no process here to restart');
  }
  if (/Restart to apply/.test(popupHtml)) throw new Error('the popup has a Restart button again');
});

check('DROPPED: the speech half of the 8766 protocol', () => {
  for (const gone of ['speak', 'playhead', 'config.get', 'config.set', 'ServerConfig', 'EngineInfo']) {
    if (new RegExp(`'${gone}'|\\b${gone}\\b`).test(protocolCode)) {
      throw new Error(`protocol.ts still declares ${gone}. Speech left that wire in Phase 16; `
        + 'vocabulary nothing speaks is vocabulary that drifts.');
    }
  }
  // What is LEFT of that wire is the tab recorder's, and that is deliberate.
  if (!/record\.start/.test(protocolTs)) {
    throw new Error('protocol.ts lost the recorder verbs too — the recorder still needs a machine '
      + 'with a filesystem, and nothing has replaced that yet (plan step 6)');
  }
});

check('DROPPED: every Orpheus voice, and the fastStart Orpheus arm', () => {
  for (const voice of ['leah', 'tara', 'zac', 'zoe', 'jess', 'mia', 'julia', 'leo']) {
    if (new RegExp(`['"\`]${voice}['"\`]`).test(allCode)) {
      throw new Error(`the Orpheus built-in voice "${voice}" is baked into the extension again. `
        + 'The voice list is the selected server\'s.');
    }
  }
  if (/orpheus/i.test(allCode)) {
    throw new Error('the extension names Orpheus again. It is deprecated and not built into '
      + 'Crucible (ruling 2026-09-14).');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AND THE ROWS THAT ARE THE EXTENSION'S OWN, which stay as they are
// ═══════════════════════════════════════════════════════════════════════════

check('KEPT: the tab-recording rows are untouched', () => {
  for (const id of ['recStart', 'recStop', 'recDiscard', 'recSpeed']) {
    if (!new RegExp(`id="${id}"`).test(popupHtml)) throw new Error(`the popup lost ${id}`);
  }
  if (!/id="recordingsDir"/.test(optionsHtml)) throw new Error('Options lost the recordings folder');
  if (!/id="host"/.test(optionsHtml) || !/id="port"/.test(optionsHtml) || !/id="token"/.test(optionsHtml)) {
    throw new Error(
      'Options lost BookForge\'s host/port/token. The plan calls them "replaced by the server '
      + 'picker", and they are — FOR SPEECH. The tab recorder still hands raw PCM to a machine '
      + 'with a filesystem, and Owen split step 6 on 2026-09-14 so that endpoint outlives the '
      + 'speak relay: these rows are permanent, not a remnant.');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// AND §2's RULING, WHICH THE SAME DOCUMENT STATED TWICE AND DIFFERENTLY
// ═══════════════════════════════════════════════════════════════════════════
//
// This file already keeps one of the plan's rulings honest (§0's two columns),
// and §2 carries another: Correct Sentences spreads its candidates across the
// take ladder. It said so in two incompatible ways at once — "with a two-rung
// ladder and N = 3 that is takes 1, 0, 1", and, four lines later, that a take
// past the ladder's length is refused by name. A rung repeated is not a
// second reading: narrator seeds per chunk (`_seed_for` returns `seed + index`,
// `HiggsConfig.seed` defaults to 1234), so the same rung renders the same bytes
// and the third candidate of that cycle is a copy of the first — which is the
// defect Correct Sentences exists to avoid, written into the plan for it.
//
// A plan that states a rule twice is a plan that will be implemented twice.

const planPath = path.join(REPO, 'docs', 'EXTENSION-TO-CRUCIBLE-PLAN.md');
const plan = fs.readFileSync(planPath, 'utf-8');

check('§2 does not cycle the take ladder', () => {
  if (/takes 1, 0, 1/.test(plan)) {
    throw new Error(
      'the plan still says a two-rung ladder answers N = 3 with "takes 1, 0, 1". Rung 1 twice is '
      + 'the same seed and the same bytes, so that audition list offers two copies of one reading. '
      + 'A candidate gets a rung of its own or the request is refused by name.');
  }
});

check('§2 does not rest on the unseeded premise', () => {
  if (/sampling is unseeded/.test(plan)) {
    throw new Error(
      'the plan still explains differing takes by narrator\'s sampling being unseeded. It is '
      + 'seeded — python/narrator/engine/higgs/engine.py `_seed_for` returns `seed + index` off a '
      + 'default of 1234 — and narrator\'s own CONTRACTS.md says two take-0 re-rolls always were '
      + 'byte-identical. That premise is what made the cycle look harmless.');
  }
});

check('§2 states the ladder rule: a rung per candidate, refused by name past it', () => {
  if (!/candidate k \(0-based\) is asked at `take: k \+ 1`/.test(plan)) {
    throw new Error('§2 no longer states which rung a candidate is asked at');
  }
  // The refusal is BookForge's own since 2026-09-19: crucible retired
  // `unknown_take` and renders a rung above the ladder at the voice's own
  // sampling, so the plan must name the door that still says no.
  if (!/crucible_reroll_ladder_too_short/.test(plan)) {
    throw new Error('§2 no longer names the refusal for a take past the ladder\'s length');
  }
});

console.log(failures === 0 ? '\nBoth columns hold.' : `\n${failures} check(s) FAILED.`);
process.exitCode = failures === 0 ? 0 : 1;
