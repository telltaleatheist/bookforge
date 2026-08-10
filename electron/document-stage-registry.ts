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
  /**
   * The most recent progress line this stage emitted, or null before its first.
   *
   * Held for ONE reason: `document:stage-progress` is a broadcast, and a window
   * that reloads mid-stage has missed every line already sent. It comes back
   * subscribed to a channel that will not speak again until the next page is
   * read, so its queue row sat frozen at whatever percentage happened to be on
   * screen when the reload hit — with the elapsed timer still counting, which
   * made it look like a run that had hung (Owen, Aug 8 2026). A live TTS session
   * has never had this problem because main holds its progress and the renderer
   * asks for it on load (`parallelTts.listActive`); this is the same answer for
   * a document stage.
   *
   * It is the LAST LINE, not a history: what a reattaching window needs is where
   * the run is now, and the lines it missed are on the console either way.
   */
  lastProgress: StageProgressLine | null;
}

/** A stage's most recent progress line, in the shape a window can be handed. */
export interface StageProgressLine {
  stage: string;
  message: string;
  done: number;
  total: number;
  /** The rasterising pass's own count, when the run has one. See DocumentStageProgress. */
  render?: { done: number; total: number };
  /** When this line was emitted — an ETA reattaches to a rate, not to a count. */
  at: number;
}

/**
 * A stage that has been ORDERED and has not claimed its project yet.
 *
 * ── Why there is a second, weaker state (Owen, 2026-08-10) ──────────────────
 *
 * A conversion does not claim its project the moment it is asked for.
 * `runVlmConversion` waits on the GPU arbiter — possibly behind a TTS job — and
 * then on roughly 44 seconds of vLLM model load BEFORE `withProjectStage` calls
 * `beginStage`, and that ordering is deliberate: holding a project's stage lock
 * through a wait for a run that has not begun would refuse every other stage on
 * that book for a minute at a time.
 *
 * The cost of that ordering was a blind spot. For the whole of the load window
 * this registry said the project had nothing running, while a conversion was
 * plainly burning memory and about to claim it. Two things asked exactly the
 * wrong question in exactly that window:
 *
 *  - a queue row sent to attach to the running conversion asked "is the stage
 *    still there?", was told no, and reported a ninety-minute conversion
 *    COMPLETE seconds after being enqueued;
 *  - a window that reloaded during the load was told the run had died and failed
 *    its own row saying so.
 *
 * So an intent is recorded from the moment the run is ordered. It is deliberately
 * NOT a claim: `beginStage` ignores it entirely, so two stages behave exactly as
 * they did before and the lock still opens only where it always did. What it
 * changes is what the process can HONESTLY ANSWER about a book — "something is
 * working on this" is true from the order, not from the claim.
 *
 * It carries no AbortController, and that is a statement rather than an omission:
 * there is nothing to abort yet. Cancelling reaches a run through the claim, as
 * it always has, and a run cancelled during its load is stopped by the abort the
 * claim installs a moment later.
 *
 * ── What deliberately does NOT consult it, and what that leaves open ─────────
 *
 * `beginStage`, `stageRunningFor` and `abortAllStages` all read `active` only.
 * The first two are about the LOCK — may a second writer start, and who is
 * refusing it — and an intent holds nothing, so answering from it would refuse
 * stages this process has always allowed. The third has nothing to abort.
 *
 * That leaves one thing open, named here rather than quietly: RESET during the
 * load window. `stageRunningFor` is how a reset refuses while a stage is in
 * flight, and the hazard it guards — foundry's staged temp landing after the
 * reset and restoring the document the user asked to be gone — is just as real
 * for a run that is still loading its model as for one that has claimed. Closing
 * it means teaching that refusal about intents, which changes when Reset says no
 * and is a decision about Reset rather than about this registry. It is not
 * closed here.
 */
export interface StageIntent {
  projectDir: string;
  /** The stage's user-facing name — the same one the claim will carry. */
  label: string;
  /** When the run was ORDERED, which is what an attaching row's clock means. */
  startedAt: number;
}

const active = new Map<string, ActiveStage>();

/**
 * Several, per project, because two conversions of one book CAN both be in
 * their load window at once — the second is refused when it reaches the claim,
 * not before. A map holding one would lose the first the moment the second
 * arrived and hand the project to nobody when the second was refused.
 */
const intents = new Map<string, StageIntent[]>();

/**
 * Say that a stage has been ordered for this project, and hand back the release.
 *
 * The caller must run the release in a `finally` that covers the CLAIM as well:
 * the intent stands from the order right through the run, so nothing ever sees a
 * gap between "ordered" ending and "claimed" beginning.
 */
export function markStageIntent(projectDir: string, label: string): () => void {
  const intent: StageIntent = { projectDir, label, startedAt: Date.now() };
  const held = intents.get(projectDir);
  if (held) held.push(intent);
  else intents.set(projectDir, [intent]);
  return () => {
    const list = intents.get(projectDir);
    if (!list) return;
    // Removed BY IDENTITY, never by index or by project: two orders on one book
    // are two entries, and releasing "the first one" would drop an intent whose
    // run is still loading.
    const at = list.indexOf(intent);
    if (at >= 0) list.splice(at, 1);
    if (list.length === 0) intents.delete(projectDir);
  };
}

/**
 * Every stage ORDERED and not yet claimed, for the projects where nothing holds
 * the claim.
 *
 * A project whose claim is held is reported by `activeStages` and is not
 * repeated here — one project, one answer, so a caller matching on project
 * directory cannot find two entries describing one run.
 */
export function unclaimedStageIntents(): StageIntent[] {
  const out: StageIntent[] = [];
  for (const [projectDir, list] of intents) {
    if (active.has(projectDir)) continue;
    // The OLDEST — the order that is furthest along and the one whose clock the
    // user has been watching.
    if (list.length > 0) out.push(list[0]);
  }
  return out;
}

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
  active.set(projectDir, { projectDir, label, startedAt: Date.now(), abort, lastProgress: null });
  return () => {
    // Only if it is still OURS. A release that fired after the entry had been
    // replaced would hand the project to nobody while a stage was still running.
    if (active.get(projectDir)?.abort === abort) active.delete(projectDir);
  };
}

/**
 * Remember this stage's latest line, so a window that reloads can be told where
 * the run is instead of waiting for the next broadcast.
 *
 * Silently ignored when the project holds no stage: progress arriving after the
 * release is a line already in flight when the run unwound, and recording it
 * would resurrect an entry `beginStage` would then refuse to replace.
 */
export function recordStageProgress(projectDir: string, line: StageProgressLine): void {
  const held = active.get(projectDir);
  if (held) held.lastProgress = line;
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
