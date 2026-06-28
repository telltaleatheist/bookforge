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
import { getConfig } from './tool-paths';
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
} from './orpheus-models';

/** Card tag that marks a repo as a BookForge Orpheus voice. */
const ORPHEUS_VOICE_TAG = 'bookforge-orpheus-voice';

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
}

// ── credentials / account ─────────────────────────────────────────────────────

function getHfUser(): string | null {
  return getConfig().orpheusHfUser?.trim() || null;
}

/** Resolve an HF token: Settings → env HF_TOKEN → ~/.cache/huggingface/token. */
export function getHfToken(): string | null {
  const fromSettings = getConfig().huggingFaceToken?.trim();
  if (fromSettings) return fromSettings;
  const fromEnv = process.env.HF_TOKEN?.trim() || process.env.HUGGING_FACE_HUB_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const cached = fs
      .readFileSync(path.join(os.homedir(), '.cache', 'huggingface', 'token'), 'utf-8')
      .trim();
    if (cached) return cached;
  } catch {
    /* no cached token */
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
 * The downloadable voice catalogue: the configured HF account's
 * `bookforge-orpheus-voice`-tagged repos. Returns [] when no account is set.
 */
export async function fetchOrpheusCatalog(): Promise<OrpheusCatalogEntry[]> {
  const user = getHfUser();
  if (!user) return [];

  const token = getHfToken();
  const headers: Record<string, string> = { 'User-Agent': 'BookForge' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const url =
    `https://huggingface.co/api/models?author=${encodeURIComponent(user)}` +
    `&filter=${ORPHEUS_VOICE_TAG}&full=true`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`HuggingFace list failed (${res.status} ${res.statusText}) for author "${user}"`);
  }
  const repos = (await res.json()) as Array<Record<string, any>>;
  const installed = new Set(listOrpheusModels().map((m) => m.id));

  const out: OrpheusCatalogEntry[] = [];
  for (const repo of repos) {
    const repoId: string = repo.id || repo.modelId;
    if (!repoId) continue;
    const id = repoId.split('/').pop()!;
    const card = (repo.cardData || {}) as Record<string, any>;

    let voiceToken = (card.orpheus_token ?? '').toString().trim();
    let label = (card.label ?? '').toString().trim();
    let sampleRate = Number(card.sample_rate) || 0;

    if (!voiceToken || !sampleRate) {
      const meta = await fetchCardMeta(repoId, headers);
      voiceToken = voiceToken || (meta.orpheus_token || '').trim();
      label = label || (meta.label || '').trim();
      sampleRate = sampleRate || Number(meta.sample_rate) || 24000;
    }
    if (!voiceToken) continue; // not a usable voice without its prompt token

    out.push({
      repoId,
      id,
      token: voiceToken,
      label: label || prettyFromId(id),
      sampleRate,
      private: !!repo.private,
      installed: installed.has(id),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
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

function runDownload(repoId: string, id: string, token: string | null): Promise<{ ok: boolean; error?: string }> {
  const scriptPath = resolveDownloadScript();

  const viaWsl = process.platform === 'win32' && shouldUseWsl2ForOrpheus();
  const destDir = `${modelsDirForSpawn(viaWsl)}${viaWsl ? '/' : path.sep}${id}`;

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
        `python -u ${shellQuote(scriptWsl)} ${shellQuote(repoId)} ${shellQuote(destDir)}`;
      command = 'wsl.exe';
      args = distro ? ['-d', distro, 'bash', '-c', bash] : ['bash', '-c', bash];
      env = process.env;
    } else {
      const py = getPythonInvocation(getDefaultE2aPath(), 'orpheus');
      command = py.command;
      args = [...py.args, '-u', scriptPath, repoId, destDir];
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

/**
 * Download a catalogue voice into the models dir and record it in the manifest.
 * `addedAt` is stamped here (normal Electron code — Date is fine outside workflows).
 */
export async function installOrpheusModel(repoId: string): Promise<{ success: boolean; error?: string }> {
  const user = getHfUser();
  if (!user) return { success: false, error: 'No HuggingFace account configured (Settings → Tools).' };

  // Re-fetch the catalogue so we have the authoritative token/label for this repo.
  let entry: OrpheusCatalogEntry | undefined;
  try {
    entry = (await fetchOrpheusCatalog()).find((e) => e.repoId === repoId || e.id === repoId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!entry) return { success: false, error: `Repo "${repoId}" not found in the ${user} voice catalogue.` };

  const result = await runDownload(entry.repoId, entry.id, getHfToken());
  if (!result.ok) return { success: false, error: result.error || 'download failed' };

  upsertManifestEntry({
    id: entry.id,
    label: entry.label,
    token: entry.token,
    dir: entry.id,
    format: 'hf',
    sampleRate: entry.sampleRate,
    source: { type: 'hf', ref: entry.repoId },
    addedAt: new Date().toISOString().slice(0, 10),
  });
  return { success: true };
}

/** Drop a voice from the manifest and delete its folder (best-effort). */
export function removeOrpheusModel(id: string): { success: boolean; error?: string } {
  try {
    removeManifestEntry(id);
    const dir = path.join(getOrpheusModelsDir(), id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* folder may be gone, locked, or on an unmounted \\wsl$ — manifest is updated regardless */
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
