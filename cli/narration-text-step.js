/**
 * narration-text-step.js — the ONE door every CLI path takes to the narration
 * text cleanup.
 *
 * `cli/narration-prep-step.js`'s rule, for its reason: a CLI running its own
 * version of a pass could not catch the app's bugs, which is the whole point of
 * there being a CLI. So this file calls `runNarrationTextPass` out of the
 * compiled dist — the same function the queue's `narration-text` job runs — and
 * every adapter (`--narration-text`, `orpheus-batch-render`,
 * `orpheus-audiobook-render`) calls this.
 *
 * ── What it produces ────────────────────────────────────────────────────────
 *
 *   <stem>.narration.epub                the cleaned, STAMPED book
 *   <stem>.narration.narration-text.json the receipt: per-rule counts, every
 *                                        model edit and its verdict, versions
 *
 * ── When it does nothing, and says so ───────────────────────────────────────
 *
 *  - the input already carries a CURRENT stamp: it has been through this pass,
 *    and running it again would cost a model pass to produce the same bytes;
 *  - a `<stem>.narration.epub` already sits beside the input whose receipt names
 *    THIS source and THIS version: the same reuse, one run later;
 *  - the input is a `.txt`: a plain-text audition has no book and no chain, and
 *    `prepareNarrationInput` still cleans those inline.
 *
 * Anything else is a real run. A file that exists but describes a DIFFERENT book
 * is never overwritten — `uniqueOutputPath` gives the new one its " (2)".
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** The receipt that sits beside a cleaned book. */
function receiptPathFor(outPath) {
  return `${outPath.slice(0, -path.extname(outPath).length)}.narration-text.json`;
}

/**
 * Is this cleaned book beside the input the SAME work this run would do?
 *
 * Three things have to agree: the source's content address, the number rules'
 * version and the punctuation spec's. Any disagreement means the file describes
 * a different book or a different pass, and it is left exactly where it is.
 */
function reusable(receipt, inputSha16, normalizerVersion, punctuationSpec) {
  return receipt !== null
    && receipt.inputSha16 === inputSha16
    && receipt.normalizerVersion === normalizerVersion
    && receipt.punctuationSpec === punctuationSpec;
}

/**
 * The cleaned books already sitting beside the input, newest name last.
 *
 * `<stem>.narration.epub` and every `<stem>.narration (n).epub` that the
 * collision rule has minted. Enumerated rather than guessed at, because the (n)
 * are exactly the copies a reuse check that stats one name can never see.
 */
/**
 * Which cleaned-book sibling this filename is, or null when it is not one.
 *
 * A plain string comparison rather than a regex over the stem: a book's filename
 * carries periods, parentheses and commas ("Working Towards The Fuhrer. Kershaw,
 * Ian. (1993)"), and every one of them is a metacharacter. Nothing is escaped
 * here because nothing is compiled.
 */
function siblingIndex(name, base) {
  if (!name.startsWith(base) || !name.endsWith('.epub')) return null;
  const middle = name.slice(base.length, name.length - '.epub'.length);
  if (middle === '') return 0;
  const m = /^ \((\d+)\)$/.exec(middle);
  return m === null ? null : Number(m[1]);
}

/**
 * The cleaned books already sitting beside the input, in minting order.
 *
 * `<stem>.narration.epub` and every `<stem>.narration (n).epub` the collision
 * rule has minted. Enumerated rather than guessed at, because the (n) are
 * exactly the copies a reuse check that stats one name can never see: runs 2-5
 * minted (2), (3), (4), (5) while four correctly-cleaned copies with matching
 * receipts sat unread, each costing a full model pass over the whole book (the
 * adversarial review, 2026-09-04).
 */
function cleanedSiblings(wanted) {
  const dir = path.dirname(wanted);
  const base = path.basename(wanted, '.epub');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return fs.existsSync(wanted) ? [wanted] : [];
  }
  return entries
    .map((name) => ({ name, index: siblingIndex(name, base) }))
    .filter((e) => e.index !== null)
    .sort((a, b) => a.index - b.index)
    .map((e) => path.join(dir, e.name));
}

function readReceipt(receiptPath) {
  try {
    return JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Run the narration text cleanup on one file, and say what happened.
 *
 * Returns `{ inputPath, receiptPath, receipt, ran }` — `inputPath` is what the
 * next stage must read, which is the cleaned book when one was made and the
 * original when there was nothing to do.
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

  const bridge = require('../dist/electron/parallel-tts-bridge.js');
  const pass = require('../dist/electron/narration-text-pass.js');
  const naming = require('../dist/electron/output-naming.js');
  const normalizer = require('../dist/electron/tts-number-normalizer.js');
  const punctuation = require('../dist/electron/tts-punctuation.js');
  const sidecar = require('../dist/electron/sidecar-binding.js');

  // Already clean? Then this stage is a no-op by the book's own account.
  const gate = await pass.narrationTextGate(resolved);
  if (gate.ok) {
    console.log(
      `[narration-text] ${path.basename(resolved)} already carries a current stamp `
      + `(${gate.stamp.normalizerVersion}/${gate.stamp.punctuationSpec}, ${gate.stamp.model}). `
      + 'Nothing to do.');
    return { inputPath: resolved, receiptPath: null, receipt: null, ran: false };
  }

  const inputSha16 = (await sidecar.bookDigest(resolved)).hex.slice(0, 16);
  const stem = path.basename(resolved, path.extname(resolved));
  const wanted = path.join(path.dirname(resolved), `${stem}.narration.epub`);

  // EVERY candidate, not just the unsuffixed one. `uniqueOutputPath` mints
  // "<stem>.narration (2).epub" on a collision, and a reuse check that only ever
  // stats the bare name never finds one again: runs 2-5 minted (2), (3), (4),
  // (5) while four correctly-cleaned copies with matching receipts sat unread —
  // a full model pass over the whole book, every time (the adversarial review,
  // 2026-09-04). Triggered by a corrupt receipt, and by any book edited once.
  for (const candidate of cleanedSiblings(wanted)) {
    const existing = readReceipt(receiptPathFor(candidate));
    if (reusable(existing, inputSha16, normalizer.NORMALIZER_VERSION,
      punctuation.PUNCTUATION_SPEC_VERSION)) {
      console.log(`[narration-text] reusing the cleaned book beside the input: ${candidate}`);
      return {
        inputPath: candidate, receiptPath: receiptPathFor(candidate), receipt: existing,
        ran: false,
      };
    }
  }

  const outPath = naming.uniqueOutputPath(wanted);
  const { createOllamaNormalizerRunner, numberNormalizerModel } =
    require('../dist/electron/tts-number-normalizer-runner.js');
  const { loadNarrationTextPrompt } = require('../dist/electron/ai-bridge.js');

  // Read ONCE and carried: the tag is part of the cache path and of the stamp, so
  // a run that read it twice could name the copy after one model and make it with
  // another.
  const model = opts && opts.model ? opts.model : numberNormalizerModel();
  const t0 = Date.now();
  const result = await pass.runNarrationTextPass({
    epubPath: resolved,
    outPath,
    cacheDir: bridge.narrationCutsDir(),
    systemPrompt: await loadNarrationTextPrompt(),
    model,
    runner: createOllamaNormalizerRunner(model),
    ...(opts && opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });

  const receiptPath = receiptPathFor(outPath);
  fs.writeFileSync(receiptPath, `${JSON.stringify(result.receipt, null, 2)}\n`, 'utf8');

  const p = result.receipt.punctuation;
  const n = result.receipt.numbers;
  console.log(`[narration-text] book:    ${result.outPath}`);
  console.log(`[narration-text] receipt: ${receiptPath}`);
  console.log(
    `[narration-text] punctuation: ${p.spansApplied} span(s) over ${p.targetsChanged} passage(s) `
    + `— ${Object.entries(p.counts).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`
    + `${p.refused.length > 0 ? `; ${p.refused.length} refused (crosses markup)` : ''}`);
  console.log(
    `[narration-text] readings: ${n === null ? 0 : n.appliedSpans} applied `
    + `(${n === null ? 0 : n.appliedByRules} by rule, ${n === null ? 0 : n.appliedByModel} by `
    + `${model}) over ${n === null ? 0 : n.targetsSelected} block(s), `
    + `${n === null ? 0 : n.targetsAsked} asked`);
  console.log(
    `[narration-text] by class: ${n === null ? '(none)'
      : Object.entries(n.appliedByClass).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
  console.log(`[narration-text] done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  return { inputPath: result.outPath, receiptPath, receipt: result.receipt, ran: true };
}

module.exports = { runNarrationTextStep, receiptPathFor };
