import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { positionPicture, positionView, type PositionView } from '@shared/ledger';
import { unwritten, type BookOp, type Replayed } from '@shared/ops';
import { fold } from '@shared/original';
import type { JobKind } from '@shared/types';

import { LedgerService } from './ledger.service';
import { ProjectsService } from './projects.service';
import { QueueService } from './queue.service';
import { api } from './foundry';

/**
 * The open documents — the list down the left, and the one place that knows
 * which is which.
 *
 * TABS ARE RENDERER STATE, on purpose. Main owns everything with a lifetime — a
 * conversion, an unpacked book's temp directory, the allow-list — but which of
 * them is on screen and in what order is a window's own business, and pushing
 * that through IPC would make a reload of the renderer able to disturb it.
 *
 * The one door in is `document:opened`. The menu, the dialog, a drop, a path on
 * argv and a conversion that just finished all reach main first (which decides
 * whether the file is openable at all) and arrive back here as that event. So
 * this service never has to decide whether a path is real, and there is exactly
 * one code path that creates a tab.
 *
 * ── Panes ────────────────────────────────────────────────────────────────────
 *
 * The workspace is one to five PANES side by side, and A PANE HOLDS A STACK OF
 * DOCUMENTS AND SHOWS ONE OF THEM. They exist for one comparison in particular:
 * a book beside its translation, the German page and the English page under two
 * hands at once. Everything else about panes follows from that, including the
 * auto-open rule (a translation lands in a pane of its OWN, so it appears beside
 * its source rather than on top of it).
 *
 * ── The strips came back, and this comment is the reversal ───────────────────
 *
 * EACH PANE USED TO CARRY A CHROME-STYLE STRIP of its own — VS Code's editor
 * groups, a stack of tabs per column — and this paragraph used to record why
 * they were taken away: five columns on a 1920-wide window give each strip 370
 * pixels, three tabs in one of them are unreadable stubs, and a VERTICAL LIST in
 * a panel of its own (app-open-documents) does not degrade with the number of
 * columns. Every word of that is still true and it was still the wrong trade,
 * because it measured the strip as a NAVIGATOR and the strip's job was never
 * only navigation.
 *
 * The user specced them back, in these words: *"clicking another file will
 * automatically close the one i was looking at and open the one i just clicked,
 * unless i pin the file by right-clicking the chrome-style tab at the top"*, and
 * *"if they grab the tab and drag it to one of the sides, it enters split screen
 * with the tab that was currently active when they dragged it"*. PIN, DRAG-SPLIT
 * AND CLOSE are what a strip is for this time — three gestures that need
 * something to point at, and a vertical list of every document in the window
 * cannot be that something, because none of the three is about the window. They
 * are about THIS COLUMN: what it is holding, what it may throw away when the next
 * click lands, and what it should tear off into a column of its own.
 *
 * The narrow-strip complaint is answered by the auto-close rule rather than by
 * removing the strip: a column accumulates tabs only where somebody PINNED one,
 * so the ordinary five-column window has one tab per strip and reads exactly as
 * it did without them. The documents list stays — it is the project and export
 * navigator, which is a different job, and it is still the only place a
 * document's order in the WINDOW lives.
 *
 * THE TABS STAY IN ONE FLAT LIST and the panes hold ids into it. A pane owning
 * whole Tab objects would put `patch()` — the one function every edit, save and
 * flag in this file goes through — behind a search of a list of lists, and the
 * first thing to rot would be an edit landing in one pane's copy of a tab while
 * another pane showed the other. One list, one identity per tab; the panes
 * decide only where each is shown and which of theirs is on top.
 *
 * A DOCUMENT IS IN AT MOST ONE PANE, and the strips did not weaken that. It is
 * in at most one STRIP: clicking a row for something already on screen REVEALS
 * it rather than putting a second viewer over one unpack — the rule `adopt()`
 * has always enforced for files — and dragging a tab between strips MOVES it.
 * Two panes on one tab would also share its `chapterHref`, so the two columns
 * would look scroll-locked to each other for reasons nothing on screen explains.
 *
 * ONE PANE IS FOCUSED, and it is what the rail, the menu and the keyboard mean
 * by "the document": `active()` is the focused pane's document and nothing else.
 * With a single pane open, that is exactly the app that existed before panes did
 * — the feature is meant to be invisible until it is used.
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
 * (docs/RENDERER.md §0 A1). A `book` tab is the project's BOOK — the reflowed blocks the renderer draws on the proof sheet
 * (docs/RENDERER.md §5) — which does not live in any one file the user opens: it
 * is made from the bank at the position, main decides which bank that is, and the
 * renderer never learns where it is kept. So the tab carries the PROJECT
 * DIRECTORY in `path` and asks main for the rows by naming it.
 *
 * That is why `projectDirOf` has a case for this kind and nothing else does: for
 * every other tab the project is the folder the file is IN, and for this one the
 * path IS the project.
 */
export type TabKind = 'pdf' | 'book';

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
   * Kershaw-Ian.-1993` — and this app used to put that on the pane, in the
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
   * the rest. A dot in the corner of a tab is the right weight for "this lives in
   * the library and nowhere else" — a modal is not.
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
   * is: only the active tab's viewer is in the DOM, so a component that held
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
   * PINNED — right-clicked in its strip and told to stay.
   *
   * ── What it protects against, which is a rule and not an accident ───────────
   *
   * Clicking a document in the left nav REPLACES what the focused column was
   * showing (see `place`), because the user asked for exactly that: *"clicking
   * another file will automatically close the one i was looking at and open the
   * one i just clicked, unless i pin the file by right-clicking the chrome-style
   * tab at the top."* So the ordinary column holds one tab and browsing a
   * project's documents does not accumulate a strip of them — and a pin is how
   * somebody says "not this one" about the page they are working against.
   *
   * A PINNED TAB ALSO HIDES ITS ✕, which is the same statement said twice on
   * purpose: the gesture that closes and the gesture that closes-by-replacement
   * are one decision, and a pin that stopped only the quiet one would be a pin
   * that fails in the way nobody tests.
   *
   * ON THE TAB, like `layerView`, and NOT PERSISTED for its reason exactly: five
   * panes can each hold a different document, a global flag would pin all of
   * them, and a pin restored from last week would be the app refusing to reuse a
   * column for a reason nobody in the room remembers.
   */
  pinned: boolean;
  /**
   * Bumped on every flush that reached disk.
   *
   * It is what makes a pane re-read a document whose PATH did not change: a
   * rendering replaces the project's PDF at the same name, and a viewer with no
   * reason to believe the bytes moved would go on showing the old ones. The
   * pdf.js pane watches path AND revision for exactly that.
   */
  revision: number;
  /** Why this tab has nothing in it, when that happens. Never swallowed. */
  problem: string | null;
}

/**
 * A column of the workspace: a strip of documents, one of them on screen.
 *
 * IT WAS ONE `tabId` AND IT IS A LIST NOW, which is the strips coming back (see
 * this file's header). The two fields are separate rather than "the first of the
 * list is the active one" because the strip's ORDER is the user's — they drag
 * tabs around in it — and which one is on top is a different question they answer
 * by clicking. Folding the two would mean every activation reordered the strip
 * under the hand that clicked it.
 *
 * `activeTabId` of null means this pane is showing HOME — which is what a column
 * with nothing in it has always shown, back when there was only ever one. It is
 * what Ctrl+\ makes (an empty column to drop a document into, with an empty
 * strip), and it is also what the rail's Home button makes of a column that still
 * has a strip: the tabs stay listed, one click from coming back.
 */
export interface Pane {
  id: string;
  /**
   * The strip, left to right. Every id is in the flat tab list, and no id is in
   * two panes' strips — see the header's "a document is in at most one pane".
   */
  tabIds: string[];
  /** Which of them is on screen. Null is Home, including for an empty strip. */
  activeTabId: string | null;
  /**
   * The pane's share of the row, as a flex-grow number.
   *
   * In memory only, and deliberately: a layout is a thing you arrange for the
   * comparison you are doing right now, and restoring last week's column widths
   * over this week's two books would be furniture arriving in the wrong room.
   */
  flex: number;
}

/**
 * Five, and the number is a judgement rather than a limit of the code.
 *
 * A sixth column on a 1920-wide window is 300 pixels of book, which is a column
 * of hyphens. The cap is also what makes the auto-open rule terminate: past it,
 * a finished job takes the RIGHTMOST column's slot instead of narrowing
 * everything — and the book that was there is still open in the list, one click
 * from coming back.
 */
export const MAX_PANES = 5;

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
 * onto the translate row, the pane follows through `showPosition`, and the
 * cast that renders it carries `forStep`, which the auto-open effect already
 * skips.
 */
const OPENS_ITSELF: ReadonlySet<JobKind> = new Set<JobKind>(['pdf']);

/**
 * No tabs at all — the default for `questionBefore`'s second argument.
 *
 * A shared frozen empty set rather than a `new Set()` per call: an ordinary close
 * asks about one tab and has nothing to carry, and allocating a set to say so on
 * every ✕ is a small thing done often.
 */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** What a rendered chapter reported being clicked, for the editor to jump to. */
export interface SourceJump {
  /** The EPUB tab the click came from. Its editor, if any, is the one that moves. */
  tabId: string;
  bf: boolean;
  tag: string;
  index: number;
  /**
   * Bumped per click, and it is what makes a SECOND click on the same block do
   * anything at all: the payload would otherwise be identical, the signal would
   * not change, and the editor's effect would never run.
   */
  seq: number;
}

/**
 * The blocks one frame says are selected.
 *
 * A SET, since the marquee: a drag over empty space takes everything it
 * touches, shift and ctrl/cmd extend a click, and every gesture in the mode —
 * Delete, the inspector's relabel — acts on all of them as one batch.
 *
 * IT IS NOT A FACT ABOUT THE BOOK, and it is NOT IN THE UNDO STACK. A selection
 * lives in the frame's DOM and dies with the frame; nothing on disk records it,
 * and a reload starts with nothing selected. It is held here only because the
 * inspector — which is in the shell, not in the pane — has no other way to
 * learn what the user clicked. (BookForge puts its selection in the history and
 * pays for it with a special case in three separate places.)
 */
export interface FrameSelection {
  blockIds: readonly string[];
  /**
   * The `data-bf-cat` they all share, so the inspector can mark the row the
   * selection already is — and null the moment two of them disagree, because a
   * marked row over a mixed selection is the panel asserting something untrue
   * about most of what is highlighted.
   */
  category: string | null;
}

/** How many blocks of each category the rendered chapter holds, and how many are struck. */
export interface CategoryCounts {
  counts: Readonly<Record<string, number>>;
  struck: Readonly<Record<string, number>>;
}

/*
 * `LedgerField`, `LedgerRow`, `LedgerAction` and `LedgerStacks` MOVED TO
 * shared/types.ts, because the ledger is written to disk now and main is what
 * writes it. Main still never replays a row — that is entirely this file's,
 * through the setters — but it does have to recognise the shape, so that a
 * history file carrying a field no setter answers to is refused as the wrong
 * shape rather than handed to a Ctrl+Z that would fall through every branch.
 */

/**
 * The list under one key, made on first use. Grouping rows for one repaint call.
 *
 * Generic in what it holds as well as in the key: a replay groups ids for the
 * frame to repaint AND the decisions those rows owe the curation, and two
 * copies of four lines is how the two would learn to behave differently.
 */
function bucket<K, V>(map: Map<K, V[]>, key: K): V[] {
  const found = map.get(key);
  if (found) return found;
  const made: V[] = [];
  map.set(key, made);
  return made;
}

/**
 * The picture one project's panes are showing, and the string that decides
 * whether it has moved.
 *
 * BOTH TOGETHER, never one without the other. The view is what a repaint acts on
 * and the string is what a repaint is decided by, and they are made in one call
 * (`pictureIn`) so that no surface can compare by one answer and act on another.
 */
interface ShownPicture {
  view: PositionView;
  picture: string;
}

/**
 * THE BOOK PANE'S STACK, as everything outside that pane needs it.
 *
 * ── Why a wire exists at all, when the selection deliberately has none ──────
 *
 * The book pane keeps its selection to itself on a stated rule: surface-local
 * state stays local until something else genuinely needs it, and a wire with
 * nothing on either end is worse than no wire. The stack is the case where
 * something else does need it, and TWO things do.
 *
 * THE UNDO CHORD IS ROUTED, not listened for. Ctrl+Z is a menu accelerator that
 * main swallows on its way past, and the renderer decides which of the undos a
 * chord meant — a text box's, the rendered frame's, or the book's
 * (`MenuAction`, shared/api.ts). `replay` is where that decision is made, and a
 * global key listener added by the pane would be a second answer fighting the
 * first.
 *
 * AND CLOSING IS ASKED ABOUT IN ONE PLACE. `questionBefore` is the one dialog a
 * closing tab gets, on this file's own ruling that a person shutting a book is
 * asked once about everything it costs. The stack is in memory and closing
 * genuinely scraps it (docs/RENDERER.md §3), so that question has to be able to
 * see it — and, because a card whose only route to keeping the work is *cancel,
 * find Apply, close again* has made the user do the app's job, it has to be able
 * to press Apply too.
 *
 * IT IS AN INTERFACE THE PANE IMPLEMENTS rather than state this service holds,
 * which is the whole of what keeps the ruling intact: the ops still live in the
 * component that makes them, and what crosses the boundary is a set of questions
 * and a set of verbs.
 *
 * ── AND NOW THE PANELS, WHICH IS WHY IT GREW ────────────────────────────────
 *
 * Notes, Furniture review and Chapters live in the app shell and keep its dark
 * style (RENDERER-DESIGN.md §5), which puts them OUTSIDE the pane whose stack
 * their every gesture pushes onto. A panel that kept its own list of notes would
 * be a second account of the book — the exact failure the replay exists to make
 * impossible — so what crosses here is the pane's OWN replay, read as a signal,
 * and one verb that puts ops on the pane's own stack. Undo, redo and Apply then
 * take a panel's decision back exactly as they take a decision made on the paper,
 * because there is one stack and it is the pane's.
 *
 * THE SELECTION CROSSED WITH THEM, and it crossed as a QUESTION rather than as
 * state. The pane's own rule was that its selection stays local *until something
 * else genuinely needs it* — "the day the inspector can act on it, it moves up".
 * That day is this one: "a chapter starts at the selected block" is a panel
 * button about a block picked on the paper. It is still the pane's signal, still
 * in no undo stack and still gone on a reload; the panel reads it and cannot
 * write it.
 */
export interface BookStack {
  /** How many changes are waiting with no Apply behind them. */
  pending(): number;
  /** True when there is anything to take back. Both directions, for the notice. */
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  /** Land the stack as a step. Resolves false when main refused; the sentence is its own. */
  apply(): Promise<boolean>;
  /**
   * THE BOOK AS THE SHEET IS DRAWING IT — the file with the chain and the stack
   * replayed, and null while the pane is still opening.
   *
   * A SIGNAL READ, so a panel calling it inside a computed repaints with the
   * paper. It is the pane's own `view()` and not a copy of it: the rows the
   * Notes panel lists and the rows on the sheet are one array, so the two cannot
   * disagree about what this book says.
   */
  view(): Replayed | null;
  /** The blocks picked on the paper. Read-only, and never a fact about the book. */
  selected(): ReadonlySet<string>;
  /**
   * True when the ops own the divisions — the first chapter op takes the list
   * over and `reset` hands it back (`Replayed.chapters`).
   *
   * The panel needs it twice: to say whose list the rows are, and to know whether
   * "Use Foundry's" has anything to give back. A reset pushed over a seed already
   * in force would be a row in somebody's history recording a change that changed
   * nothing.
   */
  chaptersOwned(): boolean;
  /** Ops onto the same stack the gestures on the paper push onto. */
  push(ops: readonly BookOp[]): void;
  /** Put a block in the middle of the sheet and pulse it — the panels' jump. */
  reveal(id: string): void;
}

/** One project whose position has moved since this window last painted it. */
interface PositionMove {
  /** The project directory, folded — the key `showing` is kept under. */
  key: string;
  /**
   * The same directory AS MAIN SPELLS IT, kept beside the folded key.
   *
   * The key is folded because on Windows one path arrives spelled three ways and
   * two spellings of one project would be two entries. What must NOT be folded is
   * what goes back over IPC: main proves the directory is one of Home's projects
   * before it reads a byte, and a lowercased path is a project on this filesystem
   * and a stranger to a string comparison. (`LedgerService.Holding` keeps both for
   * the identical reason.)
   */
  dir: string;
  /** What the panes were showing, or null for a project this window has just met. */
  was: ShownPicture | null;
  now: ShownPicture;
}

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly queue = inject(QueueService);
  /**
   * The library, read only to NAME things.
   *
   * Nothing about a tab's life depends on it — a document opens, unpacks, edits
   * and saves whether or not a project has claimed it — which is why this is the
   * one thing asked of it. The alternative was for every surface that draws a
   * document (the list, the pane's toolbar, the window's title bar) to look the
   * project up for itself, and three lookups of one fact is three chances for
   * two of them to disagree about what a book is called, which is the exact
   * failure this whole change exists to end.
   */
  private readonly projects = inject(ProjectsService);

  /**
   * The step ledger, read for the POSITION — which step each project is standing
   * on, and what document that resolves to.
   *
   * It was also read for a gate: may this document be corrected right now? That
   * question had an answer while there were two curations to write into and
   * standing on a save decided which one a gesture reached. Standing on any step
   * is a replay of that chain now (docs/RENDERER.md §3), editing from an old one
   * branches, and there is nothing to diverge — so the gate is gone and this is
   * the position and nothing else.
   *
   * The dependency runs ONE WAY. `LedgerService` knows about projects and the
   * confirm card and nothing about tabs; everything this side wants to happen to a
   * pane after a step changed is arranged here.
   */
  private readonly ledger = inject(LedgerService);

  private readonly all = signal<Tab[]>([]);
  private readonly columns = signal<Pane[]>([]);
  private readonly focused = signal<string | null>(null);

  /**
   * Every open document, in the order the list shows them.
   *
   * THE ORDER IS THIS LIST'S, now that the strips are gone: there is nowhere
   * else a document sits in a sequence, so `reorder` writes here and the panel
   * renders it straight.
   */
  readonly tabs = this.all.asReadonly();
  readonly panes = this.columns.asReadonly();
  readonly focusedPaneId = this.focused.asReadonly();

  readonly focusedPane = computed<Pane | null>(() =>
    this.columns().find((pane) => pane.id === this.focused()) ?? null);

  /** Null means Home — which is also what "no panes open at all" looks like. */
  readonly activeId = computed<string | null>(() => this.focusedPane()?.activeTabId ?? null);
  readonly active = computed<Tab | null>(() => this.byId(this.activeId()));

  /**
   * The DOCUMENT the user is working on, which is not always the active tab.
   *
   * An editor tab is a face of its book, so with the editor pane focused the
   * rail's Translate, the OCR dialog's source and Ctrl+S must all still mean
   * the book. Everything that acts on "what I am looking at" reads this;
   * `active()` stays literal, for the things that mean the tab itself.
   */
  readonly activeDocument = computed<Tab | null>(() => this.active());

  readonly canSplit = computed(() => this.columns().length < MAX_PANES);

  /**
   * The last thing that went wrong out here rather than inside a tab: a drop
   * this app will not open, a save that failed. Shown as a strip under the tabs
   * and dismissed by hand — a refusal that vanished on a timer is a refusal the
   * user gets to wonder about.
   */
  readonly notice = signal<string | null>(null);

  /** The tab whose chapter is being written right now, for the "Writing…" line. */
  readonly writingTo = signal<string | null>(null);

  /**
   * True from the moment a row leaves the document list until the drag ends.
   *
   * IT EXISTS BECAUSE OF THE <iframe>. A rendered chapter is a frame with its
   * own browsing context, and a drag over it delivers dragover/drop to THAT
   * document — the pane underneath would never see the pointer, so a book could
   * not be dropped onto the one thing a person aims at. The workspace lays a
   * transparent shield over every pane while this is on, and takes it away the
   * instant the drag is over so nothing normal is intercepted.
   *
   * Whether a drag is happening, and NOT what it carries: the id is unreadable
   * until the drop (that is the platform's rule, not ours), so the drop preview
   * is still driven by the pointer's position alone.
   */
  readonly draggingDocument = signal(false);

  /** The most recent click-to-source, for whichever editor is watching that book. */
  readonly sourceJump = signal<SourceJump | null>(null);
  private jumpSeq = 0;

  /**
   * Paths that will arrive as UNSAVED tabs: a conversion's output, or a
   * workspace book re-opened from Home.
   *
   * A set consulted on the way in, rather than a flag on the open call, because
   * the open call and the tab's creation are on opposite sides of an IPC round
   * trip through main.
   */
  private readonly expectUnsaved = new Set<string>();

  /** Paths that will arrive wanting a pane of their own. Same round trip, same trick. */
  private readonly expectOwnPane = new Set<string>();

  /**
   * Paths that will arrive meaning to TAKE THE PLACE of what the focused column
   * is showing — the documents list's click, and nothing else.
   *
   * The user's rule (`Tab.pinned`) is about the nav: browsing a project's
   * documents reuses one column rather than stacking five tabs nobody asked for.
   * Everything else that opens — a drop, a finished job, a step's document —
   * JOINS the strip, because none of those is somebody saying "instead of this".
   */
  private readonly expectReplace = new Set<string>();

  /**
   * Paths that will arrive wanting a NAMED column, keyed the same way.
   *
   * It is how a project's own book gets to the column that project is already
   * being read in, rather than to whichever one happens to be focused. See
   * `place`'s `intoPane`.
   */
  private readonly expectPane = new Map<string, string>();

  /** Conversions already turned into a tab, so a queue push cannot open a second. */
  private readonly openedJobs = new Set<string>();

  /**
   * An open editor's "write what is in the box, now".
   *
   * Registered by the editor component, because the draft lives in its textarea
   * and nothing out here can see it. `close()` awaits it before it asks the user
   * anything: the debounce is 700 ms, and closing a tab inside that window used
   * to throw away the last sentence typed AND ask a question about a `modified`
   * flag that had not been set yet.
   */
  private readonly pendingFlush = new Map<string, () => Promise<void>>();

  private sequence = 0;
  private paneSequence = 0;

  constructor() {
    api?.onDocumentOpened((absolutePath) => { this.adopt(absolutePath); });
    api?.onDocumentRelocated(({ from, to }) => { this.relocate(from, to); });

    /*
     * THE PROJECT THE WINDOW IS IN, remembered past its last tab. Closing every
     * tab used to bounce the window to Home, which reads as being thrown out of
     * the room you were working in (user ruling, 2026-08-16): the workspace now
     * keeps the project — its tree stays up, its empty bench says a step is one
     * click away — until the person leaves for the library on purpose
     * (`releaseProject`). Written from an effect on the active tab rather than
     * at close time, because "the project you were in" is a fact about what was
     * shown, not about what was shut.
     */
    effect(() => {
      const tab = this.active();
      if (tab === null) return;
      const dir = this.projectDirOf(tab);
      if (dir !== null) this.heldProject.set(dir);
    });

    /**
     * A finished conversion opens itself.
     *
     * Watching the queue MIRROR rather than being told by whatever enqueued the
     * job: the job outlives the dialog that started it, outlives a trip to
     * Settings, and (because main owns the queue) outlives a reload of this
     * window. The only fact that matters is that a row reached `done`.
     *
     * EPUB and PDF both, because both have a tab to open into and looking at
     * the result is the next thing anybody does — a reprinted PDF is a claim
     * about every page of a book, and the claim is checked by eye. txt stays
     * shelf-only:
     * there is no text tab, and the OS opens it from reveal.
     *
     * A TRANSLATION IS THE THIRD, and it is the one this matters most for: it
     * runs for hours, so the person who ordered it is not watching, and the
     * book appearing in a tab is how they find out it finished at all.
     *
     * IN A PANE OF ITS OWN, which is what the panes are for: the translation
     * arrives beside the book it was made from, and the two are readable
     * against each other without a single gesture from the user.
     *
     * Jobs already finished when this window loaded are marked as seen without
     * opening: a reload should not reopen five books somebody closed.
     *
     * A SAVE'S OWN BOOK IS THE EXCEPTION, and it is the one job here nobody
     * ordered. Applying changes casts the book as of that save (`forStep`, the
     * per-save cast), which is a rendering the app made for itself so that
     * standing on an older save shows the book that save made — and it lands in
     * the middle of somebody correcting the next paragraph. Every other job in
     * this list is a thing a person pressed a button for and is waiting on; this
     * one would be a tab arriving in front of work in progress, for a document
     * they can already reach by clicking the row it belongs to.
     */
    let first = true;
    effect(() => {
      const jobs = this.queue.jobs();
      for (const job of jobs) {
        if (!OPENS_ITSELF.has(job.kind) || job.forStep !== undefined || job.state !== 'done') continue;
        if (this.openedJobs.has(job.id)) continue;
        this.openedJobs.add(job.id);
        if (first) continue;
        this.openFinished(job.outputPath, job.kind);
      }
      if (jobs.length > 0) first = false;
    });

    /**
     * A DOCUMENT LEARNS ITS BOOK'S NAME LATE, and this is what tells it.
     *
     * A file opened from outside the library is imported in the background: the
     * tab exists before the project does, so at the moment it is made there is
     * nothing to ask and the name falls back to the file. The project arrives
     * some hundreds of milliseconds later as `projects:changed`, and without
     * this the tab would keep the fallback for the rest of the session — the
     * list on the left saying one thing about a book while Home said another,
     * which is the disagreement this is all for.
     *
     * ONLY WHERE NOBODY CHOSE A NAME. `named` is the whole guard: an unpacked
     * book's `dc:title` is a better answer than any project title and is never
     * overwritten by this. Nor is the editor's "<book> — HTML".
     *
     * It converges in one pass and cannot loop: the patch below is the only
     * write, it happens only when the name actually moved, and the run it
     * triggers finds the same answer already in place.
     */
    effect(() => {
      this.projects.items();
      for (const tab of this.all()) {
        if (tab.named) continue;
        const want = this.titleFor(tab);
        if (want !== tab.title) this.patch(tab.id, { title: want });
      }
    });

    /**
     * THE POINTER MOVED, SO THE PANES SHOW THE STEP THE USER IS STANDING ON.
     *
     * ── What clicking a row used to do, which was very nearly nothing ────────
     *
     * `docs/STEP-LEDGER.md` has promised since the day the ledger was designed
     * that the position decides what the viewers show, and this effect used to
     * keep about a third of that promise. It re-read the CURATION and left the
     * blocks under it exactly where they were, which is correct only while both
     * rows are about one reading: move between two readings and the pane went on
     * drawing the first reading's boxes with the second reading's corrections over
     * them, silently, with nothing on screen admitting the swap. And it was
     * guarded on the pane already being in the block editor, so for a scan nobody
     * had pressed Blocks on — and for the import row, where the honest picture is
     * no outlines at all — a click on a row in somebody's own history did
     * literally nothing. That is what a user with a two-step project saw: they
     * clicked the import, they clicked the read, and the app sat there.
     *
     * ── What it does now: make the pane match the answer ─────────────────────
     *
     * `positionView` (shared/ledger.ts) says what the picture at the position IS —
     * which reading's bank, which corrections over it, whether there are outlines
     * at all — and this effect's whole job is to make the panes of that project
     * agree with it. Nothing here re-derives any of that; the day a read row comes
     * to mean a reflowed HTML document rather than a scan with boxes on it
     * (docs/DERIVED-BOOK.md §6 phase B), the answer changes shape and this loop
     * does not.
     *
     * A MOVE THAT CHANGES THE BANK RELOADS; A MOVE THAT CHANGES ONLY THE
     * CORRECTIONS DOES NOT. Re-reading a bank is a spawn of the engine and a
     * re-measure of five hundred pages, and putting that behind the one gesture in
     * this app that is meant to be free is the exact ceremony a history panel
     * promises it does not have. So a save and the reading it was made from — two
     * rows, one bank — cost one small file read between them, and only a genuinely
     * different reading pays for the blocks. `positionPicture` is what makes that
     * distinction; the step id would have been wrong in both directions.
     *
     * ── Keyed by PROJECT, and the first sighting is a baseline ───────────────
     *
     * By project because the position is a fact about a book rather than about a
     * viewer of one, and because two panes onto one project must not each decide
     * separately what that book is standing on.
     *
     * THE FIRST SIGHTING RECORDS AND ACTS ON NOTHING. Opening a document must
     * not be read as a move. A pointer move is a
     * DIFFERENCE from what this window was last showing, and a project it has
     * never seen has no difference to be. The entry is dropped again when the last
     * tab of that project closes, so a reopen baselines afresh rather than
     * inheriting a picture from a session nobody is in any more.
     */
    effect(() => {
      const moves: PositionMove[] = [];
      const open = new Set<string>();
      for (const tab of this.all()) {
        const dir = this.projectDirOf(tab);
        if (dir === null) continue;
        const key = fold(dir);
        if (open.has(key)) continue;
        open.add(key);
        const now = this.pictureIn(dir);
        // Nobody has read this project's history yet, so there is no position to
        // obey. It arrives as its own change and is baselined then.
        if (now === null) continue;
        const was = this.showing.get(key) ?? null;
        if (was !== null && was.picture === now.picture) continue;
        moves.push({ key, dir, was, now });
      }
      /*
       * WHICH COLUMNS ARE OPEN IS NO LONGER READ HERE, and its absence is the
       * ruling rather than an oversight. This used to be tracked so that a move
       * with nowhere to be shown could put a sentence on the strip and then re-ask
       * once a column appeared. There is no such state any more: clicking a row is
       * an instruction to LOOK at that step, so a document that is open but in no
       * column is put in one and a document that is not open is opened. The app
       * does the thing instead of explaining why it cannot.
       */
      untracked(() => {
        for (const key of [...this.showing.keys()]) {
          if (!open.has(key)) {
            this.showing.delete(key);
            // The resolved document goes with the picture it belonged to, for the
            // same reason: a reopen baselines afresh rather than measuring against
            // what a session nobody is in was showing.
            this.forgetShown(key);
          }
        }
        for (const move of moves) {
          this.showing.set(move.key, move.now);
          if (move.was === null) {
            /*
             * THE FIRST SIGHTING STILL MOVES NOTHING, AND IT NO LONGER LEAVES THE
             * DOCUMENT UNKNOWN.
             *
             * It used to `continue` outright, which was right while the resolved
             * document was bookkeeping for `followDocuments` alone. It is not any
             * more: the rail and the dialogs ask what document the position is
             * showing before they decide what a button does (docs/WORKBENCH.md
             * §6c), and a project met a moment ago answered "I do not know" —
             * which is how Translate came to sit dead over a book that was
             * plainly on screen. Nothing here is put on screen by asking; it
             * records what the position resolves to, exactly as the sweep does on
             * every announce, so that the first question a button asks has an
             * answer.
             */
            void this.baselineShown(move.dir, move.key);
            continue;
          }
          void this.showPosition(move);
        }
      });
    });

    /**
     * THE POSITION DID NOT MOVE AND THE DOCUMENT UNDER IT DID.
     *
     * ── Why the picture above cannot see this by itself ────────────────────────
     *
     * `positionPicture` (shared/ledger.ts) is composed of the reading, the
     * corrections and — for a row that shows its own payload — the row: the three
     * things the LEDGER knows that decide what is on screen. Which file a read row
     * actually resolves to is not one of them, and cannot be: it is main's
     * bookkeeping, answered over IPC (`ledger:document-at`), and the effect above
     * is synchronous. So a project standing still while its document changes
     * underneath is invisible to that key by construction.
     *
     * And it changed, on the path this app cared most about, for as long as a
     * position could resolve to one document and then to another: main answered a
     * read row that came back as the scan by casting the book, so seconds later
     * the same position resolved to an EPUB with nothing in the ledger having
     * moved. There are no casts now (docs/RENDERER.md §7) and a read row is drawn
     * on the sheet, so that particular swap cannot happen — but the effect stays,
     * because the reason it was built is the complaint it was built for: *"i
     * wanted the document to show."*
     *
     * ── An effect of its own, on the delete effect's precedent ─────────────────
     *
     * The same shape as "a step was deleted, so the panes read their state again"
     * above: a fact the position cannot express, on a trigger of its own, acting
     * only where something actually CHANGED. `projects.items()` is that trigger —
     * main announces the projects whenever a catalogue does anything, which
     * includes the landing that files a cast — and the acting is `showPosition`,
     * the one door that puts a position's document on screen.
     *
     * IT ASKS MAIN AND NEVER GUESSES. Reading the catalogue here to work out
     * whether a cast has appeared would be a second opinion about a resolution
     * that is deliberately main's alone (`showPosition` says why at length), and
     * it would be wrong in exactly the place it is dearest — a branch read, a
     * rotated cast. One IPC per open project per announce, and announces are
     * landings and imports rather than keystrokes.
     *
     * THE FIRST ANSWER FOR A PROJECT IS A BASELINE AND MOVES NOTHING, which is
     * the position effect's own first-sighting rule said about the document
     * instead of the picture: a window that has just met a project has no
     * difference to act on.
     *
     * A BASELINE IS NOT A NO-OP ANY MORE, THOUGH — see the position effect above,
     * which now asks for the document at a position it is meeting for the first
     * time instead of leaving it unknown until something announces.
     */
    effect(() => {
      this.projects.items();
      untracked(() => {
        this.openAwaitedBooks();
        void this.followDocuments();
      });
    });
  }

  /**
   * What main last said was at each project's position — this window's memory of
   * the DOCUMENT, beside `showing`'s memory of the picture.
   *
   * Not a field on `ShownPicture`, and that is on purpose: the view and the string
   * it compares by are made together and never apart (see `pictureIn`), and this
   * one arrives hundreds of milliseconds later over IPC. A picture carrying a
   * field that is empty at the moment it is compared would be an invitation to
   * compare it.
   *
   * ── A SIGNAL NOW, BECAUSE THE DIALOGS READ IT ────────────────────────────────
   *
   * It was a plain `Map`: bookkeeping for `followDocuments`, written and read in
   * one file, and nothing on screen depended on it. There is one selection now
   * (docs/WORKBENCH.md §6c) — "every action keys off the position, never the open
   * tab" — so Translate, Export and Metadata all ask what document the position is
   * showing, and a `Map` cannot tell a template that the answer moved. A dialog
   * standing open while a job casts the book, or while the user clicks a row in
   * the library behind it, would go on describing the document from before.
   *
   * The map inside is replaced rather than mutated on every write, which is what
   * makes the signal's equality check mean anything at all.
   */
  private readonly documentShown = signal<ReadonlyMap<string, string | null>>(new Map());

  /**
   * The document this project's panes are pointed at, for a surface that acts on
   * the position rather than on whatever tab happens to be focused.
   *
   * NULL IS THREE STATES AND THEY ARE DELIBERATELY ONE HERE: nothing has read this
   * project's history yet, the position names no document of its own, or there is
   * no project. Every caller wants the same thing from all three — fall back to
   * what it can see for itself — and a surface that told them apart would be a
   * surface with three empty states for one absence.
   */
  documentShownFor(projectDir: string | null): string | null {
    if (projectDir === null) return null;
    return this.documentShown().get(fold(projectDir)) ?? null;
  }

  /** Main's latest answer about this project's position, kept where it is read. */
  private rememberShown(key: string, target: string | null): void {
    this.documentShown.update((map) => new Map(map).set(key, target));
  }

  /** This project has no tabs left; its answer goes with them. */
  private forgetShown(key: string): void {
    this.documentShown.update((map) => {
      if (!map.has(key)) return map;
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  }

  /**
   * THE FOCUS MIRROR: a document the user has just focused moves the position onto
   * the step that document IS.
   *
   * ── The confusion it exists to end ──────────────────────────────────────────
   *
   * The app had two selectors pretending to be one. The library selected a file,
   * the ledger selected a step, and the actions keyed off a mix — so the user's
   * own report: *"i could have a document open, the epub, but have the pdf import
   * step selected, and id never know that i just ran translate against the
   * original pdf rather than the generated epub because i had the wrong step
   * selected, since the right document was open."* Clicking a library row already
   * moved the position and put its document on screen; this is the other
   * direction, and with both of them there is one selection
   * (docs/WORKBENCH.md §6c).
   *
   * ── THE GUARD, WHICH IS THE WHOLE OF THE CARE HERE ──────────────────────────
   *
   * A document that is ALREADY the one the position is showing moves nothing. A
   * book resolves to the NEWEST step of its chain — the only step you can act from
   * — so without this, somebody standing on an older save and clicking into the
   * pane to read it would be silently walked forward to the newest one, and the
   * next thing they exported would be a book they had deliberately stepped back
   * from. Standing still is not a gesture.
   *
   * ── Only user gestures reach this ───────────────────────────────────────────
   *
   * The strip's own click, a pointerdown in a pane, Ctrl+Tab and Ctrl+1…5, and
   * nothing else. It is emphatically NOT inside `activateInPane` or `reveal`,
   * because `showPosition` reaches both of those on its way to satisfying a click
   * on a library row: a mirror there would answer main's own answer with a
   * question about it, and a position that had just been moved to an older step
   * would move itself back the instant the pane obeyed.
   *
   * A LOOSE FILE HAS NO LEDGER AND NO POSITION, so it is a no-op — its actions go
   * on taking the file, which is the ruling for loose rows everywhere.
   *
   * FIRE AND FORGET, AND A FAILURE IS NEVER IN THE WAY. Focus has already happened
   * by the time this is called; a refusal from main (a catalogue that will not
   * parse) belongs on the notice strip, not in front of a person who was trying to
   * look at a document.
   */
  async standForTab(tabId: string): Promise<void> {
    if (!api) return;
    const tab = this.byId(tabId);
    if (tab === null) return;
    const subject = tab;
    /*
     * THE BOOK MOVES NOTHING, because it cannot disagree with the pointer. This
     * mirror exists so that a pane and a position can never describe two different
     * things — it answers "which step is this FILE" — and the book tab is not a
     * file: it is put on screen BY a read row and shows whatever reading that row
     * is about (`showBook`). Asking main which step it belongs to would be asking
     * about a directory, and the honest answer for a directory is nothing. A book
     * open under a project standing on a curate or translate row is showing that
     * chain's own reading, which is the same book — so there is nothing to correct
     * there either.
     */
    if (subject.kind === 'book') return;
    const dir = this.projectDirOf(subject);
    if (dir === null) return;
    const key = fold(dir);
    const known = this.documentShown().get(key);
    /*
     * THE FIRST FOCUS IN A PROJECT ASKS, RATHER THAN ASSUMING THE GUARD CANNOT
     * ANSWER — and this is the case the guard would otherwise miss entirely.
     *
     * Nothing writes `documentShown` for a project until the position MOVES
     * (`showPosition`) or main announces (`followDocuments`), so a project opened
     * from Home and clicked into straight away has no memory of what it is
     * showing. Treating that silence as "not the same document" is exactly the
     * yank this guard exists to prevent: somebody who left the pointer on an
     * older save, reopened the book and clicked into the page would be walked
     * forward to the newest step by the act of looking at it.
     *
     * One extra round trip, once per project per session, for the same question
     * `followDocuments` asks on every announce — and the answer is kept, because
     * it is the same fact those two record.
     */
    const shown = known !== undefined ? known : await this.rememberedShown(dir, key);
    if (shown !== null && fold(shown) === fold(subject.path)) return;
    try {
      /*
       * `adopt` AND NOT A SECOND READ. Main hands back the ledger AND the rows it
       * composed for it — the same whole answer `go` returns, for the same reason
       * — and `LedgerService.adopt` is the door already built for a history that
       * arrived from somewhere other than that class. A `refresh` here would be a
       * second round trip describing a moment later than the one that was acted
       * on, which is the failure `go`'s own comment is about.
       */
      this.ledger.adopt(dir, await api.ledger.standFor(dir, subject.path));
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * What main says is at this project's position, asked once and kept.
   *
   * The answer is null for every refusal (`LedgerService.documentAt` says why),
   * and null here means "no document of its own" — which the guard reads as "not
   * the one in front of me", so the mirror goes ahead and lets main decide. That
   * is the right way round: main is the side that knows, and a renderer guessing
   * at a catalogue it could not read is how somebody ends up standing somewhere
   * they did not ask to be.
   */
  private async rememberedShown(projectDir: string, key: string): Promise<string | null> {
    const at = await this.ledger.documentAt(projectDir);
    this.rememberShown(key, at);
    return at;
  }

  /**
   * A project this window has just met, asked once what its position is showing.
   *
   * IT NEVER OVERWRITES AN ANSWER THAT IS ALREADY IN HAND. A first sighting and a
   * gesture can both fire in the same frame — the pointerdown that opened the
   * project's tab is one of them — and this is the older question of the two, so
   * landing last must not replace a newer answer with a staler one.
   */
  private async baselineShown(projectDir: string, key: string): Promise<void> {
    if (this.documentShown().has(key)) return;
    const at = await this.ledger.documentAt(projectDir);
    if (this.documentShown().has(key)) return;
    this.rememberShown(key, at);
  }

  /** True while a sweep is in flight, so two announces do not walk it twice. */
  private following = false;

  /**
   * Re-ask main which document each open project's position resolves to, and put
   * it on screen if the answer moved.
   *
   * ONE SWEEP AT A TIME. Two announces in quick succession — a rendering lands and
   * a catalogue is rewritten — would otherwise interleave two walks over the same
   * projects, each acting on the other's answer.
   *
   * ANY ANSWER IS DROPPED IF THE POSITION MOVED WHILE IT WAS IN FLIGHT, by
   * identity against `showing` exactly as `showPosition` does it: a click that
   * lands mid-sweep is newer than anything this was asking about.
   */
  private async followDocuments(): Promise<void> {
    if (this.following) return;
    this.following = true;
    try {
      const asked = new Set<string>();
      for (const tab of this.all()) {
        const dir = this.projectDirOf(tab);
        if (dir === null) continue;
        const key = fold(dir);
        if (asked.has(key)) continue;
        asked.add(key);
        const now = this.showing.get(key);
        // Nothing has painted this project yet; the position effect baselines it
        // and this has nothing to compare against until it does.
        if (now === undefined) continue;
        const target = await this.ledger.documentAt(dir);
        if (this.showing.get(key) !== now) continue;
        const was = this.documentShown().get(key);
        this.rememberShown(key, target);
        if (was === undefined || was === target) continue;
        await this.showPosition({ key, dir, was: now, now }, target);
      }
    } finally {
      this.following = false;
    }
  }

  /**
   * The picture each project's panes are currently showing, keyed by the folded
   * directory — this window's memory of where every open book was standing.
   */
  private readonly showing = new Map<string, ShownPicture>();

  /**
   * What this project's panes OUGHT to be showing, or null while nothing has read
   * its history.
   *
   * The view and the string it compares by are made together and never apart: a
   * caller holding one without the other would either compare pictures it cannot
   * act on or act on a picture it cannot compare.
   */
  private pictureIn(projectDir: string | null): ShownPicture | null {
    const history = this.ledger.historyFor(projectDir);
    if (history === null) return null;
    const view = positionView(history.ledger);
    return { view, picture: positionPicture(view) };
  }

  /**
   * Make this project's pane show the position — the DOCUMENT first, and then what
   * is drawn over it.
   *
   * ── What a click used to be worth, and what the user said about it ──────────
   *
   * `b61bfab` made a pointer move drive the block editor's mode and which
   * corrections are drawn, and left the file underneath both of them exactly where
   * it was: `Tab.path` is fixed when a document is opened from the documents panel
   * and nothing else ever moved it. So a project holding the scan and the reprint
   * made from its reading showed one of them however many rows were clicked —
   * *"switching between steps doesnt switch between the original pdf and the
   * rendered facsimile like i expected"* — and when there was nothing this could
   * change it put a sentence on the strip instead, which is the half the user was
   * angrier about: *"i wanted the document to show. instead of showing the
   * document, it gave me an error saying it couldnt show the document… it should be
   * showing me document"*.
   *
   * ── The ruling this is built to ─────────────────────────────────────────────
   *
   * CLICKING A ROW IS AN INSTRUCTION TO LOOK AT THAT STEP, and the app satisfies it
   * rather than explaining why it cannot. In order: swap the pane to the step's
   * document; if that document is open but in no column, put it in one; if it is
   * not open at all, open it. Nothing here reports a state it could have fixed,
   * which is why this function no longer has a sentence to say.
   *
   * ── The three pictures over it, and what each costs ─────────────────────────
   *
   * NO OUTLINES (the import, and any position with no reading above it): the pane
   * comes out of the block editor. Nothing had been read at that point in the
   * book's story, so boxes drawn there would be the pane making a claim about a
   * step the user is standing BEFORE — which is the one thing the revert row exists
   * to let somebody look at without.
   *
   * OUTLINES, PANE NOT IN THE MODE: it goes into the mode and reads the bank. The
   * expensive one, and it is expensive exactly once per genuinely different
   * picture.
   *
   * OUTLINES, PANE ALREADY IN THE MODE: the bank is re-read if the READING moved,
   * or if the pages under it changed — a document swap is a different PDF, and
   * boxes measured against the old one would be drawn over the new one's pages.
   * Otherwise this is a few kilobytes of corrections off a disk, which is what
   * keeps stepping between a reading and its saves as free as a history panel
   * promises. See `refreshCuration`.
   */
  private async showPosition(
    move: PositionMove,
    /**
     * The answer, when the caller already has it — `followDocuments` asks main
     * which document is at the position in order to notice that it MOVED, and
     * asking again here would be a second round trip for the same fact and a
     * second chance to get a different one.
     */
    resolved?: string | null,
  ): Promise<void> {
    const view = move.now.view;
    /*
     * ASKED OF MAIN, EVERY MOVE, AND NEVER COMPOSED HERE. A project's layers are
     * main's bookkeeping — which folder holds the live copy, which of two readings
     * a reprint belongs to — and a renderer that spelled `working/<stem>.pdf` for
     * itself would be a second opinion that goes wrong exactly where it is dearest:
     * a branch read answering with the original reading's file. Main also admits
     * the answer to the viewer's allow-list on the way out, which this side cannot
     * do for itself. Null is the ordinary "this position names no document of its
     * own" and means keep the one we have.
     */
    const target = resolved !== undefined ? resolved : await this.ledger.documentAt(move.dir);
    /*
     * AND THE ANSWER IS DROPPED IF THE USER HAS MOVED AGAIN. Somebody clicking
     * down a history four rows deep issues four of these, and main answers them in
     * whatever order the disk feels like — so without this the pane could settle on
     * the document of a row nobody is standing on any more, and stay there until
     * the next click. `showing` already holds the newest picture (the effect writes
     * it synchronously before starting any of this), so identity against it is the
     * whole test. It is `LedgerService`'s ticket, in the one other place that asks
     * main a question a later question can invalidate.
     */
    if (this.showing.get(move.key) !== move.now) return;
    /*
     * WHAT THE PANES ARE NOW POINTED AT, remembered here because this is the one
     * place that knows it. `followDocuments` compares against it to notice a
     * document that changed under a position that did not move; recording it
     * anywhere else would be recording an intention rather than what happened.
     */
    this.rememberShown(move.key, target);
    /*
     * ── A READ ROW SHOWS THE BOOK, AND THAT IS THE SEAM MOVING AGAIN ──────────
     *
     * `documentAtPosition` answers a read row with the EPUB cast from its reading,
     * and every word of its own comment about why is still true — right up to the
     * ruling this wave is built on: *"we arent supposed to be rendering the book as
     * an epub… the user isnt reading a book on foundry, they're editing the
     * contents of a book"* (docs/RENDERER.md §0). The cast was the flowing document
     * while there was nothing else that flowed. There is now: the book file, drawn
     * as blocks on a proof sheet, which is the surface every op in R3 and after is
     * written against.
     *
     * SO A READ ROW OPENS THE BOOK TAB AND NOT THE CAST, and it is EITHER/OR
     * rather than both — one project, one column, one thing on screen. A row that
     * opened the sheet and then let `showDocument` put the EPUB beside it would be
     * two tabs for one instruction, and the second of them would be the surface
     * this wave exists to replace.
     *
     * CURATE AND TRANSLATE ROWS COME HERE TOO, AS OF R6b, and that sentence used
     * to say the opposite: they were left alone while their surfaces still struck
     * and relabelled through machinery the book had none of yet. It has all of it
     * now, and the surfaces they used are gone — a save's decisions are re-keyed
     * onto block ids and replayed like any other step's, and a translation's words
     * are in the derived book its landing wrote. Neither row has a document of its
     * own any more, because the per-step casts that were those documents are
     * deleted (docs/RENDERER.md §7). The test is `view.sheet` and it is asked in
     * one place, so there is no second door to drift from this one.
     */
    /*
     * AN EDIT ROW SHOWS THE BOOK TOO, and it is the same seam one action further
     * along. An `edit` step retains a file of ops against the book file's blocks
     * (docs/RENDERER.md §3) — there is no document of its own to point a viewer
     * at, and what it is ABOUT is the proof sheet — so it goes where a read row
     * goes and the sheet replays the chain up to it. Sending it through
     * `showDocument` instead would open the cast EPUB beside the surface the
     * changes were made on, which is the tab this whole wave exists to stop being
     * the answer.
     */
    /*
     * AND AN IMPORTED EPUB'S ORIGIN ROW OPENS IT AS WELL, which is the third door
     * onto the same surface and the one this wave owed. A project that arrived as
     * an EPUB has no read step and will never have one — a bank models pages and
     * an EPUB has none, so its book is exploded straight out of the container
     * (docs/RENDERER.md §6, the refinement paragraph) — and the import is
     * therefore the row that book belongs to. Without this the click lands in
     * `showDocument` and opens the archived EPUB in the iframe reader, which is
     * the surface the whole wave exists to replace.
     *
     * THE TEST ITSELF MOVED INTO `positionView`. It was spelled here and again,
     * differently, at the split-pane door below, and two doors onto one surface
     * that disagree about who may come through is a bug with no symptom until
     * somebody uses the second one. `sheet` is now the one answer to "is the
     * picture at this position the proof sheet", asked in the module that already
     * owns every other question about a position.
     */
    const onTheSheet = view.sheet;
    const swapped = onTheSheet
      ? this.showBook(move)
      : await this.showDocument(move, target);
    /*
     * AND NOTHING IS DONE TO THE SCAN'S PAGES, which is where a loop used to be.
     *
     * It turned the block editor on and off from `view.outlines` and re-read the
     * bank whenever the reading moved. That editor is deleted (docs/RENDERER.md
     * §7, A1): a scan is a photograph and this app shows it, so a pointer move
     * changes which DOCUMENT a pane holds — done above — and nothing about how it
     * is drawn. `swapped` is still the answer this function owes its caller.
     */
    void swapped;
  }

  /**
   * Put the position's document on screen, and answer whether the pages moved.
   *
   * ── Three ways to satisfy one instruction ───────────────────────────────────
   *
   * ALREADY THE DOCUMENT ON THAT TAB: `reveal`, which is a no-op when it is in a
   * column and PUTS IT IN ONE when it is not. That second case is the exact state
   * the app used to describe back at the user — their book was open, no column was
   * showing it, and they were told to go and click it in the list. Doing it for
   * them is the whole of the fix.
   *
   * A PDF THIS PROJECT ALREADY HAS A TAB FOR: the tab MOVES to the new file. One
   * document per project per pane is what makes "the pane shows the step" true;
   * opening the scan beside the reprint would leave two tabs with the same book's
   * name in the list and neither of them following the pointer. `app-pdf-view`
   * watches `tab.path` and re-opens when the string changes, so the swap is the
   * patch and nothing else — the same mechanism `relocate` uses when an import
   * moves a tab onto the project's copy.
   *
   * ANYTHING ELSE: opened, through the one door every open in this app goes
   * through. That covers a translation's EPUB, which is emphatically NOT swapped
   * into a PDF tab — a book is UNPACKED, and patching a path would leave a viewer
   * serving chapters out of a tree belonging to a different book — and it covers a
   * project whose document nobody has open. `adopt` refuses to make a second tab
   * for a file already open, so this cannot double up.
   *
   * ── Which tab follows the pointer, when the project has several ─────────────
   *
   * The one in the focused column first, then any in a column, then any at all —
   * and ONLY of the kind the target is. A person comparing the scan against the
   * cast EPUB has two tabs of one project on screen, and swapping the EPUB's pane
   * to a PDF because they clicked a read row would take away the book they were
   * reading to answer a question about the pages.
   *
   * ── AND A CHANGE OF KIND IS AN OPEN, NEVER A PATCH ──────────────────────────
   *
   * The position's document can now change KIND under a click: the import row
   * answers the scan and the read and curate rows answer the EPUB cast from the
   * reading (docs/WORKBENCH.md §4, Unit E). Patching a path across that boundary
   * would leave a PDF viewer pointed at a book — or an unpacked book's viewer
   * serving chapters out of a tree belonging to a scan — so the two documents
   * become two TABS IN ONE STRIP, and clicking between the steps activates
   * between them. That is the whole reason the strips are back in a form that can
   * hold more than one thing: nothing threads "this is a PDF" through the
   * renderer, the seam is position → document → show it (DERIVED-BOOK §7), and a
   * strip is what lets one column show whichever of a project's faces the
   * position names without throwing the other away.
   *
   * The same-kind swap SURVIVES for PDF↔PDF, and it is worth keeping for the one
   * thing it does that opening cannot: `app-pdf-view` keeps the page you were on
   * when the path under it moves, and a scan re-opened as a second tab would land
   * you back at page one of a five-hundred-page book.
   */
  private async showDocument(move: PositionMove, target: string | null): Promise<boolean> {
    const mine = this.all().filter((tab) => {
      const dir = this.projectDirOf(tab);
      return dir !== null && fold(dir) === move.key;
    });
    /*
     * THE COLUMN THIS BOOK IS ALREADY IN, worked out before anything moves. A
     * project's documents belong together: the cast book has to arrive in the
     * column the scan is being read in, not in whichever column the pointer
     * happened to leave focused — which, for somebody reading two books, is
     * routinely the other book's.
     */
    const home = this.paneAmong(mine);
    // Right-click → "Open in split" on a step row, consumed exactly once. The
    // menu sets it and then moves the pointer; this is where the move lands.
    const split = this.splitNext.delete(move.key);
    if (target === null) {
      /*
       * NOTHING TO SWAP TO, AND STILL SOMETHING TO DO. A position with no document
       * of its own — a project with no reading yet, a payload since swept — is
       * still a row somebody clicked, so if none of this book's tabs is in a column
       * one of them goes in one. The instruction was "show me this step"; the
       * honest answer is this book, where they can see it.
       */
      const first = mine[0];
      if (first === undefined) return false;
      if (split) {
        this.openInNewPane(first.id, this.indexOfPane(home) + 1);
        return false;
      }
      if (mine.some((tab) => this.paneOf(tab.id) !== null)) return false;
      this.reveal(first.id);
      return false;
    }

    const key = normalise(target);
    const already = mine.find((tab) => normalise(tab.path) === key);
    if (already !== undefined) {
      if (split) this.openInNewPane(already.id, this.indexOfPane(home) + 1);
      else this.reveal(already.id, false, home?.id ?? null);
      return false;
    }

    /*
     * WHETHER FOUNDRY MADE THIS FILE, ASKED OF THE CATALOGUE RATHER THAN ASSUMED.
     * It is what the Chrome dot and the closing question are about: "no copy of
     * this exists anywhere you chose". True of a reprint and a translation; false
     * of the untouched original in `archive/`, which is in this app precisely
     * BECAUSE the user still has their own. Home draws one row per file type and
     * the archive is the layer it never draws, so a path the listing does not name
     * is the original — and false is the right answer for exactly that.
     */
    const madeByUs = this.projects.projectFor(target)?.documents
      .some((row) => normalise(row.path) === key && row.managed) === true;

    /*
     * AN EPUB IS NOT A DOCUMENT THIS APP SHOWS, and this is the one position that
     * can still name one: a translate step from before records, whose payload is
     * the book its run wrote. There is no viewer for it — the iframe reader is
     * deleted (docs/RENDERER.md §7) and pointing pdf.js at a zip would be a pane
     * with "This PDF would not open" on it. So the row is honest instead: the file
     * is there, Reveal opens it, and the pane keeps what it had.
     */
    if (key.endsWith('.epub')) {
      this.notice.set(
        'That step is an EPUB written before Foundry kept translations as records, and Foundry no '
        + 'longer opens books as files — it edits the book itself. Reveal it from the library to '
        + 'read it, or translate again from the step it was made from.',
      );
      return false;
    }
    const follower = this.followerAmong(mine);
    if (follower === null) {
      if (split) this.expectOwnPane.add(key);
      else if (home !== null) this.expectPane.set(key, home.id);
      await this.openFile(target, madeByUs);
      return true;
    }
    this.patch(follower.id, {
      path: target,
      // The dot follows the file, for the reason above: the tab is about to stop
      // being about the copy Foundry made and start being about the user's own.
      unsaved: madeByUs,
      /*
       * THE REVISION MOVES WITH THE PATH. It is what makes a pane re-read bytes it
       * is already pointed at (see `openFinished`), and the two files this swaps
       * between can have the same name in two layers of one project — so a viewer
       * that compared only the string would faithfully conclude there was nothing
       * to do, which is the failure that whole comment exists about.
       */
      revision: follower.revision + 1,
      /*
       * AND THE NAME ONLY IF NOBODY CHOSE ONE, which is `relocate`'s rule and its
       * reason: a book's `dc:title` outranks anything derived from a path, and
       * these files are all one book anyway — `nameFor` answers the project's title
       * for every layer of it.
       */
      ...(follower.named ? {} : { title: this.nameFor(target) }),
    });
    if (split) this.openInNewPane(follower.id, this.indexOfPane(home) + 1);
    else this.reveal(follower.id, false, home?.id ?? null);
    return true;
  }

  /**
   * Put the project's BOOK on screen — the proof sheet, not a file.
   *
   * ── One per project, forever ────────────────────────────────────────────────
   *
   * There is exactly one book in a project and one tab for it. Everything else in
   * this file that opens something has to decide between a swap and a second tab,
   * because two paths can be two documents of one project; here there is nothing
   * to decide, because the tab does not name a file at all — it names the project,
   * and main answers with whatever the position's reading reflowed to. A book tab
   * that is already open is therefore already correct for any read row of that
   * project, and revealing it is the whole of the work.
   *
   * IT LANDS IN THE COLUMN THE PROJECT IS ALREADY BEING READ IN, which is
   * `showDocument`'s rule and for `showDocument`'s reason: a project's documents
   * belong together, and a person reading two books must not have this one arrive
   * in the other one's column. "Open in split" is consumed here too — the flag
   * rides on a position move and this is now one of the two places a move lands.
   *
   * ANSWERS FALSE, ALWAYS: the boolean its caller wants is "did the PAGES under
   * the block editor move", and nothing here points a PDF pane anywhere.
   */
  private showBook(move: PositionMove): boolean {
    const mine = this.all().filter((tab) => {
      const dir = this.projectDirOf(tab);
      return dir !== null && fold(dir) === move.key;
    });
    const home = this.paneAmong(mine);
    const split = this.splitNext.delete(move.key);
    const id = this.bookTabIn(move.dir);
    /*
     * AND IT RE-ASKS FOR THE BOOK, which revealing alone does not do.
     *
     * *"Standing on any step = replay of that chain."* (docs/RENDERER.md §3.) The
     * pane's rows and its op chain both come from one call to main, and that call
     * is keyed to the POSITION — so a move from a read row onto an edit row, or
     * between two edit rows of one reading, changes what `book:load` would answer
     * while the tab's own path (the project directory) does not move an inch.
     * Without a revision the sheet would sit there showing the book as of whatever
     * row it last loaded, which is precisely the complaint the position effect
     * exists to answer: clicking a row in your own history and watching the app do
     * nothing.
     *
     * It is the mechanism `showDocument` already uses to make a viewer re-read
     * bytes it is already pointed at, used here for the same reason — the thing
     * that changed is not visible in the path.
     *
     * ONLY ON A MOVE. This runs from `showPosition`, which the effect only reaches
     * when the picture genuinely changed (`positionPicture` carries the edit chain
     * for exactly this), so revealing a tab, focusing it or clicking the row you
     * are already standing on costs nothing.
     */
    const already = this.byId(id);
    if (already !== null) this.patch(id, { revision: already.revision + 1 });
    if (split) this.openInNewPane(id, this.indexOfPane(home) + 1);
    else this.reveal(id, false, home?.id ?? null);
    return false;
  }

  /**
   * This project's book tab, made if it has none yet. Never a second one.
   *
   * MADE HERE RATHER THAN THROUGH `openFile`, and that is not a shortcut past a
   * gate. Every other tab in this app is made by `adopt`, on main's own
   * `document:opened` announcement, because main is what decides whether a path
   * may be opened at all. There is no path here to decide about: the tab is the
   * PROJECT, its rows arrive over an IPC that admits nothing (`book.load`,
   * shared/api.ts), and a door answering "yes, you may open this directory" would
   * be a door granting access to a folder for being asked about it.
   */
  /**
   * OPEN A FINISHED EXPORT IN A TAB — the proof sheet over the file itself.
   *
   * The click model is the user's (2026-08-16): left-click an export leaf opens
   * it, Ctrl+S saves a copy somewhere else, and the context menu carries the
   * rest. What the tab shows is the export EXPLODED — the same derivation an
   * imported EPUB gets — locked to the Final version register, because what the
   * file contains is a finished book and the finished-book projection is the
   * honest way to look at one. One tab per file, like every document.
   */
  openExportView(path: string, title: string): void {
    const key = fold(path);
    const already = this.all().find((tab) => tab.kind === 'book' && fold(tab.path) === key);
    if (already !== undefined) {
      this.reveal(already.id, true);
      return;
    }
    const made: Tab = { ...this.blankTab('book', path, title), viewOnly: true };
    this.all.update((tabs) => [...tabs, made]);
    this.reveal(made.id, true);
  }

  private bookTabIn(projectDir: string): string {
    const key = fold(projectDir);
    const already = this.all().find((tab) => tab.kind === 'book' && fold(tab.path) === key);
    if (already !== undefined) return already.id;
    const made = this.blankTab('book', projectDir, this.projectTitleOf(projectDir));
    this.all.update((tabs) => [...tabs, made]);
    return made.id;
  }

  /**
   * The column one of these documents is in — the focused one for preference.
   *
   * "For preference" is the whole of it: with two of a project's faces on screen
   * the answer has to be the one the hand is in, or a click on a step row would
   * repaint the column the user is not looking at.
   */
  private paneAmong(mine: readonly Tab[]): Pane | null {
    const ids = new Set(mine.map((tab) => tab.id));
    const focused = this.focusedPane();
    if (focused && focused.tabIds.some((id) => ids.has(id))) return focused;
    return this.columns().find((pane) => pane.tabIds.some((id) => ids.has(id))) ?? null;
  }

  /** Where a column sits left to right, or the focused one's place when it has none. */
  private indexOfPane(pane: Pane | null): number {
    const panes = this.columns();
    const at = pane === null ? -1 : panes.findIndex((candidate) => candidate.id === pane.id);
    return at >= 0 ? at : panes.findIndex((candidate) => candidate.id === this.focused());
  }

  /**
   * Projects whose next position move puts its document in a COLUMN OF ITS OWN.
   *
   * The inspector's right-click → "Open in split" on a step row, which is two
   * acts that have to arrive as one: stand on the step, and put what it shows
   * beside what is already there. Standing is `LedgerService.go`, and what a step
   * shows is only decided afterwards, by main, in `showDocument` — so the
   * intention is left here for that answer to find. Consumed exactly once, so a
   * later move made for some other reason cannot inherit it.
   */
  private readonly splitNext = new Set<string>();

  /**
   * The open book panes' stacks, by tab id — see `BookStack`.
   *
   * A SIGNAL OF A MAP, AND IT USED TO BE A PLAIN ONE. The argument for the plain
   * map was that nothing DREW from it: the undo chord reads it the instant a chord
   * arrives and the closing question reads it the instant a tab goes, and both are
   * events rather than repaints. The panels ended that — Notes, Furniture and
   * Chapters are drawn in the shell out of the pane's own replay, so the inspector
   * has to hear a pane arrive and hear it leave, and a lookup in a plain map inside
   * a computed is a read of something that can change with nothing to notice it.
   *
   * WHAT THIS IS NOT is a signal that a PUSH moves. The map answers which pane is
   * in which tab; the ops behind `pending()` and the rows behind `view()` are the
   * pane's own signals, reached through the entry. So a gesture on the paper still
   * repaints exactly what depends on it, and registering a pane — twice per tab, in
   * a session — is what writes here.
   *
   * The pane puts itself in on init and takes itself out on destroy, so an entry
   * here is always a pane that exists — which is what lets every reader treat a
   * missing entry as "that book has nothing waiting" rather than as an error.
   */
  private readonly bookStacks = signal<ReadonlyMap<string, BookStack>>(new Map());

  /**
   * A BOOK PANE'S UNWRITTEN STACK, HELD WHILE ITS TAB IS SHOWN ELSEWHERE.
   *
   * Switching a pane to another tab DESTROYS the book component (the viewer
   * renders one tab at a time), and the first draft let the stack die with it —
   * a glance at the scan cost every strike since the last Apply (user report,
   * 2026-08-16). The ruling: the stack belongs to the TAB, not to the
   * component's lifetime. The pane parks it here on destroy and claims it back
   * on load; it is dropped when the tab closes (after the closing question,
   * which consults it — see `questionBefore`) and let go with a notice when the
   * position moved while it was parked, because ops made against the book at
   * one step are a delta against a state the tab is no longer showing.
   *
   * A plain map: written at destroy, read at load and at close, drawn by
   * nothing.
   */
  private readonly parkedStacks = new Map<string, {
    /** The tab's revision when parked — a move while parked bumps it. */
    revision: number;
    landed: readonly BookOp[];
    pending: readonly BookOp[];
    undone: readonly BookOp[];
  }>();

  /** The pane, on destroy, leaving its unwritten work with the tab. */
  parkBookStack(tabId: string, held: {
    revision: number;
    landed: readonly BookOp[];
    pending: readonly BookOp[];
    undone: readonly BookOp[];
  }): void {
    this.parkedStacks.set(tabId, held);
  }

  /** The pane, on load, taking it back — a claim, so nothing is answered twice. */
  claimBookStack(tabId: string): {
    revision: number;
    landed: readonly BookOp[];
    pending: readonly BookOp[];
    undone: readonly BookOp[];
  } | null {
    const held = this.parkedStacks.get(tabId) ?? null;
    this.parkedStacks.delete(tabId);
    return held;
  }

  /** The book pane in this tab, announcing itself. Called once, on init. */
  registerBookStack(tabId: string, stack: BookStack): void {
    this.bookStacks.update((held) => new Map(held).set(tabId, stack));
  }

  /** And letting go, on destroy — an entry for a pane that is gone answers for nothing. */
  releaseBookStack(tabId: string): void {
    this.bookStacks.update((held) => {
      const next = new Map(held);
      next.delete(tabId);
      return next;
    });
  }

  /**
   * The stack of the book pane in this tab, or null for every other kind of tab
   * and for a book still opening.
   *
   * THE PANELS' ONE DOOR. Everything the inspector's three book sections draw and
   * everything they do goes through the returned interface, so the shell holds no
   * copy of the book and no second list of ops.
   */
  bookStackFor(tabId: string | null): BookStack | null {
    return tabId === null ? null : this.bookStacks().get(tabId) ?? null;
  }

  /** Set by the inspector's menu immediately before it moves the pointer. */
  splitNextIn(projectDir: string): void {
    this.splitNext.add(fold(projectDir));
  }

  /** Dropped when the move it was set for turns out not to happen. */
  forgetSplitIn(projectDir: string): void {
    this.splitNext.delete(fold(projectDir));
  }

  /**
   * "Open in split" on the step somebody is ALREADY standing on.
   *
   * The flag above rides on a position MOVE, and a right-click on the current row
   * is not one: main answers with the same ledger, the picture does not change,
   * and nothing would ever consume it. So this asks main the same question
   * `showPosition` asks — what document does this position name — and puts the
   * answer in a column of its own.
   */
  async splitAtPosition(projectDir: string): Promise<void> {
    this.forgetSplitIn(projectDir);
    const at = this.indexOfPane(this.focusedPane());
    /*
     * A ROW WHOSE PICTURE IS THE SHEET SPLITS THE BOOK, for `showPosition`'s
     * reason and so that the two gestures cannot disagree. Asking main which
     * document this position names would answer with the cast EPUB — the surface
     * the sheet replaces — and put it in a column of its own beside a book
     * somebody was reading, which is the "one tab, not two" rule broken by the one
     * door that went round it.
     *
     * IT IS `view.sheet` AND NO LONGER `action === 'read'`, which is the same
     * expression the click uses and is why it is one expression now. This door had
     * already drifted: an edit row opened the sheet on a click and the cast EPUB
     * on a split, and nothing said so.
     */
    if (this.pictureIn(projectDir)?.view.sheet === true) {
      this.openInNewPane(this.bookTabIn(projectDir), at + 1);
      return;
    }
    const target = await this.ledger.documentAt(projectDir);
    if (target === null) {
      // The position names no document of its own, so the honest thing to put in
      // the new column is this book — the same fallback `showDocument` makes.
      const key = fold(projectDir);
      const mine = this.all().find((tab) => {
        const dir = this.projectDirOf(tab);
        return dir !== null && fold(dir) === key;
      });
      if (mine !== undefined) this.openInNewPane(mine.id, at + 1);
      return;
    }
    const normalised = normalise(target);
    const already = this.all().find((tab) => normalise(tab.path) === normalised);
    if (already !== undefined) {
      this.openInNewPane(already.id, at + 1);
      return;
    }
    const madeByUs = this.projects.projectFor(target)?.documents
      .some((row) => normalise(row.path) === normalised && row.managed) === true;
    this.expectOwnPane.add(normalised);
    await this.openFile(target, madeByUs);
  }

  /** The PDF tab that follows the pointer: focused column, then any column, then any. */
  private followerAmong(mine: readonly Tab[]): Tab | null {
    const pdfs = mine.filter((tab) => tab.kind === 'pdf');
    if (pdfs.length === 0) return null;
    const focused = this.focusedPane()?.activeTabId ?? null;
    return pdfs.find((tab) => tab.id === focused)
      ?? pdfs.find((tab) => this.paneOf(tab.id) !== null)
      ?? pdfs[0]!;
  }

  /**
   * What to call a document at this path — the book, and the file only as a last
   * resort.
   *
   * THE SAME STRING HOME SHOWS, and it is one call rather than a rule repeated
   * here precisely so that it cannot become a second opinion: see
   * `ProjectsService.nameFor`, which every surface that draws a document's name
   * goes through.
   */
  private nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  /**
   * What to call this TAB — one step above `nameFor`, which answers about a path.
   *
   * The two are the same question for every tab that is a file. A `book` tab is
   * not one (see `TabKind`): its path is the project's own directory, and
   * `nameFor` would answer with the folder said aloud — a slug with a hash on the
   * end — for the one document in this app whose name is never in doubt. It is
   * the project's title, which is what Home, the library and every other surface
   * already call this book.
   *
   * IT IS RE-DERIVED RATHER THAN FROZEN AT BIRTH, which is why this is a function
   * and not a flag: a metadata step can change a book's title while it is open,
   * and the naming effect above exists precisely so that every tab that did not
   * have a name CHOSEN for it follows.
   */
  private titleFor(tab: Tab): string {
    return tab.kind === 'book' ? this.projectTitleOf(tab.path) : this.nameFor(tab.path);
  }

  /**
   * The title of the project AT this directory, or the folder said aloud.
   *
   * The fallback is `nameFor`'s own last resort rather than a second one: a
   * directory no project claims is a book that has left the library while a tab
   * was open, and the honest thing to say about it is whatever its folder is
   * called.
   */
  private projectTitleOf(dir: string): string {
    const key = fold(dir);
    const project = this.projects.items().find((one) => fold(one.dir) === key) ?? null;
    return project === null || project.problem !== null || project.title.length === 0
      ? this.nameFor(dir)
      : project.title;
  }

  // ── Opening ──────────────────────────────────────────────────────────────

  /** The rail's and Home's Open button. The tab arrives on `document:opened`. */
  async openViaDialog(): Promise<void> {
    await api?.openDocumentDialog();
  }

  /**
   * A drop. Main decides whether the path is openable; a refusal is SAID rather
   * than ignored, because a file that lands in the window and does nothing is
   * indistinguishable from a broken app.
   */
  async openDropped(file: File): Promise<void> {
    if (!api) return;
    const candidate = api.pathForFile(file);
    if (!candidate) return;
    const admitted = await api.openPath(candidate);
    if (admitted === null) {
      this.notice.set(`${file.name} is not something Foundry opens — it reads PDFs and the EPUBs it casts.`);
    }
  }

  /**
   * The documents list's click on a row nothing has opened yet — including an
   * EXPORT row, which is a file in `final/` and opens like any other document.
   *
   * IT REPLACES what the focused column is showing, which is the user's rule
   * about browsing: *"clicking another file will automatically close the one i
   * was looking at and open the one i just clicked, unless i pin the file"*. The
   * displaced tab gets its ordinary closing question, so nothing with work in it
   * goes without being asked.
   */
  async openFromList(filePath: string, managed = false): Promise<void> {
    this.expectReplace.add(normalise(filePath));
    await this.openFile(filePath, managed);
  }

  /**
   * Open a PROJECT — Home's row click — which is a different gesture from
   * opening a file, because a project has a POSITION and the position decides
   * what belongs on screen.
   *
   * ── The complaint this answers ──────────────────────────────────────────────
   *
   * Opening a project put the ORIGINAL document in the pane while the position
   * stood on the newest step — an edit row, whose picture is the proof sheet —
   * and the first-sighting rule (correctly) refuses to read "a tab appeared" as
   * a move, so nothing ever corrected it. The user had to click the import row
   * and then back down to their edits to see the book they left off in.
   *
   * ── Why the original still opens first ──────────────────────────────────────
   *
   * The `openPath` round trip is where main records the recent — the fact Home
   * orders its rows by — and the adopted tab is the project's document face,
   * grouped in the documents nav where flipping to it is one click. So the
   * original opens exactly as it always has, and then, WHERE THE POSITION'S
   * PICTURE IS THE SHEET, the book tab goes on top: the same end state the user
   * was building by hand, in one click. `document:opened` is announced before
   * `openPath` resolves (electron/documents.ts), so the original's tab has already
   * been adopted and focused by the time the sheet is revealed over it — the
   * ordering cannot race.
   *
   * A project standing on the import keeps today's behaviour: the position's
   * surface IS the document, and `view.sheet` is false there for a scan. An
   * imported EPUB's origin row answers sheet=true (positionView owns that test),
   * so such a project opens onto its book — the only surface it has.
   */
  async openProject(projectDir: string, originalPath: string, managed = false): Promise<void> {
    await this.openFile(originalPath, managed);
    // The history is read before the decision, not guessed at: a project opened
    // from Home has usually never been seen by this window's ledger mirror.
    if (this.ledger.historyFor(projectDir) === null) await this.ledger.refresh(projectDir);
    const picture = this.pictureIn(projectDir);
    if (picture === null || !picture.view.sheet) return;
    this.reveal(this.bookTabIn(projectDir));
  }

  /** Open a path this window already knows about: Home's list, the shelf's Open. */
  async openFile(filePath: string, managed = false): Promise<void> {
    if (!api) return;
    const key = normalise(filePath);
    if (managed) this.expectUnsaved.add(key);
    const admitted = await api.openPath(filePath);
    if (admitted === null) {
      this.expectUnsaved.delete(key);
      this.expectOwnPane.delete(key);
      this.expectReplace.delete(key);
      this.expectPane.delete(key);
      // NAMED, NOT SPELLED OUT. A path in the strip is this app showing its own
      // bookkeeping to somebody who asked for a book — and the whole path was
      // never readable in one line of a notice anyway. The row that failed to
      // open still carries the path in its tooltip, which is where a person
      // debugging their own library goes looking.
      this.notice.set(`${this.nameFor(filePath)} is no longer there.`);
    }
  }

  /**
   * A rendering's output: unsaved, and in a pane of its own if there is room.
   *
   * ── A NEW FILE UNDER AN OLD NAME ───────────────────────────────────────────
   *
   * Generating a real-text PDF appeared to do nothing at all. The run finished,
   * the shelf said so, and the page on screen did not change — because a
   * PDF-producing rendering REPLACES the project's live PDF at the same path
   * (`refreshLivePdf`), `adopt` finds a tab already on that path and merely
   * reveals it, and `app-pdf-view` re-reads only when the path STRING changes.
   * Same name, new bytes, and every layer of the app faithfully concluded there
   * was nothing to do.
   *
   * So a document already open is REVEALED AND RELOADED. The revision bump is
   * this app's own idiom for exactly this — it is what makes an edited chapter
   * repaint in an <iframe> pointed at a URL it is already showing — and the PDF
   * pane now watches it for the same reason.
   *
   * A document that is NOT open takes the ordinary path and opens fresh.
   *
   * ── A COLUMN OF ITS OWN, EXCEPT WHERE THAT IS A SECOND COLUMN OF ONE BOOK ───
   *
   * The pane-of-its-own rule was written for the translation and it is right for
   * the translation: it runs for hours, the person who ordered it is not
   * watching, and the whole point of it appearing is that they can read it
   * AGAINST the source. Two columns is the feature.
   *
   * A READING NOW CASTS THE BOOK BY ITSELF (docs/WORKBENCH.md §4, Unit E), and
   * nobody asked for that one at all. Under the old rule it arrived as a new
   * column, unbidden, next to the scan it was cast from — and then the position
   * effect, which is the thing that actually MEANT to put it on screen, found it
   * already in a column and merely focused it. Two mechanisms, one book, and a
   * column the user did not arrange: the read step's document turning up as
   * furniture rather than as the step's document.
   *
   * So a landing whose project is already open in a column JOINS THAT COLUMN'S
   * STRIP — it is another face of the same book, the same thing clicking the read
   * row means — and only a translation still insists on a column of its own,
   * because only a translation is a thing to be read beside rather than instead.
   * A landing whose project has nothing open takes a column, because there is
   * nothing for it to join.
   */
  private openFinished(filePath: string, kind: JobKind): void {
    const key = normalise(filePath);
    const already = this.all().find((tab) => normalise(tab.path) === key);
    if (already) {
      this.reveal(already.id);
      this.patch(already.id, { revision: already.revision + 1, unsaved: true, savedPath: null });
      return;
    }
    const home = kind === 'translate' ? null : this.paneHolding(filePath);
    if (home !== null) this.expectPane.set(key, home.id);
    else this.expectOwnPane.add(key);
    void this.openFile(filePath, true);
  }

  /**
   * The column this file's PROJECT is already being read in, or null.
   *
   * The focused one first, so a person reading two books gets the answer about
   * the one in front of them; then any column holding a tab of that project.
   */
  private paneHolding(filePath: string): Pane | null {
    const dir = this.projects.projectFor(filePath)?.dir ?? null;
    if (dir === null) return null;
    const key = fold(dir);
    const mine = new Set(this.all()
      .filter((tab) => {
        const own = this.projectDirOf(tab);
        return own !== null && fold(own) === key;
      })
      .map((tab) => tab.id));
    if (mine.size === 0) return null;
    const focused = this.focusedPane();
    if (focused && focused.tabIds.some((id) => mine.has(id))) return focused;
    return this.columns().find((pane) => pane.tabIds.some((id) => mine.has(id))) ?? null;
  }

  /**
   * The single tab factory. Focuses an existing tab for the same file rather
   * than opening a second — two tabs onto one book are two scroll positions
   * fighting over one document, and with panes it would be two of them fighting
   * over one unpack.
   */
  private adopt(absolutePath: string): void {
    const key = normalise(absolutePath);
    const ownPane = this.expectOwnPane.delete(key);
    const replace = this.expectReplace.delete(key);
    const intoPane = this.expectPane.get(key) ?? null;
    this.expectPane.delete(key);
    /*
     * DRAINED WITH ITS THREE SIBLINGS AND NOT AT THE POINT OF USE, which is the
     * only reason this line is up here: the EPUB branch below returns without
     * making a tab, and an expectation left in a map by a path that never takes
     * one is an entry nothing will ever clear.
     */
    const unsaved = this.expectUnsaved.delete(key);
    const existing = this.all().find((tab) => normalise(tab.path) === key);
    if (existing) {
      this.reveal(existing.id, replace, intoPane);
      return;
    }

    /*
     * ── AN EPUB OPENS AS A BOOK, NOT AS A FILE ────────────────────────────────
     *
     * It used to become an `epub` tab: main unpacked it into a working tree and
     * served the chapters to an iframe. Both are deleted (docs/RENDERER.md §7),
     * and what replaced them is the thing the container was always standing in
     * for — an imported EPUB explodes into the BOOK FILE (§6, R6a), and the book
     * is what the proof sheet draws.
     *
     * SO NO TAB IS MADE HERE. Main has already started the import (`openDocument`,
     * electron/documents.ts) and `awaitBook` opens the project's sheet the moment there
     * is a project to open it for — which is usually a moment later, and is
     * immediate for an EPUB already in the library.
     */
    if (key.endsWith('.epub')) {
      this.awaitBook(absolutePath, ownPane, intoPane);
      return;
    }
    const tab = this.blankTab('pdf', absolutePath, this.nameFor(absolutePath));
    tab.unsaved = unsaved;
    this.all.update((tabs) => [...tabs, tab]);
    this.place(tab.id, ownPane, null, replace, intoPane);
  }

  /**
   * An EPUB is open somewhere in the library — show that project's BOOK.
   *
   * ── Why this waits rather than resolving ──────────────────────────────────
   *
   * A file dropped on the window is announced by main IMMEDIATELY and imported
   * behind that announcement, deliberately: keying a project is a full sha256 and
   * a window that sat still for it would read as an app that had missed the file.
   * So at the instant this is called there is very often no project yet, and the
   * question "which book is this" has no answer that could be composed here.
   *
   * IT IS A SET AND NOT A PROMISE, for the reason every other cross-cutting fact
   * in this file is a signal: the answer arrives as `projects:changed`, which is
   * an announcement to the whole window rather than the resolution of a call this
   * side made. The entry is dropped as soon as it is spent, and an import that
   * never lands leaves one path in a set — which is the cheapest possible way to
   * be wrong about a book nobody can open anyway.
   */
  private readonly awaitingBooks = new Map<string, { ownPane: boolean; intoPane: string | null }>();

  private awaitBook(filePath: string, ownPane: boolean, intoPane: string | null): void {
    this.awaitingBooks.set(normalise(filePath), { ownPane, intoPane });
    this.openAwaitedBooks();
  }

  /** Every awaited EPUB whose project this window can now see. */
  private openAwaitedBooks(): void {
    for (const [key, where] of [...this.awaitingBooks]) {
      const dir = this.projects.projectFor(key)?.dir ?? null;
      if (dir === null) continue;
      this.awaitingBooks.delete(key);
      const id = this.bookTabIn(dir);
      if (where.ownPane) this.openInNewPane(id, this.columns().length);
      else this.reveal(id, false, where.intoPane);
    }
  }

  /**
   * The document this tab is showing has moved to the copy this app works on.
   *
   * ── What this fixes ─────────────────────────────────────────────────────────
   *
   * A file opened from outside the library is IMPORTED — copied into the
   * project's `archive/` untouched, and again into the live layer, which is what
   * "the PDF" means in every other sentence this app says. The tab kept the
   * outside path, because the import is deliberately not awaited and there was
   * nothing else to name at the moment the tab was made.
   *
   * Everything then asked the wrong question. `projectFor(tab.path)` answers
   * null for a path outside the library, so Generate said a book that had just
   * been read had not been read, the dock's waiting light stayed lit on a
   * finished project, the nav could not group the document under its own book,
   * and the block editor had no bank to fetch. One stale string, six broken
   * features, and nothing on screen to explain any of it.
   *
   * ── The same tab, never a second one ────────────────────────────────────────
   *
   * `adopt` would make a new tab for the new path, which is exactly the failure
   * this exists to prevent: two viewers onto one document, two scroll positions,
   * and the user watching their book apparently open twice. So this PATCHES —
   * the tab keeps its id, its pane, its ledger, its selection and its place in
   * the list, and only its idea of where the file is changes.
   *
   * A PDF pane reloads by itself: `app-pdf-view` watches `tab.path` through a
   * computed and re-opens when the string changes, which is a repaint of the
   * same pages from the same bytes. A book does not reload at all — it is
   * already unpacked, and it is unpacked from the SAME project, because the
   * import is keyed by the file's content and both paths reach it.
   *
   * `savedPath` MOVES WITH IT WHEN IT NAMED THE FILE WE ARE LEAVING. It is a
   * grant — for a book opened from the user's own disk it names their file, and
   * Save updating the copy they chose is what they asked for by opening it — but
   * that stops being true the moment the tab stops showing that file. A Save
   * that repacked the working tree over a document on another drive, while every
   * label on screen said the library's copy, is the same invariant `meta:write-pdf`
   * broke: THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY. Main revokes the
   * matching grant in the same breath. Where `savedPath` names something else
   * entirely — a Save As the user made — it is left exactly alone.
   *
   * Silent when nothing matches — the tab was closed inside the import's own
   * round trip, which is a race with no consequence.
   */
  private relocate(from: string, to: string): void {
    const was = normalise(from);
    const now = normalise(to);
    if (was === now) return;
    const moving = this.all().find((tab) => normalise(tab.path) === was);
    if (!moving) {
      // No tab for it, which for an EPUB is the ordinary case: `adopt` made none
      // and is waiting for the project this move announces.
      if (this.awaitingBooks.has(was)) {
        const where = this.awaitingBooks.get(was)!;
        this.awaitingBooks.delete(was);
        this.awaitBook(to, where.ownPane, where.intoPane);
      }
      return;
    }
    /*
     * THE DESTINATION IS ALREADY OPEN — one book reached two ways.
     *
     * Somebody opened the project's copy from Home and then dropped their own
     * file on the window (or the reverse). This used to give up and leave the
     * outside-path tab exactly where it was, which is the worst of the three
     * outcomes: that tab keeps every identity bug the relocation exists to fix,
     * and the user is looking at two tabs of one book with only one of them
     * working.
     *
     * ONE BOOK, ONE TAB. The outside tab closes and the one already on the
     * working copy is revealed. Nothing is lost — they are the same bytes, and
     * the surviving tab is the one with a project behind it. `ask: false`
     * because there is no question here: this is not a document being put away,
     * it is two views of one document becoming one.
     */
    const already = this.all().find((tab) => normalise(tab.path) === now && tab.id !== moving.id);
    if (already) {
      void this.close(moving.id, false);
      this.reveal(already.id);
      return;
    }
    this.patch(moving.id, {
      path: to,
      /*
       * AND THE SAVE TARGET GOES WITH THE PATH. `savedPath` names the copy the
       * user chose, and for a book opened from their own disk that is their own
       * file — which is a deliberate design and stays right up until the moment
       * the tab stops showing that file. Keeping it here would mean Ctrl+S
       * repacking the working tree over a document on E:\\ while every label on
       * screen said the library's. Main revokes the matching write grant at the
       * same instant, so the two sides cannot disagree; clearing it here is what
       * makes Save fall through to Save As, which is the door that asks.
       */
      ...(moving.savedPath !== null && normalise(moving.savedPath) === was
        ? { savedPath: null, unsaved: true }
        : {}),
      /*
       * THE TITLE ONLY IF NOBODY HAS SET A BETTER ONE. A book's title becomes
       * its `dc:title` when it unpacks — "Working Towards the Führer" rather
       * than the name it arrived under — and overwriting that because the file
       * moved between folders would undo the one piece of naming this app does
       * on the user's behalf.
       *
       * RE-DERIVED RATHER THAN CARRIED, because this move is the exact moment
       * the answer changes: the file is going from a folder of the user's into
       * a project, so the name it should now be wearing is the project's, and
       * `nameFor` is where that is decided once for the whole app.
       */
      ...(moving.named ? {} : { title: this.nameFor(to) }),
    });
  }

  private blankTab(kind: TabKind, path: string, title: string): Tab {
    this.sequence += 1;
    return {
      id: `tab-${this.sequence}`,
      kind,
      path,
      title,
      named: false,
      unsaved: false,
      modified: false,
      savedPath: null,
      layerView: false,
      thumbnails: true,
      pinned: false,
      revision: 0,
      problem: null,
    };
  }

  // ── Panes ────────────────────────────────────────────────────────────────

  byId(id: string | null): Tab | null {
    if (id === null) return null;
    return this.all().find((tab) => tab.id === id) ?? null;
  }

  /**
   * The column HOLDING this document, if any is. At most one, by construction.
   *
   * Holding and not showing: a tab sitting in a strip behind another one is in
   * that column, and every caller of this asks the question that way — "is it on
   * screen somewhere" means "is there a column I can bring it to the front of".
   * `paneShowing` is the narrower question, for the surfaces that draw the
   * difference.
   */
  paneOf(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.tabIds.includes(tabId)) ?? null;
  }

  /** The column with this document ON TOP — what the documents list marks as on screen. */
  paneShowing(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.activeTabId === tabId) ?? null;
  }

  /** True while nothing may close this tab out from under the user. */
  isPinned(tabId: string): boolean {
    return this.byId(tabId)?.pinned === true;
  }

  /**
   * Right-click → Pin / Unpin, on a tab in a strip.
   *
   * A TOGGLE AND NOT TWO METHODS, because the menu draws one item whose label is
   * the answer to the same question this reads.
   */
  togglePin(tabId: string): void {
    const tab = this.byId(tabId);
    if (tab === null) return;
    this.patch(tabId, { pinned: !tab.pinned });
  }

  /**
   * The strip's own click: bring this tab to the front of the column it is in.
   *
   * NOT `reveal`. Reveal would put a tab that is in no column into the FOCUSED
   * one, which is right for a row in the documents list and wrong for a strip —
   * a strip only ever draws tabs that are already in its own pane, so the pane is
   * known and there is nothing to place.
   */
  activateInPane(paneId: string, tabId: string): void {
    this.columns.update((panes) => panes.map((pane) => (
      pane.id === paneId && pane.tabIds.includes(tabId)
        ? { ...pane, activeTabId: tabId }
        : pane)));
    this.focused.set(paneId);
  }

  /**
   * Clicking anywhere in a pane focuses it — that is the whole focus model, and
   * it is why nothing else in the app has to ask which pane it is in.
   */
  focusPane(paneId: string): void {
    if (this.focused() === paneId) return;
    if (this.columns().some((pane) => pane.id === paneId)) this.focused.set(paneId);
  }

  /**
   * Ctrl+1…5. Out of range is a no-op rather than a clamp — 4 means the fourth.
   *
   * IT MIRRORS THE FOCUS ONTO THE POSITION, and it mirrors HERE rather than at the
   * call site because the chord IS this method: `app.ts`'s key handler is its only
   * caller, and nothing in this file reaches it. A pane is focused by the position
   * effect through `this.focused.set` directly, which is the seam that keeps a
   * programmatic reveal out of this door.
   */
  focusPaneAt(index: number): void {
    const pane = this.columns()[index];
    if (!pane) return;
    this.focused.set(pane.id);
    if (pane.activeTabId !== null) void this.standForTab(pane.activeTabId);
  }

  /**
   * Put a newly opened tab in a pane and give it the focus.
   *
   * The first document makes the first pane. After that: a finished job asks
   * for one of its own (up to the cap, past which it takes the rightmost pane's
   * slot), and everything else — a drop, Home's list, the shelf's Open — lands
   * in the pane the user is working in, because they aimed at it.
   *
   * LANDING IN THE FOCUSED PANE NOW REPLACES what that pane was showing, since
   * a pane holds one document. Nothing is lost: the displaced document stays
   * open in the list with its unpack, its edits and its dot, one click from
   * being back on screen. What it is NOT allowed to do is displace a book with
   * a translation of it — that is why a finished job still asks for a column of
   * its own, and why the two rules read differently.
   *
   * `beside` names a pane the new one must open DIRECTLY to the right of, which
   * is what an HTML editor asks for: it is a face of one particular book, and a
   * column of source three panes away from the page it belongs to helps nobody.
   * A conversion's output passes nothing and lands on the end.
   *
   * ── And it JOINS a strip rather than emptying one ───────────────────────────
   *
   * Landing in a column used to overwrite what that column held, because a column
   * held one thing. It now inserts into the strip beside the active tab and takes
   * the front — nothing is displaced by arriving.
   *
   * `replace` is the user's auto-close rule and it is a DIFFERENT act, asked for
   * by the caller rather than implied by landing: *"clicking another file will
   * automatically close the one i was looking at… unless i pin the file"*. So the
   * documents list passes it, the position effect does not (a scan and the book
   * cast from it are two rows of one project and must be able to sit in one strip
   * together), and a finished job does not (it is a comparison, not a
   * replacement). What it does is CLOSE the tab it took the front from — through
   * the ordinary close, so a document with something to lose still gets its
   * question and a "keep" leaves it exactly where it was, in the strip, beside
   * the new one. A pinned tab is never the one it takes.
   */
  private place(
    tabId: string,
    ownPane: boolean,
    beside: string | null = null,
    replace = false,
    intoPane: string | null = null,
  ): void {
    const panes = this.columns();
    if (panes.length === 0) {
      const pane = this.makePane(tabId);
      this.columns.set([pane]);
      this.focused.set(pane.id);
      return;
    }
    if (ownPane && panes.length < MAX_PANES) {
      const pane = this.makePane(tabId);
      const at = beside === null ? -1 : panes.findIndex((candidate) => candidate.id === beside);
      const next = at < 0
        ? [...panes, pane]
        : [...panes.slice(0, at + 1), pane, ...panes.slice(at + 1)];
      this.columns.set(equalise(next));
      this.focused.set(pane.id);
      return;
    }
    /*
     * `intoPane` NAMES THE COLUMN THIS BOOK ALREADY LIVES IN, and it is what
     * keeps the position effect from scattering one project across the window.
     * Clicking the read row opens the cast book; without this it would land in
     * whichever column happened to be focused — the OTHER book's, if the user was
     * reading two — and the scan it is meant to replace on screen would stay
     * exactly where it was, in a column nobody was looking at.
     */
    const named = intoPane === null
      ? null
      : panes.find((pane) => pane.id === intoPane) ?? null;
    const target = named
      ?? (ownPane
        ? crowdedTarget(panes, beside)
        : (this.focusedPane() ?? panes[panes.length - 1]!));
    const displaced = replace ? this.byId(target.activeTabId) : null;
    this.columns.set(panes.map((pane) => (
      pane.id === target.id ? addToStrip(pane, tabId) : pane)));
    this.focused.set(target.id);
    if (displaced !== null && displaced.id !== tabId && !displaced.pinned) {
      void this.close(displaced.id);
    }
  }

  private makePane(tabId: string | null): Pane {
    this.paneSequence += 1;
    return {
      id: `pane-${this.paneSequence}`,
      tabIds: tabId === null ? [] : [tabId],
      activeTabId: tabId,
      flex: 1,
    };
  }

  /**
   * Put a document in front of the user — a click on its row in the list, or a
   * step whose document is already open.
   *
   * IN A STRIP ALREADY: it comes to the front of the column it is in, and the
   * focus goes there. A second viewer over one unpack is two scroll positions
   * fighting over one document — the thing `adopt` refuses to make for two files
   * — and (because `chapterHref` lives on the tab) two columns that appear
   * scroll-locked with nothing on screen saying why.
   *
   * IN NO STRIP: it joins the focused pane's. `replace` is the documents list's
   * auto-close rule; everything that reveals for its own reasons leaves it off.
   */
  reveal(tabId: string, replace = false, intoPane: string | null = null): void {
    if (this.byId(tabId) === null) return;
    const pane = this.paneOf(tabId);
    if (pane) {
      this.activateInPane(pane.id, tabId);
      return;
    }
    this.place(tabId, false, null, replace, intoPane);
  }

  /**
   * Show a document in a named column — a row dropped on a pane's middle, or a
   * tab dragged from one strip into another.
   *
   * IT LEAVES THE STRIP IT CAME FROM, when it had one: a document is in at most
   * one pane. The source column survives with its remaining tabs and only goes
   * when the move emptied it — an empty column nobody asked for is furniture in
   * the way of the two the user is comparing. (An empty column somebody DID ask
   * for — Ctrl+\ — is a different thing and stays until it is filled or closed,
   * which is why this only drops a column the move itself emptied.)
   */
  show(tabId: string, paneId: string): void {
    const panes = this.columns();
    if (this.byId(tabId) === null || !panes.some((pane) => pane.id === paneId)) return;
    const from = panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
    if (from !== null && from.id === paneId) {
      this.activateInPane(paneId, tabId);
      return;
    }
    const going = new Set([tabId]);
    this.columns.set(panes
      .map((pane) => {
        if (pane.id === paneId) return addToStrip(pane, tabId);
        return pane.id === from?.id ? withoutTabs(pane, going) : pane;
      })
      .filter((pane) => pane.id !== from?.id || pane.tabIds.length > 0));
    this.focused.set(paneId);
  }

  /**
   * A tab dropped INTO A STRIP — reordered inside its own column, or moved into
   * another one, landing in front of `beforeTabId` (null means the end).
   *
   * ONE METHOD FOR BOTH, because from the hand's side they are one gesture: pick
   * a tab up, put it down between two others. Which column it started in is this
   * function's problem and not the drag's, and splitting it in two would mean the
   * workspace deciding — from a drop's geometry — which of two service calls it
   * was making, and getting it wrong at exactly the boundary between them.
   *
   * The column it left goes only if the move emptied it, which is `show`'s rule
   * and for `show`'s reason.
   */
  dropInStrip(tabId: string, paneId: string, beforeTabId: string | null): void {
    const panes = this.columns();
    if (this.byId(tabId) === null || tabId === beforeTabId) return;
    const to = panes.find((pane) => pane.id === paneId);
    if (to === undefined) return;
    const from = panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
    const without = to.tabIds.filter((id) => id !== tabId);
    const at = beforeTabId === null ? -1 : without.indexOf(beforeTabId);
    const index = at < 0 ? without.length : at;
    const landed: Pane = {
      ...to,
      tabIds: [...without.slice(0, index), tabId, ...without.slice(index)],
      activeTabId: tabId,
    };
    const going = new Set([tabId]);
    this.columns.set(panes
      .map((pane) => {
        if (pane.id === paneId) return landed;
        return pane.id === from?.id ? withoutTabs(pane, going) : pane;
      })
      .filter((pane) => pane.id === paneId || pane.id !== from?.id || pane.tabIds.length > 0));
    this.focused.set(paneId);
  }

  /**
   * Insert a column at `atIndex` showing this document — a row dropped on the
   * left or right edge band of a pane.
   *
   * THE CAP IS SAID BY NAME. The drop preview does not light up an edge band
   * once there are five columns (a target that lights and then does nothing is
   * worse than one that visibly will not take it), so this is only reachable by
   * a drop the preview never promised — and a gesture that lands on nothing has
   * to say why. Refused even when the document is already in a column and the
   * move would be net-zero: the preview cannot offer that without knowing what
   * the drag carries, and an operation that works only when you cannot see that
   * it will is not an operation.
   */
  openInNewPane(tabId: string, atIndex: number): void {
    const panes = this.columns();
    if (this.byId(tabId) === null) return;
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const from = panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
    const going = new Set([tabId]);
    const fresh = this.makePane(tabId);
    const at = Math.max(0, Math.min(atIndex, panes.length));
    // The source column KEEPS ITS OTHER TABS and only goes when tearing this one
    // out left it with nothing — the strip is what makes the difference from the
    // one-document-per-column version of this, where the source was always empty.
    this.columns.set(equalise([...panes.slice(0, at), fresh, ...panes.slice(at)]
      .map((pane) => (pane.id === from?.id ? withoutTabs(pane, going) : pane))
      .filter((pane) => pane.id !== from?.id || pane.tabIds.length > 0)));
    this.focused.set(fresh.id);
  }

  /**
   * Ctrl+\ and View → Split right: an EMPTY column beside the focused one.
   *
   * It used to move the active tab out of a stack, which is an operation that
   * no longer exists — a pane holds one document, so there is nothing to move
   * out of it. What the chord means now is "make me somewhere to put something",
   * and the user fills it by clicking a row in the list, dragging one onto it,
   * or opening a book from the Home page it shows until they do.
   *
   * ALL THREE REFUSALS ARE SAID. This is reachable from a menu item and a
   * keyboard chord, neither of which can grey itself out against renderer
   * state, so the ways it cannot happen have to arrive as sentences — a Ctrl+\
   * that silently does nothing is indistinguishable from a Ctrl+\ that is broken.
   */
  newEmptyPane(): void {
    const panes = this.columns();
    if (panes.length === 0) {
      this.notice.set('There is nothing open to put a column beside — open a document first.');
      return;
    }
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const at = panes.findIndex((pane) => pane.id === this.focused());
    if (at >= 0 && panes[at]!.tabIds.length === 0) {
      this.notice.set('This column is already empty — put a document in it before making another.');
      return;
    }
    const fresh = this.makePane(null);
    const index = at < 0 ? panes.length : at + 1;
    this.columns.set(equalise([...panes.slice(0, index), fresh, ...panes.slice(index)]));
    this.focused.set(fresh.id);
  }

  /**
   * Take a column away without closing what is in it.
   *
   * The ✕ on an empty column's Home page, which is the only way an empty one
   * can go: a column with a document in it is closed by closing the document
   * (see `dropFromPanes`), and there is deliberately no gesture that puts a book
   * away and leaves a hole where it was.
   */
  closePane(paneId: string): void {
    const panes = this.columns();
    const at = panes.findIndex((pane) => pane.id === paneId);
    if (at < 0) return;
    const kept = panes.filter((pane) => pane.id !== paneId);
    // Not equalised, for the reason `dropFromPanes` gives: the survivors keep
    // the shares the user dragged and flex reflows them across the width.
    this.columns.set(kept);
    if (this.focused() === paneId) {
      this.focused.set(kept[Math.min(at, kept.length - 1)]?.id ?? null);
    }
  }

  /**
   * Move a document in the list — a row dragged onto another row.
   *
   * `beforeTabId` names the document it lands in front of; null means the end.
   * This is the ONLY place a document's order is decided now that the strips
   * are gone, which is why it writes the flat list rather than any pane.
   */
  reorder(tabId: string, beforeTabId: string | null): void {
    if (tabId === beforeTabId) return;
    const tabs = this.all();
    const moving = tabs.find((tab) => tab.id === tabId);
    if (!moving) return;
    const without = tabs.filter((tab) => tab.id !== tabId);
    const at = beforeTabId === null ? -1 : without.findIndex((tab) => tab.id === beforeTabId);
    const index = at < 0 ? without.length : at;
    this.all.set([...without.slice(0, index), moving, ...without.slice(index)]);
  }

  /**
   * A divider drag. Two neighbours, one number moved between them.
   *
   * Only the pair either side of the divider changes, so the rest of the row
   * does not twitch while a divider is dragged — the caller does the pixel
   * arithmetic against the real widths and hands back the two shares.
   */
  resize(leftPaneId: string, leftFlex: number, rightPaneId: string, rightFlex: number): void {
    this.columns.update((panes) => panes.map((pane) => {
      if (pane.id === leftPaneId) return { ...pane, flex: Math.max(0.05, leftFlex) };
      if (pane.id === rightPaneId) return { ...pane, flex: Math.max(0.05, rightFlex) };
      return pane;
    }));
  }

  // ── Living with them ─────────────────────────────────────────────────────

  /**
   * The rail's Home. Home is "this column is showing nothing", not a document.
   *
   * THE STRIP STAYS. Nothing was closed — the tabs are still this column's, still
   * drawn along its top, and one click from coming back — which is a better Home
   * than the one that emptied the column, because it does not make somebody go
   * and find their book in the list again to undo pressing a button.
   */
  goHome(): void {
    const pane = this.focusedPane();
    if (!pane) return;
    this.columns.update((panes) => panes.map((candidate) =>
      (candidate.id === pane.id ? { ...candidate, activeTabId: null } : candidate)));
  }

  /**
   * The project this window is in — set by looking at any of its documents,
   * kept when the last of them closes, cleared only by leaving on purpose.
   * See the constructor's effect for the ruling.
   */
  readonly heldProject = signal<string | null>(null);

  /** Leaving for the library, on purpose — the one thing that clears the hold. */
  releaseProject(): void {
    this.heldProject.set(null);
  }

  /**
   * Ctrl/Cmd+Tab. Walks THE FOCUSED COLUMN'S OWN STRIP, wrapping.
   *
   * IT MEANS WHAT IT SAYS NOW. It used to walk the whole window's flat list and
   * pull whichever document came next INTO this column — skipping the ones
   * another column had, because taking one would have swapped two columns'
   * contents rather than advanced one. That was the best a chord called "next
   * tab" could do in an app with no tabs: a cycle that moved documents between
   * columns to simulate a strip that was not there.
   *
   * There is a strip now, so this is the strip's own cycle: the next tab in this
   * column, then round. A column holding one document has nowhere to go and the
   * chord does nothing, which is honest — the other four columns' documents are
   * not this column's to riffle through.
   *
   * AND IT MOVES THE POSITION WITH IT, on `focusPaneAt`'s reasoning: the chord is
   * this method, `app.ts` is its only caller, and stepping from the scan to the
   * book with a keystroke is the same statement as clicking the tab. The mirror is
   * outside `activateInPane` on purpose — that one is also how a library click
   * lands its document (see `standForTab`).
   */
  nextTab(): void {
    const pane = this.focusedPane();
    if (!pane || pane.tabIds.length === 0) return;
    const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
    const next = pane.tabIds[(at + 1) % pane.tabIds.length];
    if (next === undefined) return;
    this.activateInPane(pane.id, next);
    void this.standForTab(next);
  }

  /**
   * Close every tab showing one of these files — the window letting go of what is
   * about to be erased.
   *
   * ── Why it is the paths and not a tab id ────────────────────────────────────
   *
   * A step delete names PAYLOADS, not tabs: main is destroying `generated/<book>
   * (en).epub` and knows nothing about which panes this window has open, and only
   * this side can close one. So the caller hands over the list main gave it and
   * this matches whole paths, folded — never a basename, because a project holds
   * `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf` at once and
   * closing by last segment would shut the scan for a delete aimed at a reprint.
   *
   * WITHOUT ASKING. Every caller has already put a confirm on screen naming
   * exactly these losses, and a second dialog about unsaved changes in a document
   * that is being destroyed is a question with no useful answer.
   *
   * A COPY OF THE LIST FIRST, because closing mutates the very signal this reads.
   */
  async closeShowing(files: readonly string[]): Promise<void> {
    const doomed = new Set(files.map((file) => fold(file)));
    const ids = this.all()
      .filter((tab) => doomed.has(fold(tab.path)))
      .map((tab) => tab.id);
    for (const id of ids) await this.close(id, false);
  }

  /**
   * The window is going — every open document gets the question first.
   *
   * ── Why quitting comes back to this class ───────────────────────────────────
   *
   * Quit used to skip closing altogether: the window was destroyed and the tabs
   * went with it, so nothing was asked about any of them. That was survivable
   * while the only thing at stake was a copy of a file the user had been warned
   * about, and it stopped being survivable the moment closing a scan became the
   * event that ends a session's undo history — quitting with four books open
   * converted "undoable" into "permanent" four times over, silently. Main cannot
   * ask on its own: it knows which files were ever opened, not which documents
   * are open now, and that is renderer state.
   *
   * THE SAME QUESTION, DOCUMENT BY DOCUMENT, and not a summary of all of them.
   * Every one of these losses is about a particular book — its corrections, its
   * save, its copy — and a dialog that pooled four books into one number would be
   * asking somebody to make four decisions with one button. `keep` on any of them
   * stops the quit where it stands: the person said they wanted that book, and
   * carrying on to ask about the next one would be the app negotiating.
   *
   * NOTHING IS CLOSED HERE. The tabs are asked about and left exactly as they are;
   * main destroys the window if the answer is yes. Closing them one by one first
   * would leave a cancelled quit with a window somebody had emptied on their way
   * to changing their mind.
   */
  async letGo(): Promise<boolean> {
    /*
     * THE TABS THIS SWEEP HAS ALREADY ACCOUNTED FOR, which is what makes the
     * corrections question fire exactly once for a project with two of them open.
     *
     * `questionBefore` skips the corrections when another open tab still reaches
     * the same project's decisions — see it for why. In a sweep that is every tab
     * of the project, so with nothing carried between iterations each tab would
     * point at the next as the one that still holds them and NOBODY would be
     * asked: the window would close on a project's uncommitted decisions in
     * silence, which is the exact failure this sweep exists to prevent. Carrying
     * the ones already passed makes the LAST tab of each project the one with
     * nothing left to point at, and it is the one that asks.
     */
    const accountedFor = new Set<string>();
    // A copy, because a save made from the dialog can repaint the list underneath
    // this loop, and an iteration over the live signal would be walking an array
    // that moved.
    for (const tab of [...this.all()]) {
      if (await this.questionBefore(tab.id, accountedFor) === 'stay') return false;
      accountedFor.add(tab.id);
    }
    return true;
  }

  /**
   * What this document has to say for itself before it goes, asked once — and
   * ONLY when something would actually be lost.
   *
   * ── THE QUESTION THAT WAS ASKED ABOUT NOTHING ───────────────────────────────
   *
   * This used to ask whenever a tab was `unsaved`, and `unsaved` means "no copy
   * of this exists anywhere you chose" — which is true FROM BIRTH of every book
   * this app opens out of a project, because the project IS where it lives. So
   * closing a tab somebody had done nothing but look at raised a dialog about a
   * loss that had not happened, and a warning that fires when nothing is at stake
   * is how a person learns to dismiss the one that matters. The user ruled on it
   * in a sentence: *"only pop up a confirmation alert if changes have been
   * made."*
   *
   * It is also a warning that outlived its workflow. It was written when Save put
   * a copy somewhere of the user's choosing and the app could reasonably say "you
   * have not done that yet"; saving is the export modal's job now
   * (docs/WORKBENCH.md §6), a project tab that closes loses track of nothing, and
   * Home still lists the book. The DOT stays — `Tab.unsaved` is a fact worth
   * drawing — but it is not a reason to stop somebody on their way out.
   *
   * ── ONE QUESTION FOR TWO LOSSES ─────────────────────────────────────────────
   *
   * A book's filed copy can be out of date, and a scan's corrections can have no
   * save to come back to. Main composes whichever of the two are true into one
   * card, because this codebase has already ruled that a closing document is
   * asked about once (`closeShowing`): a second dialog on top of the first is the
   * app arguing with an answer it already has.
   *
   * ── And the offer to keep the work is a button, not advice ─────────────────
   *
   * A dialog whose only route to keeping the work is *cancel, hunt for Apply,
   * close again* has made the user do the app's job, and the way that ends is
   * that they stop reading the box. So the answer can be "apply these changes,
   * then close" — and it goes through the pane's own `apply`, the same path the
   * sheet's own button takes, rather than a second commit written for this
   * dialog. AN APPLY MAIN REFUSES LEAVES THE TAB OPEN: closing anyway would have
   * thrown away the very thing the answer asked to keep, and main's own sentence
   * is already in the notice strip saying why it would not land.
   */
  private async questionBefore(
    id: string,
    /**
     * Tabs this same operation has already dealt with — see `letGo`. Empty for
     * an ordinary close, which is dealing with exactly one.
     */
    accountedFor: ReadonlySet<string> = EMPTY_IDS,
  ): Promise<'go' | 'stay'> {
    const current = this.byId(id);
    if (current === null || !api) return 'go';
    /*
     * ── THE SCRAP-GUARD, AND IT IS THE ONE REAL LOSS THIS CARD EVER DESCRIBES ──
     *
     * The other thing this used to ask about — the block editor's uncommitted
     * CURATION — is gone with that editor, and it was never a loss: every strike
     * was already on disk and what ended was a way back. The book pane's stack is
     * the opposite — in memory, the only copy, and scrapped by closing, which is
     * the ruling (docs/RENDERER.md §3: "Apply writes and clears; closing without
     * applying scraps it"). It is asked about PER TAB: a stack belongs to one pane
     * and closing that pane is the moment it goes, whatever else is open onto the
     * same book.
     */
    const stack = current.kind === 'book' ? this.bookStackFor(current.id) : null;
    /*
     * A BACKGROUND BOOK TAB HAS NO LIVE PANE AND STILL HAS A STACK — the parked
     * one (`parkedStacks`). Closing it from the strip while another tab is up
     * would otherwise skip this question entirely and drop unwritten work with
     * no sentence anywhere, which is the one loss this card exists to prevent.
     */
    const parked = stack === null && current.kind === 'book'
      ? this.parkedStacks.get(current.id) ?? null
      : null;
    const edits = stack !== null && stack.pending() > 0
      ? stack.pending()
      : parked !== null && unwritten(parked.landed, parked.pending) > 0
        ? unwritten(parked.landed, parked.pending)
        : null;
    if (!current.modified && edits === null) return 'go';

    const answered = await api.confirmClose({
      title: current.title,
      modified: current.modified,
      savedPath: current.savedPath,
      edits,
    });
    if (answered === 'keep') return 'stay';
    /*
     * A REFUSAL LEAVES THE TAB OPEN: closing anyway would throw away the very
     * thing the answer asked to keep, and main's own sentence is already on the
     * notice strip saying why it would not land.
     */
    if (answered === 'save' && stack !== null) return await stack.apply() ? 'go' : 'stay';
    if (answered === 'save' && parked !== null) {
      /*
       * APPLYING A PARKED STACK NEEDS NO PANE: the doors are main's
       * (`book:amend` rewrites the tip the person was standing on;
       * `book:apply` lands a step), and the pane was only ever the thing that
       * pressed them. Amend when the parked stack grew out of a recorded tip,
       * exactly as the pane itself decides.
       */
      try {
        const history = parked.landed.length > 0
          ? await api.book.amend(current.path, parked.pending)
          : await api.book.apply(current.path, parked.pending);
        this.ledger.adopt(current.path, history);
        return 'go';
      } catch (err) {
        this.notice.set(err instanceof Error ? err.message : String(err));
        return 'stay';
      }
    }
    return 'go';
  }

  /**
   * How many OTHER open tabs would still reach this document's project after it
   * goes — the count that decides whether the corrections question is owed.
   *
   * EDITORS DO NOT COUNT. An editor tab is a face of its book rather than a
   * document of its own, and closing the book closes it (`close`), so counting
   * one would be counting the tab that is going with this one.
   *
   * A DOCUMENT IN NO PROJECT HAS NO SIBLINGS: somebody's own PDF out of their
   * Downloads folder has no project, no curation and nothing to be the last way
   * back to. Zero is the honest answer and it is also the one that lets the
   * question be asked, which costs nothing — main answers null for it.
   */
  private otherTabsIn(doomed: Tab, accountedFor: ReadonlySet<string>): number {
    const dir = this.projectDirOf(doomed);
    if (dir === null) return 0;
    const key = fold(dir);
    return this.all().filter((tab) => {
      if (tab.id === doomed.id || accountedFor.has(tab.id)) return false;
      const own = this.projectDirOf(tab);
      return own !== null && fold(own) === key;
    }).length;
  }

  /**
   * Close a tab, asking first when it has something to lose.
   *
   * The question is `questionBefore` above, asked in the app's own card
   * (`ConfirmService`). THE BOOK IS NOT DELETED EITHER WAY (see
   * electron/workspace.ts) and neither are its corrections, so what closing costs
   * is a filed copy left behind and a state they can come back to, never the work
   * itself.
   *
   * `ask: false` FOR A CLOSE THAT IS PART OF A DELETE, and it is the difference
   * between one question and two. The question's whole subject is work the user
   * might want to keep — a copy to keep track of, corrections to keep a way back
   * to — and a document being deleted is one where all of that is false and the
   * offer to save it is an offer to write bytes into a file about to be
   * unlinked. The delete's own confirmation asked the only question there is; a
   * second card on top of it, asking about saving the thing they just told the
   * app to destroy, is the app arguing with an answer it already has.
   */
  async close(id: string, ask = true): Promise<void> {
    if (!this.all().some((candidate) => candidate.id === id)) return;
    if (ask && await this.questionBefore(id) === 'stay') return;

    // The list is re-read AFTER the dialog: that box is modal to the window but
    // not to the app, and a conversion can finish and open a tab while it is up.
    const tabs = this.all();
    if (!tabs.some((candidate) => candidate.id === id)) return;

    const going = new Set<string>([id]);
    // The parked stack goes with the tab — the closing question above already
    // asked about it, so this is the scrap the person chose.
    this.parkedStacks.delete(id);
    this.all.set(tabs.filter((candidate) => !going.has(candidate.id)));
    /*
     * NOTHING PER-TAB IS LEFT TO FORGET, and the emptiness is the wave landing.
     * A close used to drop five maps keyed by tab id — the frame's selection and
     * category tally, the persisted undo ledger, whether a block was being typed
     * in, and the translation world a word edit belonged to — and every one of
     * them served a surface that is deleted (docs/RENDERER.md §7). What a tab
     * still owns is its BookStack, and that is released by the pane that
     * registered it (`releaseBookStack`), because the pane is what knows the
     * stack has finished with the document rather than merely lost its column.
     */
    this.dropFromPanes(going);
  }

  /**
   * CLOSING A DOCUMENT FALLS BACK TO ITS NEIGHBOUR IN THE STRIP, and closing the
   * LAST of a column closes the column.
   *
   * The neighbour is the strips' whole difference here. Before them a pane held
   * one document and had nothing to fall back to, so every close took a column
   * with it; now a column with three tabs in it loses one and keeps its place,
   * which is what a person closing a document out of a stack means.
   *
   * An EMPTIED column still goes. Leaving one behind would mean closing four
   * books left four Home pages side by side, which is a workspace nobody
   * arranged — and closing the last document takes the last column with it, so
   * the window is Home again exactly as it was before any of this.
   *
   * The focus lands on the column that took the closed one's place, which is
   * the browser's rule for tabs one level up.
   */
  private dropFromPanes(going: ReadonlySet<string>): void {
    const panes = this.columns();
    const kept: Pane[] = [];
    let focusAt = -1;
    for (const pane of panes) {
      const left = withoutTabs(pane, going);
      // EMPTIED BY THIS CLOSE, and not merely empty. A column somebody made with
      // Ctrl+\ is empty on purpose and waiting to be filled; dropping it because
      // a document closed three columns away would take away the place they had
      // just made to put something.
      if (pane.tabIds.length > 0 && left.tabIds.length === 0) {
        if (pane.id === this.focused()) focusAt = kept.length;
        continue;
      }
      kept.push(left);
    }
    // Not equalised: the panes that remain keep their shares and flex reflows
    // them across the width, which is what the user arranged. Only ADDING a
    // pane resets to equal, because a new column has no share to keep.
    this.columns.set(kept);
    if (focusAt >= 0) {
      this.focused.set(kept[Math.min(focusAt, kept.length - 1)]?.id ?? null);
    }
  }

  async closeActive(): Promise<void> {
    const tab = this.active();
    if (tab) await this.close(tab.id);
  }

  // ── The PDF viewer's two view modes ──────────────────────────────────────

  toggleLayerView(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, layerView: !tab.layerView } : tab)));
  }

  toggleThumbnails(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, thumbnails: !tab.thumbnails } : tab)));
  }

  /**
   * The project this document belongs to, or null for a file opened from elsewhere.
   *
   * A `book` TAB NAMES ITS PROJECT DIRECTLY (see `TabKind`), so it is answered
   * from the tab rather than looked up: `projectFor` asks which project a FILE is
   * inside, and a directory is not inside itself. Asked of the catalogue anyway,
   * so that a directory this window no longer has a project for answers null like
   * anything else — the alternative is a tab claiming to belong to a book that has
   * left the library.
   */
  private projectDirOf(tab: Tab): string | null {
    if (tab.kind !== 'book') return this.projects.projectFor(tab.path)?.dir ?? null;
    const key = fold(tab.path);
    return this.projects.items().find((project) => fold(project.dir) === key)?.dir ?? null;
  }

  /** Ctrl/Cmd+Z, from the Edit menu. The focused document's, never a global one. */
  async undo(): Promise<void> {
    await this.replay('undo');
  }

  /** Ctrl/Cmd+Shift+Z. */
  async redo(): Promise<void> {
    await this.replay('redo');
  }

  /**
   * Put one change back — which is now one stack, in one place.
   *
   * THERE WERE FIVE DOORS INTO THIS FUNCTION AND THERE IS ONE. The chord used to
   * be routed by what the focused tab was: a caret in an iframe took the typing
   * back, a scan replayed rows into the live curation, a cast book replayed them
   * into somebody's markup, and two of those three consulted a persisted ledger
   * on disk. All of it is deleted with the surfaces that had it
   * (docs/RENDERER.md §7). What is left is the proof sheet's LIFO of ops, held in
   * memory until Apply writes them down (§3) — so this is the one undo in the app
   * and it touches no disk at all: no ledger to read back, no file to put a row
   * into, nothing to await.
   *
   * IT IS STILL ASYNC, and deliberately: the menu action and the two public
   * wrappers are `Promise`-typed across the app, and narrowing them here would be
   * a signature change in five call sites to save one microtask.
   *
   * EVERY REFUSAL IS A SENTENCE, including "there is nothing to undo": the menu
   * item cannot grey itself out against renderer state, so a chord that quietly
   * did nothing would be indistinguishable from a chord that is broken.
   */
  private async replay(direction: 'undo' | 'redo'): Promise<void> {
    const tab = this.activeDocument();
    if (!api || !tab) {
      this.notice.set('There is no document in front of you to undo anything in.');
      return;
    }
    /*
     * THE BOOK'S STACK IS THE PANE'S, AND THE CHORD IS ROUTED TO IT.
     *
     * It is a LIFO of ops held in memory until Apply writes them down
     * (docs/RENDERER.md §3), so this is the one undo in the app that touches no
     * disk at all — no ledger to read back, no file to put a row into, nothing to
     * await. What arrives here is a chord main swallowed as a menu accelerator,
     * and this function is where the window decides which of its three undos it
     * meant; the pane deliberately adds no listener of its own, because two
     * answers to one keypress is how a book and a text field end up both taking
     * one back.
     *
     * EVERY REFUSAL IS STILL A SENTENCE, which is this function's own rule: a
     * chord that quietly did nothing cannot be told from a chord that is broken.
     * "Nothing to undo" on a book that has never been touched and on a book whose
     * stack has just been applied are the same true statement, and both are worth
     * making — the second one especially, because Apply is exactly the moment
     * somebody's next instinct is Ctrl+Z.
     */
    if (tab.kind === 'book') {
      const stack = this.bookStackFor(tab.id);
      if (stack === null) {
        this.notice.set(`${tab.title} is still opening.`);
        return;
      }
      if (direction === 'undo') {
        if (!stack.canUndo()) {
          this.notice.set(
            `There is nothing to undo in ${tab.title}. Changes on the book are taken back until you `
            + 'apply them; applying makes them a row in Steps you can stand on instead.',
          );
          return;
        }
        stack.undo();
        return;
      }
      if (!stack.canRedo()) {
        this.notice.set(`There is nothing to redo in ${tab.title}.`);
        return;
      }
      stack.redo();
      return;
    }
    /*
     * AND ANYTHING ELSE HAS NO STACK, which is the honest end of the routing
     * rather than a fall-through. A scan is a photograph and the app does not
     * edit one (docs/RENDERER.md §0 A1); the sentence names the surface that
     * does, because a chord that quietly did nothing is this function's own
     * definition of a failure nobody can act on.
     */
    this.notice.set(
      `There is nothing to undo in ${tab.title}. Changes are made on the book — open it from the `
      + 'step you want to work from, and undo takes them back until you apply them.',
    );
  }

  /**
   * Something outside this service edited the document on disk.
   *
   * Today that is the Metadata dialog, which writes the package (or the working
   * PDF) through the engine rather than through any of the member writes above.
   * The flag it sets is the one that matters: the working copy has moved ahead
   * of whatever was last filed, so Save has work to do.
   *
   * NO REVISION BUMP, deliberately. Nothing in any chapter's markup moved, and
   * reloading the rendered pane would cost the reader their place in order to
   * repaint a page that looks identical.
   */
  noteDocumentEdited(id: string): void {
    this.patch(id, { modified: true });
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  /**
   * Ctrl/Cmd+S — which, for everything this app still opens, is Save As.
   *
   * NOTHING IN THIS APP EDITS A FILE ANY MORE. A book is not a file at all (see
   * `saveAs`), and a scan is a photograph the app only ever reads — so there is
   * no destination a silent re-save could write to that would carry anything the
   * previous copy did not. The one thing Ctrl+S can do is ask where, which is
   * exactly what Save As is; the branch that repacked a working tree over the
   * file it came from went with the working tree (docs/RENDERER.md §7).
   */
  async save(id: string): Promise<void> {
    await this.saveAs(id);
  }

  /**
   * Ctrl/Cmd+Shift+S. Always the picker.
   *
   * A PDF saves as a COPY of the finished file: a conversion's output lives in
   * the workspace until this puts it somewhere the user chose, and that is the
   * whole difference between "foundry made me a PDF I can read" and "there is a
   * PDF I can read in a folder I know about". It is the only kind that saves at
   * all: the book is not a file, and Export is the door a finished copy of it
   * leaves by.
   */
  async saveAs(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!api || !tab) return;
    /*
     * THE BOOK IS NOT A FILE, so there is nothing for a picker to write. It is
     * made from the pages this project was read from and it is remade from them at
     * will; what a person actually wants from Save here is a finished copy, which
     * is Export — the door that renders the position through the whole ledger and
     * files the result. Said rather than silently ignored, because a chord that
     * does nothing reads as a broken app.
     */
    if (tab.kind === 'book') {
      this.notice.set(
        `${tab.title} is the book itself, not a file — Export files a finished copy of it.`);
      return;
    }
    try {
      const destination = await api.documentSaveCopy(
        tab.path, suggestName(baseName(tab.path), '.pdf'));
      if (destination === null) return;
      this.patch(tab.id, { unsaved: false, savedPath: destination });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /** The menu's Save / Save As. The focused pane's document. */
  async saveActive(): Promise<void> {
    const tab = this.active();
    if (tab === null) return;
    /*
     * CTRL+S OVER AN EXPORT VIEW SAVES A COPY — the user's own reading of the
     * chord (2026-08-16). The tab's file is finished and already filed in the
     * project's tray; "save" over it can only mean "put a copy where I choose",
     * which is the export door's dialog. Both chords say it, because Save and
     * Save As collapse to one meaning over a file this app will never rewrite.
     */
    if (tab.viewOnly === true) {
      await api?.saveExport(tab.path).catch((err: unknown) => {
        this.notice.set(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    await this.save(tab.id);
  }

  async saveActiveAs(): Promise<void> {
    const tab = this.active();
    if (tab === null) return;
    if (tab.viewOnly === true) {
      await api?.saveExport(tab.path).catch((err: unknown) => {
        this.notice.set(err instanceof Error ? err.message : String(err));
      });
      return;
    }
    await this.saveAs(tab.id);
  }

  private patch(id: string, changes: Partial<Tab>): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }
}

/**
 * Every pane an equal share.
 *
 * Applied when a pane is ADDED and not when one is removed: a new column has no
 * share of its own to keep, and taking the row back to equal is the only
 * arrangement that does not favour whichever neighbour happened to be widest.
 * Removing a pane leaves the others alone — flex already reflows them in
 * proportion, which is the arrangement the user made.
 */
function equalise(panes: readonly Pane[]): Pane[] {
  return panes.map((pane) => ({ ...pane, flex: 1 }));
}

/**
 * Put a document into this column's strip and bring it to the front.
 *
 * DIRECTLY AFTER THE ACTIVE TAB rather than at the end, because that is where a
 * person looking at one thing expects the next thing to appear — the browser's
 * rule for "open in new tab" from the page you are on, and the only placement
 * under which the auto-close rule leaves the strip in the order it was in.
 *
 * Already in this strip is an ACTIVATION and nothing else: the order is the
 * user's and re-inserting a tab they had dragged somewhere would move it under
 * the click that only meant "show me that one".
 */
function addToStrip(pane: Pane, tabId: string): Pane {
  if (pane.tabIds.includes(tabId)) return { ...pane, activeTabId: tabId };
  const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
  const index = at < 0 ? pane.tabIds.length : at + 1;
  return {
    ...pane,
    tabIds: [...pane.tabIds.slice(0, index), tabId, ...pane.tabIds.slice(index)],
    activeTabId: tabId,
  };
}

/**
 * Take documents out of a strip, and answer what the column shows now.
 *
 * THE NEIGHBOUR TO THE RIGHT, then the one to the left — the browser's rule for
 * closing a tab, and the one that does not make a person hunt for where they
 * were. A strip emptied entirely goes to Home, which is what the caller then
 * decides whether to keep as a column at all.
 */
function withoutTabs(pane: Pane, going: ReadonlySet<string>): Pane {
  if (!pane.tabIds.some((id) => going.has(id))) return pane;
  const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
  const tabIds = pane.tabIds.filter((id) => !going.has(id));
  if (pane.activeTabId !== null && !going.has(pane.activeTabId)) {
    return { ...pane, tabIds };
  }
  const after = pane.tabIds.slice(at + 1).find((id) => !going.has(id));
  const before = [...pane.tabIds.slice(0, Math.max(0, at))].reverse().find((id) => !going.has(id));
  return { ...pane, tabIds, activeTabId: after ?? before ?? tabIds[0] ?? null };
}

/**
 * Which column a document that wanted one of its OWN has to settle for, once
 * there are five and there are no more to make.
 *
 * The rightmost, normally — a conversion's output has no opinion about where it
 * lands, and the far end displaces the least of what the user was looking at.
 *
 * BUT NOT WHEN IT ASKED TO BE BESIDE SOMETHING. An HTML editor is a face of one
 * particular book, and at the cap "the rightmost column" can BE that book's
 * column: pressing Edit HTML would then replace the page with its own source,
 * which is the one arrangement the feature exists to avoid. So it takes the
 * column just right of the book instead, or just left when the book is already
 * the last one. Something is displaced either way — that is what a full window
 * means — but never the document the gesture was about.
 */
function crowdedTarget(panes: readonly Pane[], beside: string | null): Pane {
  const last = panes[panes.length - 1]!;
  if (beside === null) return last;
  const at = panes.findIndex((pane) => pane.id === beside);
  if (at < 0) return last;
  return panes[at + 1] ?? panes[at - 1] ?? last;
}

/** Windows paths differ by case and separator and are the same file. */
function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * What the save dialog opens pre-filled with.
 *
 * THE FILE'S OWN NAME, AND THIS IS ONE OF THE TWO PLACES A FILENAME BELONGS.
 * Everywhere else in this window a document is called by its book — the pane's
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
function suggestName(fileName: string, extension: '.epub' | '.pdf'): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = cleaned.length > 0 ? cleaned : 'book';
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
}
