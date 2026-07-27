/**
 * Shared job-stage progress model.
 *
 * A long-running job is a SEQUENCE of stages with wildly different durations
 * (denoising 3,000 sentences is minutes; writing chapter markers is a second).
 * A single 0-100 bar over that sequence is a lie — it either stalls for minutes
 * or leaps 40% at once, and it can't say WHICH part is slow.
 *
 * Instead every stage reports its OWN 0-100 fraction, and the headline
 * percentage is the duration-WEIGHTED average of those fractions. That headline
 * is naturally monotonic, because a stage's fraction only ever increases.
 *
 * The stage list is per-run: a reassembly that runs RVC declares an RVC stage, one
 * that doesn't never shows the bar. Weights are relative, not percentages — the
 * tracker normalizes them — so adding a stage doesn't require rebalancing the rest.
 */

/** One stacked stage bar, as sent to the renderer. */
export interface JobStageProgress {
  name: string;
  label: string;
  /** 0-100 WITHIN this stage. */
  pct: number;
  status: 'pending' | 'running' | 'complete';
}

/** Declaration of one stage. `weight` is relative to the other stages in the run. */
export interface StageSpec {
  name: string;
  label: string;
  /** Relative share of total job duration. Normalized against the other stages. */
  weight: number;
}

/**
 * Ordered stage state for one job run.
 *
 * Ordering matters: advancing to a later stage completes every earlier one. Bridges
 * observe subprocess output out of order and can miss the "finished" line for a fast
 * stage entirely, so "we're on stage N" is the only reliable signal that stages
 * 0..N-1 are done.
 */
export class StageTracker {
  private readonly specs: StageSpec[];
  private readonly stages: JobStageProgress[];
  private readonly totalWeight: number;

  constructor(specs: StageSpec[]) {
    if (specs.length === 0) {
      throw new Error('StageTracker requires at least one stage');
    }
    const zeroOrNegative = specs.find(s => !(s.weight > 0));
    if (zeroOrNegative) {
      throw new Error(`StageTracker: stage "${zeroOrNegative.name}" needs a positive weight`);
    }
    this.specs = specs;
    this.totalWeight = specs.reduce((acc, s) => acc + s.weight, 0);
    this.stages = specs.map(s => ({ name: s.name, label: s.label, pct: 0, status: 'pending' }));
  }

  /** Index of a declared stage, or -1 when this run didn't declare it. */
  private indexOf(name: string): number {
    return this.specs.findIndex(s => s.name === name);
  }

  /** True when this run declared the stage (optional stages are absent by design). */
  has(name: string): boolean {
    return this.indexOf(name) >= 0;
  }

  /**
   * Mark a stage as running WITHOUT claiming a fraction — for stages whose progress
   * isn't measurable until the first subprocess line lands. Completes earlier stages.
   */
  start(name: string): void {
    const idx = this.indexOf(name);
    if (idx < 0) return;
    this.completeBefore(idx);
    if (this.stages[idx].status === 'pending') this.stages[idx].status = 'running';
  }

  /**
   * Set a stage's fraction. Monotonic — a lower value than already reported is
   * ignored, so an ffmpeg heartbeat can never drag a bar backwards. Completes
   * every earlier stage.
   */
  set(name: string, pct: number): void {
    const idx = this.indexOf(name);
    if (idx < 0) return;
    this.completeBefore(idx);
    const clamped = Math.max(0, Math.min(100, pct));
    const stage = this.stages[idx];
    if (clamped > stage.pct) stage.pct = clamped;
    if (stage.status === 'pending') stage.status = 'running';
    if (stage.pct >= 100) stage.status = 'complete';
  }

  /** Fill a stage to 100% and mark it done (plus every earlier stage). */
  complete(name: string): void {
    const idx = this.indexOf(name);
    if (idx < 0) return;
    this.completeBefore(idx);
    this.stages[idx].pct = 100;
    this.stages[idx].status = 'complete';
  }

  /** Terminal success: every stage reads 100%. */
  completeAll(): void {
    for (const stage of this.stages) {
      stage.pct = 100;
      stage.status = 'complete';
    }
  }

  private completeBefore(idx: number): void {
    for (let i = 0; i < idx; i++) {
      this.stages[i].pct = 100;
      this.stages[i].status = 'complete';
    }
  }

  /** The stage currently running, or undefined once everything is complete. */
  current(): JobStageProgress | undefined {
    return this.stages.find(s => s.status !== 'complete');
  }

  /** Duration-weighted headline percentage, 0-100 with one decimal. */
  master(): number {
    const weighted = this.stages.reduce(
      (acc, stage, i) => acc + stage.pct * this.specs[i].weight,
      0,
    );
    return Math.round((weighted / this.totalWeight) * 10) / 10;
  }

  /** Detached copy for sending over IPC. */
  snapshot(): JobStageProgress[] {
    return this.stages.map(s => ({ ...s }));
  }
}
