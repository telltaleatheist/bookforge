/**
 * document-stage-registry — which projects have a stage working on them, right
 * now, in this process.
 *
 * This is deliberately the ONLY thing in the document pipeline that is state in
 * memory, and it is not pipeline state: it says nothing about what has happened
 * to a book, only about what is happening to it this instant. Which stages have
 * RUN is read off the documents (`readDocumentPipelineState`), as it must be —
 * that is the whole design. What a file on disk cannot tell you is whether a
 * subprocess is about to write into it, and that is what this answers.
 *
 * Two callers need it, and neither could see the other before it existed:
 *
 *  - **Reset** must refuse while a stage is in flight. foundry's own discipline
 *    is a staged temp renamed into place at the end, so a stage that started
 *    before a reset and lands after it RESTORES the working document the user
 *    asked to be gone — silently, seconds later, looking like the reset failed.
 *    The old run model got this right by accident (a run was an object in
 *    memory); the document model has to state it.
 *  - **Quit** must stop them. A document stage spawns foundry, which spawns a
 *    llama-server holding several GB of weights on the GPU. Closing the window
 *    without aborting leaves both running with nothing left to report to.
 *
 * Keyed by project directory because that is what a stage is ABOUT: two windows
 * open on one book are two views of one document, and the second asking to
 * detect while the first is detecting is not two runs — it is two writers on one
 * file. Refusing the second is the point.
 */

export interface ActiveStage {
  projectDir: string;
  /** The stage's user-facing name, for the sentence that refuses. */
  label: string;
  startedAt: number;
  abort: AbortController;
}

const active = new Map<string, ActiveStage>();

/**
 * Claim a project for a stage, or refuse because something else holds it.
 *
 * Returns the RELEASE, which the caller must run in a `finally`. Claiming is
 * refused rather than queued: the two stages would append to the same working
 * document from two different base lengths, and the second update would land on
 * bytes the first had already moved past.
 */
export function beginStage(
  projectDir: string,
  label: string,
  abort: AbortController
): () => void {
  const held = active.get(projectDir);
  if (held) {
    throw new Error(
      `${held.label} is already working on this book. Wait for it to finish, or stop it, before `
      + `starting ${label} — both would write into the same working document.`
    );
  }
  active.set(projectDir, { projectDir, label, startedAt: Date.now(), abort });
  return () => {
    // Only if it is still OURS. A release that fired after the entry had been
    // replaced would hand the project to nobody while a stage was still running.
    if (active.get(projectDir)?.abort === abort) active.delete(projectDir);
  };
}

/** The stage working on this project, or null. The sentence a refusal needs. */
export function stageRunningFor(projectDir: string): string | null {
  return active.get(projectDir)?.label ?? null;
}

/** Ask the stage on this project to stop. False when there is none. */
export function abortStageFor(projectDir: string): boolean {
  const held = active.get(projectDir);
  if (!held) return false;
  held.abort.abort();
  return true;
}

/** Every stage in flight — quit's list, and a diagnostic. */
export function activeStages(): ActiveStage[] {
  return [...active.values()];
}

/**
 * Stop everything, for quit.
 *
 * Aborting is all this does: the entries are removed by their own releases as
 * the stages unwind, so a caller that waited on this map would be waiting on the
 * stages themselves, which is `runFoundry`'s job rather than this module's.
 */
export function abortAllStages(): number {
  const held = [...active.values()];
  for (const stage of held) stage.abort.abort();
  return held.length;
}
