/**
 * SET UP FOR BOOKFORGE — the one place this app says what it needs from a server.
 *
 * PHASE13-OPERATOR.md §5.4. A server row's button posts
 * `shared/crucible/bookforge.module.json` as a `module` task and draws the
 * task's own events in the row. That file is GENERATED in the crucible repo
 * from its manifests and vendored here byte for byte, which is what replaced
 * `BOOKFORGE_JOB_TYPES` and the printed pull list in `install.ts`: two
 * hand-kept restatements of ids the manifests already own, with nothing
 * comparing them (`tools/test-crucible-module-file.js` is now the thing that
 * does).
 *
 * ── WHAT THIS MODULE IS, AND WHAT IT IS NOT ────────────────────────────────
 *
 * It is a SUBMIT and a READ. It installs nothing itself, spawns nothing, and
 * knows nothing about envs or weights — the server does all of it, one task at
 * a time, and reports `step` / `progress` / `skipped` / `done` / `failed` on
 * its own SSE stream. This file's whole job is to hand those frames to a row.
 *
 * A module is IDEMPOTENT by the server's design: installed job types and
 * installed subjects inside a module are SKIPPED with a `skipped` event each
 * (§3.3). So the button is safe to press on a server that is already stocked,
 * and it is the honest way to find out whether one is.
 *
 * ── THE REFUSAL THAT MUST NOT READ AS A FAULT ──────────────────────────────
 *
 * §5.4, verbatim: when the post is refused `server_busy` because a LEASE is
 * open, the row shows the holder — *"held by foundry — translate,
 * qwen3.8-27b-4bit"* — and NOT a generic failure. A lease means another app on
 * the same machine is mid-run, which is the system working; an operator shown
 * a dead button with no name concludes the button is broken and presses it
 * until it is. The SDK's `CrucibleCardHeld` carries `fact` (`a job`, `a lease`,
 * `the claim`, `a chat`) and `who` (the server's own sentence), and both travel
 * to the row untranslated.
 */
import { CrucibleCardHeld, CrucibleRefused, type CrucibleModule } from '@crucible/client';

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
 * Post the module and stream the task to `onProgress`, one frame per event.
 *
 * Resolves when the task reaches a terminal state, with the state it reached —
 * it does NOT throw on `failed`. A failed module is a thing the row draws (the
 * step that failed, the code, the message), not an exception the row has to
 * reconstruct one from. It DOES throw when the post itself is refused, because
 * then there is no task and nothing to draw.
 */
export async function setUpServerForBookForge(
  server: string,
  onProgress: (progress: CrucibleModuleProgress) => void,
): Promise<CrucibleModuleProgress> {
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);

  let taskId: string;
  try {
    taskId = await client.submitTask({ type: 'module', module: BOOKFORGE_MODULE });
  } catch (err) {
    throw describeModuleRefusal(err, server);
  }

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
  return last;
}

/** Cancel the running task on a server. Answers `cancelling`, never `cancelled`. */
export async function cancelServerSetup(server: string, taskId: string): Promise<void> {
  const client = crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  await client.cancelTask(taskId);
}

/**
 * Turn a refused POST into a sentence a ROW can show, with the holder named.
 *
 * `CrucibleCardHeld` first and by itself, because it is the refusal §5.4 says
 * must never render as a generic failure. Everything else keeps the server's
 * own code and message — `task_busy` naming the running task, `invalid_module`,
 * `unknown_subject` — which is what "refused by name" means at a button.
 */
export function describeModuleRefusal(err: unknown, server: string): Error {
  if (err instanceof CrucibleCardHeld) {
    const refusal = new Error(
      `crucible "${server}" cannot be set up right now: ${err.heldLine}. That is the system `
      + 'working, not a fault — another app on that machine is mid-run and installing a job '
      + 'type restarts the server\'s registry. Press this again when it lands.',
    );
    refusal.name = 'CrucibleCardHeld';
    return refusal;
  }
  if (err instanceof CrucibleRefused) {
    return new Error(`crucible "${server}" refused ${err.code}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
