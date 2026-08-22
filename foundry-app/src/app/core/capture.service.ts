import { Injectable, computed, inject, signal } from '@angular/core';

import type {
  CaptureIntaken,
  CaptureIntakeProgress,
  CapturePage,
  CapturePhoto,
  CapturePrepared,
  CaptureQuad,
  CaptureRecipe,
  CaptureSplit,
  CaptureStanding,
} from '@shared/types';

import {
  arrangementOf, halvesOf, isWholeFrameTurned, joinedQuad, sameShape, splitFromFraction,
  turnedLike, turnQuad, turnsOf, WHOLE_FRAME,
} from '@shared/capture';
import type { CaptureCard } from '../components/capture-grid/capture-grid.component';
import { api } from './foundry';
import { NoticeService } from './notice.service';

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
  private readonly notices = inject(NoticeService);

  private readonly directory = signal<string | null>(null);
  private readonly door = signal<string | null>(null);
  private readonly current = signal<CaptureRecipe | null>(null);

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
  private readonly run = signal<CaptureIntakeProgress | null>(null);
  readonly intakeProgress = this.run.asReadonly();

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

  /**
   * WRITE THE RECIPE NOW, AND WAIT FOR IT.
   *
   * ── The defect this exists for ──────────────────────────────────────────────
   *
   * The save is debounced 400ms, and `mintBegin` READS THE RECIPE FROM DISK.
   * So a gesture made less than 400ms before Mint is pressed is not in the
   * minted PDF -- and, because the mint records its arrangement from the same
   * disk read, it is not in the recorded arrangement either. The two agree with
   * each other, so the divergence sentence stays QUIET about a book that is
   * missing the last thing somebody did. A silent wrong page in a finished book
   * is the most expensive shape this feature has.
   *
   * ── Why callers do not each remember to call it ────────────────────────────
   *
   * The mint press awaits it, and `open` calls it before replacing what is in
   * memory with what is on disk -- which covers every read-over path there is,
   * including switching to another project and back, rather than the one path
   * somebody thought of. A rule enforced at the door beats the same rule
   * restated at each caller.
   *
   * Nothing pending is the ordinary case and costs one comparison: the timer is
   * null whenever the last write has already gone.
   */
  async flush(): Promise<void> {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const dir = this.directory();
    const recipe = this.current();
    if (api === null || dir === null || recipe === null) return;
    try {
      await api.capture.recipeSave(dir, recipe);
    } catch (err) {
      this.complain(err);
    }
  }

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

  /** Start a capture project and stand in it. */
  async create(title: string): Promise<string | null> {
    if (api === null) return null;
    try {
      const made = await api.capture.create(title);
      this.directory.set(made.projectDir);
      this.door.set(made.token);
      this.current.set(made.recipe);
      return made.projectDir;
    } catch (err) {
      this.complain(err);
      return null;
    }
  }

  /** Open the recipe of a capture project already on disk. */
  async open(projectDir: string): Promise<void> {
    if (api === null) return;
    /*
     * THE PREVIOUS PROJECT'S LAST GESTURE, BEFORE THIS ONE OVERWRITES IT.
     *
     * This method replaces the recipe in memory with the one on disk, so
     * anything still sitting on the save timer would be gone -- and the light
     * table calls it whenever the tab changes project, which is an ordinary
     * thing to do half a second after moving a corner. It flushes the OLD
     * directory because `this.directory()` has not moved yet.
     */
    await this.flush();
    try {
      const opened = await api.capture.recipeLoad(projectDir);
      this.directory.set(projectDir);
      this.door.set(opened.token);
      this.mintedFrom.set(opened.mintedFrom);
      this.current.set(opened.recipe);
    } catch (err) {
      this.complain(err);
    }
  }

  /**
   * Files dropped on the strip.
   *
   * The renderer turns each `File` into a path with `pathForFile` and main does
   * everything else — copying, hashing, decoding, the capture time, the working
   * copy and the thumbnail. A file the browser gave us no path for is skipped
   * and said aloud rather than dropped silently: that happens for a drag out of
   * another application's virtual folder, and the person deserves to know their
   * photograph did not arrive.
   */
  async intake(projectDir: string, files: readonly File[]): Promise<CaptureIntaken | null> {
    /*
     * THE CALLER NAMES THE PROJECT, and that is not ceremony.
     *
     * This used to read `this.directory()`, which is set only AFTER
     * `recipeLoad` resolves. Two things came of that. A drop that landed while
     * the recipe was still loading found it null and returned in SILENCE — the
     * photographs simply did not arrive and nothing said so. And the window
     * drop handler routes on the front TAB while this read the SERVICE, so the
     * two could name different projects and the photographs would land in the
     * wrong one.
     *
     * The tab knows which project it is. Taking it as an argument makes the two
     * one fact, and lets a drop work during the load rather than vanish into it.
     */
    if (api === null) return null;
    const paths: string[] = [];
    for (const file of files) {
      const path = api.pathForFile(file);
      // COUNTED, NOT ANNOUNCED HERE. A per-file notice inside this loop
      // overwrites itself: drag in twenty photographs out of another
      // application's virtual folder and the bar shows the twentieth name and
      // nothing about the other nineteen. The one sentence at the end says how
      // many, beside everything else that happened.
      if (path !== '') paths.push(path);
    }
    return this.intakePaths(projectDir, paths, files.length - paths.length);
  }

  /**
   * The same intake, named by PATH rather than by a dropped `File`.
   *
   * ── Why the door was split in two (Wave 38) ────────────────────────────────
   *
   * `intake` above is the DROP door: something arrived from outside the window
   * and the browser's handle on it has to be turned into a path before main can
   * be told anything. That is the only thing it does that this does not.
   *
   * The intake workspace already holds paths — it took each one with
   * `pathForFile` at the moment of the drop, because an object URL outlives the
   * drag and `webUtils` is only reachable from the preload — so routing it back
   * through a `File` list would be this app converting a path into a browser
   * object in order to convert it into a path again. Worse, it would be the
   * workspace holding the ONE handle that must not be re-derived later, and
   * re-deriving it anyway.
   *
   * `unreadable` is the count the caller could not turn into a path at all. It
   * is a parameter rather than a fact this method could work out, because only
   * the side holding the original list knows how many things were in it.
   *
   * ── IT ANSWERS WITH THE REPORT, WHICH IT USED TO SWALLOW ───────────────────
   *
   * The notice is still set here — every caller wants the same sentence and
   * composing it twice is how two surfaces start disagreeing about what just
   * happened. What is new is that the report is also RETURNED, because "create
   * a book from these" has a second question the notice cannot answer: did the
   * intake happen at all? A caller that empties its own list on the strength of
   * an intake that threw would have destroyed the only copy of the person's
   * selection. `null` is "it did not run"; anything else is main's account of
   * what it did, refusals and all.
   */
  async intakePaths(
    projectDir: string,
    paths: readonly string[],
    unreadable: number,
  ): Promise<CaptureIntaken | null> {
    if (api === null) return null;
    if (paths.length === 0) {
      this.notices.notice.set(
        unreadable === 1
          ? 'That file could not be read from where it was dragged from.'
          : `None of those ${unreadable} files could be read from where they were dragged from.`,
      );
      return null;
    }
    // Shown from the moment the ask is made rather than from main's first
    // push, which does not arrive until a photograph is decoded.
    this.run.set({ projectDir, done: 0, total: paths.length, file: '' });
    try {
      const intaken = await api.capture.intake(projectDir, [...paths]);
      this.directory.set(projectDir);
      this.door.set(intaken.token);
      this.current.set(intaken.recipe);
      this.notices.notice.set(reportOn(intaken, unreadable));
      return intaken;
    } catch (err) {
      this.complain(err);
      return null;
    } finally {
      // Cleared here and nowhere else: main's closing push says done === total,
      // but the recipe is not on screen until the invoke has answered, and a
      // card that vanished at the last push would uncover a grid that has not
      // caught up yet.
      this.run.set(null);
    }
  }

  /** The person dragged a card: their order is the order from here on. */
  reorder(order: readonly string[]): void {
    this.change((recipe) => ({ ...recipe, order: [...order] }));
  }

  /**
   * SORT, BY SPREAD AND NOT BY CARD — the doc's sharpest trap, inherited from
   * the reverse button this act replaces.
   *
   * "A book shot back-to-front reverses into reading order by spread; within
   * each split the left page still precedes the right. Reversing raw page cards
   * would silently swap every pair." The same holds for any reordering: the
   * PHOTOGRAPHS are sorted and each photograph's own pages ride along in their
   * standing sequence. Grouping is by first appearance rather than by the
   * recipe's photo list, because after a drag the order is the person's and the
   * groups should follow what is on screen.
   *
   * ── Two keys, both Owen's (2026-08-22) ───────────────────────────────────
   *
   * *"it should be able to sort them by filename or by date saved. ascending
   * or descending. sorting by filename will sort by date anyway since these
   * files are screenshots."* A phone shoot carries EXIF times and sorts by
   * them; a screenshot shoot carries mtimes that survive some copies and not
   * others, and its FILENAMES carry the truth. So both keys are offered and
   * neither is guessed at.
   *
   * NAME IS A NATURAL COMPARE (`numeric: true`), so "page 2" precedes
   * "page 10" — a plain lexicographic sort puts them the other way, which on a
   * numbered shoot is the whole book shuffled. `takenAt` is an ISO-8601 string
   * and compares as itself.
   *
   * A SORT IS ALLOWED ON AN ARRANGED TABLE, where the old reverse was not:
   * flipping an arrangement was meaningless (what is the reverse of your own
   * order?), but sorting one is a person deliberately abandoning it for a rule,
   * and the act says which rule. The sort is stable, so ties keep their
   * standing order.
   */
  sortBy(key: 'name' | 'taken', descending: boolean): void {
    this.change((recipe) => {
      const groups = new Map<string, string[]>();
      for (const id of recipe.order) {
        /*
         * An id no photograph claims groups UNDER ITSELF rather than being
         * skipped — dropping it would be a page deleted from the book by a
         * sort button, invisibly, because `cards` does not draw an
         * unresolvable id either. It can only arise from a hand-edited
         * recipe; preserving it costs one `?? id`.
         */
        const photoId = this.pageIn(recipe, id)?.photo.id ?? id;
        const group = groups.get(photoId);
        if (group === undefined) groups.set(photoId, [id]);
        else group.push(id);
      }
      const byId = new Map(recipe.photos.map((photo) => [photo.id, photo] as const));
      const keyed = [...groups.entries()].map(([photoId, pages]) => {
        const photo = byId.get(photoId);
        // The unclaimed id's own text stands in for both keys: it stays in the
        // book, sorted somewhere defensible, rather than being special-cased.
        const word = key === 'name' ? (photo?.name ?? photoId) : (photo?.takenAt ?? photoId);
        return { word, pages };
      });
      keyed.sort((one, other) =>
        one.word.localeCompare(other.word, undefined, { numeric: true, sensitivity: 'base' }));
      if (descending) keyed.reverse();
      return { ...recipe, order: keyed.flatMap((group) => group.pages) };
    });
  }

  /*
   * `reverse()` STOOD HERE AND THE SORT SUBSUMES IT (Owen, 2026-08-22). The
   * button it served could only flip a time-ordered table and disabled itself
   * the moment anybody dragged; "newest first" is now one of four sort acts
   * that work from any standing order. `descending` — the computed that
   * labelled that button — went with it; `arranged` stays, because the drag
   * hint still reads it.
   */

  /**
   * Remove photographs from the project, bank and all.
   *
   * NOT A STRIKE, and the surface must never let the two be confused: a strike
   * leaves a photograph in the project and out of the book, and this deletes the
   * recipe entry, the working copy, the thumbnail AND the original together, so
   * nothing is left orphaned.
   *
   * ONE CALL FOR THE WHOLE HANDFUL. The person answered one question about nine
   * photographs; nine calls would be nine recipe writes, nine chances to fail
   * half way, and a project that lost four of them. Main writes once.
   *
   * The recipe comes back rather than being re-read, because removal changes
   * which pages exist and the grid must not draw a card for a photograph whose
   * thumbnail has just been deleted underneath it.
   */
  async remove(photoIds: readonly string[]): Promise<void> {
    const dir = this.directory();
    if (api === null || dir === null || photoIds.length === 0) return;
    try {
      const recipe = await api.capture.remove(dir, [...photoIds]);
      this.current.set(recipe);
      this.notices.notice.set(
        photoIds.length === 1
          ? 'One photograph was removed from this project.'
          : `${photoIds.length} photographs were removed from this project.`,
      );
    } catch (err) {
      this.complain(err);
    }
  }

  /** Strike a page, or put it back. Struck pages stay on the table. */
  toggleStrike(pageId: string): void {
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) => ({
        ...photo,
        pages: photo.pages.map((page) =>
          page.id === pageId ? { ...page, struck: !page.struck } : page,
        ),
      })),
    }));
  }

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
  readonly prepare = computed<PrepareCounts>(() => {
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
  private readonly mintedFrom = signal<string | null>(null);

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
  readonly diverged = computed<boolean>(() => {
    const recipe = this.current();
    const minted = this.mintedFrom();
    if (recipe === null || minted === null) return false;
    return arrangementOf(recipe) !== minted;
  });

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
  async refreshMintedFrom(): Promise<void> {
    const directory = this.directory();
    if (api === null || directory === null) return;
    try {
      this.mintedFrom.set((await api.capture.recipeLoad(directory)).mintedFrom);
    } catch {
      // Deliberately quiet: nothing a person did failed, and the mint that just
      // landed has already spoken for itself.
    }
  }

  /**
   * HOW MANY PHOTOGRAPHS A BULK TURN WOULD ACTUALLY TURN.
   *
   * The button carries this number, so it has to count what the gesture DOES
   * rather than what the book contains: same shape (the others are named and
   * skipped, exactly as a stamp names them) and sitting at a different turn.
   * A button reading "turn the other 24" that turns twenty-three is the label
   * lying about the act, which is the complaint this whole wave came from.
   *
   * Zero is the ordinary end state -- once the book is uniform the control has
   * nothing to do, and the surface says so rather than going grey in silence.
   */
  outOfTurnWith(photoId: string): number {
    const recipe = this.current();
    if (recipe === null) return 0;
    const source = recipe.photos.find((photo) => photo.id === photoId);
    const like = source?.pages[0]?.quad;
    if (source === undefined || like === undefined) return 0;
    const facing = turnsOf(like);
    return recipe.photos.filter((photo) =>
      photo.id !== source.id
      && sameShape(source, photo)
      && photo.pages.some((page) => turnsOf(page.quad) !== facing)).length;
  }

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
  readonly applyCost = computed<StampCost>(() => {
    const { takes, complete, shape } = this.applyPopulations();
    return { takes: takes.length, complete: complete.length, shape: shape.length };
  });

  /**
   * WHO IS IN EACH OF AN APPLY'S THREE POPULATIONS -- photograph ids, disjoint
   * and exhaustive over the book, or three empty lists while the book has no
   * standing crop to measure against.
   *
   * Shape is asked before completeness, exactly as the Apply itself asks, so a
   * complete photograph of another shape lands once, under the reason the act
   * would actually give for leaving it alone. `applyCost` above is this
   * answer's lengths; the rail's pressable counts are its members.
   */
  readonly applyPopulations = computed<Record<keyof StampCost, readonly string[]>>(() => {
    const recipe = this.current();
    const crop = recipe?.book?.crop;
    const takes: string[] = [];
    const complete: string[] = [];
    const shape: string[] = [];
    if (recipe !== null && crop !== undefined) {
      for (const photo of recipe.photos) {
        if (!sameShape(crop, photo)) shape.push(photo.id);
        else if (isComplete(photo)) complete.push(photo.id);
        else takes.push(photo.id);
      }
    }
    return { takes, complete, shape };
  });

  /**
   * THE BOOK'S CUT, if this photograph is one it could apply to.
   *
   * ── The cut is fractions, so the shape is part of the question ────────────
   *
   * A cut is two points in a frame's own fraction space, exactly like a crop, so
   * it only falls on the same gutter in a frame of the same proportions. Offered
   * on a differently shaped photograph it would land somewhere plausible and
   * wrong, which is `sameShape`'s whole subject. The standing carries the frame
   * it was set on for this reason, and this is where that is spent.
   *
   * Null whenever there is nothing to offer -- no standing yet, a book of single
   * pages, or a photograph the standing was not drawn for -- and the caller
   * falls back to the middle and SAYS SO. The two are different offers and the
   * surface must not present them as one.
   */
  bookCutFor(photoId: string): CaptureSplit | null {
    const recipe = this.current();
    const crop = recipe?.book?.crop;
    const cut = recipe?.book?.cut;
    if (recipe === null || cut === undefined || crop === undefined) return null;
    const photo = recipe.photos.find((one) => one.id === photoId);
    if (photo === undefined || !sameShape(crop, photo)) return null;
    return cut;
  }

  /** Whether the book has a standing crop this photograph could take. */
  hasStanding(photoId: string): boolean {
    const recipe = this.current();
    const crop = recipe?.book?.crop;
    const photo = recipe?.photos.find((one) => one.id === photoId);
    return crop !== undefined && photo !== undefined && sameShape(crop, photo);
  }

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
   * It does nothing when there is no standing to return to, which is why the
   * control is ABSENT then rather than disabled: a control that would change
   * nothing is not shown.
   */
  matchTheOthers(photoId: string): void {
    this.change((recipe) => {
      const standing = recipe.book;
      if (standing === undefined) return recipe;
      const photos = recipe.photos.map((photo) =>
        (photo.id === photoId ? wearing(photo, standing) ?? photo : photo));
      // A standing carries a cut, so returning to it can change how many pages
      // this photograph has -- in either direction.
      return { ...recipe, photos, order: orderFor(photos, recipe.order) };
    });
  }

  /*
   * A `completeNames` LIST STOOD HERE AND WENT WITH THE QUESTION IT ANSWERED.
   *
   * It named the photographs a stamp would spare, for the dialog that asked
   * whether to overwrite them anyway. Wave 25 removed the subject rather than
   * the sentence: complete photographs are simply left out of every global, and
   * RELEASE is the explicit door for a person who wants one back in the flow --
   * a deliberate press on the one photograph they mean, rather than a question
   * at stamp time about a population they have to hold in their head.
   *
   * The names themselves are not lost. `announce` still lists what a global left
   * alone, through `namerFor`, which is where that fallback always lived.
   */

  /** Whether the person has ticked one of the rail's three verbs. */
  ticked(verb: keyof CapturePrepared): boolean {
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
  tick(verb: keyof CapturePrepared): void {
    this.change((recipe) => ({
      ...recipe,
      prepared: { ...recipe.prepared, [verb]: recipe.prepared?.[verb] !== true },
    }));
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
  readonly evident = computed<{ turned: boolean; cropped: boolean; split: boolean }>(() => {
    const recipe = this.current();
    if (recipe === null) return { turned: false, cropped: false, split: false };
    let turned = false;
    let cropped = recipe.book?.crop !== undefined;
    let split = recipe.book?.cut !== undefined;
    for (const photo of recipe.photos) {
      if (turned && cropped && split) break;
      const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
      if (!turned && turnsOf(sheet) !== 0) turned = true;
      if (!cropped && !isWholeFrameTurned(sheet)) cropped = true;
      if (!split && photo.pages.length > 1) split = true;
    }
    return { turned, cropped, split };
  });

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
   */
  setQuads(photoId: string, quads: readonly CaptureQuad[]): void {
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
                byHand: true,
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
   * ── AND IT MARKS BY HAND, for the reason setQuads does ─────────────────────
   *
   * Turning a photograph on the table IS setting it by hand — the person looked
   * at that one and said which way up it goes. Leaving the mark off would let
   * the next apply-to-all silently undo a turn somebody performed deliberately,
   * which is the exact loss the mark exists to prevent, arriving through a new
   * door. Every page of the photograph is marked, not the one that was clicked:
   * a spread is two pages of one picture and half a protection reads as none.
   */
  turnPhotos(photoIds: readonly string[], turns: number): void {
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
  clearCrop(photoId: string): void {
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
  clearSplit(photoId: string): void {
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
  cutHere(photoId: string): void {
    const recipe = this.current();
    const photo = recipe?.photos.find((one) => one.id === photoId);
    if (recipe === null || photo === undefined) return;
    const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
    const book = this.bookCutFor(photoId);
    this.setSplit(photoId, book ?? splitFromFraction(sheet, 0.5), book === null);
  }

  /**
   * The editor dragged one end of the gutter, or slid the whole cut.
   *
   * `mine` is what the cut MEANS about this photograph -- see `cutHere`. A drag
   * is always a placement and defaults to one; only the tick taking the book's
   * own cut passes false, and even then a mark the CROP earned survives.
   */
  setSplit(photoId: string, split: CaptureSplit, mine = true): void {
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
        const cut = cutWith(photo, split, mine);
        return cut === null ? photo : (mine ? placed(cut) : cut);
      });
      // A split changes which pages exist, so the order grows with it.
      return { ...recipe, photos, order: orderFor(photos, recipe.order) };
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

  /**
   * TURN THE REST OF THE BOOK TO MATCH THIS ONE — the modal's one global, and
   * now the only thing this door does.
   *
   * ── THE STAMP ARM IS GONE (W25-P3), AND WHAT REPLACED IT IS TWO ACTS ─────
   *
   * It copied one photograph's whole configuration onto every other photograph
   * of the same shape, from a button in the modal. That press is now
   * `recordCrop` — which sets the book's standing and touches nobody else — and
   * the table's `applyCrops`, which lands the standing on every photograph that
   * is not complete. The split is THE SCOPE RULE: a control in the modal speaks
   * for the photograph it has open, and a press there that changed twenty-four
   * other pictures was the modal speaking for the book.
   *
   * Everything the stamp arm knew survives in those two: `standingOf` lifts the
   * configuration, `wearing` puts it on, `isComplete` decides who is skipped and
   * `announce` says what happened. Nothing was deleted except the SURFACE the
   * act was reached from.
   *
   * ── THE TURN IS NOT SUPERSEDED, and it is a different act in two ways ────
   *
   * It applies across photographs of DIFFERENT shapes, where a crop cannot — so
   * folding it into the book's crop would make "all" mean two different sets in
   * one sentence. And it overwrites nobody's corners: `turnedLike` relabels
   * which corner prints top-left, so every crop on every photograph survives a
   * bulk turn to the last decimal.
   *
   * SHAPE STILL DECIDES WHO IS ASKED, though, because "match this one" is a
   * question about the same rectangle seen the same way round: the acceptance
   * shoot has twenty-six portrait photographs and one landscape, and the odd one
   * is NAMED rather than silently left out. `sameShape` (shared/capture.ts) is
   * the 2% test.
   *
   * IT SKIPS NOBODY FOR BEING COMPLETE, deliberately. Complete means the book
   * has stopped moving this photograph's CROP; the way round a page sits is a
   * fact the person set by turning it, and a bulk turn that spared complete
   * photographs would leave exactly the pages somebody had already worked on
   * lying the wrong way up.
   */
  applyToAll(from: string, gesture: ApplyToAll): ApplyOutcome {
    /*
     * HOISTED OUT OF THE EDIT so the caller can be told what happened. The
     * surface needs it: Owen asked for the BUTTON to acknowledge, and a button
     * that lit up on the click rather than on the act would say "Applied" over
     * a notice bar reporting that everything was skipped.
     */
    /*
     * KEPT AS A REASON PER PHOTOGRAPH so the sentence can GROUP them.
     *
     * It used to be a list of finished strings, which forced the reason to be
     * repeated once per name: "Left alone: IMG_0212 (you set that one by hand),
     * IMG_0215 (you set that one by hand), IMG_0220 (you set that one by hand)."
     * docs/CAPTURE.md asks for the other shape -- "Left alone: pages 3, 7 --
     * you set those by hand" -- which says the reason once and is the voice the
     * rest of this surface already speaks in.
     */
    const skipped: Skipped[] = [];
    let applied = 0;
    this.change((recipe) => {
      const source = recipe.photos.find((photo) => photo.id === from);
      if (source === undefined) return recipe;
      /*
       * THE ORIENTATION EVERY OTHER PHOTOGRAPH IS BEING ASKED TO MATCH, read
       * once from the source's FIRST page. Any page of it would answer the same
       * -- a split photograph's halves both carry the sheet's turn -- and one
       * read is one answer rather than one per target.
       */
      const like = source.pages[0]?.quad ?? null;
      const name = namerFor(recipe);

      const photos = recipe.photos.map((photo) => {
        /*
         * THE SOURCE IS LEFT EXACTLY AS IT IS, and it always was on this arm.
         * A turn copies no crop, so the source's crop has not become anything
         * and its mark still means what it meant. (The stamp arm cleared the
         * mark here, for a reason that died with it: it skipped the source, so
         * a marked source would have opted out of the standing it authored.
         * `recordCrop` does not skip anybody, so it clears nothing.)
         */
        if (photo.id === source.id) return photo;
        if (!sameShape(source, photo)) {
          skipped.push({ name: name(photo), why: 'shape' });
          return photo;
        }
        /*
         * MAKE THIS ONE MATCH THAT ONE -- a question about the book, and never
         * about how many times somebody pressed a button just now.
         *
         * The gesture it replaced applied a RELATIVE number of quarters counted
         * during the current visit to the editor, which had two consequences and
         * neither was intended: the control was dead on arrival at every
         * photograph (the counter resets when the picture changes), so it could
         * not be used at all without first turning something; and stepping to
         * the next page and back forgot the turns you had already made while the
         * page stayed turned.
         *
         * Reading the ORIENTATIONS instead answers the same way ten seconds
         * later or next Tuesday, which is the property `arrangementOf` has for
         * the same reason: a question about state is stable, a question about a
         * visit is not.
         *
         * A PAGE AT A TIME, because a split photograph's halves each carry the
         * sheet's own turn -- measured rather than assumed, P1's twenty-seven
         * checks -- so every page of a spread lands in the same orientation with
         * no special case for the split.
         *
         * It moves no corner. `turnedLike` is a relabelling, so every crop on
         * every photograph survives this to the last decimal.
         */
        if (like === null) return photo;
        applied += 1;
        return {
          ...photo,
          pages: photo.pages.map((page) => ({ ...page, quad: turnedLike(page.quad, like) })),
        };
      });

      /*
       * IT ALWAYS SAYS WHAT IT DID, and that is the fix Owen actually needed.
       *
       * This used to speak only when something was SKIPPED, so an apply-to-all
       * that worked perfectly said nothing whatever — and the grid draws raw
       * thumbnails, so twenty-five turned photographs look exactly like
       * twenty-five untouched ones. "didnt work... maybe it takes a while but
       * there was no indicator" is the correct reading of a surface that
       * reports only its own refusals.
       */
      /*
       * The verb is the GESTURE'S and not a constant, even now that there is one
       * gesture: this door is a union with room in it, and a sentence hard-coded
       * to the only arm that exists today is the shape that goes wrong quietly
       * on the day a second one lands.
       */
      this.notices.notice.set(
        announce(gesture.kind === 'turn' ? 'Turned' : 'Applied to', applied, skipped),
      );
      /*
       * THE ORDER IS NOT REBUILT, because a turn cannot change which pages
       * exist. The stamp arm could -- it copied the source's page list, so an
       * unsplit photograph gained one and a split one could lose the one it had
       * -- and `orderFor` stood here for that. `turnPhotos`, which is this same
       * act reached from the table, has never needed it either.
       */
      return { ...recipe, photos };
    });
    return { applied, skipped: skipped.length };
  }

  /**
   * WHICH PASS THE BOOK IS IN — crop everything, then split everything.
   *
   * Absent is the crop pass, which is where a project starts and where *Reopen
   * crops* returns it; there is no `'crop'` on disk (see `CaptureRecipe.pass`).
   * Answered as a word rather than as a boolean because the surfaces that read
   * it are choosing between two sets of handles, not turning one thing on.
   */
  readonly pass = computed<'crop' | 'split'>(() => this.current()?.pass ?? 'crop');

  /**
   * THE PERSON SAYING THIS PAGE IS RIGHT — the say-so, and the only writer of
   * `complete: true`.
   *
   * ── Why a stored answer, when a placement needs none ──────────────────────
   *
   * Because this is the one completion that leaves NO TRACE IN THE GEOMETRY. A
   * person who looks at a page the book's crop already fits, agrees with it, and
   * steps on has moved nothing — so there is nothing for `isComplete` to derive
   * from, and without a field the next Apply would move a page somebody had
   * just approved. It is the rail's tick philosophy at page grain: a derivation
   * cannot know that a person has looked.
   *
   * IT IS NOT THE SAME ACT AS PLACING. A placement records provenance and lets
   * the derive speak (`placed`); this records the decision itself, because it is
   * the whole of what happened.
   */
  markComplete(photoId: string): void {
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) =>
        (photo.id === photoId ? { ...photo, complete: true } : photo)),
    }));
  }

  /**
   * LET THE BOOK CHANGE THIS ONE AGAIN — release, and the only writer of
   * `complete: false`.
   *
   * ── It keeps the lines, which is the difference between this and a reset ──
   *
   * A released photograph is unchanged on screen: its crop, its cut and its
   * turn all stay exactly where they were, and the next Apply is what overwrites
   * them. That matters because release is reached by right-clicking a card,
   * where nothing is drawn large enough to check — a door that silently
   * replaced the picture underneath the menu would be a door nobody presses
   * twice. *Match the others* is the other press, and it is the one that hands
   * the lines back immediately.
   *
   * ── AND IT MUST BE STORED RATHER THAN DERIVED AWAY ───────────────────────
   *
   * The pages keep their `byHand`, so the derive would go on answering
   * "complete" and the button would do nothing at all. This is the case the
   * explicit field exists for; everything else about `complete` follows from
   * wanting this one press to work.
   *
   * ONE PHOTOGRAPH PER PRESS, like every other per-photograph door here. A
   * selection of nine is nine calls into one debounced write, so the cost of
   * looping is a loop.
   */
  release(photoId: string): void {
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) =>
        (photo.id === photoId ? { ...photo, complete: false } : photo)),
    }));
  }

  /**
   * THIS PHOTOGRAPH'S CROP AND CUT BECOME THE BOOK'S — AND NOTHING IS STAMPED.
   *
   * ── The half of Wave 24's *Crop all* that survives ───────────────────────
   *
   * That press did two things: it recorded the standing and it copied it onto
   * every other photograph. The two have been separated because THE SURFACE
   * NAMES THE SCOPE — a control in the modal speaks for the photograph it has
   * open, and a press there that changed twenty-four other pictures was the
   * modal speaking for the book. Propagation is the table's Apply now, and this
   * is what is left: a record.
   *
   * Which also makes it cheap enough to press while looking. A person can set
   * the book's crop from page 3, disagree, set it again from page 11, and
   * nothing has happened to page 7 in between.
   *
   * ── IT LEAVES THE SOURCE'S OWN MARK ALONE, and that is a change ──────────
   *
   * Wave 24 cleared it here, because the drag that placed the standing marked
   * the photograph and the stamp skipped the source — so without clearing, the
   * page used to set the book would have been excluded from every later global
   * forever. That trap does not exist once the two acts are separate: the Apply
   * skips this photograph for being complete and the skip costs nothing,
   * because what it holds IS the standing. If the standing later moves on to
   * another page's crop, this one keeps the crop a hand placed — which is the
   * ruling, not an oversight.
   *
   * The cut comes with it, as a standing carries one: a book cut down the
   * middle is a fact about the book, and Wave 24's ruling that one button
   * carries both is unchanged by moving where the button lives.
   */
  recordCrop(photoId: string): void {
    this.change((recipe) => {
      const photo = recipe.photos.find((one) => one.id === photoId);
      if (photo === undefined) return recipe;
      return { ...recipe, book: standingOf(photo) };
    });
  }

  /**
   * THIS LINE BECOMES THE BOOK'S CUT — the split pass's record, and only the cut.
   *
   * ── Why it does not go through `standingOf` ──────────────────────────────
   *
   * Because by the split pass the crop is settled and this photograph may not
   * be speaking for it. A complete photograph holds a crop somebody placed on
   * it alone; lifting a whole standing off it here would quietly replace the
   * book's crop — already applied to every follower — with one outlier's, on a
   * press whose label says nothing about crops.
   *
   * A BOOK WITH NO CROP CANNOT USE A CUT, and this does not pretend otherwise.
   * The cut is fractions of a frame, so `bookCutFor` and the split pass's Apply
   * both need the standing's frame to know whether it means the same thing on
   * another photograph — with no crop recorded, the line is stored and nothing
   * can offer it. That state is unreachable through the passes (the split pass
   * is only entered by an Apply that requires a standing crop) and it is left
   * refusing rather than papered over with a crop this press did not mean.
   *
   * An uncut photograph clears the book's cut, for `clearSplit`'s reason: no cut
   * is the absence of one, and a book of single pages needs no second state.
   */
  recordCut(photoId: string): void {
    this.change((recipe) => {
      const photo = recipe.photos.find((one) => one.id === photoId);
      if (photo === undefined) return recipe;
      const book = { ...recipe.book };
      if (photo.split === null) delete book.cut;
      else book.cut = photo.split;
      return { ...recipe, book };
    });
  }

  /**
   * APPLY — the book's crop lands on every photograph that is not complete.
   *
   * ── It is the table's act, and it has no source ──────────────────────────
   *
   * Wave 24's stamp copied from the photograph somebody was standing on, which
   * is why it had to skip one and why the modal had to carry it. This one lands
   * the STANDING, which belongs to the book. Every photograph is a candidate,
   * the one the standing was lifted from included — it takes it again, exactly
   * and harmlessly, unless it has since been completed.
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
  applyCrops(): ApplyOutcome {
    const held = this.current();
    const standing = held?.book;
    const crop = standing?.crop;
    if (held === null || standing === undefined || crop === undefined) {
      this.notices.notice.set(
        'The book has no crop yet, so there is nothing to apply. Set one from a page first.',
      );
      return { applied: 0, skipped: 0 };
    }
    const skipped: Skipped[] = [];
    let applied = 0;
    this.change((recipe) => {
      const name = namerFor(recipe);
      const photos = recipe.photos.map((photo) => {
        if (!sameShape(crop, photo)) {
          skipped.push({ name: name(photo), why: 'shape' });
          return photo;
        }
        if (isComplete(photo)) {
          skipped.push({ name: name(photo), why: 'complete' });
          return photo;
        }
        const worn = wearing(photo, standing);
        // Unreachable from a standing lifted off a real photograph, and leaving
        // this one alone is the only answer that cannot make a page out of a
        // corner.
        if (worn === null) return photo;
        applied += 1;
        return worn;
      });
      this.notices.notice.set(applied === 0 && skipped.length === 0
        ? 'Nothing to apply.'
        : announce('Applied to', applied, skipped));
      return {
        ...recipe,
        photos,
        // A standing carries a cut, so an Apply can change how many pages a
        // photograph has -- in either direction.
        order: orderFor(photos, recipe.order),
        pass: 'split',
      };
    });
    return { applied, skipped: skipped.length };
  }

  /**
   * APPLY — the book's cut lands on every photograph that is not complete.
   *
   * ── A stamp act with no state of its own ─────────────────────────────────
   *
   * It moves no pass and records nothing: it is repeatable, and repeating it is
   * the ordinary way to work. Slide the line on one page, make it the book's,
   * press this, look again. The crop pass's Apply is a commitment because it
   * changes what every surface DRAWS; this one only moves a gutter.
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
  applyCuts(): ApplyOutcome {
    const held = this.current();
    const crop = held?.book?.crop;
    const cut = held?.book?.cut;
    if (held === null || crop === undefined || cut === undefined) {
      this.notices.notice.set(
        crop === undefined
          ? 'The book has no crop yet, so a cut has no frame to fall in.'
          : 'The book has no cut yet. Cut one page where the book is cut, and make that line the book\'s.',
      );
      return { applied: 0, skipped: 0 };
    }
    const skipped: Skipped[] = [];
    let applied = 0;
    this.change((recipe) => {
      const name = namerFor(recipe);
      const photos = recipe.photos.map((photo) => {
        if (!sameShape(crop, photo)) {
          skipped.push({ name: name(photo), why: 'shape' });
          return photo;
        }
        if (isComplete(photo)) {
          skipped.push({ name: name(photo), why: 'complete' });
          return photo;
        }
        // Null is a segment that resolves against THIS sheet to neighbouring
        // edges, which cuts a corner off rather than cutting a page in two.
        // Leaving the photograph whole is the only answer that cannot destroy
        // a page -- see `cutWith`.
        const done = cutWith(photo, cut, false);
        if (done === null) return photo;
        applied += 1;
        return done;
      });
      this.notices.notice.set(applied === 0 && skipped.length === 0
        ? 'Nothing to cut.'
        : announce('Cut', applied, skipped));
      // A cut changes which pages exist, so the order grows with it.
      return { ...recipe, photos, order: orderFor(photos, recipe.order) };
    });
    return { applied, skipped: skipped.length };
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
  reopen(): void {
    this.change((recipe) => {
      if (recipe.pass === undefined) return recipe;
      const next = { ...recipe };
      delete next.pass;
      return next;
    });
  }

  /** The page and the photo it belongs to, or null. */
  private pageIn(
    recipe: CaptureRecipe,
    pageId: string,
  ): { photo: CapturePhoto; page: CapturePhoto['pages'][number] } | null {
    for (const photo of recipe.photos) {
      const page = photo.pages.find((one) => one.id === pageId);
      if (page !== undefined) return { photo, page };
    }
    return null;
  }

  /** The capture time of every card, in the order the grid draws them. */
  private orderedTimes(): readonly string[] {
    const recipe = this.current();
    if (recipe === null) return [];
    const times: string[] = [];
    for (const id of recipe.order) {
      const found = this.pageIn(recipe, id);
      if (found !== null) times.push(found.photo.takenAt);
    }
    return times;
  }

  private change(edit: (recipe: CaptureRecipe) => CaptureRecipe): void {
    const recipe = this.current();
    if (recipe === null) return;
    const next = edit(recipe);
    this.current.set(next);
    this.save(next);
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Write the recipe, at most once every `SAVE_AFTER_MS` of quiet.
   *
   * The LAST state wins rather than the first: a drag emits a recipe per
   * pointermove and only where the corner came to rest is worth writing. A save
   * that fails says so once and keeps the edit on screen — the recipe in memory
   * is what the person is looking at, and throwing it away to match the disk
   * would lose work to a transient error.
   */
  private save(recipe: CaptureRecipe): void {
    const dir = this.directory();
    // Held in a local rather than read off the module inside the timeout: the
    // narrowing above does not survive into a later callback, and a bridge that
    // was there when the edit happened is the one that should write it.
    const bridge = api;
    if (bridge === null || dir === null) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void bridge.capture.recipeSave(dir, recipe).catch((err: unknown) => this.complain(err));
    }, SAVE_AFTER_MS);
  }

  private complain(err: unknown): void {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/** What "apply to all" is applying — the gesture, with what it needs to repeat. */
/** What an apply-to-all did, for a surface that has to acknowledge it. */
export interface ApplyOutcome {
  applied: number;
  skipped: number;
}

/**
 * WHAT AN APPLY WOULD COST, in the three populations the consequence line under
 * it has to name. See `CaptureService.applyCost`, which is its only reader.
 *
 * The three are exhaustive and disjoint by construction -- every photograph in
 * the project is in exactly one of them -- which is what lets the sentence be
 * read as an account of the whole book rather than as three unrelated numbers.
 *
 * IT KEEPS THE NAME `StampCost` and the name is now a fossil: the stamp it was
 * written for is gone (W25-P3) and the table's Apply inherited the shape. The
 * rename is a service-side edit and nothing depends on the word, so it is said
 * here rather than done in passing by the package that deleted the press.
 */
export interface StampCost {
  /**
   * Photographs that will hold this crop afterwards.
   *
   * EVERY PHOTOGRAPH IS A CANDIDATE, because the Apply lands the BOOK'S crop
   * and belongs to no photograph -- including the one the standing was lifted
   * from, which takes it again exactly and harmlessly unless it has since been
   * completed. (A `stampCost` counted this from a SOURCE and had to include it
   * by hand; that count went with the press.)
   */
  takes: number;
  /**
   * Spared because the book has stopped moving them: `isComplete`, and the same
   * test the skip makes rather than a second walk that agrees with it today.
   *
   * It counted `byHand` until Wave 25, which is now provenance rather than the
   * rule -- a photograph completed by the say-so has no hand-set page on it and
   * is skipped all the same, so a count of hands would have promised a reach
   * the act does not have.
   */
  complete: number;
  /** Spared because the same fractions are not the same region on them. */
  shape: number;
}

/** What the prepare rail counts. Facts about the recipe, said in numbers. */
export interface PrepareCounts {
  /** Photographs on the table, struck included -- the rail counts pictures. */
  photos: number;
  /** Photographs whose SHEET has been moved off the whole frame. */
  cropped: number;
  /**
   * Photographs carrying a hand-set page.
   *
   * PROVENANCE, NOT THE SKIP RULE, since Wave 25 — a photograph completed by
   * the say-so carries no `byHand` and is skipped all the same. The rail still
   * draws this one; the number it should be drawing is `complete` below, and
   * that swap belongs to the rail (W25-P2) rather than to the count.
   */
  byHand: number;
  /** Photographs the book will not move — the one population a global skips. */
  complete: number;
  /** Photographs cut into pages. */
  split: number;
  /** The pages those cuts produced, which is what makes the count worth saying. */
  pagesFromSplits: number;
}

/**
 * WHAT A GLOBAL PRESS IN THE MODAL ASKS FOR — and there is one of them.
 *
 * ── The stamp arm was deleted here by W25-P3, with its override flag ─────────
 *
 * `{ kind: 'stamp'; includeComplete?: boolean }` stood beside this one. It
 * carried a whole photograph's configuration onto every other photograph of the
 * same shape, and the flag was the answer to a dialog asking whether to
 * overwrite the pages somebody had set by hand. Both are gone in one piece,
 * because Wave 25 removed the QUESTION rather than the sentence: the modal
 * records the book's crop and propagates nothing, the table's Apply propagates
 * and skips every complete photograph, and RELEASE is the deliberate press that
 * puts one back in the flow.
 *
 * A ONE-ARM UNION IS STILL A UNION, and it stays spelled as one. Collapsing it
 * to a bare string would make the day a second global arrives an edit to every
 * caller's emit rather than an added arm here.
 */
export type ApplyToAll =
  /**
   * Quarter turns, so every photo gets the TURN rather than this photo's
   * corners. It is the one act that changes every page without overwriting
   * hand-set crops, because a turn permutes each page's own corners rather than
   * replacing them -- and the one that reaches photographs of other shapes,
   * which is why it never folded into the crop.
   */
  | { kind: 'turn' };

/*
 * A local `WHOLE` CONSTANT AND ITS DOCBLOCK STOOD HERE, orphaned: the function
 * they belonged to had already moved to shared/capture.ts as `isWholeFrame`,
 * and only the constant and the comment describing the departed function were
 * left. Swept while the file was open.
 */

/**
 * WHAT A GLOBAL DID, in one sentence — and it ALWAYS says something.
 *
 * The verb is the caller's, because "applied to 25" makes somebody work out
 * what was applied; they pressed a button that said what it would do, and the
 * sentence should say it happened. Silence was the old defect: an act that
 * worked perfectly said nothing at all, and the grid draws raw thumbnails, so
 * twenty-five turned photographs look exactly like twenty-five untouched ones.
 * *"didnt work... maybe it takes a while but there was no indicator"* is the
 * correct reading of a surface that reports only its own refusals.
 */
function announce(did: string, applied: number, skipped: readonly Skipped[]): string {
  const count = applied === 1 ? '1 photograph' : `${applied} photographs`;
  return skipped.length === 0
    ? `${did} ${count}.`
    : `${did} ${count}. Left alone: ${leftAlone(skipped)}.`;
}

/**
 * WHAT TO CALL A PHOTOGRAPH IN A SENTENCE — by position, never by file.
 *
 * The skip sentences used to print `photo.file`, which is
 * `originals/<sha>.heic` — content-addressed, because the recipe does not keep
 * the name a photograph arrived under. Owen ran apply-to-all, it worked on
 * twenty-five photographs and skipped the landscape frame exactly as ruled, and
 * the only thing the surface told him was a hex digest. He read the whole act as
 * broken.
 *
 * A person cannot act on a sha. They CAN act on "Photograph 27", because that is
 * what the grid counts and what the editor's own readout says, so the two
 * surfaces agree on how a photograph is referred to. Position is taken from the
 * ARRANGEMENT — first appearance in the order — for the same reason the editor's
 * walk is.
 *
 * THE NAME IT ARRIVED UNDER IS PREFERRED where there is one. `CapturePhoto.name`
 * is OPTIONAL and must stay so: a recipe written before that field cannot be
 * migrated, because the copy is named by hash and the source path was never
 * recorded. Owen's project is one of those, so position is not a fallback for
 * tidiness — it is the only thing the oldest recipes can say.
 *
 * ONE BODY FOR EVERY GLOBAL. The stamp, the crop pass's Apply and the split
 * pass's Apply all name the photographs they left alone, and three sentences
 * about the same photograph must not call it three things.
 */
function namerFor(recipe: CaptureRecipe): (photo: CapturePhoto) => string {
  const position = new Map<string, number>();
  for (const pageId of recipe.order) {
    const owner = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
    if (owner !== undefined && !position.has(owner.id)) position.set(owner.id, position.size + 1);
  }
  return (photo) => photo.name ?? `Photograph ${position.get(photo.id) ?? '?'}`;
}

/**
 * The photographs a stamp would not touch, said once per reason.
 *
 * Grouped rather than listed, because the reason belongs to the GROUP and
 * repeating it per name is how a sentence stops being read: three hand-set
 * photographs produced the same eight words three times over. The order is the
 * order the reasons were first met, so the sentence follows the arrangement
 * rather than an alphabet nobody chose.
 */
function leftAlone(skipped: readonly Skipped[]): string {
  const groups: { why: Skipped['why']; names: string[] }[] = [];
  for (const one of skipped) {
    const group = groups.find((each) => each.why === one.why);
    if (group === undefined) groups.push({ why: one.why, names: [one.name] });
    else group.names.push(one.name);
  }
  return groups
    .map(({ why, names }) => {
      const many = names.length !== 1;
      /*
       * "COMPLETE" AND NOT "SET BY HAND", since Wave 25 -- and the wording had
       * to move with the test. A page completed by the say-so has nothing
       * hand-set on it at all, so the old sentence would have told somebody
       * they had placed corners they never touched, about the one page they
       * had deliberately left alone.
       */
      const because = why === 'complete'
        ? `${many ? 'those are' : 'that one is'} complete`
        : `${many ? 'different shapes' : 'a different shape'}`;
      return `${names.join(', ')} — ${because}`;
    })
    .join('; ');
}

/**
 * ONE PHOTOGRAPH A GLOBAL DID NOT TOUCH, and the reason it gives.
 *
 * The reason is kept rather than a finished sentence so `leftAlone` can GROUP
 * them: a list of strings forces the reason to be repeated once per name, and
 * three complete photographs produced the same eight words three times over.
 * The two reasons are the two the skip has; a third would need a sentence
 * before it needs a field.
 */
interface Skipped {
  name: string;
  why: 'complete' | 'shape';
}

/** Quiet before a write. Long enough that a drag is one save, short enough to be invisible. */
const SAVE_AFTER_MS = 400;

/**
 * The order with any newly-cut pages folded in beside the page they came from.
 *
 * ── IT USED TO PUT THEM ALL AT THE BACK OF THE BOOK ─────────────────────────
 *
 * The docblock promised this and the code did not do it, and the gap is one
 * assumption: it recognised a new page by the OLD PAGE'S ID HAVING VANISHED.
 * An unsplit photograph's only page is `<photoId>:0` and a split one's pages
 * are `:0` and `:1`, so the old id never vanishes -- the cut ADDS `:1` and
 * leaves `:0` exactly where it was. The "a split replaced it" branch below
 * therefore never ran for a split, and every new right-hand page fell through
 * to the sweep at the end.
 *
 * Measured on four photographs split in one act: A:0 B:0 C:0 D:0 became
 * A:0 B:0 C:0 D:0 A:1 B:1 C:1 D:1 -- every left page, then every right page.
 * A whole book of versos followed by a whole book of rectos, in the minted PDF
 * and nowhere else, because the light table draws the same cards either way and
 * the number in the footer is the same fifty-four.
 *
 * AND THE SINGLE GESTURE IS THE QUIETER ONE (P1, channel seq 138): split ONE
 * spread on a shoot of twenty-five and A:0 B:0 becomes A:0 B:0 A:1 -- one page
 * adrift at the back of an otherwise perfect book. That is the version somebody
 * reaches for first, and the version that survives a reading of the grid.
 *
 * It has been live for as long as splitting has, and it survived because
 * nothing had split a real shoot yet: Owen's recipe holds twenty-five
 * photographs and no splits at all.
 *
 * ── THE RULE, AND WHY IT IS NOT SIMPLY "KEEP A PHOTOGRAPH'S PAGES TOGETHER" ─
 *
 * A page that the arrangement ALREADY NAMES keeps its own slot, and only a page
 * the arrangement has never heard of is folded in beside its sibling. That
 * distinction is the whole of it: somebody who has dragged the two halves of a
 * spread apart on purpose has an order that says so, and a rule that gathered
 * each photograph's pages together would quietly undo it on the next stamp.
 */
function orderFor(photos: readonly CapturePhoto[], previous: readonly string[]): string[] {
  const known = new Set(previous);
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (!placed.has(id)) { order.push(id); placed.add(id); }
  };

  for (const id of previous) {
    const owner = photos.find((one) => one.pages.some((page) => page.id === id))
      // The page itself is gone — a stamp can now take a photograph from two
      // pages back down to one — so its photograph is found by the id it was
      // built from, and its remaining pages take the slot.
      ?? photos.find((one) => id.startsWith(`${one.id}:`));
    if (owner === undefined) continue;

    if (owner.pages.some((page) => page.id === id)) place(id);
    for (const page of owner.pages) if (!known.has(page.id)) place(page.id);
  }

  // Whole photographs the arrangement has never seen — an intake since the last
  // save — go on the end, which is where new photographs belong.
  for (const photo of photos) for (const page of photo.pages) place(page.id);
  return order;
}

/**
 * Whether a sequence never moves against `direction`. TIES COUNT AS SORTED,
 * which is the whole reason this is not a comparison of two arrays.
 */
function runsWith(values: readonly string[], direction: 1 | -1): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) * direction > 0) return false;
  }
  return true;
}

/**
 * What an intake DID, in one sentence a person can act on.
 *
 * Main answers with more than the recipe on purpose (`CaptureIntaken`): a drop
 * containing a screenshot and four photographs this project already holds
 * otherwise looks exactly like a clean import of nothing, and the person is left
 * counting cards to work out what happened to their afternoon. Every clause here
 * exists because its absence is silence.
 *
 * The refusals carry MAIN'S OWN WORDING rather than a rephrasing — it is the
 * side that knows why, and ".txt is not a photograph this stage reads yet" is
 * already a sentence. Two are shown and the rest counted, because a notice bar
 * holding twenty reasons is a notice bar nobody reads.
 */
function reportOn(intaken: CaptureIntaken, unreadable: number): string {
  const said: string[] = [];
  said.push(intaken.added === 1 ? 'One photograph added.' : `${intaken.added} photographs added.`);
  if (intaken.duplicates.length > 0) {
    said.push(
      `${intaken.duplicates.length} already in this project (${intaken.duplicates.slice(0, 2).join(', ')}`
      + `${intaken.duplicates.length > 2 ? ', …' : ''}) — copied once, not twice.`,
    );
  }
  for (const { file, why } of intaken.refused.slice(0, 2)) said.push(`${file}: ${why}`);
  if (intaken.refused.length > 2) said.push(`${intaken.refused.length - 2} more refused.`);
  if (unreadable > 0) {
    said.push(`${unreadable} could not be read from where they were dragged from.`);
  }
  return said.join(' ');
}

/**
 * ONE PHOTOGRAPH, TURNED — AND ITS SPLIT RE-SEATED WITH IT.
 *
 * ── A turn does not move a corner, but it does move a PAGE ─────────────────
 *
 * `turnQuad` permutes the corner assignment without moving any point, so the
 * crop stays on exactly the same part of the photograph however many times it
 * is turned. That is why turning each page's quad on its own LOOKS right.
 *
 * It is not right for a spread, and the measurement says so exactly. Turning
 * the two halves of a centre-split independently, against re-deriving them
 * from the turned sheet:
 *
 *   a quarter turn      the same, both ways
 *   a half turn         THE HALVES SWAP READING ORDER
 *   three quarters      THE HALVES SWAP READING ORDER
 *
 * Which is obvious once seen: turn a spread upside down and the page that was
 * on the left is on the right. The independent turn keeps the old order, so
 * the book silently gets two pages in the wrong sequence -- and it is
 * invisible on the table, because both cards are there and both look correct.
 *
 * So a photograph with a cut in it is turned by rebuilding the WHOLE sheet,
 * turning that, and asking `halvesOf` for the halves again. The split itself
 * is untouched: it is a segment in the photograph's own fraction space and a
 * turn moves nothing, so the cut is still across the same gutter.
 *
 * ── WHAT FOLLOWS A HALF, AND WHAT FOLLOWS AN INDEX ────────────────────────
 *
 * A strike is a decision about a PHYSICAL page -- "this one is a duplicate" --
 * so when the order swaps, the strike has to travel with the half rather than
 * stay on the seat. Each re-derived half is matched back to the turned quad it
 * equals, and carries that page's strike with it. Matching by GEOMETRY rather
 * than by a swap rule means this stays right if `halvesOf` ever orders a turn
 * differently than it does today.
 */
function turned(photo: CapturePhoto, turns: number): CapturePhoto {
  const marked = (page: CapturePage, quad: CaptureQuad): CapturePage =>
    ({ ...page, quad, byHand: true });

  // A turn is a PLACEMENT -- the person looked at this one and said which way
  // up it goes -- so it completes the photograph through `placed`'s rule rather
  // than through a second write of its own.
  if (photo.split === null || photo.pages.length !== 2) {
    return placed({
      ...photo,
      pages: photo.pages.map((page) => marked(page, turnQuad(page.quad, turns))),
    });
  }

  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const halves = halvesOf(turnQuad(whole, turns), photo.split);
  // Unreachable for a split this app can produce, and leaving the photograph
  // untouched is the only answer that cannot put a page in the wrong place.
  if (halves === null) return photo;

  const spun = photo.pages.map((page) => turnQuad(page.quad, turns));
  return placed({
    ...photo,
    pages: halves.map((quad, seat) => {
      const came = spun.findIndex((one) => sameQuad(one, quad));
      const from = photo.pages[came === -1 ? seat : came]!;
      return { ...marked(from, quad), id: `${photo.id}:${seat}` };
    }),
  });
}

/** Two quads, corner for corner. Fractions out of one turn, so exact is honest. */
function sameQuad(a: CaptureQuad, b: CaptureQuad): boolean {
  return a.every((point, index) => point[0] === b[index]![0] && point[1] === b[index]![1]);
}

/**
 * THE ONE TEST EVERY SKIP READS: will the book move this photograph?
 *
 * ── Two states became one, and this is where the two are reconciled ────────
 *
 * Wave 24 had a photograph EITHER following the book OR holding its own, and
 * the second state was spelled as `byHand` on its pages. Wave 25 keeps that
 * meaning and adds a second way into it -- a person pressing *This page is
 * right* on a page they have not touched at all. Both answer the same question,
 * so they must not be two questions: every global act asks this one and nothing
 * else, or the dot on the card promises a skip some other rule does not make.
 *
 * ── THE EXPLICIT FIELD WINS, AND ONLY THE EXPLICIT FIELD CAN SAY `false` ───
 *
 * Which is what makes release possible at all. A released photograph keeps its
 * hand-placed lines -- that is the whole point, it keeps them until the next
 * Apply overwrites them -- so the derive would go on saying "complete" forever
 * and the release would be a button that does nothing. Reading the stored `false`
 * over the pages is the release.
 *
 * The reverse case is handled at the WRITE and not here (see `placed`): a
 * placement DELETES the stored answer rather than writing a second `true`, so a
 * released-then-replaced photograph reads complete again through the derive.
 * One place holds that answer, and this is it.
 *
 * ── IT LIVES BESIDE THE RECIPE'S RULES RATHER THAN IN shared/ ─────────────
 *
 * `sameShape` and `halvesOf` are in shared/ because BOTH SIDES resolve them --
 * main mints from the same geometry the renderer draws. Nothing in main reads
 * `complete`: the mint prints every photograph's lines whatever this says, which
 * is the "left out of the stamp, never the mint" ruling made structural. A
 * predicate in shared/ would advertise a question main is supposed never to ask.
 */
export function isComplete(photo: CapturePhoto): boolean {
  if (photo.complete !== undefined) return photo.complete;
  return photo.pages.some((page) => page.byHand === true);
}

/**
 * A PHOTOGRAPH SOMEBODY HAS JUST PLACED A LINE ON -- with any stored answer
 * about completeness DELETED rather than overwritten.
 *
 * ── Why deleted, when writing `true` would read the same today ────────────
 *
 * Because the two disagree the moment anything else changes. `byHand` is
 * provenance and this field is a decision, and a placement is BOTH -- so the
 * honest record of a placement is the provenance alone, with the decision left
 * to the one rule that reads it. A `true` written here would be a second,
 * frozen copy of an answer `isComplete` already gives, and the first act to
 * clear the provenance without clearing the copy would leave a photograph the
 * book refuses to move for a reason nothing on disk can explain.
 *
 * The case that forces it is the released page: release stores `false`, the
 * page keeps its lines, and then somebody drags a corner on it. Written beside,
 * the stored `false` out-argues the hand that just moved the crop and the next
 * Apply overwrites work made ten seconds ago. Deleted, the derive answers, and
 * it answers `true` because a hand placed it -- which is the ruling.
 *
 * NOT called by the stamp. `wearing` deletes the same field for the mirror
 * reason and writes `byHand: false` with it, so a follower comes out of an
 * Apply saying nothing about itself at all.
 */
function placed(photo: CapturePhoto): CapturePhoto {
  if (photo.complete === undefined) return photo;
  const next = { ...photo };
  delete next.complete;
  return next;
}

/**
 * ONE PHOTOGRAPH, CUT AT A LINE -- the only body that turns a segment into two
 * pages of a book, and null when the segment cannot be one.
 *
 * ── ALWAYS FROM THE WHOLE PAGE ────────────────────────────────────────────
 *
 * `setSplit` used to record `split.x` and stop — so on the photograph somebody
 * was actually looking at, dragging the gutter stored a number and produced no
 * second page, while the stamp (which skipped the source) split every OTHER
 * photograph correctly. The one photo the gesture was performed on was the one
 * photo it did not act on.
 *
 * `joinedQuad` and not `pages[0]`, for the same reason the editor draws from
 * it: after the first drag `pages[0]` is the left half, and re-splitting that
 * would halve the page again on every adjustment. It is also what makes this
 * right for the split pass's Apply, where the same line lands on a photograph
 * that may already be cut somewhere else: the cut is always made against the
 * SHEET, so a second Apply moves the gutter rather than quartering the page.
 *
 * ── AND IT KEEPS THIS PHOTOGRAPH'S CROP, which is the whole of what makes
 *    the split pass a pass ─────────────────────────────────────────────────
 *
 * The book's crop landed at the crop-pass Apply and a complete photograph keeps
 * its own; neither is this line's business. So the sheet comes from the pages
 * as they are and only the gutter moves.
 *
 * ── Null, and why the callers must honour it ─────────────────────────────
 *
 * A segment resolving against this sheet to NEIGHBOURING edges cuts a corner
 * off — a triangle and a pentagon — and the mint rectifies four corners or
 * nothing. `seatSplit` cannot produce one from a pointer, so this is
 * unreachable from the editor and reachable from a hand-edited recipe; leaving
 * the photograph untouched is the only answer that cannot destroy a page. That
 * refusal-by-construction is why the seating lives in shared/ rather than in
 * the component: a gutter that DRAWS FINE AND REFUSES TO SAVE is this feature's
 * own precedent.
 *
 * `mine` is what the cut MEANS about this photograph -- see `cutHere`. A mark
 * the photograph ALREADY held survives either way, read from the whole
 * photograph rather than per page: a spread is two pages of one picture, and
 * half a protection reads as none.
 *
 * STRIKES SURVIVE A RE-CUT, by seat. Which half is a page is a decision about
 * the book, and moving the gutter is not taking it back.
 */
function cutWith(photo: CapturePhoto, split: CaptureSplit, mine: boolean): CapturePhoto | null {
  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const halves = halvesOf(whole, split);
  if (halves === null) return null;
  const [first, second] = halves;
  const kept = mine || photo.pages.some((page) => page.byHand === true);
  return {
    ...photo,
    split,
    pages: [
      { id: `${photo.id}:0`, quad: first, struck: photo.pages[0]?.struck ?? false, byHand: kept },
      { id: `${photo.id}:1`, quad: second, struck: photo.pages[1]?.struck ?? false, byHand: kept },
    ],
  };
}

/**
 * ONE PHOTOGRAPH'S CONFIGURATION, LIFTED INTO THE BOOK'S STANDING.
 *
 * ── The sheet, never the pages ────────────────────────────────────────────
 *
 * `joinedQuad` is the same body the editor draws from and `setSplit` re-cuts
 * from, so lifting a standing and wearing it are exact inverses rather than two
 * approximations that drift apart over a few adjustments. Storing the HALVES
 * instead would be storing a reading order, and a reading order is a fact about
 * the photograph it was taken from -- see `turned` above for the measurement
 * that makes that concrete.
 *
 * ── THE FRAME COMES WITH IT, because a crop is fractions of something ─────
 *
 * `sameShape` is what stops a portrait crop resolving to a plausible, stretched
 * region of a landscape frame, and it needs two shapes. Pointing at the source
 * photograph by id would work until somebody removed it, which is a thing they
 * may do at any time; the two numbers cost nothing and cannot go missing.
 */
function standingOf(photo: CapturePhoto): CaptureStanding {
  return {
    crop: {
      quad: joinedQuad(photo.pages.map((page) => page.quad), photo.split),
      width: photo.width,
      height: photo.height,
    },
    // A book of single pages has no cut, and an absent key says that better
    // than a null does -- the file stays silent about what nobody set.
    ...(photo.split === null ? {} : { cut: photo.split }),
  };
}

/**
 * ONE PHOTOGRAPH WEARING THE BOOK'S CROP AND CUT -- the only body that applies a
 * standing, and it is deliberately the only one.
 *
 * ── Two callers, and they must not be two rules ──────────────────────────
 *
 * The stamp dresses every same-shaped photograph in it, and *Match the others*
 * dresses one. Written twice, "what it means to take the book's crop" would have
 * two answers on the day it was defined -- which is the defect `outputSizeFor`,
 * `sameShape` and `splitFromFraction` were each moved into `shared/` to prevent,
 * and each of those had two bodies within hours.
 *
 * ── IT KEEPS THE TURN AND COPIES THE CROP, which is Owen's ruling ─────────
 *
 * `turnedLike` moves no corner: it relabels which corner prints top-left, taking
 * that label from the photograph being dressed. So a page somebody turned
 * upright stays upright while receiving the book's crop exactly, to the last
 * decimal, because there is no arithmetic here to be wrong by a pixel.
 *
 * ── AND IT CUTS THE SHEET RATHER THAN CARRYING TWO HALVES ────────────────
 *
 * Which is what makes it right for a spread facing the other way. Turn a spread
 * upside down and the page that was on the left is on the right; halves carried
 * across keep their old order and the book silently gets two pages in the wrong
 * sequence. Re-deriving them from the turned sheet re-orders them into reading
 * order for free, because the corner order IS the orientation.
 *
 * ── What null means ──────────────────────────────────────────────────────
 *
 * No crop in the standing -- nothing to wear -- or a cut that resolves against
 * this sheet to neighbouring edges, which cuts a corner off and is a shape the
 * mint cannot print. Both are answered by leaving the photograph alone, because
 * the alternative is inventing a page.
 *
 * STRIKES BELONG TO THE PHOTOGRAPH, NOT TO THE CONFIGURATION, so they stay on
 * the seat they were on. A page struck for being a blurred retake is still a
 * blurred retake after somebody changes its crop.
 */
function wearing(photo: CapturePhoto, standing: CaptureStanding): CapturePhoto | null {
  const crop = standing.crop;
  if (crop === undefined) return null;
  /*
   * THE WAY THIS PHOTOGRAPH ALREADY SITS, read before its pages are replaced.
   * Any of its pages would answer the same -- both halves of a spread carry the
   * sheet's turn -- and a photograph that somehow had none keeps the standing's
   * own orientation rather than inventing an answer.
   */
  const facing = photo.pages[0]?.quad;
  const sheet = facing === undefined ? crop.quad : turnedLike(crop.quad, facing);
  const cut = standing.cut ?? null;
  const halves = cut === null ? null : halvesOf(sheet, cut);
  if (cut !== null && halves === null) return null;
  const quads: readonly CaptureQuad[] = halves ?? [sheet];
  /*
   * A PHOTOGRAPH WEARING THE STANDING SAYS NOTHING ABOUT ITSELF -- the stored
   * answer goes, in both directions, and `byHand: false` goes with it.
   *
   * It is `placed`'s rule from the other side. A page that has just taken the
   * book's crop is a FOLLOWER by construction, so the derive gives the right
   * answer and a stored one could only ever contradict it: a `true` left here
   * would exclude a photograph from the next Apply for a decision the Apply has
   * just overwritten, and a `false` would be a release nobody pressed, kept
   * beside pages that already say the same thing.
   *
   * That covers *Match the others* as well, which is the release and the Apply
   * in one press: the page gives up its own lines, so it gives up the answer it
   * held about them.
   */
  const worn = { ...photo };
  delete worn.complete;
  return {
    ...worn,
    split: cut,
    pages: quads.map((quad, seat) => ({
      id: `${photo.id}:${seat}`,
      quad,
      struck: photo.pages[seat]?.struck ?? false,
      /*
       * THE GLOBAL CLEARS THE MARK, ruled at channel seq 129. Left standing, the
       * first stamp would mark every page hand-set and the second would skip
       * every one -- a feature that works exactly once per project.
       *
       * It is equally right on the *Match the others* path, and for a clearer
       * reason there: a page that has just taken the book's crop is not a page
       * somebody set by hand. That is the whole content of the press.
       */
      byHand: false,
    })),
  };
}
