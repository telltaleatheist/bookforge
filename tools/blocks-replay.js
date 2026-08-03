#!/usr/bin/env node
/**
 * blocks-replay — score the shipping model against a labelled book's gold answers.
 *
 *   node --require cli/electron-stub.js tools/blocks-replay.js --book <slug>
 *        [--sft /Volumes/Callisto/training/blocks/sft/train.jsonl] [--model blocks-v3-4b]
 *        [--json out.json]
 *
 * Replays a book's OWN SFT conversations (the exact prompts, including the book's
 * per-variant normalizers) through the bundled llama-server and diffs the answers
 * against the hand labels in the gold assistant turns. This is how "what does the
 * model get wrong on <book>" is answered for any book already in the corpus —
 * including books labelled before runs were snapshotted, where no correction diff
 * exists.
 *
 * SAY WHAT THE NUMBER IS. A book from train.jsonl gives a MEMORIZATION CEILING —
 * errors there are the model's hard floor and their confusion structure is real,
 * but the agreement rate is not performance. A book from eval.jsonl is a true
 * held-out score. The output states which file the rows came from; quote it with
 * that label attached.
 *
 * First measured use (Churches V2, a train book, Jul 30 2026): 181/1,516 wrong at
 * the floor, and the image/caption/footer triangle was half of it — the same
 * starving classes the corpus plan already targets, confirmed from the other side.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

function usage(msg) {
  if (msg) console.error(`blocks-replay: ${msg}`);
  console.error(
    'usage: node --require cli/electron-stub.js tools/blocks-replay.js --book <slug>\n' +
    '         [--sft <train-or-eval.jsonl>] [--model blocks-v3-4b] [--json out.json]\n' +
    '       omit --book to list the books in the file');
  process.exit(msg ? 1 : 0);
}
if (argv.includes('--help') || argv.includes('-h')) usage();

const sftPath = path.resolve(
  (opt('sft', '/Volumes/Callisto/training/blocks/sft/train.jsonl'))
    .replace(/^~(?=\/)/, os.homedir()));
if (!fs.existsSync(sftPath)) usage(`no such file: ${sftPath}`);
const model = opt('model', 'blocks-v3-4b');
const jsonOut = opt('json', null);

const enc = require(path.join(REPO_ROOT, 'dist/blocks/features/pdf-picker/services/blocks-encoder.js'));
const { blocksClassify } = require(path.join(REPO_ROOT, 'dist/electron/blocks-bridge.js'));

const all = fs.readFileSync(sftPath, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
const book = opt('book', null);
if (!book) {
  const counts = new Map();
  for (const r of all) counts.set(r.book, (counts.get(r.book) ?? 0) + 1);
  console.log(`books in ${path.basename(sftPath)}:`);
  for (const [b, n] of [...counts.entries()].sort()) console.log(`  ${b}  (${n} pages)`);
  process.exit(0);
}
const rows = all.filter(r => r.book === book);
if (!rows.length) usage(`no rows for book "${book}" in ${sftPath} — run without --book to list`);

const isEval = /eval/.test(path.basename(sftPath));
console.log(`[replay] ${rows.length} pages of ${book} from ${path.basename(sftPath)} ` +
  `(${isEval ? 'HELD-OUT — a true score' : 'TRAIN — a memorization ceiling, not performance'})`);

const LINE = /^\s*(\d+)\s+([a-z_]+)\s*$/;
function parse(text) {
  const out = new Map();
  for (const ln of String(text).trim().split('\n')) {
    const m = LINE.exec(ln);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

(async () => {
  const confusion = new Map();
  const perClass = new Map();
  let total = 0, wrong = 0, missing = 0;
  const B = 8;
  const started = Date.now();

  for (let i = 0; i < rows.length; i += B) {
    const slice = rows.slice(i, i + B);
    const res = await blocksClassify({
      endpoint: '', backend: 'local', model, batch: B,
      stop: enc.BLOCKS_STOP, numCtx: 8192,
      pages: slice.map(r => ({
        system: r.messages[0].content, user: r.messages[1].content,
        raw: enc.toRawPrompt({ system: r.messages[0].content, user: r.messages[1].content }),
      })),
    });
    if (!res.success) { console.error(`blocks-replay: ${res.error}`); process.exit(1); }
    slice.forEach((r, k) => {
      const gold = parse(r.messages[2].content);
      const pred = parse(res.answers[k] ?? '');
      for (const [id, g] of gold) {
        total++;
        if (!perClass.has(g)) perClass.set(g, { n: 0, right: 0 });
        perClass.get(g).n++;
        const p = pred.get(id);
        if (p === undefined) { missing++; continue; }
        if (p === g) { perClass.get(g).right++; continue; }
        wrong++;
        const key = `${p}\t${g}`;
        confusion.set(key, (confusion.get(key) ?? 0) + 1);
      }
    });
    process.stderr.write(`\r[replay] ${Math.min(i + B, rows.length)}/${rows.length} pages  ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s   `);
  }
  process.stderr.write('\n');

  console.log(`\n[replay] blocks ${total}  wrong ${wrong} (${(wrong / total * 100).toFixed(1)}%)  unanswered ${missing}`);
  console.log('\n  model said -> hand label');
  const conf = [...confusion.entries()].sort((a, b) => b[1] - a[1]);
  for (const [k, n] of conf.slice(0, 15)) {
    const [p, g] = k.split('\t');
    console.log(`    ${p.padEnd(11)} -> ${g.padEnd(11)} ${String(n).padStart(4)}`);
  }
  console.log('\n  per true class: right/n');
  for (const [c, v] of [...perClass.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`    ${c.padEnd(11)} ${String(v.right).padStart(5)}/${v.n}`);
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({
      book, sft: sftPath, model, split: isEval ? 'eval' : 'train',
      total, wrong, missing,
      confusion: conf.map(([k, n]) => { const [p, g] = k.split('\t'); return { predicted: p, actual: g, n }; }),
      perClass: Object.fromEntries(perClass),
    }, null, 1));
    console.log(`\n[replay] wrote ${jsonOut}`);
  }
})();
