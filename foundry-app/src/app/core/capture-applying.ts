/**
 * capture-applying — applying crops and cuts to the photographs, and saving the recipe.
 */
import type { CapturePhoto, CaptureRecipe } from '@owen/foundry-core/shared/types';
import { api } from './foundry';
import { ApplyOutcome, announce, SAVE_AFTER_MS, orderFor } from './capture-outcomes';
import { isComplete, placed, dressed, linesFor, cutWith, standingOf, wearing } from './capture-geometry';
import type { CaptureService } from './capture.service';

/**
 * THIS ONE IS ITS OWN — *Global* unticked, and the only writer of
 * `complete: true`.
 *
 * ── Why a stored answer, when a placement needs none ──────────────────────
 *
 * Because this completion leaves NO TRACE IN THE GEOMETRY. Unticking the box
 * moves nothing: the photograph keeps the crop, the cut and the turn it
 * already had, and the only thing that changes is that the book stops moving
 * it. There is nothing for `isComplete` to derive from, so without a field
 * the next global would move a page somebody had just claimed.
 *
 * IT IS NOT THE SAME ACT AS PLACING. A placement records provenance and lets
 * the derive speak (`placed`); this records the decision itself, because it is
 * the whole of what happened.
 *
 * ── It inherits the say-so's door and its argument (Wave 51) ───────────
 *
 * *✓ This page is right — next* was the only writer before, and the reason it
 * needed a stored answer is the reason the unticked box does: a person who
 * looks at a page the book's crop already fits and agrees with it has moved
 * nothing, and a derivation cannot know they looked. The press is gone — it
 * completed AND stepped, so it could not say "this one is mine" without also
 * leaving the page — and the box says the same thing where the hand already is.
 */
/*
 * AND WAVE 51b TOOK ITS DOOR AWAY, ONE DAY AFTER IT WAS BUILT.
 *
 * The untick was its only caller, and the untick no longer says anything about
 * the photograph in front of it: *Global* is a MODE now (see `global` above),
 * so turning it off is a person describing the next hour of work rather than
 * claiming the picture they happen to be looking at. Writing `complete: true`
 * there would claim fifty pages over an evening, one per time somebody
 * unticked the box to go and tweak something.
 *
 * The state survives and so does the way in: a page becomes its own by being
 * MOVED while the mode is off, which is `setQuads(..., mine)` and the
 * provenance derive in `isComplete`. Nothing writes `complete: true` any more;
 * the field is still read, because recipes written on 2026-08-26 hold them and
 * they mean exactly what they meant.
 *
 * WHAT IS GONE WITH IT, said out loud: there is no longer any way to say "the
 * book must leave this one alone" WITHOUT moving it. A page that already looks
 * right and must not be moved by a later global has to be nudged to claim it.
 * That is a real hole and a small one — the gesture is how every other claim
 * is made — and it wants a card-level door (right-click, beside *Follow the
 * book again*) rather than a checkbox in the modal that means two things.
 */

/*
 * `release` STOOD HERE — the only writer of `complete: false` — and Wave 51
 * took its door away.
 *
 * It cleared the mark and KEPT the lines, which was the right shape while the
 * card's right-click was a menu item about a policy: the page stayed exactly
 * as it looked and the next Apply was what moved it. With propagation live
 * that gap has nowhere to sit — a page released and left alone would be a
 * follower wearing lines the book does not have, until some later act
 * silently corrected it. So the right-click means `matchTheOthers` now: give
 * up the mark AND take the book's lines, in the press, where a person can see
 * it happen. Re-ticking *Global* is the same act from the modal.
 *
 * A stored `false` is still HONOURED (see `isComplete`): recipes written
 * before this wave hold them, and they mean what they always meant.
 */

/*
 * `recordCrop` AND `recordCut` STOOD HERE and are folded into `leadTheBook`.
 *
 * They were the half of Wave 24's *Crop all* that survived the scope rule: a
 * press in the modal wrote the book's standing and propagated nothing,
 * because a control there speaks for the photograph it has open. The rule
 * holds; what Wave 51 removed is the PRESS. With *Global* ticked the gesture
 * itself is the book's, so recording and dressing the followers happen
 * together at the moment a corner is let go of, and two doors a person had to
 * find in the right order became none.
 *
 * Both bodies moved intact. `leadTheBook('crop')` is `standingOf` wholesale;
 * `leadTheBook('cut')` writes the cut alone, for `recordCut`'s reason -- by
 * the split pass the crop is settled and this photograph may not be speaking
 * for it.
 */

/**
 * FINALIZE PAGE CROPS — the book's crop lands, and the pass moves.
 *
 * ── It is the table's act, and it has no source ──────────────────────────
 *
 * Wave 24's stamp copied from the photograph somebody was standing on, which
 * is why it had to skip one and why the modal had to carry it. This one lands
 * the STANDING, which belongs to the book. Every photograph is a candidate,
 * the one the standing was lifted from included — it takes it again, exactly
 * and harmlessly, unless it has since been completed.
 *
 * ── SINCE WAVE 26 IT MOSTLY LANDS ON NOBODY, AND THAT IS THE POINT ───────
 *
 * Propagation is live: every follower took the book's crop at the moment the
 * gesture that set it was let go of (`leadTheBook`). So the ordinary press of
 * this button finds the book already dressed and reports it -- which is why
 * the walk is the SAME body rather than a second rule that agrees. What is
 * left for it to catch is stragglers: a photograph intaken after the standing
 * was set, or one handed back to the book between one gesture and the next.
 *
 * It is kept as a press rather than folded into the pass move because the two
 * are different promises. Moving the pass is a person saying the crops are
 * settled; landing the standing is the book making sure of it. A safety net
 * that runs the real walk cannot lie about what it caught.
 *
 * ── THE SKIP IS `isComplete`, WHICH IS THE WHOLE WAVE ────────────────────
 *
 * One test, read here and by nothing else that disagrees with it: a page
 * somebody placed, and a page somebody approved, are one population, and the
 * dot on the card is the same question asked of one photograph.
 *
 * ── AND IT MOVES THE PASS ────────────────────────────────────────────────
 *
 * Which is the commitment: from here the surfaces draw the rectified
 * projection and offer the line rather than the corners. It is not a second
 * render and it cuts no pixels — that happens once, at Finish — so *Reopen
 * crops* costs nothing and destroys nothing.
 *
 * IT REFUSES WHEN THERE IS NO STANDING, and says so rather than moving the
 * pass on an act that did not happen. A split pass entered without a crop
 * would be a pass whose Apply cannot resolve its own cut.
 *
 * THROUGH `wearing`, for Wave 24's measured reason: a standing IS a sheet and
 * a cut, and turning a spread's two halves independently swaps which one reads
 * first. Nothing here composes halves.
 */
export function applyCrops(this: CaptureService): ApplyOutcome {
  const held = this.current();
  if (held === null || !this.anyCrop()) {
    this.notices.notice.set(
      'The book has no crop yet, so there is nothing to finalize. Open a page and place its '
      + 'crop with Global ticked — the rest take it as you go.',
    );
    return { applied: 0, skipped: 0 };
  }
  let outcome: ApplyOutcome = { applied: 0, skipped: 0 };
  this.change((recipe) => {
    /*
     * EACH PHOTOGRAPH WEARS ITS OWN SIDE'S STANDING, resolved here and by the
     * rail's count through the same body. A side with nothing standing yet
     * reaches nobody rather than falling back to the book's own: an odd crop
     * placed and an even one not yet placed is an ordinary half-finished
     * state, and dressing the even pages in the odd crop would undo the very
     * distinction the person is in the middle of making.
     *
     * Null from `wearing` is unreachable from a standing lifted off a real
     * photograph, and leaving that one alone is the only answer that cannot
     * make a page out of a corner.
     */
    const { photos, applied, skipped } = dressed(recipe, (photo, parity) => {
      const lines = linesFor(recipe.book, parity);
      const crop = lines?.crop;
      if (lines === undefined || crop === undefined) return null;
      return { wear: (one) => wearing(one, lines) };
    });
    outcome = { applied, skipped: skipped.length };
    this.notices.notice.set(applied === 0 && skipped.length === 0
      ? 'Nothing to finalize.'
      : announce('Finalized', applied, skipped));
    return {
      ...recipe,
      photos,
      // A standing carries a cut, so a finalize can change how many pages a
      // photograph has -- in either direction.
      order: orderFor(photos, recipe.order),
      pass: 'split',
    };
  });
  return outcome;
}

/**
 * FINALIZE PAGE SPLITS — the book's cut lands on every follower.
 *
 * ── A stamp act with no state of its own ─────────────────────────────────
 *
 * It moves no pass and records nothing: it is repeatable, and repeating it is
 * the ordinary way to work. The crop pass's finalize is a commitment because
 * it changes what every surface DRAWS; this one only moves a gutter.
 *
 * Like its sibling it is a safety net rather than the propagation: a line slid
 * with *Global* ticked has already reached every follower. What it catches is
 * the same short list — a late arrival, a photograph handed back to the book
 * since the last gesture.
 *
 * ── IT KEEPS EVERY PHOTOGRAPH'S OWN CROP, which is why it is not `wearing` ─
 *
 * By now the followers hold the standing crop and the complete ones hold
 * their own, and neither is this line's business. `cutWith` cuts each
 * photograph's own sheet at the book's line, so an Apply here re-seats the
 * gutter without touching a corner — and re-seating is why it can be pressed
 * twice: the cut is always made against the SHEET, never against the halves
 * a previous press left behind.
 *
 * ── TAKING THE BOOK'S CUT IS FOLLOWING IT ────────────────────────────────
 *
 * So no page is marked by this, exactly as the tick does not mark (Wave 24's
 * `cutHere` ruling, measured: accepting the standing must not opt you out of
 * the standing). A mark the CROP earned survives, because the crop is still
 * theirs.
 *
 * The shape is asked of the standing's own frame, because a cut is fractions
 * of a frame and only falls on the same gutter in one of the same
 * proportions. Which is also why this refuses with no standing crop to
 * measure against, rather than resolving the line somewhere plausible.
 */
export function applyCuts(this: CaptureService): ApplyOutcome {
  const held = this.current();
  if (held === null || !this.anyCrop() || !this.anyCut()) {
    this.notices.notice.set(
      !this.anyCrop()
        ? 'The book has no crop yet, so a cut has no frame to fall in.'
        : 'The book has no cut yet. Open a spread and put the line down the gutter with Global '
        + 'ticked — the rest follow it as you go.',
    );
    return { applied: 0, skipped: 0 };
  }
  let outcome: ApplyOutcome = { applied: 0, skipped: 0 };
  this.change((recipe) => {
    // Each side's own line, resolved as the crops are. A side with no cut is
    // left whole rather than given the other side's: on a shoot whose odd
    // pages are spreads and whose even ones are single sheets, the fallback
    // would cut every single page in half.
    //
    // Null from `cutWith` is a segment that resolves against a sheet to
    // NEIGHBOURING edges, which cuts a corner off rather than cutting a page
    // in two. Leaving that photograph whole is the only answer that cannot
    // destroy a page.
    const { photos, applied, skipped } = dressed(recipe, (photo, parity) => {
      const lines = linesFor(recipe.book, parity);
      const crop = lines?.crop;
      const cut = lines?.cut;
      if (crop === undefined || cut === undefined) return null;
      return { wear: (one) => cutWith(one, cut, false) };
    });
    outcome = { applied, skipped: skipped.length };
    this.notices.notice.set(applied === 0 && skipped.length === 0
      ? 'Nothing to cut.'
      : announce('Cut', applied, skipped));
    // A cut changes which pages exist, so the order grows with it.
    return { ...recipe, photos, order: orderFor(photos, recipe.order) };
  });
  return outcome;
}

/**
 * REOPEN THE CROPS — back to the crop pass, and nothing else changes.
 *
 * It costs nothing and destroys nothing, which is the property that makes
 * Apply safe to press: no pixels were cut, so there is nothing to undo. Every
 * line every photograph holds is exactly where it was, including the ones the
 * last Apply landed — reopening is not a rollback, it is the corners being
 * offered again.
 */
export function reopen(this: CaptureService): void {
  this.change((recipe) => {
    if (recipe.pass === undefined) return recipe;
    const next = { ...recipe };
    delete next.pass;
    return next;
  });
}

/** The page and the photo it belongs to, or null. */
export function pageIn(this: CaptureService, recipe: CaptureRecipe, pageId: string): { photo: CapturePhoto; page: CapturePhoto['pages'][number] } | null {
  for (const photo of recipe.photos) {
    const page = photo.pages.find((one) => one.id === pageId);
    if (page !== undefined) return { photo, page };
  }
  return null;
}

/** The capture time of every card, in the order the grid draws them. */
export function orderedTimes(this: CaptureService): readonly string[] {
  const recipe = this.current();
  if (recipe === null) return [];
  const times: string[] = [];
  for (const id of recipe.order) {
    const found = this.pageIn(recipe, id);
    if (found !== null) times.push(found.photo.takenAt);
  }
  return times;
}

export function change(this: CaptureService, edit: (recipe: CaptureRecipe) => CaptureRecipe): void {
  const recipe = this.current();
  if (recipe === null) return;
  const next = edit(recipe);
  this.current.set(next);
  this.save(next);
}

/**
 * Write the recipe, at most once every `SAVE_AFTER_MS` of quiet.
 *
 * The LAST state wins rather than the first: a drag emits a recipe per
 * pointermove and only where the corner came to rest is worth writing. A save
 * that fails says so once and keeps the edit on screen — the recipe in memory
 * is what the person is looking at, and throwing it away to match the disk
 * would lose work to a transient error.
 */
export function save(this: CaptureService, recipe: CaptureRecipe): void {
  const dir = this.directory();
  // Held in a local rather than read off the module inside the timeout: the
  // narrowing above does not survive into a later callback, and a bridge that
  // was there when the edit happened is the one that should write it.
  const bridge = api;
  if (bridge === null || dir === null) return;
  this.unsaved = recipe;
  if (this.saveTimer !== null) clearTimeout(this.saveTimer);
  this.saveTimer = setTimeout(() => {
    this.saveTimer = null;
    void this.write(bridge, dir, recipe);
  }, SAVE_AFTER_MS);
}

/**
 * ONE WRITE, and the disk is current only when it succeeds. A later edit
 * that arrived while this one was in flight is a newer `unsaved` and stays
 * held; a failure says so and leaves the edit for the next write to carry.
 */
export async function write(this: CaptureService, bridge: NonNullable<typeof api>, dir: string, recipe: CaptureRecipe): Promise<void> {
  try {
    await bridge.capture.recipeSave(dir, recipe);
    if (this.unsaved === recipe) this.unsaved = null;
  } catch (err) {
    this.complain(err);
  }
}

export function complain(this: CaptureService, err: unknown): void {
  this.notices.notice.set(err instanceof Error ? err.message : String(err));
}
