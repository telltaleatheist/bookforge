import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import type { Job } from '@shared/types';

import { QueueService } from '../../core/queue.service';
import { QueueViewService } from '../../core/queue-view.service';
import { hosted } from '../../core/foundry';

/**
 * THE QUEUE PAGE — the whole board, with room to breathe.
 *
 * Owen asked for it in the same breath as the bar (his ruling is quoted in full
 * at the head of `QueueBarComponent`): *"put a button in it for 'more info'
 * thatll take me to a queue page that looks like bookforge's queue page"*. So
 * this is BookForge's queue page's ANATOMY, drawn with Foundry's facts and in
 * Foundry's tokens — its structures reproduced, none of its code imported, and
 * nothing invented that this app's queue does not really know.
 *
 * ── The bands, in BookForge's own order ─────────────────────────────────────
 *
 *   Needs you    — failures, with the engine's own sentence. Not drawn when
 *                  there are none, which is almost always, and therefore worth
 *                  reading when it is.
 *   On the bench — the three slots, always all three, occupied or free. This is
 *                  the page's centre of gravity, and the reason the page exists
 *                  at all: rationing one GPU slot and two CPU slots is the whole
 *                  job of the scheduler, and the dropdown has room to group rows
 *                  by lane but not to draw the slots themselves.
 *   Up next      — everything waiting, GROUPED BY BOOK, each row saying why it
 *                  is still.
 *   Finished     — today's work as history, in a table, rather than as more rows
 *                  that look live.
 *
 * A band with nothing in it is not drawn, so the page is short when the queue is
 * quiet and long only when there is genuinely that much to say.
 *
 * ── It is a bigger window onto the same facts, and nothing more ─────────────
 *
 * Every signal on this page comes from `QueueViewService`, which is the same
 * service the dropdown reads — BookForge's own lesson, learned the hard way and
 * written into its page's header: before it had one, its two queue surfaces
 * *"spoke different dialects"* and its page showed a step only once it had
 * started. There is one description of this queue and one set of words for it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * BookForge's page carries covers, ETAs, card temperatures, per-stage bars, a
 * Pause-the-engine control, a Retry, and a per-book Start. Foundry's queue knows
 * none of those things, and a page that drew a slot for an ETA it cannot compute
 * would be furniture that never fills. Two are worth naming rather than merely
 * omitting:
 *
 *   NO RETRY on a failed row. Nothing in main re-runs a settled job; the honest
 *   gesture is to order the work again from the tool that ordered it, and a
 *   button here promising otherwise would be a door onto nothing.
 *
 *   NO PER-BOOK START, though the grouping invites one. `queue.start()` releases
 *   the WHOLE held batch — that is the engine-level semantics Owen fenced off —
 *   so a Start under one title would silently start four other books. The one
 *   Start there is stays in the page head, carrying the count of what it
 *   commits, exactly as it does in the dropdown.
 *
 * ── Hosted, this page cannot be reached ────────────────────────────────────
 *
 * The route itself refuses hosted (`app.routes.ts`), which is the real gate; the
 * `@if` below is the second half of the same rule, kept for the reason the
 * shelf's summons and the shelf's render were both gated: a door with nobody
 * behind it and a room with no door are two halves of one promise, and neither
 * side should have to trust the other to remember it.
 */
@Component({
  selector: 'app-queue-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!hosted()) {
    <div class="page">
      <!--
        THE HEAD, and the two controls that act on the whole queue. Start is
        last and on the right because it is the primary action, and it carries
        the COUNT for the same reason it does everywhere else: the number is the
        thing being committed to.
      -->
      <header class="page-head">
        <h1>Queue</h1>
        <span class="head-note">{{ view.busySlots() }} of {{ view.slots().length }} slots in use</span>
        <button class="btn" [disabled]="queue.finished().length === 0"
                (click)="queue.clearFinished()">Clear finished</button>
        <button class="primary" [disabled]="queue.held().length === 0"
                [attr.aria-label]="view.startLabel()"
                [title]="view.startLabel()"
                (click)="queue.start()">
          Start@if (queue.held().length > 0) { <span>&nbsp;{{ queue.held().length }}</span> }
        </button>
      </header>

      <!-- ── Needs you ───────────────────────────────────────────────────── -->
      <!--
        FAILURES FIRST, because they are the only rows on this page that are
        waiting on the PERSON rather than on the machine. There is no per-row
        control: main will not remove a settled job (its own \`remove\` takes
        held and queued only), so the one honest gesture is Clear finished in
        the head, and inventing a button that main refuses would be worse than
        having none.
      -->
      @if (queue.failed().length > 0) {
        <section class="band">
          <header class="band-head bad">
            <h2>Needs you · {{ queue.failed().length }}</h2>
          </header>
          @for (job of queue.failed(); track job.id) {
            <article class="card failed">
              <div class="card-head">
                <div class="min">
                  <h3>{{ view.label(job) }}</h3>
                  <p class="sub">{{ kindLine(job) }}</p>
                </div>
              </div>
              <!--
                THE ENGINE'S OWN SENTENCE, not this app's paraphrase of it, and
                the whole of its stderr on the hover. The line is chosen by the
                same rule the dropdown uses — the argument lives with the rule,
                in QueueViewService.failureLine.
              -->
              <p class="error" [title]="job.error ?? ''">{{ view.failureLine(job.error) }}</p>
            </article>
          }
        </section>
      }

      <!-- ── On the bench ────────────────────────────────────────────────── -->
      <section class="band">
        <header class="band-head">
          <h2>On the bench</h2>
          <span class="note">{{ view.busySlots() }} of {{ view.slots().length }} slots in use</span>
        </header>

        <!--
          ONE CARD PER SLOT, ALWAYS ALL THREE. The GPU card is the widest because
          the card is the resource a person schedules their day around — and
          because the GPU lane is the one that costs hours, which is the same
          fact the chip's progress hairline follows.

          A slot is drawn free when it is free, in words. That is the fact a
          board exists to show at a glance: "the card is idle while these two
          compile" is exactly as interesting as knowing what is running.
        -->
        <div class="slots">
          @for (slot of view.slots(); track slot.key) {
            <article class="slot-card"
                     [class.gpu]="slot.lane === 'gpu'"
                     [class.idle]="slot.occupant === null">
              <div class="slot-strip" [title]="slot.hint">
                <span>{{ slot.lane === 'gpu' ? 'GPU' : 'CPU' }} · slot {{ slot.index }} of {{ slot.of }}</span>
                @if (slot.occupant; as busy) {
                  <button class="btn stop" (click)="queue.cancel(busy.id)"
                          [attr.aria-label]="'Cancel ' + view.label(busy)"
                          title="Stop this run and free the slot. A cancelled job is recorded as cancelled; the rest of the queue carries on.">
                    ✕ Cancel this run
                  </button>
                }
              </div>

              @if (slot.occupant; as busy) {
                <div class="slot-book">
                  <div class="min grow">
                    <div class="act">{{ view.label(busy) }}</div>
                    <div class="sub" [title]="view.paths(busy)">{{ kindLine(busy) }}</div>
                  </div>
                  @if (view.determinate(busy)) {
                    <!--
                      HOW FAR, AND HOW MUCH LONGER, stacked in the same corner
                      because they are two readings of one thing and the page has
                      the width to give them both. The percentage is the
                      measurement and stays the big number; the estimate sits
                      under it small and grey, which is the weighting the two
                      deserve — one is what has happened, the other is a forecast
                      of what has not.

                      It is drawn only when there is one. \`QueueEtaService\`
                      says nothing until it has watched the count move, starts a
                      new clock at every phase boundary, and takes the estimate
                      away when the count stops — so this corner is a percentage
                      alone for the first stretch of every run, and again the
                      moment a run goes quiet.

                      ON A RUN WITH TWO STAGES BOTH NUMBERS ARE THE STAGE THAT
                      IS COUNTING, which is the one thing they could honestly be:
                      ranking sentences and verifying passages are unrelated
                      quantities (the estimate drops its clock at the boundary
                      for exactly that reason), so a combined percentage would be
                      an average of two things that do not average. The corner
                      therefore agrees with whichever of the two bars below is
                      moving.
                    -->
                    <div class="right">
                      <div class="pct">{{ view.percent(busy) }}%</div>
                      @if (view.timeLeft(busy); as left) {
                        <div class="eta">{{ left }}</div>
                      }
                    </div>
                  }
                </div>

                @if (view.stageBars(busy); as stages) {
                  <!--
                    TWO STAGES, TWO BARS — Owen's ruling, and the argument is in
                    \`stageBars\`: an analysis ranks every sentence and then
                    verifies the survivors, and one bar over both filled to the
                    end and started again, which reads as a fault rather than as
                    a second pass. The stage that has not started is drawn dimmed
                    rather than left out, because an empty bar with a name on it
                    is how the run says there is another pass coming.

                    The count rides the stage it belongs to and the sentence
                    below is dropped for these rows: it would say the same words
                    the moving stage's own line already says.
                  -->
                  <div class="stages">
                    @for (stage of stages; track stage.key) {
                      <div class="stage" [class.idle]="!stage.active && !stage.done">
                        <span class="stage-name">{{ stage.label }}</span>
                        <div class="bar"><i [style.width.%]="stage.percent"></i></div>
                        @if (stage.count) {
                          <span class="stage-count">{{ stage.count }}</span>
                        }
                      </div>
                    }
                  </div>
                } @else {
                  <div class="bar" [class.indeterminate]="!view.determinate(busy)">
                    <i [style.width.%]="view.percent(busy)"></i>
                  </div>

                  <!--
                    THE FULL PROGRESS SENTENCE, both halves of it. The count says
                    how far; the line under it is whatever the engine last said
                    that was NOT a count — the retry, the fallback, the block it is
                    chewing on. A count alone cannot tell working from wedged, and
                    a person who believes a job is hung kills it: an hour of GPU
                    thrown away by the progress display. The page has room, so it
                    spends more of the sentence than the dropdown can.
                  -->
                  <p class="step">{{ view.stepLine(busy) }}</p>
                }
                @if (view.stepDetail(busy, 400); as detail) {
                  <p class="note-line" [title]="busy.note ?? busy.message ?? ''">{{ detail }}</p>
                }
              } @else {
                <div class="free">
                  <div class="free-head">Free</div>
                  <div class="free-sub">Nothing running in this slot</div>
                </div>
              }
            </article>
          }
        </div>
      </section>

      <!-- ── The sections that are not lanes ─────────────────────────────── -->
      <!--
        AN INSTALL HOLDS THE WHOLE MACHINE AND A MINT HOLDS NOTHING, so neither
        belongs in a slot and neither has an occupancy to report. They draw only
        when they have rows — the shared table is what decides which is which
        (shared/queue-board.ts), the same table the scheduler rations by. Their
        heads are named for what they DO to the board, because that is the fact
        a person reading a queue needs: one of them is why nothing else is
        moving, the other is why something is moving that no slot accounts for.
      -->
      @for (section of view.board(); track section.key) {
        @if (section.head === 'The whole machine' || section.head === 'Beside the lanes') {
          <section class="band">
            <header class="band-head">
              <h2>{{ section.head }}</h2>
              <span class="note" [title]="section.hint">what this does to the board</span>
            </header>
            <article class="card">
              @for (job of section.rows; track job.id) {
                <div class="qrow">
                  <div class="min grow">
                    <div class="qname" [title]="view.paths(job)">{{ view.label(job) }}</div>
                    <div class="sub">{{ stateLine(job) }}</div>
                  </div>
                  <div class="qright">
                    @if (job.state === 'held' || job.state === 'queued') {
                      <button class="btn stop" (click)="queue.remove(job.id)"
                              [attr.aria-label]="'Remove ' + view.label(job) + ' from the queue'"
                              title="Take this out of the queue. It never ran, so there is nothing to undo.">✕ Remove</button>
                    } @else if (job.state === 'running') {
                      <button class="btn stop" (click)="queue.cancel(job.id)"
                              [attr.aria-label]="'Cancel ' + view.label(job)"
                              title="Stop this run. A cancelled job is recorded as cancelled.">✕ Cancel</button>
                    }
                  </div>
                </div>
              }
            </article>
          </section>
        }
      }

      <!-- ── Up next ─────────────────────────────────────────────────────── -->
      @if (view.waitingBooks().length > 0) {
        <section class="band">
          <header class="band-head">
            <h2>Up next</h2>
            <span class="note">{{ waitingCount() }} waiting across {{ view.waitingBooks().length }} books</span>
          </header>

          <!--
            GROUPED BY THE BOOK, because that is how a batch is assembled: a
            person adds work a book at a time, and a flat list of eleven rows is
            eleven readings of the same four titles. The rows inside a group are
            in QUEUE ORDER, which is the order Start will release them in — the
            grouping is presentation and never a re-sort.
          -->
          @for (group of view.waitingBooks(); track group.key) {
            <article class="card">
              <div class="card-head">
                <div class="min">
                  <h3>{{ group.title }}</h3>
                  <p class="sub">{{ groupLine(group.rows) }}</p>
                </div>
              </div>

              <div class="chain">
                @for (job of group.rows; track job.id) {
                  <div class="cstep">
                    <span class="spine" aria-hidden="true"></span>
                    <span class="sdot" [class.held]="job.state === 'held'" aria-hidden="true"></span>
                    <span class="cname">{{ kindLine(job) }}</span>
                    <span class="cmid">
                      <!--
                        WHY THIS ROW IS STILL, and the difference is the user.
                        "Waiting for Start" is a job behind a button nobody has
                        pressed; "Queued" is a job behind a machine that is busy
                        and will reach it. A page that called both "Queued" would
                        leave somebody watching a still list wondering whether
                        the app had hung — which is the whole reason the held
                        state exists.
                      -->
                      @if (job.state === 'held') {
                        <span class="why hold"><span class="dot" aria-hidden="true"></span>Waiting for Start</span>
                      } @else {
                        <span class="why"><span class="dot" aria-hidden="true"></span>{{ job.message ?? 'Queued' }}</span>
                      }
                    </span>
                    <span class="cright">
                      <!--
                        REMOVE, and never "Cancel": these rows have not run. Same
                        ✕ as the dropdown's, same call, and the same verb — a
                        "Cancelled" row for a batch item somebody changed their
                        mind about is residue in exactly the list they are using
                        to see what they have assembled.
                      -->
                      <button class="btn stop xs" (click)="queue.remove(job.id)"
                              [attr.aria-label]="'Remove ' + view.label(job) + ' from the queue'"
                              title="Take this step out of the queue. It never ran, so nothing is undone.">✕ Remove</button>
                    </span>
                  </div>
                }
              </div>
            </article>
          }
        </section>
      }

      @if (queue.jobs().length === 0) {
        <section class="band">
          <div class="empty">
            <h2>Nothing is queued</h2>
            <!-- An export is deliberately not named here: it runs on the spot,
                 under the Export dialog, and never waits in this list (2026-08-23). -->
            <p>
              Read the pages of a book, or translate one, and the work is scheduled
              here — one run on the graphics card at a time, two on the processor.
            </p>
          </div>
        </section>
      }

      <!-- ── Finished ────────────────────────────────────────────────────── -->
      <!--
        HISTORY, DRAWN AS HISTORY. A table rather than more cards, because a
        finished job is a fact you scan a column of, and rows that kept the live
        rows' shape would keep asking to be read as live. The controls that
        survive are the ones a finished job actually has: the PDF opens, an
        export offers itself, and everything shows itself where it landed.
      -->
      @if (queue.finished().length > 0) {
        <section class="band">
          <header class="band-head">
            <h2>Finished · {{ queue.finished().length }}</h2>
            <span class="note">{{ queue.failed().length }} failed</span>
          </header>

          <table class="ftable">
            <thead>
              <tr>
                <th>Book</th><th>Act</th><th>Outcome</th><th></th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (job of queue.finished(); track job.id) {
                <tr>
                  <td class="b" [title]="view.paths(job)">{{ view.label(job) }}</td>
                  <td>{{ kindLine(job) }}</td>
                  <td class="outcome">{{ outcome(job) }}</td>
                  <td>
                    <span class="pill"
                          [class.ok]="job.state === 'done'"
                          [class.bad]="job.state === 'failed'">{{ job.state }}</span>
                  </td>
                  <td class="acts">
                    @if (job.state === 'done' && job.kind !== 'env-install') {
                      @if (job.kind === 'pdf') {
                        <button class="btn xs" (click)="view.open(job)"
                                title="Open this PDF in a tab">Open</button>
                      }
                      @if (view.filed(job)) {
                        <button class="btn xs" (click)="view.saveCopy(job)"
                                title="Save a copy of this export">Save…</button>
                      }
                      <button class="btn xs" (click)="view.reveal(job)"
                              [attr.aria-label]="'Show ' + view.label(job) + ' in the file manager'"
                              title="Show it in the file manager">↗</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </section>
      }
    </div>
    }
  `,
  styles: [`
    /* The Settings page's own shell, so the two routes in this app are the same
       kind of surface: a scrolling column with a head at the top of it. */
    :host { display: block; height: 100%; overflow-y: auto; }
    /* Centred in the window, not hugging its left edge -- Owen (2026-08-22):
       "instead of aligning to the left, maybe align the queue page in the
       center." The cap is unchanged; the auto margins are the whole move. */
    .page { padding: 20px 24px 60px; max-width: 1100px; margin: 0 auto; }

    .min { min-width: 0; }
    .grow { flex: 1; }

    .page-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
    .page-head h1 { margin: 0; font-size: 20px; font-weight: 600; }
    .head-note { flex: 1; font-size: 12px; color: var(--text-tertiary); }

    /* ── Bands ─────────────────────────────────────────────────────────── */

    .band { margin-top: 20px; }
    .band-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
    .band-head h2 {
      margin: 0;
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.13em; text-transform: uppercase;
      color: var(--text-tertiary);
    }
    .band-head.bad h2 { color: var(--error); }
    .band-head .note {
      margin-left: auto;
      font-size: 11px; color: var(--text-muted);
      display: flex; align-items: center; gap: 10px;
    }

    /* ── Cards ─────────────────────────────────────────────────────────── */

    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      margin-bottom: 10px;
      overflow: hidden;
    }
    .card.failed { border-color: var(--error); }

    .card-head { display: flex; align-items: center; gap: 11px; padding: 11px 14px; }
    .card-head h3 { margin: 0; font-size: 15px; font-weight: 600; color: var(--text-primary); }
    .card-head .sub { margin: 2px 0 0; font-size: 13px; }

    .sub { font-size: 11px; color: var(--text-tertiary); }

    .error {
      margin: 0;
      padding: 0 14px 12px;
      font-size: 12px;
      color: var(--text-secondary);
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* ── Buttons ───────────────────────────────────────────────────────── */

    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      flex: none;
      height: 26px; padding: 0 10px;
      font-size: 11px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
      white-space: nowrap;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .btn:hover:not(:disabled) {
      color: var(--text-primary); border-color: var(--border-strong); background: var(--bg-hover);
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.xs { height: 22px; padding: 0 8px; font-size: 10.5px; }

    /*
      OUTLINED IN THE ERROR COLOUR, NEVER FILLED. Cancelling a run is
      destructive-LOOKING and only half destructive — the job stops and is
      recorded as cancelled, and nothing already written is thrown away — so the
      control has to be findable at a glance on a busy card without reading as
      "this deletes your book". It is the same argument BookForge's own Stop
      button carries, and the same treatment.
    */
    .btn.stop { border-color: var(--error); color: var(--error); font-weight: 600; }
    .btn.stop:hover:not(:disabled) {
      background: var(--error-soft); border-color: var(--error); color: var(--error);
    }

    .primary {
      display: inline-flex; align-items: center; justify-content: center;
      flex: none;
      height: 32px; padding: 0 16px;
      border: none;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 600; line-height: 1;
      cursor: pointer;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }

    /* ── The bench ─────────────────────────────────────────────────────── */

    /*
      The GPU slot is the wide one, which is a statement about the machine
      rather than about the layout: it is the lane that runs for hours and the
      one everything else waits behind. One column on a narrow window, because
      three cards at 300 pixels each is three cards nobody can read.
    */
    .slots { display: grid; grid-template-columns: 1.7fr 1fr 1fr; gap: 12px; }
    @media (max-width: 1000px) { .slots { grid-template-columns: minmax(0, 1fr); } }

    .slot-card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-top: 2px solid var(--border-default);
      border-radius: var(--radius);
      padding: 11px 13px 13px;
      min-width: 0;
    }
    .slot-card.gpu { border-top-color: var(--accent); }
    /* A free slot is drawn as an outline rather than as a filled card: it is a
       space, and it should look like one without having to be read first. */
    .slot-card.idle { border-style: dashed; border-top-style: solid; background: transparent; }

    .slot-strip {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 9px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    /* The strip is set in small uppercase tracking; a button inside it is a
       button, not more of the strip's label. */
    .slot-strip .btn {
      margin-left: auto;
      font-size: 10.5px; height: 22px; padding: 0 8px;
      letter-spacing: 0; text-transform: none;
    }

    .slot-book { display: flex; gap: 10px; align-items: flex-start; }
    .act {
      font-size: 14px; font-weight: 600; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .right { flex: none; text-align: right; font-variant-numeric: tabular-nums; }
    .pct { font-size: 17px; font-weight: 600; color: var(--accent); }
    /* The forecast, under the measurement and a good deal quieter than it —
       the argument is at the markup. It never wraps, because "~1h 10m left" is
       the longest thing it says and a slot card must not reflow around it. */
    .eta { margin-top: 2px; font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }

    .bar {
      height: 5px;
      border-radius: 3px;
      background: var(--bg-sunken);
      overflow: hidden;
      margin-top: 10px;
    }
    .bar i {
      display: block; height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, var(--accent-hover), var(--accent));
      transition: width 0.4s ease;
    }
    /* No honest fraction, no claim of one: the fill slides instead of measuring.
       An install only counts bytes while it is downloading, and a bar creeping
       through a checksum of five gigabytes would be an animation, not a
       measurement. */
    .bar.indeterminate i { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(320%); }
    }

    /*
      ── THE TWO STAGES OF AN ANALYSIS ────────────────────────────────────────

      The slot card has the width the dropdown's row does not, so the stack is
      the same three columns with more room in them: the name is legible at the
      card's own size and the count sits at the right edge where the eye already
      goes for the percentage. Same shape in both surfaces on purpose — a person
      who has learned to read the pair in the dropdown should not have to learn
      it again here.
    */
    .stages { display: flex; flex-direction: column; gap: 7px; margin-top: 10px; }
    .stage {
      display: grid;
      grid-template-columns: 68px minmax(0, 1fr) max-content;
      align-items: center;
      gap: 10px;
    }
    /* The stack's gap does the spacing, so the bars inside it carry none — and
       they are a pixel thinner than the single bar, so two of them read as two
       smaller measurements rather than as twice the one they replace. */
    .stage .bar { height: 4px; margin-top: 0; }
    .stage-name { font-size: 11px; color: var(--text-tertiary); white-space: nowrap; }
    .stage-count {
      font-size: 11.5px;
      color: var(--text-tertiary);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    /* Not started: quieter in both parts, so the eye lands on the stage that is
       moving. Never hidden — an empty bar with a name on it is the run saying
       there is another pass coming. */
    .stage.idle .stage-name { color: var(--text-muted); }
    .stage.idle .bar { opacity: 0.55; }

    .step { margin: 9px 0 0; font-size: 12px; color: var(--text-secondary); }
    .note-line {
      margin: 5px 0 0;
      font-size: 11.5px; line-height: 1.45;
      color: var(--text-tertiary);
      word-break: break-word;
    }

    .free { padding: 12px 0 6px; text-align: center; }
    .free-head { font-size: 12px; color: var(--text-tertiary); }
    .free-sub { font-size: 10px; color: var(--text-muted); margin-top: 3px; }

    /* ── Rows off the lanes, and the chain ─────────────────────────────── */

    .qrow { display: flex; align-items: center; gap: 10px; padding: 9px 14px; }
    .qrow + .qrow { border-top: 1px solid var(--border-subtle); }
    .qname {
      font-size: 13px; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .qright { display: flex; align-items: center; gap: 6px; flex: none; }

    .chain { padding: 0 14px 10px; }

    /*
      THE NAME AND ITS STATUS SIT TOGETHER, and the one flexible column is at the
      END so the controls hold the right edge. BookForge learned this the hard
      way — Owen, on its first version: *"its very, very tiny. and very spaced
      out."* — because a fixed-width name column put a gap between every short
      label and its status, and then a second, larger gap before the controls:
      three related facts about one step reading as three unrelated columns.
    */
    .cstep {
      display: grid;
      grid-template-columns: 16px minmax(0, 220px) minmax(0, max-content) 1fr;
      align-items: center;
      gap: 10px;
      padding: 7px 0;
      position: relative;
    }

    /* The thread down the group: what makes a book's waiting rows read as one
       batch rather than as four unrelated lines that happen to be adjacent. */
    .spine {
      position: absolute;
      left: 7px; top: -4px; bottom: -4px;
      width: 2px;
      background: var(--border-default);
    }
    .cstep:first-child .spine { top: 50%; }
    .cstep:last-child .spine { bottom: 50%; }

    .sdot {
      width: 15px; height: 15px;
      border-radius: 50%;
      position: relative;
      z-index: 1;
      background: var(--bg-elevated);
      box-sizing: border-box;
      border: 2px dashed var(--text-muted);
    }
    /* Held is the accent because the accent is what Start wears: the rows and
       the control that releases them are visibly the same subject. */
    .sdot.held { border-color: var(--accent); background: var(--accent-soft); }

    .cname {
      font-size: 14px;
      color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .cmid { min-width: 0; }
    .cright { display: flex; align-items: center; gap: 8px; justify-self: end; }

    .why {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      min-width: 0;
      padding: 2px 8px;
      border-radius: 3px;
      background: var(--bg-input);
      color: var(--text-tertiary);
      font-size: 12px;
      overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
    }
    .why .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
    .why.hold { background: var(--accent-soft); color: var(--accent); }

    /* ── Finished ──────────────────────────────────────────────────────── */

    .ftable { width: 100%; border-collapse: collapse; font-size: 12px; }
    .ftable th {
      text-align: left;
      font-size: 9px; font-weight: 400;
      letter-spacing: 0.11em; text-transform: uppercase;
      color: var(--text-muted);
      padding: 0 10px 6px 0;
      border-bottom: 1px solid var(--border-subtle);
    }
    .ftable td {
      padding: 7px 10px 7px 0;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      vertical-align: middle;
    }
    .ftable td.b { color: var(--text-primary); }
    .ftable td.outcome { color: var(--text-secondary); }
    .ftable td.acts { text-align: right; white-space: nowrap; }
    .ftable td.acts .btn + .btn { margin-left: 6px; }

    .pill {
      display: inline-block;
      font-size: 9px;
      padding: 1px 8px;
      border-radius: 999px;
      background: var(--bg-input);
      color: var(--text-tertiary);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .pill.ok { background: var(--accent-soft); color: var(--accent); }
    .pill.bad { background: var(--error-soft); color: var(--error); }

    /* ── Empty ─────────────────────────────────────────────────────────── */

    .empty { text-align: center; padding: 48px 20px; color: var(--text-tertiary); }
    .empty h2 { margin: 0 0 8px; font-size: 18px; font-weight: 600; color: var(--text-primary); }
    .empty p { margin: 0 auto; max-width: 52ch; font-size: 13px; line-height: 1.55; }

    @media (prefers-reduced-motion: reduce) {
      .bar i { transition: none; }
      .bar.indeterminate i { animation: none; width: 100% !important; }
    }
  `],
})
export class QueuePageComponent {
  /** The route already refuses hosted; this is the other half. See the header. */
  protected readonly hosted = hosted;
  protected readonly queue = inject(QueueService);
  protected readonly view = inject(QueueViewService);

  /** How many rows are waiting, across every book — the band's own count. */
  protected waitingCount(): number {
    return this.queue.held().length + this.queue.queued().length;
  }

  /**
   * WHAT KIND OF WORK THIS IS, in the words the rest of the app uses.
   *
   * The row above it already says which BOOK, so this line answers the other
   * half of "what is this" — and it is the column BookForge calls "Act". No
   * filenames and no job kinds spelled the way the wire spells them: a person
   * ordered a reading, or an export, and that is what they should read back.
   *
   * A translation and a simplify are one kind on the wire (a simplify is a
   * rewrite prompt on the translate command) and this does not try to tell them
   * apart, because the row's own title already does: a simplify carries a title
   * of its own, which is where the distinction is really kept.
   */
  protected kindLine(job: Job): string {
    switch (job.kind) {
      case 'read': return 'Reading the pages';
      case 'translate': return 'Translating';
      case 'epub': return 'Casting the book';
      case 'pdf': return 'Reprinting';
      case 'txt': return 'Plain text';
      case 'mint': return 'Assembling the photographs';
      case 'env-install': return 'Installing the environment';
      /*
       * "Reading against the categories" and not "Analysing", because the word
       * alone says nothing about what is being done to somebody's book — and this
       * column is the one place a person scanning a queue of expensive rows finds
       * out what each of them is FOR. It is the book being read a second time,
       * against a checklist (docs/ANALYSIS.md §1), which is exactly the sentence.
       */
      case 'analysis': return 'Reading against the categories';
    }
  }

  /**
   * WHAT BECAME OF IT — the finished table's outcome column.
   *
   * A job names what it DID, not what it wrote: a reading's product is the bank
   * and the book follows from it, so "Read · the book follows" is the true
   * sentence where a filename would be this app showing somebody a name out of
   * its own bookkeeping. The same words the dropdown's done rows use, from the
   * same `made()`, for the reason both surfaces share one service at all.
   */
  protected outcome(job: Job): string {
    if (job.state === 'failed') return this.view.failureLine(job.error);
    if (job.state === 'cancelled') return 'Cancelled';
    if (job.kind === 'env-install') return 'Installed';
    if (job.kind === 'read') return 'Read · the book follows';
    if (job.kind === 'translate') return 'Translated · the book follows';
    return this.view.made(job);
  }

  /**
   * A book's waiting rows, counted and told apart by what they are waiting on.
   *
   * The group header is the one place the shape of the batch is visible — "3
   * steps, all waiting for Start" is what somebody assembling a batch is
   * checking — and the two waits are never added together, because they are the
   * two different facts this queue is built around.
   */
  protected groupLine(rows: readonly Job[]): string {
    const held = rows.filter((job) => job.state === 'held').length;
    const queued = rows.length - held;
    const parts = [
      held > 0 ? `${held} waiting for Start` : null,
      queued > 0 ? `${queued} queued` : null,
    ].filter((part) => part !== null);
    return parts.join(' · ');
  }

  /**
   * One waiting row's state, for the off-lane sections that have no chain.
   *
   * THE ESTIMATE IS ON THIS LINE TOO, and it is not a special case: these
   * sections hold the install and the mint, and a mint counts photographs being
   * rectified in this very window (`noteMintPage`) — which is a count like any
   * other and the one job in the app whose progress is nobody's process to ask.
   * An install has no fraction at all (it counts megabytes in a field of its
   * own) so it simply never has one to draw, which is the same silence every
   * other row gets before its count has moved.
   */
  protected stateLine(job: Job): string {
    if (job.state === 'held') return 'Waiting for Start';
    if (job.state === 'running') {
      const left = this.view.timeLeft(job);
      const line = this.view.stepLine(job);
      return left === '' ? line : `${line} · ${left}`;
    }
    if (job.state === 'queued') return job.message ?? 'Queued';
    return this.outcome(job);
  }
}
