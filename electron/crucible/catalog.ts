/**
 * THE CATALOG DOOR — what a server could hold, and getting it there.
 *
 * Read `shared/crucible/catalog-wire.ts` first; it says why this exists and
 * what "connected to HuggingFace" honestly means. This file is the projection:
 * the SDK's types in, that wire's shapes out, exactly the job `probe.ts` and
 * `engine-settings.ts` do for the other three documents. The renderer has no
 * `@crucible/client` and must not re-spell its types, so ONE module carries
 * each answer across the seam (crucible ARCHITECTURE.md R1).
 *
 * NOTHING IS CACHED. Every call reads the server. "What is installed" is a
 * claim about somebody else's disk and it changes without asking this app —
 * the operator's page pulls, the other app's module post pulls, a `--purge`
 * removes — so a remembered answer is a wrong answer waiting for a screen to
 * draw it.
 */
import { CrucibleRefused, type CatalogRow, type SubjectKind } from '@crucible/client';
import type {
  CrucibleCatalogRow,
  CrucibleCatalogView,
  CrucibleRemovalPrompt,
  CrucibleSubjectKind,
} from '../../shared/crucible/catalog-wire';
import { CRUCIBLE_SUBJECT_KINDS } from '../../shared/crucible/catalog-wire';
import type { CrucibleModuleProgress } from '../../shared/crucible/settings-wire';
import { crucibleClientFor, CRUCIBLE_CLIENT_NAME } from './servers';
import { followCrucibleTask } from './module-setup';

/**
 * THE TWO ASSIGNMENTS THAT KEEP THE MIRROR HONEST.
 *
 * `CrucibleSubjectKind` is a hand-written copy of the SDK's `SubjectKind`, and
 * the SDK's own comment records what happens to hand-written copies of it: a
 * five-member mirror of a six-member union shipped an engine that could not
 * fetch its own llama.cpp. These two lines make the compiler the checker.
 * Widening either union without the other is a build error, and a build error
 * is the cheapest possible day to find out.
 *
 * They are `const` rather than a type alias so that nothing can satisfy them by
 * being `any`.
 */
const _kindIsTheSdks: SubjectKind = 'model' as CrucibleSubjectKind;
const _sdksIsTheKind: CrucibleSubjectKind = 'model' as SubjectKind;
void _kindIsTheSdks; void _sdksIsTheKind;

function subjectKind(value: SubjectKind): CrucibleSubjectKind {
  /*
   * NOT A CAST. The two unions are pinned identical above, but the value on
   * this wire arrives from a server that may be NEWER than this build — the
   * SDK yields an unknown event kind rather than throwing, and a seventh
   * subject kind would arrive here the same way. Refusing it by name beats
   * drawing a row whose kind nothing can act on.
   */
  if ((CRUCIBLE_SUBJECT_KINDS as readonly string[]).includes(value)) {
    return value as CrucibleSubjectKind;
  }
  throw new Error(
    `This Crucible offers a subject kind BookForge has never heard of: "${value}". `
    + `This build knows: ${CRUCIBLE_SUBJECT_KINDS.join(', ')}. Update BookForge.`,
  );
}

function projectRow(row: CatalogRow): CrucibleCatalogRow {
  return {
    kind: subjectKind(row.kind),
    id: row.id,
    name: row.name,
    jobType: row.jobType,
    installed: row.installed,
    installedBytes: row.installedBytes,
    expectedBytes: row.expectedBytes,
    floors: row.floors === null ? null : [...row.floors],
    source: row.source,
    resident: row.resident,
  };
}

/** `GET /v1/catalog` — every subject this server's backend can hold. */
export async function readCrucibleCatalog(server: string): Promise<CrucibleCatalogView> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  const rows = await client.catalog();
  return { server, rows: rows.map(projectRow) };
}

/**
 * Submit a `pull` and follow it to its end.
 *
 * ── Why the caller is told the task id before it finishes ──────────────────
 *
 * It is not: this resolves with the terminal frame. The id travels on every
 * PROGRESS frame instead (`CrucibleModuleProgress.taskId`), which is what a
 * Cancel button needs and is the first thing the first frame carries.
 *
 * ── The refusals, and which are ordinary ───────────────────────────────────
 *
 * `already_installed` is the server refusing a pull of something it already
 * has, and §3.3 makes that deliberate — a single pull is a person asking for
 * one specific thing, so being told it is already there is the answer, not an
 * error. `task_busy` names the task in the way. Both cross as refusals with
 * their code intact; NEITHER is retried here, because queues belong to clients
 * (ARCHITECTURE.md R5) and a settings page's contribution to backing off is
 * saying exactly what is in the way.
 */
export async function pullCrucibleSubject(
  server: string,
  kind: CrucibleSubjectKind,
  id: string,
  onProgress: (progress: CrucibleModuleProgress) => void,
): Promise<CrucibleModuleProgress> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  const taskId = await client.submitTask({ type: 'pull', kind, id });
  return followCrucibleTask(server, taskId, onProgress);
}

/**
 * What a removal would take with it — read from the catalog, so the confirm
 * names the SIZE rather than "a file" (crucible `docs/MODEL-CHOICE.md` §7).
 *
 * A subject that is not in the catalog at all, or is not installed, is refused
 * here rather than at the delete door. The page should not have offered a
 * Remove button for either, so being told so is how that bug becomes visible.
 */
export async function crucibleRemovalPrompt(
  server: string,
  kind: CrucibleSubjectKind,
  id: string,
): Promise<CrucibleRemovalPrompt> {
  const { rows } = await readCrucibleCatalog(server);
  const row = rows.find((entry) => entry.kind === kind && entry.id === id);
  if (row === undefined) {
    throw new Error(`${server} has no ${kind} called "${id}" in its catalog.`);
  }
  if (!row.installed) {
    throw new Error(`${row.id} is not installed on ${server}, so there is nothing to remove.`);
  }
  return {
    kind: row.kind,
    id: row.id,
    name: row.name,
    installedBytes: row.installedBytes,
    resident: row.resident,
  };
}

/**
 * `DELETE /v1/catalog/{kind}/{id}` — remove an installed subject's files.
 *
 * **The caller must already have said so on screen.** That condition is the
 * SDK's and it is not softened here: this function does not confirm, does not
 * prompt, and does not check whether anybody was asked. It deletes.
 *
 * Refused by name, and each name is a different thing to do about it:
 * `subject_unknown`, `subject_not_installed`, `subject_in_use` (`details.who`
 * says what is holding it) and `subject_remove_failed` (`details.path` says
 * which file would not go). None is retried.
 */
export async function removeCrucibleSubject(
  server: string,
  kind: CrucibleSubjectKind,
  id: string,
): Promise<void> {
  const client = await crucibleClientFor(server, CRUCIBLE_CLIENT_NAME);
  await client.removeSubject(kind, id);
}

/** The server's own refusal code, where it gave one. Never renamed in transit. */
export function crucibleCatalogRefusalCode(err: unknown): string | null {
  return err instanceof CrucibleRefused ? err.code : null;
}
