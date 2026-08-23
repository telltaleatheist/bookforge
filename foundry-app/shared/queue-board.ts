/**
 * THE BOARD — which resource each kind of job needs, and how many of each the
 * machine has.
 *
 * Compiled by BOTH programs, like the wire shapes beside it: the scheduler
 * (electron/job-queue.ts) reads this to decide when a row may start, and the
 * chrome (core/queue-view.service.ts) reads it to decide which lane a row is drawn
 * in. ONE TABLE, because the lane a row waits in and the lane it eventually
 * runs in are the same question, and two answers to it would be a board that
 * draws a reading under CPU while the pump holds it against the card.
 *
 * Owen ruled the shape (docs/QUEUE-BOARD.md, verbatim): *"the queue shelf
 * should probably look a bit more like the bookforge queue, where it has two
 * cpu slots and one gpu slot, and i can see details about the step thats taking
 * place."*
 *
 * ── Why this is a table over the union and not a lookup with a default ──────
 *
 * A default resource is a fallback, and fallbacks are bugs with a delay on
 * them: the day somebody adds a kind, the default would quietly file it in
 * whichever lane the fallback happened to name — and the first symptom would be
 * two models resident on one card at four in the morning. `Record<JobKind, …>`
 * makes the compiler name the missing row at the moment the kind is added,
 * which is the same reason `NEVER_ROUTED` one file over is a table and not a
 * literal. That one WAS a literal once, and it aged exactly this way.
 */
import type { JobKind } from './types';

/**
 * What a job needs from the machine while it runs.
 *
 * ── `gpu` and `cpu` are the two LANES, and they are the whole of the board ──
 *
 * A lane is a count of things that may run at once. `gpu` is one because the
 * card is one (Wave 16: *"one machine's GPU needs one owner"*); `cpu` is two
 * because Owen said two, and because two engine processes compiling two
 * different books are disjoint by construction — every book file write is
 * already serialised per target path (`oneWriterOf`, electron/engine.ts), every
 * catalogue edit is serialised per project (`withManifest`,
 * electron/projects.ts), and two live rows writing one output are refused
 * outright at the door (`enqueueHere`'s dedupe).
 *
 * ── `exclusive` IS NOT A LANE AND IS NOT "no resource" ──────────────────────
 *
 * An environment install takes no card and is not a conversion, and the
 * contract first spelled it as neither — *"it keeps its own path outside the
 * slots exactly as Wave 16e ruled"*. THAT READING OF 16e WAS WRONG and the
 * build corrected the contract rather than the code: 16e ruled that an install
 * never ROUTES to a host queue, which is a fact about whose scheduler decides
 * it. It says nothing about slots, and in this app's own queue an install has
 * always taken the pump's one serial slot — deliberately, because the whole
 * argument for an install living in this queue at all is that *"a conversion
 * that needs the environment must wait BEHIND it"*. A downloader running beside
 * the lanes would let a reading start against the Python it is halfway through
 * replacing, which is the one failure the shared queue exists to prevent.
 *
 * So an install holds the WHOLE BOARD: it starts only when every slot is free,
 * nothing starts beside it, and nothing queued behind it starts before it does.
 * That is exactly what one serial slot bought, spelled as a rule instead of as
 * a side effect of there being only one slot.
 *
 * ── `unscheduled` IS THE ROW THE PUMP NEVER SEES ────────────────────────────
 *
 * A mint is minutes of work with progress and a cancel, and it belongs on the
 * shelf — but the rasterising happens in the RENDERER under somebody's hands
 * and main only assembles what arrives. It is born `running` (`beginMint`), so
 * it is invisible to a scheduler that only ever claims a `queued` row. It
 * competes with nothing, it holds no slot, and it does not hold the drain.
 * Naming that here rather than leaving it implied is what lets the shelf draw
 * such a row somewhere honest instead of inventing a lane for it.
 */
export type JobResource = 'gpu' | 'cpu' | 'exclusive' | 'unscheduled';

/**
 * THE TABLE. Every kind, one resource, no default — see the module note.
 *
 * SIMPLIFY IS NOT IN HERE AND MUST NOT BE. It is a rewrite prompt on the
 * translate command (`TranslateRequest.rewrite`), the Simplify dialog calls
 * `enqueueTranslate`, and the row it produces is `kind: 'translate'` wearing a
 * title of its own. It inherits `gpu` through that, which is correct for the
 * reason the lane exists: it holds an Ollama model for the length of a book.
 */
export const JOB_RESOURCE: Readonly<Record<JobKind, JobResource>> = {
  /** The VLM holds the card for hours. */
  read: 'gpu',
  /** Ollama holds the card (`keep_alive: 0` on exit, Wave 4c) — and so does a Simplify. */
  translate: 'gpu',
  /** Engine compile or cast — disk and CPU, and no model anywhere near it. */
  epub: 'cpu',
  txt: 'cpu',
  /**
   * A facsimile or a real-text reprint: `--reuse-readings` over a finished
   * bank, which loads no model and opens no socket (`executeJob`'s server rule).
   */
  pdf: 'cpu',
  /** Rectify and assemble, in the renderer's hands. See `unscheduled` above. */
  mint: 'unscheduled',
  /** The precondition of the engine running at all. See `exclusive` above. */
  'env-install': 'exclusive',
};

/** The two resources that are actually counted in slots. */
export type Lane = 'gpu' | 'cpu';

/** Drawn in this order, and scheduled in it too: the expensive lane first. */
export const LANES: readonly Lane[] = ['gpu', 'cpu'];

/**
 * HOW MANY MAY RUN AT ONCE — Owen's numbers, in the one place both sides read.
 *
 * One GPU because the card is one. Two CPUs because he said two: a machine that
 * can compile two books while it reads a third is a machine doing three things
 * in the time it used to do one, and the three do not contend for anything the
 * app cannot already serialise (see `JobResource`).
 */
export const SLOTS: Readonly<Record<Lane, number>> = { gpu: 1, cpu: 2 };

/** Is this resource one of the counted lanes? A type guard, so callers narrow. */
export function isLane(resource: JobResource): resource is Lane {
  return resource === 'gpu' || resource === 'cpu';
}

/**
 * The lane this kind of job runs in, or null when it runs in neither.
 *
 * Null is two different facts — an install that holds every lane, and a mint
 * that holds none — and a caller that needs to tell them apart asks
 * `JOB_RESOURCE` directly. This is for the callers that only want a lane.
 */
export function laneOf(kind: JobKind): Lane | null {
  const resource = JOB_RESOURCE[kind];
  return isLane(resource) ? resource : null;
}
