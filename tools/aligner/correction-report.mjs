#!/usr/bin/env node
/**
 * correction-report — read the model-correction logs and say where to label next.
 *
 *   node tools/aligner/correction-report.mjs [--min 2]
 *
 * Reads every `model-corrections.jsonl` under ~/Documents/BookForge/training/,
 * written by the editor when a book is exported after a Detect run. Each line is
 * one block the model answered and a human then changed, with the final label —
 * never the sequence of flips that produced it.
 *
 * The question this exists to answer is which of two things a confusion is,
 * because they call for opposite responses and eval_loss cannot tell them apart:
 *
 *   SYSTEMATIC — the same mistake in every book. The model is missing a feature,
 *     and more books will not fix it. `table` is the known case: 345 examples
 *     across 2 books, F1 0.00 at every point on the learning curve, because one
 *     book's tables say nothing about another book's typography.
 *   SCATTERED — the mistake appears in one book and not others. That is either a
 *     house style the corpus has not seen, or a genuinely ambiguous boundary, and
 *     labelling more books of that kind is exactly the fix.
 *
 * A confusion is called systematic here when it shows up in most of the books
 * that were in a position to exhibit it. That denominator matters: a confusion
 * absent from a book with no examples of the class is not evidence of anything.
 *
 * READ THE PRECISION/RECALL CAVEAT BEFORE ACTING ON THIS. The human sees the
 * model's answer first, so a wrong-looking label draws the eye and gets
 * corrected — while a class the model never emits produces nothing to look at.
 * This measures where the model's ANSWERS are wrong. It cannot count what the
 * model silently missed, and for `table`/`subheading`/`title` the silent misses
 * are the whole story. Use the eval harness for recall.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MIN = Number(opt('min', 2));
const root = path.join(os.homedir(), 'Documents', 'BookForge', 'training');

const records = [];
const books = new Set();
for (const slug of fs.existsSync(root) ? fs.readdirSync(root) : []) {
  const file = path.join(root, slug, 'model-corrections.jsonl');
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    records.push(r);
    books.add(r.book);
  }
}

if (records.length === 0) {
  console.log('No correction logs yet.\n');
  console.log('They are written when a book is exported after a Detect run:');
  console.log('  open the book -> Detect -> Load categories -> correct in Label mode');
  console.log('  -> Export training data');
  process.exit(0);
}

// Adapters, first: a log mixing two models describes neither.
const adapters = new Map();
for (const r of records) adapters.set(r.adapter, (adapters.get(r.adapter) ?? 0) + 1);
console.log(`${records.length} corrections across ${books.size} book(s)`);
if (adapters.size > 1) {
  console.log('\nWARNING — corrections span MORE THAN ONE MODEL. Confusions from '
    + 'different adapters are not comparable; filter by adapter before drawing '
    + 'conclusions:');
}
for (const [a, n] of [...adapters].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(n).padStart(5)}  ${a || '(unrecorded)'}`);
}

// Which books could even exhibit a given confusion — the honest denominator.
const booksWithPredicted = new Map();   // predicted class -> Set(book)
for (const r of records) {
  if (!booksWithPredicted.has(r.predicted)) booksWithPredicted.set(r.predicted, new Set());
  booksWithPredicted.get(r.predicted).add(r.book);
}

const conf = new Map();                 // "truth<-predicted" -> {n, books:Set, examples:[]}
for (const r of records) {
  const key = `${r.predicted}>${r.corrected}`;
  if (!conf.has(key)) conf.set(key, { n: 0, books: new Set(), examples: [] });
  const c = conf.get(key);
  c.n++;
  c.books.add(r.book);
  if (c.examples.length < 3) c.examples.push(r);
}

const rows = [...conf].map(([key, c]) => {
  const [predicted, corrected] = key.split('>');
  const couldShow = booksWithPredicted.get(predicted)?.size ?? 1;
  return { predicted, corrected, ...c, share: c.books.size / couldShow, couldShow };
}).filter(r => r.n >= MIN).sort((a, b) => b.n - a.n);

console.log(`\nCONFUSIONS (model said -> human said), min ${MIN} occurrences`);
console.log(`${'model said'.padEnd(13)}${'human said'.padEnd(13)}${'n'.padStart(5)}`
  + `${'books'.padStart(8)}  verdict`);
for (const r of rows) {
  // Systematic needs BOTH breadth across books and more than one book able to
  // show it — "1 of 1 books" is not a pattern, it is a single observation.
  const systematic = r.couldShow > 1 && r.share >= 0.6;
  const verdict = systematic
    ? 'SYSTEMATIC — missing feature, more books will not fix it'
    : r.couldShow === 1
      ? 'one book only — no basis to generalise yet'
      : 'scattered — house style or ambiguity, more books should help';
  console.log(`${r.predicted.padEnd(13)}${r.corrected.padEnd(13)}${String(r.n).padStart(5)}`
    + `${(r.books.size + '/' + r.couldShow).padStart(8)}  ${verdict}`);
}

// Which classes the model gets handed back most often — i.e. what it over-claims.
const wrongWhenSaid = new Map();
const saidTotal = new Map();
for (const r of records) {
  wrongWhenSaid.set(r.predicted, (wrongWhenSaid.get(r.predicted) ?? 0) + 1);
}
console.log('\nCORRECTED AWAY FROM (the model over-claims these):');
for (const [c, n] of [...wrongWhenSaid].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${c}`);
}

const correctedTo = new Map();
for (const r of records) correctedTo.set(r.corrected, (correctedTo.get(r.corrected) ?? 0) + 1);
console.log('\nCORRECTED TO (what it should have said):');
for (const [c, n] of [...correctedTo].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${c}`);
}

console.log('\nEXAMPLES from the largest confusions:');
for (const r of rows.slice(0, 5)) {
  console.log(`\n  ${r.predicted} -> ${r.corrected}  (${r.n})`);
  for (const e of r.examples) {
    console.log(`    p${String(e.page).padStart(4)} fs${e.fsize} ${e.lines}l ${e.chars}ch  `
      + JSON.stringify((e.text || '').slice(0, 62)));
  }
}

console.log('\nRemember: this is PRECISION only. A class the model never emits '
  + 'produces no corrections at all, so silence here is not evidence it works — '
  + 'run tools/aligner/eval-rubric.py for recall.');
