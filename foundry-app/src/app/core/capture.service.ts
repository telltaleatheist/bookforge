import { Injectable, computed, inject, signal } from '@angular/core';

import type {
  CaptureIntaken,
  CaptureIntakeProgress,
  CaptureLines,
  CapturePage,
  CapturePhoto,
  CapturePoint,
  CapturePrepared,
  CaptureQuad,
  CaptureRecipe,
  CaptureSplit,
  CaptureStanding,
} from '@owen/foundry-core/shared/types';

import {
  arrangementOf, cutOf, halvesOf, isPdfName, isWholeFrameTurned, joinedQuad,
  splitFromFraction, turnedLike, turnQuad, turnsOf, WHOLE_FRAME,
} from '@owen/foundry-core/shared/capture';
import type { CaptureCard } from '../components/capture-grid/capture-grid.component';
import { api } from './foundry';
import { NoticeService } from './notice.service';
import { PdfPagesService } from './pdf-pages.service';
import { ApplyOutcome, runsWith, CaptureScope } from './capture-outcomes';
import { isComplete, placed, standings } from './capture-geometry';
export type { ApplyOutcome, StampCost, PrepareCounts, Parity, CaptureScope } from './capture-outcomes';
export { isComplete } from './capture-geometry';
import * as intaking from './capture-intake';
import * as costing from './capture-costs';
import * as leading_ from './capture-leading';
import * as editing from './capture-editing';
import * as applying from './capture-applying';

/**
 * THE LIGHT TABLE'S STATE — the recipe, and every rule about changing it.
 *
 * ── Where the line falls between this and the components ────────────────────
 *
 * The grid owns an arrangement and the editor owns four corners; NEITHER owns
 * the recipe, and neither can reach IPC. Everything they emit arrives here as a
 * question about the whole project — which photographs are the same shape as
 * this one, which pages belong to which photo, what the order means once
 * somebody has dragged — because those are the questions a single card cannot
 * answer about itself.
 *
 * That is also what lets the two components be pointed at anything: the doc's
 * trap about reversing spreads rather than page cards (below) is a rule about
 * photos, and only this service holds photos.
 *
 * ── PICTURES REACH THE PAGE THROUGH THE DOOR, NEVER THROUGH IPC ─────────────
 *
 * `foundry-file://capture/<token>/<name>`, where the token comes back from
 * `create`, `intake` or `recipeLoad` and the names are `photo.thumb` and
 * `photo.workingCopy` — PLAIN BASENAMES out of `capture/derived/`, which is the
 * only directory the capture token reaches. Nothing here composes a path: the
 * names are written by intake and carried in the recipe, so the layout on disk
 * is main's business alone.
 *
 * THE BANK HAS NO DOOR. `capture/originals/` — the HEIC files that are somebody's
 * only copy of an afternoon in an archive — is not merely unserved but
 * UNADDRESSABLE through the scheme, because no string this service could compose
 * reaches out of `derived/`. That is a property of the flat-name rule rather than
 * a check anybody has to keep right (feature channel, seq 40).
 *
 * ── The recipe is saved WHOLE, and debounced ────────────────────────────────
 *
 * `capture:recipe-save` takes the entire document every time — it is kilobytes
 * for hundreds of photographs, and a patch protocol would be a second way to say
 * what the file already says. Dragging a corner emits on every pointermove, so
 * the writes are debounced here rather than in the editor: the editor should not
 * have to know that saving costs anything.
 */
@Injectable({ providedIn: 'root' })
export class CaptureService {
  readonly notices = inject(NoticeService);
  readonly pdfPages = inject(PdfPagesService);

  readonly directory = signal<string | null>(null);
  readonly door = signal<string | null>(null);
  readonly current = signal<CaptureRecipe | null>(null);

  /**
   * HOW FAR AN INTAKE HAS GOT, or null when none is running.
   *
   * A PUSH RATHER THAN THE INVOKE'S ANSWER, because the invoke cannot speak
   * until it is finished and it is not finished for the better part of a minute
   * (`capture:intake-progress`, main's side). The subscription is armed once
   * for the life of the service rather than per intake: an intake that started
   * before anybody subscribed would push into nothing, and there is no second
   * chance at a progress event.
   *
   * THE CARD LIVES FOR THE INVOKE, NOT FOR THE PUSHES: set before the call and
   * cleared in a finally, so its lifetime is exactly the work it describes.
   *
   * IT IS NOT COUPLED TO THE CHANNEL, and that is the whole reason. If a push
   * never arrives — main throws before the loop, the listener misses its
   * registration, the broadcast goes to a window that has been replaced — a card
   * that waited for one would wait forever, and the person is back to a frozen
   * window with nothing on it, which is the exact complaint it exists to answer.
   * Shown on the invoke it cannot fail to appear, whatever the other end does;
   * cleared in the finally it cannot outlive the work. The pushes only decorate
   * a card that was already going to be there.
   *
   * (An earlier version of this paragraph justified the same decision by saying
   * the first push does not arrive until a photograph is decoded, "over a second
   * on this shoot". P1 measured it at 110 ms — the emit is BEFORE the work, not
   * after it, which is the same decision that makes the payload name the
   * photograph in hand. A correct choice defended by a false claim is the shape
   * this project keeps refusing, so the claim is gone rather than softened.)
   */
  readonly run = signal<CaptureIntakeProgress | null>(null);
  readonly intakeProgress = this.run.asReadonly();

  /**
   * WHOSE HAND IS ON THE HANDLES — *Global*, and it is a MODE (Wave 51b).
   *
   * ── Owen's correction, in his own words ───────────────────────────────────
   *
   * *"if i uncheck global, make it so it doesnt switch back to checked unless i
   * specifically set it back … my workflow is i set the global configuration for
   * everything, and then i uncheck global and go through every page and tweak
   * them individually. i dont want to have to uncheck global for every one."*
   *
   * Wave 51 derived the tick from the open photograph (`!isComplete`), which was
   * an honest reading of a state and the wrong control for the work. The second
   * half of an evening is one pass through fifty pages nudging each one, and a
   * box derived per photograph is a box that ticks itself back on fifty times —
   * so the person is unticking a checkbox before every single gesture, and any
   * one they forget silently moves the whole book.
   *
   * So the box is a mode: it flips when somebody clicks it and at no other
   * moment. Stepping between photographs never touches it.
   *
   * ── IT IS NOT IN THE RECIPE, AND THAT IS THE RULING ───────────────────────
   *
   * The recipe records what the BOOK is: its lines, and which photographs have
   * been taken out of the book's hands. Which way a person is working this
   * evening is not a fact about the book — it is a fact about the hand — and
   * storing it would mean opening a project tomorrow with the corners already
   * disarmed because of how the last session ended. It starts ticked on every
   * open, which is the state a person can see is safe: the first gesture places
   * the book's crop, which is what an evening starts with.
   *
   * ── AND UNCHECKING MARKS NOTHING ──────────────────────────────────────────
   *
   * Wave 51's untick wrote `complete: true` on the open photograph, because the
   * box WAS that field. A mode cannot: unticking is a person saying "the next
   * things I do are local", not a claim about the picture they happen to be
   * looking at. A page becomes its own by being MOVED while the mode is off
   * (`setQuads(..., mine)`), and a page nobody touches stays a follower — which
   * is exactly the walk-every-page workflow the mode exists for.
   */
  readonly leading = signal(true);
  readonly global = this.leading.asReadonly();

  /**
   * WHICH PAGES A GLOBAL GESTURE REACHES — all of them, or one side of the book.
   *
   * Owen: *"im thinking we can add a 'just even pages' and 'just odd pages'
   * global setting. this change only applies to every other page, but its
   * global."* The case is recto/verso: a book shot one page at a time from a
   * fixed stand puts the left-hand pages in one part of the frame and the
   * right-hand pages in another, so one crop is right about half the book by
   * construction.
   *
   * Session state beside the mode, and not in the recipe, for the mode's own
   * reason: it says which pages the NEXT gesture speaks for. What the gesture
   * leaves behind — `CaptureStanding.odd` / `.even` — is the book's and is
   * stored.
   */
  readonly reach = signal<CaptureScope>('all');
  readonly scope = this.reach.asReadonly();

  /** The person clicked *Global*. The only thing that moves the mode. */
  setGlobal(on: boolean): void {
    this.leading.set(on);
  }

  /** The person chose which side of the book a global gesture speaks for. */
  setScope(scope: CaptureScope): void {
    this.reach.set(scope);
  }

  /** The recipe on screen, or null when no capture project is open. */
  readonly recipe = this.current.asReadonly();

  /**
   * The cards for the grid, in the recipe's own order.
   *
   * A page whose photo has gone — which nothing writes today, but a hand-edited
   * recipe could — is dropped rather than drawn as a hole, and the count on the
   * header is the number of cards actually drawn.
   */
  readonly cards = computed<readonly CaptureCard[]>(() => {
    const recipe = this.current();
    if (recipe === null) return [];
    const cards: CaptureCard[] = [];
    for (const id of recipe.order) {
      const found = this.pageIn(recipe, id);
      if (found === null) continue;
      cards.push({
        id,
        photoId: found.photo.id,
        thumb: this.url(found.photo.thumb),
        label: `Page ${cards.length + 1}`,
        struck: found.page.struck,
        // The card draws it, so a turn and a crop are visible on the table
        // rather than only inside the editor.
        quad: found.page.quad,
        // The pixels the quad is a fraction OF -- what the card needs to know
        // which way round the page it draws will come out.
        width: found.photo.width,
        height: found.photo.height,
        /*
         * THE BOOK WILL NOT MOVE THIS PHOTOGRAPH, and the table has to show it.
         *
         * "Never overwritten" means a page can sit out every future global for
         * the life of the project. Without a mark on the card, somebody presses
         * Apply, counts the ones that did not move, and has no way to find
         * them -- the rail says "2 by hand" and nothing anywhere says WHICH two.
         * That was tolerable while the mark was a policy nobody could see; it
         * stops being tolerable the moment the mark is the thing standing
         * between a person and the crop they placed.
         *
         * IT IS `isComplete` AND NOT `byHand`, which is Wave 25's whole point:
         * the mark on the card and the test the stamp makes have to be one
         * question, or the dot promises a skip that does not happen. A page
         * completed by the say-so carries no `byHand` anywhere and must still
         * be marked.
         *
         * The FIELD is still called `own` because the card declares it and the
         * card is P2's fence; P2 renames it with the dot it draws.
         *
         * ON THE PHOTOGRAPH, so both halves of a cut spread carry it. Complete
         * is a fact about the picture, and a spread showing the mark on one
         * card and not the other would read as a defect rather than as a pair.
         */
        own: isComplete(found.photo),
      });
    }
    return cards;
  });

  /**
   * WHETHER SOMEBODY HAS ARRANGED THESE PAGES BY HAND — derived, never stored.
   *
   * The doc rules that "once the user has dragged, the sort is history and their
   * order is the order", and the recipe has nowhere to record that it happened.
   * It does not need one: the order either still runs in capture-time sequence
   * or it does not, and that is a fact ABOUT the order, so reading it off the
   * order cannot get out of step with the order the way a flag could.
   * `descending` was such a flag and left the recipe for this reason (main
   * 9a5a24c, from this service's own argument).
   *
   * ── Read off the TIMES rather than the ids, because of ties ────────────────
   *
   * The obvious derivation — sort the ids and compare the two arrays — breaks on
   * equal capture times, and equal times are not exotic here. A burst is one; a
   * bulk copy that leaves every file with the same mtime is twenty-seven, and
   * `takenAtSource: 'mtime'` says that is exactly how some of these times were
   * got. Where times tie, the ascending and descending sorts produce THE SAME
   * array, so one press of the reverse button would leave an order matching
   * neither, and the toggle would disable itself permanently on a shoot whose
   * only fault was being copied in one go.
   *
   * So this asks the question that survives ties: does the sequence of times
   * ever move against itself? If it never does, in either direction, the sort
   * still applies and nobody has arranged anything.
   *
   * The one imprecision left is worth naming and is harmless: a drag that moves a
   * card WITHIN a run of equal times is not noticed, because nothing changed that
   * the sort has an opinion about.
   */
  readonly arranged = computed(() => {
    const times = this.orderedTimes();
    return !runsWith(times, 1) && !runsWith(times, -1);
  });

  /* `descending` stood here — the reverse button's label. See `sortBy`. */

  constructor() {
    /*
     * ARMED FOR THE LIFE OF THE SERVICE, and never torn down: this is a root
     * singleton that lives as long as the window, so an unsubscribe would only
     * ever run at shutdown. Holding the returned function and never calling it
     * would be ceremony that reads like a leak somebody forgot to close.
     */
    api?.capture.onIntakeProgress((progress) => this.run.set(progress));

    /*
     * THE WINDOW GOING AWAY IS AN EXIT LIKE ANY OTHER, and it is the one exit
     * that cannot wait 400ms.
     *
     * BEST EFFORT, AND SAID PLAINLY RATHER THAN IMPLIED: `beforeunload` cannot
     * await anything, so this starts the write immediately instead of leaving it
     * on a timer. That turns "up to 400ms of unwritten work, guaranteed lost"
     * into "a write already in flight", which is a large improvement and not a
     * guarantee. The guarantee would have to be main refusing to close while a
     * recipe write is outstanding, which is a bigger change than this defect
     * earns and belongs to whoever asks for it.
     */
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => void this.flush());
    }
  }

  flush(): Promise<void> { return intaking.flush.call(this); }

  armed(): void { return intaking.armed.call(this); }

  /** A door URL for a name intake wrote. Never a path this service composed. */
  url(name: string): string {
    const token = this.door();
    return token === null ? '' : `foundry-file://capture/${token}/${encodeURIComponent(name)}`;
  }

  /** The working copy of the photo a page belongs to, for the editor. */
  workingCopyUrl(pageId: string): string {
    const recipe = this.current();
    if (recipe === null) return '';
    return this.url(this.pageIn(recipe, pageId)?.photo.workingCopy ?? '');
  }

  create(title: string): Promise<string | null> { return intaking.create.call(this, title); }

  open(projectDir: string): Promise<void> { return intaking.open.call(this, projectDir); }

  intake(projectDir: string, files: readonly File[]): Promise<CaptureIntaken | null> { return intaking.intake.call(this, projectDir, files); }

  intakePaths(projectDir: string, paths: readonly string[], unreadable: number): Promise<CaptureIntaken | null> { return intaking.intakePaths.call(this, projectDir, paths, unreadable); }

  reorder(order: readonly string[]): void { return intaking.reorder.call(this, order); }

  sortBy(key: 'name' | 'taken', descending: boolean): void { return intaking.sortBy.call(this, key, descending); }

  remove(photoIds: readonly string[]): Promise<void> { return intaking.remove.call(this, photoIds); }

  toggleStrike(pageId: string): void { return intaking.toggleStrike.call(this, pageId); }

  readonly prepare = costing.prepare.call(this);

  /**
   * WHAT THE BOOK ON THE SHELF WAS MINTED FROM — main's answer, not ours.
   *
   * A fingerprint of the arrangement the current book was made from, or null.
   * Main resolves WHICH book that is by walking the catalogue's pdf chain from
   * the tip down to the nearest step that recorded one, and this is simply
   * carried: the renderer computes the LIVE side and never the stored one, so
   * there is one answer to "which book is a person looking at" rather than two
   * that can disagree.
   */
  readonly mintedFrom = signal<string | null>(null);

  readonly diverged = costing.diverged.call(this);

  refreshMintedFrom(): Promise<void> { return costing.refreshMintedFrom.call(this); }

  readonly applyCost = costing.applyCost.call(this);

  readonly applyPopulations = costing.applyPopulations.call(this);

  standingFor(photoId: string): CaptureLines | undefined { return costing.standingFor.call(this, photoId); }

  /**
   * WHETHER THE BOOK HAS A CROP ANYWHERE, and whether it has a cut anywhere.
   *
   * Any of the three standings — the book's own, the odd side's, the even
   * side's — because these gate whether an act EXISTS. A book whose odd pages
   * have a crop and whose own has none has something to finalize, and a rail
   * that drew no button would be hiding an act that would work.
   */
  readonly anyCrop = computed<boolean>(() => standings(this.current()?.book).some(
    (lines) => lines.crop !== undefined,
  ));
  readonly anyCut = computed<boolean>(() => standings(this.current()?.book).some(
    (lines) => lines.cut !== undefined,
  ));

  readonly sided = costing.sided.call(this);

  bookCutFor(photoId: string): CaptureSplit | null { return leading_.bookCutFor.call(this, photoId); }

  matchTheOthers(photoId: string): void { return leading_.matchTheOthers.call(this, photoId); }

  followAllAgain(): void { return leading_.followAllAgain.call(this); }

  leadTheBook(photoId: string, what: 'crop' | 'cut'): void { return leading_.leadTheBook.call(this, photoId, what); }

  turnWithTheBook(photoId: string, turns: number): void { return leading_.turnWithTheBook.call(this, photoId, turns); }

  resetAll(what: 'crop' | 'cut'): void { return leading_.resetAll.call(this, what); }

  ticked(verb: keyof CapturePrepared): boolean { return editing.ticked.call(this, verb); }

  tick(verb: keyof CapturePrepared): void { return editing.tick.call(this, verb); }

  readonly evident = costing.evident.call(this);

  setQuads(photoId: string, quads: readonly CaptureQuad[], mine?: Parameters<typeof editing.setQuads>[2]): void { return editing.setQuads.call(this, photoId, quads, mine); }

  turnPhotos(photoIds: readonly string[], turns: number): void { return editing.turnPhotos.call(this, photoIds, turns); }

  clearCrop(photoId: string): void { return editing.clearCrop.call(this, photoId); }

  clearSplit(photoId: string): void { return editing.clearSplit.call(this, photoId); }

  cutHere(photoId: string): void { return editing.cutHere.call(this, photoId); }

  setSplit(photoId: string, split: CaptureSplit, mine?: Parameters<typeof editing.setSplit>[2]): void { return editing.setSplit.call(this, photoId, split, mine); }

  readonly pass = costing.pass.call(this);

  applyCrops(): ApplyOutcome { return applying.applyCrops.call(this); }

  applyCuts(): ApplyOutcome { return applying.applyCuts.call(this); }

  reopen(): void { return applying.reopen.call(this); }

  pageIn(recipe: CaptureRecipe, pageId: string): { photo: CapturePhoto; page: CapturePhoto['pages'][number] } | null { return applying.pageIn.call(this, recipe, pageId); }

  private orderedTimes(): readonly string[] { return applying.orderedTimes.call(this); }

  change(edit: (recipe: CaptureRecipe) => CaptureRecipe): void { return applying.change.call(this, edit); }

  saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * THE RECIPE THE DISK DOES NOT HAVE YET, or null when the disk is current.
   *
   * ── Owen, 2026-09-21: *"it looked like it placed the page splits in the
   * right spot, but when i assembled the final product, the page splits dont
   * appear to be where the arm was"* ──────────────────────────────────────
   *
   * The mint reads the recipe FROM DISK (`mintBegin`), so the only way the
   * product can disagree with the stage is a disk that is behind the screen.
   * `flush` used to close that gap only while a save was still PENDING: a
   * debounced write that had already run and FAILED -- a validation refusal,
   * a volume that was busy -- left the timer null, so `flush` wrote nothing,
   * and the mint that followed was made from the last recipe that did land,
   * with a notice about the failure two gestures back as the only sign. This
   * field is the edit itself, held until a write succeeds, so `flush` has
   * something to write whether the failure was a timer or a refusal.
   */
  unsaved: CaptureRecipe | null = null;

  save(recipe: CaptureRecipe): void { return applying.save.call(this, recipe); }

  write(bridge: NonNullable<typeof api>, dir: string, recipe: CaptureRecipe): Promise<void> { return applying.write.call(this, bridge, dir, recipe); }

  complain(err: unknown): void { return applying.complain.call(this, err); }
}
