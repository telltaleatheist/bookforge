import { Injectable, inject, signal } from '@angular/core';
import { ElectronService } from './electron.service';

export type BookshelfServerState = 'stopped' | 'starting' | 'running';

/**
 * Global state of the Bookshelf web server (the read-only browser UI served on
 * the LAN, default port 8765).
 *
 * Unlike the TTS service, the main process does not broadcast bookshelf state
 * changes, so this service is the single renderer-side mirror: it polls
 * `bookshelf:status` on init and on a slow interval. Starting/stopping from the
 * nav rail flips the persisted `enabled` flag in main (so the choice survives a
 * relaunch via autoStartBookshelf).
 */
@Injectable({ providedIn: 'root' })
export class BookshelfServerService {
  private readonly electronService = inject(ElectronService);

  readonly state = signal<BookshelfServerState>('stopped');
  readonly port = signal<number>(8765);
  readonly addresses = signal<string[]>([]);

  constructor() {
    void this.refresh();
    // Slow polling fallback — there is no push channel for bookshelf state.
    setInterval(() => void this.refresh(), 30_000);
  }

  async refresh(): Promise<void> {
    const result = await this.electronService.bookshelfGetStatus();
    if (result.success && result.data) {
      this.state.set(result.data.running ? 'running' : 'stopped');
      this.port.set(result.data.port);
      this.addresses.set(result.data.addresses ?? []);
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    this.state.set('starting'); // optimistic; the status confirms
    const result = await this.electronService.bookshelfStart({ port: this.port() });
    if (result.success && result.data) {
      this.state.set(result.data.running ? 'running' : 'stopped');
      this.addresses.set(result.data.addresses ?? []);
    } else {
      this.state.set('stopped');
    }
    return result;
  }

  async stop(): Promise<void> {
    await this.electronService.bookshelfStop();
    this.state.set('stopped');
  }

  async toggle(): Promise<void> {
    if (this.state() === 'stopped') {
      await this.start();
    } else {
      await this.stop();
    }
  }
}
