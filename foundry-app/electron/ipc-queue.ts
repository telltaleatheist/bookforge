/**
 * ipc-queue — recents and the job queue.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import * as queue from '@owen/foundry-core/node/job-queue';
import { clearRecents, forgetRecent, listRecents } from '@owen/foundry-core/node/recents';
import { enqueueJob, enqueueTextPassFor, enqueueTriagedCleanupFor, enqueueAnalysisFor, runJobNow } from '@owen/foundry-core/node/doors-queue';
import type { JobRequest, TextPassRequest, AnalyzeRequest, CleanRequest } from '@owen/foundry-core/shared/types';

export function registerQueueDoors(): void {
  // ── Home's list ──────────────────────────────────────────────────────────
  ipcMain.handle('recents:list', () => listRecents());
  ipcMain.handle('recents:forget', (_event, filePath: string) => forgetRecent(filePath));
  ipcMain.handle('recents:clear', () => clearRecents());


  /*
   * ── WHAT THE SHELF DRAWS, WHICH IS NOT ALWAYS FOUNDRY'S OWN LIST ──────────
   *
   * `shelfJobs` rather than `listJobs`, and the difference only exists hosted:
   * with a host queue registered, the rows in this window are the HOST's, pushed
   * per project and accumulated into the one global list this mirror has always
   * been (electron/job-queue.ts). Standalone the two functions answer the same
   * array. The PUSH on `queue:changed` below is the same expression, because a
   * window that asked and a window that was pushed at must not hold different
   * facts — `hostOffers`' rule, one family along.
   */
  ipcMain.handle('queue:list', () => queue.shelfJobs());
  ipcMain.handle('queue:enqueue', (_event, request: JobRequest) => enqueueJob(request));
  /*
   * ── ONE DOOR FOR THREE TEXT PASSES, AND THE CHANNEL KEEPS ITS NAME ─────────
   *
   * A translation, a rewrite and a narration cleanup all arrive here (Owen,
   * 2026-09-05: *"translate, simplify, and cleanup are all three similar steps"*),
   * because everything this door does is the same for all three: re-check the
   * input against the allow-list, resolve the position from the records file's own
   * project, hand it to the one enqueue. A `queue:enqueue-clean` beside this would
   * have been a second channel with an identical body.
   *
   * THE NAME IS NOT CHANGED EITHER, and that is a deliberate refusal rather than
   * an oversight. docs/IPC-CHANNELS.md is BookForge's COLLISION AUDIT — the
   * authority on every name this app owns in a process it shares — and a rename is
   * a new name to audit plus an old one to prove retired, paid for a channel whose
   * behaviour is unchanged. `queue:enqueue-translate` is now the family's door,
   * spelled after its eldest member, and the doc says so.
   */
  ipcMain.handle('queue:enqueue-translate', (_event, request: TextPassRequest) => enqueueTextPassFor(request));
  /*
   * ── A CLEANUP WITH ITS TRIAGE IN FRONT OF IT: ONE PRESS, TWO ROWS ──────────
   *
   * Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with
   * snap and then we bring snap down and load the full normal cleaning logic."*
   * The window sends the cleanup it would have sent to the door above, and
   * `enqueueTriagedCleanup` makes the triage and chains the cleanup behind it.
   *
   * A DOOR OF ITS OWN rather than a flag on `queue:enqueue-translate`, because
   * that door's answer is one row and this act is two — the dialog pins a picked
   * server on both and its Start releases both, so it has to be handed both ids.
   * The whole argument for making the pair in main rather than in the window is
   * at `enqueueTriagedCleanup` (electron/job-queue.ts).
   *
   * THE SAME ADMISSION AND THE SAME POSITION as the door above, because the
   * cleanup is the same request it would have been: its input re-checked against
   * the allow-list, and the position resolved from the project its records file
   * belongs to — which is the triage's position too, since the verdicts are
   * named beside those records. NOT REFUSED HOSTED, on the cleanup's own terms:
   * this act exists only on BookForge's behalf, and the pair routes to its queue.
   */
  ipcMain.handle('queue:enqueue-clean-triaged', (_event, request: CleanRequest) =>
    enqueueTriagedCleanupFor(request));
  /*
   * AN ANALYSIS IS QUEUED THE SAME WAY, and since 2026-10-30 a hosted window
   * queues it too — in the HOST'S queue, which learned the pair (`enqueueAnalysis`,
   * electron/job-queue.ts; Owen: *"analysis is grayed out in foundry/bookforge"*).
   *
   * THE ONE REFUSAL LEFT is a hosted window whose host registered NO queue.
   * Owen's ruling, 2026-08-21: *"when im in bookforge, the shelf shouldnt appear
   * at all"* — so there Foundry's own scheduler would start an hour of GPU with
   * no row anybody in either window can see, cancel or start. A host that keeps a
   * queue is the case that works; one that does not is said by name.
   */
  ipcMain.handle('queue:enqueue-analysis', (_event, request: AnalyzeRequest) => enqueueAnalysisFor(request));
  /*
   * AN EXPORT RUNS AT THE PRESS AND THE ANSWER IS THE SETTLED ROW — the whole of
   * the difference from `queue:enqueue` one door up. The dialog that asked is
   * holding this invoke open for the seconds the run takes, and what it gets
   * back is the row in whatever state it settled: `done` with the filed path,
   * `failed` with the engine's own words, or a still-pending row when something
   * is already writing the same file (`runNow` hands the existing one back, and
   * the caller reads the state to tell the two apart). Never routed to a host
   * queue — an export is seconds of CPU arithmetic somebody is watching for, and
   * the argument lives at `runNow` (electron/job-queue.ts).
   */
  ipcMain.handle('queue:run', (_event, request: JobRequest) => runJobNow(request));
  ipcMain.handle('queue:start', () => queue.start());
  /*
   * ONE ROW, BY NAME — what a dialog's own Start presses. `queue:start` is the
   * shelf's button and releases the whole held batch; this releases the row the
   * caller just made and leaves every other parked row parked. Answers whether
   * it let go, so a dialog that is about to watch the run can tell "running" from
   * "somebody removed it while I was open".
   */
  ipcMain.handle('queue:release', (_event, id: string) => queue.release(id));
  ipcMain.handle('queue:remove', (_event, id: string) => { queue.remove(id); });
  ipcMain.handle('queue:cancel', (_event, id: string) => { queue.cancel(id); });
  ipcMain.handle('queue:clear-finished', () => { queue.clearFinished(); });
  /**
   * THE ROW PICKER'S ONE DOOR — send this row to a different slot.
   *
   * `waitFor` is a slot name or `any` (`ANY_SLOT`, shared/slots.ts). Nothing is
   * answered on the way OUT: the change publishes on `queue:changed` like every
   * other change to a row, and a handler returning the row would be a second
   * copy of it racing the push.
   *
   * A REFUSAL IS NOT NOTHING, THOUGH, and it is deliberately not swallowed here.
   * `setWaitFor` throws a `QueueRoutingRefusal` for a row a GPU has already
   * taken — the race it argues at length — and the throw crosses the preload as
   * a rejected invoke so the picker that sent it can say the sentence. Catching
   * it here would restore exactly the silence that made the race invisible.
   */
  ipcMain.handle('queue:set-wait-for', (_event, id: string, waitFor: string) => {
    queue.setWaitFor(id, waitFor);
  });
}
