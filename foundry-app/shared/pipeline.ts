/**
 * The render pipeline — what a RENDERING MEANS, standing anywhere in the history.
 *
 * ── The approximation this file replaced ────────────────────────────────────
 *
 * Until this existed the position affected a rendering through exactly one thing:
 * which `--overlay` the engine was handed (`planConversion` → `overlayForPosition`).
 * Standing on a translation, `curationInEffect` walked past it to the nearest
 * curated ancestor and rendered THE BOOK IT WAS TRANSLATED FROM — the state the
 * translation was taken of, which `shared/ledger.ts` called "the honest
 * approximation" and which is a German book for somebody who clicked the row
 * labelled *Translated (Hungarian)*.
 *
 * ── And the two-stage pipeline that replaced IT, which is also gone ─────────
 *
 * The first fix was a PIPELINE: render the curated book out of the readings bank
 * into a nameless EPUB in the OS temp directory, then hand that file to
 * `translate`, which read it and wrote the real one — plus, for an export, a third
 * run to tidy the result into an edition. Three spawns, two intermediates, and a
 * whole class of failure between them, all of it because a translation WAS A FILE
 * and the only way to get a translated book carrying this position's strikes was
 * to make the book and give it away.
 *
 * A translation is a RECORDS FILE now (docs/WORKBENCH.md §10): one row per flowing
 * block, keyed by the block's own position in the reading bank. So a translated
 * book is CAST rather than converted — one `vlm-convert` over the same bank,
 * through the same reflow, the same curation, the same chapters and the same
 * edition rules as the source, with the records' words in the blocks. What is left
 * of this module is the one question that survived all three designs: WHICH
 * translation, if any, is this position about — and that is still read off the
 * ancestry, which is still the whole of what a position means.
 *
 * ── Why it is pure, and why it is here rather than in `workspace.ts` ────────
 *
 * `shared/ledger.ts`'s reason, one layer up: this decides which files a button
 * press turns into a command line, and a decision like that belongs somewhere a
 * test can reach without an Electron main process. It is also asked from BOTH
 * sides — main composes the plan with it, and the Export dialog asks (through
 * `translationInEffect`) which products can be offered from where somebody stands
 * — and a rule spelled on both sides of an IPC boundary is a rule that drifts.
 *
 * ── The table, which is the contract ────────────────────────────────────────
 *
 *   standing on            rendering
 *   ─────────────────────  ────────────────────────────────────────────────
 *   import                 vlm-convert
 *   read                   vlm-convert + the live overlay
 *   curate (no translate)  vlm-convert + that snapshot
 *   translate              vlm-convert + ancestor curation + THAT ROW'S RECORDS
 *   curate under translate vlm-convert + THIS snapshot + the ancestral records
 *
 * The first three rows are `curationInEffect` exactly as it already answers, and
 * that is deliberate rather than lucky: the walk stops at a `read`, so a position
 * with no translation above it cannot reach this file's answer at all. The two
 * translated rows are the same walk asked one more question — and the last of them
 * is now free, where the pipeline made it a held job that could spend model time.
 */

import {
  curationInEffect,
  positionOf,
  readingInEffect,
  translationInEffect,
} from './ledger';
import type { LedgerStep, ProjectLedger } from './types';

/**
 * The model a translation is asked of when nobody chose one — the engine's own
 * default (`DEFAULT_TRANSLATE_MODEL`, src/translate/run.ts).
 *
 * ── Why it lives in shared/ rather than in the Translate dialog ─────────────
 *
 * It was a constant in `translate-dialog.component.ts`, where it is the value the
 * field opens on, and that was the whole population of askers for as long as a
 * dialog was the only door to a translation. Two copies of a model id is two
 * answers the day somebody bumps one of them, and the way that failure presents is
 * a re-translation quietly asking a different model than the first run did, filling
 * one records file with answers in two voices.
 */
export const DEFAULT_TRANSLATE_MODEL = 'qwen3.8:27b';

/** Ollama's own default port, and where it is unless somebody moved it. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/**
 * What a rendering at the position is made of: one run of `vlm-convert`, and the
 * three answers the ancestry decides about it.
 *
 * Every field is a STEP rather than a path, because this module knows nothing
 * about project directories (`shared/ledger.ts`'s rule, and the reason both of
 * them are testable). Main turns the steps into the paths the engine is handed.
 */
export interface RenderPipeline {
  /**
   * The curation snapshot the run renders with, or null when the answer is the
   * live overlay.
   *
   * `curationInEffect`, unchanged and un-second-guessed. Standing on a `curate`
   * gives that snapshot — including one made UNDER a translation, which is the
   * whole of the user's strike-then-re-render walkthrough; standing on a
   * `translate` walks past it to the curation the translation was made under,
   * which is the state its blocks were numbered in.
   */
  curation: LedgerStep | null;
  /**
   * The reading whose bank the run replays, or null for a project with no reading
   * on the path (a position standing on the import, most of all).
   */
  reading: LedgerStep | null;
  /**
   * The translation whose words go into the blocks, or null for a rendering of the
   * book in its own language.
   *
   * It supplies `--language` (`params.language`) and `--records` (its payload,
   * with `translationRecordsOf`'s legacy answer applied by the caller). NOT a
   * second run: the records are read by the same `vlm-convert` that assembles the
   * book, at the one point where a block's words are written.
   *
   * ── A CHAIN IS FOUND AS ONE ROW, AND THAT IS THE WHOLE OF IT ───────────────
   *
   * `translationInEffect` answers the NEAREST translate step above the position,
   * so standing on the Hungarian row of a German → English → Hungarian chain
   * answers Hungarian and never English. That is exactly right and needs no walk of
   * its own: the Hungarian records already hold Hungarian for every block they
   * answer, because the chain was resolved when they were WRITTEN (the run read the
   * English records as its source, `--source-records`). Materialisation reads one
   * file per book, however many languages it passed through on the way.
   *
   * This is what the one-hop refusal used to sit in front of, and the refusal was
   * honest about the design it guarded: rendering a chained row over EPUBs would
   * have meant `vlm-convert → translate → translate`, two intermediates and a bank
   * chain nothing in this app named — and rendering it in one hop was worse, since
   * that row's bank held English keyed to HUNGARIAN source text, so every block
   * would have missed and the run would have silently re-translated the whole book
   * out of the German. Neither hazard exists over records: there is no second
   * spawn to chain, and a records file is keyed by POSITION, so the only question
   * at materialisation is which file to read.
   */
  translate: LedgerStep | null;
}

/**
 * The ancestry, read as a rendering.
 *
 * ── The refusal that used to be here ────────────────────────────────────────
 *
 * A translation MADE FROM ANOTHER TRANSLATION was refused at this point, with a
 * sentence, and the sentence was true of the pipeline it defended (see
 * `RenderPipeline.translate`). The user reversed the deferral on 2026-08-15 and
 * named the case in their own words — *"if they click the english translation and
 * then click translate to hungarian, it translates from english to hungarian, thus
 * creating a chain of translations: german to english to hungarian"* — and the
 * records design makes the chain the ordinary thing rather than the exception: the
 * chain is resolved once, when the records are written, and every reader afterwards
 * sees one file of answers about one book.
 *
 * So there is nothing to refuse here any more, and a function that cannot throw is
 * a function the Export dialog can ask without a `try` around a computed.
 */
export function renderPipeline(
  ledger: ProjectLedger,
  /**
   * THE STEP THIS RENDERING IS ABOUT, when it is about one rather than about the
   * position — a save's own book, a translation's own book.
   *
   * Both of those are cast by a LANDING rather than by a person pressing a button,
   * and the pointer at that moment is wherever they happen to be standing. Asking
   * the position there would answer with somebody else's chain: the live
   * corrections under a step-shaped name, or the wrong language's records in a book
   * named for this one. Null and absent both mean the position.
   */
  at: LedgerStep | null = null,
): RenderPipeline {
  // Resolved once and handed to all three, rather than left for each of them to
  // ask the position again: a plan is one answer about one place, and three walks
  // that could each answer about a different one is the bug `planRendering`'s
  // single manifest read exists to prevent, one layer down.
  const standing = at ?? positionOf(ledger);
  return {
    curation: curationInEffect(ledger, standing),
    reading: readingInEffect(ledger, standing),
    translate: translationInEffect(ledger, standing),
  };
}

/*
 * `translationStage` USED TO LIVE HERE and went with the second spawn.
 *
 * It turned a `ThenTranslate` into the `TranslateRequest` the queue's `argsFor`
 * knew how to spell, and its argument was a good one: the translate command line
 * has seven flags that were each learned once and expensively (`--bank` most of
 * all, after a 456-block book was killed at block 152 having written nothing), so
 * a second place assembling one is a second place to forget one.
 *
 * There is no second place any more. A translated book is cast by `vlm-convert`
 * with `--records`, and the one remaining `translate` command line is composed by
 * `argsFor` from a request the Translate dialog filled in — which is where it was
 * before a Generate could run the translator, and where the flags have always been
 * spelled exactly once.
 */
