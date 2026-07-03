/**
 * WSL lifecycle control — the single home for probing, stopping, and destroying WSL
 * guest processes. Used by parallel-tts-bridge (batch audiobook workers) and
 * orpheus-worker-pool (Listen streaming server).
 *
 * THE RULE THAT KEEPS WSL ALIVE: never SIGKILL a GPU-bound process inside the guest.
 * A process force-killed while kernel-stuck in a dxg (GPU paravirtualization) wait is
 * what wedges the entire WSL utility VM — wslservice becomes unkillable, every \\wsl$
 * touch hangs forever (the white-screen failure), and only a Windows reboot recovers.
 *
 * Teardown discipline, in order:
 *   1. Cooperative SIGTERM — the Python workers install handlers (worker.py,
 *      orpheus_stream.py) and exit themselves, releasing the GPU from inside.
 *   2. Verified wait — poll pgrep until the process is gone.
 *   3. `wsl.exe -t <distro>` — the final destroy. Terminating the VM releases the GPU
 *      at the hypervisor level and cannot leave a half-dead process behind. All durable
 *      output lives on /mnt/* (Windows disk), so nothing is lost; the only cost is a
 *      cold start on the next job.
 *   4. If even VM-terminate fails, latch "wedged": refuse to spawn more GPU work and
 *      surface "reboot required" instead of hammering a dead VM.
 *
 * Every wsl.exe invocation here is an async spawn with a kill-timer — nothing in this
 * module can block the main thread on a wedged VM.
 */

import { spawn } from 'child_process';
import { getWslDistro } from './tool-paths';

export interface ExecWslResult {
  /** Process exit code; -1 when wsl.exe errored, was killed by the timeout, or never spawned. */
  code: number;
  stdout: string;
  timedOut: boolean;
}

/** Outcome of a graceful in-guest kill. 'unresponsive' means wsl.exe itself stopped
 *  answering — the VM is likely wedged (the latch is set by then). */
export type WslPkillOutcome = 'none' | 'exited' | 'alive' | 'unresponsive';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Args prefix for running a guest BINARY: distro selector + `-e` (exec, NO login
 *  shell). `-e` matters twice over: our pkill/pgrep patterns contain shell
 *  metacharacters (`(worker|app)\.py` — a bare `wsl.exe pkill -f (worker|app)...`
 *  would be a bash syntax error), and skipping the shell avoids .bashrc side
 *  effects. wsl.exe built-ins (--list, -t, --shutdown) must NOT use this. */
function guestExecArgs(): string[] {
  const distro = getWslDistro();
  return distro ? ['-d', distro, '-e'] : ['-e'];
}

/**
 * Run wsl.exe with a hard kill-timer. Async spawn — never blocks the event loop the
 * way the old execSync kill paths could. wsl.exe prints UTF-16LE; stdout is decoded
 * accordingly.
 */
export function execWsl(args: string[], timeoutMs: number): Promise<ExecWslResult> {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let settled = false;
    const done = (code: number, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      // wsl.exe emits UTF-16LE for its own messages (--list etc.) but plain UTF-8 for
      // guest command output; stripping NULs handles both without guessing.
      const text = stdout.toString('utf8').replace(/\0/g, '');
      resolve({ code, stdout: text, timedOut });
    };
    try {
      const p = spawn('wsl.exe', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      const t = setTimeout(() => {
        try { p.kill(); } catch { /* already gone */ }
        done(-1, true);
      }, timeoutMs);
      p.stdout.on('data', (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]); });
      p.on('exit', (code) => { clearTimeout(t); done(code ?? -1, false); });
      p.on('error', () => { clearTimeout(t); done(-1, false); });
    } catch {
      done(-1, false);
    }
  });
}

// ---------------------------------------------------------------------------
// Wedged latch
// ---------------------------------------------------------------------------

let wedgedSince: number | null = null;
let wedgedReason = '';

export function isWslWedged(): boolean {
  return wedgedSince !== null;
}

export function wslWedgedMessage(): string {
  return `WSL is not responding (${wedgedReason}). The WSL VM appears kernel-wedged — ` +
    `no more GPU jobs will be started. A Windows reboot is required to recover WSL.`;
}

export function markWslWedged(reason: string): void {
  if (wedgedSince === null) {
    wedgedSince = Date.now();
    wedgedReason = reason;
    console.error(`[WSL] VM marked WEDGED (${reason}). Blocking all further WSL GPU work; a reboot is likely required.`);
  }
}

function clearWslWedged(context: string): void {
  if (wedgedSince !== null) {
    console.log(`[WSL] VM responsive again (${context}) — clearing wedged latch after ${Math.round((Date.now() - wedgedSince) / 1000)}s.`);
    wedgedSince = null;
    wedgedReason = '';
  }
}

// ---------------------------------------------------------------------------
// Liveness probe
// ---------------------------------------------------------------------------

const LIVENESS_TTL_MS = 20_000;
let lastProbeAt = 0;
let lastProbeResult = true;
let probeInFlight: Promise<boolean> | null = null;

/**
 * Is the WSL service responsive? "Alive" means wsl.exe answers within the timeout —
 * a distro that simply isn't running yet still counts as alive (it cold-starts on
 * demand); a kernel-wedged VM times out. Result is cached for ~20s so hot paths
 * (IPC handlers, resume scans) can call this freely.
 *
 * A successful probe clears the wedged latch (e.g. after `wsl --shutdown` recovered
 * a zombie, or the user rebooted and relaunched mid-session).
 */
export async function isWslAlive(): Promise<boolean> {
  const now = Date.now();
  if (now - lastProbeAt < LIVENESS_TTL_MS) return lastProbeResult;
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async () => {
    const res = await execWsl(['--list', '--running', '--quiet'], 5000);
    // Exit code is irrelevant ("no running distributions" is non-zero but healthy) —
    // what matters is that wsl.exe ANSWERED. A wedged VM hangs until our kill-timer.
    const alive = !res.timedOut && res.code !== -1;
    lastProbeAt = Date.now();
    lastProbeResult = alive;
    if (alive) {
      clearWslWedged('liveness probe');
    } else {
      markWslWedged('liveness probe timed out');
    }
    probeInFlight = null;
    return alive;
  })();
  return probeInFlight;
}

/** Synchronous read of the last cached probe result without triggering a new probe.
 *  Kicks off a background refresh when stale. For sync call sites (orpheus-models fs
 *  guards) that cannot await. */
export function isWslAliveCached(): boolean {
  if (isWslWedged()) return false;
  if (Date.now() - lastProbeAt >= LIVENESS_TTL_MS) {
    void isWslAlive().catch(() => { /* probe failures latch internally */ });
  }
  return lastProbeResult;
}

// ---------------------------------------------------------------------------
// Graceful in-guest kill (NO SIGKILL — ever)
// ---------------------------------------------------------------------------

export interface WslPkillOptions {
  /** How long to wait for the process to exit after SIGTERM. Default 60s — vLLM
   *  init/CUDA-graph capture defers Python signal delivery until native code returns,
   *  which can take tens of seconds. */
  graceMs?: number;
  pollMs?: number;
  label?: string;
}

/**
 * SIGTERM the guest processes matching `pattern`, then VERIFY they exit. Never
 * escalates to SIGKILL — force-killing a process in a dxg GPU wait is exactly what
 * wedges the VM. Callers that need a guarantee follow an 'alive' result with
 * terminateWslDistro().
 */
export async function wslPkillGraceful(pattern: string, opts: WslPkillOptions = {}): Promise<WslPkillOutcome> {
  const graceMs = opts.graceMs ?? 60_000;
  const pollMs = opts.pollMs ?? 500;
  const label = opts.label ?? 'wsl-pkill';
  const d = guestExecArgs();

  const probe = await execWsl([...d, 'pgrep', '-f', pattern], 8000);
  if (probe.timedOut || probe.code === -1) {
    markWslWedged(`${label}: pgrep did not answer`);
    return 'unresponsive';
  }
  if (probe.code === 1) return 'none';

  console.log(`[WSL] ${label}: SIGTERM to guest processes matching "${pattern}" (grace ${graceMs}ms, no SIGKILL)`);
  await execWsl([...d, 'pkill', '-TERM', '-f', pattern], 8000);

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const c = await execWsl([...d, 'pgrep', '-f', pattern], 8000);
    if (c.code === 1) {
      console.log(`[WSL] ${label}: guest processes exited cleanly on SIGTERM`);
      return 'exited';
    }
    if (c.timedOut || c.code === -1) {
      markWslWedged(`${label}: WSL stopped answering while waiting for SIGTERM exit`);
      return 'unresponsive';
    }
  }

  console.warn(`[WSL] ${label}: process still alive after ${graceMs}ms grace — caller should escalate to VM terminate (never SIGKILL)`);
  return 'alive';
}

/**
 * Wait (poll pgrep) for guest processes matching `pattern` to disappear WITHOUT
 * signalling them — used as a spawn preflight so a new vLLM never starts alongside a
 * tearing-down one. Returns true when the guest is clear.
 */
export async function waitForGuestExit(pattern: string, timeoutMs: number, label = 'guest-wait'): Promise<boolean> {
  const d = guestExecArgs();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const c = await execWsl([...d, 'pgrep', '-f', pattern], 8000);
    if (c.code === 1) return true;
    if (c.timedOut || c.code === -1) {
      markWslWedged(`${label}: pgrep did not answer`);
      return false;
    }
    if (Date.now() >= deadline) {
      console.warn(`[WSL] ${label}: guest processes matching "${pattern}" still present after ${timeoutMs}ms`);
      return false;
    }
    await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// The final destroy: VM terminate
// ---------------------------------------------------------------------------

/**
 * Terminate the WSL distro VM — the guaranteed teardown. Releases the GPU at the
 * hypervisor level; a kernel-stuck guest process cannot survive it the way it
 * survives SIGKILL. Safe for data: all durable BookForge output lives on /mnt/*.
 *
 * Falls back to `wsl --shutdown` (all distros) when no distro is configured.
 * On failure/timeout the wedged latch is set — at that point only a reboot helps.
 */
export async function terminateWslDistro(reason: string): Promise<boolean> {
  const distro = getWslDistro();
  console.warn(`[WSL] FINAL DESTROY: terminating ${distro ? `distro '${distro}'` : 'all distros (--shutdown)'} — ${reason}`);

  const args = distro ? ['-t', distro] : ['--shutdown'];
  const res = await execWsl(args, 15_000);
  if (res.timedOut || res.code === -1) {
    markWslWedged(`terminate ${distro ?? '--shutdown'} timed out`);
    return false;
  }

  // Verify: the distro must no longer be listed as running.
  const check = await execWsl(['--list', '--running', '--quiet'], 5000);
  if (check.timedOut || check.code === -1) {
    markWslWedged('post-terminate liveness check timed out');
    return false;
  }
  const stillRunning = distro
    ? check.stdout.split(/\r?\n/).some((l) => l.trim() === distro)
    : check.stdout.trim().length > 0;
  if (stillRunning) {
    markWslWedged(`distro survived wsl -t`);
    return false;
  }

  console.warn(`[WSL] VM terminated cleanly (${reason}). GPU released; next job pays a cold start.`);
  clearWslWedged('successful VM terminate');
  // Refresh the liveness cache — the service just proved responsive.
  lastProbeAt = Date.now();
  lastProbeResult = true;
  return true;
}

/**
 * Full teardown ladder for guest GPU processes: SIGTERM+verify, then VM terminate if
 * anything refuses to die. This is the ONLY sanctioned way to force WSL GPU work to
 * stop. Returns the pkill outcome ('exited'/'none' = clean; 'alive'/'unresponsive'
 * mean the VM was (or had to be) destroyed / latched).
 */
export async function destroyWslGuestProcesses(pattern: string, opts: WslPkillOptions = {}): Promise<WslPkillOutcome> {
  const outcome = await wslPkillGraceful(pattern, opts);
  if (outcome === 'alive') {
    await terminateWslDistro(`${opts.label ?? 'teardown'}: process survived SIGTERM grace`);
  } else if (outcome === 'unresponsive') {
    // One attempt at the final destroy even when unresponsive — `wsl -t` sometimes
    // still lands when per-process control is gone; failure keeps the latch set.
    await terminateWslDistro(`${opts.label ?? 'teardown'}: WSL unresponsive`);
  }
  return outcome;
}
