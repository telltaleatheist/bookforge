/**
 * Llama bridge — bundled local LLM for offline AI cleanup (WS2).
 *
 * Ports Briefcase's llama.cpp integration: spawns a persistent `llama-server`
 * binary on a local port and generates via its OpenAI-compatible
 * `/v1/chat/completions` endpoint. Owns the Cogito GGUF catalog, a
 * hardware-aware recommendation, single-file model downloads (progress +
 * cancel), and the server's start/stop/idle lifecycle.
 *
 * Binary:   resources/bin/llama-server-<arch>  (mac/linux) | llama-server.exe (win)
 * Models:   <userData>/llama-models/*.gguf
 * Active:   <userData>/llama-models/active-model.json   { activeModelId }
 *
 * The binary is OPTIONAL — if it isn't bundled (lean seed), localStatus()
 * reports binaryPresent:false and the wizard steers the user to Ollama / an API
 * key instead. Everything downstream degrades gracefully.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { app } from 'electron';

import { downloadFile } from './components/downloader';
import { systemProbe } from './components/system-probe';
import { componentManager } from './components/component-manager';
import { LLAMA_CUDA_ID } from './components/llama-cuda';
import { getManagedBinaryPath } from './update/managed-bins';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog (Cogito GGUFs — bartowski quants on HuggingFace, direct resolve URLs)
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalModelInfo {
  id: string;
  name: string;
  filename: string;
  url: string;
  sizeGB: number;
  minRAM: number;        // GB of (V)RAM the quant comfortably needs
  layers: number;        // transformer block count — for VRAM-aware partial GPU offload
  description: string;
  downloaded: boolean;   // filled in by listModels()
  isActive: boolean;     // filled in by listModels()
  recommended: boolean;  // filled in by listModels() from the current machine
  fits: boolean;         // filled in by listModels(): runs fully/fast on this machine (minRAM ≤ effectiveGB)
}

type CatalogEntry = Omit<LocalModelInfo, 'downloaded' | 'isActive' | 'recommended' | 'fits'>;

const HF = 'https://huggingface.co/bartowski';

const COGITO_MODELS: CatalogEntry[] = [
  {
    id: 'cogito-3b',
    name: 'Cogito 3B',
    filename: 'deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf',
    url: `${HF}/deepcogito_cogito-v1-preview-llama-3B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-3B-Q4_K_M.gguf`,
    sizeGB: 2.24,
    minRAM: 4,
    layers: 28,
    description: 'Lightweight and fast. Works on most GPUs (4GB+) or CPU.',
  },
  {
    id: 'cogito-8b',
    name: 'Cogito 8B',
    filename: 'deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf',
    url: `${HF}/deepcogito_cogito-v1-preview-llama-8B-GGUF/resolve/main/deepcogito_cogito-v1-preview-llama-8B-Q4_K_M.gguf`,
    sizeGB: 4.92,
    minRAM: 6,
    layers: 32,
    description: 'Good balance of quality and speed. Great on 6GB+ GPU.',
  },
  {
    id: 'cogito-14b',
    name: 'Cogito 14B',
    filename: 'deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf',
    url: `${HF}/deepcogito_cogito-v1-preview-qwen-14B-GGUF/resolve/main/deepcogito_cogito-v1-preview-qwen-14B-Q4_K_M.gguf`,
    sizeGB: 8.99,
    minRAM: 10,
    layers: 48,
    description: 'Higher quality results. Runs on 10GB+ GPU or 16GB+ RAM.',
  },
  {
    id: 'cogito-32b',
    name: 'Cogito 32B',
    filename: 'deepcogito_cogito-v1-preview-qwen-32B-Q4_K_M.gguf',
    url: `${HF}/deepcogito_cogito-v1-preview-qwen-32B-GGUF/resolve/main/deepcogito_cogito-v1-preview-qwen-32B-Q4_K_M.gguf`,
    sizeGB: 19.85,
    minRAM: 24,
    layers: 64,
    description: 'Best quality. Needs a 24GB+ GPU or a 32GB+ unified-memory Mac.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface LocalModelProgress {
  modelId: string;
  pct: number;            // 0–100
  receivedBytes: number;
  totalBytes: number;
  speed?: string;         // e.g. "12.3 MB/s"
  eta?: string;           // e.g. "1m 40s"
  phase: 'download' | 'done' | 'error' | 'cancelled';
  message?: string;
}

export interface LocalSystemInfo {
  platform: NodeJS.Platform;
  totalRamGB: number;
  cuda: boolean;
  cudaName?: string;
  vramGB?: number;
  effectiveGB: number;     // VRAM if a usable GPU is present, else system RAM
  recommendedModelId: string;
}

export interface LocalStatus {
  binaryPresent: boolean;
  ready: boolean;                  // server is up and serving
  activeModelId: string | null;
  activeModelDownloaded: boolean;
  anyModelDownloaded: boolean;
  modelsDir: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8769;
const STARTUP_TIMEOUT_MS = 120_000;  // model load can be slow on a cold cache
const GENERATE_TIMEOUT_MS = 300_000; // a long chunk on CPU
const IDLE_SHUTDOWN_MS = 5 * 60_000;

function getModelsDir(): string {
  const dir = path.join(app.getPath('userData'), 'llama-models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getActiveConfigPath(): string {
  return path.join(getModelsDir(), 'active-model.json');
}

/**
 * Resolve the llama-server binary to run.
 *
 * On Windows we ship the small CPU-only build in resources/bin and offer the
 * CUDA build as an optional component (see components/llama-cuda.ts). When that
 * pack is installed, prefer its GPU binary so local AI cleanup runs on the GPU.
 *
 * Otherwise mirror mutool-bridge's resolution: process.resourcesPath/bin
 * (packaged) → the repo's resources/bin (dev). Returns null when no binary is
 * available.
 */
function resolveBinary(): string | null {
  // Downloaded CUDA pack wins when present (Windows only).
  if (process.platform === 'win32') {
    const cudaEntry = componentManager.resolveEntry(LLAMA_CUDA_ID);
    if (cudaEntry) return cudaEntry;
  }

  // A managed (server-pushed, auto-updated) llama-server, if installed, ranks above the bundled
  // resources/bin copy so binary updates we publish take effect. The Windows CUDA pack above
  // still wins when present.
  const managed = getManagedBinaryPath('llama-server');
  if (managed) return managed;

  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const isWin = process.platform === 'win32';
  const names = isWin
    ? ['llama-server.exe']
    : [`llama-server-${arch}`, 'llama-server'];

  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath || '';
  const roots = [
    path.join(resourcesPath, 'bin'),
    path.join(__dirname, '..', '..', 'resources', 'bin'),
  ];

  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model management
// ─────────────────────────────────────────────────────────────────────────────

function getActiveModelId(): string | null {
  try {
    const raw = fs.readFileSync(getActiveConfigPath(), 'utf-8');
    const parsed = JSON.parse(raw) as { activeModelId?: string };
    return parsed.activeModelId || null;
  } catch {
    return null;
  }
}

function setActiveModelId(modelId: string | null): void {
  const tmp = getActiveConfigPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ activeModelId: modelId }, null, 2));
  fs.renameSync(tmp, getActiveConfigPath());
}

function isDownloaded(entry: CatalogEntry): boolean {
  try {
    const p = path.join(getModelsDir(), entry.filename);
    return fs.existsSync(p) && fs.statSync(p).size > 100 * 1024 * 1024; // >100MB = real
  } catch {
    return false;
  }
}

async function systemInfo(): Promise<LocalSystemInfo> {
  const prof = await systemProbe.profile();
  const totalRamGB = Math.round((prof.ramMB / 1024) * 10) / 10;
  const usableGpu = prof.cuda.available && (prof.cuda.vramMB ?? 0) >= 4096;
  const vramGB = prof.cuda.vramMB ? Math.round((prof.cuda.vramMB / 1024) * 10) / 10 : undefined;
  // Apple Silicon shares unified memory → use system RAM as the budget.
  const effectiveGB = usableGpu && vramGB ? vramGB : totalRamGB;

  let recommendedModelId: string;
  if (effectiveGB >= 24) recommendedModelId = 'cogito-32b';
  else if (effectiveGB >= 10) recommendedModelId = 'cogito-14b';
  else if (effectiveGB >= 6) recommendedModelId = 'cogito-8b';
  else recommendedModelId = 'cogito-3b';

  return {
    platform: process.platform,
    totalRamGB,
    cuda: prof.cuda.available,
    cudaName: prof.cuda.name,
    vramGB,
    effectiveGB: Math.round(effectiveGB * 10) / 10,
    recommendedModelId,
  };
}

async function listModels(): Promise<LocalModelInfo[]> {
  const info = await systemInfo();
  const activeId = getActiveModelId();
  return COGITO_MODELS.map((m) => ({
    ...m,
    downloaded: isDownloaded(m),
    isActive: m.id === activeId,
    recommended: m.id === info.recommendedModelId,
    // Runs fully on this machine (fast). Bigger models still download/run, but
    // partly on CPU and slowly — the UI dims them and warns.
    fits: m.minRAM <= info.effectiveGB,
  }));
}

async function status(): Promise<LocalStatus> {
  const activeId = getActiveModelId();
  const active = activeId ? COGITO_MODELS.find((m) => m.id === activeId) : undefined;
  const downloaded = COGITO_MODELS.filter(isDownloaded);
  return {
    binaryPresent: resolveBinary() !== null,
    ready: server.isReady(),
    activeModelId: activeId,
    activeModelDownloaded: active ? isDownloaded(active) : false,
    anyModelDownloaded: downloaded.length > 0,
    modelsDir: getModelsDir(),
  };
}

// In-flight download per model id (for cancel).
const downloads = new Map<string, AbortController>();

function fmtBytesPerSec(bps: number): string {
  const mb = bps / (1024 * 1024);
  return `${mb.toFixed(1)} MB/s`;
}

function fmtEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function downloadModel(
  modelId: string,
  onProgress: (p: LocalModelProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const entry = COGITO_MODELS.find((m) => m.id === modelId);
  if (!entry) return { ok: false, error: `Unknown model: ${modelId}` };

  if (downloads.has(modelId)) {
    return { ok: false, error: 'Download already in progress' };
  }

  const dest = path.join(getModelsDir(), entry.filename);
  const tmp = dest + '.download';
  const controller = new AbortController();
  downloads.set(modelId, controller);

  // Compute speed/ETA from the downloader's byte progress (throttled to ~1/s).
  let lastTick = 0;
  let lastBytes = 0;
  let speed = '';
  let eta = '';

  try {
    await downloadFile(
      entry.url,
      tmp,
      modelId,
      (p) => {
        const received = p.receivedBytes ?? 0;
        const total = p.totalBytes ?? 0;
        const now = Date.now();
        if (now - lastTick >= 1000 && received > lastBytes) {
          const bps = ((received - lastBytes) / (now - lastTick)) * 1000;
          speed = fmtBytesPerSec(bps);
          eta = total > 0 ? fmtEta((total - received) / bps) : '';
          lastTick = now;
          lastBytes = received;
        }
        onProgress({
          modelId,
          pct: p.pct ?? 0,
          receivedBytes: received,
          totalBytes: total,
          speed,
          eta,
          phase: 'download',
          message: `Downloading ${entry.name}…`,
        });
      },
      controller.signal,
    );

    fs.renameSync(tmp, dest);
    downloads.delete(modelId);

    // First model downloaded becomes the active one automatically.
    if (!getActiveModelId()) setActiveModelId(modelId);

    onProgress({ modelId, pct: 100, receivedBytes: 0, totalBytes: 0, phase: 'done',
                 message: `${entry.name} ready.` });
    return { ok: true };
  } catch (err) {
    downloads.delete(modelId);
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    const aborted = controller.signal.aborted;
    const message = aborted ? 'Download cancelled' : (err instanceof Error ? err.message : String(err));
    onProgress({ modelId, pct: 0, receivedBytes: 0, totalBytes: 0,
                 phase: aborted ? 'cancelled' : 'error', message });
    return { ok: false, error: message };
  }
}

function cancelDownload(modelId: string): void {
  downloads.get(modelId)?.abort();
}

function deleteModel(modelId: string): { ok: boolean; error?: string } {
  const entry = COGITO_MODELS.find((m) => m.id === modelId);
  if (!entry) return { ok: false, error: `Unknown model: ${modelId}` };
  try {
    const p = path.join(getModelsDir(), entry.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    if (getActiveModelId() === modelId) {
      // Promote any other downloaded model, else clear.
      const next = COGITO_MODELS.find((m) => m.id !== modelId && isDownloaded(m));
      setActiveModelId(next ? next.id : null);
      if (server.activeModelId() === modelId) void server.stop();
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function setActive(modelId: string): { ok: boolean; error?: string } {
  const entry = COGITO_MODELS.find((m) => m.id === modelId);
  if (!entry) return { ok: false, error: `Unknown model: ${modelId}` };
  if (!isDownloaded(entry)) return { ok: false, error: `${entry.name} is not downloaded` };
  const prev = getActiveModelId();
  setActiveModelId(modelId);
  // If a different model was loaded, drop it so the next request loads the new one.
  if (prev !== modelId && server.activeModelId() === prev) void server.stop();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Server lifecycle + generation
// ─────────────────────────────────────────────────────────────────────────────

class LlamaServer {
  private proc: ChildProcess | null = null;
  private port = DEFAULT_PORT;
  private ready = false;
  private loadedModelId: string | null = null;
  private loadedBinary: string | null = null;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  isReady(): boolean {
    return this.ready && this.proc !== null;
  }

  activeModelId(): string | null {
    return this.loadedModelId;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, IDLE_SHUTDOWN_MS);
  }

  /** Start (or reuse) the server for the active model. Throws on failure. */
  private async ensureStarted(): Promise<void> {
    const activeId = getActiveModelId();
    if (!activeId) throw new Error('No local model selected. Download one in AI Setup.');
    const entry = COGITO_MODELS.find((m) => m.id === activeId);
    if (!entry || !isDownloaded(entry)) {
      throw new Error('The selected local model is not downloaded.');
    }

    const binary = resolveBinary();
    if (!binary) throw new Error('The local AI engine (llama-server) is not bundled in this build.');

    // Already serving the right model with the right binary (e.g. the CUDA pack
    // wasn't installed/removed since launch).
    if (this.ready && this.proc && this.loadedModelId === activeId && this.loadedBinary === binary) {
      this.touch();
      return;
    }
    // Serving a stale model, or the resolved binary changed (CUDA pack just
    // installed/removed) — restart so the new binary takes effect.
    if (this.proc && (this.loadedModelId !== activeId || this.loadedBinary !== binary)) {
      await this.stop();
    }
    if (this.starting) return this.starting;

    const modelPath = path.join(getModelsDir(), entry.filename);
    this.starting = this.spawnServer(binary, modelPath, activeId);
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Decide how many transformer layers to offload to the GPU.
   *
   * Blindly passing `-ngl 99` (offload everything) is the AI-cleanup bug on small
   * GPUs: a model larger than VRAM doesn't error — NVIDIA's "CUDA sysmem fallback"
   * silently spills the overflow into system RAM over PCIe, so the model "loads"
   * but generation crawls and returns EMPTY text (cleanup then no-ops / errors).
   * Instead, offload only as many layers as actually fit in VRAM and run the rest
   * on the CPU. Apple Silicon shares memory with Metal, so it still offloads all.
   */
  private async computeNgl(modelId: string): Promise<{ ngl: number; note: string }> {
    if (process.platform === 'darwin') return { ngl: 99, note: 'Metal (unified memory): full offload' };

    const info = await systemInfo();
    if (!info.cuda || !info.vramGB || info.vramGB < 4) {
      return { ngl: 0, note: 'no usable GPU → CPU' };
    }

    const entry = COGITO_MODELS.find((m) => m.id === modelId);
    const sizeGB = entry?.sizeGB ?? 0;
    const layers = entry?.layers ?? 0;
    const vram = info.vramGB;
    const HEADROOM_GB = 1.5; // display + KV cache (8K ctx) + compute buffers
    const budget = vram - HEADROOM_GB;

    if (sizeGB > 0 && sizeGB <= budget) {
      return { ngl: 99, note: `full offload (${sizeGB}GB fits in ${vram}GB VRAM)` };
    }
    if (layers > 0 && budget > 0 && sizeGB > 0) {
      const n = Math.max(0, Math.min(layers, Math.floor(layers * (budget / sizeGB))));
      if (n >= layers) return { ngl: 99, note: 'full offload' };
      if (n <= 0) return { ngl: 0, note: `${sizeGB}GB model too big for ${vram}GB VRAM → CPU` };
      return { ngl: n, note: `partial offload ${n}/${layers} layers (${sizeGB}GB model, ${vram}GB VRAM)` };
    }
    return { ngl: 0, note: `model exceeds ${vram}GB VRAM budget → CPU` };
  }

  private async spawnServer(binary: string, modelPath: string, modelId: string): Promise<void> {
    const { ngl, note } = await this.computeNgl(modelId);
    console.log(`[llama] GPU offload for ${modelId}: -ngl ${ngl} (${note})`);
    return new Promise<void>((resolve, reject) => {
      const args = [
        '-m', modelPath,
        '--port', String(this.port),
        '-c', '8192',          // context window
        '-ngl', String(ngl),   // VRAM-aware offload (see computeNgl) — avoids OOM-to-sysmem
        '--threads', '4',
      ];

      const env = { ...process.env };
      // macOS: llama.cpp dylibs ship alongside the binary.
      if (process.platform === 'darwin') {
        const binDir = path.dirname(binary);
        env.DYLD_LIBRARY_PATH = `${binDir}:${env.DYLD_LIBRARY_PATH || ''}`;
      }

      const proc = spawn(binary, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows needs the cwd at the binary dir so it finds its DLLs.
        cwd: process.platform === 'win32' ? path.dirname(binary) : undefined,
        windowsHide: true,
      });
      this.proc = proc;
      this.loadedModelId = modelId;
      this.loadedBinary = binary;

      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch { /* ignore */ }
        reject(new Error('llama-server did not start within 2 minutes.'));
      }, STARTUP_TIMEOUT_MS);

      const onReady = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.ready = true;
        this.touch();
        resolve();
      };

      const watch = (buf: Buffer) => {
        const s = buf.toString();
        if (/server is listening|HTTP server listening|llama server listening|listening on/i.test(s)) {
          onReady();
        }
      };
      proc.stdout?.on('data', watch);
      proc.stderr?.on('data', watch);

      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.proc = null;
        this.ready = false;
        reject(err);
      });

      proc.on('close', () => {
        this.proc = null;
        this.ready = false;
        this.loadedModelId = null;
        this.loadedBinary = null;
        if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const proc = this.proc;
    if (!proc) { this.ready = false; return; }
    this.ready = false;
    this.proc = null;
    this.loadedModelId = null;
    this.loadedBinary = null;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.once('close', finish);
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
          proc.kill('SIGTERM');
        }
      } catch { finish(); return; }
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(); }, 5000);
    });
  }

  /** Generate a completion via the OpenAI-compatible endpoint. */
  async generate(opts: {
    system?: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;
  }): Promise<string> {
    await this.ensureStarted();
    this.touch();

    const messages: Array<{ role: string; content: string }> = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: opts.prompt });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);

    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.loadedModelId || 'local',
          messages,
          max_tokens: opts.maxTokens ?? 4096,
          temperature: opts.temperature ?? 0.1,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`llama-server HTTP ${res.status}`);
      }
      const data = await res.json() as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> };
      const choice = data.choices?.[0];
      const text = choice?.message?.content ?? '';
      if (!text) {
        // Empty output despite a 200 is the classic VRAM-overflow symptom: the
        // model spilled into shared system memory and generated nothing usable.
        const reason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
        throw new Error(
          `The local AI model produced no text${reason}. This usually means the model is too large ` +
          `for your GPU — pick a smaller Cogito model in AI Setup (its recommendation fits your hardware).`,
        );
      }
      this.touch();
      return text;
    } catch (err) {
      if (controller.signal.aborted && !opts.signal?.aborted) {
        throw new Error(`llama-server timed out after ${GENERATE_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
}

const server = new LlamaServer();

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

export const llamaBridge = {
  catalog: (): CatalogEntry[] => COGITO_MODELS,
  listModels,
  systemInfo,
  status,
  downloadModel,
  cancelDownload,
  deleteModel,
  setActive,
  generate: (opts: Parameters<LlamaServer['generate']>[0]) => server.generate(opts),
  stop: () => server.stop(),
  /** True when a local model is selected, downloaded, and the binary is present. */
  isUsable: async (): Promise<boolean> => {
    const s = await status();
    return s.binaryPresent && s.activeModelDownloaded;
  },
};
