/**
 * Persist OCR blocks into a project's manifest — the CLI's half of the picker's save.
 *
 * The picker stores an OCR pass as `manifest.editor.ocrBlocks` +
 * `manifest.editor.ocrCategories` (see `project:save-to-path` in main.ts), and
 * `projects:load-from-path` hands them straight back, so reopening the book shows
 * the OCR'd blocks instead of re-OCRing. This module lets a headless OCR run land
 * in the same two fields, so a book can be OCR'd on the machine with the GPU and
 * hand-labelled on another — the library is Syncthing-shared, so the manifest is
 * the transport.
 *
 * Two guards, both of which exist because getting them wrong is silent:
 *
 *   1. The PDF must BE the project's source document, proved by SHA-256 of the
 *      bytes. Block geometry is meaningless against any other file, and blocks
 *      filed under the wrong book look perfectly valid until someone labels 5,000
 *      of them.
 *   2. Existing `ocrBlocks` are never overwritten without `overwrite`. Labels
 *      (`editor.categoryCorrections`) are keyed to block IDs, and OCR mints fresh
 *      IDs every run — so replacing the blocks silently orphans every label made
 *      against them. That can be hours of work.
 *
 * Deliberately NOT an IPC handler: nothing in the app needs this yet, and adding a
 * channel for a CLI-only capability is surface with no caller.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { ProjectManifest } from './manifest-types';
import {
  getManifest,
  getManifestPath,
  getVariants,
  modifyManifest,
  setLibraryBasePath,
} from './manifest-service';
import type { TextBlock, Category } from '../shared/ocr/text-block';

/** A validated project + source-document pairing, and what is already stored. */
export interface OcrProjectTarget {
  /** Absolute project directory, as resolved. */
  projectDir: string;
  /** The folder name under `<library>/projects/`, which IS the manifest's project id. */
  projectId: string;
  /** `<library>` — two levels above the project directory. */
  libraryRoot: string;
  manifestPath: string;
  /** The PDF that was OCR'd, absolute — re-verified against the project under the lock. */
  pdfPath: string;
  /** The project's own source document, whose bytes matched the PDF being OCR'd. */
  sourceDocPath: string;
  sourceSha256: string;
  /** How many OCR blocks the manifest already holds (0 when it holds none). */
  existingBlockCount: number;
  /** How many hand labels are keyed to those blocks (0 when there are none). */
  existingCorrectionCount: number;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

/** One file the project itself claims as a source document. */
interface SourceCandidate {
  /** Absolute path. */
  filePath: string;
  /** Where the claim comes from, for the refusal message. */
  origin: string;
  sizeBytes: number;
}

/**
 * Every file this project records as a source document of the book.
 *
 * All of them, not one: the app resolves a SINGLE file to open (see
 * `projects:load-from-path` — legacy `source/{finalized,original}.*`, then
 * the primary/first ebook variant), but that resolution is about which rendition to
 * edit, and a project routinely holds several. The 17-page Kershaw scan, for
 * instance, has both `archive/…pdf` (the scan the OCR blocks describe) and
 * `source/Working Towards The Fuhrer.epub` — the export, produced FROM those
 * blocks and named after the book. Picking one and rejecting
 * everything else would refuse the archive original — the very file that must be
 * OCR'd — because a later derivative happened to sort first.
 *
 * So the guard is "the bytes are a document this project owns", proved by hash
 * against this list. That still refuses another book's PDF, which is the failure
 * mode that matters.
 */
function collectSourceCandidates(projectDir: string, manifest: ProjectManifest): SourceCandidate[] {
  const found: SourceCandidate[] = [];
  const seen = new Set<string>();
  const add = (filePath: string, origin: string): void => {
    const key = filePath.toLowerCase();
    if (seen.has(key)) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;  // recorded but not present — nothing to compare against
    }
    if (!stat.isFile()) return;
    seen.add(key);
    found.push({ filePath, origin, sizeBytes: stat.size });
  };

  // archive/ — the pristine imports. `role: 'original'` is the scan itself.
  for (const entry of manifest.archive ?? []) {
    if (entry.role === 'audiobook' || entry.format === 'm4b') continue;
    add(path.join(projectDir, entry.path), `archive (${entry.role})`);
  }

  // Book variants — editions/languages/formats of the same book.
  const { variants } = getVariants(manifest);
  for (const v of variants) {
    if (v.kind !== 'ebook') continue;
    add(path.join(projectDir, v.path), `variant ${v.id}`);
  }

  // The project's own export, BY ITS RECORD. Never by scanning source/ for a
  // name: the export is named after the book now, and the one thing such a scan
  // can still match is a pre-rename `exported.epub` — a stray file the app does
  // not adopt anywhere else and must not adopt here either.
  const exportRel = manifest.outputs?.epub?.path;
  if (exportRel) {
    add(path.join(projectDir, ...exportRel.split('/')), 'manifest outputs.epub');
  }

  // Legacy source/ layout, which is what the app's own open path still prefers.
  const sourceDir = path.join(projectDir, 'source');
  if (fs.existsSync(sourceDir)) {
    for (const name of fs.readdirSync(sourceDir)) {
      if (!/^(finalized|original)\./.test(name)) continue;
      add(path.join(sourceDir, name), `source/${name}`);
    }
  }

  return found;
}

/**
 * Locate the project, prove the PDF is its source document, and report what OCR
 * state it already holds. Throws — with the reason named — on anything else.
 *
 * Call this BEFORE running OCR: every failure it can report is knowable up front,
 * and finding out after an hour of Tesseract that the path was wrong is not a
 * failure mode worth having. `persistOcrToProject` re-checks all of it under the
 * manifest lock, so passing here is not treated as permission later.
 */
export async function resolveOcrProjectTarget(
  projectDirArg: string,
  pdfPath: string,
): Promise<OcrProjectTarget> {
  const projectDir = path.resolve(projectDirArg);
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    throw new Error(`--project is not a directory: ${projectDir}`);
  }
  const manifestPath = path.join(projectDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `not a BookForge project (no manifest.json): ${projectDir}\n` +
      '  --project wants the project FOLDER, e.g. <library>/projects/<slug>.');
  }

  // The manifest service addresses projects as `<library>/projects/<id>`, so the
  // library root is two levels up and the folder name is the id. Checked rather
  // than assumed: pointed at a stray folder, modifyManifest would otherwise look
  // for a manifest somewhere entirely different and report "Project not found".
  const projectsDir = path.dirname(projectDir);
  if (path.basename(projectsDir).toLowerCase() !== 'projects') {
    throw new Error(
      `${projectDir} is not inside a library: expected <library>/projects/<slug>,\n` +
      `  but its parent folder is named "${path.basename(projectsDir)}".`);
  }
  const libraryRoot = path.dirname(projectsDir);
  const projectId = path.basename(projectDir);
  setLibraryBasePath(libraryRoot);

  const resolved = path.resolve(getManifestPath(projectId));
  if (resolved.toLowerCase() !== path.resolve(manifestPath).toLowerCase()) {
    throw new Error(
      'library layout mismatch — the manifest service would write to a different file:\n' +
      `  asked for: ${manifestPath}\n  resolves to: ${resolved}`);
  }

  const read = await getManifest(projectId);
  if (!read.success || !read.manifest) {
    throw new Error(`cannot read ${manifestPath}: ${read.error}`);
  }

  const target = verifyOcrTarget(projectDir, pdfPath, read.manifest);
  return {
    projectDir,
    projectId,
    libraryRoot,
    manifestPath,
    pdfPath: path.resolve(pdfPath),
    ...target,
  };
}

/**
 * The checks that must hold at the moment of writing, run against a manifest the
 * caller has in hand. Shared by the pre-flight and the locked write so there is one
 * definition of "may these blocks go in here".
 */
function verifyOcrTarget(
  projectDir: string,
  pdfPath: string,
  manifest: ProjectManifest,
): Pick<OcrProjectTarget, 'sourceDocPath' | 'sourceSha256' | 'existingBlockCount' | 'existingCorrectionCount'> {
  const pdfAbs = path.resolve(pdfPath);
  if (!fs.existsSync(pdfAbs)) throw new Error(`no such file: ${pdfAbs}`);

  const candidates = collectSourceCandidates(projectDir, manifest);
  if (candidates.length === 0) {
    throw new Error(
      `project ${path.basename(projectDir)} records no source document that exists on disk:\n` +
      '  nothing in archive[], no ebook variant file, no recorded outputs.epub,\n' +
      '  no source/{finalized,original}.*\n' +
      `  manifest.source.originalFilename = ${JSON.stringify(manifest.source?.originalFilename)}\n` +
      '  There is nothing to check the OCR\'d PDF against, so the write cannot be verified.');
  }

  const pdfSize = fs.statSync(pdfAbs).size;
  const pdfSha256 = sha256File(pdfAbs);
  // Size first: a hash is only needed for candidates that could possibly match, and
  // a project can hold a 60 MB scan next to a 200 MB one.
  let match: SourceCandidate | undefined;
  const hashes = new Map<string, string>();
  for (const c of candidates) {
    if (c.sizeBytes !== pdfSize) continue;
    const hash = sha256File(c.filePath);
    hashes.set(c.filePath, hash);
    if (hash === pdfSha256) { match = c; break; }
  }

  if (!match) {
    const listed = candidates.map(c =>
      `    ${c.origin}: ${path.relative(projectDir, c.filePath)}\n` +
      `      ${c.sizeBytes} bytes, sha256 ${hashes.get(c.filePath) ?? '(not hashed — size differs)'}`
    ).join('\n');
    throw new Error(
      'the PDF being OCR\'d is NOT a source document of this project — refusing to write.\n' +
      `  OCR'd: ${pdfAbs}\n` +
      `      ${pdfSize} bytes, sha256 ${pdfSha256}\n` +
      `  manifest.source.originalFilename = ${JSON.stringify(manifest.source?.originalFilename)}\n` +
      `  the project's own source documents are:\n${listed}\n` +
      '  OCR block geometry and IDs only mean anything against the exact file the\n' +
      '  picker opens. Point --project at the book this PDF belongs to, or OCR the\n' +
      '  project\'s own copy of it.');
  }
  const sourceDocPath = match.filePath;
  const sourceSha256 = pdfSha256;

  const editor = manifest.editor as Record<string, unknown> | undefined;
  const existing = editor?.['ocrBlocks'];
  const existingBlockCount = Array.isArray(existing) ? existing.length : 0;
  const corrections = editor?.['categoryCorrections'];
  const existingCorrectionCount = Array.isArray(corrections) ? corrections.length : 0;

  return { sourceDocPath, sourceSha256, existingBlockCount, existingCorrectionCount };
}

/** What `existingBlockCount` blocks and `existingCorrectionCount` labels cost to replace. */
function overwriteRefusal(t: Pick<OcrProjectTarget, 'existingBlockCount' | 'existingCorrectionCount'>,
                          manifestPath: string): Error {
  const labels = t.existingCorrectionCount > 0
    ? `manifest.editor.categoryCorrections holds ${t.existingCorrectionCount} hand label(s), ` +
      'every one of them keyed to a block ID this run would replace — they would be orphaned'
    : 'manifest.editor.categoryCorrections is absent or empty, so no hand labels are keyed to them';
  return new Error(
    `${manifestPath} already holds ${t.existingBlockCount} OCR block(s) — refusing to overwrite.\n` +
    `  ${labels}.\n` +
    '  Pass --overwrite-ocr if you really mean to discard the stored blocks.');
}

/**
 * Write `ocrBlocks` + `ocrCategories` into the project's manifest.
 *
 * Uses `modifyManifest`, the app's own locked read-modify-write, and sets ONLY
 * those two fields — every other piece of editor state (undo stack, block edits,
 * crop regions, chapters, hand labels) is left exactly as found. Re-runs the full
 * verification INSIDE the lock: OCR takes minutes to hours, and the point of the
 * overwrite guard is to notice labelling that happened while it ran.
 */
export async function persistOcrToProject(
  target: OcrProjectTarget,
  blocks: TextBlock[],
  categories: Record<string, Category>,
  options: { overwrite: boolean },
): Promise<{ manifestPath: string; replacedBlockCount: number }> {
  if (blocks.length === 0) {
    throw new Error(
      'refusing to write 0 OCR blocks into a manifest — that is not a result, it is a\n' +
      '  failed run, and storing it would make the app skip OCR on every later open.');
  }

  setLibraryBasePath(target.libraryRoot);
  let replacedBlockCount = 0;

  const result = await modifyManifest(target.projectId, (manifest) => {
    // The PDF, not the already-matched source copy: this must re-prove the same
    // thing the pre-flight proved, against the manifest as it is NOW.
    const fresh = verifyOcrTarget(target.projectDir, target.pdfPath, manifest);
    if (fresh.existingBlockCount > 0 && !options.overwrite) {
      throw overwriteRefusal(fresh, target.manifestPath);
    }
    replacedBlockCount = fresh.existingBlockCount;

    if (!manifest.editor) manifest.editor = {};
    manifest.editor.ocrBlocks = blocks;
    manifest.editor.ocrCategories = categories;
  });

  if (!result.success) {
    throw new Error(`failed to write ${target.manifestPath}: ${result.error}`);
  }
  return { manifestPath: result.manifestPath ?? target.manifestPath, replacedBlockCount };
}

/**
 * The pre-flight refusal, as a separate call so the CLI can fail before OCR rather
 * than after it. `persistOcrToProject` enforces the same rule under the lock.
 */
export function assertOcrOverwriteAllowed(target: OcrProjectTarget, overwrite: boolean): void {
  if (target.existingBlockCount > 0 && !overwrite) {
    throw overwriteRefusal(target, target.manifestPath);
  }
}
