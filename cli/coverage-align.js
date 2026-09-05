/**
 * coverage-align.js — the ALIGN step on its own, headless.
 *
 * The app runs this as its own queue row between render and assembly
 * (`electron/queue-steps/align.ts`), and the row calls exactly one function:
 * `coverage-align-job.runCoverageAlign(stepId, {processDir, language},
 * queueMainWindow())`. This adapter calls that same function with the same
 * config and a null window, which the job supports (it publishes
 * `coverage-align:progress` on the in-process bus before it looks at a window).
 *
 * NOTHING ABOUT THE SPAWN LIVES HERE. `narrator align` is invoked by
 * `runCoverageAlign` through `buildNarratorSpawn` and the whisperx-env
 * interpreter it resolves — a second spawn builder in `cli/` would be the exact
 * drift this CLI exists to catch rather than cause. The report lands where
 * `coverageReportPath()` says, which is also where both assembly spawns look for
 * it, so an alignment run from here satisfies an assembly run from anywhere.
 *
 * WHY IT MATTERS: `assemble/coverage_gate.py` REFUSES a book from an engine
 * whose policy is enforced (higgs-v3) when no report is there. Without this
 * command the only headless way to satisfy that gate was to render the book
 * again through a chain that carried an Align row.
 *
 *   node --require ./cli/electron-stub.js cli/coverage-align.js \
 *        --project "<projectDir>" --language en
 *   node --require ./cli/electron-stub.js cli/coverage-align.js \
 *        --process-dir "<session>/<hash>" --language de
 */
'use strict';
const path = require('path');
const crypto = require('crypto');
require('./electron-stub.js');   // intercept require('electron') for the compiled job
const { resolveSessionTarget } = require('./session-target.js');

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) continue;
    const body = t.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) { a[body.slice(0, eq)] = body.slice(eq + 1); }
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { a[body] = argv[++i]; }
    else { a[body] = true; }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // NEVER DEFAULTED — the same refusal the app's step makes. The aligner loads a
  // per-language wav2vec2 checkpoint, and one pointed at the wrong language
  // scores every word badly, which the guard reads as "the audio did not say the
  // text" and refuses a book that was read correctly.
  const language = typeof args.language === 'string' ? args.language : null;
  if (!language) {
    throw new Error(
      '--language <code> is required: the aligner loads a different acoustic model for each '
      + 'language, and a guess here would refuse a book that was read correctly.');
  }
  const { processDir, projectDir } = await resolveSessionTarget(args);

  const job = require('../dist/electron/coverage-align-job.js');
  for (const fn of ['runCoverageAlign', 'stopCoverageAlign', 'coverageAlignPython',
                    'coverageReportPath']) {
    if (typeof job[fn] !== 'function') {
      throw new Error(
        `compiled coverage-align-job missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }
  // The plan-time check the narration dialog makes, made here for the same
  // reason: an absent aligner is cheap to say now and expensive to discover
  // after the render.
  if (job.coverageAlignPython() === null) {
    throw new Error(
      'the whisperx add-on is not installed, and the aligner runs in it. Install it in '
      + 'Settings -> Add-ons (whisperx-env) — narrator\'s own interpreters must not grow torch.');
  }
  const events = require('../dist/electron/bridge-events.js');

  const stepId = `cli-align-${crypto.randomUUID()}`;
  console.log(`[align] session: ${processDir}${projectDir ? ` (project ${path.basename(projectDir)})` : ''}`);
  console.log(`[align] report:  ${job.coverageReportPath(processDir)}`);

  let lastPct = -1;
  const off = events.onBridgeEvent('coverage-align:progress', (e) => {
    if (e.jobId !== stepId) return;
    const p = e.progress || {};
    const pct = Math.floor(p.percentage ?? 0);
    if (pct === lastPct && p.phase !== 'error') return;
    lastPct = pct;
    const counted = p.total ? ` ${p.processed}/${p.total} chunk(s)` : '';
    console.log(`[align] ${p.phase} ${pct}%${counted}${p.message ? ` — ${p.message}` : ''}`);
  });

  let stopping = false;
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[align] ${sig} — stopping the aligner...`);
    job.stopCoverageAlign(stepId);
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  const t0 = Date.now();
  const result = await job.runCoverageAlign(stepId, { processDir, language }, null);
  off();
  if (!result || !result.success) {
    throw new Error(`alignment failed: ${result && result.error ? result.error : 'unknown'}`);
  }
  console.log(`[align] ${result.chunksAligned} chunk(s) aligned -> ${result.reportPath}`);
  console.log(`[align] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[align] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
