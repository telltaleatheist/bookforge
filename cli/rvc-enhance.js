/**
 * rvc-enhance.js — the RVC-ENHANCEMENT step on its own, headless.
 *
 * The app's chain runs this as its own queue row
 * (`electron/queue-steps/rvc-enhancement.ts`), and the row calls exactly one
 * function: `rvc-job.runRvcEnhancement(stepId, config, queueMainWindow())`.
 * This adapter calls that same function with the same config shape and a null
 * window, which the job supports by design (it publishes `rvc:progress` on the
 * in-process bus before it looks at a window, and `queueMainWindow()` is itself
 * null headless). No conversion logic lives here.
 *
 * NOT `--rvc` (cli/rvc-convert.js). That drives
 * `rvc-bridge.convertFileRvcChunked` over ONE FINISHED AUDIO FILE — the
 * memory-safe whole-book reconstruction. THIS is the pass the app runs over a
 * session's PER-SENTENCE cache, writing a durable derived set that assembly
 * then reads via `--sentences_dir`. Two different jobs with two different
 * outputs; the CLI names both rather than picking one and calling it "RVC".
 *
 *   node --require ./cli/electron-stub.js cli/rvc-enhance.js \
 *        --project "<projectDir>" --voice-id builtin:deathstalker-sigma \
 *        [--index-rate 0.3] [--protect-rate 0.1] [--f0-method rmvpe] [--sentence-gap 0.6]
 *
 * `--sentences-dir` is this pass reading a DENOISE's output (the "denoise
 * first, then convert" order). The job refuses it alongside --sentence-gap
 * rather than ignoring one, and so does this door.
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

/** A numeric flag, or absent. Absent is NOT zero and NOT a default invented here —
 *  the job leaves an absent field on urvc's own default, which is the app's behaviour. */
function optionalNumber(args, name) {
  if (args[name] === undefined || args[name] === true) return undefined;
  const n = Number(args[name]);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got: ${args[name]}`);
  return n;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const voiceId = args['voice-id'];
  if (!voiceId) {
    throw new Error('--voice-id <rvc asset id> is required (e.g. builtin:deathstalker-sigma)');
  }
  const { processDir, projectDir } = await resolveSessionTarget(args);

  const rvcJob = require('../dist/electron/rvc-job.js');
  for (const fn of ['runRvcEnhancement', 'stopRvcEnhancement']) {
    if (typeof rvcJob[fn] !== 'function') {
      throw new Error(`compiled rvc-job missing ${fn} — rebuild (npx tsc -p tsconfig.electron.json)`);
    }
  }
  const events = require('../dist/electron/bridge-events.js');

  const config = { processDir, voiceId };
  for (const [flag, field] of [['index-rate', 'indexRate'], ['protect-rate', 'protectRate'],
                               ['n-semitones', 'nSemitones'], ['hop-length', 'hopLength']]) {
    const v = optionalNumber(args, flag);
    if (v !== undefined) config[field] = v;
  }
  if (args['f0-method']) config.f0Method = args['f0-method'];
  if (args['sentences-dir'] !== undefined) {
    const dir = path.resolve(args['sentences-dir']);
    if (!fs.existsSync(dir)) throw new Error(`--sentences-dir not found: ${dir}`);
    config.sentencesDir = dir;
  }
  const gap = optionalNumber(args, 'sentence-gap');
  if (gap !== undefined) {
    if (gap < 0) throw new Error(`--sentence-gap must be a non-negative number, got: ${gap}`);
    config.sentenceGap = gap;
  }

  const jobId = `cli-rvc-${crypto.randomUUID()}`;
  console.log(`[rvc-enhance] session: ${processDir}${projectDir ? ` (project ${path.basename(projectDir)})` : ''}`);
  console.log(`[rvc-enhance] voice: ${voiceId}`);

  let lastPct = -1;
  const off = events.onBridgeEvent('rvc:progress', (e) => {
    if (e.jobId !== jobId) return;
    const p = e.progress || {};
    const pct = Math.floor(p.percentage ?? 0);
    if (pct === lastPct && p.phase !== 'error') return;
    lastPct = pct;
    const counted = p.total ? ` ${p.processed}/${p.total} sentence(s)` : '';
    console.log(`[rvc-enhance] ${p.phase} ${pct}%${counted}${p.message ? ` — ${p.message}` : ''}`);
  });

  let stopping = false;
  const stopAndExit = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[rvc-enhance] ${sig} — aborting (the partial set is abandoned, not committed)...`);
    rvcJob.stopRvcEnhancement(jobId);
  };
  process.on('SIGINT', () => stopAndExit('SIGINT'));
  process.on('SIGTERM', () => stopAndExit('SIGTERM'));

  const t0 = Date.now();
  const result = await rvcJob.runRvcEnhancement(jobId, config, null);
  off();
  if (!result || !result.success) {
    throw new Error(`rvc enhancement failed: ${result && result.error ? result.error : 'unknown'}`);
  }
  console.log(result.reused
    ? `[rvc-enhance] REUSED (already derived for this session): ${result.scratchDir}`
    : `[rvc-enhance] wrote: ${result.scratchDir}`);
  console.log(`[rvc-enhance] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[rvc-enhance] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
