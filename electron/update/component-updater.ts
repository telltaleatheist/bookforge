/**
 * component-updater — keeps OUR server-hosted binaries current (ffmpeg, yt-dlp, …).
 *
 * Scope: ONLY manifest.components[] — the binaries WE build/host and watch. Third-party models
 * (HuggingFace voices, whisper, Stanza language packs) live in manifest.voices/languages and are
 * downloaded on demand from upstream; they are NOT our code and are deliberately OUTSIDE update
 * logic. This module never looks at them.
 *
 * "Watching" = the client compares, on each manifest poll, the installed version+sha256 against
 * the manifest. Replacing a binary on the server (re-run the publish step, which recomputes the
 * sha256 and bumps the manifest) therefore surfaces as an available update — even if the version
 * string is unchanged, a differing sha256 counts as an update.
 *
 * Install layout: userData/managed-bins/<id>/   (extracted archive contents)
 *                 userData/managed-bins/state.json  ({ [id]: InstalledBinary })
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { downloadAndExtract } from '../components/downloader';
import type { InstallProgress, Platform, Arch } from '../components/component-types';
import { readPointer } from '../launcher/boot-state';
import { getManifest } from './remote-manifest';
import { selectArtifact, currentPlatformArch } from './manifest-types';
import {
  MANAGED_BINS_DIR,
  readState,
  recordInstalled,
  defaultEntryRel,
} from './managed-bins';
import { gt, satisfies } from './semver';

const BASE_DIR = MANAGED_BINS_DIR;

export type ComponentUpdateState =
  | 'not-installed'
  | 'up-to-date'
  | 'update-available'
  | 'incompatible' // newer exists but needs a newer app code version (requiresApp)
  | 'unavailable'; // no artifact for this platform

export interface ComponentUpdateStatus {
  id: string;
  state: ComponentUpdateState;
  installedVersion: string | null;
  availableVersion: string;
  bytes: number;
  requiresApp?: string;
  /** Set while downloading. */
  progressPct?: number;
  error?: string;
}

/** The app code version that requiresApp gates against (the booted code bundle, or app version). */
function appVersion(): string {
  return readPointer()?.version ?? app.getVersion();
}

/** Compute the update status for every managed component in the manifest. */
export async function listManagedComponents(force = false): Promise<ComponentUpdateStatus[]> {
  const manifest = await getManifest(force);
  const state = readState();
  const platformArch = currentPlatformArch();

  return (manifest.components ?? []).map((c) => {
    const artifact = selectArtifact(c, platformArch);
    const installed = state[c.id] ?? null;
    const base: ComponentUpdateStatus = {
      id: c.id,
      state: 'up-to-date',
      installedVersion: installed?.version ?? null,
      availableVersion: c.version,
      bytes: artifact?.bytes ?? 0,
      requiresApp: c.requiresApp,
    };

    if (!artifact) return { ...base, state: 'unavailable' };
    if (c.requiresApp && !satisfies(appVersion(), c.requiresApp)) {
      return { ...base, state: 'incompatible' };
    }
    if (!installed) return { ...base, state: 'not-installed' };

    // Update if the version is newer, OR the content changed (sha256 differs) at the same version.
    const changed = gt(c.version, installed.version) || artifact.sha256 !== installed.sha256;
    return { ...base, state: changed ? 'update-available' : 'up-to-date' };
  });
}

/** Components that have a newer/changed, compatible build ready to install. */
export async function checkComponentUpdates(force = false): Promise<ComponentUpdateStatus[]> {
  const all = await listManagedComponents(force);
  return all.filter((s) => s.state === 'update-available' || s.state === 'not-installed');
}

/**
 * Download + verify + install (or update) one managed binary. Extracts the artifact archive into
 * userData/managed-bins/<id>/ (atomic: staging dir then rename), verifies sha256, records state.
 */
export async function installComponent(
  id: string,
  opts?: { onProgress?: (s: ComponentUpdateStatus) => void; signal?: AbortSignal }
): Promise<ComponentUpdateStatus> {
  const manifest = await getManifest(true);
  const component = (manifest.components ?? []).find((c) => c.id === id);
  if (!component) throw new Error(`Unknown component: ${id}`);

  const platformArch = currentPlatformArch();
  const artifact = selectArtifact(component, platformArch);
  if (!artifact) throw new Error(`No ${id} artifact for ${platformArch}`);
  if (component.requiresApp && !satisfies(appVersion(), component.requiresApp)) {
    throw new Error(`${id} ${component.version} requires app ${component.requiresApp}`);
  }

  const finalDir = path.join(BASE_DIR, id);
  const staging = finalDir + '.installing';
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const status: ComponentUpdateStatus = {
    id,
    state: 'update-available',
    installedVersion: readState()[id]?.version ?? null,
    availableVersion: component.version,
    bytes: artifact.bytes,
    requiresApp: component.requiresApp,
    progressPct: 0,
  };
  const emit = (p: Partial<ComponentUpdateStatus>) => {
    Object.assign(status, p);
    opts?.onProgress?.(status);
  };

  try {
    await downloadAndExtract(
      {
        platform: process.platform as Platform,
        arch: process.arch as Arch,
        url: artifact.url,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      },
      staging,
      (p: InstallProgress) => emit({ progressPct: Math.round(p.pct) }),
      opts?.signal
    );

    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(staging, finalDir);

    // Resolve + record the executable, and ensure it's runnable (tar usually preserves the
    // exec bit, but be defensive on non-Windows).
    const entryRel = component.entry ?? defaultEntryRel(id);
    const entryPath = path.join(finalDir, entryRel);
    if (process.platform !== 'win32' && fs.existsSync(entryPath)) {
      try {
        fs.chmodSync(entryPath, 0o755);
      } catch {
        /* non-fatal */
      }
    }
    recordInstalled(id, {
      version: component.version,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      dir: finalDir,
      entryPath,
      installedAt: new Date().toISOString(),
    });

    emit({ state: 'up-to-date', installedVersion: component.version, progressPct: 100 });
    return status;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    emit({ state: 'update-available', error: (err as Error).message });
    throw err;
  }
}
