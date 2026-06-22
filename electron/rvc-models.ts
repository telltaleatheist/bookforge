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
import * as path from 'path';
import * as fs from 'fs';

import { downloadFile, sha256File, osTarBin } from './components/downloader';

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
    url: `${RELEASE_BASE}/rvc-voice-sigma.tar.gz`,
    sha256: '610140a1cc5114f8a4a84a59014ca98d61a5f9c4715e91b7a8949fecebe12f1c',
    bytes: 107877125,
    version: '2026.06.21',
  },
  {
    id: 'rvc-voice-samantha',
    label: 'Samantha',
    modelName: 'Samantha',
    matches: 'the Scarlett Johansson (default) voice',
    url: `${RELEASE_BASE}/rvc-voice-samantha.tar.gz`,
    sha256: '519d6eb1c6dfcaef22621ec088b70051ae18884cb1372abd26670dda9503b9d2',
    bytes: 51140977,
    forceIndexRate0: true, // ships .pth only — index is empty upstream
    version: '2026.06.21',
  },
];

/** Look up an enhancement voice descriptor by its asset id. */
export function getRvcVoiceById(id: string): RvcVoiceAsset | undefined {
  return RVC_VOICE_ASSETS.find((v) => v.id === id);
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

/** Install an enhancement voice by its asset id (pulls base models first). */
export async function ensureRvcVoice(
  voiceId: string,
  onProgress?: (m: string) => void,
): Promise<void> {
  const voice = RVC_VOICE_ASSETS.find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown RVC voice: ${voiceId}`);
  await ensureRvcBaseModels(onProgress);
  await ensureRvcAsset(voice, onProgress);
}

export interface RvcVoiceStatus {
  id: string;
  label: string;
  modelName: string;
  matches: string;
  bytes: number;
  installed: boolean;
  forceIndexRate0: boolean;
}

/** Status of every enhancement voice for the configuration page. */
export function listRvcVoices(): RvcVoiceStatus[] {
  return RVC_VOICE_ASSETS.map((v) => ({
    id: v.id,
    label: v.label,
    modelName: v.modelName,
    matches: v.matches,
    bytes: v.bytes,
    installed: rvcVoiceInstalled(v),
    forceIndexRate0: !!v.forceIndexRate0,
  }));
}

/** Remove an installed enhancement voice (its folder + marker). */
export function removeRvcVoice(voiceId: string): void {
  const voice = RVC_VOICE_ASSETS.find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown RVC voice: ${voiceId}`);
  const dir = path.join(getRvcModelsDir(), 'rvc', 'voice_models', voice.modelName);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(assetMarkerPath(voice.id), { force: true }); } catch { /* ignore */ }
}
