/**
 * THE CUE SAYS WHAT THE READER SAID (Owen, 2026-09-25): "a better idea would probably be to go with what the reader
 * actually said. just correct the vtt so it reflects the real audio so we arent losing training data."
 *
 * But the BOOK stays the authority for every word the reader did say: proper nouns and spellings are why we align to
 * the EPUB at all, and most ASR errors are near-misses ("Lessie" heard as "Lesci", "shattering" as "shuddering"). So
 * the correction is word by word, over an alignment of the book's words to the words heard in the cue's span:
 *
 *   same word / near-miss spelling      -> the BOOK's word (and its punctuation)
 *   one word = two heard, or the reverse -> the BOOK's form ("steel-jacketed" / "steel jacketed", "bubble had" /
 *                                          "bubblehead")
 *   a different word                    -> the READER's word, with the book word's punctuation around it
 *   a word the reader added             -> inserted
 *   a word the reader left out          -> removed (its sentence-final punctuation moves to the word before)
 *
 * When the two agree on fewer than MIN_AGREEMENT of the book's words the cue is more likely misplaced than reworded,
 * and nothing is corrected - the caller reports it for exclusion instead.
 */

import { isNearMiss } from './book-diff';

export const MIN_AGREEMENT = 0.3;

/** Owen's spot check, 2026-09-26 - five rules, each from a clip he heard:
 *   "Lt." / "St." / "Eph." heard as "Lieutenant" / "Saint" / "Ephesians": an ABBREVIATION of the heard word is the same
 *     word - the book keeps "Lt." and the render's cleanup expands it (the old replace left "Saint. Stephen's": a
 *     period mid-sentence);
 *   "Chantal" heard as "Gentile": a NAME (capitalised mid-sentence somewhere in the book) is never replaced;
 *   "nine thousand" heard as "9000": numbers compare by VALUE;
 *   "If neither explanation..." with "If" unheard by both listens: a 1-2 word deletion at the sentence's START or END is
 *     not applied - the ASR is weakest there (a dropped CLAUSE still defaults to the reader);
 *   trailing additions ("Ephesians 5 verse 21") are the cue's own words - see absorbGapWords in sentence-align.ts. */
export interface CorrectOptions {
  /** Lower-cased names from the whole book: never replaced by a heard word. */
  readonly properNouns?: ReadonlySet<string>;
}

/** Edge deletions of at most this many words are not applied (the ASR's weak spot). */
export const MAX_EDGE_DELETE = 2;

const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, million: 1000000, billion: 1000000000 };
/** "twentythree" (the hyphen keyed away) -> 23; a plain number word -> its value; anything else -> null. */
function wordValue(k: string): number | null {
  if (k in UNITS) return UNITS[k];
  if (k in TENS) return TENS[k];
  for (const t of Object.keys(TENS)) {
    const rest = k.slice(t.length);
    if (k.startsWith(t) && rest in UNITS && UNITS[rest] < 10) return TENS[t] + UNITS[rest];
  }
  return null;
}
const isNumberWord = (k: string): boolean => wordValue(k) !== null || k in SCALES;

const key = (t: string): string => t.toLowerCase()
  .replace(/[‘’ʼ'`]/g, '').replace(/[‐-―-]/g, '').replace(/[^a-z0-9]/g, '');

interface Tok { readonly surface: string; readonly lead: string; readonly core: string; readonly trail: string; readonly k: string }

function tokens(text: string): Tok[] {
  return text.split(/\s+/).filter(Boolean).map((surface) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(surface)!;
    return { surface, lead: m[1], core: m[2], trail: m[3], k: key(surface) };
  }).filter((t) => t.k.length > 0 || t.surface.length > 0);
}

/**
 * A run of number words becomes ONE token keyed by its value ("nine thousand" -> k "9000", surface kept), so it lines
 * up with an ASR numeral; a digits token already keys to its digits ("9,000" -> "9000"). A lone small number word
 * ("one", "nine") stays a word - it is more often "one of them" than a count.
 */
function mergeNumbers(ts: Tok[]): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < ts.length;) {
    if (!isNumberWord(ts[i].k) || ts[i].k in SCALES) { out.push(ts[i]); i++; continue; }
    let total = 0; let cur = 0; let j = i; let last = i;
    while (j < ts.length) {
      const k = ts[j].k;
      if (k === 'and' && j > i && j + 1 < ts.length && isNumberWord(ts[j + 1].k)) { j++; continue; }
      if (k in SCALES) { const sc = SCALES[k]; if (sc === 100) cur = (cur || 1) * 100; else { total += (cur || 1) * sc; cur = 0; } }
      else { const v = wordValue(k); if (v === null) break; cur += v; }
      last = j; j++;
      if (/[.,;:!?)”"]$/.test(ts[last].surface)) break;   // a run ends at punctuation
    }
    const single = last === i;
    if (single && (wordValue(ts[i].k) ?? 99) < 10) { out.push(ts[i]); i++; continue; }
    const span = ts.slice(i, last + 1);
    out.push({ surface: span.map((t) => t.surface).join(' '), lead: span[0].lead, core: span.map((t) => t.core).join(' '),
      trail: span[span.length - 1].trail, k: String(total + cur) });
    i = last + 1;
  }
  return out;
}

/** "Lt." against "lieutenant", "St." against "saint", "Eph." against "ephesians": a period-marked abbreviation of it. */
function abbreviates(b: Tok, h: Tok): boolean {
  if (!b.trail.startsWith('.') || b.k.length === 0 || b.k.length > 5 || h.k.length <= b.k.length) return false;
  if (!/^[A-Z]/.test(b.core) || h.k[0] !== b.k[0]) return false;
  let at = 0;   // the abbreviation's letters appear in order in the heard word
  for (const ch of h.k) if (at < b.k.length && ch === b.k[at]) at++;
  return at === b.k.length;
}

export interface Correction {
  readonly text: string;
  readonly changed: boolean;
  /** Share of the book's words the reader said (exact / near-miss / compound), in order. */
  readonly agreement: number;
  readonly edits: readonly { readonly op: 'replace' | 'insert' | 'delete'; readonly book?: string; readonly heard?: string }[];
}

type Op = 'match' | 'join2' | 'split2' | 'sub' | 'ins' | 'del' | 'keep';

/** Correct `bookText` to the words heard in its span. `heard` is the heard words in order. */
export function correctToHeard(bookText: string, heard: readonly string[], opts: CorrectOptions = {}): Correction {
  const B = mergeNumbers(tokens(bookText).filter((t) => t.k.length > 0));
  const H = mergeNumbers(heard.map((w) => tokens(w)).flat().filter((t) => t.k.length > 0));
  const n = B.length; const m = H.length;
  if (n === 0) return { text: bookText, changed: false, agreement: 1, edits: [] };
  const names = opts.properNouns;
  const sameTok = (b: Tok, h: Tok): boolean => b.k === h.k || isNearMiss(b.k, h.k) || abbreviates(b, h)
    || (names !== undefined && names.has(b.k) && /^[A-Z]/.test(b.core) && !/^\d/.test(h.k));
  // A compound is the same word when it joins EXACTLY ("steel"+"jacketed"), or by a near-miss only when every part
  // is a real word (>= 3 letters): "with"+"a" is one letter off "with", and "as"+"wayne" two off "wayne".
  const joins = (parts: string[], whole: string): boolean => parts.join('') === whole
    || (parts.every((x) => x.length >= 3) && Math.abs(parts.join('').length - whole.length) <= 2
        && isNearMiss(parts.join(''), whole));   // and near in LENGTH: "wayne"+"stepped" is 5 edits off "stepped" but a whole word longer
  // edit-distance DP, with free compound joins either way
  const INF = 1e9;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const back: Op[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill('match'));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j]; if (c >= INF) continue;
      const relax = (a: number, b: number, v: number, op: Op): void => { if (v < cost[a][b]) { cost[a][b] = v; back[a][b] = op; } };
      if (i < n && j < m) { const eq = sameTok(B[i], H[j]); relax(i + 1, j + 1, c + (eq ? 0 : 1), eq ? 'match' : 'sub'); }
      if (i < n && j + 1 < m && joins([H[j].k, H[j + 1].k], B[i].k)) relax(i + 1, j + 2, c, 'split2');   // book one = heard two
      if (i + 1 < n && j < m && joins([B[i].k, B[i + 1].k], H[j].k)) relax(i + 2, j + 1, c, 'join2');    // book two = heard one (near-miss: "bubble had" / "bubblehead")
      if (i < n) relax(i + 1, j, c + 1, 'del');
      if (j < m) relax(i, j + 1, c + 1, 'ins');
    }
  }
  // walk back
  const path: { op: Op; i: number; j: number }[] = [];
  let i = n; let j = m;
  while (i > 0 || j > 0) {
    const op = back[i][j]; path.push({ op, i, j });
    if (op === 'match' || op === 'sub') { i--; j--; } else if (op === 'split2') { i--; j -= 2; } else if (op === 'join2') { i -= 2; j--; }
    else if (op === 'del') i--; else j--;
  }
  path.reverse();
  // THE EDGES ARE THE ASR'S WEAK SPOT: a sentence's first or last word or two, unheard, stay as the book has them.
  const edgeRun = (from: number, step: number): number[] => {
    const idx: number[] = [];
    for (let k = from; k >= 0 && k < path.length; k += step) {
      if (path[k].op === 'del') idx.push(k); else if (path[k].op !== 'ins') break;
    }
    return idx;
  };
  const anyHeard = path.some((p) => p.op === 'match' || p.op === 'sub' || p.op === 'split2' || p.op === 'join2');
  for (const run of [edgeRun(0, 1), edgeRun(path.length - 1, -1)]) {
    if (anyHeard && run.length > 0 && run.length <= MAX_EDGE_DELETE) for (const k of run) path[k] = { ...path[k], op: 'keep' };
  }
  const kept = path.reduce((a, p) => a + (p.op === 'match' ? 1 : p.op === 'split2' ? 1 : p.op === 'join2' ? 2 : 0), 0);
  const agreement = kept / n;
  if (agreement < MIN_AGREEMENT) return { text: bookText, changed: false, agreement, edits: [] };

  const out: string[] = []; const edits: Correction['edits'][number][] = [];
  let bi = 0; let hj = 0;
  for (const p of path) {
    if (p.op === 'match' && abbreviates(B[bi], H[hj])) {
      // THE SPOKEN WORD, NO PERIOD (Owen, spot check 2: "Matt." should read "Matthew"; "Lieutenant Robin Huard - its a
      // title. theres no period there"). The book's case, the reader's word, the book's other trailing punctuation.
      const b = B[bi]; const h = H[hj];
      const word = /^[A-Z]/.test(b.core) ? h.core[0].toUpperCase() + h.core.slice(1) : h.core;
      out.push(b.lead + word + b.trail.replace(/^\./, '')); edits.push({ op: 'replace', book: b.surface, heard: h.core }); bi++; hj++;
    }
    else if (p.op === 'match') { out.push(B[bi].surface); bi++; hj++; }
    else if (p.op === 'keep') { out.push(B[bi].surface); bi++; }
    else if (p.op === 'split2') { out.push(B[bi].surface); bi++; hj += 2; }
    else if (p.op === 'join2') { out.push(B[bi].surface, B[bi + 1].surface); bi += 2; hj++; }
    else if (p.op === 'sub') {
      const b = B[bi]; const h = H[hj];
      out.push(b.lead + h.core + b.trail); edits.push({ op: 'replace', book: b.surface, heard: h.core }); bi++; hj++;
    } else if (p.op === 'ins') { out.push(H[hj].core); edits.push({ op: 'insert', heard: H[hj].core }); hj++; }
    else {
      const b = B[bi];
      // keep sentence punctuation the dropped word carried (".", "?", "!", closing quote)
      if (b.trail && /[.?!”"]/.test(b.trail) && out.length) out[out.length - 1] = out[out.length - 1].replace(/[^\p{L}\p{N}]*$/u, '') + b.trail;
      edits.push({ op: 'delete', book: b.surface }); bi++;
    }
  }
  let text = out.join(' ').replace(/\s+/g, ' ').trim();
  if (text && /^[a-z]/.test(text) && /^[A-Z]/.test(bookText.trim())) text = text[0].toUpperCase() + text.slice(1);
  return { text, changed: edits.length > 0, agreement, edits };
}
