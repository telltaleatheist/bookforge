/**
 * SLOTS — the places a job's compute can go, as both programs name them.
 *
 * The plan of record is docs/SLOTS.md, and Owen's sentence is the whole design:
 * *"everything goes through a crucible server now, including local… there should
 * be no local gpu listed in the queue"*, and then precisely: *"cpu slots are
 * always local. we dont outsource simple cpu work to crucible. one gpu slot in
 * the queue per connected crucible server. including the local crucible, which is
 * indistinguishable from the remote crucible server."*
 *
 * ── THAT RULING REPLACED AN EARLIER ONE, AND HALF THIS FILE WAS BUILT ON IT ──
 *
 * The earlier sentence was *"the friend sees a single gpu slot if theyre local —
 * their GPU slot… if theyre using crucible on their local machine, the local GPU
 * disappears."* So a machine's own Ollama WAS a slot (`LOCAL_SLOT_NAME`, "This
 * computer"), and an enabled loopback Crucible hid it — one card, one owner.
 *
 * There is no local slot now at all. The GPU slots are exactly the enabled
 * Crucible servers, in registry order, plus the cloud slots after them; a
 * Crucible on this desk is an ordinary registry entry that replaces nothing,
 * because there is nothing left for it to replace. What the ruling protects is
 * the CPU side of the board, which was never a slot and is not one now: a
 * compile, a rasterise and an EPUB assembly are this machine's disk and this
 * machine's cores, counted by `CPU_LANE_SLOTS` (shared/queue-board.ts) and
 * outsourced to nobody.
 *
 * ── WHY THIS IS `ComputeSlot` AND NOT `Slot` ────────────────────────────────
 *
 * Because `Slot` is taken, twice, by a different idea that is already right.
 * `shared/queue-board.ts` counts LANES — two CPU lanes, and one GPU lane per
 * compute slot — and `electron/job-queue.ts` calls one lane's claim a `Slot`.
 * That board answers *how many things may run at once*; this file answers
 * *whose machine*. They were orthogonal and are now merely different: since
 * Package G the board DERIVES its GPU lanes from the list this file describes
 * (`computeLanes`), so a slot is what a lane is made of rather than an unrelated
 * axis — while a CPU lane is still a lane and no slot's. One word for the two
 * would still be how a scheduler starts believing a remote job is holding the
 * local card, so the longer name stays deliberate, and the UI still says "slot"
 * because that is the word Owen used for the thing a person sees.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * No token, ever. A registry entry's token lives in the app's own settings file
 * and is read in the main process by the one module that builds a client with
 * it; nothing on this wire carries it and nothing in the renderer has ever seen
 * it. {@link CrucibleServerView.tokenSet} is the only thing the settings card
 * is told about it, which is the whole of what a person needs to know to decide
 * whether to type a new one.
 *
 * No capability answers either. What a server can and cannot do is a fact with
 * a clock on it — a card gets swapped, a model is deleted, somebody starts
 * narrating — so it is asked at the moment it is acted on (dispatch) or at the
 * moment somebody presses a button (Test connection) and never cached into a
 * shape like this, where a stale copy would be indistinguishable from a fresh
 * one.
 */
/*
 * THE ONE IMPORT IN THIS FILE, and it is a type. `CrucibleInstallRowId` is the
 * install door's row vocabulary and it has ONE owner — the wire file below —
 * because both the skeleton composed here and the events that fill it in must
 * name the same five rows. Re-spelling the union in this file is exactly the
 * two-owner shape ARCHITECTURE.md R1 names.
 */
import type { CrucibleInstallRowId } from './crucible-install-wire';

/**
 * The value of a row's `waitFor` that means "the first slot that will take it".
 *
 * A RESERVED NAME rather than `null` or an absent field, because absent already
 * means something else on `Job.waitFor`: a row minted before this existed, or by
 * a host that has not re-vendored, which falls back to the standing default
 * (`AppSettings.newJobsWaitFor`) rather than to any particular slot. The
 * registry refuses a server called this, so the two can never be confused.
 */
/**
 * WHY THERE IS NO PICKER — the difference between "none" and "could not ask".
 *
 * A bare `ComputeSlot[]` cannot tell a window with no servers from a window
 * that had nobody to ask, and the two want different sentences: the first is a
 * person who has not added one, the second is a host that has not implemented
 * the registry seam. Reporting the second as the first is a page quietly
 * behaving as though no server were linked, which is the shape this codebase
 * keeps removing.
 *
 * A CODE AND A SENTENCE TOGETHER, because they have different readers. The
 * sentence is drawn where the picker would be; the code is what anything that
 * branches reads, so no caller has to match on prose. Null is the ordinary
 * answer: the list is the whole truth.
 */
export interface SlotRefusal {
  /**
   * `host_provides_no_registry` — hosted, and the host implements no registry
   * seam at all. `host_registry_unavailable` — it implements one and the call
   * failed, which is a DIFFERENT fact: something is wrong on the host's side
   * right now rather than missing from its build, and it may work on the next
   * read. A host that answers "not ready yet" by throwing (BookForge throws
   * `registry_snapshot_not_taken` before its first snapshot) lands here, and
   * reporting that as "no servers" would be the silence this type exists to
   * end.
   */
  code: 'host_provides_no_registry' | 'host_registry_unavailable';
  sentence: string;
}

/** The slot list and, when there is one, the reason it could not be asked for. */
export interface SlotAvailability {
  slots: ComputeSlot[];
  refusal: SlotRefusal | null;
}

export const ANY_SLOT = 'any';

/**
 * THE LIVE QUEUE'S OWN CHOICE OF MACHINE — Owen's *"global crucible server
 * option"*, and the second of the two controls that decide where a row runs.
 *
 * Owen, 2026-09-15, settling the shape: *"a queue item is in pending, then the
 * crucible server is chosen (even if thats 'any'), and it's sent to the live
 * queue. the live queue distributes it to the correct crucible server depending
 * on what the live queue is set to — any, or a specific crucible server, from
 * the list."* And the gate, from the same ruling: *"if the queue has 'm1 ultra'
 * set as the crucible server, but the job item is set to 3090 ti, and it's added
 * to the queue, the queue doesnt process it until the global queue unlocks the
 * 3090 ti."*
 *
 * So the dial is a RESTRICTION and not merely a fallback. A row whose own choice
 * disagrees with it WAITS — it does not get quietly sent somewhere else, because
 * somebody named that machine on purpose and moving the work would be the app
 * overruling them silently.
 *
 * ── IT IS THE SAME LITERAL AS {@link ANY_SLOT}, DELIBERATELY ───────────────
 *
 * BookForge aliases theirs the same way (`GPU_DIAL_ANY` = `WAIT_FOR_ANY`) and
 * warned us to: two controls that both mean "whatever is free" and spell it
 * differently are two spellings that drift, and then one screen's "Any" stops
 * matching the other's. One literal, two names, and the names exist so a reader
 * can see WHICH control a given call site is talking about.
 */
export const GPU_DIAL_ANY = ANY_SLOT;

/**
 * WHO CHOSE THE MACHINE A PARKED ROW IS WAITING FOR — and the reason the
 * parked sentences are a 2xN rather than a list.
 *
 * BookForge's `VenueSource`, adopted verbatim on their advice — *"if Foundry
 * only mirrors one thing from this message, make it VenueSource"* — and the
 * argument is the failure it prevents:
 *
 *   `row`  — the BOOK names the server. The way out is to re-point the book.
 *   `dial` — the book said Any and THE QUEUE'S DIAL chose. The way out is to
 *            turn the dial.
 *
 * Every cause a row can be parked for (the machine is switched off, unreachable,
 * no longer registered, nothing enabled at all) can arise under either source,
 * and the CAUSE does not tell you which. Telling somebody whose book already
 * says Any to *"set this book to Any"* is telling them to do the thing they have
 * already done — a wrong-cause sentence that is invisible unless the source
 * travels beside the cause. {@link orAnyWords} renders the tail.
 */
export type VenueSource = 'row' | 'dial';

/**
 * THE LONGEST A SLOT NAME MAY BE — 48 characters, and the number is shared with
 * BookForge so that a name accepted in one app is accepted in the other.
 *
 * It used to be enforced by nobody and applied by one silent `.slice(0, 60)` on
 * the way to disk (electron/app-settings.ts), which is the worst of the three
 * possible answers: the card showed one name, the file held another, and the
 * truncated one could collide with a row that was already there.
 */
export const SLOT_NAME_MAX = 48;

/**
 * A SLOT NAME AS IT IS STORED — trimmed, with runs of whitespace collapsed to
 * one space.
 *
 * ONE SPELLING, because the name IS the identity: it is what a row's `waitFor`
 * says, what `ranOn` records, what the scheduler keys its occupancy by and what
 * the bench card is headed with. Two writers that tidied differently would put
 * two strings in front of one machine.
 */
export function tidySlotName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * WHAT IS WRONG WITH A SLOT NAME, as a sentence somebody can act on — or null
 * when nothing is.
 *
 * ── ONE OWNER FOR A RULE THAT TWO PLACES ENFORCE ────────────────────────────
 *
 * The registry has a REFUSING writer (`writeCrucibleServers`, with
 * `writeCloudProviders` beside it) and a CLEANING clamp (`clampCrucibleServers`,
 * `clampCloudProviders` — electron/app-settings.ts). That division of labour is
 * right and stays: the writer says what to fix because somebody is looking at a
 * card, the clamp drops what it cannot store because nobody is. What was wrong
 * is that the two enforced DIFFERENT RULES — the writer checked no length at
 * all while the clamp quietly truncated at 60 — so a long name was refused by
 * nobody and silently shortened on the way to disk, where it could collide with
 * another entry or stop matching the name the card was still showing. This
 * function is the one rule and both consult it. The `what` is the noun the
 * caller's card uses (`server`, `provider`), so the sentence names the thing the
 * person is editing.
 *
 * ── WHY EACH CHARACTER IS FORBIDDEN, HERE ───────────────────────────────────
 *
 * Not "because BookForge forbids it". The limits are shared with that app so
 * that one name is legal in both, but each of these breaks something in THIS
 * one:
 *
 *   * `:` is the mark between a slot and its upstream lane. `upstreamLaneName`
 *     composes `<slot>:cloud` (shared/queue-board.ts), and that string is an
 *     identity THREE readers compare by: the scheduler's occupancy map, the
 *     walk's claim, and the bench's card. A server called `3090:cloud` would
 *     give its own card lane the name of server `3090`'s UPSTREAM lane, and two
 *     lanes with one string is one lane.
 *   * `/` and `\` because a Crucible server's name becomes an Electron session
 *     partition, `crucible:<name>` (electron/crucible-ui.ts) — which is the
 *     whole of what keeps two servers' operator pages out of each other's
 *     cookies and storage.
 *   * A control character because the name is drawn as a label, written into a
 *     JSON settings file and printed in log lines, and not one of those three
 *     has an escape for it.
 *
 * ONE RULE FOR EVERY SLOT NAME rather than two that differ by list: both lists
 * feed one picker and one lane string, and a person moving a name from one card
 * to the other should not discover it is legal on only one of them.
 *
 * Runs of whitespace are not refused, they are COLLAPSED — see
 * {@link tidySlotName}, which every caller runs first. A double space is a typo
 * rather than a decision, and refusing one would be this app teaching somebody
 * to count spaces.
 *
 * ── AND THE ONE NAME THE QUEUE HAS ALREADY SPENT ────────────────────────────
 *
 * {@link ANY_SLOT} is what a row's `waitFor` says when it means "the first slot
 * that will take it". A slot wearing it would make a stored row mean something
 * other than what the person picked. The clamps always dropped it; now the
 * writers refuse it BY NAME instead of accepting a server that then vanishes.
 *
 * IT USED TO BE TWO. `LOCAL_SLOT_NAME` ("This computer") was the other, and it is
 * gone with the slot it named — Owen: *"there should be no local gpu listed in
 * the queue"*. A name nothing uses is not reserved, so the reservation went with
 * the constant rather than being kept as a rule about a word this app no longer
 * says.
 *
 * AND THE CPU LANE NEEDS NO RESERVATION EITHER, which was worth checking rather
 * than assuming: Owen's ruling protects that lane by name — *"cpu slots are
 * always local. we dont outsource simple cpu work to crucible"* — but the lane
 * has no name in this namespace and never had one. The CPU side of the board is
 * a COUNT (`CPU_LANE_SLOTS`, shared/queue-board.ts), its bench cards are keyed
 * `cpu:<n>` and titled "CPU · slot 1 of 2", and the scheduler's occupancy map
 * holds a lane name only for a GPU run (`Slot.on`, electron/job-queue.ts, is null
 * for every CPU row). There is no string a server could collide with.
 *
 * WHAT IS DELIBERATELY NOT HERE IS UNIQUENESS. One name cannot see the other
 * list, so a collision is refused at the two writers (which read both lists) and
 * deduped at the two clamps — `writeCrucibleServers` argues that split.
 */
export function slotNameRefusal(name: string, what: string): string | null {
  if (name.length === 0) {
    return `A ${what} needs a name — it is what a queue row waits for.`;
  }
  if (name.length > SLOT_NAME_MAX) {
    return `That name is too long — a ${what}'s name is at most ${SLOT_NAME_MAX} characters, `
      + `and this one is ${name.length}.`;
  }
  /*
   * THE NAME IS NOT ECHOED BACK IN THIS ONE SENTENCE: a control character
   * printed into a card's line is a card that draws wrong, which would be this
   * refusal reproducing the thing it is refusing.
   */
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return `A ${what}'s name cannot contain control characters.`;
  }
  if (name.includes(':')) {
    return `"${name}" cannot contain ":" — that is the mark between a slot and its upstream `
      + 'lane, so this name would be the same string as another slot\'s lane.';
  }
  if (name.includes('/') || name.includes('\\')) {
    return `"${name}" cannot contain "/" or "\\" — the name becomes a browser partition when `
      + 'this app opens that server\'s own page.';
  }
  if (name.toLowerCase() === ANY_SLOT.toLowerCase()) {
    return `"${name}" is a name the queue has already spent: "${ANY_SLOT}" means the first slot `
      + `that will take a row. Give this ${what} a different name.`;
  }
  return null;
}

/**
 * Whose compute a slot is.
 *
 * ── `local` IS GONE, AND THE UNION IS WHERE THAT IS ENFORCED ────────────────
 *
 * It was the machine's own Ollama, and Owen's ruling deleted it: *"everything
 * goes through a crucible server now, including local… there should be no local
 * gpu listed in the queue."* Removing the member rather than leaving it
 * unconstructed is the point — the compiler now refuses a slot, a lane or a
 * capacity that claims to be this machine's card, so there is no path by which
 * one comes back by accident. A Crucible on this desk is `crucible`, exactly as
 * the one in the next room is.
 *
 * `cloud` WAS THE SEAM AND IS NOW BUILT — docs/SLOTS.md §3 and §7 (Package F,
 * app half). It was declared here before anything constructed one, because every
 * walk in the dispatcher has to know that a cloud slot is *never* what `any`
 * falls through to (SLOTS.md §3: *"a deliberate per-job choice, never something
 * `any` falls through to"*), and a `kind` union that gains a member later would
 * make every one of those walks a place somebody has to remember.
 *
 * `computeSlots` now appends one per ENABLED {@link CloudProviderView}, after
 * every Crucible slot, and the `any` walk STEPS PAST them by kind with a
 * sentence rather than refusing — a machine with nothing but a cloud provider
 * configured is a machine whose `any` rows wait for a person to choose, which is
 * exactly what "never fallen back to" means when it is spent money on the other
 * side of the choice.
 */
export type ComputeSlotKind = 'crucible' | 'cloud';

/** One place a job's compute can go. */
export interface ComputeSlot {
  /**
   * What a row's `waitFor` names, and what every sentence about the wait says.
   * Unique across the list, and it is always somebody's own name: a Crucible
   * slot's is the registry entry's, a cloud slot's is the provider entry's.
   */
  name: string;
  kind: ComputeSlotKind;
  /**
   * A Crucible slot's base URL, without `/v1` — for the settings row, for the
   * "unreachable" sentence, and for composing the engine's `--endpoint`.
   *
   * ── AND DELIBERATELY ABSENT ON A CLOUD SLOT, WHICH DOES HAVE ONE ───────────
   *
   * A cloud provider has an address (the provider's own, or an
   * OpenAI-compatible host somebody named) and it is NOT put here, because this
   * field is read for one thing besides drawing: `localLane`
   * (shared/queue-board.ts) decides which lane is THIS MACHINE'S CARD by asking
   * whether a lane's url is loopback. An OpenAI-compatible endpoint at
   * `http://localhost:8000/v1` is a perfectly ordinary thing to configure, and a
   * cloud slot that carried it would be adopted as this machine's card — a
   * provider's rate limit standing in for a GPU, and whatever genuinely does run
   * on that card left unguarded. The address lives on the provider entry, where
   * the settings card reads it; the placement composes `--endpoint` from there.
   */
  url?: string;
}

/**
 * A registered Crucible server, as the renderer is allowed to see it.
 *
 * THE ARRAY POSITION IS THE RANK. There is no `rank` field and there must not be
 * one: a rank kept beside the order is two owners of one fact, and the first
 * time a drag reorders one and not the other the picker and the `any` walk
 * disagree about which machine is first. Reordering is rewriting the array.
 */
export interface CrucibleServerView {
  name: string;
  /** Base URL without `/v1`, as stored. */
  url: string;
  /** Off means it is not a slot at all: no picker entry, no `any` candidate. */
  enabled: boolean;
  /** Whether a token is stored. The token itself never crosses this wire. */
  tokenSet: boolean;
  /**
   * Is this the Crucible on this very machine? Derived from the URL rather than
   * stored, so a person who edits the address does not leave a flag behind
   * claiming otherwise.
   *
   * IT NO LONGER HIDES ANYTHING. It used to be the one thing that removed the
   * local slot — Owen's earlier *"if theyre using crucible on their local
   * machine, the local GPU disappears"* — and there is no local slot to remove:
   * *"one gpu slot in the queue per connected crucible server. including the
   * local crucible, which is indistinguishable from the remote crucible server."*
   * What it is still good for is locality itself: which lane is this machine's
   * card (`localLane`, shared/queue-board.ts), and which entry an Uninstall or a
   * local-config read is about.
   */
  loopback: boolean;
  /**
   * THE ENTRY THIS ONE TURNED OUT TO SHARE A MACHINE WITH, or null.
   *
   * Owen's pass-through ruling (2026-09-15) means a Windows tray and the WSL
   * engine behind it are ONE card reachable two ways, so registering both draws
   * one slot and not two. This is the row's half of saying so: the entry is
   * still listed, still enabled and still editable — what it does not have is a
   * lane of its own, and a row that silently stopped being a slot would be the
   * app disagreeing with somebody's registry behind their back.
   *
   * DERIVED FROM THE LAST SLOT DERIVATION, never stored: the hop cache expires
   * and the answer changes with it. Null covers both "it has its own machine"
   * and "nobody has resolved it yet", which are the same thing to this card —
   * in both cases the row draws a slot.
   */
  sharesEngineWith: string | null;
}

/**
 * One entry as the settings card hands it back. The whole array is sent, in
 * order, and replaces the whole registry — see {@link CrucibleServerView}.
 */
export interface CrucibleServerEdit {
  name: string;
  url: string;
  enabled: boolean;
  /**
   * A NEW token, or `null` to keep whatever is stored.
   *
   * The field is write-only in both directions of this pair: it comes back from
   * the card filled in only when somebody typed one, and the view that goes out
   * never carries it. `null` and `''` are different answers — `''` would be a
   * person clearing the field, which is a server that can no longer be reached
   * and is refused at the door rather than stored.
   */
  token: string | null;
}

/**
 * What a new row's `waitFor` starts as — Owen's *"New jobs wait for"* setting.
 *
 * `top` is the top-ranked ENABLED slot at the moment of the press, resolved then
 * and written onto the row, because a row that said "whatever is first" would
 * change machines when somebody reorders the list while it waits. `any` is the
 * reserved name and genuinely means "the first that will take it", decided at
 * dispatch.
 */
export type NewJobsWaitFor = 'top' | 'any';

/** What `Test connection` learned, as the card draws it. */
export type CrucibleProbe =
  | {
    outcome: 'ok';
    /** `info().server.name` — what the server calls itself. */
    serverName: string;
    /**
     * The server's version, or null where it did not state one. Null in each of
     * these descriptive fields means THE SERVER DID NOT SAY, and the probe is
     * still `ok` (Owen, 2026-09-24: *"if it can make the call to the crucible
     * server then it should work"*); the screen draws only what was said.
     */
    version: string | null;
    /** `cuda-linux`, `mlx-darwin`. Windows is never a backend. Null where not stated. */
    backend: string | null;
    /** The card, in the server's own words, or null where it gave none. */
    gpu: string | null;
    /**
     * HOW BIG THAT CARD IS, as a number — the third of the three things Owen
     * asked a person be told about an engine (2026-09-15: *"the GPU it's
     * connected to and how powerful it is"*).
     *
     * A NUMBER AND NOT A PHRASE, because this file is the wire and the wording
     * belongs to the screen (`core/crucible-words.ts` states that rule for
     * everything a person reads about a server). `gpu` beside it is already a
     * borderline case and stays as it is only because the server itself is the
     * one naming the card.
     *
     * 0 for a host that declared none, which is a real answer — an engine can
     * be running on a machine whose accelerator the probe could not size — and
     * the screen draws the name alone rather than "0.0 GB". Null where the server
     * sent no figure at all, drawn the same way.
     */
    vramBytes: number | null;
    /**
     * THE ORCHESTRATOR THIS ANSWER CAME THROUGH, or null for an address that is
     * the engine itself.
     *
     * crucible docs/PHASE17-ORCHESTRATOR.md §6: a registered address may be an
     * orchestrator, which serves no job types and manages exactly one engine.
     * Every other field above is the ENGINE's — that is the machine the work
     * runs on and the card whose name a person wants — so this is the half of
     * the sentence they would otherwise not be told, and it names both.
     *
     * A PRESENT NULL RATHER THAN AN ABSENT KEY, on this wire's standing rule:
     * "there is no orchestrator" is a statement about the machine, and the card
     * draws a line for it or does not.
     */
    via: string | null;
  }
  | {
    /**
     * Everything else, in the SDK's own sentence.
     *
     * One arm rather than one per error type, deliberately: the card prints the
     * sentence and offers nothing to press, so five arms would be five spellings
     * of the same row. The SDK's errors already name what to fix ("crucible at X
     * is unreachable", "crucible refused the token"), and replacing one of those
     * with a word of ours is how a fixable problem becomes an unfixable one. The
     * dispatcher, which has to ACT differently per error, switches on the SDK's
     * error types instead of on this.
     */
    outcome: 'failed';
    message: string;
  };

/**
 * WHAT PRESSING "Start Crucible" CAME TO.
 *
 * ── Why there is no `failed` arm, and a sentence instead ──────────────────
 *
 * Because the interesting outcome is neither started nor failed. Launching the
 * tray SUCCEEDS long before the engine answers — on Windows the tray has to
 * claim its engine and wait for a systemd unit inside a WSL guest that may be
 * cold — so a run that timed out waiting has still done the thing it was asked
 * to do, and calling that a failure would send somebody to fix a machine that is
 * two seconds from working. `started` is "an engine is answering NOW"; `detail`
 * is what to tell them either way, already a whole sentence.
 */
export interface CrucibleStartResult {
  started: boolean;
  detail: string;
}

/**
 * What "Add local Crucible" answered — the entry it made, or why it could not.
 *
 * THE TOKEN IS NOT IN HERE. The whole point of reading the local server's own
 * `config.toml` is that the file is the single owner of that token (BookForge
 * reached this first and paid for the lesson: a copied token goes stale the next
 * time `crucible init --force` runs, and the first symptom is a 401 with nothing
 * saying why). Main reads the file, writes the entry, and answers with the view;
 * nothing about the token crosses the preload, and no second copy is kept beyond
 * the entry the person can see.
 *
 * IT IS ALSO THE PAIRING FILE'S ANSWER (`crucible:add-from-pairing-file`, Wave
 * 62 / PHASE15-HOST.md §3.6 and §5.1), and REUSED rather than copied because the
 * two doors say the same three things: an entry was made, or there is nothing on
 * this machine, or there is something here that cannot be read. `configPath` is
 * the pairing file's own path for that door, which is what "the file the token
 * came out of" means on either road.
 */
export type LocalCrucibleAdd =
  | { outcome: 'added'; servers: CrucibleServerView[]; serverName: string; url: string; configPath: string }
  | { outcome: 'failed'; code: LocalCrucibleFailure; message: string };

/**
 * Why the local server could not be read. Each is a different thing to do about
 * it, which is why they are told apart rather than collapsed into one sentence.
 */
export type LocalCrucibleFailure =
  /**
   * No config.toml where the local server would keep one — and, for the pairing
   * door, NO PAIRING FILE. A STATE, not a fault: PHASE15-HOST.md §3.6 is explicit
   * that *"an absent file means 'no local server' — a fact the app shows, not a
   * fallback it fills"*, and both roads reach the same sentence about the same
   * machine, so a second code for it would be two names for one silence.
   */
  | 'no_local_config'
  /** Windows, and nothing has said which WSL distro to look in. */
  | 'no_wsl_distro'
  /** `wsl.exe` would not run, or the guest failed for some other reason. */
  | 'wsl_read_failed'
  /**
   * The file is there and is not something this reader understands — a config.toml
   * that will not parse, or a pairing file whose line the SDK's `parsePairing`
   * refuses (`invalid_pairing`, PHASE13-OPERATOR.md §2.1). Somebody's to fix,
   * which is why it is told apart from the absence above.
   */
  | 'config_unreadable'
  /** It parses and lacks a key the server itself requires. */
  | 'config_missing_key'
  /** It reads, and an entry for that address is already in the registry. */
  | 'already_registered';

/**
 * WHAT A PASTED CONNECT CODE SAYS BEFORE ANYBODY PRESSES ANYTHING — the preview
 * that fills the Name and Address boxes as a person pastes.
 *
 * PHASE15-HOST.md §5.1 way 2, through the SDK's `parsePairing`. Owen's words for
 * it are BookForge's words for it: a **connect code**, never "pairing line" — the
 * line is what Crucible calls the thing it prints, and the two apps say one word
 * to the person who pastes it.
 *
 * ── THERE IS NO TOKEN ON THIS WIRE, AND THAT IS THE WHOLE SHAPE ─────────────
 *
 * The code carries one, and the renderer never receives it back. The person
 * TYPED the line, so they hold it already — but the standing rule is that the
 * renderer never holds a credential it did not type INTO A FIELD FOR THAT
 * PURPOSE, and a preview answer carrying a token would put one in a signal, a
 * change-detection pass and anything that ever logs a component's state. So the
 * line goes one way into main (`crucible:parse-connect-code`), main answers with
 * the name and the address only, and the token stays on main's side of the
 * preload for `crucible:test-connect-code` and `crucible:add-connect-code` —
 * which take the LINE again rather than a token handed back and forth.
 */
export type ConnectCodePreview =
  | { outcome: 'read'; name: string; url: string }
  /** The SDK's own `invalid_pairing` sentence, with the fragment already elided. */
  | { outcome: 'refused'; message: string };

/**
 * Everything the Servers card draws in one read.
 *
 * One shape rather than three calls because the three answers are one picture
 * and a card assembled from three round trips draws a list that disagrees with
 * its own slot preview for a frame.
 */
export interface CrucibleSettingsView {
  servers: CrucibleServerView[];
  /** The slot list as it stands — what the pickers will show. */
  slots: ComputeSlot[];
  newJobsWaitFor: NewJobsWaitFor;
  /**
   * THE LIVE QUEUE'S OWN MACHINE — {@link GPU_DIAL_ANY} or a server's name.
   *
   * Beside the slot list rather than in a read of its own, because the control
   * that sets it is a picker OVER that list: a screen that read the dial and the
   * slots separately could draw a dial naming a server its own list does not
   * have, which is the state the picker exists to let somebody out of.
   */
  queueGpuDial: string;
  /**
   * The WSL distro the local-Crucible read looks in. Empty means unset, and
   * unset is refused rather than defaulted: *"the default distro"* is whatever
   * `wsl --set-default` last said, and a server read from the wrong guest is a
   * wrong server. Only meaningful on Windows.
   */
  wslDistro: string;
  /**
   * Hosted, the slot list is the HOST's and this window neither adds nor removes
   * one (docs/SLOTS.md §3). The card draws the list read-only and says so.
   */
  hosted: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLOUD PROVIDERS — Package F's app half (Owen, 2026-09-14)
//
// *"give them the option of connecting an api key for openai or claude instead
// of using the 27b or the 9b. if the user wants to they can use usage credits
// from a cloud model… for weaker systems."*
//
// A provider is a SLOT (docs/SLOTS.md §3): never busy, nothing resident, text
// acts only, and a DELIBERATE per-job choice. Everything in this section is the
// wire half of that; the key itself is in `AppSettings.cloudProviders` and never
// crosses, exactly as a Crucible's token does not.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH WIRE THE PROVIDER SPEAKS — and it is the engine's `--server` value, not
 * a brand.
 *
 * The engine has three doors (docs/VLLM.md §2) and only two of them are ever on
 * the other end of one of these: `openai`, which is OpenAI's own API and equally
 * any OpenAI-compatible host somebody points at, and `anthropic`, which is a
 * different wire end to end (`POST /v1/messages`, a top-level `system`,
 * `x-api-key`). `ollama` is not here because an Ollama is the LOCAL slot and has
 * no key.
 *
 * IT IS THE KIND THAT DECIDES THE CREDENTIAL HEADER, which is why this is a
 * declared field on the entry rather than something sniffed out of the URL: a
 * proxy in front of either, or a self-hosted gateway, would be guessed wrong,
 * and what a wrong guess costs is a 401 with nothing saying why.
 */
export type CloudProviderKind = 'openai' | 'anthropic';

/** The name a person reads, per kind. Spelled once so every surface agrees. */
export const CLOUD_PROVIDER_LABEL: Readonly<Record<CloudProviderKind, string>> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

/**
 * THE PROVIDER'S OWN ADDRESS, used whenever an entry names none.
 *
 * `openai` carries `/v1` and `anthropic` does not, and that difference is the
 * two engine doors' own normalisation rather than an inconsistency here: the
 * OpenAI door appends `/v1` to an endpoint that lacks one
 * (`normaliseVllmEndpoint`, src/translate/vllm.ts) and the Anthropic door STRIPS
 * a trailing version before composing `/v1/messages`
 * (`normaliseAnthropicEndpoint`). Spelling each the way its own door wants it is
 * what makes the Test in main and the run in the engine ask the same server.
 */
export const CLOUD_PROVIDER_ENDPOINT: Readonly<Record<CloudProviderKind, string>> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/**
 * WHAT GOES IN THE MODEL BOX BEFORE ANYBODY TYPES — a PLACEHOLDER, and the
 * distinction is the whole reason this is not a catalog.
 *
 * Hosted model line-ups change monthly: a list compiled into this build would be
 * wrong by the next release and confidently so, offering models that have been
 * retired and hiding the one somebody is paying for. So the field is free text,
 * the placeholder is one plausible id per provider, and the PROOF is the Test
 * button — which lists `/v1/models` at the provider and says whether the id in
 * the box is among them. The engine keeps the same posture: `--model` is
 * REQUIRED on both cloud doors, because a provider holds a catalog and there is
 * no default to fall back on.
 */
export const CLOUD_PROVIDER_MODEL_HINT: Readonly<Record<CloudProviderKind, string>> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
};

/**
 * THE SENTENCE THAT HAS TO BE UNDER THE KEY FIELD, and it is a rule rather than
 * a nicety.
 *
 * Everything else in this app runs on hardware the person is standing next to.
 * A cloud slot is the one place where pressing Translate sends somebody's book
 * to a company, and the card says so in as many words beside the box where the
 * key is typed — before the choice, not in a changelog. Declared here so the
 * settings card and any later surface cannot word it differently.
 */
export const CLOUD_KEY_SENTENCE =
  'Text you translate, simplify, clean or analyse is sent to that provider.';

/**
 * ONE CONFIGURED PROVIDER, AS THE RENDERER IS ALLOWED TO SEE IT.
 *
 * `keySet` is where the stored entry has the key — `CrucibleServerView.tokenSet`
 * exactly, for the same reason and with the same consequence: this shape is what
 * crosses the preload, so a renderer cannot leak a credential it was never told.
 */
export interface CloudProviderView {
  /** What the picker calls it, and what a row's `waitFor` names. Unique. */
  name: string;
  kind: CloudProviderKind;
  /** The provider's model id, as the person typed it. Never validated against a list. */
  model: string;
  /**
   * An OpenAI-compatible host, or EMPTY for the provider's own address.
   *
   * Empty rather than the resolved default, so that the card can show the
   * default as a placeholder and a person can tell "I have not chosen" from "I
   * have chosen the same thing the default is". {@link CLOUD_PROVIDER_ENDPOINT}
   * is what empty resolves to, at the placement.
   */
  endpoint: string;
  /** Off is not a slot at all: no picker entry, and nothing lit in the dock. */
  enabled: boolean;
  /** Whether a key is stored. The key itself never crosses this wire. */
  keySet: boolean;
}

/**
 * One entry as the Cloud providers card hands it back. The whole array is sent
 * and replaces the whole list, on `CrucibleServerEdit`'s argument exactly: four
 * of the five edits are the same operation on an array, and two writers of one
 * list is how a save loses half of a gesture.
 */
export interface CloudProviderEdit {
  name: string;
  kind: CloudProviderKind;
  model: string;
  endpoint: string;
  enabled: boolean;
  /**
   * A NEW key, or `null` to keep whatever is stored.
   *
   * Write-only in both directions, {@link CrucibleServerEdit.token}'s rule word
   * for word — and the match against the stored list is by NAME, so a rename and
   * a new key in one gesture is the one case the card must send a key for.
   */
  apiKey: string | null;
}

/** Everything the Cloud providers card draws in one read. */
export interface CloudSettingsView {
  providers: CloudProviderView[];
  /** The slot list as it stands — cloud entries included, after the Crucibles. */
  slots: ComputeSlot[];
  /**
   * Hosted, the slot list is the HOST's and this window neither adds nor removes
   * one (docs/SLOTS.md §3) — so the card draws read-only and main refuses the
   * write, exactly as the Servers card does.
   */
  hosted: boolean;
}

/**
 * WHAT `Test` LEARNED — the model listing, and whether the chosen id is in it.
 *
 * ── Why a listing and not a completion ──────────────────────────────────────
 *
 * A test that generated a token would cost money to answer a question about
 * whether a key works, and would still not say whether the MODEL is one this key
 * may use. `GET /v1/models` answers both in one unbilled request: a 401 is the
 * key, and an id missing from `models` is the model.
 *
 * `chosen` IS SEPARATE FROM `outcome`, because a key that works and a model that
 * is not on the account are different news with different fixes, and a card that
 * folded them into one failure would send somebody to re-paste a working key.
 */
export type CloudProbe =
  | {
    outcome: 'ok';
    /** Every id the provider listed, in the order it listed them. */
    models: string[];
    /** The id the entry names — echoed so the card's sentence cannot drift. */
    chosen: string;
    /** Is `chosen` among `models`? False is a warning, never a refusal to save. */
    chosenListed: boolean;
  }
  | {
    /** Unreachable, refused, or an answer this reader could not parse. */
    outcome: 'failed';
    message: string;
  };

// ─────────────────────────────────────────────────────────────────────────────
// "Install Crucible here" — the sequence, and the seam that will run it
// (electron/crucible-install.ts; docs/SETUP.md)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of the install's PROGRESS LIST (crucible PHASE19 §3.1), or one of the
 * elevated commands beside it.
 *
 * `command` IS ALWAYS NULL on a progress row and PHASE19 §0 is why: *"Nobody is
 * ever shown a command."* The field survives because `elevated` shares this
 * shape, and `elevated` is empty on every platform — see
 * `electron/crucible-install.ts`, which no longer composes one either.
 *
 * `id` is what an event names when it says a row began; the LABEL is never
 * matched, so the wording can change without moving the wire
 * (shared/crucible-install-wire.ts). `done` is only ever true for a step this
 * app can actually CHECK, and the live state of a row during a run is the
 * reducer's, not this field's.
 */
export interface CrucibleInstallStep {
  /** Which row of shared/crucible-install-wire.ts's list this is. */
  id: CrucibleInstallRowId;
  title: string;
  detail: string;
  /** Null on every progress row. Kept for `elevated`, which is empty. */
  command: string | null;
  /** True only when this app has verified it. See the note above. */
  done: boolean;
}

/**
 * THE THREE PLATFORMS THE SEQUENCE DIFFERS BY, AND A WORD FOR THE REST.
 *
 * `NodeJS.Platform` would be the exact type and is deliberately not used: this
 * file is imported by the RENDERER, whose tsconfig carries no node types, and a
 * shared shape that only compiles in main is a shape that will be moved here and
 * then moved back. The three names are the three the plan actually branches on —
 * a WSL guest, a launchd agent, a systemd user unit — and `other` is a platform
 * Crucible has no backend for, which the plan says in as many words rather than
 * drawing a sequence nobody can run.
 */
export type InstallPlatform = 'win32' | 'darwin' | 'linux' | 'other';

/** What `wsl.exe -l -v` said. Empty with a sentence when it could not be asked. */
export interface WslDistroFacts {
  /** WSL2 distributions only — WSL1 has no GPU passthrough, so it is not a candidate. */
  distros: string[];
  /** The one wsl.exe marks with `*`, or null. Never used as a default: see `wslDistro`. */
  default: string | null;
  /** One sentence, whether it worked or not. */
  detail: string;
}

/**
 * EVERYTHING THE "INSTALL CRUCIBLE HERE" DOOR DRAWS.
 *
 * One read, composed in main, for the same reason `CrucibleSettingsView` is:
 * the platform branch, the WSL probe and the step list are one picture, and a
 * screen that asked for them separately would draw a Windows sequence beside a
 * "no WSL found" that had not arrived yet.
 */
export interface CrucibleInstallPlan {
  platform: InstallPlatform;
  /** win32 only; null elsewhere, where there is no guest to install into. */
  wsl: WslDistroFacts | null;
  /** The hardware probe's own sentence about this machine. */
  machine: string;
  /** The sequence, in order. */
  steps: CrucibleInstallStep[];
  /**
   * The commands that need a privilege this app does not have — elevation, a
   * reboot, sudo. Listed APART from the sequence, because `@crucible/bootstrap`
   * draws the same line: it refuses by name and hands the command over rather
   * than attempting it. Empty on macOS, which needs neither.
   */
  elevated: CrucibleInstallStep[];
  /** Crucible's own README — the argument behind the sequence. */
  readme: string;
  /** Whether this platform supports installing from this standalone window. */
  driven: boolean;
  /** The sentence the disabled button wears. Always set, whether driven or not. */
  drivenWhy: string;
}

/**
 * Is this URL's host the machine it is read on?
 *
 * Shared because two programs ask it: the board, to decide which lane is this
 * machine's own card (`localLane`, shared/queue-board.ts), and main, to tell a
 * local entry from a remote one for the doors that are genuinely about locality
 * — the Uninstall, and the read of this machine's own `config.toml`. It used to
 * decide whether an entry HID the local slot, and there is no local slot now.
 * `0.0.0.0` and `::` are in the set because they
 * are bind addresses that a person pastes out of a config file, and a client
 * that dialled either of them would be dialling this machine.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host.endsWith('.localhost');
}

/**
 * The slot a row's `waitFor` names, or null when nothing in the list does.
 *
 * Null is NOT an error here and the callers read it as two different facts: the
 * dispatcher reads it as "the row is waiting for a slot that is switched off or
 * gone" and holds the row saying so, and the picker reads it as "draw the stored
 * name greyed, beside the live ones" so that a person can see what their row is
 * actually waiting for before they change it.
 */
export function slotNamed(slots: readonly ComputeSlot[], name: string): ComputeSlot | null {
  return slots.find((slot) => slot.name === name) ?? null;
}
