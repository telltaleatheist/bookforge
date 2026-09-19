/**
 * THE ONE SEAM BETWEEN THIS APP AND THE ORCHESTRATOR'S INSTALL DOOR.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.6. The door is three verbs —
 * `GET /install`, `GET /install/events`, `POST /install` — and
 * `@crucible/bootstrap` wraps them as `installStatus()`, `watchInstall()` and
 * `requestHostInstall()`. Everything in BookForge that wants to know how the
 * move is going asks {@link CrucibleInstallDoor} and nothing else.
 *
 * ── THE STOPGAP IS OVER (2026-09-19) ───────────────────────────────────────
 *
 * `PreSdkInstallDoor` stood here for a day: a class fed by this app's own
 * install events, which could only ever see a move THIS PROCESS ran, could not
 * produce `reboot-pending` because the vendored SDK's action union had no
 * `reboot` in it, and could not produce `declined` at all. Every one of those
 * is now a real answer off the door, so the class is deleted rather than kept
 * beside its replacement. What survives it is this file's INTERFACE, which is
 * what let the swap happen without a renderer, an IPC channel or a component
 * changing.
 *
 * ── WHAT IS STILL THIS FILE'S OWN WORK ─────────────────────────────────────
 *
 *  1. **Fan-out.** `watchInstall()` is one call that follows a move to its end.
 *     Several windows may be watching one machine's one move, so this holds the
 *     single watch and hands every subscriber its own unsubscribe.
 *  2. **The terminal event.** The SDK reports `failed` as a mid-stream event and
 *     the OUTCOME FILE as the record of how it ended (§2.2). The renderer draws
 *     the outcome, so the terminal event is emitted from `watchInstall()`'s
 *     RESOLUTION, where the real outcome is, and never from a `failed` frame,
 *     which is one step's news rather than the machine's.
 *  3. **Not asking a door that is not there.** A machine with no host pack has
 *     had no move, which is `{running: false, outcome: null}` from a FILE TEST
 *     (`hostInstalled`) rather than a refusal from a socket nothing is
 *     listening on. A host that IS installed and will not answer is a real
 *     refusal and it surfaces.
 */
import {
  TERMINAL_OUTCOME_STATES,
  hostInstalled,
  installStatus,
  requestHostInstall,
  watchInstall,
  type HostEvent,
  type Runner,
  type WslOutcome,
} from '@crucible/bootstrap';

import type {
  CrucibleInstallDoorEvent,
  CrucibleInstallDoorStatus,
  CrucibleInstallOutcome,
} from '../../shared/crucible/install-door-wire';
import { crucibleProcessRunner } from './host-runner';
import { bookforgeJobTypes } from './install';

/**
 * THE APP'S OUTCOME SHAPE IS THE SDK'S, AND THE COMPILER IS WHAT SAYS SO.
 *
 * `shared/crucible/install-door-wire.ts` cannot import `@crucible/bootstrap` —
 * it is compiled into the RENDERER, which has no Node and no installer — so the
 * five states and the six fields are written out there a second time. That is
 * two owners of one shape, and this is the thing comparing them: an identity
 * function typed `(WslOutcome) => CrucibleInstallOutcome` only compiles while
 * the SDK's document is assignable to the app's. A field the SDK renames, drops
 * or retypes is a COMPILE ERROR here rather than an `undefined` on a screen.
 */
const asAppOutcome = (outcome: WslOutcome): CrucibleInstallOutcome => outcome;

/**
 * IS THIS OUTCOME ONE THE APP STOPS WAITING ON? The SDK's list, never a local
 * one (§2.8).
 *
 * It matters which: `failed` is NOT terminal, because the tray retries a
 * failure once and an app that coordinated after the first would install
 * gigabytes onto an engine about to be replaced by the second attempt. The app
 * held a hand-written `outcome !== null` for a day and that rule was wrong in
 * exactly that case.
 */
export function installOutcomeIsTerminal(outcome: CrucibleInstallOutcome | null): boolean {
  return outcome !== null && TERMINAL_OUTCOME_STATES.includes(outcome.state);
}

/**
 * THE DOOR. Three verbs, and the app knows no other way to ask about a move.
 *
 * `watch` returns its own unsubscribe rather than taking a token, because
 * every caller in this app is a window that can be destroyed and the
 * unsubscribe is the thing they hold.
 */
export interface CrucibleInstallDoor {
  /** `GET /install` — is a move running, and what did the last one come to? */
  status(): Promise<CrucibleInstallDoorStatus>;
  /**
   * `GET /install/events` — every event of the running move, from where it is
   * now. Returns the unsubscribe.
   */
  watch(onEvent: (event: CrucibleInstallDoorEvent) => void): () => void;
  /**
   * `POST /install` — **Try again**, and nothing else. §2.5: this is the apps'
   * ONE WSL control, shown only when the outcome is `cannot` or `failed`.
   */
  start(): Promise<void>;
}

/** One `HostEvent` → the app's shape. A rename and nothing else. */
function appEvent(event: HostEvent): CrucibleInstallDoorEvent | null {
  if (event.event === 'step') {
    return {
      event: 'step',
      name: event.data.name,
      index: event.data.index,
      total: event.data.total,
      detail: '',
    };
  }
  if (event.event === 'progress') {
    return {
      event: 'progress',
      file: event.data.file,
      bytes_done: event.data.bytes_done,
      bytes_total: event.data.bytes_total,
    };
  }
  if (event.event === 'state') {
    return {
      event: 'state',
      code: event.data.code,
      sentence: event.data.sentence,
      action: event.data.action,
    };
  }
  if (event.event === 'line') {
    // The step a line belongs to is the last `step` event's; the SDK says so
    // and {@link HostInstallDoor} keeps it rather than guessing per line.
    return { event: 'line', step: '', stream: event.data.stream, text: event.data.text };
  }
  /*
   * `done` AND `failed` ARE NOT FORWARDED FROM HERE. Both are one frame's news
   * about a sequence, and the thing the app draws is the OUTCOME — which is a
   * file the tray writes at every terminal point and `GET /install` answers
   * with. The terminal event is emitted where that outcome is known, in
   * {@link HostInstallDoor.follow}.
   */
  return null;
}

/** The world this reads, named so a keeper can drive every branch without a socket. */
export interface InstallDoorHost {
  /** The runner the SDK spawns and reads files through. */
  runner(): Runner;
  status(runner: Runner): Promise<Awaited<ReturnType<typeof installStatus>>>;
  watch(
    sinks: { onEvent: (event: HostEvent) => void; decisionWaitMs?: number },
    runner: Runner,
  ): Promise<Awaited<ReturnType<typeof watchInstall>>>;
  post(release: string, runner: Runner): Promise<void>;
  /** Is there a host pack on this machine at all? A file test, not a ping. */
  installed(runner: Runner): boolean;
}

/**
 * The real door. `crucibleProcessRunner()` and not the package's own
 * `processRunner()`, for `host-runner.ts`'s reason: the Windows CLI is a
 * `.cmd` and Node has refused to spawn one without a shell since the
 * CVE-2024-27980 fix.
 */
export function processInstallDoorHost(): InstallDoorHost {
  return {
    runner: crucibleProcessRunner,
    status: (runner) => installStatus({}, runner),
    watch: (sinks, runner) => watchInstall(sinks, runner),
    post: async (release, runner) => {
      await requestHostInstall({ release, jobTypes: bookforgeJobTypes() }, runner);
    },
    installed: hostInstalled,
  };
}

/**
 * THE DOOR, OVER THE SDK.
 *
 * One of these lives for the life of the main process; `main.ts` constructs it
 * and nothing else does.
 */
export class HostInstallDoor implements CrucibleInstallDoor {
  private readonly watchers = new Set<(event: CrucibleInstallDoorEvent) => void>();
  /** The one `watchInstall` in flight, or null. Several windows, one follow. */
  private following: Promise<void> | null = null;
  /** The last `step` name, which is what a `line` belongs to (the SDK's rule). */
  private step = '';

  constructor(private readonly host: InstallDoorHost = processInstallDoorHost()) {}

  async status(): Promise<CrucibleInstallDoorStatus> {
    const runner = this.host.runner();
    /*
     * A MACHINE WITH NO HOST PACK HAS HAD NO MOVE. That is not a refusal
     * swallowed: `hostInstalled` is a file test on the host's own entry point,
     * and "there is no door" and "the door will not answer" are different
     * facts with different fixes. The second one still surfaces, because this
     * only short-circuits on the first.
     *
     * Off Windows it is the same answer for a stronger reason: there is no WSL
     * move to have an outcome about.
     */
    if (runner.platform !== 'win32' || !this.host.installed(runner)) {
      return { running: false, outcome: null };
    }
    const status = await this.host.status(runner);
    return {
      running: status.running,
      outcome: status.outcome === null ? null : asAppOutcome(status.outcome),
    };
  }

  watch(onEvent: (event: CrucibleInstallDoorEvent) => void): () => void {
    this.watchers.add(onEvent);
    // NOBODY HAS ASKED FOR A MOVE HERE, so do not wait for the tray to decide
    // it wants one — see {@link follow}.
    void this.follow(0);
    return () => { this.watchers.delete(onEvent); };
  }

  /**
   * Follow this machine's move to its end, once.
   *
   * `watchInstall` NEVER STARTS ONE (§2.3 put that in the tray), so calling it
   * on a quiet machine costs a poll and returns. It is started when the first
   * watcher arrives and again after each one ends, so a panel opened during the
   * next move attaches to it.
   *
   * ── `decisionWaitMs` IS THE DIFFERENCE BETWEEN WATCHING AND EXPECTING ─────
   *
   * The SDK's default is 195 s (`DECISION_WAIT_MS`, its own citation of the
   * tray's presence-settle ceiling), because a caller that has JUST run
   * `install.ps1` should wait for the tray to decide whether this machine is
   * moving. An app merely opening a settings panel has not asked for anything,
   * and three minutes of polling a door four times a second on a quiet machine
   * is work nobody requested — so subscribing passes 0, which attaches to a
   * move in flight and returns at once when there is none. **Try again** is
   * the other case and takes the SDK's own wait.
   */
  private async follow(decisionWaitMs?: number): Promise<void> {
    if (this.following !== null) return this.following;
    const runner = this.host.runner();
    if (runner.platform !== 'win32' || !this.host.installed(runner)) return;
    this.following = (async () => {
      try {
        const status = await this.host.watch({
          onEvent: (event) => this.relay(event),
          ...(decisionWaitMs === undefined ? {} : { decisionWaitMs }),
        }, runner);
        /*
         * THE ENDING COMES FROM THE OUTCOME, NOT FROM A FRAME. A move that
         * ended with no outcome recorded is a machine that decided nothing —
         * the ordinary quiet case — and emitting a terminal event for it would
         * tell every open panel that something finished.
         */
        if (status.outcome === null) return;
        const outcome = asAppOutcome(status.outcome);
        this.emit(outcome.state === 'done' ? { event: 'done', outcome } : { event: 'error', outcome });
      } finally {
        this.following = null;
      }
    })();
    return this.following;
  }

  /**
   * `POST /install` — Try again.
   *
   * The release is the OUTCOME's, not the channel's: this retries the move the
   * machine already attempted, and asking the channel would silently turn a
   * retry into an upgrade. A machine with no outcome has nothing to try again
   * and says so by name rather than posting a move nobody asked for.
   */
  async start(): Promise<void> {
    const runner = this.host.runner();
    if (runner.platform !== 'win32' || !this.host.installed(runner)) {
      throw new Error(
        'host_not_installed: there is no Crucible host on this computer, so there is no engine '
        + 'setup to try again. Install Crucible first.',
      );
    }
    const status = await this.host.status(runner);
    if (status.outcome === null) {
      throw new Error(
        'no_install_outcome: this computer has not recorded an engine setup, so there is nothing '
        + 'to try again.',
      );
    }
    try {
      await this.host.post(status.outcome.release, runner);
    } catch (err) {
      /*
       * A 409 IS THE DOOR SAYING "IT IS ALREADY HAPPENING" and naming
       * `/install/events` — which is the thing this app is already watching.
       * So it is not an error to report: the press did what the person wanted,
       * which is for the move to be under way.
       */
      if ((err as { code?: unknown }).code !== 'host_install_running') throw err;
    }
    // A MOVE IS NOW EXPECTED, so this one waits the SDK's own wait for the tray
    // to pick the POST up — unlike a panel merely subscribing.
    void this.follow();
  }

  private relay(event: HostEvent): void {
    if (event.event === 'step') this.step = event.data.name;
    const translated = appEvent(event);
    if (translated === null) return;
    this.emit(translated.event === 'line' ? { ...translated, step: this.step } : translated);
  }

  private emit(event: CrucibleInstallDoorEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }
}
