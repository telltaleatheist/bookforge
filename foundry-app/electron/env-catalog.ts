/**
 * env-catalog — the Python environments foundry was MEASURED with, pinned.
 *
 * A conversion's speed, its VRAM ceiling and its failure modes are properties of
 * an exact set of wheels: vllm 0.11.0 against python 3.12.13, mlx-vlm 0.6.10
 * against 3.11.15, pymupdf 1.28.0 for the rasteriser every tier needs. `pip
 * install` on the user's machine resolves whatever the index offers TODAY and
 * produces a machine nobody has measured — so the app ships those environments
 * as release assets and downloads the one this platform can actually use.
 *
 * ── Two tables, deliberately apart ───────────────────────────────────────────
 *
 *   ENV_SPECS  — what is inside each environment and where its interpreter sits.
 *                Fixed by how the environment was BUILT. Changes with a new
 *                release tag, never with a rebuild of the same one.
 *
 *   ENV_ASSETS — bytes, sha256, and the part list. This is the ONE const the
 *                build's numbers land in; every URL and every size on screen is
 *                derived from it. When the assets are rebuilt, this is the only
 *                thing that is edited.
 *
 * ── A null sha256 is a REFUSAL ───────────────────────────────────────────────
 *
 * An entry whose sha256 is null has not been published yet. `requirePublished`
 * throws on it and the settings card shows it greyed. It is emphatically NOT a
 * signal to download the bytes and skip the check: an archive nobody can name
 * the hash of is a Python nobody should be running a book through, and the
 * failure mode of getting that wrong (a truncated or substituted interpreter) is
 * silent for a long time.
 *
 * The archive layout is fixed and the same for all three: ONE top-level
 * `python/` directory, containing `foundry-env.json` (name, target,
 * python-version, packages). That file is both the manifest the card prints
 * after an install and the MARKER that says a directory is a previous install of
 * ours — see `MARKER_RELPATH`, and the refuse-to-delete guard in env-install.ts.
 */
import * as os from 'node:os';
import * as path from 'node:path';

import type { EnvTarget } from '../shared/types';

/** Where the assets live. One release, one tag, three environments. */
const REPO = 'telltaleatheist/foundry';
const RELEASE_TAG = 'env-v1';

/**
 * The file whose presence means "this directory is an environment we installed".
 * POSIX-separated: it is a path INSIDE the archive, and it is also handed to
 * `test -f` inside a WSL distro.
 */
export const MARKER_RELPATH = 'python/foundry-env.json';

// ─────────────────────────────────────────────────────────────────────────────
// The numbers
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvPart {
  /** The release asset's own file name — `<archive>.partN`. */
  name: string;
  bytes: number | null;
  sha256: string | null;
}

export interface EnvAsset {
  /**
   * The REASSEMBLED archive's name. Also what tells the unpacker it is a
   * .tar.gz, which is why it stays a name even when the upload was split.
   */
  archive: string;
  /** The reassembled size, for the progress bar's right-hand side. */
  bytes: number | null;
  /** Of the REASSEMBLED archive. Null = not published; installing is refused. */
  sha256: string | null;
  /**
   * In download order — part0 first. Empty when the asset was uploaded whole.
   * GitHub caps a release asset at 2 GiB, so anything larger arrives in pieces
   * and is concatenated back before it is hashed.
   */
  parts: EnvPart[];
}

/**
 * ★ THE NUMBERS ★ — everything the build produces, and nothing else.
 *
 * Filled in from the release. `bytes` is the reassembled size; `sha256` is of
 * the reassembled archive; each part carries its own so a bad piece is named at
 * the moment it lands rather than 5 GB later.
 */
export const ENV_ASSETS: Record<EnvTarget, EnvAsset> = {
  'windows-x64': {
    archive: 'foundry-env-windows-x64-v1.tar.gz',
    bytes: 62_130_043,
    sha256: 'f0c5bf3c1c55168f95f6d293fcdcf5acd8e585ac785a307d2c429cadcfc5bf21',
    parts: [],
  },

  'mac-arm64': {
    archive: 'foundry-env-mac-arm64-v1.tar.gz',
    bytes: 218_784_079,
    sha256: 'dea140da88582a37a564d421d055d62caebc05e9de8957cf07136397e38343b5',
    parts: [],
  },

  // ~4.7 GiB of CUDA wheels: three assets, concatenated back in this order.
  'wsl-x64': {
    archive: 'foundry-env-wsl-x64-v1.tar.gz',
    bytes: 5_074_335_683,
    sha256: 'ee4fb2dc5059947e3a46bada2b4e53c9d39f1934f938799c391740a295d87ff7',
    parts: [
      {
        name: 'foundry-env-wsl-x64-v1.tar.gz.part0',
        bytes: 1_992_294_400,
        sha256: '49741c342fbfba215b9caa7020fd5fa1741675f3733b2cfdd5736004ea6ae01f',
      },
      {
        name: 'foundry-env-wsl-x64-v1.tar.gz.part1',
        bytes: 1_992_294_400,
        sha256: 'f77500336be807cecc3325922ebf47dc8f046c3b043176d7ff373239daec9111',
      },
      {
        name: 'foundry-env-wsl-x64-v1.tar.gz.part2',
        bytes: 1_089_746_883,
        sha256: 'e1a270fa74241a650139b0ce04f44735bb7db19186b3af7715df6f885a9d47ba',
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// What is in them
// ─────────────────────────────────────────────────────────────────────────────

export interface EnvSpec {
  target: EnvTarget;
  /** What the card calls it. */
  label: string;
  /**
   * The HOST that can use it. `wsl-x64` is a Linux environment, but the host
   * that installs and drives it is win32 — the platform filter answers "should
   * this machine be offered this", not "what kernel is the Python for".
   */
  platform: NodeJS.Platform;
  /** The host arch it requires, or null when any will do. */
  arch: string | null;
  pythonVersion: string;
  /** The packages that make it worth downloading, for the card to print. */
  packages: string[];
  /** The interpreter, relative to the unpack destination. POSIX, as in the tar. */
  pythonRelpath: string;
  /**
   * True when the environment must live INSIDE a WSL distro. Such a target has
   * no directory picker: its destination is a path in the guest's filesystem,
   * and extracting to it across \\wsl$ would flatten the symlinks a Python
   * install is made of.
   */
  inWsl: boolean;
  /** One sentence for the card, saying what the environment buys. */
  purpose: string;
}

export const ENV_SPECS: Record<EnvTarget, EnvSpec> = {
  'windows-x64': {
    target: 'windows-x64',
    label: 'Windows rasteriser',
    platform: 'win32',
    arch: 'x64',
    pythonVersion: '3.12.13',
    packages: ['pymupdf 1.28.0'],
    pythonRelpath: 'python/python.exe',
    inWsl: false,
    purpose: 'PyMuPDF, which every tier needs — a run draws the book locally before anything reads it.',
  },

  'wsl-x64': {
    target: 'wsl-x64',
    label: 'vLLM in WSL',
    platform: 'win32',
    arch: 'x64',
    pythonVersion: '3.12.13',
    packages: ['vllm 0.11.0', 'pymupdf'],
    pythonRelpath: 'python/bin/python3',
    inWsl: true,
    purpose: 'The reading server itself: vLLM on the local GPU, served to the engine over an endpoint.',
  },

  'mac-arm64': {
    target: 'mac-arm64',
    label: 'MLX on Apple silicon',
    platform: 'darwin',
    arch: 'arm64',
    pythonVersion: '3.11.15',
    packages: ['mlx-vlm 0.6.10', 'pymupdf 1.28.0'],
    pythonRelpath: 'python/bin/python3',
    inWsl: false,
    purpose: 'Reading on the Mac\'s own GPU, plus the PyMuPDF every run rasterises with.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Derived
// ─────────────────────────────────────────────────────────────────────────────

export function assetUrl(name: string): string {
  return `https://github.com/${REPO}/releases/download/${RELEASE_TAG}/${name}`;
}

export interface EnvSource {
  url: string;
  /** Null when the build has not published a size for this piece. */
  bytes: number | null;
  /** Checked the moment the piece finishes, before it is appended. */
  sha256: string | null;
}

/**
 * The ordered list of things to fetch: one entry for a whole asset, N for a
 * split one. The ORDER is the part order in the catalog and nothing sorts it —
 * `part10` sorting before `part2` is exactly the bug that produces an archive
 * that downloads, verifies against nothing, and fails to unpack.
 */
export function envSources(target: EnvTarget): EnvSource[] {
  const asset = ENV_ASSETS[target];
  if (asset.parts.length === 0) {
    return [{ url: assetUrl(asset.archive), bytes: asset.bytes, sha256: asset.sha256 }];
  }
  return asset.parts.map((part) => ({
    url: assetUrl(part.name),
    bytes: part.bytes,
    sha256: part.sha256,
  }));
}

/**
 * Throws unless the entry's numbers are actually on the release.
 *
 * The refusal is the point. Called before a single byte is fetched, and again
 * by nothing else — there is no path through the installer that reaches a
 * download with a null hash behind it.
 */
export function requirePublished(target: EnvTarget): EnvAsset {
  const asset = ENV_ASSETS[target];
  if (asset.sha256 === null || asset.bytes === null) {
    throw new Error(
      `${ENV_SPECS[target].label} (${target}) is not yet published: the catalog has no sha256 for `
      + `${asset.archive}, so there is nothing to verify a download against.`,
    );
  }
  for (const part of asset.parts) {
    if (part.sha256 === null || part.bytes === null) {
      throw new Error(
        `${ENV_SPECS[target].label} (${target}) is not yet published: ${part.name} has no sha256 in the catalog.`,
      );
    }
  }
  return asset;
}

/** True when the entry can be installed at all. The card greys the rest out. */
export function isPublished(target: EnvTarget): boolean {
  const asset = ENV_ASSETS[target];
  if (asset.sha256 === null || asset.bytes === null) return false;
  return asset.parts.every((part) => part.sha256 !== null && part.bytes !== null);
}

/**
 * Where an environment goes when the user does not say.
 *
 * Under the platform's own per-user application data, never beside the app: a
 * packaged install lives in Program Files, and five gigabytes of CUDA wheels
 * under a directory that an update replaces wholesale is a download done twice.
 * The WSL target's default is a path in the GUEST's home, tilde-form, because
 * bash is what will expand it.
 */
export function defaultDest(target: EnvTarget): string {
  switch (target) {
    case 'windows-x64': {
      const local = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local');
      return path.join(local, 'foundry', 'envs', 'windows-x64');
    }
    case 'mac-arm64':
      return path.join(os.homedir(), 'Library', 'Application Support', 'foundry', 'envs', 'mac-arm64');
    case 'wsl-x64':
      return '~/.foundry/envs/wsl-x64';
  }
}

/**
 * The interpreter that will exist under `dest`.
 *
 * A WSL target is joined with POSIX rules even though this process is Windows —
 * the path is for bash, and `~\.foundry\envs\wsl-x64\python\bin\python3` is not
 * a thing any shell has ever resolved.
 */
export function interpreterPath(target: EnvTarget, dest: string): string {
  const spec = ENV_SPECS[target];
  return spec.inWsl
    ? path.posix.join(dest, spec.pythonRelpath)
    : path.join(dest, ...spec.pythonRelpath.split('/'));
}

/** The marker file under `dest` — the thing the delete guard looks for. */
export function markerPath(target: EnvTarget, dest: string): string {
  return ENV_SPECS[target].inWsl
    ? path.posix.join(dest, MARKER_RELPATH)
    : path.join(dest, ...MARKER_RELPATH.split('/'));
}

/**
 * The environments this machine could actually use.
 *
 * Offering a Mac environment on Windows is not a harmless extra row: it is five
 * hundred megabytes the user might spend on a Python that cannot run here. The
 * arch test is separate from the platform test because `mac-arm64` on an Intel
 * Mac is the same mistake in a smaller costume.
 */
export function targetsForPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): EnvTarget[] {
  return (Object.keys(ENV_SPECS) as EnvTarget[]).filter((target) => {
    const spec = ENV_SPECS[target];
    if (spec.platform !== platform) return false;
    return spec.arch === null || spec.arch === arch;
  });
}
