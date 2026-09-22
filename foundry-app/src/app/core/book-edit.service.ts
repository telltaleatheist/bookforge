import { Injectable, computed, inject, signal } from '@angular/core';

import { isPdfName } from '@shared/capture';
import type { ProjectDocument, ProjectSummary } from '@shared/types';

import { api } from './foundry';
import { CaptureService } from './capture.service';
import { OpenDocumentsService } from './documents.service';
import { NoticeService } from './notice.service';
import { PdfPagesService } from './pdf-pages.service';
import { ProjectsService } from './projects.service';

/**
 * EDIT THE BOOK YOU ARE READING — take its PDF apart onto a light table of its
 * own, and hand the pages back as a second book.
 *
 * ── Owen's ask, 2026-09-21, verbatim ────────────────────────────────────────
 *
 * *"im thinking we should have an 'edit book' option in the normal foundry
 * window. after we open a pdf, and we have the step workflow on the left side
 * and the tiles and everything, maybe the user can be given the option of
 * editing the book directly (if it's a pdf), which would take them to the
 * crop/page split/etc screen. they can rebuild the book and itll have a new set
 * of steps starting from the edited version they create from the original."*
 *
 * The gesture already existed, and only at the door: drop a PDF on the window
 * and the card offers *Edit book*, which explodes it into pages you can crop,
 * split and turn (`App.sortPdfs`). What was missing was the same offer ONE
 * MOMENT LATER — after the book is open, the steps are down the left and the
 * person has just discovered that every second page is upside down. Until now
 * the only way there was to find the file on disk and drag it in again, which is
 * a person working around their own library.
 *
 * ── IT MAKES A SECOND BOOK. IT DOES NOT EDIT THE OPEN ONE ───────────────────
 *
 * This is the ruling the whole file hangs on, and Owen's own sentence is the
 * argument for it: *"itll have a NEW SET OF STEPS starting from the edited
 * version they create from the original."* A project is a ledger — an ordered
 * account of what was done to one document, with readings, overlays and
 * corrections hanging off particular steps. Re-founding an open project on a
 * different PDF would orphan all of it silently: the bank would still be there,
 * still keyed to pages that no longer exist, and nothing on screen would say so.
 *
 * So the original is not touched at all. What is made is a NEW capture project
 * whose photographs happen to be the old book's pages, and from the moment it is
 * made it is an ordinary light table — the crop, the split and the turn are the
 * ones that were always there, and its mint founds its own document with its own
 * steps (`catalogueMint`, electron/projects.ts: *"from that moment the project is
 * ORDINARY"*). Nothing below had to be built for that; it is verified rather than
 * written.
 *
 * ── AND IT IS THE DROP CARD'S OWN TWO DOORS, IN SEQUENCE ────────────────────
 *
 * `IntakeWorkspaceService.createBook` says this at length and it is the same
 * sentence here: `capture:create` makes a named empty project, `CaptureService
 * .intake` copies files into one — and `intake` is ALREADY the door that knows a
 * PDF in the list means "explode it first", because the light table's own drop
 * needed exactly that (see its `isPdfName` block). So "take this book apart into
 * a new book" is those two calls one after the other, and this service is the
 * word "then". No rasterizing, no staging, no release, and no second opinion
 * about any of it.
 *
 * ── THE ONE THING IT HAS TO DO ITSELF: A PATH IS NOT A `File` ───────────────
 *
 * The drop card is handed `File` objects by the browser. A book on the shelf is
 * a PATH, and pdf.js runs in this renderer, so the bytes have to cross into it
 * before anything can be drawn — `api.documentBytes`, the same door the scan
 * pane beside a book reads its page from, and then a `File` composed over the
 * bytes so that the door below receives what it already accepts.
 *
 * THAT READ IS GATED BY `admitted` (electron/documents.ts) and the refusal is
 * *"was never opened in this app"*. It is admitted in the two places that put
 * this book in front of somebody — opening the document admits its path, and
 * loading a BOOK admits the scan behind it so the original pane can draw
 * (electron/book.ts, which records this exact trap after measuring it). Both are
 * true by the time this button can be pressed, because the button only exists
 * while the book is open. A refusal is still SAID rather than swallowed: this is
 * minutes of work about to not happen, and silence would read as a dead button.
 */
@Injectable({ providedIn: 'root' })
export class BookEditService {
  private readonly captures = inject(CaptureService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly notices = inject(NoticeService);
  private readonly pdfPages = inject(PdfPagesService);
  private readonly projects = inject(ProjectsService);

  /** True from the press to the light table, so a second press cannot land. */
  private readonly running = signal(false);

  /**
   * WHETHER A BOOK IS BEING TAKEN APART RIGHT NOW — this one or any other.
   *
   * A press is minutes of rasterizing and it makes a PROJECT, so a second press
   * on a button that still looks live is a second project on the shelf with the
   * same name and half a book in it. The rasterizing pass is the shared resource
   * either way — `PdfPagesService` holds one canvas and one worker per run and
   * its progress card holds one Stop — so the honest gate is "is there a pass",
   * and that is asked of the pass rather than of this service's own flag.
   */
  readonly busy = computed(() => this.running() || this.pdfPages.progress() !== null);

  /**
   * The PDF this project was founded on, or null for a project with no such
   * thing to edit.
   *
   * ONE QUESTION, ASKED OF THE CATALOGUE — `originalOf` is what Home, the tree,
   * the OCR dialog and the export dialog all ask to mean "the book's own file",
   * and a fifth spelling of it here would be a fifth chance to disagree about
   * which file a project's steps start from. Its `path` is the live copy where
   * there is one and the archived original otherwise, which is the layer this app
   * edits and *"what the user means by 'the PDF'"* (electron/projects.ts).
   *
   * A PROJECT THAT ARRIVED AS PHOTOGRAPHS IS NOT OFFERED THIS, and the caller is
   * where that is decided rather than here: it already HAS a light table, with
   * the very crops and turns this would go and make a second copy of. See
   * `ActionMenuComponent`, where the two doors are mutually exclusive by
   * construction.
   */
  pdfOf(project: ProjectSummary): ProjectDocument | null {
    const original = this.projects.originalOf(project);
    if (original === null || original.missing) return null;
    if (original.kind !== 'pdf') return null;
    // The row's KIND and the file's own NAME both, because the name is what the
    // door below routes on: `intake` decides a file is a PDF by its extension
    // (`isPdfName`), so a row calling itself a PDF over a file that does not
    // spell one would have this hand intake a scan to be decoded as one frame.
    return isPdfName(original.label) ? original : null;
  }

  /**
   * Take `project`'s PDF apart into a new light table, and stand in it.
   *
   * ── THE NAME IS THE ORIGINAL'S WITH A WORD ON IT ───────────────────────────
   *
   * *"Working Towards The Fuhrer (edited)"*. Two books made from one scan sit on
   * one shelf for as long as both exist, and a person who cannot tell them apart
   * at a glance will read the wrong one — `createCaptureProject` keys the folder
   * off a random suffix, so the TITLE is the only thing distinguishing them.
   * Editing an edit stacks the word rather than counting: *"… (edited) (edited)"*
   * is honest about what happened, where *"(edited 2)"* would invite the question
   * of what the first one was.
   *
   * ── AN EXPLOSION THAT WAS STOPPED STILL LEAVES THE TABLE ───────────────────
   *
   * `createBook`'s rule, for its reason, said there in full: the project *"was
   * named, it exists, and its light table is the surface the images can be
   * dragged onto directly"*. Pressing Stop on the progress card halfway through
   * a 600-page scan therefore lands on an empty or partial table rather than on
   * nothing — which is the outcome somebody who stopped it can see and act on,
   * where a project silently deleted underneath them would be this app throwing
   * away a folder it made on their behalf.
   */
  async editBook(project: ProjectSummary): Promise<boolean> {
    if (api === null) return false;
    if (this.busy()) {
      this.notices.notice.set('A book is already being taken apart. Wait for it to finish.');
      return false;
    }
    const original = this.pdfOf(project);
    if (original === null) {
      this.notices.notice.set(
        `${project.title} has no PDF behind it, so there are no pages to take apart.`);
      return false;
    }

    this.running.set(true);
    try {
      let file: File;
      try {
        const bytes = await api.documentBytes(original.path);
        /*
         * RE-VIEWED, NOT COPIED. `documentBytes` answers a `Uint8Array`, whose
         * type says its buffer is `ArrayBufferLike` — so a `BlobPart` will not
         * take it, because in principle such a view could be over a
         * `SharedArrayBuffer`, which structured cloning across the preload
         * cannot produce. `bytes.slice()` would satisfy the compiler by making a
         * SECOND full copy of a scan that can run to hundreds of megabytes; a
         * view over the same bytes says the same thing for nothing.
         */
        const whole = new Uint8Array(
          bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
        /*
         * THE NAME MATTERS AND THE TYPE DOES NOT. `intake` routes on
         * `isPdfName(file.name)` and pdf.js reads the bytes, so the one thing
         * this has to get right is the name — and `label` is the row's own
         * filename, which `pdfOf` has already checked spells a PDF. It is
         * `label` rather than the tail of `path` because a document's name is a
         * fact the catalogue keeps and this side has no business re-deriving:
         * the house rule is that nothing in this app matches a document by the
         * last segment of a path.
         */
        file = new File([whole], original.label, { type: 'application/pdf' });
      } catch (err) {
        this.notices.notice.set(
          `${project.title} could not be read to take apart: `
          + `${err instanceof Error ? err.message : String(err)}`);
        return false;
      }

      const dir = await this.captures.create(`${project.title} (edited)`);
      // `create` has already put its own sentence on the notice strip for a
      // failure. A second one here would be this file's guess at what main said.
      if (dir === null) return false;

      // Every report this makes — how many pages landed, what would not draw —
      // is main's own, said on the notice strip by `intakePaths`. Nothing here
      // re-says any of it; what this method decides is only where the person
      // ends up.
      await this.captures.intake(dir, [file]);
      this.documents.show(this.documents.captureTabIn(dir));
      return true;
    } finally {
      this.running.set(false);
    }
  }
}
