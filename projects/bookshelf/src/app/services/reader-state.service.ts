import { Injectable, signal } from '@angular/core';

export interface ReaderSession {
  /** `p:<projectId>` or `e:<relativePath>` — the reader's book reference. */
  ref: string;
  title: string;
  author: string;
  cover: string | null;
}

/**
 * Holds the currently-open reading session so the book reader can MINIMIZE to a
 * bottom bar (like the audio player's mini-bar) and be reopened with its reading
 * position intact. This is the reading analogue of PlayerService: the reader
 * overlay tears down its DOM when minimized, but the session (and the persisted
 * per-book position) survive so reopening restores where you left off.
 *
 * Unlike audio there's nothing to keep running in the background — this only
 * tracks "a book is open" plus a progress label for the bar.
 */
@Injectable({ providedIn: 'root' })
export class ReaderStateService {
  readonly session = signal<ReaderSession | null>(null);
  /** Human progress label shown on the mini-bar (e.g. "42%" or "p. 88 / 240"). */
  readonly progress = signal('');

  open(session: ReaderSession): void {
    const current = this.session();
    if (current?.ref === session.ref) return; // reopening — keep progress
    this.session.set(session);
    this.progress.set('');
  }

  setProgress(label: string): void {
    this.progress.set(label);
  }

  end(): void {
    this.session.set(null);
    this.progress.set('');
  }
}
