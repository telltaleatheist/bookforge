/**
 * A LEASE ON THE RESIDENT MODEL — this app saying it intends a RUN of requests.
 *
 * ── The ruling this exists to satisfy ───────────────────────────────────────
 *
 * Owen, 2026-09-14: *"Models should always be unloaded when we're done with
 * them. Every time."* Crucible now unloads the resident model the moment the
 * last of four facts goes false — no job on the lane, no lease open, no
 * streaming session, no chat in flight (crucible `docs/PHASE7-LANES.md` §5.3).
 *
 * Three of those four hold themselves. The fourth does not: a chat completion
 * takes no lane and holds no claim, deliberately, because a vLLM engine batches
 * and serialising chats to fix a reporting gap would destroy the thing the
 * engine exists to do (`crucible/inflight.py`). That is the right answer for ONE
 * chat and the wrong answer for two thousand — and a BookForge cleanup run, a
 * text act and a page read are each two thousand.
 *
 * ── THIS IS NOT A SPEED FIX. WITHOUT IT THE DOORS DO NOT WORK ──────────────
 *
 * Measured against the unload build (crucible `5bf7d62`) while it was landing:
 * the chat door **never loads a model**, by design — residency is the operator's
 * act, and a chat that loaded would evict whatever the last client left there. So
 * the moment a cleanup run's completion returns, the server sees no job, no
 * lease, no session and no chat in flight, and unloads. The NEXT chunk is not
 * slow; it is answered **`model_not_resident`** (the chat door's own code, which
 * did not move), and the run dies at chunk 2 of
 * 600 with nothing having gone wrong anywhere.
 *
 * A lease is therefore what makes these doors function at all. Reading it as a
 * performance measure is how it gets dropped from a door and the failure blamed
 * on the server.
 *
 * The fact that actually exists is that **this client intends a run**, and only
 * this client has it. So it says so: it takes a lease, heartbeats while the run
 * is alive, and releases when the run ends. That is the whole of this module.
 *
 * ── What a lease is, and what it is NOT ─────────────────────────────────────
 *
 * It is a REFUSAL, not a reservation (crucible `crucible/leases.py`). Holding
 * one admits nothing, reserves no lane and does not make a busy server take our
 * work. It says exactly one thing: *while this is open, nothing may move the
 * model off that card.* `load-model`, `unload-model`, `load-voice`, `tts` and
 * `align` are refused `409 leased` on that server while it is open —
 * including to us, because the server cannot tell two of our runs apart.
 *
 * It never gates a chat. Chats are what it protects.
 *
 * ── WHO LEASES, AND WHO MUST NOT ────────────────────────────────────────────
 *
 * The rule is *does this door's work reach the server as a SEQUENCE of requests
 * with nothing else holding the card between them.*
 *
 *   LEASE — the four text acts (`text-venue.ts`), the `crucible` AI provider's
 *           cleanup run (`ai-bridge.ts`), the page read (`pages.ts`). Each is
 *           hundreds or thousands of chat completions against one resident
 *           model, and between any two of them the card is unprotected.
 *
 *   DO NOT LEASE — `render.ts`, `asr.ts`, `align.ts`, `rvc.ts`, `denoise.ts`,
 *           `reroll.ts`. Their work is ONE job on the lane, and a job already
 *           holds everything a lease would hold: `/v1/activity` reports it
 *           `running`, and a second submission is refused `server_busy` naming
 *           it. Leasing around one of them would add a second claim on the same
 *           fact — and `tts` and `align` are in `EVICTS_THE_RESIDENT_MODEL`, so
 *           a lease taken around one would refuse the very job it was taken for.
 *
 *   DO NOT LEASE — `stream.ts`. A streaming session holds the resident engine's
 *           exclusive CLAIM (`crucible/residency.py`, `refuse_if_claimed`), which
 *           is fact 3 of the four. It is already one of the things that keeps a
 *           model loaded; a lease beside it would be the same claim twice.
 *
 * **A LEASE IS TAKEN AROUND A RUN, NEVER AROUND ONE REQUEST.** One per request
 * would be the reload this exists to prevent, wearing a different hat, and on the
 * unload build it would be worse than that — the model is gone between the
 * release and the next take. So the wrapper goes around the CALLER: the whole
 * `cleanupEpub` job, the whole engine spawn, the whole conversion. Where a door
 * looks like it wraps a single request, the caller is what wants wrapping.
 *
 * **A ROW OF ACTS IS ALSO ONE RUN (BUILT 2026-09-14).** A queue row that cleans
 * a book and then simplifies it is two acts against one resident model, and
 * each used to take and release its own lease — so the model was unloaded
 * between them and the second act paid a full reload. The scheduler now runs
 * every step inside a ROW SCOPE and the lease is handed to it instead of being
 * released: see ONE LEASE PER ROW below for the seam, for why the scope is
 * ambient, and for the one thing it could not settle — a lease carries a single
 * act name and Crucible's vocabulary has no name for "a row of acts", so a
 * row-wide lease is stamped with the act that OPENED it. That is a ruling owed
 * (`docs/CRUCIBLE_ROLLOUT_PLAN.md` §3), not a decision taken here.
 *
 * ── Why this is hand-rolled HTTP and not three SDK calls ────────────────────
 *
 * `client.lease()`, `client.heartbeat()` and `client.release()` exist on the
 * Crucible branch (`aa2a24f`) and ship in the release after this one. The pin in
 * `package.json` is `@crucible/client` **v0.5.0**, which does not carry them. So
 * the three routes are called with `fetch` here, and the ERROR MAPPING below is
 * the reason this is a module and not three inline calls: everything else on
 * these paths throws the SDK's own error types and every door switches on them,
 * so a route called by hand that threw a bare `Error` would turn `409
 * leased` — a WAIT — into "something went wrong", which is a failure.
 *
 * **THE DAY THE PIN MOVES, THIS FILE COLLAPSES TO THE SDK'S THREE METHODS.**
 * {@link leaseRequest} and its mapping go; {@link withCrucibleLease} stays, and
 * so does every caller. {@link CrucibleLeased} is replaced by the SDK's own type
 * of the same name, which carries the same five fields and the same
 * `leasedLine`.
 *
 * ── Two semantics that are not optional ─────────────────────────────────────
 *
 * **`404 unknown_lease` on a RELEASE is a no-op.** Released and expired both mean
 * nothing is held, which is the state a release wanted. Reporting it would fail a
 * finished run for tidying that had already happened.
 *
 * **`404 unknown_lease` on a HEARTBEAT is a RE-LEASE, not a failure.** Leases
 * live in memory and a restart forgets them, so `unknown_lease` mid-run means the
 * card is unprotected RIGHT NOW while our engine is mid-book. The answer is a new
 * lease on the same model, not a log line. Foundry's dispatch does exactly this
 * (`foundry/app/electron/crucible-dispatch.ts`, `takeLease`) and this mirrors it
 * deliberately: two clients guessing differently at the same restart is how one
 * of them loses a book.
 *
 * ── Expiry is the backstop, and the only one ────────────────────────────────
 *
 * There is no sweeper on the server: every read compares the stored instant to
 * the clock. So a client that crashes, sleeps or is killed stops blocking the
 * card within its TTL, whether or not anything was watching. That is what makes
 * {@link CRUCIBLE_LEASE_TTL_SECONDS} a LIVENESS number rather than a duration —
 * it is how long the server should keep believing in a client it cannot see, not
 * how long the run will take.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  CrucibleAuthError,
  CrucibleBusy,
  CrucibleRefused,
  CrucibleServerError,
  CrucibleUnreachable,
  CrucibleVersionError,
  SDK_VERSION,
} from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, getServer } from './servers';

// ─────────────────────────────────────────────────────────────────────────────
// The numbers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long the server keeps believing in this app without hearing from it.
 *
 * LIVENESS, NOT DURATION. A run may be an hour; this is two minutes, because the
 * question it answers is "how long after this process disappears should somebody
 * else's card stay claimed by it". Two minutes is three heartbeats, so two may be
 * lost in a row before anything expires.
 *
 * Crucible's own range is 30–3600 s (`crucible/leases.py`, `require_ttl`) and it
 * is NOT mirrored here: the server owns that fact and states the range in its own
 * `400 invalid_ttl`, so a ttl this module disagreed with would be two owners of
 * one rule. Ask, and read the refusal.
 */
export const CRUCIBLE_LEASE_TTL_SECONDS = 120;

/**
 * The heartbeat cadence for a ttl: a THIRD of it.
 *
 * A half would mean one dropped packet costs the card. A third means two
 * consecutive losses are survivable, which is the difference between a blip and
 * an eviction mid-book. The same third Foundry's dispatch uses, so two clients
 * against one server behave the same way under the same loss.
 */
export function crucibleHeartbeatIntervalMs(ttlSeconds: number): number {
  return Math.round((ttlSeconds / 3) * 1000);
}

const API_HEADER = 'X-Crucible-Api';
const API_VERSION = '1';

/**
 * What the server records as the lease's `client`, and what `/v1/activity`
 * reports to the bench that asks who is holding the card.
 *
 * The SDK's own composition — `<clientName> crucible-client/<sdk version>` — so
 * a lease and a job from this app appear under ONE name in a shared server's log
 * rather than as two apps (crucible `docs/ARCHITECTURE.md` R1).
 */
function leaseUserAgent(): string {
  return `${CRUCIBLE_CLIENT_NAME} crucible-client/${SDK_VERSION}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The refusal that is a WAIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `409 leased`: somebody has said they are mid-run on that model.
 *
 * Its own type for {@link CrucibleBusy}'s reason — the body is not decoration.
 * The server answers with the holder's name, the act, when it started and when
 * it expires *"enough for a client to back off intelligently"*, and a caller
 * left to dig that out of `details: unknown` would re-implement the same parse in
 * every door.
 *
 * **`holder` is null when the lease was taken without a User-Agent, and null
 * means "it did not say".** Never guessed at: a bench must not be confidently
 * wrong about whose run is on the card.
 *
 * **Nothing here retries or waits it out.** ARCHITECTURE.md R5 — queues belong to
 * clients. A sleep loop in this module would be a queue with a policy nobody
 * chose; what a door does with the wait is the door's, every time. Where the
 * caller is a queue step the wait is rendered through the queue's own busy hold
 * ({@link leasedLine} → `noteStepBusy`), which is the same road `server_busy`
 * already travels.
 *
 * A subclass of {@link CrucibleRefused} so that every `catch` already written
 * against the SDK's types still catches it, and so it is a one-line deletion the
 * day the pin carries the SDK's own `CrucibleLeased`.
 */
export class CrucibleLeased extends CrucibleRefused {
  /** The open lease's id, as the server named it. */
  readonly leaseId: string;
  /** The holder's recorded User-Agent. Null = it did not say. */
  readonly holder: string | null;
  /** The capability class it was taken for: `translate`, `clean`, `pages`, … */
  readonly act: string;
  /** When the holder took it, as the server said it. */
  readonly since: string;
  /** The earliest it can lapse without a heartbeat. */
  readonly expiresAt: string;

  constructor(
    status: number,
    code: string,
    serverMessage: string,
    details: unknown,
    fields: {
      leaseId: string;
      holder: string | null;
      act: string;
      since: string;
      expiresAt: string;
    },
  ) {
    super(status, code, serverMessage, details);
    this.name = 'CrucibleLeased';
    this.leaseId = fields.leaseId;
    this.holder = fields.holder;
    this.act = fields.act;
    this.since = fields.since;
    this.expiresAt = fields.expiresAt;
  }

  /**
   * "leased: foundry, translate since 2026-09-14T01:02:03Z" — the one line a
   * bench or a held queue row puts in front of a person.
   *
   * Deliberately the same shape as {@link CrucibleBusy.busyLine}, because the two
   * are read in the same place by the same reader for the same purpose: what is
   * in the way, and whose it is.
   */
  get leasedLine(): string {
    const who = this.holder === null ? 'an unnamed client' : this.holder;
    return `leased: ${who}, ${this.act} since ${this.since}`;
  }
}

/**
 * The SDK's `isServerSpecificRefusal` — which decides whether a `waitFor: "any"`
 * walk should try the NEXT server — does not know `leased` on the pinned
 * v0.5.0: it lists codes explicitly and answers `false` for anything it has not
 * seen. So today a `leased` stops an `any` walk rather than moving it
 * along, which costs an opportunity and never a wrong answer (the conservative
 * direction the SDK chose on purpose).
 *
 * This is the one place that knows better, and it is NOT a second copy of that
 * table: it answers only for this one code, for the callers that walk. The SDK's
 * next release puts `leased` in `SERVER_SPECIFIC_REFUSALS` and this goes.
 */
export function isCrucibleLeasedElsewhere(err: unknown): err is CrucibleLeased {
  return err instanceof CrucibleLeased;
}

// ─────────────────────────────────────────────────────────────────────────────
// The three routes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One authenticated call to a route `@crucible/client` v0.5.0 has no method for.
 *
 * The two headers are exactly the ones the SDK sends on every authenticated
 * route, and the mapping below produces exactly the SDK's own error types — see
 * the header for why that, and not the fetch, is the point of this function.
 */
async function leaseRequest(
  where: { url: string; token: string },
  route: string,
  options: { method: string; body?: unknown },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${where.url}${route}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${where.token}`,
        [API_HEADER]: API_VERSION,
        'User-Agent': leaseUserAgent(),
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (cause) {
    throw new CrucibleUnreachable(
      where.url, cause instanceof Error ? cause.message : String(cause), cause,
    );
  }

  if (response.status === 204) return null;
  const text = await response.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
  }
  if (response.ok) return parsed;

  /*
   * `{"error": {"code", "message", "details"?}}` is the documented envelope for
   * every refusal on this wire (crucible `docs/DESIGN.md` §4). A body that is not
   * one is NOT dressed up as a code — `unreadable_refusal` says so, because a
   * made-up code would be switched on by a door as though a server had said it.
   */
  const envelope = (parsed as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)
    ?.error;
  const code = typeof envelope?.code === 'string' ? envelope.code : 'unreadable_refusal';
  const message = typeof envelope?.message === 'string' ? envelope.message : text.slice(0, 300);
  const details = envelope?.details ?? null;

  if (response.status === 401) throw new CrucibleAuthError(code, message);
  if (response.status === 426) {
    const served = (details as { server_api_version?: unknown } | null)?.server_api_version;
    throw new CrucibleVersionError(
      code, message, typeof served === 'number' ? served : null, Number(API_VERSION),
    );
  }
  if (response.status >= 500) throw new CrucibleServerError(response.status, code, message);
  if (response.status === 409 && code === 'leased') {
    const held = (details ?? {}) as Record<string, unknown>;
    throw new CrucibleLeased(409, code, message, details, {
      leaseId: typeof held['lease_id'] === 'string' ? held['lease_id'] : '',
      holder: typeof held['client'] === 'string' ? held['client'] : null,
      act: typeof held['act'] === 'string' ? held['act'] : 'a run',
      since: typeof held['since'] === 'string' ? held['since'] : '',
      expiresAt: typeof held['expires_at'] === 'string' ? held['expires_at'] : '',
    });
  }
  throw new CrucibleRefused(response.status, code, message, details);
}

// ─────────────────────────────────────────────────────────────────────────────
// The lease
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT KIND OF RESIDENT THING A LEASE IS ON — a fact for THIS side only.
 *
 * A Crucible holds one resident thing at a time and it has three kinds — a
 * model, a voice, an aligner — each of which evicts the other two
 * (`crucible/residency.py`). A lease names the resident THING, whatever kind it
 * is, and there is one route for all three: `POST /v1/models/{id}/lease` takes a
 * voice id or an aligner id as readily as a model id.
 *
 * **THE KIND IS NEVER ON THE WIRE, AND THAT IS DELIBERATE ON THE SERVER'S PART**
 * (`crucible/leases.py`): at the moment a lease is taken there is exactly ONE
 * candidate, because the card holds one thing — so the server supplies the kind
 * from `resident.kind`, and a `kind` in the body would be a field with no
 * question to answer and a second thing able to disagree with it (R1).
 *
 * So why is it a parameter here? Because it is a fact about THE CALLER'S
 * INTENTION, and this side needs it for the two things the wire does not carry:
 * a log line that says what was leased, and a door that can be read without
 * guessing. Naming it also keeps the module honest about what it does NOT yet
 * do — see the ruling below.
 *
 * RULING OWED — the doors that should lease a VOICE, once the voice/aligner
 * extension lands (it is in flight on the Crucible side; the shape above is read
 * out of `crucible/leases.py`, not assumed):
 *   · a chapter-by-chapter render — `render.ts` submits one `tts` job per run
 *     today, but a book rendered in chapters is N jobs against one resident
 *     voice, and with the unload ruling in place each chapter pays a narrator
 *     load. The server's own note says `tts` under a VOICE lease **for the voice
 *     it names** is an admission rather than a refusal, which is what makes this
 *     coherent at all;
 *   · a re-roll taken after a render (`reroll.ts` — one job per take against the
 *     voice it is re-rolling).
 * And an ALIGNER: a chapter-by-chapter align (`align.ts`), where the resident
 * aligner exists precisely so hundreds of chunks pay one load.
 *
 * **NONE of those is built here.** The coordinator holds the final shape; a
 * client that guessed at it would be the first thing to break when it lands, and
 * nothing in BookForge renders or aligns chapter by chapter through these doors
 * yet.
 */
export type CrucibleLeaseKind = 'model' | 'voice' | 'aligner';

/**
 * The one lease route, for every kind. The id is the ONLY thing on it — see
 * {@link CrucibleLeaseKind} for why the kind stays on this side.
 */
function leaseRoute(id: string): string {
  return `/v1/models/${encodeURIComponent(id)}/lease`;
}

/** An open lease, for the log line and for the run that holds it. */
export interface CrucibleLease {
  /** The server's id for the LEASE. Changes if a heartbeat had to re-lease. */
  readonly id: string;
  /** The server it is on, by NAME — `local`, or a registry name. */
  readonly server: string;
  /** What kind of resident thing it holds. */
  readonly kind: CrucibleLeaseKind;
  /** The id of the leased thing — a model id today. */
  readonly leased: string;
  /** The capability class it was taken for. */
  readonly act: string;
  /** Stop the heartbeat and give the card back. Idempotent; never throws. */
  release(): Promise<void>;
}

export interface CrucibleLeaseOptions {
  /** Names an entry in `<userData>/crucible-servers.json`, or the reserved `local`. Never a URL. */
  readonly server: string;
  /**
   * Which resident kind this lease is on. NOT sent to the server, which supplies
   * it from what is on the card — see {@link CrucibleLeaseKind}. Required and
   * never defaulted, because it is the caller's own statement of what it is
   * holding, and a door that did not say would be leasing whatever this module
   * happened to assume. Every door that exists today says `model`.
   */
  readonly kind: CrucibleLeaseKind;
  /**
   * The id of the thing being leased — a Crucible model id today, which must
   * ALREADY be resident. A lease never loads anything: a load evicts whatever is
   * on that card, which on a shared server is somebody else's book.
   */
  readonly id: string;
  /**
   * The capability class, named TRUTHFULLY: `clean`, `translate`, `simplify`,
   * `analysis`, `pages`. It goes on a bench beside the card, so a simplify that
   * called itself a translate would be the lie Owen ruled out on 2026-09-13.
   *
   * Not narrowed to a union here on purpose: the vocabulary belongs to the
   * server (`crucible/inflight.py`, `require_act_name`), which refuses one it does
   * not know as `400 unknown_act`. A copy of that list on this side would be a
   * second owner, able to go stale in the direction that refuses a class Crucible
   * had just learned.
   */
  readonly act: string;
  /**
   * How long the server should keep believing in us without hearing from us.
   * Defaults to {@link CRUCIBLE_LEASE_TTL_SECONDS} — the module's liveness
   * policy, which is a declared number rather than a fallback for a missing one.
   * Out of the server's 30–3600 range it comes back `400 invalid_ttl` stating the
   * range, which is the one owner of that rule.
   */
  readonly ttlSeconds?: number;
  /**
   * OVERRIDES the cadence {@link crucibleHeartbeatIntervalMs} derives.
   *
   * **Only a keeper passes this.** The derived third-of-ttl is the policy, and a
   * caller that shortened it would be tuning somebody else's server from here; it
   * exists because the server's floor is a 30 s ttl and a suite must not spend ten
   * seconds per check watching a real heartbeat arrive.
   */
  readonly heartbeatMs?: number;
  /** Free text for the run's log. */
  readonly onLog?: (line: string) => void;
}

/**
 * Every lease this process currently holds.
 *
 * Kept so that {@link releaseAllCrucibleLeases} can give back a card the app is
 * quitting on rather than leaving it claimed for the rest of the ttl. It is a
 * courtesy and never the mechanism: expiry is the mechanism, because a process
 * that is killed does not run handlers.
 */
const openLeases = new Set<CrucibleLease>();

/** Armed on the first lease, never on import — see {@link armQuitRelease}. */
let quitReleaseArmed = false;

/**
 * Give every open lease back when the app quits.
 *
 * Registered on the FIRST lease rather than at import, so a run that never
 * touches a Crucible never installs a handler. `before-quit` rather than `quit`:
 * the DELETEs are fired without holding the quit up, because a release that
 * delayed shutdown to tidy something the ttl will tidy anyway would be worse than
 * the ttl.
 *
 * Under a CLI (`process.versions.electron` absent) there is no such event and
 * none is invented: the process's own ending unwinds `withCrucibleLease`'s
 * `finally`, and a kill is what the ttl is for.
 */
function armQuitRelease(): void {
  if (quitReleaseArmed) return;
  quitReleaseArmed = true;
  if (process.versions.electron === undefined) return;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron') as typeof import('electron');
  app.on('before-quit', () => {
    void releaseAllCrucibleLeases();
  });
}

/**
 * Release every lease this process holds. Called on `before-quit`, and by a
 * keeper that wants to prove the quit path gives the cards back.
 */
export async function releaseAllCrucibleLeases(): Promise<void> {
  // The row map first, so a scope that outlives this call cannot hand a
  // released lease to a later act as if it were still open.
  rowLeases.clear();
  await Promise.all([...openLeases].map((lease) => lease.release()));
}

/** How many leases are open right now — for a keeper, and for a log line. */
export function openCrucibleLeaseCount(): number {
  return openLeases.size;
}

/**
 * Take the lease and arm the heartbeat that keeps it.
 *
 * A refusal PROPAGATES: `409 leased` as {@link CrucibleLeased} (a wait),
 * `409 not_resident` / `400 unknown_act` / `400 invalid_ttl` as
 * {@link CrucibleRefused} carrying the server's own code and sentence. Nothing
 * here loops, and nothing here loads a model to make the lease possible — a load
 * evicts whatever is on that card, which on a shared server is somebody else's
 * book.
 *
 * Prefer {@link withCrucibleLease}, which cannot leak one.
 */
export async function takeCrucibleLease(options: CrucibleLeaseOptions): Promise<CrucibleLease> {
  const { server, kind, id: leased, act } = options;
  const takeRoute = leaseRoute(leased);
  const ttlSeconds = options.ttlSeconds ?? CRUCIBLE_LEASE_TTL_SECONDS;
  const log = options.onLog ?? ((line: string) => console.log(`[CRUCIBLE-LEASE] ${line}`));

  // Resolved at CALL time, and resolved again on a re-lease: `local`'s token
  // lives in the server's own config.toml and `crucible init --force` mints a new
  // one, so a copy cached across a run is a copy that can go stale mid-book.
  const where = (): { url: string; token: string } => {
    const entry = getServer(server);
    return { url: entry.url, token: entry.token };
  };

  const acquire = async (): Promise<string> => {
    const body = await leaseRequest(
      where(), takeRoute, { method: 'POST', body: { act, ttl_seconds: ttlSeconds } },
    );
    const granted = (body as { lease_id?: unknown } | null)?.lease_id;
    if (typeof granted !== 'string' || granted === '') {
      /*
       * A 201 with no `lease_id`. Refused rather than shrugged off: carrying on
       * without one would mean running a whole book under a protection this code
       * believes it has, which is worse than not having it — nobody would look
       * for the eviction, because the lease was "taken".
       */
      throw new CrucibleRefused(
        201, 'lease_unreadable',
        `crucible "${server}" granted a lease on the ${kind} "${leased}" with no lease_id, so there `
        + 'is nothing '
        + 'to heartbeat and nothing to release. Nothing ran under it.',
        body,
      );
    }
    return granted;
  };

  let id = await acquire();
  log(`crucible "${server}" leased the ${kind} ${leased} for ${act} (${id}, ttl ${ttlSeconds}s)`);

  let released = false;
  const beat = options.heartbeatMs ?? crucibleHeartbeatIntervalMs(ttlSeconds);
  const timer = setInterval(() => {
    void leaseRequest(where(), `/v1/leases/${encodeURIComponent(id)}/heartbeat`, { method: 'POST' })
      .catch(async (err: unknown) => {
        /*
         * THE SERVER FORGOT THE LEASE, which is what a restart does. Leases are
         * in memory there, so `unknown_lease` on a heartbeat means the card is
         * unprotected NOW while this run is mid-book. The answer is not a log line
         * but a NEW lease on the same model: the model is still resident (a server
         * that had lost it would already be answering our requests
         * `not_resident`) and this run still intends every request it has
         * left. A re-lease that is itself refused falls through to the log below,
         * and the run goes on unprotected AND SAID SO.
         */
        let failure = err;
        if (err instanceof CrucibleRefused && err.code === 'unknown_lease' && !released) {
          try {
            id = await acquire();
            log(`crucible "${server}" had forgotten the lease on ${leased} (restarted?); `
              + `took a new one (${id})`);
            return;
          } catch (again) {
            failure = again;
          }
        }
        /*
         * A LOST HEARTBEAT IS NOT A LOST RUN AND MUST NOT STOP ONE. The run is
         * talking to the same server over its own sockets and is the thing that
         * would actually notice a problem; a heartbeat that fails while the run is
         * fine is a blip, and two more go out before the ttl is up. What it is not
         * is silent — an eviction later in the book gets a visible cause here
         * instead of looking like the server misbehaving.
         */
        log(`the lease heartbeat for ${leased} on crucible "${server}" failed: `
          + `${failure instanceof Error ? failure.message : String(failure)}`);
      });
  }, beat);
  // The heartbeat must never be the reason a CLI process stays alive after its
  // work is done.
  timer.unref?.();

  const lease: CrucibleLease = {
    get id(): string { return id; },
    server,
    kind,
    leased,
    act,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      clearInterval(timer);
      openLeases.delete(lease);
      try {
        await leaseRequest(where(), `/v1/leases/${encodeURIComponent(id)}`, { method: 'DELETE' });
        log(`crucible "${server}" released the lease on ${leased} (${id})`);
      } catch (err) {
        // ALREADY GONE IS THE STATE A RELEASE WANTED. `unknown_lease` means it was
        // released or it expired, and both of those mean nothing is held — so this
        // is a no-op, not a failure to report.
        if (err instanceof CrucibleRefused && err.code === 'unknown_lease') return;
        /*
         * Anything else is logged and swallowed on purpose, and this is the ONE
         * swallow in this module: the run has finished, the lease expires in at
         * most its ttl on its own, and failing a completed book because the tidying
         * failed would be reporting a loss that did not happen.
         */
        log(`the lease on ${leased} at crucible "${server}" could not be released `
          + `(it expires within ${ttlSeconds}s): ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
  openLeases.add(lease);
  armQuitRelease();
  return lease;
}

/**
 * RUN `run` UNDER ONE LEASE, and release it on every way out.
 *
 * The door every leasing caller uses. One lease for the whole run — not one per
 * request, which would be the reload this exists to prevent wearing a different
 * hat — heartbeated at a third of its ttl while `run` is in flight, and released
 * in a `finally` that success, failure and cancellation all pass through.
 *
 * The take is OUTSIDE the try on purpose: a lease that was never granted has
 * nothing to release, and a `finally` around a failed take would be releasing an
 * id that does not exist.
 */
export async function withCrucibleLease<T>(
  options: CrucibleLeaseOptions,
  run: (lease: CrucibleLease) => Promise<T>,
): Promise<T> {
  const row = currentRow();
  if (row !== null) return withRowLease(row, options, run);
  const lease = await takeCrucibleLease(options);
  try {
    return await run(lease);
  } finally {
    await lease.release();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// ONE LEASE PER ROW
// ────────────────────────────────────────────────────────────────────────────
//
// ── The defect ─────────────────────────────────────────────────────────────
//
// A queue row that cleans a book and THEN simplifies it is two acts against one
// resident model, and each took and released its own lease. Between the first
// release and the second take nothing held the card, and Owen's 2026-09-14
// ruling — *"Models should always be unloaded when we're done with them. Every
// time."* — means the server unloads a 19 GB model in that gap and the second
// act pays a full reload. The lease exists precisely to prevent that, and the
// row-shaped case slipped through it (the RULING OWED at the top of this file).
//
// ── The seam ───────────────────────────────────────────────────────────────
//
// The scheduler runs every step inside a ROW SCOPE named by the run's id
// (`queue-engine.ts`, `launch`). Inside a scope, `withCrucibleLease` does not
// release at the end of its caller: it hands the lease to the scope, and the
// scope keeps it until the SCHEDULER closes it — which is the moment the row has
// no next step that would use it (`closeCrucibleRowLease`).
//
// ── Why the scope is AMBIENT rather than a parameter ───────────────────────
//
// Because the alternative is threading a run id through `cleanupEpub`,
// `translateEpub`, `analyzeBook`, `runProcessingPass`, `runVlmConversion`,
// `resolveCrucibleTextEngine` and every future door — six signatures and their
// call sites changed to carry a fact none of them has any other use for, and a
// seventh door added later that silently keeps the old behaviour by forgetting
// to pass it. An `AsyncLocalStorage` makes the scheduler's own call stack the
// carrier, so EVERY leasing door is row-aware without knowing the rule, and a
// door called outside the queue (the CLI, Settings → AI) is unchanged: no
// scope, so `withCrucibleLease` releases in its own `finally` exactly as before.
//
// ── The act name, and the ruling it is owed ────────────────────────────────
//
// A lease carries ONE act, and Crucible refuses any name outside its own
// capability classes (`crucible/inflight.py`, `require_act_name`) — there is no
// name for "a row of acts". So a row-wide lease is stamped with **the act that
// OPENED it**, and the code says so out loud rather than pretending otherwise.
//
// What that is honest about: the lease answers *why is this model being held*,
// and "because this row started cleaning this book" is a true answer for the
// whole row. What it is NOT: a statement of what is running right now. That
// question is answered per request by `X-Crucible-Act`, which every act sets
// truthfully and which `/v1/activity` reports as the in-flight entry's act — so
// the lie Owen ruled out on 2026-09-13 (a simplify calling itself a translate)
// cannot happen here. A reader sees a `simplify` in flight under a lease opened
// for `clean`, which is two true facts.
//
// RULING OWED, recorded in `docs/CRUCIBLE_ROLLOUT_PLAN.md` §3: either Crucible
// gains a way to RE-STATE a lease's act (an act on the heartbeat, or a PATCH),
// or a lease carries a LIST of acts, or this stays as the opening act's name.
// It is not resolved here, because the vocabulary is the server's.

/**
 * The row a step is running under, or null outside the scheduler.
 *
 * `AsyncLocalStorage` rather than a module variable: two steps of two different
 * runs are in flight at once (that is the whole point of the slot sets), and a
 * single mutable "current row" would hand one run's lease to the other.
 */
const rowScope = new AsyncLocalStorage<string>();

function currentRow(): string | null {
  return rowScope.getStore() ?? null;
}

/** Leases held on behalf of a ROW rather than of one act. */
const rowLeases = new Map<string, CrucibleLease>();

/**
 * A RELEASE THAT HAS LEFT BUT NOT LANDED, per row.
 *
 * `settleStep` is synchronous by contract and fires `closeCrucibleRowLease`
 * without awaiting it, so between two steps of one row there is a moment when
 * this side has given the lease up and the SERVER still holds it. The next act
 * taking its lease in that moment is answered `409 leased` — by us, naming us —
 * and the row fails on a claim it made against itself.
 *
 * So a take for a row waits for that row's outstanding release first. It is not
 * a retry and not a sleep: it is the same promise, awaited by the one caller
 * that must not overtake it. Nothing else waits on it — a release is a courtesy
 * everywhere else, and the ttl is the mechanism.
 */
const rowReleases = new Map<string, Promise<void>>();

/**
 * Run one step inside its run's lease scope.
 *
 * Called by the scheduler around every step, leasing or not: a step that never
 * touches a Crucible simply never asks the scope for anything.
 */
export function withCrucibleRowScope<T>(row: string, fn: () => Promise<T>): Promise<T> {
  return rowScope.run(row, fn);
}

/**
 * Give back the lease a row was holding, if any. Idempotent; never throws.
 *
 * The scheduler calls it when the row has no next step that would use it —
 * which is what makes "one lease per row" mean *per consecutive run of acts*
 * rather than *for the life of the row*, so a lease is never held across an
 * assembly or an hour of narration.
 */
export async function closeCrucibleRowLease(row: string): Promise<void> {
  const lease = rowLeases.get(row);
  if (lease === undefined) return;
  rowLeases.delete(row);
  // Published BEFORE it is awaited, so the next act of this row — which may be
  // launched in the same tick, this call having been fired without an await —
  // finds it and waits rather than racing the server's own one-lease rule.
  const going = lease.release().finally(() => {
    if (rowReleases.get(row) === going) rowReleases.delete(row);
  });
  rowReleases.set(row, going);
  await going;
}

/** For a keeper, and for a log line: is this row holding one? */
export function crucibleRowLease(row: string): CrucibleLease | null {
  return rowLeases.get(row) ?? null;
}

/**
 * THE THREE CALLS THE SCHEDULER MAKES, composed once.
 *
 * `queue-engine.ts` takes this seam injected rather than imported, to keep its
 * one property (no Electron, no registry, no HTTP) — but that made the
 * COMPOSITION a thing each mount wrote out, and a keeper writing its own is a
 * keeper that can pass against a shape the app does not use. There is one
 * composition now: `queue-ipc.ts` mounts it, and the suites drive it.
 *
 * Deliberately not typed as `CrucibleLeaseHost`: importing that type would
 * make this module depend on the scheduler it is injected into. The shape is
 * structural, and `setCrucibleLeaseHost` is what checks it.
 */
export function crucibleLeaseSeam(): {
  withRowScope<T>(row: string, fn: () => Promise<T>): Promise<T>;
  closeRow(row: string): Promise<void>;
  leaseSubject(row: string): string | null;
} {
  return {
    withRowScope: withCrucibleRowScope,
    closeRow: closeCrucibleRowLease,
    // WHAT this run is holding, so the scheduler can compare it to what the
    // next act needs. A lease is per model and a server holds one, so keeping
    // it open across a change of model is a refusal this app hands itself.
    leaseSubject: (row: string): string | null => crucibleRowLease(row)?.leased ?? null,
  };
}

async function withRowLease<T>(
  row: string,
  options: CrucibleLeaseOptions,
  run: (lease: CrucibleLease) => Promise<T>,
): Promise<T> {
  /*
   * THE PREVIOUS ACT'S RELEASE MAY STILL BE IN THE AIR. The scheduler settles
   * synchronously and closes the row's lease without awaiting the DELETE, so
   * this act can begin while the server still believes the last one is held —
   * and a server holds ONE lease. Waited for, not retried: see `rowReleases`.
   */
  const going = rowReleases.get(row);
  if (going !== undefined) await going;
  const held = rowLeases.get(row);
  if (held !== undefined) {
    if (held.server === options.server && held.leased === options.id) {
      options.onLog?.(
        `[crucible] reusing this run's lease on "${options.id}" at ${options.server} — opened for `
        + `${held.act}, this act is ${options.act}. One lease per row, so the model is not `
        + 'unloaded between them.',
      );
      return run(held);
    }
    /*
     * A DIFFERENT MODEL OR A DIFFERENT MACHINE ends the run of acts the held
     * lease was for: a server holds ONE lease, and nothing this row does next
     * concerns the old one. Released before the take rather than after, because
     * a second lease on the same server would be refused `409 leased` — by us,
     * against ourselves.
     */
    options.onLog?.(
      `[crucible] this run's lease was on "${held.leased}" at ${held.server}; this act wants `
      + `"${options.id}" at ${options.server}, so the first is given back.`,
    );
    rowLeases.delete(row);
    await held.release();
  }
  const lease = await takeCrucibleLease(options);
  rowLeases.set(row, lease);
  /*
   * NO `finally` HERE, AND THAT IS THE WHOLE POINT. The lease outlives this
   * act. Every way it can still be given back: the scheduler closes the row
   * (`closeCrucibleRowLease`) when nothing follows, a later act of the same row
   * swaps it above, the app quits (`releaseAllCrucibleLeases`), or the ttl
   * expires — which is the mechanism, the other three being courtesies.
   */
  return run(lease);
}
