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
import { runElapsedSeconds, taskElapsedSeconds } from '@shared/queue/job-timing';
import { JobStageProgress, QueueJob, RATE_WINDOW_MIN_SECONDS } from '../models/queue.types';

/** The stage fields the ETA math needs — accepts any stage list the UI renders. */
type StageView = Pick<JobStageProgress, 'name' | 'pct' | 'status' | 'weight'>;

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
  /** Words per minute — the legible comparable rate. Null when per-chunk counts are absent. */
  wordsPerMin: number | null;
  /** Characters per minute — what the ETA divides. Null when per-chunk counts are absent. */
  charsPerMin: number | null;
  /**
   * Audio seconds produced per wall second, or null until the bridge has sampled enough
   * rendered audio. The headline figure: it is the only one that does not move with the
   * author's sentence length or the voice's speaking pace.
   */
  realtimeFactor: number | null;
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

    // Sentences/min rides the SAME chunk rate scaled by the sentences-per-chunk ratio
    // COUNTED THIS SESSION, so it stays exactly consistent with chunks/min and the ETA.
    //
    // No book-average stand-in: the backend emits the per-session sentence total and the
    // book total from the same per-chunk counts, so either both are present or neither
    // is. A missing exact count alongside a present book total would mean the per-chunk
    // accrual had broken — and quietly swapping in the book average there would hide
    // exactly that, while looking like a real measurement. Absent → show chunks/min only.
    //
    // Also absent for 1:1 engines (XTTS), where it would just duplicate chunks/min.
    const totalChunks = job.totalChunksInJob || 0;
    const rawTotal = job.totalRawSentencesInJob || 0;
    const rawDone = job.rawSentencesDoneInSession;
    let sentencesPerMin: number | null = null;
    if (totalChunks > 0 && rawTotal > totalChunks && typeof rawDone === 'number' && rawDone > 0) {
      sentencesPerMin = chunksPerMin * (rawDone / chunksDoneInSession);
    }

    // Words and characters ride the same window, scaled by what THIS session actually
    // rendered — same discipline as sentences/min, and absent rather than estimated when
    // the per-chunk counts aren't there.
    const wordsDone = job.rawWordsDoneInSession;
    const charsDone = job.rawCharsDoneInSession;
    const wordsPerMin = typeof wordsDone === 'number' && wordsDone > 0
      ? chunksPerMin * (wordsDone / chunksDoneInSession)
      : null;
    const charsPerMin = typeof charsDone === 'number' && charsDone > 0
      ? chunksPerMin * (charsDone / chunksDoneInSession)
      : null;

    // Audio seconds produced per wall second. Both factors are measured on this run: the
    // character rate above, and the seconds-of-audio-per-character the bridge sampled
    // from the rendered FLACs.
    const secondsPerChar = job.audioSecondsPerChar;
    const realtimeFactor = charsPerMin !== null && typeof secondsPerChar === 'number' && secondsPerChar > 0
      ? (charsPerMin * secondsPerChar) / 60
      : null;

    // Remaining uses the CUMULATIVE count (a resume job has work banked from earlier
    // sessions) while the rate came from this session only.
    //
    // Priced in CHARACTERS when they're known, chunks otherwise. Chunks are packed to a
    // character budget, so they are near-uniform in the body of a book but not at its
    // seams — the last chunk of every chapter is a short one, and a chunk-count ETA
    // charges full price for each. Characters also track the audio duration that is the
    // actual work (seconds-per-char varied ±6% across books measured, seconds-per-word
    // ±11%), so this is the same estimate expressed in the better unit, not a new model.
    const totalCharsForEta = job.totalRawCharsInJob || 0;
    const charsDoneForEta = this.charsCompletedInJob(job);
    let etaSeconds = 0;
    if (charsPerMin !== null && charsPerMin > 0 && totalCharsForEta > 0 && charsDoneForEta !== null) {
      etaSeconds = Math.round((Math.max(0, totalCharsForEta - charsDoneForEta) / charsPerMin) * 60);
    } else {
      const totalForEta = job.totalChunksInJob || job.totalChunks || 0;
      const remainingChunks = Math.max(0, totalForEta - (job.chunksCompletedInJob || 0));
      etaSeconds = chunksPerMin > 0 && totalForEta > 0
        ? Math.round((remainingChunks / chunksPerMin) * 60)
        : 0;
    }

    const sample: RateSample = {
      chunksDone: chunksDoneInSession,
      anchorAt,
      chunksPerMin,
      sentencesPerMin,
      wordsPerMin,
      charsPerMin,
      realtimeFactor,
      etaSeconds,
      stampedAt: Date.now(),
    };
    this.samples.set(job.id, sample);
    return sample;
  }

  /**
   * Characters rendered across the WHOLE job, or null when that can't be counted.
   *
   * Only this session's characters are ever reported. When earlier sessions banked work
   * (a resume), the characters behind those chunks were never counted, and reconstructing
   * them from the book's average chars-per-chunk is precisely the ratio-estimate this
   * file refuses everywhere else — it would look like a measurement and drift with the
   * packing. Null instead, and the caller prices that job in chunks.
   */
  private charsCompletedInJob(job: QueueJob): number | null {
    const sessionChars = job.rawCharsDoneInSession;
    if (typeof sessionChars !== 'number') return null;
    const cumulativeChunks = job.chunksCompletedInJob ?? 0;
    const sessionChunks = job.chunksDoneInSession ?? cumulativeChunks;
    if (cumulativeChunks !== sessionChunks) return null;
    return sessionChars;
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
  private stageEtaSeconds(job: QueueJob, stages: StageView[]): number | null {
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

    // A stage list with no declared weights (derived from phase fields) has nothing to
    // say about relative cost, so every stage counts the same.
    const weightOf = (s: StageView) => (typeof s.weight === 'number' && s.weight > 0 ? s.weight : 1);

    // Calibrate on the ONE stage actually being measured: how long a percent of it takes,
    // per unit of its declared weight. Every remaining stage is then priced by its own
    // weight against that constant, so the estimate carries the pipeline's real shape
    // instead of assuming the cheap trailing steps cost as much as the expensive one.
    const secondsPerWeightedPct = (elapsedSec / advanced) / weightOf(running);

    let remaining = secondsPerWeightedPct * weightOf(running) * (100 - running.pct);
    for (const stage of stages.slice(stages.indexOf(running) + 1)) {
      remaining += secondsPerWeightedPct * weightOf(stage) * (100 - stage.pct);
    }

    return Math.round(remaining);
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
  etaSeconds(job: QueueJob, stages: StageView[] = []): number | null {
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
  etaDisplay(job: QueueJob, stages: StageView[] = []): string {
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
  finishesAt(job: QueueJob, stages: StageView[] = []): Date | null {
    const seconds = this.etaSeconds(job, stages);
    if (seconds === null) return null;
    return new Date(Date.now() + seconds * 1000);
  }

  /**
   * Headline speed: the REALTIME FACTOR — how much audio a minute of work produces.
   *
   * Sentences/min used to lead here, and it was actively misleading. A chunk is packed to
   * a character budget, so it holds however many sentences fit: ~1.9 for a dense author,
   * ~4.4 for a sparse one. Three real jobs measured 188 / 150 / 92 sentences per minute
   * while producing 839 / 717 / 841 audio-seconds per wall-minute — the slowest-looking
   * book was the fastest running, and its ETA (correct, it was 5.3x the text) read as a
   * fault. Audio is the unit of work, so audio per wall-clock is the figure that means
   * the same thing on every book and every voice.
   *
   * Null realtimeFactor is a real state, not an error: the bridge has to sample rendered
   * audio before it can report one. The text rates show alone until then, rather than a
   * placeholder that would look like a measurement.
   */
  speedLabel(job: QueueJob): string | null {
    this.tick();
    const sample = this.rateSample(job);
    if (!sample) return null;

    // Words lead the text rates because they are legible — "2,040 words/min" carries an
    // intuition that "12,597 chars/min" does not, at identical accuracy. Sentences/min
    // stays alongside: within one book it tracks progress honestly and a stall shows in
    // it, it just can't be compared between books.
    const textRates: string[] = [];
    if (sample.wordsPerMin !== null) {
      textRates.push(`${Math.round(sample.wordsPerMin).toLocaleString()} words/min`);
    }
    if (sample.sentencesPerMin !== null) {
      textRates.push(`${Math.round(sample.sentencesPerMin)} sent/min`);
    }
    if (textRates.length === 0) {
      textRates.push(`${Math.round(sample.chunksPerMin * 10) / 10} chunks/min`);
    }

    const text = textRates.join(' · ');
    return sample.realtimeFactor !== null
      ? `${(Math.round(sample.realtimeFactor * 10) / 10).toFixed(1)}x realtime (${text})`
      : text;
  }

  /** Seconds THIS ONE task has been working, ticking. Zero before it starts. */
  elapsedSeconds(job: QueueJob): number {
    this.tick();
    return taskElapsedSeconds(job, Date.now());
  }

  elapsedDisplay(job: QueueJob): string {
    return formatDuration(this.elapsedSeconds(job));
  }

  /**
   * Total time a RUN has been working — every task in it, added up.
   *
   * The row a run is headed by executes nothing itself, so its elapsed is read from
   * its steps rather than from its own timestamps. A standalone job is a run of one,
   * which is why this takes the step list and not a master row.
   */
  runElapsedDisplay(steps: readonly QueueJob[]): string {
    this.tick();
    return formatDuration(runElapsedSeconds(steps, Date.now()));
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
