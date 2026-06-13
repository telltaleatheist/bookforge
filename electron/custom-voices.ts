/**
 * User-added custom XTTS voices.
 *
 * Lets a user point BookForge at their OWN fine-tuned XTTS checkpoint folder
 * (config.json + model.pth + vocab.json + a reference .wav) and use it in the
 * streaming player (Play tab) and the browser extension, alongside the built-in
 * and downloadable voices.
 *
 * These are NOT catalog components (they're arbitrary user folders), so they
 * live in their own registry at <userData>/custom-voices.json. The streaming
 * worker loads them from the local folder directly (no HuggingFace fetch); see
 * xtts_stream.py load_voice() `local_checkpoint_dir`.
 *
 * Full audiobook generation: e2a loads a custom checkpoint from the rigid
 * custom_model_dir/<engine>/<name>/{config.json,model.pth,vocab.json} layout
 * (plus a <name>.wav reference). ensureCustomVoiceStaged() builds that layout by
 * hardlinking (instant, same-volume) — falling back to copy across volumes — so
 * the 1.7 GB checkpoint isn't duplicated in the common case. The bridges pass
 * --custom_model <name> --custom_model_dir <root> --voice <staged wav>; the e2a
 * fork (bookforge_ext/parallel) loads them in place with no zip extraction.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface CustomVoice {
  id: string;             // filesystem-safe, unique; echoed back on load
  name: string;           // display name
  checkpointDir: string;  // absolute folder holding config.json/model.pth/vocab.json
  refPath: string;        // absolute path to the reference .wav (for conditioning latents)
}

// The three checkpoint files an XTTS fine-tune must ship, plus we require a
// reference clip to clone from.
const REQUIRED_FILES = ['config.json', 'model.pth', 'vocab.json'];

function registryPath(): string {
  return path.join(app.getPath('userData'), 'custom-voices.json');
}

function readRegistry(): CustomVoice[] {
  try {
    const raw = fs.readFileSync(registryPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRegistry(voices: CustomVoice[]): void {
  fs.writeFileSync(registryPath(), JSON.stringify(voices, null, 2), 'utf-8');
}

/** Registered custom voices whose checkpoint folder still exists on disk. */
export function listCustomVoices(): CustomVoice[] {
  return readRegistry().filter((v) => {
    try {
      return fs.existsSync(path.join(v.checkpointDir, 'model.pth'));
    } catch {
      return false;
    }
  });
}

/** Insert spaces so "MyClonedVoice" reads as "My Cloned Voice". */
function prettify(stem: string): string {
  return stem
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .trim() || stem;
}

/** A filesystem- and e2a-safe id derived from the folder name, made unique. */
function deriveId(folderName: string, taken: Set<string>): string {
  const base = folderName.replace(/[^A-Za-z0-9_-]+/g, '') || 'CustomVoice';
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  return id;
}

/** The first .wav directly inside the folder, or null. Used as the reference clip. */
function findRefWav(dir: string): string | null {
  try {
    const wav = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.wav'));
    return wav ? path.join(dir, wav) : null;
  } catch {
    return null;
  }
}

/**
 * Validate and register a custom voice from a user-picked checkpoint folder.
 * The folder must contain config.json, model.pth, vocab.json and at least one
 * .wav (used as the reference clip). Returns the new voice, or an error message
 * naming what's missing.
 */
export function addCustomVoiceFromFolder(
  folderPath: string,
  reservedIds: Set<string> = new Set()
): { success: true; voice: CustomVoice } | { success: false; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(folderPath);
  } catch {
    return { success: false, error: `Folder not found: ${folderPath}` };
  }
  if (!stat.isDirectory()) {
    return { success: false, error: 'Please pick a folder, not a file.' };
  }

  const missing = REQUIRED_FILES.filter((f) => !fs.existsSync(path.join(folderPath, f)));
  if (missing.length > 0) {
    return {
      success: false,
      error:
        `This doesn't look like an XTTS voice folder — missing: ${missing.join(', ')}. ` +
        'An XTTS voice folder holds config.json, model.pth and vocab.json (plus a reference .wav).',
    };
  }

  const refPath = findRefWav(folderPath);
  if (!refPath) {
    return {
      success: false,
      error: 'No reference .wav found in the folder. Add a short reference clip of the voice (a .wav) and try again.',
    };
  }

  const existing = readRegistry();
  const folderName = path.basename(folderPath);
  // Already registered (same folder)? Return the existing record.
  const dup = existing.find((v) => path.resolve(v.checkpointDir) === path.resolve(folderPath));
  if (dup) return { success: true, voice: dup };

  const taken = new Set<string>([...existing.map((v) => v.id), ...reservedIds]);
  const voice: CustomVoice = {
    id: deriveId(folderName, taken),
    name: prettify(folderName),
    checkpointDir: folderPath,
    refPath,
  };
  writeRegistry([...existing, voice]);
  return { success: true, voice };
}

/** Forget a custom voice (does not delete the user's files). */
export function removeCustomVoice(id: string): { success: boolean } {
  const next = readRegistry().filter((v) => v.id !== id);
  writeRegistry(next);
  // Drop the staged e2a layout too (hardlinks/copies we created, never the user's
  // originals — those live in checkpointDir).
  try {
    const dir = path.join(stagingRootFor(id), CUSTOM_ENGINE, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// e2a custom-model staging (full audiobook generation)
// ─────────────────────────────────────────────────────────────────────────────

/** XTTS is the only engine that supports user fine-tunes today. */
const CUSTOM_ENGINE = 'xtts';

/** Result handed to the TTS bridges to build e2a --custom_model* args. */
export interface CustomVoiceE2aArgs {
  customModel: string;     // model NAME (the voice id)
  customModelDir: string;  // staging root that contains <engine>/<name>/
  voicePath: string;       // staged reference wav (inside customModelDir)
}

/** Single staging root for all custom voices: <userData>/custom-model-staging. */
function stagingRootFor(_id: string): string {
  return path.join(app.getPath('userData'), 'custom-model-staging');
}

/**
 * Hardlink src→dest (instant, same-volume), falling back to a copy across
 * volumes or when hardlinks aren't supported. No-op if dest already exists
 * (hardlinks share content with the source, so a stale link is harmless).
 */
function linkOrCopy(src: string, dest: string): void {
  if (fs.existsSync(dest)) return;
  try {
    fs.linkSync(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return;
    // EXDEV (cross-device) or a filesystem without hardlinks → copy.
    fs.copyFileSync(src, dest);
  }
}

/**
 * Ensure the rigid e2a layout exists for a custom voice and return the args the
 * TTS bridges thread into prep/worker. Idempotent: re-staging an already-staged
 * voice is cheap. Returns null if the voice isn't registered (or its files are
 * gone), so callers fall back to the normal --fine_tuned path.
 */
export function ensureCustomVoiceStaged(id: string): CustomVoiceE2aArgs | null {
  const voice = listCustomVoices().find((v) => v.id === id);
  if (!voice) return null;

  const root = stagingRootFor(id);
  const modelDir = path.join(root, CUSTOM_ENGINE, id);
  try {
    fs.mkdirSync(modelDir, { recursive: true });
    for (const f of REQUIRED_FILES) {
      linkOrCopy(path.join(voice.checkpointDir, f), path.join(modelDir, f));
    }
    // e2a's _set_voice() uses session['voice'] directly (skipping built-in speaker
    // resolution) only when the wav path is INSIDE custom_model_dir — so stage it
    // here as <name>.wav.
    const voicePath = path.join(modelDir, `${id}.wav`);
    linkOrCopy(voice.refPath, voicePath);
    return { customModel: id, customModelDir: root, voicePath };
  } catch (err) {
    console.error(`[CUSTOM-VOICES] Failed to stage ${id} for e2a:`, err);
    return null;
  }
}

/** True when `id` names a registered custom voice (vs a catalog fine-tune). */
export function isCustomVoiceId(id: string | undefined | null): boolean {
  if (!id) return false;
  return listCustomVoices().some((v) => v.id === id);
}
