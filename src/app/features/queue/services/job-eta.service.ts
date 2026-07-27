/**
 * The single throughput measurement every progress readout shares.
 *
 * Speed and ETA must never disagree, so both come from ONE sample per job, taken
 * when a chunk completes and HELD between completions. The readouts used to divide
 * a frozen chunk count by a growing elapsed on every one-second tick, so the rate
 * slid down and the ETA crept up between completions, then both jumped when a chunk
 * landed. That is what the holding does away with: a completion takes one
 * measurement, and the ETA counts down monotonically from it until the next one.
 *
 * State lives HERE rather than in a component because the queue list tears
 * components down and rebuilds them freely; a per-component sample would reset the
 * measurement every time a job scrolled or the panel switched.
 */

import { Injectable, OnDestroy, signal } from '@angular/core';
import { QueueJob, RATE_WINDOW_MIN_SECONDS } from '../models/queue.types';

interface RateSample {
  /** Session chunk count this sample was measured at — the key for holding vs re-measuring. */
  chunksDone: number;
  /**
   * The anchor this sample was measured from. A retry reuses the job id but re-stamps
   * the anchor, so comparing it is what stops a fresh run inheriting the previous
   * run's rate the moment its chunk count happens to pass the old one.
   */
  anchorAt: number;
  chunksPerMin: number;
  sentencesPerMin: number | null;
  /** Seconds remaining as of `stampedAt`. */
  etaSeconds: number;
  stampedAt: number;
}

/** Reassembly measures per-stage, because its stages run at wildly different speeds. */
interface StageEtaState {
  stageName: string;
  /** When the CURRENT stage started, and how far in it already was. */
  startedAt: number;
  startPct: number;
}

@Injectable({ providedIn: 'root' })
export class JobEtaService implements OnDestroy {
  /**
   * One global 1-second tick instead of a timer per component. Read it inside a
   * computed/template expression to re-evaluate every second.
   */
  readonly tick = signal(0);

  private readonly samples = new Map<string, RateSample>();
  private readonly stageEta = new Map<string, StageEtaState>();
  /** Master/workflow ETAs arrive from the queue service periodically; count down between. */
  private readonly masterEta = new Map<string, { value: number; receivedAt: number }>();

  private readonly timer = setInterval(() => this.tick.update(t => t + 1), 1000);

  ngOnDestroy(): void {
    clearInterval(this.timer);
  }

  /** Drop every cached measurement for a job (on completion, removal or restart). */
  forget(jobId: string): void {
    this.samples.delete(jobId);
    this.stageEta.delete(jobId);
    this.masterEta.delete(jobId);
  }

  /**
   * Chunk-throughput sample for a chunked job (TTS, AI cleanup), or null when there
   * isn't yet an honest window to measure.
   *
   * The window is [firstChunkCompletedAt, now] and contains exactly the completions
   * since chunksAtFirstStamp — the count the anchor was stamped at. It is NOT
   * (chunksDone - 1): that convention assumed progress arrives one chunk at a time,
   * but Orpheus emits "Converting sentence" only when a batch of 64 finishes, so the
   * FIRST observation is routinely already 128 chunks deep. Crediting 127 of them to
   * a window that just opened reported 429 chunks/min for a job running at ~70.
   *
   * Consequence: no rate until the second flush lands, and none until the window
   * spans RATE_WINDOW_MIN_SECONDS. One observation cannot time anything, and one
   * batch gap is too quantized to trust.
   */
  private rateSample(job: QueueJob): RateSample | null {
    const anchorAt = job.firstChunkCompletedAt;
    const anchorChunks = job.chunksAtFirstStamp;
    // Both or neither. A job carrying only the timestamp came from a build that
    // didn't record the count — there is no honest rate to derive from it.
    if (anchorAt === undefined || anchorChunks === undefined) return null;

    // Nullish, not ||: a real 0 must not collapse to the cumulative count.
    const chunksDoneInSession = job.chunksDoneInSession ?? job.chunksCompletedInJob ?? 0;
    const chunksInWindow = chunksDoneInSession - anchorChunks;
    if (chunksInWindow <= 0) return null;        // still inside the anchoring batch

    const held = this.samples.get(job.id);
    if (held && held.anchorAt === anchorAt && held.chunksDone === chunksDoneInSession) {
      return held;                               // hold — do not re-divide by a longer elapsed
    }

    const elapsedMs = Date.now() - anchorAt;
    if (elapsedMs < RATE_WINDOW_MIN_SECONDS * 1000) return null;
    const chunksPerMin = chunksInWindow / (elapsedMs / 60000);

    // Sentences/min rides the SAME chunk rate scaled by the sentences-per-chunk
    // ratio, so it stays exactly consistent with chunks/min and with the ETA. Prefer
    // the exact ratio (backend summed the real-sentence counts of the chunks actually
    // rendered); fall back to the book average only on sessions with no per-chunk
    // counts. Meaningless for 1:1 engines (XTTS), where it would duplicate chunks/min.
    const totalChunks = job.totalChunksInJob || 0;
    const rawTotal = job.totalRawSentencesInJob || 0;
    let sentencesPerMin: number | null = null;
    if (totalChunks > 0 && rawTotal > totalChunks) {
      const exact = job.rawSentencesDoneInSession;
      const ratio = (typeof exact === 'number' && exact > 0)
        ? exact / chunksDoneInSession
        : rawTotal / totalChunks;
      sentencesPerMin = chunksPerMin * ratio;
    }

    // Remaining uses the CUMULATIVE count (a resume job has work banked from earlier
    // sessions) while the rate came from this session only.
    const totalForEta = job.totalChunksInJob || job.totalChunks || 0;
    const remainingChunks = Math.max(0, totalForEta - (job.chunksCompletedInJob || 0));
    const etaSeconds = chunksPerMin > 0 && totalForEta > 0
      ? Math.round((remainingChunks / chunksPerMin) * 60)
      : 0;

    const sample: RateSample = {
      chunksDone: chunksDoneInSession,
      anchorAt,
      chunksPerMin,
      sentencesPerMin,
      etaSeconds,
      stampedAt: Date.now(),
    };
    this.samples.set(job.id, sample);
    return sample;
  }

  /**
   * Seconds remaining for a job whose progress is a stage sequence (reassembly).
   *
   * Measured WITHIN the current stage and extrapolated to the whole remaining plan by
   * relative stage weight. Stages differ by orders of magnitude — denoising 3,000
   * sentences versus writing chapter markers — so a whole-job elapsed/progress
   * extrapolation is meaningless the moment the job changes stage. Restarting the
   * measurement at every transition is what keeps the estimate believable.
   */
  private stageEtaSeconds(job: QueueJob, stages: { name: string; pct: number; status: string }[]): number | null {
    const running = stages.find(s => s.status === 'running');
    if (!running) return null;

    const state = this.stageEta.get(job.id);
    if (!state || state.stageName !== running.name) {
      this.stageEta.set(job.id, { stageName: running.name, startedAt: Date.now(), startPct: running.pct });
      return null;                                // no elapsed inside this stage yet
    }

    const elapsedSec = (Date.now() - state.startedAt) / 1000;
    const advanced = running.pct - state.startPct;
    // Need real movement inside the stage before the per-percent cost means anything.
    if (elapsedSec < 5 || advanced < 1) return null;

    const secondsPerPct = elapsedSec / advanced;
    const thisStageRemaining = secondsPerPct * (100 - running.pct);

    // The remaining stages have no measurement of their own yet. Charging them the
    // current stage's per-percent cost is a rough but stable stand-in, and it's
    // visibly better than pretending they're free.
    const laterStages = stages.slice(stages.indexOf(running) + 1);
    const laterRemaining = laterStages.reduce((acc, s) => acc + secondsPerPct * (100 - s.pct), 0);

    return Math.round(thisStageRemaining + laterRemaining);
  }

  /**
   * Master/workflow ETA. The queue service recomputes this every 15s across all
   * children; between updates it's counted down locally so the number moves.
   */
  private masterEtaSeconds(job: QueueJob): number | null {
    if (job.estimatedSecondsRemaining === undefined) return null;
    const held = this.masterEta.get(job.id);
    if (!held || held.value !== job.estimatedSecondsRemaining) {
      this.masterEta.set(job.id, { value: job.estimatedSecondsRemaining, receivedAt: Date.now() });
      return job.estimatedSecondsRemaining;
    }
    const elapsed = Math.floor((Date.now() - held.receivedAt) / 1000);
    return Math.max(0, held.value - elapsed);
  }

  /**
   * Seconds remaining, or null when nothing measurable exists yet.
   *
   * Never extrapolates from job-start elapsed — that window includes model load and
   * pass-1 planning, so elapsed/progress grossly overshoots and the estimate slides
   * downward on every refresh instead of holding. Null until a real measurement
   * exists; the caller decides how to say "not yet".
   */
  etaSeconds(job: QueueJob, stages: { name: string; pct: number; status: string }[] = []): number | null {
    this.tick();  // re-evaluate every second

    if (job.status !== 'processing') return null;
    // Pass-1 planning has no predictable duration — don't fabricate an ETA.
    if (job.cleanupPhase === 'analyzing') return null;

    // Workflow master: the queue service already summed running + pending children.
    if (job.workflowId && !job.parentJobId) return this.masterEtaSeconds(job);

    const sample = this.rateSample(job);
    if (sample) {
      const sinceSample = Math.floor((Date.now() - sample.stampedAt) / 1000);
      return Math.max(0, sample.etaSeconds - sinceSample);
    }

    return this.stageEtaSeconds(job, stages);
  }

  /** Human-readable ETA, including the reasons an estimate isn't available yet. */
  etaDisplay(job: QueueJob, stages: { name: string; pct: number; status: string }[] = []): string {
    if (job.status === 'complete') return 'Complete';
    if (job.status !== 'processing') return '-';
    if ((job.progress || 0) >= 100) return 'Complete';
    if (job.cleanupPhase === 'analyzing') return 'Analyzing…';

    const seconds = this.etaSeconds(job, stages);
    if (seconds !== null) return formatDuration(seconds);

    // Nothing measured yet. Say which kind of waiting it is — a chunked job sitting
    // at zero completions is loading a model, not stalled.
    if (job.totalChunksInJob && !job.chunksCompletedInJob) return 'Loading models…';
    return 'Calculating…';
  }

  /**
   * Wall-clock time this job should finish, for the jobs long enough that "4h 12m"
   * means less than "9:47 PM". Null whenever the ETA itself is unavailable.
   */
  finishesAt(job: QueueJob, stages: { name: string; pct: number; status: string }[] = []): Date | null {
    const seconds = this.etaSeconds(job, stages);
    if (seconds === null) return null;
    return new Date(Date.now() + seconds * 1000);
  }

  /**
   * Combined speed readout: chunks/min (what the ETA tracks), plus true sentences/min
   * when the chunk→sentence ratio is known. On sessions without that ratio only
   * chunks/min shows — never a duplicate number posing as sentences.
   */
  speedLabel(job: QueueJob): string | null {
    this.tick();
    const sample = this.rateSample(job);
    if (!sample) return null;

    const chunks = Math.round(sample.chunksPerMin * 10) / 10;
    if (sample.sentencesPerMin === null) return `${chunks} chunks/min`;

    const sentences = Math.round(sample.sentencesPerMin);
    // Exact per-chunk sum → no "~"; book-average estimate → keep the "~".
    const exact = typeof job.rawSentencesDoneInSession === 'number' && job.rawSentencesDoneInSession > 0;
    return `${chunks} chunks/min (${exact ? '' : '~'}${sentences} sentences/min)`;
  }

  /** Seconds since a job started, ticking. Zero when it hasn't started. */
  elapsedSeconds(job: QueueJob): number {
    this.tick();
    if (!job.startedAt) return 0;
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    return Math.max(0, Math.floor((end - new Date(job.startedAt).getTime()) / 1000));
  }

  elapsedDisplay(job: QueueJob): string {
    return formatDuration(this.elapsedSeconds(job));
  }
}

/** Compact duration: 45s / 12m 30s / 2h 05m. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;

  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return `${minutes}m ${s % 60}s`;
}
