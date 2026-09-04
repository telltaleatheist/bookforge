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
const TEXT_CHANGING: ReadonlySet<AppliedPassKind> = new Set<AppliedPassKind>([
  'simplify', 'translate', 'footnote-refs', 'narration-text',
]);

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
export function narrationTextReadiness(
  passes: readonly AppliedPass[],
): NarrationTextReadiness {
  const textChanging = passes.filter((p) => TEXT_CHANGING.has(p.kind));
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
