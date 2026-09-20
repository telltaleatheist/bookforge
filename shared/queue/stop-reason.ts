/**
 * WHY A STEP STOPPED — one fact, one sentence, one owner.
 *
 * ── The night this module is written about (2026-09-20, 14:25 ET) ───────────
 *
 * Owen relaunched BookForge and found two narration rows aimed at two idle
 * Crucible servers reading *"Stopped by user — press Start to resume"*. He had
 * not stopped either of them. The app closing had: the quit chain reaches the
 * bridge's stop door (`stopParallelConversion`, electron/parallel-tts-bridge.ts)
 * and that door had exactly one sentence, written for the Stop button. The OTHER
 * end of the same fact — a hard kill, where nothing gets to run a stop at all —
 * came back through `reviveInterrupted` saying *"Interrupted when BookForge
 * closed."* Two ends, ONE fact (the app closed), two sentences, and one of them
 * blamed the person reading it.
 *
 * So the reason is a VALUE that travels with the stop, and the sentence is
 * derived from it here and nowhere else. A door that stops something says which
 * of the two gestures it is performing; every surface that words it asks this
 * module. Neither half can drift from the other again, because there is only one
 * of each sentence in the tree.
 *
 * ── Why it is `shared/` ────────────────────────────────────────────────────
 *
 * Both halves of the seam need it and neither owns it: the TTS bridge emits the
 * progress line a user reads, the queue engine records the reason on the step
 * and re-words it on the next load, and the renderer reads
 * {@link QueueStep.stopReason} off the mirror. A constant in either half would
 * make the other half import across the seam for a sentence.
 */

/**
 * The two gestures that leave a step present, unstarted and resumable.
 *
 * `'user'` — somebody pressed Stop. They are taking the card back and they know
 *            this row is not going to run; it stays {@link StepStatus} `held`
 *            until they say otherwise, and an untargeted Start does not sweep it
 *            up (see `release`, electron/queue-engine.ts).
 * `'closed'` — the APP ended while the step was running: the quit chain's
 *            teardown, or a kill that `reviveInterrupted` finds on the next
 *            load. Nobody decided to stop this work, so pressing Running picks
 *            it back up.
 *
 * There is deliberately no third value for "a runner stopped itself". That is a
 * failure with an account (`QueueStep.lastError`), not a gesture.
 */
export type StopReason = 'user' | 'closed';

/**
 * THE SENTENCE FOR EACH, and the only copy of either.
 *
 * Both are addressed to the person looking at the row and both end by naming
 * the gesture that resumes the work, because a row that stopped without saying
 * how to continue is the shape this whole layer exists to remove.
 */
const SENTENCES: Readonly<Record<StopReason, string>> = {
  user: 'Stopped by user — press Start to resume',
  closed: 'Interrupted when BookForge closed. Press Start to pick it up from where it got to.',
};

/** How a stop of this kind reads on the row. */
export function stopSentence(reason: StopReason): string {
  return SENTENCES[reason];
}

/**
 * The same fact as an ANALYTICS `error` string — short, past tense, no
 * instruction, because the ledger is read long after the button is gone.
 */
export function stopAnalyticsError(reason: StopReason): string {
  return reason === 'closed' ? 'Interrupted when BookForge closed' : 'Stopped by user';
}

/** Just enough of a {@link QueueStep} to answer the two questions below. */
export interface StoppedStepFacts {
  readonly status: string;
  readonly wasInterrupted?: boolean;
  readonly stopReason?: StopReason;
}

/**
 * DID THE APP'S CLOSING STOP THIS STEP — the predicate `start()` releases on.
 *
 * `wasInterrupted` WITH NO REASON counts as closed, and that is not a guess: it
 * is what every queue written before this field existed looks like, and the
 * shape it was overwhelmingly written by is the revive path, which is a close.
 * Reading it the other way would leave a library's worth of rows needing a press
 * each; reading it this way costs at worst one resumed render somebody had
 * stopped before upgrading, which resumes from what is already on disk.
 */
export function closedInterrupted(step: StoppedStepFacts): boolean {
  if (step.status !== 'held') return false;
  if (step.stopReason === 'closed') return true;
  return step.stopReason === undefined && step.wasInterrupted === true;
}

/**
 * DID A PERSON STOP THIS STEP — the one shape an untargeted Start leaves alone.
 *
 * `StepStatus`' own words for `held`: *present, will not be auto-picked, and
 * needs an explicit gesture to run again*. Pressing Running is a decision about
 * THE QUEUE; the row somebody stopped by hand needs its own press (the per-row
 * ▶, which targets it).
 */
export function userStopped(step: StoppedStepFacts): boolean {
  return step.status === 'held' && step.stopReason === 'user';
}
