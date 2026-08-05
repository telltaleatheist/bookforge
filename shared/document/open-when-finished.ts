/**
 * "Open when finished" — a promise the APP keeps, not a window.
 *
 * RULED 2026-08-04 (docs/PIPELINE_V2_PLAN.md, Owen's first real session): "i
 * processed it in queue with the open when complete checkbox checked, but it
 * didnt open the completed copy… when the book finished in the queue, i went
 * back to studio to open it."
 *
 * The old implementation was a listener inside the picker component, filtered on
 * the project that window happened to be showing. The whole point of a long run
 * is that the user goes somewhere else while it works, so the one condition
 * under which the promise paid out was the one under which it was not needed. A
 * checkbox that only pays out if you stayed and watched is a checkbox that does
 * nothing.
 *
 * So the request outlives the component that made it. This is the whole of the
 * bookkeeping, kept pure and out of the main process so it can be tested without
 * an Electron window:
 *
 *  - It is a REQUEST ABOUT A PROJECT AND A STATION, because that is what the
 *    user asked ("open the working copy when the cast lands"), and not a boolean
 *    somewhere that a later unrelated stage could cash in.
 *  - It is CONSUMED ONCE. `take` removes as it returns, so two windows racing to
 *    honour the same request cannot both open one.
 *  - It knows nothing about whether the artifact actually exists. That is a fact
 *    about files, measured by the side that has them; this only remembers what
 *    was asked for.
 */

import { stationMintedBy, type StationId } from './stations';

/** What a caller asked for, and the only shape stored. */
export interface OpenWhenFinishedRequest {
  readonly projectDir: string;
  /** The station the run being submitted will mint. */
  readonly station: StationId;
}

export class OpenWhenFinishedLedger {
  private readonly byProject = new Map<string, StationId>();

  /**
   * Record the promise. One per project: a second request over the same book
   * replaces the first, because the user pressed something newer and that is
   * what they are waiting for.
   */
  request(projectDir: string, station: StationId): void {
    if (!projectDir) {
      throw new Error(
        'An "open when finished" request has to name the project it is about; none was given.'
      );
    }
    this.byProject.set(projectDir, station);
  }

  /** Withdraw it — a run that was refused will never finish. */
  cancel(projectDir: string): void {
    this.byProject.delete(projectDir);
  }

  /** The station this project is waiting on, without consuming it. */
  pending(projectDir: string): StationId | null {
    return this.byProject.get(projectDir) ?? null;
  }

  /**
   * True when a stage that just finished is the one this project is waiting on.
   *
   * A run may contain several stages. Matching on the station the stage MINTS —
   * rather than on the fact that any stage ended — is what stops a cast in a
   * two-pass run from cashing in a promise the user made about the book.
   */
  awaits(projectDir: string, stage: string): boolean {
    const station = this.byProject.get(projectDir);
    if (station === undefined) return false;
    return stationMintedBy(stage) === station;
  }

  /**
   * Take the promise: return it and remove it, in one step.
   *
   * The atomicity is the point. The picker asks for this whenever it has just
   * re-measured a book, and a book can be open in more than one window; a peek
   * followed by a delete would let both of them open the same station and fight
   * over the viewer.
   */
  take(projectDir: string): StationId | null {
    const station = this.byProject.get(projectDir);
    if (station === undefined) return null;
    this.byProject.delete(projectDir);
    return station;
  }

  /** Every project with a promise outstanding — for logging and for tests. */
  outstanding(): OpenWhenFinishedRequest[] {
    return [...this.byProject].map(([projectDir, station]) => ({ projectDir, station }));
  }
}
