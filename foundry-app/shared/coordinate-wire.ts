/**
 * WHAT COORDINATING WITH A CRUCIBLE LOOKS LIKE FROM OUTSIDE — types only.
 *
 * crucible `docs/PHASE14-ENVPACKS.md` §4a, Owen 2026-09-14: *"if its present,
 * bookforge should coordinate with the installed crucible to make sure it has
 * what it needs to run all of its features."* The ruling is about the APP, not
 * about BookForge: Foundry asks a Crucible for a text engine and three models,
 * and the same sentence applies word for word. Nobody presses a button — the
 * presence of the app is the request. So there is no "set up for Foundry" verb
 * on this wire; there is a STATE, one per server, which the main process owns
 * (`electron/crucible-coordinate.ts`) and every screen draws.
 *
 * ── ASK, THEN ACT ──────────────────────────────────────────────────────────
 *
 * §4a as amended (crucible `cecfdd0`, from Foundry's own review of it):
 * connecting READS `GET /v1/info`, `GET /v1/catalog` and `GET /v1/capability`
 * and compares the vendored module (`shared/foundry.module.json`) against them.
 * The third read is §5.3a's (crucible `e342fee`): the module names CLASSES and
 * the engine's own capability record is the one place a class becomes an id, so
 * "is the translate model here" cannot be asked without it. Nothing missing
 * is a read and nothing else — no task is posted at all. That is not an
 * optimisation: a Crucible runs ONE task at a time, so a task whose whole
 * content would be `skipped` events is a task two apps arriving at once collide
 * on (`task_busy`), and one Foundry would be refused `server_busy` by its OWN
 * lease while its own translation is running. Only
 * {@link CrucibleCoordinationState} `preparing` involves a POST.
 *
 * ── AND NOTHING TO PRESS, ANYWHERE ─────────────────────────────────────────
 *
 * Owen, 2026-09-14: *"lets make it as simple as possible."* Coordination is
 * automatic on EVERY enabled server in the registry — the Crucible on this
 * machine and every remote, however long ago it was registered. There is no
 * consent step and no per-server question: opening Foundry on a laptop
 * connected to the Mac downloads onto the Mac whatever Foundry needs there and
 * is not. Saying "not that one" is done by switching the server OFF in
 * Settings, which is the one control that already means it (crucible
 * `1a10cc8`; a one-press consent on a foreign remote was proposed and overruled
 * for simplicity).
 *
 * IT RUNS HOSTED TOO. Inside BookForge the registry is the host's and read-only
 * (`crucible-registry.ts`), and each app still posts its OWN module: the union
 * of the two modules on one server is the contract, and a Foundry that declined
 * to ask would be a Foundry whose acts are dark on a machine BookForge had
 * already prepared for itself. What is suppressed hosted is the DRAWING, not
 * the asking — the Servers card is the host's over there.
 *
 * ── NOTHING HERE IS A SENTENCE ─────────────────────────────────────────────
 *
 * Every field is a FACT and the words are the renderer's
 * (`src/app/core/crucible-words.ts`). Two reasons, and the second is the
 * load-bearing one: a sentence composed in main would be a second wording of
 * the same state beside the one a screen already has to write for its own
 * layout (crucible ARCHITECTURE.md R1); and the app's copy says *GPU engine*
 * where this file says `server` and *the text model* where it says `subject`,
 * which is a translation rather than a spelling — the code keeps the contract's
 * names precisely so the copy can stop using them.
 *
 * This file is BookForge's `shared/crucible/coordinate-wire.ts` in shape and in
 * meaning, deliberately: the two apps coordinate with the same servers, and a
 * person who has both open must not be told two different stories about one
 * machine.
 */

/**
 * ONE CLASS THIS ENGINE DOES NOT SERVE — and it is NOT a thing that is missing.
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a: the module names CAPABILITY CLASSES and
 * the SERVER resolves each one through its own capability record. *"A class this
 * backend has DISABLED is not a refusal"* — the module task finishes `done` and
 * reports it, and the app shows "not on this engine". A Mac with no `pages`
 * block and a 12 GB box that cannot hold a 27B are both this, and neither is a
 * failure of anything: Foundry asked for five classes, that machine serves
 * three, and three is what it will do.
 *
 * WHICH IS WHY IT IS ITS OWN TYPE beside {@link CrucibleMissingEntry} rather
 * than a flag on one. A missing thing is a thing to DOWNLOAD and it goes away;
 * an unmet class is a fact about that machine and stays. Flattening them would
 * make a `stocked` server with two unmet classes indistinguishable from one
 * waiting on two downloads, which are opposite news.
 */
export interface CrucibleUnmetClass {
  /** `clean`, `translate`, `simplify`, `analysis`, `pages`. */
  readonly class: string;
  /**
   * WHY, IN THE ENGINE'S OWN WORDS — the capability row's `reason`, verbatim.
   * Never one composed here: the row said why the class is off, with the
   * shortfall in it, and a sentence of ours in its place is how a fixable
   * problem becomes an unfixable one.
   */
  readonly reason: string;
}

/**
 * One thing this server has not got that Foundry's module asks for.
 *
 * Composed by comparing the vendored module against `GET /v1/catalog`,
 * `GET /v1/info`'s `capabilities[].jobType` and `GET /v1/capability` — three
 * reads the server already owns the answer to, so nothing here is a second
 * table (R1).
 */
export type CrucibleMissingEntry =
  /** A job type whose environment this server has not installed. */
  | {
      readonly what: 'job-type';
      readonly jobType: string;
      /**
       * Only ever set for `tts`, where one venv serves one engine. Foundry's
       * module names no `tts`, so this is null on every entry this app can
       * produce today — it is carried anyway because the field is the module
       * file's (`CrucibleModule.job_types[].narrator_engine`) and a wire that
       * dropped it would have to grow it back the day Foundry asks for one.
       */
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
       * Every subject Foundry asks for is a `model`, so this is null for all
       * three of them today.
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
    }
  /**
   * WEIGHTS A CLASS RESOLVES TO, which this server has not pulled.
   *
   * crucible `docs/PHASE15-HOST.md` §5.3a. The module's `needs` carry CLASSES,
   * unresolved, and the engine's own capability record is what turns one into an
   * id — a different id per machine, which is the whole reason the generator
   * stopped doing it. So this app cannot say "the model `qwen3.8-27b-4bit` is
   * missing" without first reading that engine's `selected`, and having read it,
   * it knows BOTH halves: the class Foundry asked for and the subject that
   * engine picked for it.
   *
   * IT IS A SEPARATE VARIANT FROM `subject` BECAUSE THE CLASS IS THE HALF A
   * PERSON UNDERSTANDS. A row that said "the text model Qwen3.8 27B" for
   * `translate` and again for `simplify` would be saying one machine fact twice;
   * one that said it for `pages` would be wrong. The class is what the words are
   * composed from (`src/app/core/crucible-words.ts`), and the subject's name is
   * what is appended to it.
   */
  | {
      readonly what: 'class';
      /** `clean`, `translate`, `simplify`, `analysis`, `pages`. */
      readonly class: string;
      /** What THAT engine's capability record selected for the class. */
      readonly id: string;
      /**
       * The catalog row's kind — `model`, or `engine` for the llama.cpp
       * binaries a `llama-windows` server runs GGUF with (§3.10, fact 1).
       * `null` when the subject is not in that catalog at all, because the kind
       * is the catalog's to say and guessing `model` would be this app naming
       * something it did not read.
       */
      readonly kind: string | null;
      /** The manifest's display name, or null — then the id IS the name. */
      readonly name: string | null;
      /** Which job type these weights belong to, or null when uncatalogued. */
      readonly jobType: string | null;
      /** What the pull will fetch where the manifest declares it. Never 0. */
      readonly expectedBytes: number | null;
      /**
       * Was the selected subject in that server's catalog at all?
       *
       * `false` is a strange state and is carried rather than hidden: the
       * engine's own capability record named an id its own catalog does not
       * list. Posting the module is still right — the server resolves the class
       * itself and is the one owner of what a subject is — and the row has
       * already named what it could not find.
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
 * One frame of the `module` task a server runs for Foundry.
 *
 * Nothing posts one on a button (crucible `docs/PHASE14-ENVPACKS.md` §4a): it is
 * posted by `electron/crucible-coordinate.ts` when a READ of that server's
 * catalog says something is missing, and this shape travels inside
 * {@link CrucibleCoordinationState}'s `preparing`.
 *
 * Every field is a different kind of fact and they are separate for that
 * reason: `line` is the installer's own output and is NOT load-bearing (crucible
 * ARCHITECTURE.md R4), `bytes` is a pull's counts and is, and `step` is the only
 * thing that says where in the module this is.
 *
 * IT LIVES HERE RATHER THAN IN A SETTINGS WIRE OF ITS OWN, which is where
 * BookForge keeps it (`shared/crucible/settings-wire.ts`). Foundry has no such
 * file and no second reader of this shape: coordination is the only thing that
 * posts a task, so putting it beside the state it travels inside keeps the whole
 * of "what a module task looks like from outside" in one place.
 */
export interface CrucibleModuleProgress {
  /** The registry name of the server this task is running on. */
  readonly server: string;
  readonly taskId: string | null;
  readonly state: 'running' | 'done' | 'failed' | 'cancelled';
  /** `{name, index, total}` — for a module, one per entry plus the reload. */
  readonly step: { readonly name: string; readonly index: number; readonly total: number } | null;
  /** One line of pip's output. Draw it, never branch on it. */
  readonly line: string | null;
  /** A pull's byte counts. `total` is null where no manifest sizes it. */
  readonly bytes: {
    readonly done: number;
    readonly total: number | null;
    readonly file: string;
  } | null;
  /** A module entry that was already true. Idempotence, reported. */
  readonly skipped: string | null;
  /**
   * What the server offers after its reload step — the client is TOLD rather
   * than having to diff two `/v1/info` reads (§3.4). Null until that step.
   */
  readonly jobTypes: readonly string[] | null;
  /** The `failed` event's own code and message. Completed steps STAY (R6). */
  readonly error: { readonly code: string; readonly message: string } | null;
  /**
   * WHAT THE SERVER ITSELF SAID WAS UNMET — `TaskStatus.unmet` (crucible
   * PHASE15-HOST.md §5.3a), read once when the stream ends.
   *
   * `null` UNTIL THE TASK IS TERMINAL, and that is not the same as `[]`. The
   * events say nothing about unmet classes — the field is on the task document,
   * not on a frame — so a running task genuinely has no answer here, and an
   * empty array in its place would say "this engine serves everything Foundry
   * asked for" before the engine had been asked.
   *
   * IT IS THE ENGINE'S ANSWER, NOT THIS APP'S PREDICTION. The `unmet` on the
   * coordination state one type down is what Foundry worked out from the
   * capability record a moment BEFORE posting; this is what the server reports
   * having resolved every class through that same record. They should agree, and
   * where they do not, the server is right — it is the one that did the
   * resolving (PHASE9: the capability record is the one place a class is
   * resolved).
   */
  readonly unmet: readonly CrucibleUnmetClass[] | null;
}

/**
 * Where coordination with one server stands.
 *
 * A server with NO state is the fifth case and is deliberately not a member:
 * nothing has asked it yet, and "idle" drawn as a row of its own would be a
 * screen announcing the absence of news.
 *
 * ── `unmet` RIDES ON EVERY PHASE THAT COMPARED ────────────────────────────
 *
 * The three phases that have read that engine's capability record — `stocked`,
 * `preparing`, `waiting` — all carry {@link CrucibleUnmetClass}, because the
 * classes this engine does not serve are true of it whatever the downloads are
 * doing, and a half-hour wait is exactly when somebody wants to be told. **A
 * server with nothing missing and two unmet classes is `stocked`** with the two
 * named: nothing is missing, which is what the word means, and Foundry posts
 * nothing — the engine cannot be made to serve a class by downloading anything.
 */
export type CrucibleCoordinationState =
  /** Reading `/v1/info`, `/v1/catalog` and `/v1/capability`. No task, no card. */
  | { readonly server: string; readonly phase: 'checking' }
  /** The read said nothing is missing. ZERO posts. `unmet` may still have rows. */
  | {
      readonly server: string;
      readonly phase: 'stocked';
      readonly checkedAt: string;
      readonly unmet: readonly CrucibleUnmetClass[];
    }
  /** The module task is running — posted by us, or one we found and followed. */
  | {
      readonly server: string;
      readonly phase: 'preparing';
      readonly missing: readonly CrucibleMissingEntry[];
      /** What the capability record said this engine does not serve. */
      readonly unmet: readonly CrucibleUnmetClass[];
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
      /** What the capability record said this engine does not serve. */
      readonly unmet: readonly CrucibleUnmetClass[];
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
