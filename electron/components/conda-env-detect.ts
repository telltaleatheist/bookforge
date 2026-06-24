/**
 * Shared external-detection helper: candidate locations for a named conda env
 * (envs/<name>) under the common conda/miniforge/anaconda installs, per platform.
 * Used by the point-to-your-env engine components (orpheus is inline; voxtral-env
 * and f5-env use this) so a user who builds their own env is auto-detected.
 */
import * as os from 'os';
import * as path from 'path';
import type { Platform } from './component-types';

export function namedCondaEnvCandidates(name: string): { platform: Platform; path: string }[] {
  const home = os.homedir();
  const out: { platform: Platform; path: string }[] = [];
  const unixRoots = [
    path.join(home, 'miniforge3'),
    path.join(home, 'Miniforge3'),
    path.join(home, 'miniconda3'),
    path.join(home, 'anaconda3'),
    '/opt/conda',
    '/opt/homebrew/Caskroom/miniconda/base',
    '/opt/homebrew/Caskroom/miniforge/base',
  ];
  const winRoots = [
    path.join(home, 'Miniforge3'),
    path.join(home, 'miniconda3'),
    path.join(home, 'Miniconda3'),
    path.join(home, 'anaconda3'),
    path.join(home, 'Anaconda3'),
    'C:\\ProgramData\\Miniforge3',
    'C:\\ProgramData\\miniconda3',
    'C:\\ProgramData\\Anaconda3',
  ];
  for (const r of unixRoots) {
    out.push({ platform: 'darwin', path: path.join(r, 'envs', name) });
    out.push({ platform: 'linux', path: path.join(r, 'envs', name) });
  }
  for (const r of winRoots) {
    out.push({ platform: 'win32', path: path.join(r, 'envs', name) });
  }
  return out;
}
