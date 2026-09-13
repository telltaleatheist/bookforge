#!/usr/bin/env node
/**
 * AN AUDIOBOOK THAT NEVER REACHED THE LIBRARY IS NOT A COMPLETE REASSEMBLY.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-reassembly-registration-failure.js
 *
 * ── The defect this pins (2026-09-13) ───────────────────────────────────────
 *
 * `reassembly-bridge.ts` files the finished m4b in the project manifest, and
 * both of its failure arms — `!reg.success`, and the `catch (regErr)` around the
 * whole call — LOGGED and fell through to `resolve({ success: true, outputPath })`.
 * The m4b was on disk, `outputs.audiobook` was never set, the project page and
 * Bookshelf listed nothing, and the queue said "Reassembly complete!".
 *
 * Note the shape it had: that error log was ADDED by an earlier fix, which
 * recorded the gap instead of closing it. The promotion step twenty lines above
 * had already been through exactly this and carries the invariant in a comment —
 * "a promotion failure must NEVER report success" — one step short of the end.
 *
 * ── What must stay true ─────────────────────────────────────────────────────
 *
 *   1. `reg.skipped` is NOT a failure. It means the m4b is outside this
 *      library's projects dir, which is a legitimate place to assemble to and
 *      has nothing to file. Collapsing the two would fail every out-of-library
 *      assembly.
 *   2. Anything else — a false `success`, or a throw — resolves `success: false`
 *      NAMING the cause.
 *   3. R6: nothing is deleted on that path. The audio is good; only the filing
 *      failed, and the failure names the file so it can be re-filed.
 *
 * Rows 1 and 2's inputs are measured off the REAL `registerAudiobookOutput`, so
 * "skipped means outside the library" is a fact about the shipped code rather
 * than an assumption written into a test.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The compiled bridges reach for Electron's `app` at import time; this is the
// same shim every CLI adapter runs under.
require('../cli/electron-stub.js');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'reassembly-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

const manifestService = require(path.join(DIST, 'manifest-service.js'));

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => console.log(`  ok    ${name}`))
    .catch((err) => {
      failures++;
      console.log(`  FAIL  ${name}\n        ${err.message.split('\n').join('\n        ')}`);
    });
}

/** A source file with comments removed, so a scan reads code and not prose. */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-reg-fail-'));

async function main() {
  console.log('what the registration door actually answers');

  manifestService.setLibraryBasePath(SCRATCH);

  let skippedOutcome;
  await check('an m4b OUTSIDE the library comes back skipped, not failed', async () => {
    const outside = path.join(SCRATCH, 'elsewhere', 'output', 'a.m4b');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'x');
    skippedOutcome = await manifestService.registerAudiobookOutput(outside, { professionallyRead: false });
    assert.strictEqual(skippedOutcome.skipped, true,
      'registerAudiobookOutput stopped marking an out-of-library m4b as skipped; the bridge '
      + 'tells the two cases apart on this field alone');
  });

  let failedOutcome;
  await check('an m4b INSIDE the library with no manifest is a real failure', async () => {
    const inside = path.join(SCRATCH, 'projects', 'demo', 'output', 'a.m4b');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'x');
    failedOutcome = await manifestService.registerAudiobookOutput(inside, { professionallyRead: false });
    assert.strictEqual(failedOutcome.success, false, 'this must not report success');
    assert.notStrictEqual(failedOutcome.skipped, true,
      'a project that could not be written is NOT "outside the library" — if these two '
      + 'answers ever converge, the bridge cannot tell a lost audiobook from a legitimate one');
    assert.ok(typeof failedOutcome.error === 'string' && failedOutcome.error.length > 0,
      'and it names the cause, which is what the job must report');
  });

  console.log('and the bridge acts on the difference');

  const bridgeSource = fs.readFileSync(path.join(REPO, 'electron/reassembly-bridge.ts'), 'utf8');
  const code = codeOnly(bridgeSource);

  /**
   * The success branch of the assembly close handler: from the registration call
   * to the completion. Everything this suite asserts about control flow has to
   * be inside it, so a matching line somewhere else in a 3,000-line file cannot
   * stand in for the fix.
   */
  function successBranch(source) {
    const start = source.indexOf('registerAudiobookOutput(outputPath');
    const end = source.indexOf("resolve({ success: true, outputPath })", start);
    assert.ok(start >= 0 && end > start,
      'the assembly close handler no longer has a registration → success run to read; '
      + 'this suite must be re-anchored rather than left passing');
    return source.slice(start, end);
  }

  await check('a failed registration is CARRIED, not just logged', () => {
    const branch = successBranch(code);
    assert.ok(/registrationError = /.test(branch),
      'the `!reg.success` arm still only logs — the job resolves success with nothing filed');
    // Both arms, because the catch is the one that fires when the manifest write
    // throws, which is the case the earlier fix added a log line for.
    const assignments = branch.match(/registrationError = /g) ?? [];
    assert.ok(assignments.length >= 2,
      `both the !reg.success arm and the catch must record the failure; found ${assignments.length}`);
    assert.ok(/catch \(regErr\)[\s\S]{0,200}registrationError = /.test(branch),
      'the catch around the registration does not record the failure');
  });

  await check('and it resolves success:false BEFORE the completion', () => {
    const branch = successBranch(code);
    assert.ok(/if \(registrationError !== null\)/.test(branch),
      'nothing tests the recorded failure, so it is a variable nobody reads');
    assert.ok(/resolve\(\{ success: false, outputPath, error: msg \}\)/.test(branch),
      'the guard must resolve a FAILURE naming the file — the audio is good and where it '
      + 'is, is the whole remedy');
    assert.ok(/return;/.test(branch.slice(branch.indexOf('registrationError !== null'))),
      'the guard must return rather than fall through to the completion below it');
  });

  await check('R6: the guard deletes nothing', () => {
    const guard = (() => {
      const branch = successBranch(code);
      const at = branch.indexOf('if (registrationError !== null)');
      return branch.slice(at);
    })();
    for (const destructive of ['rmSync', 'unlink', 'cleanupStagingDir', 'rm(']) {
      assert.ok(!guard.includes(destructive),
        `the filing-failure path calls ${destructive} — the audio is good and only the `
        + 'filing failed; the promotion path above it preserves its work for the same reason');
    }
  });

  await check('reg.skipped is still the legitimate outside-the-library case', () => {
    const branch = successBranch(code);
    assert.ok(/if \(reg\.skipped\)/.test(branch), 'the skipped case is still tested FIRST');
    const skippedArm = branch.slice(branch.indexOf('if (reg.skipped)'),
      branch.indexOf('else if (!reg.success)'));
    assert.ok(!skippedArm.includes('registrationError = '),
      'a skipped registration now fails the job — every assembly outside the library would '
      + 'report failure');
  });

  console.log('the assertions are real — the old shape is caught');

  await check('MUTATION: the pre-fix branch fails every control-flow row', () => {
    // The branch exactly as it was: both arms log, neither records, and the
    // completion below is unguarded.
    const preFix = `registerAudiobookOutput(outputPath, { professionallyRead: false });
          if (reg.skipped) {
            reassemblyLog.warn('Audiobook not registered in manifest (outside library)', { jobId, outputPath });
          } else if (!reg.success) {
            reassemblyLog.error('Failed to register audiobook in manifest', { jobId, outputPath, error: reg.error });
          } else {
            reassemblyLog.info('Registered audiobook in manifest', { jobId, outputPath });
          }
        } catch (regErr) {
          reassemblyLog.error('Manifest registration threw', { jobId, error: (regErr).message });
        }
        resolve({ success: true, outputPath })`;
    const branch = successBranch(preFix);
    assert.ok(!/registrationError = /.test(branch),
      'the "carried, not just logged" row would have passed the pre-fix code');
    assert.ok(!/if \(registrationError !== null\)/.test(branch),
      'the "resolves success:false" row would have passed the pre-fix code');
  });

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(failures === 0
    ? '\nAll reassembly registration checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
