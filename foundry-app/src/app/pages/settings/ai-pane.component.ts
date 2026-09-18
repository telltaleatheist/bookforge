/**
 * ai-pane — which Crucible model does the reading and writing.
 *
 * ── WHAT THIS REPLACED, AND WHY IT IS ONE PANE INSTEAD OF TWO CARDS ────────
 *
 * It was `engine-settings-card` ("Where the text work runs") and
 * `engine-models-card` ("Which model runs each act"), stacked. Each was right
 * about its own half and the pair asked a person to hold two tables in their
 * head to answer one question: a route select in the upper table, a model
 * picker for the same class in the lower one, and no line on screen joining
 * them. The two cards' own doc comments each argued at length for the split —
 * "different questions with different vocabularies" — and the argument was
 * sound about the CONTRACT and wrong about the SCREEN. The engine has two
 * fields; a person has one question, which is *what runs my translation*.
 *
 * Owen, 2026-09-17, handing over BookForge's version of this page: *"lets
 * organize the foundry settings like this as well. teh user adds crucible
 * servers and they configure the crucible server for foundry's uses in foundry
 * settings directly."* BookForge got there first (its `ai-panel.component.ts`)
 * and this is the same shape, deliberately — the two apps are windows onto one
 * engine and a person who learns one has learned the other.
 *
 * So a class is ONE ROW with ONE LIST, and the list mixes three kinds of thing
 * that were three controls before: a model on that engine's card, a model it
 * could fetch, and an account it can forward to. They are all answers to *what
 * runs this*, so they are all chips in one row, and {@link JobChip} is composed
 * in the class so the template never branches on which kind a chip is.
 *
 * ── THE ENGINE IS STILL THE ONLY STORE ────────────────────────────────────
 *
 * Unchanged from both cards, and it is the rule that makes this pane cheap:
 * crucible `docs/PHASE15-HOST.md` §5.2 — *"every control in these sections is a
 * request to the engine, and its result is the engine's answer re-read. There
 * is no Save button that writes an app file and syncs later."* No Foundry key
 * stands behind any of it, so switching the server chip is not a merge or a
 * migration: it is a different document, read fresh. Per-server-ness is free
 * because it is a property of where the data lives.
 *
 * bookforge-02 reports the defect that shape prevents, having had it: an
 * app-side `model` pinned in BookForge's own settings was sent with every run
 * and beat the engine's choice, so a model picked on this page was silently
 * overridden for `clean`. Foundry has never had the equivalent — `job-queue.ts`
 * reads `placement.model ?? request.model`, engine first — and this pane adds
 * no place to keep one.
 *
 * ── WHAT IS DELIBERATELY NOT MERGED ───────────────────────────────────────
 *
 * The ACCOUNTS block at the foot stays a block. A key is configured once for
 * the whole engine and then routed per class, so folding it into the rows would
 * ask for the same key four times. The rows point DOWN at it in words, which is
 * what BookForge's rows do and what its screenshot says.
 *
 * ── AND FOUNDRY'S OWN CLOUD SLOTS ARE NOT HERE AT ALL ────────────────────
 *
 * They were, for about an hour, as a second block headed "Cloud accounts
 * Foundry calls itself" — Foundry's own keys, used when a job goes straight to
 * a provider instead of to an engine (docs/SLOTS.md §3). Owen, reading the two
 * blocks: *"the 'connect a provider' section - ist that already covered by
 * having the api key input boxes above it?"*
 *
 * Not literally — one pays through the engine's account and one through
 * Foundry's — but that distinction is invisible to somebody looking at two
 * groups of Anthropic and OpenAI boxes on one page, and it fails his standing
 * rule: *"foundry should only be exposing the settings it needs, nothing else."*
 * Since Wave 66 every act goes through a Crucible server and the tiles are dark
 * without one, so the direct-to-provider path is the one with no caller.
 *
 * THE MECHANISM IS UNTOUCHED — `cloud-providers.ts`, the slots, the dispatcher
 * group headed "Cloud — costs credits" — and only the card is gone. Restoring
 * it is one import.
 */
import {
  ChangeDetectionStrategy, Component, computed, DestroyRef, inject, signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  LLM_CLASSES,
  UPSTREAM_LABEL,
  UPSTREAM_NAMES,
  defaultEngineServer,
  splitUpstreamModel,
  type LlmClass,
  type LocalModelChoice,
  type CapabilityRecord,
  type SettingsDocument,
  type SettingsPatch,
} from '@shared/engine-settings';
import type { CruciblePullProgress } from '@shared/model-wire';
import type { CrucibleServerView } from '@shared/slots';
import { MODEL_CLASSES, type ModelClass } from '@shared/types';
import { actWords, shortfallWords, sizeWords } from '../../core/crucible-words';
import { api } from '../../core/foundry';
import {
  EngineUpstreamsComponent,
  type UpstreamApply,
} from '../../components/engine-upstreams/engine-upstreams.component';

/**
 * THE JOBS, GROUPED BY WHAT THE WORK IS.
 *
 * Five classes in one flat list makes reading a scan look like a sibling of
 * simplifying a paragraph. They are not: one is a picture problem and four are
 * a text problem, and the four share a route the fifth can never have
 * (PHASE15 §1 — `pages` may not go upstream).
 *
 * The grouping is THIS APP's reading, which is the right owner: the engine
 * decides what it can serve, an app decides how to put it in front of a person.
 * BookForge groups the same five the same way and then adds five more of its
 * own — voices, transcription, noise removal — which Foundry has no act behind
 * and therefore does not draw.
 */
const JOB_GROUPS: ReadonlyArray<{
  readonly title: string;
  readonly classes: readonly ModelClass[];
}> = [
  { title: 'Text', classes: ['clean', 'translate', 'simplify', 'analysis'] },
  { title: 'Documents', classes: ['pages'] },
];

/**
 * The reserved value of the "let the engine decide" chip.
 *
 * Not the empty string, for `engine-models-card`'s reason, which outlived it: a
 * control whose "none" value is empty cannot tell "nobody picked" from "picked
 * the automatic one", and those are the two states this exists to separate.
 */
const AUTOMATIC = 'automatic-choice';

/**
 * ONE THING A JOB COULD RUN ON.
 *
 * Composed in the class and drawn without a decision in the template. The list
 * mixes a model on the card, a model that would have to be fetched first, and
 * an account the engine forwards to — and a template branching on which is
 * which per chip is a template nobody can read. They are all the same question,
 * so they are all the same shape, and `action` is the only thing that differs.
 */
interface JobChip {
  /** Stable across redraws so the row does not re-create chips as it updates. */
  readonly key: string;
  readonly label: string;
  /** The small line under the label: a size, a state, or what it is. */
  readonly detail: string;
  /** Is this what the job runs on right now? */
  readonly chosen: boolean;
  /**
   * `assign` puts a local model on the class, `automatic` hands the choice back
   * to the engine, `route` sends the class to an account, `fetch` downloads the
   * weights before any of that is possible.
   */
  readonly action: 'assign' | 'automatic' | 'route' | 'fetch';
  /** The model id, the upstream id, or the empty string for `automatic`. */
  readonly value: string;
  /** What the free-text box opens with, for a `route` chip that opens one. */
  readonly prefill: string;
  /**
   * Draw it dimmed — the engine is expected to refuse it, or it is not on the
   * machine yet. NEVER disabled: see {@link chipsFor}.
   */
  readonly dim: boolean;
}

/** One job, and everything drawn about it. */
interface JobRow {
  readonly cls: ModelClass;
  readonly title: string;
  /** What runs it right now, in one line, including who decided. */
  readonly subtitle: string;
  readonly chips: readonly JobChip[];
  /** The engine's own sentence about why this will not run, or null. */
  readonly reason: string | null;
  readonly shortfall: string | null;
  /** May this class be sent to an account at all? `pages` may not. */
  readonly routable: boolean;
  /** A fetch in flight for one of this row's chips, as a sentence, or null. */
  readonly pull: string | null;
}

@Component({
  selector: 'app-ai-pane',
  imports: [EngineUpstreamsComponent, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (servers().length === 0) {
      <!--
        NOTHING TO DRAW A WINDOW ONTO. Owen, 2026-09-15: "if theres no connected
        crucible server then tiles should be disabled" — and a page of dead
        pickers over an absent engine is the same failure one screen along. It
        says what is missing and where the door is, and offers nothing to press
        that cannot work.
      -->
      <div class="empty">
        <p class="lead">No Crucible server is connected.</p>
        <p class="detail">
          Every model Foundry uses runs on a Crucible server, so there is nothing to configure
          until one is added. Add one under Crucible Servers and this page fills itself in from
          whatever that machine turns out to hold.
        </p>
      </div>
    } @else {
      <!--
        WHICH ENGINE — chips rather than a select, and drawn even when there is
        only one. The old cards hid the control at one server on the grounds
        that a select with one option teaches somebody there is something to
        choose. A chip is not a select: it is a label that happens to be
        pressable, so at one server it reads as a statement of which machine
        this page is about, which is worth saying on a page that writes to it.
      -->
      <div class="chips servers">
        @for (server of servers(); track server.name) {
          <button class="chip server" type="button"
                  [class.chosen]="server.name === chosen()"
                  [disabled]="working()"
                  (click)="choose(server.name)">
            <span class="chip-name">{{ server.name }}</span>
            <span class="chip-detail">{{ serverWords(server) }}</span>
          </button>
        }
      </div>

      @if (problem(); as why) { <p class="warn">{{ why }}</p> }

      @if (doc(); as settings) {
        @for (group of grouped(); track group.title) {
          <h3 class="group">{{ group.title }}</h3>
          @for (row of group.rows; track row.cls) {
            <div class="job">
              <div class="job-head">
                <div class="job-who">
                  <span class="job-title">{{ row.title }}</span>
                  <span class="job-sub">{{ row.subtitle }}</span>
                </div>
                <div class="chips">
                  @for (chip of row.chips; track chip.key) {
                    <!--
                      DIMMED IS NOT DISABLED, and the distinction is the whole
                      honesty of this control. The fit figure excludes the KV
                      cache so it is not a verdict; somebody may be about to
                      free memory; and the ENGINE refuses by name
                      (local_model_does_not_fit, 409). Greying says "expect this
                      to be refused", never "you may not ask".
                    -->
                    <button class="chip" type="button"
                            [class.chosen]="chip.chosen"
                            [class.dim]="chip.dim"
                            [disabled]="working() || (chip.action === 'fetch' && pulling())"
                            [title]="chip.detail"
                            (click)="press(row, chip)">
                      <span class="tick">{{ chip.chosen ? '✓' : '' }}</span>
                      <span class="chip-name">{{ chip.label }}</span>
                    </button>
                  }
                </div>
              </div>

              @if (row.pull; as running) { <p class="small">{{ running }}</p> }
              @if (row.shortfall; as short) { <p class="small warnish">{{ short }}</p> }
              @if (row.reason; as why) { <p class="small">{{ why }}</p> }

              @if (row.routable) {
                <!--
                  THE POINTER DOWNWARDS, on every routable row. It is the line
                  BookForge's rows carry and it is doing real work: the accounts
                  are the answer for a card nothing fits, and a person staring at
                  a row of models that will not run needs to be told there is
                  another kind of answer further down the page.
                -->
                <p class="small">
                  To run this on Anthropic, OpenAI or an Ollama server instead, set one up under
                  Accounts below and press Test.
                </p>
                @if (custom() === row.cls) {
                  <div class="typed">
                    <input class="wide" type="text" [name]="'c-' + row.cls"
                           placeholder="anthropic/claude-sonnet-5"
                           [ngModel]="typed()"
                           (ngModelChange)="typed.set($event)">
                    <button class="primary" type="button"
                            [disabled]="working() || typed().trim().length === 0"
                            (click)="routeTyped(row.cls)">Use it</button>
                  </div>
                }
              }
            </div>
          }
        }

        <!-- ── What the engine is, under everything it was asked to do ──── -->
        <p class="small">{{ backendLine(settings) }}</p>
        @if (settings.backendKind === 'llama-windows') {
          <p class="small">
            Optional: use WSL acceleration for additional model support. The engine on
            {{ chosen() }} manages setup, downloads and any Windows restart requirement.
          </p>
          <button class="primary" [disabled]="working()" (click)="upgradeWindows()">
            Set up WSL acceleration
          </button>
        }
        @if (upgradeMessage(); as message) { <p class="small">{{ message }}</p> }

        <p class="small">
          The sizes above are the engine's estimate of the WEIGHTS only — they do not include the
          KV cache, which a long context on a large model adds several gigabytes to. A model can
          be offered as fitting and still run out of memory when it loads.
        </p>

        <!-- ── Accounts: the engine's own, configured once ──────────────── -->
        <h3 class="group">Accounts</h3>
        <p class="detail">
          An account the engine forwards to. The key is stored in the engine, never here — the
          box below is empty every time this page is drawn, and the engine will only ever say
          the last four characters of what it holds. BookForge, pointed at the same server,
          shows the same accounts.
        </p>
        <app-engine-upstreams
          [serverName]="chosen()"
          [doc]="settings"
          [busy]="working()"
          (apply)="applyUpstream($event)" />

      } @else if (problem() === null) {
        <p class="small">Asking the engine…</p>
      }
    }
  `,
  styles: [`
    :host { display: block; }

    .empty { display: flex; flex-direction: column; gap: 6px; }
    .lead { margin: 0; font-size: 13px; font-weight: 600; }

    .detail { margin: 0 0 4px; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
    .small { margin: 0; font-size: 11px; line-height: 1.5; color: var(--text-tertiary); }
    .warn { margin: 0; font-size: 12px; color: var(--error); }
    .warnish { color: var(--warn); }
    .bad { color: var(--error); }
    .mono { font-family: var(--font-mono); }

    .group {
      margin: 18px 0 8px;
      font-family: var(--font-display); font-size: 13px; font-weight: 600;
      display: flex; align-items: baseline; gap: 10px;
    }
    .group:first-of-type { margin-top: 10px; }

    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chips.servers { margin-bottom: 12px; }

    /*
      SELECTED IS A TICK AND A BORDER, AND THE TEXT NEVER CHANGES COLOUR.
      bookforge-02 shipped this control with the accent used as a background
      behind the ordinary text colour and Owen could not read it. A chosen chip
      here keeps its own foreground and gains a mark plus an edge, which cannot
      go wrong against any theme because nothing about the contrast moves.
    */
    /*
      ONE LINE, NOT TWO. The tick used to sit ABOVE the name in a column, which
      made a chosen chip taller than its neighbours and the whole row ragged —
      Owen: "the buttons are oddly shaped". The tick is inline now and its slot
      is reserved whether or not it is filled, so pressing one does not resize
      it or shift the chips beside it.
    */
    .chip {
      display: inline-flex; align-items: baseline; gap: 6px;
      font: inherit; font-size: 12px; text-align: left; white-space: nowrap;
      background: var(--bg-sunken); color: var(--text-primary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 4px 10px; cursor: pointer;
    }
    .chip:hover:not(:disabled) { border-color: var(--text-tertiary); }
    .chip.chosen { border-color: var(--accent); }
    .chip:disabled { cursor: default; opacity: 0.6; }
    /* Expect the engine to refuse this, or it is not downloaded yet. Pressable. */
    .chip.dim .chip-name { color: var(--text-tertiary); }
    .chip-detail { font-size: 10px; color: var(--text-tertiary); }
    /* A fixed slot, so a chip is the same size ticked and unticked. */
    .tick { font-size: 10px; color: var(--accent); width: 8px; flex: none; }
    /* The server chips DO stack, because their second line is a fact about the
       machine rather than a mark on a choice. */
    .chip.server { flex-direction: column; align-items: flex-start; gap: 1px; min-width: 140px; }

    .job {
      background: var(--bg-raised);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 10px 12px;
      margin-bottom: 8px;
      display: flex; flex-direction: column; gap: 6px;
    }
    .job-head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
    .job-who { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 160px; }
    .job-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .job-sub { font-size: 11px; color: var(--text-tertiary); }

    .typed { display: flex; align-items: center; gap: 6px; }
    .wide { flex: 1; min-width: 0; }
    input {
      font: inherit; font-size: 12px;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 4px 6px;
    }

    .primary {
      display: inline-flex; align-items: center; justify-content: center;
      align-self: flex-start;
      height: 26px; padding: 0 12px; border: none;
      border-radius: var(--radius-sm);
      background: var(--accent); color: var(--text-inverse);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }

    button.ghost {
      font: inherit; font-size: 11px;
      background: transparent; color: var(--text-secondary);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 2px 8px; cursor: pointer;
    }
    button.ghost:hover:not(:disabled) { background: var(--bg-sunken); }
    button.ghost:disabled { opacity: 0.5; cursor: default; }
  `],
})
export class AiPaneComponent {
  protected readonly servers = signal<CrucibleServerView[]>([]);
  protected readonly chosen = signal('');
  protected readonly doc = signal<SettingsDocument | null>(null);
  protected readonly capability = signal<CapabilityRecord | null>(null);
  protected readonly working = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly upgradeMessage = signal<string | null>(null);

  /** Pulls in flight or just finished, by subject id. Cleared on a fresh read. */
  private readonly pulls = signal<Record<string, CruciblePullProgress>>({});
  protected readonly pulling = computed(
    () => Object.values(this.pulls()).some((run) => run.state === 'running'));

  /** The free-text box under a row, while that row's account chip is open. */
  protected readonly custom = signal<ModelClass | null>(null);
  protected readonly typed = signal('');

  /**
   * Every upstream model id THIS ENGINE ALREADY ROUTES SOMETHING TO.
   *
   * PHASE15 §3.7's middle group. It is this list rather than a catalog because
   * there is no catalog — §2: *"the server does not ship a cloud model list"* —
   * and because the useful case is the second class: somebody who routed
   * translation to a model wants simplify on the same one with one press.
   */
  private readonly upstreamOptions = computed<string[]>(() => {
    const settings = this.doc();
    if (settings === null) return [];
    const ids = LLM_CLASSES
      .map((cls) => settings.routes[cls])
      .filter((row) => row.route === 'upstream' && row.model !== null)
      .map((row) => row.model as string)
      .filter((id) => {
        const split = splitUpstreamModel(id);
        return split !== null && settings.upstreams[split.upstream].configured;
      });
    return [...new Set(ids)];
  });

  /**
   * THE WHOLE PAGE OF ROWS, GROUPED, COMPOSED ONCE.
   *
   * A computed rather than a method the template calls per group, and that is
   * not a micro-optimisation: a method here would rebuild every chip of every
   * job on every change-detection pass, and the chips carry `chosen` flags
   * derived from two documents. Recomposing them while somebody is pressing one
   * is how a list develops a flicker nobody can reproduce.
   *
   * Rows come in {@link MODEL_CLASSES} order within their group. A class the
   * engine serves that Foundry has no act for — `tts`, `asr`, `align`, `rvc`,
   * `denoise`, all BookForge's — is not drawn: a Foundry settings page listing a
   * voice engine is the noise Owen objected to, in the other direction. A group
   * that ends up with no rows at all is not drawn either, heading included.
   */
  protected readonly grouped = computed(() => JOB_GROUPS
    .map((group) => ({ title: group.title, rows: this.rowsIn(group.classes) }))
    .filter((group) => group.rows.length > 0));

  private rowsIn(classes: readonly ModelClass[]): JobRow[] {
    const settings = this.doc();
    if (settings === null) return [];
    const cap = this.capability();
    return MODEL_CLASSES
      .filter((cls) => classes.includes(cls))
      .map((cls) => {
        const klass = cap?.classes.find((row) => row.capability === cls) ?? null;
        /*
         * THE REASON IS DRAWN ONLY WHEN IT IS NEWS. On a class that runs, the
         * server's sentence restates the row above it ("X fits: it needs 20.1
         * GiB and there is 21.0 available") — true, and five of them under five
         * working pickers is noise nobody reads. When the class will NOT run it
         * is the only thing on screen that says why.
         */
        const failing = klass !== null && !klass.enabled;
        const routable = (LLM_CLASSES as readonly string[]).includes(cls);
        const chips = this.chipsFor(cls, settings, routable);
        const running = chips
          .map((chip) => this.pulls()[chip.value])
          .find((run) => run !== undefined && run.state === 'running');
        return {
          cls,
          title: actWords(cls),
          subtitle: this.subtitleFor(cls, settings, klass?.selected ?? null),
          chips,
          reason: failing ? klass.reason : null,
          shortfall: failing ? shortfallWords(klass.shortfallBytes) : null,
          routable,
          pull: running === undefined ? null : this.pullWords(running),
        };
      });
  }

  /**
   * WHAT RUNS THIS RIGHT NOW, AND WHO DECIDED — the line under the job's name.
   *
   * Three different facts share this line and each is said in its own words,
   * because "qwen3.8-27b-4bit" alone does not tell somebody whether they chose
   * it or the machine did, and that is exactly what they came to find out:
   *
   *   * routed to an account — the upstream id, which is not a local model and
   *     must not be printed as though it were one;
   *   * a model somebody assigned — its id, flatly;
   *   * `null`, which is a CHOICE and not a gap (the SDK: *"null restores the
   *     engine's automatic decision"*) — so the engine's own resolution from
   *     `GET /v1/capability`, marked as the engine's.
   *
   * The resolution is read, never computed. An app that worked out for itself
   * which model the engine would pick would be keeping a second copy of the
   * engine's rules, wrong from the first release that changed them.
   */
  private subtitleFor(
    cls: ModelClass, settings: SettingsDocument, resolved: string | null,
  ): string {
    const route = (LLM_CLASSES as readonly string[]).includes(cls)
      ? settings.routes[cls as LlmClass]
      : undefined;
    if (route !== undefined && route.route === 'upstream' && route.model !== null) {
      return `${route.model} — an account this engine forwards to`;
    }
    const assigned = settings.localModels.assigned[cls] ?? null;
    if (assigned !== null) return assigned;
    if (resolved !== null && resolved.length > 0) return `${resolved} (chosen by the engine)`;
    return 'the engine has not chosen one';
  }

  /**
   * THE ONE LIST, out of three sources.
   *
   * NOTHING IS FILTERED OUT. Not the model that will not fit — the estimate
   * excludes the KV cache and the ENGINE refuses by name
   * (`local_model_does_not_fit`, 409) — and not the model that is not
   * downloaded, which gets a fetch instead of an assignment. A picker that hid
   * either would be this app enforcing a rule it holds a worse copy of, and the
   * person would be left wondering where the model went.
   *
   * THE ACCOUNT CHIPS ARE ONLY ON A ROUTABLE CLASS. `pages` may never go
   * upstream (PHASE15 §1), so offering one there would be offering something
   * the server refuses by name — the one case where this page does decide
   * something, because the contract states it rather than estimates it.
   */
  private chipsFor(
    cls: ModelClass, settings: SettingsDocument, routable: boolean,
  ): JobChip[] {
    const route = routable ? settings.routes[cls as LlmClass] : undefined;
    const upstream = route !== undefined && route.route === 'upstream' ? route.model : null;
    const assigned = settings.localModels.assigned[cls] ?? null;
    const local = upstream === null;

    const chips: JobChip[] = [{
      key: `${cls}:auto`,
      label: 'Automatic',
      detail: 'the engine decides',
      chosen: local && assigned === null,
      action: 'automatic',
      value: '',
      prefill: '',
      dim: false,
    }];

    for (const choice of settings.localModels.choices[cls] ?? []) {
      chips.push({
        key: `${cls}:${choice.id}`,
        label: choice.installed ? choice.id : `${choice.id} ↓`,
        detail: this.choiceWords(choice),
        chosen: local && assigned === choice.id,
        action: choice.installed ? 'assign' : 'fetch',
        value: choice.id,
        prefill: '',
        dim: !choice.fits || !choice.installed,
      });
    }

    if (routable) {
      for (const id of this.upstreamOptions()) {
        chips.push({
          key: `${cls}:route:${id}`,
          label: id,
          detail: 'an account this engine forwards to',
          chosen: upstream === id,
          action: 'route',
          value: id,
          prefill: '',
          dim: false,
        });
      }
      /*
       * ONE CHIP PER CONFIGURED ACCOUNT, NAMED — and none at all when no
       * account is set up.
       *
       * This was a single chip reading "an account…", drawn on every row
       * whether or not any account existed. Owen, on meeting it: *"it says 'an
       * account...' - not sure what that is."* Neither could anybody: it named
       * no provider, and on a machine with no key configured it opened a box
       * for a model id on an account the engine did not hold, which the engine
       * then refused. A control that is meaningless until something else is
       * true does not belong on screen until that thing is true — the row's own
       * line already says where to go and set one up.
       */
      for (const name of UPSTREAM_NAMES) {
        if (!settings.upstreams[name].configured) continue;
        const open = upstream !== null && splitUpstreamModel(upstream)?.upstream === name;
        chips.push({
          key: `${cls}:route:${name}`,
          label: `${UPSTREAM_LABEL[name]}…`,
          detail: `name a model on the ${UPSTREAM_LABEL[name]} account this engine holds`,
          chosen: open && !this.upstreamOptions().includes(upstream as string),
          action: 'route',
          value: '',
          prefill: `${name}/`,
          dim: false,
        });
      }
    }

    return chips;
  }

  constructor() {
    const destroyRef = inject(DestroyRef);
    if (!api) return;

    destroyRef.onDestroy(api.crucible.onEngineUpgrade((progress) => {
      if (progress.server === this.chosen()) this.upgradeMessage.set(progress.message);
    }));

    /*
     * EVERY FRAME OF EVERY PULL, filtered to the engine this page is looking
     * at. Main broadcasts to all windows and names the server on each frame, so
     * a page watching the Mac does not draw the PC's download.
     */
    api.crucible.onPullProgress((progress) => {
      if (progress.server !== this.chosen()) return;
      this.pulls.update((all) => ({ ...all, [progress.id]: progress }));
      /*
       * A LANDED PULL CHANGES THE ROW IT WAS FOR: the job's chip stops being a
       * fetch and becomes something assignable. So the page re-reads rather
       * than patching in place — the engine is the truth and this is a window
       * onto it.
       */
      if (progress.state === 'done') void this.load();
    });

    void this.load();
  }

  /**
   * The registry, then the chosen engine's document.
   *
   * THE REGISTRY IS READ THROUGH `crucible:settings`, which hosted answers the
   * HOST's list (electron/crucible-registry.ts). That is the whole of what
   * PHASE15 §5.3 asks: one engine, two apps, and no branch here that knows the
   * difference.
   */
  private async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.servers.set(view.servers);
    if (this.chosen().length === 0) {
      this.chosen.set(defaultEngineServer(view.servers)?.name ?? '');
    }
    if (this.chosen().length > 0) await this.read();
  }

  /**
   * One read of the document and the capability record, together.
   *
   * BOTH GO TOGETHER, and a failure clears both. A document kept beside a
   * capability record that failed to read would draw five working pickers, no
   * reason under the class that cannot run, and a subtitle claiming the engine
   * has not chosen a model when the truth is that nobody asked it.
   */
  private async read(): Promise<void> {
    if (!api) return;
    this.working.set(true);
    try {
      const [document, capability] = await Promise.all([
        api.crucible.engineSettings(this.chosen()),
        api.crucible.engineCapability(this.chosen()),
      ]);
      this.doc.set(document);
      this.capability.set(capability);
      this.problem.set(null);
    } catch (err) {
      this.doc.set(null);
      this.capability.set(null);
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.working.set(false);
    }
  }

  protected choose(name: string): void {
    if (name === this.chosen()) return;
    this.chosen.set(name);
    /*
     * THE WHOLE VIEW GOES WITH THE ENGINE, and there is nothing to migrate
     * because nothing on this page is Foundry's. The pulls are keyed by subject
     * id and two engines can be fetching the same model, so carrying the map
     * across would draw the PC's progress on the Mac's row. A pull still
     * running is not lost: main keeps following it and its next frame names its
     * own server, which this page ignores until it is looking there again.
     */
    this.doc.set(null);
    this.capability.set(null);
    this.pulls.set({});
    this.custom.set(null);
    this.upgradeMessage.set(null);
    void this.load();
  }

  /**
   * The chip subtitle: what that machine is, and only for the one being read.
   *
   * The registry entry carries a name, a URL and whether it is switched on — it
   * does NOT carry the card or the backend, which come from the document this
   * page reads for the CHOSEN server alone. So the others say what is true of
   * them and nothing more. Probing every registered engine to fill in a subtitle
   * would be this page starting network traffic to decorate a label.
   */
  protected serverWords(server: CrucibleServerView): string {
    if (server.name !== this.chosen()) {
      return server.enabled ? 'not selected' : 'switched off';
    }
    const settings = this.doc();
    if (settings === null) return this.problem() === null ? 'reading…' : 'not answering';
    const total = this.capability()?.totalBytes ?? 0;
    const card = total > 0 ? ` · ${sizeWords(total)} card` : '';
    return `${settings.backendKind}${card}`;
  }

  /**
   * "qwen3.8-27b-4bit — 20.1 GB est., larger than this card" — and the word for
   * the figure is never "fits".
   */
  private choiceWords(choice: LocalModelChoice): string {
    const size = `${sizeWords(choice.memoryBytesEstimate)} est.`;
    const room = choice.fits ? size : `${size} · larger than this card`;
    return choice.installed ? room : `${room} · not installed`;
  }

  protected pullWords(run: CruciblePullProgress): string {
    switch (run.state) {
      case 'done': return run.skipped === null ? 'fetched' : run.skipped;
      case 'failed': return 'could not be fetched';
      case 'cancelled': return 'stopped';
      default: break;
    }
    if (run.bytes !== null) {
      const done = sizeWords(run.bytes.done);
      return run.bytes.total === null
        ? `fetching — ${done} so far`
        : `fetching — ${done} of ${sizeWords(run.bytes.total)}`;
    }
    if (run.step !== null) {
      return `${run.step.name} (${run.step.index} of ${run.step.total})`;
    }
    return 'starting…';
  }

  /**
   * ONE PRESS, ONE REQUEST, AND THE ANSWER IS THE NEW TRUTH.
   *
   * The four chip actions are four different requests and this is the only
   * place that knows which is which — the template presses a chip and says
   * nothing about what kind it was.
   *
   * ── WHY AN ASSIGNMENT ALSO SETS THE ROUTE ────────────────────────────────
   *
   * Because a person pressing a local model on a class that is currently routed
   * to Anthropic means *run it here now*, and writing `local_models` alone would
   * store a preference the engine never consults while the route stands
   * upstream. The control would appear to work and change nothing — the exact
   * defect bookforge-02 hit from the other direction. PHASE15 §3.2 applies
   * upstreams, then routes, then validates the whole, and *"a refusal applies
   * nothing"*, so the pair is safe to send as one body.
   *
   * `pages` takes no `routes` key at all: it is not an {@link LlmClass} and the
   * engine refuses the field by name.
   */
  protected press(row: JobRow, chip: JobChip): void {
    if (chip.action === 'fetch') {
      void this.fetch(chip.value);
      return;
    }
    if (chip.action === 'route') {
      if (chip.value.length === 0) {
        this.custom.set(row.cls);
        this.typed.set(chip.prefill);
        return;
      }
      this.custom.set(null);
      void this.put({ routes: { [row.cls as LlmClass]: chip.value } });
      return;
    }
    this.custom.set(null);
    const model = chip.action === 'automatic' ? null : chip.value;
    const patch: SettingsPatch = { localModels: { [row.cls]: model } };
    if (row.routable) patch.routes = { [row.cls as LlmClass]: 'local' };
    void this.put(patch);
  }

  protected routeTyped(cls: ModelClass): void {
    const value = this.typed().trim();
    if (value.length === 0) return;
    this.custom.set(null);
    void this.put({ routes: { [cls as LlmClass]: value } });
  }

  /**
   * Save or Remove on an account card — one PUT, and the page redraws from its
   * answer.
   *
   * THE MODEL IS IGNORED HERE and the child is not asked for one
   * (`wantsModel` is false): the model is chosen on the job rows, where the
   * question is "what runs translation" rather than "what is this key for". The
   * wizard asks the same child for both, because its one press has to configure
   * and route together (PHASE15 §5.2).
   */
  protected applyUpstream(event: UpstreamApply): void {
    if (event.upstreams === undefined || Object.keys(event.upstreams).length === 0) return;
    void this.put({ upstreams: event.upstreams });
  }

  /**
   * ONE WRITE, AND THE ANSWER REPLACES WHAT IS ON SCREEN.
   *
   * §3.2: the PUT's response is the whole document after the write, so nothing
   * here merges. The CAPABILITY is re-read beside it, because a write changes
   * it — a class whose selection moved to something that does not fit becomes a
   * class the engine will not serve, and the PUT answers with the settings
   * document alone. Without that read the subtitle and the reason line would
   * describe the previous choice.
   *
   * A REFUSAL RE-READS RATHER THAN LEAVING THE PAGE AS IT WAS. A refusal
   * applies nothing, so the engine still holds what it held — but the chips are
   * now showing the value the person pressed, which it rejected, and re-reading
   * is what puts the control back in step with the machine.
   */
  private async put(patch: SettingsPatch): Promise<void> {
    if (!api || this.chosen().length === 0 || this.working()) return;
    this.working.set(true);
    try {
      this.doc.set(await api.crucible.engineSettingsPut(this.chosen(), patch));
      this.capability.set(await api.crucible.engineCapability(this.chosen()));
      this.problem.set(null);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
      await this.read();
    } finally {
      this.working.set(false);
    }
  }

  /**
   * ONE PRESS, ONE PULL. Every fetch is gone while any pull on this engine is
   * running — one machine, one disk, one network, and two concurrent
   * multi-gigabyte fetches onto one card is not a thing to make easy.
   *
   * A REFUSAL TO START is drawn on this page's own problem line rather than
   * invented into a progress frame: nothing was fetched, so there is no pull to
   * report the state of.
   */
  private async fetch(id: string): Promise<void> {
    if (!api || this.pulling()) return;
    try {
      await api.crucible.pull(this.chosen(), 'model', id);
      this.problem.set(null);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async upgradeWindows(): Promise<void> {
    if (!api) return;
    this.working.set(true);
    this.problem.set(null);
    try {
      await api.crucible.upgradeWindowsEngine(this.chosen());
      await this.read();
    } catch (error) {
      this.problem.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.working.set(false);
    }
  }

  /**
   * What the engine is, under the rows — and in host mode that is the whole
   * story of why every local chip says nothing fits.
   *
   * PHASE15 §3.5: a `backend_kind` of `none` is a Windows machine with no WSL2,
   * which has no accelerator at all; the four text classes are the only work it
   * can do, and they can only be done upstream.
   */
  protected backendLine(settings: SettingsDocument): string {
    const allowance = Math.round(settings.desktopAllowanceBytes / 1e8) / 10;
    if (settings.backendKind === 'none') {
      return 'This engine has no accelerator (host mode), so the work above runs on an account or not at all.';
    }
    return `Engine backend: ${settings.backendKind}. It leaves ${allowance} GB of its card to the desktop.`;
  }
}
