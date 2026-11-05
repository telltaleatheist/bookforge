/**
 * The door a Higgs prep will go through at the flip: a worker thread, because every document of a book
 * is parsed and packed. It writes `session-state.json` and the bridge reads that, as it does today.
 *
 * NOTHING CALLS THIS YET. It needs the libxml2 binary, which waits on Emscripten.
 */

import type { ChildProcess } from 'child_process';
import * as path from 'path';

import { startWorkerProcess } from '../worker-process';
import type { PrepOptions } from './prep';

export interface PrepRequest {
  readonly ebook: string;
  readonly sessionDir: string;
  readonly options: PrepOptions;
}

export function startPrep(request: PrepRequest): ChildProcess {
  return startWorkerProcess(path.join(__dirname, 'prep-worker.js'), request, 'prep_ebook_info() Exception: ');
}
