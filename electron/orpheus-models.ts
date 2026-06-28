/**
 * Folder-discovered custom Orpheus models.
 *
 * Any HF/MLX Orpheus model folder dropped into
 *
 *   <userData>/runtime/orpheus-models/<voice-token>/
 *
 * is automatically offered as an Orpheus voice. By convention the FOLDER NAME is
 * the voice token the model was fine-tuned on (e.g. `.../owen` → prompt `owen:`),
 * and the display label is that name prettified. A folder counts as a model when
 * it contains a `config.json` plus at least one `*.safetensors` shard.
 *
 * This is the Orpheus analogue of rvc-models.ts: scan a managed dir, return a
 * list the renderer turns into a dropdown, and resolve a selected id back to an
 * absolute dir + voice token for the e2a `--orpheus_model_dir` arg. Unlike RVC
 * there is no download catalog — models are user-supplied (trained or pulled from
 * HF), so discovery is purely filesystem-driven.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './tool-paths';

export interface OrpheusModel {
  /** Dropdown value AND the voice token — the folder name verbatim. */
  id: string;
  /** Human label, e.g. "Owen Morgan" derived from "owen-morgan". */
  label: string;
  /** Voice token passed as --fine_tuned (same as id; kept explicit for clarity). */
  voice: string;
  /** Absolute path to the model folder, passed as --orpheus_model_dir. */
  dir: string;
}

/**
 * The custom-Orpheus models root.
 *
 * BOOKFORGE_ORPHEUS_MODELS_DIR overrides it so `electron:dev` can point at an
 * alternate folder — mirrors the BOOKFORGE_RVC_MODELS_DIR dev seam.
 */
export function getOrpheusModelsDir(): string {
  const override = process.env.BOOKFORGE_ORPHEUS_MODELS_DIR?.trim();
  if (override) return override;
  // Persisted Settings value (Settings → Tools → "Orpheus models directory").
  // On Windows+WSL this is typically a \\wsl$\... UNC path so the model loads off
  // WSL-native ext4; the WSL spawn translates it to /home/... (see isWslUncPath).
  const configured = getConfig().orpheusModelsDir?.trim();
  if (configured) return configured;
  return path.join(app.getPath('userData'), 'runtime', 'orpheus-models');
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

/** Scan the managed dir for usable custom Orpheus models (sorted by label). */
export function listOrpheusModels(): OrpheusModel[] {
  const root = getOrpheusModelsDir();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // dir doesn't exist yet → no custom models
  }
  const models: OrpheusModel[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    if (!isModelFolder(dir)) continue;
    models.push({ id: e.name, label: prettyLabel(e.name), voice: e.name, dir });
  }
  models.sort((a, b) => a.label.localeCompare(b.label));
  return models;
}

/**
 * Resolve a selected voice id to its model dir + voice token, or null when the id
 * is not a discovered custom Orpheus model (i.e. it's a built-in voice).
 */
export function resolveOrpheusModel(id: string | undefined | null): OrpheusModel | null {
  if (!id) return null;
  const dir = path.join(getOrpheusModelsDir(), id);
  if (!isModelFolder(dir)) return null;
  return { id, label: prettyLabel(id), voice: id, dir };
}
