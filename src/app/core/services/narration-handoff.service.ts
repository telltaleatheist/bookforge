import { Injectable, signal } from '@angular/core';

/**
 * The picker handed a finished book to narration — which project, and nobody has
 * acted on it yet.
 *
 * Why this exists at all. The hand-off crosses a window AND a route: main raises
 * the main window and sends `app:show-narration` (electron/main.ts), the shell
 * hears it and navigates to Studio (app.ts), and Studio is the only place that
 * can select the project and put the wizard on the TTS step. Studio is lazily
 * routed, so at the moment the event arrives it may not be mounted — a request
 * that only a mounted listener could catch would be dropped precisely on the
 * cold path, which is the common one (the user was in the picker, not in Studio).
 *
 * Why not a query parameter, which is how the URL would normally carry this: the
 * router does not re-emit an unchanged URL, so pressing Next a second time for
 * the same book would navigate to the same `/studio?narrate=<dir>` and produce
 * no event at all. A hand-off that works once per book and then silently stops
 * is worse than one that never worked.
 *
 * It is a REQUEST, not state: it is set once and consumed once, and after that
 * there is nothing here to disagree with anything. The same shape main uses for
 * "open when finished" (electron/document-open-when-finished.ts), for the same
 * reason — the asker and the doer are not in the same place.
 */
@Injectable({ providedIn: 'root' })
export class NarrationHandoffService {
  private readonly _pending = signal<string | null>(null);

  /** The project directory narration was asked for, or null when nothing is owed. */
  readonly pending = this._pending.asReadonly();

  /**
   * Narration was asked for. Overwrites an unconsumed request on purpose: two
   * asks in a row are one user changing their mind, and the later one is the
   * one they are looking at.
   */
  request(projectDir: string): void {
    this._pending.set(projectDir);
  }

  /**
   * Take the request, leaving nothing behind.
   *
   * Consuming is what makes a repeat of the SAME project work: the signal goes
   * back to null, so the next request is a change and fires again.
   */
  take(): string | null {
    const dir = this._pending();
    this._pending.set(null);
    return dir;
  }
}
