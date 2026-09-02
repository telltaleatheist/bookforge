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
import { expandNumbersEnDetailed } from './number-expansion.js';
import type { NarrationNumberTarget, NarrationTextRewrite } from './epub-processor.js';

/**
 * The rule version, in the copy's own filename.
 *
 * BUMP IT when the selection rule, any disposition below, or
 * `electron/prompts/tts-number-normalize.txt` changes. A `.n1.` copy on disk is
 * a claim about what this pass does, and reusing one after the pass changed
 * would narrate yesterday's rules.
 */
export const NORMALIZER_VERSION = 'n1';

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
 * qwen3.5:9b is what Owen pulled on 2026-09-02; qwen3.8:27b is the heavier
 * option and is set by typing it into Settings, not by editing this line.
 */
export const DEFAULT_NORMALIZER_MODEL = 'qwen3.5:9b';

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
  /** A letter-bearing word of `find` is missing from `replace`, or out of order. */
  | 'WORDS_DROPPED'
  /** The span sits in citation apparatus and is unspeakable in any form. */
  | 'CITATION_CODE'
  /** The deterministic expander reads this shape differently. */
  | 'ORACLE_DISAGREE'
  /** The span crosses a text-node boundary — an `<em>`, a `<sup>`, a link. */
  | 'SPANS_MARKUP'
  /** The span overlaps one already accepted for this target. */
  | 'OVERLAPS_APPLIED'
  /** The heading and its contents entry could not take the SAME edit. */
  | 'TOC_MISMATCH'
  | 'APPLIED';

/** One proposed edit and what became of it. */
export interface NumberEditRecord {
  find: string;
  replace: string;
  status: NumberEditStatus;
  /** Why, when the status alone does not say it (the oracle's own reading, etc.). */
  detail?: string;
}

/** What became of one target the model was asked about. */
export type NumberUnitStatus =
  /** The model answered and the answer parsed (it may still have been empty). */
  | 'ANSWERED'
  /** The answer would not parse, twice. The digits stand. */
  | 'UNIT_PARSE_FAIL'
  /** The edits came from a heading this entry repeats, not from a model call. */
  | 'SHARED_WITH_HEADING';

/** The record for one target: the review trail, and what makes this reversible. */
export interface NumberUnitRecord {
  key: string;
  kind: NarrationNumberTarget['kind'];
  file: string;
  status: NumberUnitStatus;
  /** The text the model was shown — the target's own, before any edit. */
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
  unitsParseFailed: number;
  appliedSpans: number;
  dispositions: Record<string, number>;
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
): NarrationNumberTarget[] {
  return targets.filter((t) => {
    if (!DIGIT.test(t.text)) return false;
    if (t.statedCategory === 'caption' || t.statedCategory === 'footnote') return false;
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
 * What a spoken number may be made of: letters, spaces, and the punctuation a
 * narrator's own transcript carries. Anything else — a digit, a slash, a
 * currency sign, a bracket — means the model did not finish the conversion or
 * smuggled markup through the replacement.
 */
const SPOKEN_WORDS = /^[A-Za-zÀ-ÿ '’,.-]+$/;

/** The abbreviations that make what follows them a page or volume reference. */
const CITATION_LEAD = /(?:^|[\s(\[“"])(?:pp?|vols?|nos?|ibid|cf|fol)\.\s*$/i;

/** A roman-numeral token of two or more characters — "II", "XIV", never "I". */
const ROMAN_TOKEN = /^[IVXLCDM]{2,}$/;

/**
 * The shapes `expandNumbersEnDetailed` reads UNAMBIGUOUSLY, and is therefore
 * allowed to overrule the model on.
 *
 * Bare integers, bare years and dates are deliberately NOT here: those are the
 * ambiguous shapes the model exists for ("1200 people" is twelve hundred, 1200
 * on its own is a year), and letting a rule set that always says "one thousand
 * two hundred" veto the model would undo the whole pass.
 */
const ORACLE_SHAPES: ReadonlyArray<{ name: string; test: RegExp }> = [
  { name: 'currency', test: /[$£€¢]/ },
  { name: 'percent', test: /%/ },
  { name: 'ordinal', test: /\d(?:st|nd|rd|th)\b/i },
  { name: 'decade', test: /(?:\d{4}s\b|['‘’]\d0s\b)/ },
  { name: 'thousands', test: /\d{1,3}(?:,\d{3})+/ },
];

/**
 * A scale word after a currency amount takes the oracle's currency rule out of
 * the "unambiguous" class.
 *
 * Measured against the rule itself (number-expansion.ts rule 3): the scale word
 * WINS over the decimal there, so "$1.5 million" expands to "one million
 * dollars" — the .5 is dropped. That is a real defect in the oracle for this one
 * shape, and it is exactly the shape the prompt teaches as "one point five
 * million dollars". Consulting the oracle here would reject the correct answer,
 * so this shape is left to the model, like the bare integers above it.
 */
const CURRENCY_WITH_SCALE = /[$£€]\s?[\d,.]+\s*(?:hundred|thousand|million|billion|trillion)/i;

/** Strip the punctuation a word wears at a sentence edge, for word comparison. */
function bareWord(token: string): string {
  return token.replace(/^[^A-Za-zÀ-ÿ0-9]+|[^A-Za-zÀ-ÿ0-9]+$/g, '');
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
  const prior = priorTokens.length > 0 ? bareWord(priorTokens[priorTokens.length - 1]) : '';
  const next = nextTokens.length > 0 ? bareWord(nextTokens[0]) : '';
  return ROMAN_TOKEN.test(prior) || ROMAN_TOKEN.test(next);
}

/** Two readings of the same span, compared the way a listener would hear them. */
function sameReading(a: string, b: string): boolean {
  const flat = (s: string): string =>
    s.toLowerCase().replace(/[-’',.]/g, ' ').replace(/\s+/g, ' ').trim();
  return flat(a) === flat(b);
}

/**
 * The deterministic expander's reading of this span, or null when it has no
 * unambiguous opinion about the shape.
 */
export function oracleReadingOf(find: string): string | null {
  const shape = ORACLE_SHAPES.find((s) => s.test.test(find));
  if (shape === undefined) return null;
  if (shape.name === 'currency' && CURRENCY_WITH_SCALE.test(find)) return null;
  const expanded = expandNumbersEnDetailed(find);
  // No expansion, or digits still standing, means the rule set did not consume
  // this span — it has nothing to say about it, which is not a disagreement.
  if (expanded.expansions.length === 0) return null;
  if (DIGIT.test(expanded.text)) return null;
  return expanded.text;
}

/** One span the writer will splice, plus the record that says why. */
interface ValidatedEdits {
  accepted: NarrationTextRewrite[];
  records: NumberEditRecord[];
}

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
): ValidatedEdits {
  const starts: number[] = [];
  let running = 0;
  for (const length of segments) { starts.push(running); running += length; }
  const withinOneNode = (at: number, end: number): boolean =>
    starts.some((start, i) => at >= start && end <= start + segments[i]);

  const accepted: NarrationTextRewrite[] = [];
  const records: NumberEditRecord[] = [];
  const reject = (find: string, replace: string, status: NumberEditStatus, detail?: string): void => {
    records.push(detail === undefined ? { find, replace, status } : { find, replace, status, detail });
  };

  for (const proposed of edits) {
    const find = typeof proposed?.find === 'string' ? proposed.find : '';
    const replace = typeof proposed?.replace === 'string' ? proposed.replace : '';

    if (find === '' || find === replace) { reject(find, replace, 'NOOP'); continue; }

    const at = target.indexOf(find);
    if (at < 0) { reject(find, replace, 'NOT_FOUND'); continue; }
    if (target.indexOf(find, at + 1) >= 0) { reject(find, replace, 'AMBIGUOUS_FIND'); continue; }
    if (!DIGIT.test(find)) { reject(find, replace, 'NO_DIGIT_IN_FIND'); continue; }
    if (DIGIT.test(replace)) { reject(find, replace, 'DIGIT_IN_REPLACE'); continue; }
    if (!SPOKEN_WORDS.test(replace)) { reject(find, replace, 'REPLACE_NOT_WORDS'); continue; }
    if (!keepsEveryWord(find, replace)) { reject(find, replace, 'WORDS_DROPPED'); continue; }
    if (sitsInCitation(target, find, at)) { reject(find, replace, 'CITATION_CODE'); continue; }

    const oracle = oracleReadingOf(find);
    if (oracle !== null && !sameReading(oracle, replace)) {
      reject(find, replace, 'ORACLE_DISAGREE', `the rules read it "${oracle}"`);
      continue;
    }

    const end = at + find.length;
    if (!withinOneNode(at, end)) { reject(find, replace, 'SPANS_MARKUP'); continue; }
    if (accepted.some((a) => at < a.at + a.find.length && a.at < end)) {
      reject(find, replace, 'OVERLAPS_APPLIED');
      continue;
    }

    accepted.push({ find, replace, at });
    records.push({ find, replace, status: 'APPLIED' });
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

/** The model tag, made safe to put in a filename without losing which tag it was. */
export function sanitizeModelTag(model: string): string {
  return model.replace(/[^A-Za-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Where a given input, rule version and model land on disk. */
export function normalizedCopyPaths(
  outDir: string, inputSha16: string, model: string,
): { epubPath: string; recordPath: string } {
  const stem = `${inputSha16}.${NORMALIZER_VERSION}.${sanitizeModelTag(model)}.norm.tts`;
  return {
    epubPath: path.join(outDir, `${stem}.epub`),
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
  options: NumberNormalizationOptions,
): Promise<NumberNormalizationOutcome | null> {
  const { readNarrationNumberTargets, writeNarrationEpub } = await import('./epub-processor.js');

  const bytes = await fs.readFile(inputPath);
  const inputSha16 = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
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

  const targets = await readNarrationNumberTargets(inputPath);
  const selected = selectNumberTargets(targets);
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

  /** One target, decided: what it says, what was proposed for it, what survived. */
  interface PendingTarget {
    target: NarrationNumberTarget;
    status: NumberUnitStatus;
    accepted: NarrationTextRewrite[];
    records: NumberEditRecord[];
    rawAnswer?: string;
  }
  const pending = new Map<string, PendingTarget>();
  let parseFailed = 0;
  let done = 0;

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

  // The window is sized to the longest request this book will make, once, before
  // the model is loaded — see `pinContextTo`.
  const inputs = asked.map((t) => {
    const at = positionOf.get(t.key)!;
    // Only a neighbour of the SAME kind in the SAME file is context: the entry
    // after a contents line is another chapter's name, which says nothing about
    // this one's numbers.
    const sameRun = (offset: number): string | null => {
      const other = targets[at + offset];
      if (other === undefined || other.kind !== t.kind || other.file !== t.file) return null;
      return other.text;
    };
    return buildNormalizerInput(t.text, sameRun(-1), sameRun(1));
  });
  runner.pinContextTo?.(
    options.systemPrompt, inputs.reduce((a, b) => (b.length > a.length ? b : a), ''));

  try {
    for (const [index, target] of asked.entries()) {
      const answer = await askForEdits(runner, options.systemPrompt, inputs[index]);
      if ('parseFail' in answer) {
        parseFailed++;
        pending.set(target.key, {
          target, status: 'UNIT_PARSE_FAIL', accepted: [], records: [], rawAnswer: answer.parseFail,
        });
      } else {
        const { accepted, records } = validateNumberEdits(target.text, target.segments, answer.edits);
        pending.set(target.key, { target, status: 'ANSWERED', accepted, records });
      }
      done++;
      options.onProgress?.(done, asked.length, 'Normalizing numbers');
    }

    if (parseFailed > asked.length * MAX_PARSE_FAIL_SHARE) {
      throw new Error(
        `The number-normalization model '${runner.model}' failed to produce a usable edit list for `
        + `${parseFailed} of ${asked.length} passages. That is a model this pass cannot use, not a `
        + 'hard book: check that the model is pulled and that it answers with JSON.'
      );
    }
  } finally {
    // Before the return, and before e2a is spawned — a completed pass that left
    // 6-17 GB of weights resident is a TTS job waiting on VRAM nothing is using.
    options.onProgress?.(asked.length, asked.length, 'Releasing model');
    await runner.release();
  }

  // ── The heading and its contents entries, made to say ONE thing ───────────
  //
  // e2a matches a body heading against the TOC titles it was handed, to recognize
  // a chapter opening that lost its heading tag, and the m4b's chapter names come
  // from that same list — so the two MUST be the same string. Guaranteed here by
  // construction rather than hoped for: the heading's own edits are offered to
  // every entry that repeats it, and only the edits that validate against EVERY
  // one of them are applied to ANY of them. An edit that will not land on the
  // contents line is taken back off the heading too (`TOC_MISMATCH`), so the two
  // cannot diverge in either direction.
  const groups = new Map<string, NarrationNumberTarget[]>();
  for (const target of selected) {
    if (!isHeadingTarget(target) && !isTocEntry(target)) continue;
    const key = collapseForTocMatch(target.text);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [target]); else list.push(target);
  }
  const editId = (e: { find: string; replace: string }): string => `${e.find}\u0000${e.replace}`;

  for (const [, members] of groups) {
    const headings = members.filter(isHeadingTarget);
    const entries = members.filter(isTocEntry);
    if (headings.length === 0 || entries.length === 0) continue;  // nothing to reconcile
    // The first heading in book order is the proposal. A second heading printing
    // the same words gets the same reading, which is the point.
    const proposal = (pending.get(headings[0].key)?.accepted ?? [])
      .map((e) => ({ find: e.find, replace: e.replace }));
    const survives = new Set(proposal.map(editId));
    for (const member of members) {
      const landed = new Set(
        validateNumberEdits(member.text, member.segments, proposal).accepted.map(editId));
      for (const id of [...survives]) if (!landed.has(id)) survives.delete(id);
    }
    const agreed = proposal.filter((e) => survives.has(editId(e)));

    for (const member of members) {
      const { accepted } = validateNumberEdits(member.text, member.segments, agreed);
      const was = pending.get(member.key);
      const records: NumberEditRecord[] = [];
      if (was !== undefined) {
        // Everything the model said about this member, with the applied edits
        // the group could not agree on demoted by name.
        for (const record of was.records) {
          if (record.status === 'APPLIED' && !survives.has(editId(record))) {
            records.push({
              ...record, status: 'TOC_MISMATCH',
              detail: 'the heading and its contents entry could not both take it',
            });
          } else {
            records.push(record);
          }
        }
      } else {
        for (const edit of proposal) {
          records.push(survives.has(editId(edit))
            ? { ...edit, status: 'APPLIED' }
            : {
              ...edit, status: 'TOC_MISMATCH',
              detail: 'the heading and its contents entry could not both take it',
            });
        }
      }
      pending.set(member.key, {
        target: member,
        status: was === undefined ? 'SHARED_WITH_HEADING' : was.status,
        accepted,
        records,
        ...(was === undefined || was.rawAnswer === undefined ? {} : { rawAnswer: was.rawAnswer }),
      });
    }
  }

  // The record and the rewrite plan, built from the SAME settled decisions, so
  // the copy on disk and the review trail beside it cannot describe two passes.
  const rewrites = new Map<string, NarrationTextRewrite[]>();
  const units: NumberUnitRecord[] = [];
  const dispositions: Record<string, number> = {};
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
    excludeCaptions: true,
    excludeFootnotes: true,
    stripSupMarkers: true,
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
    unitsParseFailed: parseFailed,
    appliedSpans: written.rewrittenSpans,
    dispositions,
    units,
  };
  await fs.writeFile(stagingRecord, JSON.stringify(record, null, 2), 'utf8');
  await fs.rename(stagingRecord, recordPath);
  await fs.rename(stagingEpub, epubPath);

  console.log(
    `[TTS-NUMBERS] ${written.rewrittenSpans} number(s) read as words by ${runner.model} over `
    + `${selected.length} of ${targets.length} passage(s); dispositions `
    + `${JSON.stringify(dispositions)}; the copy is ${epubPath}`);

  return { epubPath, recordPath, reused: false, record };
}
