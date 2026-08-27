import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  ANALYSIS_CATEGORIES,
  ANALYSIS_CATEGORY_IDS,
  CUSTOM_CATEGORY_DESCRIPTION_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  customCategoryId,
  type CustomAnalysisCategory,
} from '@shared/analysis-categories';
import { fold } from '@shared/original';
import { canTranslateFrom } from '@shared/stages';
import {
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
  DEFAULT_TRANSLATE_MODEL as DEFAULT_MODEL,
} from '@shared/pipeline';
import type { AnalyzeRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { seedLlmDefaults } from '../../core/llm-defaults';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/*
 * THE TWO DEFAULTS ARE IMPORTED AND NEVER COPIED, exactly as the Translate dialog
 * imports them and for the same reason spelled there: they are the engine's own
 * defaults, they are what a person is shown before they change them, and a model
 * id written down twice is a bump that applies to one of two places.
 *
 * `DEFAULT_TRANSLATE_MODEL` IS THE RIGHT CONSTANT DESPITE ITS NAME, and the name
 * is worth one sentence rather than a second constant beside it. It is Owen's
 * standing ruling about which model this program asks — *"27b is the standard
 * we'll use for every task"* — and the verifier is one of those tasks
 * (docs/ANALYSIS.md §2 names the same value). A second constant holding the same
 * string would be the drift this import exists to prevent, arriving under a
 * better name.
 */

/**
 * Analysis — configure ONE reading of this book against the categories, and put
 * it in the queue.
 *
 * The Translate dialog's shape, deliberately (docs/ANALYSIS.md §7): it enqueues
 * and nothing else, the run belongs to main, and dismissing this does not touch a
 * job that is already moving. Three things differ, and all three are rulings.
 *
 *   **THE CHECKLIST IS THE QUESTION.** Which categories to look for is the whole
 *   of what makes this analysis this one — it decides what the report contains,
 *   and therefore whether a second run refreshes the row you have or files a new
 *   one beside it (`PARAMS_OF.analysis`, shared/ledger.ts). So the run is ordered
 *   from a list of CHECKBOXES and never from a text field: every name that leaves
 *   here is one the engine has a calibrated hypothesis, a first-draft hypothesis,
 *   or a saved description for.
 *
 *   **AND THE LIST CAN BE ADDED TO.** Owen, 2026-08-25: *"maybe the user can add
 *   more categories - even one-sentence descriptive ones. and they check off which
 *   ones they want to search for in this document."* Engine-side this is not a new
 *   door: `buildPlan` (src/analyze/plan.ts) has always taken a description-backed
 *   category and wrapped the sentence into its one hypothesis, and the two
 *   built-ins Owen named himself — anti-evolution, authoritarian-blueprint — came
 *   in through exactly that shape. What was missing was a way to say one from the
 *   app.
 *
 *   THE SENTENCE IS THE HYPOTHESIS, WHICH IS WHY THE FIELD ASKS FOR A CLAIM. It
 *   is scored against every sentence in the book as *"The author's statement
 *   matches this description: …"*, so "conscription" finds nothing and "the author
 *   argues that military service should be compulsory" finds something. The dialog
 *   says so, and every category made this way is marked untuned in the report,
 *   because nothing has calibrated a sentence somebody typed this afternoon.
 *
 *   ADDING ONE IS A SAVE AND NOT A KEYSTROKE, and that is what keeps the old
 *   sentence about free text true in its new form. A typed name becomes a category
 *   only by being written into `app-settings.json` through main's own door, where
 *   it is slugged, capped and collision-checked (`clampAnalysisCategories`); the
 *   plan door then admits a name only if that file already holds it. So the path
 *   from a text box to a prompt runs through a deliberate act of saving, and what
 *   reaches the engine is always a string main itself minted.
 *
 *   THEY ARE THE USER'S AND NOT THIS BOOK'S. The list persists app-level, beside
 *   the library folder, and reaches every book on the machine; what is decided per
 *   run is which of them are ticked. Removing one is allowed and costs no report:
 *   a report carries its own category list (`AnalysisReading.categories`) and the
 *   panel names a category it has never heard of by saying its id aloud
 *   (`analysisCategoryName`), so an old report goes on rendering in full after the
 *   category it names has been deleted.
 *
 *   **THERE IS NO SENSITIVITY CONTROL.** Owen, 2026-08-25: *"it flags absolutely
 *   anything that could possibly match and then we have a button that displays
 *   things that match strictly (only turn up a few options), a moderate filter, or
 *   a very loose filter."* The run captures ONCE at the widest calibrated net;
 *   strictness is three buttons on the panel, over stored scores, so changing your
 *   mind costs a click and never another hour. A knob here would be a knob whose
 *   good value is known, which is the shape this app keeps refusing.
 *
 *   **IT SAYS HOW LONG IT WILL TAKE, BEFORE THE BUTTON.** Ranking is minutes and
 *   verifying is one model call per surviving passage, which is an hour on a hot
 *   book. That is the fact somebody deciding whether to tick all twelve boxes
 *   actually needs, and a number met after the press is a number met too late.
 */
@Component({
  selector: 'app-analysis-dialog',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeAnalysis()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Analyse this book">
      <header class="head">
        <span class="title">Analysis</span>
        <button class="x" (click)="ui.closeAnalysis()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
          <!--
            THE BOOK'S NAME AND NOT ITS PATH, the Translate dialog's own rule: the
            book's title is what the tab, the tree and the window already call it,
            and a workspace path in a narrow box is a string nobody can read half
            of. The path is on the tooltip for the one person who wants it.
          -->
          <label class="field">
            <span class="label">Book</span>
            <input type="text" [value]="name()" readonly [title]="input">
          </label>

          <div class="field">
            <span class="label">Look for <em>every ticked category is measured over every sentence</em></span>
            <div class="checklist">
              @for (one of categories; track one.id) {
                <label class="check" [class.on]="picked().has(one.id)">
                  <input
                    type="checkbox"
                    [checked]="picked().has(one.id)"
                    (change)="flip(one.id)">
                  <span class="check-name">{{ one.name }}</span>
                  <!--
                    UNTUNED SAID QUIETLY AND BEFORE THE RUN. docs/ANALYSIS.md §5:
                    these two have no calibrated hypothesis yet, so they may turn
                    up too much or too little, and the report names them as
                    untuned. The person deciding whether to spend an hour is the
                    person who wants to know which half of this list has been
                    measured — which is why it is here and not only afterwards.
                  -->
                  @if (!one.tuned) {
                    <span class="check-note" title="No calibrated hypothesis yet — a first draft">draft</span>
                  }
                </label>
              }
            </div>
          </div>

          <!--
            THE USER'S OWN, IN THEIR OWN BLOCK. They are kept apart from the
            twelve rather than mixed in, and the reason is that they are a
            different KIND of thing: the built-ins are the engine's list and
            cannot be removed, these are a list this person keeps and can. One
            grid with three removable rows scattered through it would make every
            row look like it might vanish.
          -->
          @if (mine().length > 0) {
            <div class="field">
              <span class="label">Yours <em>scored from the sentence you wrote</em></span>
              <div class="checklist mine">
                @for (one of mine(); track one.id) {
                  <label class="check own" [class.on]="picked().has(one.id)">
                    <input
                      type="checkbox"
                      [checked]="picked().has(one.id)"
                      (change)="flip(one.id)">
                    <span class="check-name">
                      {{ one.name }}
                      <em class="check-said">{{ one.description }}</em>
                    </span>
                    <!--
                      REMOVE, AS A BUTTON INSIDE A LABEL, which needs the press
                      stopped: a click anywhere in a label toggles its checkbox,
                      so without this the ✕ would tick the category on its way to
                      deleting it.
                    -->
                    <button
                      type="button"
                      class="drop"
                      [attr.aria-label]="'Remove ' + one.name"
                      (click)="$event.preventDefault(); drop(one.id)"
                    >✕</button>
                  </label>
                }
              </div>
            </div>
          }

          <!--
            ADDING ONE. Two fields and a button, folded away until asked for: the
            ordinary visit to this dialog ticks boxes and presses Add to queue,
            and a form standing open in the middle of it would be a question
            nobody came here to answer.
          -->
          @if (adding()) {
            <div class="field adder">
              <input
                type="text"
                class="add-name"
                placeholder="Name — what the legend will call it"
                [attr.maxlength]="nameMax"
                [ngModel]="newName()"
                (ngModelChange)="newName.set($event)"
                name="newName">
              <textarea
                class="add-said"
                rows="2"
                placeholder="One sentence: the claim the author would be making. “The author argues that …”"
                [attr.maxlength]="saidMax"
                [ngModel]="newSaid()"
                (ngModelChange)="newSaid.set($event)"
                name="newSaid"></textarea>
              <p class="note">
                The sentence <strong>is</strong> what gets measured — every sentence in the book is
                scored against it. A claim finds passages; a topic finds nothing. Nothing has
                calibrated it, so the report will mark this category as a first draft.
              </p>
              @if (addProblem(); as reason) {
                <p class="problem">{{ reason }}</p>
              }
              <div class="picks">
                <button class="ghost small" (click)="stopAdding()">Cancel</button>
                <button class="ghost small" [disabled]="saving()" (click)="save()">
                  {{ saving() ? 'Saving…' : 'Add category' }}
                </button>
              </div>
            </div>
          }

          <div class="picks">
            <button class="ghost small" (click)="pickAll()">All</button>
            <button class="ghost small" (click)="pickNone()">None</button>
            @if (!adding()) {
              <button class="ghost small" (click)="startAdding()">Add a category…</button>
            }
            <span class="tally">{{ picked().size }} of {{ all().length }}</span>
          </div>

          <label class="field">
            <span class="label">Model <em>the verifier, not the ranker</em></span>
            <input type="text" [ngModel]="model()" (ngModelChange)="model.set($event)" name="model">
          </label>
          <!--
            THE TWO STAGES, NAMED, because the field above only governs one of
            them and a person changing it should know which. The ranking is done
            by an entailment model this app does not offer a choice about; what
            this names is the model that answers the one question the ranker
            cannot — is the author asserting this, or reporting it.
          -->
          <p class="note">
            Every sentence is scored by an entailment model first — that pass is
            fixed and takes minutes. This model answers the question that decides a
            flag: <strong>is the author asserting this claim, or quoting, questioning
            or arguing against it?</strong> One call per surviving passage, which is
            what makes a hot book an hour.
          </p>

          <label class="field">
            <span class="label">Ollama <em>used, never started</em></span>
            <input type="text" [ngModel]="ollama()" (ngModelChange)="ollama.set($event)" name="ollama">
          </label>

          <p class="note">
            The report is filed as a step under the one you are standing on, and nothing about the
            book changes. How strict to be is decided afterwards, in the panel — the run finds
            everything it possibly can, once, and three buttons narrow it.
          </p>

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
        </div>

        <footer class="foot">
          <button class="ghost" (click)="ui.closeAnalysis()">Cancel</button>
          <button
            class="primary"
            [disabled]="busy() || picked().size === 0"
            (click)="add()"
          >
            {{ busy() ? 'Working…' : 'Add to queue' }}
          </button>
        </footer>
      } @else {
        <!--
          THE EMPTY STATE NAMES THE TWO WAYS TO GET HERE, the Translate dialog's
          own reasoning: no book made yet, or deliberately standing back on the
          import. They want different things from the person reading it.
        -->
        <div class="body empty">
          <p>
            There is no book here to analyse. An analysis reads the blocks Foundry made when it
            read the pages, so the pages have to be read first — and standing on the import row is
            standing before the book: step onto the reading or an edit to analyse what is there.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeAnalysis()">Close</button>
          <button class="primary" (click)="openDocument()">Open a book…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT -- confirm-dialog's rule,
     * kept verbatim across every card in this app. 1200 is the dialog layer; the
     * confirmation keeps 1300 so the guard can still draw over this.
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

    /*
      TWO COLUMNS, BECAUSE TWELVE ROWS IN ONE COLUMN IS A SCROLLER. The checklist
      is the one decision on this card that is read as a WHOLE — "am I looking for
      everything, or these three" — and a list that cannot be seen at once is a
      list somebody ticks by memory.
    */
    .checklist {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 2px 10px;
    }
    .check {
      display: flex; align-items: center; gap: 6px;
      padding: 4px 6px;
      border-radius: var(--radius-sm);
      font-size: 12px; color: var(--text-secondary);
      cursor: pointer;
      user-select: none;
    }
    .check:hover { background: var(--bg-hover); }
    .check.on { color: var(--text-primary); }
    .check-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* A word and not a colour: an untuned category is not a WARNING, it is a fact
       about how much has been measured, and an amber pip beside four rows of a
       checklist would read as something being wrong with them. */
    .check-note {
      flex: 0 0 auto;
      font-family: var(--font-mono);
      font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text-tertiary);
    }

    /*
      ONE COLUMN FOR THE USER'S OWN, because each of them carries a SENTENCE and
      a sentence in a half-width cell is three lines of four words. The twelve
      built-ins are names and fit two abreast; these are not the same shape.
    */
    .checklist.mine { grid-template-columns: 1fr; }
    .check.own { align-items: flex-start; }
    .check.own input { margin-top: 3px; }
    .check-said {
      display: block;
      font-style: normal;
      font-size: 10.5px; line-height: 1.4;
      color: var(--text-tertiary);
      white-space: normal;
    }
    .check.own .check-name { overflow: visible; white-space: normal; }
    .drop {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 10px;
      padding: 2px 4px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .drop:hover { background: var(--bg-active); color: var(--danger, var(--warn)); }

    .adder {
      padding: 10px;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      background: var(--bg-sunken);
    }
    .add-said { resize: vertical; min-height: 44px; line-height: 1.45; }

    .picks { display: flex; align-items: center; gap: 8px; }
    .tally {
      margin-left: auto;
      font-size: 11px; color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

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
    .ghost.small { height: 24px; padding: 0 10px; font-size: 11px; }
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
export class AnalysisDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  /**
   * The book this analysis is OF — a PROJECT WITH A BOOK IN IT, named by its
   * original document.
   *
   * `canTranslateFrom` AND NOT A PREDICATE OF ITS OWN, which is worth arguing
   * because it looks like borrowing. The question both acts ask is identical: is
   * there a BOOK at this position — a reading has landed, or the book arrived as
   * one — and are we standing somewhere other than the untouched import. An
   * analysis reads exactly what a translation reads (the position's materialised
   * book file), refuses exactly where a translation refuses, and is offered from
   * exactly the same rows.
   *
   * Owen's ruling is that the offer and the possibility are one fact (*"The only
   * options that exist are the ones that are possible for that stage"*), and one
   * fact wants ONE function — the four copies of this test that existed before
   * `shared/stages.ts` are the argument. A fifth copy that happened to agree today
   * is a fifth chance for a button to offer what a card then refuses.
   */
  protected readonly source = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return null;
    if (!canTranslateFrom(project, this.ledger.standingIn(project.dir))) return null;
    return this.projects.originalOf(project)?.path ?? null;
  });

  /** What that book is CALLED. The Translate dialog's `name`, for its reasons. */
  protected readonly name = computed(() => {
    const input = this.source();
    if (input === null) return '';
    const at = fold(input);
    const showing = this.documents.tabs().find((tab) => fold(tab.path) === at);
    return showing?.title ?? this.projects.nameFor(input);
  });

  /** The checklist, from the one table. See shared/analysis-categories.ts. */
  protected readonly categories = ANALYSIS_CATEGORIES;

  /**
   * The categories this person has written, as main holds them.
   *
   * SET ONLY FROM MAIN'S ANSWER and never optimistically. Every write comes back
   * with the list as it was actually stored — ids re-derived from names, fields
   * trimmed and capped, collisions dropped (`clampAnalysisCategories`) — so
   * taking the answer is what keeps the window and the file from disagreeing
   * about an id that a checklist is about to be keyed on.
   */
  protected readonly mine = signal<readonly CustomAnalysisCategory[]>([]);

  /** The built-ins and the user's own, in the order the plan will take them. */
  protected readonly all = computed<readonly { id: string; name: string; description?: string }[]>(
    () => [...ANALYSIS_CATEGORIES, ...this.mine()],
  );

  protected readonly nameMax = CUSTOM_CATEGORY_NAME_MAX;
  protected readonly saidMax = CUSTOM_CATEGORY_DESCRIPTION_MAX;

  /** Whether the add form is open, and what is in it. */
  protected readonly adding = signal(false);
  protected readonly newName = signal('');
  protected readonly newSaid = signal('');
  protected readonly addProblem = signal<string | null>(null);
  protected readonly saving = signal(false);

  /**
   * WHICH BOXES ARE TICKED — every one of them, to begin with.
   *
   * THE DEFAULT IS EVERYTHING, and that is the same ruling the sensitivity knob
   * lost to: the run is meant to find anything it possibly can, once, and the
   * narrowing happens afterwards. Somebody who knows they only care about two
   * categories can say so and pay for two; somebody who does not know yet should
   * not have to guess before the machine has looked.
   */
  protected readonly picked = signal<ReadonlySet<string>>(
    new Set(ANALYSIS_CATEGORY_IDS),
  );

  protected readonly model = signal(DEFAULT_MODEL);
  protected readonly ollama = signal(DEFAULT_OLLAMA);
  protected readonly problem = signal<string | null>(null);
  /** The plan hashes the whole book to key it, and materialises one. Not instant. */
  protected readonly busy = signal(false);

  constructor() {
    // The model and the URL are the app's own settings, written by first-run
    // setup after it measured the machine — see core/llm-defaults.ts.
    seedLlmDefaults(this.model, this.ollama);
    // The Translate dialog's rule: a complaint about the last book is cleared when
    // the book changes, and nothing else resets. The checklist in particular is
    // the user's careful answer and survives switching tabs.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
    void this.loadMine();
  }

  /**
   * The user's own categories, read once when this card is built.
   *
   * TICKED ON ARRIVAL, because the default is everything and these are part of
   * everything — a person who saved a category and then found it unticked would
   * reasonably conclude the saving had not worked. They are ADDED to whatever is
   * already ticked rather than replacing it, so a read that lands while somebody
   * is untickíng boxes does not undo them.
   *
   * A FAILURE IS SILENT AND MEANS "NONE". There is no bridge at all in a browser
   * build, and a person who has never added a category is the ordinary case; a
   * red sentence about a settings file at the top of a dialog somebody opened to
   * analyse a book would be an error message about a feature they are not using.
   */
  private async loadMine(): Promise<void> {
    if (!api) return;
    try {
      const held = await api.analysis.readCategories();
      this.mine.set(held);
      this.picked.update((was) => new Set([...was, ...held.map((one) => one.id)]));
    } catch {
      this.mine.set([]);
    }
  }

  protected startAdding(): void {
    this.adding.set(true);
    this.addProblem.set(null);
  }

  protected stopAdding(): void {
    this.adding.set(false);
    this.addProblem.set(null);
    this.newName.set('');
    this.newSaid.set('');
  }

  /**
   * SAVE A CATEGORY — and refuse, in words, everything that cannot become one.
   *
   * The refusals are checked HERE as well as in main, and that is not belt and
   * braces: main CLAMPS (it drops what it cannot use, silently, because a
   * hand-edited file with one bad row should cost that row and not the list), and
   * a clamp is exactly the wrong answer to a person who has just typed something
   * and pressed a button. What they are owed is a sentence saying which part of
   * it was the problem. Main's clamp remains the guarantee about what is on the
   * disk; this is the conversation.
   */
  protected async save(): Promise<void> {
    if (!api) return;
    const name = this.newName().replace(/\s+/g, ' ').trim();
    const description = this.newSaid().replace(/\s+/g, ' ').trim();
    if (name.length === 0) {
      this.addProblem.set('Give it a name — that is what the checklist and the legend will say.');
      return;
    }
    if (description.length === 0) {
      this.addProblem.set(
        'Write the sentence. It is the whole of what gets measured: without it there is nothing '
        + 'to score a sentence of the book against.',
      );
      return;
    }
    const id = customCategoryId(name);
    if (id.length === 0) {
      this.addProblem.set('That name is all punctuation, so there is nothing to file it under.');
      return;
    }
    if (ANALYSIS_CATEGORY_IDS.includes(id)) {
      this.addProblem.set(
        `Foundry already looks for something it calls “${name}”, with hypotheses that were `
        + 'measured. It is on the list above.',
      );
      return;
    }
    if (this.mine().some((one) => one.id === id)) {
      this.addProblem.set(`You already have a category called “${name}”.`);
      return;
    }
    this.saving.set(true);
    this.addProblem.set(null);
    try {
      const held = await api.analysis.writeCategories([...this.mine(), { id, name, description }]);
      this.mine.set(held);
      this.picked.update((was) => new Set([...was, id]));
      this.stopAdding();
    } catch (err) {
      this.addProblem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Remove one of the user's own categories.
   *
   * NO CONFIRMATION, and no report is harmed. What is destroyed is a name and a
   * sentence, both of them one retype away; what is NOT destroyed is any report
   * that named it, because a report carries its own category list
   * (`AnalysisReading.categories`) and the panel says an unfamiliar id aloud
   * rather than refusing to draw it (`analysisCategoryName`). A guard card in
   * front of a two-field record would be this app's confirmation habit applied
   * where there is nothing to lose.
   */
  protected async drop(id: string): Promise<void> {
    if (!api) return;
    try {
      const held = await api.analysis.writeCategories(this.mine().filter((one) => one.id !== id));
      this.mine.set(held);
      this.picked.update((was) => {
        const next = new Set(was);
        next.delete(id);
        return next;
      });
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected flip(id: string): void {
    this.picked.update((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected pickAll(): void {
    this.picked.set(new Set(this.all().map((one) => one.id)));
  }

  protected pickNone(): void {
    this.picked.set(new Set());
  }

  protected openDocument(): void {
    void this.documents.openViaDialog();
  }

  protected async add(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;
    const ticked = this.picked();
    if (ticked.size === 0) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      /*
       * IN THE TABLE'S ORDER, which is the engine's plan order — and main
       * re-orders it again for itself, because that list is the step's own
       * QUESTION and two spellings of one checklist would be two questions
       * (`workspace:plan-analysis`, electron/ipc.ts). Sending it ordered here as
       * well is not belt and braces: it is what makes the request legible to
       * anybody reading it, and it costs one filter.
       */
      const asked = this.all().filter((one) => ticked.has(one.id)).map((one) => one.id);
      // Main names the report, mints the step and materialises the book the run
      // reads — every path in the answer is main's composition. See `AnalysisPlan`.
      const plan = await api.workspace.planAnalysis(input, asked);
      const request: AnalyzeRequest = {
        kind: 'analysis',
        inputPath: plan.inputPath,
        bookPath: plan.bookPath,
        outputPath: plan.outputPath,
        /*
         * THE WHOLE SET, WITH THE UNTICKED ONES MARKED rather than a shorter
         * array. It is the spelling `buildPlan` documents itself as accepting from
         * this app (src/analyze/plan.ts), and the reason is that a list composed
         * by DROPPING names is indistinguishable from a list of the only
         * categories this build has heard of — so the day the engine grows a
         * thirteenth, a shortened list would silently turn it off.
         *
         * THE USER'S OWN CARRY THEIR SENTENCE, and they have to: the engine has no
         * hypotheses for a name it has never heard of, so `buildPlan` refuses
         * outright a category given neither a description nor hypotheses of its
         * own. A built-in never carries one — its hypotheses are the measured
         * ones, and a description beside them would be a second opinion about a
         * calibrated question.
         */
        categories: this.all().map((one) => ({
          name: one.id,
          enabled: ticked.has(one.id),
          ...(one.description !== undefined ? { description: one.description } : {}),
          // The display name rides with the id so the report's `names` header
          // shows every device — the phone included — the words this dialog
          // shows, a custom category's exactly as its author typed them.
          label: one.name,
        })),
        model: this.model().trim() || DEFAULT_MODEL,
        ollama: this.ollama().trim() || DEFAULT_OLLAMA,
        // Main's answer travelling back to main: the step the report is named
        // after, minted at the plan so the file and the row agree hours later.
        stepId: plan.stepId,
      };

      /*
       * A REFUSAL IS NOT A SUCCESS, the Translate dialog's own hard-won line: main
       * dedupes on the report path and answers with the row that already exists,
       * so a second press would otherwise announce an analysis it had not queued
       * and close over the evidence.
       */
      if (await this.queue.enqueueAnalysis(request) === 'already') {
        this.problem.set(
          'This analysis is already queued for this book — nothing was added. It is in the queue.',
        );
        return;
      }
      /*
       * The queue panel, opened, and it matters for the reason it matters after a
       * translation: the job is HELD, so nothing happens until Start is pressed
       * and that button is inside it. Closing this dialog onto a shut panel would
       * leave an analysis configured, idle and out of sight.
       */
      this.ui.summonQueue(false);
      this.ui.confirmQueued('Analysis queued — the report lands on its own step when it finishes.');
      this.ui.closeAnalysis();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
