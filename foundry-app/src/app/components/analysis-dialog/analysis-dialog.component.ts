import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  ANALYSIS_CATEGORIES,
  ANALYSIS_CATEGORY_IDS,
  CUSTOM_CATEGORY_DESCRIPTION_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  customCategoryId,
  type CustomAnalysisCategory,
} from '@shared/analysis-categories';
import { SUGGEST_HINT_MAX, type SuggestProgress } from '@shared/category-suggestions';
import { fold } from '@shared/original';
import { canTranslateFrom } from '@shared/stages';
import {
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
  DEFAULT_TRANSLATE_MODEL as DEFAULT_MODEL,
} from '@shared/pipeline';
import { withChosenModel } from '@shared/job-model-offer';
import type { AnalyzeRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { RunProgressComponent } from '../run-progress/run-progress.component';
import { RunTargetComponent } from '../run-target/run-target.component';
import { JobModelComponent } from '../job-model/job-model.component';
import { api, hosted } from '../../core/foundry';

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
 *   here is one the engine has a measured line, a first-draft line, or a saved
 *   description for.
 *
 *   **AND THE LIST CAN BE ADDED TO.** Owen, 2026-08-25: *"maybe the user can add
 *   more categories - even one-sentence descriptive ones. and they check off which
 *   ones they want to search for in this document."* Engine-side this is not a new
 *   door: `buildPlan` (src/analyze/plan.ts) has always taken a description-backed
 *   category. What was missing was a way to say one from the app.
 *
 *   THE SENTENCE IS THE QUESTION, WHICH IS WHY THE FIELD ASKS FOR A CLAIM. Its
 *   first sentence is the line the ranker offers for the category and the whole
 *   of it is what the verifier tests, so "conscription" finds nothing and "the
 *   author argues that military service should be compulsory" finds something.
 *   The dialog says so, and every category made this way is marked untuned in the
 *   report, because nothing has calibrated a sentence somebody typed this
 *   afternoon.
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
  imports: [FormsModule, RunProgressComponent, RunTargetComponent, JobModelComponent],
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
          THE RUN REPLACES THE FORM. Leaving the fields up while the job moves
          would offer edits that change nothing — the request was composed and
          handed over at the press.
        -->
        @if (watched(); as job) {
          <app-run-progress [job]="job" [verb]="job.kind === 'analysis-rank' ? 'Scoring the sentences' : 'Checking the passages'" />
        } @else {
          <!-- WHERE IT WILL RUN, AND WHAT WILL RUN IT. Two choices now, and
               both are real. The model is a dropdown on Owen's ruling of
               2026-10-25, verbatim: "put the option the user can pick in a
               dropdown on the modal that configures the job"; "cloud accounts
               should be listed as an option in every model dropdown if its
               available, just like 27b or 9b or anything else. however,
               bookforge should use the last used model as the default. the
               ideal is that the user wont need to use cloud models because
               theyre expensive. but it should be there if their system is too
               weak to run a local model"; "keep it at 27b as the max right
               now". job-model.component.ts carries the rest. -->
          <app-run-target act="analysis" [(server)]="server" (ready)="canRun.set($event)" />
          <app-job-model kind="analysis" [server]="server()" [(value)]="chosenModel"
                         (ready)="modelReady.set($event)" />
          <!--
            THE BOOK'S NAME AND NOT ITS PATH, the Translate dialog's own rule: the
            book's title is what the tab, the tree and the window already call it,
            and a workspace path in a narrow box is a string nobody can read half
            of. The path is on the tooltip for the one person who wants it.
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
            LIT BOXES, NOT CHECKBOXES (Owen, 2026-10-30: "checkbox isnt the
            bookforge way of doing it … having a box that contains the text and
            clicking the box and it lights up the whole box"). The export
            dialog's format cards are the pattern: the chosen box wears the
            accent fill and border. These are many-of-many, so each is a toggle
            (aria-pressed) rather than a radio.
          -->
          <div class="field">
            <span class="label">Look for <em>every lit category is measured over every sentence</em></span>
            <div class="checklist">
              @for (one of categories; track one.id) {
                <button
                  type="button"
                  class="pick"
                  [class.on]="picked().has(one.id)"
                  [attr.aria-pressed]="picked().has(one.id)"
                  (click)="flip(one.id)">
                  <span class="pick-head">
                    <span class="pick-name">{{ one.name }}</span>
                    <!--
                      UNTUNED SAID QUIETLY AND BEFORE THE RUN. docs/ANALYSIS.md §5:
                      these have no measured line yet, so they may turn up too
                      much or too little, and the report names them as untuned.
                    -->
                    @if (!one.tuned) {
                      <span class="pick-tag" title="Not measured yet — a first draft">draft</span>
                    }
                  </span>
                  <span class="pick-said">{{ one.about }}</span>
                </button>
              }
            </div>
          </div>

          <!--
            THE USER'S OWN, IN THEIR OWN BLOCK — typed, or suggested from a book
            and saved the moment the model wrote them. They are kept apart from
            the built-ins because they are a different KIND of thing: the
            built-ins are the engine's list and cannot be changed, these are a
            list this person keeps, edits (the pencil) and removes (the ✕).
            A box with buttons inside it cannot itself be a <button>, so it is a
            toggle by role, and the two small buttons stop their press from
            reaching it.
          -->
          @if (mine().length > 0) {
            <div class="field">
              <span class="label">Yours <em>scored from the sentence you wrote, or the model suggested</em></span>
              <div class="checklist mine">
                @for (one of mine(); track one.id) {
                  @if (editing() === one.id) {
                    <div class="pick editing">
                      <input
                        type="text"
                        [attr.maxlength]="nameMax"
                        [ngModel]="editName()"
                        (ngModelChange)="editName.set($event)"
                        [attr.aria-label]="'Name of ' + one.name">
                      <textarea
                        rows="3"
                        [attr.maxlength]="saidMax"
                        [ngModel]="editSaid()"
                        (ngModelChange)="editSaid.set($event)"
                        [attr.aria-label]="'Description of ' + one.name"></textarea>
                      @if (editProblem(); as reason) {
                        <p class="problem">{{ reason }}</p>
                      }
                      <div class="picks">
                        <button type="button" class="ghost small" (click)="stopEditing()">Cancel</button>
                        <button type="button" class="ghost small" [disabled]="saving()" (click)="saveEdit(one.id)">
                          {{ saving() ? 'Saving…' : 'Save' }}
                        </button>
                      </div>
                    </div>
                  } @else {
                    <div
                      class="pick own"
                      role="button"
                      tabindex="0"
                      [class.on]="picked().has(one.id)"
                      [attr.aria-pressed]="picked().has(one.id)"
                      (click)="flip(one.id)"
                      (keydown.enter)="flip(one.id)"
                      (keydown.space)="$event.preventDefault(); flip(one.id)">
                      <span class="pick-head">
                        <span class="pick-name">{{ one.name }}</span>
                        @if (suggestedHere().has(one.id)) {
                          <span class="pick-tag" title="Suggested from this book just now">suggested</span>
                        }
                        <button
                          type="button"
                          class="tool"
                          title="Change what it says"
                          [attr.aria-label]="'Edit ' + one.name"
                          (click)="$event.stopPropagation(); startEditing(one)"
                          (keydown)="$event.stopPropagation()">✎</button>
                        <button
                          type="button"
                          class="tool drop"
                          title="Remove it from your categories"
                          [attr.aria-label]="'Remove ' + one.name"
                          (click)="$event.stopPropagation(); drop(one.id)"
                          (keydown)="$event.stopPropagation()">✕</button>
                      </span>
                      <span class="pick-said">{{ one.description }}</span>
                    </div>
                  }
                }
              </div>
            </div>
          }

          <!--
            ADDING ONE. Two fields and a button, folded away until asked for: the
            ordinary visit to this dialog lights boxes and presses Add to queue,
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
                rows="3"
                placeholder="The claim, in its first sentence: “Says wives must obey their husbands.” Then, if it helps, what counts: “An approving story counts.”"
                [attr.maxlength]="saidMax"
                [ngModel]="newSaid()"
                (ngModelChange)="newSaid.set($event)"
                name="newSaid"></textarea>
              <p class="note">
                The <strong>first sentence</strong> is what every sentence in the book is scored
                against, so make it the claim — a claim finds passages; a topic finds nothing.
                The whole description is what each passage is then checked against, which is
                where to say what counts. It is saved for every book. Nothing has calibrated
                it, so the report will mark this category as a first draft.
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

          <!--
            SUGGEST, WITH A NOTE (Owen, 2026-10-30: "if i run it on the jehovahs
            witnesses anti evolution book, i would tell it to look for any anti
            evolution pseudoscience"). The note is optional; with it, the model
            looks hardest for what it names, and some of the excerpts are the
            passages its words touch most.
          -->
          <div class="suggest-row">
            <input
              type="text"
              class="hint"
              placeholder="What do you expect in this book? Optional — e.g. anti-evolution pseudoscience"
              [attr.maxlength]="hintMax"
              [disabled]="suggestion() !== null"
              [ngModel]="hint()"
              (ngModelChange)="hint.set($event)"
              (keydown.enter)="suggest()"
              name="hint">
            <button class="ghost small" [disabled]="suggestion() !== null || !canRun() || !modelReady()" (click)="suggest()">
              Suggest from this book
            </button>
          </div>

          <!--
            THE SUGGESTION RUN, UNDER ITS BUTTON AND NOT IN A SECOND MODAL (Owen,
            2026-10-30: "a small progress bar and a stop button next to it under
            the suggest button"). The bar and the time left are estimates and
            say so; the sentence beside them is the server's own, so "#1 in its
            line" and "loading qwen3.8-27b-4bit" read as what they are. Each
            suggestion appears above as a box of its own as it arrives.
          -->
          @if (suggestion(); as run) {
            <div class="suggesting">
              <div class="bar-row">
                <div class="bar" role="progressbar" [attr.aria-valuenow]="pct(run.fraction)" aria-valuemin="0" aria-valuemax="100">
                  <div class="bar-fill" [style.width.%]="pct(run.fraction)"></div>
                </div>
                <span class="eta">{{ eta(run.etaS) }}</span>
                <button type="button" class="ghost small" (click)="stopSuggesting()">Stop</button>
              </div>
              <p class="note">{{ run.status }}</p>
            </div>
          }
          @if (suggestNote(); as said) {
            <p class="note">{{ said }}</p>
          }
          @if (suggestProblem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }


          <p class="note">
            The report is filed as a step under the one you are standing on, and nothing about the
            book changes. How strict to be is decided afterwards, in the panel — the run finds
            everything it possibly can, once, and three buttons narrow it.
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
            <button class="ghost" (click)="ui.closeAnalysis()">Cancel</button>
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
                    [disabled]="busy() || !canRun() || !modelReady()" (click)="add(false)">
              {{ busy() === 'queue' ? 'Working...' : 'Add to queue' }}
            </button>
            @if (!hosted()) {
            <button class="primary" [disabled]="busy() || !canRun() || !modelReady() || picked().size === 0" (click)="add(true)">
              {{ busy() === 'start' ? 'Starting…' : 'Start' }}
            </button>
          }
          </footer>
        }
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
    /* A fact, not a field. What a read-only input used to be. */
    .fact {
      margin: 0; font-size: 12px; color: var(--text-primary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
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
      gap: 6px;
    }
    /*
      THE LIT BOX — the export dialog's \`.kind\` card, many-of-many. The chosen
      ones wear the accent, which is this app's one word for "this is the thing":
      the same soft fill the action menu's active row uses.
    */
    .pick {
      display: flex; flex-direction: column; gap: 2px;
      padding: 7px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      text-align: left; cursor: pointer;
      font: inherit; color: inherit;
      user-select: none;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .pick:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .pick:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
    .pick.on { background: var(--accent-soft); border-color: var(--accent); }
    .pick-head { display: flex; align-items: flex-start; gap: 6px; }
    .pick-name { flex: 1; min-width: 0; font-size: 12px; font-weight: 500; color: var(--text-secondary); }
    /*
      THE FILL CARRIES THE ACCENT, NOT THE WORDS. Accent text on the accent's own
      soft fill was cyan on cyan (Owen, 2026-10-30: "the fonts inside the checked
      checkboxes is hard to see"), so a lit box writes in the ordinary text
      colours, one step brighter than an unlit one.
    */
    .pick.on .pick-name { color: var(--text-primary); font-weight: 600; }
    .pick.on .pick-said { color: var(--text-secondary); }
    .pick.on .pick-tag { color: var(--text-secondary); }
    .pick-said { font-size: 10.5px; line-height: 1.4; color: var(--text-tertiary); }
    /* A word and not a colour: an untuned category is not a WARNING, it is a fact
       about how much has been measured, and an amber pip beside several boxes
       would read as something being wrong with them. */
    .pick-tag {
      flex: 0 0 auto;
      margin-top: 2px;
      font-family: var(--font-mono);
      font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--text-tertiary);
    }

    /*
      ONE COLUMN FOR THE USER'S OWN, because each of them carries a SENTENCE and
      a sentence in a half-width cell is three lines of four words. The built-ins
      carry one short gloss each and fit two abreast; these are not the same shape.
    */
    .checklist.mine { grid-template-columns: 1fr; }
    .tool {
      flex: 0 0 auto;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px; line-height: 1;
      padding: 2px 4px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .tool:hover { background: var(--bg-active); color: var(--text-primary); }
    .tool.drop:hover { color: var(--danger, var(--warn)); }
    .pick.editing { cursor: default; gap: 6px; background: var(--bg-sunken); }
    .pick.editing:hover { border-color: var(--border-default); }
    .pick.editing textarea { resize: vertical; min-height: 44px; line-height: 1.45; }

    .suggest-row { display: flex; align-items: center; gap: 8px; }
    .suggest-row .hint { flex: 1; min-width: 0; height: 24px; font-size: 11px; }

    /* The suggestion run: a thin bar, the time left, and Stop, under the button. */
    .suggesting { display: flex; flex-direction: column; gap: 4px; }
    .bar-row { display: flex; align-items: center; gap: 8px; }
    .bar {
      flex: 1; height: 4px;
      background: var(--bg-sunken);
      border-radius: 2px; overflow: hidden;
    }
    .bar-fill { height: 100%; background: var(--accent); transition: width 900ms linear; }
    .eta { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }

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

  /*
   * NO OLLAMA SIGNAL. See the Translate dialog, where it is argued; the model
   * and the engine are both chosen above (`chosenModel`, `server`), the model on
   * Owen's ruling of 2026-10-25, which job-model.component.ts quotes. The
   * ranking row keeps its own 9B whatever is chosen. Verification is hundreds of tiny closed questions over
   * one loaded model, which is the shape a batching server gains most on; the
   * way to get one is to place the row on an engine slot, on its own row.
   */
  protected readonly problem = signal<string | null>(null);
  /** The plan hashes the whole book to key it, and materialises one. Not instant. */
  /** WHICH press is in flight, so only that button says so. */
  protected readonly busy = signal<'queue' | 'start' | null>(null);
  /** Read in the template: hosted, the host's queue holds nothing. */
  protected readonly hosted = hosted;

  /** The engine this run is pinned to. The child picks the default. */
  protected readonly server = signal('');
  /** May this act run on that engine at all — the child's verdict. */
  protected readonly canRun = signal(false);
  /** The model row chosen in the dropdown; empty is Automatic. The child preselects the last one used. */
  protected readonly chosenModel = signal('');
  /** Has the dropdown read a list and chosen from it — the child's verdict. */
  protected readonly modelReady = signal(false);
  /**
   * THE ROWS THIS CARD IS WATCHING, or null when it is a form — the ranking and
   * the check behind it. Ids rather than jobs: a job is re-pushed whole on every
   * change, and a held copy would be a snapshot going stale under a progress bar.
   * `rank` is null when a second press found the pair with its ranking done.
   */
  private readonly watching = signal<{ analysis: string; rank: string | null } | null>(null);
  /**
   * THE ROW TO DRAW NOW — the ranking while it is still to come or running, and
   * the check after it: the Clean dialog's rule, so a person sees "Scoring…" and
   * then "Checking…" rather than a check reading "waiting" for the length of a
   * ranking they asked for. NULL the moment the check leaves the list, which is
   * what makes Send to background and a finished run one code path.
   */
  protected readonly watched = computed(() => {
    const ids = this.watching();
    if (ids === null) return null;
    const jobs = this.queue.jobs();
    const rank = ids.rank === null ? undefined : jobs.find((job) => job.id === ids.rank);
    if (rank !== undefined
      && (rank.state === 'held' || rank.state === 'queued' || rank.state === 'running'
        || rank.state === 'failed' || rank.state === 'cancelled')) {
      // A ranking that FAILED is drawn too: the check behind it was taken with
      // it, and the reason is on this row.
      return rank;
    }
    return jobs.find((job) => job.id === ids.analysis) ?? null;
  });

  /**
   * LET GO OF THE RUN, KEEP THE RUN. Nothing moves and nothing is handed over —
   * the row has been in the queue since the press, so this card simply stops
   * watching and closes.
   */
  protected background(): void {
    this.watching.set(null);
    this.ui.summonQueue(true);
    this.ui.closeAnalysis();
  }

  /** Stop the run and go back to being a form, with the values still in it. */
  protected async cancelRun(id: string): Promise<void> {
    await this.queue.cancel(id);
    this.watching.set(null);
  }


  constructor() {
    // The Translate dialog's rule: a complaint about the last book is cleared when
    // the book changes, and nothing else resets. The checklist in particular is
    // the user's careful answer and survives switching tabs.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
    void this.loadMine();
    /*
     * THE SUGGESTION FRAMES, for as long as this card exists. Closing the card
     * stops a run that is still going — the model is released, and every
     * suggestion that already arrived stays saved.
     */
    if (api) {
      const off = api.analysis.onSuggestProgress((frame) => this.onSuggestFrame(frame));
      inject(DestroyRef).onDestroy(() => {
        off();
        void this.stopSuggesting();
      });
    }
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
    const refused = await this.keep(this.newName(), this.newSaid());
    if (refused === null) this.stopAdding();
    else this.addProblem.set(refused);
  }

  /**
   * THE ADD FORM'S SAVE: null when it was kept (and lit), else the sentence
   * saying why not.
   */
  private async keep(rawName: string, rawSaid: string): Promise<string | null> {
    if (!api) return 'There is no app behind this window to save into.';
    const name = rawName.replace(/\s+/g, ' ').trim();
    const description = rawSaid.replace(/\s+/g, ' ').trim();
    if (name.length === 0) return 'Give it a name — that is what the checklist and the legend will say.';
    if (description.length === 0) {
      return 'Write the sentence. It is the whole of what gets measured: without it there is nothing '
        + 'to score a sentence of the book against.';
    }
    const id = customCategoryId(name);
    if (id.length === 0) return 'That name is all punctuation, so there is nothing to file it under.';
    if (ANALYSIS_CATEGORY_IDS.includes(id)) {
      return `Foundry already looks for something it calls “${name}”, with a line that was `
        + 'measured. It is on the list above.';
    }
    if (this.mine().some((one) => one.id === id)) return `You already have a category called “${name}”.`;
    this.saving.set(true);
    this.addProblem.set(null);
    try {
      const held = await api.analysis.writeCategories([...this.mine(), { id, name, description }]);
      this.mine.set(held);
      this.picked.update((was) => new Set([...was, id]));
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      this.saving.set(false);
    }
  }

  // ── Suggested from this book ─────────────────────────────────────────────

  /**
   * THE RUN IN FLIGHT, as its last frame, or null when there is none. Set to a
   * starting frame at the press, so the bar is there before main answers.
   */
  protected readonly suggestion = signal<SuggestProgress | null>(null);
  /** The reader's note for the model — what they expect in this book. Kept across runs while the card is open. */
  protected readonly hint = signal('');
  protected readonly hintMax = SUGGEST_HINT_MAX;
  /** The ids suggested while this card has been open, for their "suggested" tag. */
  protected readonly suggestedHere = signal<ReadonlySet<string>>(new Set());
  /** What the last run ended with — its count and the theme it read. */
  protected readonly suggestNote = signal<string | null>(null);
  protected readonly suggestProblem = signal<string | null>(null);
  /** The run's id, once main or its first frame has said it. */
  private suggestRunId: string | null = null;

  /**
   * ASK FOR SUGGESTIONS, on the server and model the dropdowns name — the same
   * pair the run would use, so a person who picked this PC's 27B for the
   * analysis gets suggestions from it too. What arrives is saved by main as it
   * arrives; this card only draws the frames (`onSuggestFrame`).
   */
  protected async suggest(): Promise<void> {
    const input = this.source();
    if (input === null || !api || this.suggestion() !== null) return;
    this.suggestProblem.set(null);
    this.suggestNote.set(null);
    this.suggestRunId = null;
    this.suggestion.set({
      runId: '', state: 'running', phase: 'loading', status: 'Starting…',
      fraction: 0, etaS: null, theme: null, added: [], mine: null,
    });
    try {
      const id = await api.analysis.suggestStart({
        inputPath: input,
        title: this.name(),
        server: this.server(),
        model: this.chosenModel(),
        hint: this.hint(),
      });
      this.suggestRunId ??= id;
    } catch (err) {
      this.suggestion.set(null);
      this.suggestProblem.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async stopSuggesting(): Promise<void> {
    if (!api || this.suggestRunId === null) return;
    await api.analysis.suggestCancel(this.suggestRunId);
  }

  /**
   * ONE FRAME. Main runs one suggestion at a time, so a frame that arrives
   * before `suggestStart` has answered is this card's run and names its id.
   * The stored list is taken whole, as any write's answer is, and what this
   * run added is lit.
   */
  private onSuggestFrame(frame: SuggestProgress): void {
    if (this.suggestion() === null) return;
    if (this.suggestRunId === null) this.suggestRunId = frame.runId;
    else if (frame.runId !== this.suggestRunId) return;
    if (frame.mine !== null) this.mine.set(frame.mine);
    const fresh = frame.added.filter((id) => !this.suggestedHere().has(id));
    if (fresh.length > 0) {
      this.suggestedHere.update((was) => new Set([...was, ...fresh]));
      this.picked.update((was) => new Set([...was, ...fresh]));
    }
    if (frame.state === 'running') {
      this.suggestion.set(frame);
      return;
    }
    this.suggestion.set(null);
    this.suggestRunId = null;
    if (frame.state === 'failed') {
      this.suggestProblem.set(frame.message ?? 'The suggestions failed.');
      return;
    }
    const said = frame.state === 'cancelled' ? (frame.message ?? 'Stopped.') : frame.status;
    this.suggestNote.set(frame.theme !== null && frame.theme.length > 0 ? `${said} It read this book as: ${frame.theme}` : said);
  }

  /** The bar's width, in whole percent. */
  protected pct(fraction: number): number {
    return Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  }

  /** The time left, said as the estimate it is. */
  protected eta(seconds: number | null): string {
    if (seconds === null) return '';
    if (seconds < 60) return `about ${Math.max(1, seconds)} s left`;
    return `about ${Math.round(seconds / 60)} min left`;
  }

  // ── Changing one of yours (the pencil) ───────────────────────────────────

  protected readonly editing = signal<string | null>(null);
  protected readonly editName = signal('');
  protected readonly editSaid = signal('');
  protected readonly editProblem = signal<string | null>(null);

  protected startEditing(one: CustomAnalysisCategory): void {
    this.editing.set(one.id);
    this.editName.set(one.name);
    this.editSaid.set(one.description);
    this.editProblem.set(null);
  }

  protected stopEditing(): void {
    this.editing.set(null);
    this.editProblem.set(null);
  }

  /**
   * SAVE AN EDIT IN PLACE. The id is the name's slug (`customCategoryId`), so a
   * renamed category is a new id where it stands in the list, and whether it is
   * lit — and whether it was suggested here — moves with it.
   */
  protected async saveEdit(oldId: string): Promise<void> {
    if (!api) return;
    const name = this.editName().replace(/\s+/g, ' ').trim();
    const description = this.editSaid().replace(/\s+/g, ' ').trim();
    const id = customCategoryId(name);
    let refused: string | null = null;
    if (name.length === 0) refused = 'Give it a name — that is what the list and the legend will say.';
    else if (description.length === 0) refused = 'Write the sentence. It is the whole of what gets measured.';
    else if (id.length === 0) refused = 'That name is all punctuation, so there is nothing to file it under.';
    else if (ANALYSIS_CATEGORY_IDS.includes(id)) refused = `Foundry already looks for something it calls “${name}”.`;
    else if (this.mine().some((one) => one.id === id && one.id !== oldId)) refused = `You already have a category called “${name}”.`;
    if (refused !== null) {
      this.editProblem.set(refused);
      return;
    }
    this.saving.set(true);
    try {
      const held = await api.analysis.writeCategories(
        this.mine().map((one) => (one.id === oldId ? { id, name, description } : one)),
      );
      this.mine.set(held);
      if (id !== oldId) {
        const move = (was: ReadonlySet<string>): Set<string> => {
          const next = new Set(was);
          if (next.delete(oldId)) next.add(id);
          return next;
        };
        this.picked.update(move);
        this.suggestedHere.update(move);
      }
      this.stopEditing();
    } catch (err) {
      this.editProblem.set(err instanceof Error ? err.message : String(err));
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

  /**
   * ONE COMPOSE, TWO ENDINGS — `release` is the whole difference between the two
   * buttons, and it is an argument rather than a second method because
   * everything above the last few lines is identical.
   */
  protected async add(release: boolean): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;
    const ticked = this.picked();
    if (ticked.size === 0) return;

    this.busy.set(release ? 'start' : 'queue');
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
         * line for a name it has never heard of, so `buildPlan` refuses outright a
         * category given no description. A built-in never carries one — its line
         * is the measured one, and a description beside it would be a second
         * opinion about a calibrated question.
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
        /*
         * ── THE MODEL AND THE ENDPOINT ARE DECLARED CONSTANTS NOW ───────────
         *
         * Owen, 2026-09-15: *"we dont have any local models. crucible handles
         * all model orchestration."* The PLACEMENT names the model a request
         * runs — the one chosen in this dialog's dropdown (`chosenModel`, Owen
         * 2026-10-25), else the biggest that fits up to 27B — and applies it
         * at the spawn, over the top of these two (`doorArgs`,
         * electron/job-queue.ts). So these two are never the choice.
         *
         * THE REQUEST FIELDS ARE NOT GONE, because one caller still reads them:
         * a DRY RUN has no server to ask, so `argsFor` defaults to `UNPLACED`
         * and prints the request's own pair (BookForge's `cli/clean-step.js`).
         * The declared defaults are the honest thing for that line to carry.
         */
        model: DEFAULT_MODEL,
        ollama: DEFAULT_OLLAMA,
        // Main's answer travelling back to main: the step the report is named
        // after, minted at the plan so the file and the row agree hours later.
        /*
         * THE ROW THIS PASS IS MADE FROM, as main resolved it at the press. It
         * is what the run materialises its book out of when it starts, and it
         * travels as an ID because a path under `derived/` is swept at every
         * settle — see `TranslateRequest.at`. Never read here.
         */
        at: plan.at ?? null,
        stepId: plan.stepId,
      };

      /*
       * A REFUSAL IS NOT A SUCCESS, the Translate dialog's own hard-won line: main
       * dedupes on the report path and answers with the row that already exists,
       * so a second press would otherwise announce an analysis it had not queued
       * and close over the evidence.
       */
      /*
       * PINNED TO THE ENGINE THE CARD NAMED, and pinned AFTER the enqueue rather
       * than carried on the request: `waitFor` is a property of the ROW — a
       * person can re-route a parked row from the shelf — so the queue's own
       * door owns it. A blank server means nothing was chosen and the row keeps
       * the default it was admitted with.
       */
      const { outcome, id, rankId } = await this.queue.enqueueAnalysisNamed(withChosenModel(request, this.chosenModel()));
      /*
       * BOTH ROWS GO WHERE THE CARD SAID — the ranking on that server's decide
       * model and the check on its analysis model — as the Clean dialog pins its
       * triage and its cleanup together.
       */
      if (id !== null && this.server().length > 0) {
        if (rankId !== null) await this.queue.setWaitFor(rankId, this.server());
        await this.queue.setWaitFor(id, this.server());
      }
      // THE NEXT ONE OPENS ON THIS ONE'S MODEL (Owen: "use the last used model
      // as the default") — only once a row was really added. Automatic too.
      if (id !== null && outcome !== 'already') await api.crucible.rememberJobModel('analysis', this.chosenModel());
      if (outcome === 'already') {
        /*
         * A DUPLICATE IS STILL A RUN SOMEBODY CAN WATCH. Main answers with the
         * EXISTING row, and if that is the work just asked for then Start's
         * honest behaviour is to show it working. Add to queue keeps the
         * sentence, because there the news IS that the shelf did not grow.
         */
        if (release && id !== null) {
          await this.releasePair(id, rankId);
          this.watching.set({ analysis: id, rank: rankId });
          return;
        }
        this.problem.set(
          'This analysis is already queued for this book — nothing was added. It is in the queue.',
        );
        return;
      }

      /*
       * START COMMITS TO THIS ROW AND NOTHING ELSE — `queue:release`, not
       * `queue:start`, which lets go of every row somebody parked deliberately.
       */
      if (release && id !== null) {
        await this.releasePair(id, rankId);
        this.watching.set({ analysis: id, rank: rankId });
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
      this.busy.set(null);
    }
  }

  /** Start commits to the pair and nothing else — the ranking, then the check behind it. */
  private async releasePair(analysis: string, rank: string | null): Promise<void> {
    if (rank !== null) await this.queue.release(rank);
    await this.queue.release(analysis);
  }
}
