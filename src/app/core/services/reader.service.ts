import { Injectable, computed, signal } from '@angular/core';

export interface ReaderSummary {
  id: string;
  name: string;
  hasPin: boolean;
}

/**
 * ReaderService (desktop) — the "who is listening" identity for the player.
 *
 * BookForge IS the server, so this talks to its OWN in-process reader store over
 * IPC (window.electron.reader) — the same profiles the phone/web app use, kept in
 * sync automatically. There is deliberately no notion of connecting to a different
 * server: it's always this app's store. When no profile is selected ("guest"),
 * listening + bookmarks stay local and are not attributed to anyone.
 */
@Injectable({ providedIn: 'root' })
export class ReaderService {
  private static readonly STORAGE_KEY = 'bookforge-active-reader';

  readonly readers = signal<ReaderSummary[]>([]);
  readonly activeId = signal<string | null>(localStorage.getItem(ReaderService.STORAGE_KEY));
  readonly active = computed<ReaderSummary | null>(() =>
    this.readers().find((r) => r.id === this.activeId()) ?? null,
  );

  private get api() { return (window as any).electron?.reader; }

  /** Load the profile list; drop the persisted selection if that reader is gone. */
  async load(): Promise<void> {
    const api = this.api;
    if (!api) return;
    try {
      const res = await api.list();
      if (res?.success) this.readers.set(res.readers);
      if (this.activeId() && !this.readers().some((r) => r.id === this.activeId())) {
        this.select(null);
      }
    } catch {
      /* store unavailable — stay guest */
    }
  }

  select(id: string | null): void {
    this.activeId.set(id);
    if (id) localStorage.setItem(ReaderService.STORAGE_KEY, id);
    else localStorage.removeItem(ReaderService.STORAGE_KEY);
  }
}
