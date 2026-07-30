/**
 * rubric-models — the downloadable block-category model.
 *
 * Rubric labels every text block on a page with what it IS (body, chapter
 * opening, running head, footnote, caption, table fragment, …). That is what
 * turns a scanned book into a clean EPUB, so the model is not optional
 * decoration — but it is 2.5 GB, so it is not bundled either. It downloads
 * through the same component machinery as voices, RVC models and speech-to-text.
 *
 *   Hosting:  huggingface.co/owenmorgan/bookforge-rubric  (direct resolve URLs)
 *   On disk:  <OwenMorgan shared>/rubric-models/<filename>.gguf
 *   Served by: electron/rubric-server.ts — the BUNDLED llama-server, on the raw
 *              /completion endpoint.
 *
 * NOT Ollama. Detect used to require the user to have Ollama installed and to
 * have imported the model into it by hand, which is not a thing to ask of
 * someone who wants to make an audiobook. llama-server already ships for local
 * AI cleanup (llama-bridge.ts), it takes a GGUF path directly, and its
 * /completion endpoint sends the prompt VERBATIM — which this model requires,
 * because it was trained under Qwen3's template with thinking disabled and a
 * server that re-templates feeds it a shape it never saw.
 *
 * A plain HTTP fetch, deliberately: whisper models come down via
 * huggingface_hub in the bundled Python env, but a single GGUF needs no Python
 * at all, and Detect should not fail because a TTS env is missing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

import { downloadFile } from './components/downloader';
import { migrateLegacyDir } from './shared-paths';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export interface RubricModelDef {
  /** Stable id. Also the component id suffix and the localStorage value. */
  id: string;
  /** User-facing name. Says what it does, not what it is built from. */
  name: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  /** GB of RAM the quant comfortably needs, weights + an 8k KV cache. */
  minRAM: number;
  note: string;
  /** Preferred when more than one is installed — higher wins. */
  rank: number;
}

const HF = 'https://huggingface.co/owenmorgan/bookforge-rubric/resolve/main';

/**
 * THE MODEL NAME IS LOAD-BEARING. `rubricVersionFor()` in the encoder reads
 * v1/v2/v3/v4 out of the id to pick the prompt format and the legal class list.
 * v1 and v2 were trained on different prompt shapes and on a taxonomy that
 * still had the positional front_matter/back_matter classes, so an id without a
 * version reads as v1 and gets a prompt advertising classes the checkpoint
 * never saw — which looks exactly like a bad model.
 *
 * Adding v4 here required adding the matching branch to `rubricVersionFor()`
 * FIRST: before that, `rubric-v4-4b` fell through every test and read as v1, so
 * shipping it would have served a v3-taxonomy model the retired sixteen-class
 * prompt. v4 shares v3's prompt and taxonomy exactly — what changed is the OCR
 * segmentation — but the version still has to be declared in both places.
 */
export const RUBRIC_MODELS: RubricModelDef[] = [
  {
    id: 'rubric-v4-4b',
    name: 'Page layout model',
    filename: 'rubric-v4-4b-Q8_0.gguf',
    url: `${HF}/rubric-v4-4b-Q8_0.gguf`,
    sha256: '441a5c88737a5592661c44d7e9f5e8c2fd65bb87926944e76b3cb2472f0fbb48',
    bytes: 4280405344,
    minRAM: 8,
    note: 'Labels each block on a page — body, chapter opening, running head, '
      + 'footnote, caption, table — so exports keep the prose and drop the '
      + 'furniture. Trained on the split-only segmentation; it labels a page '
      + 'exactly right about twice as often as v3.',
    rank: 40,
  },
  {
    id: 'rubric-v3-4b',
    name: 'Page layout model',
    filename: 'rubric-v3-4b-Q4_K_M.gguf',
    url: `${HF}/rubric-v3-4b-Q4_K_M.gguf`,
    sha256: '18d2aa19e7aaf98cf940b114bdca8015bfb118d06f38f7e21a017aa3c0b54c9a',
    bytes: 2497280864,
    minRAM: 6,
    note: 'Labels each block on a page — body, chapter opening, running head, '
      + 'footnote, caption, table — so exports keep the prose and drop the furniture.',
    rank: 30,
  },
];

export function getRubricModelDef(id: string): RubricModelDef | undefined {
  return RUBRIC_MODELS.find((m) => m.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Location
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The models dir: `<OwenMorgan shared>/rubric-models`.
 *
 * Shared rather than per-app for the same reason the Cogito GGUFs are (see
 * llama-bridge.ts getModelsDir): weights are large and identical across
 * OwenMorgan apps. `migrateLegacyDir` moves a pre-existing per-app copy once, so
 * an upgrade does not re-download 2.5 GB.
 *
 * Overridable for tests and odd installs. Nothing stores an absolute path to a
 * model — a model is always referenced by id and resolved here — so the dir can
 * move without invalidating anything.
 */
export function getRubricModelsDir(): string {
  const override = process.env.BOOKFORGE_RUBRIC_MODELS_DIR?.trim();
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  return migrateLegacyDir(path.join(app.getPath('userData'), 'rubric-models'), 'rubric-models');
}

/** Absolute path to a model's GGUF (may not exist yet). */
export function rubricModelPath(id: string): string {
  const def = getRubricModelDef(id);
  if (!def) throw new Error(`Unknown rubric model: ${id}`);
  return path.join(getRubricModelsDir(), def.filename);
}

/**
 * Present when the GGUF is on disk at its full expected size.
 *
 * Size-checked, not just existence-checked: an interrupted download that got
 * renamed into place (or a half-synced file) would otherwise read as installed
 * and llama-server would fail to load it with a message about the file format,
 * which sends the user looking in entirely the wrong place.
 */
export function isRubricModelPresent(id: string): boolean {
  const def = getRubricModelDef(id);
  if (!def) return false;
  try {
    return fs.statSync(path.join(getRubricModelsDir(), def.filename)).size === def.bytes;
  } catch {
    return false;
  }
}

export interface RubricModelStatus extends RubricModelDef {
  present: boolean;
  path: string;
}

export function listRubricModels(): RubricModelStatus[] {
  const dir = getRubricModelsDir();
  return RUBRIC_MODELS.map((m) => ({
    ...m,
    present: isRubricModelPresent(m.id),
    path: path.join(dir, m.filename),
  }));
}

/** The best installed model, or null. What Detect defaults to. */
export function bestInstalledRubricModel(): RubricModelStatus | null {
  const installed = listRubricModels().filter((m) => m.present);
  if (!installed.length) return null;
  return installed.sort((a, b) => b.rank - a.rank)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

export interface RubricDownloadProgress {
  id: string;
  pct: number;
  receivedBytes: number;
  totalBytes: number;
}

interface InFlight {
  promise: Promise<{ ok: boolean; error?: string }>;
  controller: AbortController;
  listeners: Set<(p: RubricDownloadProgress) => void>;
  last?: RubricDownloadProgress;
}
const inFlight = new Map<string, InFlight>();

/**
 * Download a model into its dir.
 *
 * Idempotent, and concurrent callers JOIN rather than race: the Settings panel,
 * the setup page's download dock and a Detect run that found no model can all
 * ask at once, and two `downloadFile`s into one path would interleave bytes.
 * Downloads to `<name>.download` and renames only on success, so an interrupted
 * one can never be mistaken for an installed model.
 */
export function downloadRubricModel(
  id: string,
  onProgress?: (p: RubricDownloadProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const def = getRubricModelDef(id);
  if (!def) return Promise.resolve({ ok: false, error: `Unknown rubric model: ${id}` });
  if (isRubricModelPresent(id)) return Promise.resolve({ ok: true });

  const running = inFlight.get(id);
  if (running) {
    if (onProgress) {
      running.listeners.add(onProgress);
      if (running.last) onProgress(running.last);
    }
    return running.promise;
  }

  const listeners = new Set<(p: RubricDownloadProgress) => void>();
  if (onProgress) listeners.add(onProgress);
  const controller = new AbortController();
  const entry: InFlight = { promise: Promise.resolve({ ok: true }), controller, listeners };
  inFlight.set(id, entry);

  const dir = getRubricModelsDir();
  const dest = path.join(dir, def.filename);
  const tmp = `${dest}.download`;

  entry.promise = (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // A stale partial from a previous run: start clean rather than append.
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }

      await downloadFile(def.url, tmp, id, (p) => {
        const progress: RubricDownloadProgress = {
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

export function cancelRubricModelDownload(id: string): void {
  inFlight.get(id)?.controller.abort();
}

/** Delete a model's GGUF. The server must be stopped first — see rubric-server. */
export function deleteRubricModel(id: string): { ok: boolean; error?: string } {
  const def = getRubricModelDef(id);
  if (!def) return { ok: false, error: `Unknown rubric model: ${id}` };
  try {
    const p = path.join(getRubricModelsDir(), def.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
