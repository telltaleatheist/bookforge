/**
 * Archive Migration — relocate professionally-read audiobooks output/ → archive/
 *
 * Directly-uploaded, professionally-read audiobooks used to be written into a
 * project's output/ folder. output/ is a DISPOSABLE stage — `pipeline:delete-output`
 * blind-wipes everything in it — so an irreplaceable human-narrated upload could be
 * destroyed. New uploads now land in the protected archive/ folder; this one-shot,
 * user-triggered migration moves EXISTING ones there too.
 *
 * What moves: the m4b plus its co-located sidecars (<base>.m4b.vtt, <base>.m4b.cover.*,
 * <base>.m4b.sidecars.json) and any manifest-referenced output/ transcript. What is
 * rewritten: outputs.audiobook.path/vttPath, variants[].path/vttPath, and any committed
 * audiobook-analysis report's `binding.m4bPath` (+ the manifest's reportSha256 so the
 * verifier still matches — the m4b bytes are unchanged by a pure move, so m4bSha256
 * stays valid).
 *
 * ORDERING (matches variant:delete / audiobook:delete-output / atomicMoveDirectory):
 *   1. copy m4b + sidecars into archive/
 *   2. confirm the manifest write that repoints at archive/
 *   3. only THEN unlink the output/ originals
 * A failed manifest write rolls back the archive copies (manifest still points at the
 * intact output/ file). A failed unlink leaves the output/ orphan and reports it — never
 * a dangling manifest. Idempotent: a book already pointing at archive/ is skipped, and a
 * partially-applied run is safely finished on the next pass. TTS renders
 * (professionallyRead:false) are NEVER migrated.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  listProjects,
  getManifest,
  getProjectPath,
  modifyManifest,
  atomicCopyFile,
  atomicWriteFile,
} from './manifest-service.js';
import type { ProjectManifest } from './manifest-types.js';

export interface ArchiveMigrationBookResult {
  projectId: string;
  title: string;
  status: 'migrated' | 'skipped' | 'failed';
  reason?: string;
  /** output/ files that could not be unlinked after a confirmed manifest move. */
  orphans?: string[];
}

export interface ArchiveMigrationResult {
  success: boolean;
  books: ArchiveMigrationBookResult[];
  migrated: number;
  skipped: number;
  failed: number;
}

export interface ArchiveMigrationProgress {
  current: number;
  total: number;
  projectId: string;
  title: string;
}

type ProgressCallback = (p: ArchiveMigrationProgress) => void;

const norm = (p?: string): string => (p || '').replace(/\\/g, '/');
const relToAbs = (projectDir: string, rel: string): string =>
  path.join(projectDir, rel.split('/').join(path.sep));

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/**
 * Every audiobook m4b in this project that is professionally-read AND still under
 * output/. Mirrors getVariants' professionally-read resolution so legacy imports
 * (flag absent but source.type === 'audiobook') are caught, while TTS renders
 * (professionallyRead:false, source.type epub/pdf/url) are never selected.
 */
function selectProfessionalOutputM4bs(manifest: ProjectManifest): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rel?: string) => {
    const r = norm(rel);
    if (!r.startsWith('output/') || seen.has(r)) return;
    seen.add(r); out.push(r);
  };

  const ab = manifest.outputs?.audiobook;
  if (ab?.path) {
    const abIsProfessional = ab.professionallyRead === true
      || (ab.professionallyRead === undefined && manifest.source?.type === 'audiobook');
    if (abIsProfessional) add(ab.path);
  }

  for (const v of manifest.variants || []) {
    if (v.kind !== 'audiobook') continue;
    if (v.id?.startsWith('bilingual:')) continue; // bilingual are derived, not uploads
    // Stored audiobook variants come from variant:add (human audio) and store
    // professionallyRead:true; require an explicit true so an ambiguous entry is
    // never mistaken for a professional upload.
    if (v.professionallyRead !== true) continue;
    add(v.path);
  }

  return out;
}

/** Manifest-referenced output/ transcript sidecars tied to a specific m4b rel. */
function associatedOutputVtts(manifest: ProjectManifest, oldRel: string): string[] {
  const vtts = new Set<string>();
  const ab = manifest.outputs?.audiobook;
  if (ab && norm(ab.path) === oldRel && norm(ab.vttPath).startsWith('output/')) {
    vtts.add(norm(ab.vttPath));
  }
  for (const v of manifest.variants || []) {
    if (norm(v.path) === oldRel && v.vttPath && norm(v.vttPath).startsWith('output/')) {
      vtts.add(norm(v.vttPath));
    }
  }
  return [...vtts];
}

/** Files that must travel with an m4b: the m4b itself plus any basename-prefixed
 *  sidecar (X.m4b, X.m4b.vtt, X.m4b.cover.*, X.m4b.sidecars.json). Absolute paths. */
async function siblingFiles(m4bAbs: string): Promise<string[]> {
  const dir = path.dirname(m4bAbs);
  const base = path.basename(m4bAbs);
  let entries: string[];
  try { entries = await fs.readdir(dir); } catch { return [m4bAbs]; }
  return entries
    .filter((e) => e === base || e.startsWith(base + '.'))
    .map((e) => path.join(dir, e));
}

/** Repoint every manifest pointer for this m4b from output/ to archive/. */
function rewriteManifestPointers(mf: ProjectManifest, oldRel: string, newRel: string, oldVtts: string[]): void {
  const vttNew = (v?: string): string | undefined => {
    const r = norm(v);
    return oldVtts.includes(r) ? r.replace(/^output\//, 'archive/') : v;
  };
  if (mf.outputs?.audiobook && norm(mf.outputs.audiobook.path) === oldRel) {
    mf.outputs.audiobook.path = newRel;
    if (mf.outputs.audiobook.vttPath) mf.outputs.audiobook.vttPath = vttNew(mf.outputs.audiobook.vttPath);
  }
  for (const v of mf.variants || []) {
    if (norm(v.path) === oldRel) {
      v.path = newRel;
      if (v.vttPath) v.vttPath = vttNew(v.vttPath);
    }
  }
}

/**
 * Rewrite any committed audiobook-analysis report whose binding points at the moved
 * m4b (output/ → archive/), and refresh its manifest reportSha256. Best-effort: a
 * failure here only makes the analysis stale (it is recomputable), never corrupt.
 */
async function rewriteAnalysesForMove(projectId: string, projectDir: string, oldRel: string, newRel: string): Promise<void> {
  const { manifest } = await getManifest(projectId);
  if (!manifest?.audiobookAnalyses) return;
  for (const [variantId, entry] of Object.entries(manifest.audiobookAnalyses)) {
    const reportAbs = relToAbs(projectDir, entry.reportPath);
    let json: string;
    try { json = await fs.readFile(reportAbs, 'utf8'); } catch { continue; }
    let report: any;
    try { report = JSON.parse(json); } catch { continue; }
    if (!report?.binding || norm(report.binding.m4bPath) !== oldRel) continue;
    report.binding.m4bPath = newRel;
    const newJson = JSON.stringify(report, null, 2);
    await atomicWriteFile(reportAbs, newJson);
    const newSha = crypto.createHash('sha256').update(newJson, 'utf8').digest('hex');
    await modifyManifest(projectId, (mf) => {
      const e = mf.audiobookAnalyses?.[variantId];
      if (e) e.reportSha256 = newSha;
    });
  }
}

async function migrateOne(
  projectId: string,
  projectDir: string,
  oldRel: string,
): Promise<{ status: 'migrated' | 'skipped' | 'failed'; reason?: string; orphans: string[] }> {
  const newRel = oldRel.replace(/^output\//, 'archive/');
  const oldAbs = relToAbs(projectDir, oldRel);
  const newAbs = relToAbs(projectDir, newRel);

  // Read fresh to capture associated transcript sidecars under lock-free snapshot.
  const { manifest } = await getManifest(projectId);
  if (!manifest) return { status: 'failed', reason: 'manifest not found', orphans: [] };
  const oldVtts = associatedOutputVtts(manifest, oldRel);

  // Finish a partially-applied prior run (output gone but archive copy present):
  // just ensure the manifest points at archive/ and the analyses are rewritten.
  if (!(await pathExists(oldAbs))) {
    if (await pathExists(newAbs)) {
      const saved = await modifyManifest(projectId, (mf) => rewriteManifestPointers(mf, oldRel, newRel, oldVtts));
      if (!saved.success) return { status: 'failed', reason: saved.error || 'manifest update failed', orphans: [] };
      await rewriteAnalysesForMove(projectId, projectDir, oldRel, newRel);
      return { status: 'migrated', orphans: [] };
    }
    return { status: 'skipped', reason: `output file already gone: ${oldRel}`, orphans: [] };
  }

  // Assemble the full set of files to move (m4b + sidecars + manifest vtts).
  const moveSet = new Set<string>(await siblingFiles(oldAbs));
  for (const vrel of oldVtts) moveSet.add(relToAbs(projectDir, vrel));

  // 1. COPY everything into archive/ (output originals untouched).
  const copied: string[] = [];
  try {
    for (const src of moveSet) {
      if (!(await pathExists(src))) continue;
      const dst = path.join(path.dirname(newAbs), path.basename(src));
      await atomicCopyFile(src, dst);
      copied.push(dst);
    }
  } catch (err) {
    for (const c of copied) { try { await fs.unlink(c); } catch { /* rollback */ } }
    return { status: 'failed', reason: `copy to archive failed: ${(err as Error).message}`, orphans: [] };
  }

  // 2. CONFIRM the manifest write pointing at archive/ BEFORE removing anything.
  const saved = await modifyManifest(projectId, (mf) => rewriteManifestPointers(mf, oldRel, newRel, oldVtts));
  if (!saved.success) {
    for (const c of copied) { try { await fs.unlink(c); } catch { /* rollback */ } }
    return { status: 'failed', reason: `manifest update failed: ${saved.error}`, orphans: [] };
  }

  // 2b. Keep committed analyses valid across the move (best-effort).
  try { await rewriteAnalysesForMove(projectId, projectDir, oldRel, newRel); }
  catch { /* analysis just goes stale — recomputable, never corrupt */ }

  // 3. UNLINK output/ originals. A locked file (EBUSY/EPERM on the Syncthing drive)
  // is a recoverable skip: leave the orphan and report it, never a dangling manifest.
  const orphans: string[] = [];
  for (const src of moveSet) {
    if (!(await pathExists(src))) continue;
    try { await fs.unlink(src); } catch { orphans.push(src); }
  }
  return { status: 'migrated', orphans };
}

async function migrateBook(snapshot: ProjectManifest): Promise<ArchiveMigrationBookResult> {
  const projectId = snapshot.projectId;
  const title = snapshot.metadata?.title || projectId;
  try {
    const { manifest } = await getManifest(projectId);
    if (!manifest) return { projectId, title, status: 'failed', reason: 'manifest not found' };

    const targets = selectProfessionalOutputM4bs(manifest);
    if (targets.length === 0) {
      return { projectId, title, status: 'skipped', reason: 'no professionally-read audiobook in output/' };
    }

    const projectDir = getProjectPath(projectId);
    const orphans: string[] = [];
    let movedAny = false;
    for (const oldRel of targets) {
      const res = await migrateOne(projectId, projectDir, oldRel);
      if (res.status === 'failed') return { projectId, title, status: 'failed', reason: res.reason };
      if (res.status === 'migrated') movedAny = true;
      if (res.orphans.length) orphans.push(...res.orphans);
    }
    return {
      projectId,
      title,
      status: movedAny ? 'migrated' : 'skipped',
      reason: movedAny ? undefined : 'already migrated',
      orphans: orphans.length ? orphans : undefined,
    };
  } catch (err) {
    return { projectId, title, status: 'failed', reason: (err as Error).message };
  }
}

/**
 * Migrate every professionally-read audiobook still under output/ into archive/.
 * Safe to run repeatedly. Returns a per-book success/skip/failure report.
 */
export async function migrateProfessionalAudiobooksToArchive(
  onProgress?: ProgressCallback,
): Promise<ArchiveMigrationResult> {
  const list = await listProjects();
  if (!list.success || !list.projects) {
    return { success: false, books: [], migrated: 0, skipped: 0, failed: 0 };
  }

  const books: ArchiveMigrationBookResult[] = [];
  const total = list.projects.length;
  let current = 0;
  for (const snapshot of list.projects) {
    current++;
    onProgress?.({ current, total, projectId: snapshot.projectId, title: snapshot.metadata?.title || snapshot.projectId });
    books.push(await migrateBook(snapshot));
  }

  const migrated = books.filter((b) => b.status === 'migrated').length;
  const skipped = books.filter((b) => b.status === 'skipped').length;
  const failed = books.filter((b) => b.status === 'failed').length;
  return { success: failed === 0, books, migrated, skipped, failed };
}
