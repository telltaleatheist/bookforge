#!/usr/bin/env node
/**
 * A THROW IN THE POST-WORKER TAIL IS A FAILED JOB, NOT A HUNG ONE.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-worker-completion-throw.js
 *
 * ── The defect this pins (2026-09-13) ───────────────────────────────────────
 *
 * `normalizeWslSessionToWindows` THROWS by design — "THERE IS NO WSL ASSEMBLY
 * FALLBACK ANY MORE" — and it is awaited from `checkAllWorkersComplete`'s tail.
 * A comment further down that function claimed the assembly `catch` covered it.
 * Brace-counted: it does not. The assembly `try` opens about a hundred and eighty
 * lines LATER, and the normalizer sat outside every `try` in the function, as did
 * `runPostRenderAlignment`, the project-cache block and `stopChapterCloser`.
 *
 * The function is called as a floating promise from three worker `close`/`error`
 * handlers and one VRAM-wait retry, and this process installs no
 * `unhandledRejection` handler. So the throw went NOWHERE:
 *
 *   - no completion event was ever emitted;
 *   - the session was never removed from `activeSessions`, so
 *     `waitForBridgeEvent` (queue-steps/tts-conversion.ts, no timeout) left the
 *     queue row at "Assembling…" forever and `renderRangeHeadless`'s poll spun;
 *   - `session.completionError` — the ONLY carrier a headless run has, since
 *     `emitComplete` returns early with no mainWindow — was never set;
 *   - the GPU lease was never released, so every later job waited out its ten
 *     minutes and then ran unleased.
 *
 * ── Why this keeper can fail ────────────────────────────────────────────────
 *
 * It runs the SHIPPED tail, lifted out of the compiled bridge with its free
 * variables rebound (the technique `tools/test-assembly-after-wsl-normalize.js`
 * established), and makes the normalizer throw exactly what it throws in
 * production. Then it runs the INNER function directly with the same stubs and
 * requires THAT to reject — which is the pre-fix behaviour, and proves the rows
 * above are measuring the wrapper rather than nothing.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');

if (!fs.existsSync(path.join(DIST, 'parallel-tts-bridge.js'))) {
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
// The real functions, lifted out of the compiled bridge
// ─────────────────────────────────────────────────────────────────────────────
const bridgeJs = fs.readFileSync(path.join(DIST, 'parallel-tts-bridge.js'), 'utf-8');
function lift(name) {
  const m = bridgeJs.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`));
  if (!m) throw new Error(`${name} is not in the compiled bridge — did it move?`);
  return m[0];
}

/** The exact sentence `normalizeWslSessionToWindows` throws when the copy fails. */
const WSL_COPY_FAILURE =
  'The rendered session could not be copied out of WSL onto a Windows path (EIO). '
  + 'Assembly runs natively and will not read the \\wsl$ mount.';

/**
 * Build the tail with every collaborator stubbed, and hand back the recorder.
 *
 * `normalizeThrows` is the one knob: it is the step that throws in production
 * and had nowhere to throw to.
 */
function buildTail(normalizeThrows) {
  const recorder = {
    completions: [],
    deleted: [],
    assemblyRan: false,
    normalizeRan: false,
  };
  const activeSessions = { delete: (id) => { recorder.deleted.push(id); } };
  const emitComplete = (session, success, outputPath, error) => {
    recorder.completions.push({ success, outputPath, error });
  };
  const logger = { log: async () => {}, logError: async () => {} };
  const ttsLog = { info: () => {}, warn: () => {}, error: () => {} };

  const built = eval(
    `(function (path, console, activeSessions, emitComplete, logger, ttsLog, recorder, WSL_COPY_FAILURE, normalizeThrows) {
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
       // The compiled tail reaches its cross-module collaborators through tsc's
       // import namespaces, so the stubs wear the same names.
       const orpheus_memory_1 = { noteOrpheusOom: () => {} };
       const rolling_logger_1 = { getTTSLogger: () => ttsLog };
       const chapter_closer_1 = { stopChapterCloser: async () => null };
       const denoise_bridge_1 = {
         finalDenoiseReady: () => ({ ok: true }),
         denoiseSentences: async () => {},
       };
       const rvc_models_1 = { getRvcVoiceById: () => null, resolveRvcIndexRate: () => 0.3 };
       const rvc_bridge_1 = { rvcEnhancementReady: () => ({ ok: true }), enhanceSentences: async () => {} };
       const normalizeWslSessionToWindows = async () => {
         recorder.normalizeRan = true;
         if (normalizeThrows) throw new Error(WSL_COPY_FAILURE);
       };
       const runAssembly = async () => { recorder.assemblyRan = true; return 'C:\\\\out\\\\book.m4b'; };
       ${lift('completeAfterWorkers')}
       ${lift('checkAllWorkersComplete')}
       return { checkAllWorkersComplete, completeAfterWorkers };
     })`,
  )(path, { log: () => {}, warn: () => {}, error: () => {} },
    activeSessions, emitComplete, logger, ttsLog, recorder, WSL_COPY_FAILURE, normalizeThrows);

  return { ...built, recorder };
}

/** A session whose single worker finished cleanly — the ordinary success path. */
function finishedSession() {
  return {
    jobId: 'keeper-job',
    cancelled: false,
    isResumeJob: false,
    workers: [{
      id: 0, status: 'complete', retryCount: 0,
      sentenceStart: 0, sentenceEnd: 9, error: undefined,
    }],
    prepInfo: {
      sessionId: 'keeper',
      sessionDir: 'C:\\scratch\\ebook-keeper',
      processDir: 'C:\\scratch\\ebook-keeper\\p',
      chaptersDir: 'C:\\scratch\\ebook-keeper\\p\\chapters',
      chaptersDirSentences: 'C:\\scratch\\ebook-keeper\\p\\chapters\\sentences',
      totalChapters: 1,
      totalSentences: 10,
    },
    config: {
      settings: { language: 'en', ttsEngine: 'orpheus' },
      skipAssembly: false,
      outputDir: 'C:\\out',
    },
  };
}

async function main() {
  console.log('the post-worker tail reports what it cannot do');

  await check('the happy path still completes successfully', async () => {
    const { checkAllWorkersComplete, recorder } = buildTail(false);
    const session = finishedSession();
    await checkAllWorkersComplete(session);
    assert.strictEqual(recorder.normalizeRan, true, 'the normalizer was never reached');
    assert.strictEqual(recorder.assemblyRan, true, 'assembly was never reached');
    assert.deepStrictEqual(
      recorder.completions.map((c) => c.success), [true],
      `expected one successful completion, got ${JSON.stringify(recorder.completions)}`);
    assert.deepStrictEqual(recorder.deleted, ['keeper-job'], 'the session was not released');
  });

  let thrownRecorder;
  await check('a WSL copy failure does NOT reject out of the handler', async () => {
    const { checkAllWorkersComplete, recorder } = buildTail(true);
    thrownRecorder = recorder;
    const session = finishedSession();
    // The call sites are floating promises. A rejection here is an unhandled
    // rejection in production, and there is no handler for one.
    await checkAllWorkersComplete(session);
    assert.strictEqual(recorder.normalizeRan, true);
    assert.strictEqual(recorder.assemblyRan, false, 'assembly ran on a session still in WSL');
    thrownRecorder.session = session;
  });

  await check('it emits a FAILED completion naming the copy', () => {
    assert.strictEqual(thrownRecorder.completions.length, 1,
      `expected exactly one completion, got ${JSON.stringify(thrownRecorder.completions)}`);
    const [done] = thrownRecorder.completions;
    assert.strictEqual(done.success, false, 'the job reported success with no audiobook');
    assert.match(done.error, /Session copy failed/,
      `the failure must name the stage, not "Assembly failed": ${done.error}`);
    assert.match(done.error, /could not be copied out of WSL/, done.error);
  });

  await check('and sets completionError, the headless run\'s only carrier', () => {
    // With no mainWindow `emitComplete` returns early, so a CLI render learns the
    // cause from this field alone (renderRangeHeadless reads it after its poll).
    assert.ok(typeof thrownRecorder.session.completionError === 'string',
      'completionError was not set — a headless render would throw a downstream symptom '
      + 'instead of the real cause');
    assert.match(thrownRecorder.session.completionError, /could not be copied out of WSL/);
  });

  await check('and RELEASES the session, which is the wedge itself', () => {
    assert.deepStrictEqual(thrownRecorder.deleted, ['keeper-job'],
      'the session stayed in activeSessions: the queue row sits at "Assembling…" forever, '
      + 'the headless poll spins, and the GPU lease is never released');
  });

  console.log('the rows above measure the wrapper, not nothing');

  await check('MUTATION: the tail itself (un-wrapped) still rejects', async () => {
    // This IS the pre-fix behaviour — `completeAfterWorkers` was
    // `checkAllWorkersComplete`, called bare from a close handler. If it ever
    // stops rejecting, the four rows above pass for a reason that is not the fix.
    const { completeAfterWorkers, recorder } = buildTail(true);
    let rejected = false;
    await completeAfterWorkers(finishedSession()).catch(() => { rejected = true; });
    assert.strictEqual(rejected, true,
      'the un-wrapped tail swallowed the throw, so the wrapper is proving nothing');
    assert.deepStrictEqual(recorder.completions, [],
      'the un-wrapped tail reported a completion it cannot have reached');
    assert.deepStrictEqual(recorder.deleted, [],
      'the un-wrapped tail released the session it cannot have released');
  });

  console.log('and no call site is left floating');

  const source = fs.readFileSync(path.join(REPO, 'electron/parallel-tts-bridge.ts'), 'utf8');

  await check('every checkAllWorkersComplete(...) call carries a .catch()', () => {
    // The wrapper must not be the last word either: if `emitComplete` itself
    // throws there is nowhere left to send it, and the alternative is the
    // unhandled rejection this whole suite is about.
    const bare = [];
    const lines = source.split('\n');
    lines.forEach((line, i) => {
      if (!/checkAllWorkersComplete\(session\)/.test(line)) return;
      if (/function checkAllWorkersComplete/.test(line)) return;
      // The `.catch()` may sit on the next line (it does, at every site).
      const window = `${line}\n${lines[i + 1] ?? ''}`;
      if (!/\.catch\(/.test(window)) bare.push(`${i + 1}: ${line.trim()}`);
    });
    assert.deepStrictEqual(bare, [],
      `these call sites float a rejection into a process with no unhandledRejection handler:\n`
      + bare.join('\n'));
    // MUTATION: the scan can see a bare call. Without this it passes for a file
    // that has no call sites at all.
    const fabricated = ['  emitProgress(session);', '  checkAllWorkersComplete(session);', '  return;'];
    const caught = fabricated.some((line, i) =>
      /checkAllWorkersComplete\(session\)/.test(line)
      && !/\.catch\(/.test(`${line}\n${fabricated[i + 1] ?? ''}`));
    assert.ok(caught, 'the scan cannot recognize a bare call site');
  });

  await check('there are still four of them', () => {
    // Three worker close/error handlers and the VRAM-wait retry. A new one added
    // without a `.catch()` fails the row above; a count here says the row above
    // is looking at all of them.
    const calls = source.match(/checkAllWorkersComplete\(session\)\n?\s*\.catch\(/g) ?? [];
    assert.strictEqual(calls.length, 4,
      `expected 4 guarded call sites, found ${calls.length} — if a site was added or removed, `
      + 'say so here rather than loosening the count');
  });

  console.log(failures === 0
    ? '\nAll post-worker completion checks passed.'
    : `\n${failures} check(s) FAILED.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
