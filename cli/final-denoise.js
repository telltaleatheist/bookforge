/**
 * final-denoise.js — the FINAL-DENOISE step on its own, headless.
 *
 * The app runs this as its own queue row since 2026-08-29
 * (`electron/queue-steps/final-denoise.ts`), and the row calls exactly one
 * function: `denoise-job.runFinalDenoise(stepId, config, queueMainWindow())`.
 * This adapter calls that same function with the same config shape and a null
 * window — which `runFinalDenoise` supports by design (it publishes
 * `final-denoise:progress` on the in-process bus BEFORE it looks at a window,
 * and `queueMainWindow()` is itself null in a headless run). Nothing about the
 * pass is re-implemented here: this file resolves the session, subscribes to
 * the bridge's own progress events, and prints them.
 *
 * WHY IT IS ITS OWN COMMAND. `--audiobook` already runs the denoise between
 * generation and assembly, so a bug there could only be reproduced by paying
 * for a whole render first. The set it writes is DURABLE (a sibling of the raw
 * cache with a manifest saying what it was derived from), so a second run over
 * the same session reuses it and says so.
 *
 *   node --require ./cli/electron-stub.js cli/final-denoise.js \
 *        --project "<projectDir>" [--sentence-gap 0.6]
 *   node --require ./cli/electron-stub.js cli/final-denoise.js \
 *        --process-dir "<session>/<hash>" [--sentences-dir <upstream set>]
 *
 * `--sentences-dir` is the pass reading ANOTHER pass's output (the "convert
 * first, then denoise" order). The job REFUSES it alongside --sentence-gap
 * rather than ignoring one of them, and so does this door — the gap can only be
 * applied to raw audio.
 */
'use strict';
const fs = require('fs');
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
  const { processDir, projectDir } = await resolveSessionTarget(args);

  const denoiseJob = require('../dist/electron/denoise-job.js');
  for (const fn of ['runFinalDenoise', 'stopFinalDenoise']) {
    if (typeof denoiseJob[fn] !== 'function') {
      throw new Error(`compiled denoise-job missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }
  const events = require('../dist/electron/bridge-events.js');

  const config = { processDir };
  if (args['sentences-dir'] !== undefined) {
    const dir = path.resolve(args['sentences-dir']);
    if (!fs.existsSync(dir)) throw new Error(`--sentences-dir not found: ${dir}`);
    config.sentencesDir = dir;
  }
  if (args['sentence-gap'] !== undefined && args['sentence-gap'] !== true) {
    const gap = parseFloat(args['sentence-gap']);
    if (!Number.isFinite(gap) || gap < 0) {
      throw new Error(`--sentence-gap must be a non-negative number, got: ${args['sentence-gap']}`);
    }
    config.sentenceGap = gap;
  }

  const jobId = `cli-denoise-${crypto.randomUUID()}`;
  console.log(`[denoise] session: ${processDir}${projectDir ? ` (project ${path.basename(projectDir)})` : ''}`);

  let lastPct = -1;
  const off = events.onBridgeEvent('final-denoise:progress', (e) => {
    if (e.jobId !== jobId) return;
    const p = e.progress || {};
    const pct = Math.floor(p.percentage ?? 0);
    if (pct === lastPct && p.phase !== 'error') return;
    lastPct = pct;
    const counted = p.total ? ` ${p.processed}/${p.total} block(s)` : '';
    console.log(`[denoise] ${p.phase} ${pct}%${counted}${p.message ? ` — ${p.message}` : ''}`);
  });

  let stopping = false;
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[denoise] ${sig} — aborting the pass (the partial set is abandoned, not committed)...`);
    denoiseJob.stopFinalDenoise(jobId);
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  const t0 = Date.now();
  const result = await denoiseJob.runFinalDenoise(jobId, config, null);
  off();
  if (!result || !result.success) {
    throw new Error(`final denoise failed: ${result && result.error ? result.error : 'unknown'}`);
  }
  console.log(result.reused
    ? `[denoise] REUSED (already derived for this session): ${result.outputDir}`
    : `[denoise] wrote: ${result.outputDir}`);
  console.log(`[denoise] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[denoise] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
