import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * One row of the chapter rail: somewhere in the book to jump to, and whether
 * that chapter is struck out of the narration.
 *
 * Flatter than the Chapter tab's {@link ChapterRow} on purpose. The rail is a
 * navigation column — every row HAS a page, or it would not be here — and the
 * only other thing it says is what the strike toggle needs. The shell derives it
 * (`railChapterRows`), so this component never asks the book anything.
 */
export interface ChapterRailRow {
  /** Stable identity for tracking. */
  id: string;
  /** What this chapter is called, in the book's own words. */
  title: string;
  /** Zero-based page the chapter opens on — where a click lands. */
  page: number;
  /**
   * Every block of this chapter's document is struck out of the narration.
   *
   * PAINTED on the row and read by the toggle, from the one derivation
   * (`narrationStruckDocuments` in the shell), so the strike-through the user
   * sees and the direction the × goes can never be two different answers.
   */
  struck: boolean;
  /**
   * The spine document (zip entry) this row's × strikes, or null when this row
   * is not offered one.
   *
   * Null covers three states that are all "there is no whole-document gesture
   * here": a chapter with no document at all (a working PDF's chapters, a row
   * read out of the navigation), and a row that is a chapter of a document some
   * OTHER row opens — a heading labelled mid-chapter, which is a split the next
   * build will make and not a document of its own yet. Such a row is still
   * painted struck when its document is, because that is true of the chapter;
   * what it is not offered is the act.
   */
  strikeFile: string | null;
}

/**
 * The book's chapters, beside the viewer.
 *
 * This is the EPUB's navigation column — the page timeline it replaces is a
 * raster affordance and is not rendered for a book at all. It is NAVIGATION
 * FIRST: a row is a destination, the whole chapter name is on it (rows wrap;
 * an ellipsis on the one thing the rail exists to show would be absurd), and
 * the click target for jumping is the row's own title button.
 *
 * The one act it offers is the strike toggle (Owen, 2026-08-12: "give me the
 * ability to strike out entire chapters… maybe an X next to the chapter on the
 * left nav bar. i wont need a bunch of indexes, for example"). It is a SIBLING
 * of the title button, never a wrapper around it, so it cannot swallow the
 * click that jumps.
 *
 * ── Why this is not the Chapter tab's × ───────────────────────────────────
 *
 * The Chapter tab's × means DEMOTE: "this heading is not a chapter, relabel it
 * as body text". That is an edit to what the book says about itself. This one
 * means STRIKE: "do not read this chapter aloud", which changes nothing about
 * the book at all. Two ×s that mean different things on one row would be a
 * trap, so they are kept on different surfaces, drawn with different glyphs
 * (`✕`/`↺` here, `×` there), and their tooltips say which act is which in
 * words. The Chapter tab is deliberately NOT given a strike toggle.
 *
 * Purely presentational: it holds nothing, and both gestures are outputs.
 */
@Component({
  selector: 'app-chapter-rail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="chapter-rail-header">Chapters</div>
    <div class="chapter-rail-list">
      @for (row of rows(); track row.id) {
        <!--
          The refusal rides on the ROW as well as on the button, because a
          disabled button does not always take the pointer and its own tooltip
          can go unread. Absent entirely while striking is allowed, so an idle
          hover over a chapter says nothing.
        -->
        <div
          class="chapter-rail-row"
          [class.struck]="row.struck"
          [attr.title]="strikeRefusal()"
        >
          <button
            type="button"
            class="chapter-rail-item"
            [title]="'Page ' + (row.page + 1)"
            (click)="jump.emit(row.page)"
          >{{ row.title }}</button>
          @if (row.strikeFile !== null) {
            <!--
              Hidden until the pointer is on the row while the chapter is being
              READ — the rail is a navigation column, and a permanent column of
              ×s would read as its decoration. A STRUCK chapter's toggle is
              always visible: the strike-through says something was done, and
              the only way back is this button, which must not be something the
              user has to discover by hovering.
            -->
            <button
              type="button"
              class="chapter-rail-strike"
              [class.on]="row.struck"
              [disabled]="strikeRefusal() !== null"
              [attr.aria-pressed]="row.struck"
              [title]="strikeTooltip(row)"
              (click)="strikeToggle.emit(row.strikeFile)"
            >{{ row.struck ? '↺' : '✕' }}</button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      width: 230px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-surface);
      border-right: 1px solid var(--border-subtle);
    }

    .chapter-rail-header {
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      border-bottom: 1px solid var(--border-subtle);
    }

    .chapter-rail-list {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: var(--ui-spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .chapter-rail-row {
      display: flex;
      align-items: flex-start;
      gap: 2px;
      border-radius: 6px;
    }

    .chapter-rail-row:hover { background: var(--bg-elevated); }

    /* Rows wrap — the whole point is the WHOLE chapter name, never an ellipsis. */
    .chapter-rail-item {
      flex: 1;
      min-width: 0;
      text-align: left;
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      font-size: var(--ui-font-sm);
      line-height: 1.35;
      color: var(--text-secondary);
      background: none;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
    }

    .chapter-rail-row:hover .chapter-rail-item { color: var(--text-primary); }

    /* A chapter struck out of the narration. Dimmed AND struck through: the
       chapter is still in the book and still on the page — this row says only
       that it will not be read aloud — so it stays legible and stays where it
       is, because it is also the handle for bringing it back. */
    .chapter-rail-row.struck .chapter-rail-item {
      color: var(--text-tertiary);
      text-decoration: line-through;
    }

    .chapter-rail-strike {
      flex: none;
      align-self: center;
      opacity: 0;
      padding: 0 var(--ui-spacing-xs);
      background: none;
      border: 0;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: var(--ui-font-sm);
      line-height: 1.35;
    }

    .chapter-rail-row:hover .chapter-rail-strike,
    .chapter-rail-strike.on,
    .chapter-rail-strike:focus-visible { opacity: 1; }

    .chapter-rail-strike:hover:not(:disabled) { color: var(--warning); }

    /* Shown wherever it would be shown, dimmed: a gesture that is refused right
       now is still a gesture this row has, and hiding it would leave a struck
       chapter looking like one nothing can be done about. */
    .chapter-rail-row:hover .chapter-rail-strike:disabled,
    .chapter-rail-strike.on:disabled { opacity: 0.4; }

    .chapter-rail-strike:disabled { cursor: not-allowed; }
  `],
})
export class ChapterRailComponent {
  /** The chapters of the book on screen, in reading order. */
  readonly rows = input.required<readonly ChapterRailRow[]>();
  /**
   * Why nothing here may be struck right now, or null when it may be.
   *
   * The SHELL's standing sentence (`curationReadOnlyReason`) — the same words
   * the banner above the viewer is already showing, and the same answer every
   * other curation gesture is refused by. Said here rather than re-worded, so
   * the refusal and the reason cannot drift apart.
   */
  readonly strikeRefusal = input.required<string | null>();

  /** Take the reader to this zero-based page. */
  readonly jump = output<number>();
  /** Strike this spine document out of the narration, or put it back. */
  readonly strikeToggle = output<string>();

  /** What the × will do to this chapter, in the words of the act. */
  strikeTooltip(row: ChapterRailRow): string {
    const refusal = this.strikeRefusal();
    if (refusal !== null) return refusal;
    return row.struck
      ? 'Bring this chapter back into the narration'
      : 'Strike this whole chapter out of the narration — nothing is deleted from the book';
  }
}
