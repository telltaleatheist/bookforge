/**
 * narration-text-readiness.ts — has this BOOK had the narration text cleanup,
 * and is it still the last word on the text?
 *
 * ── Two gates, one meaning ──────────────────────────────────────────────────
 *
 * `narrationTextGate` (electron/narration-text-pass.ts) asks a FILE: it reads the
 * stamp on the OPF, and it is what the render door and the CLI use, because they
 * are handed a path and nothing else.
 *
 * This one asks a PROJECT, from its ledger, and it is what the app's Narrate
 * button uses — because the ledger knows something the file cannot: whether a
 * LATER pass rewrote the text after the cleanup ran. A simplify or a translate
 * recorded after `narration-text` leaves the stamp on the book (the pass wrote
 * text nodes, it did not touch the OPF) while making it a claim about text that
 * is no longer there. "Stale, re-run" and "missing, run it" are different
 * instructions to a user who believes they already did it, so they are different
 * states with different sentences.
 *
 * ── What counts as text-changing ────────────────────────────────────────────
 *
 * Every pass that rewrites the words a narrator would read. `vlm-convert` is the
 * book's ORIGIN rather than a change to one, and the retired kinds are history
 * that cannot be re-run, so neither can make a cleanup stale.
 *
 * A RECORD AND NOT A SET, and the direction is the point. As a `Set` literal
 * this failed OPEN: a new text-rewriting kind added to `AppliedPassKind` left
 * the literal untouched, nothing complained, and a book rewritten by it went on
 * reporting `ok: true` — narrated against text the cleanup never saw. Written
 * as an exhaustive `Record`, adding a kind is a COMPILE error until somebody
 * answers the question. Reported by the adversarial review, 2026-09-04.
 *
 * A kind a persisted manifest carries that this build does not know is treated
 * as text-changing by `isTextChanging` below — the safe direction for the one
 * case the compiler cannot see, an older or newer build's manifest.
 */
import { PUNCTUATION_SPEC_VERSION } from './tts-punctuation.js';
import { NORMALIZER_VERSION } from './tts-number-normalizer.js';
import type { AppliedPass, AppliedPassKind } from './manifest-types.js';

/** The label the user sees for the pass, in one place. */
export const NARRATION_TEXT_LABEL = 'Narration text cleanup';

/**
 * The passes that rewrite the text a narrator reads.
 *
 * `narration-text` is in the set because it is the one this readiness is ABOUT:
 * the question is whether it is the LAST of these, so it has to be one of them.
 */
const TEXT_CHANGING: Readonly<Record<AppliedPassKind, boolean>> = {
  simplify: true,
  translate: true,
  'footnote-refs': true,
  'narration-text': true,
  // A book's ORIGIN rather than a change to one: a conversion cannot make a
  // cleanup stale because there was no cleaned text before it.
  'vlm-convert': false,
  // Retired, and unrunnable. They appear only in an old book's history.
  'get-text': false,
  blocks: false,
  reflow: false,
  footnotes: false,
  tesseract: false,
  'ocr-correction': false,
  detection: false,
};

export type NarrationTextReadiness =
  | { ok: true; at: string; model: string }
  | { ok: false; state: 'missing' | 'stale'; reason: string };

/** The pass this record says ran, when it names one this build understands. */
function versionsOf(pass: AppliedPass): { normalizer: string; punctuation: string } | null {
  const params = pass.params;
  if (params === undefined) return null;
  const normalizer = params['normalizerVersion'];
  const punctuation = params['punctuationSpec'];
  if (typeof normalizer !== 'string' || typeof punctuation !== 'string') return null;
  return { normalizer, punctuation };
}

/**
 * Is this book ready to narrate, by its own history?
 *
 * `passes` is the family's `appliedPasses`, in the order they ran — what
 * `manifestService.readAppliedPasses(projectDir, familyId)` answers.
 */
/**
 * Does this pass rewrite the words a narrator reads?
 *
 * An unknown kind — a manifest written by a build this one does not know —
 * answers YES. A cleanup that might be stale reads stale; the cost is one re-run
 * the user can see, against a book narrated from text nothing ever cleaned.
 */
function isTextChanging(kind: AppliedPassKind): boolean {
  const known = TEXT_CHANGING[kind];
  return known === undefined ? true : known;
}

export function narrationTextReadiness(
  passes: readonly AppliedPass[],
): NarrationTextReadiness {
  const textChanging = passes.filter((p) => isTextChanging(p.kind));
  const last = textChanging.length === 0 ? undefined : textChanging[textChanging.length - 1];

  if (!textChanging.some((p) => p.kind === 'narration-text')) {
    return {
      ok: false,
      state: 'missing',
      reason: `This book has not had the ${NARRATION_TEXT_LABEL}, so its punctuation is whatever `
        + 'the book printed and its numbers are still digits. Narration reads the text exactly as '
        + 'it stands, so it has to run first.',
    };
  }

  if (last!.kind !== 'narration-text') {
    return {
      ok: false,
      state: 'stale',
      reason: `The ${NARRATION_TEXT_LABEL} ran, but a later pass rewrote the text after it, so `
        + 'what it cleaned is not what a narrator would be handed now. It has to run again.',
    };
  }

  const versions = versionsOf(last!);
  if (versions === null) {
    return {
      ok: false,
      state: 'stale',
      reason: `The ${NARRATION_TEXT_LABEL} on this book was recorded without the versions it ran `
        + 'at, so there is no way to tell whether it matches the rules this build uses. It has to '
        + 'run again.',
    };
  }
  if (versions.normalizer !== NORMALIZER_VERSION
    || versions.punctuation !== PUNCTUATION_SPEC_VERSION) {
    return {
      ok: false,
      state: 'stale',
      reason: `The ${NARRATION_TEXT_LABEL} on this book ran at `
        + `${versions.normalizer}/${versions.punctuation}, and this build reads text by `
        + `${NORMALIZER_VERSION}/${PUNCTUATION_SPEC_VERSION}. It has to run again.`,
    };
  }

  const model = last!.params?.['model'];
  return {
    ok: true,
    at: last!.at,
    model: typeof model === 'string' ? model : 'an unrecorded model',
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// The door the Narrate button asks through
// ─────────────────────────────────────────────────────────────────────────────

/** What the readiness door answers. */
export interface NarrationTextReadinessAnswer {
  success: boolean;
  /** The CHAIN's answer, or null when this project's chains cannot name one. */
  readiness?: NarrationTextReadiness | null;
  /** The FILE's own answer — the stamp the render door will read. */
  fileState?: unknown;
  familyId?: string | null;
  bookPath?: string | null;
  familyNote?: string;
  error?: string;
}

/**
 * Is this book ready to narrate — asked of a PROJECT and of the FILE at once.
 *
 * THE HANDLER'S WHOLE BODY, exported, because the `narration:text-readiness` IPC
 * is a one-line call to it. The third adversarial review asked for the handler's
 * branches to be tested rather than the pure helper's, and a handler whose logic
 * lives inside `ipcMain.handle` in a six-thousand-line file cannot be: this is
 * the same function the IPC calls, and the keeper calls it too.
 *
 * Two answers, because they can disagree. The FILE's stamp is what the render
 * door reads and needs no chain resolved, so it is computed first and stands
 * even when the project's chains cannot name one. The CHAIN's answer knows the
 * one thing the file cannot: whether a LATER pass rewrote the text.
 */
export async function narrationTextReadinessFor(
  projectDir: string,
  askedPath?: string,
  familyId?: string,
): Promise<NarrationTextReadinessAnswer> {
  const fs = await import('fs');
  const manifestService = await import('./manifest-service.js');
  const { narrationTextGate } = await import('./narration-text-pass.js');

  try {
    const fileState = askedPath === undefined || !fs.existsSync(askedPath)
      ? null
      : await narrationTextGate(askedPath);

    const resolved = await manifestService.familyForOpen(projectDir, askedPath, familyId);
    if (resolved === null) {
      // ZERO CHAINS AND MANY CHAINS ARE NOT THE SAME ANSWER. `familyForOpen`
      // returns null for both, and calling them both "more than one book chain"
      // sent a project that simply has no recorded chain yet down the path that
      // offers nothing — where the round-1 code had correctly offered the
      // cleanup (the second adversarial review, 2026-09-04). A project with no
      // chain has not been cleaned, by definition, so it reads MISSING and the
      // offer stands.
      const families = (await manifestService.readProjectManifest(projectDir)).families ?? [];
      if (families.length === 0) {
        const book = await manifestService.bookForAct(projectDir);
        return {
          success: true,
          readiness: narrationTextReadiness([]),
          fileState,
          familyId: null,
          bookPath: book === null ? null : book.absPath,
        };
      }
      return {
        success: true,
        readiness: null,
        fileState,
        familyId: null,
        bookPath: null,
        familyNote: 'This project holds more than one book chain, and the version you pressed '
          + 'belongs to none of them by name, so its history could not be read. The file itself '
          + 'still says whether it has been cleaned.',
      };
    }
    const family = resolved.family.id;
    const passes = await manifestService.readAppliedPasses(projectDir, family);
    const book = await manifestService.bookForAct(projectDir, family);
    return {
      success: true,
      readiness: narrationTextReadiness(passes),
      fileState,
      familyId: family,
      bookPath: book === null ? null : book.absPath,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
