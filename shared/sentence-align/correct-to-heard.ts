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
  /**
   * The book's UNUSUAL words (Owen 2026-09-27: "the books proper nouns and unusual words should be trusted. So this will
   * really be about finding paraphrasing, not superseding the book"): lower-case words of >= 6 letters the whole book
   * uses at most twice ("fluttered", heard as "flooded" in spot check 2). Like a name, never replaced by a heard word.
   */
  readonly rareWords?: ReadonlySet<string>;
  /**
   * A SECOND, INDEPENDENT LISTEN (a different ASR family - whisper-large-v3-turbo beside qwen3-asr; Owen 2026-09-27:
   * "Have whisper large turbo or something run on the problematic spots"). The re-check used the SAME model twice,
   * which shares its biases - Owen's spot check 2 found 7 of 15 corrections were one model's consistent mishearing.
   *
   * WHOSE SIDE IS THE SECOND LISTEN ON (Owen: "we need a way to score how similar they are ... so we can tell what's a
   * paraphrase from what's a transcription error"; "one word doesn't matter much, and I'd trust qwen over whisper").
   * Qwen's edits are grouped into REGIONS (a run of consecutive changes, "table 21" -> "the back of the book"). For each
   * region, the second listen's words over the same stretch are scored against the book's region and against Qwen's:
   *   sim(second, qwen) >= sim(second, book)  -> the audio departs from the book: Qwen's version (ties go to Qwen)
   *   sim(second, book) >  sim(second, qwen)  -> Qwen misheard: the book keeps the region
   * Every region's vote and margin is returned in `regions`; close calls are the review page's.
   */
  readonly secondOpinion?: readonly string[];
}

/** What keeping a name against a different heard word costs the alignment: more than a match, less than a sub. */
const KEPT_COST = 0.5;
/** Marks an emitted word written against the one before it (a `glued` token): the space before it is taken out. */
const GLUE = '\u0000';
/** A tie-breaker only: small enough that no number of them can outweigh a single edit in any cue. */
const EXACT_BONUS = 0.0001;

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

/**
 * A word's comparison key. ACCENTS ARE FOLDED, not dropped (2026-09-28): "Kébir" keyed "kbir" and never met the
 * reader's "Kebir". Exported because the caller builds the book's name and rare-word sets and must key them the
 * same way (`electron/crucible/sentence-align.ts`).
 */
export const wordKey = (t: string): string => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[‘’ʼ'`]/g, '').replace(/[‐-―-]/g, '').replace(/[^a-z0-9]/g, '');
const key = wordKey;

interface Tok {
  readonly surface: string; readonly lead: string; readonly core: string; readonly trail: string; readonly k: string;
  /** A merged DATE (`mergeDates`): which order it was written or said in - day first, or month first. */
  readonly date?: 'dm' | 'md';
  /** Written against the word before it with no space: the far side of an em or en dash ("army—three"). */
  readonly glued?: boolean;
}

/**
 * The words of `text`. AN EM OR EN DASH BETWEEN TWO WORDS SEPARATES THEM (2026-09-28): "army—three" was one token,
 * so "three" never met the number words after it, and "three hundred thousand" heard came back "three three hundred
 * thousand". The far word is marked `glued` and written back against the dash, with no space.
 */
function tokens(text: string): Tok[] {
  // A "&" opening a word is its own token ("Telegram &Gazette's", a typo): as a lead it was written back in front
  // of the reader's "and". Standalone, it keys to nothing and drops out, as "Harper & Row" always has.
  return text.replace(/(^|\s)&(?=\p{L})/gu, '$1& ').split(/\s+/).filter(Boolean)
    // Split at every dash between two words or numbers: "army—three", "2—what", and a range "1861–65", which a reader
    // says "1861 to 65" (the writer turns a dash said aloud into that "to"). NOT a citation's range ("6:9–18",
    // "3.1–4"): its numbers are one reference, and split, the reader's words landed on the wrong half.
    .flatMap((word) => word.split(/\d[:.]\d/.test(word)
      ? /(?<=\p{L}[—–])(?=[\p{L}\p{N}])|(?<=\p{N}[—–])(?=\p{L})/u
      : /(?<=[\p{L}\p{N}][—–])(?=[\p{L}\p{N}])/u).map((surface, i) => ({ surface, glued: i > 0 })))
    .map(({ surface, glued }) => {
      const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/u.exec(surface)!;
      // "&" IS THE WORD "and" (2026-09-28): keyed to nothing, it dropped out on the book side AND on a second listen
      // that also writes "&", so the vote sided with the book and vetoed the reader's "and" ("Johnson Johnson").
      if (/^&$/.test(surface.replace(/[^\p{L}\p{N}&]/gu, '')) && !/[\p{L}\p{N}]/u.test(surface)) {
        return { surface, lead: '', core: '&', trail: '', k: 'and', ...(glued ? { glued: true } : {}) };
      }
      return { surface, lead: m[1], core: m[2], trail: m[3], k: decimalKey(m[2]) ?? key(surface), ...(glued ? { glued: true } : {}) };
    }).filter((t) => t.k.length > 0 || t.surface.length > 0);
}

/**
 * A decimal's key keeps its point ("$1.488" -> "1.488"), so it meets the same decimal said aloud ("one point four
 * eight eight", `mergeNumbers`); the plain key dropped the point and made it 1488. Null for anything else.
 */
function decimalKey(core: string): string | null {
  // The digits AS WRITTEN, never re-formatted: "4.30" is not "4.3", and must still meet the ASR's "430".
  return /^\d[\d,]*\.\d+$/.test(core) ? core.replace(/,/g, '') : null;
}

/** A number under 100 as words, cardinal or ordinal ("14" -> "fourteen", "14th" -> "fourteenth"), keyed; else null. */
function spelledKey(k: string): string | null {
  const m = /^(\d{1,2})(st|nd|rd|th)?$/.exec(k); if (m === null) return null;
  const n = Number(m[1]); const ordinal = m[2] !== undefined;
  const unitOrd = Object.keys(ORDINAL_UNITS).find((w) => ORDINAL_UNITS[w] === n);
  if (ordinal && unitOrd !== undefined) return unitOrd;
  const card = Object.keys(UNITS).find((w) => UNITS[w] === n) ?? Object.keys(TENS).find((w) => TENS[w] === n);
  if (card !== undefined) return ordinal ? null : card;
  const tens = Object.keys(TENS).find((w) => TENS[w] === n - (n % 10)); if (tens === undefined) return null;
  const unit = n % 10;
  const tail = ordinal ? Object.keys(ORDINAL_UNITS).find((w) => ORDINAL_UNITS[w] === unit) : Object.keys(UNITS).find((w) => UNITS[w] === unit);
  return tail === undefined ? null : tens + tail;
}

/** A merged span's surface: its words' own, with a space only where the text had one. */
function joinSurfaces(span: readonly Tok[]): string {
  return span.map((t, i) => (i > 0 && !t.glued ? ' ' : '') + t.surface).join('');
}

/**
 * A DIGIT INSIDE A BOOK WORD is a typo, not a spelling to trust over the reader (2026-09-28): the EPUB's "al1one" was
 * kept as a near-miss of the heard "alone", and the text cleanup later read its 1 as "one" - "al one one".
 */
function typo(b: Tok): boolean {
  return /\p{L}\d+\p{L}/u.test(b.core);
}

/** A word's value as a number word or an ordinal word ("eight", "seventeenth"), or null. */
function valueOf(t: Tok): number | null {
  const day = /^\d/.test(t.k) ? null : readDay([t], 0);
  return wordValue(t.k) ?? (day !== null && day.len === 1 ? day.value : null);
}

/**
 * A LONE number word and the same digits are the same number (2026-09-28): "8–15" read "eight to fifteen", "17–18 May"
 * read "the seventeenth and eighteenth". `mergeNumbers` leaves a lone small word unmerged ("one of them"), so without
 * this the book's "8–" tied between the heard "eight" and the heard "to", took "to", and wrote "eight to–15". The
 * ALIGNMENT pairs them; the writer keeps the reader's spoken form ("Engine one", "First John"), as it always did.
 */
function sameValue(b: Tok, h: Tok): boolean {
  // A decimal against the same digits WITHOUT its point is the same number: the ASR writes "8.1 per cent" as "81",
  // and the old point-less key matched them, so the book's "8.1" stood.
  const bare = (k: string): string => k.replace('.', '');
  if ((b.k.includes('.') || h.k.includes('.')) && /^[\d.]+$/.test(b.k) && /^[\d.]+$/.test(h.k)
    && (bare(b.k) === bare(h.k) || Number(b.k) === Number(h.k))) return true;   // and "18.0" is 18
  return (/^\d+$/.test(b.k) && valueOf(h) === Number(b.k)) || (/^\d+$/.test(h.k) && valueOf(b) === Number(h.k));
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
      // "and" continues a number only after a scale word ("two hundred and five"); "1934 and 18.9" is two numbers.
      if (k === 'and' && j > i && ts[j - 1].k in SCALES && j + 1 < ts.length && isNumberWord(ts[j + 1].k)) { j++; continue; }
      if (k in SCALES) { const sc = SCALES[k]; if (sc === 100) cur = (cur || 1) * 100; else { total += (cur || 1) * sc; cur = 0; } }
      else {
        const v = wordValue(k); if (v === null) break;
        // A YEAR IS SAID IN PAIRS (2026-09-28): "nineteen thirty-three" is 1933, not 19 + 33. Two two-digit values in a
        // row are never a sum in speech ("twenty five" is a ten and a unit, and stays one).
        if (cur >= 10 && cur <= 99 && v >= 10 && j > i) cur = cur * 100 + v; else cur += v;
      }
      last = j; j++;
      if (/[.,;:!?)”"]$/.test(ts[last].surface)) break;   // a run ends at punctuation
    }
    /*
     * A DECIMAL SAID ALOUD (2026-09-28, mck): "one point four eight eight" is 1.488 - the digits after "point" are
     * read one by one, never summed ("four eight eight" was 20). Keyed like the book's "$1.488" (`decimalKey`).
     */
    let digits = '';
    if (ts[last + 1]?.k === 'point' && !/[.,;:!?)”"]$/.test(ts[last].surface)) {
      let d = last + 2;
      while (d < ts.length) {
        const v = wordValue(ts[d].k) ?? (/^\d$/.test(ts[d].k) ? Number(ts[d].k) : null);
        if (v === null || v > 9) break;
        digits += String(v); d++;
        if (/[.,;:!?)”"]$/.test(ts[d - 1].surface)) break;
      }
      if (digits !== '') last = d - 1;
    }
    const single = last === i;
    if (single && (wordValue(ts[i].k) ?? 99) < 10) { out.push(ts[i]); i++; continue; }
    const span = ts.slice(i, last + 1);
    out.push({ surface: joinSurfaces(span), lead: span[0].lead, core: span.map((t) => t.core).join(' '), ...(span[0].glued ? { glued: true } : {}),
      trail: span[span.length - 1].trail, k: digits === '' ? String(total + cur) : `${total + cur}.${digits}` });
    i = last + 1;
  }
  return out;
}

const MONTHS: Record<string, number> = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12 };
const ORDINAL_UNITS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7,
  eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15,
  sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };

/** A day of the month at `ts[i]` - "1", "1st", "first", "twenty-first", "twenty first" - as { value, len }, or null. */
function readDay(ts: Tok[], i: number): { value: number; len: number } | null {
  const k = ts[i]?.k; if (k === undefined) return null;
  const digits = /^(\d{1,2})(st|nd|rd|th)?$/.exec(k);
  if (digits) { const v = Number(digits[1]); return v >= 1 && v <= 31 ? { value: v, len: 1 } : null; }
  if (k in ORDINAL_UNITS) return { value: ORDINAL_UNITS[k], len: 1 };
  for (const t of ['twenty', 'thirty']) {
    const rest = k.slice(t.length);
    if (k.startsWith(t) && rest in ORDINAL_UNITS && ORDINAL_UNITS[rest] < 10) return { value: TENS[t] + ORDINAL_UNITS[rest], len: 1 };
    const next = ts[i + 1]?.k;
    if (k === t && next !== undefined && next in ORDINAL_UNITS && ORDINAL_UNITS[next] < 10) {
      return { value: TENS[t] + ORDINAL_UNITS[next], len: 2 };
    }
  }
  return null;
}

/** A value of 10..99 said in one or two words ("nineteen", "thirtythree", "thirty three"), or null. */
function readTwoDigit(ts: Tok[], i: number): { value: number; len: number } | null {
  const v = ts[i] === undefined ? null : wordValue(ts[i].k);
  if (v === null || v < 10) return null;
  const u = ts[i + 1] === undefined ? null : wordValue(ts[i + 1].k);
  if (ts[i].k in TENS && u !== null && u >= 1 && u <= 9) return { value: v + u, len: 2 };
  return { value: v, len: 1 };
}

/** A year at `ts[i]`: "1933", "nineteen thirty-three", "nineteen oh five", "nineteen hundred", "two thousand (and) five". */
function readYear(ts: Tok[], i: number): { value: number; len: number } | null {
  const k = ts[i]?.k; if (k === undefined) return null;
  if (/^\d{4}$/.test(k)) { const v = Number(k); return v >= 1000 && v <= 2099 ? { value: v, len: 1 } : null; }
  if (k === 'two' && ts[i + 1]?.k === 'thousand') {
    let j = i + 2; if (ts[j]?.k === 'and') j++;
    const rest = readTwoDigit(ts, j) ?? (ts[j] && wordValue(ts[j].k) !== null && wordValue(ts[j].k)! < 10 ? { value: wordValue(ts[j].k)!, len: 1 } : null);
    return rest === null ? { value: 2000, len: 2 } : { value: 2000 + rest.value, len: j - i + rest.len };
  }
  const hi = readTwoDigit(ts, i); if (hi === null) return null;
  const j = i + hi.len; const nk = ts[j]?.k;
  if (nk === 'hundred') return { value: hi.value * 100, len: hi.len + 1 };
  if ((nk === 'oh' || nk === 'o') && ts[j + 1] && (wordValue(ts[j + 1].k) ?? 99) < 10) {
    return { value: hi.value * 100 + wordValue(ts[j + 1].k)!, len: hi.len + 2 };
  }
  const lo = readTwoDigit(ts, j); if (lo === null) return null;
  const v = hi.value * 100 + lo.value;
  return v >= 1000 && v <= 2099 ? { value: v, len: hi.len + lo.len } : null;
}

/**
 * A DATE IS ONE TOKEN, KEYED BY ITS VALUE, IN EITHER ORDER (2026-09-28). Evans writes "1 December 1933" and the reader
 * says "December first nineteen thirty-three"; token by token the two cannot line up (an ordinal is not a number word,
 * and the month has moved), and the alignment paid for it with "December December 1933" on 1,039 Third Reich cues. So
 * a day next to a month - day first ("1 December", "the first of December") or month first ("December 1,", "December
 * the first") - with a year after it if there is one, becomes one token keyed `date:<month>-<day>[-<year>]`, which
 * matches the same date said the other way round. A month with no day beside it stays a word ("in May").
 */
/** Months that are also everyday words: "the first may seem", "we march first". */
const VERB_MONTHS = new Set(['may', 'march']);

/**
 * Is this month-and-day really a date? Always, unless the month is also a verb. Then it needs one more sign: a capital
 * on the month, a day in digits, "of" between them, or a year after.
 */
function unambiguous(month: Tok, day: Tok, of: boolean, year: boolean): boolean {
  if (!VERB_MONTHS.has(month.k)) return true;
  return /^[A-Z]/.test(month.core) || /^\d/.test(day.k) || of || year;
}

function mergeDates(ts: Tok[]): Tok[] {
  const out: Tok[] = [];
  // Nothing reaches across punctuation, except the comma before a year ("December 1, 1933"); no year across a sentence end.
  const bare = (t: Tok | undefined): boolean => t !== undefined && t.trail.length === 0;
  const yearAfter = (j: number): { value: number; len: number } | null =>
    (j > 0 && /[.;:!?]/.test(ts[j - 1].trail) ? null : readYear(ts, j));
  for (let i = 0; i < ts.length;) {
    let hit: { len: number; month: number; day: number; year: number | null; order: 'dm' | 'md' } | null = null;
    // day first: [the] DAY [of] MONTH [YEAR]
    {
      let j = i; if (ts[j]?.k === 'the') j++;
      const day = readDay(ts, j);
      if (day !== null) {
        let m = j + day.len; const of = ts[m]?.k === 'of'; if (of) m++;
        const month = ts[m] === undefined ? undefined : MONTHS[ts[m].k];
        const y = month === undefined ? null : yearAfter(m + 1);
        const joined = ts.slice(j, m).every(bare);
        // A SPOKEN ordinal before a month is a date only with "the" or "of" around it, or a year after it ("the
        // second of August", "fourteenth August 1914"): "a second August miracle" is an adjective and a name, and read
        // as 2 August it replaced the book's "second" and doubled the month (tc, 2026-09-28). A digit day ("2 August")
        // is a date as written.
        const spokenDay = !/^\d/.test(ts[j].k);
        const framed = !spokenDay || j > i || of || y !== null;
        if (month !== undefined && joined && framed && unambiguous(ts[m], ts[j], of, y !== null)) {
          hit = { len: m + 1 - i + (y?.len ?? 0), month, day: day.value, year: y?.value ?? null, order: 'dm' };
        }
      }
    }
    // month first: MONTH [the] DAY [YEAR]
    if (hit === null && ts[i] !== undefined && MONTHS[ts[i].k] !== undefined) {
      let j = i + 1; if (ts[j]?.k === 'the') j++;
      const day = readDay(ts, j);
      // A day, and not the head of a bigger number: "May 2" is a date, "May two thousand" is not.
      const y = day === null ? null : yearAfter(j + day.len);
      const joined = ts.slice(i, j).every(bare) && (day === null || ts.slice(j, j + day.len - 1).every(bare));
      if (day !== null && joined && !(ts[j + day.len] && ts[j + day.len].k in SCALES) && unambiguous(ts[i], ts[j], false, y !== null)) {
        hit = { len: j + day.len - i + (y?.len ?? 0), month: MONTHS[ts[i].k], day: day.value, year: y?.value ?? null, order: 'md' };
      }
    }
    if (hit === null) { out.push(ts[i]); i++; continue; }
    const span = ts.slice(i, i + hit.len);
    out.push({ surface: joinSurfaces(span), lead: span[0].lead, core: span.map((t) => t.core).join(' '), ...(span[0].glued ? { glued: true } : {}),
      trail: span[span.length - 1].trail, k: `date:${hit.month}-${hit.day}${hit.year === null ? '' : `-${hit.year}`}`, date: hit.order });
    i += hit.len;
  }
  return out;
}

/**
 * THE READER'S ORDER FOR A DATE THE BOOK WROTE THE OTHER WAY ROUND: the heard words, with the month spelled as the book
 * spells it (the ASR's case is not the book's), and the book's punctuation around the whole.
 */
function readerDate(b: Tok, h: Tok): string {
  const bookMonth = b.core.split(' ').find((w) => MONTHS[key(w)] !== undefined);
  const words = h.core.split(' ').map((w) => (bookMonth !== undefined && MONTHS[key(w)] !== undefined ? bookMonth : w));
  return b.lead + words.join(' ') + b.trail;
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
  /** Qwen regions the second listen sided against - the book kept them; listed for review. */
  readonly disputed?: readonly RegionVote[];
  /** Every region's vote (with a second opinion): what each side said, the similarities, and the decision. */
  readonly regions?: readonly RegionVote[];
  /** Share of the book's words the reader said (exact / near-miss / compound), in order. */
  readonly agreement: number;
  readonly edits: readonly { readonly op: 'replace' | 'insert' | 'delete'; readonly book?: string; readonly heard?: string }[];
}

type Op = 'match' | 'join2' | 'split2' | 'splitN' | 'sub' | 'ins' | 'del' | 'keep';

export interface RegionVote {
  /** the book's words over the region, Qwen's, and the second listen's */
  readonly book: string; readonly qwen: string; readonly second: string;
  readonly simBook: number; readonly simQwen: number;
  /** simQwen - simBook: > 0 leans to Qwen, < 0 to the book; |margin| small = a close call */
  readonly margin: number;
  readonly decision: 'qwen' | 'book';
}

/** Word similarity in [0, 1]: 1 - normalised edit distance over keys (near-miss spellings count as equal). */
function wordSim(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const n = a.length; const m = b.length; const d: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    let prev = d[0]; d[0] = i;
    for (let j = 1; j <= m; j++) {
      const t = d[j]; const eq = a[i - 1] === b[j - 1] || isNearMiss(a[i - 1], b[j - 1]);
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (eq ? 0 : 1)); prev = t;
    }
  }
  return 1 - d[m] / Math.max(n, m);
}

/** `held`: a MATCH step that is a name or rare word KEPT against a different heard word - written like a match, never counted as the reader saying it (`agreement`). */
type Path = { op: Op; i: number; j: number; n?: number; held?: boolean }[];

/** The book-vs-heard alignment: an edit-distance DP with free compound joins either way, then the edge rule. */
function alignPath(B: Tok[], H: Tok[], opts: CorrectOptions): Path {
  const n = B.length; const m = H.length;
  const names = opts.properNouns; const rare = opts.rareWords;
  // A DATE matches only the same date: its key is a value, and a near-miss of "date:12-1-1933" is another day.
  const sameTok = (b: Tok, h: Tok): boolean => (b.date !== undefined || h.date !== undefined || typo(b)) ? b.k === h.k
    : b.k === h.k || sameValue(b, h) || isNearMiss(b.k, h.k) || abbreviates(b, h);
  /*
   * A NAME OR RARE WORD IS KEPT against a heard word that is NOT it ("Chantal" heard as "Gentile"), but that pairing
   * is NOT A MATCH, and it costs (2026-09-28). It used to cost nothing, exactly like a real match, so a name could
   * pair with ANY heard word for free. Wherever the book has a token the reader did not voice ("&", an initial, a
   * day number) beside a name, the aligner tied: the name took the neighbouring heard word, and the heard copy of the
   * name was inserted beside it. That gave "Harper Harper Row", "Peter Peter Drucker", "let Vin Vin defeat", "on
   * December December 1918" (training-pc-1, about 1,060 cues). Cheaper than a substitution, so the name still wins
   * over the reader's word; dearer than a real match, so a real match always wins over it.
   */
  // A typo is never a trusted rare word or name either: "al1one" is lower-case, six characters and used once, so the
  // book's rare-word set held it and kept it against the heard "alone" (HoA, a83d8cd7).
  const kept = (b: Tok, h: Tok): boolean => b.date === undefined && h.date === undefined && !typo(b) && (
    (names !== undefined && names.has(b.k) && /^[A-Z]/.test(b.core) && !/^\d/.test(h.k))
    || (rare !== undefined && rare.has(b.k) && /^\p{L}/u.test(h.core)));
  // A compound is the same word when it joins EXACTLY ("steel"+"jacketed"), or by a near-miss only when every part
  // is a real word (>= 3 letters): "with"+"a" is one letter off "with", and "as"+"wayne" two off "wayne".
  // A number part joins SPELLED: the reader's "14th century" is the book's "fourteenth-century" (cd, 2026-09-28).
  const joins = (parts: string[], whole: string): boolean => parts.join('') === whole
    || parts.map((x) => spelledKey(x) ?? x).join('') === whole
    || (parts.every((x) => x.length >= 3) && Math.abs(parts.join('').length - whole.length) <= 1
        && isNearMiss(parts.join(''), whole));   // and near in LENGTH: "wayne"+"stepped" is 5 edits off "stepped" but a whole word longer;
        // <= 1, not 2 (2026-09-27): "the"+"back" joined ("theback") passed as a near-miss of "table" and the whole
        // alignment took that free shortcut - "Check table 21" corrected to "Check Check of the book".
  const INF = 1e9;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const back: Op[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill('match'));
  const backN: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      const c = cost[i][j]; if (c >= INF) continue;
      const relax = (a: number, b: number, v: number, op: Op): void => { if (v < cost[a][b]) { cost[a][b] = v; back[a][b] = op; } };
      if (i < n && j < m) {
        // An IDENTICAL word earns a hair off, which only ever breaks a tie: "This book" / "This audiobook" could pair
        // "This" with "This", or insert the heard "This" and join the book's two words loosely - equal costs, and the
        // second printed "This This book".
        if (B[i].k === H[j].k) relax(i + 1, j + 1, c - EXACT_BONUS, 'match');
        else if (sameTok(B[i], H[j])) relax(i + 1, j + 1, c, 'match');
        else if (kept(B[i], H[j])) relax(i + 1, j + 1, c + KEPT_COST, 'match');
        else relax(i + 1, j + 1, c + 1, 'sub');
      }
      if (i < n && j + 1 < m && joins([H[j].k, H[j + 1].k], B[i].k)) relax(i + 1, j + 2, c, 'split2');   // book one = heard two
      // book one = heard 3..6, EXACT only ("two-and-a-half-inch" / "two and a half inch")
      if (i < n && B[i].k.length >= 6) {
        let acc = H[j] ? H[j].k : '';
        for (let t = 2; t <= 6 && j + t <= m; t++) {
          acc += H[j + t - 1].k;
          if (acc.length > B[i].k.length) break;
          if (t >= 3 && acc === B[i].k && c < cost[i + 1][j + t]) { cost[i + 1][j + t] = c; back[i + 1][j + t] = 'splitN'; backN[i + 1][j + t] = t; }
        }
      }
      if (i + 1 < n && j < m && joins([B[i].k, B[i + 1].k], H[j].k)) relax(i + 2, j + 1, c, 'join2');    // book two = heard one
      if (i < n) relax(i + 1, j, c + 1, 'del');
      if (j < m) relax(i, j + 1, c + 1, 'ins');
    }
  }
  const path: Path = [];
  let i = n; let j = m;
  while (i > 0 || j > 0) {
    const op = back[i][j]; const nn = backN[i][j];
    const held = op === 'match' && !(B[i - 1].k === H[j - 1].k || sameTok(B[i - 1], H[j - 1]));
    path.push(op === 'splitN' ? { op, i, j, n: nn } : held ? { op, i, j, held } : { op, i, j });
    if (op === 'match' || op === 'sub') { i--; j--; } else if (op === 'split2') { i--; j -= 2; } else if (op === 'splitN') { i--; j -= nn; }
    else if (op === 'join2') { i -= 2; j--; }
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
  const anyHeard = path.some((q) => q.op === 'match' || q.op === 'sub' || q.op === 'split2' || q.op === 'splitN' || q.op === 'join2');
  for (const run of [edgeRun(0, 1), edgeRun(path.length - 1, -1)]) {
    if (anyHeard && run.length > 0 && run.length <= MAX_EDGE_DELETE) for (const k of run) path[k] = { ...path[k], op: 'keep' };
  }
  return path;
}

/**
 * The key of a word, and of each of its parts: its hyphen or space parts ("Reich-Ranicki" -> reichranicki, reich,
 * ranicki) and a contraction's base ("I’ve" -> ive, i).
 */
function partKeys(core: string): Set<string> {
  const keys = new Set<string>([key(core)]);
  for (const part of core.split(/[\s‐-―-]+/)) if (key(part)) keys.add(key(part));
  const base = contractionBase(core); if (base !== null) keys.add(base);
  keys.delete('');
  return keys;
}

/** A contraction's base word's key ("I'd" -> "i", "Jose's" -> "jose"), or null for a word with no apostrophe. */
function contractionBase(core: string): string | null {
  const m = /^(.+?)[’'ʼ]\p{L}{1,3}$/u.exec(core);
  return m === null ? null : key(m[1]) || null;
}

/** Correct `bookText` to the words heard in its span. `heard` is the heard words in order. */
export function correctToHeard(bookText: string, heard: readonly string[], opts: CorrectOptions = {}): Correction {
  const B = mergeNumbers(mergeDates(tokens(bookText).filter((t) => t.k.length > 0)));
  const H = mergeNumbers(mergeDates(heard.map((w) => tokens(w)).flat().filter((t) => t.k.length > 0)));
  const n = B.length;
  if (n === 0) return { text: bookText, changed: false, agreement: 1, edits: [] };
  const path = alignPath(B, H, opts);
  // THE REGION VOTE (see CorrectOptions.secondOpinion): which of Qwen's regions stand
  const regionOf = new Array<number>(path.length).fill(-1);
  const votes: RegionVote[] = [];
  const bookWins = new Set<number>();
  if (opts.secondOpinion) {
    const H2 = mergeNumbers(mergeDates(opts.secondOpinion.map((w) => tokens(w)).flat().filter((t) => t.k.length > 0)));
    const path2 = alignPath(B, H2, opts);
    // h2At[i] = where the second listen stands when book word i is reached (its insertions BEFORE book word i come
    // before h2At[i]); h2At[n] = the end. So H2[h2At[lo] .. h2At[hi]) is what it heard over book words [lo, hi).
    const h2At = new Array<number>(B.length + 1).fill(-1);
    { let bi = 0; let hj = 0;
      const at = (i: number): void => { if (i < B.length && h2At[i] < 0) h2At[i] = hj; };
      for (const q of path2) {
        if (q.op === 'ins') { hj++; continue; }
        at(bi);
        if (q.op === 'match' || q.op === 'sub') { bi++; hj++; }
        else if (q.op === 'keep' || q.op === 'del') bi++;
        else if (q.op === 'split2') { bi++; hj += 2; }
        else if (q.op === 'splitN') { bi++; hj += q.n ?? 3; }
        else if (q.op === 'join2') { at(bi + 1); bi += 2; hj++; }
      }
      h2At[B.length] = H2.length;
      for (let i = B.length - 1; i >= 0; i--) if (h2At[i] < 0) h2At[i] = h2At[i + 1];
    }
    // group Qwen's consecutive edit ops into regions, tracking the book span [b0, b1) and Qwen's heard span
    let bi = 0; let hj = 0; let r = -1; let b0 = 0; let q0 = 0;
    const spans: { b0: number; b1: number; q0: number; q1: number }[] = [];
    for (let k = 0; k < path.length; k++) {
      const op = path[k].op; const edit = op === 'sub' || op === 'ins' || op === 'del';
      if (edit && r < 0) { r = spans.length; b0 = bi; q0 = hj; spans.push({ b0, b1: bi, q0, q1: hj }); }
      if (!edit && r >= 0) { spans[r].b1 = bi; spans[r].q1 = hj; r = -1; }
      if (edit) regionOf[k] = spans.length - 1;
      if (op === 'match' || op === 'sub') { bi++; hj++; } else if (op === 'keep' || op === 'del') bi++;
      else if (op === 'split2') { bi++; hj += 2; } else if (op === 'splitN') { bi++; hj += path[k].n ?? 3; }
      else if (op === 'join2') { bi += 2; hj++; } else hj++;
    }
    if (r >= 0) { spans[r].b1 = bi; spans[r].q1 = hj; }
    spans.forEach((sp, idx) => {
      const qw = H.slice(sp.q0, sp.q1).map((t) => t.k);
      // the second listen over the same book stretch, widened by one book word each side so an insertion region
      // (b0 === b1) still has context; the same widening is applied to the book and Qwen sides
      const lo = Math.max(0, sp.b0 - 1); const hi = Math.min(B.length, sp.b1 + 1);
      const s0 = h2At[lo]; const s1 = h2At[hi];
      const sw = H2.slice(s0, Math.max(s0, s1)).map((t) => t.k);
      const bwx = B.slice(lo, hi).map((t) => t.k);
      const qwx = [...B.slice(lo, sp.b0).map((t) => t.k), ...qw, ...B.slice(sp.b1, hi).map((t) => t.k)];
      const simBook = wordSim(sw, bwx); const simQwen = wordSim(sw, qwx);
      const decision: 'qwen' | 'book' = simQwen >= simBook ? 'qwen' : 'book';
      if (decision === 'book') bookWins.add(idx);
      votes.push({ book: B.slice(sp.b0, sp.b1).map((t) => t.surface).join(' '), qwen: H.slice(sp.q0, sp.q1).map((t) => t.core).join(' '),
        second: H2.slice(s0, Math.max(s0, s1)).map((t) => t.core).join(' '),
        simBook: +simBook.toFixed(3), simQwen: +simQwen.toFixed(3), margin: +(simQwen - simBook).toFixed(3), decision });
    });
  }
  const vetoed = (k: number): boolean => regionOf[k] >= 0 && bookWins.has(regionOf[k]);
  // A KEPT NAME IS NOT AGREEMENT (2026-09-29): a name held against a different heard word says nothing about whether
  // the reader read this sentence - counted, it lifted a cue placed on another sentence's audio (tp cue 8153: shared
  // "November 1938", held "Nazi") over MIN_AGREEMENT, and the two sentences were spliced into one.
  const kept = path.reduce((a, p) => a + (p.op === 'match' && !p.held ? 1 : p.op === 'split2' || p.op === 'splitN' ? 1 : p.op === 'join2' ? 2 : 0), 0);
  const agreement = kept / n;
  if (agreement < MIN_AGREEMENT) return { text: bookText, changed: false, agreement, edits: [] };

  const out: string[] = []; const edits: Correction['edits'][number][] = [];
  /** Per emitted word: did it come from the READER (an insert or a replace), its keys, and its edit's index. */
  /** `inner`: this word ends in a dash that joined its BOOK token to the next one ("army—" before "three"). */
  const meta: { heard: boolean; full: string; keys: Set<string>; base: string | null; edit: number; inner: boolean }[] = [];
  const put = (text: string, heard: boolean, src: string, glued = false, inner = false): void => {
    out.push((glued ? GLUE : '') + text);
    meta.push({ heard, full: key(src), keys: partKeys(src), base: contractionBase(src), edit: heard ? edits.length - 1 : -1, inner });
  };
  const innerAt = (i: number): boolean => B[i + 1]?.glued === true;
  let bi = 0; let hj = 0;
  for (let k = 0; k < path.length; k++) {
    const p = path[k];
    if (p.op === 'match' && abbreviates(B[bi], H[hj])) {
      // THE SPOKEN WORD, NO PERIOD (Owen, spot check 2: "Matt." should read "Matthew"; "Lieutenant Robin Huard - its a
      // title. theres no period there"). The book's case, the reader's word, the book's other trailing punctuation.
      const b = B[bi]; const h = H[hj];
      const word = /^[A-Z]/.test(b.core) ? h.core[0].toUpperCase() + h.core.slice(1) : h.core;
      edits.push({ op: 'replace', book: b.surface, heard: h.core }); put(b.lead + word + b.trail.replace(/^\./, ''), false, b.core, b.glued); bi++; hj++;
    }
    else if (p.op === 'match' && B[bi].date !== undefined && H[hj].date !== undefined && B[bi].date !== H[hj].date) {
      // THE SAME DATE, SAID THE OTHER WAY ROUND: the cue follows the reader ("1 December 1933" read as "December first
      // nineteen thirty-three"), since a transcript whose order is not the audio's is not the audio's transcript.
      edits.push({ op: 'replace', book: B[bi].surface, heard: H[hj].core }); put(readerDate(B[bi], H[hj]), false, B[bi].core, B[bi].glued); bi++; hj++;
    }
    else if (p.op === 'match' && B[bi].k !== H[hj].k && /^\d/.test(B[bi].k) && /^\p{L}/u.test(H[hj].core)
      && sameValue(B[bi], H[hj])) {
      // PAIRED BY VALUE, WRITTEN AS SAID: the reader's spoken number in the book's punctuation ("Engine one").
      const b = B[bi]; const h = H[hj];
      edits.push({ op: 'replace', book: b.surface, heard: h.core });
      put(b.lead + h.core + b.trail, false, b.core, b.glued, innerAt(bi)); bi++; hj++;
    }
    else if (p.op === 'match' && B[bi].core === '&') {
      // THE BOOK'S "&", READ "and": written as said ("Johnson and Johnson").
      put(H[hj].core, false, 'and', B[bi].glued, innerAt(bi)); bi++; hj++;
    }
    else if (p.op === 'match') { put(B[bi].surface, false, B[bi].core, B[bi].glued, innerAt(bi)); bi++; hj++; }
    else if (p.op === 'keep') { put(B[bi].surface, false, B[bi].core, B[bi].glued, innerAt(bi)); bi++; }
    else if (p.op === 'split2') { put(B[bi].surface, false, B[bi].core, B[bi].glued, innerAt(bi)); bi++; hj += 2; }
    else if (p.op === 'splitN') { put(B[bi].surface, false, B[bi].core, B[bi].glued, innerAt(bi)); bi++; hj += p.n ?? 3; }
    else if (p.op === 'join2') { put(B[bi].surface, false, B[bi].core, B[bi].glued, innerAt(bi)); put(B[bi + 1].surface, false, B[bi + 1].core, B[bi + 1].glued, innerAt(bi + 1)); bi += 2; hj++; }
    else if (p.op === 'sub') {
      const b = B[bi]; const h = H[hj];
      if (vetoed(k)) { put(b.surface, false, b.core, b.glued); bi++; hj++; }
      else {
        // The reader's word REPAIRING the book's own word (a typo: "spe1ar" read "spear") is that book word, and keeps
        // its place against a dash ("spear—the weapon"); any other replacement is the reader's (see the writer).
        const repair = typo(b);
        edits.push({ op: 'replace', book: b.surface, heard: h.core });
        put(b.lead + h.core + b.trail, !repair, h.core, repair && b.glued === true, innerAt(bi)); bi++; hj++;
      }
    } else if (p.op === 'ins') {
      if (vetoed(k)) hj++;
      else { edits.push({ op: 'insert', heard: H[hj].core }); put(H[hj].core, true, H[hj].core); hj++; }
    }
    else if (vetoed(k)) { put(B[bi].surface, false, B[bi].core, B[bi].glued, innerAt(bi)); bi++; }
    else {
      const b = B[bi];
      // keep sentence punctuation the dropped word carried (".", "?", "!", closing quote)
      if (b.trail && /[.?!”"]/.test(b.trail) && out.length) out[out.length - 1] = out[out.length - 1].replace(/[^\p{L}\p{N}]*$/u, '') + b.trail;
      edits.push({ op: 'delete', book: b.surface }); bi++;
    }
  }
  /*
   * A HEARD WORD IS NEVER WRITTEN TWICE (2026-09-28). A word taken from the reader (inserted, or replacing a book word)
   * that is the same word as the BOOK word right beside it - or one part of it ("Reich" beside "Reich-Ranicki") - is
   * the alignment spending one heard word twice: the book's token already says it. So it is dropped, and its edit
   * with it, keeping any sentence punctuation it carried. A book that repeats a word itself ("Mama, Mama") is never
   * touched: only a word the READER supplied can be dropped.
   *
   * The other direction is a CONTRACTION: the reader's "I'd" or "Jose's" beside the book's own "I" / "Jose" is the
   * reader saying that word and the next as one ("I had" -> "I'd"), so the reader's contraction stands and the book
   * word it already contains goes.
   *
   * Neighbours are the nearest words still standing, and the pass repeats until nothing changes: dropping "El" from
   * "Mers El Mers-el-Kébir" is what puts "Mers" beside the book's word.
   */
  const droppedEdits = new Set<number>(); const extraEdits: Correction['edits'][number][] = [];
  const near = (i: number, step: number): number => {
    for (let j = i + step; j >= 0 && j < out.length; j += step) if (out[j] !== '') return j;
    return -1;
  };
  const isBook = (j: number): boolean => j >= 0 && !meta[j].heard;
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < out.length; i++) {
      const m = meta[i]; if (out[i] === '' || !m.heard) continue;
      const L = near(i, -1); const R = near(i, 1);
      if ([L, R].some((j) => isBook(j) && meta[j].keys.has(m.full))) {
        const trail = /[^\p{L}\p{N}]*$/u.exec(out[i])![0];
        if (/[.?!”"]/.test(trail) && L >= 0) out[L] = out[L].replace(/[^\p{L}\p{N}]*$/u, '') + trail;
        out[i] = ''; if (m.edit >= 0) droppedEdits.add(m.edit); again = true; continue;
      }
      if (m.base !== null && isBook(L) && meta[L].full === m.base) {
        const lead = /^[^\p{L}\p{N}]*/u.exec(out[L])![0];
        extraEdits.push({ op: 'delete', book: out[L] });
        out[i] = lead + out[i]; out[L] = ''; again = true;
      }
    }
  }
  const keptEdits = [...edits.filter((_, i) => !droppedEdits.has(i)), ...extraEdits];
  // A glued word goes against the word before it only when that word still ENDS IN THE DASH; after a word the reader
  // inserted or supplied, it gets its space back.
  // And a word the READER put between a dash and its glued word is the dash said aloud ("May–June" read "May to
  // June"), so the dash goes and the word stands.
  //
  // Two more, about the book's joining dash once the reader has changed one side of it. A word glued to the word
  // before it is never glued to a word the READER supplied: the dash joined two book words, and the reader replaced
  // one ("on the seventeenth and–18 May"). And a joining dash whose partner is gone - deleted, or replaced - goes
  // with it ("in 1942– and stayed").
  let text = ''; let last = -1;
  const next = (i: number): string | undefined => out.slice(i + 1).find((x) => x !== '' && x !== GLUE);
  out.forEach((w, i) => {
    if (w === '' || w === GLUE) return;
    const afterReader = last >= 0 && meta[last].heard;
    if (w.startsWith(GLUE) && !afterReader) {
      text += (/[—–]$/.test(text) ? '' : ' ') + w.slice(GLUE.length); last = i; return;
    }
    const word = w.startsWith(GLUE) ? w.slice(GLUE.length) : w;
    if (last >= 0 && meta[last].inner && /[—–]$/.test(text)) text = text.replace(/[—–]$/, '');
    if (meta[i].heard && /[—–]$/.test(text) && next(i)?.startsWith(GLUE)) text = text.replace(/[—–]$/, '');
    text += ' ' + word; last = i;
  });
  text = text.replace(/\s+/g, ' ').trim();
  if (text && /^[a-z]/.test(text) && /^[A-Z]/.test(bookText.trim())) text = text[0].toUpperCase() + text.slice(1);
  return { text, changed: keptEdits.length > 0, agreement, edits: keptEdits,
    ...(opts.secondOpinion ? { regions: votes, disputed: votes.filter((v) => v.decision === 'book') } : {}) };
}
