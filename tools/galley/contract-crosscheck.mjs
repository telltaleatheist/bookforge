/**
 * Does galley's edit list survive the PRODUCTION applier?
 *
 * galley's corpus was round-trip verified against tools/galley/edits.mjs. But the
 * app applies edits with electron/ai-cleanup-prepass.ts `applyEditList`, which is a
 * DIFFERENT contract: nine semantic guards, a MULTI path, a fuzzy match ladder, and
 * word-boundary lookarounds. If those guards reject galley's true corrections,
 * integration silently loses recall and no scorer would show it — the model would
 * look fine and the books would not improve.
 *
 * This runs every GOLD edit in the corpus through the production applier and reports
 * which guard blocked what. Gold, not model output, so every block here is a CONTRACT
 * MISMATCH, not a model error.
 *
 * Measured Jul 31 2026 over all 9,016 rows / 15,854 edits:
 *   production applier landed  18.6%   (2,949 APPLIED + 16 quote-norm + 1 MULTI)
 *   blocked                    81.4%
 *   rows reproduced exactly    697 / 4,508
 * Root cause: 11,502 of 15,854 gold anchors (72.5%) sit MID-WORD, and the production
 * matcher requires a word boundary at any alphanumeric edge of `find`. See
 * docs/GALLEY_INTEGRATION.md §1. Re-run this after any change to either contract.
 *
 * usage: node tools/galley/contract-crosscheck.mjs <sft.jsonl...>
 *   (needs dist/electron built: npm run build:electron)
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseEdits, applyEdits } from './edits.mjs';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const prepassPath = path.join(repoRoot, 'dist', 'electron', 'ai-cleanup-prepass.js');
if (!fs.existsSync(prepassPath)) {
  console.error(`contract-crosscheck: ${prepassPath} not found. Run: npm run build:electron`);
  process.exit(1);
}
const { applyEditList } = require(prepassPath);

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node tools/galley/contract-crosscheck.mjs <sft.jsonl...>');
  process.exit(1);
}

const ALNUM = /[A-Za-zÀ-ÿ0-9]/;
const APPLIED_STATUSES = new Set(['APPLIED', 'MULTI', 'FOUND_FUZZY', 'FOUND_AFTER_QUOTE_NORM']);

const byStatus = new Map();
const examples = new Map();
let rows = 0, identityRows = 0, editRows = 0, totalEdits = 0;
let galleyOk = 0, prodExact = 0, prodDiffered = 0;
let anchorsUnique = 0, anchorsAbsent = 0, boundaryKilled = 0;

for (const f of files) {
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const msgs = JSON.parse(line).messages;
    const ocr = msgs.find((m) => m.role === 'user').content;
    const target = msgs.find((m) => m.role === 'assistant').content;
    rows++;
    if (/^none$/i.test(target.trim())) { identityRows++; continue; }
    editRows++;

    const { edits } = parseEdits(target);
    totalEdits += edits.length;

    // Why an edit fails: is the anchor there at all, or is it the boundary guard?
    for (const e of edits) {
      const idx = ocr.indexOf(e.before);
      if (idx < 0) { anchorsAbsent++; continue; }
      if (ocr.indexOf(e.before, idx + 1) < 0) anchorsUnique++;
      const end = idx + e.before.length;
      const preBad = ALNUM.test(e.before[0]) && idx > 0 && ALNUM.test(ocr[idx - 1]);
      const postBad = ALNUM.test(e.before.at(-1)) && end < ocr.length && ALNUM.test(ocr[end]);
      if (preBad || postBad) boundaryKilled++;
    }

    // galley's own applier — the corpus guarantee
    const g = applyEdits(ocr, edits);
    if (g.ok) galleyOk++;

    // production applier, same edits translated to its field names
    const { text, records } = applyEditList(ocr, edits.map((e) => ({ find: e.before, replace: e.after })));
    for (const r of records) {
      byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
      if (!examples.has(r.status)) examples.set(r.status, { find: r.find, replace: r.replace });
    }
    if (text === g.text) prodExact++; else prodDiffered++;
  }
}

console.log(`rows ${rows}  identity ${identityRows}  with-edits ${editRows}  gold edits ${totalEdits}`);
console.log(`galley applier accepted rows:      ${galleyOk}/${editRows}`);
console.log(`production applier reproduced row: ${prodExact}/${editRows}   DIFFERED: ${prodDiffered}`);
console.log(`\ngold anchors present verbatim AND unique: ${anchorsUnique}/${totalEdits}`);
console.log(`gold anchors absent verbatim:            ${anchorsAbsent}`);
console.log(`gold anchors a WORD-BOUNDARY guard rejects: ${boundaryKilled}  (${(boundaryKilled / totalEdits * 100).toFixed(1)}%)`);

console.log('\nproduction dispositions over gold edits  (! = blocks a TRUE correction):');
for (const [st, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
  const mark = APPLIED_STATUSES.has(st) ? '   ' : ' ! ';
  const ex = examples.get(st);
  console.log(`${mark}${st.padEnd(26)} ${String(n).padStart(6)}  ${(n / totalEdits * 100).toFixed(2)}%   e.g. ${JSON.stringify(ex.find)} → ${JSON.stringify(ex.replace)}`);
}
