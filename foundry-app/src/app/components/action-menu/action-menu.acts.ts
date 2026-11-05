/**
 * action-menu.acts — what pressing a tile on the rail does.
 */
import { computed } from '@angular/core';
import { exportNodeId } from '@owen/foundry-core/shared/host-ops';
import { hostActAimFrom } from '@owen/foundry-core/shared/stages';
import { fold } from '@owen/foundry-core/shared/original';
import { hosted } from '../../core/foundry';
import { isExportView } from '../../core/documents.service';
import { UnappliedService } from '../../core/unapplied.service';
import type { ActionMenuComponent } from './action-menu.component';

/**
 * THE PRESS ITSELF, aimed and ready — the one fork the tree footer already
 * takes (`open-documents`, the `act.form` branch), taken here through the
 * same two doors so the two surfaces cannot mean different things by one
 * offer. An offer WITH a form opens the host's questions in our card, on the
 * workspace where the card lives; a FORMLESS offer is invoked immediately —
 * the host raises its own window and asks there, so there is nothing to
 * navigate to on this side and nothing irreversible in the click. Errors are
 * a sentence on the strip, this menu's own habit.
 */
export function press(this: ActionMenuComponent, operationId: string, dir: string, nodeId: string): void {
  if (this.hostOps.offer(operationId)?.form !== undefined) {
    void this.router.navigateByUrl('/');
    this.ui.openHostOp({ operationId, projectDir: dir, nodeId });
    return;
  }
  void this.hostOps.invoke(operationId, dir, nodeId).catch((err: unknown) => {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  });
}

/**
 * Press one: work out what this act is aimed at, then open the host's questions
 * in our card.
 *
 * ── TWO KINDS OF ACT REACH THIS BUTTON, AND THEY AIM AT DIFFERENT THINGS ───
 *
 * AN ACT THAT CONSUMES THE BOOK aims at the STEP the person is standing on —
 * the same id the tree row for that step would send, which is the whole of why
 * it can be pressed from here at all. What it does with a step that has no
 * export behind it is the host's business: it asks Foundry to make one
 * (`exportEpubFromStep`, electron/mount.ts) and then runs the work, which is
 * Owen's ruling and the reason this branch exists.
 *
 * WHAT THE PRESS NAMES IS `hostActAimFrom` (shared/stages.ts), since
 * 2026-09-11, and the argument for its order is written there. In short: the
 * promise the window stands on wins; then a finished EPUB is named by file
 * whenever one exists (Owen's ruling, 2026-08-24); then the position, which
 * names itself — including an EPUB import, which IS the book — while a
 * position parked on a SCAN gets a sentence instead of the old
 * `hostActPositionFrom` hop onto the reading, the hop that cast and narrated
 * the German text of a book whose English export was on screen. The mapping
 * itself survives in shared/stages.ts for the TREE's row presses, where the
 * row pressed says which lineage was meant.
 *
 * AN ACT THAT CONSUMES ONLY THE FINISHED FILE keeps every refusal it had. It
 * has said it reads an export and nothing else, so a press has to name one, and
 * a book with none — or with two, which this menu cannot choose between — is a
 * sentence rather than a guess. That is unchanged behaviour for a host that has
 * not moved its act onto the book.
 *
 * WHICH KIND THIS IS, ASKED THROUGH THE ONE RULE. `offersFor('book')` is
 * `offeredFrom` (shared/host-ops.ts), the same function the tree gates on, so a
 * declaration that reaches the tree's step rows and a declaration that takes
 * this branch cannot come apart.
 *
 * EVERY REFUSAL IS A SENTENCE ON THE STRIP, which is this menu's own habit for
 * a button that cannot grey itself out against a fact this deep in the model.
 */
export async function runHostAct(this: ActionMenuComponent, operationId: string): Promise<void> {
  /*
   * ── AND NOTHING THIS PRESS CAN THROW IS ALLOWED TO BE SILENT ──────────────
   *
   * The tree's footer got this wrapper on 2026-09-08 (`run`, open-documents),
   * after Owen pressed Narrate on a running promise and got no card, no notice
   * and no line in the terminal — the signature of an uncaught throw in a click
   * handler, which reaches the hosted window's devtools console where nobody is
   * looking. This menu is the second door onto the same acts and had no
   * wrapper, so on 2026-09-11 the dock's Narrate could still do exactly that.
   * The refusals below return quietly by design; what is left to catch is a
   * program error, which the person in front of the button should be told.
   */
  try {
    await this.hostActPressed(operationId);
  } catch (err) {
    const label = this.hostOps.offer(operationId)?.label ?? 'This act';
    this.notices.notice.set(
      `“${label}” could not be started: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error('[dock] the host act press threw', err);
  }
}

export async function hostActPressed(this: ActionMenuComponent, operationId: string): Promise<void> {
  const dir = this.target();
  if (dir === null) return;
  /*
   * AND THE SAME QUESTION THE THREE DIALOGS ABOVE ASK, for the same reason and
   * one seam further out. A host act that consumes the book asks Foundry to
   * EXPORT the step it names (`exportEpubFromStep`, electron/mount.ts) and then
   * works on that file — so an act ordered over a pane holding unapplied changes
   * spends somebody else's queue on a book without them, and the result lands
   * in the tree looking exactly like the one they meant.
   *
   * AIMED BY `target()`, NOT BY THE ACTIVE DOCUMENT. This menu can be pressed
   * over a project it is holding rather than the one on screen, and the gate has
   * to look at the book the act will actually be made from.
   *
   * ASKED BEFORE ANY OF THE REFUSALS BELOW, deliberately: those are about
   * whether the act can be aimed at all, and a person who has just answered
   * "apply them and continue" should have their changes recorded even if the
   * aim then turns out to be impossible. The alternative — refuse first, ask
   * second — would make the answer depend on the order two unrelated facts
   * happen to be checked in.
   */
  if (!await this.unapplied.cleared(dir, 'host')) return;
  if (this.hostOps.offersFor('book').some((offer) => offer.id === operationId)) {
    /*
     * ── WHAT THE PRESS NAMES IS ONE RULE, AND IT LIVES IN SHARED ────────────
     *
     * `hostActAimFrom` (shared/stages.ts) holds the order the facts are read
     * in and the argument for each: the promise the window stands on wins
     * outright (Owen, 2026-09-07 — the grayed card is a position and every
     * surface answers for it); then the finished export on screen, then the one
     * finished export (Owen, 2026-08-24 — *"name the file im actually
     * exporting"*); then the position, which names itself unless it is an
     * arrival, and an arrival names itself only when it IS the book (an EPUB
     * import — the same answer the tree gives that row). This method's job is
     * to gather those facts honestly and to say each refusal as a sentence on
     * the strip, which is this menu's own habit for a button that cannot grey
     * itself out against a fact this deep in the model.
     *
     * THE FACTS, AND WHERE EACH COMES FROM. The promise is `promiseIn` rather
     * than a test on `standingIn`'s answer, because "is the window aimed at a
     * promise here" is a question the ledger mirror already answers by name.
     * The export on screen is the focused tab when it is one of this project's
     * finished EPUBs — the strongest possible reading of "the file im actually
     * exporting". The position and ledger are the mirror's, read after the
     * unapplied gate so an Apply that just moved the pointer is what gets named.
     */
    const held = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
    const finished = (held?.exports ?? [])
      .filter((made) => made.kind === 'epub')
      .map((made) => made.file);
    const tab = this.stage.activeDocument();
    const viewing = tab !== null && tab.kind === 'book' && isExportView(tab)
      ? finished.find((file) => fold(tab.path) === fold(`${dir}/final/${file}`)) ?? null
      : null;
    const promise = this.ledger.promiseIn(dir);
    const aim = hostActAimFrom({
      promised: promise === null ? null : this.ledger.standingIn(dir),
      finished,
      viewing,
      standing: this.ledger.standingIn(dir),
      ledger: this.ledger.historyFor(dir)?.ledger ?? null,
    });
    if (aim.kind === 'node') {
      this.press(operationId, dir, aim.nodeId);
      return;
    }
    switch (aim.why) {
      case 'several-exports':
        this.notices.notice.set(
          'This book has more than one finished export, so which one this should work from is '
          + 'not obvious from here. Open the one you mean, or start it from its row in the '
          + 'library tree.',
        );
        return;
      case 'no-position':
        /*
         * `standingIn` answers null while a project's history is still in
         * flight — `hasBookAt` deliberately reads that silence as "not the
         * import" so the button is not greyed on a guess — and a press in that
         * window has nothing to send. Saying so is the honest answer.
         */
        this.notices.notice.set(
          'This book’s history has not finished loading in this window, so there is no step to '
          + 'run this from yet. Give it a moment and press again.',
        );
        return;
      case 'a-scan':
        this.notices.notice.set(
          'This book is standing on its scan, and there is no finished export to name — so '
          + 'running this from here would be a guess about which text you mean. Export the book '
          + 'first, or press the act on the step you mean in the library tree.',
        );
        return;
    }
  }
  const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
  /*
   * THE EPUBS, not the whole tray: what these acts consume is the finished
   * BOOK file, and counting a plain-text export here would refuse for
   * ambiguity between two files only one of which the act can read — or,
   * worse, aim the nodeId at the text file's own provenance. The same kind
   * test the row's `produces` and this menu's gray both make, made a third
   * time where the target is picked.
   */
  const exports = (project?.exports ?? []).filter((made) => made.kind === 'epub');
  if (exports.length === 0) {
    /*
     * AND THIS IS REACHABLE AGAIN, which it was not while the gray was
     * `hasEpubExport`. The button now greys on what the STAGE can do, so an act
     * that consumes only the finished file can be pressed over a book that has
     * none — and the honest answer is the sentence, because an act that did not
     * say it consumes the book is an act this menu must not make an export for
     * on its own initiative.
     */
    this.notices.notice.set(
      'There is nothing finished to work from yet — export this book first, and the act will '
      + 'have a file to consume.',
    );
    return;
  }
  if (exports.length > 1) {
    this.notices.notice.set(
      'This book has more than one finished export, so which one this should work from is not '
      + 'obvious from here. Pick the one you mean in the library tree and start it from there.',
    );
    return;
  }
  /*
   * ONE EXPORT, AND THE PRESS NAMES THAT EXPORT — the same id the tree's own
   * press on the same file would send (`exportNodeId`, shared/host-ops.ts).
   *
   * IT USED TO SEND THE EXPORT'S PROVENANCE STEP, falling back to the standing
   * one, and both are wrong for the same reason Owen's third ruling gives: the
   * host echoes this id into every node it pushes back, so a menu press that
   * named a STEP put the narration under that step in the tree while a tree
   * press on the very same file put it under the file. Two doors onto one act
   * that disagreed about where the result belongs is the shape this codebase
   * refuses everywhere else; this menu aims at the export, so it says the
   * export.
   *
   * NO FALLBACK IS NEEDED ANY MORE. The old one existed because a
   * pre-`stepId` catalogue had no provenance to send; the file's own name is
   * always available, so the one branch that could answer null is gone.
   */
  const target = exports[0];
  if (target === undefined) return;
  this.press(operationId, dir, exportNodeId(target.file));
}

export function home(this: ActionMenuComponent): void {
  void this.router.navigateByUrl('/');
  // This menu's Home is leaving on purpose: the held project lets go, so an
  // empty workspace shows the library rather than the room just left.
  this.stage.releaseProject();
  this.stage.goHome();
}

/**
 * Reading the pages is a thing you do to the document in front of you, so
 * opening the dialog from Settings takes you back to the documents first.
 */
export function convert(this: ActionMenuComponent): void {
  void this.router.navigateByUrl('/');
  this.ui.openOcr();
}

/**
 * ASKED ABOUT UNAPPLIED WORK FIRST, and this is the shape all three of these
 * openers share.
 *
 * An export is arithmetic over the RECORDED STEPS, so a book pane holding
 * changes nobody applied would have quietly produced the book without them
 * (`UnappliedService` — Owen's own report, 2026-08-21). The card is raised
 * BEFORE the dialog rather than at its Add press because none of these three
 * dialogs has a source picker: each computes its `source()` from the active
 * document's project, so the book this gate looks at is the book the card will
 * act on for the whole life of it, and settling the question first beats
 * settling it after somebody has picked a language and a model.
 *
 * THE NAVIGATION HAPPENS FIRST EITHER WAY. A press from Settings means "go and
 * do this to the document", and a person who then answers Cancel is a person
 * back among their documents rather than one stranded on a settings page.
 */
export async function openExport(this: ActionMenuComponent): Promise<void> {
  void this.router.navigateByUrl('/');
  if (!await this.unapplied.clearedHere('export')) return;
  this.ui.openExport();
}

export async function translate(this: ActionMenuComponent): Promise<void> {
  void this.router.navigateByUrl('/');
  if (!await this.unapplied.clearedHere('translate')) return;
  this.ui.openTranslate();
}

export async function simplify(this: ActionMenuComponent): Promise<void> {
  void this.router.navigateByUrl('/');
  if (!await this.unapplied.clearedHere('simplify')) return;
  this.ui.openSimplify();
}

export async function clean(this: ActionMenuComponent): Promise<void> {
  void this.router.navigateByUrl('/');
  // THE SAME GATE THE OTHER MAKE-ACTS PASS THROUGH. A cleanup is arithmetic over
  // the RECORDED steps — main materialises the position's book from them — so
  // changes nobody has applied would silently not be in the book that is cleaned.
  if (!await this.unapplied.clearedHere('clean')) return;
  this.ui.openClean();
}

/**
 * NO `clearedHere` IN FRONT OF THIS ONE, which puts it with the sweep rather
 * than with Translate and Simplify.
 *
 * The guard protects acts that CONSUME a rendering or MOVE the position — acts
 * that would otherwise run against a book missing the pending ops somebody is
 * looking at. This one reads the position's book file, with every pending edit
 * already replayed into it by main, and writes a report beside it: it consumes
 * no rendering and the pointer does not follow the landing
 * (\`RETAINED_BESIDE_YOU\`). docs/ANALYSIS.md §7 decides this explicitly, on the
 * sweep's own rule.
 */
export function analyse(this: ActionMenuComponent): void {
  void this.router.navigateByUrl('/');
  this.ui.openAnalysis();
}

/**
 * Opens the table, or returns to the one already open.
 *
 * `captureTabIn` is idempotent by construction -- it hands back the existing
 * tab for a project that already has one rather than making a second, which
 * matters more here than on Home: this row is reachable FROM the table, so
 * without that the door out of the room would put a second copy of the room
 * beside it. The navigate is the neighbours' habit, for the case where this
 * menu is drawn over a route that is not the workspace.
 */
export function editPhotographs(this: ActionMenuComponent, dir: string): void {
  void this.router.navigateByUrl('/');
  this.documents.show(this.documents.captureTabIn(dir));
}

/**
 * Take the open book apart into a light table of its own.
 *
 * THE NAVIGATE IS `editPhotographs`' HABIT, one flight up, for its reason: this
 * menu is drawn beside routes that are not the workspace, and the light table
 * this ends on is a tab rather than a route. It goes FIRST, before minutes of
 * rasterizing, so the progress card the pass raises is on screen where somebody
 * can watch it and press Stop — the drop card's ruling, which opens the panel
 * before the first page is drawn rather than after the last.
 *
 * THE PROJECT IS RE-READ FROM THE CATALOGUE rather than captured by the
 * computed above, which holds the DIRECTORY on purpose: a summary is a snapshot
 * that main re-announces, and a press acting on a minutes-old copy of a
 * project's document list is the class of bug this app keeps writing down. The
 * directory is the one handle that cannot go stale.
 */
export function editBook(this: ActionMenuComponent): void {
  const dir = this.editable();
  if (dir === null) return;
  const project = this.projects.projectFor(dir);
  if (project === null) return;
  void this.router.navigateByUrl('/');
  void this.bookEdit.editBook(project);
}

export function metadata(this: ActionMenuComponent): void {
  /*
   * AN EPUB EXPORT GETS THE MINT DIALOG — Owen's ruling (2026-08-24): the
   * tile over a finished book opens the same card the mint asked with, and
   * Save stamps the very file on screen. The PDF keeps the older dialog,
   * whose Info-dictionary fields are a different document's different
   * questions.
   */
  const tab = this.stage.activeDocument();
  if (tab !== null && tab.kind === 'book' && isExportView(tab)) {
    const project = this.projects.projectFor(tab.path);
    if (project !== null) {
      void this.router.navigateByUrl('/');
      this.ui.openMintMeta({
        mode: 'edit',
        projectDir: project.dir,
        path: tab.path,
        file: tab.path.split(/[\\/]/).pop() ?? tab.path,
      });
      return;
    }
  }
  void this.router.navigateByUrl('/');
  this.ui.openMetadata();
}
