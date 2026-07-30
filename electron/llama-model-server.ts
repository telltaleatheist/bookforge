/**
 * llama-model-server — one lifecycle for every fine-tune we serve ourselves.
 *
 * BookForge ships two small task-specific fine-tunes that are not chat models:
 * the page-layout model (rubric) and the footnote-marker remover (dagger). Both
 * want the same thing — the BUNDLED llama-server, held on a private loopback
 * port, spawned on first use, idle-shut-down, and sequenced against every other
 * GPU tenant through the arbiter. Only the numbers differ.
 *
 * /completion, NOT /v1/chat/completions. The prompt has to arrive VERBATIM.
 * These models were trained under Qwen3's chat template with thinking disabled,
 * which inserts an empty `<think>\n\n</think>` block that stock templates omit —
 * so any server that builds the prompt itself feeds the model a shape it never
 * saw, and the answers degrade in a way that reads as a bad model rather than a
 * bad client. `/completion` takes the prompt as given; the chat endpoint cannot.
 *
 * SEPARATE instances rather than one shared server. They hold different models,
 * so sharing would mean unloading and reloading several GB whenever a user
 * alternates between tasks. Each registers its OWN owner label with the arbiter
 * so they are sequenced instead of fighting over the device.
 *
 * Nothing here knows what a page or a footnote is: a caller hands over prompts
 * it built itself and gets back raw completions. Prompt formats live with the
 * feature that owns them.
 */
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

import { resolveLlamaServerBinary } from './llama-bridge';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { systemProbe } from './components/system-probe';

/** Long enough to be useful across a book, short enough to give the RAM back. */
const IDLE_SHUTDOWN_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 3 * 60_000;

/** What a server needs to know about the model it was asked to load. */
export interface ResolvedModel {
  /** User-facing name, for the "not downloaded yet" message. */
  name: string;
  /** Absolute path to the GGUF. */
  path: string;
  /** On disk at its full expected size — NOT mere existence. */
  present: boolean;
}

export interface LlamaModelServerConfig {
  /** Log prefix, e.g. 'rubric' → `[rubric] …`. */
  logTag: string;
  /** How the model is named in errors the user reads, e.g. 'page-layout model'. */
  modelLabel: string;
  /** Loopback port. Must be unique across every server this app may run. */
  port: number;
  /** `-c`. Size it against the CORPUS, never guess — see the callers. */
  contextSize: number;
  /** Full-offload threshold; under it, run on CPU rather than fail to allocate. */
  neededVramMB: number;
  /** Arbiter owner label. Distinct per server, so two never co-reside. */
  gpuOwner: string;
  /** `n_predict`. A hard ceiling on one answer. */
  maxPredict: number;
  /**
   * How long to wait for the GPU before proceeding without the lock. Undefined
   * means wait indefinitely — correct for a server whose model is large enough
   * that co-residency would OOM.
   */
  gpuAcquireTimeoutMs?: number;
  /** Catalog lookup. Null when the id is not a model this server can serve. */
  resolveModel(modelId: string): ResolvedModel | null;
}

export interface LlamaGenerateResult {
  success: boolean;
  answers?: string[];
  error?: string;
}

export class LlamaModelServer {
  private proc: ChildProcess | null = null;
  private ready = false;
  private loadedModelId: string | null = null;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private holdsGpu = false;

  constructor(private readonly cfg: LlamaModelServerConfig) {}

  get port(): number { return this.cfg.port; }
  get endpoint(): string { return `http://127.0.0.1:${this.cfg.port}`; }
  get running(): boolean { return this.ready && this.proc !== null; }
  get modelId(): string | null { return this.loadedModelId; }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, IDLE_SHUTDOWN_MS);
  }

  private releaseGpuIfHeld(): void {
    if (!this.holdsGpu) return;
    this.holdsGpu = false;
    releaseGpu(this.cfg.gpuOwner);
  }

  /**
   * Ensure a server is up holding `modelId`.
   *
   * A request for a DIFFERENT model stops the current server first — one process
   * per model, and two multi-GB servers is not a trade anyone asked for.
   */
  async ensure(modelId: string): Promise<void> {
    if (this.ready && this.loadedModelId === modelId) { this.touch(); return; }
    if (this.starting) {
      await this.starting;
      if (this.ready && this.loadedModelId === modelId) { this.touch(); return; }
    }
    if (this.proc && this.loadedModelId !== modelId) await this.stop();

    this.starting = this.start(modelId).finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(modelId: string): Promise<void> {
    const model = this.cfg.resolveModel(modelId);
    if (!model) throw new Error(`Unknown ${this.cfg.modelLabel}: ${modelId}`);
    if (!model.present) {
      throw new Error(
        `The ${this.cfg.modelLabel} is not downloaded yet. `
        + `Install "${model.name}" from Settings.`);
    }
    const binary = resolveLlamaServerBinary();
    if (!binary) {
      throw new Error(
        'The local model runtime (llama-server) is not installed with this build.');
    }

    await acquireGpu(this.cfg.gpuOwner, { timeoutMs: this.cfg.gpuAcquireTimeoutMs });
    this.holdsGpu = true;
    try {
      await this.spawnServer(binary, model.path, modelId);
    } catch (err) {
      this.releaseGpuIfHeld();
      throw err;
    }
  }

  /**
   * Layers to offload: all of them, or none.
   *
   * No partial ladder like llama-bridge's, because these models are small enough
   * that the question is binary — a card that cannot hold the weights plus the
   * KV cache cannot hold a useful fraction of them either, and a partial offload
   * would spend PCIe traffic per token to save little.
   *
   * `-ngl 99` unconditionally would hard-OOM on a small card with an error about
   * buffer allocation, which reads as a broken model rather than a small GPU.
   * Apple Silicon is exempt: unified memory means "VRAM" is system RAM, and the
   * probe reports no CUDA device there.
   */
  private async computeNgl(): Promise<{ ngl: number; note: string }> {
    if (process.platform === 'darwin') {
      return { ngl: 99, note: 'Metal, unified memory' };
    }
    try {
      const profile = await systemProbe.profile();
      const vramMB = profile.cuda?.vramMB ?? 0;
      if (!profile.cuda?.available || vramMB <= 0) {
        return { ngl: 0, note: 'no GPU detected → CPU' };
      }
      if (vramMB < this.cfg.neededVramMB) {
        return {
          ngl: 0,
          note: `${Math.round(vramMB / 1024)}GB VRAM < `
            + `${Math.round(this.cfg.neededVramMB / 1024)}GB needed → CPU`,
        };
      }
      return { ngl: 99, note: `full offload (${Math.round(vramMB / 1024)}GB VRAM)` };
    } catch {
      // A probe failure must not stop the feature: CPU is slower, not broken.
      return { ngl: 0, note: 'GPU probe failed → CPU' };
    }
  }

  private async spawnServer(binary: string, modelPath: string, modelId: string): Promise<void> {
    const { logTag, modelLabel, port, contextSize } = this.cfg;
    const { ngl, note } = await this.computeNgl();
    console.log(`[${logTag}] ${modelId}: -ngl ${ngl}, -c ${contextSize} (${note})`);
    return new Promise<void>((resolve, reject) => {
      const args = [
        '-m', modelPath,
        '--port', String(port),
        '--host', '127.0.0.1',   // never listen off-box
        '-c', String(contextSize),
        '-np', '1',              // one request at a time; the device serializes anyway
        '-ngl', String(ngl),     // see computeNgl — all or nothing for this size
        '--no-webui',
      ];

      const env = { ...process.env };
      if (process.platform === 'darwin') {
        // macOS: the llama.cpp dylibs ship alongside the binary.
        env.DYLD_LIBRARY_PATH = `${path.dirname(binary)}:${env.DYLD_LIBRARY_PATH || ''}`;
      }

      const proc = spawn(binary, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Windows needs cwd at the binary dir so it finds its DLLs.
        cwd: process.platform === 'win32' ? path.dirname(binary) : undefined,
        windowsHide: true,
      });
      this.proc = proc;
      this.loadedModelId = modelId;

      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.kill(); } catch { /* ignore */ }
        reject(new Error(message));
      };
      const timer = setTimeout(
        () => fail(`The ${modelLabel} did not load within 3 minutes.`),
        STARTUP_TIMEOUT_MS);

      // Readiness comes from the log line, not from a poll loop: llama-server
      // binds the port before the weights are in, so a successful connect is not
      // a promise that it can answer.
      const watch = (chunk: Buffer) => {
        const text = chunk.toString();
        if (!settled && /server is listening|HTTP server listening|starting the main loop/i.test(text)) {
          settled = true;
          clearTimeout(timer);
          this.ready = true;
          this.touch();
          resolve();
        }
        // Keep the tail for diagnosis; llama-server is chatty, so only errors.
        if (/error|failed|unable/i.test(text)) {
          console.warn(`[${logTag}] llama-server:`, text.trim().split('\n').slice(-2).join(' '));
        }
      };
      proc.stdout?.on('data', watch);
      proc.stderr?.on('data', watch);

      proc.on('error', (err) => fail(`Could not start the ${modelLabel}: ${err.message}`));
      proc.on('exit', (code) => {
        this.ready = false;
        this.proc = null;
        this.loadedModelId = null;
        this.releaseGpuIfHeld();
        if (!settled) fail(`The ${modelLabel} exited during startup (code ${code}).`);
      });
    });
  }

  /** Stop the server and give the memory back. Idempotent. */
  async stop(): Promise<void> {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const proc = this.proc;
    this.ready = false;
    this.proc = null;
    this.loadedModelId = null;
    if (!proc) { this.releaseGpuIfHeld(); return; }
    await new Promise<void>((resolve) => {
      const done = setTimeout(() => {
        // Escalate: a wedged llama-server holding several GB is worse than a
        // hard kill of a process with no state worth saving.
        try {
          if (process.platform === 'win32' && proc.pid) {
            spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
          } else {
            proc.kill('SIGKILL');
          }
        } catch { /* already gone */ }
        resolve();
      }, 5000);
      proc.once('exit', () => { clearTimeout(done); resolve(); });
      try { proc.kill(); } catch { clearTimeout(done); resolve(); }
    });
    this.releaseGpuIfHeld();
  }

  /**
   * Generate for a batch of pre-templated prompts, in order.
   *
   * Sequential on purpose — `-np 1`, and one device. Batching here would only
   * move the queue, and it would make a mid-batch failure lose the prompts that
   * had already succeeded.
   */
  async generate(
    modelId: string,
    prompts: string[],
    stop?: string,
  ): Promise<LlamaGenerateResult> {
    try {
      await this.ensure(modelId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const answers: string[] = [];
    for (const prompt of prompts) {
      this.touch();
      let res: Response;
      try {
        res = await fetch(`${this.endpoint}/completion`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,              // VERBATIM — see the file header
            temperature: 0,      // a deterministic task: greedy, never sampled
            n_predict: this.cfg.maxPredict,
            stop: stop ? [stop] : undefined,
            // Prompts from one caller share a long system prefix, so the KV for
            // it is reused instead of re-prefilled on every request.
            cache_prompt: true,
          }),
        });
      } catch (err) {
        return {
          success: false,
          error: `lost the connection to the ${this.cfg.modelLabel}: `
            + `${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const body = await res.json() as { content?: string; error?: unknown };
      if (!res.ok) {
        const message = typeof body.error === 'string'
          ? body.error
          : JSON.stringify(body.error ?? `HTTP ${res.status}`);
        return { success: false, error: message };
      }
      answers.push(body.content ?? '');
    }
    return { success: true, answers };
  }
}
