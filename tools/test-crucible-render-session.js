#!/usr/bin/env node
/**
 * A RENDER ON A CRUCIBLE SERVER NEVER ENTERS WSL — not its prep, not its session,
 * not a copy out of it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-crucible-render-session.js
 *
 * ── The defect this pins (2026-09-14, 01:50) ────────────────────────────────
 *
 * `bookforge-tts --tts --engine higgs --voice deathstalker --crucible-server mac`
 * rendered its chunks on the Mac's Crucible correctly, then FAILED. The session
 * had been created inside the WSL guest — `prepareSession` asked `jobRunsInWsl`,
 * which answers for the ENGINE, and the Higgs engine's env is a guest env — so
 * the artifacts were downloaded into a `\\wsl$` path and a normaliser then had to copy the whole session onto the
 * scratch root. The scratch root was `<library>/tmp` on the NAS share (Z:) then
 * (it is machine-local since 2026-09-21), the
 * guest's `/mnt/z` was a stale root-owned mount point that `test -d` called
 * "mounted", and the copy died on `mkdir: cannot create directory
 * '/mnt/z/bookforge': Permission denied`. After a finished render.
 *
 * ── The rule now, and what this suite measures of it ────────────────────────
 *
 * When the generation venue is a Crucible server (any server, `local` included):
 *
 *  1. No venue, engine or toggle can place a render in the guest: the bridge has no branch that could.
 *  2. `newSessionDir` places the session on a host-native path under the stated scratch root.
 *  3. Prep is TypeScript: `prepareSession` asks no Python.
 *  4. The scratch-root refusal — `narratorScratchRoot()` naming the "Narrator
 *     scratch folder" setting — has its sentence pinned.
 *
 * No GPU, no model, no WSL call.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'parallel-tts-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}
// The bridge's component system reads dist/electron/data at import time and
// `tsc` does not copy it (the precedent is tools/test-cli-narration-prep.js).
if (!fs.existsSync(path.join(DIST, 'data', 'rvc-voice-assets.json'))) {
  console.error(
    'dist/electron/data/rvc-voice-assets.json is missing — this suite loads the whole bridge, '
    + 'which reads it at import.\n  npx tsc -p tsconfig.electron.json && npx shx cp -r electron/data dist/electron/');
  process.exitCode = 1;
  return;
}

// ─────────────────────────────────────────────────────────────────────────────
// A userData of our own, a fake tools env, and a config with BOTH WSL toggles on
// ─────────────────────────────────────────────────────────────────────────────
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-crucible-session-'));
const USER_DATA = path.join(WORK, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });
process.env.BOOKFORGE_USER_DATA = USER_DATA;      // cli/electron-stub.js honours this
process.env.BOOKFORGE_USERDATA_DIR = USER_DATA;   // managed-bins resolves its root at import

/** A tools env that exists as a directory but whose python is NOT a python. */
const FAKE_TOOLS_ENV = path.join(WORK, 'tools-env');
const fakePython = process.platform === 'win32'
  ? path.join(FAKE_TOOLS_ENV, 'python.exe')
  : path.join(FAKE_TOOLS_ENV, 'bin', 'python');
fs.mkdirSync(path.dirname(fakePython), { recursive: true });
fs.writeFileSync(fakePython, '');
process.env.BOOKFORGE_TOOLS_ENV = FAKE_TOOLS_ENV;

// The Higgs toggle ON: the strongest form of the claim is that a Crucible-venue run
// stays native on a machine where the engine would otherwise go to the guest.
// `wslCondaPath` is what `getWslSessionsRoot` derives the guest root from.
fs.writeFileSync(path.join(USER_DATA, 'tool-paths.json'), JSON.stringify({
  useWsl2ForHiggs: true,
  wslDistro: 'Ubuntu',
  wslCondaPath: '/home/keeper/anaconda3/bin/conda',
}, null, 2));

require(path.join(REPO, 'cli', 'electron-stub.js'));

const narratorPaths = require(path.join(DIST, 'narrator-paths.js'));
const SCRATCH = path.join(WORK, 'scratch');
narratorPaths.setNarratorScratchRoot(SCRATCH);
const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));

const ON_WINDOWS = process.platform === 'win32';
const GUEST_ROOT = '/home/keeper/bookforge-sessions';

const CRUCIBLE = { where: 'crucible', server: 'mac', because: 'the caller named it' };
const LOCAL = { where: 'crucible', server: 'local', because: 'the first enabled server that answered' };

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(err && err.message).split('\n').join('\n        ')}`);
    process.exitCode = 1;
  }
}
const isUnc = (p) => /^\\\\wsl[$.]/i.test(p) || /^\/\/wsl[$.]/i.test(p);

// ─────────────────────────────────────────────────────────────────────────────
// Lifted out of the compiled bridge (the technique tools/test-worker-completion-throw.js
// and tools/test-assembly-after-wsl-normalize.js established)
// ─────────────────────────────────────────────────────────────────────────────
const bridgeJs = fs.readFileSync(path.join(DIST, 'parallel-tts-bridge.js'), 'utf-8');
function lift(name) {
  const m = bridgeJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`));
  if (!m) throw new Error(`${name} is not in the compiled bridge — did it move?`);
  return m[0];
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('1. no render can enter the guest, whatever the toggles say');

  /*
   * THIS SECTION USED TO BE A CONTRAST between a Crucible venue and the legacy one, and then a
   * `prepRunsInWsl` that answered false for every venue. Both are gone: there is no question left
   * to ask, so what is pinned is that the question does not come back.
   */
  await check('the bridge has no branch that places a session in the guest', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    for (const name of ['prepRunsInWsl', 'sessionHomeFor', 'sessionRunsInWsl', 'jobRunsInWsl', 'getWslSessionsRoot', 'shouldUseWsl2ForHiggs']) {
      assert.ok(!new RegExp(`\\b${name}\\(`).test(src), `${name} is back in the bridge`);
    }
  });

  console.log('2. where the session is created');

  const ID = 'ccd14111-da29-4fb0-a489-a19a0f126bac';
  await check('a Crucible-venue session is host-native under the stated scratch root', () => {
    const dir = bridge.newSessionDir(ID);
    assert.strictEqual(dir, path.join(SCRATCH, `ebook-${ID}`), dir);
    assert.ok(!isUnc(dir) && !dir.startsWith('/'), `not a host path: ${dir}`);
    assert.ok(fs.existsSync(SCRATCH), 'the scratch root was not created');
  });

  // Sections 3 and 4 LEFT IN STEP 8 (2026-11-05) with the spawn they drove, dropped by name: "onHost builds a
  // native prep in the TOOLS env", "the same request WITHOUT onHost is the guest spawn", "onHost is refused by
  // name on a phase that loads the model", "onHost and wslCondaEnv together are refused", "a tools env whose
  // python is not a python is refused naming the interpreter", "this machine's tools env can prep".
  // Prep is TypeScript now, and needs no tools env.
  await check('prepareSession asks no Python, and the local doctor is not back', () => {
    /*
     * It used to assert a two-armed branch: `hostPrepRefusal` on the Crucible
     * side and the Higgs DOCTOR on the legacy one. The doctor is deleted with the
     * local environment it examined — the engine runs on a Crucible server, which
     * answers for its own environment. `hostPrepRefusal` went at the flip (step 7):
     * prep is TypeScript, so a machine with no tools env prepares a book as well as any.
     */
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const at = src.indexOf('export async function prepareSession(');
    const body = src.slice(at, src.indexOf('const sessionDirForReading = newSessionDir(', at));
    assert.ok(!/hostPrepRefusal/.test(body),
      'prepareSession asks about a Python again, and prep needs none');
    assert.ok(!/higgsEnvironmentRefusal/.test(body),
      'the local Higgs doctor is back in prepareSession — that question belongs to the '
      + 'server that will run the engine, not to this machine');
  });

  /*
   * SECTION 5 STOOD HERE AND ITS SUBJECT IS DELETED.
   *
   * It drove the SHIPPED completion tail and proved it did not call
   * `normalizeWslSessionToWindows` for a Crucible-venue session, with a mutation
   * arm proving the recorder could see the call at all, and a third check that
   * the normaliser refused such a session BY NAME.
   *
   * `normalizeWslSessionToWindows` no longer exists: it copied a finished session
   * out of the guest onto Windows, and nothing renders in the guest. The defect
   * it guarded — a render bound for the Mac writing its session to ext4 and then
   * dying on the copy back out — cannot be reconstructed, because the branch that
   * placed a session in the guest is gone with it. Section 1 above now asserts
   * that directly and unconditionally, which is the stronger form.
   */

  console.log('6. the scratch-root refusal names the setting a person can fix');

  await check('narratorScratchRoot() refuses an unmounted root naming "Narrator scratch folder"', () => {
    const gone = path.join(WORK, 'no-such-volume', 'tmp');
    narratorPaths.setNarratorScratchRoot(gone);
    try {
      assert.throws(() => narratorPaths.narratorScratchRoot(),
        (err) => err.message.includes(gone) && /Narrator scratch folder/.test(err.message) && /not mounted/.test(err.message));
      narratorPaths.setNarratorScratchRoot(null);
      assert.throws(() => narratorPaths.narratorScratchRoot(),
        /No narrator scratch root has been stated[\s\S]*Narrator scratch folder[\s\S]*narrator-sessions-root\.js/);
    } finally {
      narratorPaths.setNarratorScratchRoot(SCRATCH);
    }
  });

  console.log('7. nothing else in a Crucible-venue run enters the guest');

  await check('no teardown enters the guest', () => {
    /*
     * This used to ask that every guest gate read the venue (`sessionRunsInWsl`). The gates are gone
     * with what they guarded: no session is in the guest, so Stop and quit have no guest arm.
     */
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    assert.ok(!/from '\.\/wsl-lifecycle'/.test(src), 'the bridge reaches for the guest teardown again');
    assert.ok(!/destroyWslSessionWorkers|killWslWrapper/.test(src), 'a guest teardown is back');
  });

  await check('every door that PREPS decides the venue first and hands it to prepareSession', () => {
    /*
     * THE DOORS CHANGED ON 2026-09-19, THE RULE DID NOT.
     *
     * `prepareSession` is handed a venue because the venue decides what the
     * chunks are packed TO — the rendering machine's `max_chars` and pace block
     * off `GET /v1/voices`, never this machine's catalog. (It also used to
     * decide where the session was CREATED; that half is moot now, since every
     * venue is a Crucible and every session is host-native.)
     *
     * Owen split the prep off into its own CPU row that evening, so the doors
     * that prep are `packWithHandle` — which both the `prepare` queue row and
     * `startParallelConversion`'s inline compatibility arm reach through
     * `packSessionForNarration` — and `renderRangeHeadless`, the CLI's, which
     * preps inline by design. `startParallelConversion` itself no longer preps:
     * handed a packed session, it reads the chunks off disk.
     *
     * AND IT IS ASKED EARLIER STILL SINCE THE PARK LANDED (2026-09-19, second
     * pass): the queue's door resolves venue AND band through
     * `bandThisPrepPacksTo` before it cuts the narration copy, because a
     * prepare row now PARKS when no machine will state the band
     * (`crucible/prep-band.ts`) and a parked pass that had already cut a copy
     * and swept this book's scratch sessions would pay that price once per
     * queue pass for as long as the machines are off.
     */
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    for (const [name, decidedBy] of [
      ['async function packWithHandle(', 'await bandThisPrepPacksTo('],
      ['async function renderRangeHeadless(', 'await decideGenerationVenue('],
    ]) {
      const at = src.indexOf(name);
      assert.ok(at > 0, `${name} not found`);
      const body = src.slice(at, at + 12000);
      const decide = body.indexOf(decidedBy);
      const prep = body.indexOf('await prepareSession(');
      assert.ok(decide > 0 && prep > 0 && decide < prep,
        `${name} preps before it knows whose numbers to pack to`);
    }
    // The CLI reads the band the plain way — it has no queue row to park — but
    // it still reads it BEFORE it preps, for the same reason.
    const cli = src.slice(src.indexOf('async function renderRangeHeadless('));
    assert.ok(cli.indexOf('await venueBandForPrep(') > 0
      && cli.indexOf('await venueBandForPrep(') < cli.indexOf('await prepareSession('),
      'the headless door preps without the venue\'s band');
    // And the queue's door asks the machines BEFORE it cuts the narration copy:
    // a park must cost one ping sweep, not a copy and a sweep.
    const queueDoor = src.slice(src.indexOf('async function packWithHandle('));
    assert.ok(queueDoor.indexOf('await bandThisPrepPacksTo(')
      < queueDoor.indexOf('await prepareNarrationInput('),
      'the queue\'s prep cuts the narration copy before it knows whether any machine will '
      + 'state the band — which is the whole cost of a park, paid on every queue pass');
    // And exactly one door spawns the prep, so a third could not appear with a
    // venue decided somewhere else.
    const spawns = src.match(/await prepareSession\(/g) || [];
    assert.strictEqual(spawns.length, 2,
      `prepareSession is called ${spawns.length} time(s): the shared prep half and the CLI's `
      + 'headless door. A third caller must decide the venue first, for the same reason.');
  });

  await check('the copy-out probe asks mountpoint, not test -d (a stale mount point is a directory)', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const at = src.indexOf('async function wslSeesDrive(');
    const body = src.slice(at, at + 2000);
    assert.ok(/const probe = `mountpoint -q \$\{windowsToWslPath\(/.test(body),
      'the probe is not mountpoint -q asked about the one converter for its mount point');
    assert.ok(!/const probe = `test -d/.test(body), 'test -d is back');
  });

  try {
    fs.rmSync(WORK, { recursive: true, force: true });
  } catch { /* a temp dir that will not go is not a test failure */ }

  console.log(`\ncrucible-render-session: ${passed} check(s) passed`
    + (failures.length ? `, ${failures.length} FAILED: ${failures.join(', ')}` : ''));
})().catch((err) => {
  console.error('crucible-render-session: the suite itself failed:', err);
  process.exitCode = 1;
});
