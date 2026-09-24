import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { QueueService } from '../../core/queue.service';
import { QueueViewService } from '../../core/queue-view.service';
import { UiService } from '../../core/ui.service';
import { hosted } from '../../core/foundry';

/**
 * THE QUEUE BAR — the chip in the window's top-right corner, and the panel it
 * opens.
 *
 * Owen's ruling, 2026-08-22, verbatim:
 *
 *   *"looks like we didnt implement a bookforge-style queue. can you make the
 *   queue shelf a bar along the top right that i can click and look at, and put
 *   a button in it for 'more info' thatll take me to a queue page that looks
 *   like bookforge's queue page? this is just ui work mostly, not changing the
 *   way it works on an engine level."*
 *
 * The last sentence is the fence and it was kept: the scheduler, the slot table,
 * the drain contract, the held/Start semantics and every door on `QueueService`
 * are untouched. What changed is where the same facts are drawn.
 *
 * ── THE GRAVESTONE: the bottom-right shelf, and where each of its jobs went ──
 *
 * `QueueShelfComponent` is deleted. It was a pill docked in the bottom-right
 * corner that unrolled upward, modelled on BookForge's setup-download dock —
 * which, it turns out, is the wrong BookForge component to have copied: that one
 * is the first-run DOWNLOAD dock, and BookForge's actual queue is a chip in the
 * title bar with a dropdown under it and a page behind that. Owen noticed. So
 * this is not a redesign of the shelf; it is the shelf finally being modelled on
 * the thing it was always meant to resemble.
 *
 * NOT ONE OF ITS BEHAVIOURS DIED. Every one is named here so that a person
 * looking for the shelf finds out where its job went rather than whether it had
 * one:
 *
 *   the collapsed pill's headline    → the chip's line, from the same computed
 *                                      (`QueueViewService.headline`, moved
 *                                      wholesale, not respelled)
 *   the aggregate bar following GPU  → the hairline along the chip's bottom edge
 *   the expanded board               → this panel, and the queue page
 *   the two-meaning ✕                → unchanged in both surfaces: a running job
 *                                      is CANCELLED, a held or queued one is
 *                                      REMOVED, and the titles still say which
 *   Start, carrying the count        → this panel's foot, and the page's head
 *   Clear finished                   → beside it, in both
 *   the export-done unroll           → opens this panel (see the constructor)
 *   `focusShelfAt` → Start           → `focusStartAt`, focusing Start in here
 *   the sr-only live region          → the first element in this template
 *   `@if (!hosted())`                → unchanged, absolutely: see below
 *
 * And one thing was deliberately NOT carried: the shelf drew nothing at all with
 * an empty queue. This chip is always there standalone, because a bar you can
 * *"click and look at"* is not a bar that disappears when there is nothing in
 * it — and because the panel is where Start lives, so a queue you cannot open
 * when it is empty is one you cannot begin. BookForge's own empty chip is a
 * quiet glyph reading "Queue" for exactly that reason, and this one is too. The
 * price is real and is named: the standalone window's top row costs about 34
 * pixels now, where it cost nothing before.
 *
 * ── HOSTED, THERE IS NO QUEUE SURFACE OF FOUNDRY'S. NONE. ───────────────────
 *
 * Owen's earlier ruling, 2026-08-21, verbatim: *"when im in bookforge, the shelf
 * shouldnt appear at all. thats the hangup. bookforge should be using its own
 * queue."* That survives this wave without a scratch, and it now covers three
 * surfaces instead of one: this chip, this panel and the queue page are all
 * behind the same gate. The hosted window's queue IS the host's, its rows draw
 * in the host's own chrome, and its held reads are released from the host's own
 * queue page.
 *
 * The corner this chip sits in is the corner the HOST STATUS CHIP has hosted
 * (Wave 14) — and the two can never collide, because each is drawn in exactly
 * the world the other is not: the host's chip has nothing to say standalone (no
 * host ever pushes, its host element is display:none), and this one is not
 * rendered hosted at all.
 *
 * ── The panel is a plain anchored box and not an overlay ────────────────────
 *
 * BookForge parents its tray in a CDK overlay, for a reason that is about its
 * window and not about ours: its chip sits in a 40px title bar with its own
 * stacking context and `-webkit-app-region: drag`, so a child panel would be
 * clipped, would sit under the window body, and would be DRAGGABLE. Foundry's
 * top row is an ordinary flex row of the shell with nothing clipping it, so an
 * absolutely-positioned child is the whole mechanism — and this app has no CDK
 * dependency, which is not a thing to add for one dropdown.
 */
@Component({
  selector: 'app-queue-bar',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Reflected onto the host so the row can take itself out of the shell's
  // layout hosted, exactly the way the host status chip does — see the styles.
  host: { '[class.up]': '!hosted()' },
  template: `
    @if (!hosted()) {
    <!--
      WHAT JUST HAPPENED, said out loud. The dialogs close on Add now and move
      focus here, so the confirmation they used to leave on screen has to arrive
      some other way for anybody not watching the corner. Polite rather than
      assertive: a job being queued is news, not an interruption.

      It lived on the shelf and it lives here for the same reason it lived
      there — with the surface the sentences are ABOUT. Its text is the same
      signal, merely renamed with the chrome it belongs to.
    -->
    <p class="sr-only" role="status" aria-live="polite">{{ ui.queueSaid() }}</p>

    <!--
      THE CHIP. Three marks and a line: what state the queue is in, what it is
      doing, and how far along the run that costs hours is. The mark and the
      sentence are the shelf's own, unchanged.

      NO COUNT BADGES, unlike BookForge's chip, and that is a deliberate
      subtraction rather than an omission. Its chip carries a waiting badge and
      a failed badge because its headline names only the running book; ours
      already says "· 3 queued, 2 held" in words, and a number repeating what
      the sentence beside it just said is furniture that has to be kept in step
      with the sentence forever.
    -->
    <button type="button" class="chip"
            [class.running]="view.leading() !== null"
            [class.bad]="view.leading() === null && queue.failed().length > 0"
            [class.quiet]="empty()"
            [attr.aria-expanded]="ui.queueOpen()"
            aria-haspopup="dialog"
            [attr.aria-label]="chipLabel()"
            (click)="toggle()">
      @if (empty()) {
        <span class="glyph" aria-hidden="true">⏳</span>
      } @else if (view.leading()) {
        <span class="spinner" aria-hidden="true"></span>
      } @else if (queue.failed().length > 0) {
        <span class="mark bad" aria-hidden="true">!</span>
      } @else {
        <span class="mark ok" aria-hidden="true">✓</span>
      }
      <span class="what">{{ view.headline() }}</span>
      <span class="chev" aria-hidden="true">{{ ui.queueOpen() ? '▴' : '▾' }}</span>

      <!--
        HOW FAR ALONG, as a hairline along the bottom edge rather than as a
        number in the row. The chip is a glance; a percentage competing with the
        book's name would make it a reading. It is the host status chip's own
        anatomy, because these are two chips in one corner of one window and the
        second one should not invent a second way of showing a fraction.

        It follows the GPU lane's run and says so in the computed that picks it
        — the argument is in QueueViewService.leading, where it has always been.

        ONE HAIRLINE EVEN FOR THE RUN THAT HAS TWO STAGES, and that is a decision
        rather than an oversight. The panel below draws an analysis as two bars
        because a bar that fills twice reads as a fault; this is two pixels of
        the chip's bottom edge, and splitting them in half would produce two
        one-pixel rules that no glance can tell apart, let alone tell which is
        which — the shape that answers the complaint at 420 pixels wide creates a
        new one at 2. So the edge measures the stage that is RUNNING, which is
        what a hairline can honestly say: how the thing happening now is getting
        on. Somebody who wants to know which pass that is opens the panel, which
        is the gesture this whole chip exists to invite.
      -->
      @if (view.leading(); as active) {
        <span class="edge"><i [style.width.%]="view.percent(active)"></i></span>
      }
    </button>

    @if (ui.queueOpen()) {
      <!--
        THE PANEL — the thing Owen asked to be able to click and look at. It is
        the shelf's expanded board, re-housed: the same lane sections off the
        same shared table, the same rows, the same two meanings of ✕, the same
        Start with its count. What is new is the door at the bottom.
      -->
      <div #panel class="panel" role="dialog" aria-label="Queue" tabindex="-1">
        <div class="panel-head">
          <span class="eyebrow">Queue</span>
          <span class="note">{{ view.busySlots() }} of {{ view.slots().length }} slots in use</span>
        </div>

        <div class="panel-body">
          @if (queue.jobs().length === 0) {
            <!-- Not "or export one" any more: an export runs on the spot, under
                 the dialog that asked for it, and never waits here (2026-08-23). -->
            <p class="empty">Nothing is queued. Read the pages of a book, or translate one, and
              the work turns up here.</p>
          }

          @for (section of view.board(); track section.key) {
          <!--
            THE LANE, drawn only when the board holds more than one kind of
            work — the service's own note carries the argument. A rule across
            the panel rather than a row, in BookForge's section idiom: the one
            mistake available here is a head that looks clickable, and every
            other strip in this panel either navigates or cancels.
          -->
          @if (section.head !== null) {
            <div class="sec" [title]="section.hint">
              <span>{{ section.head }} · {{ section.slots }}</span>
              <span class="rule"></span>
            </div>
          }
          @if (section.head !== null && section.rows.length === 0) {
            <p class="lane-idle">Free — nothing queued wants this slot</p>
          }
          @for (job of section.rows; track job.id) {
            <div class="row" [attr.data-state]="job.state">
              <div class="row-top">
                <!--
                  THE BOOK, and the files one hover away. A row here used to be
                  the input's basename, which is the name of a copy in a folder
                  this app never shows anybody. Both paths are in the tooltip,
                  because "where did that actually get written" is the question a
                  person asks about a finished job.
                -->
                <span class="name" [title]="view.paths(job)">{{ view.label(job) }}</span>
                <!--
                  TWO GESTURES THAT LOOK THE SAME AND ARE NOT. A running job is
                  CANCELLED — a child is holding a GPU, stopping it is a real
                  event, and the row that records it afterwards is worth having.
                  A held or queued job is REMOVED: it never ran, so there is
                  nothing to stop, and a "Cancelled" row for a batch item
                  somebody simply changed their mind about is residue in the one
                  list they are using to see what they have assembled. Same ✕,
                  different verb, and the titles say which.
                -->
                @if (job.state === 'held' || job.state === 'queued') {
                  <button class="x" (click)="queue.remove(job.id)"
                          title="Remove from the queue"
                          [attr.aria-label]="'Remove ' + view.label(job) + ' from the queue'">✕</button>
                } @else if (job.state === 'running') {
                  <button class="x" (click)="queue.cancel(job.id)"
                          title="Cancel"
                          [attr.aria-label]="'Cancel ' + view.label(job)">✕</button>
                } @else if (job.state === 'done' && job.kind !== 'env-install') {
                  <!--
                    Open comes FIRST because it is what a finished conversion is
                    for. Reveal stays beside it: the book is in the app's
                    workspace until it is saved a copy of, and "where is it
                    actually" is a fair question to be able to answer. Only the
                    PDF opens — there is one viewer for a file in this app, and
                    an export is the door OUT of it, not a surface inside it.
                  -->
                  @if (job.kind === 'pdf') {
                    <button class="tiny" (click)="view.open(job)"
                            title="Open this PDF in a tab">Open</button>
                  }
                  @if (view.filed(job)) {
                    <button class="tiny" (click)="view.saveCopy(job)"
                            title="Save a copy of this export">Save…</button>
                  }
                  <button class="x" (click)="view.reveal(job)" title="Show it in the file manager">↗</button>
                }
              </div>

              @switch (job.state) {
                @case ('running') {
                  @if (view.stageBars(job); as stages) {
                    <!--
                      A RUN WITH TWO STAGES GETS TWO BARS, one under the other.
                      Owen: *"could be good to have two different smaller
                      progress bars, after the bookforge queue model."* An
                      analysis ranks every sentence and then verifies the
                      survivors, and one bar over both filled to the end and
                      started again — a measurement that un-completes, which
                      reads as a fault in the app rather than as a second pass.
                      Which stage is running, how far each got and what the
                      counting one is counting are all \`stageBars\`, where the
                      whole argument lives; this is only the drawing of it.

                      THE COUNT AND THE ESTIMATE RIDE THE STAGE THAT IS
                      COUNTING, on the row that has the bar they are about, so
                      neither of them has to be labelled twice. The stage that
                      has not started says its name and nothing else.
                    -->
                    <div class="stages">
                      @for (stage of stages; track stage.key) {
                        <div class="stage" [class.idle]="!stage.active && !stage.done">
                          <span class="stage-name">{{ stage.label }}</span>
                          <div class="bar"><i [style.width.%]="stage.percent"></i></div>
                          @if (stage.count) {
                            <span class="stage-count">{{ stage.count }}@if (view.timeLeft(job); as left) {<span class="eta"> · {{ left }}</span>}</span>
                          }
                        </div>
                      }
                    </div>
                  } @else {
                    <!--
                      Indeterminate whenever there is no honest fraction: an env
                      install only counts bytes during its download phase, and a
                      bar that kept moving through a sha256 of five gigabytes would
                      be an animation, not a measurement.
                    -->
                    <div class="bar" [class.indeterminate]="!view.determinate(job)">
                      <i [style.width.%]="view.percent(job)"></i>
                    </div>
                    <!--
                      THE COUNT, AND HOW MUCH LONGER — one line, because they are
                      one thought and a row here has three lines to spend in total.
                      The estimate is the quieter of the two on purpose: the
                      fraction is a measurement of what has happened and this is a
                      forecast of what has not, and a row that drew them at the
                      same weight would be inviting the guess to be read as the
                      fact. Absent for most of a job's life — see
                      \`QueueEtaService\`, which will not say a number until it has
                      watched the count move, drops the clock at every phase
                      boundary, and takes the estimate away when the count stops.
                    -->
                    <span class="sub">{{ view.stepLine(job) }}@if (view.timeLeft(job); as left) {<span class="eta"> · {{ left }}</span>}</span>
                  }
                  <!--
                    THE STEP TAKING PLACE, which is the thing Owen could not see.
                    The count says how far; this says what the engine is actually
                    doing — the answer it rejected and is asking again, the page
                    it fell back on, the record it is writing onto a finished
                    book. Only ever drawn when there IS a count, because without
                    one the line above is already the engine's own words.
                  -->
                  @if (view.stepDetail(job); as detail) {
                    <span class="detail" [title]="job.note ?? job.message ?? ''">{{ detail }}</span>
                  }
                }
                <!--
                  "Waiting for Start" and not "Queued", because the two are
                  different facts and the user is the difference. A queued job is
                  behind a machine that is busy and will reach it; a held one is
                  behind a button nobody has pressed, and a panel that called
                  both "Queued" would leave somebody watching a still list
                  wondering whether the app had hung.
                -->
                @case ('held') {
                  <span class="why hold"><span class="dot" aria-hidden="true"></span>Waiting for Start</span>
                }
                @case ('queued') {
                  <span class="why"><span class="dot" aria-hidden="true"></span>{{ job.message ?? 'Queued' }}</span>
                }
                @case ('done') {
                  <span class="sub ok" [title]="job.message ?? ''">
                    <!--
                      A JOB NAMES WHAT IT DID, not what it wrote. A reading's
                      product is the bank, and naming the file it landed in would
                      be this app showing somebody a name out of its own
                      bookkeeping instead of telling them their book had been
                      read. The engine's own last line is the tooltip either way,
                      and both paths are on the name above.
                    -->
                    @if (job.kind === 'env-install') { Installed }
                    @else if (job.kind === 'read') { Read · the book follows }
                    @else if (job.kind === 'translate') { Translated · the book follows }
                    @else if (job.kind === 'simplify') { Simplified · the book follows }
                    @else if (job.kind === 'clean') { Cleaned · the book follows }
                    @else { Done · {{ view.made(job) }} }
                  </span>
                }
                @case ('cancelled') { <span class="sub">Cancelled</span> }
                @case ('failed') {
                  <span class="sub bad" [title]="job.error ?? ''">{{ view.failureLine(job.error) }}</span>
                }
              }
            </div>
          }
          }
        </div>

        <!--
          THE FOOT, and the door Owen asked for is in it.

          MORE INFO IS ON THE LEFT, away from the two controls that DO
          something, because it is the one thing here that only takes you
          somewhere — BookForge's own tray puts its "Open the queue →" in
          exactly that corner. It is a link and not a button because it
          navigates: middle-click and the keyboard get what they expect, and the
          router closes the panel on the way (see \`goPage\`).

          START IS THE PRIMARY ACTION AND SITS WHERE A PRIMARY ACTION SITS —
          last, on the right, the way every dialog in this app puts its commit
          button. It carries the COUNT because the number is the thing being
          committed to: "Start 4" is a person confirming the batch they just
          assembled, where a bare "Start" would be a button they press to find
          out what happens. Disabled with nothing held rather than hidden, so
          the foot does not change shape as rows come and go.
        -->
        <div class="panel-foot">
          <a class="details" routerLink="/queue" (click)="goPage()">More info →</a>
          <span class="spacer"></span>
          <button class="tiny" [disabled]="queue.finished().length === 0"
                  (click)="queue.clearFinished()">Clear finished</button>
          <button #start class="primary" [disabled]="queue.held().length === 0"
                  [attr.aria-label]="view.startLabel()"
                  [title]="view.startLabel()"
                  (click)="queue.start()">
            Start@if (queue.held().length > 0) { <span>&nbsp;{{ queue.held().length }}</span> }
          </button>
        </div>
      </div>
    }
    }
  `,
  styles: [`
    /*
      ── THE ROW COSTS NOTHING IN THE WINDOW THAT MUST NOT HAVE IT ────────────

      Hosted this is display:none — not visibility, not opacity, not a
      zero-height box — so a hosted window's chrome is byte for byte the chrome
      of one that never mounted this component. The padding is on the host
      rather than on a wrapper inside it, which is what makes that true.

      \`position: relative\` because the panel hangs off it, and the z-index is
      the shelf's old rung: viewer < queue 900 < drag veil 1000 < toasts 1100 <
      dialogs 1200. The ladder did not move; only the thing on this rung did.
    */
    :host { display: none; }
    :host(.up) {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: 6px 12px 0;
      position: relative;
      z-index: 900;
    }

    /* Read, never seen. Clipped rather than display:none or visibility:hidden,
       because both of those take the element out of the accessibility tree and
       a live region nothing can reach announces nothing. */
    .sr-only {
      position: absolute;
      width: 1px; height: 1px;
      margin: -1px; padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      clip-path: inset(50%);
      white-space: nowrap;
      border: 0;
    }

    /* ── The chip ──────────────────────────────────────────────────────── */

    /*
      BookForge's chip, in Foundry's tokens: a pill, 28 high, the running state
      ringed in the accent and the empty state barely there at all. overflow is
      hidden twice over — the progress line is anchored to the bottom edge
      inside it, and a headline longer than the ceiling ellipses instead of
      pushing the chip across the window.
    */
    .chip {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      height: 28px;
      max-width: 420px;
      padding: 0 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 14px;
      color: var(--text-secondary);
      font: inherit;
      font-size: 12px;
      text-align: left;
      cursor: pointer;
      overflow: hidden;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .chip:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .chip:focus-visible { outline: none; box-shadow: var(--focus-ring); }
    .chip.running { border-color: var(--accent); }
    .chip.running:hover { border-color: var(--accent-hover); }
    .chip.bad { border-color: var(--error); }
    /* Empty, it is barely a control: still pressable — Start lives inside — but
       it has nothing to report and does not take the eye for saying so. */
    .chip.quiet { background: transparent; border-color: transparent; color: var(--text-tertiary); }

    .what {
      min-width: 0;
      flex: 0 1 auto;
      font-family: var(--font-display); font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .chip.quiet .what { font-weight: 500; color: inherit; }
    .chev { flex: none; color: var(--text-tertiary); font-size: 10px; }
    .glyph { flex: none; font-size: 12px; line-height: 1; }

    .spinner {
      width: 12px; height: 12px; flex: none;
      border: 2px solid var(--accent-soft);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .mark { flex: none; font-weight: 700; }
    .mark.ok { color: var(--ok); }
    .mark.bad { color: var(--error); }

    /* The host status chip's progress hairline, verbatim in shape: two pixels
       along the bottom edge of the chip, clipped by the chip's own overflow. */
    .edge {
      position: absolute;
      left: 0; right: 0; bottom: 0;
      height: 2px;
      background: var(--bg-sunken);
    }
    .edge i {
      display: block;
      height: 100%;
      background: var(--accent);
      transition: width 200ms ease;
    }

    /* ── The panel ─────────────────────────────────────────────────────── */

    /*
      Anchored under the chip with their right edges aligned, which is where a
      dropdown from a corner control belongs and what BookForge's overlay
      position says in CDK's vocabulary. The shelf's shadow verbatim: the two
      surfaces that float over this window should not hover at different
      heights.
    */
    .panel {
      position: absolute;
      top: 100%;
      right: 12px;
      margin-top: 6px;
      width: 420px;
      max-width: calc(100vw - 24px);
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      font-size: 13px;
      color: var(--text-primary);
    }
    .panel:focus { outline: none; }

    .panel-head {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .eyebrow {
      font-size: 10px; font-weight: 700;
      letter-spacing: 0.14em; text-transform: uppercase;
      color: var(--text-tertiary);
    }
    .panel-head .note { margin-left: auto; font-size: 11px; color: var(--text-muted); }

    .panel-body { max-height: min(60vh, 460px); overflow-y: auto; }

    .empty {
      margin: 0;
      padding: 22px 14px;
      text-align: center;
      color: var(--text-tertiary);
      font-size: 12px;
      line-height: 1.5;
    }

    /*
      THE LANE HEAD READS AS A RULE ACROSS THE LIST, not as a row — BookForge's
      own section idiom, which is the same decision the shelf made in different
      clothes. Sticky, so the lane a row belongs to is still legible when a long
      batch is scrolled: the body is a window, and a board whose headers scroll
      away is a list again.
    */
    .sec {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px 5px;
      background: var(--bg-elevated);
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.13em;
      text-transform: uppercase;
      color: var(--text-muted);
    }
    .sec .rule { flex: 1; height: 1px; background: var(--border-subtle); }
    /* The lane that is free says so in words rather than by being a gap. */
    .lane-idle {
      margin: 0;
      padding: 4px 14px 8px;
      font-size: 11.5px;
      color: var(--text-muted);
      font-style: italic;
    }

    .row {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 14px;
    }
    .row + .row { border-top: 1px solid var(--border-subtle); }
    .row-top { display: flex; align-items: center; gap: 8px; }
    .name {
      flex: 1; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .bar {
      height: 5px;
      border-radius: 3px;
      background: var(--bg-sunken);
      overflow: hidden;
      margin-top: 2px;
    }
    .bar i {
      display: block;
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--accent-hover), var(--accent));
      transition: width 0.4s ease;
    }
    .bar.indeterminate i { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide {
      0% { transform: translateX(-100%); }
      100% { transform: translateX(320%); }
    }

    /*
      ── THE TWO STAGES OF AN ANALYSIS ────────────────────────────────────────

      Two SMALLER bars, which is what Owen asked for and is also the only shape
      that works: a row in this panel has three lines to spend, and two bars at
      the full weight of the one they replace would be a row that shouts twice
      about one job. So the pair is set on a grid — name, bar, count — and the
      whole stack occupies about the height the single bar and its line did.

      THE STAGE THAT HAS NOT STARTED IS DIMMED AND STILL DRAWN, which is the
      point of drawing two: an empty second bar with a name on it is the run
      saying there is another pass coming, so the first one finishing does not
      have to be read as the job finishing.
    */
    .stages { display: flex; flex-direction: column; gap: 5px; margin-top: 3px; }
    .stage {
      display: grid;
      grid-template-columns: 58px minmax(0, 1fr) max-content;
      align-items: center;
      gap: 8px;
    }
    /* The bar inside a stage row carries no margin of its own — the stack's gap
       is what spaces the pair — and is a pixel thinner than the single bar, so a
       staged row reads as two smaller measurements rather than as two of it. */
    .stage .bar { height: 4px; margin-top: 0; }
    .stage-name {
      font-size: 10.5px;
      color: var(--text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .stage-count {
      font-size: 11px;
      color: var(--text-tertiary);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    /* Not started: quieter than the running stage in both of its parts, so the
       eye lands on the one that is moving. Never hidden — see the note above. */
    .stage.idle .stage-name { color: var(--text-muted); }
    .stage.idle .bar { opacity: 0.55; }

    .sub {
      font-size: 11px; color: var(--text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sub.ok { color: var(--ok); }
    .sub.bad { color: var(--error); white-space: normal; }
    /* The forecast, dimmer than the count it follows and on the same line. See
       the comment at the markup for why it is the quieter of the two. */
    .eta { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    /*
      THE STEP, WRAPPED TO TWO LINES AND NO MORE. The engine's sentences run
      long — a rejected answer names the block and the attempt — and the whole of
      one is in the hover; two lines is what a row can spend without the panel
      turning into a log window, which is what the terminal is for.
    */
    .detail {
      font-size: 11px;
      color: var(--text-muted);
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-word;
    }

    /*
      WHY THIS ROW IS STILL, in BookForge's pill. A sentence in a tinted capsule
      rather than a line of grey text, because "waiting" and "waiting for
      something you have to do" are the two states a still queue can be in and
      the difference is the whole reason somebody opened this panel.
    */
    .why {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
      max-width: 100%;
      padding: 2px 8px;
      border-radius: 3px;
      background: var(--bg-input);
      color: var(--text-tertiary);
      font-size: 11px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .why .dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex: none; }
    /*
      A held row reads as WAITING FOR SOMEBODY rather than as inert. The accent
      is the same one the Start button carries, so the row and the control that
      releases it are visibly the same subject; the left rule is what makes a run
      of them legible as a BATCH at a glance, which is the thing being assembled.
      Colour is not the only carrier — the row also says "Waiting for Start" in
      words, because a state told only in hue is a state somebody who cannot see
      the hue does not have.
    */
    .why.hold { background: var(--accent-soft); color: var(--accent); }
    .row[data-state='held'] { box-shadow: inset 2px 0 0 var(--accent); }

    /* ── Controls ──────────────────────────────────────────────────────── */

    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 12px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .tiny {
      display: inline-flex; align-items: center; justify-content: center;
      flex: none;
      height: 22px; padding: 0 9px;
      border-radius: var(--radius-sm);
      font-size: 11px; font-weight: 500; line-height: 1;
      cursor: pointer;
      background: transparent;
      border: 1px solid var(--border-default);
      color: var(--text-secondary);
      white-space: nowrap;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .tiny:hover:not(:disabled) {
      background: var(--bg-hover); border-color: var(--border-strong); color: var(--text-primary);
    }
    .tiny:disabled { opacity: 0.5; cursor: not-allowed; }

    .panel-foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      background: var(--bg-sunken);
      border-top: 1px solid var(--border-subtle);
    }
    .spacer { flex: 1; }
    .details {
      color: var(--text-tertiary);
      font-size: 11.5px;
      text-decoration: none;
      cursor: pointer;
      border-radius: var(--radius-sm);
    }
    .details:hover { color: var(--accent); }

    /* The dialogs' primary button, at the panel's smaller scale — same tokens,
       same states, so Start reads as the same kind of commit as "Add to queue". */
    .primary {
      display: inline-flex; align-items: center; justify-content: center;
      flex: none;
      height: 26px; padding: 0 12px;
      border: none;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 600; line-height: 1;
      cursor: pointer;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }

    @media (prefers-reduced-motion: reduce) {
      .spinner { animation: none; }
      .bar i { transition: none; }
      .bar.indeterminate i { animation: none; width: 100% !important; }
    }
  `],
})
export class QueueBarComponent {
  /** Hosted, the whole component renders nothing — see the class docblock. */
  protected readonly hosted = hosted;
  protected readonly queue = inject(QueueService);
  protected readonly view = inject(QueueViewService);
  protected readonly ui = inject(UiService);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly start = viewChild<ElementRef<HTMLButtonElement>>('start');

  constructor() {
    /*
     * FOCUS ARRIVES FROM THE OCR DIALOG, one press at a time.
     *
     * The counter is read and the button is focused in a microtask, because the
     * panel may have been shut a moment ago: `summonQueue` opens it in the same
     * tick, and the button does not exist in the DOM until that render has
     * happened. Focusing a button that is not there yet silently does nothing,
     * which is the failure this ordering exists to avoid.
     *
     * IT DOES NOT FIGHT THE PANEL'S OWN FOCUS. Opening the panel by CLICKING the
     * chip focuses the panel container, so Escape has somewhere to land; that
     * happens in `toggle` rather than in an effect precisely so this path — the
     * one that wants Start under the finger — is never overwritten by it.
     */
    effect(() => {
      if (this.ui.focusStartAt() === 0) return;
      queueMicrotask(() => this.start()?.nativeElement.focus());
    });

    /*
     * A FINISHED EXPORT OPENS THE PANEL. Every other job's completion is
     * background news — a cast, a facsimile, a translation whose book follows
     * in a tab — but an export IS the deliverable, and finishing one behind a
     * shut panel was the app whispering "exported" with the file nowhere in
     * reach (user report, 2026-08-16). The transition is watched per job id so
     * a panel the person closes afterwards stays closed; only the moment of
     * arrival opens it, with the row's Save… and ↗ on it.
     */
    const seen = new Map<string, string>();
    effect(() => {
      for (const job of this.queue.jobs()) {
        const was = seen.get(job.id);
        seen.set(job.id, job.state);
        if (was !== undefined && was !== 'done' && job.state === 'done' && this.view.filed(job)) {
          this.ui.queueOpen.set(true);
        }
      }
    });
  }

  /** Nothing has ever been in this queue, which is the chip's quietest state. */
  protected readonly empty = computed(() => this.queue.jobs().length === 0);

  /**
   * The chip, said aloud. The headline is a phrase rather than a sentence and
   * ends with what pressing it does, because a screen reader arriving at a
   * button in a corner has no other way to learn that it opens something.
   */
  protected readonly chipLabel = computed(() => {
    const verb = this.ui.queueOpen() ? 'Close' : 'Open';
    if (this.empty()) return `Queue is empty. ${verb} the queue.`;
    return `Queue: ${this.view.headline()}. ${verb} the queue.`;
  });

  /**
   * The chip's press.
   *
   * The panel takes focus as it opens so that Escape reaches it without the
   * user tabbing to it — BookForge does the same thing as its overlay attaches,
   * and for the same reason. In a microtask because the panel is not in the DOM
   * until this signal's render has happened.
   */
  protected toggle(): void {
    const open = !this.ui.queueOpen();
    this.ui.queueOpen.set(open);
    if (open) queueMicrotask(() => this.panel()?.nativeElement.focus());
  }

  /**
   * More info was pressed. The router does the navigating (it is a link); this
   * only shuts the panel, because a dropdown still hanging over the page it
   * just sent you to is a dropdown you have to dismiss before you can read what
   * you asked for.
   */
  protected goPage(): void {
    this.ui.queueOpen.set(false);
  }

  /**
   * ESCAPE SHUTS IT, which is the promise every overlay in this app makes.
   *
   * On the document rather than on the panel: focus may legitimately have moved
   * out of the panel by the time somebody presses Escape — into the chip, or
   * nowhere at all after a row's ✕ removed the element that had it — and a
   * panel that only closes while it happens to hold focus is one that gets
   * stuck open.
   */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    if (!this.ui.queueOpen()) return;
    this.ui.queueOpen.set(false);
  }

  /**
   * A CLICK ANYWHERE ELSE SHUTS IT — the other half of "click and look at".
   *
   * The chip's own click is excluded by the containment test rather than by a
   * stopPropagation on the button: the panel is full of controls, several of
   * which remove the element they are on, and a swallowed event is a bug that
   * only shows up in the one gesture nobody tried. Anything inside this
   * component's host is the panel's own business; everything else is a person
   * looking away.
   */
  @HostListener('document:pointerdown', ['$event'])
  protected onPointerDown(event: PointerEvent): void {
    if (!this.ui.queueOpen()) return;
    const target = event.target;
    if (target instanceof Node && this.host.nativeElement.contains(target)) return;
    this.ui.queueOpen.set(false);
  }
}
