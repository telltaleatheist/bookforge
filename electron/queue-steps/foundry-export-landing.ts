/**
 * foundry-export-landing — hand a Foundry export to the narration when it lands.
 *
 * ── Why it is a step at all ─────────────────────────────────────────────────
 *
 * Owen, 2026-09-07: "i click the grayed out row and hit the export epub tile ...
 * i can click the grayed out exported epub and click narrate. then send
 * narration and assembly to the queue." At the press there is no file: the
 * export is a pending row in this queue, chained under a clean-up that has not
 * run. A narration run's first step reads an `epub` artifact, and the only
 * honest source for one that does not exist yet is a step that RUNS AFTER the
 * export's row lands and answers "which file, which version" at that moment.
 *
 * So this row sits under the export's Foundry row (`parentStepId` = that row),
 * the narration sits under this one, and the engine's own lineage does the
 * waiting and the cascade: cancel or remove the clean-up and this goes with it.
 *
 * ── What it looks up, and why it does not file anything ─────────────────────
 *
 * The landing is FILED by main's `recordFoundryExportLanding` when Foundry
 * announces it — a copy into the book's folder and a version row with Foundry
 * provenance (`FoundryVariantSource`: project key, file name, step). That door
 * is idempotent and it is the only writer; a second writer here would be the
 * two-copies-of-one-truth this seam was built to avoid. This step WAITS for
 * that recording to settle (`awaitFoundryLandingRecorded` — the announcement is
 * a promise this side holds, not a thing to poll for) and then reads the
 * manifest once. A version that is not there after the recording settled is a
 * filing that failed, and its reason is already in the log: refused by name.
 */
import * as path from 'node:path';
import * as manifestService from '../manifest-service';
import { awaitFoundryLandingRecorded, findLandedExport } from '../foundry-landing-wait';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import type { ProjectVariant } from '../manifest-types';

export interface FoundryExportLandingConfig {
  /** The BookForge book folder, absolute — the library side of the mapping. */
  bookDir: string;
  /** The Foundry project KEY (its folder name), the other side of the mapping. */
  projectKey: string;
  /** The export's file name as Foundry's tray will announce it. */
  fileName: string;
  /** The ledger step the export is cast from, when the row said. */
  forStep?: string;
}

function refuseMissing(config: FoundryExportLandingConfig): Error {
  const map = config.bookDir ? path.basename(config.bookDir) : 'the book';
  return new Error(
    `Foundry's export "${config.fileName}" (project ${config.projectKey}) landed, but it is not on `
    + `${map}'s versions list, so the narration chained onto it has no book to read. The reason `
    + 'the landing could not be recorded is in the log above ("[foundry-host] ..."). Nothing was '
    + 'narrated; press Narrate on the export row once it is listed.');
}

export const foundryExportLandingStep: StepModule = {
  type: 'foundry-export-landing',
  // Chained under a Foundry row, which produces no artifact the engine models.
  consumes: null,
  produces: 'epub',
  resource: () => 'cpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as FoundryExportLandingConfig;
    for (const key of ['bookDir', 'projectKey', 'fileName'] as const) {
      if (typeof config?.[key] !== 'string' || config[key] === '') {
        throw new Error(
          `This export-landing row carries no ${key}, so it cannot say which file it waits for. `
          + 'The row was composed wrongly rather than the work failing.');
      }
    }
    const projectId = path.basename(config.bookDir);
    const lookUp = async (): Promise<ProjectVariant | null> => {
      const got = await manifestService.getManifest(projectId);
      if (!got.manifest) {
        throw new Error(
          `${projectId} could not be read (${got.error || 'no reason given'}), so the export `
          + 'this narration waits for cannot be looked up.');
      }
      return findLandedExport(
        manifestService.getVariants(got.manifest).variants, config.projectKey, config.fileName);
    };

    ctx.report({ message: `Waiting for ${config.fileName} to be recorded as a version` });
    let variant = await lookUp();
    if (variant === null) {
      await awaitFoundryLandingRecorded(config.projectKey, config.fileName, ctx.signal);
      variant = await lookUp();
    }
    if (variant === null) throw refuseMissing(config);

    const epubPath = path.join(config.bookDir, ...variant.path.split('/'));
    ctx.report({ percent: 100, message: `Exported book: ${path.basename(epubPath)}`, detail: null });
    return {
      kind: 'epub',
      path: epubPath,
      // The identity the narration's row would have carried had the export
      // existed at the press: the version, and the book it belongs to.
      detail: { variantId: variant.id, projectDir: config.bookDir,
                ...(config.forStep === undefined ? {} : { forStep: config.forStep }) },
    };
  },

  cancel(): void {
    // The abort signal is the cancel: the wait rejects on it.
  },
};
