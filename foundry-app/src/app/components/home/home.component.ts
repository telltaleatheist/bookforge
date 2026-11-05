import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { typeLabel } from '@owen/foundry-core/shared/documents';
import type { ProjectSummary } from '@owen/foundry-core/shared/types';

import { api, hosted } from '../../core/foundry';
import { CaptureService } from '../../core/capture.service';
import { IntakeWorkspaceService } from '../../core/intake-workspace.service';
import { ProjectsService } from '../../core/projects.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { NoticeService } from '../../core/notice.service';
import { UiService } from '../../core/ui.service';

/**
 * Home — what the app is when nothing is open.
 *
 * Three things, in the order a person needs them: the books they have worked on,
 * a target big enough to drop a book on without aiming, and the two actions
 * worth a button. The drop target is decorative in the strict sense — the WHOLE
 * WINDOW accepts a drop (see App) — but a rectangle that says "drop here" is how
 * anybody knows that.
 *
 * ── The list is PROJECTS, not files ──────────────────────────────────────────
 *
 * A row is a BOOK — one folder holding the scan, the cast EPUB, a translation,
 * the real-text PDF — and the tags on it are the answer to "what has been made
 * from this?", which a flat list of filenames could not give.
 *
 * CLICKING A ROW OPENS THE BOOK, and it used to open a drop-down instead. The
 * expansion was a list of every document in the project and a second click to
 * choose from it — which is the right question asked at the wrong moment: nine
 * times out of ten the answer is "the scan", the user knew that before they
 * clicked, and the menu was a step between them and the thing they came for.
 * `originalOf` picks it (ProjectsService) and the row opens it directly.
 *
 * THE OTHER DOCUMENTS ARE NOT GONE, THEY MOVED. They are in the open-documents
 * nav now, grouped under the project, where flipping between a scan and the book
 * cast from it is one click and stays available while you read — which is when
 * that question is actually asked. It was never a question for a screen you are
 * about to leave.
 *
 * A row leaves this list ONE WAY, and it takes the book with it. There is no
 * Clear and no "forget this", deliberately: the old recents list was a cache of
 * names and dropping one cost nothing, but this one is the library itself, and a
 * button that made a book vanish from the only screen that lists it while
 * leaving the folder on disk would be a delete button wearing a nicer word.
 *
 * So the button beside Reveal is the honest version of that: it DELETES — the
 * project directory and everything in it, off the disk, for real. The question
 * is asked in the app's OWN confirmation now (ConfirmService) rather than in a
 * native message box, but every word in it is still main's: the size on disk,
 * the readings bank, the filed copy (`projects:describe` in electron/ipc.ts).
 * This side's job is to refuse early when a document from the project is open,
 * to ask, and to say what happened.
 *
 * IT IS THE SAME CARD THE SIDE NAV USES to delete one document. There is exactly
 * one confirmation in this app, and it looks the same wherever the thing being
 * ended is — which is what stops a second, softer one being invented later.
 *
 * IT IS ALWAYS THE WHOLE WINDOW NOW, and that is the single-viewer ruling
 * reaching this file (docs/PLAN.md §4, unit 8b). It used to be two things: the
 * app's first screen, AND what an empty COLUMN showed — Ctrl+\ made a column with
 * nothing in it, and the useful thing to put in one was the library. Drawn as a
 * column it carried a ✕ of its own, because a column you asked for and changed
 * your mind about has to be a column you can put away. There are no columns, so
 * there is no ✕ and no `pane` input: this screen appears when nothing is on
 * screen and no project is held, and it fills the window it appears in.
 */
@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.component.html',
  styleUrl: './home.component.scss',
})
export class HomeComponent {
  protected readonly hosted = hosted;

  protected readonly projects = inject(ProjectsService);
  protected readonly documents = inject(OpenDocumentsService);
  private readonly notices = inject(NoticeService);
  protected readonly ui = inject(UiService);
  /** Read for one question: is there a workspace to promise? See the target. */
  protected readonly workspace = inject(IntakeWorkspaceService);
  private readonly captures = inject(CaptureService);
  private readonly router = inject(Router);

  constructor() {
    // Re-read every time Home is constructed, which is every time it comes back
    // on screen. There is no push channel for the project list and there should
    // not be: the things that change it are conversions, which the queue already
    // broadcasts, and this is the only screen that reads it.
    void this.projects.refresh();
  }

  /**
   * What has been made from this book, as short tags on its row.
   *
   * WHAT IT IS, never where it lives: `cast`, `real text`, `translation`. The
   * folders those documents actually sit in are this app's bookkeeping and the
   * user never has to learn them. The catalogue still spells the real-text PDF's
   * role `searchable`, because that token is written into every project on every
   * disk and renaming it would orphan those rows — so the tag is translated here,
   * where a person reads it, rather than there, where a file remembers it.
   * Deduplicated, because a book with three
   * translations says "translation" once and expands to name them — the row
   * answers "has this been cast yet?" at a glance, and three language tags in a
   * row answers something else.
   *
   * An imported document contributes no tag: "you gave me this book" is not an
   * answer to what has been made from it.
   */
  protected tags(project: ProjectSummary): string[] {
    const tags: string[] = [];
    for (const document of project.documents) {
      /*
       * THE FILE TYPES THIS BOOK HAS, which is what a row is now. The book's own
       * type is not a tag — "you gave me a PDF" is not an answer to what has
       * been made from it — so the row that IS the import contributes nothing,
       * and everything beside it is something this app produced.
       */
      if (document.origin) continue;
      tags.push(typeLabel(document.kind));
    }
    return tags;
  }

  /**
   * Open the book this project is about — one click, no menu.
   *
   * `managed` decides whether the tab wears the unsaved dot, and the answer
   * differs inside one project: a cast book exists only because Foundry made it,
   * so nothing the user chose holds a copy — but an IMPORTED document is their
   * own, sitting in a folder of their own, and a dot on it would be a warning
   * about a loss that cannot happen. It rides on the document (`ProjectDocument`)
   * rather than being worked out here, because main is what knows where a file
   * came from.
   *
   * A project with nothing openable left is refused by the disabled row above,
   * and a catalogue that will not parse never gets here — `originalOf` returns
   * null for both, and the row says which it is.
   */
  /**
   * A row nobody can open, which a capture project is NOT.
   *
   * The old test was "the catalogue parses and there is no original", which was
   * exactly right until a project could exist with no documents on purpose.
   * Owen closed Foundry, reopened it, and found the project he had spent the
   * evening photographing greyed out and tagged "nothing to open" -- both false,
   * and the second one insulting: everything was there.
   *
   * `project.capture` is asked rather than inferred from the empty document
   * list, because an empty list is ALSO what a project whose files have gone
   * missing looks like, and that is the case the tag was written for. This is
   * the field I asked for at seq 54 and then did not wire when it landed.
   */
  protected deadRow(project: ProjectSummary): boolean {
    if (project.problem !== null) return false;
    if (project.capture) return false;
    return this.projects.originalOf(project) === null;
  }

  protected openProject(project: ProjectSummary): void {
    const original = this.projects.originalOf(project);
    /*
     * A CAPTURE PROJECT WITH NOTHING MINTED YET OPENS ITS LIGHT TABLE. There is
     * no document to stand on, and the surface the person was working on is the
     * table -- so the row goes back to where they left off rather than refusing.
     *
     * Once it HAS been minted it has an original like any other project and
     * opens through the ordinary door, which lands on its position: the ledger
     * decides whether that is the book or the photographs, and this row does not
     * need a second opinion about it.
     */
    if (original === null) {
      if (!project.capture) return;
      this.documents.show(this.documents.captureTabIn(project.dir));
      return;
    }
    /*
     * THE PROJECT DOOR AND NOT THE FILE DOOR: the row is a book, and opening a
     * book means landing where its position stands — the proof sheet, for any
     * project with edits or a reading — with the original adopted underneath it
     * exactly as before. `OpenDocumentsService.openProject` owns the reasoning.
     */
    void this.documents.openProject(project.dir, original.path, original.managed);
  }

  /**
   * The glyph is the ORIGINAL'S kind, which is a fact about the book rather
   * than about the row's state — a project of a scan shows a page, a project
   * started from an EPUB shows a book. It replaced the expander's chevron, and
   * it earns its place for the same reason the chevron did not: a triangle said
   * "there is more of this row", which is no longer true, and this says what
   * pressing the row will open.
   */
  protected glyph(project: ProjectSummary): string {
    if (project.problem !== null) return '⚠';
    const original = this.projects.originalOf(project);
    // Photographs, and only photographs: a capture project reaches this line
    // exactly while nothing has been minted from it, and the empty-project glyph
    // beside it means the opposite thing -- that everything is gone. Once it has
    // minted, it has an original and falls through to the scan glyph below,
    // which is right for a minted book for the same reason it is right for an
    // imported one: what the row opens is a picture of paper.
    if (project.capture && original === null) return '▣';
    if (original === null) return '⌸';
    return original.kind === 'epub' ? '▤' : '▦';
  }

  /** What the row says on hover: the file it opens, over the folder it is in. */
  protected rowTitle(project: ProjectSummary): string {
    if (project.problem !== null) return project.problem;
    const original = this.projects.originalOf(project);
    // The same lie the row told, in the tooltip. A capture project with no
    // original has everything it is supposed to have.
    if (original === null) {
      // The light table, because that is what the row opens and saying otherwise
      // would be a tooltip describing a door that is not there. It said one of
      // two sentences until Wave 41 — the second was "the pages are made" — and
      // a minted project has an original now and never gets here, so there is
      // one thing left to say.
      if (project.capture) return `Open the light table\n${project.dir}`;
      return `${project.dir}\nNothing in this project is still on the disk.`;
    }
    return `Open ${original.label}\n${project.dir}`;
  }

  /**
   * "Read this book's pages" — the row's own next step.
   *
   * IT OPENS THE BOOK FIRST, and that is not a detour. The OCR dialog converts
   * the document in front of you: it lists the open PDFs and defaults to the
   * focused one, because reading pages is something you do to a book you are
   * looking at. Opening the dialog over a library screen with nothing open would
   * put "Open a PDF first" in front of somebody who had just pointed at a
   * specific book — so the row opens it, and the dialog then finds it there.
   */
  protected async readPages(project: ProjectSummary): Promise<void> {
    const original = this.projects.originalOf(project);
    /*
     * A CAPTURED-BOOK ARM STOOD HERE (Wave 41's gravestone) opening the light
     * table first, because a minted project had no document and the tab WAS the
     * opening — the OCR dialog found a capture project through its open tab
     * exactly as it finds a PDF through one.
     *
     * A minted project has an original, so it takes the branch below with every
     * other book. What is left of the null case is a project with photographs
     * and no mint, and there is nothing there to read: `reading.needed` is false
     * for it (its archive is null), so this button is not drawn on that row at
     * all and the guard has nothing to guard.
     */
    if (original === null) return;
    /*
     * AWAITED, and the await is the whole of the fix. Opening a document is a
     * full round trip through main — it admits the path, records the recent and
     * pushes `document:opened` back — and firing the dialog beside it meant the
     * card painted before the tab existed. So a person who pressed OCR on a
     * specific book got "Open a PDF first" over the book they had just pointed
     * at, and the only way out was to close the dialog and press it again.
     */
    await this.documents.openFile(original.path, original.managed);
    this.ui.openOcr();
  }

  /** The folder itself, in Explorer/Finder. The one way out of this app. */
  protected reveal(project: ProjectSummary): void {
    void api?.reveal(project.dir);
  }

  /**
   * Delete the project — the folder and everything in it, off the disk.
   *
   * THE TAB CHECK IS HERE AND ALSO IN MAIN, and the two are not redundant. This
   * one is the one that can say a sentence worth reading: this side holds the
   * tabs, so it knows the document's TITLE — the words on the tab the user is
   * looking at — and can name it and say that closing it makes this possible.
   * Main's is the one that is an authorization: it asks its own record of what
   * is unpacked, because a renderer's word about its own state is not a fact
   * main may act on when the action is a recursive delete. Deleting a working
   * tree out from under an open book leaves the viewer serving files that are
   * gone, and on Windows the delete stops on the first locked file and leaves
   * half a project.
   *
   * EVERY TAB, not just the focused one, and matched on the PATH rather than on
   * anything the row supplies: an editor tab points at its book's path too, and
   * a book can be open in more than one column.
   *
   * A cancel is silence. Anything else — the sentence main returns when the
   * folder is gone, or a refusal from either side — goes to the notice strip,
   * which is where this app says what it just did.
   */
  protected async remove(project: ProjectSummary): Promise<void> {
    const open = this.documents.tabs().find((tab) => within(project.dir, tab.path));
    if (open !== undefined) {
      this.notices.notice.set(
        `“${open.title}” is open from this project, so it cannot be deleted while you are `
        + 'reading it — the delete would leave this tab showing files that no longer exist. '
        + 'Close it, then try again.',
      );
      return;
    }
    try {
      const said = await this.projects.remove(project);
      if (said !== null) this.notices.notice.set(said);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }


  protected settings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /** Coarse on purpose — the exact minute a book was opened is nobody's question. */
  protected when(at: number): string {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(at).toLocaleDateString();
  }
}

/**
 * Is `filePath` inside `dir`? Folded, because on Windows one file arrives
 * spelled three ways — the same reason recents compares paths this way.
 *
 * The separator is appended to the folder before the prefix test, so a project
 * called `Kershaw-a1b2c3d4` does not claim the tabs of `Kershaw-a1b2c3d4-notes`
 * sitting beside it and block a delete that has nothing to do with it. This is
 * a check that produces a MESSAGE, not one that grants anything: main proves for
 * itself what may be erased.
 */
function within(dir: string, filePath: string): boolean {
  const fold = (target: string): string => target.replace(/\\/g, '/').toLowerCase();
  const root = fold(dir).replace(/\/+$/, '');
  return fold(filePath).startsWith(`${root}/`);
}
