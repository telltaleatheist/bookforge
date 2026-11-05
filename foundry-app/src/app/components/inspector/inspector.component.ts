import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { pdfCategoryLabel } from '@owen/foundry-core/shared/categories';
import type { BookOp, Replayed } from '@owen/foundry-core/shared/ops';

import { LedgerService } from '../../core/ledger.service';
import { ProjectsService } from '../../core/projects.service';
import { BookStacksService, type BookStack } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { AskPanelComponent } from '../ask-panel/ask-panel.component';
import { chapterSpan } from '@owen/foundry-core/shared/flow';

/**
 * The inspector — what the focused book IS, down the right-hand side.
 *
 * Final Cut Pro's inspector is the reference and the shape is deliberate: a
 * column of accordion sections, all open by default, each scrolling INSIDE
 * ITSELF. One long scroll for the whole panel would mean a book with sixty
 * chapters pushes the category rows off the bottom of the screen, and the
 * category rows are the half a curator uses every few seconds.
 *
 * IT IS IN THE SHELL AND NOT IN THE PANE, which is the change that pays for
 * itself. The chapter list used to be a 260px column inside each book's own
 * viewer, so five open books were five copies of the same furniture eating 1300
 * pixels of a window whose whole job is showing pages. There is one of it now and it
 * follows the FOCUSED document — the same thing the rail, Ctrl+S and the menu
 * mean by "what I am working on" (`StageService.activeDocument`).
 *
 * ── WHAT IT KNOWS, WHICH IS ONE PANE'S OWN REPLAY ────────────────────────────
 *
 * The book pane registers itself with the service as a `BookStack`, and every row
 * drawn here is read out of that pane's replay while every button pushes an op
 * onto that pane's stack. This component holds no copy of the book, no list of
 * ops and no idea where any of it is kept — which is what lets the panels live in
 * the shell (RENDERER-DESIGN.md §5) while undo, redo and Apply go on meaning one
 * thing.
 *
 * IT USED TO ASK AN IFRAME. The rendered chapter was a sandboxed frame with an
 * opaque origin, so everything about the page arrived as posted messages and
 * everything done to it went back the same way. That whole channel is deleted
 * (docs/RENDERER.md §7), and with it this panel's Category section, its Contents
 * section and its word-correction box: the surfaces those addressed are gone, and
 * what is left is the three panels the proof sheet owns.
 */
/**
 * THE PANEL'S WIDTH IS A SHARE OF THE WINDOW, not a number of pixels (Owen,
 * 2026-11-03: *"no matter how big it is, the left side nav can take 20% - 25%
 * of the screen maybe. then the other 75% - 80% can be split between the right
 * side nav and the main window/book"*). The library is 22% (open-documents);
 * the default here is half of the 78% left, so the book and this panel stand
 * even at every window size. A drag stores the share it ends on, so a dragged
 * width keeps its proportion when the window changes size. Before this it was
 * 520px fitted against a 384px library (doubled 2026-11-02 for Ask), and a
 * width stored in pixels under the old key is no longer read.
 */
const DEFAULT_SHARE = 0.39;
/** The narrowest it goes, in px, and the widest share of the window a drag can take. */
const MIN_WIDTH = 220;
const MAX_SHARE = 0.7;
/** The shortest an open section can be dragged, in pixels: its header and a row or two. */
const MIN_SECTION = 72;
/** Ask starts with a larger share: it is the section that reads a conversation. */
const DEFAULT_WEIGHTS: Record<string, number> = { chapters: 1, notes: 1, furniture: 1, ask: 1.5 };
const SHARE_KEY = 'foundry.inspector.share';
const WEIGHTS_KEY = 'foundry.inspector.weights';

/*
 * STORAGE IS A CONVENIENCE AND MAY BE ABSENT — a private window, blocked site
 * data. Every read falls back to the defaults and every write may fail
 * quietly; the panel draws the same either way.
 */
function readShare(): number {
  try {
    const held = localStorage.getItem(SHARE_KEY);
    const n = held === null ? NaN : Number(held);
    return Number.isFinite(n) && n > 0 && n <= MAX_SHARE ? n : DEFAULT_SHARE;
  } catch {
    return DEFAULT_SHARE;
  }
}

function readWeights(): Record<string, number> {
  try {
    const held = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? 'null') as unknown;
    if (typeof held !== 'object' || held === null) return { ...DEFAULT_WEIGHTS };
    const out: Record<string, number> = { ...DEFAULT_WEIGHTS };
    for (const [k, v] of Object.entries(held)) if (typeof v === 'number' && v > 0) out[k] = v;
    return out;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

function keep(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage refused: the size is this session's only */ }
}

@Component({
  selector: 'app-inspector',
  imports: [AskPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[style.width.%]': 'share() * 100' },
  templateUrl: './inspector.component.html',
  styleUrl: './inspector.component.scss',
})
export class InspectorComponent {
  protected readonly stage = inject(StageService);
  private readonly stacks = inject(BookStacksService);
  private readonly projects = inject(ProjectsService);
  private readonly ledger = inject(LedgerService);


  /**
   * Both sections start OPEN, which is what Owen asked for and what an inspector
   * is for: a panel whose sections you have to open before it says anything is a
   * panel that says nothing. They are still collapsible, because sixty chapters
   * and eleven categories do not both fit on a laptop.
   */
  protected readonly chaptersOpen = signal(true);
  /**
   * The proof sheet's two other sections, SHUT by default (Owen, 2026-10-30:
   * "minimize furniture and notes by default, i almost never need those").
   * A click on the header still opens either.
   */
  protected readonly notesOpen = signal(false);
  protected readonly furnitureOpen = signal(false);

  // ── The panel's size, the person's own ───────────────────────────────────

  /** How wide the panel is, as a share of the window's width. */
  protected readonly share = signal(readShare());
  /** Each section's share of the height, by name; an open section's height is proportional to it. */
  private readonly weights = signal<Record<string, number>>(readWeights());
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  protected grow(name: string): number {
    return this.weights()[name] ?? DEFAULT_WEIGHTS[name] ?? 1;
  }

  protected resetWidth(): void {
    this.share.set(DEFAULT_SHARE);
    keep(SHARE_KEY, DEFAULT_SHARE);
  }

  protected resetWeights(): void {
    this.weights.set({ ...DEFAULT_WEIGHTS });
    keep(WEIGHTS_KEY, DEFAULT_WEIGHTS);
  }

  /** Drag the left edge: the panel grows leftward, into the pages. */
  protected grabEdge(down: PointerEvent): void {
    down.preventDefault();
    const edge = down.currentTarget as HTMLElement;
    edge.setPointerCapture(down.pointerId);
    edge.classList.add('dragging');
    const host = edge.parentElement as HTMLElement;
    const from = host.getBoundingClientRect().width;
    const x0 = down.clientX;
    const move = (e: PointerEvent): void => {
      const whole = window.innerWidth;
      const px = Math.min(whole * MAX_SHARE, Math.max(MIN_WIDTH, from + (x0 - e.clientX)));
      this.share.set(Math.round((px / whole) * 1000) / 1000);
    };
    const up = (): void => {
      edge.removeEventListener('pointermove', move);
      edge.removeEventListener('pointerup', up);
      edge.removeEventListener('pointercancel', up);
      edge.classList.remove('dragging');
      keep(SHARE_KEY, this.share());
    };
    edge.addEventListener('pointermove', move);
    edge.addEventListener('pointerup', up);
    edge.addEventListener('pointercancel', up);
  }

  /**
   * Drag the line between two sections. The nearest OPEN section above the grip
   * and the nearest open one below it trade height; a shut section in between is
   * passed over, and with no open section on one side there is nothing to trade.
   * At the press every open section's weight becomes its height in pixels, so
   * the two being dragged move exactly with the pointer and the rest stand still.
   */
  protected grabGrip(down: PointerEvent): void {
    const panel = this.panel()?.nativeElement;
    if (panel === undefined) return;
    const grip = down.currentTarget as HTMLElement;
    const sections = [...panel.querySelectorAll<HTMLElement>('[data-section]')];
    const open = sections.filter((el) => !el.classList.contains('shut'));
    const above = [...open].reverse().find((el) => (grip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) !== 0);
    const below = open.find((el) => (grip.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    if (above === undefined || below === undefined) return;
    down.preventDefault();
    grip.setPointerCapture(down.pointerId);
    const heights: Record<string, number> = { ...this.weights() };
    for (const el of open) heights[el.dataset['section']!] = el.getBoundingClientRect().height;
    const a = above.dataset['section']!;
    const b = below.dataset['section']!;
    const pair = heights[a]! + heights[b]!;
    const a0 = heights[a]!;
    const y0 = down.clientY;
    const move = (e: PointerEvent): void => {
      const next = Math.min(pair - MIN_SECTION, Math.max(MIN_SECTION, a0 + (e.clientY - y0)));
      this.weights.set({ ...heights, [a]: next, [b]: pair - next });
    };
    const up = (): void => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      keep(WEIGHTS_KEY, this.weights());
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  /** Which chapter row is being renamed, and the text in its box. */
  protected readonly renamingHref = signal<string | null>(null);
  protected readonly renameText = signal('');

  private readonly renameBox = viewChild<ElementRef<HTMLInputElement>>('renameBox');

  // ── The proof sheet's panels: Chapters, Notes, Furniture review ──────────
  //
  // Three sections about one book, and none of them holds any of it. The book
  // pane registers itself with the service as a `BookStack`; what this half of
  // the component does is read that pane's own replay and push ops onto that
  // pane's own stack. Nothing here is persisted, nothing here goes over IPC, and
  // there is no second account of the document anywhere in it — which is the
  // whole of why the panels can live in the shell (RENDERER-DESIGN.md §5) while
  // the ops go on living in the pane that draws them.

  /** The book pane in front, or null for every other kind of document. */
  protected readonly sheet = computed<BookStack | null>(() => {
    const tab = this.stage.activeDocument();
    return tab === null || tab.kind !== 'book' ? null : this.stacks.bookStackFor(tab.id);
  });

  /** A finished export shown read-only: no stack to land an Ask run on. */
  protected readonly viewOnly = computed(() => this.stage.activeDocument()?.viewOnly === true);

  /**
   * The book as that pane is drawing it — the file with the chain and the
   * unapplied stack replayed over it, and null while it is still opening.
   *
   * THE PENDING VIEW AND NOT THE FILE. A panel drawing what is on disk would
   * disagree with the paper the moment somebody struck a note, and the person
   * would be looking at two answers to one question with no way to tell which
   * was stale.
   */
  private readonly sheetView = computed<Replayed | null>(() => this.sheet()?.view() ?? null);

  /**
   * Where the book divides, in reading order — the replay's answer.
   *
   * ALREADY FILTERED TO WHAT IS DRAWABLE (`Replayed.chapters`), so a division
   * above a block a merge consumed is not in this list and there is no dimmed
   * row here of the kind the scan's section keeps. The two are different facts:
   * a scan's chapter names a banked answer this RENDERING may not show, and is
   * kept because the name is still in the file; this list is the file, so a
   * division that is not in it is a division that is not.
   */
  protected readonly sheetChapters = computed<SheetChapterRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const where = new Map(replayed.rows.map((row) => [row.id, row.pages[0] ?? row.page] as const));
    return replayed.chapters.map((one) => ({
      id: one.id,
      title: one.title,
      page: where.get(one.id) ?? 0,
    }));
  });

  /**
   * The same list with the book's HEADINGS in it — divisions at the top level,
   * every Section-header indented under the division it falls in.
   *
   * TWO LEVELS BECAUSE A BOOK HAS TWO. A division is where the book breaks; a
   * heading is where a part of it is announced. The panel listed only the first
   * of those, so a chapter with six headed sections in it looked exactly like a
   * chapter with none, and the one thing an outline is FOR — seeing the shape of
   * what you are working on — was the one thing it would not show.
   *
   * ONE WALK OF THE ROWS, and the order falls out of it. `Replayed.chapters` is
   * already filtered to divisions whose anchor is an unshelved row (ops.ts,
   * \`drawableChapters\`), so every division is met in this walk exactly where the
   * flow puts it and the nesting needs no second sort and no parent pointers:
   * reading order IS the outline.
   *
   * A ROW THAT IS BOTH IS THE CHAPTER. Divisions are routinely set on the very
   * heading block that opens them — the seed does it by construction — and
   * listing that block twice would have the panel say the book divides here and
   * also merely announces something here, about one block, in two rows sharing
   * one id.
   *
   * WHAT A SECTION ENTRY IS NOT: shelved, and not struck. The shelf is not the
   * book (the Furniture section is where those live and it says why each one
   * left). And an outline is where the book divides and what it will read as, so
   * a struck heading — in the document, drawn cancelled, absent from the edition
   * — is on its way out and has no business shaping the list of what is staying.
   *
   * A HEADING ABOVE THE FIRST DIVISION STILL LISTS, indented, under nothing.
   * Front matter has headings and no parent, and inventing a parent for them
   * would be the panel making up a division the book does not have.
   */
  protected readonly sheetOutline = computed<OutlineEntry[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const divisions = new Map(replayed.chapters.map((one) => [one.id, one.title] as const));
    const out: OutlineEntry[] = [];
    for (const row of replayed.rows) {
      const page = row.pages[0] ?? row.page;
      const division = divisions.get(row.id);
      if (division !== undefined) {
        out.push({ kind: 'chapter', id: row.id, title: division, page });
        continue;
      }
      if (row.category !== 'Section-header') continue;
      if (row.shelf !== undefined || row.struck === true) continue;
      out.push({ kind: 'section', id: row.id, title: headingWords(row.text), page });
    }
    return out;
  });

  /** Every note in the book, in reading order, each knowing whether anything points at it. */
  protected readonly notes = computed<NoteRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const orphans = new Set(replayed.loose.notes);
    const out: NoteRow[] = [];
    for (const row of replayed.rows) {
      // The shelf is not the book, and a note is never on it.
      if (row.shelf !== undefined || row.category !== 'Footnote') continue;
      out.push({
        id: row.id,
        // The engine counts a note's place on its page from zero and the page
        // prints it from one, which is the pane's own arithmetic for the sienna
        // ordinal in the gutter.
        ordinal: (row.note ?? 0) + 1,
        words: opening(row.text),
        page: row.pages[0] ?? row.page,
        orphan: orphans.has(row.id),
      });
    }
    return out;
  });

  /**
   * The reference numbers in the body that no note carries.
   *
   * NOT ROWS. A loose marker is a run of characters inside a block — a block,
   * an offset and a length — so it is listed by the words it is printed in and
   * by the number the page shows, and its identity is the three coordinates
   * together. That key is what the linking state is held by, so a marker the
   * replay re-derives away while somebody is choosing simply stops being armed.
   */
  protected readonly looseMarkers = computed<LooseRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const held = new Map(replayed.rows.map((row) => [row.id, row] as const));
    const order = new Map(replayed.rows.map((row, at) => [row.id, at] as const));
    return [...replayed.loose.markers]
      .sort((one, other) =>
        (order.get(one.block) ?? 0) - (order.get(other.block) ?? 0) || one.at - other.at)
      .map((marker) => {
        const row = held.get(marker.block);
        return {
          key: `${marker.block}|${marker.at}|${marker.len}`,
          block: marker.block,
          at: marker.at,
          len: marker.len,
          printed: marker.printed,
          words: opening(row?.text ?? ''),
          page: row === undefined ? 0 : row.pages[0] ?? row.page,
        };
      });
  });

  /** Both directions of the one flag, counted for the badge. */
  protected readonly unlinked = computed<number>(() => {
    const replayed = this.sheetView();
    return replayed === null ? 0 : replayed.loose.markers.length + replayed.loose.notes.length;
  });

  /** Every row the reflow took out of the book, at its reading-order position. */
  protected readonly furniture = computed<ShelvedRow[]>(() => {
    const replayed = this.sheetView();
    if (replayed === null) return [];
    const out: ShelvedRow[] = [];
    for (const row of replayed.rows) {
      if (row.shelf === undefined) continue;
      out.push({
        id: row.id,
        label: pdfCategoryLabel(row.category),
        // Every shelved row carries one, by the file format's own rule; the
        // empty string is what a book written by something older would leave,
        // and an empty line is better than a sentence this panel invented.
        why: row.why ?? '',
        words: opening(row.text),
        page: row.pages[0] ?? row.page,
      });
    }
    return out;
  });

  /**
   * The loose marker whose note the next click chooses, by key.
   *
   * A KEY AND NOT THE ROW. The rows are recomputed on every push, and a held
   * object would go on naming a marker the replay has since bound or re-derived
   * away — which is a link op minted against coordinates that have moved.
   */
  protected readonly linking = signal<string | null>(null);

  /** That marker, if it is still loose. Null the moment it stops being. */
  protected readonly linkingRow = computed<LooseRow | null>(() => {
    const key = this.linking();
    return key === null ? null : this.looseMarkers().find((row) => row.key === key) ?? null;
  });

  /** Arm a number for linking, or put it down again. */
  protected startLink(row: LooseRow): void {
    this.linking.set(this.linking() === row.key ? null : row.key);
  }

  /**
   * A note row, clicked — which means one of two things and says which in the
   * hint before it is clicked.
   *
   * With a number armed it is the LINK: the number in the body stops being a
   * number nothing carries and the note stops being a note nothing points at,
   * both from one decision, which is what `link` is for. With nothing armed it
   * is the jump — the pane's own scroll-and-pulse, so that clicking a note in a
   * list of eighty puts it in front of the reader on the paper.
   */
  protected tapNote(row: NoteRow): void {
    const pane = this.sheet();
    if (pane === null) return;
    const picked = this.linkingRow();
    if (picked === null) {
      pane.reveal(row.id);
      return;
    }
    this.linking.set(null);
    pane.push([{ op: 'link', block: picked.block, at: picked.at, len: picked.len, note: row.id }]);
  }

  /** Put a shelved row back in the book, where it was printed. */
  protected restoreShelved(id: string): void {
    this.sheet()?.push([{ op: 'restore-furniture', id }]);
  }

  /**
   * The one block picked on the paper, when exactly one is and it is in the flow.
   *
   * A DIVISION SITS ABOVE A BLOCK, so a shelved row cannot carry one — the
   * replay would refuse it into `missing`, where nothing can clear it, and a
   * button that mints such an op is a button that files a complaint against the
   * person who pressed it.
   */
  private readonly divideAt = computed(() => {
    const pane = this.sheet();
    const replayed = this.sheetView();
    if (pane === null || replayed === null) return null;
    const picked = [...pane.selected()];
    if (picked.length !== 1) return null;
    const row = replayed.rows.find((one) => one.id === picked[0]);
    return row === undefined || row.shelf !== undefined ? null : row;
  });

  protected canDivide(): boolean {
    const row = this.divideAt();
    return row !== null && !this.sheetChapters().some((one) => one.id === row.id);
  }

  protected divideTitle(): string {
    const row = this.divideAt();
    if (row === null) return 'Pick one block on the page first';
    return this.sheetChapters().some((one) => one.id === row.id)
      ? 'A chapter already starts at that block'
      : 'The book divides at this block, and the contents lists it';
  }

  /**
   * "Chapter starts here", over the block picked on the paper.
   *
   * SEEDED WITH THE BLOCK'S OWN FIRST LINE, which is what the scan's version of
   * this button does and for its reason: it is right far more often than any
   * other guess, it is exactly what the detection would have called it, and it is
   * a starting point rather than a rule — the row is renameable the moment it
   * appears, because the contents entry and the printed heading are two
   * statements and a book is allowed to disagree with itself about them.
   */
  protected makeSheetChapter(): void {
    const pane = this.sheet();
    const row = this.divideAt();
    if (pane === null || row === null || !this.canDivide()) return;
    const words = row.text.split('\n')[0]?.trim() ?? '';
    pane.push([{ op: 'chapter', set: row.id, title: words.slice(0, 120) }]);
  }

  protected startSheetRename(row: SheetChapterRow): void {
    this.renameText.set(row.title);
    this.renamingHref.set(row.id);
  }

  /** Escape, and blur. The box closes and the name is left as it was. */
  protected cancelRename(): void {
    this.renamingHref.set(null);
  }

  /**
   * Enter in the rename box. An empty or unchanged name is a cancel, which is
   * the box's own rule everywhere else in this panel — and here it also keeps
   * the paper's promise that a chapter chip always has something on it to
   * double-click.
   */
  protected commitSheetRename(id: string): void {
    const pane = this.sheet();
    const label = this.renameText().trim();
    const row = this.sheetChapters().find((one) => one.id === id);
    this.renamingHref.set(null);
    if (pane === null || label.length === 0 || label === row?.title) return;
    pane.push([{ op: 'chapter', rename: id, title: label }]);
  }

  /** The block stays; the rule goes. */
  protected dropSheetChapter(id: string): void {
    this.sheet()?.push([{ op: 'chapter', remove: id }]);
  }

  /** A chapter row's right-click menu: which division, and what it holds. */
  protected readonly chapterMenu = signal<{
    x: number;
    y: number;
    id: string;
    title: string;
    /** Every unstruck block in the chapter, its opening block first (`chapterSpan`). */
    ids: string[];
  } | null>(null);

  protected chapterRowMenu(event: MouseEvent, row: SheetChapterRow): void {
    const pane = this.sheet();
    const replayed = pane === null ? null : pane.view();
    if (replayed === null) return;
    event.preventDefault();
    const opens = new Set(replayed.chapters.map((chapter) => chapter.id));
    this.chapterMenu.set({
      x: event.clientX, y: event.clientY, id: row.id, title: row.title,
      ids: chapterSpan(replayed.rows, opens, row.id),
    });
  }

  /**
   * REMOVE ALL: the division and every block under it, as ONE gesture.
   *
   * The marker goes first, then each block is struck — the same strike Delete
   * pushes, so the blocks are cancelled rather than destroyed and one Ctrl+Z
   * brings the chapter back, title and all. The order matters: the division is
   * removed while its opening block still flows, which is the only place the
   * replay takes a `chapter` op from.
   */
  protected removeChapterAll(): void {
    const open = this.chapterMenu();
    this.chapterMenu.set(null);
    const pane = this.sheet();
    if (open === null || pane === null) return;
    const blocks = open.ids.length === 1 ? '1 block' : `${open.ids.length} blocks`;
    pane.pushGroup(`removing the chapter "${open.title}" and its ${blocks}`, [
      { op: 'chapter', remove: open.id },
      ...open.ids.map((id): BookOp => ({ op: 'strike', id })),
    ]);
  }

  /** The same ✕ the row carries, offered beside Remove all. */
  protected removeChapterMarker(): void {
    const open = this.chapterMenu();
    this.chapterMenu.set(null);
    if (open !== null) this.dropSheetChapter(open.id);
  }

  /**
   * The way back — one op, so Ctrl+Z brings the person's own list back.
   *
   * Only offered while the ops own the list, because a reset over a seed already
   * in force is a change that changes nothing and would still be a row in
   * somebody's history.
   */
  protected resetSheetChapters(): void {
    const pane = this.sheet();
    if (pane === null || !pane.chaptersOwned()) return;
    pane.push([{ op: 'chapter', reset: true }]);
  }

  // ── Standing on ──────────────────────────────────────────────────────────

  /**
   * The project the focused document belongs to, or null for a file opened from
   * somewhere this app has never imported.
   *
   * THE STRIP IS ABOUT THE BOOK AND NOT ABOUT THE TAB, which is why this is a
   * separate question from `subject()`. A book's position is the same position
   * whether you are looking at the scan, at the flowing book cast from it or at
   * one of its translations — they are all one project — and a strip that came
   * and went with the mode a pane happens to be in would be a position that
   * belongs to a viewer rather than to a book.
   */
  protected readonly projectDir = computed<string | null>(() => {
    const tab = this.stage.activeDocument();
    if (tab === null) return null;
    /*
     * THE LIGHT TABLE CARRIES NO INSPECTOR — Owen (2026-08-22): \`"the
     * righthand nav bar that says 'Standing on The pages you minted' doesnt
     * need to be there unless the inspectors are there in the first place.
     * they arent necessary when we're sorting pages and organizing/cropping.
     * thats only for the working files."\` The inspector's whole subject is
     * the LEDGER — where you stand, what was made from where — and on the
     * capture surface the recipe is the truth and the rail is its inspector.
     * Answering null here removes the panel whole (the outer @if), which is
     * this component's own idiom for "nothing to inspect".
     */
    if (tab.kind === 'capture') return null;
    const project = this.projects.projectFor(tab.path);
    // A catalogue that will not parse has no history to draw and its refusal is
    // already on its row on Home. `ProjectsService` treats it as no project at
    // all for exactly this reason, and so does this.
    return project === null || project.problem !== null ? null : project.dir;
  });

  /** Main's sentence for a ledger it would not read, drawn under the strip. */
  protected readonly stepsProblem = computed<string | null>(() =>
    this.ledger.problemFor(this.projectDir()));

  /**
   * WHERE THIS BOOK IS STANDING, in one line.
   *
   * ── Why it says two things about a reading and one about everything else ────
   *
   * The library calls a read step "the Book", because in a tree of provenance
   * that is what the node IS — the flowing document you read, curate and
   * translate — and *"we shouldnt call the working files 'epub' until we
   * export"*. The step's own label says something else and something useful:
   * "Read (317 pages)", which is what was actually done and how much of it. A
   * strip that said only "Book" would leave somebody standing on one of two
   * readings with no way to tell which; one that said only "Read (317 pages)"
   * would name a row the panel beside it calls something different. So it says
   * both, in that order — the thing, then what was done to make it.
   *
   * THREE STATES THAT LOOK ALIKE AND ARE NOT: a ledger that refused to parse
   * (the sentence below the strip says which), a history still in flight, and a
   * book with a position. Saying "nowhere" while the answer is on its way would
   * be the panel asserting something it has not been told.
   */
  protected readonly standingName = computed<string>(() => {
    const dir = this.projectDir();
    if (dir === null) return '';
    if (this.ledger.problemFor(dir) !== null) return 'Nowhere';
    const step = this.ledger.standingIn(dir);
    if (step === null) return this.stepsRead() ? 'Nowhere' : 'Reading this book’s history…';
    return step.action === 'read' ? `Book · ${step.label}` : step.label;
  });

  /**
   * The strip on hover — the full timestamp, and where the rest of the story is.
   *
   * IT POINTS AT THE LIBRARY, because that is the panel that moves this. The
   * strip is a readout and deliberately not a control: one selector
   * (docs/WORKBENCH.md §6c), and it is on the left.
   */
  protected standingTitle(): string {
    const dir = this.projectDir();
    const step = dir === null ? null : this.ledger.standingIn(dir);
    if (step === null) return 'Where this book stands. Click a step in the library to move it.';
    return `${step.label} — ${new Date(step.createdAt).toLocaleString()}. This is what the panes `
      + 'show and what the next thing you do is made from. Click a step in the library to move it.';
  }

  /**
   * Whether this window has read this project's history at all.
   *
   * The strip above draws from it, and null there means "not read yet" rather
   * than "nowhere" — a panel that said a book was standing nowhere because an
   * IPC had not answered would be reporting its own latency as a fact about
   * somebody's project.
   */
  protected readonly stepsRead = computed(() =>
    this.ledger.historyFor(this.projectDir()) !== null);
}

interface SheetChapterRow {
  /** The block the division sits above — the id every chapter op is keyed to. */
  id: string;
  title: string;
  /** The source page it opens on, drawn with the ≈ the book's own ghosts wear. */
  page: number;
}

/**
 * One row of the two-level outline: a division, or a heading inside one.
 *
 * IT EXTENDS THE CHAPTER ROW rather than being a union of two shapes, because
 * the two rows carry the same three facts and differ only in what may be DONE to
 * them — which the template asks about by name, once, where it draws the
 * buttons. A union would buy a narrowing the template does not need and would
 * cost this file a second declaration of id, title and page.
 */
interface OutlineEntry extends SheetChapterRow {
  kind: 'chapter' | 'section';
}

/**
 * A heading's words, for a row in the outline.
 *
 * THE EMPHASIS MARKS COME OFF. A heading's text arrives in the model's spelling
 * and \`*Interlude*\` is the source saying "set this in italics", not a book
 * called *Interlude* with the asterisks printed. Elsewhere in this panel the
 * markup rides along (\`opening\`, which lists what the book SAYS); an outline
 * entry is a NAME, held next to chapter titles that carry none, and a column of
 * names where half wear punctuation the printer never set reads as a fault in
 * the book.
 */
function headingWords(text: string): string {
  return text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

/** One drawn row of the Notes section — a note at the foot of a page. */
interface NoteRow {
  id: string;
  /** Which note of its page this is, counted from one. */
  ordinal: number;
  words: string;
  page: number;
  /** True when nothing in the body points at it — one of the two linking flags. */
  orphan: boolean;
}

/** One drawn row of the numbers in the body that no note carries. */
interface LooseRow {
  /** Block, offset and length together — the only identity a marker has. */
  key: string;
  block: string;
  at: number;
  len: number;
  /** The number the page printed, which is what a person matches a note by. */
  printed: number;
  /** The opening of the block it is printed in, so the row can be found. */
  words: string;
  page: number;
}

/** One drawn row of the Furniture review — a row the reflow took out of the book. */
interface ShelvedRow {
  id: string;
  /** What kind of block the model said it was. */
  label: string;
  /** The reflow's own sentence of evidence for taking it out. */
  why: string;
  words: string;
  page: number;
}

/**
 * The opening of a block's words, for a row in a 260px column.
 *
 * WHITESPACE COLLAPSED AND CUT ON A CHARACTER COUNT, not on a word boundary: a
 * row is one line with an ellipsis at the end of it either way, and hunting for
 * the last space before the limit would make the cut depend on how long the
 * words happen to be. The source string's own markup rides along, because the
 * panel is a list of what the book SAYS and the book says it in the model's
 * spelling.
 */
function opening(text: string, many = 64): string {
  const said = text.replace(/\s+/g, ' ').trim();
  return said.length <= many ? said : `${said.slice(0, many).trimEnd()}…`;
}

/** One drawn row of the Category section. */
interface CategoryRow {
  id: string;
  label: string;
  colour: string;
  note: string;
  /** How many of them this chapter holds, or null while nobody has counted. */
  total: number | null;
  /** How many of those are already marked to be cut. */
  struck: number;
}
