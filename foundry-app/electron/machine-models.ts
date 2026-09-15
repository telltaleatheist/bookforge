/**
 * machine-models — every store of weights this app knows about on this machine,
 * with sizes, and the one of them Foundry is allowed to delete from.
 *
 * ── WHY THE ROW EXISTS AT ALL ───────────────────────────────────────────────
 *
 * Owen, 2026-09-14 (docs/SLOTS.md §5b): *"id really rather not have multiple
 * copies of gigantic models floating around… the models cant cross the wsl
 * barrier right?"* They can be reached across it and it does not help: ollama
 * holds its own quantised GGUF blobs, Crucible on WSL holds safetensors for
 * vLLM, Crucible on the Mac holds MLX weights. The 27B in each store is a
 * DIFFERENT FILE, so there is no sharing to arrange — only ownership to state,
 * and duplication to make visible. Hence §5b's last bullet: *"a 'Models on this
 * machine' settings row lists every store the app knows… with sizes, so
 * duplication is seen rather than discovered from a full disk."*
 *
 * ── ONE OWNER PER STORE, AND FOUNDRY OWNS EXACTLY ONE ───────────────────────
 *
 * **Foundry's own downloads** — the llama.cpp build and the dots.ocr GGUF files
 * under `pageReaderDir()` — are the only things on this screen with a Remove
 * button, because they are the only things this app put there. The removal
 * deletes that directory and nothing else, and says the gigabytes it freed
 * (`removePageReader`, page-reader.ts).
 *
 * **Ollama is listed and never touched.** Owen: *"ollama has its own thing going
 * on and we should leave it be."* It is a model manager with its own store, its
 * own commands and its own idea of what is safe to delete; a Remove button here
 * would be this app reaching into somebody else's application data to save a
 * number on a screen. The sizes come from `/api/tags`, which reports them, and a
 * model it reports no size for is a null rather than a zero.
 *
 * **A local Crucible** is a line naming what that server says it serves. Foundry
 * cannot see a Crucible's weights on disk and does not pretend to: the models
 * listed there carry no byte counts, because the honest answer to "how big is
 * it" from this side of the WSL boundary is that nobody here measured it.
 *
 * ── AND THE RULE THAT IS NO LONGER INERT ────────────────────────────────────
 *
 * §5b: Foundry deletes the dots GGUF *"only when a LOCAL Crucible has taken over
 * that class (its capability record lists the class as served — not merely 'a
 * server was configured'), and never silently"*, and *"a REMOTE Crucible removes
 * nothing… the settings row OFFERS removal with a number on it and the sentence
 * 'page reading will then need <server> to be reachable'."*
 *
 * That rule is now WIRED (Wave 61 package E). `pageReaderRemovalOffer` computes
 * it; `applyPageReaderRemoval` performs the automatic half and writes a receipt
 * (`AppSettings.pageReaderRemoved`) so the sentence survives the app being
 * closed. It fires from exactly two places — the moment the registry is saved,
 * and once at startup — and never from a read: a screen that deleted four
 * gigabytes as a side effect of being looked at would be a screen nobody could
 * open safely.
 */
import { readAppSettings, writeAppSettings } from './app-settings';
import { CRUCIBLE_READS } from './crucible-dispatch';
import {
  localCrucibleServes,
  localCrucibleSummary,
  refreshCrucibleFacts,
  remoteCrucibleServing,
} from './crucible-provider';
import { LINEUP_PROVENANCE } from './llm-catalog';
import { probeOllama } from './ollama';
import { DEFAULT_OLLAMA_ENDPOINT } from '../shared/pipeline';
import {
  pageReaderDir,
  pageReaderFootprint,
  removePageReader,
} from './page-reader';
import type {
  MachineModelItem,
  MachineModels,
  MachineStore,
  RemovalOffer,
  RemovalOutcome,
} from '../shared/types';

/**
 * The whole inventory, measured now.
 *
 * NOTHING IS CACHED on this side. Somebody who has just pulled a model in
 * another window, or deleted the page reader by hand, should see this screen say
 * so the next time they open it — and the cost is one directory walk plus one
 * localhost request. The Crucible half IS briefly cached, by the provider, and
 * refreshed here before anything is composed: see `refreshCrucibleFacts` for why
 * that fact is measured asynchronously and read synchronously.
 */
export async function machineModels(): Promise<MachineModels> {
  const settings = readAppSettings();
  /*
   * OLLAMA'S OWN PORT, AND NOT A SETTING ANY MORE. `AppSettings.ollamaUrl` was
   * deleted with every other model setting (Owen, 2026-09-15) — the address the
   * ENGINE forwards to is the engine's own `upstreams.ollama.url`, and Foundry
   * keeping a second copy of it was one fact with two owners. What this probe
   * is for is unchanged and is not about where work runs: it counts what is on
   * THIS DISK, and a machine with an Ollama on a moved port shows an empty
   * Ollama row, which is a smaller wrong answer than a stale address.
   */
  const [ollama] = await Promise.all([
    probeOllama(DEFAULT_OLLAMA_ENDPOINT),
    refreshCrucibleFacts(),
  ]);

  const foundry = pageReaderFootprint();
  const removed = settings.pageReaderRemoved;
  const foundryStore: MachineStore = {
    id: 'foundry',
    label: 'Foundry\'s own downloads',
    detail: foundry.items.length === 0
      ? emptyFoundryDetail(removed === null ? null : removedSentence(removed.server, removed.bytes, removed.at))
      : `The local page reader, in ${pageReaderDir()}. Removing it here deletes these files and `
        + 'nothing else; installing it again downloads them back.',
    bytes: foundry.bytes,
    items: foundry.items,
    removable: foundry.items.length > 0,
  };

  const ollamaItems: MachineModelItem[] = ollama.holdings.map((held) => ({
    name: held.name,
    detail: 'Pulled through Ollama, which manages its own store.',
    bytes: held.bytes,
  }));
  const ollamaStore: MachineStore = {
    id: 'ollama',
    label: 'Ollama',
    detail: ollama.running
      ? `${ollama.detail} Foundry never removes anything from it — Ollama is its own model manager.`
      : ollama.detail,
    bytes: ollamaItems.reduce<number | null>(
      (sum, item) => (sum === null || item.bytes === null ? null : sum + item.bytes),
      0,
    ),
    items: ollamaItems,
    // NEVER, and it is not a capability this screen is waiting on. See the header.
    removable: false,
  };

  const crucible = localCrucibleSummary();
  const crucibleStore: MachineStore = {
    id: 'crucible',
    label: 'A Crucible on this machine',
    detail: crucible?.detail
      ?? 'None is registered. A Crucible serving a class takes over that class\'s weights, and this '
        + 'row will say which — add one from the Servers card above.',
    /*
     * ALWAYS NULL, even with models listed. Crucible's store is on the far side
     * of a WSL boundary (or is MLX weights in a Mac's own cache) and this app has
     * measured none of it; a total composed from nothing would read as "0 bytes"
     * beside four model names, which is worse than saying nothing.
     */
    bytes: null,
    items: crucible?.items ?? [],
    removable: false,
  };

  return {
    stores: [foundryStore, ollamaStore, crucibleStore],
    pageReader: pageReaderRemovalOffer(),
    generatedBy: LINEUP_PROVENANCE.generatedBy,
    generatedAt: LINEUP_PROVENANCE.generatedAt,
  };
}

/** The Foundry store's sentence when there is nothing in it — with or without a receipt. */
function emptyFoundryDetail(receipt: string | null): string {
  const base = `Nothing. Foundry has downloaded no weights to this machine; the page reader would go `
    + `in ${pageReaderDir()}.`;
  return receipt === null ? base : `${receipt} ${base}`;
}

/** Remove Foundry's own downloads. The one deletion this screen may perform. */
export function removeFoundryDownloads(): Promise<RemovalOutcome> {
  return removePageReader();
}

/**
 * SLOTS.md §5b, as a function: should the dots files go, what would that cost,
 * and who ends up owning page reading if they do?
 *
 * ── THE THREE STATES, AND WHY `unknown` IS NOT `no` ─────────────────────────
 *
 * A **local** Crucible serving pages has taken over the class on this disk, so
 * the local reader's files are the duplicate and Foundry removes them — never
 * silently: the row says what went and what it freed, and the receipt in
 * settings says it again tomorrow.
 *
 * A **remote** Crucible removes NOTHING of its own accord. Owen: *"configured is
 * not present — the local reader is what works when the Mac is asleep."* So the
 * remote case is an OFFER with a number on it and a sentence naming what page
 * reading will then depend on. The person presses it or does not.
 *
 * `unknown` — nothing has probed, or the local server did not answer — takes the
 * same branch as `no`. That is the whole reason the provider's answer is
 * three-valued: a silence must never read as a permission to delete four
 * gigabytes.
 */
export function pageReaderRemovalOffer(): RemovalOffer {
  const footprint = pageReaderFootprint();
  const removed = readAppSettings().pageReaderRemoved;
  if (footprint.items.length === 0) {
    return {
      automatic: false,
      bytes: 0,
      server: null,
      detail: removed === null
        ? 'Foundry has downloaded no page reader here, so there is nothing to remove.'
        : removedSentence(removed.server, removed.bytes, removed.at),
    };
  }

  if (localCrucibleServes('pages') === 'yes') {
    /*
     * ── THE ONE CONDITION §5b's SENTENCE ASSUMES AND DOES NOT SPELL ──────────
     *
     * §5b says Foundry removes its own copy *"only when a LOCAL Crucible has
     * TAKEN OVER that class"*. Serving it is half of taking it over; the other
     * half is this app actually SENDING page reads there, and today it does not:
     * `CRUCIBLE_READS` is false (crucible-dispatch.ts), a `read` job takes the
     * local path, and `job-queue.ts` starts the local llama-server BEFORE it even
     * resolves a placement.
     *
     * So removing the files on the strength of a capability record alone would
     * delete the thing that is still doing the work, and the next PDF would fail
     * with "the local page reader is not installed yet" on a machine whose owner
     * had done nothing but register their own server. This is not caution about
     * §5b; it is §5b's own precondition, read exactly.
     *
     * WHAT IT COSTS TO REVERSE IS ONE CONSTANT. The day `CRUCIBLE_READS` flips —
     * which needs the read path to resolve its placement before it starts a
     * server, plus the ruling package B is settling about REMOTE readers — this
     * branch and `applyPageReaderRemoval` become automatic together, with no
     * other change. Nothing else in the rule is conditional.
     */
    if (!CRUCIBLE_READS) {
      return {
        automatic: false,
        bytes: footprint.bytes,
        /*
         * NULL, WHICH IS WHAT SWITCHES THE REMOVE BUTTON OFF. `server` names a
         * REMOTE Crucible that page reading would fall to — the case where
         * removing is a real choice with a real consequence. This is not that
         * case: removing here would break reading outright, so the card gets the
         * sentence and no button to press.
         */
        server: null,
        detail: 'The Crucible on this machine can read pages — but Foundry still reads them with '
          + 'its own copy, so removing it now would leave nothing here to read with. Foundry will '
          + 'remove it by itself once reading goes through Crucible.',
      };
    }
    return {
      automatic: true,
      bytes: footprint.bytes,
      server: null,
      detail: 'A Crucible on this machine is reading pages, so Foundry\'s own copy of the reader is '
        + 'a duplicate and is removed.',
    };
  }

  const remote = remoteCrucibleServing('pages');
  if (remote !== null) {
    return {
      automatic: false,
      bytes: footprint.bytes,
      server: remote,
      detail: `"${remote}" can read pages, and it is on another machine — so Foundry has removed `
        + `nothing. You can remove this copy to free the space; page reading will then need `
        + `"${remote}" to be reachable.`,
    };
  }

  return {
    automatic: false,
    bytes: footprint.bytes,
    server: null,
    detail: 'Nothing else on this machine reads pages, so Foundry\'s copy is the one that works. '
      + 'Removing it is yours to ask for.',
  };
}

/**
 * PERFORM §5b's AUTOMATIC HALF — the one place in this app that deletes model
 * files without somebody pressing a button.
 *
 * ── WHEN IT MAY RUN, AND THE TWO CALLERS THAT SAY SO ────────────────────────
 *
 * Only when `localCrucibleServes('pages')` is `yes`, which means an enabled
 * loopback entry answered `GET /v1/capability` with the `pages` row enabled and
 * a model selected. Not "a server is configured"; not "a server is loopback";
 * not `unknown`.
 *
 * It is called from `crucible:save` — the moment somebody registers or enables
 * the local Crucible, which is the gesture that makes this true — and once at
 * startup, for the machine where the Crucible was installed while Foundry was
 * closed. It is NOT called from `machineModels()` or from the gate read: a
 * deletion that happens because a screen was opened is a deletion nobody chose
 * the timing of, and the two read paths are called from tooltips.
 *
 * ── NEVER SILENT ────────────────────────────────────────────────────────────
 *
 * The receipt is written before this returns, so the Models card, the page
 * reader's own card and the next launch all say the same sentence. A removal
 * that freed nothing writes NO receipt — there would be nothing to explain, and
 * a receipt for it would haunt a machine that never had a reader.
 *
 * Returns the receipt's sentence when something was removed, and null otherwise,
 * so the caller can decide whether the change is worth a push.
 */
export async function applyPageReaderRemoval(): Promise<string | null> {
  if (localCrucibleServes('pages') !== 'yes') return null;
  /*
   * AND READING MUST ACTUALLY GO THERE. See the long note in
   * `pageReaderRemovalOffer`: while `CRUCIBLE_READS` is false a `read` job takes
   * the local path, so removing these files would delete the thing still doing
   * the work. The card says so; this returns null, and the day that constant
   * flips both halves become automatic together.
   */
  if (!CRUCIBLE_READS) return null;
  const before = pageReaderFootprint();
  if (before.items.length === 0) return null;

  const outcome = await removePageReader();
  if (!outcome.ok) {
    /*
     * A REFUSAL IS LOGGED AND LEFT ALONE. `removePageReader` refuses when the
     * server it would have to stop is not ours — somebody else's llama-server on
     * port 8000 — and the right answer to that is to keep the files, not to try
     * harder. The offer stays on the card with its own sentence next time.
     */
    console.error(`[slots] the page reader could not be removed automatically: ${outcome.detail}`);
    return null;
  }
  if (outcome.freedBytes === 0 && before.bytes !== null && before.bytes > 0) {
    // It reported success and freed nothing off a directory that had something
    // in it. Recorded as a null size rather than as a zero, for the same reason
    // `RemovalOutcome.detail` is main's sentence: a confident wrong number about
    // somebody's disk is worse than an admission.
    return finishRemoval(null);
  }
  return finishRemoval(outcome.freedBytes > 0 ? outcome.freedBytes : before.bytes);
}

function finishRemoval(bytes: number | null): string {
  /*
   * THE SERVER'S NAME COMES OFF THE REGISTRY AT THE MOMENT OF THE REMOVAL and is
   * stored, rather than being looked up when the sentence is printed: a person
   * who later renames or removes that entry should still be told which machine
   * took page reading over, and a name resolved at print time would go blank
   * exactly then.
   */
  const local = localCrucibleSummary();
  const server = local === null ? 'a Crucible on this machine' : nameFrom(local.detail);
  const at = new Date().toISOString();
  writeAppSettings({ pageReaderRemoved: { server, bytes, at } });
  return removedSentence(server, bytes, at);
}

/**
 * The first quoted name out of the provider's sentence.
 *
 * The provider composes that sentence and owns the quoting; pulling the name
 * back out of it here is cheaper than a second accessor that returns the same
 * string unquoted, and a sentence with no quoted name falls back to a phrase
 * rather than to an empty one.
 */
function nameFrom(detail: string): string {
  return /"([^"]+)"/.exec(detail)?.[1] ?? 'a Crucible on this machine';
}

/** The one sentence every surface prints about an automatic removal. */
function removedSentence(server: string, bytes: number | null, at: string): string {
  const size = bytes === null || bytes <= 0
    ? 'its files'
    : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  const when = at.slice(0, 10);
  return `"${server}" took over page reading on ${when}, so Foundry removed its own copy of the `
    + `reader and freed ${size}. Installing the page reader again downloads it back.`;
}
