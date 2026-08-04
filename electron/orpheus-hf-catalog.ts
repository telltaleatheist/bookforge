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
  FUSEWORK_SUBDIR,
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
  /**
   * The LOCAL id this repo installs as — the card's `orpheus_token`, NOT the repo's
   * short name. One voice = one id, whatever the repo is called and whichever artifact
   * form it ships, which is what lets `owenmorgan/thirdreich-orpheus-3b-lora` and the
   * older `owenmorgan/thirdreich-orpheus-3b` land on (and update) the SAME manifest
   * entry `thirdreich` — the id the curated tuning catalog is keyed by. See
   * installOrpheusModel for why any other choice silently drops the voice's tuning.
   */
  id: string;
  /** Prompt token the model was fine-tuned on (from card `orpheus_token`). */
  token: string;
  /** Display label. */
  label: string;
  sampleRate: number;
  private: boolean;
  /** Already present in the local manifest/folder. */
  installed: boolean;
  /** The local folder/manifest id when installed. Normally equal to `id`; it can still
   *  differ for a hand-dropped folder named after the repo short-name, or a voice
   *  installed by an older build that keyed on the short name. Uninstall must target
   *  THIS, not the catalog id. Absent when not installed. */
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

/** Stable catalog id for the shared base, whatever repo it is pulled from. */
const ORPHEUS_BASE_ID = 'orpheus-3b-base';

/**
 * The base the Settings "Base model" card offers when NO adapter voice in the catalog
 * has declared one — i.e. the identity of the card itself, nothing more. It is a REAL,
 * public repo id, not a placeholder.
 *
 * It is emphatically NOT a fallback for an adapter card that forgot `orpheus_base`:
 * such a card is REJECTED (see baseRefFromCard's callers). Serving a LoRA on the wrong
 * base produces confident, fluent, WRONG audio with no error anywhere — the one failure
 * class this module must never manufacture.
 */
export const DEFAULT_ORPHEUS_BASE: OrpheusBaseRef = {
  id: ORPHEUS_BASE_ID,
  ref: 'unsloth/orpheus-3b-0.1-ft',
};

/** Parse a card's `orpheus_base` value ("unsloth/orpheus-3b-0.1-ft") into a base ref.
 *  Undefined when the card doesn't declare one — which for an adapter card is fatal,
 *  never defaulted. */
function baseRefFromCard(meta: Record<string, string>): OrpheusBaseRef | undefined {
  const ref = (meta.orpheus_base || '').trim();
  if (!ref) return undefined;
  return { id: ORPHEUS_BASE_ID, ref };
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
  // Every catalogued adapter declares a base (fetchOrpheusCatalog drops the ones that
  // don't), so this is a real declaration whenever any adapter voice exists. With NO
  // adapter voices there is nothing to derive from and nothing that needs a base:
  // `required` is false, the Settings card is hidden, and DEFAULT_ORPHEUS_BASE is
  // simply the identity that card would show — not a substituted per-voice base.
  const base = adapters.length > 0 ? adapters[0].base! : DEFAULT_ORPHEUS_BASE;
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

  // "Installed?" is matched on TWO keys, because neither alone is sufficient:
  //
  //  1. The manifest's recorded `source.ref` — the exact HF repo a voice was installed
  //     from. Catches a voice installed from THIS repo under any local id.
  //  2. The card's `orpheus_token`, which is the id every install now lands under (see
  //     installOrpheusModel). Catches the same VOICE installed from a different repo:
  //     the deployed merged installs record the old `…-orpheus-3b` refs, while this
  //     catalog now lists the `…-orpheus-3b-lora` repos. Without this key all three
  //     primaries render "Available" with an enabled Download on the very machine
  //     they are installed on.
  //
  // A third, weaker key is kept last: a folder named after the repo SHORT NAME. That
  // only ever matches a hand-dropped folder (or one installed by a pre-token-id build),
  // so it stays a match of last resort.
  const installedModels = listOrpheusModels();
  const installedIds = new Set(installedModels.map((m) => m.id));
  // repo ref → the local folder id it was installed as, so Uninstall can target the
  // right folder even when it differs from the id this catalog would install under.
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
        const shortName = repoId.split('/').pop()!;
        // The local id is the voice's TOKEN — see OrpheusCatalogEntry.id.
        const id = voiceToken;
        const artifact = artifactFromCard(meta);
        // An adapter card MUST declare its base. A LoRA served on the wrong base still
        // produces fluent audio in a subtly wrong voice, with no error at any layer —
        // so a card that omits `orpheus_base` is not a usable voice, exactly like a card
        // that omits `orpheus_token`, and is dropped from the catalogue rather than
        // being handed a guessed default.
        const base = artifact === 'adapter' ? baseRefFromCard(meta) : undefined;
        if (artifact === 'adapter' && !base) {
          console.warn(
            `[ORPHEUS-CATALOG] Skipping '${repoId}': its model card declares ` +
              `orpheus_artifact: adapter but no orpheus_base, and a LoRA cannot be served ` +
              `without knowing which base model it was trained against.`,
          );
          return null;
        }
        // Best-effort private flag from the model-info endpoint.
        let isPrivate = false;
        try {
          const info = await fetch(`https://huggingface.co/api/models/${repoId}`, { headers });
          if (info.ok) isPrivate = !!(await info.json()).private;
        } catch { /* ignore */ }
        // Installed if the manifest records this repo as a source, or the voice's token
        // id is installed (the same voice from an older/other repo), or — last resort —
        // a hand-dropped folder is named after the repo short-name.
        const localId =
          localIdByRepoRef.get(repoId) ??
          (installedIds.has(id) ? id : installedIds.has(shortName) ? shortName : undefined);
        const baseInstalled = base ? isBaseRefInstalled(base) : true;
        return {
          repoId,
          id,
          token: voiceToken,
          label: (meta.label || '').trim() || prettyFromId(shortName),
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

/** Install progress. Phase 'base' only ever fires on the FIRST adapter install of a
 *  machine's life — after that the base is already there and the install is a single
 *  ~0.4 GB step. Phase 'fuse' is the macOS-only CPU merge (see runFuse). */
export interface OrpheusInstallProgress {
  repoId: string;
  phase: 'base' | 'voice' | 'fuse';
  message: string;
}
export type OrpheusInstallProgressFn = (p: OrpheusInstallProgress) => void;

// ── fuse (macOS only) ─────────────────────────────────────────────────────────

/**
 * Locate orpheus_fuse.py across dev (electron/scripts) and packaged (dist) layouts — the
 * same three candidates resolveDownloadScript walks, for the same reason.
 *
 * THROWS when none of them exists. There is no sensible fallback: handing python a path
 * that isn't there turns a packaging bug into an opaque `can't open file` inside a fuse
 * failure message, on the one platform where the fuse is the only way to install a voice.
 * The script is copied into dist by build:electron's script list — if this throws, that
 * list is what's wrong.
 */
function resolveFuseScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'orpheus_fuse.py'),
    path.join(__dirname, '..', '..', 'electron', 'scripts', 'orpheus_fuse.py'),
    path.join(__dirname, 'scripts', 'orpheus_fuse.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `orpheus_fuse.py is not in this build (looked in ${candidates.join(', ')}). ` +
        `It must be copied into dist/electron/scripts by the build:electron script list.`,
    );
  }
  return found;
}

/**
 * Merge a downloaded LoRA into a full model MLX can load: `W' = W + (α/r)·B@A` for every
 * targeted projection, written to `<models>/<id>/` in the base's own shard layout.
 *
 * macOS ONLY — see the CANONICAL constraint block on resolveOrpheusInstall's darwin
 * branch (electron/orpheus-models.ts) for why the Mac has to fuse at all.
 *
 * The merge is BUILT in `<models>/.fusework/<id>/` and renamed onto `<models>/<id>/` only
 * once it verifies: the workspace is a dotted scratch dir the model scan skips, so a fuse
 * that dies half-way leaves nothing that reads as an installed voice, and the promote is
 * rename-based so a re-install never deletes the working copy before the new one is in
 * place (orpheus_fuse.py promote()).
 *
 * Runs through the SAME python invocation orpheus_download.py uses natively — the
 * per-engine Orpheus env — because that is the environment that is guaranteed to exist
 * on a Mac that can render Orpheus at all. The script imports nothing but `safetensors`
 * and `torch`, deliberately not `peft`: a one-shot weight merge should not be coupled to
 * peft's version drift in a shared runtime env.
 */
function runFuse(
  baseDir: string,
  adapterDir: string,
  outDir: string,
  workspaceDir: string,
  onLine?: (line: string) => void,
): Promise<{ ok: boolean; error?: string }> {
  let scriptPath: string;
  try {
    scriptPath = resolveFuseScript();
  } catch (err) {
    return Promise.resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  const py = getPythonInvocation(getDefaultE2aPath(), 'orpheus');
  const args = [
    ...py.args,
    '-u',
    scriptPath,
    '--base', baseDir,
    '--adapter', adapterDir,
    '--out', outDir,
    // Same filesystem as --out (it is renamed into place), and deleted on any failure.
    '--workspace', workspaceDir,
    // A re-install of a retrained voice MUST replace the previous fused copy; without
    // --force the script refuses a non-empty output, which would strand the update.
    '--force',
    // Cheap next to the merge itself (a re-read plus three recomputed matrices) and it
    // is the only thing standing between a truncated write and a voice that loads.
    '--verify',
  ];

  return new Promise((resolve) => {
    // PYTHONIOENCODING is not cosmetic here: the script's own output is ASCII, but any
    // library warning or traceback that isn't would raise UnicodeEncodeError on a stdout
    // that inherited a non-UTF-8 codepage, killing a merge that had already succeeded.
    const child = spawn(py.command, args, { env: buildCondaSpawnEnv({ PYTHONIOENCODING: 'utf-8' }) });
    let stdout = '';
    let stderr = '';
    let pending = '';
    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      // Surface each `[FUSE] …` progress line as it arrives; the merge is minutes long
      // and a frozen "Fusing…" with no motion reads as a hang.
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('[FUSE]')) onLine?.(t.slice('[FUSE]'.length).trim());
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, error: err.message }));
    child.on('close', () => {
      // Same contract as the downloader: the last JSON object on stdout is the result.
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (typeof parsed.ok === 'boolean') return resolve(parsed);
        } catch {
          /* not JSON */
        }
      }
      resolve({ ok: false, error: stderr.trim().slice(-400) || 'fuse produced no result' });
    });
  });
}

/**
 * Download the ONE shared base model into `<models>/_base/<short-name>` and record a
 * `kind: 'base'` manifest entry. Idempotent: an already-installed base returns
 * success without re-downloading (6.6 GB), which is what makes the two-phase adapter
 * install cheap from the second voice onward.
 */
export async function installOrpheusBase(
  base: OrpheusBaseRef,
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
 * always took — one download into `<models>/<id>`, no base involved.
 *
 * A THIRD PHASE runs on macOS ONLY: fusing the adapter onto the base into a normal
 * merged folder (see runFuse). Nothing about the Windows/WSL path changes — every new
 * branch below is `process.platform === 'darwin'`.
 *
 * THE INSTALL ID IS THE CARD'S `orpheus_token`, not the repo's short name. That single
 * rule is what keeps a voice's identity stable across repos and artifact forms, and it
 * is load-bearing in two places:
 *
 *  - The curated tuning catalog (electron/data/orpheus-models.json) is keyed by id, and
 *    applyTuning matches by id. An install under `deathstalker-orpheus-3b-lora` matches
 *    NOTHING there, so the voice renders with no eosBoost / repPenalty / maxCharsPerSec
 *    / sentenceGap — i.e. exactly the untuned configuration whose silence-loop runaways
 *    those caps exist to prevent.
 *  - Re-installing the same voice from a different repo (merged → lora) must UPDATE the
 *    one entry, not add a near-duplicate voice to every picker.
 *
 * A card with no `orpheus_token` is rejected below, so the id always exists.
 *
 * COLLISION with an existing entry of the same id is not an error — it is the intended
 * A/B state (both forms of one voice installed). The existing record's other-form
 * inventory is carried forward and only the fields this install owns are overwritten,
 * so installing the adapter of an already-merged voice flips `artifact` and adds
 * `adapterDir` while leaving `dir` pointing at the merged copy that is still on disk.
 */
export async function installOrpheusModel(
  repoId: string,
  onProgress?: OrpheusInstallProgressFn,
): Promise<{ success: boolean; error?: string; id?: string }> {
  const token = getHfToken();
  const headers: Record<string, string> = { 'User-Agent': 'BookForge' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  // Read the authoritative token/label straight from the repo's model card.
  const meta = await fetchCardMeta(repoId, headers);
  const voiceToken = (meta.orpheus_token || '').trim();
  if (!voiceToken) {
    return { success: false, error: `Repo "${repoId}" has no orpheus_token on its model card — not a BookForge Orpheus voice.` };
  }
  const id = voiceToken;
  const label = (meta.label || '').trim() || prettyFromId(repoId.split('/').pop()!);
  const sampleRate = Number(meta.sample_rate) || 24000;
  const artifact = artifactFromCard(meta);
  // Same rule as the catalogue: an adapter with no declared base is not installable.
  // Guessing one would serve this LoRA on some other model — fluent, confident, and
  // the wrong voice, with nothing anywhere reporting a problem.
  const base = artifact === 'adapter' ? baseRefFromCard(meta) : undefined;
  if (artifact === 'adapter' && !base) {
    return {
      success: false,
      error:
        `Repo "${repoId}" declares orpheus_artifact: adapter but no orpheus_base on its model card. ` +
        `A LoRA can only be served on the exact base model it was trained against, so BookForge ` +
        `will not install it without that declaration.`,
    };
  }

  // Because the id IS the token, two DIFFERENT repos that declare the same
  // `orpheus_token` claim the same local identity — and the deployed source list has
  // exactly that: `deathstalker-orpheus-3b-lora` and `deathstalker-narration-orpheus-3b`
  // both say `deathstalker`. Installing the second AS THE SAME FORM would download
  // straight over the first's folder and destroy it, silently, before any manifest
  // write. That is not the A/B state (which is one voice in two forms, in two different
  // folders, and is allowed below) — it is two voices fighting over one name, and the
  // only honest answer is to refuse and say which cards collide. Re-installing the SAME
  // repo is an update and passes.
  const existing = readManifest().models.find((e) => e.id === id);
  if (existing?.kind === 'base') {
    return {
      success: false,
      error:
        `Can't install "${repoId}" as voice id "${id}": that id is already the shared base ` +
        `model record. Change the repo's orpheus_token — it must name the voice, not the base.`,
    };
  }
  // macOS serves this adapter FUSED (see runFuse): the install writes a second folder,
  // the merged one at `<models>/<id>/`, so on darwin an adapter install claims BOTH
  // destinations and both have to be checked for the collision above. Without this a Mac
  // could install `<voice>-orpheus-3b-lora` straight over a merged `<voice>-orpheus-3b`
  // from a different card — the exact overwrite the check exists to refuse, just via the
  // fuse output instead of the download.
  const fuseOnDarwin = artifact === 'adapter' && process.platform === 'darwin';
  const existingRef = existing?.source?.ref;
  //
  // …EXCEPT when the "collision" is the MIGRATION ITSELF. Every Mac that already had
  // Orpheus voices has them as MERGED installs from the old `<voice>-orpheus-3b` repos,
  // and the new `<voice>-orpheus-3b-lora` repo is the same voice — same orpheus_token,
  // deliberately — arriving in its new artifact form. Its fuse output lands on exactly the
  // folder the old merged copy occupies, which reads as a token collision and is not one:
  // there is one owner of this token and this is its upgrade. Refusing it would leave the
  // -lora repos installable on Windows and refused on macOS, with the only escape being to
  // delete a working voice before running an unproven fuse. So: same token owner + an
  // existing MERGED install + an incoming adapter fuse on darwin = UPGRADE, allowed. The
  // promote is rename-based (orpheus_fuse.py promote()), so the old copy survives intact
  // until the fused one has been written AND verified.
  //
  // A DIFFERENT token owner (existing.token names another voice) is still a real
  // collision and still refused, as is any occupied adapter folder — two -lora repos
  // fighting over one token is the case this guard was written for.
  const existingToken = existing?.token || existing?.id;
  const isDarwinFormUpgrade =
    !!existing && fuseOnDarwin && existingToken === voiceToken && existing.artifact !== 'adapter';
  const claimedFolders: string[] = [];
  if (artifact === 'adapter') {
    if (existing?.adapterDir) claimedFolders.push(path.join(getOrpheusModelsDir(), ADAPTERS_SUBDIR, existing.adapterDir));
    if (fuseOnDarwin && existing?.dir && !isDarwinFormUpgrade) claimedFolders.push(path.join(getOrpheusModelsDir(), existing.dir));
  } else if (existing?.dir) {
    claimedFolders.push(path.join(getOrpheusModelsDir(), existing.dir));
  }
  if (existing && existingRef && existingRef !== repoId) {
    for (const dest of claimedFolders) {
      let occupied = false;
      try {
        occupied = fs.existsSync(dest);
      } catch {
        occupied = false; // unreadable models dir — the download itself will report it
      }
      if (occupied) {
        return {
          success: false,
          error:
            `"${repoId}" and the already-installed "${existingRef}" both declare orpheus_token ` +
            `"${id}", so both want to live in ${dest}. Installing this one would overwrite the ` +
            `other. Give one of the two model cards a distinct orpheus_token, or uninstall ` +
            `"${existing.label}" first.`,
        };
      }
    }
  }

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

  // THIRD PHASE, macOS only: fuse the LoRA onto the base to get an ordinary merged model
  // folder (why: the canonical block in orpheus-models.ts). The download win survives
  // (0.4 GB over the wire per extra voice); only the local disk pays.
  //
  // The manifest is written ONLY on success, and the failure is loud: a Mac left with a
  // downloaded-but-unfused adapter has a voice e2a will refuse to render (orpheus.py
  // hard-errors on adapter mode off vLLM) rather than one that renders in the wrong
  // voice. Both downloads are already on disk, so retrying costs only the CPU merge.
  if (fuseOnDarwin) {
    const resolvedBase = resolveOrpheusBase(base!);
    if (!resolvedBase) {
      return {
        success: false,
        error:
          `The shared base model "${base!.ref}" reported success but is not resolvable on disk, ` +
          `so the ${label} voice cannot be fused onto it.`,
      };
    }
    const fusedDir = path.join(getOrpheusModelsDir(), id);
    const adapterPath = path.join(getOrpheusModelsDir(), ADAPTERS_SUBDIR, id);
    // Scratch sibling of the output (same filesystem — the promote is a rename), skipped
    // by the model scan so a killed fuse is never adopted as a voice.
    const workspaceDir = path.join(getOrpheusModelsDir(), FUSEWORK_SUBDIR, id);
    // An upgrade replaces a voice the user already has working, which is a different
    // thing to be watching than a first install — say which one this is.
    const fuseHeadline = isDarwinFormUpgrade
      ? `Upgrading ${label} to the adapter form…`
      : `Fusing the ${label} voice onto the base model…`;
    onProgress?.({ repoId, phase: 'fuse', message: fuseHeadline });
    const fused = await runFuse(resolvedBase.dir, adapterPath, fusedDir, workspaceDir, (line) =>
      onProgress?.({ repoId, phase: 'fuse', message: `${fuseHeadline} ${line}` }),
    );
    if (!fused.ok) {
      return {
        success: false,
        error:
          `The ${label} voice downloaded, but fusing it onto the shared base model failed: ` +
          `${fused.error || 'unknown error'}. macOS cannot serve a LoRA adapter directly, so the ` +
          `voice is not usable until this succeeds — the downloads are kept, so retrying only ` +
          `repeats the merge.`,
      };
    }
  }

  // Carry forward the OTHER form's folder if this voice already has one installed —
  // upsertManifestEntry replaces the record wholesale, so dropping `dir` here would
  // orphan a merged copy that is still on disk (and vice-versa). Exactly one field
  // describes each form, and `artifact` says which one is served.
  upsertManifestEntry({
    ...(existing?.dir ? { dir: existing.dir } : {}),
    ...(existing?.adapterDir ? { adapterDir: existing.adapterDir } : {}),
    // …including the base an already-installed adapter declared: installing the MERGED
    // form of the same voice must not strip the adapter's base ref and leave the other
    // half unservable.
    ...(existing?.base ? { base: existing.base } : {}),
    id,
    label,
    token: voiceToken,
    // An adapter lands under adapters/<id>; a merged voice keeps the top-level <id>.
    // `artifact` is written EXPLICITLY in both cases: this install is a deliberate
    // choice of form, and when both forms are present it is the only thing that says
    // which one to serve.
    //
    // A FUSED (macOS) install records BOTH folders and `artifact: 'merged'`, because
    // both are real and the merged one is what gets loaded. `adapterDir` + `base` are
    // not decoration: they are the provenance of those weights (which LoRA over which
    // base produced them) and they are the input stage B2 will serve directly once MLX
    // can apply a LoRA at runtime, at which point flipping this one field switches the
    // machine over with no re-download.
    ...(artifact === 'adapter'
      ? fuseOnDarwin
        ? { adapterDir: id, dir: id, artifact: 'merged' as const }
        : { adapterDir: id, artifact: 'adapter' as const }
      : { dir: id, artifact: 'merged' as const }),
    ...(base ? { base } : {}),
    format: 'hf',
    sampleRate,
    source: { type: 'hf', ref: repoId },
    addedAt: new Date().toISOString().slice(0, 10),
  });
  // The local voice id comes back so callers can act on THIS voice specifically —
  // above all, tell a running streaming engine to forget it. Re-installing a
  // retrained voice writes new weights to the same folder, and an engine that already
  // has the old ones registered would go on serving them for the rest of the session.
  return { success: true, id };
}

/**
 * Drop a voice from the manifest and delete its folder (best-effort).
 *
 * Deletes BOTH artifact locations for the id — `<models>/<id>` and
 * `<models>/adapters/<id>` — because "uninstall this voice" must not leave the other
 * half behind to be silently adopted by the reconcile scan on the next launch.
 * A `kind: 'base'` record is refused while any installed voice still references it:
 * deleting the shared base would break every adapter at once.
 *
 * PRE-EXISTING HAZARD (not introduced by the adapter migration, not fixed here): the
 * catalogue's ref→local-id map (fetchOrpheusCatalog) keeps ONE id per `source.ref`, so
 * if two manifest entries somehow record the SAME repo as their source, the later entry
 * wins the map and this function would be handed that id — uninstalling the wrong one of
 * the two. It cannot happen through the installer (one id per voice, and re-installing
 * updates that id's entry in place); it needs a hand-edited models.json. Worth knowing
 * before adding any code path that writes a second entry with an existing ref.
 */
export function removeOrpheusModel(id: string): { success: boolean; error?: string } {
  try {
    const entry = readManifest().models.find((e) => e.id === id);
    if (entry?.kind === 'base') {
      // DARWIN TRADEOFF (recorded, deliberate, must be revisited by stage B2): the guard
      // counts voices whose ACTIVE artifact is 'adapter', and a fused Mac voice reports
      // 'merged' — its weights are standalone, so deleting the base cannot break it and
      // this guard correctly lets the base go. What it costs is a re-download: the next
      // adapter install on that Mac pulls the 6.6 GB base again, because the fuse needs
      // it as an input even though nothing needs it at render time. That is the right
      // trade while fused voices are self-contained. It stops being right at B2, where
      // the Mac serves base + adapter resident and deleting the base breaks every voice
      // on the machine — at which point this must count darwin adapter-provenance voices
      // (entry.adapterDir set) as dependants too.
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
