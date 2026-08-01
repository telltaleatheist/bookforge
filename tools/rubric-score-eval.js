#!/usr/bin/env node
/**
 * rubric-score-eval — score a SHIPPING rubric model over a whole eval split.
 *
 *   node --require cli/electron-stub.js tools/rubric-score-eval.js \
 *     [--sft /Volumes/Callisto/training/rubric/sft/eval.jsonl] \
 *     [--model rubric-v3-4b] [--backend local|ollama] [--limit N] [--json out.json]
 *
 * WHY THIS EXISTS ALONGSIDE THE OTHER TWO SCORERS. tools/aligner/eval-rubric.py
 * scores an ADAPTER on the training box: it needs the GPU, unsloth, and the base
 * at the precision the run trained against. tools/rubric-replay.js scores the
 * shipping model but on ONE book at a time, and reports per-class recall only —
 * no precision, so no macro-F1. This one scores the shipping GGUF over the FULL
 * eval split and reports macro-F1, which is the number this project quotes.
 *
 * The metric definitions are copied deliberately, line for line, from
 * eval-rubric.py: confusion keyed (truth, predicted) with `<missing>` and
 * `<illegal>` as pseudo-predictions that cost recall but belong to no class's
 * precision; macro-F1 averaged over the classes that actually occur, because the
 * corpus is ~60% body and plain accuracy barely moves when a small class dies.
 * Divergence there would silently make v3 and v4 numbers incomparable.
 *
 * WHAT THE NUMBER IS: a served-path score. It carries the quantization of
 * whatever GGUF is installed, so it is not identical to an adapter score from
 * the trainer — but it IS what BookForge will actually do, and comparing two
 * models through this one harness is valid. Quote the model id with the score.
 *
 * A note on the eval split itself: v4 re-segmented the corpus, so the eval
 * blocks CHANGED (6,002 -> 6,966). A v3 score from before that rework cannot be
 * compared to a v4 score. Re-baseline v3 through this tool on the new split
 * first; that is the whole reason it was written.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = p => p.replace(/^~(?=\/)/, os.homedir());

if (argv.includes('--help') || argv.includes('-h')) {
  console.error(
    'usage: node --require cli/electron-stub.js tools/rubric-score-eval.js\n' +
    '         [--sft <eval.jsonl>] [--model <id>] [--backend local|ollama]\n' +
    '         [--book <slug>] [--limit N] [--batch 8] [--json out.json]');
  process.exit(0);
}

const sftPath = path.resolve(tilde(opt('sft', '/Volumes/Callisto/training/rubric/sft/eval.jsonl')));
if (!fs.existsSync(sftPath)) { console.error(`rubric-score-eval: no such file: ${sftPath}`); process.exit(1); }
const model = opt('model', 'rubric-v3-4b');
const backend = opt('backend', 'local');
const endpoint = opt('endpoint', backend === 'ollama' ? 'http://localhost:11434' : '');
const jsonOut = opt('json', null);
const batch = Number(opt('batch', '8'));
const limit = Number(opt('limit', '0'));
const bookFilter = opt('book', null);
/**
 * Score a model whose taxonomy still has `table` against a split where truth has
 * `table` folded into `list` (v5 built with --merge-table-into-list). Without this
 * an older model is marked wrong on every table it gets RIGHT, and the comparison
 * measures the taxonomy change rather than the model. Predictions only — truth in
 * the split is already folded. Say it in the output so no score is quoted without it.
 */
const foldTable = argv.includes('--fold-table-into-list');

const enc = require(path.join(REPO_ROOT, 'dist/rubric/features/pdf-picker/services/rubric-encoder.js'));
const { rubricClassify } = require(path.join(REPO_ROOT, 'dist/electron/rubric-bridge.js'));

const CATEGORIES = ['body', 'title', 'chapter', 'heading', 'subheading', 'quote', 'caption',
  'footnote', 'header', 'footer', 'image', 'table', 'list'];
const LINE = /^\s*(\d+)\s+([a-z_]+)\s*$/;

/** -> [Map(id -> category), unparseableLineCount]. Last line wins: a repeated id
 *  is the model correcting itself mid-answer. */
function parseAnswer(text) {
  const out = new Map();
  let bad = 0;
  for (const raw of String(text ?? '').trim().split('\n')) {
    if (!raw.trim()) continue;
    const m = LINE.exec(raw);
    if (m) out.set(Number(m[1]), m[2]); else bad++;
  }
  return [out, bad];
}

let rows = fs.readFileSync(sftPath, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
if (bookFilter) rows = rows.filter(r => r.book === bookFilter);
if (limit) rows = rows.slice(0, limit);
if (!rows.length) { console.error('rubric-score-eval: no rows to score'); process.exit(1); }

const isEval = /eval/.test(path.basename(sftPath));
console.log(`[score] ${rows.length} pages from ${path.basename(sftPath)} ` +
  `(${isEval ? 'HELD-OUT — a true score' : 'TRAIN — a memorization ceiling, NOT performance'})`);
console.log(`[score] model=${model} backend=${backend}` +
  (foldTable ? '  [predicted `table` folded into `list`]' : ''));

(async () => {
  const confusion = new Map();            // "truth\tpred" -> n
  const perBook = new Map();              // book -> {right, wrong}
  let badLines = 0, missingBlocks = 0, extraBlocks = 0, badCategory = 0, pageExact = 0;
  const examples = [];
  const started = Date.now();

  const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);

  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    const res = await rubricClassify({
      endpoint, backend, model, batch: slice.length,
      stop: enc.RUBRIC_STOP, numCtx: 12288,
      pages: slice.map(r => ({
        system: r.messages[0].content, user: r.messages[1].content,
        raw: enc.toRawPrompt({ system: r.messages[0].content, user: r.messages[1].content }),
      })),
    });
    if (!res.success) { console.error(`\nrubric-score-eval: ${res.error}`); process.exit(1); }

    slice.forEach((r, k) => {
      const [truth] = parseAnswer(r.messages[2].content);
      const [pred, bad] = parseAnswer(res.answers[k] ?? '');
      if (foldTable) for (const [bid, c] of pred) if (c === 'table') pred.set(bid, 'list');
      badLines += bad;
      const book = r.book ?? '?';
      if (!perBook.has(book)) perBook.set(book, { right: 0, wrong: 0 });
      const pb = perBook.get(book);
      let ok = true;
      for (const [bid, gold] of truth) {
        const got = pred.get(bid);
        if (got === undefined) {
          missingBlocks++; bump(confusion, `${gold}\t<missing>`); pb.wrong++; ok = false; continue;
        }
        if (!CATEGORIES.includes(got)) {
          badCategory++; bump(confusion, `${gold}\t<illegal>`); pb.wrong++; ok = false; continue;
        }
        bump(confusion, `${gold}\t${got}`);
        if (got === gold) { pb.right++; continue; }
        pb.wrong++; ok = false;
        if (examples.length < 60) {
          examples.push({ book, page: r.page, block: bid, truth: gold, pred: got });
        }
      }
      for (const id of pred.keys()) if (!truth.has(id)) extraBlocks++;
      if (ok && pred.size === truth.size) pageExact++;
    });

    process.stderr.write(`\r[score] ${Math.min(i + batch, rows.length)}/${rows.length} pages  ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s   `);
  }
  process.stderr.write('\n');

  let total = 0, correct = 0;
  for (const [k, n] of confusion) {
    total += n;
    const [t, p] = k.split('\t');
    if (t === p) correct += n;
  }

  // Per-class precision/recall/F1. <missing> and <illegal> cost the true class
  // its recall but belong to no class's precision — same as eval-rubric.py.
  const perClass = {};
  for (const cat of CATEGORIES) {
    let tp = 0, fn = 0, fp = 0;
    for (const [k, n] of confusion) {
      const [t, p] = k.split('\t');
      if (t === cat && p === cat) tp += n;
      else if (t === cat) fn += n;
      else if (p === cat) fp += n;
    }
    const support = tp + fn;
    if (!support && !fp) continue;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = support ? tp / support : 0;
    const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
    perClass[cat] = { support, precision: +prec.toFixed(4), recall: +rec.toFixed(4),
                      f1: +f1.toFixed(4), tp, fp, fn };
  }
  const cats = Object.keys(perClass);
  const macroF1 = cats.length ? cats.reduce((s, c) => s + perClass[c].f1, 0) / cats.length : 0;

  const confusions = [...confusion.entries()]
    .map(([k, n]) => { const [truth, pred] = k.split('\t'); return { n, truth, pred }; })
    .filter(c => c.truth !== c.pred)
    .sort((a, b) => b.n - a.n);

  const report = {
    model, backend, sft: sftPath, split: isEval ? 'eval' : 'train',
    pages: rows.length, blocks: total,
    block_accuracy: total ? +(correct / total).toFixed(4) : 0,
    macro_f1: +macroF1.toFixed(4),
    page_exact_match: +(pageExact / rows.length).toFixed(4),
    format_failures: { unparseable_lines: badLines, missing_blocks: missingBlocks,
                       extra_blocks: extraBlocks, illegal_categories: badCategory },
    per_class: perClass,
    top_confusions: confusions.slice(0, 25),
    per_book: Object.fromEntries([...perBook.entries()]
      .filter(([, c]) => c.right + c.wrong)
      .map(([b, c]) => [b, { ...c, accuracy: +(c.right / (c.right + c.wrong)).toFixed(4) }])),
    error_examples: examples,
    elapsed_s: +((Date.now() - started) / 1000).toFixed(1),
  };

  console.log(`\n${model}  ${report.split.toUpperCase()} split`);
  console.log(`  blocks ${total}   accuracy ${(report.block_accuracy * 100).toFixed(2)}%   ` +
    `MACRO-F1 ${report.macro_f1.toFixed(4)}   page-exact ${(report.page_exact_match * 100).toFixed(1)}%`);
  const ff = report.format_failures;
  console.log(`  format: ${ff.missing_blocks} unanswered, ${ff.extra_blocks} invented, ` +
    `${ff.illegal_categories} illegal, ${ff.unparseable_lines} unparseable lines`);
  console.log('\n  class        support      P      R     F1');
  for (const c of cats.sort((a, b) => perClass[b].support - perClass[a].support)) {
    const m = perClass[c];
    console.log(`  ${c.padEnd(12)} ${String(m.support).padStart(6)}  ` +
      `${m.precision.toFixed(3)}  ${m.recall.toFixed(3)}  ${m.f1.toFixed(3)}`);
  }
  console.log('\n  top confusions (hand label -> model said)');
  for (const c of confusions.slice(0, 12)) {
    console.log(`    ${c.truth.padEnd(11)} -> ${c.pred.padEnd(11)} ${String(c.n).padStart(4)}`);
  }

  if (jsonOut) {
    fs.writeFileSync(tilde(jsonOut), JSON.stringify(report, null, 1));
    console.log(`\n[score] wrote ${tilde(jsonOut)}`);
  }
})();
