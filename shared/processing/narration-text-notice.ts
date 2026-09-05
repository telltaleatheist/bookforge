/**
 * narration-text-notice — the one sentence the FAILSAFE cleanup is offered with.
 *
 * Owen, 2026-09-05: *"the bookforge clean text action outside of foundry is a
 * failsafe in case the user forgets and just wants to get it done immediately.
 * it won't be treated as the standard method… if the user deletes the epub and
 * re-exports, the cleaning job will be lost. that's the cost of doing it to an
 * epub. the user can be informed of it."*
 *
 * ONE CONSTANT, TWO SURFACES. The failsafe is reachable from exactly two places
 * — the "Clean text…" action on a version row (studio-versions) and the "Yes"
 * arm of the narrate-time offer (narration-modal) — and a user who reads one of
 * them and then the other must not be told two different things about what the
 * run costs. Written here because both surfaces are the renderer's and the
 * ledger row that describes the finished run is the main process's; `shared/` is
 * the only place all three can read.
 *
 * WHAT IT HAS TO SAY, and why each half is in it:
 *
 *   - it cleans the EXPORTED EPUB IN PLACE. That is the whole difference from
 *     the hosted step: this act produces a FILE and nothing that remembers how
 *     the file was made.
 *   - deleting or re-exporting the EPUB LOSES IT. A re-export comes from the
 *     project, and the project's chain never learned about this cleanup, so the
 *     new file is uncleaned. Somebody who is not told this will re-export and
 *     quietly narrate uncleaned text.
 *   - the HOSTED step is the standard method. The failsafe is for the person who
 *     forgot; naming the standard method is what keeps it from becoming one.
 */

/** The sentence. Used verbatim by both surfaces; never paraphrased at a call site. */
export const NARRATION_TEXT_FAILSAFE_NOTICE =
  'This is the failsafe: it cleans the exported EPUB in place, so deleting that file or '
  + 're-exporting it from the project loses the cleanup — the standard method is the '
  + '"Clean text" step in the Foundry window, which everything you do afterwards carries along.';
