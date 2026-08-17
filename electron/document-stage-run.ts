/**
 * document-stage-run — how a stage over a project's documents is ANNOUNCED.
 *
 * A stage is a long piece of work over one project's files, and there are two
 * places one can be started from: a window pressed a button (document-ipc,
 * vlm-convert) or the queue reached a job. What has to happen around it is
 * identical either way, and it was written out twice:
 *
 *  - it is CLAIMED in the shared stage registry, so a reset submitted from
 *    another window sees it and refuses by name rather than being silently
 *    undone by it when the staged temp lands, and so quit can stop it;
 *  - it says `document:stage-started`, every line of `document:stage-progress`
 *    and finally `document:stage-finished` to EVERY window, because a project's
 *    documents change whoever ran the stage — the picker showing that book has
 *    to hear about it, and the conversion dialog watches these three channels
 *    and nothing else;
 *  - `document:stage-finished` fires from a `finally`, because a stage that
 *    FAILED still stopped and a window waiting for it to stop has to stop
 *    waiting. What it changed on disk is measured afterwards, never inferred
 *    from the fact that it ended.
 *
 * One description of all of it, here. Callers differ only in what they do with
 * the CONTROLLER: one that has somewhere else to register it hands its own in,
 * and otherwise `document:cancel-stage` finds it through the registry.
 */

import { BrowserWindow } from 'electron';

import { publishBridgeEvent } from './bridge-events';
import { beginStage, recordStageProgress } from './document-stage-registry';
import type { DocumentStageProgress } from './document-stages';

/**
 * Send a message to every live window. A project's files belong to no one window.
 *
 * It is also published on the main-side bus, because the queue engine lives in
 * THIS process now and a `webContents.send` cannot be heard here — a conversion
 * step has to follow the same three channels the conversion dialog does.
 */
export function broadcastToAllWindows(channel: string, payload: unknown): void {
  publishBridgeEvent(channel, payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export interface ProjectStageOptions {
  readonly signal: AbortSignal;
  readonly onProgress: (progress: DocumentStageProgress) => void;
}

/**
 * Run one stage over a project: claimed, announced, and settled.
 *
 * `stage` is the name that travels with every line and with the failure, because
 * "which stage said this" is the whole of what makes foundry's own message
 * actionable — and it is the name windows match on, so it is the user-facing one
 * ('Get Text', 'Footnote removal') rather than a pass kind.
 *
 * The caller may hand in its own `controller` when it has somewhere else to
 * register it (a queue job id). Omitted, one is made here and the registry is
 * the only way to reach it, which is exactly what `document:cancel-stage` does.
 */
export async function withProjectStage<T>(
  projectDir: string,
  stage: string,
  run: (opts: ProjectStageOptions) => Promise<T>,
  controller: AbortController = new AbortController()
): Promise<T> {
  const release = beginStage(projectDir, stage, controller);
  broadcastToAllWindows('document:stage-started', { projectDir, stage });
  try {
    return await run({
      signal: controller.signal,
      onProgress: (progress) => {
        // Recorded BEFORE it is broadcast: the registry's copy is what a window
        // that missed this line gets when it comes back and asks, so it must
        // never be the one thing that did not happen.
        recordStageProgress(projectDir, { ...progress, at: Date.now() });
        broadcastToAllWindows('document:stage-progress', { projectDir, ...progress });
      },
    });
  } finally {
    release();
    broadcastToAllWindows('document:stage-finished', { projectDir, stage });
  }
}
