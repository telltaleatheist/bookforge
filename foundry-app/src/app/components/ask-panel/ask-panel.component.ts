import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';

import { AskService } from '../../core/ask.service';
import type { BookStack } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { JobModelComponent } from '../job-model/job-model.component';

/**
 * ASK — the inspector's section for putting a request to the open book.
 *
 * Owen, 2026-10-29: *"lets build in the logic for asking questions about the
 * document and giving it the ability to mark things. when its done
 * striking/changing/whatever, there should be a button on the sidebar we can
 * click thatll open a modal and show us what it did."*
 *
 * A request, the model dropdown every job offers (`ask`, the same list and the
 * same remembered last choice), Ask, and while it runs a line saying what the
 * model is doing and a Cancel. When it is done the model's summary is here and
 * "Review changes" opens the card that lists every mark by reason and takes any
 * of them back.
 *
 * IT DRAWS AND DOES NOT HOLD. The run lives in `AskService`, keyed by the book,
 * because this section is destroyed every time the person looks at another tab
 * and a run is minutes of a model's work.
 *
 * A SECTION OF THE INSPECTOR, so its host IS the accordion: the inspector's
 * column gives every section a share of the height, and this one takes its
 * share the same way (`:host` below mirrors the inspector's `.accordion`).
 */
@Component({
  selector: 'app-ask-panel',
  imports: [JobModelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.shut]': '!open()' },
  template: `
    <button class="head" (click)="open.set(!open())">
      <span class="twist">{{ open() ? '▾' : '▸' }}</span>
      <span class="label">Ask</span>
      @if (session(); as kept) {
        <span class="count">{{ kept.items.length }}</span>
      }
    </button>
    @if (open()) {
      <div class="body">
        <p class="hint">
          Ask for something to be done to this book — "strike the study questions" — and a
          model works through it, marking what to remove or change. Everything it does
          waits with your other edits.
        </p>
        <textarea
          #box
          class="request"
          rows="3"
          placeholder="What should be done to this book?"
          aria-label="Your request"
          [value]="request()"
          [disabled]="busy()"
          (input)="request.set(box.value)"
        ></textarea>
        <div class="model">
          <app-job-model
            kind="ask"
            [topRanked]="true"
            [value]="model()"
            (valueChange)="model.set($event)"
            (ready)="modelReady.set($event)"
            (listedOn)="server.set($event)"
          />
        </div>
        <div class="actions">
          @if (busy()) {
            <button class="ghost" [disabled]="run()?.runId === null || run()?.phase === 'landing'" (click)="cancel()">Cancel</button>
          } @else {
            <button class="primary" [disabled]="!canAsk()" (click)="ask()">Ask</button>
          }
        </div>

        @if (run(); as now) {
          @if (now.phase === 'running' || now.phase === 'landing') {
            <p class="status">{{ now.status }}</p>
            @if (now.says; as said) {
              <p class="says">{{ said }}</p>
            }
          } @else if (now.message; as message) {
            <p class="status" [class.problem]="now.phase === 'failed'">{{ message }}</p>
          }
        }

        @if (session(); as kept) {
          <div class="result">
            <p class="asked">Last asked: "{{ kept.request }}"</p>
            @if (kept.summary.length > 0) {
              <p class="summary">{{ kept.summary }}</p>
            } @else {
              <p class="summary none">The model wrote no summary.</p>
            }
            <button class="ghost wide" [disabled]="kept.items.length === 0" (click)="ui.openAskReview()">
              Review changes ({{ kept.items.length }})
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host {
      flex: 1 1 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid var(--border-subtle);
    }
    :host(.shut) { flex: 0 0 auto; }

    .head {
      display: flex; align-items: baseline; gap: 8px;
      width: 100%;
      padding: 10px 12px 8px;
      background: transparent; border: none;
      text-align: left; cursor: pointer;
    }
    .head:hover { background: var(--bg-hover); }
    .twist { color: var(--text-tertiary); font-size: 9px; }
    .label {
      flex: 1;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    .body {
      flex: 1; min-height: 0; overflow-y: auto;
      display: flex; flex-direction: column; gap: 8px;
      padding: 0 12px 10px;
    }
    .hint { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }

    .request {
      width: 100%; box-sizing: border-box; resize: vertical;
      min-height: 56px;
      padding: 6px 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit; font-size: 12px; line-height: 1.45;
    }
    .request:focus { outline: none; border-color: var(--accent); }

    .actions { display: flex; justify-content: flex-end; }

    .status { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-secondary); }
    .status.problem { color: var(--warn); }
    .says {
      margin: 0; font-size: 11px; line-height: 1.5; font-style: italic;
      color: var(--text-tertiary);
    }

    .result {
      display: flex; flex-direction: column; gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
    }
    .asked { margin: 0; font-size: 11px; color: var(--text-tertiary); }
    .summary {
      margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary);
      white-space: pre-wrap;
    }
    .summary.none { color: var(--text-tertiary); }

    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 28px; padding: 0 14px;
      border-radius: var(--radius-md);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
    }
    .primary { border: none; background: var(--accent); color: var(--text-inverse); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .primary:disabled, .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    .wide { width: 100%; }
  `],
})
export class AskPanelComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly asks = inject(AskService);

  /** The book pane this section is about — the inspector's own `sheet()`. */
  readonly pane = input.required<BookStack>();

  protected readonly open = signal(true);
  protected readonly request = signal('');
  /** The dropdown's value; `''` is Automatic. */
  protected readonly model = signal('');
  protected readonly modelReady = signal(false);
  /** The server the dropdown's list was read from, which is where the run goes. */
  protected readonly server = signal<string | null>(null);

  /** The book tab in front of the person, which is what the pane is drawing. */
  private readonly tab = computed(() => {
    const tab = this.stage.activeDocument();
    return tab !== null && tab.kind === 'book' && tab.viewOnly !== true ? tab : null;
  });

  protected readonly run = computed(() => {
    const tab = this.tab();
    return tab === null ? null : this.asks.runs().get(tab.path) ?? null;
  });
  protected readonly busy = computed(() => {
    const phase = this.run()?.phase;
    return phase === 'running' || phase === 'landing';
  });
  protected readonly session = computed(() => {
    const tab = this.tab();
    return tab === null ? null : this.asks.latest().get(tab.path) ?? null;
  });
  protected readonly canAsk = computed(() =>
    this.tab() !== null && this.modelReady() && this.server() !== null && this.request().trim().length > 0);

  constructor() {
    effect(() => {
      const tab = this.tab();
      if (tab !== null) untracked(() => { void this.asks.loadLatest(tab.path); });
    });
  }

  protected ask(): void {
    const tab = this.tab();
    if (tab === null || !this.canAsk()) return;
    void this.asks.start(tab, this.pane(), this.request().trim(), this.server(), this.model());
  }

  protected cancel(): void {
    const tab = this.tab();
    if (tab !== null) void this.asks.cancel(tab.path);
  }
}
