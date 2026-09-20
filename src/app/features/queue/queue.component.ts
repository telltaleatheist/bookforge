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
 *   Pending      — staged books, nothing committed, waiting for Send to queue.
 *   Up next      — grouped by BOOK, each group drawing its chain with real
 *                  lineage, every still step saying why it is still.
 *   Finished     — today's work as history: what it produced and how long it
 *                  took, in a table, not as more rows that look live.
 *
 * ── Pending and Up next are ONE card in two states ──────────────────────────
 *
 * They were two loops drawing two nearly-identical cards, and they drifted:
 * different action sets, different pickers, different words for the same fact.
 * The body of both is now a single `#bookCard` template with a `staged` flag,
 * and each band supplies its own wrapper — Up next's because only IT is a drop
 * list and `cdkDrag` has to be a real child of the band that owns the drag.
 *
 * The card is two columns: the BOOK on the left (grip, cover, title, one-line
 * summary) and the DECISION on the right (which machine, then what to do about
 * it). Owen, 2026-09-19: *"we have like 6 red cancel buttons listed, and
 * they're all the way on the other side of the screen from the name of the
 * job/book."* The actions now sit a hand's width from the title, there is one
 * primary per card, and the destructive pair lives in a `⋯` menu whose entries
 * say what each one KEEPS. Red survives only inside that menu.
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

import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CdkDrag, CdkDragHandle, CdkDropList, moveItemInArray } from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';

import { benchRows, prepFraction, prepLabel } from '@shared/queue/bench';
import type { BookPlan, FinishedRun } from '@shared/queue/bench';
import type { ServerReach } from '@shared/queue/engine-types';
import { LOCAL_WORK_SET, LONGFORM_ALIGN_SET } from '@shared/queue/slot-sets';
import { DesktopSelectComponent, ToolbarComponent, ToolbarItem } from '../../creamsicle-desktop';
import type { DesktopSelectItems } from '../../creamsicle-desktop';
import { DialogService } from '../../creamsicle-desktop/services/dialog.service';
import { ElectronService } from '../../core/services/electron.service';
import { ToastService } from '../../core/services/toast.service';
import { JobDetailsComponent } from './components/job-details/job-details.component';
import { JobStepComponent } from './components/job-step/job-step.component';
import { stagesFor } from './models/job-stages';
import { JobEtaService } from './services/job-eta.service';
import { QueueService } from './services/queue.service';
import { QueueTrayService } from './services/queue-tray.service';
import type { BenchSectionView, BookPlanView, LaneView } from './services/queue-tray.service';

/**
 * WHAT RUNNING AND PAUSED MEAN — the words, once (2026-09-19).
 *
 * The state is drawn TWICE: on the Up next band header, where the rows it
 * governs are, and in the toolbar, which is on screen even when Up next is
 * empty. Two drawings of one fact is fine — two WORDINGS of it is not, and a
 * copied tooltip is exactly the kind of thing that gets edited in one place a
 * month from now. Both controls interpolate these strings and both press
 * `setQueueRunning`; neither keeps a latch of its own.
 *
 * The titles say what the STATE means, not what the button does, because the
 * one you are already in is still pressable (see `setQueueRunning`).
 */
const QUEUE_STATE_CONTROL = {
  running: {
    label: 'Running',
    title: 'Steps start as slots free up. Pressing it while already running '
      + 'picks up anything that was stopped.',
  },
  paused: {
    label: 'Paused',
    title: 'Books may still be added to the queue and reordered; nothing new '
      + 'starts until Running. Work already on a slot finishes.',
  },
} as const;

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [
    DatePipe, DecimalPipe, NgTemplateOutlet, FormsModule,
    ToolbarComponent, DesktopSelectComponent, JobStepComponent, JobDetailsComponent,
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

      <!-- ── On the bench ──────────────────────────────────────────────────
           GROUPED, not one flat grid (Owen, 2026-09-15: "they look kind of ugly
           clustered together randomly. and its hard to tell which slot im
           looking at unless i look closely at the names"). The sections and
           their order come from benchSections, which is pure and keeper-driven
           and never draws an empty heading; this draws them. The overall count
           stays, because "3 of 6 in use" is the sentence somebody reads first. -->
      <section class="band">
        <header class="band-head">
          <h2>On the bench</h2>
          <span class="note">{{ busyLanes() }} of {{ tray.lanes().length }} slots in use</span>
        </header>

        @for (section of tray.sections(); track section.group) {
        <div class="sect">
          <div class="sect-head">
            <h3>{{ section.heading }}</h3>
            <span class="sect-note">{{ section.note }}</span>
            <!--
              THE DIAL IS GONE FROM HERE, replaced by the per-slot switches
              above each card (Owen, 2026-09-15: *"instead of having a dropdown
              that chooses whether to have 'any' or the given crucible servers,
              lets have a big checkbox above each gpu slot"*).

              They are not the same control wearing different clothes and the
              swap is the point. The dial STEERED — one machine at a time, every
              book, and a book that named another waited. The switches say what
              each machine is FOR, independently, so two cards can be on and a
              third off; "any" stops being a setting and becomes what is left
              switched on. The per-book picker is untouched and still chooses
              between them (Owen: *"the dropdown can remain for queue items"*).
            -->
            <!-- OF THE ONES THAT ARE ON. Counting a switched-off card among
                 the slots you have would make "1 of 3 in use" read as two idle
                 machines when one of them is off on purpose. -->
            <span class="sect-count">{{ section.inUse }} of {{ liveLanes(section) }} in use</span>
          </div>

        <!--
          THE GRID, Owen 2026-09-15: one across, then two, then three, then
          2+2, 3+2, 3+3. 'benchRows' owns the arithmetic (and a keeper holds it
          to his numbers); this draws each row as its own grid of exactly that
          many columns, which is what makes the two lanes of a 3+2 second row
          take half the width each instead of sitting under the first two
          columns with a hole on the right.
        -->
        @for (row of rowsOf(section.lanes); track $index) {
        <div class="lane-row" [style.grid-template-columns]="'repeat(' + row.length + ', minmax(0, 1fr))'">
          @for (lane of row; track lane.setId + lane.resource + lane.index) {
          <div class="lane-cell">
            <!--
              THE SWITCH, ABOVE THE SLOT IT GOVERNS, and only above a slot it
              can govern. Owen: "each one should have an enable/disable checkbox
              above it with its name" — and of the CPU pair, "those belong to
              the local system... they obviously cant be disabled."
              'switchOf' answers with the SERVER NAME or null, so the local
              aligner's GPU row gets no switch either: there is no registered
              server behind it to switch off.

              It writes 'routing.disabled' through the same 'setEnabled' the
              Settings panel has always called. One fact, two doors — and the
              queue has honoured it all along ('decideWaitFor' holds a named
              server that is off, and 'any' never tries one).

              AND 'down' IS A SECOND WORD FOR A SECOND FACT, never for this one.
              The switch is what the operator decided this machine is for;
              'lane.down' is what the machine said when the scheduler last asked
              it (QueueSnapshot.servers, one reach cache, no second poll). A
              sleeping Mac used to draw a lane indistinguishable from a working
              one, with its books silently never starting. The checkbox stays
              live and nothing here writes 'routing.disabled' from it: switching
              a machine off because it is asleep would leave it off after it
              woke, and the operator never chose that. The reason is on the
              label's tooltip, one hover away, because the transport's sentence
              is too long to draw and too useful to drop.
            -->
            @if (switchOf(lane); as server) {
              <label
                class="lane-switch"
                [class.off]="lane.disabled"
                [class.down]="!lane.disabled && lane.down"
                [title]="lane.down || ''"
              >
                <input
                  type="checkbox"
                  [checked]="!lane.disabled"
                  [disabled]="switching() === server"
                  (change)="toggleServer(server, $any($event.target).checked)"
                />
                <span class="lane-switch-name">{{ server }}</span>
                @if (lane.disabled) {
                  <span class="lane-switch-word">off</span>
                } @else if (lane.down) {
                  <span class="lane-switch-word">down</span>
                }
              </label>
            } @else {
              <div class="lane-switch none">
                <span class="lane-switch-name">{{ lane.setLabel }}</span>
              </div>
            }
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
                <span>{{ lane.setLabel }} · {{ lane.resource === 'gpu' ? 'GPU' : 'CPU' }} · slot {{ lane.index }} of {{ lane.of }}</span>
                @if (lane.retiring) { <span class="retiring">finishing — no new work goes here</span> }
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

                <!-- Inside the PREPARING stage, before e2a exists. "Preparing
                     book" is honestly at 0% while the number-normalization pass
                     walks the whole book through a local model, which on a long
                     book is minutes of a card that otherwise says nothing. -->
                @if (busy.prep; as prep) {
                  <div class="batch-row">
                    @if (prepFraction(prep) !== undefined) {
                      <span class="bar thin batch">
                        <i [style.width.%]="prepFraction(prep)! * 100"></i>
                      </span>
                    }
                    <span class="batch-text">{{ prepLabel(prep) }}</span>
                  </div>
                }

                <!-- There is no second bar for the MLX batch any more (removed
                     2026-09-11). The batch's rows retire one at a time and the
                     bridge folds them into the chunk count, so the CHUNK bar is
                     what moves during the decode — the same thing the PC shows,
                     and one bar instead of two. The detail line above still says
                     what is being rendered together. -->

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
          </div>
          }
        </div>
        }
        </div>
        }
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
            <h2>Up next · {{ visiblePlans().length }}</h2>
            <span class="note left">{{ plannedSteps() }} steps across {{ visiblePlans().length }} books</span>

            <!--
              RUNNING OR PAUSED, said on the band it is about (Owen, 2026-09-19:
              *"the active queue should have a running or paused option where it
              accepts new entries or doesn't accept new entries — that's what the
              pause button should handle probably"*).

              PAUSED ACCEPTS ROWS. Send to queue still works and a book added
              while paused sits here until Resume; the engine has always behaved
              this way — the running latch gates its pump — so this is the WORD
              for a state that existed with nothing on screen saying which one
              we were in.

              HERE *AND* IN THE TOOLBAR, because this band is not always on
              screen. This header only exists while Up next has rows, so the
              one press Owen most wants — arming Paused BEFORE queueing sixteen
              books overnight — had nowhere to happen. The toolbar twin is
              always drawn (see toolbarItems); this one is beside the rows it
              governs, which is where you look once there are rows.

              Twins, not a fork: both read tray.isRunning(), both call
              setQueueRunning, and both take their words from
              QUEUE_STATE_CONTROL. There is still exactly one latch, and it is
              the engine's.

              The toolbar's old Pause/Resume pair is gone — it named the same
              latch in the language of ACTIONS rather than states, which is how
              a queue could be paused with nothing on screen saying so. Halt
              stays there as the destructive sibling — it stops running work.
            -->
            <div class="band-right">
              <div class="seg" role="group" aria-label="Queue state">
                <button
                  type="button"
                  class="seg-btn"
                  [class.on]="tray.isRunning()"
                  [attr.aria-pressed]="tray.isRunning()"
                  (click)="setQueueRunning(true)"
                  [title]="queueState.running.title"
                ><span class="seg-dot" aria-hidden="true"></span>{{ queueState.running.label }}</button>
                <button
                  type="button"
                  class="seg-btn paused"
                  [class.on]="!tray.isRunning()"
                  [attr.aria-pressed]="!tray.isRunning()"
                  (click)="setQueueRunning(false)"
                  [title]="queueState.paused.title"
                ><span class="seg-dot" aria-hidden="true"></span>{{ queueState.paused.label }}</button>
              </div>
            </div>
          </header>

          @for (plan of visiblePlans(); track plan.key) {
            <article class="card" cdkDrag [cdkDragData]="plan">
              <!-- HANDLE, not the whole card. The card body carries Stop this
                   book, an overflow menu and a step name per row that expands
                   it; making the card itself draggable would arm a drag under
                   every one of those presses.

                   It stays HERE rather than inside the shared body because
                   cdkDrag finds its handle by content query, and a handle
                   rendered from a template declared elsewhere is not in that
                   scope — the card would silently become draggable everywhere.
                   Absolutely placed, so both bands' titles line up whether or
                   not the card has a grip. -->
              <button
                type="button"
                class="grip"
                cdkDragHandle
                aria-label="Drag to change this book's place in the queue"
                title="Drag to change this book's place in the queue"
              >⠿</button>
              <ng-container
                [ngTemplateOutlet]="bookCard"
                [ngTemplateOutletContext]="{ $implicit: plan, staged: false }"
              />
            </article>
          }
        </section>
      }

      <!-- ── The book card, both bands ──────────────────────────────────────
           Declared once and rendered by Pending (staged: true) and Up next
           (staged: false). The WRAPPER stays with each band because only Up
           next is a drop list and cdkDrag must be its own child. -->
      <ng-template #bookCard let-plan let-staged="staged">
        <!-- TWO COLUMNS: the book on the left, the decision on the right.
             The old card was one flex row with the actions pushed right by an
             auto margin, so the name was flush left and its buttons flush right
             across the whole page — the complaint this card exists to fix. -->
        <div class="book-head">
          <div class="who">
            @if (plan.cover) {
              <img class="cover" [src]="plan.cover" alt="" />
            } @else {
              <span class="cover blank" aria-hidden="true"></span>
            }
            <div class="min">
              <div class="title-row">
                <h3>{{ plan.title }}</h3>
                @if (staged) { <span class="staged-tag">Staged</span> }
              </div>
              @if (staged) {
                <!-- THE CHAIN AS ONE LINE, and the rows folded away behind it.
                     A staged book's steps all say "Pending — not sent to the
                     queue yet", four times over, which is the band's own
                     heading repeated per row. The arrow line says the same
                     thing in the space of a sentence and still answers the
                     question the chain was there for: what will this run? -->
                <button
                  type="button"
                  class="sub chainline"
                  [attr.aria-expanded]="expandedPlans().has(plan.key)"
                  (click)="togglePlanChain(plan)"
                  title="The chain this book will run. Click to see it step by step."
                >{{ pendingSummary(plan) }}</button>
              } @else {
                <div class="sub">{{ planSummary(plan) }}</div>
              }
            </div>
          </div>

          <!--
            THE DECISION COLUMN: which machine, then what to do about it.

            WHICH SERVER THIS BOOK WAITS FOR (crucible docs/PHASE7-LANES.md
            §4.2.1). One field, on the book, because one book is one GPU: every
            step of it follows this answer. Read-only once the book has been
            ASSIGNED — a job finishes on the machine it started on (§4.3) — and
            then it is a CHIP in the same slot the picker occupied, so the eye
            finds the machine in one place whether the book is chosen or fixed.
          -->
          <div class="decide">
            @if (staged) {
              <div class="venue-row">
                <span class="venue-word">Run on</span>
                <desktop-select
                  class="pick"
                  size="sm"
                  placeholder="No server chosen"
                  ariaLabel="Which machine this book renders on"
                  [options]="stagedServerOptions()"
                  [ngModel]="waitForValue(plan)"
                  (ngModelChange)="chooseWaitFor(plan, $event)"
                />
              </div>
            } @else if (plan.travels) {
              @if (plan.waitForResolved.length > 0) {
                <div class="venue-row">
                  <span class="venue-word">Runs on</span>
                  <span class="runs-on" title="A book finishes on the machine it started on.">
                    <span class="dot" aria-hidden="true"></span>{{ plan.waitForResolved.join(' + ') }}
                  </span>
                </div>
              } @else {
                <div class="venue-row">
                  <span class="venue-word">Wait for</span>
                  <desktop-select
                    class="pick"
                    size="sm"
                    placeholder="No server chosen"
                    ariaLabel="Which machine this book renders on"
                    [options]="liveServerOptions()"
                    [ngModel]="waitForValue(plan)"
                    (ngModelChange)="chooseWaitFor(plan, $event)"
                  />
                </div>
              }
            }

            <!--
              ONE PRIMARY, and it is whatever this card's state makes obvious:
              send a staged book, stop a running one, start a held one, or move
              a waiting one up the list. Every one of them is a call that
              already existed; nothing new was taught to the engine here.

              THE DESTRUCTIVE PAIR IS IN THE MENU, and they are not the same
              act worded twice. Send back to Pending stops the book and keeps
              it — settings, renders, and its server a question again (Owen:
              "if i hit cancel book while its in queue, it drops back to
              pending"). Remove takes it out altogether. The labels say what
              each KEEPS, because that is the difference. A book that travels
              nowhere has no Pending band to fall back to, so it is offered
              Remove alone rather than an entry that refuses on press.
            -->
            <div class="acts">
              @if (staged) {
                <button
                  type="button"
                  class="btn go grow"
                  (click)="sendPlan(plan)"
                  [title]="tray.isRunning()
                    ? 'Put this book in the live queue. It starts when a machine it will accept is free.'
                    : 'Put this book in the live queue. The queue is paused, so it waits there until you set it Running.'"
                >▶ Send to queue</button>
                <button
                  type="button"
                  class="btn quiet"
                  (click)="cancelPlan(plan)"
                  title="Discard this staged book. Nothing has been rendered for it."
                >Discard</button>
              } @else {
                @if (runningSteps(plan) > 0) {
                  <button
                    type="button"
                    class="btn grow"
                    (click)="stopBook(plan)"
                    title="Stop what this book is running and free its slots. It keeps everything it has rendered; Start picks it up from there. The rest of the queue carries on."
                  >■ Stop this book</button>
                } @else if (plan.allHeld) {
                  <button
                    type="button"
                    class="btn go grow"
                    (click)="startPlan(plan)"
                    title="Release this book's steps. They claim a slot as one frees up."
                  >▶ Start this book</button>
                } @else {
                  <button
                    type="button"
                    class="btn grow"
                    [disabled]="!canMoveToTop(plan)"
                    (click)="moveToTop(plan)"
                    [title]="canMoveToTop(plan)
                      ? 'Put this book at the front of Up next — the engine claims work from the top.'
                      : 'This book is already at the front of the queue.'"
                  >Move to top</button>
                }

                <div class="more-wrap">
                  <button
                    type="button"
                    class="more"
                    aria-haspopup="menu"
                    [attr.aria-expanded]="menuFor() === plan.key"
                    [attr.aria-label]="'More actions for ' + plan.title"
                    (click)="toggleMenu(plan, $event)"
                  >⋯</button>
                  @if (menuFor() === plan.key) {
                    <div class="menu" role="menu">
                      @if (plan.travels) {
                        <button type="button" class="menu-item" role="menuitem" (click)="menuReturnToPending(plan)">
                          <span class="k">Send back to Pending</span>
                          <span class="d">
                            Stops it, keeps its settings and what it rendered; its
                            server becomes a question again.
                          </span>
                        </button>
                      }
                      <button type="button" class="menu-item danger" role="menuitem" (click)="menuRemove(plan)">
                        <span class="k">Remove from queue</span>
                        <span class="d">
                          Takes all {{ plan.steps.length }} step{{ plan.steps.length === 1 ? '' : 's' }}
                          out; nothing already rendered is deleted.
                        </span>
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          </div>
        </div>

        @if (!staged || expandedPlans().has(plan.key)) {
          <div class="chain">
            @for (step of plan.steps; track step.stepId) {
              @if (staged) {
                <!-- Names only. Nothing staged has a queue position, a slot, or
                     a reason to be still beyond "not sent yet" — and the one it
                     does have is on the line above, once. -->
                <div class="cstep staged-step">
                  <span class="spine" aria-hidden="true"></span>
                  <span class="sdot held" aria-hidden="true"></span>
                  <span class="cname plain">{{ step.label }}</span>
                  <span class="cright"></span>
                </div>
              } @else {
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
                    <!--
                      THE PER-STEP CONTROLS APPEAR ON HOVER OR FOCUS. A book of
                      four steps drew four red buttons in a stripe at the right
                      edge, none of them near the thing they act on, and none of
                      them the thing a reader came to this row for — which is
                      the name, the reason and the percentage.

                      Faded, not display:none, so the keyboard can still reach
                      them: a button removed from the flow cannot be tabbed to,
                      and :focus-within is what brings it back. Always drawn on
                      a coarse pointer, which has no hover to give.
                    -->
                    <span class="ctl">
                      @if (step.startable) {
                        <button type="button" class="btn go xs" (click)="start(step.stepId)">
                          ▶ {{ step.reason?.kind === 'stopped' ? 'Resume' : 'Start' }}
                        </button>
                      }
                      <!-- Every step in the chain can be dropped on its own, and
                           the word changes with what dropping it MEANS: a running
                           step is stopped (and keeps what it rendered), a waiting
                           one is skipped — taken out of the queue. Same call
                           either way — the engine settles a cancelled step held. -->
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
                          class="btn quiet xs"
                          (click)="cancelStep(step.stepId)"
                          title="Take this step out of the queue. Nothing already rendered is deleted."
                        >✕ Skip</button>
                      }
                    </span>
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
            }
          </div>
        }
      </ng-template>

      <!-- ── Pending ───────────────────────────────────────────────────────
           Adding a book stages it here: nothing about it is committed, its
           server is chosen while that is still free, and Send to queue is the
           press that commits it (docs/PENDING-QUEUE-AND-GPU-DIAL.md §1-§3).

           BELOW Up next, not above it (Owen, 2026-09-19: *"put pending at the
           bottom and active items/up next above it"*). The live queue is what a
           person watches; a staged book is parked until they come back for it,
           so it reads last. -->
      @if (tray.pending().length > 0) {
        <section class="band">
          <header class="band-head">
            <h2>Pending · {{ tray.pending().length }}</h2>
            <span class="note left">
              Staged, not queued — choose a machine, then send
            </span>
          </header>

          @for (plan of tray.pending(); track plan.key) {
            <!-- The SAME body Up next draws, in its staged state: dashed, tagged,
                 no grip (nothing here has a queue position to drag). -->
            <article class="card staged">
              <ng-container
                [ngTemplateOutlet]="bookCard"
                [ngTemplateOutletContext]="{ $implicit: plan, staged: true }"
              />
            </article>
          }
        </section>
      }

      @if (visiblePlans().length === 0 && busyLanes() === 0 && tray.failures().length === 0
           && tray.pending().length === 0) {
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
            <span class="note left">{{ tray.finished().failed.length }} failed</span>
            <!-- A BUTTON AT THE BAND'S EDGE, not a button inside the sentence
                 beside it. It lived in the "N failed" note span, where it read
                 as part of a status line rather than as the one act this band
                 offers. -->
            <div class="band-right">
              <button
                type="button"
                class="btn"
                (click)="clearFinished()"
                title="Clear today's history. Nothing on disk is touched."
              >Clear finished</button>
            </div>
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

    /* CENTRED, not baseline: the band head now carries controls — the
       Running/Paused switch and Clear finished — and a button's baseline is
       nowhere near its heading's. */
    .band-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
      min-height: 26px;
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

    /* A note that BELONGS TO THE HEADING rather than holding the right edge.
       The bench's "3 of 6 slots in use" is a readout and stays right; Pending,
       Up next and Finished read as "<band> · <count> — <what that means>", and
       their right edge is where the band's control goes. */
    .band-head .note.left { margin-left: 0; }

    .band-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ── Running / Paused ──────────────────────────────────────────────────
       Two states of ONE fact (the engine's running latch), drawn as one
       control so it cannot look like two independent buttons. Colour carries
       the meaning: green is moving, amber is holding — never red, because
       pausing throws nothing away. */
    .seg {
      display: inline-flex;
      border: 1px solid var(--border-default);
      border-radius: 7px;
      overflow: hidden;
      background: var(--bg-surface);
    }

    .seg-btn {
      font-family: inherit;
      font-size: 0.6875rem;
      font-weight: 600;
      padding: 4px 11px;
      border: 0;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }

    .seg-btn + .seg-btn { border-left: 1px solid var(--border-default); }
    .seg-btn:hover { color: var(--text-primary); }
    .seg-btn.on { background: var(--accent-subtle); color: var(--accent); }
    .seg-btn.paused.on { background: var(--warning-bg); color: var(--warning-text); }

    .seg-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex: none;
      opacity: 0.35;
    }

    .seg-btn.on .seg-dot { opacity: 1; }

    /* ── Cards ─────────────────────────────────────────────────────────── */

    /* NOT overflow:hidden any more: the overflow menu hangs below its
       button and clipping it to the card would hide the one control the card
       face no longer carries. Relative because the drag grip is placed against
       this edge. */
    .card {
      position: relative;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      margin-bottom: 10px;
    }

    .card.failed {
      border-color: var(--color-danger);
      background: var(--bg-elevated);
    }

    /* The Needs-you card, which is one line of facts and two buttons and wants
       none of the two-column machinery below. */
    .card-head {
      display: flex;
      align-items: center;
      gap: 11px;
      padding: 11px 14px;
    }

    .card-head h3,
    .book-head h3 {
      margin: 0;
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .sub { font-size: 0.6875rem; color: var(--text-tertiary); }

    /* The book card's own sub-line only. The lane cards use .sub as well, and
       those were not the ones that were hard to read — scoping this keeps the
       GPU/CPU slots exactly as they were. */
    .card-head .sub,
    .book-head .sub { font-size: 0.8125rem; }

    .acts { margin-left: auto; display: flex; gap: 6px; flex: none; align-items: center; }

    /* ── The book card: two columns ────────────────────────────────────────
       Left is fluid and holds the book; right is a fixed decision column —
       which machine, then what to do about it. The width is fixed so every
       card's actions land in the same place down the page, and minmax(0,1fr)
       so a long title ellipsises instead of pushing the column off-screen. */
    .book-head {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      gap: 14px;
      align-items: start;
      padding: 11px 14px 10px 30px;
    }

    .who { display: flex; align-items: center; gap: 11px; min-width: 0; }

    /* The tag is NOT inside the h3: the title ellipsises, and a tag inside it
       would be the first thing a long title ate. */
    .title-row { display: flex; align-items: center; min-width: 0; }

    .staged-tag {
      flex: none;
      margin-left: 8px;
      font-size: 0.5625rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-tertiary);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      padding: 1px 6px;
    }

    /* The staged summary is a DISCLOSURE, not a label: it says what the chain
       is and opens the chain. Styled as the text it replaced. */
    .chainline {
      font-family: inherit;
      display: block;
      text-align: left;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chainline:hover { color: var(--text-secondary); }

    .decide { display: grid; gap: 7px; min-width: 0; }

    /* Which machine the book waits for. Quiet: it is a standing answer, not an
       action, and it must not compete with the button under it. */
    .venue-row { display: flex; align-items: center; gap: 8px; }

    .venue-word {
      flex: none;
      width: 52px;
      font-size: 0.625rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: .05em;
    }

    .pick { flex: 1; min-width: 0; }

    /* THE SAME SLOT THE PICKER OCCUPIED, once the answer is settled: a book
       finishes on the machine it started on, so this is a fact, not a control
       that would refuse on press. */
    .runs-on {
      flex: 1;
      min-width: 0;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 0.75rem;
      font-weight: 600;
      padding: 4px 9px;
      border-radius: 6px;
      background: var(--accent-subtle);
      color: var(--accent);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .runs-on .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex: none;
    }

    .btn.grow { flex: 1; text-align: center; }

    /* ── The overflow menu ─────────────────────────────────────────────────
       The two destructive acts, out of the card face. Red lives HERE and
       nowhere else on the card: on the face it read as six alarms per book,
       none of them near what they act on. */
    .more-wrap { position: relative; flex: none; }

    .more {
      font-family: inherit;
      width: 28px;
      height: 26px;
      border-radius: 5px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.875rem;
      line-height: 1;
    }

    .more:hover { color: var(--text-primary); border-color: var(--border-strong); }

    .menu {
      position: absolute;
      right: 0;
      top: calc(100% + 5px);
      z-index: 30;
      min-width: 262px;
      padding: 5px;
      display: grid;
      gap: 2px;
      text-align: left;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    }

    .menu-item {
      font-family: inherit;
      display: block;
      width: 100%;
      text-align: left;
      padding: 7px 9px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      cursor: pointer;
    }

    .menu-item:hover { background: var(--hover-bg); }

    .menu-item .k {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .menu-item .d {
      display: block;
      margin-top: 2px;
      font-size: 0.6875rem;
      line-height: 1.4;
      color: var(--text-tertiary);
      white-space: normal;
    }

    .menu-item.danger .k { color: var(--color-danger); }

    /* The card holding an open menu comes forward. Cards are stacked in
       document order, so without this the NEXT book's card paints over the
       menu of the one above it. */
    .card:has(.menu) { z-index: 5; }

    /* NARROW: the decision column stops being a column. Three buttons and a
       picker beside a title is a wrap waiting to happen; stacked, it is a
       block under the book it is about. */
    @media (max-width: 760px) {
      .book-head { grid-template-columns: minmax(0, 1fr); }
      .venue-word { width: auto; }
    }

    /* ── The bench's sections ──────────────────────────────────────────────
       Owen, 2026-09-15: the slots "look kind of ugly clustered together
       randomly. and its hard to tell which slot im looking at unless i look
       closely at the names." The heading carries the name of the group and a
       line saying what is in it, so the answer is above the cards rather than
       inside them. */

    .sect + .sect { margin-top: 16px; }

    .sect-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }

    .sect-head h3 {
      margin: 0;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .sect-note { font-size: 0.6875rem; color: var(--text-muted); }

    .sect-count {
      margin-left: auto;
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    /* ONE LANE NOW DOES STRETCH, reversing the cap that used to be here.
       It read: "a section with one lane must not stretch it across the whole
       page... alone it would be six times the width of the words in it", and
       capped it at 420px. Owen, 2026-09-15, ruled the other way: *"if theres one
       gpu available, the gpu slot stretches across the whole screen, left to
       right."* His is the later call on his own bench, and the card has more in
       it now than it did — a switch, a name, a thermal reading and an ETA. */

    /* ── Pending ───────────────────────────────────────────────────────────
       Dashed, because nothing about a staged book is committed: it is a plan on
       the bench, not work in the queue. Otherwise the SAME card as Up next, so
       the press between them is the only difference a reader has to hold. */

    .card.staged {
      border-style: dashed;
      border-color: var(--border-default);
    }

    .cstep.staged-step { grid-template-columns: 16px minmax(0, 260px) 1fr; }

    .cname.plain { color: var(--text-tertiary); cursor: default; }

    /* ── Reordering "Up next" ──────────────────────────────────────────────
       Styled after studio-list's list rows (the house precedent for CdkDrag):
       a handle that fades in on hover, a dimmed placeholder, a lifted preview.
       Sizes and colours are this page's tokens, not that component's.

       PLACED AGAINST THE CARD'S EDGE rather than in the row, so that the
       staged card — which has no grip — still lines its title up with the live
       one. Both cards reserve the same 30px of left padding. */

    .grip {
      position: absolute;
      left: 6px;
      top: 15px;
      z-index: 2;
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

    .cdk-drag-preview .book-head { background: var(--bg-elevated); }

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

    .btn:disabled {
      opacity: 0.45;
      cursor: default;
    }

    .btn:disabled:hover { color: var(--text-secondary); border-color: var(--border-default); }

    /* The SECOND act on a card, and a second act must not look like the first.
       Borderless: it is available, not offered. Skip and Discard wear it —
       both were red, and neither throws anything away. */
    .btn.quiet {
      border-color: transparent;
      background: transparent;
      color: var(--text-tertiary);
    }

    .btn.quiet:hover {
      color: var(--text-primary);
      border-color: var(--border-default);
    }

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

    /* ── The grid ──────────────────────────────────────────────────────────
       One ROW at a time, each its own grid of exactly the columns that row
       holds — the count comes from 'benchRows' and is written inline on the
       element. Columns are equal ('1fr' each, 'minmax(0, …)' so a long book
       title cannot push its lane wider than its share), because Owen's rule is
       about halves and thirds of the width: *"if there are two, the two are
       split so the left half is taken up by slot 1 and the right half by slot
       2."* The old three-column '1.7fr 1fr 1fr' is gone with the flat list it
       belonged to. */
    .lane-row {
      display: grid;
      gap: 12px;
      margin-bottom: 12px;
    }
    .lane-row:last-child { margin-bottom: 0; }

    .lane-cell { display: flex; flex-direction: column; min-width: 0; }

    /* NARROW: one lane per row, whatever the arithmetic said. The inline
       'grid-template-columns' is overridden here on purpose — three cards side
       by side under 1000px is three unreadable cards. */
    @media (max-width: 1000px) {
      .lane-row { grid-template-columns: minmax(0, 1fr) !important; }
    }

    /* ── The switch above each slot ────────────────────────────────────────
       Owen: *"each one should have an enable/disable checkbox above it with its
       name."* Big enough to hit without aiming — it is the control that decides
       whether a machine works at all. */
    .lane-switch {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      margin-bottom: 6px;
      border-radius: 6px;
      cursor: pointer;
      user-select: none;
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
    }
    .lane-switch input { width: 18px; height: 18px; cursor: pointer; accent-color: var(--accent); }
    .lane-switch input:disabled { cursor: progress; }
    .lane-switch-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lane-switch-word {
      margin-left: auto;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--text-secondary);
    }
    .lane-switch.off { opacity: 0.75; }
    /* NOT ANSWERING. Greyed like the off state because the lane is equally not
       going to run anything — but the word is different, and so is the cure:
       off is undone with the box beside it, down by waking the machine. */
    .lane-switch.down { opacity: 0.75; }
    .lane-switch.down .lane-switch-word { color: var(--warning-text); }
    /* The CPU pair and the local aligner: a name, no box, and NOT a disabled
       checkbox — an unclickable control invites the question of how to click
       it. Padded to the same height so the cards below stay on one line. */
    .lane-switch.none { cursor: default; background: transparent; border-color: transparent; }

    /* SWITCHED OFF: greyed, still legible, still there. Owen: *"if a crucible
       slot is unchecked, it grays it out until it's re-checked/re-enabled."* */
    .lane-cell:has(.lane-switch.off) .lcard,
    .lane-cell:has(.lane-switch.down) .lcard {
      opacity: 0.45;
      filter: grayscale(1);
    }

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

       The MLX batch bar was the other user of this row until 2026-09-11, when
       the batch's retired rows moved into the chunk bar itself; the prep pass
       keeps it. Quiet is a lighter grey against a real track, not a fill the
       same value as the track — it was invisible in dark mode as the latter. */
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
      border-radius: 4px;
    }

    /* The row lights up because its controls do: something appears on hover, and
       a row that gains a button without otherwise reacting reads as a glitch. */
    .cstep:not(.staged-step):hover,
    .cstep:not(.staged-step):focus-within { background: var(--bg-hover); }

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

    /* ── The per-step controls ─────────────────────────────────────────────
       Hidden until the row is hovered or something in it has focus. FADED,
       never display:none — a button taken out of the flow cannot be tabbed
       to, and :focus-within is exactly what brings these back for a keyboard.

       The row keeps their width whether or not they are drawn, so nothing
       jumps sideways under the pointer. */
    .ctl {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      opacity: 0;
      transition: opacity 0.12s;
    }

    .cstep:hover .ctl,
    .cstep:focus-within .ctl { opacity: 1; }

    /* A touch screen has no hover to give, so it gets them always. */
    @media (hover: none) {
      .ctl { opacity: 1; }
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

    /* ── Focus ─────────────────────────────────────────────────────────────
       The controls this page grew have their own backgrounds, and a borderless
       one shows no default ring against them. Said once, for all of them. */
    .seg-btn:focus-visible,
    .more:focus-visible,
    .menu-item:focus-visible,
    .chainline:focus-visible,
    .btn:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    @media (prefers-reduced-motion: reduce) {
      .sdot.run::after { animation: none; opacity: 1; }
      .bar i { transition: none; }
      .ctl, .grip { transition: none; }
    }
  `],
})
export class QueueComponent {
  readonly tray = inject(QueueTrayService);
  private readonly queueService = inject(QueueService);
  private readonly electronService = inject(ElectronService);
  private readonly eta = inject(JobEtaService);
  private readonly toasts = inject(ToastService);
  private readonly dialog = inject(DialogService);

  /** Steps whose full readout the user has opened. Closed is the default. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());

  readonly finished = computed(() => this.tray.finishedToday());

  /** The band switch's half of the shared Running / Paused wording. */
  readonly queueState = QUEUE_STATE_CONTROL;

  readonly toolbarItems = computed<ToolbarItem[]>(() => {
    // MOVEMENT, not the engine's latch, and not defined here: the tray draws
    // this same control and the two must not disagree. See
    // QueueTrayService.anythingRunning for the rule and why.
    const isRunning = this.tray.anythingRunning();
    // THE LATCH ITSELF, which is a different question: is the queue admitting
    // work, whether or not anything happens to be on a card this second.
    const queueRunning = this.tray.isRunning();
    return [
      // RUNNING / PAUSED, the toolbar twin of the Up next band switch (Owen,
      // 2026-09-19: *"a running or paused option where it accepts new entries
      // or doesn't accept new entries — that's what the pause button should
      // handle probably"*).
      //
      // ALWAYS DRAWN, which is the whole reason it is here: the band header
      // exists only while Up next has rows, so Paused could not be armed on an
      // empty queue — and arming it before queueing a night's worth of books is
      // the press that most wants to happen on an empty queue.
      //
      // ONE FACT, TWO DRAWINGS. Both read `tray.isRunning()`, both call
      // `setQueueRunning`, both take their words from QUEUE_STATE_CONTROL. The
      // toolbar keeps no state of its own: `active` is rendered, never written
      // (see ToolbarItem.active), so a press that main refuses leaves the pair
      // showing what the engine actually holds.
      //
      // The state you are IN stays pressable, exactly as on the band: a Running
      // press while running releases anything stopped (see `setQueueRunning`).
      // Disabling it here would quietly make the twin a different control.
      {
        id: 'queue-running',
        type: 'button' as const,
        label: QUEUE_STATE_CONTROL.running.label,
        active: queueRunning,
        tooltip: QUEUE_STATE_CONTROL.running.title,
      },
      {
        id: 'queue-paused',
        type: 'button' as const,
        label: QUEUE_STATE_CONTROL.paused.label,
        active: !queueRunning,
        tooltip: QUEUE_STATE_CONTROL.paused.title,
      },
      { id: 'sep0', type: 'divider' as const },

      // ONE STOPPING GESTURE UP HERE, and it is the destructive one.
      //
      // Halt is NOT that latch and never was (Owen, 2026-08-29): it takes the
      // card back NOW, cancelling what is running. One button wearing the word
      // Pause while doing the halt is how an hour of denoise got cancelled to
      // prevent the NEXT hour of denoise. Offered only while something is
      // actually running, because there is nothing to halt otherwise.
      ...(isRunning ? [
        {
          id: 'halt',
          type: 'button' as const,
          icon: '■',
          label: 'Halt processing',
          tooltip: 'Stop the queue AND everything it is running, now. Anything '
            + 'stopped resumes from what it has already rendered. To stop just '
            + 'one step, use the Stop button on its slot.',
        },
      ] : []),
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

  // ── Which server a book waits for ────────────────────────────────────────
  //
  // crucible docs/PHASE7-LANES.md §4.2.1. The picker is per BOOK, not per step
  // (§4.4: one book = one GPU), and it offers EVERY registered server in rank
  // order plus Any — a switched-off one greyed rather than gone.
  //
  // ── Why every server, and why off the snapshot ─────────────────────────────
  //
  // This list used to be the ENABLED servers, fetched once through
  // `crucible.servers()` when the page opened, and it was wrong in both halves
  // at once (Owen, 2026-09-19: *"if one of the crucible servers is disabled with
  // an unchecked checkbox, that crucible server doesnt appear as an option in
  // the queue dropdown. if i re-check it, it still doesnt appear"*).
  //
  //  - FILTERED: a machine you can see on the bench, with its own switch on its
  //    own card, simply was not in the list beside it. The two controls are
  //    about the same hardware and disagreed about whether it exists. Drawn and
  //    DISABLED is the same answer the bench already gives a switched-off lane
  //    (`BenchLane.disabled`): *a card you own and turned off must never look
  //    like one BookForge cannot find.*
  //
  //  - READ ONCE: flipping the switch made the list stale with nothing to
  //    refresh it, so re-enabling a server left it missing until the page was
  //    rebuilt. The cure is not a second fetch on the toggle — it is to stop
  //    holding a copy. `QueueSnapshot.servers` is this same list, ranked,
  //    disabled ones included, recomputed on every publication from the reach
  //    cache admission itself reads. One fact, one owner (crucible
  //    docs/ARCHITECTURE.md R1): a picker that polled on its own could show a
  //    machine as available in the exact moment the scheduler was holding a book
  //    off it.
  //
  // Offering a disabled server is not offering a trap: the option cannot be
  // chosen, and a book that already names one keeps showing that name rather
  // than appearing to have no answer.

  /** Every registered server, best first, each with the operator's switch. */
  readonly waitForChoices = computed<readonly ServerReach[]>(
    () => this.tray.servers());

  /** "mac (off)", or just the name. Why an option cannot be picked. */
  serverOptionLabel(row: ServerReach): string {
    return row.enabled ? row.name : `${row.name} (off)`;
  }

  /**
   * THE PICKER'S ROWS — `desktop-select` items, not `<option>` elements.
   *
   * House rule: never a native `<select>`. The two lists differ by ONE label,
   * and that difference is deliberate: a staged book has not been sent
   * anywhere, so *"let the queue decide"* is an instruction about the future;
   * a live one is already waiting, so *"the first that will take it"* describes
   * what is happening to it right now.
   *
   * Two computeds rather than one method, because a method in the template
   * would mint a fresh array on every change-detection pass and the select's
   * `options` setter would re-read its rows each tick of a running render.
   */
  private serverRows(anyLabel: string): DesktopSelectItems {
    return [
      ...this.waitForChoices().map((row) => ({
        value: row.name,
        label: this.serverOptionLabel(row),
        disabled: !row.enabled,
        title: row.enabled
          ? undefined
          : `${row.name} is switched off on the bench. Switch it back on to send work there.`,
      })),
      { value: 'any', label: anyLabel },
    ];
  }

  readonly stagedServerOptions = computed<DesktopSelectItems>(
    () => this.serverRows('Let the queue decide'));

  readonly liveServerOptions = computed<DesktopSelectItems>(
    () => this.serverRows('Any — the first that will take it'));

  /** What the select shows: the book's one answer, or '' for none/disagreeing. */
  waitForValue(plan: BookPlan): string {
    if (plan.waitFor.length !== 1) return '';
    return plan.waitFor[0] ?? '';
  }

  async chooseWaitFor(plan: BookPlan, value: string): Promise<void> {
    try {
      // Every run of the book, because the book is the unit the answer is about.
      for (const jobId of plan.jobIds) await this.queueService.setWaitFor(jobId, value);
    } catch (err) {
      /*
       * THE EDIT LOST THE RACE, and the toast says so in main's own words —
       * "X was taken by a GPU on mac before this change arrived … Nothing here
       * has been altered." (docs/PENDING-QUEUE-AND-GPU-DIAL.md, "Mutability").
       *
       * The select is NOT reverted by hand here, and does not need to be: it is
       * bound to the snapshot, so the next publication — which main sends on the
       * same tick it refused — redraws it at the value the book actually has. A
       * local revert would be this side guessing at a state main already owns.
       */
      this.toasts.problem((err as Error)?.message || 'That server could not be chosen.');
    }
  }

  // ── Running / Paused ─────────────────────────────────────────────────────
  //
  // ONE fact — the engine's `running` latch — and this is the only method on
  // the page that writes it. The band switch and its toolbar twin are two
  // drawings of it, both pressing here, so neither can hold a stale opinion of
  // the state. Both halves go through the doors that already
  // existed: Start is `startQueue` (which also releases anything stopped),
  // Paused is `pauseQueue`, the DRAIN — the running steps finish what they are
  // doing and nothing new claims a slot.
  //
  // PAUSED ACCEPTS ROWS (Owen, 2026-09-19, from the admission ruling: *"if the
  // queue isn't active then it just sits in the active queue doing nothing"*).
  // Send to queue is not refused while paused; a book added lands in Up next
  // and waits there. That is why this needed no engine change at all: `pump()`
  // has always been gated on the latch.

  // PRESSING THE STATE IT IS ALREADY IN IS NOT A NO-OP, and the guard that
  // made it one had to go: `startQueue` also RELEASES everything that was
  // stopped, which was the toolbar Start button's second job. With the latch
  // already on and a book sitting held, a Running press is the gesture that
  // picks it back up — and both calls are idempotent, so nothing is spent on
  // the press that changes nothing.
  setQueueRunning(running: boolean): void {
    this.report(running ? this.queueService.startQueue() : this.queueService.pauseQueue());
  }

  /** The section's lanes, cut into Owen's rows. The arithmetic lives in `bench`. */
  rowsOf(lanes: readonly LaneView[]): LaneView[][] {
    return benchRows(lanes);
  }

  /** How many of this section's lanes are switched ON — the honest denominator. */
  liveLanes(section: BenchSectionView): number {
    return section.lanes.filter((lane) => !lane.disabled).length;
  }

  /**
   * THE SERVER THIS LANE'S SWITCH WOULD GOVERN, or null when it has none.
   *
   * A switch is only honest above a lane whose work the registry can actually
   * be told to stop sending. Two GPU lanes have no server behind them —
   * `local-longform-align` is this app's own aligner (until it becomes a
   * Crucible job) and `local-work` is the CPU pair — and a checkbox over either
   * would be one that writes nothing, or worse, writes `routing.disabled` for a
   * name no registry has.
   *
   * Owen on the CPU pair: *"those belong to the local system... they obviously
   * cant be disabled. no enable/disable button for them."* The same reasoning
   * reaches the aligner row, which he did not name: there is nowhere else for
   * that work to go either.
   */
  switchOf(lane: LaneView): string | null {
    if (lane.resource !== 'gpu') return null;
    if (lane.setId === LOCAL_WORK_SET || lane.setId === LONGFORM_ALIGN_SET) return null;
    return lane.setId;
  }

  /** The server whose switch is mid-flight, so its box cannot be double-clicked. */
  readonly switching = signal<string | null>(null);

  /**
   * FLIP ONE MACHINE ON OR OFF — `routing.disabled`, through the same
   * `setEnabled` the Settings panel writes. Nothing here decides where work
   * goes: `decideWaitFor` has always held a named server that is off and has
   * always skipped one for `any`. This is the switch, not the rule.
   *
   * It DEFERS: a render already on that
   * card keeps it (§4.3 — a job finishes where it started), and the row says so
   * by staying `retiring` until its occupant lands. Switching a machine off can
   * never take work off it.
   *
   * A refusal is SAID. The only one main can give is a name this machine does
   * not have, which would mean the bench and the registry had come apart — and
   * a checkbox that silently sprang back would be the worst way to learn it.
   */
  async toggleServer(server: string, enabled: boolean): Promise<void> {
    if (this.switching() !== null) return;
    this.switching.set(server);
    try {
      const res = await this.electronService.crucible.setEnabled(server, enabled);
      if (!res.success) {
        this.toasts.problem(res.error || `"${server}" could not be switched ${enabled ? 'on' : 'off'}.`);
      }
    } catch (err) {
      this.toasts.problem((err as Error)?.message
        || `"${server}" could not be switched ${enabled ? 'on' : 'off'}.`);
    } finally {
      this.switching.set(null);
    }
  }

  /** Send a staged book into the live queue. */
  sendPlan(plan: BookPlan): void {
    this.report(this.tray.sendPlanToQueue(plan));
  }

  /**
   * "4 steps · Narrate → Enhance (RVC) → Assemble M4B" — a staged card's line.
   *
   * The chain, not a count and a shrug. It replaced four chain rows each saying
   * *"Pending — not sent to the queue yet"*, which is the band's own heading
   * repeated once per step: the rows are still there, folded behind this line,
   * for when the names matter more than the shape.
   */
  pendingSummary(plan: BookPlan): string {
    const count = `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`;
    const chain = plan.steps.map((step) => step.label).join(' → ');
    return chain ? `${count} · ${chain}` : count;
  }

  /** Staged books whose chain the user has unfolded. Folded is the default. */
  readonly expandedPlans = signal<ReadonlySet<string>>(new Set());

  togglePlanChain(plan: BookPlan): void {
    const next = new Set(this.expandedPlans());
    if (next.has(plan.key)) next.delete(plan.key);
    else next.add(plan.key);
    this.expandedPlans.set(next);
  }

  // ── The overflow menu ────────────────────────────────────────────────────
  //
  // Small and inline rather than the house `desktop-context-menu`: that one is
  // a right-click menu positioned at a page coordinate with one line per entry,
  // and these two entries are a label AND a sentence saying what each KEEPS.
  // The difference between them is the whole reason they are two.
  //
  // One open at a time, keyed by the plan. Escape closes it and a click
  // anywhere else closes it — the toggle stops its own click from reaching the
  // document listener, or the press that opens the menu would also close it.

  readonly menuFor = signal<string | null>(null);

  toggleMenu(plan: BookPlan, event: Event): void {
    event.stopPropagation();
    this.menuFor.update((open) => (open === plan.key ? null : plan.key));
  }

  closeMenu(): void {
    this.menuFor.set(null);
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    if (this.menuFor() !== null) this.closeMenu();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.menuFor() !== null) this.closeMenu();
  }

  /** Back to Pending, from the menu. The dialog and the rules live in `cancelBook`. */
  menuReturnToPending(plan: BookPlan): void {
    this.closeMenu();
    void this.cancelBook(plan);
  }

  /** Out of the queue altogether, from the menu. */
  menuRemove(plan: BookPlan): void {
    this.closeMenu();
    this.cancelPlan(plan);
  }

  // ── What a live card's ONE primary button is ─────────────────────────────

  /** How many of this book's steps hold a slot right now. */
  runningSteps(plan: BookPlan): number {
    return plan.steps.filter((step) => step.status === 'running').length;
  }

  /**
   * STOP WHAT THIS BOOK IS RUNNING, leaving the queue running — the same
   * narrow act the slot's own Stop performs, applied to every step of the book
   * at once rather than making the user find them on the bench.
   */
  stopBook(plan: BookPlan): void {
    this.report(this.tray.stopPlan(plan));
  }

  /** False for the book already at the front, and for a queue of one. */
  canMoveToTop(plan: BookPlan): boolean {
    if (this.reordering()) return false;
    const plans = this.visiblePlans();
    return plans.length > 1 && plans[0]?.key !== plan.key;
  }

  /**
   * PUT THIS BOOK AT THE FRONT — the drag, without the drag, because the
   * engine claims work by walking `jobs[]` from the front and "run this one
   * next" is the thing the order is for. It goes through the SAME
   * `applyPlanOrder` a drop does, so the optimistic redraw, the refusal and
   * the re-read are one path with one set of rules.
   */
  moveToTop(plan: BookPlan): void {
    if (!this.canMoveToTop(plan)) return;
    const plans = this.tray.plans();
    const from = plans.findIndex((row) => row.key === plan.key);
    if (from <= 0) return;
    const optimistic = [...plans];
    moveItemInArray(optimistic, from, 0);
    this.droppedPlans.set(optimistic);
    this.report(this.applyPlanOrder(plans, from, 0));
  }

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

  /** Both shared, so the shelf and this card word the prep pass identically. */
  readonly prepLabel = prepLabel;
  readonly prepFraction = prepFraction;

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
      // The toolbar twin of the Up next band switch — the SAME door, so the
      // two cannot mean different things. See `setQueueRunning`.
      case 'queue-running': this.setQueueRunning(true); break;
      case 'queue-paused': this.setQueueRunning(false); break;
      // The hard stop: latch off AND every running step cancelled. The soft
      // one — the latch by itself — is Running/Paused, above.
      case 'halt': this.report(this.queueService.stopQueue()); break;
      // The server list is NOT refreshed here any more and needs no door of its
      // own: it rides the snapshot this call re-reads (`waitForChoices`).
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

  /**
   * Take every run in a book's plan out of the queue — Pending's Discard,
   * where nothing has been rendered and there is nowhere further back to go,
   * and the live card's *"Remove from queue"* overflow entry.
   */
  cancelPlan(plan: BookPlan): void {
    this.report(this.tray.cancelPlan(plan));
  }

  /**
   * SEND A BOOK BACK TO PENDING — the first entry of the live card's overflow
   * menu, which drops it back rather than deleting it.
   *
   * Owen, 2026-09-18: *"i should be able to stop it from running and move it
   * back to the pending queue if i want … let me change the server again if i
   * want once it re-enters the queue. or delete it if i want. if i hit cancel
   * book while its in queue, it drops back to pending."*
   *
   * A book that TRAVELS goes back to the staging band with its settings intact
   * and its server answerable again. One that does not travel has no staging
   * band to return to — `returnToPending` refuses it by name — so for those this
   * stays what Cancel has always been: out of the queue. Deciding that here
   * rather than letting the engine refuse keeps the button from being one that
   * works on some cards and errors on others.
   *
   * ASKED FIRST when the return would leave banked work behind. A read's pages
   * live in Foundry and this side cannot discard them, so "start over" would
   * quietly mean "resume from page 214" — and that is a thing to learn before
   * pressing, not after.
   */
  async cancelBook(plan: BookPlan): Promise<void> {
    if (!plan.travels) {
      this.report(this.tray.cancelPlan(plan));
      return;
    }
    let warning: string | null = null;
    try {
      warning = await this.tray.returnPlanWarning(plan);
    } catch {
      // The warning is a courtesy and its absence must not block the act: a
      // refusal here would leave the user unable to cancel a book because the
      // page could not look up a caveat about it.
      warning = null;
    }
    if (warning !== null) {
      const go = await this.dialog.confirm({
        title: 'Send this book back to Pending?',
        message: `${plan.title} stops and returns to Pending, where you can change its server or `
          + 'delete it.',
        detail: warning,
        confirmLabel: 'Back to Pending',
        type: 'warning',
      });
      if (!go) return;
    }
    this.report(this.tray.returnPlanToPending(plan));
  }

  clearFinished(): void {
    this.report(this.tray.clearFinished());
  }

  showInFolder(filePath: string): void {
    this.report(this.electronService.showItemInFolder(filePath));
  }
}
