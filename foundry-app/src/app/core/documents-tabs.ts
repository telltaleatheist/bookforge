/**
 * documents-tabs — what an open tab is, and the small facts about paths and names the service works from.
 */
import { effect } from '@angular/core';
import { fold } from '@owen/foundry-core/shared/original';
import type { JobKind } from '@owen/foundry-core/shared/types';
import { BookStacksService } from './book-stacks.service';
import { NoticeService } from './notice.service';

/**
 * The open documents — the flat list, and the one place that knows which is
 * which.
 *
 * TABS ARE RENDERER STATE, on purpose. Main owns everything with a lifetime — a
 * conversion, an unpacked book's temp directory, the allow-list — but which of
 * them is open and in what order is a window's own business, and pushing that
 * through IPC would make a reload of the renderer able to disturb it.
 *
 * The one door in is `document:opened`. The menu, the dialog, a drop, a path on
 * argv and a conversion that just finished all reach main first (which decides
 * whether the file is openable at all) and arrive back here as that event. So
 * this service never has to decide whether a path is real, and there is exactly
 * one code path that creates a tab.
 *
 * ── This was `TabsService`, and this file is four fifths of what it did ──────
 *
 * `TabsService` was 2,752 lines and about fourteen injection sites, and unit 8c
 * (docs/PLAN.md §4) broke it along the seams it had grown rather than the ones it
 * was designed with. What stayed here is the LIST AND ITS LIFE: identity, naming,
 * the flags a document wears, the doors it is opened by and the questions it is
 * closed by. What left is what was never about a list — the notice sentence
 * (`NoticeService`), what is on screen (`StageService`), the ledger's opinion
 * about what ought to be (`PositionSyncService`) and the book viewers' undo
 * stacks (`BookStacksService`).
 *
 * THE DEPENDENCY RUNS ONE WAY and it is the whole point: Notice ← Documents ←
 * Stage ← PositionSync. This file may say a sentence and may ask a book viewer
 * what a close would scrap; it may not ask what is on screen, and does not need
 * to — see `show` below for the one place that looked like it did.
 *
 * ── ONE VIEWER, AND THE SECOND REVERSAL THIS CLASS CARRIED ──────────────────
 *
 * The class this came out of carried the record of the panes: one to five columns
 * side by side, and the reversal that brought each column's CHROME-STYLE STRIP
 * back with pin, drag-split and close. Both went on one ruling (2026-08-17):
 *
 *   *"i dont think we should have tabs in foundry. i think its making things a
 *   bit confusing. however, the user should be able to compare two steps
 *   sometimes. so i think the solution is to have a single viewer window/single
 *   tab, and if the user wants to compare two steps, theres a compare button
 *   they can click and then they can choose the step to compare."*
 *
 * THE TABS STAY IN ONE FLAT LIST, and now it is the only list there is. It was
 * already flat under the panes, on the rule that `patch()` — the one function
 * every edit, save and flag in this file goes through — must never have to search
 * a list of lists. What went with the columns is the second structure that held
 * ids INTO it; the order in the list is the library panel's, through `reorder`,
 * and nothing else records a sequence.
 *
 * A DOCUMENT HAS AT MOST ONE TAB, unchanged and load-bearing. Opening something
 * already open SHOWS it rather than putting a second viewer over one unpack —
 * the rule `adopt()` has always enforced for files.
 *
 * ── TWO KINDS, WHICH IS WHERE R6c LEFT IT ───────────────────────────────────
 *
 * There were four. `epub` was an unpacked book served to a sandboxed <iframe>
 * and `editor` was that book's markup in a textarea beside it, and both are
 * deleted with the editing world they belonged to (docs/RENDERER.md §7). What is
 * left is a document this app SHOWS and a book this app EDITS.
 */

/**
 * `book` IS THE ONE KIND THAT IS NOT A FILE.
 *
 * `pdf` is a document on disk — a scan or a facsimile, shown and never edited
 * (docs/RENDERER.md §0 A1). A `book` tab is the project's BOOK — the reflowed
 * blocks the renderer draws on the proof sheet (docs/RENDERER.md §5) — which does
 * not live in any one file the user opens: it is made from the bank at the
 * position, main decides which bank that is, and the renderer never learns where
 * it is kept. So the tab carries the PROJECT DIRECTORY in `path` and asks main
 * for the rows by naming it.
 *
 * That is why `projectDirOf` has a case for this kind and nothing else does: for
 * every other tab the project is the folder the file is IN, and for this one the
 * path IS the project.
 *
 * ── GRAVESTONE: THE `pages` KIND (Wave 41) ─────────────────────────────────
 *
 * A fourth kind stood in this union for a captured book, which was a FOLDER of
 * rectified page images: the mint wrote them and filed no document, because Owen
 * had ruled the container out. So the one thing a `pdf` tab is for — a path
 * pdf.js can be handed — did not exist for it, and pointing this app's one PDF
 * viewer at a directory is how the app came to tell somebody their pages were no
 * longer there while they sat on the disk.
 *
 * The mint writes the container again (`recordMint`, electron/projects.ts) and
 * older projects are healed into one, so a captured book opens in a `pdf` tab
 * like every other scan in the library. Three kinds, and the light table is the
 * only one of them a captured project still needs of its own.
 */
export type TabKind = 'pdf' | 'book' | 'capture';

/**
 * WHETHER THIS TAB'S `path` IS A DIRECTORY RATHER THAN A FILE.
 *
 * Named because it is the question seven sites were asking and none of them
 * said so: they tested `kind === 'book'` and MEANT "the path is a project, so
 * do not treat it as bytes". Adding `capture` as a third kind made every one of
 * those seven silently wrong — the same defaulting-switch shape the capture
 * feature has now met four times in one evening, most recently as seven
 * predicates branching on a step's action.
 *
 * So the property gets a name and the sites ask for the property. A fourth kind
 * whose path is a directory joins by being added HERE, and a fourth kind whose
 * path is a file changes nothing — which is the difference between a decision
 * recorded once and a decision re-taken correctly seven times.
 *
 * The two directory kinds are otherwise nothing alike: a `book` tab is a reading
 * of a finished book and a `capture` tab is a light table of photographs that are
 * not a book yet. They share a filesystem fact, not a nature, and every site that
 * cares about the nature still asks about the kind.
 *
 * A FOURTH KIND JOINED HERE AND NOWHERE ELSE AND LEFT THE SAME WAY, which is this
 * function's own promise kept twice. `pages` was added to the union above and to
 * this line at Wave 34, and the seven sites that ask "is the path a directory"
 * were correct for it before anybody looked at them; it was removed from the same
 * two places at Wave 41, and they were correct again.
 *
 * IT IS A TYPE PREDICATE and that is not decoration: the sites it replaces were
 * narrowing `kind` by testing it, and one of them passes the narrowed kind to a
 * function that only accepts `pdf`. A plain boolean compiled everywhere except
 * there, where it failed loudly — which is the behaviour worth having.
 */
export function pathIsProject(tab: Tab): tab is Tab & { kind: 'book' | 'capture' } {
  return tab.kind === 'book' || tab.kind === 'capture';
}

/**
 * WHETHER THIS TAB IS A FINISHED EXPORT — a book tab whose path is an EPUB FILE
 * in a project's `final/` tray, rather than a project directory.
 *
 * ── Named because two surfaces started needing the same three-part test ─────
 *
 * `viewOnly` is set in exactly one place (`openExportView`) and already means
 * this, and for one caller a flag read inline was enough. It stopped being enough
 * the moment the metadata door reopened: the menu has to decide whether to draw
 * the row and the dialog has to decide which of two engine commands to read
 * through, and those two answers must be the same answer. Two inline copies of a
 * predicate is how a menu comes to offer a dialog that then says it has nothing
 * to show.
 *
 * THE EXTENSION IS PART OF THE QUESTION and not belt-and-braces. `final/` holds
 * plain-text exports as well as books, main refuses one by name, and a caller
 * asking "is this a book I can read a `dc:` package out of" wants that answered
 * here rather than one IPC round trip later.
 *
 * IT IS THE RENDERER'S HALF OF A RULE MAIN OWNS. `exportInTray`
 * (electron/projects.ts) is what actually authorises the read and the write; this
 * only decides what to DRAW, which is why it can be a cheap string test. A tab
 * this says yes to and main says no to gets main's refusal in the dialog, which
 * is the right way round — a renderer that could authorise itself would not be
 * gated at all.
 */
export function isExportView(tab: Tab): boolean {
  return tab.kind === 'book' && tab.viewOnly === true && tab.path.toLowerCase().endsWith('.epub');
}

export interface Tab {
  id: string;
  kind: TabKind;
  /**
   * The file this tab is showing. For a conversion that has not been saved
   * anywhere, that is the copy in the managed workspace — and it stays that even
   * after Save As, because the saved file is a byte-for-byte copy and re-opening
   * it would throw away an unpack for nothing.
   *
   * FOR A `book` TAB THIS IS THE PROJECT DIRECTORY and not a file at all — see
   * `TabKind`. Everything that treats a path as bytes to open is gated on the
   * kind, and the two prefix tests that group a project's tabs together accept
   * the directory itself for exactly this one.
   */
  path: string;
  /**
   * WHAT THIS DOCUMENT IS CALLED, which is never its filename.
   *
   * A stem is built to survive a filesystem — `Working-Towards-The-Fuhrer.-
   * Kershaw-Ian.-1993` — and this app used to put that on the viewer, in the
   * window's own title bar and in the list down the left. It is the name of a
   * file, not of a book, and the two surfaces that showed it disagreed with the
   * one that did not: Home has always said "Working Towards the Führer".
   *
   * So it is the BOOK's name — the project's title where a project claims this
   * file, the book's own `dc:title` once it has been unpacked — and only where
   * neither exists does it fall back to the file, said aloud (`spokenName`).
   * The filename itself survives in the row's tooltip and in the save dialog,
   * which are the two places somebody is asking about a file rather than about
   * a book.
   */
  title: string;
  /**
   * True once something CHOSE this title, rather than it being derived from
   * whatever the document happens to be called on disk.
   *
   * IT REPLACES A STRING COMPARISON, and the comparison was the fragile part. The
   * rule has always been "never clobber a title somebody chose" — a book's
   * `dc:title` must survive the file moving between folders — and it used to be
   * enforced by testing whether the title still EQUALLED the basename, which
   * quietly stops working the moment the derived name is anything other than the
   * basename. Written down as a flag, the rule is the same rule and cannot be
   * broken by improving the fallback.
   */
  named: boolean;
  /**
   * The Chrome dot. True while no copy of this book exists anywhere the user
   * chose — it lives in the library workspace and nowhere else.
   *
   * DISTINCT FROM `modified`, and the distinction is the whole point. This one
   * is about a book nobody has filed; that one is about a filed copy that has
   * fallen behind. A tab can be either, both, or neither.
   *
   * IT IS DRAWN AND NOT ASKED ABOUT. The closing question used to fire on this
   * flag, which is true from birth for every book opened out of a project, so it
   * interrupted people who had lost nothing; the user ruled it out ("only pop up
   * a confirmation alert if changes have been made") and `questionBefore` says
   * the rest. A dot in the corner of a card is the right weight for "this lives
   * in the library and nowhere else" — a modal is not.
   */
  unsaved: boolean;
  /**
   * Edited since the copy at `savedPath` was written.
   *
   * The app DOES edit documents now (the chapter editor), so "nothing in this
   * app modifies a document" is no longer true and this flag is what replaced
   * it. It never means the edits are at risk: every keystroke that lands is
   * written through to the workspace copy before this is set.
   */
  modified: boolean;
  /**
   * Where Save/Save As put it, once it has been anywhere. Seeded with the file
   * itself for a book opened from the user's own disk — that file is already a
   * copy they chose, and Save should update it rather than ask.
   */
  savedPath: string | null;
  /**
   * True while the PDF viewer is showing the text layer beside the page.
   *
   * On the TAB rather than in the component, for the same reason `thumbnails`
   * is: only the shown tab's viewer is in the DOM, so a component that held
   * this would forget it the moment the user looked at something else. A view
   * mode that resets itself when you glance away is a view mode you stop using.
   */
  layerView: boolean;
  /**
   * A BOOK TAB THAT SHOWS A FINISHED EXPORT, read-only — the proof sheet locked
   * to the Final version register over an exploded copy of the file. Its path
   * is the EPUB itself, not a project directory, and nothing about it is a
   * position: no stack, no Apply, and Ctrl+S saves a copy of the export.
   */
  viewOnly?: boolean;
  /** True while the PDF viewer's thumbnail strip is up. ON by default — it sits
   *  along the bottom where it costs little, and Owen wants the pages in reach. */
  thumbnails: boolean;
  /**
   * Bumped on every flush that reached disk.
   *
   * It is what makes the viewer re-read a document whose PATH did not change: a
   * rendering replaces the project's PDF at the same name, and a viewer with no
   * reason to believe the bytes moved would go on showing the old ones. The
   * pdf.js viewer watches path AND revision for exactly that.
   */
  revision: number;
  /** Why this tab has nothing in it, when that happens. Never swallowed. */
  problem: string | null;
}

/**
 * The job kinds that become a tab when they finish.
 *
 * A set rather than a chain of comparisons because the list has grown twice
 * now, and each time the test lived inline it was one `||` away from a kind
 * that finishes and is never seen. What is NOT here is deliberate: `txt` has no
 * tab to open into, `env-install` made no document at all, and `read` made no
 * document EITHER — its product is the bank, which is not a thing anybody looks
 * at. What you look at is what you generate from it, and generating is one of
 * the two kinds above, which is exactly why they open themselves: somebody
 * asks for an EPUB precisely because they want to read it.
 *
 * `translate` left this set when its product became a records file. Its
 * `.jsonl` is a bank's kind of thing — nobody reads it — and opening it here
 * produced a refusal notice per finished translation. The translated BOOK
 * still arrives in front of the person, by the other door: the position moves
 * onto the translate row, the viewer follows through `showPosition`
 * (`PositionSyncService`), and the cast that renders it carries `forStep`,
 * which the auto-open effect already skips.
 */
export const OPENS_ITSELF: ReadonlySet<JobKind> = new Set<JobKind>(['pdf']);

/**
 * No tabs at all — the default for `questionBefore`'s second argument.
 *
 * A shared frozen empty set rather than a `new Set()` per call: an ordinary close
 * asks about one tab and has nothing to carry, and allocating a set to say so on
 * every ✕ is a small thing done often.
 */
export const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/*
 * FOUR HELPERS LIVED HERE AND THEY WERE ALL COLUMN ARITHMETIC: `equalise` (every
 * pane an equal share of the row), `addToStrip` (insert directly after the tab on
 * top, which is where a person expects the next thing to appear), `withoutTabs`
 * (closing falls back to the neighbour on the right, then the left) and
 * `crowdedTarget` (which of five columns a document that wanted one of its own has
 * to settle for). Every one of them answered a question the single viewer does not
 * ask — see this file's header for the ruling that stopped asking it.
 */

/**
 * Windows paths differ by case and separator and are the same file.
 *
 * EXPORTED FOR `PositionSyncService`, which compares a step's resolved document
 * against the paths of the tabs this file holds. One spelling of that comparison,
 * in the file that owns the paths — two copies of four characters is how two
 * services learn to disagree about whether `C:\A\b.pdf` and `c:/a/B.pdf` are one
 * document. (`fold` in @shared/original is the neighbouring rule and NOT the same
 * one: it also strips a trailing separator, which is right for a directory and
 * wrong for a file.)
 */
export function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

export function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * What the save dialog opens pre-filled with.
 *
 * THE FILE'S OWN NAME, AND THIS IS ONE OF THE TWO PLACES A FILENAME BELONGS.
 * Everywhere else in this window a document is called by its book — the viewer's
 * toolbar, the list on the left, the window's title bar — because a person
 * reading their library is thinking about books. A person in a save dialog is
 * thinking about a FILE: it is going into a folder of theirs, beside things they
 * named, and it has to be findable there by whatever their other copy of it is
 * called. It used to be fed the tab's title, which was the same string as the
 * basename for a PDF and quietly stopped being one the moment titles became the
 * book's.
 *
 * The characters removed are the ones Windows refuses outright; a name with a
 * colon in it is common (`Working Towards The Fuhrer: …`) and a save dialog that
 * opened pre-filled with an illegal name would fail on OK with a message from
 * the OS rather than from us.
 */
export function suggestName(fileName: string, extension: '.epub' | '.pdf'): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = cleaned.length > 0 ? cleaned : 'book';
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
}
