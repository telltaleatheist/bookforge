/**
 * tts-number-normalizer.ts — the numbers in a narration copy, read as words.
 *
 * ── Why a MODEL does the reading and code does the guarding ─────────────────
 *
 * A TTS engine handed "June 12, 1933" says something, and what it says depends
 * on the engine, the voice and the sentence around it. Orpheus fine-tunes read
 * dates in whatever form their corpus taught them, which is how the 08-30 date
 * probe ended with 43 of 120 takes garbled on BOTH served checkpoints (the
 * fixture beside this file: `_campaigns/2026-09-01-cod-full-rebuild/fixtures/
 * number-normalization`). The fix is to hand the engine words, so every voice
 * says the same thing.
 *
 * Owen ruled on HOW, 2026-09-01: deterministic rules *"almost never catch
 * everything and almost always get something wrong"*, so a model does the
 * conversion. This file is the other two thirds of that ruling — the code that
 * SELECTS what the model is asked about and VALIDATES what it sends back. The
 * model never edits the book: it returns an edit list, every edit is checked
 * against a wall of deterministic rules, and a rejected edit means the printed
 * digits stand and the rejection is recorded by name.
 *
 * ── And the third of it that code DOES read, since 2026-09-02 ───────────────
 *
 * The first live run measured the cost of asking a 9b model about shapes that
 * have exactly one reading: it narrated "Jeremiah 44:17-19" as "four fourteen
 * seventeen", said the word "hyphen" out loud forty times, and threw away
 * fifty-seven correct expansions of "2 Cor." because it had dropped the
 * abbreviation. Owen's ruling on that record: *"lets try doing deterministic
 * scripture fixing since we know that shape. have it do the deterministic part
 * before sending it through to the ai, so the ai has less work to do… just basic
 * deterministic stuff that we can guarantee will be correct on the other side,
 * then send everything else through the ai."*
 *
 * So `electron/tts-number-rules.ts` runs FIRST, over every selected span. What
 * it converts, the model never sees; a passage with no digit left after it is
 * never sent at all (`RULES_ONLY`). What the model IS shown is the rule-applied
 * text, its edits are validated against that, and the accepted ones are mapped
 * back to offsets in the ORIGINAL — a model edit that reaches into a span the
 * rules already read is refused (`OVERLAPS_APPLIED`), because two readings of
 * one span is not an improvement on either.
 *
 * ── The three things this pass will not do ──────────────────────────────────
 *
 *  1. It will not touch text with no digit in it. Selection is a digit test, and
 *     a `find` with no digit is rejected — so prose the model felt like tidying
 *     cannot ride in on a number edit.
 *  2. It will not speak a citation. "Document II 9/34", "p. 23", "298/38" are
 *     unspeakable in any form (orpheus-training's evidence: they derail every
 *     model), so they are LEFT AS PRINTED and left for a content-layer decision.
 *  3. It will not lose a word. Every letter-bearing word of a `find` has to
 *     appear again, in order, in the `replace` — the model may convert numbers,
 *     never rename the prose around them.
 *
 * ── What is content-addressed, and why the version constant is here ─────────
 *
 * The normalized copy is named by the sha of the file that went IN, the rule
 * version below, and the model tag. Same three ⇒ same path, reused without a
 * model call; any change ⇒ a new path. `NORMALIZER_VERSION` versions the RULES
 * AND THE PROMPT together: a change to either makes the copies on disk describe
 * a pass this file no longer runs, and they must not be reused.
 *
 * Doctrine: the model call is INJECTED (`NumberNormalizerRunner`). Nothing in
 * here dials Ollama, so the whole state space — good edits, drift, dropped
 * words, a digit left in, a citation edit, garbage JSON — is reachable from a
 * test with no GPU.
 */
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { hasLetter } from './ai-cleanup-prepass.js';
import {
  applyNumberRules, bareWord, CANONICAL_BOOK_NAMES, cardinalWords, scriptureSpans,
  sitsInCitation, stillHasDigits,
} from './tts-number-rules.js';
import { ordinalToWords } from './number-expansion.js';
import {
  ABBREVIATION_READINGS, abbreviationContextRefusal, abbreviationKey, bracketRemovalRefusal,
  capsReadingRefusal, gluedAmpersandReadings, hasGluedAmpersand, isEmphasisWord, isRomanContext,
  prefixesAName, romanReadingRefusal, romanValue,
} from './tts-spoken-forms.js';
import type { ReadingRefusal } from './tts-spoken-forms.js';
import type { NumberRuleOutcome } from './tts-number-rules.js';
import type { NarrationNumberTarget, NarrationTextRewrite } from './epub-processor.js';

// The citation guard is DEFINED in tts-number-rules.ts, because the rules and
// this validator owe the same answer about "p. 23". Re-exported here so the
// tests and callers that knew it by this name still find it.
export { sitsInCitation, bareWord };

/**
 * The rule version, in the copy's own filename.
 *
 * BUMP IT when the selection rule, any disposition below,
 * `electron/tts-number-rules.ts` or `electron/prompts/tts-number-normalize.txt`
 * changes. A `.n1.` copy on disk is a claim about what this pass does, and
 * reusing one after the pass changed would narrate yesterday's rules.
 *
 * n1 → n2 (2026-09-02): the deterministic pre-pass, and the prompt that tells
 * the model it already ran.
 * n2 → n3 (2026-09-02, after the live n2 run): bare references continuing a
 * book-anchored list are scripture; NUMBER_DROPPED; the prompt's rule for a
 * number the passage prints twice.
 * n3 → n4 (2026-09-03, after the Mac's live run): the clock rule ("2:00 p.m."
 * had read "two oh two p.m."); the prompt's rule for an abbreviated range.
 * n4 → n5 (2026-09-04, the shared-normalization handoff): a PUNCTUATION stage
 * now runs ahead of these rules (`electron/tts-punctuation.ts`, spec s1 — the
 * canonical ellipsis, the quote map, the invisibles and the space variants), so
 * the text the rules and the model are handed is not the text an `.n4.` copy was
 * made from; plus the two rule defects the orpheus-finetune side reported —
 * an archive sigil in front of a bare integer is citation apparatus
 * (`isArchiveSigil`), and a chapter-crossing scripture range no longer orphans
 * its second colon (`SCRIPTURE_REF`).
 *
 * n5 → n6 (2026-09-05, Owen's scripture ruling): the deterministic scripture
 * READING is gone. A reference is now DETECTED and protected
 * (`scriptureSpans`), the model reads it in the form Owen settled the same day
 * ("First Peter three, seven"), and the validator's `keepsEveryWord` invariant
 * is relaxed to the one-token law inside a detected span so an abbreviation may
 * become a name. Every book-anchored reference in a book reads differently than
 * it did under n5, and a bare `c:v` reads exactly as it did.
 *
 * A BUMP HERE IS A CROSS-REPO EVENT. These rules are vendored byte-for-byte into
 * orpheus-finetune's `pipeline/normalization/vendor/` and drift-checked on every
 * training build — see docs/NARRATION_TEXT_PASS.md.
 */
export const NORMALIZER_VERSION = 'n6';

/**
 * The model this pass uses when the setting is absent.
 *
 * A DECLARED DEFAULT, not a fallback: `ttsNumberNormalizerModel` is a preference
 * with no correct "missing" value, and every install that has never opened
 * Settings has it missing. That is different in kind from a required value that
 * went missing — the case the no-fallbacks rule is about — where substituting
 * anything hides the bug. Declared once, here, so the tag in a cache path, the
 * tag in an error message and the tag the request carries are one string.
 *
 * qwen3.5:9b-q8_0 (10 GB) is the Q8 build of the model Owen pulled on 2026-09-02
 * — the Q4_K_M used 9 GB of a 24 GB card, so Owen moved it up one step
 * ("it can probably go up one step"); qwen3.8:27b is the heavier
 * option and is set by typing it into Settings, not by editing this line.
 */
export const DEFAULT_NORMALIZER_MODEL = 'qwen3.5:9b-q8_0';

/** How much of the model's answer to keep in the record when it will not parse. */
const RAW_ANSWER_EXCERPT = 600;

/**
 * The share of selected units that may end in a parse failure before the model
 * is declared broken and the job fails.
 *
 * A model that cannot emit the JSON it was asked for is not "a few hard
 * paragraphs" — it is the wrong model, or a model answering in a shape this
 * prompt does not produce, and letting the book through would silently narrate
 * every number as digits while the log said a normalization ran.
 */
const MAX_PARSE_FAIL_SHARE = 0.10;

// ─────────────────────────────────────────────────────────────────────────────
// The dispositions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What happened to one proposed edit.
 *
 * Read `applyEditList` in ai-cleanup-prepass.ts for the SHAPE of this — every
 * outcome recorded, a rejection meaning the original text stands — but NOT for
 * the rules. That applier's guards are the exact inverse of these: it blocks a
 * find that carries digits and no letters (`NUMERIC_EDIT_BLOCKED`), blocks a
 * digit whose value changes (`DIGIT_MUTATION_BLOCKED`), and blocks an edit whose
 * replacement drifts from its find (`DRIFT_BLOCKED`). All three describe exactly
 * what this pass exists to do. Sharing an applier would have meant loosening
 * that one, which guards the OCR repair pass against a model rewriting numbers.
 */
export type NumberEditStatus =
  /** Empty find, or find identical to replace: nothing was proposed. */
  | 'NOOP'
  /** `find` is not a verbatim substring of the target. No fuzzy ladder here. */
  | 'NOT_FOUND'
  /** `find` occurs more than once: which one was meant is not knowable. */
  | 'AMBIGUOUS_FIND'
  /** `find` carries no digit, so it is not a number edit. */
  | 'NO_DIGIT_IN_FIND'
  /** `replace` still carries a digit: the conversion did not happen. */
  | 'DIGIT_IN_REPLACE'
  /** `replace` is not plain spoken words. */
  | 'REPLACE_NOT_WORDS'
  /** `replace` narrates the NAME of a punctuation mark — "hyphen", "colon". */
  | 'PUNCTUATION_SPOKEN'
  /** A bare list marker "3." whose replacement dropped the period. */
  | 'LIST_MARKER_PERIOD'
  /** A letter-bearing word of `find` is missing from `replace`, or out of order. */
  | 'WORDS_DROPPED'
  /** `find` has more groups of digits than `replace` has number words: a number was lost. */
  | 'NUMBER_DROPPED'
  /** A detected scripture reference came back half-read — see `scriptureReadingRefusal`. */
  | 'SCRIPTURE_UNREAD'
  /**
   * NOT A VERDICT ON AN EDIT — a note that the rules found a scripture reference
   * here and protected it, so the model was asked and no rule was allowed to
   * read it. It is what lets the receipt say why a block still held digits.
   */
  | 'SCRIPTURE_PROTECTED'
  /** The span sits in citation apparatus and is unspeakable in any form. */
  | 'CITATION_CODE'
  /** The span crosses a text-node boundary — an `<em>`, a `<sup>`, a link. */
  | 'SPANS_MARKUP'
  /** The span overlaps one already accepted for this target, rule or model. */
  | 'OVERLAPS_APPLIED'
  /** `replace` is empty or blank: a deletion, which only the marker class may be. */
  | 'EMPTY_REPLACE'
  /** `find` is longer than one span whose reading differs — a clause, or a paraphrase. */
  | 'EDIT_TOO_LONG'
  /** `replace` is far longer than what it replaces: an expansion nothing justifies. */
  | 'REPLACE_TOO_LONG'
  /** This block proposed more edits than a block of spoken-form fixes can have. */
  | 'TOO_MANY_EDITS'
  /** The block's non-number edits together would rewrite too much of it. */
  | 'BLOCK_BUDGET'
  /**
   * The replacement is not a READING of the token it changed.
   *
   * The model decides WHETHER a token is read differently than it is printed;
   * `electron/tts-spoken-forms.ts` decides what it may become. An abbreviation
   * this build has no reading for is refused here BY NAME, so the tokens real
   * books print arrive as a review list and the table grows on purpose.
   */
  | 'NOT_A_READING'
  /** The span is not one of the classes this pass asks about — it is prose. */
  | 'NOT_A_CLASS'
  /** The reading invents words the find does not account for. */
  | 'WORDS_ADDED'
  /** The heading and its contents entry could not take the SAME edit. */
  | 'TOC_MISMATCH'
  /** A deterministic rule read it, before the model was asked anything. */
  | 'APPLIED_RULE'
  | 'APPLIED';

/**
 * WHICH KIND OF READING an edit is about.
 *
 * Derived from the `find` rather than declared by the model — a model that names
 * its own class would be trusted about the one thing the record exists to check.
 * The receipt tallies by class, which is how "the model made 400 all-caps edits
 * on this book" becomes a thing anyone can see.
 */
export type NumberEditClass =
  /** The find prints a digit. Every number invariant applies to it. */
  | 'number'
  /** An abbreviation with a period — "Dr.", "e.g.", "St." */
  | 'abbreviation'
  /** A run of capitals — an acronym said as letters, or emphasis. */
  | 'all-caps'
  /** A parenthesis or bracket: apparatus a narrator does not read. */
  | 'bracketed'
  /** A hyphen used as a dash, with spaces around it. */
  | 'spaced-hyphen'
  /** An ampersand, which a narrator says as the word. */
  | 'ampersand'
  /** A roman numeral naming a person or a part. */
  | 'roman'
  /** Anything else. The class the receipt watches hardest. */
  | 'other';

/** A roman-numeral token of two or more characters, as a whole word. */
const ROMAN_WORD = /(?:^|\s)[IVXLCDM]{2,}(?:$|[\s,.;:)\]])/;

/**
 * A WHOLE bracketed insertion, with whatever spacing stands around it —
 * " (see p. 12)", "[sic]".
 *
 * This exact shape is the only one a REMOVAL is allowed for: apparatus a
 * narrator does not read. A find that merely CONTAINS a bracket ("cost (1934)
 * and") is not this, and removing it would take prose with it.
 */
const WHOLE_BRACKET = /^\s*[([][^()[\]]*[)\]]\s*$/;

/** Is this span a bracketed insertion and nothing else? */
export function isWholeBracketedInsertion(find: string): boolean {
  return WHOLE_BRACKET.test(find);
}

/**
 * Which class this edit is about, from the span it names.
 *
 * FOR THE RECEIPT, not for the enforcement. What invariants an edit has to
 * satisfy is decided by two explicit questions in `validateNumberEdits` — does
 * the find print a digit, and is this a bracketed removal — because a bracketed
 * span with a page number in it is both a bracket and a number, and the two
 * questions have different answers.
 */
export function classifyEdit(find: string): NumberEditClass {
  if (isWholeBracketedInsertion(find)) return 'bracketed';
  if (DIGIT.test(find)) return 'number';
  if (/[()[\]]/.test(find)) return 'bracketed';
  if (ROMAN_WORD.test(find)) return 'roman';
  if (find.includes('&')) return 'ampersand';
  if (/\s-\s/.test(find)) return 'spaced-hyphen';
  // ANCHORED TO A WHOLE TOKEN. Unanchored, this matched any span containing a
  // word followed by a period — so "He did not believe it." classified as an
  // abbreviation edit and the one-token law let the sentence be extended (the
  // second adversarial review, 2026-09-04). An abbreviation is a token that ENDS
  // in a period, or one built of single letters and periods ("e.g.", "a.m.").
  if (hasAbbreviationToken(find)) return 'abbreviation';
  // A run of capitals as a WHOLE word. The word boundaries matter: without
  // them a lower-case span with two adjacent capitals anywhere in it reads as an
  // acronym edit.
  if (/(?<![A-Za-z])[A-Z]{2,}(?![A-Za-z])/.test(find)) return 'all-caps';
  return 'other';
}

/** One proposed edit and what became of it. */
export interface NumberEditRecord {
  find: string;
  replace: string;
  status: NumberEditStatus;
  /**
   * Which reading this edit is about. Absent on records written before the pass
   * asked about anything but numbers.
   */
  editClass?: NumberEditClass;
  /** Why, when the status alone does not say it (the oracle's own reading, etc.). */
  detail?: string;
}

/** What became of one target the model was asked about. */
export type NumberUnitStatus =
  /** The model answered and the answer parsed (it may still have been empty). */
  | 'ANSWERED'
  /**
   * The deterministic rules left no digit behind, so the model was never asked.
   * The cheapest possible outcome, and the one the pre-pass exists to produce.
   */
  | 'RULES_ONLY'
  /** The answer would not parse, twice. The digits stand. */
  | 'UNIT_PARSE_FAIL'
  /** The edits came from a heading this entry repeats, not from a model call. */
  | 'SHARED_WITH_HEADING';

/** The record for one target: the review trail, and what makes this reversible. */
export interface NumberUnitRecord {
  key: string;
  /**
   * Where in the input this unit came from. A book's kinds are the EPUB target
   * kinds; `text-block` is a paragraph of a plain-text input, which has no
   * element, no contents entry and no title to be.
   */
  kind: NarrationNumberTarget['kind'] | 'text-block';
  /** The zip entry, or the text file's own name. */
  file: string;
  status: NumberUnitStatus;
  /**
   * The target's own text, BEFORE any edit — rule or model.
   *
   * Not the string the model was shown, which is this with the rules already
   * applied: a reviewer needs the printed original to judge every edit against,
   * and every `find` below is a substring of it (a model edit that reached into
   * a rule's span was refused, so what survives is verbatim in both).
   */
  text: string;
  edits: NumberEditRecord[];
  /** The head of the raw answer, when it would not parse. Diagnosis only. */
  rawAnswer?: string;
}

/** The whole pass, as a file beside the copy it produced. */
export interface NumberNormalizationRecord {
  normalizerVersion: string;
  model: string;
  source: string;
  inputSha16: string;
  generatedAt: string;
  targetsTotal: number;
  targetsSelected: number;
  /** How many of the selected spans still had a digit after the rules ran. */
  targetsAsked: number;
  unitsParseFailed: number;
  appliedSpans: number;
  /** Of `appliedSpans`, how many a deterministic rule read. */
  appliedByRules: number;
  /**
   * How many scripture references the rules DETECTED and protected across the
   * book — the spans no rule was allowed to read and the model was asked about.
   *
   * Reported because it is the number that says whether this book has scripture
   * in it at all, which is the first thing to know when a reference comes out
   * wrong: a zero here means the detector never saw it, and a large number with
   * few APPLIED means the model is declining them.
   */
  scriptureReferences: number;
  /** And how many the model read. The two sum to `appliedSpans`. */
  appliedByModel: number;
  dispositions: Record<string, number>;
  /**
   * How many edits of each class were APPLIED — 'number', 'abbreviation',
   * 'all-caps', 'bracketed', 'spaced-hyphen', 'roman', 'other'.
   *
   * Separate from `dispositions`, which counts verdicts: this counts what the
   * pass actually DID to the book, by kind of reading, which is the number a
   * reviewer looks at first when the pass is allowed to change more than digits.
   */
  appliedByClass: Record<string, number>;
  units: NumberUnitRecord[];
}

/** What the pass returns to the door that called it. */
export interface NumberNormalizationOutcome {
  /** The narration copy the job must use from here on. */
  epubPath: string;
  /** The record beside it. */
  recordPath: string;
  /** True when this run reused a copy already on disk (no model call was made). */
  reused: boolean;
  record: NumberNormalizationRecord;
}

/** The same, for a plain-text input. */
export interface TextNormalizationOutcome {
  /** The normalized text file the render must read from here on. */
  textPath: string;
  /** The record beside it — the same shape a book's pass writes. */
  recordPath: string;
  /** True when this run reused a copy already on disk (no model call was made). */
  reused: boolean;
  record: NumberNormalizationRecord;
}

// ─────────────────────────────────────────────────────────────────────────────
// Selection — deterministic, cheap, and the only thing that reaches the model
// ─────────────────────────────────────────────────────────────────────────────

/** Anything with an Arabic digit in it. The whole selection rule. */
const DIGIT = /[0-9]/;

/**
 * Which of a book's targets go to the model.
 *
 * Every text with a digit in it, and nothing else. Owen, 2026-09-02: *"it should
 * pass every block through that might need it — not every block, just the
 * problematic ones — including chapter names/spines/etc."*
 *
 * HEADINGS ARE IN. They were excluded in the first draft of this pass on the
 * theory that an m4b chapter title must stay book-exact — but a chapter title is
 * read out loud too, e2a expands a bare digit in one at the engine anyway, and
 * the exclusion only meant the heading and its contents entry could disagree.
 * Owen accepts that the m4b's chapter names and the transcript carry the spoken
 * form, which is the price of them being one string.
 *
 * CAPTIONS AND FOOTNOTES ARE OUT, and not because of anything here: the cut
 * (`narrationInputFor`) already removed them from the file this pass is given.
 * They are skipped by category anyway, for the book with no stamps that reaches
 * this pass uncut — narrating a caption is a decision the cut owns, and this
 * pass must not make a caption speakable that the cut would have removed.
 */
export function selectNumberTargets(
  targets: readonly NarrationNumberTarget[],
  /**
   * WHICH TARGETS GO TO THE MODEL.
   *
   * 'digit-bearing' is the rule this pass had until 2026-09-04: a digit test,
   * and nothing else. 'every-block' is Owen's ruling of that day — *"send every
   * single block through to be sure. I suspect deterministic decisions on this
   * aren't the right way to do it. Let the model decide what should be
   * updated."* — because the classes the pass now asks about (an abbreviation,
   * an acronym, a bracketed aside, a spaced hyphen, a roman numeral) print no
   * digit at all, so a digit test would never show the model one of them.
   *
   * THE CAPTION AND FOOTNOTE EXCLUSION HOLDS EITHER WAY. Narrating a caption is
   * a decision the cut owns (the narrationInputFor door removes them from the file a
   * render reads), and this pass must not make one speakable that the cut would
   * have removed.
   */
  ask: 'digit-bearing' | 'every-block' = 'digit-bearing',
): NarrationNumberTarget[] {
  return targets.filter((t) => {
    if (ask === 'digit-bearing' && !DIGIT.test(t.text)) return false;
    if (t.statedCategory === 'caption' || t.statedCategory === 'footnote') return false;
    // A code listing is not prose. Its digits are a program's, its spacing is
    // the author's, and a narrator reading "for i in range(ten)" is not an
    // improvement on one reading "range(10)". The punctuation stage refuses it
    // for the same reason (electron/narration-text-pass.ts).
    if (t.preformatted === true) return false;
    return true;
  });
}

/** Is this target a HEADING — the thing a contents entry repeats? */
export function isHeadingTarget(target: NarrationNumberTarget): boolean {
  if (/^h[1-6]$/.test(target.tag)) return true;
  // foundry's three heading levels, as its converter stamps them.
  return target.statedCategory === 'title'
    || target.statedCategory === 'chapter'
    || target.statedCategory === 'section-header';
}

/** One line of text, for comparing a heading with the contents entry that names it. */
export function collapseForTocMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — the safety boundary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a spoken number may be made of, WHATEVER the book prints around it:
 * letters, spaces, and the punctuation a narrator's own transcript always
 * carries.
 *
 * The book's own punctuation is added to this per-edit (see `spokenWords`): the
 * guard is against a digit, a currency sign and markup, never against a dash the
 * book itself printed. It was the latter that refused
 * "one. Halloween—October thirty-first" on the 2026-09-02 run, five times, for
 * carrying the em dash it was handed.
 */
const SPOKEN_BASE = /[A-Za-zÀ-ÿ\s'’,.-]/;

/**
 * The characters no reading may contain no matter what the book printed.
 *
 * A digit means the conversion did not happen; a currency or percent sign means
 * it half happened; a slash, an angle bracket or a brace means markup or a
 * citation code got into the replacement.
 */
const NEVER_SPOKEN = /[0-9$£€¢%#/\\<>{}|@*_~^+=]/;

/**
 * The names of punctuation marks, which a narrator says out loud only when the
 * model has confused describing the text for reading it.
 *
 * Measured on the 2026-09-02 run: FORTY applied edits contained the literal word
 * "hyphen" or "colon" — "Deuteronomy seven twenty-five hyphen twenty-six",
 * "Exodus twenty-two colon eighteen". Counted rather than merely detected, so a
 * book that legitimately discusses a hyphen keeps saying so; what is refused is
 * a replacement that says it MORE often than the text it replaces.
 */
const PUNCTUATION_NAMES = /\b(?:hyphen|colon|dash|slash)e?s?\b/gi;

/** How many times a replacement names a punctuation mark. */
function punctuationNameCount(text: string): number {
  return (text.match(PUNCTUATION_NAMES) ?? []).length;
}

/**
 * Is `replace` plain spoken words for THIS find?
 *
 * Letters, whitespace and everyday narration punctuation always; plus any
 * character the `find` itself carried — an em dash, a parenthesis, a quote, a
 * semicolon — because refusing the book's own punctuation refuses correct
 * readings. Never a digit, a currency sign or markup, whatever the find held.
 */
function spokenWords(find: string, replace: string, extra = ''): boolean {
  if (NEVER_SPOKEN.test(replace)) return false;
  const fromFind = new Set([...find, ...extra]);
  return [...replace].every((ch) => SPOKEN_BASE.test(ch) || fromFind.has(ch));
}

/**
 * THE HYPHEN-TO-EM-DASH ALLOWANCE, and the only character this pass may invent.
 *
 * A spaced hyphen used as a dash — "the man - who had waited - left" — is an em
 * dash in disguise, and reading it as one is a class the prompt asks about. But
 * `SPOKEN_BASE` holds no U+2014 and `spokenWords` otherwise admits only what the
 * find already carried, so EVERY edit of that class was rejected
 * REPLACE_NOT_WORDS. Found by the adversarial review of 2026-09-04 by running
 * the prompt's own worked example through this validator.
 *
 * Scoped as narrowly as the defect: only when text edits are allowed at all, and
 * only when the find actually printed a hyphen for the dash to have come from.
 * A number edit can still never invent one.
 */
const HYPHEN_DASH_ALLOWANCE = '\u2014';

/** A bare list marker — "1.", "12." — where the period is part of the reading. */
const LIST_MARKER = /^\d{1,3}\.$/;

/**
 * The WORDS of a span, with a dotted abbreviation counted as ONE word.
 *
 * Split on letters rather than on whitespace, so "waited—and" is two words and
 * "e.g." is one. That distinction is the whole of the one-token law below: a
 * class-5 edit changes punctuation between two words and must keep both, while a
 * class-2 edit replaces one dotted token and must keep everything else.
 */
const WORD_TOKEN = /[A-Za-zÀ-ÿ]+(?:\.[A-Za-zÀ-ÿ]+)*\.?/g;

/** The raw word tokens of a span, in order. */
function wordTokens(text: string): string[] {
  return text.match(WORD_TOKEN) ?? [];
}

/** How two word tokens are compared: case and interior periods do not count. */
const wordKey = (token: string): string => token.toLowerCase().replace(/\./g, '');

/**
 * THE PUNCTUATION A READING MAY NOT MOVE.
 *
 * Owen's ruling of 2026-09-04: the replacement must carry every punctuation
 * character of the find that sits OUTSIDE the token it changes, in order. The
 * law had compared words and counted them, so a reading could drop a semicolon
 * and fuse two sentences — "Dr. Kempner; they" became "Doctor Kempner they" in
 * a real working copy.
 */
const READING_PUNCTUATION = /[.,;:!?"'()—-]/g;

/** The punctuation of a span, in order, as one string. */
function punctuationOf(text: string): string {
  return (text.match(READING_PUNCTUATION) ?? []).join('');
}

/**
 * The find's punctuation with the changed token's own removed.
 *
 * The token's periods are ITS OWN — "Dr." is read "Doctor" and the period goes
 * with it — so they are not part of what must survive. Everything else is.
 */
function punctuationOutsideToken(
  find: string, droppedIndex: number, keepFinalPeriod: boolean,
): string {
  const spans = wordTokenSpans(find);
  const token = droppedIndex >= 0 && droppedIndex < spans.length ? spans[droppedIndex] : undefined;
  if (token === undefined) return punctuationOf(find);
  // When the sentence rule applies, that final period is the SENTENCE'S and not
  // the abbreviation's — "Oxford St. The rain" has to come out "Oxford Street."
  // — so it counts as punctuation the reading must carry.
  const cut = keepFinalPeriod && token.token.endsWith('.')
    ? token.token.slice(0, -1)
    : token.token;
  return punctuationOf(find.slice(0, token.at) + find.slice(token.at + cut.length));
}

/** Where the nth word token of a span begins. */
function tokenOffsetIn(find: string, droppedIndex: number): number {
  const spans = wordTokenSpans(find);
  const token = droppedIndex >= 0 && droppedIndex < spans.length ? spans[droppedIndex] : undefined;
  return token === undefined ? 0 : token.at;
}

/**
 * Could the period ending this token be the end of a SENTENCE?
 *
 * The block after it: nothing at all, or a capital, a quote or a bracket. That
 * is the shape "Oxford St. The rain" has, and reading it "Oxford Street The
 * rain" fused two sentences in the user's own book.
 */
function couldEndSentence(after: string): boolean {
  const next = after.replace(/^[\s ]+/, '');
  return next === '' || /^["'“‘([]/.test(next) || /^[A-ZÀ-Þ]/.test(next);
}

/**
 * An ampersand read as the word it stands for, and nothing else.
 *
 * The prompt has always taught `"&" is "and"` and `classifyEdit` had no class for
 * it, so every such edit was refused NOT_A_CLASS — the same
 * prompt-teaches-what-the-wall-refuses drift the second review found, missed
 * because the keeper ran only the WORKED examples and not the prompt's own
 * quoted pairs (the fourth adversarial review, 2026-09-04).
 */
function ampersandToAnd(text: string): string {
  return text.replace(/&/g, 'and');
}

/**
 * Every reading this span's ampersand may have.
 *
 * A GLUED one ("AT&T") is a single token whose sides are read as class-3 tokens
 * and joined by " and "; a SPACED one ("Smith & Co") is the word in place of the
 * sign. The two are different shapes and the glued one is checked first, because
 * the bare replace that served both read "AT&T" as "ATandT" and wrote it into a
 * book (the fifth adversarial review, 2026-09-04).
 */
function ampersandReadings(find: string): string[] {
  return hasGluedAmpersand(find) ? gluedAmpersandReadings(find) : [ampersandToAnd(find)];
}

/** A spaced hyphen read as the em dash it stands in for, and nothing else. */
function hyphenToDash(text: string): string {
  return text.includes(' - ') || /[ \t]-[ \t]/.test(text)
    ? text.replace(/[ \t]+-[ \t]+/g, HYPHEN_DASH_ALLOWANCE)
    : text;
}

/** A bracketed span with its brackets dropped and everything else kept. */
function droppedBrackets(text: string): string {
  const open = text.indexOf('[') >= 0 ? '[' : '(';
  const close = open === '[' ? ']' : ')';
  const first = text.indexOf(open);
  const last = text.lastIndexOf(close);
  if (first < 0 || last < first) return text;
  return text.slice(0, first) + text.slice(first + 1, last) + text.slice(last + 1);
}

/** Is this pair of tokens the same word, differing only in case? */
function isEmphasisRecase(pair: { was: string; now: string }): boolean {
  // Only a run of capitals is read in ordinary case, the reading is EXACTLY
  // lower case, and the run has to be a WORD rather than an initialism — the
  // same test `capsReadingRefusal` applies, because this path reaches the book
  // without going through it and "The US Army" -> "The us Army" did (the fourth
  // adversarial review, 2026-09-04).
  const bare = pair.was.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (!/^[A-ZÀ-Þ]{2,}$/.test(bare)) return false;
  if (pair.now !== pair.was.toLowerCase()) return false;
  return isEmphasisWord(bare);
}

/**
 * Which table judges the token that changed, and what it says.
 *
 * ── The order is Owen's ruling of 2026-09-04 ────────────────────────────────
 *
 * THE LETTERS READING IS NEVER FORBIDDEN. MD, CD, DC, MC, CV, MM, XL, DI, LI,
 * IX, CIV and MIX are all legal roman numerals AND ordinary acronyms, and when
 * the numeral won by default "MIX" could only be read "one thousand nine" while
 * "M I X" was refused. So a run of capitals is offered the caps reading first,
 * and the numeral reading only where a book actually prints a numeral: after a
 * part word, after a capitalized name, or before a century.
 */
function readingRefusal(
  token: string, reading: readonly string[], before: string, after: string,
): ReadingRefusal {
  if (isAbbreviationToken(token)) {
    const context = abbreviationContextRefusal(token, before, after);
    if (context !== null) return context;
    return abbreviationReadingRefusal(token, reading);
  }
  const caps = capsReadingRefusal(token, reading);
  if (caps === null) return null;
  if (romanValue(token) !== null && isRomanContext(before, after)) {
    const value = romanValue(token)!;
    return romanReadingRefusal(token, reading, {
      cardinal: cardinalWords(value),
      ordinal: ordinalToWords(value),
    });
  }
  return caps;
}

/**
 * Is `reading` an allowed reading of the ABBREVIATION token `token`?
 *
 * From the table, and from nowhere else — an unknown one is REFUSED and named,
 * so it can be reviewed and added on purpose. The CASE has to be one the table
 * wrote: as written, all lower, or capitalized on the first letter only. "at
 * SAINT Petersburg" was applied and written into a book before this checked it.
 */
function abbreviationReadingRefusal(token: string, reading: readonly string[]): ReadingRefusal {
  const entry = ABBREVIATION_READINGS.get(abbreviationKey(token));
  if (entry === undefined) {
    return `"${token}" is not an abbreviation this build has a reading for. Unknown `
      + 'abbreviations are left exactly as printed and listed for review, never guessed';
  }
  // The sentence's period, when the reading carries one, is not part of the word
  // the table knows: "Street." is "Street" wearing the end of a sentence.
  const said = reading.join(' ').replace(/\.$/, '');
  const forms = new Set<string>();
  for (const form of entry.readings) {
    forms.add(form);
    forms.add(form.toLowerCase());
    forms.add(form.charAt(0).toUpperCase() + form.slice(1).toLowerCase());
  }
  if (forms.has(said)) return null;
  const wrongCase = [...forms].some((f) => f.toLowerCase() === said.toLowerCase());
  return wrongCase
    ? `"${said}" reads "${token}" correctly but in a case this build does not write — it is `
      + `${entry.readings.map((r) => `"${r}"`).join(' or ')}`
    : `"${said}" is not a reading of "${token}" — this build reads it `
      + `${entry.readings.map((r) => `"${r}"`).join(' or ')}`;
}
/**
 * The word tokens of `find` that do not appear, IN ORDER, in `replace`.
 *
 * Greedy and left to right, the same shape as `keepsEveryWord`'s subsequence
 * walk, but it reports WHICH words went missing rather than only whether any
 * did — because the one-token law has to know whether the one that went is the
 * one the class was allowed to change.
 */
function droppedWords(find: string, replace: string): string[] {
  return alignWords(find, replace).dropped;
}

/** "e.g.", "a.m." — single letters joined by periods, which are always one. */
const DOTTED_LETTERS = /^(?:[A-Za-zÀ-ÿ]\.)+$/;

/**
 * Is this word token SHAPED like an abbreviation?
 *
 * Used to pick which reading table judges a token that changed. It is a shape
 * test and nothing more: "it." passes it, and the abbreviation table then
 * refuses "it." by name, which is the right answer for a model that tried to
 * read the last word of a sentence.
 */
function isAbbreviationToken(token: string): boolean {
  return token.endsWith('.') || DOTTED_LETTERS.test(token);
}

/**
 * Does this span hold an abbreviation, for the purpose of CLASSIFYING it?
 *
 * The position matters, and this is where the second adversarial review's
 * finding lands: a period at the END of a span is a sentence, not an
 * abbreviation, so "He did not believe it." is prose. A period anywhere else in
 * the span is an abbreviation — nothing else puts one mid-sentence — and a
 * span-final token is one only when the table already knows it, which is the
 * same "never guessed" rule the readings follow.
 */
function hasAbbreviationToken(find: string): boolean {
  const tokens = wordTokens(find);
  if (tokens.length === 0) return false;
  if (tokens.slice(0, -1).some(isAbbreviationToken)) return true;
  const last = tokens[tokens.length - 1]!;
  if (DOTTED_LETTERS.test(last)) return true;
  return last.endsWith('.')
    && ABBREVIATION_READINGS.has(last.toLowerCase().replace(/[^a-zà-ÿ]/g, ''));
}

/** What the alignment of a find against its replacement found. */
interface WordAlignment {
  /** Find tokens with no match in the replacement, in order. */
  dropped: string[];
  /** Which WORD of the find the single dropped token was, or -1. */
  droppedIndex: number;
  /** The replacement's words that stand where the single dropped token was. */
  reading: string[];
  /** Replacement words that are neither a matched find word nor that reading. */
  inserted: number;
  /**
   * Matched words whose CASE changed.
   *
   * A word that matched by key and differs by case is still a change to the
   * book, and nothing was checking it: "the FBI had" -> "The f b i had" was
   * applied and written verbatim (the third adversarial review, 2026-09-04).
   */
  recased: Array<{ was: string; now: string }>;
}

/** Every word token of a span with the offset it begins at. */
function wordTokenSpans(text: string): Array<{ token: string; at: number }> {
  const out: Array<{ token: string; at: number }> = [];
  WORD_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_TOKEN.exec(text)) !== null) out.push({ token: m[0], at: m.index });
  return out;
}

/**
 * Line the find's words up against the replacement's, and say exactly what
 * happened to each.
 *
 * ── Why an alignment and not a subsequence test ─────────────────────────────
 *
 * The one-token law bounded DELETION and SUBSTITUTION and not INSERTION: a
 * subsequence check is satisfied by a replacement that keeps every word and adds
 * a sentence after them. The second adversarial review of 2026-09-04 measured
 * both halves of that hole —
 *
 *   "He did not believe it." -> "He did not believe it. He had never believed
 *                               it, and he said so."          APPLIED
 *   "Dr. Kempner was convinced" -> "Dr. Kempner was not convinced"   APPLIED
 *
 * — so the alignment counts what was ADDED as well as what went missing, and it
 * also hands back the words that stand where the dropped token was, which is
 * what `electron/tts-spoken-forms.ts` needs to say whether they are a READING of
 * it.
 */
function alignWords(find: string, replace: string): WordAlignment {
  const wanted = wordTokens(find);
  const got = wordTokens(replace);
  const gotKeys = got.map(wordKey);
  const dropped: string[] = [];
  /** Where in `got` each matched find token landed. */
  const matchedAt: number[] = [];
  const recased: Array<{ was: string; now: string }> = [];
  let droppedIndex = -1;
  let wordIndex = -1;
  let at = 0;
  for (const token of wanted) {
    wordIndex++;
    const found = gotKeys.indexOf(wordKey(token), at);
    if (found < 0) {
      if (dropped.length === 0) droppedIndex = wordIndex;
      dropped.push(token);
      continue;
    }
    const landed = got[found]!;
    if (landed !== token) recased.push({ was: token, now: landed });
    matchedAt.push(found);
    at = found + 1;
  }
  // The window the single dropped token's reading occupies: everything in the
  // replacement between the matched word before it and the matched word after.
  let reading: string[] = [];
  if (dropped.length === 1) {
    const before = droppedIndex > 0 ? matchedAt[droppedIndex - 1]! : -1;
    const after = droppedIndex < matchedAt.length ? matchedAt[droppedIndex]! : got.length;
    reading = got.slice(before + 1, after);
  }
  return {
    dropped, droppedIndex, reading, recased,
    inserted: got.length - matchedAt.length - reading.length,
  };
}

/**
 * Is this word token the one its CLASS is allowed to change?
 *
 * The pending ruling of 2026-09-04, implemented as the default: for a non-number
 * class the replacement must preserve every alphabetic word of the find in
 * order EXCEPT the single token the class is about — a dotted abbreviation, a
 * run of capitals, a roman numeral. One-token edits only.
 *
 * A word that is none of those is prose, and prose is not this pass's to
 * rewrite: "tarmac" → "terrace" is an OCR correction, "cheered" → "jeered" is an
 * invention, and both were APPLIED before this law existed (measured by the
 * adversarial review of 2026-09-04, cases A5 and A6).
 */
function isClassToken(token: string): boolean {
  if (token.includes('.')) return true;                       // Dr. · e.g. · St.
  const bare = token.replace(/\./g, '');
  if (/^[IVXLCDM]{2,}$/.test(bare)) return true;              // VIII · XIV
  return /^[A-Z]{2,}$/.test(bare);                            // FBI · NSDAP
}

/**
 * How many alphabetic words a BRACKETED insertion may hold and still be
 * removable as apparatus.
 *
 * "[sic]" is one, "(emphasis added)" is two, "(see page twelve)" is three. Four
 * is "(the guarantee would hold)" — a clause of the author's prose, which the
 * shape test alone happily deleted (the adversarial review's case A4). Three is
 * the last count at which every measured apparatus insertion still fits and no
 * measured clause does.
 */
const MAX_BRACKET_WORDS = 3;

/**
 * How many words a number's reading may add beyond the find's own.
 *
 * `keepsEveryWord` proves nothing is LOST; nothing proved nothing was GAINED,
 * so "The 12 men who refused were shot" → "The twelve men who refused were
 * spared, and the men who shot" passed every number invariant and inverted the
 * sentence (the adversarial review, 2026-09-04). The reading may hold the find's
 * own words, plus the number words the conversion produces, plus this much slack
 * for the joins a reading legitimately needs — "to" in a range, "and" in
 * "five dollars and fifty cents", "point" in a decimal.
 */
const NUMBER_WORD_SLACK = 3;

/**
 * The words a number is made of when spoken. Hyphenated compounds are split
 * before the count, so "eighty-five" is two of them.
 */
const NUMBER_WORDS = new Set([
  'zero', 'oh', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'billion', 'trillion',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
  'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
  'eighteenth', 'nineteenth', 'twentieth', 'thirtieth', 'fortieth', 'fiftieth', 'sixtieth',
  'seventieth', 'eightieth', 'ninetieth', 'hundredth', 'thousandth',
  'twenties', 'thirties', 'forties', 'fifties', 'sixties', 'seventies', 'eighties', 'nineties',
  'hundreds',
]);

/** How many number words `text` speaks. */
function numberWordCount(text: string): number {
  return text.toLowerCase().split(/[\s-]+/).map((t) => bareWord(t))
    .filter((t) => NUMBER_WORDS.has(t)).length;
}

/**
 * The separate NUMBERS `text` prints.
 *
 * A COMMA-GROUPED NUMBER IS ONE NUMBER, and that is the whole of Ask 2c
 * (orpheus-finetune's NORMALIZATION_SPEC.md §F4, 2026-09-04). Counting bare runs
 * of digits made "5,000" two of them, so `fewestNumberWords` demanded three
 * number words and refused "five thousand copies" — a correct reading — with
 * NUMBER_DROPPED. Measured on tr_dn3: it also refused "18,000-strong" →
 * *eighteen thousand strong* and "20-30,000" → *twenty to thirty thousand*, and
 * both rows still print their digits in the served corpus.
 *
 * The floor itself is sound (it is what catches "20:6" → "twenty"); what it
 * could not see is that a comma is a separator INSIDE one number. Returned as
 * the DIGITS of each number, comma removed, so the length test below counts
 * digits and not characters.
 */
function digitRuns(text: string): string[] {
  return (text.match(/\d{1,3}(?:,\d{3})+|\d+/g) ?? []).map((run) => run.replace(/,/g, ''));
}

/** How many separate numbers `text` prints. */
function digitRunCount(text: string): number {
  return digitRuns(text).length;
}

/**
 * The fewest number words a reading of `text` can honestly contain.
 *
 * A run of one or two digits is at least one word ("six", "fifteen", "twenty").
 * A run of three or more is at least TWO — "one hundred", "nineteen eighty-five",
 * "two thousand", "zero zero one" — there is no single English number word for
 * any value from a hundred up. That second floor is what catches a year range
 * read by half: "1914-1918" → "nineteen fourteen" has two number words for two
 * runs, and only the per-run floor sees that it needed four.
 */
function fewestNumberWords(text: string): number {
  let needed = 0;
  for (const run of digitRuns(text)) needed += run.length >= 3 ? 2 : 1;
  return needed;
}

/**
 * Does `replace` still carry every prose word of `find`, in order?
 *
 * The words that must survive are the ones with a letter and no digit —
 * "February", "dollars", "million", "per", "cent". A word carrying a digit is
 * part of the number and is SUPPOSED to change; a word with no letter is
 * punctuation. Case-insensitive, and a subsequence rather than an exact list,
 * because the conversion legitimately inserts words between them.
 */
export function keepsEveryWord(find: string, replace: string): boolean {
  const required = find.split(/\s+/)
    .filter((t) => hasLetter(t) && !DIGIT.test(t))
    .map((t) => bareWord(t).toLowerCase())
    .filter((t) => t.length > 0);
  if (required.length === 0) return true;
  const got = replace.split(/\s+/).map((t) => bareWord(t).toLowerCase());
  let at = 0;
  for (const want of required) {
    const found = got.indexOf(want, at);
    if (found < 0) return false;
    at = found + 1;
  }
  return true;
}

/**
 * The scripture form of `keepsEveryWord`: one prose word may CHANGE, and a word
 * must arrive where it went.
 *
 * Reading "1 Pet. 3:7" aloud means saying "Peter" where the page prints "Pet.",
 * so the strict subsequence test cannot apply; what applies instead is the same
 * one-token law the text classes are held to. Two things are proved:
 *
 *   AT MOST ONE prose word of the find is missing from the reading. "See Gen.
 *   1:1 and be glad" → "See one, one and be glad" loses two and is refused.
 *
 *   AND A WORD ARRIVED. The reading must carry a prose word that is neither one
 *   of the find's own nor a number word — the book NAME. Without this, dropping
 *   the abbreviation outright ("1 Pet. 3:7" → "First three, seven") would pass
 *   the first test, and the book would be gone from the narration.
 *
 * Every other number invariant still applies on top of this one; this is a
 * relaxation of ONE test over ONE class of span, not a licence.
 */
/**
 * Does this reading CLAIM to be a scripture reference?
 *
 * A canonical book name, or an ordinal volume word in front of a capitalized
 * word ("Second Corinthians") — the two things a reference's reading says that
 * no other reading of a `c:v` does. Used only to decide whether the
 * chapter-and-verse pause is required of a reading; never to decide a reading.
 */
function claimsToBeScripture(replace: string): boolean {
  const printed = replace.split(/[\s-]+/);
  const words = printed.map((w) => bareWord(w).toLowerCase());
  if (words.some((w) => CANONICAL_BOOK_NAMES.has(w))) return true;
  return words.some((w, i) =>
    ORDINAL_VOLUME_WORDS.has(w) && /^[A-Z]/.test(printed[i + 1] ?? ''));
}

/** The words a leading volume number is read as. */
const ORDINAL_VOLUME_WORDS: ReadonlySet<string> = new Set(['first', 'second', 'third']);

/** A volume numeral written in letters — the roman and ordinal forms. */
const ROMAN_VOLUME = /^(?:i{1,3}|1st|2nd|3rd)$/i;

/**
 * Could `word` be what `token` is an abbreviation OF?
 *
 * Longer, and carrying the token's letters in order. That is the whole of what
 * an English abbreviation is, contractions included, and it is checkable without
 * a dictionary of either books or words.
 */
function expandsToken(token: string, word: string): boolean {
  if (word.length <= token.length) return false;
  let at = 0;
  for (const letter of token) {
    at = word.indexOf(letter, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/**
 * The words a reference's READING is built out of, which are therefore not
 * evidence that a book name arrived.
 */
const READING_STRUCTURE: ReadonlySet<string> = new Set([
  'verse', 'verses', 'chapter', 'chapters', 'to', 'through', 'and', 'following',
]);

export function scriptureWordsSurvive(find: string, replace: string): boolean {
  const prose = (text: string): string[] => text.split(/\s+/)
    .filter((t) => hasLetter(t) && !DIGIT.test(t))
    .map((t) => bareWord(t).toLowerCase())
    .filter((t) => t.length > 0);

  const required = prose(find);
  // A ROMAN VOLUME NUMERAL IS A NUMBER, and the one-token allowance is for the
  // book NAME. "1 Pet." loses its "1" from `required` because the digit test
  // above drops it; "II Cor." has to lose its "II" for the same reason, or
  // reading it costs two words and every reading is WORDS_DROPPED — measured on
  // the adversarial review of 2026-09-05, which found "II Cor. 5:17" narrated as
  // digits because no edit the model could make was acceptable.
  if (required.length > 1 && ROMAN_VOLUME.test(required[0])) required.shift();
  const got = prose(replace);
  let missing = 0;
  let dropped: string | undefined;
  let at = 0;
  for (const want of required) {
    const found = got.indexOf(want, at);
    if (found < 0) { missing += 1; dropped = want; continue; }
    at = found + 1;
  }
  if (missing > 1) return false;
  if (missing === 0) return true;
  // A word went; the NAME IT WAS SHORT FOR has to have come. Not merely "some
  // new word": "1 Pet. 3:7" → "First three, verse seven" arrives with the book
  // gone and the structural word "verse" standing in for it, and an earlier cut
  // of this accepted it.
  //
  // So the arriving word must be longer than the token that went and must
  // contain that token's letters IN ORDER — which is what an abbreviation is.
  // That admits every contraction a publisher prints ("Jas." → James, "Phlm." →
  // Philemon, "Mk." → Mark, "Pss." → Psalms) and, because detection now admits
  // any dotted abbreviation, the ordinary words that are not scripture at all
  // ("Sec." → Section, "Ch." → Chapter, "Mr." → Mister). It refuses "chapter"
  // standing in for "Pet.".
  //
  // OR a canonical book name, for the one case an expansion is not a
  // lengthening: "Cant. 8:6" is read "Song of Songs", which is the book's other
  // NAME rather than the abbreviation's spelling-out.
  const fromFind = new Set(required);
  const gone = dropped;
  return got.some((word) => {
    if (fromFind.has(word) || NUMBER_WORDS.has(word)) return false;
    if (CANONICAL_BOOK_NAMES.has(word)) return true;
    return gone !== undefined && expandsToken(gone, word);
  });
}

/**
 * Is a reference READ, or only half-read? The refusal, or null.
 *
 * ── The residue this exists for ─────────────────────────────────────────────
 *
 * Measured by the orpheus-finetune session on the deathstalker corpus,
 * 2026-09-05: a row served as **"(Ps. sixty three six)"**. Something upstream
 * had spelled the digits out and left everything else — the abbreviation still
 * abbreviated, and the boundary between chapter and verse simply gone, so the
 * narrator says "sixty three six" as one number. Every invariant above passed
 * it: the digits were words, no word was dropped, no punctuation was named.
 *
 * Protect-then-model is what prevents that shape being produced; this is what
 * refuses it if the model produces it anyway. Three refusals:
 *
 *   THE ABBREVIATION SURVIVED. A token ending in a period, anywhere but at the
 *   very end of the reading, is "Ps." or "Cor." left as printed. (The last token
 *   may end in one: a reference at the end of a sentence keeps its period.)
 *
 *   THE BOUNDARY IS GONE — but only when the reading CLAIMS to be a reference.
 *   Owen's ear on the corpus clips, 2026-09-05: the narrator says either "First
 *   John one nine" (a PAUSE between the numbers, which in text is a comma) or
 *   "Romans five verse seventeen". Both are accepted; what is refused is
 *   neither, which is the "sixty three six" fusion. One separator per printed
 *   `chapter:verse`.
 *
 *   THE CLAIM TEST is what keeps this from refusing correct readings of things
 *   that are NOT scripture. Detection admits any abbreviation carrying its own
 *   period, so "Sec. 3:7" of a statute is a detected span, and its correct
 *   reading — "Section three seven" — has no pause in it and must pass. The
 *   first cut of this refused exactly that, and refused "Widescreen sixteen
 *   nine" as well, which is how the adversarial review of 2026-09-05 measured
 *   that a false-positive detection is not free. So the pause is demanded only
 *   of a reading that names a canonical book or an ordinal volume: "Psalm sixty
 *   three six" is claiming to be a reference and is refused; "Section three
 *   seven" claims nothing and is not.
 *
 *   THE WORD "CHAPTER" WAS SPOKEN. None of the measured readings says it, and
 *   Owen ruled it out by name: the pause is what says it.
 *
 * A REMAINING DIGIT is the fourth thing a half-read reference can do, and it is
 * not asked here: DIGIT_IN_REPLACE has already refused it, for every class.
 */
export function scriptureReadingRefusal(find: string, replace: string): string | null {
  // Only of a reading that is CLAIMING to be a reference — for the same reason
  // the pause is. "Ch. 3:7" of a manual is a detected span whose correct reading
  // is "Chapter three seven", and the word is the abbreviation's own expansion
  // there, not a narrator explaining a verse.
  if (/\bchapters?\b/i.test(replace) && claimsToBeScripture(replace)) {
    return 'a reference is never read with the word "chapter" — the pause says it';
  }
  const tokens = replace.trim().split(/\s+/);
  const abbreviation = tokens.slice(0, -1).find((token) => /^[A-Za-z]{1,6}\.$/.test(token));
  if (abbreviation !== undefined) {
    return `"${abbreviation}" is still abbreviated; a reference is read with the book's full name`;
  }
  const references = (find.match(/\d{1,3}\s*:\s*\d{1,3}/g) ?? []).length;
  if (references > 0 && claimsToBeScripture(replace)) {
    const separators = (replace.match(/,/g) ?? []).length
      + (replace.match(/\bverses?\b/gi) ?? []).length;
    if (separators < references) {
      return `${references} chapter-and-verse reference(s) need ${references} pause(s) between `
        + `chapter and verse — a comma or the word "verse"; the reading has ${separators}`;
    }
  }
  return null;
}

/**
 * Where `find` occurs in `target`, counting only occurrences a NUMBER could
 * mean.
 *
 * DIGIT-BOUNDED, and that is the whole point: a plain `indexOf` finds the "1."
 * of a list inside "11." and calls the edit ambiguous — which it did fifty times
 * on the 2026-09-02 run, throwing away every list marker in the book. A match
 * whose leading digit has a digit before it, or whose trailing digit has a digit
 * after it, is a match on the middle of some other number and is not an
 * occurrence of this one at all.
 */
export function digitBoundedOccurrences(target: string, find: string): number[] {
  const out: number[] = [];
  if (find === '') return out;
  for (let at = target.indexOf(find); at >= 0; at = target.indexOf(find, at + 1)) {
    if (DIGIT.test(find[0]) && at > 0 && DIGIT.test(target[at - 1])) continue;
    const end = at + find.length;
    if (DIGIT.test(find[find.length - 1]) && end < target.length && DIGIT.test(target[end])) continue;
    out.push(at);
  }
  return out;
}

/** One span the writer will splice, plus the record that says why. */
interface ValidatedEdits {
  accepted: NarrationTextRewrite[];
  records: NumberEditRecord[];
}

/**
 * What the validator is asked to allow, and the caps it enforces when it does.
 *
 * ── Why there is a second mode at all ───────────────────────────────────────
 *
 * Owen, 2026-09-04: *"send every single block through to be sure. I suspect
 * deterministic decisions on this aren't the right way to do it. Let the model
 * decide what should be updated."* So the narration text pass asks about every
 * block and about more than numbers — abbreviations, all-caps runs, bracketed
 * apparatus, spaced hyphens, roman numerals, footnote markers.
 *
 * ── What that costs, said plainly ───────────────────────────────────────────
 *
 * A NUMBER edit has a lexical anchor: `keepsEveryWord` proves every prose word
 * of the find survives, and `NUMBER_DROPPED` proves every printed number came
 * out as words. A TEXT edit has NO such anchor — "Dr." → "Doctor" and "e.g." →
 * "for example" both legitimately replace the letters, so nothing can compare
 * the two sides word for word. What guards a text edit instead is: it must be
 * anchored (verbatim, exactly once), it must be short, its replacement must be
 * spoken words and no longer than an expansion justifies, it may not touch a
 * span the rules already read, and the block as a whole has a CHANGE BUDGET —
 * the text edits together may not rewrite more than a quarter of it. A short,
 * word-shaped paraphrase of one clause can still pass all of that; the
 * `.receipt.json` names every accepted edit with its class so it can be seen.
 */
export interface NumberEditPolicy {
  /**
   * May an edit whose `find` prints NO digit be accepted?
   *
   * False is the number pass as it has always been: a find with no digit is
   * `NO_DIGIT_IN_FIND`, so prose the model felt like tidying cannot ride in on a
   * number edit. True is the narration text pass.
   */
  allowTextEdits: boolean;
}

/** The number pass's own policy — the behaviour every caller had before 2026-09-04. */
export const NUMBERS_ONLY: NumberEditPolicy = { allowTextEdits: false };
/** The narration text pass's policy: every class, under the caps below. */
export const EVERY_CLASS: NumberEditPolicy = { allowTextEdits: true };

/**
 * The longest span whose READING can differ from its printing.
 *
 * "Kretschmar/Nicolaisen, Document II 9/34" is 38 characters and is the longest
 * real find measured on the fixture book. 200 leaves room for a find extended
 * with surrounding words to make it unique (which the prompt asks for) and still
 * refuses a clause: a find longer than this is a paraphrase wearing an edit's
 * clothes.
 */
const MAX_FIND_CHARS = 200;

/**
 * How much longer a replacement may be than what it replaces.
 *
 * The largest honest expansion is a number: "$1,250,000" (10 characters) reads
 * "one million two hundred fifty thousand dollars" (46) — 4.6x. The formula is
 * `4x + 40`, which admits that and every acronym spelled out, and refuses a
 * replacement that is a new sentence.
 */
const replaceCap = (find: string): number => find.length * 4 + 40;

/**
 * How many edits one block may propose.
 *
 * A block is a paragraph. Twenty-four spans whose reading differs is already an
 * extraordinary paragraph (the densest fixture, an archive citation line, has
 * six); beyond it the model is rewriting rather than reading.
 */
const MAX_EDITS_PER_BLOCK = 24;

/**
 * The share of a block's characters the TEXT edits together may replace.
 *
 * Number edits are excluded from the budget: a paragraph that is a table of
 * dates legitimately changes most of its characters, and the number invariants
 * already prove each one. What this bounds is the class with no lexical anchor —
 * a model that "improved" a paragraph one short span at a time.
 */
const MAX_TEXT_EDIT_SHARE = 0.25;

/**
 * And the FLOOR under that share, in characters.
 *
 * A quarter of a paragraph is a real bound; a quarter of a HEADING is four
 * characters, and a heading is exactly the block whose whole text might be one
 * abbreviation ("Dr. Smith", "Part IV"). Without a floor the budget would refuse
 * every short block's only honest edit. SIXTY, lowered from eighty by the adversarial review of 2026-09-04, which
 * measured an eighty-nine-character sentence having eighty of its characters
 * replaced and accepted. It is still longer than any heading this app has
 * measured, and the one-token law above is what now bounds MEANING — this is
 * the backstop, not the guard.
 */
const MIN_TEXT_EDIT_BUDGET = 60;

/**
 * Check one target's proposed edits and return the ones that may be applied.
 *
 * EVERY outcome is recorded, and a rejection means the printed digits stand for
 * that span — and the VOICE READS THEM AS DIGITS: e2a's own number transform is
 * permanently disabled (Owen, 2026-09-02), so nothing downstream converts what
 * this pass refused. That is the accepted cost of never accepting a wrong edit;
 * the `.edits.json` beside the copy names every refusal for review. The order
 * of the checks is the order of the dispositions in `NumberEditStatus`, and the
 * first one that fires is the one recorded: they are reasons, not a score.
 *
 * `segments` is what makes `SPANS_MARKUP` answerable here rather than inside the
 * writer: it is the length of each of the target's text nodes, so a span that
 * does not fit inside one of them is a span sitting across an `<em>` or a
 * `<sup>`, and it is refused before anything is written.
 */
export function validateNumberEdits(
  target: string,
  segments: readonly number[],
  edits: ReadonlyArray<{ find?: unknown; replace?: unknown }>,
  /**
   * Spans of `target` a deterministic rule already read. An edit reaching into
   * one is refused `OVERLAPS_APPLIED`, the same way an edit reaching into a span
   * accepted earlier in this very list is: two readings of one span is not an
   * improvement on either.
   */
  reserved: ReadonlyArray<{ at: number; end: number }> = [],
  /**
   * Which classes may be accepted. Defaults to NUMBERS ONLY, which is the
   * behaviour every caller had before 2026-09-04 and is what keeps the vendored
   * copy of this module answering the way the corpora were built with.
   */
  policy: NumberEditPolicy = NUMBERS_ONLY,
): ValidatedEdits {
  const starts: number[] = [];
  let running = 0;
  for (const length of segments) { starts.push(running); running += length; }
  const withinOneNode = (at: number, end: number): boolean =>
    starts.some((start, i) => at >= start && end <= start + segments[i]);

  // The scripture references in this block, recomputed from the target the model
  // was actually shown. They are protected spans, so they read the same here as
  // they did in the rules — no offset mapping, and no chance of the two halves
  // disagreeing about where a reference is.
  const scripture = scriptureSpans(target);

  const accepted: NarrationTextRewrite[] = [];
  const records: NumberEditRecord[] = [];
  const reject = (find: string, replace: string, status: NumberEditStatus, detail?: string): void => {
    const editClass = classifyEdit(find);
    records.push(detail === undefined
      ? { find, replace, status, editClass }
      : { find, replace, status, editClass, detail });
  };

  // How many characters the accepted TEXT edits have replaced so far. Number
  // edits are outside the budget — their own invariants prove each one.
  let textBudgetSpent = 0;
  const textBudget = Math.max(
    MIN_TEXT_EDIT_BUDGET, Math.floor(target.length * MAX_TEXT_EDIT_SHARE));

  for (const proposed of edits) {
    const find = typeof proposed?.find === 'string' ? proposed.find : '';
    const replace = typeof proposed?.replace === 'string' ? proposed.replace : '';
    const editClass = classifyEdit(find);
    // WHICH INVARIANTS APPLY, asked directly rather than read off the class: a
    // bracketed insertion carrying a page number is both a bracket and a number,
    // and the two questions have different answers. A digit-bearing find with a
    // real replacement is a NUMBER edit and every number invariant applies; a
    // removal is judged by whether it is apparatus.
    const isRemoval = replace.trim() === '';
    const isNumber = DIGIT.test(find) && !isRemoval;

    if (find === '' || find === replace) { reject(find, replace, 'NOOP'); continue; }
    if (accepted.length >= MAX_EDITS_PER_BLOCK) {
      reject(find, replace, 'TOO_MANY_EDITS',
        `a block may carry ${MAX_EDITS_PER_BLOCK} spans whose reading differs; beyond that the `
        + 'answer is a rewrite of the block and not a list of readings');
      continue;
    }
    if (find.length > MAX_FIND_CHARS) {
      reject(find, replace, 'EDIT_TOO_LONG',
        `a find of ${find.length} characters is a clause, not a span whose reading differs`);
      continue;
    }

    const occurrences = digitBoundedOccurrences(target, find);
    if (occurrences.length === 0) { reject(find, replace, 'NOT_FOUND'); continue; }
    if (occurrences.length > 1) { reject(find, replace, 'AMBIGUOUS_FIND'); continue; }
    const at = occurrences[0];
    // Does this edit reach into a reference the rules detected and protected?
    // Asked once, here, because three checks below turn on the answer.
    const inScripture = scripture.some((s) => at < s.end && s.at < at + find.length);
    if (!isNumber && !policy.allowTextEdits) {
      reject(find, replace, 'NO_DIGIT_IN_FIND');
      continue;
    }


    // ── A SPACED HYPHEN READ AS A DASH is punctuation and nothing else ───
    //
    // Checked by SHAPE rather than by class, because the class test loses to
    // the digit test: "12 - and" classifies as a number edit and was refused
    // DIGIT_IN_REPLACE, so the whole class was impossible next to a number
    // (the third review, 2026-09-04). Here the replacement must be the find
    // with its spaced hyphens turned into em dashes and NOTHING else changed,
    // so any digit it carries is provably the find's own.
    if (find.includes('&') && ampersandReadings(find).includes(replace)) {
      if (sitsInCitation(target, find, at)) {
        reject(find, replace, 'CITATION_CODE');
        continue;
      }
      const ampEnd = at + find.length;
      if (!withinOneNode(at, ampEnd)) { reject(find, replace, 'SPANS_MARKUP'); continue; }
      if (reserved.some((r) => at < r.end && r.at < ampEnd)
        || accepted.some((a) => at < a.at + a.find.length && a.at < ampEnd)) {
        reject(find, replace, 'OVERLAPS_APPLIED');
        continue;
      }
      const ampSpends = Math.max(find.length, replace.length);
      if (textBudgetSpent + ampSpends > textBudget) {
        reject(find, replace, 'BLOCK_BUDGET',
          `the readings accepted so far already replace ${textBudgetSpent} of this block's `
          + `${target.length} characters`);
        continue;
      }
      textBudgetSpent += ampSpends;
      accepted.push({ find, replace, at });
      records.push({ find, replace, status: 'APPLIED', editClass: 'ampersand' });
      continue;
    }
    if (hyphenToDash(find) === replace) {
      if (sitsInCitation(target, find, at)) {
        reject(find, replace, 'CITATION_CODE');
        continue;
      }
      const dashEnd = at + find.length;
      if (!withinOneNode(at, dashEnd)) { reject(find, replace, 'SPANS_MARKUP'); continue; }
      if (reserved.some((r) => at < r.end && r.at < dashEnd)
        || accepted.some((a) => at < a.at + a.find.length && a.at < dashEnd)) {
        reject(find, replace, 'OVERLAPS_APPLIED');
        continue;
      }
      const dashSpends = Math.max(find.length, replace.length);
      if (textBudgetSpent + dashSpends > textBudget) {
        reject(find, replace, 'BLOCK_BUDGET',
          `the readings accepted so far already replace ${textBudgetSpent} of this block's `
          + `${target.length} characters`);
        continue;
      }
      textBudgetSpent += dashSpends;
      accepted.push({ find, replace, at });
      records.push({ find, replace, status: 'APPLIED', editClass: 'spaced-hyphen' });
      continue;
    }
    if (DIGIT.test(replace)) { reject(find, replace, 'DIGIT_IN_REPLACE'); continue; }
    if (replace.length > replaceCap(find)) {
      reject(find, replace, 'REPLACE_TOO_LONG',
        `${replace.length} characters for a ${find.length}-character span is an expansion no `
        + 'reading justifies');
      continue;
    }
    // The one character this pass may invent, and only for the class it exists
    // for: a hyphen the book printed, read as the em dash it stands in for.
    const extraAllowed = !isNumber && policy.allowTextEdits && find.includes('-')
      ? HYPHEN_DASH_ALLOWANCE : '';
    if (!spokenWords(find, replace, extraAllowed)) {
      reject(find, replace, 'REPLACE_NOT_WORDS');
      continue;
    }
    if (punctuationNameCount(replace) > punctuationNameCount(find)) {
      reject(find, replace, 'PUNCTUATION_SPOKEN',
        'the replacement says the NAME of a punctuation mark the book only prints');
      continue;
    }
    if (LIST_MARKER.test(find) && !replace.trimEnd().endsWith('.')) {
      reject(find, replace, 'LIST_MARKER_PERIOD',
        'a list marker keeps its period — "1." is read "one.", not "one"');
      continue;
    }

    if (isNumber) {
      // ── The number invariants, unchanged, and they apply to nothing else ──
      //
      // WITH ONE RELAXATION, and its boundary is exactly one detected scripture
      // span. `keepsEveryWord` requires every prose word of the find to survive,
      // which is right for "12 June 1933" and impossible for "1 Pet. 3:7":
      // reading it means REPLACING "Pet." with "Peter". That refusal is measured
      // — 57 correct expansions were thrown away as WORDS_DROPPED on the
      // 2026-09-02 run — and it is why the reading was done by rule instead,
      // which is the arrangement Owen reversed on 2026-09-05.
      //
      // Inside a detected span the invariant becomes the ONE-TOKEN LAW the text
      // branch below already uses: at most one prose word may go, and a name
      // must arrive in its place. Every other number invariant is untouched, and
      // NUMBER_DROPPED still proves the chapter and the verse both came out as
      // words — "1 Pet. 3:7" → "First Peter three" is still refused.
      const wordsSurvive = inScripture
        ? scriptureWordsSurvive(find, replace) : keepsEveryWord(find, replace);
      if (!wordsSurvive) { reject(find, replace, 'WORDS_DROPPED'); continue; }
      // Every run of digits has to come out as at least one number word. Measured
      // on the n2 acceptance run, 2026-09-02: "20:6" came back as "twenty" — the
      // verse silently gone, and nothing above could see it because the answer was
      // plain words with no digit in it. "1985" → "nineteen eighty-five" is three
      // words for one run; "28:7-8" → "twenty-eight seven through eight" is three
      // for three; "20:6" → "twenty" is one for two, and refused.
      if (numberWordCount(replace) < fewestNumberWords(find)) {
        reject(find, replace, 'NUMBER_DROPPED',
          `${digitRunCount(find)} group(s) of digits need at least ${fewestNumberWords(find)} `
          + `number word(s); the reading has ${numberWordCount(replace)}`);
        continue;
      }
      // And nothing proved that no words were GAINED. "The 12 men who refused
      // were shot" -> "The twelve men who refused were spared, and the men who
      // shot" keeps every prose word in order, converts the number, prints no
      // digit — and inverts the sentence. Measured by the adversarial review,
      // 2026-09-04. The reading may hold the find's own words, the number words
      // the conversion produced, and NUMBER_WORD_SLACK joins. Nothing more.
      const allowedWords =
        wordTokens(find).length + numberWordCount(replace) + NUMBER_WORD_SLACK;
      if (wordTokens(replace).length > allowedWords) {
        reject(find, replace, 'WORDS_ADDED',
          `the reading has ${wordTokens(replace).length} words for a span of `
          + `${wordTokens(find).length}; a conversion may add its number words and `
          + `${NUMBER_WORD_SLACK} joining word(s), not a clause`);
        continue;
      }
      // LAST, so every invariant above keeps its own name: what the relaxation
      // opened, this closes. Inside a detected span the reading must actually BE
      // a reading — the book named in full, and a pause between the chapter and
      // the verse. ("20:6" → "twenty" is still NUMBER_DROPPED above; what
      // reaches here is a reading with all its numbers and no reference in it.)
      if (inScripture) {
        const halfRead = scriptureReadingRefusal(find, replace);
        if (halfRead !== null) {
          reject(find, replace, 'SCRIPTURE_UNREAD', halfRead);
          continue;
        }
      }
    } else {
      // ── THE ONE-TOKEN LAW, and the READING law on top of it ─────────────
      //
      // Owen's ruling of 2026-09-04: for a non-number class the replacement must
      // preserve every alphabetic word of the find, in order, EXCEPT the single
      // token the class is allowed to change. The second review added: the
      // replacement must be a READING of that token. The third added: it must
      // also keep every punctuation mark outside it, and its CASE.
      //
      // Each of those is a measured defect, not a precaution: a name swapped, a
      // negation inserted, "FBI" -> "Gestapo", and "Dr. Kempner; they" ->
      // "Doctor Kempner they", which fused two sentences in the working copy.

      // ── A REMOVAL: apparatus, and only apparatus ─────────────────────────
      if (isRemoval) {
        if (!isWholeBracketedInsertion(find)) {
          reject(find, replace, 'EMPTY_REPLACE',
            'only a bracketed insertion may be removed outright; every other reading says '
            + 'something');
          continue;
        }
        const notApparatus = bracketRemovalRefusal(find);
        if (notApparatus !== null) {
          reject(find, replace, 'EMPTY_REPLACE', notApparatus);
          continue;
        }
        if (wordTokens(find).length > MAX_BRACKET_WORDS) {
          reject(find, replace, 'EMPTY_REPLACE',
            `a bracketed insertion of ${wordTokens(find).length} words is a clause of the book, `
            + `not apparatus; at most ${MAX_BRACKET_WORDS} may be removed`);
          continue;
        }
      } else if (droppedBrackets(find) === replace) {
        // ── A SQUARE-BRACKETED INTERPOLATION, read rather than deleted ─────
        //
        // Owen's ruling of 2026-09-04: "[he said]" is words, and words are READ.
        // The permitted edit is to drop the brackets and keep everything else —
        // which is what this shape is — and deleting the whole thing is only for
        // the apparatus shapes above. Round brackets are not offered this: a
        // parenthesis is the author's punctuation and a narrator reads through
        // it either way.
        if (find.trim()[0] !== '[') {
          reject(find, replace, 'NOT_A_CLASS',
            'a parenthesis is the book\'s own punctuation and stays; only an editorial '
            + '[interpolation] may have its brackets dropped');
          continue;
        }
      } else {
        // Which class this span belongs to, with the brackets set aside: a
        // parenthesis around an acronym is still an acronym edit.
        const inner = editClass === 'bracketed'
          ? classifyEdit(find.replace(/^\s*[([]|[)\]]\s*$/g, ''))
          : editClass;
        if (inner === 'other' || inner === 'bracketed') {
          reject(find, replace, 'NOT_A_CLASS',
            'this span is prose, not an abbreviation, a run of capitals, a roman numeral or a '
            + 'bracketed insertion — the pass has no reading to give it');
          continue;
        }
        const aligned = alignWords(find, replace);
        const dropped = aligned.dropped;
        /** Does the changed token's final period belong to the sentence? */
        let sentencePeriod = false;
        if (dropped.length > 1) {
          reject(find, replace, 'WORDS_DROPPED',
            `${dropped.length} words of the span are missing from the reading `
            + `(${dropped.join(', ')}); a reading may change exactly one`);
          continue;
        }
        // NOTHING MAY BE ADDED EITHER. The law bounded what went missing and
        // said nothing about what arrived, so a replacement that kept every word
        // and appended a sentence passed (the second review, 2026-09-04).
        if (aligned.inserted > 0) {
          reject(find, replace, 'WORDS_ADDED',
            `the reading adds ${aligned.inserted} word(s) the span does not account for; a `
            + 'reading replaces one token and repeats the rest');
          continue;
        }
        // A word that only changed CASE is the emphasis reading, and only a run
        // of capitals gets it. "the FBI had" -> "The f b i had" changed two.
        const miscased = aligned.recased.filter((pair) => !isEmphasisRecase(pair));
        const firstMiscased = miscased[0];
        if (firstMiscased !== undefined) {
          reject(find, replace, 'NOT_A_READING',
            `"${firstMiscased.was}" became "${firstMiscased.now}", which is neither the same `
            + 'word nor its emphasis reading — only a run of capitals is read in ordinary case');
          continue;
        }

        const changed = dropped[0];
        if (changed !== undefined) {
          if (!isClassToken(changed)) {
            reject(find, replace, 'WORDS_DROPPED',
              `"${changed}" is an ordinary word, not the abbreviation, run of capitals or `
              + 'roman numeral this reading is about');
            continue;
          }
          // WHERE the token sits in the BLOCK, so the context rules and the
          // sentence rule read the book rather than the span the model chose.
          const spanAt = tokenOffsetIn(find, aligned.droppedIndex);

          const tokenAt = at + spanAt;
          const before = target.slice(0, tokenAt);
          const after = target.slice(tokenAt + changed.length);

          // ── AN ABBREVIATION WHOSE PERIOD MAY END THE SENTENCE keeps it ────
          //
          // Asked of the BLOCK, at the token, wherever the token sits in the
          // find. It used to be asked of the find — "is this token the last
          // thing in the span?" — and the prompt tells the model to extend a
          // find until it is unique, so the moment it did the guard switched
          // off: "Oxford St. The" -> "Oxford Street The" was APPLIED and fused
          // two sentences, while the CORRECT "Oxford Street. The" was refused
          // for carrying a period the accounting had stripped (the fourth
          // adversarial review, 2026-09-04).
          //
          // What follows the TOKEN in the block is the only evidence there is,
          // and it does not change when the model widens its find.
          sentencePeriod = changed.endsWith('.') && couldEndSentence(after)
            && !prefixesAName(changed, before, after);
          const readingLast = aligned.reading[aligned.reading.length - 1];
          if (sentencePeriod && (readingLast === undefined || !readingLast.endsWith('.'))) {
            reject(find, replace, 'NOT_A_READING',
              `the block goes on after "${changed}" with a capital, so its period may be the end `
              + 'of the sentence — the reading has to keep it');
            continue;
          }
          const notAReading = readingRefusal(changed, aligned.reading, before, after);
          if (notAReading !== null) {
            reject(find, replace, 'NOT_A_READING', notAReading);
            continue;
          }
        }

        // ── AND EVERY MARK OUTSIDE THE CHANGED TOKEN SURVIVES ─────────────
        //
        // The law compared words and counted them, so a reading could silently
        // drop a semicolon: "Dr. Kempner; they" -> "Doctor Kempner they",
        // measured into a working copy.
        const wantPunct = punctuationOutsideToken(find, aligned.droppedIndex, sentencePeriod);
        const gotPunct = punctuationOf(replace);
        if (wantPunct !== gotPunct) {
          reject(find, replace, 'NOT_A_READING',
            `the span prints ${JSON.stringify(wantPunct)} around the word it changes and the `
            + `reading prints ${JSON.stringify(gotPunct)}; a reading changes a word, never the `
            + 'punctuation around it');
          continue;
        }
      }

      // The budget counts whichever side is bigger: a sixty-character find that
      // became two hundred characters of invention spent sixty of the block's
      // budget before this was measured (the first adversarial review).
      const spends = Math.max(find.length, replace.length);
      if (textBudgetSpent + spends > textBudget) {
        reject(find, replace, 'BLOCK_BUDGET',
          `the readings accepted so far already replace ${textBudgetSpent} of this block's `
          + `${target.length} characters, and a block whose text is rewritten past `
          + `${Math.round(MAX_TEXT_EDIT_SHARE * 100)}% is being paraphrased, not read`);
        continue;
      }
    }

    // A DETECTED REFERENCE IS EXEMPT FROM THE CITATION GUARD. The guard reads a
    // leading roman numeral as apparatus ("Document II 9/34"), which is right
    // everywhere except the one place a roman numeral means a VOLUME: "II Cor.
    // 5:17" was refused CITATION_CODE and narrated as digits (measured,
    // adversarial review 2026-09-05). The span was recognized as a reference by
    // shape before the model was asked, and that evidence is the stronger one.
    if (!inScripture && sitsInCitation(target, find, at)) {
      reject(find, replace, 'CITATION_CODE');
      continue;
    }

    const end = at + find.length;
    if (!withinOneNode(at, end)) { reject(find, replace, 'SPANS_MARKUP'); continue; }
    if (reserved.some((r) => at < r.end && r.at < end)
      || accepted.some((a) => at < a.at + a.find.length && a.at < end)) {
      reject(find, replace, 'OVERLAPS_APPLIED');
      continue;
    }

    if (!isNumber) textBudgetSpent += Math.max(find.length, replace.length);
    accepted.push({ find, replace, at });
    records.push({ find, replace, status: 'APPLIED', editClass });
  }
  return { accepted, records };
}

// ─────────────────────────────────────────────────────────────────────────────
// The model call
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one model call this pass makes, injected.
 *
 * Production binds it to `generateEditListWithOllama` in ai-bridge.ts, so the
 * request goes through the SAME code path as every other edit-list call in the
 * app — the thinking-capability probe, the streaming inactivity timeout, the
 * `<answer>` extraction. A test binds it to a function returning canned strings
 * and reaches every disposition above without a GPU.
 */
export interface NumberNormalizerRunner {
  /** The model tag: in the cache path, in the log, and in every error message. */
  model: string;
  /**
   * Called once, before the first request, with the LONGEST input this pass will
   * send. Ollama fully reloads the runner on any `num_ctx` change, so the window
   * is sized once for the whole book and pinned — a per-passage estimate would
   * churn a 6-17 GB model in and out between paragraphs. Optional because a test
   * runner has no context window to size.
   */
  pinContextTo?(systemPrompt: string, longestInput: string): void;
  /** One request. Returns the extracted answer; throws on transport failure. */
  generate(input: string, systemPrompt: string): Promise<string>;
  /**
   * Give the model's VRAM back. Called once, after the last target, BEFORE this
   * pass returns — e2a takes the GPU next and cannot share it with 6-17 GB of
   * weights sitting out a keep_alive window.
   */
  release(): Promise<void>;
}

/** Where the model looks for the target, and what it may not edit. */
export function buildNormalizerInput(
  target: string,
  previous: string | null,
  next: string | null,
): string {
  const shown = (s: string | null): string =>
    s === null || s.trim() === '' ? '(none)' : s.replace(/\s+/g, ' ').trim();
  return `PREVIOUS (context only, never edit this):\n${shown(previous)}\n\n`
    + `TARGET (edit ONLY this):\n${target}\n\n`
    + `NEXT (context only, never edit this):\n${shown(next)}`;
}

/** Is this failure input-independent — worth exactly one re-roll? */
function isTransportFailure(message: string): boolean {
  return /fetch|network|ECONNREFUSED|ECONNRESET|socket|timeout|EHOSTUNREACH|ENOTFOUND/i.test(message);
}

/**
 * Ask the model about one target and parse its edit list.
 *
 * Two retry rules, both from `cleanChunkEditList` and for its reasons:
 *  - a TRANSPORT failure is input-independent, so it is retried once;
 *  - a PARSE failure is content-correlated, and is retried once at the SAME
 *    settings — a second identical answer is the model's real answer, and the
 *    unit is then recorded `UNIT_PARSE_FAIL` with its digits intact.
 * A transport failure that survives its retry THROWS: an unreachable Ollama is
 * not a paragraph this pass gets to skip.
 */
async function askForEdits(
  runner: NumberNormalizerRunner,
  systemPrompt: string,
  input: string,
): Promise<{ edits: Array<{ find?: unknown; replace?: unknown }> } | { parseFail: string }> {
  const { firstJsonObject } = await import('./ai-cleanup-prepass.js');
  let lastRaw = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let answer: string;
    try {
      answer = await runner.generate(input, systemPrompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 1 && isTransportFailure(message)) continue;
      throw new Error(
        `The number-normalization pass could not reach the model '${runner.model}': ${message}`
      );
    }
    lastRaw = answer;
    const objText = firstJsonObject(answer);
    if (objText !== null) {
      try {
        const parsed = JSON.parse(objText) as { edits?: unknown };
        if (Array.isArray(parsed.edits)) {
          return { edits: parsed.edits as Array<{ find?: unknown; replace?: unknown }> };
        }
      } catch { /* falls through to the retry / the recorded failure */ }
    }
  }
  return { parseFail: lastRaw.slice(0, RAW_ANSWER_EXCERPT) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The loop both kinds of input share
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One span the model will be asked about, with the neighbours it is shown.
 *
 * A book's paragraph and a text file's block are the SAME question — here is a
 * span of prose, here is what stands either side of it, which of its digits does
 * a narrator read as words. What differs is upstream (an EPUB has elements, text
 * nodes, headings and a contents page; a `.txt` has blank lines) and downstream
 * (an EPUB is written through `writeNarrationEpub`, a `.txt` is spliced and
 * joined). The part in the middle is `askAboutEach`, and it is ONE function so
 * the two inputs cannot drift apart in how strictly the model is guarded — a
 * second copy of the retry rules or the parse-failure gate would be a second set
 * of rules to keep true.
 */
export interface NormalizerAsk {
  /** How the answer is found again: a target's key, or a block's index. */
  key: string;
  /** The text the model may edit, and the text every edit is validated against. */
  text: string;
  /** The length of each of that text's nodes. A plain-text block is one node. */
  segments: readonly number[];
  /** The neighbour before it — shown as context, never editable. */
  previous: string | null;
  /** The neighbour after it, same. */
  next: string | null;
}

/** What the loop settled about one ask. */
export interface AskOutcome {
  status: NumberUnitStatus;
  /** Every span to splice, at its offset in the ORIGINAL text — rules and model. */
  accepted: NarrationTextRewrite[];
  records: NumberEditRecord[];
  rawAnswer?: string;
  /**
   * What the deterministic rules alone made of this span.
   *
   * Kept because the heading/contents reconciliation needs it: a rule edit is
   * reconciled by asking whether the OTHER member's rules produced the same
   * edit, not by re-validating it — the validator would refuse "2 Cor. 10:4" →
   * "Second Corinthians ten four" for dropping the word "Cor.", which is exactly
   * what the abbreviation rule is for.
   */
  ruled: NumberRuleOutcome;
}

/**
 * The rules' spans as they sit in the RULE-APPLIED text, with the length each
 * one added.
 *
 * The model is shown that text and answers about it, so both questions this pass
 * then has — "does this model edit reach into a span code already read?" and
 * "where is it in the ORIGINAL?" — are answered in those coordinates.
 */
function ruleSpansInApplied(
  ruled: NumberRuleOutcome,
): Array<{ at: number; end: number; delta: number }> {
  const spans: Array<{ at: number; end: number; delta: number }> = [];
  let shift = 0;
  for (const edit of ruled.rewrites) {
    const at = edit.at + shift;
    const delta = edit.replace.length - edit.find.length;
    spans.push({ at, end: at + edit.replace.length, delta });
    shift += delta;
  }
  return spans;
}

/** The offset in the ORIGINAL text of a rule-applied offset no rule span covers. */
function toOriginalOffset(
  spans: ReadonlyArray<{ at: number; end: number; delta: number }>,
  at: number,
): number {
  let shift = 0;
  for (const span of spans) {
    if (span.end <= at) shift += span.delta; else break;
  }
  return at - shift;
}

/** The record line for every edit the deterministic rules settled. */
function ruleRecords(ruled: NumberRuleOutcome): NumberEditRecord[] {
  const out: NumberEditRecord[] = [];
  for (const edit of ruled.rewrites) {
    out.push({
      find: edit.find, replace: edit.replace, status: 'APPLIED_RULE',
      editClass: classifyEdit(edit.find), detail: edit.rule,
    });
  }
  for (const refusal of ruled.refused) {
    out.push({
      find: refusal.find, replace: refusal.replace, status: 'SPANS_MARKUP',
      editClass: classifyEdit(refusal.find),
      detail: `the ${refusal.rule} rule: ${refusal.reason}`,
    });
  }
  // AND EVERY SCRIPTURE REFERENCE THE RULES PROTECTED, by name.
  //
  // A block that still holds digits after the rules ran is a block the model is
  // asked about, and the record has to be able to say WHY. Without this line a
  // protected reference is invisible: no rule read it, so no APPLIED_RULE names
  // it, and if the model then declines it the receipt shows a block that was
  // asked about and changed nothing, with nothing to say what was in it.
  //
  // `replace` is the reference as printed, because a rule proposed no reading of
  // it — that is the whole point of the disposition.
  for (const span of ruled.scripture) {
    out.push({
      find: span.find, replace: span.find, status: 'SCRIPTURE_PROTECTED',
      editClass: 'number',
      detail: 'a scripture reference: no rule may read it, and the model was asked',
    });
  }
  return out;
}

/** The rules' rewrites as plain spans, ready to splice into the original. */
function ruleRewrites(ruled: NumberRuleOutcome): NarrationTextRewrite[] {
  return ruled.rewrites.map(({ at, find, replace }) => ({ at, find, replace }));
}

/**
 * Ask the model about every selected span, validate every answer, and give the
 * model's VRAM back before returning.
 *
 * The whole model-facing contract lives here: the context window pinned ONCE to
 * the longest request, the two retry rules in `askForEdits`, the validation wall
 * in `validateNumberEdits`, the parse-failure share that declares a model broken
 * rather than narrating a book of digits, and the `release()` in `finally` —
 * which runs on the failure path too, because a pass that threw still left 6-17
 * GB of weights resident and e2a takes the GPU next either way.
 */
async function askAboutEach(
  asks: readonly NormalizerAsk[],
  runner: NumberNormalizerRunner,
  systemPrompt: string,
  onProgress: NumberNormalizationProgress | undefined,
  /**
   * Which blocks reach the model, and which classes their answers may carry.
   *
   * 'digit-bearing' + NUMBERS_ONLY is the number pass: a span the rules finished
   * costs no request at all, which is what `RULES_ONLY` records. 'every-block' +
   * EVERY_CLASS is the narration text pass: one request per block, whatever it
   * prints, because an abbreviation and an acronym are invisible to a digit test.
   */
  ask: 'digit-bearing' | 'every-block' = 'digit-bearing',
  policy: NumberEditPolicy = NUMBERS_ONLY,
): Promise<{ decisions: Map<string, AskOutcome>; parseFailed: number; asked: number }> {
  // ── The deterministic pass, first and for everything ──────────────────────
  const ruledOf = new Map<string, NumberRuleOutcome>();
  for (const ask of asks) ruledOf.set(ask.key, applyNumberRules(ask.text, ask.segments));

  // Only a span the rules left a digit in is worth a model call. The neighbours
  // are shown in their rule-applied form too, so the context reads in the same
  // words the answer has to be written in.
  const inputs = new Map<string, string>();
  const asContext = (text: string | null): string | null =>
    text === null ? null : applyNumberRules(text, [text.length]).text;
  for (const one of asks) {
    const ruled = ruledOf.get(one.key)!;
    // A block with nothing left to read is skipped ONLY when the question is
    // about digits. When the question is "does anything here print one way and
    // read another", a block with no digit is exactly the block that might.
    if (ask === 'digit-bearing' && !stillHasDigits(ruled.text)) continue;
    // A block with no text at all is nothing to ask about in either mode.
    if (ruled.text.trim() === '') continue;
    inputs.set(one.key,
      buildNormalizerInput(ruled.text, asContext(one.previous), asContext(one.next)));
  }
  const total = inputs.size;

  const decisions = new Map<string, AskOutcome>();
  const settleByRules = (ask: NormalizerAsk): void => {
    const ruled = ruledOf.get(ask.key)!;
    decisions.set(ask.key, {
      status: 'RULES_ONLY', accepted: ruleRewrites(ruled), records: ruleRecords(ruled), ruled,
    });
  };

  // A book the rules read entirely never loads a model at all — no context to
  // pin, no request, and nothing to release. That is not an optimization: an
  // Ollama that is down must not fail a pass that had nothing to ask it.
  if (total === 0) {
    for (const ask of asks) settleByRules(ask);
    onProgress?.(0, 0, 'Releasing model');
    return { decisions, parseFailed: 0, asked: 0 };
  }

  runner.pinContextTo?.(
    systemPrompt, [...inputs.values()].reduce((a, b) => (b.length > a.length ? b : a), ''));

  let parseFailed = 0;
  let done = 0;
  try {
    for (const ask of asks) {
      const input = inputs.get(ask.key);
      if (input === undefined) { settleByRules(ask); continue; }

      const ruled = ruledOf.get(ask.key)!;
      const fromRules = ruleRewrites(ruled);
      const answer = await askForEdits(runner, systemPrompt, input);
      if ('parseFail' in answer) {
        parseFailed++;
        decisions.set(ask.key, {
          status: 'UNIT_PARSE_FAIL', accepted: fromRules, records: ruleRecords(ruled),
          rawAnswer: answer.parseFail, ruled,
        });
      } else {
        // Validated against the text the model was SHOWN, then moved back onto
        // the original: the two differ by exactly the rules' own length deltas.
        const spans = ruleSpansInApplied(ruled);
        const { accepted, records } =
          validateNumberEdits(ruled.text, ruled.segments, answer.edits, spans, policy);
        const mapped = accepted.map((edit) => {
          const at = toOriginalOffset(spans, edit.at);
          if (ask.text.slice(at, at + edit.find.length) !== edit.find) {
            throw new Error(
              `The number-normalization pass could not place "${edit.find}" back into ${ask.key}: `
              + `the original text at ${at} reads "${ask.text.slice(at, at + edit.find.length)}". `
              + 'Nothing was written.');
          }
          return { find: edit.find, replace: edit.replace, at };
        });
        decisions.set(ask.key, {
          status: 'ANSWERED',
          accepted: [...fromRules, ...mapped].sort((a, b) => a.at - b.at),
          records: [...ruleRecords(ruled), ...records],
          ruled,
        });
      }
      done++;
      onProgress?.(done, total, 'Normalizing numbers');
    }

    if (parseFailed > total * MAX_PARSE_FAIL_SHARE) {
      throw new Error(
        `The number-normalization model '${runner.model}' failed to produce a usable edit list for `
        + `${parseFailed} of ${total} passages. That is a model this pass cannot use, not a `
        + 'hard book: check that the model is pulled and that it answers with JSON.'
      );
    }
  } finally {
    // Before the return, and before e2a is spawned — a completed pass that left
    // 6-17 GB of weights resident is a TTS job waiting on VRAM nothing is using.
    onProgress?.(total, total, 'Releasing model');
    await runner.release();
  }
  return { decisions, parseFailed, asked: total };
}

// ─────────────────────────────────────────────────────────────────────────────
// The pass
// ─────────────────────────────────────────────────────────────────────────────

/** How the door watches this run. */
export interface NumberNormalizationProgress {
  (done: number, total: number, label: string): void;
}

export interface NumberNormalizationOptions {
  /** The prompt, loaded by the caller so this module never guesses a path. */
  systemPrompt: string;
  /** Where the copy and its record go — the narration-cuts directory. */
  outDir: string;
  onProgress?: NumberNormalizationProgress;
}

/**
 * What the written copy does BESIDES the number rewrites.
 *
 * Stated by the caller, never defaulted, because the two callers want opposite
 * things and neither is "the obvious one":
 *
 *  - the narration cut wants all three ON — it is making the second file, the one
 *    a voice reads, and captions, endnotes and reference markers are not read;
 *  - the narration TEXT PASS wants all three OFF — it is editing the BOOK, on the
 *    document chain, and a pass that removed elements would be refused by the
 *    ledger's text-only invariant and would take the user's captions with it.
 *
 * `writeNarrationEpub` defaults them all to ON, which is right for the copy and
 * catastrophic for the book, so this field is required and the mistake cannot be
 * made by omission.
 */
export interface NarrationCopyShape {
  excludeCaptions: boolean;
  excludeFootnotes: boolean;
  stripSupMarkers: boolean;
}

/** What the EPUB driver needs on top of the options both drivers share. */
export interface EpubNumberNormalizationOptions extends NumberNormalizationOptions {
  /**
   * The 16-hex content address of the book being read — the first half of the
   * copy's name.
   *
   * Supplied by the caller rather than taken here, because a book is not always
   * a file: the document chain's working copy is a FOLDER of its parts, which
   * `fs.readFile` cannot hash at all. `epubContentAddress` is the answer for a
   * plain `.epub`; `bookDigest` (electron/sidecar-binding.ts) is the answer for
   * either container, and the narration text pass uses that one.
   */
  inputSha16: string;
  /** What the write does besides the rewrites. See `NarrationCopyShape`. */
  copy: NarrationCopyShape;
  /**
   * WHICH BLOCKS ARE ASKED ABOUT, and therefore what the model is asked.
   *
   * 'digit-bearing' is the number pass: a digit test selects, and only a
   * digit-bearing find may be accepted. 'every-block' is Owen's ruling of
   * 2026-09-04 for the narration text pass — every block goes, and the answer
   * may name an abbreviation, an acronym, a bracketed aside, a spaced hyphen or
   * a roman numeral as well as a number.
   *
   * Stated, never defaulted: the two cost wildly different amounts of model time
   * (one call per digit-bearing passage against one call per block of the book)
   * and a caller that did not say which it wanted would be guessing with an hour
   * of GPU.
   */
  ask: 'digit-bearing' | 'every-block';
}

/** The content address of a book that IS a file: the sha of its bytes. */
export async function epubContentAddress(inputPath: string): Promise<string> {
  const bytes = await fs.readFile(inputPath);
  return crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** The model tag, made safe to put in a filename without losing which tag it was. */
export function sanitizeModelTag(model: string): string {
  return model.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/** The name a given input, rule version and model share, whatever the format. */
function normalizedStem(inputSha16: string, model: string): string {
  return `${inputSha16}.${NORMALIZER_VERSION}.${sanitizeModelTag(model)}.norm.tts`;
}

/** Where a given input, rule version and model land on disk. */
export function normalizedCopyPaths(
  outDir: string, inputSha16: string, model: string,
): { epubPath: string; recordPath: string } {
  const stem = normalizedStem(inputSha16, model);
  return {
    epubPath: path.join(outDir, `${stem}.epub`),
    recordPath: path.join(outDir, `${stem}.edits.json`),
  };
}

/**
 * The same three facts, for a plain-text input.
 *
 * Same stem, different extension: the sha is over the CONTENT, so a `.txt` and
 * an `.epub` can never collide on one, and the record beside either says which
 * it describes.
 */
export function normalizedTextPaths(
  outDir: string, inputSha16: string, model: string,
): { textPath: string; recordPath: string } {
  const stem = normalizedStem(inputSha16, model);
  return {
    textPath: path.join(outDir, `${stem}.txt`),
    recordPath: path.join(outDir, `${stem}.edits.json`),
  };
}

/**
 * Read every number in a narration copy as words, and write the copy that says
 * them.
 *
 * Returns the input path UNCHANGED, with no model call and no file written, when
 * the book has no digit anywhere a narrator reads — the cut's own precedent
 * (`narrationInputFor` returns the source for a book with nothing to cut): a
 * file with no evidence passes through untouched, same bytes.
 *
 * Otherwise the copy is ALWAYS written, even when every edit was rejected and
 * the text is unchanged. That is what makes the cache honest: "this input, these
 * rules, this model, and here is the record of what the model said" is a fact
 * worth keeping, and re-deriving it would mean a second model pass over a book
 * the pass has already read.
 */
export async function normalizeNarrationNumbers(
  inputPath: string,
  runner: NumberNormalizerRunner,
  options: EpubNumberNormalizationOptions,
): Promise<NumberNormalizationOutcome | null> {
  const { readNarrationNumberTargets, writeNarrationEpub } = await import('./epub-processor.js');

  const inputSha16 = options.inputSha16;
  const { epubPath, recordPath } = normalizedCopyPaths(options.outDir, inputSha16, runner.model);

  // Both halves or neither: the record IS part of the artifact (it is the review
  // trail and what makes the rewrite reversible for display), so a copy sitting
  // beside a missing record describes a pass nobody can check, and is re-made.
  try {
    await fs.access(epubPath);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as NumberNormalizationRecord;
    console.log(
      `[TTS-NUMBERS] ${record.appliedSpans} number(s) already read as words by `
      + `${record.model} (copy on disk reused): ${epubPath}`);
    return { epubPath, recordPath, reused: true, record };
  } catch { /* not normalized yet, or the record is not beside it */ }

  const policy: NumberEditPolicy =
    options.ask === 'every-block' ? EVERY_CLASS : NUMBERS_ONLY;
  const targets = await readNarrationNumberTargets(inputPath);
  const selected = selectNumberTargets(targets, options.ask);
  if (selected.length === 0) {
    console.log(
      `[TTS-NUMBERS] ${path.basename(inputPath)} prints no digits a narrator would read — `
      + 'the book passes through untouched.');
    return null;
  }

  // Context is the book's own neighbours, in the book's own order, so a year is
  // read against the sentence it stands in. Indexed over ALL targets rather than
  // the selected ones: the paragraph before a date is usually digit-free, and
  // that is exactly the paragraph that says whether 1200 is a year.
  const positionOf = new Map<string, number>();
  targets.forEach((t, i) => positionOf.set(t.key, i));

  const isTocEntry = (t: NarrationNumberTarget): boolean => t.kind === 'nav' || t.kind === 'ncx';
  // A contents entry that repeats a heading of this book is NOT asked about
  // separately — it takes the heading's own edits below. Decided before the first
  // request, so the total the progress bar reports is the number of requests
  // that will actually be made, and computed off the SELECTED set because a
  // heading with no digits is not a heading this pass has an opinion about.
  const headingTexts = new Set(
    selected.filter(isHeadingTarget).map((t) => collapseForTocMatch(t.text)));
  const asked = selected.filter(
    (t) => !(isTocEntry(t) && headingTexts.has(collapseForTocMatch(t.text))));

  const asks: NormalizerAsk[] = asked.map((t) => {
    const at = positionOf.get(t.key)!;
    // Only a neighbour of the SAME kind in the SAME file is context: the entry
    // after a contents line is another chapter's name, which says nothing about
    // this one's numbers.
    const sameRun = (offset: number): string | null => {
      const other = targets[at + offset];
      if (other === undefined || other.kind !== t.kind || other.file !== t.file) return null;
      return other.text;
    };
    return {
      key: t.key, text: t.text, segments: t.segments,
      previous: sameRun(-1), next: sameRun(1),
    };
  });

  const { decisions: pending, parseFailed, asked: targetsAsked } =
    await askAboutEach(asks, runner, options.systemPrompt, options.onProgress,
      options.ask, policy);

  // ── The heading and its contents entries, made to say ONE thing ───────────
  //
  // e2a matches a body heading against the TOC titles it was handed, to recognize
  // a chapter opening that lost its heading tag, and the m4b's chapter names come
  // from that same list — so the two MUST be the same string. Guaranteed here by
  // construction rather than hoped for: the heading's own edits are offered to
  // every entry that repeats it, and only the edits that land on EVERY one of
  // them are applied to ANY of them. An edit that will not land on the contents
  // line is taken back off the heading too (`TOC_MISMATCH`), so the two cannot
  // diverge in either direction.
  //
  // THE RULE EDITS GO THROUGH THIS TOO, and they are checked differently on
  // purpose. A rule edit is not re-validated — the validator would refuse
  // "2 Cor. 10:4" → "Second Corinthians ten four" for losing the word "Cor.",
  // which is precisely what the abbreviation rule exists to do. It is asked of
  // the member's OWN rules instead: a rule edit lands on a member iff running
  // the rules over that member produced the same edit. They genuinely can
  // differ — `applyNumberRules` is a pure function of the text AND its text
  // nodes, so a heading carrying an `<em>` can refuse a span that its one-node
  // contents entry takes — and that is exactly the divergence this exists to
  // stop.
  const groups = new Map<string, NarrationNumberTarget[]>();
  for (const target of selected) {
    if (!isHeadingTarget(target) && !isTocEntry(target)) continue;
    const key = collapseForTocMatch(target.text);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [target]); else list.push(target);
  }
  const editId = (e: { find: string; replace: string }): string => `${e.find}\u0000${e.replace}`;

  const TOC_MISMATCH_DETAIL = 'the heading and its contents entry could not both take it';

  for (const [, members] of groups) {
    const headings = members.filter(isHeadingTarget);
    const entries = members.filter(isTocEntry);
    if (headings.length === 0 || entries.length === 0) continue;  // nothing to reconcile

    // A contents entry that was never asked has no settled decision yet, so it
    // gets its own deterministic reading here — the same function, same text.
    const ruledOf = new Map<string, NumberRuleOutcome>();
    for (const member of members) {
      ruledOf.set(member.key,
        pending.get(member.key)?.ruled ?? applyNumberRules(member.text, member.segments));
    }
    const ruleIdsOf = (key: string): Set<string> =>
      new Set(ruledOf.get(key)!.rewrites.map(editId));

    // The first heading in book order is the proposal. A second heading printing
    // the same words gets the same reading, which is the point.
    const head = pending.get(headings[0].key);
    if (head === undefined) {
      throw new Error(
        `The number-normalization pass reached no decision about the heading ${headings[0].key} `
        + 'that its contents entries repeat. Nothing was written.');
    }
    const headRuleIds = ruleIdsOf(headings[0].key);
    const proposal = head.accepted.map((e) => ({ find: e.find, replace: e.replace }));
    const byRule = (e: { find: string; replace: string }): boolean => headRuleIds.has(editId(e));

    const survives = new Set(proposal.map(editId));
    for (const member of members) {
      const ruled = ruledOf.get(member.key)!;
      const landed = new Set<string>(ruleIdsOf(member.key));
      for (const edit of validateNumberEdits(
        ruled.text, ruled.segments, proposal.filter((e) => !byRule(e)),
        ruleSpansInApplied(ruled), policy).accepted) {
        landed.add(editId(edit));
      }
      for (const id of [...survives]) if (!landed.has(id)) survives.delete(id);
    }

    for (const member of members) {
      const ruled = ruledOf.get(member.key)!;
      const spans = ruleSpansInApplied(ruled);
      const memberRuleIds = ruleIdsOf(member.key);

      const fromRules = ruled.rewrites
        .filter((e) => survives.has(editId(e)))
        .map(({ at, find, replace }) => ({ at, find, replace }));
      const fromModel = validateNumberEdits(
        ruled.text, ruled.segments,
        proposal.filter((e) => survives.has(editId(e)) && !byRule(e)), spans, policy,
      ).accepted.map((edit) => ({
        find: edit.find, replace: edit.replace, at: toOriginalOffset(spans, edit.at),
      }));
      const accepted = [...fromRules, ...fromModel].sort((a, b) => a.at - b.at);

      const was = pending.get(member.key);
      const records: NumberEditRecord[] = [];
      if (was !== undefined) {
        // Everything already settled about this member, with the applied edits
        // the group could not agree on demoted by name.
        for (const record of was.records) {
          const applied = record.status === 'APPLIED' || record.status === 'APPLIED_RULE';
          records.push(applied && !survives.has(editId(record))
            ? { ...record, status: 'TOC_MISMATCH', detail: TOC_MISMATCH_DETAIL }
            : record);
        }
      } else {
        // A contents entry that cost no request: its trail is its own rules'
        // reading, plus whatever the heading proposed on top of it.
        for (const edit of ruled.rewrites) {
          records.push(survives.has(editId(edit))
            ? { find: edit.find, replace: edit.replace, status: 'APPLIED_RULE', detail: edit.rule }
            : {
              find: edit.find, replace: edit.replace,
              status: 'TOC_MISMATCH', detail: TOC_MISMATCH_DETAIL,
            });
        }
        for (const edit of proposal) {
          if (memberRuleIds.has(editId(edit))) continue;  // recorded just above
          records.push(survives.has(editId(edit))
            ? { ...edit, status: 'APPLIED' }
            : { ...edit, status: 'TOC_MISMATCH', detail: TOC_MISMATCH_DETAIL });
        }
      }
      pending.set(member.key, {
        status: was === undefined ? 'SHARED_WITH_HEADING' : was.status,
        accepted,
        records,
        ruled,
        ...(was === undefined || was.rawAnswer === undefined ? {} : { rawAnswer: was.rawAnswer }),
      });
    }
  }

  // The record and the rewrite plan, built from the SAME settled decisions, so
  // the copy on disk and the review trail beside it cannot describe two passes.
  const rewrites = new Map<string, NarrationTextRewrite[]>();
  const units: NumberUnitRecord[] = [];
  const dispositions: Record<string, number> = {};
  const appliedByClass: Record<string, number> = {};
  for (const target of selected) {
    const settled = pending.get(target.key);
    if (settled === undefined) {
      // Every selected target was either asked about or reconciled against the
      // heading it repeats. One that is neither means the two passes above
      // disagree about what this book holds, which is not a book to narrate.
      throw new Error(
        `The number-normalization pass reached no decision about ${target.key}. Nothing was written.`
      );
    }
    if (settled.accepted.length > 0) rewrites.set(target.key, settled.accepted);
    for (const record of settled.records) {
      dispositions[record.status] = (dispositions[record.status] ?? 0) + 1;
      if (record.status !== 'APPLIED' && record.status !== 'APPLIED_RULE') continue;
      const klass = record.editClass ?? classifyEdit(record.find);
      appliedByClass[klass] = (appliedByClass[klass] ?? 0) + 1;
    }
    units.push({
      key: target.key, kind: target.kind, file: target.file, status: settled.status,
      text: target.text, edits: settled.records,
      ...(settled.rawAnswer === undefined ? {} : { rawAnswer: settled.rawAnswer }),
    });
  }

  await fs.mkdir(options.outDir, { recursive: true });
  // Written to a staging name and renamed into place, so a process that dies
  // mid-write cannot leave a truncated file under the name the reuse branch
  // above trusts. The record is renamed FIRST: the copy is what the reuse branch
  // tests for, so it must be the last of the two to appear.
  const stagingEpub = path.join(options.outDir, `${inputSha16}.staging-${crypto.randomUUID()}.epub`);
  const stagingRecord = `${stagingEpub}.edits.json`;
  const written = await writeNarrationEpub(inputPath, stagingEpub, [], {
    excludeCaptions: options.copy.excludeCaptions,
    excludeFootnotes: options.copy.excludeFootnotes,
    stripSupMarkers: options.copy.stripSupMarkers,
    rewrites,
  });

  const record: NumberNormalizationRecord = {
    normalizerVersion: NORMALIZER_VERSION,
    model: runner.model,
    source: inputPath,
    inputSha16,
    generatedAt: new Date().toISOString(),
    targetsTotal: targets.length,
    targetsSelected: selected.length,
    targetsAsked,
    unitsParseFailed: parseFailed,
    appliedSpans: written.rewrittenSpans,
    // The two halves of that count, from the tally the same decisions produced:
    // an APPLIED_RULE record IS an accepted rule edit and an APPLIED record IS an
    // accepted model edit — anything the reconciliation took back is TOC_MISMATCH
    // by then and in neither.
    appliedByRules: dispositions.APPLIED_RULE ?? 0,
    appliedByModel: dispositions.APPLIED ?? 0,
    scriptureReferences: dispositions.SCRIPTURE_PROTECTED ?? 0,
    dispositions,
    appliedByClass,
    units,
  };
  await fs.writeFile(stagingRecord, JSON.stringify(record, null, 2), 'utf8');
  await fs.rename(stagingRecord, recordPath);
  await fs.rename(stagingEpub, epubPath);

  console.log(
    `[TTS-NUMBERS] ${written.rewrittenSpans} number(s) read as words over `
    + `${selected.length} of ${targets.length} passage(s) — ${record.appliedByRules} by rules, `
    + `${record.appliedByModel} by ${runner.model} (asked about ${targetsAsked}); `
    + `${record.scriptureReferences} scripture reference(s) protected; dispositions `
    + `${JSON.stringify(dispositions)}; the copy is ${epubPath}`);

  return { epubPath, recordPath, reused: false, record };
}

// ─────────────────────────────────────────────────────────────────────────────
// The same pass, over a plain-text input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A text file's paragraphs — the unit the CLI's `--tts --input passage.txt`
 * renders and the unit this pass asks about.
 *
 * Blank lines separate them, which is the same rule `--mode streaming` already
 * reads a page's blocks by, so one text file means the same thing to both CLI
 * paths. A block is joined back with exactly one blank line between it and the
 * next, so a round trip through this pass with nothing to change is the same
 * paragraphs in the same order — e2a splits sentences itself and never depended
 * on the original run of blank lines.
 */
export function splitTextBlocks(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter((block) => block !== '');
}

export interface TextBlockNormalizationOptions extends NumberNormalizationOptions {
  /**
   * What the blocks came from. Recorded as the record's `source` and used in the
   * log line, so a `.edits.json` in the cache directory says which input it is
   * about. Required: a record that cannot name its source is a record nobody can
   * match back to a render.
   */
  source: string;
}

/**
 * Read every number in a block of plain text as words, and write the text that
 * says them.
 *
 * ── Why this exists beside the book pass ────────────────────────────────────
 *
 * `--tts --text` and `--tts --input passage.txt` are how a voice is auditioned,
 * and until now they were the one narration path that still spoke raw digits:
 * e2a has no number transform of its own any more (permanently disabled,
 * 2026-09-02), and the book door reads an EPUB. A voice test that says "twenty
 * three slash three slash nineteen thirty three" where the shipped audiobook
 * says "March twenty-third" is measuring a different pipeline than the one it
 * claims to.
 *
 * ── What is the same, and what could not be ─────────────────────────────────
 *
 * The model contract is IDENTICAL — `askAboutEach` is the same function the book
 * pass calls, so the selection rule, the validation wall, the retry rules, the
 * parse-failure gate and the release all behave the same on a text file as on a
 * book. What has no counterpart here is markup: a block is one text node, so
 * `SPANS_MARKUP` can never fire; and there is no contents page, so nothing is
 * reconciled against a heading.
 *
 * Returns null — no file written, no model loaded — when no block carries a
 * digit, the same "a file with no evidence passes through untouched" the cut and
 * the book pass both take.
 */
export async function normalizeTextBlocks(
  blocks: readonly string[],
  runner: NumberNormalizerRunner,
  options: TextBlockNormalizationOptions,
): Promise<TextNormalizationOutcome | null> {
  // Content-addressed on the BLOCKS, not on the file: `--text "…"` writes a temp
  // file with a fresh name on every run, and naming the copy after the bytes it
  // was made from is what lets a second audition of the same passage reuse the
  // first one's answers instead of paying for the model again.
  const joined = blocks.join('\n\n');
  const inputSha16 = crypto.createHash('sha256').update(joined, 'utf8').digest('hex').slice(0, 16);
  const { textPath, recordPath } = normalizedTextPaths(options.outDir, inputSha16, runner.model);

  // Both halves or neither — the record IS part of the artifact, exactly as it is
  // for a book.
  try {
    await fs.access(textPath);
    const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as NumberNormalizationRecord;
    console.log(
      `[TTS-NUMBERS] ${record.appliedSpans} number(s) already read as words by `
      + `${record.model} (copy on disk reused): ${textPath}`);
    return { textPath, recordPath, reused: true, record };
  } catch { /* not normalized yet, or the record is not beside it */ }

  const selected = blocks
    .map((text, index) => ({ key: `block-${index}`, text, index }))
    .filter((block) => DIGIT.test(block.text));
  if (selected.length === 0) {
    console.log(
      `[TTS-NUMBERS] ${path.basename(options.source)} prints no digits a narrator would read — `
      + 'the text passes through untouched.');
    return null;
  }

  // Context is the neighbouring BLOCKS, in the file's own order, and taken from
  // ALL of them rather than the selected ones — the paragraph before a date is
  // usually digit-free, and that is exactly the paragraph that says whether 1200
  // is a year.
  const asks: NormalizerAsk[] = selected.map((block) => ({
    key: block.key,
    text: block.text,
    segments: [block.text.length],
    previous: block.index > 0 ? blocks[block.index - 1] : null,
    next: block.index + 1 < blocks.length ? blocks[block.index + 1] : null,
  }));

  const { decisions, parseFailed, asked: targetsAsked } =
    await askAboutEach(asks, runner, options.systemPrompt, options.onProgress);

  // The record and the rewritten text, built from the SAME settled decisions.
  const rewritten = [...blocks];
  const units: NumberUnitRecord[] = [];
  const dispositions: Record<string, number> = {};
  const appliedByClass: Record<string, number> = {};
  let appliedSpans = 0;
  for (const block of selected) {
    const settled = decisions.get(block.key);
    if (settled === undefined) {
      // Every selected block was asked about. One that was not means the loop and
      // the selection disagree about what this file holds, which is not a file to
      // narrate.
      throw new Error(
        `The number-normalization pass reached no decision about ${block.key} of `
        + `${options.source}. Nothing was written.`);
    }
    // Applied back to front, so an earlier splice cannot move a later offset. The
    // find is re-checked against the text at its recorded position first: the
    // writer for a book proves every rewrite landed or destroys the output, and a
    // splice that went in at the wrong offset must fail here the same way.
    let text = block.text;
    for (const edit of [...settled.accepted].sort((a, b) => b.at - a.at)) {
      if (text.slice(edit.at, edit.at + edit.find.length) !== edit.find) {
        throw new Error(
          `The number-normalization pass could not splice "${edit.find}" into ${block.key} of `
          + `${options.source} at ${edit.at} — the text there is not what was validated. `
          + 'Nothing was written.');
      }
      text = text.slice(0, edit.at) + edit.replace + text.slice(edit.at + edit.find.length);
      appliedSpans++;
    }
    rewritten[block.index] = text;

    for (const record of settled.records) {
      dispositions[record.status] = (dispositions[record.status] ?? 0) + 1;
      if (record.status !== 'APPLIED' && record.status !== 'APPLIED_RULE') continue;
      const klass = record.editClass ?? classifyEdit(record.find);
      appliedByClass[klass] = (appliedByClass[klass] ?? 0) + 1;
    }
    units.push({
      key: block.key, kind: 'text-block', file: path.basename(options.source),
      status: settled.status, text: block.text, edits: settled.records,
      ...(settled.rawAnswer === undefined ? {} : { rawAnswer: settled.rawAnswer }),
    });
  }

  await fs.mkdir(options.outDir, { recursive: true });
  // Staged and renamed into place, the record first, for the reason the book pass
  // does it: the copy is what the reuse branch tests for, so it must be the last
  // of the two to appear.
  const stagingText = path.join(options.outDir, `${inputSha16}.staging-${crypto.randomUUID()}.txt`);
  const stagingRecord = `${stagingText}.edits.json`;
  await fs.writeFile(stagingText, `${rewritten.join('\n\n')}\n`, 'utf8');

  const record: NumberNormalizationRecord = {
    normalizerVersion: NORMALIZER_VERSION,
    model: runner.model,
    source: options.source,
    inputSha16,
    generatedAt: new Date().toISOString(),
    targetsTotal: blocks.length,
    targetsSelected: selected.length,
    targetsAsked,
    unitsParseFailed: parseFailed,
    appliedSpans,
    appliedByRules: dispositions.APPLIED_RULE ?? 0,
    appliedByModel: dispositions.APPLIED ?? 0,
    scriptureReferences: dispositions.SCRIPTURE_PROTECTED ?? 0,
    dispositions,
    appliedByClass,
    units,
  };
  await fs.writeFile(stagingRecord, JSON.stringify(record, null, 2), 'utf8');
  await fs.rename(stagingRecord, recordPath);
  await fs.rename(stagingText, textPath);

  console.log(
    `[TTS-NUMBERS] ${appliedSpans} number(s) read as words over `
    + `${selected.length} of ${blocks.length} block(s) — ${record.appliedByRules} by rules, `
    + `${record.appliedByModel} by ${runner.model} (asked about ${targetsAsked}); dispositions `
    + `${JSON.stringify(dispositions)}; the copy is ${textPath}`);

  return { textPath, recordPath, reused: false, record };
}
