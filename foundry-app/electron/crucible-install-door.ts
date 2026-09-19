/**
 * THE SEAM — the one interface every install surface in Foundry is built on.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.6 gives the orchestrator a door
 * that can be WATCHED and not only driven: `GET /install` answers the outcome
 * and whether a move is running, `GET /install/events` replays a ring of the
 * last 200 events and then follows, and `POST /install` is Try again.
 * `@crucible/bootstrap` carries `installStatus()` and `watchInstall()` over
 * them, and this file is the whole of what Foundry knows about that.
 *
 * ── THE STOPGAP IS OVER ────────────────────────────────────────────────────
 *
 * Part 1 of this phase shipped `preSdkInstallDoor()`, which reported only what
 * this app itself did and answered `outcome: null` always, because the SDK
 * carrying §2.6 had not been cut. It has been (crucible
 * `feat/phase19-automatic-wsl` c687f95, vendored as the labelled pre-release
 * pack — see `app/package.json`'s `_cruciblePhase19Pack`), and the swap is
 * this file. Nothing in `src/` moved: the renderer was built against the three
 * verbs below and against `shared/crucible-install-wire.ts`, which was the
 * point of putting them there.
 *
 * ── WHAT IS STILL FOUNDRY'S AND NOT THE SDK'S ──────────────────────────────
 *
 * The ROWS. `HostEvent` names the host's own steps — `wsl-state`,
 * `import-distro`, `guest-install`, `install-job-types`, `migrate-weights` and
 * the rest — and §3.1 asks for six named rows a person can read. The mapping
 * between them is {@link rowForHostStep}, and it lives here because it is a
 * statement about this app's screen, not about Crucible's sequence.
 */
import {
  hostInstalled,
  installStatus,
  processRunner,
  requestHostInstall,
  watchInstall,
  BootstrapRefusal,
  type HostEvent,
  type HostFetch,
  type InstallStatus,
  type JobTypeRequest,
  type Runner,
} from '@crucible/bootstrap';
import { driveCrucibleInstall } from './crucible-install';
import type {
  CrucibleInstallEvent,
  CrucibleInstallOutcome,
  CrucibleInstallRowId,
  CrucibleInstallStatus,
} from '../shared/crucible-install-wire';

/**
 * THE DOOR, as Foundry uses it. Three verbs and no fourth.
 *
 * `watch` answers the unsubscribe, synchronously, so a window that closes
 * mid-install detaches without waiting on a promise that may be a stream.
 */
export interface CrucibleInstallDoor {
  /** §2.6's `GET /install`: is a move running, and what did the last one do? */
  status(): Promise<CrucibleInstallStatus>;
  /** Attach to the run in flight, or to the next one. Answers the detach. */
  watch(onEvent: (event: CrucibleInstallEvent) => void): () => void;
  /**
   * §2.5's **Try again** — `POST /install`. Drawn only on a `cannot` or a
   * `failed`, because a machine that is done has nothing to try and a machine
   * mid-move is already trying.
   */
  retry(): Promise<void>;
}

/**
 * WHICH §3.1 ROW ONE OF THE HOST'S STEPS BELONGS TO.
 *
 * `crucible/host/installer.py` names its steps and this is that list, folded
 * into the six rows a person reads. The fold is not arbitrary: everything
 * between the state walk and the pairing switch is one thing to somebody
 * watching — the Linux engine being set up — and eleven rows ticking past
 * would be an app showing its own plumbing.
 *
 *   host                                         → Installing Crucible
 *   wsl-state, import-distro, guest-ready,
 *   guest-install, migrate-config, lan-door,
 *   stop-windows-server, switch-pairing          → Setting up the Linux engine
 *   install-job-types                            → Installing what Foundry needs
 *   prepare-weights, migrate-weights             → Downloading models
 *
 * NULL FOR A NAME THIS BUILD DOES NOT KNOW, and the row on screen does not
 * move. Reaching it means the Crucible on this machine is newer than this app;
 * its lines and bytes still land on whatever row is running, which is the
 * honest reading of "something we have no word for is happening inside the
 * step we last named". Inventing a row from the step's own identifier would
 * put `switch-pairing` in front of a person.
 */
export function rowForHostStep(name: string): CrucibleInstallRowId | null {
  if (name === 'host') return 'install';
  if (name === 'install-job-types') return 'job-types';
  if (name === 'prepare-weights' || name === 'migrate-weights') return 'models';
  const MOVE = [
    'wsl-state', 'import-distro', 'guest-ready', 'guest-install',
    'migrate-config', 'lan-door', 'stop-windows-server', 'switch-pairing',
  ];
  return MOVE.includes(name) ? 'linux-engine' : null;
}

/** §2.2's file, as this app's wire spells it. One reading, in one place. */
export function readOutcome(status: InstallStatus): CrucibleInstallOutcome | null {
  const outcome = status.outcome;
  if (outcome === null) return null;
  return {
    state: outcome.state,
    code: outcome.code,
    sentence: outcome.sentence,
    at: outcome.at,
    release: outcome.release,
    attempts: outcome.attempts,
  };
}

/** Everyone attached right now. A set, so a double-detach is not a hole. */
const watchers = new Set<(event: CrucibleInstallEvent) => void>();

/** One run at a time, and the flag this door's `status` falls back on. */
let running = false;

/** Tell every attached window. */
function emit(event: CrucibleInstallEvent): void {
  for (const watcher of [...watchers]) watcher(event);
}

/**
 * THE HOST'S EVENTS, TRANSLATED AND EMITTED — the one place `HostEvent`
 * becomes something a template can draw.
 *
 * ── Two of the six kinds are deliberately not passed straight through ──────
 *
 * `done` is DROPPED. The host's `done` means THE MOVE finished; this app's
 * `done` means the whole sequence finished, backend and all, and it is emitted
 * by {@link runInstallNarrated} after the engine has been started and
 * registered. Forwarding the host's would mark every row after it `skipped`
 * while three of them were still to come.
 *
 * `step` may emit TWO of ours. §3.1's second row is "Starting the Windows
 * engine", and nothing in the host's stream announces it — because by the time
 * the tray is answering its own door at all, the native engine it installed is
 * already up (§2.8: "the native engine is up within seconds of install, and
 * the move runs behind it"). So the FIRST move step is the proof that row is
 * finished, and it is drawn and closed on that proof rather than on a guess.
 */
function relay(event: HostEvent): void {
  switch (event.event) {
    case 'step': {
      const row = rowForHostStep(event.data.name);
      if (row === null) return;
      if (row === 'linux-engine') windowsEngineUp();
      emit({ event: 'step', row, jobType: null });
      return;
    }
    case 'progress':
      emit({
        event: 'progress',
        bytesDone: event.data.bytes_done,
        bytesTotal: event.data.bytes_total,
        file: event.data.file,
      });
      return;
    case 'state':
      emit({ event: 'state', code: event.data.code, sentence: event.data.sentence, action: event.data.action });
      return;
    case 'line':
      emit({ event: 'line', text: event.data.text, stream: event.data.stream });
      return;
    case 'failed':
      emit({ event: 'failed', code: event.data.code, message: event.data.message });
      return;
    case 'done':
      return;
  }
}

/**
 * §3.1's SECOND ROW, DRAWN ONCE PER RUN BY WHICHEVER PROOF ARRIVES FIRST.
 *
 * Two callers and one row. {@link relay} calls it on the tray's first move
 * step, which proves the native engine is up (§2.8). `driveCrucibleInstall`
 * calls it after the installer, for the machine that has no move to prove it
 * with — `declined`, or a tray that decided there was nothing to do. Making it
 * idempotent HERE rather than asking both callers to check is the point: a row
 * that went `running` again after it was `done` would be the list going
 * backwards under somebody watching it.
 */
function windowsEngineUp(): void {
  if (windowsEngineSeen) return;
  windowsEngineSeen = true;
  emit({ event: 'step', row: 'windows-engine', jobType: null });
}

/** Reset per run: the one-shot above is about THIS run's first move step. */
let windowsEngineSeen = false;

/**
 * THE SDK CALLS THIS DOOR MAKES, injectable so a keeper can script a host
 * without opening a socket.
 *
 * `fetchImpl` and `runner` are the SDK's own two seams and this adds none of
 * its own: `installStatus`, `watchInstall` and `requestHostInstall` all take
 * exactly these, and a keeper that had to mock this module instead of the wire
 * would be testing the mock.
 */
export interface InstallDoorWire {
  fetchImpl?: HostFetch;
  runner?: Runner;
}

/**
 * WHICH RELEASE A RETRY ASKS FOR, and it is the outcome's own.
 *
 * §2.5's Try again is the same move again — the one that was refused — so the
 * release is the one it was for, which §2.2 records. Asking the channel here
 * instead would turn a retry into an upgrade nobody pressed a button for, on a
 * machine whose last answer was that it could not do this.
 */
const RETRY_JOB_TYPES: readonly JobTypeRequest[] = ['echo'];

/**
 * THE DOOR OVER `@crucible/bootstrap`.
 *
 * ── Why `status` can answer without asking ────────────────────────────────
 *
 * There is no door on a machine with no host pack — off win32 there is no host
 * at all, and on win32 before `install.ps1` has run there is nothing listening
 * on `:7101`. `installStatus()` would refuse `host_unreachable` there, which is
 * a true sentence about a machine nobody has installed anything on yet and a
 * useless one to draw. So the absence is answered as the absence: nothing
 * running, nothing recorded. That is NOT a fallback — it is the only fact
 * available, and it is distinguished from "the tray is installed and will not
 * answer", which is still raised by name.
 */
export function crucibleInstallDoor(wire: InstallDoorWire = {}): CrucibleInstallDoor {
  const runner = wire.runner ?? processRunner();
  const options = wire.fetchImpl === undefined ? {} : { fetchImpl: wire.fetchImpl };
  return {
    status: async () => {
      if (runner.platform !== 'win32' || !hostInstalled(runner)) return { running, outcome: null };
      const answered = await installStatus(options, runner);
      return { running: answered.running || running, outcome: readOutcome(answered) };
    },
    watch: (onEvent) => {
      watchers.add(onEvent);
      return () => { watchers.delete(onEvent); };
    },
    retry: async () => {
      const before = await installStatus(options, runner);
      const outcome = before.outcome;
      if (outcome === null) {
        throw new BootstrapRefusal(
          'host_install_failed',
          'this machine has no record of an engine move, so there is nothing to try again. '
          + 'Install Crucible here first.',
        );
      }
      windowsEngineSeen = false;
      try {
        await requestHostInstall({
          release: outcome.release, jobTypes: RETRY_JOB_TYPES, ...options, onEvent: relay,
        }, runner);
      } catch (error) {
        /*
         * 409 IS NOT A FAILURE, IT IS A RACE THIS DOOR WINS BY WAITING (§2.6):
         * the tray may have started the same move a moment before the press,
         * and the door's own answer names `/install/events` for exactly this.
         * Every other refusal is raised, including the outcome's own 4c code.
         */
        if (!(error instanceof BootstrapRefusal) || error.code !== 'host_install_running') throw error;
        await watchInstall({ ...options, onEvent: relay }, runner);
      }
    },
  };
}

/**
 * RUN THE SEQUENCE AND NARRATE IT.
 *
 * Exported because main's `crucible:install` door and the renderer's Install
 * button are the same run, and §2.5's Try again is the same run once more
 * through {@link CrucibleInstallDoor.retry} — two entry points that walked
 * different sequences would be two owners of it.
 */
export async function runInstallNarrated(): Promise<void> {
  running = true;
  windowsEngineSeen = false;
  try {
    await driveCrucibleInstall({ event: emit, hostEvent: relay, windowsEngineUp });
  } catch (error) {
    emit({
      event: 'failed',
      code: error instanceof BootstrapRefusal ? error.code : 'install_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    running = false;
  }
}
