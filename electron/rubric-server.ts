/**
 * rubric-server — runs the block-category model on the BUNDLED llama-server.
 *
 * The Detect path used to require Ollama: the user had to install it, then
 * `ollama create` the model from a Modelfile by hand. That is not a thing to ask
 * of someone who wants to make an audiobook, and it meant the model could not be
 * shipped as a download. llama-server already comes with the app for local AI
 * cleanup, so pointing a second instance at the rubric GGUF removes the external
 * dependency entirely.
 *
 * /completion, NOT /v1/chat/completions. The prompt has to arrive VERBATIM.
 * Training used Qwen3's chat template with thinking disabled, which inserts an
 * empty `<think>\n\n</think>` block that stock templates omit — so any server
 * that builds the prompt itself feeds the model a shape it never saw, and the
 * answers degrade in a way that reads as a bad model rather than a bad client.
 * That is the same reason the Ollama path used `raw: true`. `/completion` takes
 * the prompt as given; the chat endpoint cannot.
 *
 * SEPARATE from llama-bridge's server rather than sharing it. They hold
 * different models, so sharing would mean unloading and reloading several GB
 * whenever a user alternates between AI cleanup and Detect. The GPU arbiter
 * exists to sequence exactly this, and both register as owners.
 *
 * Lifecycle mirrors llama-bridge: spawn on first use, idle-shutdown after a
 * quiet period, and stop on quit. The model is several GB, and Detect is
 * something you do for a few minutes per book.
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

import { resolveLlamaServerBinary } from './llama-bridge';
import { rubricModelPath, isRubricModelPresent, getRubricModelDef } from './rubric-models';
import { acquireGpu, releaseGpu } from './gpu-arbiter';
import { systemProbe } from './components/system-probe';

/** Owner label for the arbiter — distinct from llama:cleanup, same device. */
export const GPU_OWNER_RUBRIC = 'llama:rubric';

/**
 * 12288, explicitly, and it is sized against the CORPUS, not guessed.
 *
 * This was 8192 when the longest real page measured 6,529 tokens. v4's
 * split-only segmentation cuts dense pages far finer — the longest page now
 * measures 10,404 tokens (measured with the real Qwen3 tokenizer over the whole
 * v4 SFT corpus), plus roughly 400 for the answer. At 8192 those pages were
 * silently truncated before the model ever saw them, and truncation lands on the
 * END of the block list, so the model simply stops answering for blocks it was
 * never shown. That reads as "the new model dropped blocks" rather than "the
 * server cut the prompt", which is the wrong place to go looking.
 *
 * Still not left to the model's own 40960: the KV cache would be several times
 * larger for context nothing uses. RE-MEASURE THIS WHENEVER SEGMENTATION
 * CHANGES — it is a property of how finely pages get cut, not of the model.
 */
const CONTEXT = 12288;

/** Long enough to be useful across a book, short enough to give the RAM back. */
const IDLE_SHUTDOWN_MS = 5 * 60_000;
const STARTUP_TIMEOUT_MS = 3 * 60_000;

/** Port for the rubric server. Distinct from llama-bridge's, since both may run. */
const PORT = 8769;

/**
 * VRAM needed for full offload: ~2.4 GB of Q4_K_M weights plus a ~1.1 GB KV
 * cache at 8k, rounded up for the compute buffers. Under this, run on CPU
 * rather than fail to allocate. See computeNgl.
 */
const NEEDED_VRAM_MB = 4608;

export interface RubricGenerateResult {
  success: boolean;
  answers?: string[];
  error?: string;
}

class RubricServer {
  private proc: ChildProcess | null = null;
  private ready = false;
  private loadedModelId: string | null = null;
  private starting: Promise<void> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private holdsGpu = false;

  get port(): number { return PORT; }
  get endpoint(): string { return `http://127.0.0.1:${PORT}`; }
  get running(): boolean { return this.ready && this.proc !== null; }
  get modelId(): string | null { return this.loadedModelId; }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.stop(); }, IDLE_SHUTDOWN_MS);
  }

  private releaseGpuIfHeld(): void {
    if (!this.holdsGpu) return;
    this.holdsGpu = false;
    releaseGpu(GPU_OWNER_RUBRIC);
  }

  /**
   * Ensure a server is up holding `modelId`.
   *
   * A request for a DIFFERENT model stops the current server first — one process
   * per model, and two 2.5 GB servers is not a trade anyone asked for.
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
    const def = getRubricModelDef(modelId);
    if (!def) throw new Error(`Unknown page-layout model: ${modelId}`);
    if (!isRubricModelPresent(modelId)) {
      throw new Error(
        `The page-layout model is not downloaded yet. Install "${def.name}" from Settings.`);
    }
    const binary = resolveLlamaServerBinary();
    if (!binary) {
      throw new Error(
        'The local model runtime (llama-server) is not installed with this build.');
    }
    const modelPath = rubricModelPath(modelId);

    await acquireGpu(GPU_OWNER_RUBRIC);
    this.holdsGpu = true;
    try {
      await this.spawnServer(binary, modelPath, modelId);
    } catch (err) {
      this.releaseGpuIfHeld();
      throw err;
    }
  }

  /**
   * Layers to offload: all of them, or none.
   *
   * No partial ladder like llama-bridge's, because this model is small enough
   * that the question is binary — 2.4 GB of weights plus a 1.1 GB KV cache at
   * 8k, so ~3.5 GB. A card that cannot hold that cannot hold a useful fraction
   * of it either, and a partial offload would spend PCIe traffic per token to
   * save little.
   *
   * `-ngl 99` unconditionally would hard-OOM on a 4 GB card with an error about
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
      if (vramMB < NEEDED_VRAM_MB) {
        return {
          ngl: 0,
          note: `${Math.round(vramMB / 1024)}GB VRAM < ${Math.round(NEEDED_VRAM_MB / 1024)}GB needed → CPU`,
        };
      }
      return { ngl: 99, note: `full offload (${Math.round(vramMB / 1024)}GB VRAM)` };
    } catch {
      // A probe failure must not stop Detect: CPU is slower, not broken.
      return { ngl: 0, note: 'GPU probe failed → CPU' };
    }
  }

  private async spawnServer(binary: string, modelPath: string, modelId: string): Promise<void> {
    const { ngl, note } = await this.computeNgl();
    console.log(`[rubric] ${modelId}: -ngl ${ngl}, -c ${CONTEXT} (${note})`);
    return new Promise<void>((resolve, reject) => {
      const args = [
        '-m', modelPath,
        '--port', String(PORT),
        '--host', '127.0.0.1',   // never listen off-box
        '-c', String(CONTEXT),
        '-np', '1',              // one page at a time; the device serializes anyway
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
        () => fail('The page-layout model did not load within 3 minutes.'),
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
          console.warn('[rubric] llama-server:', text.trim().split('\n').slice(-2).join(' '));
        }
      };
      proc.stdout?.on('data', watch);
      proc.stderr?.on('data', watch);

      proc.on('error', (err) => fail(`Could not start the page-layout model: ${err.message}`));
      proc.on('exit', (code) => {
        this.ready = false;
        this.proc = null;
        this.loadedModelId = null;
        this.releaseGpuIfHeld();
        if (!settled) fail(`The page-layout model exited during startup (code ${code}).`);
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
   * move the queue, and it would make a mid-batch failure lose the pages that
   * had already succeeded.
   */
  async generate(
    modelId: string,
    prompts: string[],
    stop?: string,
  ): Promise<RubricGenerateResult> {
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
            temperature: 0,      // classification: greedy, never sampled
            n_predict: 2048,
            stop: stop ? [stop] : undefined,
            // Every page shares the same long system prefix, so the KV for it is
            // reused instead of re-prefilled ~1,500 tokens per page.
            cache_prompt: true,
          }),
        });
      } catch (err) {
        return {
          success: false,
          error: `lost the connection to the page-layout model: `
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

export const rubricServer = new RubricServer();

/** Stop the server — for quit, and for deleting the model it has open. */
export async function stopRubricServer(): Promise<void> {
  await rubricServer.stop();
}

/** Whether a GGUF for `modelId` is on disk (re-exported for the IPC layer). */
export function rubricModelInstalled(modelId: string): boolean {
  try {
    return isRubricModelPresent(modelId) && fs.existsSync(rubricModelPath(modelId));
  } catch {
    return false;
  }
}
