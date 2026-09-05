#!/usr/bin/env node
/**
 * Extract the e2a command lines `parallel-tts-bridge.ts` builds, as text.
 *
 * Shared by `tools/test-orpheus-argv-snapshot.js` (which compares the current
 * source against a committed baseline) and by the one-off run that produced that
 * baseline from the commit BEFORE the Higgs work started. One extractor, so the
 * two sides cannot disagree about what "the argv" is.
 *
 * ── Why text, and why not just call the function ────────────────────────────
 *
 * The argv is assembled inside `runPrep` / `startWorker` / `runAssembly`, none of
 * which is exported, and all of which touch the filesystem, Electron's `app`, the
 * GPU arbiter and a live session object before they get to the array. Driving
 * them for a snapshot would mean faking all of that, and the fakes would then be
 * the thing under test.
 *
 * What actually needs proving is narrower and is a property of the SOURCE: that
 * the flags an Orpheus job sends to ebook2audiobook, in order, are the same
 * strings after the Higgs work as before it. The array literals say that
 * directly. Comments and whitespace are stripped, so reformatting is not a
 * failure and a moved flag is.
 */
'use strict';

/**
 * The array literals this extractor pins, by the anchor that starts each one.
 *
 * All FIVE e2a doors, because the whole claim is "no Orpheus argv moved" and a
 * door left out of the snapshot is a door the claim does not cover:
 *
 *   prep                  app.py --prep_only
 *   retake                worker.py with an explicit sentence set
 *   worker-lightweight    worker.py, the door every book actually renders through
 *   worker-app            app.py --worker_mode (unexercised: useLightweightWorker
 *                         is on — pinned anyway, since "unexercised" is a fact
 *                         about today's setting, not about the code)
 *   assembly              app.py --assemble_only
 *
 * The retake and worker doors are told apart by their session expression
 * (`sessionId` vs `prepInfo.sessionId`), which is the only thing that differs in
 * their opening lines.
 */
const ANCHORS = [
  { name: 'prep', start: "appPath,\n    '--headless',\n    '--ebook'" },
  { name: 'retake', start: "workerPath,\n      '--session', sessionId," },
  { name: 'worker-lightweight', start: "workerPath,\n      '--session', prepInfo.sessionId," },
  { name: 'worker-app', start: "appPath,\n      '--headless',\n      '--session', prepInfo.sessionId," },
  { name: 'assembly', start: "appPath,\n    '--headless',\n    // Only include --ebook" },
];

/** Strip comments and collapse whitespace so formatting is not a diff. */
function normalize(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * From `start`, read forward to the closing `];` of the array literal it sits in,
 * tracking bracket depth so a nested `[...]` (the bilingual spread, the
 * sentences_dir ternary) does not end it early.
 */
function literalFrom(source, start) {
  const at = source.indexOf(start);
  if (at < 0) {
    throw new Error(
      `The argv anchor was not found:\n  ${JSON.stringify(start)}\n` +
      'Either the spawn was rewritten (in which case decide whether the Orpheus ' +
      'argv really should change, and regenerate the baseline deliberately) or the ' +
      'anchor needs updating.',
    );
  }
  let depth = 0;
  let i = at;
  // Walk back to the `[` that opens this literal.
  while (i > 0 && source[i] !== '[') i--;
  const open = i;
  for (i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return normalize(source.slice(open, i + 1));
    }
  }
  throw new Error(`Unterminated array literal from anchor ${JSON.stringify(start)}`);
}

function extract(source) {
  // LINE ENDINGS FIRST. The anchors above are written with `\n`, and this repo has
  // `core.autocrlf=true`, so on Windows every working file is CRLF and every
  // anchor missed — `indexOf` returned -1 and the keeper died with "the argv
  // anchor was not found" on a tree where nothing had moved. It has been failing
  // that way on Windows since it was written (verified on a clean checkout,
  // 2026-09-05), which made the one keeper whose whole job is to say "the Orpheus
  // argv did not change" unable to say anything at all.
  //
  // Normalising here and not at the call site because `normalize()` already
  // collapses all whitespace, so the SNAPSHOT is identical either way — this
  // only affects whether the anchors can be found.
  const lf = source.replace(/\r\n/g, '\n');
  const out = {};
  for (const a of ANCHORS) out[a.name] = literalFrom(lf, a.start);
  return out;
}

module.exports = { extract, ANCHORS, normalize };

// `node tools/orpheus-argv-extract.js <file>` prints the snapshot, which is how
// the committed baseline was produced from the pre-Higgs commit.
if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) {
    console.error('usage: orpheus-argv-extract.js <parallel-tts-bridge.ts>');
    process.exit(64);
  }
  console.log(JSON.stringify(extract(fs.readFileSync(file, 'utf-8')), null, 2));
}
