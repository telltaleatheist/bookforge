#!/usr/bin/env node
/**
 * THE RENDER ROW GIVES THE GPU SLOT BACK WHEN THE CARD IS FREE — not when the
 * step is over.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-narration-gpu-handoff.js
 *
 * ── The measurement this file is named for (Owen's Mac, 2026-09-19) ─────────
 *
 * *Letter to the American Church*, rendered on this PC's Crucible. From the
 * Mac's own `tts.log` and `queue-engine.json`, all times UTC:
 *
 *   16:49:34  the tts-conversion row starts (resource: gpu)
 *   16:57:49  Crucible unloads the voice — the card is free
 *   16:58:03  "Chunk alignment failed after 14s, so the audiobook carries the
 *              estimated transcript: … crucible … is unreachable (ECONNRESET)"
 *   17:05:41  "Session cached to project on completion" — 458 s of file copy
 *   17:05:42  the row settles; the reassembly row takes a CPU slot 4 ms later
 *
 * Owen: *"it just sits in the gpu slot for another 10 minutes after alignment
 * fails. a timeout? it takes up the slot."* It was not a timeout, and it was not
 * the assembly — the assembly has been its own CPU row for a long time and
 * claimed its slot immediately. It was the TAIL of the render row: publishing
 * the rendered session into the project is minutes of file copy on a library
 * volume that has no clone support, and it was charged to a card that had been
 * idle since 16:57:49.
 *
 * ── What is defended here ───────────────────────────────────────────────────
 *
 *  1. THE SHIPPED COMPLETION TAIL, lifted out of the compiled bridge and driven
 *     with fakes, announces the GPU phase over AFTER the alignment and BEFORE
 *     the session copy — with the alignment FAILING, which is the path measured
 *     above. The render still completes, carrying the estimated transcript.
 *  2. It is announced ONCE: a session that has already said it is off the card
 *     does not say it again from the inline path.
 *  3. THE REAL `ttsConversionStep` turns that announcement into
 *     `StepRunContext.releaseGpu`, verbatim and for its own job only.
 *
 * The engine's half — that a handed-back slot is claimed by the next book while
 * the first row runs on — is in `tools/test-queue-engine.js`.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-steps', 'tts-conversion.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

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

// ─────────────────────────────────────────────────────────────────────────────
// 1. The SHIPPED completion tail
// ─────────────────────────────────────────────────────────────────────────────
//
// Lifted from the compiled bridge rather than re-written here, which is the
// whole point: a copy of the ordering written in this file would agree with
// itself for ever. `new Function` supplies the free names the tail calls; the
// arms it never reaches are compiled and never evaluated.

const bridgeJs = fs.readFileSync(path.join(DIST, 'parallel-tts-bridge.js'), 'utf-8');

/** The named function's source, from `async function X(` to the next `\n}` at column 0. */
function lift(name) {
  const start = bridgeJs.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`${name} is not in the compiled bridge — did it move?`);
  const end = bridgeJs.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name} has no closing brace at column 0 — did the emit change?`);
  return bridgeJs.slice(start, end + 3);
}

/**
 * THE CHANNEL NAME COMES FROM THE BRIDGE, never from this file. Restating the
 * string here would make the seam agree with itself while the app disagreed.
 */
function liftedChannel() {
  const m = bridgeJs.match(/exports\.TTS_GPU_PHASE_OVER = '([^']+)'/);
  // Null rather than a throw, so a build without the seam still RUNS this suite
  // and fails on the assertions rather than on the require.
  return m === null ? null : m[1];
}

/** Run the shipped tail with fakes, recording the order it did things in. */
async function runShippedTail({ skipAssembly, alignFails }) {
  const order = [];
  const completions = [];
  const session = {
    jobId: 'step_letter',
    cancelled: false,
    workers: [{ id: 0, status: 'complete', sentenceStart: 0, sentenceEnd: 343 }],
    prepInfo: {
      sessionDir: '/tmp/ebook-adf13b73',
      processDir: '/tmp/ebook-adf13b73/9bd91896',
      chaptersDirSentences: '/tmp/ebook-adf13b73/9bd91896/chapters/sentences',
      totalSentences: 344,
    },
    config: {
      skipAssembly,
      bfpPath: '/lib/projects/Letter_to_the_American_Church',
      settings: { language: 'en' },
    },
  };

  const noopLog = () => Promise.resolve();
  /*
   * The tail reaches its imports through TypeScript's emitted namespace objects
   * (`rolling_logger_1.getTTSLogger`), so those are supplied by name too. The
   * three enhancement bridges are only named on the inline arm past the
   * completeness gate, which no case here reaches; they are passed as empty
   * objects so a change that DID reach them fails loudly instead of quietly.
   */
  const tail = new Function(
    'runPostRenderAlignment', 'announceGpuPhaseOver', 'cacheSessionToProject',
    'emitComplete', 'activeSessions', 'logger',
    'rolling_logger_1', 'chapter_closer_1', 'denoise_bridge_1', 'rvc_models_1', 'rvc_bridge_1',
    'findMissingSentenceFiles', 'runAssembly', 'removeScratchSession', 'rendererSend',
    `${lift('completeAfterWorkers')}\nreturn completeAfterWorkers;`,
  )(
    async () => {
      order.push(alignFails ? 'align-failed' : 'align-ran');
    },
    (s, reason) => {
      // The REAL guard, not the real function: the shipped one also drops this
      // machine's GPU mutex, which has no meaning in a test process.
      if (s.gpuPhaseOver === true) return;
      s.gpuPhaseOver = true;
      order.push(`gpu-phase-over: ${reason}`);
    },
    async () => {
      order.push('cache-session');
      return { success: true, cachedSentencesDir: '/lib/projects/x/stages/03-tts/…/sentences' };
    },
    (s, ok, outputPath, error) => {
      order.push(`complete: ${ok ? 'ok' : 'failed'}`);
      completions.push({ ok, outputPath, error });
    },
    { delete: () => {} },
    { log: noopLog, logError: noopLog },
    { getTTSLogger: () => ({ info() {}, warn() {}, error() {} }) },
    { stopChapterCloser: async () => { order.push('stop-chapter-closer'); return null; } },
    {}, {}, {},
    async () => { order.push('completeness-gate'); return []; },
    async () => { order.push('assemble'); return '/lib/output/letter.m4b'; },
    async () => { order.push('remove-scratch'); },
    () => {},
  );

  await tail(session);
  return { order, completions, session };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The real step, with the bridge stubbed
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL = liftedChannel();

const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId, filename: electronId, loaded: true,
  exports: {
    app: {
      getPath: () => path.join(os.tmpdir(), 'bf-gpu-handoff-userdata'),
      getName: () => 'BookForge', isPackaged: false, getAppPath: () => REPO,
      on() {}, whenReady: () => Promise.resolve(),
    },
    BrowserWindow: class {}, ipcMain: { on() {}, handle() {} },
    powerSaveBlocker: { start() {}, stop() {} }, dialog: {}, shell: {},
  },
};

function stub(relative, exports) {
  const id = path.join(DIST, relative);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return exports;
}

/** What the step is told the bridge is doing. The run is driven from the test. */
const bridge = stub('parallel-tts-bridge.js', {
  TTS_GPU_PHASE_OVER: CHANNEL,
  setMainWindow() {},
  detectRecommendedWorkerCount: () => ({ count: 1 }),
  checkResumeStatusFast: async () => ({ success: false }),
  checkResumeStatusFromProcessDir: async () => ({ success: false }),
  findResumableProjectSession: async () => null,
  resumeParallelConversion: async () => ({ success: true }),
  cacheSessionToProject: async () => ({ success: false }),
  stopAndCacheParallelConversion: async () => {},
  /** Set by each test: what the bridge does once the step has called it. */
  drive: null,
  startParallelConversion(jobId) {
    if (bridge.drive) setTimeout(() => bridge.drive(jobId), 0);
    return Promise.resolve({ success: true });
  },
});
stub('rolling-logger.js', {
  getTTSLogger: () => ({ info() {}, warn() {}, error() {} }),
});
stub('queue-steps/runtime.js', {
  projectDirForStep: () => '/lib/projects/Letter_to_the_American_Church',
  queueMainWindow: () => null,
});

const busEvents = require(path.join(DIST, 'bridge-events.js'));
const { ttsConversionStep } = require(path.join(DIST, 'queue-steps', 'tts-conversion.js'));

/** A step context that records what the step asked the engine for. */
function fakeCtx(stepId) {
  const released = [];
  return {
    released,
    ctx: {
      jobId: 'job_1',
      stepId,
      step: { config: { language: 'en', ttsEngine: 'higgs', skipAssembly: true }, metrics: {}, wasInterrupted: false },
      job: {},
      input: { kind: 'epub', path: '/books/letter.epub' },
      signal: new AbortController().signal,
      report() {},
      releaseGpu: (reason) => released.push(reason),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
  console.log('1. the shipped completion tail');

  await check('THE ALIGNMENT FAILED AND THE SLOT IS STILL HANDED BACK — before the session copy', async () => {
    const { order, completions } = await runShippedTail({ skipAssembly: true, alignFails: true });
    const align = order.indexOf('align-failed');
    const handoff = order.findIndex((s) => s.startsWith('gpu-phase-over'));
    const copy = order.indexOf('cache-session');
    assert.ok(align >= 0, `the alignment did not run: ${order.join(' → ')}`);
    assert.ok(handoff >= 0, `THE GPU PHASE WAS NEVER ANNOUNCED: ${order.join(' → ')}`);
    assert.ok(handoff > align, `announced before the alignment: ${order.join(' → ')}`);
    assert.ok(copy > handoff,
      `the session copy ran while the row still held the card: ${order.join(' → ')}`);
    assert.deepStrictEqual(completions.map((c) => c.ok), [true],
      'a failed alignment must not fail the render — the book ships with the estimated transcript');
  });

  await check('a clean alignment hands it back at the same place', async () => {
    const { order } = await runShippedTail({ skipAssembly: true, alignFails: false });
    const handoff = order.findIndex((s) => s.startsWith('gpu-phase-over'));
    assert.ok(handoff > order.indexOf('align-ran') && handoff < order.indexOf('cache-session'),
      order.join(' → '));
  });

  await check('the reason names what settled, so the queue log says why the card is free', async () => {
    const { order } = await runShippedTail({ skipAssembly: true, alignFails: true });
    const line = order.find((s) => s.startsWith('gpu-phase-over'));
    assert.ok(/render/.test(line) && /align/.test(line), `unhelpful reason: ${line}`);
  });

  await check('the INLINE path announces once, after the alignment and before the assembly', async () => {
    // The CLI and the language-learning wizard, which assemble in the same step.
    // The enhancement passes are GPU work and run between those two points, so
    // the hand-off can only be at the end of them — never at the alignment.
    const { order } = await runShippedTail({ skipAssembly: false, alignFails: false });
    const announcements = order.filter((s) => s.startsWith('gpu-phase-over'));
    assert.strictEqual(announcements.length, 1,
      `the inline path announced ${announcements.length} times: ${order.join(' → ')}`);
    const at = order.indexOf(announcements[0]);
    assert.ok(at > order.indexOf('align-ran'), order.join(' → '));
    assert.ok(at < order.indexOf('assemble'),
      `the assembly ran while the row still held the card: ${order.join(' → ')}`);
  });

  console.log('2. the real step turns it into releaseGpu');

  await check('the bridge exports the channel the step listens on', () => {
    assert.ok(CHANNEL, 'the compiled bridge exports no TTS_GPU_PHASE_OVER — there is no seam');
  });

  await check('the step gives the slot back the moment the bridge says the card is free', async () => {
    const { ctx, released } = fakeCtx('step_letter');
    bridge.drive = (jobId) => {
      busEvents.publishBridgeEvent(CHANNEL, {
        jobId,
        reason: 'the render and the post-render alignment have settled',
      });
      // …and the completion arrives only much later, which is the defect: the
      // copy between the two used to be charged to the card.
      setTimeout(() => busEvents.publishBridgeEvent('parallel-tts:complete', {
        jobId, success: true, outputPath: '/s/sentences', sessionId: 'ebook-1', sessionDir: '/s',
      }), 5);
    };
    const out = await ttsConversionStep.run(ctx);
    assert.deepStrictEqual(released, ['the render and the post-render alignment have settled'],
      'the step did not hand the slot back, or did not pass the bridge\'s own words on');
    assert.strictEqual(out.kind, 'audio-session');
  });

  await check('an announcement for ANOTHER job is not this row\'s slot', async () => {
    const { ctx, released } = fakeCtx('step_fuhrer');
    bridge.drive = (jobId) => {
      busEvents.publishBridgeEvent(CHANNEL, { jobId: 'step_somebody_else', reason: 'not ours' });
      setTimeout(() => busEvents.publishBridgeEvent('parallel-tts:complete', {
        jobId, success: true, outputPath: '/s/sentences', sessionId: 'ebook-2', sessionDir: '/s',
      }), 5);
    };
    await ttsConversionStep.run(ctx);
    assert.deepStrictEqual(released, []);
  });

  await check('the listener is dropped when the step ends — a later announcement reaches nobody', async () => {
    const { ctx, released } = fakeCtx('step_done');
    bridge.drive = (jobId) => {
      busEvents.publishBridgeEvent('parallel-tts:complete', {
        jobId, success: true, outputPath: '/s/sentences', sessionId: 'ebook-3', sessionDir: '/s',
      });
    };
    await ttsConversionStep.run(ctx);
    busEvents.publishBridgeEvent(CHANNEL, { jobId: 'step_done', reason: 'too late' });
    assert.deepStrictEqual(released, [], 'a settled step must not be recharged by a stray event');
  });

  console.log(`\nnarration gpu hand-off: ${passed} test(s) passed, ${failures.length} failed`);
})();
