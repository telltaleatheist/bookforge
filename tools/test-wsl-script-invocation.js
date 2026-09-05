#!/usr/bin/env node
/**
 * `wsl.exe` MUST BE GIVEN `--exec` WHEN IT IS HANDED A SHELL SCRIPT.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-wsl-script-invocation.js
 *
 * ── The bug this exists for, measured on owens-pc 2026-09-05 ────────────────
 *
 * The Higgs doctor reported BOTH site-packages patches as "was not found in
 * /home/telltale/anaconda3/envs/higgs3" on a machine where the files were
 * present AND correctly patched — sentinel marker present, `[:, :-1]` absent,
 * sha 0b36f650, the certifying server's own file. Nothing was wrong with the
 * env. The probe could not see it.
 *
 * Isolated through the SAME `spawn('wsl.exe', args)` the doctor uses:
 *
 *   ['-d','Ubuntu','bash','-c','f=hi; echo f=$f']          -> "f="     WRONG
 *   ['-d','Ubuntu','--','bash','-c','f=hi; echo f=$f']     -> "f="     WRONG
 *   ['-d','Ubuntu','--exec','bash','-c','f=hi; echo f=$f'] -> "f=hi"   right
 *
 * Without `--exec`, wsl.exe runs the command line through the distro's DEFAULT
 * SHELL first, and that shell expands every `$` before `bash -c` sees the
 * script. A variable the script assigns to ITSELF is unset out there, so it
 * expands to empty. The doctor's probe is
 * `f=$(ls <glob> | head -1); if [ -n "$f" ] …`, so it always took the "absent"
 * branch — and a doctor that calls a good environment broken sends someone to
 * run Install/Repair over a working install, which on this box would have
 * overwritten the patched file the live certificate is bound to.
 *
 * `--` IS NOT THE FIX, which is the obvious guess and was measured wrong: it
 * only stops wsl.exe parsing the rest as its own options. `--exec` (`-e`) is
 * the flag that means "no shell".
 *
 * ── What this keeper does ──────────────────────────────────────────────────
 *
 * Two halves, because one of them cannot run everywhere:
 *
 *   SHAPE   `wslScriptArgs` — the one builder every script-bearing wsl.exe call
 *           goes through — puts `--exec` before the script. Pure, runs on any
 *           host. Deleting the flag fails HERE, on every machine.
 *   LIVE    on win32 with a real wsl.exe, the builder's argv is SPAWNED with a
 *           probe script that assigns a variable and reads it back. This is the
 *           half that would have caught the original bug, and it is skipped BY
 *           NAME elsewhere rather than quietly passing.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'tool-paths.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

// tool-paths.js requires('electron'); the CLI's headless shim is the same one
// the doctor is driven with by hand.
require(path.join(REPO, 'cli', 'electron-stub.js'));
const toolPaths = require(path.join(DIST, 'tool-paths.js'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err && err.message}`);
  }
}

/** A script that can only answer correctly if no outer shell ate its `$`. */
const PROBE = 'f=hi; echo f=$f';

console.log('the wsl.exe script argv');

check('wslScriptArgs puts --exec BEFORE the script', () => {
  const args = toolPaths.wslScriptArgs('Ubuntu', PROBE);
  assert.deepStrictEqual(args, ['-d', 'Ubuntu', '--exec', 'bash', '-c', PROBE]);
  assert.ok(args.indexOf('--exec') < args.indexOf('-c'),
    'the flag arrives after the script, by which time the shell has already run');
});

check('with no distro it still carries --exec', () => {
  assert.deepStrictEqual(toolPaths.wslScriptArgs(undefined, PROBE),
    ['--exec', 'bash', '-c', PROBE]);
});

check('`--` is NOT used in place of --exec', () => {
  // Measured: `--` leaves the default shell in the path and the probe still
  // reads back empty. It is the plausible-looking fix, so it is refused by name.
  const args = toolPaths.wslScriptArgs('Ubuntu', PROBE);
  assert.ok(!args.includes('--'),
    '`--` stops wsl.exe parsing its own options; it does NOT skip the shell');
});

// ─────────────────────────────────────────────────────────────────────────────
// LIVE — win32 with a real wsl.exe, skipped BY NAME anywhere else
// ─────────────────────────────────────────────────────────────────────────────
function liveSkipReason() {
  if (process.platform !== 'win32') {
    return `not win32 (${process.platform}) — there is no wsl.exe to drive`;
  }
  const probe = spawnSync('wsl.exe', ['--status'], { encoding: 'utf-8', windowsHide: true });
  if (probe.error) return `wsl.exe did not run (${probe.error.message})`;
  return null;
}

const skip = liveSkipReason();
if (skip) {
  console.log(`  --  SKIPPED (live): ${skip}`);
} else {
  const runWsl = (args) => {
    const r = spawnSync('wsl.exe', args, {
      encoding: 'utf-8', windowsHide: true, timeout: 30000,
    });
    return { out: (r.stdout || '').replace(/\0/g, '').trim(), status: r.status };
  };

  check('LIVE: the builder’s argv runs a script that reads its own variable', () => {
    // The whole bug in one assertion. If this reads "f=", every `$` in every
    // probe script is being eaten before bash sees it.
    const { out, status } = runWsl(toolPaths.wslScriptArgs(undefined, PROBE));
    assert.strictEqual(status, 0, `wsl.exe exited ${status}`);
    assert.strictEqual(out, 'f=hi',
      `the script read back ${JSON.stringify(out)} — its own variable was expanded away ` +
      'by the distro’s default shell before bash ran it');
  });

  check('LIVE: a command SUBSTITUTION assigned to a variable survives too', () => {
    // The doctor's actual shape: `f=$(ls … | head -1); if [ -n "$f" ] …`.
    const script = 'f=$(echo hi); if [ -n "$f" ]; then echo got=$f; else echo empty; fi';
    const { out } = runWsl(toolPaths.wslScriptArgs(undefined, script));
    assert.strictEqual(out, 'got=hi', `the doctor-shaped probe read back ${JSON.stringify(out)}`);
  });

  check('LIVE: without the flag the SAME script reads back empty', () => {
    // Not a requirement on wsl.exe — a statement of what the flag is doing. If
    // this ever stops being true the flag has become harmless, not wrong, so
    // this reports rather than dictates: it fails only if the bare form starts
    // agreeing, which would mean the two checks above prove nothing.
    const bare = ['bash', '-c', PROBE];
    const { out } = runWsl(bare);
    console.log(`      (bare, no --exec: ${JSON.stringify(out)})`);
    assert.notStrictEqual(out, 'f=hi',
      'the bare form now works too — wsl.exe changed, and the checks above no ' +
      'longer demonstrate what --exec is for. Re-measure before trusting them.');
  });
}

console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
