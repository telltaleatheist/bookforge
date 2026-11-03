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

import type { AskHighlight, AskSession } from '@shared/ask';

import { AskService, type AskRunState, type AskStep } from '../../core/ask.service';
import type { BookStack } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { ConfirmService } from '../../core/confirm.service';
import { runsOf } from '@shared/ask-conversations';
import type { AskPreset } from '@shared/ask-presets';
import { api } from '../../core/foundry';
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
 * (OPEN while the run works, so the person sees what it is doing and that it is
 * doing something — Owen, 2026-11-01; folded once it is a finished run, open on a
 * click), and the model's reply — its own summary — with
 * "Review changes" under it. A text box, Send, and Stop while it works.
 *
 * A FOLLOW-UP CONTINUES FROM A NOTE, NOT FROM THE ROUNDS (Owen, 2026-11-01:
 * *"maybe when it finishes its first run, it 'compacts' by summarizing what it
 * found, and then i can ask more questions about the same subject"*). When a run
 * ends, the model writes itself a short note, and the next Send starts from it
 * ("Continuing …" over the box says so). "New question" removes the note, so the
 * model forgets, and clears the thread from view; the kept runs and their review
 * list are not deleted.
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
    <div class="top">
      <button class="head" (click)="open.set(!open())">
        <span class="twist">{{ open() ? '▾' : '▸' }}</span>
        <span class="label">Ask</span>
      </button>
      @if (open() && tab() !== null) {
        <button class="plus" title="New conversation — the ones before it are kept" [disabled]="busy()" (click)="newConversation()">+</button>
      }
    </div>
    @if (open()) {
      <div class="body">
        <!--
          THE BOOK'S CONVERSATIONS (Owen, 2026-11-02), newest first, folded to
          the one in front. A row goes back to it; its runs are drawn below and
          the next message continues it. Delete asks first, on the app's own
          card, and never undoes what its runs put on the book.
        -->
        @if (conversationList().length > 0) {
          <div class="convs">
            <button class="conv-head" (click)="listOpen.set(!listOpen())">
              <span class="twist">{{ listOpen() ? '▾' : '▸' }}</span>
              <span class="conv-now">{{ continuing()?.title ?? 'New conversation' }}</span>
              <span class="conv-count">{{ conversationList().length }}</span>
            </button>
            @if (listOpen()) {
              <ul class="conv-list">
                @for (one of conversationList(); track one.id) {
                  <li class="conv" [class.on]="one.id === continuing()?.id">
                    <button class="conv-pick" [disabled]="busy()" (click)="openConversation(one.id)" [title]="one.title">
                      <span class="conv-title">{{ one.title }}</span>
                      <span class="conv-meta">{{ dated(one.updatedAt) }} · {{ one.turns }} {{ one.turns === 1 ? 'question' : 'questions' }}</span>
                    </button>
                    <button class="conv-x" title="Delete this conversation" [disabled]="busy()" (click)="deleteConversation(one.id, one.title)">✕</button>
                  </li>
                }
              </ul>
            }
          </div>
        }
        <div class="thread" #thread>
          @if (exchanges().length === 0 && live() === null) {
            <p class="empty">
              Ask for something to be done to this book ("strike the study questions") or ask
              about it. The model works through the book and marks what to remove or change;
              everything it does waits with your other edits, and you can review it after.
            </p>
          }
          @for (one of exchanges(); track one.session.id) {
            <div class="msg person" [title]="one.session.request">{{ one.session.chain?.step ?? one.session.preset ?? one.session.request }}</div>
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
            @if (one.session.highlights; as places) {
              @if (places.length > 0) {
                <p class="places-head">Found {{ places.length }} {{ places.length === 1 ? 'place' : 'places' }}</p>
                <ul class="places">
                  @for (place of places; track $index) {
                    <li>
                      <button class="place" [class.on]="isPointed(one.session.id, $index)" (click)="point(one.session.id, $index, place)">
                        <span class="place-note">{{ place.note }}</span>
                        <span class="place-quote">{{ place.quote === null ? place.id : '“' + place.quote + '”' }}</span>
                      </button>
                    </li>
                  }
                </ul>
              }
            }
            @if (one.closing; as closing) {
              <p class="note">{{ closing }}</p>
            }
            @if (one.latest && one.session.hitLimit === true && live() === null) {
              <button class="ghost review" [disabled]="busy() || !modelReady() || server() === null" title="Send a follow-up that carries on from the model's note" (click)="keepGoing()">Keep going</button>
            }
            @if (one.session.items.length > 0) {
              <button class="ghost review" (click)="review(one.session.id)">
                Review changes ({{ one.session.items.length }})
              </button>
            }
          }
          @if (chainOver(); as over) {
            <p class="note">{{ over }}</p>
          }
          @if (live(); as now) {
            @if (chainSaid(); as step) {
              <p class="chain">{{ step }}</p>
            }
            <div class="msg person" [title]="now.request">{{ now.chain?.step ?? now.preset ?? now.request }}</div>
            @if (now.phase === 'running' || now.phase === 'landing') {
              <button class="working active" (click)="liveFolded.set(!liveFolded())">
                <span class="spinner" aria-hidden="true"></span>
                Working… {{ now.round > 0 ? 'round ' + now.round + ' of ' + now.maxRounds : '' }}
                @if (now.tally.length > 0) {
                  · {{ now.tally }}
                }
              </button>
              @if (liveOpen()) {
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
              <button class="working" (click)="liveFolded.set(!liveFolded())">
                <span class="twist">{{ liveOpen() ? '▾' : '▸' }}</span>
                {{ now.phase === 'cancelled' ? 'Stopped' : 'Stopped with a problem' }} after {{ elapsed(now) }}
              </button>
              @if (liveOpen()) {
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
          @if (continuing(); as on) {
            <p class="continuing" [title]="on.title">
              Continuing “{{ clipped(on.title) }}” · {{ on.turns }} {{ on.turns === 1 ? 'question' : 'questions' }} so far
            </p>
          }
          <!--
            THE PRESETS, ONE PRESS EACH (Owen, 2026-11-02) — the kept list, in its
            order and with its names, so an edit in the Presets modal is an edit
            here. A press runs that one at once; the modal is where several run
            in order and where they are edited. The question is on hover.
          -->
          @if (presetRow().length > 0) {
            <div class="presets">
              @for (preset of presetRow(); track preset.id) {
                <button class="preset" [disabled]="!canRunPreset()" [title]="preset.question" (click)="runPreset(preset)">{{ preset.label }}</button>
              }
            </div>
          }
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
          <!--
            SERVER, THEN MODEL, EACH THE PANEL'S WIDTH (Owen, 2026-11-02). They
            used to share the button row, which squeezed the model dropdown to
            nothing and wrapped its billing line a word a line over the buttons.
            The model list is the chosen server's own (app-job-model, reading
            main's one list); changing the server reads it again.
          -->
          <div class="pick">
            <div class="field">
              <label class="label" for="ask-server">Server</label>
              @if (servers().length > 0) {
                <select id="ask-server" [disabled]="busy()" [value]="server() ?? ''" (change)="choose($any($event.target).value)">
                  @for (one of servers(); track one) {
                    <option [value]="one" [selected]="one === server()">{{ one }}</option>
                  }
                </select>
              } @else {
                <select id="ask-server" disabled [title]="serversProblem() ?? 'Add one under Settings › Crucible Servers.'"><option>{{ serversProblem() === null ? 'No Crucible server' : 'Servers could not be read' }}</option></select>
              }
            </div>
            <app-job-model
              kind="ask"
              [topRanked]="true"
              [server]="pinned()"
              [value]="model()"
              (valueChange)="model.set($event)"
              (ready)="modelReady.set($event)"
              (listedOn)="server.set($event)"
            />
          </div>
          <div class="bar">
            <span class="spacer"></span>
            @if (busy()) {
              <button class="ghost" [disabled]="live()?.runId === null || live()?.phase === 'landing'" (click)="stop()">Stop</button>
            } @else {
              <button class="ghost" title="Run kept questions on this book, one after another" (click)="ui.openAskPresets()">Presets</button>
              <button class="primary" [disabled]="!canSend()" (click)="send()">Send</button>
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    /* --grow is the inspector's: the share of the column this section was dragged to. */
    :host {
      flex: var(--grow, 1) 1 0;
      min-height: 0;
      display: flex;
      flex-direction: column;
      border-bottom: 1px solid var(--border-subtle);
    }
    :host(.shut) { flex: 0 0 auto; }

    .top { display: flex; align-items: center; }
    .plus {
      flex: 0 0 auto; margin-right: 8px;
      width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
      background: transparent; border: 1px solid var(--border-default); border-radius: var(--radius-sm);
      color: var(--text-secondary); font-size: 15px; line-height: 1; cursor: pointer;
    }
    .plus:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .plus:disabled { opacity: 0.4; cursor: default; }
    .convs { flex-shrink: 0; border-bottom: 1px solid var(--border-subtle); }
    .conv-head {
      display: flex; align-items: baseline; gap: 6px; width: 100%;
      padding: 4px 12px 6px; background: transparent; border: none; text-align: left; cursor: pointer;
    }
    .conv-head:hover { background: var(--bg-hover); }
    .conv-now { flex: 1; min-width: 0; font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-count { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .conv-list { list-style: none; margin: 0; padding: 0 0 6px; max-height: 280px; overflow-y: auto; }
    .conv { display: flex; align-items: center; gap: 4px; padding: 0 8px 0 12px; }
    .conv.on .conv-title { font-weight: 600; }
    .conv-pick {
      flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      padding: 4px 6px; background: transparent; border: none; border-radius: var(--radius-sm); text-align: left; cursor: pointer;
    }
    .conv-pick:hover:not(:disabled) { background: var(--bg-hover); }
    .conv-title { font-size: 12px; color: var(--text-primary); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .conv-meta { font-size: 10px; color: var(--text-tertiary); }
    .conv-x {
      flex: 0 0 auto; width: 20px; height: 20px; background: transparent; border: none; border-radius: var(--radius-sm);
      color: var(--text-tertiary); font-size: 11px; cursor: pointer;
    }
    .conv-x:hover:not(:disabled) { background: var(--bg-hover); color: var(--error); }
    .head {
      display: flex; align-items: baseline; gap: 8px;
      flex: 1;
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
    .continuing {
      margin: 0;
      font-size: 11px; line-height: 1.4;
      color: var(--text-tertiary);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pick { display: flex; flex-direction: column; gap: 8px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .pick select { width: 100%; min-width: 0; }
    .bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .bar .spacer { flex: 1; }

    .chain { margin: 0; font-size: 11px; font-weight: 600; color: var(--accent); }
    .presets { display: flex; flex-wrap: wrap; gap: 4px; }
    .preset {
      max-width: 100%; height: 24px; padding: 0 9px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default); border-radius: 12px;
      font-family: inherit; font-size: 11px; cursor: pointer;
    }
    .preset:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .preset:disabled { opacity: 0.5; cursor: not-allowed; }
    .places-head { margin: 2px 0 0; font-size: 11px; font-weight: 600; color: var(--text-secondary); }
    .places { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
    .place {
      display: flex; flex-direction: column; align-items: flex-start; gap: 1px;
      width: 100%; padding: 5px 8px; text-align: left;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
      font-family: inherit; cursor: pointer;
    }
    .place:hover { border-color: var(--border-strong); }
    .place.on { border-color: var(--accent); }
    .place-note { font-size: 12px; line-height: 1.35; }
    .place-quote {
      font-size: 11px; line-height: 1.35; color: var(--text-tertiary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
    }

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
  private readonly confirm = inject(ConfirmService);

  /** The book pane this section is about — the inspector's own `sheet()`. */
  readonly pane = input.required<BookStack>();

  protected readonly open = signal(true);
  protected readonly draft = signal('');
  /** The dropdown's value; `''` is Automatic. */
  protected readonly model = signal('');
  protected readonly modelReady = signal(false);
  /** The server the model list was read from, which is where the run goes. */
  protected readonly server = signal<string | null>(null);
  /**
   * The server the person picked here, or '' before they have — when the
   * model list asks main for the remembered one, else the top-ranked one, and
   * says which on `listedOn`.
   */
  protected readonly pinned = signal('');
  /** The registered Crucible servers that are switched on, by name. */
  protected readonly servers = signal<readonly string[]>([]);
  /** Why the servers could not be read, said on the empty box. */
  protected readonly serversProblem = signal<string | null>(null);
  /** Which finished runs' "Working" lines are open, by session id. */
  protected readonly unfolded = signal<ReadonlySet<string>>(new Set());
  /**
   * THE RUN IN FRONT'S "Working" LINE IS OPEN UNLESS SOMEBODY FOLDED IT. Folded is
   * what is held, not open, so a section made again — after a tab switch or a
   * reload, while the run goes on in AskService — starts open, and every Send
   * opens it again.
   */
  protected readonly liveFolded = signal(false);
  protected readonly liveOpen = computed(() => !this.liveFolded());

  private readonly threadBox = viewChild<ElementRef<HTMLElement>>('thread');

  /** The book tab in front of the person, which is what the pane is drawing. */
  protected readonly tab = computed(() => {
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

  /** The book's conversations, newest first. */
  protected readonly conversationList = computed(() => {
    const tab = this.tab();
    return tab === null ? [] : this.asks.conversations().get(tab.path) ?? [];
  });
  /** Whether the list of conversations is unfolded. */
  protected readonly listOpen = signal(false);

  /**
   * THE CONVERSATION IN FRONT: its kept runs, each with the rounds of the run
   * that made it when this window watched it, and the closing sentence about
   * what landed for the run that just finished. A new conversation has none.
   */
  protected readonly exchanges = computed(() => {
    const tab = this.tab();
    if (tab === null) return [];
    const conversation = this.continuing();
    const sessions = conversation === null ? [] : runsOf(conversation, this.asks.history().get(tab.path) ?? []);
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
    return run;
  });

  /** The conversation the next Send continues, or null when it starts a new one. */
  protected readonly continuing = computed(() => {
    const tab = this.tab();
    if (tab === null) return null;
    void this.asks.active();
    void this.asks.conversations();
    return this.asks.activeOf(tab.path);
  });

  protected readonly canSend = computed(() =>
    this.tab() !== null && !this.busy() && this.modelReady() && this.server() !== null && this.draft().trim().length > 0);

  /** "Presets: step 2 of 3 — Front & back matter" while the book's chain runs. */
  protected readonly chainSaid = computed(() => {
    const tab = this.tab();
    return tab === null ? null : this.asks.chainSaid().get(tab.path) ?? null;
  });

  /** The sentence the book's last chain ended on, while nothing newer is running. */
  protected readonly chainOver = computed(() => {
    const tab = this.tab();
    if (tab === null || this.busy()) return null;
    return this.asks.chainOver().get(tab.path) ?? null;
  });

  /** A server picked: the model list is read from it, keeping the model only if it offers it. */
  protected choose(name: string): void {
    if (name.length === 0 || name === this.server()) return;
    this.pinned.set(name);
  }

  private async loadServers(): Promise<void> {
    if (!api) return;
    try {
      const view = await api.crucible.settings();
      this.servers.set(view.servers.filter((one) => one.enabled).map((one) => one.name));
    } catch (err) {
      this.servers.set([]);
      this.serversProblem.set(err instanceof Error ? err.message : String(err));
    }
  }

  constructor() {
    void this.loadServers();
    void this.asks.loadPresets();
    // The Presets modal sends with this panel's choice of model, and starts "Add preset" from its box.
    effect(() => {
      this.asks.presetContext.set({
        server: this.server(),
        model: this.model(),
        ready: this.modelReady(),
        busy: this.busy(),
        draft: this.draft(),
      });
    });
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
    this.liveFolded.set(false);
    void this.asks.start(tab, this.pane(), message, this.server(), this.model());
  }

  /**
   * KEEP GOING — a run that stopped at its round limit, continued as a follow-up
   * on its thread. The model's note says where it was, so nothing it did is lost
   * and the person has nothing to word.
   */
  protected keepGoing(): void {
    const tab = this.tab();
    if (tab === null || this.busy() || !this.modelReady() || this.server() === null) return;
    this.liveFolded.set(false);
    void this.asks.start(tab, this.pane(), KEEP_GOING, this.server(), this.model());
  }

  /** The kept presets, in their order: the row above the box. */
  protected readonly presetRow = computed(() => this.asks.presets());

  /** A preset can run when a book is in front, nothing is running, and a model is chosen. */
  protected readonly canRunPreset = computed(() =>
    this.tab() !== null && !this.busy() && this.modelReady() && this.server() !== null);

  /** One preset, now, as one run headed with its name. */
  protected runPreset(preset: AskPreset): void {
    const tab = this.tab();
    if (tab === null || !this.canRunPreset()) return;
    this.liveFolded.set(false);
    void this.asks.runPresets(tab, this.pane(), [preset], this.server(), this.model());
  }

  /** Light a place the model pointed at, and go to it; clicking it again puts it down. */
  protected point(sessionId: string, index: number, place: AskHighlight): void {
    const tab = this.tab();
    if (tab !== null) this.asks.point(tab.id, tab.path, placeKey(sessionId, index), place);
  }

  protected isPointed(sessionId: string, index: number): boolean {
    return this.asks.pointed()?.key === placeKey(sessionId, index);
  }

  protected stop(): void {
    const tab = this.tab();
    if (tab !== null) void this.asks.cancel(tab.path);
  }

  /** "+": the next message starts a new conversation; the ones before it are kept. */
  protected newConversation(): void {
    const tab = this.tab();
    if (tab === null) return;
    this.asks.newConversation(tab.path);
    this.listOpen.set(false);
  }

  protected openConversation(id: string): void {
    const tab = this.tab();
    if (tab === null) return;
    this.asks.openConversation(tab.path, id);
    this.listOpen.set(false);
  }

  /** Delete one, on the app's own confirm card. Its edits stay on the book. */
  protected async deleteConversation(id: string, title: string): Promise<void> {
    const tab = this.tab();
    if (tab === null) return;
    const agreed = await this.confirm.ask({
      message: `Delete the conversation "${this.clipped(title)}"?`,
      detail: [
        'Its questions, answers and the model\'s note go from this list.',
        'Nothing it changed on the book is undone — those edits stay, and Undo still takes them back.',
      ],
      confirm: 'Delete conversation',
    });
    if (agreed) await this.asks.deleteConversation(tab.path, id);
  }

  /** Open the review card on this run. */
  protected review(sessionId: string): void {
    this.asks.reviewing.set(sessionId);
    this.ui.openAskReview();
  }

  /** "2 Nov" today's year, "2 Nov 2025" otherwise. */
  protected dated(iso: string): string {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return '';
    const sameYear = at.getFullYear() === new Date().getFullYear();
    return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) });
  }

  protected clipped(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= 60 ? flat : `${flat.slice(0, 60)}…`;
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

/** What Keep going sends: the note carries the rest. */
const KEEP_GOING = 'Continue where you left off.';

/** A place's key in the lit map — never an analysis finding's. */
function placeKey(sessionId: string, index: number): string {
  return `ask:${sessionId}:${index}`;
}
