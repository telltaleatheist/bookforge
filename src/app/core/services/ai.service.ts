import { Injectable, computed, inject, signal } from '@angular/core';

import { SettingsService } from './settings.service';

/**
 * AI availability + local-model management (WS2).
 *
 * "Is AI available?" spans three independent sources — any one suffices:
 *   1. An API key (Claude or OpenAI), read from renderer settings.
 *   2. A local model served by Ollama (running AND has at least one model).
 *   3. The bundled llama.cpp engine with a downloaded model.
 *
 * The cleanup/simplify pages gate on `available()`; the AI Setup wizard uses the
 * local-model methods. Key presence is reactive (it reads the settings signal);
 * the Ollama + local checks are async IPC and are cached until refresh().
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
  checkConnection: () => Promise<{ success: boolean; data?: { connected: boolean; models?: { name: string }[]; error?: string }; error?: string }>;
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
  private readonly _ollamaHasModels = signal(false);
  private readonly _ollamaConnected = signal(false);
  private readonly _localUsable = signal(false);
  private readonly _localStatus = signal<LocalStatus | null>(null);
  private readonly _checking = signal(false);
  private readonly _checkedOnce = signal(false);

  /** True when Claude or OpenAI has a non-empty API key. Reactive on settings. */
  readonly hasApiKey = computed(() => {
    const cfg = this.settings.getAIConfig();
    return !!cfg.claude?.apiKey?.trim() || !!cfg.openai?.apiKey?.trim();
  });
  readonly ollamaHasModels = this._ollamaHasModels.asReadonly();
  readonly ollamaConnected = this._ollamaConnected.asReadonly();
  readonly localUsable = this._localUsable.asReadonly();
  readonly localStatus = this._localStatus.asReadonly();
  readonly checking = this._checking.asReadonly();
  readonly checkedOnce = this._checkedOnce.asReadonly();

  /** AI is available if ANY source is configured. */
  readonly available = computed(() =>
    this.hasApiKey() || this._ollamaHasModels() || this._localUsable()
  );

  constructor() {
    void this.refresh();
  }

  /** Re-run the async (Ollama + local) checks. Key presence updates reactively. */
  async refresh(): Promise<void> {
    const api = bridge();
    if (!api) {
      // Web preview — nothing to probe; treat keys as the only signal.
      this._checkedOnce.set(true);
      return;
    }
    this._checking.set(true);
    try {
      const [ollama, local] = await Promise.all([
        api.checkConnection().catch(() => ({ success: false } as Awaited<ReturnType<AiBridge['checkConnection']>>)),
        api.localStatus().catch(() => ({ success: false } as Awaited<ReturnType<AiBridge['localStatus']>>)),
      ]);

      const connected = !!ollama?.data?.connected;
      this._ollamaConnected.set(connected);
      this._ollamaHasModels.set(connected && (ollama?.data?.models?.length ?? 0) > 0);

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
