/**
 * processing-chain — a run is an ordered list of passes over ONE project.
 *
 * The wizard (phase 4) builds a sidebar of passes and hands it here. Everything
 * that can be decided up front is decided HERE, before a single job is queued:
 * which file the passes read, which pages, where each pass's stage directory
 * goes, and whether the ordering is legal at all. A chain that cannot work is
 * refused with the reason — never accepted and discovered at step four, three
 * hours in, by a stage that cannot find its input.
 *
 * ── ORDERING RULES, AND WHY ──────────────────────────────────────────────────
 *
 * The foundry passes do not read the book: they read a PDF's run directory, and
 * the book is EXPORTED from that directory once, by the last of them. So an EPUB
 * pass (simplify, translate) that runs before a foundry pass would have its work
 * overwritten by that export — the rebuilt book comes from the scan, which never
 * heard of it. That is silent, total data loss, so the plan refuses it rather
 * than ordering it.
 *
 * Within the foundry group the order is foundry's own contract (scan → ocr →
 * blocks → footnotes) and it is not the user's to change; the plan checks that
 * each pass's prerequisite is either earlier in the chain or already done on
 * disk from a previous run.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import type { AppliedPassKind, ProjectManifest } from './manifest-types';
import { foundryStagesDone } from './foundry-run';
import type {
  ChainPassRequest,
  PassJobConfig,
  PassJobType,
  PlannedPassJob,
  ProcessingChainPlan,
  ProcessingChainRequest,
} from '../shared/processing/pass-types';

export type {
  ChainPassRequest,
  PassJobType,
  PlannedPassJob,
  ProcessingChainPlan,
  ProcessingChainRequest,
} from '../shared/processing/pass-types';

const JOB_TYPE_OF: Record<AppliedPassKind, PassJobType> = {
  tesseract: 'foundry-scan',
  'ocr-correction': 'foundry-ocr-correct',
  footnotes: 'foundry-footnotes',
  simplify: 'simplify',
  translate: 'translate-pass',
};

const LABEL_OF: Record<AppliedPassKind, string> = {
  tesseract: 'Tesseract',
  'ocr-correction': 'OCR correction',
  footnotes: 'Footnote removal',
  simplify: 'Simplify',
  translate: 'Translate',
};

const FOUNDRY_KINDS = new Set<AppliedPassKind>(['tesseract', 'ocr-correction', 'footnotes']);

/** What a foundry pass needs to have happened first, in foundry's own terms. */
const FOUNDRY_NEEDS: Partial<Record<AppliedPassKind, { stage: 'scan' | 'ocr'; pass: AppliedPassKind }>> = {
  'ocr-correction': { stage: 'scan', pass: 'tesseract' },
  footnotes: { stage: 'ocr', pass: 'ocr-correction' },
};





async function readManifest(projectDir: string): Promise<ProjectManifest> {
  const raw = await fs.promises.readFile(path.join(projectDir, 'manifest.json'), 'utf-8');
  return JSON.parse(raw) as ProjectManifest;
}

function resolveProjectDir(request: ProcessingChainRequest): string {
  if (request.projectDir) return request.projectDir;
  if (request.projectId) return manifestService.getProjectPath(request.projectId);
  throw new Error('A processing run needs a project; neither projectDir nor projectId was given.');
}

/**
 * The document the passes read.
 *
 * A foundry chain needs a PDF and says so by name when the project has none —
 * "this book was imported as an EPUB, so there is nothing for Tesseract to
 * read" is a sentence a user can act on, unlike a missing-file error from three
 * layers down.
 */
async function resolveSource(
  request: ProcessingChainRequest,
  projectDir: string,
  manifest: ProjectManifest,
  needsPdf: boolean
): Promise<string> {
  if (request.sourcePath) {
    if (!fs.existsSync(request.sourcePath)) {
      throw new Error(`The chosen source ${request.sourcePath} is not there.`);
    }
    return request.sourcePath;
  }

  if (request.variantId) {
    const { variants } = manifestService.getVariants(manifest);
    const variant = variants.find((v) => v.id === request.variantId);
    if (!variant) {
      throw new Error(`This project has no variant ${request.variantId}; pick one of its listed versions.`);
    }
    const abs = path.join(projectDir, variant.path.split('/').join(path.sep));
    if (!fs.existsSync(abs)) {
      throw new Error(`The "${variant.descriptor || variant.format}" version points at ${abs}, which is not there.`);
    }
    return abs;
  }

  if (!needsPdf) return manifestService.readExportEpub(projectDir).then((record) => {
    if (!record) {
      throw new Error(
        'This project has no book EPUB yet, so there is nothing for these passes to read. '
        + 'Put the Tesseract and OCR-correction passes ahead of them, or export the book from the editor first.'
      );
    }
    if (!fs.existsSync(record.absPath)) {
      throw new Error(`The project's book is recorded as ${record.relPath}, but that file is not there.`);
    }
    return record.absPath;
  });

  const { variants } = manifestService.getVariants(manifest);
  const pdf = variants.find((v) => v.format.toLowerCase() === 'pdf');
  const candidates = [
    ...(pdf ? [path.join(projectDir, pdf.path.split('/').join(path.sep))] : []),
    path.join(projectDir, 'source', 'original.pdf'),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error(
      'The Tesseract / OCR-correction / footnote passes read a PDF, and this project has none — '
      + 'it was imported as an EPUB. Use the Simplify and Translate passes on it instead.'
    );
  }
  return found;
}

/** Every page of the document, in the order the editor kept them. */
async function resolvePages(pdfPath: string, manifest: ProjectManifest): Promise<number[]> {
  const order = manifest.source?.pageOrder;
  if (order?.length) return [...order];
  const { callCountPages } = await import('./pdf-worker-proxy.js');
  const count = await callCountPages(pdfPath);
  if (!count || count < 1) {
    throw new Error(`${path.basename(pdfPath)} reports ${count} pages; there is nothing to OCR.`);
  }
  return Array.from({ length: count }, (_, i) => i);
}

/**
 * Validate and lay out a run. Nothing is queued here — this is the answer to
 * "what would this run do?", and it is the same answer the submission uses.
 */
export async function planProcessingChain(request: ProcessingChainRequest): Promise<ProcessingChainPlan> {
  const projectDir = resolveProjectDir(request);
  if (!fs.existsSync(path.join(projectDir, 'manifest.json'))) {
    throw new Error(`${projectDir} is not a BookForge project (no manifest.json).`);
  }
  const manifest = await readManifest(projectDir);
  const passes = request.passes ?? [];
  if (passes.length === 0) {
    throw new Error('A processing run needs at least one pass.');
  }

  const foundryPasses = passes.filter((p) => FOUNDRY_KINDS.has(p.kind));
  const needsPdf = foundryPasses.length > 0;
  const sourcePath = await resolveSource(request, projectDir, manifest, needsPdf);

  // A foundry pass after an EPUB pass would rebuild the book from the scan and
  // discard everything the EPUB pass wrote. Refused, not reordered: reordering
  // would silently run something other than what the user composed.
  const lastFoundryAt = passes.map((p) => FOUNDRY_KINDS.has(p.kind)).lastIndexOf(true);
  const firstEpubAt = passes.findIndex((p) => !FOUNDRY_KINDS.has(p.kind));
  if (lastFoundryAt >= 0 && firstEpubAt >= 0 && firstEpubAt < lastFoundryAt) {
    throw new Error(
      `${LABEL_OF[passes[lastFoundryAt].kind]} rebuilds the book from the scanned pages, which would `
      + `throw away what ${LABEL_OF[passes[firstEpubAt].kind]} wrote before it. Move the scan-based `
      + 'passes (Tesseract, OCR correction, Footnote removal) above the others.'
    );
  }

  const bookKey = needsPdf ? (request.bookKey || sourcePath) : undefined;
  const doneOnDisk = bookKey ? foundryStagesDone(bookKey) : new Set<string>();
  const kindsSoFar = new Set<AppliedPassKind>();
  for (const pass of passes) {
    const needs = FOUNDRY_NEEDS[pass.kind];
    if (!needs) continue;
    if (kindsSoFar.has(needs.pass) || doneOnDisk.has(needs.stage)) continue;
    throw new Error(
      `${LABEL_OF[pass.kind]} reads what ${LABEL_OF[needs.pass]} produced, and this book has not had `
      + `it. Add ${LABEL_OF[needs.pass]} to the run, above it.`
    );
  }

  // The export at the end of the foundry group needs laid-out blocks. A scan on
  // its own has none, so a Tesseract-only run produces no book — and any EPUB
  // pass behind it has nothing to read.
  const willHaveBlocks = passes.some((p) => p.kind === 'ocr-correction') || doneOnDisk.has('blocks');
  const producesEpub = lastFoundryAt >= 0 && willHaveBlocks;
  if (lastFoundryAt >= 0 && firstEpubAt >= 0 && !producesEpub) {
    throw new Error(
      'A Tesseract pass on its own produces page text with no layout, so no EPUB comes out of it — '
      + `and ${LABEL_OF[passes[firstEpubAt].kind]} has nothing to read. Add the OCR correction pass.`
    );
  }

  const pages = needsPdf ? await resolvePages(sourcePath, manifest) : undefined;

  // Where the book will be. A foundry chain writes the canonical name (the book
  // may have been retitled since the last export); everything else rewrites the
  // recorded file in place.
  const target = await manifestService.exportEpubTarget(projectDir);
  const record = await manifestService.readExportEpub(projectDir);
  const bookEpubPath = producesEpub ? target.absPath : (record?.absPath ?? target.absPath);

  // Stage numbering. An export starts the book's provenance over — the rebuilt
  // book has had nothing else done to it — so a chain that exports numbers from
  // 1, and one that does not carries on from what the book already records.
  const base = producesEpub ? 0 : (record ? (manifest.outputs?.epub?.appliedPasses?.length ?? 0) : 0);

  const foundryStageDirs: Array<{ kind: AppliedPassKind; diff?: string }> = [];
  const jobs: PlannedPassJob[] = passes.map((pass, i) => {
    const stage = manifestService.passStageRelDir(base + i + 1, pass.kind);
    const diff = `${stage}/diff.json`;
    const isFoundry = FOUNDRY_KINDS.has(pass.kind);
    const isLastFoundry = isFoundry && i === lastFoundryAt;
    if (isFoundry) {
      // tesseract has nothing to diff against — it IS the first reading of the page.
      foundryStageDirs.push({ kind: pass.kind, ...(pass.kind === 'tesseract' ? {} : { diff }) });
    }

    const config: PassJobConfig = {
      kind: pass.kind,
      projectDir,
      stageRelDir: stage,
      ...(isFoundry ? { pdfPath: sourcePath, pages, bookKey } : {}),
      ...(pass.redo ? { redo: true } : {}),
      ...(isLastFoundry && producesEpub
        ? { exportAfter: true, exportPasses: [...foundryStageDirs] }
        : {}),
      ...(pass.simplify ? { simplify: pass.simplify } : {}),
      ...(pass.translate ? { translate: pass.translate } : {}),
    };

    if (pass.kind === 'simplify' && !pass.simplify) {
      throw new Error('The Simplify pass needs a mode and a model; none were given.');
    }
    if (pass.kind === 'translate' && !pass.translate) {
      throw new Error('The Translate pass needs source and target languages and a model; none were given.');
    }

    return { jobType: JOB_TYPE_OF[pass.kind], label: LABEL_OF[pass.kind], config };
  });

  return {
    projectId: manifest.projectId || path.basename(projectDir),
    projectDir,
    title: manifest.metadata?.title || path.basename(projectDir),
    sourcePath,
    bookEpubPath,
    producesEpub,
    jobs,
  };
}
