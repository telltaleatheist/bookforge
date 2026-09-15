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
 * ── AND ONE STEP THAT IS NOT A NEED AT ALL ──────────────────────────────────
 *
 * Crucible (Wave 61 package E, docs/SLOTS.md) sits after Ollama and offers three
 * doors — connect to one elsewhere, use one already on this machine, install one
 * here. Owen: *"foundry should work if they have no idea what theyre doing and
 * they just want to convert PDFs to EPUB. but if they do know what theyre doing
 * and they want access to speed, they can use crucible."* So it is the one step
 * whose blurb says outright that most people should walk past it, the Ollama
 * step before it is untouched and remains the beginner's path, and the doors
 * themselves are a child component (`app-crucible-doors`) shared with the
 * Settings card so the two screens cannot offer different choices.
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

import type { CrucibleCoordinationMap } from '@shared/coordinate-wire';
import type { CrucibleServerView } from '@shared/slots';
import type {
  EnvCatalogItem,
  EnvInstallProgress,
  EnvTarget,
  Job,
  LlmChoices,
  LlmModelOption,
  OllamaPullProgress,
  PageReaderProgress,
  PageReaderState,
} from '@shared/types';
import {
  LLM_CLASSES,
  defaultEngineServer,
  type CapabilityRecord,
  type LlmClass,
  type SettingsDocument,
  type SettingsPatch,
} from '@shared/engine-settings';
import { CrucibleDoorsComponent } from '../crucible-doors/crucible-doors.component';
import { coordinationWords } from '../../core/crucible-words';
import {
  EngineUpstreamsComponent,
  type UpstreamApply,
} from '../engine-upstreams/engine-upstreams.component';
import { QueueService } from '../../core/queue.service';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

type StepId =
  | 'welcome' | 'library' | 'ollama' | 'crucible' | 'routes' | 'envs' | 'reading' | 'done';

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
    blurb: 'The model this machine runs text on. It gets the largest that fits — and a card that cannot hold a 27B reaches translation another way.',
  },
  {
    /*
     * AFTER OLLAMA AND BEFORE THE ENVIRONMENTS. After, because the Ollama step
     * is what most people will use and a Crucible offered first would read as a
     * requirement. Before the environments, because it is a decision rather than
     * a download: somebody who connects to a Crucible here has changed what the
     * rest of setup means, and finding that out after paying for two Pythons
     * would be finding it out too late.
     */
    id: 'crucible',
    title: 'Crucible (optional)',
    blurb: 'Most people should skip this. It is how a second machine, or a faster path on this one, gets used.',
  },
  {
    /*
     * ── SHOWN ONLY WHEN THERE IS AN ENGINE TO ASK ────────────────────────
     *
     * crucible docs/PHASE15-HOST.md §5.2: the wizard's AI step reads the chosen
     * server's capability and, for each llm class that will not run on its card,
     * offers to run that class through an upstream instead. With no server
     * registered there is no capability to read and nothing to configure, so the
     * step is not drawn, not counted in the rail, and NOT recorded as skipped —
     * a settings screen saying somebody skipped a step that was never offered
     * would be saying something false (`dismiss`'s rule about the skipped list).
     *
     * IMMEDIATELY AFTER THE CRUCIBLE STEP, because that step is where the server
     * comes from: registering one there is what makes this one appear, and a
     * question about where translation runs asked before there is anywhere for
     * it to run is a question with no answers in it.
     */
    id: 'routes',
    title: 'Where the text work runs',
    blurb: 'What the engine cannot do on its own card, it can do through an account you connect here.',
  },
  {
    id: 'envs',
    title: 'Python environments',
    blurb: 'Prebuilt, hash-checked, and the exact versions foundry was measured with.',
  },
  {
    id: 'reading',
    title: 'The page reader',
    blurb: 'What actually reads the pages. On most machines this is the one download that matters.',
  },
  {
    id: 'done',
    title: 'Ready',
    blurb: 'Everything here stays changeable in Settings.',
  },
];

@Component({
  selector: 'app-setup-wizard',
  imports: [CrucibleDoorsComponent, EngineUpstreamsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (up()) {
      <div class="scrim"></div>
      <div class="card" role="dialog" aria-modal="true" aria-label="First-run setup">
        <!-- ── The rail of dots ────────────────────────────────────────── -->
        <div class="rail">
          @for (step of visible(); track step.id) {
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
                <!--
                  THE ONE THING THIS SCREEN MUST NOT PROMISE. Owen's floor
                  (docs/SLOTS.md §1): translation and simplification need a 27B,
                  or a Crucible, or a cloud key. On a smaller card no amount of
                  pulling makes them work, so it is said BEFORE the download
                  rather than discovered afterwards as a dark tile. The
                  narration cleanup and the analysis still run here, which is
                  why the step is not skipped — it is narrowed.
                -->
                @if (facts.translateFloorMiss; as miss) {
                  <p class="warn">
                    Translation and simplification need {{ miss.needs }} or larger, which wants
                    {{ miss.needsGB }} GB — more than this machine has. The models below still
                    clean text for the narrator and run analysis. For translation, connect a
                    Crucible server or a cloud provider in Settings.
                  </p>
                }
                <!--
                  docs/SLOTS.md §5b: the app never pulls into Ollama while a
                  LOCAL Crucible serves the class. Said in the rows rather than
                  by hiding them — the list's job is to describe this machine,
                  and a list that silently shortened itself would describe a
                  different one. The download buttons are off; choosing a row
                  still works, because the tag it writes is what a job uses if
                  that server is later switched off.
                -->
                @if (facts.crucible; as taken) {
                  <p class="ok-note">
                    The Crucible on this machine ({{ taken.server }}) already serves
                    {{ taken.classes.join(', ') }} here, so Foundry will not pull a second copy of
                    these models into Ollama.
                  </p>
                }
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
                      <button class="primary" type="button"
                              [disabled]="busy() || facts.crucible !== null"
                              (click)="pullModel()">
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

          <!-- ── Crucible ────────────────────────────────────────────────── -->
          @if (current() === 'crucible') {
            <p class="lead">
              Crucible is a separate program that serves models over the network — on this
              machine or on another one. Foundry does not need it: everything on the last
              screen works without it, and this step can be skipped for good.
            </p>
            <p class="line">
              What it buys is speed and reach. A Crucible on a machine with a bigger card runs
              the translation there; a Crucible on this machine replaces the local GPU slot with
              one that holds its models properly instead of loading and unloading per job.
            </p>
            @if (crucibleServers().length > 0) {
              <p class="ok-note">
                Already registered: {{ crucibleNames() }}. Settings › Servers is where these are
                ranked and switched off.
              </p>
              <!--
                AND WHAT FOUNDRY HAS ALREADY SAID TO EACH OF THEM.
                crucible docs/PHASE14-ENVPACKS.md §4a: finding an engine is the
                request, so this step offers nothing to press about it — it says
                what is happening. One line per REGISTERED server, and a server
                nothing has asked about yet draws none, because "idle" written
                out is a screen announcing the absence of news.
              -->
              @for (server of crucibleServers(); track server.name) {
                @if (coordinationOf(server.name); as said) {
                  <p class="small">{{ server.name }} — {{ said }}</p>
                }
              }
            }
            <app-crucible-doors (changed)="loadCrucible()" />
          }

          <!-- ── Where the text work runs ────────────────────────────────── -->
          @if (current() === 'routes') {
            <p class="lead">
              The GPU engine (Crucible) runs cleanup, translation, simplification and analysis.
              What it cannot run on its own card, it can run through an account you connect —
              the key is stored in the engine, not in Foundry, and BookForge uses the same one.
            </p>
            @if (routeProblem(); as why) { <p class="line bad">{{ why }}</p> }

            @if (routeDoc(); as settings) {
              @if (unservedClasses().length === 0) {
                <p class="ok-note">
                  This engine can run all four on its own card. Nothing to connect.
                </p>
                @for (cls of classes; track cls) {
                  <p class="small">{{ classLabel(cls) }} — {{ routeLine(cls) }}</p>
                }
              } @else {
                <p class="line">
                  These will not run on this engine's card. Its own words for why:
                </p>
                @for (row of unservedClasses(); track row.cls) {
                  <p class="small"><strong>{{ classLabel(row.cls) }}</strong> — {{ row.reason }}</p>
                }
                <p class="line">
                  Connect one account below and Test it; the models it lists are the ones your key
                  can use. Saving sets every class above to run there, in one go.
                </p>
                <app-engine-upstreams
                  [serverName]="routeServer()"
                  [doc]="settings"
                  [busy]="routeBusy()"
                  [wantsModel]="true"
                  applyLabel="Use it for these"
                  (apply)="applyRoutes($event)" />
              }
            } @else if (routeProblem() === null) {
              <p class="line">Asking the engine…</p>
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

          <!-- ── The page reader ─────────────────────────────────────────── -->
          @if (current() === 'reading') {
            @if (reader(); as it) {
              <p class="lead">
                The model that reads pages is dots.ocr. Every other thing foundry asks a model to do
                — translate, simplify, clean, analyse — goes to the ollama on the last step, but no
                ollama serves this one, so this is the one piece foundry fetches itself.
              </p>
              <p class="line">{{ it.platformNote }}</p>
              <p class="line">{{ it.detail }}</p>
              <p class="line">
                It is fetched once and kept. Every read after it is offline, and the analysis model
                is already handled — its weights are inside the analysis worker on the previous step.
              </p>
              @if (it.supported && !it.installed) {
                <div class="actions">
                  <button class="primary" type="button" [disabled]="warming()" (click)="getReader()">
                    @if (it.downloadBytes !== null) {
                      Download the page reader ({{ readerSize(it.downloadBytes) }})
                    } @else {
                      Download the page reader
                    }
                  </button>
                  @if (warming()) {
                    <button class="ghost" type="button" (click)="cancelReader()">Cancel</button>
                  }
                </div>
              }
              @if (readerSaid(); as progress) {
                @if (progress.phase === 'download') {
                  <div class="bar"><div class="fill" [style.width.%]="progress.percent"></div></div>
                }
                <p class="small" [class.bad]="progress.phase === 'error'">
                  {{ progress.item }} — {{ progress.detail }}
                </p>
              }
            } @else {
              <p class="lead">Looking at what this machine has…</p>
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

  protected readonly current = signal<StepId>('welcome');
  /** The four llm classes, in the order the routes step draws them. */
  protected readonly classes = LLM_CLASSES;
  protected readonly libraryDir = signal('');
  protected readonly choices = signal<LlmChoices | null>(null);
  protected readonly chosen = signal('');
  protected readonly busy = signal(false);
  protected readonly ollamaSaid = signal<OllamaPullProgress | null>(null);
  protected readonly modelSaid = signal('');
  protected readonly envItems = signal<EnvCatalogItem[]>([]);
  protected readonly readingSaid = signal('');
  protected readonly warming = signal(false);
  protected readonly reader = signal<PageReaderState | null>(null);
  protected readonly readerSaid = signal<PageReaderProgress | null>(null);
  protected readonly profileSaid = signal('');
  /** The registry, so the Crucible step can say what is already there. */
  protected readonly crucibleServers = signal<CrucibleServerView[]>([]);
  /**
   * And what Foundry has already said to each of them, by stored name.
   *
   * The same map the Servers card draws, from the same push, so the wizard and
   * Settings cannot tell one person two stories about one machine. Loaded AND
   * listened to: coordination starts at app start, before this wizard exists,
   * so a step that only listened would draw nothing about a server that was
   * already `stocked` when it opened.
   */
  protected readonly coordination = signal<CrucibleCoordinationMap>({});

  /*
   * ── The routes step's four facts (PHASE15-HOST.md §5.2) ──────────────────
   *
   * Which engine is being configured, its settings document, its capability
   * record, and whatever the last press was answered with. NONE OF IT IS
   * STORED: the document is the engine's and is re-read from every write's own
   * answer, which is the whole of what §5.2 means by *"there is no Save button
   * that writes an app file and syncs later"*.
   */
  protected readonly routeServer = signal('');
  protected readonly routeDoc = signal<SettingsDocument | null>(null);
  protected readonly routeCap = signal<CapabilityRecord | null>(null);
  protected readonly routeBusy = signal(false);
  protected readonly routeProblem = signal<string | null>(null);

  /**
   * THE CLASSES THIS ENGINE WILL NOT RUN ON ITS OWN CARD, with the server's own
   * sentence about each.
   *
   * §5.2: *"for each llm class that is `enabled: false` locally it says the
   * class's reason and offers 'run it through Anthropic / OpenAI / an Ollama
   * server instead'."* THE REASON IS THE SERVER'S and is printed verbatim —
   * replacing it with a word of ours is how a fixable problem ("2.1 GB short")
   * becomes an unfixable one ("not supported").
   *
   * A class already routed upstream is NOT here: §3.3 says such a row answers
   * `enabled: true`, so the engine itself has already stopped asking.
   */
  protected readonly unservedClasses = computed<{ cls: LlmClass; reason: string }[]>(() => {
    const record = this.routeCap();
    if (record === null) return [];
    return LLM_CLASSES.flatMap((cls) => {
      const row = record.classes.find((entry) => entry.capability === cls);
      if (row === undefined || row.enabled) return [];
      return [{ cls, reason: row.reason }];
    });
  });

  /** Step ids moved past without doing the thing. A Set would not survive JSON. */
  protected readonly skipped = signal<string[]>([]);

  private readonly live = signal<Record<string, EnvInstallProgress>>({});

  protected readonly up = computed(() => this.ui.setupOpen());
  /**
   * THE STEPS THIS RUN ACTUALLY HAS — the rail, the numbering and every walk.
   *
   * One step is conditional: `routes` needs a registered engine to draw a window
   * onto (crucible docs/PHASE15-HOST.md §5.2), so with an empty registry it is
   * not in the list at all. That is deliberately not the same as SKIPPING it —
   * a skipped step is one somebody was offered and moved past, and the Ready
   * screen names those out loud.
   *
   * IT CAN GROW MID-WIZARD, and that is right: registering a server on the
   * Crucible step is exactly what makes the question "where does translation
   * run" answerable, and the dot appearing is the wizard saying so. The registry
   * is read once when this screen opens, so a machine that already had a server
   * shows the dot from the first frame rather than discovering it three steps
   * in.
   */
  protected readonly visible = computed<readonly StepDef[]>(() => {
    const hasEngine = this.crucibleServers().length > 0;
    return STEPS.filter((step) => step.id !== 'routes' || hasEngine);
  });
  protected readonly index = computed(() => Math.max(0, this.indexOf(this.current())));
  protected readonly def = computed(() => this.visible()[this.index()] ?? STEPS[0]!);
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
    api.pageReader.onProgress((progress) => {
      this.readerSaid.set(progress);
      if (progress.phase === 'done' || progress.phase === 'error') {
        this.warming.set(false);
        void this.loadReader();
      }
    });
    /*
     * COORDINATION IS NOT SOMETHING THIS SCREEN STARTS, so it is only heard.
     * The sweep runs at app start on every enabled server (crucible
     * docs/PHASE14-ENVPACKS.md §4a), and somebody standing on this step while a
     * model downloads onto the Mac should watch it move rather than find out by
     * pressing Next twice.
     */
    api.crucible.onCoordination((state) => {
      this.coordination.update((all) => ({ ...all, [state.server]: state }));
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
      /*
       * THE REGISTRY IS READ BEFORE THE FIRST FRAME, not when the Crucible step
       * is reached, because the rail is drawn from it: `visible()` hides the
       * routes step while there is no engine, and a machine that ALREADY has a
       * server registered would otherwise show a rail that grew a dot three
       * steps in for no reason a person could see.
       */
      void this.loadCrucible();
      this.ui.openSetup();
    });

    // Each step loads only what it can read for free. Nothing here fetches.
    effect(() => {
      if (!this.up()) return;
      const here = this.current();
      if (here === 'welcome') void this.loadProfile();
      if (here === 'library') void this.loadLibrary();
      if (here === 'ollama') void this.loadChoices();
      if (here === 'crucible') void this.loadCrucible();
      if (here === 'routes') void this.loadRoutes();
      if (here === 'envs') void this.loadEnvs();
      if (here === 'reading') void this.loadReader();
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

  /**
   * The registry, for the Crucible step's "already registered" line.
   *
   * Re-read after any of the three doors writes one, because the line is the
   * only feedback the step gives that an Add landed — the door itself closes and
   * says nothing more, on the standing rule that main's answer is the truth and
   * a component holding its own copy of a list is the copy that goes stale.
   */
  protected async loadCrucible(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.crucibleServers.set(view.servers);
    this.coordination.set(await api.crucible.coordination());
    /*
     * AND THE OLLAMA STEP'S FACTS, because registering a local Crucible changes
     * them: a class it serves is a class this wizard must not pull a second copy
     * of into Ollama (docs/SLOTS.md §5b). Read here rather than on the way back
     * to that step, so somebody who presses Back finds the rows already saying
     * so instead of watching them change under the cursor.
     */
    if (this.choices() !== null) await this.loadChoices();
  }

  // ── Where the text work runs (PHASE15-HOST.md §5.2) ───────────────────────

  /**
   * BOTH ANSWERS, TOGETHER, because the step is one picture made of two.
   *
   * The CAPABILITY record says which classes this engine cannot serve locally
   * and WHY, in its own sentence; the settings document says where each class is
   * routed now and which upstreams are configured. Read one without the other
   * and the step either offers to fix something already fixed or shows a route
   * with no reason beside it.
   *
   * THE SERVER IS CHOSEN ONCE, by the same rule the settings card uses
   * (`defaultEngineServer`, shared/engine-settings.ts): the loopback engine
   * first, because it is the one whose routes decide what this computer does.
   */
  protected async loadRoutes(): Promise<void> {
    if (!api) return;
    const server = this.routeServer().length > 0
      ? this.routeServer()
      : defaultEngineServer(this.crucibleServers())?.name ?? '';
    this.routeServer.set(server);
    if (server.length === 0) return;
    this.routeBusy.set(true);
    try {
      const [document, capability] = await Promise.all([
        api.crucible.engineSettings(server),
        api.crucible.engineCapability(server),
      ]);
      this.routeDoc.set(document);
      this.routeCap.set(capability);
      this.routeProblem.set(null);
    } catch (err) {
      /*
       * BOTH GO, TOGETHER. The step's offer is composed from the two, and a
       * document kept beside a capability record that failed to re-read would
       * let the step say "this engine can run all four" on the strength of an
       * EMPTY list of unserved classes — which is the same sentence as "nothing
       * was measured", said as though it were good news.
       */
      this.routeDoc.set(null);
      this.routeCap.set(null);
      this.routeProblem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.routeBusy.set(false);
    }
  }

  /**
   * ONE PRESS, ONE PUT: the key AND every route it is meant to serve.
   *
   * §5.2: *"entering a key calls `test`, then one `PUT` that configures the
   * upstream AND sets the route, then capability is re-read and the step shows
   * the new answer."* §3.2 is what makes one request the RIGHT number: upstreams
   * are applied, then routes, then the whole is validated, and *"a refusal
   * applies nothing"*. Two requests would leave a key stored against routes that
   * were refused — a half-configured engine nobody asked for.
   *
   * IT ROUTES EVERY CLASS THE ENGINE SAID IT CANNOT SERVE, not the one the
   * person happened to be looking at. That is the step's whole offer: the rows
   * above it are the classes with no local answer, and a press that fixed one of
   * four would leave three rows saying the same thing with the same button under
   * them.
   */
  protected async applyRoutes(event: UpstreamApply): Promise<void> {
    const server = this.routeServer();
    if (!api || server.length === 0 || event.model === null) return;
    const classes = this.unservedClasses();
    if (classes.length === 0) return;
    const model = `${event.upstream}/${event.model}`;
    const patch: SettingsPatch = {
      ...(event.upstreams === undefined ? {} : { upstreams: event.upstreams }),
      routes: Object.fromEntries(classes.map((row) => [row.cls, model])),
    };
    this.routeBusy.set(true);
    try {
      this.routeDoc.set(await api.crucible.engineSettingsPut(server, patch));
      this.routeProblem.set(null);
      /*
       * AND CAPABILITY AGAIN, because §2 recomputes it in-process on every write
       * that touches a route and §3.3 puts the route in every row. The rows this
       * step draws come from THAT record, so the step showing the new answer is
       * this read and not a redraw of what was sent.
       */
      this.routeCap.set(await api.crucible.engineCapability(server));
    } catch (err) {
      this.routeProblem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.routeBusy.set(false);
    }
  }

  /** One class's row, in the words a person uses for it. */
  protected classLabel(cls: LlmClass): string {
    switch (cls) {
      case 'clean': return 'Cleanup';
      case 'translate': return 'Translation';
      case 'simplify': return 'Simplification';
      case 'analysis': return 'Analysis';
    }
  }

  /** Where a class runs right now, as one line under its name. */
  protected routeLine(cls: LlmClass): string {
    const row = this.routeDoc()?.routes[cls];
    if (row === undefined) return '';
    if (row.route === 'upstream' && row.model !== null) return `runs on ${row.model}`;
    return row.model === null ? 'runs here, if anything fits' : `runs here on ${row.model}`;
  }

  /** The registered servers, named, for the one line the step prints about them. */
  protected crucibleNames(): string {
    return this.crucibleServers().map((server) => server.name).join(', ');
  }

  /**
   * One engine's coordination sentence, or null when nothing has asked it yet.
   *
   * EVERY WORD OF IT IS `core/crucible-words.ts`'s — the same function the
   * Servers card calls, because main sends facts and the copy has one owner
   * (crucible ARCHITECTURE.md R1).
   */
  protected coordinationOf(name: string): string | null {
    const state = this.coordination()[name];
    return state === undefined ? null : coordinationWords(state);
  }

  // ── Steps ─────────────────────────────────────────────────────────────────

  protected indexOf(id: StepId): number {
    return this.visible().findIndex((step) => step.id === id);
  }

  protected next(): void {
    const at = this.index();
    const nextStep = this.visible()[at + 1];
    if (nextStep) this.current.set(nextStep.id);
  }

  protected back(): void {
    const previous = this.visible()[this.index() - 1];
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
    const rest = this.visible().slice(from)
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

  // ── The page reader ───────────────────────────────────────────────────────

  /*
   * THIS STEP USED TO BE A DISCLOSURE, and now it is a download.
   *
   * It said "your first read pays about six gigabytes, through whatever reads
   * the pages" — which was true, because the weights arrived inside vLLM's or
   * mlx-vlm's own Hugging Face cache and this app had no door to them except a
   * button that started a server. The local page reader has a door: the files
   * are named, sized and fetched here, so the number is on screen before
   * anybody agrees to it rather than inside somebody's first conversion.
   *
   * A MAC STILL HAS mlx-vlm IN PROCESS and does not strictly need this. It is
   * offered anyway: a Mac whose MLX environment is not installed has no other
   * way to read a page, and a step that hid the option on one platform would be
   * a step that is wrong exactly when it matters.
   */
  protected async loadReader(): Promise<void> {
    if (!api) return;
    this.reader.set(await api.pageReader.state());
  }

  protected readerSize(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  protected async getReader(): Promise<void> {
    if (!api) return;
    this.warming.set(true);
    this.readingSaid.set('');
    this.readerSaid.set(null);
    const result = await api.pageReader.install();
    this.warming.set(false);
    this.readingSaid.set(result.detail);
    await this.loadReader();
  }

  protected cancelReader(): void {
    void api?.pageReader.cancelInstall();
    this.warming.set(false);
  }
}
