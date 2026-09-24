import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { fold } from '@shared/original';
import { canCleanFrom } from '@shared/stages';
import {
  DEFAULT_CLEAN_TEXT_MODEL as DEFAULT_MODEL,
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
} from '@shared/pipeline';
import type { CleanRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { RunProgressComponent } from '../run-progress/run-progress.component';
import { RunTargetComponent } from '../run-target/run-target.component';
import { api, hosted } from '../../core/foundry';

/**
 * WHERE THIS MACHINE REMEMBERS THE TRIAGE BOX — one reader on one machine, so the
 * browser's own storage and nothing main has to know about (`MEASURE_KEY`'s
 * arrangement in book-view). Absent or unreadable is the default, which is ON.
 */
const TRIAGE_KEY = 'foundry.clean-dialog.triage';

/** The box as this machine last left it; ON when nothing was ever said. */
function triageRemembered(): boolean {
  try {
    return localStorage.getItem(TRIAGE_KEY) !== 'off';
  } catch {
    // No storage in this window: the default stands for this press.
    return true;
  }
}

/**
 * Clean text — say the book again in the words it already has, punctuated and
 * typeset so a narrator can read it aloud.
 *
 * ── The ruling (Owen, 2026-09-05) ───────────────────────────────────────────
 *
 * *"text cleanup should be an optional (but encouraged) step where the user runs
 * it at any point and everything they do after that carries the cleanup along. if
 * they delete blocks and then run cleanup, just like with translate or simplify,
 * it changes the contents of the text that the user sees. they can delete blocks
 * or whatever after that."*
 *
 * And, about where it belongs: *"cleanup will only ever be done on behalf of
 * bookforge and wont be available in foundry since foundry isnt designed to
 * narrate text."* So this window exists in Foundry and is only ever OPENED in a
 * hosted one — the tile that opens it carries the `@if (hosted())`, on the host
 * acts' own arrangement (a loop that runs zero times standalone).
 *
 * ── Why it is the Simplify dialog with the question taken out ───────────────
 *
 * Because it is the same job. What the queue runs is a text pass, what lands is a
 * step of its own, and what comes out is a records file materialised into a
 * derived book — every word of the machinery this window talks to is the machinery
 * the other two talk to, and the plan it asks main for is the same shape. So the
 * fields are the same fields, in the same order, for the same reasons.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT ASK ───────────────────────────────────
 *
 * NO REWRITE PICKER. A rewrite asks WHO the book should be for and the answer
 * changes the prose; a cleanup asks nothing, because there is only one thing to
 * do to a paragraph a narrator has to read — normalise its punctuation and
 * typography against the spec, and refuse an edit that changes what the sentence
 * says. Three cards here would be three ways of asking a question with one answer.
 *
 * NO INSTRUCTIONS BOX EITHER, which is the field a reader of the Simplify dialog
 * will look for. Instructions there pin the terms a REWRITE must leave untouched,
 * and they exist because rewriting is a judgement about words. A cleanup makes no
 * such judgement — it is measured against a punctuation spec the engine owns and
 * stamps into the file (`--stamp`) — so a free-text instruction here would be an
 * invitation to move a specification the stamp then claims was followed.
 *
 * ── AND THE ONE BOX IT DOES ASK, WHICH IS ABOUT COST AND NOT ABOUT WORDS ────
 *
 * Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with
 * snap and then we bring snap down and load the full normal cleaning logic."* With
 * the box ticked the press makes two rows — a quick check on a small model that
 * marks which paragraphs need anything at all, and the cleanup behind it, which
 * asks its big model only about those. The text that comes out is the same text:
 * a paragraph the check passes is recorded exactly as the cleaner's first,
 * mechanical stage leaves it, and any doubt is resolved toward cleaning. So it is
 * ON by default and remembered per machine, and it is drawn ONLY when an engine
 * can do the check — otherwise it is a sentence, because a box that cannot be
 * honoured is not an option (Owen, 2026-09-17).
 */
@Component({
  selector: 'app-clean-dialog',
  imports: [FormsModule, RunProgressComponent, RunTargetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeClean()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Clean this book's text">
      <header class="head">
        <span class="title">Clean text</span>
        <button class="x" (click)="ui.closeClean()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
        <!--
          THE RUN REPLACES THE FORM. Leaving the fields up while the job moves
          would offer edits that change nothing — the request was composed and
          handed over at the press.
        -->
        @if (watched(); as job) {
          <app-run-progress [job]="job" [verb]="job.kind === 'clean-triage' ? 'Checking which paragraphs need it' : 'Cleaning'" />
        } @else {
          <!-- WHERE IT WILL RUN, AND WHAT WILL RUN IT. The child draws the one
               real choice and states the rest — run-target.component.ts carries
               the ruling about why the model is not a button. -->
          <app-run-target act="clean" [(server)]="server" (ready)="canRun.set($event)" />
          <!--
            The book's own name, as the tab, the pane and the window are already
            calling it. The path is on the tooltip for the one person who wants
            it — see the Translate dialog, where this field is argued in full.
          -->
          <!--
            A FACT, NOT A FIELD. It was a read-only input, which is a control
            that looks pressable and is not — Owen, 2026-09-17: *"if an option is
            impossible to click … dont present it as an option. it isnt an
            option. present it as information or dont present it at all."* The
            book is not choosable here; the dialog was opened on it.
          -->
          <p class="fact" [title]="input">{{ name() }}</p>

          <!--
            THE QUICK CHECK IN FRONT OF THE CLEANUP. A box only when an engine
            can do it; a sentence when none can, because a box that cannot be
            honoured is not an option (Owen, 2026-09-17: "present it as
            information or dont present it at all"). Nothing while the answer is
            still being asked for -- a box that appears and then turns into a
            sentence would be the screen changing its mind in front of somebody.
          -->
          @switch (triageOffer()) {
            @case ('yes') {
              <label class="check">
                <input type="checkbox" [checked]="triaged()" (change)="setTriaged($event)" />
                <span>Skip paragraphs that need no cleaning <em>(a quick check runs first)</em></span>
              </label>
            }
            @case ('no') {
              <p class="note">
                Every paragraph goes to the cleaner. The quick check that skips the ones needing
                nothing is not something {{ triageWhere() }} can do yet.
              </p>
            }
          }

          <p class="note">
            The cleanup lands as a NEW step, in the same language, and the book you are cleaning
            is never written to. Everything you make after it carries the cleaned text —
            translate or simplify afterwards and the cleanup no longer applies, because those
            write fresh sentences of their own.
          </p>

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        }
        </div>

        <!--
          THREE PRESSES, THEN TWO — the shape OCR took first, and the reason is
          the same: Start enqueues exactly as Add does and then releases that ONE
          row, so the modal and the queue are the same run seen from two places.
          Send to background is this card letting go, not a handover.
        -->
        @if (watched(); as job) {
          <footer class="foot">
            <p class="beside">{{ job.state === 'done' ? 'Done.' : 'It keeps going if you close this.' }}</p>
            <button class="ghost" (click)="cancelRun(job.id)">Stop</button>
            <button class="primary" (click)="background()">Send to background</button>
          </footer>
        } @else {
          <footer class="foot">
            <button class="ghost" (click)="ui.closeClean()">Cancel</button>
            <!--
              -- HOSTED IT IS "ADD TO QUEUE", AND ONLY THAT --------------------

              I built this backwards. The first version hid Add to queue hosted
              and kept Start, reasoning that the host queue holds nothing so the
              two buttons would mean the same thing. Owen, meeting it in
              BookForge: *"for the vendored copy, it should have an add to queue
              button and it should add it to the bookforge queue. we dont do long
              actions from the modal in bookforge, like the cleanup stage,
              translate, simplify, narrate, and ocr."*

              So it is not a question of which label is accurate. It is a HOUSE
              RULE about where long work belongs: in BookForge it belongs in
              BookForge's queue, on BookForge's own shelf, beside everything else
              that machine is doing. A modal running a twenty-minute cleanup
              inside a window that is a guest of another app is the wrong shape
              whatever the button says.

              Start is therefore ABSENT hosted rather than relabelled, and the
              watching branch goes with it: nothing here sets watching, so the
              card never becomes a progress view it has no business being.
            -->
            <button [class.ghost]="!hosted()" [class.primary]="hosted()"
                    [disabled]="busy() || !canRun()" (click)="add(false)">
              {{ busy() === 'queue' ? 'Working...' : 'Add to queue' }}
            </button>
            @if (!hosted()) {
            <button class="primary" [disabled]="busy() || !canRun()" (click)="add(true)">
              {{ busy() === 'start' ? 'Starting…' : 'Start' }}
            </button>
          }
          </footer>
        }
      } @else {
        <!--
          The same two ways to get here as the Simplify dialog's empty state, and
          the same answer to each: there is no book yet, or you have deliberately
          stepped back to the import and are standing before the book.
        -->
        <div class="body empty">
          <p>
            There is no book here to clean. A cleanup says every paragraph again, so the
            pages have to have been read first — and standing on the import row is standing
            before the book: step onto the reading or an edit to clean what is there.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeClean()">Close</button>
          <button class="primary" (click)="openDocument()">Open a book…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /* A fact, not a field. What a read-only input used to be. */
    .fact {
      margin: 0; font-size: 12px; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT -- confirm-dialog's rule,
     * and the simplify dialog's copy of it verbatim: this host is a full-window
     * sheet of glass, and the scrim and the card say auto below so nothing a
     * person can see behaves differently.
     */
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }

    .scrim {
      pointer-events: auto;
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    .card {
      pointer-events: auto;
      position: relative;
      margin: 8vh auto 0;
      width: 460px;
      max-width: calc(100vw - 32px);
      max-height: 82vh;
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }

    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }

    .head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .title { flex: 1; font-family: var(--font-display); font-weight: 600; font-size: 16px; }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 13px;
      padding: 3px 5px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .body { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 14px; }
    .body.empty { color: var(--text-secondary); font-size: 13px; line-height: 1.5; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; font-weight: 400; opacity: 0.75; }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .check {
      display: flex; align-items: flex-start; gap: 8px;
      font-size: 12px; line-height: 1.5; color: var(--text-primary); cursor: pointer;
    }
    .check input { margin: 3px 0 0; flex: none; accent-color: var(--accent); }
    .check em { font-style: normal; color: var(--text-tertiary); }
    .note strong { color: var(--text-secondary); font-weight: 600; }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active { background: var(--bg-active); transform: scale(0.98); }
  `],
})
export class CleanDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  /**
   * The book this cleanup is OF — the Simplify dialog's `source`, asked of the
   * same ledger through the same predicate, because the two buttons open onto one
   * fact: the project has a book at its position.
   *
   * `canCleanFrom` RATHER THAN `canSimplifyFrom`, even though one delegates to the
   * other. Owen's rule is that the offer and the possibility are one function, and
   * the function has to be named for the act — so that the day a cleanup grows a
   * condition a rewrite does not have, the tile and this card both learn it
   * (shared/stages.ts argues the naming in full).
   */
  protected readonly source = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return null;
    if (!canCleanFrom(project, this.ledger.standingIn(project.dir))) return null;
    return this.projects.originalOf(project)?.path ?? null;
  });

  /** What that book is called — the tab's title where there is one, the project's otherwise. */
  protected readonly name = computed(() => {
    const input = this.source();
    if (input === null) return '';
    const at = fold(input);
    const showing = this.documents.tabs().find((tab) => fold(tab.path) === at);
    return showing?.title ?? this.projects.nameFor(input);
  });

  /**
   * THE ROW THIS CARD IS AIMED AT, when it is not the position.
   *
   * Undefined for every press this dialog had before Owen's pending-node ruling,
   * and a step id for the one shape where the pointer could not follow the click:
   * somebody standing on a GRAYED card in the tree, whose step will not exist until
   * a queued job lands. Main resolves it, refuses an id that is neither a step nor a
   * live promise, and answers with a DEFERRED plan for the second case
   * (`LedgerService.aimedAt`, and `aimedAt` in electron/ipc.ts).
   */
  private readonly aim = computed<string | undefined>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return undefined;
    const project = this.projects.projectFor(tab.path);
    return project === null ? undefined : this.ledger.aimedAt(project.dir);
  });

  /*
   * NO MODEL PICKER, NO OLLAMA FIELD AND NO `server` SIGNAL. See the Translate
   * dialog, where all three are argued. The three-tag list this window offered
   * — 8-bit, 16-bit, 27B — was Foundry choosing a model, which is the engine's
   * decision now (Owen, 2026-09-15).
   */
  protected readonly problem = signal<string | null>(null);
  /** The plan materialises the position's whole book before it answers. Not instant. */
  /** WHICH press is in flight, so only that button says so. */
  protected readonly busy = signal<'queue' | 'start' | null>(null);
  /** Read in the template: hosted, the host's queue holds nothing. */
  protected readonly hosted = hosted;

  /** The engine this run is pinned to. The child picks the default. */
  protected readonly server = signal('');
  /** May this act run on that engine at all — the child's verdict. */
  protected readonly canRun = signal(false);
  /**
   * THE BOX: a quick check first, and the cleaner asked only about what it flags.
   * ON unless this machine last said otherwise — see the class note.
   */
  protected readonly triaged = signal(triageRemembered());
  /**
   * CAN ANY ENGINE THIS PRESS WOULD GO TO DO THE CHECK — `yes`, `no`, or null
   * while that is still being asked.
   *
   * WHOSE ENGINES DEPENDS ON WHO PLACES THE RUN. Hosted, the host's queue picks
   * the machine when the job starts (run-target says so), so the question is
   * whether ANY of its engines serves the `decide` class. Standalone the row is
   * pinned to the server chosen above, so it is whether THAT one does — a check
   * offered because some other machine could run it would be pinned to one that
   * cannot, and fail in the queue instead of being declined here.
   *
   * An engine older than the class has no row for it, which is a `no` — the true
   * answer until it is upgraded — and never a guess that it might.
   */
  protected readonly triageOffer = signal<'yes' | 'no' | null>(null);
  /** Who "cannot do it yet", for the sentence drawn in place of the box. */
  protected readonly triageWhere = computed(() => {
    const chosen = this.server();
    return hosted() || chosen.length === 0 ? 'any connected engine' : `"${chosen}"`;
  });
  /**
   * THE ROWS THIS CARD IS WATCHING, or null when it is a form. Ids rather than
   * jobs: a job is re-pushed whole on every change, and a held copy would be a
   * snapshot going stale under a progress bar. `triage` is null for a cleanup
   * pressed without the check.
   */
  private readonly watching = signal<{ clean: string; triage: string | null } | null>(null);
  /**
   * THE ROW TO DRAW NOW — the check while it is still to come or running, and
   * the cleanup after it. One bar at a time, in the order the work happens, so a
   * person watching sees "Checking…" and then "Cleaning…" rather than a cleanup
   * reading "waiting for an engine" for the length of a check they asked for.
   *
   * NULL the moment the cleanup leaves the list, which is what makes Send to
   * background and a finished run one code path.
   */
  protected readonly watched = computed(() => {
    const ids = this.watching();
    if (ids === null) return null;
    const jobs = this.queue.jobs();
    const triage = ids.triage === null ? undefined : jobs.find((job) => job.id === ids.triage);
    if (triage !== undefined
      && (triage.state === 'held' || triage.state === 'queued' || triage.state === 'running'
        || triage.state === 'failed' || triage.state === 'cancelled')) {
      // A check that FAILED is drawn too: the cleanup behind it was taken with it,
      // and the reason is on this row.
      return triage;
    }
    return jobs.find((job) => job.id === ids.clean) ?? null;
  });

  /**
   * LET GO OF THE RUN, KEEP THE RUN. Nothing moves and nothing is handed over —
   * the row has been in the queue since the press, so this card simply stops
   * watching and closes.
   */
  protected background(): void {
    this.watching.set(null);
    this.ui.summonQueue(true);
    this.ui.closeClean();
  }

  /** Stop the run and go back to being a form, with the values still in it. */
  protected async cancelRun(id: string): Promise<void> {
    await this.queue.cancel(id);
    this.watching.set(null);
  }


  constructor() {
    // A complaint about the last book is cleared when the book changes.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
    // The chosen engine changed, so whether the check can run is asked again.
    effect(() => {
      void this.askTriage(this.server());
    });
  }

  /** Tick or untick the box, and remember it on this machine. */
  protected setTriaged(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.triaged.set(on);
    try {
      localStorage.setItem(TRIAGE_KEY, on ? 'on' : 'off');
    } catch { /* not kept: the box holds for this press regardless */ }
  }

  /**
   * CAN THE CHECK RUN WHERE THIS PRESS WOULD GO — see `triageOffer`.
   *
   * A read that FAILS is a `no` with the failure in the console rather than on
   * the card: the run-target line above already says, in the engine's own words,
   * that this server could not be asked what it runs, and a second sentence about
   * the same failure under it would be the dialog repeating itself.
   */
  private async askTriage(chosen: string): Promise<void> {
    if (!api) return;
    this.triageOffer.set(null);
    try {
      if (hosted() || chosen.length === 0) {
        const serving = await api.crucible.serves('decide');
        if (this.server() !== chosen) return;
        this.triageOffer.set(serving === null ? 'no' : 'yes');
        return;
      }
      const record = await api.crucible.engineCapability(chosen);
      if (this.server() !== chosen) return;
      const row = record.classes.find((entry) => entry.capability === 'decide');
      this.triageOffer.set(row !== undefined && row.enabled && row.selected.length > 0 ? 'yes' : 'no');
    } catch (err) {
      console.error(`[clean] could not ask whether "${chosen}" can check which paragraphs need cleaning:`, err);
      if (this.server() === chosen) this.triageOffer.set('no');
    }
  }

  protected openDocument(): void {
    void this.documents.openViaDialog();
  }

  /**
   * ONE COMPOSE, TWO ENDINGS — `release` is the whole difference between the two
   * buttons, and it is an argument rather than a second method because
   * everything above the last few lines is identical.
   */
  protected async add(release: boolean): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    this.busy.set(release ? 'start' : 'queue');
    this.problem.set(null);
    try {
      const plan = await api.workspace.planCleanup(input, this.aim());
      /*
       * THE STAMP IS MAIN'S AND THIS WINDOW NEVER COMPOSES ONE. It is named from
       * the records file so the compile that later reads it and the plan that
       * writes it cannot disagree (`narrationStampFileFor`, electron/projects.ts).
       * An absent one is main's refusal arriving by a route that should not exist,
       * and it is said rather than passed on as an empty `--stamp`.
       */
      if (plan.stampPath === undefined || plan.stampPath.length === 0) {
        this.problem.set(
          'Foundry could not work out where to record what the cleanup did, so the run was not '
          + 'queued.',
        );
        return;
      }
      const request: CleanRequest = {
        kind: 'clean',
        inputPath: plan.inputPath,
        // WHERE THE ANSWERS GO, and the whole of what this run makes. The BOOK it
        // reads is made when the run starts, out of `at` below — no path under
        // `derived/` crosses this seam any more (`TranslateRequest.at`).
        recordsPath: plan.recordsPath,
        stampPath: plan.stampPath,
        // THE ADMISSION THAT THIS IS MADE FROM SOMETHING THAT HAS NOT HAPPENED,
        // carried verbatim — the queue reads it, nothing here interprets it.
        ...(plan.deferred !== undefined ? { deferred: plan.deferred } : {}),
        /*
         * ── THE MODEL AND THE ENDPOINT ARE DECLARED CONSTANTS NOW ───────────
         *
         * Owen, 2026-09-15: *"we dont have any local models. crucible handles
         * all model orchestration."* The ENGINE's capability record names the
         * model a request runs (crucible docs/PHASE15-HOST.md §3.3) and the
         * placement applies it at the spawn, over the top of these two
         * (`doorArgs`, electron/job-queue.ts) — so a field here let somebody
         * choose something that was then ignored, and it is gone.
         *
         * THE REQUEST FIELDS ARE NOT GONE, because one caller still reads them:
         * a DRY RUN has no server to ask, so `argsFor` defaults to `UNPLACED`
         * and prints the request's own pair (BookForge's `cli/clean-step.js`).
         * The declared defaults are the honest thing for that line to carry.
         */
        model: DEFAULT_MODEL,
        ollama: DEFAULT_OLLAMA,
        // Minted by the plan and carried back to the landing, so the row and the
        // file agree about which cleanup this is. Never read here.
        /*
         * THE ROW THIS PASS IS MADE FROM, as main resolved it at the press. It
         * is what the run materialises its book out of when it starts, and it
         * travels as an ID because a path under `derived/` is swept at every
         * settle — see `TranslateRequest.at`. Never read here.
         */
        at: plan.at ?? null,
        stepId: plan.stepId,
      };

      // A refusal is not a success: the queue dedupes on the records path and
      // answers with the row that already exists, so a second press has queued
      // nothing and this card stays put and says so.
      /*
       * ── WITH THE CHECK, TWO ROWS; WITHOUT IT, TODAY'S ONE ────────────────────
       *
       * The box is honoured only when an engine can do the check (`triageOffer`);
       * when it is not drawn, this is the cleanup it has always been. With it, main
       * makes the pair — the check, then the cleanup chained behind it — and hands
       * back both ids, because everything below acts on both
       * (`enqueueTriagedCleanup`, electron/job-queue.ts).
       */
      const withCheck = this.triaged() && this.triageOffer() === 'yes';
      const { outcome, rows } = withCheck
        ? await this.queue.enqueueTriagedCleanup(request).then((made) => ({
          outcome: made.outcome,
          rows: made.cleanId === null ? null : { clean: made.cleanId, triage: made.triageId },
        }))
        : await this.queue.enqueueTextPassNamed(request).then((made) => ({
          outcome: made.outcome,
          rows: made.id === null ? null : { clean: made.id, triage: null },
        }));
      /*
       * PINNED TO THE ENGINE THE CARD NAMED, and pinned AFTER the enqueue rather
       * than carried on the request: `waitFor` is a property of the ROW — a
       * person can re-route a parked row from the shelf — so the queue's own
       * door owns it. A blank server means nothing was chosen and the row keeps
       * the default it was admitted with.
       *
       * BOTH ROWS, when there are two: the check was offered because THIS engine
       * can do it (`askTriage`), and a cleanup and its check on two different
       * machines would load two models where the person picked one.
       */
      if (rows !== null && this.server().length > 0) {
        if (rows.triage !== null) await this.queue.setWaitFor(rows.triage, this.server());
        await this.queue.setWaitFor(rows.clean, this.server());
      }
      if (outcome === 'already') {
        /*
         * A DUPLICATE IS STILL A RUN SOMEBODY CAN WATCH. Main answers with the
         * EXISTING row, and if that is the work just asked for then Start's
         * honest behaviour is to show it working. Add to queue keeps the
         * sentence, because there the news IS that the shelf did not grow.
         */
        if (release && rows !== null) {
          await this.releaseRows(rows);
          this.watching.set(rows);
          return;
        }
        this.problem.set(
          'This cleanup is already queued for this book — nothing was added. It is in the queue.',
        );
        return;
      }

      /*
       * START COMMITS TO THESE ROWS AND NOTHING ELSE — `queue:release`, not
       * `queue:start`, which lets go of every row somebody parked deliberately.
       */
      if (release && rows !== null) {
        await this.releaseRows(rows);
        this.watching.set(rows);
        return;
      }
      /*
       * THE QUEUE PANEL IS SUMMONED AND HOSTED THAT IS DELIBERATELY NOTHING, which
       * is the Simplify dialog's own line and matters more here: this act is only
       * ever pressed in a hosted window, where the shelf is the host's and Foundry
       * draws none of its own (Owen, 2026-08-21). The call is kept so the two
       * dialogs behave identically if the gate ever changes.
       */
      this.ui.summonQueue(false);
      this.ui.confirmQueued('Clean text queued — it lands in the tree when it finishes.');
      this.ui.closeClean();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * START'S RELEASE, PER ROW — the check first, then the cleanup. Release is
   * per-row by design (`queue:release` lets go of exactly the row it names), so a
   * pair is two presses of it; the cleanup released second still waits behind its
   * check on the board (`Job.after`), which is what makes the order safe.
   */
  private async releaseRows(rows: { clean: string; triage: string | null }): Promise<void> {
    if (rows.triage !== null) await this.queue.release(rows.triage);
    await this.queue.release(rows.clean);
  }
}
