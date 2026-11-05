/**
 * One prep, in a worker thread. The port of `route_prep`'s last half: narrator's own refusals leave as a
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
      log(JSON.stringify({ success: false, error: 'prep_ebook_info failed' }));
    }
    port.postMessage({ exit: 1 });
  }
})();
