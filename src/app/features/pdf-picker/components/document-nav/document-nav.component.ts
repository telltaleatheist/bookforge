import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { BLOCK_CATEGORIES } from '@shared/ocr/block-categories';
import type { TextBlock } from '@shared/ocr/text-block';
import type { DocumentPipelineState, ResetTarget } from '@shared/document/pipeline-types';
import { mergeRefusal } from '@shared/document/block-merge';

/**
 * What each reset target is called in front of the user.
 *
 * Declared beside the control that offers them rather than in the wire types,
 * because these are the picker's words and not part of the contract with main.
 * `none` is the one that has to be spelled out: it is the working copy as it was
 * minted — a fresh copy of the archive original — and "reset to none" reads as
 * doing nothing at all.
 *
 * The other three are the Tesseract-era stages, which no longer run. They are
 * still listed because a working document minted before Aug 2026 carries their
 * recorded boundaries and a reset to one of them is still an exact truncate.
 */
export const DOCUMENT_STAGE_LABELS: Record<ResetTarget, string> = {
  none: 'the untouched copy',
  'get-text': 'Get Text',
  blocks: 'Detect blocks',
  footnotes: 'Footnotes',
};

/** The three things the nav can be showing. */
export type DocumentNavTab = 'select' | 'label' | 'chapter';

/**
 * The picker's right-side nav (docs/DOCUMENT_PIPELINE.md §"Picker UI").
 *
 * ONE mode — select — and three tabs over it, because the three things a person
 * does to a book are choose blocks, say what they are, and fix the chapter
 * titles. There is no Detect above them any more: the Tesseract stage that
 * relabelled every block went with its pipeline (Aug 2026), so the categories on
 * screen are the app's own analysis and the user's corrections to it.
 *
 * Every category swatch in both tabs comes from the ONE palette
 * (`shared/ocr/block-categories.ts`). A block has one category field, so
 * selecting by category and labelling by category are the same field read and
 * written — there is no second map for a colour or a selection to disagree with.
 *
 * Purely presentational: it holds which tab is open and which chapter title is
 * being typed into, and nothing else. Every act is an output, because the shell
 * is what owns the document.
 */
@Component({
  selector: 'app-document-nav',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Said once, where the work was asked for. A refused curation edit is
         re-read from the document, so the message here IS the whole recovery. -->
    @if (lastError(); as failure) {
      <div class="nav-head">
        <div class="nav-error">
          <span class="nav-error-title">That did not land</span>
          <pre class="nav-error-message">{{ failure }}</pre>
        </div>
      </div>
    }

    <div class="tab-strip" role="tablist">
      @for (entry of TABS; track entry.id) {
        <button
          type="button"
          role="tab"
          class="tab-btn"
          [class.active]="tab() === entry.id"
          [attr.aria-selected]="tab() === entry.id"
          (click)="tabChange.emit(entry.id)"
        >{{ entry.label }}</button>
      }
    </div>

    <div class="tab-body">
      @switch (tab()) {
        @case ('select') {
          <p class="tab-hint">
            Click a category to select every block of it. Double-click a block on the
            page to do the same from there.
          </p>
          @for (row of categoryRows(); track row.id) {
            <button
              type="button"
              class="cat-row"
              [disabled]="row.count === 0"
              (click)="selectCategory.emit(row.id)"
            >
              <span class="cat-swatch" [style.background]="row.color"></span>
              <span class="cat-name">{{ row.name }}</span>
              <span class="cat-count">{{ row.count }}</span>
            </button>
          }

          <div class="tab-actions">
            <button type="button" class="action-btn" (click)="selectAll.emit()">Select all</button>
            <button
              type="button"
              class="action-btn"
              [disabled]="selectedBlockIds().length === 0"
              (click)="deselectAll.emit()"
            >Deselect</button>
            <!-- Merge is the "the system thinks it's two blocks but it isn't"
                 correction, so it is only ever offered on blocks the reader
                 would have read one after the other — see mergeRefusal. -->
            <button
              type="button"
              class="action-btn"
              [disabled]="!hasDocument() || mergeRefusal() !== null"
              [title]="mergeTooltip()"
              (click)="merge.emit()"
            >{{ selectedBlockIds().length >= 2 ? 'Merge ' + selectedBlockIds().length : 'Merge' }}</button>
          </div>
        }

        @case ('label') {
          <p class="tab-hint">
            Click a block, then click what it is. The category is the block's one
            field — the colour on the page, the Select tab and the book all read it.
          </p>
          @for (row of categoryRows(); track row.id) {
            <button
              type="button"
              class="cat-row"
              [disabled]="selectedBlockIds().length === 0"
              (click)="assignCategory.emit(row.id)"
            >
              <span class="cat-swatch" [style.background]="row.color"></span>
              <span class="cat-name">{{ row.name }}</span>
              <span class="cat-desc">{{ row.description }}</span>
            </button>
          }
          @if (selectedBlockIds().length === 0) {
            <p class="tab-empty">Nothing is selected, so there is nothing to label yet.</p>
          }
        }

        @case ('chapter') {
          <p class="tab-hint">
            Every block labelled a chapter opening, in reading order. The text here
            IS the chapter's title in the book — double-click one to retype it.
            Ctrl/⌘-click or shift-click to pick several, then Merge.
          </p>
          @for (block of chapterBlocks(); track block.id) {
            <div
              class="chapter-row"
              [class.editing]="editingId() === block.id"
              [class.selected]="isSelected(block.id)"
            >
              @if (editingId() === block.id) {
                <input
                  class="chapter-input"
                  type="text"
                  [value]="draftTitle()"
                  (input)="draftTitle.set($any($event.target).value)"
                  (keydown.enter)="commitTitle(block)"
                  (keydown.escape)="cancelTitle()"
                  (blur)="commitTitle(block)"
                />
              } @else {
                <!--
                  A single click selects (the shell's ONE selection, the same one
                  the page overlay paints), and a double-click opens the title
                  for typing. The pencil stays: it is the discoverable way in,
                  and a double-click is the fast one.
                -->
                <button
                  type="button"
                  class="chapter-title"
                  (click)="onRowClick(block, $event)"
                  (dblclick)="startEditing(block)"
                >{{ block.text.trim() || '(no title)' }}</button>
                <span class="chapter-page">p{{ block.page + 1 }}</span>
                <button
                  type="button"
                  class="chapter-pencil"
                  title="Edit this chapter's title"
                  (click)="startEditing(block)"
                >✎</button>
              }
            </div>
          }
          @if (chapterBlocks().length === 0) {
            <p class="tab-empty">
              No block is labelled a chapter opening. Label one in the Label tab and it
              appears here.
            </p>
          }

          <!--
            The SAME merge as the Select tab's, judged by the SAME rule and
            landed down the same service call. A scan that broke one heading
            across two boxes is the case this exists for, and it is discovered
            here — reading the chapter list — far more often than on the page.
          -->
          <div class="tab-actions">
            <button
              type="button"
              class="action-btn"
              [disabled]="!hasDocument() || mergeRefusal() !== null"
              [title]="mergeTooltip()"
              (click)="merge.emit()"
            >{{ selectedBlockIds().length >= 2 ? 'Merge ' + selectedBlockIds().length : 'Merge' }}</button>
          </div>
        }
      }
    </div>

    <!--
      The one user-facing affordance the working documents power. Every stage
      completion is a byte offset in an append-only file, so this is a truncate:
      an exact restoration, not a re-run.
    -->
    <div class="nav-foot">
      <label class="reset-label" for="reset-target">Reset to</label>
      <div class="reset-row">
        <select
          id="reset-target"
          class="reset-select"
          [disabled]="!hasDocument()"
          [value]="resetTarget()"
          (change)="resetTarget.set($any($event.target).value)"
        >
          @for (target of resetTargets(); track target) {
            <option [value]="target">{{ labelFor(target) }}</option>
          }
        </select>
        <button
          type="button"
          class="action-btn"
          [disabled]="!hasDocument()"
          (click)="resetTo.emit(resetTarget())"
        >Reset</button>
      </div>
      @if (!hasDocument()) {
        <p class="tab-empty">
          This book has no working copy, so there is nothing to reset. Create one
          from the versions page to curate it.
        </p>
      }
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
      background: var(--bg-sidebar);
    }

    .nav-head {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
    }

    .nav-error-message {
      margin: 0;
      max-height: 8em;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: $font-mono;
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .nav-error {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: var(--ui-spacing-sm);
      border: 1px solid var(--warning);
      border-radius: 4px;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
    }

    .nav-error-title {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      color: var(--warning);
    }

    .tab-strip {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
    }

    .tab-btn {
      flex: 1;
      padding: var(--ui-spacing-sm);
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: var(--ui-font-sm);
    }

    .tab-btn.active {
      color: var(--text-primary);
      border-bottom-color: var(--accent);
    }

    .tab-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-md);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .tab-hint,
    .tab-empty {
      margin: 0 0 var(--ui-spacing-sm);
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      line-height: 1.4;
    }

    .cat-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      width: 100%;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: none;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
    }

    .cat-row:hover:not(:disabled) { background: var(--bg-hover); }
    .cat-row:disabled { opacity: 0.4; cursor: not-allowed; }

    .cat-swatch {
      flex-shrink: 0;
      width: 12px;
      height: 12px;
      border-radius: 3px;
    }

    .cat-name { flex: 1; }

    .cat-count,
    .cat-desc,
    .chapter-page {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .cat-desc {
      flex: 2;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tab-actions {
      display: flex;
      gap: var(--ui-spacing-xs);
      margin-top: var(--ui-spacing-md);
    }

    .action-btn {
      flex: 1;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      color: var(--text-primary);
      cursor: pointer;
      font-size: var(--ui-font-xs);
    }

    .action-btn:hover:not(:disabled) { background: var(--bg-hover); }
    .action-btn:disabled { opacity: 0.4; cursor: not-allowed; }

    .chapter-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      padding: 2px var(--ui-spacing-xs);
      border-radius: 4px;
    }

    .chapter-row:hover { background: var(--bg-hover); }

    .chapter-row.selected {
      background: color-mix(in srgb, var(--accent) 22%, transparent);
      box-shadow: inset 2px 0 0 var(--accent);
    }

    .chapter-title {
      flex: 1;
      background: none;
      border: none;
      padding: 0;
      text-align: left;
      color: var(--text-primary);
      cursor: pointer;
      font-size: var(--ui-font-sm);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The pencil is what opens title editing, so it only appears on the row the
       pointer is on — a column of them would read as the list's own decoration. */
    .chapter-pencil {
      opacity: 0;
      background: none;
      border: none;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .chapter-row:hover .chapter-pencil { opacity: 1; }

    .chapter-input {
      flex: 1;
      padding: 2px var(--ui-spacing-xs);
      background: var(--bg-input);
      border: 1px solid var(--border-accent);
      border-radius: 3px;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
    }

    .nav-foot {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-md);
      border-top: 1px solid var(--border-subtle);
    }

    .reset-label {
      font-size: var(--ui-font-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
    }

    .reset-row {
      display: flex;
      gap: var(--ui-spacing-xs);
    }

    .reset-select {
      flex: 1;
      padding: var(--ui-spacing-xs);
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: 4px;
      color: var(--text-primary);
      font-size: var(--ui-font-xs);
    }
  `],
})
export class DocumentNavComponent {
  /** Every live block, for the per-category counts the Select tab shows. */
  readonly blocks = input.required<readonly TextBlock[]>();
  readonly selectedBlockIds = input.required<readonly string[]>();
  readonly chapterBlocks = input.required<readonly TextBlock[]>();
  /** Null until a working document has been read for this book. */
  readonly state = input.required<DocumentPipelineState | null>();
  readonly lastError = input.required<string | null>();
  /** False for a book that has no working copy — an archive original, a loose file. */
  readonly hasDocument = input.required<boolean>();
  /**
   * Which tab is open. Owned by the shell rather than here, because the Label
   * tab is also a POINTER mode — the viewer's click means something different
   * while it is open — and the left rail offers it too. One value, so the rail,
   * the pointer and the tab strip cannot say three different things.
   */
  readonly tab = input.required<DocumentNavTab>();

  readonly selectCategory = output<string>();
  readonly assignCategory = output<string>();
  readonly selectAll = output<void>();
  readonly deselectAll = output<void>();
  readonly merge = output<void>();
  /**
   * A chapter row was chosen. The ids are what the selection should BECOME when
   * `additive` is false, and what to add to it when it is true.
   *
   * The list is resolved here rather than in the shell because a shift-click
   * means "everything between", and "between" is an order — this component's
   * order, the chapter list as it is drawn. Emitting the modifier and letting
   * the shell re-derive the range would be a second copy of that order.
   */
  readonly chapterClick = output<{ blockIds: string[]; additive: boolean }>();
  readonly retitle = output<{ blockId: string; title: string }>();
  readonly resetTo = output<ResetTarget>();
  readonly tabChange = output<DocumentNavTab>();

  /** The chapter block whose title is being typed into, or null. */
  private readonly editing = signal<string | null>(null);
  readonly editingId = this.editing.asReadonly();
  readonly draftTitle = signal('');

  /**
   * The chapter row a shift-click measures from: the last one clicked without
   * shift. Null before the first click in this list, which is why a shift-click
   * with no anchor selects only the row it landed on rather than guessing at
   * one end of the book.
   */
  private rangeAnchor: string | null = null;

  readonly TABS: readonly { id: DocumentNavTab; label: string }[] = [
    { id: 'select', label: 'Select' },
    { id: 'label', label: 'Label' },
    { id: 'chapter', label: 'Chapter' },
  ];

  /**
   * The thirteen, with this book's counts.
   *
   * The whole contract is listed rather than only the classes present, because
   * both tabs are places you go to ASK for a class: a Label tab that omitted
   * `chapter` until something was already a chapter could never make the first
   * one.
   */
  readonly categoryRows = computed(() => {
    const counts = new Map<string, number>();
    for (const block of this.blocks()) {
      counts.set(block.category_id, (counts.get(block.category_id) ?? 0) + 1);
    }
    return BLOCK_CATEGORIES.map(def => ({
      id: def.id,
      name: def.name,
      description: def.description,
      color: def.color,
      count: counts.get(def.id) ?? 0,
    }));
  });

  /**
   * Where a reset can land: the stages with a recorded boundary, plus the one
   * that always exists. "The untouched copy" needs no boundary — it is a re-copy
   * of the archive primary — so it is offered whenever there is a document.
   */
  readonly resetTargets = computed<ResetTarget[]>(() => {
    const recorded = this.state()?.resetTargets ?? [];
    return [...recorded, 'none'];
  });

  /** The target the Reset button will act on. */
  readonly resetTarget = signal<ResetTarget>('none');

  labelFor(target: ResetTarget): string {
    return DOCUMENT_STAGE_LABELS[target];
  }

  /**
   * The selection, judged by the one merge rule. Null when it would be taken.
   *
   * Computed rather than a method so the disabled state and the tooltip read the
   * same answer instead of asking twice.
   */
  readonly mergeRefusal = computed<string | null>(() => {
    const chosen = new Set(this.selectedBlockIds());
    return mergeRefusal(this.blocks().filter(b => chosen.has(b.id)));
  });

  mergeTooltip(): string {
    if (!this.hasDocument()) return 'Merging is an edit to the working copy, and there is none.';
    const refusal = this.mergeRefusal();
    if (refusal) return refusal;
    return `Merge ${this.selectedBlockIds().length} blocks into one.`;
  }

  isSelected(blockId: string): boolean {
    return this.selectedBlockIds().includes(blockId);
  }

  /**
   * A click on a chapter row, with the modifiers a list has always had.
   *
   * Plain click replaces the selection with this row. Ctrl/⌘ adds it (the shell
   * toggles, exactly as it does for a block on the page). Shift takes everything
   * between the anchor and here, in the list's own order.
   */
  onRowClick(block: TextBlock, event: MouseEvent): void {
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && this.rangeAnchor !== null) {
      const list = this.chapterBlocks();
      const from = list.findIndex(b => b.id === this.rangeAnchor);
      const to = list.findIndex(b => b.id === block.id);
      // An anchor the list no longer carries — its block was relabelled away
      // from `chapter` since the click — is not a range. Fall to the plain
      // single-row answer rather than inventing an end for it.
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        this.chapterClick.emit({
          blockIds: list.slice(lo, hi + 1).map(b => b.id),
          additive: false,
        });
        return;
      }
    }
    if (!event.shiftKey) this.rangeAnchor = block.id;
    this.chapterClick.emit({ blockIds: [block.id], additive });
  }

  startEditing(block: TextBlock): void {
    this.editing.set(block.id);
    this.draftTitle.set(block.text.trim());
  }

  cancelTitle(): void {
    this.editing.set(null);
  }

  /**
   * Land the typed title, or say nothing if it is unchanged.
   *
   * An empty title is refused by leaving the row alone rather than by writing
   * one: a chapter with no words is a heading the book cannot navigate to, and
   * the way to say "this is not a chapter" is to relabel the block.
   */
  commitTitle(block: TextBlock): void {
    if (this.editing() !== block.id) return;
    this.editing.set(null);
    const title = this.draftTitle().trim();
    if (title.length === 0 || title === block.text.trim()) return;
    this.retitle.emit({ blockId: block.id, title });
  }
}
