import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { CompareColumnComponent } from '../../components/compare/compare-column.component';
import { HomeComponent } from '../../components/home/home.component';
import { NoticeBarComponent } from '../../components/notice-bar/notice-bar.component';
import { ViewerComponent } from '../../components/viewer/viewer.component';
import { hosted } from '../../core/foundry';
import { ProjectsService } from '../../core/projects.service';
import { PositionSyncService } from '../../core/position-sync.service';
import { StageService } from '../../core/stage.service';

/**
 * The workspace: ONE DOCUMENT, filling the window.
 *
 * ── What this file was, and the ruling that emptied it ───────────────────────
 *
 * It was eight hundred lines of furniture. One to five COLUMNS side by side,
 * each with a CHROME-STYLE STRIP along its top; ✕ to close a tab, right-click to
 * pin it, drag it within a strip to reorder, into another strip to move it, or
 * onto a pane's EDGE BAND to tear it into a column of its own; dividers between
 * the columns with seven pixels of grab area and pixel arithmetic behind them; a
 * transparent SHIELD over every pane while a row was in the air, because a drag
 * over a rendered chapter's <iframe> is delivered to the frame and never to the
 * pane underneath; and a drop preview to say which of the three landings the
 * geometry meant. All of it is gone, on one ruling (2026-08-17):
 *
 *   *"i dont think we should have tabs in foundry. i think its making things a
 *   bit confusing. however, the user should be able to compare two steps
 *   sometimes. so i think the solution is to have a single viewer window/single
 *   tab, and if the user wants to compare two steps, theres a compare button
 *   they can click and then they can choose the step to compare."*
 *
 * `StageService`'s header carries the argument in full, including why the
 * comparison the columns were built for survives them (it is the Aligned pair
 * inside app-book-view, and Compare is docs/PLAN.md §4, unit 8d). What is left
 * here is the three things this page ever actually had to decide.
 *
 * ── The three states, in the order they are asked ────────────────────────────
 *
 * A DOCUMENT IS SHOWN: `app-viewer` fills the window with it — beside a second,
 * READ-ONLY column while a comparison is up (unit 8d). That second column is the
 * only thing that has been added back to this page since the panes left, and the
 * shape of it is the argument for why it is not them coming back: there is one,
 * it is driven by one signal on the stage, it takes no gesture that could change
 * anything, and it has an ✕. See the `.row` styles for the layout rule, which is
 * "two equal halves or one whole" and nothing else.
 *
 * NOTHING IS SHOWN AND A PROJECT IS HELD: the quiet bench. Closing the last
 * document used to bounce the window to Home, which reads as being thrown out of
 * the room you were working in (user ruling, 2026-08-16), so the workspace keeps
 * the project — the library's tree stays up on the left — until the person
 * leaves for the library on purpose. This is also what Home the BUTTON now lands
 * on, and what closing the document on screen lands on, and that is one empty
 * state rather than three.
 *
 * NOTHING IS SHOWN AND NOTHING IS HELD: Home, which is where the app begins.
 *
 * ── HOSTED, THAT THIRD STATE IS NOT HOME, AND THIS IS THE ONLY PLACE IT COULD
 *    BE STOPPED ───────────────────────────────────────────────────────────────
 *
 * *"foundry is building out a book builder. i dont think thatll need to exist in
 * bookforge so we'll need to make sure the user never reaches the home/library
 * of foundry. thats only a foundry function."* (2026-08-20)
 *
 * `<app-home />` is written down exactly once in this app, on the line below, so
 * every route to Home is a route to THIS BRANCH — which is why the refusal is
 * here rather than spread over the gestures that lead to it. Two of those routes
 * were measured in a hosted window before this was written, and both are
 * ordinary:
 *
 *  - A HOSTED WINDOW WHOSE DOCUMENT NEVER ARRIVES. `openFoundryWindow` resolves
 *    the deep link and, for a project with nothing openable in it, logs and
 *    sends nothing — so no tab lands, `heldProject` is never set, and this
 *    branch drew Foundry's Home and stayed there. It also drew it for the beat
 *    between the window loading and the document arriving on every ordinary
 *    hosted open.
 *  - CLOSING THE SHOWN DOCUMENT WITH ANOTHER STILL OPEN. The list is not empty,
 *    so `leaveIfHostedAndEmpty` does not fire; the pointer is deliberately not
 *    repaired on close ("a stale pointer is not an error to be repaired, it is
 *    Home" — documents.service.ts), so the held bench appears, and its *Back to
 *    the library* released the project and landed here. Two clicks, with a book
 *    still open.
 *
 * WHAT IT SHOWS INSTEAD IS A BENCH AND NOT A BLANKED HOME. A Home with its
 * contents guarded away is somewhere a person can still be stranded — the
 * standing rule for this is 82a3763, which CLOSES a hosted window rather than
 * falling through to Home when it runs out of tabs. Closing cannot be the answer
 * here: a hosted window has nothing open for the moment between loading and its
 * document arriving, and a window that shut on "nothing open" would shut before
 * the file got there (documents.service.ts says so, and that is why its own rule
 * is asked from the close GESTURE and never from a count).
 *
 * So the empty hosted workspace is quiet, has no doors, and leaves the way back
 * where it already is: the tree on the left, which is the host's own book.
 *
 * ── And the notice bar is above all three ────────────────────────────────────
 *
 * Outside the branch, deliberately: what it says is about the WINDOW rather than
 * about any one document, and the state where it matters most — a bad file
 * dropped on an app with nothing open — is the state with no document to hang it
 * under.
 *
 * ── Focusing the document moves the position onto it ─────────────────────────
 *
 * There is ONE selection (docs/WORKBENCH.md §6c). Clicking a row in the library
 * moves the position and puts its document on screen; a pointerdown in the viewer
 * moves the position back, through `PositionSyncService.standForTab`, so that the viewer
 * and the pointer can never describe two different things. Without it a person
 * reads the book, presses Translate and translates the scan.
 *
 * POINTERDOWN AND NOT CLICK, which is the one thing kept verbatim from the pane
 * version: it lands before the `click` of the same gesture, so a button that acts
 * on "the document in front of me" already has the right answer by the time it
 * runs, and a drag that begins in the viewer also means that document, where a
 * click that never completes would have said nothing.
 *
 * IT MIRRORS EVEN WHEN THE DOCUMENT WAS ALREADY SHOWN, on purpose: the POSITION
 * can be somewhere else entirely while the same document sat on screen (a job
 * landed, a row was clicked in the library). Clicking into the document you are
 * looking at is the plainest way there is to say "this one", and the guard in
 * `standForTab` makes it free in the case where it already is.
 */
@Component({
  selector: 'app-workspace',
  imports: [CompareColumnComponent, HomeComponent, NoticeBarComponent, ViewerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-notice-bar />

    @if (stage.activeDocument(); as tab) {
      <!--
        ONE COLUMN, OR TWO WHILE A COMPARISON IS UP.

        The row is present either way and holds one child in the ordinary case,
        so the live viewer's box is the same element whether or not a second
        column is beside it — a viewer that was re-created by opening a
        comparison would lose the reader's place in the book they were reading.
      -->
      <div class="row">
        <section class="stage" (pointerdown)="stand(tab.id)">
          <app-viewer [tab]="tab" />
        </section>
        @if (stage.compare() !== null) {
          <app-compare-column />
        }
      </div>
    } @else if (heldTitle(); as title) {
      <!--
        NOTHING OPEN IS NOT NO PROJECT. The window keeps the book it was working
        on (StageService.heldProject): the tree stays up on the left, and this
        bench says the way back is one click away. Home is where you go on
        purpose, by the button.
      -->
      <div class="held">
        <p class="held-title">{{ title }}</p>
        <p class="held-hint">Nothing is open. Click a step in the tree to open it here.</p>
        <!--
          THE WAY OUT IS TO THE LIBRARY, SO HOSTED THERE IS NOWHERE FOR IT TO GO.
          \`leave()\` releases the held project, and an empty workspace with no
          project held is Home — so this button is a door onto Foundry's own
          library, which a hosted window must not have (see the class docblock).
        -->
        @if (!hosted()) {
          <button type="button" class="held-leave" (click)="leave()">Back to the library</button>
        }
      </div>
    } @else if (hosted()) {
      <!--
        HOSTED, THE EMPTY WORKSPACE IS A BENCH AND NEVER HOME — see the class
        docblock for the two routes this closes.

        It says only what is true from here. A window can be empty because the
        document it was opened for has not arrived yet, or because the deep link
        found nothing openable and gave up (\`openFoundryWindow\`, electron/mount.ts),
        and this branch cannot tell those apart — so it names neither, and the
        host's own window is where the reason belongs.
      -->
      <div class="held">
        <p class="held-hint">Nothing is open in this window.</p>
      </div>
    } @else {
      <app-home />
    }
  `,
  styles: [`
    /* A column, so the notice line can take the height it needs off the top and
       the document takes the rest. */
    :host { display: flex; flex-direction: column; height: 100%; }

    /*
      THE ROW IS ONE COLUMN OR TWO, AND NOTHING ARRANGES IT.

      This is not the panes coming back (docs/PLAN.md §4, unit 8d). There is no
      divider, no drag, no flex the user can move and no number remembered
      anywhere: two equal halves while a comparison is up, one whole while it is
      not. A COMPARISON IS A QUESTION, NOT A LAYOUT — it has a beginning (the
      Compare button) and an end (the ✕ on the second column), and the moment it
      grew a draggable edge it would start being furniture somebody has to tidy.

      FIFTY-FIFTY IS THE WHOLE RULE, and it is v1 said out loud rather than a
      first step towards a splitter. Two books being read against each other want
      the same width; the one case that might not — a narrow scan beside a wide
      reflow — is answered by the PDF viewer's own zoom, which is a read and
      already there.
    */
    .row { display: flex; flex: 1; min-height: 0; }

    /*
      \`min-width: 0\` and no floor, which is the flat rule the columns never
      managed to have. A hard minimum would make the pair overflow a narrow
      window — the row would scroll sideways and half a book would be off screen,
      which is worse than a cramped one. With at most two children and no
      dragging, cramped is the only failure available and it is recoverable by
      pressing ✕.
    */
    .stage, app-compare-column {
      flex: 1 1 0;
      min-width: 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    /* The seam between the two, drawn on the second column so a single column
       never carries a border it has nothing to be separated from. */
    app-compare-column { border-left: 1px solid var(--border-default); }
    app-viewer, app-home { flex: 1; min-height: 0; }

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
  /**
   * Whether somebody else is running this app — the switch that decides whether
   * this window may show Home at all.
   *
   * Asked here rather than passed in, exactly as `HomeComponent` and the action
   * menu ask it: it is a fact about the process, answered once from main
   * (`app:hosted`), and threading it through an input would make it look like a
   * property of the workspace that a caller could disagree with.
   */
  protected readonly hosted = hosted;

  protected readonly stage = inject(StageService);
  private readonly positions = inject(PositionSyncService);
  private readonly projects = inject(ProjectsService);

  /**
   * The held project's title, or null when there is none to hold — a project
   * deleted from the library since it was held answers null too, which is what
   * sends the empty workspace on rather than naming a ghost. Standalone that
   * next stop is Home; hosted it is the quiet bench, which is the whole of the
   * difference and is decided in the template rather than here.
   */
  protected readonly heldTitle = computed(() => {
    const held = this.stage.heldProject();
    if (held === null) return null;
    return this.projects.projectFor(held)?.title ?? null;
  });

  protected leave(): void {
    this.stage.releaseProject();
  }

  /**
   * A pointerdown in the viewer: the position, moved onto the document under the
   * hand. See the class docblock for why it is pointerdown and why it fires even
   * when nothing about the screen changed.
   */
  protected stand(tabId: string): void {
    void this.positions.standForTab(tabId);
  }
}
