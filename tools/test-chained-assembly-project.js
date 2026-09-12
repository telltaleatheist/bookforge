#!/usr/bin/env node
/**
 * Tests for WHICH PROJECT A SESSION-CONSUMING ROW IS ABOUT, and for the session
 * a narration hands the row behind it.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-chained-assembly-project.js
 *
 * ── The incident this file is named for ─────────────────────────────────────
 *
 * Owen, 2026-09-12 16:31. Foundry "Clean text" on *Starcraft 1. Liberty's
 * Crusade* → Narrate from the pending export. The chain was
 * `foundry-job` → `foundry-export-landing` → `tts-conversion` → `reassembly`.
 * The render finished — 518 chunks, 101.7 raw sentences a minute, cached under
 * `stages/03-tts/sessions/en/` — and the assembly failed one millisecond after
 * starting:
 *
 *   "This assembly row names no narration session and no project, so there is
 *    nothing for it to assemble."
 *
 * Both halves of that sentence were wrong, and each was its own bug:
 *
 *  1. THE ROW NAMED A PROJECT. Its config carried
 *     `bfpPath: <the project dir>` — every row of a narration plan does
 *     (shared/queue/narration-run.ts § NarrationStepPlan) — and the step read
 *     `ctx.job.projectId` and nothing else. A Foundry-ORDERED run has no
 *     `projectId`: it is enqueued with a `documentPath` and no project. Four
 *     other steps had the identical shape, so the rule is now one function,
 *     `projectDirForStep`.
 *  2. THE ROW NAMED A SESSION, or should have. `tts-conversion` reported the
 *     CACHED sentences beside e2a's SCRATCH session dir and no `processDir` at
 *     all, so the assembly could not read a session off its own input and went
 *     looking for a project to ask. It now states the durable session it just
 *     published, and a chained assembly needs no project at all.
 *
 * The third half — the finished M4B being linked to its project, and Studio
 * reloading — lives on the job's `projectId` and is pinned in
 * `tools/test-queue-engine.js`.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'queue-steps', 'runtime.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}

/*
 * A STUB ELECTRON, SEEDED BEFORE ANYTHING IS REQUIRED.
 *
 * The step modules are main-process code and their bridges import `electron` at
 * load. Seeding `require.cache` for it is what lets this suite drive the REAL
 * `reassemblyStep` — the module whose resolution order is the bug — rather than
 * a copy of its logic written in the test, which is the one thing a regression
 * test for this must not be.
 */
const electronId = require.resolve('electron');
require.cache[electronId] = {
  id: electronId, filename: electronId, loaded: true,
  exports: {
    app: {
      getPath: () => path.join(os.tmpdir(), 'bf-chained-assembly-userdata'),
      getName: () => 'BookForge', isPackaged: false, getAppPath: () => REPO,
      on() {}, whenReady: () => Promise.resolve(),
    },
    BrowserWindow: class {}, ipcMain: { on() {}, handle() {} },
    powerSaveBlocker: { start() {}, stop() {} }, dialog: {}, shell: {},
  },
};

/** Stub a compiled module by path, before its consumer is loaded. */
function stub(relative, exports) {
  const id = path.join(DIST, relative);
  require.cache[id] = { id, filename: id, loaded: true, exports };
  return exports;
}

const bridge = stub('reassembly-bridge.js', {
  /** Every call is recorded; the test reads what the step asked for. */
  calls: [], cachedLookups: [],
  startReassembly(stepId, config) {
    bridge.calls.push({ stepId, config });
    return Promise.resolve({ success: true, outputPath: '/lib/output/starcraft.m4b' });
  },
  stopReassembly() {},
  getBfpCachedSession(projectDir) {
    bridge.cachedLookups.push(projectDir);
    return Promise.resolve({
      sessionId: 'from-the-project-cache',
      sessionDir: `${projectDir}/stages/03-tts/sessions/en/ebook-cache`,
      processDir: `${projectDir}/stages/03-tts/sessions/en/ebook-cache/hash`,
      chapters: [{ excluded: false }, { excluded: false }],
    });
  },
});
stub('bridge-events.js', { onBridgeEvent: () => () => {} });
stub('coverage-align-job.js', {
  coverageReportPath: (processDir) => `${processDir}/coverage.json`,
  summarizeCoverageReport: () => null,
});

const { projectDirForStep } = require(path.join(DIST, 'queue-steps', 'runtime.js'));
const { reassemblyStep } = require(path.join(DIST, 'queue-steps', 'reassembly.js'));
const { findCachedSessionLayout } = require(path.join(DIST, 'session-cache-layout.js'));

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-chained-assembly-'));
const tests = [];
let passed = 0;
const failures = [];
const test = (name, fn) => tests.push({ name, fn });

/* ── The failed job, as queue-engine.json recorded it ──────────────────────── */

const PROJECT = "/Volumes/iO/bookforge/projects/Starcraft_1._Liberty_s_Crusade_-_Jeff_Grubb_(2001)";
const CACHED_SESSION = `${PROJECT}/stages/03-tts/sessions/en/ebook-c0030f67-b6d0-48a1-b472-a9ab90f27f9b`;
const CACHED_PROCESS = `${CACHED_SESSION}/a3f430c50aa7371ee0617a8fd4900384`;

/** The step's config, verbatim from the failed row (job_mtyr7fex_6fe410f7). */
const ASSEMBLY_CONFIG = {
  type: 'reassembly',
  // The plan writes empty strings for a session that does not exist at compose
  // time. They are NOT answers, and that is half of what the helper is for.
  sessionId: '', sessionDir: '', processDir: '',
  outputDir: `${PROJECT}/output`,
  metadata: {
    title: "Starcraft 1. Liberty's Crusade", author: 'Jeff Grubb', year: 2001,
    outputFilename: "Starcraft 1. Liberty's Crusade. Grubb, Jeff. (2001).m4b",
  },
  excludedChapters: [], applyDeRing: false, chapterGap: 3,
  registerAsNewVariant: false,
  bfpPath: PROJECT,
};

/** The narration's artifact as it was: cached sentences, SCRATCH session, no processDir. */
const TTS_ARTIFACT_BEFORE = {
  kind: 'audio-session',
  path: `${CACHED_PROCESS}/chapters/sentences`,
  sessionId: 'c0030f67-b6d0-48a1-b472-a9ab90f27f9b',
  sessionDir: '/Volumes/iO/bookforge/tmp/ebook-c0030f67-b6d0-48a1-b472-a9ab90f27f9b',
  detail: { projectDir: PROJECT, language: 'en', skipAssembly: true },
};

/** And as it is now: the durable session it just published, all three names. */
const TTS_ARTIFACT_AFTER = {
  ...TTS_ARTIFACT_BEFORE,
  sessionDir: CACHED_SESSION,
  processDir: CACHED_PROCESS,
};

function runContext(config, input, job = {}) {
  const reports = [];
  return {
    ctx: {
      jobId: 'job_mtyr7fex_6fe410f7', stepId: 'step_mtyr7ron_3a78339f',
      step: { config, metrics: {} }, job, input,
      signal: { aborted: false },
      report: (update) => reports.push(update),
    },
    reports,
  };
}

// ── (a) the helper ──────────────────────────────────────────────────────────

test('projectDirForStep reads the ROW first and the RUN last', () => {
  const ctx = {
    input: { detail: { projectDir: '/lib/from-the-artifact' } },
    job: { projectId: '/lib/from-the-run' },
  };
  assert.strictEqual(
    projectDirForStep(ctx, { bfpPath: '/lib/book', projectDir: '/lib/article' }), '/lib/book',
    'a BOOK row states bfpPath, and it wins');
  assert.strictEqual(
    projectDirForStep(ctx, { projectDir: '/lib/article' }), '/lib/article',
    'an ARTICLE row states projectDir; exactly one of the two is ever set');
  assert.strictEqual(
    projectDirForStep(ctx, {}), '/lib/from-the-artifact',
    'a row that states neither takes what the artifact in front of it said');
  assert.strictEqual(
    projectDirForStep({ input: { detail: {} }, job: { projectId: '/lib/from-the-run' } }, {}),
    '/lib/from-the-run',
    "and the run's own project is the answer of last resort");
});

test('an EMPTY project is not an answer, and nothing at all is refused', () => {
  const ctx = { input: { detail: { projectDir: '/lib/from-the-artifact' } }, job: {} };
  assert.strictEqual(
    projectDirForStep(ctx, { bfpPath: '', projectDir: '' }), '/lib/from-the-artifact',
    "the plan writes '' for what does not exist yet — it must fall through, not name the root");
  assert.strictEqual(
    projectDirForStep({ input: { detail: {} }, job: { projectId: '' } }, { sessionId: '' }),
    undefined,
    'nothing answered, so the STEP gets to refuse in its own words');
  assert.strictEqual(projectDirForStep({}, null), undefined, 'no config and no context at all');
});

// ── (c) the real assembly row, on the failed job's shapes ───────────────────

test("the failed row's OWN config answers: bfpPath, with no processDir on the input", async () => {
  bridge.calls.length = 0; bridge.cachedLookups.length = 0;
  const { ctx } = runContext(ASSEMBLY_CONFIG, TTS_ARTIFACT_BEFORE, {
    // THE FOUNDRY-ORDERED RUN: a documentPath and no project. This is the
    // header that made the old code refuse.
    id: 'job_mtyr7fex_6fe410f7',
    documentPath: '/Volumes/iO/bookforge/foundry/projects/Starcraft-.../generated/starcraft.epub',
  });
  const out = await reassemblyStep.run(ctx);
  assert.strictEqual(out.kind, 'm4b');
  assert.deepStrictEqual(bridge.cachedLookups, [PROJECT],
    "the row's own bfpPath is what the project cache was asked about");
  assert.strictEqual(bridge.calls.length, 1);
  assert.strictEqual(bridge.calls[0].config.processDir,
    `${PROJECT}/stages/03-tts/sessions/en/ebook-cache/hash`,
    'and the session it assembles is the one that cache answered with');
});

test('a run with no project, no bfpPath and no session still refuses BY NAME', async () => {
  const { ctx } = runContext(
    { ...ASSEMBLY_CONFIG, bfpPath: undefined }, { kind: 'audio-session' }, { id: 'job_x' });
  await assert.rejects(() => reassemblyStep.run(ctx),
    /names no narration session and no project/,
    'the refusal wording is the operator-facing half of this fix and must survive it');
});

test('the NEW narration artifact needs no project at all — it names the whole session', async () => {
  bridge.calls.length = 0; bridge.cachedLookups.length = 0;
  const { ctx } = runContext(ASSEMBLY_CONFIG, TTS_ARTIFACT_AFTER, { id: 'job_mtyr7fex_6fe410f7' });
  await reassemblyStep.run(ctx);
  assert.deepStrictEqual(bridge.cachedLookups, [],
    'a chained assembly must not go to disk looking for a session it was handed');
  assert.strictEqual(bridge.calls[0].config.sessionDir, CACHED_SESSION);
  assert.strictEqual(bridge.calls[0].config.processDir, CACHED_PROCESS);
  assert.strictEqual(bridge.calls[0].config.sessionId,
    'c0030f67-b6d0-48a1-b472-a9ab90f27f9b');
});

// ── (d) the three names a published cache states ────────────────────────────

test('a cached session states its sessionDir, processDir and sentencesDir', async () => {
  // e2a's ordinary shape: ebook-<uuid>/<content hash>/chapters/sentences.
  const sessionDir = path.join(SCRATCH, 'ebook-c0030f67');
  const processDir = path.join(sessionDir, 'a3f430c50aa7371ee0617a8fd4900384');
  fs.mkdirSync(path.join(processDir, 'chapters', 'sentences'), { recursive: true });
  fs.writeFileSync(path.join(processDir, 'session-state.json'), '{"chapter_sentences":[]}');

  const layout = await findCachedSessionLayout(sessionDir);
  assert.deepStrictEqual(layout, {
    sessionDir,
    processDir,
    sentencesDir: path.join(processDir, 'chapters', 'sentences'),
  }, 'all three, so cacheSessionToProject states them instead of the caller deriving them');
});

test('the flat shape answers too, and a directory that is no session answers null', async () => {
  const flat = path.join(SCRATCH, 'ebook-flat');
  fs.mkdirSync(path.join(flat, 'chapters', 'sentences'), { recursive: true });
  assert.deepStrictEqual(await findCachedSessionLayout(flat), {
    sessionDir: flat, processDir: flat, sentencesDir: path.join(flat, 'chapters', 'sentences'),
  });

  const empty = path.join(SCRATCH, 'ebook-empty');
  fs.mkdirSync(path.join(empty, 'chapters'), { recursive: true });
  assert.strictEqual(await findCachedSessionLayout(empty), null,
    'null is not an error here — each caller has its own thing to say about it');
  assert.strictEqual(await findCachedSessionLayout(path.join(SCRATCH, 'nope')), null);
});

(async () => {
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ok    ${name}`);
    } catch (err) {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    }
  }
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`\nchained-assembly-project: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
