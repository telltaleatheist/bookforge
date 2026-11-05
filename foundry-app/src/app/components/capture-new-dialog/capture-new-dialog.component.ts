import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { CaptureService } from '../../core/capture.service';
import { OpenDocumentsService } from '../../core/documents.service';
import { IntakeWorkspaceService } from '../../core/intake-workspace.service';
import { UiService } from '../../core/ui.service';

/**
 * NAMING A BOOK BEFORE PHOTOGRAPHING IT — scrim and card, like every other
 * dialog here.
 *
 * ── Why this replaced a field on Home ───────────────────────────────────────
 *
 * The first version put the input and its two buttons inline in Home's action
 * row, and Owen's first look at it was "the input/buttons for create new
 * project are all crammed together with no spacing". He is right and the reason
 * is not really the spacing: this app asks every other question that has a text
 * field and a confirm in a MODAL, and five components already do it. A sixth
 * shape in the action row was the deviation, and no amount of padding would
 * have made it stop being one.
 *
 * The original argument for the inline field was that `window.prompt` does not
 * exist in Electron's renderer, so the button would have looked broken. That
 * argued against `prompt()`. It never argued against a dialog, which is what
 * the app does everywhere else — I reached for the wrong alternative.
 *
 * ── The name is asked at all because it is ONE-SHOT ─────────────────────────
 *
 * The project's folder stem is made from this and the catalogue never renames
 * files under anybody (docs/CAPTURE.md). A default of "Photographs" would be
 * permanent, and permanent is too long to live with a name nobody chose. So the
 * field is empty, the placeholder asks the question, and an empty answer is
 * still allowed — main names it `Photographs` and that is then somebody's
 * decision rather than the app's.
 *
 * ── ONE CARD, TWO GESTURES BEHIND IT (Wave 38) ──────────────────────────────
 *
 * Owen: *"itll pop up a modal to name the new book and open in the project just
 * as though they had started a new book from the home page."* "Just as though"
 * is a specification, not a simile — so this is the same card, and the only
 * thing that differs is what is standing behind the question:
 *
 *   Photograph a book…    an empty project, to shoot into
 *   Create new book…      an empty project, with N images moving into it
 *
 * `UiService.captureNewFrom` carries the second one's ids and is empty for the
 * first. A SECOND DIALOG WOULD HAVE BEEN THE MISTAKE THIS FILE'S FIRST VERSION
 * ALREADY MADE ONCE: the inline field on Home was a sixth shape for a question
 * five modals already asked, and the fix was not spacing, it was noticing that
 * there is one question here. There is still one question here.
 *
 * What the images change is the LEAD and the button's word, because the name is
 * no longer the whole of what pressing it does — nine photographs are about to
 * move — and a card that said nothing about them would be asking somebody to
 * confirm half of an act.
 */
@Component({
  selector: 'app-capture-new-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './capture-new-dialog.component.html',
  styleUrl: './capture-new-dialog.component.scss',
})
export class CaptureNewDialogComponent {
  private readonly captures = inject(CaptureService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly workspace = inject(IntakeWorkspaceService);
  protected readonly ui = inject(UiService);

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

  /**
   * The workspace images this book is being made of — empty for the plain door.
   * Read straight off the service rather than copied into a local: a card that
   * kept its own snapshot would be a second answer to which images are meant,
   * and there is only ever one card on screen.
   */
  protected readonly from = computed(() => this.ui.captureNewFrom());

  /** The card's own name for what it is about to do. */
  protected readonly heading = computed(() =>
    this.from().length > 0 ? 'Create a new book' : 'Photograph a book',
  );

  protected readonly title = signal('');
  /** True while `capture:create` is in flight — it makes a folder, so not twice. */
  protected readonly making = signal(false);

  constructor() {
    // The field is what the dialog is FOR, so the caret starts in it. Anything
    // else makes a person's first keystroke go nowhere.
    afterNextRender(() => this.field().nativeElement.focus());
  }

  protected close(): void {
    if (this.making()) return;
    this.ui.closeCaptureNew();
  }

  /**
   * Make the project and stand in it.
   *
   * The tab is opened from the DIRECTORY rather than a path, exactly as a book
   * tab is: there is no file here for main to be asked permission about. No
   * navigation either — Home is the workspace with no document up, so showing
   * the tab is what puts the light table on screen.
   */
  protected async create(): Promise<void> {
    if (this.making()) return;
    this.making.set(true);
    try {
      /*
       * THE TWO-DOOR PATH IS THE SERVICE'S, NOT THIS CARD'S. `createBook` makes
       * the project and moves the images in — `capture:create` then
       * `capture:intake`, the two doors that already existed — and opens the tab
       * exactly as the branch below does. It is over there because deciding what
       * leaves the workspace is a fact about the workspace, and because a dialog
       * that owned that sequence would be the surface holding the rule.
       *
       * THE CARD CLOSES FIRST in this branch and not in the other, and the
       * difference is where the waiting is drawn: an intake of forty
       * photographs is a minute of work with a progress card of its own
       * (`CaptureProgressComponent`), and a naming modal sitting greyed out in
       * front of it would be two reports about one act with the useless one on
       * top. Making an empty project is a round trip, so that one stays up.
       */
      const chosen = this.from();
      if (chosen.length > 0) {
        this.ui.closeCaptureNew();
        await this.workspace.createBook(this.title().trim(), chosen);
        return;
      }
      const made = await this.captures.create(this.title().trim());
      if (made === null) return;
      this.ui.closeCaptureNew();
      this.documents.show(this.documents.captureTabIn(made));
    } finally {
      this.making.set(false);
    }
  }
}
