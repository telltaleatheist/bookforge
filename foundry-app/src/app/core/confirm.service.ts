import { Injectable, effect, inject, signal } from '@angular/core';

import type { AppQuestion, DeletionPrompt, QuestionAnswer } from '@shared/types';

import { api } from './foundry';
import { UiService } from './ui.service';

/**
 * EVERY QUESTION THIS APP ASKS, ASKED IN THIS APP.
 *
 * ── What it replaced, and what the OS chrome was costing ────────────────────
 *
 * There were six native message boxes: the delete confirmation, the closing
 * document, the unlinked footnote, the re-read, and the two echoes between a
 * page heading and its contents entry. `dialog.showMessageBox` is modal to the
 * WINDOW — the next gesture cannot race it, and it cannot scroll out from under
 * itself — and that is a real advantage this card had to earn back. What it
 * could not do is look like this app: it is the OS's rectangle, in the OS's
 * fonts, with the OS's button order, and a program whose every other question is
 * a card in its own idiom asking these through a system alert reads as a program
 * interrupted by something else. The user called the first one "the js alert",
 * and then ruled on the rest of them: *"we should have zero js alerts. they
 * should all be custom modals."*
 *
 * The modality is earned the way the app earns it everywhere else — a fixed
 * full-window scrim at the top of the stack, which takes every click before
 * anything under it can, including a sandboxed iframe that is free to scroll
 * behind it.
 *
 * ── THE FACTS ARE STILL MAIN'S ──────────────────────────────────────────────
 *
 * Nothing in this file composes a sentence. `AppQuestion` and `DeletionPrompt`
 * arrive whole from the process that knows the size on disk, the readings bank's
 * page count and what a save is worth (electron/ipc.ts). The one thing the
 * renderer must never do to this dialog is start writing its own copy, which is
 * how a warning worth reading becomes "Are you sure?".
 *
 * ── A PROMISE, so a caller reads as the sentence it is ──────────────────────
 *
 *     if (!await this.confirm.ask(prompt)) return;
 *
 * ── IT DRAWS OVER ANOTHER DIALOG AND DOES NOT CLOSE IT ──────────────────────
 *
 * `UiService.dialogs` is one-at-a-time in one direction only, and the direction
 * matters. Any other dialog opening closes this one — the effect below turns
 * that into the question's own dismissal answer, so a promise nobody will ever
 * settle cannot leave a caller holding a lock forever. But this one opening
 * closes NOTHING: a confirmation is a question ABOUT the gesture that raised it,
 * and the re-read question is raised from inside the OCR card by the very button
 * that would enqueue the run. Taking that card away to ask about it would answer
 * a question nobody asked — the person says "no, leave the reading as it is" and
 * finds the dialog they were filling in has gone. The card sits above every
 * other dialog (z-index, `ConfirmDialogComponent`), so drawing over one is
 * exactly as modal as replacing it and loses nothing.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmService {
  private readonly ui = inject(UiService);

  /** What the card is currently asking. Null when nothing is. */
  readonly question = signal<AppQuestion | null>(null);

  private settle: ((answer: QuestionAnswer) => void) | null = null;
  /** The answer a dismissal means, taken from whatever is being asked. */
  private dismissed = '';

  constructor() {
    effect(() => {
      // Closed by anything at all — Escape, the scrim, another dialog opening —
      // is the question's own dismissal answer. The card is the question; without
      // it there is nothing to answer.
      if (!this.ui.confirmOpen()) this.finish({ key: this.dismissed, standing: false });
    });

    /*
     * THE BRIDGE IS HANDED THIS CARD, ONCE, AS THE APP STARTS.
     *
     * The five questions main used to put on screen itself are still asked
     * through `api.confirmClose` and its four siblings — the call sites did not
     * change and must not have to know a card exists. What changed is where the
     * drawing happens, and the preload cannot reach an Angular component, so the
     * component's service reaches the preload instead.
     *
     * IN THE CONSTRUCTOR AND NOWHERE ELSE. `ConfirmDialogComponent` is mounted
     * for the whole life of the window and injects this, so the registration
     * happens at bootstrap, before any gesture can ask anything. There is no
     * unregister for the same reason: there is no moment where the right place
     * for one of these questions is somewhere else.
     */
    api?.drawQuestions((question) => this.put(question));
  }

  /**
   * Ask one of main's composed questions, and resolve with what was pressed.
   *
   * The answer is the pressed choice's own key — never an index (see
   * `AppQuestion`) — beside whether the standing-answer box was ticked. What is
   * done with either is the caller's business; this file draws and settles.
   */
  put(question: AppQuestion): Promise<QuestionAnswer> {
    this.finish({ key: this.dismissed, standing: false });
    this.dismissed = question.dismissed;
    this.question.set(question);
    /*
     * NOT `only()`, WHICH WOULD CLOSE WHATEVER RAISED THE QUESTION. See the
     * header: the signal is set directly so the card stacks, and the other half
     * of the one-at-a-time rule still holds because every other opener goes
     * through `only()` and clears this. (UiService once offered an
     * `openConfirm()` that was `only(confirmOpen)`; it never had a caller and
     * was removed — the note where it stood says why it must not come back.)
     */
    this.ui.confirmOpen.set(true);
    return new Promise<QuestionAnswer>((resolve) => {
      this.settle = resolve;
    });
  }

  /**
   * The delete confirmation — a `DeletionPrompt` worn as a question.
   *
   * TWO SHAPES BECAUSE THERE ARE TWO COMPOSERS, not because there are two cards.
   * `DeletionPrompt` is main's older shape for the same job and every delete flow
   * in the app hands one over; converting it here is four lines and keeps those
   * call sites reading as the sentence they are. The safety it has always had is
   * spelled out rather than implied: the destructive button is LAST and wears the
   * error colour, Keep it is what is focused, and a dismissal keeps it.
   */
  async ask(prompt: DeletionPrompt): Promise<boolean> {
    const answer = await this.put({
      title: prompt.message,
      message: '',
      detail: prompt.detail,
      choices: [
        { key: 'keep', label: 'Keep it' },
        { key: 'destroy', label: prompt.confirm, danger: true },
      ],
      preferred: 'keep',
      dismissed: 'keep',
      checkbox: null,
    });
    return answer.key === 'destroy';
  }

  /** The card's own buttons. */
  answer(key: string, standing = false): void {
    this.finish({ key, standing });
    this.ui.closeConfirm();
    this.question.set(null);
  }

  private finish(answer: QuestionAnswer): void {
    const settle = this.settle;
    this.settle = null;
    settle?.(answer);
  }
}
