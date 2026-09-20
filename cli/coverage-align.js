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
 * WHY IT MATTERS: it is the only headless way to MEASURE a rendered book. The
 * report does not gate assembly (Owen, 2026-09-05 — assembly assembles whatever
 * was rendered and reports what the audit found), but without it nothing says
 * which chunks came out wrong, and the sentence transcript is proportional
 * estimates rather than real word timings.
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
  for (const fn of ['runCoverageAlign', 'stopCoverageAlign', 'coverageReportPath']) {
    if (typeof job[fn] !== 'function') {
      throw new Error(
        `compiled coverage-align-job missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }
  /*
   * NO PLAN-TIME GATE ANY MORE (2026-09-19, bug hunt finding B2).
   *
   * There was one here — `coverageAlignPython() === null` → refuse — on the
   * argument that an absent aligner is cheap to say now and expensive to
   * discover after a render. True, and it was asking about the wrong machine:
   * the model runs on a Crucible server and narrator's half runs in the TOOLS
   * env, so a local `qwen-align` conda env is not what decides whether this
   * door can work. It refused, by name, on machines that would have aligned
   * fine. The refusal that is left is `runCoverageAlign`'s own, made once,
   * naming the server it could not reach or the thing that server would not do.
   */
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
  /*
   * `gpu`, BECAUSE THERE IS NO OTHER ANSWER LEFT (2026-09-19, bug hunt §H).
   *
   * This said `cpu` until today, on the 2026-09-07 argument that the Assembly
   * tab's GPU option exists because a QUEUE can hold a row until the card is
   * free, and a door with no queue behind it should not compete with whatever
   * is rendering. That argument was about a local spawn on this machine's card.
   * It is not where the aligner runs any more: `runCoverageAlign` sends every
   * alignment to the Crucible the session's own record names, and a Crucible
   * has only the card — so `runCoverageAlignOnCrucible` refuses anything but
   * `gpu` BY NAME (`crucible_align_cpu_row`). A door that asks for the CPU is
   * a door that cannot run at all, which is what this one had become.
   *
   * Competing for the card is the SERVER's question now, and it answers it:
   * a machine already running somebody's job refuses with its own holder line
   * rather than being quietly shared.
   *
   * There is deliberately no `--device` flag here. The choice the app's row
   * still carries is about a local spawn nothing reaches any more; inventing a
   * flag for it would offer a setting whose only two values are "run" and
   * "refused by name".
   */
  const result = await job.runCoverageAlign(
    stepId, { processDir, language, device: 'gpu' }, null);
  off();
  // FAILURE HERE MEANS THE RUN COULD NOT HAPPEN — no session, no aligner, a dead
  // worker. A pass that measured every chunk and doubted some of them succeeded
  // and says so on the next line.
  if (!result || !result.success) {
    throw new Error(`alignment failed: ${result && result.error ? result.error : 'unknown'}`);
  }
  console.log(`[align] ${result.chunksAligned} chunk(s) aligned, `
    + `${result.chunksFailed ?? 0} failed coverage, `
    + `${result.chunksErrored ?? 0} could not be placed -> ${result.reportPath}`);
  if (result.retakeIndices && result.retakeIndices.length > 0) {
    console.log(`[align] retake: ${result.retakeIndices.join(',')}`);
  }
  console.log(`[align] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[align] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
