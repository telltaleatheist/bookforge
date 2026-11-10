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

import type { AskHighlight, AskSession } from '@owen/foundry-core/shared/ask';

import { AskService, type AskRunState, type AskStep } from '../../core/ask.service';
import type { BookStack } from '../../core/book-stacks.service';
import { StageService } from '../../core/stage.service';
import { UiService } from '../../core/ui.service';
import { ConfirmService } from '../../core/confirm.service';
import { runsOf } from '@owen/foundry-core/shared/ask-conversations';
import { ASK_PRESET_MAX, type AskPreset } from '@owen/foundry-core/shared/ask-presets';
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
  host: { '[class.shut]': '!open()', '(document:keydown.escape)': 'presetMenu.set(null)' },
  templateUrl: './ask-panel.component.html',
  styleUrl: './ask-panel.component.scss',
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
  private readonly requestBox = viewChild<ElementRef<HTMLTextAreaElement>>('box');

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
  protected readonly presetMax = ASK_PRESET_MAX;

  /** The right-click menu on a preset: which one, and where the pointer was. */
  protected readonly presetMenu = signal<{ readonly preset: AskPreset; readonly x: number; readonly y: number } | null>(null);

  /** Open it at the pointer, kept inside the window. */
  protected presetMenuAt(event: MouseEvent, preset: AskPreset): void {
    event.preventDefault();
    this.presetMenu.set({
      preset,
      x: Math.max(4, Math.min(event.clientX, window.innerWidth - 170)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 80)),
    });
  }

  protected editPreset(preset: AskPreset): void {
    this.presetMenu.set(null);
    this.ui.openAskPreset(preset.id, 'panel');
  }

  /** The ✕ and the menu's Delete. Asked first: the ✕ sits a few pixels from the button that runs it. */
  protected async deletePreset(preset: AskPreset): Promise<void> {
    this.presetMenu.set(null);
    const agreed = await this.confirm.ask({
      message: `Delete the preset "${preset.label}"?`,
      detail: [
        'Its title and its text go from the app, for every book.',
        'Nothing it changed on a book is undone.',
      ],
      confirm: 'Delete preset',
    });
    if (agreed) await this.asks.deletePreset(preset.id);
  }

  /**
   * A PRESS PUTS THE PRESET'S TEXT IN THE BOX; Send sends it (Owen, 2026-11-10:
   * *"lets make the presets just fill the text box with the text of the preset
   * so i can edit it before sending it"*). It replaces what the box held: a
   * preset is a whole question. The box takes the caret, at the end, so the
   * next keys add to it. While a run is going the box is disabled, and a press
   * does nothing.
   */
  protected usePreset(preset: AskPreset): void {
    if (this.busy()) return;
    this.draft.set(preset.question);
    const box = this.requestBox()?.nativeElement;
    if (box === undefined) return;
    // The value now, not at the next render: the caret is placed against it.
    box.value = preset.question;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
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
