/**
 * narration-prep.js — the narration door on its own, headless.
 *
 * Owen, 2026-09-02: *"make sure the bookforge cli has a cleanup step independent
 * of the tts step, so the user can run one and then the other."* This is that
 * step. It runs `prepareNarrationInput` — the caption/footnote cut and the
 * number pass, the SAME exported function `startParallelConversion` calls — and
 * then stops, leaving the prepared copy and its `.edits.json` on disk.
 *
 * Because the copy is content-addressed by (input sha, rule version, model), a
 * later `--tts` or `--audiobook` on the same input finds it and reuses it
 * without a second model call: run the prep, read the record, then render.
 *
 * NOT `--ai-cleanup`. That is the OCR/model book-repair pass over an epub's
 * prose (ai-bridge.cleanupEpub) and it is a different job with a different
 * output. This one only decides what the NARRATOR is handed.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/narration-prep.js --input book.epub
 *   node --require ./cli/electron-stub.js cli/narration-prep.js --project "<dir>"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { USER_DATA } = require('./electron-stub.js');
const { resolveInputEpub } = require('./resolve-project-epub.js');
const { applyNarratorSessionsRoot } = require('./narrator-sessions-root.js');
const { runNarrationPrep } = require('./narration-prep-step.js');

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
  if (!args.project && !args.input) {
    throw new Error('--project <projectDir> or --input <file.epub|file.txt> is required');
  }
  if (args.project && args.input) {
    throw new Error('--project and --input both name what to prep; pass one');
  }

  // The project's book is resolved by the SAME record --audiobook uses, so
  // prepping a project and then rendering it prep the identical file — which is
  // what makes the second run find the copy this one wrote.
  let inputPath;
  if (args.project) {
    const projectDir = path.resolve(args.project);
    if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
      throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
    }
    // The RECORDED book, through manifest-service.bookForAct — the door every
    // act in the app resolves through. An unrecorded stray under source/ is
    // refused here exactly as the app would refuse it.
    inputPath = await resolveInputEpub(projectDir);
    console.log(`[prep] project book: ${inputPath}`);
    // The app keeps its narration cuts under the LIBRARY's scratch (or the
    // Settings override); prep there, or a later app render pays for the
    // model pass again because it looks for the copy somewhere else.
    const libraryRoot = path.dirname(path.dirname(projectDir));
    console.log(`[prep] scratch: ${applyNarratorSessionsRoot(libraryRoot)}`);
  } else {
    inputPath = path.resolve(args.input);
  }
  if (!fs.existsSync(inputPath)) throw new Error(`input file not found: ${inputPath}`);

  const bridge = require('../dist/electron/parallel-tts-bridge.js');

  // Real log sink (else logger calls spam ENOENT). CLI-specific dir so the app's
  // own worker-output.log is never clobbered.
  await bridge.initializeLogger(path.join(USER_DATA, 'cli'));

  // A job id of the CLI's own, so the door's log lines are attributable to this
  // run and not to a queued job that never happened.
  const jobId = `cli-prep-${crypto.randomUUID()}`;
  const t0 = Date.now();
  // 'required': this command IS the cleanup step, so a book it preps is one the
  // operator means to have cleaned. There is no skip here — skipping the cleanup
  // is a thing you ask of a RENDER, and this renders nothing.
  const prep = await runNarrationPrep(
    bridge, inputPath, jobId, { skipAssembly: true, textCleanup: 'required' });

  if (prep.recordPath === null) {
    console.log(`[prep] nothing written — ${inputPath} is already what the narrator reads`);
  } else {
    console.log(`[prep] copy:   ${prep.inputPath}`);
    console.log(`[prep] record: ${prep.recordPath}`);
    const tally = Object.entries(prep.dispositions).sort((a, b) => b[1] - a[1]);
    console.log(`[prep] dispositions: ${
      tally.length === 0 ? '(none proposed)' : tally.map(([k, n]) => `${k}=${n}`).join(' ')}`);
  }
  console.log(`[prep] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[prep] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
