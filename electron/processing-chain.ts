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
 *
 * ── REPAIR AND LAYOUT ARE TWO PASSES ─────────────────────────────────────────
 *
 * `ocr-correction` repairs what Tesseract misread; `detection` labels every
 * block so an EPUB can be built out of them. They were one unit until Aug 2026,
 * on the reasoning that neither half is useful alone — which is false in the case
 * that matters: a PDF with an embedded text layer is read accurately by Tesseract
 * and has nothing to repair, so the repair stage is half an hour of GPU spent to
 * change nothing, while the layout stage is still needed. So they are two passes,
 * two queue jobs and two provenance records.
 *
 * `tesseract` is still not a pass a caller may ask for. Reading the pages is the
 * FIRST STAGE of whichever pass needs a scan and cannot find one — OCR correction
 * always, Detection when nothing else in the run or on disk provides it. The kind
 * survives in the manifest (a book records what was done to it) and in nothing
 * else; a request naming it is refused rather than folded in, so a caller written
 * against the old shape is told, not obeyed.
 *
 * ── FOOTNOTE REMOVAL IS TWO PASSES WEARING ONE NAME ──────────────────────────
 *
 * `foundry footnotes` takes two inputs, and which one it reads is decided by
 * what the RUN reads, not by the pass:
 *
 *   PDF run  → `--run <dir>`: a stage of the scan chain, before the export.
 *   EPUB run → `--epub <book>`: an EPUB pass, rewriting the book in place,
 *              subject to the same ordering rules as simplify and translate.
 *
 * So `footnotes` counts as a foundry pass only when the source is a PDF, and
 * the plan records the mode (`PassJobConfig.footnotesMode`) rather than leaving
 * the executor to infer it from which fields are set.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import type { AppliedPassKind, ProjectManifest } from './manifest-types';
import { foundryStagesDone } from './foundry-run';
import type { DetectionMode } from '../shared/processing/pass-types';
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

/**
 * The queue job each requestable pass becomes. `tesseract` is absent on purpose:
 * reading the pages is the FIRST STAGE of the pass that needs a scan, not a job
 * of its own, and a request that names it is refused rather than quietly folded
 * in.
 */
const JOB_TYPE_OF: Record<Exclude<AppliedPassKind, 'tesseract'>, PassJobType> = {
  'ocr-correction': 'foundry-ocr',
  detection: 'foundry-detect',
  footnotes: 'foundry-footnotes',
  simplify: 'simplify',
  translate: 'translate-pass',
};

const LABEL_OF: Record<AppliedPassKind, string> = {
  tesseract: 'Tesseract',
  'ocr-correction': 'OCR correction',
  detection: 'Detection',
  footnotes: 'Footnote removal',
  simplify: 'Simplify',
  translate: 'Translate',
};

/**
 * The passes that can ONLY be foundry run stages: they read the scanned pages,
 * and nothing else can stand in for them. `footnotes` is deliberately not in it
 * (a foundry stage on a PDF run, an EPUB pass otherwise), and this is how the
 * question "does this run need a PDF?" is asked of every pass.
 */
const SCAN_ONLY_KINDS = new Set<AppliedPassKind>(['ocr-correction', 'detection']);

/**
 * What a foundry pass needs to have happened first, in foundry's own terms.
 *
 * OCR correction and Detection need NOTHING: each runs the scan itself when it
 * has to, as its first stage, so there is no earlier pass for either to stand on.
 *
 * Footnote removal needs the BLOCKS, not the repaired text. foundry's footnotes
 * stage reads `blocks/blocks.json` and judges block text; it uses the ocr
 * artifact only if one happens to be there, and the export builds its text base
 * the same way, so a book with no ocr stage is consistent end to end. Requiring
 * `ocr` here is what used to stop a born-digital PDF — which has nothing to
 * repair — from having its markers removed.
 */
const FOUNDRY_NEEDS: Partial<Record<AppliedPassKind, { stage: 'scan' | 'ocr' | 'blocks'; pass: AppliedPassKind }>> = {
  footnotes: { stage: 'blocks', pass: 'detection' },
};





/**
 * The queue job a pass becomes, or a refusal naming the one kind that is not a
 * job. The check above catches this while the run is still a request; this is the
 * same fact stated where the type is, so no cast is needed to build the plan.
 */
function jobTypeOf(kind: AppliedPassKind): PassJobType {
  if (kind === 'tesseract') {
    throw new Error(
      `${LABEL_OF['tesseract']} has no queue job: it is the first stage of whichever pass needs a `
      + `scan and cannot find one (${LABEL_OF['ocr-correction']}, or ${LABEL_OF['detection']}).`
    );
  }
  return JOB_TYPE_OF[kind];
}

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
 * A scan chain needs a PDF and says so by name when the project has none —
 * "this book was imported as an EPUB, so there is nothing for the OCR pass to
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
        + 'Put the Detection pass ahead of them — it is what builds the book out of the scanned '
        + 'pages — or export the book from the editor first.'
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
      'The OCR correction and Detection passes read a PDF, and this project has none — it was '
      + 'imported as an EPUB. Use the Footnote removal, Simplify and Translate passes on it instead.'
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

  // Said before anything else is resolved, because a caller sending the retired
  // pair would otherwise get a confusing prerequisite error about a pass it did
  // ask for. See the header: the scan is a STAGE of OCR correction now.
  if (passes.some((p) => p.kind === 'tesseract')) {
    throw new Error(
      `${LABEL_OF['tesseract']} is not a pass of its own: reading the pages is the first stage of `
      + `${LABEL_OF['ocr-correction']}, and of ${LABEL_OF['detection']} when nothing else in the `
      + 'run has read them. Ask for those passes instead.'
    );
  }

  // The scan passes decide whether this run reads a PDF; the source then decides
  // what a `footnotes` pass IS (see the header). Resolving in that order is what
  // keeps a footnotes-only run over the book EPUB from being told to find a PDF.
  const needsPdf = passes.some((p) => SCAN_ONLY_KINDS.has(p.kind));
  const sourcePath = await resolveSource(request, projectDir, manifest, needsPdf);
  const sourceIsPdf = path.extname(sourcePath).toLowerCase() === '.pdf';
  if (needsPdf && !sourceIsPdf) {
    const scanPass = passes.find((p) => SCAN_ONLY_KINDS.has(p.kind))!;
    throw new Error(
      `${LABEL_OF[scanPass.kind]} reads the scanned pages of a PDF, and this run was pointed at `
      + `${path.basename(sourcePath)}. Pick the PDF version of this book, or drop that pass.`
    );
  }
  const isFoundryPass = (kind: AppliedPassKind): boolean =>
    SCAN_ONLY_KINDS.has(kind) || (kind === 'footnotes' && sourceIsPdf);

  // The one option footnote removal has belongs to the EPUB reading of a book.
  // A PDF run reads the scanned pages, where note bodies and index entries are
  // not populations anything can name — so an option that could not be honoured
  // is refused rather than accepted and ignored.
  const askEverywhereOnPdf = passes.find(
    (p) => p.kind === 'footnotes' && sourceIsPdf && p.footnotes?.askEverything
  );
  if (askEverywhereOnPdf) {
    throw new Error(
      `${LABEL_OF['footnotes']}'s "also check note bodies and index entries" option applies to a `
      + 'book EPUB, and this run reads the scanned pages of a PDF. Turn it off, or run the pass '
      + 'over the book EPUB instead.'
    );
  }

  // A foundry pass after an EPUB pass would rebuild the book from the scan and
  // discard everything the EPUB pass wrote. Refused, not reordered: reordering
  // would silently run something other than what the user composed.
  const lastFoundryAt = passes.map((p) => isFoundryPass(p.kind)).lastIndexOf(true);
  const firstEpubAt = passes.findIndex((p) => !isFoundryPass(p.kind));
  if (lastFoundryAt >= 0 && firstEpubAt >= 0 && firstEpubAt < lastFoundryAt) {
    throw new Error(
      `${LABEL_OF[passes[lastFoundryAt].kind]} rebuilds the book from the scanned pages, which would `
      + `throw away what ${LABEL_OF[passes[firstEpubAt].kind]} wrote before it. Move the passes that `
      + 'read the scanned pages above the others.'
    );
  }

  const anyFoundry = lastFoundryAt >= 0;
  const bookKey = anyFoundry ? (request.bookKey || sourcePath) : undefined;
  const doneOnDisk = bookKey ? foundryStagesDone(bookKey) : new Set<string>();

  // ── OCR correction invalidates the layout ───────────────────────────────────
  //
  // The pass wipes the run directory and reads the pages again, which mints a new
  // scan with new line ids. Every block artifact on disk names the OLD ones, so
  // what the previous Detection produced describes a scan that no longer exists —
  // and foundry's export would refuse it, an hour of OCR later, in the last
  // minute of the run. Said here instead, before anything is queued.
  //
  // Refused rather than added silently: a run that quietly grows a stage the user
  // did not ask for is a run whose cost they cannot predict, and Detection on a
  // full book is not a rounding error.
  const ocrAt = passes.map((p) => p.kind === 'ocr-correction').lastIndexOf(true);
  if (ocrAt >= 0) {
    const detectAt = passes.findIndex((p, i) => p.kind === 'detection' && i > ocrAt);
    if (detectAt < 0) {
      const above = passes.some((p) => p.kind === 'detection');
      throw new Error(
        `${LABEL_OF['ocr-correction']} re-reads the pages, which invalidates the old layout — the `
        + `blocks describe a scan this pass replaces. `
        + (above
          ? `Move the ${LABEL_OF['detection']} pass below it.`
          : `Add the ${LABEL_OF['detection']} pass to this run, after it.`)
      );
    }
  }

  const kindsSoFar = new Set<AppliedPassKind>();
  for (const pass of passes) {
    // An EPUB-mode footnotes pass stands on the book, not on a scan: it has the
    // prerequisites of an EPUB pass, which is none.
    const needs = isFoundryPass(pass.kind) ? FOUNDRY_NEEDS[pass.kind] : undefined;
    if (needs && !kindsSoFar.has(needs.pass) && !doneOnDisk.has(needs.stage)) {
      throw new Error(
        `${LABEL_OF[pass.kind]} reads what ${LABEL_OF[needs.pass]} produced, and this book has not had `
        + `it. Add ${LABEL_OF[needs.pass]} to the run, above it.`
      );
    }
    // Recorded AFTER the check — a pass cannot be its own prerequisite — and on
    // every iteration, which is what makes "earlier in the chain" mean anything.
    kindsSoFar.add(pass.kind);
  }

  // The export at the end of the foundry group needs laid-out blocks. Page text
  // with no layout is not a book, so a foundry group that never labels the blocks
  // produces no EPUB — and any EPUB pass behind it has nothing to read.
  const willHaveBlocks = passes.some((p) => p.kind === 'detection') || doneOnDisk.has('blocks');
  const producesEpub = lastFoundryAt >= 0 && willHaveBlocks;
  if (lastFoundryAt >= 0 && firstEpubAt >= 0 && !producesEpub) {
    throw new Error(
      'Nothing in this run labels the blocks of the scanned pages, so no EPUB comes out of it — '
      + `and ${LABEL_OF[passes[firstEpubAt].kind]} has nothing to read. Add the `
      + `${LABEL_OF['detection']} pass.`
    );
  }

  const pages = anyFoundry ? await resolvePages(sourcePath, manifest) : undefined;

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
  /**
   * Has a pass EARLIER in this chain read the pages? Walked in execution order
   * as the jobs are built, which is the only place the answer exists: it is not
   * a property of the disk (the OCR pass is about to wipe it) and not a property
   * of any single pass.
   */
  let scanInChain = false;
  const jobs: PlannedPassJob[] = passes.map((pass, i) => {
    const stage = manifestService.passStageRelDir(base + i + 1, pass.kind);
    const diff = `${stage}/diff.json`;
    const isFoundry = isFoundryPass(pass.kind);
    const isLastFoundry = isFoundry && i === lastFoundryAt;

    // Where Detection's scan comes from, decided HERE and stated in the job — the
    // footnotes precedent. A chain that reads the pages above it feeds it; a run
    // directory that already holds a finished scan is INPUT to it, the way the
    // book EPUB is input to a simplify pass; and when there is neither, it reads
    // the pages itself and the book records that it did.
    const detectionMode: DetectionMode | undefined = pass.kind === 'detection'
      ? (scanInChain ? 'scan-in-chain' : (doneOnDisk.has('scan') ? 'scan-on-disk' : 'scan-here'))
      : undefined;
    // OCR correction always reads the pages; Detection only in `scan-here`.
    if (pass.kind === 'ocr-correction' || detectionMode === 'scan-here') scanInChain = true;

    if (isFoundry) {
      // ONE job, sometimes TWO provenance records: a pass that had to read the
      // pages did two things to the book and says so. The kinds are the
      // manifest's contract; the queue's row count is not.
      //
      // tesseract has nothing to diff against — it IS the first reading of the
      // page. Neither has detection: it labels blocks, it does not change text.
      if (pass.kind === 'ocr-correction' || detectionMode === 'scan-here') {
        foundryStageDirs.push({ kind: 'tesseract' });
      }
      foundryStageDirs.push(
        pass.kind === 'detection' ? { kind: pass.kind } : { kind: pass.kind, diff }
      );
    }

    const config: PassJobConfig = {
      kind: pass.kind,
      projectDir,
      stageRelDir: stage,
      ...(isFoundry ? { pdfPath: sourcePath, pages, bookKey } : {}),
      ...(detectionMode ? { detectionMode } : {}),
      // Said outright, never inferred: the two footnote passes share a name, a
      // job type and a queue row, and only the plan knows which one this is.
      ...(pass.kind === 'footnotes'
        ? {
          footnotesMode: (isFoundry ? 'foundry-run' : 'epub') as 'foundry-run' | 'epub',
          ...(pass.footnotes ? { footnotes: pass.footnotes } : {}),
        }
        : {}),
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

    return { jobType: jobTypeOf(pass.kind), label: LABEL_OF[pass.kind], config };
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
