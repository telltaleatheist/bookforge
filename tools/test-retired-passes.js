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
 * rows, and three of the kinds they name — `tesseract`, `ocr-correction`,
 * `detection` — no longer exist: the document pipeline folded the first into Get
 * Text, the second into Build the book, and turned the third into annotations in
 * the working PDF (docs/DOCUMENT_PIPELINE.md).
 *
 * A row like that cannot be reasoned about. Nothing knows what `detection` would
 * do now, and the nearest live pass is not the same pass — running it would
 * spend GPU time producing something the user did not ask for and did not plan.
 * So it is refused, and the refusal carries the sentence that explains the
 * change plus where to plan the run again, because "there is no detection pass"
 * on its own tells someone nothing about what happened to their queue.
 *
 * `footnotes` is the same shape from the other side: it survived, but it now has
 * two implementations and the PLAN says which. A row queued before that
 * distinction existed carries no `footnotesMode`, and picking one would silently
 * read the wrong document.
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
  {
    const detection = await run('detection');
    ok('the job fails instead of guessing', detection.success === false);
    ok('and the message names the change and the fix',
      /Detect blocks/.test(detection.error || '') && /Process tab/.test(detection.error || ''),
      detection.error);

    const ocr = await run('ocr-correction');
    ok('OCR correction says where the repair went',
      ocr.success === false && /Build the book/.test(ocr.error || ''),
      ocr.error);

    const tesseract = await run('tesseract');
    ok('and Tesseract says which pass reads the pages now',
      tesseract.success === false && /Get Text/.test(tesseract.error || ''),
      tesseract.error);
  }

  console.log('\n2. a footnotes row that does not say which document it reads');
  {
    // The pass survived the pipeline change; the AMBIGUITY did not survive with
    // it. `--epub` edits the finished book and `--pdf` rewrites the working
    // document's text layer, and a job that names neither would have one of them
    // chosen for it — which is a pass silently reading the wrong document.
    const footnotes = await run('footnotes');
    ok('an unqualified footnotes job is refused, not guessed at',
      footnotes.success === false && /footnotesMode/.test(footnotes.error || ''),
      footnotes.error);
    ok('and it says the row predates the document pipeline',
      /document pipeline/.test(footnotes.error || ''), footnotes.error);
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\ntest harness failed:', err);
  process.exit(1);
});
