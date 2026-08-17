import { Injectable, inject } from '@angular/core';
import { ToastService } from './toast.service';

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
 * Since 2026-08-17 this is a VOCABULARY, not a second stack: Owen ruled the
 * bottom-left banner and the toast stack must be one system ("we need to
 * unify"), so a notice renders as a plain line on the toast stack
 * ({@link ToastService.line}) and the banner component is gone. The service
 * survives because "say one sentence, at most once" is an API its callers
 * mean, independent of where the sentence appears.
 *
 * The picker window keeps its own in-viewer stack (`sessionNotices`) because
 * its notices belong to the book on screen.
 */
@Injectable({ providedIn: 'root' })
export class NoticeService {
  private readonly toasts = inject(ToastService);

  /** Keys already said this session, for {@link notifyOnce}. */
  private readonly saidOnce = new Set<string>();

  /**
   * Say one thing, once. Repeating an identical line already on the stack does
   * nothing — a job reporting itself twice should read as one event.
   */
  notify(text: string): void {
    this.toasts.line(text);
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
}
