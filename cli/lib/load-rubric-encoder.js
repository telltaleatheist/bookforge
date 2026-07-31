/**
 * Load the rubric encoder FROM SOURCE, every run.
 *
 * The encoder owns the prompt format and the legal class list, and
 * `rubricVersionFor()` picks both by reading the version out of the model id.
 * That makes it the one file where running yesterday's copy is not a stale test
 * but a WRONG ANSWER: a model served the previous version's prompt is offered a
 * taxonomy it was never trained on, answers plausibly anyway, and reads as a bad
 * checkpoint.
 *
 * Which is exactly what happened. The CLIs used to `require` a checked-in
 * `dist/rubric/.../rubric-encoder.js`, existence-checked and never
 * freshness-checked, so a build from the day before passed silently: v5 was
 * classified under the retired sixteen-class v1 prompt and reported
 * `promptVersion: 1` in its own output, which is the only reason it was caught.
 *
 * So there is no artifact to go stale. Same reasoning, and the same esbuild
 * approach, as `cli/export-epub.js` — and cheap here, because the encoder's only
 * import is a `type`, which esbuild erases. No stubs, no Angular, no graph.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(REPO_ROOT, 'src/app/features/pdf-picker/services/rubric-encoder.ts');

let cached = null;

/** The encoder module, built from the current source. */
function loadRubricEncoder() {
  if (cached) return cached;

  if (!fs.existsSync(SOURCE)) {
    console.error(`rubric: the encoder source is missing (${SOURCE}).`);
    process.exit(1);
  }

  let esbuild;
  try {
    esbuild = require(path.join(REPO_ROOT, 'node_modules', 'esbuild'));
  } catch {
    console.error('rubric: esbuild is not installed — run npm install.');
    process.exit(1);
  }

  const built = esbuild.buildSync({
    entryPoints: [SOURCE],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    logLevel: 'error',
  });

  const temp = path.join(os.tmpdir(), `bookforge-rubric-encoder-${process.pid}.cjs`);
  fs.writeFileSync(temp, built.outputFiles[0].text);
  try {
    cached = require(temp);
  } finally {
    fs.unlinkSync(temp);
  }

  if (typeof cached.rubricVersionFor !== 'function') {
    console.error('rubric: the encoder bundle exports no rubricVersionFor — it was restructured.');
    process.exit(1);
  }
  return cached;
}

module.exports = { loadRubricEncoder };
