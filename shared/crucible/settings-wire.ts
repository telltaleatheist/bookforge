/**
 * The shapes the Crucible Servers settings row sends across the IPC seam.
 *
 * Types only. The main process owns the registry (`electron/crucible/servers.ts`)
 * and the rank/enable record (`routing.ts`); the renderer owns neither and must
 * not re-spell them, so the wire lives here, once, and both sides import it —
 * the same rule `shared/vlm/conversion.ts` and `shared/processing/pass-types.ts`
 * already follow.
 *
 * Nothing here carries a token. {@link CrucibleServerRow.tokenMasked} is
 * `****<last 4>`, which is enough to tell two tokens apart and not enough to use
 * one — the registry's listing type is structurally unable to carry the
 * plaintext (see `servers.ts`), and this wire keeps that property rather than
 * re-earning it.
 */

import type { CapabilityWork, ContextCeiling } from '@crucible/client';

// ─────────────────────────────────────────────────────────────────────────────
// The list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH DOOR A CRUCIBLE FOUND ON THIS COMPUTER CAME THROUGH.
 *
 * Not a property of a SERVER — since Owen's ruling of 2026-09-15 every server is
 * a registry entry and nothing else. This is a property of the offer the add
 * form is prefilled from (`electron/crucible/discovery.ts`), shown so a person
 * can see where the address and the key came from before they accept it.
 *
 *  - `pairing` — the connect code the engine (or the Windows host) wrote beside
 *    its own config, crucible `docs/PHASE15-HOST.md` §3.6. **The contract's
 *    door**, and the one that needs no WSL and no typing.
 *  - `file` — its `config.toml`, read directly. macOS and Linux.
 *  - `wsl` — its `config.toml`, read through `wsl.exe`. **The LEGACY door**,
 *    dated: §3.6 says it "is how the WSL server gets registered" until a host
 *    exists on the machine, "and that door is deleted when the host lands".
 */
export type CrucibleDiscoveryVia = 'pairing' | 'file' | 'wsl';

/**
 * A CRUCIBLE FOUND ON THIS COMPUTER, as the add door draws it.
 *
 * An OFFER, not a server: it is what the registry entry would look like if the
 * operator accepted it. Nothing routes through it, nothing ranks it, and it is
 * not in {@link CrucibleServersView.servers} until it has been added.
 */
export type DiscoveredCrucibleRow =
  | {
      present: true;
      /** `[server] name`, or the connect code's name, e.g. `crucible@example-pc-wsl`. */
      serverName: string;
      url: string;
      tokenMasked: string;
      /** The file this was read from; prefixed `<distro>:` when read through WSL. */
      configPath: string;
      via: CrucibleDiscoveryVia;
      /**
       * The name it is ALREADY registered under, when a registry entry has this
       * URL. `null` when nothing does, which is when there is something to add.
       */
      registeredAs: string | null;
    }
  | {
      present: false;
      /** `no_local_config`, `no_wsl_distro`, … — a NAMED state, never an outage. */
      code: string;
      /** The sentence, which carries the fix. Shown as the row's state. */
      reason: string;
    };

/** One registered server, as the row draws it. Wherever it runs. */
export interface CrucibleServerRow {
  name: string;
  url: string;
  tokenMasked: string;
  /** ISO 8601. */
  added: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rank and enablement (crucible docs/PHASE7-LANES.md section 4.2.2)
// ─────────────────────────────────────────────────────────────────────────────

/** What a NEW queue row's `waitFor` is written as (§4.2.1a). */
export type WaitForDefault = 'top-ranked' | 'any';

/** One server's place in the queue's order. Rank is the index — there is no number. */
export interface RankedServerRow {
  name: string;
  enabled: boolean;
}

/** The rank/enable record resolved against the servers that exist. */
export interface RoutingView {
  /** Every registered server, best first. There is no other kind. */
  ranked: RankedServerRow[];
  newJobsWaitFor: WaitForDefault;
  /*
   * There was a `legacyLocalRender` here — the ONE switch that ran renders and
   * text passes with the local engines instead. The layer it turned on is
   * DELETED (docs/LEGACY-REMOVAL.md); a record on disk that still carries the
   * key is stripped on read and said once, by name (`crucible/routing.ts`).
   * Every act is now a Crucible server or a named refusal.
   */
  /**
   * Names the record mentions that no server answers to any more. Reported with
   * the name, never pruned behind the operator's back.
   */
  unknown: string[];
}

/** Everything the settings row draws before it probes anything. */
export interface CrucibleServersView {
  /** Every registered server. One list, one kind of row. */
  servers: CrucibleServerRow[];
  /**
   * A Crucible on THIS computer that the add form can be prefilled from, or the
   * named reason there is none. It is an offer and never a row in
   * {@link servers} — see {@link DiscoveredCrucibleRow}.
   */
  discovered: DiscoveredCrucibleRow;
  routing: RoutingView;
}

// ─────────────────────────────────────────────────────────────────────────────
// What a server says about itself
// ─────────────────────────────────────────────────────────────────────────────

/** `GET /v1/info` + `GET /v1/health`, as one answer. */
export interface ServerFacts {
  /** What the server calls itself — not the name this machine files it under. */
  serverName: string;
  version: string;
  apiVersion: number;
  platform: string;
  arch: string;
  /** `cuda-linux` or `mlx-darwin`. Windows is never a backend. */
  backend: string;
  gpu: { vendor: string; name: string; vramBytes: number };
  /** What this server will accept as a job `type`. */
  jobTypes: string[];
  /** The lane, right now. */
  health: 'ok' | 'warming' | 'busy';
  queueDepth: number;
  /** The ids on the card, and what KIND holds it (`llm`, `tts`, … or null). */
  residentModels: string[];
  residentKind: string | null;
}

/**
 * What a Test found, as one of the answers the two-step probe can distinguish.
 *
 * `ping` is unauthenticated and `info` is not, which is the whole reason the
 * button calls both: the pair tells "nothing there" from "not a Crucible" from
 * "wrong token" (crucible docs/PHASE5-APPS.md section 2), and every one of those
 * has a different fix.
 */
export type CrucibleProbeResult =
  | { outcome: 'ok'; facts: ServerFacts }
  /** Nothing answered at that address. */
  | { outcome: 'unreachable'; message: string }
  /** Something answered and it is not a Crucible. */
  | { outcome: 'not_a_crucible'; message: string }
  /** A Crucible answered `ping` and refused the token. */
  | { outcome: 'wrong_token'; message: string }
  /** The server and this client do not speak the same API version. */
  | { outcome: 'version_mismatch'; message: string }
  /** Any other named refusal — the registry's or the server's. */
  | { outcome: 'refused'; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// The operator door (crucible docs/PHASE13-OPERATOR.md sections 5.1, 5.3, 5.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one pasted `crucible://` line becomes: the three fields the connect
 * door already has.
 *
 * The line is read by the SDK's `parsePairing` IN MAIN, not here, and that is
 * not a layering preference — the renderer has no `@crucible/client` and the
 * producer of these lines is `crucible/pairing.py`, so a second parser written
 * against a format doc would be the two-owners defect in the one place the
 * format exists to prevent it (PHASE13 §2.1: a line whose meaning depends on
 * which parser read it is not a format).
 */
export interface PairingFields {
  name: string;
  url: string;
  token: string;
}

/**
 * A pasted line that is not a pairing line, refused by name.
 *
 * `invalid_pairing` is shown VERBATIM and nothing is filled (§5.1). The
 * `detail` is the SDK's own sentence about what was wrong with the shape — it
 * never contains the token, which `parsePairing` elides before it throws.
 */
export interface PairingRefusal {
  code: 'invalid_pairing';
  detail: string;
}

/** Either three fields, or the named refusal. Never a half-filled form. */
export type PairingResult =
  | { ok: true; fields: PairingFields }
  | { ok: false; refusal: PairingRefusal };

/**
 * One frame of the `module` task a server runs for BookForge.
 *
 * Nothing posts one on a button any more (crucible
 * `docs/PHASE14-ENVPACKS.md` §4a): it is posted by
 * `electron/crucible/coordinate.ts` when a READ of that server's catalog says
 * something is missing, and this shape travels inside
 * {@link CrucibleCoordinationState}'s `preparing`.
 *
 * Every field is a different kind of fact and they are separate for that
 * reason: `line` is the installer's own output and is NOT load-bearing
 * (crucible ARCHITECTURE.md R4), `bytes` is a pull's counts and is, and `step`
 * is the only thing that says where in the module this is.
 */
export interface CrucibleModuleProgress {
  /** The registry name of the server this task is running on. */
  server: string;
  taskId: string | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** `{name, index, total}` — for a module, one per entry plus the reload. */
  step: { name: string; index: number; total: number } | null;
  /** One line of pip's output. Draw it, never branch on it. */
  line: string | null;
  /** A pull's byte counts. `total` is null where no manifest sizes it. */
  bytes: { done: number; total: number | null; file: string } | null;
  /** A module entry that was already true. Idempotence, reported. */
  skipped: string | null;
  /**
   * What the server offers after its reload step — the client is TOLD rather
   * than having to diff two `/v1/info` reads (§3.4). Null until that step.
   */
  jobTypes: string[] | null;
  /** The `failed` event's own code and message. Completed steps STAY (R6). */
  error: { code: string; message: string } | null;
  /**
   * WHAT THE SERVER ITSELF SAID WAS UNMET — `TaskStatus.unmet` (crucible
   * `docs/PHASE15-HOST.md` §5.3a), read once when the stream ends.
   *
   * `null` UNTIL THE TASK IS TERMINAL, and that is not the same as `[]`. The
   * events say nothing about unmet classes — the field is on the task
   * document, not on a frame — so a running task genuinely has no answer here,
   * and an empty array in its place would say "this engine serves everything
   * BookForge asked for" before the engine had been asked.
   *
   * IT IS THE ENGINE'S ANSWER, NOT THIS APP'S PREDICTION. The `unmet` on
   * {@link CrucibleCoordinationState} is what BookForge worked out from the
   * capability record a moment BEFORE posting; this is what the server reports
   * having resolved every class through that same record. They should agree,
   * and where they do not the SERVER is right — it is the thing that did the
   * resolving (crucible PHASE9: the capability record is the one place a class
   * is resolved).
   */
  unmet: { class: string; reason: string }[] | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Models, and what is happening right now
// ─────────────────────────────────────────────────────────────────────────────

/** One row of `GET /v1/models`: four separate facts, plus the reason for a no. */
export interface CrucibleModelRow {
  id: string;
  family: string;
  paramsB: number;
  backendSupported: boolean;
  installed: boolean;
  resident: boolean;
  loadable: boolean;
  /** Always present when `loadable` is false — a refusal with no reason is a bug. */
  reason?: string;
  /** Weights plus KV at the default context, measured on the host. */
  memoryBytesEstimate: number | null;
}

/** One job on a server, as a bench reads it. */
export interface ActivityJobRow {
  jobId: string;
  type: string;
  model: string | null;
  status: string;
  /** 0..1. A job HAS a denominator: the client posted the whole of the work up front. */
  progress: number;
  message: string | null;
  /** The submitting client's User-Agent, or null when it did not say. */
  client: string | null;
}

/**
 * The open streaming session. **`progress` is not here and never will be**
 * (crucible docs/PHASE7-LANES.md section 5.1): a reader's rows arrive one `say`
 * at a time, so a percentage would be a percentage of whatever happens to have
 * arrived — a number that goes DOWN. Draw the counts.
 */
export interface ActivityStreamRow {
  sessionId: string;
  voice: string;
  since: string;
  client: string | null;
  said: number;
  finished: number;
  inFlight: number;
  seconds: number;
}

/** `GET /v1/activity`, as the row draws it. */
export interface CrucibleActivityView {
  serverName: string;
  uptimeS: number;
  resident: { kind: string; id: string; since: string } | null;
  /** The id of a model being loaded right now, or null. */
  warming: string | null;
  /** Who holds narrator's wire. Not the lane — a stream holds this and not that. */
  claimedBy: string | null;
  streaming: ActivityStreamRow | null;
  chatInFlight: number;
  slot: {
    busy: number;
    of: number;
    queueDepth: number;
    /**
     * The server's own composition of "the lane is free AND nobody holds the
     * card". **Never a reservation** — reading it is not permission to submit;
     * only `POST /v1/jobs` can say yes.
     */
    acceptsWork: boolean;
  };
  running: ActivityJobRow[];
  queued: ActivityJobRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Which Crucible model each text act runs on (docs/CRUCIBLE_ROLLOUT_PLAN 2.6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four acts, exactly as crucible's `capability.py` names its capability
 * classes — Owen's ruling of 2026-09-13: *"they can't lie to the user and say a
 * translate job is running when it's actually a simplify job."*
 *
 * Spelled here for the renderer and in `electron/crucible/text-acts.ts` for the
 * main process, which is two copies of one fact — so the keeper
 * `tools/test-crucible-text-acts.js` asserts they agree, and that both agree
 * with crucible's own file.
 */
export const CRUCIBLE_TEXT_ACT_NAMES = ['clean', 'translate', 'simplify', 'analysis'] as const;

export type CrucibleTextActName = (typeof CRUCIBLE_TEXT_ACT_NAMES)[number];

/*
 * `CrucibleTextActModels` IS DELETED, and so is the record it described
 * (2026-09-14, `<userData>/crucible-models.json`).
 *
 * Owen ruled it with Foundry (docs/CRUCIBLE_ROLLOUT_PLAN.md section 3):
 * **the capability record owns the per-class model.** Phase 9 made that
 * mapping a PER-HOST fact — `crucible install` probes the card and picks the
 * largest candidate that fits, so a 24 GB box serves `translate` with a 4-bit
 * 27B and a 12 GB box does not serve it at all — and an id chosen in this
 * app's Settings was a second opinion about a decision that already has an
 * owner. The SDK's own `CapabilityRecord` puts it plainly: *"A client handed a
 * model id by configuration would be carrying one this server may have
 * refused."*
 *
 * What replaced it is {@link CrucibleCapabilityView}: a READ of
 * `GET /v1/capability`, drawn as what the server has decided rather than as a
 * choice this app makes.
 */

/** One class's verdict on one server, as Settings → AI draws it. */
export interface CrucibleCapabilityRow {
  /** `clean`, `translate`, `simplify`, `analysis`, `tts`, `asr`, … */
  capability: string;
  enabled: boolean;
  /** The model that won, or `''` when none did. Branch on `enabled`, not on this. */
  selected: string;
  /** Why, in the server's own words, whichever way it went. Never empty. */
  reason: string;
  /** How much more memory the smallest candidate needed, or 0. */
  shortfallBytes: number;
  /**
   * WHERE this class's work runs on that server (PHASE15 §3.3).
   *
   * `upstream` means `selected` is an upstream model id and the work leaves the
   * card entirely — which is what the queue reads to give the row a `[cloud]`
   * lane instead of a GPU slot (`shared/queue/slot-sets.ts`). Every non-llm
   * class answers `local`; only `clean translate simplify analysis` can be
   * anything else.
   */
  route: CrucibleRouteKind;
  /**
   * CRUCIBLE 1.0.24's two additions, carried through verbatim — the SDK demands
   * both keys on the wire and types each as nullable (`CapabilityRow`), so this
   * mirror carries exactly that and nothing drawn from them yet: what the class
   * runs as (`work`), and the per-model context ceilings a load may go up to
   * (`contextCeilings`).
   */
  work: CapabilityWork | null;
  contextCeilings: readonly ContextCeiling[] | null;
}

/**
 * `GET /v1/capability` — what a server can hold, per class, and why not.
 *
 * `totalBytes` is the card the decision was measured on, which is how a stale
 * record is told from a current one without anybody writing down a date.
 */
export interface CrucibleCapabilityView {
  backendKind: string;
  totalBytes: number;
  desktopAllowanceBytes: number;
  classes: CrucibleCapabilityRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE'S OWN SETTINGS (crucible docs/PHASE15-HOST.md sections 3.1, 3.2)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── WHY THESE SHAPES ARE HERE AND NOT IN app-settings.json ─────────────────
 *
 * Owen, 2026-09-14 (evening): *"bookforge/foundry gain a simple contract: send
 * commands to the crucible server. period. they dont have ollama fallbacks or
 * cloud anything at all."* And: *"If the user enters an anthropic api key, it
 * should pass through to crucible."*
 *
 * PHASE15 §0: **settings live in the engine and nowhere else.** An app is a
 * WINDOW onto them, never a copy. So these types describe a document BookForge
 * reads and writes over HTTP and never stores: there is no app-settings key, no
 * tool-paths key, no localStorage entry, and `tools/test-no-cloud-doors.js`
 * pins that by name.
 *
 * This **overrules the morning ruling** that cloud keys live in Foundry's cloud
 * card (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §3): the keys moved INTO the engine and
 * Foundry's card becomes a window onto the same document.
 *
 * A key is WRITE-ONLY. Nothing on this wire can carry one back — the read shape
 * has a {@link CrucibleUpstreamRow.keyHint}, four characters, and no field a
 * key could travel in. That is the same property `CrucibleServerRow.tokenMasked`
 * has at the top of this file, kept rather than re-earned.
 */

/** The three upstreams an engine can forward an llm class to. Exactly these. */
export const CRUCIBLE_UPSTREAM_NAMES = ['anthropic', 'openai', 'ollama'] as const;

/** One of the three. Never a free string: the server refuses a fourth by name. */
export type CrucibleUpstreamName = (typeof CRUCIBLE_UPSTREAM_NAMES)[number];

/**
 * Where a class's work runs ON THAT SERVER.
 *
 * `local` is the selected local model; `upstream` is a service the operator
 * configured. **It is a route, not a fallback** (PHASE15 §0): it is chosen
 * before any request and nothing switches to it because something failed.
 */
export type CrucibleRouteKind = 'local' | 'upstream';

/** One class's route, as `GET /v1/settings` states it. */
export interface CrucibleRouteRow {
  route: CrucibleRouteKind;
  /**
   * For `local`, the class's selected local model, or `null` when nothing fits.
   * For `upstream`, the upstream model id (`anthropic/claude-sonnet-5`).
   *
   * `null` is "nothing fits", a measured answer — branch on {@link route} and
   * on this being null, never on an empty string, which the server does not
   * send here.
   */
  model: string | null;
}

/**
 * One upstream's state. **`configured` is the only thing to branch on** — the
 * hint and the url are for showing, and a key is never here at all.
 */
export interface CrucibleUpstreamRow {
  configured: boolean;
  /**
   * The server's own hint at which key is there, or `null`.
   *
   * It arrives WITH its leading ellipsis — `…k3A9` — and is rendered
   * VERBATIM (crucible `c5482ff`). A screen that stripped it and re-added its
   * own would be the second author of one string, and the day the server
   * lengthens the hint the two would disagree about what a person is looking
   * at. `anthropic` and `openai` only; `ollama` is reached by address.
   */
  keyHint: string | null;
  /** Where the Ollama server is. `null` for the two that are reached by key. */
  url: string | null;
}

/** `GET /v1/settings` — the whole document, and the only copy of it. */
/**
 * One model this engine could hold for one capability class, as the ENGINE
 * computed it — never as this app estimated it.
 *
 * `fits` IS AN ESTIMATE AND IT EXCLUDES THE KV CACHE. `memoryBytesEstimate` is
 * the weights alone; a context window's keys and values are on top of it and
 * are not counted. Measured 2026-09-16 on Owen's PC: `qwen3.8-27b-4bit` reports
 * 20.15 GiB and `fits: true` against roughly 21 GiB of allowance — under a
 * gigabyte of headroom before any cache at all, and a 16k context on a 27B
 * model is several GiB. So a choice can say it fits and then fail to load.
 * Anything drawing this must word it as an estimate and say what it leaves out.
 * (Crucible's own defect; unfixed, and Owen's to rule on.)
 */
export interface CrucibleLocalModelChoice {
  id: string;
  memoryBytesEstimate: number;
  fits: boolean;
  installed: boolean;
}

/**
 * Which local model serves each capability class, and what else could.
 *
 * `null` for a class means the engine DECIDES — automatic selection, which is a
 * real answer and not an absent one. The two maps are keyed by capability class
 * (`clean`, `translate`, `pages`, `tts`, … — more than the four text acts).
 */
export interface CrucibleLocalModels {
  selected: Record<string, string | null>;
  choices: Record<string, CrucibleLocalModelChoice[]>;
}

export interface CrucibleEngineSettings {
  /** One entry per llm class, always all four. */
  routes: Record<CrucibleTextActName, CrucibleRouteRow>;
  /** One entry per upstream, always all three, configured or not. */
  upstreams: Record<CrucibleUpstreamName, CrucibleUpstreamRow>;
  desktopAllowanceBytes: number;
  /** `cuda-linux`, `mlx-darwin`, or `none` in host mode. */
  backendKind: string;
  /**
   * Always present. An engine that does not send both maps is refused by the
   * SDK, by name and with the field path.
   *
   * It was `| null` for two hours on 2026-09-16, meaning "this server predates
   * model assignment". Owen ruled that population out of existence the same
   * evening — nothing is released, so nothing is legacy — and an optional shape
   * kept for readers who do not exist is a branch every caller pays for.
   *
   * `choices` can still be EMPTY, and that is a different thing: an engine
   * that has not measured its card yet has no candidates to offer and no budget
   * to measure them against. It is answering with nothing, not failing to
   * answer.
   */
  localModels: CrucibleLocalModels;
}

/**
 * `PUT /v1/settings` — a PARTIAL patch, validated as a whole, applied or not.
 *
 * One request configures an upstream AND sets the route to it (§5.2): the
 * server applies upstreams first, then routes, then validates, and a refusal
 * applies nothing — so there is no window in which a route names a key that is
 * not there yet.
 */
export interface CrucibleEngineSettingsPatch {
  /** `'local'`, or an upstream model id `<upstream>/<model>`. */
  routes?: Partial<Record<CrucibleTextActName, string>>;
  /** A key or a url to set; `null` REMOVES that upstream. */
  upstreams?: Partial<Record<CrucibleUpstreamName, { key: string } | { url: string } | null>>;
  desktopAllowanceBytes?: number;
  /**
   * Capability class → a model id, or `null` to hand the choice back to the
   * engine. The server refuses by name: `local_model_not_selectable` (400) for
   * a class that has no choice to make, `local_model_unknown` (400) for an id
   * it does not have, `local_model_does_not_fit` (409), and
   * `capability_undecided` (503) when nothing has decided anything on that host
   * yet.
   */
  localModels?: Record<string, string | null>;
}

/**
 * What to try before saving: `POST /v1/settings/upstreams/{name}/test`.
 *
 * Empty means "test what is already configured" — the button beside a card
 * that already has a key. A key or url here is tested WITHOUT being stored,
 * which is what makes Test-before-Save true rather than a wording.
 */
export type CrucibleUpstreamProbe = { key: string } | { url: string } | Record<string, never>;

/**
 * What the upstream itself lists.
 *
 * **BookForge ships no cloud model list** (PHASE15 §2): the ids a person picks
 * from are the ones the account can actually reach, asked for at the moment
 * they are shown. A hardcoded three-item list was audit finding 3 and it is
 * gone.
 */
export interface CrucibleUpstreamModels {
  models: string[];
}

/**
 * A named refusal from the settings door, for a screen that shows the fix.
 *
 * `field` is the server's `details.field` where it sent one: a DOTTED PATH
 * (`upstreams.anthropic.key`, `routes.translate`) naming exactly which control
 * the refusal is about, so a panel can put the sentence beside that control
 * instead of at the top of the page. `classes` comes with `upstream_in_use`
 * and lists the classes still routed to the upstream somebody tried to remove.
 * Both are `null` when the server sent neither — never invented.
 */
export interface CrucibleEngineSettingsRefusal {
  code: string;
  message: string;
  field?: string | null;
  classes?: string[] | null;
}

/** A read or a write, or the reason there is neither. Never a half-document. */
export type CrucibleEngineSettingsResult =
  | { ok: true; settings: CrucibleEngineSettings }
  | { ok: false; refusal: CrucibleEngineSettingsRefusal };

/**
 * What Test answered.
 *
 * A RESULT and not an exception, matching the SDK's `testUpstream()` (crucible
 * PHASE15 §3.8, pinned by `c5482ff`) so the vendored method is a drop-in. And
 * right on its own terms: "that key was rejected" is the ordinary outcome of
 * pressing Test, it belongs beside the field, and a caller that had to catch
 * it would be using the exception channel for the expected answer. The three
 * codes are `upstream_unreachable`, `upstream_rejected`,
 * `upstream_unconfigured`.
 */
export type CrucibleUpstreamTestResult =
  | { ok: true; models: string[] }
  | { ok: false; refusal: CrucibleEngineSettingsRefusal };
