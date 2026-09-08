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
import {
  awaitFoundryLandingRecorded, awaitImpliedExport, findLandedExport,
} from '../foundry-landing-wait';
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
  /**
   * AN IMPLIED EXPORT — the file Foundry wrote where the host said (`to`), which
   * is filed nowhere and announced to nobody (Owen, 2026-09-08: the EPUB a
   * narration is made from is not a version unless somebody asked for one). The
   * row this step hangs under IS the export; the engine runs this step only once
   * that row is done, so the whole wait is "is the file there".
   */
  unfiledPath?: string;
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
    if (config.unfiledPath !== undefined) {
      if (!path.isAbsolute(config.unfiledPath)) {
        throw new Error(
          `This export-landing row names its implied export as "${config.unfiledPath}", which is `
          + 'not an absolute path. The row was composed wrongly rather than the work failing.');
      }
      /*
       * WAIT FOR THE PROMISE, NOT FOR THE DIRECTORY. The export is on FOUNDRY's
       * own queue (`exportEpubFromStep` ends in `enqueueHere`), chained behind
       * the very text pass this row hangs under — so at the moment this step
       * becomes runnable the file is typically seconds away, and polling would
       * be this side guessing at a fact the mount already promised us.
       * `awaitImpliedExport` resolves when that promise settles and REJECTS with
       * Foundry's own sentence when the export failed, which is the honest thing
       * to tell somebody whose narration has no book to read.
       */
      ctx.report({ message: `Waiting for ${path.basename(config.unfiledPath)} to be written` });
      const held = await awaitImpliedExport(config.unfiledPath, ctx.signal);
      const fs = await import('node:fs');
      if (!fs.existsSync(config.unfiledPath)) {
        throw new Error(held === 'unheld'
          ? `The export this narration reads (${config.unfiledPath}) is not on disk, and nothing in `
            + 'this app is making it — the press that ordered it was in an earlier run, and an '
            + 'implied export does not survive one. Press Narrate on the step again.'
          : `Foundry reported the export at ${config.unfiledPath} as written and it is not there.`);
      }
      ctx.report({ percent: 100, message: `Book for narration: ${path.basename(config.unfiledPath)}`, detail: null });
      return {
        kind: 'epub',
        path: config.unfiledPath,
        detail: { projectDir: config.bookDir,
                  ...(config.forStep === undefined ? {} : { forStep: config.forStep }) },
      };
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
