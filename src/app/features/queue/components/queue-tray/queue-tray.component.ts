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
 *   Up next     — ONE SMALL CARD PER BOOK, cover · title · meta · pill, which
 *                 opens downward into that book's chain. Owen, 2026-09-20:
 *                 *"they should be small cards, not big long expanded lists of
 *                 work"* — the band had been one tall row per STEP, so two
 *                 books filled the panel with nine rows, each repeating the
 *                 book's title and each carrying its own ✕.
 *   Pending     — the same card for books that have been staged but not sent.
 *   Finished    — one line. History, drawn as history.
 *
 * A band with nothing in it is not drawn, so the panel is short when the queue
 * is quiet and long only when there is genuinely that much to say.
 *
 * ── It is not a dead end any more ───────────────────────────────────────────
 *
 * The old shelf could start a held run and pause the engine, and every other
 * intent ended at "Open queue details →" — which re-listed what you were already
 * looking at. Stop, retry, start and remove all live here now — and since the
 * 2026-09-20 redesign the last two are said about a BOOK rather than a step,
 * because five presses to take one book out is five chances to leave a chain
 * that can no longer finish. Nothing here
 * DECIDES anything: every control is a sentence sent through QueueTrayService to
 * main, which owns the queue.
 *
 * The state grammar (solid check for done, pulsing ring for running, dashed
 * hollow for waiting or held) is the one Foundry's provenance tree uses, because
 * they are two views of one pipeline and a user should not have to learn it
 * twice.
 */

import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, ElementRef, inject, output, signal } from '@angular/core';
import { Router } from '@angular/router';

import { prepFraction, type PlannedStep } from '@shared/queue/bench';
import { QueueTrayService, type BookPlanView } from '../../services/queue-tray.service';

/**
 * Where a BOOK stands, in one word and one tone.
 *
 * One word, because the card has room for one and because the states a user
 * acts on differently are few: it is moving, it is the next one to move, it is
 * waiting its turn, or something is holding it.
 */
interface CardState {
  word: string;
  tone: 'run' | 'next' | 'wait' | 'pause' | 'held' | 'staged';
}

@Component({
  selector: 'app-queue-tray',
  standalone: true,
  imports: [DecimalPipe, NgTemplateOutlet],
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
        <!-- Three states, not two. Two made the lamp contradict the button
             beside it: the engine's latch stays set over a queue that finished
             everything an hour ago, so the shelf said "Running" next to a
             button offering to Start. Idle is the honest third word — nothing
             is moving, and nobody paused it. -->
        <span class="engine" [class.paused]="!tray.isRunning()">
          <span class="led" aria-hidden="true"></span>
          {{ tray.anythingRunning()
            ? (tray.isRunning() ? 'Running' : 'Finishing, then pausing')
            : (tray.isRunning() ? 'Idle' : 'Paused') }}
        </span>
        <!-- Two stopping gestures (Owen, 2026-08-29): the drain lets running
             steps finish and admits nothing new; Halt takes the GPU back now.
             While draining, the accent button flips to Resume (cancel the
             drain) and Halt stays for the step still finishing. -->
        @if (tray.anythingRunning() && tray.isRunning()) {
          <button type="button" class="btn accent push" (click)="pauseAfterCurrent()"
                  title="Let the running steps finish, then stop — nothing new claims a slot.">
            ⏸ Pause after current
          </button>
          <button type="button" class="btn stop" (click)="haltProcessing()"
                  title="Stop the queue and everything it is running, now. To stop just one step, use its own Stop button below.">
            ■ Halt
          </button>
        } @else if (tray.anythingRunning()) {
          <button type="button" class="btn accent push" (click)="startQueue()"
                  title="The queue is finishing its running step and will pause after it. Resume claiming new work instead.">
            ▶ Resume
          </button>
          <button type="button" class="btn stop" (click)="haltProcessing()"
                  title="Stop the step that is finishing, now. It resumes from what it has already rendered.">
            ■ Halt
          </button>
        } @else {
          <button type="button" class="btn accent push" (click)="startQueue()"
                  [disabled]="!tray.anythingToDo()"
                  [title]="tray.anythingToDo()
                    ? 'Claim work as slots free up, and resume anything that was stopped.'
                    : 'Nothing is queued, so there is nothing to start.'">
            ▶ Start
          </button>
        }
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

      @for (lane of tray.lanes(); track lane.setId + lane.resource + lane.index) {
        <div
          class="lane"
          [class.gpu]="lane.resource === 'gpu'"
          [class.warn]="lane.hold"
          [class.hot]="lane.thermal?.throttleSustained"
          [class.free]="!lane.occupant"
        >
          <div class="slot">
            <b>{{ lane.setLabel }} · {{ lane.resource === 'gpu' ? 'GPU' : 'CPU' }}</b>
            {{ lane.index }} of {{ lane.of }}
            @if (lane.thermal; as thermal) {
              <span class="temp" [class.hot]="thermal.throttleSustained">{{ thermal.tempC }}°</span>
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
                  <!-- Nothing, rather than "not timed yet". An unmeasured step
                       has no time to report, and a line saying so is a line of
                       the panel spent on an absence. -->
                  @if (lane.eta; as left) {
                    <div class="eta">{{ left }}</div>
                  }
                  <!-- The shelf's per-slot Stop, matching the queue page's. At
                       452px the label is the verb alone and the sentence lives
                       in the tooltip — but it is a LABELLED button, not a bare
                       glyph: the control that takes work off the card should
                       not be the one you have to guess at. -->
                  <button type="button" class="tiny stop" (click)="stopStep(busy.stepId)"
                          title="Stop this step and free the slot. It keeps everything it has already rendered, and Start picks it up from there. The rest of the queue keeps running — use Pause queue above to stop it all.">
                    ■ Stop
                  </button>
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

              <!-- Counted work inside the PREPARING stage. The stage line above
                   reads "Preparing book 0%" for as long as the number pass takes,
                   and in 452px this line is the only thing that says it is alive. -->
              @if (busy.prep; as prep) {
                <div class="stage-line">
                  <span class="s-name">{{ prep.label }}</span>
                  <span class="bar thin">
                    <i [style.width.%]="(prepFraction(prep) ?? 0) * 100"></i>
                  </span>
                  <span class="s-val">{{ prep.done }}/{{ prep.total }}</span>
                </div>
              }

              @if (lane.thermal?.throttleSustained) {
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

      <!-- ── Up next ───────────────────────────────────────────────────────
           ONE CARD PER BOOK, not one row per step.

           Owen, 2026-09-20: *"lets do the same for the dropdown/toast style
           queue in the top right corner of bookforge. they should be small
           cards, not big long expanded lists of work"* — "the same" being the
           queue page's Completed blocks, which he had approved minutes before:
           *"this is a good size and structure. it expands downward to show more
           info. compact."*

           What that replaced: two books drawn as NINE tall rows, every one of
           them repeating the book's name, carrying a grey box saying "Waiting
           for <the previous step> to finish", and its own red ✕ Cancel. A book
           is one object — cover, title, what it has left, one word for where it
           stands, one ✕ that takes the whole book out. Its chain is one click
           down, which is where somebody who wants it will look. -->
      @if (tray.plans().length > 0) {
        <div class="sec">
          <!-- BOOKS, not steps. The heading that read "Up next · 11" was
               counting the steps of two books — the number the old shape was
               made of, and the one nothing below it named. -->
          <span>Up next · {{ tray.plans().length }}</span>
          <span class="rule"></span>
        </div>
        @for (plan of tray.plans(); track plan.key) {
          <ng-container
            [ngTemplateOutlet]="bookCard"
            [ngTemplateOutletContext]="{ $implicit: plan, staged: false, first: $first }"
          />
        }
      }

      <!-- Staged books get the SAME card under their own heading. They are not
           "up next" — nothing has been sent — and the pill says so on each one.
           Send to queue is deliberately not here: it commits a book to a
           machine (docs/PENDING-QUEUE-AND-GPU-DIAL.md), and the choice it
           commits lives on the page. -->
      @if (tray.pending().length > 0) {
        <div class="sec">
          <span>Pending · {{ tray.pending().length }}</span>
          <span class="rule"></span>
        </div>
        @for (plan of tray.pending(); track plan.key) {
          <ng-container
            [ngTemplateOutlet]="bookCard"
            [ngTemplateOutletContext]="{ $implicit: plan, staged: true, first: false }"
          />
        }
      }

      @if (tray.lanes().length > 0 && busyLanes() === 0
           && tray.plans().length === 0 && tray.pending().length === 0) {
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

    <!-- ── The book card ───────────────────────────────────────────────────
         Drawn ONCE for both bands. A staged book and a queued one are the same
         object on two sides of one press, and two drawings of it is how the
         two bands drift into two vocabularies for the same thing.

         Collapsed it is cover · title · meta · pill · ✕, about 64px tall. Open
         it grows DOWNWARD in place into the chain, which is the Completed
         block's behaviour and therefore already learned. -->
    <ng-template #bookCard let-plan let-staged="staged" let-first="first">
      @let state = cardState(plan, staged, first);
      <article class="bcard" [class.on]="openKey() === plan.key">
        <div class="bcard-row">
          <button
            type="button"
            class="face"
            [attr.aria-expanded]="openKey() === plan.key"
            (click)="toggleCard(plan.key)"
            [title]="'What ' + plan.title + ' still has to run'"
          >
            <span class="chev" aria-hidden="true">▸</span>
            @if (plan.cover) {
              <img class="cover bk" [src]="plan.cover" alt="" />
            } @else {
              <span class="cover bk blank" aria-hidden="true"></span>
            }
            <span class="min grow">
              <span class="bk-title">{{ plan.title }}</span>
              <span class="bk-meta">{{ cardMeta(plan, state) }}</span>
            </span>
            <span [class]="'pill ' + state.tone">{{ state.word }}</span>
          </button>

          <!-- ONE ▶ PER BOOK, and only when the whole book is held: the
               shelf's principle is that it is not a dead end, and without this
               "start this one book" would be reachable only by starting the
               whole queue from the header. -->
          @if (state.tone === 'held' && !staged) {
            <button
              type="button"
              class="mini go"
              (click)="startBook(plan)"
              [title]="'Start ' + plan.title + ' — it claims a slot as soon as one is free.'"
              [attr.aria-label]="'Start ' + plan.title"
            >▶</button>
          }

          <!-- ONE ✕ PER BOOK, after the pill. Nine ✕ for two books was the
               screenshot's loudest line; a book leaves the queue as a book. -->
          <button
            type="button"
            class="mini kill"
            (click)="cancelBook(plan)"
            [title]="'Take ' + plan.title + ' out of the queue. Nothing it has already rendered is deleted.'"
            [attr.aria-label]="'Take ' + plan.title + ' out of the queue'"
          >✕</button>
        </div>

        @if (openKey() === plan.key) {
          <!-- The chain, as the queue page draws it: a dot, a name, and only a
               number when one has been measured. -->
          <div class="ladder">
            @for (step of plan.steps; track step.stepId) {
              <div class="rung" [class.now]="step.status === 'running'">
                <span class="rdot" aria-hidden="true"></span>
                <span class="rname">{{ step.label }}</span>
                @if (step.status === 'running' && step.percent !== null) {
                  <span class="rval">{{ step.percent | number:'1.0-0' }}%</span>
                }
                @if (tray.etaForStep(step.stepId); as left) {
                  <span class="rval soft">{{ left }}</span>
                }
              </div>
              @if (stepNote(step); as note) {
                <span class="why" [class.warn]="step.reason?.kind === 'admission'">
                  <span class="dot" aria-hidden="true"></span>{{ note }}
                </span>
              }
            }
          </div>
        }
      </article>
    </ng-template>
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
    .eta { font-size: 10px; color: var(--text-secondary); }

    .bar {
      height: 5px;
      border-radius: 3px;
      background: var(--progress-track);
      overflow: hidden;
      margin-top: 8px;
    }

    .bar i {
      display: block;
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--accent-hover), var(--progress-fill));
      transition: width 0.4s ease;
    }

    /* A step that has measured nothing gets no coloured bar — an empty track is
       "nothing reported", and a bar at zero is a claim it never made. */
    .bar.dim i { background: transparent; }

    .stage-line {
      display: grid;
      /* Room for "Converting sentences" in full — the words carry the meaning,
         so the bar gives way, not the label. */
      grid-template-columns: 124px 1fr 34px;
      align-items: center;
      gap: 8px;
      margin-top: 6px;
      font-size: 10px;
      color: var(--progress-label);
    }

    .stage-line .bar.thin { height: 4px; margin-top: 0; }
    .s-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .s-val {
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: var(--progress-value);
      font-weight: 600;
    }

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

    /* ── Up next: one card per book ─────────────────────────────────────
       The Completed block from the queue page, at the shelf's scale: a raised
       rounded rectangle, a 44px cover, one line of title, one muted meta line,
       one pill — about 64px of panel per book, where a book used to take five
       rows of ninety. */

    .bcard {
      position: relative;
      margin: 0 14px 7px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
    }

    .bcard.on { border-color: var(--border-default); }

    .bcard-row { display: flex; align-items: center; }

    .face {
      font-family: inherit;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 8px 4px 8px 9px;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }

    .face:hover .bk-title { color: var(--accent); }

    /* A CHEVRON THAT TURNS, so the card says which way it will go before it is
       pressed — the same affordance the page's Completed drawer uses. */
    .chev {
      font-size: 9px;
      line-height: 1;
      color: var(--text-muted);
      transition: transform 0.2s ease;
      flex: none;
    }

    .bcard.on .chev { transform: rotate(90deg); }

    .cover.bk { width: 30px; height: 44px; border-radius: 3px; }

    .bk-title {
      display: block;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bk-meta {
      display: block;
      margin-top: 2px;
      font-size: 10.5px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ONE WORD FOR WHERE THE BOOK STANDS, in the tray's own tones: accent for
       moving, success for the one that goes next, amber for anything a person
       or a pause is holding, muted for the rest. */
    .pill {
      flex: none;
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 9px;
      background: var(--bg-input);
      color: var(--text-tertiary);
    }

    .pill.run { background: var(--accent-subtle); color: var(--accent); }
    .pill.next { color: var(--success); }
    .pill.pause,
    .pill.held { background: var(--warning-bg); color: var(--warning-text); }
    .pill.staged { color: var(--text-muted); }

    /* The two book-level controls, small and quiet: neither is the card's
       point, and a column of ten books must not read as a column of twenty
       glyphs. They take their colour on hover, where the hand already is. */
    .mini {
      flex: none;
      font-family: inherit;
      font-size: 11px;
      line-height: 1;
      padding: 5px 6px;
      margin-right: 3px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
    }

    .mini.go:hover { color: var(--accent); background: var(--accent-subtle); }
    .mini.kill:hover { color: var(--color-danger); background: var(--warning-bg); }

    /* ── The chain, once the card is open ─────────────────────────────── */

    .ladder {
      display: grid;
      gap: 5px;
      padding: 7px 11px 9px;
      border-top: 1px solid var(--border-subtle);
    }

    .rung {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 10.5px;
      color: var(--text-muted);
      min-width: 0;
    }

    .rung.now { color: var(--text-primary); }

    .rdot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      border: 1px dashed var(--text-muted);
      flex: none;
    }

    .rung.now .rdot { background: var(--accent); border: 0; }

    /* The name takes the free space, so both numbers land against the card's
       right edge whether there are two of them or one. */
    .rname {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .rval {
      flex: none;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
      color: var(--accent);
    }

    /* A measured time left follows the percentage rather than competing with
       it: the number that moves is the one nearest the name. */
    .rval.soft { color: var(--text-tertiary); font-weight: 400; }

    .ladder .why { margin: 0 0 0 14px; }

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

    .tiny.bad {
      border-color: transparent;
      background: var(--bg-elevated);
      color: var(--color-danger);
      font-weight: 600;
    }

    /* Outlined, not filled — stopping a step keeps everything it rendered, so
       it must be FINDABLE without reading as "throw this away". */
    .tiny.stop {
      border-color: color-mix(in srgb, var(--color-danger) 45%, transparent);
      color: var(--color-danger);
      font-weight: 600;
    }

    .tiny.stop:hover {
      border-color: var(--color-danger);
      background: var(--bg-elevated);
      color: var(--color-danger);
    }

    /* The lane's Stop sits under the ETA in a right-aligned column. */
    .right .tiny.stop { margin-top: 5px; }

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

  /**
   * Shared with the bench card (shared/queue/bench.ts), so the two never disagree
   * about how far a prep pass has got. The WORDING is the shelf's own — a
   * stage-line here is a label, a bar and a value in 452px, which is why this
   * draws `done/total` in the value column instead of the card's one-line
   * `prepLabel`.
   */
  readonly prepFraction = prepFraction;

  /**
   * The one book whose chain is open, by plan key — or null.
   *
   * ONE at a time, like the page's Completed blocks: the shelf is 452px of a
   * window somebody is working in, and a panel that can be expanded into a
   * wall is the shape this redesign took out.
   */
  readonly openKey = signal<string | null>(null);

  /** How many slots are in use, for the band's own heading. */
  busyLanes(): number {
    return this.tray.lanes().filter(lane => lane.occupant !== null).length;
  }

  /** Take focus so Escape reaches the panel without the user tabbing to it. */
  focus(): void {
    (this.host.nativeElement as HTMLElement).focus();
  }

  async pauseAfterCurrent(): Promise<void> {
    await this.tray.pauseAfterCurrent();
  }

  async haltProcessing(): Promise<void> {
    await this.tray.haltProcessing();
  }

  async startQueue(): Promise<void> {
    await this.tray.startQueue();
  }

  async clearFinished(): Promise<void> {
    await this.tray.clearFinished();
  }

  /** Open one book's chain, or close the one that is open. */
  toggleCard(key: string): void {
    this.openKey.update(open => (open === key ? null : key));
  }

  /**
   * WHERE A BOOK STANDS, in one word.
   *
   * Asked of the book and not of its steps, because that is the object the
   * card is: the nine rows this replaced each carried their own status and
   * left the reader to work out what the BOOK was doing.
   *
   * The order of the tests is the order of specificity. A staged book is
   * `Pending` before anything else is asked of it — it is not in the queue, so
   * no queue fact applies. `Held` outranks `Paused` because it is the narrower
   * truth: the queue being paused is true of every card at once, and the one a
   * person has held is a thing they did to this book. `Next` is the front of
   * the released list, and it is the only positional word here — everything
   * behind it is `Waiting`, since a number for its place would be a promise
   * about an order the pump is free to revise.
   */
  cardState(plan: BookPlanView, staged: boolean, first: boolean): CardState {
    if (staged) return { word: 'Pending', tone: 'staged' };
    if (plan.steps.some(step => step.status === 'running')) return { word: 'Running', tone: 'run' };
    if (plan.allHeld) return { word: 'Held', tone: 'held' };
    if (!this.tray.isRunning()) return { word: 'Paused', tone: 'pause' };
    return first ? { word: 'Next', tone: 'next' } : { word: 'Waiting', tone: 'wait' };
  }

  /**
   * The card's one muted line: HOW MUCH is left, and WHAT IS NEXT.
   *
   * The steps a plan carries are the ones that have not finished
   * (`bookPlans` drops terminal steps), so the count is work remaining and the
   * first of them is the act the book is about to perform — the two facts the
   * ladder underneath would otherwise have to be opened to learn.
   */
  cardMeta(plan: BookPlanView, state: CardState): string {
    const count = `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`;
    const running = plan.steps.find(step => step.status === 'running');
    if (running) return `${count} · ${running.label} running`;
    if (state.tone === 'staged') return `${count} · not sent yet`;
    if (state.tone === 'held' || state.tone === 'pause') return `${count} · held`;
    const next = plan.steps[0];
    return next ? `${count} · ${next.label} next` : count;
  }

  /**
   * WHAT A STEP HAS TO SAY THAT THE CARD DOES NOT ALREADY SAY — or null.
   *
   * Owen's screenshot was nine rows of grey boxes reading "Waiting for <the
   * previous step> to finish", which is the chain restating its own order once
   * per rung. A reason earns its line only when it carries something the
   * ladder's shape cannot: the card is waiting on a machine, on a slot, on an
   * admission the scheduler is holding.
   *
   * The three silences:
   *  - a RUNNING step has no reason at all (`bookPlans` sets it null); its
   *    percentage is beside its name.
   *  - `waiting-parent`, and a `held` step that is not startable — both of
   *    which mean "behind the one above it", which the order already says.
   *  - `pending`, which is a fact about the whole run and is already the
   *    card's pill; repeating it on five rungs is the same sentence five times.
   */
  stepNote(step: PlannedStep): string | null {
    const reason = step.reason;
    if (reason === null) return null;
    if (reason.kind === 'waiting-parent' || reason.kind === 'pending') return null;
    if (reason.kind === 'held' && !step.startable) return null;
    return reason.sentence;
  }

  /** Start every held run of one book, the shelf's answer to "just this one". */
  async startBook(plan: BookPlanView): Promise<void> {
    await this.tray.startPlan(plan);
  }

  /**
   * Take a whole BOOK out of the queue.
   *
   * The old shelf cancelled one step at a time, which on a chain of five meant
   * five presses to undo one intention — and the four it left behind were a
   * book that could no longer finish. `cancelPlan` removes every run of the
   * group and leaves every file they wrote alone.
   */
  async cancelBook(plan: BookPlanView): Promise<void> {
    await this.tray.cancelPlan(plan);
  }

  async retry(stepId: string): Promise<void> {
    await this.tray.retryStep(stepId);
  }

  /** Stop the step on one slot, leaving the queue running. */
  async stopStep(stepId: string): Promise<void> {
    await this.tray.stopStep(stepId);
  }

  /**
   * Take one row out of the queue — the failure cards, which hold a run id.
   *
   * `removeRun` cancels just the step when its run has others and removes the
   * run when it does not, so either id is a safe thing to hand it. Up next no
   * longer calls this: a book leaves the queue as a book ({@link cancelBook}).
   */
  async remove(rowId: string): Promise<void> {
    await this.tray.removeRun(rowId);
  }

  openDetails(): void {
    this.dismiss.emit();
    void this.router.navigate(['/queue']);
  }
}
