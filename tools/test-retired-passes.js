#!/usr/bin/env node
/**
 * Tests for the retired-kind refusal in electron/processing-passes.ts.
 *
 *   npx tsc -p tsconfig.electron.json && node tools/test-retired-passes.js
 *
 * ── What is actually being defended ─────────────────────────────────────────
 *
 * `queue.json` outlives the code that wrote it. A user who planned a run under
 * an older build, closed the app and reopened it under this one still has those
 * rows, and every kind they name except `simplify` and `translate` is gone: in
 * Aug 2026 `foundry vlm-convert` became the only PDF→EPUB conversion and the
 * whole Tesseract-era document pipeline went with it — `get-text` (the cast),
 * `blocks` (Detect), `reflow` (the exporter) and the 4B `footnotes` pass, which
 * had already absorbed `tesseract`, `ocr-correction` and `detection`.
 *
 * A row like that cannot be reasoned about. Nothing knows what `reflow` would do
 * now, and the nearest live pass is not the same pass — running it would spend
 * GPU time producing something the user did not ask for and did not plan. So it
 * is refused, and the refusal carries the sentence that explains the change plus
 * where to plan the run again, because "there is no reflow pass" on its own
 * tells someone nothing about what happened to their queue.
 *
 * The queue's own half of this is `RETIRED_JOB_TYPES`
 * (src/app/features/queue/models/queue.types.ts), which fails such a row on
 * LOAD. This is the belt to that pair of braces: a row that reaches the executor
 * anyway still refuses rather than falling through a switch.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist', 'electron');
if (!fs.existsSync(path.join(DIST, 'processing-passes.js'))) {
  console.error('Compile first: npx tsc -p tsconfig.electron.json');
  process.exit(1);
}
const passes = require(path.join(DIST, 'processing-passes.js'));

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-passes-test-'));

let failures = 0;
function ok(label, condition, detail) {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

/** Run one pass config and hand back its result. Never throws — the queue row
 *  needs the message, so a failure is RETURNED rather than raised. */
async function run(kind, extra) {
  return passes.runProcessingPass(
    `stale-${kind}`,
    { kind, projectDir: scratch, stageRelDir: `stages/01-${kind}`, ...extra },
    null
  );
}

(async () => {
  console.log('1. a queue row naming a pass this build no longer has');
  // Each of these says what happened to that pass, not merely that it is gone.
  const expected = {
    'get-text': /Convert to EPUB/,
    blocks: /block model/,
    reflow: /Convert to EPUB writes the book/,
    footnotes: /narration copy/,
    tesseract: /document vision model/,
    'ocr-correction': /Tesseract pipeline it repaired/,
    detection: /Tesseract pipeline it labelled/,
  };
  for (const [kind, pattern] of Object.entries(expected)) {
    const result = await run(kind);
    ok(`${kind} fails instead of guessing`, result.success === false, result.error);
    ok(`${kind} says what happened to it`, pattern.test(result.error || ''), result.error);
    ok(`${kind} says where to plan the run again`,
      /Process tab/.test(result.error || ''), result.error);
  }

  console.log('\n2. a kind nobody has ever had');
  {
    // Not in the retired table, so it reaches the switch's exhaustiveness arm —
    // which has to refuse rather than fall through to whichever case is last.
    const result = await run('sharpen');
    ok('an unknown kind is refused by its own name',
      result.success === false && /no sharpen pass/.test(result.error || ''), result.error);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
