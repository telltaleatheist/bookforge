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
 * ── LANES, not one list with a machine dropdown (Owen, 2026-09-20) ──────────
 *
 * *"maybe pending is along the left side and goes to the bottom, like a side
 * bar… the two cpu slots sit at the top, and then the GPU slots are in a grid
 * underneath"* — and, on what a GPU slot IS: *"gpu slots are crucible servers,
 * and in this case we have 2, so they should be slots 1 of 2 and 2 of 2"*.
 *
 * The old page drew ONE "Up next" list and put the machine question inside each
 * card as a dropdown. The queue's actual shape is a set of MACHINES with books
 * queued behind each of them, and a list plus a dropdown makes the reader
 * reconstruct that shape in their head from N separate answers. So the shape is
 * drawn:
 *
 *   Pending       — the left column, floor to ceiling. Every book waiting for
 *                   ANY machine: released books with no server named, staged
 *                   books not yet sent, and books that travel nowhere (they run
 *                   on the local CPU slots and cannot be pinned — tagged "CPU").
 *   Finished      — a drawer docked at that column's foot: today's work as
 *                   history, one BLOCK per book, its steps inside it.
 *   Needs you     — failures, with the engine's own sentence and the controls
 *                   that resolve them. Not drawn when there are none. First in
 *                   the right column, so it cannot shorten the sidebar.
 *   Local slots   — this machine's own lanes, as compact tiles. Not drop
 *                   targets: nothing is pinned to a CPU slot, work simply
 *                   arrives there.
 *   GPU slots     — one LANE per Crucible server, each drawing what is on its
 *                   card now and the books pinned behind it, in queue order.
 *
 * ── TWO COLUMNS, TWO SCROLLBARS, NO PAGE SCROLL (Owen, 2026-09-20) ──────────
 *
 * *"i think the pending list should stretch to the bottom of the tab. like a
 * sidebar. and on the bottom can be an accordion that slides up and shows
 * completed jobs. the completed jobs can be blocks, just like they were when
 * they were pending. not plain text like they are now. a single block that,
 * when clicked, expand to show which job was done. cleanup, tts, assembly,
 * etc."*
 *
 * The page used to own the only scrollbar, which made "the bottom of the tab" a
 * place nothing could be put: every column was as tall as its own contents, so
 * Pending drew a stub on a quiet day and pushed the machines off screen on a
 * busy one. Now `.page` is a fixed-height flex column that clips, `.layout`
 * takes the whole of it, and the two panes scroll themselves — the pending list
 * inside the aside, everything else inside `.floor`. Below 960px all of that is
 * undone and the page scrolls again, because stacked columns with private
 * scrollbars are three nested scrollers and a drawer pinned to the middle of a
 * page.
 *
 * And Finished stopped being a table. Six columns at the very bottom of the
 * page, below the fold, drawn in a shape nothing else here uses, with a book's
 * four chained steps appearing as four unrelated rows sharing a title cell. It
 * is now one card per BOOK from the same family the book had while it waited,
 * and clicking it opens the chain it ran — reusing the running card's own
 * `.rung` ladder, because "what this book ran, in order" must not have two
 * drawings.
 *
 * DRAG IS THE ACCELERATOR, NEVER THE ONLY DOOR. Pending → lane pins, lane →
 * Pending un-pins, and either way the same `chooseWaitFor` the ⋯ menu's
 * *Run on…* picker calls is what actually writes the answer. A person on a
 * keyboard, or a person who simply does not want to drag, loses nothing.
 *
 * ── Pending and the lanes are ONE card in two states ────────────────────────
 *
 * They were two loops drawing two nearly-identical cards, and they drifted:
 * different action sets, different pickers, different words for the same fact.
 * The body of all of them is now a single `#bookCard` template with a `staged`
 * flag, and each list supplies its own wrapper — because every list here is a
 * drop list and `cdkDrag` has to be a real child of the list that owns the drag.
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
import {
  CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, moveItemInArray,
} from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';

import { prepFraction, prepLabel } from '@shared/queue/bench';
import type { BookPlan, FinishedRun } from '@shared/queue/bench';
import type { JobType, ServerReach, StepStatus } from '@shared/queue/engine-types';
import { LOCAL_WORK_SET, LONGFORM_ALIGN_SET } from '@shared/queue/slot-sets';
import { DesktopSelectComponent } from '../../creamsicle-desktop';
import type { DesktopSelectItems } from '../../creamsicle-desktop';
import { DialogService } from '../../creamsicle-desktop/services/dialog.service';
import { ElectronService } from '../../core/services/electron.service';
import { ToastService } from '../../core/services/toast.service';
import { JobDetailsComponent } from './components/job-details/job-details.component';
import { JobStepComponent } from './components/job-step/job-step.component';
import { StageBarsComponent } from './components/stage-bars/stage-bars.component';
import { stagesFor } from './models/job-stages';
import { JobEtaService } from './services/job-eta.service';
import { QueueService } from './services/queue.service';
import { QueueTrayService } from './services/queue-tray.service';
import type { BenchSectionView, BookPlanView, LaneView } from './services/queue-tray.service';

/**
 * WHAT RUNNING AND PAUSED MEAN — the words, once (2026-09-19).
 *
 * The state used to be drawn TWICE — on the Up next band header and in the
 * toolbar — because the band header vanished with its rows. The lane layout
 * removed that band, so there is now ONE drawing of it, in the toolbar, where
 * it is on screen over an empty queue as well as a full one. The table stays
 * where it is: two WORDINGS of one fact is the thing to avoid, and a copied
 * tooltip is exactly what gets edited in one place a month from now.
 *
 * The titles say what the STATE means, not what the button does, because the
 * one you are already in is still pressable (see `setQueueRunning`).
 *
 * `caption` is the sentence under the pill (Owen, 2026-09-20 — the segmented
 * control has to say what the state DOES, not just name it). It is a full
 * sentence rather than the tooltip's paragraph because it is always on screen.
 */
const QUEUE_STATE_CONTROL = {
  running: {
    label: 'Running',
    title: 'Steps start as slots free up. Pressing it while already running '
      + 'picks up anything that was stopped.',
    caption: 'Accepting books and starting them as machines free up.',
  },
  paused: {
    label: 'Paused',
    title: 'Books may still be added to the queue and reordered; nothing new '
      + 'starts until Running. Work already on a slot finishes.',
    caption: 'Accepting books; nothing new starts. Work already on a card finishes.',
  },
} as const;

/** The Pending column's identity as a drop target. Not a server's name. */
const PENDING_LIST = '__pending__';

/**
 * How many pinned books a lane draws before it folds (Owen's mockup).
 *
 * Four, and the fold is PER LANE: a server with eleven books behind it must not
 * push the server beside it off the bottom of the screen, and "+ 7 more pinned
 * here" is a more useful sentence about that lane than seven more cards are.
 */
const PINNED_FOLD = 4;

/**
 * A row of the Pending column: a book's plan, and which side of the Send-to-
 * queue press it is on. One list, because to the reader they are one kind of
 * thing — *not behind a particular machine* — and the card body is the same
 * `#bookCard` in its two states.
 */
interface PendingEntry {
  plan: BookPlanView;
  staged: boolean;
}

/**
 * WHERE A DROPPED BOOK GOES IN THE ENGINE'S ONE ORDER.
 *
 * `none` is a real answer and not an absence: a book pinned to an EMPTY lane
 * has said nothing about its rank, and moving it anyway — to the back, which is
 * the other plausible reading of "dropped last" — would demote a book for the
 * crime of being given a free machine.
 */
type OrderTarget =
  | { kind: 'none' }
  | { kind: 'end' }
  | { kind: 'before'; plan: BookPlanView };

/**
 * WHERE THE DRAWER REMEMBERS WHETHER IT IS OPEN.
 *
 * The renderer's own key, like every other per-machine preference on this side
 * (the library path is the standing example): what a person wants their queue
 * page to look like is a fact about this screen, not about the library, and
 * nothing in main has an opinion about it. Default CLOSED — the page is about
 * what is running, and history that opens itself takes half the sidebar from
 * the list Owen asked to stretch to the bottom.
 */
const FINISHED_OPEN_KEY = 'bookforge.queue.finishedOpen';

/**
 * ONE FINISHED BOOK, with everything it ran today inside it.
 *
 * Owen, 2026-09-20: *"a single block that, when clicked, expand to show which
 * job was done. cleanup, tts, assembly, etc."* — so the unit here is the BOOK
 * and the steps are its contents, which is the opposite of what the table did
 * (one row per step, the title repeated down the page).
 */
interface FinishedBlock {
  /** Stable across re-groupings: the first jobId the book was seen under. */
  key: string;
  title: string;
  cover: string | null;
  /** Oldest first — the order they ran, which is how a chain is read. */
  runs: FinishedRun[];
  /** The worst thing that happened to any step of it. */
  status: 'done' | 'failed' | 'cancelled';
  /** The latest finish in the group. */
  finishedAt?: string;
}

/**
 * Read the drawer's remembered state without letting a storage failure take
 * the page with it. A locked-down or full localStorage is a real thing on a
 * desktop app, and it must cost a preference, never a render.
 */
function readFinishedOpen(): boolean {
  try {
    return localStorage.getItem(FINISHED_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * A finished step's place in time, as a number that sorts.
 *
 * A step with no 'finishedAt' sorts LAST rather than first: an unstamped row
 * is one the engine never got to write a time for, and putting it at the head
 * of a chain would claim it ran before the ones that did.
 */
function finishedMs(run: FinishedRun): number {
  if (!run.finishedAt) return Number.POSITIVE_INFINITY;
  const ms = new Date(run.finishedAt).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** One rung of the step ladder a busy card draws. */
interface ChainRung {
  stepId: string;
  label: string;
  status: StepStatus;
  type: JobType;
  percent: number | null;
  /** Finished successfully — the part of the chain a Stop would keep. */
  done: boolean;
}

@Component({
  selector: 'app-queue',
  standalone: true,
  imports: [
    DatePipe, DecimalPipe, NgTemplateOutlet, FormsModule,
    DesktopSelectComponent, JobStepComponent, JobDetailsComponent, StageBarsComponent,
    CdkDropList, CdkDropListGroup, CdkDrag, CdkDragHandle, CdkScrollable,
  ],
  template: `
    <!-- ── The toolbar row ─────────────────────────────────────────────────
         HAND-DRAWN, not \'desktop-toolbar\' (2026-09-20). ToolbarItem is a flat
         list of buttons, dropdowns and dividers; what this row has to say is a
         LABELLED STATE — the word "Queue", a segmented pill, and a caption
         underneath that changes with the state — which no combination of those
         item types expresses without lying about which control owns what.

         Everything it presses is the same door it pressed before:
         \'setQueueRunning\' for the pill, \'stopQueue\' for Halt, and
         \'refreshFromBackend\' for the arrow. The queue page is the only page
         with a toolbar of its own shape; every other page still uses the
         component. -->
    <div class="qbar">
      <div class="qstate">
        <span class="qword">Queue</span>
        <!-- Two states of ONE fact (the engine's running latch), drawn as one
             control so it cannot look like two independent buttons. Colour
             carries the meaning: green is moving, amber is holding — never red,
             because pausing throws nothing away.

             PAUSED ACCEPTS ROWS (Owen, 2026-09-19: *"if the queue isn't active
             then it just sits in the active queue doing nothing"*). Send to
             queue is not refused while paused. That is what the caption says,
             and it is why this needed no engine change at all: \'pump()\' has
             always been gated on the latch. -->
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
        <span class="qcaption">{{ stateCaption() }}</span>
      </div>

      <span class="qspacer"></span>

      <!-- The same slot readout the old "On the bench" heading carried. It
           belongs up here now that the bench is two separate bands and neither
           of them can honestly claim the whole count. -->
      <span class="qslots">{{ slotSummary() }}</span>

      <!-- ONE STOPPING GESTURE UP HERE, and it is the destructive one.
           Halt is NOT the latch and never was (Owen, 2026-08-29): it takes the
           card back NOW, cancelling what is running. One button wearing the
           word Pause while doing the halt is how an hour of denoise got
           cancelled to prevent the NEXT hour of denoise. Offered only while
           something is actually running, because there is nothing to halt
           otherwise — and now SAYING HOW MUCH it would stop, behind its own
           rule, so it cannot be pressed as though it were the pill's sibling. -->
      @if (tray.anythingRunning()) {
        <span class="qrule" aria-hidden="true"></span>
        <button
          type="button"
          class="btn halt"
          (click)="halt()"
          title="Stop the queue AND everything it is running, now. Anything stopped resumes from what it has already rendered. To stop just one book, use the Stop on its card."
        >■ Stop running work · {{ runningBooks() }} book{{ runningBooks() === 1 ? '' : 's' }}</button>
      }

      <button
        type="button"
        class="qicon"
        (click)="refresh()"
        aria-label="Refresh the queue"
        title="Re-read the queue from the app’s main process."
      >↻</button>
    </div>

    <div class="page">


      <!-- ── The floor: Pending down the left, the machines on the right ───
           Owen, 2026-09-20: *"maybe pending is along the left side and goes to
           the bottom, like a side bar… the two cpu slots sit at the top, and
           then the GPU slots are in a grid underneath"*.

           ONE cdkDropListGroup around the whole thing, because a book dragged
           out of Pending has to be able to land on any lane and a book dragged
           off a lane has to be able to land back in Pending. The group is what
           connects the lists; nothing here maintains a list of ids. -->
      <div class="layout" cdkDropListGroup>

        <!-- ── Pending, the column that runs floor-to-ceiling ─────────────
             Owen, 2026-09-20: *"i think the pending list should stretch to the
             bottom of the tab. like a sidebar."*

             It USED to be 'position: sticky' inside the page's own scroller,
             which is a different thing wearing the same look: it was as tall
             as its contents and slid along as the page moved, so a short
             queue drew a short stub and a long one grew the page until the
             machines beside it scrolled away. Now the aside IS the height of
             the floor — a flex column that owns two children, the pending
             list (which takes what is left and scrolls inside itself) and the
             Finished drawer docked at its foot.

             DRAWN LIKE A SLOT, deliberately: it is the answer "any machine",
             and a book sitting in it is queued exactly as hard as one pinned to
             a card. It is the only list here that is not a machine, so it says
             which machine it is — the first free one.

             The SECTION is the drop list, header included: a wide target, and
             no wrapper between the column and its cards. It is also the
             SCROLLER, which is why the header inside it is sticky rather than
             lifted out — CDK auto-scrolls the drop list's own element while a
             book is dragged near its edge, and a scroller nested one level
             deeper is not one it knows to move. -->
        <aside class="sidebar">
          <section
            class="slotcol"
            cdkDropList
            [cdkDropListDisabled]="reordering()"
            [cdkDropListEnterPredicate]="acceptUnpin"
            (cdkDropListDropped)="onPendingDrop($event)"
            (cdkDropListEntered)="hoverList.set(pendingList)"
            (cdkDropListExited)="clearHover(pendingList)"
            (mouseenter)="hoverList.set(pendingList)"
            (mouseleave)="clearHover(pendingList)"
          >
            <header class="slot-head">
              <div class="slot-line">
                <h2>Pending</h2>
                <span class="slot-count">{{ pendingColumn().length }}</span>
              </div>
              <div class="slot-where">Any machine</div>
              <span class="slot-pill">first free machine</span>
            </header>

            @if (dragNote(pendingList); as note) {
              <p class="drop-note">{{ note }}</p>
            }

            @for (entry of pendingColumn(); track entry.plan.key) {
              <article
                class="card narrow"
                [class.staged]="entry.staged"
                cdkDrag
                [cdkDragData]="entry.plan"
                [cdkDragDisabled]="isLocked(entry.plan)"
                (cdkDragStarted)="dragStarted(entry.plan)"
                (cdkDragEnded)="dragEnded()"
              >
                <!-- HANDLE, not the whole card. The card body carries a
                     primary, an overflow menu and a step name per row that
                     expands it; making the card itself draggable would arm a
                     drag under every one of those presses.

                     It stays HERE rather than inside the shared body because
                     cdkDrag finds its handle by content query, and a handle
                     rendered from a template declared elsewhere is not in that
                     scope — the card would silently become draggable
                     everywhere. Absent on a book that holds a card: there is
                     nothing a drag of it could honestly mean. -->
                @if (!isLocked(entry.plan)) {
                  <button
                    type="button"
                    class="grip"
                    cdkDragHandle
                    aria-label="Drag this book onto a machine, or up and down the queue"
                    title="Drag this book onto a machine, or up and down the queue"
                  >⠿</button>
                }
                <ng-container
                  [ngTemplateOutlet]="bookCard"
                  [ngTemplateOutletContext]="{ $implicit: entry.plan, staged: entry.staged, lane: null }"
                />
              </article>
            }

            @if (pendingColumn().length === 0) {
              <p class="slot-free">
                Nothing is waiting for a free machine. Books pinned to a
                particular server are on that server’s lane.
              </p>
            }
          </section>

          <!-- ── Finished today, docked at the sidebar's foot ────────────────
               Owen, 2026-09-20: *"on the bottom can be an accordion that
               slides up and shows completed jobs. the completed jobs can be
               blocks, just like they were when they were pending. not plain
               text like they are now. a single block that, when clicked,
               expand to show which job was done. cleanup, tts, assembly,
               etc."*

               THIS REPLACES THE TABLE. The old band was a six-column
               '<table class="ftable">' at the very bottom of the page —
               below the lanes, below the fold, seen by nobody, and written in
               a shape nothing else on this page uses. A book that ran four
               steps appeared as four unrelated rows sharing a title cell.

               The BLOCK is the answer to both: one card per BOOK, drawn from
               the same family as the card it was five minutes ago in Pending,
               and its steps are inside it rather than beside it. The card's
               own step ladder ('.rung') is what the expansion reuses, because
               "what this book ran, in order" is the same question a running
               card answers and must not have two drawings.

               Only drawn when something finished today — an empty accordion
               is a control that promises a drawer with nothing in it. -->
          @if (finishedBlocks().length > 0) {
            <section class="finished" [class.open]="finishedOpen()">
              <!-- TWO BUTTONS, not one: the header toggles, and Clear is its
                   own act. Nesting Clear inside the toggle would make it a
                   button in a button (invalid, and a press of it would also
                   open the drawer it just emptied). -->
              <div class="fin-head">
                <button
                  type="button"
                  class="fin-toggle"
                  [attr.aria-expanded]="finishedOpen()"
                  (click)="toggleFinished()"
                  title="Today’s finished books. Click to open or close."
                >
                  <span class="chev" aria-hidden="true">▸</span>
                  <span class="fin-word">Finished today</span>
                  <!-- BOOKS, not steps. The drawer under this header lists
                       books, and a count of the STEPS inside them — which is
                       what the table's heading carried, because the table's
                       rows were steps — would name a number nothing below it
                       adds up to. -->
                  <span class="fin-count">{{ finishedBlocks().length }}</span>
                  @if (finishedFailed() > 0) {
                    <span class="fin-bad">{{ finishedFailed() }} failed</span>
                  }
                </button>
                <button
                  type="button"
                  class="btn quiet xs fin-clear"
                  (click)="clearFinished()"
                  title="Clear today’s history. Nothing on disk is touched."
                >Clear</button>
              </div>

              <!-- THE SLIDE IS 0fr → 1fr on a grid row, not a max-height
                   guess: a max-height animation has to name a number bigger
                   than the content, and any number big enough is also a
                   visibly wrong speed for a short drawer. The clip is what
                   hides the closed content; the list inside it owns the
                   scroll and its own ceiling. -->
              <div class="fin-body">
                <div class="fin-clip">
                  <div class="fin-list">
                    @for (block of finishedBlocks(); track block.key) {
                      <article class="card narrow fin-card" [class.on]="openFinished() === block.key">
                        <button
                          type="button"
                          class="fin-block"
                          [attr.aria-expanded]="openFinished() === block.key"
                          (click)="toggleFinishedBlock(block)"
                          [title]="'What ' + block.title + ' ran today'"
                        >
                          @if (block.cover) {
                            <img class="cover" [src]="block.cover" alt="" />
                          } @else {
                            <span class="cover blank" aria-hidden="true"></span>
                          }
                          <div class="min">
                            <div class="title-row"><h3>{{ block.title }}</h3></div>
                            <div class="sub">
                              {{ block.runs.length }} step{{ block.runs.length === 1 ? '' : 's' }}
                              @if (block.finishedAt) {
                                · finished {{ block.finishedAt | date:'shortTime' }}
                              }
                            </div>
                          </div>
                          <span
                            class="pill"
                            [class.ok]="block.status === 'done'"
                            [class.bad]="block.status === 'failed'"
                          >{{ block.status }}</span>
                        </button>

                        <!-- WHICH JOB WAS DONE — cleanup, TTS, assembly — in
                             the order it ran, which is the order a person
                             reads a chain in and the reverse of the order the
                             engine hands them over (newest first). -->
                        @if (openFinished() === block.key) {
                          <div class="ladder fin-ladder">
                            @for (run of block.runs; track run.stepId) {
                              <div class="fin-step">
                                <div class="rung fin-rung" [class.done]="run.status === 'done'">
                                  <span class="rdot" aria-hidden="true"></span>
                                  <span class="rname">{{ run.label }}</span>
                                  <span
                                    class="mk pill"
                                    [class.ok]="run.status === 'done'"
                                    [class.bad]="run.status === 'failed'"
                                  >{{ run.status }}</span>
                                </div>
                                <div class="fin-meta">
                                  <span class="fin-num">{{ took(run) }}</span>
                                  @if (run.finishedAt) {
                                    <span aria-hidden="true">·</span>
                                    <span class="fin-num">{{ run.finishedAt | date:'shortTime' }}</span>
                                  }
                                  <!-- The produced file, still a real door:
                                       the table's one genuinely useful cell
                                       was this one, and it is the same
                                       'showInFolder' it always was. -->
                                  @if (run.outputPath; as out) {
                                    <button
                                      type="button"
                                      class="link fin-file"
                                      [title]="out"
                                      (click)="showInFolder(out)"
                                    >{{ fileName(out) }}</button>
                                  }
                                </div>
                              </div>
                            }
                          </div>
                        }
                      </article>
                    }
                  </div>
                </div>
              </div>
            </section>
          }
        </aside>

        <!-- 'cdkScrollable' EARNS ITS KEEP THE MOMENT THIS COLUMN SCROLLS
             ITSELF. CDK finds a drop list's scrollable ANCESTORS through the
             ScrollDispatcher, and only registered ones are in that answer — so
             without this, a book dragged toward the bottom of the floor would
             hover over a lane that never came up to meet it. Nothing else
             about the drag changed: the group still connects every list. -->
        <div class="floor" cdkScrollable>

          <!-- ── Needs you, at the head of the right column ──────────────
               It used to sit ABOVE the whole floor, which meant one failed
               step pushed Pending, the tiles and every lane down the page —
               the sidebar now runs floor-to-ceiling and nothing may shorten
               it. Here it is the first thing in the column that scrolls, so a
               failure is still the first thing read and the machines below it
               do not move. -->
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

          <!-- ── Local slots ───────────────────────────────────────────────
               This machine's own lanes — the 'local-work' CPU pair, and the
               in-app aligner's GPU row when it is on the bench. TILES, not
               lanes, and NOT drop targets: nothing is ever pinned to a CPU
               slot. Work that travels nowhere simply arrives on one, which is
               why those books sit in Pending tagged "CPU" rather than in a
               queue behind a tile. -->
          @if (localLanes().length > 0) {
            <section class="band">
              <header class="band-head">
                <h2>Local slots</h2>
                <span class="note">Assembly, muxing, exports — work this machine does and never sends anywhere.</span>
              </header>
              <div class="tiles">
                @for (lane of localLanes(); track laneKey(lane)) {
                  <article class="lcard tile" [class.idle]="!lane.occupant && !lane.hold">
                    <div class="tile-head">
                      <span class="tile-where">This machine</span>
                      <span class="tile-slot">{{ localSlotLabel(lane) }}</span>
                    </div>
                    <ng-container
                      [ngTemplateOutlet]="slotBody"
                      [ngTemplateOutletContext]="{ $implicit: lane, compact: true }"
                    />
                  </article>
                }
              </div>
            </section>
          }

          <!-- ── GPU slots ─────────────────────────────────────────────────
               ONE LANE PER CRUCIBLE SERVER. Owen, 2026-09-20: *"gpu slots are
               crucible servers, and in this case we have 2, so they should be
               slots 1 of 2 and 2 of 2"* — so the ordinal drawn on a lane head
               is its place among the SERVERS, not 'lane.index'/'lane.of', which
               count slots inside one machine's own pool and read "1 of 1" on
               every card in a two-server bench.

               A Crucible server is a Crucible server wherever it runs (ruling
               7, 2026-09-19), so a loopback engine gets exactly this lane and
               exactly these controls. -->
          @if (gpuLanes().length > 0) {
            <section class="band">
              <header class="band-head">
                <h2>GPU slots · {{ gpuLanes().length }} Crucible server{{ gpuLanes().length === 1 ? '' : 's' }}</h2>
                <span class="note">Drag a book onto a lane to pin it there. Switch one off to keep new work away from it.</span>
              </header>
              <div class="lanes">
                @for (lane of gpuLanes(); track laneKey(lane); let i = $index) {
                  <section
                    class="lane"
                    [class.off]="lane.disabled"
                    [class.down]="!lane.disabled && lane.down"
                    cdkDropList
                    [cdkDropListData]="lane"
                    [cdkDropListDisabled]="reordering()"
                    [cdkDropListEnterPredicate]="acceptPin"
                    (cdkDropListDropped)="onLaneDrop(lane, $event)"
                    (cdkDropListEntered)="hoverList.set(lane.setId)"
                    (cdkDropListExited)="clearHover(lane.setId)"
                    (mouseenter)="hoverList.set(lane.setId)"
                    (mouseleave)="clearHover(lane.setId)"
                  >
                    <!-- THE SWITCH, ON THE LANE IT GOVERNS, and only on a lane
                         it can govern. Owen: "each one should have an
                         enable/disable checkbox above it with its name."
                         'switchOf' answers with the SERVER NAME or null, so
                         nothing on the local tiles gets one: there is no
                         registered server behind them to switch off.

                         It writes 'routing.disabled' through the same
                         'setEnabled' the Settings panel has always called. One
                         fact, two doors — and the queue has honoured it all
                         along ('decideWaitFor' holds a named server that is
                         off, and 'any' never tries one).

                         AND 'down' IS A SECOND WORD FOR A SECOND FACT, never
                         for this one. The switch is what the operator decided
                         this machine is for; 'lane.down' is what the machine
                         said when the scheduler last asked it. A sleeping Mac
                         used to draw a lane indistinguishable from a working
                         one, with its books silently never starting. Nothing
                         here writes 'routing.disabled' from it: switching a
                         machine off because it is asleep would leave it off
                         after it woke, and the operator never chose that. -->
                    <header class="lane-head">
                      @if (switchOf(lane); as server) {
                        <label class="lane-switch" [title]="lane.down || ''">
                          <input
                            type="checkbox"
                            [checked]="!lane.disabled"
                            [disabled]="switching() === server"
                            (change)="toggleServer(server, $any($event.target).checked)"
                          />
                          <span class="lane-name">{{ lane.setLabel }}</span>
                        </label>
                      } @else {
                        <span class="lane-name">{{ lane.setLabel }}</span>
                      }
                      <span class="lane-slot">GPU slot {{ i + 1 }} of {{ gpuLanes().length }}</span>
                      <!-- Per-class bindings, not [class]="tone": a whole-class
                           binding beside a static class attribute is a rule
                           about merging that nobody should have to remember
                           while reading a lane header. -->
                      <span
                        class="lane-state"
                        [class.live]="laneState(lane).tone === 'live'"
                        [class.warn]="laneState(lane).tone === 'warn'"
                        [class.bad]="laneState(lane).tone === 'bad'"
                      >
                        <span class="dot" aria-hidden="true"></span>{{ laneState(lane).word }}
                      </span>
                      @if (lane.thermal; as thermal) {
                        <span class="temp" [class.hot]="thermal.throttleSustained">
                          {{ thermal.tempC }}°C
                          @if (thermal.fanPct !== undefined) { · fan {{ thermal.fanPct }}% }
                        </span>
                      }
                    </header>

                    <!-- The driver's own verdict, not a threshold this app
                         invented. Said above the work because it explains the
                         number below it: a throttled card is why a healthy run
                         misses its band. -->
                    @if (lane.thermal?.throttleSustained) {
                      <div class="hot-note">
                        Running hot — the card is throttling itself, so this run is
                        slower than the machine can go. Check fans and airflow.
                      </div>
                    }

                    <div class="on-card">
                      <div class="on-card-label">On the card now</div>
                      <ng-container
                        [ngTemplateOutlet]="slotBody"
                        [ngTemplateOutletContext]="{ $implicit: lane, compact: false }"
                      />
                    </div>

                    <div class="pinned">
                      <div class="pinned-head">
                        Pinned here · {{ lanePinned(lane).length }}
                      </div>

                      @if (dragNote(lane.setId); as note) {
                        <p class="drop-note" [class.no]="pinRefusal(lane, dragging()) !== null">{{ note }}</p>
                      }

                      @for (plan of laneRows(lane); track plan.key) {
                        <article
                          class="card narrow"
                          cdkDrag
                          [cdkDragData]="plan"
                          [cdkDragDisabled]="isLocked(plan)"
                          (cdkDragStarted)="dragStarted(plan)"
                          (cdkDragEnded)="dragEnded()"
                        >
                          @if (!isLocked(plan)) {
                            <button
                              type="button"
                              class="grip"
                              cdkDragHandle
                              aria-label="Drag this book to another machine, or up and down this lane"
                              title="Drag this book to another machine, or up and down this lane"
                            >⠿</button>
                          }
                          <ng-container
                            [ngTemplateOutlet]="bookCard"
                            [ngTemplateOutletContext]="{ $implicit: plan, staged: false, lane: lane }"
                          />
                        </article>
                      }

                      @if (lanePinned(lane).length === 0) {
                        <p class="pinned-none">Nothing is waiting for this machine.</p>
                      }

                      <!-- THE FOLD IS PER LANE. Expanding one server's queue
                           must not move the server beside it, which is what a
                           page-wide "show all" would do. -->
                      @if (lanePinned(lane).length > laneRows(lane).length) {
                        <button type="button" class="fold" (click)="toggleLaneFold(lane)">
                          + {{ lanePinned(lane).length - laneRows(lane).length }} more pinned here
                        </button>
                      } @else if (lanePinned(lane).length > pinnedFold) {
                        <button type="button" class="fold" (click)="toggleLaneFold(lane)">
                          Show fewer
                        </button>
                      }
                    </div>
                  </section>
                }
              </div>
            </section>
          }

          <!-- ── Routed elsewhere ──────────────────────────────────────────
               An engine forwarding a request to its upstream (crucible PHASE15
               §5.3). Neither this machine's CPU nor a card anybody here owns,
               so it is neither a tile nor a lane you can pin to — drawn as
               tiles, with the section's own words, only when such a lane
               exists. -->
          @for (section of cloudSections(); track section.group) {
            <section class="band">
              <header class="band-head">
                <h2>{{ section.heading }}</h2>
                <span class="note">{{ section.note }}</span>
              </header>
              <div class="tiles">
                @for (lane of section.lanes; track laneKey(lane)) {
                  <article class="lcard tile" [class.idle]="!lane.occupant && !lane.hold">
                    <div class="tile-head">
                      <span class="tile-where">{{ lane.setLabel }}</span>
                      <span class="tile-slot">slot {{ lane.index }} of {{ lane.of }}</span>
                    </div>
                    <ng-container
                      [ngTemplateOutlet]="slotBody"
                      [ngTemplateOutletContext]="{ $implicit: lane, compact: true }"
                    />
                  </article>
                }
              </div>
            </section>
          }

          <!-- NOTHING AT ALL, at the foot of the floor. The lane layout
               above draws machines whether or not anything is queued, so this
               only replaces the whole floor when there is no work, no failure
               and no machine holding anything.

               It sat BELOW the layout until the sidebar grew to full height;
               with '.page' a fixed-height flex column there is no "below" any
               more, so it lives at the end of the column that scrolls. -->
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
        </div>
      </div>

      <!-- ── What is on a slot ──────────────────────────────────────────────
           ONE body for a tile and for a lane's "On the card now", because a
           slot is a slot: the same occupant, the same measurements, the same
           three empty states (held off, free, or simply nothing wants it). The
           'compact' flag drops the step ladder, which a 2-across tile has no
           room for and a CPU assembly has little to say in. -->
      <ng-template #slotBody let-lane let-compact="compact">
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
            <!-- The percentage alone up here. The ETA is down in the
                 measurements (Owen, 2026-08-22): it is a measurement, it
                 belongs with the others. -->
            <div class="right">
              @if (busy.percent !== null) {
                <div class="pct">{{ busy.percent | number:'1.0-0' }}%</div>
              }
            </div>
            <!-- STOP, TOP RIGHT, POSITIONED LIKE AN X (Owen, 2026-09-20: *"put
                 Stop in the top right, positioned like its an X. and keep it
                 short"*). It is the narrow act and the tooltip says so: the
                 queue keeps running, the book keeps what it rendered.

                 It is NOT wired to 'returnToPending', which resets progress —
                 a known engine defect (PK16) being fixed on its own. A stopped
                 book stays exactly where it is, held, with "Start this book".
                 Asking first, because what a stop keeps is the only thing
                 worth knowing before pressing it. -->
            <button
              type="button"
              class="stop-x"
              (click)="stopLane(lane)"
              title="Stops this step and frees the card. The book keeps everything it has rendered; Start picks it up from there."
            >■ Stop</button>
          </div>

          <div class="bar" [class.dim]="busy.percent === null">
            <i [style.width.%]="busy.percent ?? 0"></i>
          </div>

          <!-- The stage breakdown, because the headline number alone cannot
               show life: an Orpheus batch reports no completions for minutes
               while the stages under it are moving. Drawn by the same
               'app-stage-bars' the expanded step readout uses, so a stage
               cannot read one way here and another there. -->
          @if (busy.stages.length > 0) {
            <app-stage-bars
              [stages]="busy.stages"
              [detail]="tray.detailFor(lane) || undefined"
              [prep]="busy.prep"
            />
          } @else {
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
          }

          <!-- THE STEP LADDER — where this book has got to in its own chain.
               Read off the mirror rather than off 'plan.steps', because a
               plan drops terminal steps by construction ('plansOf' skips
               them) and the rung a reader most wants is the one that is
               already DONE: it is the part a stop would keep. -->
          @if (!compact) {
            @if (chainFor(busy.jobId); as chain) {
              @if (chain.length > 1) {
                <div class="ladder">
                  @for (rung of chain; track rung.stepId) {
                    <div class="rung" [class.now]="rung.status === 'running'" [class.done]="rung.done">
                      <span class="rdot" aria-hidden="true"></span>
                      <span class="rname">{{ rung.label }}</span>
                      @if (rung.status === 'running') {
                        <span class="bar thin"><i [style.width.%]="rung.percent ?? 0"></i></span>
                        <span class="rval">
                          @if (rung.percent !== null) { {{ rung.percent | number:'1.0-0' }}% } @else { now }
                        </span>
                      } @else {
                        <span class="rval">{{ rung.done ? 'done' : 'waiting' }}</span>
                      }
                    </div>
                  }
                </div>
              }
            }
          }

          <!-- The measurements. Rate is the number a long render is judged by;
               absent until an honest window exists, never estimated.

               Drawn whenever the slot is busy, rather than only when something
               has been measured: the ETA cell always says something — a
               duration or "not timed yet" — and a row that appeared partway
               through a run would move every other number down the card at the
               moment the reader was watching them. -->
          <div class="measures">
            @if (lane.count) {
              <!-- CHUNKS, not sentences. lane.count is
                   chunksCompletedInJob/totalChunksInJob, and a chunk packs 2-3
                   sentences — so this read ~3.6x lower than the book's real
                   sentence count and disagreed with the sent/min beside it,
                   which IS raw sentences (Owen, 2026-08-20). -->
              <div class="ro"><div class="k">Chunks</div><div class="v">{{ lane.count }}</div></div>
            }
            @if (lane.speed) {
              <div class="ro"><div class="k">Rate</div><div class="v">{{ lane.speed }}</div></div>
            }
            @if (lane.elapsed) {
              <div class="ro"><div class="k">Elapsed</div><div class="v">{{ lane.elapsed }}</div></div>
            }
            <!-- Last, and pushed to the right edge so it lands under the stage
                 rows' "done" column. Elapsed and ETA end up beside each other,
                 which is the pairing a person actually reads: how long this has
                 taken, and how long is left. -->
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
            <div class="free-sub">Nothing queued wants this slot.</div>
          </div>
        }
      </ng-template>

      <!-- ── The book card, every list ──────────────────────────────────────
           Declared once and rendered by the Pending column (staged books with
           staged: true, released ones with false) and by every lane's pinned
           list. The WRAPPER stays with each list because every list here is a
           drop list and cdkDrag must be its own child.

           'lane' is the lane this card is drawn ON, or null in Pending. It is
           passed so a Stop can say which card it frees, not so the body can
           decide anything differently. -->
      <ng-template #bookCard let-plan let-staged="staged" let-lane="lane">
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
                <!-- CPU, on a book that travels nowhere. It is in the Pending
                     column with everything else waiting for a free machine, and
                     without this tag it would look like a book that simply has
                     not been given a server — which is the one thing it can
                     never be given. A pass or an assembly runs on this
                     machine's local slots; there is nothing to pin it to. -->
                @if (!plan.travels) {
                  <span
                    class="cpu-tag"
                    title="This book's work runs on this machine's CPU slots. It cannot be pinned to a Crucible server."
                  >CPU</span>
                }
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
            step of it follows this answer.

            ── Why the live card's picker moved into the ⋯ menu (2026-09-20) ──

            THE LANE IS NOW THE ANSWER. A card drawn under "sonnet · GPU slot 1
            of 2" has already said which machine it waits for, and a dropdown on
            it repeating that is the page asking a question it just answered.
            The picker is not gone — it is the menu's *Run on…* row, which is
            the keyboard and the precise path, because DRAG IS AN ACCELERATOR
            AND NEVER THE ONLY DOOR.

            A STAGED book keeps its picker on the card face: choosing a machine
            while nothing is committed is the whole point of staging it
            (docs/PENDING-QUEUE-AND-GPU-DIAL.md §2), and a staged card in the
            Pending column has no lane heading above it to say the answer.

            An ASSIGNED book still shows a read-only CHIP: a job finishes on the
            machine it started on (§4.3), and the chip says so where the picker
            would have been rather than leaving the fact to the lane alone.
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
            } @else if (plan.travels && plan.waitForResolved.length > 0) {
              <div class="venue-row">
                <span class="venue-word">Runs on</span>
                <span class="runs-on" title="A book finishes on the machine it started on.">
                  <span class="dot" aria-hidden="true"></span>{{ plan.waitForResolved.join(' + ') }}
                </span>
              </div>
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
                    (click)="stopBookAsked(plan, lane)"
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
                      ? 'Put this book at the front of the whole queue — the engine claims work from the top.'
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
                    [title]="lockedReason(plan) ?? 'More actions for this book'"
                    (click)="toggleMenu(plan, $event)"
                  >⋯</button>
                  @if (menuFor() === plan.key) {
                    <div class="menu" role="menu">
                      <!-- RUN ON… — the keyboard's door to the pin, and the
                           precise one. Everything a drag from Pending onto a
                           lane does, this row does: it is the same
                           'chooseWaitFor' on the same book, and the card simply
                           appears under the machine it now names. Drag is an
                           accelerator, never the only way to say this. -->
                      @if (plan.travels && plan.waitForResolved.length === 0) {
                        <div class="menu-pick" (click)="$event.stopPropagation()">
                          <span class="k">Run on…</span>
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
                      <!-- WHY THIS BOOK CANNOT BE DRAGGED, said where the hand
                           that failed to drag it will look next. A book that
                           holds a card is finishing on the machine it started
                           on (§4.3); moving it is not a thing the engine can
                           do, and a grip that silently refused would read as a
                           broken page. -->
                      @if (lockedReason(plan); as why) {
                        <p class="menu-note">{{ why }}</p>
                      }
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

    /* THE PAGE NO LONGER SCROLLS — its two columns do (Owen, 2026-09-20:
       *"i think the pending list should stretch to the bottom of the tab. like
       a sidebar"*).

       While '.page' owned 'overflow-y', "the bottom of the tab" was not a place
       anything could reach: every column was as tall as its own contents and
       the page grew to the tallest of them. So the page is now a FIXED-HEIGHT
       flex column that clips, '.layout' inside it takes the whole remainder,
       and the scroll is pushed down one level to the two things that actually
       have lists in them — the pending column and the floor. Below 960px this
       is all undone and the page scrolls again (see NARROW). */
    .page {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      padding: 4px 20px 14px;
      background: var(--bg-base);
    }

    /* ── The queue page's own toolbar row ──────────────────────────────────
       Matching 'desktop-toolbar' exactly where it can — same ground, same
       bottom rule, same left padding — because it sits where that component
       sits on every other page and must not read as a different chrome. What
       it adds is the LABELLED state: a word, a pill, and a caption that
       changes with the state. */
    .qbar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
      padding: 8px 12px;
      background: var(--bg-toolbar);
      border-bottom: 1px solid var(--border-subtle);
      flex-wrap: wrap;
    }

    .qstate { display: flex; align-items: center; gap: 10px; min-width: 0; }

    .qword {
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--text-tertiary);
    }

    .qcaption {
      font-size: 0.75rem;
      color: var(--text-muted);
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .qspacer { flex: 1; }

    .qslots {
      font-size: 0.6875rem;
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    /* A REAL RULE between the state control and Halt (Owen's mockup). They are
       not siblings: one says whether the queue admits work, the other cancels
       what is on the cards right now, and side by side with nothing between
       them the second reads as the third position of the first. */
    .qrule {
      width: 1px;
      height: 22px;
      background: var(--border-default);
      flex: none;
    }

    /* Halt, outlined in the danger colour and never filled: filled red is what
       this page uses for a failure that already happened. */
    .btn.halt {
      border-color: var(--color-danger);
      color: var(--color-danger);
      font-weight: 600;
    }
    .btn.halt:hover { background: var(--warning-bg); color: var(--color-danger); }

    .qicon {
      font-family: inherit;
      font-size: 0.9375rem;
      line-height: 1;
      width: 30px;
      height: 28px;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      flex: none;
    }
    .qicon:hover { color: var(--text-primary); border-color: var(--border-strong); }

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
       Finished reads as "<band> · <count> — <what that means>", and
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

    /* CPU — a book that travels nowhere, sitting in Pending with the books that
       are waiting for a card. The tag is the difference, and it is stated in
       the same shape as Staged so the two read as one vocabulary. */
    .cpu-tag {
      flex: none;
      margin-left: 8px;
      font-size: 0.5625rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-secondary);
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
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

    /* RUN ON… — a picker inside the menu, which is the keyboard's door to the
       pin a drag makes. Not a menu-item: it does not act on click, it holds a
       control, so it gets the row's padding and none of its hover. */
    .menu-pick {
      display: grid;
      gap: 5px;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .menu-pick .k {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* WHY a book cannot be moved. A sentence, not an entry — there is nothing
       to press, and a greyed-out entry would invite the press anyway. */
    .menu-note {
      margin: 0;
      padding: 8px 10px;
      font-size: 0.6875rem;
      line-height: 1.45;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-subtle);
    }

    /* The card holding an open menu comes forward. Cards are stacked in
       document order, so without this the NEXT book's card paints over the
       menu of the one above it. */
    .card:has(.menu) { z-index: 5; }

    /* ── A card inside a 300px lane ────────────────────────────────────────
       The two-column book card is a page-width object: a fluid book on the
       left and a 300px decision column on the right. In the Pending sidebar
       and inside a lane it has no such width, so the decision stacks under the
       book it is about — the same thing the 760px media query does to the
       page-width card, decided by WHERE the card is rather than by the
       viewport, because a narrow card can sit on a wide screen. */
    .card.narrow .book-head {
      grid-template-columns: minmax(0, 1fr);
      gap: 8px;
      padding: 9px 10px 9px 26px;
    }
    .card.narrow .venue-word { width: auto; }
    .card.narrow .chain { padding: 0 10px 8px; }
    /* The chain row wraps instead of trying to hold four columns in 280px:
       name on one line, then the reason and the numbers under it. 'justify-self'
       comes off .cright because there is no flexible column left to push it
       against. */
    .card.narrow .cstep { grid-template-columns: 14px minmax(0, 1fr); row-gap: 3px; }
    .card.narrow .cmid, .card.narrow .cright { grid-column: 2; }
    .card.narrow .cright { justify-self: start; flex-wrap: wrap; }
    .card.narrow .cstep.staged-step { grid-template-columns: 14px minmax(0, 1fr); }
    /* The menu is 262px wide and the card is barely more; hung off the LEFT it
       stays inside the lane instead of over the one beside it. */
    .card.narrow .menu { right: auto; left: 0; min-width: 0; width: 260px; }

    /* NARROW: the decision column stops being a column. Three buttons and a
       picker beside a title is a wrap waiting to happen; stacked, it is a
       block under the book it is about. */
    @media (max-width: 760px) {
      .book-head { grid-template-columns: minmax(0, 1fr); }
      .venue-word { width: auto; }
    }

    /* ── The floor ─────────────────────────────────────────────────────────
       Owen, 2026-09-20: *"maybe pending is along the left side and goes to the
       bottom, like a side bar… the two cpu slots sit at the top, and then the
       GPU slots are in a grid underneath"*.

       The sidebar is a FIXED column and the floor takes what is left —
       minmax(0, 1fr) so a long book title inside a lane ellipsises instead of
       widening the whole grid. */
    .layout {
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      /* ONE ROW, minmax(0, 1fr) — the row that decides whether this works.
         An 'auto' row is sized to its tallest item, so a floor full of lanes
         would make the row taller than the grid box, spill past the clipped
         page, and leave both columns' own overflow rules with nothing to do.
         Pinned to the container's height, the two panes are shorter than their
         contents and their scrollbars are the ones that appear. */
      grid-template-rows: minmax(0, 1fr);
      gap: 16px;
      /* STRETCH, not 'start'. Both columns are full-height panes now: the
         aside has a drawer that has to sit at ITS bottom, not at the bottom of
         whatever it happens to contain. */
      align-items: stretch;
      flex: 1;
      min-height: 0;
      margin-top: 16px;
    }

    /* THE SIDEBAR IS A FULL-HEIGHT COLUMN OF TWO PARTS: the pending list,
       which takes everything that is left and scrolls inside itself, and the
       Finished drawer docked at its foot. It is not sticky and has no
       max-height of its own — it is exactly as tall as the floor beside it,
       which is what "stretches to the bottom of the tab" means.

       It does NOT scroll. A scroller here would scroll the drawer off the
       bottom, and the drawer is the one thing on this column that must be
       where the hand expects it. */
    .sidebar {
      display: flex;
      flex-direction: column;
      gap: 12px;
      min-width: 0;
      min-height: 0;
    }

    /* PENDING, DRAWN LIKE A SLOT. It is the answer "any machine", and a book in
       it is queued exactly as hard as one pinned to a card — so it gets a
       slot's frame rather than a list's. Accent-topped like a GPU lane because
       it is where the GPU work goes when nobody has named a machine. */
    .slotcol {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-top: 2px solid var(--accent);
      border-radius: 8px;
      padding: 0 11px 12px;
      /* THE SCROLLING MIDDLE. It takes the sidebar's leftover height, so
         opening the drawer below shortens this list rather than pushing it
         off the screen.

         'min-height: 160px' does two jobs at once and both are wanted: it is
         a floor, so an empty queue still draws a column and not a hairline,
         and — because it is not 'auto' — it is also what lets this flex item
         be SHORTER than its contents, which is the whole reason the scrollbar
         lands here instead of on the page. */
      flex: 1;
      min-height: 160px;
      overflow-y: auto;
    }

    /* STICKY INSIDE ITS OWN SCROLLER. The section is the drop list AND the
       scroller (CDK auto-scrolls the drop list's own element, and only that
       one), so the header cannot be lifted out to a fixed sibling — it stays
       a child and pins itself. Opaque, because pending cards pass underneath
       it. The 11px of top padding moved here from the section so the sticky
       edge is flush with the accent rule above it. */
    .slot-head {
      position: sticky;
      top: 0;
      z-index: 2;
      padding-top: 11px;
      margin-bottom: 10px;
      background: var(--bg-surface);
    }

    .slot-line { display: flex; align-items: baseline; gap: 8px; }

    .slot-line h2 {
      margin: 0;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--text-tertiary);
    }

    .slot-count {
      margin-left: auto;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    .slot-where {
      margin-top: 3px;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .slot-pill {
      display: inline-block;
      margin-top: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.625rem;
      font-weight: 600;
      background: var(--accent-subtle);
      color: var(--accent);
    }

    .slot-free {
      margin: 6px 0 0;
      font-size: 0.6875rem;
      line-height: 1.5;
      color: var(--text-muted);
    }

    /* THE RIGHT COLUMN SCROLLS ON ITS OWN. Needs-you, the tiles, the lanes
       and the empty state all live here, and none of them may move the
       sidebar: Owen's whole point is that Pending holds its place while the
       machines are read. */
    .floor {
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
      /* Room for its scrollbar so a lane's right edge is not sat on. */
      padding-right: 4px;
    }

    /* The first band in a column that starts at the top of the pane needs no
       20px of air above it. */
    .floor > .band:first-of-type { margin-top: 0; }

    /* ── Local slots ───────────────────────────────────────────────────────
       TILES, two across, because a CPU slot has a fraction of a lane's content
       and no queue behind it — nothing is ever pinned to one. */
    .tiles {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .lcard.tile { border-top-color: var(--border-default); }

    .tile-head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 8px;
    }

    .tile-where {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .tile-slot {
      margin-left: auto;
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    /* ── GPU lanes ─────────────────────────────────────────────────────────
       auto-fill at a 300px floor: two servers share the width, six wrap into
       rows, and a bench that grows needs no arithmetic here. This replaced
       'benchRows' on this section — that function cut a FLAT list of slots into
       Owen's 1/2/3-per-row shape, and a lane is no longer a slot-sized card: it
       carries a header, an occupant and a queue of its own. */
    .lanes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 12px;
      align-items: start;
    }

    .lane {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-top: 2px solid var(--accent);
      border-radius: 8px;
      padding: 10px 12px 12px;
      min-width: 0;
    }

    /* SWITCHED OFF or NOT ANSWERING: greyed, still legible, still there. Owen:
       *"if a crucible slot is unchecked, it grays it out until it's
       re-checked/re-enabled."* The lane HEADER keeps full contrast, because the
       switch that undoes it lives there and a greyed-out control is one you
       cannot find. */
    .lane.off, .lane.down { border-top-color: var(--border-default); }
    .lane.off .on-card, .lane.down .on-card,
    .lane.off .pinned, .lane.down .pinned { opacity: 0.55; }

    .lane-head {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border-subtle);
    }

    /* Owen: *"each one should have an enable/disable checkbox above it with its
       name."* Big enough to hit without aiming — it is the control that decides
       whether a machine works at all. */
    .lane-switch {
      display: flex;
      align-items: center;
      gap: 7px;
      cursor: pointer;
      user-select: none;
      min-width: 0;
    }
    .lane-switch input { width: 16px; height: 16px; cursor: pointer; accent-color: var(--accent); }
    .lane-switch input:disabled { cursor: progress; }

    .lane-name {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .lane-slot {
      font-size: 0.6875rem;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    /* THE STATE WORD. Five facts the snapshot already states, said in one place
       so a lane cannot look busy and idle at once: off, unreachable, finishing,
       waiting for the card, rendering/assembling, idle. The tone is the colour;
       the word is the answer. */
    .lane-state {
      margin-left: auto;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.625rem;
      font-weight: 600;
      white-space: nowrap;
      background: var(--bg-subtle);
      color: var(--text-tertiary);
    }
    .lane-state .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
    .lane-state.live { background: var(--accent-subtle); color: var(--accent); }
    .lane-state.warn { background: var(--warning-bg); color: var(--warning-text); }
    .lane-state.bad { background: var(--warning-bg); color: var(--color-danger); }

    .on-card { padding-top: 10px; }

    .on-card-label {
      font-size: 0.625rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 7px;
    }

    .pinned {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px dashed var(--border-subtle);
      /* The drop target has to be catchable even when the lane is empty: a
         book cannot be pinned to a machine whose queue is a 0px strip. */
      min-height: 72px;
    }

    .pinned-head {
      font-size: 0.625rem;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 7px;
    }

    .pinned-none, .drop-note {
      margin: 0 0 8px;
      font-size: 0.6875rem;
      line-height: 1.45;
      color: var(--text-muted);
    }

    /* WHAT A DROP HERE WOULD MEAN, said inside the target while the hand is
       over it. A refusal reads in the warning tone and still SAYS the reason —
       'cdkDropListEnterPredicate' refuses the drop silently, and a target that
       just will not take a card with no sentence attached is the failure this
       whole page exists to remove. */
    .drop-note {
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--accent-subtle);
      color: var(--accent);
      font-weight: 600;
    }
    .drop-note.no { background: var(--warning-bg); color: var(--warning-text); }

    .fold {
      font-family: inherit;
      font-size: 0.6875rem;
      font-weight: 600;
      padding: 4px 0;
      border: 0;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
    }
    .fold:hover { color: var(--accent); }

    /* ── The step ladder on a busy card ────────────────────────────────────
       Where this book has got to in its own chain, at a glance: a done rung, a
       moving one with its bar, and the rest waiting. */
    .ladder { display: grid; gap: 4px; margin-top: 9px; }

    .rung {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) 46px 40px;
      align-items: center;
      gap: 7px;
      font-size: 0.6875rem;
      color: var(--text-muted);
    }
    .rung.now { color: var(--text-primary); }
    .rung .rdot {
      width: 7px; height: 7px; border-radius: 50%;
      border: 1px dashed var(--text-muted);
    }
    .rung.done .rdot { background: var(--text-tertiary); border-style: solid; }
    .rung.now .rdot { background: var(--accent); border: 0; }
    .rname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rval { text-align: right; font-variant-numeric: tabular-nums; }
    .rung .bar.thin { height: 4px; margin: 0; }

    /* ── NARROW ────────────────────────────────────────────────────────────
       Below ~960px the sidebar stops being a sidebar: it stacks ABOVE the
       machines, because Pending is the thing you add to and the machines are
       the thing you watch.

       AND THE PANES GO BACK TO BEING ONE PAGE. Full-height columns are a
       two-column idea; stacked, they would give a phone-width screen three
       scrollbars inside each other and a drawer pinned to the bottom of a
       block halfway down it. So '.page' takes its 'overflow-y' back and every
       inner scroller is released — the same normal flow this page had before
       the sidebar grew. */
    @media (max-width: 960px) {
      .page {
        display: block;
        overflow-y: auto;
        padding-bottom: 40px;
      }
      .layout {
        grid-template-columns: minmax(0, 1fr);
        grid-template-rows: auto;
        align-items: start;
        flex: none;
        min-height: auto;
      }
      .sidebar { display: block; min-height: auto; }
      .slotcol {
        flex: none;
        overflow: visible;
        padding-top: 11px;
      }
      .slot-head { position: static; padding-top: 0; }
      .floor { overflow: visible; padding-right: 0; }
      .finished { margin-top: 12px; }
      /* Stacked, the drawer has no column to take a share of, so it takes a
         share of the window instead. */
      .finished.open { max-height: none; }
      .finished.open .fin-clip { max-height: 60vh; }
      .tiles { grid-template-columns: minmax(0, 1fr); }
    }

    /* ── Pending ───────────────────────────────────────────────────────────
       Dashed, because nothing about a staged book is committed: it is a plan on
       the bench, not work in the queue. Otherwise the SAME card a released book
       gets, so the press between them is the only difference a reader has to
       hold. */

    .card.staged {
      border-style: dashed;
      border-color: var(--border-default);
    }

    .cstep.staged-step { grid-template-columns: 16px minmax(0, 260px) 1fr; }

    .cname.plain { color: var(--text-tertiary); cursor: default; }

    /* ── Reordering ────────────────────────────────────────────────────────
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
       dragged must not say it can — a drop still settling. The selector follows
       the lists, which are now the Pending column and each lane rather than one
       band. */
    .cdk-drop-list-disabled .grip { cursor: default; }

    .cdk-drag-preview .book-head { background: var(--bg-elevated); }

    /* A card lifted out of a 300px lane keeps its narrow shape in flight: the
       preview is re-parented to the body, where the 'card.narrow' rules still
       apply because they are class-based and the class rides with it. */
    .cdk-drag-preview .grip { opacity: 0.65; }

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

    /* ── The slot card ─────────────────────────────────────────────────
       The shared frame for a local TILE and for the occupant area inside a GPU
       lane. The per-slot switch moved onto the lane header (it belongs to the
       MACHINE, not to the card drawn inside it), and the row of small-caps slot
       words moved there with it — a lane says its own name, ordinal and state
       in one line now, so the card below is nothing but the work. */

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

    /* ── Stop, positioned like an X ────────────────────────────────────────
       Owen, 2026-09-20: *"put Stop in the top right, positioned like its an X.
       and keep it short"*. Top-right of the busy card, the size and place a
       close button would take, and two words long. It is a real destructive-ish
       act, so it wears the stop colours on hover rather than the close glyph's
       silence — but it is NOT red at rest: red at rest on the one card that is
       working reads as an error. */
    .stop-x {
      flex: none;
      align-self: flex-start;
      font-family: inherit;
      font-size: 0.625rem;
      font-weight: 600;
      line-height: 1;
      padding: 4px 7px;
      border-radius: 5px;
      border: 1px solid var(--border-default);
      background: var(--bg-surface);
      color: var(--text-tertiary);
      cursor: pointer;
      white-space: nowrap;
    }

    .stop-x:hover {
      border-color: var(--color-danger);
      background: var(--warning-bg);
      color: var(--color-danger);
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

    /* ── Finished: the drawer at the sidebar's foot ────────────────────────
       It replaced a '<table class="ftable">' six columns wide at the bottom of
       the page. Nothing of that is kept — a table is a shape for comparing
       rows, and these rows are not compared, they are a book's own history.

       Docked, never scrolled with the list above it: it is 'flex: none' in the
       sidebar's column, which is what puts it AT the bottom rather than after
       whatever Pending happens to contain. */
    .finished {
      flex: none;
      display: flex;
      flex-direction: column;
      min-height: 0;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;
    }

    /* ROUGHLY THE LOWER 45% OF THE SIDEBAR, and a real ceiling rather than a
       guess in viewport units: the aside is a stretched grid item with a
       definite height, so a percentage here is a percentage of the column it
       is docked in. It is a MAXIMUM — two finished books draw two books tall,
       not a half-empty drawer — and everything above it keeps the rest. */
    .finished.open {
      flex: 0 1 auto;
      max-height: 45%;
    }

    .fin-head { flex: none; }

    .fin-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 8px 0 0;
    }

    .fin-step { min-width: 0; }

    .fin-toggle {
      font-family: inherit;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 9px 4px 9px 10px;
      border: 0;
      background: transparent;
      color: var(--text-tertiary);
      cursor: pointer;
      text-align: left;
      font-size: 0.6875rem;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
    }

    .fin-toggle:hover { color: var(--text-primary); }

    /* A CHEVRON THAT TURNS, so the header says which way the drawer will go
       before it is pressed. */
    .chev {
      display: inline-block;
      font-size: 0.625rem;
      line-height: 1;
      color: var(--text-muted);
      transition: transform 0.22s ease;
      flex: none;
    }

    .finished.open .chev { transform: rotate(90deg); }

    .fin-word { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .fin-count {
      font-size: 0.8125rem;
      font-weight: 600;
      letter-spacing: 0;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
      flex: none;
    }

    /* SAID ONLY WHEN IT IS TRUE, and in the danger colour, because "0 failed"
       is a sentence nobody needs and a number in red that means nothing. */
    .fin-bad {
      margin-left: auto;
      font-size: 0.625rem;
      font-weight: 600;
      letter-spacing: 0;
      text-transform: none;
      color: var(--color-danger);
      flex: none;
    }

    .fin-clear { flex: none; }

    /* 0fr → 1fr: the row itself animates, so the drawer slides to whatever its
       content is instead of to a number this stylesheet had to guess. */
    .fin-body {
      flex: 0 1 auto;
      min-height: 0;
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows 0.22s ease;
    }

    .finished.open .fin-body { grid-template-rows: 1fr; }

    /* THE CLIP IS ALSO THE SCROLLER. Closed, the 0fr row gives it no height
       and it hides what is inside; open and capped by the 45%, the 1fr row
       hands it a definite height that is shorter than its contents, and the
       scrollbar lands exactly there. Open and NOT capped — a short day's
       history — it is content-tall and never scrolls at all. */
    .fin-clip { min-height: 0; overflow: hidden; }
    .finished.open .fin-clip { overflow: hidden auto; }

    .fin-list { padding: 2px 9px 9px; }

    /* ── A finished BOOK, as a block ───────────────────────────────────────
       Owen: *"the completed jobs can be blocks, just like they were when they
       were pending."* Same '.card.narrow' family, so a book that finished
       reads as the same object it was while it waited — one card, one cover,
       one title — and the only difference is that its chain is history. */
    .fin-card { margin-bottom: 8px; }
    .fin-card:last-child { margin-bottom: 0; }
    .fin-card.on { border-color: var(--border-default); }

    .fin-block {
      font-family: inherit;
      width: 100%;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 10px;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }

    .fin-block:hover h3 { color: var(--accent); }
    .fin-block .min { flex: 1; }
    .fin-block h3 {
      margin: 0;
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .fin-block .sub { font-size: 0.6875rem; }
    .fin-block .pill { flex: none; }

    /* ── The steps inside a block ──────────────────────────────────────────
       THE RUNNING CARD'S LADDER, reused: '.rung' with its dot and its
       ellipsising name, because "what this book ran, in order" is the same
       readout and a second drawing of it would drift from the first. What
       changes is the last column — a live rung ends in a percentage, a
       finished one ends in what it turned out to be. */
    .fin-ladder {
      gap: 7px;
      margin: 0;
      padding: 0 10px 9px 10px;
      border-top: 1px solid var(--border-subtle);
      padding-top: 8px;
    }

    .fin-rung { grid-template-columns: 10px minmax(0, 1fr) auto; }

    /* A cancelled or failed step keeps the dashed, unfilled dot a waiting rung
       has: it did not finish, and the ladder should not say it did. */
    .mk {
      justify-self: end;
      flex: none;
    }

    /* The measurements under the step's own name, indented to the dot's
       column, so a 320px sidebar reads down rather than across. */
    .fin-meta {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 5px;
      margin: 2px 0 0 17px;
      font-size: 0.625rem;
      color: var(--text-muted);
    }

    .fin-num { font-variant-numeric: tabular-nums; }

    .fin-file {
      font-size: 0.625rem;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

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
      /* The drawer still opens and closes — it just stops sliding there. */
      .fin-body, .chev { transition: none; }
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

  /**
   * How many finished BOOKS ended badly — counted the same way the header's
   * total is, so "3 · 1 failed" means one of those three books. A step count
   * here would disagree with the number beside it, and a book with two failed
   * steps is still one book that needs looking at.
   */
  readonly finishedFailed = computed(
    () => this.finishedBlocks().filter(b => b.status === 'failed').length);

  /** Whether the Finished drawer is open. Remembered per machine. */
  readonly finishedOpen = signal<boolean>(readFinishedOpen());

  /** Which finished book has its steps showing. One at a time. */
  readonly openFinished = signal<string | null>(null);

  /**
   * TODAY'S FINISHED STEPS, GROUPED INTO ONE BLOCK PER BOOK.
   *
   * Two passes, and both are needed:
   *
   *  - BY jobId first, because that is the engine's own idea of "these steps
   *    belong together" and it is exact. Every step of one narration run
   *    carries the same job id whatever its label says.
   *
   *  - THEN BY TITLE, because a book's work is not one job. A read that was
   *    converted, then simplified, then narrated is three jobs against one
   *    book, and drawing it as three blocks would put the same cover and the
   *    same title on screen three times — the exact complaint about the table,
   *    reshaped into cards. The title is what a person calls the book, so it
   *    is what the merge is on; case and surrounding space are ignored because
   *    they are typing, not identity.
   *
   * The engine hands these over NEWEST FIRST ('finishedSince'), so the block
   * order here is "most recently finished book first" — and the runs inside
   * each block are reversed into the order they actually ran, which is the
   * only order a chain reads in.
   */
  readonly finishedBlocks = computed<readonly FinishedBlock[]>(() => {
    const byJob = new Map<string, FinishedBlock>();
    const byTitle = new Map<string, FinishedBlock>();
    const order: FinishedBlock[] = [];

    for (const run of this.finished()) {
      const titleKey = run.title.trim().toLowerCase();
      let block = byJob.get(run.jobId) ?? byTitle.get(titleKey);
      if (!block) {
        block = {
          key: run.jobId,
          title: run.title,
          cover: null,
          runs: [],
          status: 'done',
        };
        order.push(block);
        byTitle.set(titleKey, block);
      }
      byJob.set(run.jobId, block);
      block.runs.push(run);
      // The cover is the book's, not the step's, so the first job that can
      // answer answers for all of them.
      if (block.cover === null) block.cover = this.tray.coverForJobId(run.jobId);
    }

    for (const block of order) {
      // THE WORST THING THAT HAPPENED WINS. A book whose narration succeeded
      // and whose assembly failed did not have a good day, and a green pill on
      // it would be the page lying about work that needs attention.
      block.status = block.runs.some(r => r.status === 'failed')
        ? 'failed'
        : block.runs.some(r => r.status === 'cancelled')
          ? 'cancelled'
          : 'done';

      block.runs.sort((a, b) => finishedMs(a) - finishedMs(b));
      const last = block.runs[block.runs.length - 1];
      block.finishedAt = last?.finishedAt;
    }

    return order;
  });

  /**
   * OPEN OR CLOSED, and remembered. A write that throws costs the memory of
   * the choice and nothing else — the drawer still opens.
   */
  toggleFinished(): void {
    const next = !this.finishedOpen();
    this.finishedOpen.set(next);
    try {
      localStorage.setItem(FINISHED_OPEN_KEY, next ? '1' : '0');
    } catch {
      // A preference is not worth failing a page for.
    }
  }

  /** One book's steps at a time; pressing the open one closes it. */
  toggleFinishedBlock(block: FinishedBlock): void {
    this.openFinished.set(this.openFinished() === block.key ? null : block.key);
  }

  /** The toolbar's half of the shared Running / Paused wording. */
  readonly queueState = QUEUE_STATE_CONTROL;

  /** The sentence under the pill — what the state the queue is IN does. */
  stateCaption(): string {
    return this.tray.isRunning()
      ? QUEUE_STATE_CONTROL.running.caption
      : QUEUE_STATE_CONTROL.paused.caption;
  }

  /**
   * "GPU 1 of 2 busy · CPU 0 of 2" — the readout the old "On the bench"
   * heading carried, moved to the toolbar now that the bench is two bands and
   * neither can honestly claim the whole count.
   *
   * GPU counts the SERVER lanes, because that is what a GPU slot is (Owen,
   * 2026-09-20: *"gpu slots are crucible servers"*) — the in-app aligner's own
   * GPU row is this machine's and is counted with the local slots, where it is
   * drawn.
   */
  slotSummary(): string {
    const gpu = this.gpuLanes();
    const local = this.localLanes();
    const busy = (lanes: readonly LaneView[]) => lanes.filter((l) => l.occupant !== null).length;
    return `GPU ${busy(gpu)} of ${gpu.length} busy · CPU ${busy(local)} of ${local.length}`;
  }

  /** How many BOOKS Halt would stop. Books, not steps: it is a book's card. */
  runningBooks(): number {
    return this.visiblePlans().filter((plan) => this.runningSteps(plan) > 0).length;
  }

  /**
   * THE HARD STOP: latch off AND every running step cancelled. The soft one —
   * the latch by itself — is Running / Paused.
   *
   * Halt is NOT that latch and never was (Owen, 2026-08-29): it takes the card
   * back NOW. One button wearing the word Pause while doing the halt is how an
   * hour of denoise got cancelled to prevent the NEXT hour of denoise.
   */
  halt(): void {
    this.report(this.queueService.stopQueue());
  }

  /**
   * Re-read the queue from main.
   *
   * The server list is NOT refreshed separately and needs no door of its own:
   * it rides the snapshot this call re-reads (`waitForChoices`).
   */
  refresh(): void {
    this.report(this.queueService.refreshFromBackend());
  }

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

  /**
   * WRITE THE BOOK'S ANSWER, and let a refusal out.
   *
   * The one door: the picker, the ⋯ menu's *Run on…*, a drag onto a lane and a
   * drag back to Pending all come through here, so a pin made by hand and a pin
   * made by dragging cannot be two different acts. It THROWS, because a drag
   * that was refused must not go on to reorder the queue for a pin that never
   * happened (see `applyMove`); `chooseWaitFor` below is the same call with the
   * refusal put on screen, which is what a bare picker wants.
   */
  private async setPlanServer(plan: BookPlan, value: string): Promise<void> {
    // Every run of the book, because the book is the unit the answer is about.
    for (const jobId of plan.jobIds) await this.queueService.setWaitFor(jobId, value);
  }

  async chooseWaitFor(plan: BookPlan, value: string): Promise<void> {
    try {
      await this.setPlanServer(plan, value);
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
  // Send to queue is not refused while paused; a book added lands in Pending
  // or on its machine's lane and waits there. That is why this needed no engine change at all: `pump()`
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

  // ── The floor: which lane draws what ─────────────────────────────────────
  //
  // Every one of these is a CUT of `tray.sections()`, which is `benchSections`
  // plus the decoration only a renderer can add. Nothing here re-derives a lane
  // or decides where work goes — the scheduler owns that, and a second opinion
  // drawn on the page is how a surface comes to disagree with the engine it is
  // reporting on.
  //
  // `benchRows` is gone from this page. It cut a FLAT list of slots into Owen's
  // 1/2/3-per-row shape (2026-09-15) and is still the right answer for a list of
  // slot-sized cards — the tray still draws one. A LANE is not a slot-sized
  // card: it carries a header, an occupant and a queue of its own, so the
  // section is a CSS auto-fill grid instead and the arithmetic has nowhere to
  // apply.

  /**
   * THE CRUCIBLE SERVERS' LANES — one per registered engine, in rank order.
   *
   * Owen, 2026-09-20: *"gpu slots are crucible servers, and in this case we have
   * 2, so they should be slots 1 of 2 and 2 of 2."* So the GPU section is the
   * `gpu` group MINUS the lanes that have no server behind them: `local-work`
   * (this app's CPU pair, which can hold a GPU row only in theory) and
   * `local-longform-align` (the in-app aligner). That is the same test
   * {@link switchOf} makes about the switch, and for the same reason — a lane
   * with no registered server is not a machine you can be told to stop sending
   * work to, and it is not a slot you can pin a book to either.
   */
  readonly gpuLanes = computed<LaneView[]>(() =>
    this.tray.sections()
      .filter((section) => section.group === 'gpu')
      .flatMap((section) => section.lanes)
      .filter((lane) => this.switchOf(lane) !== null));

  /**
   * WHAT THIS MACHINE DOES FOR ITSELF — the `local-work` CPU pair, plus the
   * in-app aligner's GPU row when it is on the bench.
   *
   * Drawn as tiles above the lanes and NOT as drop targets, because nothing is
   * ever pinned to one: assembly, muxing and the passes travel nowhere (crucible
   * `docs/PHASE7-LANES.md` §4), so the work simply arrives here. A book of those
   * waits in Pending tagged "CPU" rather than in a queue behind a tile.
   */
  readonly localLanes = computed<LaneView[]>(() =>
    this.tray.sections()
      .filter((section) => section.group === 'gpu' || section.group === 'cpu')
      .flatMap((section) => section.lanes)
      .filter((lane) => lane.resource !== 'gpu' || this.switchOf(lane) === null));

  /** The `cloud` sections, with the bench's own words, drawn only when present. */
  readonly cloudSections = computed<BenchSectionView[]>(() =>
    this.tray.sections().filter((section) => section.group === 'cloud'));

  /** A lane's identity for `track`: machine, pool and slot together. */
  laneKey(lane: LaneView): string {
    return `${lane.setId}|${lane.resource}|${lane.index}`;
  }

  /** "CPU slot 2 of 2" — the tile's own pool position, which IS `index`/`of`. */
  localSlotLabel(lane: LaneView): string {
    return `${lane.resource === 'gpu' ? 'GPU' : 'CPU'} slot ${lane.index} of ${lane.of}`;
  }

  /**
   * WHAT A LANE IS DOING, in one word, from facts the snapshot already states.
   *
   * The order is the order a person needs them in. `disabled` first because a
   * switched-off machine is not being asked anything, so nothing else said
   * about it would be a measurement. `down` next, because an unreachable
   * machine's idleness is not idleness. Then the work, then the reasons a free
   * lane is free.
   */
  laneState(lane: LaneView): { word: string; tone: string } {
    if (lane.disabled) return { word: 'off', tone: 'off' };
    if (lane.down) return { word: 'unreachable', tone: 'bad' };
    const occupant = lane.occupant;
    if (occupant) {
      const assembling = /assembl/i.test(occupant.verb) || /assembl/i.test(occupant.label);
      return { word: assembling ? 'assembling' : 'rendering', tone: 'live' };
    }
    if (lane.retiring) return { word: 'finishing', tone: 'warn' };
    if (lane.hold) return { word: 'waiting for the card', tone: 'warn' };
    return { word: 'idle', tone: 'off' };
  }

  // ── Which books belong to which lane ─────────────────────────────────────

  /**
   * THE SERVER A RELEASED BOOK IS BEHIND, or null for "any machine".
   *
   * `waitForResolved` wins because it is where the work ACTUALLY went and the
   * answer is no longer a question (§4.3 — a job finishes on the machine it
   * started on). Otherwise the book's own `waitFor`, with `any` and the two
   * honest absences (`null`, nothing recorded) all meaning the same thing here:
   * it is waiting for the first free machine, which is the Pending column.
   */
  private serverOf(plan: BookPlan): string | null {
    const resolved = plan.waitForResolved[0];
    if (resolved !== undefined) return resolved;
    const says = plan.waitFor[0];
    if (says === undefined || says === null || says === 'any') return null;
    return says;
  }

  /** The job ids currently holding a slot, anywhere on the bench. */
  private readonly onSlotJobIds = computed<ReadonlySet<string>>(() => {
    const ids = new Set<string>();
    for (const lane of this.tray.lanes()) {
      if (lane.occupant) ids.add(lane.occupant.jobId);
    }
    return ids;
  });

  /**
   * EVERY RELEASED BOOK, FILED UNDER THE MACHINE IT NAMES.
   *
   * Keyed by `setId`, and only for servers that actually have a lane: a book
   * naming a server that has since been removed must not vanish, so it falls
   * through to Pending (see {@link pendingColumn}) rather than into a map entry
   * nothing draws.
   *
   * A book that is ON a slot is not ALSO in the queue behind it. It is drawn
   * once, as the lane's occupant, because two cards for one book reads as two
   * books.
   */
  private readonly pinnedByLane = computed<ReadonlyMap<string, BookPlanView[]>>(() => {
    const lanes = new Set(this.gpuLanes().map((lane) => lane.setId));
    const busy = this.onSlotJobIds();
    const out = new Map<string, BookPlanView[]>();
    for (const plan of this.visiblePlans()) {
      const server = this.serverOf(plan);
      if (server === null || !lanes.has(server)) continue;
      if (plan.jobIds.some((jobId) => busy.has(jobId))) continue;
      const list = out.get(server);
      if (list === undefined) out.set(server, [plan]);
      else list.push(plan);
    }
    return out;
  });

  /** Every book pinned to this lane, in the engine's own order. */
  lanePinned(lane: LaneView): BookPlanView[] {
    return this.pinnedByLane().get(lane.setId) ?? [];
  }

  /** The ones actually drawn — the first {@link PINNED_FOLD} unless unfolded. */
  laneRows(lane: LaneView): BookPlanView[] {
    const all = this.lanePinned(lane);
    if (this.expandedLanes().has(lane.setId)) return all;
    return all.slice(0, PINNED_FOLD);
  }

  readonly pinnedFold = PINNED_FOLD;

  /** Lanes whose pinned queue the user has unfolded. Folded is the default. */
  readonly expandedLanes = signal<ReadonlySet<string>>(new Set());

  toggleLaneFold(lane: LaneView): void {
    const next = new Set(this.expandedLanes());
    if (next.has(lane.setId)) next.delete(lane.setId);
    else next.add(lane.setId);
    this.expandedLanes.set(next);
  }

  /**
   * THE PENDING COLUMN — everything waiting for ANY machine, in one list.
   *
   * Three kinds of book end up here and they are one kind to the reader: *this
   * is not behind a particular machine.*
   *
   *  - a released book that names no server, or names `any`;
   *  - a STAGED book, which has not been sent at all (its server is chosen here
   *    while nothing is committed — docs/PENDING-QUEUE-AND-GPU-DIAL.md §1-§3);
   *  - a book that TRAVELS NOWHERE, tagged "CPU": it runs on this machine's
   *    local slots and there is no card to pin it to.
   *
   * AND ANYTHING THE LANES DID NOT CLAIM. The filter is "not pinned to a lane
   * that exists, and not on a slot" rather than a list of the three cases
   * above, so a book naming a server that has since been unregistered lands
   * here instead of disappearing off the page. A queue page that can silently
   * stop drawing a queued book is worse than one that draws it in the wrong
   * column.
   *
   * Released first, staged after: the live queue is what a person watches; a
   * staged book is parked until they come back for it (Owen, 2026-09-19: *"put
   * pending at the bottom and active items/up next above it"* — the same
   * ordering, now down a column instead of down the page).
   */
  readonly pendingColumn = computed<PendingEntry[]>(() => {
    const busy = this.onSlotJobIds();
    const pinned = new Set<string>();
    for (const list of this.pinnedByLane().values()) for (const plan of list) pinned.add(plan.key);
    const released: PendingEntry[] = this.visiblePlans()
      .filter((plan) => !pinned.has(plan.key))
      .filter((plan) => !plan.jobIds.some((jobId) => busy.has(jobId)))
      .map((plan) => ({ plan, staged: false }));
    const staged: PendingEntry[] = this.tray.pending().map((plan) => ({ plan, staged: true }));
    return [...released, ...staged];
  });

  /** The released half of the column — the only part that has a queue order. */
  private pendingOrdered(): BookPlanView[] {
    return this.pendingColumn().filter((entry) => !entry.staged).map((entry) => entry.plan);
  }

  // ── Dragging a book onto a machine ───────────────────────────────────────
  //
  // Owen, 2026-09-20, on the shape this replaces: a list with a machine
  // dropdown made the reader reconstruct "which books are behind which
  // machine" from N separate answers. Dragging a card onto a lane IS the
  // answer, and it writes the same `waitFor` the dropdown wrote.
  //
  // THE ENGINE HAS ONE ORDER. There is no per-lane queue in `queue.json` —
  // `pump()` walks a single flat `jobs[]` from the front — so a lane-local drop
  // has to be translated into a statement about the global order. The rule is
  // the only one that survives a book being pinned anywhere:
  //
  //   the dropped book goes BEFORE the lane-neighbour that now follows it;
  //   dropped last in a lane, before the next global plan after that lane's
  //   last book; and with no neighbours at all, nowhere — the order is left
  //   exactly as it was.
  //
  // That last case is deliberate. Pinning a book to an EMPTY lane says nothing
  // about where it belongs in the queue, and sending it to the back (the other
  // plausible reading of "dropped last") would demote a book for the crime of
  // being given a free machine.

  /** The plan under the hand, while a drag is in flight. Null the rest of the time. */
  readonly dragging = signal<BookPlanView | null>(null);

  /** Which list the hand is over: a lane's `setId`, or {@link PENDING_LIST}. */
  readonly hoverList = signal<string | null>(null);

  readonly pendingList = PENDING_LIST;

  dragStarted(plan: BookPlanView): void {
    this.dragging.set(plan);
  }

  dragEnded(): void {
    this.dragging.set(null);
    this.hoverList.set(null);
  }

  clearHover(key: string): void {
    if (this.hoverList() === key) this.hoverList.set(null);
  }

  /**
   * A BOOK THAT HOLDS A CARD CANNOT BE MOVED, and this says why.
   *
   * `waitForResolved` is the engine's own record that the work WENT somewhere
   * (§4.3), and a running step is the same fact happening. Either way the
   * answer to "put it on the other machine" is not one the engine can give, so
   * the card carries no grip at all rather than a grip that silently refuses.
   * The sentence is on the ⋯ button's tooltip and inside the menu, which is
   * where a hand that failed to drag it looks next.
   */
  lockedReason(plan: BookPlan): string | null {
    if (!this.isLocked(plan)) return null;
    return 'This book holds a card. Stop it first; it keeps what it has finished.';
  }

  isLocked(plan: BookPlan): boolean {
    return plan.waitForResolved.length > 0
      || plan.steps.some((step) => step.status === 'running');
  }

  /**
   * WHY THIS LANE WILL NOT TAKE THIS BOOK, or null when it will.
   *
   * Every refusal is a fact the SNAPSHOT already states — the operator's switch,
   * the transport's last answer, the step module's own `travels`. Nothing is
   * re-measured here and nothing is invented: a page that decided for itself
   * whether a machine was reachable would be a second opinion about a decision
   * the scheduler has already made.
   */
  pinRefusal(lane: LaneView, plan: BookPlanView | null): string | null {
    if (plan === null) return null;
    if (!plan.travels) {
      return `${plan.title} runs on this machine's CPU slots. It cannot be pinned to a card.`;
    }
    if (this.isLocked(plan)) return this.lockedReason(plan);
    if (lane.disabled) {
      return `${lane.setLabel} is switched off. Switch it on to send work there.`;
    }
    if (lane.down) return `${lane.setLabel} is not answering — ${lane.down}`;
    return null;
  }

  /**
   * THE DROP PREDICATES. Stable arrow properties, not methods called from the
   * template: a predicate rebuilt on every change-detection pass would hand CDK
   * a new function mid-drag.
   *
   * The lane reads its refusal off its OWN `cdkDropListData`, so one predicate
   * serves every lane.
   */
  readonly acceptPin = (drag: CdkDrag<BookPlanView>, drop: CdkDropList<LaneView>): boolean =>
    this.pinRefusal(drop.data, drag.data ?? null) === null;

  /** Pending takes anything that could be dragged at all. "Any machine" refuses nobody. */
  readonly acceptUnpin = (drag: CdkDrag<BookPlanView>): boolean =>
    drag.data === undefined || !this.isLocked(drag.data);

  /**
   * WHAT A DROP HERE WOULD MEAN, said inside the target while the hand is over
   * it — or why it would be refused.
   *
   * The refusal sentence is shown even though `cdkDropListEnterPredicate` has
   * already refused the drop, and that is the point: a target that simply will
   * not take a card, with nothing on screen saying why, is exactly the failure
   * this page exists to remove.
   */
  dragNote(key: string): string | null {
    const plan = this.dragging();
    if (plan === null || this.hoverList() !== key) return null;
    if (key === PENDING_LIST) {
      return `Back to Pending — ${plan.title} takes the first free machine.`;
    }
    const lane = this.gpuLanes().find((row) => row.setId === key);
    if (lane === undefined) return null;
    const refusal = this.pinRefusal(lane, plan);
    if (refusal !== null) return refusal;
    return `Pin ${plan.title} to ${lane.setLabel}; it runs after the books above it.`;
  }

  onLaneDrop(lane: LaneView, event: CdkDragDrop<LaneView>): void {
    const plan = event.item.data as BookPlanView | undefined;
    if (plan === undefined) return;
    const siblings = this.lanePinned(lane).filter((row) => row.key !== plan.key);
    const pinning = this.serverOf(plan) !== lane.setId;
    this.report(this.applyMove(
      plan,
      pinning ? lane.setId : null,
      this.targetFor(siblings, event.currentIndex),
      pinning ? `Pinned to ${lane.setLabel}` : 'Moved up this lane',
    ));
  }

  onPendingDrop(event: CdkDragDrop<unknown>): void {
    const plan = event.item.data as BookPlanView | undefined;
    if (plan === undefined) return;
    const siblings = this.pendingOrdered().filter((row) => row.key !== plan.key);
    // A STAGED book has no place in the global order (it is not in `jobs[]` as
    // far as the pump is concerned), so the released half of the column is the
    // only part a position can be about. A drop among the staged cards at the
    // bottom clamps to the end of the released ones rather than inventing a
    // rank for a book that has none.
    const index = Math.min(event.currentIndex, siblings.length);
    const unpinning = this.serverOf(plan) !== null;
    this.report(this.applyMove(
      plan,
      unpinning ? 'any' : null,
      this.targetFor(siblings, index),
      unpinning ? 'Back to Pending' : 'Moved up Pending',
    ));
  }

  /**
   * WHICH GLOBAL PLAN THE DROPPED BOOK GOES IN FRONT OF.
   *
   * `siblings` is the destination list WITHOUT the dragged book, which is what
   * `currentIndex` counts against in both of CDK's cases (a move within a list
   * reports the index after the lift; a move between lists reports the
   * insertion index in a list that never held it).
   *
   * The folded tail needs no special case: `laneRows` draws a PREFIX of
   * `lanePinned`, so an index past the drawn cards lands on the first folded
   * one — which is exactly where the eye says the card went.
   */
  private targetFor(siblings: BookPlanView[], index: number): OrderTarget {
    const before = siblings[index];
    if (before !== undefined) return { kind: 'before', plan: before };
    const last = siblings[siblings.length - 1];
    if (last === undefined) return { kind: 'none' };
    const plans = this.tray.plans();
    const at = plans.findIndex((row) => row.key === last.key);
    const next = at < 0 ? undefined : plans[at + 1];
    return next === undefined ? { kind: 'end' } : { kind: 'before', plan: next };
  }

  /**
   * PIN, THEN PLACE — and say so, with an Undo.
   *
   * The order of the two halves is load-bearing: `setWaitFor` is the one main
   * can REFUSE (the book was taken by a card before the change arrived), and a
   * reorder applied first would leave the queue rearranged for a pin that never
   * happened. A refusal is rethrown to `report`, which puts main's own sentence
   * on screen.
   *
   * THE UNDO IS BEST-EFFORT AND SAYS SO BY BEING AN UNDO RATHER THAN A REVERT:
   * it puts the book's server back and moves it back to the index it held, in
   * the queue AS IT STANDS THEN. If the queue moved on — a book finished, two
   * more were added — the index is the honest target, not a promise that the
   * whole queue returns to a previous state. Nothing here caches a queue; main
   * owns it.
   */
  private async applyMove(
    plan: BookPlanView, server: string | null, target: OrderTarget, kicker: string,
  ): Promise<void> {
    const memo = {
      waitFor: this.waitForValue(plan) || 'any',
      index: this.tray.plans().findIndex((row) => row.key === plan.key),
    };
    if (server !== null) await this.setPlanServer(plan, server);
    await this.placeBefore(plan, target);
    this.toasts.show({
      tone: 'success',
      kicker,
      title: plan.title,
      meta: server === null ? 'Moved in the queue.' : 'Its server changed for every step of the book.',
      cover: plan.cover,
      action: { label: 'Undo', run: () => this.report(this.undoMove(plan, memo)) },
    });
  }

  private async undoMove(plan: BookPlanView, memo: { waitFor: string; index: number }): Promise<void> {
    await this.setPlanServer(plan, memo.waitFor);
    if (memo.index < 0) return;
    const plans = this.tray.plans();
    const from = plans.findIndex((row) => row.key === plan.key);
    if (from < 0 || from === memo.index) return;
    const optimistic = [...plans];
    moveItemInArray(optimistic, from, memo.index);
    this.droppedPlans.set(optimistic);
    await this.applyPlanOrder(plans, from, memo.index);
  }

  /**
   * Put a book in front of another one, in the engine's ONE order.
   *
   * Goes through the SAME `applyPlanOrder` a Move-to-top does, so the optimistic
   * redraw, the refusal and the re-read are one path with one set of rules.
   */
  private async placeBefore(plan: BookPlanView, target: OrderTarget): Promise<void> {
    if (target.kind === 'none') return;
    const plans = this.tray.plans();
    const from = plans.findIndex((row) => row.key === plan.key);
    // A STAGED book is not in `plans()` at all — it has been pinned, which is
    // the whole of what a drop onto a lane means for it, and it has no rank to
    // change. It still needs Send to queue.
    if (from < 0) return;
    const remaining = plans.filter((_, index) => index !== from);
    const to = target.kind === 'end'
      ? remaining.length
      : remaining.findIndex((row) => row.key === target.plan.key);
    if (to < 0 || to === from) return;
    const optimistic = [...plans];
    moveItemInArray(optimistic, from, to);
    this.droppedPlans.set(optimistic);
    await this.applyPlanOrder(plans, from, to);
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

  // ── Stopping, and what a stop KEEPS ──────────────────────────────────────
  //
  // Owen, 2026-09-20: *"put Stop in the top right, positioned like its an X.
  // and keep it short"*. The button is two words; the sentence about what it
  // keeps is the dialog, because that is the only thing worth knowing before
  // pressing it and it is different for every book.
  //
  // STOP IS NOT "SEND BACK TO PENDING". That path currently resets progress —
  // a defect in the engine (PK16), being fixed on its own — so this side does
  // not reach for it. A stopped book stays exactly where it is, held, with
  // "Start this book", which resumes from what is already rendered.
  //
  // There is NO "start over" here. That lives in the Narrate modal, where the
  // settings a fresh run would use are also on screen.

  /** Stop what is on a lane's card, after saying what it keeps. */
  async stopLane(lane: LaneView): Promise<void> {
    const occupant = lane.occupant;
    if (occupant === null) return;
    const plan = this.planForJob(occupant.jobId);
    if (plan !== null && !(await this.confirmStop(plan, lane))) return;
    this.stopStep(occupant.stepId);
  }

  /** Stop every step of a book that holds a slot, after saying what it keeps. */
  async stopBookAsked(plan: BookPlanView, lane: LaneView | null): Promise<void> {
    if (!(await this.confirmStop(plan, lane))) return;
    this.stopBook(plan);
  }

  /**
   * "Here is what it keeps" — the dialog, built from the book's own chain.
   *
   * True with no dialog when nothing is running: there is no progress to be
   * anxious about and a confirmation would be ceremony.
   */
  private async confirmStop(plan: BookPlanView, lane: LaneView | null): Promise<boolean> {
    if (this.runningSteps(plan) === 0) return true;
    const lines = this.chainFor(plan.jobIds[0] ?? '').map((rung) => this.keepLine(rung, lane));
    return this.dialog.confirm({
      title: 'Stop this book?',
      message: `${plan.title} comes off the card and stays here, held. Start picks it up from `
        + 'what it has already rendered.',
      detail: lines.join('\n'),
      confirmLabel: 'Stop, keep what’s done',
      cancelLabel: 'Keep going',
      type: 'warning',
    });
  }

  /**
   * ONE LINE PER STEP, saying whether the stop keeps it.
   *
   * The count comes from the LANE (`lane.count` is chunks done over total,
   * measured by the bridge) rather than from a number this page works out, for
   * the reason every measurement on this page goes through one owner: two
   * opinions about how much is rendered is the worst possible thing to show
   * somebody deciding whether to stop.
   *
   * ALIGNMENT IS THE EXCEPTION AND IS NAMED. A coverage align has no resumable
   * state — it re-measures the whole book — so promising it is kept would be a
   * promise about a file that does not exist.
   */
  private keepLine(rung: ChainRung, lane: LaneView | null): string {
    if (rung.done) return `KEEP · ${rung.label}`;
    if (rung.status !== 'running') return `—    · ${rung.label}`;
    if (rung.type === 'align') return `—    · ${rung.label} (starts over — nothing to keep)`;
    const onThisLane = lane?.occupant?.stepId === rung.stepId;
    const count = onThisLane ? lane?.count ?? null : null;
    if (count !== null) return `KEEP · ${rung.label} — ${count} rendered so far`;
    return `KEEP · ${rung.label} — what it has rendered so far`;
  }

  /**
   * A RUN'S WHOLE CHAIN, terminal steps included — the step ladder, and the
   * keep-list above.
   *
   * Read off the mirrored snapshot rather than off `BookPlan.steps`, because a
   * plan drops terminal steps by construction (`plansOf` skips them) and the
   * rung a reader most wants is the one that is already DONE: it is the part a
   * stop would keep, and a ladder that begins at the running step cannot show
   * a book is three-quarters through its chain.
   */
  chainFor(jobId: string): ChainRung[] {
    const job = this.queueService.snapshot().jobs.find((row) => row.id === jobId);
    if (job === undefined) return [];
    return job.steps.map((step) => ({
      stepId: step.id,
      label: step.label,
      status: step.status,
      type: step.type,
      percent: step.progress.percent ?? null,
      done: step.status === 'done',
    }));
  }

  /** The plan a run belongs to, or null while the snapshot catches up. */
  planForJob(jobId: string): BookPlanView | null {
    return this.tray.plans().find((plan) => plan.jobIds.includes(jobId)) ?? null;
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

  // ── Reordering ───────────────────────────────────────────────────────────
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
  //
  // THE ONE FLAT-LIST DROP HANDLER IS GONE with the band it served. It read
  // `previousIndex`/`currentIndex` straight off the event, which only works
  // while every queued book is in ONE list; a lane-local drop says nothing
  // about a global index, so `targetFor` + `placeBefore` above translate it
  // into the statement the engine can take. `moveToTop` still comes through
  // `applyPlanOrder` for the same reason it always did: one path, one set of
  // rules for the optimistic redraw, the refusal and the re-read.

  /**
   * The order the user just dropped, held only while its reorder calls are in
   * flight. Null the rest of the time, which is nearly always.
   */
  private readonly droppedPlans = signal<BookPlanView[] | null>(null);

  /** True while a drop is being applied. Move to top is refused meanwhile. */
  readonly reordering = computed(() => this.droppedPlans() !== null);

  /**
   * What the lists draw.
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
