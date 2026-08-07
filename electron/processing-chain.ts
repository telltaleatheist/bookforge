/**
 * processing-chain — a run is an ordered list of passes over ONE project.
 *
 * The wizard builds a sidebar of passes and hands it here. Everything that can
 * be decided up front is decided HERE, before a single job is queued: which
 * document the passes read, where each pass's stage directory goes, and whether
 * the ordering is legal at all. A chain that cannot work is refused with the
 * reason — never accepted and discovered at step four, three hours in, by a
 * stage that cannot find its input.
 *
 * ── ORDERING RULES, AND WHY ──────────────────────────────────────────────────
 *
 * The document passes do not read the book: they read and write the WORKING
 * DOCUMENT, and the book is written out of it once, by Reflow. So an EPUB pass
 * (footnotes on the book, simplify, translate) that runs before a Reflow would
 * have its work overwritten by that Reflow — the rebuilt book comes from the
 * working document, which never heard of it. That is silent, total data loss, so
 * the plan refuses it rather than ordering it.
 *
 * Within the document group the order is the pipeline's own — Get Text → Blocks
 * → Reflow — and it is not the user's to change. Each pass's prerequisite is
 * checked against the chain ahead of it AND against the documents already on
 * disk, and the second half is why a book that was scanned last week can have
 * just its blocks re-run today.
 *
 * ── PREREQUISITES ARE READ OFF THE DOCUMENTS ─────────────────────────────────
 *
 * Not off a run record. `readDocumentPipelineState` opens the working document
 * and answers from what is IN it: a marker means Get Text has run, block
 * annotations mean Blocks has, a book on disk the binding vouches for means
 * Reflow has. So the question "can this chain run?" is answered by the same
 * files the stages themselves will read, and there is no third thing that can
 * disagree with both.
 *
 * ── THERE IS NO OCR-CORRECTION PASS ──────────────────────────────────────────
 *
 * Repairing what Tesseract misread happens INSIDE Reflow, on the kept lines
 * only, after the user has culled what the book does not need — so the blocks
 * somebody deleted cost zero GPU instead of half an hour of it. It was a pass of
 * its own while the repair was assumed to precede curation; putting it after
 * curation is what made it stop being one.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import type { AppliedPassKind, ProjectManifest } from './manifest-types';
import { resolveDocumentProject } from './document-project';
import { readDocumentPipelineState } from './document-stages';
import type {
  ChainPassRequest,
  PassJobConfig,
  PassJobType,
  PlannedPassJob,
  ProcessingChainPlan,
  ProcessingChainRequest,
  ProcessingPassKind,
} from '../shared/processing/pass-types';

export type {
  ChainPassRequest,
  PassJobType,
  PlannedPassJob,
  ProcessingChainPlan,
  ProcessingChainRequest,
} from '../shared/processing/pass-types';

const JOB_TYPE_OF: Record<ProcessingPassKind, PassJobType> = {
  'get-text': 'document-get-text',
  blocks: 'document-blocks',
  reflow: 'document-reflow',
  footnotes: 'foundry-footnotes',
  simplify: 'simplify',
  translate: 'translate-pass',
};

const LABEL_OF: Record<AppliedPassKind, string> = {
  'get-text': 'Get Text',
  blocks: 'Detect blocks',
  reflow: 'Build the book',
  footnotes: 'Footnote removal',
  simplify: 'Simplify',
  translate: 'Translate',
  // The other route to a book, and NOT a pass: it is a document stage
  // (electron/vlm-convert.ts) and a chain request naming it is refused by
  // `JOB_TYPE_OF` having no entry for it. Named here because provenance is a
  // book's own history and a converted book records one.
  'vlm-convert': 'Convert to EPUB',
  // Retired — named only so a refusal about an old book's history reads.
  tesseract: 'Tesseract',
  'ocr-correction': 'OCR correction',
  detection: 'Detection',
};

/**
 * The passes that read the WORKING DOCUMENT, and so need the project to have a
 * PDF at all. `footnotes` is deliberately not in it: a document stage on a PDF
 * run, an EPUB pass otherwise.
 */
const DOCUMENT_ONLY_KINDS = new Set<ProcessingPassKind>(['get-text', 'blocks', 'reflow']);

/**
 * What a document pass needs to have happened first, and which pass does it.
 *
 * Get Text needs nothing — it is the cast, and it reads the archive original.
 * Blocks needs a working document to write annotations into. Reflow needs a
 * block layer, because without one nothing says which of a page's lines are the
 * prose and which are the running heads. Footnotes-on-the-PDF needs the cast for
 * the same reason Blocks does: it rewrites a text layer that has to exist.
 */
const DOCUMENT_NEEDS: Partial<Record<ProcessingPassKind, {
  done: 'getText' | 'blocks';
  pass: ProcessingPassKind;
}>> = {
  blocks: { done: 'getText', pass: 'get-text' },
  reflow: { done: 'blocks', pass: 'blocks' },
  // Applies only when the pass is the PDF reading — the prerequisite lookup is
  // gated on isDocumentPass, and the EPUB reading has the prerequisites of an
  // EPUB pass, which is none.
  footnotes: { done: 'getText', pass: 'get-text' },
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
 * A document chain needs a PDF and says so by name when the project has none —
 * "this book was imported as an EPUB, so there is nothing for these passes to
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

  if (!needsPdf) {
    const record = await manifestService.readExportEpub(projectDir);
    if (!record) {
      throw new Error(
        'This project has no book EPUB yet, so there is nothing for these passes to read. '
        + `Put ${LABEL_OF['reflow']} ahead of them — it is what writes the book out of the working `
        + 'document — or export the book from the editor first.'
      );
    }
    if (!fs.existsSync(record.absPath)) {
      throw new Error(`The project's book is recorded as ${record.relPath}, but that file is not there.`);
    }
    return record.absPath;
  }

  // The document pipeline's own resolution, so the planner and every stage pick
  // the same PDF out of a project that holds more than one — and refuse in the
  // same words when nothing said which.
  const project = await resolveDocumentProject({ projectDir });
  return path.join(projectDir, project.primaryRelPath.split('/').join(path.sep));
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

  // Said before anything else is resolved, because a caller sending a retired
  // kind would otherwise get a confusing prerequisite error about a pass it did
  // ask for. See manifest-types: these three survive as HISTORY and nothing else.
  const retired = passes.find((p) =>
    (['tesseract', 'ocr-correction', 'detection'] as string[]).includes(p.kind));
  if (retired) {
    throw new Error(
      `${LABEL_OF[retired.kind as AppliedPassKind]} is not a pass any more. Reading the pages is `
      + `${LABEL_OF['get-text']}, labelling the blocks is ${LABEL_OF['blocks']}, and repairing what `
      + `Tesseract misread happens inside ${LABEL_OF['reflow']} — on the blocks you kept, so the `
      + 'ones you deleted cost nothing. Ask for those passes instead.'
    );
  }

  const needsPdf = passes.some((p) => DOCUMENT_ONLY_KINDS.has(p.kind));
  const sourcePath = await resolveSource(request, projectDir, manifest, needsPdf);
  const sourceIsPdf = path.extname(sourcePath).toLowerCase() === '.pdf';
  if (needsPdf && !sourceIsPdf) {
    const docPass = passes.find((p) => DOCUMENT_ONLY_KINDS.has(p.kind))!;
    throw new Error(
      `${LABEL_OF[docPass.kind]} reads a PDF, and this run was pointed at `
      + `${path.basename(sourcePath)}. Pick the PDF version of this book, or drop that pass.`
    );
  }
  // Which document a footnotes pass reads is decided by WHERE THE USER PUT IT,
  // not by what the run's source file happens to be. Before a later Build the
  // book it is the PDF reading — its edits to the text layer feed that reflow.
  // After one (or when the project's book already exists and no reflow follows)
  // it is the EPUB reading, over the book — which is the spec's default for a
  // scanned book anyway: the adapter measures 97.0% applied / 0.5% false-fire
  // on clean text against 90.5% / 2.1% on raw OCR text. Deciding this by source
  // alone is what silently rewrote the working PDF AFTER the book had been
  // built, so the book kept every marker while the pass reported success.
  const record = await manifestService.readExportEpub(projectDir);
  const reflowIndices = passes
    .map((p, i) => (p.kind === 'reflow' ? i : -1))
    .filter((i) => i >= 0);
  const footnotesModeAt = (index: number): 'pdf' | 'epub' => {
    if (!sourceIsPdf) return 'epub';
    if (reflowIndices.some((r) => r > index)) return 'pdf';
    if (reflowIndices.some((r) => r < index) || record) return 'epub';
    return 'pdf';
  };

  const isDocumentPass = (kind: ProcessingPassKind, index: number): boolean =>
    DOCUMENT_ONLY_KINDS.has(kind) || (kind === 'footnotes' && footnotesModeAt(index) === 'pdf');

  // The one option footnote removal has belongs to the EPUB reading of a book.
  // A PDF reading rewrites a text layer, where note bodies and index entries are
  // not populations anything can name — so an option that could not be honoured
  // is refused rather than accepted and ignored.
  const askEverywhereOnPdf = passes.find(
    (p, i) => p.kind === 'footnotes' && footnotesModeAt(i) === 'pdf' && p.footnotes?.askEverything
  );
  if (askEverywhereOnPdf) {
    throw new Error(
      `${LABEL_OF['footnotes']}'s "also check note bodies and index entries" option applies to a `
      + 'book EPUB, and this run reads the working PDF. Turn it off, or run the pass over the book '
      + 'after Reflow has written it — which is where it works best anyway.'
    );
  }

  // A document pass after an EPUB pass would rebuild the book from the working
  // document and discard everything the EPUB pass wrote. Refused, not reordered:
  // reordering would silently run something other than what the user composed.
  const lastDocumentAt = passes.map((p, i) => isDocumentPass(p.kind, i)).lastIndexOf(true);
  const firstEpubAt = passes.findIndex((p, i) => !isDocumentPass(p.kind, i));
  if (lastDocumentAt >= 0 && firstEpubAt >= 0 && firstEpubAt < lastDocumentAt) {
    throw new Error(
      `${LABEL_OF[passes[lastDocumentAt].kind]} rebuilds the book from the working document, which `
      + `would throw away what ${LABEL_OF[passes[firstEpubAt].kind]} wrote before it. Move the passes `
      + 'that read the PDF above the others.'
    );
  }

  // What the DOCUMENTS say has already happened. Read off the files themselves,
  // which is the same reading every stage does — so a prerequisite that passes
  // here cannot fail at run time for a reason the plan could not see.
  const onDisk = sourceIsPdf
    ? (await readDocumentPipelineState(
        await resolveDocumentProject({ projectDir, sourcePath })
      )).stages
    : { getText: false, blocks: false, footnotes: false, reflow: false };

  // Re-reading the pages invalidates the layout: the cast REPLACES the working
  // document, and the annotations described the one it replaced.
  //
  // RULED 2026-08-04 (docs/PIPELINE_V2_PLAN.md, Owen's first real session):
  // **the cast does not imply a detect.** This used to refuse a run that cast
  // without detecting, on the reasoning that a cast leaves the document with no
  // blocks — true, but it made every press of OCR / Cast enqueue a Detect the
  // user had not asked for ("it added detect to the queue even though i hadnt
  // chosen to detect yet"). The invalidation is real and is handled where it
  // belongs: at the Working station, a book with no blocks offers Detect as its
  // primary action and says so in its own words. A run may cast and stop.
  //
  // What is still refused is the ORDERING — a detect ABOVE the cast that would
  // wipe it — because that one is a chain that cannot work rather than a chain
  // that does less than the user expected.
  const getTextAt = passes.map((p) => p.kind === 'get-text').lastIndexOf(true);
  if (getTextAt >= 0) {
    const wipedBlocksAt = passes.findIndex((p, i) => p.kind === 'blocks' && i < getTextAt);
    if (wipedBlocksAt >= 0 && !passes.some((p, i) => p.kind === 'blocks' && i > getTextAt)) {
      throw new Error(
        `${LABEL_OF['get-text']} reads the pages again and casts the working document fresh, which `
        + `throws away the annotations ${LABEL_OF['blocks']} wrote before it. Move the `
        + `${LABEL_OF['blocks']} pass below it.`
      );
    }
  }

  // The same invalidation, for the text layer: a PDF-reading footnotes pass
  // ahead of a later Get Text has its marker removals cast away with the rest
  // of the working document, silently, by a pass the user also asked for.
  const wipedFootnotesAt = passes.findIndex((p, i) =>
    p.kind === 'footnotes' && footnotesModeAt(i) === 'pdf'
    && passes.some((q, j) => q.kind === 'get-text' && j > i));
  if (wipedFootnotesAt >= 0) {
    throw new Error(
      `${LABEL_OF['get-text']} reads the pages again and casts the working document fresh, which `
      + `discards what ${LABEL_OF['footnotes']} removed from its text layer. Move the `
      + `${LABEL_OF['footnotes']} pass below it.`
    );
  }

  for (const [i, pass] of passes.entries()) {
    // An EPUB-mode footnotes pass stands on the book, not on a working document:
    // it has the prerequisites of an EPUB pass, which is none.
    const needs = isDocumentPass(pass.kind, i) ? DOCUMENT_NEEDS[pass.kind] : undefined;
    if (!needs) continue;

    // A cast EARLIER IN THIS RUN replaces the working document, so everything
    // the documents carry today stops counting from that point on, and so does
    // any pass that ran before it. This is what stands in for the old blanket
    // "a cast must be followed by a detect" refusal now that casting alone is a
    // legal run (Owen's ruling, docs/PIPELINE_V2_PLAN.md): a bare cast is fine,
    // and a Build the book behind one still names the Detect it needs, because
    // the annotations it would have read are the ones the cast threw away.
    //
    // The LAST cast above this pass, not the first — a run may cast twice, and
    // it is the most recent one that decides what the document carries.
    let castAt = -1;
    for (let j = 0; j < i; j += 1) if (passes[j].kind === 'get-text') castAt = j;
    // `>=` and not `>`: when the prerequisite IS the cast, the cast satisfies it.
    const writtenInChain = passes.some(
      (p, j) => p.kind === needs.pass && j < i && j >= castAt);
    const writtenOnDisk = castAt < 0 && onDisk[needs.done];
    if (!writtenInChain && !writtenOnDisk) {
      throw new Error(
        `${LABEL_OF[pass.kind]} reads what ${LABEL_OF[needs.pass]} writes, and this book's working `
        + `document does not carry it. Add ${LABEL_OF[needs.pass]} to the run, above it.`
      );
    }
  }

  // Reflow is the one exporter, so a chain produces a book exactly when it
  // contains one. No `exportAfter` flag, and no last-foundry-pass carrying an
  // export it does not otherwise know about: the pass that writes the book IS
  // the pass that writes the book.
  const producesEpub = passes.some((p) => p.kind === 'reflow');
  if (lastDocumentAt >= 0 && firstEpubAt >= 0 && !producesEpub) {
    throw new Error(
      `Nothing in this run writes the book, so ${LABEL_OF[passes[firstEpubAt].kind]} has nothing to `
      + `read. Add the ${LABEL_OF['reflow']} pass after the passes that read the PDF.`
    );
  }

  // Where the book will be. A Reflow writes the canonical name (the book may have
  // been retitled since the last export); everything else rewrites the recorded
  // file in place.
  const target = await manifestService.exportEpubTarget(projectDir);
  const bookEpubPath = producesEpub ? target.absPath : (record?.absPath ?? target.absPath);

  // Stage numbering. An export starts the book's provenance over — the rebuilt
  // book has had nothing else done to it — so a chain that exports numbers from
  // 1, and one that does not carries on from what the book already records.
  const base = producesEpub ? 0 : (record ? (manifest.outputs?.epub?.appliedPasses?.length ?? 0) : 0);

  const jobs: PlannedPassJob[] = passes.map((pass, i) => {
    const stage = manifestService.passStageRelDir(base + i + 1, pass.kind);
    const isDocument = isDocumentPass(pass.kind, i);

    const config: PassJobConfig = {
      kind: pass.kind,
      projectDir,
      stageRelDir: stage,
      ...(isDocument ? { sourcePath } : {}),
      ...(request.variantId ? { variantId: request.variantId } : {}),
      // Said outright, never inferred: the two footnote passes share a name, a
      // job type and a queue row, and only the plan knows which one this is.
      ...(pass.kind === 'footnotes'
        ? {
          footnotesMode: footnotesModeAt(i),
          ...(pass.footnotes ? { footnotes: pass.footnotes } : {}),
        }
        : {}),
      ...(pass.reflow ? { reflow: pass.reflow } : {}),
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
