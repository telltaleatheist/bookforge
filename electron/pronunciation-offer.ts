/**
 * THE PRONUNCIATION GUIDE'S SECTION ON FOUNDRY'S CLEANUP MODAL — what this app says
 * when Foundry asks the host whether it has a say in a cleanup (`passOffer`).
 *
 * Owen, 2026-11-01: *"make sure the user knows the pronunciation guide has to be
 * processed before cleaning. maybe we even put 'generate pronunciation guide' in the
 * cleanup modal instead of what we're doing now"*. What we were doing: a cleanup of a
 * step with no guide built one inside itself, said only in its progress line. Now the
 * modal says whether the step has a guide and offers what to do about it; the choice
 * travels on the request as `hostChoice` (GUIDE_CHOICE), and a guide to build is
 * queued as its own row ahead of the cleanup (foundry-host-queue `guideAhead`).
 *
 * Owen, 2026-11-02: *"pronunciation guide and clean text are closely linked enough that
 * they can be the same step ... the user can decide to remove the pronunciation
 * corrections if they want"*. So a guide choice is the whole chain: the guide (built,
 * rebuilt or as it stands), the cleanup with the guide's places PROTECTED and not
 * written, and the guide applied LAST as "Pronunciation adjusted" under the cleaned
 * step (foundry-host-queue `adjustAfter`) — the one step to delete to take the
 * corrections out, without cleaning again.
 *
 * Foundry draws the words and reads none of them, so every sentence here is ours.
 */
import { guidePathsOfStep, hasGuide, readGlossary } from './narration-glossary';
import { GUIDE_CHOICE } from '../shared/pronunciation-guide';
import { appliedStepInfo } from './pronunciation-applied';

/** One way to go, as the modal draws it (Foundry's `HostPassChoice`). */
export interface GuidePassChoice {
  id: string;
  label: string;
  detail: string;
  recommended?: boolean;
  /** The rows this choice adds ahead of the cleanup, in order. */
  queues: string[];
}

/** The section (Foundry's `HostPassOffer`). */
export interface GuidePassOffer {
  label: string;
  note: string;
  choices: GuidePassChoice[];
  chosen: string;
  /** The link that opens the guide: the host op, run on the step's node. */
  review?: { label: string; operationId: string; nodeId: string };
}

/** The host op that opens a step's guide window (main.ts's `bookforge.guide`). */
export const GUIDE_OPERATION_ID = 'bookforge.guide';

const NO_GUIDE: GuidePassChoice = {
  id: GUIDE_CHOICE.none,
  label: 'Clean without a guide',
  detail: 'The cleanup decides how each one is said in its own sentence, and nothing is applied after it.',
  queues: [],
};

/** The one line every guide choice shares: where the corrections land, and how to take them out. */
const ADJUSTED_NOTE = 'The corrections land as their own step, “Pronunciation adjusted”, under the cleaned text. '
  + 'Delete that step to take them out.';

/**
 * The section for a cleanup made from step `at` (or the greyed row `deferredFrom`
 * that will land it), or null when the cleanup names no step.
 */
export function guidePassOffer(projectDir: string, at: string | null, deferredFrom: string | null): GuidePassOffer | null {
  const step = at ?? deferredFrom;
  if (step === null) return null;
  /*
   * A STEP THE GUIDE WAS APPLIED AS: its words are already said, so there is no
   * guide to build over it. The cleanup is handed every applied place, kept.
   */
  if (appliedStepInfo(projectDir, step) !== null) {
    return {
      label: 'Pronunciation guide',
      note: 'The pronunciation guide is applied in this step. The cleanup keeps every applied word as it is.',
      choices: [
        {
          id: GUIDE_CHOICE.use,
          label: 'Keep the applied words',
          detail: 'The cleanup leaves every word the guide wrote in as it is.',
          recommended: true,
          queues: [],
        },
        { ...NO_GUIDE, label: 'Clean without protecting them', detail: 'The cleanup may change applied words in their sentence.' },
      ],
      chosen: GUIDE_CHOICE.use,
    };
  }
  const files = guidePathsOfStep(projectDir, step);
  if (!hasGuide(files)) {
    return {
      label: 'Pronunciation guide',
      note: `This step has no pronunciation guide yet. ${ADJUSTED_NOTE}`,
      choices: [
        {
          id: GUIDE_CHOICE.build,
          label: 'Build a guide, clean, then apply it as its own step',
          detail: 'The guide reads the whole book and decides how initials, abbreviations and numerals are said, so '
            + 'the cleanup doesn’t guess them one sentence at a time and leaves them alone.',
          recommended: true,
          queues: ['Build the pronunciation guide'],
        },
        NO_GUIDE,
      ],
      chosen: GUIDE_CHOICE.build,
    };
  }
  const glossary = readGlossary(files.glossary, files.book);
  const words = glossary.entries.length;
  const built = glossary.built === undefined ? ''
    : `, built ${new Date(glossary.built).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return {
    label: 'Pronunciation guide',
    note: `This step has a guide: ${words} ${words === 1 ? 'word' : 'words'}${built}. ${ADJUSTED_NOTE}`,
    choices: [
      {
        id: GUIDE_CHOICE.use,
        label: 'Use the existing guide, clean, then apply it',
        detail: 'Its readings, and your changes to them, are applied after the cleanup as they are.',
        recommended: true,
        queues: [],
      },
      {
        id: GUIDE_CHOICE.rebuild,
        label: 'Rebuild the guide, clean, then apply it',
        detail: 'Decides the whole book again first. Your changes to the guide are dropped.',
        queues: ['Rebuild the pronunciation guide'],
      },
      { ...NO_GUIDE, label: 'Clean without it' },
    ],
    chosen: GUIDE_CHOICE.use,
    review: { label: 'Review it', operationId: GUIDE_OPERATION_ID, nodeId: step },
  };
}
