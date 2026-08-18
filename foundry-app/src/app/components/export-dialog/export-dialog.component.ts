import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { qualify } from '@shared/documents';
import { translationInEffect } from '@shared/ledger';
import type { ConversionKind, JobRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * Export — the finished book, in the form you want to keep it in.
 *
 * ── It was called Generate, and the rename is the ruling ────────────────────
 *
 * A generate wrote a document into the project's working directories, where it
 * sat among the steps looking like one. It is not one: nothing is ever built on
 * top of it, no later step takes it as a parent, and the moment somebody
 * corrects a block upstream it is a stale copy of a book that has moved on. The
 * user said what it actually is — "it wont go into the working files as a step
 * because it isnt the base for new steps. its a terminal step. so its an export"
 * — and an export lands in the project's own filed folder, is listed under the
 * project rather than in the ledger, and opens as a tab you can close.
 *
 * The planning machinery is the SAME machinery (planConversion, the pipeline,
 * generate-under-a-translation, every refusal); only where the file lands
 * changed, which is why this is the old dialog reworked rather than a new one.
 *
 * ── Why this is a dialog of its own and not a field on the OCR one ──────────
 *
 * Because it is a different act with a different cost. Reading a book is hours
 * of GPU against pages nobody has seen: it is held, batched, and committed to
 * with a Start button. Exporting is arithmetic over answers that are already on
 * the disk — offline, no model, no server, seconds — and it is repeatable. The
 * two used to be one dialog and one job, which made the FORMAT a decision
 * somebody had to make before a single page was read, and made "could I have
 * that as text as well?" cost another three hours.
 *
 * So the reading is paid for once and this is free, as many times as you like,
 * in as many formats as you like.
 *
 * ── It runs immediately, and it opens what it made ──────────────────────────
 *
 * NO START GATE. The queue's hold exists so that hours of GPU are never spent by
 * the act of configuring them; there are no hours here to spend, and a person who
 * pressed Export and then had to find a shelf and press Start would be pressing
 * a second button to confirm a decision they made with the first. It still goes
 * through the queue — one engine at a time is a rule about the machine, not about
 * the person — so it waits behind a reading that is running, and the shelf shows
 * it moving.
 *
 * AND THE RESULT OPENS ITSELF, which is the point: somebody exports an EPUB
 * precisely because they want to look at it. That is OPENS_ITSELF in
 * OpenDocumentsService.
 *
 * ── No reading yet ──────────────────────────────────────────────────────────
 *
 * TWO OPTIONS AND NOT THREE. There is no route in this engine from a scan to a
 * book that does not go through the model — the whole pipeline is built on the
 * bank of what it read — so "export without OCR" is not a thing this dialog can
 * offer to do. It says the pages have not been read and offers to read them.
 */
@Component({
  /*
   * ONE SELECTOR AGAIN. There were two for one wave: the shell mounted this
   * dialog by its old tag while `app.ts` still belonged to another unit, and an
   * app that answered only to the new name would have been an app with no export
   * dialog at all until that file was opened. It has been opened, the shell
   * writes \`<app-export-dialog />\`, and the second name went with the re-export
   * that stood beside the old path. A compatibility name that outlives its reason
   * is how a codebase ends up with two words for one thing and nobody sure which
   * one is real.
   */
  selector: 'app-export-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeExport()"></div>

    <div class="card" role="dialog" aria-modal="true" aria-label="Export this book">
      <header class="head">
        <span class="title">Export</span>
        <button class="x" (click)="ui.closeExport()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
          <label class="field">
            <span class="label">The book</span>
            <input type="text" [value]="optionFor(input)" readonly [title]="input">
          </label>

          @if (canMake()) {
            <!--
              THE THREE FORMATS AS CARDS rather than a select, because this is the
              whole question the dialog asks and a drop-down would hide two thirds
              of the answer behind a click. Each one says what it IS.
            -->
            <div class="kinds" role="radiogroup" aria-label="What to make">
              @for (choice of choices; track choice.kind) {
                <button
                  class="kind"
                  role="radio"
                  [attr.aria-checked]="kind() === choice.kind"
                  [class.on]="kind() === choice.kind"
                  [disabled]="noFacsimile() && choice.kind === 'pdf'"
                  (click)="kind.set(choice.kind)"
                >
                  <span class="kind-name">{{ choice.label }}</span>
                  <span class="kind-note">{{ choice.blurb }}</span>
                </button>
              }
            </div>

            @if (noFacsimile()) {
              <!--
                THE BOUND, SAID RATHER THAN JUST APPLIED. A dead card with no
                sentence beside it is an app that has decided something and will
                not say what. Main refuses the same pair for the same reason
                (planExport), and the engine refuses it again underneath — this is
                the courtesy, not the rule.

                IT USED TO SAY "the EPUB only", and it was true of a translated
                export while that job ended in a run that reads a book and writes a
                book. A translation is a records file now and the words go into the
                blocks as the book is assembled, upstream of the format fork — so
                plain text works from here too, and only the facsimile cannot.

                TWO REASONS, TWO SENTENCES. The card is dead for a book that
                arrived as a book as well, and "click back to the reading" is
                advice to nowhere for a project that has no reading and no scan to
                have one of. A bound that names the wrong reason is a bound the
                person will try to work around.
              -->
              @if (arrivedAsBook()) {
                <p class="note">
                  No facsimile of this one. A facsimile reprints a scan's own photographed pages as
                  real text, and this book came to you as a book — there are no pages of it anywhere,
                  only its words. The EPUB and the plain text are made from those.
                </p>
              } @else {
                <p class="note">
                  No facsimile, standing here. You are on a translation, and a facsimile reprints the
                  scan's own photographed pages — there is nowhere on a photograph of a German page to
                  put a Hungarian paragraph. Click back to the reading for a facsimile of the original.
                </p>
              }
            }

            @if (kind() === 'txt') {
              <p class="note">
                Plain text is the book with the markup taken off — headings, paragraphs, and
                footnotes as [1] at the end of each chapter. Pictures do not survive it, and
                Foundry cannot open a text file in a tab: the queue will say when it is filed.
              </p>
            } @else if (kind() === 'pdf') {
              <p class="note">
                The same pages, reprinted as real text: same page size, same layout, every line
                set where it was printed — but as type rather than as a photograph. It stays
                crisp at any zoom, copies as words, and is a fraction of the size. Pictures are
                cut out of the scan and kept. A page the model could not read keeps its
                photograph so nothing is lost. Your original scan is never touched.
              </p>
            } @else {
              <p class="note">
                The book, rebuilt into chapters with its footnotes linked. It opens here the
                moment it is done, and it stays filed under this project.
              </p>
            }

            <!--
              WHAT THIS IS MADE FROM, said plainly, because it is the reassurance
              that makes exporting a second time feel free rather than reckless.

              A TRANSLATION POSITION USED TO GET A SECOND SENTENCE HERE, admitting
              that the export could spend model time: it ran the translator over
              whatever the bank could not answer, and a job like that starts from
              the queue rather than from this button. A translated export is one
              rendering now — the words are read out of the translation's records
              file, which is on disk — so the plain sentence is true everywhere and
              the caveat is gone rather than merely unshown.

              A BOOK THAT ARRIVED AS A BOOK GETS THE TRUE VERSION OF THE SAME
              REASSURANCE. No model has read anything here and none ever will, so
              naming pages that were never read would be this app claiming work it
              did not do — in the one sentence whose entire job is to make
              exporting a second time feel free.
            -->
            @if (arrivedAsBook()) {
              <p class="note quiet">
                Made from the book you imported, taken apart into its own chapters and paragraphs.
                Nothing is read and no GPU is used.
              </p>
            } @else {
              <p class="note quiet">
                Made from the {{ pages() > 0 ? pages().toLocaleString() + ' pages' : 'pages' }} the
                model has already read.
                Nothing is read again and no GPU is used.
              </p>
            }

            <!--
              A FINISHED EXPORT IS NOT A STEP, and saying so is what stops the
              next question. Everything else this app makes appears in the Steps
              ledger and can be built on; this one is the end of the line, which
              is exactly why it is safe to make ten of them.
            -->
            <p class="note quiet">
              It is filed under this project, beside the other things you have exported. It never
              becomes a step, so nothing you do later is built on it — make another whenever the
              book has moved on.
            </p>

            @if (problem(); as reason) {
              <p class="problem">{{ reason }}</p>
            }
          } @else if (readingDone()) {
            <!--
              READ, BUT STANDING ON THE SCAN. Not an error and not a missing
              step: the user is looking at the pages the book was read from, and
              the honest answer is where to stand rather than a button that
              would quietly export the book they stepped back from.
            -->
            <p class="unread">You are standing on the scan.</p>
            <p class="note">
              An export is made from the book, so stand on the book in the library first — it
              hangs under the scan, along with everything you have done to it — and this offers
              all three formats from wherever you are standing.
            </p>
          } @else {
            <!--
              The whole of the no-reading state. Two options, because there is no
              third: nothing in this engine turns a scanned book into a readable
              one without the model reading it first.

              AND IT IS ABOUT A SCAN, WHICH IS WHAT IT ALWAYS MEANT. Every project
              that had not been read landed here, including the ones that never had
              pages to read — so a person who imported an EPUB was told their book
              had not been read yet and offered a vision model for it, which is a
              false sentence about a finished book and a bill for nothing. Those go
              to the cards now (\`canMake\`) and this is left saying exactly what it
              was written to say, to the people it was written for.
            -->
            <p class="unread">This book has not been read yet.</p>
            <p class="note">
              An export is built out of what the vision model read off the pages, and nobody has
              read these pages. That is the one step that costs anything — after it, you can make
              any of the three from the same reading, as often as you like, for nothing.
            </p>
          }
        </div>

        <!--
          NO PRIMARY WHERE THERE IS NOTHING TO PRESS. Standing on the scan the
          only thing this card can offer is a sentence and a way out; a dead
          Export button beside it would be the app inviting a gesture it has
          just explained it will not take.
        -->
        <footer class="foot">
          <button class="ghost" (click)="ui.closeExport()">Cancel</button>
          @if (canMake()) {
            <button class="primary" [disabled]="busy()" (click)="run()">
              {{ busy() ? 'Starting…' : 'Export' }}
            </button>
          } @else if (!readingDone()) {
            <button class="primary" (click)="ui.openOcr()">Read the pages…</button>
          }
        </footer>
      } @else {
        <div class="body empty">
          <p>Open a book first — exporting is a thing you do to the document you have in front of you.</p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeExport()">Close</button>
          <button class="primary" (click)="openDocument()">Open a document…</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    /* The OCR dialog's card, to the pixel. Two modals in one app that differ by
       a few pixels of padding read as two apps. */
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
    .body.empty { color: var(--text-secondary); font-size: 13px; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    .kinds { display: flex; flex-direction: column; gap: 6px; }
    .kind {
      display: flex; flex-direction: column; gap: 2px;
      padding: 9px 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      text-align: left; cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .kind:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    /* Dimmed rather than hidden: the two formats still exist and are still what
       this book can be made into from one row up, so removing the cards would
       teach somebody that this app cannot make a facsimile at all. */
    .kind:disabled { opacity: 0.45; cursor: not-allowed; }
    /* The chosen one wears the accent, which is this app's one word for "this is
       the thing" — the same soft fill the action menu's active row and the inspector's
       current category row use. */
    .kind.on { background: var(--accent-soft); border-color: var(--accent); }
    .kind-name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .kind.on .kind-name { color: var(--accent); }
    .kind-note { font-size: 11px; color: var(--text-tertiary); }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .note.quiet { opacity: 0.8; }
    .unread { margin: 0; font-size: 13px; font-weight: 500; color: var(--text-primary); }
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
export class ExportDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);

  /**
   * The BOOK this is an export of, named by the document the project was built
   * around rather than by whatever the pane happens to be showing.
   *
   * IT USED TO BE "the focused tab, if it is a PDF", which was right while the
   * scan was the only thing anybody ever stood on. It is wrong now: standing on
   * the reading shows the flowing book, and that is exactly the position an EPUB
   * is usually wanted from — a dialog that went dark there would be dark in the
   * commonest case in the app. So the tab identifies the PROJECT, and the
   * project's own origin document is what the plan is asked about, which is the
   * question main answers anyway (it resolves the archived original regardless of
   * what it is handed).
   *
   * NO SOURCE PICKER, unlike the OCR dialog, and the difference is what the two
   * are for. That one exists to assemble a BATCH — four books queued in one
   * sitting, run overnight — so it lets you point at any open scan. This is one
   * free export of the thing you are looking at, made because you want the
   * result; a picker would be a list to read before a button that could have been
   * pressed already.
   */
  protected readonly source = computed(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    const project = this.projects.projectFor(tab.path);
    if (project === null) return tab.kind === 'pdf' ? tab.path : null;
    return this.projects.originalOf(project)?.path ?? (tab.kind === 'pdf' ? tab.path : null);
  });

  private readonly project = computed(() => {
    const input = this.source();
    return input === null ? null : this.projects.projectFor(input);
  });

  /**
   * Whether this book's pages have been read — the one thing that decides which
   * of the two dialogs this is.
   *
   * FROM THE PROJECT RECORD, which main derived once when it listed the library
   * (`readingState` in electron/projects.ts). Not a probe of the disk from here:
   * the renderer cannot read a path it names, and a dialog that had to ask main
   * about a file every time it opened would be a dialog with a spinner in it.
   */
  protected readonly readingDone = computed(() => this.project()?.reading.done === true);
  protected readonly pages = computed(() => this.project()?.reading.pages ?? 0);

  /**
   * WHETHER THIS BOOK ARRIVED AS A BOOK, which is the other way a project comes
   * to have blocks — and the reason this dialog was dead-bolted for every one of
   * them.
   *
   * `readingDone` above is false for such a project and always will be: there are
   * no pages under it to read, so nothing ever banks any, so the sentence below
   * offered to run OCR on a book that has no photographs in it and the Export
   * button never appeared. The three formats are all arithmetic over BLOCKS, and
   * an imported EPUB's blocks are exploded out of the archived container the same
   * way a scan's are reflowed out of a bank (docs/RENDERER.md §6, `book =
   * f(epub)`). One of the two roads having been travelled is the real condition,
   * and it always was.
   *
   * FROM `ProjectsService`, where the test is argued and spelled once, because the
   * rail's Export button asks the identical question — a dock that lights a button
   * onto a dialog that says the book cannot be exported is worse than either
   * answer alone.
   */
  protected readonly arrivedAsBook = computed(() => this.projects.arrivedAsBook(this.project()));

  /**
   * WHETHER THE POSITION IS STANDING ON THE SCAN, which is the one place in a
   * read project where there is nothing to export.
   *
   * ── Why the gate is the position and the input is still the original ────────
   *
   * These look contradictory and are not. `source()` above hands main the
   * project's ORIGINAL because that is the question main's planner answers — it
   * resolves the archived original regardless of what it is given, and it reads
   * the POSITION for itself to decide whether a translate stage belongs in the
   * plan (`renderPipeline`). So the input has never been the thing that decides
   * WHICH book comes out; the position has.
   *
   * What was missing was the honest refusal at the top of the import chain. An
   * export is arithmetic over the bank a reading produced, and standing on the
   * import is standing BEFORE that reading: the user has deliberately stepped
   * back to the untouched scan, and an Export button live there would quietly
   * make the book they had just stepped away from (docs/WORKBENCH.md §6c — every
   * action keys off the position, "on the import row = disabled").
   *
   * FROM THE LEDGER MIRROR, like `noFacsimile` beside it. A project whose history
   * this window has not read yet answers null, and null is not the import — the
   * dialog stays open and main's own refusal is the backstop, which is this file's
   * rule everywhere: a shut door explains itself, and a door shut on a guess does
   * not.
   *
   * AND IT IS NOT THE IMPORT WHEN THE IMPORT IS THE BOOK. Everything above is
   * about stepping BACK to the untouched scan from a reading made of it. A project
   * that arrived as a book has no reading to have stepped back from and exactly
   * one row in its whole ledger — the import — and that row is not a photograph of
   * the book, it IS the book: main reads that same position, an EPUB archive with
   * no reading in effect, as the instruction to explode the container
   * (`bookAtPosition`, electron/projects.ts). Refusing there would refuse the only
   * place such a project can ever stand.
   */
  protected readonly onImport = computed(() =>
    !this.arrivedAsBook()
    && this.ledger.standingIn(this.project()?.dir ?? null)?.action === 'import');

  /**
   * The blocks exist — read off pages or exploded out of a container — and the
   * position is somewhere an export can be made from.
   */
  protected readonly canMake = computed(() =>
    (this.readingDone() || this.arrivedAsBook()) && !this.onImport());

  /**
   * The three products, named as PRODUCTS.
   *
   * "Facsimile PDF" and not "PDF": the word is the user's, and it is doing real
   * work. A PDF export of a scanned book could mean two completely different
   * things — a copy of the photographs, or the bank set back onto pages as type —
   * and only the second one is a production rather than a file copy
   * (docs/DERIVED-BOOK.md §4). Naming it facsimile is what stops somebody
   * building a page-image exporter nobody asked for.
   */
  protected readonly choices: readonly { kind: ConversionKind; label: string; blurb: string }[] = [
    { kind: 'epub', label: 'EPUB', blurb: 'The book, in chapters, for a reader.' },
    { kind: 'pdf', label: 'Facsimile PDF', blurb: 'The same pages, reprinted as real text.' },
    { kind: 'txt', label: 'Plain text', blurb: 'The words, with the markup taken off.' },
  ];

  /**
   * Whether the one thing that cannot be made from here is the facsimile.
   *
   * ── The bound, and where it is actually enforced ────────────────────────────
   *
   * A facsimile reprints the PAGE — the scan's own photographed lines, set back as
   * type — and there is nowhere in that route for a translated paragraph to go.
   * The engine refuses the pair by name (src/vlm/convert.ts) and main refuses it a
   * step earlier (`planExport`); this is the card going quiet before either of
   * them has to say so.
   *
   * IT USED TO BE `epubOnly`, AND THE PLAIN TEXT CARD WAS DEAD WITH IT. That was
   * honest about the two-stage pipeline: an export standing under a translation
   * ended in `translate`, which reads a book and writes a book, so there was no
   * route to the text emitter at all. A translation is a records file now and its
   * words are substituted before the format fork, so plain text comes out
   * translated for free — one product this app could not offer yesterday.
   *
   * FROM THE LEDGER MIRROR, the same one the inspector paints its rows from and
   * the OCR dialog asks what a re-read would cost. `translationInEffect` is the
   * walk `curationInEffect` already makes, asked one more question.
   *
   * ── AND THERE IS A SECOND WAY TO HAVE NO PAGES TO REPRINT ───────────────────
   *
   * A book that arrived as a book never had any. The translation case is "there
   * is nowhere on this photograph to put those words"; this one is that there is
   * no photograph — no scan, no bank, no page geometry anywhere in the project —
   * so a facsimile is not a product that is unavailable from where somebody is
   * standing, it is a product this book has no version of at all. The two are one
   * dead card and two different sentences, said below; main refuses the pair for
   * the second reason as well (`planRendering`, electron/workspace.ts), so the
   * menu route is answered too.
   */
  protected readonly noFacsimile = computed(() => {
    if (this.arrivedAsBook()) return true;
    const ledger = this.ledger.historyFor(this.project()?.dir ?? null)?.ledger ?? null;
    return ledger !== null && translationInEffect(ledger) !== null;
  });

  /** EPUB unless asked otherwise — it is the format this app can also read. */
  protected readonly kind = signal<ConversionKind>('epub');
  protected readonly problem = signal<string | null>(null);
  /** The plan hashes the whole document to key its project; a 400 MB scan is not instant. */
  protected readonly busy = signal(false);

  constructor() {
    // A stale complaint about the last document, cleared when the source moves.
    effect(() => {
      this.source();
      this.problem.set(null);
    });
    /*
     * READ THE HISTORY FOR THE BOOK THIS DIALOG IS ABOUT, because nothing else
     * necessarily has. The OCR dialog does exactly this and for the same reason:
     * somebody who opened a project from Home and pressed Export straight away
     * would otherwise be offered all three formats over a translation, because
     * this window had never read the ledger that says where they are standing.
     * `ensure` is silent and idempotent — a project already held is a no-op.
     */
    effect(() => { this.ledger.ensure(this.project()?.dir ?? null); });
    /*
     * AND THE CHOICE FOLLOWS THE BOUND. A person who picked the facsimile over
     * the reading and then clicked onto the translation would be left holding a
     * selection that is now a disabled card — and would press Export to be told
     * by main what the card in front of them already said.
     */
    effect(() => { if (this.noFacsimile() && this.kind() === 'pdf') this.kind.set('epub'); });
  }

  /**
   * The BOOK this export would be made from, and what it is.
   *
   * The same wording as the OCR dialog's picker, out of the same helper, because
   * they name the same set of documents and a person moves between the two in one
   * sitting. It was a basename — the name of a copy in a directory this app never
   * shows anybody — and the path is still one hover away on the field itself,
   * which is where somebody asking about a file rather than about a book looks.
   */
  protected optionFor(filePath: string): string {
    return qualify(this.nameFor(filePath), 'pdf', '');
  }

  /** One rule for what a document is called, and it is not this file's. */
  private nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  /** What a kind is CALLED, out of the one table the cards are drawn from. */
  private labelFor(kind: ConversionKind): string {
    return this.choices.find((choice) => choice.kind === kind)?.label ?? 'document';
  }

  protected openDocument(): void {
    void this.documents.openViaDialog();
  }

  /**
   * Ask for the export, and get out of the way.
   *
   * THE DIALOG CLOSES AND NOTHING ELSE HAPPENS ON SCREEN until the job lands —
   * at which point the document opens itself in a tab, which is the result the
   * user asked for. The shelf is unrolled on the way out so that an export
   * which takes a moment is visibly moving rather than apparently ignored.
   *
   * `planExport` AND NOT `plan`, and the difference is one directory and the
   * whole ruling: the same planning pass, aimed at the project's filed folder
   * rather than at the working ones. `export: true` on the request is the other
   * half — it is what tells the landing to file the result rather than record it
   * as a rendering the ledger will later be asked to reason about.
   *
   * A refusal keeps the card, in the form this app's dialogs already use: the
   * same export already running is not a success and moving on would be
   * performing a result nothing produced. Main's own sentences arrive this way
   * too — the interrupted reading, the unread book, the translation of a
   * translation — and they are shown verbatim, because they name the case better
   * than anything this window could compose about a project it cannot read.
   */
  protected async run(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      const kind = this.kind();
      const plan = await api.workspace.planExport(input, kind);
      const request: JobRequest = {
        kind,
        // The pixels, as always: main resolves the archived original rather than
        // trusting the document the user happens to be looking at.
        inputPath: plan.sourcePath,
        outputPath: plan.outputPath,
        readingsPath: plan.readingsPath,
        /*
         * TERMINAL, and the landing has to be told. Without this the queue
         * records the result as a rendering of the project — a row in the
         * documents catalogue, a live file something later could be built on —
         * which is precisely what an export is not.
         */
        export: true,
        /*
         * AND THE TRANSLATION'S OWN WORDS, WHEN MAIN PUT THEM IN THE PLAN —
         * carried, never composed. Which translation this position is about is
         * read off the ledger, and the ledger main holds is the truth; this
         * window holds a mirror of it that is a repaint behind at worst. Copying
         * what the plan says is the same rule `readingsPath` has always obeyed one
         * line up.
         *
         * This used to be a whole second STAGE — a translate run after the
         * rendering, with a language, a bank and a row to land in. A translation
         * is a records file now, so what the plan hands over is that file and the
         * language to declare the book as, and one engine run makes the edition.
         */
        ...(plan.records !== undefined ? { records: plan.records } : {}),
        ...(plan.language !== undefined ? { language: plan.language } : {}),
        /*
         * AND THE BOOK ITSELF, WHEN THIS EXPORT IS OF A BOOK SOMEBODY EDITED —
         * carried, never composed, for `records`' reason exactly. Main replayed
         * the changes on the way to this position into a book file of its own the
         * moment the plan was made, and the engine compiles that instead of
         * rebuilding the book from the pages it was read from
         * (docs/RENDERER.md §6). Absent for a book nobody has edited and for a
         * facsimile, both of which are made from the reading as they always were.
         */
        ...(plan.bookPath !== undefined ? { bookPath: plan.bookPath } : {}),
      };

      const outcome = await this.queue.enqueue(request);
      if (outcome === 'already') {
        this.problem.set(`The ${this.labelFor(kind)} of ${this.nameFor(input)} is already being made.`);
        return;
      }
      this.ui.shelfExpanded.set(true);
      /*
       * ONE SENTENCE NOW, AND IT SAYS THE JOB IS MOVING. A translated export used
       * to be HELD — it ran the translator as its second stage, which can spend
       * model time — so the line had to hand the person to the Start button. It
       * is one `vlm-convert` with the translation's words read out of a file: no
       * model, no server, seconds. Nothing is waiting for a press, so nothing
       * should tell somebody to go and find one.
       */
      this.ui.announce(`Making the ${this.labelFor(kind)} of ${this.nameFor(input)}. It will be `
        + 'filed under this project when it is done.');
      this.ui.closeExport();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
