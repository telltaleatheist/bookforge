/**
 * One assembly, in a worker thread. A port of `route_assemble` in `narrator/compat/app.py`: the
 * PCM and the JSON stay off the main process, and a failure comes out as a result the bridge can
 * read rather than as a bare stack. `assemble-door.ts` is the only thing that starts this.
 */

import { setMaxListeners } from 'events';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import { pyJsonDumpsAscii } from '../py-compat';
import { buildManifest } from '../session/session-v1';
import { AssemblyCancelled } from './ffmpeg-tools';
import { assemble } from './run';
import type { AssemblyRequest } from './assemble-door';

const port = parentPort!;
const request = workerData as AssemblyRequest;
const abort = new AbortController();
// One listener per running ffmpeg, and a pool runs up to sixteen.
setMaxListeners(0, abort.signal);
port.on('message', (message: unknown) => {
  if (message === 'cancel') abort.abort();
});
const log = (line: string): void => port.postMessage({ stream: 'stdout', text: `${line}\n` });

(async () => {
  try {
    const manifest = await buildManifest(request.processDir, {
      sentencesDir: request.sentencesDir ?? null,
      chapters: request.chapters ?? null,
      log,
    });
    const result = await assemble(manifest, request.outputDir, {
      ffmpeg: request.ffmpeg,
      ffprobe: request.ffprobe,
      coverageReport: request.coverageReport ?? null,
      chapterGap: request.chapterGap,
      finalDenoise: request.finalDenoise,
      log,
      signal: abort.signal,
    });
    log(pyJsonDumpsAscii({
      success: true,
      session_id: manifest.source.sessionId,
      output_files: [result.m4bPath],
      output_dir: path.resolve(request.outputDir),
    }));
    port.postMessage({ exit: 0 });
  } catch (err) {
    if (err instanceof AssemblyCancelled) {
      port.postMessage({ exit: 1 });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    log(`assemble_audiobook() Exception: ${message}`);
    port.postMessage({ stream: 'stderr', text: `${err instanceof Error ? err.stack : message}\n` });
    log(pyJsonDumpsAscii({ success: false, error: message }));
    port.postMessage({ exit: 1 });
  }
})();
