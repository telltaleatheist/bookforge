/**
 * ToastService — the bottom-right stack of "this landed".
 *
 * ── One stack, two shapes ───────────────────────────────────────────────────
 *
 * This stack is the app's ONLY notification surface (Owen, 2026-08-17: "we
 * need to unify" — the bottom-left notice banner that used to coexist with it
 * is gone). Two shapes ride on it: the CARD (cover, kicker, title, meta,
 * click destination — news about work that finished elsewhere) and the LINE
 * (`line()` / `plain` — one sentence about something the user just did, which
 * is what `NoticeService` renders through).
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
  /**
   * A one-sentence toast: no cover slot, and the title wraps instead of
   * ellipsizing. The shape {@link ToastService.line} raises — see there for
   * why it exists.
   */
  plain?: boolean;
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

  /**
   * Say one sentence on the stack — no cover, no destination, gone in a few
   * seconds. This is NoticeService's rendering since the two stacks were
   * unified (Owen, 2026-08-17: "we need to unify" — the bottom-left banner and
   * this stack were two visual languages for the same "here is a fact").
   *
   * Repeating a line already on the stack does nothing: a job reporting itself
   * twice should read as one event.
   */
  line(text: string): void {
    const line = text.trim();
    if (!line) throw new Error('ToastService.line was given an empty notice');
    if (this._toasts().some(t => t.plain && t.title === line)) return;
    this.show({ tone: 'success', kicker: 'Notice', title: line, meta: '', cover: null, action: null, plain: true });
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
