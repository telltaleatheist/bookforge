/**
 * dagger-models — the downloadable footnote-marker remover.
 *
 * Scanned books arrive with footnote reference markers welded into the prose:
 * a superscript digit that OCR flattens into the sentence, so "the treaty³ was
 * signed" narrates as "the treaty three was signed". Dagger reads a passage and
 * returns it with those markers gone and NOTHING ELSE CHANGED. It is 1.2 GB, so
 * it downloads through the same component machinery as voices, RVC models,
 * speech-to-text and the page-layout model.
 *
 *   Hosting:  huggingface.co/owenmorgan/bookforge-dagger  (direct resolve URLs)
 *   On disk:  <OwenMorgan shared>/dagger-models/<filename>.gguf
 *   Served by: electron/dagger-server.ts — the BUNDLED llama-server, on the raw
 *              /completion endpoint.
 *
 * f16, NOT quantized, and that is deliberate. Dagger trained in bf16 and its job
 * is to copy its input back verbatim minus a few characters; a lossy weight step
 * buys ~600 MB and risks the one thing the model exists to guarantee. At 0.6B
 * the full-precision weights are smaller than the page-layout model's quant
 * anyway, so there is nothing to trade.
 *
 * A plain HTTP fetch, deliberately: a single GGUF needs no Python at all, and
 * cleanup should not fail because a TTS env is missing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

import { downloadFile } from './components/downloader';
import { migrateLegacyDir } from './shared-paths';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export interface DaggerModelDef {
  /** Stable id. Also the component id suffix. */
  id: string;
  /** User-facing name. Says what it does, not what it is built from. */
  name: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  /** GB of RAM the weights comfortably need, plus its small KV cache. */
  minRAM: number;
  note: string;
  /** Preferred when more than one is installed — higher wins. */
  rank: number;
}

const HF = 'https://huggingface.co/owenmorgan/bookforge-dagger/resolve/main';

/**
 * The version in the id is load-bearing the same way rubric's is: it is what a
 * caller keys the prompt format off. Adding a v2 means declaring it wherever the
 * prompt is built BEFORE it can be listed here.
 */
export const DAGGER_MODELS: DaggerModelDef[] = [
  {
    id: 'dagger-v1-0.6b',
    name: 'Footnote marker remover',
    filename: 'dagger-v1-0.6b-f16.gguf',
    url: `${HF}/dagger-v1-0.6b-f16.gguf`,
    sha256: 'cbe3cee888c92caa6a67a9084d8b9e6bc3324479e52d2601c54eda71a241bff3',
    bytes: 1198182784,
    minRAM: 2,
    note: 'Strips the leftover footnote reference markers OCR welds into the '
      + 'prose, so a superscript digit is not narrated as a number in the middle '
      + 'of a sentence. Returns the passage otherwise untouched.',
    rank: 10,
  },
];

export function getDaggerModelDef(id: string): DaggerModelDef | undefined {
  return DAGGER_MODELS.find((m) => m.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Location
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The models dir: `<OwenMorgan shared>/dagger-models`.
 *
 * Its own sub-directory, not a corner of rubric-models: that name belongs to the
 * page-layout model, and a shared dir that quietly holds someone else's weights
 * is the kind of thing that gets half-deleted later.
 *
 * Shared rather than per-app for the same reason the Cogito GGUFs are (see
 * llama-bridge.ts getModelsDir): weights are identical across OwenMorgan apps.
 * `migrateLegacyDir` moves a pre-existing per-app copy once, so an upgrade does
 * not re-download.
 *
 * Overridable for tests and odd installs. Nothing stores an absolute path to a
 * model — a model is always referenced by id and resolved here — so the dir can
 * move without invalidating anything.
 */
export function getDaggerModelsDir(): string {
  const override = process.env.BOOKFORGE_DAGGER_MODELS_DIR?.trim();
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  return migrateLegacyDir(path.join(app.getPath('userData'), 'dagger-models'), 'dagger-models');
}

/** Absolute path to a model's GGUF (may not exist yet). */
export function daggerModelPath(id: string): string {
  const def = getDaggerModelDef(id);
  if (!def) throw new Error(`Unknown dagger model: ${id}`);
  return path.join(getDaggerModelsDir(), def.filename);
}

/**
 * Present when the GGUF is on disk at its full expected size.
 *
 * Size-checked, not just existence-checked: an interrupted download that got
 * renamed into place (or a half-synced file) would otherwise read as installed
 * and llama-server would fail to load it with a message about the file format,
 * which sends the user looking in entirely the wrong place.
 */
export function isDaggerModelPresent(id: string): boolean {
  const def = getDaggerModelDef(id);
  if (!def) return false;
  try {
    return fs.statSync(path.join(getDaggerModelsDir(), def.filename)).size === def.bytes;
  } catch {
    return false;
  }
}

export interface DaggerModelStatus extends DaggerModelDef {
  present: boolean;
  path: string;
}

export function listDaggerModels(): DaggerModelStatus[] {
  const dir = getDaggerModelsDir();
  return DAGGER_MODELS.map((m) => ({
    ...m,
    present: isDaggerModelPresent(m.id),
    path: path.join(dir, m.filename),
  }));
}

/** The best installed model, or null. What the cleanup path defaults to. */
export function bestInstalledDaggerModel(): DaggerModelStatus | null {
  const installed = listDaggerModels().filter((m) => m.present);
  if (!installed.length) return null;
  return installed.sort((a, b) => b.rank - a.rank)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

export interface DaggerDownloadProgress {
  id: string;
  pct: number;
  receivedBytes: number;
  totalBytes: number;
}

interface InFlight {
  promise: Promise<{ ok: boolean; error?: string }>;
  controller: AbortController;
  listeners: Set<(p: DaggerDownloadProgress) => void>;
  last?: DaggerDownloadProgress;
}
const inFlight = new Map<string, InFlight>();

/**
 * Download a model into its dir.
 *
 * Idempotent, and concurrent callers JOIN rather than race: the Settings panel,
 * the setup page's download dock and a cleanup run that found no model can all
 * ask at once, and two `downloadFile`s into one path would interleave bytes.
 * Downloads to `<name>.download` and renames only on success, so an interrupted
 * one can never be mistaken for an installed model.
 */
export function downloadDaggerModel(
  id: string,
  onProgress?: (p: DaggerDownloadProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const def = getDaggerModelDef(id);
  if (!def) return Promise.resolve({ ok: false, error: `Unknown dagger model: ${id}` });
  if (isDaggerModelPresent(id)) return Promise.resolve({ ok: true });

  const running = inFlight.get(id);
  if (running) {
    if (onProgress) {
      running.listeners.add(onProgress);
      if (running.last) onProgress(running.last);
    }
    return running.promise;
  }

  const listeners = new Set<(p: DaggerDownloadProgress) => void>();
  if (onProgress) listeners.add(onProgress);
  const controller = new AbortController();
  const entry: InFlight = { promise: Promise.resolve({ ok: true }), controller, listeners };
  inFlight.set(id, entry);

  const dir = getDaggerModelsDir();
  const dest = path.join(dir, def.filename);
  const tmp = `${dest}.download`;

  entry.promise = (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // A stale partial from a previous run: start clean rather than append.
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }

      await downloadFile(def.url, tmp, id, (p) => {
        const progress: DaggerDownloadProgress = {
          id,
          pct: p.pct ?? 0,
          receivedBytes: p.receivedBytes ?? 0,
          totalBytes: p.totalBytes ?? def.bytes,
        };
        entry.last = progress;
        for (const l of listeners) l(progress);
      }, controller.signal);

      // Size is the cheap integrity check; the sha256 in the catalog is checked
      // by the component path, which has a verify phase to report it in.
      const got = fs.statSync(tmp).size;
      if (got !== def.bytes) {
        throw new Error(`downloaded ${got} bytes, expected ${def.bytes} — the file is incomplete`);
      }
      fs.renameSync(tmp, dest);
      return { ok: true };
    } catch (err) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        error: aborted ? 'Download cancelled'
          : (err instanceof Error ? err.message : String(err)),
      };
    } finally {
      inFlight.delete(id);
    }
  })();

  return entry.promise;
}

export function cancelDaggerModelDownload(id: string): void {
  inFlight.get(id)?.controller.abort();
}

/** Delete a model's GGUF. The server must be stopped first — see dagger-server. */
export function deleteDaggerModel(id: string): { ok: boolean; error?: string } {
  const def = getDaggerModelDef(id);
  if (!def) return { ok: false, error: `Unknown dagger model: ${id}` };
  try {
    const p = path.join(getDaggerModelsDir(), def.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
