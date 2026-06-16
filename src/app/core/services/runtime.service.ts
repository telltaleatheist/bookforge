import { Injectable, computed, effect, signal } from '@angular/core';

export type RuntimeReadyState = 'preparing' | 'ready' | 'error';

export interface RuntimeStatus {
  state: RuntimeReadyState;
  message: string;
  error?: string;
}

/**
 * Map a discrete runtime-setup stage message to a coarse 0–100 percent for the
 * first-run progress UI. The main process reports named stages, not real
 * percentages, so these are best-effort checkpoints; {@link RuntimeService}
 * clamps the result monotonically so out-of-order messages never jump it back.
 */
function setupPercentFor(message: string, ready: boolean): number {
  // ONLY the real ready flag is 100. Per-step "…ready." messages (env, e2a) must
  // map to their phase, never 100 — otherwise the monotonic floor locks the bar
  // at 100 while later phases (voice / language pack) are still downloading and
  // the page looks frozen. Ordered to match the first-run "update" sequence:
  // e2a code → env (download + unpack) → default voice → English pack.
  if (ready) return 100;
  const m = (message || '').toLowerCase();
  if (m.includes('english language pack')) {
    return m.includes('installing') ? 96 : m.includes('verifying') ? 92 : 86;
  }
  if (m.includes('johansson voice') || (m.includes('voice') && m.includes('downloading'))) {
    return m.includes('installing') ? 80 : m.includes('verifying') ? 76 : 58;
  }
  if (m.includes('conda-unpack') || m.includes('fixing environment')) return 50;
  if (m.includes('extracting')) return 45;
  if (m.includes('text-to-speech runtime')) return 30; // env download / prepare / ready
  if (m.includes('audiobook engine') || m.includes('installing the bundled') || m.includes('bundled')) return 12;
  if (m.includes('updating') || m.includes('setting up') || m.includes('starting') || m.includes('choose your library')) return 6;
  return 8;
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

  // True when the bundled environment was created from scratch this launch — a
  // fresh install or post-"Remove all data". Tied to the ENVIRONMENT (the env dir
  // was absent), NOT lingering localStorage, so the shell can show first-run setup
  // even when a stale onboarding flag survived an uninstall. Loaded once at boot.
  private readonly _freshInstall = signal(false);
  readonly freshInstall = this._freshInstall.asReadonly();

  readonly status = this._status.asReadonly();
  readonly ready = computed(() => this._initialized() && this._status().state === 'ready');
  readonly preparing = computed(() => this._initialized() && this._status().state === 'preparing');
  /** The error status when setup failed, else null. */
  readonly errorStatus = computed(() => {
    if (!this._initialized()) return null;
    const s = this._status();
    return s.state === 'error' ? s : null;
  });

  // Coarse 0–100 setup progress for the first-run UI (bottom bar + finish page).
  // Derived from the discrete stage message and clamped monotonically so it only
  // ever advances; the floor is bumped by an effect in the constructor.
  private readonly _rawProgress = computed(() =>
    setupPercentFor(this._status().message, this.ready())
  );
  private readonly _progressFloor = signal(0);
  readonly setupProgress = computed(() => Math.max(this._rawProgress(), this._progressFloor()));

  private unsubscribe?: () => void;

  /**
   * Resolves once the bundled runtime has settled — ready OR errored. Used to
   * gate env-dependent downloads (voices / language packs spawn the bundled
   * python, which doesn't exist until the first-run unpack finishes). Resolves
   * on the error state too so a stalled setup makes the caller fail loudly
   * rather than hang forever. Resolves immediately when already settled
   * (dev / web, or after unpack).
   */
  whenReady(): Promise<void> {
    if (this.ready() || this.errorStatus()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (this.ready() || this.errorStatus()) {
          clearInterval(timer);
          resolve();
        }
      }, 200);
    });
  }

  constructor() {
    // Monotonic floor: stage messages can arrive slightly out of order, but the
    // progress bar should only ever advance.
    effect(() => {
      const p = this._rawProgress();
      if (p > this._progressFloor()) this._progressFloor.set(p);
    });

    const api = (window as unknown as { electron?: { runtime?: RuntimeBridge } }).electron?.runtime;
    if (!api) {
      // Not running under Electron (web preview) — nothing to set up.
      this._status.set({ state: 'ready', message: 'Ready' });
      this._initialized.set(true);
      return;
    }

    // Was this a fresh install / post-reset? (env created from scratch)
    api.isFreshInstall?.().then((res) => {
      if (res?.success && res.data === true) this._freshInstall.set(true);
    }).catch(() => { /* default false */ });

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
  isFreshInstall?: () => Promise<{ success: boolean; data?: boolean; error?: string }>;
}
