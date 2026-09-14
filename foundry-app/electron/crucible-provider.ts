/**
 * crucible-provider — the one question everything in packages D and E asks about
 * a Crucible, and the registry read that now answers it.
 *
 * ── WHAT ASKS, AND WHY THE ANSWER IS THREE-VALUED ───────────────────────────
 *
 * Three things need to know whether a Crucible is serving a class of model:
 *
 *   1. the tiles (act-gates.ts) — a LOCAL Crucible serving `translate` lights
 *      Translate even where ollama holds nothing at all, because the models are
 *      over there;
 *   2. the inventory row (machine-models.ts) — SLOTS.md §5b's "Models on this
 *      machine" lists a local Crucible's residency beside ollama's store;
 *   3. the deletion rule (machine-models.ts, `pageReaderRemovalOffer`) — Foundry
 *      deletes the dots GGUF it downloaded ONLY when a LOCAL Crucible has taken
 *      over the `pages` class, and never merely because a server was configured.
 *
 * The third is why `unknown` exists and is not `no`. "No local Crucible serves
 * pages" authorises deleting four gigabytes of weights; "I cannot tell yet" must
 * not, and the two states are genuinely different — a Mac Studio that is asleep,
 * a WSL guest that has not been started since the last reboot, and a machine
 * with no Crucible at all would otherwise all answer the same word. Every caller
 * treats `unknown` exactly as it treats `no` EXCEPT that no deletion follows it.
 *
 * ── PACKAGE C'S REGISTRY IS THE SOURCE, AND THERE IS NO SECOND ONE ──────────
 *
 * `AppSettings.crucibleServers` (crucible-registry.ts) holds the servers; the
 * capability read is `readCapability` (crucible-dispatch.ts), the same route and
 * the same error mapping the placement path uses. Nothing here keeps a list of
 * its own: two registries would be two answers to "which servers exist", and the
 * queue would eventually pick the wrong one.
 *
 * ── WHY THERE IS A CACHE, AND WHY THE READ IS SYNCHRONOUS ───────────────────
 *
 * `localCrucibleServes` is called from `textGate`, `readGate` and
 * `pageReaderRemovalOffer`, all of which are synchronous and two of which run on
 * every menu open. An `await` in any of them would mean a dock that cannot draw
 * its tiles until a server on another machine has answered — so the fact is
 * MEASURED ASYNCHRONOUSLY and READ SYNCHRONOUSLY, out of a small cache with a
 * clock on it:
 *
 *   * `refreshCrucibleFacts()` does the probing. `actGates()` and
 *     `machineModels()` await it before they compose an answer, which is what
 *     makes the two screens that show these facts show fresh ones.
 *   * A synchronous read of a cache that has never been filled answers
 *     `unknown`, which is the honest word for it and is safe everywhere.
 *   * `forgetCrucibleFacts()` is called from `crucible:save`. Adding, enabling
 *     or removing a server changes every answer here, and a fifteen-second stale
 *     window after a deliberate press is the one case a person would read as the
 *     app ignoring them.
 *
 * The window is short because these facts move: a server is switched off, a
 * `crucible install` finishes, somebody's laptop lid closes. It is not zero
 * because a menu that opened four HTTP requests every time it was drawn would be
 * a menu with a network hop in its animation.
 *
 * ── EVERY PROBE HAS A CLOCK ON IT ───────────────────────────────────────────
 *
 * `PROBE_TIMEOUT_MS` is passed into the capability read, and a cut-off answers
 * `unknown` rather than `no`. A remote Crucible that is asleep is the ordinary
 * case on a home network, and the difference between "it said it cannot" and "it
 * did not say" is the difference between darking a tile and leaving it alone.
 */
import type { CrucibleServerEntry } from './app-settings';
import { crucibleServers } from './crucible-registry';
import { readCapability, type CapabilityRecord } from './crucible-dispatch';
import { isLoopbackUrl } from '../shared/slots';
import type { MachineModelItem, ModelClass } from '../shared/types';

/**
 * Three values, because two would be a lie. `unknown` is the honest state of a
 * machine whose servers have not answered yet, and it is not `no`.
 */
export type ServedAnswer = 'yes' | 'no' | 'unknown';

/**
 * How long a server has to answer the capability read before this call gives up
 * and reports `unknown`.
 *
 * Three seconds, which is generous for a loopback socket and short enough that
 * four unreachable servers cannot hold the gate read for longer than a person
 * notices. It is deliberately NOT the dispatcher's timeout (there is none there,
 * on purpose — see `crucibleRequest`): a placement is a press being answered and
 * may wait; a tooltip may not.
 */
const PROBE_TIMEOUT_MS = 3_000;

/** How long a measured answer is believed. See the module note. */
const CACHE_MS = 15_000;

/** What one server answered, or why it could not. */
interface ServerFacts {
  name: string;
  url: string;
  loopback: boolean;
  /** Null when the server did not answer at all — unreachable, refused, undecided. */
  record: CapabilityRecord | null;
}

interface Snapshot {
  at: number;
  servers: ServerFacts[];
}

/** Null until something has probed. A null snapshot is `unknown` everywhere. */
let snapshot: Snapshot | null = null;

/** The probe in flight, so two callers awaiting at once make one round of requests. */
let inFlight: Promise<void> | null = null;

/**
 * MEASURE EVERY ENABLED SERVER, once, and remember it briefly.
 *
 * Awaited by the two composers that show these facts (`actGates`,
 * `machineModels`) and by nothing else — everything that only READS goes through
 * the synchronous accessors below.
 *
 * NOTHING HERE REJECTS. A failure to reach a server is a fact about that server
 * and is recorded as `record: null`; letting it throw would mean a gate read
 * that fails because a Mac is asleep, which is the failure this whole file is
 * arranged to avoid.
 */
export function refreshCrucibleFacts(): Promise<void> {
  if (snapshot !== null && Date.now() - snapshot.at < CACHE_MS) return Promise.resolve();
  if (inFlight !== null) return inFlight;
  inFlight = probeAll().finally(() => { inFlight = null; });
  return inFlight;
}

async function probeAll(): Promise<void> {
  const enabled = crucibleServers().filter((entry) => entry.enabled);
  const servers = await Promise.all(enabled.map(probeOne));
  snapshot = { at: Date.now(), servers };
}

async function probeOne(entry: CrucibleServerEntry): Promise<ServerFacts> {
  const base: Omit<ServerFacts, 'record'> = {
    name: entry.name,
    url: entry.url,
    loopback: isLoopbackUrl(entry.url),
  };
  try {
    return { ...base, record: await readCapability(entry, PROBE_TIMEOUT_MS) };
  } catch (err) {
    /*
     * LOGGED AT DEBUG VOLUME AND NOT RE-THROWN. A server being unreachable is
     * ordinary; a console line per gate read would be a console full of it. The
     * message is kept out of the line entirely because a refusal from an
     * authenticated route can echo request details, and nothing about a token is
     * ever worth a log line.
     */
    void err;
    return { ...base, record: null };
  }
}

/** Forget everything measured. Called from `crucible:save`; see the module note. */
export function forgetCrucibleFacts(): void {
  snapshot = null;
}

/**
 * Does this record say the class is served — SLOTS.md §5b's *"its capability
 * record lists the class as served"*?
 *
 * BOTH HALVES ARE REQUIRED, and they are the same two the dispatcher checks
 * before it will place a job (`placeOnCrucible`): the row is `enabled`, and it
 * names a `selected` model. A row that is enabled with an empty selection is a
 * server that has decided it can do the work and then found nothing that fits —
 * which is the case that must read as `no`, because treating it as a yes would
 * delete this machine's reader in favour of a server that cannot read a page.
 */
function serves(record: CapabilityRecord, cls: ModelClass): boolean {
  const row = record.classes.find((entry) => entry.capability === cls);
  return row !== undefined && row.enabled && row.selected.length > 0;
}

/**
 * Is a Crucible ON THIS MACHINE serving this class right now?
 *
 * LOCAL, and the distinction is Owen's (SLOTS.md §5b): *"a REMOTE Crucible
 * removes nothing. It takes nothing from this disk, and configured is not
 * present — the local reader is what works when the Mac is asleep."* A remote
 * server is a slot, not an owner of anything on this disk, so it can light a
 * tile but can never authorise a deletion — which is why callers that delete ask
 * THIS function and not "is any server configured".
 *
 * ── THE THREE ANSWERS, EXACTLY ──────────────────────────────────────────────
 *
 *   `yes`     — an enabled loopback entry answered, and its row for this class
 *               is enabled with a model selected.
 *   `no`      — an enabled loopback entry answered, and the row is disabled, has
 *               no selection, or is not in the record at all. The server has
 *               said what it cannot do, which is an answer.
 *   `unknown` — there is no local entry, or nothing has probed yet, or the local
 *               server did not answer. Never a permission to delete.
 *
 * MORE THAN ONE LOOPBACK ENTRY is possible (two ports, two guests) and any one
 * of them saying yes is a yes: the class IS being served on this machine, which
 * is the whole of what the question asks. A `no` is only returned when every
 * local entry that answered said no — one silent server among them keeps the
 * answer at `unknown`.
 */
export function localCrucibleServes(cls: ModelClass): ServedAnswer {
  if (snapshot === null) return 'unknown';
  const local = snapshot.servers.filter((server) => server.loopback);
  if (local.length === 0) return 'unknown';
  let silent = false;
  for (const server of local) {
    if (server.record === null) { silent = true; continue; }
    if (serves(server.record, cls)) return 'yes';
  }
  return silent ? 'unknown' : 'no';
}

/**
 * The name of a REMOTE Crucible serving this class, or null.
 *
 * For the one sentence §5b asks the Models card to show: *"page reading will
 * then need <server> to be reachable"*. It names a server rather than answering
 * a boolean because that sentence has a hole in it that only a name fills, and
 * because a person deciding whether to free four gigabytes needs to know WHICH
 * machine they are then depending on.
 *
 * The FIRST such server in rank order, which is the one an `any` walk would
 * reach first and therefore the one the offer is about.
 */
export function remoteCrucibleServing(cls: ModelClass): string | null {
  for (const server of snapshot?.servers ?? []) {
    if (server.loopback) continue;
    if (server.record !== null && serves(server.record, cls)) return server.name;
  }
  return null;
}

/**
 * WHAT A CRUCIBLE ON THIS MACHINE HAS TAKEN OVER — the server's name and every
 * class it is serving, or null when none has taken over anything.
 *
 * For the Ollama step of the wizard and the Language model card, which must not
 * pull a model for a class this machine already serves (SLOTS.md §5b: *"the app
 * never pulls into [Ollama] while a local Crucible serves the class"*). They say
 * so in the row rather than hiding it, so they need the NAME as well as the fact.
 *
 * THE FIRST LOOPBACK SERVER THAT SERVES ANYTHING, and its classes. Two local
 * Crucibles is a state the registry allows and nobody has; naming the first is
 * better than composing a sentence about a configuration that does not exist.
 */
export function localCrucibleTakeover(): { server: string; classes: ModelClass[] } | null {
  for (const server of snapshot?.servers ?? []) {
    if (!server.loopback || server.record === null) continue;
    const classes = server.record.classes
      .filter((row) => row.enabled && row.selected.length > 0)
      .map((row) => row.capability as ModelClass);
    if (classes.length > 0) return { server: server.name, classes };
  }
  return null;
}

/**
 * The Crucible line on "Models on this machine", or null when there is nothing
 * to say about one.
 *
 * A LINE PER SERVER, not a residency list of model files, and the distinction is
 * deliberate: this app cannot see a Crucible's weights on disk. It can see what
 * the server SAYS it serves and which model it selected for each class, which is
 * the useful half — a person looking at this row is asking "is the 27B on this
 * machine twice", and "the Crucible here serves translate with qwen3.8-27b-4bit"
 * answers it without inventing a byte count nobody measured.
 *
 * Sizes are therefore NULL throughout, and `MachineStore.bytes` stays null so
 * the card's total says "size partly unknown" rather than adding a zero in.
 */
export function localCrucibleSummary(): { detail: string; items: MachineModelItem[] } | null {
  const local = (snapshot?.servers ?? []).filter((server) => server.loopback);
  if (snapshot === null) return null;
  if (local.length === 0) return null;

  const items: MachineModelItem[] = [];
  const silent: string[] = [];
  for (const server of local) {
    if (server.record === null) { silent.push(server.name); continue; }
    for (const row of server.record.classes) {
      if (!row.enabled || row.selected.length === 0) continue;
      items.push({
        name: row.selected,
        detail: `"${server.name}" serves ${row.capability} with this. Its weights are Crucible's, in `
          + 'Crucible\'s own store — Foundry neither downloaded them nor can remove them.',
        bytes: null,
      });
    }
  }

  const named = local.map((server) => `"${server.name}"`).join(', ');
  if (items.length === 0) {
    return {
      detail: silent.length === local.length
        ? `${named} is registered on this machine and did not answer, so what it holds is not known `
          + 'here. Nothing has been removed on the strength of it.'
        : `${named} is registered on this machine and is serving no class, so Foundry's own models `
          + 'are still what this computer runs.',
      items: [],
    };
  }
  return {
    detail: `${named} is a Crucible on this machine. The models below are ITS copies — a class it `
      + 'serves is a class Foundry does not pull into Ollama, and the page reader it serves is one '
      + 'Foundry removes its own copy of (docs/SLOTS.md §5b).'
      + (silent.length === 0 ? '' : ` ${silent.map((name) => `"${name}"`).join(', ')} did not answer.`),
    items,
  };
}
