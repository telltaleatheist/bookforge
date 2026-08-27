import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import {
  batchLabel,
  benchLanes,
  bookPlans,
  finishedSince,
  needsYou,
  startOfDay,
  type BenchLane,
  type BookPlan,
  type FinishedRun,
} from '@shared/queue/bench';
import type { ActiveBatchProgress, GpuThermalReading, QueueSnapshot, QueueStep } from '@shared/queue/engine-types';
import { ApiService } from '../services/api.service';
import { IconComponent } from '../shared/icon.component';

/**
 * The queue, on a phone.
 *
 * ── Why it derives nothing ──────────────────────────────────────────────────
 *
 * The server hands over the engine's own snapshot and this page runs the SAME
 * pure functions the desktop queue page runs over it — `needsYou`,
 * `benchLanes`, `bookPlans`, `finishedSince` from shared/queue/bench.ts. That
 * is what "shows me what I see on the BookForge queue page" has to mean: one
 * queue described in one vocabulary. A second flattened shape computed here
 * would be a second opinion about a scheduler this side cannot see.
 *
 * The one thing this page must NOT copy from the desktop is the ETA. That is
 * JobEtaService — a stateful renderer-local rate sampler with its own clock —
 * and a phone polling every three seconds has no basis for it. Rate and chunks
 * come off the engine's own recorded stamps or they are not shown; nothing here
 * invents a time remaining.
 *
 * ── Clocks ──────────────────────────────────────────────────────────────────
 *
 * Every elapsed figure is measured against `now()`, which is the SERVING
 * machine's clock at the last poll, not this device's. The timestamps being
 * subtracted were stamped there.
 */
@Component({
  selector: 'app-queue-view',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="qhead">
      <div class="qtitle">
        <h2>Queue</h2>
        <span class="qsub">{{ summary() }}</span>
      </div>
      <!-- The label follows the engine's RUNNING LATCH, not "is anything
           running", because the latch is exactly what these two routes flip.
           Pausing does not stop a step that is already going — that is the Stop
           button on its slot — so the button never claims otherwise. -->
      @if (snapshot(); as snap) {
        @if (snap.running) {
          <button class="qtoggle" (click)="toggle('pause')" [disabled]="busy()"
                  title="Stop claiming new work. Anything already running keeps going — stop those one at a time.">
            <app-icon name="pause" [size]="16" /><span>Pause</span>
          </button>
        } @else {
          <button class="qtoggle start" (click)="toggle('start')" [disabled]="busy() || !anythingToDo()"
                  [title]="anythingToDo()
                    ? 'Release everything held and start claiming work as slots free up.'
                    : 'Nothing is queued, so there is nothing to start.'">
            <app-icon name="play" [size]="16" /><span>Start</span>
          </button>
        }
      }
    </div>

    <!-- A refusal does not time out. News the reader was not looking at must not
         be able to disappear unseen, and every one of these is the engine
         explaining why a press did nothing. -->
    @if (problem(); as msg) {
      <div class="qbanner bad" role="alert">
        <span>{{ msg }}</span>
        <button class="qx" (click)="problem.set(null)" aria-label="Dismiss">✕</button>
      </div>
    }
    @if (loadError(); as msg) {
      <div class="qbanner bad" role="alert">
        <span>{{ msg }}</span>
        <button class="qx" (click)="poll()" aria-label="Try again">⟳</button>
      </div>
    }

    @if (!snapshot() && !loadError()) {
      <div class="qempty"><span class="qglyph">📋</span><p>Reading the queue…</p></div>
    }

    @if (snapshot()) {
      <!-- Needs you: failures only. Not drawn when there are none — it is worth
           reading precisely because it is empty most of the time. -->
      @if (failures().length > 0) {
        <section class="band">
          <h3 class="bhead bad">Needs you · {{ failures().length }}</h3>
          @for (run of failures(); track run.stepId) {
            <div class="card fail">
              <div class="crow">
                <div class="cwho">
                  <div class="ctitle">{{ run.title }} · {{ run.label }}</div>
                  @if (run.finishedAt) { <div class="csub">Failed {{ clock(run.finishedAt) }}</div> }
                </div>
              </div>
              <p class="cerror">{{ run.error }}</p>
              <div class="acts">
                <button class="btn danger" (click)="retry(run.stepId)" [disabled]="busy()">Retry this step</button>
                <button class="btn" (click)="remove(run.jobId)" [disabled]="busy()">Remove</button>
              </div>
            </div>
          }
        </section>
      }

      <!-- On the bench: every slot, occupied or not. A free slot is information —
           it says nothing queued wants that resource, which is the difference
           between a queue that is stuck and one that has nothing to do. -->
      <section class="band">
        <h3 class="bhead">On the bench<span class="bnote">{{ busyLanes() }} of {{ lanes().length }} slots in use</span></h3>
        @for (lane of lanes(); track lane.resource + lane.index) {
          <div class="card lane" [class.idle]="!lane.occupant && !lane.hold"
               [class.warn]="!lane.occupant && !!lane.hold"
               [class.hot]="!!lane.thermal?.throttleActive">
            <div class="slot">
              <span class="slotname">{{ lane.resource === 'gpu' ? 'GPU' : 'CPU' }} · slot {{ lane.index }} of {{ lane.of }}</span>
              @if (lane.thermal; as reading) {
                <span class="therm">{{ thermWords(reading) }}</span>
              }
              @if (lane.occupant; as run) {
                <button class="btn xs" (click)="stop(run.stepId)" [disabled]="busy()">■ Stop</button>
              }
            </div>

            @if (lane.thermal?.throttleActive) {
              <p class="hotnote">Running hot — the card is throttling itself, so this run is slower than the machine can go.</p>
            }

            @if (lane.occupant; as run) {
              <div class="crow">
                <div class="cwho">
                  <div class="ctitle">{{ run.verb }} <span class="clabel">· {{ run.label }}</span></div>
                  <div class="csub">{{ run.title }}</div>
                </div>
                @if (run.percent !== null) { <div class="cpct">{{ round(run.percent) }}%</div> }
              </div>
              <div class="bar"><div class="fill" [class.dim]="run.percent === null" [style.width.%]="run.percent ?? 0"></div></div>

              @for (stage of run.stages; track stage.name) {
                <div class="stage">
                  <span class="sname">{{ stage.label }}</span>
                  <span class="sbar"><span class="sfill" [class.done]="stage.status === 'complete'" [style.width.%]="stage.pct"></span></span>
                  <span class="sval">{{ stageValue(stage.status, stage.pct) }}</span>
                </div>
              }

              @if (detailOf(run.detail, run.message); as detail) {
                <p class="cdetail">{{ detail }}</p>
              }
              @if (run.activeBatch; as batch) {
                <p class="cdetail">{{ batchWords(batch) }}</p>
              }

              <div class="measures">
                @if (chunksOf(run.stepId); as count) {
                  <span class="m"><b>Chunks</b>{{ count }}</span>
                }
                @if (rateOf(run.stepId); as rate) {
                  <span class="m"><b>Rate</b>{{ rate }}</span>
                }
                @if (elapsedOf(run.stepId); as spent) {
                  <span class="m"><b>Elapsed</b>{{ spent }}</span>
                }
              </div>
            } @else if (lane.hold; as hold) {
              <div class="freetext warn-text">Waiting for the card</div>
              <p class="cdetail">{{ hold }}</p>
            } @else {
              <div class="freetext">Free</div>
              <p class="cdetail">Nothing queued wants this slot.</p>
            }
          </div>
        }
      </section>

      <!-- Up next: one card per BOOK, because that is how the work was ordered —
           narrate, enhance and assemble on one book are one intention. -->
      @if (plansError(); as msg) {
        <section class="band"><h3 class="bhead bad">Up next</h3><p class="cerror">{{ msg }}</p></section>
      } @else if (plans().length > 0) {
        <section class="band">
          <h3 class="bhead">Up next<span class="bnote">{{ plannedSteps() }} steps across {{ plans().length }} books</span></h3>
          @for (plan of plans(); track plan.key) {
            <div class="card">
              <div class="crow">
                <div class="cwho">
                  <div class="ctitle">{{ plan.title }}</div>
                  <div class="csub">{{ planSummary(plan) }}</div>
                </div>
              </div>
              @for (step of plan.steps; track step.stepId) {
                <div class="cstep">
                  <div class="cline">
                    <span class="dot" [class.run]="step.status === 'running'" [class.held]="step.status === 'held'"></span>
                    <span class="sname">{{ step.label }}</span>
                    @if (step.percent !== null) { <span class="spct">{{ round(step.percent) }}%</span> }
                    @if (step.status === 'running') {
                      <button class="btn xs" (click)="stop(step.stepId)" [disabled]="busy()">■ Stop</button>
                    }
                  </div>
                  <!-- A running step's reason is null on purpose: its progress
                       belongs to the bench, and repeating it here would be the
                       same fact twice. -->
                  <div class="reason" [class.warnpill]="step.reason?.kind === 'admission'">
                    {{ step.reason ? step.reason.sentence : 'On the bench above.' }}
                  </div>
                </div>
              }
              <div class="acts">
                <button class="btn danger" (click)="cancelPlan(plan)" [disabled]="busy()"
                        [title]="cancelPlanTitle(plan)">✕ Cancel this book</button>
              </div>
            </div>
          }
        </section>
      }

      @if (plans().length === 0 && busyLanes() === 0 && failures().length === 0 && !plansError()) {
        <section class="band">
          <h3 class="bhead">Nothing is queued</h3>
          <p class="cdetail">Narrate a book from its versions page in BookForge. Work started anywhere in BookForge is scheduled here.</p>
        </section>
      }

      @if (finished().length > 0) {
        <section class="band">
          <h3 class="bhead">Finished today · {{ finished().length }}
            <button class="btn xs bnote-btn" (click)="clearFinished()" [disabled]="busy()">Clear finished</button>
          </h3>
          @for (run of finished(); track run.stepId) {
            <div class="frow">
              <div class="fwho">
                <div class="ftitle">{{ run.title }}</div>
                <div class="csub">{{ run.label }} · took {{ took(run) }}</div>
              </div>
              <div class="fright">
                <span class="ftime">{{ run.finishedAt ? clock(run.finishedAt) : '—' }}</span>
                <span class="pill" [class.ok]="run.status === 'done'" [class.bad]="run.status === 'failed'">{{ run.status }}</span>
              </div>
            </div>
          }
        </section>
      }
    }
  `,
  styles: [`
    :host { display: block; padding-bottom: 24px; }

    .qhead { display: flex; align-items: center; gap: 12px; padding: 2px 0 14px; }
    .qtitle { flex: 1; min-width: 0; }
    .qtitle h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
    .qsub { font-size: 12px; color: var(--text-tertiary); }
    .qtoggle { display: flex; align-items: center; gap: 6px; min-height: 38px; padding: 0 16px;
      border: 1px solid var(--border-subtle); border-radius: 19px; background: var(--bg-elevated);
      color: var(--text-primary); font-size: 14px; font-weight: 600; cursor: pointer; }
    .qtoggle.start { background: var(--accent); border-color: transparent; color: var(--text-on-accent); }
    .qtoggle:disabled { opacity: 0.4; }

    .qbanner { display: flex; align-items: center; gap: 10px; padding: 10px 12px; margin-bottom: 12px;
      border-radius: 10px; font-size: 13px; line-height: 1.4; }
    .qbanner.bad { background: color-mix(in srgb, var(--error) 16%, transparent); color: var(--text-primary);
      border: 1px solid color-mix(in srgb, var(--error) 45%, transparent); }
    .qbanner span { flex: 1; min-width: 0; }
    .qx { flex-shrink: 0; width: 30px; height: 30px; border: none; background: transparent;
      color: var(--text-secondary); font-size: 15px; cursor: pointer; }

    .qempty { text-align: center; padding: 48px 0; color: var(--text-tertiary); }
    .qglyph { font-size: 34px; }
    .qempty p { margin: 8px 0 0; font-size: 14px; }

    .band { margin-bottom: 22px; }
    .bhead { display: flex; align-items: center; gap: 8px; margin: 0 0 8px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase; color: var(--text-secondary); }
    .bhead.bad { color: var(--error); }
    .bnote { margin-left: auto; font-weight: 500; letter-spacing: 0; text-transform: none; font-size: 12px; color: var(--text-tertiary); }
    .bnote-btn { margin-left: auto; }

    .card { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; margin-bottom: 8px;
      background: var(--card-bg); border: 1px solid var(--border-subtle); border-radius: 12px; }
    .card.fail { border-color: color-mix(in srgb, var(--error) 55%, transparent); }
    .card.lane.idle { border-style: dashed; background: transparent; }
    .card.lane.warn { border-color: color-mix(in srgb, var(--warning) 55%, transparent); }
    .card.lane.hot { border-color: color-mix(in srgb, var(--error) 60%, transparent); }

    .slot { display: flex; align-items: center; gap: 8px; font-size: 10px; font-weight: 700;
      letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-tertiary); }
    .slot .btn { margin-left: auto; }
    .therm { letter-spacing: 0; text-transform: none; font-weight: 500; }
    .hotnote { margin: 0; font-size: 12px; line-height: 1.4; color: var(--error); }

    .crow { display: flex; align-items: flex-start; gap: 10px; }
    .cwho { flex: 1; min-width: 0; }
    .ctitle { font-size: 14px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .clabel { font-weight: 400; color: var(--text-secondary); }
    .csub { font-size: 12px; color: var(--text-tertiary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cpct { flex-shrink: 0; font-size: 20px; font-weight: 700; color: var(--accent); }
    .cerror { margin: 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary); white-space: pre-wrap; }
    .cdetail { margin: 0; font-size: 12px; line-height: 1.4; color: var(--text-tertiary); }

    .bar { height: 6px; border-radius: 3px; background: var(--bg-elevated); overflow: hidden; }
    .fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s ease; }
    .fill.dim { background: transparent; }

    .stage { display: grid; grid-template-columns: minmax(0, 1fr) 2fr 42px; align-items: center; gap: 8px; }
    .stage .sname { font-size: 11px; color: var(--text-tertiary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sbar { height: 3px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden; }
    .sfill { display: block; height: 100%; background: var(--text-secondary); }
    .sfill.done { background: var(--success); }
    .sval { font-size: 11px; text-align: right; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .measures { display: flex; flex-wrap: wrap; gap: 6px 16px; padding-top: 8px; border-top: 1px solid var(--border-subtle); }
    .m { font-size: 12px; color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .m b { display: block; font-size: 9px; font-weight: 700; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--text-tertiary); }

    .freetext { font-size: 14px; font-weight: 600; color: var(--text-tertiary); }
    .freetext.warn-text { color: var(--warning); }

    .cstep { padding: 5px 0; }
    .cline { display: flex; align-items: center; gap: 8px; }
    .cstep .dot { flex-shrink: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); }
    .cstep .dot.run { background: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
    .cstep .dot.held { background: transparent; border: 1.5px solid var(--text-tertiary); }
    .cstep .sname { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cstep .reason { padding-left: 16px; font-size: 11.5px; line-height: 1.35; color: var(--text-tertiary); }
    .cstep .reason.warnpill { color: var(--warning); }
    .cstep .spct { font-size: 12px; font-weight: 600; color: var(--text-secondary); font-variant-numeric: tabular-nums; }

    .acts { display: flex; flex-wrap: wrap; gap: 8px; }
    .btn { min-height: 36px; padding: 0 14px; border: 1px solid var(--border-subtle); border-radius: 18px;
      background: var(--bg-elevated); color: var(--text-primary); font-size: 13px; font-weight: 600; cursor: pointer; }
    .btn.xs { min-height: 30px; padding: 0 10px; font-size: 12px; }
    .btn.danger { background: var(--error); border-color: transparent; color: var(--text-on-accent); }
    .btn:disabled { opacity: 0.4; }

    .frow { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border-subtle); }
    .fwho { flex: 1; min-width: 0; }
    .ftitle { font-size: 13px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fright { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .ftime { font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .pill { padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; text-transform: uppercase;
      background: var(--bg-elevated); color: var(--text-secondary); }
    .pill.ok { background: var(--success); color: var(--text-on-accent); }
    .pill.bad { background: var(--error); color: var(--text-on-accent); }
  `],
})
export class QueueViewComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);

  /** The last snapshot read, and the SERVER clock that read it. */
  readonly snapshot = signal<QueueSnapshot | null>(null);
  private readonly serverNow = signal(0);
  /** Why the queue could not be read. Cleared by the next poll that succeeds. */
  readonly loadError = signal<string | null>(null);
  /** The engine's sentence when a control refused. Dismissed by hand, never on a timer. */
  readonly problem = signal<string | null>(null);
  /** True while a control is in flight — every button greys out, so a press
   *  cannot be sent twice while the queue is mid-gesture. */
  readonly busy = signal(false);

  private timer: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 3000);
  }

  ngOnDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    try {
      const { snapshot, now } = await this.api.getQueueSnapshot();
      // The clock first: every band is read against it, and a snapshot set
      // beside a stale `now` would date this poll's rows by the last one's.
      this.serverNow.set(now);
      this.snapshot.set(snapshot);
      this.loadError.set(null);
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : String(err));
    }
  }

  // ── The bands ───────────────────────────────────────────────────────────────

  readonly failures = computed(() => {
    const snap = this.snapshot();
    return snap === null ? [] : needsYou(snap);
  });

  readonly lanes = computed<BenchLane[]>(() => {
    const snap = this.snapshot();
    return snap === null ? [] : benchLanes(snap);
  });

  /**
   * `bookPlans` throws when a waiting step's parent has left the queue — the
   * scheduler cannot say when such a row will run, and neither can this page.
   * The sentence replaces the band rather than blanking the page around it.
   */
  private readonly planning = computed<{ plans: BookPlan[]; error: string | null }>(() => {
    const snap = this.snapshot();
    if (snap === null) return { plans: [], error: null };
    try {
      return { plans: bookPlans(snap), error: null };
    } catch (err) {
      return { plans: [], error: err instanceof Error ? err.message : String(err) };
    }
  });

  readonly plans = computed(() => this.planning().plans);
  readonly plansError = computed(() => this.planning().error);

  /**
   * Today is the day the SERVER's clock is in, read in this device's timezone —
   * the boundary the reader means by "today" is the one on the machine they are
   * holding, and the instant it is applied to is the one the queue was read at.
   */
  readonly finished = computed<FinishedRun[]>(() => {
    const snap = this.snapshot();
    return snap === null ? [] : finishedSince(snap, startOfDay(this.serverNow()));
  });

  readonly busyLanes = computed(() => this.lanes().filter((lane) => lane.occupant !== null).length);
  readonly plannedSteps = computed(() => this.plans().reduce((n, plan) => n + plan.steps.length, 0));

  /** Anything a Start could act on: released-and-waiting, or held. */
  readonly anythingToDo = computed(() => this.liveSteps().length > 0);

  private liveSteps(): QueueStep[] {
    const snap = this.snapshot();
    if (snap === null) return [];
    const live: QueueStep[] = [];
    for (const job of snap.jobs) {
      for (const step of job.steps) {
        if (step.status === 'queued' || step.status === 'waiting' || step.status === 'held') live.push(step);
      }
    }
    return live;
  }

  readonly summary = computed(() => {
    const snap = this.snapshot();
    if (snap === null) return '';
    const running = this.busyLanes();
    const waiting = this.liveSteps().length;
    if (running === 0 && waiting === 0) return 'Nothing is queued.';
    const parts: string[] = [];
    if (running > 0) parts.push(`${running} running`);
    if (waiting > 0) parts.push(`${waiting} waiting`);
    return `${parts.join(' · ')}${snap.running ? '' : ' · paused'}`;
  });

  // ── Actions ─────────────────────────────────────────────────────────────────

  async toggle(action: 'start' | 'pause'): Promise<void> {
    await this.act(() => this.api.sendQueueControl(action));
  }

  async stop(stepId: string): Promise<void> {
    await this.act(() => this.api.queueCancel({ stepId }));
  }

  async retry(stepId: string): Promise<void> {
    await this.act(() => this.api.queueRetry({ stepId }));
  }

  async remove(jobId: string): Promise<void> {
    await this.act(() => this.api.queueRemove(jobId));
  }

  async clearFinished(): Promise<void> {
    await this.act(() => this.api.queueClearFinished());
  }

  /**
   * Take a whole book out, run by run.
   *
   * Sequential and NOT swallowed per run: if the second removal refuses, the
   * first one really did happen, and a loop that reported success anyway would
   * leave half a book in the queue with the page claiming it is gone.
   */
  async cancelPlan(plan: BookPlan): Promise<void> {
    await this.act(async () => {
      for (const jobId of plan.jobIds) await this.api.queueRemove(jobId);
    });
  }

  private async act(gesture: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.problem.set(null);
    try {
      await gesture();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
    // Whatever happened, the queue is the authority on what happened.
    await this.poll();
  }

  // ── Words and numbers ───────────────────────────────────────────────────────

  round(n: number): number {
    return Math.round(n);
  }

  /** What the step last said about itself: its stage detail, else its message. */
  detailOf(detail: string | undefined, message: string | undefined): string {
    if (detail !== undefined && detail.trim() !== '') return detail;
    if (message !== undefined && message.trim() !== '') return message;
    return '';
  }

  /** Timed against the SERVER's clock, because `startedAt` was stamped there. */
  batchWords(batch: ActiveBatchProgress): string {
    return batchLabel(batch, this.serverNow());
  }

  /** "done" for a finished stage, an em dash for one that has not begun. */
  stageValue(status: 'pending' | 'running' | 'complete', pct: number): string {
    if (status === 'complete') return 'done';
    if (status === 'pending') return '—';
    return `${Math.round(pct)}%`;
  }

  thermWords(reading: GpuThermalReading): string {
    return reading.fanPct === undefined
      ? `${reading.tempC}°C`
      : `${reading.tempC}°C · fan ${reading.fanPct}%`;
  }

  planSummary(plan: BookPlan): string {
    const steps = `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`;
    const running = plan.steps.filter((s) => s.status === 'running').length;
    if (running > 0) return `${steps} · ${running} on the bench`;
    return plan.allHeld ? `${steps} · held, not started` : `${steps} · waiting`;
  }

  cancelPlanTitle(plan: BookPlan): string {
    const steps = `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`;
    return `Take this book out of the queue — ${steps}. Nothing already rendered is deleted.`;
  }

  /** "128 / 1,617" — CHUNKS, which pack two or three sentences each. */
  chunksOf(stepId: string): string {
    const step = this.stepById(stepId);
    if (step === null) return '';
    const { chunksCompletedInJob: done, totalChunksInJob: total } = step.metrics;
    if (done === undefined || total === undefined) return '';
    return `${done.toLocaleString()} / ${total.toLocaleString()}`;
  }

  /**
   * "12.4 chunks/min", measured over the window the ENGINE stamped: from the
   * first completion of this run to the last, containing the completions
   * between them.
   *
   * Measured from `startedAt` it would fold in the model load, and measured
   * from the first stamp without its count it would assume completions arrive
   * one at a time, which a batched engine makes false. Absent until the engine
   * has recorded all four numbers — a rate over a window of nothing is not a
   * slow rate, it is no rate.
   */
  rateOf(stepId: string): string {
    const step = this.stepById(stepId);
    if (step === null) return '';
    const { firstChunkCompletedAt, chunksAtFirstStamp, chunkCompletedAt, chunksCompletedInJob } = step.metrics;
    if (firstChunkCompletedAt === undefined || chunksAtFirstStamp === undefined) return '';
    if (chunkCompletedAt === undefined || chunksCompletedInJob === undefined) return '';
    const minutes = (chunkCompletedAt - firstChunkCompletedAt) / 60000;
    const chunks = chunksCompletedInJob - chunksAtFirstStamp;
    if (minutes <= 0 || chunks <= 0) return '';
    return `${(chunks / minutes).toFixed(1)} chunks/min`;
  }

  /** How long this step has been going, against the server's clock. */
  elapsedOf(stepId: string): string {
    const step = this.stepById(stepId);
    if (step === null || step.startedAt === undefined) return '';
    return this.spell((this.serverNow() - new Date(step.startedAt).getTime()) / 1000);
  }

  /** How long a finished run took, or an em dash when it was never timed. */
  took(run: FinishedRun): string {
    if (run.startedAt === undefined || run.finishedAt === undefined) return '—';
    const seconds = (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    return this.spell(seconds);
  }

  /** 45 → "45s", 750 → "12m 30s", 7500 → "2h 05m". */
  private spell(seconds: number): string {
    const whole = Math.round(seconds);
    if (whole < 60) return `${whole}s`;
    if (whole < 3600) return `${Math.floor(whole / 60)}m ${whole % 60}s`;
    return `${Math.floor(whole / 3600)}h ${String(Math.floor((whole % 3600) / 60)).padStart(2, '0')}m`;
  }

  clock(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  private stepById(stepId: string): QueueStep | null {
    const snap = this.snapshot();
    if (snap === null) return null;
    for (const job of snap.jobs) {
      const found = job.steps.find((step) => step.id === stepId);
      if (found !== undefined) return found;
    }
    return null;
  }
}
