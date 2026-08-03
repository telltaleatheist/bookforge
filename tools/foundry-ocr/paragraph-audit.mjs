#!/usr/bin/env node
/**
 * paragraph-audit — how much PARAGRAPH damage is actually in the ocr corpus,
 * and how much of it ocr could even be blamed for.
 *
 *   node tools/foundry-ocr/paragraph-audit.mjs --pairs ~/Documents/BookForge/training/galley/paragraph-probe
 *
 * ocr repairs a block of OCR text. The question this answers is whether the
 * block's INTERNAL line/paragraph structure is damaged often enough to be worth
 * a training target — and, when it is damaged, whether the evidence needed to
 * fix it is inside the block (ocr's job) or in the block next door (the
 * `continues` head planned for blocks, docs/BLOCKS_TRAINING.md §9c).
 *
 * It reads the fields align-pairs.py added for exactly this: `ocrRaw`/`truthRaw`
 * (un-collapsed), `ocrLines`/`truthLines` (index-aligned, because geometry
 * assigned each truth word to an OCR LINE box), and `truthPar` — PyMuPDF's own
 * block/line numbering for the first and last truth word on each line.
 *
 * MEASURED vs ASSUMED, stated up front because it decides how much the numbers
 * are worth:
 *   MEASURED — every count below is over real mined pairs.
 *   ASSUMED  — that a change in PyMuPDF's block number means a paragraph
 *              boundary. PyMuPDF blocks come from its own layout clustering,
 *              not from the document's semantics; they usually track paragraphs
 *              in single-column body text and are less trustworthy around
 *              headings, footnotes and font changes. The audit therefore also
 *              reports the per-category breakdown so a caller can discount the
 *              categories where the assumption is weakest.
 *
 * Fails loudly: a pairs file without the new fields is a stale mine, not a
 * reason to guess.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = (p) => p.replace(/^~(?=\/)/, os.homedir());

const dir = opt('pairs', null);
if (!dir) { console.error('paragraph-audit: --pairs <dir of *.pairs.jsonl> is required'); process.exit(1); }
const root = path.resolve(tilde(dir));
const files = fs.readdirSync(root).filter((f) => f.endsWith('.pairs.jsonl')).sort();
if (!files.length) { console.error(`paragraph-audit: no *.pairs.jsonl in ${root}`); process.exit(1); }

// ── the app's own wrap-hyphen rule, verbatim from shared/text/line-join.ts ────
// Mirrored (not imported) because that file is TypeScript under the Angular
// build. If it drifts, this audit is measuring the wrong break.
const WRAP_END = /[A-Za-zÀ-ÿ]-[ \t]*$/;
const WRAP_CONT = /^[ \t]*[A-Za-zÀ-ÿ]/;
const isWrapHyphen = (a, b) => WRAP_END.test(a) && WRAP_CONT.test(b);
const SOFT_HYPHEN_END = /­[ \t]*$/;
const ws = (s) => s.split(/\s+/).filter(Boolean).join(' ');

const C = {
  blocks: 0, oneLine: 0,
  joinMismatch: 0,                 // ocrLines rejoined ≠ ocrRaw — assumption broken
  identicalRaw: 0,                 // ocrRaw === truthRaw, nothing to repair at all
  wsOnly: 0,                       // (d) differ only in whitespace after collapsing
  structDiffBlocks: 0,             // any structural difference of any kind
  // (a) wrap hyphens
  hyphOcr: 0, hyphBoth: 0, hyphTruthHealed: 0, hyphTruthSoft: 0,
  hyphOcrOnlyHallucinated: 0, hyphTruthOnly: 0, hyphUnknown: 0,
  // (b)/(c) breaks
  breakOcrNotTruth: 0,             // (b) OCR broke where the truth did not
  breakTruthNotOcr: 0,             // (c) truth broke where the OCR did not
  blocksWithTruthParaBreak: 0,     // ≥1 truth paragraph boundary inside one block
  truthParaBreaks: 0,
  emptyTruthLine: 0,
  // ownership
  withinBlockTargets: 0,           // blocks ocr could be trained on
  betweenBlockOnly: 0,             // blocks whose only damage needs a neighbour
  fragmentBlocks: 0,               // block is part of a truth paragraph that spans blocks
  // A bno change is only evidence of a PARAGRAPH if it is not just PyMuPDF
  // cutting a block mid-word: measured, "Berlin-‖Lichterfelde" is a bno change
  // and obviously not a paragraph. Strict count excludes any boundary whose
  // preceding line ends in a hyphen of either kind.
  weldedStrict: 0, weldedHyphenExplained: 0,
  // Fragment buckets. One PyMuPDF block that swallows a whole page makes every
  // OCR block on it look like a fragment; that is PyMuPDF failing to segment,
  // not the OCR splitting a paragraph. Bucketed so the two cannot be confused.
  fragSmall: 0, fragMid: 0, fragMega: 0,
};
const paraSizeHist = new Map();
const byCat = new Map();
const byBook = new Map();
const samples = { merge: [], hallucinatedHyphen: [], healed: [], fragment: [] };

// A truth paragraph (book,page,PyMuPDF bno) -> the set of OCR blocks it touched.
const paraToBlocks = new Map();

const rows = [];
for (const f of files) {
  for (const line of fs.readFileSync(path.join(root, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.ocrRaw === undefined || r.truthPar === undefined) {
      console.error(`paragraph-audit: ${f} has no ocrRaw/truthPar — it was mined before the\n` +
        'additive fields existed. Re-mine it (mine-book.mjs --force) rather than\n' +
        'auditing a corpus that cannot answer the question.');
      process.exit(1);
    }
    rows.push(r);
  }
}

// pass 1 — build the truth-paragraph → OCR-block map (needs all rows first,
// because "does this paragraph continue into the next block" is not a fact any
// single row carries).
for (const r of rows) {
  for (const tp of r.truthPar) {
    if (!tp) continue;
    for (const bno of new Set([tp[0], tp[2]])) {
      const k = `${r.book}|${r.page}|${bno}`;
      if (!paraToBlocks.has(k)) paraToBlocks.set(k, new Set());
      paraToBlocks.get(k).add(r.blockId);
    }
  }
}

// pass 2 — classify each block
for (const r of rows) {
  C.blocks++;
  const cat = r.category ?? 'unknown';
  if (!byCat.has(cat)) byCat.set(cat, { n: 0, struct: 0, para: 0, hyph: 0, frag: 0 });
  if (!byBook.has(r.book)) byBook.set(r.book, { n: 0, struct: 0, para: 0, hyph: 0, frag: 0 });
  const ct = byCat.get(cat), cb = byBook.get(r.book);
  ct.n++; cb.n++;

  const oL = r.ocrLines, tL = r.truthLines, tp = r.truthPar;
  if (oL.length <= 1) C.oneLine++;

  // Verify the assumption that ocrLines really is what ocrRaw was built from.
  // If this ever fires the index alignment between ocrLines and truthLines is
  // not trustworthy and every number below is suspect — so it is counted, not
  // swallowed.
  let rejoin = '';
  for (let i = 0; i < oL.length; i++) rejoin = i === 0 ? oL[i] : rejoin + (isWrapHyphen(rejoin, oL[i]) ? '\n' : ' ') + oL[i];
  if (ws(rejoin) !== ws(r.ocrRaw)) C.joinMismatch++;

  if (r.ocrRaw === r.truthRaw) C.identicalRaw++;
  else if (ws(r.ocrRaw) === ws(r.truthRaw)) C.wsOnly++;

  let struct = false, paraBreak = false, hyphTarget = false;

  for (let i = 0; i + 1 < oL.length; i++) {
    const oHy = isWrapHyphen(oL[i], oL[i + 1]);
    const tEmpty = !tL[i].trim() || !tL[i + 1].trim();
    if (tEmpty) { C.emptyTruthLine++; if (oHy) { C.hyphOcr++; C.hyphUnknown++; } continue; }
    const tHy = isWrapHyphen(tL[i], tL[i + 1]);
    const tSoft = SOFT_HYPHEN_END.test(tL[i]);

    // (a) wrap hyphens. The point of interest is not how many there are but
    // whether the TRUTH resolves them: a PDF text layer normally carries the
    // same hard hyphen the printer set, in which case it teaches ocr
    // nothing about whether to heal.
    if (oHy) {
      C.hyphOcr++;
      if (tSoft) { C.hyphTruthSoft++; hyphTarget = true; struct = true; if (samples.healed.length < 6) samples.healed.push({ book: r.book, page: r.page, ocr: oL[i].slice(-30), truth: tL[i].slice(-30) }); }
      else if (tHy) C.hyphBoth++;
      else {
        C.hyphTruthHealed++; C.hyphOcrOnlyHallucinated++; hyphTarget = true; struct = true;
        if (samples.hallucinatedHyphen.length < 6) samples.hallucinatedHyphen.push({ book: r.book, page: r.page, ocrEnd: oL[i].slice(-34), truthEnd: tL[i].slice(-34) });
      }
    } else if (tHy) { C.hyphTruthOnly++; struct = true; }

    // (b)/(c). The OCR's rendered break at i|i+1 is a LINE break. The truth's
    // is a line break too unless PyMuPDF's block number changes across it, in
    // which case the typesetter started a new paragraph exactly where the OCR
    // ran two lines of one block together.
    const aBno = tp[i] ? tp[i][2] : null;
    const bBno = tp[i + 1] ? tp[i + 1][0] : null;
    if (aBno !== null && bBno !== null && aBno !== bBno) {
      C.truthParaBreaks++; C.breakTruthNotOcr++; paraBreak = true; struct = true;
      if (oHy || tHy || tSoft) C.weldedHyphenExplained++; else C.weldedStrict++;
      if (samples.merge.length < 8) samples.merge.push({ book: r.book, page: r.page, cat, before: tL[i].slice(-46), after: tL[i + 1].slice(0, 46) });
    }
    // The reverse — OCR broke where the truth did not — cannot happen at the
    // LINE level here, because both sides use the same line partition by
    // construction. It shows up as the block-splitting case below instead, and
    // is counted there. Recording zero honestly rather than inventing a proxy.
  }

  // Between-block: does a truth paragraph this block touches also touch another
  // OCR block? Then the paragraph was split by segmentation, and no amount of
  // looking at this block alone can tell you it continues.
  let fragment = false, biggest = 1;
  for (const t of tp) {
    if (!t) continue;
    for (const bno of new Set([t[0], t[2]])) {
      const n = paraToBlocks.get(`${r.book}|${r.page}|${bno}`)?.size ?? 1;
      if (n > 1) fragment = true;
      if (n > biggest) biggest = n;
    }
  }
  paraSizeHist.set(biggest, (paraSizeHist.get(biggest) ?? 0) + 1);
  if (fragment) {
    C.fragmentBlocks++; ct.frag++; cb.frag++;
    if (biggest <= 3) C.fragSmall++; else if (biggest < 8) C.fragMid++; else C.fragMega++;
    if (samples.fragment.length < 6) samples.fragment.push({ book: r.book, page: r.page, cat, head: ws(r.truthRaw).slice(0, 60) });
  }

  if (struct) { C.structDiffBlocks++; ct.struct++; cb.struct++; }
  if (paraBreak) { C.blocksWithTruthParaBreak++; ct.para++; cb.para++; }
  if (hyphTarget) { ct.hyph++; cb.hyph++; }
  if (struct) C.withinBlockTargets++;
  else if (fragment) C.betweenBlockOnly++;
}

// ── report ───────────────────────────────────────────────────────────────────
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(2)}%`;
const P = (label, n, of = C.blocks) => console.log(`  ${label.padEnd(52)} ${String(n).padStart(6)}  ${pct(n, of)}`);

console.log(`PARAGRAPH AUDIT   ${files.length} book(s), ${C.blocks} aligned blocks   ${root}`);
console.log(`\nSANITY`);
P('single-line blocks (no internal structure at all)', C.oneLine);
P('ocrLines rejoin ≠ ocrRaw  (must be 0)', C.joinMismatch);
P('adjacent line pairs with an empty truth line', C.emptyTruthLine, C.emptyTruthLine + 1);

console.log(`\nHOW OFTEN DOES STRUCTURE DIFFER AT ALL`);
P('ocrRaw byte-identical to truthRaw', C.identicalRaw);
P('(d) differ in WHITESPACE ONLY (invisible to a reader)', C.wsOnly);
P('blocks with ANY structural difference', C.structDiffBlocks);

console.log(`\nBY KIND`);
P('(a) wrap hyphens in the OCR', C.hyphOcr);
P('     ...truth carries the SAME hard hyphen (no signal)', C.hyphBoth);
P('     ...truth uses a SOFT hyphen (heal signal)', C.hyphTruthSoft);
P('     ...truth has no hyphen there (OCR invented it)', C.hyphOcrOnlyHallucinated);
P('     ...truth line empty, undecidable', C.hyphUnknown);
P('(b) break in OCR but not truth (line level: impossible)', C.breakOcrNotTruth);
P('(c) break in truth but not OCR (paragraphs welded)', C.breakTruthNotOcr);
P('     ...of which mid-WORD (a hyphen, not a paragraph)', C.weldedHyphenExplained, C.truthParaBreaks);
P('     ...of which a real paragraph boundary', C.weldedStrict, C.truthParaBreaks);
P('blocks containing ≥1 welded paragraph boundary', C.blocksWithTruthParaBreak);

console.log(`\nOWNERSHIP`);
P('WITHIN-block damage — ocr could learn it', C.withinBlockTargets);
P('block is a FRAGMENT of a paragraph spanning blocks', C.fragmentBlocks);
P('  ...paragraph spans 2-3 OCR blocks (a real split)', C.fragSmall);
P('  ...spans 4-7 (real split or loose clustering)', C.fragMid);
P('  ...spans ≥8 — PyMuPDF ate the page, NOT an OCR split', C.fragMega);
P('  ...and has no within-block damage → blocks `continues`', C.betweenBlockOnly);
console.log('  blocks-per-truth-paragraph histogram (max over the block\'s paragraphs):');
console.log('    ' + [...paraSizeHist].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${v}`).join('  '));

console.log(`\nWOULD GAIN A PARAGRAPH-REPAIR TARGET`);
P('blocks with any within-block paragraph/hyphen target', C.withinBlockTargets);

console.log(`\nBY CATEGORY (blocks / any-struct / welded-para / hyphen-target / fragment)`);
for (const [k, v] of [...byCat].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${String(k).padEnd(18)} ${String(v.n).padStart(5)}  ${pct(v.struct, v.n).padStart(7)}  ${pct(v.para, v.n).padStart(7)}  ${pct(v.hyph, v.n).padStart(7)}  ${pct(v.frag, v.n).padStart(7)}`);
}
console.log(`\nBY BOOK`);
for (const [k, v] of byBook) {
  console.log(`  ${k.slice(0, 46).padEnd(48)} ${String(v.n).padStart(5)}  struct ${pct(v.struct, v.n).padStart(7)}  para ${pct(v.para, v.n).padStart(7)}  frag ${pct(v.frag, v.n).padStart(7)}`);
}

const show = (title, arr, fmt) => { if (!arr.length) return; console.log(`\n${title}`); for (const s of arr) console.log('  ' + fmt(s)); };
show('WELDED PARAGRAPHS (truth started a new block mid-OCR-block)', samples.merge,
  (s) => `${s.book.slice(0, 20)} p${s.page} [${s.cat}]  …${s.before}  ‖  ${s.after}…`);
show('OCR INVENTED A WRAP HYPHEN', samples.hallucinatedHyphen,
  (s) => `${s.book.slice(0, 20)} p${s.page}  ocr …${JSON.stringify(s.ocrEnd)}  truth …${JSON.stringify(s.truthEnd)}`);
show('TRUTH MARKED A SOFT HYPHEN', samples.healed,
  (s) => `${s.book.slice(0, 20)} p${s.page}  ocr …${JSON.stringify(s.ocr)}  truth …${JSON.stringify(s.truth)}`);
show('FRAGMENTS (paragraph continues in another block)', samples.fragment,
  (s) => `${s.book.slice(0, 20)} p${s.page} [${s.cat}]  ${JSON.stringify(s.head)}`);
