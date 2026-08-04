/**
 * Orpheus voice CATALOG, sourced from a HuggingFace account.
 *
 * The single source of truth for "what voices exist" is the user's HF account:
 * any repo tagged `bookforge-orpheus-voice` (in its model-card metadata) is offered
 * as a downloadable voice. The card also carries the one thing we can't infer — the
 * prompt `orpheus_token` the model was fine-tuned on — plus an optional label and
 * sample rate. "Upload to HF (with the tag) = available in BookForge."
 *
 * Installing downloads the repo into the local models dir (on Windows+WSL the
 * download runs INSIDE WSL so it lands on ext4, not the slow /mnt/c mount) and
 * writes a models.json manifest entry (orpheus-models.ts). The installed manifest
 * is the offline cache; this module is only about the remote catalogue + fetching.
 */

import { spawn } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getConfig, updateConfig } from './tool-paths';
import {
  getDefaultE2aPath,
  getPythonInvocation,
  buildCondaSpawnEnv,
  shouldUseWsl2ForOrpheus,
  getWslDistro,
  getWslCondaPath,
  getWslE2aPath,
  getWslOrpheusCondaEnv,
  windowsToWslPath,
} from './e2a-paths';
import {
  getOrpheusModelsDir,
  upsertManifestEntry,
  removeManifestEntry,
  listOrpheusModels,
  readManifest,
  resolveOrpheusBase,
  orpheusBaseFolderName,
  ADAPTERS_SUBDIR,
  BASE_SUBDIR,
  type OrpheusArtifact,
  type OrpheusBaseRef,
} from './orpheus-models';

/** Built-in Orpheus voice sources (HF repo ids), offered by default so voices are
 *  available with zero configuration. Users add/remove more in Settings. Each
 *  repo's model card carries the prompt token + label we read below.
 *
 *  The list is loaded from a shipped JSON data file (electron/data/) rather than
 *  hardcoded here. The file is copied next to this module in the dist build
 *  (build:electron `shx cp -r electron/data`), so it resolves relative to __dirname
 *  — the same way prompts do. A missing/unparseable file is a PACKAGING bug and
 *  MUST fail loud (no silent fallback to an inline default). */
function loadDefaultOrpheusSources(): string[] {
  const dataPath = path.join(__dirname, 'data', 'orpheus-voice-sources.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to load built-in Orpheus voice sources from ${dataPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
    throw new Error(`Built-in Orpheus voice sources data file is malformed (expected string[]): ${dataPath}`);
  }
  return parsed;
}

export const DEFAULT_ORPHEUS_SOURCES: string[] = loadDefaultOrpheusSources();

/** The active source list: the user's configured repos, or the built-in defaults. */
export function getOrpheusSources(): string[] {
  const cfg = getConfig().orpheusVoiceSources;
  return Array.isArray(cfg) ? [...cfg] : [...DEFAULT_ORPHEUS_SOURCES];
}

/** Parse a user-entered source into a bare HF repo id ("owner/name"). Accepts a
 *  full URL (huggingface.co/owner/name[/tree/…]) or a bare id. Null if unparseable. */
export function normalizeRepoId(input: string): string | null {
  let s = (input || '').trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/(www\.)?(huggingface\.co|hf\.co)\//i, '');
  s = s.replace(/^\/+/, '').replace(/\/+$/, '');
  s = s.replace(/\/(tree|resolve|blob)\/.*$/i, ''); // strip a trailing /tree/main etc.
  return /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/.test(s) ? s : null;
}

export function addOrpheusSource(input: string): { success: boolean; error?: string; repoId?: string; sources?: string[] } {
  const repoId = normalizeRepoId(input);
  if (!repoId) return { success: false, error: `"${input}" isn't a valid HuggingFace repo (expected owner/name).` };
  const list = getOrpheusSources();
  if (!list.includes(repoId)) list.push(repoId);
  updateConfig({ orpheusVoiceSources: list });
  return { success: true, repoId, sources: list };
}

export function removeOrpheusSource(repoId: string): string[] {
  const list = getOrpheusSources().filter((s) => s !== repoId);
  updateConfig({ orpheusVoiceSources: list });
  return list;
}

export interface OrpheusCatalogEntry {
  /** Full HF repo id, e.g. "owenmorgan/owen-morgan-orpheus-3b". */
  repoId: string;
  /** Local id / folder name (the repo's short name). */
  id: string;
  /** Prompt token the model was fine-tuned on (from card `orpheus_token`). */
  token: string;
  /** Display label. */
  label: string;
  sampleRate: number;
  private: boolean;
  /** Already present in the local manifest/folder. */
  installed: boolean;
  /** The local folder/manifest id when installed (may differ from `id` — e.g. the
   *  folder is `deathstalker` while the repo short-name is `deathstalker-orpheus-3b`).
   *  Uninstall must target THIS, not the catalog id. Absent when not installed. */
  installedId?: string;
  /**
   * What this repo ships, read from the card's `orpheus_artifact` key. ABSENT on the
   * card ⇒ `'merged'`, so every existing voice repo keeps its exact meaning and the
   * whole migration stays additive.
   */
  artifact: OrpheusArtifact;
  /** The shared base an adapter voice needs (card `orpheus_base`). Adapter repos only. */
  base?: OrpheusBaseRef;
  /** True for an adapter voice whose shared base is not installed yet — the UI
   *  disables Download and says so, because installing the adapter alone is useless. */
  needsBase?: boolean;
  /** Rough download size in bytes, for the UI ("0.4 GB" vs "6.6 GB"). Nominal per
   *  artifact kind, not a HEAD of every file — it exists to set expectations. */
  approxSizeBytes: number;
}

/**
 * Nominal artifact sizes for the UI. MEASURED on the deployed voices: an r=64 LoRA
 * over the 7 attention/MLP projections is 389,074,464 bytes (~0.39 GB) and a merged
 * Orpheus-3B fine-tune is ~6.6 GB across two bf16 shards. The shared base is a
 * one-time ~6.6 GB that all adapters then reuse.
 */
const ADAPTER_APPROX_BYTES = 0.4 * 1024 ** 3;
const MERGED_APPROX_BYTES = 6.6 * 1024 ** 3;
export const ORPHEUS_BASE_APPROX_BYTES = MERGED_APPROX_BYTES;

/**
 * The DEFAULT shared base for adapter voices. A card that declares `orpheus_base`
 * wins; this is what an adapter repo that forgot the key resolves to, and it is also
 * the base the "Base model" card in Settings installs when no adapter voice has
 * declared anything else yet. It is a REAL, public repo id — not a placeholder.
 */
export const DEFAULT_ORPHEUS_BASE: OrpheusBaseRef = {
  id: 'orpheus-3b-base',
  ref: 'unsloth/orpheus-3b-0.1-ft',
};

/** Parse a card's `orpheus_base` value ("unsloth/orpheus-3b-0.1-ft") into a base ref. */
function baseRefFromCard(meta: Record<string, string>): OrpheusBaseRef | undefined {
  const ref = (meta.orpheus_base || '').trim();
  if (!ref) return undefined;
  return { id: DEFAULT_ORPHEUS_BASE.id, ref };
}

/** A card's `orpheus_artifact` value. Anything other than "adapter" — including an
 *  absent key — means merged, which is the pre-migration meaning of every card. */
function artifactFromCard(meta: Record<string, string>): OrpheusArtifact {
  return (meta.orpheus_artifact || '').trim().toLowerCase() === 'adapter' ? 'adapter' : 'merged';
}

/** Is this base installed? Listing-safe: a WSL-down throw becomes "not installed"
 *  for the CATALOG view only (the render path still throws — see orpheus-models). */
function isBaseRefInstalled(base: OrpheusBaseRef): boolean {
  try {
    return resolveOrpheusBase(base) !== null;
  } catch {
    return false;
  }
}

/** Status of the shared base model, for the Settings "Base model" card + the wizard. */
export interface OrpheusBaseStatus {
  /** The base every adapter voice in the current catalog needs. */
  base: OrpheusBaseRef;
  installed: boolean;
  /** False when the install is a symlink this process can't traverse (normal on
   *  Windows, where the base is a link into the WSL HuggingFace cache). */
  verified: boolean;
  /** Absolute path when installed. */
  dir?: string;
  approxSizeBytes: number;
  /** True when at least one configured source repo is an adapter voice, i.e. the base
   *  is actually needed on this machine. */
  required: boolean;
}

/**
 * Which base the machine needs and whether it's there. `required` is computed from
 * the CATALOG (a network read), so callers that only want the local answer can pass
 * a pre-fetched catalog in.
 */
export async function getOrpheusBaseStatus(catalog?: OrpheusCatalogEntry[]): Promise<OrpheusBaseStatus> {
  const entries = catalog ?? (await fetchOrpheusCatalog());
  const adapters = entries.filter((e) => e.artifact === 'adapter');
  const base = adapters.find((e) => e.base)?.base ?? DEFAULT_ORPHEUS_BASE;
  let resolved: { dir: string; verified: boolean } | null = null;
  try {
    resolved = resolveOrpheusBase(base);
  } catch {
    resolved = null; // WSL down — report "not installed" rather than failing the panel
  }
  return {
    base,
    installed: resolved !== null,
    verified: resolved?.verified ?? false,
    ...(resolved ? { dir: resolved.dir } : {}),
    approxSizeBytes: ORPHEUS_BASE_APPROX_BYTES,
    required: adapters.length > 0,
  };
}

// ── credentials / account ─────────────────────────────────────────────────────

/** Resolve an HF token: Settings → env HF_TOKEN → ~/.config/bookforge/hf-*.token →
 *  ~/.cache/huggingface/token. The bookforge token file lets the built-in default
 *  (private) voice repos resolve out of the box on the owner's machines; it's
 *  simply absent elsewhere. */
export function getHfToken(): string | null {
  const fromSettings = getConfig().huggingFaceToken?.trim();
  if (fromSettings) return fromSettings;
  const fromEnv = process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const files = [
    path.join(os.homedir(), '.config', 'bookforge', 'hf-owenmorgan.token'),
    path.join(os.homedir(), '.cache', 'huggingface', 'token'),
  ];
  for (const f of files) {
    try {
      const t = fs.readFileSync(f, 'utf-8').trim();
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  return null;
}

function prettyFromId(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/\borpheus\b/gi, '')
    .replace(/\b3b\b/gi, '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── catalogue fetch ───────────────────────────────────────────────────────────

/** Minimal YAML-frontmatter parse for the few flat keys we read off a README. */
function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

async function fetchCardMeta(
  repoId: string,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`https://huggingface.co/${repoId}/raw/${branch}/README.md`, { headers });
      if (res.ok) return parseFrontmatter(await res.text());
    } catch {
      /* try next branch */
    }
  }
  return {};
}

/**
 * The downloadable voice catalogue: resolve every configured source repo (or the
 * built-in defaults) to a voice by reading its model card. A repo without an
 * `orpheus_token` on its card isn't a usable voice and is skipped. Repos are
 * resolved concurrently; a single unreachable/invalid one never fails the list.
 */
export async function fetchOrpheusCatalog(): Promise<OrpheusCatalogEntry[]> {
  const token = getHfToken();
  const headers: Record<string, string> = { 'User-Agent': 'BookForge' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // "Installed?" is keyed by the SOURCE repo, not the folder id. listOrpheusModels
  // only exposes the folder id — which for our voices is the prompt token / folder
  // name ("deathstalker"), NOT the repo short-name the catalog uses
  // ("deathstalker-orpheus-3b") — so an id-vs-id compare never matches and every
  // installed voice mis-renders as "Available". Match on the manifest's recorded
  // source.ref (the exact HF repo) instead, with id-match kept as a fallback for
  // hand-dropped folders that happen to be named after the repo short-name.
  const installedModels = listOrpheusModels();
  const installedIds = new Set(installedModels.map((m) => m.id));
  // repo ref → the local folder id it was installed as, so Uninstall can target the
  // right folder even when it differs from the catalog's repo-short-name id.
  const localIdByRepoRef = new Map<string, string>();
  for (const e of readManifest().models) {
    if (installedIds.has(e.id) && e.source?.ref) localIdByRepoRef.set(e.source.ref, e.id);
  }

  const resolved = await Promise.all(
    getOrpheusSources().map(async (repoId): Promise<OrpheusCatalogEntry | null> => {
      try {
        const meta = await fetchCardMeta(repoId, headers);
        const voiceToken = (meta.orpheus_token || '').trim();
        if (!voiceToken) return null; // not a usable voice without its prompt token
        const id = repoId.split('/').pop()!;
        // Best-effort private flag from the model-info endpoint.
        let isPrivate = false;
        try {
          const info = await fetch(`https://huggingface.co/api/models/${repoId}`, { headers });
          if (info.ok) isPrivate = !!(await info.json()).private;
        } catch { /* ignore */ }
        // Installed if the manifest records this repo as a source, or (fallback for
        // hand-dropped folders) a folder is named after the repo short-name.
        const localId = localIdByRepoRef.get(repoId) ?? (installedIds.has(id) ? id : undefined);
        const artifact = artifactFromCard(meta);
        // An adapter card SHOULD declare its base; one that doesn't gets the single
        // shared base every Orpheus LoRA in this system is trained against. This is not
        // a silent substitution — the resolved ref is what the UI shows and what the
        // manifest records, so a mismatch surfaces as a loud e2a load error, not as
        // subtly wrong audio.
        const base = artifact === 'adapter' ? (baseRefFromCard(meta) ?? DEFAULT_ORPHEUS_BASE) : undefined;
        const baseInstalled = base ? isBaseRefInstalled(base) : true;
        return {
          repoId,
          id,
          token: voiceToken,
          label: (meta.label || '').trim() || prettyFromId(id),
          sampleRate: Number(meta.sample_rate) || 24000,
          private: isPrivate,
          installed: localId !== undefined,
          installedId: localId,
          artifact,
          ...(base ? { base } : {}),
          ...(base && !baseInstalled ? { needsBase: true as const } : {}),
          approxSizeBytes: artifact === 'adapter' ? ADAPTER_APPROX_BYTES : MERGED_APPROX_BYTES,
        };
      } catch {
        return null;
      }
    }),
  );
  return resolved
    .filter((e): e is OrpheusCatalogEntry => e !== null)
    .sort((a, b) => a.label.localeCompare(b.label));
}

// ── install (download) ────────────────────────────────────────────────────────

/** Translate the models dir to the path the (possibly WSL) download will write to. */
function modelsDirForSpawn(viaWsl: boolean): string {
  const dir = getOrpheusModelsDir();
  if (!viaWsl) return dir;
  const norm = dir.replace(/\\/g, '/');
  const unc = norm.match(/^\/\/wsl[$.](?:localhost)?\/[^/]+\/(.*)/);
  if (unc) return '/' + unc[1];
  return windowsToWslPath(dir);
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Run orpheus_download.py (WSL-native on Windows, else native env) → parsed result. */
/** Locate orpheus_download.py across dev (electron/scripts) and packaged (dist) layouts. */
function resolveDownloadScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'orpheus_download.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'orpheus_download.py'),
    path.join(__dirname, 'scripts', 'orpheus_download.py'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || candidates[candidates.length - 1];
}

/** What the downloader is fetching, and hence where it lands + how it's validated. */
type DownloadKind = 'merged' | 'adapter' | 'base';

/**
 * The path a download of `kind` writes to, in the spawn's own path flavour (native
 * Windows/POSIX, or WSL-native when the download runs inside WSL).
 *
 *   merged   <models>/<id>
 *   adapter  <models>/adapters/<id>
 *   base     <models>/_base/<id>
 *
 * The merged case is byte-identical to what this function did before.
 */
function destForKind(kind: DownloadKind, id: string, viaWsl: boolean): string {
  const sep = viaWsl ? '/' : path.sep;
  const root = modelsDirForSpawn(viaWsl);
  if (kind === 'adapter') return `${root}${sep}${ADAPTERS_SUBDIR}${sep}${id}`;
  if (kind === 'base') return `${root}${sep}${BASE_SUBDIR}${sep}${id}`;
  return `${root}${sep}${id}`;
}

function runDownload(
  repoId: string,
  id: string,
  token: string | null,
  kind: DownloadKind = 'merged',
): Promise<{ ok: boolean; error?: string }> {
  const scriptPath = resolveDownloadScript();

  const viaWsl = process.platform === 'win32' && shouldUseWsl2ForOrpheus();
  const destDir = destForKind(kind, id, viaWsl);

  return new Promise((resolve) => {
    let command: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;

    if (viaWsl) {
      const distro = getWslDistro();
      const wslConda = getWslCondaPath();
      const wslE2a = getWslE2aPath();
      const orpheusEnv = getWslOrpheusCondaEnv();
      const scriptWsl = windowsToWslPath(scriptPath);
      const exportTok = token ? `export HF_TOKEN=${shellQuote(token)} && ` : '';
      const bash =
        `${exportTok}cd ${shellQuote(wslE2a)} && ` +
        `${shellQuote(wslConda)} run --no-capture-output -n ${shellQuote(orpheusEnv)} ` +
        `python -u ${shellQuote(scriptWsl)} ${shellQuote(repoId)} ${shellQuote(destDir)} --kind ${shellQuote(kind)}`;
      command = 'wsl.exe';
      args = distro ? ['-d', distro, 'bash', '-c', bash] : ['bash', '-c', bash];
      env = process.env;
    } else {
      const py = getPythonInvocation(getDefaultE2aPath(), 'orpheus');
      command = py.command;
      args = [...py.args, '-u', scriptPath, repoId, destDir, '--kind', kind];
      env = buildCondaSpawnEnv(token ? { HF_TOKEN: token } : {});
    }

    const child = spawn(command, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', () => {
      // The script prints a single JSON line; find the last JSON object in stdout.
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (typeof parsed.ok === 'boolean') return resolve(parsed);
        } catch {
          /* not JSON */
        }
      }
      resolve({ ok: false, error: stderr.trim().slice(-400) || 'download produced no result' });
    });
  });
}

/** Two-phase install progress. Phase 'base' only ever fires on the FIRST adapter
 *  install of a machine's life — after that the base is already there and the
 *  install is a single ~0.4 GB step. */
export interface OrpheusInstallProgress {
  repoId: string;
  phase: 'base' | 'voice';
  message: string;
}
export type OrpheusInstallProgressFn = (p: OrpheusInstallProgress) => void;

/**
 * Download the ONE shared base model into `<models>/_base/<short-name>` and record a
 * `kind: 'base'` manifest entry. Idempotent: an already-installed base returns
 * success without re-downloading (6.6 GB), which is what makes the two-phase adapter
 * install cheap from the second voice onward.
 */
export async function installOrpheusBase(
  base: OrpheusBaseRef = DEFAULT_ORPHEUS_BASE,
): Promise<{ success: boolean; error?: string; alreadyInstalled?: boolean }> {
  const folder = orpheusBaseFolderName(base);
  try {
    if (resolveOrpheusBase(base)) return { success: true, alreadyInstalled: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const result = await runDownload(base.ref, folder, getHfToken(), 'base');
  if (!result.ok) return { success: false, error: result.error || 'base model download failed' };
  try {
    upsertManifestEntry({
      id: base.id,
      label: 'Orpheus 3B (shared base model)',
      // A base is never prompted, so it has no fine-tune token. The field is required
      // by the entry shape; the id is the least surprising thing to put in it, and
      // `kind: 'base'` is what actually keeps this record out of every voice list.
      token: base.id,
      kind: 'base',
      dir: folder,
      base,
      format: 'hf',
      sampleRate: 24000,
      source: { type: 'hf', ref: base.ref },
      addedAt: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { success: true };
}

/**
 * Download a catalogue voice into the models dir and record it in the manifest.
 * `addedAt` is stamped here (normal Electron code — Date is fine outside workflows).
 *
 * TWO PHASES for an adapter voice: ensure the shared base (~6.6 GB, once per machine)
 * and then the adapter itself (~0.4 GB). A MERGED voice takes exactly the path it
 * always took — one download into `<models>/<id>`, no base involved — so this is a
 * no-op change for every merged repo.
 */
export async function installOrpheusModel(
  repoId: string,
  onProgress?: OrpheusInstallProgressFn,
): Promise<{ success: boolean; error?: string }> {
  const token = getHfToken();
  const headers: Record<string, string> = { 'User-Agent': 'BookForge' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Read the authoritative token/label straight from the repo's model card.
  const meta = await fetchCardMeta(repoId, headers);
  const voiceToken = (meta.orpheus_token || '').trim();
  if (!voiceToken) {
    return { success: false, error: `Repo "${repoId}" has no orpheus_token on its model card — not a BookForge Orpheus voice.` };
  }
  const id = repoId.split('/').pop()!;
  const label = (meta.label || '').trim() || prettyFromId(id);
  const sampleRate = Number(meta.sample_rate) || 24000;
  const artifact = artifactFromCard(meta);
  const base = artifact === 'adapter' ? (baseRefFromCard(meta) ?? DEFAULT_ORPHEUS_BASE) : undefined;

  if (base) {
    onProgress?.({ repoId, phase: 'base', message: 'Downloading shared base model (one time)…' });
    const baseResult = await installOrpheusBase(base);
    if (!baseResult.success) {
      return { success: false, error: `Shared base model "${base.ref}" failed to install: ${baseResult.error}` };
    }
  }

  onProgress?.({
    repoId,
    phase: 'voice',
    message: base ? `Downloading the ${label} voice adapter…` : `Downloading the ${label} voice…`,
  });
  const result = await runDownload(repoId, id, token, artifact);
  if (!result.ok) return { success: false, error: result.error || 'download failed' };

  upsertManifestEntry({
    id,
    label,
    token: voiceToken,
    // An adapter lands under adapters/<id>; a merged voice keeps the top-level <id>.
    // Both fields are written so a voice that later gains the OTHER form (the A/B
    // state) needs no manifest surgery — only the `artifact` field flips.
    ...(artifact === 'adapter' ? { adapterDir: id, artifact } : { dir: id }),
    ...(base ? { base } : {}),
    format: 'hf',
    sampleRate,
    source: { type: 'hf', ref: repoId },
    addedAt: new Date().toISOString().slice(0, 10),
  });
  return { success: true };
}

/**
 * Drop a voice from the manifest and delete its folder (best-effort).
 *
 * Deletes BOTH artifact locations for the id — `<models>/<id>` and
 * `<models>/adapters/<id>` — because "uninstall this voice" must not leave the other
 * half behind to be silently adopted by the reconcile scan on the next launch.
 * A `kind: 'base'` record is refused while any installed voice still references it:
 * deleting the shared base would break every adapter at once.
 */
export function removeOrpheusModel(id: string): { success: boolean; error?: string } {
  try {
    const entry = readManifest().models.find((e) => e.id === id);
    if (entry?.kind === 'base') {
      const dependants = listOrpheusModels().filter((m) => m.artifact === 'adapter').map((m) => m.id);
      if (dependants.length > 0) {
        return {
          success: false,
          error:
            `The shared Orpheus base model is still used by ${dependants.length} installed adapter ` +
            `voice${dependants.length === 1 ? '' : 's'} (${dependants.join(', ')}). Uninstall those voices first.`,
        };
      }
    }
    // removeManifestEntry → writeManifest THROWS when the \\wsl$ models dir is
    // unreachable (WSL down/wedged) — that also guards the sync rmSync below, which
    // against a wedged VM would block the main thread forever.
    removeManifestEntry(id);
    const root = getOrpheusModelsDir();
    const targets = entry?.kind === 'base'
      ? [path.join(root, BASE_SUBDIR, entry.base ? orpheusBaseFolderName(entry.base) : entry.dir || id)]
      : [path.join(root, entry?.dir || id), path.join(root, ADAPTERS_SUBDIR, entry?.adapterDir || id)];
    for (const dir of targets) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* folder may be gone, locked, or on an unmounted \\wsl$ — manifest is updated regardless */
      }
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
