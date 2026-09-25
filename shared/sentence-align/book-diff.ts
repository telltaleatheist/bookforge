/**
 * THE BOOK'S WORDS, FOUND IN THE AUDIO — the diff at the heart of generate-sentences.
 *
 * Owen, 2026-09-24: "send the audio through qwen-asr, and then compare that to the
 * epub … find the proper nouns it got wrong … then send it through alignment so
 * it's exact … the goal is to get it as exact as possible, word-wise and
 * timestamp-wise." And: "bookforge manages the logic, but we dont ever directly
 * call the qwen model. we call it through the crucible api and get files back."
 *
 * So this file is pure logic, no I/O. It takes the EPUB's sentences and the words
 * Crucible's `asr` job heard (Qwen3-ASR, stamped by Qwen3-ForcedAligner), and
 * decides for every sentence where it is and how sure that is.
 *
 * ── THE BOOK TEXT IS THE TRUTH; ASR ONLY LOCATES AND CHECKS ────────────────
 *
 * No cue text ever comes from the ASR. A proper noun the ASR spelled wrong
 * ("Ellen" for "Elend") costs nothing: it sits exactly where "Elend" was spoken,
 * and its times are the aligner's times on that same stretch of audio, so the
 * EPUB word takes them. The ASR's spelling is never shown to anyone.
 *
 * ── HOW THE TWO WORD STREAMS ARE MATCHED ───────────────────────────────────
 *
 * A whole book is ~250,000 words on each side, too many for one edit-distance
 * table. So: ANCHORS first — word n-grams that occur exactly once in the book
 * AND exactly once in the transcript, kept only where they run forward on both
 * sides (longest increasing subsequence) — then a small edit-distance alignment
 * in each gap between anchors, where a near-miss spelling (Elend/Ellen) is
 * cheaper than an unrelated word. A gap too large for that is re-anchored with
 * shorter n-grams; one that still has no anchor is a stretch the two sides do
 * not share (a skipped chapter, an ad) and nothing in it is matched.
 *
 * ── WHAT EACH SENTENCE GETS ───────────────────────────────────────────────
 *
 *  - `placed`: its first and last words were heard, and most of the rest. Its
 *    word times are the ASR's (= the aligner's, on the same audio).
 *  - `disputed`: part of it was heard but not its edges, or too little of it
 *    matched to trust (numbers read out, a heading read differently, a garbled
 *    stretch). It goes to Crucible's `align` job with the EPUB's own text, in a
 *    window bounded by placed neighbours.
 *  - `unspoken`: almost none of it was heard. It is not placed and is reported
 *    — the forced aligner never refuses text, so handing it words that were not
 *    spoken would place them somewhere anyway.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tokens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A word reduced to what both sides can agree on: lower case, accents stripped,
 * apostrophes and punctuation gone ("Don't" = "dont", "Kelsier's" = "kelsiers").
 * Hyphens and dashes SPLIT words, because the two sides hyphenate differently
 * ("twenty-one" / "twenty one", "well—I" / "well I").
 */
export function normalizeWords(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‐‑‒–—―\-/]+/g, ' ')
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w !== '');
}

/** One heard word, in absolute book seconds. */
export interface HeardWord {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/** The EPUB side of the match: one token, and the sentence it belongs to. */
interface BookToken {
  readonly norm: string;
  readonly sentence: number;
}

/** One heard word split into tokens: each carries the word's index and times. */
interface HeardToken {
  readonly norm: string;
  readonly word: number;
  readonly start: number;
  readonly end: number;
}

/** How one book token was matched. */
export type MatchKind = 'exact' | 'fuzzy' | 'sub';

export interface TokenMatch {
  /** Index into the heard-token stream. */
  readonly heard: number;
  readonly kind: MatchKind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Similarity
// ─────────────────────────────────────────────────────────────────────────────

/** Levenshtein distance, early-out past `cap`. */
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/**
 * A near-miss spelling of the same spoken word: "elend"/"ellen", "vin"/"vinn",
 * "kelsier"/"kelsior". Both words at least 3 letters and at most a third of the
 * longer one's letters different. Short words must match exactly: "a"/"i",
 * "he"/"she" are different words, not misspellings.
 */
export function isNearMiss(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3) return false;
  const len = Math.max(a.length, b.length);
  // 40 percent of the longer word: "elend"/"ellen" is 2 of 5. A 3-letter word may differ by one.
  const cap = len <= 3 ? 1 : Math.round(len * 0.4);
  return editDistance(a, b, cap) <= cap;
}

// ─────────────────────────────────────────────────────────────────────────────
// The gap aligner (edit distance, small tables only)
// ─────────────────────────────────────────────────────────────────────────────

const COST_INDEL = 1;
const COST_FUZZY = 0.4;
/** Above one indel, below two: an unrelated word pair is a substitution only where
 *  that keeps both streams in step — never preferred over a real match nearby. */
const COST_SUB = 1.5;
/** The largest gap table the DP fills (cells). Bigger gaps are re-anchored first. */
const DP_MAX_CELLS = 4_000_000;

function alignGap(
  book: readonly string[], b0: number, b1: number,
  heard: readonly string[], h0: number, h1: number,
  out: (TokenMatch | null)[],
): void {
  const n = b1 - b0;
  const m = h1 - h0;
  if (n === 0 || m === 0) return;
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 0 diag, 1 up (book token unheard), 2 left (heard token extra)
  for (let j = 1; j <= m; j++) { cost[j] = j * COST_INDEL; move[j] = 2; }
  for (let i = 1; i <= n; i++) {
    cost[i * W] = i * COST_INDEL; move[i * W] = 1;
    const bw = book[b0 + i - 1];
    for (let j = 1; j <= m; j++) {
      const hw = heard[h0 + j - 1];
      const pair = bw === hw ? 0 : isNearMiss(bw, hw) ? COST_FUZZY : COST_SUB;
      let best = cost[(i - 1) * W + (j - 1)] + pair; let mv = 0;
      const up = cost[(i - 1) * W + j] + COST_INDEL;
      if (up < best) { best = up; mv = 1; }
      const left = cost[i * W + (j - 1)] + COST_INDEL;
      if (left < best) { best = left; mv = 2; }
      cost[i * W + j] = best; move[i * W + j] = mv;
    }
  }
  let i = n; let j = m;
  while (i > 0 && j > 0) {
    const mv = move[i * W + j];
    if (mv === 0) {
      const bw = book[b0 + i - 1]; const hw = heard[h0 + j - 1];
      out[b0 + i - 1] = { heard: h0 + j - 1, kind: bw === hw ? 'exact' : isNearMiss(bw, hw) ? 'fuzzy' : 'sub' };
      i--; j--;
    } else if (mv === 1) i--;
    else j--;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anchors
// ─────────────────────────────────────────────────────────────────────────────

/** n-grams occurring exactly once in [s0, s1) of `words`, keyed to their position. */
function uniqueGrams(words: readonly string[], s0: number, s1: number, k: number): Map<string, number> {
  const seen = new Map<string, number>();
  for (let p = s0; p + k <= s1; p++) {
    const g = words.slice(p, p + k).join(' ');
    seen.set(g, seen.has(g) ? -1 : p);
  }
  for (const [g, p] of seen) if (p < 0) seen.delete(g);
  return seen;
}

/** Longest strictly increasing subsequence of pairs by `.h`, pairs already sorted by `.b`. */
function lis(pairs: readonly { b: number; h: number }[]): { b: number; h: number }[] {
  const tails: number[] = []; const tailIdx: number[] = []; const prev = new Array<number>(pairs.length).fill(-1);
  pairs.forEach((p, i) => {
    let lo = 0; let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < p.h) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tailIdx[lo - 1];
    tails[lo] = p.h; tailIdx[lo] = i;
  });
  const out: { b: number; h: number }[] = [];
  for (let i = tailIdx.length ? tailIdx[tailIdx.length - 1] : -1; i >= 0; i = prev[i]) out.push(pairs[i]);
  return out.reverse();
}

/**
 * Match book[b0,b1) to heard[h0,h1): anchor on n-grams unique on both sides,
 * then align the gaps. `k` steps down 4 → 3 → 2 inside a gap too big for the DP.
 */
function matchRange(
  book: readonly string[], b0: number, b1: number,
  heard: readonly string[], h0: number, h1: number,
  out: (TokenMatch | null)[], k: number,
): void {
  if (b1 <= b0 || h1 <= h0) return;
  if ((b1 - b0) * (h1 - h0) <= DP_MAX_CELLS) { alignGap(book, b0, b1, heard, h0, h1, out); return; }
  if (k < 2) return; // no anchor and too big to align: the two sides do not share this stretch

  const gb = uniqueGrams(book, b0, b1, k);
  const gh = uniqueGrams(heard, h0, h1, k);
  const pairs: { b: number; h: number }[] = [];
  for (const [g, p] of gb) { const q = gh.get(g); if (q !== undefined) pairs.push({ b: p, h: q }); }
  pairs.sort((x, y) => x.b - y.b);
  // Anchors may overlap (two unique grams sharing words); keep one only when it
  // starts past the end of the last KEPT anchor on both sides.
  const chain: { b: number; h: number }[] = [];
  for (const p of lis(pairs)) {
    const last = chain[chain.length - 1];
    if (!last || (p.b >= last.b + k && p.h >= last.h + k)) chain.push(p);
  }
  if (chain.length === 0) { matchRange(book, b0, b1, heard, h0, h1, out, k - 1); return; }

  let pb = b0; let ph = h0;
  for (const a of chain) {
    matchRange(book, pb, a.b, heard, ph, a.h, out, k);
    for (let t = 0; t < k; t++) out[a.b + t] = { heard: a.h + t, kind: 'exact' };
    pb = a.b + k; ph = a.h + k;
  }
  matchRange(book, pb, b1, heard, ph, h1, out, k);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sentences
// ─────────────────────────────────────────────────────────────────────────────

export interface BookSentence {
  readonly text: string;
  readonly kind?: string;
}

export type SentenceStatus = 'placed' | 'disputed' | 'unspoken';

export interface WordTime {
  /** The EPUB word's normalized token. */
  readonly norm: string;
  /** Absolute seconds, or null for a word that was not heard. */
  readonly start: number | null;
  readonly end: number | null;
  readonly match: MatchKind | null;
}

export interface SentencePlacement {
  readonly index: number;
  readonly status: SentenceStatus;
  /** First heard word's start / last heard word's end, absolute seconds. Null when not placed. */
  readonly start: number | null;
  readonly end: number | null;
  /** Share of the sentence's tokens heard as the same word (exact or near-miss). */
  readonly coverage: number;
  readonly words: readonly WordTime[];
  /** Why a sentence is not `placed`, in words a person can act on. */
  readonly reason?: string;
}

/** A sentence is `placed` from the ASR alone when this much of it was heard. */
export const PLACED_MIN_COVERAGE = 0.6;
/** Below this it is `unspoken`: too little heard to put the text anywhere. */
export const UNSPOKEN_MAX_COVERAGE = 0.2;

export interface BookDiff {
  readonly sentences: readonly SentencePlacement[];
  /** Runs of heard words matching no book word (ads, intros, a heading read differently). */
  readonly extraAudio: readonly { readonly start: number; readonly end: number; readonly words: number; readonly text: string }[];
  readonly stats: {
    readonly bookTokens: number;
    readonly heardTokens: number;
    readonly exact: number;
    readonly fuzzy: number;
    readonly sub: number;
    readonly placed: number;
    readonly disputed: number;
    readonly unspoken: number;
  };
}

/** A run of unmatched heard words this long is listed as extra audio. */
const EXTRA_MIN_WORDS = 5;

export function diffBookAgainstHeard(sentences: readonly BookSentence[], heard: readonly HeardWord[]): BookDiff {
  const bookTok: BookToken[] = [];
  const sentTok: [number, number][] = [];
  sentences.forEach((s, si) => {
    const a = bookTok.length;
    for (const w of normalizeWords(s.text)) bookTok.push({ norm: w, sentence: si });
    sentTok.push([a, bookTok.length]);
  });
  const heardTok: HeardToken[] = [];
  heard.forEach((w, wi) => {
    const parts = normalizeWords(w.word);
    // A word the ASR joined ("twentyone") or split ("twenty one") keeps its own times;
    // a hyphenated heard word's parts share them (the aligner stamped the whole word).
    for (const p of parts) heardTok.push({ norm: p, word: wi, start: w.start, end: w.end });
  });

  const bookNorm = bookTok.map((t) => t.norm);
  const heardNorm = heardTok.map((t) => t.norm);
  const match: (TokenMatch | null)[] = new Array(bookTok.length).fill(null);
  matchRange(bookNorm, 0, bookNorm.length, heardNorm, 0, heardNorm.length, match, 4);

  let exact = 0; let fuzzy = 0; let sub = 0;
  for (const m of match) { if (!m) continue; if (m.kind === 'exact') exact++; else if (m.kind === 'fuzzy') fuzzy++; else sub++; }

  const placements: SentencePlacement[] = sentences.map((_, si) => {
    const [a, b] = sentTok[si];
    const words: WordTime[] = [];
    let same = 0;
    for (let t = a; t < b; t++) {
      const m = match[t];
      const h = m ? heardTok[m.heard] : null;
      if (m && m.kind !== 'sub') same++;
      words.push({ norm: bookTok[t].norm, start: h ? h.start : null, end: h ? h.end : null, match: m ? m.kind : null });
    }
    const n = b - a;
    const coverage = n === 0 ? 0 : same / n;
    const firstHeard = n > 0 && match[a] !== null;
    const lastHeard = n > 0 && match[b - 1] !== null;
    if (n === 0) {
      return { index: si, status: 'unspoken', start: null, end: null, coverage: 0, words, reason: 'no words to place (punctuation only)' };
    }
    // PLACED FROM THE ASR only when EVERY word was heard as itself (or a near-miss
    // spelling) and nothing else was heard in between: then each word's time is the
    // aligner's time on that word. "1024" heard as "ten twenty four" matched 4 of 5
    // words and the sentence's ends were right, but the number's own time was not —
    // "exact word-wise" means that sentence goes to the aligner with its own text.
    // coverage 1 = every token matched exact/near-miss, in order; contiguous = no heard token between them
    const contiguous = coverage === 1 && match[b - 1]!.heard - match[a]!.heard === b - a - 1;
    if (contiguous) {
      const s0 = heardTok[match[a]!.heard].start;
      const e0 = heardTok[match[b - 1]!.heard].end;
      if (e0 > s0) return { index: si, status: 'placed', start: s0, end: e0, coverage, words };
      return { index: si, status: 'disputed', start: null, end: null, coverage, words, reason: 'its heard words run backwards or have no length' };
    }
    if (coverage <= UNSPOKEN_MAX_COVERAGE && n >= 3) {
      return { index: si, status: 'unspoken', start: null, end: null, coverage, words, reason: `only ${Math.round(coverage * 100)}% of its words were heard` };
    }
    const why = !firstHeard ? 'its first word was not heard' : !lastHeard ? 'its last word was not heard'
      : coverage < 1 ? `${Math.round(coverage * 100)}% of its words were heard as written`
        : 'other words were heard in the middle of it';
    return { index: si, status: 'disputed', start: null, end: null, coverage, words, reason: why };
  });

  // Heard words no book word claimed AS ITSELF. A substitution does not claim: the
  // gap aligner pairs an ad with a skipped sentence word-for-word when their lengths
  // are close, and that pairing says nothing about either.
  const claimed = new Uint8Array(heardTok.length);
  for (const m of match) if (m && m.kind !== 'sub') claimed[m.heard] = 1;
  const extraAudio: { start: number; end: number; words: number; text: string }[] = [];
  for (let j = 0; j < heardTok.length;) {
    if (claimed[j]) { j++; continue; }
    let k = j; while (k < heardTok.length && !claimed[k]) k++;
    const firstWord = heardTok[j].word; const lastWord = heardTok[k - 1].word;
    const count = lastWord - firstWord + 1;
    if (count >= EXTRA_MIN_WORDS) {
      extraAudio.push({
        start: heardTok[j].start, end: heardTok[k - 1].end, words: count,
        text: heard.slice(firstWord, lastWord + 1).map((w) => w.word.trim()).join(' ').slice(0, 300),
      });
    }
    j = k;
  }

  const count = (s: SentenceStatus): number => placements.filter((p) => p.status === s).length;
  return {
    sentences: placements,
    extraAudio,
    stats: {
      bookTokens: bookTok.length, heardTokens: heardTok.length, exact, fuzzy, sub,
      placed: count('placed'), disputed: count('disputed'), unspoken: count('unspoken'),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows for the aligner
// ─────────────────────────────────────────────────────────────────────────────

export interface AlignWindowPlan {
  readonly index: number;
  /** Absolute seconds of audio to cut: from the placed sentence before to the placed sentence after. */
  readonly start: number;
  readonly end: number;
  /** The disputed sentences inside, in order. */
  readonly sentences: readonly number[];
  /** Their EPUB text, joined — what the aligner is told was spoken. */
  readonly text: string;
}

/** The aligner's own ceiling is 300 s (a refusal, not a split); stay well under it. */
export const WINDOW_MAX_S = 180;
/** How far past its own first/last heard word a window reaches (bounded by placed neighbours). */
export const WINDOW_MARGIN_S = 2.0;

/**
 * Every run of consecutive disputed sentences becomes one window, bounded by the
 * END of the placed sentence before it and the START of the placed sentence after
 * it — audio nothing else claims. A run whose bounds are more than WINDOW_MAX_S
 * apart is not sent: the two sides disagree over minutes there (a skipped or
 * re-read passage), and those sentences are reported rather than forced into it.
 */
export function planAlignWindows(
  diff: BookDiff, sentences: readonly BookSentence[], audioDuration: number,
): { windows: AlignWindowPlan[]; tooLong: { sentences: number[]; start: number; end: number }[] } {
  const P = diff.sentences;
  const windows: AlignWindowPlan[] = [];
  const tooLong: { sentences: number[]; start: number; end: number }[] = [];
  for (let i = 0; i < P.length;) {
    if (P[i].status !== 'disputed') { i++; continue; }
    let k = i; while (k < P.length && P[k].status !== 'placed') k++;
    const run = [];
    for (let t = i; t < k; t++) if (P[t].status === 'disputed') run.push(t);
    let before = 0; for (let t = i - 1; t >= 0; t--) if (P[t].status === 'placed') { before = P[t].end!; break; }
    let after = k < P.length ? P[k].start! : audioDuration;
    // Hug the run's OWN heard words when it has any: the audio between the placed
    // neighbours can also hold a skipped passage or an ad, and the aligner places
    // whatever text it is given — told one sentence over an ad, it puts it on the ad.
    const own = run.flatMap((s) => P[s].words).filter((w) => (w.match === 'exact' || w.match === 'fuzzy') && w.start !== null);
    if (own.length > 0) {
      const first = Math.min(...own.map((w) => w.start!)); const last = Math.max(...own.map((w) => w.end!));
      before = Math.max(before, first - WINDOW_MARGIN_S);
      after = Math.min(after, last + WINDOW_MARGIN_S);
      // ... and never into audio the book does not contain (an ad ending just before it).
      for (const x of diff.extraAudio) {
        if (x.end <= first && x.end > before) before = x.end;
        if (x.start >= last && x.start < after) after = x.start;
      }
    }
    if (after - before > WINDOW_MAX_S || after <= before) {
      tooLong.push({ sentences: run, start: before, end: after });
    } else {
      windows.push({ index: windows.length, start: before, end: after, sentences: run, text: run.map((t) => sentences[t].text).join(' ') });
    }
    i = k;
  }
  return { windows, tooLong };
}

/** One aligner item, window-relative seconds (the SDK's `AlignItem`). */
export interface AlignedItem {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Put a window's aligner items back onto its sentences. The items are the
 * aligner's own tokens (snap: "close, not guaranteed 1:1"), so they are matched
 * to the window's EPUB words with the same gap aligner as the book; a sentence
 * whose first and last words got times is placed, with `match` = what the item
 * matched as. The aligner was told this text, so every matched word is the EPUB
 * word — there is nothing to check against but the order and the length.
 */
export function placeWindow(
  window: AlignWindowPlan, sentences: readonly BookSentence[], items: readonly AlignedItem[],
): SentencePlacement[] {
  const toks: { norm: string; sentence: number }[] = [];
  for (const si of window.sentences) for (const w of normalizeWords(sentences[si].text)) toks.push({ norm: w, sentence: si });
  const itemTok: { norm: string; start: number; end: number }[] = [];
  for (const it of items) for (const p of normalizeWords(it.text)) itemTok.push({ norm: p, start: it.start + window.start, end: it.end + window.start });
  const match: (TokenMatch | null)[] = new Array(toks.length).fill(null);
  alignGap(toks.map((t) => t.norm), 0, toks.length, itemTok.map((t) => t.norm), 0, itemTok.length, match);

  return window.sentences.map((si) => {
    const idx = toks.map((t, i) => (t.sentence === si ? i : -1)).filter((i) => i >= 0);
    const words: WordTime[] = idx.map((i) => {
      const m = match[i]; const h = m ? itemTok[m.heard] : null;
      return { norm: toks[i].norm, start: h ? h.start : null, end: h ? h.end : null, match: m ? m.kind : null };
    });
    const first = words.find((w) => w.start !== null); const last = [...words].reverse().find((w) => w.end !== null);
    if (!first || !last || last.end! <= first.start!) {
      return { index: si, status: 'disputed', start: null, end: null, coverage: 0, words, reason: 'the aligner placed none of its words' };
    }
    const heardShare = words.filter((w) => w.match === 'exact' || w.match === 'fuzzy').length / Math.max(1, words.length);
    return { index: si, status: 'placed', start: first.start, end: last.end, coverage: heardShare, words };
  });
}
