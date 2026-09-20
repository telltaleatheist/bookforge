/**
 * WHAT THE SERVER ANNOUNCED AND THIS SIDE HAS NOT GOT YET — and where a
 * re-opened stream has to start so it arrives.
 *
 * ── The hole this fills (bug hunt 2026-09-20, PK13's `artifacts` scenario) ──
 *
 * `client.writeArtifactsTo()` starts each artifact's download as its frame
 * lands and raises the FIRST failure at the next yield boundary. One `500` on
 * one artifact of a job that RAN therefore threw out of the iteration — often
 * before the `done` frame had even been yielded — and both doors read that
 * throw the only way they could: no terminal frame, so the job is an orphan,
 * so Q7 sweeps the server and DELETEs a job that had finished, and the whole
 * render or align is re-run from zero.
 *
 * A failed artifact fetch is a TRANSPORT fault on work that is already done.
 * The fix is to ask again — and asking again means re-opening the stream, which
 * needs the one number this module owns: **the lowest event id that still has
 * something owed under it.** A reconnect resumes there, the server replays that
 * frame, and the SDK downloads it again (its `started` set is per call, so a
 * name that failed in the last run is fetched in the next one). Everything
 * already on disk stays: the SDK writes a sidecar then renames, so a frame seen
 * twice is the same bytes twice, never a half file.
 *
 * ── Why a module and not two closures ──────────────────────────────────────
 *
 * `job.ts` and `render.ts` both consume the same iterator and both need the
 * same three answers ("what is owed", "where must a retry resume", "is there
 * anything left to read"). Two copies of a resume rule is how the two doors
 * drift, which is what `stream-reconnect.ts` was written to stop happening a
 * second time.
 *
 * ── The directory is the authority, not the tally ──────────────────────────
 *
 * The SDK yields a `written` record on the pass AFTER the download lands, so a
 * file whose fetch settled just as the socket died is ON DISK and was never
 * announced to anybody (PK11's "seen, not fixed"). A tally that believed only
 * what it was told would re-fetch those files on every reconnect — measured:
 * two of three chunks fetched twice on one blip. So the caller hands in a
 * predicate over its own artifact directory and that is asked FIRST, in one
 * place, so "what is owed", "where must a retry resume" and "is there anything
 * left to read" cannot come to three different answers.
 *
 * A name already on disk from an EARLIER attempt at the same book reads as
 * landed too, and that is correct for every caller here: a resume submits only
 * the chunks that are missing (`render.ts`), so a name this stream announced is
 * one this directory did not have when the job was submitted.
 *
 * No client and no clock; the only I/O is the caller's own predicate.
 */

import * as fsSync from 'fs';
import * as path from 'path';

/** A name the server announced, and the event that announced it. */
interface Announcement {
  readonly name: string;
  /**
   * The id of the frame that named it, or `null` when the ONLY announcement was
   * the `done` frame's list. See {@link ArtifactsOwedTally.resumeFrom}: the
   * SDK's done-list fallback runs only on a full replay, so a name with no
   * frame of its own cannot be recovered by resuming above zero.
   */
  readonly eventId: number | null;
}

export interface ArtifactsOwedTally {
  /**
   * An `artifact` frame: the server says this file exists and the SDK has begun
   * fetching it. The FIRST announcement wins — a replayed frame carries the
   * same id, and a later one must not push the resume point forward past work
   * that is still owed.
   */
  announced(name: string, eventId: number): void;
  /**
   * The `done` frame's `artifacts` list — the authoritative set. Names already
   * announced by a frame keep that frame's id; the rest are recorded with none.
   */
  announcedByDone(names: readonly string[]): void;
  /** One file landed on disk, under the name the server announced it by. */
  landed(name: string): void;
  /** Announced, not landed, in announcement order. Empty is the good answer. */
  owed(): readonly string[];
  /**
   * Where a re-opened stream must resume so that everything still owed is
   * replayed — see the note on the return value in the implementation.
   */
  resumeFrom(lastEventId: number): number;
  /** One sentence for a refusal or a log line. Never empty when something is owed. */
  describe(): string;
}

/**
 * @param onDisk Does this artifact already exist in the caller's directory?
 *   Omitted by a caller that writes no files (a `load-model` job, an in-memory
 *   fetch), where nothing can be on disk to begin with.
 */
export function createArtifactsOwed(onDisk?: (name: string) => boolean): ArtifactsOwedTally {
  /** name → where it was announced. Insertion order is announcement order. */
  const announced = new Map<string, Announcement>();
  const landed = new Set<string>();

  /**
   * On disk once, on disk for ever: the answer is cached so that one `owed()`
   * cannot disagree with the next about a file nothing is going to delete.
   */
  const hasLanded = (name: string): boolean => {
    if (landed.has(name)) return true;
    if (onDisk !== undefined && onDisk(name)) {
      landed.add(name);
      return true;
    }
    return false;
  };

  const owed = (): readonly string[] => [...announced.keys()].filter((name) => !hasLanded(name));

  return {
    announced(name: string, eventId: number): void {
      if (announced.has(name)) return;
      announced.set(name, { name, eventId });
    },
    announcedByDone(names: readonly string[]): void {
      for (const name of names) {
        if (announced.has(name)) continue;
        announced.set(name, { name, eventId: null });
      }
    },
    landed(name: string): void {
      landed.add(name);
    },
    owed,
    /**
     * Three answers, and each of them is a rule:
     *
     *  - **Nothing owed** → `lastEventId`, which is the ordinary resume: pick
     *    up where this side left off.
     *  - **Something owed that a frame announced** → one BELOW the lowest such
     *    frame, so the server replays it and the SDK fetches the file again.
     *    Never above `lastEventId` — a resume point ahead of where this side
     *    got to would skip frames nobody has seen.
     *  - **Something owed that only the `done` list named** → 0, a full replay.
     *    The SDK fetches a done-listed name that produced no `artifact` frame
     *    ONLY when the caller did not resume from an id (`writeArtifactsTo`:
     *    *"the prefix they chose not to replay is theirs"*), so any resume above
     *    zero would leave that file unfetchable for ever. It costs a replay of
     *    frames this side has already acted on, which is cheap, and a re-fetch
     *    of artifacts already written, which is the same bytes to the same
     *    names — and it is the only way to get the file at all.
     */
    resumeFrom(lastEventId: number): number {
      const outstanding = owed();
      if (outstanding.length === 0) return lastEventId;
      let lowest: number | null = null;
      for (const name of outstanding) {
        const at = announced.get(name)?.eventId ?? null;
        if (at === null) return 0;
        if (lowest === null || at < lowest) lowest = at;
      }
      if (lowest === null) return 0;
      return Math.max(0, Math.min(lastEventId, lowest - 1));
    },
    describe(): string {
      const outstanding = owed();
      if (outstanding.length === 0) return 'every announced artifact is on disk';
      const shown = outstanding.slice(0, 4).join(', ');
      return `${outstanding.length} artifact(s) the server announced are not on disk yet `
        + `(${shown}${outstanding.length > 4 ? ', …' : ''})`;
    },
  };
}

/**
 * "Is this artifact already in that directory?" — the predicate
 * {@link createArtifactsOwed} asks, built once here so both doors ask it the
 * same way.
 *
 * Existence is the whole test, because the SDK writes the sidecar and then
 * RENAMES the artifact into place: a file that is there is a file that is
 * complete. A zero-byte one never gets that far (`writeArtifactsTo` refuses a
 * zero-byte artifact as a server announcing a file it did not write), and a
 * name is always a single directory member — the SDK refuses a traversal
 * before it writes anything.
 */
export function artifactOnDiskIn(dir: string): (name: string) => boolean {
  return (name: string): boolean => {
    try {
      return fsSync.statSync(path.join(dir, name)).size > 0;
    } catch {
      return false;
    }
  };
}
