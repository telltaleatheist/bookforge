/**
 * capture-costs — what an apply would cost and touch, derived before anything is pressed.
 */
import { computed } from '@angular/core';
import type { CaptureLines, CaptureRecipe } from '@owen/foundry-core/shared/types';
import { arrangementOf, halvesOf, isWholeFrameTurned, joinedQuad, turnsOf } from '@owen/foundry-core/shared/capture';
import { api } from './foundry';
import { StampCost, PrepareCounts } from './capture-outcomes';
import { turned, isComplete, placed, dressed, paritiesOf, parityOf, linesFor, standings, cutWith } from './capture-geometry';
import type { CaptureService } from './capture.service';

/*
 * A `stage` COMPUTED STOOD HERE AND THE STAGES ARE GONE (Wave 24).
 *
 * It answered whether the editor should open on the one wide button that sets
 * the whole shoot or on the per-page row -- derived from the recipe rather
 * than stored, because a stored stage starts at 1 and would have put somebody
 * returning to fix page 31 in front of the button that stamps over an evening
 * of work.
 *
 * The derivation was right and it has nothing left to decide: there is one
 * control set in that room now, and the thing stage 1 existed to say -- they
 * were all shot the same way, so setting one sets them all -- is said better
 * by the consequence line under Crop all, which gives the actual number.
 */


/**
 * WHAT THE PREPARE RAIL SAYS ABOUT THE BOOK — facts, counted, never judged.
 *
 * The rail's three rows each carry a live status beside a tick. The tick is
 * the PERSON speaking and these numbers are the derivation, and the two are
 * kept apart on purpose: THE DERIVATION NEVER CLEARS A TICK. Nothing here
 * decides whether a step is finished, because two of the three cannot be
 * known and the third would still be answering a question nobody asked.
 *
 * ── There is no "turned" count here, and that is a ruling ──────────────────
 *
 * A turn is a CYCLIC PERMUTATION of a quad's corners (geometry.ts rotate);
 * no orientation is stored anywhere, so "upright" is not merely unrecorded,
 * it is unstatable. A count of turns PERFORMED is derivable -- only rotate
 * moves which corner is corner 0, and halvesOf preserves the roles -- and it
 * was proposed and WITHDRAWN, because a count needs a denominator and a
 * denominator asserts a target. On this shoot the correct final state is
 * twenty-five sideways spreads turned and at least two photographs NOT
 * turned: the framed letters are landscape and the magazine advertisement is
 * portrait, and neither wants a turn. "25 of 27 turned" would read as two
 * left to do, and the rail would spend the project quietly asking him to
 * break two pages that are already right. A progress count without a true
 * denominator is a lie with a number in it.
 */
export function prepare(this: CaptureService) {
  return computed<PrepareCounts>(() => {
  const recipe = this.current();
  if (recipe === null) {
    return { photos: 0, cropped: 0, byHand: 0, complete: 0, split: 0, pagesFromSplits: 0 };
  }
  let cropped = 0;
  let byHand = 0;
  let complete = 0;
  let split = 0;
  let pagesFromSplits = 0;
  for (const photo of recipe.photos) {
    /*
     * THE SHEET, NOT THE PAGES. Two false positives live in the obvious
     * version of this test, and Owen walks straight into both:
     *
     * A SPLIT photograph has no half that is the whole frame -- halvesOf cuts
     * it in two -- so a spread split down the middle and never cropped would
     * count as cropped. joinedQuad reassembles the sheet the halves came
     * from, which is the thing the question is actually about.
     *
     * A TURNED photograph fails an exact whole-frame test as well, because a
     * turn permutes the corners. He turns twenty-five sideways spreads before
     * he places a single corner, so the rail would have told him "25 cropped"
     * the moment he finished turning.
     */
    const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
    if (!isWholeFrameTurned(sheet)) cropped += 1;
    if (photo.pages.some((page) => page.byHand === true)) byHand += 1;
    if (isComplete(photo)) complete += 1;
    if (photo.split !== null) {
      split += 1;
      pagesFromSplits += photo.pages.length;
    }
  }
  return { photos: recipe.photos.length, cropped, byHand, complete, split, pagesFromSplits };
});
}

/**
 * THE BOOK ON THE SHELF WAS MINTED FROM AN EARLIER ARRANGEMENT.
 *
 * False whenever there is nothing to say: no recipe, and -- ruled -- no
 * stored arrangement at all. Absent means SILENCE, which covers three true
 * cases at once (no book, a mint from before the field existed, a book this
 * app did not mint), and either claim in that state would be a false sentence
 * from one direction or the other.
 *
 * THE LIVE SIDE IS COMPUTED FROM THE SAME BODY MAIN MINTS WITH.
 * `arrangementOf` lives in shared/ and `mintBegin` calls the same page plan,
 * so the fingerprint cannot drift from the thing it describes: if the two ever
 * disagree the mint is wrong, not this sentence.
 *
 * AND IT IS A HASH OF THE MINT INPUT, NOT OF THE RECIPE FILE, which is what
 * keeps this surface honest about the feature it sits inside. The ticks and
 * the hand-set marks live in the recipe and the mint never reads them -- so a
 * file hash would light this sentence the moment somebody ticked "Turn
 * pages", answering a person who had just said "yes, I turned them" with
 * "the book on the shelf is out of date".
 */
export function diverged(this: CaptureService) {
  return computed<boolean>(() => {
  const recipe = this.current();
  const minted = this.mintedFrom();
  if (recipe === null || minted === null) return false;
  return arrangementOf(recipe) !== minted;
});
}

/**
 * After a mint: the shelf moved, so re-read what it was minted from.
 *
 * ONLY THAT. It would be one line shorter to re-open the project, and that
 * would replace the recipe this window is holding with the one on disk --
 * which is the same bytes today and would not be the day somebody adjusts a
 * corner while the mint is still running. The sentence is worth a round trip;
 * it is not worth reaching into the work.
 *
 * A failure leaves the old answer standing rather than clearing it: a stale
 * true sentence is better than a false silence, and the next open corrects it.
 */
export async function refreshMintedFrom(this: CaptureService): Promise<void> {
  const directory = this.directory();
  if (api === null || directory === null) return;
  try {
    this.mintedFrom.set((await api.capture.recipeLoad(directory)).mintedFrom);
  } catch {
    // Deliberately quiet: nothing a person did failed, and the mint that just
    // landed has already spoken for itself.
  }
}

/*
 * `outOfTurnWith` STOOD HERE — the count on *Turn the other 24 to match this
 * one* — and went with the button (Wave 51).
 *
 * The number was the whole difference between that press and the ⟲ ⟳ pair
 * beside it, and the press is subsumed: with *Global* ticked a turn already
 * reaches every follower, so the second control would be the same act with a
 * different reach and no visible reason for the difference. The count has
 * nothing left to label.
 */

/*
 * A `stampCost` COUNT STOOD HERE AND WENT WITH THE PRESS IT COUNTED (W25-P3).
 *
 * It answered "how many photographs would end up with THIS photograph's
 * configuration", which is a question only a press with a SOURCE can ask. The
 * modal's *Crop all* was that press; it is a record now, and a record reaches
 * exactly one photograph -- the book's standing -- so there is no population
 * to count and no consequence line to carry one.
 *
 * `applyCost` below is the surviving count and is not this one renamed. It is
 * asked of THE BOOK, from the table, where the propagation now lives.
 */

/**
 * WHAT AN APPLY WOULD COST — the same three populations, asked of THE BOOK.
 *
 * ── Why this is not the old per-source count with a different argument ────
 *
 * Because the act has no source any more. Wave 24's press copied from the
 * photograph somebody happened to be standing on, so the count had to name
 * one; the table's Apply lands THE BOOK'S OWN CROP, which belongs to no
 * photograph and skips none. Every photograph in the project is counted here,
 * the one the standing was lifted from included -- it takes the standing
 * again, harmlessly and exactly, unless it has since been completed.
 *
 * SHAPE IS ASKED FIRST, as it is there, so the three stay disjoint and
 * exhaustive: a complete photograph of another shape is counted once, under
 * the reason the Apply would actually give for leaving it alone.
 *
 * ONE COUNT FOR BOTH PASSES. The crop pass lands the standing's crop and the
 * split pass lands its cut, but both are fractions of the same frame and both
 * skip on the same test, so a second count would be a second chance to
 * disagree with the act. Zero everywhere when the book has no crop yet --
 * there is nothing to apply, and the rail draws no button.
 *
 * IT IS THE MEMBERSHIP'S LENGTHS, not a count of its own. The rail's pressable
 * populations need the MEMBERS and this line needs the NUMBERS, and two walks
 * answering one question is the drift shape this repo has refused by name
 * (Wave 18: "I had written the correct rule once and the wrong rule twice,
 * three functions apart"). So the walk happens once, in `applyPopulations`,
 * and this is arithmetic over its answer -- the sentence and the selection
 * cannot disagree, because they are readings of one thing.
 */
export function applyCost(this: CaptureService) {
  return computed<StampCost>(() => {
  const { takes, complete } = this.applyPopulations();
  return { takes: takes.length, complete: complete.length };
});
}

/**
 * WHO IS IN EACH OF AN APPLY'S TWO POPULATIONS -- photograph ids, disjoint,
 * or two empty lists while the book has no standing crop to measure against.
 *
 * ── THERE WERE THREE UNTIL 2026-09-21, and the third was "a different shape" ─
 *
 * A photograph whose frame was not within two percent of the standing's was
 * left out of every global, because the same fractions are not the same
 * region on it (`sameShape`). That gate was written for a camera, where every
 * frame is one of two shapes and the one landscape frame among the portraits
 * is a different photograph. A scanner is not a camera: its auto-crop gives
 * every page its own size, and on the fragebogen scan -- 271 landscape
 * spreads whose aspects run from 1.15 to 1.33 -- the *Two pages* tick on one
 * spread reached forty-seven of them and the rest had to be ticked one at a
 * time. Owen: *"the 'two pages' button isnt splitting all pages like i
 * expected it to ... even though the 'global' checkbox is checked"*, and the
 * ruling: *"any action i take with the global button checked should apply
 * that action to every page uniformly."*
 *
 * So the shape is no longer asked of anything a global does, here or in the
 * walk (`dressed`). Completeness is the one thing that spares a page, and a
 * page the book's fractions fit badly -- the lone portrait cover in a book of
 * spreads -- is exactly the page a person unticks *Global* to set by hand,
 * which is what makes it complete. `applyCost` above is this answer's
 * lengths; the rail's pressable counts are its members.
 */
export function applyPopulations(this: CaptureService) {
  return computed<Record<keyof StampCost, readonly string[]>>(() => {
  const recipe = this.current();
  const takes: string[] = [];
  const complete: string[] = [];
  if (recipe !== null) {
    const parities = paritiesOf(recipe);
    const cutting = this.pass() === 'split';
    for (const photo of recipe.photos) {
      /*
       * EACH PHOTOGRAPH IS MEASURED AGAINST THE STANDING IT WOULD ACTUALLY
       * WEAR, which is its side's if that side has one (Wave 51b).
       *
       * Asked of the book's own crop alone, this count lies twice the moment
       * anybody uses a parity scope: every odd photograph carrying the odd
       * crop reads as "a different shape" or as a taker of a crop it is never
       * going to be given. The resolution is `linesFor`, the same body the
       * Apply itself resolves through, so the sentence under the button and
       * the act cannot disagree.
       *
       * A PHOTOGRAPH WITH NO STANDING FOR ITS SIDE IS IN NO POPULATION AT
       * ALL — which is new, and is why `StampCost` no longer claims to be
       * exhaustive over the book. It is a real state: place the odd pages'
       * crop first and the even ones have nothing to take yet. Counting them
       * as takers would promise a move that cannot happen; counting them as
       * spared would blame a shape or a hand for a standing nobody has set.
       *
       * AND THE SPLIT PASS ASKS FOR A CUT AS WELL, because that is what its
       * Apply lands. With one standing the two questions had one answer; with
       * a side that is cut and a side that is not they do not, and "22 are cut
       * where the book is cut" said of eleven single pages is the shape of
       * wrongness this count exists to prevent.
       */
      const lines = linesFor(recipe.book, parities.get(photo.id) ?? 'odd');
      const crop = lines?.crop;
      if (crop === undefined) continue;
      if (cutting && lines?.cut === undefined) continue;
      if (isComplete(photo)) complete.push(photo.id);
      else takes.push(photo.id);
    }
  }
  return { takes, complete };
});
}

/**
 * THE LINES THIS PHOTOGRAPH WOULD WEAR — its side's, or the book's own.
 *
 * The one resolution, offered to the surfaces that draw what the book has to
 * say about a photograph: the ghost under the outline, and the cut the *Two
 * pages* tick would take. Undefined means the book has nothing for this side
 * yet, which is a different sentence from "the book has nothing at all" and
 * the callers say so.
 */
export function standingFor(this: CaptureService, photoId: string): CaptureLines | undefined {
  const recipe = this.current();
  if (recipe === null) return undefined;
  return linesFor(recipe.book, parityOf(recipe, photoId));
}

/**
 * THE BOOK'S LINES ARE SPLIT BY SIDE — one sentence's worth of state.
 *
 * The rail's consequence lines say what a press will do, and "N take the
 * book's crop and cut" is one crop and one cut. Once a side has its own, the
 * takers are taking two different rectangles and possibly only one of them a
 * cut, so the sentence names the sides instead of promising a single answer it
 * no longer has. The COUNTS stay exact either way (`applyPopulations`); this
 * governs only the words around them.
 */
export function sided(this: CaptureService) {
  return computed<boolean>(() => {
  const book = this.current()?.book;
  return book?.odd !== undefined || book?.even !== undefined;
});
}

/*
 * `readyToMint` STOOD HERE — the mint gate, every verb ticked — and Owen
 * REVERSED it (2026-08-22): *"sometimes i wont need to do any of the three.
 * if thats the case i should be able to click finish/finalize anyway."* The
 * gate was built the night he minted before turning, and it was right for
 * that night; a shoot of screenshots that needs no turn, no crop and no cut
 * showed its other face — three ceremonial ticks between a person and the
 * one act they came for. Finish is pressable whenever there are pages now,
 * and the ticks below are the record, not the lock.
 */

/**
 * WHAT THE WORK ITSELF SAYS IS DONE — the derived half of the rail's ticks.
 *
 * Owen: *"it should auto-check the one i already worked on."* This amends
 * the standing tick ruling HALFWAY: the old rule was that the derivation
 * never touches a tick because no rule can know the pages are right. That
 * stays true in the direction that matters — nothing here ever CLEARS what
 * a person said — but a turn that was performed, a crop that was placed (or
 * a standing set), a cut that exists are facts, and a box left empty beside
 * work visibly done reads as the app not noticing. The display is
 * said-OR-evident; the person's own tick still covers "I looked and nothing
 * was needed", which no derivation can say.
 */
export function evident(this: CaptureService) {
  return computed<{ turned: boolean; cropped: boolean; split: boolean }>(() => {
  const recipe = this.current();
  if (recipe === null) return { turned: false, cropped: false, split: false };
  let turned = false;
  // A standing anywhere counts, the sides' included: a person who has placed
  // the odd pages' crop has visibly cropped something.
  let cropped = standings(recipe.book).some((lines) => lines.crop !== undefined);
  let split = standings(recipe.book).some((lines) => lines.cut !== undefined);
  for (const photo of recipe.photos) {
    if (turned && cropped && split) break;
    const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
    if (!turned && turnsOf(sheet) !== 0) turned = true;
    if (!cropped && !isWholeFrameTurned(sheet)) cropped = true;
    if (!split && photo.pages.length > 1) split = true;
  }
  return { turned, cropped, split };
});
}

/*
 * THE CUT ITSELF IS ONE BODY, `cutWith`, and it is deliberately the only one.
 *
 * Two paths make exactly the same geometry and mean different things by it: a
 * person sliding the gutter here, and the split pass's Apply landing the
 * book's line on twenty-four photographs. They differ in one bit -- whose line
 * it is -- and the arithmetic behind them must not be two bodies free to
 * drift, which is the ruling that put `joinedQuad`, `sameShape` and
 * `outputSizeFor` in shared/ before it, each after the two had already been
 * written twice.
 */

/*
 * `applyToAll` STOOD HERE AND WAVE 26 CLOSED ITS LAST ARM.
 *
 * By the end it did one thing: *Turn the other 24 to match this one*, a
 * button in the modal that reached every photograph of the same shape. The
 * stamp arm had already gone (W25-P3) to `recordCrop` plus the table's Apply;
 * the turn survived because it is the one global that overwrites nobody's
 * corners, so it never raised the question the stamp did.
 *
 * It is subsumed rather than dropped. `turnWithTheBook` is the same act with
 * the reach *Global* promises -- the followers, and not the pages somebody
 * has taken for their own -- reached from the ⟲ ⟳ pair rather than from a
 * second button whose only difference was a count. The `ApplyToAll` union and
 * the acknowledgement state that lit its button went with it.
 */

/**
 * WHICH PASS THE BOOK IS IN — crop everything, then split everything.
 *
 * Absent is the crop pass, which is where a project starts and where *Reopen
 * crops* returns it; there is no `'crop'` on disk (see `CaptureRecipe.pass`).
 * Answered as a word rather than as a boolean because the surfaces that read
 * it are choosing between two sets of handles, not turning one thing on.
 */
export function pass(this: CaptureService) {
  return computed<'crop' | 'split'>(() => this.current()?.pass ?? 'crop');
}
