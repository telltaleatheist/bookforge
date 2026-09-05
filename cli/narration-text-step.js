/**
 * narration-text-step.js — the ONE door every CLI path takes to the narration
 * text cleanup FAILSAFE.
 *
 * `cli/narration-prep-step.js`'s rule, for its reason: a CLI running its own
 * version of a pass could not catch the app's bugs, which is the whole point of
 * there being a CLI. So this file calls `cleanTextEpub` out of the compiled dist
 * — the same function the queue's `narration-text` job runs — and every adapter
 * (`--narration-text`, `orpheus-batch-render`, `orpheus-audiobook-render`) calls
 * this.
 *
 * ── The engine does the work ────────────────────────────────────────────────
 *
 * Owen ruled on 2026-09-05 that the pass lives in the Foundry engine. This runs
 * `foundry clean-text --epub <book> --out <staging>` and lands the staging on
 * the book. BookForge's own copy of the three stages is gone.
 *
 * ── IT REPLACES THE BOOK, and that is the ruling ────────────────────────────
 *
 * Owen, 2026-09-05: *"the cleaning step can be done on an epub… it should
 * replace the epub that's currently there if one already exists. if the user
 * deletes the epub and re-exports, the cleaning job will be lost. that's the
 * cost of doing it to an epub."*
 *
 * So this no longer mints `<stem>.narration.epub` beside the input and hand the
 * next stage a second file. It cleans the book the caller named, in place, with
 * one rename — which is also what makes the reuse machinery unnecessary: a book
 * that has already been cleaned SAYS SO, in its own OPF, and the gate below is
 * the whole of the check.
 *
 * ── What it produces ────────────────────────────────────────────────────────
 *
 *   <book>.epub                  the same path, cleaned and STAMPED
 *   <stem>.narration-text.json   the engine's receipt: per-rule punctuation
 *                                counts, every model edit and its verdict
 *
 * ── When it does nothing, and says so ───────────────────────────────────────
 *
 *  - the input already carries a CURRENT stamp: it has been through this pass,
 *    and running it again would cost a model pass to produce the same bytes;
 *  - the input is a `.txt`: a plain-text audition has no book and no chain, and
 *    `prepareNarrationInput` still cleans those inline.
 *
 * Anything else is a real run.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** The receipt that sits beside a cleaned book. */
function receiptPathFor(bookPath) {
  return `${bookPath.slice(0, -path.extname(bookPath).length)}.narration-text.json`;
}

/**
 * Run the narration text cleanup on one file, and say what happened.
 *
 * Returns `{ inputPath, receiptPath, receipt, ran }` — `inputPath` is what the
 * next stage must read, which since the in-place ruling is always the file the
 * caller named.
 */
async function runNarrationTextStep(inputPath, opts) {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) throw new Error(`input file not found: ${resolved}`);

  if (path.extname(resolved).toLowerCase() !== '.epub') {
    console.log(
      `[narration-text] ${path.basename(resolved)} is not an EPUB — a plain-text audition has no `
      + 'book chain, and the render door cleans it inline. Nothing to do.');
    return { inputPath: resolved, receiptPath: null, receipt: null, ran: false };
  }

  const door = require('../dist/electron/narration-clean-text.js');

  // Already clean? Then this stage is a no-op by the book's own account.
  const gate = await door.narrationTextGate(resolved);
  if (gate.ok) {
    console.log(
      `[narration-text] ${path.basename(resolved)} already carries a current stamp `
      + `(${gate.stamp.normalizerVersion}/${gate.stamp.punctuationSpec}, ${gate.stamp.model}). `
      + 'Nothing to do.');
    return { inputPath: resolved, receiptPath: null, receipt: null, ran: false };
  }

  if (opts && opts.model) {
    // The model is the ENGINE's setting now — the same `app-settings.json` the
    // hosted Clean text press reads — so a tag passed here would run a cleanup
    // the app's own settings say nothing about. Said rather than silently
    // dropped, and rather than honoured behind the app's back.
    console.log(
      '[narration-text] note: --model is ignored. The cleanup runs `foundry clean-text`, which '
      + 'takes its model and its Ollama endpoint from the same settings the hosted Clean text '
      + 'press uses, so the two doors cannot run different models.');
  }

  /*
   * STAGED BESIDE THE BOOK, then renamed onto it. Beside, so the rename is
   * within one filesystem and is therefore atomic — a reader (or Syncthing) sees
   * the old book or the new one and never a half-written one. A crash mid-run
   * leaves a `.bookforge-clean-*` file and the book exactly as it was.
   */
  const staging = path.join(
    path.dirname(resolved),
    `${path.basename(resolved, '.epub')}.bookforge-clean-${crypto.randomUUID()}.epub`);

  const t0 = Date.now();
  let outcome;
  try {
    outcome = await door.cleanTextEpub({
      epubPath: resolved,
      outPath: staging,
      ...(opts && opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
  } catch (err) {
    // Nothing of a refused run may be left standing where somebody could adopt
    // it as a cleaned book.
    fs.rmSync(staging, { force: true });
    fs.rmSync(door.cleanTextStampSidecar(staging), { force: true });
    fs.rmSync(door.cleanTextReceiptPath(staging), { force: true });
    throw err;
  }

  // THE TARGET IS THE FILE THIS RUN READ, and it is checked. The failsafe's
  // whole act is replacing somebody's export in place, and "over which file" is
  // the one question it must never get wrong.
  if (!fs.existsSync(resolved)) {
    fs.rmSync(staging, { force: true });
    throw new Error(
      `${resolved} is gone since this cleanup started reading it. The cleaned book was written `
      + 'and has been removed rather than landed on a path that is no longer the book that was '
      + 'cleaned.');
  }

  const receiptPath = receiptPathFor(resolved);
  fs.writeFileSync(receiptPath, `${JSON.stringify(outcome.receipt, null, 2)}\n`, 'utf8');
  fs.renameSync(staging, resolved);
  // The engine's sidecars are named off the STAGING path and describe a file
  // that no longer exists under that name. The receipt is kept beside the book
  // above; these two are removed rather than left as orphans.
  fs.rmSync(door.cleanTextStampSidecar(staging), { force: true });
  fs.rmSync(door.cleanTextReceiptPath(staging), { force: true });

  const p = outcome.receipt.punctuation;
  console.log(`[narration-text] book:    ${resolved} (replaced in place)`);
  console.log(`[narration-text] receipt: ${receiptPath}`);
  console.log(
    `[narration-text] punctuation: ${p.spansApplied} span(s) over ${p.targetsChanged} passage(s) `
    + `— ${Object.entries(p.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`
    + `${p.refused.length > 0 ? `; ${p.refused.length} refused (crosses markup)` : ''}`);
  console.log(
    `[narration-text] blocks: ${outcome.receipt.units.length} cleaned, `
    + `${outcome.receipt.unitsAsked} asked of ${outcome.settings.model}, `
    + `${outcome.receipt.unitsParseFailed} unanswerable, `
    + `${outcome.receipt.keptAsPrinted.length} left exactly as printed`);
  console.log(
    `[narration-text] stamped ${outcome.stamp.normalizerVersion}/`
    + `${outcome.stamp.punctuationSpec} by ${outcome.stamp.model}`);
  console.log(
    '[narration-text] this is the FAILSAFE: the cleanup lives in this FILE. Re-export this book '
    + 'from its project and the cleanup is lost — the standard method is the Clean text step in '
    + 'the Foundry window.');
  console.log(`[narration-text] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  return { inputPath: resolved, receiptPath, receipt: outcome.receipt, ran: true };
}

module.exports = { runNarrationTextStep, receiptPathFor };
