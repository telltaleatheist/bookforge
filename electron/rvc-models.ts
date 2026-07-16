/**
 * RVC model assets — base models (required) + enhancement voices (optional).
 *
 * The `rvc-env` component (electron/components/rvc-env.ts) ships only the RVC
 * ENGINE. Conversion also needs model files, which live OUTSIDE the env so they
 * survive env updates and can be added/removed individually:
 *
 *   <userData>/runtime/rvc-models/                ← URVC_MODELS_DIR at runtime
 *     rvc/embedders/contentvec/{config.json,pytorch_model.bin}   (base, required)
 *     rvc/predictors/rmvpe.pt                                     (base, required)
 *     rvc/voice_models/<Name>/<*.pth>[, <*.index>]               (one per voice)
 *
 * Each asset is a tar.gz published as a GitHub release asset (assets tag on
 * telltaleatheist/bookforge) whose internal layout is rooted at `rvc/…`, so it
 * extracts straight into the rvc-models dir. Download → sha256-verify → extract
 * → per-asset ready-marker, mirroring ensureRuntimeAsset() in e2a-env-bootstrap.
 *
 * The base models are REQUIRED for any conversion; the voices are the
 * user-facing "enhancement voices" offered on the configuration page. A voice
 * whose `forceIndexRate0` is set has no usable .index and must be converted with
 * --index-rate 0 (the pipeline reads this off the descriptor).
 */

import { app } from 'electron';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { downloadFile, sha256File, osTarBin, extractArchive } from './components/downloader';
import { getConfig, updateConfig } from './tool-paths';

const RELEASE_BASE =
  'https://github.com/telltaleatheist/bookforge/releases/download/assets';

export interface RvcAsset {
  id: string;
  label: string;
  url: string;
  sha256: string;
  bytes: number;
  version: string; // bump (with a new tarball) to force a re-download + re-extract
}

/** Base embedder + pitch predictor — required before any conversion runs. */
export const RVC_BASE_ASSET: RvcAsset = {
  id: 'rvc-base-models',
  label: 'RVC base models',
  url: `${RELEASE_BASE}/rvc-base-models.tar.gz`,
  sha256: '4cc3b83681d6a4d42102e16bdfd3dbc52596ab70c5315cba0c681fe8c93a7c0b',
  bytes: 387652691,
  version: '2026.06.21',
};

/** A downloadable enhancement voice (RVC model). */
export interface RvcVoiceAsset extends RvcAsset {
  /** Folder name under rvc/voice_models — also the `model_name` arg to urvc. */
  modelName: string;
  /** Short note on which TTS voice this best enhances (UI guidance). */
  matches: string;
  /** True when the model ships without a usable faiss .index — convert with
   *  --index-rate 0 (the .index is empty / absent). */
  forceIndexRate0?: boolean;
  /** Per-voice tuned index-rate (0–1), recorded as a reference for the value
   *  that A/B'd best for this voice. NOT currently applied — the UI uses the
   *  global 0.5 default (by product decision); wire this into the wizard if
   *  per-voice index defaults are ever turned on. */
  defaultIndexRate?: number;
  /** True for a user-added source: no sha256 (user-hosted) → extract to a temp
   *  dir, locate the .pth/.index anywhere inside, and relocate into
   *  voice_models/<modelName>/ (the archive layout is unknown, unlike defaults). */
  userSource?: boolean;
}

export const RVC_VOICE_ASSETS: RvcVoiceAsset[] = [
  {
    id: 'rvc-voice-owen-morgan',
    label: 'Owen Morgan',
    // Definitive Owen Morgan RVC (ep400), hosted on the owner's HuggingFace
    // alongside the XTTS fine-tune. Tarball extracts to rvc/voice_models/Owen Morgan/.
    modelName: 'Owen Morgan',
    matches: 'the Owen Morgan fine-tuned XTTS voice',
    url: 'https://huggingface.co/owenmorgan/owen-morgan-bookforge/resolve/main/rvc/owen-morgan.tar.gz',
    sha256: '1a446de02c9f322f36a0979a3c135f69ac0436713dc6ce5b7ede9c26da3ed6ec',
    bytes: 80526382,
    version: '2026.06.22',
  },
  {
    id: 'rvc-voice-sigma',
    label: 'Sigma Male Narrator',
    modelName: 'Sigma Male Narrator',
    matches: 'a deep male narration voice',
    // Moved to the owner's HuggingFace alongside Owen Morgan.
    url: 'https://huggingface.co/owenmorgan/owen-morgan-bookforge/resolve/main/rvc/sigma.tar.gz',
    sha256: '1bd49bd68233c56a977eb65a94f9a1f3aa0f3677c5e03aef4c4442389a877f19',
    bytes: 107877124,
    version: '2026.06.22',
  },
  {
    id: 'rvc-voice-us-female-1',
    label: 'US Female 1',
    modelName: 'US_Female_1',
    matches: 'a female English narration voice (the best over Orpheus leah)',
    // From Wismut/RVC_US_Female_1 on HuggingFace, re-hosted on the owner's repo.
    // Ships WITH its 194 MB faiss .index: the earlier "segfault" was the OpenMP
    // duplicate-lib crash (now fixed by the bridge's KMP_DUPLICATE_LIB_OK +
    // OMP_NUM_THREADS=1 env), not the index. A/B'd best at index-rate 0.75
    // (the most locked/faithful timbre over Orpheus leah) — recorded in
    // defaultIndexRate below for reference, though the app currently defaults
    // all voices to the global 0.5.
    url: 'https://huggingface.co/owenmorgan/owen-morgan-bookforge/resolve/main/rvc/us-female-1.tar.gz',
    sha256: 'b81303b2d33569cc61f547d5c44582cefa69043544d8bc78e3b9538a30d465d7',
    bytes: 170789700,
    version: '2026.06.25',
    defaultIndexRate: 0.75,
  },
  {
    id: 'rvc-voice-girlfriend',
    label: 'Girlfriend',
    modelName: 'Girlfriend',
    matches: 'a warm female English narration voice (great over Orpheus tara/leah)',
    // From rvc-modils/femalemodels (girlfriend.zip), re-hosted on the owner's
    // repo. Ships with its faiss .index (converts fine at index-rate 0.5).
    url: 'https://huggingface.co/owenmorgan/owen-morgan-bookforge/resolve/main/rvc/girlfriend.tar.gz',
    sha256: '23f8df8636cac4e76d11225ab3ac837e9e4bd40fee4ccaa55f8492a62c9b277a',
    bytes: 182708462,
    version: '2026.06.24',
  },
  // NOTE: the "Samantha" (Scarlett Johansson, "Her") RVC model was removed —
  // it's the actress's actual voice and she has not consented to its use. Do not
  // re-add it. (The XTTS "Scarlett Johansson" default voice is only NAMED after
  // her and is NOT her real voice, so it stays.)
];

// ── User-added RVC voice sources (Settings) ───────────────────────────────────

export interface RvcUserSource { url: string; name: string; }

/** The user's added RVC sources (persisted in ToolPathsConfig.rvcVoiceSources). */
export function getRvcSources(): RvcUserSource[] {
  const list = getConfig().rvcVoiceSources;
  return Array.isArray(list) ? list.filter((s) => s && s.url && s.name) : [];
}

/** Stable asset id for a user source (derived from its display name). */
function userSourceId(name: string): string {
  return 'rvc-user-' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function addRvcSource(url: string, name: string): { success: boolean; error?: string } {
  const u = (url || '').trim();
  const n = (name || '').trim();
  if (!/^https?:\/\/.+/i.test(u)) return { success: false, error: 'Enter a valid http(s) archive URL.' };
  if (!n) return { success: false, error: 'Enter a name for the voice.' };
  const list = getRvcSources();
  if (list.some((s) => userSourceId(s.name) === userSourceId(n))) {
    return { success: false, error: `A voice named "${n}" already exists.` };
  }
  list.push({ url: u, name: n });
  updateConfig({ rvcVoiceSources: list });
  return { success: true };
}

/** Remove a user source by its synthetic asset id; also deletes any install. */
export function removeRvcSource(id: string): void {
  const src = getRvcSources().find((s) => userSourceId(s.name) === id);
  updateConfig({ rvcVoiceSources: getRvcSources().filter((s) => userSourceId(s.name) !== id) });
  if (src) { try { removeRvcVoice(id); } catch { /* best-effort */ } }
}

/** A user source as a synthetic RvcVoiceAsset (no sha256, unknown size/version). */
function userSourceToAsset(s: RvcUserSource): RvcVoiceAsset {
  return {
    id: userSourceId(s.name),
    label: s.name,
    modelName: s.name,
    matches: 'a custom RVC voice',
    url: s.url,
    sha256: '',
    bytes: 0,
    version: 'user',
    userSource: true,
  };
}

/** Stable asset id for a locally-dropped model (derived from its folder name). */
function localVoiceId(folderName: string): string {
  return 'rvc-local-' + folderName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Auto-discovered local RVC models: any folder under voice_models/ that contains
 * a .pth and isn't already claimed by a built-in or a user source. This makes
 * trained models drop-in — copy `<modelName>/<something>.pth` into voice_models/
 * and it appears as an installed voice. `forceIndexRate0` is derived from the
 * ABSENCE of a faiss .index (no index → must convert at index-rate 0). An optional
 * `voice.json` in the folder ({ label, matches, defaultIndexRate }) overrides the
 * folder-name label / defaults.
 */
export function getLocalRvcVoices(): RvcVoiceAsset[] {
  const dir = path.join(getRvcModelsDir(), 'rvc', 'voice_models');
  if (!fs.existsSync(dir)) return [];
  const claimed = new Set<string>([
    ...RVC_VOICE_ASSETS.map((v) => v.modelName),
    ...getRvcSources().map((s) => s.name),
  ]);
  const voices: RvcVoiceAsset[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (claimed.has(name)) continue; // a built-in / user source owns this folder
    const folder = path.join(dir, name);
    let entries: string[];
    try {
      if (!fs.statSync(folder).isDirectory()) continue;
      entries = fs.readdirSync(folder);
    } catch { continue; }
    if (!entries.some((f) => f.toLowerCase().endsWith('.pth'))) continue;
    const hasIndex = entries.some((f) => f.toLowerCase().endsWith('.index'));
    // Optional per-folder manifest for a nicer label / recorded index default.
    let meta: { label?: string; matches?: string; defaultIndexRate?: number } = {};
    const manifest = path.join(folder, 'voice.json');
    if (fs.existsSync(manifest)) {
      try { meta = JSON.parse(fs.readFileSync(manifest, 'utf-8')); }
      catch { /* malformed manifest → fall back to folder-name defaults */ }
    }
    voices.push({
      id: localVoiceId(name),
      label: meta.label || name,
      modelName: name,
      matches: meta.matches || 'a custom local RVC voice',
      url: '',
      sha256: '',
      bytes: 0,
      version: 'local',
      forceIndexRate0: !hasIndex,
      defaultIndexRate: meta.defaultIndexRate,
      userSource: true, // shares the "local, no sha256" semantics
    });
  }
  return voices;
}

/** Built-in defaults + user sources + auto-discovered local drop-ins. */
export function getAllRvcVoiceAssets(): RvcVoiceAsset[] {
  return [...RVC_VOICE_ASSETS, ...getRvcSources().map(userSourceToAsset), ...getLocalRvcVoices()];
}

/** Look up an enhancement voice descriptor by its asset id (defaults + user). */
export function getRvcVoiceById(id: string): RvcVoiceAsset | undefined {
  return getAllRvcVoiceAssets().find((v) => v.id === id);
}

/**
 * The RVC models root — set as URVC_MODELS_DIR when invoking the engine.
 *
 * BOOKFORGE_RVC_MODELS_DIR overrides it so `electron:dev` can point at an
 * existing models tree (e.g. the repo's `models/`) instead of downloading the
 * managed assets — mirrors the BOOKFORGE_E2A_ENV dev seam.
 */
export function getRvcModelsDir(): string {
  const override = process.env.BOOKFORGE_RVC_MODELS_DIR?.trim();
  if (override) return override;
  return path.join(app.getPath('userData'), 'runtime', 'rvc-models');
}

function assetMarkerPath(id: string): string {
  return path.join(getRvcModelsDir(), `.bookforge-rvc-asset-${id}.json`);
}

export function rvcAssetReady(asset: RvcAsset): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(assetMarkerPath(asset.id), 'utf-8'));
    return m.version === asset.version && m.sha256 === asset.sha256;
  } catch {
    return false;
  }
}

/**
 * Whether the required base models are usable. Checks the actual files (not just
 * the download marker) so it's also true for a dev BOOKFORGE_RVC_MODELS_DIR that
 * was populated outside the managed-download path.
 */
export function rvcBaseModelsReady(): boolean {
  if (rvcAssetReady(RVC_BASE_ASSET)) return true;
  const root = getRvcModelsDir();
  const contentvec = path.join(root, 'rvc', 'embedders', 'contentvec', 'pytorch_model.bin');
  const rmvpe = path.join(root, 'rvc', 'predictors', 'rmvpe.pt');
  return fs.existsSync(contentvec) && fs.existsSync(rmvpe);
}

/** Whether a voice's model folder is actually present (marker OR files on disk). */
function rvcVoiceInstalled(v: RvcVoiceAsset): boolean {
  if (rvcAssetReady(v)) return true;
  const dir = path.join(getRvcModelsDir(), 'rvc', 'voice_models', v.modelName);
  try {
    return fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.pth'));
  } catch {
    return false;
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

const inFlight: Record<string, Promise<void> | undefined> = {};

async function doEnsureRvcAsset(
  asset: RvcAsset,
  onProgress?: (message: string) => void,
): Promise<void> {
  const root = getRvcModelsDir();
  fs.mkdirSync(root, { recursive: true });

  const cache = path.join(root, `${asset.id}.tar.gz`);

  // Reuse a cached, verified archive from an interrupted prior run.
  let haveValid = false;
  if (fs.existsSync(cache)) {
    try {
      const got = await sha256File(cache);
      haveValid = got.toLowerCase() === asset.sha256.toLowerCase();
    } catch { /* unreadable — re-download */ }
    if (!haveValid) { try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ } }
  }

  if (!haveValid) {
    const mb = (n?: number) => (n != null ? Math.round(n / 1_000_000) : 0);
    let lastPct = -1;
    await downloadFile(asset.url, cache, `rvc-${asset.id}`, (p) => {
      if (typeof p.pct === 'number' && p.pct !== lastPct) {
        lastPct = p.pct;
        const detail = p.totalBytes ? ` ${p.pct}% (${mb(p.receivedBytes)} / ${mb(p.totalBytes)} MB)` : '';
        onProgress?.(`Downloading ${asset.label}…${detail}`);
      }
    });
    onProgress?.(`Verifying ${asset.label}…`);
    const got = await sha256File(cache);
    if (got.toLowerCase() !== asset.sha256.toLowerCase()) {
      try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
      throw new Error(
        `Downloaded ${asset.label} checksum mismatch (expected ${asset.sha256}, got ${got}).`
      );
    }
  }

  onProgress?.(`Installing ${asset.label}…`);
  await run(osTarBin(), ['-xzf', cache, '-C', root]);

  fs.writeFileSync(
    assetMarkerPath(asset.id),
    JSON.stringify({ version: asset.version, sha256: asset.sha256 }),
    'utf-8',
  );
  try { fs.rmSync(cache, { force: true }); } catch { /* ignore */ }
}

/** Download + install an RVC asset if missing (deduped by id). */
export function ensureRvcAsset(
  asset: RvcAsset,
  onProgress?: (message: string) => void,
): Promise<void> {
  if (rvcAssetReady(asset)) return Promise.resolve();
  const existing = inFlight[asset.id];
  if (existing) return existing;
  const p = doEnsureRvcAsset(asset, onProgress).finally(() => { inFlight[asset.id] = undefined; });
  inFlight[asset.id] = p;
  return p;
}

/** Ensure the required base models are present. */
export function ensureRvcBaseModels(onProgress?: (m: string) => void): Promise<void> {
  return ensureRvcAsset(RVC_BASE_ASSET, onProgress);
}

/** Recursively find the LARGEST file with a given extension under `dir` (the model
 *  weights, not an incidental small companion), or null. */
function findLargestByExt(dir: string, ext: string): string | null {
  const matches: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith(ext)) matches.push(p);
    }
  };
  walk(dir);
  if (matches.length === 0) return null;
  const size = (p: string): number => { try { return fs.statSync(p).size; } catch { return 0; } };
  return matches.reduce((a, b) => (size(b) > size(a) ? b : a));
}

/** Download a user-source archive, extract it, and relocate the .pth (+ .index)
 *  into voice_models/<modelName>/ (the archive's internal layout is unknown). */
async function doEnsureUserRvcVoice(
  voice: RvcVoiceAsset,
  onProgress?: (m: string) => void,
): Promise<void> {
  if (rvcVoiceInstalled(voice)) return;
  const destDir = path.join(getRvcModelsDir(), 'rvc', 'voice_models', voice.modelName);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rvc-'));
  const archive = path.join(tmpRoot, 'voice-archive');
  try {
    let lastPct = -1;
    await downloadFile(voice.url, archive, `rvc-${voice.id}`, (p) => {
      if (typeof p.pct === 'number' && p.pct !== lastPct) {
        lastPct = p.pct;
        onProgress?.(`Downloading ${voice.label}… ${p.pct}%`);
      }
    });
    onProgress?.(`Installing ${voice.label}…`);
    const extractDir = path.join(tmpRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    await extractArchive(archive, extractDir, voice.url);
    const pth = findLargestByExt(extractDir, '.pth');
    if (!pth) throw new Error(`No .pth model file found in the archive for "${voice.label}".`);
    const index = findLargestByExt(extractDir, '.index');
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(pth, path.join(destDir, path.basename(pth)));
    if (index) fs.copyFileSync(index, path.join(destDir, path.basename(index)));
    fs.writeFileSync(
      assetMarkerPath(voice.id),
      JSON.stringify({ version: voice.version, sha256: voice.sha256 }),
      'utf-8',
    );
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Install an enhancement voice by its asset id (pulls base models first).
 *  Built-in voices are sha256-verified tarballs; user sources are downloaded +
 *  extracted + relocated (no checksum). */
export async function ensureRvcVoice(
  voiceId: string,
  onProgress?: (m: string) => void,
): Promise<void> {
  const voice = getAllRvcVoiceAssets().find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown RVC voice: ${voiceId}`);
  await ensureRvcBaseModels(onProgress);
  if (voice.userSource) {
    const existing = inFlight[voice.id];
    if (existing) return existing;
    const p = doEnsureUserRvcVoice(voice, onProgress).finally(() => { inFlight[voice.id] = undefined; });
    inFlight[voice.id] = p;
    await p;
  } else {
    await ensureRvcAsset(voice, onProgress);
  }
}

/** Whether an enhancement voice (by asset id) is installed on disk. */
export function isRvcVoiceInstalled(voiceId: string): boolean {
  const voice = getAllRvcVoiceAssets().find((v) => v.id === voiceId);
  return !!voice && rvcVoiceInstalled(voice);
}

/** Absolute folder a voice's model extracts to (rvc/voice_models/<modelName>). */
export function rvcVoiceModelDir(voiceId: string): string | null {
  const voice = getRvcVoiceById(voiceId);
  if (!voice) return null;
  return path.join(getRvcModelsDir(), 'rvc', 'voice_models', voice.modelName);
}

/** Remove an installed enhancement voice (its folder + marker). */
export function removeRvcVoice(voiceId: string): void {
  const voice = getRvcVoiceById(voiceId);
  if (!voice) throw new Error(`Unknown RVC voice: ${voiceId}`);
  const dir = path.join(getRvcModelsDir(), 'rvc', 'voice_models', voice.modelName);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(assetMarkerPath(voice.id), { force: true }); } catch { /* ignore */ }
}
