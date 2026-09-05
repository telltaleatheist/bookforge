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
 *   node --require ./cli/electron-stub.js cli/narration-text.js --project "<dir>" --family <id>
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { USER_DATA } = require('./electron-stub.js');
const { applyNarratorSessionsRoot } = require('./narrator-sessions-root.js');
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
  const { planProcessingChain } = require('../dist/electron/processing-chain.js');
  const { runProcessingPass } = require('../dist/electron/processing-passes.js');
  const manifestService = require('../dist/electron/manifest-service.js');

  // ── WHICH CHAIN, when the project holds more than one ────────────────────
  //
  // A project with two archive EPUBs has two chains and every resolver refuses
  // to guess between them, so `--project` alone could not clean one at all (the
  // third adversarial review, 2026-09-04). `--family` names it, by id or by the
  // stem of the file it was minted from, and a project that needs one and was
  // not given one is told which are there.
  const families = (await manifestService.readProjectManifest(projectDir)).families ?? [];
  let sourcePath;
  if (families.length > 1) {
    const wanted = typeof familyArg === 'string' ? familyArg.toLowerCase() : null;
    const stemOf = (f) => path.basename(f.source.path).replace(/\.[^.]+$/, '');
    const chosen = wanted === null ? null : families.find((f) =>
      f.id.toLowerCase() === wanted || stemOf(f).toLowerCase() === wanted);
    if (chosen === null || chosen === undefined) {
      const list = families.map((f) => `  ${f.id}    ${stemOf(f)}`).join('\n');
      throw new Error(
        `${path.basename(projectDir)} holds ${families.length} book chains, and nothing can `
        + 'guess which one to clean. Name it with --family <id|stem>:\n' + list
        + (wanted === null ? '' : `\n(no chain answers to "${familyArg}")`));
    }
    const book = await manifestService.ensureBookEpub(projectDir, chosen.id);
    sourcePath = book.absPath;
    console.log(`[narration-text] chain: ${chosen.id} (${stemOf(chosen)})`);
  } else if (typeof familyArg === 'string') {
    console.log('[narration-text] note: --family is ignored; this project has one chain.');
  }

  const plan = await planProcessingChain({
    projectDir,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    passes: [{ kind: 'narration-text' }],
  });
  if (plan.jobs.length !== 1) {
    throw new Error(`the planner produced ${plan.jobs.length} jobs for one pass`);
  }
  console.log(`[narration-text] project book: ${plan.bookEpubPath}`);
  console.log(`[narration-text] stage: ${plan.jobs[0].config.stageRelDir}`);
  if (model) console.log(`[narration-text] note: --model is ignored for a project run; `
    + 'the app reads its model from Settings so the pass and the app agree.');

  const jobId = `cli-narration-text-${crypto.randomUUID()}`;
  const t0 = Date.now();
  const result = await runProcessingPass(jobId, plan.jobs[0].config, null);
  console.log(`[narration-text] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!result.success) throw new Error(result.error || 'the pass failed and gave no reason');
  console.log(`[narration-text] book:    ${result.outputPath}`);
  if (result.narrationInputPath) {
    console.log(`[narration-text] to narrate: ${result.narrationInputPath}`);
  }
  console.log(`[narration-text] ${result.summary}`);
  if (result.ledgerEntryId) console.log(`[narration-text] ledger: ${result.ledgerEntryId}`);
  if (result.ledgerRefusal) console.log(`[narration-text] ledger: ${result.ledgerRefusal}`);
  if (result.narrationCarryNote) {
    console.log(`[narration-text] strikes: ${result.narrationCarryNote}`);
  }
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
    process.exit(0);
  }

  const step = await runNarrationTextStep(path.resolve(args.input), {
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
