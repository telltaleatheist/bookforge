/**
 * WHO IS ASKING FOR A NARRATION, and the one place the dialog is drawn.
 *
 * ── Why the modal is not hosted where it is opened ──────────────────────────
 *
 * There are two doors and they are nowhere near each other. One is a button on
 * the book's versions page. The other is Foundry's Narrate, which arrives as an
 * IPC message to the SHELL — Foundry's window has no route, no book on screen
 * and no versions component mounted, and Owen's ruling of 2026-08-26 put the
 * dialog on this side precisely because that window is "just for text changes".
 *
 * Hosting the dialog at each door would mean two copies of its inputs, its
 * close handling and its "the rows are in the queue" toast, drifting the day one
 * of them gains a field — which is the same argument that moved the RUN
 * description into shared/. So the shell hosts it once, this holds who asked,
 * and a door is a single call.
 *
 * ── The target is carried, never looked up ──────────────────────────────────
 *
 * Owen's identity law: "the tts pipeline knows exactly which file its working
 * with because the user came to the tts page FROM the button on that document."
 * Both doors already know the file and the version — the versions row IS one,
 * and main resolves Foundry's press through `foundry-narrate-target.ts` before
 * it sends anything. So this passes a complete target through and has no way to
 * resolve a partial one, which is what keeps a run from being filed against
 * whichever version the code reached first.
 */
import { Injectable, signal } from '@angular/core';
import type { NarrateTarget } from '@shared/queue/narrate-target';

/*
 * Re-exported rather than redeclared. The same payload crosses from main when
 * Foundry's Narrate is pressed, so a local copy would be a second answer to what
 * a narration press names — and the two would drift the day it gains a field.
 */
export type NarrationTarget = NarrateTarget;

@Injectable({ providedIn: 'root' })
export class NarrationDialogService {
  private readonly _target = signal<NarrationTarget | null>(null);

  /** The book the dialog is open on, or null when it is closed. */
  readonly target = this._target.asReadonly();

  /**
   * Open the dialog on this book.
   *
   * A second call while it is open REPLACES the target rather than being
   * refused: the case that produces one is a Narrate pressed in Foundry while
   * the dialog is already up on another book, and the press the user just made
   * is the one they mean.
   */
  open(target: NarrationTarget): void {
    this._target.set(target);
  }

  close(): void {
    this._target.set(null);
  }
}
