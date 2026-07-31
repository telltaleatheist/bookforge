/**
 * icdar-to-pairs — convert the ICDAR post-OCR competition data into galley pairs.
 *
 *   node tools/galley/icdar-to-pairs.mjs [--out ~/…/galley/pairs] [--dry-run]
 *     [--sets eng_monograph]
 *
 * ONLY ONE OF THE THREE ENGLISH SETS IS USED, and the reason is measured rather
 * than assumed. Sampling every set for CER and orthography (250 files each):
 *
 *   icdar17 eng_monograph    CER  0.88%   median 0.6%   long-s 0.0/10k   USED
 *   icdar17 eng_periodical   CER  4.13%   median 4.2%   long-s 7.2/10k   skipped
 *   icdar19 EN               CER 22.43%   median 11.6%  long-s 6.8/10k   skipped
 *
 * eng_periodical and icdar19 are 19th-century and earlier newspapers set with
 * the long s (ſ), and icdar19's median block is 11.6% CER with a p90 of 51.8%.
 * §10d's measured ceiling is ~8% CER — past that the alignment itself collapses
 * — and a model trained on ſ learns a typographic convention no book in this
 * library uses. They are not "extra data", they are a different problem.
 *
 * eng_monograph at 0.88% CER is close to the domain corpus's own 0.45-0.58%,
 * which is what makes it a legitimate PRETRAINING stage: same task, same error
 * scale, different century. It is not a substitute for the domain corpus, and
 * it is tagged `source: icdar` so it can be dropped from a build in one filter.
 *
 * On the archaic vocabulary that remains (19.4 per 10k chars — hath, thou,
 * whilst): those words appear in the GROUND TRUTH, so the model sees them
 * preserved, never "corrected". That teaches exactly the restraint §9b's prompt
 * demands — do not modernise spelling — so it is a feature of this set rather
 * than a hazard.
 *
 * FORMAT. Each file has three lines: the raw OCR, and a character-aligned pair
 * where `@` marks a gap on that side and `#` marks a region with NO ground
 * truth. Segments containing `#` are dropped rather than guessed at — an
 * unaligned region is the one place where "truth" is known to be absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const tilde = (p) => p.replace(/^~(?=\/)/, os.homedir());

const corpora = path.resolve(tilde(opt('corpora', '~/Documents/BookForge/training/galley/public-corpora')));
const outDir = path.resolve(tilde(opt('out', '~/Documents/BookForge/training/galley/pairs')));
const dryRun = argv.includes('--dry-run');
const minChars = Number(opt('min-chars', '120'));
const maxChars = Number(opt('max-chars', '1200'));
const maxCer = Number(opt('max-cer', '0.08'));

/** Only the set that survived the measurement above. --sets can override. */
const SETS = (opt('sets', 'eng_monograph')).split(',').map((s) => s.trim()).filter(Boolean);
const BASE = path.join(corpora, 'icdar17/ICDAR2017_datasetPostOCR_Training_10M_v1.2');

const QUOTES = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '‐': '-', '‑': '-', '­': '' };
const fold = (s) => [...s.normalize('NFKC')].map((c) => QUOTES[c] ?? c).join('');

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
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

function walk(d, out = []) {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.txt')) out.push(p);
  }
  return out;
}

/**
 * Cut the aligned pair into segments a block-sized unit can carry.
 *
 * Two cuts, for different reasons: at `#` runs, because there is no truth
 * there; and at sentence ends once a segment is long enough, because galley's
 * unit is one block and a 12,000-character newspaper column is not one.
 */
function segments(ocrA, gsA) {
  const out = [];
  let o = '', t = '', started = false;
  const flush = () => {
    const oo = o.trim(), tt = t.trim();
    if (oo.length >= minChars && tt.length >= minChars) out.push([oo, tt]);
    o = ''; t = ''; started = false;
  };
  const n = Math.min(ocrA.length, gsA.length);
  for (let i = 0; i < n; i++) {
    const g = gsA[i], c = ocrA[i];
    if (g === '#') { flush(); continue; }        // no ground truth here
    if (g !== '@') t += g;
    if (c !== '@') o += c;
    started = true;
    if (started && o.length >= maxChars && /[.!?]/.test(t.slice(-1))) flush();
  }
  flush();
  return out;
}

const rows = [];
const skipped = { cer: 0, short: 0 };
let files = 0;

for (const set of SETS) {
  const dir = path.join(BASE, set);
  const list = walk(dir);
  if (!list.length) { console.error(`icdar-to-pairs: no files under ${dir}`); continue; }
  for (const f of list) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const get = (tag) => { const l = lines.find((x) => x.startsWith(tag)); return l ? l.slice(tag.length).replace(/^\s/, '') : null; };
    const ocrA = get('[OCR_aligned]');
    const gsA = get('[ GS_aligned]');
    if (!ocrA || !gsA) continue;
    files++;
    const id = path.basename(f, '.txt');
    let k = 0;
    for (const [ocr, truth] of segments(ocrA, gsA)) {
      const d = lev(truth, ocr);
      const cer = d / Math.max(1, truth.length);
      if (cer > maxCer) { skipped.cer++; continue; }
      const tf = fold(truth), of = fold(ocr);
      rows.push({
        book: `icdar17-${set}`, source: 'icdar', page: Number(id) || 0,
        blockId: `icdar_${set}_${id}_${k++}`, category: 'body',
        ocr, truth,
        cer: Number(cer.toFixed(5)),
        cerFolded: Number((lev(tf, of) / Math.max(1, tf.length)).toFixed(5)),
        cerFoldedCaseless: Number((lev(tf.toLowerCase(), of.toLowerCase()) / Math.max(1, tf.length)).toFixed(5)),
        ocrConf: null,
      });
    }
  }
}

const cers = rows.map((r) => r.cer).sort((a, b) => a - b);
const pct = (q) => (cers.length ? (cers[Math.floor(cers.length * q)] * 100).toFixed(2) + '%' : '-');
console.log(`icdar-to-pairs — sets: ${SETS.join(', ')}`);
console.log(`  ${files} files → ${rows.length} pairs   (dropped: ${skipped.cer} over --max-cer ${maxCer})`);
console.log(`  CER  median ${pct(0.5)}  p75 ${pct(0.75)}  p90 ${pct(0.9)}`);
console.log(`  identity pairs ${rows.filter((r) => r.cer === 0).length}`);
console.log('\n  These are 19th-century monographs. Use as a PRETRAINING stage; the');
console.log('  domain corpus mined from real books is what the model is judged on.');

if (dryRun) { console.log('\n--dry-run: nothing written'); process.exit(0); }
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'icdar17.pairs.jsonl');
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`\nwrote ${out}`);
