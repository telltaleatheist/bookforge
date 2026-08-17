/**
 * vllm-server — the reading server, served from WSL, for as long as the queue
 * wants it.
 *
 * Adapted from BookForge's electron/vlm-page-server.ts, which is the proven
 * version of this. What was taken, and why each piece is load-bearing:
 *
 *   · **The serve command's shape.** `conda run -n <env> --no-capture-output
 *     vllm serve <model> --trust-remote-code --host 0.0.0.0 --port <p>
 *     --gpu-memory-utilization <u> --max-model-len 32768`, through
 *     `wsl.exe -d <distro> -e bash -lc`. `--trust-remote-code` is not optional:
 *     dots.ocr ships its own modeling code and vLLM refuses the repo without it,
 *     by name, in a pydantic ValidationError. `--no-capture-output` is what puts
 *     the guest's log on THIS process's handles while it runs, which is what the
 *     readiness wait below reads.
 *
 *   · **Readiness from the server's own log, not just the clock.** Polling
 *     /v1/models alone turns every failure into the full timeout. A CUDA OOM, a
 *     missing module or a rejected config says so in the first thirty seconds
 *     and then sits there; scanning for those patterns fails the job in thirty
 *     seconds with the log tail as the message.
 *
 *   · **One in-flight start promise.** Two jobs beginning together must share
 *     one spawn, or the second reserves VRAM the first already holds.
 *
 *   · **Stopping from INSIDE the distro.** `pkill -TERM` in the guest, not a
 *     taskkill on wsl.exe: SIGKILLing a process that holds the CUDA device is
 *     the documented way to wedge WSL until a reboot. The Windows-side tree kill
 *     is a last resort, after the graceful stop has been given its minute.
 *
 * ── The lifetime: up while the queue has work, down when it drains ───────────
 *
 * BookForge reference-counts the server per conversion because it arbitrates
 * one GPU between vLLM and TTS. This app has no second tenant, so it counts
 * nothing — but it reaches the same conclusion at a coarser grain: the queue
 * DRAINING stops the server. Teardown is on drain, not between jobs, so a
 * queue with three books in it loads the model once; but an empty queue has
 * no claim on half the card's VRAM (which under WSL is committed host RAM
 * too), and bringing the model back for the next job costs ~44 s — the cheap
 * side of that trade. The queue signals through noteQueueBusy/noteQueueIdle
 * below. An optional keep-warm window delays the stop for someone feeding
 * jobs one at a time by hand; it is a window with a number on it, never
 * "stay up indefinitely".
 *
 * ── The one rule about somebody else's server ────────────────────────────────
 *
 * If port 8000 already answers, that server is USED and never owned: not
 * stopped on quit, not stopped by the Stop button, not restarted. It may be the
 * user's own hand-started vLLM, and killing a thing this app did not start is
 * how you lose someone else's work.
 */
import { spawn, type ChildProcess } from 'node:child_process';

import { readSettings } from './settings';
import { bashArgs, decodeWslBytes, killTree, runWsl } from './wsl';
import type { ServerState, ServerStatus } from '../shared/types';

/**
 * The port, fixed.
 *
 * vLLM's own default, which is what a user who started one by hand will be on,
 * and what the engine's shipped `backend.endpointUrl` already points at. Note
 * it is NOT BookForge's 8077 — the two servers coexist on this machine, and
 * every kill in this file is scoped to 8000 so that stays true.
 */
const PORT = 8000;

/**
 * The base URL the engine is handed. `/v1` is the OpenAI-compatible prefix.
 *
 * EXPORTED because the installers write it into the engine's settings the moment
 * the server they just built exists (`env-install.ts`, `backend-setup.ts`). It
 * is the one place this address is composed, and two spellings of it would be
 * two answers to "where is the reading server" — one in the file the engine
 * reads, one in the process this app starts.
 */
export const VLLM_URL = `http://localhost:${PORT}/v1`;
const URL_BASE = VLLM_URL;

/** The document reader. dots.ocr is what foundry's registry expects to talk to. */
const MODEL = 'rednote-hilab/dots.ocr';

/**
 * Fraction of TOTAL VRAM vLLM reserves up front and holds.
 *
 * Half the card, flat. BookForge sizes this from free VRAM because it hands the
 * same GPU to TTS workers and has an arbiter to ask; there is no arbiter here
 * and nothing to ask, so the number is a cap rather than a measurement. Half is
 * clear of the ~6 GB of weights plus a workable KV cache on any card big enough
 * to run this at all, and leaves the desktop its half — and under WSL's dxg
 * layer every reserved GiB is also committed host RAM, which is why reserving
 * for the card's emptiness rather than the model's need is a way to OOM the
 * machine around it.
 */
const GPU_UTIL = 0.5;

/** Context window. dots.ocr pages fit inside this with room for the answer. */
const MAX_MODEL_LEN = 32_768;

/**
 * A first serve downloads ~6 GB of weights from HuggingFace before it loads
 * them, so the budget has to clear a slow line — a timeout that fired during
 * that download would read as a broken environment. The fatal-pattern scan is
 * what keeps a genuinely broken start from actually costing this long.
 */
const STARTUP_TIMEOUT_MS = 15 * 60_000;

/** How long the guest gets to release the CUDA device after SIGTERM. */
const SHUTDOWN_TIMEOUT_MS = 60_000;

/** Lines kept for a failure that has to explain itself. */
const LOG_CAP = 400;

/**
 * Log lines that mean this server is never going to be ready.
 *
 * Each one is a thing vLLM says and then keeps sitting there for, which is the
 * whole reason this list exists: without it every one of them costs the full
 * fifteen minutes before the job is told.
 */
const FATAL_PATTERNS: readonly { pattern: RegExp; meaning: string }[] = [
  { pattern: /CUDA out of memory|torch\.OutOfMemoryError|No available memory for the cache blocks/i,
    meaning: 'the GPU does not have enough free memory for the model' },
  { pattern: /ValidationError/,
    meaning: 'vLLM rejected the model configuration' },
  { pattern: /ModuleNotFoundError|No module named/,
    meaning: 'something is missing from the environment' },
  { pattern: /Address already in use|error while attempting to bind on address/i,
    meaning: `something else already holds port ${PORT}` },
  { pattern: /does not appear to have a file named config\.json|Repository Not Found|401 Client Error/i,
    meaning: 'the model could not be fetched from HuggingFace' },
];

/**
 * vLLM's own INFO and WARNING lines, which are never a reason to give up.
 *
 * This exclusion is load-bearing, not tidiness. A healthy vLLM on a build
 * without the compiled extension prints
 *
 *     WARNING … [interface.py:389] Failed to import from vllm._C with
 *     ModuleNotFoundError("No module named 'vllm._C'")
 *
 * during a start that goes on to succeed. Scanning it would fail a working
 * server in the first ten seconds and report a missing module that is not
 * missing — the exact failure mode this whole scan exists to prevent, aimed the
 * wrong way. A real fatality is an ERROR line or an unprefixed traceback.
 */
const CHATTER = /^(INFO|WARNING|DEBUG)\b/;

/**
 * One log line -> why this server will never be ready, or null.
 *
 * Pure and exported so the patterns can be checked against real vLLM output
 * without spending twenty gigabytes of VRAM to produce it.
 */
export function fatalReason(line: string): string | null {
  if (CHATTER.test(line.trim())) return null;
  for (const { pattern, meaning } of FATAL_PATTERNS) {
    if (pattern.test(line)) return meaning;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Which endpoints are ours to start
// ─────────────────────────────────────────────────────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Is this URL the local server this module manages?
 *
 * A remote endpoint — a vLLM on another machine, a hosted OpenAI-compatible
 * service — is used exactly as given and never started, never stopped, never
 * probed for readiness beyond the request the engine itself makes. Starting a
 * local server because a job named a REMOTE one would burn twenty gigabytes for
 * nothing.
 */
export function isLocalVllmEndpoint(url: string): boolean {
  try {
    const parsed = new URL(url.trim());
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return LOOPBACK.has(parsed.hostname) && port === String(PORT);
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The launch command
// ─────────────────────────────────────────────────────────────────────────────

export interface Launch {
  kind: 'conda' | 'venv';
  /** The conda env's name, when it is one. For the log line and nothing else. */
  env: string | null;
  /** The bash command line, exactly as `bash -lc` will get it. */
  command: string;
}

/**
 * An interpreter path inside WSL -> the command that serves from it.
 *
 * The path SHAPE decides, because it is the only thing we are given and it is
 * unambiguous: `<root>/envs/<name>/bin/python` is a conda env — its `<root>` has
 * the conda binary that can `run -n <name>` — and anything else is a plain
 * environment whose `bin/` already holds the `vllm` entry point. Deriving it
 * beats storing a route, because a user who points `backend.vllmPython` at an
 * env they built by hand never told us which kind it is.
 */
export function deriveLaunch(python: string, model = MODEL, util = GPU_UTIL): Launch {
  // Everything after the `vllm` entry point — the two routes differ only in how
  // they reach that entry point, never in what they ask it for.
  const serveArgs = [
    'serve', model,
    '--trust-remote-code',
    // 0.0.0.0 rather than 127.0.0.1: that is the binding that crosses WSL2's
    // localhost forwarding. It is still only reachable as localhost from Windows.
    '--host', '0.0.0.0',
    '--port', String(PORT),
    '--gpu-memory-utilization', String(util),
    '--max-model-len', String(MAX_MODEL_LEN),
  ].join(' ');

  const conda = /^(.*)\/envs\/([^/]+)\/bin\/python[0-9.]*$/.exec(python.trim());
  if (conda) {
    const [, root, env] = conda;
    return {
      kind: 'conda',
      env: env ?? null,
      command: `${root}/bin/conda run -n ${env} --no-capture-output vllm ${serveArgs}`,
    };
  }

  // `<env>/bin/python` -> `<env>/bin`, whose `vllm` is the same entry point
  // activating the environment would have put on PATH. Calling it by path
  // rather than sourcing `activate` keeps this one command with no shell state.
  const bin = python.trim().replace(/\/[^/]+$/, '');
  return { kind: 'venv', env: null, command: `${bin}/vllm ${serveArgs}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

interface RunningServer {
  proc: ChildProcess;
  distro: string;
  log: string[];
  /** Set by the log scan the moment the guest says something unrecoverable. */
  fatal: string | null;
  exited: { code: number | null; signal: string | null } | null;
}

let server: RunningServer | null = null;
/** In-flight start, so two jobs beginning together share one spawn. */
let starting: Promise<ServerStatus> | null = null;
/** A server on the port that we did not start. Used, never owned. */
let external = false;
let state: ServerState = 'stopped';
let detail = 'Not started.';
let listener: (status: ServerStatus) => void = () => { /* set by main */ };

export function onServerStatus(fn: (status: ServerStatus) => void): void {
  listener = fn;
}

export function serverStatus(): ServerStatus {
  return { state, detail, url: URL_BASE, model: MODEL, external };
}

/** True only when this process spawned the thing that is up. */
export function ownsServer(): boolean {
  return server !== null && !external;
}

function publish(next: ServerState, why: string): void {
  state = next;
  detail = why;
  listener(serverStatus());
}

function logTail(lines = 14): string {
  return server === null ? '' : server.log.slice(-lines).join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Starting
// ─────────────────────────────────────────────────────────────────────────────

/** Does the port answer its model list, and with what? */
async function askModelList(): Promise<{ up: boolean; models: string[] }> {
  try {
    const res = await fetch(`${URL_BASE}/models`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return { up: false, models: [] };
    const body = await res.json() as { data?: { id?: string }[] };
    const models = (body.data ?? []).map((entry) => entry.id).filter((id): id is string => !!id);
    return { up: true, models };
  } catch {
    return { up: false, models: [] };
  }
}

/**
 * The server a job should send its pages to, started if it is not up.
 *
 * Throws with the guest's own log tail when it cannot be. The caller (the job
 * queue) puts that on the job, because "the reading server did not start" with
 * no further word is the least useful failure a conversion can have.
 */
export async function ensureServer(): Promise<ServerStatus> {
  // Demand for the server cancels any pending idle stop, even when the caller
  // forgot to say noteQueueBusy first.
  cancelIdleStop();

  // Somebody else's, or our own from a moment ago. Either way the port answers
  // and there is nothing to start.
  const existing = await askModelList();
  if (existing.up) {
    if (server === null) {
      external = true;
      publish('ready', existing.models.length > 0
        ? `A server on port ${PORT} was already answering (${existing.models.join(', ')}). Using it as it is; this app will not stop it.`
        : `A server on port ${PORT} was already answering. Using it as it is; this app will not stop it.`);
    } else {
      publish('ready', detail);
    }
    return serverStatus();
  }

  // The port went quiet. If what was on it was somebody else's, it is not there
  // any more and the claim has to be dropped — otherwise a server we then start
  // ourselves would be treated as unownable and never stopped.
  external = false;

  if (starting !== null) return starting;
  starting = startServer().finally(() => { starting = null; });
  return starting;
}

async function startServer(): Promise<ServerStatus> {
  const settings = readSettings();
  const distro = settings.backend.wslDistro;
  const python = settings.backend.vllmPython;

  // Named settings rather than symptoms: each of these is a field on the
  // settings screen that nobody filled in, and `conda run -n undefined` failing
  // ninety seconds later names nothing the user typed.
  if (process.platform !== 'win32') {
    const why = `Serving vLLM from WSL is a Windows arrangement; this machine is ${process.platform}.`;
    publish('failed', why);
    throw new Error(why);
  }
  if (!distro || !python) {
    const why = `No WSL environment is set up for reading. Open Settings and run "Set up vLLM in WSL", `
      + 'or point the endpoint at a server elsewhere.';
    publish('failed', why);
    throw new Error(why);
  }

  const launch = deriveLaunch(python);
  publish('starting', `Starting vLLM in ${distro} (${launch.kind}${launch.env ? ` env ${launch.env}` : ''})…`);

  const proc = spawn('wsl.exe', bashArgs(distro, launch.command), { windowsHide: true });
  const record: RunningServer = { proc, distro, log: [], fatal: null, exited: null };
  server = record;
  external = false;

  const collect = (chunk: Buffer): void => {
    for (const line of decodeWslBytes(chunk).split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      record.log.push(line);
      if (record.fatal === null) record.fatal = fatalReason(line);
    }
    // Bounded: a serving vLLM logs every request, and this is a diagnostic
    // tail, not a transcript.
    if (record.log.length > LOG_CAP) record.log.splice(0, record.log.length - LOG_CAP);
  };
  proc.stdout?.on('data', collect);
  proc.stderr?.on('data', collect);

  proc.on('exit', (code, signal) => {
    record.exited = { code, signal };
    if (server === record) {
      server = null;
      if (state !== 'starting') publish('stopped', `The server in ${distro} exited (code ${code}).`);
    }
  });

  const fail = async (why: string): Promise<never> => {
    const tail = logTail();
    await terminate(record, 'the start failed');
    if (server === record) server = null;
    const message = tail ? `${why}\n\n${tail}` : why;
    publish('failed', message);
    throw new Error(message);
  };

  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (record.exited !== null) {
      return fail(`The reading server in ${distro} stopped before it was ready (exit ${record.exited.code}).`);
    }
    if (record.fatal !== null) {
      return fail(`The reading server in ${distro} cannot start: ${record.fatal}.`);
    }
    const probe = await askModelList();
    if (probe.up) {
      publish('ready', `Serving ${MODEL} from ${distro} on ${URL_BASE}.`);
      return serverStatus();
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return fail(
    `The reading server in ${distro} did not answer on ${URL_BASE} within `
    + `${Math.round(STARTUP_TIMEOUT_MS / 60_000)} minutes.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Idle teardown
// ─────────────────────────────────────────────────────────────────────────────

/** The pending stop, while a drained queue's keep-warm window runs out. */
let idleStop: NodeJS.Timeout | null = null;

function cancelIdleStop(): void {
  if (idleStop !== null) {
    clearTimeout(idleStop);
    idleStop = null;
  }
}

/**
 * A job is about to need the server: whatever idle countdown was running is
 * over. The queue calls this BEFORE ensureServer, so a job that arrives inside
 * the keep-warm window keeps the warm server instead of racing its stop.
 */
export function noteQueueBusy(): void {
  cancelIdleStop();
}

/**
 * The queue just drained: stop the server this app started — immediately when
 * `keepWarmMinutes` is 0 (the default), otherwise once the window runs out.
 *
 * The policy number comes from the CALLER (the queue reads the app's own
 * settings); this module only executes it, which keeps it free of Electron
 * imports and testable. A server this app merely found on the port is not
 * ours and is left exactly alone, whatever the setting says. A stop is never
 * mid-job by construction: the queue only reports idle when nothing is
 * running, and anything that starts afterwards cancels the countdown.
 */
export function noteQueueIdle(keepWarmMinutes: number): void {
  cancelIdleStop();
  if (!ownsServer()) return;
  if (keepWarmMinutes <= 0) {
    void stopServer('the queue is empty');
    return;
  }
  const distro = server?.distro ?? 'WSL';
  publish('ready',
    `Serving ${MODEL} from ${distro} on ${URL_BASE}. The queue is empty — stopping in `
    + `${keepWarmMinutes} min unless another job arrives.`);
  idleStop = setTimeout(() => {
    idleStop = null;
    void stopServer(`the queue has been empty for ${keepWarmMinutes} min`);
  }, keepWarmMinutes * 60_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stopping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bring the guest's server down, gracefully first.
 *
 * `pkill -TERM` INSIDE the distro, scoped by `--port 8000`, so a vLLM serving
 * something else on another port — BookForge's own lives on 8077 — is never
 * touched even when it is serving the same model. Only if the process this side
 * owns is still there a minute later does the Windows tree kill happen, and
 * that is noted in the status rather than done silently: it is the move that
 * can wedge WSL, and a user whose next start hangs deserves to know it was made.
 */
async function terminate(entry: RunningServer, reason: string): Promise<void> {
  const pattern = `vllm serve .*--port ${PORT}`;
  await runWsl(
    bashArgs(entry.distro, `pkill -TERM -f ${JSON.stringify(pattern)}`),
    30_000,
  );

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (entry.proc.exitCode === null && entry.proc.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (entry.proc.exitCode === null && entry.proc.signalCode === null) {
    killTree(entry.proc);
    console.warn(`[vllm-server] ${reason}: still running after SIGTERM; killed the wsl.exe tree`);
  }
}

/**
 * Stop the server, if it is ours.
 *
 * A server this app found already running is left alone and said so — the Stop
 * button on the settings screen is disabled for it, and app quit does not touch
 * it either.
 */
export async function stopServer(reason = 'asked to stop'): Promise<ServerStatus> {
  // A manual stop supersedes a scheduled one; a timer left armed would fire
  // later and re-announce a stop that already happened.
  cancelIdleStop();
  if (external) {
    publish('ready', `That server was already running before this app started it, so it is left alone.`);
    return serverStatus();
  }
  const entry = server;
  if (entry === null) {
    publish('stopped', 'Not started.');
    return serverStatus();
  }
  server = null;
  publish('stopped', `Stopping — ${reason}…`);
  await terminate(entry, reason);
  publish('stopped', `Stopped — ${reason}.`);
  return serverStatus();
}
