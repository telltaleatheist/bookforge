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

/**
 * WHICH DOOR THE USER CAME THROUGH, and therefore what the run may do.
 *
 * Owen, 2026-08-27: *"if the user enters the modal from the sentence cache line
 * item, the system should know they want to run the effect against the sentence
 * cache … and the narration checkbox/tab should be disabled. if they want to
 * narrate a new session, theyll have to open the modal from the epub."*
 *
 * 'document' — pressed on a version of the book. Every stage is on offer,
 *   narration included, and the resume choice appears when a part-finished
 *   render is on disk.
 * 'cache'    — pressed on the sentence-cache row. The run is about audio that
 *   already exists: reading is locked off, because a fresh read is a thing you
 *   start FROM the book.
 *
 * It has NO DEFAULT anywhere, here or in the dialog. A default is how the next
 * door added gets the wrong one silently, and the wrong one is either a locked
 * tab on a run that meant to read the book or an unlocked one on a run that
 * meant to leave the cache alone.
 */
export type NarrationEntryContext = 'document' | 'cache';

/**
 * ONE PRESS: what it is about, and where it was made.
 *
 * A single signal rather than two, so the pair cannot be half-set. Two would
 * have made "the dialog is open but nobody said through which door" a state the
 * host had to assert its way out of, and an assertion is where a wrong answer
 * gets in quietly.
 */
export interface NarrationRequest {
  readonly target: NarrationTarget;
  readonly context: NarrationEntryContext;
}

@Injectable({ providedIn: 'root' })
export class NarrationDialogService {
  private readonly _request = signal<NarrationRequest | null>(null);

  /** The press the dialog is open on, or null when it is closed. */
  readonly request = this._request.asReadonly();

  /**
   * Open the dialog on this book, through this door.
   *
   * A second call while it is open REPLACES the request rather than being
   * refused: the case that produces one is a Narrate pressed in Foundry while
   * the dialog is already up on another book, and the press the user just made
   * is the one they mean. The context travels with the target because they are
   * one press.
   */
  open(target: NarrationTarget, context: NarrationEntryContext): void {
    this._request.set({ target, context });
  }

  close(): void {
    this._request.set(null);
  }
}
