/**
 * The contextBridge surface, declared where BOTH sides can see it.
 *
 * The renderer cannot import the preload (it imports `electron`), and the
 * preload must not invent a shape the renderer then re-declares by hand — two
 * hand-written copies of one interface is one refactor away from a silent
 * mismatch. So the interface lives here: preload.ts implements it, and the
 * renderer's `window.foundry` is typed as it.
 */
import type { BookOutcome } from './book';
import type { HostNodeAction, HostOffers, HostStatus } from './host-ops';
import type { ReadAsk } from './ledger';
import type { BookOp, PendingOutcome, PendingStack } from './ops';
import type { ReReadPrompt } from './reread';
import type {
  AppQuestion,
  BackendSettingsPatch,
  CaptureCreated,
  CaptureIntaken,
  CaptureIntakeProgress,
  CaptureMintBegun,
  CaptureOpened,
  CaptureRecipe,
  CloseAnswer,
  CloseWarning,
  ConversionKind,
  DeletionPrompt,
  DocumentDeletion,
  DoctorResult,
  EngineInfo,
  EnvCatalogItem,
  EnvInstallProgress,
  EnvInstallRequest,
  EnvTooling,
  EpubMetadataFields,
  HostNode,
  HostNodes,
  Job,
  JobRequest,
  MetadataOutcome,
  MetadataWriteOutcome,
  PdfMetadataFields,
  LedgerStep,
  ProjectLedger,
  ProjectSummary,
  QuestionAnswer,
  ReadingPlan,
  RecentDocument,
  RewriteMode,
  ServerStatus,
  SettingsView,
  SetupLogEvent,
  SetupRequest,
  SetupResult,
  StepDeletion,
  StepLedgerView,
  StepRow,
  TranslateRequest,
  TranslationPlan,
  UnappliedAnswer,
  UnappliedWarning,
  WorkspacePlan,
  WslFacts,
} from './types';

/**
 * What the File menu asked for, since main cannot press a button in a tab.
 *
 * The accelerators live on the MENU rather than on a renderer keydown handler:
 * a menu item with `CmdOrCtrl+S` on it and a `keydown` listener for the same
 * chord both fire, and the menu is the half a user can discover.
 *
 * `undo` and `redo` are the reason the Edit menu stopped being the platform's
 * role menu: its Undo is the focused text field's and cannot reach a document
 * history that lives in a service. The renderer decides which of the three
 * undos a chord meant — a text box's, the rendered frame's, or the book's.
 */
export type MenuAction =
  /**
   * The File menu's one materialising verb, and what it replaced.
   *
   * There were two items here — Save and Save As — and the user ruled them out of
   * the app entirely: "there will be no 'save a copy' or 'save' buttons along the
   * top of panels. those buttons are reserved for the export modal that pops up
   * when you click the export button on the nav rail." A Save that wrote the
   * working tree back over a file the user chose was the right verb for an app
   * whose document was a file; the document is a projection of a bank now, and
   * what a person wants out of it is a FINISHED thing — a book, a reprint, a text
   * — which is the export modal's question and nobody else's.
   *
   * `save` and `save-as` survive in this union because the renderer's own service
   * still carries out both (the close-with-unsaved-changes dialog is one caller),
   * and a menu that no longer sends them is a menu that stopped offering the
   * gesture rather than a service that lost it.
   */
  | 'export'
  | 'save'
  | 'save-as'
  | 'close-tab'
  /*
   * `split-right` WAS HERE, and it is the one name that left this union rather
   * than outliving its menu item. It was View → Split right (Ctrl+\), the one
   * DISCOVERABLE door onto the workspace's columns — and the columns are gone:
   * *"i dont think we should have tabs in foundry… the solution is to have a
   * single viewer window/single tab, and if the user wants to compare two steps,
   * theres a compare button they can click"* (user, 2026-08-17). `save` and
   * `save-as` stayed when their menu items went because the renderer still
   * carries both out; nothing in the renderer splits anything, so there is
   * nothing left to name.
   */
  | 'toggle-documents'
  | 'undo'
  | 'redo';

export interface FoundryApi {
  /** process.platform, for the one or two places the UI says "on Windows". */
  platform: string;

  /**
   * Whether this window is standing inside another app.
   *
   * ── What the answer changes, and what it must not ───────────────────────────
   *
   * Hosted (docs/BOOKFORGE-HANDOFF.md §8), the window is one BookForge opened
   * over books it owns: the library folder is its data directory and the book
   * list is its own page. So the controls that would answer those questions a
   * second time go — the library-location setting, whose refusal main enforces
   * anyway (`library:set`), and eventually Home. NOTHING ELSE. This is not a
   * feature flag and there is no hosted EDITING mode: the proof sheet, the
   * ledger, the queue and every door behind them are the same app either way,
   * and a second behaviour keyed off this is how the copy stops being mechanical.
   *
   * A PROMISE ASKED ONCE. Mounting happens before the window exists and there is
   * one main process, so the answer cannot change while the page lives.
   */
  hosted(): Promise<boolean>;

  /** The menu's File→Open, callable from the UI too. Resolves to the path, or null. */
  openDocumentDialog(): Promise<string | null>;
  /**
   * A dropped file's path, admitted by main or refused. The renderer cannot read
   * the file either way — this only tells the viewer what it may ask for.
   */
  openPath(candidate: string): Promise<string | null>;
  /**
   * The real path behind a dropped `File`. Electron removed `File.path` in
   * favour of `webUtils.getPathForFile`, and it is the reason a drop needs a
   * preload at all.
   */
  pathForFile(file: File): string;
  /**
   * The whole file, for the app's own pdf.js viewer.
   *
   * The renderer still cannot read a path it names: main answers only for files
   * already in the open allow-list, and rejects by name for anything else — the
   * same `admitted` check everything that serves a document asks.
   */
  documentBytes(absolutePath: string): Promise<Uint8Array>;
  /**
   * Copy an open document to a destination the user picks in main's own save
   * dialog. Returns where it went, or null for a cancel. The source must be in
   * the open allow-list — the dialog authorizes the destination, never the read.
   */
  documentSaveCopy(absolutePath: string, suggestedName: string): Promise<string | null>;
  reveal(target: string): Promise<void>;
  /**
   * The finished shelf row's Save — an OS save dialog over a file in a
   * project's final/ tray, defaulting to Downloads. Answers where the copy
   * went, or null for a cancelled dialog; rejects for a path that is not one
   * of the library's exports.
   */
  saveExport(target: string): Promise<string | null>;
  /**
   * The question asked before a tab with something to lose closes — main's
   * sentences, drawn in the app's own card (`drawQuestions`).
   *
   * ONE QUESTION FOR BOTH REASONS, and that is deliberate rather than
   * economical. This app has already ruled that stacking dialogs about one
   * closing document is wrong (see `closeShowing` in core/documents.service.ts): a person
   * shutting a book should be asked once, about everything that closing it costs,
   * and a second card on top of the first is the app arguing with an answer it
   * already has. Main picks the wording from the flags — "the copy you chose is
   * older than this" and "there is no save of these corrections to come back to"
   * are two different warnings, and a tab can owe both at once.
   *
   * IT WAS THREE. The third was "no copy of this exists anywhere you chose",
   * which was true of every book the app opened out of a project and therefore
   * interrupted people who had lost nothing. See `CloseWarning` for the ruling.
   */
  confirmClose(warning: CloseWarning): Promise<CloseAnswer>;
  /**
   * "Read this book again?" — the cost of a re-read, named before the job exists.
   *
   * MAIN'S QUESTION IN THE APP'S OWN CARD, like every other dialog here. The
   * native box it replaced was defended on this one's own ground — the next thing
   * that happens after a yes is an enqueue, and a question the user can click
   * behind is a question they can answer twice — and the card meets it: it is a
   * full-window scrim at the top of the stack, so the Add button under it takes
   * no clicks while the question is up.
   *
   * THE SENTENCES ARRIVE COMPOSED, which is the one place this differs from
   * `confirmClose`. The facts they are made of live in the ledger, and the
   * renderer is the side already holding a mirror of it (`ledger.service.ts`) —
   * so asking main to name the cost would be an IPC round trip for a decision
   * that is pure and shared. The composition is `reReadAhead` in shared/reread.ts,
   * where it is tested; main owns the shape of the question, the two buttons and
   * what a press of one of them means.
   *
   * True means read it again. Anything else — the other button, a card dismissed
   * with Escape, a card nothing was there to draw — is a no, because the yes
   * spends three hours of GPU and doing nothing is the outcome that is never
   * wrong.
   *
   * ADVISORY, and deliberately so: see `BANK-LIFECYCLE.md` §3.3. The cost is named
   * as of the moment of asking, and the actual replace-or-branch decision is made
   * at landing against the ledger as it stands then.
   */
  confirmReRead(prompt: ReReadPrompt): Promise<boolean>;
  /**
   * "These changes are not applied yet" — asked before Export, Translate,
   * Simplify, a host act or a move to another step runs over a book with a stack
   * waiting on it.
   *
   * THE LIST GREW ON 2026-08-22 and so did the weight of the answers. Owen:
   * *"any action they take, whether it's switching to a different step or
   * narrating or anything at all, should ask if they want to apply changes in a
   * modal. discard/apply changes."* The act crossing this seam is therefore an
   * `UnappliedAct` rather than a `MakeAct`, and the answer is one of two rather
   * than one of three — see `UnappliedAnswer`, which carries the gravestone for
   * the one that went.
   *
   * ── The defect ──────────────────────────────────────────────────────────────
   *
   * A chapter renamed, a paragraph retyped, no second Apply, Export pressed — and
   * the EPUB came out without either, silently (user report, 2026-08-21). Every
   * make-act in this app is arithmetic over the recorded STEPS, and the pane's
   * stack is a delta that has not become one; the book that came out was honest
   * about the ledger and silent about the page in front of the person.
   *
   * MAIN'S QUESTION AND THIS APP'S OWN CARD, on `confirmClose`'s rule and for its
   * reason: the renderer hands over facts it is the only holder of — the count,
   * the book, which act — and main composes, because the one thing the renderer
   * must never do to this dialog is write its own copy.
   *
   * `'cancel'` IS WHAT AN UNANSWERED QUESTION MEANS, and it is now the only
   * answer that changes nothing at all — the other two record a step or destroy
   * a stack. A dismissal must never be read as consent to either.
   */
  confirmUnapplied(warning: UnappliedWarning): Promise<UnappliedAnswer>;

  /**
   * THE APP'S OWN CONFIRMATION CARD, HANDED TO THE BRIDGE ONCE AT STARTUP.
   *
   * ── Why the five questions above did not change shape ───────────────────────
   *
   * Every one of them used to be `ipcRenderer.invoke` and nothing else: main put
   * a native box on the screen and the promise settled with what was pressed. The
   * boxes are gone (the user: "we should have zero js alerts. they should all be
   * custom modals"), and the thing that draws the replacement is an Angular
   * component in the renderer — which the bridge cannot reach and must not try
   * to.
   *
   * So the drawing is handed IN. `ConfirmService` registers the card here as the
   * app starts, and the five calls above keep their exact signatures: they ask
   * main for the composed question, hand it to whatever was registered, and
   * resolve with the answer's own word. Not one caller beyond this file changed —
   * the OCR dialog still awaits a boolean, `questionBefore` still awaits a
   * `CloseAnswer` — which is the property this indirection exists to buy.
   *
   * REGISTERED ONCE AND NOT UNREGISTERED. The card is mounted for the whole life
   * of the window (see `ConfirmDialogComponent`), so there is no moment where it
   * is right for a question to go somewhere else.
   *
   * WITH NOTHING REGISTERED, A QUESTION IS NOT ASKED AND THEREFORE NOT AGREED TO.
   * Every one of the five resolves with its own safe answer — keep the tab, undo
   * the edit, leave the reading alone — because a renderer that cannot draw a
   * card cannot have been answered, and the alternative is spending hours of GPU
   * on somebody's behalf.
   */
  drawQuestions(draw: (question: AppQuestion) => Promise<QuestionAnswer>): void;

  /**
   * A document's own record — the OPF's Dublin Core fields, or the PDF's Info
   * dictionary — read and written through `foundry epub-meta` / `pdf-meta`.
   *
   * NEITHER OF THESE MOVES A FILE. `project.json` holds `title` and `stem` as
   * two fields precisely so that a book's NAME and its FILENAMES are decoupled:
   * correcting a title changes the metadata, and the paths stay exactly where
   * they are, because they are in recents, in whatever else the user has
   * pointed at them, and in a sync client's index.
   *
   * Reading and writing are one pair rather than four calls because the dialog
   * does both against the same document, and because a patch with no fields in
   * it is a read.
   */
  meta: {
    /** The working PDF, by the path this app already has open. Refused for any other. */
    readPdf(filePath: string): Promise<MetadataOutcome>;
    writePdf(filePath: string, patch: Partial<PdfMetadataFields>): Promise<MetadataWriteOutcome>;
    /**
     * A FINISHED EXPORT in a project's `final/` tray, by its own path. Refused
     * for any other file, INCLUDING an EPUB the user imported.
     *
     * The asymmetry with the PDF pair is the asymmetry between the two documents.
     * A scan is what this app was given and keeps working from; an exported book
     * is what it made, out of a bank, and can make again. So the container is
     * safe to rewrite — and the write's other half, the metadata step, is what
     * puts the correction on the NEXT cast, which is the only reason the edit
     * outlives the one file in front of the person making it.
     */
    readEpub(filePath: string): Promise<MetadataOutcome>;
    writeEpub(filePath: string, patch: Partial<EpubMetadataFields>): Promise<MetadataWriteOutcome>;
  };

  /**
   * The managed workspace: where a conversion writes.
   *
   * A job never asks the user where to put anything — a plan hands the dialog
   * the paths a job needs, and they land inside the PROJECT for the document
   * being converted (`<libraryDir>/projects/<key>/`).
   *
   * THERE WERE FOUR PLANS HERE AND THERE ARE THREE. `plan` composed a Generate
   * — a rendering into `generated/` that a person asked for by file format —
   * and both the button and the product are gone: the workbench reads the book
   * file, so nothing needs a cast EPUB (docs/RENDERER.md §7).
   */
  workspace: {
    /**
     * Where an OCR job's answers go. No output file: the BANK is the product.
     *
     * Separate from `plan` below because a reading has no format and therefore
     * no output name to compose, and because `plan` rotates the `generated/`
     * file its rendering is about to replace — which a reading has no business
     * doing, since it writes nothing there.
     *
     * IT TAKES WHAT THE FORM ASKED, and that is not a convenience. Which bank
     * this run fills depends on whether it is the same question a reading of
     * this book already answered — same pages, same language, so a replace
     * aimed at that step's own file — or a different one, which branches and
     * gets a bank of its own. Main decides that here and hands back the path
     * AND the step id it belongs to; the request carries both onward.
     */
    planReading(inputPath: string, asked?: ReadAsk): Promise<ReadingPlan>;
    /**
     * The same rendering, aimed at `final/` — where a TERMINAL document goes.
     *
     * ── Why this is a second plan and not a flag on the one above ───────────────
     *
     * The two compose from the same machinery and differ in one field, which is
     * exactly the argument for one function with an argument — and the argument
     * against is what the two plans DO on the way. `plan` reserves a slot in
     * `generated/`: it refuses when the book it would replace is open in a tab,
     * because a rotation there moves a working tree out from under a reader. An
     * export replaces nothing anybody is working from — `final/` is the tray, not
     * the workshop — so it asks none of that, and a caller that had to remember to
     * pass the right flag to skip a refusal is a caller that will one day pass the
     * wrong one.
     *
     * EVERYTHING ELSE IS IDENTICAL, deliberately: the same completed-bank refusal
     * said in the same words, the same curation resolved from the same position,
     * and the same translation's words put into the blocks when the position
     * stands under one — so exporting the Hungarian from a save made under it
     * produces the Hungarian with that save's cuts applied, which is the whole
     * promise of making a product from a row. The answer is a `WorkspacePlan` like
     * any other; only `outputPath` says where it landed.
     *
     * The caller sets `GenerateRequest.export` on the request it builds from this.
     * That flag is what the queue's landing reads, and it is the renderer's to set
     * because the renderer is what knows which of the two buttons was pressed.
     */
    planExport(inputPath: string, kind: ConversionKind): Promise<WorkspacePlan>;
    /**
     * Where a translation of this book goes — which is a RECORDS FILE beside the
     * reading it was taken of, `readings/<key>.<lang>[.<id8>].records.jsonl`, and
     * no book at all.
     *
     * The run writes one row per flowing block, keyed by that block's own position
     * in the reading bank, and the translated book is CAST from those rows
     * afterwards by the same `vlm-convert` that assembles every other book here.
     * So there is no output EPUB in this answer, and no separate bank: the records
     * file is its own cache, which is why the engine refuses `--bank` beside it.
     *
     * Separate from `plan` because it answers a different question — there is no
     * format to choose and no `generated/` predecessor to rotate, and the language
     * rather than a format decides the name.
     *
     * IT MAY ALSO ANSWER WITH A CHAIN, and a chain is now a fact about the BOOK
     * it answers with. Standing under a translation, `bookPath` is that row's own
     * derived book — the words already in its language — and `from` is the
     * language the ledger recorded for it: the user's *"german to english to
     * hungarian"*, with no second file to point at. Composed by main off the
     * ledger, never by this window: a source language taken from a mirror is a
     * prompt that can be told the wrong thing about what it is holding.
     *
     * IT ANSWERS WITH THE BOOK THE JOB READS. `bookPath` is the position
     * materialised — every applied change replayed in — and it is what the run is
     * handed. `inputPath` comes back too and is the job's identity rather than its
     * input: main admitted it, the queue re-checks it, and the settle names it.
     * Use both verbatim; neither is a path this window may compose.
     */
    planTranslation(
      inputPath: string,
      targetLanguage: string,
    ): Promise<TranslationPlan & { inputPath: string }>;
    /**
     * Where a SIMPLIFICATION of this book goes — the same answer as above, about a
     * run that says the book again in the language it is already in.
     *
     * THE SAME PLAN SHAPE BECAUSE IT IS THE SAME JOB. A rewrite is the translate
     * pipeline with one word changed on the command line, so it writes the same
     * kind of records file, is named after the same kind of step, seeds from the
     * same kind of sibling and is cast into a book the same way. The caller builds
     * a `TranslateRequest` from this and adds `rewrite` itself, which is the only
     * field this window contributes that the plan does not.
     *
     * THERE IS NO LANGUAGE TO PASS, AND THAT IS THE INTERESTING PART. A rewrite
     * happens IN a language rather than into one, so main resolves it — the
     * translation the position stands under, or failing that the language the
     * reading declared — and hands it back as `from`. The caller puts that same
     * value in the request's `to`: both ends of a rewrite are one fact, and a
     * window that composed them separately could tell the model it was holding
     * something else.
     */
    planSimplification(
      inputPath: string,
      mode: RewriteMode,
    ): Promise<TranslationPlan & { inputPath: string }>;
  };

  /**
   * The step ledger — everything that has been done to one book, and where the
   * user is standing in it.
   *
   * ── What this surface is, in one paragraph ────────────────────────────────
   *
   * Every project carries a list of STEPS: the import, each reading, each frozen
   * curation, each translation. Each one is the retained payload of one action and
   * records which step it was made FROM, so the structure is a tree — but the UI
   * is a flat chronological list, like Photoshop's History panel, with one quiet
   * "from Read" annotation on the rows where the chain jumps. DO NOT BUILD A TREE
   * UI. A position pointer marks where the user is standing; clicking a row moves
   * it, and acting from an earlier row APPENDS rather than truncating, which is
   * the one thing Photoshop does that this must never do.
   *
   * ── Why every one of these is a main-process call ─────────────────────────
   *
   * The renderer names a project directory and nothing else, exactly as it names a
   * PDF for `document:read-bytes`. Where the payloads are, what a delete would
   * destroy, what a step costs to lose and whether a path is a project at all are
   * main's own records — and `delete` UNLINKS FILES, so a renderer's word about a
   * directory cannot be an authorization (the `admitted` precedent). Main proves
   * the directory is one of Home's projects on every call in this family, not only
   * the destructive one: a gate that guards only the delete is a gate somebody
   * routes around by reading first.
   *
   * ── And why the ordering never crosses the boundary ───────────────────────
   *
   * EVERY ONE OF THESE ANSWERS WITH THE ROWS ALREADY COMPOSED. The chronological
   * order and the "from …" annotation are the whole of this design's concession to
   * the tree, and a renderer deriving them would be a second implementation of the
   * one rule that decides whether the flat list is misleading about what was made
   * from what. Three of these used to hand back a bare ledger, which left the
   * renderer making a second `read` after every pointer move and every delete —
   * two round trips for one gesture, and the second answer describes a catalogue a
   * moment later than the first.
   */
  ledger: {
    /**
     * One project's steps, plus the flat list the library draws.
     *
     * NULL when the project no longer exists. The window re-reads every held
     * ledger on `projects:changed`, and a delete is one — so the guaranteed
     * first reader of a deleted project is this call, asked by a mirror that
     * has not heard yet. Null means "drop the holding and stop asking"; it is
     * never the answer for a project that is merely unreadable.
     *
     * REJECTS for a catalogue that exists but will not parse, including one
     * whose stored ledger is malformed — a project in that state is already
     * listed on Home with the reason on its row, and this is the same refusal
     * reaching the same strip.
     */
    read(projectDir: string): Promise<StepLedgerView | null>;
    /**
     * Stand on a different step. Answers with the ledger and rows as they now
     * stand — the same rows, since a pointer move changes no step and no order.
     *
     * FREE, INSTANT AND UNCONFIRMED — one line of the manifest, no job, no
     * rendering, no file written. That is the promise every history panel makes
     * by looking like one, and it is kept here: what changes is which state the
     * viewers show and which step the next action is made from.
     *
     * Rejects by name for a step id this project does not hold. The caller is
     * clicking a row main drew, so an unknown id means the two are looking at
     * different ledgers, and standing somewhere plausible instead would show
     * somebody a book they did not ask for.
     */
    go(projectDir: string, stepId: string): Promise<StepLedgerView>;
    /**
     * Stand on whichever step this document belongs to. Answers exactly as `go`
     * does, and answers with the ledger UNCHANGED when the document belongs to no
     * step or to the one already stood on.
     *
     * ── The gesture it exists for ─────────────────────────────────────────────
     *
     * There is ONE selection: clicking a row in the library moves the position,
     * and focusing a document moves it back, so the pointer and the pane can never
     * describe two different things. Without it a person reads the book, clicks
     * Translate, and translates the scan — because the pointer was still on the
     * import while the right document was on screen, and nothing on the surface
     * said so.
     *
     * ── Why the renderer names a file and not a step ──────────────────────────
     *
     * Because a tab holds a path and nothing else, and turning a path into a step
     * means knowing which reading cast the book in `generated/`, which working
     * copy is the scan rather than a reprint, and which of a chain's rows is the
     * one you can still act from. Those are main's records — the same ones
     * `documentAt` reads in the other direction, resolved in the same place so the
     * two cannot come to disagree.
     *
     * FREE AND SILENT WHERE NOTHING MOVES. This runs on every focus gesture, and
     * the answer is nearly always the row already stood on; no manifest is
     * rewritten in that case. An export never moves the position at all — exports
     * are terminal, nothing is made from one, and looking at one is not a step.
     *
     * Rejects only for a directory that is not a project or a catalogue that will
     * not parse, like everything else here. A path belonging to no step is an
     * ordinary answer, not a refusal.
     */
    standFor(projectDir: string, filePath: string): Promise<StepLedgerView>;
    /**
     * WHICH DOCUMENT BELONGS ON SCREEN AT THIS PROJECT'S POSITION — absolute, or
     * null when the position names no document of its own.
     *
     * ── Why the renderer asks rather than works it out ──────────────────────
     *
     * Every path in a project is a path main composes. A renderer that built
     * `working/<stem>.pdf` for itself would be a second opinion about a question
     * the ledger has already answered, and the way that opinion is wrong is that a
     * branch read answers with the original reading's file. Main also has to admit
     * the answer to the viewer's allow-list before handing it over, which is not
     * something a renderer can do for itself and must not be.
     *
     * NULL IS ORDINARY AND MEANS "KEEP WHAT YOU HAVE": a project with no reading
     * yet, a payload that has been swept, a position that is simply about the
     * document already on screen. It is never a refusal, and the caller must not
     * put a sentence on the strip about it — clicking a row is an instruction to
     * look at that step, and the app's answer to "I have nowhere to show it" is to
     * put it somewhere rather than to explain.
     *
     * Rejects only for a catalogue that will not parse, like everything else here.
     */
    documentAt(projectDir: string): Promise<string | null>;
    /**
     * THE SAME QUESTION ABOUT A ROW NOBODY IS STANDING ON — Compare's resolve.
     *
     * A comparison locks a second, read-only column to a step the person picked
     * out of their own history, and the pointer is somewhere else by definition —
     * that is what comparing means — so `documentAt` above cannot answer for it.
     * Where the row's picture is the proof sheet this answers null and the column
     * asks `book.loadAt` instead; where it is a FILE (the import, a rendering) this
     * is the path, admitted to the viewer's allow-list on the way out exactly as
     * `documentAt` admits its own.
     *
     * NULL IS ORDINARY AND MEANS TWO THINGS AT ONCE, deliberately: this row shows
     * no file of its own, or the step has been deleted since the picker was drawn.
     * The caller wants the same thing from both — draw the sheet, which says its
     * own sentence if the step has gone — so telling them apart would be two empty
     * states for one absence.
     */
    documentAtStep(projectDir: string, stepId: string): Promise<string | null>;
    /**
     * What deleting this step would take — the facts for the confirm card.
     *
     * EVERY CASUALTY, NAMED, WITH ITS OWN COST SENTENCE. A delete cascades: a
     * reading's translations were made from that reading and have nowhere to
     * hang, so they go with it. That was the ruling, and what makes it safe is
     * that the user reads the list first — which is what this is for.
     *
     * The sentences are composed in main, from the retention rule, in the words
     * every other warning in this app uses for the same loss. An "Are you sure?"
     * over a list of four teaches people to click through the one that was about
     * their curation.
     *
     * IT ALSO PROVES THE DELETE IS ALLOWED, so a card is never put on screen for
     * something the delete would refuse a click later. The origin rejects here:
     * deleting the import is deleting the project, and `projects.delete` does
     * that with its own ceremony. So does a book this window still has open,
     * which is why the answer carries `files` — the caller closes those tabs
     * between the yes and the delete, exactly as the document delete does.
     */
    describeDelete(projectDir: string, stepId: string): Promise<StepDeletion>;
    /**
     * Do it: the step and its whole subtree off the ledger, their payloads off
     * the disk. Answers with the ledger and the rows that are left.
     *
     * ASKING IS THE CALLER'S JOB; PROVING IS STILL MAIN'S. This runs the same
     * refusals `describeDelete` ran, because a renderer that skipped the question
     * must meet the same answer — including the origin's, which rejects by name,
     * and the open book's, which does not lift until the tab is closed.
     *
     * IT TAKES THE PAYLOAD'S BELONGINGS TOO — the working tree unpacked from it,
     * the undo ledgers named after that tree, the versions earlier runs rotated
     * aside. A delete that left those behind left a directory of somebody's markup
     * that nothing in the app could ever reach again.
     *
     * It really deletes. Nothing is rotated aside and there is no copy anywhere
     * else; a payload that survives is one another step still names.
     */
    delete(projectDir: string, stepId: string): Promise<StepLedgerView>;
  };

  /**
   * THE BOOK — the one document this app edits, as the renderer draws it.
   *
   * ── Why a project directory and not a file ────────────────────────────────
   *
   * Because the renderer has no business knowing which file the book is in.
   * Which bank a position's reading left, where the reflow of that bank lives,
   * and whether it has been made yet are all main's records — the same records
   * `ledger.documentAt` reads one door up, resolved in the same place so the two
   * cannot come to disagree. A renderer that composed the path would be a second
   * opinion about which of two readings a branch is about, which is the failure
   * `readingBank` (electron/projects.ts) exists to end.
   *
   * ── It can be slow exactly once, and the sheet says so ────────────────────
   *
   * A project whose bank has never been reflowed has its book file MADE on this
   * call — main spawns the engine and waits — which doubles as the migration for
   * every project in the library, since they all predate the format
   * (docs/RENDERER.md §9, R2). It is seconds of arithmetic over a file that is
   * already on disk, it happens once per reading, and the pane shows
   * `Opening the book…` while it runs.
   *
   * IT ANSWERS WITH A SENTENCE RATHER THAN REJECTING, on this app’s own rule
   * and for its reason: a book that has not been read yet, a bank the engine
   * would not reflow and a file whose grammar this build does not know are all
   * states a person should meet as words on the paper (RENDERER-DESIGN.md §5)
   * rather than as a broken tab. The sentences carry no paths, and the pane
   * renders whichever one comes back verbatim — the alternative to a sentence is
   * an empty sheet that looks exactly like a book with nothing in it.
   *
   * IT DOES REJECT for a directory that is not one of Home's projects, which is
   * the security gate refusing rather than the book being unavailable.
   */
  book: {
    load(projectDir: string): Promise<BookOutcome>;
    /**
     * THE BOOK AS OF A NAMED STEP — the same replay, resolved to a row instead of
     * to the pointer.
     *
     * Compare's read (docs/PLAN.md §4, unit 8d). Everything `load` promises holds:
     * no path crosses in either direction, it may spawn the engine on a library
     * written before the book format existed, and it answers a failure as a
     * sentence the sheet draws rather than rejecting one. A step id this project
     * no longer holds is one of those sentences, because a delete can land between
     * the picker being drawn and this being asked.
     */
    loadAt(projectDir: string, stepId: string): Promise<BookOutcome>;
    /**
     * THE STACK, WRITTEN DOWN — one Apply, one step, one file of ops.
     *
     * ── What the renderer is handing over ─────────────────────────────────────
     *
     * Everything on the pane's in-memory stack, in the order it was made: a
     * DELTA against the book at the position the person is standing on, not a
     * cumulative statement about the book (docs/RENDERER.md §3). Undo has already
     * happened here — a popped op never reaches this call — so the list is
     * exactly what somebody meant to keep.
     *
     * MAIN WRITES THE FILE BEFORE IT WRITES THE STEP, atomically, so a row naming
     * a payload that failed to write is not a state this app can construct. The
     * step lands as a CHILD OF THE POSITION, which is what makes editing from an
     * older row a branch rather than an argument — the tree already draws
     * branches — and the pointer follows onto it, because the ops reach the paper
     * only through the chain from where you stand (`RETAINED_BESIDE_YOU`,
     * shared/ledger.ts).
     *
     * ── And the answer is the whole history back ──────────────────────────────
     *
     * `recordCuration`'s shape and its reason: main hands back the ledger AND the
     * rows it composed for it, so the gesture and what is on screen are one
     * statement rather than a paint followed by a round trip that describes a
     * catalogue a moment later. The pane clears its stack on this answer; the ops
     * come back as chain ops on the reload the pointer move triggers.
     *
     * IT REJECTS rather than answering a sentence, unlike `load`. Every way this
     * fails — a directory that is not a project, a book with no history to hang a
     * step off, a disk that would not take the file — is a state where the
     * person's changes are still on the stack in front of them and the honest
     * thing is a refusal they can act on, not a sheet quietly redrawn as though
     * nothing had been pressed.
     */
    apply(projectDir: string, ops: readonly BookOp[]): Promise<StepLedgerView>;
    /**
     * Rewrite the tip edit step's own file to this list — the consolidating
     * Apply. Refuses (rejects) when the position is no longer an amendable tip;
     * the pane shows the sentence and the person presses Apply again, which
     * lands a step of its own. See amendBookOps, electron/book.ts.
     */
    amend(projectDir: string, ops: readonly BookOp[]): Promise<StepLedgerView>;
    /**
     * A finished export in this library's tray, exploded and answered in
     * book:load's own shape, read-only — ops empty, tip null, no translation
     * pair. Refusals are sentences in the outcome, never rejections.
     */
    view(target: string): Promise<BookOutcome>;
    /**
     * ONE CORRECTED PARAGRAPH ON A TRANSLATED POSITION — the words, to the
     * records, and never onto the ops chain.
     *
     * *"Translated edits are per-language record corrections."* (docs/RENDERER.md
     * §5.) Everything else the pane can do to a translated book is an ordinary op
     * and goes through `apply` above: striking a paragraph, relabelling it,
     * joining two, cutting one, moving a division. The WORDS are the one thing
     * that is not the ops chain's to hold, because they are the translate step's
     * payload — a `text` op over a translated block would put the person's
     * sentence in the chain while the records still held the machine's, and every
     * later materialisation of that book would answer with the machine's.
     *
     * `id` IS A BLOCK ID OF THE BOOK FILE, and main proves it is one before a byte
     * moves: the halves of a cut that has not been applied yet are ids the pane
     * holds and the file has never had, and a record filed under one of those is a
     * row nothing will ever read back (`correctBookBlock`, electron/book.ts).
     *
     * IT ANSWERS WITH THE WHOLE BOOK, already remade. A correction leaves the
     * derived book file stale until main materialises it again, so the call that
     * appends the row is the call that rebuilds it and hands back what the pane
     * should now be drawing — one question, one answer, on `load`'s own rule.
     *
     * IT REJECTS rather than answering a sentence, on `apply`'s rule: the words
     * are in front of the person, and a refusal is a thing they can act on.
     */
    correct(projectDir: string, id: string, text: string): Promise<BookOutcome>;
    /**
     * ── THE WORKING STACK, ON DISK — three doors that are not history ──────────
     *
     * `apply` and `amend` above write a STEP. These write the thing that has not
     * become one yet, so that a window closing, a crash or a glance at another tab
     * can never be the reason somebody's unapplied afternoon is gone (Owen's
     * reversal of "closing without applying scraps it", 2026-08-22). Nothing in
     * the ledger mentions this file, no replay reads it, and every book in this
     * app draws identically whether it exists or not.
     *
     * `pendingSave` IS CALLED ON A DEBOUNCE, from the stacks registry, exactly as
     * the light table's recipe is written (`CaptureService`). A stack with nothing
     * waiting CLEARS rather than writing an empty file: "changed back to nothing"
     * is one of the changes it is called for.
     *
     * `pendingRead` REFUSES OUT LOUD RATHER THAN ADOPTING. A stack made at another
     * step is a delta against a book the person is no longer looking at, and
     * replaying it here would apply their strikes to a document they made no
     * decision about — so the outcome carries a sentence and a count, and the pane
     * says what was let go. Its refusals name the file, which is the standing
     * exception to this app's no-filenames rule: the one useful thing about a file
     * that will not read is where it is.
     *
     * `pendingClear` HAS TWO CALLERS AND BOTH ARE A PERSON SPEAKING — an Apply,
     * which has just recorded every one of these decisions, and the closing card's
     * Discard. There is deliberately no third.
     */
    pendingSave(projectDir: string, stack: PendingStack): Promise<void>;
    pendingRead(projectDir: string): Promise<PendingOutcome>;
    pendingClear(projectDir: string): Promise<void>;
  };

  /**
   * The library folder — where conversions land and where the pickers open.
   *
   * Changing it affects NEW work only: nothing is migrated, and recents keep
   * the absolute paths they were recorded with.
   */
  library: {
    dir(): Promise<string>;
    /** The directory picker. Chooses without saving; `set` is the commit. */
    choose(current: string): Promise<string | null>;
    set(dir: string): Promise<string>;
  };

  /**
   * Home's primary listing: one row per BOOK, expanding to the documents in it.
   *
   * Read off the library's `projects/` directory every time rather than mirrored
   * — a project gains an output when a three-hour conversion lands, and a cached
   * list would be a list from before the thing the user is waiting for.
   */
  projects: {
    list(): Promise<ProjectSummary[]>;
    /**
     * The library changed — a project made, a reading landed, an output
     * recorded. Returns its own unsubscribe.
     *
     * NO PAYLOAD, deliberately. Composing the listing is a directory walk and
     * main does not do one on the chance that somebody is looking; this says
     * only that something moved, and the mirror asks for the list.
     *
     * IT EXISTS BECAUSE A DROPPED FILE HAD NO OTHER WAY TO ANNOUNCE ITSELF. The
     * import that turns somebody's scan into a project runs in the background,
     * behind the tab that already opened, and the renderer's project list used
     * to re-read only on three occasions that a background import is not one of.
     * So the app went on saying a book was not in the library while its folder
     * sat on the disk — and every question asked of "the project this document
     * is in" was answered from that.
     */
    onChanged(listener: () => void): () => void;
    /**
     * What deleting this project would destroy, in sentences worth reading.
     *
     * THE QUESTION MOVED TO THE RENDERER AND THE FACTS DID NOT. Main used to ask
     * in a native message box; the app asks in its own modal now, and this is
     * what it asks WITH — the size on disk, the readings bank's page count, the
     * filed copy, the flat statement that nothing comes back. Main is the only
     * side that can know any of it.
     *
     * It also PROVES the delete is currently allowed, so the app never puts a
     * warning on screen for something it would refuse a click later. A refusal —
     * a book from the project open in a tab, a job queued to write into it —
     * rejects with the reason.
     */
    describe(dir: string): Promise<DeletionPrompt>;
    /**
     * Erase one project's whole directory — archive, generated, working, final,
     * readings, history — from the disk. It really deletes; nothing is rotated
     * aside and there is no copy anywhere else.
     *
     * ASKING IS THE CALLER'S JOB NOW; PROVING IS STILL MAIN'S. This runs the
     * same refusals `describe` ran, because a renderer that skipped the question
     * must meet the same answer — the checks live in the call that erases rather
     * than in the one that asks. It names a directory and main decides, the same
     * way it does for everything else it is handed a path for.
     *
     * Resolves to the sentence for the notice strip once the folder is gone. A
     * refusal REJECTS with the reason.
     */
    delete(dir: string): Promise<string>;
  };

  /**
   * One document inside a project — the file, and its row in the catalogue.
   *
   * A NARROWER DOOR THAN `projects`, deliberately. Main refuses any path that is
   * not strictly inside `<library>/projects/<project>/`, so a renderer cannot
   * name an arbitrary file and have it unlinked; and it refuses the project's
   * ORIGINAL outright, because deleting that is deleting the project and there
   * is a separate call for that with a separate warning.
   */
  documents: {
    /**
     * What deleting this document would do — and whether it is the original.
     *
     * `original: true` means the prompt describes the PROJECT: every other
     * document in the folder was made from this file, so there is no version of
     * removing it that leaves a project behind. The caller is expected to run
     * `projects.delete` on `projectDir` instead.
     */
    describe(filePath: string): Promise<DocumentDeletion>;
    /**
     * Remove the file and its catalogue row. Resolves to the notice sentence.
     *
     * A file that is already MISSING is still removable: its row is the only
     * thing left of it, and refusing on the grounds that the bytes are gone
     * would leave a listing nobody can clean.
     */
    delete(filePath: string): Promise<string>;
  };

  /**
   * The individual documents that have been opened, newest first.
   *
   * Still the app's own userData, never the engine's settings. Home lists
   * PROJECTS now and reads this only through main, which uses it to answer "when
   * was anything in this project last opened" — a fact a folder on disk does not
   * carry.
   */
  recents: {
    list(): Promise<RecentDocument[]>;
    forget(filePath: string): Promise<RecentDocument[]>;
    clear(): Promise<RecentDocument[]>;
  };

  queue: {
    list(): Promise<Job[]>;
    enqueue(request: JobRequest): Promise<Job>;
    /** The same queue and the same GPU lane, a different command. See `TranslateRequest`. */
    enqueueTranslate(request: TranslateRequest): Promise<Job>;
    /**
     * Run an EXPORT now, and answer when it is over — the Export dialog's door.
     *
     * The invoke stays open for the seconds the run takes and resolves with the
     * row as it SETTLED: `done` and the file is filed, `failed` and `error`
     * carries the engine's own words, `cancelled` and somebody stopped it. A
     * still-pending state means something is already writing the same file and
     * that existing row was handed back instead — the caller's "already being
     * made". Nothing lingers in the queue afterwards: the row leaves the list
     * at the settle, because this dialog is the surface that reports the
     * outcome (`runNow`, electron/job-queue.ts).
     *
     * A `read` request is refused by name — hours of GPU never run under a
     * dialog's spinner. Readings and translations keep the held queue.
     */
    run(request: JobRequest): Promise<Job>;
    /**
     * Release everything currently HELD, in order. Answers with how many.
     *
     * Both engine enqueues above return a job that is held and idle, so this is
     * the call that makes anything happen. A job added after this returns is
     * held again and waits for the next press (electron/job-queue.ts).
     */
    start(): Promise<number>;
    /**
     * Take a held or queued row out of the list entirely.
     *
     * Not `cancel`: a job that never started has nothing to stop and leaves no
     * record worth keeping, and a `cancelled` row for it is residue in a shelf
     * somebody is using to assemble a batch. Refused on a running job, which is
     * what `cancel` is for.
     */
    remove(id: string): Promise<void>;
    cancel(id: string): Promise<void>;
    clearFinished(): Promise<void>;
    /** Every change, whole list. Returns its own unsubscribe. */
    onChanged(listener: (jobs: Job[]) => void): () => void;
  };

  /**
   * THE HOST-OPERATIONS SOCKET, from the renderer's side — what somebody else's
   * application has contributed to this app's provenance tree.
   *
   * ── The doors, and why the renderer needs each of them ─────────────────────
   *
   * `offers` IS THE FIRST PAINT AND `onOffersChanged` IS EVERY REVISION AFTER
   * IT. It was asked ONCE, like `hosted()`, on the reasoning that a host
   * registers its operations at mount and nothing can change them while the
   * process lives — and that conflated a fact ASKED once with a fact that CANNOT
   * change. A host whose own form legitimately moves while the window is up (a
   * voice installed since, a setting changed since, an act it can no longer
   * honour) had no way to publish it, and a subscription that never fires for
   * every host that never revises costs nothing. `nodes` is the first paint — a window
   * that opened after the host had already pushed has to be able to catch up —
   * and `onChanged` is every push after that, carrying the whole set for one
   * project on `queue.onChanged`'s precedent.
   *
   * `invoke` NAMES AN OPERATION BY ID AND A NODE BY ID, and that pair is the
   * entire request: main turns the operation id back into the host's own function
   * (a renderer can only name something the host registered), and the node id is
   * what the user pressed "from here" on — a ledger step when the act was ordered
   * from something this app made, one of the host's own nodes when it was chained
   * onto work that has not finished yet.
   *
   * `status` IS THE ONE THAT IS NOT ABOUT A BOOK. The three above describe work
   * ordered from a row and land on that row; the status describes the host's own
   * queue and lands in the window's top corner, once, whichever book is open.
   * Same three shapes as everything else here — a read for the first paint, a
   * push for every change, an invoke for the click — so nothing about it is a
   * new kind of thing to learn.
   *
   * STANDALONE IT IS TWO EMPTY LISTS, A NULL AND A DOOR NOBODY OPENS, which is
   * why the tree needs no branch for "is this app hosted": there is nothing to
   * offer and nothing to draw, so it draws what it always drew.
   */
  hostOps: {
    /**
     * Everything the host has on offer as of now — its operations, and whether a
     * failed node's Retry and Dismiss have anywhere to go.
     *
     * ONE ANSWER FOR ONE QUESTION. Both halves are facts about the same
     * registration, so asking them separately would be two round trips that could
     * disagree. Standalone the operations are empty and `nodeActions` is false,
     * which is the tree drawing exactly what it drew before the socket existed.
     *
     * IT IS A FIRST PAINT AND NOT A FINAL ANSWER — see `onOffersChanged`, and
     * note that the two carry ONE type so that a seeded answer and a pushed one
     * cannot be different shapes of the same fact.
     */
    offers(): Promise<HostOffers>;
    /**
     * Retry or dismiss a host node that FAILED — the pair the tree draws on a
     * failed card, and only when `offers().nodeActions` said somebody is
     * listening.
     *
     * FOUNDRY CHANGES NOTHING ITSELF: a retry is the host's queue running the work
     * again, a dismiss is the host's queue forgetting it, and what reaches this
     * window either way is the next push of that project's nodes.
     *
     * REJECTS WITH THE HOST'S OWN SENTENCE, on `invoke`'s rule — this is a button,
     * and the tree says what the host said where the button was.
     */
    nodeAction(projectDir: string, nodeId: string, action: HostNodeAction): Promise<void>;
    /** This project's host nodes as they now stand. Empty is the ordinary answer. */
    nodes(projectDir: string): Promise<HostNode[]>;
    /**
     * Run one of the host's acts, from a node in the tree.
     *
     * REJECTS WITH THE HOST'S OWN SENTENCE when the host's handler throws —
     * deliberately not swallowed anywhere along the way, because this is a
     * button somebody pressed and the alternative is a button that appears to
     * do nothing.
     */
    invoke(
      operationId: string,
      projectDir: string,
      nodeId: string,
      /**
       * THE ANSWERS TO THE OPERATION'S OWN FORM, keyed by each field's `key`, and
       * `{}` for an operation that declared none.
       *
       * Foundry draws the form from `HostOperationOffer.form` and passes what was
       * chosen back untouched — it validates nothing in here and understands
       * none of it, which is what keeps this window host-agnostic (see
       * `HostOpField`). An operation with no form invokes the instant it is
       * pressed and still sends `{}`, so the host is never handed `undefined` for
       * a record it is entitled to read.
       */
      settings: Record<string, unknown>,
    ): Promise<void>;
    /** Every push, whole set, one project. Returns its own unsubscribe. */
    onChanged(listener: (pushed: HostNodes) => void): () => void;
    /**
     * THE HOST REVISED WHAT IT OFFERS — the whole answer again, replacing what
     * `offers` said.
     *
     * The same shape the read answers, on purpose: what the host publishes is
     * "here is everything I offer now", never a delta, so a renderer holding it
     * replaces both halves and has nothing to reconcile. Fires only for a host
     * that calls `setHostOperations` (electron/mount.ts) — standalone, and for
     * every host that declares its acts once at mount, this never fires and
     * nothing about the window changes.
     *
     * IT RACES THE READ, and the subscriber is responsible for that: arm this
     * BEFORE asking, and let a push that has already arrived win over an answer
     * composed before it. `onStatusChanged` carries the same warning for the same
     * reason (`HostOpsService`, which is where both guards live).
     */
    onOffersChanged(listener: (pushed: HostOffers) => void): () => void;
    /**
     * WHAT THE HOST IS DOING RIGHT NOW, and whether the chip may be pressed.
     *
     * The first paint of the chrome's chip, for a window that opened after the
     * host had already pushed. `null` is the ordinary answer — standalone
     * always, and hosted until the host has something to say — and it means the
     * chip is not drawn at all rather than drawn empty (`HostStatus`,
     * shared/host-ops.ts).
     *
     * `openable` IS THE PROBE THE AFFORDANCE IS DRAWN BY. True only where the
     * host registered `FoundryHost.onStatusOpen`; false leaves the chip a
     * readout, with no cursor, no hover and no press — because a chip that
     * looked pressable and did nothing is the outcome this socket must not have.
     * It rides on this answer rather than on a door of its own for
     * `offers().nodeActions`' reason exactly.
     */
    status(): Promise<{ status: HostStatus | null; openable: boolean }>;
    /** Every push of it, whole value. Null clears the chip. Returns its own unsubscribe. */
    onStatusChanged(listener: (pushed: HostStatus | null) => void): () => void;
    /**
     * The chip was clicked — ask the host to open whatever it thinks this is
     * about. Sent only when `status().openable` said somebody is listening;
     * rejects by name otherwise.
     */
    openStatus(): Promise<void>;
  };

  engineInfo(): Promise<EngineInfo>;
  doctor(endpointUrl?: string): Promise<DoctorResult>;
  settings: {
    read(): Promise<SettingsView>;
    write(patch: BackendSettingsPatch): Promise<SettingsView>;
  };

  /**
   * WSL, and the environment vLLM is served from.
   *
   * Facts are re-measured on demand rather than cached in the renderer: a user
   * who installs a distro while the settings screen is open should be able to
   * press the button again and see it.
   */
  wsl: {
    /** Which distros exist, or why there are none. */
    facts(): Promise<WslFacts>;
    /** What one distro can build an environment with. */
    tooling(distro: string): Promise<EnvTooling>;
  };

  /**
   * The prebuilt environments — the ones the conversions were MEASURED with.
   *
   * The app installs what this machine is missing by itself at startup, as rows
   * in the queue shelf; this surface is the manual path for the cases automation
   * cannot decide: a different location, a particular WSL distro, a reinstall.
   */
  env: {
    /** Platform-relevant entries, with installed state measured now. */
    catalog(): Promise<EnvCatalogItem[]>;
    /**
     * Queue an install and return its job id. Resolves as soon as it is
     * QUEUED — the shelf and `onInstallProgress` carry the rest, and a promise
     * held open across a five-gigabyte download is a promise a reload loses.
     */
    install(request: EnvInstallRequest): Promise<string>;
    cancel(): Promise<void>;
    /** A directory for an install, or null. Meaningless for a WSL target. */
    chooseDest(defaultPath: string): Promise<string | null>;
    /** Every phase change, as it happens. Returns its own unsubscribe. */
    onInstallProgress(listener: (progress: EnvInstallProgress) => void): () => void;
  };

  backendSetup: {
    /**
     * Build the environment. Resolves with the outcome; a failure is a result,
     * not a rejection, because every one of them is a sentence to read.
     */
    run(request: SetupRequest): Promise<SetupResult>;
    cancel(): Promise<void>;
    /** Every line, as it happens. Returns its own unsubscribe. */
    onLog(listener: (event: SetupLogEvent) => void): () => void;
  };

  vllmServer: {
    status(): Promise<ServerStatus>;
    /** Rejects with the guest's log tail when it will not start. */
    start(): Promise<ServerStatus>;
    stop(): Promise<ServerStatus>;
    onStatus(listener: (status: ServerStatus) => void): () => void;
    /**
     * Minutes an app-started server outlives a drained queue. 0 — the default
     * — stops it the moment the queue empties; the ceiling is main's
     * (app-settings.ts), so whatever is asked for, an idle server always has a
     * scheduled end. `setKeepWarm` returns the value as clamped and stored.
     */
    keepWarm(): Promise<number>;
    setKeepWarm(minutes: number): Promise<number>;
  };

  /**
   * ── THE CAPTURE STAGE, WHICH IS UPSTREAM OF EVERYTHING ELSE HERE ─────────
   *
   * A project can now arrive as PHOTOGRAPHS (docs/CAPTURE.md): originals copied
   * in and never touched again, a recipe of splits and quads over them, and a
   * mint that assembles an image-only PDF. FROM THE MINTED PDF ONWARD NOTHING
   * IN THIS INTERFACE CHANGES — the read, the book, narrate and export never
   * learn the stage exists.
   *
   * `projectDir` AND NOT `projectId`. docs/CAPTURE.md writes the table rows as
   * `{projectId, …}`; there is no such thing in this codebase, where a project
   * is addressed by its directory and every neighbouring door above takes
   * exactly that. Spelling it the doc's way would put a second name on a thing
   * that already has one.
   *
   * PIXELS CROSS THIS BRIDGE IN ONE DIRECTION ONLY. Working copies and
   * thumbnails are never IPC bytes: they reach the page through the
   * `foundry-file:` door as an img element, allow-listed by the token these
   * calls hand back. What crosses here is the finished page JPEG, renderer to
   * main, one page at a time, so no whole book is ever resident in one heap.
   */
  capture: {
    /**
     * Make an empty capture project and answer with everywhere it lives.
     *
     * THE ONLY DOOR IN THIS APP THAT CREATES A PROJECT WITHOUT A FILE. Every
     * other project is born by importing a document and keyed by the hash of its
     * bytes; photographs have to have somewhere to land before any of them
     * exist, so this one is keyed from a random id and hands back the directory
     * that is now the only handle on it. The recipe and token come back in the
     * same round trip, so the create path never needs a load after it.
     */
    create(title: string): Promise<CaptureCreated>;
    /**
     * Copy the named files in, hash them, decode, read their capture times, and
     * append them to the recipe. Late arrivals inherit the settings of the photo
     * before them — except where the aspect rule refuses the copy.
     *
     * ANSWERS WITH WHAT IT WOULD NOT DO, as well as what it did: a drop that
     * contained files this stage does not read, or photographs this project
     * already holds, must not look identical to a drop that worked.
     */
    intake(projectDir: string, paths: string[]): Promise<CaptureIntaken>;
    /**
     * Where an intake has got to, once per photograph, while it runs.
     *
     * A PUSH BECAUSE THE INVOKE CANNOT SPEAK UNTIL IT IS DONE, and it is not
     * done for the better part of a minute. `env:install-progress` is the
     * precedent and this follows it exactly, down to returning the unsubscribe.
     */
    onIntakeProgress(listener: (progress: CaptureIntakeProgress) => void): () => void;
    /** The recipe, and the door token that makes its pictures loadable. */
    recipeLoad(projectDir: string): Promise<CaptureOpened>;
    /*
     * ── GRAVESTONE: `pagesLoad` (Wave 41) ─────────────────────────────────────
     *
     * The pages a mint made, in reading order, with the token that served them.
     * It took the project and nothing else because the POSITION decided which
     * mint — the same shape `book:load` has, for the same reason.
     *
     * The mint writes a PDF and the minted row opens it through the ordinary
     * document path, so there is no listing for a renderer to ask for.
     */
    /**
     * Take photographs out of the project altogether, and answer with what is
     * left.
     *
     * NOT A STRIKE. A strike leaves a photograph in the project and out of the
     * book; this deletes the recipe entry, the working copy, the thumbnail AND
     * the original, together, so nothing is orphaned. The bank copies go too,
     * which is safe to say because they ARE copies — the dragged-in files still
     * exist where they came from, and the confirm says so with the count.
     *
     * A LIST, NOT ONE ID, because the marquee selects a handful and the person
     * answered one confirm about all of them. One call, one recipe write, one
     * answer. Refused while a mint of this project is running.
     */
    remove(projectDir: string, photoIds: string[]): Promise<CaptureRecipe>;
    /** The whole document, every time. The renderer debounces; this does not. */
    recipeSave(projectDir: string, recipe: CaptureRecipe): Promise<void>;
    /**
     * Open a mint. MAIN COMPUTES THE FINAL LIST — strikes filtered, order
     * applied, sizes decided — and the renderer rasterizes exactly that list.
     */
    mintBegin(projectDir: string): Promise<CaptureMintBegun>;
    /** One rectified page, in the order `mintBegin` listed them. */
    mintPage(mintId: string, index: number, jpeg: ArrayBuffer): Promise<void>;
    /** Write the PDF, append the step, set the archive. Answers with the step. */
    mintCommit(mintId: string): Promise<LedgerStep>;
    /** Give up. Nothing is left behind and no step is appended. */
    mintAbort(mintId: string): Promise<void>;
  };
  onDocumentOpened(listener: (absolutePath: string) => void): () => void;
  /**
   * A document this app opened has MOVED to the copy it actually works on.
   *
   * ── The working-copy model, finally true of the tab as well ────────────────
   *
   * A file from outside the library is imported: copied into `archive/` as the
   * untouched original and again into the live layer, which is what "the PDF"
   * means everywhere else in this app. The tab, though, kept the path the open
   * came in on — because the import is deliberately not awaited (a 400 MB sha256
   * must not sit between a person and their document), so at the moment the tab
   * is made there is nothing else to name.
   *
   * THAT COST A USER THEIR WHOLE PIPELINE. Their scan opened off `E:\\…`, the
   * project was built, the reading ran and landed — and Generate said "this book
   * has not been read yet", because `projectFor(E:\\…)` is null and every
   * question this app asks about the document in front of you is asked of the
   * tab's path. Restarting did not help: it was identity, not staleness.
   *
   * So main says where the document went as soon as it knows, and the tab MOVES
   * — the same tab, not a second one. A document that was already inside a
   * project never fires this, because there is nowhere for it to go.
   */
  onDocumentRelocated(listener: (move: { from: string; to: string }) => void): () => void;
  onNavigate(listener: (route: string) => void): () => void;
  /**
   * A project to stand in, pushed as the window finishes loading — the hosted
   * door onto a book.
   *
   * ── Why a push, and why it carries what it carries ──────────────────────────
   *
   * Hosted, the window is opened FROM something: a book's page in BookForge, on
   * a press of "Edit in Foundry". There is no Home to land on — BookForge's book
   * list is the library — so the window has to come up already standing in the
   * project, and the only side that knows which project that is is the one that
   * opened the window.
   *
   * The payload is exactly what a click on Home's own row carries, and it is
   * resolved by main from `originalOf` (shared/original.ts), the same function
   * that row calls: the project directory, the document opening it opens, and
   * whether Foundry made that document — which is what decides the unsaved dot.
   * One rule, one resolution, two doors onto it.
   *
   * NOT WIRED IN THE RENDERER YET. The contract lands with the mount seam so
   * that BookForge can build against it; the tab this should open is a wave of
   * its own (docs/PLAN.md, Wave 7).
   */
  /*
   * `originalPath` IS NULL FOR A PROJECT WITH NO DOCUMENT, which since the mint
   * stopped writing a PDF means every captured book. The opening is still an
   * opening — what it lands on is the light table — and a null here is the
   * honest way to say "this project has no file to put on screen", where the
   * alternatives were a fabricated path and a door that refused.
   */
  onProjectOpen(
    listener: (project: { dir: string; originalPath: string | null; managed: boolean }) => void,
  ): () => void;
  /** File→Save As / Close Tab, which are accelerators on the menu. */
  onMenuAction(listener: (action: MenuAction) => void): () => void;
  /**
   * The window is about to go — the ✕, Quit, the OS logging out — and every open
   * document gets asked what closing it costs before it does.
   *
   * ── Why quitting has to come back here at all ───────────────────────────────
   *
   * Quit bypassed per-tab closing entirely. The window was destroyed, the tabs
   * went with it, and none of them was ever asked the question the ✕ on a tab
   * asks — which did not matter while the only thing at stake was a file copy the
   * user had already been warned about, and matters now that closing a scan is
   * what turns "undoable" into "permanent". Main cannot ask on its own: it knows
   * which files were ever opened, not which documents are open NOW, and open
   * documents are renderer state.
   *
   * The listener must answer through `letWindowClose` exactly once — false keeps
   * the window, and keeps whatever quit was in progress from happening.
   */
  onWindowClosing(listener: () => void): () => void;
  /** The answer to `onWindowClosing`. True lets the window go. */
  letWindowClose(go: boolean): Promise<void>;
  /**
   * Close this window — the ✕, pressed from inside the page.
   *
   * HOSTED, IT IS WHAT RUNNING OUT OF TABS MEANS. Standalone the last close
   * leaves the workbench standing in its project with Home under that, which is
   * where the app begins; hosted the library is the host's, so an emptied window
   * that fell through to a project picker would be Foundry answering a question
   * BookForge already answers (§8's rule, in the shape it takes at the end of a
   * session rather than the start of one).
   *
   * IT ASKS THE DOCUMENTS ON THE WAY OUT. Main re-enters the ✕'s own path, so
   * `onWindowClosing` is pushed and `letWindowClose` is owed exactly as it would
   * be for a pointer — this is not a way past the question, only another way to
   * ask it. The promise settles when main has heard, not when the window is gone.
   */
  closeWindow(): Promise<void>;
}
