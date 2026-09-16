/**
 * THE SERVER REGISTRY, AND THE SLOT LIST DERIVED FROM IT.
 *
 * docs/SLOTS.md §3 and §6 (Package C). This module owns three things and
 * deliberately no more:
 *
 *   1. the registered Crucible servers, read out of and written into the app's
 *      own settings file, in priority order;
 *   2. `computeSlots()` — the list a picker draws and the `any` walk walks;
 *   3. the two acts that TALK to a server for a settings row: Test connection,
 *      and reading the local server's own config so an entry can be made from
 *      it without anybody copying a token by hand.
 *
 * WHAT IS NOT HERE IS THE DISPATCH. Deciding which slot a job goes to, reading
 * a capability record, making a model resident and composing the spawn is
 * `crucible-dispatch.ts` — a different question with a different shape of
 * answer. This module reads and writes; that one acts, and every act of its is
 * on a row somebody is watching.
 *
 * ── The token, and the one rule it has ──────────────────────────────────────
 *
 * It never leaves this process. It is read here, held in the settings file, and
 * handed to the SDK or to a spawn's `env`. It is not on a command line (a
 * command line is spelled into the terminal by `job-queue.ts`, pasted into bug
 * reports, and listed by the process table), it is not in an IPC payload (the
 * renderer's shape is `CrucibleServerView`, which has a boolean where this has a
 * secret), and it is in no log line, including the ones that report a failure
 * involving it.
 *
 * ── Why the word "crucible" is in this filename ─────────────────────────────
 *
 * Because it is allowed to be: the engine (`src/`) must never name a product —
 * it speaks an OpenAI dialect to whatever is on the other end and cannot tell
 * one server from another — but the APP is the operator, and an operator that
 * loads a model, reads a capability record and renders a 409 by its code is
 * talking to a Crucible specifically. Pretending otherwise here would mean a
 * module full of sentences about "the server" that only one server can answer.
 */
import { spawn } from 'node:child_process';

import {
  CrucibleAuthError,
  CrucibleClient,
  CrucibleNotACrucible,
  CrucibleUnreachable,
  CrucibleVersionError,
  engineOf,
  type EngineOwner,
  type EngineRef,
} from '@crucible/client';

import {
  readAppSettings,
  writeAppSettings,
  clampCrucibleUrl,
  sameCrucibleAddress,
  CRUCIBLE_SERVER_MAX,
  type CrucibleServerEntry,
} from './app-settings';
import { cloudProviderViews, enabledCloudProviders } from './cloud-providers';
import { foundryHost, hosted } from './host';
import { pairingFileRead } from './crucible-pairing';
import {
  ANY_SLOT,
  isLoopbackUrl,
  slotNameRefusal,
  tidySlotName,
  type CloudSettingsView,
  type ComputeSlot,
  type SlotAvailability,
  type SlotRefusal,
  type CrucibleProbe,
  type CrucibleServerEdit,
  type CrucibleServerView,
  type CrucibleSettingsView,
  type LocalCrucibleAdd,
} from '../shared/slots';

/**
 * WHAT THE SERVER LOGS AS THE HOLDER OF OUR JOBS — and it must be this word.
 *
 * The SDK puts it in `User-Agent`, and that is what a Crucible reports back to
 * the NEXT client that finds the lane taken: `CrucibleBusy.holder`. So this
 * string is what BookForge's queue will print when Foundry is in the way, and
 * what this app will print when BookForge is. A clientName invented per call
 * site would make one machine look like two apps.
 */
export const CRUCIBLE_CLIENT_NAME = 'foundry';

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/** Every registered server, in priority order. The stored shape, token and all. */
export function crucibleServers(): CrucibleServerEntry[] {
  /*
   * HOSTED, THE REGISTRY IS THE HOST'S — and it is read HERE, at the one
   * function every other reader goes through, rather than at each of them.
   * `computeSlots`, `crucibleServerNamed` and the dispatcher all ask this, so
   * putting the choice anywhere else would be putting it in some of them.
   *
   * IT NEVER FALLS BACK TO THE SETTINGS FILE HOSTED. That file holds an empty
   * list nobody can write to, and reading it would mean a slot drawn from one
   * list and a credential looked up in another — the break `host.ts` describes
   * on `servers?()`. A host with no registry has no servers here, full stop.
   */
  return readRegistry().entries;
}

/** The registry, and the reason it is empty when the reason is not "none". */
interface RegistryRead {
  entries: CrucibleServerEntry[];
  refusal: SlotRefusal | null;
}

/**
 * THE ONE READ. Standalone it is the settings file; hosted it is the host's
 * own registry and never the settings file, which hosted holds an empty list
 * nobody can write to — reading it would mean a slot drawn from one list and a
 * credential looked up in another, which is the break `host.ts` describes.
 *
 * A THROW IS NOT AN EMPTY REGISTRY. A host that implements the seam and fails
 * the call is saying something is wrong NOW, not that it has no servers, and
 * it may answer on the next read: BookForge throws `registry_snapshot_not_taken`
 * before its first snapshot is taken. Returning [] for that would put "you have
 * added no servers" in front of somebody whose servers are all still there.
 */
function readRegistry(): RegistryRead {
  if (!hosted()) return { entries: readAppSettings().crucibleServers, refusal: null };
  const provider = foundryHost()?.servers;
  if (provider === undefined) {
    return {
      entries: [],
      refusal: {
        code: 'host_provides_no_registry',
        /*
         * THE SECOND SENTENCE USED TO BE *"Work will run the way it did before
         * servers could be chosen"*, and Wave 66 made it false: there is no
         * local GPU slot to fall back to, so GPU work in a window like this has
         * nowhere to go and is refused by name rather than quietly run here.
         * Exports and compiles are unaffected — they are CPU work, and Owen's
         * ruling keeps that lane local.
         */
        sentence: 'This window is running inside another application, and that application has '
          + 'not offered a list of GPU engines. Translation, simplification, cleanup, analysis '
          + 'and page reading have nowhere to run; exports and compiles are unaffected.',
      },
    };
  }
  try {
    return { entries: cleanHostServers(provider.call(foundryHost()) ?? []), refusal: null };
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    return {
      entries: [],
      refusal: {
        code: 'host_registry_unavailable',
        sentence: `The application this window runs inside could not say which Crucible servers `
          + `there are (${said}). Its list may not be ready yet; nothing here is lost.`,
      },
    };
  }
}

/**
 * The host's registry, cleaned. Empty is a real answer; so is "there is none".
 *
 * A MISSING OR FAILING SEAM IS NOT REPORTED HERE — `readRegistry` above owns
 * both, as typed state the page draws, because a log line the product's
 * behaviour depends on is a log line doing a type's job.
 *
 * WHAT IS LOGGED HERE IS A HOST'S BUG: a row that is not an entry. Name, address
 * and `enabled` are all required, and a row missing any of them is dropped
 * with a line naming the field. `enabled` is required rather than defaulted
 * because a default here would be this code deciding a fact the host owns —
 * and "switched on" is the dangerous direction to guess in. A token may be
 * empty: a server on a trusted network has none, and the request says so
 * itself if it turns out to want one.
 */
function cleanHostServers(offered: readonly CrucibleServerEntry[]): CrucibleServerEntry[] {
  const seen = new Set<string>();
  const out: CrucibleServerEntry[] = [];
  for (const entry of offered) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    const token = typeof entry.token === 'string' ? entry.token : '';
    if (name.length === 0 || url.length === 0 || typeof entry.enabled !== 'boolean') {
      console.error(
        `[slots] the host offered a server this app cannot read and it was dropped: ${
          name.length === 0 ? 'no name' : url.length === 0 ? `"${name}" has no address`
            : `"${name}" does not say whether it is enabled`}.`,
      );
      continue;
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, url, token, enabled: entry.enabled });
  }
  return out;
}

/** One entry by name, or null. Case-insensitive, because the picker is. */
export function crucibleServerNamed(name: string): CrucibleServerEntry | null {
  const key = name.trim().toLowerCase();
  return crucibleServers().find((entry) => entry.name.toLowerCase() === key) ?? null;
}

/** The registry as the renderer is allowed to see it. */
export function crucibleServerViews(): CrucibleServerView[] {
  /*
   * THE SLOTS ARE DERIVED FIRST, and that is not a wasted call: `slotsFrom` is
   * what decides which entries share a machine, and reading `engineSharedWith`
   * without it would hand back whatever the last derivation happened to say —
   * on a fresh process, nothing at all. It is a pure pass over the registry
   * against a cache, with no network in it.
   */
  computeSlots();
  return crucibleServers().map(viewOf);
}

function viewOf(entry: CrucibleServerEntry): CrucibleServerView {
  return {
    name: entry.name,
    url: entry.url,
    enabled: entry.enabled,
    tokenSet: entry.token.length > 0,
    loopback: isLoopbackUrl(entry.url),
    sharesEngineWith: engineSharedWith(entry.name),
  };
}

/**
 * REPLACE THE WHOLE REGISTRY — add, remove, rename, reorder and enable, all at
 * once, in one door.
 *
 * ── Why one door and not five ───────────────────────────────────────────────
 *
 * Because four of the five are the same operation on an ordered array, and the
 * fifth (reorder) IS the array. A `crucible:reorder` that moved an index while
 * `crucible:rename` changed a name would be two writers of one list, and a drag
 * that landed between them would write one of the two changes. The card holds
 * the list it is editing and sends it whole; the last write wins, which is what
 * a settings card means.
 *
 * ── The token is carried by its ABSENCE ─────────────────────────────────────
 *
 * `token: null` on an incoming entry means "keep what is stored", and it is what
 * the card sends for every row nobody retyped — because the card has never been
 * told the token and so cannot send it back. The match is by NAME against the
 * stored list, which is why a rename and a new token in the same gesture is the
 * one case the card must send a token for: the old name is gone and there is
 * nothing to carry forward from. It is refused by name rather than silently
 * dropping the server.
 */
export function writeCrucibleServers(edits: readonly CrucibleServerEdit[]): CrucibleServerView[] {
  refuseHostedRegistryChange();
  const stored = new Map(crucibleServers().map((entry) => [entry.name.toLowerCase(), entry]));
  /*
   * THE OTHER REGISTRY'S NAMES, read here for the reason `writeCloudProviders`
   * reads this one: two arrays with two clamps cannot see each other, and a slot
   * list with two rows called one thing is a row nobody can choose between. The
   * refusal is by name rather than a silent drop, because somebody who typed a
   * name meant something by it and deserves to be told what already has it.
   */
  const cloud = new Set(
    readAppSettings().cloudProviders.map((entry) => entry.name.toLowerCase()),
  );
  const next: CrucibleServerEntry[] = [];
  for (const edit of edits.slice(0, CRUCIBLE_SERVER_MAX)) {
    const name = tidySlotName(edit.name);
    const url = clampCrucibleUrl(edit.url);
    /*
     * THE NAME RULE HAS ONE OWNER and it is `slotNameRefusal` (shared/slots.ts),
     * which says what is wrong in a sentence this can throw verbatim. It used to
     * be two rules — this writer refused an empty name and nothing else, while
     * `clampCrucibleServers` silently cut at 60 — so a long name got past here
     * and arrived on disk as something the card was no longer showing.
     */
    const wrongName = slotNameRefusal(name, 'server');
    if (wrongName !== null) throw new Error(wrongName);
    if (cloud.has(name.toLowerCase())) {
      throw new Error(
        `"${name}" is already the name of a cloud provider. Two slots with one name is a row `
        + 'nobody can choose between — give this one a different name.',
      );
    }
    if (url === null) {
      throw new Error(
        `"${name}" needs an address like http://192.168.1.20:7100 — the server's base URL, `
        + 'without /v1 on the end.',
      );
    }
    const carried = stored.get(name.toLowerCase());
    const token = typeof edit.token === 'string' && edit.token.trim().length > 0
      ? edit.token.trim()
      : carried?.token ?? '';
    if (token.length === 0) {
      throw new Error(
        `"${name}" needs a token. A Crucible has no anonymous mode — run \`crucible token --show\` `
        + 'on that machine and paste what it prints.',
      );
    }
    next.push({ name, url, token, enabled: edit.enabled !== false });
  }
  /*
   * THE CLAMP IS THE SECOND READER AND THE LAST WORD. Everything above refuses
   * by name so the card can say what to fix; `clampCrucibleServers` (inside
   * `writeAppSettings`) drops what it cannot store — a duplicate name, a
   * reserved one — and the answer is read back OUT of the file rather than
   * returned from this array, on this app's standing rule that a settings door
   * answers with what was stored and never with what was sent.
   */
  writeAppSettings({ crucibleServers: next });
  return crucibleServerViews();
}

/**
 * ADD ONE SERVER, for a caller that is not editing the list.
 *
 * The Servers card sends the whole registry because it holds the whole registry;
 * the setup wizard holds three text boxes and has never seen the list, and
 * making it read one in order to append to it would be a second reader of the
 * order with a window between the read and the write. So this reads, appends and
 * hands the result to {@link writeCrucibleServers} — THE SAME ONE WRITER, with
 * every refusal it makes, rather than a second path into the settings file.
 *
 * AN EXISTING NAME IS REPLACED IN PLACE, keeping its position and its enabled
 * state, which is `addLocalCrucible`'s rule for the same reason: somebody
 * re-adding a server they already have is fixing its token, and a second entry
 * beside the first would leave the stale one in the picker.
 *
 * ── AND A SECOND NAME FOR ONE ADDRESS IS REFUSED, SINCE 2026-09-15 ────────
 *
 * This door compared NAMES and nothing else, so a registry already holding
 * `127.0.0.1:7100` as "3090 Ti" would take a second row for the same address
 * under any other name and hand the queue two GPU lanes over one card.
 * `addLocalCrucible` has always compared addresses, which made it worse than a
 * missing rule: a person who pressed the local button got a safety that a
 * person who pasted a connect code did not, for a reason nobody could infer
 * from either screen. One rule now ({@link sameCrucibleAddress}), consulted by
 * both, which is the shape the slot-name fix took for the same kind of split.
 *
 * REPLACING THE ROW AT THAT ADDRESS IS STILL FINE — that is the token refresh
 * above, and it is why the test excludes the row this call is replacing rather
 * than asking whether the address is present at all.
 *
 * It THROWS, like every other refusal this file makes, because the doors that
 * call it already print what they catch. There is no arm for "added it anyway".
 */
export function addCrucibleServer(name: string, url: string, token: string): CrucibleServerView[] {
  const label = tidySlotName(name);
  const clash = crucibleServers().find(
    (entry) => entry.name.toLowerCase() !== label.toLowerCase()
      && sameCrucibleAddress(entry.url, url),
  );
  if (clash !== undefined) {
    throw new Error(
      `${url} is already registered as "${clash.name}". One engine wants one entry — `
      + 'two would give the queue two GPU slots over the same card. Rename that entry, '
      + 'or remove it if this is meant to replace it.',
    );
  }
  let replaced = false;
  const updated = crucibleServers()
    .map((entry): CrucibleServerEdit => {
      if (entry.name.toLowerCase() === label.toLowerCase()) {
        replaced = true;
        return { name: entry.name, url, enabled: entry.enabled, token };
      }
      return {
      name: entry.name,
      url: entry.url,
      enabled: entry.enabled,
      // Null, so the stored token is carried forward — this function has no
      // business handling the tokens of servers it was not asked about.
      token: null,
      };
    });
  if (!replaced) updated.push({ name: label, url, enabled: true, token });
  return writeCrucibleServers(updated);
}

/**
 * DROP ONE SERVER BY NAME, for a caller that is not editing the list.
 *
 * {@link addCrucibleServer}'s twin and written the same way, for the same
 * reason: read, change, hand the whole thing to the ONE writer, so that every
 * refusal and every clamp still applies and there is no second path into the
 * settings file. A name that is not there is not an error — the answer is the
 * list, which is what the caller wanted to know.
 *
 * THE ONE CALLER TODAY is the uninstall door (electron/crucible-uninstall.ts,
 * crucible `docs/INSTALL-UNINSTALL.md` §6.4): a real uninstall takes
 * `config.toml` with it, so the entry pointing at that engine is an entry
 * holding a token that no longer opens anything. Leaving it would leave a slot
 * in the picker that fails every job placed on it.
 */
export function removeCrucibleServer(name: string): CrucibleServerView[] {
  const key = tidySlotName(name).toLowerCase();
  const kept = crucibleServers()
    .filter((entry) => entry.name.toLowerCase() !== key)
    .map((entry): CrucibleServerEdit => ({
      name: entry.name,
      url: entry.url,
      enabled: entry.enabled,
      // Null, so the stored token is carried forward — see addCrucibleServer.
      token: null,
    }));
  return writeCrucibleServers(kept);
}

/**
 * HOSTED, THE REGISTRY IS SOMEBODY ELSE'S — `library:set`'s refusal, for the
 * same reason (docs/SLOTS.md §3: *"The vendored (BookForge-hosted) app takes its
 * slot list from the host"*).
 *
 * A refusal rather than a hidden card: the card IS hidden hosted, and this is
 * the door behind it. Something that can be reached by an IPC message must
 * refuse at the door as well, or the hiding is a decoration.
 */
function refuseHostedRegistryChange(): void {
  if (!hosted()) return;
  throw new Error(
    'The servers are the host application\'s while Foundry is running inside it. '
    + 'Change them there.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The slots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHERE A JOB'S COMPUTE CAN GO, in priority order.
 *
 * ── THERE IS NO LOCAL SLOT, AND THAT IS THE WHOLE OF WAVE 66's SLOT HALF ───
 *
 * It used to be first, and it used to be what a person with no Crucible saw:
 * this machine's own Ollama, under the name "This computer", removed for exactly
 * one reason — an enabled entry whose URL was loopback. Owen deleted the slot
 * outright: *"everything goes through a crucible server now, including local…
 * there should be no local gpu listed in the queue"*, and *"one gpu slot in the
 * queue per connected crucible server. including the local crucible, which is
 * indistinguishable from the remote crucible server."*
 *
 * So the GPU slots are the enabled Crucible servers, in registry order, and
 * nothing else. A loopback entry is one of them and replaces nothing. A machine
 * with no server registered has NO slot, which is not a broken app and is not a
 * silent fallback either: a GPU job in that state is refused by name, with the
 * one thing a person can do about it (`placeJob`, crucible-dispatch.ts). CPU work
 * — every export, compile and rasterise — is untouched, because the same ruling
 * says so: *"cpu slots are always local. we dont outsource simple cpu work to
 * crucible."*
 *
 * ── AN ORCHESTRATOR WITH NO ENGINE IS NOT A SLOT ───────────────────────────
 *
 * crucible docs/PHASE17-ORCHESTRATOR.md §6: a registered address may be a tray
 * ORCHESTRATOR that manages an engine, and `resolveEngine` follows that hop once.
 * An orchestrator WITH an engine is a perfectly good slot — one machine, one
 * lane, whichever of its two addresses the person registered. An orchestrator
 * with NO engine serves no job type at all, and a lane for it would be a lane the
 * scheduler could fill with work nothing can answer. BookForge's bench draws no
 * row for one; neither does this list.
 *
 * IT IS READ OUT OF THE RESOLVER'S CACHE AND NEVER ASKED FOR HERE
 * ({@link engineAbsence}). This function is called on every pump pass and behind
 * every picker; a network hop in it would put a round trip in front of the board.
 * A cache that has never been filled answers "unknown", and unknown DRAWS THE
 * LANE — a machine nobody has probed yet is not a machine that has answered.
 *
 * ── THE CLOUD SLOTS COME LAST, AND THE ORDER IS THE WHOLE STATEMENT ────────
 *
 * One per ENABLED cloud provider (docs/SLOTS.md §3, Package F), after every
 * Crucible. The position matters because this list is what `any` walks in rank
 * order — and `any` STEPS PAST a cloud slot by kind rather than taking it
 * (`placeJob`, crucible-dispatch.ts), so putting them last means the walk has
 * already tried every machine that costs nothing before it reaches the ones that
 * cost money and declines them. A person who wants one says so on the row.
 *
 * A DUPLICATE NAME IS DROPPED HERE AS THE LAST WORD. Both writers refuse a name
 * the other list already has, so this cannot happen through the cards; a
 * hand-edited settings file can still produce it, and a picker with two rows
 * called one thing is a row nobody can choose between. The CRUCIBLE keeps the
 * name, because it was in the list first when this feature landed and because a
 * dropped cloud slot costs nothing but a slot nobody picked.
 *
 * ── Hosted, this list is the host's whole answer ───────────────────────────
 *
 * Including the emptiness of it. A host that registers no `slots` provider gets
 * an empty list, and an empty list is no longer a window that quietly runs
 * everything here: since Wave 66 there is no local slot to fall back to, so GPU
 * work in such a window is refused by name (`placeJob`, crucible-dispatch.ts) and
 * CPU work goes on exactly as before. `SlotRefusal` is what says which silence
 * this is, and its sentence says which half of the queue is affected. A host that
 * offers no cloud slot therefore has none —
 * this app's own `cloudProviders` are not merged into a host's list, because the
 * work in a hosted window runs on the host's compute and its bill is the host's.
 */
export function slotAvailability(): SlotAvailability {
  /*
   * THE ONE PLACE THAT KNOWS WHY THERE IS NO PICKER. `computeSlots()` below is
   * this function's `.slots` and nothing else, so the two cannot drift: one
   * reads the registry and derives, the other does the same and throws the
   * reason away. Both exist because most callers — the lanes, the stored-name
   * check, the cards — want the list and behave identically either way, while
   * the two that speak to a person, the picker and a placement's refusal, have
   * to say which of the silences this is.
   */
  const read = readRegistry();
  return { slots: slotsFrom(read.entries), refusal: read.refusal };
}

export function computeSlots(): ComputeSlot[] {
  return slotsFrom(readRegistry().entries);
}

/**
 * The slots a registry implies — the ONE derivation, used by both readers.
 *
 * `computeSlots()` throws the refusal away and `slotAvailability()` keeps it;
 * neither computes a slot the other would not, because there is one function
 * here that turns servers into slots and both call it.
 */
/**
 * WHICH ENTRIES LOST THE MERGE, by lower-cased name, and to whom.
 *
 * Written by {@link slotsFrom} because that is where the decision is made, and
 * read by the Servers card so a row that draws no slot can say WHY. A merge
 * nobody can see is the app quietly disagreeing with somebody's registry.
 *
 * It is a snapshot of the LAST derivation rather than a durable fact: the hop
 * cache expires, a server is switched off, and the answer changes. Every reader
 * of it re-derives the slots first, which is what keeps the two in step.
 */
let sharesEngineWith = new Map<string, string>();

/** Whose engine this entry turned out to share, or null. See {@link sharesEngineWith}. */
export function engineSharedWith(name: string): string | null {
  return sharesEngineWith.get(name.toLowerCase()) ?? null;
}

function slotsFrom(entries: readonly CrucibleServerEntry[]): ComputeSlot[] {
  /*
   * ── ONE LIST, ONE DERIVATION, BOTH WAYS ───────────────────────────────────
   *
   * Hosted, the entries handed in are the HOST's registry (`readRegistry`), so
   * the slots below are derived from them by this same code rather than handed
   * over as a second list. That is what stops a host and this app computing
   * different slots from the same servers, and it is what makes a credential
   * lookup impossible to miss: every slot named here came from an entry that
   * `crucibleServerNamed` will find.
   *
   * NOTHING IS SUPPRESSED HOSTED ANY MORE, and it used to be two things and then
   * one. The one was the local slot — BookForge requires Crucible and has no
   * ollama fallback (SLOTS.md §1) — and there is no local slot on either side of
   * that seam now, so the branch that hid it is gone rather than kept as a test
   * of something that cannot happen.
   *
   * CLOUD SLOTS ARE DRAWN HOSTED, and the reverse was a mistake that
   * contradicted a ruling. Owen: *"if a user can't run a 27b for translation,
   * the only way the translate/simplify cards can light up is if we connect a
   * cloud model."* A person running BookForge on a laptop IS that user, and
   * suppressing the cloud here left them no path at all — translate and
   * simplify dark, with the sentence naming a card this window did not draw.
   * The argument for suppressing was that the bill is the host's; it is not.
   * The key is the host USER's own, typed into this card by the person who
   * will pay for it, and there is no third party anywhere in it.
   */
  const servers = entries.filter((entry) => entry.enabled && engineAbsence(entry) === null);
  /*
   * ── TWO DOORWAYS ONTO ONE MACHINE ARE ONE SLOT ────────────────────────────
   *
   * Owen, 2026-09-15: *"the windows crucible instance should act as a
   * passthrough for the WSL crucible … it's just a passthrough to the real
   * engine."* So the Windows tray and the WSL engine behind it are one card
   * reachable two ways, and a registry holding both entries would otherwise
   * draw TWO GPU LANES OVER ONE CARD — the queue would believe it had two
   * machines and start two jobs on one, where the 27B needs 20.1 of the 21 GiB
   * that card has free. Slower than running them in turn, and often a failure.
   *
   * THE ADDRESS RULE IS WAVE 70's, the third caller of it: a doorway is the same
   * doorway whatever its host case or its default port
   * ({@link sameCrucibleAddress}). What is compared is the RESOLVED address, so
   * the tray at `:7101` and the engine at `:7100` land on one key.
   *
   * FIRST IN REGISTRY ORDER WINS, because the order is the person's own drag
   * rank (Wave 66) and nothing else here is entitled to rank two entries. The
   * loser is not deleted, not disabled and not renamed — it keeps its row on the
   * Servers card, which says which entry it shares a machine with.
   *
   * AN UNRESOLVED ENTRY IS NEVER MERGED. `resolvedEngineAddress` answers null
   * for a machine nobody has asked yet, and every null is its own key, so a slot
   * is hidden only on a fact and never on ignorance — `engineAbsence`'s rule one
   * line above, which this now sits beside.
   */
  const byEngine: CrucibleServerEntry[] = [];
  const merged = new Map<string, string>();
  for (const entry of servers) {
    const address = resolvedEngineAddress(entry);
    const first = address === null
      ? undefined
      : byEngine.find((kept) => {
        const keptAt = resolvedEngineAddress(kept);
        return keptAt !== null && sameCrucibleAddress(keptAt, address);
      });
    if (first === undefined) byEngine.push(entry);
    else merged.set(entry.name.toLowerCase(), first.name);
  }
  sharesEngineWith = merged;
  const out: ComputeSlot[] = byEngine.map(
    (entry): ComputeSlot => ({ name: entry.name, kind: 'crucible', url: entry.url }),
  );
  const taken = new Set(out.map((slot) => slot.name.toLowerCase()));
  for (const provider of enabledCloudProviders()) {
    if (taken.has(provider.name.toLowerCase())) continue;
    taken.add(provider.name.toLowerCase());
    /*
     * NO `url` ON A CLOUD SLOT, deliberately, and `ComputeSlot.url` carries the
     * whole argument: `localLane` reads that field to decide which lane is this
     * machine's own card, and an OpenAI-compatible endpoint at localhost would
     * be adopted as the local lane. The address is on the provider entry, which
     * is what the placement composes `--endpoint` from.
     */
    out.push({ name: provider.name, kind: 'cloud' });
  }
  return out;
}


/**
 * WHAT A NEW ROW SHOULD WAIT FOR — resolved at the press, never at the spawn.
 *
 * `top` becomes the NAME of the top-ranked enabled slot, because docs/SLOTS.md
 * §3 rules that *"queued rows do NOT move when servers are re-ranked"* and a row
 * carrying the word "top" would move. `any` stays the reserved word, which is
 * the one answer that genuinely means "decide later".
 *
 * UNDEFINED WHEN THERE IS NOTHING TO DECIDE — no slots at all, or exactly one. A
 * row with no `waitFor` is every row this queue has ever held; writing a name
 * onto it would put a fact on the wire that the picker is not even drawn to show.
 * With one slot the walk finds that slot anyway, and with none the placement
 * refuses by name — neither is a decision this function has to pre-empt.
 *
 * AND `top` IS THE TOP NON-CLOUD SLOT (docs/SLOTS.md §3: a cloud provider is *"a
 * deliberate per-job choice, never something `any` falls through to"*). The
 * ordering in `computeSlots` already puts every cloud slot last, so the filter
 * changes nothing today — it is here so that a later reordering cannot make a
 * standing preference start billing somebody by default. The same sentence in
 * two places is the point: `any` steps past them in the walk, and `top` cannot
 * name one here.
 */
export function waitForOfNewJob(): string | undefined {
  const slots = computeSlots();
  if (slots.length < 2) return undefined;
  if (readAppSettings().newJobsWaitFor === ANY_SLOT) return ANY_SLOT;
  return slots.find((slot) => slot.kind !== 'cloud')?.name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Talking to one, for a settings row
// ─────────────────────────────────────────────────────────────────────────────

/** What a caller may say about the client it wants. One field, and it is a clock. */
export interface ClientOptions {
  /**
   * A DEADLINE ON EVERY CALL THIS CLIENT MAKES, in milliseconds.
   *
   * `CrucibleClientOptions.timeoutMs`, new in `@crucible/client` 0.6.0 (packed
   * from crucible `e342fee`). There is no default and none is invented here: a
   * dispatch is a person's press being answered and may wait as long as the
   * platform waits, and a number chosen in this function would cancel somebody's
   * slow-but-working load. The one caller that says a number is
   * `crucible-provider.ts`'s gate probe (`PROBE_TIMEOUT_MS`), because a Mac that
   * is asleep must not put a network timeout behind a tooltip.
   */
  readonly timeoutMs?: number;
}

/**
 * A client for one entry, AT THE ADDRESS THE ENTRY HOLDS. The only place a token
 * meets the SDK.
 *
 * ── AND IT IS NOT THE ONE MOST CALLERS WANT ANY MORE ───────────────────────
 *
 * A registered address may be an ORCHESTRATOR (crucible
 * docs/PHASE17-ORCHESTRATOR.md §1), which serves no job types at all. Anything
 * that talks to the ENGINE — a capability read, a placement, a settings write,
 * coordination — goes through {@link engineClientFor} instead, which follows
 * §6's one hop. This function is what that one is built out of, and what the
 * two callers who genuinely mean *this* address use: the hop resolution itself,
 * and nothing else.
 */
export function clientFor(entry: CrucibleServerEntry, options: ClientOptions = {}): CrucibleClient {
  return new CrucibleClient({
    url: entry.url,
    token: entry.token,
    clientName: CRUCIBLE_CLIENT_NAME,
    timeoutMs: options.timeoutMs,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// An orchestrator is not an engine — crucible docs/PHASE17-ORCHESTRATOR.md §6
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT A REGISTERED ADDRESS TURNED OUT TO BE, once the relation was read.
 *
 * `entry` is the entry as the ENGINE is addressed: the same name and the SAME
 * TOKEN (§6: *"follow `engine.url` ONCE, with the SAME token"*), with the
 * engine's url in place of the registered one. `hop` is null when the
 * registered address IS the engine, which is every machine that predates Phase
 * 17 and every machine that never grew a tray.
 */
export interface EngineTarget {
  readonly entry: CrucibleServerEntry;
  readonly hop: EngineHop | null;
}

/** The orchestrator that was in front of the engine, for a sentence. */
export interface EngineHop {
  /** What the person actually registered. `crucible:open` still opens THIS. */
  readonly orchestratorUrl: string;
  /** `info().server.name` of the orchestrator — `crucible-orchestrator@owens-pc`. */
  readonly orchestratorName: string;
  /** PHASE17 §3.2's `engine` ref, as it arrived. `name` is null when it could not be read. */
  readonly engineName: string | null;
  readonly engineUrl: string;
  readonly engineBackend: string | null;
  readonly engineOwner: EngineOwner;
}

/**
 * THE TWO WAYS A HOP CANNOT BE FOLLOWED, each with the relation's own name on it.
 *
 * Neither is a fault of this app's and neither is a server that is merely busy,
 * so neither may wear the SDK's sentence for something else. They are refusals
 * a PERSON fixes — install an engine on that machine, or point the entry at one
 * — which is why `crucible-dispatch.ts` reads them as STANDING waits: nothing
 * the queue does on a timer will change either answer.
 *
 *   `orchestrator_has_no_engine` — §6, verbatim: *"A machine whose orchestrator
 *     has no engine has nothing to ask; that is a fact to show a person, next to
 *     the button that installs one."* The SDK's `engineOf` throws a
 *     `CrucibleProtocolError` for this; it is caught and re-thrown here, because
 *     a protocol error means "the document is malformed" everywhere else in this
 *     app and this document is not — it is a correct document about an empty
 *     machine.
 *   `orchestrator_engine_is_not_an_engine` — §6's *"Once, and never a chain."*
 *     The second document's `role` is CHECKED and anything but `engine` is
 *     refused rather than followed. A client that followed it would loop.
 */
export class CrucibleOrchestratorError extends Error {
  readonly code: 'orchestrator_has_no_engine' | 'orchestrator_engine_is_not_an_engine';

  constructor(
    code: 'orchestrator_has_no_engine' | 'orchestrator_engine_is_not_an_engine',
    message: string,
  ) {
    super(message);
    this.name = 'CrucibleOrchestratorError';
    this.code = code;
  }
}

/**
 * How long a resolved hop is believed. `crucible-provider.ts`'s clock and its
 * argument, one question along: the fact moves — a tray is installed, an engine
 * is moved into WSL, `crucible install` finishes — but a window this short
 * cannot be the thing that makes a placement wrong for long, and a resolution
 * per capability read would put an extra round trip in front of every one.
 */
const HOP_CACHE_MS = 60_000;

interface HopEntry {
  at: number;
  target: EngineTarget;
}

/**
 * ONE RESOLUTION PER REGISTRY ENTRY, keyed by the two fields that decide it.
 *
 * The NAME is not enough — a person who re-points an entry at a different
 * machine has changed the answer and kept the name — and the TOKEN is not in
 * the key, because a token that changed cannot change which of two processes
 * answers an address, and a secret is not a map key in this process on the rule
 * this module's header states.
 */
const hops = new Map<string, HopEntry>();

/** In flight, so two placements racing on one server make one round of requests. */
const hopsInFlight = new Map<string, Promise<EngineTarget>>();

/**
 * THE ENTRIES THAT TURNED OUT TO BE AN ORCHESTRATOR WITH NOTHING BEHIND THEM —
 * the negative half of the resolution, kept so the SLOT LIST can read it without
 * asking anybody anything.
 *
 * Keyed and clocked exactly as {@link hops} is (`hopKey`, {@link HOP_CACHE_MS}),
 * because it is the same fact with the opposite sign and a person fixes it the
 * same way — `crucible install` on that machine, or re-pointing the entry — after
 * which the next resolution overwrites it.
 *
 * ONLY `orchestrator_has_no_engine` IS REMEMBERED HERE. A machine that is
 * unreachable is asleep, not engineless, and hiding its slot would take a lane
 * away from somebody whose Mac is shut; a chained orchestrator
 * (`orchestrator_engine_is_not_an_engine`) is a misconfiguration the placement
 * already refuses with a sentence naming both addresses, and a person needs to
 * see that slot in the picker to understand which entry they must re-point.
 */
const engineless = new Map<string, { at: number; sentence: string }>();

/**
 * IS THIS ENTRY KNOWN TO HAVE NO ENGINE BEHIND IT — the refusal's own sentence,
 * or null for "no" and for "nobody has asked yet".
 *
 * SYNCHRONOUS, AND A CACHE READ AND NOTHING ELSE — `crucible-provider.ts`'s
 * posture, for its reason: the readers are the slot list and the dispatcher's
 * pinned branch, both of which run on every pump pass and behind every picker,
 * and neither may put a network hop behind a lane. An unfilled cache answers null
 * so an unprobed machine keeps its lane; the two states are told apart nowhere in
 * this app because the answer to both is the same one.
 */
export function engineAbsence(entry: CrucibleServerEntry): string | null {
  const known = engineless.get(hopKey(entry));
  if (known === undefined || Date.now() - known.at >= HOP_CACHE_MS) return null;
  return known.sentence;
}

/**
 * WHERE THIS ENTRY'S WORK ACTUALLY LANDS — the engine's address, or null for
 * "nobody has resolved this one yet".
 *
 * Owen, 2026-09-15, on the Windows tray: *"the windows crucible instance should
 * act as a passthrough for the WSL crucible. all settings and calls should
 * arrive at the WSL crucible. it's just a passthrough to the real engine."* So
 * an entry pointing at an orchestrator is not a machine of its own — it is a
 * second doorway onto one — and the address below is the machine, whichever
 * doorway was registered.
 *
 * SYNCHRONOUS AND A CACHE READ AND NOTHING ELSE, exactly as {@link
 * engineAbsence} is and for the same reason: the reader is the slot list, which
 * runs behind every picker and on every pump pass. An unresolved entry answers
 * null and {@link slotsFrom} keeps its lane — this app never hides a machine on
 * the strength of not having asked.
 */
export function resolvedEngineAddress(entry: CrucibleServerEntry): string | null {
  const cached = hops.get(hopKey(entry));
  if (cached === undefined || Date.now() - cached.at >= HOP_CACHE_MS) return null;
  return cached.target.hop?.engineUrl ?? cached.target.entry.url;
}

/**
 * Every ENABLED entry currently known to have no engine behind it — for the two
 * sentences that have to name them: a pinned row whose one server is in this
 * state, and the refusal a board with no slots at all gives.
 */
export function enginelessServers(): { name: string; sentence: string }[] {
  const out: { name: string; sentence: string }[] = [];
  for (const entry of crucibleServers()) {
    if (!entry.enabled) continue;
    const sentence = engineAbsence(entry);
    if (sentence !== null) out.push({ name: entry.name, sentence });
  }
  return out;
}

function hopKey(entry: CrucibleServerEntry): string {
  return `${entry.name.toLowerCase()}\u0000${entry.url}`;
}

/**
 * FORGET EVERY RESOLVED HOP — called from `afterRegistryChanged()` (ipc.ts),
 * beside `forgetCrucibleFacts()` and for the same reason it is called there.
 *
 * A deliberate registry change is the one moment a stale answer reads as the app
 * ignoring somebody: re-pointing an entry from the orchestrator to the engine,
 * or the other way, must take effect on the next press and not a minute later.
 * There is no synchronous reader of this cache to mislead — every caller is
 * already inside an `await` — which is the one way it is simpler than the
 * capability cache it is modelled on.
 */
export function forgetEngineTargets(): void {
  hops.clear();
  /*
   * AND THE NEGATIVE HALF WITH IT. An entry that answered "no engine" is one
   * whose slot this app is hiding; somebody who has just pressed Save on the
   * Servers card — after installing the engine, or after re-pointing the row —
   * must get that slot back on the next read rather than a minute later.
   */
  engineless.clear();
}

/**
 * FOLLOW THE RELATION, ONCE — crucible docs/PHASE17-ORCHESTRATOR.md §6.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * Because on Owen's own PC there are two Crucible processes and only one of them
 * can do any work: the tray ORCHESTRATOR answers `127.0.0.1:7101` and the WSL
 * ENGINE answers `127.0.0.1:7100`. A person who pastes the orchestrator's
 * connect code, or whose pairing file names it, would otherwise have this app
 * talking to a process with `job_types: []` — every capability class reading as
 * unavailable and every placement failing or parking, on a machine with a
 * working 4090 in it.
 *
 * ── The rule, which is `engineOf`'s and is not re-derived here ─────────────
 *
 *   * `role: 'engine'` — and a pre-Phase-17 document, which the SDK reads as
 *     one by its VINTAGE (§3.3's all-or-nothing rule, the same one `route`
 *     gets) — resolves to the entry unchanged. You are already there.
 *   * `role: 'orchestrator'` with an engine → the engine's url, the SAME token,
 *     and the second document's `role` checked before anything is sent to it.
 *   * `role: 'orchestrator'` with no engine → refused by name.
 *
 * ── ONCE, AND NEVER A CHAIN ────────────────────────────────────────────────
 *
 * The second `info()` is the whole of the chain check and is not an extra cost
 * anybody pays twice: it is made only on the orchestrator branch, and the
 * answer is cached for {@link HOP_CACHE_MS}. An orchestrator whose `engine.url`
 * names another orchestrator is a misconfigured machine, and a client that
 * followed it would loop.
 *
 * NOTHING HERE IS LOGGED. The address of a hop is not a secret but the token
 * carried across it is, and a line that names one server "through" another is a
 * line that gets pasted into a bug report beside the rest of the console.
 */
export async function resolveEngine(
  entry: CrucibleServerEntry,
  options: ClientOptions = {},
): Promise<EngineTarget> {
  const key = hopKey(entry);
  const cached = hops.get(key);
  if (cached !== undefined && Date.now() - cached.at < HOP_CACHE_MS) {
    /*
     * THE TOKEN IS TAKEN FROM THE ENTRY IN HAND, never from the cached copy. A
     * registry save that only rotated a token does not move the hop (see
     * `hopKey`), so the cached url is still right and the cached secret is the
     * old one — and a stale token is exactly the 401 nobody can explain.
     */
    return withToken(cached.target, entry.token);
  }
  const running = hopsInFlight.get(key);
  if (running !== undefined) return withToken(await running, entry.token);
  const attempt = resolveOnce(entry, options).finally(() => { hopsInFlight.delete(key); });
  hopsInFlight.set(key, attempt);
  let target: EngineTarget;
  try {
    target = await attempt;
  } catch (err) {
    /*
     * THE ONE FAILURE THAT IS REMEMBERED — see {@link engineless}. It is written
     * here rather than in `resolveOnce` because this is the function that owns
     * the cache and its clock, and a second writer of one cache is how a fact
     * gets a different lifetime depending on which caller found it.
     */
    if (err instanceof CrucibleOrchestratorError && err.code === 'orchestrator_has_no_engine') {
      engineless.set(key, { at: Date.now(), sentence: err.message });
    }
    throw err;
  }
  /*
   * A RESOLUTION IS THE ANSWER TO THE OPPOSITE QUESTION TOO: an entry that has
   * just named its engine is not an entry with none, whatever it said a minute
   * ago, and leaving the old fact to expire would hide a working slot for the
   * rest of the window.
   */
  engineless.delete(key);
  hops.set(key, { at: Date.now(), target });
  return target;
}

function withToken(target: EngineTarget, token: string): EngineTarget {
  return target.entry.token === token
    ? target
    : { ...target, entry: { ...target.entry, token } };
}

async function resolveOnce(
  entry: CrucibleServerEntry,
  options: ClientOptions,
): Promise<EngineTarget> {
  const here = await clientFor(entry, options).info();
  /*
   * `engineOf` IS THE RULE AND IS THE SDK'S. Foundry does not re-implement it,
   * for the reason the contract states in §6: *"the SDK's rule, written once so
   * both apps read it the same way."* A second reading here is how Foundry and
   * BookForge start disagreeing about which of two processes on one machine is
   * the one that does the work.
   */
  let ref: EngineRef | null;
  try {
    ref = engineOf(here);
  } catch (err) {
    /*
     * THE SDK'S OWN SENTENCE IS DELIBERATELY NOT APPENDED. `engineOf` raises a
     * `CrucibleProtocolError`, whose wrapper reads *"crucible sent something API
     * v1 does not describe"* — and this document describes itself perfectly. It
     * is a correct answer about an empty machine, and printing that wrapper
     * beside it would send somebody looking for a malformed document.
     */
    void err;
    throw new CrucibleOrchestratorError(
      'orchestrator_has_no_engine',
      `${entry.url} is an orchestrator (${here.server.name}) and manages no engine, so there is `
      + 'nothing there to send work to — install one from its console, or point this entry at a '
      + 'machine that has one.',
    );
  }
  if (ref === null) return { entry, hop: null };

  const url = clampCrucibleUrl(ref.url);
  if (url === null) {
    throw new CrucibleOrchestratorError(
      'orchestrator_engine_is_not_an_engine',
      `${entry.url} is an orchestrator and named its engine as "${ref.url}", which is not an `
      + 'address this app can reach.',
    );
  }
  const engine: CrucibleServerEntry = { ...entry, url };
  /*
   * §6: *"the second document's `role` is checked and anything but `engine` is
   * refused rather than followed."* Read BEFORE anything else is asked of it,
   * so that a machine chained to a second orchestrator is refused rather than
   * having a capability read made against a process that serves none.
   */
  const there = await clientFor(engine, options).info();
  if (there.role !== 'engine') {
    throw new CrucibleOrchestratorError(
      'orchestrator_engine_is_not_an_engine',
      `${entry.url} is an orchestrator whose engine address (${url}) is itself an orchestrator `
      + `(${there.server.name}). An app follows one hop and no more — point this entry at the `
      + 'engine directly.',
    );
  }
  return {
    entry: engine,
    hop: {
      orchestratorUrl: entry.url,
      orchestratorName: here.server.name,
      engineName: ref.name ?? there.server.name,
      engineUrl: url,
      engineBackend: ref.backend ?? there.host.backend,
      engineOwner: ref.owner,
    },
  };
}

/**
 * A CLIENT FOR THE ENGINE BEHIND ONE REGISTRY ENTRY — what everything that does
 * work asks for.
 *
 * {@link clientFor} plus {@link resolveEngine}, in the one function, so that no
 * caller has to remember the pair. Callers that also need the engine's ADDRESS
 * (the placement composes `<url>/openai`, and the header map carries the token
 * for it) take {@link resolveEngine} directly and build the client from
 * `target.entry` — one resolution, one address, no chance of a request going to
 * the engine and a URL being composed from the orchestrator.
 */
export async function engineClientFor(
  entry: CrucibleServerEntry,
  options: ClientOptions = {},
): Promise<CrucibleClient> {
  return clientFor((await resolveEngine(entry, options)).entry, options);
}

/**
 * TEST CONNECTION — `info()`, which is authenticated, so one call answers both
 * "is there a Crucible there" and "is this the right token".
 *
 * Every failure keeps the SDK's own sentence. They already name what to fix
 * ("crucible at http://… is unreachable: …", "crucible refused the token") and a
 * word of ours in place of one of those is how a fixable problem becomes an
 * unfixable one. The types are named in the catch anyway — not to reword them,
 * but so that a throw this module has NOT anticipated is visibly a different
 * branch rather than something that quietly wore the same sentence.
 */
export async function probeCrucible(name: string): Promise<CrucibleProbe> {
  const entry = crucibleServerNamed(name);
  if (entry === null) return { outcome: 'failed', message: `There is no server called "${name}".` };
  return probeEntry(entry);
}

/**
 * TEST AN ADDRESS AND A TOKEN THAT ARE NOT IN THE REGISTRY YET.
 *
 * The setup wizard's "Connect to a Crucible server" door (docs/SETUP.md, Wave 61
 * package E) has a URL box, a token box and a Test button, and none of those
 * three has been saved when the button is pressed. Testing after adding would be
 * this app writing a server into somebody's settings in order to find out
 * whether it is a server.
 *
 * IT IS THE SAME PROBE, through the same client and the same error handling —
 * the only difference is where the two fields came from. A second probe with its
 * own error branches is how one surface starts reporting "unreachable" where the
 * other reports the SDK's sentence about a refused token.
 *
 * THE TOKEN IS NOT STORED BY THIS CALL and is not logged by it. It arrives over
 * IPC from a box the person is typing in, is used for one request, and is
 * dropped; only a later `crucible:save` writes it anywhere.
 */
export async function probeCrucibleAt(url: string, token: string): Promise<CrucibleProbe> {
  const clamped = clampCrucibleUrl(url);
  if (clamped === null) {
    return {
      outcome: 'failed',
      message: 'That needs to be an address like http://192.168.1.20:7100 — the server\'s base URL, '
        + 'without /v1 on the end.',
    };
  }
  if (token.trim().length === 0) {
    return {
      outcome: 'failed',
      message: 'A Crucible has no anonymous mode. Run `crucible token --show` on that machine and '
        + 'paste what it prints.',
    };
  }
  return probeEntry({ name: clamped, url: clamped, token: token.trim(), enabled: true });
}

/**
 * The probe itself. Both doors above are this function plus a way of naming the
 * server.
 *
 * ── AN ORCHESTRATOR IN FRONT OF AN ENGINE IS A SUCCESS ─────────────────────
 *
 * And it has to be, because it is the shape of Owen's own PC (PHASE17 §5, first
 * row): the tray on `:7101`, the WSL engine on `:7100`, and an address that is
 * perfectly usable through one hop. Reporting it as a failure would tell
 * somebody to fix a machine that is working. So the probe RESOLVES first and
 * then reads the ENGINE's document — the name, the version, the backend and the
 * card are all the engine's, which is the machine the work will run on — and
 * `via` carries the orchestrator so the card can say both.
 *
 * WHAT STAYS A FAILURE is an orchestrator with nothing behind it, and a chain.
 * Both arrive as {@link CrucibleOrchestratorError}, whose sentences name what to
 * do, and both fall through the named catch below like every other refusal.
 */
/**
 * The card, named once.
 *
 * This was `${vendor} ${name}`, which on every NVIDIA machine there is produces
 * *"nvidia NVIDIA GeForce RTX 3090 Ti"* — the vendor twice, once in lower case.
 * The prefix is not useless, though, and is why the join was there: a Mac
 * answers vendor `apple` with name `M1 Ultra`, and "M1 Ultra" alone on a card
 * beside three NVIDIA rows is the one row that does not say whose it is.
 *
 * So it is prefixed only when the name does not already say it. Compared case-
 * insensitively because the two fields disagree on case by convention — the
 * vendor is a lower-case key, the name is the marketing string — and that
 * disagreement is exactly what made the duplicate invisible to whoever wrote
 * the join.
 */
function gpuWords(vendor: string, name: string): string {
  const card = name.trim();
  const who = vendor.trim();
  if (who.length === 0) return card;
  if (card.length === 0) return who;
  return card.toLowerCase().startsWith(who.toLowerCase()) ? card : `${who} ${card}`;
}

async function probeEntry(entry: CrucibleServerEntry): Promise<CrucibleProbe> {
  try {
    const target = await resolveEngine(entry);
    const info = await clientFor(target.entry).info();
    return {
      outcome: 'ok',
      serverName: info.server.name,
      version: info.server.version,
      backend: info.host.backend,
      gpu: gpuWords(info.host.gpu.vendor, info.host.gpu.name),
      vramBytes: info.host.gpu.vramBytes,
      via: target.hop === null
        ? null
        : `through the orchestrator ${target.hop.orchestratorName} at ${target.hop.orchestratorUrl} `
          + `(${target.hop.engineOwner})`,
    };
  } catch (err) {
    if (
      err instanceof CrucibleUnreachable
      || err instanceof CrucibleNotACrucible
      || err instanceof CrucibleAuthError
      || err instanceof CrucibleVersionError
      // The relation's own two, whose sentences already say what to install or
      // what to re-point — see CrucibleOrchestratorError.
      || err instanceof CrucibleOrchestratorError
    ) {
      return { outcome: 'failed', message: err.message };
    }
    return { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The local connection, published by Crucible on the native filesystem.
// ─────────────────────────────────────────────────────────────────────────────

export async function addLocalCrucible(name: string): Promise<LocalCrucibleAdd> {
  refuseHostedRegistryChange();
  try {
    const published = await pairingFileRead();
    if (published.found !== 'pairing') {
      return {
        outcome: 'failed',
        code: published.found === 'absent' ? 'no_local_config' : 'config_unreadable',
        message: published.found === 'absent'
          ? 'Crucible has not published a local connection. Install or repair Crucible, then try again.'
          : published.message,
      };
    }
    const connection = published.pairing;
    // Refresh an existing address in place, preserving the user's name, rank
    // and enabled state even if the server renamed itself or rotated its token.
    const existing = crucibleServers().find((entry) => sameCrucibleAddress(entry.url, connection.url));
    const wanted = tidySlotName(name);
    const label = existing !== undefined ? existing.name : wanted.length > 0 ? wanted : connection.name;
    const servers = addCrucibleServer(label, connection.url, connection.token);
    return { outcome: 'added', servers, serverName: label, url: connection.url, configPath: published.path };
  } catch (err) {
    return { outcome: 'failed', code: 'config_unreadable',
      message: err instanceof Error ? err.message : String(err) };
  }
}
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started or timed out. Never both with a code. */
  failure: string | null;
}

/**
 * Run one command and collect what it said.
 *
 * ── The decode, which is the thing that makes this its own function ────────
 *
 * `wsl.exe` writes its OWN messages ("There is no distribution with the
 * supplied name") in UTF-16LE with a BOM, while everything the guest prints
 * comes through as UTF-8. So the two are interleaved on one pipe with two
 * encodings, and a `spawn(..., {encoding: 'utf8'})` turns the wsl.exe half into
 * a string of NUL-separated characters — which is how a legible refusal becomes
 * an unreadable one exactly when somebody needs to read it. Each chunk is
 * therefore decoded on its own, by the one thing that tells the two apart at a
 * glance: UTF-16LE ASCII has a NUL in every other byte.
 */
export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = '';
    let stderr = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: '', failure: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, failure: 'it did not answer within 20 seconds' });
    }, 20_000);
    child.stdout?.on('data', (chunk: Buffer) => { stdout += decodeChunk(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += decodeChunk(chunk); });
    child.on('error', (err) => finish({ code: null, stdout, stderr, failure: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, failure: null }));
  });
}

/** One chunk, decoded as whichever of the two encodings it actually is. */
function decodeChunk(chunk: Buffer): string {
  if (chunk.length >= 2 && chunk[0] === 0xff && chunk[1] === 0xfe) {
    return chunk.subarray(2).toString('utf16le');
  }
  /*
   * No BOM, so look at the bytes. Interleaved NULs in the first stretch of a
   * chunk mean UTF-16LE ASCII and mean nothing else: UTF-8 never contains a NUL
   * byte at all, so a single one is already conclusive and half of them is not a
   * judgement call.
   */
  const look = Math.min(chunk.length, 64);
  let nuls = 0;
  for (let index = 1; index < look; index += 2) if (chunk[index] === 0) nuls += 1;
  return nuls > 0 && nuls >= Math.floor(look / 4) ? chunk.toString('utf16le') : chunk.toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// The settings card's one read
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the Servers card draws, in one answer — see `CrucibleSettingsView`. */
export function crucibleSettingsView(): CrucibleSettingsView {
  const settings = readAppSettings();
  return {
    servers: crucibleServerViews(),
    slots: computeSlots(),
    newJobsWaitFor: settings.newJobsWaitFor,
    queueGpuDial: settings.queueGpuDial,
    wslDistro: settings.wslDistro,
    hosted: hosted(),
  };
}

/**
 * And the Cloud providers card's one read — see `CloudSettingsView`.
 *
 * ── Why it is composed HERE and not in `cloud-providers.ts` ────────────────
 *
 * Because it carries the SLOT LIST, and `computeSlots` lives in this module.
 * Putting this function beside the providers would mean that module importing
 * this one while this one already imports it for the cloud slots — a cycle,
 * around a function whose whole job is to answer one question consistently. The
 * division stays what the two headers say: that module reads and writes the
 * providers, this one derives the slots, and the card's read is a slot question
 * with a list attached.
 */
export function cloudSettingsView(): CloudSettingsView {
  return {
    providers: cloudProviderViews(),
    slots: computeSlots(),
    hosted: hosted(),
  };
}
