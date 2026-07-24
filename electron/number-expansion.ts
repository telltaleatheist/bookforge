/**
 * number-expansion.ts — deterministic English number-to-words expansion for the
 * TTS-prep pass (pass 2 of AI cleanup). This is a hand-rolled TypeScript port of
 * the rule set in electron/scripts/orpheus_stream.py `normalize_for_tts`, extended
 * with thousands separators, year/decade reading and ordinals. It exists so the
 * cleaned EPUB carries speakable number words instead of digit glyphs the TTS
 * engine would mispronounce.
 *
 * Doctrine (mirrors ai-cleanup-prepass.ts): pure functions only — NO model calls,
 * NO fs, NO Electron. Every transform is a plain string→string rewrite so this
 * module is trivially unit-testable via a dist import.
 *
 * NO FALLBACKS: an ambiguous pattern is LEFT UNCHANGED, never guessed. The
 * explicitly out-of-scope shapes below stay as their original digits:
 *   - colon references (5:30, 13:1) — time vs scripture vs ratio is ambiguous
 *   - number ranges (1914-1918)     — the hyphen is a range, not arithmetic
 *   - roman numerals (III)          — carry no arabic digits, untouched anyway
 *   - fractions (1/2)               — the slash makes it a fraction, not two ints
 *   - digits embedded in a word     — COVID-19, R2D2 (letter/hyphen adjacency)
 *   - integers >= one quadrillion   — out of the supported 0..trillions range
 * Each is enforced by an adjacency guard on the bare-integer rule, not a post-hoc
 * filter, so the untouched text is byte-identical to the input.
 */

// ─────────────────────────────────────────────────────────────────────────────
// English integer → words (hand-rolled, 0 .. 999 trillion)
// ─────────────────────────────────────────────────────────────────────────────

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
// Index i names 1000^i. Index 0 (the bare ones group) has no scale word.
const SCALES = ['', 'thousand', 'million', 'billion', 'trillion'];

/** Words for a 0..999 group (no scale word). Hyphenates twenty-one … ninety-nine. */
function threeDigitToWords(n: number): string {
  const parts: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} hundred`);
  if (rest > 0) {
    if (rest < 20) {
      parts.push(ONES[rest]);
    } else {
      const tens = Math.floor(rest / 10);
      const ones = rest % 10;
      parts.push(ones > 0 ? `${TENS[tens]}-${ONES[ones]}` : TENS[tens]);
    }
  }
  return parts.join(' ');
}

/**
 * Convert a non-negative integer (0 .. 999,999,999,999,999) to English words.
 * Returns null when the value is outside the supported range — the caller then
 * leaves the original digits untouched (no-fallback), rather than emitting a wrong
 * or truncated reading.
 */
export function integerToWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0) return null;
  if (n === 0) return 'zero';
  if (n >= 1e15) return null; // beyond trillions — leave the digits as-is

  const groups: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    groups.push(remaining % 1000);
    remaining = Math.floor(remaining / 1000);
  }
  // groups[0] = ones, groups[1] = thousands, … — emit high scale first.
  const out: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === 0) continue;
    const scale = SCALES[i];
    out.push(scale ? `${threeDigitToWords(g)} ${scale}` : threeDigitToWords(g));
  }
  return out.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordinals (7th → seventh, 21st → twenty-first, 103rd → one hundred third)
// ─────────────────────────────────────────────────────────────────────────────

// Irregular ordinal stems for the final cardinal word.
const ONE_ORDINALS: Record<string, string> = {
  zero: 'zeroth', one: 'first', two: 'second', three: 'third', four: 'fourth',
  five: 'fifth', six: 'sixth', seven: 'seventh', eight: 'eighth', nine: 'ninth',
  ten: 'tenth', eleven: 'eleventh', twelve: 'twelfth', thirteen: 'thirteenth',
  fourteen: 'fourteenth', fifteen: 'fifteenth', sixteen: 'sixteenth',
  seventeen: 'seventeenth', eighteen: 'eighteenth', nineteen: 'nineteenth',
};
const TENS_ORDINALS: Record<string, string> = {
  twenty: 'twentieth', thirty: 'thirtieth', forty: 'fortieth', fifty: 'fiftieth',
  sixty: 'sixtieth', seventy: 'seventieth', eighty: 'eightieth', ninety: 'ninetieth',
};
const SCALE_ORDINALS: Record<string, string> = {
  hundred: 'hundredth', thousand: 'thousandth', million: 'millionth',
  billion: 'billionth', trillion: 'trillionth',
};

/** Turn a single cardinal word (possibly hyphenated, e.g. "twenty-one") ordinal. */
function ordinalizeWord(word: string): string {
  if (word.includes('-')) {
    const [head, tail] = word.split('-');
    return `${head}-${ordinalizeWord(tail)}`;
  }
  if (ONE_ORDINALS[word]) return ONE_ORDINALS[word];
  if (TENS_ORDINALS[word]) return TENS_ORDINALS[word];
  if (SCALE_ORDINALS[word]) return SCALE_ORDINALS[word];
  return `${word}th`;
}

/** Cardinal-words → ordinal-words: only the LAST token becomes ordinal. */
function ordinalToWords(n: number): string | null {
  const cardinal = integerToWords(n);
  if (cardinal === null) return null;
  const tokens = cardinal.split(' ');
  tokens[tokens.length - 1] = ordinalizeWord(tokens[tokens.length - 1]);
  return tokens.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Years and decades
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read a plausible year the way a person says it: 1989 → "nineteen eighty-nine",
 * 1905 → "nineteen oh five", 2007 → "two thousand seven", 1900 → "nineteen
 * hundred". Only called for values already matched in the 1100–2099 year window.
 */
function yearToWords(y: number): string {
  if (y >= 2000 && y <= 2009) {
    const lo = y % 100;
    return lo ? `two thousand ${integerToWords(lo)}` : 'two thousand';
  }
  const hi = Math.floor(y / 100);
  const lo = y % 100;
  const hiWords = integerToWords(hi)!;
  if (lo === 0) return `${hiWords} hundred`;
  const loWords = lo >= 10 ? integerToWords(lo)! : `oh ${integerToWords(lo)!}`;
  return `${hiWords} ${loWords}`;
}

/** Pluralize the final word of a spoken year for a decade: "thirty" → "thirties". */
function pluralizeLastWord(words: string): string {
  const tokens = words.split(' ');
  const last = tokens[tokens.length - 1];
  tokens[tokens.length - 1] = last.endsWith('y') ? `${last.slice(0, -1)}ies` : `${last}s`;
  return tokens.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Decimal / thousands-separated cardinal phrase
// ─────────────────────────────────────────────────────────────────────────────

/** "50,000" → fifty thousand; "3.14" → three point one four. null → leave as-is. */
function numberPhrase(token: string): string | null {
  const bare = token.replace(/,/g, '');
  if (bare.includes('.')) {
    const [intPart, frac] = bare.split('.');
    const intWords = integerToWords(intPart === '' ? 0 : parseInt(intPart, 10));
    if (intWords === null) return null;
    const digits = [...frac].map(d => ONES[parseInt(d, 10)]).join(' ');
    return `${intWords} point ${digits}`;
  }
  return integerToWords(parseInt(bare, 10));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface NumberExpansion { from: string; to: string; }

/**
 * Ordered rule sweeps. Each rule replaces only digit-bearing tokens, so whitespace
 * and markup are never touched, and once a token is expanded to words it carries no
 * digits and cannot re-match a later rule (which is what makes the whole function
 * idempotent). A replacement that would equal the matched text (or that a guard
 * declines) leaves the original substring in place.
 */
function runRules(input: string, record: (from: string, to: string) => void): string {
  let s = input;

  const apply = (re: RegExp, fn: (m: string[]) => string | null): void => {
    s = s.replace(re, (...args) => {
      // String.replace passes (match, ...groups, offset, string); the trailing two
      // are offset+full string (and, with named groups, a groups object) — slice
      // them off to leave [match, ...captures].
      let end = args.length;
      if (typeof args[end - 1] === 'object') end -= 1; // named-groups object (unused here)
      const groups = args.slice(0, end - 2) as string[];
      const whole = groups[0];
      const out = fn(groups);
      if (out === null || out === whole) return whole;
      record(whole, out);
      return out;
    });
  };

  // 1. Apostrophe decades: '70s → seventies (straight or curly apostrophe). The
  //    footnote/quote pass normalizes curly → straight before this runs in the
  //    real pipeline, but the standalone function accepts both. 20..90 only;
  //    '00s / '10s are ambiguous decade-vs-count and are left as-is.
  const DECADE_WORDS: Record<string, string> = {
    '20': 'twenties', '30': 'thirties', '40': 'forties', '50': 'fifties',
    '60': 'sixties', '70': 'seventies', '80': 'eighties', '90': 'nineties',
  };
  apply(/['\u2018\u2019](\d0)s\b/g, m => DECADE_WORDS[m[1]] ?? null);

  // 2. Full-year decades: 1930s → nineteen thirties, 2000s → two thousands. Only
  //    plausible years ending in 0, so the year reading + plural is well-defined.
  apply(/(?<![\w.\-])(1[1-9]\d0|20\d0)s\b/g, m => pluralizeLastWord(yearToWords(parseInt(m[1], 10))));

  // 3. Currency: $5.50 → five dollars and fifty cents; $3 million → three million
  //    dollars; $5 → five dollars. Scale word (when present) wins over cents.
  apply(
    /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(hundred|thousand|million|billion|trillion))?/gi,
    m => {
      const whole = parseInt(m[1].replace(/,/g, ''), 10);
      const wholeWords = integerToWords(whole);
      if (wholeWords === null) return null;
      const scale = m[3] ? m[3].toLowerCase() : '';
      if (scale) return `${wholeWords} ${scale} dollars`;
      let out = `${wholeWords} dollar${whole === 1 ? '' : 's'}`;
      if (m[2]) {
        const c = parseInt(m[2].padEnd(2, '0').slice(0, 2), 10);
        if (c) out += ` and ${integerToWords(c)} cent${c === 1 ? '' : 's'}`;
      }
      return out;
    }
  );

  // 4. Percent: 40% → forty percent; 3.5% → three point five percent.
  apply(
    /(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?%/g,
    m => { const p = numberPhrase(m[1]); return p === null ? null : `${p} percent`; }
  );

  // 5. Ordinals: 7th → seventh, 21st → twenty-first, 103rd → one hundred third.
  apply(/(?<![\w.\-])(\d+)(?:st|nd|rd|th)\b/g, m => ordinalToWords(parseInt(m[1], 10)));

  // 6. Years: 1989 → nineteen eighty-nine (1100–2099 only, and not part of a range
  //    or larger token). A trailing '.'/',' is allowed so end-of-sentence years
  //    still read as years; a neighbouring '-' (range) or word char blocks it.
  apply(/(?<![\w.\-])(1[1-9]\d{2}|20\d{2})(?![\w\-])/g, m => yearToWords(parseInt(m[1], 10)));

  // 7. Bare integers / decimals / thousands groups. Guarded so colon refs,
  //    fractions, ranges and word-embedded digits stay untouched (see header).
  apply(/(?<![\w:/.\-,])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?![\w:/\-])/g, m => numberPhrase(m[1]));

  return s;
}

/** Expand English numbers to words, returning the text and each expansion made. */
export function expandNumbersEnDetailed(text: string): { text: string; expansions: NumberExpansion[] } {
  if (!text) return { text, expansions: [] };
  const expansions: NumberExpansion[] = [];
  const out = runRules(text, (from, to) => expansions.push({ from, to }));
  return { text: out, expansions };
}

/** Expand English numbers to words for TTS. Idempotent: expand(expand(x)) === expand(x). */
export function expandNumbersEn(text: string): string {
  return expandNumbersEnDetailed(text).text;
}
