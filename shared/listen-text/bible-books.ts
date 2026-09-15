/**
 * bible-books.ts — the scripture book NAME, expanded deterministically, and
 * only where the name cannot be anything else.
 *
 * ── The request ─────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"for ai cleanup, i want to deterministically expand bible
 * book names. ex -> exodus, tim. -> timothy. or at least tell the ai cleanup
 * model to expand them the rest of the way before going through TTS. it's a
 * mess."*
 *
 * ── THE THIRD NAMED EXCEPTION ───────────────────────────────────────────────
 *
 * The standing rule is that deterministic text fixes are for LISTEN only and a
 * BOOK goes through the cleanup MODEL, because a rule that is wrong about a
 * book is wrong in an audiobook nobody re-reads. Two exceptions were already
 * granted — the unspoken-glyph strip and the caps-run fold — on the same
 * ground, which is that they fire only where they CANNOT be wrong. This is the
 * third, and it is held to the same standard: nothing here expands a word that
 * could be an English word, a person, a month, a chapter or a rank.
 *
 * ── WHAT DECIDES "UNAMBIGUOUS" — AND WHY IT IS NOT A SECOND REGEX ───────────
 *
 * `electron/tts-number-rules.ts` already answers this exact question. Its
 * `scriptureSpans` finds every reference in a text and requires one of four
 * kinds of evidence before it will call a capitalized word in front of a
 * `c:v` a book: the token's own abbreviating period, a volume number, a
 * canonical book name, or a two-or-three-letter token that is not a function
 * word. That detector was measured against a 1,030-line fixture
 * (`tools/fixtures/scripture-readings.json`) and against Owen's own must-NOT
 * list ("Widescreen 16:9", "Chapter 3:7", "Jan. 3:7", "at 3:16 John left"), and
 * it exists because the rules must PROTECT a reference from being half-read.
 *
 * So this module does not ask the question again. It asks the detector, and
 * expands the book token INSIDE a span the detector already claimed. One
 * detector, one definition of "this is a reference", and the negative corpus
 * that guards it is the one already in the repository.
 *
 * ── WHAT OWEN RULED OUT BEFORE, AND WHY THIS IS NOT THAT ────────────────────
 *
 * 2026-09-05, on a proposal to read references by table: *"there are a billion
 * ways Bible verses are abbreviated"*. That ruling stands and is the reason the
 * detector has no abbreviation table in it at all — it asks a token's SHAPE,
 * never its identity, and it never produces a READING.
 *
 * This table does not decide whether something is a reference; the detector
 * does. It only answers "given that this IS a reference, what is the book's
 * full name" — and it answers that with the abbreviations it knows and stays
 * silent on every one it does not. An abbreviation missing from this table
 * costs nothing: the span is untouched and the model reads it exactly as it
 * does today. That is what makes an open set safe to have a partial table of.
 *
 * ── THE CHAPTER AND VERSE STAY AS DIGITS ────────────────────────────────────
 *
 * On purpose. A detected span is CLOSED to every number rule so the model can
 * read the reference whole ("Romans five, verse seventeen" — the measured form,
 * 22 clips of 23), and this pass must not take half of that job. It replaces
 * the NAME and nothing else, and the span it leaves behind is still a span the
 * detector recognizes: "Rom. 5:17" becomes "Romans 5:17", which has evidence
 * (c) — a canonical name — where it had evidence (a).
 */
import type { NarrationTextRewrite } from '../text/narration-rewrite.js';
import { CANONICAL_BOOK_NAMES, scriptureSpans } from '../../electron/tts-number-rules.js';

/**
 * HOW A VOLUME NUMBER IS READ — the one place to change it.
 *
 * "1 Cor." is "First Corinthians", not "One Corinthians" and not "1
 * Corinthians". THIS IS THE RULING OWED: it is taken from the number prompt,
 * which has stated it since 2026-09-05 (*"A LEADING BOOK NUMBER is an ordinal
 * word: 1 is 'First', 2 is 'Second', 3 is 'Third' — never 'one', never
 * 'two'"*) and which the model has been asked against ever since, so the
 * deterministic half agreeing with it is the only choice that does not make
 * two halves of one pass read the same reference two ways. If Owen wants
 * "One Corinthians", or the numeral left standing for the model, this array is
 * the whole edit.
 */
export const BOOK_ORDINAL_WORDS: readonly string[] = ['First', 'Second', 'Third'];

/** A volume number as a book prints one — arabic, roman or ordinal. */
const VOLUME_WORDS: ReadonlyMap<string, number> = new Map(Object.entries({
  '1': 1, i: 1, '1st': 1,
  '2': 2, ii: 2, '2nd': 2,
  '3': 3, iii: 3, '3rd': 3,
}));

/**
 * THE TABLE — an abbreviation, lower-cased and without its period, to the full
 * name a narrator says.
 *
 * A NUMBERED book's name here is the name WITHOUT its volume ("Corinthians",
 * never "1 Corinthians"), because the volume is read separately above and
 * because that is the token the detector hands over.
 *
 * ── WHAT IS DELIBERATELY ABSENT, and why each one ───────────────────────────
 *
 * Every entry below has to survive the question "what ELSE is this?", and
 * fourteen candidates did not. They are listed rather than silently omitted,
 * because the next person to "complete" this table will reach for exactly
 * these:
 *
 *   ch      "Ch. 3:7" is a CHAPTER — the number prompt names it by name.
 *   mr      Mister.
 *   kg      a kilogram.
 *   nb      nota bene.
 *   pp      pages.
 *   re      "Re:" — a subject line, and a citation marker.
 *   act     "Act 3:2" of a play — Owen's own must-NOT list.
 *   ti      Timothy or Titus, and nothing tells them apart.
 *   hb      Habakkuk or Hebrews.
 *   jud     Jude, Judges or Judith.
 *   jo      Job, Joel, John or Jonah.
 *   ph      Philippians or Philemon.
 *   am      the verb, and the meridiem.
 *   is      the verb. (A dotted "Is. 40:31" IS detected; expanding it would
 *           mean this table, not the detector, deciding that a sentence
 *           beginning "Is." is scripture.)
 *   de, es, lu, mar
 *           too short to be an abbreviation of one thing — "de" and "es" are
 *           particles, "Lu" is a name, and "Mar." is March (which the detector
 *           refuses as a month before this table is ever asked).
 *
 * A FULL NAME IS NOT AN ABBREVIATION and is not in this table: "John", "Mark",
 * "Acts", "Job", "Ruth", "Amos", "Joel", "Titus", "Jude", "James" and "Song"
 * are already what a narrator says, so there is nothing to expand and no way
 * for this pass to be wrong about them. That is not an omission; it is the
 * reason the never-expand list is shorter than it looks.
 */
const ABBREVIATIONS: ReadonlyMap<string, string> = new Map(Object.entries({
  // ── The Law ──
  gen: 'Genesis', ge: 'Genesis', gn: 'Genesis',
  ex: 'Exodus', exo: 'Exodus', exod: 'Exodus',
  lev: 'Leviticus', lv: 'Leviticus',
  num: 'Numbers', nu: 'Numbers', nm: 'Numbers',
  deut: 'Deuteronomy', dt: 'Deuteronomy',
  // ── The History ──
  josh: 'Joshua', jos: 'Joshua', jsh: 'Joshua',
  judg: 'Judges', jdg: 'Judges', jdgs: 'Judges',
  rth: 'Ruth',
  sam: 'Samuel', sm: 'Samuel',
  kgs: 'Kings', ki: 'Kings', kin: 'Kings',
  chr: 'Chronicles', chron: 'Chronicles', chro: 'Chronicles',
  ezr: 'Ezra',
  neh: 'Nehemiah',
  esth: 'Esther', est: 'Esther',
  // ── The Poetry ──
  jb: 'Job',
  // "Ps." and "Psa." are the SINGULAR; only the doubled "Pss." is the plural.
  // The prompt has stated that since 2026-09-05 and the corpus measured it
  // four times out of four.
  ps: 'Psalm', psa: 'Psalm', pslm: 'Psalm', pss: 'Psalms',
  prov: 'Proverbs', prv: 'Proverbs', pro: 'Proverbs',
  eccl: 'Ecclesiastes', eccles: 'Ecclesiastes', eccle: 'Ecclesiastes',
  ec: 'Ecclesiastes', qoh: 'Ecclesiastes',
  sg: 'Song of Songs', sos: 'Song of Songs', cant: 'Song of Songs',
  // ── The Prophets ──
  isa: 'Isaiah',
  jer: 'Jeremiah', je: 'Jeremiah', jr: 'Jeremiah',
  lam: 'Lamentations',
  ezek: 'Ezekiel', eze: 'Ezekiel', ezk: 'Ezekiel',
  dan: 'Daniel', dn: 'Daniel',
  hos: 'Hosea', ho: 'Hosea',
  joe: 'Joel', jl: 'Joel',
  amo: 'Amos',
  obad: 'Obadiah', ob: 'Obadiah', oba: 'Obadiah',
  jon: 'Jonah', jnh: 'Jonah',
  mic: 'Micah', mi: 'Micah',
  nah: 'Nahum', na: 'Nahum',
  hab: 'Habakkuk',
  zeph: 'Zephaniah', zep: 'Zephaniah', zp: 'Zephaniah',
  hag: 'Haggai', hg: 'Haggai',
  zech: 'Zechariah', zec: 'Zechariah', zc: 'Zechariah',
  mal: 'Malachi', ml: 'Malachi',
  // ── The Gospels and Acts ──
  matt: 'Matthew', mt: 'Matthew', mat: 'Matthew',
  mk: 'Mark', mrk: 'Mark',
  lk: 'Luke', luk: 'Luke',
  jn: 'John', jhn: 'John', joh: 'John',
  ac: 'Acts',
  // ── The Letters ──
  rom: 'Romans', ro: 'Romans', rm: 'Romans',
  cor: 'Corinthians', co: 'Corinthians',
  gal: 'Galatians', ga: 'Galatians',
  eph: 'Ephesians', ep: 'Ephesians',
  phil: 'Philippians', php: 'Philippians', philip: 'Philippians',
  col: 'Colossians', cl: 'Colossians',
  thess: 'Thessalonians', thes: 'Thessalonians', th: 'Thessalonians',
  tim: 'Timothy', tm: 'Timothy',
  tit: 'Titus',
  phlm: 'Philemon', phm: 'Philemon', philem: 'Philemon', pm: 'Philemon',
  heb: 'Hebrews',
  jas: 'James', jm: 'James',
  pet: 'Peter', pe: 'Peter', pt: 'Peter',
  rev: 'Revelation', rv: 'Revelation',
  // ── The deuterocanon, which a Catholic edition prints and cites the same way ──
  tob: 'Tobit', tb: 'Tobit',
  jdt: 'Judith',
  wis: 'Wisdom', ws: 'Wisdom',
  sir: 'Sirach', ecclus: 'Sirach',
  bar: 'Baruch',
  macc: 'Maccabees', mac: 'Maccabees', mc: 'Maccabees',
  esd: 'Esdras',
}));

/**
 * The abbreviations that may be expanded with NO reference behind them at all.
 *
 * A bare "Phlm." has no chapter and no verse, so the detector never sees it and
 * the evidence has to come from the word itself. Three tests, all of which an
 * entry here passes: it is not an English word, it is not a name anybody is
 * called, and it is not an abbreviation of anything else in a book. It must
 * still carry its abbreviating PERIOD — that period is what says "this is
 * short for something" — so a dotless "Phlm" is left alone.
 *
 * DELIBERATELY TINY, and the omissions are the point. "Zeph.", "Obad.",
 * "Matt.", "Isa.", "Jer." and "Josh." are all names people are actually
 * called, and a narrator saying "Joshua wrote back" where the book said
 * "Josh. wrote back" is exactly the class of error the LISTEN-only rule exists
 * to prevent. Adding one is a line here and a case in the negative corpus.
 */
const BARE_ALIASES: ReadonlySet<string> = new Set([
  'phlm', 'philem', 'eccles', 'ecclus', 'judg', 'ezek', 'chron',
]);

/**
 * The prefix of a detected span: an optional volume number, then the book
 * token, then its optional period. Anchored, because it is applied to the span
 * the detector already delimited and must describe that span's own head.
 */
const SPAN_PREFIX = /^(?:([123]|III|II|I|1st|2nd|3rd)\s+)?([A-Z][A-Za-z]{0,13})(\.?)/;

/** A bare dotted abbreviation standing on its own: "Phlm." with nothing behind it. */
const BARE_DOTTED = /(?<![\w.])([A-Z][A-Za-z]{2,13})\.(?![\w.])/g;

/** One expansion, with the book it named, so a caller can say what it did. */
export interface BibleBookExpansion extends NarrationTextRewrite {
  /** The full book name this span now prints — for the log, never for a reading. */
  book: string;
}

/** `g`-flag iteration without the shared-lastIndex trap. */
function* matches(re: RegExp, text: string): Generator<RegExpExecArray> {
  const scan = new RegExp(re.source, re.flags);
  for (let m = scan.exec(text); m !== null; m = scan.exec(text)) {
    if (m[0] === '') { scan.lastIndex++; continue; }
    yield m;
  }
}

/** The full name for an abbreviation, or null when the table has no opinion. */
function fullName(token: string): string | null {
  const bare = token.toLowerCase();
  // A token that is ALREADY a canonical book name is not an abbreviation, and
  // rewriting it to itself would be a rewrite the writer has to verify for
  // nothing. "Song", "John" and "Job" live here, which is why they are safe.
  if (CANONICAL_BOOK_NAMES.has(bare)) return null;
  return ABBREVIATIONS.get(bare) ?? null;
}

/**
 * Every span of `text` whose scripture BOOK NAME is printed short and is read
 * long — as rewrites, in the order they occur, non-overlapping.
 *
 * `segments` is the length of each of the text's nodes, exactly as
 * `applyNumberRules` takes them: a rewrite that would have to cross a text-node
 * boundary is DROPPED rather than applied, because reaching across the boundary
 * means flattening the element to get at the name. A plain string passes
 * `[text.length]`, which is what `expandBibleReferences` does.
 */
export function bibleReferenceRewrites(
  text: string,
  segments: readonly number[] = [text.length],
): BibleBookExpansion[] {
  const starts: number[] = [];
  let running = 0;
  for (const length of segments) { starts.push(running); running += length; }
  if (running !== text.length) {
    throw new Error(
      `The bible book expansion was handed segments summing to ${running} for a `
      + `${text.length}-character text. Those describe two different strings; nothing was `
      + 'rewritten.');
  }
  const withinOneNode = (at: number, end: number): boolean =>
    starts.some((start, i) => at >= start && end <= start + segments[i]);

  const out: BibleBookExpansion[] = [];
  const taken: Array<{ at: number; end: number }> = [];
  const add = (at: number, find: string, replace: string, book: string): void => {
    const end = at + find.length;
    if (!withinOneNode(at, end)) return;
    if (taken.some((t) => at < t.end && t.at < end)) return;
    taken.push({ at, end });
    out.push({ at, find, replace, book });
  };

  // ── 1. Inside a reference the detector already claimed ──────────────────
  for (const span of scriptureSpans(text)) {
    const head = SPAN_PREFIX.exec(span.find);
    if (head === null) continue;
    const [whole, volume, token] = head;
    const name = fullName(token);
    let ordinal: string | null = null;
    if (volume !== undefined) {
      const which = VOLUME_WORDS.get(volume.toLowerCase());
      if (which === undefined) {
        throw new Error(
          `The bible book expansion matched "${volume}" as a volume number in "${span.find}" and `
          + 'has no ordinal word for it. SPAN_PREFIX and VOLUME_WORDS describe two different sets '
          + 'of volume numbers; nothing was rewritten.');
      }
      ordinal = BOOK_ORDINAL_WORDS[which - 1];
    }
    // Nothing printed short: a fully spelled book with no volume number in
    // front of it is already what the narrator says.
    if (name === null && ordinal === null) continue;
    const spoken = name ?? token;
    // The abbreviating period is CONSUMED here and only here: what follows it
    // inside a detected span is the chapter, so it can never have been ending a
    // sentence. (The bare case below is where that question is real.)
    const replace = ordinal === null ? spoken : `${ordinal} ${spoken}`;
    if (replace === whole) continue;
    add(span.at, whole, replace, name ?? spoken);
  }

  // ── 2. A bare dotted abbreviation that can be nothing else ──────────────
  for (const m of matches(BARE_DOTTED, text)) {
    const token = m[1];
    if (!BARE_ALIASES.has(token.toLowerCase())) continue;
    const name = fullName(token);
    if (name === null) continue;
    // THE PERIOD IS ALSO A FULL STOP when a capital or the end of the text
    // follows it — the same rule the narration prompt states for "Oxford St.
    // The rain" — so it is kept there and dropped everywhere else. Getting this
    // wrong runs two sentences together in the audio.
    const rest = text.slice(m.index + m[0].length);
    const sentenceEnd = rest.trim() === '' || /^\s+["'(“‘]?[A-Z]/.test(rest);
    add(m.index, m[0], sentenceEnd ? `${name}.` : name, name);
  }

  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * `text` with every unambiguous scripture book abbreviation printed in full.
 *
 * The convenience form for a caller that holds a whole string rather than an
 * element's text nodes — Listen, and a `.txt` narration input.
 */
export function expandBibleReferences(text: string): string {
  const edits = bibleReferenceRewrites(text);
  if (edits.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.at) + edit.replace;
    cursor = edit.at + edit.find.length;
  }
  return out + text.slice(cursor);
}
