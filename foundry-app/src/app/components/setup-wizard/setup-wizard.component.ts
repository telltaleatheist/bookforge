/**
 * setup-wizard — the screen a person meets the first time foundry is opened.
 *
 * ── WHAT IT IS FOR, IN ONE SENTENCE ─────────────────────────────────────────
 *
 * Foundry needs four things that do not arrive with the application — a folder
 * to keep books in, a GPU engine, one or two prebuilt Pythons and the page
 * reader — and until this screen existed, a new installation discovered each of
 * them by failing at it. The wizard asks for them in the order they are needed,
 * says what each one costs before fetching a byte of it, and lets every single
 * one be skipped.
 *
 * ── IT USED TO ASK FOR OLLAMA AND A MODEL, AND THAT STEP IS DELETED ─────────
 *
 * Between the library and the engine there was a step that probed for Ollama,
 * offered to fetch its official installer, listed the Qwen lineup with one row
 * badged for this machine's card, and pulled the chosen tag with a bar. Owen,
 * 2026-09-15: *"we dont have any local models. crucible handles all model
 * orchestration. if theres no connected crucible server then tiles should be
 * disabled."* Foundry runs no model, so there is nothing for this screen to
 * measure the machine against and nothing for it to download.
 *
 * ── THE ENGINE STEP IS THE ONE THAT MATTERS NOW ─────────────────────────────
 *
 * It offers three doors — connect to one elsewhere, use one already on this
 * machine, install one here — and it stopped being optional in Wave 66: every
 * GPU slot in the queue is a registered engine, so somebody who skips it cannot
 * translate, simplify, clean, analyse or read pages at all. The doors themselves
 * are a child component (`app-crucible-doors`) shared with the Settings card so
 * the two screens cannot offer different choices.
 *
 * ── IT IS A FLOW, NOT A QUESTION, AND THAT DECIDES THREE THINGS ─────────────
 *
 * `UiService.dialogs` is the one-modal list, and this is deliberately not on
 * it (see `setupOpen` there). A modal is a question with an answer; this is
 * several steps, one of which STARTS WORK THAT OUTLIVES THE STEP — a
 * page-reader download keeps what it has already fetched even when it is
 * cancelled. So:
 *
 *   * it does not go through `only()`, which would let any dialog opened over
 *     it clear the boolean and take a half-finished setup off the screen;
 *   * it is MOUNTED UNCONDITIONALLY by the shell and holds its own `@if`,
 *     because an `@if` around this component is a DESTROY, and destroying it
 *     mid-download would drop the progress subscription that is the only
 *     thing telling somebody their download is alive;
 *   * closing it is never a failure. `setup:finish` is called on the way out
 *     however it is left, and what was skipped is written down.
 *
 * ── NOTHING DOWNLOADS BECAUSE YOU ARRIVED SOMEWHERE ─────────────────────────
 *
 * Every step that costs bytes has a button, and the button is the permission.
 * Arriving at the environments step reads the catalog (a directory check),
 * arriving at the engine step reads the registry — neither of those spends
 * anything of the user's. The moment something is going to be fetched, the size
 * is on screen next to the button that fetches it.
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
import type { CrucibleProbe, CrucibleServerView } from '@shared/slots';
import type { PageReaderProgress, PageReaderState } from '@shared/types';
import {
  LLM_CLASSES,
  defaultEngineServer,
  splitUpstreamModel,
  type CapabilityRecord,
  type CapabilityRow,
  type LlmClass,
  type SettingsDocument,
  type SettingsPatch,
} from '@shared/engine-settings';
import { CrucibleDoorsComponent } from '../crucible-doors/crucible-doors.component';
import {
  FOUNDRY_ACTS,
  actWords,
  cardWords,
  coordinationWords,
  shortfallWords,
} from '../../core/crucible-words';
import {
  EngineUpstreamsComponent,
  type UpstreamApply,
} from '../engine-upstreams/engine-upstreams.component';
import { UiService } from '../../core/ui.service';
import { api } from '../../core/foundry';

type StepId =
  | 'welcome' | 'library' | 'crucible' | 'routes' | 'reading' | 'done';

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
 * lands beside, then the engine, then what runs where, and that is the whole of
 * it.
 *
 * ── THE PYTHON STEP IS GONE, AND SO IS THE HARDWARE LINE ──────────────────
 *
 * Owen, 2026-09-15, reading this wizard on a machine with a Crucible already
 * running on it: *"not sure what all this stuff is for… but it should all be
 * automatic. the user doesnt need to see this stuff about crucible to set it
 * up."* Two screens went on that ruling:
 *
 *   * **Python environments.** `electron/env-provision.ts` has provisioned
 *     these at startup since it was written — *"the app provisions ITSELF. A
 *     user who installs foundry and opens a PDF should not first have to read a
 *     settings screen and press a button labelled with a word ('rasteriser')
 *     they have no reason to know"* — so the step was asking permission for a
 *     download that had already been decided, in that exact word. The one pack
 *     startup does NOT queue (the analysis worker, 528 MB) keeps its row in
 *     Settings › Python environments, which is where somebody who wants it will
 *     look. Nothing is deleted here and no download changed.
 *   * **The machine's own card, on the welcome page.** `system:probe` runs
 *     `nvidia-smi` on this computer, and since Wave 67 this computer's card is
 *     not where anything runs: *"one gpu slot in the queue per connected
 *     crucible server."* The card a person needs to see is the one the ENGINE
 *     reports, and it is on the engine step now, in that server's own words.
 *     `probeSystem` keeps its two honest callers — `crucible-install.ts`, which
 *     describes the machine that would HOST a server, and the held local page
 *     reader.
 */
const STEPS: readonly StepDef[] = [
  {
    id: 'welcome',
    title: 'Welcome',
    blurb: 'A library folder and a GPU engine. Each one can be skipped, and each one can be done later from Settings.',
  },
  {
    id: 'library',
    title: 'Your library',
    blurb: 'Where finished books live. A folder you can open, back up and sync — not somewhere hidden.',
  },
  {
    /*
     * AFTER THE LIBRARY AND BEFORE THE ENVIRONMENTS. It used to sit after an
     * Ollama step, on the argument that the Ollama step *"is what most people will
     * use and a Crucible offered first would read as a requirement"* — and since
     * Wave 66 it IS one, and since 2026-09-15 there is no Ollama step to sit
     * after. Before the environments, because it is a decision rather than a
     * download: somebody who connects to an engine here has changed what the rest
     * of setup means, and finding that out after paying for two Pythons would be
     * finding it out too late.
     */
    id: 'crucible',
    /*
     * IT SAID *"Crucible (optional)"* AND *"Most people should skip this"*, and
     * Owen's Wave 66 ruling retired both: *"everything goes through a crucible
     * server now, including local… there should be no local gpu listed in the
     * queue."* Every GPU slot in the queue is a registered engine, so a person
     * who skips this step has no slot and cannot translate, simplify, clean,
     * analyse or read pages at all. Telling them to walk past it would be this
     * screen sending somebody to a dead queue.
     */
    title: 'A GPU engine',
    blurb: 'Where translation, simplification, cleanup, analysis and page reading run — on this machine or another one. Without one they cannot run.',
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
    /*
     * ── DRAWN ONLY WHEN NO CONNECTED ENGINE READS PAGES ──────────────────
     *
     * This step is the FALLBACK path and says so in its own prose: three
     * gigabytes of dots.ocr weights for *"a machine that has no engine of its
     * own"*. An engine whose capability record has `pages` enabled already
     * reads pages, so offering the download beside it is offering somebody a
     * second copy of something they have — which is the shape of Owen's
     * complaint about this wizard, one screen along.
     *
     * HIDDEN RATHER THAN DELETED: Wave 68 held the local page reader
     * deliberately, on a gate that has not been met, because it is the only
     * road to an EPUB on a machine that cannot install WSL. A machine like that
     * has no engine serving `pages`, so it still sees this step.
     */
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
              search for claims. The book itself is made on this computer; anything that meets a
              language model is sent to a GPU engine, which is the one thing here worth setting up
              carefully.
            </p>
            <p class="line">
              Nothing on the next screens downloads until you press the button that downloads it,
              and the size is always beside the button.
            </p>
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

          <!-- ── The engine, in two faces ────────────────────────────────── -->
          <!--
            OWEN OPENED THIS STEP ON A MACHINE ALREADY RUNNING AN ENGINE AND WAS
            SHOWN THREE DOORS AND THEN A REFUSAL: *"i tried to connect to the
            crucible server but it gave me an error. this should be idiot proof…
            it shouldnt talk about crucible unless it needs to, or to ask the
            user to add a crucible server."* So the step has two faces and the
            connected one is the common case: main connects the engine on this
            machine at startup without being asked (connectLocalEngine in main), and
            what is left to show is what he asked for — the card, what it can
            do, and what it cannot.

            THE WORD "CRUCIBLE" IS IN THE SECOND FACE ONLY. A person with a
            working engine never needs it; a person who has to install one is
            about to run an installer with that name on it, and hiding it there
            would be hiding the one word they need to search for.
          -->
          @if (current() === 'crucible') {
            @if (engineProbe(); as engine) {
              <p class="lead">
                Ready. Translation, simplification, cleanup, analysis and page reading run on
                <strong>{{ engine.serverName }}</strong>, and nothing here needs setting up.
              </p>
              <div class="engine">
                <p class="engine-card">{{ cardWords(engine) }}</p>
                <p class="small">
                  {{ engine.backend }} · version {{ engine.version }}
                  @if (engine.via; as via) { · reached through {{ via }} }
                </p>
              </div>

              @if (engineActs().length > 0) {
                <p class="line">What it can do with that card:</p>
                <div class="acts">
                  @for (act of engineActs(); track act.act) {
                    <div class="act" [attr.data-ok]="act.enabled">
                      <span class="dotstate" [attr.data-ok]="act.enabled"></span>
                      <span class="act-name">{{ act.act }}</span>
                      @if (act.enabled) {
                        <span class="act-by mono">{{ act.by }}</span>
                      } @else if (act.shortfall; as short) {
                        <span class="act-by">needs {{ short }}</span>
                      } @else {
                        <span class="act-by">will not run here</span>
                      }
                    </div>
                    @if (!act.enabled) { <p class="act-why small">{{ act.reason }}</p> }
                  }
                </div>
              }

              @if (engineNeedsAccount()) {
                <!--
                  OWEN'S OWN EXAMPLE, AND THE OFFER HE ASKED FOR: *"if the
                  crucible server isnt powerful enough to run translate, because
                  it's running on an 8 gb gpu and cant run the 27b, it can prompt
                  them for claude or chatgpt api key for that."* It POINTS at the
                  next step instead of growing a key box, because that step is
                  PHASE15 §5.2's panel and the key belongs in the engine, once.
                -->
                <p class="line">
                  What this card cannot run, an Anthropic or OpenAI account can. The next step is
                  where that key goes — it is stored in the engine, not in foundry.
                </p>
              }

              <!--
                STILL REACHABLE, NEVER IN THE WAY. A second machine is a second
                GPU slot in the queue and is the whole reason somebody buys a Mac
                Studio; a person who has one working engine is not looking for it
                on this screen.
              -->
              @if (moreDoors()) {
                <app-crucible-doors (changed)="loadCrucible()" />
              } @else {
                <div class="actions">
                  <button class="ghost" type="button" (click)="moreDoors.set(true)">
                    Add another machine
                  </button>
                </div>
              }
            } @else if (engineAsking()) {
              <p class="lead">Looking for an engine…</p>
            } @else {
              <p class="lead">
                Translation, simplification, cleanup, analysis and page reading run on a GPU
                engine — a program called Crucible, on this machine or another one. Foundry
                looked and found none here. Compiling a book and exporting it never need one.
              </p>
              <p class="line">
                An engine on a machine with a bigger card runs the work there; one on this
                machine runs it here and holds its models properly instead of loading and
                unloading per job. Registering both gives the queue two GPU slots and it will
                use whichever is free.
              </p>
              @if (crucibleServers().length > 0) {
                <!--
                  A REGISTERED SERVER THAT WOULD NOT ANSWER. It is named, with
                  whatever the last coordination sweep said about it, because
                  "foundry found none here" beside a row somebody added by hand
                  would read as the app having forgotten it.
                -->
                <p class="ok-note">
                  Registered but not answering just now: {{ crucibleNames() }}. Settings › Servers
                  tests these and says why.
                </p>
                @for (server of crucibleServers(); track server.name) {
                  @if (coordinationOf(server.name); as said) {
                    <p class="small">{{ server.name }} — {{ said }}</p>
                  }
                }
              }
              <app-crucible-doors (changed)="loadCrucible()" />
            }
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

          <!-- ── The page reader ─────────────────────────────────────────── -->
          @if (current() === 'reading') {
            @if (reader(); as it) {
              <p class="lead">
                The model that reads pages is dots.ocr. Every other thing foundry asks a model to do
                — translate, simplify, clean, analyse — runs on the GPU engine you connected, and so
                does this when the engine serves it. This copy is the fallback for a machine that
                has no engine of its own, and it is the only weights foundry ever fetches.
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

    .dotstate {
      width: 8px;
      height: 8px;
      margin-top: 5px;
      border-radius: 50%;
      background: var(--text-tertiary);
      flex-shrink: 0;
    }
    .dotstate[data-ok="true"] { background: var(--ok); }


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

    .engine {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 10px;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }
    .engine-card {
      margin: 0;
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
    }

    .acts { display: flex; flex-direction: column; gap: 2px; }
    .act { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    /* The dot sits on a text baseline everywhere else in this card; on these
       rows it sits in a flex line of its own, so the nudge has to come off. */
    .act .dotstate { margin-top: 0; }
    .act-name { color: var(--text-primary); }
    .act-by { margin-left: auto; color: var(--text-tertiary); text-align: right; }
    .act[data-ok="false"] .act-by { color: var(--warn); }
    /* The server's own sentence about a refusal, indented under its row so it
       reads as an explanation of that line rather than a new one. */
    .act-why { padding: 0 0 4px 16px; }

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

  protected readonly current = signal<StepId>('welcome');
  /** The four llm classes, in the order the routes step draws them. */
  protected readonly classes = LLM_CLASSES;
  protected readonly libraryDir = signal('');
  protected readonly readingSaid = signal('');
  protected readonly warming = signal(false);
  protected readonly reader = signal<PageReaderState | null>(null);
  protected readonly readerSaid = signal<PageReaderProgress | null>(null);
  /** The registry, so the Crucible step can say what is already there. */
  protected readonly crucibleServers = signal<CrucibleServerView[]>([]);
  /**
   * WHAT THE CONNECTED ENGINE IS AND WHAT IT CAN DO — `loadEngineFacts`.
   *
   * `null` on both means "there is nothing to show about an engine", which
   * covers an empty registry AND a registered server that would not answer, and
   * the step draws the doors for both. They are never half-set.
   */
  protected readonly engineProbe = signal<Extract<CrucibleProbe, { outcome: 'ok' }> | null>(null);
  protected readonly engineCap = signal<CapabilityRecord | null>(null);
  protected readonly engineAsking = signal(false);
  /**
   * Whether the three doors are open on the CONNECTED face.
   *
   * It starts closed and there is no reason to persist it: a person who came
   * here to add a second machine adds it, and the next time this screen opens
   * the second machine is why they are not looking for the button.
   */
  protected readonly moreDoors = signal(false);
  /** The words file's, exposed because a template cannot call a bare import. */
  protected readonly cardWords = cardWords;

  /**
   * THE FIVE ACTS THIS APP HAS, each with the engine's own verdict, in
   * {@link FOUNDRY_ACTS} order — and a class the server did not mention at all
   * is DROPPED rather than drawn as a refusal.
   *
   * An absent row means the server is older than that class, not that the card
   * is too small, and "Analyse claims — will not run here" over a server that
   * has simply never heard of analysis would send somebody to buy a graphics
   * card for a problem an upgrade fixes.
   */
  protected readonly engineActs = computed(() => {
    const record = this.engineCap();
    if (record === null) return [];
    return FOUNDRY_ACTS
      .map((name) => record.classes.find((row) => row.capability === name))
      .filter((row): row is CapabilityRow => row !== undefined)
      .map((row) => ({
        act: actWords(row.capability),
        enabled: row.enabled,
        /*
         * WHAT IS RUNNING IT, and the two routes read differently on purpose.
         * A local class names the MODEL, because that is the thing on the card
         * and the thing whose speed somebody is about to notice. An upstream
         * class names the ACCOUNT rather than the model id, because
         * `anthropic/claude-sonnet-5` in a list of five rows is an id, and "via
         * your Anthropic account" is the fact that explains why that row is
         * lit when the card could not do it.
         */
        by: row.route === 'upstream'
          ? `via your ${splitUpstreamModel(row.selected)?.upstream ?? 'connected'} account`
          : row.selected,
        reason: row.reason,
        shortfall: shortfallWords(row.shortfallBytes),
        /* `pages` cannot route upstream (PHASE15 §1), so it is never offered a key. */
        routable: (LLM_CLASSES as readonly string[]).includes(row.capability),
      }));
  });

  /**
   * Whether any TEXT act is refused, which is the one case Owen named as
   * deserving an offer: *"if the crucible server isnt powerful enough to run
   * translate, because it's running on an 8 gb gpu and cant run the 27b, it can
   * prompt them for claude or chatgpt api key for that."*
   *
   * It POINTS at the next step rather than growing a key field of its own. The
   * routes step is PHASE15 §5.2's panel and already holds the whole of this —
   * the upstream child, the write-through, the test button — and a second key
   * box two screens earlier would be a second owner of the one fact this app is
   * forbidden to store twice.
   */
  protected readonly engineNeedsAccount = computed(
    () => this.engineActs().some((act) => !act.enabled && act.routable));

  /**
   * Does a connected engine already read pages? Decides whether the page-reader
   * step is drawn at all — see its entry in {@link STEPS}.
   */
  protected readonly engineReadsPages = computed(
    () => this.engineCap()?.classes.some((row) => row.capability === 'pages' && row.enabled) === true);
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
    const readsPages = this.engineReadsPages();
    return STEPS.filter((step) => {
      if (step.id === 'routes') return hasEngine;
      if (step.id === 'reading') return !readsPages;
      return true;
    });
  });
  protected readonly index = computed(() => Math.max(0, this.indexOf(this.current())));
  protected readonly def = computed(() => this.visible()[this.index()] ?? STEPS[0]!);

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
      /*
       * A STORED ID THIS BUILD NO LONGER HAS IS DROPPED, not carried.
       *
       * The Ready screen falls back to printing the raw id for a step it cannot
       * name, which is right for a typo and wrong for a step that was DELETED:
       * somebody who skipped "Python environments" before 2026-09-15 would be
       * told, in a later run, that they skipped "envs" — a word this app no
       * longer uses about a screen it no longer has. It is the same rule the
       * routes step is hidden by: a wizard must not say somebody skipped a step
       * that was never offered.
       */
      const known = new Set<string>(STEPS.map((step) => step.id));
      this.skipped.set(state.skipped.filter((id) => known.has(id)));
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

    /*
     * ── THE STEP LIST CAN SHRINK NOW, SO STANDING ON ONE HAS TO BE CHECKED ──
     *
     * Until 2026-09-15 `visible()` could only GROW: the routes step appeared
     * when a server was registered and nothing ever took a step away. The page
     * reader step is hidden when a connected engine serves `pages`, and that
     * answer arrives from a network probe — so a step somebody is standing on
     * can stop existing under them.
     *
     * What that looked like without this: `indexOf` answers -1, `index()`
     * clamps it to 0, the heading and the rail say "Welcome" while `current()`
     * still says `reading` and the body draws the page reader. A card whose
     * title and contents disagree.
     *
     * FORWARD, not back. A step disappears here because it was ANSWERED — the
     * engine reads pages, so there is nothing to download — and sending
     * somebody backwards would re-ask them a question that has just been
     * settled.
     *
     * THE POSITION COMES FROM `STEPS`, NOT FROM `index()`. `index()` is
     * `max(0, indexOf(current))` and `indexOf` answers -1 for a step that is no
     * longer drawn, so reading the landing out of it puts everybody on Welcome
     * — which is the bug this effect exists to prevent, wearing a different
     * face. The full order is the one place a vanished step still has a
     * position, so the landing is the first VISIBLE step at or after it.
     */
    effect(() => {
      const steps = this.visible();
      const here = this.current();
      if (steps.some((step) => step.id === here)) return;
      const was = STEPS.findIndex((step) => step.id === here);
      const order = new Map(STEPS.map((step, at) => [step.id, at]));
      const landing = steps.find((step) => (order.get(step.id) ?? 0) >= was)
        ?? steps[steps.length - 1];
      if (landing !== undefined) this.current.set(landing.id);
    });

    // Each step loads only what it can read for free. Nothing here fetches.
    effect(() => {
      if (!this.up()) return;
      const here = this.current();
      if (here === 'library') void this.loadLibrary();
      if (here === 'crucible') void this.loadCrucible();
      if (here === 'routes') void this.loadRoutes();
      if (here === 'reading') void this.loadReader();
    });

  }

  // ── Reading what is free to read ───────────────────────────────────────────


  private async loadLibrary(): Promise<void> {
    if (!api) return;
    this.libraryDir.set(await api.library.dir());
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
    await this.loadEngineFacts();
  }

  /**
   * THE TWO FACTS THE ENGINE STEP SHOWS WHEN THERE IS AN ENGINE — the card, and
   * what it can do with it.
   *
   * Owen, 2026-09-15, opening this wizard on a machine already running one:
   * *"since crucible is already set up on our machine, it should just connect to
   * the server and then show what gpu is registered with the existing crucible
   * server… things the user might need to know about crucible setup: the GPU
   * it's connected to and how powerful it is, the functions that will be
   * available and the functions that wont be available because it isnt powerful
   * enough, what might need an API key to run."*
   *
   * ── BOTH READS ARE THE ONES THAT ALREADY EXIST ───────────────────────────
   *
   * `crucible:test` is `info()` — the server's name, its version, its backend
   * and THE CARD IN ITS OWN WORDS — and `crucible:engine-capability` is
   * `readCapability`, the dispatcher's own reader, which is what the routes step
   * one screen along already draws from. Neither places a job, neither loads a
   * model, and no third door was added for this: a second way to ask an engine
   * what it is would be a second answer to drift from the first.
   *
   * ── A FAILURE IS NOT A BLANK ─────────────────────────────────────────────
   *
   * Both are set together and cleared together, for the reason `loadRoutes`
   * gives about its own pair: a card kept beside a capability record that failed
   * to read would let this step print "this engine can do everything" from an
   * EMPTY list of refusals, which is the sentence "nothing was measured" said as
   * though it were good news. When they clear, the step falls back to the doors,
   * which is the honest face for an engine that will not answer.
   */
  private async loadEngineFacts(): Promise<void> {
    if (!api) return;
    const server = defaultEngineServer(this.crucibleServers());
    if (server === null) {
      this.engineProbe.set(null);
      this.engineCap.set(null);
      return;
    }
    this.engineAsking.set(true);
    try {
      const [probe, capability] = await Promise.all([
        api.crucible.test(server.name),
        api.crucible.engineCapability(server.name),
      ]);
      this.engineProbe.set(probe.outcome === 'ok' ? probe : null);
      this.engineCap.set(probe.outcome === 'ok' ? capability : null);
    } catch {
      /*
       * SWALLOWED, and the step draws the doors instead. Every reason this can
       * throw — the engine is asleep, the token was rotated, the machine is off
       * the network — is already said out loud one screen along in Settings ›
       * Servers, which has a Test button and prints the SDK's own sentence. A
       * wizard that stopped on an exception here would be a wizard somebody
       * cannot get past because a laptop in another room is shut.
       */
      this.engineProbe.set(null);
      this.engineCap.set(null);
    } finally {
      this.engineAsking.set(false);
    }
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
