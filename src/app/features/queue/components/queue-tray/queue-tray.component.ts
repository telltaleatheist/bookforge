/**
 * The queue tray — the dropdown under the top-bar chip.
 *
 * One card per RUN, with a row per step and a short connector between them, so
 * the shape on screen is the shape the engine holds: a chain with lineage, not a
 * flat list of tasks that happen to share a book. The state grammar is the same
 * one Foundry's provenance tree uses — solid check for done, pulsing ring for
 * running, dashed hollow for waiting or held — because they are two views of one
 * pipeline and a user should not have to learn it twice.
 *
 * It draws from QueueTrayService and acts through it. Nothing here decides
 * anything about the queue; every control is a sentence sent to main.
 */

import { ChangeDetectionStrategy, Component, ElementRef, inject, output } from '@angular/core';
import { Router } from '@angular/router';

import { QueueTrayService, TrayJobView } from '../../services/queue-tray.service';

@Component({
  selector: 'app-queue-tray',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'role': 'dialog',
    'aria-label': 'Queue',
    'tabindex': '-1',
    '(keydown.escape)': 'dismiss.emit()',
  },
  template: `
    <div class="tray">
      <div class="tray-head">
        <span class="eyebrow">Queue</span>
        <button type="button" class="btn accent" (click)="toggleQueue()">
          {{ tray.isRunning() ? '❚❚ Pause' : '▶ Start' }}
        </button>
        <button type="button" class="btn" (click)="clearFinished()">Clear finished</button>
      </div>

      @if (tray.jobs().length === 0) {
        <div class="tray-empty">Nothing is queued.</div>
      }

      @for (job of tray.jobs(); track job.id) {
        <div class="job" [class.held]="job.held">
          <div class="goal">
            @if (job.cover) {
              <img class="cover" [src]="job.cover" alt="" />
            } @else {
              <span class="cover cover-blank" aria-hidden="true"></span>
            }
            <div class="goal-text">
              <h4>{{ job.title }}</h4>
              <div class="kicker">{{ job.kicker }}</div>
            </div>
            <div class="goal-right">
              @if (job.held) {
                <button type="button" class="start" (click)="start(job)">▶ Start</button>
              } @else {
                <span>{{ job.right }}</span>
              }
            </div>
          </div>

          @for (step of job.steps; track step.id) {
            @if (!$first) {
              <div class="vline" aria-hidden="true"></div>
            }
            <div class="jstep" [class.active]="step.running">
              <span
                class="sdot"
                [class.done]="step.status === 'done'"
                [class.run]="step.running"
                [class.wait]="step.idle"
                [class.bad]="step.status === 'failed' || step.status === 'cancelled'"
                aria-hidden="true"
              >
                @if (step.status === 'done') {
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                       stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M4 12.5l5 5L20 6.5" />
                  </svg>
                }
              </span>
              <span class="nm">{{ step.name }}</span>
              <div
                class="pbar"
                [class.idle]="!step.running && step.percent === 0"
                [class.bad]="step.status === 'failed' || step.status === 'cancelled'"
              >
                <i [style.width.%]="step.percent"></i>
              </div>
              <span class="pv">{{ step.right }}</span>
            </div>
          }
        </div>
      }

      @if (tray.finished().count > 0) {
        <div class="done-row">
          <span class="okd" [class.bad]="tray.finished().failed.length > 0" aria-hidden="true"></span>
          <span>
            {{ tray.finished().count }} finished today —
            @if (tray.finished().failed.length === 0) {
              <span class="ok">all good</span>
            } @else {
              <span class="bad-text">{{ tray.finished().failed.join(', ') }} failed</span>
            }
          </span>
        </div>
      }

      <div class="tray-foot">
        <button type="button" class="details" (click)="openDetails()">Open queue details →</button>
        <span class="ambient">live in every window</span>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 430px;
      max-width: calc(100vw - 24px);
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      box-shadow: var(--shadow-xl);
      overflow: hidden;
      color: var(--text-primary);
      font-size: 13px;
    }

    :host:focus { outline: none; }

    .tray {
      max-height: min(70vh, 620px);
      overflow-y: auto;
    }

    .tray-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      background: var(--bg-surface);
      z-index: 1;
    }

    .eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1.4px;
      text-transform: uppercase;
      color: var(--text-tertiary);
    }

    .btn {
      display: inline-flex;
      gap: 5px;
      align-items: center;
      padding: 4px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      font-size: 11.5px;
      font-family: inherit;
      cursor: pointer;
    }

    .btn:hover { color: var(--text-primary); border-color: var(--border-strong); }

    .btn.accent {
      margin-left: auto;
      border-color: transparent;
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: 600;
    }

    .tray-empty {
      padding: 22px 14px;
      text-align: center;
      color: var(--text-tertiary);
      font-size: 12px;
    }

    .job {
      border-bottom: 1px solid var(--border-subtle);
      padding: 11px 14px 12px;
    }

    .job.held {
      background: repeating-linear-gradient(
        45deg,
        transparent 0 10px,
        var(--hover-bg) 10px 20px
      );
    }

    .goal {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 9px;
    }

    .cover {
      width: 30px;
      height: 44px;
      border-radius: 4px;
      flex: none;
      object-fit: cover;
      background: var(--bg-input);
    }

    .cover-blank {
      display: block;
      border: 1px solid var(--border-subtle);
    }

    .goal-text { min-width: 0; }

    .goal-text h4 {
      margin: 0;
      font-size: 12.5px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .kicker {
      font-size: 10.5px;
      color: var(--text-tertiary);
      margin-top: 1px;
    }

    .goal-right {
      margin-left: auto;
      padding-left: 8px;
      font-size: 11px;
      color: var(--text-tertiary);
      text-align: right;
      flex: none;
      font-variant-numeric: tabular-nums;
    }

    .start {
      border: none;
      background: transparent;
      color: var(--accent);
      font-weight: 600;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 4px;
    }

    .start:hover { background: var(--accent-subtle); }

    .jstep {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 4px 0 4px 4px;
    }

    .sdot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      flex: none;
      display: grid;
      place-items: center;
      box-sizing: border-box;
    }

    .sdot svg { width: 9px; height: 9px; }

    .sdot.done {
      background: var(--accent);
      color: var(--text-inverse);
    }

    .sdot.run { border: 2px solid var(--accent); }

    .sdot.run::after {
      content: '';
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
      animation: tray-pulse 1.4s ease-in-out infinite;
    }

    .sdot.wait { border: 2px dashed var(--text-muted); }

    .sdot.bad { background: var(--color-danger); }

    @keyframes tray-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.75); }
      50% { opacity: 1; transform: scale(1); }
    }

    .nm {
      font-size: 12px;
      width: 150px;
      flex: none;
      color: var(--text-secondary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .jstep.active .nm { color: var(--text-primary); font-weight: 500; }

    .pbar {
      flex: 1;
      min-width: 0;
      height: 5px;
      border-radius: 3px;
      background: var(--bg-input);
      overflow: hidden;
    }

    .pbar i {
      display: block;
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--accent-hover), var(--accent));
      transition: width 0.4s ease;
    }

    .pbar.idle i { background: var(--border-default); }

    /* How far a step got before it stopped, in the colour of why it stopped. */
    .pbar.bad i { background: var(--color-danger); }

    .pv {
      width: 74px;
      text-align: right;
      font-size: 10.5px;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      flex: none;
    }

    .jstep.active .pv { color: var(--accent); }

    .vline {
      margin-left: 10px;
      width: 2px;
      height: 6px;
      background: var(--border-subtle);
    }

    .done-row {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 14px;
      color: var(--text-tertiary);
      font-size: 12px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .okd {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      flex: none;
    }

    .okd.bad { background: var(--color-danger); }

    .ok { color: var(--success); }
    .bad-text { color: var(--color-danger); }

    .tray-foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 9px 14px;
      background: var(--bg-elevated);
      font-size: 11.5px;
      position: sticky;
      bottom: 0;
    }

    .details {
      border: none;
      background: transparent;
      color: var(--text-tertiary);
      font-size: 11.5px;
      font-family: inherit;
      cursor: pointer;
      padding: 0;
    }

    .details:hover { color: var(--accent); }

    .ambient { color: var(--text-muted); }

    @media (prefers-reduced-motion: reduce) {
      .sdot.run::after { animation: none; opacity: 1; }
      .pbar i { transition: none; }
    }
  `],
})
export class QueueTrayComponent {
  readonly tray = inject(QueueTrayService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The panel wants to go away — Escape, or a control that navigates. */
  readonly dismiss = output<void>();

  /** Take focus so Escape reaches the panel without the user tabbing to it. */
  focus(): void {
    (this.host.nativeElement as HTMLElement).focus();
  }

  async toggleQueue(): Promise<void> {
    await this.tray.toggleQueue();
  }

  async clearFinished(): Promise<void> {
    await this.tray.clearFinished();
  }

  async start(job: TrayJobView): Promise<void> {
    await this.tray.startJob(job.id);
  }

  openDetails(): void {
    this.dismiss.emit();
    void this.router.navigate(['/queue']);
  }
}
