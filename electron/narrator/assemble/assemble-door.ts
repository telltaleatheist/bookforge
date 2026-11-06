/**
 * The door the bridges assemble through, for every session.
 *
 * An Orpheus session is refused by name inside (`chapters.ts`): Orpheus is retired and its padded path
 * is not ported (Owen, 2026-11-05: "orpheus is done, yes. deprecated"). Its finished m4b is untouched.
 */

import type { ChildProcess } from 'child_process';
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

export function startAssembly(request: AssemblyRequest): ChildProcess {
  return startWorkerProcess(path.join(__dirname, 'assemble-worker.js'), request, 'assemble_audiobook() Exception: ');
}
