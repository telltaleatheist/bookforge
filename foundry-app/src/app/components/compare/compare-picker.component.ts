import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import type { LedgerStep } from '@shared/types';

import { OpenDocumentsService } from '../../core/documents.service';
import { LedgerService } from '../../core/ledger.service';
import { StageService } from '../../core/stage.service';

/**
 * THE COMPARE CONTROL — a button, and the step it opens onto.
 *
 * ── The user's ruling, and the shape it names ───────────────────────────────
 *
 *   *"i dont think we should have tabs in foundry. i think its making things a
 *   bit confusing. however, the user should be able to compare two steps
 *   sometimes. so i think the solution is to have a single viewer window/single
 *   tab, and if the user wants to compare two steps, theres a compare button
 *   they can click and then they can choose the step to compare."*
 *
 * Two sentences, two halves, and this component is both of them: the BUTTON, and
 * the CHOOSING. Everything else about the comparison — where the column goes, what
 * it draws, when it ends — belongs to the workspace and to `StageService.compare`;
 * this only ever sets a step id.
 *
 * ── Why it is a component rather than markup in two places ──────────────────
 *
 * It is wanted in two different chromes: the book's head row, beside the register
 * segments, and the PDF viewer's toolbar. Those are the two surfaces a person can
 * be standing on when the question *"is this what the last step said?"* occurs to
 * them, and a control that existed on only one of them would make the answer
 * depend on which kind of document happened to be up. Copying the scrim, the menu
 * and the step list into both would be two things to keep true.
 *
 * ── It asks the stage which book, and the ledger which rows ─────────────────
 *
 * Not its host. A control dropped into a chrome could read the tab it is drawn
 * inside — but the comparison is about the DOCUMENT IN FRONT OF THE PERSON, which
 * is the stage's own subject, and `startCompare` derives the project from exactly
 * that. So the button and the column can never disagree about which book is being
 * compared, whichever chrome the button was pressed in.
 *
 * ── THE ROWS ARE THE LEDGER'S OWN ──────────────────────────────────────────
 *
 * `step.label` and nothing derived. The library draws SENTENCES over these rows
 * ("Translated into German", "from Applied changes") because a tree is read at a
 * glance and a notation is not; a menu of eight items being chosen from is a
 * different act, and the stored label is what this app called the step at the
 * moment it happened. It is also the one string that cannot drift from the row —
 * every derived sentence is a second opinion about it.
 *
 * THE STANDING ROW IS NOT OFFERED. Comparing the position against itself would
 * draw the same book twice, side by side, which is a feature that appears broken
 * the first time anybody tries it. Excluded rather than disabled: a menu of rows
 * where one is permanently dead teaches people to check before clicking, and the
 * row they cannot pick is the one they are already looking at.
 */
@Component({
  selector: 'app-compare-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      DRAWN ONLY WHERE THERE IS SOMETHING TO COMPARE AGAINST. A project with one
      step has no second row to offer, and a button whose menu would be empty is
      furniture that teaches somebody the feature does not work.
    -->
    @if (choices().length > 0) {
      <button
        type="button"
        class="act"
        [class.on]="stage.compare() !== null"
        title="Put another step beside this one, read-only"
        (click)="open($event)"
      >Compare</button>
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
        aria-label="Choose a step to compare against"
        [style.left.px]="where.x"
        [style.top.px]="where.y"
        (keydown.escape)="at.set(null)"
      >
        <span class="lbl">compare against</span>
        @for (step of choices(); track step.id) {
          <button role="menuitem" (click)="choose(step)">{{ step.label }}</button>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }

    /*
      THE HOST'S OWN BUTTON SHAPE. Both chromes this is dropped into draw their
      controls at 11px in a bordered pill (\`.act\` on the book's head tray,
      \`.ghost\` on the PDF toolbar), and a control that arrived wearing its own
      idea of a button would read as something bolted on rather than as one more
      thing this row offers. The two differ by a pixel of padding and neither
      cares; this takes the smaller.
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
    /* Lit while a comparison is up, because the button is also the reminder that
       the second column is somebody's own doing rather than the app's. */
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
export class ComparePickerComponent {
  protected readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly ledger = inject(LedgerService);

  /** Where the menu was asked for, or null while it is shut. */
  protected readonly at = signal<{ x: number; y: number } | null>(null);

  /**
   * The project of the document in front of the person, or null.
   *
   * THE STAGE'S ANSWER AND NOT THE HOST'S, for the reason in the class docblock:
   * this control is about what is on screen, and there is exactly one of those.
   */
  private readonly projectDir = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    return tab === null ? null : this.documents.projectDirOf(tab);
  });

  /**
   * Every step of this book except the one it is standing on, newest last.
   *
   * THE LEDGER'S OWN ORDER, untouched. `ProjectLedger.steps` is in creation order
   * and `parseLedger` refuses a file where it is not, so a sort here would be this
   * component holding a second opinion about the shape of somebody's history —
   * which is the same rule the library's tree follows for the same reason.
   */
  protected readonly choices = computed<readonly LedgerStep[]>(() => {
    const dir = this.projectDir();
    if (dir === null) return NO_STEPS;
    const history = this.ledger.historyFor(dir);
    if (history === null) return NO_STEPS;
    const standing = this.ledger.standingIn(dir)?.id ?? null;
    return history.ledger.steps.filter((step) => step.id !== standing);
  });

  /**
   * Open the menu under the button.
   *
   * `stopPropagation` because both chromes this is dropped into sit inside
   * surfaces with click handlers of their own — the book's head row is inside the
   * viewer, and a press that also landed there would be a gesture doing two things.
   *
   * POSITIONED FROM THE BUTTON'S OWN BOX rather than from the pointer, which is
   * the one place this departs from the library's menu. That one is raised by a
   * right-click and belongs where the pointer was; this is raised by a button, and
   * a menu that appeared under the mouse rather than under the control would read
   * as unrelated to it.
   */
  protected open(event: MouseEvent): void {
    event.stopPropagation();
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.at.set({ x: box.left, y: box.bottom + 4 });
  }

  protected choose(step: LedgerStep): void {
    this.at.set(null);
    this.stage.startCompare(step.id);
  }
}

const NO_STEPS: readonly LedgerStep[] = [];
