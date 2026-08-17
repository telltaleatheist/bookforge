/**
 * settings — read and write the ENGINE's settings file.
 *
 * `%APPDATA%\foundry\settings.json` on Windows, the platform equivalent
 * elsewhere, `FOUNDRY_CONFIG_DIR` overriding both — the same three rules
 * foundry's own src/backend/settings.ts applies, because the app and the engine
 * disagreeing about where the file is means an app that appears to save nothing.
 *
 * The SCHEMA IS THE ENGINE'S. This module writes only the keys this app has a
 * reason to write — the three the settings screen edits, plus the two the WSL
 * setup runner discovers (`wslDistro`, `vllmPython`) — and PRESERVES every
 * other key in the file, at both levels: a newer engine's `endpointModel` must
 * survive an older app saving a URL over it. Reading is equally forgiving — unknown keys are ignored, and a file
 * that will not parse is reported rather than replaced, because overwriting an
 * operator's broken JSON destroys the thing they need to see to fix it.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readJson } from '../shared/json';
import type { BackendMode, BackendSettingsPatch, SettingsView } from '../shared/types';

const MODES: readonly BackendMode[] = ['auto', 'endpoint', 'mlx'];

export function configDir(): string {
  const override = process.env['FOUNDRY_CONFIG_DIR'];
  if (override) return override;
  switch (process.platform) {
    case 'win32': {
      const appData = process.env['APPDATA'];
      if (!appData) throw new Error('%APPDATA% is not set; cannot locate foundry\'s config directory.');
      return path.join(appData, 'foundry');
    }
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'foundry');
    default: {
      const xdg = process.env['XDG_CONFIG_HOME'];
      return path.join(xdg ?? path.join(os.homedir(), '.config'), 'foundry');
    }
  }
}

export function settingsPath(): string {
  return path.join(configDir(), 'settings.json');
}

/** The whole file as it is on disk, or null when there is not one. */
function readRaw(): { parsed: Record<string, unknown> | null; problem?: string } {
  const file = settingsPath();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { parsed: null };
    return { parsed: null, problem: `${file} could not be read: ${(err as Error).message}` };
  }
  try {
    const parsed: unknown = readJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { parsed: null, problem: `${file} does not hold a JSON object.` };
    }
    return { parsed: parsed as Record<string, unknown> };
  } catch (err) {
    return { parsed: null, problem: `${file} is not valid JSON: ${(err as Error).message}` };
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readSettings(): SettingsView {
  const { parsed, problem } = readRaw();
  const view: SettingsView = { path: settingsPath(), backend: {} };
  if (problem) view.problem = problem;
  if (!parsed) return view;

  const backend = parsed['backend'];
  if (typeof backend !== 'object' || backend === null || Array.isArray(backend)) return view;
  const b = backend as Record<string, unknown>;

  const mode = asString(b['mode']);
  if (mode && (MODES as readonly string[]).includes(mode)) view.backend.mode = mode as BackendMode;
  const url = asString(b['endpointUrl']);
  if (url) view.backend.endpointUrl = url;
  const python = asString(b['python']);
  if (python) view.backend.python = python;
  const distro = asString(b['wslDistro']);
  if (distro) view.backend.wslDistro = distro;
  const vllmPython = asString(b['vllmPython']);
  if (vllmPython) view.backend.vllmPython = vllmPython;
  return view;
}

/**
 * Merge the keys this app owns into the file and write it back.
 *
 * An EMPTY STRING clears its key — that is the field the user emptied, and
 * leaving the old value behind would make the screen a liar. Everything else in
 * the file, at both levels, is carried across untouched.
 *
 * A file that would not parse is REFUSED rather than clobbered: the operator's
 * broken JSON is the only record of what they meant.
 */
export function writeSettings(patch: BackendSettingsPatch): SettingsView {
  const { parsed, problem } = readRaw();
  if (problem) throw new Error(`${problem} Nothing was saved — fix or move the file aside first.`);

  const root: Record<string, unknown> = parsed ?? {};
  const existing = root['backend'];
  const backend: Record<string, unknown> =
    typeof existing === 'object' && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};

  const apply = (key: keyof BackendSettingsPatch): void => {
    const value = patch[key];
    if (value === undefined) return;
    if (typeof value === 'string' && value.trim().length === 0) delete backend[key];
    else backend[key] = typeof value === 'string' ? value.trim() : value;
  };
  apply('mode');
  apply('endpointUrl');
  apply('python');
  // Written by the WSL setup runner rather than by a form field. Same merge
  // rule: a key the caller left undefined is untouched, so the settings screen
  // saving a URL cannot wipe the environment the setup screen just built.
  apply('wslDistro');
  apply('vllmPython');

  root['backend'] = backend;

  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return readSettings();
}
