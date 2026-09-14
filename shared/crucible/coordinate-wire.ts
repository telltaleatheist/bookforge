/**
 * WHAT COORDINATING WITH A CRUCIBLE LOOKS LIKE FROM OUTSIDE — types only.
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a, Owen 2026-09-14: *"if its present,
 * bookforge should coordinate with the installed crucible to make sure it has
 * what it needs to run all of its features."* Nobody presses a button: the
 * presence of the app is the request. So there is no longer a "Set up for
 * BookForge" verb on this wire — there is a STATE, one per server, which the
 * main process owns (`electron/crucible/coordinate.ts`) and every screen draws.
 *
 * ── ASK, THEN ACT ──────────────────────────────────────────────────────────
 *
 * §4a as amended (crucible `cecfdd0`, from Foundry's review): connecting READS
 * `GET /v1/catalog` and compares the module against it. Nothing missing is a
 * read and nothing else — no task is posted at all. That is not an optimisation:
 * a Crucible runs ONE task at a time, so a task whose whole content would be
 * `skipped` events is a task two apps arriving at once collide on
 * (`task_busy`), and one BookForge would be refused `server_busy` by its OWN
 * lease while its own book is running. Only {@link CrucibleCoordinationState}
 * `preparing` involves a POST.
 *
 * ── AND NOTHING TO PRESS, ANYWHERE ─────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"lets make it as simple as possible."* Coordination is
 * automatic on EVERY server this app is connected to — this machine's and every
 * remote, however long ago it was registered. There is no consent step and no
 * per-server question: opening BookForge on a laptop connected to the Mac
 * downloads onto the Mac whatever BookForge needs there and is not. Saying "not
 * that one" is done by DISABLING the server in Settings, which is the one
 * switch that already means it (crucible `1a10cc8`; a one-press consent on a
 * foreign remote was proposed by Foundry and overruled for simplicity).
 *
 * ── NOTHING HERE IS A SENTENCE ─────────────────────────────────────────────
 *
 * Every field is a FACT and the words are the renderer's
 * (`src/app/features/settings/components/crucible-words.ts`). Two reasons, and
 * the second is the load-bearing one: a sentence composed in main would be a
 * second wording of the same state beside the one a screen already has to write
 * for its own layout (crucible ARCHITECTURE.md R1); and the app's copy says
 * *GPU engine* where this file says `server` and *narration engine* where it
 * says `tts`, which is a translation, not a spelling — the code keeps its names
 * precisely so the copy can stop using them.
 */

import type { CrucibleModuleProgress } from './settings-wire';

/**
 * One thing this server has not got that BookForge's module asks for.
 *
 * Composed by comparing the vendored module against `GET /v1/catalog` and
 * `GET /v1/info`'s `capabilities[].jobType` — both reads the server already
 * owns the answer to, so nothing here is a second table (R1).
 */
export type CrucibleMissingEntry =
  /** A job type whose environment this server has not installed. */
  | {
      readonly what: 'job-type';
      readonly jobType: string;
      /** Only ever set for `tts`, where one venv serves one engine. */
      readonly narratorEngine: string | null;
    }
  /** Weights this server has not pulled. */
  | {
      readonly what: 'subject';
      /** `model`, `voice`, `rvc`, `rvc-base`, `denoise`. */
      readonly kind: string;
      readonly id: string;
      /**
       * The manifest's display name, or `null` where the manifest carries none
       * — in which case the id IS the name, which is the honest thing to show.
       */
      readonly name: string | null;
      /** Which job type these weights belong to, or null when uncatalogued. */
      readonly jobType: string | null;
      /**
       * What the pull will fetch, where the manifest declares it.
       *
       * **`null` is "size not declared" and never 0.** Models and voices are a
       * whole-repo snapshot no manifest sizes (PHASE13 §3.2), and a screen that
       * printed "0 GB to download" would be stating a number nobody measured.
       */
      readonly expectedBytes: number | null;
      /**
       * Was this subject in the catalog at all?
       *
       * `false` means this backend has no block for it — posting the module
       * will be refused `unknown_subject`, BY THE SERVER, which is the one
       * owner of what a subject is. It is carried rather than silently dropped
       * so the refusal, when it arrives, is about something the row already
       * named.
       */
      readonly inCatalog: boolean;
    };

/**
 * Who is holding the card, out of a `409 server_busy`'s `details` (PHASE13
 * §3.3). Both halves travel untranslated: `fact` is which of the four things
 * holds it and `who` is the server's own sentence about the holder.
 */
export interface CrucibleCoordinationHolder {
  /** `a job`, `a lease`, `the claim` or `a chat`. */
  readonly fact: string;
  /** The server's own words. Shown verbatim — §5.4 forbids a generic failure. */
  readonly who: string;
}

/**
 * Where coordination with one server stands.
 *
 * A server with NO state is the fifth case and is deliberately not a member:
 * nothing has asked it yet, and "idle" drawn as a row of its own would be a
 * screen announcing the absence of news.
 */
export type CrucibleCoordinationState =
  /** Reading `/v1/info` and `/v1/catalog`. No task, no lane, no card. */
  | { readonly server: string; readonly phase: 'checking' }
  /** The read said nothing is missing. ZERO posts. */
  | { readonly server: string; readonly phase: 'stocked'; readonly checkedAt: string }
  /** The module task is running — posted by us, or one we found and followed. */
  | {
      readonly server: string;
      readonly phase: 'preparing';
      readonly missing: readonly CrucibleMissingEntry[];
      readonly progress: CrucibleModuleProgress;
      /** True when this task was already running and we joined it (`task_busy`). */
      readonly followed: boolean;
    }
  /**
   * `409 server_busy`: the card is held. A WAIT with the holder named, never a
   * failure — the queue's admission hold, one layer out.
   */
  | {
      readonly server: string;
      readonly phase: 'waiting';
      readonly missing: readonly CrucibleMissingEntry[];
      readonly holder: CrucibleCoordinationHolder;
      /** How many times the card has been asked about. 1 on the first refusal. */
      readonly attempts: number;
      /**
       * The wait gave up asking. Not a failure and not a timeout on the work:
       * the next connect starts it again. A wait that polled for ever would be
       * an app holding an opinion about somebody else's afternoon.
       */
      readonly stopped: boolean;
    }
  /**
   * A refusal about the REQUEST — `invalid_module`, `unknown_subject`. Fails
   * ONCE, by name: it will not be posted again this session, because the
   * vendored file cannot change while the app is running and re-posting it
   * would be the same wrong answer on a timer.
   */
  | {
      readonly server: string;
      readonly phase: 'refused';
      readonly code: string;
      readonly message: string;
    }
  /** Nothing answered, or it answered something else. Nothing was posted. */
  | { readonly server: string; readonly phase: 'unreachable'; readonly message: string };

/** Every server coordination has anything to say about, by name. */
export type CrucibleCoordinationMap = Readonly<Record<string, CrucibleCoordinationState>>;
