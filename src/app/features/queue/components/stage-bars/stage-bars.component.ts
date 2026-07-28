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
import { JobStageProgress } from '../../models/queue.types';

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

      .stage-detail {
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
}
