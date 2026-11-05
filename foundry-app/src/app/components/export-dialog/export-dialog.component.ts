import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import { qualify } from '@owen/foundry-core/shared/documents';
import { translationInEffect } from '@owen/foundry-core/shared/ledger';
import { carriedFromPlan } from '@owen/foundry-core/shared/pipeline';
import type { ConversionKind, JobRequest } from '@owen/foundry-core/shared/types';

import { LedgerService } from '../../core/ledger.service';
import { NoticeService } from '../../core/notice.service';
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
 * ── It runs HERE, under this card, and it opens what it made ────────────────
 *
 * NOT A QUEUE JOB AT ALL ANY MORE. The queue is for work that takes a long time
 * or holds real resources — a reading is hours of GPU, a translation holds a
 * model for a book — and an export is seconds of offline arithmetic somebody is
 * actively waiting on. It used to be enqueued anyway ("one engine at a time is
 * a rule about the machine"), which meant this dialog closed on a promise and
 * the queue page was where you went to learn whether the button worked. The
 * user ended it (2026-08-23): only the expensive things go to the queue; an
 * export is processed on the spot, in the modal that asked for it.
 *
 * So Export runs the job through `queue.run` (main's `runNow`), the card stays
 * up saying "Exporting…" for the seconds it takes, and the SETTLED row comes
 * back as the answer: a failure is the engine's own words in this card, and a
 * success closes it, files the result, and puts the book in front of the
 * person — an exported EPUB opens as its proof sheet, a facsimile opens in the
 * viewer, and plain text is named in the notice because there is no tab for it.
 * Machine-rationing did not go anywhere a person can feel: main still mints a
 * row for the length of the run, so the guards count it and its ✕ works; the
 * row just never waits and never lingers.
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
  templateUrl: './export-dialog.component.html',
  styleUrl: './export-dialog.component.scss',
})
export class ExportDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly queue = inject(QueueService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);
  /** The one sentence a finished export gets — the notice bar, in both worlds. */
  private readonly notices = inject(NoticeService);

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
    /*
     * ASKED OF THE LEDGER WITH THE PROMISES IN IT (`LedgerService.ledgerIn`), so a
     * facsimile offered from a position under a translation that has not LANDED yet
     * is refused for the same reason it is refused under a landed one: there is
     * nowhere on the photographs to put those words. The card would otherwise offer
     * a reprint that main will decline a moment later, which is the exact shape
     * Owen's ruling forbids.
     */
    const ledger = this.ledger.ledgerIn(this.project()?.dir ?? null);
    const standing = this.ledger.standingIn(this.project()?.dir ?? null);
    return ledger !== null && translationInEffect(ledger, standing) !== null;
  });

  /**
   * THE ROW THIS CARD IS AIMED AT, when it is not the position.
   *
   * Undefined for every press this dialog had before Owen's pending-node ruling,
   * and a step id for the one shape where the pointer could not follow the click:
   * somebody standing on a GRAYED card in the tree — *"i click the grayed out row
   * and hit the export epub tile"* — whose step will not exist until a queued job
   * lands. Main resolves it and answers with a DEFERRED plan, which carries the
   * four names this export will have and nothing that needed the chain.
   */
  private readonly aim = computed<string | undefined>(
    () => this.ledger.aimedAt(this.project()?.dir ?? null),
  );

  /** EPUB unless asked otherwise — it is the format this app can also read. */
  protected readonly kind = signal<ConversionKind>('epub');
  protected readonly problem = signal<string | null>(null);
  /**
   * True from the press to the settle — the plan AND the run, because the run
   * happens under this card now. It used to cover only the planning hash (a
   * 400 MB scan is not instant); the seconds of engine time it also covers are
   * exactly what the button's "Exporting…" is describing.
   */
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
   * Ask for the export, WAIT FOR IT, and put the result in front of the person.
   *
   * THE CARD HOLDS THE QUESTION OPEN. `queue.run` resolves when the job has
   * settled — seconds, because an export is arithmetic over answers already on
   * the disk — and the row that comes back is the whole account: `done` and the
   * file is filed, `failed` and `error` carries the engine's own words, a
   * pending state and something else is already writing this very file. Nothing
   * goes to the queue and nothing is left in it afterwards; the header carries
   * the ruling.
   *
   * `planExport` AND NOT `plan`, and the difference is one directory and the
   * whole ruling: the same planning pass, aimed at the project's filed folder
   * rather than at the working ones. `export: true` on the request is the other
   * half — it is what tells the landing to file the result rather than record it
   * as a rendering the ledger will later be asked to reason about.
   *
   * WHAT OPENS IS DECIDED BY WHAT WAS MADE, the library's own click model
   * (open-documents): an EPUB opens as its proof sheet over the exported file,
   * a facsimile PDF opens in the viewer, and plain text has no tab — the notice
   * names it and its library row reveals the file. Opened from HERE, off the
   * settled row, rather than inferred from a queue mirror this job no longer
   * appears in.
   *
   * A refusal keeps the card, in the form this app's dialogs already use: the
   * same export already running is not a success and moving on would be
   * performing a result nothing produced. Main's own sentences arrive this way
   * too — the interrupted reading, the unread book, the translation of a
   * translation, and now the engine's own failure — and they are shown verbatim,
   * because they name the case better than anything this window could compose
   * about a run it did not watch.
   *
   * A CARD CLOSED MID-RUN CHANGES NOTHING: the run is main's, this method's
   * continuation still fires, and the book still arrives with its notice — the
   * person dismissed a spinner, not the work.
   */
  protected async run(): Promise<void> {
    const input = this.source();
    if (input === null || !api) return;

    /*
     * ── AN EPUB MINT GOES THROUGH THE METADATA CARD FIRST — Owen's ruling ────
     *
     * (2026-08-24): *"The modal appears BEFORE the mint. Filling it is how the
     * user knows what they're exporting and where it'll go."* So the EPUB
     * press hands off to the mint metadata dialog, which runs the whole
     * export itself — fields, filename, queue, landing — with this card's own
     * machinery below serving the formats that carry no metadata card: the
     * facsimile and the text. The handoff needs the project, and an export
     * source is always inside one; a path somehow outside any project falls
     * through to the old path, which will refuse it with the plan's own
     * sentence rather than this dialog inventing one.
     */
    if (this.kind() === 'epub') {
      const project = this.projects.projectFor(input);
      if (project !== null) {
        this.ui.openMintMeta({ mode: 'mint', projectDir: project.dir, inputPath: input });
        return;
      }
    }

    this.busy.set(true);
    this.problem.set(null);
    try {
      const kind = this.kind();
      const plan = await api.workspace.planExport(input, kind, this.aim());
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
         * AND THE TRANSLATION'S WORDS, THE LANGUAGE, THE EDITED BOOK AND THE
         * NARRATION RECEIPT, WHEN MAIN PUT THEM IN THE PLAN — carried, never
         * composed, through the one function every builder spreads
         * (`carriedFromPlan`, shared/pipeline.ts). Which translation, which
         * book and which cleanup this position is about is read off the ledger
         * main holds; this window's mirror is a repaint behind at worst, which
         * is the same rule `readingsPath` obeys one line up.
         *
         * THIS USED TO BE THREE HAND-WRITTEN SPREADS, and the day the plan grew
         * a fourth field this builder did not learn it: an export from a
         * cleaned position came out with no narration meta, and BookForge asked
         * Owen to clean a book he had just cleaned (2026-09-05). A spread of a
         * function cannot fall a field behind.
         */
        ...carriedFromPlan(plan),
      };

      /*
       * ── A DEFERRED EXPORT IS QUEUED, WHERE EVERY OTHER ONE IS RUN ─────────────
       *
       * This card runs its export under itself and always has, for a reason it
       * states at length: an export is seconds of offline arithmetic and the person
       * who pressed the button is standing in front of the dialog waiting for the
       * file. NEITHER HALF IS TRUE OF A PROMISED ONE. There is nothing to compute
       * yet — the book it would compile has not been made, because the step it is of
       * has not landed — so holding the card open would be a spinner over a wait of
       * unknown length, and `runNow` refuses the request by name rather than spawn
       * an engine against a chain that does not exist.
       *
       * SO IT GOES IN THE QUEUE, which is where Owen put it: *"i click the grayed
       * out row and hit the export epub tile … then send narration and assembly to
       * the queue."* The row waits behind the one it is made from (`Job.after`), the
       * tree draws it as a grayed card under the promise it hangs off, and the
       * person is told that rather than shown a proof sheet of nothing.
       *
       * THE DEDUPE ANSWER IS READ, on `QueueService.enqueue`'s own rule: pressing
       * Export twice on one promise must say the second press changed nothing rather
       * than announce a success over a row that was already there.
       */
      if (plan.deferred !== undefined) {
        const added = await this.queue.enqueue(request);
        this.notices.notice.set(
          added === 'already'
            ? `The ${this.labelFor(kind)} of ${this.nameFor(input)} is already queued.`
            : `Queued the ${this.labelFor(kind)} — it will be made when the step it comes from `
              + 'finishes.',
        );
        this.ui.closeExport();
        return;
      }

      const job = await this.queue.run(request);
      if (job === null) return; // no API — a browser tab, where the button cannot exist anyway

      if (job.state === 'held' || job.state === 'queued' || job.state === 'running') {
        // Main's dedupe handed back the row that is already writing this file.
        this.problem.set(`The ${this.labelFor(kind)} of ${this.nameFor(input)} is already being made.`);
        return;
      }
      if (job.state === 'failed') {
        this.problem.set(job.error ?? `The ${this.labelFor(kind)} could not be made.`);
        return;
      }
      if (job.state === 'cancelled') {
        this.problem.set(`The ${this.labelFor(kind)} was stopped before it finished. `
          + 'Nothing was filed — export again whenever you like.');
        return;
      }

      /*
       * DONE, AND THE PROOF IS PUT IN FRONT OF THE PERSON. Off the settled row's
       * own path — never a guess about where main filed it — and by the same
       * doors the library's export rows open through, so a book exported and a
       * book clicked cannot arrive differently.
       */
      const filed = job.outputPath.split(/[\\/]/).pop() ?? job.outputPath;
      if (kind === 'epub') {
        this.documents.openExportView(job.outputPath, filed);
      } else if (kind === 'pdf') {
        void this.documents.openFromList(job.outputPath, true);
      }
      this.notices.notice.set(`Wrote ${filed} — filed under this project.`);
      this.ui.closeExport();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
