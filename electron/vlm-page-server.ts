/**
 * vlm-page-server — the document vision model, served from WSL, for as long as a
 * conversion needs it and no longer.
 *
 * `foundry vlm-convert` reads a page in one of two ways: locally through MLX,
 * which is Metal and therefore Apple Silicon only, or by POSTing the page to an
 * OpenAI-compatible server (`--vlm-endpoint`). On Windows the second is the only
 * one there is, and the reason is harder than the one that sends Orpheus to WSL.
 * Orpheus goes there because vLLM's CUDA graphs will not capture on native
 * Windows — a performance cliff. This goes there because **vLLM has no Windows
 * build at all**: `pip download vllm==0.11.0 --only-binary=:all:` against the
 * bundled interpreter answers `from versions: none` (measured 2026-08-07).
 *
 * The native alternative was measured rather than assumed, and rejected on the
 * numbers. dots.ocr under transformers DOES load and generate in BookForge's own
 * bundled env (torch 2.7.1+cu126, transformers 4.57.6, PyMuPDF already present) —
 * and it sat at 23.9 GB of VRAM and 12.8 GB of host RAM for a 3B model whose
 * weights are 6 GB, because there is no Windows flash-attn wheel for that torch
 * build and dots.ocr's vision tower falls back to EAGER attention over ~3,450
 * patches, which is quadratic. Through vLLM in WSL the same three pages of the
 * same book took 14.5 s wall — 4.8 s a page — inside a bounded reservation.
 *
 * ── What this module is, and is not ──────────────────────────────────────────
 *
 * It is the SAME hookup Orpheus has: the user points at a WSL conda env they
 * built and maintain themselves (Settings → Add-ons), and BookForge spawns into
 * it. It is deliberately NOT a managed component. A vLLM env is several GB of
 * CUDA wheels whose versions track the model, it can only be installed INTO
 * WSL — which nothing in the component system does today — and Owen's decision
 * (2026-08-07) was explicit: point at the environment, do not package it.
 *
 * The weights are not ours either. vLLM pulls the repo from HuggingFace into the
 * guest's own cache on first serve, which is why nothing here downloads, hashes
 * or mirrors a model.
 *
 * ── Lifetime ─────────────────────────────────────────────────────────────────
 *
 * Started on the first conversion that needs it, held across consecutive
 * conversions (loading the model costs ~44 s, and a user converting three books
 * should pay that once), and shut down `IDLE_SHUTDOWN_MS` after the last one
 * lets go. Reference-counted rather than timed alone: a 300-page book is ninety
 * minutes of one caller holding it, and an idle timer that could fire mid-run
 * would kill the server under a conversion that is still reading pages.
 *
 * ── Two rules this file exists to keep ───────────────────────────────────────
 *
 * **The GPU is taken through the arbiter, for the whole run.** A 20 GB
 * reservation and an Orpheus worker cannot co-reside on one 24 GB card. No
 * `onYield` is registered ON PURPOSE: yielding mid-conversion means failing a
 * ninety-minute run, so other GPU tenants QUEUE behind it instead. That is the
 * honest trade — they wait, rather than both of us failing.
 *
 * **The guest process is stopped with SIGTERM, from inside the guest.** Killing
 * `wsl.exe` from Windows SIGKILLs a process that holds the CUDA device, and that
 * is what wedges WSL until a reboot (memory `wsl-wedge-proofing`). So shutdown
 * is `pkill -TERM` in the distro, followed by waiting for the VRAM to come back.
 */

import { spawn, ChildProcess } from 'child_process';

import {
  getWslDistro,
  getWslCondaPath,
  getWslVlmCondaEnv,
  getWslVlmModel,
  shouldUseWsl2ForVlm,
} from './tool-paths';
import { acquireGpu, releaseGpu, getGpuMemMB } from './gpu-arbiter';

/**
 * Loopback port the guest's server is reached on.
 *
 * Fixed rather than ephemeral because WSL2's localhost forwarding is what
 * carries it across the VM boundary, and a port chosen inside the guest is not
 * something the Windows side can discover. Picked clear of the llama servers'
 * range and of vLLM's own default 8000, so a hand-started server (which is how
 * this was first proven) and BookForge's own can coexist on one machine.
 */
const VLM_SERVER_PORT = 8077;

/** Base URL foundry is handed. The `/v1` is the OpenAI-compatible prefix. */
const VLM_SERVER_URL = `http://127.0.0.1:${VLM_SERVER_PORT}/v1`;

/** Long enough to span consecutive conversions, short enough to give 20 GB back. */
const IDLE_SHUTDOWN_MS = 5 * 60_000;

/**
 * Loading the model, capturing CUDA graphs and opening the port took 43.7 s on
 * this machine's 3090 Ti with the weights already cached. The budget is set well
 * clear of that because a FIRST serve also downloads ~5.7 GB from HuggingFace,
 * and a timeout that fired during that download would look like a broken env.
 */
const STARTUP_TIMEOUT_MS = 15 * 60_000;

/** How long to wait for the guest to release the device after SIGTERM. */
const SHUTDOWN_TIMEOUT_MS = 60_000;

/** Below this much free VRAM there is no point starting: the model is ~6 GB plus KV. */
const MIN_FREE_VRAM_MB = 9_000;

/** Leave this much of the card for the desktop, Chrome and the app itself. */
const DESKTOP_MARGIN_MB = 1_500;

/** Never reserve more than this fraction of the card, however empty it looks. */
const UTIL_CEILING = 0.85;

/** The arbiter owner label. Distinct from every TTS owner, so we are sequenced. */
const GPU_OWNER = 'vlm-page-reader';

interface RunningServer {
  proc: ChildProcess;
  /** The repo the server was STARTED with — what foundry must name in requests. */
  model: string;
  /** Everything the guest has said, kept so a failure can quote itself. */
  log: string[];
  /** Conversions currently holding this server. */
  holders: number;
  /** Set while no one holds it. */
  idleTimer: NodeJS.Timeout | null;
  /** True once the port answered. */
  ready: boolean;
}

let server: RunningServer | null = null;
/** In-flight start, so two conversions beginning together share one spawn. */
let starting: Promise<RunningServer> | null = null;

/** What a caller gets: where to send pages, and the name to send them under. */
export interface VlmPageServer {
  url: string;
  model: string;
  /** Call when the conversion is over, whatever its outcome. */
  release: () => void;
}

/**
 * Why this machine cannot serve the page reader from WSL, or null when it can.
 *
 * Every branch names the setting that is missing rather than a symptom, because
 * each one is a field in Settings → Add-ons that nobody filled in — and the
 * alternative is `conda run -n undefined` failing ninety seconds later with a
 * conda error that mentions nothing the user typed.
 */
export function wslVlmRefusal(): string | null {
  if (process.platform !== 'win32') {
    return `Serving the page reader from WSL is a Windows arrangement; this machine is ${process.platform}.`;
  }
  if (!shouldUseWsl2ForVlm()) {
    return 'WSL2 for page reading is switched off. Turn it on in Settings → Add-ons.';
  }
  if (!getWslVlmCondaEnv()) {
    return 'No WSL conda environment is set for page reading. Name the environment holding vLLM '
      + 'in Settings → Add-ons.';
  }
  if (!getWslVlmModel()) {
    return 'No model is set for page reading. Name the HuggingFace repo the server should load '
      + '(e.g. rednote-hilab/dots.ocr) in Settings → Add-ons.';
  }
  return null;
}

/** Is a server already up and answering? Used by the settings Test button. */
export function vlmPageServerStatus(): { running: boolean; url: string; model: string | null } {
  return {
    running: server !== null && server.ready,
    url: VLM_SERVER_URL,
    model: server?.model ?? null,
  };
}

/**
 * `gpu_memory_utilization` for this card right now.
 *
 * A fraction of TOTAL VRAM that vLLM reserves up front and holds. Sized from
 * what is actually free rather than pinned at a constant: the 0.85 that worked
 * when the card was idle would, with a browser awake, reserve past free — and
 * reserving past free is what WDDM backs with system RAM, which freezes the
 * whole machine rather than failing the run. Same reasoning as
 * `computeSafeGpuUtil`, whose own floors are Orpheus's and do not describe this
 * model.
 */
async function sizeReservation(): Promise<{ util: number; freeMB: number | null }> {
  const mem = await getGpuMemMB();
  if (!mem) {
    // No NVIDIA GPU visible. Nothing to size against — vLLM will fail on its own
    // terms and say so, which is more useful than a number invented here.
    return { util: UTIL_CEILING, freeMB: null };
  }
  const reserveMB = mem.freeMB - DESKTOP_MARGIN_MB;
  const util = Math.max(Math.min(reserveMB / mem.totalMB, UTIL_CEILING), 0.05);
  return { util: Math.round(util * 100) / 100, freeMB: mem.freeMB };
}

/** The one place the `wsl.exe` argv is built, so start and stop agree on the shape. */
function buildServeCommand(model: string, util: number): { file: string; args: string[] } {
  const distro = getWslDistro();
  const conda = getWslCondaPath();
  const env = getWslVlmCondaEnv();

  // `--no-capture-output` so the guest's log reaches this process while it runs
  // rather than at exit: the readiness wait and every failure message below are
  // read out of that stream.
  //
  // Bound to 0.0.0.0 rather than 127.0.0.1 because that is the binding measured
  // to cross WSL2's localhost forwarding on this machine. It is reached only as
  // 127.0.0.1 from Windows.
  const serve = [
    conda, 'run', '-n', env!, '--no-capture-output',
    'vllm', 'serve', model,
    // dots.ocr ships its own modeling code, and vLLM refuses to load a repo that
    // does without this — by name, in a pydantic ValidationError, which is how
    // its absence was caught here rather than by a user. Every document VLM
    // worth pointing at is a custom architecture, so this belongs on the command
    // rather than behind a setting.
    '--trust-remote-code',
    '--host', '0.0.0.0',
    '--port', String(VLM_SERVER_PORT),
    '--gpu-memory-utilization', String(util),
    '--max-model-len', '32768',
  ].join(' ');

  const args = distro ? ['-d', distro, '-e', 'bash', '-lc', serve] : ['-e', 'bash', '-lc', serve];
  return { file: 'wsl.exe', args };
}

/** Has the port started answering its model list? */
async function answersModelList(): Promise<boolean> {
  try {
    const res = await fetch(`${VLM_SERVER_URL}/models`, {
      signal: AbortSignal.timeout(3_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The last few lines the guest said, for a failure that has to explain itself. */
function logTail(entry: RunningServer, lines = 12): string {
  return entry.log.slice(-lines).join('\n').trim();
}

/**
 * Spawn the server and wait for it to answer, or throw naming what went wrong.
 *
 * The GPU is acquired BEFORE the spawn and released only when the server stops,
 * so a TTS job cannot arrive between the reservation and the first page.
 */
async function startServer(): Promise<RunningServer> {
  const refusal = wslVlmRefusal();
  if (refusal !== null) throw new Error(refusal);

  const model = getWslVlmModel()!;

  await acquireGpu(GPU_OWNER, { timeoutMs: 10 * 60_000 });

  let entry: RunningServer | null = null;
  try {
    const { util, freeMB } = await sizeReservation();
    if (freeMB !== null && freeMB < MIN_FREE_VRAM_MB) {
      throw new Error(
        `Only ${Math.round(freeMB / 1024)} GB of VRAM is free, and the page reader needs about `
        + `${Math.round(MIN_FREE_VRAM_MB / 1024)} GB for the model and its cache. Close whatever `
        + 'else is using the GPU and convert again. Nothing was started.'
      );
    }

    const { file, args } = buildServeCommand(model, util);
    console.log(`[vlm-server] serving ${model} from WSL at ${VLM_SERVER_URL} (util ${util})`);

    const proc = spawn(file, args, { windowsHide: true });
    entry = { proc, model, log: [], holders: 0, idleTimer: null, ready: false };
    const record = entry;

    const collect = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (line.trim().length > 0) record.log.push(line);
      }
      // Bounded: a vLLM run logs every request, and this is a diagnostic tail,
      // not a transcript.
      if (record.log.length > 400) record.log.splice(0, record.log.length - 400);
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);

    // A holder rather than a bare `let`: the assignment happens in a callback
    // TypeScript does not follow, so a plain variable narrows to `null` and the
    // check below becomes unreachable code it refuses to compile.
    const exit: { info: { code: number | null; signal: string | null } | null } = { info: null };
    proc.on('exit', (code, signal) => {
      exit.info = { code, signal };
      if (server === record) {
        console.warn(`[vlm-server] exited (code ${code}, signal ${signal})`);
        server = null;
        releaseGpu(GPU_OWNER);
      }
    });

    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exit.info !== null) {
        throw new Error(
          `The page-reader server in WSL stopped before it was ready (exit ${exit.info.code}).\n`
          + logTail(record)
        );
      }
      if (await answersModelList()) {
        record.ready = true;
        console.log('[vlm-server] ready');
        return record;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error(
      `The page-reader server in WSL did not answer on ${VLM_SERVER_URL} within `
      + `${Math.round(STARTUP_TIMEOUT_MS / 60_000)} minutes.\n${logTail(record)}`
    );
  } catch (err) {
    // Whatever failed, the reservation must not outlive it.
    if (entry) await terminate(entry, 'startup failed');
    releaseGpu(GPU_OWNER);
    throw err;
  }
}

/**
 * Stop the guest's server the only way that is safe.
 *
 * SIGTERM is delivered INSIDE the distro. Killing `wsl.exe` from Windows would
 * SIGKILL a process holding the CUDA device, which is the documented way to
 * wedge WSL until the machine is rebooted (memory `wsl-wedge-proofing`). The
 * pattern matched is the model name, which is unique to this server's argv and
 * cannot catch the user's own hand-started vLLM on the default port unless it is
 * serving the same model — in which case they asked for the same thing twice.
 */
async function terminate(entry: RunningServer, reason: string): Promise<void> {
  console.log(`[vlm-server] stopping — ${reason}`);
  const distro = getWslDistro();
  const args = distro ? ['-d', distro, '-e', 'bash', '-lc'] : ['-e', 'bash', '-lc'];
  const pattern = `vllm serve ${entry.model}`;

  await new Promise<void>((resolve) => {
    const killer = spawn('wsl.exe', [...args, `pkill -TERM -f ${JSON.stringify(pattern)}`], {
      windowsHide: true,
    });
    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });

  // Wait for the process this side owns to go with it, so the VRAM is actually
  // back before the next tenant is told the card is free.
  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (entry.proc.exitCode === null && entry.proc.signalCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (entry.proc.exitCode === null && entry.proc.signalCode === null) {
    console.warn(
      `[vlm-server] still running ${Math.round(SHUTDOWN_TIMEOUT_MS / 1000)}s after SIGTERM; `
      + 'leaving it rather than SIGKILLing a process that holds the CUDA device'
    );
  }
}

/** Start the idle countdown, replacing any previous one. */
function armIdleTimer(entry: RunningServer): void {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.holders > 0) return;
    if (server !== entry) return;
    server = null;
    void terminate(entry, 'idle').finally(() => releaseGpu(GPU_OWNER));
  }, IDLE_SHUTDOWN_MS);
}

/**
 * The server a conversion should send its pages to, started if it is not up.
 *
 * The returned `release` must be called when the conversion ends — on success,
 * on failure and on cancellation alike — or the server never becomes idle and
 * never gives the card back.
 */
export async function ensureVlmPageServer(): Promise<VlmPageServer> {
  if (server === null && starting === null) {
    starting = startServer();
    try {
      server = await starting;
    } finally {
      starting = null;
    }
  } else if (starting !== null) {
    // A second conversion arrived while the first was still spawning. Join it
    // rather than starting a second server that would reserve the same VRAM.
    server = await starting;
  }

  const entry = server!;
  entry.holders += 1;
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  let released = false;
  return {
    url: VLM_SERVER_URL,
    model: entry.model,
    release: () => {
      // Idempotent: a caller that releases in both a `catch` and a `finally`
      // must not drive the count negative and leave the server pinned forever.
      if (released) return;
      released = true;
      entry.holders -= 1;
      if (entry.holders <= 0) armIdleTimer(entry);
    },
  };
}

/** Stop the server now, if one is up. For app shutdown and for the settings UI. */
export async function stopVlmPageServer(reason = 'asked to stop'): Promise<void> {
  const entry = server;
  if (entry === null) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  server = null;
  await terminate(entry, reason);
  releaseGpu(GPU_OWNER);
}
