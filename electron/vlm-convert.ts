/**
 * vlm-convert — the second route from a PDF to this project's book, driven from
 * BookForge.
 *
 * `foundry vlm-convert` hands each page picture to a document VLM (dots.ocr) and
 * assembles what comes back into an EPUB. Owen's design, 2026-08-07: one button
 * on a PDF-sourced project, and the EPUB it writes is the OFFICIAL, COMPLETE
 * book — everything kept — recorded as `manifest.outputs.epub`. What a listener
 * does not want to hear is struck out afterwards, in the picker, and exported as
 * a SECOND file (shared/vlm/narration-deletions.ts). This module is the first
 * half of that.
 *
 * ── Why it is a document STAGE and not a pass ───────────────────────────────
 *
 * A processing pass reads `outputs.epub`, transforms it, and renames the result
 * back onto the same path (docs/PROCESSING_PIPELINE_V2.md). A conversion is
 * where the book COMES FROM: there is nothing to read, nothing to diff against,
 * and no legal position for it in a chain except first. So it goes through
 * `withProjectStage`, exactly like the cast and the detect, and gets the three
 * things that come with it for free and correctly:
 *
 *  - a project can have ONE at a time, refused by name by the stage registry
 *    (a second conversion writing the same book is two writers on one file);
 *  - it is owned by MAIN, so an ng-serve reload cannot kill ninety minutes of
 *    GPU, and quit aborts it;
 *  - every window hears `document:stage-started` / `-progress` / `-finished`,
 *    which is what the picker already listens to.
 *
 * The chain planner never sees `vlm-convert` and must not: `buildJobConfig`
 * throws on a pass kind it does not know, which is the refusal.
 *
 * ── Resumability, and where the answers are banked ──────────────────────────
 *
 * `--readings <file.jsonl>` banks every page's answer as it lands and a re-run
 * reads only what is missing (foundry README §vlm-convert). A 300-page book is
 * about ninety minutes on the M1 Ultra, so a run that is interrupted at page 280
 * and has to start over is the difference between a feature and a threat. The
 * file is MACHINE-LOCAL — same rule as the render cache and the foundry run
 * directories: it is hundreds of megabytes of model output that means nothing on
 * another machine, and the library folder is Syncthing-synced.
 *
 * It is keyed by the PDF's sha256, so a re-imported or edited PDF gets a
 * different file without anything having to notice, and the answers can never be
 * about a different book than the pages being read.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ensureFoundryPath, runFoundry } from './foundry-bridge';
import { resolveDocumentProject } from './document-project';
import { primaryAbsPath } from './document-stages';
import { withProjectStage } from './document-stage-run';
import { moveIntoPlace } from './processing-passes';
import { sha256File } from './sidecar-binding';
import * as manifestService from './manifest-service';
import {
  VLM_CONVERT_STAGE,
  parseVlmProgressLine,
  type VlmConvertRequest,
  type VlmConvertResult,
} from '../shared/vlm/conversion';

const STAGING_DIR = path.join(os.tmpdir(), 'bookforge-staging');

/**
 * Where this PDF's banked page answers live — machine-local, derived, never
 * recorded. A sibling of the foundry run directories for the same reason they
 * are there (electron/document-stages.ts `documentScratchDir`).
 */
export function vlmReadingsPath(pdfSha256: string): string {
  return path.join(
    os.homedir(), 'Documents', 'BookForge', 'foundry-runs',
    `vlm-${pdfSha256.slice(0, 16)}`, 'readings.jsonl'
  );
}

/**
 * `dc:language` for the book — DECLARED, never detected.
 *
 * foundry says so itself and it is right: nothing in the conversion reads a
 * language, and a guess would land in the EPUB's metadata wearing the authority
 * of a measurement. The project's own metadata is a thing a person set, so it is
 * the answer where there is one; `en` is foundry's own default, kept rather than
 * invented.
 */
function languageOf(manifest: { metadata?: { language?: string } }): string {
  const declared = (manifest.metadata?.language ?? '').trim();
  return declared.length > 0 ? declared : 'en';
}

/**
 * Read one page count out of foundry's own summary lines, or null.
 *
 * `vlm-convert: 317 pages in 5120.4s (…)` is the last line of a successful run
 * and is the only place the whole page count is stated as a number rather than
 * as the right-hand side of a progress fraction.
 */
function totalPagesFrom(stderr: string): number | null {
  const match = /vlm-convert:\s+(\d+)\s+pages\s+in\s/.exec(stderr);
  return match ? Number(match[1]) : null;
}

/** The pages that are NOT in the book, with foundry's own reason for each. */
function unreadablePagesFrom(stderr: string): Array<{ page: number; reason: string }> {
  const out: Array<{ page: number; reason: string }> = [];
  const pattern = /vlm-convert:\s+page\s+(\d+)\s+SKIPPED\s+—\s+(.+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(stderr)) !== null) {
    out.push({ page: Number(match[1]), reason: match[2].trim() });
  }
  return out;
}

function inferredPagesFrom(stderr: string): number {
  const match = /vlm-convert:\s+(\d+)\s+read this run at\s/.exec(stderr);
  return match ? Number(match[1]) : 0;
}

/**
 * Convert a project's PDF into its book, and record it.
 *
 * The four acts, in this order, and the order is the design:
 *
 *  1. foundry writes the EPUB into `/tmp/bookforge-staging/`. Nothing lands in
 *     the synced library until the run has finished and exited zero — a
 *     half-written EPUB inside the library is a half-written EPUB propagating to
 *     every other machine.
 *  2. It is moved onto `exportEpubTarget`'s path, atomically at the destination.
 *     WHERE it goes and what it is CALLED are `manifest-service`'s answers, not
 *     this module's: the book's name is derived in one place
 *     (docs: "One place derives the name").
 *  3. `registerEpubExport` records it — which also ends the OLD book's
 *     provenance and drops the narration copy cut from it, because this is a
 *     rebuild and the passes applied to the previous bytes did not happen to
 *     these.
 *  4. `appendAppliedPass` writes the conversion into the fresh provenance, so
 *     the versions page can say where this book came from. It goes AFTER the
 *     export for the same reason the foundry passes' records do: an export
 *     starts provenance over, and a record written before it would be erased by
 *     it.
 */
export async function runVlmConversion(request: VlmConvertRequest): Promise<VlmConvertResult> {
  const project = await resolveDocumentProject({
    projectDir: request.projectDir,
    ...(request.variantId ? { variantId: request.variantId } : {}),
    ...(request.sourcePath ? { sourcePath: request.sourcePath } : {}),
  });
  const pdfPath = primaryAbsPath(project);
  if (!fs.existsSync(pdfPath)) {
    throw new Error(
      `${project.primaryRelPath} is recorded as this project's PDF, but it is not on disk. `
      + 'Nothing was converted.'
    );
  }

  // Awaited BEFORE the stage is claimed: `ensureFoundryPath` may download 38 MB,
  // and holding a project's stage lock through a transfer would refuse every
  // other stage for the duration of something that has not started yet.
  await ensureFoundryPath();

  const target = await manifestService.exportEpubTarget(project.projectDir);
  const manifest = await manifestService.getManifest(project.projectId);
  if (!manifest.success || !manifest.manifest) {
    throw new Error(
      `Could not read ${project.projectDir}'s manifest before converting: ${manifest.error}`
    );
  }
  const language = languageOf(manifest.manifest);

  const { sha256 } = await sha256File(pdfPath);
  const readingsPath = vlmReadingsPath(sha256);
  await fs.promises.mkdir(path.dirname(readingsPath), { recursive: true });
  await fs.promises.mkdir(STAGING_DIR, { recursive: true });
  const stagedEpub = path.join(STAGING_DIR, `vlm-convert-${sha256.slice(0, 16)}.epub`);

  const result = await withProjectStage(project.projectDir, VLM_CONVERT_STAGE, async (opts) => {
    let lastMessage = '';
    let done = 0;
    let total = 0;

    const run = await runFoundry(
      [
        'vlm-convert',
        '--pdf', pdfPath,
        '--out', stagedEpub,
        '--readings', readingsPath,
        '--language', language,
      ],
      {
        signal: opts.signal,
        onProgress: (line) => {
          lastMessage = line;
          const parsed = parseVlmProgressLine(line);
          if (parsed) {
            done = parsed.done;
            total = parsed.total;
          }
          opts.onProgress({ stage: 'vlm-convert', message: line, done, total });
        },
      }
    );

    if (run.code !== 0) {
      // foundry's own stderr is the message a user needs — it names the missing
      // Python, the model it could not load, the page it choked on. Never
      // paraphrased, and never replaced with an exit code.
      throw new Error(
        `foundry vlm-convert failed (exit ${run.code}).\n${run.stderr.trim() || lastMessage}`
      );
    }
    if (!fs.existsSync(stagedEpub)) {
      throw new Error(
        `foundry vlm-convert reported success but wrote no EPUB at ${stagedEpub}. `
        + 'Nothing was recorded.'
      );
    }
    return run;
  });

  await moveIntoPlace(stagedEpub, target.absPath);
  await manifestService.registerEpubExport(project.projectDir, target.absPath);

  const unreadable = unreadablePagesFrom(result.stderr);
  const totalPages = totalPagesFrom(result.stderr) ?? 0;
  const inferredPages = inferredPagesFrom(result.stderr);

  await manifestService.appendAppliedPass(project.projectDir, {
    kind: 'vlm-convert',
    at: new Date().toISOString(),
    params: {
      source: project.primaryRelPath,
      sourceSha256: sha256,
      language,
      totalPages,
      inferredPages,
      // Named in the record, not just in a log line: a page the model could not
      // read is a page of the user's book that is not in it, and the versions
      // page is where they would look for that months later.
      unreadablePages: unreadable.map((p) => p.page),
    },
  });

  return {
    epubPath: target.absPath,
    relPath: target.relPath,
    inferredPages,
    totalPages,
    unreadable,
  };
}
