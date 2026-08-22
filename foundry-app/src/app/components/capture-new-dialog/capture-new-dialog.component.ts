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
  template: `
    <div class="scrim" (click)="close()"></div>

    <div
      class="card"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="heading()"
      (keydown.escape)="close()"
    >
      <header class="head">
        <span class="title">{{ heading() }}</span>
      </header>

      <div class="body">
        <p class="lead">
          The name goes on the project's folder and cannot be changed afterwards.
        </p>
        <!--
          THE SECOND SENTENCE ONLY WHEN THERE IS A SECOND HALF TO THE ACT. It
          counts the images because a person about to move nine photographs out
          of the workspace should read the nine — capture-grid's rule for its
          own menu, and the same reason: the workspace list is where they are
          now, and after this it is not.
        -->
        @if (from().length > 0) {
          <p class="lead">
            {{ from().length }}
            {{ from().length === 1 ? 'image moves' : 'images move' }} out of the workspace and into
            it. Anything the intake will not read is named afterwards.
          </p>
        }
        <!--
          Enter submits, because a one-field ask where the keyboard cannot
          finish it is a form pretending to be a question. The destructive-Enter
          reasoning in confirm-dialog does not apply: nothing here destroys
          anything, and the worst an accidental Enter makes is an empty project.
        -->
        <input
          #field
          class="name"
          type="text"
          placeholder="What book is this?"
          [value]="title()"
          [disabled]="making()"
          (input)="title.set(field.value)"
          (keydown.enter)="create()"
        />
      </div>

      <footer class="foot">
        <button class="ghost" type="button" [disabled]="making()" (click)="close()">Cancel</button>
        <!-- "Start" is right for a shoot that has not happened yet and wrong for
             photographs that are already here: nothing is being started, a book
             is being made out of what is on the table. -->
        <button class="primary" type="button" [disabled]="making()" (click)="create()">
          {{ making() ? 'Making…' : from().length > 0 ? 'Create' : 'Start' }}
        </button>
      </footer>
    </div>
  `,
  styles: [`
    /*
     * The host is inert and only its children are not — confirm-dialog's rule,
     * for its reason: a full-window sheet of glass that swallows clicks reads
     * exactly like an app that has died. Here the \`@if\` is in app.ts so the
     * host does not exist while closed, but the discipline is kept anyway
     * because the day somebody moves the \`@if\` inside is the day it matters.
     */
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }

    .scrim {
      position: absolute; inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    .card {
      position: relative;
      pointer-events: auto;
      width: min(460px, calc(100vw - 48px));
      margin: 64px auto 0;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      outline: none;
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .head { padding: 16px 20px 8px; }
    .title { font-family: var(--font-display); font-size: 15px; font-weight: 600; }

    .body { padding: 0 20px 4px; }
    .lead { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }

    .name {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      margin-bottom: 4px;
      font-size: 13px;
      font-family: inherit;
      color: var(--text-primary);
      background: var(--bg-base);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-sm);
      outline: none;
    }
    .name:focus { border-color: var(--accent); }
    .name:disabled { opacity: 0.6; }

    .foot {
      display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap;
      padding: 12px 20px 16px;
      border-top: 1px solid var(--border-subtle);
    }

    /*
     * THE BUTTON RULES ARE COPIED, NOT INHERITED, and that is not laziness.
     *
     * Angular component styles are SCOPED. This card carried confirm-dialog's
     * class names -- ghost and primary -- and none of its rules, because they
     * never leave the component that declares them. So the buttons rendered
     * NATIVE WHITE, which is what Owen saw: a modal in the house style with two
     * browser-default buttons at the bottom of it.
     *
     * Copied from confirm-dialog character for character rather than
     * approximated, because two dialogs that ALMOST match is worse than one
     * that does not: a difference of two pixels reads as a rendering bug rather
     * than as a decision.
     *
     * Every one of the app's dialogs carries its own copy of these rules --
     * confirm, export, host-op, metadata, ocr, simplify, translate. That is the
     * existing house pattern and this file joins it rather than inventing a
     * shared sheet on its own authority; lifting all eight into one place is a
     * house-wide change and somebody else's call.
     */
    .ghost, .primary {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover { background: var(--bg-hover); border-color: var(--border-strong); }
    .primary {
      border: none;
      background: var(--accent-strong); color: var(--text-inverse);
    }
    .primary:hover { background: var(--accent); }
    .primary:active { transform: scale(0.98); }
    /* Both buttons go quiet while the project is being made -- the card is not
       dismissable then, and a button that still looks pressable is a lie. */
    .ghost:disabled, .primary:disabled { opacity: 0.55; cursor: default; }
    .primary:disabled:hover { background: var(--accent-strong); }
    .ghost:disabled:hover { background: var(--bg-input); border-color: var(--border-default); }
  `],
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
