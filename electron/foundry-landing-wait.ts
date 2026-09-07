/**
 * foundry-landing-wait — the pure half of "narrate on a pending export"
 * (Owen, 2026-09-07), kept free of every app-bound import so the keeper can load
 * it under plain node: the registry a chained narration waits on, and the
 * lookup that turns a landed export into the version the library filed.
 */
import type { ProjectVariant } from './manifest-types';

// Waiting for a landing to be RECORDED — the `foundry-export-landing` step's door.
//
// A narration chained onto an export that has not landed yet (Owen, 2026-09-07)
// runs the moment the export's row settles — and Foundry announces the landing
// (`onExport`) BEFORE it settles that row, while recording it here is
// asynchronous (a claims read, a file copy, a manifest write). So at the moment
// the chained step runs, the version may be announced-and-not-yet-filed, or the
// announcement may not have been delivered at all. Neither is a reason to poll
// the manifest and neither is a reason to give up: the announcement is a
// PROMISE this side can hold, and this registry holds it by (project key, file
// name) so the step can wait on the exact fact it needs — "the recording of THIS
// file has settled" — and then read the manifest once.
//
// A recording that FAILED still settles the wait: the step then finds no
// version and refuses by name, with the reason already in the log above it.

const landingsInFlight = new Map<string, Promise<unknown>>();
const landingWaiters = new Map<string, Array<() => void>>();

function landingLane(projectKey: string, fileName: string): string {
  return `${projectKey}|${fileName.toLowerCase()}`;
}

/** Say that Foundry announced this landing and `recording` is its filing. */
export function noteFoundryLandingAnnounced(
  projectKey: string,
  fileName: string,
  recording: Promise<unknown>,
): void {
  const lane = landingLane(projectKey, fileName);
  landingsInFlight.set(lane, recording);
  void recording.then(() => undefined, () => undefined).then(() => {
    if (landingsInFlight.get(lane) === recording) landingsInFlight.delete(lane);
  });
  const waiting = landingWaiters.get(lane) ?? [];
  landingWaiters.delete(lane);
  for (const wake of waiting) wake();
}

/**
 * Resolve once the recording of this file's landing has SETTLED — whether it
 * was announced before this call or after it. Rejects only on `signal`.
 */
export function awaitFoundryLandingRecorded(
  projectKey: string,
  fileName: string,
  signal: AbortSignal,
): Promise<void> {
  const lane = landingLane(projectKey, fileName);
  const settledOf = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);
  const inFlight = landingsInFlight.get(lane);
  if (inFlight !== undefined) return settledOf(inFlight);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const left = (landingWaiters.get(lane) ?? []).filter((w) => w !== wake);
      if (left.length > 0) landingWaiters.set(lane, left); else landingWaiters.delete(lane);
      reject(new Error('Stopped while waiting for the export to be recorded.'));
    };
    const wake = () => {
      signal.removeEventListener('abort', onAbort);
      const recording = landingsInFlight.get(lane);
      void (recording === undefined ? Promise.resolve() : settledOf(recording)).then(resolve);
    };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    landingWaiters.set(lane, [...(landingWaiters.get(lane) ?? []), wake]);
  });
}

/**
 * The version this export was filed as, or null. Case-insensitive on the name,
 * as `FoundryVariantSource.fileName` is compared everywhere; a LIVE export
 * (`foundrySource`) stands ahead of a KEPT snapshot of the same tray name
 * (`promotedFrom`), as the narrate resolver's dedupe rules — both present means
 * the tray's current bytes.
 */
export function findLandedExport(
  variants: readonly ProjectVariant[],
  projectKey: string,
  fileName: string,
): ProjectVariant | null {
  const want = fileName.toLowerCase();
  const matches = variants.filter((v) => {
    const src = v.foundrySource ?? v.promotedFrom;
    return src !== undefined && src.projectKey === projectKey
      && src.fileName.toLowerCase() === want && v.format.toLowerCase() === 'epub';
  });
  const live = matches.find((v) => v.foundrySource !== undefined);
  return live ?? matches[0] ?? null;
}
