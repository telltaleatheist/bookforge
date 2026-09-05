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

/**
 * The abbreviations that make what follows them an UNSPEAKABLE reference.
 *
 * `p.` AND `pp.` WERE HERE UNTIL 2026-09-04, and Owen's ruling took them out: a
 * page reference is read out loud — "p. 23" is "page twenty three" — so it is a
 * shape with exactly one reading and belongs to the `page` rule below, not to
 * the guard. What is left is the apparatus that has no reading: a volume, a
 * number, "ibid.", "cf.", "fol.".
 */
const CITATION_LEAD = /(?:^|[\s(\[“"])(?:vols?|nos?|ibid|cf|fol)\.\s*$/i;

/** A roman-numeral token of two or more characters — "II", "XIV", never "I". */
const ROMAN_TOKEN = /^[IVXLCDM]{2,}$/;

/**
 * AN ARCHIVE SIGIL: the two-to-four letter code a records citation prints in
 * front of a file number — "HSG 11 Js. Sond. 298/38", "GnH 3659/42", "AfW HH R
 * 231191".
 *
 * Two shapes, and the shape is the whole guarantee: a token that is ENTIRELY
 * uppercase ("HSG", "HH"), or one that carries an uppercase letter somewhere
 * after its first character ("GnH", "AfW"). Ordinary prose has neither — "The",
 * "In", "One" capitalize position 0 and nothing else, so they do not match, and
 * "the 11 men" is still read.
 *
 * Reported by the orpheus-finetune side (BOOKFORGE_HANDOFF.md, "Ask 2") against
 * the very line this app's own prompt already lists as leave-as-printed:
 * `sitsInCitation` knew p./pp./vol./no./ibid./cf./fol., a slash between digits,
 * a roman-numeral neighbour and half a phone number, and did NOT know the sigil,
 * so the bare-integer rule read the "11" out of an archive reference.
 *
 * THE OTHER HALF OF THAT ASK IS DELIBERATELY NOT ADOPTED. The handoff also notes
 * that an abbreviation token AFTER the span ("Js.", "Sond.") marks a citation.
 * It does — and so do "U.S.", "Dr.", "Mr.", "St." and every other abbreviation
 * ordinary prose prints after a number ("the 11 U.S. soldiers"). This guard is
 * shared with the model validator (`CITATION_CODE`), so a false positive here
 * means the digits reach the narrator with nothing downstream able to convert
 * them. The sigil is a shape; "a period on the next word" is not.
 */
const ARCHIVE_SIGIL = /^[A-Za-z]{2,4}$/;

/** Does this token look like the archive sigil in front of a file number? */
function isArchiveSigil(token: string): boolean {
  const word = bareWord(token);
  if (!ARCHIVE_SIGIL.test(word)) return false;
  return word === word.toUpperCase() || /[A-Z]/.test(word.slice(1));
}

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

/**
 * A roman numeral and a period, immediately in front of a number.
 *
 * Lower case as well as upper: a citation prints "iii. 1281-2" far more often
 * than "III. 1281-2", and `ROMAN_TOKEN` is upper-case only because it exists to
 * recognise "Document II" without refusing the pronoun "I".
 *
 * THE NUMERAL GRAMMAR IS STRICT — thousands, then hundreds, then tens, then
 * units — because a loose [ivxlcdm]+ also spells ordinary English. "he did. 45
 * men", "it was mild. 12 degrees" and "the civil. 90 percent" all matched the
 * loose form and would have had their numbers refused as apparatus.
 */
const ROMAN_CITATION_LEAD =
  /(?:^|[\s(\[])(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})\.\s*(?=\d)/i;

/**
 * The words that make the numbers after them PAGES.
 *
 * Roman numerals are deliberately absent: `ROMAN_CITATION_LEAD` already claims
 * "iii. 1281-2", and putting [ivxlcdm] in a lead list would also claim the
 * ordinary words made only of those letters — "mild", "civil", "did".
 */
const PAGE_RANGE_LEAD = /(?:\bpp?|\bpages?|\bnos?|\bfols?|\bff|\blines?|\bll)\.?\s*$/i;

/**
 * An abbreviated page range BEHIND A PAGE LEAD: "pp. 51-2", "fol. 128-9".
 *
 * The second number is shorter than the first because it drops the shared
 * leading digits, so "51-2" is pages fifty-one to fifty-two, not fifty-one to
 * two — and the LIVE model run of 2026-09-04 made exactly that misread on
 * "iii. 1281-2".
 *
 * THE PAGE LEAD IS REQUIRED, and that is a narrowing of Owen's ruling made
 * because the wider form contradicts the shipped number prompt, which teaches
 * '"112–14" is "one hundred twelve to one hundred fourteen"' — the keeper
 * `test-prompt-examples` refused the wider form on exactly that line. A bare
 * prose range keeps the prompt's reading, which is the correct one; an
 * apparatus range is left as printed. A YEAR range abbreviates identically
 * ("1935-36") and reads differently again, so a first number that could be a
 * year is never claimed here — that judgement is the model's, and the live run
 * measured it making it correctly.
 */
function isAbbreviatedPageRange(target: string, find: string, at: number): boolean {
  const before = target.slice(0, at);
  for (const m of find.matchAll(/(\d{2,})\s*[\u2010-\u2015\u002D]\s*(\d+)/g)) {
    const first = m[1]!;
    const second = m[2]!;
    const value = Number(first);
    if (value >= 1100 && value <= 2099) continue;  // a year range is the model's
    if (second.length >= first.length) continue;
    if (!PAGE_RANGE_LEAD.test(before + find.slice(0, m.index))) continue;
    return true;
  }
  return false;
}

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
 *  5. AN ARCHIVE SIGIL immediately before a bare integer — "HSG 11" — see
 *     `isArchiveSigil`.
 *  6. A ROMAN NUMERAL AND A PERIOD in front of a number — "iii. 1281-2" — a
 *     volume or a part, and the number after it a page.
 *  7. AN ABBREVIATED PAGE RANGE BEHIND A PAGE LEAD — "pp. 51-2" — where the
 *     second number is shorter than the first. A bare prose range keeps the
 *     number prompt's reading, and a year range is left to the model.
 *

 * It lives in this file rather than beside the validator because BOTH halves of
 * the pass owe the same answer: a rule that converted "p. 23" and a model edit
 * that converted "p. 23" are the same defect, and one implementation cannot
 * drift from itself.
 */
export function sitsInCitation(target: string, find: string, at: number): boolean {
  if (/\d\s*\/\s*\d/.test(find)) return true;
  // 6. A ROMAN NUMERAL AND A PERIOD immediately before a number — "iii. 1281-2",
  //    "II. 45". That is a volume or a part and the number after it is a page,
  //    and the LIVE model run of 2026-09-04 read one as a quantity: "iii. 1281-2"
  //    shipped as "iii. one thousand two hundred eighty-one to two". Checked
  //    INSIDE the span as well as before it, because the model sends the lead
  //    and the number together.
  if (ROMAN_CITATION_LEAD.test(find)) return true;
  if (ROMAN_CITATION_LEAD.test(target.slice(0, at) + find.slice(0, 1))) return true;
  // 7. AN ABBREVIATED PAGE RANGE BEHIND A PAGE LEAD — "pp. 51-2", "fol. 128-9":
  //    the second number is shorter than the first because it drops the shared
  //    leading digits, which is the page-range convention.
  if (isAbbreviatedPageRange(target, find, at)) return true;
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
  // 5. AN ARCHIVE SIGIL immediately before a BARE INTEGER — "HSG 11", "GnH 3659".
  //    The bare-integer condition is what keeps this off a date or a scripture
  //    reference standing after an acronym; a sigil in front of a whole phrase
  //    says nothing about that phrase.
  if (/^\d+$/.test(bareWord(find)) && isArchiveSigil(priorToken)) return true;
  return ROMAN_TOKEN.test(bareWord(priorToken)) || ROMAN_TOKEN.test(bareWord(nextToken));
}

// ─────────────────────────────────────────────────────────────────────────────
// Recognizing a scripture reference — DETECTION ONLY, never a reading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE RULING THIS SECTION EXISTS FOR, and what it replaced.
 *
 * Owen, 2026-09-05, after a Higgs A/B render of the deathstalker book narrated
 * "(1 Pet. 3:7)" as *"one pet three seven"*: **"I don't want to do it
 * deterministically. An AI takes over. There are a billion ways Bible verses are
 * abbreviated."**
 *
 * Until n6 this file carried a table of ABBREVIATIONS and READ the reference
 * itself — "2 Cor. 10:4" → "Second Corinthians ten four". An abbreviation table
 * is the wrong instrument for an open set: "Pet.", "1 Pt.", "I Pet." and a
 * hundred house styles are one book, and a table that is 95% complete does not
 * read the last 5% as printed — it hands them to the generic integer rule, which
 * narrates "one pet three seven". That is the defect Owen heard.
 *
 * So the deterministic layer does the one thing it can GUARANTEE: it recognizes
 * the SHAPE of a reference and PROTECTS it. Nothing rewrites a detected span.
 * The span keeps its digits, which is what routes its block to the model, and
 * the model reads it (`electron/prompts/tts-number-normalize.txt`).
 *
 * ── WHAT COUNTS AS EVIDENCE, and why a false positive is not free ───────────
 *
 * The first cut of this detector fired on ANY capitalized token in front of a
 * `c:v`, on the theory that "a span detected in error is merely sent to the
 * model". THAT WAS MEASURED FALSE (adversarial review, 2026-09-05): inside a
 * detected span the validator demands a pause between chapter and verse, so the
 * model's CORRECT reading of "Widescreen 16:9" → *"sixteen nine"* was refused
 * and the digits reached the narrator — and the book-less rule, which read
 * "Score 21:19" correctly before this branch, no longer got the chance. The
 * deny-list that was supposed to hold the line ("Chapter", "Room", …) is not a
 * closed set and never could be: `Lakers`, `Widescreen`, `Flight`, `Route`,
 * `Docket`, `BWV`, every weekday and a sentence-initial `Then` all fired.
 *
 * So detection now requires EVIDENCE, and there are exactly four kinds — three
 * strong, one weak and paid for below. A reference is detected when the token in
 * front of the `c:v` is:
 *
 *   (a) an ABBREVIATION — it carries its own period: "Pet. 3:7", "Ps. 63:6";
 *   (b) preceded by a VOLUME NUMBER — arabic 1-3, roman I/II/III, or the
 *       ordinal forms: "1 John 3:16", "II Cor. 5:17", "1st John 1:9";
 *   (c) one of the FULL CANONICAL BOOK NAMES below;
 *   (d) TWO OR THREE LETTERS with no period at all: "Ps 23:1", "Jn 3:16",
 *       "Rev 21:4", "Mt 5:3".
 *
 * Everything else keeps exactly the behaviour it had before this branch.
 *
 * ── (d) IS WEAK EVIDENCE, ON PURPOSE, AND IT IS CHEAP BECAUSE OF THE CLAIM TEST
 *
 * A dotless "Ps 23:1" is the same shape as "Map 2:1" and "Bus 47:15", so on its
 * own it proves nothing. It is admitted anyway because the FIRST cut of (a)-(c)
 * left every dotless abbreviation unreadable — the model's "Psalm twenty three,
 * verse one" was refused WORDS_DROPPED, because that relaxation is scoped to
 * detected spans, and the digits reached the narrator. Losing "Ps", "Jn", "Rev"
 * and "Mt" is a regression from this app's own behaviour in exactly the domain
 * the branch exists for.
 *
 * What makes it affordable is the validator's CLAIM TEST, which is the same
 * thing that makes a detected "Sec. 3:7" affordable: the chapter-and-verse pause
 * is asked only of a reading that NAMES a canonical book or an ordinal volume.
 * So "Map 2:1" → "Map two one" and "Bus 47:15" → "Bus forty seven fifteen" are
 * accepted exactly as printed prose, while "Jn 3:16" → "John three, verse
 * sixteen" is accepted as a reference. The model decides which it is looking at,
 * which is the arrangement Owen ruled for.
 *
 * THE COST, stated so it is not a surprise: a 2-3 letter token in front of a
 * c:v is now PROTECTED, so the book-less rule no longer reads it, and its
 * reading depends on the model where before it was deterministic. Measured, the
 * surface is small — a token of exactly two or three letters, no period, with a
 * verse of ten or more ("Bus 47:15"). Four letters and up are deliberately out:
 * "Then", "Score", "Case", "Odds", "Route" and every longer word keep the
 * deterministic reading they have on main.
 *
 * ── THE SAME VETO NOTE AS (c) ───────────────────────────────────────────────
 *
 * (d) is not a table of abbreviations either — it asks the token's LENGTH, not
 * its identity — but it is the loosest of the four, and it is the one to remove
 * first if Owen wants the detector tighter. Deleting it restores (a)-(c) exactly
 * and costs the dotless abbreviations again.
 *
 * ── THE READING OF OWEN'S RULING THAT (c) RESTS ON — HE MAY VETO IT ─────────
 *
 * Owen's objection was to enumerating ABBREVIATIONS ("there are a billion ways
 * Bible verses are abbreviated"), and it is unanswerable: that set is open, and
 * every house style invents another. The set of full canonical book names is
 * neither open nor invented — it is 73 fixed words, closed since the canon was,
 * and it is used here as a SHAPE, never as a reading. If Owen reads his ruling
 * as forbidding this list too, delete `CANONICAL_BOOK_NAMES` and shapes (a) and
 * (b) still stand; the cost is that "Genesis 3:15" and "Revelation 21:4" — a
 * fully spelled book with no volume number — stop being protected.
 *
 * ── WHAT IS NOT DETECTED, stated so it is not mistaken for an oversight ─────
 *
 * A SINGLE-LETTER ABBREVIATION: "S. of S. 2:1". The token pattern needs two
 * letters, because a one-letter abbreviation is also every initial in a name.
 *
 * A LONGER DOTLESS WORD: "Widescreen 16:9", "Score 21:19", "Wednesday 9:45",
 * "Then 9:45". Four letters and up with no period is the shape of every
 * capitalized noun in English, and (d) stops short of it deliberately.
 *
 * The book table itself survives as TEST EVIDENCE for the model —
 * `tools/fixtures/scripture-readings.json`.
 */

/**
 * THE FULL CANONICAL BOOK NAMES — a closed set of 73 words, used as SHAPE.
 *
 * Every book of the Protestant canon and of the deuterocanon, as the LAST word
 * of the name a book prints ("Song of Songs" ends in "Songs", "Wisdom of
 * Solomon" in "Solomon"), because the reference pattern takes the one token
 * standing immediately in front of the numbers. A volume number is not part of
 * a name here: "Samuel", not "1 Samuel".
 *
 * Read twice, and never as a reading: shape (c) of the detector, and — in the
 * model validator — the test of whether a replacement is CLAIMING to be a
 * scripture reading, which is what decides whether the chapter-and-verse pause
 * is required of it ("Psalm sixty three six" is refused; "Section three seven",
 * for a "Sec. 3:7" that was never scripture, is not).
 */
export const CANONICAL_BOOK_NAMES: ReadonlySet<string> = new Set([
  'genesis', 'exodus', 'leviticus', 'numbers', 'deuteronomy', 'joshua', 'judges', 'ruth',
  'samuel', 'kings', 'chronicles', 'ezra', 'nehemiah', 'esther', 'job', 'psalm', 'psalms',
  'proverbs', 'ecclesiastes', 'qoheleth', 'song', 'songs', 'solomon', 'canticles',
  'isaiah', 'jeremiah', 'lamentations', 'ezekiel', 'daniel', 'hosea', 'joel', 'amos',
  'obadiah', 'jonah', 'micah', 'nahum', 'habakkuk', 'zephaniah', 'haggai', 'zechariah',
  'malachi', 'matthew', 'mark', 'luke', 'john', 'acts', 'apostles', 'romans',
  'corinthians', 'galatians', 'ephesians', 'philippians', 'colossians', 'thessalonians',
  'timothy', 'titus', 'philemon', 'hebrews', 'james', 'peter', 'jude', 'revelation',
  'tobit', 'judith', 'wisdom', 'sirach', 'ecclesiasticus', 'baruch', 'maccabees',
  'esdras', 'susanna', 'manasseh', 'dragon',
]);

/**
 * The books that come in numbered volumes, for the shape that has no `c:v`
 * behind it at all — "2 Corinthians".
 *
 * JOHN IS DELIBERATELY ABSENT. "1 John" is an epistle in a reference and a
 * person everywhere else, and with no reference to settle it the pass has no
 * business claiming either — so a bare "1 John" is not protected, and its "1" is
 * read by the integer rule exactly as every other bare digit is.
 */
const NUMBERED_BOOK_NAMES: readonly string[] = [
  'Samuel', 'Kings', 'Chronicles', 'Corinthians', 'Thessalonians', 'Timothy', 'Peter',
  'Maccabees', 'Esdras',
];

/**
 * A VOLUME NUMBER in front of a book — arabic, roman, or ordinal.
 *
 * Roman numerals are not decoration: "II Cor. 5:17" is ordinary in older
 * Anglo-American religious typography, which is the deathstalker corpus this
 * branch exists for, and with the numeral standing OUTSIDE the span it was
 * narrated as digits — both readings the model could offer were refused, one
 * WORDS_DROPPED and one CITATION_CODE (measured, adversarial review 2026-09-05).
 *
 * Longest first, so "III" is preferred over "II" over "I".
 */
const VOLUME_NUMBER = '[123]|III|II|I|1st|2nd|3rd';

/** The same set as a test, for the one place that reads a token on its own. */
const VOLUME_TOKEN = /^(?:[123]|i{1,3}|1st|2nd|3rd)$/i;

/**
 * The two- and three-letter words that stand in front of a number and are NOT
 * naming a thing — which is what evidence (d) has to step around.
 *
 * NOT "ordinary English words": "Map", "Bus" and "Odds" are ordinary English
 * words, they DO name a thing that carries a number, and (d) is meant to admit
 * them (the model then reads them as the prose they are). What is here is the
 * other grammatical slot — the function words and the pointing verbs, which
 * cannot be the name of anything. "See 20:6 there" and "In 20:16 he says" are
 * the measured cases.
 *
 * This list is CLOSED in a way the old deny-list of capitalized nouns never was,
 * and the reason is the length: the English function words of two or three
 * letters are a fixed, countable set, while the capitalized nouns that can
 * precede a colon-number are not.
 */
const SHORT_NOT_A_BOOK: ReadonlySet<string> = new Set([
  'an', 'as', 'at', 'be', 'by', 'do', 'go', 'he', 'if', 'in', 'is', 'it', 'its',
  'me', 'my', 'no', 'of', 'on', 'or', 'our', 'see', 'she', 'so', 'the', 'to',
  'up', 'us', 'we', 'you', 'and', 'but', 'for', 'her', 'his', 'not', 'now',
  'per', 'via', 'was', 'yet',
  // …and the citation markers, which point at a number without naming one.
  'cf', 'cp', 'eg', 'ie', 'ib', 'id', 'nos', 'pp', 'vs',
]);

/**
 * Is this token a MONTH? Owen's must-NOT list, and the one word-level exception
 * the detector still needs.
 *
 * "Jan. 3:7" and "Sept. 4:9" have shape (a) — an abbreviation with its period —
 * and are not references. Months are the only ordinary abbreviation this pass
 * refuses by name; every other one ("Sec. 3:7", "Ch. 3:7", "Mr. 3:7") is
 * detected, sent to the model, and read as whatever it actually is, which the
 * validator now allows.
 */
function namesNoBook(token: string): boolean {
  return monthName(token.toLowerCase().replace(/\.$/, '')) !== null;
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
  /**
   * The scripture references found in the text and PROTECTED from every rule.
   *
   * Offsets are the ORIGINAL text's, like `rewrites`. They are here so the pass
   * above can say why a block still holds digits after the rules ran: because a
   * reference is waiting for the model, not because a rule failed.
   */
  scripture: ScriptureSpan[];
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
// The scripture DETECTOR, and the one reading it leaves behind
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A chapter:verse reference, with everything that legitimately hangs off it.
 *
 * `[<volume> ]Book[.] c:v[a][–[c2:]v2[b]][ff.]`. The pattern MATCHES on shape
 * alone; `scriptureSpans` then requires one of the four kinds of evidence
 * above — the book token's own period, a volume number, a canonical name, or a
 * two-or-three-letter token — before it will call the match a reference. Matching widely and admitting
 * narrowly keeps the evidence test in one readable place instead of in three
 * regexes.
 *
 * THE RANGE MAY CROSS A CHAPTER. Reported by the orpheus-finetune side
 * (BOOKFORGE_HANDOFF.md, "Ask 2b") and found by running this pass over a real
 * corpus: "(Col. 3:19-4:1 and parallels)" must be recognized whole, or half of
 * it is protected and the other half is read by some other rule.
 */
const SCRIPTURE_REF = new RegExp(
  `(?:(?<![\\w:.\\-])(${VOLUME_NUMBER})\\s+)?`  // 1 an optional volume number
  + '([A-Z][A-Za-z]{1,13})(\\.?)\\s+'        // 2 the book token, 3 its period
  + '(?<![\\d:.])(\\d{1,3}):(\\d{1,3})'      // 4 chapter, 5 verse
  + '(?:(?!ff\\.)([a-z])(?![a-z\\d]))?'      // 6 an optional verse letter
  + '(?:\\s*[\\u2010-\\u2015\\u002D]\\s*'
  + '(?:(\\d{1,3}):)?'                       // 7 the range's own chapter, if any
  + '(\\d{1,3})(?:(?!ff\\.)([a-z])(?![a-z\\d]))?)?'  // 8 v2, 9 its letter
  + '(ff\\.)?'                               // 10 "and following"
  + '(?![A-Za-z\\d])',                       // and nothing else glued to it
  'gd');

/**
 * A CHAPTER-ONLY reference — but only "1 Pet. 3", never a bare "Gen. 3".
 *
 * THE DECISION, 2026-09-05, stated rather than guessed. A chapter-only
 * reference has no colon in it, so the only thing separating "Gen. 3" from
 * "Fig. 3" is knowing that Genesis is a book and a figure is not — and knowing
 * that is precisely the table Owen's ruling removed. A LEADING VOLUME NUMBER is
 * evidence that survives without one: English prints "1 Pet. 3" and never
 * "1 Fig. 3", so the numbered form is detected and the bare form is not. (Shape
 * (c) does not help here either: "Kings 3" and "Job 3" would take a chapter that
 * "Room 3" and "Track 3" print the same way, and only the colon tells them
 * apart.)
 *
 * A bare "Gen. 3" therefore reaches the model with its digit intact and is read
 * there — the same place every other unprotected digit is read. Nothing is lost;
 * what is refused is the app claiming to know a book by its shape alone.
 */
const SCRIPTURE_CHAPTER_ONLY = new RegExp(
  `(?<![\\w:.\\-])(${VOLUME_NUMBER})\\s+`  // 1 the volume number, REQUIRED
  + '([A-Z][A-Za-z]{1,12})\\.'          // 2 the book token, its period REQUIRED
  + '\\s+(\\d{1,3})'                    // 3 the chapter
  // …and nothing that makes it some other shape: a verse colon, a decimal, a
  // longer number, or a range dash.
  + '(?![\\d:]|\\.\\d|\\s*[\\u2010-\\u2015\\u002D]\\s*\\d)',
  'gd');

/** "2 Corinthians" — a numbered book with no reference behind it. */
const BARE_NUMBERED_BOOK = new RegExp(
  `(?<![\\w:.\\-])(${VOLUME_NUMBER})\\s+(${NUMBERED_BOOK_NAMES.join('|')})\\b`, 'g');

/**
 * A CLOCK RANGE — "5:30-6:00" — is not a verse range and is left whole.
 *
 * Blocked as a region rather than merely skipped, so the rule cannot come back
 * and convert the "5:30" half on its own and leave "-6:00" printed beside it.
 */
const CLOCK_RANGE = /\d{1,2}:\d{2}\s*[‐-―-]\s*\d{1,2}:\d{2}/g;

/**
 * ONE MORE REFERENCE IN A LIST, measured from the end of the last one —
 * "Leviticus 19:31; 20:6", "Genesis 6:11, 13 and 7:1", "Job 41:1–2, 14–34".
 *
 * A joiner (a semicolon, a comma, or "and"), then a verse or a chapter:verse,
 * with an optional range and an optional letter. Applied repeatedly, so a list
 * of any length is ONE detected span: a bare "13" that belongs to a reference
 * must be protected with it, or the integer rule reads it as a count while the
 * model reads the rest as a verse.
 *
 * BOUNDED, because the swallow is greedy and the numbers it swallows stop being
 * readable by any rule. Measured (adversarial review, 2026-09-05): "Quoting
 * Rom. 8:28, 250 members left" took the 250, and "Isa. 5:20 and 1,000 copies"
 * took the head of the grouped number. A BARE tail number is admitted only when
 * it could be a verse — no verse is above Psalm 119:176, so 176 is the ceiling —
 * and never when it is the head of a comma-grouped number. A tail carrying its
 * own `c:v` is a reference whatever its size and is not bounded.
 *
 * What this does NOT settle: "Gen. 1:1, 12 of them agreed". 12 is a possible
 * verse and the shape says nothing more, so it is still swallowed. The model
 * recovers it (an edit covering the words passes both scripture checks), and no
 * bound short of a dictionary would tell that 12 from the 13 of "Genesis 6:11,
 * 13 and 7:1".
 */
const HIGHEST_VERSE = 176;
const REF_LIST_TAIL = new RegExp(
  '^(?:\\s*[;,]\\s*(?:and\\s+)?|\\s+and\\s+)'
  + '(?:\\d{1,3}:)?\\d{1,3}(?:(?!ff\\.)[a-z](?![a-z\\d]))?'
  + '(?:\\s*[\\u2010-\\u2015\\u002D]\\s*(?:\\d{1,3}:)?\\d{1,3}'
  + '(?:(?!ff\\.)[a-z](?![a-z\\d]))?)?'
  + '(?:ff\\.)?'
  + '(?![A-Za-z\\d])');

/**
 * A time-of-day word standing immediately after the numbers.
 *
 * The clock rule takes every shape it is sure of before this one runs, but it
 * only knows hours one to twelve; "15:30 p.m." is not a clock it recognizes, and
 * a meridiem is not something a verse is ever followed by. So a meridiem is a
 * refusal here as well as a claim there — Owen's must-NOT list, 2026-09-05.
 */
const TRAILING_MERIDIEM = /^\s*(?:[ap]\.?\s?m\.?(?![A-Za-z])|o'clock\b)/i;

/** One span of text this pass recognized as a scripture reference. */
export interface ScriptureSpan {
  /** Its offset in the text it was found in. */
  at: number;
  /** One past its last character. */
  end: number;
  /** The text of it, exactly as printed. */
  find: string;
}

/**
 * Every scripture reference in `text`, as spans to be PROTECTED and read by the
 * model — never as readings.
 *
 * Exported because three places need the same answer and must not each have
 * their own: `applyNumberRules` closes these spans to every rule; the model
 * pass's validator relaxes one invariant inside them (an abbreviation may become
 * a name); and the tests pin the must-NOT list against them.
 */
export function scriptureSpans(text: string): ScriptureSpan[] {
  const found: ScriptureSpan[] = [];
  const add = (at: number, end: number) => {
    // A list tail can carry the span past a reference the scan finds later; the
    // overlap check keeps one span rather than two that share characters.
    if (found.some((s) => at < s.end && s.at < end)) return;
    found.push({ at, end, find: text.slice(at, end) });
  };

  for (const m of matches(SCRIPTURE_REF, text)) {
    const [, volume, bookToken, period] = m;
    if (namesNoBook(bookToken)) continue;
    // THE EVIDENCE TEST — the whole of it, in one place. A capitalized word in
    // front of a c:v is "Widescreen" as often as it is "Genesis"; one of these
    // three has to be true before the pass will claim it.
    const bare = bookToken.toLowerCase();
    const evidence = period === '.'                                  // (a)
      || volume !== undefined                                        // (b)
      || CANONICAL_BOOK_NAMES.has(bare)                              // (c)
      || (bookToken.length <= 3 && !SHORT_NOT_A_BOOK.has(bare));     // (d)
    if (!evidence) continue;
    let end = m.index + m[0].length;
    if (TRAILING_MERIDIEM.test(text.slice(end))) continue;
    // Swallow the rest of the list, one reference at a time.
    for (;;) {
      const tail = REF_LIST_TAIL.exec(text.slice(end));
      if (tail === null) break;
      // "John 3:16 and 2 Cor. 5:17" — the "2" after "and" is not a verse of
      // John, it is the volume number of the NEXT book, and swallowing it left
      // "Cor. 5:17" outside the span for the integer rule to read as "Cor. five
      // seventeen". A bare number with a capitalized word behind it belongs to
      // what follows; a number with its own colon is a reference either way.
      if (!tail[0].includes(':')) {
        if (/^\s+[A-Z]/.test(text.slice(end + tail[0].length))) break;
        // …and it has to be a number a verse could be, and not the head of a
        // comma-grouped one.
        const numbers = tail[0].match(/\d{1,3}/g) ?? [];
        if (numbers.some((n) => Number(n) > HIGHEST_VERSE)) break;
        if (/^,\d{3}(?!\d)/.test(text.slice(end + tail[0].length))) break;
      }
      end += tail[0].length;
    }
    add(m.index, end);
  }
  for (const m of matches(SCRIPTURE_CHAPTER_ONLY, text)) {
    if (namesNoBook(m[2])) continue;
    add(m.index, m.index + m[0].length);
  }
  for (const m of matches(BARE_NUMBERED_BOOK, text)) {
    add(m.index, m.index + m[0].length);
  }
  found.sort((a, b) => a.at - b.at);
  return found;
}

/**
 * A BOOK-LESS `c:v`, which is a verse or a clock time and is read only where
 * the two readings COINCIDE.
 *
 * This is what is left of the old scripture rule, and it is not scripture: no
 * book stands in front of these digits, so the pass does not know what they are.
 * At a verse of ten or more it does not need to — "6:59" is "six fifty nine"
 * whichever it is — and under ten it does ("10:05" could be "ten oh five"), so
 * those are left for the model.
 *
 * Owen's must-NOT list names the case this rule must NOT grow into: "at 3:16
 * John left" is a book name AFTER the digits, which is no evidence at all, and
 * it must keep reading "three sixteen" with no scripture pause in it. A detected
 * reference never reaches here — `applyNumberRules` has already closed it.
 */
function verseOrClockCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(BOOKLESS_REF, text)) {
    const [whole, chapter, verse, verseLetter, chapter2, verse2, verse2Letter, ff] = m;
    if (Number(verse) < 10) continue;

    const chapterWords = cardinalWords(Number(chapter));
    const verseWords = cardinalWords(Number(verse));
    if (chapterWords === null || verseWords === null) continue;

    let spoken = `${chapterWords} ${verseWords}`;
    if (verseLetter !== undefined) spoken += ` ${verseLetter}`;
    if (verse2 !== undefined) {
      const verse2Words = cardinalWords(Number(verse2));
      if (verse2Words === null) continue;
      spoken += ' through';
      if (chapter2 !== undefined) {
        const chapter2Words = cardinalWords(Number(chapter2));
        if (chapter2Words === null) continue;
        spoken += ` ${chapter2Words}`;
      }
      spoken += ` ${verse2Words}`;
      if (verse2Letter !== undefined) spoken += ` ${verse2Letter}`;
    }
    // "ff." is READ, not dropped: the pass refuses a MODEL edit that loses a
    // word of the book and must not do by rule what it refuses by hand.
    if (ff !== undefined) spoken += ' and following';

    out.push({ at: m.index, find: whole, replace: spoken, rule: 'verse-or-clock' });
  }
  return out;
}

/** The same shape as `SCRIPTURE_REF` with no book token in front of it. */
const BOOKLESS_REF = new RegExp(
  '(?<![\\d:.])(\\d{1,3}):(\\d{1,3})'
  + '(?:(?!ff\\.)([a-z])(?![a-z\\d]))?'
  + '(?:\\s*[\\u2010-\\u2015\\u002D]\\s*'
  + '(?:(\\d{1,3}):)?'
  + '(\\d{1,3})(?:(?!ff\\.)([a-z])(?![a-z\\d]))?)?'
  + '(ff\\.)?'
  + '(?![A-Za-z\\d])',
  'g');

// ─────────────────────────────────────────────────────────────────────────────
// Rule: date
// ─────────────────────────────────────────────────────────────────────────────

/** "12 June 1933" / "12th June 1933" — the printed order the reading inverts. */
const DATE_DAY_FIRST = new RegExp(
  `(?<![\\w:.\\-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})(\\.?)`
  + ',?\\s+(1[1-9]\\d{2}|20\\d{2})(?![\\w\\-])', 'g');

/**
 * "4 September" — a day-first date with NO YEAR.
 *
 * `DATE_DAY_FIRST` requires one, so a yearless day-first date fell through to
 * the bare-integer rule and read "four September". The LIVE model run of
 * 2026-09-04 measured it in Kershaw: "…his last detailed report, which was on 4
 * September." shipped as "on four September", and the model's own correct repair
 * ("September fourth") was refused because a mangled date is not one of the
 * classes a reading may be about. Owen's ruling: read it the American spoken
 * way, which is the with-year rule minus the year.
 *
 * THE PERIOD IS THE ABBREVIATION'S, OR THE SENTENCE'S, AND THEY ARE DIFFERENT.
 * "on 4 September." is a full month and a sentence ending; "on 4 Sept. and
 * later" is an abbreviation mid-sentence; "on 4 Sept. The next day" is both. So
 * the period is only swallowed when the month is ABBREVIATED, and even then it
 * is written back when what follows could be a new sentence — the same rule the
 * reading law applies to "Oxford St. The rain".
 *
 * The year lookahead is what keeps this off "4 September 1939", which the
 * with-year rule reads; the lead guard is what keeps it off "Chapter 4
 * September" and "p. 4 September", where the digit is not a day.
 */
const DATE_DAY_FIRST_NO_YEAR = new RegExp(
  `(?<![\\w:.\\-])(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALTERNATION})(\\.?)(?![A-Za-z])`
  + '(?!,?\\s*(?:1[1-9]\\d{2}|20\\d{2}))', 'g');

/**
 * Could a period here be the end of a SENTENCE?
 *
 * Nothing after it, or a capital, a quote or a bracket. Written out rather than
 * imported because this module is a leaf the training side vendors on its own.
 */
function periodCouldEndSentence(after: string): boolean {
  const next = after.replace(/^[\s\u00a0]+/, '');
  return next === '' || /^["'\u201c\u2018([]/.test(next) || /^[A-Z\u00c0-\u00de]/.test(next);
}

/**
 * The words that make the number after them a NUMBERED THING and not a day.
 *
 * "Chapter 4 September" is a chapter and a month, not the fourth of September.
 */
const DATE_LEAD_BLOCK =
  /(?:chapter|part|section|volume|vol|book|figure|fig|table|act|no|nos|pp?|line|item|note)\.?\s+$/i;

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
  // LAST, so a with-year match at the same offset is the one that wins: the
  // engine takes candidates left to right and closes what it takes.
  for (const m of matches(DATE_DAY_FIRST_NO_YEAR, text)) {
    const month = monthName(m[2]);
    if (month === null) continue;
    if (DATE_LEAD_BLOCK.test(text.slice(0, m.index))) continue;
    const spoken = dateWords(month, Number(m[1]), undefined);
    if (spoken === null) continue;
    // The period goes with the month only when the month is ABBREVIATED. After a
    // full name it is the sentence's and stays exactly where the book put it.
    const abbreviated = m[2].toLowerCase() !== month.toLowerCase();
    const period = m[3] === '.' && abbreviated;
    const find = period ? m[0] : m[0].slice(0, m[0].length - m[3].length);
    if (sitsInCitation(text, find, m.index)) continue;
    const after = text.slice(m.index + find.length);
    const replace = period && periodCouldEndSentence(after) ? `${spoken}.` : spoken;
    out.push({ at: m.index, find, replace, rule: 'date' });
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
// Rule: a page reference — READ, since 2026-09-04
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "p. 23", "pp. 65-71" — a page reference, which a narrator reads out loud.
 *
 * Owen's ruling of 2026-09-04 revised the leave-as-printed list: a page
 * reference has exactly one spoken reading, so it is a RULE and not a refusal.
 * The abbreviation the book printed decides the word — `p.` is "page", `pp.` is
 * "pages" — and a range is joined with "to", not the verse range's "through",
 * because "pages sixty five through seventy one" is not how anyone says it.
 *
 * Its capital is kept: a sentence that opens "P. 23 has the figure" reads "Page
 * twenty three", and lower-casing it mid-book would be a change to the prose.
 *
 * WHAT IT DOES NOT TAKE: "vol. 2", "no. 5", "ibid.", "fol." — those are still
 * `CITATION_LEAD`'s, because a volume number is apparatus rather than something
 * a narrator says. And a leading zero ("p. 007") is a code, not a page.
 */
const PAGE_REF = new RegExp(
  '(?<![\\w.\\-])(pp?)\\.\\s*(\\d{1,4})'
  + '(?:\\s*[\\u2010-\\u2015\\u002D]\\s*(\\d{1,4}))?(?![\\w\\-])', 'gi');

function pageCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(PAGE_REF, text)) {
    const [whole, abbrev, first, second] = m;
    if (first.length > 1 && first.startsWith('0')) continue;
    if (second !== undefined && second.length > 1 && second.startsWith('0')) continue;
    // AN ABBREVIATED RANGE IS LEFT. "pp. 51-2" drops the shared leading digit and
    // means pages fifty-one to fifty-two; read literally it becomes "pages fifty
    // one to two", which is what this rule shipped until 2026-09-04. Owen's ruling
    // is that the shape is apparatus and stays as printed, so the span is left
    // whole here and `sitsInCitation` clause 7 keeps the model off it as well.
    if (second !== undefined && second.length < first.length) continue;
    const firstWords = cardinalWords(Number(first));
    if (firstWords === null) continue;
    let spoken = abbrev.toLowerCase() === 'pp' ? 'pages' : 'page';
    if (abbrev[0] === abbrev[0].toUpperCase()) spoken = spoken[0].toUpperCase() + spoken.slice(1);
    spoken += ` ${firstWords}`;
    if (second !== undefined) {
      const secondWords = cardinalWords(Number(second));
      if (secondWords === null) continue;
      spoken += ` to ${secondWords}`;
    }
    out.push({ at: m.index, find: whole, replace: spoken, rule: 'page' });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule: digits glued to letters — READ, since 2026-09-04
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A token of letters, digits and hyphens — "COVID-19", "B-17", "I-95", "R2D2",
 * "7-Eleven", "MP3".
 *
 * Owen's ruling of 2026-09-04 moved this out of the leave-as-printed list too:
 * *"COVID-nineteen is actually correct, that's how it's pronounced in real
 * life."* Every one of these is said with the number as a word, so the printed
 * form has one reading and code can give it.
 *
 * The lookarounds exclude a `/` on either side, which is what keeps this off
 * every archive and catalogue code the guard exists for — "9/34" and "298/38"
 * are not tokens this rule can even see. A trailing `.` is allowed (a sentence
 * ends), but a `.` followed by a DIGIT is not: "v1.2" is a version number, and
 * reading half of it would print "v one.2".
 */
const GLUED_ALNUM = /(?<![\w/.\-])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?![\w/\-])/g;

/**
 * The longest digit run this rule will read.
 *
 * THREE, not four, and the fourth digit is where the corpus contract lives. A
 * four-digit run inside a hyphenated token is a YEAR — "pre-1914", "post-1945",
 * "Kennedy-1963", "Louis XIV-1715" — and a year is the model's judgement, never
 * a rule's (`BARE_INT` stops at three digits for exactly this reason). Reading
 * one here would say "pre-one thousand nine hundred fourteen", which is not what
 * anybody says and not what the four served fine-tunes were trained on.
 *
 * Found by the adversarial review of 2026-09-04, which measured the first cut of
 * this rule against an n4 build over the same corpus.
 */
const GLUED_MAX_DIGITS = 3;
/** And the most runs. "A1B2C3D4" is a part number, not a word with a number in it. */
const GLUED_MAX_RUNS = 3;

/**
 * A token that OPENS with digits pressed straight against letters — "105mm",
 * "9mm", "20km", "5kg", "12V", "8GB", "6ft", "4a".
 *
 * That shape is a MEASUREMENT or a designation, and its letters are a unit
 * abbreviation the narrator says as a word ("millimetre", "kilograms") or as
 * letters ("G B") — never as the printed letters glued to a number. This rule
 * has no table of units and no way to tell "4a" (a Sonderkommando) from "4A" (a
 * seat), so it read "one hundred five mm" and destroyed the digits on the way
 * (the second adversarial review, 2026-09-04). Left for the model, which can see
 * the sentence.
 *
 * The LETTER-PREFIX forms are untouched and are what this rule is for: "B-17",
 * "COVID-19", "R2D2", "F8F", "C18", "V-2", "MP3". So are the hyphenated ones
 * that open with digits, where the hyphen says the number is its own word:
 * "7-Eleven", "24-hour", "30-year-old".
 */
const DIGITS_THEN_UNIT = /^\d+[A-Za-z]/;

/**
 * A digit run whose shape belongs to an EARLIER rule, and which this catch-all
 * must therefore not read.
 *
 * `FULL_DECADE`, the year rule and `ORDINAL` each carry a `(?<![\w.\-])`
 * lookbehind that excludes a preceding hyphen, so every one of these was left as
 * printed before this rule existed — and this rule runs LAST, which is exactly
 * why it would otherwise claim them all:
 *
 *   mid-1920s   -> "mid-one thousand nine hundred twenty s"   (decade, hyphenated)
 *   mid-19th    -> "mid-nineteen th"                          (ordinal, hyphenated)
 *
 * Both are MALFORMED, and they carry no digit afterwards, so `stillHasDigits`
 * never sends them to the model and no downstream guard can see them — the same
 * failure class as the orphaned colon this version's scripture fix removed.
 *
 * A run followed by "s" is a decade or a plural; a run followed by an ordinal
 * suffix is an ordinal. Either way the reading is not a bare cardinal, and a
 * rule that cannot tell which reading it is has no business guessing.
 *
 * NO TRAILING LOOKAHEAD, and its absence is the fix. `(?![A-Za-z])` said "only
 * when the suffix ENDS the run", which `<br/>` fusion defeats: the walk joins
 * the words either side of a line break with nothing between them, so a book
 * printing "the 3rd<br/>day" hands this rule "the 3rdday" and the lookahead
 * failed — the token was read "three rdday" (the second adversarial review,
 * 2026-09-04). n4 left those digits for the model, which is the right answer,
 * and dropping the lookahead restores it. The reviewer probed every intended
 * reading: none regresses, because no shape this rule is FOR has a digit run
 * followed by "s" or by an ordinal suffix at all.
 */
const CLAIMED_BY_ANOTHER_RULE = /^(?:s|st|nd|rd|th)/i;

function gluedCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of matches(GLUED_ALNUM, text)) {
    const token = m[0];
    if (token.length > 24) continue;
    if (!/[A-Za-z]/.test(token) || !/\d/.test(token)) continue;
    const runs = token.match(/\d+/g)!;
    if (runs.length > GLUED_MAX_RUNS) continue;
    // A serial, a leading zero, or a number no cardinal covers: left as printed.
    if (runs.some((run) => run.length > GLUED_MAX_DIGITS)) continue;
    if (runs.some((run) => run.length > 1 && run.startsWith('0'))) continue;
    // A measurement or a designation: digits pressed straight against letters.
    if (DIGITS_THEN_UNIT.test(token)) continue;
    // A run whose shape another rule owns — a decade's "s", an ordinal's suffix.
    // Checked per run, against what FOLLOWS it inside the token.
    let claimed = false;
    for (const runMatch of token.matchAll(/\d+/g)) {
      if (CLAIMED_BY_ANOTHER_RULE.test(token.slice(runMatch.index! + runMatch[0].length))) {
        claimed = true;
        break;
      }
    }
    if (claimed) continue;
    // "v1.2" — a version, not a word with a number in it.
    if (/^\.\d/.test(text.slice(m.index + token.length))) continue;
    if (sitsInCitation(text, token, m.index)) continue;

    // Every digit run becomes its cardinal, IN PLACE. A hyphen the book printed
    // stays a hyphen ("B-seventeen"); a digit run pressed straight against a
    // letter gains a space, because "Rtwo" is not a word ("R2D2" reads "R two D
    // two").
    let replace = '';
    let refused = false;
    for (let i = 0; i < token.length;) {
      if (!/\d/.test(token[i])) { replace += token[i]; i++; continue; }
      let end = i;
      while (end < token.length && /\d/.test(token[end])) end++;
      const words = cardinalWords(Number(token.slice(i, end)));
      if (words === null) { refused = true; break; }
      if (i > 0 && /[A-Za-z]/.test(token[i - 1])) replace += ' ';
      replace += words;
      if (end < token.length && /[A-Za-z]/.test(token[end])) replace += ' ';
      i = end;
    }
    if (refused || replace === token) continue;
    out.push({ at: m.index, find: token, replace, rule: 'glued' });
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
  // What is left of scripture in this file: a book-LESS chapter:verse, read only
  // where the verse and the clock readings coincide. Every reference with a book
  // in front of it was closed before this list ran and belongs to the model.
  { name: 'verse-or-clock', scan: verseOrClockCandidates },
  // Before the date and the integer, because "p. 12" is a page and not a day,
  // and because the whole "pp. 65-71" is one reading its halves are not.
  { name: 'page', scan: pageCandidates },
  { name: 'date', scan: dateCandidates },
  { name: 'money', scan: moneyCandidates },
  { name: 'percent', scan: percentCandidates },
  { name: 'decade', scan: decadeCandidates },
  { name: 'ordinal', scan: ordinalCandidates },
  { name: 'marker', scan: markerCandidates },
  { name: 'grouped', scan: groupedIntCandidates },
  { name: 'integer', scan: bareIntCandidates },
  // LAST, because it is the widest net: every earlier rule that knows a shape
  // ("1940s-era" is a decade before it is a glued token) has already taken it,
  // and what reaches here is a token no other rule recognized.
  { name: 'glued', scan: gluedCandidates },
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
  // AND EVERY SCRIPTURE REFERENCE, closed before any rule runs. Owen's ruling of
  // 2026-09-05: the reading of a reference is the model's, and a rule that read
  // half of one ("1 Pet. 3:7" → "one pet three seven") is the defect that ruling
  // came from. Protection is what makes the model's job possible — the digits
  // have to still be there when it is asked.
  const scripture = scriptureSpans(text);
  for (const span of scripture) closed.push({ at: span.at, end: span.end });
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

  return { rewrites, refused, text: out, segments: grown, scripture };
}

/** Does this text still hold a digit the model has to be asked about? */
export function stillHasDigits(text: string): boolean {
  return DIGIT.test(text);
}
