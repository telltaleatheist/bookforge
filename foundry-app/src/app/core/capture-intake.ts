/**
 * capture-intake — a capture project's photographs: creating and opening it, taking files in, ordering and removing them.
 */
import { computed } from '@angular/core';
import type { CaptureIntaken } from '@owen/foundry-core/shared/types';
import { isPdfName } from '@owen/foundry-core/shared/capture';
import { api } from './foundry';
import { PdfPagesService } from './pdf-pages.service';
import { reportOn } from './capture-outcomes';
import { turned } from './capture-geometry';
import type { CaptureService } from './capture.service';

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
export async function flush(this: CaptureService): Promise<void> {
  if (this.saveTimer !== null) {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }
  // WHATEVER THE DISK DOES NOT HAVE, pending or previously refused -- see
  // `unsaved`. A mint that follows this reads the disk, and a mint made from
  // a recipe two gestures old is a product that disagrees with the stage.
  const recipe = this.unsaved;
  const dir = this.directory();
  if (api === null || dir === null || recipe === null) return;
  await this.write(api, dir, recipe);
  if (this.unsaved !== null) {
    throw new Error(
      'The recipe could not be written, so the book on screen is not the book on disk. '
      + 'Nothing was minted from it; the notice above says what refused the write.',
    );
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
export function armed(this: CaptureService): void {
  this.leading.set(true);
  this.reach.set('all');
}

/** Start a capture project and stand in it. */
export async function create(this: CaptureService, title: string): Promise<string | null> {
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
export async function open(this: CaptureService, projectDir: string): Promise<void> {
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
 *
 * A PDF IS THE ONE FILE THAT DOES NOT SIMPLY BECOME A PATH — it becomes as
 * many paths as it has pages. See the block inside.
 */
export async function intake(this: CaptureService, projectDir: string, files: readonly File[]): Promise<CaptureIntaken | null> {
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
  /*
   * ── A PDF IN THE DROP IS TAKEN APART BEFORE ANY OF IT CROSSES ──────────
   *
   * Owen, 2026-09-10: *"give me the ability to drag/drop a pdf into a new
   * book, not just images. if i do, it should take each page as an individual
   * image."*
   *
   * ON THE LIGHT TABLE THERE IS NO SECOND MEANING TO ASK ABOUT. A PDF dropped
   * on Home could be a book to open or a book to take apart, and the shell
   * asks (`App.onDrop`). Here the person is standing in a capture project
   * looking at cards of pages: the only thing a PDF can mean is more of them.
   * It used to mean a refusal — *".pdf is not a photograph this stage reads"* —
   * which was main correctly answering a question this side should never have
   * let it be asked.
   *
   * WHAT INTAKE RECEIVES IS PNGs, and it never learns otherwise. Each page is
   * rasterized and staged (`PdfPagesService`), and the staged paths join the
   * photographs in ONE call, in the order they were dropped, so a folder of
   * loose photos and a scan handed over in one gesture land as one book in the
   * order the person handed them over.
   *
   * THE STAGING IS RELEASED IN A `finally` AND NOT ON THE HAPPY PATH. Intake
   * has copied the bytes into the project by then, so what is being deleted is
   * the second copy — and a throw that skipped the release would leave a
   * scan's worth of PNGs in %TEMP% until the next drop swept them.
   */
  const stages: string[] = [];
  let unreadable = 0;
  try {
    for (const file of files) {
      if (isPdfName(file.name)) {
        // No thumbnails: intake makes its own from the file it copies, and a
        // second encode per page here would be thrown away unlooked at.
        const exploded = await this.pdfPages.explode(file, false);
        if (exploded === null) {
          // Null is two things. A scan that would not open is no reason to
          // lose the photographs beside it, so the drop goes on. STOP MEANT
          // THE WHOLE DROP — but what has already been staged still goes in,
          // because those pages exist and the person watched them arrive.
          if (this.pdfPages.stopped()) break;
          continue;
        }
        stages.push(exploded.stageId);
        for (const page of exploded.pages) paths.push(page.path);
        continue;
      }
      const path = api.pathForFile(file);
      // COUNTED, NOT ANNOUNCED HERE. A per-file notice inside this loop
      // overwrites itself: drag in twenty photographs out of another
      // application's virtual folder and the bar shows the twentieth name and
      // nothing about the other nineteen. The one sentence at the end says how
      // many, beside everything else that happened.
      if (path === '') unreadable += 1;
      else paths.push(path);
    }
    return await this.intakePaths(projectDir, paths, unreadable);
  } finally {
    for (const stageId of stages) {
      await api.capture.pdfStageRelease(stageId).catch(() => undefined);
    }
  }
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
export async function intakePaths(this: CaptureService, projectDir: string, paths: readonly string[], unreadable: number): Promise<CaptureIntaken | null> {
  if (api === null) return null;
  if (paths.length === 0) {
    /*
     * SILENT WHEN THERE IS NOTHING TO BE SILENT ABOUT. `unreadable` is the
     * count the caller could not turn into a path; zero of those AND no paths
     * means the drop was accounted for somewhere else and already spoken
     * about — a PDF whose explosion was cancelled or refused, which said so in
     * its own words. A sentence here would be this method's guess at a failure
     * it did not witness, and "None of those 0 files could be read" is a
     * sentence about nothing.
     */
    if (unreadable === 0) return null;
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
export function reorder(this: CaptureService, order: readonly string[]): void {
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
export function sortBy(this: CaptureService, key: 'name' | 'taken', descending: boolean): void {
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
export async function remove(this: CaptureService, photoIds: readonly string[]): Promise<void> {
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
export function toggleStrike(this: CaptureService, pageId: string): void {
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
