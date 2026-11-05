/**
 * open-documents.groups — the library rail's groups, derived: every open book and its tree of steps as rows.
 */
import { computed } from '@angular/core';
import { typeLabel } from '@owen/foundry-core/shared/documents';
import { exportNodeId, exportOfNodeId } from '@owen/foundry-core/shared/host-ops';
import { pendingStepOf } from '@owen/foundry-core/shared/pending';
import type { HostNode, Job, LedgerStep, NodeOutput, ProjectSummary } from '@owen/foundry-core/shared/types';
import { hosted } from '../../core/foundry';
import { LedgerService } from '../../core/ledger.service';
import { pathIsProject } from '../../core/documents.service';
import { Row, RowKind, DotState, blank, Group } from './open-documents.model';
import { hostRow, parentNameOf, drawLineage, inProject, arrivalSentence, iconForArrival, iconForStep, titleForStep, promisedTitle, factForStep, parentTitleOf, EXPORT_LABEL_OF, exportLabel, stepTitle, whenOn, joinIn, fold } from './open-documents.words';
import type { OpenDocumentsComponent } from './open-documents.component';

/**
 * ONE TREE PER OPEN BOOK — the panel, flattened for drawing.
 *
 * ── Why it is flattened here rather than drawn recursively ──────────────────
 *
 * A recursive template would need a component or a self-referencing
 * ng-template per level, and every gesture on a row — the drop insertion
 * point, the menu, the middle-click — is written against a flat list of keys.
 * Flattening at the source keeps ONE card template, one `track`, and one place
 * that decides what is visible: a collapsed node simply does not emit its
 * children, which is also what makes collapse cost nothing.
 *
 * IT IS ALSO WHAT MAKES THE SPINE DRAWABLE. The lineage is a per-row set of
 * lane flags computed in one backward pass over the finished list
 * (`drawLineage`), and a backward pass needs a list. A nested template would
 * have to ask each level whether anything below it continues, which is the
 * same question asked once per level instead of once per book.
 *
 * ── What is claimed, and what is left over ──────────────────────────────────
 *
 * The catalogue's own files — the scan, the cast Book, a translation — are
 * SPOKEN FOR BY THE TREE and are not drawn a second time as tabs. That is the
 * whole point of the merge: the step is the document. Their tabs are still
 * counted in `tabIds`, because closing the book has to close them and the
 * loose list must not pick them up as strays from nowhere.
 *
 * What is genuinely left over — an HTML face, a copy somebody opened out of an
 * archive folder — hangs off the root, because that is where it is on disk and
 * a row nobody can close is worse than a row in an odd place.
 */
export function groups(this: OpenDocumentsComponent) {
  return computed<Group[]>(() => {
  const open = this.rows();
  const collapsed = this.collapsed();
  const out: Group[] = [];

  for (const project of this.openProjects()) {
    const mine = open.filter((row) => inProject(row.path, project.dir));
    if (mine.length === 0) continue;

    const history = this.ledger.historyFor(project.dir);
    const problem = this.ledger.problemFor(project.dir);
    const standing = this.ledger.standingIn(project.dir)?.id ?? null;
    // Which step the book on the shelf was minted from -- main's one
    // resolution, read and never re-derived. Null for every project that has
    // no book, which is every project that is not a capture project today.
    const shelf = history?.current ?? null;

    /*
     * WHETHER THERE IS A BOOK IN THIS PROJECT AT ALL, asked once per book and
     * spent on every card in it.
     *
     * It decides `produces`, which decides what the "from here" footer may
     * offer — and it is the DOCK'S OWN TEST, deliberately (`canTranslate`,
     * action-menu.component.ts): the reading landed, or the book arrived as one,
     * and never the import row where somebody has stepped back to the
     * untouched scan. Two surfaces offering the same act must agree about when
     * it is available, and the way they agree is by asking the same question
     * of the same project record.
     */
    const arrivedAsBook = this.projects.arrivedAsBook(project);
    const hasBook = project.reading.done || arrivedAsBook;

    /*
     * THE PARENT CHAIN, INDEXED ONCE. `ProjectLedger.steps` is in creation
     * order and `parseLedger` refuses a file where it is not, so the children
     * of any node come out in the order they were made without a sort — which
     * matters, because a sort here would be this component holding a second
     * opinion about the shape of somebody's history.
     */
    const steps = history?.ledger.steps ?? [];
    const kids = new Map<string, LedgerStep[]>();
    let origin: LedgerStep | null = null;
    for (const step of steps) {
      if (step.parent === null) {
        origin ??= step;
        continue;
      }
      const already = kids.get(step.parent);
      if (already === undefined) kids.set(step.parent, [step]);
      else already.push(step);
    }

    /*
     * WHAT THE HOST IS MAKING IN THIS BOOK, indexed by the ledger step each
     * node hangs under.
     *
     * A HOST NODE IS NOT IN `steps` AND NEVER WILL BE. This is a second index
     * beside the ledger's, read from a mirror of somebody else's queue, and it
     * is joined onto the tree at exactly one place: the walk below emits a
     * step's host nodes after the step's own children. Standalone the map is
     * empty and the walk emits nothing extra.
     */
    const nodesByStep = new Map<string, HostNode[]>();
    for (const node of this.hostOps.nodesFor(project.dir)) {
      const already = nodesByStep.get(node.parentStepId);
      if (already === undefined) nodesByStep.set(node.parentStepId, [node]);
      else already.push(node);
    }

    /*
     * ── WHAT THIS BOOK'S QUEUE HAS PROMISED, indexed by the node it hangs under ─
     *
     * Owen, 2026-09-07: *"if i queue cleanup, i want a grayed out step to appear
     * where the item will be when it finishes."*
     *
     * A THIRD INDEX BESIDE THE LEDGER'S AND THE HOST'S, and it is DERIVED FROM
     * QUEUE ROWS RATHER THAN READ FROM ANYWHERE. Nothing pending is ever written
     * to `project.json` (shared/pending.ts carries the whole argument): the rows
     * are the record, so a row that leaves the queue takes its card off the screen
     * in this very repaint — which is the drawing half of Owen's cascade, and it
     * needs no bookkeeping at all.
     *
     * KEYED BY THE PARENT, WHICH FOR A PROMISE'S CHILD IS ANOTHER PROMISE'S
     * `mints`. A plan made under a promised cleanup names that cleanup's minted
     * step id as its parent — the same id the landing will append under, and the
     * same id this card is drawn as — so the chain in Owen's sentence (clean →
     * export → narrate) is three lookups of one map.
     *
     * THE ORPHANS ARE ALREADY GONE. `LedgerService.promisesIn` admits a row only
     * where its parent is a real step or another admitted promise, so a chain
     * whose head left the queue is not in this list at all.
     */
    const pendingByParent = new Map<string, Job[]>();
    for (const promise of this.ledger.promisesIn(project.dir)) {
      const parent = promise.parentStep ?? '';
      const already = pendingByParent.get(parent);
      if (already === undefined) pendingByParent.set(parent, [promise]);
      else already.push(promise);
    }

    /*
     * A STEP THE CHAIN DOES NOT REACH IS STILL DRAWN, hanging off the root.
     *
     * The ledger's rule is one parentless step and every other parent present
     * (`LedgerStep.parent`, shared/types.ts), and `parseLedger` holds it — so
     * this is a branch that should never run. It exists because the failure it
     * prevents is the worst one a navigator has: a step that is in the file, is
     * standing in the position, and is on nobody's screen, so it cannot be
     * clicked, split or deleted. The flat list could not have this bug; a tree
     * can, and it costs one filter not to.
     */
    const ids = new Set(steps.map((step) => step.id));
    const stranded = steps.filter((step) => step !== origin
      && (step.parent === null || !ids.has(step.parent)));

    /*
     * THE TERMINAL FILES — the exports, each drawn under the STEP IT WAS MADE
     * FROM, and under the book itself only where nothing recorded one.
     *
     * ── "RECORDS WHAT WAS MADE, NEVER THE POSITION" IS OVERRULED ───────────
     *
     * This block used to hang every export off the ROOT, at the Book's own
     * indent, on a doctrine written into three comments here: the tray records
     * what was made and not where it was made from; an export card draws NO
     * lineage line because the tray does not record a position and this panel
     * will not guess one. The doctrine was true when it was written — `final[]`
     * held a file, a kind and a date and genuinely could not say more.
     *
     * IT IS FALSE NOW BECAUSE THE CATALOGUE LEARNED. Wave 9 put `stepId` on
     * every export row precisely so the provenance could stop being guessed,
     * and Owen looked at the result and ruled (2026-08-17 22:30): *"the epub
     * should be a child of 'applied changes'. right now it looks like it's a
     * child of 'the book'."* An export IS made from a position; the tree knows
     * which; drawing it anywhere else is the panel withholding a fact it holds.
     *
     * SO THE LINEAGE IS DRAWN, and the sentence under the card changed with it
     * — a narration is made from an export now, so *"nothing is made from it"*
     * was two rulings out of date.
     *
     * A NULL `madeFrom` KEEPS THE OLD HOME, and that is where the old doctrine
     * survives as a fallback rather than as a rule: catalogues written before
     * `stepId` existed have exports whose provenance genuinely is unknown, and
     * the honest place for a file whose parent nobody recorded is under the
     * book it belongs to. See `orphanExports` below, which is where that is
     * decided.
     *
     * Main sends them newest first with a PROJECT-RELATIVE path
     * (`ProjectSummary.exports`), which is this codebase's oldest house rule
     * reaching the nav: a project holds `archive/Book.pdf`, `working/Book.pdf`
     * and `final/Book.pdf` at once, so nothing may ever be matched or joined
     * by its last segment. The path is rebuilt against the project's own
     * directory — in the project's own separator, so a Windows tooltip does
     * not read half in slashes — and it is never on screen as a name.
     *
     * An export whose file has gone is not listed at all: main drops those
     * before it sends the list, because `final/` is the user's own tray and a
     * row that opens nothing is worse than no row.
     */
    const claimed = new Set<string>();
    const terminals: Row[] = [];
    for (const made of project.exports) {
      const path = joinIn(project.dir, made.file);
      const label = exportLabel(made.kind);
      const already = mine.find((row) => fold(row.path) === fold(path)) ?? null;
      if (already !== null) claimed.add(already.key);
      terminals.push({
        ...blank,
        key: `${project.key}:final:${made.file}`,
        kind: 'export',
        tab: already?.tab ?? null,
        path,
        /*
         * THE PRODUCT, AS THE DIALOG NAMED IT — a noun where a step's card
         * carries a past tense, on the same precedent the root and the reading
         * follow: what a person wants off a terminal card is the thing, not
         * the act. It is also what every other surface in this file spells its
         * sentences out of (the delete's tooltip, the tab an EPUB opens into),
         * so it stays exactly the word it has always been.
         */
        title: label,
        /*
         * WHAT IT IS, AND WHAT IS MADE FROM IT — both changed with the
         * ruling. The card used to say *"a finished file — nothing is made
         * from it"* and drew no lineage, because the tray recorded no
         * position and this panel would not invent one. It records one now
         * (`ProjectFinal.stepId`), the card is drawn under it, and a
         * narration IS made from this file — so the old sentence was wrong
         * twice over in one line.
         *
         * `from` IS LEFT TO THE PARENT-NAMING PASS BELOW, which spells the
         * step's own title the way every other child of a step does.
         */
        said: 'the finished file — audio work is made from this',
        state: whenOn(made.madeAt),
        icon: 'ft-out',
        dot: 'file',
        tooltip: made.kind === 'txt'
          ? `Show this ${label} in the file manager\nExported `
            + `${new Date(made.madeAt).toLocaleString()}\nRight-click to save a copy.\n${path}`
          : `Open this ${label}\nExported ${new Date(made.madeAt).toLocaleString()}\n`
            + `Right-click or Ctrl+S in its tab to save a copy.\n${path}`,
        depth: 1,
        dir: project.dir,
        // A finished thing this app made, so it wears the dot when it is opened:
        // it lives in the library and nowhere the user filed it themselves.
        managed: true,
        /*
         * ONLY THE REPRINT OPENS. An export is a FINISHED product and this app
         * has exactly one viewer left for a file — pdf.js — so a PDF export
         * opens and an EPUB does not: the iframe reader that used to show one
         * is deleted (docs/RENDERER.md §7), and pointing pdf.js at a zip would
         * be a pane with "This PDF would not open" on it. The card stays, wearing
         * its date and its Reveal, because an export the app made and then would
         * not admit to is worse than one it will not open.
         */
        openable: made.kind === 'pdf',
        focused: already?.focused ?? false,
        /*
         * ── THE EXPORT ROW IS WHERE NARRATION BELONGS, AND NOW IT OFFERS IT ──
         *
         * *"In the tree, 'The book' and 'Applied changes (52)' offer
         * translate/simplify/narrate/etc., but the exported-EPUB row offers
         * nothing. The export row is the single most correct place for
         * `narrate` — it IS the file narration consumes."* (BookForge →
         * Foundry, 2026-08-18.)
         *
         * IT PRODUCES AN `export`, WHICH IS ITS OWN CURRENCY as of Wave 10 —
         * and the change from `'book'` is Owen's ruling landing in one word.
         * Saying `book` here put every `appliesTo: 'book'` act on this row AND
         * on every ledger step, so Narrate appeared on "Applied changes" where
         * it could only refuse: *"The only options that exist are the ones that
         * are possible for that stage."* A ledger step produces the WORDS; this
         * row is the finished FILE of them; an act that reads a file declares
         * `export` and lands here alone (`NodeOutput`, shared/types.ts).
         *
         * What it does NOT get is Foundry's own acts — see `acts`, where they
         * are gated on the row being a POSITION. An export is terminal in this
         * app's own pipeline and a source in the host's, and this field is the
         * only place those two facts meet.
         *
         * AND ONLY THE EPUB ROW SAYS IT. What an `export` act consumes today
         * is the finished BOOK file; a plain-text export or a reprint
         * offering one would be a button whose only possible outcome is the
         * host's refusal — the exact shape the ruling forbids. The day a
         * host registers an act that consumes a facsimile, this is the one
         * line that learns kinds.
         */
        produces: made.kind === 'epub' ? 'export' : null,
        // Its provenance, where the catalogue recorded one (`ProjectFinal.stepId`).
        madeFrom: made.stepId ?? null,
        /*
         * THE ID A PRESS ON THIS ROW HANDS THE HOST — `export:<file>`, minted
         * from the catalogue's own spelling of the file and from nothing about
         * this render (`exportNodeId`, shared/host-ops.ts, which carries the
         * whole argument). It is what makes a narration come back wearing this
         * row as its parent instead of the step the export was made from,
         * which is Owen's third ruling.
         */
        nodeId: exportNodeId(made.file),
      });
    }

    /*
     * AND THE FACSIMILES, WHICH ARE TERMINAL FOR THE SAME REASON THE EXPORTS
     * ARE — *"from the bank, pdf facsimile can be generated. that's a terminal
     * item"* (docs/RENDERER.md §0 A3).
     *
     * A reading has two documents in it: the Book, which is the read step's card
     * up in the tree and the thing everything downstream is made from, and the
     * page-for-page record, which nothing is ever made from. So it is a leaf
     * beside the exports rather than a step of its own — no arrow, no position,
     * and clicking it opens the PDF exactly as clicking an export opens one.
     *
     * AND IT IS ONLY EVER HERE BECAUSE SOMEBODY ASKED FOR IT. A reading used to
     * leave one of these in `generated/` on its own, back when a re-read could
     * take the previous pass's answers with it and a reprint on the disk was the
     * only thing about a reading that could not be invalidated. Banks are kept
     * now, so a project reads without gaining a row here and the row appears
     * when a person makes the reprint. Which is also why the list can be empty
     * for a fully read book and that is the ordinary state, not a hole.
     *
     * DRAWN UNDER THE IMPORT, at the Book's own indent, because that is where
     * the ruling puts it and because the alternative is worse than it looks: a
     * facsimile hung under the READ step would be a child of a card that is
     * itself a position, so folding the reading away would hide a terminal file,
     * and a project with two readings would draw two cards that look like
     * versions of one document rather than the records of two different passes.
     *
     * CALLED "FACSIMILE" AND NOT "FACSIMILE PDF", which is the export's word.
     * The two cards can appear together — somebody who exports a facsimile
     * after one has been made has both — and the distinction they need is that
     * one is a copy they filed and one is the record this book keeps of its own
     * reading. The line underneath says which in words; the title carries the
     * difference a person scanning a tree can use, and neither of them is a
     * filename.
     *
     * Main sends only the ones that are ON DISK (`ProjectSummary.facsimiles`),
     * project-relative, newest reading last — the same rules the exports above
     * arrive under, for the same reasons.
     */
    for (const made of project.facsimiles) {
      const path = joinIn(project.dir, made.file);
      const already = mine.find((row) => fold(row.path) === fold(path)) ?? null;
      if (already !== null) claimed.add(already.key);
      terminals.push({
        ...blank,
        key: `${project.key}:facsimile:${made.file}`,
        // A FILE ROW AND NOT A FIFTH KIND. Everything the row does — open on
        // click, wear the on-screen bar, offer a delete behind the danger ✕ — is
        // what this kind already means, and a `RowKind` per product would be
        // four template branches to say one thing.
        kind: 'export',
        tab: already?.tab ?? null,
        path,
        title: 'Facsimile',
        said: 'the pages as they were printed — nothing is made from it',
        state: whenOn(made.madeAt),
        icon: 'ft-page',
        dot: 'file',
        tooltip: 'Open this facsimile\nThe pages of this book as they were '
          + 'printed, reprinted as real text from what the reading found. Nothing '
          + `is made from it.\n${path}`,
        depth: 1,
        dir: project.dir,
        managed: true,
        openable: true,
        focused: already?.focused ?? false,
      });
    }

    /*
     * THE TABS THE TREE DOES NOT SPEAK FOR — the catalogue, AND the books the
     * steps cast for themselves.
     *
     * The catalogue alone was wrong and the way it was wrong was visible:
     * *"under that - 'epub - a copy you open…' is this the OCR record/OCR bank?
     * … the naming scheme is wrong, the organizing is wrong, the user should
     * never see 'epub'… it's deceptive."* A per-step cast is not catalogued on
     * purpose (`ProjectSummary.renderings` holds the whole argument), so
     * standing on a translation — which opens its cast — produced a row down
     * here saying somebody had opened a file by hand, named by its container
     * format, one line under the step that had actually made it.
     *
     * So the set is both, joined against the project's own directory in the
     * project's own separator, whole path against whole path. `renderings`
     * arrives project-relative for the same reason `exports` does, which is
     * this codebase's oldest house rule: a project holds `archive/Book.pdf`,
     * `working/Book.pdf` and `generated/Book.pdf` at once and nothing may ever
     * be matched by its last segment.
     */
    const catalogue = new Set(project.documents.map((document) => fold(document.path)));
    const extras: Row[] = [];
    for (const row of mine) {
      if (claimed.has(row.key)) continue;
      /*
       * THE BOOK IS THE READ STEP, and the read step is already a card up
       * there — the one called "The book", which is what standing on it opens
       * (`showBook`, core/position-sync.service.ts). It cannot be claimed by the
       * catalogue test below because it is not a file in the catalogue: its
       * path is the PROJECT's own directory, which is the whole of how a tab
       * for something that is not a file names what it is about. Without this
       * it would fall through to the loose row at the bottom of the tree,
       * announcing itself as a copy the reader went and opened by hand — the
       * exact confusion the merge of steps and documents exists to end.
       */
      if (row.tab !== null && row.tab !== undefined && pathIsProject(row.tab)) {
        claimed.add(row.key);
        continue;
      }
      // A step already names this document. See the docblock: the merge is the
      // whole point, and drawing it again as a file is the confusion §6c is
      // about.
      if (catalogue.has(fold(row.path))) {
        claimed.add(row.key);
        continue;
      }
      /*
       * IT SAYS WHAT MAKES IT DIFFERENT, which is that the project does not
       * claim it. Its tab is titled after the book, and under a root already
       * reading the book's name that would be a card saying nothing at all. The
       * old answer was the filename, which is the one thing this list is not
       * allowed to fall back to; the honest answer is that this is a copy the
       * reader went and opened themselves, with the path one hover away.
       */
      // Only a FILE-backed tab can be a loose copy — both directory kinds are
      // claimed above and never reach here. Asked explicitly rather than left to
      // narrowing, which could prove it while there were two kinds and cannot
      // now that there are three.
      const named = row.tab?.kind === 'pdf' ? typeLabel(row.tab.kind) : '';
      extras.push({
        ...row,
        title: named.length > 0 ? named : row.title,
        said: 'a copy you opened',
        depth: 1,
        dir: project.dir,
      });
      claimed.add(row.key);
    }

    /*
     * ── THE EXPORTS, INDEXED BY THE STEP THEY WERE MADE FROM ───────────────
     *
     * Owen's fourth ruling (2026-08-17 22:30). `madeFrom` has been on the row
     * since Wave 9 and was drawn nowhere; this is the index that puts it on
     * screen. A row whose provenance names a step in THIS project's ledger is
     * emitted by the walk, as that step's own child; everything else falls to
     * `orphanExports` and keeps the home the tray doctrine gave it.
     *
     * NAMING A STEP THIS PROJECT DOES NOT HOLD COUNTS AS ORPHANED, which is
     * not defensive: a delete can take the step an export was made from while
     * the file itself stays in `final/` (the tray is the user's and is never
     * swept by a step delete), so this is the ordinary end state of deleting a
     * reading somebody had already exported from.
     */
    const exportsByStep = new Map<string, Row[]>();
    const orphanExports: Row[] = [];
    for (const row of terminals) {
      const parent = row.madeFrom;
      if (parent === null || !ids.has(parent)) {
        orphanExports.push(row);
        continue;
      }
      const already = exportsByStep.get(parent);
      if (already === undefined) exportsByStep.set(parent, [row]);
      else already.push(row);
    }

    /*
     * AND THE HOST NODES AN EXPORT ROW OWNS — the ghost narrations, indexed by
     * the export id they came back wearing.
     *
     * The host echoes the invoke's nodeId into `parentStepId` verbatim, so a
     * narration ordered from an export row arrives with `export:<file>` in the
     * field the ledger's own children are indexed by. `nodesByStep` above cannot
     * hold them: its keys are step ids, and a lookup there would never match.
     * Reading them out by the same spelling the press minted is the whole of
     * the join (`exportNodeId` / `exportOfNodeId`, shared/host-ops.ts).
     *
     * A NODE WHOSE PARENT NAMES AN EXPORT THIS PROJECT NO LONGER HAS draws
     * nowhere, which is `setHostNodes`' own documented posture for a parent the
     * tree cannot find — Foundry does not refuse a push, it simply has nowhere
     * to hang it.
     */
    const hostedOnExports = new Map<string, HostNode[]>();
    for (const node of this.hostOps.nodesFor(project.dir)) {
      if (exportOfNodeId(node.parentStepId) === null) continue;
      const already = hostedOnExports.get(node.parentStepId);
      if (already === undefined) hostedOnExports.set(node.parentStepId, [node]);
      else already.push(node);
    }

    /**
     * Draw one export row and whatever the host is making from it.
     *
     * ── An export has children now, which is the composition of two rulings ─
     *
     * Ruling three puts the narrations under the export; ruling four puts the
     * export under its step. Together the tree reads Book → … → Applied
     * changes → EPUB export → the narration — which is the pipeline in the
     * order it happened, and is what Owen was describing when he said the epub
     * looked like a child of the book.
     *
     * SO IT GROWS AN ARROW, and only when it has something under it. `expanded`
     * has been null on every export since the row existed — *"an export never
     * gets one; it is terminal, and an arrow on it would promise something
     * under it"* — and that sentence is now true only of an export nobody has
     * made anything from. The promise is kept either way: an arrow appears
     * exactly when there is something to reveal.
     */
    /**
     * ONE PROMISED CARD, AND EVERYTHING PROMISED UNDER IT.
     *
     * ── The grammar is the one the tree already had ────────────────────────
     *
     * `.card.pending` — no fill, a dashed border, an untinted mark — is the shape
     * a host's queued node has worn since this panel was redrawn, and its own
     * style comment says why: *"the fill is what the eye reads as 'this is a
     * thing'; a plan is the shape of one."* A promise of Foundry's own is exactly
     * that claim about exactly that kind of thing, so it gets the same drawing
     * rather than a second vocabulary for one idea. `drawLineage` reads `planned`
     * and dashes the thread down to it for free.
     *
     * ── A STEP PROMISE AND A FILE PROMISE, told apart by the id ───────────
     *
     * `Job.mints` is the node this row will land and `exportOfNodeId` is the test
     * (shared/host-ops.ts): `export:<file>` is a file in the tray, anything else
     * is a step of the ledger. A step promise carries the synthetic `LedgerStep`,
     * so every predicate in shared/stages.ts answers for it exactly as it will
     * once it lands; a file promise carries the id a host act names — the SAME id
     * the landed export row will carry, so a narration chained onto the promise
     * comes back parented on a node that is still there afterwards and nothing
     * has to be re-parented.
     *
     * ── AND A REAL STEP IS NEVER DRAWN UNDER ONE ──────────────────────────
     *
     * Which is why this recurses only into `pendingByParent` and never into
     * `kids`. It is a fact about the world rather than a rule enforced here: a
     * landing always happens before anything made from it can run, so by the time
     * a real child exists its parent is a real step and `walk` draws the lot.
     */
    const walkPending = (promise: Job, depth: number): void => {
      const id = promise.mints ?? '';
      const key = `${project.key}:pending:${promise.id}`;
      const under = pendingByParent.get(id) ?? [];
      const shown = !collapsed.has(key);
      const file = exportOfNodeId(id);
      /*
       * THE HOST'S WORK CHAINED ONTO THIS PROMISE, drawn under it as under a landed
       * step (Owen, 2026-10-10: *"steps apply to the one above them"*). A host
       * that chains work onto a greyed step names the step the promise MINTS as
       * its parent — the id it will keep once it lands, so nothing re-parents.
       * A file promise's host work is `hostedOnExports`', drawn by `emitExport`.
       */
      const jobs = file === null ? nodesByStep.get(id) ?? [] : [];
      const node = pendingStepOf(promise);
      const title = node !== null
        ? promisedTitle(node, promise)
        : exportLabel(EXPORT_LABEL_OF[promise.kind] ?? 'epub');
      /*
       * WHAT THE CARD SAYS WHILE IT WAITS. The dot is the host row's own
       * vocabulary — `hostRow` passes four states straight onto four of the dot's
       * six — and a HELD row wears the queued one: standalone every text pass is
       * born held, waiting on a person rather than on the machine, and that is a
       * distinction the SHELF draws rather than the tree. The right-hand slot says
       * the same word, with the count where the engine has given one.
       */
      const dot: DotState = promise.state === 'running'
        ? 'running'
        : promise.state === 'failed' ? 'failed' : 'queued';
      const percent = promise.progress === null || promise.progress.total <= 0
        ? null
        : Math.round((promise.progress.page / promise.progress.total) * 100);
      const state = promise.state === 'failed'
        ? 'failed'
        : promise.state === 'running'
          ? (percent === null ? 'running' : `running ${percent}%`)
          : 'queued';
      rows.push({
        ...blank,
        key,
        // A FILE PROMISE IS AN `export` ROW, on the facsimile's precedent: a
        // `RowKind` per product would be four template branches to say one thing,
        // and everything this card does — open nothing, take the selection, offer
        // the host's acts — is what that kind already means.
        kind: file !== null ? 'export' : 'step',
        path: file !== null ? promise.outputPath : project.dir,
        // WHAT `titleForStep` WILL SAY ONCE IT LANDS, out of the same function
        // that will say it — so the card does not change its wording when the
        // promise becomes a fact. See `promisedTitle` for the two facts that
        // reach it off the ROW rather than off the params a promise has none of.
        title,
        state,
        icon: node !== null ? iconForStep(node) : 'ft-out',
        tint: node !== null ? 'text' : 'plain',
        dot,
        // THE ONE THING A PERSON HAS TO KNOW ABOUT THIS CARD, said where a card in
        // this panel says everything else about itself. The engine's own sentence
        // rides underneath when the run failed.
        tooltip: `${state} — this is not a step of this book yet. It is here because the queue is `
          + 'going to make it, and if that work leaves the queue this card and everything under '
          + 'it go with it.'
          // A RUNNING PROMISE SAYS WHERE ITS DOOR IS. It cannot be deleted from
          // the tree (Owen's lock, 2026-09-08 — see `.card.locked` in the
          // styles and `refuseRunningGhost` in electron/ipc.ts), and a card
          // that is refusing a gesture should say so before the gesture.
          + (promise.state === 'running'
            ? ' It has started, so it can only be stopped in the queue — which takes everything '
              + 'queued behind it with it.'
            : '')
          + `${promise.error === undefined ? '' : `\n${promise.error}`}`,
        why: promise.state === 'failed' ? promise.error ?? null : null,
        depth,
        dir: project.dir,
        step: node,
        promise,
        // WHAT CAN BE MADE FROM HERE — a promised step produces the words of a
        // book exactly as the landed one will, and a promised EPUB is the file a
        // host act consumes. `hasBook` is the test every real card in this book is
        // drawn by: a promise cannot make a book out of a project that has none.
        // A promised ANALYSIS offers nothing, as the landed one does not: it
        // is terminal (see the landed card's `produces`).
        produces: node !== null
          ? (hasBook && node.action !== 'analysis' ? 'book' : null)
          : (promise.kind === 'epub' ? 'export' : null),
        madeFrom: file !== null ? promise.parentStep ?? null : null,
        nodeId: file !== null ? id : null,
        current: id === standing,
        planned: true,
        expanded: under.length + jobs.length === 0 ? null : shown,
      });
      if (!shown) return;
      for (const kid of under) walkPending(kid, depth + 1);
      for (const hosted of jobs) rows.push(hostRow(project, hosted, title, depth + 1));
    };

    const emitExport = (row: Row, depth: number): void => {
      const jobs = row.nodeId === null ? [] : hostedOnExports.get(row.nodeId) ?? [];
      const shown = !collapsed.has(row.key);
      rows.push({
        ...row,
        depth,
        expanded: jobs.length === 0 ? null : shown,
      });
      if (!shown) return;
      /*
       * THE GHOST SAYS WHICH FILE IT IS BEING MADE FROM, which is the export's
       * own card title ("EPUB"). Before the ruling these rows hung under a
       * STEP and named it; hanging under the file and naming nothing would
       * have been a lineage line drawn and then left blank.
       */
      for (const node of jobs) rows.push(hostRow(project, node, row.title, depth + 1));
    };

    // ── The tree itself, root first ──────────────────────────────────────
    const rootKey = `${project.key}:root`;
    const rootKids = origin === null
      ? stranded
      : [...kids.get(origin.id) ?? [], ...stranded];
    const rootHostNodes = origin === null ? [] : nodesByStep.get(origin.id) ?? [];
    /*
     * THE ORPHANS RATHER THAN EVERY TERMINAL, now that most exports are drawn
     * deeper: a book whose only export hangs under a step still has children
     * (that step is one), so the count is only wrong in the direction that
     * would matter if a project's ENTIRE contents were exports with parents —
     * which cannot happen, because a step with an export under it is itself a
     * child of the root.
     */
    const rootPending = origin === null ? [] : pendingByParent.get(origin.id) ?? [];
    const rootHasChildren =
      rootKids.length + rootHostNodes.length + orphanExports.length + extras.length
      + rootPending.length > 0;
    const rootOpen = !collapsed.has(rootKey);
    const rows: Row[] = [{
      ...blank,
      key: rootKey,
      kind: 'root',
      // The project's directory, because Show in file manager on a book means
      // the book's folder — and because the root names a book, not a file.
      path: project.dir,
      // THE BOOK'S OWN NAME, and it is the one title in this panel that is not
      // a sentence about an act. The group header that used to carry it is
      // gone; what the import IS goes on the line underneath, where every
      // other card keeps its second fact.
      title: project.title,
      said: origin === null ? 'reading this book’s history…' : arrivalSentence(origin),
      state: origin === null ? null : whenOn(origin.createdAt),
      icon: origin === null ? 'ft-scan' : iconForArrival(origin.payload),
      dot: 'source',
      tooltip: this.rootTitle(project, origin, problem),
      depth: 0,
      dir: project.dir,
      step: origin,
      // The import is a position like any other, so acting from it is offered
      // on exactly the terms the dock offers it on: only where the import IS
      // the book (a project that arrived as one), never where it is the scan
      // somebody has stepped back to.
      produces: hasBook && arrivedAsBook ? 'book' : null,
      current: origin !== null && origin.id === standing,
      stale: origin?.stale === true,
      expanded: rootHasChildren ? rootOpen : null,
    }];

    if (rootOpen) {
      const walk = (step: LedgerStep, depth: number): void => {
        const under = kids.get(step.id) ?? [];
        const jobs = nodesByStep.get(step.id) ?? [];
        const key = `${project.key}:step:${step.id}`;
        const shown = !collapsed.has(key);
        rows.push({
          ...blank,
          key,
          kind: 'step',
          path: project.dir,
          // A SENTENCE, DERIVED — never `step.label`, which is the record of
          // what this app called the act at the time and is what the tooltip
          // still says. See `titleForStep`.
          title: titleForStep(step),
          fact: factForStep(step),
          from: parentTitleOf(step, steps, project.title),
          state: whenOn(step.createdAt),
          icon: iconForStep(step),
          tint: 'text',
          dot: 'done',
          tooltip: stepTitle(step, standing),
          depth,
          dir: project.dir,
          step,
          /*
           * AN ANALYSIS IS TERMINAL (Owen, 2026-10-30: *"its a special step
           * that's terminal - there arent other steps that can be derived form
           * it"*): it is a report ABOUT the book above it, not a state of the
           * book, so its card offers no acts. Translating or narrating is done
           * on the step it was run against.
           */
          produces: hasBook && step.action !== 'analysis'
            && (arrivedAsBook || step.action !== 'import') ? 'book' : null,
          current: step.id === standing,
          onTheShelf: step.id === shelf,
          stale: step.stale === true,
          expanded: under.length + jobs.length === 0 ? null : shown,
        });
        if (!shown) return;
        for (const kid of under) walk(kid, depth + 1);
        /*
         * THE FILES MADE FROM THIS STEP, between its ledger children and the
         * host's work — see the index above for the ruling. Before the steps'
         * own children would have put an export above a translation made from
         * the same row; after the host's nodes would have put a finished file
         * below the work being made from it. Between them is the order the
         * pipeline actually runs in.
         */
        for (const made of exportsByStep.get(step.id) ?? []) emitExport(made, depth + 1);
        /*
         * AND WHAT THE QUEUE HAS PROMISED FROM THIS PLACE — after everything that
         * has actually happened, and before the host's own work.
         *
         * THE ORDER IS THE ONE THE HOST'S NODES ALREADY ARGUE FOR: *"the ledger's
         * children are things that HAVE happened to the words, and a host node is
         * most often the thing that has not happened yet."* A promise is that same
         * kind of claim about Foundry's own work, so it sits with the plans rather
         * than with the record — and above the host's, because the host's work is
         * usually made FROM one of these.
         */
        for (const promise of pendingByParent.get(step.id) ?? []) walkPending(promise, depth + 1);
        /*
         * THE HOST'S OWN WORK, AFTER THE STEPS MADE FROM THE SAME PLACE.
         *
         * Last rather than first, and it is the honest order: the ledger's
         * children are things that HAVE happened to the words, and a host node
         * is most often the thing that has not happened yet. A queued
         * narration drawn above a finished translation would put the plan
         * above the record.
         */
        for (const node of jobs) {
          rows.push(hostRow(project, node, parentNameOf(project, step), depth + 1));
        }
      };
      for (const step of rootKids) walk(step, 1);
      // The promises made from the IMPORT ROW itself — rare, because there is
      // nothing to clean before a book has been read — and drawn for the reason
      // the stranded steps are: a card that exists and is on nobody's screen
      // cannot be clicked, selected or taken out of the queue.
      for (const promise of rootPending) walkPending(promise, 1);
      for (const node of rootHostNodes) {
        rows.push(hostRow(project, node, parentNameOf(project, origin), 1));
      }
      /*
       * AND THE EXPORTS NOBODY RECORDED A PARENT FOR, at the Book's own indent
       * — the home every export had before the ruling, kept for exactly the
       * rows that still have nothing better to say. A catalogue written before
       * `ProjectFinal.stepId` existed has files whose provenance is genuinely
       * unknown, and inventing one for them would be the guess the old tray
       * doctrine was right to refuse.
       */
      for (const made of orphanExports) emitExport(made, 1);
      rows.push(...extras);
    }

    out.push({
      key: project.key,
      title: project.title,
      dir: project.dir,
      rows: drawLineage(rows),
      /*
       * EVERY TAB IN THE BOOK, AND NOT EVERY TAB IN THE ROWS. The tree draws
       * fewer rows than the project has open documents — the scan and the
       * Book are steps now — so a close-the-book that walked the drawn rows
       * would leave open exactly the two tabs the reader most wanted shut.
       * This is also what keeps the loose list from picking them up.
       */
      tabIds: mine.map((row) => row.tab?.id).filter((id): id is string => id !== undefined),
    });
  }
  return out;
});
}
