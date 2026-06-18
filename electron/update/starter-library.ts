/**
 * starter-library — seed a brand-new, EMPTY library with the bundled finished sample project.
 *
 * On first run, after the user sets their library folder, if that library has NO projects yet AND
 * the manifest advertises a `starter`, we download + sha256-verify the starter tarball and extract
 * it straight into the library root (the archive is rooted there: projects/<slug>/ + media/<cover>).
 *
 * This is CONTENT, not code — it is never part of the auto-update tiers, and it is NEVER seeded
 * into a library that already contains projects (the user's fresh-vs-existing rule). It runs once.
 */

import * as fs from 'fs';
import * as path from 'path';
import { downloadAndExtract } from '../components/downloader';
import type { InstallProgress, Platform, Arch } from '../components/component-types';
import { getManifest } from './remote-manifest';

export interface StarterStatus {
  /** The manifest advertises a starter library. */
  available: boolean;
  /** The target library already has projects → seeding is skipped. */
  alreadyPresent: boolean;
  slug?: string;
  bytes?: number;
  /** Set during an install. */
  installing?: boolean;
  phase?: InstallProgress['phase'];
  progressPct?: number;
  error?: string;
}

/**
 * A library is eligible for seeding only when it's empty — i.e. its projects/ dir contains no
 * folder with a manifest.json. Missing/unreadable projects/ counts as empty (fresh library).
 */
export function isLibraryEmpty(libraryRoot: string): boolean {
  const projectsDir = path.join(libraryRoot, 'projects');
  try {
    if (!fs.existsSync(projectsDir)) return true;
    for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) {
      if (e.isDirectory() && fs.existsSync(path.join(projectsDir, e.name, 'manifest.json'))) {
        return false;
      }
    }
    return true;
  } catch {
    return true;
  }
}

/** Whether a starter exists in the manifest and whether the library is eligible to receive it. */
export async function getStarterStatus(libraryRoot: string, force = false): Promise<StarterStatus> {
  let starter;
  try {
    starter = (await getManifest(force)).starter;
  } catch {
    return { available: false, alreadyPresent: false };
  }
  if (!starter || !starter.url) return { available: false, alreadyPresent: false };
  return {
    available: true,
    alreadyPresent: !isLibraryEmpty(libraryRoot),
    slug: starter.slug,
    bytes: starter.bytes,
  };
}

/**
 * Download + verify + extract the starter library into an EMPTY library root. No-ops (does NOT
 * overwrite) if the library already has projects. Returns the resulting status.
 */
export async function installStarterLibrary(
  libraryRoot: string,
  opts?: { onProgress?: (s: StarterStatus) => void; signal?: AbortSignal }
): Promise<StarterStatus> {
  const starter = (await getManifest(true)).starter;
  if (!starter || !starter.url) {
    return { available: false, alreadyPresent: false };
  }
  // Hard guard: never seed over an existing library.
  if (!isLibraryEmpty(libraryRoot)) {
    return { available: true, alreadyPresent: true, slug: starter.slug, bytes: starter.bytes };
  }

  const status: StarterStatus = {
    available: true,
    alreadyPresent: false,
    slug: starter.slug,
    bytes: starter.bytes,
    installing: true,
    progressPct: 0,
  };
  const emit = (p: Partial<StarterStatus>) => {
    Object.assign(status, p);
    opts?.onProgress?.(status);
  };

  fs.mkdirSync(libraryRoot, { recursive: true });

  try {
    await downloadAndExtract(
      {
        platform: process.platform as Platform,
        arch: process.arch as Arch,
        url: starter.url,
        sha256: starter.sha256,
        bytes: starter.bytes,
      },
      libraryRoot,
      (p: InstallProgress) => emit({ phase: p.phase, progressPct: Math.round(p.pct) }),
      opts?.signal
    );
    emit({ installing: false, alreadyPresent: true, progressPct: 100 });
    return status;
  } catch (err) {
    emit({ installing: false, error: (err as Error).message });
    throw err;
  }
}
