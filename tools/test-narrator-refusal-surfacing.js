#!/usr/bin/env node
/**
 * A REFUSAL THE USER CAN READ.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narrator-refusal-surfacing.js
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * narrator refuses on STDOUT. `compat/app.py` prints `Error: <message>` and the
 * `FlagRefused` text with `print(..., flush=True)`, and the result dict carrying
 * `"success": false, "error": ...` goes there too; stderr gets tracebacks and
 * library chatter. Every error path in `parallel-tts-bridge.ts` read `stderr`
 * alone, so a job that was refused reached the user as:
 *
 *     Prep failed with code 1:
 *
 * — the reason sitting unread in a buffer, and nothing anywhere saying what to
 * fix. That is worse than a crash: a crash has a stack.
 *
 * ── Why this runs a real python ─────────────────────────────────────────────
 *
 * A fixture would encode my belief about which stream narrator uses, and that
 * belief is exactly what was wrong. So it drives a REAL refusal through a REAL
 * narrator in the tools env, captures both streams as they actually arrive, and
 * pushes them through the bridge's own compiled `spawnFailureDetail`.
 *
 * NOT a keeper in run-keepers: it needs a python env with narrator importable.
 * It IS cheap (no model, no GPU) and should be run whenever an error path moves.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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
    app: { getAppPath: () => REPO, getPath: () => os.tmpdir(), isPackaged: false },
    BrowserWindow: class {},
  },
};
const paths = require(path.join(DIST, 'e2a-paths.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));

/**
 * THE WORKER DOOR RUNS IN THE TOOLS ENV HERE, and only here.
 *
 * A refusal is decided by narrator's flag parser before any engine is
 * constructed, so it needs no torch and no vLLM — but the real worker door
 * resolves the Orpheus environment, which on a Windows machine rendering through
 * WSL does not exist natively at all (it refuses by name, correctly). Pointing it
 * at the tools env keeps the ARGV and the ERROR PATH real, which is what is under
 * test, without demanding a 6 GB environment to prove a string reaches a log.
 */
function stub(mod, name, fn) {
  const d = Object.getOwnPropertyDescriptor(mod, name);
  if (d && d.get) Object.defineProperty(mod, name, { value: fn, configurable: true, enumerable: true });
  else mod[name] = fn;
}
stub(toolPaths, 'shouldUseWsl2ForOrpheus', () => false);
const toolsPython = paths.getPythonInvocation(paths.getDefaultE2aPath());
stub(paths, 'getPythonInvocation', () => toolsPython);

const spawnMod = require(path.join(DIST, 'narrator-spawn.js'));

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
 * The bridge's OWN helper, lifted out of the compiled file.
 *
 * Not re-implemented and not imported: importing `parallel-tts-bridge.js` pulls
 * in Electron, the GPU arbiter and the manifest service, none of which a string
 * function needs. Lifting the source means an edit to the helper is an edit to
 * what this tests.
 */
const bridgeJs = fs.readFileSync(path.join(DIST, 'parallel-tts-bridge.js'), 'utf-8');
const helperSrc = bridgeJs.match(/function spawnFailureDetail[\s\S]*?\n}\n/);
if (!helperSrc) {
  console.error('spawnFailureDetail is not in the compiled bridge — did the error paths change shape?');
  process.exit(1);
}
const spawnFailureDetail = eval(`${helperSrc[0]}; spawnFailureDetail`);

// ─────────────────────────────────────────────────────────────────────────────
// Drive real refusals
// ─────────────────────────────────────────────────────────────────────────────

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-refusal-'));

/** Run a narrator door through the app's own plan builder and capture both streams. */
function refuse(what, { phase, engine, args }) {
  const plan = spawnMod.buildNarratorSpawn({
    engine, phase, args, envExtras: { E2A_TMP_DIR: SCRATCH }, cwdHint: REPO,
  });
  const r = spawnSync(plan.command, plan.args, {
    cwd: plan.cwd, env: plan.env, encoding: 'utf-8', timeout: 180000,
  });
  return {
    what,
    status: r.status,
    stdout: (r.stdout || ''),
    stderr: (r.stderr || ''),
    plan,
  };
}

// AN ENGINE THE SPAWN AND THE ARGV DISAGREE ABOUT. Passing `--tts_engine higgs`
// on a plan built for orpheus is exactly what a stale session-state.json produces,
// and narrator refuses it rather than picking one — which is the refusal a real
// user hits, and it is NOT the one I expected when writing this (I predicted the
// near-miss "'higgs' is not a registry id"; the disagreement check fires first).
// Left as the real message, because a test that asserts the refusal I imagined is
// the same mistake as a fixture.
const nearMiss = refuse('an engine the argv and the spawn disagree about', {
  engine: 'orpheus', phase: 'worker',
  args: ['--session', 'x', '--session_dir', path.join(SCRATCH, 'nope'),
         '--sentences_dir', path.join(SCRATCH, 'nope'),
         '--tts_engine', 'higgs', '--sentence_start', '0', '--sentence_end', '1'],
});

// Assembly without the flag narrator will not guess.
const noSessionDir = refuse('assembly with no --session_dir', {
  phase: 'assembly',
  args: ['--headless', '--session', 'x', '--output_dir', SCRATCH, '--assemble_only'],
});

// A session directory that is not one.
const badSession = refuse('resume of a directory that is not a session', {
  phase: 'resume',
  args: ['--headless', '--resume_session', path.join(SCRATCH, 'not-a-session')],
});

const CASES = [
  { r: nearMiss, mustSay: /--tts_engine higgs disagrees with NARRATOR_ENGINE/i },
  { r: noSessionDir, mustSay: /--session_dir/ },
  { r: badSession, mustSay: /not found|No session|session-state/i },
];

console.log('narrator refuses on STDOUT, which is the whole point');
for (const { r, mustSay } of CASES) {
  check(`${r.what}: the reason is on stdout`, () => {
    assert.match(r.stdout, mustSay,
      `stdout did not carry the refusal.\n  stdout: ${r.stdout.trim().slice(-400)}`
      + `\n  stderr: ${r.stderr.trim().slice(-400)}`);
  });
  check(`${r.what}: a stderr-ONLY reader gets nothing usable`, () => {
    // The regression, stated as a test: the bridge used to build its job-log detail
    // from stderr alone, and a refusal printed on stdout reached the user as a bare
    // exit code. So this asks the shipped helper what a stderr-only reader would
    // have produced, and requires that it does NOT name the problem.
    //
    // This row spent the branch as `assert.ok(true)` — it printed `ok` for three
    // cases whatever narrator did. If it ever fails because the reason genuinely
    // appears on stderr too, DELETE it; do not restore the stderr-only read.
    const stderrOnly = spawnFailureDetail('', r.stderr, 1200);
    assert.doesNotMatch(stderrOnly || '', mustSay,
      `stderr alone already names the problem, so this row no longer pins anything:`
      + `\n  ${(stderrOnly || '(empty)').slice(0, 300)}`);
  });
}

console.log('the bridge surfaces it');
for (const { r, mustSay } of CASES) {
  check(`${r.what}: spawnFailureDetail carries the reason`, () => {
    const detail = spawnFailureDetail(r.stdout, r.stderr, 1200);
    assert.ok(detail, 'the helper produced an empty detail from a real refusal');
    assert.match(detail, mustSay,
      `the surfaced detail does not name the problem:\n  ${detail}`);
  });
  check(`${r.what}: the detail is ONE line, fit for a job log`, () => {
    const detail = spawnFailureDetail(r.stdout, r.stderr, 1200);
    assert.ok(!detail.includes('\n'), 'a traceback\'s newlines survived into the message');
  });
}

console.log('and the messages the user sees are built from it');
check('every error path in the bridge reads BOTH streams', () => {
  // The four doors named in the review. Asserted on the source because the
  // alternative is driving four Electron-bound async functions, and what went
  // wrong was a missing argument, which source shows exactly.
  const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');
  const calls = src.match(/spawnFailureDetail\([^)]*\)/g) || [];
  assert.ok(calls.length >= 4,
    `expected the four doors (prep, worker, assembly, retake) to call it; saw ${calls.length}`);
  for (const call of calls) {
    assert.ok(!/^spawnFailureDetail\(\s*''/.test(call),
      `a door passes an empty stdout tail: ${call}`);
  }
  // And none of them may go back to a bare stderr interpolation.
  assert.ok(!/Prep failed with code \$\{code\}: \$\{stderr\}/.test(src),
    'the prep door is back to interpolating stderr alone');
});

check('the helper prefers stdout over stderr', () => {
  assert.strictEqual(spawnFailureDetail('the reason', 'noise'), 'the reason');
  assert.strictEqual(spawnFailureDetail('', 'only stderr'), 'only stderr');
  assert.strictEqual(spawnFailureDetail('', ''), '');
});

fs.rmSync(SCRATCH, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll refusal-surfacing checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
