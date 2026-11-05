/**
 * open-documents.acts — the acts a step's card offers, and what pressing one does.
 */
import { computed } from '@angular/core';
import { CHAINABLE_FROM, exportNodeId } from '@owen/foundry-core/shared/host-ops';
import { canCleanFrom, canExportFrom, canReadPages, canSimplifyFrom, canTranslateFrom, hostActPositionFrom } from '@owen/foundry-core/shared/stages';
import type { HostNodeAction } from '@owen/foundry-core/shared/host-ops';
import { isTextPass } from '@owen/foundry-core/shared/ledger';
import type { MakeAct, NodeOutput } from '@owen/foundry-core/shared/types';
import { hosted } from '../../core/foundry';
import { StageService } from '../../core/stage.service';
import { UnappliedService } from '../../core/unapplied.service';
import { Act, NO_ACTS, Row } from './open-documents.model';
import { iconForHostKind, fold } from './open-documents.words';
import type { OpenDocumentsComponent } from './open-documents.component';

/**
 * WHAT CAN BE DONE FROM THE SELECTED CARD — the "from here" footer's contents.
 *
 * ── ONLY THE POSSIBLE IS OFFERED, which is the whole of Owen's ruling ───────
 *
 *   *"just put 'export EPUB' as the only option on things that aren't capable
 *   of narration or whatever. The only options that exist are the ones that
 *   are possible for that stage."* (2026-08-17 20:30, via the bridge.)
 *
 * A BUTTON WHOSE ONLY POSSIBLE OUTCOME IS A REFUSAL IS NOT DRAWN. What he had
 * hit was the host's Narrate on a step that had nothing exported, but the same
 * complaint was true of this app's own three: an unread scan's import row is a
 * stage where Translate, Simplify and Export can each only refuse, and the
 * footer drew all three anyway — or, where `produces` had already gone null,
 * drew NOTHING and left a stage with one obvious next act looking like a dead
 * end.
 *
 * ── Each act is gated on the predicate the act itself refuses by ────────────
 *
 * `shared/stages.ts` holds one function per act — `canReadPages`,
 * `canTranslateFrom`, `canSimplifyFrom`, `canExportFrom` — and the dock's
 * buttons, the dialogs' own refusals and this footer all read the same one. The
 * point is not tidiness: it is that a button here and a sentence in a card
 * cannot come to different answers about what a stage can do, which is exactly
 * the failure the ruling names.
 *
 * ASKED ABOUT THE ROW, NOT ABOUT THE POSITION. Pressing an act in this footer
 * STANDS on the row first and then opens the dialog (`run`), so the honest
 * question for a card is "would this be possible if I were standing here" —
 * the same predicate with the row's own step in it. The dock asks the identical
 * function about the step the book is actually standing on.
 *
 * ── And the host's acts are still gated by what the node produces ───────────
 *
 * `Row.produces` is the currency (`NodeOutput`): the words of a book, a
 * finished export, or a host's audio. The host declares what each of its
 * operations consumes and `offeredFrom` is one comparison — which is what stops
 * Assemble appearing on a chapter of text, and, since Wave 10, what stops an
 * act that reads a finished FILE appearing on a ledger step.
 *
 * COMPUTED FOR THE SELECTED CARD ONLY, because that is the only card that
 * draws it: this reads `picked()`, so it is recomputed when the selection
 * moves and not once per row per repaint.
 */
export function acts(this: OpenDocumentsComponent) {
  return computed<readonly Act[]>(() => {
  const key = this.picked();
  if (key === null) return NO_ACTS;
  const row = this.groups().flatMap((group) => group.rows).find((one) => one.key === key) ?? null;
  if (row === null || row.dir === null) return NO_ACTS;
  const dir = row.dir;
  const out: Act[] = [];
  /*
   * ── IS THIS CARD A PROMISE — the one fact every tile below inherits ───────
   *
   * Owen: *"the export epub tile is grayed out until ai cleanup finishes."* Every
   * act offered from a promised row is itself deferred: it is planned now, queued
   * now, and cannot start until the row it is made from lands. So the answer is
   * taken once, from the card, and spread onto each act rather than re-derived per
   * tile — which is this file's own standing habit (`hasBook` two hundred lines
   * up) and is what keeps a fourth act from arriving without it.
   *
   * THE HINT SAYS WHAT THE DIM MEANS, in the card's own words. A tile that were
   * merely faint would read as broken; one that says "Runs after Cleaned for
   * narration finishes" is describing a queue.
   */
  const waiting = row.promise !== null;
  const after = (hint: string): Pick<Act, 'hint' | 'deferred'> => ({
    hint: waiting ? `${hint} — runs after “${row.title}” finishes` : hint,
    deferred: waiting,
  });
  /*
   * FOUNDRY'S OWN ACTS ARE OFFERED FROM A POSITION — a root or a step, never an
   * export row and never a host's node. An export is terminal in this app's own
   * pipeline (*"it wont go into the working files as a step because it isnt the
   * base for new steps"*), and offering Translate there would be offering to
   * make a new book out of a finished file by standing somewhere the card
   * cannot stand.
   *
   * IT NO LONGER TESTS `produces`, and that is Wave 10 landing. `produces` is a
   * fact about what the HOST may chain onto; whether THIS app can act is a
   * different question with four different answers, and conflating them is what
   * made an unread scan's import row offer three impossible acts (or, once
   * `produces` went null there, offer nothing at all — including the one act
   * that WAS possible).
   */
  if (row.kind === 'root' || row.kind === 'step') {
    const project = this.projects.items().find((one) => fold(one.dir) === fold(dir)) ?? null;
    /*
     * THE STEP THIS CARD IS, which is what the predicates are asked about — see
     * the docblock: pressing stands here first, so the question is what would be
     * possible from this row.
     */
    const at = row.step;
    /*
     * READ COMES FIRST BECAUSE IT COMES FIRST. On a scan nobody has read, this
     * is the only possible act and everything else is waiting on it — which is
     * exactly the stage Owen was looking at when he ruled. The dock has always
     * said the same thing by lighting its OCR button; this is that sentence
     * said where the person is actually standing.
     *
     * IT DISAPPEARS THE MOMENT A BANK LANDS. `canReadPages` is main's own
     * `reading.needed`, false for a project that arrived as an EPUB (no pages
     * to read) and false once a reading is done — so this is not a permanent
     * fixture of the root, it is the one act a book still owes.
     */
    if (canReadPages(project)) {
      out.push({
        id: 'read', label: 'Read the pages', icon: 'ft-scan', audio: false, host: null,
        form: false,
        ...after('Read this book\u2019s pages with the vision model \u2014 everything else is made from it'),
      });
    }
    /*
     * AND THE THREE THAT CONSUME THE WORDS, each on its own predicate. They
     * agree today (all three are `hasBookAt`) and are asked separately anyway,
     * because they are three acts with three dialogs and a shared name is what
     * lets one of them grow a condition later without the other two silently
     * inheriting it.
     *
     * METADATA IS DELIBERATELY NOT HERE, unchanged: it is a record ABOUT the
     * position rather than a thing made FROM it — the pointer does not even
     * move for it (`StepAction`) — so "from here" is the wrong sentence for it,
     * and the dock keeps it.
     */
    if (canTranslateFrom(project, at)) {
      out.push({ id: 'translate', label: 'Translate', icon: 'ft-globe', audio: false, host: null,
        form: false, ...after('Translate what this node holds into another language') });
    }
    if (canSimplifyFrom(project, at)) {
      out.push({ id: 'simplify', label: 'Simplify', icon: 'ft-spark', audio: false, host: null,
        form: false,
        ...after('Say this again in its own language: plainer, more natural, or for a learner') });
    }
    /*
     * AND CLEAN TEXT, HOSTED ONLY — the tile's own rule, said again here because
     * this is a second surface offering the same act (Owen, 2026-09-05: *"only
     * make it visible when vendored to bookforge"*). Hidden rather than grayed,
     * for the reason the action menu argues in full: a gray says "not from
     * here", and this act is not part of a standalone Foundry at all.
     */
    if (hosted() && canCleanFrom(project, at)) {
      out.push({ id: 'clean', label: 'Clean text', icon: 'ft-wave', audio: false, host: null,
        form: false,
        ...after('Say this again with the punctuation and typography a narrator can read aloud') });
    }
    if (canExportFrom(project, at)) {
      out.push({ id: 'export', label: 'Export', icon: 'ft-out', audio: false, host: null,
        form: false, ...after('Make the finished book from this node') });
    }
    /*
     * ── AND THE ONE ACT HERE THAT MAKES NOTHING: COMPARE ─────────────────────
     *
     * Owen ordered a cleanup, waited for it, opened the book and expected to be
     * shown what had changed. Nothing was lit. The highlights had existed since
     * Wave 57 (docs/COMPARE-CHANGES.md) — they are simply only drawn INSIDE a
     * comparison, and reaching one meant finding the compare picker in the
     * book's head row and then aiming it, by hand, at the step this pass was
     * made from. That is a person being asked to reconstruct a fact the row
     * already knows.
     *
     * SO THE DOOR GOES WHERE THE ACT IS. A text pass is the one kind of step
     * whose whole product is a difference from its parent (`TEXT_PASS_ACTIONS`
     * — translate, simplify, clean), and its parent is written on the row. One
     * press puts the two side by side with every change lit, and there is
     * nothing left to aim.
     *
     * ── Three conditions, each for its own reason ────────────────────────────
     *
     * IT IS A TEXT PASS. A curation, a read, an export and a metadata row are
     * not "the same book, said differently" — a diff against their parent is
     * either meaningless or is the tree itself.
     *
     * THE PARENT IS STILL IN THE LEDGER. `step.parent` is an id captured when
     * the step landed, and a step somebody has since removed leaves it naming
     * nothing. Offering a comparison against a step that is gone would be a
     * tile that opens an empty column.
     *
     * AND NOT ON A PROMISE. `waiting` means this row is a pending node — the
     * work is queued and nothing has been made yet (Wave 56), so there is no
     * text on this side of the comparison to draw. Every other act here is
     * DEFERRED when the row is promised, which is honest for a make-act: it
     * will be run when the promise lands. A comparison is not made, it is
     * LOOKED AT, so "later" is not a thing it can be — the tile is simply
     * absent until there is something to look at.
     *
     * IT CONSUMES NOTHING AND MAKES NOTHING, which is why `pressed` leaves
     * `made` null for it: two views of what already exists cannot have been
     * produced without somebody's unapplied changes, so the card that asks
     * about those has nothing to warn about here.
     */
    if (!waiting && at !== null && isTextPass(at.action) && at.parent !== null) {
      const held = this.ledger.historyFor(dir);
      const parent = at.parent;
      if (held !== null && held.ledger.steps.some((one) => one.id === parent)) {
        out.push({ id: 'compare', label: 'Compare', icon: 'ft-book', audio: false, host: null,
          form: false,
          ...after('Show this beside the step it was made from, with every change lit') });
      }
    }
  }
  /*
   * A ROW THAT PRODUCES NOTHING HAS NO HOST ACTS, which is where the old
   * `produces === null` guard at the top of this function went. It could not
   * stay there: it would have refused the whole footer for exactly the stage
   * this wave exists to give an offer to.
   */
  if (row.produces === null) return out;
  /*
   * AND NOTHING CHAINS OFF A NODE THAT FAILED.
   *
   * *"Owen's screenshot of a FAILED narrate node: the card still offers 'FROM
   * HERE: Enhance / Assemble' — ops that chain onto the audio the step never
   * produced."* `produces` on a host node is a PROMISE (it is what makes a
   * queued run chainable at all), and a failure is the promise broken while the
   * row goes on making it. `CHAINABLE_FROM` is the table that says so, in
   * shared/host-ops.ts where the offer rule lives.
   *
   * ONLY HOST NODES ARE ASKED. A ledger step cannot be in a failed state — a
   * step exists because something landed — so this is a question about the one
   * kind of row that carries somebody else's queue state.
   */
  if (row.node !== null && !CHAINABLE_FROM[row.node.state]) return out;
  const nodeId = this.nodeIdFor(row);
  const held = this.hostStates();
  const states = held !== null && nodeId !== null && held.key === `${dir}\u0000${nodeId}` ? held.states : {};
  for (const offer of this.hostOps.offersFor(row.produces)) {
    const state = states[offer.id];
    const label = state?.label ?? offer.label;
    out.push({
      id: `host:${offer.id}`,
      label,
      icon: iconForHostKind(offer.kind),
      audio: true,
      host: offer.id,
      form: offer.form !== undefined,
      ...after(state?.detail ?? `${label} — handled by the app Foundry is running inside`),
      done: state?.done === true,
    });
  }
  return out;
});
}

/**
 * RETRY OR DISMISS A HOST NODE THAT FAILED — the pair a failed card wears
 * instead of a "from here" footer.
 *
 * *"Failed nodes want `Retry` and `Dismiss` instead."* Foundry does neither
 * itself: it tells the host, and the row re-runs or leaves on the next push of
 * that project's nodes, which is how every other fact about a host node
 * arrives. The rejection is said on the strip, where this panel says everything
 * a host refused.
 */
export async function act(this: OpenDocumentsComponent, event: MouseEvent, row: Row, action: HostNodeAction): Promise<void> {
  event.stopPropagation();
  if (row.dir === null || row.node === null) return;
  try {
    await this.hostOps.nodeAction(row.dir, row.node.id, action);
  } catch (err) {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Whether this card draws Retry and Dismiss.
 *
 * BOTH HALVES, AND THE SECOND IS THE ONE THAT MATTERS. A failed node is the
 * only place they belong; a host that never registered `onNodeAction` is the
 * case where drawing them would produce a button that refuses — *"a button that
 * silently does nothing is the socket's one forbidden outcome"* — so the probe
 * rides on the mount-time offers answer and is asked here.
 */
export function canAct(this: OpenDocumentsComponent, row: Row): boolean {
  return row.node !== null && row.node.state === 'failed' && this.hostOps.takesNodeActions();
}

/**
 * Press one of the acts in a card's footer.
 *
 * ── Foundry's own three: STAND, THEN OPEN THE DOCK'S OWN DIALOG ─────────────
 *
 * The dialogs act on the POSITION — that is how aiming has always worked in
 * this app, and it is why there is no second targeting mechanism here. So the
 * footer's Translate stands on its own card first and then opens exactly the
 * dialog the dock opens. The stand is very nearly always a no-op (clicking the
 * card is what opened the footer, and clicking a node stands on it), and it is
 * made anyway because "very nearly always" is not a thing to leave a dialog's
 * aim resting on.
 *
 * ── The host's: NAME THE NODE, AND ASK ITS QUESTIONS IN THIS WINDOW ────────
 *
 * Nothing is stood on. Main hands the host the project and the id of the node
 * the footer belongs to — a ledger step id, one of the host's own node ids when
 * the act was chained onto work that has not finished, or the step an EXPORT
 * was made from — and the host takes it from there, into its own queue. What
 * comes back is either nothing or a rejection, and a rejection is the host's
 * sentence: it goes on the notice strip verbatim, because a button that appears
 * to do nothing is the one outcome this socket must not have.
 *
 * ── AND THE MODAL IS OURS NOW, WHERE THE ACT HAS ONE ───────────────────────
 *
 * *"Owen wants the dialog in the Foundry window, like translate/simplify."* An
 * operation that declared a `form` opens `app-host-op-dialog` — Foundry's own
 * card, drawn from the host's fields, invoking on Start. One that declared none
 * invokes on this click exactly as every operation did before, which is the
 * compatibility promise stated where it is kept.
 */
export async function run(this: OpenDocumentsComponent, event: MouseEvent, row: Row, act: Act): Promise<void> {
  // Without this the click also lands on the card, which for a step would
  // re-stand it and for a host node would do nothing — but both of them would
  // fire while a dialog was opening over the top.
  event.stopPropagation();
  /*
   * ── AND NOTHING THIS PRESS CAN THROW IS ALLOWED TO BE SILENT ──────────────
   *
   * *"a button that appears to do nothing is the one outcome this socket must
   * not have"* is written twice in this file about the HOST's refusals, and it
   * was true of everything except an exception raised on the way to them: an
   * uncaught throw in a click handler reaches the hosted window's devtools
   * console, which is a place nobody is looking, and Angular abandons the rest
   * of the handler. Owen pressed Narrate on a running promise and got no card,
   * no notice and no line in the terminal (2026-09-08) — which is the exact
   * signature of that, whatever the throw turns out to be.
   *
   * So the whole press is wrapped and the sentence goes on the notice strip.
   * This is not a repair layer over a known defect: the refusals a press can
   * legitimately meet already return quietly by their own design, and what is
   * left for this to catch is a program error, which the person in front of it
   * should be told about rather than left to infer from a button that did
   * nothing.
   */
  try {
    await this.pressed(row, act);
  } catch (err) {
    this.notices.notice.set(
      `“${act.label}” could not be started: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error('[tree] the act press threw', err);
  }
}

export async function pressed(this: OpenDocumentsComponent, row: Row, act: Act): Promise<void> {
  /*
   * ── AND FIRST, THE CARD ABOUT WORK NOBODY APPLIED ─────────────────────────
   *
   * Every act this footer offers is a MAKE-ACT — an export, a translation, a
   * rewrite, or one of the host's — and every one of them is arithmetic over the
   * recorded steps. A book pane holding changes with no Apply behind them would
   * therefore have produced the book WITHOUT them, silently (Owen's report,
   * 2026-08-21; `UnappliedService` has the whole account). `read` is the one act
   * here that is not: an OCR read makes the bank the ops are a delta against,
   * so it has nothing to be missing, and asking about it would be a card raised
   * over a gesture it does not describe.
   *
   * AIMED AT THE ROW'S OWN PROJECT, which is the book this footer belongs to
   * rather than whatever tab happens to be up — the same directory every branch
   * below sends.
   *
   * ── AND THE ANSWER IS READ, NOT JUST OBEYED (Wave 36) ─────────────────────
   *
   * `clearedFor` rather than `cleared` because this is the one press that moves
   * the pointer AFTER the gate has run, and an Apply moves it too — onto the
   * edit step it has just landed as a child of the position. Standing back on
   * this row afterwards would put the act behind the very changes somebody just
   * pressed Apply to include. `standing` is read BEFORE the card is raised for
   * exactly that comparison: it is the position the stack was made at, and it
   * is meaningless afterwards.
   */
  const made: MakeAct | null = act.host !== null
    ? 'host'
    : act.id === 'translate' || act.id === 'simplify' || act.id === 'clean'
      || act.id === 'export'
      ? act.id
      : null;
  const standing = this.ledger.standingIn(row.dir)?.id ?? null;
  const gate = made === null ? 'go' : await this.unapplied.clearedFor(row.dir, made);
  if (gate === 'stop') return;
  /*
   * WHERE THE APPLY LEFT THE POINTER IS WHERE THIS ACT BELONGS — but only when
   * the row pressed IS the row the changes were made at.
   *
   * That condition is the whole of the care here. Apply lands a child of the
   * STANDING position, which is not necessarily this row: somebody can stand on
   * one step, make changes, and press Export on a different row further up the
   * tree. In that case the new edit step has nothing to do with the act, and
   * skipping the move would silently export a step nobody clicked. So the move
   * is skipped in exactly one shape — pressed on the row that was being stood
   * on, and applied — where the pointer is already one step better than where
   * this was about to send it.
   */
  const landedHere = gate === 'applied' && standing !== null && standing === row.step?.id;
  if (act.host !== null) {
    if (row.dir === null) return;
    /*
     * ── AND A HOST ACT NAMES THE STEP THE APPLY JUST LANDED ─────────────────
     *
     * The same correction as the move below, expressed the only way a host act
     * can express it: this branch does not stand on anything, it hands an id
     * over the socket and the host takes that id back to an export of the step
     * it names. `nodeIdFor(row)` names the row — which, after an Apply that
     * landed a child of this very row, is the step WITHOUT the changes. Owen's
     * ruling names this act in particular (*"whether it's switching to a
     * different step or narrating or anything at all"*), and a narration made
     * from the un-applied book is precisely the hours-of-GPU-on-the-wrong-book
     * failure the card exists to prevent — reached, in this one shape, by
     * answering the card correctly.
     *
     * THE POSITION IS RE-READ RATHER THAN COMPOSED. `applyUnapplied` adopts
     * main's own history before it resolves, so the ledger this asks is already
     * the post-Apply one; working the new id out from the answer would be this
     * panel keeping a second opinion about where main put the pointer.
     */
    const nodeId = landedHere
      ? this.ledger.standingIn(row.dir)?.id ?? this.nodeIdFor(row)
      : this.nodeIdFor(row);
    if (nodeId === null) {
      /*
       * A ROW THAT CANNOT SAY WHAT IT WOULD ACT ON GETS A SENTENCE, not a
       * click that does nothing — this socket's own standing rule, applied to
       * the one refusal `nodeIdFor` can now make: an import row over a book
       * whose reading is not recorded in its history (`hostActPositionFrom`,
       * shared/stages.ts). It was a silent return while the only way to reach
       * it was a row with no dir, no step and no name, which is a state this
       * panel cannot draw.
       */
      this.notices.notice.set(
        'This book’s reading is not recorded in its history, so an act ordered from this row '
        + 'has no step to name. Click the step you want it made from and press again.',
      );
      return;
    }
    if (act.form) {
      this.ui.openHostOp({ operationId: act.host, projectDir: row.dir, nodeId });
      return;
    }
    void this.hostOps.invoke(act.host, row.dir, nodeId).catch((err: unknown) => {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    });
    return;
  }
  /*
   * ── AND THE MOVE ONTO THE ROW ASKS ONLY IF NOTHING ELSE HAS ──────────────
   *
   * Every act here stands on the row before it opens its dialog, and standing
   * is itself something the unapplied card now guards (`stand`). Handing it
   * `made !== null` is how the two questions stay one: a make-act has already
   * been answered for against this very project a few lines above, so the move
   * says nothing; a READ has not, because an OCR is not a make-act — it makes
   * the bank the ops are a delta against, so it has nothing to be missing — and
   * the move it performs is exactly the one somebody should be asked about.
   * That is the honest split: the card is raised once per press, by whichever
   * of the two halves of the press actually costs something.
   */
  const moved = landedHere ? Promise.resolve(true) : this.stand(row, made !== null);
  void moved.then((go) => {
    // A dismissed card stops the whole press, not merely the move: opening the
    // dialog anyway would leave somebody configuring a read of a book they just
    // said they did not want to leave the step of.
    if (!go) return;
    void this.router.navigateByUrl('/');
    if (act.id === 'read') this.ui.openOcr();
    else if (act.id === 'translate') this.ui.openTranslate();
    else if (act.id === 'simplify') this.ui.openSimplify();
    else if (act.id === 'clean') this.ui.openClean();
    else if (act.id === 'compare') {
      /*
       * ── AND STANDING FIRST IS NOT A COST HERE, IT IS THE GESTURE ───────────
       *
       * Every other act above stands on the row and then opens a dialog, and
       * the standing is a means: the dialog needs a position to act FROM.
       * Compare is different in kind and lands in the same place for a better
       * reason. The comparison is drawn BETWEEN the position and the compared
       * step — the live column is wherever the book is standing and the second
       * column is the step named here (`StageService.startCompare`, which
       * takes the project off what is on screen) — so somebody who pressed
       * Compare on a cleanup must end up STANDING ON THE CLEANUP, looking back
       * at the step it was made from. Standing on the row is the half of the
       * gesture that decides what the left-hand column is.
       *
       * WHICH IS ALSO WHY THE PARENT IS RE-READ FROM THE ROW rather than
       * carried on the act: `Act` is a description of a tile, and an id
       * captured when the footer was computed would be a second opinion about
       * a ledger that may have moved under it. The guard that offered this
       * tile already proved the parent is in the history.
       */
      const parent = row.step?.parent ?? null;
      if (parent !== null) this.stage.startCompare(parent);
    } else this.ui.openExport();
  });
}

/**
 * THE MOST PRECISE NODE ID THIS ROW CAN HONESTLY NAME.
 *
 * ── Three answers, in order of how much they know ──────────────────────────
 *
 * A HOST NODE names itself: the host minted the id, so chaining onto work that
 * has not finished is expressed by handing the id straight back.
 *
 * A POSITION names its step — EXCEPT AN IMPORT, WHICH NAMES THE READING UNDER
 * IT. That is what "from here" has always sent, and the host resolves it
 * against whatever mapping it keeps; the one substitution is
 * `hostActPositionFrom` (shared/stages.ts), because the host takes this id
 * back to `exportEpubFromStep` and that path still refuses the import row.
 * Today this panel can only reach the substitution's second answer — a root
 * row offers the host's acts only where the import IS the book, and an import
 * that is the book names itself — so nothing about a press changes here. It is
 * wired anyway, because the rule about which id a host act may carry is one
 * rule and the two press sites must not hold two versions of it.
 *
 * AN EXPORT names THE STEP IT WAS MADE FROM (`Row.madeFrom`), which is the
 * whole point of 9a: *"narrate on a step should mean 'the export made from this
 * step's state'."* With the provenance recorded, invoking from an export row
 * gives the host a precise target for free.
 *
 * ── AND THE FALLBACK, WHICH IS DELIBERATELY NOT A GUESS ────────────────────
 *
 * An export written before `ProjectFinal.stepId` existed has no provenance, and
 * this sends THE STEP THE BOOK IS STANDING ON. That is not a claim that the
 * export came from there — it did not necessarily — it is the id that pressing
 * the act on the tree a moment earlier would have sent, which is exactly the
 * input the host's own fallback was written against: *"absent stepId = today's
 * behavior (unique-export-or-refuse)."* Sending nothing would take the feature
 * away from every book exported before this wave; sending the root would be a
 * fabricated provenance. Sending the position is honest about being a fallback
 * and preserves the behaviour the letter asked to preserve.
 *
 * NULL WHEN THERE IS NOTHING AT ALL — and the caller now says so on the strip
 * rather than returning quietly, because the one reachable null is a real
 * refusal with a real reason (see `run`).
 */
export function nodeIdFor(this: OpenDocumentsComponent, row: Row): string | null {
  if (row.node !== null) return row.node.id;
  if (row.step !== null) {
    const held = row.dir === null ? null : this.ledger.historyFor(row.dir);
    return hostActPositionFrom(held?.ledger ?? null, row.step)?.id ?? null;
  }
  /*
   * AN EXPORT ROW NAMES ITSELF, and this line is Owen's third ruling.
   *
   * It used to answer `madeFrom` — the STEP the export was made from — which
   * was the most precise thing it could say before the row had a name of its
   * own, and which is exactly why the ghost rows landed on "Applied changes":
   * the host echoes the invoke's nodeId into every node it pushes back, so a
   * press that said "the step" produced narrations parented on the step. The
   * row has a name now (`exportNodeId`), so the press says the export and the
   * work comes back hanging under it.
   *
   * `madeFrom` STAYS BELOW AS THE FALLBACK, for a row that somehow has no
   * name — which cannot happen for an export today and costs one line to
   * survive if a future row kind grows a provenance without one.
   */
  if (row.nodeId !== null) return row.nodeId;
  if (row.madeFrom !== null) return row.madeFrom;
  if (row.dir === null) return null;
  return this.ledger.standingIn(row.dir)?.id ?? null;
}
