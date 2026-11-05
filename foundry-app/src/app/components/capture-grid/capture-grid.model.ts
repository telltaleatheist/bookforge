/**
 * capture-grid.model — a card on the table, and the constants of carrying and sweeping.
 */
import type { CaptureQuad } from '@owen/foundry-core/shared/types';
import { computed, input } from '@angular/core';

/** One page on the table, as the grid needs to draw it. */
export interface CaptureCard {
  /** The page id — `<photoId>:<n>`, the recipe's own. */
  readonly id: string;
  /**
   * The PHOTOGRAPH this page is on.
   *
   * Here so the grid can count photographs without holding a recipe. It could
   * be parsed out of the id, and must not be: a surface that derives an
   * identity by splitting a string is a surface that keeps working until the
   * day the id format changes under it.
   */
  readonly photoId: string;
  /** The 640 px thumbnail's URL, through the capture door. */
  readonly thumb: string;
  /** What to call it on the table. */
  readonly label: string;
  /** Struck pages stay on the table and out of the mint. */
  readonly struck: boolean;
  /** The page this card will mint, for the crop drawn over its thumbnail. */
  quad: CaptureQuad;
  /**
   * THE PHOTOGRAPH'S PIXELS, and the card cannot do without them.
   *
   * A quad is FRACTIONS of the working copy, so a half-width crop reads
   * 0.5 x 1.0 on every photograph in the project -- and the page it prints is
   * 2016 x 3024 on one shot and something else entirely on another. The shape a
   * card must draw itself at is not recoverable from the quad alone.
   *
   * They are on the card rather than looked up because the grid holds cards and
   * not a recipe, which is the line this file's docblock already draws.
   */
  readonly width: number;
  readonly height: number;
  /**
   * THE BOOK HAS STOPPED MOVING THIS PHOTOGRAPH — `isComplete`, and the dot.
   *
   * The table has to say it because the promise is open-ended: a complete
   * photograph sits out every global act for the life of the project. Without a
   * mark, the way to find the ones that did not move is to press Apply, count
   * the cards, and squint -- and a rail that says "3 complete" while saying
   * nothing about WHICH three is a number with nowhere to go. It has somewhere
   * to go now: the rail's counts are pressable and light exactly these cards.
   *
   * A fact about the PHOTOGRAPH, so both cards of a cut spread carry it. A pair
   * showing the mark on one card and not its twin would read as a defect rather
   * than as a pair.
   *
   * ── THE NAME IS P1's AND STAYS P1's ─────────────────────────────────────
   *
   * `own` was the Wave 24 word ("its own crop"), and the service's `cards`
   * computed invites this package to rename it now that the question behind it
   * is `isComplete` rather than `byHand`. It is not renamed, because the writer
   * of this field is `capture.service.ts` — one word there, in ground this
   * package consumes and does not edit. The CARD's input is called `complete`,
   * which is the name a person meets; this one is the wire between two files
   * and is documented rather than moved.
   */
  readonly own: boolean;
}

/**
 * The drag payload's type. A private MIME rather than `text/plain` so a page
 * dragged inside the grid is distinguishable, BEFORE the drop, from a file
 * dragged in from Explorer — `dataTransfer.types` is the only part of a payload
 * readable during a drag, and the two mean opposite things here. The dock does
 * the same for its document rows, and for the same reason.
 */
export const PAGE_MIME = 'application/x-foundry-capture-page';

/**
 * THE LIGHT TABLE — the main viewer for a capture project with no minted PDF.
 *
 * ── What this owns, and what it refuses to ──────────────────────────────────
 *
 * The arrangement: which card sits where, which way the sort runs, where a
 * dragged page lands, and where files may be dropped. It owns none of the
 * meaning — a card is a row of pixels and a label handed to it, the recipe is
 * the service's, and every gesture leaves here as an event rather than as a
 * mutation.
 *
 * That is what lets the grid be drawn against anything: it never learns what a
 * quad is, and the rules about spreads and splits live where they can be shared
 * (`capture-editor/geometry.ts`, and the service above it).
 *
 * ── A CLICK CHOOSES; OPENING TAKES TWO ─────────────────────────────────────
 *
 * Wave 21 point 1. Until tonight a single click OPENED the editor, so the only
 * way to select one card was to draw a marquee band across it and stop -- and
 * selection is now the gesture the table is FOR: it feeds reorder, delete, and
 * which photograph the modal opens on. A gesture that common cannot cost a
 * rubber band.
 *
 * So a click chooses, ctrl and meta toggle, shift takes the run, and OPENING is
 * a double-click or Enter. The marquee is untouched and still starts anywhere
 * on the table, because at fifty-two cards almost every pixel is a card.
 *
 * The one number that moves between the two worlds is what "one selected" means
 * for Enter: PHOTOGRAPHS, not cards, through the same fold the menu and the
 * confirm use. Both halves of a split spread are two cards on one picture, and
 * the editor edits the picture.
 *
 * ── THE ORDER STOPS BEING A SORT THE MOMENT SOMEBODY DRAGS ──────────────────
 *
 * docs/CAPTURE.md: cards arrive "sorted by capture time … Cards drag to
 * reorder; once the user has dragged, the sort is history and their order is the
 * order." So this component emits a REORDER — the full list of ids in their new
 * arrangement — and never a "move card 3 to slot 7" that a re-sort could
 * silently undo. The service decides that the recipe's `order` is now the
 * person's and stops sorting.
 *
 * ── REVERSE IS ASKED FOR, NOT DONE ──────────────────────────────────────────
 *
 * The doc's sharpest trap: "Reverse operates on capture order, not on split
 * halves. A book shot back-to-front reverses into reading order by spread;
 * within each split the left page still precedes the right. Reversing raw page
 * cards would silently swap every pair." A grid holding a flat list of cards
 * CANNOT honour that — it cannot see which two cards were one photograph. So it
 * emits `reverse` and the service, which holds the photos, does it properly.
 * Reversing the array here would be exactly the bug the doc names.
 *
 * ── The drop zone stops the drop, and that was NOT ENOUGH ───────────────────
 *
 * This zone calls `stopPropagation` so the window’s own file-drop handler does
 * not also answer a drop the grid has taken. That much was always right and it
 * still is. What it was NOT is sufficient, and Owen found out in the first
 * minutes of the acceptance run: the zone is a STRIP DOWN ONE SIDE, so a drop
 * on the table, on the empty state, or on the header sailed past it to the
 * window and came back as “IMG_0238.HEIC is not something Foundry opens”.
 *
 * The window handler now routes a drop to intake whenever a capture tab is in
 * front (app.ts, `intaking`), which is the app’s own philosophy applied where
 * it had not been: dropping a book at the app is not aiming at a rectangle, and
 * neither is dropping photographs. So this strip is no longer the only way in —
 * it is the OBVIOUS one, kept because a gesture with nowhere visible to aim is
 * a gesture people do not discover.
 *
 * `stopPropagation` therefore now prevents a DOUBLE INTAKE rather than a wrong
 * one. Both paths call the same `intake`, and without it a drop on the strip
 * would be answered twice.
 */
/**
 * How far a pointer must travel before a press becomes a sweep rather than a
 * click. Small enough that a deliberate drag is caught immediately, large
 * enough that a click with a shaky hand is still a click.
 */
export const SWEEP_STARTS_AT = 5;

/**
 * How near the table's top or bottom edge a dragged card starts the scroll, and
 * how far one frame moves it at the very edge.
 *
 * The band is about a card's own margin — wide enough to fall into without
 * aiming, narrow enough that the middle of the table is dead ground where a
 * person can hold a card still. The step is a pixel figure per frame rather than
 * per second because the loop IS the clock here: sixteen pixels at sixty frames
 * is most of a row a second, which crosses a shoot of a hundred and seventy-nine
 * in a few seconds without overshooting the row somebody is aiming at.
 */
export const SCROLL_BAND = 48;

export const SCROLL_STEP = 16;

/** Whether a drag carries files from outside the app rather than a page card. */
export function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}
