/**
 * The door `electron/coverage-align-job.ts` measures a book through: a worker thread, because every
 * chunk's PCM is decoded and scanned. It takes no card and loads no model.
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';

import { startWorkerProcess } from '../worker-process';

export interface AlignRequest {
  readonly processDir: string;
  /** A Crucible `align` artifact: the model's items per chunk. */
  readonly alignmentPath: string;
  readonly reportPath: string;
  /** Defaults to `<book stem>.sentences.vtt` beside the session, which is what binds it to the book. */
  readonly vttPath?: string;
  readonly language: string;
  /** The silence assembly will leave between chapters: these cues are timed against the finished book. */
  readonly chapterGap: number;
  readonly ffmpeg: string;
}

export function startAlignment(request: AlignRequest): ChildProcess {
  return startWorkerProcess(path.join(__dirname, 'align-worker.js'), request, 'Error: ');
}
