import {
  ChangeDetectionStrategy, Component, ElementRef, effect, input, output, signal, viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

/**
 * The chapter this book READS and does not NAME, waiting for a name.
 *
 * `file` is the document's zip entry — the identity a chapter is listed,
 * renamed and struck by. `reason` is MAIN's own sentence about why the page
 * cannot print a name, said here rather than in an alert the user would have to
 * dismiss before being offered the fix.
 */
export interface ChapterNamePrompt {
  file: string;
  reason: string;
}

/**
 * Ask what a chapter is called, for a document the book's table of contents
 * does not list.
 *
 * ── Why this exists at all ─────────────────────────────────────────────────
 *
 * Promoting a block to `chapter` makes it its document's OPENING, and an opening
 * prints its chapter's stored name. A document the contents does not name has no
 * stored name, so the page cannot follow — and until Aug 2026 that was the end
 * of it: the app said "rename the chapter to give it one" and the rename refused
 * every unlisted document (Owen, 2026-08-10). The missing operation is LISTING
 * the chapter, and this is where it is asked for.
 *
 * ── Why it is its own component ────────────────────────────────────────────
 *
 * The picker shell's own stylesheet sits within a few bytes of the per-component
 * budget, and this modal is presentational in the way `pass-options-modal` and
 * `export-settings-modal` already are: it holds the text being typed and nothing
 * else. The book, the project and the write are the shell's.
 *
 * Leave it unlisted is a real choice and not a cancel-shaped dead end. The block
 * IS the document's opening either way — the book already records that — and
 * only the contents entry is at stake; the Chapter tab carries the row from
 * here on, marked unlisted, with the same offer standing.
 */
@Component({
  selector: 'app-chapter-name-modal',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="dismiss.emit()">
      <div class="prompt" (click)="$event.stopPropagation()">
        <h3 class="prompt-title">Name this chapter</h3>
        <p class="prompt-reason">{{ prompt().reason }}</p>
        <input
          #nameInput
          class="prompt-input"
          type="text"
          placeholder="What this chapter is called"
          [value]="draft()"
          (input)="draft.set($any($event.target).value)"
          (keydown.enter)="confirm()"
          (keydown.escape)="dismiss.emit()"
        />
        <div class="prompt-actions">
          <desktop-button variant="ghost" (click)="dismiss.emit()">
            Leave it unlisted
          </desktop-button>
          <desktop-button
            variant="primary"
            [disabled]="draft().trim().length === 0"
            (click)="confirm()"
          >List it</desktop-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .prompt {
      width: 420px;
      max-width: calc(100vw - 32px);
      padding: 24px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
    }

    .prompt-title {
      margin: 0 0 8px;
      font-size: var(--ui-font-lg);
      color: var(--text-primary);
    }

    .prompt-reason {
      margin: 0;
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .prompt-input {
      width: 100%;
      margin-top: 16px;
      padding: 8px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
    }

    .prompt-input:focus {
      outline: none;
      border-color: var(--accent);
    }

    .prompt-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
  `],
})
export class ChapterNameModalComponent {
  readonly prompt = input.required<ChapterNamePrompt>();
  /**
   * What the box opens on — the heading printed on the page, when there is a
   * block behind the chapter. Very nearly always the name the user is about to
   * type, and the empty string when the book states nothing to pre-fill from.
   */
  readonly initialName = input.required<string>();

  /** A name was given. The shell owns the write; this only says what was typed. */
  readonly name = output<string>();
  /** Leave the chapter unlisted. Nothing is undone — see this file's header. */
  readonly dismiss = output<void>();

  readonly draft = signal('');
  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

  private readonly fill = effect(() => { this.draft.set(this.initialName()); });

  /**
   * Put the caret in the box the moment it appears.
   *
   * NOT a nicety, and the same hazard the Chapter tab's own title editor has:
   * this opens over a page whose window-level shortcuts include Backspace for
   * "strike the selection", and the selection is the block that was just
   * relabelled. An unfocused box would take the user's first keystroke and
   * delete the very chapter they are naming.
   *
   * The caret goes to the END of the pre-filled heading, so a first Backspace
   * corrects rather than clears; the `activeElement` guard stops a re-render
   * mid-word from yanking it back there.
   */
  private readonly focusEditor = effect(() => {
    const box = this.nameInput();
    if (box === undefined) return;
    const el = box.nativeElement;
    if (el.ownerDocument.activeElement === el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

  confirm(): void {
    const title = this.draft().trim();
    if (title.length === 0) return;
    this.name.emit(title);
  }
}
