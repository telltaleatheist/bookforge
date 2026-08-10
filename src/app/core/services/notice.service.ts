import { Injectable, signal } from '@angular/core';

/** One line on the app's notice stack. */
export interface AppNotice {
  id: number;
  text: string;
}

/**
 * The app's non-blocking way of saying something happened.
 *
 * A modal is for three things only: confirming a destructive act, refusing an
 * act the user just asked for, and reporting an error that stopped what they
 * asked for. Everything else that is still worth saying out loud — a background
 * job finished, a partial condition, a one-time migration fact — comes here
 * instead, and the user reads it when they look rather than being stopped to
 * acknowledge it.
 *
 * The picker window keeps its own in-viewer stack (`sessionNotices`) because
 * its notices belong to the book on screen. This one is the main window's, and
 * is rendered once at the app root by {@link NoticeBannerComponent}.
 */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  /** Oldest first; the banner renders them newest-first so a fresh one is on top. */
  readonly notices = signal<AppNotice[]>([]);

  private seq = 0;

  /** Keys already said this session, for {@link notifyOnce}. */
  private readonly saidOnce = new Set<string>();

  /**
   * How many lines the stack will hold before the oldest falls off. A cap
   * rather than unbounded growth: past four the stack stops being a message
   * and becomes a wall, which is the thing this whole vehicle exists to avoid.
   */
  private static readonly MAX_NOTICES = 4;

  /**
   * How long a notice stays before dismissing itself. Owen, 2026-08-10 (on the
   * conversion-finished toast): "have them dismiss after a few seconds." Long
   * enough to read two sentences from across the room; a notice the user must
   * act on belongs in a modal, not here, so nothing on this stack needs to
   * outlive its reading.
   */
  private static readonly AUTO_DISMISS_MS = 8000;

  /** The auto-dismiss timer per notice, cancelled on manual dismissal. */
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  /**
   * Say one thing, once. Repeating an identical line already on the stack does
   * nothing — a job reporting itself twice should read as one event.
   */
  notify(text: string): void {
    const line = text.trim();
    if (!line) throw new Error('NoticeService.notify was given an empty notice');
    let added: number | null = null;
    this.notices.update(list => {
      if (list.some(n => n.text === line)) return list;
      added = ++this.seq;
      const next = [...list, { id: added, text: line }];
      return next.length > NoticeService.MAX_NOTICES
        ? next.slice(next.length - NoticeService.MAX_NOTICES)
        : next;
    });
    if (added !== null) {
      const id = added;
      this.timers.set(id, setTimeout(() => this.dismiss(id), NoticeService.AUTO_DISMISS_MS));
    }
  }

  /**
   * Say one thing at most once per `key` for the life of this window, even
   * after the user dismisses it. For facts that are true of a project rather
   * than of a click — the key is usually the project path.
   */
  notifyOnce(key: string, text: string): void {
    if (this.saidOnce.has(key)) return;
    this.saidOnce.add(key);
    this.notify(text);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.notices.update(list => list.filter(n => n.id !== id));
  }
}
