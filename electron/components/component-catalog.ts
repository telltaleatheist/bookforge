/**
 * Component Catalog — the in-app list of optional components BookForge can
 * detect, install, verify, and resolve. Ships with the app; later remote-
 * fetchable for updatability.
 *
 * Phase 1 entries: Calibre (external), Tesseract (external), Orpheus
 * (external + managed stub).
 */

import * as os from 'os';
import * as path from 'path';

import { getE2aPath } from '../tool-paths';
import { voiceComponents } from './voice-components';
import { rvcVoiceComponents } from './rvc-voice-components';
import { languagePackComponents } from './language-pack-components';
import { llamaCudaComponent } from './llama-cuda';
import { cudaTtsComponent } from './cuda-tts';
import { cudaRvcComponent } from './cuda-rvc';
import { rvcEnvComponent } from './rvc-env';
import { voxtralEnvComponent } from './voxtral-env';
import { f5EnvComponent } from './f5-env';
import type {
  OptionalComponent,
  ComponentArtifact,
  Platform,
} from './component-types';

// ─────────────────────────────────────────────────────────────────────────────
// Calibre — binary, external-only (managed can be added later)
//
// Candidate paths copied EXACTLY from electron/ebook-convert-bridge.ts
// (EBOOK_CONVERT_PATHS), tagged by platform.
// ─────────────────────────────────────────────────────────────────────────────

const calibre: OptionalComponent = {
  id: 'calibre',
  name: 'Calibre',
  description:
    'Converts many ebook formats (MOBI, AZW3, FB2, DOCX, …) to EPUB via the ebook-convert CLI.',
  kind: 'binary',
  acquisition: ['external'],
  sizeBytes: 0,
  requirements: {
    gpu: 'none',
    // All platforms eligible (platforms omitted = all).
  },
  artifacts: [],
  detect: {
    commandNames: ['ebook-convert'],
    candidates: [
      // macOS Calibre.app
      { platform: 'darwin', path: '/Applications/calibre.app/Contents/MacOS/ebook-convert' },
      // macOS Homebrew
      { platform: 'darwin', path: '/opt/homebrew/bin/ebook-convert' },
      { platform: 'darwin', path: '/usr/local/bin/ebook-convert' },
      // Linux
      { platform: 'linux', path: '/usr/bin/ebook-convert' },
      // Windows (common install paths)
      { platform: 'win32', path: 'C:\\Program Files\\Calibre2\\ebook-convert.exe' },
      { platform: 'win32', path: 'C:\\Program Files (x86)\\Calibre2\\ebook-convert.exe' },
    ],
    envVar: 'CALIBRE_PATH',
  },
  verify: { kind: 'exec', args: ['--version'] },
  version: '',
  entryPath: '', // resolved from detection for external installs
  externalHelpUrl: 'https://calibre-ebook.com/download',
};

// ─────────────────────────────────────────────────────────────────────────────
// Tesseract — binary, external-only
// ─────────────────────────────────────────────────────────────────────────────

const tesseract: OptionalComponent = {
  id: 'tesseract',
  name: 'Tesseract OCR',
  description: 'Open-source OCR engine used to extract text from scanned/image PDFs.',
  kind: 'binary',
  acquisition: ['external'],
  sizeBytes: 0,
  requirements: {
    gpu: 'none',
  },
  artifacts: [],
  detect: {
    commandNames: ['tesseract'],
    candidates: [
      { platform: 'darwin', path: '/opt/homebrew/bin/tesseract' },
      { platform: 'darwin', path: '/usr/local/bin/tesseract' },
      { platform: 'linux', path: '/usr/bin/tesseract' },
      { platform: 'win32', path: 'C:\\Program Files\\Tesseract-OCR\\tesseract.exe' },
    ],
    envVar: 'TESSERACT_PATH',
  },
  verify: { kind: 'exec', args: ['--version'] },
  version: '',
  entryPath: '',
  externalHelpUrl: 'https://tesseract-ocr.github.io/tessdoc/Installation.html',
};

// ─────────────────────────────────────────────────────────────────────────────
// Orpheus — conda-env, external + managed (stub URLs until hosting is chosen)
//
// GPU NOTE: Orpheus runs on EITHER an NVIDIA CUDA GPU (vLLM backend) OR Apple
// Silicon (MLX backend). The locked GpuKind type has no "cuda-or-apple-silicon"
// member, and we may not modify the contract. So we declare requirements.gpu =
// 'cuda' here and rely on system-probe.evaluate()'s special rule: for a
// conda-env component, a 'cuda' GPU requirement is ALSO satisfied by Apple
// Silicon. This keeps the contract unchanged while encoding the real
// capability. See electron/components/system-probe.ts → evaluate().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the external-detection candidate conda env locations for Orpheus:
 * named envs (orpheus_tts / orpheus_env) under common conda installs, plus a
 * prefix env (orpheus_env) sitting beside the e2a install.
 */
function getOrpheusEnvCandidates(): { platform: Platform; path: string }[] {
  const homeDir = os.homedir();
  const candidates: { platform: Platform; path: string }[] = [];

  const envNames = ['orpheus_tts', 'orpheus_env'];

  // Named envs under common conda roots (envs/<name>).
  const unixCondaRoots = [
    path.join(homeDir, 'miniforge3'),
    path.join(homeDir, 'Miniforge3'),
    path.join(homeDir, 'miniconda3'),
    path.join(homeDir, 'anaconda3'),
    '/opt/conda',
    '/opt/homebrew/Caskroom/miniconda/base',
    '/opt/homebrew/Caskroom/miniforge/base',
  ];
  const winCondaRoots = [
    path.join(homeDir, 'Miniforge3'),
    path.join(homeDir, 'miniconda3'),
    path.join(homeDir, 'Miniconda3'),
    path.join(homeDir, 'anaconda3'),
    path.join(homeDir, 'Anaconda3'),
    'C:\\ProgramData\\Miniforge3',
    'C:\\ProgramData\\miniconda3',
    'C:\\ProgramData\\Anaconda3',
  ];

  for (const root of unixCondaRoots) {
    for (const name of envNames) {
      const envPath = path.join(root, 'envs', name);
      candidates.push({ platform: 'darwin', path: envPath });
      candidates.push({ platform: 'linux', path: envPath });
    }
  }
  for (const root of winCondaRoots) {
    for (const name of envNames) {
      candidates.push({ platform: 'win32', path: path.join(root, 'envs', name) });
    }
  }

  // Prefix env beside the e2a install (e.g. <e2a>/orpheus_env).
  try {
    const e2aPath = getE2aPath();
    const e2aParent = path.dirname(e2aPath);
    for (const name of envNames) {
      const besideE2a = path.join(e2aParent, name);
      const insideE2a = path.join(e2aPath, name);
      candidates.push({ platform: 'darwin', path: besideE2a });
      candidates.push({ platform: 'linux', path: besideE2a });
      candidates.push({ platform: 'win32', path: besideE2a });
      candidates.push({ platform: 'darwin', path: insideE2a });
      candidates.push({ platform: 'linux', path: insideE2a });
      candidates.push({ platform: 'win32', path: insideE2a });
    }
  } catch {
    // getE2aPath should not throw, but never let catalog construction fail.
  }

  return candidates;
}

// Managed artifacts: per-platform stub entries (url:'' until hosting is chosen).
const orpheusArtifacts: ComponentArtifact[] = [
  { platform: 'darwin', arch: 'arm64', gpu: 'apple-silicon', url: '', sha256: '', bytes: 0, condaUnpack: true },
  { platform: 'win32', arch: 'x64', gpu: 'cuda', url: '', sha256: '', bytes: 0, condaUnpack: true },
  { platform: 'linux', arch: 'x64', gpu: 'cuda', url: '', sha256: '', bytes: 0, condaUnpack: true },
];

const orpheus: OptionalComponent = {
  id: 'orpheus',
  name: 'Orpheus TTS',
  description:
    'High-quality neural TTS with strong prosody. Runs on an NVIDIA CUDA GPU (vLLM) or Apple Silicon (MLX).',
  kind: 'conda-env',
  acquisition: ['external', 'managed'],
  sizeBytes: 0,
  requirements: {
    // 'cuda' here means CUDA OR Apple Silicon for conda-env components — see the
    // GPU NOTE above and system-probe.evaluate().
    gpu: 'cuda',
    minVramMB: 6000,
  },
  artifacts: orpheusArtifacts,
  detect: {
    candidates: getOrpheusEnvCandidates(),
    envVar: 'ORPHEUS_ENV_PATH',
  },
  verify: { kind: 'python-import', module: 'orpheus_tts' },
  version: '',
  entryPath: '', // env root, resolved from detection (external) or install dir (managed)
  externalHelpUrl:
    'https://github.com/canopyai/Orpheus-TTS#installation',
};

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

// Built fresh on every call so it reflects the latest catalog snapshot: the
// voice and language-pack entries come from CatalogService, which swaps in the
// live catalog after its background network refresh. The static entries
// (calibre, tesseract, orpheus, GPU packs) never change.
export function getCatalog(): OptionalComponent[] {
  return [
    calibre,
    tesseract,
    orpheus,
    llamaCudaComponent(),
    cudaTtsComponent(),
    cudaRvcComponent(),
    rvcEnvComponent(),
    voxtralEnvComponent(),
    f5EnvComponent(),
    ...voiceComponents(),
    ...rvcVoiceComponents(),
    ...languagePackComponents(),
  ];
}

export function getComponent(id: string): OptionalComponent | undefined {
  return getCatalog().find((c) => c.id === id);
}
