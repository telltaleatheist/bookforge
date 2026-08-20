/**
 * GPU thermal sampler — nvidia-smi, every 20 seconds, ONLY while a GPU step runs.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * 2026-08-19: a narration ran ~15% under its measured band and read as a code
 * regression. It was the card — 86°, fan already at 96%, the driver's SW
 * thermal slowdown active, clocks cut ~10% — and the throttle counters showed
 * SEVEN HOURS of accumulated slowdown since boot, meaning every long run that
 * week had been quietly part-throttled. Nothing in the app could have said so.
 * Now the queue records what the card reports, the bench says it out loud, and
 * a finished run's analytics carry the thermal story
 * (electron/queue-engine.ts settleStep → analytics.gpuThermal).
 *
 * ── What it refuses to do ───────────────────────────────────────────────────
 *
 *  - No reading is ever invented. nvidia-smi missing, a field unparseable, a
 *    non-win32 platform → NO sample, and the snapshot simply carries none.
 *    The Mac renders on MLX and has no nvidia-smi; it gets no thermal row, not
 *    a fake one.
 *  - The throttle verdict is the DRIVER'S: the thermal bits of
 *    clocks_event_reasons.active (0x20 SW thermal, 0x40 HW thermal). Not a
 *    temperature threshold this app made up — measured support for the query
 *    on this machine's driver before this was written.
 *  - It never samples an idle card. The point is what happens to RUNS; a timer
 *    spawning nvidia-smi all day to watch nothing is heat of its own.
 */

import { execFile } from 'node:child_process';

import type { GpuThermalReading } from '../shared/queue/engine-types';
import { hasRunningGpuStep, recordGpuThermal } from './queue-engine';

const SAMPLE_MS = 20_000;

/** nvmlClocksThrottleReason: SwThermalSlowdown | HwThermalSlowdown. */
const THERMAL_BITS = 0x20n | 0x40n;

const QUERY = [
  '--query-gpu=temperature.gpu,fan.speed,power.draw,clocks.sm,clocks.max.sm,clocks_event_reasons.active',
  '--format=csv,noheader',
];

let timer: ReturnType<typeof setInterval> | null = null;
let sampling = false;
/** Set on the first hard failure; the sampler then stays quiet for the session. */
let disabled = false;
/** Whether the engine currently holds a reading — so idle clears exactly once. */
let engineHasReading = false;

function parseSample(line: string): GpuThermalReading | null {
  // "87, 96 %, 350.76 W, 1950 MHz, 2115 MHz, 0x0000000000000020"
  const parts = line.trim().split(',').map((p) => p.trim());
  if (parts.length !== 6) return null;
  const tempC = Number(parts[0]);
  const fanPct = Number(parts[1].replace('%', '').trim());
  const powerW = Number(parts[2].replace('W', '').trim());
  const clocksMhz = Number(parts[3].replace('MHz', '').trim());
  const clocksMaxMhz = Number(parts[4].replace('MHz', '').trim());
  if (!Number.isFinite(tempC) || !parts[5].startsWith('0x')) return null;
  let mask: bigint;
  try {
    mask = BigInt(parts[5]);
  } catch {
    return null;
  }
  return {
    tempC,
    ...(Number.isFinite(fanPct) ? { fanPct } : {}),
    ...(Number.isFinite(powerW) ? { powerW } : {}),
    ...(Number.isFinite(clocksMhz) ? { clocksMhz } : {}),
    ...(Number.isFinite(clocksMaxMhz) ? { clocksMaxMhz } : {}),
    throttleActive: (mask & THERMAL_BITS) !== 0n,
    at: new Date().toISOString(),
  };
}

function sampleOnce(): void {
  if (sampling) return;
  sampling = true;
  execFile('nvidia-smi', QUERY, { timeout: 10_000, windowsHide: true }, (err, stdout) => {
    sampling = false;
    if (err) {
      // No nvidia-smi, or a driver that cannot answer: this machine has no
      // thermal story to tell. Said once, then silence — not once per 20s.
      if (!disabled) {
        disabled = true;
        console.warn('[GPU-THERMAL] sampling disabled for this session:', err.message);
      }
      return;
    }
    const reading = parseSample(stdout);
    if (reading === null) {
      if (!disabled) {
        disabled = true;
        console.warn('[GPU-THERMAL] sampling disabled: unparseable nvidia-smi output:',
          stdout.trim().slice(0, 120));
      }
      return;
    }
    engineHasReading = true;
    recordGpuThermal(reading);
  });
}

/**
 * Start the sampler. Idempotent; safe to call once at queue init.
 *
 * win32-only by design: this is the machine with the card. WSL renders on the
 * same physical GPU, and the Windows-side nvidia-smi sees it — the reading is
 * about the silicon, not about which OS the worker runs in.
 */
export function startGpuThermalSampler(): void {
  if (process.platform !== 'win32' || timer !== null) return;
  timer = setInterval(() => {
    if (disabled) return;
    if (!hasRunningGpuStep()) {
      // Nothing on the card: retire the reading rather than letting a stale
      // temperature sit on the snapshot describing a run that ended.
      if (engineHasReading) {
        engineHasReading = false;
        recordGpuThermal(null);
      }
      return;
    }
    sampleOnce();
  }, SAMPLE_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

export function stopGpuThermalSampler(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
