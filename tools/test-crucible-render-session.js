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
const LEGACY = { where: 'legacy-local-narrator', because: 'the legacy local-render switch is on' };

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

/** The shipped completion tail with every collaborator stubbed and a recorder. */
function buildTail() {
  const recorder = { normalizeRan: false, assemblyRan: false, completions: [], deleted: [] };
  const activeSessions = { delete: (id) => { recorder.deleted.push(id); } };
  const emitComplete = (session, success, outputPath, error) => {
    recorder.completions.push({ success, outputPath, error });
  };
  const logger = { log: async () => {}, logError: async () => {} };
  const ttsLog = { info: () => {}, warn: () => {}, error: () => {} };
  const built = eval(
    `(function (path, console, activeSessions, emitComplete, logger, ttsLog, recorder) {
       const MAX_WORKER_RETRIES = 2;
       const mainWindow = null;
       const isOomError = () => false;
       const retryWorker = () => {};
       const stopWatchdog = () => {};
       const stopRenderedPoller = () => {};
       const rendererSend = () => {};
       const runPostRenderAlignment = async () => {};
       const cacheSessionToProject = async () => ({ success: true });
       const findMissingSentenceFiles = async () => [];
       const removeScratchSession = async () => {};
       const orpheus_memory_1 = { noteOrpheusOom: () => {} };
       const rolling_logger_1 = { getTTSLogger: () => ttsLog };
       const chapter_closer_1 = { stopChapterCloser: async () => null };
       const denoise_bridge_1 = { finalDenoiseReady: () => ({ ok: true }), denoiseSentences: async () => {} };
       const rvc_models_1 = { getRvcVoiceById: () => null, resolveRvcIndexRate: () => 0.3 };
       const rvc_bridge_1 = { rvcEnhancementReady: () => ({ ok: true }), enhanceSentences: async () => {} };
       const normalizeWslSessionToWindows = async () => { recorder.normalizeRan = true; };
       const runAssembly = async () => { recorder.assemblyRan = true; return 'C:\\\\out\\\\book.m4b'; };
       ${lift('completeAfterWorkers')}
       ${lift('checkAllWorkersComplete')}
       return { checkAllWorkersComplete };
     })`,
  )(path, { log: () => {}, warn: () => {}, error: () => {} }, activeSessions, emitComplete, logger, ttsLog, recorder);
  return { ...built, recorder };
}

/** A session whose single worker finished; `venue` is the one variable. */
function finishedSession(venue, sessionDir) {
  return {
    jobId: 'keeper-job',
    cancelled: false,
    isResumeJob: false,
    ...(venue ? { venue } : {}),
    workers: [{ id: 0, status: 'complete', retryCount: 0, sentenceStart: 0, sentenceEnd: 9 }],
    prepInfo: {
      sessionId: 'keeper',
      sessionDir,
      processDir: `${sessionDir}${path.sep}p`,
      chaptersDir: `${sessionDir}${path.sep}p${path.sep}chapters`,
      chaptersDirSentences: `${sessionDir}${path.sep}p${path.sep}chapters${path.sep}sentences`,
      totalChapters: 1,
      totalSentences: 10,
    },
    config: { settings: { language: 'en', ttsEngine: 'higgs' }, skipAssembly: false, outputDir: 'C:\\out' },
  };
}

/** The shipped normaliser, with the copy branch stubbed to explode if reached. */
const normalize = eval(
  `(function (fsSync, path, logger, console) {
     ${lift('isWslUncPath')}
     ${lift('sessionDirFromCachedSentences')}
     const fs = { rm: async () => {} };
     const findE2aProcessDir = () => null;
     const narratorScratchRoot = () => { throw new Error('the copy branch must not be reached'); };
     const copyDirOutOfWsl = async () => { throw new Error('the copy branch must not be reached'); };
     const rewriteSessionStatePaths = async () => {};
     ${lift('normalizeWslSessionToWindows')}
     return normalizeWslSessionToWindows;
   })`,
)(fs, path, { log: async () => {} }, { log: () => {} });

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('1. the venue decides, not the engine\'s toggle');

  await check('a Crucible venue never preps in WSL, for either engine, with both toggles on', () => {
    for (const venue of [CRUCIBLE, LOCAL]) {
      for (const engine of ['higgs', 'orpheus']) {
        assert.strictEqual(bridge.prepRunsInWsl(venue, engine), false,
          `${engine} on crucible "${venue.server}" would prep in the guest`);
      }
    }
  });

  await check(ON_WINDOWS
    ? 'the legacy venue keeps the engine\'s answer: both engines go to the guest'
    : 'the legacy venue keeps the engine\'s answer: no guest off Windows', () => {
    for (const engine of ['higgs', 'orpheus']) {
      assert.strictEqual(bridge.prepRunsInWsl(LEGACY, engine), ON_WINDOWS,
        `${engine} on the legacy venue answered ${!ON_WINDOWS} on ${process.platform}`);
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

  if (ON_WINDOWS) {
    await check('the legacy venue, same toggles, same engine, still goes to the guest', () => {
      for (const engine of ['higgs', 'orpheus']) {
        const home = bridge.sessionHomeFor(LEGACY, engine, ID);
        assert.strictEqual(home.inGuest, true, `${engine}: a legacy WSL prep left the guest`);
        assert.strictEqual(home.guestRoot, GUEST_ROOT);
        assert.strictEqual(home.sessionDir, `${GUEST_ROOT}/ebook-${ID}`);
        assert.ok(isUnc(home.sessionDirForReading) && /Ubuntu/.test(home.sessionDirForReading),
          `the host reads it through \\\\wsl$: ${home.sessionDirForReading}`);
      }
    });
    await check('MUTATION: the venue is the ONE thing that moved the session', () => {
      const a = bridge.sessionHomeFor(CRUCIBLE, 'higgs', ID);
      const b = bridge.sessionHomeFor(LEGACY, 'higgs', ID);
      assert.notStrictEqual(a.sessionDir, b.sessionDir,
        'both venues placed the session in the same directory — the placement is not reading the venue');
    });
  } else {
    await check('the legacy venue is native off Windows (there is no guest)', () => {
      const home = bridge.sessionHomeFor(LEGACY, 'higgs', ID);
      assert.strictEqual(home.inGuest, false);
      assert.strictEqual(home.sessionDir, path.join(SCRATCH, `ebook-${ID}`));
    });
  }

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

  await check('narratorSpawnCrossesIntoWsl is the ONE computation the spawn and the voice document share', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'higgs-spawn.ts'), 'utf8');
    assert.ok(/narratorSpawnCrossesIntoWsl\('higgs', kind, onHost\)/.test(src),
      'higgs-spawn.ts must derive the voice document\'s arm from narratorSpawnCrossesIntoWsl with onHost');
    const spawnSrc = fs.readFileSync(path.join(REPO, 'electron', 'narrator-spawn.ts'), 'utf8');
    assert.ok(/narratorSpawnCrossesIntoWsl\(engine, phase, req\.onHost === true\)/.test(spawnSrc),
      'buildNarratorSpawn must derive its own arm from the same function');
  });

  console.log('4. the tools env is MEASURED before a Crucible-venue prep spawns');

  await check('a tools env whose python is not a python is refused naming the interpreter', async () => {
    const refusal = await narratorSpawn.hostPrepRefusal('higgs');
    assert.ok(typeof refusal === 'string' && refusal.length > 0, 'an empty file passed as a python');
    assert.ok(refusal.includes(fakePython), `the refusal must name the interpreter: ${refusal}`);
    assert.ok(/cannot run narrator's prep/.test(refusal), refusal);
    assert.ok(/Nothing preps inside WSL for a render that does not run there/.test(refusal), refusal);
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

  await check('prepareSession asks hostPrepRefusal on the Crucible branch and the Higgs doctor on the legacy one', () => {
    const src = fs.readFileSync(path.join(REPO, 'electron', 'parallel-tts-bridge.ts'), 'utf8');
    const at = src.indexOf('export async function prepareSession(');
    const body = src.slice(at, src.indexOf('const home = sessionHomeFor(', at));
    assert.ok(/if \(venue\.where === 'crucible'\) \{[\s\S]*?await hostPrepRefusal\(engine\)[\s\S]*?\} else if \(isHiggsJob\(settings\)\) \{[\s\S]*?await higgsEnvironmentRefusal\(\)/.test(body),
      'the Crucible branch must probe the tools env and the legacy branch must keep the doctor');
    const spawnAt = src.indexOf('const prepPlan = buildJobSpawn({', at);
    assert.ok(spawnAt > 0 && /onHost: venue\.where === 'crucible'/.test(src.slice(spawnAt, spawnAt + 700)),
      'the prep spawn must be built onHost exactly when the venue is a Crucible');
  });

  console.log('5. the completion tail never calls the normaliser for a Crucible venue');

  await check('the SHIPPED tail assembles a Crucible-venue session without normalizeWslSessionToWindows', async () => {
    const { checkAllWorkersComplete, recorder } = buildTail();
    await checkAllWorkersComplete(finishedSession(CRUCIBLE, path.join(SCRATCH, 'ebook-keeper')));
    assert.strictEqual(recorder.normalizeRan, false, 'the normaliser was called for a session that never entered WSL');
    assert.strictEqual(recorder.assemblyRan, true, 'assembly never ran');
    assert.deepStrictEqual(recorder.completions.map((c) => c.success), [true], JSON.stringify(recorder.completions));
    assert.deepStrictEqual(recorder.deleted, ['keeper-job']);
  });

  await check('MUTATION: the same tail DOES call it for a legacy session (the recorder measures)', async () => {
    const { checkAllWorkersComplete, recorder } = buildTail();
    await checkAllWorkersComplete(finishedSession(undefined, 'C:\\scratch\\ebook-keeper'));
    assert.strictEqual(recorder.normalizeRan, true, 'the legacy tail skipped the normaliser too — the gate is not the venue');
    assert.strictEqual(recorder.assemblyRan, true);
  });

  await check('the normaliser refuses a Crucible-venue session by name (a caller bug, said)', async () => {
    const hostPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      await assert.rejects(
        () => normalize(finishedSession(CRUCIBLE, path.join(SCRATCH, 'ebook-keeper'))),
        /rendered on crucible "mac"[\s\S]*never enters WSL/);
      // And a native legacy session is simply nothing to do — not a refusal.
      await normalize(finishedSession(undefined, 'C:\\scratch\\ebook-keeper'));
    } finally {
      Object.defineProperty(process, 'platform', { value: hostPlatform, configurable: true });
    }
  });

  console.log('6. the scratch-root refusal arrives BEFORE a legacy WSL prep, naming the setting');

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

  if (ON_WINDOWS) {
    await check('a legacy WSL prep reaches that refusal at placement time, before the guest root is even named', () => {
      const gone = path.join(WORK, 'no-such-volume', 'tmp');
      narratorPaths.setNarratorScratchRoot(gone);
      try {
        assert.throws(() => bridge.sessionHomeFor(LEGACY, 'orpheus', ID),
          (err) => err.message.includes(gone) && /Narrator scratch folder/.test(err.message));
      } finally {
        narratorPaths.setNarratorScratchRoot(SCRATCH);
      }
    });
  }

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
    assert.ok(/if \(!sessionRunsInWsl\(session\)\) return;/.test(fn('async function ensureGuestCanReachSession(')),
      'ensureGuestCanReachSession would mount the library share in WSL for a render that never goes there');
    assert.ok(/const orpheusViaWsl = engine === 'orpheus' && sessionRunsInWsl\(session\);/.test(fn('async function acquireGpuForJob(')),
      'the clear-guest gate and the wedge check must key on the session\'s arm');
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
    for (const name of ['export async function startParallelConversion(', 'export async function renderRangeHeadless(']) {
      const at = src.indexOf(name);
      const body = src.slice(at, at + 12000);
      const decide = body.indexOf('await decideGenerationVenue(');
      const prep = body.indexOf('await prepareSession(');
      assert.ok(decide > 0 && prep > 0 && decide < prep, `${name} preps before it knows where the render runs`);
      assert.ok(/await prepareSession\([^;]*?, venue, /.test(body.slice(prep, prep + 200)), `${name} preps without the venue`);
      assert.ok(/assemblyProcess: null,\s*venue,/.test(body), `${name} does not carry the venue on its session`);
    }
    const resume = src.slice(src.indexOf('export async function resumeParallelConversion('));
    const decide = resume.indexOf('await decideAndRememberVenue(session)');
    const guest = resume.indexOf('await ensureGuestCanReachSession(session)');
    assert.ok(decide > 0 && guest > 0 && decide < guest, 'a resume must know its venue before the guest gates run');
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
