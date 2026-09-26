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

const key = (t: string): string => t.toLowerCase()
  .replace(/[‘’ʼ'`]/g, '').replace(/[‐-―-]/g, '').replace(/[^a-z0-9]/g, '');

interface Tok { readonly surface: string; readonly lead: string; readonly core: string; readonly trail: string; readonly k: string }

function tokens(text: string): Tok[] {
  return text.split(/\s+/).filter(Boolean).map((surface) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(surface)!;
    return { surface, lead: m[1], core: m[2], trail: m[3], k: key(surface) };
  }).filter((t) => t.k.length > 0 || t.surface.length > 0);
}

export interface Correction {
  readonly text: string;
  readonly changed: boolean;
  /** Share of the book's words the reader said (exact / near-miss / compound), in order. */
  readonly agreement: number;
  readonly edits: readonly { readonly op: 'replace' | 'insert' | 'delete'; readonly book?: string; readonly heard?: string }[];
}

type Op = 'match' | 'join2' | 'split2' | 'sub' | 'ins' | 'del';

/** Correct `bookText` to the words heard in its span. `heard` is the heard words in order. */
export function correctToHeard(bookText: string, heard: readonly string[]): Correction {
  const B = tokens(bookText).filter((t) => t.k.length > 0);
  const H = heard.map((w) => tokens(w)).flat().filter((t) => t.k.length > 0);
  const n = B.length; const m = H.length;
  if (n === 0) return { text: bookText, changed: false, agreement: 1, edits: [] };
  const same = (a: string, b: string): boolean => a === b || isNearMiss(a, b);
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
      if (i < n && j < m) relax(i + 1, j + 1, c + (same(B[i].k, H[j].k) ? 0 : 1), same(B[i].k, H[j].k) ? 'match' : 'sub');
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
  const kept = path.reduce((a, p) => a + (p.op === 'match' ? 1 : p.op === 'split2' ? 1 : p.op === 'join2' ? 2 : 0), 0);
  const agreement = kept / n;
  if (agreement < MIN_AGREEMENT) return { text: bookText, changed: false, agreement, edits: [] };

  const out: string[] = []; const edits: Correction['edits'][number][] = [];
  let bi = 0; let hj = 0;
  for (const p of path) {
    if (p.op === 'match') { out.push(B[bi].surface); bi++; hj++; }
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
