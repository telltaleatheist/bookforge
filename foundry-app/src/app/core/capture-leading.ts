/**
 * capture-leading — one page's cut leading the rest of the book: matching, following, turning and resetting.
 */
import type { CapturePhoto, CaptureRecipe, CaptureSplit, CaptureStanding } from '@owen/foundry-core/shared/types';
import { turnQuad, turnsOf, WHOLE_FRAME } from '@owen/foundry-core/shared/capture';
import { announce, handedBack, orderFor } from './capture-outcomes';
import { turned, isComplete, placed, dressed, paritiesOf, parityOf, linesFor, standings, withCut, following, uncropped, rejoined, seated, cutWith, standingOf, wearing } from './capture-geometry';
import type { CaptureService } from './capture.service';

/**
 * THE BOOK'S CUT, if this photograph is one it could apply to.
 *
 * ── The cut is fractions, and the shape is NO LONGER part of the question ─
 *
 * A cut is two points in a frame's own fraction space, exactly like a crop.
 * Until 2026-09-21 it was offered only to a frame within two percent of the
 * standing's, on the argument that the same fractions land somewhere
 * plausible and wrong on another proportion. On a scanned book that withheld
 * the offer from most of the book (see `applyPopulations` for the ruling),
 * and a cut offered to a page of another proportion lands NEAR the gutter
 * rather than on it -- which is what the line is there to be dragged for.
 * Since 2026-09-21 it often lands ON it without being dragged: the landing
 * seats the line on the fold the page can be seen to have (`seated`).
 *
 * Null whenever there is nothing to offer -- no standing yet, or a book of
 * single pages -- and the caller falls back to the middle and SAYS SO. The
 * two are different offers and the surface must not present them as one.
 */
export function bookCutFor(this: CaptureService, photoId: string): CaptureSplit | null {
  const recipe = this.current();
  if (recipe === null) return null;
  // THIS PHOTOGRAPH'S SIDE OF THE BOOK, since Wave 51b. A book whose odd pages
  // are spreads and whose even ones are single sheets has two answers here,
  // and offering the wrong side's line would put the gutter down the middle of
  // a page rather than down the fold.
  const lines = linesFor(recipe.book, parityOf(recipe, photoId));
  // A cut with no crop beside it is a state the passes cannot write -- the
  // crop pass lifts both off one photograph and the split pass adds a cut to
  // a crop already committed -- so this is the one condition, not a second.
  return lines?.cut ?? null;
}

/*
 * `hasStanding` STOOD HERE AND WENT WITH THE CONTROL IT GATED (Wave 51).
 *
 * It answered "is there a book's crop THIS photograph could be given back to",
 * per photograph rather than per book, because a standing drawn for another
 * shape is no offer at all. The modal's *Follow the book again* was drawn only
 * where it answered yes.
 *
 * The way back is the *Global* tick now, and the tick is never absent: it
 * always has something to say, because it names a state rather than offering
 * an act. `matchTheOthers` handles the no-standing case itself — the mark is
 * given up and the lines stay — so there is nothing left to ask first.
 */

/**
 * GIVE THIS PHOTOGRAPH BACK TO THE BOOK -- the release, named for its outcome.
 *
 * ── What it replaces, and why the old name could not be fixed ─────────────
 *
 * `keep` was a toggle over `byHand`, and its control had to be called *"Let
 * apply-to-all change it again"* -- a sentence about a POLICY governing a
 * FUTURE PRESS, which is the only kind of name available when the thing on the
 * other side of the release has no name. There was no *the book's crop* to
 * give a page back to; there was only "whatever the next stamp happens to be
 * copying from".
 *
 * With a standing there is an object, so the control can be named after what a
 * person watches happen: the page takes the crop the rest of the book has.
 *
 * ── IT IS THE ONLY ESCAPE THAT COSTS NOTHING ELSE ─────────────────────────
 *
 * The mark is set by dragging, so it can be set by accident -- and before this
 * the only way out was a global with the override on, which changes every
 * other page to fix one. This changes exactly the photograph in front of you.
 *
 * ── IT NO LONGER REFUSES A BOOK WITH NO STANDING (Wave 51) ────────────────
 *
 * It used to return the recipe untouched when `book` was absent, and the
 * control was drawn only where a standing existed -- which was honest while
 * the outcome was "take the book's crop" and there was none. It is now the
 * ONLY way back from *its own*, because `release` (which cleared the mark and
 * kept the lines) went with the checkbox that subsumed it. With no standing
 * there is nothing to wear, so the photograph keeps its lines and gives up its
 * mark, which is exactly what the old release did. The outcome the control
 * promises -- the book may move this one again -- is true in both branches.
 */
export function matchTheOthers(this: CaptureService, photoId: string): void {
  this.change((recipe) => {
    // ITS OWN SIDE'S LINES, by the same resolution every other act uses: a
    // photograph handed back to the book takes what the book would have given
    // it, and on a recto/verso shoot that is the odd or the even crop.
    const standing = linesFor(recipe.book, parityOf(recipe, photoId));
    const photos = recipe.photos.map((photo) => {
      if (photo.id !== photoId) return photo;
      const follower = following(photo);
      return standing === undefined ? follower : wearing(follower, standing) ?? follower;
    });
    // A standing carries a cut, so returning to it can change how many pages
    // this photograph has -- in either direction.
    return { ...recipe, photos, order: orderFor(photos, recipe.order) };
  });
}

/**
 * GIVE EVERY PAGE BACK TO THE BOOK -- the override, and Owen's other half.
 *
 * ── The ruling, in his own words ──────────────────────────────────────────
 *
 * *"if the page was individually edited, it's exempt from the global
 * settings, unless the user specifically overrides all individual settings to
 * revert to global."*
 *
 * The first clause is already the whole of this file: every global act asks
 * `isComplete` and steps around the photographs a hand has claimed. What was
 * missing is the clause after the comma. `matchTheOthers` hands ONE
 * photograph back, from a card's right-click, and that is the wrong shape for
 * the person the sentence is about -- somebody who has decided the individual
 * pass itself was the mistake, and would otherwise be closing the modal to
 * make fifty right-clicks against a population they cannot see from inside it.
 *
 * ── IT IS NOT `resetAll`, AND THE TWO MUST NOT BE CONFUSED ────────────────
 *
 * Reset goes back to the ORIGINALS and empties the book's standing with them.
 * This keeps the standing and dresses everybody in it, which is what *revert
 * to global* means: the marks go, the book's lines stay, and the pages take
 * them. Both overrule a hand, so both ask first -- and the two questions have
 * to say which of the two outcomes they are about, because a person reaching
 * for one and getting the other loses either an evening's cropping or the
 * book's own crop.
 *
 * ── IT IS THE SAME WALK, RELEASED FIRST ───────────────────────────────────
 *
 * `dressed` spares everything complete, and its `lead` is the one photograph
 * a mark does not spare. Here EVERY marked photograph is a lead -- so rather
 * than teaching that parameter to carry a population, the marks are given up
 * BEFORE the walk, through `following`, which is exactly what `dressed` does
 * to its lead on the way into `wear`. The walk then meets a book of followers
 * and does what it always does. One body, one skip, one resolution: a
 * photograph handed back here and a photograph handed back by the right-click
 * cannot come out differently.
 *
 * ── THE PASS IS READ HERE RATHER THAN TAKEN ───────────────────────────────
 *
 * `resetAll` takes its half as an argument because its caller composes a
 * sentence about it anyway. This reads `pass()`, so the confirm and the act
 * cannot end up naming two different passes. The crop pass hands back the
 * resolved crop AND cut, exactly as `matchTheOthers` does; the split pass
 * hands back the CUT alone, for `applyCuts`' reason -- by then the crops are
 * committed, and a pass that moved a corner would be answering a question
 * about gutters with somebody's cropping.
 *
 * ── A PAGE WITH NOTHING TO WEAR GIVES UP ITS MARK ANYWAY ──────────────────
 *
 * A photograph whose side of the book has no standing yet, or whose frame is
 * not the standing's shape, has nothing to take. It still comes out a
 * FOLLOWER, keeping the lines it has.
 *
 * That is `matchTheOthers`' own ruling for the same state, and it is the only
 * reading of *revert to global* that is true of the OUTCOME the button
 * promises: the book may move this one again. The alternative -- leave it
 * marked and count it -- would answer "give every page back to the book" with
 * a book that still holds pages the next global steps around, for a reason
 * the person would have to go looking for. The shape case is not new either:
 * `leadTheBook`'s guard already releases a photograph it cannot dress, and
 * the rail's pressable *N a different shape* is where that population is
 * named. What this adds is a count in the sentence, so nothing is silent.
 */
export function followAllAgain(this: CaptureService): void {
  const held = this.current();
  if (held === null || !held.photos.some(isComplete)) return;
  const cutting = this.pass() === 'split';
  this.change((recipe) => {
    const mine = new Set(recipe.photos.filter(isComplete).map((photo) => photo.id));
    // The marks first, so the walk below meets a book of followers -- see the
    // docblock. `following` is the same body `dressed` runs on its lead.
    const released: CaptureRecipe = {
      ...recipe,
      photos: recipe.photos.map((photo) => (mine.has(photo.id) ? following(photo) : photo)),
    };
    const { photos, applied } = dressed(released, (photo, parity) => {
      // Nobody else is reached. A follower already wears whatever the book
      // has to give it, so dressing it again would be an act with a reach it
      // never claimed -- and the two Finalizes are where that is asked for.
      if (!mine.has(photo.id)) return null;
      const lines = linesFor(recipe.book, parity);
      const crop = lines?.crop;
      if (lines === undefined || crop === undefined) return null;
      if (!cutting) return { wear: (one) => wearing(one, lines) };
      const cut = lines.cut;
      if (cut === undefined) return null;
      return { wear: (one) => cutWith(one, cut, false) };
    });
    this.notices.notice.set(handedBack(mine.size, applied));
    // A standing carries a cut, so a hand-back can change how many pages a
    // photograph has -- in either direction.
    return { ...released, photos, order: orderFor(photos, recipe.order) };
  });
}

/**
 * THE BOOK MOVES WITH THIS PHOTOGRAPH -- what *Global* means, spelled once.
 *
 * ── Owen's ruling, and the two presses it replaces ────────────────────────
 *
 * Wave 25 split one act in two: the modal RECORDED the book's crop and the
 * rail APPLIED it, on the rule that the modal speaks only for the photograph
 * it has open. The rule was right and the sequence was not: a person placing
 * the book's crop had to press a button, leave the room, press another, and
 * come back to see whether it had fitted. Owen's answer is a tick rather than
 * two more buttons -- *Global*, on by default, and while it is on THE HAND ON
 * THE CORNERS IS THE BOOK'S HAND. This is that press, made by the gesture
 * itself at the moment it lands.
 *
 * `recordCrop` and `recordCut` were its two halves and are folded in here.
 *
 * ── IT IS STILL ONE WALK, AND STILL THE SAME SKIP ─────────────────────────
 *
 * `dressed` below is the body both Finalize buttons run, so a live
 * propagation and a finalize cannot land differently -- which is the whole of
 * why finalize is a safety net rather than a second rule. Every complete
 * photograph is skipped, exactly as before, and `lead` is the one exception:
 * the photograph the gesture happened on is dressed even if it was marked,
 * because ticking *Global* on a page you had taken for your own IS the act of
 * giving it back and handing its lines to the book.
 *
 * ── IT SAYS NOTHING, DELIBERATELY ────────────────────────────────────────
 *
 * The Applies announce what they touched, because a press with no visible
 * consequence needs a sentence. This runs on every corner let go of, and a
 * notice bar rewriting itself twenty times a minute is a notice bar nobody
 * reads. What is left out is the shape skip, and the rail carries that
 * standing -- "N a different shape", pressable, at all times.
 */
export function leadTheBook(this: CaptureService, photoId: string, what: 'crop' | 'cut'): void {
  const scope = this.reach();
  this.change((recipe) => {
    const photo = recipe.photos.find((one) => one.id === photoId);
    if (photo === undefined) return recipe;
    /*
     * WHICH PHOTOGRAPHS THIS GESTURE SPEAKS FOR, and where its lines are kept.
     *
     * `side` is the standing this act writes — the book's own under *All
     * pages*, one side's under *Odd* or *Even* — and `inReach` is the same
     * decision asked of every other photograph.
     *
     * THE PHOTOGRAPH THE GESTURE HAPPENED ON IS ALWAYS IN REACH, even when it
     * sits on the other side of the book from the scope. It has already been
     * moved by the drag; leaving it out would leave it holding a stored mark
     * from some earlier evening while the hand that just moved it was plainly
     * the book's. Its lines become that side's standing wherever it sits,
     * which is the only reading of "this gesture speaks for the odd pages"
     * that does not require the person to be standing on an odd page to say
     * it.
     */
    const parities = paritiesOf(recipe);
    const side: 'odd' | 'even' | null = scope === 'all' ? null : scope;
    const inReach = (one: CapturePhoto): boolean =>
      one.id === photoId || side === null || parities.get(one.id) === side;
    /*
     * A PHOTOGRAPH OF ANOTHER SHAPE LED NOBODY, until 2026-09-21.
     *
     * The refusal stood here: a standing lifted off the one landscape frame
     * in a shoot of portrait ones fit none of them, so the gesture stayed
     * local, the standing was left as it was and the photograph gave up its
     * mark. That was a camera's case, and it is gone for a scanner's: every
     * page of a scan is its own size, and the refusal left a tick on one
     * spread reaching a sixth of the book. The ruling that took the shape out
     * of every global's questions is under `applyPopulations`; the first
     * gesture defines the book, whatever frame it happens on, and every later
     * one moves the whole book with it.
     */

    if (what === 'crop') {
      const standing = standingOf(photo);
      const crop = standing.crop;
      // `standingOf` always lifts one; the narrowing is the type's, not a
      // state this can be in.
      if (crop === undefined) return recipe;
      const { photos } = dressed(
        recipe,
        (one) => (inReach(one) ? { wear: (worn, leading) => wearing(worn, standing, !leading) } : null),
        photoId,
      );
      /*
       * AN *ALL PAGES* ACT SUPERSEDES THE SIDES — the book has one crop again.
       *
       * The sides exist because somebody said "these two halves differ"; an
       * act made with the scope back on *All pages* is the same person saying
       * they do not, and leaving `odd` standing beside a new book crop would
       * be a decision that outlives the person taking it back. A scoped act
       * writes its own side and leaves the other exactly where it is.
       */
      const book: CaptureStanding = side === null
        ? { ...standing }
        : side === 'odd'
          ? { ...recipe.book, odd: standing }
          : { ...recipe.book, even: standing };
      return { ...recipe, photos, book, order: orderFor(photos, recipe.order) };
    }

    /*
     * THE CUT ALONE, because by the split pass the crop is settled and this
     * photograph may not be speaking for it -- `recordCut`'s ruling, kept. A
     * complete photograph holds a crop somebody placed on it alone, and
     * lifting a whole standing off it here would quietly replace the book's
     * crop, already worn by every follower, with one outlier's.
     */
    const cut = photo.split ?? undefined;
    /*
     * THE CUT LANDS ON THE SCOPE'S STANDING, AND AN *ALL* CUT LANDS ON ALL
     * THREE (Wave 51b).
     *
     * A side's block is WHOLE — a photograph wears its side's lines or the
     * book's, never a merge — so a cut written only into the book's own would
     * never reach a side that has a block of its own. That is the one place
     * the block rule needs help, and this is it: *All pages* means every
     * photograph is cut here, so the line goes into the book's lines and into
     * whichever sides exist, and the sides keep the crops the crop pass gave
     * them. Which is `recordCut`'s ruling arriving at a second level — the cut
     * alone, because by this pass the crops are settled.
     */
    const book: CaptureStanding = { ...recipe.book };
    if (side === null) {
      withCut(book, cut);
      if (book.odd !== undefined) book.odd = withCut({ ...book.odd }, cut);
      if (book.even !== undefined) book.even = withCut({ ...book.even }, cut);
    } else {
      // From what that side already wears, which is its own block if it has
      // one and the book's lines if it does not -- so a side's first cut
      // arrives beside the crop that side was already being given rather than
      // as a block with a cut and nothing to cut.
      const worn = withCut({ ...(linesFor(recipe.book, side) ?? {}) }, cut);
      // A block holding neither is silence, not a key meaning nothing.
      if (worn.crop === undefined && worn.cut === undefined) delete book[side];
      else if (side === 'odd') book.odd = worn;
      else book.even = worn;
    }
    const { photos } = dressed(
      recipe,
      (one) => (inReach(one)
        ? { wear: (worn, leading) => (cut === undefined ? rejoined(worn) : cutWith(worn, cut, false, !leading)) }
        : null),
      photoId,
    );
    return { ...recipe, photos, book, order: orderFor(photos, recipe.order) };
  });
}

/**
 * TURN THIS PHOTOGRAPH AND EVERY FOLLOWER WITH IT -- *Global* on the ⟲ ⟳ pair.
 *
 * ── It is not a standing, which is why it is its own door ────────────────
 *
 * A turn is not carried by the book's crop: `wearing` re-labels the standing
 * into whatever direction the photograph it is dressing already faces, on
 * purpose, so that a page somebody stood upright keeps its orientation while
 * taking the book's rectangle. So propagating a turn means turning the others,
 * and `leadTheBook` cannot do it however it is called.
 *
 * ── EVERY PHOTOGRAPH GOES THROUGH `turned`, INCLUDING THE FOLLOWERS ──────
 *
 * Wave 21c's bulk turn re-labelled each follower's pages one at a time, which
 * is wrong for a spread by the arithmetic `turned` has measured since it was
 * written: a half turn swaps which half reads first, and turning two halves
 * independently keeps the old order. Rebuilding the sheet, turning that and
 * re-deriving the halves is the one body that gets it right, and there is no
 * reason for a second one here.
 *
 * ── AND IT SPARES THE COMPLETE ONES, where the old bulk turn did not ─────
 *
 * That is a REVERSAL, said out loud. Wave 21c argued that a turn overwrites
 * nobody's corners, so sparing complete photographs would leave exactly the
 * pages somebody had worked on lying the wrong way up. True of a press
 * labelled *turn the other 24*; false of a tick whose caption promises that
 * the book leaves an unticked page alone. A person who takes a page for their
 * own has taken its orientation too, and the ⟲ ⟳ pair with *Global* off is
 * how they turn it.
 */
export function turnWithTheBook(this: CaptureService, photoId: string, turns: number): void {
  const scope = this.reach();
  this.change((recipe) => {
    const source = recipe.photos.find((one) => one.id === photoId);
    if (source === undefined) return recipe;
    const lead = following(turned(source, turns));
    const facing = lead.pages[0]?.quad;
    // THE SCOPE REACHES THE TURN TOO. A turn is not carried by the standing,
    // so it cannot ride in on the resolution the crops use -- but a person who
    // has said "the odd pages, please" and then presses ⟳ has said it about
    // this act as much as about the corners.
    const parities = paritiesOf(recipe);
    const photos = recipe.photos.map((photo) => {
      if (photo.id === source.id) return lead;
      const now = photo.pages[0]?.quad;
      if (facing === undefined || now === undefined) return photo;
      if (scope !== 'all' && parities.get(photo.id) !== scope) return photo;
      if (isComplete(photo)) return photo;
      return following(turned(photo, turnsOf(facing) - turnsOf(now)));
    });
    // A turn cannot change which pages exist -- `turned` re-derives a spread's
    // halves in place -- so the arrangement is left exactly as it is.
    return { ...recipe, photos };
  });
}

/**
 * PUT THE WHOLE BOOK BACK -- the one act that overrules a hand.
 *
 * ── The exception, and it is the only one ────────────────────────────────
 *
 * "A hand-placed change is assumed correct and is never overwritten by a
 * global" is Owen's standing ruling and every other act in this file obeys it.
 * This one does not, because it is the act a person reaches for when the
 * assumption is what went wrong: a crop placed against the wrong edge and then
 * carried across fifty pages, an evening that has to start again. It is
 * therefore CONFIRMED at the surface -- the app's own dialog, once -- and it
 * is the only place in this stage where a question is asked before a global.
 *
 * ── THE TURNS SURVIVE, AND THAT IS A DECISION ────────────────────────────
 *
 * "Back to original" could mean the frame as the camera handed it over, turns
 * and all. It does not, and must not: on Owen's own shoot twenty-five sideways
 * spreads are turned before a single corner is placed, and un-turning them
 * would spend the reset destroying the work nobody was complaining about. So
 * each photograph goes back to the WHOLE FRAME AS IT NOW FACES --
 * `turnQuad(WHOLE_FRAME, ...)` -- which is no crop and the same orientation.
 *
 * ── WHAT EACH PASS RESETS IS WHAT THAT PASS OWNS ─────────────────────────
 *
 * The crop pass clears the book's standing entirely -- the sides' lines with
 * the book's own, because a reset that left the odd pages a crop would be an
 * act called *Reset every crop* that reset half of them -- and gives every
 * photograph the whole frame back, keeping its cut where it has one --
 * `clearCrop`'s ruling that a cut survives its crop, applied to the book. The
 * split pass rejoins every photograph and clears the book's cut alone, because
 * the crops are committed by then and a reset that threw them away would be
 * answering a question about gutters with the loss of an evening's cropping.
 */
export function resetAll(this: CaptureService, what: 'crop' | 'cut'): void {
  this.change((recipe) => {
    const photos = recipe.photos.map((photo) =>
      (what === 'crop' ? uncropped(photo) : rejoined(photo)));
    const order = orderFor(photos, recipe.order);
    if (what === 'crop') {
      const next = { ...recipe, photos, order };
      delete next.book;
      return next;
    }
    /*
     * The crop stays, so the standing keeps its crop and loses its cut -- ON
     * EVERY SIDE, because a reset that rejoined every photograph and left the
     * odd pages' cut standing would put the line straight back on the next
     * finalize. An empty standing is dropped rather than written as a key
     * meaning nothing -- the same silence the validator keeps for one.
     */
    const book: CaptureStanding = { ...recipe.book };
    delete book.cut;
    if (book.odd !== undefined) book.odd = withCut({ ...book.odd }, undefined);
    if (book.even !== undefined) book.even = withCut({ ...book.even }, undefined);
    if (book.odd?.crop === undefined) delete book.odd;
    if (book.even?.crop === undefined) delete book.even;
    const next: CaptureRecipe = { ...recipe, photos, order, book };
    if (standings(book).length === 0) delete next.book;
    return next;
  });
}
