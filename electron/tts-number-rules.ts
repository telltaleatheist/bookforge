/**
 * tts-number-rules.ts — the shapes a narrator's reading is GUARANTEED, done in
 * code before the model is ever asked.
 *
 * ── The ruling this file exists for ─────────────────────────────────────────
 *
 * Owen, 2026-09-02, after the first live run of the number pass read
 * "Jeremiah 44:17-19" as "four fourteen seventeen…" and narrated the word
 * "hyphen" forty times: *"lets try doing deterministic scripture fixing since we
 * know that shape. have it do the deterministic part before sending it through
 * to the ai, so the ai has less work to do. we can probably do some basic
 * deterministic stuff… just basic deterministic stuff that we can GUARANTEE will
 * be correct on the other side, then send everything else through the ai."*
 *
 * GUARANTEE is the whole admission test. A shape belongs here only when the
 * printed form has exactly one spoken reading and the rule can prove it is
 * looking at that shape. Everything else — a bare four-digit number (year or
 * quantity), a decimal with no unit, a slash reference, a page citation, a roman
 * numeral, digits glued to letters — is LEFT AS PRINTED for the model, which is
 * the pass that exists to weigh context. A rule that is 95% right is not a rule;
 * it is a defect with a schedule.
 *
 * ── Where the readings come from ────────────────────────────────────────────
 *
 * The cardinal and the scripture forms are a port of e2a's
 * `lib/classes/tts_engines/common/orpheus_text.py` (`num_to_words`,
 * `_big_num_words`, `expand_grouped_integers`, `normalize_scripture`), which is
 * itself the training-corpus extractor's transform — so the words the fine-tunes
 * were trained on and the words this pass hands them are one form. Owen,
 * 2026-09-02: *"pull the logic right out of e2a and place it in bookforge… it
 * belongs in bookforge."* e2a is not edited; this is the copy that runs.
 *
 * The style, which the two halves do NOT share and must not be "tidied" into
 * agreement:
 *   - CARDINALS are unhyphenated and carry no "and": 250 is "two hundred fifty",
 *     44 is "forty four", 3,450 is "three thousand four hundred fifty".
 *   - ORDINALS and PAIR-FORM YEARS are hyphenated: "twenty-third", "nineteen
 *     forty-four", "nineteen oh five", "two thousand six". Those come from
 *     number-expansion.ts, which already reads them that way.
 *   - DATES are American in BOTH printed orders: "June 12, 1933" and
 *     "12 June 1933" are each "June twelfth, nineteen thirty-three".
 *   - A verse RANGE is "through", the form the training corpora print.
 *
 * ── What it returns, and why offsets ────────────────────────────────────────
 *
 * Edits, not a rewritten string. The pass downstream has to know exactly which
 * spans code changed so a model edit that overlaps one can be refused and the
 * rest mapped back to the ORIGINAL text; and an edit must sit inside ONE of the
 * target's text nodes or it would flatten an `<em>`. Both are answerable only
 * with offsets, so offsets are what this returns. The applied text comes back
 * too, because the caller needs the exact string the model will be shown.
 *
 * Doctrine, from the pass above it: pure functions only. No fs, no model, no
 * Electron. Every rule is reachable from a test with no GPU.
 */
import type { NarrationTextRewrite } from './epub-processor.js';
import { ordinalToWords, pluralizeLastWord, yearToWords } from './number-expansion.js';

/** Anything with an Arabic digit in it. */
const DIGIT = /[0-9]/;

// ─────────────────────────────────────────────────────────────────────────────
// The cardinal, ported from e2a (orpheus_text.num_to_words / _big_num_words)
// ─────────────────────────────────────────────────────────────────────────────

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/**
 * 0..9999 in the training corpora's own style: cardinal, NO hyphens, no "and".
 *
 * This is deliberately not `integerToWords` from number-expansion.ts, which
 * hyphenates ("twenty-one") because it also serves the OCR-repair pass. The
 * fine-tunes were trained on the unhyphenated form and that is what they read
 * best, so the two live side by side on purpose.
 */
export function cardinalWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  if (n < 20) return ONES[n];
  if (n < 100) {
    const rest = n % 10;
    return rest === 0 ? TENS[Math.floor(n / 10)] : `${TENS[Math.floor(n / 10)]} ${ONES[rest]}`;
  }
  if (n < 1000) {
    const head = `${ONES[Math.floor(n / 100)]} hundred`;
    return n % 100 === 0 ? head : `${head} ${cardinalWords(n % 100)}`;
  }
  const head = `${ONES[Math.floor(n / 1000)]} thousand`;
  return n % 1000 === 0 ? head : `${head} ${cardinalWords(n % 1000)}`;
}

/**
 * The same style, extended past 9999 to the millions — e2a's `_big_num_words`.
 *
 * Beyond a billion a printed number is data rather than prose, and e2a stops
 * there; so does this, and the digits are then left for the model.
 */
export function bigCardinalWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n > 999_999_999) return null;
  if (n < 10000) return cardinalWords(n);
  const parts: string[] = [];
  let rest = n;
  if (rest >= 1_000_000) {
    parts.push(`${cardinalWords(Math.floor(rest / 1_000_000))} million`);
    rest %= 1_000_000;
  }
  if (rest >= 1000) {
    parts.push(`${cardinalWords(Math.floor(rest / 1000))} thousand`);
    rest %= 1000;
  }
  if (rest > 0) parts.push(cardinalWords(rest)!);
  return parts.join(' ');
}

/** The digits after a decimal point, spoken one at a time: ".45" → "four five". */
function fractionDigits(frac: string): string {
  return [...frac].map((d) => ONES[Number(d)]).join(' ');
}

/** "1,250,000" → "one million two hundred fifty thousand"; "2.9" → "two point nine". */
function decimalPhrase(token: string): string | null {
  const bare = token.replace(/,/g, '');
  const dot = bare.indexOf('.');
  if (dot < 0) return bigCardinalWords(Number(bare));
  const whole = bigCardinalWords(Number(bare.slice(0, dot) === '' ? '0' : bare.slice(0, dot)));
  if (whole === null) return null;
  return `${whole} point ${fractionDigits(bare.slice(dot + 1))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The citation guard — shared with the validator, defined once, here
// ─────────────────────────────────────────────────────────────────────────────

/** The abbreviations that make what follows them a page or volume reference. */
const CITATION_LEAD = /(?:^|[\s(\[“"])(?:pp?|vols?|nos?|ibid|cf|fol)\.\s*$/i;

/** A roman-numeral token of two or more characters — "II", "XIV", never "I". */
const ROMAN_TOKEN = /^[IVXLCDM]{2,}$/;

/**
 * Half a phone number, as a whole token: a parenthesized area code — "(405)" —
 * or a hyphenated digit group — "235-5396", "471-1722".
 *
 * Neither half reads on its own, and a span standing next to one is the OTHER
 * half. Measured 2026-09-02 on the scripture book: without this, "(405)
 * 235-5396" narrated as "(four hundred five) 235-5396" — the worst of both
 * readings. Only tested against a NEIGHBOUR, never against the span itself: a
 * hyphenated digit group is also how a year range prints ("1914-1918"), and that
 * one the model reads correctly.
 */
const PHONE_PART = /^(?:\(\d{3}\)|[^\w\s]*\d{1,4}[-‐-―]\d{2,4}[^\w\s]*)$/;

/** Strip the punctuation a word wears at a sentence edge, for word comparison. */
export function bareWord(token: string): string {
  return token.replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, '');
}

/**
 * Is this span citation apparatus — a thing no reading of which is right?
 *
 * Three shapes, kept deliberately narrow because a false positive costs only an
 * unconverted number while a false negative narrates "Document two nine over
 * thirty-four":
 *
 *  1. A SLASH BETWEEN DIGITS, inside the span ("9/34", "298/38") or immediately
 *     against either of its edges (the model sent "34" out of "9/34").
 *  2. A ROMAN-NUMERAL TOKEN of two or more characters directly before or after
 *     the span ("Document II 9/34"). One-character romans are excluded on
 *     purpose: "I" is a pronoun and "C"/"D"/"L"/"M"/"V"/"X" are initials, and
 *     any of them would refuse ordinary prose.
 *  3. A PAGE OR VOLUME ABBREVIATION immediately before the span — p. pp. vol.
 *     vols. no. nos. ibid. cf. fol.
 *  4. HALF A PHONE NUMBER as the token directly before or after it — an area
 *     code in parentheses, or a hyphenated digit group — which makes the span
 *     the other half of it.
 *

 * It lives in this file rather than beside the validator because BOTH halves of
 * the pass owe the same answer: a rule that converted "p. 23" and a model edit
 * that converted "p. 23" are the same defect, and one implementation cannot
 * drift from itself.
 */
export function sitsInCitation(target: string, find: string, at: number): boolean {
  if (/\d\s*\/\s*\d/.test(find)) return true;
  const before = target.slice(0, at);
  const after = target.slice(at + find.length);
  if (/\d\s*$/.test(before) && /^\s*\//.test(after)) return true;
  if (/\/\s*$/.test(before) && /^\s*\d/.test(after)) return true;
  if (/\d$/.test(find) && /^\s*\/\s*\d/.test(after)) return true;
  if (/^\d/.test(find) && /\d\s*\/\s*$/.test(before)) return true;
  if (CITATION_LEAD.test(before)) return true;
  const priorTokens = before.trim().split(/\s+/);
  const nextTokens = after.trim().split(/\s+/);
  const priorToken = priorTokens.length > 0 ? priorTokens[priorTokens.length - 1] : '';
  const nextToken = nextTokens.length > 0 ? nextTokens[0] : '';
  if (PHONE_PART.test(priorToken) || PHONE_PART.test(nextToken)) return true;
  return ROMAN_TOKEN.test(bareWord(priorToken)) || ROMAN_TOKEN.test(bareWord(nextToken));
}

// ─────────────────────────────────────────────────────────────────────────────
// The Bible books
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standard abbreviations for the books of the Bible, and the full names they
 * stand for.
 *
 * SOURCE: the SBL Handbook of Style §8.3.1 general-purpose abbreviation list
 * (the form nearly every English-language religious publisher follows), extended
 * with the four older Anglo-American short forms a book of this kind also
 * prints — "Ex." for Exodus beside SBL's "Exod.", and "Mt./Mk./Lk./Jn." beside
 * SBL's "Matt./Mark/Luke/John" — plus "Jam." for James, which is what the book
 * measured on 2026-09-02 actually printed.
 *
 * The full names are here too, as their own keys, so a reference that already
 * spells the book out is RECOGNIZED (which is what tells a chapter:verse from a
 * clock time) without being rewritten.
 */
const BIBLE_BOOKS: ReadonlyMap<string, string> = new Map(Object.entries({
  // Torah / history
  gen: 'Genesis', genesis: 'Genesis',
  ex: 'Exodus', exod: 'Exodus', exodus: 'Exodus',
  lev: 'Leviticus', leviticus: 'Leviticus',
  num: 'Numbers', numbers: 'Numbers',
  deut: 'Deuteronomy', deuteronomy: 'Deuteronomy',
  josh: 'Joshua', joshua: 'Joshua',
  judg: 'Judges', judges: 'Judges',
  ruth: 'Ruth',
  sam: 'Samuel', samuel: 'Samuel',
  kgs: 'Kings', kings: 'Kings',
  chr: 'Chronicles', chron: 'Chronicles', chronicles: 'Chronicles',
  ezra: 'Ezra',
  neh: 'Nehemiah', nehemiah: 'Nehemiah',
  esth: 'Esther', esther: 'Esther',
  // Wisdom / poetry
  job: 'Job',
  ps: 'Psalm', psalm: 'Psalm', pss: 'Psalms', psalms: 'Psalms',
  prov: 'Proverbs', proverbs: 'Proverbs',
  eccl: 'Ecclesiastes', ecclesiastes: 'Ecclesiastes',
  // Prophets
  isa: 'Isaiah', isaiah: 'Isaiah',
  jer: 'Jeremiah', jeremiah: 'Jeremiah',
  lam: 'Lamentations', lamentations: 'Lamentations',
  ezek: 'Ezekiel', ezekiel: 'Ezekiel',
  dan: 'Daniel', daniel: 'Daniel',
  hos: 'Hosea', hosea: 'Hosea',
  joel: 'Joel', amos: 'Amos',
  obad: 'Obadiah', obadiah: 'Obadiah',
  jonah: 'Jonah',
  mic: 'Micah', micah: 'Micah',
  nah: 'Nahum', nahum: 'Nahum',
  hab: 'Habakkuk', habakkuk: 'Habakkuk',
  zeph: 'Zephaniah', zephaniah: 'Zephaniah',
  hag: 'Haggai', haggai: 'Haggai',
  zech: 'Zechariah', zechariah: 'Zechariah',
  mal: 'Malachi', malachi: 'Malachi',
  // Gospels / Acts
  matt: 'Matthew', mt: 'Matthew', matthew: 'Matthew',
  mk: 'Mark', mark: 'Mark',
  lk: 'Luke', luke: 'Luke',
  jn: 'John', john: 'John',
  acts: 'Acts',
  // Epistles
  rom: 'Romans', romans: 'Romans',
  cor: 'Corinthians', corinthians: 'Corinthians',
  gal: 'Galatians', galatians: 'Galatians',
  eph: 'Ephesians', ephesians: 'Ephesians',
  phil: 'Philippians', philippians: 'Philippians',
  col: 'Colossians', colossians: 'Colossians',
  thess: 'Thessalonians', thessalonians: 'Thessalonians',
  tim: 'Timothy', timothy: 'Timothy',
  tit: 'Titus', titus: 'Titus',
  philem: 'Philemon', philemon: 'Philemon',
  heb: 'Hebrews', hebrews: 'Hebrews',
  jas: 'James', jam: 'James', james: 'James',
  pet: 'Peter', peter: 'Peter',
  jude: 'Jude',
  rev: 'Revelation', revelation: 'Revelation',
}));

/**
 * The books that come in numbered volumes — the only ones a leading 1/2/3 turns
 * into "First"/"Second"/"Third".
 *
 * JOHN IS DELIBERATELY ABSENT. "1 John" is an epistle in a scripture reference
 * and a person everywhere else, so it earns its ordinal only from rule A, where
 * a chapter:verse follows and settles it. The rest are never personal names in
 * the "<digit> <Name>" position.
 */
const NUMBERED_BOOKS: ReadonlySet<string> = new Set([
  'Samuel', 'Kings', 'Chronicles', 'Corinthians', 'Thessalonians', 'Timothy', 'Peter', 'John',
]);

/**
 * The same list WITHOUT John, for the rule that has no chapter:verse to lean on.
 *
 * "1 John 1:9" is settled by the reference that follows it; a bare "1 John" is
 * not, so it stays with the model.
 */
const NUMBERED_BOOKS_BARE = [...NUMBERED_BOOKS].filter((b) => b !== 'John').join('|');

const ORDINAL_PREFIX: Record<string, string> = { 1: 'First', 2: 'Second', 3: 'Third' };

/** The full name a printed book token stands for, or null when it names no book. */
function bibleBook(token: string): string | null {
  return BIBLE_BOOKS.get(token.toLowerCase().replace(/\.$/, '')) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Months
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS: ReadonlyMap<string, string> = new Map(Object.entries({
  jan: 'January', january: 'January',
  feb: 'February', february: 'February',
  mar: 'March', march: 'March',
  apr: 'April', april: 'April',
  may: 'May',
  jun: 'June', june: 'June',
  jul: 'July', july: 'July',
  aug: 'August', august: 'August',
  sep: 'September', sept: 'September', september: 'September',
  oct: 'October', october: 'October',
  nov: 'November', november: 'November',
  dec: 'December', december: 'December',
}));

const MONTH_ALTERNATION =
  'January|February|March|April|May|June|July|August|September|October|November|December'
  + '|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';

function monthName(token: string): string | null {
  return MONTHS.get(token.toLowerCase().replace(/\.$/, '')) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decades — the rest of the ordinal/year readings come from number-expansion.ts
// ─────────────────────────────────────────────────────────────────────────────

/** '70s → "seventies". 20..90 only: '00s and '10s are decade-vs-count ambiguous. */
const APOSTROPHE_DECADES: Record<string, string> = {
  20: 'twenties', 30: 'thirties', 40: 'forties', 50: 'fifties',
  60: 'sixties', 70: 'seventies', 80: 'eighties', 90: 'nineties',
};

// ─────────────────────────────────────────────────────────────────────────────
// What a rule produces
// ─────────────────────────────────────────────────────────────────────────────

/** One span a rule rewrote, at its offset in the ORIGINAL text. */
export interface NumberRuleRewrite extends NarrationTextRewrite {
  /** Which rule read it — the name that goes in the record. */
  rule: string;
}

/** One span a rule could read but was not allowed to touch. */
export interface NumberRuleRefusal {
  find: string;
  replace: string;
  rule: string;
  reason: string;
}

/** Everything the deterministic pass settled about one span of text. */
export interface NumberRuleOutcome {
  /** The accepted spans, sorted by offset, non-overlapping, ORIGINAL offsets. */
  rewrites: NumberRuleRewrite[];
  /** The spans a rule read but could not apply — recorded, never silent. */
  refused: NumberRuleRefusal[];
  /** The text with every accepted rewrite applied. */
  text: string;
  /** The text-node lengths of that text — `segments` shifted by the rewrites. */
  segments: number[];
}

/** A candidate before the overlap and text-node checks have run. */
interface Candidate {
  at: number;
  find: string;
  replace: string;
  rule: string;
}

/** A rule: a name and a scan that proposes candidates over the whole text. */
interface Rule {
  name: string;
  scan(text: string): Candidate[];
}

/** Every match of `re` (which must be global) as [match, ...groups] plus index. */
function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    yield m;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: clock time — decided BEFORE scripture, because the two share a shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `H:MM` followed by a meridiem — "2:00 p.m.", "10:05 am", "7:30 P.M." — or a
 * bare `H:00`.
 *
 * Measured on the Mac's first live run (orpheus-mlx-mac, 2026-09-03): "2:00
 * p.m." had no rule, fell to the model, and came back "two oh two p.m." — a
 * clock read as chapter and verse, well-formed enough that no disposition could
 * refuse it. A meridiem settles the shape outright; and a bare `:00` settles it
 * too, because no chapter has a verse zero, so "6:00" is a clock whatever
 * stands around it.
 *
 * Reading: "two p.m." for the hour, "two thirty p.m." past it, "ten oh five
 * a.m." under ten minutes; the meridiem is KEPT AS PRINTED (it is already
 * spoken as letters). A bare `H:00` reads "six o'clock".
 */
const CLOCK_MERIDIEM = new RegExp(
  '(?<![\\w:.\\-])(1[0-2]|0?[1-9]):([0-5]\\d)\\s*([AaPp])\\.?\\s?([Mm])\\.?(?![A-Za-z\\d])', 'g');
const CLOCK_ON_THE_HOUR = /(?<![\w:.\-])(1[0-2]|0?[1-9]):00(?![\d:])/g;

function clockMinutes(mm: string): string | null {
  const minutes = Number(mm);
  if (minutes === 0) return '';
  if (minutes < 10) return ` oh ${cardinalWords(minutes)}`;
  const words = cardinalWords(minutes);
  return words === null ? null : ` ${words}`;
}

function clockCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(CLOCK_MERIDIEM, text)) {
    const hour = cardinalWords(Number(m[1]));
    const minutes = clockMinutes(m[2]);
    if (hour === null || minutes === null) continue;
    // The meridiem exactly as the book printed it — "p.m.", "PM", "am".
    const meridiem = m[0].slice(m[0].indexOf(m[3]));
    out.push({ at: m.index, find: m[0], replace: `${hour}${minutes} ${meridiem}`, rule: 'clock' });
  }
  for (const m of matches(CLOCK_ON_THE_HOUR, text)) {
    const hour = cardinalWords(Number(m[1]));
    if (hour === null) continue;
    out.push({ at: m.index, find: m[0], replace: `${hour} o'clock`, rule: 'clock' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: scripture
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chapter:verse reference, with everything that legitimately hangs off it.
 *
 * `[<1|2|3> ][Book ]c:v[a][–v2[b]][ff.]`. The book token and the numeric prefix
 * are optional and are only PART of the rewritten span when they have to change
 * — "Jeremiah 44:17-19" rewrites "44:17-19" and leaves the name alone, while
 * "2 Cor. 10:4" rewrites the lot because both the prefix and the abbreviation
 * are read differently than they are printed.
 */
const SCRIPTURE_REF = new RegExp(
  '(?:(?<![\\w:.\\-])([123])\\s+)?'          // 1 an optional volume number
  + '(?:([A-Z][A-Za-z]{1,13})(\\.?)\\s+)?'   // 2 the book token, 3 its period
  + '(?<![\\d:.])(\\d{1,3}):(\\d{1,3})'      // 4 chapter, 5 verse
  + '(?:(?!ff\\.)([a-z])(?![a-z\\d]))?'      // 6 an optional verse letter
  + '(?:\\s*[\\u2010-\\u2015\\u002D]\\s*(\\d{1,3})(?:(?!ff\\.)([a-z])(?![a-z\\d]))?)?'  // 7 v2, 8 letter
  + '(ff\\.)?'                               // 9 "and following"
  + '(?![A-Za-z\\d])',                       // and nothing else glued to it
  'gd');

/**
 * A CLOCK RANGE — "5:30-6:00" — is not a verse range and is left whole.
 *
 * Blocked as a region rather than merely skipped, so the rule cannot come back
 * and convert the "5:30" half on its own and leave "-6:00" printed beside it.
 */
const CLOCK_RANGE = /\d{1,2}:\d{2}\s*[‐-―-]\s*\d{1,2}:\d{2}/g;

/**
 * What may stand between one reference and the next in a LIST of them —
 * "Leviticus 19:31; 20:6", "Genesis 6:11, 13 and 7:1". A joiner (a semicolon, a
 * comma, or the word "and"), then any number of bare verses or verse ranges
 * each followed by a joiner of its own, and nothing else. The bare verses are
 * the integer rule's, and they are still part of the same list.
 */
const REF_LIST_JOIN = new RegExp(
  '^\\s*(?:[;,]\\s*(?:and\\s+)?|and\\s+)'
  + '(?:\\d{1,3}(?:\\s*[\\u2010-\\u2015\\u002D]\\s*\\d{1,3})?\\s*(?:[;,]\\s*(?:and\\s+)?|and\\s+))*$');

function scriptureCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  // Where the last reference that named its book ended — the anchor a bare
  // reference right after it inherits.
  let anchoredEnd = -1;
  for (const m of matches(SCRIPTURE_REF, text)) {
    const [whole, prefix, bookToken, , chapter, verse, verseLetter, verse2, verse2Letter, ff] = m;
    const spans = m.indices!;
    const book = bookToken === undefined ? null : bibleBook(bookToken);
    const end = m.index + whole.length;

    // A BARE chapter:verse — no book named — is scripture OR a clock time. The
    // two readings coincide once the verse reaches ten ("6:59" is "six fifty
    // nine" either way), so only those are converted; "10:05" could be "ten oh
    // five" and is left for the model. A capitalized word that names no book —
    // "Room 3:15", "Chapter 4:2" — counts as no book, and the numbers still
    // read the same way whichever it turns out to be.
    //
    // THE ONE EXCEPTION is a bare reference that CONTINUES a list the book was
    // named at the head of: "Leviticus 19:31; 20:6" is two verses of Leviticus,
    // never a clock time. Measured 2026-09-02 (the n2 acceptance run): left to
    // the model, that "20:6" came back as "twenty" — the verse dropped. The
    // anchor carries down the list only through a list joiner; any other word
    // between them breaks the chain.
    const continuesList = anchoredEnd >= 0 && REF_LIST_JOIN.test(text.slice(anchoredEnd, m.index));
    if (book === null && !continuesList && Number(verse) < 10) continue;
    if (book !== null || continuesList) anchoredEnd = end;

    const chapterWords = cardinalWords(Number(chapter));
    const verseWords = cardinalWords(Number(verse));
    if (chapterWords === null || verseWords === null) continue;

    let spoken = `${chapterWords} ${verseWords}`;
    if (verseLetter !== undefined) spoken += ` ${verseLetter}`;
    if (verse2 !== undefined) {
      const verse2Words = cardinalWords(Number(verse2));
      if (verse2Words === null) continue;
      spoken += ` through ${verse2Words}`;
      if (verse2Letter !== undefined) spoken += ` ${verse2Letter}`;
    }
    // "ff." is READ, not dropped. e2a's port swallows it, but this pass refuses
    // a MODEL edit that loses a word of the book, and it must not do by rule
    // what it refuses by hand — "and following" is the standard reading of it.
    if (ff !== undefined) spoken += ' and following';

    // Which of the leading words this rewrite has to swallow, and therefore
    // where the span starts. Nothing that reads as printed is dragged in.
    const expandsBook = book !== null && bookToken !== undefined
      && bookToken.toLowerCase() !== book.toLowerCase();
    const expandsPrefix = prefix !== undefined && book !== null && NUMBERED_BOOKS.has(book);

    if (expandsPrefix) {
      const at = spans[1]![0];
      out.push({
        at, find: text.slice(at, end),
        replace: `${ORDINAL_PREFIX[prefix!]} ${book} ${spoken}`, rule: 'scripture',
      });
    } else if (expandsBook) {
      const at = spans[2]![0];
      out.push({ at, find: text.slice(at, end), replace: `${book} ${spoken}`, rule: 'scripture' });
    } else {
      const at = spans[4]![0];
      out.push({ at, find: text.slice(at, end), replace: spoken, rule: 'scripture' });
    }
  }
  return out;
}

/**
 * A numbered book with NO chapter:verse — "2 Corinthians" → "Second
 * Corinthians".
 *
 * e2a's port required a chapter:verse before it would touch a leading digit,
 * because it had no book table and "Chapter 3 The Journey" would otherwise have
 * become "Third The Journey". This one has the table, which is the direct
 * evidence e2a was using the chapter:verse as a proxy for, so the guarantee
 * holds without it.
 */
const BARE_NUMBERED_BOOK = new RegExp(
  `(?<![\\w:.\\-])([123])\\s+(${NUMBERED_BOOKS_BARE})\\b`, 'g');

function numberedBookCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(BARE_NUMBERED_BOOK, text)) {
    out.push({
      at: m.index,
      find: m[0],
      replace: `${ORDINAL_PREFIX[m[1]]} ${m[2]}`,
      rule: 'scripture',
    });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: date
// ─────────────────────────────────────────────────────────────────────────────

/** "12 June 1933" / "12th June 1933" — the printed order the reading inverts. */
const DATE_DAY_FIRST = new RegExp(
  `(?<![\\w:.\\-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})(\\.?)`
  + ',?\\s+(1[1-9]\\d{2}|20\\d{2})(?![\\w\\-])', 'g');

/** "June 12, 1933", "June 12th", "Dec. 19, 1991" — and "December 19" alone. */
const DATE_MONTH_FIRST = new RegExp(
  `(?<![\\w\\-])(${MONTH_ALTERNATION})(\\.?)\\s+(\\d{1,2})(?:st|nd|rd|th)?`
  + '(?:,?\\s+(1[1-9]\\d{2}|20\\d{2}))?(?![\\w\\-:])', 'g');

function dateWords(month: string, day: number, year: string | undefined): string | null {
  if (day < 1 || day > 31) return null;
  const dayWords = ordinalToWords(day);
  if (dayWords === null) return null;
  if (year === undefined) return `${month} ${dayWords}`;
  return `${month} ${dayWords}, ${yearToWords(Number(year))}`;
}

function dateCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(DATE_DAY_FIRST, text)) {
    const month = monthName(m[2]);
    if (month === null) continue;
    const spoken = dateWords(month, Number(m[1]), m[4]);
    if (spoken === null) continue;
    out.push({ at: m.index, find: m[0], replace: spoken, rule: 'date' });
  }
  for (const m of matches(DATE_MONTH_FIRST, text)) {
    const month = monthName(m[1]);
    if (month === null) continue;
    const spoken = dateWords(month, Number(m[3]), m[4]);
    if (spoken === null) continue;
    out.push({ at: m.index, find: m[0], replace: spoken, rule: 'date' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: money
// ─────────────────────────────────────────────────────────────────────────────

const CURRENCY: Record<string, { one: string; many: string; sub: string }> = {
  $: { one: 'dollar', many: 'dollars', sub: 'cents' },
  '£': { one: 'pound', many: 'pounds', sub: 'pence' },
  '€': { one: 'euro', many: 'euros', sub: 'cents' },
};

const MONEY = /([$£€])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s*(hundred|thousand|million|billion|trillion))?/gi;

/** "50¢" — a bare sub-unit, which only ever reads as cents. */
const CENTS = /(?<![\w.\-])(\d{1,3})\s?¢/g;

function moneyCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(MONEY, text)) {
    const unit = CURRENCY[m[1]];
    const whole = Number(m[2].replace(/,/g, ''));
    const wholeWords = bigCardinalWords(whole);
    if (wholeWords === null) continue;
    const frac = m[3];
    const scale = m[4]?.toLowerCase();

    let replace: string;
    if (scale !== undefined) {
      // A scale word takes the decimal with it: "$1.5 million" is "one point
      // five million dollars". (number-expansion.ts drops the .5 here — a
      // measured defect of the OCR-pass expander this rule deliberately fixes.)
      const amount = frac === undefined ? wholeWords : `${wholeWords} point ${fractionDigits(frac)}`;
      replace = `${amount} ${scale} ${unit.many}`;
    } else if (frac === undefined) {
      replace = `${wholeWords} ${whole === 1 ? unit.one : unit.many}`;
    } else if (frac.length <= 2) {
      const sub = Number(frac.padEnd(2, '0'));
      if (sub === 0) {
        replace = `${wholeWords} ${whole === 1 ? unit.one : unit.many}`;
      } else if (whole === 0) {
        replace = `${cardinalWords(sub)} ${unit.sub}`;
      } else {
        replace = `${wholeWords} ${whole === 1 ? unit.one : unit.many} and `
          + `${cardinalWords(sub)} ${unit.sub}`;
      }
    } else {
      continue;  // "$1.4142" is not money this rule can be sure of
    }
    out.push({ at: m.index, find: m[0], replace, rule: 'money' });
  }
  for (const m of matches(CENTS, text)) {
    const words = cardinalWords(Number(m[1]));
    if (words === null) continue;
    out.push({ at: m.index, find: m[0], replace: `${words} cents`, rule: 'money' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: percent
// ─────────────────────────────────────────────────────────────────────────────

const PERCENT = /(?<![\w.\-])(\d{1,3}(?:,\d{3})*(?:\.\d+)?)\s*(%|per cent|percent)/g;

function percentCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(PERCENT, text)) {
    const words = decimalPhrase(m[1]);
    if (words === null) continue;
    // The book's own word survives — "per cent" is not silently Americanized.
    const unit = m[2] === '%' ? 'percent' : m[2];
    out.push({ at: m.index, find: m[0], replace: `${words} ${unit}`, rule: 'percent' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: decade
// ─────────────────────────────────────────────────────────────────────────────

const FULL_DECADE = /(?<![\w.\-])(1[1-9]\d0|20\d0)s\b/g;
const APOSTROPHE_DECADE = /['‘’](\d0)s\b/g;

function decadeCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(FULL_DECADE, text)) {
    out.push({
      at: m.index, find: m[0],
      replace: pluralizeLastWord(yearToWords(Number(m[1]))), rule: 'decade',
    });
  }
  for (const m of matches(APOSTROPHE_DECADE, text)) {
    const words = APOSTROPHE_DECADES[m[1]];
    if (words === undefined) continue;
    out.push({ at: m.index, find: m[0], replace: words, rule: 'decade' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: ordinal, and the numbered marker
// ─────────────────────────────────────────────────────────────────────────────

const ORDINAL = /(?<![\w.\-])(\d{1,4})(?:st|nd|rd|th)\b/g;
const NUMBER_MARKER = /#\s?(\d{1,4})(?![\w\-])/g;

function ordinalCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(ORDINAL, text)) {
    const words = ordinalToWords(Number(m[1]));
    if (words === null) continue;
    out.push({ at: m.index, find: m[0], replace: words, rule: 'ordinal' });
  }
  return out;
}

function markerCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(NUMBER_MARKER, text)) {
    const words = cardinalWords(Number(m[1]));
    if (words === null) continue;
    out.push({ at: m.index, find: m[0], replace: `number ${words}`, rule: 'marker' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: comma-grouped integer, and the standalone integer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The punctuation a bare number may wear and still be a bare number.
 *
 * Deliberately NARROWER than e2a's `[^\w\s]*`, which takes any punctuation at
 * all: a leading "$" or "#" makes it money or a marker (rules of their own), and
 * a trailing ":" makes it a chapter, a clock time or a label ("Chapter 3: The
 * Long Year" is not "Chapter three"). Those are the adjacencies Owen's list
 * names, enforced by the token shape rather than by a post-hoc filter.
 */
const OPENERS = '[(\\["\'‘“¡¿]*';
const CLOSERS = '[)\\]"\'’”.,;!?]*';

const GROUPED_INT = new RegExp(
  `(?<!\\S)(${OPENERS})(\\d{1,3}(?:,\\d{3})+)(${CLOSERS})(?!\\S)`, 'g');

/**
 * A bare 1-3 digit integer, whitespace-delimited modulo that punctuation.
 *
 * ONE TO THREE DIGITS, not e2a's one to four: a four-digit number is the
 * year-or-quantity ambiguity ("1200 people" is twelve hundred, 1200 alone is a
 * year) and that judgement is the model's whole job. Leading zeros are left
 * alone too — "001" is a code, and its cardinal ("one") would be a lie.
 */
const BARE_INT = new RegExp(`(?<!\\S)(${OPENERS})(\\d{1,3})(${CLOSERS})(?!\\S)`, 'g');

function groupedIntCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(GROUPED_INT, text)) {
    const words = bigCardinalWords(Number(m[2].replace(/,/g, '')));
    if (words === null) continue;
    if (sitsInCitation(text, m[0], m.index)) continue;
    out.push({ at: m.index, find: m[0], replace: `${m[1]}${words}${m[3]}`, rule: 'grouped' });
  }
  return out;
}

function bareIntCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(BARE_INT, text)) {
    const digits = m[2];
    if (digits.length > 1 && digits.startsWith('0')) continue;
    const words = cardinalWords(Number(digits));
    if (words === null) continue;
    if (sitsInCitation(text, m[0], m.index)) continue;
    out.push({ at: m.index, find: m[0], replace: `${m[1]}${words}${m[3]}`, rule: 'integer' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The rules, in the order that settles every overlap between them
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Priority, not sequence: every rule reads the ORIGINAL text, and where two want
 * the same characters the EARLIER one wins. Scripture before dates before money
 * before the generic integer, because a rule that knows more about a shape is
 * the one that should read it — "December 19, 1991" is a date, not three bare
 * numbers, and "$5,000" is money, not a comma-grouped integer.
 */
const RULES: readonly Rule[] = [
  // A clock with a meridiem, or on the hour, is settled before scripture can
  // read "2:00 p.m." as a chapter and a verse (the Mac's live finding).
  { name: 'clock', scan: clockCandidates },
  { name: 'scripture', scan: (t) => [...scriptureCandidates(t), ...numberedBookCandidates(t)] },
  { name: 'date', scan: dateCandidates },
  { name: 'money', scan: moneyCandidates },
  { name: 'percent', scan: percentCandidates },
  { name: 'decade', scan: decadeCandidates },
  { name: 'ordinal', scan: ordinalCandidates },
  { name: 'marker', scan: markerCandidates },
  { name: 'grouped', scan: groupedIntCandidates },
  { name: 'integer', scan: bareIntCandidates },
];

/**
 * Read every GUARANTEED shape in one span of text, and say exactly what changed.
 *
 * `segments` is the length of each of the text's nodes — one entry for a plain
 * paragraph, one per text node for an element carrying an `<em>` or a `<sup>`.
 * A rewrite that would have to cross a boundary is REFUSED rather than applied,
 * for the reason the model's edits are: reaching across the boundary means
 * flattening the element to get at the number.
 *
 * A refused span is also closed to every later rule. A rule that could not have
 * the whole of "$5.50" must not be followed by one that takes the "50".
 */
export function applyNumberRules(
  text: string,
  segments: readonly number[],
): NumberRuleOutcome {
  const starts: number[] = [];
  let running = 0;
  for (const length of segments) { starts.push(running); running += length; }
  if (running !== text.length) {
    throw new Error(
      `The number rules were handed segments summing to ${running} for a ${text.length}-character `
      + 'text. Those describe two different strings; nothing was rewritten.');
  }
  const withinOneNode = (at: number, end: number): boolean =>
    starts.some((start, i) => at >= start && end <= start + segments[i]);

  const rewrites: NumberRuleRewrite[] = [];
  const refused: NumberRuleRefusal[] = [];
  // Spans no later rule may touch: everything taken, everything refused, and the
  // clock ranges that are not verse ranges.
  const closed: Array<{ at: number; end: number }> = [];
  for (const m of matches(CLOCK_RANGE, text)) {
    closed.push({ at: m.index, end: m.index + m[0].length });
  }
  const isClosed = (at: number, end: number): boolean =>
    closed.some((c) => at < c.end && c.at < end);

  for (const rule of RULES) {
    // Left to right, so two candidates of the SAME rule settle by position.
    for (const candidate of rule.scan(text).sort((a, b) => a.at - b.at)) {
      const end = candidate.at + candidate.find.length;
      if (text.slice(candidate.at, end) !== candidate.find) {
        throw new Error(
          `The ${candidate.rule} rule proposed "${candidate.find}" at ${candidate.at}, where the `
          + `text reads "${text.slice(candidate.at, end)}". Nothing was rewritten.`);
      }
      if (isClosed(candidate.at, end)) continue;
      if (!withinOneNode(candidate.at, end)) {
        refused.push({
          find: candidate.find, replace: candidate.replace, rule: candidate.rule,
          reason: 'the span crosses a text-node boundary',
        });
        closed.push({ at: candidate.at, end });
        continue;
      }
      rewrites.push({ at: candidate.at, find: candidate.find, replace: candidate.replace, rule: candidate.rule });
      closed.push({ at: candidate.at, end });
    }
  }

  rewrites.sort((a, b) => a.at - b.at);

  // The text, and the text-node lengths of it, from the SAME list of rewrites.
  const grown = [...segments];
  let out = '';
  let cursor = 0;
  for (const edit of rewrites) {
    out += text.slice(cursor, edit.at) + edit.replace;
    cursor = edit.at + edit.find.length;
    const node = starts.findIndex((start, i) => edit.at >= start && edit.at < start + segments[i]);
    if (node < 0) {
      throw new Error(
        `The number rules rewrote "${edit.find}" at ${edit.at}, which sits in no text node. `
        + 'Nothing was written.');
    }
    grown[node] += edit.replace.length - edit.find.length;
  }
  out += text.slice(cursor);

  return { rewrites, refused, text: out, segments: grown };
}

/** Does this text still hold a digit the model has to be asked about? */
export function stillHasDigits(text: string): boolean {
  return DIGIT.test(text);
}
