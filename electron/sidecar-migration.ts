// Sidecar migration — extract each audiobook's embedded transcript + cover into
// HASH-BOUND sidecars (bookforge-sidecar-binding-v1) co-located with the m4b.
//
// Why sidecars are safe again: the previous named-`.vtt` sidecars mislinked to the
// wrong m4b (see metadata-tools.deleteSidecarsForM4b), which is why mono audiobooks
// went embed-only. Every sidecar this migration writes carries the m4b's SHA-256,
// so a reader serves it ONLY for those exact bytes — spillover is impossible.
//
// The embedded copies are LEFT INTACT (portability in other apps). This migration
// only ADDS files; it never rewrites an m4b and never mutates a manifest, so it is
// fully reversible (delete the three sidecar files per m4b). The binding is found
// at the deterministic sibling path `<m4b>.sidecars.json` — derive-don't-scan,
// the same pattern used for diff caches — and validated by hash before use.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { getVariants, getProjectsPath, getLibraryBasePath } from './manifest-service';
import { extractVttFromM4b } from './metadata-tools';
import { getFfmpegPath, getFfprobePath } from './tool-paths';
import type { ProjectManifest, ProjectVariant } from './manifest-types';
import {
  SIDECAR_BINDING_VERSION, SIDECAR_VTT_DIGEST_ALGORITHM,
  type SidecarBinding, type SidecarAssetRecord,
  sha256File, vttDigest, sidecarPathsFor, sidecarBase, writeBinding, writeFileAtomic,
} from './sidecar-binding';

export interface MigrationOptions {
  libraryRoot: string;
  dryRun: boolean;
  limit?: number;
  onlyProject?: string;
  onProgress?: (msg: string) => void;
}

export interface AssetOutcome {
  action: 'written' | 'would-write' | 'skipped-none' | 'error';
  source?: 'embedded' | 'metadata';
  rel?: string;          // project-relative sidecar path
  cueCount?: number;     // vtt only
  bytes?: number;
  error?: string;
}

export interface VariantOutcome {
  projectId: string;
  variantId: string;
  m4bRel: string;
  m4bSha256?: string;
  m4bBytes?: number;
  vtt: AssetOutcome;
  cover: AssetOutcome;
  bindingRel?: string;
  flags: string[];       // 'm4b-missing', 'already-bound-valid', etc.
}

export interface MigrationSummary {
  projectsScanned: number;
  variants: number;
  vttWritten: number;
  coverWritten: number;
  noTranscript: number;
  m4bMissing: number;
  errors: number;
  dryRun: boolean;
  outcomes: VariantOutcome[];
}

/** Probe the codec of the first video (attached-picture) stream, or null. */
function embeddedCoverCodec(m4bPath: string): string | null {
  try {
    const out = execFileSync(getFfprobePath(),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
        '-of', 'default=nw=1:nk=1', m4bPath], { encoding: 'utf8' }).trim();
    return out || null;
  } catch { return null; }
}

/** Copy the embedded cover out of the m4b losslessly to `<dest>`. Throws on failure. */
function extractEmbeddedCover(m4bPath: string, dest: string): void {
  execFileSync(getFfmpegPath(),
    ['-v', 'error', '-y', '-i', m4bPath, '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', dest],
    { stdio: ['ignore', 'ignore', 'pipe'] });
}

function extOfCodec(codec: string): string {
  if (codec === 'png') return 'png';
  if (codec === 'mjpeg' || codec === 'jpeg' || codec === 'jpg') return 'jpg';
  return 'img';
}

async function migrateVariant(
  projectDir: string,
  projectId: string,
  variant: ProjectVariant,
  manifest: ProjectManifest,
  opts: MigrationOptions,
): Promise<VariantOutcome> {
  const m4bAbs = path.join(projectDir, variant.path);
  const outcome: VariantOutcome = {
    projectId, variantId: variant.id, m4bRel: variant.path,
    vtt: { action: 'skipped-none' }, cover: { action: 'skipped-none' }, flags: [],
  };

  if (!fs.existsSync(m4bAbs)) { outcome.flags.push('m4b-missing'); return outcome; }

  // 1. Authoritative m4b identity (full hash — this is a commit-time operation).
  const { sha256: m4bSha256, size: m4bBytes } = await sha256File(m4bAbs);
  outcome.m4bSha256 = m4bSha256;
  outcome.m4bBytes = m4bBytes;

  const paths = sidecarPathsFor(m4bAbs);
  const rel = (p: string) => path.relative(projectDir, p).split(path.sep).join('/');
  const assets: Partial<Record<'vtt' | 'cover', SidecarAssetRecord>> = {};

  // 2. Transcript. Mono audiobooks carry it EMBEDDED; bilingual carry a sidecar
  //    VTT recorded on the variant. Prefer the embedded track, fall back to the
  //    recorded sidecar (bilingual). Absent → no transcript for this book.
  try {
    let vttText = await extractVttFromM4b(m4bAbs);
    let vttSource: 'embedded' | 'metadata' = 'embedded';
    if (!vttText && variant.vttPath) {
      const sidecarAbs = path.join(projectDir, variant.vttPath);
      if (fs.existsSync(sidecarAbs)) { vttText = fs.readFileSync(sidecarAbs, 'utf8'); vttSource = 'metadata'; }
    }
    if (vttText) {
      const buf = Buffer.from(vttText, 'utf8');
      // The canonical cue digest is an OPTIONAL integrity extra. Some embedded
      // transcripts contain a degenerate cue (e.g. a zero-duration `t --> t`) that
      // the STRICT parser rejects — yet the player serves them fine with its lenient
      // parser. Write the sidecar byte-identical to the embedded track regardless;
      // omit only the canonical digest when it can't be computed. The m4bSha256 is
      // what actually binds this transcript to THIS audio, not the cue digest.
      let transcriptSha256: string | undefined;
      let cueCount: number | undefined;
      try { ({ transcriptSha256, cueCount } = vttDigest(vttText)); }
      catch { outcome.flags.push('vtt-noncanonical'); }
      if (!opts.dryRun) await writeFileAtomic(paths.vtt, buf);
      assets.vtt = {
        path: rel(paths.vtt), sha256: (await import('crypto')).createHash('sha256').update(buf).digest('hex'),
        bytes: buf.byteLength, source: vttSource,
        ...(transcriptSha256 ? { transcriptDigestAlgorithm: SIDECAR_VTT_DIGEST_ALGORITHM, transcriptSha256, cueCount } : {}),
      };
      outcome.vtt = { action: opts.dryRun ? 'would-write' : 'written', source: vttSource, rel: rel(paths.vtt), cueCount, bytes: buf.byteLength };
    }
  } catch (err) {
    outcome.vtt = { action: 'error', error: String((err as Error).message || err) };
  }

  // 3. Cover. Prefer the embedded attached picture (lossless copy); fall back to
  //    the project cover recorded in metadata (library-relative under media/).
  try {
    const codec = embeddedCoverCodec(m4bAbs);
    let coverAbs: string | null = null;
    let coverSource: 'embedded' | 'metadata' = 'embedded';
    let coverExt = 'jpg';
    const coverBase = sidecarBase(m4bAbs);
    if (codec) {
      coverExt = extOfCodec(codec);
      coverAbs = `${coverBase}.cover.${coverExt}`;
      if (!opts.dryRun) extractEmbeddedCover(m4bAbs, coverAbs);
    } else {
      const coverRel = variant.metadata?.coverPath || manifest.metadata?.coverPath;
      if (coverRel) {
        const srcAbs = path.join(opts.libraryRoot, coverRel);
        if (fs.existsSync(srcAbs)) {
          coverExt = (path.extname(srcAbs).replace('.', '') || 'jpg').toLowerCase();
          coverAbs = `${coverBase}.cover.${coverExt}`;
          coverSource = 'metadata';
          if (!opts.dryRun) fs.copyFileSync(srcAbs, coverAbs);
        }
      }
    }
    if (coverAbs) {
      // In dry-run the file doesn't exist yet; hash/size only when written.
      let sha = ''; let bytes = 0;
      if (!opts.dryRun) { const r = await sha256File(coverAbs); sha = r.sha256; bytes = r.size; }
      assets.cover = { path: rel(coverAbs), sha256: sha, bytes, source: coverSource };
      outcome.cover = { action: opts.dryRun ? 'would-write' : 'written', source: coverSource, rel: rel(coverAbs), bytes };
    }
  } catch (err) {
    outcome.cover = { action: 'error', error: String((err as Error).message || err) };
  }

  // 4. Binding — only when at least one asset was produced.
  if (assets.vtt || assets.cover) {
    const binding: SidecarBinding = {
      protocol: SIDECAR_BINDING_VERSION,
      projectId, variantId: variant.id,
      m4b: { path: variant.path, sha256: m4bSha256, bytes: m4bBytes },
      assets,
      createdAt: new Date().toISOString(),
      generator: 'sidecar-migration-v1',
    };
    if (!opts.dryRun) await writeBinding(paths.binding, binding);
    outcome.bindingRel = rel(paths.binding);
  }
  return outcome;
}

const normRel = (p: string): string => (p || '').replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

/**
 * Regenerate the hash-bound sidecars for a SINGLE m4b that was just (re)written or
 * re-embedded, deriving its projectId + variantId from the path and manifest. Call
 * it right after an embed (where the old sidecars are deleted) so the sidecar tracks
 * the NEW m4b bytes — this is how new and re-aligned audiobooks stay bound going
 * forward, not just the one-time migration. Best-effort: returns null and NEVER
 * throws, so it can't break the audiobook pipeline. No-op for a path outside the
 * library's projects/ tree or a variant not found in the manifest.
 */
export async function regenerateBoundSidecars(m4bAbsPath: string): Promise<VariantOutcome | null> {
  try {
    const projectsRoot = getProjectsPath();
    const abs = path.resolve(m4bAbsPath);
    const relToProjects = path.relative(projectsRoot, abs);
    if (relToProjects.startsWith('..') || path.isAbsolute(relToProjects)) return null;
    const projectId = relToProjects.split(path.sep)[0];
    const projectDir = path.join(projectsRoot, projectId);
    const mp = path.join(projectDir, 'manifest.json');
    if (!fs.existsSync(mp)) return null;
    const manifest: ProjectManifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
    const { variants } = getVariants(manifest);
    const rel = path.relative(projectDir, abs).split(path.sep).join('/');
    const variant = variants.find(v => v.kind === 'audiobook' && normRel(v.path) === normRel(rel));
    if (!variant) return null;
    return await migrateVariant(projectDir, manifest.projectId || projectId, variant, manifest,
      { libraryRoot: getLibraryBasePath(), dryRun: false });
  } catch {
    return null;
  }
}

export async function migrateLibrary(opts: MigrationOptions): Promise<MigrationSummary> {
  const projectsRoot = path.join(opts.libraryRoot, 'projects');
  const slugs = fs.readdirSync(projectsRoot)
    .filter(d => { try { return fs.statSync(path.join(projectsRoot, d)).isDirectory(); } catch { return false; } })
    .filter(d => !opts.onlyProject || d === opts.onlyProject);

  const summary: MigrationSummary = {
    projectsScanned: 0, variants: 0, vttWritten: 0, coverWritten: 0,
    noTranscript: 0, m4bMissing: 0, errors: 0, dryRun: opts.dryRun, outcomes: [],
  };

  for (const slug of slugs) {
    if (opts.limit && summary.variants >= opts.limit) break;
    const dir = path.join(projectsRoot, slug);
    const mp = path.join(dir, 'manifest.json');
    if (!fs.existsSync(mp)) continue;
    let manifest: ProjectManifest;
    try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); }
    catch { summary.errors++; continue; }
    summary.projectsScanned++;
    const projectId = manifest.projectId || slug;

    const { variants } = getVariants(manifest);
    for (const v of variants) {
      if (v.kind !== 'audiobook' || !v.path?.endsWith('.m4b')) continue;
      if (opts.limit && summary.variants >= opts.limit) break;
      summary.variants++;
      let oc: VariantOutcome;
      try {
        oc = await migrateVariant(dir, projectId, v, manifest, opts);
      } catch (err) {
        // One variant failing (a bad m4b, an unwritable path) must never abort the
        // whole library run — record it and move on.
        oc = {
          projectId, variantId: v.id, m4bRel: v.path, flags: ['variant-error'],
          vtt: { action: 'error', error: String((err as Error).message || err) },
          cover: { action: 'error' },
        };
      }
      summary.outcomes.push(oc);
      if (oc.flags.includes('m4b-missing')) summary.m4bMissing++;
      if (oc.vtt.action === 'written' || oc.vtt.action === 'would-write') summary.vttWritten++;
      else if (oc.vtt.action === 'skipped-none') summary.noTranscript++;
      if (oc.cover.action === 'written' || oc.cover.action === 'would-write') summary.coverWritten++;
      if (oc.vtt.action === 'error' || oc.cover.action === 'error') summary.errors++;
      opts.onProgress?.(`${slug} · ${v.id}: vtt=${oc.vtt.action} cover=${oc.cover.action}`);
    }
  }
  return summary;
}
