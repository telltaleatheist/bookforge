/**
 * The door the bridges assemble through.
 *
 * ORPHEUS STAYS ON THE PYTHON until step 8 (lead's ruling, 2026-11-05): Orpheus is retired and not
 * ported, and its sessions' behaviour does not change before Owen rules. So the session's own
 * recorded engine picks the route. See docs/REORG-PLAN.md.
 *
 * Pre-encoded chapters and a post-render filter are not requests here: both come only from an
 * Orpheus session (the chapter closer, and its de-ring voice filter), which takes the Python.
 */

import type { ChildProcess } from 'child_process';
import { promises as fsp } from 'fs';
import * as path from 'path';

import { startWorkerProcess } from '../worker-process';

export interface AssemblyRequest {
  readonly processDir: string;
  readonly outputDir: string;
  readonly sentencesDir?: string | null;
  readonly chapters?: string | null;
  readonly coverageReport?: string | null;
  readonly chapterGap: number;
  readonly finalDenoise: boolean;
  readonly ffmpeg: string;
  readonly ffprobe: string;
}

/**
 * `python` for an Orpheus session and `typescript` for everything else. A state file that cannot
 * be read goes to the TypeScript, whose reader refuses it by name.
 */
export async function assemblyRoute(processDir: string): Promise<'python' | 'typescript'> {
  try {
    const state = JSON.parse(await fsp.readFile(path.join(processDir, 'session-state.json'), 'utf8')) as Record<string, unknown>;
    return state['tts_engine'] === 'orpheus' ? 'python' : 'typescript';
  } catch {
    return 'typescript';
  }
}

export function startAssembly(request: AssemblyRequest): ChildProcess {
  return startWorkerProcess(path.join(__dirname, 'assemble-worker.js'), request, 'assemble_audiobook() Exception: ');
}
