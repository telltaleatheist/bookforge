/**
 * Idle-shutdown window for the streaming TTS engines.
 *
 * A warm engine holds several GB of weights, so it releases itself after a spell
 * with no generation. How long that spell is belongs to the user — someone reading
 * article after article wants it to stay hot; someone who streamed one paragraph
 * wants the memory back — so it's a persisted setting rather than a constant.
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
