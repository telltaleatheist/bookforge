/**
 * THE LISTEN CLIENT, in one place, for every surface that streams speech.
 *
 * Two halves, and the seam between them is the `ListenGeneratorPort`:
 *
 *   - `session-policy.ts` — WHICH ROW NEXT. The read-ahead window, the
 *     background prefetch, the preempt rule, the playhead and the first-wave
 *     ramp. It knows nothing about Crucible; a keeper drives it against a fake
 *     generator, and the local narrator pool is behind it in the main process.
 *   - `crucible-rows.ts` — ONE ROW ON A CRUCIBLE SESSION. `say` at take 0, the
 *     four frames (`audio` / `done` / `restart` / `error`) demultiplexed back
 *     into one promise per row, and `cancel` / `cancelAll` / `close`.
 *
 * Opening the session, and reattaching to it with `Last-Event-ID` inside the
 * server's 15-second grace window, are `@crucible/client`'s — neither is
 * re-implemented here.
 *
 * Three programs compile this directory: the main process
 * (`electron/stream-scheduler.ts`, `electron/crucible/stream.ts`), the Angular
 * renderer, and the browser extension's offscreen document, which since Phase
 * 16 talks to a Crucible with no BookForge in between
 * (docs/EXTENSION-TO-CRUCIBLE-PLAN.md).
 *
 * No Node, no DOM, no Electron in either file. The transport is the SDK client
 * the caller hands over; the sink is the caller's; `Data` is whatever the
 * caller's generator calls a chunk payload.
 */
export {
  DEFAULT_LOOKAHEAD_SECONDS,
  ListenSessions,
  type ListenChunk,
  type ListenGeneratorPort,
  type ListenRowResult,
  type ListenSink,
  type ListenStartOptions,
} from './session-policy.js';

export {
  CRUCIBLE_STREAM_IN_FLIGHT,
  CRUCIBLE_STREAM_RAMP_WIDTH,
  CRUCIBLE_STREAM_TAKE,
  CrucibleRowSession,
  type CrucibleRowChunk,
  type CrucibleRowResult,
  type CrucibleRowSessionDeps,
  type CrucibleSayOptions,
} from './crucible-rows.js';
