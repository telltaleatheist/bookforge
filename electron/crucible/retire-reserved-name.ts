/**
 * THE ONE-TIME MOVE OF `local` OUT OF THIS MACHINE'S RECORDS.
 *
 * ── What was there before, and what has to happen to it ────────────────────
 *
 * Until 2026-09-15 `local` was a RESERVED Crucible server name: not a registry
 * entry, but a row the app manufactured from this machine's own `config.toml`
 * or pairing file. Owen's ruling deleted the idea ("a local crucible server
 * shouldnt be treated any differently than a remote crucible server"), and
 * `servers.ts` now knows only registry entries.
 *
 * Four records on this machine can still NAME it, and every one of them was
 * written by the app itself:
 *
 *   <userData>/crucible-servers.json    the registry — where the entry must GO
 *   <userData>/crucible-routing.json    `order` / `disabled`, the operator's rank
 *   <userData>/crucible-upstreams.json  one learned fact per server name
 *   <userData>/queue-engine.json        `waitFor`, `waitForResolved`, a step's `venue`
 *
 * Leaving them would not be a cosmetic problem. A queued book whose `waitFor`
 * says `local` would refuse `unknown_server` for ever; a finished step whose
 * `venue` says `local` would keep a bench row alive under a name nothing can
 * resolve. So this runs ONCE, before anything reads any of them, and rewrites
 * every reference in the same pass.
 *
 * ── WHAT `local` BECOMES ───────────────────────────────────────────────────
 *
 * An ordinary registry entry for the same machine, discovered the same way the
 * reserved name used to be resolved (`discovery.ts` — the pairing file, else
 * `config.toml`, on Windows through `wsl.exe`) and carrying the same token.
 *
 * Its NAME is, in order:
 *
 *   1. the name of a registry entry that ALREADY has that URL, if there is one —
 *      the operator got there first, and adding a second row for one machine is
 *      the duplicate this whole ruling is about;
 *   2. otherwise the name the server calls ITSELF (`[server] name`, e.g.
 *      `crucible@owens-pc-wsl`), which is the only name in the world that
 *      nobody here invented.
 *
 * It is not "local", not a label, not a guess at what Owen would have typed. He
 * renames it by removing and re-adding it under the name he wants, which is the
 * same door every other server has.
 *
 * ── AND IF IT CANNOT BE DONE, NOTHING IS DONE ──────────────────────────────
 *
 * There is no partial migration and no silent drop. If discovery finds no
 * Crucible on this machine, or the name it offers is not a usable server name,
 * or that name is already taken by a DIFFERENT machine, this refuses BY NAME
 * ({@link RetireReservedNameError}) and writes nothing at all. The records keep
 * saying `local`, the rows that name it refuse `unknown_server` in their own
 * words, and the log line says exactly which record still holds the word and
 * what to do about it. A queue row stranded loudly is recoverable; one quietly
 * repointed at the wrong machine is not.
 *
 * ── Order, and why a crash in the middle is safe ───────────────────────────
 *
 * The registry is written FIRST, then the three records that point INTO it.
 * Each file is written temp-and-rename, like every other record here. A crash
 * between two of them leaves an entry that is simply registered plus records
 * that still say `local` — which is exactly the state this function is built to
 * find, so the next launch finishes the job. Running it twice is a no-op.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  CrucibleDiscoveryError,
  discoverCrucible,
  processDiscoveryHost,
  type DiscoveredCrucible,
} from './discovery';
import {
  CrucibleRegistryError,
  ServerRegistry,
  serverNameKey,
  originKey,
  validateServerName,
  type CrucibleServerEntry,
} from './servers';
import { getWslDistro } from '../tool-paths';

/**
 * THE RETIRED NAME, SPELLED ONCE, HERE.
 *
 * It is not a constant anything else may import: nothing in the app means it
 * any more, and a second file that could say `local` is a second file that could
 * start meaning it again. This module is the only thing that still recognises
 * the word, and only in order to remove it.
 */
const RETIRED_RESERVED_NAME = 'local';

export type RetireReservedNameErrorCode =
  /** Records name `local` and there is no Crucible on this machine to be it. */
  | 'reserved_name_unresolved'
  /** The discovered server's own name is not a usable server name. */
  | 'reserved_name_unusable'
  /** That name is already registered, for a DIFFERENT address. */
  | 'reserved_name_taken'
  /** One of the four records could not be read or written. */
  | 'reserved_name_record_unreadable';

export class RetireReservedNameError extends Error {
  readonly code: RetireReservedNameErrorCode;

  constructor(code: RetireReservedNameErrorCode, message: string) {
    super(message);
    this.name = 'RetireReservedNameError';
    this.code = code;
  }
}

/** Where the four records live, so a keeper can drive this over a temp dir. */
export interface RetireReservedNameHost {
  /** `<userData>`. */
  userData: string;
  /** What the reserved name used to resolve to. Throws {@link CrucibleDiscoveryError}. */
  discover: () => DiscoveredCrucible;
}

/** The real one. */
export function processRetireHost(userData: string): RetireReservedNameHost {
  return {
    userData,
    discover: () => discoverCrucible(processDiscoveryHost(getWslDistro())),
  };
}

/** What one run did, in enough detail for one log line. */
export interface RetireReservedNameReport {
  /** Which records named it. Empty means there was nothing to do. */
  found: string[];
  /** The registry name it became, or null when nothing was found. */
  becameName: string | null;
  /** True when this run ADDED the registry entry (false when it was already there). */
  registered: boolean;
  /** One line per record rewritten. */
  rewrote: string[];
}

const ROUTING_FILE = 'crucible-routing.json';
const UPSTREAMS_FILE = 'crucible-upstreams.json';
const QUEUE_FILE = 'queue-engine.json';
const REGISTRY_FILE = 'crucible-servers.json';

/**
 * Do it, or refuse by name having written nothing.
 *
 * Called once, from app start, BEFORE the queue engine loads its state and
 * before anything reads the routing or upstream records.
 */
export function retireReservedLocalName(host: RetireReservedNameHost): RetireReservedNameReport {
  const registryFile = path.join(host.userData, REGISTRY_FILE);
  const registry = new ServerRegistry(registryFile);

  /*
   * IF A SERVER IS ACTUALLY CALLED `local`, THERE IS NOTHING TO RETIRE.
   *
   * The name is free text now (`servers.ts validateServerName`), so an operator
   * may legitimately type it — reserving it in the other direction would be the
   * same defect upside down. A record naming `local` then names THEIR server,
   * and rewriting it would repoint their rows at a machine they did not choose.
   * Checked first, and it is also what makes a second run after a manual
   * re-add a no-op.
   */
  if (registry.read().servers.some((entry) => entry.name === RETIRED_RESERVED_NAME)) {
    return { found: [], becameName: null, registered: false, rewrote: [] };
  }

  const found: string[] = [];
  const routing = readJson(path.join(host.userData, ROUTING_FILE));
  const upstreams = readJson(path.join(host.userData, UPSTREAMS_FILE));
  const queue = readJson(path.join(host.userData, QUEUE_FILE));

  if (routingNamesIt(routing)) found.push(ROUTING_FILE);
  if (upstreamsNameIt(upstreams)) found.push(UPSTREAMS_FILE);
  if (queueNamesIt(queue)) found.push(QUEUE_FILE);

  if (found.length === 0) {
    return { found, becameName: null, registered: false, rewrote: [] };
  }

  // ── WHAT IT IS ───────────────────────────────────────────────────────────
  let discovered: DiscoveredCrucible;
  try {
    discovered = host.discover();
  } catch (err) {
    if (err instanceof CrucibleDiscoveryError) {
      throw new RetireReservedNameError(
        'reserved_name_unresolved',
        `${found.join(', ')} still name the retired Crucible server "${RETIRED_RESERVED_NAME}", and `
          + `there is no Crucible on this computer for it to become (${err.code}: ${err.message}). `
          + 'Nothing has been changed. Add that machine\'s server in Settings → Crucible Servers '
          + `and re-point the rows, or start its Crucible and launch BookForge again.`,
      );
    }
    throw err;
  }

  const entries = registry.read().servers;
  const url = discovered.url.replace(/\/+$/, '');
  /*
   * THE SAME ADDRESS RULE THE REGISTRY USES, and it must be the same one.
   *
   * This compared `url.replace(/\/+$/, '')` — a trailing slash and nothing else
   * — until 2026-09-15, which is strictly NARROWER than `originKey`. A stored
   * row written `http://LOCALHOST:7100` and a discovered `http://localhost:7100`
   * are one engine and did not match here, so this fell through to the name
   * branch and, when the names differed, WROTE A SECOND ROW FOR THE SAME
   * ADDRESS. The bench then draws two GPU lanes over one card and the queue
   * schedules onto both.
   *
   * And nothing downstream would have caught it: this path writes with
   * `registry.write(...)` rather than `add()`, so it never meets the duplicate
   * refusal that door now makes. A startup path, writing silently, reachable by
   * nothing worse than a cosmetic difference in how a URL was typed.
   *
   * Flagged by the Foundry session, which hit the mirror image of this in its own
   * `adoptPairingFile`: a pre-check narrower than the writer's rule turned an
   * "already registered, nothing to do" into a thrown error on every launch.
   * Theirs failed loudly and ours failed silently, from the same cause — a
   * second copy of a rule that has an owner. Calling `originKey` is what keeps
   * the two one rule rather than two that agree today.
   */
  const already = entries.find((entry) => originKey(entry.url) === originKey(url));

  let becameName: string;
  let registered = false;
  if (already !== undefined) {
    becameName = already.name;
  } else {
    try {
      becameName = validateServerName(discovered.name);
    } catch (err) {
      if (err instanceof CrucibleRegistryError) {
        throw new RetireReservedNameError(
          'reserved_name_unusable',
          `${found.join(', ')} still name the retired Crucible server "${RETIRED_RESERVED_NAME}", `
            + `and the Crucible on this computer calls itself "${discovered.name}", which is not a `
            + `usable server name (${err.code}: ${err.message}). Nothing has been changed. Add it `
            + 'by hand in Settings → Crucible Servers under a name you choose.',
        );
      }
      throw err;
    }
    const key = serverNameKey(becameName);
    const clash = entries.find((entry) => serverNameKey(entry.name) === key);
    if (clash !== undefined) {
      throw new RetireReservedNameError(
        'reserved_name_taken',
        `${found.join(', ')} still name the retired Crucible server "${RETIRED_RESERVED_NAME}". It `
          + `is the Crucible at ${url}, which calls itself "${discovered.name}" — and a DIFFERENT `
          + `server (${clash.url}) is already registered under that name. Nothing has been `
          + 'changed. Rename or remove that entry, or add this one by hand under a name you choose.',
      );
    }
    registry.write({
      servers: [
        ...entries,
        {
          name: becameName,
          url,
          token: discovered.token,
          added: new Date().toISOString(),
        } satisfies CrucibleServerEntry,
      ],
    });
    registered = true;
  }

  // ── AND EVERY RECORD THAT POINTED AT IT ─────────────────────────────────
  const rewrote: string[] = [];
  if (routingNamesIt(routing)) {
    const record = routing as Record<string, unknown>;
    record['order'] = rename(record['order'] as string[], becameName);
    record['disabled'] = rename(record['disabled'] as string[], becameName);
    writeJson(path.join(host.userData, ROUTING_FILE), record);
    rewrote.push(`${ROUTING_FILE}: rank and enable switch`);
  }
  if (upstreamsNameIt(upstreams)) {
    const record = upstreams as { upstreams: Record<string, unknown> };
    const table = record.upstreams;
    const value = table[RETIRED_RESERVED_NAME];
    delete table[RETIRED_RESERVED_NAME];
    /*
     * A value already under the new name WINS. It was learned from that
     * address under the name it is registered with; the one filed under the
     * retired name is the same fact, learned earlier, about the same machine.
     * Keeping the newer one is not a merge — the two cannot disagree about
     * anything but when they were read.
     */
    if (!(becameName in table)) table[becameName] = value;
    writeJson(path.join(host.userData, UPSTREAMS_FILE), record);
    rewrote.push(`${UPSTREAMS_FILE}: whether that engine has an upstream`);
  }
  if (queueNamesIt(queue)) {
    const record = queue as { jobs?: unknown };
    const jobs = Array.isArray(record.jobs) ? record.jobs : [];
    let rows = 0;
    let steps = 0;
    for (const entry of jobs) {
      const job = entry as Record<string, unknown>;
      if (job['waitFor'] === RETIRED_RESERVED_NAME) { job['waitFor'] = becameName; rows += 1; }
      if (job['waitForResolved'] === RETIRED_RESERVED_NAME) {
        job['waitForResolved'] = becameName;
        rows += 1;
      }
      const jobSteps = Array.isArray(job['steps']) ? job['steps'] as unknown[] : [];
      for (const each of jobSteps) {
        const step = each as Record<string, unknown>;
        if (step['venue'] === RETIRED_RESERVED_NAME) { step['venue'] = becameName; steps += 1; }
      }
    }
    writeJson(path.join(host.userData, QUEUE_FILE), record);
    rewrote.push(`${QUEUE_FILE}: ${rows} queue field(s) and ${steps} step venue(s)`);
  }

  return { found, becameName, registered, rewrote };
}

/** One line for the log. Names only — never a URL, never a token. */
export function describeRetirement(report: RetireReservedNameReport): string {
  if (report.found.length === 0) {
    return '[CRUCIBLE] no record on this machine names the retired server "local"; nothing to do.';
  }
  return `[CRUCIBLE] the retired server name "${RETIRED_RESERVED_NAME}" was named by `
    + `${report.found.join(', ')} and is now the registry entry "${report.becameName}"`
    + `${report.registered ? ' (added)' : ' (already registered)'}. Rewrote: `
    + `${report.rewrote.join('; ')}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four records, read and written the way their owners do
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A record, or `null` when it is not there.
 *
 * A file that exists and does not parse is REFUSED rather than skipped: its
 * owner refuses it too (`corrupt_routing`, `crucible_upstreams_record_corrupt`),
 * and a migration that quietly stepped over a record it could not read could
 * leave the one reference it was built to remove.
 */
function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new RetireReservedNameError(
      'reserved_name_record_unreadable',
      `${file} could not be read (${(err as Error).message}), so it cannot be checked for the `
        + 'retired server name. Nothing has been changed.',
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new RetireReservedNameError(
      'reserved_name_record_unreadable',
      `${file} is not valid JSON (${(err as Error).message}), so it cannot be checked for the `
        + 'retired server name. Nothing has been changed — repair or delete the file by hand.',
    );
  }
}

/** Temp-and-rename, the rule every record under `<userData>` here is written by. */
function writeJson(file: string, value: unknown): void {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
  fs.renameSync(temp, file);
}

function routingNamesIt(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return false;
  const table = record as Record<string, unknown>;
  return (['order', 'disabled'] as const).some((key) => {
    const value = table[key];
    return Array.isArray(value) && value.includes(RETIRED_RESERVED_NAME);
  });
}

function upstreamsNameIt(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return false;
  const table = (record as { upstreams?: unknown }).upstreams;
  if (table === null || table === undefined || typeof table !== 'object') return false;
  return RETIRED_RESERVED_NAME in (table as Record<string, unknown>);
}

function queueNamesIt(record: unknown): boolean {
  if (record === null || typeof record !== 'object') return false;
  const jobs = (record as { jobs?: unknown }).jobs;
  if (!Array.isArray(jobs)) return false;
  return jobs.some((entry) => {
    const job = entry as Record<string, unknown>;
    if (job['waitFor'] === RETIRED_RESERVED_NAME) return true;
    if (job['waitForResolved'] === RETIRED_RESERVED_NAME) return true;
    const steps = Array.isArray(job['steps']) ? job['steps'] as unknown[] : [];
    return steps.some((each) => (each as Record<string, unknown>)['venue'] === RETIRED_RESERVED_NAME);
  });
}

function rename(list: unknown, becameName: string): string[] {
  if (!Array.isArray(list)) return [];
  return list.map((name) => (name === RETIRED_RESERVED_NAME ? becameName : String(name)));
}
