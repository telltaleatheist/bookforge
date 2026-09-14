/**
 * Idle-shutdown window for the streaming TTS engines.
 *
 * A warm engine holds several GB of weights, so it releases itself after a spell
 * with no generation. How long that spell is belongs to the user — someone reading
 * article after article wants it to stay hot; someone who streamed one paragraph
 * wants the memory back — so it's a persisted setting rather than a constant.
 *
 * Since 2026-08-11 the window applies in SERVICE MODE too. Service mode used to
 * be exempt, which meant starting the TTS server for the browser extension held
 * ~14 GB until the app quit. Now the timeout PARKS the engine instead of turning
 * the service off: the worker is killed, serviceMode stays true, the TTS API
 * server keeps listening, and the next speak cold-starts the worker again.
 *
 * Lives in its own module, not in streaming-engine.ts, because BOTH worker pools
 * need to read it and streaming-engine.ts already imports them: putting it there
 * would close an import cycle.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** Never shut down on idle. */
export const IDLE_NEVER = 0;
export const DEFAULT_IDLE_MINUTES = 15;
/** The choices offered to clients (0 = never). Kept here so the app, the API and
 *  the extension all present the same ladder. */
export const IDLE_CHOICES = [5, 10, 15, 30, 60, IDLE_NEVER];
const MAX_IDLE_MINUTES = 24 * 60;

let cached: number | null = null;

function configPath(): string {
  return path.join(app.getPath('userData'), 'tts-idle.json');
}

export function getIdleMinutes(): number {
  if (cached !== null) return cached;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
    cached = normalize(raw?.idleMinutes);
  } catch {
    cached = DEFAULT_IDLE_MINUTES; // first run / unreadable
  }
  return cached;
}

/** Persist a new window. Returns the value actually stored (clamped). */
export function setIdleMinutes(minutes: unknown): number {
  const next = normalize(minutes);
  cached = next;
  try {
    fs.writeFileSync(configPath(), JSON.stringify({ idleMinutes: next }, null, 2));
  } catch (err) {
    console.error('[StreamIdle] Failed to persist tts-idle.json:', err);
  }
  return next;
}

/** Milliseconds of inactivity before shutdown, or null when set to never. */
export function getIdleTimeoutMs(): number | null {
  const minutes = getIdleMinutes();
  return minutes === IDLE_NEVER ? null : minutes * 60_000;
}

function normalize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_IDLE_MINUTES;
  if (value <= 0) return IDLE_NEVER;
  return Math.min(MAX_IDLE_MINUTES, Math.round(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// The sweep — ONE rule, applied by every streaming backend
// ─────────────────────────────────────────────────────────────────────────────

/** How often the sweep asks whether the window has run out. */
const IDLE_SWEEP_MS = 60_000;

/** What a backend tells the sweep, and what the sweep may do to it. */
export interface IdleWatchHooks {
  /** A log prefix, e.g. `[Orpheus Pool]`, so the line names who parked. */
  readonly label: string;
  /** Is there anything to release right now? A stopped backend never fires. */
  isActive(): boolean;
  /** Service mode PARKS (the backend goes, the service stays armed) rather than shutting down. */
  isServiceMode(): boolean;
  /** Release the backend but keep the service armed. */
  park(): void;
  /** Release the backend and the service. */
  shutdown(): void;
}

/**
 * The idle rule as a thing a backend arms, touches and disarms.
 *
 * Lifted out of `orpheus-worker-pool.ts` on 2026-09-14, when the Listen path
 * gained a second backend — a Crucible streaming session (`electron/crucible/
 * stream.ts`) — that has to release itself on exactly the same rule: the
 * user's window, read per sweep so a change applies to a running backend, and
 * parking rather than stopping in service mode. Two hand-written sweeps would
 * be one rule with two owners (crucible `docs/ARCHITECTURE.md` R1), and the
 * day one of them forgot the service-mode branch a browser extension would
 * find its endpoint gone instead of cold. So the sweep lives beside the
 * setting it reads, and a backend supplies only the four facts it owns.
 *
 * `touch()` is what every generation calls; the sweep compares against the
 * last touch. `arm()` starts the interval (and touches, so a freshly started
 * backend is not idle by its own start-up time); `disarm()` clears it. The
 * interval is `unref`'d so it never keeps the process alive on its own.
 */
export class IdleWatch {
  private lastActivityAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly hooks: IdleWatchHooks) {}

  /** Something just happened — the window starts over. */
  touch(): void {
    this.lastActivityAt = Date.now();
  }

  /** Start sweeping. Re-arming an armed watch restarts it. */
  arm(): void {
    this.disarm();
    this.touch();
    this.timer = setInterval(() => this.sweep(), IDLE_SWEEP_MS);
    this.timer.unref?.();
  }

  disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One tick of the rule. Exposed so a keeper can fire it without waiting a minute. */
  sweep(): void {
    const timeoutMs = getIdleTimeoutMs();
    if (timeoutMs === null) return; // set to never
    if (!this.hooks.isActive() || Date.now() - this.lastActivityAt <= timeoutMs) return;
    const minutes = Math.round(timeoutMs / 60000);
    // Service mode is not exempt: the weights come down either way. It just
    // PARKS — the service stays armed and the next speak cold-starts a worker.
    if (this.hooks.isServiceMode()) {
      console.log(`${this.hooks.label} Idle for ${minutes} min — parking the engine (service stays armed)`);
      this.hooks.park();
    } else {
      console.log(`${this.hooks.label} Idle for ${minutes} min — shutting down`);
      this.hooks.shutdown();
    }
  }
}
