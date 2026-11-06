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
 * A KEEPER since 2026-09-13. It needs a python env with narrator importable, and
 * that used to be the reason it was left out of run-keepers — which is how it
 * came to crash on import and run ZERO checks for a month with nothing saying so.
 * It is listed now and SKIPS BY NAME where the env is absent. It is cheap (no
 * model, no GPU) and should also be run by hand whenever an error path moves.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');


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

/*
 * A real refusal through the real door, in a process of its own so this file stays synchronous. Since step 8
 * the door is `startPrep`, in TypeScript: the Python doors this file used to drive are deleted.
 */
function refuse(what, ebook, ttsEngine) {
  const request = { ebook, sessionDir: path.join(SCRATCH, 'session'), options: { session: 'x', language: 'en', ttsEngine, higgsVoice: 'v', maxChars: 800, floorChars: 500 } };
  const script = `const { startPrep } = require(${JSON.stringify(path.join(DIST, 'narrator', 'text', 'prep-door.js'))});
    const child = startPrep(${JSON.stringify(request)});
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('close', (code) => { process.exitCode = code; });`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 60000 });
  return { what, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const notEpub = path.join(SCRATCH, 'a.txt');
fs.writeFileSync(notEpub, 'x');
const orpheus = refuse('an engine prep does not serve', notEpub, 'orpheus');
const noSessionDir = refuse('a book that is not an EPUB', notEpub, 'higgs-v3');

const CASES = [
  { r: orpheus, mustSay: /narrator preps for \['higgs-v3'\], not 'orpheus'/ },
  { r: noSessionDir, mustSay: /reads EPUB only, not '\.txt'/ },
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
  /*
   * TWO DOORS NOW, not four. `worker` and `retake` were the LOCAL narrator
   * spawn and are deleted (docs/LEGACY-REMOVAL.md); what is left that this app
   * still spawns is PREP (host-native, for a Crucible render) and ASSEMBLY.
   *
   * Asserted on the source because the alternative is driving Electron-bound
   * async functions, and what went wrong was a missing ARGUMENT, which source
   * shows exactly. The definition line is excluded so the count is of CALLERS —
   * counting it was what made this read 3 against a floor of 4.
   */
  const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf-8');
  const calls = (src.match(/spawnFailureDetail\([^)]*\)/g) || [])
    .filter((c) => !/^spawnFailureDetail\(stdoutTail/.test(c));
  assert.strictEqual(calls.length, 2,
    `expected the two surviving doors (prep, assembly) to call it; saw ${calls.length}. `
    + 'A THIRD would mean something started spawning locally again.');
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
