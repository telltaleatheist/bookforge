import { Injectable, computed, inject, signal } from '@angular/core';

import { ElectronService, StreamWorkerConfig } from './electron.service';
import { ComponentService } from './component.service';

/** Hardware-based recommendation about whether multiple workers will help. */
export interface WorkerAdvice {
  /** Suggested worker count for this machine (1 on CUDA / plain CPU). */
  recommended: number;
  /** Whether enabling multiple workers is actually worth it here. */
  worthwhile: boolean;
  /** Tone for the advice banner. */
  level: 'good' | 'neutral' | 'discouraged';
  message: string;
}

/**
 * Multi-worker capability gate, shared across the app.
 *
 * Parallel TTS workers each load their own model copy (~5 GB RAM) and only help
 * on shared-memory Apple Silicon — on a GPU the engine serializes to 1 worker,
 * and on most CPUs extra workers just oversubscribe the cores. So multi-worker
 * is an opt-in capability: a single checkbox (first-run setup + Settings) unlocks
 * a 1–4 count that becomes the per-machine default for every worker control —
 * the TTS server, the processing pipeline, and the browser extension.
 *
 * The main process (xtts-worker-pool / tts-stream.json) is the source of truth;
 * this service mirrors it for the renderer and writes back through IPC.
 */
@Injectable({ providedIn: 'root' })
export class WorkerConfigService {
  private readonly electron = inject(ElectronService);
  private readonly components = inject(ComponentService);

  readonly config = signal<StreamWorkerConfig | null>(null);

  /** Hard ceiling — beyond 4, workers fight each other for memory bandwidth. */
  readonly HARD_MAX = 4;

  /**
   * Hardware-driven advice, derived from the machine's SystemProfile (detected by
   * the component system). The honest message most people should see is "leave it
   * off"; only shared-memory Apple Silicon really benefits.
   */
  readonly advice = computed<WorkerAdvice>(() => {
    const p = this.components.profile();
    if (!p) {
      return { recommended: 1, worthwhile: false, level: 'neutral', message: 'Checking your hardware…' };
    }
    const ramGB = Math.round(p.ramMB / 1024);

    // The advice depends on the device the engine will actually run on. A CUDA
    // GPU only serializes when it's the active device — force CPU and the
    // workers run on cores in parallel, just like any other CPU.
    const runsOnGpu = p.cuda?.available && this.devicePref() !== 'cpu';

    // NVIDIA/CUDA (and not forced to CPU): decode serializes on the GPU.
    if (runsOnGpu) {
      const name = p.cuda.name ? ` (${p.cuda.name})` : '';
      return {
        recommended: 1,
        worthwhile: false,
        level: 'discouraged',
        message: `Your NVIDIA GPU${name} runs TTS decode one step at a time, so extra workers just fight over the GPU. Leave this off — 1 worker is fastest. (Switch the engine to CPU below if you want to use multiple workers.)`,
      };
    }

    // Apple Silicon: unified/shared memory is the one case that scales near-linearly.
    if (p.appleSilicon) {
      // ~5 GB per worker, keep ~4 GB headroom, capped at 4 (bandwidth ceiling).
      const rec = Math.min(this.HARD_MAX, Math.max(1, Math.floor((ramGB - 4) / 5)));
      return rec >= 2
        ? {
            recommended: rec,
            worthwhile: true,
            level: 'good',
            message: `Apple Silicon with ${ramGB} GB shared memory — the machine that benefits most. About ${rec} workers is the sweet spot; past 4 they compete for memory bandwidth, so 4 is the ceiling.`,
          }
        : {
            recommended: 1,
            worthwhile: false,
            level: 'neutral',
            message: `Apple Silicon, but only ${ramGB} GB shared memory — there isn't room for more than 1 worker (each needs ~5 GB).`,
          };
    }

    // Plain CPU (Windows/Linux x86, Intel Mac, or a GPU box forced to CPU).
    // Workers DO run in parallel across cores — but each needs ~5 GB RAM and
    // they share memory bandwidth, so the speedup is modest, not near-linear.
    const rec = Math.min(this.HARD_MAX, Math.max(1, Math.floor((ramGB - 4) / 5)));
    const forcedCpu = p.cuda?.available && this.devicePref() === 'cpu';
    if (rec >= 2) {
      return {
        recommended: Math.min(rec, 2),
        worthwhile: true,
        level: 'neutral',
        message: `${forcedCpu ? 'Running on CPU (GPU disabled): ' : ''}workers run in parallel across your cores, but each needs ~5 GB RAM (${ramGB} GB total) and they share memory bandwidth, so expect a modest speedup, not ${rec}×. Try 2 first.`,
      };
    }
    return {
      recommended: 1,
      worthwhile: false,
      level: 'discouraged',
      message: `Not enough RAM for more than 1 worker (each needs ~5 GB; you have ${ramGB} GB).`,
    };
  });

  /** True when the engine runs TTS on CUDA, where worker count is moot. */
  readonly isCudaMachine = computed(() => !!this.components.profile()?.cuda?.available);

  /** Whether the user has unlocked multiple workers. */
  readonly enabled = computed(() => this.config()?.enabled ?? false);
  /** The chosen 1–4 count (remembered even while disabled). */
  readonly count = computed(() => this.config()?.count ?? 2);
  /** What worker controls should actually use: the count when enabled, else 1. */
  readonly effectiveCount = computed(() => (this.enabled() ? this.count() : 1));
  readonly min = computed(() => this.config()?.minWorkers ?? 1);
  readonly max = computed(() => this.config()?.maxWorkers ?? 4);
  /** True on a machine the engine runs on CUDA, where extra workers do nothing. */
  readonly isCuda = computed(() => this.config()?.device === 'cuda');

  constructor() {
    void this.refresh();
    // The advisor reads the machine's SystemProfile — make sure it's loaded even
    // if the Add-ons tab hasn't been opened yet.
    void this.components.ensureLoaded();
  }

  async refresh(): Promise<void> {
    const result = await this.electron.ttsStreamWorkerConfig();
    if (result.success && result.data) {
      this.config.set(result.data);
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const result = await this.electron.ttsStreamSetWorkerConfig({ enabled });
    if (result.success && result.data) {
      this.config.set(result.data);
    }
  }

  async setCount(count: number): Promise<void> {
    const result = await this.electron.ttsStreamSetWorkerConfig({ count });
    if (result.success && result.data) {
      this.config.set(result.data);
    }
  }

  /** Streaming-engine device preference ('auto' | 'cpu' | 'gpu' | 'mps'). */
  readonly devicePref = computed(() => this.config()?.devicePref ?? 'auto');

  async setDevicePref(devicePref: 'auto' | 'cpu' | 'gpu' | 'mps'): Promise<void> {
    const result = await this.electron.ttsStreamSetWorkerConfig({ devicePref });
    if (result.success && result.data) {
      this.config.set(result.data);
    }
  }
}
