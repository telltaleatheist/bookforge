import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';

import { BookViewComponent } from '../book-view/book-view.component';
import { PdfViewComponent } from '../pdf-view/pdf-view.component';
import { ChangesService } from '../../core/changes.service';
import { LedgerService } from '../../core/ledger.service';
import { StageService } from '../../core/stage.service';
import type { Tab } from '../../core/documents.service';
import { api } from '../../core/foundry';

/**
 * THE SECOND COLUMN — one step of this book, read-only, beside the live one.
 *
 * ── What it is, and the four words that keep it small ──────────────────────
 *
 * *"a compare button they can click and then they can choose the step to
 * compare."* (User, 2026-08-17.) This is the half after the choosing: a column
 * locked to one row of the ledger, showing what that row shows, and taking no
 * gesture that could change anything.
 *
 * IT IS NOT THE PANES COMING BACK. That is the constraint this whole component is
 * written under (docs/PLAN.md §4, unit 8d). There is ONE of these, it is driven by
 * ONE signal, and it has no id, no strip, no focus, no drag and no divider. The
 * columns were a layout system — five of them, arrangeable, each with its own
 * stack and its own idea of what "the document" meant — and the reason they went
 * is that arranging furniture had become a second selector. A comparison is not
 * furniture: it is a question with a beginning and an end, and the ✕ is the end.
 *
 * ── The two things a step can be, and how this tells them apart ────────────
 *
 * A row's picture is either the PROOF SHEET (a read, an edit, a save, a
 * translation, an imported EPUB's origin) or a FILE (the import of a scan, a
 * rendering). `ledger:document-at-step` is the question, asked of main because
 * every path in a project is main's to compose and because main is the only side
 * that can admit the answer to the viewer's allow-list. A path comes back for the
 * second kind; null for the first, and null is also what a step that has been
 * DELETED answers, which is deliberate — both mean "draw the sheet", and the sheet
 * says its own sentence when the step has gone (`book:load-at`).
 *
 * ── Nothing here ever moves the position ───────────────────────────────────
 *
 * The live column mirrors focus onto the pointer (`standForTab`, the workspace's
 * pointerdown) because looking at a document is a statement about which step you
 * are on. THIS COLUMN MAKES NO SUCH STATEMENT and must not: the whole point is to
 * look at a row you are NOT standing on. So there is no pointerdown handler here,
 * and the two viewers below are given no way to reach one — which is the same
 * reason `showPosition` never mirrors either.
 *
 * ── And it is read-only by REUSING the projection, not by hiding buttons ───
 *
 * `app-book-view` already has a locked mode: `viewing()`, which the export view
 * has used since exports opened in a tab. It hides the head row, refuses to leave
 * the finished-book register, and gates every gesture that could mint an op. This
 * column turns the same flag on through `atStep`, so the read-only-ness is the one
 * that has been carried for months rather than a second set of guards written for
 * Compare. `app-pdf-view` gets `readOnly`, which is smaller because a PDF viewer
 * has nothing to edit — what it hides is the two view-mode toggles, which write
 * through a tab id this column's synthetic tab does not have.
 *
 * ── And, since 2026-09-08, the head says WHAT CHANGED ──────────────────────
 *
 * Owen: *"I want to be able to compare what changed side-by-side in ai cleanup.
 * It should highlight the changes on each side, like in analysis."* The
 * highlight itself is the book view's (`cut()`, and `ChangesService` for the
 * diff — docs/COMPARE-CHANGES.md); what this head adds is the three things a
 * person reading two columns needs from the bar between them: HOW MANY blocks
 * differ, a way to put the light OUT without closing the comparison, and ↑↓ to
 * walk the differences with both columns following. All three are drawn only
 * when the target is a book — a scan compared with a scan has no words to diff.
 */
@Component({
  selector: 'app-compare-column',
  imports: [BookViewComponent, PdfViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './compare-column.component.html',
  styleUrl: './compare-column.component.scss',
})
export class CompareColumnComponent {
  protected readonly stage = inject(StageService);
  private readonly ledger = inject(LedgerService);
  /** The diff between the two columns — the head reads its count and drives its walk. */
  protected readonly changes = inject(ChangesService);

  /** The chip's sentence: how many blocks differ, or that none do. */
  protected readonly said = computed<string>(() => {
    const n = this.changes.changedBlocks();
    if (!this.changes.enabled()) return 'changes off';
    if (n === 0) return 'no changes';
    return n === 1 ? '1 block changed' : `${n} blocks changed`;
  });

  /** The toggle — `ConfirmDialogComponent.tick`'s shape, for the same input. */
  protected light(event: Event): void {
    this.changes.enabled.set((event.target as HTMLInputElement).checked);
  }

  /**
   * What this step resolves to, once main has answered — `null` path means the
   * proof sheet.
   *
   * THE STEP ID IS CARRIED WITH THE ANSWER so the template cannot draw one step's
   * chrome over another's book. A person clicking down a list of rows issues
   * several of these and main answers them in whatever order the disk feels like;
   * the effect below drops any answer that is not about the comparison currently
   * asked for, which is the ticket idiom `showPosition` uses for the same hazard.
   */
  protected readonly target = signal<{ stepId: string; path: string | null } | null>(null);

  constructor() {
    /*
     * ASK MAIN WHAT THIS ROW SHOWS, and ask again when the row changes.
     *
     * The comparison is a computed that can also go null underneath this — the
     * step was deleted, the book on screen changed — and when it does the workspace
     * stops drawing this component entirely, so there is nothing to clean up here.
     * What this effect owes is the other direction: a comparison that MOVED from
     * one step to another while the column stayed up, which is what happens when
     * somebody picks a second row without leaving compare mode.
     */
    effect(() => {
      const where = this.stage.compare();
      untracked(() => {
        if (where === null) {
          this.target.set(null);
          return;
        }
        if (this.target()?.stepId === where.stepId) return;
        // Cleared first: the old answer is about the row they have just left, and
        // drawing it under the new row's name for one frame would be the column
        // lying about which step it is showing.
        this.target.set(null);
        void this.resolve(where.projectDir, where.stepId);
      });
    });
  }

  private async resolve(projectDir: string, stepId: string): Promise<void> {
    if (!api) return;
    let path: string | null = null;
    try {
      path = await api.ledger.documentAtStep(projectDir, stepId);
    } catch {
      /*
       * A REFUSAL IS DRAWN AS THE SHEET, not as a sentence on the strip. The only
       * thing that rejects here is the directory gate, which cannot fire for a
       * project this window has open — and if it somehow does, `book:load-at`
       * refuses the same way and puts its sentence on the compare column's own
       * paper, where somebody looking at the column will actually read it.
       */
      path = null;
    }
    // The comparison may have moved (or ended) while main was answering. `compare`
    // holds the newest wish, so identity against it is the whole test.
    if (this.stage.compare()?.stepId !== stepId) return;
    this.target.set({ stepId, path });
  }

  /** The row's own label, as the ledger stored it — the picker offered this string. */
  protected readonly label = computed<string>(() => {
    const where = this.stage.compare();
    if (where === null) return '';
    const history = this.ledger.historyFor(where.projectDir);
    const step = history?.ledger.steps.find((one) => one.id === where.stepId) ?? null;
    return step?.label ?? 'that step';
  });

  /**
   * A TAB THAT IS NOT IN THE LIST, and saying so plainly is the point.
   *
   * `app-book-view` and `app-pdf-view` both take a `Tab`, because every other
   * caller has one: a viewer is drawn for a document the window has open. This
   * column is not a document — it is a second view of a book that is already open,
   * with no place in the library, no ✕ of its own in that list, no closing question
   * and no place in the order. So it is handed a SYNTHETIC tab: the shape the
   * viewers need, made out of what the comparison already knows.
   *
   * THE ID IS FIXED AND CANNOT COLLIDE. Real ids are `tab-<n>` (`blankTab`), so
   * `compare` is a name no document in the list can wear — which matters because
   * ids key the book-stack registry, and a compare column that registered under a
   * real tab's id would answer the inspector's panels for a book nobody is editing.
   * (It registers nothing anyway: `atStep` turns that off in the viewer.)
   *
   * `viewOnly` IS NOT SET HERE, deliberately, and the difference is worth stating.
   * That flag means "this tab IS a finished export" — a file on disk, opened
   * through `book:view`. This column is the project's own book at an earlier row,
   * read through `book:load-at`. Both end up read-only, and they get there by two
   * different doors; conflating them would send this column's load down the export
   * path and open the wrong file entirely.
   */
  protected readonly bookTab = computed<Tab>(() => ({
    ...SYNTHETIC,
    kind: 'book',
    path: this.stage.compare()?.projectDir ?? '',
    title: this.label(),
  }));

  /**
   * The same, for a step whose picture is a file.
   *
   * A FUNCTION AND NOT A COMPUTED because the path arrives on the resolve rather
   * than off the comparison, and the template already has it in hand — a computed
   * would have to reach back into `target()` and reproduce the null check the
   * template just made.
   *
   * BOTH VIEW MODES ARE OFF. `layerView` and `thumbnails` live on the tab and are
   * toggled through the documents list by id; this tab has no entry there, so the
   * toggles would write nowhere. `readOnly` on the viewer hides them rather than
   * leaving two dead buttons, and the pages, the zoom and the page counter — which
   * are what somebody comparing a scan actually wants — all stay.
   */
  protected pdfTab(path: string): Tab {
    return { ...SYNTHETIC, kind: 'pdf', path, title: this.label() };
  }
}

/**
 * The fields a synthetic tab has to carry to satisfy `Tab`, all of them the
 * quietest answer available: nothing is unsaved, nothing is modified, nothing has
 * been filed anywhere, and there is no problem to report. A compare column wears
 * no marks because it makes no claims — every one of these flags is about a
 * document's relationship to the disk, and this is a view rather than a document.
 */
const SYNTHETIC = {
  id: 'compare',
  named: true,
  unsaved: false,
  modified: false,
  savedPath: null,
  layerView: false,
  thumbnails: false,
  revision: 0,
  problem: null,
} as const;
