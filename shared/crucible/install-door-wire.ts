/**
 * THE ORCHESTRATOR'S INSTALL DOOR, AS THE APP READS IT.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.2 and §2.6. On a Windows machine
 * that can host WSL2 the Linux engine now arrives BY ITSELF: the tray decides
 * at every start whether this machine should be moving, and runs the move. The
 * app does not choose it, does not drive it and is never shown a command for
 * it — what the app does is WATCH, and offer the two controls a person can
 * genuinely press (Restart now, Try again).
 *
 * So the shapes here are not a request/response pair. They are two facts:
 *
 *   1. {@link CrucibleInstallOutcome} — "what happened to the move on this
 *      machine", the one owner of that, written by the installer at every
 *      terminal point (`%LOCALAPPDATA%\Crucible\wsl-outcome.json`).
 *   2. {@link CrucibleInstallDoorEvent} — the ndjson the running move emits,
 *      step by step, line by line, byte by byte.
 *
 * WHY A SEPARATE WIRE FROM `install-wire.ts`. `CrucibleInstallProgress` there
 * is what THIS APP's own `install()` call reports while the app is the caller.
 * These are what the ORCHESTRATOR reports about a move the app did not start
 * and cannot stop. They are two different owners of two different facts, and
 * folding them together is how "BookForge is installing" and "this machine is
 * moving itself to the Linux engine" would end up as one sentence that is
 * wrong half the time.
 */

/**
 * THE FIVE TERMINAL STATES, and no sixth (§2.2).
 *
 * `done` — the guest engine is up and is what answers on :7100.
 * `reboot-pending` — Windows asked for a restart; nothing else is wrong. The
 *   app offers **Restart now**; Crucible never takes a reboot itself.
 * `cannot` — the state table's verdict is one only a person can clear (a BIOS
 *   setting, a disk). Terminal for the tray; the app shows the sentence and
 *   **Try again**, because the person may have gone and changed it.
 * `failed` — something broke mid-move (a download died, the guest install
 *   failed). Retried once by the tray; then it waits for Try again.
 * `declined` — `[orchestrator] wsl = "never"` in Crucible's config. The one way
 *   to keep a machine native on purpose. NO APP OFFERS IT: the apps' setup has
 *   no choice to make, so this arrives already true or not at all.
 */
export type CrucibleInstallOutcomeState =
  | 'done' | 'reboot-pending' | 'cannot' | 'failed' | 'declined';

/**
 * `wsl-outcome.json`, verbatim (§2.2).
 *
 * `code` and `sentence` are NULL on `done` and `declined` — there is no state
 * table row to name and nothing to explain — and both carry the refusing
 * owner's own words otherwise. Nothing in this app composes that sentence: it
 * is the state table's, written where the probe lives, and an app that
 * rewrote it would be the second owner of a verdict about somebody's machine.
 */
export interface CrucibleInstallOutcome {
  state: CrucibleInstallOutcomeState;
  /** A state-table code, or a task failure code. Null on done and declined. */
  code: string | null;
  /** The state table's own sentence. Null on done and declined. */
  sentence: string | null;
  /** ISO-8601, when this outcome was written. */
  at: string;
  /** Which Crucible release the move was for, or null when none was reached. */
  release: string | null;
  /** How many times the move has been attempted. A second `failed` waits. */
  attempts: number;
}

/**
 * IS THERE ANYTHING LEFT TO WAIT FOR?
 *
 * §2.8: the app coordinates with the TERMINAL engine only. Coordinate-on-
 * connect installs job environments and pulls weights — gigabytes — and run
 * against the native engine on a machine that is mid-move they land on Windows
 * and are thrown away by migrate-weights minutes later. Every one of the five
 * states IS terminal for the tray, which is the point: the non-terminal case is
 * `outcome === null` with a move running, and that is a `null` rather than a
 * sixth state, so no caller can read "nothing has happened yet" as a verdict.
 */
export function installOutcomeIsTerminal(outcome: CrucibleInstallOutcome | null): boolean {
  return outcome !== null;
}

/**
 * ONE ndjson EVENT off `GET /install/events` (§2.6, §2.12).
 *
 * `progress` carries `bytes_done`/`bytes_total` in the orchestrator's own
 * spelling rather than a renamed pair: the Ubuntu image and the guest
 * interpreter get the shape `pull` already emits, and a field renamed on the
 * way through this wire is a field that drifts. **pip has no byte total** —
 * an `install` task streams pip's own lines and the app shows the LINE, not an
 * invented bar.
 */
export type CrucibleInstallDoorEvent =
  /** The state table's answer for this machine, with the sentence its owner wrote. */
  | { event: 'state'; code: string; sentence: string; action: string }
  /** One step of the move began. `index`/`total` are null when the run is not counted. */
  | { event: 'step'; name: string; index: number | null; total: number | null; detail: string }
  /** Bytes, while something downloads. `bytes_total` is null until the size is known. */
  | { event: 'progress'; file: string; bytes_done: number; bytes_total: number | null }
  /** One line a process printed. pip's own lines arrive here. */
  | { event: 'line'; step: string; stream: 'stdout' | 'stderr'; text: string }
  /** The move reached a terminal point. The outcome is the record of it. */
  | { event: 'done'; outcome: CrucibleInstallOutcome }
  /** It stopped by name. Also terminal, and also carries the outcome. */
  | { event: 'error'; outcome: CrucibleInstallOutcome };

/** `GET /install` (§2.6): is a move running, and what did the last one come to? */
export interface CrucibleInstallDoorStatus {
  running: boolean;
  /** Null when no move has ever reached a terminal point on this machine. */
  outcome: CrucibleInstallOutcome | null;
}
