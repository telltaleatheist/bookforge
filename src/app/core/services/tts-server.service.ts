import { Injectable, inject, signal } from '@angular/core';
import { ElectronService } from './electron.service';

export type TtsServerState = 'stopped' | 'starting' | 'warming' | 'running';

/**
 * Global state of the stream TTS engine ("the TTS server").
 *
 * The main process is the single source of truth; every window mirrors it via
 * 'tts-service:state' broadcasts, so starting or stopping the server in one
 * window is reflected everywhere (nav rail, play screens, listen windows).
 *
 * `state` tracks the engine itself regardless of how it was started.
 * `serviceMode` is true only when the user pinned it as a resident service
 * (nav rail / "Start server"): pinned engines survive listen-window close and
 * idle timeout, so external clients (e.g. a browser extension) can rely on it.
 */
@Injectable({ providedIn: 'root' })
export class TtsServerService {
  private readonly electronService = inject(ElectronService);

  readonly state = signal<TtsServerState>('stopped');
  readonly serviceMode = signal(false);

  /**
   * Warm-up progress (0–100) while the voice model loads into memory after the
   * worker process boots — null when no warm-up is in flight. The worker reports
   * 'ready' the moment Python starts, but the ~1.8 GB checkpoint loads lazily on
   * the first voice load; this tracks that gap so the UI can show a real bar.
   */
  readonly warmupPct = signal<number | null>(null);

  constructor() {
    this.electronService.onTtsServiceState(s => {
      this.state.set(s.state);
      this.serviceMode.set(s.serviceMode);
      // Clear the warm-up bar once the engine is fully warm or has stopped.
      if (s.state === 'running' || s.state === 'stopped') {
        this.warmupPct.set(null);
      }
    });
    this.electronService.onTtsWarmup(d => {
      this.warmupPct.set(d.pct >= 100 ? null : d.pct);
    });
    void this.refresh();
    // Slow polling fallback in case a broadcast is ever missed
    setInterval(() => void this.refresh(), 30_000);
  }

  async refresh(): Promise<void> {
    const result = await this.electronService.ttsServiceStatus();
    if (result.success && result.state) {
      this.state.set(result.state);
      this.serviceMode.set(!!result.serviceMode);
    }
  }

  /** Start the engine pinned as a service; optionally warm a specific voice. */
  async start(voice?: string): Promise<{ success: boolean; error?: string }> {
    this.state.set('starting');  // optimistic; the broadcast confirms
    const result = await this.electronService.ttsServiceStart(voice);
    if (!result.success) {
      this.state.set('stopped');
    }
    return result;
  }

  async stop(): Promise<void> {
    await this.electronService.ttsServiceStop();
  }

  async toggle(): Promise<void> {
    if (this.state() === 'stopped') {
      await this.start();
    } else {
      await this.stop();
    }
  }
}
