import { Injectable, computed, inject, signal } from '@angular/core';

import type {
  CaptureIntaken,
  CaptureIntakeProgress,
  CaptureLines,
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
  private readonly leading = signal(true);
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
  private readonly reach = signal<CaptureScope>('all');
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

  /**
   * A PROJECT ARRIVES WITH THE BOOK'S HAND ON THE HANDLES — the mode, reset.
   *
   * The mode and the scope are the hand's, not the book's, and a hand does not
   * carry across projects: opening a second shoot with *Global* off because the
   * first evening ended that way would be a person's first gesture reaching one
   * page when they had every reason to think it reached the book. Ticked and
   * *All pages* is the state a person can see, and the first gesture of a
   * project is the one that most wants the reach.
   */
  private armed(): void {
    this.leading.set(true);
    this.reach.set('all');
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
      this.armed();
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
      this.armed();
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
    const takes: string[] = [];
    const complete: string[] = [];
    const shape: string[] = [];
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
        if (!sameShape(crop, photo)) shape.push(photo.id);
        else if (isComplete(photo)) complete.push(photo.id);
        else takes.push(photo.id);
      }
    }
    return { takes, complete, shape };
  });

  /**
   * THE LINES THIS PHOTOGRAPH WOULD WEAR — its side's, or the book's own.
   *
   * The one resolution, offered to the surfaces that draw what the book has to
   * say about a photograph: the ghost under the outline, and the cut the *Two
   * pages* tick would take. Undefined means the book has nothing for this side
   * yet, which is a different sentence from "the book has nothing at all" and
   * the callers say so.
   */
  standingFor(photoId: string): CaptureLines | undefined {
    const recipe = this.current();
    if (recipe === null) return undefined;
    return linesFor(recipe.book, parityOf(recipe, photoId));
  }

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
  readonly sided = computed<boolean>(() => {
    const book = this.current()?.book;
    return book?.odd !== undefined || book?.even !== undefined;
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
    if (recipe === null) return null;
    // THIS PHOTOGRAPH'S SIDE OF THE BOOK, since Wave 51b. A book whose odd pages
    // are spreads and whose even ones are single sheets has two answers here,
    // and offering the wrong side's line would put the gutter down the middle of
    // a page rather than down the fold.
    const lines = linesFor(recipe.book, parityOf(recipe, photoId));
    const crop = lines?.crop;
    const cut = lines?.cut;
    if (cut === undefined || crop === undefined) return null;
    const photo = recipe.photos.find((one) => one.id === photoId);
    if (photo === undefined || !sameShape(crop, photo)) return null;
    return cut;
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
  matchTheOthers(photoId: string): void {
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
  followAllAgain(): void {
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
        if (!cutting) return { frame: crop, wear: (one) => wearing(one, lines) };
        const cut = lines.cut;
        if (cut === undefined) return null;
        return { frame: crop, wear: (one) => cutWith(one, cut, false) };
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
  leadTheBook(photoId: string, what: 'crop' | 'cut'): void {
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
       * A PHOTOGRAPH OF ANOTHER SHAPE LEADS NOBODY, AND MUST NOT TRY.
       *
       * A crop is fractions of a frame, so a standing lifted off the one
       * landscape frame in a shoot of twenty-six portrait ones fits none of
       * them -- `sameShape` would skip every follower and the book would be
       * left holding a crop nothing can wear. That was survivable while the
       * standing was written by a deliberate press labelled *make this the
       * book's crop*; live, it would happen to somebody who nudged a corner on
       * the odd frame, silently, with the rail's counts collapsing to "26 a
       * different shape" as the only sign.
       *
       * So the gesture stays local and the standing is left exactly as it is.
       * Nothing is lost: `setQuads` has already written this photograph's own
       * lines, and every global skips it for the same reason this one does.
       *
       * IT STILL GIVES UP THE MARK, which is what keeps the tick honest: a
       * person re-ticking *Global* on the odd frame has asked for the book to
       * move it again, and a door that answered by leaving `complete` set would
       * be a checkbox that ticks itself back off. The book cannot reach it and
       * says so through the rail's "N a different shape"; that is a different
       * sentence from "this one is mine".
       *
       * WITH NO STANDING YET there is nothing to be a different shape FROM, and
       * the first gesture defines the book -- whatever frame it happens on,
       * which is the only answer available and the one a person expects.
       */
      const already = side === null ? linesOf(recipe.book)?.crop : linesFor(recipe.book, side)?.crop;
      if (already !== undefined && !sameShape(already, photo)) {
        return {
          ...recipe,
          photos: recipe.photos.map((one) => (one.id === photoId ? following(one) : one)),
        };
      }

      if (what === 'crop') {
        const standing = standingOf(photo);
        const crop = standing.crop;
        // `standingOf` always lifts one; the narrowing is the type's, not a
        // state this can be in.
        if (crop === undefined) return recipe;
        const { photos } = dressed(
          recipe,
          (one) => (inReach(one) ? { frame: crop, wear: (worn) => wearing(worn, standing) } : null),
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
      // The standing's own frame decides who is the same shape, and falls back
      // to this photograph's when the book has no crop -- a state the passes
      // cannot reach, and not one worth refusing a gesture over.
      const frame = (side === null ? linesOf(book) : linesFor(book, side))?.crop ?? photo;
      const { photos } = dressed(
        recipe,
        (one) => (inReach(one)
          ? { frame, wear: (worn) => (cut === undefined ? rejoined(worn) : cutWith(worn, cut, false)) }
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
  turnWithTheBook(photoId: string, turns: number): void {
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
        if (!sameShape(source, photo) || isComplete(photo)) return photo;
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
  resetAll(what: 'crop' | 'cut'): void {
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
  setQuads(photoId: string, quads: readonly CaptureQuad[], mine = true): void {
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
   * `mine` is what the cut MEANS about this photograph -- see `cutHere`. It
   * defaults to a placement, and two callers pass false: the tick taking the
   * book's own cut, and a drag made with *Global* ticked, which is the book's
   * hand rather than this page's (see `setQuads`, where the same exception is
   * argued at length). Even then a mark the CROP earned survives.
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
  readonly pass = computed<'crop' | 'split'>(() => this.current()?.pass ?? 'crop');

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
  applyCrops(): ApplyOutcome {
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
        return { frame: crop, wear: (one) => wearing(one, lines) };
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
  applyCuts(): ApplyOutcome {
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
        return { frame: crop, wear: (one) => cutWith(one, cut, false) };
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
 * The three are DISJOINT by construction -- no photograph is counted twice --
 * which is what lets the sentence be read as an account of the book rather than
 * as three unrelated numbers.
 *
 * THEY STOPPED BEING EXHAUSTIVE AT WAVE 51b, and the gap is not a defect. A
 * photograph whose side of the book has no standing yet is in none of the three:
 * it is not going to take anything, and it is not being SPARED either, because
 * there is nothing to spare it from. Naming it under any of the three headings
 * would be a sentence blaming a shape or a hand for a crop nobody has placed.
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

/*
 * THE `ApplyToAll` UNION STOOD HERE AND HAS NOTHING LEFT TO NAME (Wave 51).
 *
 * W25-P3 deleted its stamp arm; this wave deleted the turn arm with the button
 * that emitted it. A union carrying one arm was worth spelling while a second
 * was plausibly coming; a union carrying none is a type describing a door that
 * is not there. `turnWithTheBook` is the surviving act and it takes the two
 * things it needs — a photograph and a number of quarters — like every other
 * per-photograph door in this service.
 */

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
 * WHAT THE OVERRIDE DID — how many were handed back, and how many of those had
 * nothing to take.
 *
 * `announce` cannot say this, and the difference is not a wording preference.
 * Its shape is *"N were changed. Left alone: …"*, and here NOTHING is left
 * alone: every marked photograph gives up its mark, the ones the book has no
 * lines for included. Listing those under *Left alone* would tell somebody a
 * page is still theirs at the exact moment it stopped being.
 *
 * SO THE SECOND CLAUSE IS ABOUT LINES, NOT ABOUT MARKS. "Kept the lines they
 * had" is the true half — the crop on those photographs did not move — and the
 * marks are covered by the first clause, which speaks for all of them.
 *
 * No names here, where the Applies name their skips. The population is the
 * rail's *N a different shape*, pressable, at all times; and unlike a skip,
 * this one is not a refusal a person has to go and correct — it is the book
 * having nothing to offer that side yet, which the next gesture fixes.
 */
function handedBack(gave: number, applied: number): string {
  const count = gave === 1 ? 'One photograph is' : `${gave} photographs are`;
  const kept = gave - applied;
  if (kept === 0) return `${count} following the book again.`;
  const held = kept === 1
    ? 'One of them kept the lines it had'
    : `${kept} of them kept the lines they had`;
  return `${count} following the book again. ${held} — the book has nothing their side and `
    + 'shape can wear yet.';
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
 * ── A TURN CLAIMS NOTHING, AND WAVE 26 REVERSED THAT ─────────────────────
 *
 * This used to write `byHand: true` on every page and route through `placed`,
 * so turning a photograph made it its own. The argument was that a later global
 * would otherwise silently undo a turn somebody had performed deliberately —
 * AND THAT ARGUMENT WAS FALSE ABOUT THE CROP. `wearing` takes the standing's
 * quad through `turnedLike` into whatever direction the photograph is already
 * facing, precisely so that a page stood upright keeps its orientation while
 * receiving the book's rectangle. A global crop has never been able to undo a
 * turn. The only act that could was the bulk turn, and that one is now the
 * *Global* tick's, which spares every photograph that is its own by rule.
 *
 * The cost of the false protection is what forced the reversal. Owen's own
 * opening move on a shoot is to turn twenty-five sideways spreads on the table,
 * before a single corner is placed — and under the old rule that claimed all
 * twenty-five, so the book's crop would then have reached NOBODY and every card
 * would have carried a mark nobody meant to set. A tick that reads "its own" on
 * a photograph whose only history is being stood the right way up is the surface
 * lying about what a person did.
 *
 * So a turn now leaves the mark EXACTLY AS IT FOUND IT, in both directions: it
 * does not claim a follower and it does not release a page somebody claimed.
 * Turning is orthogonal to whose lines these are, which is what it always was.
 * `turnWithTheBook` clears the marks it needs to clear itself (`following`),
 * where the clearing is part of what that act means.
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
  const spin = (page: CapturePage, quad: CaptureQuad): CapturePage => ({ ...page, quad });

  if (photo.split === null || photo.pages.length !== 2) {
    return {
      ...photo,
      pages: photo.pages.map((page) => spin(page, turnQuad(page.quad, turns))),
    };
  }

  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const halves = halvesOf(turnQuad(whole, turns), photo.split);
  // Unreachable for a split this app can produce, and leaving the photograph
  // untouched is the only answer that cannot put a page in the wrong place.
  if (halves === null) return photo;

  const spun = photo.pages.map((page) => turnQuad(page.quad, turns));
  return {
    ...photo,
    pages: halves.map((quad, seat) => {
      const came = spun.findIndex((one) => sameQuad(one, quad));
      const from = photo.pages[came === -1 ? seat : came]!;
      return { ...spin(from, quad), id: `${photo.id}:${seat}` };
    }),
  };
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
 * ── THE EXPLICIT FIELD WINS, AND `false` IS NOW ONLY EVER READ ────────────
 *
 * Nothing writes `false` any more. `release` did — it cleared the mark and kept
 * the lines, so the derive had to be out-argued or the button would have done
 * nothing — and Wave 51 replaced that door with `matchTheOthers`, which gives up
 * the mark by CLEARING the provenance (`following`) rather than by writing an
 * answer beside it. Every act that hands a photograph back to the book now
 * leaves it saying nothing about itself, which is what a follower is.
 *
 * The read stays, and must: recipes written before this wave hold stored
 * `false`s, they mean exactly what they meant, and the validator carries them.
 *
 * The reverse case is handled at the WRITE and not here (see `placed`): a
 * placement DELETES the stored answer rather than writing a second `true`, so a
 * photograph handed back and then re-placed reads complete again through the
 * derive. One place holds that answer, and this is it.
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
 * THE BOOK'S LINES ON EVERY FOLLOWER — the ONE walk three acts share.
 *
 * ── Why it is one body ────────────────────────────────────────────────────
 *
 * `applyCrops`, `applyCuts` and `leadTheBook` all ask the same three questions
 * in the same order — is this the same shape, has somebody taken it for their
 * own, and does the wearing resolve — and they had three answers written out
 * separately the moment the third one existed. That is the drift shape this
 * file has already paid for by name (Wave 18: *"I had written the correct rule
 * once and the wrong rule twice, three functions apart"*), and it matters more
 * here than it ever did: the live propagation and the Finalize that backstops
 * it MUST land identically, or the button is a second opinion about work a
 * person watched happen.
 *
 * `wear` is the only difference between the callers, and it is a function
 * because the two acts genuinely differ: one dresses a photograph in the whole
 * standing, the other only re-cuts the sheet it already has. Null from it is
 * always "this cannot be done to this photograph" and always means leave it
 * alone — a corner made into a page is the failure both refusals guard.
 *
 * ── THE CALLER ANSWERS PER PHOTOGRAPH, WHICH IS WAVE 51b's ONE CHANGE ─────
 *
 * `reach` is asked of each photograph and of the SIDE OF THE BOOK it falls on,
 * and it answers with the frame that photograph would be measured against and
 * the wearing it would take — or null, meaning this act does not reach it at
 * all. Three things needed that and none of them could be said with one frame
 * and one wearing: a scoped gesture reaching only the odd pages, a finalize
 * landing two different crops in one walk, and a side that has no standing yet
 * and must be left alone rather than dressed in the other side's.
 *
 * NULL IS NOT A SKIP. The skip list is what a global LEFT ALONE and has to
 * explain — a shape it cannot fit, a hand it will not overrule — and "you asked
 * for the odd pages" is not something a sentence has to apologise for. Counting
 * it would report "Finalized 13 photographs. Left alone: 12 — those are
 * complete", about twelve pages nobody claimed.
 *
 * ── `lead` IS THE ONE PHOTOGRAPH A MARK DOES NOT SPARE ────────────────────
 *
 * The photograph a gesture happened on, when that gesture was the book's. It is
 * dressed even if it was marked, and it is handed to `wear` as a FOLLOWER
 * (`following`) so the mark is given up rather than argued with: a gesture made
 * with *Global* on, on a page you had taken for your own, IS the act of handing
 * it back. Null — every other caller — spares everything complete, as every
 * global here always has. (Keeping the lead in reach when the scope points at
 * the other side of the book is the CALLER's business, and `leadTheBook` says
 * why it does.)
 *
 * The skips are named through `namerFor`, by position or by filename, never by
 * a sha. Callers that speak (the two Finalizes) read the list; the live one
 * ignores it, because a notice bar rewritten on every corner let go of is a
 * notice bar nobody reads.
 */
function dressed(
  recipe: CaptureRecipe,
  reach: (photo: CapturePhoto, parity: Parity) => Reach | null,
  lead: string | null = null,
): { photos: CapturePhoto[]; applied: number; skipped: Skipped[] } {
  const name = namerFor(recipe);
  const parities = paritiesOf(recipe);
  const skipped: Skipped[] = [];
  let applied = 0;
  const photos = recipe.photos.map((photo) => {
    const leading = photo.id === lead;
    // 'odd' for a photograph the arrangement does not name -- unreachable, since
    // `paritiesOf` sweeps the whole list, and the first side is the one a book
    // of one photograph is on.
    const asked = reach(photo, parities.get(photo.id) ?? 'odd');
    if (asked === null) return photo;
    if (!sameShape(asked.frame, photo)) {
      skipped.push({ name: name(photo), why: 'shape' });
      return photo;
    }
    if (!leading && isComplete(photo)) {
      skipped.push({ name: name(photo), why: 'complete' });
      return photo;
    }
    const worn = asked.wear(leading ? following(photo) : photo);
    if (worn === null) return photo;
    applied += 1;
    return worn;
  });
  return { photos, applied, skipped };
}

/**
 * WHAT ONE PHOTOGRAPH IS IN FOR, in a walk that may be landing two standings.
 *
 * The frame is `sameShape`'s other half — the frame the lines were drawn for,
 * never the photograph's own — and `wear` is the wearing that photograph would
 * take. They travel together because they are two halves of one answer: a frame
 * from one side of the book and a wearing from the other is exactly the mistake
 * the pair exists to make unstatable.
 */
interface Reach {
  frame: { width: number; height: number };
  wear: (photo: CapturePhoto) => CapturePhoto | null;
}

/** Which side of the book a photograph falls on. 1st, 3rd, 5th … are odd. */
export type Parity = 'odd' | 'even';

/**
 * WHICH PAGES A GLOBAL GESTURE SPEAKS FOR — the scope control, as a word.
 *
 * `'all'` is the book, which is what every gesture meant before Wave 51b and
 * what most shoots want forever. The other two are Owen's recto/verso case.
 */
export type CaptureScope = 'all' | Parity;

/**
 * EVERY PHOTOGRAPH'S SIDE OF THE BOOK, read off the ARRANGEMENT.
 *
 * ── By photograph, and by the order on the table ──────────────────────────
 *
 * The 1st, 3rd, 5th … PHOTOGRAPH is odd. Not the 1st, 3rd, 5th page: a spread
 * already holds a left page and a right page, so page parity would split one
 * picture across both sides of the book and ask a single frame to wear two
 * crops. The case the sides exist for is a one-page-per-photograph shoot, where
 * the two readings agree — see `CaptureStanding`.
 *
 * FIRST APPEARANCE IN `order`, which is the same rule the walk, the mint and
 * `namerFor` all use: the arrangement is what the person is looking at, and
 * after a drag `recipe.photos` is intake sequence and a different book. Which
 * also means a drag can move a photograph from one side to the other, exactly as
 * it moves its page number — that is what it means for the sides to be a fact
 * about the arrangement rather than a mark on a picture.
 *
 * A photograph the arrangement never names still gets a side, continuing the
 * count, so nothing falls out of the book for being unplaced.
 */
function paritiesOf(recipe: CaptureRecipe): ReadonlyMap<string, Parity> {
  const sides = new Map<string, Parity>();
  const side = (): Parity => (sides.size % 2 === 0 ? 'odd' : 'even');
  for (const pageId of recipe.order) {
    const owner = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
    if (owner !== undefined && !sides.has(owner.id)) sides.set(owner.id, side());
  }
  for (const photo of recipe.photos) if (!sides.has(photo.id)) sides.set(photo.id, side());
  return sides;
}

/** One photograph's side, for the callers that need a single answer. */
function parityOf(recipe: CaptureRecipe, photoId: string): Parity {
  return paritiesOf(recipe).get(photoId) ?? 'odd';
}

/**
 * THE LINES A PHOTOGRAPH ON THIS SIDE WEARS — ITS SIDE'S, OR THE BOOK'S OWN.
 *
 * The ONE resolution, and every act that asks what the book has to say about a
 * photograph asks it here: the two Finalizes, the live propagation, *Follow the
 * book again*, the cut the *Two pages* tick offers, the ghost under the outline
 * and the rail's counts. Written twice it would be two answers within the hour.
 *
 * A SIDE'S BLOCK IS TAKEN WHOLE. A block holding a crop and no cut means "these
 * pages are single sheets", not "inherit the book's cut" — see
 * `CaptureStanding` for why a merge cannot say both. An empty block (which
 * nothing writes and the validator drops) falls back rather than resolving to
 * nothing, because a key meaning nothing should not be able to take a crop away
 * from a page.
 */
function linesFor(standing: CaptureStanding | undefined, parity: Parity): CaptureLines | undefined {
  const own = standing?.[parity];
  if (own !== undefined && (own.crop !== undefined || own.cut !== undefined)) return own;
  return linesOf(standing);
}

/**
 * THE BOOK'S OWN LINES, or nothing when it has none of its own.
 *
 * A standing carrying only sides is a real state — place the odd pages' crop
 * first and the book itself has said nothing yet — and it must answer NOTHING
 * here rather than an empty object, so a photograph on a side that has not been
 * set is left alone instead of dressed in a crop that does not exist.
 */
function linesOf(standing: CaptureStanding | undefined): CaptureLines | undefined {
  if (standing === undefined) return undefined;
  if (standing.crop === undefined && standing.cut === undefined) return undefined;
  return standing;
}

/**
 * EVERY STANDING A BOOK HOLDS — its own and its sides', each of them saying
 * something.
 *
 * For the questions that are about the book rather than about a photograph: is
 * there a crop anywhere to finalize, is there a cut anywhere to land, is this
 * standing empty enough to be written as silence.
 */
function standings(standing: CaptureStanding | undefined): readonly CaptureLines[] {
  const all: CaptureLines[] = [];
  const own = linesOf(standing);
  if (own !== undefined) all.push(own);
  if (standing?.odd !== undefined) all.push(standing.odd);
  if (standing?.even !== undefined) all.push(standing.even);
  return all;
}

/**
 * ONE BLOCK OF LINES WITH ITS CUT SET, OR TAKEN AWAY.
 *
 * `undefined` DELETES rather than writing a key, because absent is what a book
 * of single pages looks like everywhere else in this file and the validator
 * writes silence for it either way.
 *
 * IT MUTATES, and every caller hands it a copy it has just made. That is the
 * only shape that reads honestly beside `delete book.cut` two lines above it;
 * a version that returned a new object would be doing the same thing while
 * looking like it was doing something safer.
 */
function withCut<T extends CaptureLines>(lines: T, cut: CaptureSplit | undefined): T {
  if (cut === undefined) delete lines.cut;
  else lines.cut = cut;
  return lines;
}

/**
 * THIS PHOTOGRAPH, MOVING WITH THE BOOK AGAIN — the mark given up, the lines
 * left exactly where they are.
 *
 * It is `wearing`'s bookkeeping without `wearing`'s geometry, and it exists
 * because three acts need the bookkeeping alone: re-ticking *Global*, the
 * right-click hand-back on a book that has no standing yet, and the lead of a
 * `dressed` walk on its way into `wear`. Both halves are required and neither
 * is enough: the stored answer goes (a `false` left here would be a release
 * nobody pressed) AND every page's `byHand` goes with it, or the derive in
 * `isComplete` would go on answering "complete" from the provenance.
 */
function following(photo: CapturePhoto): CapturePhoto {
  const next = { ...photo };
  delete next.complete;
  return { ...next, pages: photo.pages.map((page) => ({ ...page, byHand: false })) };
}

/**
 * ONE PHOTOGRAPH BACK TO NO CROP AT ALL, FACING THE WAY IT NOW FACES.
 *
 * `WHOLE_FRAME` turned to the sheet's own orientation, which is the whole of
 * what "back to original, but keep the turns" means: a turn moves no corner, so
 * a turned whole frame is still no crop (`isWholeFrameTurned` is the reading of
 * exactly this) while a bare `WHOLE_FRAME` would silently un-turn twenty-five
 * sideways spreads. See `CaptureService.resetAll` for why that is the ruling.
 *
 * A CUT SURVIVES ITS CROP, which is `clearCrop`'s ruling applied to the book:
 * the halves are re-derived from the turned whole frame and the gutter stays
 * exactly where it was put. A cut that will not resolve against the whole frame
 * is left alone — there is no page to re-derive, and inventing one is the only
 * worse answer.
 */
function uncropped(photo: CapturePhoto): CapturePhoto {
  const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const whole = turnQuad(WHOLE_FRAME, turnsOf(sheet));
  const halves = photo.split === null ? null : halvesOf(whole, photo.split);
  if (photo.split !== null && halves === null) return following(photo);
  const quads: readonly CaptureQuad[] = halves ?? [whole];
  const next = { ...photo };
  delete next.complete;
  return {
    ...next,
    pages: quads.map((quad, seat) => ({
      id: `${photo.id}:${seat}`,
      quad,
      struck: photo.pages[seat]?.struck ?? false,
      byHand: false,
    })),
  };
}

/**
 * ONE PHOTOGRAPH PUT BACK TOGETHER — `clearSplit`'s body, for the acts that
 * need it on every photograph at once.
 *
 * The rejoined page keeps the crop the halves were describing, because
 * `joinedQuad` is the same body the editor draws from and `cutWith` re-cuts
 * from. A STRIKE ON EITHER HALF STRIKES THE PAGE: rejoining cannot keep half a
 * strike, and dropping it would quietly restore a page somebody had rejected.
 *
 * It comes back a FOLLOWER, which is what separates it from `clearSplit` —
 * that one is a person's own act on one photograph and marks it; this is the
 * book's, from `resetAll` and from a global rejoin, and marks nobody.
 */
function rejoined(photo: CapturePhoto): CapturePhoto {
  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const next = { ...photo };
  delete next.complete;
  return {
    ...next,
    split: null,
    pages: [{
      id: `${photo.id}:0`,
      quad: whole,
      struck: photo.pages.some((page) => page.struck),
      byHand: false,
    }],
  };
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
function standingOf(photo: CapturePhoto): CaptureLines {
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
function wearing(photo: CapturePhoto, standing: CaptureLines): CapturePhoto | null {
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
