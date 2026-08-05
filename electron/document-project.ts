/**
 * document-project — which document of a project the pipeline is about.
 *
 * `DocumentProject` (document-stages.ts) is three facts: the project's folder
 * slug, its directory, and the archive original everything else is bound to.
 * The first two are the manifest's. The third is a CHOICE — a project can hold
 * several versions of a book — and this module is where it is made, once, for
 * the queue and the picker both, so the two cannot pick differently and write a
 * working document each.
 *
 * ── Why the original is not searched for ────────────────────────────────────
 *
 * A project's PDF is a `variant`: a manifest record with a project-relative
 * path. The alternative — scanning `archive/` for something ending in `.pdf` —
 * is how a project with a stray second edition in it silently gets read as the
 * wrong book, and there would be no evidence of which one was used. So the
 * variants ARE the list of candidates, an explicit `variantId` beats them, and a
 * project with more than one PDF and no choice made is a question rather than a
 * guess.
 *
 * The one thing this module never does is invent a path. Every failure names
 * what is missing and what the user can do about it, because the caller's next
 * move — casting a working document, running a model over somebody's book — is
 * expensive and irreversible enough that a wrong document is worse than no
 * document.
 */

import * as fs from 'fs';
import * as path from 'path';

import * as manifestService from './manifest-service';
import type { ProjectManifest } from './manifest-types';
import {
  documentBindingPath,
  readDocumentBinding,
  toProjectRelative,
  type DocumentBinding,
} from './document-binding';
import type { DocumentProject } from './document-stages';

export interface DocumentProjectRequest {
  /** Absolute project directory. */
  projectDir: string;
  /** The version the caller already chose, when it has one. */
  variantId?: string;
  /** An absolute path the caller already resolved. Must be inside the project. */
  sourcePath?: string;
}

async function readManifest(projectDir: string): Promise<ProjectManifest> {
  const file = path.join(projectDir, 'manifest.json');
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf-8');
  } catch (err) {
    throw new Error(
      `${projectDir} is not a BookForge project — ${file} could not be read (${(err as Error).message}). `
      + 'The document pipeline works on a project, because the working document and the book are '
      + "written beside the project's own original."
    );
  }
  return JSON.parse(raw) as ProjectManifest;
}

/** Every PDF this project holds, as project-relative paths that are on disk. */
function pdfVariants(projectDir: string, manifest: ProjectManifest): Array<{
  id: string;
  relPath: string;
  label: string;
}> {
  const { variants } = manifestService.getVariants(manifest);
  return variants
    .filter((v) => v.format.toLowerCase() === 'pdf')
    .map((v) => ({
      id: v.id,
      relPath: v.path,
      label: v.descriptor || v.metadata?.title || path.basename(v.path),
    }))
    .filter((v) => fs.existsSync(path.join(projectDir, v.relPath.split('/').join(path.sep))));
}

/**
 * The book's original, and the project it belongs to.
 *
 * Never written to by anything downstream — `verifyPrimary` re-proves that at
 * every stage by hashing it — so "which file is this" is settled here and then
 * carried, rather than re-derived by each caller from whatever it happens to
 * have in hand.
 */
export async function resolveDocumentProject(
  request: DocumentProjectRequest
): Promise<DocumentProject> {
  const projectDir = path.resolve(request.projectDir);
  const manifest = await readManifest(projectDir);
  const projectId = manifest.projectId;
  if (!projectId) {
    throw new Error(
      `${path.join(projectDir, 'manifest.json')} has no projectId. Every v2 manifest carries one; `
      + 'a project without it is damaged, and inventing an id here would bind documents to a name '
      + 'nothing else uses.'
    );
  }

  if (request.sourcePath) {
    const abs = path.resolve(request.sourcePath);
    if (!fs.existsSync(abs)) {
      throw new Error(`The document this run was pointed at is not there: ${abs}`);
    }
    if (path.extname(abs).toLowerCase() !== '.pdf') {
      throw new Error(
        `${path.basename(abs)} is not a PDF. The document pipeline casts a working PDF from the `
        + "book's original; a book that arrived as an EPUB is already a book, and the footnote pass "
        + 'is what runs on one.'
      );
    }
    // `toProjectRelative` refuses a path outside the project by name. That is the
    // check that matters: the binding record names its documents project-
    // relatively, so an original somewhere else could not be recorded at all —
    // and a working document cast from a file the project does not own would be
    // bound to bytes nothing in the project can vouch for.
    return { projectId, projectDir, primaryRelPath: toProjectRelative(projectDir, abs) };
  }

  const candidates = pdfVariants(projectDir, manifest);

  if (request.variantId) {
    const chosen = candidates.find((c) => c.id === request.variantId);
    if (!chosen) {
      const { variants } = manifestService.getVariants(manifest);
      const named = variants.find((v) => v.id === request.variantId);
      throw new Error(
        named
          ? `The "${named.descriptor || named.format}" version of this book is a ${named.format}, and `
            + 'the document pipeline reads a PDF. Pick the PDF version, or run the passes that work '
            + 'on a book EPUB.'
          : `This project has no version ${request.variantId}; pick one of the versions it lists.`
      );
    }
    return { projectId, projectDir, primaryRelPath: chosen.relPath };
  }

  if (candidates.length === 0) {
    throw new Error(
      'This project has no PDF, so there is no original for the document pipeline to read — it was '
      + 'imported as a book. The footnote, simplify and translate passes work on the book EPUB; '
      + 'Get Text, Blocks and Reflow read a PDF.'
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `This project holds ${candidates.length} PDFs and nothing said which one to read:\n`
      + candidates.map((c) => `  • ${c.label} (${c.relPath})`).join('\n')
      + '\nPick the version to work on. Choosing one here would bind a working document to whichever '
      + 'happened to be listed first, and every stage after it would be about a book nobody chose.'
    );
  }
  return { projectId, projectDir, primaryRelPath: candidates[0].relPath };
}

/** One of a project's PDFs that HAS a working copy, and everything about it. */
export interface WorkingDocumentEntry {
  /** The archive original, project-relative and slash-separated. */
  primaryRelPath: string;
  primaryAbsPath: string;
  /** The original is on disk. False is a real state — a project can be half-synced. */
  primaryExists: boolean;
  workingRelPath: string;
  workingAbsPath: string;
  /** The working document's own mtime — when it was last curated. */
  workingModifiedAt: string;
  workingBytes: number;
  binding: DocumentBinding;
}

/**
 * Every PDF of this project that has a working copy ON DISK, with its binding.
 *
 * The versions page's reason for existing, as of the ruling in
 * docs/PIPELINE_V2_PLAN.md: the working copy gets a row. It was previously
 * unreachable not because anything filtered it but because nothing ever listed
 * it — `editor:get-versions` is an allowlist of known filenames and the project
 * root was never in it.
 *
 * Deliberately NOT `resolveDocumentProject`. That one CHOOSES the single
 * document a stage will write, and refuses a project holding two PDFs rather
 * than guessing — the right answer when the next move spends hours of GPU on
 * somebody's book. A listing has no such stake: it says what is there, and a
 * project with two working copies has two of them. So this enumerates instead
 * of choosing, and never throws for a project with none.
 *
 * A binding that is PRESENT AND UNREADABLE still throws, from
 * `readDocumentBinding`. That is not a listing failing to find something: it is
 * a record that binds a working document to an original, sitting right there,
 * refusing to parse — and answering "this book has no working copy" would send
 * the user off to re-cast a document that already exists.
 */
export async function listWorkingDocuments(
  projectDir: string
): Promise<WorkingDocumentEntry[]> {
  const manifest = await readManifest(projectDir);
  const entries: WorkingDocumentEntry[] = [];

  for (const candidate of pdfVariants(projectDir, manifest)) {
    const binding = readDocumentBinding(documentBindingPath(projectDir, candidate.relPath));
    // No binding means Get Text has never cast a working document for this PDF.
    // An ordinary state, and the whole of what "no working copy row" means.
    if (!binding) continue;

    const workingAbsPath = path.join(
      projectDir, binding.working.path.split('/').join(path.sep));
    let stat: fs.Stats;
    try {
      stat = fs.statSync(workingAbsPath);
    } catch {
      // The record says there is a working document and the file is not there.
      // No row: a row is a door onto a file, and there is no file to open.
      continue;
    }

    const primaryAbsPath = path.join(
      projectDir, binding.primary.path.split('/').join(path.sep));
    entries.push({
      primaryRelPath: binding.primary.path,
      primaryAbsPath,
      primaryExists: fs.existsSync(primaryAbsPath),
      workingRelPath: binding.working.path,
      workingAbsPath,
      workingModifiedAt: stat.mtime.toISOString(),
      workingBytes: stat.size,
      binding,
    });
  }

  return entries;
}

/**
 * Where Reflow writes the book: the manifest's own export target.
 *
 * Named after the original from birth (`exportEpubStem` takes the source file's
 * stem), which is the spec's rule — `book.epub` never exists on disk — and it is
 * the manifest that owns the name, so the export a user finds in the versions
 * page and the file Reflow writes are one file rather than two conventions.
 */
export async function reflowOutputPath(projectDir: string): Promise<string> {
  const target = await manifestService.exportEpubTarget(projectDir);
  return target.absPath;
}
