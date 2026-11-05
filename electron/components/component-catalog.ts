/**
 * Component Catalog — the in-app list of optional components BookForge can
 * detect, install, verify, and resolve. Ships with the app; later remote-
 * fetchable for updatability.
 *
 * Phase 1 entries: Calibre (external), Tesseract (external).
 */

import { rvcVoiceComponents } from './rvc-voice-components';
import { llamaCudaComponent } from './llama-cuda';
import { cudaRvcComponent } from './cuda-rvc';
import { rvcEnvComponent } from './rvc-env';
import { whisperxEnvComponent } from './whisperx-env';
import type { OptionalComponent } from './component-types';

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
// Catalog
// ─────────────────────────────────────────────────────────────────────────────

// Built fresh on every call because the voice entries are read off
// disk. Nothing here is fetched from a network catalog any more: the remote
// catalog served exactly two lists — the XTTS voices and the Stanza language
// packs — and both left the build (2026-09-05).
export function getCatalog(): OptionalComponent[] {
  return [
    calibre,
    llamaCudaComponent(),
    cudaRvcComponent(),
    rvcEnvComponent(),
    whisperxEnvComponent(),
    ...rvcVoiceComponents(),
  ];
}

export function getComponent(id: string): OptionalComponent | undefined {
  return getCatalog().find((c) => c.id === id);
}
