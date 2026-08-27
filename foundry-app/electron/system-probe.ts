/**
 * system-probe — what this machine actually is, measured once and said plainly.
 *
 * WHY IT EXISTS AT ALL. The setup wizard has to answer one question a person
 * cannot be expected to answer for themselves — *which of these models will run
 * here?* — and every wrong answer is expensive in a different direction. Too
 * big and the first translation runs at a word a second on a card that is
 * swapping, or refuses outright after a seventeen-gigabyte download. Too small
 * and somebody with a workstation gets the model meant for a laptop and never
 * finds out. So the recommendation is derived from numbers this file goes and
 * READS, and every number it could not read is reported as null rather than
 * guessed at.
 *
 * ── NULL IS AN ANSWER, AND IT IS NOT ZERO ────────────────────────────────────
 *
 * `nvidia-smi` missing means "there is no NVIDIA driver on this machine", which
 * is a real and common state (an AMD card, an Intel laptop, a Mac). A card that
 * is present but whose VRAM could not be parsed is a DIFFERENT state, and the
 * two must not collapse into one: the first machine should be offered the small
 * model with a CPU warning, and the second should be told the probe failed
 * rather than quietly handed the same recommendation. Every field that can be
 * unknown is `T | null`, and `detail` carries the sentence.
 *
 * ── CACHED FOR THE PROCESS, AND DELIBERATELY NOT REFRESHED ───────────────────
 *
 * Shelling out to nvidia-smi takes a couple of hundred milliseconds and blocks
 * nothing that matters, but the wizard reads this on every step change and the
 * settings screen reads it again. None of these numbers change while an app is
 * running — you do not gain VRAM at lunchtime — so the first answer is kept and
 * handed out. `probeSystem(true)` forces a re-read for the one case that is
 * real: somebody who installed a GPU driver while the app was open, and pressed
 * the wizard's re-check.
 *
 * ── EVERY PROBE IS ASYNC AND TIMED OUT ───────────────────────────────────────
 *
 * `execSync` here would freeze the renderer on a machine where nvidia-smi hangs
 * on a wedged driver — which is exactly the machine most in need of a setup
 * screen. Each probe is a spawn with a deadline, and a deadline that expires is
 * a null with a sentence, never a rejection.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';

import { app } from 'electron';

import type { CudaFacts, SystemProfile } from '../shared/types';

/** Long enough for a cold nvidia-smi on a laptop; short enough to not be a hang. */
const PROBE_MS = 8_000;

let cached: SystemProfile | null = null;

/**
 * Run a command and hand back its stdout, or null.
 *
 * NULL COVERS THREE DIFFERENT FAILURES ON PURPOSE — the binary is not on PATH,
 * it exited nonzero, it never finished. The caller cannot act differently on
 * any of them (all three mean "this machine will not tell me"), and a probe
 * that distinguished them would be three code paths writing the same sentence.
 */
function run(command: string, args: string[], timeoutMs = PROBE_MS): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(null);
    }, timeoutMs);

    const out: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) { finish(null); return; }
      const text = Buffer.concat(out).toString('utf8').trim();
      finish(text.length > 0 ? text : null);
    });
  });
}

/**
 * The NVIDIA card, if there is one.
 *
 * ONE LINE PER GPU AND THE FIRST ONE WINS. A machine with two cards is not
 * a machine with the sum of their memory: ollama loads a model onto one device
 * unless it is told otherwise, and adding 8 + 8 to recommend a 14 GB model
 * would be a recommendation for a machine that does not exist. Taking the first
 * line understates a multi-GPU workstation, which is the safe direction to be
 * wrong in and is said out loud in `detail`.
 *
 * SKIPPED ENTIRELY ON macOS. There has been no NVIDIA card in a Mac for a
 * decade, and spawning a binary that is certainly absent to learn that is a
 * probe whose only product is a slower startup.
 */
async function probeCuda(platform: NodeJS.Platform): Promise<CudaFacts> {
  if (platform === 'darwin') {
    return {
      present: false,
      name: null,
      vramMB: null,
      detail: 'macOS has no NVIDIA GPU; the GPU here is Apple\'s own and shares system memory.',
    };
  }

  const out = await run('nvidia-smi', [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (out === null) {
    return {
      present: false,
      name: null,
      vramMB: null,
      detail: 'nvidia-smi is not on this machine, so there is no NVIDIA GPU the models could use.',
    };
  }

  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  const first = lines[0] ?? '';
  const [rawName, rawVram] = first.split(',').map((part) => part.trim());
  const name = rawName && rawName.length > 0 ? rawName : null;
  const parsed = Number.parseInt(rawVram ?? '', 10);
  const vramMB = Number.isFinite(parsed) && parsed > 0 ? parsed : null;

  if (vramMB === null) {
    return {
      present: true,
      name,
      vramMB: null,
      detail: `nvidia-smi answered with "${first}", which carries no memory figure this could read.`,
    };
  }

  const extra = lines.length > 1
    ? ` This machine has ${lines.length} NVIDIA GPUs; only the first is counted, because a model loads onto one card.`
    : '';
  return {
    present: true,
    name,
    vramMB,
    detail: `${name ?? 'An NVIDIA GPU'} with ${(vramMB / 1024).toFixed(1)} GB of VRAM.${extra}`,
  };
}

/**
 * Free bytes on the volume the app writes to, in MB — or null.
 *
 * `userData` rather than the library folder: environments and ollama's model
 * store both land under the user's own application data, and on the ordinary
 * machine that is the same volume as everything else. Null when it cannot be
 * measured, and a null SKIPS the disk warning rather than raising it — telling
 * somebody they are out of space because statfs is unavailable on their
 * filesystem is worse than saying nothing.
 */
async function probeFreeDiskMB(): Promise<number | null> {
  const candidates: string[] = [];
  try { candidates.push(app.getPath('userData')); } catch { /* not ready; try home */ }
  candidates.push(os.homedir());

  for (const dir of candidates) {
    try {
      const stat = await fs.promises.statfs(dir);
      const free = Number(stat.bavail) * Number(stat.bsize);
      if (Number.isFinite(free) && free > 0) return Math.round(free / 1024 / 1024);
    } catch { /* the next candidate, then null */ }
  }
  return null;
}

/**
 * Everything, once.
 *
 * Never throws. A probe that fell over is a field that is null and a sentence
 * that says which one — a setup screen that cannot open because it could not
 * read a disk size would be the worst possible failure for this feature.
 */
export async function probeSystem(force = false): Promise<SystemProfile> {
  if (cached && !force) return cached;

  const platform = process.platform;
  const arch = process.arch;
  const appleSilicon = platform === 'darwin' && arch === 'arm64';
  const ramMB = Math.round(os.totalmem() / 1024 / 1024);

  const [cuda, freeDiskMB] = await Promise.all([probeCuda(platform), probeFreeDiskMB()]);

  /*
   * ── THE ONE DERIVED NUMBER, AND WHY IT IS DERIVED HERE ────────────────────
   *
   * `modelMemoryMB` is what a model can expect to have. It is not "VRAM" and
   * it is not "RAM": on a discrete-GPU machine it is the card, on Apple silicon
   * it is a FRACTION of unified memory (macOS itself, the browser the user has
   * open, and the app drawing this screen all live in the same pool — the 75%
   * here is roughly what Metal will let a process wire down, and erring low is
   * erring toward a model that runs), and on a machine with neither it is
   * system RAM with the understanding that everything will be slow.
   *
   * Computed once, here, so the lineup table downstream compares one number
   * against one column instead of re-deciding the platform question per row.
   */
  let modelMemoryMB: number;
  let memoryBasis: SystemProfile['memoryBasis'];
  if (cuda.present && cuda.vramMB !== null) {
    modelMemoryMB = cuda.vramMB;
    memoryBasis = 'vram';
  } else if (appleSilicon) {
    modelMemoryMB = Math.round(ramMB * 0.75);
    memoryBasis = 'unified';
  } else {
    modelMemoryMB = ramMB;
    memoryBasis = 'ram';
  }

  const gb = (mb: number): string => (mb / 1024).toFixed(1);
  const detail = memoryBasis === 'vram'
    ? `${cuda.name ?? 'An NVIDIA GPU'}, ${gb(modelMemoryMB)} GB VRAM, ${gb(ramMB)} GB RAM.`
    : memoryBasis === 'unified'
      ? `Apple silicon with ${gb(ramMB)} GB of unified memory, of which about ${gb(modelMemoryMB)} GB is reachable by a model.`
      : `No GPU a model can use; ${gb(ramMB)} GB of system RAM, so everything runs on the processor.`;

  cached = {
    platform,
    arch,
    appleSilicon,
    cuda,
    ramMB,
    freeDiskMB,
    modelMemoryMB,
    memoryBasis,
    detail,
  };
  return cached;
}

/** Drop the cache. For tests and for the wizard's "check again" button. */
export function forgetSystemProfile(): void {
  cached = null;
}
