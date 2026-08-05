/**
 * blocks-models — the downloadable page-layout (block-category) model.
 *
 * Blocks labels every text block on a page with what it IS (body, chapter
 * opening, running head, footnote, caption, list fragment, …). That is what
 * turns a scanned book into a clean EPUB, so the model is not optional
 * decoration — but it is 8 GB, so it is not bundled either. It downloads
 * through the same component machinery as voices, RVC models and speech-to-text.
 *
 *   Hosting:  huggingface.co/owenmorgan/foundry-models  (direct resolve URLs)
 *   On disk:  FOUNDRY'S models dir — see `getBlocksModelsDir()`
 *   Served by: electron/blocks-server.ts — the BUNDLED llama-server, on the raw
 *              /completion endpoint.
 *
 * ONE COPY ON DISK, SHARED WITH FOUNDRY (Aug 3 2026). The stage models were
 * called rubric / galley / dagger and shipped from BookForge's own HuggingFace
 * repos into the OwenMorgan shared dir; they are now foundry's `blocks` / `ocr` /
 * `footnotes`, published together at owenmorgan/foundry-models and downloaded by
 * `foundry models pull` into foundry's platform data dir. BookForge stopped
 * running the ocr and footnotes models itself — those are foundry passes — and
 * Detect is the last consumer left. It therefore reads the SAME file foundry
 * downloads, at the SAME path, rather than keeping a second 8 GB copy alive under
 * a name only this app used.
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
import * as os from 'os';
import * as path from 'path';

import { downloadFile, sha256File } from './components/downloader';
import { getSharedDir } from './shared-paths';

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

export interface BlocksModelDef {
  /** Stable id. Also the component id suffix and the localStorage value. */
  id: string;
  /** User-facing name. Says what it does, not what it is built from. */
  name: string;
  filename: string;
  url: string;
  sha256: string;
  bytes: number;
  /** GB of RAM the quant comfortably needs, weights + a 12k KV cache. */
  minRAM: number;
  note: string;
  /** Preferred when more than one is installed — higher wins. */
  rank: number;
  /**
   * The prompt format the weights were trained on, DECLARED — never parsed.
   *
   * The old ids carried it (`rubric-v5-4b` → prompt v5) and `blocksVersionFor()`
   * read it back out. A foundry id cannot work that way: its version segment is
   * the RELEASE (`foundry-blocks-v1-4b` is release 1), and release 1 ships the
   * v5 prompt. Parsing that id would silently serve a twelve-class checkpoint the
   * retired sixteen-class prompt — which does not error, it just scores worse and
   * reads like an undertrained model.
   *
   * So the CATALOG answers, the id never does. Same rule foundry's own catalog
   * follows (`FoundryModelDef.promptVersion`); the two must agree, and they are
   * checked against each other by eye whenever either publishes a new blocks
   * checkpoint.
   */
  promptVersion: number;
}

const HF = 'https://huggingface.co/owenmorgan/foundry-models/resolve/main';

/**
 * PUBLISHED Aug 3 2026, by foundry, into owenmorgan/foundry-models. The upload
 * was verified two ways: local sha256 matches `sha256` byte-for-byte, and HF's
 * resolve URL reports `x-linked-size` equal to `bytes`. A catalog entry existing
 * is NOT evidence that a model was published (a cleanup pass once deleted a
 * version's merged weights believing exactly that); check the repo, not this file.
 *
 * ONE ENTRY, DELIBERATELY. The rubric-v3 (Q4_K_M) and rubric-v4 (Q8_0) entries
 * that used to sit below it are gone rather than carried forward:
 *
 *  - They were never published under foundry-models, and re-publishing 2.5 GB and
 *    4.3 GB of superseded weights to keep a menu entry alive is not a trade worth
 *    making.
 *  - They are a DIFFERENT PROMPT (v3/v4 taxonomies, thirteen classes with
 *    `table`), so keeping them means keeping the whole parse-the-version-out-of-
 *    the-id machinery alive against ids that no longer exist in this namespace.
 *  - v5 — which is what this entry is — labels a whole page exactly right 79% of
 *    the time against v4's 57% on the same split.
 *
 * Nothing deletes the old GGUFs: they stay in the OwenMorgan shared dir where
 * they were downloaded, invisible to this app, for the user to remove if they
 * want the disk back.
 */
export const BLOCKS_MODELS: BlocksModelDef[] = [
  {
    id: 'foundry-blocks-v1-4b',
    name: 'Page layout model',
    // f16, NOT a quant, and BYTE-IDENTICAL to the rubric-v5-4b-f16.gguf this
    // path served before the rename — same 8,051,285,248 bytes, same sha256,
    // uploaded rather than re-quantized. v4's scoring measured Q8_0 as costing
    // nothing and Q4_K_M as costing more than the whole v3→v4 gain, so a quant
    // is a decision to be made with evidence rather than by habit — and this
    // checkpoint has not been scored under one.
    filename: 'foundry-blocks-v1-4b.gguf',
    url: `${HF}/foundry-blocks-v1-4b.gguf`,
    sha256: '4b991fca888de5cf5926d15d67b4eac979fda16fb9d3078ffdcd9f816b7e9a9a',
    bytes: 8051285248,
    // 8.1 GB of weights plus a 12288 KV cache, with headroom for the compute
    // buffers. Twice v4's, which is the price of not quantizing.
    minRAM: 16,
    note: 'Labels each block on a page — body, chapter opening, running head, '
      + 'footnote, caption — so exports keep the prose and drop the furniture. '
      + 'Merges `table` into `list`, and labels a whole page exactly right far '
      + 'more often than the version before it (79% against 57% on the same split).',
    rank: 100,
    // Release v1 of a v5 PROMPT. See BlocksModelDef.promptVersion.
    promptVersion: 5,
  },
];

export function getBlocksModelDef(id: string): BlocksModelDef | undefined {
  return BLOCKS_MODELS.find((m) => m.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Location
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The models dir — FOUNDRY'S, matching `src/models/paths.ts` in the foundry
 * repo exactly:
 *
 *   macOS:   ~/Library/Application Support/foundry/models
 *   Windows: %LOCALAPPDATA%\\foundry\\models   (Local, not Roaming — too big to roam)
 *   Linux:   $XDG_DATA_HOME/foundry/models  or  ~/.local/share/foundry/models
 *
 * Duplicated here rather than imported because foundry is a separate binary with
 * its own repo and its own release cadence — BookForge cannot `import` from it.
 * The derivation is small and stable; if foundry ever moves its models dir, this
 * function moves with it, and the symptom of getting it wrong is loud (Detect
 * reports the model is not downloaded while `foundry models list` says it is).
 *
 * NOT the OwenMorgan shared dir any more. That is BookForge's cross-app location
 * and it is where the old `rubric-models/` GGUFs still sit; this app now reads
 * the copy foundry manages, so `foundry models pull foundry-blocks-v1-4b` and
 * Settings → Add-ons put the SAME 8 GB in the SAME place instead of two.
 *
 * Overridable for tests and odd installs. Nothing stores an absolute path to a
 * model — a model is always referenced by id and resolved here — so the dir can
 * move without invalidating anything.
 */
export function getBlocksModelsDir(): string {
  const override = process.env.BOOKFORGE_BLOCKS_MODELS_DIR?.trim();
  if (override) {
    fs.mkdirSync(override, { recursive: true });
    return override;
  }
  const home = os.homedir();
  let dir: string;
  if (process.platform === 'darwin') {
    dir = path.join(home, 'Library', 'Application Support', 'foundry', 'models');
  } else if (process.platform === 'win32') {
    // LOCALAPPDATA is set on every supported Windows; the fallback reconstructs
    // the same directory it points at rather than substituting a different one.
    const local = process.env['LOCALAPPDATA']?.trim() || path.join(home, 'AppData', 'Local');
    dir = path.join(local, 'foundry', 'models');
  } else {
    const dataHome = process.env['XDG_DATA_HOME']?.trim() || path.join(home, '.local', 'share');
    dir = path.join(dataHome, 'foundry', 'models');
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The pre-rename copy of this exact checkpoint, if the user already has it.
 *
 * `<OwenMorgan shared>/rubric-models/rubric-v5-4b-f16.gguf` and
 * `<foundry models>/foundry-blocks-v1-4b.gguf` are the SAME BYTES — same sha256,
 * same size — so someone who downloaded the model before Aug 3 2026 should not be
 * asked for 8 GB again to get a file they have.
 *
 * A HARDLINK, so nothing is moved, copied or deleted: the old file stays exactly
 * where it is, and the user can remove either name later without losing the data
 * until both are gone. Size is checked first — a truncated legacy download must
 * not be adopted as a whole model — and failure is reported, never swallowed: if
 * the link cannot be made (different volume, no permission) the download runs
 * normally. This is an explicit one-time adoption, NOT a lookup fallback: nothing
 * else ever reads the legacy path.
 */
function adoptLegacyBlocksModel(def: BlocksModelDef, dest: string): boolean {
  if (def.id !== 'foundry-blocks-v1-4b') return false;
  let legacy: string;
  try {
    legacy = path.join(getSharedDir(), 'rubric-models', 'rubric-v5-4b-f16.gguf');
  } catch {
    return false;
  }
  try {
    if (fs.statSync(legacy).size !== def.bytes) return false;
  } catch {
    return false;
  }
  try {
    fs.linkSync(legacy, dest);
    console.log(`[BLOCKS] adopted the existing page-layout model: ${legacy} -> ${dest}`);
    return true;
  } catch (err) {
    console.warn(`[BLOCKS] could not hardlink ${legacy} to ${dest} `
      + `(${err instanceof Error ? err.message : String(err)}); downloading instead.`);
    return false;
  }
}

/** Absolute path to a model's GGUF (may not exist yet). */
export function blocksModelPath(id: string): string {
  const def = getBlocksModelDef(id);
  if (!def) throw new Error(`Unknown blocks model: ${id}`);
  return path.join(getBlocksModelsDir(), def.filename);
}

/**
 * Present when the GGUF is on disk at its full expected size.
 *
 * Size-checked, not just existence-checked: an interrupted download that got
 * renamed into place (or a half-synced file) would otherwise read as installed
 * and llama-server would fail to load it with a message about the file format,
 * which sends the user looking in entirely the wrong place.
 */
export function isBlocksModelPresent(id: string): boolean {
  const def = getBlocksModelDef(id);
  if (!def) return false;
  const dest = path.join(getBlocksModelsDir(), def.filename);
  try {
    if (fs.statSync(dest).size === def.bytes) return true;
    return false;
  } catch {
    // Not there under foundry's name. It may still be on this machine under the
    // pre-rename one — adopt it once rather than re-download 8 GB.
    return adoptLegacyBlocksModel(def, dest);
  }
}

export interface BlocksModelStatus extends BlocksModelDef {
  present: boolean;
  path: string;
}

export function listBlocksModels(): BlocksModelStatus[] {
  const dir = getBlocksModelsDir();
  return BLOCKS_MODELS.map((m) => ({
    ...m,
    present: isBlocksModelPresent(m.id),
    path: path.join(dir, m.filename),
  }));
}

/** The best installed model, or null. What Detect defaults to. */
export function bestInstalledBlocksModel(): BlocksModelStatus | null {
  const installed = listBlocksModels().filter((m) => m.present);
  if (!installed.length) return null;
  return installed.sort((a, b) => b.rank - a.rank)[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// Download
// ─────────────────────────────────────────────────────────────────────────────

export interface BlocksDownloadProgress {
  id: string;
  pct: number;
  receivedBytes: number;
  totalBytes: number;
}

interface InFlight {
  promise: Promise<{ ok: boolean; error?: string }>;
  controller: AbortController;
  listeners: Set<(p: BlocksDownloadProgress) => void>;
  last?: BlocksDownloadProgress;
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
export function downloadBlocksModel(
  id: string,
  onProgress?: (p: BlocksDownloadProgress) => void,
): Promise<{ ok: boolean; error?: string }> {
  const def = getBlocksModelDef(id);
  if (!def) return Promise.resolve({ ok: false, error: `Unknown blocks model: ${id}` });
  if (isBlocksModelPresent(id)) return Promise.resolve({ ok: true });

  const running = inFlight.get(id);
  if (running) {
    if (onProgress) {
      running.listeners.add(onProgress);
      if (running.last) onProgress(running.last);
    }
    return running.promise;
  }

  const listeners = new Set<(p: BlocksDownloadProgress) => void>();
  if (onProgress) listeners.add(onProgress);
  const controller = new AbortController();
  const entry: InFlight = { promise: Promise.resolve({ ok: true }), controller, listeners };
  inFlight.set(id, entry);

  const dir = getBlocksModelsDir();
  const dest = path.join(dir, def.filename);
  const tmp = `${dest}.download`;

  entry.promise = (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (adoptLegacyBlocksModel(def, dest)) return { ok: true };
      // A stale partial from a previous run: start clean rather than append.
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }

      await downloadFile(def.url, tmp, id, (p) => {
        const progress: BlocksDownloadProgress = {
          id,
          pct: p.pct ?? 0,
          receivedBytes: p.receivedBytes ?? 0,
          totalBytes: p.totalBytes ?? def.bytes,
        };
        entry.last = progress;
        for (const l of listeners) l(progress);
      }, controller.signal);

      // Size first, because it is instant and catches the common failure — a
      // truncated transfer — before spending minutes hashing eight gigabytes.
      const got = fs.statSync(tmp).size;
      if (got !== def.bytes) {
        throw new Error(`downloaded ${got} bytes, expected ${def.bytes} — the file is incomplete`);
      }

      // Then the hash, which is the actual check. This comment used to say the
      // sha256 was "checked by the component path, which has a verify phase to
      // report it in" — it is not: `fetchBlocksModel` in component-manager.ts IS
      // that path, and it verifies nothing either. So a right-sized file from
      // anywhere was adopted as the model. The digest is declared in the catalog
      // above, was verified two ways when it was published, and is the only
      // thing that distinguishes these bytes from any other bytes of the same
      // length.
      console.log(`[blocks-models] ${id}: verifying sha256 of ${got} bytes…`);
      const digest = await sha256File(tmp);
      if (digest.toLowerCase() !== def.sha256.toLowerCase()) {
        throw new Error(
          `the downloaded model is not the published one: expected sha256 ${def.sha256}, `
          + `got ${digest}. Nothing was installed.`
        );
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

export function cancelBlocksModelDownload(id: string): void {
  inFlight.get(id)?.controller.abort();
}

/**
 * Delete a model's GGUF.
 *
 * The server must be stopped first — see blocks-server. This unlinks the name in
 * FOUNDRY'S models dir, which is the copy foundry also uses: removing the
 * page-layout model from Settings → Add-ons is the same act as
 * `foundry models remove foundry-blocks-v1-4b`, and that is the point of there
 * being one copy. A legacy `rubric-models/` file adopted by hardlink survives —
 * only this name goes.
 */
export function deleteBlocksModel(id: string): { ok: boolean; error?: string } {
  const def = getBlocksModelDef(id);
  if (!def) return { ok: false, error: `Unknown blocks model: ${id}` };
  try {
    const p = path.join(getBlocksModelsDir(), def.filename);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
