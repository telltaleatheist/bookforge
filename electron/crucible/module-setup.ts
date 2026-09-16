/**
 * WHAT BOOKFORGE NEEDS FROM A SERVER, and the two acts that state it.
 *
 * PHASE13-OPERATOR.md §5.4 and PHASE14-ENVPACKS.md §4a.
 * `shared/crucible/bookforge.module.json` is GENERATED in the crucible repo
 * from its manifests and vendored here byte for byte, which is what replaced
 * `BOOKFORGE_JOB_TYPES` and the printed pull list in `install.ts`: two
 * hand-kept restatements of ids the manifests already own, with nothing
 * comparing them (`tools/test-crucible-module-file.js` is now the thing that
 * does).
 *
 * ── THERE IS NO "SET UP FOR BOOKFORGE" VERB HERE ANY MORE ──────────────────
 *
 * §4a deleted the button: presence of the app is the request. What posts this
 * module is `coordinate.ts`, and only when a READ of `GET /v1/catalog` says
 * something is missing. This file is left with the two mechanical halves —
 * {@link postBookForgeModule} and {@link followModuleTask} — because
 * coordination needs them separately: a task already running on a server is
 * FOLLOWED rather than re-posted, and following it is the same frame
 * translation as watching our own.
 *
 * ── WHAT THIS MODULE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * It is a SUBMIT and a READ. It installs nothing itself, spawns nothing, and
 * knows nothing about envs or weights — the server does all of it, one task at
 * a time, and reports `step` / `progress` / `skipped` / `done` / `failed` on
 * its own SSE stream. This file's whole job is to hand those frames on.
 *
 * A module is IDEMPOTENT by the server's design: installed job types and
 * installed subjects inside a module are SKIPPED with a `skipped` event each
 * (§3.3). Idempotence is what makes a post safe when the catalog read and the
 * post race; it is NOT a licence to post one on every connect, which is the
 * thing §4a's amendment forbids.
 *
 * ── THE REFUSAL THAT MUST NOT READ AS A FAULT ──────────────────────────────
 *
 * §5.4, verbatim: when the post is refused `server_busy` because a LEASE is
 * open, the row shows the holder — *"held by foundry — translate,
 * qwen3.8-27b-4bit"* — and NOT a generic failure. A lease means another app on
 * the same machine is mid-run, which is the system working; an operator shown
 * a dead control with no name concludes it is broken. The SDK's
 * `CrucibleCardHeld` carries `fact` (`a job`, `a lease`, `the claim`, `a chat`)
 * and `who` (the server's own sentence), and both travel to the row
 * untranslated.
 */
import type { CrucibleModule } from '@crucible/client';

import { crucibleClientFor, CRUCIBLE_CLIENT_NAME } from './servers';
import type { CrucibleModuleProgress } from '../../shared/crucible/settings-wire';

/*
 * THE VENDORED FILE ITSELF, imported so tsc copies it into dist and there is
 * exactly one of it. Read as the SDK's own `CrucibleModule` — the server's
 * snake_case spelling, not a camelCased mirror — because posting the module
 * means posting exactly those bytes.
 */
import bookforgeModule from '../../shared/crucible/bookforge.module.json';

/** What BookForge asks a Crucible for. The generated file, unedited. */
export const BOOKFORGE_MODULE: CrucibleModule = bookforgeModule as CrucibleModule;

/** The job types the module asks for, for a screen that wants to name them. */
export function bookforgeModuleJobTypes(): string[] {
  return BOOKFORGE_MODULE.job_types.map((entry) =>
    (entry.narrator_engine === undefined
      ? entry.type
      : `${entry.type} (${entry.narrator_engine})`));
}

/** The subjects the module asks for, `kind/id`, for the same reason. */
export function bookforgeModuleSubjects(): string[] {
  return BOOKFORGE_MODULE.subjects.map((s) => `${s.kind}/${s.id}`);
}

/**
 * Post the module. Answers the task id; THROWS every refusal untranslated.
 *
 * The refusal is not described here on purpose: `coordinate.ts` discriminates
 * `server_busy` (a wait), `task_busy` (follow the other one) and a refusal
 * about the request (fail once by name), and each of those is a different act.
 * A function that flattened all three into an `Error` would force the caller to
 * read the sentence back out of it.
 */
/**
 * THE MODULE AS THIS BACKEND CAN HOLD IT — subjects scoped to it, `backends`
 * stripped.
 *
 * ── Why a module is not one list any more ──────────────────────────────────
 *
 * `crucible/modules.py` used to say a module "is posted to a Mac and a PC alike
 * and must name the same subjects on both". That is true of every subject in
 * the build except the transcribers, and there it is permanently false:
 * CTranslate2 has no Metal backend, so `faster-whisper-*` exists only on
 * cuda-linux and `mlx-whisper-*` only on mlx-darwin. BookForge named the first
 * and the Mac refused the WHOLE module rather than part of it —
 *
 *   invalid_module: subjects[0]: this server has no model called
 *   'faster-whisper-large-v3' for mlx-darwin
 *
 * — which is `validate_module` behaving exactly as designed ("read a whole
 * module or refuse the whole of it. Never half.") on a file that was wrong.
 *
 * ── Why the filtering is here and not on the server ────────────────────────
 *
 * `backends` is a GENERATED field: the id and the backends it exists on both
 * come from the manifests, so nothing here chooses anything — the choice of
 * large-v3 over distil is still stated once, in `modules/bookforge.toml`.
 *
 * And the key is STRIPPED because `validate_module` refuses a subject carrying
 * an unknown key. That is what lets this ship today against Crucibles that are
 * already installed — including the Mac's, which is a pip install in a conda
 * env and not a checkout somebody can pull. A server-side `backends` would be
 * the tidier place for this rule and would require every engine to be updated
 * before any app could post the new file at all.
 */
export function moduleForBackend(backend: string): CrucibleModule {
  const subjects = BOOKFORGE_MODULE.subjects
    .filter((subject) => {
      const where = (subject as { backends?: string[] }).backends;
      /*
       * A subject with NO `backends` is one this build wrote before the field
       * existed, and it means what it always meant: everywhere. Refusing it
       * here would make an older vendored file unpostable, which is the
       * opposite of what stripping the key is for.
       */
      return where === undefined || where.includes(backend);
    })
    .map((subject) => {
      // Rebuilt from its two wire fields rather than spread-minus-`backends`:
      // the wire shape is `{kind, id}` exactly, and a future generated field
      // should reach a server only when somebody has decided it should.
      const { kind, id } = subject as { kind: CrucibleModule['subjects'][number]['kind']; id: string };
      return { kind, id };
    });
  return { ...BOOKFORGE_MODULE, subjects };
}

export async function postBookForgeModule(server: string): Promise<string> {
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  /*
   * ASKED OF THE SERVER, not read from a cache. Which backend a name resolves
   * to is the SERVER's fact (crucible's division of knowledge: the client knows
   * the order and the server, the server knows the engine), and this is one
   * cheap read immediately before a multi-gigabyte install decides what to
   * fetch. A stale answer here installs the wrong transcriber.
   */
  const backend = (await client.info()).host.backend;
  return client.submitTask({ type: 'module', module: moduleForBackend(backend) });
}

/**
 * Follow a module task to its end, one frame per event.
 *
 * Resolves when the task reaches a terminal state, with the state it reached —
 * it does NOT throw on `failed`. A failed module is a thing a screen draws (the
 * step that failed, the code, the message), not an exception it has to
 * reconstruct one from.
 *
 * The task id may be ours or somebody else's: a Crucible runs one task at a
 * time, so the module we would have posted and the task already running are
 * competing for the same slot, and joining the stream of the one in progress is
 * strictly better than queueing a second (PHASE13 §3.3 has no queue for tasks).
 *
 * ── AND ONE READ AFTER THE STREAM, FOR `unmet` ─────────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a puts the classes this engine does not
 * serve on the TASK DOCUMENT (`TaskStatus.unmet`) and on no frame of its
 * stream, so it cannot be taken off the terminal event — `done`'s data is an
 * open record and the SDK types it as one. `GET /v1/tasks/{id}` once, after the
 * last frame, is the whole cost, and it is the SERVER's own answer rather than
 * the prediction `coordinate.ts` made from the same capability record a moment
 * earlier.
 *
 * IT DOES NOT FAIL THE FOLLOW. A task that ran to `done` and then could not be
 * re-read is a task that ran to `done`; turning that into a failure would
 * report a finished install as broken because a laptop lid closed a second
 * later. `unmet` stays `null` in that case, which is exactly what it means —
 * nobody said.
 */
export async function followModuleTask(
  server: string,
  taskId: string,
  onProgress: (progress: CrucibleModuleProgress) => void,
): Promise<CrucibleModuleProgress> {
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);

  let last: CrucibleModuleProgress = {
    server,
    taskId,
    state: 'running',
    step: null,
    line: null,
    bytes: null,
    skipped: null,
    jobTypes: null,
    error: null,
    unmet: null,
  };
  onProgress(last);

  for await (const event of client.taskEvents(taskId)) {
    switch (event.event) {
      case 'started':
        last = { ...last, state: 'running' };
        break;
      case 'step':
        last = {
          ...last,
          state: 'running',
          step: { name: event.data.name, index: event.data.index, total: event.data.total },
          // The `reload` step carries what became reachable, so a client is TOLD
          // rather than having to diff two /v1/info reads (§3.4).
          jobTypes: event.data.jobTypes === undefined ? last.jobTypes : [...event.data.jobTypes],
          line: null,
          bytes: null,
          skipped: null,
        };
        break;
      case 'progress':
        // An install's line is pip's own text and is NOT load-bearing (R4); a
        // pull's counts are. They are separate fields for that reason, rather
        // than one "message" a row would have to guess the meaning of.
        last = 'line' in event.data
          ? { ...last, line: event.data.line, bytes: null }
          : {
              ...last,
              line: null,
              bytes: {
                done: event.data.bytesDone,
                total: event.data.bytesTotal,
                file: event.data.file,
              },
            };
        break;
      case 'skipped':
        last = { ...last, skipped: event.data.reason };
        break;
      case 'done':
        last = { ...last, state: 'done', line: null, bytes: null, error: null };
        break;
      case 'failed':
        // R6: the steps that completed STAY — the envs and the weights are on
        // disk. The row says which step, and pressing the button again skips
        // everything that is already true.
        last = {
          ...last,
          state: 'failed',
          error: { code: event.data.code, message: event.data.message },
        };
        break;
      case 'cancelled':
        last = { ...last, state: 'cancelled' };
        break;
      default:
        // An event kind this build has never heard of. The SDK yields it rather
        // than throwing, for the reason it says: losing the whole stream over
        // one frame is worse than ignoring the frame.
        break;
    }
    onProgress(last);
  }

  try {
    const status = await client.task(taskId);
    last = {
      ...last,
      unmet: status.unmet.map((need) => ({ class: need.class, reason: need.reason })),
    };
    onProgress(last);
  } catch (err) {
    /*
     * SWALLOWED, AND `unmet` STAYS NULL. See the note above: the stream
     * already said what happened to the work, and a re-read that did not land
     * is a question nobody answered rather than a task that went wrong. This
     * is NOT a fallback — nothing is guessed in its place, and `null` is the
     * one value on that field that means "the server was not asked".
     */
    void err;
  }
  return last;
}

/** Cancel the running task on a server. Answers `cancelling`, never `cancelled`. */
export async function cancelServerSetup(server: string, taskId: string): Promise<void> {
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  await client.cancelTask(taskId);
}
