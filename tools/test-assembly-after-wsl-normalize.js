#!/usr/bin/env node
/**
 * AFTER A WSL RENDER, EVERY PATH THE ASSEMBLER IS HANDED IS A WINDOWS PATH.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-assembly-after-wsl-normalize.js
 *
 * ── The bug this pins ───────────────────────────────────────────────────────
 *
 * Orpheus renders in WSL, so the session is written to ext4 and `prepInfo` holds
 * `\\wsl$` UNC paths. `normalizeWslSessionToWindows` copies it onto NTFS and
 * repoints `prepInfo` — and until 2026-09-05 it repointed three fields and not the
 * fourth. `processDir` stayed on the guest, and `processDir` is the one the
 * assembly door passes as `--session_dir`.
 *
 * So after every in-app Windows/WSL render the native assembler read
 * `session-state.json` from the WSL copy — whose internal paths
 * `rewriteSessionStatePaths` never rewrote — over the 9p mount, at path lengths
 * past 260 characters. That is the exact state the normalizer's own throw
 * describes: mediainfo answers a too-long path with a SILENT 0.0 duration, so the
 * book assembles wrong instead of failing.
 *
 * ── Why nothing else caught it ──────────────────────────────────────────────
 *
 * The live GPU proof drove the CLI, which reaches `startReassembly` with a
 * Windows `config.processDir` and never touches `prepInfo`. The argv snapshot
 * feeds a fixture `prepInfo` whose fields all agree, so it cannot see a field
 * being missed. Only a POST-NORMALIZATION fixture can, which is what this is.
 *
 * A KEEPER THAT CANNOT FAIL IS WORTH NOTHING, so this one is mutation-checked:
 * it re-runs its own assertion against a deliberately un-repointed prepInfo and
 * requires that to be caught.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

// THE ARM IS THE FIXTURE'S, NOT THE HOST'S. A WSL render exists only on win32, and
// the lifted normalizer returns before doing anything on any other platform — so
// on a macOS host this keeper went red while pinning nothing (2026-09-05, the Mac
// agent's run at ffca9398). The host is remembered only for the one assertion
// that is genuinely about the host's own filesystem shape.
const HOST_PLATFORM = process.platform;
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

if (!fs.existsSync(path.join(DIST, 'parallel-tts-bridge.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exitCode = 1;
  return;
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub';
  return originalResolve.call(this, request, ...rest);
};
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: {
    app: { getAppPath: () => REPO, getPath: () => os.tmpdir(), isPackaged: false },
    BrowserWindow: class {},
  },
};

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
// The real function, lifted out of the compiled bridge
// ─────────────────────────────────────────────────────────────────────────────
//
// `normalizeWslSessionToWindows` is module-private and should stay that way — it
// is not part of the bridge's surface. Lifted with its free variables rebound, so
// what runs here is the shipped code rather than a re-description of it. Only the
// `windowsSentencesDir` reuse branch is exercised: it is the branch that never
// computes a process dir, which is how the field came to be missed.
const bridgeJs = fs.readFileSync(path.join(DIST, 'parallel-tts-bridge.js'), 'utf-8');
function lift(name) {
  const m = bridgeJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`));
  if (!m) throw new Error(`${name} is not in the compiled bridge — did it move?`);
  return m[0];
}

const isWslUncPathSrc = lift('isWslUncPath');
const sessionDirSrc = lift('sessionDirFromCachedSentences');
const normalizeSrc = lift('normalizeWslSessionToWindows');

const loggerStub = { log: async () => {} };
const normalize = eval(
  `(function (fsSync, path, logger, console) {
     ${isWslUncPathSrc}
     ${sessionDirSrc}
     const fs = { rm: async () => {} };
     const findE2aProcessDir = () => null;
     const narratorScratchRoot = () => { throw new Error('the copy branch is not under test here'); };
     const copyDirOutOfWsl = async () => { throw new Error('the copy branch is not under test here'); };
     const rewriteSessionStatePaths = async () => {};
     ${normalizeSrc}
     return normalizeWslSessionToWindows;
   })`,
)(fs, path, loggerStub, { log: () => {} });

// ─────────────────────────────────────────────────────────────────────────────
// A session that really was rendered in WSL
// ─────────────────────────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-normalize-'));
const SESSION_ID = 'ccd14111-da29-4fb0-a489-a19a0f126bac';
// The Windows copy the project cache already made.
const WIN_SESSION = path.join(SCRATCH, `ebook-${SESSION_ID}`);
const WIN_PROCESS = path.join(WIN_SESSION, '645fe7068635f759cbda0b8a6d3a348d');
const WIN_SENTENCES = path.join(WIN_PROCESS, 'chapters', 'sentences');
fs.mkdirSync(WIN_SENTENCES, { recursive: true });
fs.writeFileSync(path.join(WIN_PROCESS, 'session-state.json'), JSON.stringify({ tts_engine: 'orpheus' }));

/** prepInfo exactly as a WSL prep leaves it: every path a `\\wsl$` UNC. */
function guestPrepInfo() {
  const guestSession = `\\\\wsl$\\Ubuntu\\home\\telltale\\ebook2audiobook\\tmp\\ebook-${SESSION_ID}`;
  const guestProcess = `${guestSession}\\645fe7068635f759cbda0b8a6d3a348d`;
  return {
    sessionId: SESSION_ID,
    sessionDir: guestSession,
    processDir: guestProcess,
    chaptersDir: `${guestProcess}\\chapters`,
    chaptersDirSentences: `${guestProcess}\\chapters\\sentences`,
    totalChapters: 1,
    totalSentences: 133,
  };
}

const PATH_FIELDS = ['sessionDir', 'processDir', 'chaptersDir', 'chaptersDirSentences'];

/** The assembly door's own rule: a `\\wsl$` path here is the defect. */
function guestPathsIn(argv) {
  return argv.filter((a) => typeof a === 'string' && /^\\\\wsl[$.]/i.test(a));
}

/** The `--session_dir` the assembly door builds, from `runAssembly`'s own line. */
function assemblyArgv(prep) {
  return [
    '--headless',
    '--output_dir', path.join(SCRATCH, 'out'),
    '--session', prep.sessionId,
    '--session_dir', prep.processDir,
    '--sentences_dir', prep.chaptersDirSentences,
    '--device', 'CPU',
    '--assemble_only',
  ];
}

async function main() {
  console.log('the normalizer repoints EVERY path field, not three of four');
  const prep = guestPrepInfo();
  await check('a WSL-rendered prepInfo starts entirely on the guest', () => {
    for (const f of PATH_FIELDS) {
      assert.match(prep[f], /^\\\\wsl\$/, `${f} did not start on the guest: ${prep[f]}`);
    }
  });

  // Inside a check: a normalizer that REFUSES (the same-filesystem guard firing,
  // which is what a half-repointed prepInfo now produces) must read as one failed
  // row, not as an unhandled rejection that kills the tally.
  let normalized = false;
  await check('the normalizer accepts a session it can fully repoint', async () => {
    await normalize({ prepInfo: prep, jobId: 'keeper' }, WIN_SENTENCES);
    normalized = true;
  });
  if (!normalized) {
    console.log('\n  (the remaining rows need a normalized prepInfo — skipped)');
    fs.rmSync(SCRATCH, { recursive: true, force: true });
    console.log(`\n${failures} check(s) FAILED.`);
    process.exitCode = 1;
    return;
  }

  for (const f of PATH_FIELDS) {
    await check(`${f} is repointed onto Windows`, () => {
      assert.ok(!/^\\\\wsl[$.]/i.test(prep[f]), `${f} was left on the guest: ${prep[f]}`);
      // The "Windows copy" is a real directory under the host's tmpdir, so its
      // shape is the HOST's: a drive-letter path on Windows, a plain absolute path
      // on a macOS keeper run. Absolute-and-not-UNC is the invariant; the
      // drive-letter form is asserted where the host can produce it.
      assert.ok(path.isAbsolute(prep[f]) && !/^\\\\/.test(prep[f]),
        `${f} is not a host-native absolute path: ${prep[f]}`);
      if (HOST_PLATFORM === 'win32') {
        assert.match(prep[f], /^[A-Za-z]:[\\/]/, `${f} is not a Windows path: ${prep[f]}`);
      }
    });
  }

  await check('the four fields agree on one session directory', () => {
    // The failure mode was a MIXTURE — three fields on NTFS and one on ext4 — so
    // "they are all Windows-shaped" is not enough on its own.
    assert.strictEqual(prep.processDir, WIN_PROCESS);
    assert.strictEqual(prep.chaptersDir, path.join(WIN_PROCESS, 'chapters'));
    assert.strictEqual(prep.chaptersDirSentences, WIN_SENTENCES);
    assert.ok(prep.processDir.startsWith(prep.sessionDir),
      `processDir ${prep.processDir} is not under sessionDir ${prep.sessionDir}`);
  });

  console.log('and the assembly argv it produces carries no guest path');
  await check('every path in the assembly argv is Windows-shaped', () => {
    const stray = guestPathsIn(assemblyArgv(prep));
    assert.deepStrictEqual(stray, [],
      'the assembler would read these over the 9p mount, past MAX_PATH, where '
      + 'mediainfo reports a silent 0.0 duration');
  });

  console.log('the assertion is real — the un-repointed shape is caught');
  await check('MUTATION: reverting the processDir repoint fails the argv check', () => {
    // The exact regression, reconstructed: three fields normalized, `processDir`
    // left behind. If this passes, the check above proves nothing.
    const mutated = { ...prep, processDir: guestPrepInfo().processDir };
    const stray = guestPathsIn(assemblyArgv(mutated));
    assert.ok(stray.length > 0,
      'a prepInfo with an un-repointed processDir produced a clean argv — the '
      + 'check above cannot detect the regression it exists for');
    assert.match(stray[0], /^\\\\wsl\$/);
  });

  await check('MUTATION: the normalizer itself refuses a half-normalized session', () => {
    // The normalizer now also asserts the four fields share a filesystem. Proven by
    // handing it a session whose Windows sentences dir does not exist, which is the
    // other way this function can leave prepInfo inconsistent.
    return normalize({ prepInfo: guestPrepInfo(), jobId: 'keeper' },
      path.join(SCRATCH, 'does-not-exist'))
      .then(
        () => { throw new Error('normalizing onto a missing sentences dir was accepted'); },
        (err) => {
          assert.match(err.message, /could not be copied out of WSL|No sentences at/,
            `unexpected refusal: ${err.message}`);
        },
      );
  });

  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(failures === 0
    ? '\nAll post-normalization assembly checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
