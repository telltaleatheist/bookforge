import { Injectable, computed, inject, signal } from '@angular/core';

import { SettingsService } from './settings.service';

/**
 * AI availability + local-model management (WS2).
 *
 * "Is AI available?" spans the two providers this app has — either suffices:
 *   1. A GPU engine (Crucible): a server and a model chosen in Settings → AI.
 *   2. The bundled llama.cpp engine with a downloaded model.
 *
 * IT ASKED A THIRD QUESTION UNTIL 2026-09-14 — whether a Claude or OpenAI key
 * was saved, and whether Ollama was running with a model pulled. Both are
 * gone: this app holds no key, and Ollama is an upstream the ENGINE forwards
 * to, so whether a daemon answers on this machine is not BookForge's fact to
 * report (`@shared/crucible/settings-wire`, CRUCIBLE_UPSTREAM_NAMES).
 *
 * The cleanup/simplify pages gate on `available()`; the AI Setup wizard uses the
 * local-model methods. The Crucible half is reactive (it reads the settings
 * signal); the local check is async IPC and is cached until refresh().
 */

export interface LocalModel {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  minRAM: number;
  description: string;
  downloaded: boolean;
  isActive: boolean;
  recommended: boolean;
  /** Runs fully/fast on this machine (minRAM ≤ effectiveGB). Bigger ones still
   *  work, but partly on CPU and slowly — the UI dims and warns about them. */
  fits: boolean;
}

export interface LocalSystemInfo {
  platform: string;
  totalRamGB: number;
  cuda: boolean;
  cudaName?: string;
  vramGB?: number;
  effectiveGB: number;
  recommendedModelId: string;
}

export interface LocalStatus {
  binaryPresent: boolean;
  ready: boolean;
  activeModelId: string | null;
  activeModelDownloaded: boolean;
  anyModelDownloaded: boolean;
  modelsDir: string;
}

export interface LocalModelProgress {
  modelId: string;
  pct: number;
  receivedBytes: number;
  totalBytes: number;
  speed?: string;
  eta?: string;
  phase: 'download' | 'done' | 'error' | 'cancelled';
  message?: string;
}

interface AiBridge {
  localStatus: () => Promise<{ success: boolean; data?: LocalStatus; error?: string }>;
  localSystemInfo: () => Promise<{ success: boolean; data?: LocalSystemInfo; error?: string }>;
  localListModels: () => Promise<{ success: boolean; data?: LocalModel[]; error?: string }>;
  localDownloadModel: (id: string) => Promise<{ success: boolean; error?: string }>;
  localCancelDownload: (id: string) => Promise<{ success: boolean; error?: string }>;
  localDeleteModel: (id: string) => Promise<{ success: boolean; error?: string }>;
  localSetActive: (id: string) => Promise<{ success: boolean; error?: string }>;
  onLocalModelProgress: (cb: (p: LocalModelProgress) => void) => () => void;
}

function bridge(): AiBridge | null {
  return (window as unknown as { electron?: { ai?: AiBridge } }).electron?.ai ?? null;
}

@Injectable({ providedIn: 'root' })
export class AiService {
  private readonly settings = inject(SettingsService);

  // Async-checked sources (refreshed on demand).
  private readonly _localUsable = signal(false);
  private readonly _localStatus = signal<LocalStatus | null>(null);
  private readonly _checking = signal(false);
  private readonly _checkedOnce = signal(false);

  readonly localUsable = this._localUsable.asReadonly();
  readonly localStatus = this._localStatus.asReadonly();
  readonly checking = this._checking.asReadonly();
  readonly checkedOnce = this._checkedOnce.asReadonly();

  /**
   * A Crucible server AND a model have been chosen (Settings → AI).
   *
   * Configured is not the same as reachable, and this says the weaker thing on
   * purpose: whether that model is still resident is the server's answer at run
   * time, asked then and refused by name then — a banner that polled a machine
   * across the room to decide whether to say "ready" would be stale by the time
   * anyone read it.
   */
  readonly crucibleConfigured = computed(() => {
    const cfg = this.settings.getAIConfig();
    return !!cfg.crucible?.server?.trim() && !!cfg.crucible?.model?.trim();
  });

  /**
   * A text act has somewhere to run — an engine has been chosen, or the
   * bundled model is downloaded and its binary is present.
   *
   * Composed from {@link crucibleConfigured}, deliberately: that computed
   * already decides what "an engine is chosen" means and says why it stops
   * short of "reachable". A second answer to the same question here would be
   * the one-fact-two-owners shape the audit exists to prevent.
   */
  readonly available = computed(() => this.crucibleConfigured() || this._localUsable());

  constructor() {
    void this.refresh();
  }

  /** Re-run the async local check. The engine's half updates reactively. */
  async refresh(): Promise<void> {
    const api = bridge();
    if (!api) {
      // Web preview — nothing to probe; the chosen engine is the only signal.
      this._checkedOnce.set(true);
      return;
    }
    this._checking.set(true);
    try {
      const local = await api.localStatus()
        .catch(() => ({ success: false } as Awaited<ReturnType<AiBridge['localStatus']>>));

      const ls = local?.data ?? null;
      this._localStatus.set(ls);
      this._localUsable.set(!!ls && ls.binaryPresent && ls.activeModelDownloaded);
    } finally {
      this._checking.set(false);
      this._checkedOnce.set(true);
    }
  }

  // ── Local-model management (AI Setup wizard) ──────────────────────────────

  async systemInfo(): Promise<LocalSystemInfo | null> {
    const res = await bridge()?.localSystemInfo();
    return res?.success ? res.data ?? null : null;
  }

  async listLocalModels(): Promise<LocalModel[]> {
    const res = await bridge()?.localListModels();
    return res?.success ? res.data ?? [] : [];
  }

  async downloadModel(id: string): Promise<{ success: boolean; error?: string }> {
    const res = await bridge()?.localDownloadModel(id);
    return res ?? { success: false, error: 'AI bridge unavailable' };
  }

  async cancelDownload(id: string): Promise<void> {
    await bridge()?.localCancelDownload(id);
  }

  async deleteModel(id: string): Promise<{ success: boolean; error?: string }> {
    const res = await bridge()?.localDeleteModel(id);
    await this.refresh();
    return res ?? { success: false, error: 'AI bridge unavailable' };
  }

  async setActiveModel(id: string): Promise<{ success: boolean; error?: string }> {
    const res = await bridge()?.localSetActive(id);
    await this.refresh();
    return res ?? { success: false, error: 'AI bridge unavailable' };
  }

  onModelProgress(cb: (p: LocalModelProgress) => void): () => void {
    return bridge()?.onLocalModelProgress(cb) ?? (() => undefined);
  }
}
