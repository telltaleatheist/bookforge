/**
 * What the bridges are saying, heard IN MAIN.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every long-running bridge in this app reports the same way: it holds the main
 * window and calls `webContents.send('<bridge>:progress', …)`. That was correct
 * when the scheduler lived in the renderer — the only listener WAS the renderer.
 * It is not correct now that main owns the queue, because a `webContents.send`
 * cannot be heard on this side of the wire: the queue engine would have to ask
 * the renderer to tell it what its own child processes were doing.
 *
 * So each bridge's ONE send helper — `rendererSend` in parallel-tts-bridge,
 * `sendProgress` in reassembly/rvc/video/generate-sentences, `emitProgress` in
 * bilingual-assembly — also publishes here, with the SAME channel name and the
 * SAME payload. Nothing about the wire changes: the renderer keeps receiving
 * exactly what it received before, which is what lets a modal that listens to
 * `parallel-tts:progress` on its own keep working. What is added is that main
 * can now hear it too.
 *
 * ── Why a bus rather than callbacks threaded through ────────────────────────
 *
 * Because the bridges are re-entrant in ways a callback argument cannot express:
 * `startParallelConversion` returns the moment the workers are spawned and the
 * run finishes minutes later on `parallel-tts:complete`; a resume emits from a
 * different function than the one that was called; a worker's exit handler emits
 * from a process event. Threading a callback to every one of those is the change
 * this refactor is explicitly not making — the bridges work, and only who
 * listens to them is moving.
 *
 * The payloads are NOT typed here on purpose. This file must not import a bridge
 * (they import it), so the shapes are declared by the step module that consumes
 * each channel, next to the mapping that reads them.
 */
import { EventEmitter } from 'node:events';

const bus = new EventEmitter();
// A step module subscribes per run; a busy queue can hold a dozen at once, and
// the default ceiling of 10 would print a leak warning for correct behaviour.
bus.setMaxListeners(0);

/** Publish what a bridge just sent to the renderer, for main-side listeners. */
export function publishBridgeEvent(channel: string, payload: unknown): void {
  bus.emit(channel, payload);
}

/** Listen to a bridge channel. Returns the unsubscribe. */
export function onBridgeEvent<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (payload: unknown): void => {
    try {
      listener(payload as T);
    } catch (err) {
      // A listener that throws must not take down the bridge that emitted. The
      // failure is named rather than swallowed silently.
      console.error(`[BRIDGE-EVENTS] listener for ${channel} threw:`, err);
    }
  };
  bus.on(channel, wrapped);
  return () => { bus.off(channel, wrapped); };
}

/**
 * The next event on `channel` that `match` accepts.
 *
 * Rejects if `signal` aborts, so a cancelled step stops waiting for a completion
 * that is never coming rather than holding its slot forever.
 */
export function waitForBridgeEvent<T>(
  channel: string,
  match: (payload: T) => boolean,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let unsub: (() => void) | null = null;
    let onAbort: (() => void) | null = null;
    const settle = (): void => {
      if (unsub) unsub();
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
    };
    unsub = onBridgeEvent<T>(channel, (payload) => {
      if (!match(payload)) return;
      settle();
      resolve(payload);
    });
    if (signal) {
      if (signal.aborted) {
        settle();
        reject(new Error(`Stopped while waiting for ${channel}.`));
        return;
      }
      onAbort = () => {
        settle();
        reject(new Error(`Stopped while waiting for ${channel}.`));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
