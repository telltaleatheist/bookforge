/**
 * WHAT THE WHOLE-BOOK RENDER TELLS THE READER, as one shape both sides read.
 *
 * `electron/book-render-service.ts` answers `status()`, `bookshelf-server.ts`
 * puts it on the wire at `GET /api/render/status`, and the reader
 * (`projects/bookshelf/src/app/reader/render-playback.service.ts`) polls it two
 * to three times a second while a book renders. Until 2026-09-18 the shape was
 * written once as an inline return type in the service, the route handed it to
 * `res.json()` untyped, and the reader read the parsed JSON as `any` — so the
 * two ends of the poll agreed only by coincidence, and a renamed field would
 * have shown up as a progress bar that stopped moving rather than as an error.
 *
 * It lives in shared/ for the reason the queue's types do (see
 * `shared/queue/engine-types.ts`): MAIN owns the fact, the browser holds a
 * mirror, and both read the shape from here so they cannot drift.
 */

/** The render's progress for one project, as the service states it. */
export interface RenderStatus {
  /** There is a render to speak of: a live job, or state.json on disk. */
  exists: boolean;
  /** Sentences in the plan. 0 when `exists` is false. */
  total: number;
  /** Sentences with audio on disk. */
  rendered: number;
  /** The m4b is assembled and registered. */
  done: boolean;
  /** Per-sentence coverage, in reading order — what the reader waits on. */
  coverage?: boolean[];
  /** The sentence the listener is on, as the service last recorded it. */
  playhead?: number;
  /** ffmpeg is running: rendered === total and the book is being built. */
  assembling?: boolean;
  /** An m4b path is recorded in state.json. */
  m4b?: boolean;
  /** The job's abort, by name. The reader stops and shows it. */
  error?: string;
  /** How many attempts have failed across the whole run. */
  failures?: number;
  /** Where every one of them is recorded, one JSON object per line. */
  failuresPath?: string;
}
