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

  /**
   * True while a start/stop this service issued is still waiting for its answer.
   *
   * The 30s poll and the nav-rail button write the SAME signal, and the poll has
   * no idea a start is in progress: a refresh that lands between "starting" and
   * the server actually listening reports `running: false` and flips the button
   * back to stopped under the user's finger — which reads as "the start failed"
   * for a start that is working. A transition owns the state until it answers.
   */
  private transitioning = false;

  async refresh(): Promise<void> {
    const result = await this.electronService.bookshelfGetStatus();
    // A start/stop that began after this poll went out knows more than it does.
    if (this.transitioning) return;
    if (result.success && result.data) {
      this.state.set(result.data.running ? 'running' : 'stopped');
      this.port.set(result.data.port);
      this.addresses.set(result.data.addresses ?? []);
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    this.transitioning = true;
    this.state.set('starting'); // optimistic; the status confirms
    try {
      const result = await this.electronService.bookshelfStart({ port: this.port() });
      if (result.success && result.data) {
        this.state.set(result.data.running ? 'running' : 'stopped');
        this.addresses.set(result.data.addresses ?? []);
      } else {
        this.state.set('stopped');
      }
      return result;
    } finally {
      this.transitioning = false;
    }
  }

  async stop(): Promise<{ success: boolean; error?: string }> {
    this.transitioning = true;
    try {
      const result = await this.electronService.bookshelfStop();
      // A stop that failed left the server LISTENING. Saying "stopped" would
      // put a running server behind a button offering to start it, and the
      // next poll would flip it back with no explanation.
      this.state.set(result.success ? 'stopped' : 'running');
      return result;
    } finally {
      this.transitioning = false;
    }
  }

  async toggle(): Promise<void> {
    if (this.state() === 'stopped') {
      await this.start();
    } else {
      await this.stop();
    }
  }
}
