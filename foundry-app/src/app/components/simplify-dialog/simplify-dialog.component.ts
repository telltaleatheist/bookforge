import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { fold } from '@shared/original';
import { canSimplifyFrom } from '@shared/stages';
import {
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
  DEFAULT_TRANSLATE_MODEL as DEFAULT_MODEL,
} from '@shared/pipeline';
import type { RewriteMode, SimplifyRequest } from '@shared/types';

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
 * THE THREE REWRITES, IN THE WORDS THE PERSON PICKING ONE NEEDS.
 *
 * A TABLE BESIDE THE COMPONENT rather than three cards written out in the
 * template, because the three differ only in their words: same shape, same
 * gesture, same everything the app does with the answer. Three hand-written cards
 * is three places for a fourth mode to be forgotten, and — worse — three places
 * for the copy to drift from the label the finished step will carry.
 *
 * WHAT EACH ONE SAYS IS WHO THE BOOK IS FOR, and that is the whole basis on which
 * somebody chooses. "Dejargon" and "destiffen" are flag values; nobody opens this
 * card knowing what they mean, and nobody should have to. What they know is that
 * their book is unreadable in a particular way, and each of these names a way.
 */
const REWRITES: readonly { mode: RewriteMode; name: string; what: string }[] = [
  {
    mode: 'dejargon',
    name: 'Plain terms',
    what: 'Rewrites over-complicated, jargon-heavy prose into plain, direct language. '
      + 'Keeps the technical terms the author actually relies on.',
  },
  {
    mode: 'destiffen',
    name: 'Natural voice',
    what: 'Loosens stiff, translation-flavoured prose into natural everyday phrasing. '
      + 'Made for a book that has just been machine-translated.',
  },
  {
    mode: 'learner',
    name: 'Easy language',
    what: 'For language learners (B1–B2): common words, short sentences, the same story.',
  },
];

/**
 * Simplify — say the book again, in the language it is already in.
 *
 * ── Why this is the Translate dialog with a different question ──────────────
 *
 * Because it is the same job. What the queue runs is a translate job, what lands
 * is a translate step, and what comes out is a records file cast into a book —
 * every word of the machinery this window talks to is the one the Translate
 * dialog talks to, and the plan it asks main for is the same shape. So the fields
 * are the same fields, in the same order, for the same reasons: the
 * instructions are appended to the prompt word for word because terminology is
 * per-book and no default can be right about it.
 *
 * ── AND WHY IT IS A SECOND WINDOW RATHER THAN A CHECKBOX IN THE FIRST ───────
 *
 * There is no language field here, and that absence is the point. A translation
 * asks WHERE the book should go; a rewrite asks WHO it should be for, and the
 * language is not a question at all — it is whatever the book is already in,
 * resolved by main off the ledger and handed back with the plan. A single card
 * that hid a language field behind a toggle would ask somebody to configure a job
 * before deciding which job it was.
 *
 * WHAT IT DOES ASK IS ONE OF THREE, AND NOTHING ELSE IS OPTIONAL ABOUT IT. The
 * mode decides the prompt, the filename and the row, and it is compared when a
 * later rewrite from the same step decides whether to replace this one or sit
 * beside it — so there is a default (plain terms, the commonest complaint) and no
 * empty state for it to be in.
 */
@Component({
  selector: 'app-simplify-dialog',
  imports: [FormsModule, RunProgressComponent, RunTargetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeSimplify()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Simplify this book">
      <header class="head">
        <span class="title">Simplify</span>
        <button class="x" (click)="ui.closeSimplify()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
        <!--
          THE RUN REPLACES THE FORM. Leaving the fields up while the job moves
          would offer edits that change nothing — the request was composed and
          handed over at the press.
        -->
        @if (watched(); as job) {
          <app-run-progress [job]="job" verb="Rewriting" />
        } @else {
          <!-- WHERE IT WILL RUN, AND WHAT WILL RUN IT. The child draws the one
               real choice and states the rest — run-target.component.ts carries
               the ruling about why the model is not a button. -->
          <app-run-target act="simplify" [(server)]="server" (ready)="canRun.set($event)" />
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
            REAL RADIOS RATHER THAN BUTTONS WEARING RADIO ROLES. This is a
            one-of-three choice, which is what a radio group IS, and the platform
            already gives it arrow keys, a single tab stop and a name a screen
            reader reads out. The card is the label; clicking anywhere on it picks
            the mode, because a 4-pixel dot is not the target anybody is aiming at.
          -->
          <div class="field">
            <span class="label">Rewrite</span>
            <div class="options">
              @for (option of rewrites; track option.mode) {
                <label class="option" [class.picked]="mode() === option.mode">
                  <input
                    type="radio"
                    name="rewrite"
                    [value]="option.mode"
                    [checked]="mode() === option.mode"
                    (change)="mode.set(option.mode)">
                  <span class="option-name">{{ option.name }}</span>
                  <span class="option-what">{{ option.what }}</span>
                </label>
              }
            </div>
          </div>

          <label class="field">
            <span class="label">Rewriter instructions <em>optional</em></span>
            <textarea
              rows="4"
              placeholder="Leave every legal term exactly as written. Do not simplify quoted testimony."
              [ngModel]="instructions()"
              (ngModelChange)="instructions.set($event)"
              name="instructions"></textarea>
          </label>
          <p class="note">
            Appended to the model's instructions word for word. Use it to pin the terms this
            particular book turns on — the words a rewrite must leave untouched.
          </p>

          <p class="note">
            The rewrite lands as a NEW step beside the original, in the same language, and the
            book you are simplifying is never written to. Every paragraph is checked before it
            goes in, and a paragraph the model cannot rewrite to standard fails the whole job —
            nothing half-rewritten is ever written.
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
            <button class="ghost" (click)="ui.closeSimplify()">Cancel</button>
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
          The same two ways to get here as the Translate dialog's empty state, and
          the same answer to each: there is no book yet, or you have deliberately
          stepped back to the import and are standing before the book.
        -->
        <div class="body empty">
          <p>
            There is no book here to simplify. A rewrite says every paragraph again, so the
            pages have to have been read first — and standing on the import row is standing
            before the book: step onto the reading or an edit to rewrite what is there.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeSimplify()">Close</button>
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
     * hardened here after a hunt for a swallowed click (2026-08-21): this host
     * is a full-window sheet of glass, and it was safe only because an @if
     * unmounts it -- which is safety by accident, and the first surface that
     * renders one of these unconditionally becomes a silent full-window click
     * trap. The scrim and the card say auto below, so nothing a person can see
     * behaves differently.
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

    textarea { resize: vertical; min-height: 64px; font-family: inherit; }

    /* THE WHOLE CARD IS THE CONTROL. A row of three tall cards would push the
       fields below it off a 82vh dialog on a laptop, so they stack — which also
       gives each one's sentence a full line to be read on. */
    .options { display: flex; flex-direction: column; gap: 8px; }
    .option {
      display: grid;
      grid-template-columns: auto 1fr;
      grid-template-areas: 'radio name' 'radio what';
      column-gap: 10px;
      row-gap: 3px;
      align-items: baseline;
      padding: 10px 12px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-input);
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .option:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .option.picked { border-color: var(--accent); background: var(--bg-hover); }
    .option input { grid-area: radio; margin: 0; align-self: center; accent-color: var(--accent); }
    .option-name { grid-area: name; font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .option-what { grid-area: what; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
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
export class SimplifyDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  protected readonly rewrites = REWRITES;

  /**
   * The book this rewrite is OF — the Translate dialog's `source`, asked of the
   * same ledger for the same reasons, because the two buttons open onto one fact:
   * the project has a book at its position.
   *
   * A reading has landed or the book arrived as one; standing on the import is the
   * empty state, except where the import IS the book; and a loose file with no
   * ledger behind it has no position to rewrite. What goes to main is the
   * project's ORIGINAL, because the plan resolves the project from any path inside
   * it and materialises the position's own book for itself.
   */
  protected readonly source = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    /*
     * THE SAME PREDICATE THE BUTTON WAS DRAWN BY — see shared/stages.ts. This
     * test used to be spelled out here, in the dock, and in the other dialog:
     * four copies of one rule, which is four chances for a button to offer what
     * a card then refuses. Owen's ruling is that the offer and the possibility
     * are one fact (*"The only options that exist are the ones that are possible
     * for that stage"*), and one fact wants one function.
     */
    if (project === null) return null;
    if (!canSimplifyFrom(project, this.ledger.standingIn(project.dir))) return null;
    /*
     * A CAPTURED FACE STOOD HERE (Wave 41's gravestone) answering the PROJECT
     * DIRECTORY for a captured, read project. It existed because a captured
     * project's archive was PAGES -- a folder, not a file -- since the mint
     * stopped writing a container at `ecbf238`, so `originalOf` found no origin
     * row and this dialog refused the one kind of book the app makes end to end
     * (Owen's first full walk, 2026-08-22: "Open a book first" over an applied,
     * read, captured book).
     *
     * The mint files its PDF now (`catalogueMint`, electron/projects.ts) and
     * every project made before it is healed into one, so `originalOf` answers
     * for a captured book exactly as it does for an imported scan -- which is
     * the line immediately below, unchanged, doing the whole job. Owen: "the
     * system isnt trying to sift through images, it's using the original pdf
     * just like it normally would."
     */
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
   * PLAIN TERMS BY DEFAULT, because it is the complaint that brings people here.
   * The other two are for books somebody already knows something about — that a
   * machine translated it, or that it is being read by a learner — and a person
   * who knows that will pick it.
   */
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
    const project = this.projects.projectFor(this.stage.activeDocument()?.path ?? '');
    return project === null ? undefined : this.ledger.aimedAt(project.dir);
  });

  protected readonly mode = signal<RewriteMode>('dejargon');
  /*
   * NO MODEL, NO OLLAMA AND NO `server` SIGNAL. See the Translate dialog, where
   * all three are argued: the engine chooses the model and the queue row chooses
   * the engine.
   */
  protected readonly instructions = signal('');
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
   * THE ROW THIS CARD IS WATCHING, or null when it is a form. An id rather than
   * the job: the job is re-pushed whole on every change, and a held copy would
   * be a snapshot going stale under a progress bar.
   */
  private readonly watching = signal<string | null>(null);
  /**
   * That row as it stands now. NULL the moment it leaves the list, which is what
   * makes Send to background and a finished run one code path.
   */
  protected readonly watched = computed(() => {
    const id = this.watching();
    if (id === null) return null;
    return this.queue.jobs().find((job) => job.id === id) ?? null;
  });

  /**
   * LET GO OF THE RUN, KEEP THE RUN. Nothing moves and nothing is handed over —
   * the row has been in the queue since the press, so this card simply stops
   * watching and closes.
   */
  protected background(): void {
    this.watching.set(null);
    this.ui.summonQueue(true);
    this.ui.closeSimplify();
  }

  /** Stop the run and go back to being a form, with the values still in it. */
  protected async cancelRun(id: string): Promise<void> {
    await this.queue.cancel(id);
    this.watching.set(null);
  }


  constructor() {
    // A complaint about the last book is cleared when the book changes, and
    // nothing else resets — the instructions in particular are somebody's careful
    // answer and survive switching tabs.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
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
      const rewrite = this.mode();
      const plan = await api.workspace.planSimplification(input, rewrite, this.aim());
      /*
       * BOTH ENDS OF A REWRITE ARE ONE FACT, AND IT IS MAIN'S. The language a book
       * is in is a thing the ledger holds — the translation the position stands
       * under, or the language the reading declared — so this window does not ask
       * for it and does not compose it: the plan resolves it and hands it back as
       * `from`, and the same value is what the run is told to write.
       *
       * The field is optional on the plan shape because a translation fills it
       * only for a chain. A rewrite always fills it, and main refuses outright
       * when it cannot — so an empty one here is that refusal arriving by a route
       * that should not exist, and it is said rather than passed on as a blank
       * `--to`.
       */
      /*
       * ── AND A PROMISED CHAIN IS ALLOWED NOT TO KNOW IT YET ──────────────────
       *
       * Owen, 2026-09-07: *"I'd like to make it possible to chain anything and have
       * it pick up required settings from the last step after it finishes."* A
       * rewrite ordered from a promised translation happens in a language nothing
       * can state until that translation lands, so the plan says so
       * (`DeferredPlan.namesAtSpawn`) and the queue resolves both ends at spawn.
       * The request goes out with no `to` and no `from`, which is the one window
       * `SimplifyRequest` declares them optional for.
       *
       * THE REFUSAL BELOW IS UNTOUCHED FOR EVERY OTHER PRESS, and it is the same
       * refusal it always was: main resolves the language for a landed position or
       * throws, so a blank one arriving here is that failure by a route that should
       * not exist and is said rather than passed on as an empty `--to`.
       */
      const deferred = plan.deferred;
      const to = plan.from ?? '';
      if (to.length === 0 && deferred?.namesAtSpawn !== true) {
        this.problem.set(
          'Foundry could not work out what language this book is in, so there is nothing to '
          + 'rewrite it in.',
        );
        return;
      }
      const request: SimplifyRequest = {
        /*
         * A KIND OF ITS OWN, where this said `translate` and let `rewrite` carry
         * the difference. Owen, 2026-09-05: *"it isnt a translate job. naming it
         * translate is deceptive."* The row in the shelf, the step in the history
         * and the job on the wire all say `simplify` now, and the mode is required
         * rather than optional — a rewrite without one is not a shape this window
         * can build (`SimplifyRequest`, shared/types.ts).
         */
        kind: 'simplify',
        inputPath: plan.inputPath,
        // The position's own book file with every applied change replayed into it,
        // written by main when the plan was made. This window has no opinion about it.
        // ABSENT FOR A DEFERRED PLAN — the queue materialises it at spawn.
        // BOTH ENDS, OR NEITHER. They are one fact and the queue fills both in at
        // spawn when the promised chain could not say it — see above.
        ...(to.length === 0 ? {} : { to, from: to }),
        rewrite,
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
        // Where the answers go, and the whole of what this run makes. Named after
        // the mode as well as the language, so a plain-terms rewrite and an
        // easy-language one of one book are two files and two rows.
        recordsPath: plan.recordsPath,
        // THE ADMISSION THAT THIS IS MADE FROM SOMETHING THAT HAS NOT HAPPENED,
        // carried verbatim — the queue reads it, nothing here interprets it.
        ...(plan.deferred !== undefined ? { deferred: plan.deferred } : {}),
        // Minted by the plan and carried back to the landing, so the row and the
        // file agree about which rewrite this is. Never read here.
        /*
         * THE ROW THIS PASS IS MADE FROM, as main resolved it at the press. It
         * is what the run materialises its book out of when it starts, and it
         * travels as an ID because a path under `derived/` is swept at every
         * settle — see `TranslateRequest.at`. Never read here.
         */
        at: plan.at ?? null,
        stepId: plan.stepId,
      };
      const instructions = this.instructions().trim();
      if (instructions.length > 0) request.instructions = instructions;

      // A refusal is not a success: the queue dedupes on the records path and
      // answers with the row that already exists, so a second press has queued
      // nothing and this card stays put and says so.
      /*
       * PINNED TO THE ENGINE THE CARD NAMED, and pinned AFTER the enqueue rather
       * than carried on the request: `waitFor` is a property of the ROW — a
       * person can re-route a parked row from the shelf — so the queue's own
       * door owns it. A blank server means nothing was chosen and the row keeps
       * the default it was admitted with.
       */
      const { outcome, id } = await this.queue.enqueueTextPassNamed(request);
      if (id !== null && this.server().length > 0) {
        await this.queue.setWaitFor(id, this.server());
      }
      if (outcome === 'already') {
        /*
         * A DUPLICATE IS STILL A RUN SOMEBODY CAN WATCH. Main answers with the
         * EXISTING row, and if that is the work just asked for then Start's
         * honest behaviour is to show it working. Add to queue keeps the
         * sentence, because there the news IS that the shelf did not grow.
         */
        if (release && id !== null) {
          await this.queue.release(id);
          this.watching.set(id);
          return;
        }
        this.problem.set(
          'This rewrite is already queued for this book — nothing was added. It is in the queue.',
        );
        return;
      }

      /*
       * START COMMITS TO THIS ROW AND NOTHING ELSE — `queue:release`, not
       * `queue:start`, which lets go of every row somebody parked deliberately.
       */
      if (release && id !== null) {
        await this.queue.release(id);
        this.watching.set(id);
        return;
      }
      // The queue panel, opened, because the job is HELD and the Start button is
      // in there. Closing onto a shut panel would leave a night of GPU
      // configured, idle and out of sight.
      this.ui.summonQueue(false); // hosted: no queue surface to open, and the call is deliberately nothing
      this.ui.confirmQueued('Simplify queued — it lands in the tree when it finishes.');
      this.ui.closeSimplify();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }
}
