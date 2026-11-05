import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { qualify } from '@owen/foundry-core/shared/documents';
import { LANGUAGE_CHOICES } from '@owen/foundry-core/shared/languages';
import { reReadAhead } from '@owen/foundry-core/shared/reread';
import type { Job, JobRequest } from '@owen/foundry-core/shared/types';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { QueueService } from '../../core/queue.service';
import { OpenDocumentsService, type Tab } from '../../core/documents.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { api, hosted } from '../../core/foundry';
import { RunProgressComponent } from '../run-progress/run-progress.component';
import { RunTargetComponent } from '../run-target/run-target.component';

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
  imports: [FormsModule, RunProgressComponent, RunTargetComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ocr-dialog.component.html',
  styleUrl: './ocr-dialog.component.scss',
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

  /**
   * Every book open in the app whose PAGES a model could read — as PATHS TO
   * DOCUMENTS, every one of them.
   *
   * ── Why a light table is still in this list, and what it contributes ────
   *
   * A minted book was a folder of page images between `ecbf238` and Wave 41, so
   * there was no tab of kind `pdf` for it and no path for this list to hold, and
   * the one kind of book that CANNOT have arrived with text in it had no way to
   * order a reading. The answer then was to offer the PROJECT DIRECTORY and have
   * `planReading` recognise it as one.
   *
   * A mint files a PDF now, so a captured book is an ordinary document with an
   * ordinary tab. What is NOT ordinary is where somebody is standing when they
   * press OCR: the light table is a surface of its own, it stays open after a
   * mint (the photographs remain editable — that is what makes a re-mint
   * possible at all), and a person looking at it has pointed at a book as
   * clearly as anybody looking at a PDF. So a capture tab contributes its
   * PROJECT'S ORIGINAL to this list — a path to a file, exactly like every
   * other entry — and there is no project-directory face left on either side of
   * the bridge.
   *
   * THE ALTERNATIVE WAS A BUTTON ON THE CAPTURE RAIL, and it was rejected on
   * what this dialog holds: `--skip-pages` and `--language`. A photographed book
   * has covers, endpapers and blank leaves at the front, so it is MORE likely to
   * need a page range than an imported PDF, not less — a rail button that
   * enqueued straight past this form would have taken both choices away from
   * precisely the books that need them.
   *
   * BEFORE THE MINT IT CONTRIBUTES NOTHING, which is the half that has never
   * changed: there is nothing on the disk to read, and offering it would queue
   * three hours of GPU against a book that does not exist yet.
   */
  protected readonly sources = computed(() => [...new Set(this.documents.tabs()
    .flatMap((tab) => {
      if (tab.kind === 'pdf') return [tab.path];
      if (tab.kind !== 'capture') return [];
      const original = this.mintedOriginal(tab.path);
      return original === null ? [] : [original];
    }))]);

  /**
   * The book a capture project has minted, or null while it is still a shoot.
   *
   * ONE QUESTION, ASKED OF THE CATALOGUE. `originalOf` is what Home, the tree
   * and the three make-dialogs ask about every project in the app, and a
   * captured project has been able to answer it since its mint learned to file a
   * PDF (`catalogueMint`, electron/projects.ts). The summary field that stood in
   * for it while a mint wrote a folder — `ProjectSummary.pages` — is retired
   * with the folder it described.
   */
  private mintedOriginal(projectDir: string): string | null {
    const project = this.projects.projectFor(projectDir);
    if (project === null || !project.capture) return null;
    return this.projects.originalOf(project)?.path ?? null;
  }

  /**
   * A light table is open and has nothing to read yet — photographs, no mint.
   *
   * Asked of the same two facts the source list is: a capture tab, and whether
   * its project has a book yet. The negative half is what makes this a different
   * sentence rather than the same one said twice.
   */
  protected readonly photographing = computed(() => this.documents.tabs()
    .some((tab) => tab.kind === 'capture' && this.mintedOriginal(tab.path) === null));

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
    if (tab === null) return null;
    // The captured book in front of you is the book in front of you, once it
    // has been minted: a light table names its project, and the project's
    // original is the document a reading is of. `sources` is the one rule about
    // what may be read, so its answer is what this defaults to.
    if (tab.kind === 'capture') {
      const original = this.mintedOriginal(tab.path);
      return original !== null && this.sources().includes(original) ? original : null;
    }
    return tab.kind === 'pdf' ? tab.path : null;
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
    // EVERY CANDIDATE IS A PDF AGAIN. A "photographed pages" qualifier stood
    // here for a folder, which is not one of the three file types `typeLabel`
    // names and could not be called "PDF" without the option lying about what
    // it was. A mint files a PDF, so a captured book and an imported scan are
    // the same kind of row in this picker and read the same way.
    return qualify(this.nameFor(filePath), 'pdf', '');
  }

  /** One rule for what a document is called, and it is not this file's. */
  protected nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  protected readonly skipPages = signal('');
  protected readonly language = signal('en');
  protected readonly problem = signal<string | null>(null);
  /** Why nothing was queued. Cleared whenever the form's answers change. */
  protected readonly added = signal<string | null>(null);
  /**
   * WHICH PRESS IS IN FLIGHT, so only that button says so.
   *
   * A boolean here read "something is happening" and both buttons would have
   * said it. The workspace plan is a hash of the whole PDF -- a 400 MB scan is
   * not instant -- so there is a real moment to label, and labelling the wrong
   * button during it is how somebody concludes they pressed the wrong one.
   */
  protected readonly busy = signal<'queue' | 'start' | null>(null);

  /**
   * Every language this app offers, by name — the same table Translate lists.
   *
   * The DEFAULT IS ENGLISH rather than blank. A blank would be the honest shape
   * if nothing were known, but the field is "declared, not detected": something
   * is going to be sent, and an empty select is a question with no answer
   * selected that a person can walk past without noticing.
   */
  protected readonly languages = LANGUAGE_CHOICES;

  /** Read in the template: hosted, the host's queue holds nothing. */
  protected readonly hosted = hosted;

  /** The engine this run is pinned to. The child picks the default. */
  protected readonly server = signal('');
  /** May this act run on that engine at all -- the child's verdict. */
  protected readonly canRun = signal(false);

  /**
   * THE ROW THIS CARD IS WATCHING, or null when it is a form.
   *
   * An id rather than the job, because the job is re-pushed whole on every
   * change (`queue:changed`) and a held copy would be a snapshot going stale
   * under a progress bar. See {@link watched}.
   */
  private readonly watching = signal<string | null>(null);

  /**
   * That row as it stands right now, out of the queue's own mirror.
   *
   * NULL THE MOMENT IT LEAVES THE LIST, which is what makes Send to background
   * and a finished run the same code path: the card stops watching and what it
   * draws goes back to being a form.
   */
  protected readonly watched = computed(() => {
    const id = this.watching();
    if (id === null) return null;
    return this.queue.jobs().find((job) => job.id === id) ?? null;
  });

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
    /*
     * THE BOOK ARRIVED AND TOOK THE TAB. A finished reading opens its book, which
     * leaves this card with no PDF in front of it, and it would then tell somebody
     * who has just read one to "Open a PDF first". The work is on screen, so it closes.
     */
    effect(() => {
      if (this.watched()?.state === 'done' && this.source() === null) {
        this.watching.set(null);
        this.ui.closeOcr();
      }
    });

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

  /**
   * ONE COMPOSE, TWO ENDINGS.
   *
   * `release` is the whole difference between the two buttons, and it is one
   * argument rather than two methods because everything above the last four
   * lines -- the cost question, the plan, the request -- is identical and a
   * second copy of it would drift.
   */
  protected async add(release: boolean): Promise<void> {
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

    this.busy.set(release ? 'start' : 'queue');
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
        /*
         * AN `inputKind` RODE HERE (Wave 41's gravestone), answered by main from
         * the project's own catalogue, selecting `--pdf` or `--pages` at the
         * command line. A reading is of a PDF: the mint assembles one, so the
         * question has one answer and the flag is spelled once. Owen: *"if we're
         * building the bank from the images anyway maybe we should just build it
         * from the pdf… it would help maintain provenance, and nothing will be
         * lost."*
         */
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

      /*
       * PINNED TO THE ENGINE THE CARD NAMED, and pinned AFTER the enqueue rather
       * than carried on the request: `waitFor` is a property of the ROW (a
       * person can re-route a parked row from the shelf), so the queue's own
       * door is the one owner of it. A blank server means nothing was chosen and
       * the row keeps the default it was admitted with.
       */
      const { outcome, id } = await this.queue.enqueueNamed(request);
      if (id !== null && this.server().length > 0) {
        await this.queue.setWaitFor(id, this.server());
      }
      /*
       * A REFUSAL IS NOT A SUCCESS, so it does not get the success behaviour.
       * Main dedupes on what a job produces — for a reading that is the bank —
       * so a second Add of the same book changes nothing, and closing the dialog
       * and moving focus away would be this app performing a result it did not
       * produce. It stays put and says so, in the form the dialog already uses
       * for a problem.
       */
      if (outcome === 'already') {
        /*
         * A DUPLICATE IS STILL A RUN SOMEBODY CAN WATCH. Main answers with the
         * EXISTING row, and if that row is the thing the person just asked for
         * then Start's honest behaviour is to show it working rather than to
         * report that nothing happened. Add to queue keeps the old sentence,
         * because there the news IS that the shelf did not grow.
         */
        if (release && id !== null) {
          await this.queue.release(id);
          this.watching.set(id);
          return;
        }
        this.added.set(`${this.nameFor(input)} is already waiting to be read — nothing was added.`);
        return;
      }

      /*
       * START COMMITS TO THIS ROW AND NOTHING ELSE. `queue:release` was added
       * for exactly this: the shelf's Start lets go of the whole held batch,
       * which is right for a button somebody pressed while looking at the batch
       * and wrong for a dialog that means one book.
       */
      if (release && id !== null) {
        await this.queue.release(id);
        this.watching.set(id);
        return;
      }
      /*
       * THE DIALOG GOES AND THE ATTENTION FOLLOWS THE JOB.
       *
       * This card used to stay open with a confirmation line under the form, so
       * a batch could be built without reopening it. The modal was the thing the
       * user wanted gone: what they have just done is put a job in the queue,
       * and the queue is somewhere else on the screen — leaving a form in front
       * of it makes them dismiss a card to look at the result of using it.
       *
       * So the queue panel is opened, the dialog closes, and real DOM focus moves
       * to its Start button, which is what they press next. Focus is the
       * part that matters for somebody not using a mouse: a dialog that closed
       * and dropped focus back to the document would leave them tabbing across
       * the whole window to reach the thing they just created.
       *
       * `announce` carries what the confirmation line used to say, into the
       * queue bar's live region — a sentence that is read out rather than one
       * is silently replaced by a closing card.
       */
      /*
       * The sentence is this dialog's; WHERE it lands is `confirmQueued`'s
       * (standalone: the queue bar's live region; hosted: the notice bar, because
       * there is no queue surface of ours and the host owns that chrome).
       * Hosted the clause about Start goes too — a routed read is queued on
       * arrival and runs when the device frees, nobody presses anything.
       */
      this.ui.confirmQueued(hosted()
        ? `Added ${this.nameFor(input)} to be read. It is in the queue and runs on its own.`
        : `Added ${this.nameFor(input)} to be read. Press Start on the queue to run it.`);
      /*
       * One door for the open-and-focus, because the hosted rule lives in it:
       * hosted there is no queue surface to open (Owen ruled it — the host's queue
       * page is the one queue surface) and this call is deliberately nothing.
       */
      this.ui.summonQueue(true);
      this.ui.closeOcr();
    } catch (err) {
      // Never swallowed and never a console line: the two things that can fail
      // here are reading the PDF to key it and the queue refusing the job, and
      // both are sentences.
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * LET GO OF THE RUN, KEEP THE RUN. Owen: *"if they hit 'send to background',
   * it adds it to the queeu while running and they can continue their work."*
   *
   * Nothing is moved and nothing is handed over, because the row has been in the
   * queue since the press — this card simply stops watching it and closes. The
   * queue panel opens on the way out for the reason Add has always opened it:
   * what somebody has just done is put work somewhere else on the screen, and
   * they should be able to see it.
   */
  protected background(): void {
    this.watching.set(null);
    this.ui.summonQueue(true);
    this.ui.closeOcr();
  }

  /**
   * STOP THE RUN, and go back to being a form rather than closing.
   *
   * A cancelled reading leaves a row in the shelf and nothing on disk worth
   * keeping, so the useful next thing is usually to change a page range and try
   * again — which is this card, with the values still in it.
   */
  protected async cancelRun(id: string): Promise<void> {
    await this.queue.cancel(id);
    this.watching.set(null);
  }

}
