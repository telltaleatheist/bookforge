import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { fold } from '@shared/original';
import { canCleanFrom } from '@shared/stages';
import {
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
  DEFAULT_TRANSLATE_MODEL as DEFAULT_MODEL,
} from '@shared/pipeline';
import type { CleanRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { seedLlmDefaults } from '../../core/llm-defaults';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

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
 * fields are the same fields, in the same order, for the same reasons: the model
 * matters and its trade is real, and Ollama is a server this app never starts.
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
 */
@Component({
  selector: 'app-clean-dialog',
  imports: [FormsModule],
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
            The book's own name, as the tab, the pane and the window are already
            calling it. The path is on the tooltip for the one person who wants
            it — see the Translate dialog, where this field is argued in full.
          -->
          <label class="field">
            <span class="label">Book</span>
            <input type="text" [value]="name()" readonly [title]="input">
          </label>

          <label class="field">
            <span class="label">Model</span>
            <input type="text" [ngModel]="model()" (ngModelChange)="model.set($event)" name="model">
          </label>
          <!--
            The same measured trade the other two dialogs state, because it is the
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

          <p class="note">
            The cleanup lands as a NEW step, in the same language, and the book you are cleaning
            is never written to. Everything you make after it carries the cleaned text —
            translate or simplify afterwards and the cleanup no longer applies, because those
            write fresh sentences of their own.
          </p>

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeClean()">Cancel</button>
          <button class="primary" [disabled]="busy()" (click)="add()">
            {{ busy() ? 'Working…' : 'Add to queue' }}
          </button>
        </footer>
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

  protected readonly model = signal(DEFAULT_MODEL);
  protected readonly ollama = signal(DEFAULT_OLLAMA);
  protected readonly problem = signal<string | null>(null);
  /** The plan materialises the position's whole book before it answers. Not instant. */
  protected readonly busy = signal(false);

  constructor() {
    // The model and the URL are the app's own settings, written by first-run
    // setup after it measured the machine — see core/llm-defaults.ts.
    seedLlmDefaults(this.model, this.ollama);
    // A complaint about the last book is cleared when the book changes.
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
      const plan = await api.workspace.planCleanup(input);
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
        // The position's own book file with every applied change replayed into it,
        // written by main when the plan was made. This window has no opinion about it.
        bookPath: plan.bookPath,
        recordsPath: plan.recordsPath,
        stampPath: plan.stampPath,
        model: this.model().trim() || DEFAULT_MODEL,
        ollama: this.ollama().trim() || DEFAULT_OLLAMA,
        ...(plan.seedRecords !== undefined ? { seedRecords: plan.seedRecords } : {}),
        ...(plan.generation !== undefined ? { generation: plan.generation } : {}),
        // Minted by the plan and carried back to the landing, so the row and the
        // file agree about which cleanup this is. Never read here.
        stepId: plan.stepId,
      };

      // A refusal is not a success: the queue dedupes on the records path and
      // answers with the row that already exists, so a second press has queued
      // nothing and this card stays put and says so.
      if (await this.queue.enqueueTextPass(request) === 'already') {
        this.problem.set(
          'This cleanup is already queued for this book — nothing was added. It is in the queue.',
        );
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
      this.busy.set(false);
    }
  }
}
