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
 * because these are the picker's words for the stages and not part of the
 * contract with main. `none` is the one that has to be spelled out: "before Get
 * Text" is a boundary rather than a stage, and "reset to none" reads as doing
 * nothing at all.
 */
export const DOCUMENT_STAGE_LABELS: Record<ResetTarget, string> = {
  none: 'before Get Text',
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
 * does to a detected book are choose blocks, say what they are, and fix the
 * chapter titles. Detect sits above the tabs rather than inside one: it is not a
 * way of curating, it is the thing that throws curation away and reads the pages
 * again, and it takes the one confirmation that says so.
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
    <div class="nav-head">
      <button
        type="button"
        class="detect-btn"
        [disabled]="!hasDocument() || !!stageRunning()"
        [title]="detectTooltip()"
        (click)="detect.emit()"
      >
        <span class="detect-icon">◳</span>
        <span class="detect-label">Detect blocks</span>
      </button>

      @if (stageRunning(); as stage) {
        <div class="stage-line">
          <span class="stage-spinner"></span>
          <span class="stage-name">{{ stage }}</span>
          <button type="button" class="stage-cancel" (click)="cancelStage.emit()">Stop</button>
        </div>
        <!-- The stage's own words, verbatim. Summarizing them here would leave
             the one place a person can see what it is actually doing empty. -->
        @if (stageMessage()) {
          <pre class="stage-message">{{ stageMessage() }}</pre>
        }
      }

      <!-- Said once, where the work was asked for. There is no persistent error
           state: a failed stage wrote nothing and deleted its own scratch, so
           asking for it again is the whole recovery. -->
      @if (lastError(); as failure) {
        <div class="nav-error">
          <span class="nav-error-title">That did not run</span>
          <pre class="nav-error-message">{{ failure }}</pre>
        </div>
      }
    </div>

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
            >Merge {{ selectedBlockIds().length >= 2 ? selectedBlockIds().length : '' }}</button>
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
            IS the chapter's title in the book.
          </p>
          @for (block of chapterBlocks(); track block.id) {
            <div class="chapter-row" [class.editing]="editingId() === block.id">
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
                <button
                  type="button"
                  class="chapter-title"
                  (click)="chapterClick.emit(block.id)"
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
          [disabled]="!hasDocument() || !!stageRunning()"
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
          [disabled]="!hasDocument() || !!stageRunning()"
          (click)="resetTo.emit(resetTarget())"
        >Reset</button>
      </div>
      @if (!hasDocument()) {
        <p class="tab-empty">
          This book has no working document, so there is nothing to detect into or
          reset. Open it as a project to curate it.
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

    .detect-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-sm);
      width: 100%;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
    }

    .detect-btn:hover:not(:disabled) { background: var(--accent-hover); }
    .detect-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .stage-line {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .stage-spinner {
      width: 10px;
      height: 10px;
      border: 2px solid var(--border-subtle);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: nav-spin 0.8s linear infinite;
    }

    @keyframes nav-spin { to { transform: rotate(360deg); } }

    .stage-name { flex: 1; }

    .stage-cancel {
      background: none;
      border: 1px solid var(--border-default);
      border-radius: 3px;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: var(--ui-font-xs);
      padding: 0 6px;
    }

    .stage-message,
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
  readonly stageRunning = input.required<string | null>();
  readonly stageMessage = input.required<string>();
  readonly lastError = input.required<string | null>();
  /** False for a book that has no working document — a corpus book, a loose file. */
  readonly hasDocument = input.required<boolean>();
  /**
   * Which tab is open. Owned by the shell rather than here, because the Label
   * tab is also a POINTER mode — the viewer's click means something different
   * while it is open — and the left rail offers it too. One value, so the rail,
   * the pointer and the tab strip cannot say three different things.
   */
  readonly tab = input.required<DocumentNavTab>();

  readonly detect = output<void>();
  readonly cancelStage = output<void>();
  readonly selectCategory = output<string>();
  readonly assignCategory = output<string>();
  readonly selectAll = output<void>();
  readonly deselectAll = output<void>();
  readonly merge = output<void>();
  readonly chapterClick = output<string>();
  readonly retitle = output<{ blockId: string; title: string }>();
  readonly resetTo = output<ResetTarget>();
  readonly tabChange = output<DocumentNavTab>();

  /** The chapter block whose title is being typed into, or null. */
  private readonly editing = signal<string | null>(null);
  readonly editingId = this.editing.asReadonly();
  readonly draftTitle = signal('');

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
   * that always exists. "Before Get Text" needs no boundary — it is a re-copy of
   * the archive primary — so it is offered whenever there is a document at all.
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

  detectTooltip(): string {
    if (!this.hasDocument()) {
      return 'This book has no working document to detect into.';
    }
    const running = this.stageRunning();
    if (running) return `${running} is running.`;
    return 'Read the pages again and replace every block with what they say.';
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
    if (!this.hasDocument()) return 'Merging is an edit to the working document, and there is none.';
    const refusal = this.mergeRefusal();
    if (refusal) return refusal;
    return `Merge ${this.selectedBlockIds().length} blocks into one.`;
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
