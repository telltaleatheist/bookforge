#!/usr/bin/env node
/**
 * abbr-to-table — relabel two-column abbreviation apparatus from `list` to `table`.
 *
 *   node tools/aligner/abbr-to-table.mjs            # report only
 *   node tools/aligner/abbr-to-table.mjs --apply
 *
 * An abbreviations page sets a narrow column of keys against a wide column of
 * expansions. That is tabular by the same test every other class is judged by —
 * what it looks like — and calling it `list` is the appearance-vs-something-else
 * error that `front_matter` was retired for.
 *
 * WHAT THIS DELIBERATELY DOES NOT TOUCH:
 *
 * - A GLOSSARY SET FULL MEASURE. Pohl's runs `x9-91` with an em-dash separator
 *   ("Abwehr—German military intelligence."). One column, so `list` is correct.
 *   The name of the section is not the test; the geometry is.
 * - A TABLE OF CONTENTS, whatever its shape. Whether the page numbers land in
 *   their own blocks is decided by how OCR happened to segment that book, not by
 *   the book: Pohl's TOC has a real number column, Nuremberg's is one merged
 *   block of run-together chapter names, Soul's has numbers inline in the text.
 *   Same logical page, three shapes — so a rule keyed on columns cannot be
 *   applied to it consistently, and labelling the merged case `table` would teach
 *   that a wide block of prose is a table.
 *
 * Honest expectation, from the learning curve: this moves `table` from 2 of 10
 * books to 3 of 10, and 2 was measured dead (345 examples, F1 0.00 at every
 * point). It is unlikely to raise F1 now. The reason to do it is that the
 * convention must be settled BEFORE the next books are labelled, or they are
 * labelled under the old rule and everything is relabelled twice.
 *
 * Sources are edited (labels.json), never the built corpus, so gather-corpus
 * rebuilds clean.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const APPLY = process.argv.includes('--apply');
const root = path.join(os.homedir(), 'Documents', 'BookForge', 'training');

/**
 * The sections, named explicitly rather than discovered.
 *
 * Every candidate page in the corpus was read by hand before this list was
 * written, and the geometry guard below re-checks each one — but a heuristic
 * sweep over "pages whose heading matches /ABBREVIATIONS/" would also catch
 * Pohl's single-column glossary and any future page that merely shares the word.
 * The set is small and slow-growing; being wrong here is expensive.
 */
const SECTIONS = [
  { book: 'Nuremberg_-_Infamy_on_Trial_-_Persico,_Joseph_E_-_Unknown', pages: [22] },
  { book: 'The_Holy_Reich_-_Richard_Steigmann-Gall_[Steigmann-Gall,_Richard_[Steigmann-Gall,_Richard]_(2013)', pages: [14, 15] },
  // Eval book. Changed too, on purpose: train and eval must share a convention
  // or the model is scored against a rule it was never taught.
  { book: 'Twisted_Cross_-_Bergen,_Doris_L_(1996)', pages: [248] },
];

/**
 * Two-column test, in page-relative terms: several narrow blocks on the left and
 * several wide blocks starting to their right. Runs against what the MODEL sees
 * — the OCR blocks — so a page that is tabular in print but arrived as one
 * merged block correctly fails.
 */
function isTwoColumn(blocks, dim, labels) {
  const entries = blocks.filter(b => labels[b.id] === 'list');
  if (entries.length < 6) return { ok: false, why: `only ${entries.length} list blocks` };
  let narrowLeft = 0, wideRight = 0;
  for (const b of entries) {
    const x0 = b.x / dim.width, x1 = (b.x + b.width) / dim.width;
    if (x0 < 0.25 && x1 < 0.30) narrowLeft++;
    else if (x0 >= 0.18) wideRight++;
  }
  if (narrowLeft < 3) return { ok: false, why: `${narrowLeft} narrow key blocks (need 3)` };
  if (wideRight < 3) return { ok: false, why: `${wideRight} wide expansion blocks (need 3)` };
  return { ok: true, why: `${narrowLeft} keys + ${wideRight} expansions` };
}

let totalChanged = 0;
const edits = new Map();   // book -> [blockId]

for (const { book, pages } of SECTIONS) {
  const file = path.join(root, book, 'labels.json');
  if (!fs.existsSync(file)) { console.log(`MISSING ${book}`); continue; }
  const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
  console.log(`\n=== ${book.slice(0, 46)}`);

  for (const page of pages) {
    const blocks = j.blocks.filter(b => b.page === page);
    const dim = j.pageDimensions?.[page] ?? { width: 612, height: 792 };
    const check = isTwoColumn(blocks, dim, j.labels);
    if (!check.ok) {
      console.log(`  p${page}: SKIPPED — ${check.why}`);
      continue;
    }
    const ids = blocks.filter(b => j.labels[b.id] === 'list').map(b => b.id);
    console.log(`  p${page}: ${ids.length} list -> table  (${check.why})`);
    if (!edits.has(book)) edits.set(book, []);
    edits.get(book).push(...ids);
    totalChanged += ids.length;
  }
}

console.log(`\n${totalChanged} blocks would change from list to table.`);

if (!APPLY) {
  console.log('\nReport only. Re-run with --apply to write, then:');
  console.log('  node tools/aligner/gather-corpus.mjs');
  console.log('  node tools/aligner/build-sft-dataset.mjs');
  process.exit(0);
}

for (const [book, ids] of edits) {
  const file = path.join(root, book, 'labels.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
  // Guard: every id must currently be `list`. A mismatch means the file changed
  // under us (the app was open, another pass ran) and the page numbers in
  // SECTIONS may no longer mean what they did when it was read by hand.
  const wrong = ids.filter(id => j.labels[id] !== 'list');
  if (wrong.length) {
    console.error(`REFUSING ${book}: ${wrong.length} target blocks are no longer 'list'.`);
    process.exit(1);
  }
  for (const id of ids) j.labels[id] = 'table';
  // Blocks carry their own category_id too; leaving it stale would make the
  // snapshot disagree with itself.
  for (const b of j.blocks) if (ids.includes(b.id)) b.category_id = 'table';
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(j, null, 2));
  fs.renameSync(temp, file);
  console.log(`wrote ${ids.length} -> ${file}`);
}
console.log('\nNow rebuild: gather-corpus.mjs then build-sft-dataset.mjs');
