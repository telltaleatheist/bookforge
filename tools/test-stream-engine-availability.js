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
 * guard I removed. So the rule is asserted rather than trusted.
 *
 * ── What that rule became, 2026-09-15 ──────────────────────────────────────
 *
 * It used to be AVAILABILITY AND THE LOCAL SPAWN MUST AGREE, driven per platform
 * because the answer differed per platform. The local narrator spawn is DELETED
 * (docs/LEGACY-REMOVAL.md): Listen is a Crucible streaming session, so "can this
 * machine start vLLM-Omni" is not this app's question any more — the server's own
 * capability and its `409` answer it, in its own words, when a session is opened.
 * Re-asking here would be a second opinion about somebody else's card, and it
 * would refuse a perfectly good Mac render because THIS box has no WSL.
 *
 * So the rule is now the narrower, true one: **availability claims exactly one
 * thing, and it is a fact about this machine's own catalog** — whether a Higgs
 * voice is installed. The keeper pins that it makes no platform, WSL or
 * environment claim at all, because a claim about a machine that is not doing the
 * work is the same broken promise in a new costume.
 *
 * ── And Orpheus is RETIRED, not dropped ────────────────────────────────────
 *
 * `tts-engine.json` outlives the code that wrote it, so a saved `"orpheus"` must
 * still PARSE, must still have a name to show, and must migrate rather than
 * throw — while being impossible to choose. Same treatment narration gave it in
 * `shared/tts/engine-caps.ts`.
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
const higgsModels = require(path.join(DIST, 'higgs-models.js'));
const streamJs = fs.readFileSync(path.join(DIST, 'streaming-engine.js'), 'utf-8');
const streamTs = fs.readFileSync(path.join(REPO, 'electron', 'streaming-engine.ts'), 'utf-8');

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

/**
 * Run `fn` with the machine described by `opts`, then put everything back.
 *
 * The WSL toggles used to be stubbed here too. They are not read any more — the
 * engine runs on a Crucible server — and stubbing a function nobody calls is a
 * fixture that quietly stops testing anything, so they are gone rather than
 * carried.
 */
function onPlatform(opts, fn) {
  const platformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: opts.platform, configurable: true });
  const undo = [
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
console.log('ONE engine is listed — availability is a field, not absence');
// ─────────────────────────────────────────────────────────────────────────────
check('the list names higgs, and only higgs', () => {
  const ids = stream.getAvailableEngines().map((e) => e.id);
  assert.deepStrictEqual(ids, ['higgs'],
    'a row for an engine nothing can run is a promise the build cannot keep — a '
    + 'retired engine is nameable through streamEngineLabel instead');
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
console.log('Higgs availability claims ONE thing: a voice is installed');
// ─────────────────────────────────────────────────────────────────────────────
check('no voice installed → refused, whatever the platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const h = higgsOn(platform, { higgsVoices: [] });
    assert.strictEqual(h.available, false, `${platform} offered Higgs with no voice`);
    // A voice whose artifact is missing renders in the model's own speaker, which
    // measures at 12% of the narrator's ECAPA ceiling — a different person.
    assert.match(h.reason, /voice/i);
  }
});

check('a voice installed → available, on EVERY platform', () => {
  // The platform rows this replaces refused Higgs on a Mac for want of a local
  // vLLM-Omni build, and on Windows for want of the "WSL2 for Higgs" toggle. Both
  // were questions about the LOCAL spawn, which is deleted: the engine runs on a
  // Crucible server, which may be the Mac, the PC, or a box neither of them has
  // met. Refusing here on THIS machine's platform would refuse a render that was
  // never going to happen here.
  for (const platform of ['win32', 'darwin', 'linux']) {
    const h = higgsOn(platform, {});
    assert.strictEqual(h.available, true, `${platform}: ${h.reason}`);
  }
});

check('availability makes no platform, WSL or environment claim at all', () => {
  // A source read, deliberately: the rows above prove the ANSWER is the same on
  // three platforms, but that is also what a function with a stale claim and a
  // lucky fixture looks like. This pins the absence of the question.
  const body = streamTs.match(/function higgsAvailability\(\): EngineInfo \{[\s\S]*?\n\}\n/);
  assert.ok(body, 'higgsAvailability is gone or renamed');
  for (const claim of [
    'shouldUseWsl2ForHiggs', 'shouldUseWsl2ForOrpheus',
    'narratorNativePython', 'higgsMlxBackendPresent', 'process.platform',
  ]) {
    assert.ok(!body[0].includes(claim),
      `higgsAvailability asks about ${claim} again — that is the local spawn's `
      + 'question, and the local spawn is deleted. The server answers for itself.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('Orpheus is RETIRED — nameable, never selectable');
// ─────────────────────────────────────────────────────────────────────────────
check('a retired id still has something true to show', () => {
  assert.strictEqual(stream.streamEngineLabel('orpheus'), 'Orpheus (retired)');
  assert.strictEqual(stream.streamEngineLabel('xtts'), 'XTTS (retired)');
  assert.strictEqual(stream.streamEngineLabel('higgs'), 'Higgs');
});

check('each retired id carries a DATE and a reason, not just a label', () => {
  // `RETIRED_STREAM_ENGINES` is module-private (nothing outside needs the record;
  // `streamEngineLabel` is the door), so the record itself is read from source.
  const map = streamTs.match(/const RETIRED_STREAM_ENGINES = new Map[\s\S]*?\n\]\);/);
  assert.ok(map, 'the retirement record is gone or renamed');
  for (const id of ['orpheus', 'xtts']) {
    assert.ok(map[0].includes(`['${id}', {`), `${id} is no longer nameable at all`);
  }
  assert.match(map[0], /since: '2026-09-15'/, 'Orpheus has no retirement date');
  assert.match(map[0], /docs\/LEGACY-REMOVAL\.md/,
    'the Orpheus retirement does not say where the engine went');
});

checkAsync('selecting a retired engine is refused BY NAME, never quietly honoured', () => stream
  .setSelectedEngineName('orpheus')
  .then(
    () => { throw new Error('a retired engine was accepted as a selection'); },
    (err) => {
      assert.match(err.message, /retired/i, `refused, but not as retired: ${err.message}`);
      assert.match(err.message, /This build streams: higgs/,
        'the refusal does not say what this build does stream');
    },
  ));

check('a saved "orpheus" MIGRATES to higgs rather than throwing', () => {
  /*
   * A machine that listened on Orpheus last week has `"engine": "orpheus"` on
   * disk. Throwing would leave Listen broken forever on exactly that machine —
   * including from the Settings page that would repair it — so the saved value is
   * migrated, loudly, and the file rewritten so the stale preference stops being
   * re-read. An id nobody in this build ever wrote is still refused by name.
   *
   * The shipped body is lifted with its free variables rebound, the same way
   * `setSelectedEngineName` is below: `selected` is a module-level cache, so
   * calling the real one would answer from whatever an earlier row left there.
   */
  const src = streamJs.match(/function getSelectedEngineName\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(src, 'getSelectedEngineName is not in the compiled selector — did it move?');
  const lift = (persisted) => {
    const wrote = [];
    const fn = eval(
      `(function (isEngineName, RETIRED_STREAM_ENGINES, STREAM_ENGINE_NAMES,
                  readPersisted, writePersisted) {
         let selected = null;
         ${src[0]}
         return getSelectedEngineName;
       })`,
    )(
      (v) => v === 'higgs',
      new Map([['orpheus', { label: 'Orpheus', since: '2026-09-15', reason: 'gone.' }]]),
      ['higgs'],
      () => persisted,
      (cfg) => wrote.push(cfg),
    );
    return { fn, wrote };
  };

  const orpheus = lift({ engine: 'orpheus', voices: { orpheus: 'deathstalker' } });
  assert.strictEqual(orpheus.fn(), 'higgs', 'a saved orpheus did not migrate');
  assert.deepStrictEqual(orpheus.wrote.map((c) => c.engine), ['higgs'],
    'the stale preference was left on disk to be re-read every launch');
  assert.deepStrictEqual(orpheus.wrote[0].voices, { orpheus: 'deathstalker' },
    'the migration threw away the rest of the record');

  assert.strictEqual(lift({}).fn(), 'higgs', 'a fresh install does not land on higgs');
  assert.throws(() => lift({ engine: 'wurlitzer' }).fn(), /never had/,
    'an id this build never wrote is a bug or a hand-edited file, and must not be '
    + 'quietly read as higgs');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('nothing here promises a LOCAL spawn any more');
// ─────────────────────────────────────────────────────────────────────────────
//
// THE RULE THIS FILE WAS BUILT FOR, and what became of it. Twice in one session an
// availability answer and a `buildNarratorSpawn` answer disagreed, and both times
// the symptom was a promise kept until the moment it mattered. Those rows drove
// `buildNarratorSpawn` per platform and asserted the two agreed.
//
// They are gone because the promise is gone: `getActiveEngine()` is a Crucible
// streaming session and never `buildNarratorSpawn`, so availability no longer makes
// a claim a local spawn could contradict. Asserting agreement with a launcher
// nothing calls would be a green row about a path with no users — the most
// expensive kind of keeper, because it reads like coverage.
//
// What replaces it is the pair above: availability asks ONE thing (a voice is
// installed) and is pinned to ask nothing else, and the selector is pinned never to
// offer an id the pool cannot name. The agreement that matters now is between this
// app and the SERVER, and it is pinned where the server can be faked —
// `tools/test-crucible-stream.js`.
check('the Listen facade reaches no local pool at all', () => {
  const venue = streamTs.match(/const VENUE_ROUTED[\s\S]*?\}\);/);
  assert.ok(venue, 'the venue-routed facade is gone or renamed');
  assert.ok(!/\blocal:/.test(venue[0]),
    'the facade has a local backend again — Listen is a Crucible session, and a '
    + 'second backend here is the legacy switch growing back');
  assert.ok(!/legacySwitchIsOn/.test(streamTs),
    'the legacy local-render switch is being read again');
});

check('every id the selector can choose is runnable, and the rest are retired', () => {
  /*
   * REPOINTED 2026-09-15. This compared the selector's union against the local
   * POOL's `StreamEngineId`; the pool is deleted (docs/LEGACY-REMOVAL.md), so
   * there is no second union in that direction any more.
   *
   * There is still a second union, and it is a better one to compare against:
   * `shared/tts/engine-caps.ts`'s engine table, which NARRATION reads. Two
   * surfaces in one app name engines, they retired Orpheus a day apart
   * (narration 2026-09-14, Listen 2026-09-15), and nothing compared them — which
   * is exactly the window in which a selector can offer an engine the rest of the
   * app has stopped being able to render.
   *
   * Two things are bugs and both are asserted: a SELECTABLE stream id the engine
   * table does not call runnable (nothing could serve it), and an id the stream
   * selector RETIRES that the table still calls runnable (the two surfaces
   * disagree about whether a voice can be produced at all).
   */
  const sel = streamTs.match(/export type StreamEngineName = ([^;]+);/);
  assert.ok(sel, 'the selector union is gone or renamed');
  const selIds = sel[1].split('|').map((x) => x.trim().replace(/'/g, ''));
  const caps = require(path.join(REPO, 'dist', 'shared', 'tts', 'engine-caps.js'));

  for (const id of selIds) {
    const row = caps.TTS_ENGINES[id];
    assert.ok(row, `the Listen selector offers "${id}" and the engine table has no such engine`);
    assert.strictEqual(row.retired, null,
      `the Listen selector offers "${id}" and the engine table calls it retired — `
      + 'nothing could serve it');
  }

  for (const [id, row] of Object.entries(caps.TTS_ENGINES)) {
    if (selIds.includes(id)) continue;
    if (row.retired !== null) continue;
    assert.fail(
      `the engine table calls "${id}" runnable and the Listen selector neither offers nor `
      + 'retires it — the two surfaces disagree about what this build can produce');
  }
});

/*
 * A THIRD CHECK STOOD HERE AND ITS SUBJECT IS DELETED (2026-09-15).
 *
 * "the pool refuses to name an engine when no probe is registered" pinned that
 * `serveEngineProbe` had NO default. It had defaulted to `() => 'orpheus'`, and
 * because `streaming-engine.ts` registered it at module load, that default could
 * only ever be reached when the registration was dropped or reordered — where it
 * answered by rendering a Higgs session in Orpheus, silently, with the app
 * reporting Higgs throughout.
 *
 * The pool is deleted (docs/LEGACY-REMOVAL.md) and nothing registers a probe any
 * more. The LESSON is the durable part and is why this note replaces the check
 * rather than the check simply vanishing: A DEFAULT THAT CAN ONLY BE REACHED BY A
 * BUG SHOULD BE A REFUSAL, because reaching it means the thing that was supposed
 * to answer never ran, and guessing there turns a wiring mistake into wrong audio
 * nobody can see.
 */

/*
 * TWO CHECKS STOOD HERE AND THEIR SUBJECT IS DELETED (Phase 16 step 8,
 * 2026-09-15). Both pinned an ORDER inside `tts-api-server.js`:
 * `handleConfigSet` and `handleRestart` had to apply the client's worker count
 * AFTER the engine switch (before it, the count landed on the pool the user was
 * leaving and the switch discarded it), and `handleRestart` had to read
 * residency BEFORE the switch (after it, it asked a pool that had not started,
 * got false, and silently dropped residency on every engine change).
 *
 * `config.set` and `engine.restart` are gone: they were the 8766 relay's verbs,
 * an external client's way to drive BookForge's engine, and the only external
 * client on that socket is now a Crucible client that drives a Crucible. The
 * worker count went with them (XTTS-only; XTTS is removed), and so did the
 * server class those two private methods lived on. There is no order left to
 * get wrong, so these are deleted rather than repointed at something that only
 * looks similar.
 */

// The async rows settle here, before anything decides the exit code. `process.exit`
// below would otherwise run with them still in flight and report a clean suite.
Promise.all(pending).then(() => {
  console.log(failures === 0 ? '\nAll streaming-engine availability checks passed.' : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
});
