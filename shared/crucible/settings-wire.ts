/**
 * The shapes the Crucible Servers settings row sends across the IPC seam.
 *
 * Types only. The main process owns the registry (`electron/crucible/servers.ts`),
 * the local server's config (`local.ts`) and the rank/enable record
 * (`routing.ts`); the renderer owns none of those and must not re-spell them, so
 * the wire lives here, once, and both sides import it — the same rule
 * `shared/vlm/conversion.ts` and `shared/processing/pass-types.ts` already
 * follow.
 *
 * Nothing here carries a token. {@link LocalServerRow.tokenMasked} and
 * {@link RemoteServerRow.tokenMasked} are `****<last 4>`, which is enough to tell
 * two tokens apart and not enough to use one — the registry's listing types are
 * structurally unable to carry the plaintext (see `servers.ts`), and this wire
 * keeps that property rather than re-earning it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The list
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH DOOR "the server on this machine" CAME THROUGH.
 *
 *  - `pairing` — the connect code the engine (or the Windows host) wrote beside
 *    its own config, crucible `docs/PHASE15-HOST.md` §3.6. **The contract's
 *    door**, and the one that needs no WSL and no typing.
 *  - `file` — its `config.toml`, read directly. macOS and Linux.
 *  - `wsl` — its `config.toml`, read through `wsl.exe`. **The LEGACY door**,
 *    dated: §3.6 says it "is how the WSL server gets registered" until a host
 *    exists on the machine, "and that door is deleted when the host lands".
 */
export type LocalServerVia = 'pairing' | 'file' | 'wsl';

/** The server on this machine, as the row draws it. */
export type LocalServerRow =
  | {
      present: true;
      /** `[server] name`, or the connect code's name, e.g. `crucible@owens-pc-wsl`. */
      serverName: string;
      url: string;
      tokenMasked: string;
      /** The file this was read from; prefixed `<distro>:` when read through WSL. */
      configPath: string;
      via: LocalServerVia;
    }
  | {
      present: false;
      /** `no_local_config`, `no_wsl_distro`, … — a NAMED state, never an outage. */
      code: string;
      /** The sentence, which carries the fix. Shown as the row's state. */
      reason: string;
    };

/** One registered remote server, as the row draws it. */
export interface RemoteServerRow {
  name: string;
  url: string;
  tokenMasked: string;
  /** ISO 8601. */
  added: string;
  /**
   * `null` for a usable entry. `loopback_duplicates_local` for a pre-rule entry
   * whose URL is this machine — refused at use, shown here so it can be removed.
   */
  stale: null | 'loopback_duplicates_local';
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
  /** Every known server, best first. `local` participates by name. */
  ranked: RankedServerRow[];
  newJobsWaitFor: WaitForDefault;
  /**
   * Run GPU work with the LOCAL engines instead of sending it to a Crucible
   * server: audiobook renders by spawning narrator here, and the four text acts
   * — clean, translate, simplify, analysis — against the local text server.
   *
   * **ONE switch for both**, and the field keeps the name it was minted with
   * (renaming it would orphan every record on disk to buy a spelling). Its
   * label is "Run renders and text passes with the local engines instead
   * (legacy — removed after the in-app pass)".
   *
   * **A dated stopgap with one owner** (docs/CRUCIBLE_ROLLOUT_PLAN.md §2 ruling
   * 4): the local spawn layers stay until Owen's in-app pass and are then
   * deleted in a commit he approves. It is a switch rather than a fallback —
   * nothing flips it, the work says on the log when it is on, and when it is
   * off, work that cannot reach a server FAILS BY NAME rather than quietly
   * taking the local card.
   */
  legacyLocalRender: boolean;
  /**
   * Names the record mentions that no server answers to any more. Reported with
   * the name, never pruned behind the operator's back.
   */
  unknown: string[];
}

/** Everything the settings row draws before it probes anything. */
export interface CrucibleServersView {
  local: LocalServerRow;
  remotes: RemoteServerRow[];
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
  /** Any other named refusal — the registry's, the local config's, or the server's. */
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
  /** The registry name (or `local`) this task is running on. */
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
 * key could travel in. That is the same property `LocalServerRow.tokenMasked`
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
export interface CrucibleEngineSettings {
  /** One entry per llm class, always all four. */
  routes: Record<CrucibleTextActName, CrucibleRouteRow>;
  /** One entry per upstream, always all three, configured or not. */
  upstreams: Record<CrucibleUpstreamName, CrucibleUpstreamRow>;
  desktopAllowanceBytes: number;
  /** `cuda-linux`, `mlx-darwin`, or `none` in host mode. */
  backendKind: string;
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
