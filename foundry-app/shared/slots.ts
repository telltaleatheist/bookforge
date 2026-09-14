/**
 * SLOTS — the places a job's compute can go, as both programs name them.
 *
 * The plan of record is docs/SLOTS.md, and Owen's sentence is the whole design:
 * *"the friend sees a single gpu slot if theyre local — their GPU slot. if
 * theyre using crucible on their local machine, the local GPU disappears… or
 * they can add a remote crucible server, like to the mac… itll show the mac's
 * gpu slot as open and usable, plus their local GPU."*
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

/**
 * The value of a row's `waitFor` that means "the first slot that will take it".
 *
 * A RESERVED NAME rather than `null` or an absent field, because absent already
 * means something else on `Job.waitFor`: a row minted before this existed, or by
 * a host that has not re-vendored, which falls back to the standing default
 * (`AppSettings.newJobsWaitFor`) rather than to any particular slot. The
 * registry refuses a server called this, so the two can never be confused.
 */
export const ANY_SLOT = 'any';

/**
 * What the machine's own GPU is called in the picker.
 *
 * It is a NAME and not a `kind` test at the call sites for one reason: a row's
 * `waitFor` is a string, it is written down the moment somebody picks it, and it
 * has to keep meaning the same thing afterwards. The registry refuses a server
 * with this name for the same reason it refuses {@link ANY_SLOT}.
 */
export const LOCAL_SLOT_NAME = 'This computer';

/**
 * Whose compute a slot is.
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
export type ComputeSlotKind = 'local' | 'crucible' | 'cloud';

/** One place a job's compute can go. */
export interface ComputeSlot {
  /**
   * What a row's `waitFor` names, and what every sentence about the wait says.
   * Unique across the list: the local slot's is {@link LOCAL_SLOT_NAME} and a
   * Crucible slot's is the registry entry's own name.
   */
  name: string;
  kind: ComputeSlotKind;
  /**
   * A Crucible slot's base URL, without `/v1` — for the settings row, for the
   * "unreachable" sentence, and for composing the engine's `--endpoint`. Absent
   * on the local slot, which has no one address: its text acts go to Ollama and
   * its page reading to whatever the reader owns.
   *
   * ── AND DELIBERATELY ABSENT ON A CLOUD SLOT, WHICH DOES HAVE ONE ───────────
   *
   * A cloud provider has an address (the provider's own, or an
   * OpenAI-compatible host somebody named) and it is NOT put here, because this
   * field is read for one thing besides drawing: `localLane`
   * (shared/queue-board.ts) decides which lane is THIS MACHINE'S CARD by asking
   * whether a lane's url is loopback. An OpenAI-compatible endpoint at
   * `http://localhost:8000/v1` is a perfectly ordinary thing to configure, and a
   * cloud slot that carried it would be adopted as the local lane — so a page
   * reading, which loads dots on this machine's GPU whatever the registry says,
   * would hold the cloud provider's lane and leave the card unguarded. The
   * address lives on the provider entry, where the settings card reads it; the
   * placement composes `--endpoint` from there.
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
   * claiming otherwise. A loopback entry that is enabled HIDES the local slot —
   * Owen: *"if theyre using crucible on their local machine, the local GPU
   * disappears"* — one card, one owner.
   */
  loopback: boolean;
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
    version: string;
    /** `cuda-linux`, `mlx-darwin`. Windows is never a backend. */
    backend: string;
    /** The card, in the server's own words. */
    gpu: string;
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
 * What "Add local Crucible" answered — the entry it made, or why it could not.
 *
 * THE TOKEN IS NOT IN HERE. The whole point of reading the local server's own
 * `config.toml` is that the file is the single owner of that token (BookForge
 * reached this first and paid for the lesson: a copied token goes stale the next
 * time `crucible init --force` runs, and the first symptom is a 401 with nothing
 * saying why). Main reads the file, writes the entry, and answers with the view;
 * nothing about the token crosses the preload, and no second copy is kept beyond
 * the entry the person can see.
 */
export type LocalCrucibleAdd =
  | { outcome: 'added'; servers: CrucibleServerView[]; serverName: string; url: string; configPath: string }
  | { outcome: 'failed'; code: LocalCrucibleFailure; message: string };

/**
 * Why the local server could not be read. Each is a different thing to do about
 * it, which is why they are told apart rather than collapsed into one sentence.
 */
export type LocalCrucibleFailure =
  /** No config.toml where the local server would keep one. A STATE, not a fault. */
  | 'no_local_config'
  /** Windows, and nothing has said which WSL distro to look in. */
  | 'no_wsl_distro'
  /** `wsl.exe` would not run, or the guest failed for some other reason. */
  | 'wsl_read_failed'
  /** The file is there and is not something this reader understands. */
  | 'config_unreadable'
  /** It parses and lacks a key the server itself requires. */
  | 'config_missing_key'
  /** It reads, and an entry for that address is already in the registry. */
  | 'already_registered';

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
 * THE WHEEL, NAMED ONCE.
 *
 * Crucible's server is published as a wheel on its GitHub release, and the
 * version here is the same 0.5.0 that `@crucible/client` is pinned to in
 * `app/package.json` — the SDK, the bootstrap package and the server are cut
 * together and their versions are the same number by design. Written here rather
 * than in the install module because the sequence a person copies and the
 * sequence `@crucible/bootstrap` would run must name the same file, and two
 * spellings of a filename is how they stop doing that.
 */
export const CRUCIBLE_WHEEL =
  'https://github.com/telltaleatheist/crucible/releases/download/v0.5.0/crucible-0.5.0-py3-none-any.whl';

/**
 * One numbered step of the hand sequence, or one of the elevated commands beside
 * it.
 *
 * `command` IS NULL FOR A STEP WITH NOTHING TO TYPE — "come back here and press
 * the button" is a step, and giving it an empty command string would draw an
 * empty code box under it. `done` is only ever true for a step this app can
 * actually CHECK, which today is exactly one: whether a WSL2 distribution
 * exists. Every other step is something only the machine it runs on knows the
 * outcome of, and a checkbox that guessed would be worse than no checkbox.
 */
export interface CrucibleInstallStep {
  title: string;
  detail: string;
  /** The exact line to run, complete and copyable, or null. */
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
  /** The release wheel the sequence installs. {@link CRUCIBLE_WHEEL}. */
  wheel: string;
  /**
   * Whether the driven install can run. FALSE ON EVERY MACHINE TODAY —
   * `@crucible/bootstrap` is released with Crucible's next version and is
   * deliberately not a dependency until it exists.
   */
  driven: boolean;
  /** The sentence the disabled button wears. Always set, whether driven or not. */
  drivenWhy: string;
}

/**
 * Is this URL's host the machine it is read on?
 *
 * Shared because two programs ask it: main, to decide whether an entry hides the
 * local slot, and the settings card, to draw the "this replaces your local GPU
 * slot" line as somebody types. `0.0.0.0` and `::` are in the set because they
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
