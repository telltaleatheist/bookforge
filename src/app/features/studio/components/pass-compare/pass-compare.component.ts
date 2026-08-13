/**
 * The book before a pass and the book after it, side by side, as real pages.
 *
 * ── What Owen asked for (2026-08-12) ────────────────────────────────────────
 *
 * "i wonder if review changes could pull up the epubs before/after in pdf
 * picker side-by-side". The frozen diff beside it is text: it can say which
 * words moved and nothing about what the page now looks like. This shows the
 * two books themselves, through the picker's own viewer — the publisher's
 * typesetting, the figures, the chapter openings — which is the only way to see
 * what a pass did to a BOOK rather than to a string.
 *
 * It is also the first review affordance TRANSLATE has ever had. A translate
 * pass deliberately freezes no diff (a word-diff of a translation is a wall of
 * red and green that says nothing), so its Review changes button has always
 * been drawn disabled. Its snapshots exist like every other pass's, so this
 * surface works for it exactly as it works for the rest.
 *
 * ── READ-ONLY, and that is the whole reason this can exist ──────────────────
 *
 * A ledger entry's snapshot is a RECORD. The Open button was deliberately
 * removed from ledger lines because opening one bound the project to a document
 * whose edits the picker could not vouch for and left the session writable,
 * which destroyed an evening of working changes (the block comment on the
 * ledger line in shared/document/book-chain.ts). Nothing here reverses that:
 *
 *  - the two books are opened through `quire:open-book`, which takes a PATH and
 *    knows nothing of projects, families or manifests. No working copy is
 *    minted, no manifest record is written, no editor state is saved and the
 *    session is bound to neither file;
 *  - both viewers are mounted `readOnly`, so neither pane draws a single act;
 *  - the handles are closed when this component goes away, and again by the
 *    app's quit chain (`closeAllBooksForViewer`). An open book owns an offscreen
 *    window and a session partition until it is closed, and on Windows it holds
 *    the file — a leak here would be felt as an export that cannot land.
 *
 * ── Independent panes, deliberately ─────────────────────────────────────────
 *
 * Each pane scrolls on its own. A pass that adds or removes text re-paginates
 * the book, so page 40 of the before-book and page 40 of the after-book are not
 * the same place, and a linked scroll would be a claim this surface cannot
 * make. Zoom and presentation ARE shared, because those are how the two are
 * made comparable rather than a claim about where anything is. (A percent-based
 * sync toggle is future work, and it will still be a guess.)
 */
import {
  ChangeDetectionStrategy, Component, OnDestroy, computed, effect, inject, input, signal,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import type { LaidOutBook } from '@shared/document/laid-out-book';
import { BLOCK_CATEGORIES, toCategory } from '@shared/ocr/block-categories';
import { ElectronService } from '../../../../core/services/electron.service';
import type { Category } from '../../../pdf-picker/services/pdf.service';
import {
  EpubViewerComponent, type EpubViewerSource,
} from '../../../pdf-picker/components/epub-viewer/epub-viewer.component';

/** One side of the comparison, as `book:compare-pass` resolved it. */
export interface ComparedBookView {
  /** The book on disk — a zipped `.epub` or an exploded working copy. */
  absPath: string;
  /** What this book IS: a pass's name, or the chain's source named as itself. */
  label: string;
}

/** A pane's book, once the main process has opened and laid it out. */
interface OpenedPane {
  handle: string;
  book: LaidOutBook;
  source: EpubViewerSource;
  pages: number;
}

/** What a pane is doing. Each state is a fact, never a guess. */
type PaneState =
  | { kind: 'opening' }
  | { kind: 'ready'; opened: OpenedPane }
  /** The main process said why, in a sentence, and this shows that sentence. */
  | { kind: 'refused'; why: string };

@Component({
  selector: 'app-pass-compare',
  standalone: true,
  imports: [CommonModule, EpubViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="compare">
      <div class="controls">
        <span class="hint">Read only — nothing here changes either book.</span>
        <span class="spacer"></span>
        <label class="control">Show
          <select [value]="presentation()"
                  (change)="presentation.set($any($event.target).value)">
            <option value="vertical">Pages</option>
            <option value="flow">Flowing text</option>
          </select>
        </label>
        <label class="control">Zoom
          <button type="button" (click)="zoomBy(-10)" title="Smaller">−</button>
          <span class="zoom">{{ zoom() }}%</span>
          <button type="button" (click)="zoomBy(10)" title="Bigger">+</button>
        </label>
      </div>

      <div class="panes">
        @for (pane of panes(); track pane.side) {
          <section class="pane">
            <header class="pane-head">
              <span class="side">{{ pane.side === 'before' ? 'Before' : 'After' }}</span>
              <span class="what">{{ pane.book.label }}</span>
              @if (pane.state.kind === 'ready') {
                <span class="pages">{{ pane.state.opened.pages }} pages</span>
              }
            </header>
            @switch (pane.state.kind) {
              @case ('opening') {
                <div class="pane-status">Opening {{ pane.book.label }}…</div>
              }
              @case ('refused') {
                <div class="pane-status refused">{{ asRefused(pane.state) }}</div>
              }
              @default {
                <app-epub-viewer
                  [book]="asReady(pane.state).opened.book"
                  [source]="asReady(pane.state).opened.source"
                  [categories]="categories()"
                  [hiddenCategoryIds]="nothingHidden"
                  [selectedBlockIds]="nothingSelected"
                  [deletedBlockIds]="nothingStruck"
                  [zoom]="zoom()"
                  [layout]="presentation()"
                  [readOnly]="true"
                />
              }
            }
          </section>
        }
      </div>
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; }

    .compare { display: flex; flex-direction: column; flex: 1; min-height: 0; }

    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .hint { color: var(--text-tertiary); }
    .spacer { flex: 1; }
    .control { display: inline-flex; align-items: center; gap: 4px; }
    .zoom { min-width: 44px; text-align: center; }

    .controls button, .controls select {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
      border-radius: 4px;
      padding: 2px 8px;
      font-size: var(--ui-font-xs);
      cursor: pointer;
    }

    .panes {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      flex: 1;
      min-height: 0;
      padding: 10px;
    }

    .pane {
      display: flex;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      overflow: hidden;
      background: var(--bg-sunken);
    }

    .pane-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      padding: 6px 10px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      font-size: var(--ui-font-xs);
    }

    .side { font-weight: 600; color: var(--text-primary); }
    .what { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pages { margin-left: auto; color: var(--text-tertiary); }

    .pane-status {
      margin: 16px;
      padding: 12px;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      white-space: pre-wrap;
    }

    .pane-status.refused { color: var(--text-primary); border-color: var(--color-danger); }
  `],
})
export class PassCompareComponent implements OnDestroy {
  private readonly electron = inject(ElectronService);

  /** The book the pass RAN ON. */
  readonly before = input.required<ComparedBookView>();
  /** The book the pass LEFT. */
  readonly after = input.required<ComparedBookView>();

  protected readonly zoom = signal(70);
  protected readonly presentation = signal<'vertical' | 'flow'>('vertical');

  private readonly beforeState = signal<PaneState>({ kind: 'opening' });
  private readonly afterState = signal<PaneState>({ kind: 'opening' });

  /**
   * Which opening the answers coming back belong to.
   *
   * The inputs can change while two `quire:open-book` calls are in flight, and a
   * late answer from the previous pair would mount a book this surface is no
   * longer showing — under the other book's heading. Every answer is checked
   * against the generation that asked for it, and a stale one is closed rather
   * than dropped: it owns an offscreen window either way.
   */
  private generation = 0;

  /** The one palette, exactly as the picker hands it to the viewer. */
  protected readonly categories = computed<Record<string, Category>>(() => {
    const out: Record<string, Category> = {};
    for (const def of BLOCK_CATEGORIES) out[def.id] = toCategory(def);
    return out;
  });

  // Frozen empties, one instance each: the viewer's marks are inputs, and this
  // surface has no marks to give it. New sets per change detection would be new
  // references every tick, which is work for nothing.
  protected readonly nothingHidden: ReadonlySet<string> = new Set<string>();
  protected readonly nothingStruck: ReadonlySet<string> = new Set<string>();
  protected readonly nothingSelected: readonly string[] = [];

  protected readonly panes = computed(() => [
    { side: 'before' as const, book: this.before(), state: this.beforeState() },
    { side: 'after' as const, book: this.after(), state: this.afterState() },
  ]);

  constructor() {
    // WHICH TWO BOOKS is the only thing this watches. The opening itself reads
    // and writes the pane states, and doing that inside the tracking context
    // would make the effect depend on its own output — one opened book, one
    // state write, one re-run, forever.
    effect(() => {
      const before = this.before();
      const after = this.after();
      untracked(() => { void this.openBoth(before, after); });
    });
  }

  ngOnDestroy(): void {
    // The surface is going away, so the books it opened must too — before the
    // component's own state is gone, which is the only place their handles are
    // written down. The generation bump makes any answer still in flight close
    // itself on arrival instead of leaving a book open with nobody holding it.
    this.generation++;
    void this.closeOpened();
  }

  /**
   * Open both books, one after the other.
   *
   * Sequentially, not in parallel: each open lays a whole book out in an
   * offscreen window, and two of those competing for the same CPU makes both
   * slower than doing them in turn — while the BEFORE pane, which is the one the
   * user reads first, appears in half the time.
   */
  private async openBoth(before: ComparedBookView, after: ComparedBookView): Promise<void> {
    const mine = ++this.generation;
    await this.closeOpened();
    this.beforeState.set({ kind: 'opening' });
    this.afterState.set({ kind: 'opening' });

    const left = await this.openOne(before, mine);
    if (left !== null) this.beforeState.set(left);
    const right = await this.openOne(after, mine);
    if (right !== null) this.afterState.set(right);
  }

  /**
   * One book, opened. `null` means this answer belongs to a compare that has
   * been replaced — its book is closed here and the caller records nothing.
   */
  private async openOne(book: ComparedBookView, mine: number): Promise<PaneState | null> {
    try {
      const result = await this.electron.quireOpenBook(book.absPath);
      if (!result.success || !result.data) {
        if (mine !== this.generation) return null;
        return {
          kind: 'refused',
          why: result.error
            ?? `The main process refused ${book.label} without saying why.`,
        };
      }
      const opening = result.data as {
        handle: string; book: LaidOutBook; source: EpubViewerSource;
        stats: { pages: number };
      };
      if (mine !== this.generation) {
        await this.electron.quireCloseBook(opening.handle);
        return null;
      }
      return {
        kind: 'ready',
        opened: {
          handle: opening.handle,
          book: opening.book,
          source: opening.source,
          pages: opening.stats.pages,
        },
      };
    } catch (err) {
      if (mine !== this.generation) return null;
      return { kind: 'refused', why: String((err as Error).message ?? err) };
    }
  }

  /** Close whichever of the two panes is holding an open book. */
  private async closeOpened(): Promise<void> {
    for (const state of [this.beforeState(), this.afterState()]) {
      if (state.kind !== 'ready') continue;
      await this.electron.quireCloseBook(state.opened.handle);
    }
    this.beforeState.set({ kind: 'opening' });
    this.afterState.set({ kind: 'opening' });
  }

  protected zoomBy(delta: number): void {
    this.zoom.set(Math.max(25, Math.min(400, Math.round(this.zoom() + delta))));
  }

  // The template's two narrowings. Angular's @switch does not narrow the union
  // for the branch it selected, so each branch says which shape it is standing
  // in — the same device `epub-viewer.component.ts` uses for its band states.
  protected asRefused(state: PaneState): string {
    return state.kind === 'refused' ? state.why : '';
  }

  protected asReady(state: PaneState): { opened: OpenedPane } {
    if (state.kind !== 'ready') {
      throw new Error(
        `[pass-compare] a pane was drawn as ready while it was ${state.kind}. The template and the `
        + 'state machine have gone out of step.');
    }
    return state;
  }
}
