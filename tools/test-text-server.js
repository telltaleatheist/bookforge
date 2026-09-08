#!/usr/bin/env node
/**
 * test-text-server — the arbiter that starts and stops the text-pass vLLM.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-text-server.js
 *
 * ── Why every branch here is faked, and that is the point ───────────────────
 *
 * `electron/text-server.ts` is a lifetime manager for twenty gigabytes of
 * weights on a WSL-hosted GPU. The branches that decide whether a book is
 * cleaned correctly — adopting a server that is already up, REFUSING one that
 * serves the wrong model, failing fast on a log line, swapping a profile,
 * staging weights that are not there, handing the card to a render — are exactly
 * the ones no machine reproduces on demand, and several of them cost 110 seconds
 * each to reach for real.
 *
 * So the module declares one `deps` object (`setTextServerDeps`) whose defaults
 * ARE the production implementations, and this keeper drives every branch
 * through it: no GPU, no WSL, no network, no weights. What it cannot fake — that
 * the launcher script and the module agree about the port, the dtype variable
 * and the process pattern — it reads off the real files.
 *
 * Owen, 2026-09-08: *"build that piece. the arbiter that starts/stops it"* and,
 * on the model: *"verify that when i run translate/simplify in foundry, they
 * will correctly use the 27b model in vllm and not the 9b."* The served-name
 * assertion and the call sites that use it are held below.
 */
'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'text-server.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// Every root this keeper could touch is under one temp dir, set BEFORE the stub
// loads: `app.getPath('userData')` is derived from APPDATA/XDG_CONFIG_HOME there.
// Nothing below writes a file, but a mis-injected dep must not be able to reach
// the machine's real settings or its log folder.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-text-server-'));
const FAKE_APPDATA = path.join(ROOT, 'appdata');
fs.mkdirSync(path.join(FAKE_APPDATA, 'BookForge'), { recursive: true });
if (process.platform === 'win32') process.env.APPDATA = FAKE_APPDATA;
else if (process.platform === 'darwin') process.env.HOME = FAKE_APPDATA;
else process.env.XDG_CONFIG_HOME = FAKE_APPDATA;
process.env.BOOKFORGE_USERDATA_DIR = path.join(ROOT, 'userdata');

require(path.join(REPO, 'cli', 'electron-stub.js'));

const server = require(path.join(DIST, 'text-server.js'));

const LAUNCHER = path.join(REPO, 'electron', 'scripts', 'vllm', 'serve_text_vllm.sh');
const DOWNLOADER = path.join(REPO, 'electron', 'scripts', 'vllm', 'text_model_download.py');

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ─────────────────────────────────────────────────────────────────────────────
// A fake guest
// ─────────────────────────────────────────────────────────────────────────────

/** A child process that says what a test tells it to and exits when told. */
function fakeChild() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = () => { proc.exitCode = 143; };
  proc.say = (line) => proc.stdout.emit('data', Buffer.from(`${line}\n`));
  proc.die = (code) => { proc.exitCode = code; proc.emit('exit', code, null); };
  return proc;
}

/**
 * A world for one test: what the port answers, whether the weights are there,
 * who holds the card, and every call the module made.
 */
function world(overrides = {}) {
  const calls = {
    spawns: [], pkills: [], acquires: [], releases: [], stages: [], said: [], staged: [],
  };
  const state = {
    /** Successive answers from GET /v1/models. The last one repeats. */
    modelLists: overrides.modelLists ?? [{ up: false, ids: [] }],
    staged: overrides.staged ?? true,
    lock: overrides.lock ?? null,
    child: null,
    /** The yield handler the module registered with the arbiter. */
    onYield: null,
  };
  let listIndex = 0;

  server.resetTextServerState();
  server.setTextServerDeps({
    spawn: (file, args) => {
      calls.spawns.push({ file, args });
      state.child = fakeChild();
      if (overrides.onSpawn) setImmediate(() => overrides.onSpawn(state.child));
      return state.child;
    },
    askModelList: async () => {
      const answer = state.modelLists[Math.min(listIndex, state.modelLists.length - 1)];
      listIndex += 1;
      return answer;
    },
    pkill: async (pattern, opts) => {
      calls.pkills.push({ pattern, opts });
      if (state.child !== null) { state.child.exitCode = 0; }
      return 'exited';
    },
    acquireGpu: async (owner, opts) => {
      calls.acquires.push(owner);
      state.onYield = opts && opts.onYield ? opts.onYield : null;
    },
    releaseGpu: (owner) => { calls.releases.push(owner); },
    gpuLock: () => state.lock,
    /*
     * A REAL macrotask, not a resolved promise. The readiness loop is
     * `await askModelList()` then `await sleep()`, and a sleep that resolves on
     * the microtask queue never lets a `setImmediate` or a timer run — the loop
     * starves the event loop, the guest's fatal line is never delivered, and even
     * this keeper's own stdout stops draining. `setTimeout(…, 0)` is what makes
     * the poll a poll.
     */
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    now: () => Date.now(),
    distro: () => 'Ubuntu',
    condaEnvPrefix: () => '/home/telltale/anaconda3/envs/higgs3',
    scriptPath: () => 'C:\\Users\\tellt\\Projects\\bookforge\\electron\\scripts\\vllm\\serve_text_vllm.sh',
    isStaged: async (profile) => { calls.staged.push(profile.id); return state.staged; },
    stage: async (profile, onProgress) => {
      calls.stages.push(profile.id);
      onProgress({ bytes: 4_200_000_000, total: 21_000_000_000 });
      if (overrides.stageFails) throw new Error(overrides.stageFails);
      state.staged = true;
    },
    record: () => { /* no log file in a keeper */ },
  });
  return { calls, state, say: (line) => calls.said.push(line) };
}

const NINE_B = 'qwen35-9b-bf16';
const TWENTY_SEVEN_B = 'qwen38-27b-awq-int4';
const NINE_B_NAME = 'Qwen3.5-9B-bf16';
const TWENTY_SEVEN_B_NAME = 'Qwen3.8-27B-AWQ-INT4';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The profile table, and its agreement with the launcher
// ─────────────────────────────────────────────────────────────────────────────

test('the two profiles are the two Owen named, with pinned revisions', () => {
  const ids = Object.keys(server.TEXT_MODEL_PROFILES);
  assert.deepStrictEqual(ids.slice().sort(), [NINE_B, TWENTY_SEVEN_B].slice().sort());

  const nine = server.TEXT_MODEL_PROFILES[NINE_B];
  assert.strictEqual(nine.servedName, NINE_B_NAME);
  assert.strictEqual(nine.modelDir, 'models/Qwen3.5-9B');
  assert.strictEqual(nine.hfRepo, 'Qwen/Qwen3.5-9B');
  assert.strictEqual(nine.hfRevision, 'c202236235762e1c871ad0ccb60c8ee5ba337b9a');
  assert.strictEqual(nine.dtype, 'bfloat16');

  const big = server.TEXT_MODEL_PROFILES[TWENTY_SEVEN_B];
  assert.strictEqual(big.servedName, TWENTY_SEVEN_B_NAME);
  assert.strictEqual(big.modelDir, 'models/Qwen3.8-27B-AWQ-INT4');
  assert.strictEqual(big.hfRepo, 'cyankiwi/Qwen3.8-27B-AWQ-INT4');
  assert.strictEqual(big.hfRevision, '63768c10df38c0395e12ef49edac1bd539eaeeea');
  // `auto`, because the weights are compressed-tensors INT4 and vLLM reads the
  // activation dtype out of the checkpoint's own quantization_config.
  assert.strictEqual(big.dtype, 'auto');
});

test('every served name still LOOKS like a qwen3 to Foundry', () => {
  /*
   * Foundry's `takesThinkField` (foundry src/translate/ollama.ts) is
   * `/^qwen3(\.|:|-|$)/i` over the last path segment of the served name, and it
   * is what puts `chat_template_kwargs.enable_thinking=false` on the request. A
   * served name that failed it would leave thinking ON, and the model would
   * reason before every block of every book — minutes of GPU per block on a pass
   * that asks temperature 0 for a rewrite. This is the exact regex, copied.
   */
  const takesThinkField = (model) => /^qwen3(\.|:|-|$)/i.test(model.trim());
  for (const profile of Object.values(server.TEXT_MODEL_PROFILES)) {
    assert.ok(takesThinkField(profile.servedName),
      `${profile.id} serves "${profile.servedName}", which Foundry would let think`);
  }
  // And the test itself is honest: a name that does NOT look like one fails it.
  assert.strictEqual(takesThinkField('Llama-3.1-8B'), false);
});

test('the port, the dtype and the process pattern agree with the launcher script', () => {
  const launcher = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(launcher.includes(`VLLM_TEXT_PORT:-${server.TEXT_SERVER_PORT}`),
    `serve_text_vllm.sh must default to port ${server.TEXT_SERVER_PORT}`);
  assert.ok(/VLLM_TEXT_DTYPE:-bfloat16/.test(launcher),
    'the launcher must take the activation dtype from the environment');
  assert.ok(launcher.includes('--dtype "$VLLM_TEXT_DTYPE"'), 'and pass it through');
  for (const name of [
    'VLLM_TEXT_ENV', 'VLLM_TEXT_MODEL_DIR', 'VLLM_TEXT_MODEL_NAME', 'VLLM_TEXT_PORT',
    'VLLM_TEXT_MAX_NUM_SEQS', 'VLLM_TEXT_MAX_MODEL_LEN', 'VLLM_TEXT_GPU_MEM_UTIL',
    'VLLM_TEXT_MAMBA_CACHE_DTYPE', 'VLLM_TEXT_KV_CACHE_DTYPE',
  ]) {
    assert.ok(launcher.includes(`${name}="\${${name}:-`), `${name} must be a launcher knob`);
  }
  // The stop and the sweep-exclusion patterns must match what the script execs.
  const exec = 'vllm.entrypoints.openai.api_server';
  assert.ok(launcher.includes(`-m ${exec}`), 'the launcher execs the module the patterns name');
  assert.ok(launcher.includes('--served-model-name "$VLLM_TEXT_MODEL_NAME"'),
    'the stop pattern reads the served name off the command line, so it must be ON it');
  assert.ok(new RegExp(server.TEXT_SERVER_PROTECT_RE).test(`python -m ${exec} --model x`),
    'the protect pattern must match the served process');
  assert.ok(fs.existsSync(DOWNLOADER), 'the staging script must be in the checkout');
});

test('the stop matches OUR server and no other', () => {
  const exec = 'vllm.entrypoints.openai.api_server';
  const ours = server.textServerProcessPattern(NINE_B_NAME);
  const line = (name, port) => `python -m ${exec} --model /home/t/models/x `
    + `--served-model-name ${name} --host 127.0.0.1 --port ${port}`;

  assert.ok(new RegExp(ours).test(line(NINE_B_NAME, server.TEXT_SERVER_PORT)), 'it must match ours');
  // A vLLM on somebody else's port is out of scope entirely — the page reader is
  // on 8077 and Foundry's reading server on 8000.
  assert.strictEqual(new RegExp(ours).test(line(NINE_B_NAME, 8000)), false);
  /*
   * AND THE RACE THIS EXISTS FOR: if another server takes port 8300 while ours is
   * coming up, our start fails — and the teardown of OUR spawn must not take
   * THEIRS with it. A server started for a different model does not match.
   */
  assert.strictEqual(
    new RegExp(ours).test(line(TWENTY_SEVEN_B_NAME, server.TEXT_SERVER_PORT)), false,
    'the stop would have killed a server serving a different model on our port');
  assert.ok(new RegExp(server.textServerProcessPattern(TWENTY_SEVEN_B_NAME))
    .test(line(TWENTY_SEVEN_B_NAME, server.TEXT_SERVER_PORT)));
  // The dots in a served name are LITERAL: `Qwen3.5-9B-bf16` must not match
  // `Qwen3X5-9B-bf16`, which a bare interpolation would.
  assert.strictEqual(new RegExp(ours).test(line('Qwen3X5-9B-bf16', server.TEXT_SERVER_PORT)), false);
  // `[v]llm` — it cannot match the shell of a `pkill -f` that carries it.
  assert.ok(ours.startsWith('[v]llm'),
    'the pattern must be written so it cannot match the shell that runs it');
});

test('a language act resolves to the model Owen assigned it', () => {
  assert.strictEqual(server.profileForKind('clean').id, NINE_B);
  for (const kind of ['translate', 'simplify', 'analysis']) {
    assert.strictEqual(server.profileForKind(kind).id, TWENTY_SEVEN_B, kind);
  }
  assert.throws(() => server.profileForKind('render'),
    (err) => /not a language act this arbiter has a model for/.test(err.message));
});

test('the served model is ASSERTED onto a request, never hoped for', () => {
  const nine = server.TEXT_MODEL_PROFILES[NINE_B];
  const big = server.TEXT_MODEL_PROFILES[TWENTY_SEVEN_B];
  // Empty is vLLM's default and means "whatever it is serving" — which is exactly
  // the case a translation could silently run on the 9B in. The host names it.
  assert.strictEqual(server.servedModelForRequest('', big, 'translate'), TWENTY_SEVEN_B_NAME);
  assert.strictEqual(server.servedModelForRequest(undefined, nine, 'clean'), NINE_B_NAME);
  assert.strictEqual(server.servedModelForRequest('   ', big, 'simplify'), TWENTY_SEVEN_B_NAME);
  // Saying the right thing is allowed.
  assert.strictEqual(
    server.servedModelForRequest(TWENTY_SEVEN_B_NAME, big, 'translate'), TWENTY_SEVEN_B_NAME);
  // Asking for the OTHER model refuses, naming both.
  assert.throws(
    () => server.servedModelForRequest(NINE_B_NAME, big, 'translate'),
    (err) => {
      assert.ok(err.message.includes(NINE_B_NAME), err.message);
      assert.ok(err.message.includes(TWENTY_SEVEN_B_NAME), err.message);
      assert.ok(/nothing was started/i.test(err.message), err.message);
      return true;
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Which endpoints are ours
// ─────────────────────────────────────────────────────────────────────────────

test('only OUR loopback port is managed; everything else is used as given', () => {
  for (const url of [
    'http://localhost:8300/v1', 'http://127.0.0.1:8300/v1', 'http://localhost:8300/v1/',
  ]) {
    assert.strictEqual(server.isLocalTextServerUrl(url), true, url);
    assert.strictEqual(server.textServerRoute(url).manage, true, url);
    assert.strictEqual(server.textServerRoute(url).note, null, url);
  }
  // Foundry's OWN default vLLM URL is port 8000 — its READING server, serving a
  // vision model. Nothing is started or stopped, and the note says why.
  const foundryDefault = server.textServerRoute('http://localhost:8000/v1');
  assert.strictEqual(foundryDefault.manage, false);
  assert.ok(/READING server/.test(foundryDefault.note), foundryDefault.note);
  assert.ok(foundryDefault.note.includes(server.TEXT_SERVER_URL), foundryDefault.note);
  // A remote server is somebody else's, always.
  const remote = server.textServerRoute('http://titan:8300/v1');
  assert.strictEqual(remote.manage, false);
  assert.ok(/starts and stops nothing/.test(remote.note), remote.note);
  assert.strictEqual(server.isLocalTextServerUrl('not a url'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The fatal-line scan
// ─────────────────────────────────────────────────────────────────────────────

test('a fatal line is recognised, and vLLM\'s ordinary chatter is not', () => {
  // MEASURED on this PC's first start (2026-09-08), ninety seconds in, after the
  // weights had already loaded.
  assert.ok(/nvcc/.test(
    server.textServerFatalReason("RuntimeError: Could not find nvcc and default cuda_home=''") || ''));
  assert.ok(server.textServerFatalReason('torch.OutOfMemoryError: CUDA out of memory') !== null);
  assert.ok(server.textServerFatalReason('ERROR: [Errno 98] Address already in use') !== null);
  // The exclusion that is load-bearing: a HEALTHY vLLM prints this during a start
  // that goes on to succeed.
  assert.strictEqual(server.textServerFatalReason(
    'WARNING 09-08 [interface.py:389] Failed to import from vllm._C with '
    + 'ModuleNotFoundError("No module named \'vllm._C\'")'), null);
  assert.strictEqual(server.textServerFatalReason(
    'INFO 09-08 [api_server.py:1] Application startup complete.'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The lifetime
// ─────────────────────────────────────────────────────────────────────────────

test('a server already serving THIS profile is adopted, and never stopped', async () => {
  const w = world({ modelLists: [{ up: true, ids: [NINE_B_NAME] }] });
  const handle = await server.ensureTextServer(NINE_B, w.say);
  assert.strictEqual(handle.servedName, NINE_B_NAME);
  assert.strictEqual(handle.url, server.TEXT_SERVER_URL);
  assert.strictEqual(w.calls.spawns.length, 0, 'nothing may be spawned onto an answering port');
  assert.strictEqual(w.calls.acquires.length, 0, 'a server we do not own holds no arbiter lock');
  assert.ok(w.calls.said.some((l) => /will not stop it/.test(l)), w.calls.said.join(' | '));
  assert.strictEqual(server.textServerStatus().adopted, true);

  // A drain must leave it exactly alone: it was somebody's before we wanted one.
  server.noteTextQueueIdle(0);
  await server.stopTextServer('the keeper is done');
  assert.strictEqual(w.calls.pkills.length, 0, 'an adopted server is never SIGTERMed');
});

test('a FOREIGN server on the port is refused by name, used by nothing and stopped by nothing', async () => {
  const w = world({ modelLists: [{ up: true, ids: ['rednote-hilab/dots.ocr'] }] });
  await assert.rejects(
    () => server.ensureTextServer(NINE_B, w.say),
    (err) => {
      assert.ok(err.message.includes('dots.ocr'), err.message);
      assert.ok(err.message.includes(NINE_B_NAME), err.message);
      assert.ok(/will not stop it/.test(err.message), err.message);
      return true;
    });
  assert.strictEqual(w.calls.spawns.length, 0);
  assert.strictEqual(w.calls.pkills.length, 0, 'somebody else\'s server is never killed');
  assert.strictEqual(w.calls.acquires.length, 0);
});

test('a start spawns the launcher, takes the card, and waits for OUR served name', async () => {
  const w = world({
    modelLists: [
      { up: false, ids: [] },          // the pre-check: the port is quiet
      { up: false, ids: [] },          // still loading
      { up: true, ids: [NINE_B_NAME] } // ready
    ],
  });
  const handle = await server.ensureTextServer(NINE_B, w.say);
  assert.strictEqual(handle.servedName, NINE_B_NAME);
  assert.strictEqual(w.calls.spawns.length, 1);
  assert.deepStrictEqual(w.calls.acquires, ['vllm:text']);

  const { file, args } = w.calls.spawns[0];
  assert.strictEqual(file, 'wsl.exe');
  // `--exec` is the whole reason `wslScriptArgs` exists: without it wsl.exe hands
  // the string to the distro's default shell, which expands `$HOME` to nothing.
  assert.deepStrictEqual(args.slice(0, 4), ['-d', 'Ubuntu', '--exec', 'bash']);
  const command = args[args.length - 1];
  assert.ok(command.includes(`VLLM_TEXT_MODEL_NAME='${NINE_B_NAME}'`), command);
  assert.ok(command.includes('VLLM_TEXT_MODEL_DIR="$HOME/models/Qwen3.5-9B"'),
    'the model dir must be left for the GUEST\'s bash to expand');
  assert.ok(command.includes(`VLLM_TEXT_PORT='${server.TEXT_SERVER_PORT}'`), command);
  assert.ok(command.includes("VLLM_TEXT_DTYPE='bfloat16'"), command);
  assert.ok(command.includes("VLLM_TEXT_ENV='/home/telltale/anaconda3/envs/higgs3'"), command);
  assert.ok(command.includes('/mnt/c/Users/tellt/Projects/bookforge/electron/scripts/vllm/serve_text_vllm.sh'),
    'the launcher path must be translated for the guest');
  assert.strictEqual(server.textServerStatus().running, true);
  assert.strictEqual(server.textServerStatus().profileId, NINE_B);

  await server.stopTextServer('the keeper is done');
});

test('a fatal log line fails the start FAST, with the guest\'s own tail, and gives the card back', async () => {
  const w = world({
    modelLists: [{ up: false, ids: [] }],
    onSpawn: (child) => {
      child.say('INFO 09-08 [loader] Loading weights took 15.0 seconds');
      child.say('INFO 09-08 [gpu_worker] Model loading took 16.8 GiB');
      child.say("RuntimeError: Could not find nvcc and default cuda_home='/usr/local/cuda' doesn't exist");
    },
  });
  await assert.rejects(
    () => server.ensureTextServer(NINE_B, w.say),
    (err) => {
      assert.ok(/cannot start: the environment's CUDA toolkit is missing/.test(err.message), err.message);
      // THE TAIL. Without it the failure is an exit code and the cause dies with
      // the process.
      assert.ok(err.message.includes('16.8 GiB'), `the guest's own lines must survive: ${err.message}`);
      return true;
    });
  assert.deepStrictEqual(w.calls.releases, ['vllm:text'], 'a failed start must not keep the card');
  assert.strictEqual(w.calls.pkills.length, 1, 'and must tear down what it spawned');
  assert.strictEqual(server.textServerStatus().running, false);
});

test('two passes beginning together share ONE spawn', async () => {
  const w = world({
    modelLists: [
      { up: false, ids: [] },
      { up: false, ids: [] },
      { up: true, ids: [NINE_B_NAME] },
    ],
  });
  const [a, b] = await Promise.all([
    server.ensureTextServer(NINE_B, w.say),
    server.ensureTextServer(NINE_B, w.say),
  ]);
  assert.strictEqual(a.servedName, NINE_B_NAME);
  assert.strictEqual(b.servedName, NINE_B_NAME);
  assert.strictEqual(w.calls.spawns.length, 1,
    'a second pass must join the in-flight start, not reserve the same VRAM twice');
  await server.stopTextServer('the keeper is done');
});

test('a drained queue stops the server, and the card goes back', async () => {
  const w = world({ modelLists: [{ up: false, ids: [] }, { up: true, ids: [NINE_B_NAME] }] });
  await server.ensureTextServer(NINE_B, w.say);
  assert.strictEqual(w.calls.releases.length, 0, 'the card is held while the server is up');

  server.noteTextQueueIdle(0);
  await new Promise((r) => setImmediate(r));
  await server.stopTextServer('settle');
  assert.strictEqual(w.calls.pkills.length, 1);
  assert.strictEqual(w.calls.pkills[0].pattern, server.textServerProcessPattern(NINE_B_NAME),
    'the stop must be scoped to the profile that is actually up');
  assert.deepStrictEqual(w.calls.releases, ['vllm:text']);
  assert.strictEqual(server.textServerStatus().running, false);
});

test('a keep-warm window delays the stop and then ENDS', async () => {
  const w = world({ modelLists: [{ up: false, ids: [] }, { up: true, ids: [NINE_B_NAME] }] });
  await server.ensureTextServer(NINE_B, w.say);

  // One millisecond, expressed the way the setting is: minutes. "Never
  // indefinite" is the property being held, not the number.
  server.noteTextQueueIdle(1 / 60_000);
  assert.strictEqual(w.calls.pkills.length, 0, 'the window must not stop it immediately');
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w.calls.pkills.length, 1, 'and the window must have an end');
  assert.deepStrictEqual(w.calls.releases, ['vllm:text']);

  // A pass arriving inside the window keeps the warm server rather than racing
  // its stop — the reason `noteTextQueueBusy` exists.
  const w2 = world({ modelLists: [{ up: false, ids: [] }, { up: true, ids: [NINE_B_NAME] }] });
  await server.ensureTextServer(NINE_B, w2.say);
  server.noteTextQueueIdle(1 / 60_000);
  server.noteTextQueueBusy();
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(w2.calls.pkills.length, 0, 'busy must cancel the countdown');
  await server.stopTextServer('the keeper is done');
});

test('a render asking for the card makes the text server step off it', async () => {
  const w = world({ modelLists: [{ up: false, ids: [] }, { up: true, ids: [NINE_B_NAME] }] });
  await server.ensureTextServer(NINE_B, w.say);
  assert.strictEqual(typeof w.state.onYield, 'function',
    'the text server MUST register a yield — it is the low-priority holder');

  w.state.onYield();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(w.calls.pkills.length, 1, 'a yield stops the server');
  assert.deepStrictEqual(w.calls.releases, ['vllm:text'], 'and hands the card to the render');
});

test('a job needing the OTHER model swaps the server', async () => {
  const w = world({
    modelLists: [
      { up: false, ids: [] }, { up: true, ids: [NINE_B_NAME] },          // the 9B comes up
      { up: false, ids: [] }, { up: true, ids: [TWENTY_SEVEN_B_NAME] },  // then the 27B
    ],
  });
  await server.ensureTextServer(NINE_B, w.say);
  const handle = await server.ensureTextServer(TWENTY_SEVEN_B, w.say);

  assert.strictEqual(handle.servedName, TWENTY_SEVEN_B_NAME);
  assert.strictEqual(w.calls.spawns.length, 2, 'a swap is a stop and a start');
  assert.strictEqual(w.calls.pkills.length, 1, 'the 9B is stopped first');
  assert.ok(w.calls.spawns[1].args[w.calls.spawns[1].args.length - 1]
    .includes(`VLLM_TEXT_MODEL_NAME='${TWENTY_SEVEN_B_NAME}'`));
  // The cost is SAID, because ~95 s of silence reads as a wedge.
  assert.ok(w.calls.said.some((l) => /Swapping the text server/.test(l)), w.calls.said.join(' | '));
  await server.stopTextServer('the keeper is done');
});

test('weights that are not on disk are DOWNLOADED, not refused', async () => {
  /*
   * Owen, 2026-09-08: *"id rather it just switch to the correct profile rather
   * than failing."* An absent profile stages itself and then serves.
   */
  const w = world({
    staged: false,
    modelLists: [{ up: false, ids: [] }, { up: true, ids: [TWENTY_SEVEN_B_NAME] }],
  });
  const handle = await server.ensureTextServer(TWENTY_SEVEN_B, w.say);
  assert.strictEqual(handle.servedName, TWENTY_SEVEN_B_NAME);
  assert.deepStrictEqual(w.calls.stages, [TWENTY_SEVEN_B]);
  assert.ok(w.calls.said.some((l) => /Downloading Qwen3\.8-27B-AWQ-INT4 \(about 21 GB\)/.test(l)),
    w.calls.said.join(' | '));
  // THE STAGE HAPPENS BEFORE THE CARD IS TAKEN: a 21 GB transfer does not touch
  // the GPU, and holding the arbiter through it would block every render.
  assert.strictEqual(w.calls.acquires.length, 1);
  await server.stopTextServer('the keeper is done');
});

test('a download that cannot happen refuses by name, and keeps what landed', async () => {
  const w = world({
    staged: false,
    stageFails: 'ConnectionError: HTTPSConnectionPool(host=huggingface.co) read timed out',
    modelLists: [{ up: false, ids: [] }],
  });
  await assert.rejects(
    () => server.ensureTextServer(TWENTY_SEVEN_B, w.say),
    (err) => {
      assert.ok(/read timed out/.test(err.message), err.message);
      return true;
    });
  assert.strictEqual(w.calls.spawns.length, 0, 'nothing is served from a half-downloaded model');
  assert.strictEqual(w.calls.acquires.length, 0, 'and the card is never taken for a failed stage');
});

test('another GPU job holding the card refuses the start by name', async () => {
  const w = world({
    lock: 'orpheus fine-tune, epoch 3',
    modelLists: [{ up: false, ids: [] }],
  });
  await assert.rejects(
    () => server.ensureTextServer(NINE_B, w.say),
    (err) => {
      assert.ok(/Another GPU job owns the card/.test(err.message), err.message);
      assert.ok(err.message.includes('orpheus fine-tune, epoch 3'), err.message);
      return true;
    });
  assert.strictEqual(w.calls.spawns.length, 0);
  assert.strictEqual(w.calls.acquires.length, 0);
});

test('an unknown profile id is a named throw, never a substitution', async () => {
  world();
  await assert.rejects(
    () => server.ensureTextServer('qwen-something-else'),
    (err) => /is not a text-model profile/.test(err.message));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The call sites — the bracket lives where the spawn is
// ─────────────────────────────────────────────────────────────────────────────

test('every door that spawns a text pass brackets it, and asserts the model', () => {
  /*
   * A source assertion rather than a behavioural one, deliberately: what is being
   * held is that there is ONE bracket per spawn and that it is in the file that
   * owns the spawn. A second copy in a caller is a second server lifetime, and
   * the failure mode of the missing one is a card held against nothing.
   */
  const doors = [
    ['electron/queue-steps/foundry-job.ts', true],
    ['electron/narration-clean-text.ts', false],
    ['cli/clean-step.js', true],
    ['cli/clean-lines-step.js', false],
  ];
  for (const [rel, assertsModel] of doors) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(/ensureTextServer/.test(source), `${rel} must bring the server up`);
    assert.ok(/noteTextQueueIdle|stopTextServer/.test(source), `${rel} must let it go`);
    assert.ok(/textServerRoute/.test(source),
      `${rel} must only manage the endpoint this machine owns`);
    assert.ok(/finally/.test(source), `${rel} must release on failure as well as success`);
    if (assertsModel) {
      assert.ok(/servedModelForRequest/.test(source),
        `${rel} sends a REQUEST, so it must name the served model on it`);
    }
  }
  // The bare-EPUB and clean-lines doors compose a command line instead, and the
  // rule there is the flag and the omission.
  for (const rel of ['electron/narration-clean-text.ts', 'cli/clean-lines-step.js']) {
    const source = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(/'--server', 'vllm'/.test(source), `${rel} must write --server vllm`);
    assert.ok(/settings\.model\.length > 0 \? \['--model', settings\.model\] : \[\]/.test(source),
      `${rel} must OMIT --model when the model is empty, never send --model ""`);
  }
});

test('the global WSL orphan sweep spares the text server', () => {
  /*
   * `parallel-tts-bridge`'s unscoped sweep matches `narrator\.compat\.(worker|app)|vllm`
   * — and the text server IS a vllm process in the same distro. Without the
   * exclusion, a batch job ending would SIGTERM a cleanup halfway through a book,
   * which is exactly what the Listen server's own exclusion exists to prevent.
   */
  const source = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
  assert.ok(/TEXT_SERVER_PROTECT_RE/.test(source), 'the sweep must know the text server by name');
  assert.ok(/excludeRe: spare/.test(source), 'and must pass it as the exclusion');
  // The exclusion is read out of `ps`, which TRUNCATES; the port is at the end of
  // the argv, so the protect pattern must not demand it.
  assert.strictEqual(server.TEXT_SERVER_PROTECT_RE.includes('--port'), false,
    'the ps-side exclusion must not depend on a field ps may truncate away');
});

test('app quit stops the text server, before the global sweep runs', () => {
  const main = fs.readFileSync(path.join(REPO, 'electron', 'main.ts'), 'utf8');
  const stop = main.indexOf("quitStepWithDeadline('stop the text server'");
  // The CALL, not the paragraph that explains it — the comment above the Foundry
  // step names the function too.
  const sweep = main.indexOf('await gracefulWslShutdown()');
  assert.ok(stop > 0, 'before-quit must stop the text server');
  assert.ok(sweep === -1 || stop < sweep,
    'it must stop cooperatively BEFORE any global pattern kill in the same distro');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      failures.push(t.name);
      console.error(`  FAIL  ${t.name}\n        ${err && err.stack}`);
    }
  }
  server.resetTextServerState();
  console.log(`\ntext server: ${passed}/${tests.length} passed`);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failures.length === 0 ? 0 : 1);
})();
