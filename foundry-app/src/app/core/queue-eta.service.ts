import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';

import type { Job, JobProgress } from '@shared/types';

import { QueueService } from './queue.service';

/**
 * HOW MUCH LONGER — measured in this window, out of the counts as they arrive.
 *
 * ── Why the app works this out and the engine does not ──────────────────────
 *
 * Owen, 2026-08-25: *"can you give me some kind of progress bar or something in
 * the queue? anything at all to indicate its actually working"*, and then
 * *"preferably with an ETA"*. The bar half was an engine fix — the analyze job
 * had been emitting a count every few MINUTES, so a run that was working looked
 * exactly like a run that was wedged. The ETA half is this file, and it is on
 * this side of the wire deliberately.
 *
 * The engine could compute one. It would then have to compute one for every
 * command that counts anything — `vlm-read`, `vlm-convert`'s rasterise pass,
 * `translate`, both halves of `analyze` — and print it on a line the app would
 * have to learn to parse, on a schedule the app does not control, about a clock
 * the app cannot check. Whereas the app already receives the ONE fact an
 * estimate is made of: `page` out of `total`, stamped with the moment it
 * arrived. Rate is arithmetic over that, and doing it here means every phase
 * this app will ever draw a bar for gets an ETA the day it gets a count, with
 * nothing added to the wire and nothing to keep in step across two programs.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not state about a job. Nothing here is written back to a `Job`, nothing
 * is persisted, and nothing survives the run it is about — the renderer never
 * edits a job (`QueueService`'s own rule) and an estimate this window made about
 * a process it does not own is exactly the kind of second opinion that rule
 * exists to forbid. A window opened halfway through a three-hour reading simply
 * starts measuring from the moment it opened, which is the honest answer: it did
 * not see the first two hours and has nothing true to say about them.
 *
 * ── THE THREE HONESTY RULES, which is most of what this file is ─────────────
 *
 * An ETA is the easiest lie a progress display can tell, because it looks like a
 * measurement and is actually a forecast. Three rules keep it from telling one:
 *
 *   1. NOTHING UNTIL THE RATE IS MEASURED. One sample is a position, not a
 *      speed. The row shows its count and its bar and no estimate until the
 *      count has MOVED at least once under this window's eye.
 *   2. A NEW PHASE IS A NEW CLOCK. `render` → `read`, `rank` → `verify`: the
 *      quantities are unrelated (317 pages rasterised in a minute, then 317
 *      pages read in three hours; 141 sentences ranked, then 20 passages
 *      verified), so a rate carried across the boundary would forecast the new
 *      work at the old work's speed. The history is dropped and started again,
 *      and the ETA visibly restarts rather than blending.
 *   3. A STALLED COUNT SAYS NOTHING. A frozen estimate is worse than no estimate
 *      — it is the display insisting the job is fine while the count has not
 *      moved in five minutes. Past `STALL_MS` of silence the estimate goes away
 *      and the row is back to its count, which is the state of knowledge.
 *
 * ── The heartbeat, and why a display this quiet needs one ───────────────────
 *
 * The app is zoneless: nothing is redrawn unless a signal changes. Every rule
 * above except the third falls out of the snapshots themselves, because a
 * snapshot IS a signal change — main publishes on every line the engine writes,
 * not only on the counting ones. But rule 3 is a fact about SILENCE, and silence
 * publishes nothing. So while anything is running a slow timer bumps `now`,
 * which is what lets a stalled estimate retire itself. It stops the moment the
 * board is idle: a timer ticking over an empty queue is a window redrawing
 * itself forever about nothing.
 */
@Injectable({ providedIn: 'root' })
export class QueueEtaService {
  private readonly queue = inject(QueueService);

  /**
   * The samples, per job.
   *
   * A SIGNAL AND NOT A PLAIN FIELD, because the surfaces read it while they
   * draw: a `Map` mutated on the side would be a fact the template could not see
   * changing, and in a zoneless app that is a line of text that updates whenever
   * something else happens to trigger a render. Replaced whole on every fold —
   * the histories inside it are short by construction (see `WINDOW_SAMPLES`), so
   * copying the map is cheaper than reasoning about who else is holding it.
   */
  private readonly tracks = signal<ReadonlyMap<string, Track>>(new Map());

  /** The clock the estimates are read against. See the heartbeat note above. */
  private readonly now = signal(Date.now());

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    /*
     * THE FOLD — one snapshot in, the histories advanced.
     *
     * An effect rather than a computed, and the difference matters. A computed
     * is recomputed lazily, when somebody reads it: it would see only the LATEST
     * snapshot after any gap, and — worse — it would stamp that snapshot with
     * the time of the READ rather than the time of the arrival, which is a
     * timestamp that quietly lies by however long the gap was. An effect runs
     * when the snapshot lands, so `Date.now()` here is genuinely when the count
     * moved, to within a frame.
     *
     * THE PREVIOUS HISTORIES ARE READ THROUGH `untracked`, AND THAT IS LOAD
     * BEARING RATHER THAN TIDINESS. An effect depends on every signal it reads,
     * and this one writes the very signal it folds from — read it plainly and
     * the write re-triggers the effect, which writes again, forever. Untracked,
     * the fold depends on `queue.jobs()` alone, which is the one input it
     * actually has.
     */
    effect(() => {
      const jobs = this.queue.jobs();
      const at = Date.now();
      const before = untracked(this.tracks);
      const after = advance(before, jobs, at);
      /*
       * QUIET WHEN NOTHING MOVED, which is most snapshots. Main publishes on
       * every line the engine writes and a long stretch of them carry the same
       * fraction, so `advance` hands back the very same track objects it was
       * given — and setting a signal to a new Map holding identical values would
       * be a render pass over an estimate that has not changed. The comparison
       * is by identity because that is exactly the promise `advance` makes.
       */
      if (!same(before, after)) this.tracks.set(after);
      /*
       * THE CLOCK KEEPS UP WITH THE SNAPSHOTS as well as with the heartbeat.
       * Without this it would only ever advance while the timer was alive, so a
       * window that sat idle for an hour and then started a job would read every
       * estimate against an hour-old `now` until the first tick — harmless, but
       * it means the stall rule is not armed for the first ten seconds of a run,
       * and a rule that is off when nobody is looking is not a rule.
       *
       * AT THE HEARTBEAT'S OWN GRANULARITY AND NO FINER, because a clock that
       * moved on every line the engine wrote would undo the paragraph above it:
       * `now` is a signal, every write is a render pass, and the estimate this
       * one feeds is a number rounded to five seconds at its most precise.
       */
      if (at - untracked(this.now) >= TICK_MS) this.now.set(at);
      this.pulse(jobs.some((job) => job.state === 'running'));
    });

    inject(DestroyRef).onDestroy(() => this.pulse(false));
  }

  /**
   * WHAT THIS ROW HAS LEFT — "~3m left", or null when nothing true can be said.
   *
   * Null is the ordinary answer for most of a job's life and every surface
   * treats it as "draw no estimate" rather than as a gap to fill. The three
   * rules in the class note are all decided in `estimate`; this is the reading.
   */
  forJob(job: Job): string | null {
    const track = this.tracks().get(job.id);
    if (track === undefined) return null;
    return estimate(track, this.now());
  }

  /** Start or stop the heartbeat. Idempotent — called on every fold. */
  private pulse(wanted: boolean): void {
    if (wanted === (this.timer !== null)) return;
    if (wanted) {
      this.timer = setInterval(() => this.now.set(Date.now()), TICK_MS);
      return;
    }
    clearInterval(this.timer!);
    this.timer = null;
  }
}

/** One count, and when this window saw it. */
interface Sample {
  at: number;
  page: number;
}

/**
 * One job's clock. The phase and the total are carried so a change in either
 * can be SEEN — that is honesty rule 2, and it is the whole reason a track is
 * not just an array of samples.
 */
interface Track {
  phase: JobProgress['phase'];
  total: number;
  samples: Sample[];
}

/**
 * Fold one snapshot into the histories, and return the new map.
 *
 * ── EVICTION, which is the only reason this cannot just accumulate ──────────
 *
 * A job that is no longer running has no history, and that is where every entry
 * goes: the map is rebuilt from the snapshot each time, so a row that finished,
 * failed, was cancelled or was cleared out of the queue is simply not copied
 * across. Nothing has to remember to delete it, and a queue somebody left open
 * for a week does not carry the sample history of four hundred finished jobs.
 *
 * Within a track, samples are evicted by BOTH caps (`WINDOW_SAMPLES` and
 * `WINDOW_MS`) with a floor of two, and each of the three numbers is arguable
 * where they are declared.
 */
function advance(
  before: ReadonlyMap<string, Track>,
  jobs: readonly Job[],
  now: number,
): ReadonlyMap<string, Track> {
  const after = new Map<string, Track>();
  for (const job of jobs) {
    if (job.state !== 'running') continue;
    const p = job.progress;
    /*
     * NO FRACTION, NO CLOCK. An env install counts megabytes in a field of its
     * own and only during one of its four phases; a job that has not printed a
     * count yet has nothing to measure. Both are "not tracked", not "tracked at
     * zero" — a track seeded with a page nobody reported would put a fake first
     * sample under every rate this file ever computes.
     */
    if (p === null || p.total <= 0) continue;

    const held = before.get(job.id);
    const last = held?.samples[held.samples.length - 1];
    /*
     * A NEW CLOCK, on any of three tells. The phase changed (render → read,
     * rank → verify); the total changed (the same boundaries, seen from the
     * other side — 141 sentences becoming 20 passages); or the count went
     * BACKWARDS, which is that same boundary again for a run whose two stages
     * happen to have the same total. Any of them means the samples behind it
     * describe different work, and a rate across the seam would forecast the new
     * work at the old work's speed.
     *
     * THE FIRST TELL NOW CATCHES THE ANALYSIS BOUNDARY ON ITS OWN, and it used
     * not to: the two stages of an analysis reported under one phase name
     * (`analyze`), so 141 becoming 20 was the only thing that said the run had
     * moved on, and a book whose two stages happened to share a total was left
     * leaning on the third tell. `rank` and `verify` are two phases now
     * (`JobProgress.phase`), so the seam is declared rather than inferred and the
     * estimate visibly restarts on it — which is exactly what rule 2 in the class
     * note has always promised. Nothing in this file changed to gain that; the
     * other two tells stay because they are about the other runs.
     */
    if (held === undefined || last === undefined
      || held.phase !== p.phase || held.total !== p.total || p.page < last.page) {
      after.set(job.id, { phase: p.phase, total: p.total, samples: [{ at: now, page: p.page }] });
      continue;
    }

    /*
     * A SNAPSHOT THAT DID NOT MOVE THE COUNT IS NOT A SAMPLE. Main publishes on
     * every line the engine writes — the retries, the fallbacks, the block it is
     * chewing on — so most snapshots during a slow stretch carry the same
     * fraction as the one before. Recording them would pack the window with
     * duplicates of one reading and push the movement that makes a rate out the
     * far end, which is a job that gets LESS measurable the more it talks.
     */
    if (p.page === last.page) {
      after.set(job.id, held);
      continue;
    }

    const samples = [...held.samples, { at: now, page: p.page }];
    while (samples.length > WINDOW_SAMPLES) samples.shift();
    while (samples.length > 2 && now - samples[0]!.at > WINDOW_MS) samples.shift();
    after.set(job.id, { phase: p.phase, total: p.total, samples });
  }
  return after;
}

/**
 * Are these two folds the same histories?
 *
 * BY IDENTITY, on `advance`'s own promise: a track that took no new sample is
 * handed back as the very object it was given, so identity here means "nothing
 * about this job's clock changed". Value equality would be walking every sample
 * of every running job on every line the engine writes, to answer a question
 * identity already answers.
 */
function same(before: ReadonlyMap<string, Track>, after: ReadonlyMap<string, Track>): boolean {
  if (before.size !== after.size) return false;
  for (const [id, track] of after) if (before.get(id) !== track) return false;
  return true;
}

/**
 * The forecast, or null.
 *
 * Rate is the plain secant over the window — (pages moved) / (time taken) from
 * the oldest surviving sample to the newest — and not a weighted or exponential
 * average, because the window IS the smoothing. Something cleverer would be a
 * second parameter nobody has measured on top of two that are already judgement
 * calls, and it would make the number harder to explain at exactly the moment
 * somebody distrusts it.
 */
function estimate(track: Track, now: number): string | null {
  const { samples } = track;
  // Rule 1: one sample is a position, not a speed.
  if (samples.length < 2) return null;
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  // Rule 3: silence longer than the window the rate was measured over.
  if (now - last.at > STALL_MS) return null;

  const moved = last.page - first.page;
  const span = last.at - first.at;
  if (moved <= 0 || span <= 0) return null;

  const remaining = track.total - last.page;
  /*
   * NOTHING LEFT TO FORECAST. The last count of a phase is the phase finishing;
   * "~5s left" over a run that is writing its output is a countdown to an event
   * that already happened.
   */
  if (remaining <= 0) return null;

  /*
   * MEASURED AT THE LAST SAMPLE AND NOT COUNTED DOWN FROM IT. The tempting
   * refinement is to subtract the time since that sample, so the number ticks
   * towards zero between counts — and it is wrong in the one case it would be
   * seen most: a translation whose block takes four minutes would tick down to
   * "~5s left" and sit there, which is a display that has run out of estimate
   * and is still talking. The estimate is what the last measurement implies, it
   * is refreshed by the next count, and the tilde carries the rest.
   */
  return say((remaining / moved) * span);
}

/**
 * THE WORDING — "~40s left", "~3m left", "~1h 10m left".
 *
 * ── The precision comes DOWN as the number goes up, deliberately ────────────
 *
 * A forecast made from a rate measured over three minutes is not accurate to
 * the second at the two-hour mark, and writing "~1h 47m left" claims it is. So
 * the rounding coarsens with the magnitude — five seconds under a minute, whole
 * minutes under ten, five minutes above that — and what a person reads is the
 * precision the estimate actually has. The tilde says it is an estimate; the
 * rounding says how much of one.
 *
 * NO FILENAMES, NO JARGON, NO UNITS THE READER HAS TO CONVERT: this line sits
 * under a count of pages or blocks and its whole job is to be read at a glance
 * and not thought about.
 */
function say(ms: number): string {
  const seconds = ms / 1000;
  const rounded = Math.max(5, Math.round(seconds / 5) * 5);
  if (rounded < 60) return `~${rounded}s left`;

  const minutes = seconds / 60;
  if (minutes < 10) return `~${Math.round(minutes)}m left`;
  if (minutes < 60) return `~${Math.round(minutes / 5) * 5}m left`;

  let hours = Math.floor(minutes / 60);
  let rest = Math.round((minutes - hours * 60) / 5) * 5;
  if (rest === 60) {
    hours += 1;
    rest = 0;
  }
  /*
   * PAST A DAY THE NUMBER IS NOT THE POINT. A rate that forecasts thirty-one
   * hours is either a book nobody should have started on this machine or a
   * window that has watched two slow blocks and extrapolated them over four
   * thousand — and "~31h left" invites somebody to plan around a figure with an
   * error bar the size of the estimate.
   */
  if (hours >= 24) return '~more than a day left';
  return rest === 0 ? `~${hours}h left` : `~${hours}h ${rest}m left`;
}

/**
 * HOW MANY MOVEMENTS THE RATE IS MEASURED OVER, at most.
 *
 * Twenty, and the number is chosen against the fastest thing that counts. The
 * rasterise pass posts several pages a second, so twenty samples there is a few
 * seconds of history — short enough that the estimate follows a book whose pages
 * get denser rather than averaging the whole run into a flat line. It is also
 * the memory bound: twenty small objects per running job, three running jobs,
 * and the map is rebuilt from the snapshot every time.
 */
const WINDOW_SAMPLES = 20;

/**
 * AND HOW OLD THE OLDEST OF THEM MAY BE.
 *
 * Three minutes, chosen against the slowest thing that counts. A translation
 * posts a block every ten to sixty seconds, so this holds three to eighteen of
 * them: enough that one pathological block does not throw the estimate, short
 * enough that the rate is about the chapter being translated now rather than
 * about the whole run. Both caps apply and whichever bites first wins — the
 * fast pass is bounded by the count, the slow pass by the clock.
 *
 * THE FLOOR OF TWO OVERRIDES IT (see `advance`). A translation whose blocks each
 * take four minutes would otherwise age out of its own history and never say
 * anything, when its last two blocks are exactly what an estimate should be made
 * of — and if those two are genuinely stale, the stall rule is what retires the
 * estimate, not the eviction.
 */
const WINDOW_MS = 3 * 60_000;

/**
 * HOW LONG A SILENCE IS ALLOWED TO BE before the estimate goes away.
 *
 * The window itself, and the equality is the argument rather than a coincidence:
 * once nothing has moved for longer than the span the rate was measured over,
 * every sample behind that rate is older than the silence in front of it, and
 * the number on screen is a description of a past that has stopped applying.
 * Three minutes is also comfortably longer than the worst honest stall this
 * codebase knows about — a block whose answer is rejected and asked twice more
 * (`Job.note`) — so a run that is retrying keeps its estimate and only a run
 * that has genuinely gone quiet loses it.
 */
const STALL_MS = WINDOW_MS;

/**
 * How often the clock is bumped while anything is running.
 *
 * Ten seconds, which is a fortieth of the silence it exists to detect — fine
 * enough that a stalled estimate goes away promptly, coarse enough that it is
 * not a render loop. It costs nothing at all while the board is idle, because
 * there is no timer then.
 */
const TICK_MS = 10_000;
