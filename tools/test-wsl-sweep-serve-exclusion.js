#!/usr/bin/env node
/**
 * THE GLOBAL WSL ORPHAN SWEEP DOES NOT KILL THE LISTEN SERVER'S vLLM.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-wsl-sweep-serve-exclusion.js
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * `cleanupWslOrphanedProcesses(null)` sweeps the guest with the pattern
 * `<batch modules>|vllm`. A comment above that line claimed "the guest-side helper
 * excludes `narrator.serve`". It did not — `wslPkillGraceful` had no exclusion of
 * any kind, so the sweep SIGTERM'd the resident Listen server's vLLM whenever a
 * batch job finished with no session left active. Playback stops; nothing logs an
 * error, because SIGTERM is exactly what the sweep counts as success.
 *
 * A comment is not a mechanism. This keeper exists so the exclusion is a fact.
 *
 * ── Descendants, not just the command line ──────────────────────────────────
 *
 * `narrator.serve` hosts vLLM, and vLLM's engine-core children are separate
 * processes that carry no mention of `narrator.serve` in their own command lines.
 * Excluding by cmdline alone spares the server and kills the engine underneath it —
 * the same dead playback by a longer route. So the exclusion is the matching
 * processes AND their descendants, and the fixture below has a two-level serve tree
 * to prove the walk is transitive.
 *
 * ── How it runs without WSL ─────────────────────────────────────────────────
 *
 * `wslPkillGraceful` is lifted out of the compiled `dist/electron/wsl-lifecycle.js`
 * with `execWsl` rebound to a fake guest holding a fixed process table. What runs
 * is the shipped function, not a re-description of it.
 *
 * A KEEPER THAT CANNOT FAIL IS WORTH NOTHING: the last row removes the exclusion
 * and requires the serve tree to die, so a regression that drops `excludeRe`
 * cannot pass this file.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
const LIFECYCLE = path.join(DIST, 'wsl-lifecycle.js');
const BRIDGE = path.join(DIST, 'parallel-tts-bridge.js');

if (!fs.existsSync(LIFECYCLE) || !fs.existsSync(BRIDGE)) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok    ${name}`))
    .catch((err) => {
      failures++;
      console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// The real function, lifted out of the compiled lifecycle module
// ─────────────────────────────────────────────────────────────────────────────
const lifecycleJs = fs.readFileSync(LIFECYCLE, 'utf-8');
const lifted = lifecycleJs.match(/async function wslPkillGraceful\(pattern, opts = \{\}\) \{[\s\S]*?\n\}\n/);
if (!lifted) {
  console.error('wslPkillGraceful is not in the compiled lifecycle module — did it move?');
  process.exitCode = 1;
  return;
}

/** A guest with a fixed process table. Records every kill it is asked to perform. */
function makeGuest(table) {
  const alive = new Map(table.map((r) => [String(r.pid), r]));
  const killed = [];
  const execWsl = async (argv) => {
    // argv is [...distroArgs, cmd, ...args]. The stub `guestExecArgs()` below ends
    // its distro selection with '--', so the command is the token after it.
    const i = argv.indexOf('--');
    const cmd = argv[i + 1];
    const args = argv.slice(i + 2);
    if (cmd === 'ps') {
      const out = [...alive.values()]
        .map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid).padStart(6)} ${r.args}`)
        .join('\n');
      return { code: 0, stdout: `${out}\n`, stderr: '', timedOut: false };
    }
    if (cmd === 'pgrep') {
      const re = new RegExp(args[args.length - 1]);
      const hits = [...alive.values()].filter((r) => re.test(r.args));
      if (hits.length === 0) return { code: 1, stdout: '', stderr: '', timedOut: false };
      return {
        code: 0,
        stdout: `${hits.map((r) => `${r.pid} ${r.args}`).join('\n')}\n`,
        stderr: '',
        timedOut: false,
      };
    }
    if (cmd === 'kill') {
      const pids = args.filter((a) => /^\d+$/.test(a));
      for (const pid of pids) { killed.push(pid); alive.delete(pid); }
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    throw new Error(`the fake guest was asked to run an unexpected command: ${cmd}`);
  };
  return { execWsl, killed, alive };
}

function liftPkill(execWsl) {
  const wedges = [];
  const fn = eval(
    `(function (execWsl, guestExecArgs, markWslWedged, sleep, console) {
       ${lifted[0]}
       return wslPkillGraceful;
     })`,
  )(
    execWsl,
    () => ['-d', 'Ubuntu', '--'],
    (why) => wedges.push(why),
    async () => {},
    { log: () => {}, warn: () => {} },
  );
  return { fn, wedges };
}

// ─────────────────────────────────────────────────────────────────────────────
// A guest mid-playback, with real orphans in it
// ─────────────────────────────────────────────────────────────────────────────
const SERVE = 100;          // the resident Listen server
const SERVE_VLLM = 101;     // its engine core — its cmdline says nothing about narrator.serve
const SERVE_VLLM_GC = 102;  // and ITS child, to prove the walk is transitive
const ORPHAN_VLLM = 200;    // a genuinely orphaned vLLM from a crashed batch worker
const ORPHAN_WORKER = 201;  // and a genuinely orphaned batch worker

const PY = '/home/telltale/anaconda3/envs/orpheus_tts/bin/python';

// The vLLM rows carry a LOWERCASE `vllm` in their command lines because the sweep's
// pattern is a pgrep -f regex and pgrep is case-sensitive. A fixture full of
// `VLLM::EngineCore` would sail past the whole sweep and prove nothing either way.
function table() {
  return [
    { pid: 1, ppid: 0, args: '/sbin/init' },
    { pid: SERVE, ppid: 1, args: `${PY} -m narrator.serve --port 8123` },
    { pid: SERVE_VLLM, ppid: SERVE, args: `${PY} -m vllm.v1.engine.core` },
    { pid: SERVE_VLLM_GC, ppid: SERVE_VLLM, args: `${PY} -m vllm.worker.worker_base` },
    { pid: ORPHAN_VLLM, ppid: 1, args: `${PY} -m vllm.v1.engine.core` },
    { pid: ORPHAN_WORKER, ppid: 1, args: `${PY} -m narrator.compat.worker --session abc` },
  ];
}

const bridgeJs = fs.readFileSync(BRIDGE, 'utf-8');
const SERVE_RE = 'narrator\\.serve';
const GLOBAL_PATTERN = 'narrator\\.compat\\.(?:worker|app)|vllm';
const OPTS = { graceMs: 2000, pollMs: 1, excludeRe: SERVE_RE };

async function main() {
  console.log('the global sweep spares the Listen server and takes the orphans');

  await check('it still reaps a genuinely orphaned vLLM and worker', async () => {
    const guest = makeGuest(table());
    const { fn } = liftPkill(guest.execWsl);
    const outcome = await fn(GLOBAL_PATTERN, OPTS);
    assert.strictEqual(outcome, 'exited', `unexpected outcome: ${outcome}`);
    assert.ok(guest.killed.includes(String(ORPHAN_VLLM)), 'the orphaned vLLM survived the sweep');
    assert.ok(guest.killed.includes(String(ORPHAN_WORKER)), 'the orphaned batch worker survived the sweep');
  });

  await check('it does NOT kill the serve process’s vLLM child', async () => {
    const guest = makeGuest(table());
    const { fn } = liftPkill(guest.execWsl);
    await fn(GLOBAL_PATTERN, OPTS);
    assert.ok(!guest.killed.includes(String(SERVE_VLLM)),
      'the sweep SIGTERM’d the Listen server’s engine core — playback stops with nothing logged');
  });

  await check('nor the grandchild — the exclusion is transitive', async () => {
    const guest = makeGuest(table());
    const { fn } = liftPkill(guest.execWsl);
    await fn(GLOBAL_PATTERN, OPTS);
    assert.ok(!guest.killed.includes(String(SERVE_VLLM_GC)),
      'a descendant two levels below narrator.serve was killed — the walk is not transitive');
  });

  await check('a sweep matching ONLY protected processes is "none", not a kill of nothing', async () => {
    const guest = makeGuest(table().filter((r) => r.pid !== ORPHAN_VLLM && r.pid !== ORPHAN_WORKER));
    const { fn } = liftPkill(guest.execWsl);
    const outcome = await fn(GLOBAL_PATTERN, OPTS);
    assert.strictEqual(outcome, 'none', `unexpected outcome: ${outcome}`);
    assert.deepStrictEqual(guest.killed, [], `it killed ${guest.killed.join(', ')}`);
  });

  await check('a guest that will not answer `ps` is unresponsive, NOT an empty exclusion', async () => {
    // Failing open here would kill the exact thing the exclusion protects, so a
    // silent guest must stop the sweep rather than proceed with nothing guarded.
    const guest = makeGuest(table());
    const { fn, wedges } = liftPkill(async (argv) => (argv.includes('ps')
      ? { code: -1, stdout: '', stderr: '', timedOut: true }
      : guest.execWsl(argv)));
    const outcome = await fn(GLOBAL_PATTERN, OPTS);
    assert.strictEqual(outcome, 'unresponsive', `unexpected outcome: ${outcome}`);
    assert.deepStrictEqual(guest.killed, [], `it killed ${guest.killed.join(', ')} with nothing guarded`);
    assert.ok(wedges.length > 0, 'the wedge was not recorded');
  });

  console.log('the caller actually asks for the exclusion');

  await check('cleanupWslOrphanedProcesses passes excludeRe: SERVE_PROCESS_RE', () => {
    // A helper CAPABLE of excluding is worth nothing if the one caller that needs it
    // does not ask. Read from the compiled bridge, so this matches what ships.
    const call = bridgeJs.match(/wslPkillGraceful\)\(pattern, \{[\s\S]{0,400}?\}\)/);
    assert.ok(call, 'the sweep no longer calls wslPkillGraceful(pattern, {...}) — did it move?');
    assert.match(call[0], /excludeRe:\s*(?:\w+\.)?SERVE_PROCESS_RE/,
      `the global sweep does not exclude the Listen server:\n${call[0]}`);
  });

  console.log('the assertions are real');

  await check('MUTATION: without excludeRe the serve tree dies', async () => {
    // If this passes with the exclusion dropped, every row above proves nothing.
    const guest = makeGuest(table());
    const { fn } = liftPkill(guest.execWsl);
    await fn(GLOBAL_PATTERN, { graceMs: 2000, pollMs: 1 });
    assert.ok(guest.killed.includes(String(SERVE_VLLM)),
      'dropping excludeRe left the serve vLLM alive — the checks above cannot see the '
      + 'regression they exist for');
  });

  console.log(failures === 0
    ? '\nThe global sweep leaves the Listen server alone.'
    : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
