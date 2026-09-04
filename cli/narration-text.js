/**
 * narration-text.js — the narration text cleanup on its own, headless.
 *
 * Owen, 2026-09-04: *"We should make this its own intentional step that the user
 * runs and persists, so we don't have to run it again. It runs the step on an
 * epub that foundry exported/completed and it creates an updated epub."* This is
 * that step from a shell: hand it an EPUB, get back a cleaned, stamped EPUB and
 * a receipt.
 *
 * It runs `runNarrationTextPass` out of the compiled dist — the SAME function
 * the app's `narration-text` queue job runs — through `narration-text-step.js`,
 * so a bug found here is a bug in the app.
 *
 * NOT `--prep`. That is the render door: the caption/endnote cut and the copy a
 * voice reads, made fresh per render and thrown away. This one edits the BOOK,
 * once, and the book remembers.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/narration-text.js --input book.epub
 *   node --require ./cli/electron-stub.js cli/narration-text.js --project "<dir>"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { USER_DATA } = require('./electron-stub.js');
const { resolveInputEpub } = require('./resolve-project-epub.js');
const { applyE2aScratchDir } = require('./e2a-scratch.js');
const { runNarrationTextStep } = require('./narration-text-step.js');

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
    throw new Error('--project <projectDir> or --input <file.epub> is required');
  }
  if (args.project && args.input) {
    throw new Error('--project and --input both name what to clean; pass one');
  }

  let inputPath;
  if (args.project) {
    const projectDir = path.resolve(args.project);
    if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
      throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
    }
    // The RECORDED book, through the same door every act in the app resolves.
    inputPath = await resolveInputEpub(projectDir);
    console.log(`[narration-text] project book: ${inputPath}`);
    // The intermediates go where the app's render door looks for them, so a
    // later render reuses this run's model answers instead of paying again.
    const libraryRoot = path.dirname(path.dirname(projectDir));
    console.log(`[narration-text] scratch: ${applyE2aScratchDir(libraryRoot)}`);
  } else {
    inputPath = path.resolve(args.input);
  }

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  // A real log sink, CLI-specific, so the app's own worker-output.log is never
  // clobbered by a headless run.
  await bridge.initializeLogger(path.join(USER_DATA, 'cli'));
  // A job id of this run's own, so the door's log lines are attributable to it.
  process.env.BOOKFORGE_CLI_JOB_ID = `cli-narration-text-${crypto.randomUUID()}`;

  const step = await runNarrationTextStep(inputPath, {
    ...(typeof args.model === 'string' ? { model: args.model } : {}),
  });
  if (!step.ran) {
    console.log('[narration-text] nothing written — the book is already what the narrator reads');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[narration-text] ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
