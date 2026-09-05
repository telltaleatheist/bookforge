/**
 * narration-text.js — the narration text cleanup on its own, headless.
 *
 * Owen, 2026-09-04: *"We should make this its own intentional step that the user
 * runs and persists, so we don't have to run it again. It runs the step on an
 * epub that foundry exported/completed and it creates an updated epub."* This is
 * that step from a shell: hand it an EPUB, get it back cleaned and stamped, with
 * a receipt beside it.
 *
 * It runs `cleanTextEpub` out of the compiled dist - the SAME door the app's
 * `narration-text` queue job runs, which spawns `foundry clean-text --epub` -
 * through `narration-text-step.js`, so a bug found here is a bug in the app.
 *
 * `--input` IS THE FAILSAFE and it REPLACES THE FILE (Owen, 2026-09-05). The
 * standard method is the Clean text step in the Foundry window, where the
 * cleanup is a position on the document chain; a file remembers nothing about
 * how it was made, so a re-export from the project loses this one.
 *
 * NOT `--prep`. That is the render door: the caption/endnote cut and the copy a
 * voice reads, made fresh per render and thrown away. This one edits the BOOK,
 * once, and the book remembers.
 *
 * Run via the electron shim preload:
 *   node --require ./cli/electron-stub.js cli/narration-text.js --input book.epub
 *   node --require ./cli/electron-stub.js cli/narration-text.js --project "<dir>"
 *   node --require ./cli/electron-stub.js cli/narration-text.js --project "<dir>" --family <id>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { USER_DATA } = require('./electron-stub.js');
const { applyNarratorSessionsRoot } = require('./narrator-sessions-root.js');
const { runNarrationTextStep } = require('./narration-text-step.js');
const { runProjectPass } = require('./processing-pass-step.js');

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

/**
 * A PROJECT is cleaned through the app's own pass, not beside it.
 *
 * The adversarial review of 2026-09-04: writing "<stem>.narration.epub" next to
 * a project's book and touching nothing else left the project reading MISSING in
 * the app while its file carried a current stamp — the exact divergence that
 * made the re-run deadlock reachable. A project has a ledger, a provenance
 * record and a working copy to promote into; the pass that knows how to do all
 * three is `runProcessingPass`, and this calls it.
 *
 * So --project and --input are two different acts on purpose. --project is the
 * app's pass, headless. --input is the bare-EPUB door, for a file with no
 * project around it.
 */
async function cleanProject(projectDir, model, familyArg) {
  if (model) {
    console.log('[narration-text] note: --model is ignored. The cleanup runs '
      + '`foundry clean-text`, which takes its model and its Ollama endpoint from the same '
      + 'settings the hosted Clean text press uses, so the two doors cannot run different '
      + 'models.');
  }
  await runProjectPass(projectDir, { kind: 'narration-text' },
    { family: familyArg, label: 'narration-text' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project && !args.input) {
    throw new Error('--project <projectDir> or --input <file.epub> is required');
  }
  if (args.project && args.input) {
    throw new Error('--project and --input both name what to clean; pass one');
  }

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  // A real log sink, CLI-specific, so the app's own worker-output.log is never
  // clobbered by a headless run.
  await bridge.initializeLogger(path.join(USER_DATA, 'cli'));

  if (args.project) {
    const projectDir = path.resolve(args.project);
    if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
      throw new Error(`not a BookForge project (no manifest.json): ${projectDir}`);
    }
    // The intermediates go where the app's render door looks for them, so a
    // later render reuses this run's model answers instead of paying again.
    const libraryRoot = path.dirname(path.dirname(projectDir));
    console.log(`[narration-text] scratch: ${applyNarratorSessionsRoot(libraryRoot)}`);
    await cleanProject(
      projectDir,
      typeof args.model === 'string' ? args.model : null,
      typeof args.family === 'string' ? args.family : null);
    process.exitCode = 0;
    return;
  }

  const step = await runNarrationTextStep(path.resolve(args.input), {
    ...(typeof args.model === 'string' ? { model: args.model } : {}),
  });
  if (!step.ran) {
    console.log('[narration-text] nothing written — the book is already what the narrator reads');
  }
  process.exitCode = 0;
}

main().catch((e) => {
  console.error('\n[narration-text] ERROR:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
