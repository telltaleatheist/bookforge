import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';

import { CaptureService } from '../../core/capture.service';
import { OpenDocumentsService } from '../../core/documents.service';
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
      aria-label="Photograph a book"
      (keydown.escape)="close()"
    >
      <header class="head">
        <span class="title">Photograph a book</span>
      </header>

      <div class="body">
        <p class="lead">
          The name goes on the project's folder and cannot be changed afterwards.
        </p>
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
        <button class="primary" type="button" [disabled]="making()" (click)="create()">
          {{ making() ? 'Making…' : 'Start' }}
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
  protected readonly ui = inject(UiService);

  private readonly field = viewChild.required<ElementRef<HTMLInputElement>>('field');

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
      const made = await this.captures.create(this.title().trim());
      if (made === null) return;
      this.ui.closeCaptureNew();
      this.documents.show(this.documents.captureTabIn(made));
    } finally {
      this.making.set(false);
    }
  }
}
