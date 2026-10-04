/**
 * narration-guide — the book's PRONUNCIATION GUIDE, built as its own step.
 *
 * Owen, 2026-10-03: *"the glossary building step should be its own process. and
 * if the user wants to rebuild the glossary from zero, they can"* — *"the glossary
 * is a step the user can take if they want to … if they want to run glossary
 * alone, they can go back to foundry when its done and review the words.
 * otherwise everything is autonomous"*.
 *
 * So this step is the tree's "Pronunciation guide", pressed on any step of a
 * book: it lists the book's printed forms AT THAT STEP (Foundry's
 * `printedFormsAt`) and decides how each is said (`narration-glossary.ts`). Told
 * `fromZero`, it drops every decision first — a person's included. A cleanup
 * later reads the guide it made and never rebuilds it; one with no guide builds
 * it first, through the same builder, inside its own row.
 *
 * Nothing is chained onto it and it produces no file another step reads: the
 * guide is found by the cleanup by the project's key, where this step wrote it.
 */
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { foundryFormsAtLister } from '../foundry-host-queue';
import { broadcastToAllWindows } from '../document-stage-run';

export interface NarrationGuideStepConfig {
  /** The Foundry project the guide is for. */
  projectDir: string;
  /** The ledger step pressed on — the book the forms are listed from. Null: where the book stands. */
  at: string | null;
  /** Drop every decision first, a person's included, and decide the whole book again. */
  fromZero: boolean;
  /** The book's title, for the row. */
  bookTitle: string;
}

export const narrationGuideStep: StepModule = {
  type: 'narration-guide',
  consumes: null,
  produces: 'none',
  /*
   * THE CARD: the guide asks the server's analysis model, a chat per form and a
   * decide item per occurrence — model work on the GPU, travelling with the book
   * like every other text act (`foundry-job`'s argument for `resourceFor`).
   */
  resource: () => 'gpu',
  machines: () => 'any',
  crucibleClass: () => 'analysis',
  /*
   * NO `leasesModel`: the builder takes and releases its own session
   * (`takeCrucibleLease`, narration-glossary.ts) inside this run, so nothing is
   * held for the row after it.
   */
  stopIsResumable: true,

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as NarrationGuideStepConfig;
    if (typeof config?.projectDir !== 'string' || config.projectDir === '') {
      throw new Error('This pronunciation-guide row names no book, so there is nothing to build it for.');
    }
    if (typeof config.fromZero !== 'boolean') {
      throw new Error('This pronunciation-guide row does not say whether to start from zero; it was composed wrongly.');
    }
    const { decideWhereTextActRuns, processTextVenueHost } = await import('../crucible/text-venue.js');
    const { runVenueOfRow } = await import('../crucible/step-venue.js');
    const venue = await decideWhereTextActRuns(runVenueOfRow(ctx.job.waitForResolved)?.server, processTextVenueHost());
    const line = `[narration-guide] the guide goes to crucible "${venue.server}" (${venue.because})`;
    console.log(line);
    ctx.report({ message: line, detail: line });

    const { ensureNarrationGlossary, guideAtStep } = await import('../narration-glossary.js');
    const made = await ensureNarrationGlossary({
      source: guideAtStep(config.projectDir, config.at, foundryFormsAtLister()),
      server: venue.server,
      signal: ctx.signal,
      report: (said) => ctx.report({ message: said, detail: said }),
      fromZero: config.fromZero,
    });
    const done = `pronunciation guide: ${made.forms} printed form(s), ${made.readings} spot(s) decided`
      + `${made.unplaced > 0 ? `, ${made.unplaced} left to their sentence — review them in Foundry` : ''}`;
    ctx.report({ message: done, detail: done });
    broadcastToAllWindows('project:files-changed', config.projectDir);
    return { kind: 'none' };
  },

  cancel(): void {
    // The builder follows the run's signal; there is no process of its own to stop.
  },
};
