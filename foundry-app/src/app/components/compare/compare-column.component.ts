import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';

import { BookViewComponent } from '../book-view/book-view.component';
import { PdfViewComponent } from '../pdf-view/pdf-view.component';
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
 */
@Component({
  selector: 'app-compare-column',
  imports: [BookViewComponent, PdfViewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      THE COLUMN NAMES ITSELF, which the live one does not have to. A second view
      with no label is two books side by side and no way to tell which is which —
      and the label is the ledger's own, the same string the picker offered.
    -->
    <header class="head">
      <span class="tag">Comparing</span>
      <span class="name" [title]="label()">{{ label() }}</span>
      <button
        type="button"
        class="x"
        title="Stop comparing"
        aria-label="Stop comparing"
        (click)="stage.stopCompare()"
      >✕</button>
    </header>

    @if (target(); as where) {
      @if (where.path !== null) {
        <!--
          \`@defer\`, FOR \`app-viewer\`'S REASON AND NOT AS A COPY OF ITS HABIT.
          pdf.js is half a megabyte and the window boots on Home, which has no
          document on it at all; the live viewer keeps the engine in a chunk of
          its own for exactly that, and a compare column that imported it
          EAGERLY would drag the whole thing back into the initial bundle and
          undo the split for the entire app. "on immediate" because by the time
          this block exists somebody has already asked to see a scan.

          The chunk is fetched once and instantiated per viewer, so a comparison
          of two PDFs costs one download between them.
        -->
        @defer (on immediate) {
          <app-pdf-view [tab]="pdfTab(where.path)" [readOnly]="true" />
        } @placeholder {
          <div class="waiting"></div>
        }
      } @else {
        <app-book-view [tab]="bookTab()" [atStep]="where.stepId" />
      }
    } @else {
      <!-- The resolve is one IPC and lands in a frame or two; a spinner for that
           would flash. The silence is deliberate and matches the viewer's own
           placeholder. -->
      <div class="waiting"></div>
    }
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
      height: 100%;
      overflow: hidden;
      background: var(--bg-sunken);
    }

    /*
      A QUIET BAR, NOT A TAB STRIP. It is one row, it names one thing and it has
      one verb — deliberately nothing that could be mistaken for the chrome the
      columns used to carry.
    */
    .head {
      flex: 0 0 auto;
      display: flex; align-items: center; gap: 8px;
      padding: 6px 8px 6px 10px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
    }
    .tag {
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--accent);
    }
    .name {
      flex: 1; min-width: 0;
      font-size: 11.5px; color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* ALWAYS VISIBLE, unlike the library's row ✕. That one is one of many on a
       list and appears on hover; this is the only way out of a mode, and a way
       out that has to be discovered by hovering is a mode people feel stuck in. */
    .x {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    app-book-view, app-pdf-view { flex: 1; min-height: 0; }
    .waiting { flex: 1; min-height: 0; background: var(--bg-sunken); }
  `],
})
export class CompareColumnComponent {
  protected readonly stage = inject(StageService);
  private readonly ledger = inject(LedgerService);

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
