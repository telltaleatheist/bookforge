/**
 * crucible-models — what an engine holds, what it could fetch, and the fetch.
 *
 * ── Why this module exists again ───────────────────────────────────────────
 *
 * PHASE13 (2026-09-14) moved the pull list onto Crucible's own operator page and
 * deleted it from both apps. Owen reversed that on 2026-09-16 — *"the Ollama
 * standard"*, crucible `docs/INTENT.md`: Crucible is set-and-forget, and all
 * configuration happens THROUGH the apps. The person's only direct contact with
 * Crucible is the tray icon and the installer.
 *
 * ── THE ENGINE DECIDES; THIS MODULE ASKS AND REPORTS ──────────────────────
 *
 * The rule, agreed with BookForge 2026-09-16 and the same one the fit estimate
 * follows: **the side that can see the thing at the moment it matters is the
 * side that says so.** Concretely, and each of these was a real temptation:
 *
 *   * NO DISK CHECK HERE. `install.sh` prices the server pack in the guest and
 *     refuses `pack_disk` with the exact number before a byte moves. A check in
 *     this process would be measuring the wrong filesystem on Windows — the
 *     engine's disk is inside WSL — and would be a second, worse copy of a rule
 *     that already refuses by name.
 *   * NO SIZE INVENTED. `expectedBytes` is null for every model
 *     (`CrucibleCatalogRow` carries the contract's own words). The panel says it
 *     is not known rather than borrowing a number from somewhere it fits.
 *   * NO FIT VERDICT. That belongs to `/v1/settings`'s `local_model_choices`,
 *     and even there it is an estimate that excludes the KV cache.
 *
 * ── ONE FOLLOWER FOR EVERY TASK ───────────────────────────────────────────
 *
 * The pull's progress comes from `followTask` (electron/crucible-coordinate.ts),
 * the same loop the module task uses, because the SDK emits the same frames for
 * both. A second copy would be two readers of one event vocabulary, drifting the
 * first time the server adds a frame.
 */
import { followTask } from './crucible-coordinate';
import { crucibleServerNamed, engineClientFor } from './crucible-registry';
import {
  SUBJECT_KINDS,
  type CrucibleCatalogRow,
  type CruciblePullProgress,
  type CrucibleSubjectKind,
} from '../shared/model-wire';

/**
 * WHAT THIS ENGINE HOLDS AND COULD HOLD.
 *
 * NOT FILTERED TO FOUNDRY'S OWN CLASSES, unlike the assignment card, and the
 * difference is deliberate. The assignment card answers *"which model runs MY
 * act"*, so a row for `tts` there would be noise. This answers *"what is on this
 * machine"* — and a person looking at a disk is asking about the whole disk. A
 * Foundry that hid BookForge's voices would be telling somebody their 24 GB card
 * holds less than it does, which is the question the panel exists to answer.
 * The CARD decides what to draw; this reports what is there.
 */
export async function engineCatalog(server: string): Promise<CrucibleCatalogRow[]> {
  const entry = crucibleServerNamed(server);
  if (entry === null) {
    throw new Error(
      `"${server}" is not a registered engine, so there is nothing to list. It may have been `
      + 'renamed or removed while this screen was open.',
    );
  }
  const rows = await (await engineClientFor(entry)).catalog();
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    name: row.name,
    jobType: row.jobType,
    installed: row.installed,
    installedBytes: row.installedBytes,
    expectedBytes: row.expectedBytes,
    floors: row.floors === null ? null : [...row.floors],
    source: row.source,
  }));
}

/**
 * FETCH ONE SUBJECT, reporting as it goes.
 *
 * ── IT DOES NOT AWAIT THE PULL ────────────────────────────────────────────
 *
 * The door answers the TASK ID as soon as the server has one, and the progress
 * arrives on the callback afterwards. A model is gigabytes over somebody's
 * domestic line; an IPC call that did not return until it finished would be a
 * settings window that appears to hang for an hour, and an Electron handler
 * holding a promise that long is one the renderer cannot even be told about.
 *
 * ── A FAILED PULL LEAVES WHAT IT FETCHED ──────────────────────────────────
 *
 * ARCHITECTURE.md R6: the steps that completed STAY. So a failure here is
 * reported as a failure of THIS attempt, never as "nothing happened" — the next
 * pull skips what is already on disk, and a sentence implying the bytes were
 * thrown away would send somebody to re-fetch what they already have.
 */
export async function pullSubject(
  server: string,
  kind: string,
  id: string,
  onProgress: (progress: CruciblePullProgress) => void,
): Promise<string> {
  /*
   * THE KIND IS CHECKED, NOT CAST. It arrives across the preload as a string and
   * every legitimate one came off a catalog row this module itself mapped — so
   * a word that is not one of the five means either a renderer sending
   * something it made up, or an engine newer than this build. Both deserve a
   * sentence naming the word; neither deserves a cast that turns into a 400
   * three layers down, phrased in a vocabulary this side cannot see.
   */
  if (!SUBJECT_KINDS.includes(kind as CrucibleSubjectKind)) {
    throw new Error(
      `"${kind}" is not a kind of thing this build of Foundry knows how to fetch. It expects one `
      + `of ${SUBJECT_KINDS.join(', ')} — a newer engine may offer more.`,
    );
  }
  const subject = kind as CrucibleSubjectKind;
  const entry = crucibleServerNamed(server);
  if (entry === null) {
    throw new Error(
      `"${server}" is not a registered engine, so there is nowhere to fetch "${id}" to.`,
    );
  }
  const taskId = await (await engineClientFor(entry)).submitTask({ type: 'pull', kind: subject, id });

  /*
   * FOLLOWED WITHOUT BEING AWAITED, and the catch is not optional: this promise
   * has no caller to reject to. A stream that dies mid-pull — the engine
   * restarts, the tunnel drops — must arrive as a `failed` progress frame that
   * the card can draw, not as an unhandled rejection in main with the panel
   * still spinning.
   */
  void followTask(server, taskId, (progress) => {
    onProgress({
      server,
      taskId,
      kind: subject,
      id,
      state: progress.state,
      step: progress.step,
      bytes: progress.bytes,
      skipped: progress.skipped,
      error: progress.error,
    });
  }).catch((err: unknown) => {
    onProgress({
      server,
      taskId,
      kind: subject,
      id,
      state: 'failed',
      step: null,
      bytes: null,
      skipped: null,
      error: {
        code: 'pull_not_followed',
        message: 'The fetch was started and this window stopped hearing about it: '
          + `${err instanceof Error ? err.message : String(err)}. `
          + 'Whatever it had already written is still on that machine, and starting it again '
          + 'skips what is there.',
      },
    });
  });

  return taskId;
}

/**
 * REMOVE ONE SUBJECT'S FILES FROM THAT MACHINE.
 *
 * ── The ruling, and the contract note it supersedes ───────────────────────
 *
 * The SDK's own comment on `removeSubject` says *"3.5a is explicit that neither
 * BookForge nor Foundry calls it in this phase; the host does, and an operator
 * does from the page."* That was PHASE15's division, and Owen reversed it on
 * 2026-09-16: *"they sohuld have a way to delete models from crucible, too.
 * probably through bookforge/foundry settings"*, which crucible's own
 * `docs/MODEL-CHOICE.md` then spells out as the app getting the delete button
 * wired to that route. The SDK's sentence is stale in the same way its *"five
 * things a subject can be"* was — the prose did not move with the ruling.
 *
 * ── WHAT DOES NOT CHANGE IS THE CONDITION ON IT ──────────────────────────
 *
 * *"An app does not call this on a user's behalf without saying so on screen."*
 * That clause survives the reversal intact, and it is why this is reached only
 * from a confirmed press: the door is not called to tidy up, not called because
 * a different model was chosen, and never called without the person having read
 * what goes and how much it frees.
 *
 * ── THE FOUR REFUSALS ARE THE SERVER'S AND ARE NOT RETRIED ───────────────
 *
 * `subject_unknown`, `subject_not_installed`, `subject_in_use` (whose
 * `details.who` names what is holding it) and `subject_remove_failed` (whose
 * `details.path` names the file that would not go). Each is a different thing
 * for a person to do, so each arrives as its own sentence rather than as "could
 * not remove".
 */
export async function removeModel(server: string, kind: string, id: string): Promise<void> {
  if (!SUBJECT_KINDS.includes(kind as CrucibleSubjectKind)) {
    throw new Error(
      `"${kind}" is not a kind of thing this build of Foundry knows how to remove. It expects `
      + `one of ${SUBJECT_KINDS.join(', ')}.`,
    );
  }
  const entry = crucibleServerNamed(server);
  if (entry === null) {
    throw new Error(
      `"${server}" is not a registered engine, so there is nothing of its to remove.`,
    );
  }
  await (await engineClientFor(entry)).removeSubject(kind as CrucibleSubjectKind, id);
}
