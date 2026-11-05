/**
 * action-menu.gates — whether a tile is lit, and the title that says why or why not.
 */
import { canCleanFrom, canExportFrom, canReadPages, canSimplifyFrom, canTranslateFrom } from '@owen/foundry-core/shared/stages';
import type { ActName } from '@owen/foundry-core/shared/types';
import { hosted } from '../../core/foundry';
import { isExportView } from '../../core/documents.service';
import type { ActionMenuComponent } from './action-menu.component';

/**
 * THE STEP THIS BOOK IS WAITING ON, lit in the menu.
 *
 * True for a project with no completed reading. Everything else in this app is
 * built on that bank — the block editor, every rendering, the chapter detection
 * — so a book whose pages have not been read is a book where exactly one thing
 * is worth pressing, and this menu says which.
 *
 * THE KIND OF THE FOCUSED TAB IS NO LONGER ASKED, and nothing is lost by it: a
 * project that still needs reading has no book to be looking at, so the test was
 * answering a question the project record had already settled. What it did do
 * was make the light a fact about a PANE rather than about the book, which is
 * the keying docs/WORKBENCH.md §6c retired.
 *
 * From the project RECORD (`ProjectSummary.reading`, derived once by main when
 * the library was listed), never from probing the disk here: this method runs
 * on every repaint of the menu.
 */
export function ocrWaiting(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  return canReadPages(this.projects.projectFor(tab.path));
}

/**
 * Export needs a PROJECT in front of you, and not a particular file type.
 *
 * IT USED TO BE `kind === 'pdf'`, which was true while the only thing anybody
 * stood on was the scan. It is false now: standing on the reading shows the
 * flowing book, and that document is exactly the one somebody wants an EPUB
 * of. Asking about the KIND of file in the pane was always asking the wrong
 * question — what can be exported is a fact about the project behind the
 * document (docs/DERIVED-BOOK.md §7, "anything that threads 'this is a PDF'
 * through the renderer is building the wrong thing").
 *
 * SO THE TEST IS THE READING, off the project record main derived once when it
 * listed the library — the same signal the OCR light reads, so this menu cannot
 * say "read this" and "export this" about one book at the same time. There is
 * nothing to export before a reading lands: every format this app makes is
 * arithmetic over that bank.
 *
 * ── AND THE RULING HAS A SECOND CASE: A BOOK THAT ARRIVED AS A BOOK ─────────
 *
 * "Nothing to export before a reading lands" was written about a scan, where it
 * is the whole truth, and it dead-bolted this door for every project imported
 * from an EPUB — books that are FINISHED, whose chapters and figures and
 * footnotes are all on the disk already. There is no bank under one and there
 * never will be: its book is exploded out of the archived container rather than
 * read off photographs (`bookAtPosition`, electron/projects.ts), so `done` is
 * false about a book with nothing left to do. The rule is what it always meant —
 * there is nothing to export until the blocks exist — and the blocks arrive by
 * one of two roads. `arrivedAsBook` is the other one, asked of the same project
 * record so that this and the dialog cannot disagree.
 *
 * AND IT STAYS LIVE FOR A DOCUMENT WHOSE PROJECT THIS WINDOW HAS NOT LISTED —
 * the pre-import window, where a dead button explains nothing and the plan
 * call's own refusal names the case precisely (the book nobody has read; the
 * reading that was interrupted). The dialog puts that sentence on screen. A
 * shut door explains itself, which is this menu's rule everywhere else.
 *
 * ── AND IT IS DEAD ON THE IMPORT ROW ────────────────────────────────────────
 *
 * The reading is necessary and is no longer sufficient. Standing on the import
 * is standing BEFORE the reading everything is arithmetic over — the user has
 * deliberately stepped back to the untouched scan — and an export from there
 * would quietly make the book they had just stepped away from
 * (docs/WORKBENCH.md §6c: "Translate on … the import row = disabled. Same rule
 * for Export and Metadata"). The dialog says the same thing in a sentence for
 * whoever arrives by the menu instead of by this button.
 *
 * EXCEPT WHERE THE IMPORT ROW IS THE BOOK. That refusal is about stepping BACK
 * PAST a reading to the untouched scan, and a project that arrived as a book has
 * no such step to step past: its ledger holds the import and nothing else, and
 * `bookAtPosition`'s own EPUB branch reads exactly that position — `reading ===
 * null` beside an EPUB archive — as the instruction to explode the container.
 * The row a scan project is standing BEFORE its book on is the row an EPUB
 * project's book IS, so applying one sentence to both would shut the only
 * position such a project can ever occupy.
 *
 * A HISTORY THIS WINDOW HAS NOT READ ANSWERS NULL, AND NULL IS NOT THE IMPORT.
 * The button stays live and main's own refusal is the backstop, on this menu's
 * standing preference for a door that opens onto an explanation over one that is
 * shut on a guess.
 */
export function canExport(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  const project = this.projects.projectFor(tab.path);
  return canExportFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
}

/*
 * ── THE MACHINE GATE, AND THE FIVE SENTENCES IT WRITES ────────────────────
 *
 * `machineLit` is ANDed into the five tiles that need a model, and it is a
 * separate call from the stage predicate rather than folded into it because
 * the two answers are two different explanations — see the `gates` field.
 *
 * THE TITLES BELOW EXIST AS METHODS AND NOT AS TEMPLATE TERNARIES because
 * every one of them is now a three-way choice: the machine cannot run this,
 * the book is not ready for it, or here is what the act does. Three branches
 * inline, twice per tile, is a template nobody can read — and the ORDER of the
 * branches is a decision that deserves to be written down rather than implied
 * by nesting.
 *
 * THE MACHINE ANSWERS FIRST WHEREVER IT IS DARK. A person standing on a scan
 * with no model installed has two problems, and the one to name is the one
 * that will still be there after they open a book. The exception is Analysis
 * hosted, where the refusal is neither of these and is stated before both.
 *
 * EXPORT AND METADATA ARE NOT HERE, and that is not an omission: an export is
 * arithmetic over recorded steps, and metadata is a form. Neither speaks to a
 * model, so neither can be darkened by the absence of one.
 */
export function machineLit(this: ActionMenuComponent, act: ActName): boolean {
  return this.gates.gate(act).lit;
}

export function ocrTitle(this: ActionMenuComponent): string {
  const gate = this.gates.gate('read');
  if (!gate.lit) return gate.why;
  return this.ocrWaiting()
    ? 'These pages have not been read yet — this is the step everything else needs'
    : 'Read this book\'s pages with the vision model';
}

export function translateTitle(this: ActionMenuComponent): string {
  const gate = this.gates.gate('translate');
  return gate.lit ? 'Translate this book into another language' : gate.why;
}

export function simplifyTitle(this: ActionMenuComponent): string {
  const gate = this.gates.gate('simplify');
  return gate.lit
    ? 'Say this book again in its own language: plainer, more natural, or for a learner'
    : gate.why;
}

export function cleanTitle(this: ActionMenuComponent): string {
  const gate = this.gates.gate('clean');
  if (!gate.lit) return gate.why;
  return this.canClean()
    ? 'Say this book again with the punctuation and typography a narrator can read aloud'
    : 'There is no book at this step to clean — read the pages first, or step onto the reading';
}

/**
 * ANALYSIS SAYS THE HOSTED THING FIRST, and it is the one tile here that puts
 * a refusal ahead of the machine's.
 *
 * A hosted window's gates are all lit — the work would run on the host's own
 * compute (electron/act-gates.ts) — so there is no machine sentence to say
 * there. What there IS is a permanent refusal of a different kind: a hosted
 * queue takes two request shapes and an analysis is a third, so the act is not
 * offered in that window at all. Naming the machine there would be answering a
 * question nobody had reached.
 */
export function analysisTitle(this: ActionMenuComponent): string {
  const gate = this.gates.gate('analysis');
  return gate.lit
    ? 'Read this book against the categories and list what it finds beside the page'
    : gate.why;
}

/**
 * Enabled where the project HAS a book, on the same test the dialog itself
 * applies — which is `canExport`'s test, because the two buttons ask the same
 * question of the same ledger.
 *
 * IT USED TO TEST THE POSITION'S SHOWN DOCUMENT FOR `.epub`, which was the
 * truth while every book was a cast EPUB in a pane and became its opposite at
 * the pivot: a read or edit position is drawn natively on the proof sheet and
 * shows NO document (`documentAtPosition` answers null), so the button was
 * gray exactly where the book is — the user's own report, standing on their
 * applied edits. What a translation consumes now is the POSITION'S book,
 * materialised by main with every op replayed in (`planTranslation`), so the
 * gate is "a book exists here": the reading landed, or the book arrived as
 * one — and not the import row, where the user has deliberately stepped back
 * to the untouched scan, except where the import IS the book.
 *
 * A LOOSE FILE ANSWERS FALSE, unlike Export's benefit of the doubt: what this
 * app translates is a position read off a ledger, and a file with no ledger
 * behind it has none.
 */
export function canTranslate(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  const project = this.projects.projectFor(tab.path);
  return canTranslateFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
}

/**
 * The two doors open onto one fact — the project has a book at its position —
 * so this asks the question by asking the button beside it, rather than by
 * keeping a second copy of a test that has already gone stale once.
 */
export function canSimplify(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  const project = this.projects.projectFor(tab.path);
  return canSimplifyFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
}

/**
 * THE SAME QUESTION THE TWO TILES ABOVE ASK, asked by the act's own name.
 *
 * `canCleanFrom` delegates to `canSimplifyFrom` today (shared/stages.ts argues
 * why it is a named function rather than a call), so the three agree — which is
 * Owen's own rule that the offer and the possibility are one fact, and not three
 * copies of a test that has already gone stale once on this rail.
 *
 * IT DOES NOT ASK `hosted()`, and the tile above it does. Whether the act is
 * POSSIBLE from a step is a fact about the book; whether it is OFFERED is a fact
 * about the window, and folding the second into this method would leave the gray
 * unable to explain itself — a permanently disabled tile whose title said the
 * book was not ready when the truth was that the feature is BookForge's.
 */
export function canClean(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  const project = this.projects.projectFor(tab.path);
  return canCleanFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
}

/**
 * LIT WHERE A TRANSLATION WOULD BE, hosted or not.
 *
 * It asks the same predicate the two tiles above it ask, and that is not
 * borrowing — it is Owen's own rule that the offer and the possibility are one
 * fact. An analysis reads exactly what a translation reads (the position's
 * materialised book file, every op replayed in), so "is there a book at this
 * position" has one answer and one function.
 *
 * IT WAS NEVER OFFERED HOSTED until 2026-10-30, because the host's queue had not
 * learned the analysis pair. It has (`enqueueAnalysis`, electron/job-queue.ts),
 * and the one hosted case that still cannot work — a host with no queue — is
 * refused by the door, by name.
 */
export function canAnalyse(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  const project = this.projects.projectFor(tab.path);
  return canTranslateFrom(project, project === null ? null : this.ledger.standingIn(project.dir));
}

/**
 * A document — either kind. Metadata is the one tool here that a SCAN has as
 * much use for as a book: a PDF's Info dictionary is the same six facts under
 * a different spelling, and a scan whose Title is the filename it was
 * downloaded under is the ordinary case.
 *
 * ── AND IT IS DEAD ON THE IMPORT ROW, WHICH IS THE RULE IT ALREADY CITED ───
 *
 * `canExport` above records the ruling in full — docs/WORKBENCH.md §6c, "Same
 * rule for Export and Metadata" — and this button was the half of it that was
 * never built: it keyed off the focused TAB, so standing on the import (having
 * deliberately stepped back to the untouched scan) still offered a dialog whose
 * Save is refused by main, in a sentence about a folder, one click later.
 * `archive/` is written once and never again, and the honest surface for that is
 * a shut door rather than a form that fills in and then declines.
 *
 * IT IS THE EXPORT SHAPE, LINE FOR LINE, including the reading test: a metadata
 * step is replayed onto what materialisation makes, and in a project with
 * nothing read there is nothing yet to make. A loose file keeps tab keying,
 * having no ledger to key off instead, and a history this window has not read
 * answers null — which is not the import, so the button stays live and main's
 * own refusal is the backstop.
 *
 * ── AND THE EPUB HALF IS BACK, AIMED SOMEWHERE ELSE ────────────────────────
 *
 * This was the PDF alone for a while, and the reason it was written down here:
 * the EPUB half reached `meta:read-epub`, which resolved an open book's WORKING
 * TREE, and the tree, the reader over it and the tab kind that held it are
 * deleted (docs/RENDERER.md §7). The half that was missing was never the dialog
 * — the form has drawn six `dc:` boxes the whole time — it was a DOCUMENT for it
 * to be about.
 *
 * A FINISHED EXPORT IS ONE. `openExportView` puts a book tab over a file in
 * `<project>/final/`, which is a real container with a real package in it, and
 * `viewOnly` is the app's own word for "this book tab is a finished file rather
 * than a position" (core/documents.service.ts). So the door is open exactly
 * there and nowhere else: not over a project's book tab, which is blocks out of a
 * bank and has no package to read, and not over anything the user imported.
 *
 * ── THE TWO TESTS BELOW ARE ABOUT THE PDF AND ARE NOT ASKED OF AN EXPORT ───
 *
 * The reading test asks whether there is anything to make yet; an export EXISTS,
 * so the question is already answered by the file being there. The import test
 * exists because a PDF tab's path can BE the untouched original in `archive/`,
 * and an export's path is two segments deep under `final/` — a different folder
 * by construction, whatever step the person happens to be standing on. Applying
 * either to a book would shut a door for a reason that is not about it.
 */
export function canEditMetadata(this: ActionMenuComponent): boolean {
  const tab = this.stage.activeDocument();
  if (tab === null) return false;
  if (tab.kind === 'book') return isExportView(tab);
  if (tab.kind !== 'pdf') return false;
  const project = this.projects.projectFor(tab.path);
  if (project === null) return true;
  if (!project.reading.done) return false;
  return this.ledger.standingIn(project.dir)?.action !== 'import';
}
