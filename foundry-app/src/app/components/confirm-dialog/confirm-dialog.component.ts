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
  templateUrl: './confirm-dialog.component.html',
  styleUrl: './confirm-dialog.component.scss',
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
