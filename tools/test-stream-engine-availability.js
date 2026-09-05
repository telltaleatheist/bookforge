#!/usr/bin/env node
/**
 * WHICH STREAMING ENGINES A MACHINE SAYS IT HAS, and whether it can back that up.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-stream-engine-availability.js
 *
 * ── Why this is a keeper ────────────────────────────────────────────────────
 *
 * `getAvailableEngines()` is read by three surfaces that all treat it as a
 * promise: the Settings streaming-engine picker, the TTS API's `hello` and
 * `config` payloads, and (through those) the browser extension. An engine listed
 * `available: true` that cannot start is not a small error — the user picks it,
 * every sentence fails against an environment that is not there, and the page that
 * would repair it is the one that offered the choice.
 *
 * This session has already produced that bug twice by accident: a probe that
 * resolved differently from the launcher, and an orphan door whose accidental
 * guard I removed. So the rule is asserted rather than trusted: AVAILABILITY AND
 * THE SPAWN MUST AGREE.
 *
 * ── It is host-independent, and it has to be ────────────────────────────────
 *
 * The answer differs per platform — that is the entire point of the function — so
 * the keeper drives each PLATFORM as a fixture rather than reporting whatever this
 * machine happens to be. `process.platform` is forced and restored around each
 * case, exactly as `test-higgs-engine.js` does.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'streaming-engine.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => os.tmpdir(), isPackaged: false },
    BrowserWindow: class {},
  },
};

let failures = 0;
function fail(name, err) {
  failures++;
  console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
}

/**
 * A SYNCHRONOUS row. Handing this an `async` body is a mistake it now refuses
 * rather than absorbs: the rejection would arrive after the try/catch had already
 * printed `ok`, so the row would pass no matter what the code under it did. Use
 * `checkAsync` for anything that returns a promise.
 */
function check(name, fn) {
  let out;
  try {
    out = fn();
  } catch (err) {
    fail(name, err);
    return;
  }
  if (out && typeof out.then === 'function') {
    fail(name, new Error('check() is synchronous and this row returned a promise — use checkAsync'));
    return;
  }
  console.log(`  ok    ${name}`);
}

/** Rows whose body returns a promise. Awaited before the exit code is decided. */
const pending = [];
function checkAsync(name, fn) {
  pending.push(Promise.resolve().then(fn).then(
    () => console.log(`  ok    ${name}`),
    (err) => fail(name, err),
  ));
}

const stream = require(path.join(DIST, 'streaming-engine.js'));
const spawnMod = require(path.join(DIST, 'narrator-spawn.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));
const higgsModels = require(path.join(DIST, 'higgs-models.js'));

function stub(mod, name, fn) {
  const d = Object.getOwnPropertyDescriptor(mod, name);
  const prev = mod[name];
  if (d && d.get) Object.defineProperty(mod, name, { value: fn, configurable: true, enumerable: true });
  else mod[name] = fn;
  return () => {
    if (d && d.get) Object.defineProperty(mod, name, d);
    else mod[name] = prev;
  };
}

/** Run `fn` with the machine described by `opts`, then put everything back. */
function onPlatform(opts, fn) {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: opts.platform, configurable: true });
  const undo = [
    stub(toolPaths, 'shouldUseWsl2ForHiggs', () => !!opts.wslHiggs),
    stub(toolPaths, 'shouldUseWsl2ForOrpheus', () => !!opts.wslOrpheus),
    stub(higgsModels, 'listRenderableHiggsModels', () => (opts.higgsVoices ?? ['default']).map((id) => ({ id }))),
  ];
  try {
    return fn();
  } finally {
    undo.reverse().forEach((u) => u());
    Object.defineProperty(process, 'platform', platformDesc);
  }
}

const higgsOn = (platform, extra) =>
  onPlatform({ platform, ...extra }, () => stream.getAvailableEngines().find((e) => e.id === 'higgs'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('both engines are always LISTED — availability is a field, not absence');
// ─────────────────────────────────────────────────────────────────────────────
check('the list names orpheus and higgs, in that order', () => {
  const ids = stream.getAvailableEngines().map((e) => e.id);
  assert.deepStrictEqual(ids, ['orpheus', 'higgs'],
    'a delisted engine cannot be explained to the user; an unavailable one can');
});
check('every row carries a human name, and an unavailable one carries a reason', () => {
  for (const e of stream.getAvailableEngines()) {
    assert.ok(e.name, `${e.id} has no display name`);
    if (!e.available) {
      assert.ok(e.reason && e.reason.length > 20,
        `${e.id} is unavailable with no usable reason: ${JSON.stringify(e.reason)}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('Higgs, per platform');
// ─────────────────────────────────────────────────────────────────────────────
check('win32 + the WSL toggle ON + a voice installed  → available', () => {
  const h = higgsOn('win32', { wslHiggs: true });
  assert.strictEqual(h.available, true, h.reason);
});
check('win32 + the WSL toggle OFF → refused, naming the toggle', () => {
  const h = higgsOn('win32', { wslHiggs: false });
  assert.strictEqual(h.available, false);
  assert.match(h.reason, /WSL2 for Higgs/,
    'the refusal does not say what to turn on');
});
check('no voice installed → refused, whatever the platform', () => {
  for (const platform of ['win32', 'darwin']) {
    const h = higgsOn(platform, { wslHiggs: true, higgsVoices: [] });
    assert.strictEqual(h.available, false, `${platform} offered Higgs with no voice`);
    // A voice whose artifact is missing renders in the model's own speaker, which
    // measures at 12% of the narrator's ECAPA ceiling — a different person.
    assert.match(h.reason, /voice/i);
  }
});
// REWRITTEN 2026-09-05, exactly as the case it replaces demanded. The old case
// asserted `higgsMlxBackendPresent() === false` and that darwin therefore refused
// by name ("v3's only backend is a vLLM-Omni server and there is no macOS build").
// `feat/narrator-higgs-mlx` merged in bbe845b8 and the detector — which reads the
// CONTENT under `engine/higgs/` rather than a hard-coded false — flipped by
// itself, which is what it was built to do. So the Mac no longer refuses over the
// BACKEND. What decides it now is the same thing that decides Orpheus there: the
// `narrator-mlx` environment.
//
// The assertion has to stay host-independent (this keeper runs on Windows, where
// that env is absent, and on a Mac where it may not be), so it pins the QUESTION
// rather than the answer: whatever darwin says about Higgs, it must be about
// narrator-mlx and never again about a missing backend.
check('darwin → decided by narrator-mlx, no longer by a missing MLX backend', () => {
  assert.strictEqual(spawnMod.higgsMlxBackendPresent(), true,
    'the in-process MLX Higgs backend has disappeared from engine/higgs/ — if that '
    + 'is deliberate, this case goes back to asserting darwin refuses by name');
  const h = higgsOn('darwin', {});
  if (h.available) {
    // A Mac with the env: the spawn must be buildable. (The loop below asserts
    // this for both platforms; stated here so the case reads as a whole.)
    assert.doesNotThrow(() => spawnMod.buildNarratorSpawn({
      engine: 'higgs', phase: 'serve', args: [], envExtras: {}, cwdHint: REPO,
    }), 'darwin offers Higgs but the spawn cannot be built');
  } else {
    assert.match(h.reason, /narrator-mlx/,
      'darwin refuses Higgs for something other than the narrator-mlx environment');
    assert.doesNotMatch(h.reason, /vLLM-Omni|no macOS build/,
      'darwin still refuses Higgs for want of a macOS backend — the MLX backend '
      + 'has landed, so that reason is stale and would send a Mac user looking for '
      + 'the wrong thing');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('availability and the spawn agree');
// ─────────────────────────────────────────────────────────────────────────────
//
// THE RULE THIS FILE EXISTS FOR. Twice this session an availability answer and a
// spawn answer disagreed, and both times the symptom was a promise kept until the
// moment it mattered.
for (const [platform, opts] of [['win32', { wslHiggs: true }], ['darwin', {}]]) {
  check(`${platform}: if Higgs says available, buildNarratorSpawn can build it`, () => {
    onPlatform({ platform, ...opts }, () => {
      const h = stream.getAvailableEngines().find((e) => e.id === 'higgs');
      let built = null;
      let refusal = null;
      try {
        built = spawnMod.buildNarratorSpawn({
          engine: 'higgs', phase: 'serve', args: [],
          envExtras: {}, cwdHint: REPO,
        });
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      if (h.available) {
        assert.ok(built, `Higgs is advertised available on ${platform} but the spawn refused: ${refusal}`);
      } else {
        assert.ok(refusal || built,
          'the spawn neither built nor refused — that is not an answer');
      }
    });
  });
}

check('the pool and the selector agree on what an engine id is', () => {
  // `orpheus-worker-pool.ts` declares its own `StreamEngineId` rather than
  // importing `StreamEngineName` (the import would be a cycle). Two spellings of
  // one union is a drift waiting to happen, so they are compared here.
  const poolSrc = fs.readFileSync(path.join(REPO, 'electron', 'orpheus-worker-pool.ts'), 'utf-8');
  const selSrc = fs.readFileSync(path.join(REPO, 'electron', 'streaming-engine.ts'), 'utf-8');
  const pool = poolSrc.match(/export type StreamEngineId = ([^;]+);/);
  const sel = selSrc.match(/export type StreamEngineName = ([^;]+);/);
  assert.ok(pool && sel, 'one of the two unions is gone or renamed');
  const norm = (t) => t.split('|').map((x) => x.trim()).sort().join('|');
  assert.strictEqual(norm(pool[1]), norm(sel[1]),
    `the pool streams ${pool[1]} and the selector offers ${sel[1]}`);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('selection REFUSES rather than falling back');
// ─────────────────────────────────────────────────────────────────────────────
// `setSelectedEngineName` calls `getAvailableEngines` INTERNALLY, so stubbing the
// module's export changes nothing about what it sees. It is lifted here with its
// free variables rebound, the same way the other keepers exercise module-private
// code: what runs below is the shipped body, driven against a machine whose
// availability list is missing an engine.
const streamJs = fs.readFileSync(path.join(DIST, 'streaming-engine.js'), 'utf-8');
const selectSrc = streamJs.match(/async function setSelectedEngineName\(name\) \{[\s\S]*?\n}\n/);
function liftedSelect(availability) {
  assert.ok(selectSrc, 'setSelectedEngineName is not in the compiled selector — did it move?');
  return eval(
    `(function (isEngineName, ENGINES, getSelectedEngineName, getAvailableEngines,
                getActiveEngine, readPersisted, writePersisted, emitStreamConfigChanged) {
       let selected = null;   // the module-level binding the real body assigns to
       ${selectSrc[0]}
       return setSelectedEngineName;
     })`,
  )(
    (v) => v === 'orpheus' || v === 'higgs',
    { orpheus: {}, higgs: {} },
    () => 'orpheus',
    () => availability,
    () => ({ endSession: async () => {} }),
    () => ({}),
    () => {},
    () => {},
  );
}

checkAsync('an engine missing from getAvailableEngines() cannot be selected', () => {
  // `if (info && !info.available)` read "not in the availability list ⇒ allow it",
  // so the one mistake the check exists to catch — an engine added to `ENGINES` and
  // forgotten in `getAvailableEngines()` — was the case it waved through. The two
  // lists are hand-maintained in one file; nothing but this makes them agree.
  return liftedSelect([{ id: 'orpheus', name: 'Orpheus', available: true }])('higgs').then(
    () => { throw new Error('selecting an engine with no availability row was accepted'); },
    (err) => {
      assert.match(err.message, /not in getAvailableEngines/i,
        `refused, but not for the right reason: ${err.message}`);
    },
  );
});

checkAsync('an engine that IS listed and available is still selectable', () => {
  // The refusal above must not be "refuse everything". This is also the row that
  // would have caught `isEngineName` returning `v === 'orpheus'` while every other
  // surface offered Higgs.
  return liftedSelect([
    { id: 'orpheus', name: 'Orpheus', available: true },
    { id: 'higgs', name: 'Higgs', available: true },
  ])('higgs');
});

checkAsync('every listed engine is a NAME the selector knows', () => {
  // The REAL `setSelectedEngineName`, not the lifted one — the lifted copy is given
  // its own `isEngineName` and so is blind to this.
  //
  // `isEngineName` was a hand-written second copy of the engine list, and it went
  // stale the moment Higgs was added: Higgs reached the union, `ENGINES`,
  // `getAvailableEngines()`, the Settings picker and the extension's engine menu,
  // while this one function still read `v === 'orpheus'`. Selecting it failed with
  // "Unknown streaming engine: higgs. This build streams: orpheus, higgs." — a
  // message that contradicts itself in its own second clause.
  //
  // Host-independent: on a machine where an engine is unavailable the refusal names
  // the machine, not the name. Either is fine here; "unknown" is not.
  return Promise.all(stream.getAvailableEngines().map((e) => stream
    .setSelectedEngineName(e.id)
    .then(
      () => {},
      (err) => {
        assert.doesNotMatch(err.message, /Unknown streaming engine/,
          `${e.id} is offered by getAvailableEngines() and rejected by name: ${err.message}`);
      },
    )));
});

check('the pool refuses to name an engine when no probe is registered', () => {
  // `serveEngineProbe` used to default to `() => 'orpheus'`. `streaming-engine.ts`
  // registers it at module load, so the default could only ever be reached when the
  // registration was dropped or reordered — and it answered that by rendering a Higgs
  // session in Orpheus, silently, with the app reporting Higgs throughout.
  const poolMod = require(path.join(DIST, 'orpheus-worker-pool.js'));
  const src = fs.readFileSync(path.join(REPO, 'electron', 'orpheus-worker-pool.ts'), 'utf-8');
  assert.match(src, /let serveEngineProbe: \(\(\) => StreamEngineId\) \| null = null;/,
    'the serve-engine probe has a default again — an unregistered probe must fail, not guess');
  assert.ok(typeof poolMod.setServeEngineProbe === 'function',
    'setServeEngineProbe is gone, so nothing can register the engine the pool spawns for');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('per-engine settings are applied to the engine being switched TO');
// ─────────────────────────────────────────────────────────────────────────────
check('config.set and engine.restart apply the worker count AFTER the switch', () => {
  // `applyClientWorkerCount` reads `getActiveEngine()`. Called before the switch it
  // wrote the user's count onto the pool they were leaving, which the switch then
  // discarded — a silently ignored setting, not a visible failure. Harmless only
  // while ENGINES.orpheus and ENGINES.higgs are the same object, which is exactly
  // the kind of "currently fine" that stops being fine without warning.
  //
  // Asserted on ORDER in the compiled output, because the two handlers are private
  // methods on a server class that needs a live socket to drive.
  const js = fs.readFileSync(path.join(DIST, 'tts-api-server.js'), 'utf-8');
  for (const handler of ['handleConfigSet', 'handleRestart']) {
    const body = js.match(new RegExp(`async ${handler}\\(ws, msg\\) \\{[\\s\\S]*?\\n    \\}\\n`));
    assert.ok(body, `${handler} is not in the compiled server — did it move?`);
    const apply = body[0].indexOf('applyClientWorkerCount');
    const switchAt = body[0].indexOf('setStreamConfig');
    assert.ok(apply !== -1, `${handler} no longer applies the client worker count`);
    assert.ok(switchAt !== -1, `${handler} no longer switches engine`);
    assert.ok(apply > switchAt,
      `${handler} applies the worker count to the OUTGOING engine (at ${apply}, `
      + `before the switch at ${switchAt})`);
  }
});

check('engine.restart captures residency BEFORE the switch, on purpose', () => {
  // The opposite order from the worker count, and deliberately so. "Is a client
  // holding this server resident" is a property of the session, not of whichever
  // pool is loaded. Read after the switch it would ask a pool that has not been
  // started, get false, and drop residency on every engine change.
  const js = fs.readFileSync(path.join(DIST, 'tts-api-server.js'), 'utf-8');
  const body = js.match(/async handleRestart\(ws, msg\) \{[\s\S]*?\n    \}\n/);
  assert.ok(body, 'handleRestart is not in the compiled server — did it move?');
  const was = body[0].indexOf('isServiceMode');
  const switchAt = body[0].indexOf('setStreamConfig');
  assert.ok(was !== -1 && switchAt !== -1, 'handleRestart no longer does both things');
  assert.ok(was < switchAt,
    'residency is now read from the engine being switched INTO, which has not been '
    + 'started — every engine change would silently stop the server being resident');
});

// The async rows settle here, before anything decides the exit code. `process.exit`
// below would otherwise run with them still in flight and report a clean suite.
Promise.all(pending).then(() => {
  console.log(failures === 0 ? '\nAll streaming-engine availability checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
});
