/**
 * Installing a Higgs MERGED CHECKPOINT from HuggingFace — the Settings → Higgs
 * download door.
 *
 * The Orpheus door (`orpheus-hf-catalog.ts`) discovers voices from a list of HF
 * repos and writes a per-machine manifest. This one is smaller on purpose: the
 * Higgs roster is the repo file `electron/data/higgs-models.json`, and a voice
 * there names its own `source` (the HF repo) and its own destination PER ARM
 * (`voice.checkpoint.wsl` / `.darwin`). So "install" is: download that repo into
 * that directory, on this arm, and prove the required files are there. No
 * manifest, no discovery, no id derived from a model card.
 *
 * WHERE THE BYTES LAND, and why it differs per arm:
 *
 *   Windows  inside WSL, in the `higgs3` env (huggingface_hub 1.30), into the
 *            catalog's `wsl` path on the guest's ext4 — the directory the launch
 *            script is pointed at. Not through /mnt/c: the 9p mount is slow and
 *            the server never reads the Windows side.
 *   macOS    natively, with narrator's own interpreter (the narrator-mlx env
 *            carries huggingface_hub), into the catalog's `darwin` path resolved
 *            under the app's userData — the directory the MLX backend loads.
 *
 * `higgs_download.py` (electron/scripts/higgs) validates the download: a Higgs
 * checkpoint without `generation_config.json` is a server that samples the
 * untruncated codebook tail, and narrator refuses it by name — so the script
 * deletes an incomplete download rather than leaving one for the picker to
 * report as staged.
 */

import { spawn } from 'child_process';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  HiggsModel,
  higgsCheckpointArm,
  higgsCheckpointDirFor,
  listHiggsModels,
} from './higgs-models';
import { getHfToken } from './orpheus-hf-catalog';
import { buildToolsSpawnEnv } from './narrator-paths';
import { narratorNativePython, shellQuote } from './narrator-spawn';
import {
  getWslCondaPath,
  getWslDistro,
  getWslHiggsCondaEnv,
  windowsToWslPath,
} from './tool-paths';

/** The files whose presence means "this checkpoint is staged here". The same
 *  set `higgs_download.py` validates, and the ones narrator refuses without. */
const STAGED_MARKERS = ['config.json', 'generation_config.json', 'model.safetensors.index.json'];

export interface HiggsCheckpointStatus {
  id: string;
  /** Which arm this machine is; null where Higgs has no backend. */
  arm: 'wsl' | 'darwin' | null;
  /** The directory the catalog names for this arm, in that arm's spelling. */
  dir: string | null;
  /** Every STAGED_MARKER file is present in `dir`. */
  staged: boolean;
  /** The HF repo the catalog names as the source, if any. */
  source: string | null;
  /** Why it cannot be installed here, or null. */
  reason: string | null;
}

function catalogVoice(id: string): HiggsModel {
  const model = listHiggsModels().find((m) => m.id === id);
  if (!model) {
    throw new Error(`Higgs voice "${id}" is not in the catalog.`);
  }
  return model;
}

/** The repo a checkpoint voice can be fetched from, or a refusal naming the gap. */
function sourceRepoOf(model: HiggsModel): string {
  if (model.kind !== 'checkpoint') {
    throw new Error(
      `Higgs voice "${model.id}" is kind '${model.kind}' — only a fine-tune (a merged ` +
        'checkpoint) is downloaded; the base weights come with the environment.',
    );
  }
  const source = model.source;
  if (!source || source.type !== 'hf' || !source.ref?.trim()) {
    throw new Error(
      `Higgs voice "${model.id}" names no HuggingFace source in electron/data/higgs-models.json ` +
        '(`source: {type: "hf", ref: "<user>/<repo>"}`), so there is nothing to download it from.',
    );
  }
  return source.ref.trim();
}

/** Run a shell test inside WSL; true when it exits 0. */
function wslTest(bashCondition: string): Promise<boolean> {
  return new Promise((resolve) => {
    const distro = getWslDistro();
    const args = distro
      ? ['-d', distro, '--exec', 'bash', '-c', bashCondition]
      : ['--exec', 'bash', '-c', bashCondition];
    const child = spawn('wsl.exe', args, { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Is this checkpoint on THIS machine's arm? The Settings panel's question.
 *
 * Darwin is answered from the host's own disk. WSL is answered by asking the
 * guest — the one place in the app that does, because this is a Settings page
 * a person opened, not a picker that renders on every keystroke.
 */
export async function higgsCheckpointStatus(id: string): Promise<HiggsCheckpointStatus> {
  const model = catalogVoice(id);
  const arm = higgsCheckpointArm();
  const base: HiggsCheckpointStatus = {
    id, arm, dir: null, staged: false, source: null, reason: null,
  };
  try {
    base.source = sourceRepoOf(model);
  } catch (err) {
    base.reason = err instanceof Error ? err.message : String(err);
  }
  if (!arm) {
    base.reason = base.reason ?? `Higgs has no backend on ${process.platform}.`;
    return base;
  }
  let dir: string;
  try {
    dir = higgsCheckpointDirFor(model, arm, app.getPath('userData'));
  } catch (err) {
    base.reason = base.reason ?? (err instanceof Error ? err.message : String(err));
    return base;
  }
  base.dir = dir;
  if (arm === 'darwin') {
    base.staged = STAGED_MARKERS.every((f) => fs.existsSync(path.join(dir, f)));
  } else {
    const q = shellQuote(dir);
    base.staged = await wslTest(STAGED_MARKERS.map((f) => `test -f ${q}/${f}`).join(' && '));
  }
  return base;
}

export type HiggsInstallProgressFn = (text: string) => void;

/**
 * Download the checkpoint into its catalog directory on this arm. Streams the
 * downloader's stderr (huggingface_hub's progress bars) to `onProgress`, and
 * resolves with the script's one JSON result line.
 */
export async function installHiggsCheckpoint(
  id: string,
  onProgress?: HiggsInstallProgressFn,
): Promise<{ success: boolean; error?: string; dest?: string; bytes?: number }> {
  const model = catalogVoice(id);
  let repoId: string;
  try {
    repoId = sourceRepoOf(model);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  const arm = higgsCheckpointArm();
  if (!arm) {
    return { success: false, error: `Higgs has no backend on ${process.platform}; nothing to install into.` };
  }
  const token = getHfToken();
  if (!token) {
    return {
      success: false,
      error:
        `No HuggingFace token is configured, and ${repoId} is a private repo. Put the token in ` +
        'Settings → Tools (HuggingFace token) or in ~/.config/bookforge/hf-owenmorgan.token.',
    };
  }
  const scriptPath = resolveDownloadScript();
  const dest = higgsCheckpointDirFor(model, arm, app.getPath('userData'));
  onProgress?.(`Downloading ${repoId} → ${dest}\n`);

  let command: string;
  let args: string[];
  let env: NodeJS.ProcessEnv;
  if (arm === 'wsl') {
    const distro = getWslDistro();
    const bash =
      `export HF_TOKEN=${shellQuote(token)} && cd ~ && ` +
      `${shellQuote(getWslCondaPath())} run --no-capture-output -n ${shellQuote(getWslHiggsCondaEnv())} ` +
      `python -u ${shellQuote(windowsToWslPath(scriptPath))} ${shellQuote(repoId)} ${shellQuote(dest)}`;
    command = 'wsl.exe';
    // `--exec` so wsl.exe hands bash the string untouched (it pre-expands `$var` otherwise).
    args = distro ? ['-d', distro, '--exec', 'bash', '-c', bash] : ['--exec', 'bash', '-c', bash];
    env = process.env;
  } else {
    const py = narratorNativePython('higgs');
    command = py.command;
    args = [...py.args, '-u', scriptPath, repoId, dest];
    env = buildToolsSpawnEnv({ HF_TOKEN: token });
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, { env });
    let stdout = '';
    let stderrTail = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      onProgress?.(text);
    });
    child.on('error', (err) => resolve({ success: false, error: err.message }));
    child.on('close', () => {
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(lines[i]);
          if (typeof parsed.ok === 'boolean') {
            resolve(parsed.ok
              ? { success: true, dest: parsed.dest, bytes: parsed.bytes }
              : { success: false, error: parsed.error });
            return;
          }
        } catch {
          /* not the result line */
        }
      }
      resolve({ success: false, error: stderrTail.trim().slice(-600) || 'the download produced no result' });
    });
  });
}

/** Locate higgs_download.py across dev (electron/scripts/higgs) and packaged (dist) layouts. */
function resolveDownloadScript(): string {
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'scripts', 'higgs', 'higgs_download.py'),
    path.join(__dirname, 'scripts', 'higgs', 'higgs_download.py'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'higgs_download.py is not in this build (looked at ' + candidates.join(', ') + '). ' +
        "build:electron copies electron/scripts/higgs into dist — that copy is what's missing.",
    );
  }
  return found;
}
