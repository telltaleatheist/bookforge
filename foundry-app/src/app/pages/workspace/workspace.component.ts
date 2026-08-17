import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { HomeComponent } from '../../components/home/home.component';
import { NoticeBarComponent } from '../../components/notice-bar/notice-bar.component';
import { DOCUMENT_MIME } from '../../components/open-documents/open-documents.component';
import { ViewerComponent } from '../../components/viewer/viewer.component';
import { ProjectsService } from '../../core/projects.service';
import { TabsService, type Pane, type Tab } from '../../core/tabs.service';

/**
 * The documents: one to five columns, one document in each.
 *
 * ONE PANE WITH ONE TAB IS THE OLD APP, EXACTLY. No divider is drawn, the strip
 * holds a single name, the viewer spans the window, and nothing on screen
 * mentions that a second column is possible — the split is a thing you go and
 * do, not a thing the app keeps offering. Everything below that is only reached
 * once there are two of something.
 *
 * ── The strips ───────────────────────────────────────────────────────────────
 *
 * EACH COLUMN CARRIES A CHROME-STYLE STRIP ALONG ITS TOP, and this REVERSES
 * their removal — see the reversal written out in `TabsService`'s header. The
 * strip is not a navigator (the documents list is, and it stays): it is the
 * thing three gestures need something to point AT.
 *
 *   ✕ closes that document.
 *   RIGHT-CLICK pins it, which exempts it from being replaced by the next thing
 *   clicked in the documents list and takes its ✕ away.
 *   DRAGGING it moves it — within this strip to reorder, into another strip to
 *   move it there, onto a pane's EDGE BAND to tear it into a column of its own.
 *   *"if they grab the tab and drag it to one of the sides, it enters split
 *   screen with the tab that was currently active when they dragged it."*
 *
 * A tab drag carries the SAME payload a documents-list row does, on purpose: the
 * drop side of the gesture — the middle of a pane, an edge band, the geometry
 * that tells them apart — is one piece of code that does not care which list the
 * thing came out of.
 *
 * A pane showing no document — which includes having no panes at all — is HOME.
 * Home is not a route and not a document: it is what a column is when nothing in
 * it is on top, which means closing the last document lands somewhere useful
 * instead of on a grey rectangle, and Ctrl+\ can make an empty column to drop
 * something into.
 *
 * FOCUS IS A POINTERDOWN ON THE PANE, which is the whole model. Pointerdown and
 * not click, for two reasons: it lands before the `click` of the same gesture,
 * so a button that acts on "the focused pane" already has this one by the time
 * it runs; and a drag that begins in a pane also means that pane, where a click
 * that never completes would have said nothing.
 *
 * ── AND FOCUSING A DOCUMENT MOVES THE POSITION ONTO IT ───────────────────────
 *
 * There is ONE selection (docs/WORKBENCH.md §6c). Clicking a row in the library
 * moves the position and puts its document on screen; the two gestures in this
 * file that put a document in front of somebody — a click on a tab, a pointerdown
 * in a pane — move the position back, through `TabsService.standForTab`, so that
 * the pointer and the pane can never describe two different things. Without it a
 * person reads the book, presses Translate and translates the scan.
 *
 * THE CALL IS HERE AND NOT IN `activateInPane`, deliberately. That method is also
 * how the position's OWN answer lands in a strip: a library click moves the
 * pointer, the pane obeys by activating a tab, and a mirror inside it would answer
 * main's answer with a question about it. The gesture is what mirrors, so the
 * gesture is where the call lives. The mirror is fire-and-forget and its guard is
 * in the service — standing on an older step and clicking into its document must
 * not walk anybody forward to the newest one.
 *
 * ── Taking a dropped row ─────────────────────────────────────────────────────
 *
 * A row dragged out of the list — or a tab dragged out of a strip — lands here,
 * and where in a pane it lands decides what happens: the MIDDLE shows it in that
 * column, an EDGE BAND opens a new column on that side. The preview says which
 * before the mouse comes up, because a drag with no preview is a guess.
 *
 * THE SHIELD IS NOT OPTIONAL. A rendered chapter is an <iframe> with its own
 * browsing context, and a drag over one delivers dragover/drop to the frame — so
 * without a transparent layer over each pane, a book could not be dropped onto
 * the page it is meant to replace, which is the middle of the target. The shield
 * exists only while a row is actually being dragged (TabsService.draggingDocument)
 * so nothing else in the app ever has a sheet of glass over it, and the preview
 * rectangle inside it is `pointer-events: none` — a preview that took the pointer
 * would take the dragover events the preview is computed from.
 *
 * THE STRIP SITS ABOVE THE SHIELD (z-index 31 against 30) and it has to: the
 * shield covers the whole pane, and a strip underneath it could not be dropped
 * on — which is the one drop target a tab drag most obviously means.
 */
@Component({
  selector: 'app-workspace',
  imports: [HomeComponent, NoticeBarComponent, ViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!--
      Above the columns, and outside the @if: the things it says are about the
      window rather than about any one pane, and the state where it matters most
      (a bad file dropped on an app with nothing open) is the state with no
      panes to hang it under.
    -->
    <app-notice-bar />

    @if (tabs.panes(); as panes) {
      @if (panes.length === 0) {
        <!--
          NO TABS IS NOT NO PROJECT. Closing the last document keeps the window
          in the book it was working on (TabsService.heldProject): the tree
          stays up on the left, and this quiet bench says the way back is one
          click away. Home is where you go on purpose, by the button.
        -->
        @if (heldTitle(); as title) {
          <div class="held">
            <p class="held-title">{{ title }}</p>
            <p class="held-hint">Nothing is open. Click a step in the tree to open it here.</p>
            <button type="button" class="held-leave" (click)="leave()">Back to the library</button>
          </div>
        } @else {
          <app-home />
        }
      } @else {
        <div class="row">
          @for (pane of panes; track pane.id; let index = $index, first = $first) {
            @if (!first) {
              <!--
                The divider is its own element between two panes rather than a
                border on one of them: a 1px line is unhittable, so this is 7px
                of transparent grab area with the app's own hairline painted
                down the middle of it.
              -->
              <div
                class="divider"
                role="separator"
                aria-orientation="vertical"
                (pointerdown)="startResize($event, index)"
                (pointermove)="onResize($event)"
                (pointerup)="endResize($event)"
                (pointercancel)="endResize($event)"
              ></div>
            }
            <section
              class="pane"
              [style.flex]="pane.flex + ' 1 0'"
              (pointerdown)="focusPane(pane)"
            >
              <!--
                THE STRIP. Absent entirely for a column with nothing in it —
                an empty header over a Home page would be chrome describing
                nothing — and present with one tab in it, because a single tab
                is still the thing you close, pin and drag.

                The drop handlers are on the strip AND on each tab: the tab's
                decide which side of it the drag lands on, the strip's catch
                everything past the last one.
              -->
              @if (pane.tabIds.length > 0) {
                <div
                  class="strip"
                  role="tablist"
                  [attr.aria-label]="'Column ' + (index + 1) + ' documents'"
                  (dragover)="onStripOver($event, pane)"
                  (dragleave)="onStripLeave()"
                  (drop)="onStripDrop($event, pane, null)"
                >
                  @for (tab of stripOf(pane); track tab.id) {
                    <div
                      class="tab"
                      role="tab"
                      draggable="true"
                      [class.on]="tab.id === pane.activeTabId"
                      [class.focused]="tab.id === pane.activeTabId && pane.id === tabs.focusedPaneId()"
                      [class.pinned]="tab.pinned"
                      [class.before]="before()?.paneId === pane.id && before()?.tabId === tab.id"
                      [attr.aria-selected]="tab.id === pane.activeTabId"
                      [title]="tabTitle(tab)"
                      (click)="activate(pane, tab)"
                      (auxclick)="onAux($event, tab)"
                      (contextmenu)="onTabMenu($event, pane, tab)"
                      (dragstart)="onTabDragStart($event, tab)"
                      (dragend)="onTabDragEnd()"
                      (dragover)="onTabOver($event, pane, tab)"
                      (drop)="onStripDrop($event, pane, tab)"
                    >
                      @if (tab.pinned) {
                        <span class="pin" aria-label="Pinned">📌</span>
                      }
                      <span class="name">{{ tab.title }}</span>
                      @if (tab.unsaved || tab.modified) {
                        <span class="dot" aria-hidden="true">●</span>
                      }
                      <!--
                        A PINNED TAB HAS NO ✕. The pin is one decision about
                        whether this document may go away under the user's
                        hand, and a pin that stopped the quiet closing but
                        left the loud one is a pin that fails where nobody
                        looks. Right-click → Unpin is the way back.
                      -->
                      @if (!tab.pinned) {
                        <button
                          class="x"
                          [attr.aria-label]="'Close ' + tab.title"
                          (click)="close($event, tab)"
                        >✕</button>
                      }
                    </div>
                  }
                  <!--
                    PAST THE LAST TAB. The insertion line lives on the tab a drop
                    lands in FRONT of, and a drop at the end lands in front of
                    nothing — so without this the one placement a person makes
                    most (put it at the end) is the one with no preview, which
                    this file's own rule calls a guess.
                  -->
                  @if (before()?.paneId === pane.id && before()?.tabId === null) {
                    <span class="tail" aria-hidden="true"></span>
                  }
                </div>
              }

              @if (documentIn(pane); as tab) {
                <app-viewer [tab]="tab" />
              } @else {
                <app-home [pane]="pane.id" />
              }

              @if (tabs.draggingDocument()) {
                <div
                  class="shield"
                  (dragover)="onOver($event, pane)"
                  (dragleave)="onLeave()"
                  (drop)="onDrop($event, pane, index)"
                >
                  @if (preview(); as landing) {
                    @if (landing.paneId === pane.id) {
                      <div class="landing" [class.left]="landing.zone === 'left'" [class.right]="landing.zone === 'right'"></div>
                    }
                  }
                </div>
              }
            </section>
          }
        </div>
      }
    }

    <!--
      RIGHT-CLICK ON A TAB. The same shape the documents list's menu uses (a
      full-window scrim under it, so the next click anywhere dismisses it exactly
      once and cannot also land on whatever was underneath), because there is one
      context-menu idiom in this app and a second one would be a second thing to
      learn for no gain.

      Two items and no more. Pin is what the strip is for; Close is the ✕ said in
      words, and it is the only way to close a PINNED tab short of unpinning it —
      which is why it is here even though every unpinned tab already has a button.
    -->
    @if (menu(); as open) {
      <div class="menu-scrim" (click)="menu.set(null)" (contextmenu)="menu.set(null)"></div>
      <div
        class="menu"
        role="menu"
        [attr.aria-label]="'Actions for ' + open.tab.title"
        [style.left.px]="open.x"
        [style.top.px]="open.y"
        (keydown.escape)="menu.set(null)"
      >
        <button role="menuitem" (click)="pin(open.tab)">
          {{ open.tab.pinned ? 'Unpin' : 'Pin' }}
        </button>
        <button role="menuitem" (click)="closeFromMenu(open.tab)">Close</button>
      </div>
    }
  `,
  styles: [`
    /* A column, so the notice line can take the height it needs off the top and
       the panes take the rest. */
    :host { display: flex; flex-direction: column; height: 100%; }
    .row { display: flex; flex: 1; min-height: 0; }

    /*
      \`min-width: 0\` and NOT the 280px the dividers clamp to. A hard minimum
      here would make five panes overflow a narrow window — the row would scroll
      sideways and a whole column would be off screen, which is worse than a
      cramped one. The floor is enforced where it can be enforced honestly:
      while a divider is being dragged.

      \`position: relative\` is what the shield and its preview are measured and
      painted against.
    */
    .pane {
      position: relative;
      display: flex;
      flex-direction: column;
      min-width: 0;
      height: 100%;
      overflow: hidden;
    }
    app-viewer, app-home { flex: 1; min-height: 0; }

    /*
      ── The strip ─────────────────────────────────────────────────────────

      ABOVE THE SHIELD (31 against 30) and that is load-bearing: the shield
      covers the whole pane while a drag is in the air, and a strip underneath it
      would be the one drop target a tab drag most obviously means and the one it
      could not reach.

      It SCROLLS SIDEWAYS rather than shrinking its tabs past readability. The
      old complaint about strips was that five columns give each 370 pixels and
      three tabs in one of them are two-letter stubs; the answer is a floor on the
      tab (\`min-width\`) and a scroll when they do not fit, so a narrow column
      shows two readable names and the rest are a flick away, instead of six
      unreadable ones. The bar is hidden — the strip is not a scroll region
      anybody aims at, and a horizontal scrollbar across the top of every column
      would cost more height than the tabs do.
    */
    .strip {
      position: relative;
      z-index: 31;
      flex: 0 0 auto;
      display: flex;
      align-items: stretch;
      overflow-x: auto;
      scrollbar-width: none;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-default);
    }
    .strip::-webkit-scrollbar { display: none; }

    .tab {
      display: flex;
      align-items: center;
      gap: 5px;
      flex: 0 1 auto;
      min-width: 84px;
      max-width: 200px;
      padding: 5px 6px 5px 10px;
      border-right: 1px solid var(--border-subtle);
      color: var(--text-tertiary);
      font-size: 11px;
      cursor: default;
      user-select: none;
      /* The accent bar lives here, so a tab that is not on top still holds the
         2px and nothing shifts when it comes forward. */
      box-shadow: inset 0 2px 0 0 transparent;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  color 100ms cubic-bezier(0, 0, 0.2, 1),
                  box-shadow 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .tab:hover { background: var(--bg-hover); color: var(--text-primary); }

    /*
      ON TOP, and ON TOP IN THE FOCUSED COLUMN, are two different facts and get
      two strengths — the same pair of words the documents list uses for the same
      pair of facts, because a person reading both should not have to learn two
      vocabularies for "this one".
    */
    .tab.on {
      background: var(--bg-base);
      color: var(--text-primary);
      box-shadow: inset 0 2px 0 0 var(--border-strong);
    }
    .tab.on.focused { box-shadow: inset 0 2px 0 0 var(--accent); }

    /*
      Where a dragged tab would land: a line down the edge it lands in front of.
      Spelled out against the on-screen selectors as well, because they set the
      same property at a higher specificity — without this the line would be
      invisible on exactly the tab a person is most likely to be aiming at.
    */
    .tab.before,
    .tab.on.before,
    .tab.on.focused.before { box-shadow: inset 2px 0 0 0 var(--accent); }

    /* The same line, past the last tab. */
    .tail { flex: 0 0 2px; align-self: stretch; background: var(--accent); }

    .tab .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    /* One bullet for either kind of "not filed away yet", exactly as the window
       title does it: the strip is a glance, and the documents list is where the
       two marks are told apart. */
    .tab .dot { flex: 0 0 auto; color: var(--accent); font-size: 8px; line-height: 1; }
    .tab .pin { flex: 0 0 auto; font-size: 9px; line-height: 1; }

    /*
      Hidden until the tab is under the pointer or the button is keyboard-focused,
      and the space is HELD either way — a ✕ that appeared on hover and pushed the
      title sideways would re-truncate the name under the mouse.
    */
    .tab .x {
      flex: 0 0 auto;
      visibility: hidden;
      padding: 2px 3px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 9px; line-height: 1;
      cursor: pointer;
    }
    .tab:hover .x, .tab .x:focus-visible { visibility: visible; }
    .tab .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* Above the panes and below the dialogs; the scrim is what makes the next
       click dismiss it exactly once. The documents list's menu, to the pixel. */
    .menu-scrim { position: fixed; inset: 0; z-index: 1000; }
    .menu {
      position: fixed;
      z-index: 1001;
      min-width: 140px;
      padding: 4px;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      box-shadow: 0 10px 20px -6px rgba(0, 0, 0, 0.35);
    }
    .menu button {
      display: block; width: 100%;
      padding: 6px 10px;
      background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px; text-align: left; cursor: pointer;
    }
    .menu button:hover { background: var(--bg-hover); color: var(--text-primary); }

    .divider {
      flex: 0 0 7px;
      position: relative;
      cursor: col-resize;
      background: transparent;
      /* Touch-action off, or a pointer drag on a touchscreen scrolls the row
         instead of moving the divider. */
      touch-action: none;
    }
    .divider::after {
      content: '';
      position: absolute;
      inset: 0 3px;
      background: var(--border-default);
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .divider:hover::after { background: var(--accent); }

    /*
      Over everything in the pane, iframes included, and only while a row is in
      the air. 30 puts it above the viewer's own content and below the dock
      (40), the shelf (900) and the dialogs (1200) — the drag comes FROM the
      documents panel, so the shield must never be over it.

      THE LADDER SURVIVED THE DOCK MOVING TO THE BOTTOM and the inspector
      arriving on the right, because none of the four is in a stacking context
      of its own: the shell, its row, .main and .pane set no z-index, no
      transform and no filter, so 30 and 40 are still compared against each
      other rather than against their parents. What the move DID change is
      overlap — the dock and the shelf's pill are both along the bottom edge
      now, and the shelf lifts itself by the dock's height token rather than
      relying on 900 to win an argument it should not be having.
    */
    .shield { position: absolute; inset: 0; z-index: 30; }

    /*
      The preview. \`pointer-events: none\` is load-bearing: an element that took
      the pointer would take the shield's dragover events with it, and the
      preview would flicker itself out of existence the moment it appeared.
    */
    .landing {
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: var(--accent-faint);
      border: 2px solid var(--accent);
    }
    /* An edge drop makes a column, so it is drawn as the half of the pane the
       new column would occupy — not as a line, which says "insert here" without
       saying how much of the room it takes. */
    .landing.left { right: 50%; }
    .landing.right { left: 50%; }

    /* The empty workspace of a held project: the shell's own quiet, not the
       paper's — no sheet is up, so the paper vocabulary would be a costume. */
    .held {
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      color: var(--text-secondary);
    }
    .held-title { margin: 0; font-size: 1.1rem; color: var(--text-primary); }
    .held-hint { margin: 0; font-size: 0.9rem; }
    .held-leave {
      margin-top: 1rem;
      padding: 0.35rem 0.9rem;
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md, 6px);
      background: transparent;
      color: var(--text-secondary);
      cursor: pointer;
    }
    .held-leave:hover { background: var(--bg-hover); color: var(--text-primary); }
  `],
})
export class WorkspaceComponent {
  protected readonly tabs = inject(TabsService);
  private readonly projects = inject(ProjectsService);

  /**
   * The held project's title, or null when there is none to hold — a project
   * deleted from the library since it was held answers null too, which is what
   * sends the empty workspace back to Home rather than naming a ghost.
   */
  protected readonly heldTitle = computed(() => {
    const held = this.tabs.heldProject();
    if (held === null) return null;
    return this.projects.projectFor(held)?.title ?? null;
  });

  protected leave(): void {
    this.tabs.releaseProject();
  }

  /** Which pane the pointer is over, and what a drop there would do. */
  protected readonly preview = signal<Landing | null>(null);

  /** The pane being resized, with the pixel widths the drag started from. */
  private drag: {
    left: string;
    right: string;
    leftPx: number;
    span: number;
    flex: number;
    x: number;
  } | null = null;

  /** Where a dragged tab would land in a strip: in front of this one. */
  protected readonly before = signal<{ paneId: string; tabId: string | null } | null>(null);

  /** The open tab context menu: which tab it is about, and where it was asked for. */
  protected readonly menu = signal<{ tab: Tab; x: number; y: number } | null>(null);

  protected documentIn(pane: Pane) {
    return this.tabs.byId(pane.activeTabId);
  }

  /**
   * The strip's tabs, in the strip's own order.
   *
   * Resolved HERE rather than in the service, because `Pane.tabIds` is the order
   * and the flat list is the identities — and putting the join in the service
   * would mean either duplicating the tab objects or a second computed per pane
   * that the template would then have to be handed.
   */
  protected stripOf(pane: Pane): Tab[] {
    const out: Tab[] = [];
    for (const id of pane.tabIds) {
      const tab = this.tabs.byId(id);
      if (tab !== null) out.push(tab);
    }
    return out;
  }

  /** What a tab says on hover — the book, and the two flags spelled out. */
  protected tabTitle(tab: Tab): string {
    const lines = [tab.title];
    if (tab.pinned) lines.push('Pinned — clicking another document opens beside this one.');
    if (tab.unsaved) lines.push("In Foundry's library workspace only.");
    if (tab.modified) lines.push('Edited since the copy you chose was written.');
    return lines.join('\n');
  }

  // ── The tabs themselves ──────────────────────────────────────────────────

  /**
   * The strip's click: bring this tab to the front, and stand where it stands.
   *
   * TWO CALLS AND NOT ONE, because they are two facts. Which tab is on top is this
   * window's business; which step the project is standing on is the ledger's, and
   * the second is the one every action in the app now keys off.
   */
  protected activate(pane: Pane, tab: Tab): void {
    this.tabs.activateInPane(pane.id, tab.id);
    void this.tabs.standForTab(tab.id);
  }

  /**
   * A pointerdown anywhere in a pane: the focus, and the position with it.
   *
   * IT MIRRORS EVEN WHEN THE PANE WAS ALREADY FOCUSED, and that is on purpose —
   * `focusPane` short-circuits an unchanged focus because setting a signal to what
   * it already holds is a repaint for nothing, but the POSITION can be somewhere
   * else entirely while this pane sat focused (a job landed, a row was clicked in
   * the library). Clicking into the document you are looking at is the plainest
   * way there is to say "this one", and the guard in `standForTab` makes it free
   * in the case where it already is.
   */
  protected focusPane(pane: Pane): void {
    this.tabs.focusPane(pane.id);
    if (pane.activeTabId !== null) void this.tabs.standForTab(pane.activeTabId);
  }

  protected close(event: MouseEvent, tab: Tab): void {
    // Without this the click also lands on the tab and activates the document
    // that is about to go, which flashes it on screen for a frame.
    event.stopPropagation();
    void this.tabs.close(tab.id);
  }

  /** Middle-click. `auxclick` and not `mousedown`, so a middle-drag is not a close. */
  protected onAux(event: MouseEvent, tab: Tab): void {
    if (event.button !== 1) return;
    event.preventDefault();
    void this.tabs.close(tab.id);
  }

  protected onTabMenu(event: MouseEvent, pane: Pane, tab: Tab): void {
    event.preventDefault();
    event.stopPropagation();
    // The column the menu was asked in is the column the user means, so it takes
    // the focus on the way — otherwise Close would be about this tab while every
    // other control in the window was still about another column's.
    this.tabs.focusPane(pane.id);
    this.menu.set({ tab, x: event.clientX, y: event.clientY });
  }

  protected pin(tab: Tab): void {
    this.menu.set(null);
    this.tabs.togglePin(tab.id);
  }

  protected closeFromMenu(tab: Tab): void {
    this.menu.set(null);
    void this.tabs.close(tab.id);
  }

  // ── Dragging a tab ───────────────────────────────────────────────────────

  /**
   * A tab picked up out of a strip.
   *
   * THE SAME PAYLOAD A DOCUMENTS-LIST ROW CARRIES, deliberately: the drop side of
   * this gesture — a pane's middle, a pane's edge band, another strip — is one
   * piece of code, and a second MIME would make it two that have to agree.
   *
   * `draggingDocument` raises the shield over every pane, which is what lets a
   * tab be dropped onto a rendered chapter's <iframe> at all.
   */
  protected onTabDragStart(event: DragEvent, tab: Tab): void {
    event.dataTransfer?.setData(DOCUMENT_MIME, tab.id);
    // A drag with no standard type is refused outright by some platforms before
    // a drop can happen at all.
    event.dataTransfer?.setData('text/plain', tab.title);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.tabs.draggingDocument.set(true);
  }

  protected onTabDragEnd(): void {
    this.before.set(null);
    this.preview.set(null);
    this.tabs.draggingDocument.set(false);
  }

  /**
   * Over a tab: the drop lands before it or after it, by which half the pointer
   * is in — the rule the documents list uses one axis over, and the only one that
   * lets a tab be put at the very end of a strip that fills the column.
   */
  protected onTabOver(event: DragEvent, pane: Pane, tab: Tab): void {
    if (!carriesDocument(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    // The two previews are exclusive: over the strip the drop is a place in it,
    // over the page it is a column. Leaving the other one lit would draw a
    // landing rectangle across the page for a drop that will not go there.
    this.preview.set(null);
    this.before.set({ paneId: pane.id, tabId: this.landingFor(event, pane, tab) });
  }

  protected onStripOver(event: DragEvent, pane: Pane): void {
    if (!carriesDocument(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    this.preview.set(null);
    this.before.set({ paneId: pane.id, tabId: null });
  }

  protected onStripLeave(): void {
    this.before.set(null);
  }

  /**
   * A drop in a strip — a reorder inside this column, or a move into it from
   * another one. The service cannot tell the two apart from the drop and does not
   * have to: `dropInStrip` is written as one operation.
   */
  protected onStripDrop(event: DragEvent, pane: Pane, tab: Tab | null): void {
    const id = event.dataTransfer?.getData(DOCUMENT_MIME);
    // Where it lands is read BEFORE the drag state is cleared — clearing first
    // would drop every tab at the end of the strip and quietly undo the insertion
    // point the user was just shown.
    const target = tab === null ? null : this.landingFor(event, pane, tab);
    this.onTabDragEnd();
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    this.tabs.dropInStrip(id, pane.id, target);
  }

  /** Which tab a drop over this one lands in front of, by the half it is in. */
  private landingFor(event: DragEvent, pane: Pane, tab: Tab): string | null {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    if (event.clientX <= box.left + box.width / 2) return tab.id;
    const at = pane.tabIds.indexOf(tab.id);
    return pane.tabIds[at + 1] ?? null;
  }

  // ── Taking a dropped row ─────────────────────────────────────────────────

  protected onOver(event: DragEvent, pane: Pane): void {
    if (!carriesDocument(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.before.set(null);
    this.preview.set({ paneId: pane.id, zone: this.zoneAt(event, box) });
  }

  protected onLeave(): void {
    this.preview.set(null);
  }

  protected onDrop(event: DragEvent, pane: Pane, index: number): void {
    const id = event.dataTransfer?.getData(DOCUMENT_MIME);
    // Recomputed from this event rather than read off the preview signal, so
    // what happens is what the geometry under the pointer says — a preview left
    // over from the pane next door could otherwise decide the drop.
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const zone = this.zoneAt(event, box);
    this.preview.set(null);
    this.before.set(null);
    this.tabs.draggingDocument.set(false);
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    if (zone === 'middle') this.tabs.show(id, pane.id);
    else this.tabs.openInNewPane(id, zone === 'left' ? index : index + 1);
  }

  /**
   * Which third of the pane the pointer is in.
   *
   * The band is a QUARTER of the pane, floored at 60px so a narrow column still
   * has a target a hand can hit and capped at 160 so a wide one does not turn
   * half the page into a splitter. Everything between them is the middle, which
   * is the drop a person means by default.
   *
   * AT THE CAP THE BANDS DO NOT EXIST: `canSplit` is false, the whole pane is a
   * middle drop, and nothing lights up along the edges. A target that highlights
   * and then refuses is worse than one that visibly will not take it — and the
   * refusal is still there by name, in `openInNewPane`, for a drop that arrives
   * some other way.
   */
  private zoneAt(event: DragEvent, box: DOMRect): Zone {
    if (!this.tabs.canSplit()) return 'middle';
    const band = Math.max(60, Math.min(160, box.width * 0.25));
    if (event.clientX < box.left + band) return 'left';
    if (event.clientX > box.right - band) return 'right';
    return 'middle';
  }

  // ── The dividers ─────────────────────────────────────────────────────────

  /**
   * Take the two panes' REAL widths and the two panes' flex, and hold the sum
   * of both constant while the drag moves one into the other.
   *
   * Measuring instead of computing from the flex numbers is what makes this
   * work on the first drag after a pane is added: the flexes are all 1 and the
   * pixel widths are whatever the window is, and the ratio between them is the
   * only thing that maps a mouse movement onto a share.
   */
  protected startResize(event: PointerEvent, index: number): void {
    const divider = event.currentTarget as HTMLElement;
    const left = divider.previousElementSibling as HTMLElement | null;
    const right = divider.nextElementSibling as HTMLElement | null;
    const panes = this.tabs.panes();
    const a = panes[index - 1];
    const b = panes[index];
    if (!left || !right || !a || !b) return;
    event.preventDefault();
    divider.setPointerCapture(event.pointerId);
    this.drag = {
      left: a.id,
      right: b.id,
      leftPx: left.offsetWidth,
      span: left.offsetWidth + right.offsetWidth,
      flex: a.flex + b.flex,
      x: event.clientX,
    };
  }

  protected onResize(event: PointerEvent): void {
    const drag = this.drag;
    if (drag === null) return;
    // Two panes narrower than two minimums between them cannot honour the
    // minimum, so the pair is simply halved rather than snapping to a width
    // that does not exist.
    const floor = drag.span < MIN_PANE_PX * 2 ? drag.span / 2 : MIN_PANE_PX;
    const wanted = drag.leftPx + (event.clientX - drag.x);
    const leftPx = Math.max(floor, Math.min(drag.span - floor, wanted));
    const share = drag.flex / drag.span;
    this.tabs.resize(drag.left, leftPx * share, drag.right, (drag.span - leftPx) * share);
  }

  protected endResize(event: PointerEvent): void {
    const divider = event.currentTarget as HTMLElement;
    if (divider.hasPointerCapture(event.pointerId)) divider.releasePointerCapture(event.pointerId);
    this.drag = null;
  }
}

type Zone = 'left' | 'middle' | 'right';
interface Landing { paneId: string; zone: Zone }

/** Whether this drag is a document out of the list, rather than files from the OS. */
function carriesDocument(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes(DOCUMENT_MIME) === true;
}

/**
 * How narrow a column may be dragged.
 *
 * It used to be measured against the chapter list a book carried inside every
 * pane — 260 pixels of furniture before a word of the page. That list is in the
 * shell's inspector now, so what a column has to fit is the reading toolbar: a
 * title, Edit HTML, the mode line and Save, which run out of room well before
 * this. The number is unchanged because the floor it sets is still the right
 * one; only the reason for it moved.
 */
const MIN_PANE_PX = 280;
