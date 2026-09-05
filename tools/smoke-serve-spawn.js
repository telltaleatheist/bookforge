#!/usr/bin/env node
/**
 * Does the argv/env/cwd the POOL builds actually start narrator's server on this
 * machine?
 *
 *   npx tsc -p tsconfig.electron.json && node tools/smoke-serve-spawn.js
 *
 * NOT a keeper: it needs a real python environment with the narrator package
 * importable, which a CI checkout does not have. It is the hand-run half of
 * PORT_NOTES section 9.5 — steps 2-5 of the cut-over smoke, against the fake
 * engine instead of a model, so it needs no GPU and no WSL. Run it again in the
 * WSL orpheus_tts env and on the Mac when a real model can be loaded.
 *
 * The plan comes from the real `buildSpawnPlan`. Two things are changed, both by
 * the TEST and neither by the app:
 *
 *   - the interpreter is the tools env (`getPythonInvocation` with no engine),
 *     because this machine's Orpheus env lives in WSL and the GPU is held by
 *     another job's lock. `python_env` has no torch and no vLLM — which is the
 *     point: `narrator.serve --fake-engine` needs neither.
 *   - `--fake-engine` is appended to argv. PORT_NOTES 9.6: it is an argv flag
 *     rather than an env var precisely so the pool cannot enable it by
 *     forwarding process.env, and `tools/test-serve-spawn-env.js` asserts the
 *     app never passes it.
 *
 * Everything else is the pool's: the module (`-m narrator.serve`), PYTHONPATH,
 * NARRATOR_ENGINE, all the ORPHEUS_* variables, and the cwd.
 *
 * ── `--real`: the same script with BOTH of those changes withdrawn ──────────
 *
 *   node tools/smoke-serve-spawn.js --real --voice mistborn [--stream] [--timeout 600]
 *
 * The two overrides above are exactly what stands between this smoke and a proof,
 * and each is a place a bug can hide: forcing the tools env means the WSL arm of
 * `buildSpawnPlan` is never executed, and `--fake-engine` means no backend is ever
 * detected, no weights are loaded, and `_generate_audio_batch`'s vLLM path — the
 * one PORT_NOTES 10 lists as uncovered, because `FakeEngine` reports
 * `backend='transformers'` — never runs.
 *
 * With `--real` NEITHER is applied: the plan is whatever `buildSpawnPlan()` says
 * on this machine (the WSL `orpheus_tts` arm on Windows), argv is the plan's own,
 * and the voice is a real one whose weights get loaded. **The default stays fake**
 * — a GPU-free smoke that a machine with no model can still run is the thing this
 * file was written to be, and PORT_NOTES 9.6 is about the app, not about a switch
 * a human types.
 *
 * `--real` also times the things only a real model has: cold start (spawn to
 * `ready`), model load (`load` to `loaded`), and per-row generation against the
 * audio each row actually produced, which is the number that says whether a
 * streaming reader keeps ahead of a listener.
 *
 * `--stream` sends the played row with `stream: true`, so the run exercises
 * `batch_chunk` slices instead of whole-row `batch_item`s — the fast-start token
 * stream rather than the buffered batch. Run it both ways: they are different code
 * paths in `generate_batch_stream` and only one of them is the extension's default.
 */
'use strict';
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron') return 'estub';
  return orig.call(this, r, ...a);
};
// `userData` is the REAL one, not the repo. `tool-paths.json` lives there and it is
// what `shouldUseWsl2ForOrpheus()` reads; a stub that answers the repo for every
// getPath makes that config invisible, the toggle read false, and `buildSpawnPlan`
// take the NATIVE arm — which on Windows has no Orpheus env and refuses. That is
// harmless while `--fake-engine` is forced (nothing reads userData), and it is
// exactly the arm `--real` exists to execute, so the two cannot share a lie.
// `cli/electron-stub.js` already computes it per platform; borrowed rather than
// re-derived, so there is one answer.
const { USER_DATA } = require(path.join(REPO, 'cli', 'electron-stub.js'));
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: {
      getAppPath: () => REPO,
      getPath: (name) => (name === 'userData' ? USER_DATA : REPO),
      isPackaged: false,
    },
    BrowserWindow: class {},
  },
};

const argOf = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const REAL = process.argv.includes('--real');
const STREAM = process.argv.includes('--stream');
const VOICE = argOf('voice', REAL ? null : 'leah');
const TIMEOUT_MS = Number(argOf('timeout', REAL ? 900 : 180)) * 1000;
if (REAL && !VOICE) {
  console.error('--real needs --voice <id>: a real load must name the weights it is loading.');
  process.exitCode = 2;
  return;
}

const paths = require(path.join(DIST, 'narrator-paths.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));

// Native arm, tools env. Both overrides are the TEST's, and both are named above.
// Under --real NEITHER is applied — see the header: withdrawing them is the whole
// difference between this smoke and a proof.
if (!REAL) {
  Object.defineProperty(toolPaths, 'shouldUseWsl2ForOrpheus', { value: () => false, configurable: true });
  const toolsPython = paths.getPythonInvocation();
  paths.getPythonInvocation = () => toolsPython;
}

// The pool asks a registered probe which engine a spawn is for, and refuses to
// answer with nothing registered (236558d0 — the old silent `'orpheus'` default
// was wrong for Higgs). In the app `streaming-engine.ts` registers the probe at
// module load, BEFORE the pool is ever asked; this tool loads that same module
// rather than registering a probe of its own, so the engine it spawns for is the
// one the app would choose from its saved setting, not a re-description.
// (Found by the Mac agent at ffca9398: the tool died before any spawn, on every
// host, fake mode included.)
require(path.join(DIST, 'streaming-engine.js'));
const pool = require(path.join(DIST, 'orpheus-worker-pool.js'));
const plan = pool.buildSpawnPlan();

const args = REAL ? [...plan.args] : [...plan.args, '--fake-engine'];
console.log(`MODE    : ${REAL ? `REAL model (voice ${VOICE})` : 'fake engine'}${STREAM ? ', streamed row' : ''}`);
console.log('COMMAND : ' + plan.command);
console.log('ARGV    : ' + JSON.stringify(args));
console.log('CWD     : ' + plan.cwd);
console.log('ENV     : ' + JSON.stringify(Object.fromEntries(
  Object.entries(plan.env).filter(([k]) => /^(PYTHON|NARRATOR_|ORPHEUS_|VLLM_|EBOOK)/.test(k)),
), null, 0));

const T0 = Date.now();
const at = () => ((Date.now() - T0) / 1000).toFixed(1);
const marks = {};
const child = spawn(plan.command, args, { cwd: plan.cwd, env: plan.env, shell: plan.shell === true, stdio: ['pipe', 'pipe', 'pipe'] });

// The rows are long enough to time honestly: a two-word row's rate is dominated by
// the model-call overhead and says nothing about whether a reader keeps ahead.
const BATCH_ROWS = REAL ? [
  { i: 0, text: 'The pool built this command line, and the worker on the other end of it loaded a real set of weights rather than a stand-in.' },
  { i: 1, text: 'What that buys is the one path a fake engine cannot reach: the vLLM batch, its sampling parameters, and the per-row adapter request that goes with them.' },
] : [
  { i: 0, text: 'First row of the batch.' },
  { i: 1, text: 'Second row of the batch.' },
];

const seen = [];
let step = 0;
let audioBytes = 0;
let chunkCount = 0;
let sampleRate = 24000;
const send = (o) => { child.stdin.write(JSON.stringify(o) + '\n'); };

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  line = line.trim();
  if (!line.startsWith('{')) { if (line) console.log('non-json: ' + line.slice(0, 120)); return; }
  const r = JSON.parse(line);
  seen.push(r.type);
  // A refusal before `loaded` means nothing after it can happen. Quit rather than
  // sitting on the timeout: a smoke that hangs a quarter of an hour on an answer
  // it already has is a smoke nobody runs twice — and under --real that quarter
  // hour is a GPU somebody else is waiting for.
  if (r.type === 'error' && step < 4) {
    console.log('REFUSED : ' + (r.message || JSON.stringify(r)));
    step = 4;
    send({ action: 'quit' });
    return;
  }
  const brief = { type: r.type };
  for (const k of ['device', 'backend', 'engine', 'sampleRate', 'pads', 'edgeFadeMs', 'voice', 'message', 'duration', 'i', 'count', 'seq']) {
    if (r[k] !== undefined) brief[k] = r[k];
  }
  if (r.data) brief.dataBytes = r.data.length;
  // base64 PCM_16 -> seconds, the same arithmetic orpheus-worker-pool.ts does
  // (`bytes / (rate * 2)`), so a rate quoted here is the rate the pool would report.
  if (r.data) { audioBytes += Buffer.from(r.data, 'base64').length; }
  if (r.type === 'batch_chunk') chunkCount++;
  if (r.sampleRate) sampleRate = r.sampleRate;
  // A streamed batch emits many chunks; printing each one buries the timings.
  if (r.type !== 'batch_chunk' || chunkCount <= 3) console.log(`<< [${at()}s] ` + JSON.stringify(brief));
  else if (chunkCount === 4) console.log('<< ... (further batch_chunks summarised at exit)');

  if (r.type === 'ready' && step === 0) {
    marks.ready = Date.now();
    console.log(`TIMING  : cold start (spawn -> ready) ${((marks.ready - T0) / 1000).toFixed(1)} s`);
    step = 1;
    // THE LOAD MESSAGE IS THE POOL'S, not a hand-rolled one. A bare
    // `{voice: 'mistborn'}` is refused by name — narrator's allowlist is the eight
    // stock voices and it will not substitute `leah` for a fine-tune it cannot
    // resolve, which is correct and is exactly what this tool hit on its first real
    // run. A custom voice needs `modelDir` (or `adapterDir` + `baseDir`), the voice
    // TOKEN rather than the catalog id, its per-voice caps, and — on the WSL arm —
    // those directories in GUEST form. `resolveLoadPlan` does all four, and
    // borrowing it means the smoke cannot drift from what Listen sends.
    const load = pool.resolveLoadPlan(VOICE);
    console.log('LOAD    : ' + JSON.stringify(load));
    send({
      action: 'load', warm: false, voice: load.token,
      ...(load.modelDir ? { modelDir: load.modelDir } : {}),
      ...(load.adapterDir ? { adapterDir: load.adapterDir } : {}),
      ...(load.baseDir ? { baseDir: load.baseDir } : {}),
      caps: load.caps,
    });
  } else if (r.type === 'loaded' && step === 1) {
    marks.loaded = Date.now();
    console.log(`TIMING  : model load (load -> loaded) ${((marks.loaded - marks.ready) / 1000).toFixed(1)} s`);
    step = 2;
    audioBytes = 0;
    marks.genStart = Date.now();
    send({ action: 'generate', text: 'The pool built this command line.', language: 'en' });
  } else if (r.type === 'audio' && step === 2) {
    const secs = audioBytes / (sampleRate * 2);
    const wall = (Date.now() - marks.genStart) / 1000;
    console.log(`TIMING  : single generate — ${secs.toFixed(2)} s audio in ${wall.toFixed(2)} s wall = ${(secs / wall).toFixed(2)}x realtime`);
    step = 3;
    audioBytes = 0;
    marks.batchStart = Date.now();
    const req = { action: 'generate_batch', language: 'en', items: BATCH_ROWS };
    // The fast-start token stream: the PLAYED row is the one the client streams.
    if (STREAM) req.items = req.items.map((it, n) => (n === 0 ? { ...it, stream: true } : it));
    send(req);
  } else if (r.type === 'batch_done' && step === 3) {
    marks.batchDone = Date.now();
    const secs = audioBytes / (sampleRate * 2);
    const wall = (marks.batchDone - marks.batchStart) / 1000;
    console.log(`TIMING  : batch of ${BATCH_ROWS.length} — ${secs.toFixed(2)} s audio in ${wall.toFixed(2)} s wall = ${(secs / wall).toFixed(2)}x realtime`
      + (chunkCount ? `, ${chunkCount} batch_chunk slices` : ''));
    step = 4;
    send({ action: 'quit' });
  }
});

child.stderr.on('data', (b) => {
  const s = b.toString().trim();
  if (s) console.log('[stderr] ' + s.split('\n').slice(0, 3).join(' | '));
});

child.on('close', (code) => {
  // The watchdog timer MUST be cleared here. Node keeps the event loop alive for
  // any pending timer, so without this a run that finished perfectly sits until the
  // timeout fires and then exits 1 — overwriting the exitCode two lines below. The
  // smoke prints "SMOKE OK", waits out the full window in silence, and reports
  // failure. Found 2026-09-05: `--real` raised the window from 180 s to 900 s,
  // which turned a latent 3-minute stall into a quarter-hour one and made a
  // chained second run start long after its output directory was gone.
  clearTimeout(watchdog);
  // And the escalation timer the watchdog arms. It is hoisted rather than left
  // inline for exactly the reason above: if the worker answers `quit` cleanly after
  // the watchdog fired, `close` runs while a 30 s timer is still pending, which
  // holds the event loop open and then calls `process.exit(1)` on a run that had
  // already decided its own exit code. Same stall, one level down.
  clearTimeout(escalation);
  const uniq = seen.filter((t, i) => seen.indexOf(t) === i);
  console.log('EXIT ' + code + '  sequence: ' + uniq.join(' -> ') + `  (${seen.length} messages)`);
  const need = ['ready', 'loaded', 'audio', 'batch_item', 'batch_done'];
  const missing = need.filter((t) => !seen.includes(t));
  console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'SMOKE OK — every message the pool waits for arrived');
  process.exitCode = missing.length || code ? 1 : 0;
});

// abort-path: a hung worker has to be abandoned immediately, and there is
// nothing buffered to lose — everything above is already written.
// abort-path: a hung worker has to be abandoned, and there is nothing buffered to
// lose. `quit` first, and only then the signal: under --real the child holds GPU
// memory in a WSL guest, where SIGKILLing a process mid-CUDA is what wedges the VM
// (memory: wsl-wedge-proofing). Cooperative shutdown, then a grace period.
let escalation = null;
const watchdog = setTimeout(() => {
  console.log('TIMEOUT — asking the worker to quit');
  try { send({ action: 'quit' }); } catch { /* stdin already gone */ }
  escalation = setTimeout(() => { console.log('TIMEOUT — worker did not exit; terminating'); child.kill('SIGTERM'); process.exit(1); /* abort-path */ }, 30000);
}, TIMEOUT_MS);
