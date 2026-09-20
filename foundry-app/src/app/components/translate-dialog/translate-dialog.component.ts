import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { LANGUAGE_CHOICES, languageNameFor, tagForLanguageName } from '@shared/languages';
import { languageTagFor, translationInEffect } from '@shared/ledger';
import { fold } from '@shared/original';
import { canTranslateFrom } from '@shared/stages';
import {
  DEFAULT_OLLAMA_ENDPOINT as DEFAULT_OLLAMA,
  DEFAULT_TRANSLATE_MODEL as DEFAULT_MODEL,
} from '@shared/pipeline';
import type { TranslateRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { RunProgressComponent } from '../run-progress/run-progress.component';
import { RunTargetComponent } from '../run-target/run-target.component';
import { api, hosted } from '../../core/foundry';

/*
 * THE TWO DEFAULTS LIVE IN `shared/` AND ARE IMPORTED UNDER THEIR SHORT NAMES.
 *
 * They were constants in this file, where they are the values the two fields open
 * on, and they moved out when a Generate standing on a translation could run the
 * translator with no form in front of it. That path is gone — a translated book is
 * cast from records now, and this dialog is once again the only door to a
 * translation — and the constants stay in `shared/` deliberately: they are the
 * engine's own defaults, they are what a person is shown before they change them,
 * and a copy of a model id in a component is how a bump ends up applying to one of
 * two places.
 *
 * Aliased on the way in because the long names are what a shared module owes its
 * readers and the short ones are what a dozen lines below already say.
 */

/**
 * Translate — configure ONE translation and put it in the queue.
 *
 * The same shape as the OCR dialog and for the same reasons: it enqueues and
 * nothing else, the run belongs to main, and dismissing this does not touch a
 * job that is already moving. What it asks for is different, though, and the
 * differences are the interesting part.
 *
 *   **The source is the BOOK, not the scan.** A translation replaces the text
 *   inside the categories foundry stamped when it built the book, so the input
 *   is a book this app already made. Pointed at the scan, the engine would have
 *   nothing to work on — so the dialog says where to stand rather than offering
 *   to translate photographs of pages.
 *
 *   **There is no model field and no endpoint field**, and there were both. They
 *   described where the work ran, and it runs on a connected GPU engine, which
 *   names its own model per class (Owen, 2026-09-15: *"crucible handles all model
 *   orchestration"*). A control that cannot change the run is a control that
 *   lies to whoever uses it.
 *
 *   **Translator instructions are free text and they matter.** Terminology is
 *   per-book — which words stay in the source language, whether loaded
 *   vocabulary in a historical document is rendered literally — and no default
 *   can be right about it. The text is appended to the engine's system prompt
 *   verbatim.
 */
@Component({
  selector: 'app-translate-dialog',
  imports: [FormsModule, RunProgressComponent, RunTargetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeTranslate()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Translate this book">
      <header class="head">
        <span class="title">Translate</span>
        <button class="x" (click)="ui.closeTranslate()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
        <!--
          THE RUN REPLACES THE FORM. Leaving the fields up while the job moves
          would offer edits that change nothing — the request was composed and
          handed over at the press.
        -->
        @if (watched(); as job) {
          <app-run-progress [job]="job" verb="Translating" />
        } @else {
          <!-- WHERE IT WILL RUN, AND WHAT WILL RUN IT. The child draws the one
               real choice and states the rest — run-target.component.ts carries
               the ruling about why the model is not a button. -->
          <app-run-target act="translate" [(server)]="server" (ready)="canRun.set($event)" />
          <!--
            THE BOOK'S NAME, WHICH IS WHAT THE FIELD IS CALLED. It held the whole
            path — a workspace directory, a project key with eight hex characters
            in it and a stem built out of hyphens — in a box too narrow to read
            half of, above a form asking which language to put the book into. The
            book's own \`dc:title\` is what the tab, the pane and the window are
            already calling it; the path is on the tooltip for the one person who
            wants it.
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
            THE SOURCE IS A FACT WHERE THE POSITION IS A TRANSLATION, and a
            question everywhere else. Standing on the English translation and
            asking for Hungarian is the user's own chain — *"it translates from
            english to hungarian, thus creating a chain of translations"* — and
            what that run reads is the English row's own answers, whose language
            that row recorded. Offering a From box there would invite somebody to
            disagree with the ledger, and the way that disagreement presents is a
            prompt told it is holding German while it holds English.
          -->
          <div class="pair">
            <label class="field">
              <span class="label">Into</span>
              <select [ngModel]="toChoice()" (ngModelChange)="toChoice.set($event)" name="to">
                @for (choice of languages; track choice.tag) {
                  <option [value]="choice.tag">{{ choice.name }}</option>
                }
                <option value="other">Another language…</option>
              </select>
            </label>
            @if (sourceLanguage(); as standing) {
              <label class="field">
                <span class="label">From <em>the translation you are on</em></span>
                <input type="text" [value]="nameOf(standing)" readonly [title]="standing">
              </label>
            } @else {
              <label class="field">
                <span class="label">From</span>
                <select [ngModel]="fromChoice()" (ngModelChange)="fromChoice.set($event)" name="from">
                  <option value="">Detect from the text</option>
                  @for (choice of languages; track choice.tag) {
                    <option [value]="choice.tag">{{ choice.name }}</option>
                  }
                  <option value="other">Another language…</option>
                </select>
              </label>
            }
          </div>
          @if (toChoice() === 'other') {
            <label class="field">
              <span class="label">Which language <em>to translate into</em></span>
              <input
                type="text"
                placeholder="Swahili"
                maxlength="60"
                [ngModel]="toTyped()"
                (ngModelChange)="toTyped.set($event)"
                name="toTyped">
            </label>
            @if (toTyped().trim().length > 0 && to().length === 0) {
              <p class="problem">
                Foundry doesn't recognise a language called
                “{{ toTyped().trim() }}” — check the spelling, in English.
              </p>
            }
          }
          @if (sourceLanguage() === null && fromChoice() === 'other') {
            <label class="field">
              <span class="label">Which language <em>the book is in</em></span>
              <input
                type="text"
                placeholder="Swahili"
                maxlength="60"
                [ngModel]="fromTyped()"
                (ngModelChange)="fromTyped.set($event)"
                name="fromTyped">
            </label>
            @if (fromTyped().trim().length > 0 && from().length === 0) {
              <p class="problem">
                Foundry doesn't recognise a language called
                “{{ fromTyped().trim() }}” — check the spelling, in English.
              </p>
            }
          }
          @if (sourceLanguage(); as standing) {
            <p class="note">
              This one is translated from the {{ nameOf(standing) }} translation you are
              standing on, paragraph by paragraph, so the words it starts from are the ones that
              row holds rather than the book's own.
            </p>
          }

          <label class="field">
            <span class="label">Translator instructions <em>optional</em></span>
            <textarea
              rows="4"
              placeholder="Leave 'völkisch' untranslated. Render racial terminology literally; do not soften it."
              [ngModel]="instructions()"
              (ngModelChange)="instructions.set($event)"
              name="instructions"></textarea>
          </label>
          <p class="note">
            Appended to the model's instructions word for word. Use it to pin the terms this
            particular book turns on.
          </p>

          <p class="note">
            The translation is written as a NEW book in Foundry's workspace, next to the original,
            and opens here when it is done. The book you are translating is never written to.
            A paragraph the model cannot translate to standard is refused by name and the whole
            job fails — nothing half-translated is ever written.
          </p>

          <!--
            A LANGUAGE INTO ITSELF IS NOT A TRANSLATION, and this says so before
            the button rather than after it. Standing on the English translation
            and asking for English again would ask a model to render every
            paragraph of an English book in English — hours of it — and file the
            result as a second row that means nothing. Redoing a translation is a
            different gesture: stand on the step it was made FROM and ask for that
            language again, which replaces the row you already have.
          -->
          @if (sameLanguage()) {
            <p class="problem">
              You are standing on the {{ sourceLanguage() }} translation, so translating it into
              {{ sourceLanguage() }} would be asking the model to say the same thing again. To redo
              this one, stand on the step it was made from and translate to
              {{ sourceLanguage() }} there.
            </p>
          }

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
            <button class="ghost" (click)="ui.closeTranslate()">Cancel</button>
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
            <button class="primary" [disabled]="busy() || !canRun() || to().length === 0 || fromUnresolved() || sameLanguage()" (click)="add(true)">
              {{ busy() === 'start' ? 'Starting…' : 'Start' }}
            </button>
          }
          </footer>
        }
      } @else {
        <!--
          THE EMPTY STATE NAMES THE TWO WAYS TO GET HERE — no book made yet, or
          deliberately standing back on the import — because they want different
          things from the person reading it and one vague sentence would serve
          neither.
        -->
        <div class="body empty">
          <p>
            There is no book here to translate. Translation replaces the text inside the
            categories Foundry stamps when it builds a book, so the pages have to be read
            first — and standing on the import row is standing before the book: step onto
            the reading or an edit to translate what is there.
          </p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeTranslate()">Close</button>
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
    /* Two tags on one row: they are one decision and each needs four characters. */
    .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; font-weight: 400; opacity: 0.75; }

    textarea { resize: vertical; min-height: 64px; font-family: inherit; }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .note code { font-family: var(--font-mono); font-size: 10px; color: var(--text-secondary); }
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
export class TranslateDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  /**
   * The book this translation is OF — a PROJECT WITH A BOOK IN IT, named by its
   * original document.
   *
   * ── The test used to be "the position shows an .epub", and that went stale ──
   *
   * When every book was a cast EPUB in a pane, "the position's document ends in
   * .epub" and "there is a book here" were one fact. The renderer pivot separated
   * them: a read or edit position is drawn natively on the proof sheet and shows
   * NO document at all (`documentAtPosition` answers null, docs/RENDERER.md §7) —
   * so the old test went dark exactly where the book is, and the user found it:
   * standing on their applied edits, Translate was gray.
   *
   * SO THIS IS THE EXPORT DIALOG'S SHAPE, deliberately, because the two buttons
   * answer the same question. The tab names the PROJECT — the one fact it is
   * authoritative about (docs/WORKBENCH.md §6c) — and whether there is a book to
   * translate is the ledger's answer: a reading has landed, or the book arrived
   * as one. What the plan is handed is the project's ORIGINAL, which is the
   * question main answers anyway (`planTranslation` resolves the project from any
   * path inside it and materialises the POSITION's book for itself, every op on
   * the way replayed in — so the strikes made a minute ago are in the file the
   * model reads).
   *
   * STANDING ON THE IMPORT IS STILL THE EMPTY STATE, for `canExport`'s reason:
   * the user has deliberately stepped back to the untouched scan, and a live
   * button there would translate the book they just stepped away from. Except
   * when the import IS the book — a project that arrived as an EPUB has exactly
   * one row to stand on, and refusing there would refuse the only position such
   * a project ever occupies.
   *
   * A LOOSE FILE STAYS UNTRANSLATABLE: what this app translates is a position,
   * and a file with no ledger behind it has none.
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
    if (!canTranslateFrom(project, this.ledger.standingIn(project.dir))) return null;
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

  /**
   * What that book is CALLED, which is a different question from where it is.
   *
   * A TAB SHOWING THE ORIGINAL WINS, because the tab is where this app decides
   * what a document is named (`Tab.title`) and a dialog that named it a second
   * way would be a second opinion about the book on screen behind it. But the
   * source is the archived original now, which mostly has no tab of its own —
   * the panes show the live copy or the proof sheet — so the ordinary answer is
   * `nameFor`: the project's own title, the same name every other surface calls
   * it.
   */
  protected readonly name = computed(() => {
    const input = this.source();
    if (input === null) return '';
    const at = fold(input);
    const showing = this.documents.tabs().find((tab) => fold(tab.path) === at);
    return showing?.title ?? this.projects.nameFor(input);
  });

  /**
   * THE LANGUAGE THIS ONE WOULD BE MADE OUT OF, when the position stands on a
   * translation — or null for a translation of the book's own words.
   *
   * ── Why the dialog knows this at all ────────────────────────────────────────
   *
   * Because it changes what the form ASKS. A translation made from a standing
   * translation is a chain (docs/WORKBENCH.md §10, ruling 3): the run reads that
   * row's own answers, so its source language is a fact the ledger recorded rather
   * than a box for somebody to fill in — and translating a language into itself is
   * a run that spends hours to say the same thing.
   *
   * `translationInEffect` IS THE WALK THE PLAN MAKES, asked of the same mirror the
   * inspector paints its rows from. It answers the nearest translate step above
   * the position, so it is right for a save made under one as well as for the
   * translation itself, and it answers null everywhere else — which is every
   * project that has never been translated.
   *
   * THIS WINDOW DOES NOT DECIDE ANYTHING WITH IT. Main composes the chain from its
   * own ledger (`planTranslation`, electron/workspace.ts) and hands the answer
   * back; what this is for is the sentence on screen and the button that goes
   * quiet, because a refusal a person meets before they press is worth more than
   * the same refusal afterwards.
   */
  protected readonly sourceLanguage = computed(() => {
    const project = this.projects.projectFor(this.stage.activeDocument()?.path ?? '');
    /*
     * ASKED OF THE LEDGER WITH THE PROMISES IN IT, so the walk goes THROUGH a
     * cleanup that has not landed to the translation above it — which is the same
     * answer main will compose when it re-plans, and the point of composing the
     * ledger in one place on each side (`LedgerService.ledgerIn`).
     */
    const ledger = this.ledger.ledgerIn(project?.dir ?? null);
    const standing = this.ledger.standingIn(project?.dir ?? null);
    const said = ledger === null ? undefined : translationInEffect(ledger, standing)?.params?.language;
    return said !== undefined && said.trim().length > 0 ? said.trim() : null;
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
    const project = this.projects.projectFor(this.stage.activeDocument()?.path ?? '');
    return project === null ? undefined : this.ledger.aimedAt(project.dir);
  });

  /*
   * THE LANGUAGE IS CHOSEN BY NAME AND TRAVELS AS A TAG. The dropdowns list the
   * engine's own languages by their names (shared/languages.ts, the engine
   * table's mirror — the two grow together), and "Another language…" opens a
   * box that takes a NAME, resolved against the ISO registry the runtime ships
   * (`tagForLanguageName`). What leaves this dialog is only ever the resolved
   * tag: a name nobody can resolve leaves `to()` empty, which keeps the button
   * dark and says so in a sentence — so text a person typed never reaches a
   * prompt, a filename or a package, which is the whole of the injection
   * surface a free-text language box could have had.
   */
  protected readonly languages = LANGUAGE_CHOICES;
  protected readonly nameOf = languageNameFor;
  protected readonly toChoice = signal('en');
  protected readonly toTyped = signal('');
  protected readonly fromChoice = signal('');
  protected readonly fromTyped = signal('');
  protected readonly to = computed(() => (this.toChoice() === 'other'
    ? tagForLanguageName(this.toTyped()) ?? ''
    : this.toChoice()));
  protected readonly from = computed(() => (this.fromChoice() === 'other'
    ? tagForLanguageName(this.fromTyped()) ?? ''
    : this.fromChoice()));
  /**
   * A typed FROM that resolves to nothing must hold the button: letting it
   * through would silently fall back to detection while the card is showing a
   * sentence about not recognising the language — the button and the sentence
   * would be describing two different runs.
   */
  protected readonly fromUnresolved = computed(() => this.sourceLanguage() === null
    && this.fromChoice() === 'other'
    && this.fromTyped().trim().length > 0
    && this.from().length === 0);

  /**
   * Whether the target IS the standing translation's own language.
   *
   * FOLDED THE WAY THE FILENAMES ARE, so `EN` and `en` are one language here as
   * they are everywhere else in this app: `languageTagFor` is the single spelling
   * of that reduction (shared/ledger.ts), and lowercasing after it is what stops a
   * capital letter turning "the same language" into a chain nobody asked for.
   * Main folds the same pair the same way when it decides whether this run is a
   * chain, so the two sides cannot disagree about what the button did.
   */
  protected readonly sameLanguage = computed(() => {
    const standing = this.sourceLanguage();
    const wanted = this.to().trim();
    if (standing === null || wanted.length === 0) return false;
    return languageTagFor(standing).toLowerCase() === languageTagFor(wanted).toLowerCase();
  });
  /*
   * ── NO MODEL SIGNAL, NO OLLAMA SIGNAL, AND NO `server` ONE EITHER ────────
   *
   * All three were fields on this window at one time or another, and all three
   * described where the work ran. It runs on a connected GPU engine now, which
   * chooses its own model (Owen, 2026-09-15: *"crucible handles all model
   * orchestration"*), and WHERE is picked on the job's own queue row — a
   * per-book choice this dialog deliberately does not make, for the same reason
   * it no longer makes the other one.
   */
  protected readonly instructions = signal('');
  protected readonly problem = signal<string | null>(null);
  /** The workspace plan hashes the whole book to key it. Not instant. */
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
    this.ui.closeTranslate();
  }

  /** Stop the run and go back to being a form, with the values still in it. */
  protected async cancelRun(id: string): Promise<void> {
    await this.queue.cancel(id);
    this.watching.set(null);
  }


  constructor() {
    // Same rule as the OCR dialog: a complaint about the last book is cleared
    // when the book changes, and nothing else resets. The instructions in
    // particular are the user's careful answer and survive switching tabs.
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
      const to = this.to().trim();
      // Main names the output — the language is part of the name, so it has to
      // travel with the plan rather than only with the command line — and it
      // names the INPUT too. A book edited since it was cast lives in its
      // working tree, which is not a file any engine can read, so main exports
      // it and the job reads the export. Using `input` here instead would
      // translate the version from before every cut the user just made.
      const plan = await api.workspace.planTranslation(input, to, this.aim());
      const request: TranslateRequest = {
        kind: 'translate',
        inputPath: plan.inputPath,
        /*
         * THE BOOK THE RUN READS, composed by main and carried back untouched.
         * It is the position's own book file with every change on the way to it
         * already replayed in, written into the OS temp directory when the plan
         * was made — which is why a book somebody has been editing can be
         * translated at all, and why this window has no opinion about it.
         */
        // ABSENT FOR A DEFERRED PLAN — the queue materialises it at spawn.
        to,
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
        /*
         * WHERE THE ANSWERS GO, AND THE WHOLE OF WHAT THIS RUN MAKES. Every
         * accepted block lands there the moment it is accepted, so a run that is
         * interrupted asks only for what it still owes — and there is no second
         * file, because the records ARE the cache. Never a choice in this dialog:
         * see the note on `argsFor`.
         */
        recordsPath: plan.recordsPath,
        /*
         * AND THE CHAIN, WHICH IS NO LONGER A FILE THIS WINDOW CARRIES. The book
         * above is the parent translation's own derived book when the position
         * stands under one, so the words the model is asked about are already that
         * row's. What is left of the chain here is the language they are in
         * (`sourceLanguage` below), which is a fact about somebody's history and
         * is still decided where the history lives.
         */
        // THE ADMISSION THAT THIS IS MADE FROM SOMETHING THAT HAS NOT HAPPENED,
        // carried verbatim — the queue reads it, nothing here interprets it.
        ...(plan.deferred !== undefined ? { deferred: plan.deferred } : {}),
        // The step the file is named after, minted by the plan and carried to the
        // landing so the row and the file agree about which translation this is.
        // Never read here — this dialog does not know what a step is, and it is
        // main's answer travelling back to main.
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
       * THE SOURCE LANGUAGE IS MAIN'S WHERE MAIN HAS ONE. Translating a standing
       * translation asks its questions of that row's own answers, and what language
       * those are in is recorded on the row — so the field is not offered there and
       * the plan's answer wins. Everywhere else it is what the person typed, and
       * blank still means "work it out from the text".
       */
      const from = plan.from ?? this.from().trim();
      if (from.length > 0) request.from = from;
      const instructions = this.instructions().trim();
      if (instructions.length > 0) request.instructions = instructions;

      /*
       * A REFUSAL IS NOT A SUCCESS, and this dialog used not to know the
       * difference: main dedupes on the output path and answers with the row
       * that already exists, so a second press announced a translation it had
       * not queued and closed over the evidence. It stays put and says so, in
       * the form this card already uses for a problem — the same shape the OCR
       * dialog has always had.
       */
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
          `${to} is already queued for this book — nothing was added. It is in the queue.`,
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
      /*
       * The queue panel, opened — and it matters more than it used to. The job is
       * HELD (electron/job-queue.ts), so nothing happens until Start is pressed,
       * and that button is inside it. Closing this dialog onto a shut
       * panel would leave a translation configured, idle, and out of
       * sight.
       *
       * This one still closes on add, unlike the OCR dialog: a translation is
       * about the book already open in front of you, so there is no second one
       * to queue without going and opening it.
       */
      this.ui.summonQueue(false); // hosted: no queue surface to open, and the call is deliberately nothing
      this.ui.confirmQueued('Translation queued — it lands in the tree when it finishes.');
      this.ui.closeTranslate();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }
}
