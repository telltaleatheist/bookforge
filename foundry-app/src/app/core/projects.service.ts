import { Injectable, effect, inject, signal } from '@angular/core';

import { spokenName } from '@shared/documents';
import { bookRow, fold, originalOf } from '@shared/original';
import type { ProjectDocument, ProjectSummary } from '@shared/types';

import { ConfirmService } from './confirm.service';
import { QueueService } from './queue.service';
import { api } from './foundry';

/**
 * Home's list of books, mirrored from main.
 *
 * A MIRROR and not a store, the same way QueueService and RecentsService are:
 * main reads `<libraryDir>/projects/` and decides what is in it
 * (electron/projects.ts), and this class never edits a row. There is no push
 * channel and there should not be — a project's contents change when a
 * conversion lands, which the queue already broadcasts, and Home refreshes when
 * it appears.
 *
 * `refresh()` re-reads from disk rather than patching what is here, because the
 * things that change a project happen in MAIN — a job finishing, an output
 * rotated aside — and a renderer that maintained its own copy of that would be
 * a second opinion about a folder it cannot see.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private readonly confirm = inject(ConfirmService);
  private readonly queue = inject(QueueService);
  private readonly all = signal<ProjectSummary[]>([]);

  readonly items = this.all.asReadonly();

  /**
   * Read once at construction, and again whenever a screen that needs it says so.
   *
   * IT USED TO BE HOME'S ALONE, which was safe while Home was the only reader:
   * the component is built fresh every time it comes back on screen, so the list
   * was never stale where it was drawn. The side nav now groups open documents
   * under their project, and the nav is on screen exactly when Home is NOT — so
   * a service that only ever loaded on Home would leave the nav with no
   * projects to group by for the whole of a session that opened a book from
   * disk. Once here, and refreshed by whoever notices a reason.
   */
  constructor() {
    void this.refresh();

    /*
     * MAIN SAYS WHEN THE LIBRARY MOVED, which is the trigger that was missing.
     *
     * A dropped file becomes a project in the BACKGROUND, behind the tab that
     * has already opened — and none of the three reasons this list used to
     * re-read (constructed, Home appeared, a job landed) is a background import
     * finishing. So the app went on insisting a book was not in the library
     * while its folder sat on the disk, and every question answered from this
     * list was answered wrongly.
     *
     * The event carries nothing: composing the listing is a directory walk, main
     * does not do one on the chance somebody is watching, and this asks for it.
     */
    api?.projects.onChanged(() => { void this.refresh(); });

    /*
     * AND AGAIN WHENEVER A JOB LANDS, which is the reason this class's own
     * header said somebody would eventually have to notice.
     *
     * The rule used to be "Home refreshes when it appears", and that was enough
     * while the list only said what a project CONTAINED — you went to Home to
     * see it, and going to Home re-read it. It stopped being enough when a row
     * started saying what a project NEEDS: the OCR light is on until the pages
     * are read, and the moment it goes out is a job finishing, which happens
     * while the user is looking at the book rather than at the library. A light
     * that stayed on until somebody navigated away and back would be the app
     * asking for a step it had already taken.
     *
     * WATCHING THE MIRROR rather than being told by whatever enqueued the job:
     * the job outlives the dialog that started it, outlives a trip to Settings,
     * and (because main owns the queue) outlives a reload of this window. The
     * only fact that matters is that a row has stopped moving.
     *
     * Ids are remembered so that the effect's other dependencies — a progress
     * count arriving twenty times a minute — cannot turn this into a directory
     * listing per page read.
     */
    const settled = new Set<string>();
    effect(() => {
      let landed = false;
      for (const job of this.queue.jobs()) {
        if (job.state === 'running' || job.state === 'queued' || job.state === 'held') continue;
        if (settled.has(job.id)) continue;
        settled.add(job.id);
        landed = true;
      }
      if (landed) void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (!api) return;
    this.all.set(await api.projects.list());
  }

  /**
   * The project a path belongs to, or null for a file opened from anywhere else.
   *
   * Folded, because on Windows one file arrives spelled three ways, and the
   * separator is appended before the prefix test so that `Kershaw-a1b2c3d4` does
   * not claim the documents of `Kershaw-a1b2c3d4-notes` sitting beside it.
   */
  projectFor(filePath: string): ProjectSummary | null {
    const target = fold(filePath);
    /*
     * THE DIRECTORY ITSELF IS IN ITS OWN PROJECT. The strict-child test was the
     * whole answer while every tab held a FILE — a scan, a cast, an export — and
     * it silently excluded the one tab that holds the project directory as its
     * path: the proof sheet. That absence was load-bearing in the worst way —
     * the export dialog concluded no book was open over the very surface the
     * book is edited on, and the inspector's standing strip never drew there.
     * Equality is folded the same way the prefix is, so the two spellings of
     * one directory cannot disagree about whose project it is.
     */
    return this.all().find((project) => {
      const dir = fold(project.dir).replace(/\/+$/, '');
      return target === dir || target.startsWith(`${dir}/`);
    }) ?? null;
  }

  /**
   * WHAT TO CALL THE DOCUMENT AT THIS PATH — the one answer, for every surface
   * that has to draw a name.
   *
   * ── The bug this exists for ────────────────────────────────────────────────
   *
   * Home has always said "Working Towards the Führer". The list down the left,
   * the pane's own toolbar, the window's title bar, the OCR picker and the queue
   * shelf all said `Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993.pdf`, because
   * each of them reached for the basename — a string built to survive a
   * filesystem, which is not the name of a book. Two surfaces of one window
   * calling one book two things is not a cosmetic complaint: it is the app
   * failing to agree with itself about what the user is looking at.
   *
   * ── Why it is HERE ────────────────────────────────────────────────────────
   *
   * Because this class is already the window's copy of the library, and the
   * answer is a fact about the library: `ProjectSummary.title` is the book's own
   * `dc:title` where anything has read one and the stem said aloud where nothing
   * has (`readManifest`). Every caller reading it out of the same signal is what
   * makes the disagreement impossible rather than merely fixed — four call sites
   * each doing their own lookup is four chances for two of them to drift apart
   * again, which is precisely the shape of what went wrong.
   *
   * A CATALOGUE THAT WILL NOT PARSE IS TREATED AS NO PROJECT AT ALL. A title
   * guessed out of a manifest this app could not read is the kind of confident
   * wrong answer that has somebody working on the wrong book.
   *
   * AND THE FILE IS THE LAST RESORT, never the first: a document nobody has
   * imported — dropped on the window a second ago, or opened from a folder of
   * their own that no project will ever claim — has no book behind it, so its
   * own name is all there is. `spokenName` at least says it rather than spelling
   * it.
   */
  nameFor(filePath: string): string {
    const project = this.projectFor(filePath);
    if (project !== null && project.problem === null && project.title.length > 0) {
      return project.title;
    }
    return spokenName(filePath);
  }

  /**
   * The document this project exists to hold — what clicking its row opens.
   *
   * THE RULE ITSELF LIVES IN `shared/original.ts`, and this is a thin wrapper
   * over it for one reason worth stating: main asks the same question when it
   * decides whether a delete takes the whole project with it, and two copies of
   * that ordering drifting apart would let this side offer "delete this file"
   * over a document main treats as the source of everything else in the folder.
   *
   * A catalogue that will not parse has no documents to choose between, so it
   * has no original and the row that draws it says so instead.
   */
  originalOf(project: ProjectSummary): ProjectDocument | null {
    if (project.problem !== null) return null;
    return originalOf(project.documents);
  }

  /**
   * DID THIS BOOK ARRIVE AS A BOOK — the test that separates a project with
   * nothing left to read from a project with everything still to read.
   *
   * ── Why every door in this app needs it ─────────────────────────────────────
   *
   * A project imported from an EPUB has no reading and never will have one: a
   * bank models PAGES, an EPUB has none, and its book is exploded out of the
   * container instead (`bookAtPosition`, electron/projects.ts — the `book =
   * f(epub)` route). So `reading.done` is false for that project forever, and
   * every gate written as "a reading has landed" reads that false and shuts a
   * door on a book that is already finished. The rail's Export button and the
   * export dialog both have to ask this, and two spellings of one question is two
   * answers the day either of them learns something the other has not.
   *
   * ── Why the ORIGIN ROW and not `!reading.needed && !reading.done` ───────────
   *
   * That pair is derivable and very nearly right: main composes
   * `needed: !done && archive.kind === 'pdf'` (`readingState`), so "not needed and
   * not done" does mean "nothing has been read and the archive is not a scan".
   * What it does not do is SAY anything about origin. It is two negatives about
   * the OCR light, it answers true as well for a catalogue that names no archive
   * at all, and a reader has to run main's own boolean backwards to see why it
   * means what it means.
   *
   * The summary already carries the fact itself. `bookRow` is the row whose chain
   * STARTS with the file the person handed over — `origin`, decided in
   * `summarise` from that first step's own irreplaceable cost — so its KIND is
   * what they imported, read rather than inferred. `done` rides along because it
   * is the second half of the exact pair `bookAtPosition` tests before it routes a
   * book through its container: an origin never changes, so the kind alone would
   * go on answering "arrived as a book" at a position standing under a reading of
   * one, and this side must not be the place that forgets that.
   *
   * A CATALOGUE THAT WILL NOT PARSE ANSWERS FALSE. A project this app cannot
   * describe is not one to open an export door over on a guess; main's own
   * refusal names that case in words, which is the better door.
   */
  arrivedAsBook(project: ProjectSummary | null): boolean {
    if (project === null || project.problem !== null) return false;
    return bookRow(project.documents)?.kind === 'epub' && !project.reading.done;
  }

  /**
   * Ask about erasing a project, then do it — and re-read the list if it ran.
   *
   * THREE STEPS AND MAIN OWNS TWO OF THEM. Main composes the warning and proves
   * the delete is allowed (`describe`); this side asks the question in the app's
   * own card; main proves it again and erases (`delete`). The question moved out
   * of main because a native message box is not this app's voice — the facts
   * stayed there because they are facts only main has.
   *
   * NOT AN EXCEPTION to "this class never edits a row", which is the point of
   * the round trip: the row does not disappear because this asked for it to, it
   * disappears because the folder it described is no longer in `projects/` when
   * `refresh()` reads that directory again. A renderer that patched its own list
   * on the way out would show a book as deleted that is still on the disk.
   *
   * Returns what to say in the notice strip, or null when the user cancelled —
   * a cancel is silence. A refusal throws, and the caller says it.
   */
  async remove(project: ProjectSummary): Promise<string | null> {
    if (!api) return null;
    const prompt = await api.projects.describe(project.dir);
    if (!await this.confirm.ask(prompt)) return null;
    const said = await api.projects.delete(project.dir);
    await this.refresh();
    return said;
  }

  /**
   * Ask about erasing ONE document, then do it.
   *
   * THE ORIGINAL IS NOT A FILE DELETE AND THE MODAL NEVER OFFERS ONE. Main
   * reports `original: true` for the document everything else in the folder was
   * made from, and hands back the PROJECT's warning to ask with — so the
   * question the user sees is the true one ("this deletes the whole project"),
   * and the call that runs is the project delete. There is no path through this
   * method that erases the source of a project and leaves the project standing.
   *
   * Returns the notice sentence, or null on a cancel.
   */
  async removeDocument(
    filePath: string,
    closeIt?: () => void | Promise<void>,
  ): Promise<string | null> {
    if (!api) return null;
    const plan = await api.documents.describe(filePath);
    if (!await this.confirm.ask(plan.prompt)) return null;
    /*
     * Between the yes and the delete: a file this window still holds open
     * cannot be unlinked on Windows, and the caller is the only side that can
     * let go of it. Never before the question — see the call site.
     *
     * AWAITED, or the callback does not do the job it exists for. Closing a tab
     * flushes a pending edit and tells main to let go of the unpack, both of
     * which take a turn of the loop; a fire-and-forget close would hand the
     * delete a window that has not finished letting go — which is the exact
     * failure this callback was placed here to prevent, and on the original's
     * path it is main's "that book is open right now" refusal arriving one line
     * after the user confirmed.
     */
    await closeIt?.();
    const said = plan.original
      ? await api.projects.delete(plan.projectDir)
      : await api.documents.delete(filePath);
    await this.refresh();
    return said;
  }
}
