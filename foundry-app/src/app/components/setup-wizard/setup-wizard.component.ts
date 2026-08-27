/**
 * setup-wizard — the screen a person meets the first time foundry is opened.
 *
 * ── WHAT IT IS FOR, IN ONE SENTENCE ─────────────────────────────────────────
 *
 * Foundry needs four things that do not arrive with the application — a folder
 * to keep books in, ollama, a language model small enough for THIS computer,
 * and one or two prebuilt Pythons — and until this screen existed, a new
 * installation discovered each of them by failing at it. The wizard asks for
 * them in the order they are needed, says what each one costs before fetching
 * a byte of it, and lets every single one be skipped.
 *
 * ── IT IS A FLOW, NOT A QUESTION, AND THAT DECIDES THREE THINGS ─────────────
 *
 * `UiService.dialogs` is the one-modal list, and this is deliberately not on
 * it (see `setupOpen` there). A modal is a question with an answer; this is
 * five steps, most of which START WORK THAT OUTLIVES THE STEP — an env install
 * goes into the queue and finishes whether or not this screen is looking, and
 * an ollama pull is happening in ollama's process and would finish if the whole
 * app were closed. So:
 *
 *   * it does not go through `only()`, which would let any dialog opened over
 *     it clear the boolean and take a half-finished setup off the screen;
 *   * it is MOUNTED UNCONDITIONALLY by the shell and holds its own `@if`,
 *     because an `@if` around this component is a DESTROY, and destroying it
 *     mid-install would drop the progress subscriptions that are the only
 *     thing telling somebody their download is alive;
 *   * closing it is never a failure. `setup:finish` is called on the way out
 *     however it is left, and what was skipped is written down.
 *
 * ── NOTHING DOWNLOADS BECAUSE YOU ARRIVED SOMEWHERE ─────────────────────────
 *
 * Every step that costs bytes has a button, and the button is the permission.
 * Arriving at the ollama step probes (a request to localhost), arriving at the
 * environments step reads the catalog (a directory check) — neither of those
 * spends anything of the user's. The moment something is going to be fetched,
 * the size is on screen next to the button that fetches it.
 *
 * ── NEVER WHEN HOSTED ───────────────────────────────────────────────────────
 *
 * Inside BookForge the library folder is the host's (docs/BOOKFORGE-HANDOFF.md
 * §8), the environments are provisioned by the host's own component manager,
 * and `library:set` refuses outright. A first-run wizard there would be five
 * steps of asking for things somebody else already decided.
 */
import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';

import type {
  EnvCatalogItem,
  EnvInstallProgress,
  EnvTarget,
  Job,
  LlmChoices,
  LlmModelOption,
  OllamaPullProgress,
} from '@shared/types';
import { QueueService } from '../../core/queue.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

type StepId = 'welcome' | 'library' | 'ollama' | 'envs' | 'reading' | 'done';

interface StepDef {
  id: StepId;
  /** The dot's tooltip and the card's heading. */
  title: string;
  /** One sentence under the heading saying what this step is about. */
  blurb: string;
}

/**
 * The order, and the only place it is written down.
 *
 * Library first because it is free and it is the one answer everything else
 * lands beside. Ollama before the environments because it is the step most
 * likely to send somebody out of the app into another installer, and coming
 * back to a screen that is already downloading Pythons is better than coming
 * back to one that has been waiting.
 */
const STEPS: readonly StepDef[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    blurb: 'Four things to set up. Each one can be skipped, and each one can be done later from Settings.',
  },
  {
    id: 'library',
    title: 'Your library',
    blurb: 'Where finished books live. A folder you can open, back up and sync — not somewhere hidden.',
  },
  {
    id: 'ollama',
    title: 'Ollama and a model',
    blurb: 'Translation, simplification and analysis all speak to ollama. This machine gets the largest model that fits it.',
  },
  {
    id: 'envs',
    title: 'Python environments',
    blurb: 'Prebuilt, hash-checked, and the exact versions foundry was measured with.',
  },
  {
    id: 'reading',
    title: 'The reading model',
    blurb: 'What actually reads the pages, and where its weights come from.',
  },
  {
    id: 'done',
    title: 'Ready',
    blurb: 'Everything here stays changeable in Settings.',
  },
];

@Component({
  selector: 'app-setup-wizard',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (up()) {
      <div class="scrim"></div>
      <div class="card" role="dialog" aria-modal="true" aria-label="First-run setup">
        <!-- ── The rail of dots ────────────────────────────────────────── -->
        <div class="rail">
          @for (step of steps; track step.id) {
            <span
              class="dot"
              [class.here]="step.id === current()"
              [class.past]="indexOf(step.id) < index()"
              [title]="step.title"
            ></span>
          }
          <span class="spacer"></span>
          <button class="shut" type="button" title="Close setup (everything here is in Settings)" (click)="dismiss()">✕</button>
        </div>

        <div class="head">
          <h2 class="title">{{ def().title }}</h2>
          <p class="blurb">{{ def().blurb }}</p>
        </div>

        <div class="body">
          <!-- ── Welcome ─────────────────────────────────────────────────── -->
          @if (current() === 'welcome') {
            <p class="lead">
              Foundry turns a scanned or PDF book into text you can read, translate, simplify and
              search for claims. Most of that work happens on this computer, which is why there is
              anything to set up at all.
            </p>
            <p class="line">
              Nothing on the next screens downloads until you press the button that downloads it,
              and the size is always beside the button.
            </p>
            @if (profileSaid(); as said) {
              <p class="machine">{{ said }}</p>
            }
          }

          <!-- ── Library ─────────────────────────────────────────────────── -->
          @if (current() === 'library') {
            <p class="line">
              Every conversion lands under this folder, and the Save dialogs open on it. Changing it
              later affects new work only — nothing is moved behind your back.
            </p>
            <div class="field">
              <span class="label">Library folder</span>
              <div class="row">
                <span class="path mono">{{ libraryDir() || 'Reading…' }}</span>
                <button class="ghost" type="button" (click)="pickLibrary()">Choose…</button>
              </div>
            </div>
          }

          <!-- ── Ollama ──────────────────────────────────────────────────── -->
          @if (current() === 'ollama') {
            @if (choices(); as facts) {
              <div class="state" [attr.data-ok]="facts.ollama.running">
                <span class="dotstate" [attr.data-ok]="facts.ollama.running"></span>
                <span>{{ facts.ollama.detail }}</span>
              </div>

              @if (!facts.ollama.running) {
                <p class="line">
                  Foundry does not install or manage ollama — this fetches its official installer and
                  opens it, so you land in ollama's own setup screen. Come back here and press Check
                  again when it has finished.
                </p>
                <div class="actions">
                  <button class="primary" type="button" [disabled]="busy()" (click)="getOllama()">
                    Download the ollama installer
                  </button>
                  <button class="ghost" type="button" [disabled]="busy()" (click)="reprobe()">Check again</button>
                </div>
              } @else {
                <p class="machine">{{ facts.profile.detail }}</p>
                <div class="models">
                  @for (option of facts.options; track option.tag) {
                    <button
                      class="model"
                      type="button"
                      [class.picked]="option.tag === chosen()"
                      [class.unfit]="!option.fits"
                      (click)="chosen.set(option.tag)"
                    >
                      <span class="model-head">
                        <span class="model-name">{{ option.label }}</span>
                        @if (option.recommended) { <span class="badge">Recommended</span> }
                        @if (option.installed) { <span class="badge held">Already here</span> }
                        @if (!option.fits) { <span class="badge warn-badge">Bigger than this machine</span> }
                      </span>
                      <span class="model-meta">
                        {{ option.downloadGB }} GB download · wants about {{ option.needsGB }} GB of
                        {{ memoryWord(facts) }} · {{ option.description }}
                      </span>
                      @if (!option.fits) {
                        <span class="model-warn">{{ unfitSays(facts) }}</span>
                      }
                    </button>
                  }
                </div>

                <div class="actions">
                  @if (chosenOption(); as pick) {
                    @if (pick.installed) {
                      <button class="primary" type="button" [disabled]="busy()" (click)="useModel()">
                        Use {{ pick.tag }}
                      </button>
                    } @else {
                      <button class="primary" type="button" [disabled]="busy()" (click)="pullModel()">
                        Download {{ pick.tag }} ({{ pick.downloadGB }} GB) and use it
                      </button>
                    }
                  }
                  @if (busy()) {
                    <button class="ghost" type="button" (click)="cancelOllama()">Cancel</button>
                  }
                </div>
              }

              @if (ollamaSaid(); as progress) {
                @if (progress.phase === 'download') {
                  <div class="bar"><div class="fill" [style.width.%]="progress.percent"></div></div>
                }
                <p class="small" [class.bad]="progress.phase === 'error'">{{ progress.detail }}</p>
              }
              @if (modelSaid()) { <p class="ok-note">{{ modelSaid() }}</p> }
            } @else {
              <p class="line">Asking ollama…</p>
            }
          }

          <!-- ── Python environments ─────────────────────────────────────── -->
          @if (current() === 'envs') {
            <p class="line">
              These are complete Pythons with the exact package versions foundry was measured
              against, downloaded from foundry's own release and checked against a hash before
              anything is unpacked.
            </p>
            @for (item of envItems(); track item.target) {
              <div class="env">
                <div class="env-head">
                  <span class="dotstate" [attr.data-ok]="item.installedPath !== null"></span>
                  <span class="env-title">{{ item.label }}</span>
                  @if (!item.published) { <span class="badge warn-badge">not yet published</span> }
                  @else if (item.installedPath !== null) { <span class="badge held">installed</span> }
                </div>
                <p class="small">{{ item.purpose }}</p>
                <p class="small mono">{{ item.pythonVersion }} · {{ item.packages.join(', ') }}</p>
                @if (envJob(item.target); as job) {
                  @if (job.state === 'running' || job.state === 'queued') {
                    <div class="bar" [class.indeterminate]="!envCounting(item.target)">
                      <div class="fill" [style.width.%]="envPercent(item.target)"></div>
                    </div>
                    <p class="small">{{ envWord(item.target, job) }} — {{ job.message }}</p>
                  } @else if (job.state === 'failed') {
                    <p class="small bad">{{ job.message }}</p>
                  } @else {
                    <p class="small">{{ job.message }}</p>
                  }
                }
                @if (item.installedPath === null && item.published) {
                  <div class="actions">
                    <button class="ghost" type="button" [disabled]="envBusy()" (click)="installEnv(item)">
                      Download {{ sizeOf(item) }} and install
                    </button>
                  </div>
                }
                @if (!item.published) {
                  <p class="small">This one has not been published yet, so there is no hash to check a download against. It is not offered.</p>
                }
              </div>
            }
            @if (envItems().length === 0) {
              <p class="line">Nothing on this platform needs a prebuilt Python.</p>
            }
          }

          <!-- ── The reading model ───────────────────────────────────────── -->
          @if (current() === 'reading') {
            <p class="lead">
              The model that reads pages is dots.ocr, and foundry does not host it. It is pulled
              from Hugging Face by whatever is doing the reading — the vLLM server on Windows, or
              mlx-vlm on a Mac — the first time you read a book.
            </p>
            <p class="line">
              That first read therefore pays about six gigabytes before it starts, once, and every
              read after it is offline. There is no separate download to approve here because there
              is no second way to get those weights: they arrive through the reader itself.
            </p>
            <p class="line">
              The analysis model is different and is already handled: its weights are inside the
              analysis worker environment on the previous step, so the first analysis is offline.
            </p>
            @if (canWarm()) {
              <p class="line">
                The reading server is installed on this machine, so that download can be got out of
                the way now instead of at the start of your first book.
              </p>
              <div class="actions">
                <button class="ghost" type="button" [disabled]="warming()" (click)="warmReader()">
                  Start the reading server and fetch the weights
                </button>
              </div>
            }
            @if (readingSaid()) { <p class="small">{{ readingSaid() }}</p> }
          }

          <!-- ── Done ────────────────────────────────────────────────────── -->
          @if (current() === 'done') {
            <p class="lead">That is everything foundry needs to be asked for.</p>
            @if (skipped().length > 0) {
              <p class="line">
                Skipped: {{ skippedTitles() }}. Settings has a button that opens this again, and
                each of those steps has its own card there.
              </p>
            } @else {
              <p class="line">Nothing was skipped. Settings holds all of it if you want to change something.</p>
            }
            <p class="line">Open a PDF or a folder of photographs from Home to start a book.</p>
          }
        </div>

        <!-- ── The feet ────────────────────────────────────────────────── -->
        <div class="foot">
          @if (index() > 0 && current() !== 'done') {
            <button class="ghost" type="button" (click)="back()">Back</button>
          }
          <span class="spacer"></span>
          @if (current() === 'done') {
            <button class="primary" type="button" (click)="finish()">Start using Foundry</button>
          } @else {
            @if (skippable()) {
              <button class="ghost" type="button" (click)="skip()">Skip this</button>
            }
            <button class="primary" type="button" (click)="next()">Next</button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    /*
     * THE HOST IS INERT AND ONLY ITS CHILDREN ARE NOT — the same argument the
     * confirm dialog makes, and for the same reason: this component is mounted
     * for the whole life of the window (an @if around it would be a DESTROY,
     * and destroying it mid-install drops the progress subscriptions), so a
     * fixed, full-window host is a sheet of glass over the entire application
     * at all times unless it is told not to take the pointer.
     *
     * 1250 is the capture-progress rung: above every dialog, because on first
     * run there is nothing behind this worth clicking, and below the confirm
     * card at 1300 so a question asked BY this screen lands on top of it.
     */
    :host {
      position: fixed;
      inset: 0;
      z-index: 1250;
      display: grid;
      place-items: center;
      pointer-events: none;
    }

    .scrim {
      position: absolute;
      inset: 0;
      pointer-events: auto;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      animation: fade 120ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

    .card {
      position: relative;
      pointer-events: auto;
      width: min(680px, calc(100vw - 48px));
      max-height: calc(100vh - 64px);
      display: flex;
      flex-direction: column;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.45);
      animation: rise 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    @keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

    .rail {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 12px 14px 0;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--border-default);
      transition: background-color 140ms cubic-bezier(0, 0, 0.2, 1);
    }
    .dot.past { background: var(--accent-strong); }
    .dot.here { background: var(--accent); transform: scale(1.35); }
    .spacer { flex: 1; }
    .shut {
      background: none;
      border: none;
      color: var(--text-tertiary);
      font-size: 13px;
      line-height: 1;
      padding: 2px 4px;
      cursor: pointer;
    }
    .shut:hover { color: var(--text-primary); }

    .head { padding: 8px 20px 4px; }
    .title { margin: 0; font-family: var(--font-display); font-size: 17px; font-weight: 600; }
    .blurb { margin: 4px 0 0; font-size: 12px; color: var(--text-tertiary); }

    .body {
      padding: 12px 20px 8px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .lead { margin: 0; font-size: 13px; line-height: 1.55; color: var(--text-primary); }
    .line { margin: 0; font-size: 13px; line-height: 1.55; color: var(--text-secondary); }
    .small { margin: 0; font-size: 11px; color: var(--text-tertiary); word-break: break-word; }
    .small.bad, .bad { color: var(--error); }
    .ok-note { margin: 0; font-size: 12px; color: var(--ok); }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .machine {
      margin: 0;
      font-size: 12px;
      color: var(--text-secondary);
      background: var(--bg-sunken);
      border-radius: var(--radius-sm);
      padding: 8px 10px;
    }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-tertiary);
    }
    .row { display: flex; align-items: center; gap: 8px; }
    .path {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 6px 8px;
    }

    .state {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 13px;
      color: var(--text-secondary);
    }
    .dotstate {
      width: 8px;
      height: 8px;
      margin-top: 5px;
      border-radius: 50%;
      background: var(--text-tertiary);
      flex-shrink: 0;
    }
    .dotstate[data-ok="true"] { background: var(--ok); }

    .models { display: flex; flex-direction: column; gap: 6px; }
    .model {
      display: flex;
      flex-direction: column;
      gap: 3px;
      align-items: flex-start;
      text-align: left;
      width: 100%;
      padding: 8px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  background-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .model:hover { background: var(--bg-hover); border-color: var(--border-default); }
    .model.picked { border-color: var(--accent); background: var(--accent-faint); }
    .model.unfit .model-name { color: var(--text-secondary); }
    .model-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .model-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .model-meta { font-size: 11px; color: var(--text-tertiary); }
    .model-warn { font-size: 11px; color: var(--warn); }

    .badge {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--accent);
      background: var(--accent-soft);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .badge.held { color: var(--ok); background: var(--ok-soft); }
    .badge.warn-badge { color: var(--warn); background: var(--warn-soft); }

    .env {
      display: flex;
      flex-direction: column;
      gap: 5px;
      padding: 10px;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }
    .env-head { display: flex; align-items: center; gap: 8px; }
    .env-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; }

    .bar { height: 4px; background: var(--bg-sunken); border-radius: 2px; overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
    /* No honest percentage outside a download — the bar says so rather than
       inventing a number to keep itself moving. See env-install.ts. */
    .bar.indeterminate .fill { width: 35% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    .foot {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px 16px;
      border-top: 1px solid var(--border-subtle);
    }

    .primary, .ghost {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 32px;
      padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px;
      font-weight: 500;
      line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent);
      color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
})
export class SetupWizardComponent {
  private readonly ui = inject(UiService);
  private readonly queue = inject(QueueService);

  protected readonly steps = STEPS;
  protected readonly current = signal<StepId>('welcome');
  protected readonly libraryDir = signal('');
  protected readonly choices = signal<LlmChoices | null>(null);
  protected readonly chosen = signal('');
  protected readonly busy = signal(false);
  protected readonly ollamaSaid = signal<OllamaPullProgress | null>(null);
  protected readonly modelSaid = signal('');
  protected readonly envItems = signal<EnvCatalogItem[]>([]);
  protected readonly readingSaid = signal('');
  protected readonly warming = signal(false);
  protected readonly profileSaid = signal('');

  /** Step ids moved past without doing the thing. A Set would not survive JSON. */
  protected readonly skipped = signal<string[]>([]);

  private readonly live = signal<Record<string, EnvInstallProgress>>({});

  protected readonly up = computed(() => this.ui.setupOpen());
  protected readonly index = computed(() => this.indexOf(this.current()));
  protected readonly def = computed(() => STEPS[this.index()] ?? STEPS[0]!);
  protected readonly chosenOption = computed<LlmModelOption | null>(() =>
    this.choices()?.options.find((option) => option.tag === this.chosen()) ?? null);

  private readonly envJobs = computed(() =>
    this.queue.jobs().filter((job) => job.kind === 'env-install'));
  protected readonly envBusy = computed(() =>
    this.envJobs().some((job) => job.state === 'running' || job.state === 'queued'));

  /**
   * Welcome and Ready are not skippable because there is nothing on them to
   * skip — a Skip button beside a paragraph is a button that means nothing, and
   * a step id in the skipped list that names a page of prose would make the
   * settings screen say something false.
   */
  protected readonly skippable = computed(() => {
    const here = this.current();
    return here !== 'welcome' && here !== 'done';
  });

  constructor() {
    if (!api) return;

    api.env.onInstallProgress((progress) => {
      this.live.update((all) => ({ ...all, [progress.target]: progress }));
    });
    api.ollama.onProgress((progress) => {
      this.ollamaSaid.set(progress);
      if (progress.phase === 'done' || progress.phase === 'error') this.busy.set(false);
    });

    /*
     * ── OPENED ONCE, BY MAIN'S ANSWER, AND NEVER BY THE ABSENCE OF A FILE ────
     *
     * `setup:state` reads an explicit marker rather than testing whether
     * app-settings.json exists: that file is written the first time anybody
     * changes the library folder or adds an analysis category, so on the
     * machine where somebody poked at Settings before setup ever ran, "no
     * file" is already false and this screen would never appear.
     */
    /*
     * ASKED DIRECTLY, NOT READ OFF THE `hosted` SIGNAL. That signal is filled
     * in by a promise `core/foundry.ts` starts at module load, so in this
     * constructor it is still false on a hosted window — and losing that race
     * would open a five-step wizard inside BookForge asking for a library
     * folder somebody else owns. Both answers are awaited together, so the
     * decision is made when both are actually known.
     */
    void Promise.all([api.hosted(), api.setup.state()]).then(([inHost, state]) => {
      if (inHost || state.completed) return;
      this.skipped.set([...state.skipped]);
      this.ui.openSetup();
    });

    // Each step loads only what it can read for free. Nothing here fetches.
    effect(() => {
      if (!this.up()) return;
      const here = this.current();
      if (here === 'welcome') void this.loadProfile();
      if (here === 'library') void this.loadLibrary();
      if (here === 'ollama') void this.loadChoices();
      if (here === 'envs') void this.loadEnvs();
    });

    // An env install that lands is a card that should stop saying "not
    // installed" — the queue adjudicates, the event only animates.
    let settled = 0;
    effect(() => {
      const finished = this.envJobs().filter((job) => job.state === 'done').length;
      if (finished > settled) {
        settled = finished;
        void this.loadEnvs();
      }
    });
  }

  // ── Reading what is free to read ───────────────────────────────────────────

  private async loadProfile(): Promise<void> {
    if (!api) return;
    const profile = await api.setup.probe();
    this.profileSaid.set(profile.detail);
  }

  private async loadLibrary(): Promise<void> {
    if (!api) return;
    this.libraryDir.set(await api.library.dir());
  }

  private async loadChoices(): Promise<void> {
    if (!api) return;
    const facts = await api.ollama.choices();
    this.choices.set(facts);
    if (this.chosen().length === 0) this.chosen.set(facts.suggested);
  }

  private async loadEnvs(): Promise<void> {
    if (!api) return;
    this.envItems.set(await api.env.catalog());
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  protected indexOf(id: StepId): number {
    return STEPS.findIndex((step) => step.id === id);
  }

  protected next(): void {
    const at = this.index();
    const nextStep = STEPS[at + 1];
    if (nextStep) this.current.set(nextStep.id);
  }

  protected back(): void {
    const previous = STEPS[this.index() - 1];
    if (previous) this.current.set(previous.id);
  }

  protected skip(): void {
    const here = this.current();
    this.skipped.update((all) => (all.includes(here) ? all : [...all, here]));
    this.next();
  }

  protected skippedTitles(): string {
    const names = this.skipped()
      .map((id) => STEPS.find((step) => step.id === id)?.title ?? id);
    return names.join(', ');
  }

  /**
   * Leaving by the ✕ is a completed setup, not an abandoned one.
   *
   * Every step past this one is recorded as skipped, because that is what
   * happened — and the settings screen naming them is the whole reason the list
   * is kept. Coming back is one button there.
   */
  protected async dismiss(): Promise<void> {
    const from = this.index();
    const rest = STEPS.slice(from)
      .filter((step) => step.id !== 'welcome' && step.id !== 'done')
      .map((step) => step.id);
    const all = [...new Set([...this.skipped(), ...rest])];
    this.skipped.set(all);
    await this.close(all);
  }

  protected async finish(): Promise<void> {
    await this.close(this.skipped());
  }

  private async close(skipped: string[]): Promise<void> {
    await api?.setup.finish(skipped);
    this.ui.closeSetup();
  }

  // ── Library ───────────────────────────────────────────────────────────────

  protected async pickLibrary(): Promise<void> {
    if (!api) return;
    const chosen = await api.library.choose(this.libraryDir());
    if (chosen === null) return;
    // Main's value wins: it clamps, and a renderer holding an optimistic copy
    // would show a folder nothing writes to.
    this.libraryDir.set(await api.library.set(chosen));
  }

  // ── Ollama ────────────────────────────────────────────────────────────────

  protected memoryWord(facts: LlmChoices): string {
    switch (facts.profile.memoryBasis) {
      case 'vram': return 'video memory';
      case 'unified': return 'unified memory';
      case 'ram': return 'system memory';
    }
  }

  protected unfitSays(facts: LlmChoices): string {
    return facts.profile.memoryBasis === 'ram'
      ? 'There is no GPU here, so anything at all runs on the processor — expect minutes per page rather than seconds. You can still choose it.'
      : 'It will spill onto the processor and run several times slower, or refuse to load. You can still choose it.';
  }

  protected async reprobe(): Promise<void> {
    this.ollamaSaid.set(null);
    await this.loadChoices();
  }

  protected async getOllama(): Promise<void> {
    if (!api) return;
    this.busy.set(true);
    this.modelSaid.set('');
    const result = await api.ollama.install();
    this.busy.set(false);
    this.ollamaSaid.set({
      tag: 'ollama',
      phase: result.ok ? 'done' : 'error',
      percent: result.ok ? 100 : 0,
      detail: result.detail,
    });
  }

  protected cancelOllama(): void {
    void api?.ollama.cancelInstall();
    void api?.ollama.cancelPull();
    this.busy.set(false);
  }

  protected async pullModel(): Promise<void> {
    const pick = this.chosenOption();
    if (!api || !pick) return;
    this.busy.set(true);
    this.modelSaid.set('');
    const result = await api.ollama.pull(pick.tag);
    this.busy.set(false);
    if (result.ok) {
      await this.useModel();
      await this.loadChoices();
    }
  }

  protected async useModel(): Promise<void> {
    const pick = this.chosenOption();
    if (!api || !pick) return;
    const stored = await api.llm.setModel(pick.tag);
    this.modelSaid.set(`Translation, simplification and analysis will start from ${stored}.`);
  }

  // ── Environments ──────────────────────────────────────────────────────────

  protected sizeOf(item: EnvCatalogItem): string {
    if (item.bytes === null) return 'it';
    const gb = item.bytes / 1e9;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(item.bytes / 1e6)} MB`;
  }

  protected envJob(target: EnvTarget): Job | null {
    const mine = this.envJobs().filter((job) => job.inputPath === target);
    return mine[mine.length - 1] ?? null;
  }

  protected envCounting(target: EnvTarget): boolean {
    return this.live()[target]?.phase === 'download';
  }

  protected envPercent(target: EnvTarget): number {
    return this.live()[target]?.percent ?? 0;
  }

  protected envWord(target: EnvTarget, job: Job): string {
    const phase = this.live()[target]?.phase ?? job.envProgress?.phase;
    switch (phase) {
      case 'download': return `Downloading ${this.envPercent(target)}%`;
      case 'verify': return 'Checking the hash';
      case 'unpack': return 'Unpacking';
      case 'configure': return 'Configuring';
      default: return job.state === 'queued' ? 'Waiting for the queue' : 'Starting…';
    }
  }

  protected async installEnv(item: EnvCatalogItem): Promise<void> {
    if (!api || !item.published) return;
    this.live.update((all) => {
      const next = { ...all };
      delete next[item.target];
      return next;
    });
    await api.env.install({ target: item.target });
  }

  // ── The reading model ─────────────────────────────────────────────────────

  /**
   * Only where there is a server this app can start.
   *
   * On a Mac the reading happens in-process through mlx-vlm, and there is no
   * door here that would pull those weights without also reading a book — so
   * the step is disclosure and nothing else, which is the honest shape rather
   * than a button that pretends.
   */
  protected canWarm(): boolean {
    if (!api || api.platform !== 'win32') return false;
    return this.envItems().some((item) => item.target === 'wsl-x64' && item.installedPath !== null);
  }

  protected async warmReader(): Promise<void> {
    if (!api) return;
    this.warming.set(true);
    this.readingSaid.set('Starting the reading server. The first start downloads the weights, which takes a while — you can leave this screen.');
    try {
      const status = await api.vllmServer.start();
      this.readingSaid.set(status.state === 'ready'
        ? 'The reading server is up and the weights are on this machine.'
        : status.detail);
    } catch (err) {
      this.readingSaid.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.warming.set(false);
    }
  }
}
