import {
  ChangeDetectionStrategy, Component, ElementRef, computed, effect, input, output, signal,
  viewChild,
} from '@angular/core';
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
 * One row of the Chapter tab: a chapter of whatever is on screen, and how to
 * rename it.
 *
 * A ROW rather than a block, because the two books the picker shows answer
 * "what is this chapter called?" from different places and only one of them is
 * the block's own text:
 *
 *  - **A working PDF.** The chapter IS a `chapter` block, its annotation text is
 *    the title, and the two are one field — there is nothing to reconcile. The
 *    shell builds a row whose `title` is that text, so the single-authority rule
 *    is unchanged: the row is a view of the block, never a second copy of it.
 *  - **A converted book.** The chapter opening is a `chapter` block too (foundry
 *    stamps `data-bf-cat="chapter"` on the heading it split at), but the block's
 *    text is mupdf's rendering of the PRINTED page and cannot be edited — the
 *    book is not rewritten to say something the page did not. The title lives in
 *    the book's navigation, which is what an audiobook is built from, so `title`
 *    comes from there and a rename lands there.
 *  - **A book with no chapter blocks at all** — one converted before foundry
 *    stamped the class, or an EPUB from anywhere else. Its chapters are read out
 *    of its own navigation with no block behind them, so `blockId` is null:
 *    nothing on any page corresponds to the row, so it cannot be selected and
 *    there is no element key to rename it through.
 *
 * `title` is therefore always THE title, wherever that lives, and this component
 * never has to know which of the three cases it is drawing.
 */
export interface ChapterRow {
  /** Stable identity for tracking and for the range anchor. */
  id: string;
  /** What this chapter is called — see above for where that comes from. */
  title: string;
  /**
   * Zero-based page the opening sits on, or null when nothing on any page
   * corresponds to the row.
   *
   * Null is real for a document the book READS and does not NAME whose pages
   * carry no chapter-opening block: the row exists because the spine has the
   * document, and there is no block to say which page it starts on. A number
   * invented for it would scroll the reader somewhere the row is not.
   */
  page: number | null;
  /**
   * The block this row is a view of, or null when the row was read out of the
   * book's navigation and has no block on any page.
   *
   * This is what the row can be SELECTED by — the shell's one selection is a set
   * of block ids, and the page overlay paints it — so a row with none is inert
   * to a click rather than offering a gesture that quietly does nothing.
   */
  blockId: string | null;
  /**
   * Why this row's title cannot be retyped, in the user's words, or null when it
   * can be.
   *
   * SEPARATE from `blockId` because being selectable and being renameable are
   * genuinely different questions with different answers. A chapter block of a
   * converted book that the aligner could not place in the markup is on the page
   * and can be picked, but there is no chapter document to address a rename to; a
   * `chapter` block on an archive PDF with no working copy is the same shape of
   * answer for a different reason. The shell knows which case a row is and says
   * so here, so this component never has to guess — and a user who tries gets a
   * sentence instead of a pencil that does nothing.
   */
  readOnlyReason: string | null;
  /**
   * The document this row is a chapter of that the book's table of contents does
   * NOT name, or null for every row the contents already names.
   *
   * Two rows that look alike are two different edits: typing into a named row
   * REPLACES what the book says about that document, and typing into one of
   * these makes the book say anything about it at all for the first time. The
   * shell needs to know which, so the row carries it — and the row is drawn
   * differently, because a chapter the contents does not list is one the
   * audiobook will not announce and a reader cannot navigate to.
   */
  unlistedFile: string | null;
}

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
              [disabled]="!hasDocument() || mergeBlocked() !== null"
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
            Every chapter opening, in reading order — double-click one to retype
            its title, or × to say it is not a chapter. Ctrl/⌘-click or
            shift-click to pick several, then Merge. A row marked
            <em>not in the contents</em> is a chapter this book does not name:
            type a name and it is listed under it.
          </p>
          @for (row of chapterRows(); track row.id) {
            <div
              class="chapter-row"
              [class.editing]="editingId() === row.id"
              [class.unlisted]="row.unlistedFile !== null"
              [class.selected]="row.blockId !== null && isSelected(row.blockId)"
            >
              @if (editingId() === row.id) {
                <!--
                  The caret is put in here the moment this appears — see
                  focusEditor, and why an unfocused box was a deletion. Only one
                  row is ever open, so the query names one element.
                -->
                <input
                  #titleInput
                  class="chapter-input"
                  type="text"
                  [value]="draftTitle()"
                  (input)="draftTitle.set($any($event.target).value)"
                  (keydown.enter)="commitTitle(row)"
                  (keydown.escape)="cancelTitle()"
                  (blur)="commitTitle(row)"
                />
              } @else {
                <!--
                  A single click selects (the shell's ONE selection, the same one
                  the page overlay paints), and a double-click opens the title
                  for typing. The pencil stays: it is the discoverable way in,
                  and a double-click is the fast one.

                  A row whose title cannot be retyped says why on hover instead
                  of showing a pencil that does nothing.
                -->
                <button
                  type="button"
                  class="chapter-title"
                  [class.chapter-readonly]="row.readOnlyReason !== null"
                  [title]="rowTooltip(row)"
                  (click)="onRowClick(row, $event)"
                  (dblclick)="startEditing(row)"
                >{{ row.title || '(no title)' }}</button>
                @if (row.unlistedFile !== null) {
                  <!--
                    Said on the row and not only in a tooltip: a chapter the
                    contents does not list is one the audiobook will never
                    announce, and that is the whole reason to type a name here.
                  -->
                  <span class="chapter-unlisted">not in the contents</span>
                }
                @if (row.page !== null) {
                  <span class="chapter-page">p{{ row.page + 1 }}</span>
                }
                @if (row.readOnlyReason === null) {
                  <button
                    type="button"
                    class="chapter-pencil"
                    [title]="pencilTooltip(row)"
                    (click)="startEditing(row)"
                  >✎</button>
                }
                <!--
                  Offered on every row that has a block, INCLUDING the ones the
                  pencil refuses: whether a title can be retyped and whether the
                  heading is a chapter at all are different questions, and a
                  heading the book's contents does not list is the likeliest one
                  to be answered "no". A row read out of the navigation has no
                  block to relabel, so it gets nothing.
                -->
                @if (row.blockId !== null) {
                  <button
                    type="button"
                    class="chapter-dismiss"
                    title="Not a chapter — relabel as body text"
                    (click)="demoteRow(row)"
                  >×</button>
                }
              }
            </div>
          }
          @if (chapterRows().length === 0) {
            <p class="tab-empty">
              No block is labelled a chapter opening, and this book's navigation
              lists none either. Label one in the Label tab and it appears here.
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
              [disabled]="!hasDocument() || mergeBlocked() !== null"
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

    /* A chapter the book READS and does not NAME. Dimmed rather than hidden:
       the document is there and the audiobook will reach it, silently, under no
       title at all — which is exactly the state the user has to be able to see
       in order to fix it. */
    .chapter-row.unlisted .chapter-title { color: var(--text-secondary); }

    .chapter-unlisted {
      flex: none;
      font-size: var(--ui-font-xs);
      color: var(--warning);
      white-space: nowrap;
    }

    /* A row the book states but no block backs. Still legible — it IS one of the
       book's chapters — but visibly not a thing this list can act on. */
    .chapter-readonly {
      color: var(--text-secondary);
      cursor: default;
      font-style: italic;
    }

    /* The pencil is what opens title editing, so it only appears on the row the
       pointer is on — a column of them would read as the list's own decoration.
       The dismiss × rides with it: it is the same kind of thing (an act on THIS
       row) and it removes a row, which is not a gesture to leave sitting under
       an idle pointer. */
    .chapter-pencil,
    .chapter-dismiss {
      opacity: 0;
      background: none;
      border: none;
      padding: 0 2px;
      color: var(--text-secondary);
      cursor: pointer;
    }

    .chapter-row:hover .chapter-pencil,
    .chapter-row:hover .chapter-dismiss { opacity: 1; }

    .chapter-dismiss:hover { color: var(--warning); }

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
  /** The chapters of whatever is on screen, in reading order. See {@link ChapterRow}. */
  readonly chapterRows = input.required<readonly ChapterRow[]>();
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
  /**
   * A chapter was named. Two addresses, and a row carries exactly one of them.
   *
   * `blockId` is the block the row is a view of, which is how the shell knows
   * which chapter of which artifact this is — the only address a working PDF's
   * chapters have, and the one a listed book chapter is renamed through.
   * `unlistedFile` is the document the book READS and does not NAME, which has
   * no entry to rename and is LISTED under the typed name instead. Both are
   * emitted so the shell can tell the two edits apart without re-deriving the
   * row's case, and a row with neither is never editable in the first place.
   */
  readonly retitle = output<{
    blockId: string | null; unlistedFile: string | null; title: string;
  }>();
  /**
   * A chapter row was dismissed: this block is not a chapter opening.
   *
   * Says only WHICH block, not what to make it. The class that means "ordinary
   * prose" is the palette's answer and the shell's to name — see
   * `BODY_CATEGORY` — and this component draws rows, it does not hold opinions
   * about the thirteen.
   */
  readonly demote = output<{ blockId: string }>();
  readonly resetTo = output<ResetTarget>();
  readonly tabChange = output<DocumentNavTab>();

  /** The chapter block whose title is being typed into, or null. */
  private readonly editing = signal<string | null>(null);
  readonly editingId = this.editing.asReadonly();
  readonly draftTitle = signal('');

  /** The open title box, while one is open. See {@link focusEditor}. */
  private readonly titleInput = viewChild<ElementRef<HTMLInputElement>>('titleInput');

  /**
   * Put the caret in the box the double-click just opened.
   *
   * NOT a nicety. The double-click replaces the row's `<button>` with this
   * `<input>`, and the button is what had focus — so removing it drops focus to
   * the document body, and every keystroke that follows goes to the WINDOW.
   * The picker's window-level shortcuts are there, and Backspace among them
   * means "strike the selection", which the same double-click had just made
   * this chapter (Owen, 2026-08-10: "i hit backspace to erase part of it. it
   * marked the item as deleted"). A rename that types into nothing and deletes
   * the row instead is what an unfocused editor IS.
   *
   * The caret goes to the END rather than selecting the whole title: this box is
   * opened to correct a name far more often than to replace one, and select-all
   * would make that same first Backspace erase all of it.
   *
   * Guarded on `activeElement` so a re-render while the user is typing — a
   * chapter list that reordered, a category count that changed — cannot yank the
   * caret back to the end of the box mid-word.
   */
  private readonly focusEditor = effect(() => {
    const box = this.titleInput();
    if (box === undefined) return;
    const el = box.nativeElement;
    if (el.ownerDocument.activeElement === el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

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

  /**
   * Why merging is off for reasons this panel cannot see.
   *
   * `mergeRefusal` above is about the SELECTION — are these blocks adjacent, on
   * one page, in reading order — which is all this component knows. Whether the
   * DOCUMENT can be merged into at all is the picker's question: an EPUB's
   * blocks are the book's own elements and there is no working PDF to join two
   * boxes in. Passed in rather than re-derived, so there is one answer and the
   * button is disabled by it instead of accepting the click and then refusing.
   */
  readonly documentMergeRefusal = input<string | null>(null);

  /** Either reason, selection-level first — the one the user can act on. */
  readonly mergeBlocked = computed<string | null>(() =>
    this.documentMergeRefusal() ?? this.mergeRefusal());

  mergeTooltip(): string {
    if (!this.hasDocument()) return 'Merging is an edit to the working copy, and there is none.';
    const refusal = this.mergeBlocked();
    if (refusal) return refusal;
    return `Merge ${this.selectedBlockIds().length} blocks into one.`;
  }

  isSelected(blockId: string): boolean {
    return this.selectedBlockIds().includes(blockId);
  }

  /** What the pencil does on this row — retype a name, or give the book one. */
  pencilTooltip(row: ChapterRow): string {
    return row.unlistedFile === null
      ? 'Edit this chapter\'s title'
      : 'Name this chapter and list it in the contents';
  }

  /** Why a row cannot be retyped, or the plain "which chapter is this". */
  rowTooltip(row: ChapterRow): string {
    const reason = row.readOnlyReason;
    if (reason !== null) return `${row.title} — ${reason}`;
    if (row.unlistedFile !== null) {
      return `${row.title} — this book's table of contents does not list `
        + `${row.unlistedFile}, so an audiobook would reach this chapter under no name at all. `
        + 'Type one and it is listed under it.';
    }
    return row.title;
  }

  /**
   * A click on a chapter row, with the modifiers a list has always had.
   *
   * Plain click replaces the selection with this row. Ctrl/⌘ adds it (the shell
   * toggles, exactly as it does for a block on the page). Shift takes everything
   * between the anchor and here, in the list's own order.
   *
   * Rows with no block behind them are inert AND are skipped inside a shift
   * range: a selection is a set of block ids, and a range that quietly stopped at
   * the first navigation-only row would select a different span than the one the
   * user dragged over.
   */
  onRowClick(row: ChapterRow, event: MouseEvent): void {
    if (row.blockId === null) return;
    const blockId = row.blockId;
    const additive = event.metaKey || event.ctrlKey;
    if (event.shiftKey && this.rangeAnchor !== null) {
      const list = this.chapterRows();
      const from = list.findIndex(r => r.id === this.rangeAnchor);
      const to = list.findIndex(r => r.id === row.id);
      // An anchor the list no longer carries — its block was relabelled away
      // from `chapter` since the click — is not a range. Fall to the plain
      // single-row answer rather than inventing an end for it.
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        this.chapterClick.emit({
          blockIds: list.slice(lo, hi + 1)
            .map(r => r.blockId)
            .filter((id): id is string => id !== null),
          additive: false,
        });
        return;
      }
    }
    if (!event.shiftKey) this.rangeAnchor = row.id;
    this.chapterClick.emit({ blockIds: [blockId], additive });
  }

  /**
   * "This is not a chapter."
   *
   * Closes the title editor if this row was open in it, because the block is
   * about to stop being a chapter and a committed title would be typed into a
   * row that no longer exists.
   */
  demoteRow(row: ChapterRow): void {
    if (row.blockId === null) return;
    if (this.editing() === row.id) this.editing.set(null);
    this.demote.emit({ blockId: row.blockId });
  }

  startEditing(row: ChapterRow): void {
    // The shell already said why this one cannot be retyped, and the row shows
    // it on hover — see ChapterRow.readOnlyReason. A row with neither a block
    // nor an unlisted document behind it has no address to name anything at.
    if (row.readOnlyReason !== null) return;
    if (row.blockId === null && row.unlistedFile === null) return;
    this.editing.set(row.id);
    // The box opens on the row's OWN words — for a chapter the contents does not
    // name, that is the heading printed on the page, which is very nearly always
    // the name the user is about to type.
    this.draftTitle.set(row.title);
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
   *
   * "Unchanged" is one thing for a chapter the book names and another for one it
   * does not. A named row that comes back with the name it already had is a
   * no-op. An UNLISTED row's title is the heading printed on the page, and
   * confirming it unchanged is the user saying "list it under exactly that" —
   * which is a real edit and the likeliest one they meant.
   */
  commitTitle(row: ChapterRow): void {
    if (this.editing() !== row.id) return;
    this.editing.set(null);
    if (row.blockId === null && row.unlistedFile === null) return;
    const title = this.draftTitle().trim();
    if (title.length === 0) return;
    if (row.unlistedFile === null && title === row.title) return;
    this.retitle.emit({ blockId: row.blockId, unlistedFile: row.unlistedFile, title });
  }
}
