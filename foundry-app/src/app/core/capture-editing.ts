/**
 * capture-editing — one page's edits on the light table: quads, turns, crops and the cut.
 */
import type { CapturePrepared, CaptureQuad, CaptureSplit } from '@owen/foundry-core/shared/types';
import { halvesOf, joinedQuad, splitFromFraction, turnQuad, turnsOf, WHOLE_FRAME } from '@owen/foundry-core/shared/capture';
import { announce, namerFor, orderFor } from './capture-outcomes';
import { turned, placed, following, rejoined, GUTTER_REACH, seated, cutWith, wearing } from './capture-geometry';
import type { CaptureService } from './capture.service';

/*
 * A `completeNames` LIST STOOD HERE AND WENT WITH THE QUESTION IT ANSWERED.
 *
 * It named the photographs a stamp would spare, for the dialog that asked
 * whether to overwrite them anyway. Wave 25 removed the subject rather than
 * the sentence: complete photographs are simply left out of every global, and
 * THE GLOBAL TICK, re-ticked, is the explicit door for a person who wants one
 * back in the flow -- a deliberate act on the one photograph they mean, rather
 * than a question at stamp time about a population they have to hold in their
 * head. (Wave 25 spelled that door *Release*; Wave 51 renamed the door and
 * kept the argument.)
 *
 * The names themselves are not lost. `announce` still lists what a global left
 * alone, through `namerFor`, which is where that fallback always lived.
 */

/** Whether the person has ticked one of the rail's three verbs. */
export function ticked(this: CaptureService, verb: keyof CapturePrepared): boolean {
  return this.current()?.prepared?.[verb] === true;
}

/**
 * The person saying they have looked, or taking it back.
 *
 * IT WRITES A BOOLEAN AND LEAVES THE TIDYING TO MAIN. The validator drops
 * unticked verbs rather than storing false, and removes the key entirely once
 * none are set, so the file says what was answered and stays silent about the
 * rest. Repeating that rule here would be a second implementation of it, free
 * to drift the day a fourth verb exists; both readings answer through
 * `=== true`, so an in-memory false and an absent field are the same answer
 * to every caller.
 */
export function tick(this: CaptureService, verb: keyof CapturePrepared): void {
  this.change((recipe) => ({
    ...recipe,
    prepared: { ...recipe.prepared, [verb]: recipe.prepared?.[verb] !== true },
  }));
}

/*
 * `keep` STOOD HERE AND IS GONE, replaced by `matchTheOthers` above.
 *
 * It toggled `byHand`, which is a fact about what a FUTURE PRESS will do, so
 * the only names available for its control were names for a policy: *"Let
 * apply-to-all change it again"*. Owen read it correctly as meaningless. The
 * toggle was also a strange shape -- pressing it once released the page and
 * pressing it again re-marked a page nobody had touched since, so the same
 * control both gave the crop away and took it back with no way to tell which
 * it was about to do.
 *
 * The release survives, named for its outcome and pointed at a noun. The
 * re-mark does not, and does not need to: dragging a corner marks the
 * photograph, so the way to say "this one is mine" is to place it.
 */

/**
 * The editor moved corners on one photograph — WHICH IS WHAT A HAND IS.
 *
 * ── The mark used to wait for a button, and that lost work ──────────────────
 *
 * Only the per-page Apply set `byHand`, so somebody who adjusted page 12's
 * corners and flipped onward without pressing anything had an unprotected
 * crop: the next apply-to-all overwrote it silently and named it in no skip
 * list. That is the one loss the mark exists to prevent, happening on the live
 * path instead of the migration path.
 *
 * And it could not heal. The derivation that infers the mark for old recipes
 * runs only WHILE THE FILE HAS NOT SPOKEN, and the stamp writes `byHand:
 * false` on every page it touches — so the first apply anybody ever pressed
 * switched the inference off for the life of the project, and every drag
 * after that was unprotected for good. The live path was permanently weaker
 * than the migration path, in the direction that costs an evening.
 *
 * ── One rule, two paths ────────────────────────────────────────────────────
 *
 * The migration reads "a quad that is neither the whole frame nor the stamp
 * was dragged". This is the same sentence, written at the moment the drag
 * happens rather than inferred from its result afterwards, and the two must
 * not disagree about what a hand is — two rules for one fact is the shape
 * this feature has paid for repeatedly.
 *
 * ── THE PHOTOGRAPH, NOT THE PAGE ───────────────────────────────────────────
 *
 * A spread is two pages of one picture, and the stamp copies a whole
 * configuration rather than a single quad — so marking only the half whose
 * corner was dragged would leave the other half to be replaced by the next
 * stamp. Half a protection reads as none.
 *
 * ── AND `mine` IS WHERE WAVE 26 PUT THE EXCEPTION ─────────────────────────
 *
 * The paragraphs above are the whole truth about a drag on a photograph the
 * person has taken for their own. They are exactly wrong about a drag made
 * with *Global* ticked, which is the ordinary case: that hand is not fixing
 * ONE frame, it is placing the book's crop and watching every follower take
 * it. Marking there would opt the page out of the standing it is authoring —
 * the same trap `cutHere` measured in Wave 24, arriving through the corners.
 *
 * So the flag says which hand this is, and it is the caller's to say because
 * only the surface knows whether the tick was on. False writes `byHand:
 * false` rather than leaving the old mark, exactly as `wearing` does: a page
 * moving with the book says nothing about itself.
 */
export function setQuads(this: CaptureService, photoId: string, quads: readonly CaptureQuad[], mine = true): void {
  this.change((recipe) => ({
    ...recipe,
    photos: recipe.photos.map((photo) =>
      photo.id !== photoId
        ? photo
        : placed({
            ...photo,
            pages: photo.pages.map((page, index) => ({
              ...page,
              quad: quads[index] ?? page.quad,
              byHand: mine,
            })),
          }),
    ),
  }));
}

/**
 * Turn photographs where they sit on the table — the grid's own act.
 *
 * ── It is the same turn the editor makes, through the same body ────────────
 *
 * `turnQuad` permutes the corner assignment without moving a corner, so a
 * turn from the table and a turn from the editor cannot come out differently:
 * there is one answer to "which way round is this page" and it is `turnsOf`
 * reading the order these four points are in. A second rotation written here
 * would be a second opinion about the same photograph.
 *
 * ── AND IT CLAIMS NOTHING, WHICH IS A REVERSAL (Wave 51) ──────────────────
 *
 * It used to mark every page by hand, on the argument that a later global
 * would otherwise undo a turn somebody performed deliberately. `turned` above
 * carries the whole correction: no global crop has ever been able to undo a
 * turn, and the false protection claimed the twenty-five photographs a person
 * stands upright before they have placed a single corner — which under the
 * *Global* tick would leave the book's crop reaching nobody at all.
 *
 * So this puts a photograph the right way up and says nothing about whose
 * lines it holds. Every page of the photograph is turned, not the one that was
 * clicked: a spread is two pages of one picture.
 */
export function turnPhotos(this: CaptureService, photoIds: readonly string[], turns: number): void {
  const wanted = new Set(photoIds);
  if (wanted.size === 0) return;
  this.change((recipe) => ({
    ...recipe,
    photos: recipe.photos.map((photo) => (wanted.has(photo.id) ? turned(photo, turns) : photo)),
  }));
}

/**
 * TAKE THE CROP OFF THIS PHOTOGRAPH -- Owen: "we should be able to disable
 * crop/split on any single page, or on all pages, if we dont want to do it,
 * in case one page doesnt need it".
 *
 * ── IT REMOVES THE MARK, IT DOES NOT DISABLE IT ────────────────────────────
 *
 * docs/CAPTURE.md, "Marks, then Finalize": no crop IS the whole frame, which
 * this recipe already understands and `isWholeFrame` already reads. A
 * `disabled: true` beside a stored rectangle would be a crop that is kept,
 * drawn, applied to all and then ignored -- and A SETTING THAT IS IGNORED IS
 * A SETTING THAT WILL BE BELIEVED. So "disable" is UNDO, and there is no
 * second state for anything to fall out of step with.
 *
 * ── AND THERE IS NO SEPARATE "ALL PAGES" ACT, BY CONSTRUCTION ──────────────
 *
 * Clearing the crop here leaves this photograph holding the whole frame, and
 * apply-to-all copies THIS photograph's configuration onto the others. So
 * "none of them need a crop" is already spelled: clear it here, then apply to
 * all. A second bulk act would be a second path to the same recipe, and the
 * two would eventually disagree about split pages.
 *
 * A CUT SURVIVES ITS CROP. Removing the crop from a spread means "use the
 * whole photograph", not "un-cut it" -- so the halves are re-derived from the
 * whole frame and the gutter stays exactly where it was put.
 */
export function clearCrop(this: CaptureService, photoId: string): void {
  this.change((recipe) => ({
    ...recipe,
    photos: recipe.photos.map((photo) => {
      if (photo.id !== photoId) return photo;
      if (photo.split === null || photo.pages.length !== 2) {
        return placed({
          ...photo,
          pages: photo.pages.map((page) => ({ ...page, quad: WHOLE_FRAME, byHand: true })),
        });
      }
      const halves = halvesOf(WHOLE_FRAME, photo.split);
      if (halves === null) return photo;
      return placed({
        ...photo,
        pages: photo.pages.map((page, seat) => ({
          ...page,
          quad: halves[seat] ?? page.quad,
          byHand: true,
        })),
      });
    }),
  }));
}

/**
 * PUT A CUT SPREAD BACK TOGETHER — one page again, keeping its crop.
 *
 * The inverse of `setSplit` and the same sentence as `clearCrop`: no split is
 * `split: null` with one page, which is what an uncut photograph already is,
 * so removing a cut needs no state that says a cut is present-but-off.
 *
 * The rejoined page keeps the crop the two halves were describing —
 * `joinedQuad` is the same body the editor draws from and `setSplit` re-cuts
 * from, so joining and re-cutting are exact inverses rather than two
 * approximations that drift apart over a few adjustments.
 *
 * A STRIKE ON EITHER HALF STRIKES THE PAGE. Rejoining two pages of which one
 * was struck cannot keep half a strike, and dropping it would quietly
 * restore a page somebody had rejected — so the surviving page is struck if
 * either half was, which is the answer that cannot lose a decision.
 */
export function clearSplit(this: CaptureService, photoId: string): void {
  this.change((recipe) => {
    const photos = recipe.photos.map((photo) => {
      if (photo.id !== photoId || photo.split === null) return photo;
      const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
      return placed({
        ...photo,
        split: null,
        pages: [{
          id: `${photo.id}:0`,
          quad: whole,
          struck: photo.pages.some((page) => page.struck),
          byHand: true,
        }],
      });
    });
    // A rejoin changes which pages exist, exactly as a cut does.
    return { ...recipe, photos, order: orderFor(photos, recipe.order) };
  });
}

/**
 * THE TICK: cut this photograph in two, WHERE THE BOOK IS CUT.
 *
 * ── Taking the book's cut is FOLLOWING it, not diverging from it ──────────
 *
 * This is a separate door from `setSplit` for one reason, and it is a reason
 * the walk found rather than one anybody argued in advance. Every cut used to
 * mark the photograph hand-set, which was right while cutting was a deliberate
 * per-page act reached through a button. The tick makes it the ordinary way to
 * say "this one is a spread too" -- and MEASURED on the scratch shoot, ticking
 * a photograph so it took the book's own cut then excluded it from every
 * future Crop all. Accepting the standing opted you out of the standing.
 *
 * So the mark follows where the cut CAME FROM. The book's cut leaves the
 * photograph following; the middle is a placement, because with no standing
 * there is nothing to follow and this press is what invents the answer.
 *
 * IT NEVER CLEARS A MARK SOMEBODY ELSE EARNED. A photograph whose CROP was
 * placed by hand keeps its mark through this, because the crop is still
 * theirs -- taking the book's cut says nothing about the corners.
 */
export function cutHere(this: CaptureService, photoId: string): void {
  const recipe = this.current();
  const photo = recipe?.photos.find((one) => one.id === photoId);
  if (recipe === null || photo === undefined) return;
  const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const book = this.bookCutFor(photoId);
  /*
   * THE MIDDLE, MOVED ONTO THE FOLD IF THERE IS ONE TO SEE.
   *
   * With no standing to follow, this press is what invents the line, and
   * "the middle" was only ever the least-wrong place to invent it. A page
   * whose fold has been measured has a better answer, and `seated` is the
   * same body that moves the book's line onto it -- including its refusals,
   * so a page with no measurement, no visible fold, or a fold further than
   * `GUTTER_REACH` from the middle still gets the middle exactly as before.
   *
   * IT IS STILL A PLACEMENT AND STILL MARKS THE PHOTOGRAPH ITS OWN (`mine`
   * is `book === null`, unchanged). The fold is an estimate from pixels, not
   * a decision by the book, so a line placed on it is this press's line: the
   * alternative would leave the page a follower of a standing that does not
   * exist, and the next Apply would move it.
   */
  const middle = splitFromFraction(sheet, 0.5);
  this.setSplit(photoId, book ?? seated(photo, sheet, middle), book === null);
}

/**
 * The editor dragged one end of the gutter, or slid the whole cut.
 *
 * `mine` is what the cut MEANS about this photograph -- see `cutHere`. It
 * defaults to a placement, and two callers pass false: the tick taking the
 * book's own cut, and a drag made with *Global* ticked, which is the book's
 * hand rather than this page's (see `setQuads`, where the same exception is
 * argued at length). Even then a mark the CROP earned survives.
 *
 * AND IT NOW DECIDES ONE MORE THING: whether this page's own fold may move
 * the line a few pixels as it lands (`seated`, and the docblock inside
 * `cutWith` on what that means for a drag made with *Global* on).
 */
export function setSplit(this: CaptureService, photoId: string, split: CaptureSplit, mine = true): void {
  this.change((recipe) => {
    const photos = recipe.photos.map((photo) => {
      if (photo.id !== photoId) return photo;
      /*
       * PLACED ONLY WHEN THE CUT IS THIS PERSON'S, which is the same
       * distinction `mine` has drawn since Wave 24 and now decides one more
       * thing. A slid gutter completes the photograph, so it deletes any
       * explicit answer and lets the derive speak; the tick taking the book's
       * own cut decides nothing about this photograph and must leave a say-so
       * or a release exactly as it found it.
       */
      // Where the hand let go, on this page, whichever way *Global* is: the
      // followers seat the line on their own folds (`cutWith`, `seat`).
      const cut = cutWith(photo, split, mine, false);
      return cut === null ? photo : (mine ? placed(cut) : cut);
    });
    // A split changes which pages exist, so the order grows with it.
    return { ...recipe, photos, order: orderFor(photos, recipe.order) };
  });
}
