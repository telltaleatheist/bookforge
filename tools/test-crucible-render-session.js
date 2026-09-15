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
 * the artifacts were downloaded into a `\\wsl$` path and
 * `normalizeWslSessionToWindows` then had to copy the whole session onto the
 * scratch root. The scratch root is `<library>/tmp` on the titan share (Z:), the
 * guest's `/mnt/z` was a stale root-owned mount point that `test -d` called
 * "mounted", and the copy died on `mkdir: cannot create directory
 * '/mnt/z/bookforge': Permission denied`. After a finished render.
 *
 * ── The rule now, and what this suite measures of it ────────────────────────
 *
 * When the generation venue is a Crucible server (any server, `local` included):
 *
 *  1. `prepRunsInWsl(venue, engine)` is false whatever the engine's WSL toggle
 *     says — driven here through the REAL config reader with both toggles on.
 *  2. `sessionHomeFor` places the session on a host-native path under the stated
 *     scratch root; the legacy venue, same toggles, same engine, goes to the
 *     guest exactly as before — so the venue is provably the ONE thing deciding.
 *  3. The prep spawn is built `onHost`: native arm, the TOOLS env's python,
 *     `-m narrator.compat.app`, never `wsl.exe`. Refused by name on any other
 *     phase and when combined with a guest env.
 *  4. `hostPrepRefusal` MEASURES the tools env before anything spawns — against
 *     the real one where this machine has it, and against a python that is not
 *     one, which must refuse naming the interpreter.
 *  5. The SHIPPED completion tail, lifted from the compiled bridge, does NOT call
 *     `normalizeWslSessionToWindows` for a Crucible-venue session, and the
 *     normaliser refuses such a session by name if anything hands it one.
 *  6. The scratch-root refusal — `narratorScratchRoot()` naming the "Narrator
 *     scratch folder" setting — is reached BEFORE a legacy WSL prep spawns, and
 *     its sentence is pinned.
 *
 * No GPU, no model, no WSL call: the fake tools env is a directory with an
 * empty `python.exe`, and the one real spawn (item 4) is a CPU import probe.
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

// Both toggles ON: the strongest form of the claim is that a Crucible-venue run
// stays native on a machine where BOTH engines would otherwise go to the guest.
// `wslCondaPath` is what `getWslSessionsRoot` derives the guest root from.
fs.writeFileSync(path.join(USER_DATA, 'tool-paths.json'), JSON.stringify({
  useWsl2ForOrpheus: true,
  useWsl2ForHiggs: true,
  wslDistro: 'Ubuntu',
  wslCondaPath: '/home/keeper/anaconda3/bin/conda',
}, null, 2));

require(path.join(REPO, 'cli', 'electron-stub.js'));

const narratorPaths = require(path.join(DIST, 'narrator-paths.js'));
const narratorSpawn = require(path.join(DIST, 'narrator-spawn.js'));
const SCRATCH = path.join(WORK, 'scratch');
narratorPaths.setNarratorScratchRoot(SCRATCH);
const bridge = require(path.join(DIST, 'parallel-tts-bridge.js'));

const ON_WINDOWS = process.platform === 'win32';
const GUEST_ROOT = '/home/keeper/bookforge-sessions';

const CRUCIBLE = { where: 'crucible', server: 'mac', because: 'the caller named it' };
const LOCAL = { where: 'crucible', server: 'local', because: 'the top-ranked server' };

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
   * THIS SECTION USED TO BE A CONTRAST. It drove `prepRunsInWsl` with a Crucible
   * venue and with the LEGACY one and showed that only the venue moved the
   * answer. The legacy venue is deleted (docs/LEGACY-REMOVAL.md), so there is
   * nothing to contrast with — and what is left is the stronger statement: with
   * BOTH WSL toggles on and either engine named, no venue this app can construct
   * preps in the guest, because there is only one kind of venue left.
   */
  await check('prepRunsInWsl is false for every venue, both engines, both toggles on', () => {
    for (const venue of [CRUCIBLE, LOCAL]) {
      for (const engine of ['higgs', 'orpheus']) {
        assert.strictEqual(bridge.prepRunsInWsl(venue, engine), false,
          `${engine} on crucible "${venue.server}" would prep in the guest`);
      }
    }
  });

  console.log('2. where the session is created');

  const ID = 'ccd14111-da29-4fb0-a489-a19a0f126bac';
  await check('a Crucible-venue session is host-native under the stated scratch root', () => {
    for (const venue of [CRUCIBLE, LOCAL]) {
      for (const engine of ['higgs', 'orpheus']) {
        const home = bridge.sessionHomeFor(venue, engine, ID);
        assert.strictEqual(home.inGuest, false, `${engine}/${venue.server}: placed in the guest`);
        assert.strictEqual(home.sessionDir, path.join(SCRATCH, `ebook-${ID}`),
          `${engine}/${venue.server}: ${home.sessionDir}`);
        assert.strictEqual(home.sessionDirForReading, home.sessionDir,
          'a native session is read where it is written');
        assert.ok(!isUnc(home.sessionDir) && !home.sessionDir.startsWith('/'),
          `${engine}/${venue.server}: not a host path: ${home.sessionDir}`);
      }
    }
    assert.ok(fs.existsSync(SCRATCH), 'the scratch root was not created');
  });

  console.log('3. the prep spawn is built on the host');

  await check('onHost builds a native prep in the TOOLS env: no wsl.exe, narrator.compat.app', () => {
    const plan = narratorSpawn.buildNarratorSpawn({
      engine: 'higgs', phase: 'prep', args: ['--prep_only', '--session', ID], envExtras: { X: '1' }, onHost: true,
    });
    assert.strictEqual(plan.viaWsl, false, 'the plan crosses into WSL');
    assert.notStrictEqual(plan.command, 'wsl.exe');
    assert.strictEqual(plan.command, fakePython, `not the tools env's python: ${plan.command}`);
    const at = plan.args.indexOf('-m');
    assert.ok(at >= 0 && plan.args[at + 1] === 'narrator.compat.app', `argv: ${plan.args.join(' ')}`);
    assert.ok(plan.args.includes('--prep_only') && plan.args.includes(ID));
    assert.strictEqual(plan.env.NARRATOR_ENGINE, 'higgs-v3', 'the engine id still travels: prep packs BY engine');
    assert.strictEqual(plan.env.X, '1');
    assert.ok(plan.env.PYTHONPATH && fs.existsSync(path.join(plan.env.PYTHONPATH, 'narrator', '__init__.py')),
      `PYTHONPATH does not reach narrator: ${plan.env.PYTHONPATH}`);
    for (const engine of ['orpheus']) {
      const p2 = narratorSpawn.buildNarratorSpawn({ engine, phase: 'prep', args: [], envExtras: {}, onHost: true });
      assert.strictEqual(p2.viaWsl, false, `${engine}: crosses into WSL`);
      assert.strictEqual(p2.command, fakePython);
    }
  });

  if (ON_WINDOWS) {
    await check('MUTATION: the same request WITHOUT onHost is the guest spawn (the toggle is on)', () => {
      const plan = narratorSpawn.buildNarratorSpawn({
        engine: 'higgs', phase: 'prep', args: ['--prep_only'], envExtras: {},
      });
      assert.strictEqual(plan.viaWsl, true, 'with the toggle on and no onHost, prep must still be the guest arm');
      assert.strictEqual(plan.command, 'wsl.exe');
    });
  }

  await check('onHost is refused by name on a phase that loads the model', () => {
    for (const phase of ['worker', 'serve']) {
      assert.throws(
        () => narratorSpawn.buildNarratorSpawn({ engine: 'higgs', phase, args: [], envExtras: {}, onHost: true }),
        (err) => /onHost was set on phase '(worker|serve)'/.test(err.message) && /Only prep/.test(err.message),
        `${phase} accepted onHost`);
    }
  });

  await check('onHost and wslCondaEnv together are refused: two answers for one arm', () => {
    assert.throws(
      () => narratorSpawn.buildNarratorSpawn({ phase: 'prep', engine: 'higgs', args: [], envExtras: {}, onHost: true, wslCondaEnv: 'qwen-align' }),
      /onHost and wslCondaEnv 'qwen-align' were both given/);
  });

  /*
   * A CHECK STOOD HERE AND ITS SUBJECT IS DELETED.
   *
   * "narratorSpawnCrossesIntoWsl is the ONE computation the spawn and the voice
   * document share" read `electron/higgs-spawn.ts` and proved that the arm the
   * voice document was WRITTEN for was the same arm the command line was BUILT
   * for — the two were computed separately once, and the moment a per-run
   * override lived in one of them they could disagree about which voice a book
   * was in. narrator's reaction to a voice its document does not name is not a
   * crash: a whole book renders in the base model's own speaker.
   *
   * `higgs-spawn.ts` is deleted (docs/LEGACY-REMOVAL.md) and there is no voice
   * document, because there is no local Higgs server to start on a voice. The
   * surviving half of that lesson — that a render must resolve its voice through
   * ONE function so no two doors can disagree — is `higgsModelForJob` in
   * `higgs-models.ts`, and `tools/test-higgs-engine.js` is where it is pinned.
   */

  console.log('4. the tools env is MEASURED before a Crucible-venue prep spawns');

  await check('a tools env whose python is not a python is refused naming the interpreter', async () => {
    const refusal = await narratorSpawn.hostPrepRefusal('higgs');
    assert.ok(typeof refusal === 'string' && refusal.length > 0, 'an empty file passed as a python');
    assert.ok(refusal.includes(fakePython), `the refusal must name the interpreter: ${refusal}`);
    assert.ok(/cannot run narrator's prep/.test(refusal), refusal);
    assert.ok(/nothing preps inside WSL for a render that does not run there/i.test(refusal),
      refusal);
    // And it no longer offers the deleted switch as the way out: the fix is to
    // install narrator's text dependencies into that interpreter.
    assert.ok(/pip install -e/.test(refusal), refusal);
    assert.ok(!/turn on "Render audiobooks/.test(refusal),
      `it still offers a switch that no longer exists: ${refusal}`);
  });

  const platformUserData = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'BookForge')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BookForge')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'BookForge');
  const realToolsEnv = path.join(platformUserData, 'runtime', 'tools-env');
  const realPython = process.platform === 'win32'
    ? path.join(realToolsEnv, 'python.exe') : path.join(realToolsEnv, 'bin', 'python');
  if (fs.existsSync(realPython)) {
    await check(`this machine's tools env can prep for both engines (${realToolsEnv})`, async () => {
      process.env.BOOKFORGE_TOOLS_ENV = realToolsEnv;
      try {
        for (const engine of ['higgs', 'orpheus']) {
          const refusal = await narratorSpawn.hostPrepRefusal(engine);
          assert.strictEqual(refusal, null, `${engine}: ${refusal}`);
        }
      } finally {
        process.env.BOOKFORGE_TOOLS_ENV = FAKE_TOOLS_ENV;
      }
    });
  } else {
    console.log(`  --    this machine has no tools env at ${realToolsEnv}; the real probe is not measured here`);
  }

  await check('prepareSession measures the tools env, and the local doctor is not back', () => {
    /*
     * It used to assert a two-armed branch: `hostPrepRefusal` on the Crucible
     * side and the Higgs DOCTOR on the legacy one. The doctor is deleted with the
     * local environment it examined — the engine runs on a Crucible server, which
     * answers for its own environment — so the surviving half is asserted
     * directly, and the doctor's absence with it.
     */
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const at = src.indexOf('export async function prepareSession(');
    const body = src.slice(at, src.indexOf('const home = sessionHomeFor(', at));
    assert.ok(/await hostPrepRefusal\(engine\)/.test(body),
      'prepareSession no longer measures the tools env before it spawns');
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

  await check('the guest branch of sessionHomeFor asks narratorScratchRoot() before getWslSessionsRoot()', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const at = src.indexOf('export function sessionHomeFor(');
    const guest = src.slice(at, src.indexOf('return {', at));
    const scratch = guest.indexOf('narratorScratchRoot();');
    const wsl = guest.indexOf('getWslSessionsRoot()');
    assert.ok(scratch > 0 && wsl > 0 && scratch < wsl,
      'the copy-out destination must be checked before the guest session root is derived');
    assert.ok(/RULING OWED: a scratch root on a NETWORK drive is deliberately NOT refused/.test(guest),
      'the network-drive decision is a labelled ruling, not an omission');
  });

  console.log('7. nothing else in a Crucible-venue run enters the guest');

  await check('every guest gate asks sessionRunsInWsl(session), which reads the venue', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const fn = (name) => {
      const at = src.indexOf(name);
      assert.ok(at > 0, `${name} not found`);
      return src.slice(at, at + 1600);
    };
    /*
     * TWO GATES LEFT THIS LIST ON 2026-09-15 with the local renderer.
     * `ensureGuestCanReachSession` mounted the library share INSIDE the guest for
     * a render that was about to happen there, and `acquireGpuForJob` carried an
     * `orpheusViaWsl` clear-guest arm. Neither has a subject any more: nothing
     * renders in the guest, so nothing needs the share mounted there or the guest
     * cleared before it.
     *
     * The two TEARDOWN gates below SURVIVE and still ask, and that is not
     * leftover: a session object outlives its render, Stop and quit share one
     * teardown path, and a session restored from an older queue file can still
     * carry a venue this build would never mint.
     */
    const stopAt = src.indexOf('export async function stopParallelConversion(');
    assert.ok(/if \(sessionRunsInWsl\(session\)\) \{/.test(src.slice(stopAt, stopAt + 6000)),
      'Stop must not tear down guest workers for a session that has none');
    const quitAt = src.indexOf('Killing all workers on app shutdown');
    assert.ok(/if \(sessionRunsInWsl\(session\)\) \{/.test(src.slice(quitAt, quitAt + 1500)),
      'the quit teardown must not enter the guest for a session that never did');
    const pred = fn('function sessionRunsInWsl(');
    assert.ok(/if \(session\.venue\?\.where === 'crucible'\) return false;/.test(pred));
  });

  await check('the fresh launch points decide the venue BEFORE prep and hand it to prepareSession', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    for (const name of ['export async function startParallelConversion(', 'async function renderRangeHeadless(']) {
      const at = src.indexOf(name);
      assert.ok(at > 0, `${name} not found`);
      const body = src.slice(at, at + 12000);
      const decide = body.indexOf('await decideGenerationVenue(');
      const prep = body.indexOf('await prepareSession(');
      assert.ok(decide > 0 && prep > 0 && decide < prep,
        `${name} preps before it knows where the render runs`);
    }
  });

  await check('the copy-out probe asks mountpoint, not test -d (a stale mount point is a directory)', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const at = src.indexOf('async function wslSeesDrive(');
    const body = src.slice(at, at + 2000);
    assert.ok(/const probe = `mountpoint -q \/mnt\/\$\{driveLetter\.toLowerCase\(\)\}`;/.test(body), 'the probe is not mountpoint -q');
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
