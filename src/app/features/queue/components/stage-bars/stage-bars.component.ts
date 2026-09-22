/**
 * Stacked per-stage progress bars — one labelled row per stage, each 0-100% within
 * itself. The single shared rendering for every stage list in the queue, whether the
 * stages came from a bridge (reassembly, generate-sentences) or were derived from a
 * job's phase fields (TTS, bilingual assembly).
 *
 * A stage that hasn't started shows "--" rather than "0%": zero percent of a step
 * that isn't running yet is noise, and the dimmed row already says "not yet".
 */

import { Component, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { JobStageProgress, PrepSubProgress } from '../../models/queue.types';
import { prepFraction, prepLabel } from '@shared/queue/bench';

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
      }
      <!-- THE DETAIL AND THE PREP SUB-BAR SIT UNDER THE WHOLE LIST, not under
           the running stage. Until 2026-09-21 they were emitted inside the loop
           after the running row, which put a line of text BETWEEN two stage
           bars (the align row's "Placing words" and "Measuring the book") and,
           indented to the label column, left it floating mid-card. Owen: "put
           the text somewhere else … same location for all messages so
           progress bars are aligned relative to each other." One place, flush
           with the bars, whichever stage is running.
           The MLX batch had its own row here until 2026-09-11. Its rows retire
           one at a time, the bridge folds them into the chunk count, and the
           CONVERT stage bar moves during the decode — so a second bar saying
           the same thing in a different unit was removed. The detail line
           still names what is being rendered together. -->
      @if (hasRunning()) {
        @if (detail()) {
          <div class="stage-detail">{{ detail() }}</div>
        }
        @if (prep(); as p) {
          <div class="batch-row">
            @if (prepFraction(p) !== undefined) {
              <div class="batch-track">
                <div class="batch-fill" [style.width.%]="prepFraction(p)! * 100"></div>
              </div>
            }
            <span class="batch-text">{{ prepLabel(p) }}</span>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      /* Room between the master bar above and the first stage row, so the two
         read as a headline and a breakdown rather than one bar sitting on
         another (Owen, 2026-09-21: "a little too close to the master"). */
      margin-top: 0.55rem;
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
      background: var(--progress-track);
      border-radius: 3px;
      overflow: hidden;
    }

    .stage-fill {
      height: 100%;
      background: var(--progress-fill);
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .stage-pct {
      flex: 0 0 2.75rem;
      font-size: 0.6875rem;
      color: var(--progress-value);
      font-weight: 600;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    /* Under the whole stage list, flush with the labels: one place for every
       message, so the bars above it stay contiguous and aligned. */
    .stage-detail {
      margin: 0.1rem 0 0 0;
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The sub-stage bar (today the prep pass; the MLX batch used it until
       2026-09-11). Deliberately quieter than every other bar here — half the
       height, a muted fill, indented with the detail line — because it measures a
       sub-unit of the running stage, not the stage itself. */
    .batch-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin: 0.1rem 0 0 0;
    }

    .batch-track {
      flex: 0 1 8rem;
      min-width: 0;
      height: 3px;
      background: var(--progress-track);
      border-radius: 2px;
      overflow: hidden;
    }

    /* A 55%-transparent color-mix let the dark track show through a fill already
       close to it in value, so this row read as an empty track. Quiet is now a
       lighter grey at full opacity: still subordinate to the stage bar above, but
       visibly a bar. */
    .batch-fill {
      height: 100%;
      background: var(--progress-fill-quiet);
      border-radius: 2px;
      transition: width 0.4s ease;
    }

    .batch-text {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 0.625rem;
      color: var(--progress-label);
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
   * What the RUNNING stage is doing right now, shown beneath it — "Rendering 21
   * chunks together · 2,949 tokens" while an MLX batch decodes. The stage's bar
   * moves through that batch now (its retired rows are folded into the chunk
   * count), so this says WHAT is being rendered rather than THAT anything is.
   * Omitted when the bridge has nothing specific to say.
   */
  readonly detail = input<string | undefined>(undefined);

  /**
   * Counted work inside the PREPARING stage, when there is some.
   *
   * The number-normalization pass walks a whole book through a local model before
   * e2a is spawned, and "Preparing book" cannot move while it does — so this is
   * the one sub-stage bar left here, and absent means nothing is drawn.
   */
  readonly prep = input<PrepSubProgress | undefined>(undefined);

  /** Both from shared/queue/bench.ts, so every card words this pass alike. */
  /** Whether any stage is running — the detail and the prep bar belong to a live list only. */
  readonly hasRunning = computed(() => this.stages().some((s) => s.status === 'running'));
  readonly prepLabel = prepLabel;
  readonly prepFraction = prepFraction;
}
