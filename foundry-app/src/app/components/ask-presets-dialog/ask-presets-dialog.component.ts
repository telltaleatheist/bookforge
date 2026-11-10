import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { ASK_PRESET_MAX, checkedSteps } from '@owen/foundry-core/shared/ask-presets';

import { AskService } from '../../core/ask.service';
import { BookStacksService } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';

/**
 * PRESETS — the person's kept questions, each with a checkbox; Send runs the
 * checked ones one after another, in the list's order (Owen, 2026-11-02).
 *
 * The review card's frame (scrim, card, head, foot) and its rules: mounted by
 * app.ts with the other modals, one at a time, closed by ✕, by the scrim and by
 * Escape, every one of which is Cancel.
 *
 * ── THE LIST IS KEPT AS IT IS CHANGED ──────────────────────────────────────
 *
 * Reordering, deleting and ticking a box are changes to the app's list and are
 * saved through app settings on the press. Cancel does not take them back: it
 * closes without running anything, which is what Cancel means beside a Send.
 * The boxes are kept as they are ticked, so they are as the person left them
 * when the list comes back from the card that adds or edits one preset
 * (`AskPresetDialogComponent`), which is where a preset's words are written.
 */
@Component({
  selector: 'app-ask-presets-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ask-presets-dialog.component.html',
  styleUrl: './ask-presets-dialog.component.scss',
})
export class AskPresetsDialogComponent {
  protected readonly ui = inject(UiService);
  private readonly asks = inject(AskService);
  private readonly stage = inject(StageService);
  private readonly stacks = inject(BookStacksService);

  protected readonly presetMax = ASK_PRESET_MAX;

  protected readonly presets = this.asks.presets;
  protected readonly checked = this.asks.checkedPresets;

  /** What Send runs: the checked ones, in the list's order. */
  protected readonly steps = computed(() => checkedSteps(this.presets(), this.checked()));

  /** The book in front, which is what Send runs on. */
  private readonly tab = computed(() => {
    const tab = this.stage.activeDocument();
    return tab !== null && tab.kind === 'book' && tab.viewOnly !== true ? tab : null;
  });

  /** Why Send cannot run now, or null when it can. */
  protected readonly problem = computed<string | null>(() => {
    const context = this.asks.presetContext();
    if (this.tab() === null) return 'Presets run on a book, and there is no book in front of you.';
    if (context === null || !context.ready || context.server === null) return 'The model list in the Ask panel is not ready yet.';
    if (context.busy) return 'Ask is still working on this book; Send once it has finished.';
    return null;
  });

  protected readonly canSend = computed(() => this.steps().length > 0 && this.problem() === null);

  constructor() {
    void this.asks.loadPresets();
  }

  protected flip(id: string): void {
    const next = new Set(this.checked());
    if (!next.delete(id)) next.add(id);
    void this.asks.savePresets({ checked: [...next] });
  }

  protected move(index: number, by: number): void {
    const list = [...this.presets()];
    const [one] = list.splice(index, 1);
    list.splice(index + by, 0, one!);
    void this.asks.savePresets({ presets: list });
  }

  protected remove(id: string): void {
    void this.asks.savePresets({
      presets: this.presets().filter((one) => one.id !== id),
      checked: [...this.checked()].filter((one) => one !== id),
    });
  }

  protected send(): void {
    const tab = this.tab();
    const context = this.asks.presetContext();
    if (tab === null || context === null || !this.canSend()) return;
    const pane = this.stacks.bookStackFor(tab.id);
    if (pane === null) return;
    const steps = this.steps();
    this.ui.closeAskPresets();
    void this.asks.runPresets(tab, pane, steps, context.server, context.model);
  }
}
