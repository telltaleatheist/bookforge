/**
 * narration-text-pass.ts — the narration text cleanup, as ONE step the user runs
 * and the book remembers.
 *
 * ── The ruling this file exists for ─────────────────────────────────────────
 *
 * Owen, 2026-09-04: *"We should make this its own intentional step that the user
 * runs and persists, so we don't have to run it again. It runs the step on an
 * epub that foundry exported/completed and it creates an updated epub. This
 * should be a foundry step that's necessary before it goes to TTS."*
 *
 * Until now the text cleaning happened INSIDE the render door
 * (`prepareNarrationInput`), on a content-addressed scratch copy nobody could
 * see, once per render, and — for the punctuation half — not at all. So a book
 * that was never `--ai-cleanup`ed reached the voice with its curly quotes and
 * its printed ellipses intact, and an hour of model time on the numbers was
 * spent again every time the render's input changed by a byte.
 *
 * This is that work, moved onto the document chain beside simplify, translate
 * and the footnote-reference strip: a pass the user queues, that writes a new
 * book, that is recorded in the ledger with a reviewable receipt, and that
 * STAMPS the book so every consumer downstream can tell it ran.
 *
 * ── The three stages, in this order, and the order is load-bearing ──────────
 *
 *   1. PUNCTUATION — `electron/tts-punctuation.ts`, spec s1. The canonical
 *      ellipsis, the quote map, the invisibles, the space variants. Pure and
 *      instant.
 *   2. THE NUMBER RULES — `electron/tts-number-rules.ts`. The shapes a narrator's
 *      reading is GUARANTEED, done in code.
 *   3. THE MODEL, on the residue — `electron/tts-number-normalizer.ts`. Its
 *      validators, its retry rules, its parse-failure gate, its record. NOT
 *      forked: stages 2 and 3 are that module, called with the punctuated book.
 *
 * Punctuation must run FIRST and cannot run last: `normalizeQuotes` turning a
 * U+2026 into "..." after `applyNumberRules` had computed offsets would
 * invalidate every one of them.
 *
 * ── Why the two stages are two WRITES and not one ───────────────────────────
 *
 * Stage 1 produces offsets into the printed book; stages 2-3 produce offsets
 * into the punctuated one, and the number rules' own `find` strings routinely
 * contain characters stage 1 created (`"250 members` opens with a quote the
 * printed book set curly). Composing the two into one rewrite list against the
 * printed text would mean either refusing every number that stands next to a
 * canonicalized quote, or hand-merging overlapping spans — a second coordinate
 * system to keep true. So stage 1 writes a book and stages 2-3 read it. Each
 * write is `writeNarrationEpub`, which proves every rewrite landed or destroys
 * its output; the intermediate is content-addressed and reused.
 *
 * ── Text only, and the book keeps everything ────────────────────────────────
 *
 * `excludeCaptions`, `excludeFootnotes` and `stripSupMarkers` are all OFF here,
 * against `writeNarrationEpub`'s own defaults. This pass edits THE BOOK, on the
 * chain, so it may change TEXT and must never add, remove or reorder an element
 * — that is the invariant `registerLedgerPass` and `verifyNarrationCarry` both
 * check, and a pass that failed it would move every narration strike the user
 * ever made onto the wrong paragraph. The caption/endnote/marker cut stays where
 * it is: in the render door, on the second file, which is what it always was.
 */
import * as crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';

import { diffChars } from 'diff';

import { bookDigest } from './sidecar-binding.js';
import {
  canonicalizePunctuation, PUNCTUATION_SPEC_VERSION,
} from './tts-punctuation.js';
import { NORMALIZER_VERSION, normalizeNarrationNumbers } from './tts-number-normalizer.js';
import type {
  NumberNormalizationProgress, NumberNormalizationRecord, NumberNormalizerRunner,
} from './tts-number-normalizer.js';
import type { NarrationNumberTarget, NarrationTextRewrite } from './epub-processor.js';

/**
 * The version of THIS pass's own staging, in the intermediate's filename.
 *
 * Bumped when the punctuation stage's shape changes — which today means when
 * `PUNCTUATION_SPEC_VERSION` changes, and the name carries that directly rather
 * than a second constant to keep in step.
 */
function punctuatedStem(inputSha16: string): string {
  return `${inputSha16}.${PUNCTUATION_SPEC_VERSION}.punct.tts`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The receipt
// ─────────────────────────────────────────────────────────────────────────────

/** One punctuation span the pass could read but was not allowed to apply. */
export interface PunctuationRefusal {
  /** The element the span sits in. */
  key: string;
  file: string;
  /** What the book prints there. */
  find: string;
  /** What the canonical form would have been. */
  replace: string;
  reason: string;
}

/** What the punctuation stage did to a book. */
export interface PunctuationStageRecord {
  spec: string;
  /** How many of the book's texts changed at all. */
  targetsChanged: number;
  /** How many spans were rewritten. */
  spansApplied: number;
  /** Per rule name, how many times it fired — `PUNCTUATION_RULES` are the keys. */
  counts: Record<string, number>;
  /** Spans that would have had to cross an `<em>` or a `<sup>`. Never silent. */
  refused: PunctuationRefusal[];
}

/**
 * The frozen diff this pass hands the ledger and the CLI.
 *
 * Everything a reviewer needs to judge the pass without re-running it: which
 * punctuation rule fired how often, every model edit and the verdict the
 * validator gave it (that is `numbers.units[].edits[].status`), everything
 * refused, and the three versions that together say WHICH pass this was.
 */
export interface NarrationTextReceipt {
  /** `NORMALIZER_VERSION` — the number rules and the prompt. */
  normalizerVersion: string;
  /** `PUNCTUATION_SPEC_VERSION` — the punctuation half. */
  punctuationSpec: string;
  /** The model tag that read the residue. */
  model: string;
  at: string;
  /** The book this pass read. */
  source: string;
  /** Its content address — the sha16 of the file, or of the folder's tree. */
  inputSha16: string;
  punctuation: PunctuationStageRecord;
  /**
   * The number pass's own record, verbatim — every unit, every proposed edit and
   * its disposition. Null when the book printed no digit a narrator reads, which
   * is the number pass's "passed through untouched".
   */
  numbers: NumberNormalizationRecord | null;
  /** Where that record sits on disk, for the reviewer who wants the whole file. */
  numbersRecordPath: string | null;
  /** Did the book's TEXT change at all? (The stamp changes regardless.) */
  changed: boolean;
}

/** What the pass produced. */
export interface NarrationTextPassResult {
  /** The stamped book. Always written; never the input path. */
  outPath: string;
  receipt: NarrationTextReceipt;
  /** True when the number stage reused a copy already on disk (no model call). */
  reusedNumbers: boolean;
}

export interface NarrationTextPassOptions {
  /** The book to read: an `.epub` file, or a working copy that is a folder. */
  epubPath: string;
  /** Where the updated book goes. Must not be the input. */
  outPath: string;
  /** Where the intermediates and the number pass's record live. */
  cacheDir: string;
  /** The number prompt, loaded by the caller so this module guesses no path. */
  systemPrompt: string;
  /** The model tag — part of the cache path, the stamp and every message. */
  model: string;
  /**
   * The model call, injected the way the number pass injects it, so the whole
   * pass is reachable from a test with no GPU. Production passes the Ollama
   * runner built from the Settings tag.
   */
  runner: NumberNormalizerRunner;
  onProgress?: NumberNormalizationProgress;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — punctuation, as spans the writer can splice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The character spans that turn `before` into `after`, at their offsets in
 * `before`.
 *
 * `diffChars` from the `diff` package — the same library `computeCompactDiff`
 * uses for the pass diffs — grouped so that a removal and the insertion beside
 * it are ONE replacement rather than two edits at the same offset. The offsets
 * are in the BEFORE text because that is the text the book prints and the writer
 * splices into.
 *
 * A pure insertion (an empty `find`) is impossible here: every punctuation rule
 * either deletes characters or replaces them, so an empty find would mean the
 * grouping below is wrong, and it THROWS rather than writing a span the writer
 * would have to guess a home for.
 */
export function punctuationSpans(before: string, after: string): NarrationTextRewrite[] {
  if (before === after) return [];
  const parts = diffChars(before, after);
  const out: NarrationTextRewrite[] = [];
  let at = 0;
  let i = 0;
  while (i < parts.length) {
    if (!parts[i].added && !parts[i].removed) {
      at += parts[i].value.length;
      i++;
      continue;
    }
    const start = at;
    let find = '';
    let replace = '';
    while (i < parts.length && (parts[i].added === true || parts[i].removed === true)) {
      if (parts[i].removed === true) {
        find += parts[i].value;
        at += parts[i].value.length;
      } else {
        replace += parts[i].value;
      }
      i++;
    }
    if (find === '') {
      throw new Error(
        `The punctuation stage produced an INSERTION of "${replace}" at ${start}, and every rule `
        + 'it runs either deletes or replaces. Nothing was written.');
    }
    out.push({ at: start, find, replace });
  }
  return out;
}

/** Which text node of a target a span sits in, or -1 when it crosses one. */
function nodeHolding(segments: readonly number[], at: number, end: number): number {
  let start = 0;
  for (let i = 0; i < segments.length; i++) {
    if (at >= start && end <= start + segments[i]) return i;
    start += segments[i];
  }
  return -1;
}

/** What the punctuation stage settled about one of a book's texts. */
interface PunctuatedTarget {
  rewrites: NarrationTextRewrite[];
  counts: Record<string, number>;
  refused: PunctuationRefusal[];
}

/**
 * Canonicalize one target's punctuation, as spans the writer may splice.
 *
 * The canonicalization is computed over the WHOLE text of the element, never per
 * text node: `. . .` can straddle an `<em>`, and a node's end is not a line's end
 * — stripping "trailing" whitespace at the end of a node that has an `<em>` after
 * it would weld two words together. Spans that then turn out to cross a node
 * boundary are REFUSED and recorded, exactly as the number rules refuse theirs,
 * because reaching across the boundary means flattening the element to get at
 * the characters.
 */
export function punctuateTarget(target: NarrationNumberTarget): PunctuatedTarget {
  const outcome = canonicalizePunctuation(target.text);
  if (outcome.text === target.text) return { rewrites: [], counts: {}, refused: [] };

  const rewrites: NarrationTextRewrite[] = [];
  const refused: PunctuationRefusal[] = [];
  for (const span of punctuationSpans(target.text, outcome.text)) {
    if (nodeHolding(target.segments, span.at, span.at + span.find.length) < 0) {
      refused.push({
        key: target.key, file: target.file, find: span.find, replace: span.replace,
        reason: 'the span crosses a text-node boundary — an <em>, a <sup> or a link sits in it',
      });
      continue;
    }
    rewrites.push(span);
  }
  // The counts describe the canonicalization the rules found, which is what the
  // audit compares against the corpora; the refusals above say which of them did
  // not make it into the book.
  return { rewrites, counts: outcome.counts, refused };
}

/**
 * Write the punctuated book, or hand back the input when nothing changed.
 *
 * Content-addressed and reused for the number pass's own reason: the same book
 * and the same spec make the same file, so a second run of this pass over an
 * unchanged book costs one hash instead of one zip.
 */
async function punctuateBook(
  inputPath: string,
  inputSha16: string,
  cacheDir: string,
  targets: readonly NarrationNumberTarget[],
): Promise<{ punctuatedPath: string; record: PunctuationStageRecord }> {
  const { writeNarrationEpub } = await import('./epub-processor.js');

  const rewrites = new Map<string, readonly NarrationTextRewrite[]>();
  const counts: Record<string, number> = {};
  const refused: PunctuationRefusal[] = [];
  let spansApplied = 0;
  for (const target of targets) {
    const settled = punctuateTarget(target);
    for (const [rule, n] of Object.entries(settled.counts)) {
      counts[rule] = (counts[rule] ?? 0) + n;
    }
    refused.push(...settled.refused);
    if (settled.rewrites.length === 0) continue;
    rewrites.set(target.key, settled.rewrites);
    spansApplied += settled.rewrites.length;
  }

  const record: PunctuationStageRecord = {
    spec: PUNCTUATION_SPEC_VERSION,
    targetsChanged: rewrites.size,
    spansApplied,
    counts,
    refused,
  };

  if (rewrites.size === 0) {
    console.log(
      `[NARRATION-TEXT] ${path.basename(inputPath)} already prints canonical punctuation — `
      + 'the book passes through this stage untouched.');
    return { punctuatedPath: inputPath, record };
  }

  const punctuatedPath = path.join(cacheDir, `${punctuatedStem(inputSha16)}.epub`);
  try {
    await fs.access(punctuatedPath);
    console.log(
      `[NARRATION-TEXT] ${spansApplied} punctuation span(s) already canonical in a copy on disk `
      + `(reused): ${punctuatedPath}`);
    return { punctuatedPath, record };
  } catch { /* not punctuated yet */ }

  await fs.mkdir(cacheDir, { recursive: true });
  // Staged and renamed into place, so a process that dies mid-write cannot leave
  // a truncated file under the name the reuse branch above trusts.
  const staging = path.join(cacheDir, `${inputSha16}.staging-${crypto.randomUUID()}.epub`);
  const written = await writeNarrationEpub(inputPath, staging, [], {
    // TEXT ONLY. See this file's header: the book keeps its captions, its notes
    // and its reference markers, whatever the render door will later cut.
    excludeCaptions: false,
    excludeFootnotes: false,
    stripSupMarkers: false,
    rewrites,
  });
  if (written.rewrittenSpans !== spansApplied) {
    throw new Error(
      `The punctuation stage planned ${spansApplied} span(s) and the writer applied `
      + `${written.rewrittenSpans}. Those describe two different books; nothing was written.`);
  }
  await fs.rename(staging, punctuatedPath);
  console.log(
    `[NARRATION-TEXT] ${spansApplied} punctuation span(s) canonicalized over `
    + `${rewrites.size} passage(s) — ${JSON.stringify(counts)}; the copy is ${punctuatedPath}`);
  return { punctuatedPath, record };
}

// ─────────────────────────────────────────────────────────────────────────────
// The pass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole narration text cleanup, over one book, ending in a stamped file.
 *
 * ALWAYS writes `outPath`, even when no text changed, because the STAMP is a
 * change: it is what the render door reads to know this pass ran, and a book
 * that came out unstamped because it happened to print no digits and no curly
 * quotes would be refused at render time forever. The caller decides whether a
 * text-unchanged run is worth a ledger row (`electron/processing-passes.ts`
 * refuses one when the book was already stamped at this version).
 *
 * Throws, by name, on anything it cannot promise. There is no path here that
 * produces a book quietly missing part of the work.
 */
export async function runNarrationTextPass(
  options: NarrationTextPassOptions,
): Promise<NarrationTextPassResult> {
  const {
    readNarrationNumberTargets, writeNarrationTextStamp,
  } = await import('./epub-processor.js');

  if (path.resolve(options.epubPath) === path.resolve(options.outPath)) {
    throw new Error(
      'The narration text pass was asked to write its result over the book it is reading '
      + `(${options.outPath}). The book it read is what every refusal in the record is measured `
      + 'against. Nothing was written.');
  }

  const at = new Date().toISOString();
  const inputSha16 = (await bookDigest(options.epubPath)).hex.slice(0, 16);
  const targets = await readNarrationNumberTargets(options.epubPath);

  // ── Stage 1 ───────────────────────────────────────────────────────────────
  options.onProgress?.(0, 1, 'Canonicalizing punctuation');
  const { punctuatedPath, record: punctuation } =
    await punctuateBook(options.epubPath, inputSha16, options.cacheDir, targets);

  // ── Stages 2 and 3, the number pass, unforked ─────────────────────────────
  //
  // Its content address is the PUNCTUATED book's, not the printed book's: the
  // text the rules and the model read is that one, and naming the copy after the
  // book they did not read is how a cache lies.
  const numbersInputSha16 = punctuatedPath === options.epubPath
    ? inputSha16
    : (await bookDigest(punctuatedPath)).hex.slice(0, 16);
  const outcome = await normalizeNarrationNumbers(punctuatedPath, options.runner, {
    systemPrompt: options.systemPrompt,
    outDir: options.cacheDir,
    inputSha16: numbersInputSha16,
    // TEXT ONLY — the same refusal the punctuation write makes, for the same
    // reason: this is the book, not the narration copy.
    copy: { excludeCaptions: false, excludeFootnotes: false, stripSupMarkers: false },
    // EVERY BLOCK. Owen, 2026-09-04: "send every single block through to be
    // sure. I suspect deterministic decisions on this aren't the right way to do
    // it. Let the model decide what should be updated." One model call per block
    // of the book, and the answer may name an abbreviation, an acronym, a
    // bracketed aside, a spaced hyphen or a roman numeral as well as a number.
    // That cost is accepted for this pass because the pass runs ONCE and the
    // book keeps the result.
    ask: 'every-block',
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });

  const cleanedPath = outcome === null ? punctuatedPath : outcome.epubPath;

  // ── The stamp, which is what makes the pass PERSIST ───────────────────────
  options.onProgress?.(1, 1, 'Stamping the book');
  await fs.mkdir(path.dirname(options.outPath), { recursive: true });
  await writeNarrationTextStamp(cleanedPath, options.outPath, {
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model: options.model,
    at,
  });

  const receipt: NarrationTextReceipt = {
    normalizerVersion: NORMALIZER_VERSION,
    punctuationSpec: PUNCTUATION_SPEC_VERSION,
    model: options.model,
    at,
    source: options.epubPath,
    inputSha16,
    punctuation,
    numbers: outcome === null ? null : outcome.record,
    numbersRecordPath: outcome === null ? null : outcome.recordPath,
    changed: punctuation.spansApplied > 0
      || (outcome !== null && outcome.record.appliedSpans > 0),
  };

  console.log(
    `[NARRATION-TEXT] ${punctuation.spansApplied} punctuation span(s) and `
    + `${outcome === null ? 0 : outcome.record.appliedSpans} reading(s) — `
    + `${outcome === null ? 0 : outcome.record.appliedByRules} by rule, `
    + `${outcome === null ? 0 : outcome.record.appliedByModel} by ${options.model}; `
    + `by class ${JSON.stringify(outcome === null ? {} : outcome.record.appliedByClass)}; `
    + `stamped ${NORMALIZER_VERSION}/${PUNCTUATION_SPEC_VERSION}: ${options.outPath}`);

  return { outPath: options.outPath, receipt, reusedNumbers: outcome?.reused === true };
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate — what a consumer asks of a book before it narrates it
// ─────────────────────────────────────────────────────────────────────────────

/** Why a book may not be narrated yet, or null when it may. */
export type NarrationTextGate =
  | { ok: true; stamp: { normalizerVersion: string; punctuationSpec: string; model: string } }
  | { ok: false; state: 'missing' | 'stale'; reason: string };

/**
 * Has this book been through the narration text pass, at the version this build
 * runs?
 *
 * The stamp on the file, and nothing else. The ledger says a pass ran on a
 * PROJECT; the render door is handed a FILE — by the queue, by the CLI, by a
 * batch chain on another machine — and the file has to be able to answer for
 * itself.
 *
 * A stamp from an older version is 'stale' and not 'missing', and the difference
 * is the whole of the message: "run it" and "run it again" are different
 * instructions to a user who believes they already did.
 */
export async function narrationTextGate(bookPath: string): Promise<NarrationTextGate> {
  const { readNarrationTextStamp } = await import('./epub-processor.js');
  const stamp = await readNarrationTextStamp(bookPath);
  const book = path.basename(bookPath);
  if (stamp === null) {
    return {
      ok: false,
      state: 'missing',
      reason: `${book} has not been through the narration text cleanup, so its punctuation is `
        + 'whatever the book printed and its numbers are still digits. Run "Narration text '
        + 'cleanup" on this book first — it is the step that makes the text the voice reads.',
    };
  }
  if (stamp.normalizerVersion !== NORMALIZER_VERSION
    || stamp.punctuationSpec !== PUNCTUATION_SPEC_VERSION) {
    return {
      ok: false,
      state: 'stale',
      reason: `${book} was cleaned by an older narration text pass `
        + `(${stamp.normalizerVersion}/${stamp.punctuationSpec}; this build runs `
        + `${NORMALIZER_VERSION}/${PUNCTUATION_SPEC_VERSION}), so parts of it would be narrated by `
        + 'rules this build no longer uses. Run "Narration text cleanup" again.',
    };
  }
  return {
    ok: true,
    stamp: {
      normalizerVersion: stamp.normalizerVersion,
      punctuationSpec: stamp.punctuationSpec,
      model: stamp.model,
    },
  };
}
