import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';

import {
  ASK_PRESET_LABEL_MAX,
  ASK_PRESET_QUESTION_MAX,
  presetLabel,
  presetQuestion,
} from '@owen/foundry-core/shared/ask-presets';

import { AskService } from '../../core/ask.service';
import { UiService } from '../../core/ui.service';

/**
 * ONE PRESET — its title, and the text sent to the model when it is pressed
 * (Owen, 2026-11-10: *"there should be an add preset button that pops up a modal
 * with the title of the preset and the text that's sent to the model when its
 * pressed"*).
 *
 * The same card adds a preset and edits one: `UiService.askPresetEdit` says
 * which (`id: null` is a new one) and where it was opened from, so closing it
 * goes back to the Presets list when that is where the person was.
 *
 * NOTHING IS KEPT UNTIL THE BUTTON. ✕, the scrim, Escape and Cancel all close
 * without saving, which is what tells this card apart from the list behind it,
 * whose reorder and delete are kept as they are made.
 */
@Component({
  selector: 'app-ask-preset-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ask-preset-dialog.component.html',
  styleUrl: './ask-preset-dialog.component.scss',
})
export class AskPresetDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly asks = inject(AskService);

  protected readonly labelMax = ASK_PRESET_LABEL_MAX;
  protected readonly questionMax = ASK_PRESET_QUESTION_MAX;

  /** The preset being edited, or null for a new one. Read once: the card is one question. */
  private readonly editing = this.ui.askPresetEdit()?.id ?? null;
  protected readonly adding = this.editing === null;

  protected readonly label = signal('');
  protected readonly question = signal('');
  protected readonly saving = signal(false);

  /** Both are needed: a button with no words, or one that sends nothing, is not a preset. */
  protected readonly canSave = computed(() =>
    !this.saving() && presetLabel(this.label()).length > 0 && presetQuestion(this.question()).length > 0);

  private readonly titleBox = viewChild<ElementRef<HTMLInputElement>>('title');

  constructor() {
    if (this.editing === null) {
      // A new preset starts from what is typed in the Ask box, so a question worth keeping is one press away.
      this.question.set(this.asks.presetContext()?.draft.trim() ?? '');
    } else {
      const preset = this.asks.presets().find((one) => one.id === this.editing);
      if (preset === undefined) {
        // Deleted while the card was opening: there is nothing to edit.
        this.ui.closeAskPreset();
      } else {
        this.label.set(preset.label);
        this.question.set(preset.question);
      }
    }
    afterNextRender(() => this.titleBox()?.nativeElement.focus());
  }

  protected async save(): Promise<void> {
    if (!this.canSave()) return;
    this.saving.set(true);
    const kept = await this.asks.keepPreset(this.editing, this.label(), this.question());
    this.saving.set(false);
    // A save that failed said why on the notice line; the card stays, with the words still in it.
    if (kept) this.ui.closeAskPreset();
  }
}
