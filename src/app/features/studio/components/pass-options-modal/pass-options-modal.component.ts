import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import type { SimplifyPassParams, TranslatePassParams } from '@shared/processing/pass-types';

/** Which EPUB pass is being set up. */
export type PassOptionsKind = 'simplify' | 'translate';

/**
 * The provider and model the user has already chosen in Settings → Pipeline
 * Defaults, handed in rather than read here.
 *
 * This dialog is about the per-RUN choices; who runs the pass is a standing
 * preference, and asking for it again on every book would be asking the same
 * question forever. It is SHOWN, so nobody discovers after an hour which model
 * did the work.
 */
export interface PassAiChoice {
  readonly provider: SimplifyPassParams['aiProvider'];
  readonly model: string;
  readonly ollamaBaseUrl?: string;
  readonly claudeApiKey?: string;
  readonly openaiApiKey?: string;
}

export type PassOptionsResult =
  | { kind: 'simplify'; simplify: SimplifyPassParams }
  | { kind: 'translate'; translate: TranslatePassParams };

/**
 * The two EPUB passes, and neither can be started from a button alone.
 *
 * Simplify has to know WHICH
 * simplification — de-jargon and language-learner produce different books out of
 * the same chapter — and Translate has to know the languages. Neither is
 * defaulted: a pass that quietly picked one would rewrite somebody's book into a
 * form they did not ask for, and the result reads as success.
 *
 * There is deliberately nothing else here. Every other knob those passes have is
 * a standing setting, and a second place to set it would be a second answer.
 */
@Component({
  selector: 'app-pass-options-modal',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="cancel.emit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>{{ kind() === 'simplify' ? 'Simplify this book' : 'Translate this book' }}</h2>
          <button class="close-btn" (click)="cancel.emit()">×</button>
        </div>

        <div class="modal-body">
          @if (kind() === 'simplify') {
            <p class="hint">
              Which simplification? The three produce different books out of the same
              chapter, so there is no sensible one to assume.
            </p>
            @for (option of SIMPLIFY_MODES; track option.id) {
              <label class="option">
                <input
                  type="radio"
                  name="simplify-mode"
                  [checked]="simplifyMode() === option.id"
                  (change)="simplifyMode.set(option.id)"
                />
                <span class="option-label">
                  <strong>{{ option.name }}</strong>
                  <span class="option-hint">{{ option.note }}</span>
                </span>
              </label>
            }
          } @else {
            <p class="hint">
              The book is translated in place. Both languages are asked for because a
              guess at either produces a book nobody asked for.
            </p>
            <label class="field">
              <span class="field-label">From</span>
              <input
                class="field-input"
                type="text"
                placeholder="e.g. English"
                [value]="sourceLang()"
                (input)="sourceLang.set($any($event.target).value)"
              />
            </label>
            <label class="field">
              <span class="field-label">Into</span>
              <input
                class="field-input"
                type="text"
                placeholder="e.g. Spanish"
                [value]="targetLang()"
                (input)="targetLang.set($any($event.target).value)"
              />
            </label>
          }

          <p class="who">
            Run by <strong>{{ ai().provider }}</strong>
            @if (ai().model) { / <strong>{{ ai().model }}</strong> }
            — set in Settings → Pipeline Defaults.
          </p>

          @if (refusal(); as reason) {
            <p class="refusal">{{ reason }}</p>
          }
        </div>

        <div class="modal-footer">
          <desktop-button variant="ghost" (click)="cancel.emit()">Cancel</desktop-button>
          <desktop-button variant="primary" [disabled]="refusal() !== null" (click)="submit()">
            Queue this pass
          </desktop-button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
    }

    .modal-content {
      background: var(--bg-surface);
      border-radius: $radius-lg;
      box-shadow: $shadow-xl;
      width: 90%;
      max-width: 480px;
      display: flex;
      flex-direction: column;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-lg);
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: var(--ui-font-lg);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .close-btn {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: 24px;
        cursor: pointer;
        border-radius: $radius-sm;

        &:hover { background: var(--bg-hover); }
      }
    }

    .modal-body {
      padding: var(--ui-spacing-lg);
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
    }

    .hint {
      margin: 0 0 var(--ui-spacing-sm);
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      line-height: 1.5;
    }

    .option {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      cursor: pointer;

      &:hover { background: var(--bg-hover); }
      input { margin-top: 3px; accent-color: var(--accent); }
    }

    .option-label {
      display: flex;
      flex-direction: column;
      gap: 2px;

      strong { color: var(--text-primary); font-size: var(--ui-font-base); }
    }

    .option-hint {
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
      line-height: 1.45;
    }

    .field {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
    }

    .field-label {
      width: 3.5em;
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
    }

    .field-input {
      flex: 1;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: var(--bg-input);
      border: 1px solid var(--border-input);
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
    }

    .who {
      margin: var(--ui-spacing-sm) 0 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .refusal {
      margin: 0;
      padding: var(--ui-spacing-sm);
      border: 1px solid var(--warning);
      border-radius: $radius-sm;
      background: color-mix(in srgb, var(--warning) 10%, transparent);
      font-size: var(--ui-font-sm);
      color: var(--text-primary);
      line-height: 1.45;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
    }
  `],
})
export class PassOptionsModalComponent {
  readonly kind = input.required<PassOptionsKind>();
  readonly ai = input.required<PassAiChoice>();

  readonly cancel = output<void>();
  readonly confirmed = output<PassOptionsResult>();

  readonly SIMPLIFY_MODES: readonly { id: 'dejargon' | 'destiffen' | 'learner'; name: string; note: string }[] = [
    { id: 'dejargon', name: 'De-jargon', note: 'Trade terms and acronyms explained in ordinary words.' },
    { id: 'destiffen', name: 'De-stiffen', note: 'Academic register loosened; the argument left intact.' },
    { id: 'learner', name: 'Language learner', note: 'Shorter sentences and common vocabulary throughout.' },
  ];

  /**
   * Null until the user picks. There is no pre-selected mode, because a radio
   * group that opens with one chosen is a default wearing a question's clothes.
   */
  readonly simplifyMode = signal<'dejargon' | 'destiffen' | 'learner' | null>(null);
  readonly sourceLang = signal('');
  readonly targetLang = signal('');

  /** Why this pass cannot be queued yet, or null. Drives the button AND says so. */
  readonly refusal = computed<string | null>(() => {
    const ai = this.ai();
    if (!ai.model) {
      return 'No model is set for this pass. Choose one in Settings → Pipeline Defaults; '
        + 'running somebody\'s book through an unnamed model is not something to guess at.';
    }
    if (this.kind() === 'simplify') {
      return this.simplifyMode() === null ? 'Pick which simplification this book should get.' : null;
    }
    const from = this.sourceLang().trim();
    const into = this.targetLang().trim();
    if (!from || !into) return 'Name both languages.';
    if (from.toLowerCase() === into.toLowerCase()) {
      return 'The two languages are the same, so this pass would rewrite the book into itself.';
    }
    return null;
  });

  submit(): void {
    if (this.refusal() !== null) return;
    const ai = this.ai();
    if (this.kind() === 'simplify') {
      const mode = this.simplifyMode();
      // Unreachable while `refusal` gates the button — and thrown rather than
      // defaulted, because the one thing this dialog exists to prevent is a mode
      // nobody chose reaching the queue.
      if (mode === null) throw new Error('Simplify was submitted with no mode chosen.');
      this.confirmed.emit({
        kind: 'simplify',
        simplify: {
          mode,
          aiProvider: ai.provider,
          aiModel: ai.model,
          ...(ai.ollamaBaseUrl ? { ollamaBaseUrl: ai.ollamaBaseUrl } : {}),
          ...(ai.claudeApiKey ? { claudeApiKey: ai.claudeApiKey } : {}),
          ...(ai.openaiApiKey ? { openaiApiKey: ai.openaiApiKey } : {}),
        },
      });
      return;
    }
    this.confirmed.emit({
      kind: 'translate',
      translate: {
        sourceLang: this.sourceLang().trim(),
        targetLang: this.targetLang().trim(),
        aiProvider: ai.provider,
        aiModel: ai.model,
        ...(ai.ollamaBaseUrl ? { ollamaBaseUrl: ai.ollamaBaseUrl } : {}),
        ...(ai.claudeApiKey ? { claudeApiKey: ai.claudeApiKey } : {}),
        ...(ai.openaiApiKey ? { openaiApiKey: ai.openaiApiKey } : {}),
      },
    });
  }
}
