/**
 * WHICH PROCESS ACTUALLY DOES THE WORK AT A REGISTERED ADDRESS — the one
 * resolver, and the only place in this app that follows an orchestrator's hop.
 *
 * ── The relation ──────────────────────────────────────────────────────────
 *
 * crucible `docs/PHASE17-ORCHESTRATOR.md`. A Crucible process declares a
 * `role`. An `engine` serves job types on a backend. An `orchestrator` has
 * backend kind `orchestrator`, serves ZERO job types, manages exactly one
 * engine, and reads capability THROUGH to it. It is a property of a PROCESS
 * and never of an install: on this machine ONE install runs both, as two
 * processes on two ports — measured 2026-09-15, `:7101` answers
 * `role: orchestrator` naming `crucible@owens-pc-wsl` at `:7100`, and `:7100`
 * answers `role: engine` with eleven job types and `managed_by` the first.
 *
 * ── The rule, and why it is the SDK's ─────────────────────────────────────
 *
 * `engineOf(info)` (PHASE17 §6) is the whole of it and is never re-derived
 * here: `null` means "this IS the engine, talk to the address you have", an
 * `EngineRef` means "follow `engine.url` ONCE, with the SAME token". Once, and
 * never a chain — and that is ENFORCED rather than assumed: the second document
 * is READ, and a second `role` that is not `engine` is refused by name instead
 * of followed. An orchestrator whose `engine.url` named another orchestrator
 * would otherwise loop.
 *
 * ── What follows the hop, and what deliberately does not ──────────────────
 *
 * Anything that asks a machine to WORK resolves through: only an engine can
 * serve a job type, so a claim, a capability read or a settings door aimed at
 * an orchestrator is a request that ends in `job_type_not_served`. The BENCH
 * resolves through for the same reason one step further back — a GPU row for a
 * process with no card is a lane the scheduler could place work into that
 * nothing can serve (`shared/queue/slot-sets.ts`'s `EngineRole`).
 *
 * Two things stay on the process the operator NAMED. Opening a console is a
 * person going to look at the process they typed in, and after Phase 17 the
 * orchestrator's console is the one carrying install, restart and quit. And
 * adopting a pairing file records the address that handed out the connect code.
 * Neither is a request to do work, so neither follows the hop. (This mirrors
 * Foundry, which landed the same division first — two apps talking to the same
 * two processes must not answer "which process is this" differently.)
 *
 * ── The cache ─────────────────────────────────────────────────────────────
 *
 * Keyed on NAME + URL and never on the token: a rotated token cannot change
 * which process answers an address, and the token is taken from the entry in
 * hand on every call, so a rotation can never be served a stale secret — there
 * is no token in anything this module stores. Sixty seconds, because the answer
 * changes when somebody installs or moves an engine and not otherwise, and
 * in-flight calls are deduplicated so ten claims at once are one round trip.
 * It is forgotten on a registry change by {@link forgetResolvedEngine}.
 */
import { CrucibleClient, CrucibleProtocolError, engineOf } from '@crucible/client';
import type { EngineRef, ServerInfo } from '@crucible/client';
import { noteCrucibleRole } from './routes';

/** One registry row, as much of it as resolving needs. */
export interface EngineEntry {
  readonly name: string;
  readonly url: string;
  readonly token: string;
}

/** Where the work goes, and what was in front of it. */
export interface ResolvedEngine {
  /** The registered name this was resolved FROM. */
  readonly server: string;
  /**
   * The address that serves job types: the entry's own when it is the engine,
   * the orchestrator's `engine.url` when it is not. This is what a client is
   * built against.
   */
  readonly url: string;
  /** The ENGINE's own `/v1/info`, already read — never the orchestrator's. */
  readonly info: ServerInfo;
  /**
   * The orchestrator that was followed, or `null` when the registered address
   * is the engine itself. A caller that wants to SAY what it did reads this;
   * one that only wants to send work reads {@link url}.
   */
  readonly through: EngineRef | null;
}

/** How long one answer stands. See the cache note in the header. */
export const RESOLVE_TTL_MS = 60_000;

interface CacheRow {
  /** name + url, so a row re-pointed at another machine is a different key. */
  readonly key: string;
  readonly at: number;
  readonly resolved: ResolvedEngine;
}

const byName = new Map<string, CacheRow>();
const inFlight = new Map<string, Promise<ResolvedEngine>>();

function keyOf(entry: EngineEntry): string {
  return `${entry.name}\n${entry.url}`;
}

/**
 * Forget one resolution, or all of them.
 *
 * Called when the registry changes — a server removed, re-pointed or
 * uninstalled. It runs BEFORE anything that reads capability, because
 * capability now reads through a hop and a stale hop would send that read to a
 * machine the operator has just taken away.
 */
export function forgetResolvedEngine(name?: string): void {
  if (name === undefined) {
    byName.clear();
    inFlight.clear();
    return;
  }
  byName.delete(name);
  inFlight.delete(name);
}

/**
 * The engine behind a registered address: `info()` once, the SDK's rule, and at
 * most one hop.
 *
 * Records the role on the way past (`crucible/routes.ts`), because this is the
 * moment it is known and the bench answers it inside a synchronous pump.
 *
 * Throws, by name and with a sentence a person can act on:
 *
 * * `crucible_orchestrator_has_no_engine` — that machine's orchestrator manages
 *   nothing. A fact to show next to the button that installs one, not a fault.
 * * `crucible_orchestrator_chain` — its `engine.url` answered with something
 *   that is not an engine. Refused rather than followed again.
 */
export async function resolveEngine(entry: EngineEntry, clientName: string): Promise<ResolvedEngine> {
  const cached = byName.get(entry.name);
  if (cached !== undefined && cached.key === keyOf(entry) && Date.now() - cached.at < RESOLVE_TTL_MS) {
    return cached.resolved;
  }
  // A key that moved is a different machine: drop the row rather than let it
  // stand until it expires.
  if (cached !== undefined && cached.key !== keyOf(entry)) byName.delete(entry.name);

  const running = inFlight.get(entry.name);
  if (running !== undefined) return running;

  const run = resolveNow(entry, clientName).finally(() => { inFlight.delete(entry.name); });
  inFlight.set(entry.name, run);
  return run;
}

async function resolveNow(entry: EngineEntry, clientName: string): Promise<ResolvedEngine> {
  const front = await new CrucibleClient({ url: entry.url, token: entry.token, clientName }).info();
  // The record is filled from the FIRST document, which is the one that says
  // what the registered address is. The second says what the engine is.
  noteCrucibleRole(entry.name, front);

  let ref: EngineRef | null;
  try {
    ref = engineOf(front);
  } catch (err) {
    if (err instanceof CrucibleProtocolError) {
      throw new Error(
        `crucible_orchestrator_has_no_engine: "${entry.name}" (${entry.url}) is a Crucible `
          + 'orchestrator and manages no engine, so there is nothing there to do work. Install one '
          + 'from its own console.',
      );
    }
    throw err;
  }
  if (ref === null) {
    const resolved: ResolvedEngine = { server: entry.name, url: entry.url, info: front, through: null };
    remember(entry, resolved);
    return resolved;
  }

  /*
   * ONE HOP, AND THE SECOND DOCUMENT IS READ. Following `engine.url` on trust
   * would make a misconfigured chain an infinite one; reading it costs a round
   * trip that is cached for a minute and turns the rule into something this app
   * ENFORCES rather than assumes.
   */
  const behind = await new CrucibleClient({ url: ref.url, token: entry.token, clientName }).info();
  if (behind.role !== 'engine') {
    throw new Error(
      `crucible_orchestrator_chain: "${entry.name}" (${entry.url}) is an orchestrator whose engine `
        + `at ${ref.url} answers "${behind.role}" and not "engine". An app follows one hop and no `
        + 'more — this is a misconfiguration on those machines, not something to follow again.',
    );
  }
  const resolved: ResolvedEngine = { server: entry.name, url: ref.url, info: behind, through: ref };
  remember(entry, resolved);
  return resolved;
}

function remember(entry: EngineEntry, resolved: ResolvedEngine): void {
  byName.set(entry.name, { key: keyOf(entry), at: Date.now(), resolved });
}

/**
 * A client bound to the ENGINE behind a registered address.
 *
 * The token comes from the entry handed in on every call and is never held by
 * this module, so a rotation takes effect at once and a cached resolution can
 * never serve an old secret.
 */
export async function engineClientFor(entry: EngineEntry, clientName: string): Promise<CrucibleClient> {
  const resolved = await resolveEngine(entry, clientName);
  return new CrucibleClient({ url: resolved.url, token: entry.token, clientName });
}
