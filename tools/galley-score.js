#!/usr/bin/env node
/**
 * galley-score — score the OCR corrector on its held-out books.
 *
 *   node --require ./cli/electron-stub.js tools/galley-score.js \
 *     [--sft ~/Documents/BookForge/training/galley/sft/eval.jsonl] \
 *     [--model galley-v1-4b] [--backend ollama|local] [--limit N] [--json out.json]
 *
 * DO NOT JUDGE THIS MODEL BY LOSS. Two opposite failures are indistinguishable
 * from a loss curve and from each other unless you measure them separately:
 *
 *   a model that never edits    — perfect false-edit rate, repairs nothing
 *   a model that edits freely   — good recall, rewrites the author
 *
 * So the headline is a PAIR of numbers, never one. CER reduction says whether it
 * repaired anything; false-edit rate on identity blocks says what it cost. A
 * model is only better if it moves the first without moving the second.
 *
 * THE NUMBER THAT WOULD DAMAGE A BOOK is `rows made worse` — blocks whose CER
 * went UP after the model's edits were applied. Averages hide these: a model can
 * cut pooled CER handsomely while mangling a hundred proper nouns, because the
 * corpus is 8,589 distinct capitalised tokens and getting `Baden-Wiirttemberg`
 * wrong costs almost nothing in aggregate characters. Read that count before the
 * average, every time.
 *
 * `applier rejected` is not a damage number — the contract in tools/galley/edits.mjs
 * refuses those edits and the text survives untouched. It is a MODEL QUALITY
 * number: every rejection is the model failing to copy an anchor it could see,
 * which silently costs recall. A high reject rate with a good CER means the
 * model is right about what is broken and sloppy about quoting it.
 *
 * Scored against the same applier that runs in production, from the same module,
 * so a score here is a claim about what the app would actually do to the text.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = (p) => p.replace(/^~(?=\/)/, os.homedir());

if (argv.includes('--help') || argv.includes('-h')) {
  console.error('usage: node --require ./cli/electron-stub.js tools/galley-score.js\n' +
    '         [--sft <eval.jsonl>] [--model galley-v1-4b] [--backend ollama|local]\n' +
    '         [--endpoint URL] [--limit N] [--batch 8] [--json out.json] [--show N]');
  process.exit(0);
}

const sftPath = path.resolve(tilde(opt('sft', '~/Documents/BookForge/training/galley/sft/eval.jsonl')));
if (!fs.existsSync(sftPath)) { console.error(`galley-score: no such file: ${sftPath}`); process.exit(1); }
const model = opt('model', 'galley-v1-4b');
const backend = opt('backend', 'ollama');
const endpoint = opt('endpoint', backend === 'ollama' ? 'http://localhost:11434' : '');
const jsonOut = opt('json', null);
const batch = Number(opt('batch', '8'));
const limit = Number(opt('limit', '0'));
const show = Number(opt('show', '12'));

/** Levenshtein, iterative two-row. Blocks are short; this is not the bottleneck. */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Int32Array(b.length + 1);
  let cur = new Int32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca === b[j - 1] ? 0 : 1));
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}

(async () => {
  // edits.mjs is the contract module and is ESM; this file is CJS because it
  // loads the compiled electron bridge. Dynamic import is the seam.
  const { parseEdits, applyEdits, formatEdits } = await import('./galley/edits.mjs');
  const { loadRubricEncoder } = require(path.join(REPO_ROOT, 'cli/lib/load-rubric-encoder.js'));
  const enc = loadRubricEncoder();
  const { rubricClassify } = require(path.join(REPO_ROOT, 'dist/electron/rubric-bridge.js'));

  let rows = fs.readFileSync(sftPath, 'utf-8').split('\n').filter(Boolean).map(JSON.parse);
  if (limit > 0) rows = rows.slice(0, limit);
  if (!rows.length) { console.error('galley-score: eval set is empty'); process.exit(1); }

  // Recover each block's truth by applying its GOLD edits with the production
  // applier. build-corpus.mjs round-trip verified every target against this same
  // code, so this reproduces the truth exactly — and if it ever does not, the
  // corpus and the contract have drifted and the score is meaningless, so that
  // is a hard stop rather than a warning.
  const cases = rows.map((r, i) => {
    const input = r.messages[1].content;
    const goldText = r.messages[2].content;
    const gold = parseEdits(goldText);
    const applied = applyEdits(input, gold.edits);
    if (!applied.ok) {
      console.error(`galley-score: gold row ${i} (${r.book} p${r.page}) does not satisfy the applier ` +
        `contract — the corpus and tools/galley/edits.mjs have drifted. Rebuild the corpus.`);
      process.exit(1);
    }
    return { r, input, truth: applied.text, goldEdits: gold.edits, isIdentity: gold.edits.length === 0 };
  });

  const system = rows[0].messages[0].content;
  console.log(`galley-score — ${cases.length} blocks from ${sftPath}`);
  console.log(`  model ${model} via ${backend}${endpoint ? ' @ ' + endpoint : ''}`);
  console.log(`  ${cases.filter(c => c.isIdentity).length} identity blocks, ` +
    `${cases.filter(c => !c.isIdentity).length} needing repair\n`);

  const started = Date.now();
  const results = [];
  for (let i = 0; i < cases.length; i += batch) {
    const slice = cases.slice(i, i + batch);
    const res = await rubricClassify({
      endpoint, backend, model, batch, numCtx: 4096,
      stop: ['<|im_end|>'],
      pages: slice.map(c => {
        const page = { system, user: c.input };
        return { ...page, raw: enc.toRawPrompt(page) };
      }),
    });
    if (!res.success) { console.error(`\ngalley-score: ${res.error}`); process.exit(1); }
    slice.forEach((c, k) => {
      const answer = res.answers[k];
      if (typeof answer !== 'string') {
        console.error(`\ngalley-score: backend returned no answer for ${c.r.book} p${c.r.page}`);
        process.exit(1);
      }
      results.push({ ...c, answer });
    });
    const secs = (Date.now() - started) / 1000;
    process.stderr.write(`\r[galley-score] ${results.length}/${cases.length}  ` +
      `${(results.length / secs).toFixed(1)} blk/s   `);
  }
  process.stderr.write('\n');

  // ── measure ───────────────────────────────────────────────────────────────
  let charsTruth = 0, errBefore = 0, errAfter = 0;
  let identityTotal = 0, identityEdited = 0;
  let worse = 0, better = 0, unchanged = 0;
  let rejected = 0, emitted = 0, unparseable = 0;
  let tp = 0, fp = 0, fn = 0;
  const damaged = [];
  const missed = [];

  for (const c of results) {
    const parsed = parseEdits(c.answer);
    unparseable += parsed.bad;
    emitted += parsed.edits.length;
    const applied = applyEdits(c.input, parsed.edits);
    rejected += applied.rejected.length;

    const dBefore = lev(c.truth, c.input);
    const dAfter = lev(c.truth, applied.text);
    charsTruth += c.truth.length;
    errBefore += dBefore;
    errAfter += dAfter;

    if (dAfter > dBefore) { worse++; if (damaged.length < show) damaged.push({ c, applied, dBefore, dAfter }); }
    else if (dAfter < dBefore) better++;
    else unchanged++;

    if (c.isIdentity) {
      identityTotal++;
      // Counted on APPLIED edits: an edit the contract rejected never touched
      // the text, so it is a copy failure, not damage to the reader.
      if (applied.applied > 0) identityEdited++;
    } else if (dAfter === dBefore && missed.length < show) {
      missed.push({ c, applied });
    }

    // Edit-level agreement, exact match on the pair.
    const goldSet = new Set(c.goldEdits.map(e => `${e.before} ${e.after}`));
    const predSet = new Set(parsed.edits.map(e => `${e.before} ${e.after}`));
    for (const g of goldSet) (predSet.has(g) ? tp++ : fn++);
    for (const p of predSet) if (!goldSet.has(p)) fp++;
  }

  const cerBefore = errBefore / Math.max(1, charsTruth);
  const cerAfter = errAfter / Math.max(1, charsTruth);
  const prec = tp / Math.max(1, tp + fp);
  const rec = tp / Math.max(1, tp + fn);
  const f1 = 2 * prec * rec / Math.max(1e-9, prec + rec);

  const pct = (x) => `${(x * 100).toFixed(3)}%`;
  console.log('\n══ THE PAIR — read both or neither ═══════════════════════════════');
  console.log(`  CER  ${pct(cerBefore)} → ${pct(cerAfter)}   ` +
    `(${cerBefore > 0 ? ((1 - cerAfter / cerBefore) * 100).toFixed(1) : '0.0'}% of the error removed)`);
  console.log(`  FALSE-EDIT RATE  ${identityEdited}/${identityTotal} = ` +
    `${pct(identityEdited / Math.max(1, identityTotal))} of already-correct blocks were edited`);

  console.log('\n══ DAMAGE ════════════════════════════════════════════════════════');
  console.log(`  rows made WORSE   ${worse}   <- the number that would damage a book`);
  console.log(`  rows improved     ${better}`);
  console.log(`  rows unchanged    ${unchanged}`);

  console.log('\n══ MODEL QUALITY (harmless to the text, costly to recall) ════════');
  console.log(`  edits emitted     ${emitted}`);
  console.log(`  applier rejected  ${rejected}` +
    (emitted ? `  (${(rejected / emitted * 100).toFixed(1)}% — the model failed to copy its own anchor)` : ''));
  console.log(`  unparseable lines ${unparseable}`);
  console.log(`  edit P/R/F1       ${prec.toFixed(4)} / ${rec.toFixed(4)} / ${f1.toFixed(4)}`);

  if (damaged.length) {
    console.log('\n══ BLOCKS THE MODEL MADE WORSE ═══════════════════════════════════');
    for (const d of damaged) {
      console.log(`  ${d.c.r.book} p${d.c.r.page}  distance ${d.dBefore} → ${d.dAfter}`);
      console.log(`    emitted: ${d.c.answer.replace(/\n/g, ' | ').slice(0, 150)}`);
      console.log(`    gold:    ${formatEdits(d.c.goldEdits).replace(/\n/g, ' | ').slice(0, 150)}`);
    }
  }
  if (missed.length) {
    console.log('\n══ BLOCKS IT LEFT BROKEN ═════════════════════════════════════════');
    for (const m of missed) {
      console.log(`  ${m.c.r.book} p${m.c.r.page}  said: ${m.c.answer.replace(/\n/g, ' | ').slice(0, 90)}`);
      console.log(`    should have: ${formatEdits(m.c.goldEdits).replace(/\n/g, ' | ').slice(0, 110)}`);
    }
  }

  // Per-book, because a single bad book can carry the average and whole-book
  // holdout exists precisely so that is visible.
  const byBook = new Map();
  for (const c of results) {
    const b = byBook.get(c.r.book) ?? { n: 0, chars: 0, before: 0, after: 0, worse: 0 };
    const dB = lev(c.truth, c.input);
    const dA = lev(c.truth, applyEdits(c.input, parseEdits(c.answer).edits).text);
    b.n++; b.chars += c.truth.length; b.before += dB; b.after += dA; if (dA > dB) b.worse++;
    byBook.set(c.r.book, b);
  }
  console.log('\n══ PER BOOK ══════════════════════════════════════════════════════');
  for (const [book, b] of [...byBook].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`  ${book.padEnd(34)} ${String(b.n).padStart(4)} blk  ` +
      `CER ${pct(b.before / Math.max(1, b.chars))} → ${pct(b.after / Math.max(1, b.chars))}  worse ${b.worse}`);
  }

  if (jsonOut) {
    const p = path.resolve(tilde(jsonOut));
    fs.writeFileSync(p, JSON.stringify({
      generated: new Date().toISOString(), sft: sftPath, model, backend,
      blocks: results.length, identityTotal, identityEdited,
      cerBefore, cerAfter, worse, better, unchanged,
      emitted, rejected, unparseable, precision: prec, recall: rec, f1,
      byBook: Object.fromEntries([...byBook].map(([k, v]) => [k, {
        blocks: v.n, cerBefore: v.before / Math.max(1, v.chars),
        cerAfter: v.after / Math.max(1, v.chars), worse: v.worse,
      }])),
    }, null, 1));
    console.log(`\n[galley-score] wrote ${p}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
