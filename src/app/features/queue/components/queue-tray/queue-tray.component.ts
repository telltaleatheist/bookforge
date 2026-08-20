/**
 * The queue shelf — the dropdown under the top-bar chip.
 *
 * ── The bands, in the order they matter ─────────────────────────────────────
 *
 *   Needs you   — failures. Empty almost always, and therefore worth reading
 *                 when it is not.
 *   On the bench— the THREE SLOTS, always all three, occupied or free. This is
 *                 the shelf's centre of gravity: allocating one GPU slot and two
 *                 CPU slots is the entire job of the scheduler, and until this
 *                 redesign no surface drew them.
 *   Up next     — everything waiting, each row saying WHY it is waiting in a
 *                 sentence. Five distinct reasons that used to render alike.
 *   Finished    — one line. History, drawn as history.
 *
 * A band with nothing in it is not drawn, so the panel is short when the queue
 * is quiet and long only when there is genuinely that much to say.
 *
 * ── It is not a dead end any more ───────────────────────────────────────────
 *
 * The old shelf could start a held run and pause the engine, and every other
 * intent ended at "Open queue details →" — which re-listed what you were already
 * looking at. Stop, retry, start and remove all live here now. Nothing here
 * DECIDES anything: every control is a sentence sent through QueueTrayService to
 * main, which owns the queue.
 *
 * The state grammar (solid check for done, pulsing ring for running, dashed
 * hollow for waiting or held) is the one Foundry's provenance tree uses, because
 * they are two views of one pipeline and a user should not have to learn it
 * twice.
 */

import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, inject, output } from '@angular/core';
import { Router } from '@angular/router';

import { QueueTrayService } from '../../services/queue-tray.service';

@Component({
  selector: 'app-queue-tray',
  standalone: true,
  imports: [DecimalPipe],
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
        <span class="engine" [class.paused]="!tray.isRunning()">
          <span class="led" aria-hidden="true"></span>
          {{ tray.isRunning() ? 'Running' : 'Paused' }}
        </span>
        <button type="button" class="btn accent push" (click)="toggleQueue()">
          {{ tray.isRunning() ? '❚❚ Pause' : '▶ Start' }}
        </button>
      </div>

      <!-- ── Needs you ─────────────────────────────────────────────────── -->
      @if (tray.failures().length > 0) {
        <div class="sec attention">
          <span>Needs you · {{ tray.failures().length }}</span>
          <span class="rule"></span>
        </div>
        @for (run of tray.failures(); track run.stepId) {
          <div class="attn">
            <div class="attn-top">
              @if (run.cover) {
                <img class="cover sm" [src]="run.cover" alt="" />
              } @else {
                <span class="cover sm blank" aria-hidden="true"></span>
              }
              <div class="min">
                <div class="attn-title">{{ run.title }} · {{ run.label }} failed</div>
              </div>
            </div>
            <p class="attn-msg">{{ run.error }}</p>
            <div class="attn-acts">
              <button type="button" class="tiny bad" (click)="retry(run.stepId)">Retry this step</button>
              <button type="button" class="tiny" (click)="remove(run.jobId)">Remove</button>
            </div>
          </div>
        }
      }

      <!-- ── On the bench ──────────────────────────────────────────────── -->
      <div class="sec">
        <span>On the bench · {{ busyLanes() }} of {{ tray.lanes().length }} slots</span>
        <span class="rule"></span>
      </div>

      @for (lane of tray.lanes(); track lane.resource + lane.index) {
        <div
          class="lane"
          [class.gpu]="lane.resource === 'gpu'"
          [class.warn]="lane.hold"
          [class.hot]="lane.thermal?.throttleActive"
          [class.free]="!lane.occupant"
        >
          <div class="slot">
            <b>{{ lane.resource === 'gpu' ? 'GPU' : 'CPU' }}</b>
            {{ lane.index }} of {{ lane.of }}
            @if (lane.thermal; as thermal) {
              <span class="temp" [class.hot]="thermal.throttleActive">{{ thermal.tempC }}°</span>
            }
          </div>

          <div class="lane-body">
            @if (lane.occupant; as busy) {
              <div class="lane-top">
                @if (lane.cover) {
                  <img class="cover" [src]="lane.cover" alt="" />
                } @else {
                  <span class="cover blank" aria-hidden="true"></span>
                }
                <div class="min grow">
                  <div class="act">{{ busy.verb }} <span>· {{ busy.label }}</span></div>
                  <div class="sub">{{ busy.title }}</div>
                </div>
                <div class="right">
                  @if (busy.percent !== null) {
                    <div class="pct">{{ busy.percent | number:'1.0-0' }}%</div>
                  }
                  <div class="eta">{{ lane.eta ?? 'not timed yet' }}</div>
                </div>
              </div>

              <div class="bar" [class.dim]="busy.percent === null">
                <i [style.width.%]="busy.percent ?? 0"></i>
              </div>

              <!-- Only the stage that is RUNNING, and only in the shelf: 452px
                   cannot hold four rows per lane, and the stage that is moving
                   is the one that answers "is this alive?". -->
              @for (stage of busy.stages; track stage.name) {
                @if (stage.status === 'running') {
                  <div class="stage-line">
                    <span class="s-name">{{ stage.label }}</span>
                    <span class="bar thin"><i [style.width.%]="stage.pct"></i></span>
                    <span class="s-val">{{ stage.pct | number:'1.0-0' }}%</span>
                  </div>
                }
              }

              @if (lane.thermal?.throttleActive) {
                <span class="why hot-why">
                  <span class="dot" aria-hidden="true"></span>
                  Running hot — the card is throttling itself
                </span>
              }

              @if (lane.speed; as speed) {
                <div class="detail rate">{{ speed }}</div>
              }

              @if (tray.detailFor(lane); as detail) {
                <div class="detail">{{ detail }}</div>
              }
            } @else if (lane.hold) {
              <div class="act warn-text">Waiting for the card</div>
              <span class="why warn"><span class="dot" aria-hidden="true"></span>{{ lane.hold }}</span>
            } @else {
              <div class="free-text">Free — nothing queued wants this slot</div>
            }
          </div>
        </div>
      }

      <!-- ── Up next ───────────────────────────────────────────────────── -->
      @if (tray.waiting().length > 0) {
        <div class="sec">
          <span>Up next · {{ tray.waiting().length }}</span>
          <span class="rule"></span>
        </div>
        @for (row of tray.waiting(); track row.stepId) {
          <div class="qrow">
            @if (row.cover) {
              <img class="cover xs" [src]="row.cover" alt="" />
            } @else {
              <span class="cover xs blank" aria-hidden="true"></span>
            }
            <div class="min">
              <div class="qact">{{ row.label }} <em>· {{ row.title }}</em></div>
              <span class="why" [class.warn]="row.reason.kind === 'admission'">
                <span class="dot" aria-hidden="true"></span>{{ row.reason.sentence }}
              </span>
            </div>
            <div class="qright">
              @if (row.startable) {
                <button type="button" class="tiny go" (click)="start(row.stepId)">
                  ▶ {{ row.reason.kind === 'stopped' ? 'Resume' : 'Start' }}
                </button>
              }
              <button type="button" class="tiny" (click)="remove(row.jobId)">Remove</button>
            </div>
          </div>
        }
      }

      @if (tray.lanes().length > 0 && busyLanes() === 0 && tray.waiting().length === 0) {
        <div class="empty">
          Nothing is queued. Narrate a book from its versions page, or order a read in the
          Foundry window.
        </div>
      }

      <!-- ── Finished ──────────────────────────────────────────────────── -->
      @if (tray.finished().count > 0) {
        <div class="done-row">
          <span class="okd" [class.bad]="tray.finished().failed.length > 0" aria-hidden="true"></span>
          <span class="min">
            {{ tray.finished().count }} finished today —
            @if (tray.finished().failed.length === 0) {
              <span class="ok">{{ tray.finished().titles.join(', ') }}</span>
            } @else {
              <span class="bad-text">{{ tray.finished().failed.join(', ') }} failed</span>
            }
          </span>
          <button type="button" class="btn" (click)="clearFinished()">Clear</button>
        </div>
      }

      <div class="tray-foot">
        <button type="button" class="details" (click)="openDetails()">Open the queue →</button>
        <span class="ambient">live in every window</span>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      width: 452px;
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
      max-height: min(72vh, 680px);
      overflow-y: auto;
    }

    .min { min-width: 0; }
    .grow { flex: 1; }

    /* ── Head ──────────────────────────────────────────────────────────── */

    .tray-head {
      display: flex;
      align-items: center;
      gap: 9px;
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

    .engine {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .engine .led {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--success);
    }

    .engine.paused .led { background: var(--text-muted); }

    .push { margin-left: auto; }

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
      border-color: transparent;
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: 600;
    }

    /* ── Section rules ─────────────────────────────────────────────────── */

    .sec {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px 5px;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 1.3px;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .sec .rule { flex: 1; height: 1px; background: var(--border-subtle); }
    .sec.attention { color: var(--color-danger); }
    .sec.attention .rule { background: var(--color-danger); opacity: 0.3; }

    /* ── Covers ────────────────────────────────────────────────────────── */

    .cover {
      width: 22px;
      height: 32px;
      border-radius: 4px;
      flex: none;
      object-fit: cover;
      background: var(--bg-input);
      display: block;
    }

    .cover.sm { width: 20px; height: 28px; }
    .cover.xs { width: 20px; height: 28px; }
    .cover.blank { border: 1px solid var(--border-subtle); }

    /* ── Needs you ─────────────────────────────────────────────────────── */

    .attn {
      margin: 0 14px 9px;
      border: 1px solid var(--color-danger);
      background: var(--bg-elevated);
      border-radius: 8px;
      padding: 10px 11px;
    }

    .attn-top { display: flex; align-items: center; gap: 8px; }
    .attn-title { font-size: 12px; font-weight: 600; }

    .attn-msg {
      font-size: 11px;
      color: var(--text-secondary);
      margin: 7px 0 9px;
      line-height: 1.45;
    }

    .attn-acts { display: flex; gap: 6px; }

    /* ── Lanes ─────────────────────────────────────────────────────────── */

    .lane {
      display: grid;
      grid-template-columns: 48px 1fr;
      gap: 10px;
      padding: 9px 14px 11px;
      border-left: 2px solid transparent;
    }

    .lane + .lane { border-top: 1px solid var(--border-subtle); }
    .lane.gpu { border-left-color: var(--accent); }
    .lane.gpu.warn { border-left-color: var(--warning-text); }
    .lane.gpu.hot { border-left-color: var(--color-danger); }
    .lane.free { border-left-color: var(--border-default); }

    .temp {
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      text-transform: none;
      color: var(--text-tertiary);
    }

    .temp.hot { color: var(--color-danger); font-weight: 700; }

    .why.hot-why {
      color: var(--color-danger);
      background: var(--warning-bg);
      margin-top: 7px;
    }

    .slot {
      font-size: 9px;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--text-muted);
      padding-top: 2px;
      line-height: 1.35;
    }

    .slot b {
      display: block;
      color: var(--text-tertiary);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .lane-body { min-width: 0; }
    .lane-top { display: flex; align-items: center; gap: 8px; }

    .act {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .act span { font-weight: 400; color: var(--text-secondary); }
    .act.warn-text { color: var(--warning-text); }

    .sub {
      font-size: 10.5px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .right {
      text-align: right;
      flex: none;
      font-variant-numeric: tabular-nums;
    }

    .pct { font-size: 13px; color: var(--accent); font-weight: 600; }
    .eta { font-size: 10px; color: var(--text-tertiary); }

    .bar {
      height: 5px;
      border-radius: 3px;
      background: var(--bg-input);
      overflow: hidden;
      margin-top: 8px;
    }

    .bar i {
      display: block;
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--accent-hover), var(--accent));
      transition: width 0.4s ease;
    }

    /* A step that has measured nothing gets no coloured bar — an empty track is
       "nothing reported", and a bar at zero is a claim it never made. */
    .bar.dim i { background: transparent; }

    .stage-line {
      display: grid;
      grid-template-columns: 92px 1fr 34px;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      font-size: 10px;
      color: var(--text-secondary);
    }

    .stage-line .bar.thin { height: 4px; margin-top: 0; }
    .s-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .s-val { text-align: right; font-variant-numeric: tabular-nums; }

    .detail {
      font-size: 10.5px;
      color: var(--text-tertiary);
      margin-top: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .detail.rate {
      color: var(--text-secondary);
      font-variant-numeric: tabular-nums;
    }

    .lane-acts { display: flex; gap: 6px; margin-top: 8px; }

    .free-text {
      font-size: 11.5px;
      color: var(--text-muted);
      padding-top: 7px;
      font-style: italic;
    }

    /* ── The reason a row is still ─────────────────────────────────────── */

    .why {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 10.5px;
      color: var(--text-tertiary);
      background: var(--bg-input);
      border-radius: 3px;
      padding: 2px 7px;
      margin-top: 5px;
      max-width: 100%;
    }

    .why.warn { color: var(--warning-text); background: var(--bg-elevated); }

    .why .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      flex: none;
    }

    /* ── Up next ───────────────────────────────────────────────────────── */

    .qrow {
      display: grid;
      grid-template-columns: 20px 1fr auto;
      align-items: center;
      gap: 9px;
      padding: 7px 14px;
    }

    .qrow + .qrow { border-top: 1px solid var(--border-subtle); }

    .qact {
      font-size: 12px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .qact em { font-style: normal; color: var(--text-tertiary); }

    .qright { display: flex; align-items: center; gap: 6px; }

    .tiny {
      font-size: 10.5px;
      padding: 3px 9px;
      border-radius: 5px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
    }

    .tiny:hover { color: var(--text-primary); border-color: var(--border-strong); }

    .tiny.go {
      border-color: transparent;
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: 600;
    }

    .tiny.bad {
      border-color: transparent;
      background: var(--bg-elevated);
      color: var(--color-danger);
      font-weight: 600;
    }

    /* ── Finished / foot ───────────────────────────────────────────────── */

    .empty {
      padding: 22px 14px;
      text-align: center;
      color: var(--text-tertiary);
      font-size: 12px;
      line-height: 1.5;
    }

    .done-row {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 14px;
      color: var(--text-tertiary);
      font-size: 11.5px;
      border-top: 1px solid var(--border-subtle);
    }

    .okd {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      flex: none;
    }

    .okd.bad { background: var(--color-danger); }
    .ok { color: var(--text-secondary); }
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
      .bar i { transition: none; }
    }
  `],
})
export class QueueTrayComponent {
  readonly tray = inject(QueueTrayService);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The panel wants to go away — Escape, or a control that navigates. */
  readonly dismiss = output<void>();

  /** How many slots are in use, for the band's own heading. */
  busyLanes(): number {
    return this.tray.lanes().filter(lane => lane.occupant !== null).length;
  }

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

  async start(stepId: string): Promise<void> {
    await this.tray.startStep(stepId);
  }

  async retry(stepId: string): Promise<void> {
    await this.tray.retryStep(stepId);
  }

  async remove(jobId: string): Promise<void> {
    await this.tray.removeRun(jobId);
  }

  openDetails(): void {
    this.dismiss.emit();
    void this.router.navigate(['/queue']);
  }
}
