#!/usr/bin/env node
/**
 * rubric-apply-predictions — run a shipping rubric model over one corpus book and
 * write a SECOND copy of that book with the model's labels in place of the human's,
 * so the run can be opened in the labeling UI and looked at page by page.
 *
 *   node --require ./cli/electron-stub.js tools/rubric-apply-predictions.js \
 *     --book Twisted_Cross_-_Bergen,_Doris_L_\(1996\) --model rubric-v5 --backend ollama
 *
 * A score tells you how often the model is right. It does not tell you what being
 * wrong LOOKS like — whether the misses are scattered or concentrated on the pages
 * that decide chapter splits. This writes the artifact you can actually inspect,
 * plus a disagreement report ranked by page so the worst pages are findable.
 *
 * SAFETY. The source book is opened read-only and never written. The copy goes to a
 * sibling directory suffixed with the model id, which cannot re-enter training:
 * gather-corpus.mjs works from an explicit allow-list, exactly because
 * model-labelled directories already live alongside human ones.
 *
 * The prompts come from the SFT split, not rebuilt here, so what the model sees is
 * byte-identical to what it was scored on. Block N of a page maps to the Nth block
 * of that page in labels.json — verified per page against the block count the
 * prompt declares, and a mismatch is a hard stop rather than a guess.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = p => p.replace(/^~(?=\/)/, os.homedir());

const TRAINING = path.resolve(tilde(opt('training', '~/Documents/BookForge/training')));
const bookDir = opt('book', null);
const model = opt('model', null);
const backend = opt('backend', 'ollama');
const endpoint = opt('endpoint', backend === 'ollama' ? 'http://localhost:11434' : '');
const batch = Number(opt('batch', '8'));

if (!bookDir || !model) {
  console.error('usage: node --require ./cli/electron-stub.js tools/rubric-apply-predictions.js \\\n' +
    '         --book <corpus dir name> --model <id> [--backend ollama|local] [--batch 8]');
  process.exit(1);
}

const enc = require(path.join(REPO_ROOT, 'dist/rubric/features/pdf-picker/services/rubric-encoder.js'));
const { rubricClassify } = require(path.join(REPO_ROOT, 'dist/electron/rubric-bridge.js'));

const srcDir = path.join(TRAINING, bookDir);
const labelsPath = path.join(srcDir, 'labels.json');
if (!fs.existsSync(labelsPath)) {
  console.error(`rubric-apply-predictions: no labels.json in ${srcDir}`);
  process.exit(1);
}
const labels = JSON.parse(fs.readFileSync(labelsPath, 'utf-8'));
const bookMeta = JSON.parse(fs.readFileSync(path.join(srcDir, 'book.json'), 'utf-8'));

/**
 * labels.json carries the same block TWICE and the two disagree, so which field
 * you read decides whether you are looking at the human's work or a machine's.
 *
 *   blocks[].category_id  the snapshot taken when the page was OCR'd — the
 *                         unified classifier's opening guess, never updated.
 *   labels[<block id>]    what the human actually said. Authoritative, and what
 *                         gather-corpus reads into the training set.
 *
 * On Gene Sharp those two disagree on 99 blocks — 35 of them subheadings — so
 * reading the wrong one silently scores the model against a stale machine guess
 * and reports the human as the one who changed their mind. Refuse to run rather
 * than fall back to category_id: a plausible wrong answer here is worse than a stop.
 */
if (!labels.labels || typeof labels.labels !== 'object') {
  console.error(`rubric-apply-predictions: ${labelsPath} has no top-level "labels" map. ` +
    `That map is the human labelling; blocks[].category_id is a stale pre-label snapshot ` +
    `and is not a substitute for it.`);
  process.exit(1);
}
const humanLabel = (b) => {
  const v = labels.labels[b.id];
  if (v === undefined) {
    console.error(`rubric-apply-predictions: block ${b.id} (page ${b.page}) has no entry in ` +
      `labels.labels. The book is partly labelled; refusing to report a score over it.`);
    process.exit(1);
  }
  return v;
};

// Blocks in page order — the ordering the encoder numbered them in.
const byPage = new Map();
for (const b of labels.blocks) {
  if (!byPage.has(b.page)) byPage.set(b.page, []);
  byPage.get(b.page).push(b);
}

// The prompts, taken from the split rather than rebuilt, so this run is the scored run.
const slugOf = (r) => r.book;
const rows = [];
for (const split of ['eval', 'train']) {
  const p = path.join(TRAINING, 'sft', `${split}.jsonl`);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    r._split = split;
    rows.push(r);
  }
}
// One book. Match on the slug the SFT rows carry, resolved from the corpus dir name.
const slugs = new Set(rows.map(slugOf));
const wanted = [...slugs].filter(s => {
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(bookDir).includes(norm(s)) || norm(s).includes(norm(bookDir).slice(0, 20));
});
if (wanted.length !== 1) {
  console.error(`rubric-apply-predictions: ${bookDir} matched ${wanted.length} SFT book slugs ` +
    `(${wanted.join(', ') || 'none'}). Candidates: ${[...slugs].join(', ')}`);
  process.exit(1);
}
const slug = wanted[0];
const mine = rows.filter(r => slugOf(r) === slug).sort((a, b) => a.page - b.page);
if (!mine.length) { console.error(`rubric-apply-predictions: no SFT rows for ${slug}`); process.exit(1); }

console.log(`[apply] book ${bookDir}`);
console.log(`[apply] slug ${slug} — ${mine.length} pages (${mine.filter(r => r._split === 'eval').length} held out)`);
console.log(`[apply] model=${model} backend=${backend}`);

const LINE = /^\s*(\d+)\s+([a-z_]+)\s*$/;
const CATEGORIES = new Set(labels.labelSet);

(async () => {
  const predicted = new Map();   // blockId -> category
  const disagreements = [];
  let missing = 0, illegal = 0, right = 0, total = 0;
  const started = Date.now();

  for (let i = 0; i < mine.length; i += batch) {
    const slice = mine.slice(i, i + batch);
    const res = await rubricClassify({
      endpoint, backend, model, batch: slice.length,
      stop: enc.RUBRIC_STOP, numCtx: 12288,
      pages: slice.map(r => ({
        system: r.messages[0].content, user: r.messages[1].content,
        raw: enc.toRawPrompt({ system: r.messages[0].content, user: r.messages[1].content }),
      })),
    });
    if (!res.success) { console.error(`\nrubric-apply-predictions: ${res.error}`); process.exit(1); }

    slice.forEach((r, k) => {
      const pageBlocks = byPage.get(r.page) || [];
      const declared = Number((r.messages[1].content.match(/(\d+) blocks/) || [])[1]);
      if (declared !== pageBlocks.length) {
        console.error(`\nrubric-apply-predictions: page ${r.page} prompt declares ${declared} blocks ` +
          `but labels.json has ${pageBlocks.length}. The index mapping is not valid for this book; ` +
          `refusing to write labels that would be attached to the wrong blocks.`);
        process.exit(1);
      }
      const answer = new Map();
      for (const raw of String(res.answers[k] ?? '').trim().split('\n')) {
        const m = LINE.exec(raw);
        if (m) answer.set(Number(m[1]), m[2]);
      }
      pageBlocks.forEach((b, idx) => {
        total++;
        const got = answer.get(idx + 1);
        const gold = humanLabel(b);
        if (got === undefined) { missing++; predicted.set(b.id, gold); disagreements.push({ page: r.page, id: b.id, gold, pred: '<missing>', text: (b.text || '').slice(0, 60) }); return; }
        if (!CATEGORIES.has(got)) { illegal++; predicted.set(b.id, gold); disagreements.push({ page: r.page, id: b.id, gold, pred: `<illegal:${got}>`, text: (b.text || '').slice(0, 60) }); return; }
        predicted.set(b.id, got);
        if (got === gold) right++;
        else disagreements.push({ page: r.page, id: b.id, gold, pred: got, text: (b.text || '').slice(0, 60) });
      });
    });
    process.stdout.write(`\r[apply] ${Math.min(i + batch, mine.length)}/${mine.length} pages  ${Math.round((Date.now() - started) / 1000)}s   `);
  }
  console.log();

  // ── write the copy ────────────────────────────────────────────────────────
  const outDir = `${srcDir}__PREDICTED_BY_${model}`;
  fs.mkdirSync(outDir, { recursive: true });
  // Write BOTH fields. `labels` is what the editor renders and what any downstream
  // reader treats as the labelling; category_id is kept in step so the two cannot
  // disagree in this copy the way they do in the source.
  const outLabelMap = {};
  for (const b of labels.blocks) outLabelMap[b.id] = predicted.get(b.id) ?? humanLabel(b);
  const outLabels = {
    ...labels,
    savedAt: new Date().toISOString(),
    labels: outLabelMap,
    blocks: labels.blocks.map(b => ({ ...b, category_id: outLabelMap[b.id] })),
  };
  fs.writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify(outLabels));
  fs.copyFileSync(path.join(srcDir, 'blocks.json'), path.join(outDir, 'blocks.json'));
  fs.writeFileSync(path.join(outDir, 'book.json'), JSON.stringify({
    ...bookMeta,
    title: `${bookMeta.title} [labels predicted by ${model}]`,
    predictedBy: model,
    predictedAt: new Date().toISOString(),
    note: 'MODEL OUTPUT, NOT HUMAN LABELS. Never add this to the gather-corpus allow-list.',
  }, null, 2));

  // ── the report ────────────────────────────────────────────────────────────
  const byPageCount = new Map();
  for (const d of disagreements) byPageCount.set(d.page, (byPageCount.get(d.page) || 0) + 1);
  const worst = [...byPageCount].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const confusion = new Map();
  for (const d of disagreements) {
    const k = `${d.gold} -> ${d.pred}`;
    confusion.set(k, (confusion.get(k) || 0) + 1);
  }
  fs.writeFileSync(path.join(outDir, 'disagreements.json'), JSON.stringify({
    book: slug, model, backend, blocks: total, agree: right,
    accuracy: total ? right / total : 0,
    missing, illegal,
    worstPages: worst.map(([page, n]) => ({ page, wrong: n, of: (byPage.get(page) || []).length })),
    topConfusions: [...confusion].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, n]) => ({ confusion: k, n })),
    disagreements,
  }, null, 2));

  console.log(`\n[apply] ${right}/${total} blocks agree with the human labels  (${(right / total * 100).toFixed(1)}%)`);
  if (missing) console.log(`[apply] ${missing} blocks the model never answered for (kept human label)`);
  if (illegal) console.log(`[apply] ${illegal} illegal categories (kept human label)`);
  console.log(`\n[apply] worst pages (1-based page numbers as shown in the editor):`);
  for (const [page, n] of worst.slice(0, 8)) console.log(`          page ${page + 1}: ${n} of ${(byPage.get(page) || []).length} wrong`);
  console.log(`\n[apply] top confusions:`);
  for (const [k, n] of [...confusion].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`          ${k}  ×${n}`);
  console.log(`\n[apply] wrote ${outDir}`);
  console.log(`          labels.json        — the model's labels, openable in the labeling UI`);
  console.log(`          disagreements.json — every block where it differs from the human`);
})();
