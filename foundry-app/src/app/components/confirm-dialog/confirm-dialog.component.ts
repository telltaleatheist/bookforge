import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';

import { ConfirmService } from '../../core/confirm.service';
import { UiService } from '../../core/ui.service';

/**
 * The one card every question in this app is asked in, in the app's own idiom.
 *
 * Scrim and card, like every other dialog here (ocr-dialog, translate-dialog,
 * metadata-dialog), because a question about a book should look like it came
 * from the program the book is in. What it replaced was six native message
 * boxes: the OS's rectangle, the OS's fonts, the OS's button order — correct,
 * modal, and visibly not this app. The user's ruling was "we should have zero js
 * alerts. they should all be custom modals", and the only thing the OS chrome
 * still owns in this program is the FILE PICKER, which is the OS's own chrome for
 * the OS's own filesystem and is not a question the app is asking.
 *
 * IT DRAWS SENTENCES IT DID NOT WRITE. Every word comes from main
 * (`AppQuestion`), which is the only side that knows the size on disk, how many
 * pages the readings bank holds and what a save of somebody's corrections is
 * worth. This file owns the card and the buttons and has no opinion about the
 * words in it.
 *
 * ── The safe button is the one that is focused ───────────────────────────────
 *
 * Carried across from the native dialogs' `defaultId`, whose comment said it
 * best: these are the dialogs where a reflexive Enter would destroy something.
 * So focus lands on whichever choice main named as `preferred`, Escape and the
 * scrim answer with `dismissed`, and a destructive choice wears the error colour
 * and has to be aimed at. Main also decides the ORDER, and puts the destructive
 * one LAST, so a Tab from the focused button reaches it deliberately rather than
 * a Shift+Tab reaching it by accident.
 *
 * The card takes focus itself the moment it opens, which is what makes Escape
 * work without a window-level key listener and what stops a keystroke aimed at
 * whatever was behind it landing there instead.
 *
 * ── The checkbox is a standing answer, not a preference ─────────────────────
 *
 * Two of these questions can be told to stop asking, and what is stored is the
 * ANSWER rather than a silenced flag — "always strike it" and "always leave it"
 * are different instructions about somebody else's book. The box is drawn only
 * when main offers one, and which answers it may be stored for is main's rule
 * (`QuestionCheckbox.remembers`), enforced where the answer is routed. It is
 * unticked for every new question: a standing answer is a decision made once,
 * on purpose, about the question actually in front of you.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (ui.confirmOpen() && confirm.question(); as question) {
      <div class="scrim" (click)="confirm.answer(question.dismissed)"></div>

      <div
        #card
        class="card"
        role="alertdialog"
        aria-modal="true"
        [attr.aria-label]="question.title"
        tabindex="-1"
        (keydown.escape)="confirm.answer(question.dismissed)"
      >
        <header class="head">
          <span class="title">{{ question.title }}</span>
        </header>

        <div class="body">
          <!-- The lead sentence, in the reading colour: it is what is TRUE, and
               the paragraphs under it are what that means. A composer with
               nothing to lead with (the delete card, whose headline is its whole
               statement) leaves it empty and the card closes up around it. -->
          @if (question.message.length > 0) {
            <p class="lead">{{ question.message }}</p>
          }
          @for (line of question.detail; track line) {
            <p class="line">{{ line }}</p>
          }
        </div>

        @if (question.checkbox; as box) {
          <label class="standing">
            <input type="checkbox" [checked]="ticked()" (change)="tick($event)" />
            <span>{{ box.label }}</span>
          </label>
        }

        <!--
          IN MAIN'S ORDER, WHICH IS THE SAFETY RATHER THAN THE STYLING: the
          destructive answer is last and aimed at, and the one worth pressing is
          focused. Nothing here re-sorts them.
        -->
        <footer class="foot">
          @for (choice of question.choices; track choice.key) {
            <button
              [class]="choice.danger ? 'danger' : choice.key === question.preferred ? 'primary' : 'ghost'"
              [attr.data-preferred]="choice.key === question.preferred ? '1' : null"
              (click)="confirm.answer(choice.key, ticked())"
            >{{ choice.label }}</button>
          }
        </footer>
      </div>
    }
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT.
     *
     * This component is mounted for the whole life of the window — unlike the
     * three dialogs beside it, which app.ts only creates while they are open —
     * because the service that settles its promise has to be able to close it
     * from anywhere. That is the right call and it has a price this file has to
     * pay: a \`position: fixed; inset: 0\` host is a full-window sheet of glass
     * over the application AT ALL TIMES, and while the \`@if\` above leaves it
     * empty and invisible, an empty sheet of glass still swallows every click
     * that lands on it. It did: with nothing being confirmed, Home's rows, the
     * rail, the tabs — the entire app — took the pointer and did nothing with
     * it, which reads exactly like an app that has died.
     *
     * \`pointer-events: none\` here and \`auto\` on the two things that are drawn
     * fixes it in the state-independent way: the host never takes a click, open
     * or closed, and the scrim and the card take their own because they are
     * what a person can actually see to click on.
     *
     * THE Z-INDEX IS ABOVE THE OTHER DIALOGS' 1200 AND THAT IS LOAD-BEARING NOW.
     * This card draws OVER whatever raised the question rather than replacing it
     * (see \`ConfirmService\`), so being above the OCR card is what makes "the
     * question is modal" true while the card behind it is still there to go back
     * to.
     */
    :host { position: fixed; inset: 0; z-index: 1300; display: block; pointer-events: none; }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    .card {
      position: relative;
      pointer-events: auto;
      width: min(520px, calc(100vw - 48px));
      max-height: calc(100vh - 96px);
      margin: 64px auto 0;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      outline: none;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .head { padding: 16px 20px 8px; }
    .title { font-family: var(--font-display); font-size: 15px; font-weight: 600; }

    .body { padding: 0 20px 4px; overflow-y: auto; }
    .lead { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-primary); }
    .line { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }

    /* The standing answer sits with the sentences rather than with the buttons:
       it is a statement about the question, and a tick beside the buttons reads
       as a fourth answer. */
    .standing {
      display: flex; align-items: center; gap: 8px;
      padding: 0 20px 12px;
      font-size: 12px; color: var(--text-secondary);
      cursor: pointer;
    }
    .standing input { accent-color: var(--accent-strong); cursor: pointer; }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
      padding: 12px 20px 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .ghost, .danger, .primary {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    /* The answer worth pressing, in the app's own accent: it is the one that
       costs nothing and keeps everything — a save before a close, an offer to
       carry a rename across. */
    .primary {
      border: none;
      background: var(--accent-strong); color: var(--text-inverse);
    }
    .primary:hover { background: var(--accent); }
    .primary:active { transform: scale(0.98); }
    /* The error colour, filled rather than hinted: this button ends something.
       The same red the "not there any more" tag and Home's delete hover use. */
    .danger {
      border: none;
      background: var(--error); color: var(--text-inverse);
    }
    .danger:hover { filter: brightness(1.08); }
    .danger:active { transform: scale(0.98); }
  `],
})
export class ConfirmDialogComponent {
  protected readonly confirm = inject(ConfirmService);
  protected readonly ui = inject(UiService);

  /** Whether "do this every time" is ticked, for the questions that offer it. */
  protected readonly ticked = signal(false);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');

  constructor() {
    /*
     * FOCUS LANDS ON THE ANSWER MAIN PREFERRED, and it has to be done here rather
     * than with an `autofocus` attribute: the card is created by a control-flow
     * block, so there is no page load for the attribute to be honoured at, and a
     * card that opened without focus would send Escape and Enter to whatever was
     * behind the scrim.
     *
     * THE BUTTON IS FOUND BY ITS OWN MARK rather than by an index into the list:
     * the choices are main's, in main's order, and a card that focused "the
     * first" or "the last" would be this side deciding which answer is safe.
     *
     * The tick is cleared in the same pass, which is the same rule said about
     * state instead of focus: a standing answer left ticked from the last
     * question would silence a different one.
     */
    effect(() => {
      const question = this.confirm.question();
      if (!this.ui.confirmOpen() || question === null) return;
      this.ticked.set(false);
      const card = this.card()?.nativeElement;
      queueMicrotask(() => {
        const preferred = card?.querySelector<HTMLElement>('button[data-preferred="1"]');
        (preferred ?? card)?.focus();
      });
    });
  }

  protected tick(event: Event): void {
    this.ticked.set((event.target as HTMLInputElement).checked);
  }
}
