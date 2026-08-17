import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { fold } from '@shared/original';
import {
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
  DEFAULT_TRANSLATE_MODEL as DEFAULT_MODEL,
} from '@shared/pipeline';
import type { RewriteMode, TranslateRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

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
 * are the same fields, in the same order, for the same reasons: the model matters
 * and its trade is real, Ollama is a server this app never starts, and the
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
  imports: [FormsModule],
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
            The book's own name, as the tab, the pane and the window are already
            calling it. The path is on the tooltip for the one person who wants
            it — see the Translate dialog, where this field is argued in full.
          -->
          <label class="field">
            <span class="label">Book</span>
            <input type="text" [value]="name()" readonly [title]="input">
          </label>

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
            <span class="label">Model</span>
            <input type="text" [ngModel]="model()" (ngModelChange)="model.set($event)" name="model">
          </label>
          <!--
            The same measured trade the Translate dialog states, because it is the
            same model doing the same per-block work for the same hours.
          -->
          <p class="note">
            <strong>qwen3:32b</strong> is the most faithful of the models measured and is slow —
            hours for a full book. <strong>qwen2.5:14b</strong> is roughly twice as fast and good
            for a draft, but drops the occasional clause.
          </p>

          <label class="field">
            <span class="label">Ollama <em>used, never started</em></span>
            <input type="text" [ngModel]="ollama()" (ngModelChange)="ollama.set($event)" name="ollama">
          </label>

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
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeSimplify()">Cancel</button>
          <button class="primary" [disabled]="busy()" (click)="add()">
            {{ busy() ? 'Working…' : 'Add to queue' }}
          </button>
        </footer>
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
    :host { position: fixed; inset: 0; z-index: 1200; display: block; }

    .scrim {
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }

    .card {
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
    if (project === null) return null;
    const arrived = this.projects.arrivedAsBook(project);
    if (!project.reading.done && !arrived) return null;
    if (!arrived && this.ledger.standingIn(project.dir)?.action === 'import') return null;
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
  protected readonly mode = signal<RewriteMode>('dejargon');
  protected readonly model = signal(DEFAULT_MODEL);
  protected readonly ollama = signal(DEFAULT_OLLAMA);
  protected readonly instructions = signal('');
  protected readonly problem = signal<string | null>(null);
  /** The plan materialises the position's whole book before it answers. Not instant. */
  protected readonly busy = signal(false);

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

  protected async add(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      const rewrite = this.mode();
      const plan = await api.workspace.planSimplification(input, rewrite);
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
      const to = plan.from ?? '';
      if (to.length === 0) {
        this.problem.set(
          'Foundry could not work out what language this book is in, so there is nothing to '
          + 'rewrite it in.',
        );
        return;
      }
      const request: TranslateRequest = {
        kind: 'translate',
        inputPath: plan.inputPath,
        // The position's own book file with every applied change replayed into it,
        // written by main when the plan was made. This window has no opinion about it.
        bookPath: plan.bookPath,
        to,
        from: to,
        rewrite,
        model: this.model().trim() || DEFAULT_MODEL,
        ollama: this.ollama().trim() || DEFAULT_OLLAMA,
        // Where the answers go, and the whole of what this run makes. Named after
        // the mode as well as the language, so a plain-terms rewrite and an
        // easy-language one of one book are two files and two rows.
        recordsPath: plan.recordsPath,
        ...(plan.seedRecords !== undefined ? { seedRecords: plan.seedRecords } : {}),
        ...(plan.generation !== undefined ? { generation: plan.generation } : {}),
        // Minted by the plan and carried back to the landing, so the row and the
        // file agree about which rewrite this is. Never read here.
        stepId: plan.stepId,
      };
      const instructions = this.instructions().trim();
      if (instructions.length > 0) request.instructions = instructions;

      // A refusal is not a success: the queue dedupes on the records path and
      // answers with the row that already exists, so a second press has queued
      // nothing and this card stays put and says so.
      if (await this.queue.enqueueTranslate(request) === 'already') {
        this.problem.set(
          'This rewrite is already queued for this book — nothing was added. It is in the queue shelf.',
        );
        return;
      }
      // The shelf, opened, because the job is HELD and the Start button is in
      // there. Closing onto a collapsed shelf would leave a night of GPU
      // configured, idle and out of sight.
      this.ui.shelfExpanded.set(true);
      this.ui.closeSimplify();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
