import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  ASK_PRESET_DESCRIPTION_MAX,
  ASK_PRESET_LABEL_MAX,
  ASK_PRESET_MAX,
  ASK_PRESET_QUESTION_MAX,
  checkedSteps,
  type AskPreset,
} from '@owen/foundry-core/shared/ask-presets';

import { AskService } from '../../core/ask.service';
import { BookStacksService } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';

/**
 * PRESETS — Ask's kept questions, each with a checkbox; Send runs the checked
 * ones one after another, in the list's order (Owen, 2026-11-02).
 *
 * The review card's frame (scrim, card, head, foot) and its rules: mounted by
 * app.ts with the other modals, one at a time, closed by ✕, by the scrim and by
 * Escape, every one of which is Cancel.
 *
 * ── EDITS ARE KEPT AS THEY ARE MADE ────────────────────────────────────────
 *
 * Renaming, rewording, reordering, deleting and adding are changes to the
 * app's list and are saved through app settings at once (on leaving a field,
 * or on the press). Cancel does not take them back: it closes without
 * running anything, which is what Cancel means beside a Send. Which boxes are
 * checked is remembered when Send is pressed.
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

  protected readonly labelMax = ASK_PRESET_LABEL_MAX;
  protected readonly descriptionMax = ASK_PRESET_DESCRIPTION_MAX;
  protected readonly questionMax = ASK_PRESET_QUESTION_MAX;
  protected readonly presetMax = ASK_PRESET_MAX;

  protected readonly presets = this.asks.presets;
  /** The boxes as the person is setting them, starting from what was checked last. */
  protected readonly checked = signal<ReadonlySet<string>>(new Set(this.asks.checkedPresets()));
  /** The preset whose question is open for editing. */
  protected readonly opened = signal<string | null>(null);

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

  /** Whether the person has touched a box, so a late read of the settings does not undo them. */
  private touched = false;

  constructor() {
    void this.asks.loadPresets().then(() => {
      if (!this.touched) this.checked.set(new Set(this.asks.checkedPresets()));
    });
  }

  protected flip(id: string): void {
    this.touched = true;
    this.checked.update((held) => {
      const next = new Set(held);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  protected toggle(id: string): void {
    this.opened.update((now) => (now === id ? null : id));
  }

  protected move(index: number, by: number): void {
    const list = [...this.presets()];
    const [one] = list.splice(index, 1);
    list.splice(index + by, 0, one!);
    void this.asks.savePresets({ presets: list });
  }

  protected remove(id: string): void {
    void this.asks.savePresets({ presets: this.presets().filter((one) => one.id !== id) });
    this.checked.update((held) => { const next = new Set(held); next.delete(id); return next; });
  }

  protected rename(preset: AskPreset, label: string): void {
    if (label.trim().length === 0) return;
    this.replace(preset, { label });
  }

  protected redescribe(preset: AskPreset, description: string): void {
    this.replace(preset, { description });
  }

  protected reword(preset: AskPreset, question: string): void {
    if (question.trim().length === 0) return;
    this.replace(preset, { question });
  }

  private replace(preset: AskPreset, change: Partial<AskPreset>): void {
    void this.asks.savePresets({ presets: this.presets().map((one) => (one.id === preset.id ? { ...one, ...change } : one)) });
  }

  /** A new preset at the end, its question the Ask box's text if there is any, open for editing and checked. */
  protected add(): void {
    const draft = this.asks.presetContext()?.draft.trim() ?? '';
    const id = `mine:${Date.now().toString(36)}`;
    const label = draft.length > 0 ? draft.replace(/\s+/g, ' ').slice(0, 32) : 'New preset';
    const fresh: AskPreset = { id, label, description: '', question: draft.length > 0 ? draft : 'Describe what this preset should do.' };
    void this.asks.savePresets({ presets: [...this.presets(), fresh] });
    this.checked.update((held) => new Set(held).add(id));
    this.opened.set(id);
  }

  protected restore(): void {
    void this.asks.savePresets({ presets: null });
    this.opened.set(null);
  }

  protected send(): void {
    const tab = this.tab();
    const context = this.asks.presetContext();
    if (tab === null || context === null || !this.canSend()) return;
    const pane = this.stacks.bookStackFor(tab.id);
    if (pane === null) return;
    const steps = this.steps();
    void this.asks.savePresets({ checked: [...this.checked()] });
    this.ui.closeAskPresets();
    void this.asks.runPresets(tab, pane, steps, context.server, context.model);
  }
}
