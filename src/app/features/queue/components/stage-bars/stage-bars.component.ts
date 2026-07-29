/**
 * Stacked per-stage progress bars — one labelled row per stage, each 0-100% within
 * itself. The single shared rendering for every stage list in the queue, whether the
 * stages came from a bridge (reassembly, generate-sentences) or were derived from a
 * job's phase fields (TTS, bilingual assembly).
 *
 * A stage that hasn't started shows "--" rather than "0%": zero percent of a step
 * that isn't running yet is noise, and the dimmed row already says "not yet".
 */

import { Component, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActiveBatchProgress, JobStageProgress } from '../../models/queue.types';

@Component({
  selector: 'app-stage-bars',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="stage-bars">
      @for (stage of stages(); track stage.name) {
        <div
          class="stage-row"
          [class.pending]="stage.status === 'pending'"
          [class.active]="stage.status === 'running'"
          [class.complete]="stage.status === 'complete'"
        >
          <span class="stage-label" [title]="stage.label">{{ stage.label }}</span>
          <div class="stage-track">
            <div class="stage-fill" [style.width.%]="stage.pct"></div>
          </div>
          <span class="stage-pct">
            @if (stage.status === 'pending') { -- } @else { {{ stage.pct | number:'1.0-0' }}% }
          </span>
        </div>
        @if (detail() && stage.status === 'running') {
          <div class="stage-detail">{{ detail() }}</div>
        }
        @if (batch(); as b) {
          @if (stage.status === 'running') {
            <div class="batch-row">
              @if (b.fraction !== undefined) {
                <div class="batch-track">
                  <div class="batch-fill" [style.width.%]="b.fraction * 100"></div>
                </div>
              }
              <span class="batch-text">{{ batchLabel(b) }}</span>
            </div>
          }
        }
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .stage-bars {
      display: flex;
      flex-direction: column;
      gap: 0.3rem;
    }

    .stage-row {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }

    .stage-label {
      flex: 0 0 9.5rem;
      min-width: 0;
      font-size: 0.75rem;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stage-track {
      flex: 1;
      min-width: 0;
      height: 5px;
      background: var(--bg-sunken);
      border-radius: 3px;
      overflow: hidden;
    }

    .stage-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .stage-pct {
      flex: 0 0 2.75rem;
      font-size: 0.6875rem;
      color: var(--text-secondary);
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    /* Indented under the running stage's label so it reads as that stage's detail
       rather than a second message about the job as a whole. */
    .stage-detail {
      margin: -0.1rem 0 0.15rem 10.125rem;
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The within-batch bar. Deliberately quieter than every other bar here — half
       the height, a muted fill, indented with the detail line — because it measures
       a sub-unit of the running stage, not the stage itself. */
    .batch-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0 0 0.2rem 10.125rem;
    }

    .batch-track {
      flex: 0 1 8rem;
      min-width: 0;
      height: 3px;
      background: var(--bg-sunken);
      border-radius: 2px;
      overflow: hidden;
    }

    .batch-fill {
      height: 100%;
      background: color-mix(in srgb, var(--accent) 55%, transparent);
      border-radius: 2px;
      transition: width 0.4s ease;
    }

    .batch-text {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.625rem;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .stage-row.pending {
      opacity: 0.45;

      .stage-label {
        color: var(--text-tertiary);
      }
    }

    .stage-row.active {
      .stage-label {
        color: var(--accent);
        font-weight: 500;
      }
    }

    .stage-row.complete {
      .stage-label {
        color: var(--success);
      }

      .stage-fill {
        background: var(--success);
      }
    }

    /* Narrow panels: the label can't hold a fixed 9.5rem and leave a usable track. */
    @media (max-width: 640px) {
      .stage-label {
        flex-basis: 6.5rem;
      }

      .stage-detail,
      .batch-row {
        margin-left: 7.125rem;
      }
    }
  `]
})
export class StageBarsComponent {
  readonly stages = input.required<JobStageProgress[]>();
  /**
   * What the RUNNING stage is doing right now, shown beneath it. For stages whose
   * percentage genuinely cannot move for minutes — an MLX batch renders 7-23
   * sentences as one atomic unit — this is the only thing distinguishing work from
   * a hang. Omitted when the bridge has nothing specific to say.
   */
  readonly detail = input<string | undefined>(undefined);
  /**
   * Progress inside the batch the running stage is decoding right now, when one is.
   *
   * The MLX audiobook path renders ~96 chunks as a single atomic 5-7 minute decode:
   * the stage's own percentage cannot move until every one of them lands at once.
   * This is the only thing that moves in between. Absent for every other engine and
   * between batches — and absent means nothing is drawn, not a bar at zero.
   */
  readonly batch = input<ActiveBatchProgress | undefined>(undefined);

  /**
   * "batch 12/95 sentences · 1.3k tokens" — rows first (the thing being waited on),
   * tokens second (how deep the decode is). Each clause is dropped when the engine
   * didn't report it rather than filled in with a guess.
   */
  batchLabel(b: ActiveBatchProgress): string {
    const parts: string[] = [];
    parts.push(b.rowsDone !== undefined
      ? `batch ${b.rowsDone}/${b.rowsTotal} sentences`
      : `batch of ${b.rowsTotal} sentences`);
    parts.push(`${this.compactTokens(b.tokenStep)} tokens`);
    // Which sub-batch of the current engine call this is — only worth saying when
    // the call was split into several (a batch too deep to run at full width).
    if (b.batchNo !== undefined && b.batchCount !== undefined && b.batchCount > 1) {
      parts.push(`part ${b.batchNo}/${b.batchCount}`);
    }
    return parts.join(' · ');
  }

  /** 1259 → "1.3k". Token counts run to four digits and only the magnitude matters. */
  private compactTokens(n: number): string {
    if (n < 1000) return String(n);
    return `${(n / 1000).toFixed(1)}k`;
  }
}
