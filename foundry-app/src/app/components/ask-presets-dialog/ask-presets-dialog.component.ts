import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import {
  ASK_PRESET_DESCRIPTION_MAX,
  ASK_PRESET_LABEL_MAX,
  ASK_PRESET_MAX,
  ASK_PRESET_QUESTION_MAX,
  checkedSteps,
  type AskPreset,
} from '@shared/ask-presets';

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
  template: `
    <div class="scrim" (click)="ui.closeAskPresets()"></div>
    <div class="card" role="dialog" aria-modal="true" aria-label="Presets">
      <header class="head">
        <span class="title">Presets</span>
        <button class="x" (click)="ui.closeAskPresets()" title="Close">✕</button>
      </header>

      <p class="lede">
        Checked presets run one after another, top to bottom, each as its own question on this
        book's thread — each later one sees what the earlier ones changed.
      </p>

      <div class="list">
        @for (preset of presets(); track preset.id; let i = $index; let last = $last) {
          <div class="row" [class.open]="opened() === preset.id">
            <label class="pick">
              <input type="checkbox" [checked]="checked().has(preset.id)" (change)="flip(preset.id)" />
            </label>
            <div class="what" (click)="flip(preset.id)">
              <span class="name">{{ preset.label }}</span>
              @if (preset.description.length > 0) {
                <span class="desc">{{ preset.description }}</span>
              }
            </div>
            <div class="tools">
              <button class="tool" title="Move up" [disabled]="i === 0" (click)="move(i, -1)">↑</button>
              <button class="tool" title="Move down" [disabled]="last" (click)="move(i, 1)">↓</button>
              <button class="tool" [title]="opened() === preset.id ? 'Close' : 'Edit the question'" (click)="toggle(preset.id)">✎</button>
              <button class="tool danger" title="Delete this preset" (click)="remove(preset.id)">✕</button>
            </div>
            @if (opened() === preset.id) {
              <div class="edit">
                <label class="field">
                  <span>Name</span>
                  <input #name type="text" [value]="preset.label" [attr.maxlength]="labelMax" (change)="rename(preset, name.value)" />
                </label>
                <label class="field">
                  <span>Description</span>
                  <input #desc type="text" [value]="preset.description" [attr.maxlength]="descriptionMax" (change)="redescribe(preset, desc.value)" />
                </label>
                <label class="field">
                  <span>Question</span>
                  <textarea #question rows="7" [value]="preset.question" [attr.maxlength]="questionMax" (change)="reword(preset, question.value)"></textarea>
                </label>
              </div>
            }
          </div>
        } @empty {
          <p class="none">No presets. Add one, or restore the defaults.</p>
        }
      </div>

      @if (problem(); as said) {
        <p class="problem">{{ said }}</p>
      }

      <footer class="foot">
        <button class="ghost" [disabled]="presets().length >= presetMax" (click)="add()">Add preset</button>
        <button class="ghost" (click)="restore()">Restore default presets</button>
        <span class="spacer"></span>
        <button class="ghost" (click)="ui.closeAskPresets()">Cancel</button>
        <button class="primary" [disabled]="!canSend()" (click)="send()">Send {{ steps().length }}</button>
      </footer>
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 1200; display: block; pointer-events: none; }
    .scrim {
      pointer-events: auto;
      position: absolute; inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    .card {
      pointer-events: auto;
      position: relative;
      margin: 8vh auto 0;
      width: 640px;
      max-width: calc(100vw - 32px);
      max-height: 82vh;
      display: flex; flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2), 0 20px 40px -10px rgba(0, 0, 0, 0.35);
      overflow: hidden;
      animation: rise 140ms cubic-bezier(0.34, 1.56, 0.64, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
    @keyframes rise { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }

    .head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }
    .title { flex: 1; font-family: var(--font-display); font-weight: 600; font-size: 16px; }
    .x { background: transparent; border: none; cursor: pointer; color: var(--text-tertiary); font-size: 13px; padding: 3px 5px; border-radius: var(--radius-sm); }
    .x:hover { background: var(--bg-hover); color: var(--text-primary); }

    .lede { margin: 0; padding: 10px 14px; font-size: 12px; line-height: 1.45; color: var(--text-secondary); border-bottom: 1px solid var(--border-subtle); }

    .list { flex: 1; overflow-y: auto; padding: 4px 0; }
    .none { margin: 0; padding: 28px 16px; text-align: center; font-size: 12px; color: var(--text-tertiary); }
    .row {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 4px 10px;
      padding: 8px 14px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .row.open { background: var(--bg-hover); }
    .pick { display: flex; align-items: center; cursor: pointer; }
    .what { display: flex; flex-direction: column; gap: 2px; min-width: 0; cursor: pointer; }
    .name { font-size: 13px; font-weight: 500; color: var(--text-primary); }
    .desc { font-size: 11px; line-height: 1.4; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tools { display: flex; gap: 2px; }
    .tool {
      width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm);
      color: var(--text-secondary); font-size: 12px; cursor: pointer;
    }
    .tool:hover:not(:disabled) { background: var(--bg-input); border-color: var(--border-default); color: var(--text-primary); }
    .tool:disabled { opacity: 0.35; cursor: default; }
    .tool.danger:hover:not(:disabled) { color: var(--error); }
    .edit { grid-column: 2 / 4; display: flex; flex-direction: column; gap: 8px; padding: 6px 0 4px; }
    .field { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--text-tertiary); }
    .field input, .field textarea {
      width: 100%; box-sizing: border-box;
      padding: 6px 8px;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default); border-radius: var(--radius-md);
      font-family: inherit; font-size: 12px; line-height: 1.45;
    }
    .field textarea { resize: vertical; }
    .field input:focus, .field textarea:focus { outline: none; border-color: var(--accent); }

    .problem { margin: 0; padding: 8px 14px; font-size: 12px; color: var(--warn); border-top: 1px solid var(--border-subtle); }

    .foot { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--border-subtle); }
    .spacer { flex: 1; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 28px; padding: 0 12px;
      border-radius: var(--radius-md);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .primary { border: none; background: var(--accent); color: var(--text-inverse); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .ghost { background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary); }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .primary:disabled, .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
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
