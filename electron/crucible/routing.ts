/**
 * Which Crucible servers the queue may use, and in what order.
 *
 * ── What this owns, and what it deliberately does not ───────────────────────
 *
 * `servers.ts` owns WHICH servers exist — the registry, and since Owen's ruling
 * of 2026-09-15 that is ALL of them, the one on this machine included. It says
 * nothing about *preference*, and preference is a second fact with a second
 * owner: crucible
 * `docs/PHASE7-LANES.md` section 4.2.2 gives the operator a single list, dragged
 * to order, with an enable switch per row, plus one setting for what a new queue
 * row defaults to. That is what this file persists, and it is the ONLY owner of
 * it (crucible `docs/ARCHITECTURE.md`, R1) — the registry file is not touched,
 * so re-ranking never rewrites a token and removing a server never loses a rank
 * it might get back.
 *
 *   <userData>/crucible-routing.json
 *   { "order": ["3090 Ti", "mac"], "disabled": ["mac"], "newJobsWaitFor": "top-ranked" }
 *
 * A record written before 2026-09-15 also carries `legacyLocalRender`. The layer
 * that key reached — the WSL narrator, the local text engines, the local VLM,
 * RVC and denoise spawns — IS DELETED (docs/LEGACY-REMOVAL.md), so the key is
 * STRIPPED on read and said once, by name, on the log. It is not corrupt (it was
 * valid when it was written) and nothing rewrites the file behind the operator's
 * back; the next render simply fails honestly with `no_enabled_server`, which is
 * an answer a person can act on, instead of quietly taking this machine's card.
 *
 * Written temp-and-rename like `servers.ts`, for the same reason: a half-written
 * record is the one shape that loses every preference at once.
 *
 * ── The rules, each of which is a rule from the contract ────────────────────
 *
 * **Rank is the list's order. There is no rank number** (§4.2.2: "the list's
 * order IS the rank"), so nothing here stores one and nothing renumbers.
 *
 * **EVERY server is one row, and there is no other kind.** Until 2026-09-15 the
 * server on this machine was passed into the known set under the reserved name
 * `local`, which was not a registry entry at all. Owen's ruling deleted that:
 * the known set is simply the registry, so a machine on `127.0.0.1` is ranked,
 * enabled, disabled and forgotten by exactly the code a Mac across the tailnet
 * is.
 *
 * **A newly added server lands at the BOTTOM** (§4.2.2: "adding a machine must
 * never silently demote the one every existing row defaults to"). That is not a
 * special case here: a known server the order does not name yet is ranked after
 * every server it does, which IS the rule.
 *
 * **An order that names a server the registry no longer has is REPORTED, with
 * the name — never silently pruned.** Pruning would be a fallback: it turns
 * "this record mentions a machine you removed" into silence, and the operator
 * loses both the rank (if the server comes back) and the reason their list looks
 * different. {@link RoutingView.unknown} carries the names; `forget` is the door
 * that removes one, and it refuses a name that IS known.
 *
 * ── No fallbacks ────────────────────────────────────────────────────────────
 *
 * Every refusal is a {@link CrucibleRoutingError} whose `code` names it. A
 * corrupt record is refused, never replaced. "No enabled server" is a refusal
 * from {@link Routing.ranked}'s consumers rather than an empty answer: a queue
 * that is handed nothing cannot tell "you disabled them all" from "the call
 * failed", and 2.5's rows have to say which.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { listServers } from './servers';
import { announceCrucibleRecordChanged } from './routes';
// The wire shapes, owned once in shared/ because the settings row reads them
// too (see that file's header). This module owns the RECORD; the view it hands
// back is the wire's.
import type {
  RankedServerRow as RankedServer,
  RoutingView,
  WaitForDefault,
} from '../../shared/crucible/settings-wire';

export type { RankedServer, RoutingView, WaitForDefault };

/** The record on disk. */
export interface RoutingRecord {
  /** Server names, best first. Names not in the known set are kept and reported. */
  order: string[];
  /** Server names the queue may not use. Standing state about hardware (§4.2.2). */
  disabled: string[];
  /** What a new queue row's `waitFor` is written as (§4.2.1a). */
  newJobsWaitFor: WaitForDefault;
}

export type CrucibleRoutingErrorCode =
  /** The record exists and is not the record. Refused, never replaced. */
  | 'corrupt_routing'
  /** A name that is not one of this machine's servers. */
  | 'unknown_server'
  /** A new order that does not name every known server — a drag cannot drop one. */
  | 'incomplete_order'
  /** The same server twice in one order. */
  | 'duplicate_in_order'
  /** Anything but `top-ranked` or `any`. */
  | 'invalid_wait_for'
  /** `forget` was asked to drop a name that IS a server. */
  | 'server_is_known'
  /** Every server is disabled, or there are none. */
  | 'no_enabled_server';

export class CrucibleRoutingError extends Error {
  readonly code: CrucibleRoutingErrorCode;

  constructor(code: CrucibleRoutingErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleRoutingError';
    this.code = code;
  }
}

/*
 * WHAT A NEW ROW WAITS FOR WHEN NOBODY HAS SAID — `any`, since Owen's ruling of
 * 2026-09-19: *"the default should be 'any' for the queue items. if i want
 * everything to go through one, ill disable one of the servers with the
 * checkbox"*.
 *
 * It used to be `top-ranked`, and the two are not near-misses of each other.
 * `top-ranked` writes A MACHINE'S NAME onto every book, which is an
 * INSTRUCTION — `decideWaitFor` holds a named server rather than sending the
 * book elsewhere — so a queue full of rows nobody routed by hand was a queue
 * pinned to one card by a default. `any` is the absence of an instruction, and
 * it is the setting in which the enable switches mean what they look like they
 * mean: the book goes to the first ENABLED server that answers, so switching one
 * off routes the queue rather than leaving it stuck on a name.
 *
 * This is the record's default, not a migration. A record already on disk keeps
 * what it says (it carries this key explicitly), for the reason nothing else
 * here rewrites one: the file is the operator's. The radio in Settings →
 * Crucible Servers is the one click that moves an existing record over.
 */
const DEFAULT_WAIT_FOR: WaitForDefault = 'any';

/**
 * THE RETIRED SWITCH: stripped on read, said ONCE, never honoured.
 *
 * `legacyLocalRender` used to mean "run GPU work with the local engines instead"
 * — the WSL narrator, the local text engines, the local VLM/RVC/denoise spawns.
 * That whole layer is deleted (docs/LEGACY-REMOVAL.md), so there is nothing for
 * the key to turn on.
 *
 * Three things it deliberately is NOT:
 *
 *  - **not corrupt.** The key was valid when it was written, and refusing the
 *    record would brick the app's startup over a setting that no longer has a
 *    meaning. Every other preference in the file is still good.
 *  - **not migrated.** Nothing rewrites the file: the operator's record is
 *    theirs, and a silent rewrite is how a person loses the evidence of what
 *    they had asked for. The key simply stops being read; the next write of any
 *    OTHER preference drops it, because {@link RoutingRecord} no longer has it.
 *  - **not silent.** A machine that was rendering locally yesterday will now
 *    refuse `no_enabled_server`, and the operator is owed the sentence that
 *    connects the two. Said once per record, on the log, by name.
 */
const saidLegacySwitchRetired = new Set<string>();

function noteRetiredLegacySwitch(file: string, value: unknown): void {
  if (value === undefined) return;
  if (saidLegacySwitchRetired.has(file)) return;
  saidLegacySwitchRetired.add(file);
  console.log(
    `[CRUCIBLE-ROUTING] ${file} carries "legacyLocalRender": ${JSON.stringify(value)}. That switch `
      + 'is RETIRED and is ignored: the local spawn layer it turned on — the WSL narrator, the '
      + 'local text engines, the local VLM/RVC/denoise spawns — has been deleted '
      + '(docs/LEGACY-REMOVAL.md). Every act now runs on a Crucible server or refuses by name. '
      + 'The key is left in the file untouched; nothing here rewrites your record.',
  );
}

/** `<userData>/crucible-routing.json`. Resolved at CALL time, like the registry. */
export function routingPath(): string {
  return path.join(app.getPath('userData'), 'crucible-routing.json');
}

function isWaitFor(value: unknown): value is WaitForDefault {
  return value === 'top-ranked' || value === 'any';
}

/**
 * The routing record over one file.
 *
 * Every method takes `known` — the servers that exist right now, in the order
 * the registry holds them. This class never asks the registry itself, so a
 * keeper drives it with a scripted server set and the module-level doors below
 * bind it to the real one.
 */
export class Routing {
  constructor(private readonly file: string) {}

  /**
   * The record as it is on disk.
   *
   * A missing file is the DEFAULT record — no preference has been expressed yet,
   * which is a real state and not a fallback. A file that exists and does not
   * parse, or whose fields are the wrong shape, is refused: it is a record of
   * choices the operator made, and starting over silently would rewrite them.
   */
  read(): RoutingRecord {
    const file = this.file;
    if (!fs.existsSync(file)) {
      return { order: [], disabled: [], newJobsWaitFor: DEFAULT_WAIT_FOR };
    }

    let parsed: unknown;
    const raw = fs.readFileSync(file, 'utf-8');
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CrucibleRoutingError(
        'corrupt_routing',
        `${file} is not valid JSON (${(err as Error).message}). It records which servers the queue `
          + 'may use and in what order, so nothing here will replace it — repair or delete the file '
          + 'by hand.',
      );
    }
    const record = parsed as Partial<RoutingRecord> | null;
    for (const key of ['order', 'disabled'] as const) {
      const value = record?.[key];
      if (!Array.isArray(value) || value.some((name) => typeof name !== 'string' || name === '')) {
        throw new CrucibleRoutingError(
          'corrupt_routing',
          `${file}: "${key}" must be an array of server names. Repair or delete the file by hand.`,
        );
      }
    }
    if (!isWaitFor(record?.newJobsWaitFor)) {
      throw new CrucibleRoutingError(
        'corrupt_routing',
        `${file}: "newJobsWaitFor" must be "top-ranked" or "any", not `
          + `${JSON.stringify(record?.newJobsWaitFor)}. Repair or delete the file by hand.`,
      );
    }
    noteRetiredLegacySwitch(file, (record as Record<string, unknown>)['legacyLocalRender']);
    return {
      order: [...(record.order as string[])],
      disabled: [...(record.disabled as string[])],
      newJobsWaitFor: record.newJobsWaitFor,
    };
  }

  private write(record: RoutingRecord): void {
    const file = this.file;
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, file);
  }

  /**
   * The record resolved against the servers that exist.
   *
   * Ranked servers come first in the order the record gives; every other known
   * server follows in the order the caller listed them, which is the
   * "newly added lands at the bottom" rule and not a separate mechanism.
   */
  view(known: readonly string[]): RoutingView {
    const record = this.read();
    const knownSet = new Set(known);
    const ranked: RankedServer[] = [];
    const seen = new Set<string>();
    const disabled = new Set(record.disabled);

    for (const name of record.order) {
      if (!knownSet.has(name) || seen.has(name)) continue;
      seen.add(name);
      ranked.push({ name, enabled: !disabled.has(name) });
    }
    for (const name of known) {
      if (seen.has(name)) continue;
      seen.add(name);
      ranked.push({ name, enabled: !disabled.has(name) });
    }

    const mentioned = new Set([...record.order, ...record.disabled]);
    const unknown = [...mentioned].filter((name) => !knownSet.has(name));
    return { ranked, newJobsWaitFor: record.newJobsWaitFor, unknown };
  }

  /**
   * Re-rank. `next` is the whole visible list, best first — a drag reorders a
   * list, it does not add or drop a row, so an order that omits a known server
   * or names an unknown one is a bug in the caller and is refused as one.
   *
   * Names the record already holds for servers that are NOT known are kept, at
   * the end: they are somebody's removed machine, reported by {@link view}, and
   * dropping them here would be the silent prune this module exists to avoid.
   */
  setOrder(next: readonly string[], known: readonly string[]): RoutingView {
    const seen = new Set<string>();
    for (const name of next) {
      if (seen.has(name)) {
        throw new CrucibleRoutingError(
          'duplicate_in_order',
          `"${name}" appears twice in the new order. One server has one rank.`,
        );
      }
      seen.add(name);
      if (!known.includes(name)) {
        throw new CrucibleRoutingError(
          'unknown_server',
          `"${name}" is not one of this machine's Crucible servers `
            + `(${known.length === 0 ? 'there are none' : `known: ${known.join(', ')}`}).`,
        );
      }
    }
    const missing = known.filter((name) => !seen.has(name));
    if (missing.length > 0) {
      throw new CrucibleRoutingError(
        'incomplete_order',
        `the new order does not name ${missing.join(', ')}. A re-rank carries the whole list — a `
          + 'server left out of it would lose its rank without anyone saying so.',
      );
    }
    const record = this.read();
    const kept = record.order.filter((name) => !known.includes(name) && !seen.has(name));
    this.write({ ...record, order: [...next, ...kept] });
    return this.view(known);
  }

  /** Turn one server on or off for the whole queue (§4.2.2's capacity switch). */
  setEnabled(name: string, enabled: boolean, known: readonly string[]): RoutingView {
    if (!known.includes(name)) {
      throw new CrucibleRoutingError(
        'unknown_server',
        `"${name}" is not one of this machine's Crucible servers `
          + `(${known.length === 0 ? 'there are none' : `known: ${known.join(', ')}`}).`,
      );
    }
    const record = this.read();
    const disabled = record.disabled.filter((entry) => entry !== name);
    if (!enabled) disabled.push(name);
    this.write({ ...record, disabled });
    return this.view(known);
  }

  /** What a NEW queue row's `waitFor` is written as (§4.2.1a). */
  setNewJobsWaitFor(value: WaitForDefault, known: readonly string[]): RoutingView {
    if (!isWaitFor(value)) {
      throw new CrucibleRoutingError(
        'invalid_wait_for',
        `"${String(value)}" is not something a new job can wait for. It is "top-ranked" (the server `
          + 'at the top of the list) or "any" (the first that will take it).',
      );
    }
    this.write({ ...this.read(), newJobsWaitFor: value });
    return this.view(known);
  }

  /**
   * Drop a name the record mentions that no server answers to. The door for
   * {@link RoutingView.unknown}; it refuses a name that IS a server, because
   * forgetting one of those is what the enable switch and the registry are for.
   */
  forget(name: string, known: readonly string[]): RoutingView {
    if (known.includes(name)) {
      throw new CrucibleRoutingError(
        'server_is_known',
        `"${name}" IS one of this machine's Crucible servers. Disable it to keep the queue off it, `
          + 'or remove it from the registry — forgetting its rank while it exists would just put it '
          + 'back at the bottom.',
      );
    }
    const record = this.read();
    this.write({
      ...record,
      order: record.order.filter((entry) => entry !== name),
      disabled: record.disabled.filter((entry) => entry !== name),
    });
    return this.view(known);
  }

  /**
   * The servers the queue may use, best first.
   *
   * Refuses when there is none: an empty list is indistinguishable from a failed
   * call, and a row that cannot start has to say WHY — "all 2 of your servers
   * are disabled" and "you have no servers" are different sentences with
   * different fixes.
   */
  ranked(known: readonly string[]): RankedServer[] {
    const { ranked } = this.view(known);
    const enabled = ranked.filter((row) => row.enabled);
    if (enabled.length === 0) {
      throw new CrucibleRoutingError(
        'no_enabled_server',
        ranked.length === 0
          ? 'no Crucible server is available to the queue: this machine has none, and none is '
            + 'registered. Add one in Settings → Crucible Servers.'
          : `every Crucible server is disabled (${ranked.map((row) => row.name).join(', ')}). `
            + 'Enable one in Settings → Crucible Servers.',
      );
    }
    return enabled;
  }

  /** The top of the list. Refuses by name when nothing is enabled — see {@link ranked}. */
  top(known: readonly string[]): RankedServer {
    return this.ranked(known)[0] as RankedServer;
  }

  /**
   * What to write on a new queue row: the top-ranked server's NAME, or `any`
   * (§4.2.1a — the default is a setting precisely so that it never manufactures
   * an instruction nobody gave).
   *
   * Refuses when nothing is enabled in both modes, deliberately: `any` with no
   * enabled server is a row that can only hold, and the honest moment to say so
   * is when it is queued rather than an hour later.
   */
  waitForNewJob(known: readonly string[]): string {
    const { newJobsWaitFor } = this.view(known);
    const enabled = this.ranked(known);
    return newJobsWaitFor === 'any' ? 'any' : (enabled[0] as RankedServer).name;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The app's routing: <userData>/crucible-routing.json over the real server set
// ─────────────────────────────────────────────────────────────────────────────

function store(): Routing {
  return new Routing(routingPath());
}

/**
 * The servers this machine has, in the order they were added.
 *
 * That is the whole of it: the registry IS the set of servers (Owen's ruling,
 * 2026-09-15). There is no manufactured row for this machine and no second
 * source to merge in — a machine with an empty registry has no servers, which is
 * a true state and the one the Crucible Servers panel is for.
 */
export function knownServers(): string[] {
  return listServers().map((entry) => entry.name);
}

/** The record resolved against {@link knownServers}. */
export function readRouting(): RoutingView {
  return store().view(knownServers());
}

/**
 * Re-rank. See {@link Routing.setOrder}.
 *
 * AND THE BENCH AND THE SCHEDULER ARE TOLD, for {@link setServerEnabled}'s
 * reason. Rank is what `any` means — "the first enabled server, in rank order,
 * that will take it" — so a re-rank nobody announced is a book sent to the
 * machine the operator has just demoted
 * (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A3).
 */
export function setRoutingOrder(next: readonly string[]): RoutingView {
  const view = store().setOrder(next, knownServers());
  announceCrucibleRecordChanged();
  return view;
}

/**
 * Enable or disable one server for the queue. See {@link Routing.setEnabled}.
 *
 * AND THE BENCH IS TOLD. `slotSets` reads this switch — a disabled server is
 * drawn greyed rather than dropped since 2026-09-15 — and nothing else was
 * going to republish for it, so the row kept its old look until some unrelated
 * change caused a publish. `announceCrucibleRecordChanged` is the same door the
 * routing RECORD uses when it learns, for the same reason.
 *
 * Here rather than in the IPC handler, so every caller gets it. Every other
 * write to this record and to the registry does the same since 2026-09-19 —
 * {@link setRoutingOrder}, {@link forgetRoutingName}, `servers.addServer` and
 * `servers.removeServer` — because the memo that used to absorb the difference
 * is gone (see `electron/queue-ipc.ts`).
 */
export function setServerEnabled(name: string, enabled: boolean): RoutingView {
  const view = store().setEnabled(name, enabled, knownServers());
  announceCrucibleRecordChanged();
  return view;
}

/** Set what a new queue row waits for. See {@link Routing.setNewJobsWaitFor}. */
export function setNewJobsWaitFor(value: WaitForDefault): RoutingView {
  return store().setNewJobsWaitFor(value, knownServers());
}

/**
 * Forget a name no server answers to. See {@link Routing.forget}.
 *
 * Announced like every other write to this record: it changes the ranked list
 * the bench draws and the scheduler walks.
 */
export function forgetRoutingName(name: string): RoutingView {
  const view = store().forget(name, knownServers());
  announceCrucibleRecordChanged();
  return view;
}

/**
 * The servers the queue may use, best first. Refuses by name when there is
 * none. Exported for the per-row routing 2.5 builds on top of this.
 */
export function rankedServers(): RankedServer[] {
  return store().ranked(knownServers());
}

/** The top-ranked enabled server. Refuses by name when there is none. */
export function topRankedServer(): RankedServer {
  return store().top(knownServers());
}

/** What a new queue row's `waitFor` is written as: a server name, or `any`. */
export function defaultWaitFor(): string {
  return store().waitForNewJob(knownServers());
}
