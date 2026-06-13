import { Injectable, computed, signal } from '@angular/core';

export type RuntimeReadyState = 'preparing' | 'ready' | 'error';

export interface RuntimeStatus {
  state: RuntimeReadyState;
  message: string;
  error?: string;
}

/**
 * Tracks first-run readiness of the bundled TTS runtime. Packaged builds unpack
 * the Python env + e2a snapshot on first launch (~40 s); during that window the
 * main process broadcasts `runtime:status` and we mirror it here so the shell
 * can show a blocking "Setting up…" overlay and the queue can gate job start.
 *
 * In dev / web (no Electron `runtime` bridge) there is nothing to unpack, so we
 * report ready immediately.
 */
@Injectable({ providedIn: 'root' })
export class RuntimeService {
  private readonly _status = signal<RuntimeStatus>({
    state: 'preparing',
    message: 'Starting the audiobook engine…',
  });
  // Until we've heard a real status from the main process the state is unknown.
  // Gating on this keeps the overlay from flashing in the common already-ready
  // case (the initial query resolves within a few ms).
  private readonly _initialized = signal(false);

  readonly status = this._status.asReadonly();
  readonly ready = computed(() => this._initialized() && this._status().state === 'ready');
  readonly preparing = computed(() => this._initialized() && this._status().state === 'preparing');
  /** The error status when setup failed, else null. */
  readonly errorStatus = computed(() => {
    if (!this._initialized()) return null;
    const s = this._status();
    return s.state === 'error' ? s : null;
  });

  private unsubscribe?: () => void;

  constructor() {
    const api = (window as unknown as { electron?: { runtime?: RuntimeBridge } }).electron?.runtime;
    if (!api) {
      // Not running under Electron (web preview) — nothing to set up.
      this._status.set({ state: 'ready', message: 'Ready' });
      this._initialized.set(true);
      return;
    }

    // Sync the current state first (events may have fired before we subscribed),
    // then listen for pushes. Mark initialized either way so a failed query
    // can't permanently gate the app.
    api.getStatus().then((res) => {
      if (res?.success && res.data) {
        this._status.set(res.data);
      }
    }).catch(() => { /* keep optimistic default */ }).finally(() => {
      this._initialized.set(true);
    });

    this.unsubscribe = api.onStatus((status) => {
      this._status.set(status);
      this._initialized.set(true);
    });
  }
}

interface RuntimeBridge {
  getStatus: () => Promise<{ success: boolean; data?: RuntimeStatus; error?: string }>;
  onStatus: (callback: (status: RuntimeStatus) => void) => () => void;
  usingBundledEnv: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
}
