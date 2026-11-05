/**
 * ipc-crucible-install — installing, starting and removing Crucible, its models, and its coordination.
 *
 * Registered by `registerIpc` (ipc.ts), in its order.
 */
import { ipcMain } from 'electron';
import { writeAppSettings } from '@owen/foundry-core/node/app-settings';
import { coordinateServer, coordinationStates } from '@owen/foundry-core/node/crucible-coordinate';
import { engineCatalog, pullSubject, removeModel } from '@owen/foundry-core/node/crucible-models';
import { crucibleInstallDoor } from '@owen/foundry-core/node/crucible-install-door';
import { crucibleRepairDoor, localCruciblePresence } from '@owen/foundry-core/node/crucible-repair';
import { crucibleUninstallAvailability, crucibleUninstallDryRun } from '@owen/foundry-core/node/crucible-uninstall';
import type { CrucibleUninstallFlags, CrucibleUninstallPlan, CrucibleUninstallRun } from '@owen/foundry-core/shared/uninstall-wire';
import { type NewJobsWaitFor } from '@owen/foundry-core/shared/slots';
import * as queue from '@owen/foundry-core/node/job-queue';
import { broadcast } from './window';
import { confirmRemoveModel } from '@owen/foundry-core/node/doors-questions';
import { runInstallAndCoordinate, restartWindows, uninstallCrucible, offerCrucibleStart, startCrucibleAndConnect } from '@owen/foundry-core/node/doors-crucible';
import type { Asked } from '@owen/foundry-core/shared/types';

export function registerCrucibleInstallDoors(): void {
  /*
   * THE SEAM, BUILT ONCE (electron/crucible-install-door.ts). It is the SDK's
   * `installStatus()` / `watchInstall()` / `POST /install` now; the pre-SDK
   * stopgap part 1 shipped is gone, and this one expression was the whole of
   * the swap.
   */
  const installDoor = crucibleInstallDoor();
  installDoor.watch((event) => broadcast('crucible:install-event', event));
  /**
   * THE DRIVEN INSTALL — and it refuses, today, by name.
   *
   * The button is disabled in the renderer with the same sentence this throws,
   * and the door refuses anyway: something reachable by an IPC message must
   * refuse at the door as well, or the disabling is a decoration (the Servers
   * card's hosted refusal makes the same argument). The refusal it still makes
   * is the HOSTED one — "Install Crucible from BookForge." — which PHASE19 §5
   * keeps by name; `@crucible/bootstrap` has been vendored since 1.0.0 and the
   * run itself is real.
   */
  ipcMain.handle('crucible:install', () => runInstallAndCoordinate(installDoor));
  /*
   * ── THE INSTALL DOOR'S THREE READS, PHASE19 §2.6 ──────────────────────────
   *
   * `status` and `event` used to be one thing — a string per line, pushed to
   * the window that pressed the button, gone the moment that window looked
   * away. §2.6 splits them because the move outlives the press: the tray runs
   * it, a restart happens in the middle, and the app that comes back has to be
   * able to ASK where it got to rather than only to have been listening.
   *
   * The watch is BROADCAST and not sent to the pressing window: a person who
   * opens Settings while the wizard is installing is looking at the same one
   * machine, and a second window drawing an empty list would be this app
   * pretending the install belongs to a window.
   */
  /*
   * AND THE ASK IS ALSO THE ATTACH.
   *
   * §2.3 put the move's start in the tray, so the ordinary running move is one
   * no window pressed a button for — and until 2026-09-19 a window that opened
   * onto one read `running: true` here and then sat under five waiting rows,
   * because `watch` fans out events this process was never being sent. Asking
   * where the move got to and joining its stream are the same question, so
   * they are the same call: the door replays its ring and the rows fill in.
   *
   * It is idempotent and it never starts anything (see `attach`), so the
   * second window to open costs the tray one question and nothing else.
   */
  ipcMain.handle('crucible:local-presence', () => localCruciblePresence());
  /**
   * THE REPAIR DOOR. It answers when the repair ends, which can be hours on a
   * hash of hundreds of gigabytes, and every step is pushed to every window so
   * a Settings page that comes back can pick it up from `repair-states`.
   */
  const repairDoor = crucibleRepairDoor();
  repairDoor.watch((state) => broadcast('crucible:repair-state', state));
  ipcMain.handle('crucible:repair', (_event, server: string | null, verifyOnly: boolean) =>
    repairDoor.run(server, verifyOnly));
  ipcMain.handle('crucible:repair-states', () => repairDoor.states());
  ipcMain.handle('crucible:repair-stop', (_event, server: string | null) => repairDoor.stop(server));
  ipcMain.handle('crucible:install-status', async () => {
    const answered = await installDoor.status();
    if (answered.running) installDoor.attach();
    return answered;
  });
  ipcMain.handle('crucible:install-retry', () => runInstallAndCoordinate(installDoor, installDoor.retry));
  /**
   * RESTART NOW — §2.3, and it is the only thing in Foundry that reboots a
   * machine.
   *
   * `shutdown.exe /r /t 5` AS THE INTERACTIVE USER: no elevation, because
   * restarting your own session needs none, and the five seconds are what let
   * somebody see the window acknowledge the press. It runs ONLY when pressed —
   * §2.3 is explicit that "the reboot is never taken by Crucible", and this
   * door is a person's press crossing the preload, never a consequence of
   * reading an outcome.
   *
   * `detached` and `unref` because Electron is about to be killed by the very
   * process it spawned; a child still parented to a dying main is a race with
   * nothing to win.
   */
  ipcMain.handle('crucible:restart-windows', () => restartWindows());
  /*
   * ── UNINSTALL: THREE DOORS, AND THE FIRST ONE DECIDES THE OTHER TWO ───────
   *
   * crucible `docs/INSTALL-UNINSTALL.md` §6.1, and Owen's ruling with it: the
   * door is drawn only for a server this app can PROVE is this machine's, and
   * never for a registry entry as such. `crucible:uninstall-availability` is
   * that one proof — the card asks it before it draws a button and both doors
   * below refuse on it as well, because a control that is hidden over a door
   * that is open has been decorated rather than locked.
   *
   * Everything about what is invoked, and why win32 needs `cmd.exe` to run a
   * `.cmd`, is in electron/crucible-uninstall.ts. Nothing about it is composed
   * here; these three are a read and two runs.
   */
  ipcMain.handle('crucible:uninstall-availability', () => crucibleUninstallAvailability());
  /**
   * THE PLAN, UNPERFORMED — §6.4 step 1, and the card re-asks it every time a
   * checkbox moves so the kept-weights headline moves with it.
   *
   * An exit code of 1 is still a plan (§6.2): the JSON's `ok: false` names the
   * one step that failed and the others happened. Only a usage error and a
   * document that is not a document are rejections — see the module.
   */
  ipcMain.handle('crucible:uninstall-dry-run', (
    _event,
    flags: CrucibleUninstallFlags,
  ): Promise<CrucibleUninstallPlan> => crucibleUninstallDryRun(flags));
  /**
   * THE REAL RUN, and the one thing Foundry does afterwards that the verb cannot.
   *
   * §2's box: *"THE TOKEN ALWAYS GOES, on every uninstall, including the default
   * one."* So a run that stopped the engine has left the registry row pointing at
   * it holding a dead credential, and the row goes — through the registry's one
   * writer, followed by `afterRegistryChanged`, which is what every other write
   * in this file does and what keeps the dock's gates and the slot list honest.
   *
   * ONLY WHEN THE PROOF NAMED A ROW. A `windows-host` proof says a host is
   * installed on this computer and says nothing about which entry, if any, points
   * at the engine it drives; removing a row on that basis would be the app
   * guessing at exactly the thing §6.1 forbids guessing at.
   *
   * COORDINATION STATE IS LEFT TO THE NEXT CONNECT, deliberately. The map in
   * crucible-coordinate.ts is keyed by registry name, the Servers card looks a
   * row's state up BY the row's name, and there is no row any more — so the
   * stale entry draws nothing anywhere. Registering a server under that name
   * again coordinates afresh and overwrites it. Clearing it would mean a new
   * export from that module for an entry nobody can see.
   */
  ipcMain.handle('crucible:uninstall', (
    _event,
    flags: CrucibleUninstallFlags,
  ): Promise<CrucibleUninstallRun> => uninstallCrucible(flags));
  ipcMain.handle('crucible:set-wsl-distro', (_event, distro: string) =>
    writeAppSettings({ wslDistro: distro }).wslDistro);
  /**
   * THE LIVE QUEUE'S DIAL — Owen's *"global crucible server option"*.
   *
   * ANY NAME IS ACCEPTED, including one no server currently answers to, and the
   * clamp is the only thing between the argument and the file. That is the same
   * decision BookForge took and for the reason they gave: a dial pointing at a
   * machine somebody has switched off must KEEP its value, or turning a server
   * off would silently re-point the queue at a different one. "Switched off",
   * "renamed" and "never existed" are one state to a settings writer, and the
   * PLACEMENT is where they are told apart and said out loud.
   *
   * The pump is woken because a dial that has just been widened is a dial that
   * may have unparked something, and a board that has gone quiet would otherwise
   * sit on that row until somebody pressed something else.
   */
  /**
   * IS THERE A CRUCIBLE HERE THAT IS NOT RUNNING, AND SHALL WE START IT?
   *
   * Owen, 2026-09-15 (relayed): *"the foundry app should ask if they want to
   * start crucible."* Standalone only — `crucibleRunState` answers `not-ours`
   * hosted, and that becomes `answered: 'later'` below, so the vendored copy
   * inside BookForge draws no card. BookForge has already offered by the time
   * anybody reaches Foundry there.
   *
   * ANSWERED RATHER THAN ASKED IS THE ORDINARY CASE, and it is why this is a
   * question door rather than a state read the renderer branches on: running,
   * absent, unhealthy and hosted all resolve without a card, so nothing flickers
   * on the startups where there is nothing to say.
   *
   * ── THE THREE ANSWERS, AND WHY SILENCE IS ONE OF THEM ───────────────────
   *
   * Owen met the old version of this door on 2026-09-17 with a perfectly healthy
   * engine and was told to repair his installation, because every state that was
   * not `running`, `stopped` or `absent` came through as one word and drew one
   * card. electron/crucible-start.ts carries the full account of what had really
   * happened — a three-second timeout on `/v1/info` — and why the fold is gone.
   * What is left here is the consequence:
   *
   *   * `stopped` and `unreachable` compose the OFFER. Something is installed
   *     and nothing is serving, and the press is the repair.
   *   * `unhealthy` composes NOTHING. It answered its ping, so there is nothing
   *     to start; and the Servers card watches that machine continuously, so a
   *     card here would be a second, worse voice on a question already covered.
   *     It is logged, because somebody reporting "it feels slow" deserves to
   *     have this line in the file.
   *   * `problem` composes the alarm — and now only ever over a fault in the
   *     installation, in that fault's own words rather than in a sentence that
   *     names two possibilities and then an action fitting one of them.
   *
   * THE CARD NAMES THE MANAGED SERVICE, NOT A ONE-OFF RUN, because the thing a
   * person is agreeing to is something that stays up after Foundry closes, which
   * is a different promise from "run this once" and one they should make
   * knowingly.
   */
  ipcMain.handle('crucible:offer-start', (): Promise<Asked<'start' | 'later'>> => offerCrucibleStart());
  /**
   * THE PRESS. Answered with a SENTENCE and never with a throw: every way this
   * can end — started, launched-but-still-coming-up, nothing here to start — is
   * a fact somebody should read, and a rejected invoke would arrive at the
   * renderer as an unhandled error with the interesting half missing.
   */
  ipcMain.handle('crucible:start', () => startCrucibleAndConnect());
  /**
   * WHAT THIS ENGINE HOLDS AND COULD HOLD — `GET /v1/catalog`, mapped.
   *
   * A READ AND NOTHING ELSE: it downloads nothing, loads nothing onto a card,
   * and is safe against a machine somebody is using. The card calls it on open
   * and after a pull lands, which is when the answer changes.
   */
  ipcMain.handle('crucible:catalog', (_event, server: string) => engineCatalog(server));
  /**
   * FETCH ONE SUBJECT. Answered with the TASK ID, not with the finished pull.
   *
   * A model is gigabytes over somebody's line, so the progress arrives on
   * `crucible:pull-progress` afterwards rather than this handler holding a
   * promise for an hour — a renderer cannot even be told about one that long.
   * Every frame carries the server, the kind and the id, so a card with two
   * pulls running places them without keeping a map of its own.
   */
  ipcMain.handle('crucible:pull', (_event, server: string, kind: string, id: string) =>
    pullSubject(server, kind, id, (progress) => {
      broadcast('crucible:pull-progress', progress);
    }));
  /**
   * ARE YOU SURE — composed in MAIN, because main is what knows the size.
   *
   * The SDK's condition on the remove door survives Owen's reversal of who may
   * call it: *"An app does not call this on a user's behalf without saying so on
   * screen."* So the press goes through the same card every destructive question
   * in this app uses, and the card is given the FIGURE — a person deciding
   * whether to free 17.3 GB is deciding something different from a person told
   * only that a file will go.
   *
   * `keep` is the dismissal, and it is the safe half: a question nobody answered
   * has not been agreed to.
   */
  ipcMain.handle(
    'crucible:confirm-remove-model',
    (_event, ask: { server: string; id: string; name: string | null; bytes: number | null }):
    Asked<'remove' | 'keep'> => confirmRemoveModel(ask),
  );
  /**
   * AND THE REMOVAL ITSELF. The server's four refusals arrive as they are —
   * `subject_in_use` naming what holds it is a different thing to do about it
   * than `subject_remove_failed` naming a file that would not go.
   */
  ipcMain.handle('crucible:remove-model', (_event, server: string, kind: string, id: string) =>
    removeModel(server, kind, id));
  ipcMain.handle('crucible:set-queue-gpu-dial', (_event, dial: string) => {
    const stored = writeAppSettings({ queueGpuDial: dial }).queueGpuDial;
    queue.venueRulesChanged();
    return stored;
  });
  ipcMain.handle('crucible:set-new-jobs-wait-for', (_event, choice: NewJobsWaitFor) =>
    writeAppSettings({ newJobsWaitFor: choice }).newJobsWaitFor);
  /*
   * ── COORDINATION: THE BUTTON THAT IS NOT THERE ────────────────────────────
   *
   * crucible `docs/PHASE14-ENVPACKS.md` §4a. There is no "set up this server
   * for Foundry" verb and no consent step: presence of the app is the request,
   * so Foundry coordinates with every enabled server it connects to and a
   * screen only ever READS the state. `electron/crucible-coordinate.ts` is the
   * one owner — these two doors start a run and read the map, and neither
   * composes a sentence, because the words are the renderer's
   * (`src/app/core/crucible-words.ts`; R1).
   */
  ipcMain.handle('crucible:coordination', () => coordinationStates());
  /**
   * Coordinate with one named server NOW, and answer the state it reached.
   *
   * Idempotent and concurrency-safe in `crucible-coordinate.ts`: a second call
   * while one is in flight joins the first. So the start sweep and a card that
   * asks about the same server a moment later are ONE run, not two — which is
   * the `task_busy` this whole design exists to avoid, manufactured by us.
   *
   * IT IS A DOOR AND NOT A BUTTON. Nothing in this app draws a control that
   * calls it; it exists so a screen that has just learnt about a server can ask
   * about that server rather than waiting for a push that has already been sent.
   */
  ipcMain.handle('crucible:coordinate', (_event, name: string) => coordinateServer(name));
}
