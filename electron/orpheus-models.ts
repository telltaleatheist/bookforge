/**
 * Folder-discovered custom Orpheus models, backed by a local manifest.
 *
 * Models live in
 *
 *   <orpheusModelsDir>/<id>/        (config.json + a *.safetensors shard)
 *
 * and are catalogued in a `models.json` manifest in that same dir. The manifest
 * is the source of truth for the things the filesystem can't tell us — above all
 * the **prompt token** the model was fine-tuned on (e.g. `owen:`), which often
 * differs from the folder name for third-party models. It also records the source
 * (HF repo / URL) so a voice can be re-pulled, plus label/format/sample-rate.
 *
 * Discovery is manifest-first, with a reconcile fallback: any folder that is a
 * valid model but missing from the manifest is still offered (auto-imported with
 * its folder name guessed as the token), so manually-dropped folders keep working.
 *
 * The catalogue of what's *available to download* lives on HuggingFace (see
 * orpheus-hf-catalog.ts); installing a voice writes its files here and upserts a
 * manifest entry. This module only concerns what's installed locally.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './tool-paths';

/** A resolved, loadable custom voice. */
export interface OrpheusModel {
  /** Dropdown value / folder id. */
  id: string;
  /** Human label, e.g. "Owen Morgan". */
  label: string;
  /** The prompt token (`--fine_tuned`). From the manifest; may differ from id. */
  voice: string;
  /** Absolute path to the model folder (`--orpheus_model_dir`). */
  dir: string;
}

/** One installed-model record in models.json. */
export interface OrpheusManifestEntry {
  /** Folder id (and dropdown value). */
  id: string;
  /** Display label. */
  label: string;
  /** The prompt token the model was fine-tuned on — the thing we can't guess. */
  token: string;
  /** Folder name under the models dir (defaults to id). */
  dir?: string;
  /** Model format. */
  format?: 'hf' | 'mlx';
  /** Native sample rate (Orpheus = 24000). */
  sampleRate?: number;
  /** Where it came from, so it can be re-pulled / updated. */
  source?: { type: 'hf' | 'url' | 'local'; ref?: string };
  license?: string;
  /** ISO date string (stamped by the installer; we never call Date in tests). */
  addedAt?: string;
}

interface OrpheusManifest {
  version: number;
  models: OrpheusManifestEntry[];
}

const MANIFEST_NAME = 'models.json';
const MANIFEST_VERSION = 1;

/**
 * The custom-Orpheus models root.
 *
 * Resolution order: BOOKFORGE_ORPHEUS_MODELS_DIR env (dev seam) → the persisted
 * Settings value (Settings → Tools → "Orpheus models directory") → the default
 * <userData>/runtime/orpheus-models. On Windows+WSL the Settings value is typically
 * a \\wsl$\... UNC path so the model loads off WSL-native ext4; the WSL spawn
 * translates the UNC path to /home/... (see isWslUncPath/uncToWslPath in the bridge).
 */
export function getOrpheusModelsDir(): string {
  const override = process.env.BOOKFORGE_ORPHEUS_MODELS_DIR?.trim();
  if (override) return override;
  const configured = getConfig().orpheusModelsDir?.trim();
  if (configured) return configured;
  return path.join(app.getPath('userData'), 'runtime', 'orpheus-models');
}

function manifestPath(): string {
  return path.join(getOrpheusModelsDir(), MANIFEST_NAME);
}

/** Read models.json (tolerant: missing/corrupt → empty manifest). */
export function readManifest(): OrpheusManifest {
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    if (parsed && Array.isArray(parsed.models)) {
      return { version: parsed.version || MANIFEST_VERSION, models: parsed.models };
    }
  } catch {
    /* no manifest yet, or unreadable (e.g. WSL down for a \\wsl$ path) */
  }
  return { version: MANIFEST_VERSION, models: [] };
}

/** Write models.json (creates the dir if needed). */
export function writeManifest(models: OrpheusManifestEntry[]): void {
  fs.mkdirSync(getOrpheusModelsDir(), { recursive: true });
  const data: OrpheusManifest = { version: MANIFEST_VERSION, models };
  fs.writeFileSync(manifestPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/** Insert or replace a manifest entry by id. */
export function upsertManifestEntry(entry: OrpheusManifestEntry): void {
  const models = readManifest().models;
  const i = models.findIndex((e) => e.id === entry.id);
  if (i >= 0) models[i] = entry;
  else models.push(entry);
  writeManifest(models);
}

/** Remove a manifest entry by id (does NOT delete the folder). */
export function removeManifestEntry(id: string): void {
  writeManifest(readManifest().models.filter((e) => e.id !== id));
}

/** A folder is a usable model when it has config.json + at least one safetensors shard. */
function isModelFolder(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith('.safetensors'));
  } catch {
    return false;
  }
}

/** Prettify a folder name into a display label: "owen-morgan_v2" → "Owen Morgan V2". */
function prettyLabel(folder: string): string {
  return folder
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Installed custom Orpheus models, sorted by label. Manifest-first (so the token
 * is authoritative), with valid-but-unlisted folders auto-imported (token guessed
 * as the folder name) so manually-dropped folders still appear.
 */
export function listOrpheusModels(): OrpheusModel[] {
  const root = getOrpheusModelsDir();
  const manifest = readManifest();
  const listed = new Set(manifest.models.map((e) => e.id));
  const out: OrpheusModel[] = [];

  // 1) Manifest entries whose folder is actually a valid model.
  for (const e of manifest.models) {
    const dir = path.join(root, e.dir || e.id);
    if (isModelFolder(dir)) {
      out.push({ id: e.id, label: e.label || prettyLabel(e.id), voice: e.token || e.id, dir });
    }
  }

  // 2) Reconcile: valid folders not in the manifest (dropped by hand) — guess token.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const d of entries) {
    if (!d.isDirectory() || listed.has(d.name)) continue;
    const dir = path.join(root, d.name);
    if (!isModelFolder(dir)) continue;
    out.push({ id: d.name, label: prettyLabel(d.name), voice: d.name, dir });
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * Resolve a selected voice id to its model dir + prompt token, or null when the id
 * is not an installed custom model (i.e. it's a built-in voice). Uses the manifest
 * token when present, else falls back to id-as-token for an unlisted folder.
 */
export function resolveOrpheusModel(id: string | undefined | null): OrpheusModel | null {
  if (!id) return null;
  const root = getOrpheusModelsDir();
  const entry = readManifest().models.find((e) => e.id === id);
  const dir = path.join(root, entry?.dir || id);
  if (!isModelFolder(dir)) return null;
  return { id, label: entry?.label || prettyLabel(id), voice: entry?.token || id, dir };
}
