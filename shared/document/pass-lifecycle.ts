/**
 * pass-lifecycle — a diff belongs to the file it was applied to, and dies with it.
 *
 * Owen, third real session (2026-08-04): "any time a process is run on a file,
 * there should be a diff with a 'review changes' button on that file so i can
 * see what changed… and it should be linked to the file it was applied to. so if
 * that file is removed, so is the diff and its viewing button."
 *
 * The record of what a pass did lives in two places at once — an entry in
 * `manifest.outputs.epub.appliedPasses` and a `stages/NN-<kind>/diff.json` on
 * disk — and the two have to go away together, or the versions page offers a
 * review of a file nobody has, or leaves a diff on disk that no consumer can
 * name. This module is the single statement of WHICH passes survive WHICH event,
 * kept pure so it can be tested without a project (`tools/test-pass-lifecycle.js`)
 * and so the manifest writer and the delete handler cannot answer it differently.
 *
 * ── The two events, and why "rebuilt" is one of them ────────────────────────
 *
 * Deleting the book is the obvious one. Rebuilding it is the SAME event, and
 * docs/PIPELINE_V2_PLAN.md already says so: "Rebuilding regenerates a clean
 * EPUB, which discards the EPUB passes done to the old one — their stars clear,
 * honestly." Reflow writes a fresh book from the working copy; the footnote
 * removal, the simplify and the translate that were applied to the OLD bytes did
 * not happen to these ones. A record that survived would vouch for work this
 * file has never been through, and its diff would show a before/after of text
 * that is no longer in the book.
 *
 * ── What this module deliberately does NOT do ───────────────────────────────
 *
 * It never invents an event. There is no "tidy up", no "sweep orphans", no
 * age-based expiry: a diff is a user's record of what an AI model did to their
 * book, and the only thing that takes it is the artifact it describes going
 * away. The exhaustive switch below is that rule — a new event has to be written
 * down here, with its reason, before anything can act on it.
 */

import { isPassStageDirName } from '../processing/reset-book';

/** One recorded pass, as much of it as the lifecycle needs. */
export interface RecordedPass {
  readonly kind: string;
  readonly at: string;
  /**
   * Project-relative, forward-slashed, e.g. `stages/04-footnotes/diff.json`.
   * Absent is a real state: a pass whose job died before it wrote one, and the
   * older passes that never recorded a diff at all.
   */
  readonly diff?: string;
}

/**
 * What can happen to the book EPUB that ends the passes applied to it.
 *
 * Both members END the provenance. They are still named separately because the
 * callers are different code paths with different confirmations, and a future
 * event that does NOT end it (a rename, say) must be forced to say so here
 * rather than inherit a default.
 */
export type EpubArtifactEvent = 'epub-deleted' | 'epub-rebuilt';

export interface PassLifecycle {
  /** The passes that still describe the book after the event. */
  readonly kept: readonly RecordedPass[];
  /** The passes that no longer describe anything. */
  readonly dropped: readonly RecordedPass[];
  /**
   * What the dropped passes left on disk, project-relative and forward-slashed,
   * in the order their passes ran, without duplicates.
   *
   * A pass's stage DIRECTORY when its diff sits in one (`stages/04-footnotes/`),
   * because that directory is this pass's whole workspace — the diff, foundry's
   * own `report.json` that the review header reads, and the staging it left —
   * and it is the granularity "Start over" already removes them at
   * (electron/processing-reset.ts, `stage-dir`). The diff FILE alone otherwise,
   * because a diff recorded somewhere that is not a stage directory is sharing
   * that directory with something this module knows nothing about.
   */
  readonly removePaths: readonly string[];
}

/**
 * The directory a recorded diff owns outright, or null when it owns none.
 *
 * Null is a real answer, not a failure, and there are two ways to reach it. A
 * diff recorded somewhere that is not under `stages/` at all (a legacy sidecar
 * written beside the book) shares its directory WITH the book. And a diff inside
 * one of the RESERVED stage directories — `01-cleanup`, `02-translate` — shares
 * it with the LL pipeline's own per-language books, which is exactly why
 * `isPassStageDirName` refuses those names however well their suffix matches.
 * Either way the answer is "this diff owns no directory", and only the file
 * itself comes off.
 *
 * The naming rule is NOT restated here: `shared/processing/reset-book.ts` is its
 * one authority, and "Start over" and this module have to agree about which
 * directory belongs to a pass or one of them will delete a book.
 */
export function passStageDirOf(diffRelPath: string): string | null {
  const parts = diffRelPath.split('/');
  // `stages/<dir>/<file>` and nothing shallower: a two-part path has no
  // directory under `stages/` to own.
  if (parts.length < 3) return null;
  if (parts[0] !== 'stages') return null;
  const name = parts[parts.length - 2];
  if (!isPassStageDirName(name)) return null;
  return parts.slice(0, -1).join('/');
}

/**
 * Which passes survive `event`, and what the ones that do not leave behind.
 *
 * The switch is exhaustive on purpose — `never` at the end is what makes a new
 * event a compile error here rather than a silent "everything survives".
 */
export function passesAfterEpubEvent(
  event: EpubArtifactEvent,
  passes: readonly RecordedPass[]
): PassLifecycle {
  switch (event) {
    case 'epub-deleted':
    case 'epub-rebuilt': {
      // Nothing survives either event: after a delete there is no file for a
      // pass to describe, and after a rebuild the file is not the one the passes
      // were applied to. The rebuild's OWN passes (Reflow records get-text /
      // blocks / reflow for the book it just wrote) are appended afterwards, as
      // new records — they are not survivors of this list.
      const dropped = [...passes];
      const removePaths: string[] = [];
      for (const pass of dropped) {
        if (!pass.diff) continue;
        const target = passStageDirOf(pass.diff) ?? pass.diff;
        if (!removePaths.includes(target)) removePaths.push(target);
      }
      return { kept: [], dropped, removePaths };
    }
    default: {
      const unreachable: never = event;
      throw new Error(
        `pass-lifecycle was asked about the event "${String(unreachable)}", which nothing has said `
        + 'whether the book\'s passes survive. Add it to EpubArtifactEvent with its reason — a pass '
        + 'record that outlives the file it describes is what this module exists to prevent.'
      );
    }
  }
}
