/**
 * processing-chain — a run is an ordered list of passes over ONE project's book.
 *
 * The wizard builds a sidebar of passes and hands it here. Everything that can
 * be decided up front is decided HERE, before a single job is queued: which book
 * the passes read, where each pass's stage directory goes, and whether the run
 * can work at all. A chain that cannot work is refused with the reason — never
 * accepted and discovered at step four, three hours in, by a stage that cannot
 * find its input.
 *
 * ── THERE IS ONE INPUT, AND IT IS THE BOOK ───────────────────────────────────
 *
 * Both surviving passes are EPUB passes: they read `manifest.outputs.epub`,
 * transform it and rename the result back onto the same path. So a run has no
 * ordering rules of its own — any order of Simplify and Translate is a run the
 * user meant — and the ONE thing that can be wrong is that the project has no
 * book yet. That refusal names the thing that makes one: Convert to EPUB, in the
 * picker's Archive station.
 *
 * The Tesseract-era document passes (Get Text, Detect blocks, Build the book)
 * and the AI footnote pass were removed in Aug 2026 when `foundry vlm-convert`
 * became the only PDF→EPUB conversion. Everything they needed a planner for —
 * prerequisites read off the working document, an ordering that could silently
 * discard an earlier pass's work, two readings of "footnotes" — went with them.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import type { AppliedPassKind, ProjectManifest } from './manifest-types';
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
  simplify: 'simplify',
  translate: 'translate-pass',
  // Chainable like the others — "take the reference numbers out, then simplify"
  // is an ordinary thing to want, and the pass costs seconds. Its usual door is
  // the synchronous one (`book:remove-footnote-references`), which is a
  // convenience rather than a second mechanism: both build a PassJobConfig and
  // both end in `runProcessingPass`.
  'footnote-refs': 'footnote-refs',
};

const LABEL_OF: Record<AppliedPassKind, string> = {
  simplify: 'Simplify',
  translate: 'Translate',
  'footnote-refs': 'Remove footnote references',
  // The route to a book, and NOT a pass: it is a document stage
  // (electron/vlm-convert.ts) and a chain request naming it is refused by
  // `JOB_TYPE_OF` having no entry for it. Named here because provenance is a
  // book's own history and a converted book records one.
  'vlm-convert': 'Convert to EPUB',
  // Retired — named only so a refusal about an old book's history reads.
  'get-text': 'Get Text',
  blocks: 'Detect blocks',
  reflow: 'Build the book',
  footnotes: 'Footnote removal',
  tesseract: 'Tesseract',
  'ocr-correction': 'OCR correction',
  detection: 'Detection',
};

/**
 * The pass kinds a chain request may name, as a runtime set.
 *
 * `ProcessingPassKind` is erased at run time and a request arrives over IPC, so
 * membership is checked against this rather than trusted. Anything else — a
 * retired kind from an older wizard, a typo, `vlm-convert` — is refused by name.
 */
const LIVE_KINDS = new Set<string>(Object.keys(JOB_TYPE_OF));

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
 * The book the passes read.
 *
 * A caller may name a specific file (the wizard's variant cards do), and a run
 * pointed at anything but an EPUB is refused here rather than by a pass that
 * opens it as a zip three hours later.
 */
async function resolveSource(
  request: ProcessingChainRequest,
  projectDir: string,
  manifest: ProjectManifest
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

  const record = await manifestService.readExportEpub(projectDir);
  if (!record) {
    throw new Error(
      'This project has no book EPUB yet, so there is nothing for these passes to read. '
      + `Run ${LABEL_OF['vlm-convert']} over its PDF first — it is what turns the pages into a book.`
    );
  }
  if (!fs.existsSync(record.absPath)) {
    throw new Error(`The project's book is recorded as ${record.relPath}, but that file is not there.`);
  }
  return record.absPath;
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

  // Said before anything else is resolved, because a caller sending a kind this
  // build no longer runs would otherwise get a confusing error about the book.
  const unknown = passes.find((p) => !LIVE_KINDS.has(p.kind as string));
  if (unknown) {
    const named = LABEL_OF[unknown.kind as AppliedPassKind];
    throw new Error(
      named
        ? `${named} is not a pass any more. A run is Simplify and Translate over the project's `
          + `book; making the book is ${LABEL_OF['vlm-convert']}, in the picker's Archive station.`
        : `There is no "${unknown.kind}" pass.`
    );
  }

  const sourcePath = await resolveSource(request, projectDir, manifest);
  if (path.extname(sourcePath).toLowerCase() !== '.epub') {
    throw new Error(
      `A processing run reads the project's book, and this one was pointed at `
      + `${path.basename(sourcePath)}. Pick the EPUB version of this book, or run `
      + `${LABEL_OF['vlm-convert']} over the PDF first.`
    );
  }

  const record = await manifestService.readExportEpub(projectDir);
  const bookEpubPath = record?.absPath ?? sourcePath;

  // Stage numbering carries on from what the book already records: a pass writes
  // the book in place, so the run adds to that book's history rather than
  // starting one.
  const base = record ? (manifest.outputs?.epub?.appliedPasses?.length ?? 0) : 0;

  const jobs: PlannedPassJob[] = passes.map((pass: ChainPassRequest, i: number) => {
    if (pass.kind === 'simplify' && !pass.simplify) {
      throw new Error('The Simplify pass needs a mode and a model; none were given.');
    }
    if (pass.kind === 'translate' && !pass.translate) {
      throw new Error('The Translate pass needs source and target languages and a model; none were given.');
    }

    const config: PassJobConfig = {
      kind: pass.kind,
      projectDir,
      stageRelDir: manifestService.passStageRelDir(base + i + 1, pass.kind),
      ...(pass.simplify ? { simplify: pass.simplify } : {}),
      ...(pass.translate ? { translate: pass.translate } : {}),
    };

    return { jobType: JOB_TYPE_OF[pass.kind], label: LABEL_OF[pass.kind], config };
  });

  return {
    projectId: manifest.projectId || path.basename(projectDir),
    projectDir,
    title: manifest.metadata?.title || path.basename(projectDir),
    sourcePath,
    bookEpubPath,
    jobs,
  };
}
