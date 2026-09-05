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
require.cache['estub'] = {
  id: 'estub', filename: 'estub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => REPO, isPackaged: false },
    BrowserWindow: class {},
  },
};

const paths = require(path.join(DIST, 'e2a-paths.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));

// Native arm, tools env. Both overrides are the TEST's, and both are named above.
Object.defineProperty(toolPaths, 'shouldUseWsl2ForOrpheus', { value: () => false, configurable: true });
const toolsPython = paths.getPythonInvocation(paths.getDefaultE2aPath());
paths.getPythonInvocation = () => toolsPython;

const pool = require(path.join(DIST, 'orpheus-worker-pool.js'));
const plan = pool.buildSpawnPlan();

const args = [...plan.args, '--fake-engine'];
console.log('COMMAND : ' + plan.command);
console.log('ARGV    : ' + JSON.stringify(args));
console.log('CWD     : ' + plan.cwd);
console.log('ENV     : ' + JSON.stringify(Object.fromEntries(
  Object.entries(plan.env).filter(([k]) => /^(PYTHON|NARRATOR_|ORPHEUS_|VLLM_|EBOOK)/.test(k)),
), null, 0));

const child = spawn(plan.command, args, { cwd: plan.cwd, env: plan.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });

const seen = [];
let step = 0;
const send = (o) => { child.stdin.write(JSON.stringify(o) + '\n'); };

const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  line = line.trim();
  if (!line.startsWith('{')) { if (line) console.log('non-json: ' + line.slice(0, 120)); return; }
  const r = JSON.parse(line);
  seen.push(r.type);
  const brief = { type: r.type };
  for (const k of ['device', 'backend', 'engine', 'sampleRate', 'pads', 'edgeFadeMs', 'voice', 'message', 'duration', 'i', 'count', 'seq']) {
    if (r[k] !== undefined) brief[k] = r[k];
  }
  if (r.data) brief.dataBytes = r.data.length;
  console.log('<< ' + JSON.stringify(brief));

  if (r.type === 'ready' && step === 0) {
    step = 1;
    send({ action: 'load', voice: 'leah', warm: false });
  } else if (r.type === 'loaded' && step === 1) {
    step = 2;
    send({ action: 'generate', text: 'The pool built this command line.', language: 'en' });
  } else if (r.type === 'audio' && step === 2) {
    step = 3;
    send({ action: 'generate_batch', language: 'en', items: [
      { i: 0, text: 'First row of the batch.' },
      { i: 1, text: 'Second row of the batch.' },
    ] });
  } else if (r.type === 'batch_done' && step === 3) {
    step = 4;
    send({ action: 'quit' });
  }
});

child.stderr.on('data', (b) => {
  const s = b.toString().trim();
  if (s) console.log('[stderr] ' + s.split('\n').slice(0, 3).join(' | '));
});

child.on('close', (code) => {
  console.log('EXIT ' + code + '  sequence: ' + seen.join(' -> '));
  const need = ['ready', 'loaded', 'audio', 'batch_item', 'batch_done'];
  const missing = need.filter((t) => !seen.includes(t));
  console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'SMOKE OK — every message the pool waits for arrived');
  process.exit(missing.length || code ? 1 : 0);
});

setTimeout(() => { console.log('TIMEOUT'); child.kill(); process.exit(1); }, 180000);
