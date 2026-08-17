/**
 * ToastService — the bottom-right stack of "this landed".
 *
 * ── Why not the notice banner ───────────────────────────────────────────────
 *
 * `NoticeService` already carries the non-blocking half of the dialog
 * vocabulary, and this is deliberately NOT that. A notice is a sentence about
 * something the user just did and is still looking at. A toast is news about
 * work that finished while they were doing something else: it carries the book's
 * cover, it names what was produced, and clicking it takes them to the thing.
 * Folding one into the other would mean either notices grow a cover and a
 * destination, or completions lose them.
 *
 * ── Why hand-rolled ─────────────────────────────────────────────────────────
 *
 * A toast library gives placement, stacking and a timer. Placement and stacking
 * are eight lines of flexbox; the timer is four. What it does NOT give is the
 * card — cover, kicker, title, meta line, click destination — which is the whole
 * of this feature and would have to be written into a custom template anyway. So
 * a dependency would have bought the eight lines and left the rest.
 */

import { Injectable, signal } from '@angular/core';

/** How a toast reads and how it leaves. */
export type ToastTone = 'success' | 'failure';

export interface ToastAction {
  /** Where clicking the toast goes, said as a sentence — "click to open". */
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  tone: ToastTone;
  /** The small uppercase line — "Finished narrating". */
  kicker: string;
  title: string;
  /** One line under the title: a duration, a file, a reason. */
  meta: string;
  /** A cover thumbnail as a data URI, or null. */
  cover: string | null;
  action: ToastAction | null;
}

/**
 * How long a successful toast stays up.
 *
 * Failures do NOT auto-dismiss: a run that failed while the user was in another
 * window is the one piece of news that must not be able to disappear unseen.
 */
const SUCCESS_DISMISS_MS = 8_000;

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly _toasts = signal<Toast[]>([]);
  readonly toasts = this._toasts.asReadonly();

  private nextId = 1;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(toast: Omit<Toast, 'id'>): number {
    const id = this.nextId++;
    this._toasts.update(list => [...list, { ...toast, id }]);
    if (toast.tone === 'success') {
      this.timers.set(id, setTimeout(() => this.dismiss(id), SUCCESS_DISMISS_MS));
    }
    return id;
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this._toasts.update(list => list.filter(t => t.id !== id));
  }

  dismissAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this._toasts.set([]);
  }
}
