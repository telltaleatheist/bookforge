import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { qualify } from '@shared/documents';
import { reReadAhead } from '@shared/reread';
import type { JobRequest } from '@shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

/**
 * OCR — read the pages, and stop there.
 *
 * ── The question that left ──────────────────────────────────────────────────
 *
 * This dialog used to ask for an OUTPUT FORMAT, and a conversion was one act:
 * read three hundred pages with a vision model AND write an EPUB, chosen
 * together, spent together. That made the format a decision somebody had to
 * commit to before a single page had been read — and it made "actually, could I
 * have that as plain text too?" a question whose honest answer was another three
 * hours of GPU unless you happened to know that `--reuse-readings` existed.
 *
 * They are two acts. THE PRODUCT OF THIS ONE IS THE READING: a bank of the
 * model's answers, page by page, in the project, which is the expensive
 * irreplaceable thing everything else is made from. What the book eventually
 * BECOMES is chosen afterwards, from the Export dialog, as many times as
 * somebody likes, for nothing.
 *
 * So what is left here is the two questions that are genuinely about reading —
 * which pages are not part of the book, and what language they are in — and the
 * source. Three things it stopped asking earlier are still gone: the endpoint
 * (Settings owns the backend), the output path (nothing writes one now), and
 * "bank page answers" (always on; the bank IS the job).
 *
 * It ENQUEUES AND NOTHING ELSE, and the row it makes is HELD: reading is the
 * expensive job, the hold is what makes a batch possible, and Start is what
 * commits to it. The run is main's (electron/job-queue.ts), so dismissing this
 * dialog does not touch a job that is already moving.
 */
@Component({
  selector: 'app-ocr-dialog',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="ui.closeOcr()"></div>

    <!--
      The click guard is on the CARD rather than a stopPropagation on the scrim's
      handler, because the scrim is also the thing a click outside is supposed to
      land on and the two must not be the same listener.
    -->
    <div class="card" role="dialog" aria-modal="true" aria-label="OCR and convert">
      <header class="head">
        <span class="title">OCR — read the pages</span>
        <button class="x" (click)="ui.closeOcr()" title="Close">✕</button>
      </header>

      @if (source(); as input) {
        <div class="body">
          <!--
            A PICKER RATHER THAN A READONLY BOX, and that is what makes a batch
            possible at all. It used to name the focused tab and nothing else, so
            the only conversion this dialog could queue was the one document in
            front of you. With every open PDF in the list, four books open is
            four jobs without closing this once.
          -->
          <label class="field">
            <span class="label">Source</span>
            <!--
              THE BOOK, QUALIFIED BY WHAT IT IS. These options were basenames,
              and every document of one project shares a single stem — so two
              open books were two forty-character strings differing somewhere in
              the middle, and a project's scan and the real-text PDF made from it
              were the same option twice over, differing only by the directory the
              user is deliberately never shown. Picking the wrong one earned a
              refusal after the whole form had been filled in.
            -->
            @if (sources().length > 1) {
              <select [ngModel]="input" (ngModelChange)="pick($event)" name="source" [title]="input">
                @for (candidate of sources(); track candidate) {
                  <option [value]="candidate">{{ optionFor(candidate) }}</option>
                }
              </select>
            } @else {
              <input type="text" [value]="optionFor(input)" readonly [title]="input">
            }
          </label>

          <!--
            NO OUTPUT FORMAT. What this job makes is the reading, and what the
            book becomes is a separate decision made afterwards from a bank that
            is already paid for. Saying so here, once, because everybody arriving
            at this dialog before today was asked for a format and will look for
            the field.
          -->
          <p class="note">
            This reads every page with the vision model and banks what it says. The book
            appears by itself the moment the pages are read — and from that same reading
            you can Export a finished EPUB, plain text or a real-text PDF as often as you
            like, without reading anything again.
          </p>

          <label class="field">
            <span class="label">Language <em>declared, not detected</em></span>
            <input type="text" placeholder="en" [ngModel]="language()" (ngModelChange)="language.set($event)" name="language">
          </label>

          <label class="field">
            <span class="label">Skip pages <em>optional</em></span>
            <input type="text" placeholder="3,17,19-24" [ngModel]="skipPages()" (ngModelChange)="skipPages.set($event)" name="skip">
          </label>

          <!-- No strip-footnote-markers option, deliberately. The engine flag
               exists for BookForge's narration builds, where a reference number
               becomes a narrator saying "fourteen". Foundry converts books to
               be READ: markers are kept and linked to their notes, which is
               part of what converting to EPUB means here. -->

          @if (problem(); as reason) {
            <p class="problem">{{ reason }}</p>
          }
          <!--
            The only thing left for this line to say is that NOTHING happened —
            the job was already queued. A success closes the card, so there is
            nothing for it to report and nowhere to report it.
          -->
          @if (added(); as note) {
            <p class="added" role="status">{{ note }}</p>
          }
        </div>

        <!--
          IT CLOSES ON ADD, and hands focus to the shelf.

          For a while it stayed open so a batch could be built without reopening
          it, with a confirmation line under the form. The card was the thing in
          the way: what a person has just done is put a job in the queue, the
          queue is somewhere else on the screen, and leaving a form in front of
          it makes them dismiss a dialog to see the result of using it. Adding
          another book is one press of the rail's button; looking at what you
          just queued should not be.

          A refusal — the same job already queued — keeps the card, because
          nothing happened and moving on would be performing a result.
        -->
        <!--
          THE BRANCH'S ONE LINE, and it is here — against the button, inside the
          footer — rather than up in the body with the fields. It is not a fact
          about the form; it is a fact about what pressing that button will do,
          and a person reads the thing nearest what they are about to press.

          No line at all for a replace: that one is a question, and it is asked in
          main's own box the moment Add is pressed. No line for a book nobody has
          read, because there is nothing to say.
        -->
        <footer class="foot">
          @if (branchNote(); as fact) {
            <p class="beside">{{ fact }}</p>
          }
          <button class="ghost" (click)="ui.closeOcr()">Cancel</button>
          <button class="primary" [disabled]="busy()" (click)="add()">
            {{ busy() ? 'Working…' : 'Add to queue' }}
          </button>
        </footer>
      } @else {
        <div class="body empty">
          <p>Open a PDF first — reading the pages is a thing you do to a document you have in front of you.</p>
        </div>
        <footer class="foot">
          <button class="ghost" (click)="ui.closeOcr()">Close</button>
          <button class="primary" (click)="openDocument()">Open PDF…</button>
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
    .body.empty { color: var(--text-secondary); font-size: 13px; }
    .body.empty p { margin: 0; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .label em { text-transform: none; letter-spacing: 0; font-style: normal; font-weight: 400; opacity: 0.75; }

    .check { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--text-secondary); }
    .check input { width: auto; margin-top: 2px; accent-color: var(--accent-strong); }
    .check em { display: block; font-style: normal; font-size: 11px; color: var(--text-tertiary); }

    .note { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
    .problem { margin: 0; font-size: 12px; color: var(--warn); }
    /* The confirmation the dialog owes you now that it no longer closes. Green
       rather than the warn colour, and role=status on the element so a screen
       reader hears it without the focus moving. */
    /* It only ever says "already queued" now, which is a mild refusal rather
       than a success — the warn colour, like the problem line beside it. */
    .added { margin: 0; font-size: 12px; color: var(--warn); }

    .foot {
      display: flex; align-items: center; justify-content: flex-end; gap: 8px;
      padding: 12px 16px 16px;
      border-top: 1px solid var(--border-subtle);
    }
    /* The statement beside the buttons. It takes the free width so the buttons
       stay where they have always been — a footer whose Add moves left when a
       sentence appears is a button that has to be found again. */
    .beside {
      flex: 1; margin: 0; min-width: 0;
      font-size: 11px; line-height: 1.4; color: var(--text-tertiary);
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
export class OcrDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  /**
   * This window's mirror of the step ledger — the whole reason the cost of a
   * re-read can be named without an IPC round trip.
   *
   * The Steps accordion reads it exactly this way (`inspector.component.ts`):
   * `ensure` the focused project, then `historyFor` it, which is null until main
   * has answered and null forever for a document that is not in a project.
   */
  private readonly ledger = inject(LedgerService);

  /**
   * The PDF this conversion is OF: the focused pane's document, when it is one.
   *
   * The FOCUSED pane and not "the app's document", because with five panes open
   * there is no such thing — the one the user last clicked in is the one they
   * mean, and it is the same pane the rail's buttons and Ctrl+S act on.
   *
   * An EPUB tab is not a source — it is already the output — so the dialog says
   * "open a PDF first" over a book rather than offering to convert it.
   */
  /**
   * Which PDF this dialog is about — the user's pick, or the focused tab.
   *
   * THE OBSTACLE TO QUEUEING A BATCH WAS RIGHT HERE. This used to BE
   * `activeDocument()`, so the dialog could only ever convert the one document
   * in front of the user; queueing a second book meant closing the dialog,
   * focusing another tab and opening it again, and since `add()` also closed on
   * success there was no path through the UI that put two conversions in the
   * queue at once. Nothing in main ever refused a second job — the queue would
   * have taken them all along.
   *
   * So the pick is now a signal that DEFAULTS to the focused tab and can be
   * pointed at any other open PDF. The default is kept because it is almost
   * always right and because the empty state's promise — "a conversion is a
   * thing you do to a document you have in front of you" — is still how people
   * arrive here; what changed is that it is a default rather than the only
   * possibility.
   */
  private readonly picked = signal<string | null>(null);

  /** Every PDF open in the app, which is the set this dialog can queue from. */
  protected readonly sources = computed(
    () => [...new Set(this.documents.tabs().filter((tab) => tab.kind === 'pdf').map((tab) => tab.path))]);

  protected readonly source = computed(() => {
    const chosen = this.picked();
    // A pick survives only while its document is still open: closing the tab a
    // held job was configured from should not leave the dialog pointing at it.
    if (chosen !== null && this.sources().includes(chosen)) return chosen;
    return this.suggested();
  });

  /**
   * What to start on when the user has not picked: the focused PDF, full stop.
   *
   * IT USED TO NEED A RULE HERE AND NO LONGER DOES. For a while this preferred
   * the project's original whenever the focused document was one a conversion
   * would write over — because the user could be reading the reprint, and
   * converting it earned a refusal. That case is gone: there is one PDF per
   * project now, main resolves the pixels out of `archive/` itself
   * (`planConversion`), and every document the dialog can offer is a working
   * copy a change may be applied to. The document in front of you is always the
   * right answer, which is what it looked like all along.
   */
  private readonly suggested = computed(() => {
    const tab = this.stage.activeDocument();
    return tab !== null && tab.kind === 'pdf' ? tab.path : null;
  });

  protected pick(filePath: string): void {
    this.picked.set(filePath);
  }

  /**
   * The BOOK this option would read, and what it is.
   *
   * IT WAS A FILENAME, and the picker is where that hurt most: every candidate
   * is a PDF in a project, every project's documents share one stem, so a person
   * choosing between two open books read two strings that differed somewhere in
   * the middle of forty characters of hyphens. The project's title is what Home
   * and the document list call each of them, and a picker that agrees with the
   * two screens somebody arrived from is a picker they can answer without
   * looking twice.
   *
   * ALWAYS QUALIFIED HERE, not only on a collision. This is a list somebody is
   * CHOOSING FROM, and a picker whose entries change their wording depending on
   * what else happens to be open is a picker whose entries cannot be learned.
   * The kind is passed rather than looked up because every candidate is a PDF by
   * construction (`sources`) — and the folder fallback `qualify` offers for a
   * document with no project is deliberately not taken here: a directory name is
   * a path by another spelling, and this dialog is done showing people paths.
   *
   * The whole path is still on the control's own tooltip, which is where it
   * belongs.
   */
  protected optionFor(filePath: string): string {
    return qualify(this.nameFor(filePath), 'pdf', '');
  }

  /** One rule for what a document is called, and it is not this file's. */
  private nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  protected readonly skipPages = signal('');
  protected readonly language = signal('en');
  protected readonly problem = signal<string | null>(null);
  /** Why nothing was queued. Cleared whenever the form's answers change. */
  protected readonly added = signal<string | null>(null);
  /** The workspace plan is a hash of the whole PDF; a 400 MB scan is not instant. */
  protected readonly busy = signal(false);

  /**
   * What pressing Add would do to the reading this project already has.
   *
   * ── Why it is a computed and not a question asked inside `add()` ────────────
   *
   * Because one of its three answers is a LINE ON THIS CARD rather than a dialog,
   * and that line has to move as the form does: type a page range into Skip pages
   * and a replace becomes a branch, at that keystroke, because the ask is what
   * decides which reading this is (`reRunTarget`). A fact composed once when the
   * card opened would go on saying "this will be a second reading" after somebody
   * cleared the box.
   *
   * IT IS ALSO WHAT `add()` ASKS, so the sentence beside the button and the box
   * that goes up are one decision rather than two that could disagree.
   */
  private readonly ahead = computed(() => {
    const input = this.source();
    if (input === null) return null;
    const dir = this.projects.projectFor(input)?.dir ?? null;
    return reReadAhead(this.ledger.historyFor(dir)?.ledger ?? null, {
      skipPages: this.skipPages(),
      language: this.language(),
    });
  });

  /**
   * The one line of fact a branch gets, and nothing for the other two answers.
   *
   * A STATEMENT, NOT A QUESTION, and that is the ruling rather than a shortcut
   * (`BANK-LIFECYCLE.md` §3.2). A re-read with different pages destroys nothing
   * and stales nothing — it costs GPU, and the queue is where expense happens, so
   * putting the row there is already the deliberate act and Start is a second one.
   * What it is owed is the fact that it will not replace what is there, because a
   * person asking for a different page range may genuinely believe it will.
   */
  protected readonly branchNote = computed(() => {
    const ahead = this.ahead();
    return ahead?.kind === 'branch' ? ahead.sentence : null;
  });

  constructor() {
    // A stale complaint about the last document, cleared when the source
    // changes. Nothing else resets: skip-pages and the language are the user's
    // last answers and are usually the right ones again.
    effect(() => {
      this.source();
      this.problem.set(null);
      // And the confirmation with it: "Added Working Towards the Führer" over a form that now
      // names a different book is a sentence about something else.
      this.added.set(null);
    });

    /*
     * THE HISTORY IS ASKED FOR WHEN THE CARD LANDS ON A BOOK, on the accordion's
     * own terms: `ensure` is a no-op for a project already held or already in
     * flight, so this is safe from a repaint, and everything after the first read
     * arrives through `projects:changed`. Without it a person who opened a scan
     * from Home and pressed OCR straight away would be asked nothing at all,
     * because this window would never have read the ledger that holds the reading
     * they are about to replace.
     */
    effect(() => {
      const input = this.source();
      this.ledger.ensure(input === null ? null : this.projects.projectFor(input)?.dir ?? null);
    });
  }

  protected openDocument(): void {
    void this.documents.openViaDialog();
  }

  protected async add(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    /*
     * THE COST IS NAMED BEFORE THE JOB EXISTS, and before the plan too.
     *
     * Before the PLAN because `planReading` is not a query: it imports the
     * document if it is not in the library yet, makes `readings/`, and mints the
     * step id the bank will be named after. A person who says "no, leave the
     * reading as it is" should not have had a project folder rearranged to ask
     * them.
     *
     * ── Captured here, and never asked again (`BANK-LIFECYCLE.md` §3.3) ────────
     *
     * The sentence names the cost as of THIS MOMENT. The job may then sit held
     * behind another for an hour, and the ledger can move under it — a save
     * committed, a translation landing — so what is finally replaced and staled is
     * decided at landing by `recordLanding`, against the ledger as it stands then.
     * The race is accepted deliberately and the alternative was considered: a
     * second box at spawn time is a dialog interrupting somebody who already
     * answered, in front of a run that is about to start. Worst case here is a
     * stale sentence. It is the same rule `Job.parentStep` follows — captured at
     * enqueue, on purpose.
     */
    const ahead = this.ahead();
    if (ahead?.kind === 'replace' && !await api.confirmReRead(ahead.message)) return;

    this.busy.set(true);
    this.problem.set(null);
    try {
      const skip = this.skipPages().trim();
      const language = this.language().trim();
      /*
       * Main names the bank. There is no output file to name and no format to
       * carry — the whole of what this job produces is the reading, and where
       * that goes is the project's business rather than a field on this form.
       *
       * THE ASK GOES WITH THE QUESTION, and that is why these two are read before
       * the plan rather than after it. Which bank this run fills depends on
       * whether it is the same question a reading of this book already answered:
       * the same pages and the same language replace that reading, in its own
       * file; a different page range is a second reading and gets a bank beside
       * it. Main decides that (`bankForReading`) and hands back the path with the
       * step id it belongs to.
       */
      const plan = await api.workspace.planReading(input, {
        ...(skip.length > 0 ? { skipPages: skip } : {}),
        ...(language.length > 0 ? { language } : {}),
      });
      const request: JobRequest = {
        kind: 'read',
        /*
         * THE PLAN'S SOURCE, not the document the user picked.
         *
         * They pointed at "the PDF", meaning the one this app shows them —
         * which after a real-text rendering is type on blank paper with no
         * pixels in it at all. Main resolves what that book's PAGES actually
         * are (`planReading`: the immutable `archive/` original) and the job
         * reads those. The person asking never has to know there is more than
         * one copy, which is the whole of the working-copy model.
         */
        inputPath: plan.sourcePath,
        readingsPath: plan.readingsPath,
        /*
         * Carried, never re-minted. The bank above may be named after this id —
         * `readings/<key>.<id8>.jsonl` for a second reading of the same book — and
         * the step that lands hours from now has to be that step, or the file is
         * named after a row nobody ever created. See `ReadRequest.stepId`.
         */
        stepId: plan.stepId,
      };
      if (skip.length > 0) request.skipPages = skip;
      if (language.length > 0) request.language = language;

      const outcome = await this.queue.enqueue(request);
      /*
       * A REFUSAL IS NOT A SUCCESS, so it does not get the success behaviour.
       * Main dedupes on what a job produces — for a reading that is the bank —
       * so a second Add of the same book changes nothing, and closing the dialog
       * and moving focus away would be this app performing a result it did not
       * produce. It stays put and says so, in the form the dialog already uses
       * for a problem.
       */
      if (outcome === 'already') {
        this.added.set(`${this.nameFor(input)} is already waiting to be read — nothing was added.`);
        return;
      }
      this.ui.shelfExpanded.set(true);
      /*
       * THE DIALOG GOES AND THE ATTENTION FOLLOWS THE JOB.
       *
       * This card used to stay open with a confirmation line under the form, so
       * a batch could be built without reopening it. The modal was the thing the
       * user wanted gone: what they have just done is put a job in the queue,
       * and the queue is somewhere else on the screen — leaving a form in front
       * of it makes them dismiss a card to look at the result of using it.
       *
       * So the shelf is unrolled, the dialog closes, and real DOM focus moves to
       * the shelf's Start button, which is what they press next. Focus is the
       * part that matters for somebody not using a mouse: a dialog that closed
       * and dropped focus back to the document would leave them tabbing across
       * the whole window to reach the thing they just created.
       *
       * `announce` carries what the confirmation line used to say, into the
       * shelf's live region — a sentence that is read out rather than one that
       * is silently replaced by a closing card.
       */
      this.ui.announce(
        `Added ${this.nameFor(input)} to be read. Press Start on the queue to run it.`);
      this.ui.focusShelf();
      this.ui.closeOcr();
    } catch (err) {
      // Never swallowed and never a console line: the two things that can fail
      // here are reading the PDF to key it and the queue refusing the job, and
      // both are sentences.
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
