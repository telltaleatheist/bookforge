import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { labelFor } from '@shared/ledger';
import type { LedgerStep } from '@shared/types';

import { OpenDocumentsService } from '../../core/documents.service';
import { LedgerService } from '../../core/ledger.service';
import { StageService } from '../../core/stage.service';

/**
 * THE ANALYSIS CONTROL — a button, and the report it opens onto.
 *
 * ── The same two halves Compare has, aimed at a different kind of row ───────
 *
 * `ComparePickerComponent` is the model, deliberately and down to the menu's
 * pixels: a button, a scrim, a fixed menu of the ledger's own rows, and a click
 * that sets one step id on the stage. Everything else about the panel — where the
 * column goes, what it draws, when it ends — belongs to the workspace and to
 * `StageService.secondColumn`.
 *
 * WHAT DIFFERS IS WHICH ROWS IT OFFERS, and it is the whole of the difference. A
 * comparison can be against any step of the book, because every step is a state
 * of the book. An analysis panel can only be pointed at an ANALYSIS step, because
 * what it draws is that step's payload — the report. So the list is filtered to
 * `action === 'analysis'`, and a project that has never been analysed draws no
 * button at all rather than a button whose menu is empty.
 *
 * THE STANDING ROW IS NOT EXCLUDED HERE, where Compare excludes it. Comparing the
 * position against itself would draw the same book twice, which is a feature that
 * looks broken; standing ON an analysis step and opening its report is the most
 * ordinary thing somebody can do with one — the pointer does not even move onto
 * these rows (`RETAINED_BESIDE_YOU`), so "the analysis you are standing on" is
 * usually not a thing that has happened.
 *
 * NEWEST FIRST, which is the other departure and the one that is about reading
 * rather than about rules. Compare offers the ledger's own order untouched
 * because a comparison is made against a place in a history. A report is a
 * MEASUREMENT, and the one somebody wants is nearly always the last one made —
 * the same reason a queue draws its newest rows at the top.
 */
@Component({
  selector: 'app-analysis-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (choices().length > 0) {
      <button
        type="button"
        class="act"
        [class.on]="stage.analysis() !== null"
        title="Show what an analysis of this book found, beside the page"
        (click)="open($event)"
      >Analysis</button>
    }

    <!--
      THE APP'S ONE CONTEXT-MENU IDIOM: a full-window scrim under a fixed menu, so
      the next click anywhere dismisses it exactly once and cannot also land on
      whatever was underneath. The library's own vocabulary, to the pixel — there
      is one of these in this app and a second would be a second thing to learn.
    -->
    @if (at(); as where) {
      <div class="menu-scrim" (click)="at.set(null)" (contextmenu)="at.set(null)"></div>
      <div
        class="menu"
        role="menu"
        aria-label="Choose an analysis to show"
        [style.left.px]="where.x"
        [style.top.px]="where.y"
        (keydown.escape)="at.set(null)"
      >
        <span class="lbl">show the report from</span>
        @for (step of choices(); track step.id) {
          <button role="menuitem" (click)="choose(step)">{{ named(step) }}</button>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }

    /*
      THE HOST'S OWN BUTTON SHAPE, copied from \`app-compare-picker\` because the
      two stand side by side in the same head row and a control that arrived
      wearing its own idea of a button would read as something bolted on.
    */
    .act {
      display: inline-flex; align-items: center;
      height: 22px; padding: 0 9px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 11px; line-height: 1;
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .act:hover { color: var(--text-primary); border-color: var(--border-strong); }
    /* Lit while the panel is up, because the button is also the reminder that the
       second column is somebody's own doing rather than the app's. */
    .act.on {
      background: var(--accent-faint);
      border-color: var(--accent-strong);
      color: var(--accent);
    }

    /* Above the panels and below the dialogs; the scrim is what makes the next
       click dismiss it exactly once. The library's menu, to the pixel. */
    .menu-scrim { position: fixed; inset: 0; z-index: 1000; }
    .menu {
      position: fixed;
      z-index: 1001;
      min-width: 200px;
      max-height: 60vh;
      overflow-y: auto;
      padding: 4px;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.35);
    }
    .menu .lbl {
      padding: 4px 10px 6px;
      font-family: var(--font-mono);
      font-size: 8.5px; font-weight: 600;
      letter-spacing: 0.12em; text-transform: uppercase;
      color: var(--text-tertiary);
    }
    .menu button {
      display: block; width: 100%;
      padding: 6px 10px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px; text-align: left; cursor: pointer;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
})
export class AnalysisPickerComponent {
  protected readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly ledger = inject(LedgerService);

  /** Where the menu was asked for, or null while it is shut. */
  protected readonly at = signal<{ x: number; y: number } | null>(null);

  /**
   * The project of the document in front of the person, or null — the STAGE's
   * answer and not the host's, `ComparePickerComponent`'s rule: this control is
   * about what is on screen, and there is exactly one of those.
   */
  private readonly projectDir = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    return tab === null ? null : this.documents.projectDirOf(tab);
  });

  /** Every analysis this book has, newest first. See the class docblock. */
  protected readonly choices = computed<readonly LedgerStep[]>(() => {
    const dir = this.projectDir();
    if (dir === null) return NO_STEPS;
    const history = this.ledger.historyFor(dir);
    if (history === null) return NO_STEPS;
    return history.ledger.steps.filter((step) => step.action === 'analysis').reverse();
  });

  /**
   * WHAT A ROW IS CALLED IN THIS MENU — the label the step was stamped with, or
   * the one this build would give it.
   *
   * `LedgerStep.label` IS STORED AND NOT DERIVED (shared/ledger.ts says so at
   * length), so an analysis row from an older build carries whatever it was
   * called then and that is deliberately not rewritten. What this adds is the
   * fallback for a row whose label is empty, which `labelFor` answers off the same
   * params the tree reads — one function, so the menu and the tree can never call
   * one row two things.
   */
  protected named(step: LedgerStep): string {
    return step.label.trim().length > 0 ? step.label : labelFor(step.action, step.params);
  }

  /**
   * Open the menu under the button — `ComparePickerComponent.open`, verbatim, and
   * its two reasons transfer: `stopPropagation` because the head row this sits in
   * is inside the viewer and a press that also landed there would be one gesture
   * doing two things, and the box rather than the pointer because a menu raised by
   * a button belongs under the button.
   */
  protected open(event: MouseEvent): void {
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.at.set({ x: box.left, y: box.bottom + 4 });
  }

  protected choose(step: LedgerStep): void {
    this.at.set(null);
    this.stage.startAnalysis(step.id);
  }
}

const NO_STEPS: readonly LedgerStep[] = [];
