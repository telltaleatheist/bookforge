#!/usr/bin/env node
/**
 * blocks-report — what did the model get wrong, and where should labelling go next.
 *
 *   node --require cli/electron-stub.js cli/blocks-report.js --project <dir> [--json out.json]
 *
 * Reads the stored Detect run (`editor.blocksPredictions`, written by
 * cli/blocks-detect.js) and the corrections a human made after it
 * (`editor.categoryCorrections`), and subtracts. Every disagreement is both a
 * training example and a data point about which confusions dominate.
 *
 * WHAT IT DELIBERATELY DOES NOT REPORT: accuracy over the book. A block with no
 * correction is either a block the model got right or a block nobody looked at,
 * and nothing records which pages were reviewed — so an "accuracy" here would be
 * a coverage artifact dressed as a score. The error STRUCTURE is computable and is
 * the useful half anyway: it says which classes the model cannot tell apart, which
 * is what picks the next books to label.
 *
 * Read the numbers against the known state (docs/BLOCKS_TRAINING.md): a class is
 * alive at >=500 examples across >=5 books, and `table`/`subheading` currently
 * score 0.00 because they live in too FEW BOOKS, not because they have too few
 * examples. A confusion involving them is expected and confirms the plan; a
 * confusion among the healthy classes is new information.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

function usage(msg) {
  if (msg) console.error(`blocks-report: ${msg}`);
  console.error('usage: node --require cli/electron-stub.js cli/blocks-report.js --project <dir> [--json out.json]');
  process.exit(msg ? 1 : 0);
}
if (flag('help') || flag('h') || !argv.length) usage();

const projectDir = opt('project');
if (!projectDir) usage('--project <dir> is required');
const manifestPath = path.join(path.resolve(projectDir), 'manifest.json');
if (!fs.existsSync(manifestPath)) usage(`no manifest.json in ${projectDir}`);
const jsonOut = opt('json', null);

const storePath = path.join(REPO_ROOT, 'dist', 'electron', 'blocks-predictions.js');
if (!fs.existsSync(storePath)) {
  console.error(`blocks-report: the prediction store is not built (${storePath}).\n` +
    '         Build the main process with:  npm run build:electron');
  process.exit(1);
}
const { buildBlocksErrorReport } = require(storePath);

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
let r;
try {
  r = buildBlocksErrorReport(manifest);
} catch (err) {
  console.error(`blocks-report: ${err.message}`);
  process.exit(1);
}

const pct = (n, d) => d ? `${(n / d * 100).toFixed(1)}%` : '—';

console.log(`\n${path.basename(path.resolve(projectDir))}`);
console.log(`  model ${r.model} (prompt v${r.promptVersion}), run ${r.ranAt}`);
console.log(`  ${r.predicted} predicted` + (r.unpredicted ? `, ${r.unpredicted} left unlabelled` : ''));
console.log(`  review coverage: ${r.pagesWithCorrections}/${r.pagesTotal} pages carry a correction`);

if (r.judged === 0) {
  console.log('\n  No corrections yet against this run — nothing to measure.');
  console.log('  Open the book in the picker, fix what is wrong, then run this again.');
  process.exit(0);
}

console.log(`\n  Of ${r.judged} predicted blocks a human then touched:`);
console.log(`    ${r.wrong} corrected to a different class  (${pct(r.wrong, r.judged)})`);
console.log(`    ${r.confirmed} re-affirmed as predicted`);

console.log('\n  Confusions, worst first  (model said -> human said)');
for (const c of r.confusion.slice(0, 15)) {
  console.log(`    ${c.predicted.padEnd(12)} -> ${c.actual.padEnd(12)} ${String(c.n).padStart(5)}`);
}
if (r.confusion.length > 15) console.log(`    … and ${r.confusion.length - 15} more`);

console.log('\n  Per predicted class');
console.log(`    ${'class'.padEnd(12)} ${'predicted'.padStart(9)} ${'judged'.padStart(7)} ${'wrong'.padStart(6)}  overruled`);
for (const b of r.byPredicted) {
  if (b.predicted === 0 && b.judged === 0) continue;
  console.log(`    ${b.category.padEnd(12)} ${String(b.predicted).padStart(9)} ${String(b.judged).padStart(7)} ` +
    `${String(b.wrong).padStart(6)}  ${pct(b.wrong, b.judged)}`);
}

if (r.neverPredicted.length) {
  console.log(`\n  Classes a human used that the model NEVER predicted in this book:`);
  console.log(`    ${r.neverPredicted.join(' ')}`);
  console.log('    These are the ones worth chasing — a class the model cannot produce at all');
  console.log('    is a book-spread problem, and this book is now evidence for it.');
}

console.log('\n  Caveat: "wrong" counts only blocks a human actually touched. A block with no');
console.log('  correction may be right or may be unreviewed — nothing records which pages were');
console.log('  walked, so this is an error PROFILE, not an accuracy score.\n');

if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify(r, null, 1));
  console.log(`  wrote ${jsonOut}\n`);
}
