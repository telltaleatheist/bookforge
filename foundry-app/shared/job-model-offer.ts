/**
 * WHAT A JOB'S DIALOG IS HANDED, AND WHAT IT HANDS BACK (Owen, 2026-10-25).
 *
 * `job-models.ts` is the RULE — which rows a model dropdown offers, and which
 * one is the default — and it is mirrored byte for byte in BookForge, so
 * nothing Foundry-only goes in it. This file is the Foundry half around that
 * rule: the shape `crucible:job-models` answers with, the four kinds as a list
 * a reader can iterate (the rule only needs the type), and the one line every
 * dialog uses to put the choice on its request.
 *
 * Owen, verbatim: *"put the option the user can pick in a dropdown on the modal
 * that configures the job"*; *"bookforge should use the last used model as the
 * default"*.
 */
import type { JobModelChoices, JobModelKind } from './job-models';

/** The kinds, as a list a reader can walk (the settings clamp reads it). */
export const JOB_MODEL_KINDS: readonly JobModelKind[] = ['clean', 'translate', 'simplify', 'analysis', 'ask'];

/**
 * `crucible:job-models`'s answer: the list a server offers for this kind of job,
 * and the row to preselect — the last value used for this kind when the list
 * still offers it, else AUTOMATIC (`defaultJobModel`). Main answers both because
 * main holds the remembered value (`AppSettings.lastJobModels`).
 */
export interface JobModelOffer {
  readonly list: JobModelChoices;
  readonly preselected: string;
}

/**
 * THE REQUEST, WITH THE CHOICE ON IT ONLY WHEN THERE IS ONE.
 *
 * AUTOMATIC is `''`, and the request's contract is that ABSENT means the
 * server's own pick at this app's ceiling (`TranslateRequest.chosenModel`). So
 * `''` is never written: a request carrying an empty `chosenModel` would be a
 * third state nobody defined. A new object, so the caller's is untouched.
 */
export function withChosenModel<T extends { chosenModel?: string }>(request: T, chosen: string): T {
  if (chosen.length === 0) {
    const { chosenModel: _dropped, ...rest } = request;
    return rest as T;
  }
  return { ...request, chosenModel: chosen };
}
