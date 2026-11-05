/**
 * ipc — every door the renderer may knock on, in one place.
 *
 * Split out of main.ts when the app learned to be hosted (docs/BOOKFORGE-HANDOFF.md
 * §8): registering these is what MOUNTING Foundry means, and it is the same
 * registration whether this process belongs to Foundry or to BookForge. What
 * stayed behind in main.ts is only what a standalone shell owns — the menu, the
 * command line, the process's own lifecycle.
 *
 * EVERY CHANNEL IS NAMESPACED `family:verb`, and that is not a style rule: hosted,
 * these handlers are registered into a main process that has doors of its own, so
 * a bare name is a collision waiting for a version bump. docs/IPC-CHANNELS.md is
 * the enumeration, and it is the input to the audit the copy depends on.
 *
 * The renderer has no Node: it names a path and main decides whether that path is
 * a thing this app will open. `admitted` (electron/documents.ts) is where that is
 * decided, once, for every door that reads.
 */
import { onCoordination } from '@owen/foundry-core/node/crucible-coordinate';
import { onIntakeProgress } from '@owen/foundry-core/node/capture';
import * as queue from '@owen/foundry-core/node/job-queue';
import { onProjectsChanged } from '@owen/foundry-core/node/projects';
import { broadcast } from './window';
import { deleteLedgerStep } from '@owen/foundry-core/node/doors-delete';
import { afterRegistryChanged, adoptPairingFile, sweepAtStartup } from '@owen/foundry-core/node/doors-crucible';
import { registerHostDoors } from './ipc-host';
import { registerDocumentDoors } from './ipc-documents';
import { registerPlanDoors } from './ipc-plans';
import { registerProjectDoors } from './ipc-projects';
import { registerCaptureDoors } from './ipc-capture';
import { registerBookDoors } from './ipc-book';
import { registerAskDoors } from './ipc-ask';
import { registerQueueDoors } from './ipc-queue';
import { registerAppDoors } from './ipc-app';
import { registerCrucibleDoors } from './ipc-crucible';
import { registerCrucibleInstallDoors } from './ipc-crucible-install';
import { registerSlotDoors } from './ipc-slots';

/*
 * THE FOUR NAMES THIS FILE USED TO DEFINE, re-exported so ipc.js offers what it
 * always did. The bodies moved to the doors-*.ts library files on 2026-11-04
 * (docs/FOUNDRY-CORE-PLAN.md step 2); what stayed here is the table of
 * registrations and the halves that need a window, a dialog or the shell.
 */
export { adoptPairingFile, connectLocalEngine } from '@owen/foundry-core/node/doors-crucible';
export { deleteExport, deleteLedgerStep } from '@owen/foundry-core/node/doors-delete';

export function registerIpc(): void {
  registerHostDoors();
  registerDocumentDoors();
  registerPlanDoors();
  registerProjectDoors();
  registerCaptureDoors();
  registerBookDoors();
  registerAskDoors();
  registerQueueDoors();
  registerAppDoors();
  registerCrucibleDoors();
  registerCrucibleInstallDoors();
  registerSlotDoors();

  /*
   * WEIGHTS ON THIS DISK — docs/SLOTS.md §5b's "Models on this machine".
   *
   * The removal is the only door in this app that deletes model files, and it
   * deletes exactly one directory: the one this app downloaded into. Ollama's
   * store is listed beside it and never touched (Owen: *"ollama has its own
   * thing going on and we should leave it be"*), and a local Crucible's line
   * waits on package C. A refusal comes back as a RESULT with a sentence rather
   * than as a rejection, because the row prints what happened either way.
   */
  /*
   * The whole list on every mutation — and hosted, the whole list is the HOST's
   * (`shelfJobs`, electron/job-queue.ts). The queue hands it over already
   * composed rather than this line choosing, so the door above and this push
   * cannot answer differently.
   */
  queue.onQueueChanged((jobs) => broadcast('queue:changed', jobs));
  /*
   * THE LIBRARY CHANGED, said out loud, which it never used to be.
   *
   * The renderer's project list re-read on three occasions — it was constructed,
   * Home appeared, or a queue job landed — and a BACKGROUND IMPORT is none of
   * them. A dropped scan therefore became a project on the disk that the app went
   * on denying the existence of until something unrelated happened to refresh
   * the list, and everything that asks "which project is this document in?" was
   * reading that denial.
   *
   * No payload. The listing is main's to compose and re-composing it costs a
   * directory walk, so this says only THAT something moved; the renderer asks
   * for the list itself, the same way the queue's mirror asks for jobs on boot.
   */
  onProjectsChanged(() => broadcast('projects:changed', null));
  // The same shape one door along: main talks while the invoke is still open,
  // because an intake of a whole shoot is a minute long and a promise that
  // resolves at the end cannot say anything until there is nothing to say.
  onIntakeProgress((progress) => broadcast('capture:intake-progress', progress));

  /*
   * ── DOCS/SLOTS.MD §5b, ONCE AT STARTUP ────────────────────────────────────
   *
   * For the machine where the Crucible was installed while Foundry was closed.
   * `afterRegistryChanged` covers somebody registering the local server while
   * the app is open; neither is the whole of it alone, because a person who runs
   * `crucible install llm` in a terminal and reopens Foundry has changed nothing
   * this app was watching, and their disk is still holding four gigabytes of a
   * page reader the machine no longer needs.
   *
   * IT CANNOT FIRE HOSTED, AND NOT BY A GUARD. Inside BookForge the slot list is
   * the HOST's (SLOTS.md §3) and `AppSettings.crucibleServers` is empty, so
   * `localCrucibleServes` answers `unknown` — which is not a permission to
   * delete. That is the three-valued answer doing the work it was shaped for,
   * rather than a `hosted()` check that would have to be kept in step with a
   * rule written somewhere else.
   *
   * DELIBERATELY NOT AWAITED: it probes every registered server, and blocking
   * the mount on a sleeping Mac would put a three-second stall in front of the
   * first window for a tidy-up nobody is waiting on. A failure is logged and
   * changes nothing — the files stay, and the next registry save asks again.
   */
  /*
   * ── EVERY COORDINATION STATE CHANGE, TO EVERY WINDOW ──────────────────────
   *
   * And that is not laziness about addressing: coordination starts at APP
   * START, before any window has asked for anything, and it is the same fact
   * for the Servers card and for the wizard's Crucible step. A push aimed at
   * "the sender" would have no sender for the run that matters most.
   *
   * THE SECOND HALF IS THE ONE THAT MATTERS TO THE REST OF THE APP. A run that
   * ends `preparing` with `progress.state === 'done'` means the server SERVES
   * MORE THAN IT DID — a text engine it had not installed, a model it had not
   * pulled — and every capability answer this app has cached about it was
   * measured before that. So the registry's own pass runs: forget, re-measure,
   * apply §5b's page-reader rule, light the tiles. Wired HERE rather than
   * inside the coordinate module for the reason its header gives — which
   * windows exist and what an install does to a tile are facts about the app,
   * and that module's whole subject is one conversation with one server.
   *
   * ONLY ON `done`. A `failed` module leaves behind exactly the steps that
   * completed (R6), which is a real change, and re-measuring on it would be
   * right — but a module that failed at step 1 of 4 is also the common case for
   * a server that is mid-something, and a capability sweep per failure would
   * put a probe of every registered machine behind every stumble. The next
   * connect asks again, which is the same answer arriving a moment later.
   */
  onCoordination((state) => {
    broadcast('crucible:coordination-changed', state);
    if (state.phase !== 'preparing' || state.progress.state !== 'done') return;
    void afterRegistryChanged().catch((err: unknown) => {
      console.error(
        `[crucible] "${state.server}" finished preparing, but the capability sweep that `
        + `follows it did not: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });

  sweepAtStartup();
}
