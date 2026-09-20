/**
 * ONE CLOCK OVER A CRUCIBLE EVENT STREAM — the thing that was missing when a
 * wedged server held a render forever.
 *
 * ── The hole this fills (bug hunt 2026-09-20, C2) ──────────────────────────
 *
 * No `CrucibleClient` in this app is built with `timeoutMs`, and
 * `parallel-tts-bridge.ts` deliberately removed the render watchdog on the
 * grounds that *"the server's own progress frames are the heartbeat"*. They
 * are — but **nothing measured the interval between them.** The SSE `for await`
 * inside `client.events()` / `client.writeArtifactsTo()` blocks on a TCP
 * connection that is alive and has simply stopped producing bytes. A Crucible
 * whose uvicorn is up but whose worker is wedged (the SMB-wedge class of
 * failure) holds that socket open: the queue row sits at `processing`, the GPU
 * slot stays charged, `gpuHoldOf` keeps the book atomic on that card, the
 * in-flight ledger row stays, and the only exit is a person pressing Stop.
 *
 * ── Why a clock over the FRAMES and not a `timeoutMs` on the client ────────
 *
 * A client-level timeout is the wrong knob: it would cut a legitimate hour-long
 * stream. The question is not "how long has this job taken" but "how long since
 * this server last said anything", and the answer to that is reset by every
 * frame of any kind — `progress`, `chunk`, `artifact`, `warming`, `queued`. An
 * MLX warm-load is minutes of silence and is perfectly healthy; ten minutes of
 * it is not (Owen's ruling 3, 2026-09-20).
 *
 * ── What happens when it fires ─────────────────────────────────────────────
 *
 * **The job is CANCELLED, not abandoned.** Hanging up on the stream would leave
 * the job running on the server holding its exclusive lane — the same rule
 * `job.ts` and `render.ts` spell out for a user-pressed Stop. So the caller's
 * `onStall` sends the DELETE, the stream is then given a short grace to deliver
 * the `cancelled` frame it should now receive, and either way this throws
 * {@link CrucibleStreamWentQuiet}.
 *
 * It throws its OWN class rather than one of the doors' refusal types because
 * the refusal vocabulary belongs to each door (`CrucibleJobRefused`,
 * `CrucibleRenderRefused`) and a second module minting one of those would be a
 * second owner of it. Each door catches this and re-mints its own
 * `crucible_went_quiet`, transient, with the holder's sentence.
 *
 * **The grace is not a second chance.** Once the clock has fired, the outcome
 * is `crucible_went_quiet` whatever the stream does next; the grace exists only
 * so the socket can close tidily on the `cancelled` frame instead of being left
 * mid-read. A stream that settles inside it does NOT turn this into a
 * cancellation, because "this side cancelled it" would hide the reason from the
 * person reading the row.
 */

/** The frame-to-frame silence that means a server has stopped answering. */
export const CRUCIBLE_STREAM_STALL_MS = 10 * 60 * 1000;

/**
 * How long the stream is given, after the DELETE, to deliver its terminal
 * frame before this gives up on it.
 *
 * Short on purpose: the server is already not answering, and the caller is
 * holding a GPU slot and a queue row while this waits. Fifteen seconds is
 * enough for a healthy server whose job simply had nothing to say, and nothing
 * for a wedged one.
 */
export const CRUCIBLE_STREAM_STALL_GRACE_MS = 15_000;

/**
 * A Crucible event stream that stopped producing frames for longer than the
 * clock allows. Named, never a silence and never a generic timeout.
 */
export class CrucibleStreamWentQuiet extends Error {
  readonly code = 'crucible_went_quiet';
  readonly server: string;
  /** The job that stopped talking, or null when the caller had no id yet. */
  readonly jobId: string | null;
  /** The clock that fired, in ms — what "how long was it silent" is answered from. */
  readonly stallMs: number;

  constructor(server: string, jobId: string | null, stallMs: number, message: string) {
    super(message);
    this.name = 'CrucibleStreamWentQuiet';
    this.server = server;
    this.jobId = jobId;
    this.stallMs = stallMs;
  }
}

/**
 * How long a stall of `stallMs` is worth saying out loud.
 *
 * Sub-second is spelled in ms rather than rounded: the shipped window is ten
 * minutes and a keeper's is a fraction of a second, and "silent for 0 s" is a
 * sentence that tells a reader nothing at all.
 */
export function describeStallInterval(stallMs: number): string {
  if (stallMs < 1000) return `${stallMs} ms`;
  const minutes = stallMs / 60_000;
  if (minutes >= 1 && Number.isInteger(minutes)) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  return `${Math.round(stallMs / 1000)} s`;
}

export interface StreamStallOptions<T> {
  /** For the refusal's sentence. A registry name, never a URL. */
  readonly server: string;
  /** The job being followed, when the caller already knows its id. */
  readonly jobId: string | null;
  /** Default {@link CRUCIBLE_STREAM_STALL_MS}. */
  readonly stallMs?: number;
  /** Default {@link CRUCIBLE_STREAM_STALL_GRACE_MS}. */
  readonly graceMs?: number;
  /**
   * Send the DELETE. Called exactly once, when the clock fires. A throw here is
   * swallowed into `onLog`: the stall is the news, and a cancel that could not
   * be delivered to a server that is not answering is not a surprise.
   *
   * **It is BOUNDED by `graceMs` and not awaited unconditionally.** The door
   * that hands this in calls `client.cancel()`, and no `CrucibleClient` in this
   * app is built with a `timeoutMs` — so a DELETE to the wedged server that
   * caused the stall can hang exactly as the stream did, and waiting on it
   * would put the whole bug back one function further out.
   */
  readonly onStall: () => Promise<void> | void;
  /** Free text for the job log. */
  readonly onLog?: (line: string) => void;
  /**
   * The loop over the stream. It MUST call `beat()` on every frame it sees —
   * that is what the clock measures. Whatever it resolves with is what this
   * resolves with.
   */
  readonly consume: (beat: () => void) => Promise<T>;
}

/**
 * Run one event-stream loop under the stall clock.
 *
 * Resolves with `consume`'s value when the stream ends normally. Throws
 * {@link CrucibleStreamWentQuiet} when `beat()` went unsaid for longer than the
 * clock allows, and rethrows anything `consume` itself threw.
 */
export async function withStreamStallClock<T>(options: StreamStallOptions<T>): Promise<T> {
  const stallMs = options.stallMs ?? CRUCIBLE_STREAM_STALL_MS;
  const graceMs = options.graceMs ?? CRUCIBLE_STREAM_STALL_GRACE_MS;
  const log = options.onLog ?? (() => undefined);

  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let announceStall!: () => void;
  const stalled = new Promise<void>((resolve) => { announceStall = resolve; });

  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (): void => {
    disarm();
    if (fired) return;
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      announceStall();
    }, stallMs);
    // Never the reason a headless process stays alive after its work is done.
    timer.unref?.();
  };
  // ARMED BEFORE THE FIRST FRAME. A server that accepts the stream and then says
  // nothing at all is the exact failure this exists for, and a clock that only
  // started on frame one would never start for it.
  arm();

  const running = options.consume(() => { arm(); });
  // The race below may leave `running` pending. An unhandled rejection from a
  // promise nobody is awaiting any more would take the whole process down, so it
  // is given a sink here and its value is read only through `settled`.
  const settled = running.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );

  const first = await Promise.race([settled, stalled.then(() => 'stalled' as const)]);
  if (first !== 'stalled') {
    disarm();
    if (first.ok) return first.value;
    throw first.err;
  }

  log(`crucible "${options.server}" has sent no frame for ${describeStallInterval(stallMs)}`
    + `${options.jobId === null ? '' : ` on job ${options.jobId}`}; cancelling it`);
  // BOUNDED — see `onStall`'s own note. A DELETE that hangs on the same wedged
  // server must not become the new place this call waits forever.
  await Promise.race([
    Promise.resolve().then(options.onStall).catch((err: unknown) => {
      log(`the cancel of the silent crucible "${options.server}" job was not accepted: `
        + `${err instanceof Error ? err.message : String(err)}`);
    }),
    sleep(graceMs),
  ]);
  // THE GRACE IS NOT A SECOND CHANCE — see the header. Whatever the stream does
  // now, the answer is `crucible_went_quiet`; this wait only lets the socket
  // close on the `cancelled` frame instead of being left mid-read.
  await Promise.race([settled, sleep(graceMs)]);
  disarm();
  throw new CrucibleStreamWentQuiet(
    options.server, options.jobId, stallMs,
    `crucible "${options.server}"${options.jobId === null ? '' : ` job ${options.jobId}`} sent no `
    + `event for ${describeStallInterval(stallMs)}. The connection was still open, which is what a `
    + 'server whose worker has wedged looks like, so the job was cancelled rather than waited on. '
    + 'Nothing here retried it.',
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
