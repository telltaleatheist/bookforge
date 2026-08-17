import { Injectable, signal } from '@angular/core';

import type { RecentDocument } from '@shared/types';

import { api } from './foundry';

/**
 * Home's list, mirrored from main.
 *
 * A MIRROR and not a store, the same way QueueService is: main persists
 * `recents.json` and decides what is in it (electron/recents.ts), and this class
 * never edits a row. `refresh()` is called by Home when it appears and after
 * anything that could have changed the list, because there is no push channel
 * for it — a recents list is not worth a broadcast on every open, and Home is
 * the only thing that reads it.
 */
@Injectable({ providedIn: 'root' })
export class RecentsService {
  private readonly all = signal<RecentDocument[]>([]);

  readonly items = this.all.asReadonly();

  async refresh(): Promise<void> {
    if (!api) return;
    this.all.set(await api.recents.list());
  }

  async forget(filePath: string): Promise<void> {
    if (!api) return;
    this.all.set(await api.recents.forget(filePath));
  }

  async clear(): Promise<void> {
    if (!api) return;
    this.all.set(await api.recents.clear());
  }
}
