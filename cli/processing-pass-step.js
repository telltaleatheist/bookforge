/**
 * processing-pass-step.js — running ONE of the app's processing passes on a
 * project, headless, through the app's own planner and runner.
 *
 * The four passes — simplify, translate, footnote-refs, narration-text — are one
 * door in the app: `processing-chain.planProcessingChain` lays the run out and
 * `processing-passes.runProcessingPass` runs it, and `queue-steps/pass.ts` does
 * nothing but call the second with `queueMainWindow()` (which is null in a
 * headless run — a legal, already-supported value). Everything a pass owes the
 * project lives behind that pair: the stage directory, the ledger row, the
 * provenance record, the working copy it promotes into and the narration input
 * a chained render must read.
 *
 * This file exists so `--narration-text --project` and `--pass` are ONE
 * implementation. It was the body of `cli/narration-text.js` until 2026-09-05,
 * when the other three kinds got a door of their own; extracting it was the
 * alternative to a second copy of the chain-selection rule, which is the rule
 * most likely to go quietly wrong (a project with two archive EPUBs has two
 * chains, and every resolver in the app refuses to guess between them).
 */
'use strict';
const path = require('path');
const crypto = require('crypto');

/**
 * WHICH CHAIN, when the project holds more than one.
 *
 * `--family` names it, by id or by the stem of the file it was minted from, and
 * a project that needs one and was not given one is told which are there. A
 * project with ONE chain needs no id and the app's own resolvers find it.
 *
 * @returns {Promise<string | undefined>} the source path to plan against, or
 *   undefined to let the planner resolve the project's book itself.
 */
async function resolveFamilySource(projectDir, familyArg, label) {
  const manifestService = require('../dist/electron/manifest-service.js');
  const families = (await manifestService.readProjectManifest(projectDir)).families ?? [];
  const stemOf = (f) => path.basename(f.source.path).replace(/\.[^.]+$/, '');
  if (families.length > 1) {
    const wanted = typeof familyArg === 'string' ? familyArg.toLowerCase() : null;
    const chosen = wanted === null ? null : families.find((f) =>
      f.id.toLowerCase() === wanted || stemOf(f).toLowerCase() === wanted);
    if (chosen === null || chosen === undefined) {
      const list = families.map((f) => `  ${f.id}    ${stemOf(f)}`).join('\n');
      throw new Error(
        `${path.basename(projectDir)} holds ${families.length} book chains, and nothing can `
        + 'guess which one to work on. Name it with --family <id|stem>:\n' + list
        + (wanted === null ? '' : `\n(no chain answers to "${familyArg}")`));
    }
    const book = await manifestService.ensureBookEpub(projectDir, chosen.id);
    console.log(`[${label}] chain: ${chosen.id} (${stemOf(chosen)})`);
    return book.absPath;
  }
  if (typeof familyArg === 'string') {
    console.log(`[${label}] note: --family is ignored; this project has one chain.`);
  }
  return undefined;
}

/**
 * Plan one pass over a project and run it, printing what the app would record.
 *
 * @param {string} projectDir
 * @param {{kind: 'simplify'|'translate'|'footnote-refs'|'narration-text',
 *          simplify?: object, translate?: object}} pass  the ChainPassRequest
 * @param {{family?: string|null, label: string}} opts
 * @returns {Promise<object>} the PassJobResult
 */
async function runProjectPass(projectDir, pass, opts) {
  const label = opts.label;
  const { planProcessingChain } = require('../dist/electron/processing-chain.js');
  const { runProcessingPass } = require('../dist/electron/processing-passes.js');

  const sourcePath = await resolveFamilySource(projectDir, opts.family ?? null, label);
  const plan = await planProcessingChain({
    projectDir,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    passes: [pass],
  });
  if (plan.jobs.length !== 1) {
    throw new Error(`the planner produced ${plan.jobs.length} jobs for one pass`);
  }
  console.log(`[${label}] project book: ${plan.bookEpubPath}`);
  console.log(`[${label}] stage: ${plan.jobs[0].config.stageRelDir}`);

  const jobId = `cli-${pass.kind}-${crypto.randomUUID()}`;
  const t0 = Date.now();
  // The window is null, which is what `queueMainWindow()` returns in a headless
  // app run — the same argument the queue's own step passes, not a stand-in.
  const result = await runProcessingPass(jobId, plan.jobs[0].config, null);
  console.log(`[${label}] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (!result.success) throw new Error(result.error || 'the pass failed and gave no reason');
  console.log(`[${label}] book:    ${result.outputPath}`);
  if (result.narrationInputPath) {
    console.log(`[${label}] to narrate: ${result.narrationInputPath}`);
  }
  if (result.summary) console.log(`[${label}] ${result.summary}`);
  if (result.ledgerEntryId) console.log(`[${label}] ledger: ${result.ledgerEntryId}`);
  if (result.ledgerRefusal) console.log(`[${label}] ledger: ${result.ledgerRefusal}`);
  if (result.narrationCarryNote) {
    console.log(`[${label}] strikes: ${result.narrationCarryNote}`);
  }
  return result;
}

module.exports = { runProjectPass, resolveFamilySource };
