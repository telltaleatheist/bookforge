/**
 * One prep, in a worker thread. The port of the last half of narrator's prep route: narrator's own refusals leave as a
 * sentence, and anything else as the failure the door always printed.
 */

import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';

import { writeCover } from './cover';
import { UnsupportedInput } from './epub';
import { Libxml2Wasm } from './html/libxml2-wasm';
import { UnsupportedEngine, prepSession } from './prep';
import type { PrepRequest } from './prep-door';

const port = parentPort!;
const request = workerData as PrepRequest;
const log = (line: string): void => port.postMessage({ stream: 'stdout', text: `${line}\n` });

// A stop leaves at the next await. Prep spawns nothing, so there is nothing else to wait for.
port.on('message', (message) => {
  if (message === 'cancel') port.postMessage({ exit: 1 });
});

(async () => {
  try {
    await prepSession(path.resolve(request.ebook), path.resolve(request.sessionDir), request.options, new Libxml2Wasm(), writeCover, log);
    port.postMessage({ exit: 0 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof UnsupportedInput || err instanceof UnsupportedEngine) {
      log(`Error: ${message}`);
    } else {
      log(`prep_ebook_info() Exception: ${message}`);
      port.postMessage({ stream: 'stderr', text: `${err instanceof Error ? err.stack : message}\n` });
      log('{"success": false, "error": "prep_ebook_info failed"}');
    }
    port.postMessage({ exit: 1 });
  }
})();
