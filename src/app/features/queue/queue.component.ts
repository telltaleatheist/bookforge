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
 * The LEFT COLUMN is one scroller with three sections in it, floor to
 * ceiling — Owen, 2026-09-20: *"i think the pending list should stretch to the
 * bottom of the tab. like a sidebar."*
 *
 *   Up next       — the live queue with no machine named. A book here takes the
 *                   first free card, and its POSITION is its assignment.
 *   Pending       — everything held back: released-but-held books and staged
 *                   ones. One thing to the reader — *not ready yet*.
 *   Completed     — today's work as history, behind an accordion: one BLOCK per
 *                   book, its steps inside it.
 *
 * The RIGHT COLUMN scrolls on its own:
 *
 *   Needs you     — failures, with the engine's own sentence and the controls
 *                   that resolve them. Not drawn when there are none. First
 *                   here, so it cannot shorten the sidebar.
 *   Local slots   — this machine's own lanes, as compact tiles. Not drop
 *                   targets: nothing is pinned to a CPU slot, work simply
 *                   arrives there.
 *   GPU slots     — one LANE per Crucible server, dealt into rows of at most
 *                   three that fill the width, each drawing what is on its card
 *                   now and the books pinned behind it, in queue order.
 *
 * ── READY / PENDING, AND POSITION AS THE ANSWER (Owen, 2026-09-20) ──────────
 *
 * *"the send to queue button should be a toggle that says something like
 * 'ready' or 'pending' maybe. … if they click the ready button, it jumps to the
 * top of the queue list and waits for an open gpu."* And: *"remove the 'run on'
 * dropdown. if theyre in the active queue and not the pending queue then they're
 * set automatically to 'any slot' by nature of where they sit. if the user wants
 * to pick a specific slot, they dont do it by dropdown. they drag/drop it to
 * that slot's active queue."*
 *
 * Two answers that used to be spread across six controls. A book's readiness was
 * three different primaries — "Send to queue" on a staged card, "Start this
 * book" on a held one, "Move to top" on a ready one — plus "Send back to
 * Pending" inside a ⋯ menu; and its machine was a dropdown on the card saying
 * what the card's own column already said, in a second grammar that could
 * disagree on screen. Now readiness is ONE segmented toggle (the toolbar's own
 * `.seg`, because it is the same kind of fact) and the machine is WHERE THE CARD
 * IS. The engine learned nothing new: Ready is `sendPlanToQueue` or `startPlan`
 * plus the reorder Move-to-top always did, Pending is `cancelBook` with its
 * warning dialog, and every pin still goes through `setPlanServer`.
 *
 * And the ⋯ menu is gone with them — its last two entries became the toggle and
 * the ✕ in the card's corner, which is also what replaced the word "Staged"
 * (a label repeating its own column heading, in the one corner a person looks
 * for a way out).
 *
 * ── TWO COLUMNS, TWO SCROLLBARS, NO PAGE SCROLL (Owen, 2026-09-20) ──────────
 *
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
 * takes the whole of it, and the two panes scroll themselves — `.slotcol`
 * inside the aside, everything else inside `.floor`. Below 960px all of that is
 * undone and the page scrolls again, because stacked columns with private
 * scrollbars are three nested scrollers.
 *
 * TWO SCROLLBARS, AND NO MORE THAN TWO. Completed is a labelled rule across the
 * left column and then the blocks, in the SAME flow as Up next and Pending —
 * not a drawer with a scrollbar of its own (Owen: *"an accordion contains them
 * so the user can scroll down and see what finished and when"*). A second
 * scrollbar inside a 320px column is always the one the wheel does not mean.
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
 * Pending un-pins and holds, and either way the same `setPlanServer` and the
 * same release the Ready toggle presses is what actually writes the answer.
 * A person on a keyboard, or a person who simply does not want to drag, has
 * the toggle and the X on every card and loses nothing but the choice of
 * WHICH machine — which is the one thing the layout already says.
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

import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import {
  CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, moveItemInArray,
} from '@angular/cdk/drag-drop';
import type { CdkDragDrop } from '@angular/cdk/drag-drop';
import { CdkScrollable } from '@angular/cdk/scrolling';

import { prepFraction, prepLabel } from '@shared/queue/bench';
import type { BookPlan, FinishedRun } from '@shared/queue/bench';
import type { JobType, ServerReach, StepStatus } from '@shared/queue/engine-types';
import { LOCAL_WORK_SET, LONGFORM_ALIGN_SET } from '@shared/queue/slot-sets';
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

/**
 * THE SIDEBAR'S TWO DROP TARGETS, and they mean different things.
 *
 * Owen, 2026-09-20: *"the user can grab a queue item and drag it from a gpu
 * slot back to the pending list and it flips from ready to pending again."*
 * So Up next and Pending are not one list with a divider in it — dropping a
 * card in one RELEASES it and dropping it in the other HOLDS it. Neither is a
 * server's name; the lanes use their own `setId`.
 */
const UP_NEXT_LIST = '__up_next__';
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
 * The widest a row of GPU lanes gets. Three is Owen's number, and it is also
 * the point at which a lane stops having room for its own step ladder.
 */
const LANES_PER_ROW = 3;

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
  /**
   * THE FRONT, said outright — what a Ready press means (Owen, 2026-09-20:
   * *"if they click the ready button, it jumps to the top of the queue list
   * and waits for an open gpu"*). It is not `before` the current first book,
   * because by the time the release has landed and main has been re-read the
   * first book may be a different one; "the front" is the durable statement.
   */
  | { kind: 'front' }
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
 * HOW MANY LANES GO ON EACH ROW, so the GPU slots fill the width the way the
 * local tiles do.
 *
 * Owen, 2026-09-20: *"lets make the gpu slots stretch across the screen the
 * same way cpu slots do. rows of 1, 2, or 3 crucible servers. after 3, it
 * splits into 2 rows of 2, then 2/3, then 3/3, etc."*
 *
 * Three per row at most, then as EVEN a split as the count allows, with the
 * smaller rows first so the widest row is the bottom one:
 *
 *     1 → [1]        4 → [2, 2]      7 → [2, 2, 3]
 *     2 → [2]        5 → [2, 3]      8 → [2, 3, 3]
 *     3 → [3]        6 → [3, 3]      9 → [3, 3, 3]
 *
 * Pure and exported-shaped on purpose: it is the one place the table above is
 * written down, and it takes a COUNT rather than the lanes so nothing about a
 * server can change the shape of the grid.
 */
function laneRowSizes(count: number): number[] {
  if (count <= 0) return [];
  const rows = Math.ceil(count / LANES_PER_ROW);
  const base = Math.floor(count / rows);
  const wide = count % rows;          // how many rows carry one extra
  return Array.from({ length: rows }, (_, i) => (i < rows - wide ? base : base + 1));
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
    DatePipe, DecimalPipe, NgTemplateOutlet,
    JobStepComponent, JobDetailsComponent, StageBarsComponent,
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

        <!-- ── THE LEFT COLUMN, FLOOR TO CEILING ──────────────────────────
             Owen, 2026-09-20: *"i think the pending list should stretch to the
             bottom of the tab. like a sidebar."*

             It USED to be 'position: sticky' inside the page's own scroller,
             which is a different thing wearing the same look: it was as tall
             as its contents and slid along as the page moved, so a short queue
             drew a short stub and a long one grew the page until the machines
             beside it scrolled away. Now the aside IS the height of the floor
             beside it, and one scroller inside it carries all three sections —
             Up next, Pending, Completed — in a single flow.

             EACH SECTION IS ITS OWN DROP TARGET, and that is the point rather
             than a detail: Up next means "ready, any machine", Pending means
             "held", and a lane on the right means "ready, that machine". The
             dropdown that used to carry the third answer is gone; where the
             card sits IS the answer, and a drop is how you change it. -->
        <aside class="sidebar">
          <!-- ONE SCROLLER FOR THE WHOLE COLUMN (Owen, 2026-09-20: *"an
               accordion contains them so the user can scroll down and see what
               finished and when"*). Up next, Pending and Completed are three
               sections in ONE flow, so opening Completed is a thing you scroll
               to rather than a second scrollbar appearing inside a drawer.

               'cdkScrollable' is what makes the drag work inside it: CDK finds
               a drop list's scrollable ancestors through the ScrollDispatcher,
               and only registered ones are in that answer. -->
          <section class="slotcol" cdkScrollable>
            <header class="slot-head">
              <div class="slot-line">
                <h2>Queue</h2>
                <span class="slot-count">{{ upNextColumn().length + heldColumn().length }}</span>
              </div>
              <div class="slot-where">Where a book sits is where it runs.</div>
            </header>

            <!-- ── UP NEXT · ANY SLOT ─────────────────────────────────────
                 Owen, 2026-09-20: *"if theyre in the active queue and not the
                 pending queue then they're set automatically to 'any slot' by
                 nature of where they sit. if the user wants to pick a specific
                 slot, they dont do it by dropdown. they drag/drop it to that
                 slot's active queue."*

                 POSITION IS THE ASSIGNMENT. This group is the live queue with
                 no machine named, and dropping a card into it says exactly
                 that — release it if it was staged, un-pin it if it named a
                 server, and put it where the hand let go. The dropdown that
                 used to carry this answer is gone; there is nothing it could
                 say that the column does not. -->
            <section
              class="group"
              cdkDropList
              [cdkDropListDisabled]="reordering()"
              [cdkDropListEnterPredicate]="acceptUnpin"
              (cdkDropListDropped)="onUpNextDrop($event)"
              (cdkDropListEntered)="hoverList.set(upNextList)"
              (cdkDropListExited)="clearHover(upNextList)"
              (mouseenter)="hoverList.set(upNextList)"
              (mouseleave)="clearHover(upNextList)"
            >
              <div class="group-head">
                <span class="gk">Up next</span>
                <span class="gd">· any slot</span>
                <span class="gn">{{ upNextColumn().length }}</span>
              </div>

              @if (dragNote(upNextList); as note) {
                <p class="drop-note">{{ note }}</p>
              }

              @for (plan of upNextColumn(); track plan.key) {
                <article
                  class="card narrow"
                  cdkDrag
                  [cdkDragData]="plan"
                  [cdkDragDisabled]="isLocked(plan)"
                  (cdkDragStarted)="dragStarted(plan)"
                  (cdkDragEnded)="dragEnded()"
                >
                  <!-- HANDLE, not the whole card. The card body carries a
                       Ready/Pending toggle, an X and a step name per row that
                       expands it; making the card itself draggable would arm a
                       drag under every one of those presses.

                       It stays HERE rather than inside the shared body because
                       cdkDrag finds its handle by content query, and a handle
                       rendered from a template declared elsewhere is not in
                       that scope — the card would silently become draggable
                       everywhere. Absent on a book that holds a card: there is
                       nothing a drag of it could honestly mean. -->
                  @if (!isLocked(plan)) {
                    <button
                      type="button"
                      class="grip"
                      cdkDragHandle
                      aria-label="Drag this book onto a machine, down to Pending, or up and down the queue"
                      title="Drag this book onto a machine, down to Pending, or up and down the queue"
                    >⠿</button>
                  }
                  <ng-container
                    [ngTemplateOutlet]="bookCard"
                    [ngTemplateOutletContext]="{ $implicit: plan, staged: false, lane: null }"
                  />
                </article>
              }

              @if (upNextColumn().length === 0) {
                <p class="slot-free">
                  Nothing is ready for a free machine. Press Ready on a book
                  below, or drag one up here.
                </p>
              }
            </section>

            <!-- ── PENDING ────────────────────────────────────────────────
                 Owen: *"the user can grab a queue item and drag it from a gpu
                 slot back to the pending list and it flips from ready to
                 pending again."*

                 So this group is not a parking bay, it is a STATE, and a drop
                 here performs it: un-pin AND hold, which is the same act the
                 toggle's Ready → Pending press makes — down to the dialog it
                 raises when a book has banked work that a return would leave
                 behind. Staged books (never sent at all) sit here too; to the
                 reader they are one kind of thing — *not ready yet*. -->
            <section
              class="group"
              cdkDropList
              [cdkDropListDisabled]="reordering()"
              [cdkDropListEnterPredicate]="acceptUnpin"
              (cdkDropListDropped)="onPendingDrop($event)"
              (cdkDropListEntered)="hoverList.set(pendingList)"
              (cdkDropListExited)="clearHover(pendingList)"
              (mouseenter)="hoverList.set(pendingList)"
              (mouseleave)="clearHover(pendingList)"
            >
              <div class="group-head">
                <span class="gk">Pending</span>
                <span class="gd">· held until Ready</span>
                <span class="gn">{{ heldColumn().length }}</span>
              </div>

              @if (dragNote(pendingList); as note) {
                <p class="drop-note">{{ note }}</p>
              }

              @for (entry of heldColumn(); track entry.plan.key) {
                <article
                  class="card narrow"
                  cdkDrag
                  [cdkDragData]="entry.plan"
                  [cdkDragDisabled]="isLocked(entry.plan)"
                  (cdkDragStarted)="dragStarted(entry.plan)"
                  (cdkDragEnded)="dragEnded()"
                >
                  @if (!isLocked(entry.plan)) {
                    <button
                      type="button"
                      class="grip"
                      cdkDragHandle
                      aria-label="Drag this book up to Up next, or straight onto a machine"
                      title="Drag this book up to Up next, or straight onto a machine"
                    >⠿</button>
                  }
                  <ng-container
                    [ngTemplateOutlet]="bookCard"
                    [ngTemplateOutletContext]="{ $implicit: entry.plan, staged: entry.staged, lane: null }"
                  />
                </article>
              }

              @if (heldColumn().length === 0) {
                <p class="slot-free">Nothing is being held back.</p>
              }
            </section>

            <!-- ── Completed, the third section of the same column ────────
                 Owen, 2026-09-20: *"cards that have finished are at the
                 bottom, maybe separated by a div or something with 'Completed'
                 text, so the user can clearly see theyre done. an accordion
                 contains them so the user can scroll down and see what
                 finished and when."*

                 So it is NOT a drawer pinned to the viewport's edge with a
                 scrollbar of its own — that is two scrollbars in one column
                 and the second one is always the one your wheel does not mean.
                 It is a labelled RULE across the column and then the blocks,
                 in the same flow as Up next and Pending, and "scroll down and
                 see" is literally what it is.

                 THIS REPLACES A TABLE. The old band was a six-column
                 '<table class="ftable">' at the very bottom of the page —
                 below the lanes, below the fold, seen by nobody, written in a
                 shape nothing else here uses, and a book that ran four steps
                 appeared as four unrelated rows sharing a title cell.

                 The BLOCK is the answer to both: one card per BOOK, from the
                 same family as the card it was five minutes ago in Pending,
                 with its steps inside it rather than beside it. The card's own
                 step ladder ('.rung') is what the expansion reuses, because
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
                    <!-- OWEN'S WORD, not "Finished today". The rule across the
                         column is what separates the work that is over from the
                         work that is not, and "Completed" is what he called
                         it. The day is still the scope and the Clear button
                         still says so. -->
                    <span class="fin-word">Completed</span>
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
          </section>
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
              <!-- ROWS OF AT MOST THREE, each row sharing the full width —
                   Owen, 2026-09-20: *"lets make the gpu slots stretch across
                   the screen the same way cpu slots do."* The old grid was
                   'repeat(auto-fill, minmax(300px, 1fr))', which packs as many
                   300px lanes as fit and leaves the remainder as white space:
                   two servers on a wide screen drew two narrow cards against an
                   empty right half, and five drew four-and-one. The split is
                   'laneRowSizes' — the table is written there, once — and each
                   row lays its lanes out in equal columns. -->
              @for (row of gpuLaneRows(); track $index) {
                <div class="lanes">
                @for (lane of row; track laneKey(lane)) {
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
                      <span class="lane-slot">GPU slot {{ laneOrdinal(lane) }} of {{ gpuLanes().length }}</span>
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
              }
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
        <!-- ── X, TOP RIGHT ──────────────────────────────────────────────
             Owen, 2026-09-20: *"get rid of the 'staged' text in the top right
             and replace it with an X. if the user hits X, it removes it from
             the queue completely."*

             The word it replaced said the same thing the card's COLUMN now
             says — a book under "Pending" has not been sent — so it was a
             label repeating its own heading in the one corner a person looks
             for a way out. Positioned like the running card's Stop-X and
             neutral rather than red: red on this page is a failure that has
             already happened, and this removes a book that has not run.

             ONE ACT, whichever state the card is in: 'removeFromQueue' takes
             every run of the book out. Nothing already rendered is deleted,
             which is what its tooltip says. Absent on a locked card — a book
             holding a machine is stopped first, and Stop is its control. -->
        @if (!isLocked(plan)) {
          <button
            type="button"
            class="kill-x"
            (click)="removeFromQueue(plan)"
            [attr.aria-label]="'Remove ' + plan.title + ' from the queue'"
            title="Take this book out of the queue altogether. Nothing already rendered is deleted."
          >✕</button>
        }
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
            THE DECISION COLUMN, and it is now ONE decision: ready, or not.

            ── The "Run on" picker is gone (Owen, 2026-09-20) ────────────────

            *"remove the 'run on' dropdown. if theyre in the active queue and
            not the pending queue then they're set automatically to 'any slot'
            by nature of where they sit. if the user wants to pick a specific
            slot, they dont do it by dropdown. they drag/drop it to that slot's
            active queue."*

            WHERE THE CARD SITS IS THE ANSWER. Under "Up next · any slot" it
            waits for the first free machine; under a lane's "Pinned here" it
            waits for that one. A dropdown on the card was the page asking a
            question its own layout had already answered, in a second grammar,
            and the two could disagree on screen. The writes it used to make
            have not gone anywhere — 'setPlanServer' is what every drop calls.

            An ADMITTED book still shows a read-only CHIP. That is not a choice
            being offered; it is the engine's record that the work WENT
            somewhere (crucible docs/PHASE7-LANES.md §4.3), and a book finishes
            on the machine it started on.
          -->
          <div class="decide">
            @if (plan.travels && plan.waitForResolved.length > 0) {
              <div class="venue-row">
                <span class="venue-word">Runs on</span>
                <span class="runs-on" title="A book finishes on the machine it started on.">
                  <span class="dot" aria-hidden="true"></span>{{ plan.waitForResolved.join(' + ') }}
                </span>
              </div>
            }

            <!--
              READY / PENDING — ONE TOGGLE, TWO STATES (Owen, 2026-09-20).

              *"the send to queue button should be a toggle that says something
              like 'ready' or 'pending' maybe. … if they click the ready
              button, it jumps to the top of the queue list and waits for an
              open gpu."* And the other way: *"the user can grab a queue item
              and drag it from a gpu slot back to the pending list and it flips
              from ready to pending again."*

              It replaces three primaries that were three different words for
              two states — "▶ Send to queue" on a staged card, "▶ Start this
              book" on a held one, "Move to top" on a ready one — plus a
              "Send back to Pending" buried in a ⋯ menu. A person moving a book
              between those states had to know which of the four they were
              looking at. Now there is one control and it says which state the
              book is IN, with the other half pressable beside it.

              READY MEANS THE TOP OF THE LIST, not merely membership: the
              engine claims work by walking 'jobs[]' from the front, so "I
              pressed Ready" and "this one next" are the same sentence. It goes
              through the same 'applyPlanOrder' a drag does.

              Drawn only where it can be honoured. A book holding a card is
              locked (§4.3) and its control is Stop; a running one likewise.
            -->
            <div class="acts">
              @if (runningSteps(plan) > 0) {
                <button
                  type="button"
                  class="btn grow"
                  (click)="stopBookAsked(plan, lane)"
                  title="Stop what this book is running and free its slots. It keeps everything it has rendered; Start picks it up from there. The rest of the queue carries on."
                >■ Stop this book</button>
              } @else if (isLocked(plan)) {
                <!-- WHY THIS BOOK CANNOT BE MOVED, said on the card rather
                     than inside a menu a hand has to find. It holds a machine;
                     that is a fact about the engine, not a control. -->
                <p class="locked-why">{{ lockedReason(plan) }}</p>
              } @else {
                <div class="seg ready-seg" role="group" [attr.aria-label]="'Is ' + plan.title + ' ready to run?'">
                  <button
                    type="button"
                    class="seg-btn"
                    [class.on]="isReady(plan, staged)"
                    [attr.aria-pressed]="isReady(plan, staged)"
                    (click)="setReady(plan, staged, true)"
                    title="Put this book at the front of Up next. It starts on the first machine that will take it — or drag it onto a lane to name one."
                  ><span class="seg-dot" aria-hidden="true"></span>Ready</button>
                  <button
                    type="button"
                    class="seg-btn paused"
                    [class.on]="!isReady(plan, staged)"
                    [attr.aria-pressed]="!isReady(plan, staged)"
                    (click)="setReady(plan, staged, false)"
                    title="Hold this book. It keeps its settings and anything it has rendered, and nothing starts it until Ready."
                  ><span class="seg-dot" aria-hidden="true"></span>Pending</button>
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

    /* THE TOGGLE reuses the toolbar's segmented control verbatim — '.seg' and
       '.seg-btn', green for moving and amber for holding — because it is the
       same KIND of fact: two states of one latch, one of them current. A
       second drawing of that idea in another shape is how a page ends up with
       two vocabularies for "on". */
    .ready-seg { width: 100%; }
    .ready-seg .seg-btn { flex: 1; justify-content: center; }

    /* WHY A LOCKED CARD HAS NO TOGGLE, where its toggle would have been. */
    .locked-why {
      margin: 0;
      font-size: 0.6875rem;
      line-height: 1.45;
      color: var(--text-muted);
    }

    /* THE X, TOP RIGHT — positioned like the running card's Stop, and neutral
       rather than red: red on this page is a failure that has already
       happened, and this takes out a book that has not run. Faded until the
       card is under the hand or holds focus, so a column of ten books is not a
       column of ten ✕. */
    .kill-x {
      position: absolute;
      top: 5px;
      right: 6px;
      z-index: 2;
      font-family: inherit;
      font-size: 0.6875rem;
      line-height: 1;
      padding: 3px 5px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.12s, color 0.12s;
    }

    .card:hover .kill-x,
    .card:focus-within .kill-x { opacity: 1; }
    .kill-x:hover { color: var(--color-danger); background: var(--warning-bg); }

    /* A touch screen has no hover to give. */
    @media (hover: none) { .kill-x { opacity: 1; } }

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
       would be the first thing a long title ate. Padded on the right so a long
       title does not run under the ✕ in the corner above it. */
    .title-row { display: flex; align-items: center; min-width: 0; padding-right: 20px; }

    /* CPU — a book that travels nowhere, sitting in the sidebar with the books
       that are waiting for a card. The tag is the difference. */
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
    /* SUNKEN, so the cards inside it can be raised. Owen, 2026-09-20: *"give
       the pending blocks a solid outline with a lighter gray background so
       they stand out against the current background color."* A card cannot be
       lighter than a column that is already the lightest surface the theme
       has, so the COLUMN moved down a step — '--bg-sunken' is neutral-150 in
       light and neutral-950 in dark — and the cards sit on '--bg-elevated'
       above it. Both themes read, and neither needed a new token. */
    .slotcol {
      display: flex;
      flex-direction: column;
      background: var(--bg-sunken);
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
      z-index: 3;
      flex: none;
      padding-top: 11px;
      margin-bottom: 10px;
      background: var(--bg-sunken);
    }

    /* ── The column's three sections ───────────────────────────────────────
       Up next, Pending, Completed — in one flow, in one scroller. Each is its
       own drop target and each says what a drop on it MEANS; the heads are
       small, like a lane's "Pinned here", because they label a group rather
       than open a band. */
    .group {
      flex: none;
      min-height: 52px;
    }

    .group + .group { margin-top: 14px; }

    .group-head {
      display: flex;
      align-items: baseline;
      gap: 5px;
      padding: 0 2px 6px;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 9px;
    }

    .group-head .gk {
      font-size: 0.625rem;
      font-weight: 700;
      letter-spacing: 0.11em;
      text-transform: uppercase;
      color: var(--text-secondary);
    }

    .group-head .gd {
      font-size: 0.625rem;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .group-head .gn {
      margin-left: auto;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-primary);
      font-variant-numeric: tabular-nums;
    }

    /* THE BLOCKS. Solid outline, a step lighter than the column under them. */
    .sidebar .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
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
    /* ONE ROW OF LANES, sharing the row's whole width. 'grid-auto-flow:
       column' with a single auto column track means the row's N lanes become N
       equal columns without this stylesheet having to know N — the split
       itself is 'laneRowSizes', which owns the table.

       It replaced 'repeat(auto-fill, minmax(300px, 1fr))', which packs as many
       300px lanes as fit and leaves the remainder as empty page: two servers
       on a wide screen drew two narrow cards against a blank right half. */
    .lanes {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }

    .lanes + .lanes { margin-top: 12px; }

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
      .finished { margin-top: 14px; }
      .tiles { grid-template-columns: minmax(0, 1fr); }
    }

    /* ── Pending ───────────────────────────────────────────────────────────
       Dashed, because nothing about a staged book is committed: it is a plan on
       the bench, not work in the queue. Otherwise the SAME card a released book
       gets, so the press between them is the only difference a reader has to
       hold. */

    /* NOT DASHED ANY MORE (Owen, 2026-09-20: *"a solid outline"*). A dashed
       border said "nothing here is committed", which is now the Pending
       heading's job — and saying it twice cost the card the one thing it
       needed, which was to look like a block. */
    .card.staged { border-style: solid; }

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
    /* A LABELLED RULE ACROSS THE COLUMN, not a panel docked to the viewport.
       Owen, 2026-09-20: *"cards that have finished are at the bottom, maybe
       separated by a div or something with 'Completed' text … an accordion
       contains them so the user can scroll down and see what finished and
       when."* So it has no frame and no scrollbar of its own — it is the third
       section of one flow, and the column's own scroll is the one that reaches
       it. A second scrollbar inside a 320px column is always the one the
       wheel does not mean.

       'margin-top: auto' puts it at the FOOT of the column on a quiet day and
       does nothing at all on a busy one: an auto margin absorbs free space,
       and an overflowing flex column has none. */
    .finished {
      flex: none;
      margin-top: auto;
      padding-top: 14px;
    }

    .fin-head {
      flex: none;
      border-top: 1px solid var(--border-default);
    }

    .fin-head {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
    }

    .fin-step { min-width: 0; }

    .fin-toggle {
      font-family: inherit;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 9px 4px 9px 2px;
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

    /* The clip hides the closed content and nothing else: the column scrolls,
       not this. */
    .fin-clip { min-height: 0; overflow: hidden; }

    .fin-list { padding: 8px 0 2px; }

    /* ── A finished BOOK, as a block ───────────────────────────────────────
       Owen: *"the completed jobs can be blocks, just like they were when they
       were pending."* Same '.card.narrow' family, so a book that finished
       reads as the same object it was while it waited — one card, one cover,
       one title — and the only difference is that its chain is history. */
    .fin-card { margin-bottom: 8px; background: var(--bg-elevated); }
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
    .kill-x:focus-visible,
    .fin-toggle:focus-visible,
    .fin-block:focus-visible,
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


  /**
   * THE BOOK'S ONE ANSWER, or '' for none/disagreeing.
   *
   * It has no picker to feed any more — the column the card sits in is the
   * answer (see the card's decision column). It survives because `applyMove`
   * memos it for the Undo, which has to put back exactly what was there.
   */
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
   * happened (see `applyMove`), whose caller puts main's own refusal on
   * screen.
   */
  private async setPlanServer(plan: BookPlan, value: string): Promise<void> {
    // Every run of the book, because the book is the unit the answer is about.
    for (const jobId of plan.jobIds) await this.queueService.setWaitFor(jobId, value);
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
   * through to the sidebar (see {@link sidebarPlans}) rather than into a map entry
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

  /**
   * THE GPU LANES, DEALT INTO ROWS OF AT MOST THREE — see {@link laneRowSizes}
   * for the table. The lanes keep the order `gpuLanes` put them in; all this
   * does is decide where each row breaks, so "GPU slot 2 of 5" still counts
   * across the whole bench and not within a row.
   */
  readonly gpuLaneRows = computed<LaneView[][]>(() => {
    const lanes = this.gpuLanes();
    const rows: LaneView[][] = [];
    let at = 0;
    for (const size of laneRowSizes(lanes.length)) {
      rows.push(lanes.slice(at, at + size));
      at += size;
    }
    return rows;
  });

  /** A lane's place among ALL the GPU lanes — its slot number, 1-based. */
  laneOrdinal(lane: LaneView): number {
    return this.gpuLanes().findIndex((row) => row.setId === lane.setId) + 1;
  }

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
  private readonly sidebarPlans = computed<BookPlanView[]>(() => {
    const busy = this.onSlotJobIds();
    const pinned = new Set<string>();
    for (const list of this.pinnedByLane().values()) for (const plan of list) pinned.add(plan.key);
    return this.visiblePlans()
      .filter((plan) => !pinned.has(plan.key))
      .filter((plan) => !plan.jobIds.some((jobId) => busy.has(jobId)));
  });

  /**
   * UP NEXT · ANY SLOT — released books with no machine named, in the engine's
   * own order. This IS the active queue, and its order is the one `pump()`
   * walks, so the top card is genuinely the next one out.
   */
  readonly upNextColumn = computed<BookPlanView[]>(
    () => this.sidebarPlans().filter((plan) => !plan.allHeld));

  /**
   * PENDING — everything being held back, released-but-held first and staged
   * after. Two engine states, one thing to the reader: *not ready yet.* The
   * card knows which it is (`staged`), because the toggle's Ready press is
   * `sendPlanToQueue` for one and `startPlan` for the other.
   */
  readonly heldColumn = computed<PendingEntry[]>(() => {
    const held: PendingEntry[] = this.sidebarPlans()
      .filter((plan) => plan.allHeld)
      .map((plan) => ({ plan, staged: false }));
    const staged: PendingEntry[] = this.tray.pending().map((plan) => ({ plan, staged: true }));
    return [...held, ...staged];
  });

  /** The part of the sidebar that has a queue order at all. */
  private pendingOrdered(): BookPlanView[] {
    return this.upNextColumn();
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
  readonly upNextList = UP_NEXT_LIST;

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
    return 'This book is on a card right now. Stop it first; it keeps what it has finished.';
  }

  /**
   * LOCKED MEANS ON THE CARD RIGHT NOW — a running step, and nothing else.
   *
   * Owen, 2026-09-20: *"i canceled one that was currently in the queue but its
   * still taking up the slot. i cant move it out."* This read `true` for any
   * book with a resolved venue, so a book he STOPPED — held, not running, but
   * still pinned to the machine it started on (kept for §4.3, "a job finishes
   * where it started", so a resume lands on the same card) — was undraggable
   * and drawn as a card occupant. A stopped book is not on the card; pinning it
   * only says WHERE it would resume.
   *
   * So the pin no longer locks. Dragging a stopped book to Pending routes
   * through `returnToPending`, which clears the pin when nothing stands on the
   * card and keeps it when the book is genuinely mid-hold across GPU acts — the
   * same guarded release the engine already owns. Only a running step forbids
   * the drag, because you cannot move a render off a card mid-chunk.
   */
  isLocked(plan: BookPlan): boolean {
    return plan.steps.some((step) => step.status === 'running');
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
    // THREE DROPS, THREE MEANINGS, and the note says which one this is. They
    // look identical to the hand — a card over a list — and two of them change
    // whether the book runs at all.
    if (key === UP_NEXT_LIST) {
      return `Ready — ${plan.title} takes the first free card.`;
    }
    if (key === PENDING_LIST) {
      return `Pending — ${plan.title} is held until you press Ready.`;
    }
    const lane = this.gpuLanes().find((row) => row.setId === key);
    if (lane === undefined) return null;
    const refusal = this.pinRefusal(lane, plan);
    if (refusal !== null) return refusal;
    return `Ready, on ${lane.setLabel} — ${plan.title} runs after the books above it.`;
  }

  /**
   * A DROP ON A LANE IS ALSO A READY PRESS (Owen, 2026-09-20: *"if it's
   * dragged from the pending list to a gpu slot, it automatically flips from
   * pending to ready"*).
   *
   * Release first, pin second, place third — in that order, because a pinned
   * book that is still held is a card sitting under a machine that will never
   * pick it up, which is exactly the state a person dragging it there is
   * trying to leave. The release is the SAME door the toggle presses.
   */
  onLaneDrop(lane: LaneView, event: CdkDragDrop<LaneView>): void {
    const plan = event.item.data as BookPlanView | undefined;
    if (plan === undefined) return;
    const siblings = this.lanePinned(lane).filter((row) => row.key !== plan.key);
    const pinning = this.serverOf(plan) !== lane.setId;
    this.report((async () => {
      const released = await this.release(plan);
      const now = released ?? plan;
      await this.applyMove(
        now,
        pinning ? lane.setId : null,
        this.targetFor(siblings, event.currentIndex),
        pinning ? `Ready on ${lane.setLabel}` : 'Moved up this lane',
      );
    })());
  }

  /**
   * A DROP ON *UP NEXT* MEANS READY, ON ANY MACHINE.
   *
   * Release it if it was held or staged, un-name its server if it had one, and
   * put it where the hand let go. Owen: *"if theyre in the active queue and not
   * the pending queue then they're set automatically to 'any slot' by nature of
   * where they sit."* — this is that sentence, executed.
   *
   * A book dropped here with no position to speak of (it was staged, so it is
   * not in `jobs[]` at all until the release lands) goes to the FRONT, which is
   * the same place the Ready button puts it.
   */
  onUpNextDrop(event: CdkDragDrop<unknown>): void {
    const plan = event.item.data as BookPlanView | undefined;
    if (plan === undefined) return;
    const siblings = this.pendingOrdered().filter((row) => row.key !== plan.key);
    const index = Math.min(event.currentIndex, siblings.length);
    const unpinning = this.serverOf(plan) !== null;
    this.report((async () => {
      const released = await this.release(plan);
      const placed = this.targetFor(siblings, index);
      await this.applyMove(
        released ?? plan,
        unpinning ? 'any' : null,
        // A book that was staged has no rank at all until the release lands,
        // so "dropped into an empty Up next" has no neighbour to sit behind
        // and `none` would leave it wherever the engine appended it. The drop
        // was a Ready press; the front is what a Ready press means.
        released !== null && placed.kind === 'none' ? { kind: 'front' } : placed,
        released === null && !unpinning ? 'Moved up the queue' : 'Ready',
      );
    })());
  }

  /**
   * A DROP ON *PENDING* MEANS HELD — the toggle's Ready → Pending press,
   * performed by hand.
   *
   * Owen: *"the user can grab a queue item and drag it from a gpu slot back to
   * the pending list and it flips from ready to pending again."* So this is
   * `cancelBook`, warning dialog and all: a book with banked work is asked
   * about before it goes back, whether the gesture was a click or a drag. A
   * book that is ALREADY held (or staged) has nothing to do here — Pending has
   * no queue order of its own, so there is no position to write either.
   */
  onPendingDrop(event: CdkDragDrop<unknown>): void {
    const plan = event.item.data as BookPlanView | undefined;
    if (plan === undefined) return;
    if (plan.allHeld && this.serverOf(plan) === null) return;
    void this.cancelBook(plan);
  }

  /**
   * MAKE A BOOK RUNNABLE, and answer with the version of it the engine now
   * holds — or null when it was already running.
   *
   * Two doors because there are two states behind "not ready": a STAGED book
   * has never been in `jobs[]` (`sendPlanToQueue`) and a HELD one is in it with
   * every step latched off (`startPlan`). Both end in the same place.
   *
   * THE RE-READ IS NOT OPTIONAL. A staged book gets its rank the moment it is
   * sent, and everything after this — the placement, the move to the top — is
   * arithmetic on `tray.plans()`. Acting on the snapshot from before the send
   * would be arithmetic on a list the book is not in yet, which is silently no
   * move at all. Success is a verified state, so we re-read main and look the
   * book up again.
   */
  private async release(plan: BookPlanView): Promise<BookPlanView | null> {
    const staged = this.tray.pending().some((row) => row.key === plan.key);
    if (!staged && !plan.allHeld) return null;
    if (staged) await this.tray.sendPlanToQueue(plan);
    else await this.tray.startPlan(plan);
    await this.queueService.refreshFromBackend();
    return this.tray.plans().find((row) => row.key === plan.key) ?? null;
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
    const to = target.kind === 'front'
      ? 0
      : target.kind === 'end'
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

  // ── READY / PENDING ──────────────────────────────────────────────────────
  //
  // Owen, 2026-09-20: *"the send to queue button should be a toggle that says
  // something like 'ready' or 'pending' maybe. … if they click the ready
  // button, it jumps to the top of the queue list and waits for an open gpu."*
  // And, on the other direction: *"the user can grab a queue item and drag it
  // from a gpu slot back to the pending list and it flips from ready to pending
  // again."*
  //
  // THIS IS ONE STATE WITH TWO SPELLINGS IN THE ENGINE, which is why it was
  // four buttons before: a STAGED book is not in `jobs[]` at all and a HELD one
  // is in it with its steps latched off. The card knows which it is drawn from
  // and the toggle picks the door; the user only ever sees "ready" and "not".
  //
  // Nothing new was taught to main. Ready is `sendPlanToQueue` or `startPlan`
  // plus the reorder a Move-to-top always did; Pending is `cancelBook`, warning
  // dialog included.

  /** Is this book in the live queue and free to be claimed? */
  isReady(plan: BookPlan, staged: boolean): boolean {
    return !staged && !plan.allHeld;
  }

  /**
   * FLIP IT — and, going Ready, put it at the FRONT.
   *
   * "Ready" that only meant "a member of the list" would be a press with no
   * visible effect on a queue of eleven: the engine claims work from the front,
   * so the honest reading of *"it jumps to the top of the queue list and waits
   * for an open gpu"* is the reorder, and it goes through the same
   * `applyPlanOrder` a drag and Move-to-top do.
   *
   * The reorder is attempted only once the release has been VERIFIED (see
   * `release`): a staged book has no rank until it is in `jobs[]`, and moving
   * a row that is not there yet is silently nothing.
   */
  setReady(plan: BookPlanView, staged: boolean, ready: boolean): void {
    if (ready === this.isReady(plan, staged)) return;
    if (!ready) {
      void this.cancelBook(plan);
      return;
    }
    this.report((async () => {
      const released = await this.release(plan);
      await this.applyMove(released ?? plan, null, { kind: 'front' }, 'Ready');
    })());
  }

  /**
   * THE X — out of the queue altogether (Owen: *"if the user hits X, it removes
   * it from the queue completely"*).
   *
   * One call for both states, because `cancelPlan` already walks every run of
   * the book whether it was staged or released. Nothing already rendered is
   * deleted, which is what the button's tooltip says and what `removeRun`
   * actually does.
   */
  removeFromQueue(plan: BookPlan): void {
    this.cancelPlan(plan);
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
  // into the statement the engine can take. The Ready press comes through
  // `applyPlanOrder` for the same reason a drop does: one path, one set of
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
