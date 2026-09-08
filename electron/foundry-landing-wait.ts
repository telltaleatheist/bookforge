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

// ─────────────────────────────────────────────────────────────────────────────
// Waiting for an IMPLIED export to be WRITTEN — the other half, and a different
// fact
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The implied exports this process has ordered, by the path they will be written
 * to, each held as the promise `exportEpubFromStep` returned for it.
 *
 * ── Why this registry has to exist at all ───────────────────────────────────
 *
 * An export ordered through the mount NEVER enters BookForge's queue.
 * `exportEpubFromStep` ends in `queue.enqueueHere(request, stepId)` — Foundry's
 * own internal list, deliberately, and the seam says so in as many words:
 * *"ONLY WHAT A PERSON PRESSED IN THIS WINDOW ROUTES. An export the host itself
 * ordered stays on Foundry's internal queue."* So there is no row of ours to
 * wait on, no `outputPath` of ours to match, and nothing in `queue-engine.json`
 * that could ever mention it. The first cut of the implied-export wave watched
 * our own rows for it and therefore watched for something that cannot appear:
 * the race resolved null every time and the press quietly ordered a second
 * export (Owen, 2026-09-08 — three presses, six empty `implied-*` folders).
 *
 * What the mount DOES give us is the promise, which settles exactly when the
 * export lands or fails, whatever hour that is — a deferred one waits on the
 * very text pass the narration is chained behind. So the promise is the fact,
 * and this holds it for the `foundry-export-landing` step to await instead of
 * polling a directory.
 *
 * NOT A CACHE, AND NOT LOAD-BEARING ACROSS A RESTART. An app that stops loses
 * every entry here, and the step falls back to asking the filesystem, which is
 * the honest answer when nobody is left holding the promise.
 */
const impliedExportsInFlight = new Map<string, Promise<unknown>>();

function impliedLane(toPath: string): string {
  return toPath.replace(/\\/g, '/').toLowerCase();
}

/** Hold the ordered export's promise under the path it will be written to. */
export function noteImpliedExportOrdered(toPath: string, landing: Promise<unknown>): void {
  const lane = impliedLane(toPath);
  impliedExportsInFlight.set(lane, landing);
  void landing.then(() => undefined, () => undefined).then(() => {
    if (impliedExportsInFlight.get(lane) === landing) impliedExportsInFlight.delete(lane);
  });
}

/**
 * Wait for the implied export at `toPath` to settle, or return `'unheld'` at
 * once when nobody in this process ordered it — which is what a restart leaves
 * behind, and is a fact the caller must be told rather than have smoothed over.
 *
 * A FAILED export settles this wait too, and REJECTS it with Foundry's own
 * sentence: the step then says why the book it was to read was never written,
 * in the engine's words rather than in a guess of ours.
 */
export function awaitImpliedExport(
  toPath: string,
  signal: AbortSignal,
): Promise<'landed' | 'unheld'> {
  const landing = impliedExportsInFlight.get(impliedLane(toPath));
  if (landing === undefined) return Promise.resolve('unheld');
  return new Promise<'landed' | 'unheld'>((resolve, reject) => {
    const onAbort = (): void => reject(new Error('Stopped while waiting for the book to be written.'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    void landing.then(
      () => { signal.removeEventListener('abort', onAbort); resolve('landed'); },
      (err: unknown) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}
