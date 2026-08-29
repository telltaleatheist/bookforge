/**
 * The queue page — the same four bands the shelf draws, with room to breathe.
 *
 * ── What this replaces ──────────────────────────────────────────────────────
 *
 * A left list of rows beside a right panel that was empty half the time. The
 * list duplicated the shelf; the panel, with nothing selected, followed whatever
 * was RUNNING — which is how a narration's assembly step came to appear on
 * screen only once it had started. Worse, the two surfaces spoke different
 * dialects: the shelf spoke the engine's shape (a run, its steps, their
 * lineage), the page spoke the retired flat one (master rows, child rows,
 * `parentJobId`) translated on the fly.
 *
 * Both read `shared/queue/bench.ts` now, so there is one description of the
 * queue and one set of words for it.
 *
 * ── The bands ───────────────────────────────────────────────────────────────
 *
 *   Needs you    — failures, with the engine's own sentence and the controls
 *                  that resolve them. Not drawn when there are none.
 *   On the bench — the three slots, always all three. The GPU card is the
 *                  largest object on the page because the card is the resource
 *                  the user schedules their day around.
 *   Up next      — grouped by BOOK, each group drawing its chain with real
 *                  lineage, every still step saying why it is still.
 *   Finished     — today's work as history: what it produced and how long it
 *                  took, in a table, not as more rows that look live.
 *
 * ── Detail expands in place ─────────────────────────────────────────────────
 *
 * Clicking a step opens its full readout (stages, workers, measurements) under
 * the step itself, rendered by the same `app-job-step` the old panel used. The
 * legacy row it needs is looked up by step id through the mirror — that
 * projection is still the input JobEtaService measures against, and re-deriving
 * throughput here would be a second opinion about a number that must not have
 * two.
 */

import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { CdkDrag, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';

import { batchLabel } from '@shared/queue/bench';
import type { BookPlan, FinishedRun } from '@shared/queue/bench';
import { ToolbarComponent, ToolbarItem } from '../../creamsicle-desktop';
import { ElectronService } from '../../core/services/electron.service';
import { ToastService } from '../../core/services/toast.service';
import { JobDetailsComponent } from './components/job-details/job-details.component';
import { JobStepComponent } from './components/job-step/job-step.component';
import { stagesFor } from './models/job-stages';
import { JobEtaService } from './services/job-eta.service';
import { QueueService } from './services/queue.service';
import { QueueTrayService } from './services/queue-tray.service';
import type { BookPlanView } from './services/queue-tray.service';

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [
    DatePipe, DecimalPipe, ToolbarComponent, JobStepComponent, JobDetailsComponent,
    CdkDropList, CdkDrag, CdkDragHandle,
  ],
  template: `
    <desktop-toolbar [items]="toolbarItems()" (itemClicked)="onToolbarAction($event)" />

    <div class="page">

      <!-- ── Needs you ─────────────────────────────────────────────────── -->
      @if (tray.failures().length > 0) {
        <section class="band">
          <header class="band-head bad">
            <h2>Needs you · {{ tray.failures().length }}</h2>
          </header>

          @for (run of tray.failures(); track run.stepId) {
            <article class="card failed">
              <div class="card-head">
                @if (run.cover) {
                  <img class="cover" [src]="run.cover" alt="" />
                } @else {
                  <span class="cover blank" aria-hidden="true"></span>
                }
                <div class="min">
                  <h3>{{ run.title }} · {{ run.label }}</h3>
                  @if (run.finishedAt) {
                    <div class="sub">Failed {{ run.finishedAt | date:'shortTime' }}</div>
                  }
                </div>
                <div class="acts">
                  <button type="button" class="btn bad" (click)="retry(run.stepId)">Retry this step</button>
                  <button type="button" class="btn" (click)="remove(run.jobId)">Remove</button>
                </div>
              </div>
              <p class="error">{{ run.error }}</p>
            </article>
          }
        </section>
      }

      <!-- ── On the bench ──────────────────────────────────────────────── -->
      <section class="band">
        <header class="band-head">
          <h2>On the bench</h2>
          <span class="note">{{ busyLanes() }} of {{ tray.lanes().length }} slots in use</span>
        </header>

        <div class="lanes">
          @for (lane of tray.lanes(); track lane.resource + lane.index) {
            <article
              class="lcard"
              [class.gpu]="lane.resource === 'gpu'"
              [class.warn]="lane.hold"
              [class.hot]="lane.thermal?.throttleSustained"
              [class.idle]="!lane.occupant && !lane.hold"
            >
              <!-- The per-slot Stop, restored 2026-08-21.
                   It was left out on the reasoning that Pause already stopped
                   the run, so a second control would be the same act twice. It
                   is not the same act: Pause stops the ENGINE too, so nothing
                   starts after it, while this frees one slot and lets the queue
                   carry on. Without it, "take this book off the card and get on
                   with the next one" had no button anywhere, and Owen went
                   looking for one. The wording says which is which. -->
              <div class="lcard-slot">
                <span>{{ lane.resource === 'gpu' ? 'GPU' : 'CPU' }} · slot {{ lane.index }} of {{ lane.of }}</span>
                @if (lane.thermal; as thermal) {
                  <span class="temp" [class.hot]="thermal.throttleSustained">
                    {{ thermal.tempC }}°C
                    @if (thermal.fanPct !== undefined) { · fan {{ thermal.fanPct }}% }
                  </span>
                }
                @if (lane.occupant; as running) {
                  <button
                    type="button"
                    class="btn stop"
                    (click)="stopStep(running.stepId)"
                    title="Stop this step and free the slot. It keeps everything it has already rendered, and Start picks it up from there. The rest of the queue keeps running — use Pause queue in the toolbar to stop everything."
                  >■ Stop this step</button>
                }
              </div>

              <!-- The driver's own verdict, not a threshold this app invented.
                   Said above the work because it explains the number below it:
                   a throttled card is why a healthy run misses its band. -->
              @if (lane.thermal?.throttleSustained) {
                <div class="hot-note">
                  Running hot — the card is throttling itself, so this run is
                  slower than the machine can go. Check fans and airflow.
                </div>
              }

              @if (lane.occupant; as busy) {
                <div class="lcard-book">
                  @if (lane.cover) {
                    <img class="cover lg" [src]="lane.cover" alt="" />
                  } @else {
                    <span class="cover lg blank" aria-hidden="true"></span>
                  }
                  <div class="min grow">
                    <div class="act">{{ busy.verb }} <span>· {{ busy.label }}</span></div>
                    <div class="sub">{{ busy.title }}</div>
                  </div>
                  <!-- The percentage alone up here. The ETA moved down to the
                       measurements (Owen, 2026-08-22): it is a measurement, it
                       belongs with the others, and it reads better ending the
                       row than tucked under the headline number. -->
                  <div class="right">
                    @if (busy.percent !== null) {
                      <div class="pct">{{ busy.percent | number:'1.0-0' }}%</div>
                    }
                  </div>
                </div>

                <div class="bar" [class.dim]="busy.percent === null">
                  <i [style.width.%]="busy.percent ?? 0"></i>
                </div>

                <!-- The stage breakdown, because the headline number alone cannot
                     show life: an Orpheus batch reports no completions for
                     minutes while the stages under it are moving. -->
                @if (busy.stages.length > 0) {
                  <div class="stages">
                    @for (stage of busy.stages; track stage.name) {
                      <div class="stage-row" [class.on]="stage.status === 'running'">
                        <span class="s-name">{{ stage.label }}</span>
                        <span class="bar thin" [class.done]="stage.status === 'complete'">
                          <i [style.width.%]="stage.pct"></i>
                        </span>
                        <span class="s-val">
                          @if (stage.status === 'complete') { done }
                          @else if (stage.status === 'pending') { — }
                          @else { {{ stage.pct | number:'1.0-0' }}% }
                        </span>
                      </div>
                    }
                  </div>
                }

                @if (tray.detailFor(lane); as detail) {
                  <div class="detail">{{ detail }}</div>
                }

                <!-- Inside the MLX batch. The stage bar above it is HONESTLY at
                     0% — not one sentence file has landed — while most of the
                     batch's rows have finished, so without this the card says
                     nothing is happening for ten minutes at a time. -->
                @if (busy.activeBatch; as batch) {
                  <div class="batch-row">
                    @if (batch.fraction !== undefined) {
                      <span class="bar thin batch">
                        <i [style.width.%]="batch.fraction * 100"></i>
                      </span>
                    }
                    <span class="batch-text">{{ batchLabel(batch) }}</span>
                  </div>
                }

                <!-- The measurements. Rate is the number a long render is judged
                     by; absent until an honest window exists, never estimated.

                     Drawn whenever the slot is busy, rather than only when
                     something has been measured: the ETA cell below always says
                     something — a duration or "not timed yet" — and a row that
                     appeared partway through a run would move every other
                     number down the card at the moment the reader was watching
                     them. -->
                <div class="measures">
                    @if (lane.count) {
                      <!-- CHUNKS, not sentences. lane.count is
                           chunksCompletedInJob/totalChunksInJob, and a chunk packs
                           2-3 sentences — so this read ~3.6x lower than the book's
                           real sentence count and disagreed with the sent/min beside
                           it, which IS raw sentences (Owen, 2026-08-20). Same
                           distinction the analytics panel already draws. -->
                      <div class="ro"><div class="k">Chunks</div><div class="v">{{ lane.count }}</div></div>
                    }
                    @if (lane.speed) {
                      <div class="ro"><div class="k">Rate</div><div class="v">{{ lane.speed }}</div></div>
                    }
                    @if (lane.elapsed) {
                      <div class="ro"><div class="k">Elapsed</div><div class="v">{{ lane.elapsed }}</div></div>
                    }
                    <!-- Last, and pushed to the right edge so it lands under the
                         stage rows' "done" column. Elapsed and ETA end up beside
                         each other, which is the pairing a person actually reads:
                         how long this has taken, and how long is left. -->
                    <div class="ro eta-ro">
                      <div class="k">ETA</div>
                      <div class="v">{{ lane.eta ?? 'not timed yet' }}</div>
                    </div>
                </div>
              } @else if (lane.hold) {
                <div class="held-off">
                  <div class="act warn-text">Waiting for the card</div>
                  <p class="why-long">{{ lane.hold }}</p>
                </div>
              } @else {
                <div class="free">
                  <div class="free-head">Free</div>
                  <div class="free-sub">Nothing queued wants this slot</div>
                </div>
              }
            </article>
          }
        </div>
      </section>

      <!-- ── Up next ───────────────────────────────────────────────────── -->
      <!-- The band IS the drop list, header included — a wide target, and no
           wrapper between the section and its cards. Only THIS band: order is a
           statement about work not yet claimed, so the bench, Needs-you and
           Finished bands have nothing a drag could mean. -->
      @if (visiblePlans().length > 0) {
        <section
          class="band"
          cdkDropList
          [cdkDropListDisabled]="reordering() || visiblePlans().length < 2"
          (cdkDropListDropped)="onPlanDrop($event)"
        >
          <header class="band-head">
            <h2>Up next</h2>
            <span class="note">{{ plannedSteps() }} steps across {{ visiblePlans().length }} books</span>
          </header>

          @for (plan of visiblePlans(); track plan.key) {
            <article class="card" cdkDrag [cdkDragData]="plan">
              <div class="card-head">
                <!-- HANDLE, not the whole card. The card body carries Cancel,
                     Start this book and a step name per row that expands it;
                     making the card itself draggable would arm a drag under
                     every one of those presses. -->
                <button
                  type="button"
                  class="grip"
                  cdkDragHandle
                  aria-label="Drag to change this book's place in the queue"
                  title="Drag to change this book's place in the queue"
                >⠿</button>
                @if (plan.cover) {
                  <img class="cover" [src]="plan.cover" alt="" />
                } @else {
                  <span class="cover blank" aria-hidden="true"></span>
                }
                <div class="min">
                  <h3>{{ plan.title }}</h3>
                  <div class="sub">{{ planSummary(plan) }}</div>
                </div>
                <!-- ONE Cancel, whatever the book's shape. This looped over
                     plan.jobIds and drew a button per run, so a book whose
                     chain spans two runs showed two identical "Remove"s with
                     nothing to tell them apart — which is most of why the
                     controls here read as confusing. The act is the same for
                     every run in the plan, so it is said once and applied to
                     all of them (cancelPlan). -->
                <div class="acts">
                  @if (plan.allHeld) {
                    <button type="button" class="btn go" (click)="startPlan(plan)">▶ Start this book</button>
                  }
                  <button
                    type="button"
                    class="btn stop"
                    (click)="cancelPlan(plan)"
                    [title]="'Take this book out of the queue — ' + plan.steps.length
                      + ' step' + (plan.steps.length === 1 ? '' : 's') + '. Nothing already rendered is deleted.'"
                  >✕ Cancel this book</button>
                </div>
              </div>

              <div class="chain">
                @for (step of plan.steps; track step.stepId) {
                  <div class="cstep" [class.on]="step.status === 'running'">
                    <span class="spine" aria-hidden="true"></span>
                    <span
                      class="sdot"
                      [class.run]="step.status === 'running'"
                      [class.wait]="step.status === 'waiting' || step.status === 'queued'"
                      [class.held]="step.status === 'held'"
                      aria-hidden="true"
                    ></span>

                    <button type="button" class="cname" (click)="toggleStep(step.stepId)">
                      {{ step.label }}
                    </button>

                    <span class="cmid">
                      @if (step.reason; as reason) {
                        <span class="why" [class.warn]="reason.kind === 'admission'">
                          <span class="dot" aria-hidden="true"></span>{{ reason.sentence }}
                        </span>
                      } @else {
                        <span class="why on-bench">
                          <span class="dot" aria-hidden="true"></span>on the bench
                        </span>
                      }
                    </span>

                    <span class="cright">
                      @if (step.percent !== null) {
                        {{ step.percent | number:'1.0-0' }}%
                      } @else if (step.status !== 'running') {
                        not timed on this book
                      }
                      <!--
                        HOW LONG, beside HOW FAR. A percentage answers "how much
                        is done" and nothing else, and this row is where a person
                        looks to decide whether to wait — the lane card above
                        carries the ETA, but it shows only the step that happens
                        to hold a slot, and a book's chain is read here.

                        Running steps only: a waiting step's ETA would be a
                        prediction about a run that has not started and has
                        nothing measured about it.
                      -->
                      @if (step.status === 'running' && etaFor(step.stepId); as eta) {
                        <span class="ceta">{{ eta }}</span>
                      }
                      @if (step.startable) {
                        <button type="button" class="btn go xs" (click)="start(step.stepId)">
                          ▶ {{ step.reason?.kind === 'stopped' ? 'Resume' : 'Start' }}
                        </button>
                      }
                      <!-- Every step in the chain can be dropped on its own, and
                           the word changes with what dropping it MEANS: a running
                           step is stopped (and keeps what it rendered), a waiting
                           one is simply taken out. Same call either way — the
                           engine settles a cancelled step held. -->
                      @if (step.status === 'running') {
                        <button
                          type="button"
                          class="btn stop xs"
                          (click)="stopStep(step.stepId)"
                          title="Stop this step and free its slot. It keeps what it has rendered; Start resumes from there."
                        >■ Stop</button>
                      } @else {
                        <button
                          type="button"
                          class="btn stop xs"
                          (click)="cancelStep(step.stepId)"
                          title="Take this step out of the queue. Nothing already rendered is deleted."
                        >✕ Cancel</button>
                      }
                    </span>
                  </div>

                  @if (expanded().has(step.stepId)) {
                    @if (rowFor(step.stepId); as row) {
                      <div class="expand">
                        <div class="expand-cols">
                          <app-job-step [job]="row" [expanded]="true" />
                          <app-job-details [job]="row" (showInFolder)="showInFolder($event)" />
                        </div>
                      </div>
                    } @else {
                      <div class="expand">
                        <p class="sub">This step has not reported anything yet.</p>
                      </div>
                    }
                  }
                }
              </div>
            </article>
          }
        </section>
      }

      @if (visiblePlans().length === 0 && busyLanes() === 0 && tray.failures().length === 0) {
        <section class="band">
          <div class="empty">
            <h2>Nothing is queued</h2>
            <p>
              Narrate a book from its versions page, or order a read in the Foundry window.
              Work started anywhere in BookForge is scheduled here.
            </p>
          </div>
        </section>
      }

      <!-- ── Finished ──────────────────────────────────────────────────── -->
      @if (finished().length > 0) {
        <section class="band">
          <header class="band-head">
            <h2>Finished today · {{ finished().length }}</h2>
            <span class="note">
              {{ tray.finished().failed.length }} failed
              <button type="button" class="btn" (click)="clearFinished()">Clear finished</button>
            </span>
          </header>

          <table class="ftable">
            <thead>
              <tr>
                <th>Book</th><th>Act</th><th>Produced</th>
                <th class="num">Took</th><th class="num">Finished</th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (run of finished(); track run.stepId) {
                <tr>
                  <td class="b">{{ run.title }}</td>
                  <td>{{ run.label }}</td>
                  <td class="path">
                    @if (run.outputPath) {
                      <button type="button" class="link" (click)="showInFolder(run.outputPath!)">
                        {{ fileName(run.outputPath) }}
                      </button>
                    } @else {
                      —
                    }
                  </td>
                  <td class="num">{{ took(run) }}</td>
                  <td class="num">{{ run.finishedAt | date:'shortTime' }}</td>
                  <td>
                    <span class="pill" [class.ok]="run.status === 'done'" [class.bad]="run.status === 'failed'">
                      {{ run.status }}
                    </span>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      min-height: 0;
    }

    .page {
      flex: 1;
      overflow-y: auto;
      padding: 4px 20px 40px;
      background: var(--bg-base);
    }

    .min { min-width: 0; }
    .grow { flex: 1; }

    /* ── Bands ─────────────────────────────────────────────────────────── */

    .band { margin-top: 20px; }

    .band-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 10px;
    }

    .band-head h2 {
      margin: 0;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--text-tertiary);
    }

    .band-head.bad h2 { color: var(--color-danger); }

    .band-head .note {
      margin-left: auto;
      font-size: 0.6875rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 10px;
    }

    /* ── Cards ─────────────────────────────────────────────────────────── */

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .card.failed {
      border-color: var(--color-danger);
      background: var(--bg-elevated);
    }

    .card-head {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 11px 14px;
    }

    .card-head h3 {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .sub { font-size: 0.6875rem; color: var(--text-tertiary); }

    /* The book card's own sub-line only. The lane cards use .sub as well, and
       those were not the ones that were hard to read — scoping this under
       .card-head is what keeps the GPU/CPU slots exactly as they were. */
    .card-head .sub { font-size: 0.8125rem; }

    .acts { margin-left: auto; display: flex; gap: 6px; flex: none; }

    /* ── Reordering "Up next" ──────────────────────────────────────────────
       Styled after studio-list's list rows (the house precedent for CdkDrag):
       a handle that fades in on hover, a dimmed placeholder, a lifted preview.
       Sizes and colours are this page's tokens, not that component's. */

    .grip {
      flex: none;
      width: 18px;
      padding: 0;
      border: 0;
      background: none;
      font-size: 0.875rem;
      line-height: 1;
      color: var(--text-muted);
      cursor: grab;
      opacity: 0;
      transition: opacity 0.15s;
    }

    .card:hover .grip,
    .grip:focus-visible { opacity: 0.65; }

    .grip:active { cursor: grabbing; }

    /* A disabled drop list still draws its handles, and a handle that cannot be
       dragged must not say it can — one book, or a drop still settling. */
    .band.cdk-drop-list-disabled .grip { cursor: default; }

    .cdk-drag-preview .card-head { background: var(--bg-elevated); }

    .cdk-drag-preview {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      overflow: hidden;
    }

    .cdk-drag-placeholder { opacity: 0.28; }

    .cdk-drag-animating { transition: transform 200ms ease; }

    .cdk-drop-list-dragging .card:not(.cdk-drag-placeholder) {
      transition: transform 200ms ease;
    }

    .error {
      margin: 0;
      padding: 0 14px 12px;
      font-size: 0.75rem;
      color: var(--text-secondary);
      line-height: 1.5;
      white-space: pre-wrap;
    }

    /* ── Covers ────────────────────────────────────────────────────────── */

    .cover {
      width: 26px;
      height: 38px;
      border-radius: 4px;
      flex: none;
      object-fit: cover;
      background: var(--bg-input);
      display: block;
    }

    .cover.lg { width: 34px; height: 50px; }
    .cover.blank { border: 1px solid var(--border-subtle); }

    /* ── Buttons ───────────────────────────────────────────────────────── */

    .btn {
      font-family: inherit;
      font-size: 0.6875rem;
      padding: 4px 10px;
      border-radius: 5px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
    }

    .btn:hover { color: var(--text-primary); border-color: var(--border-strong); }

    .btn.go {
      border-color: transparent;
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: 600;
    }

    .btn.bad {
      border-color: transparent;
      background: var(--warning-bg);
      color: var(--color-danger);
      font-weight: 600;
    }

    .btn.xs { padding: 2px 8px; font-size: 0.625rem; }

    /* Stopping running work is destructive-looking but not destructive — the
       step comes back held with everything it rendered. So: outlined in the
       danger colour (findable at a glance on a busy card) rather than filled
       (which would read as "this throws the work away"). */
    .btn.stop {
      border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
      color: var(--color-danger);
      font-weight: 600;
    }

    .btn.stop:hover {
      border-color: var(--color-danger);
      background: var(--warning-bg);
      color: var(--color-danger);
    }

    /* ── Lanes ─────────────────────────────────────────────────────────── */

    .lanes {
      display: grid;
      grid-template-columns: 1.7fr 1fr 1fr;
      gap: 12px;
    }

    @media (max-width: 1000px) { .lanes { grid-template-columns: 1fr; } }

    .lcard {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-top: 2px solid var(--border-default);
      border-radius: 8px;
      padding: 11px 13px 13px;
      min-width: 0;
    }

    .lcard.gpu { border-top-color: var(--accent); }
    .lcard.warn { border-top-color: var(--warning); }
    /* A throttling card outranks the accent: heat is the fact of the moment. */
    .lcard.hot { border-top-color: var(--color-danger); }
    .lcard.idle { border-style: dashed; border-top-style: solid; }

    .temp {
      margin-left: auto;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      text-transform: none;
      font-size: 0.625rem;
      color: var(--text-tertiary);
    }

    .temp.hot { color: var(--color-danger); font-weight: 700; }

    .hot-note {
      font-size: 0.6875rem;
      line-height: 1.45;
      color: var(--color-danger);
      background: var(--warning-bg);
      border-radius: 5px;
      padding: 6px 9px;
      margin-bottom: 10px;
    }

    .lcard-slot {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 0.5625rem;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    /* The slot strip is set in small uppercase tracking; a button inside it is a
       button, not more of the strip's label. */
    .lcard-slot .btn {
      margin-left: auto;
      font-size: 0.6875rem;
      letter-spacing: 0;
      text-transform: none;
    }

    .lcard-book { display: flex; gap: 10px; align-items: flex-start; }

    .act {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .act span { font-weight: 400; color: var(--text-secondary); }
    .act.warn-text { color: var(--warning-text); }

    .right { text-align: right; flex: none; font-variant-numeric: tabular-nums; }
    .pct { font-size: 1.0625rem; font-weight: 600; color: var(--accent); }

    .bar {
      height: 5px;
      border-radius: 3px;
      background: var(--progress-track);
      overflow: hidden;
      margin-top: 10px;
    }

    .bar i {
      display: block;
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--accent-hover), var(--progress-fill));
      transition: width 0.4s ease;
    }

    .bar.dim i { background: transparent; }

    .stages { display: grid; gap: 5px; margin-top: 10px; }

    .stage-row {
      display: grid;
      /* Wide enough for the longest label this pipeline produces ("Assembling
         audiobook", "Converting sentences") — the LABEL is the information and
         the bar is decoration, so the bar shrinks, never the words. */
      grid-template-columns: 128px 1fr 42px;
      align-items: center;
      gap: 8px;
      font-size: 0.625rem;
      color: var(--progress-label);
    }

    .stage-row.on { color: var(--text-primary); }
    .stage-row .s-val { color: var(--progress-value); font-weight: 600; }

    .stage-row .bar.thin { height: 4px; margin-top: 0; }

    /* A finished stage still has to be READABLE. This was --text-muted, which
       in dark mode is $neutral-600 laid on a $neutral-800 track — the bar that
       says "this part is done" was the one bar you could not see (Owen,
       2026-08-21). Done now reads near-white: settled, not live, but present. */
    .stage-row .bar.done i { background: var(--progress-fill-done); }

    /* Quieter than the stage bars above it: this measures work that has not
       landed yet, and it must not out-shout the bar that measures work that
       has. Short track, the words carrying the detail.

       This is the MLX/Mac bar — on Windows an Orpheus batch reports per chunk
       and this never draws, so its dimness was only ever visible on Mac runs,
       and only there did it have to be legible. Quiet is now a lighter grey
       against a real track, not a fill the same value as the track. */
    .batch-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      font-size: 11px;
      color: var(--progress-label);
    }
    .batch-row .bar.thin.batch {
      height: 3px;
      margin-top: 0;
      flex: 0 0 120px;
    }
    .batch-row .bar.thin.batch i { background: var(--progress-fill-quiet); }
    .batch-text { white-space: nowrap; }

    .s-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .s-val { text-align: right; font-variant-numeric: tabular-nums; }

    .detail {
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      margin-top: 7px;
    }

    .measures {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 18px;
      margin-top: 10px;
      padding-top: 9px;
      border-top: 1px solid var(--border-subtle);
    }

    .measures .k {
      font-size: 0.5625rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .measures .v {
      font-size: 0.75rem;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    /* Pushed to the far right so it sits under the stage rows' value column —
       the "done" markers at the end of those bars — rather than trailing the
       other measures at whatever offset they happen to end at. An auto margin
       rather than a fixed width: the measures wrap, and a hard column would
       have to guess how many made it onto the last line. */
    .measures .eta-ro {
      margin-left: auto;
      text-align: right;
    }

    .held-off { padding: 4px 0 2px; }

    .why-long {
      margin: 6px 0 0;
      font-size: 0.6875rem;
      color: var(--warning-text);
      line-height: 1.45;
    }

    .free { padding: 12px 0 6px; text-align: center; }
    .free-head { font-size: 0.75rem; color: var(--text-tertiary); }
    .free-sub { font-size: 0.625rem; color: var(--text-muted); margin-top: 3px; }

    /* ── The chain ─────────────────────────────────────────────────────── */

    .chain { padding: 0 14px 10px; }

    /* THE QUEUE ITEM IS READ, NOT GLANCED AT — Owen, 2026-08-22: "its very,
       very tiny. and very spaced out."

       Two separate faults, and the spacing one was doing most of the damage.
       The name sat in a FIXED 160px column, so every step whose label was
       shorter than that — which is most of them — put a gap between the name
       and its status, and then a flexible column put a second, larger gap before
       the numbers. Three related facts about one step read as three unrelated
       columns.

       Now the name and its status are both content-sized and sit together, and
       the one flexible column is at the END, holding the numbers against the
       right edge where a ledger's numbers belong. The name still ellipsises: it
       is capped, so a long label cannot push the status off the row. */
    .cstep {
      display: grid;
      grid-template-columns: 16px minmax(0, 260px) minmax(0, max-content) 1fr;
      align-items: center;
      gap: 10px;
      padding: 7px 0;
      position: relative;
    }

    .spine {
      position: absolute;
      left: 7px;
      top: -4px;
      bottom: -4px;
      width: 2px;
      background: var(--border-default);
    }

    .cstep:first-child .spine { top: 50%; }
    .cstep:last-child .spine { bottom: 50%; }

    .sdot {
      width: 15px;
      height: 15px;
      border-radius: 50%;
      position: relative;
      z-index: 1;
      background: var(--bg-surface);
      box-sizing: border-box;
      display: grid;
      place-items: center;
    }

    .sdot.run { border: 2px solid var(--accent); }

    .sdot.run::after {
      content: '';
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: var(--accent);
      animation: q-pulse 1.4s ease-in-out infinite;
    }

    .sdot.wait { border: 2px dashed var(--text-muted); }
    .sdot.held { border: 2px dashed var(--text-tertiary); background: var(--bg-input); }

    @keyframes q-pulse {
      0%, 100% { opacity: 0.35; transform: scale(0.75); }
      50% { opacity: 1; transform: scale(1); }
    }

    .cname {
      font-family: inherit;
      font-size: 0.875rem;
      text-align: left;
      color: var(--text-secondary);
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .cname:hover { color: var(--accent); }
    .cstep.on .cname { color: var(--text-primary); font-weight: 600; }

    .cmid { min-width: 0; }

    .why {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.8125rem;
      color: var(--text-tertiary);
      background: var(--bg-input);
      border-radius: 3px;
      padding: 2px 8px;
      max-width: 100%;
      /* Its column is content-sized now, so a long admission sentence would
         otherwise push the numbers off the right edge. The column may shrink
         below the text; this is what makes that degrade quietly instead. */
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }

    .why.warn { color: var(--warning-text); background: var(--warning-bg); }
    .why.on-bench { color: var(--accent); background: var(--accent-subtle); }

    .why .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: currentColor;
      flex: none;
    }

    .cright {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 0.8125rem;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
      /* The one flexible column ends here, so the numbers hold the right edge. */
      justify-self: end;
    }

    /* Brighter than the percentage beside it, because it is the number a person
       is actually here for: "how much longer" is the question, and "how far" is
       the evidence for it. */
    .ceta {
      color: var(--text-secondary);
    }

    .expand {
      margin: 2px 0 8px 26px;
      border-left: 2px solid var(--border-default);
      padding: 8px 0 4px 14px;
    }

    /* The step's own bars beside the facts about it — the two halves the old
       right-hand panel showed one at a time behind a "Sub-tasks" toggle. */
    .expand-cols {
      display: grid;
      grid-template-columns: 1.4fr 1fr;
      gap: 18px;
      align-items: start;
    }

    @media (max-width: 900px) { .expand-cols { grid-template-columns: 1fr; } }

    /* ── Finished ──────────────────────────────────────────────────────── */

    .ftable {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.75rem;
    }

    .ftable th {
      text-align: left;
      font-size: 0.5625rem;
      font-weight: 400;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--text-muted);
      padding: 0 10px 6px 0;
      border-bottom: 1px solid var(--border-subtle);
    }

    .ftable td {
      padding: 7px 10px 7px 0;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
    }

    .ftable td.b { color: var(--text-primary); }
    .ftable td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .ftable th.num { text-align: right; }

    .link {
      font-family: inherit;
      font-size: inherit;
      background: transparent;
      border: none;
      padding: 0;
      color: var(--accent);
      cursor: pointer;
      text-align: left;
    }

    .pill {
      display: inline-block;
      font-size: 0.5625rem;
      padding: 1px 8px;
      border-radius: 9px;
      background: var(--bg-input);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }

    .pill.ok { background: var(--accent-subtle); color: var(--accent); }
    .pill.bad { background: var(--warning-bg); color: var(--color-danger); }

    /* ── Empty ─────────────────────────────────────────────────────────── */

    .empty {
      text-align: center;
      padding: 48px 20px;
      color: var(--text-tertiary);
    }

    .empty h2 {
      margin: 0 0 8px;
      font-size: 1.125rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .empty p { margin: 0 auto; max-width: 44ch; font-size: 0.8125rem; line-height: 1.55; }

    @media (prefers-reduced-motion: reduce) {
      .sdot.run::after { animation: none; opacity: 1; }
      .bar i { transition: none; }
    }
  `],
})
export class QueueComponent {
  readonly tray = inject(QueueTrayService);
  private readonly queueService = inject(QueueService);
  private readonly electronService = inject(ElectronService);
  private readonly eta = inject(JobEtaService);
  private readonly toasts = inject(ToastService);

  /** Steps whose full readout the user has opened. Closed is the default. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());

  readonly finished = computed(() => this.tray.finishedToday());

  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    // MOVEMENT, not the engine's latch, and not defined here: the tray draws
    // this same control and the two must not disagree. See
    // QueueTrayService.anythingRunning for the rule and why.
    const isRunning = this.tray.anythingRunning();
    const idle = !this.tray.anythingToDo();
    return [
      // "everything" earns its place now that each slot and each step carries
      // its own Stop: without it the toolbar button and the card button read as
      // two spellings of one act, which is the confusion the labels exist to
      // prevent. This one takes the whole queue down; those take one step off.
      isRunning
        ? {
          id: 'pause',
          type: 'button',
          icon: '⏸',
          label: 'Pause queue',
          tooltip: 'Stop the queue AND everything it is running. Anything stopped '
            + 'resumes from what it has already rendered. To stop just one step, '
            + 'use the Stop button on its slot.',
        }
        : {
          id: 'start',
          type: 'button',
          icon: '▶',
          label: 'Start',
          // Grayed rather than hidden: the control should stay where the eye
          // already looks for it, saying what it would do if there were
          // anything to do.
          disabled: idle,
          tooltip: idle
            ? 'Nothing is queued, so there is nothing to start.'
            : 'Claim work as slots free up, and resume anything that was stopped.',
        },
      {
        id: 'refresh',
        type: 'button',
        icon: '↻',
        label: 'Refresh',
        tooltip: 'Re-read the queue from the app’s main process.',
      },
      { id: 'sep1', type: 'divider' },
      { id: 'spacer', type: 'spacer' },
    ];
  });

  busyLanes(): number {
    return this.tray.lanes().filter(lane => lane.occupant !== null).length;
  }

  plannedSteps(): number {
    return this.visiblePlans().reduce((total, plan) => total + plan.steps.length, 0);
  }

  // ── Reordering "Up next" ─────────────────────────────────────────────────
  //
  // Owen, 2026-08-27: "give me the ability to drag/drop queue items to different
  // spots in the queue." Order is a real lever here and not decoration — the
  // engine claims work by walking `jobs[]` from the front (queue-engine.ts
  // `pump`), so a book moved up genuinely runs sooner.
  //
  // The mapping from "card dropped at index N" to the engine's run-level
  // `reorder` lives in QueueTrayService.reorderPlans, with the whole book's
  // runs. This half is the affordance and the beat between the drop and main's
  // answer.

  /**
   * The order the user just dropped, held only while its reorder calls are in
   * flight. Null the rest of the time, which is nearly always.
   */
  private readonly droppedPlans = signal<BookPlanView[] | null>(null);

  /** True while a drop is being applied. The band refuses a second drag then. */
  readonly reordering = computed(() => this.droppedPlans() !== null);

  /**
   * What the band draws.
   *
   * Normally the tray's plans, which are the engine's answer and the only order
   * worth believing. During a drop it is the array the user made, because one
   * dropped book is SEVERAL `reorder` calls — one per run in its chain — and
   * every one of them pushes a fresh snapshot. Drawing those would replay the
   * card walking to its new place a run at a time under a hand that has already
   * let go, and would animate from an array that is half-moved.
   */
  readonly visiblePlans = computed<BookPlanView[]>(() => {
    const dropped = this.droppedPlans();
    if (dropped !== null) return dropped;
    return this.tray.plans();
  });

  onPlanDrop(event: CdkDragDrop<unknown>): void {
    const { previousIndex, currentIndex } = event;
    if (previousIndex === currentIndex) return;
    const plans = this.tray.plans();
    const optimistic = [...plans];
    moveItemInArray(optimistic, previousIndex, currentIndex);
    this.droppedPlans.set(optimistic);
    this.report(this.applyPlanOrder(plans, previousIndex, currentIndex));
  }

  /**
   * Apply a drop, then take main's word for the result.
   *
   * The refusal is HELD rather than swallowed: it is rethrown for `report` to
   * put on screen, and it is caught here only so the re-read still happens. A
   * book whose second run refused to move has left the queue in a state only
   * main can describe, and that is precisely the moment the band must stop
   * drawing the move that was asked for and start drawing the one that happened.
   */
  private async applyPlanOrder(
    plans: BookPlan[], previousIndex: number, currentIndex: number,
  ): Promise<void> {
    let refusal: unknown = null;
    try {
      await this.tray.reorderPlans(plans, previousIndex, currentIndex);
    } catch (err) {
      refusal = err;
    }
    try {
      await this.queueService.refreshFromBackend();
    } finally {
      this.droppedPlans.set(null);
    }
    if (refusal !== null) throw refusal;
  }

  /**
   * "batch 83/94 sentences · 3.3k tokens". Shared with the queue page's step
   * rows (shared/queue/bench.ts) — one batch, one wording.
   */
  readonly batchLabel = batchLabel;

  /** "3 steps · 1 on the bench", or "2 steps · held". */
  planSummary(plan: BookPlan): string {
    const count = `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`;
    if (plan.allHeld) return `${count} · held, not started`;
    const running = plan.steps.filter(s => s.status === 'running').length;
    return running > 0 ? `${count} · ${running} on the bench` : `${count} · waiting`;
  }

  /**
   * The mirror's legacy row for a step, or null.
   *
   * Null is a real answer during the beat between a step being composed and the
   * first `queue:changed` carrying it, and the template says so rather than
   * rendering an empty readout that would look like a step reporting nothing.
   */
  rowFor(stepId: string) {
    return this.queueService.jobs().find(row => row.id === stepId) ?? null;
  }

  /**
   * "1h 12m left" for a running step, or null when nothing honest can be said.
   *
   * Goes through `JobEtaService` rather than doing arithmetic here, because that
   * service is where the ONE throughput sample per job lives: a second
   * measurement taken in this component would drift against the lane card's and
   * show two different answers for the same work on the same screen.
   *
   * `etaDisplay` never returns null — it says "Calculating…" or "Loading
   * models…" while a rate is still being established, which is the honest
   * answer and worth showing. Only the states it renders as `-` (not running,
   * or already complete) collapse to null and draw nothing.
   */
  etaFor(stepId: string): string | null {
    const row = this.rowFor(stepId);
    if (!row) return null;
    const display = this.eta.etaDisplay(row, stagesFor(row));
    if (display === '-') return null;
    // "Calculating…" and "Loading models…" are sentences about the measurement,
    // not durations. Only a duration takes "left" — "Calculating… left" reads as
    // a bug in the app rather than as a state of the work.
    return display.endsWith('…') || display === 'Complete' ? display : `${display} left`;
  }

  toggleStep(stepId: string): void {
    const next = new Set(this.expanded());
    if (next.has(stepId)) next.delete(stepId);
    else next.add(stepId);
    this.expanded.set(next);
  }

  /** How long a finished step took, from its own timestamps. */
  took(run: FinishedRun): string {
    if (!run.startedAt || !run.finishedAt) return '—';
    const seconds = (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const s = Math.floor(seconds);
    if (s < 60) return `${s}s`;
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m ${s % 60}s`;
  }

  fileName(filePath: string): string {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  }

  // ── Controls ─────────────────────────────────────────────────────────────
  //
  // Every one of these is a call into main, which can refuse — "that step has
  // already started", "there is no run by that id". A refusal is SAID, because a
  // button that appears to do nothing is the failure mode this whole redesign
  // exists to remove.

  private report(work: Promise<unknown>): void {
    void work.catch((err: unknown) => {
      this.toasts.problem(err instanceof Error ? err.message : String(err));
    });
  }

  onToolbarAction(item: ToolbarItem): void {
    switch (item.id) {
      // Pause stops the RUN, not just the claiming — see QueueTrayService.toggleQueue.
      case 'start': this.report(this.queueService.startQueue()); break;
      case 'pause': this.report(this.queueService.stopQueue()); break;
      case 'refresh': this.report(this.queueService.refreshFromBackend()); break;
    }
  }

  start(stepId: string): void {
    this.eta.forget(stepId);
    this.report(this.tray.startStep(stepId));
  }

  startPlan(plan: BookPlan): void {
    this.report(this.tray.startPlan(plan));
  }

  retry(stepId: string): void {
    this.report(this.tray.retryStep(stepId));
  }

  remove(jobId: string): void {
    this.report(this.tray.removeRun(jobId));
  }

  /** Stop the step on a slot, leaving the queue running. See tray.stopStep. */
  stopStep(stepId: string): void {
    this.report(this.tray.stopStep(stepId));
  }

  /**
   * Take one waiting step out. `removeRun` is the same call the failure cards
   * use: for a step inside a multi-step run it cancels just that step, and for a
   * run with nothing else in it it removes the run.
   */
  cancelStep(stepId: string): void {
    this.report(this.tray.removeRun(stepId));
  }

  /** Take every run in a book's plan out of the queue. */
  cancelPlan(plan: BookPlan): void {
    this.report(this.tray.cancelPlan(plan));
  }

  clearFinished(): void {
    this.report(this.tray.clearFinished());
  }

  showInFolder(filePath: string): void {
    this.report(this.electronService.showItemInFolder(filePath));
  }
}
