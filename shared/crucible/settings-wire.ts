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

/** The server on this machine, as the row draws it. */
export type LocalServerRow =
  | {
      present: true;
      /** `[server] name` from its own config.toml, e.g. `crucible@owens-pc-wsl`. */
      serverName: string;
      url: string;
      tokenMasked: string;
      /** The file this was read from; prefixed `<distro>:` when read through WSL. */
      configPath: string;
      via: 'file' | 'wsl';
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

/**
 * The record `<userData>/crucible-models.json` holds: an act to a Crucible
 * model id. An act with no choice has NO KEY — there is no default, because a
 * Crucible id is whatever the host has manifests for and an Ollama tag is not
 * one.
 */
export type CrucibleTextActModels = Partial<Record<CrucibleTextActName, string>>;
