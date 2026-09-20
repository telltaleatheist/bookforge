/**
 * THE CRUCIBLE REGISTRY, HANDED TO THE HOSTED FOUNDRY WINDOW.
 *
 * ── Owen's ruling, 2026-09-14: one owner ───────────────────────────────────
 *
 * *"hosted Foundry reads BookForge's server registry."* The vendored window
 * runs inside THIS process against THIS machine's cards, so a second registry
 * over there would be a second set of tokens and a second ranking dispatching
 * against the same GPUs BookForge's own scheduler is rationing. There is one
 * registry — `<userData>/crucible-servers.json`, and since 2026-09-15 that is
 * ALL of it — and this module is the door it reaches the window through
 * (`FoundryHost.servers()`, foundry `e096734`).
 *
 * ── WHY A SNAPSHOT, AND WHY THAT IS NOT A CACHE ───────────────────────────
 *
 * Their seam is **synchronous and read at every use**: `computeSlots()` runs
 * while the queue page is being painted, so it cannot await. Ours is two file
 * reads with a bearer token in one of them, and re-deriving it under every paint
 * of a window that is not this app's to profile is not a bargain worth making.
 *
 * So the fact has an owner and a derivation (crucible `docs/ARCHITECTURE.md`
 * R1): **the registry file and the rank record are the fact**, and the snapshot
 * below is derived from them at NAMED MOMENTS — app start, every write that can
 * change the list (add, remove, re-rank, enable/disable, forget), and the
 * Servers panel's read, which is where a person presses Re-check. It carries
 * the instant it was taken (`readAt`) so a log line can say how old the answer
 * the window is using is.
 *
 * It is not a cache with a lifetime, and the difference is the part that
 * matters: a cache answers with something stale when nobody refreshed it, and
 * this **refuses** (`registry_snapshot_not_taken`). An empty array would be a
 * lie the window cannot tell from "you have no servers", and it would park
 * every hosted row on a sentence nobody can act on.
 *
 * ── What crosses, exactly ─────────────────────────────────────────────────
 *
 * `{name, url, token, enabled}` in PRIORITY ORDER, disabled entries included
 * and marked — their derivation filters, so ours must not, or a disabled server
 * would be invisible to the code whose job is to say "that one is switched
 * off". The URL is the base the registry stores, with no `/v1` and no
 * `/openai`: the vendored dispatcher composes the OpenAI base itself, and a
 * transform here would be the second composer of one address.
 *
 * THE TOKEN CROSSES, AND IT IS NOT A NEW EXPOSURE. Hosted, the window is this
 * process with this userData; the registry file is already readable by that
 * code. What the seam adds is that BookForge SAYS which servers it means,
 * instead of the window going looking for a file it should not know the name
 * of. Nothing here is logged but names — see {@link describeHostCrucibleRegistry}.
 */
import { onCrucibleRecordChanged } from './routes';
import { readRouting } from './routing';
import { getServer, CrucibleRegistryError, type ResolvedServer } from './servers';
import type { RoutingView } from '../../shared/crucible/settings-wire';

/**
 * One server as the hosted window receives it — Foundry's `CrucibleServerEntry`
 * (`foundry-app/electron/app-settings.ts`), re-declared here on the house rule
 * this seam is written to everywhere else: their published shape is written out
 * rather than imported, so a change on their side is a compile error in a file
 * whose comments say what the field meant.
 *
 * `enabled` is ALWAYS sent, never omitted. Their reader treats a missing field
 * as enabled (`entry.enabled !== false`), and relying on that would make our
 * "switched off" depend on their default rather than on our record.
 */
export interface HostCrucibleServer {
  /** How this machine names the server — the operator's own word for it. */
  name: string;
  /** The base URL as the registry stores it — no `/v1`, no `/openai`. */
  url: string;
  /** The bearer token. Never empty: a Crucible has no anonymous mode. */
  token: string;
  /** Whether the queue may place work on it. Disabled entries still cross. */
  enabled: boolean;
}

/** A name that was in the ranking and could not be resolved, with the reason. */
export interface HostRegistryOmission {
  name: string;
  code: string;
  reason: string;
}

/** One reading of this machine's registry, and when it was taken. */
export interface HostCrucibleRegistrySnapshot {
  /** ISO 8601. What "how old is this" is answered from. */
  readAt: string;
  /** Priority order, disabled included. */
  servers: HostCrucibleServer[];
  /**
   * Names the ranking held that could not be resolved into an entry, each with
   * the registry's own refusal. They are OMITTED from `servers` rather than
   * passed on — their entry shape has no refusal field, and a row with no token
   * would fail at the press with a worse sentence than this one — and they are
   * recorded here so the omission is a stated fact rather than a silent gap.
   */
  omitted: HostRegistryOmission[];
}

/** The one way this module refuses. */
export class CrucibleHostRegistryError extends Error {
  readonly code = 'registry_snapshot_not_taken';

  constructor(message: string) {
    super(`registry_snapshot_not_taken: ${message}`);
    this.name = 'CrucibleHostRegistryError';
  }
}

/**
 * The two reads a snapshot is composed from, injectable so a keeper can drive
 * every branch with no registry file, no routing record and no WSL guest.
 */
export interface HostRegistryReader {
  /** The rank/enable record resolved against the servers that exist. */
  routing(): RoutingView;
  /** One server WITH its token, from the registry. */
  server(name: string): ResolvedServer;
}

/** The real one. */
export function processHostRegistryReader(): HostRegistryReader {
  return { routing: readRouting, server: getServer };
}

let snapshot: HostCrucibleRegistrySnapshot | null = null;

/**
 * TAKE THE READING. Called at the named moments listed in this module's header
 * and nowhere else; every other caller reads {@link hostCrucibleServers}.
 *
 * ── What propagates, and what is recorded ─────────────────────────────────
 *
 * A failure to read the RECORDS propagates by name — a corrupt registry
 * (`corrupt_registry`) is a file holding every token that nothing here will
 * replace, and answering a window with an empty list instead would hand it
 * "you have no servers" for "I could not read yours". The caller logs it and
 * the previous snapshot, if there is one, stands rather than being wiped by a
 * failed read.
 *
 * A failure to resolve ONE NAME in the ranking is recorded and that name is
 * omitted: a name that vanished between the two reads (`unknown_server`) is a
 * server somebody removed a moment ago. That is about one row, and it is not a
 * reason to hand over nothing.
 */
export function refreshHostCrucibleRegistry(
  reader: HostRegistryReader = processHostRegistryReader(),
): HostCrucibleRegistrySnapshot {
  const view = reader.routing();
  const servers: HostCrucibleServer[] = [];
  const omitted: HostRegistryOmission[] = [];
  for (const row of view.ranked) {
    let resolved: ResolvedServer;
    try {
      resolved = reader.server(row.name);
    } catch (err) {
      if (err instanceof CrucibleRegistryError) {
        omitted.push({ name: row.name, code: err.code, reason: err.message });
        continue;
      }
      throw err;
    }
    servers.push({
      name: row.name,
      url: resolved.url,
      token: resolved.token,
      enabled: row.enabled,
    });
  }
  const taken: HostCrucibleRegistrySnapshot = {
    readAt: new Date().toISOString(),
    servers,
    omitted,
  };
  snapshot = taken;
  return taken;
}

/**
 * WHAT THE HOSTED WINDOW IS HANDED — the last reading, refusing by name when
 * there has not been one.
 *
 * Their reader catches a throw and logs it as an empty registry
 * (`crucible-registry.ts hostServers`), which is the right end of the rule for
 * a function called while a page paints. So this refusal is a LOG LINE over
 * there rather than a broken window — and that is exactly what it should be: a
 * hosted window drawing no slots because nobody took a reading is a bug in this
 * app's startup, and it must be visible as one rather than as "you have no
 * Crucible servers".
 */
export function hostCrucibleServers(): readonly HostCrucibleServer[] {
  if (snapshot === null) {
    throw new CrucibleHostRegistryError(
      'the hosted Foundry window asked for this machine\'s Crucible servers before BookForge took '
      + 'a reading of its registry. The snapshot is refreshed at app start and at every write to '
      + 'the registry or the rank record (electron/crucible/host-registry.ts); nothing is being '
      + 'hidden and no list is being guessed at.',
    );
  }
  return snapshot.servers;
}

/** The last reading, whole, for a log line or a settings read. Null before the first. */
export function hostCrucibleRegistrySnapshot(): HostCrucibleRegistrySnapshot | null {
  return snapshot;
}

/**
 * ONE LINE, NAMES ONLY. A registry line that printed a URL would be harmless
 * and a registry line that printed a token would not, so this prints neither —
 * `servers.ts maskToken`'s rule, applied by not having the value at all.
 */
export function describeHostCrucibleRegistry(taken: HostCrucibleRegistrySnapshot): string {
  const names = taken.servers.map((row) => (row.enabled ? row.name : `${row.name} (off)`));
  const gone = taken.omitted.map((row) => `${row.name}: ${row.code}`);
  return `[crucible] hosted Foundry registry at ${taken.readAt}: `
    + `${names.length === 0 ? 'no servers' : names.join(', ')}`
    + `${gone.length === 0 ? '' : ` — omitted ${gone.join('; ')}`}`;
}

/** Forget the reading. For a keeper that drives the "never taken" refusal. */
export function forgetHostCrucibleRegistrySnapshot(): void {
  snapshot = null;
}

/** The live subscription, so arming twice replaces rather than doubles. */
let disarmRecordListener: (() => void) | null = null;

/**
 * TAKE A NEW READING WHENEVER THE REGISTRY OR THE RANK RECORD MOVES — bug hunt
 * C10, 2026-09-20.
 *
 * The header says the snapshot is refreshed *"at every write that can change
 * the list"*. It was not: `refreshHostCrucibleRegistry` was called from ten IPC
 * handlers and startup, while the SCHEDULER is told by
 * `announceCrucibleRecordChanged()` inside `servers.addServer` /
 * `servers.removeServer` / `routing.setServerEnabled` / `setRoutingOrder` /
 * `forgetRoutingName` — deliberately there, so a non-IPC writer could not
 * forget. Auto-connect, the pairing flow and the CLI are all non-IPC writers.
 * So the hosted snapshot had exactly the failure mode `servers.ts` was
 * refactored to remove: a fact nobody told it about.
 *
 * Subscribing HERE rather than adding a call beside each announce keeps the one
 * rule in one place, and means `main.ts` needs no wiring at all — this module is
 * imported at startup and arms itself below.
 *
 * A read that throws (a corrupt registry) is caught and logged by
 * `routes.recordChanged`, which is the right end of the rule: the PREVIOUS
 * snapshot stands rather than being wiped by a failed read, exactly as
 * {@link refreshHostCrucibleRegistry}'s own docstring promises.
 *
 * `reader` exists for a keeper; the app passes none. Returns a disarm.
 */
export function armHostCrucibleRegistryRefresh(
  reader: HostRegistryReader = processHostRegistryReader(),
): () => void {
  disarmRecordListener?.();
  disarmRecordListener = onCrucibleRecordChanged(() => {
    refreshHostCrucibleRegistry(reader);
  });
  return () => {
    disarmRecordListener?.();
    disarmRecordListener = null;
  };
}

/*
 * ARMED ON IMPORT, and that is the point: a registration `main.ts` had to
 * remember is a registration a later refactor drops, which is the shape of the
 * defect above. Registering a listener reads nothing and touches no disk, so it
 * is safe at module scope; the READ happens only when something announces.
 */
armHostCrucibleRegistryRefresh();
