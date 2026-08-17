import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';

import { typeLabel } from '@shared/documents';
import type { ProjectSummary } from '@shared/types';

import { api, hosted } from '../../core/foundry';
import { ProjectsService } from '../../core/projects.service';
import { TabsService } from '../../core/tabs.service';
import { UiService } from '../../core/ui.service';

/**
 * Home — what the app is when nothing is open.
 *
 * Three things, in the order a person needs them: the books they have worked on,
 * a target big enough to drop a book on without aiming, and the two actions
 * worth a button. The drop target is decorative in the strict sense — the WHOLE
 * WINDOW accepts a drop (see App) — but a rectangle that says "drop here" is how
 * anybody knows that.
 *
 * ── The list is PROJECTS, not files ──────────────────────────────────────────
 *
 * A row is a BOOK — one folder holding the scan, the cast EPUB, a translation,
 * the real-text PDF — and the tags on it are the answer to "what has been made
 * from this?", which a flat list of filenames could not give.
 *
 * CLICKING A ROW OPENS THE BOOK, and it used to open a drop-down instead. The
 * expansion was a list of every document in the project and a second click to
 * choose from it — which is the right question asked at the wrong moment: nine
 * times out of ten the answer is "the scan", the user knew that before they
 * clicked, and the menu was a step between them and the thing they came for.
 * `originalOf` picks it (ProjectsService) and the row opens it directly.
 *
 * THE OTHER DOCUMENTS ARE NOT GONE, THEY MOVED. They are in the open-documents
 * nav now, grouped under the project, where flipping between a scan and the book
 * cast from it is one click and stays available while you read — which is when
 * that question is actually asked. It was never a question for a screen you are
 * about to leave.
 *
 * A row leaves this list ONE WAY, and it takes the book with it. There is no
 * Clear and no "forget this", deliberately: the old recents list was a cache of
 * names and dropping one cost nothing, but this one is the library itself, and a
 * button that made a book vanish from the only screen that lists it while
 * leaving the folder on disk would be a delete button wearing a nicer word.
 *
 * So the button beside Reveal is the honest version of that: it DELETES — the
 * project directory and everything in it, off the disk, for real. The question
 * is asked in the app's OWN confirmation now (ConfirmService) rather than in a
 * native message box, but every word in it is still main's: the size on disk,
 * the readings bank, the filed copy (`projects:describe` in electron/ipc.ts).
 * This side's job is to refuse early when a document from the project is open,
 * to ask, and to say what happened.
 *
 * IT IS THE SAME CARD THE SIDE NAV USES to delete one document. There is exactly
 * one confirmation in this app, and it looks the same wherever the thing being
 * ended is — which is what stops a second, softer one being invented later.
 *
 * IT IS ALSO WHAT AN EMPTY COLUMN SHOWS. Ctrl+\ makes a column with nothing in
 * it, and the useful thing to put in a column with nothing in it is the library
 * — so opening a book from this list lands in the column you are looking at.
 * When it is drawn as a column rather than as the whole window it carries a ✕,
 * because a column you asked for and changed your mind about has to be a column
 * you can put away; the ✕ closes the COLUMN and never a document.
 */
@Component({
  selector: 'app-home',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (closable()) {
      <button class="close-column" title="Close this column" (click)="closeColumn()">✕</button>
    }

    <div class="home">
      <div class="hero">
        <div class="mark">⬙</div>
        <h1>Foundry</h1>
        <p>Recast a poorly scanned PDF into a clean EPUB.</p>

        <div class="target">
          <span>Drop a PDF anywhere in this window</span>
        </div>

        <div class="actions">
          <button class="primary" (click)="tabs.openViaDialog()">Open a document…</button>
          <button class="ghost" (click)="ui.openOcr()">OCR…</button>
          <button class="ghost" (click)="settings()">Settings</button>
        </div>
      </div>

      <!-- Hosted, the list below IS the host's own book list said again from the
           other side — the two-answers problem §8 names — so the hero keeps its
           drop target and Open button (the Import-via-Foundry door needs both)
           and the library keeps its one home, over there. -->
      @if (!hosted()) {
      <section class="recents">
        <header>
          <h2>Your books</h2>
        </header>

        @if (projects.items().length === 0) {
          <p class="none">Nothing yet. A book you open or convert becomes a project here.</p>
        } @else {
          <ul>
            @for (project of projects.items(); track project.key) {
              <li>
                <button
                  class="row"
                  [title]="rowTitle(project)"
                  [disabled]="project.problem === null && projects.originalOf(project) === null"
                  (click)="openProject(project)"
                >
                  <span class="kind">{{ glyph(project) }}</span>
                  <span class="name">{{ project.title }}</span>
                  @if (project.problem !== null) {
                    <span class="tag gone" [title]="project.problem">catalogue unreadable</span>
                  } @else {
                    @for (made of tags(project); track made) {
                      <span class="tag">{{ made }}</span>
                    }
                    @if (project.filed) {
                      <span class="tag" title="A copy has been filed in this project's own folder">filed</span>
                    }
                    <!--
                      A project whose catalogue parses and whose files are all
                      gone. It used to be discoverable only by expanding the row
                      into a list of "not there any more" — now the row itself
                      has to carry it, because there is nothing left to expand
                      and a click that did nothing would be indistinguishable
                      from a dead app.
                    -->
                    @if (projects.originalOf(project) === null) {
                      <span class="tag gone" title="Every document this project listed is missing from the disk">nothing to open</span>
                    }
                  }
                  <span class="when">{{ project.openedAt > 0 ? when(project.openedAt) : '' }}</span>
                </button>
                <!--
                  THE STEP THIS BOOK IS WAITING ON, and the only one there ever
                  is. A scan whose pages have never been read cannot be turned
                  into anything — every rendering, the block editor and the
                  chapter detection are all built on the bank — so the row says
                  so and the button IS the step rather than a badge beside it.

                  It is on the row rather than only in the dock because this is
                  the screen where somebody surveys a library: five books, two of
                  them unread, is a fact you should be able to see without
                  opening each one.

                  It goes when the reading lands and nothing brings it back
                  short of the bank going away.
                -->
                @if (project.reading.needed && projects.originalOf(project) !== null) {
                  <button
                    class="ocr"
                    (click)="void readPages(project)"
                    title="These pages have not been read yet — this is the step everything else needs"
                  >OCR</button>
                }
                <button class="x" (click)="reveal(project)" title="Show this project's folder">⌕</button>
                <button
                  class="x danger"
                  (click)="remove(project)"
                  [title]="'Delete this project — ' + project.dir + ' and everything in it'"
                >⌦</button>
              </li>

              <!--
                A CATALOGUE THAT WILL NOT PARSE STILL SAYS SO IN FULL. This is
                the one row that keeps a second line: the reason is a sentence,
                it is the only thing this screen can offer about that project,
                and it has nowhere else to go now that rows do not expand.
              -->
              @if (project.problem !== null) {
                <li class="detail">
                  <p class="none">{{ project.problem }}</p>
                </li>
              }
            }
          </ul>
        }
      </section>
      }
    </div>
  `,
  styles: [`
    :host { position: relative; display: block; height: 100%; overflow-y: auto; background: var(--bg-base); }

    /* Sticky rather than absolute: this host scrolls, and a corner button that
       scrolled away with the hero would be missing exactly when a long recents
       list made the column feel permanent. */
    .close-column {
      position: sticky;
      top: 8px;
      float: right;
      margin-right: 8px;
      z-index: 1;
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
      padding: 4px 6px; border-radius: var(--radius-sm);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .close-column:hover { background: var(--bg-hover); color: var(--text-primary); }

    .home {
      max-width: 720px;
      margin: 0 auto;
      padding: 48px 24px 64px;
      display: flex;
      flex-direction: column;
      gap: 40px;
    }

    .hero { text-align: center; }
    .mark { font-size: 40px; color: var(--accent); line-height: 1; }
    .hero h1 { margin: 10px 0 4px; font-size: 24px; font-weight: 700; }
    .hero p { margin: 0 0 24px; font-size: 13px; color: var(--text-tertiary); }

    .target {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 160px;
      border: 2px dashed var(--border-default);
      border-radius: var(--radius);
      color: var(--text-tertiary);
      font-size: 13px;
      background: var(--bg-sunken);
      transition: border-color 150ms ease, color 150ms ease;
    }
    .target:hover { border-color: var(--accent); color: var(--text-secondary); }

    .actions { display: flex; gap: 8px; justify-content: center; margin-top: 20px; }

    .recents header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
    .recents h2 {
      flex: 1;
      margin: 0;
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary); font-weight: 600;
    }
    .none { margin: 0; font-size: 13px; color: var(--text-tertiary); }

    ul { list-style: none; margin: 0; padding: 0; }
    li { display: flex; align-items: center; border-bottom: 1px solid var(--border-subtle); }
    li:last-child { border-bottom: none; }

    /* A document inside a project: indented, hairlined off, and quieter than
       the book it belongs to — the row above is the thing being chosen between,
       and these are what that choice contains. */
    li.detail { border-bottom: none; padding-left: 22px; }
    li.detail .row { padding-top: 6px; padding-bottom: 6px; font-size: 12px; }
    li.detail .none { padding: 6px 8px; font-size: 12px; }

    .row {
      flex: 1; min-width: 0;
      display: flex; align-items: center; gap: 10px;
      padding: 10px 8px;
      background: transparent; border: none; border-radius: var(--radius-md);
      color: var(--text-secondary);
      font-size: 13px; text-align: left; cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .row:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-hover); }
    .row:disabled { cursor: default; opacity: 0.55; }

    .kind { flex: 0 0 auto; opacity: 0.6; font-size: 12px; }
    .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .when { flex: 0 0 auto; font-size: 11px; color: var(--text-tertiary); }

    .tag {
      flex: 0 0 auto;
      font-size: 10px; font-weight: 600; letter-spacing: 0.03em;
      padding: 2px 8px; border-radius: 999px;
      background: var(--accent-soft); color: var(--accent);
    }
    .tag.gone { background: var(--error-soft); color: var(--error); }

    /*
      THE WAITING STEP, in the accent — this app's one word for attention, used
      here for "do this next" rather than for "this is on".

      It is a filled pill and not an outline, unlike the dock's version of the
      same idea, because the contexts are opposite: on the dock it sits among
      other items that are sometimes active and has to be told apart from them,
      and here it is the only coloured thing on a row of grey text. Both are the
      same accent, which is what makes them read as one idea.

      It does not pulse. A library of twenty books with three unread would be
      three animations running forever on a screen somebody is reading.
    */
    .ocr {
      flex: 0 0 auto;
      margin-right: 2px;
      padding: 3px 10px;
      border: none; border-radius: 999px;
      background: var(--accent); color: var(--text-inverse);
      font-size: 10px; font-weight: 600; letter-spacing: 0.04em;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .ocr:hover { background: var(--accent-hover); }
    .ocr:active { background: var(--accent-active); transform: scale(0.96); }

    /* Primary / secondary / ghost, one shape apart: 32px tall, 6px radius, the
       label at 13px/500. */
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover { background: var(--accent-hover); }
    .primary:active { background: var(--accent-active); transform: scale(0.98); }
    .ghost {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:active { background: var(--bg-active); transform: scale(0.98); }

    .link {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
    }
    .link:hover { color: var(--accent); }
    .x {
      background: transparent; border: none; cursor: pointer;
      color: var(--text-tertiary); font-size: 11px;
      padding: 6px; border-radius: var(--radius-sm);
    }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }
    /* The one control in this app that destroys something wears the error
       colour on hover — the same red the "not there any more" tag uses. Quiet
       until the pointer is on it: it sits beside Reveal on every row, and a
       permanently red button on a list of books reads as a warning about the
       books rather than as an action. */
    .x.danger:hover { background: var(--error-soft); color: var(--error); }
  `],
})
export class HomeComponent {
  protected readonly hosted = hosted;

  /**
   * The column this is filling, when it is filling one.
   *
   * Null — the default — is Home as the WHOLE WINDOW, which is what the app is
   * with nothing open. The input exists only so the ✕ knows what it would be
   * closing; everything else on this screen is the same either way.
   */
  readonly pane = input<string | null>(null);

  protected readonly projects = inject(ProjectsService);
  protected readonly tabs = inject(TabsService);
  protected readonly ui = inject(UiService);
  private readonly router = inject(Router);

  /**
   * Only with a neighbour to go back to. Closing the only column would leave
   * zero columns, which draws this same screen across the same window — a
   * button whose whole effect is invisible is a button that teaches people the
   * app does not respond.
   */
  protected readonly closable = computed(() =>
    this.pane() !== null && this.tabs.panes().length > 1);

  protected closeColumn(): void {
    const id = this.pane();
    if (id !== null) this.tabs.closePane(id);
  }

  constructor() {
    // Re-read every time Home is constructed, which is every time it comes back
    // on screen. There is no push channel for the project list and there should
    // not be: the things that change it are conversions, which the queue already
    // broadcasts, and this is the only screen that reads it.
    void this.projects.refresh();
  }

  /**
   * What has been made from this book, as short tags on its row.
   *
   * WHAT IT IS, never where it lives: `cast`, `real text`, `translation`. The
   * folders those documents actually sit in are this app's bookkeeping and the
   * user never has to learn them. The catalogue still spells the real-text PDF's
   * role `searchable`, because that token is written into every project on every
   * disk and renaming it would orphan those rows — so the tag is translated here,
   * where a person reads it, rather than there, where a file remembers it.
   * Deduplicated, because a book with three
   * translations says "translation" once and expands to name them — the row
   * answers "has this been cast yet?" at a glance, and three language tags in a
   * row answers something else.
   *
   * An imported document contributes no tag: "you gave me this book" is not an
   * answer to what has been made from it.
   */
  protected tags(project: ProjectSummary): string[] {
    const tags: string[] = [];
    for (const document of project.documents) {
      /*
       * THE FILE TYPES THIS BOOK HAS, which is what a row is now. The book's own
       * type is not a tag — "you gave me a PDF" is not an answer to what has
       * been made from it — so the row that IS the import contributes nothing,
       * and everything beside it is something this app produced.
       */
      if (document.origin) continue;
      tags.push(typeLabel(document.kind));
    }
    return tags;
  }

  /**
   * Open the book this project is about — one click, no menu.
   *
   * `managed` decides whether the tab wears the unsaved dot, and the answer
   * differs inside one project: a cast book exists only because Foundry made it,
   * so nothing the user chose holds a copy — but an IMPORTED document is their
   * own, sitting in a folder of their own, and a dot on it would be a warning
   * about a loss that cannot happen. It rides on the document (`ProjectDocument`)
   * rather than being worked out here, because main is what knows where a file
   * came from.
   *
   * A project with nothing openable left is refused by the disabled row above,
   * and a catalogue that will not parse never gets here — `originalOf` returns
   * null for both, and the row says which it is.
   */
  protected openProject(project: ProjectSummary): void {
    const original = this.projects.originalOf(project);
    if (original === null) return;
    /*
     * THE PROJECT DOOR AND NOT THE FILE DOOR: the row is a book, and opening a
     * book means landing where its position stands — the proof sheet, for any
     * project with edits or a reading — with the original adopted underneath it
     * exactly as before. `TabsService.openProject` owns the reasoning.
     */
    void this.tabs.openProject(project.dir, original.path, original.managed);
  }

  /**
   * The glyph is the ORIGINAL'S kind, which is a fact about the book rather
   * than about the row's state — a project of a scan shows a page, a project
   * started from an EPUB shows a book. It replaced the expander's chevron, and
   * it earns its place for the same reason the chevron did not: a triangle said
   * "there is more of this row", which is no longer true, and this says what
   * pressing the row will open.
   */
  protected glyph(project: ProjectSummary): string {
    if (project.problem !== null) return '⚠';
    const original = this.projects.originalOf(project);
    if (original === null) return '⌸';
    return original.kind === 'epub' ? '▤' : '▦';
  }

  /** What the row says on hover: the file it opens, over the folder it is in. */
  protected rowTitle(project: ProjectSummary): string {
    if (project.problem !== null) return project.problem;
    const original = this.projects.originalOf(project);
    if (original === null) return `${project.dir}\nNothing in this project is still on the disk.`;
    return `Open ${original.label}\n${project.dir}`;
  }

  /**
   * "Read this book's pages" — the row's own next step.
   *
   * IT OPENS THE BOOK FIRST, and that is not a detour. The OCR dialog converts
   * the document in front of you: it lists the open PDFs and defaults to the
   * focused one, because reading pages is something you do to a book you are
   * looking at. Opening the dialog over a library screen with nothing open would
   * put "Open a PDF first" in front of somebody who had just pointed at a
   * specific book — so the row opens it, and the dialog then finds it there.
   */
  protected async readPages(project: ProjectSummary): Promise<void> {
    const original = this.projects.originalOf(project);
    if (original === null) return;
    /*
     * AWAITED, and the await is the whole of the fix. Opening a document is a
     * full round trip through main — it admits the path, records the recent and
     * pushes `document:opened` back — and firing the dialog beside it meant the
     * card painted before the tab existed. So a person who pressed OCR on a
     * specific book got "Open a PDF first" over the book they had just pointed
     * at, and the only way out was to close the dialog and press it again.
     */
    await this.tabs.openFile(original.path, original.managed);
    this.ui.openOcr();
  }

  /** The folder itself, in Explorer/Finder. The one way out of this app. */
  protected reveal(project: ProjectSummary): void {
    void api?.reveal(project.dir);
  }

  /**
   * Delete the project — the folder and everything in it, off the disk.
   *
   * THE TAB CHECK IS HERE AND ALSO IN MAIN, and the two are not redundant. This
   * one is the one that can say a sentence worth reading: this side holds the
   * tabs, so it knows the document's TITLE — the words on the tab the user is
   * looking at — and can name it and say that closing it makes this possible.
   * Main's is the one that is an authorization: it asks its own record of what
   * is unpacked, because a renderer's word about its own state is not a fact
   * main may act on when the action is a recursive delete. Deleting a working
   * tree out from under an open book leaves the viewer serving files that are
   * gone, and on Windows the delete stops on the first locked file and leaves
   * half a project.
   *
   * EVERY TAB, not just the focused one, and matched on the PATH rather than on
   * anything the row supplies: an editor tab points at its book's path too, and
   * a book can be open in more than one column.
   *
   * A cancel is silence. Anything else — the sentence main returns when the
   * folder is gone, or a refusal from either side — goes to the notice strip,
   * which is where this app says what it just did.
   */
  protected async remove(project: ProjectSummary): Promise<void> {
    const open = this.tabs.tabs().find((tab) => within(project.dir, tab.path));
    if (open !== undefined) {
      this.tabs.notice.set(
        `“${open.title}” is open from this project, so it cannot be deleted while you are `
        + 'reading it — the delete would leave this tab showing files that no longer exist. '
        + 'Close it, then try again.',
      );
      return;
    }
    try {
      const said = await this.projects.remove(project);
      if (said !== null) this.tabs.notice.set(said);
    } catch (err) {
      this.tabs.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected settings(): void {
    void this.router.navigateByUrl('/settings');
  }

  /** Coarse on purpose — the exact minute a book was opened is nobody's question. */
  protected when(at: number): string {
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    return new Date(at).toLocaleDateString();
  }
}

/**
 * Is `filePath` inside `dir`? Folded, because on Windows one file arrives
 * spelled three ways — the same reason recents compares paths this way.
 *
 * The separator is appended to the folder before the prefix test, so a project
 * called `Kershaw-a1b2c3d4` does not claim the tabs of `Kershaw-a1b2c3d4-notes`
 * sitting beside it and block a delete that has nothing to do with it. This is
 * a check that produces a MESSAGE, not one that grants anything: main proves for
 * itself what may be erased.
 */
function within(dir: string, filePath: string): boolean {
  const fold = (target: string): string => target.replace(/\\/g, '/').toLowerCase();
  const root = fold(dir).replace(/\/+$/, '');
  return fold(filePath).startsWith(`${root}/`);
}
