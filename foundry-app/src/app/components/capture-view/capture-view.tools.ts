/**
 * capture-view.tools — the light table's acts: opening a tool or a page, crops and turns, resets, and starting the mint.
 */
import { signal } from '@angular/core';
import type { CaptureQuad } from '@owen/foundry-core/shared/types';
import type { FractionQuad } from '@owen/foundry-core/browser/geometry';
import type { CaptureViewComponent } from './capture-view.component';

/*
 * THE ARROWS USED TO BE ANSWERED HERE TOO, AND THAT MEANT TWICE.
 *
 * This component kept a window:keydown for ArrowLeft/ArrowRight, guarded on
 * "something is open" -- which is exactly when the modal is mounted, and the
 * modal answers the same two keys on the same window. Both listeners fire for
 * one press and both call step(), so every arrow moved TWO photographs and
 * the walk skipped every other picture on the way through the shoot.
 *
 * Window listeners do not nest, so this was not fixable by stopping
 * propagation in the modal: they are siblings on one target, not a chain.
 * The fix is ownership -- the surface the keys belong to is the one they are
 * about, and that is the modal.
 */

/**
 * Ask before removing, then remove.
 *
 * ── The question names what CANNOT be undone, and what is not lost ──────────
 *
 * Removal deletes the bank copy as well as the derived files, which sounds
 * worse than it is and has to be SAID rather than softened: the originals in
 * a capture project are copies, and the files the person dragged in are still
 * wherever they dragged them from. A confirm that hid that would be asking
 * somebody to be frightened of the wrong thing; one that omitted the deletion
 * would be hiding the real cost.
 *
 * ── IT TAKES PHOTOGRAPHS, ALREADY FOLDED ────────────────────────────────────
 *
 * This used to fold page ids to photographs itself, which was correct and was
 * the SECOND place doing it -- the grid's context menu counted raw pages and
 * called them photographs, so on a split shoot the menu offered to delete 52
 * and this asked about 27. The fold moved into the grid, where the menu can
 * see it, and this takes what that offered. One fold, one number, one act.
 */
export async function confirmRemoval(this: CaptureViewComponent, photoIds: readonly string[]): Promise<void> {
  if (photoIds.length === 0) return;
  const many = photoIds.length !== 1;
  const agreed = await this.confirm.ask({
    message: many
      ? `Remove ${photoIds.length} photographs from this project?`
      : 'Remove this photograph from this project?',
    detail: [
      many
        ? 'Their pages leave the book, and the copies this project made of them are deleted.'
        : 'Its pages leave the book, and the copies this project made of it are deleted.',
      'The files you dragged in are untouched, wherever you dragged them from.',
    ],
    confirm: many ? `Remove ${photoIds.length}` : 'Remove',
  });
  if (agreed) await this.captures.remove(photoIds);
}

/**
 * A rail row: open the editor where the work is.
 *
 * ── The verb is no longer carried, and the row still means something ──────
 *
 * It used to set a TOOL the modal opened on, because Turn, Crop and Split were
 * three modes in there. The modes are gone (Wave 24) -- every control is on
 * screen at once -- so the three rows open the same room, and what each one
 * still says is "start a pass through the book thinking about this".
 *
 * IT DOES NOT MOVE SOMEBODY WHO IS ALREADY IN THE ROOM, which matters more now
 * than it did: with no tool to change, taking a person back to photograph 1
 * would be the only thing the press did.
 */
export function openTool(this: CaptureViewComponent): void {
  if (this.open() !== null) return;
  const first = this.walk()[0];
  if (first !== undefined) this.open.set(first);
}

/** A card was clicked: the editor opens on the PHOTOGRAPH that page is on. */

export function openPage(this: CaptureViewComponent, pageId: string): void {
  const recipe = this.captures.recipe();
  if (recipe === null) return;
  /*
   * A card is a PAGE and the editor edits a PHOTOGRAPH, which is not a
   * mismatch: both halves of a split are corners on one picture, and an editor
   * showing one half of a spread could not draw the split line that made it.
   */
  const photo = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
  if (photo !== undefined) this.open.set(photo.id);
}

/**
 * The corners moved. WHOSE CORNERS is the tick's answer, not this file's.
 *
 * `mine` is false while *Global* is ticked, so a drag that is the book's does
 * not mark the photograph as somebody's own — which would opt it out of the
 * standing it is in the middle of authoring. The propagation itself waits for
 * `settle` below: this runs per pointermove.
 */
export function setQuads(this: CaptureViewComponent, photoId: string, quads: readonly FractionQuad[]): void {
  this.captures.setQuads(photoId, quads as readonly CaptureQuad[], !this.global());
}

/**
 * A GESTURE ENDED AND THE BOOK WAS FOLLOWING IT — hand the lines over.
 *
 * ── Why this is the moment, and not every pointermove ────────────────────
 *
 * The drag writes the recipe continuously, because the recipe is what the
 * screen draws. Dressing every follower is a walk over the whole book that
 * re-derives halves and rebuilds the arrangement, and doing it sixty times a
 * second would be twenty-five photographs re-cut for each pixel of travel.
 * Once, when the hand opens, is the same outcome for a fraction of the work —
 * and it is also the honest reading of the gesture: what a person meant is
 * where they let go.
 *
 * WHICH PASS DECIDES WHAT IS LIFTED. The crop pass hands over the sheet and
 * the cut together (a standing carries both); the split pass hands over the
 * cut alone, because by then the crops are committed and this photograph may
 * not be speaking for them.
 */
export function settle(this: CaptureViewComponent, photoId: string): void {
  if (this.global()) this.lead(photoId);
}

/**
 * THE BOOK ADOPTS THIS PHOTOGRAPH'S LINES — one call, one place to get the
 * pass right.
 *
 * The callers used to read `global()` BEFORE their act and carry the answer,
 * because the tick was derived from the photograph and the act itself could
 * mark it — clearing a crop and rejoining a spread both do — so re-asking
 * afterwards found the box already off and dropped the propagation the person
 * was watching for. The mode cannot move under an act (Wave 51b), so the
 * dance is gone; the reads are left where they are because reading a mode
 * once at the top of a method is still the clearer sentence.
 *
 * WHICH SIDE OF THE BOOK it speaks for is the service's too, taken from the
 * scope beside the tick. It is not passed down for the reason the mode is not:
 * this file would only be carrying it from one signal to one door.
 */
export function lead(this: CaptureViewComponent, photoId: string): void {
  this.captures.leadTheBook(photoId, this.captures.pass() === 'split' ? 'cut' : 'crop');
}

/** Turn this photograph, or the whole book with it. The tick decides. */
export function turnThis(this: CaptureViewComponent, photoId: string, turns: number): void {
  if (this.global()) this.captures.turnWithTheBook(photoId, turns);
  else this.captures.turnPhotos([photoId], turns);
}

/** Take the crop off this photograph, and off the followers if it leads. */
export function clearCropHere(this: CaptureViewComponent, photoId: string): void {
  const leading = this.global();
  this.captures.clearCrop(photoId);
  if (leading) this.lead(photoId);
}

/*
 * `setGlobal` STOOD HERE AND THE TICK NO LONGER TOUCHES A PHOTOGRAPH.
 *
 * It ran the two halves of Wave 51's checkbox: ticked, the book adopted this
 * page's lines; unticked, `markComplete` took the page out of the book's
 * hands. Both are gone with the derived box (`global` above).
 *
 * The tick arms the MODE and moves nothing — `captures.setGlobal`, straight
 * from the template, because there is nothing left for this file to decide.
 * What each half did survives in the gesture: with the mode on, a drag on a
 * page that was its own hands it back AND leads the book (`leadTheBook`, whose
 * lead is always dressed); with the mode off, a drag marks the page its own
 * (`setQuads`, `mine`). Re-ticking now moves nothing until the next gesture,
 * which is the whole point of a mode — a box that re-dressed the book on being
 * ticked could not be ticked in preparation for anything.
 */

/**
 * PUT THE WHOLE BOOK BACK, having asked first.
 *
 * ── The one confirmed global in this stage, and the question says why ─────
 *
 * Every other act here spares a photograph somebody placed by hand. This one
 * reaches them, which is the whole reason it exists — the evening where the
 * assumption that a hand-placed crop is correct is the thing that went wrong —
 * and a reach like that has to be asked for rather than discovered. The detail
 * names what SURVIVES as well as what goes, on `confirmRemoval`'s rule: a
 * person should be frightened of the right thing and no more.
 */
export async function confirmReset(this: CaptureViewComponent): Promise<void> {
  const splitting = this.captures.pass() === 'split';
  const agreed = await this.confirm.ask({
    message: splitting
      ? 'Put every page in this book back together?'
      : 'Give every photograph in this book the whole frame back?',
    detail: splitting
      ? [
          'Every spread is rejoined into one page and the book\'s cut is cleared — including '
          + 'the ones you cut yourself.',
          'Every crop stays exactly where it is, and nothing is deleted: the photographs are '
          + 'all still here.',
        ]
      : [
          'Every crop is cleared and so is the book\'s own — including the pages you placed '
          + 'yourself.',
          'The turns stay, and nothing is deleted: the photographs are all still here.',
        ],
    confirm: splitting ? 'Rejoin them all' : 'Reset them all',
  });
  if (agreed) this.captures.resetAll(splitting ? 'cut' : 'crop');
}

/**
 * GIVE EVERY PAGE SOMEBODY SET THEMSELVES BACK TO THE BOOK, having asked.
 *
 * ── Owen's ruling, and why the confirm is not optional ────────────────────
 *
 * *"if the page was individually edited, it's exempt from the global
 * settings, unless the user specifically overrides all individual settings to
 * revert to global."* The exemption holds everywhere in this stage; this is
 * the override, and it is the second act in the whole feature that overrules a
 * hand. `followThese` above needs no question because it reaches the
 * photographs somebody has just selected and one drag takes any of them back.
 * This one reaches a population the person cannot see from inside the modal,
 * and the lines it replaces were placed one at a time over an evening.
 *
 * ── THE COUNT IS THE QUESTION ─────────────────────────────────────────────
 *
 * "Some pages will change" is the shape of question people press through.
 * *Seven photographs you set yourself* is a number somebody can weigh against
 * what they remember doing — and it is `prepare().complete`, the same
 * derivation as the dots on the cards and the button's own presence, so the
 * dialog cannot promise a reach the act does not have.
 *
 * ── AND IT NAMES WHAT SURVIVES ────────────────────────────────────────────
 *
 * `confirmRemoval`'s rule: a person should be frightened of the right thing
 * and no more. What survives here is everything the neighbouring Reset would
 * destroy — the book's own lines, and every original — so the detail says so
 * rather than leaving two adjacent destructive acts to be told apart by their
 * labels.
 */
export async function confirmFollowAll(this: CaptureViewComponent): Promise<void> {
  const splitting = this.captures.pass() === 'split';
  const mine = this.captures.prepare().complete;
  // Unreachable while the button is drawn only where there is somebody to
  // hand back, and cheap insurance against a dialog that promises nothing.
  if (mine === 0) return;
  const many = mine !== 1;
  const who = many ? `${mine} photographs` : 'One photograph';
  const their = many ? 'their' : 'its';
  const agreed = await this.confirm.ask({
    message: 'Give every page you set yourself back to the book?',
    detail: splitting
      ? [
          `${who} you set yourself will take the book's cut again — the line ${their} side of `
          + 'the book is set to.',
          'The cuts you placed go, and the marks go with them: every global from here reaches '
          + 'those pages. Crops stay, because this pass does not move a corner.',
          'The book\'s own lines do not change and nothing goes back to the original — Reset '
          + 'every split is the act that does that.',
          'A page whose side of the book has no cut to give it, or whose frame is a different '
          + 'shape, keeps the lines it has and gives up its mark all the same.',
        ]
      : [
          `${who} you set yourself will take the book's lines again — the crop and cut ${their} `
          + 'side of the book is set to.',
          'The lines you placed on them go, and the marks go with them: every global from here '
          + 'reaches those pages.',
          'The book\'s own lines do not change and nothing goes back to the original — Reset '
          + 'every crop is the act that does that.',
          'A page whose side of the book has nothing to give it, or whose frame is a different '
          + 'shape, keeps the lines it has and gives up its mark all the same.',
        ],
    confirm: 'Give them all back',
  });
  if (agreed) this.captures.followAllAgain();
}

/**
 * The Two-pages tick, both ways.
 *
 * Routed through ONE method rather than two template expressions, because the
 * two directions are one control: a template that wired the cut and forgot the
 * rejoin would give a tick that goes one way and sticks, and nothing about the
 * markup would look wrong.
 */
export function setTwoPages(this: CaptureViewComponent, photoId: string, on: boolean): void {
  /*
   * READ BEFORE THE ACT, because both branches can mark the photograph: a cut
   * placed down the middle (with no book's cut to take) is a placement, and a
   * rejoin always is. Re-asking afterwards would find the tick off and drop
   * the propagation — and worse, would leave the box unticking itself under a
   * hand that had only said "this one is a spread too".
   */
  const leading = this.global();
  if (on) this.captures.cutHere(photoId);
  else this.captures.clearSplit(photoId);
  if (leading) this.lead(photoId);
}

/*
 * FIVE MODAL PRESSES WERE ANSWERED HERE AND ALL FIVE ARE GONE (Wave 51).
 *
 * `turnTheRest` (the bulk turn), `record` and `applyAll` (the book's standing,
 * written and written-then-applied), `sayRight` (the say-so) and `followAgain`
 * (take the book's crop and follow it again), plus the `applaud` that lit each
 * of them for a second and a half.
 *
 * Everything they did survives, reached from the state rather than from a row
 * of buttons: `turnWithTheBook`, `leadTheBook` and `matchTheOthers`, all three
 * driven by the Global tick or by the gesture it governs. The say-so is the
 * tick unticked — it said "this one is mine" and then STEPPED, which is the
 * one thing a person claiming a page is usually not about to do.
 */

/**
 * Mint, and then let both surfaces that name the current book catch up.
 *
 * THE SHELF MOVES HERE AND NOWHERE ELSE, so this is the one place that has to
 * ask again. The rail's sentence reads the recipe's arrangement against the
 * one the shelf's book was minted from, and the step list marks WHICH ROW is
 * that book -- both of them main's single resolution, and both of them stale
 * the instant a mint lands until somebody asks.
 *
 * Only on success. A cancelled or failed mint moved no shelf, and re-reading
 * after one would be two round trips to learn that nothing changed.
 */
export async function startMint(this: CaptureViewComponent): Promise<void> {
  /*
   * THE DISK IS WHAT GETS MINTED, so it has to be current before the press.
   * `mintBegin` reads the recipe from the file rather than taking it over the
   * bridge, and the save is debounced -- so without this, a corner moved or a
   * page turned in the last four hundred milliseconds is missing from the PDF
   * and from the arrangement recorded beside it, which means nothing on the
   * surface would ever say so.
   */
  // A DISK THAT IS BEHIND THE SCREEN IS NOT MINTED (Owen, 2026-09-21: the
  // product's cuts were not where the stage drew them). `flush` throws when
  // the write it owes could not be made, and the mint is not started over
  // a recipe two gestures old.
  try {
    await this.captures.flush();
  } catch (err) {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
    return;
  }
  const step = await this.mint.mint(this.tab().path);
  if (step === null) return;
  await this.captures.refreshMintedFrom();
  await this.ledger.refresh(this.tab().path);
}
