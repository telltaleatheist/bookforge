/**
 * Training tab — the training corpus, listed from disk.
 *
 * The corpus master is `~/Documents/BookForge/training/<slug>/`, one directory
 * per book, and it is deliberately OUTSIDE the library: these books are
 * measurement material for the page-layout model, not audiobook projects. So
 * this tab talks only to the `training:*` IPC (electron/corpus-book.ts) and
 * never to manifests, Studio or the queue.
 *
 * Everything shown here is read from the files each time. There is no cache to
 * go stale, which is the point — what this tab shows is what is on disk, and
 * the counts are what tells you which book to work on next.
 */

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  ToolbarComponent,
  ToolbarItem,
  DesktopButtonComponent
} from '../../creamsicle-desktop';
import { ElectronService, TrainingBookSummary } from '../../core/services/electron.service';

/** A book plus the derived bits the row needs, so the template stays flat. */
interface TrainingRow {
  book: TrainingBookSummary;
  /** 0-100. Blocks carrying a hand label, over blocks in the snapshot. */
  percent: number;
  /** What to do with this book next — the row's headline, not decoration. */
  stateLabel: string;
  /** Drives the state pill's colour class. */
  tone: 'problem' | 'todo' | 'partial' | 'done';
}

@Component({
  selector: 'app-training',
  standalone: true,
  imports: [CommonModule, ToolbarComponent, DesktopButtonComponent],
  template: `
    <desktop-toolbar
      [items]="toolbarItems()"
      (itemClicked)="onToolbarAction($event)"
    >
    </desktop-toolbar>

    <div class="training-container">
      <!-- A failed list is NOT an empty corpus, and must never be drawn as one:
           the whole value of this tab is that it reports what is actually there. -->
      @if (listError(); as err) {
        <div class="banner error" role="alert">
          <span class="banner-title">The training corpus could not be read</span>
          <span class="banner-detail">{{ err }}</span>
        </div>
      }

      <!-- Partial failure from a multi-select add: some PDFs became books, some
           didn't. The successful ones are already in the list below, so this is
           the only place the rejected ones are ever named. -->
      @if (addError(); as err) {
        <div class="banner warning" role="alert">
          <span class="banner-title">Some files were not added</span>
          <span class="banner-detail">{{ err }}</span>
        </div>
      }

      @if (openError(); as err) {
        <div class="banner error" role="alert">
          <span class="banner-title">That book did not open</span>
          <span class="banner-detail">{{ err }}</span>
        </div>
      }

      @if (loading()) {
        <div class="empty-state">
          <p>Reading {{ corpusPath }}…</p>
        </div>
      } @else if (rows().length > 0) {
        <div class="summary">
          <span>{{ rows().length }} book{{ rows().length === 1 ? '' : 's' }}</span>
          @if (problemCount() > 0) {
            <span class="summary-problem">{{ problemCount() }} need attention</span>
          }
          <span class="summary-labelled">{{ totalLabelled() }} of {{ totalBlocks() }} blocks labelled</span>
        </div>

        <div class="book-list">
          @for (row of rows(); track row.book.dir) {
            <div
              class="book"
              [class.has-problem]="!!row.book.problem"
              [attr.role]="row.book.problem ? null : 'button'"
              [attr.tabindex]="row.book.problem ? null : 0"
              (click)="openBook(row.book)"
              (keydown.enter)="openBook(row.book)"
              (keydown.space)="openBook(row.book)"
            >
              <div class="book-head">
                <span class="book-title">{{ row.book.title }}</span>
                <span class="state-pill" [class]="'state-pill tone-' + row.tone">{{ row.stateLabel }}</span>
              </div>

              @if (row.book.problem) {
                <!-- A book that cannot be opened is exactly what you came here to
                     find, so it gets the row's body rather than a tooltip. -->
                <div class="problem">{{ row.book.problem }}</div>
              } @else {
                <div class="counts">
                  <span class="count"><strong>{{ row.book.pages }}</strong> pages</span>
                  <span class="count"><strong>{{ row.book.blocks }}</strong> blocks</span>
                  <span class="count">
                    <strong>{{ row.book.labelled }}</strong> of {{ row.book.blocks }} labelled
                  </span>
                  @if (row.book.savedAt) {
                    <span class="count muted">saved {{ row.book.savedAt | date:'MMM d, y, h:mm a' }}</span>
                  }
                </div>

                <div class="progress-track" [attr.aria-label]="row.percent + '% labelled'">
                  <div class="progress-fill" [class]="'progress-fill tone-' + row.tone" [style.width.%]="row.percent"></div>
                </div>
              }

              <!-- The PDF is referenced in place, so where it lives is part of the
                   book's identity — and the first thing to check when one breaks. -->
              <div class="book-path">{{ row.book.pdfPath ?? row.book.dir }}</div>
            </div>
          }
        </div>
      } @else if (!listError()) {
        <div class="empty-state">
          <div class="empty-icon">&#128218;</div>
          <h2>No training books yet</h2>
          <p>
            Training books live in <code>{{ corpusPath }}</code>, one folder per book —
            outside the library, because they are measurement material for the page-layout
            model rather than audiobook projects.
          </p>
          <p class="hint">
            <strong>Add PDF…</strong> records a reference to a file where it already sits.
            Nothing is copied and nothing is imported, so a corpus of hundreds of scans
            costs one small JSON file each.
          </p>
          <desktop-button variant="primary" size="md" [loading]="adding()" (click)="addPdf()">
            Add PDF…
          </desktop-button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
    }

    .training-container {
      flex: 1;
      overflow-y: auto;
      padding: 1rem;
      background: var(--bg-base);
    }

    .banner {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding: 0.75rem 1rem;
      margin-bottom: 1rem;
      border-radius: 8px;
      border: 1px solid var(--border-default);
      font-size: 0.8125rem;

      &.error {
        background: var(--error-bg);
        border-color: var(--error);
        color: var(--error-text);
      }

      &.warning {
        background: var(--warning-bg);
        border-color: var(--warning);
        color: var(--warning-text);
      }
    }

    .banner-title {
      font-weight: 600;
    }

    .banner-detail {
      white-space: pre-wrap;
      font-family: var(--font-mono, monospace);
      font-size: 0.75rem;
      opacity: 0.9;
    }

    .summary {
      display: flex;
      gap: 1rem;
      align-items: baseline;
      padding: 0 0.25rem 0.75rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    .summary-problem {
      color: var(--error);
      font-weight: 600;
    }

    .summary-labelled {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }

    .book-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .book {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      background: var(--bg-elevated);
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-accent);
      }

      &:focus-visible {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
      }

      // A book that cannot be opened does not pretend it can be clicked.
      &.has-problem {
        cursor: default;
        border-color: var(--error);

        &:hover {
          background: var(--bg-elevated);
          border-color: var(--error);
        }
      }
    }

    .book-head {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }

    .book-title {
      flex: 1;
      min-width: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .state-pill {
      flex: none;
      padding: 0.125rem 0.5rem;
      border-radius: 10px;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--bg-sunken);
      color: var(--text-secondary);

      &.tone-problem { background: var(--error-bg); color: var(--error-text); }
      &.tone-todo { background: var(--info-bg); color: var(--info-text); }
      &.tone-partial { background: var(--warning-bg); color: var(--warning-text); }
      &.tone-done { background: var(--success-bg); color: var(--success-text); }
    }

    .counts {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      font-size: 0.75rem;
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .count strong {
      color: var(--text-primary);
      font-weight: 600;
    }

    .count.muted {
      margin-left: auto;
      color: var(--text-muted);
    }

    .progress-track {
      height: 4px;
      border-radius: 2px;
      background: var(--bg-sunken);
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      transition: width 0.3s ease;
      background: var(--accent);

      &.tone-todo { background: var(--info); }
      &.tone-partial { background: var(--warning); }
      &.tone-done { background: var(--success); }
    }

    .problem {
      font-size: 0.75rem;
      color: var(--error-text);
      white-space: pre-wrap;
    }

    .book-path {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-family: var(--font-mono, monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;   // keep the filename visible when the path is too long
      text-align: left;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      padding: 2rem;
      color: var(--text-secondary);
    }

    .empty-icon {
      font-size: 3rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .empty-state h2 {
      margin: 0 0 0.5rem 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .empty-state p {
      margin: 0 0 1rem 0;
      max-width: 460px;
      font-size: 0.875rem;
      line-height: 1.5;
    }

    .empty-state .hint {
      font-size: 0.8125rem;
      color: var(--text-muted);
    }

    .empty-state code {
      font-family: var(--font-mono, monospace);
      font-size: 0.8125rem;
      color: var(--text-primary);
    }
  `]
})
export default class TrainingComponent implements OnInit {
  private readonly electronService = inject(ElectronService);

  /** Named in the empty state and the loading line — the one place the corpus lives. */
  readonly corpusPath = '~/Documents/BookForge/training/';

  readonly books = signal<TrainingBookSummary[]>([]);
  readonly loading = signal(true);
  readonly adding = signal(false);

  /** Why the list is missing, when it is. Never collapsed into "no books". */
  readonly listError = signal<string | null>(null);
  /** Files a multi-select add rejected. Cleared at the start of the next add. */
  readonly addError = signal<string | null>(null);
  /**
   * Why the last attempt to open a book failed.
   *
   * Its own signal rather than sharing `addError`: the two are reported under
   * different headings, and a failed open shown under "Some files were not
   * added" would send someone looking for a problem with the wrong book.
   */
  readonly openError = signal<string | null>(null);

  /**
   * Sorted by how much work the book still needs, most first, then title.
   *
   * The corpus is a to-do list, so the order is the order you would work it:
   * broken books first (they are invisible failures — a moved PDF looks like a
   * healthy book until you click it), then added-but-not-OCR'd, then OCR'd and
   * unlabelled, then part-labelled, and finished books last. Finished books are
   * the ones you have no reason to open, so they are the ones that get scrolled
   * past. Title breaks ties so a book keeps a findable position between refreshes.
   */
  readonly rows = computed<TrainingRow[]>(() =>
    this.books()
      .map(book => this.toRow(book))
      .sort((a, b) =>
        this.rank(a) - this.rank(b) ||
        a.book.title.localeCompare(b.book.title)
      )
  );

  readonly problemCount = computed(() => this.books().filter(b => !!b.problem).length);
  readonly totalBlocks = computed(() => this.books().reduce((sum, b) => sum + b.blocks, 0));
  readonly totalLabelled = computed(() => this.books().reduce((sum, b) => sum + b.labelled, 0));

  readonly toolbarItems = computed<ToolbarItem[]>(() => [
    {
      id: 'add',
      type: 'button',
      icon: '+',
      label: 'Add PDF…',
      tooltip: 'Reference a PDF where it already sits — nothing is copied or imported',
      disabled: this.adding()
    },
    {
      id: 'refresh',
      type: 'button',
      icon: '↻',
      label: 'Refresh',
      tooltip: 'Re-read the corpus from disk',
      disabled: this.loading()
    },
    { id: 'spacer', type: 'spacer' }
  ]);

  ngOnInit(): void {
    void this.refresh();
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      case 'add':
        void this.addPdf();
        break;
      case 'refresh':
        void this.refresh();
        break;
    }
  }

  async refresh(): Promise<void> {
    this.loading.set(true);
    // try/finally, because `ipcRenderer.invoke` REJECTS when the channel is not
    // registered — which is exactly what a running app looks like after the main
    // process has been rebuilt but not restarted. Without this the rejection is
    // unhandled, `loading` never clears, and the tab sits on "Reading …" forever:
    // a hang that looks like slowness instead of the plain error it is.
    let result: Awaited<ReturnType<ElectronService['trainingList']>>;
    try {
      result = await this.electronService.trainingList();
    } catch (err) {
      this.listError.set(
        `${(err as Error)?.message ?? err}\n\n` +
        'If the app was running while this feature was built, its main process ' +
        'does not have the training handlers yet — restart it.'
      );
      return;
    } finally {
      this.loading.set(false);
    }

    if (!result.success) {
      // Keep whatever is already on screen: the previous list is still the last
      // thing known to be true, and blanking it would hide the books as well as
      // the error.
      this.listError.set(result.error ?? 'training:list failed without saying why.');
      return;
    }
    this.listError.set(null);
    this.books.set(result.books ?? []);
  }

  /**
   * Add PDFs to the corpus. Main owns the dialog (that is where Electron's is),
   * so this only has to interpret what comes back.
   */
  async addPdf(): Promise<void> {
    this.adding.set(true);
    this.addError.set(null);
    let result: Awaited<ReturnType<ElectronService['trainingAdd']>>;
    try {
      result = await this.electronService.trainingAdd();
    } catch (err) {
      // Same unregistered-channel case as refresh(); leaving the button spinning
      // would be the worst of both worlds.
      this.addError.set(String((err as Error)?.message ?? err));
      return;
    } finally {
      this.adding.set(false);
    }

    if (!result.success) {
      this.addError.set(result.error ?? 'training:add failed without saying why.');
      return;
    }
    // `error` alongside a successful result means a multi-select was partly
    // rejected — the books that did get made are real and are listed below.
    if (result.error) this.addError.set(result.error);
    // An empty books array with no error is a cancelled dialog: nothing to say.
    await this.refresh();
  }

  async openBook(book: TrainingBookSummary): Promise<void> {
    if (book.problem) return;
    this.openError.set(null);
    const result = await this.electronService.trainingOpen(book.dir);
    if (!result.success) {
      this.openError.set(`${book.title} did not open: ${result.error ?? 'no reason given.'}`);
    }
  }

  private toRow(book: TrainingBookSummary): TrainingRow {
    const percent = book.blocks > 0
      ? Math.round((book.labelled / book.blocks) * 100)
      : 0;

    if (book.problem) {
      return { book, percent, stateLabel: 'Problem', tone: 'problem' };
    }
    switch (book.state) {
      case 'added':
        // book.json only: the PDF is known, nothing has been recognized from it.
        return { book, percent, stateLabel: 'Needs OCR', tone: 'todo' };
      case 'ocr':
        return { book, percent, stateLabel: 'Needs labels', tone: 'todo' };
      case 'labelled':
        return percent >= 100
          ? { book, percent, stateLabel: 'Labelled', tone: 'done' }
          : { book, percent, stateLabel: 'In progress', tone: 'partial' };
    }
  }

  /** Work-remaining order — see `rows` for why this is the order it is. */
  private rank(row: TrainingRow): number {
    if (row.tone === 'problem') return 0;
    if (row.book.state === 'added') return 1;
    if (row.book.state === 'ocr') return 2;
    return row.tone === 'partial' ? 3 : 4;
  }
}
