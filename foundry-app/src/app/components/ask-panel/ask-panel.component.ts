import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import type { AskSession } from '@shared/ask';

import { AskService, type AskRunState, type AskStep } from '../../core/ask.service';
import type { BookStack } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { JobModelComponent } from '../job-model/job-model.component';

/**
 * ASK — the inspector's section for putting a request to the open book, drawn
 * as a CHAT.
 *
 * Owen, 2026-10-29: *"lets build in the logic for asking questions about the
 * document and giving it the ability to mark things"*, and then, on seeing a
 * request box: *"i was thinking it would look like the briefcase one, where it
 * responds to the user and shows the text thats intended for the user after it
 * finishes the loop. like claude code, where it does work, uses tools, thinks,
 * etc. and all of that just shows as 'thinking'... having it structured like a
 * chat window at a minimum would make it a lot easier to understand."*
 *
 * So: the person's message, a "Working" line that holds the model's rounds
 * (folded, open on a click), and the model's reply — its own summary — with
 * "Review changes" under it. A text box, Send, and Stop while it works.
 *
 * ONE REQUEST, ONE CONTEXT. Every Send starts the model fresh; the thread is
 * the person's record of what was asked and what came of it, never the model's
 * memory. "New chat" clears the thread from view and deletes nothing.
 *
 * IT DRAWS AND DOES NOT HOLD. The run and the thread live in `AskService`,
 * keyed by the book, because this section is destroyed every time the person
 * looks at another tab and a run is minutes of a model's work.
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
    </button>
    @if (open()) {
      <div class="body">
        <div class="thread" #thread>
          @if (exchanges().length === 0 && live() === null) {
            <p class="empty">
              Ask for something to be done to this book ("strike the study questions") or ask
              about it. The model works through the book and marks what to remove or change;
              everything it does waits with your other edits, and you can review it after.
            </p>
          }
          @for (one of exchanges(); track one.session.id) {
            <div class="msg person">{{ one.session.request }}</div>
            <button class="working" (click)="toggle(one.session.id)">
              <span class="twist">{{ unfolded().has(one.session.id) ? '▾' : '▸' }}</span>
              Worked for {{ duration(one.session.seconds) }} · {{ one.session.rounds }} {{ one.session.rounds === 1 ? 'round' : 'rounds' }}
            </button>
            @if (unfolded().has(one.session.id)) {
              <ol class="steps">
                @for (step of one.steps; track $index) {
                  <li>{{ step.status }}@if (step.says; as said) {<span class="says">{{ said }}</span>}</li>
                } @empty {
                  <li class="quiet">The rounds of an earlier run are not kept, only what it came to.</li>
                }
              </ol>
            }
            <div class="msg model">
              @if (one.session.summary.length > 0) {
                {{ one.session.summary }}
              } @else {
                <span class="quiet">The model wrote no reply.</span>
              }
            </div>
            @if (one.closing; as closing) {
              <p class="note">{{ closing }}</p>
            }
            @if (one.latest && one.session.items.length > 0) {
              <button class="ghost review" (click)="ui.openAskReview()">
                Review changes ({{ one.session.items.length }})
              </button>
            }
          }
          @if (live(); as now) {
            <div class="msg person">{{ now.request }}</div>
            @if (now.phase === 'running' || now.phase === 'landing') {
              <button class="working active" (click)="toggle('live')">
                <span class="spinner" aria-hidden="true"></span>
                Working… {{ now.round > 0 ? 'round ' + now.round + ' of ' + now.maxRounds : '' }}
                @if (now.struck + now.revised > 0) {
                  · {{ now.struck }} marked{{ now.revised > 0 ? ', ' + now.revised + ' revised' : '' }}
                }
              </button>
              @if (unfolded().has('live')) {
                <ol class="steps">
                  @for (step of now.steps; track $index) {
                    <li>{{ step.status }}@if (step.says; as said) {<span class="says">{{ said }}</span>}</li>
                  }
                  <li class="quiet">{{ now.status }}</li>
                </ol>
              } @else {
                <p class="status">{{ now.status }}</p>
              }
            } @else {
              <button class="working" (click)="toggle('live')">
                <span class="twist">{{ unfolded().has('live') ? '▾' : '▸' }}</span>
                {{ now.phase === 'cancelled' ? 'Stopped' : 'Stopped with a problem' }} after {{ elapsed(now) }}
              </button>
              @if (unfolded().has('live')) {
                <ol class="steps">
                  @for (step of now.steps; track $index) {
                    <li>{{ step.status }}@if (step.says; as said) {<span class="says">{{ said }}</span>}</li>
                  } @empty {
                    <li class="quiet">It stopped before its first round.</li>
                  }
                </ol>
              }
              <div class="msg model" [class.problem]="now.phase === 'failed'">{{ now.message }}</div>
            }
          }
        </div>

        <div class="composer">
          <textarea
            #box
            class="request"
            rows="2"
            placeholder="Ask about this book, or say what to change…"
            aria-label="Your message"
            [value]="draft()"
            [disabled]="busy()"
            (input)="draft.set(box.value)"
            (keydown.enter)="enter($event)"
          ></textarea>
          <div class="bar">
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
            @if (busy()) {
              <button class="ghost" [disabled]="live()?.runId === null || live()?.phase === 'landing'" (click)="stop()">Stop</button>
            } @else {
              <button class="ghost" [disabled]="exchanges().length === 0 && live() === null" title="Start over with an empty thread; nothing is deleted" (click)="newChat()">New chat</button>
              <button class="primary" [disabled]="!canSend()" (click)="send()">Send</button>
            }
          </div>
        </div>
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

    /* The thread scrolls; the composer stays at the bottom of the section,
       where a chat's box is. */
    .body {
      flex: 1; min-height: 0;
      display: flex; flex-direction: column;
      padding: 0 12px 10px;
    }
    .thread {
      flex: 1; min-height: 80px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 6px;
      padding-bottom: 8px;
    }
    .empty { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }

    .msg {
      max-width: 92%;
      padding: 6px 9px;
      border-radius: var(--radius-md);
      font-size: 12px; line-height: 1.5;
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    /* The person's message on the right, the model's on the left, the way
       every chat a person has used draws the two voices. */
    .msg.person {
      align-self: flex-end;
      background: var(--accent);
      color: var(--text-inverse);
    }
    .msg.model {
      align-self: flex-start;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      color: var(--text-primary);
    }
    .msg.model.problem { border-color: var(--warn); color: var(--warn); }

    /* "Working" is one quiet line until it is opened: the rounds are there
       for whoever wants them and out of the way of whoever does not. */
    .working {
      align-self: flex-start;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 2px 0;
      background: transparent; border: none;
      font-family: inherit; font-size: 11px;
      color: var(--text-tertiary);
      cursor: pointer;
    }
    .working:hover { color: var(--text-secondary); }
    .working.active { color: var(--text-secondary); }
    .spinner {
      width: 9px; height: 9px;
      border: 1.5px solid var(--border-strong);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .steps {
      margin: 0; padding: 0 0 0 14px;
      display: flex; flex-direction: column; gap: 3px;
      font-size: 11px; line-height: 1.45;
      color: var(--text-tertiary);
    }
    .says { display: block; font-style: italic; color: var(--text-secondary); }
    .quiet { color: var(--text-tertiary); }
    .status { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .review { align-self: flex-start; }

    .composer {
      display: flex; flex-direction: column; gap: 6px;
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
    }
    .request {
      width: 100%; box-sizing: border-box; resize: vertical;
      min-height: 44px;
      padding: 6px 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-md);
      font-family: inherit; font-size: 12px; line-height: 1.45;
    }
    .request:focus { outline: none; border-color: var(--accent); }
    .bar { display: flex; align-items: center; gap: 6px; }
    .bar .model { flex: 1; min-width: 0; }

    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 28px; padding: 0 12px;
      border-radius: var(--radius-md);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
      flex: 0 0 auto;
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
  `],
})
export class AskPanelComponent {
  protected readonly ui = inject(UiService);
  private readonly stage = inject(StageService);
  private readonly asks = inject(AskService);

  /** The book pane this section is about — the inspector's own `sheet()`. */
  readonly pane = input.required<BookStack>();

  protected readonly open = signal(true);
  protected readonly draft = signal('');
  /** The dropdown's value; `''` is Automatic. */
  protected readonly model = signal('');
  protected readonly modelReady = signal(false);
  /** The server the dropdown's list was read from, which is where the run goes. */
  protected readonly server = signal<string | null>(null);
  /** Which "Working" lines are open: session ids, and 'live' for the run in front. */
  protected readonly unfolded = signal<ReadonlySet<string>>(new Set());

  private readonly threadBox = viewChild<ElementRef<HTMLElement>>('thread');

  /** The book tab in front of the person, which is what the pane is drawing. */
  private readonly tab = computed(() => {
    const tab = this.stage.activeDocument();
    return tab !== null && tab.kind === 'book' && tab.viewOnly !== true ? tab : null;
  });

  private readonly run = computed(() => {
    const tab = this.tab();
    return tab === null ? null : this.asks.runs().get(tab.path) ?? null;
  });
  protected readonly busy = computed(() => {
    const phase = this.run()?.phase;
    return phase === 'running' || phase === 'landing';
  });

  /**
   * THE THREAD: every kept session since the last "New chat", each with the
   * rounds of the run that made it when this window watched it, and the closing
   * sentence about what landed for the run that just finished.
   */
  protected readonly exchanges = computed(() => {
    const tab = this.tab();
    if (tab === null) return [];
    const since = this.asks.clearedAt().get(tab.path) ?? 0;
    const sessions = (this.asks.history().get(tab.path) ?? []).filter((one) => Date.parse(one.at) >= since);
    const latest = this.asks.latest().get(tab.path) ?? null;
    const run = this.run();
    return sessions.map((session: AskSession) => {
      const ran = run !== null && run.runId === session.id && run.phase === 'done' ? run : null;
      return {
        session,
        steps: ran?.steps ?? ([] as readonly AskStep[]),
        closing: ran?.message ?? null,
        latest: latest !== null && latest.id === session.id,
      };
    });
  });

  /** The run in front when it is not (yet) a kept session: working, stopped, or failed. */
  protected readonly live = computed<AskRunState | null>(() => {
    const run = this.run();
    if (run === null || run.phase === 'done') return null;
    const tab = this.tab();
    const since = tab === null ? 0 : this.asks.clearedAt().get(tab.path) ?? 0;
    return run.startedAt >= since ? run : null;
  });

  protected readonly canSend = computed(() =>
    this.tab() !== null && !this.busy() && this.modelReady() && this.server() !== null && this.draft().trim().length > 0);

  constructor() {
    effect(() => {
      const tab = this.tab();
      if (tab !== null) untracked(() => { void this.asks.loadLatest(tab.path); });
    });
    // The newest line in view, the way a chat keeps its last message in front.
    afterRenderEffect(() => {
      this.exchanges();
      const run = this.live();
      void run?.steps.length;
      const box = this.threadBox()?.nativeElement;
      if (box !== undefined) box.scrollTop = box.scrollHeight;
    });
  }

  /** Enter sends; Shift+Enter is a new line, the way a chat box behaves. */
  protected enter(event: Event): void {
    const key = event as KeyboardEvent;
    if (key.shiftKey || key.isComposing) return;
    event.preventDefault();
    this.send();
  }

  protected send(): void {
    const tab = this.tab();
    if (tab === null || !this.canSend()) return;
    const message = this.draft().trim();
    this.draft.set('');
    this.unfolded.update((held) => {
      const next = new Set(held);
      next.delete('live');
      return next;
    });
    void this.asks.start(tab, this.pane(), message, this.server(), this.model());
  }

  protected stop(): void {
    const tab = this.tab();
    if (tab !== null) void this.asks.cancel(tab.path);
  }

  protected newChat(): void {
    const tab = this.tab();
    if (tab !== null) this.asks.newChat(tab.path);
  }

  protected toggle(id: string): void {
    this.unfolded.update((held) => {
      const next = new Set(held);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  protected duration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  protected elapsed(run: AskRunState): string {
    return this.duration(Math.max(0, Math.round((Date.now() - run.startedAt) / 1000)));
  }
}
