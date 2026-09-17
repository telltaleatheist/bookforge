import { Component, OnInit, OnDestroy, inject, signal, computed, input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { DesktopButtonComponent } from '../../creamsicle-desktop';
import { AiService, LocalModel, LocalSystemInfo, LocalModelProgress } from '../../core/services/ai.service';
import { SettingsService } from '../../core/services/settings.service';
import { ElectronService } from '../../core/services/electron.service';
import {
  CRUCIBLE_TEXT_ACT_NAMES,
  CRUCIBLE_UPSTREAM_NAMES,
  type CrucibleEngineSettings,
  type CrucibleEngineSettingsPatch,
  type CrucibleEngineSettingsRefusal,
  type CrucibleLocalModelChoice,
  type CrucibleModelRow,
  type CrucibleCapabilityView,
  type CrucibleTextActName,
  type CrucibleUpstreamName,
  type CrucibleUpstreamProbe,
} from '@shared/crucible/settings-wire';
import {
  ENGINE_CAPABILITY_UNDECIDED,
  ENGINE_FIT_CAVEAT,
  ENGINE_KEYS_INTRO,
  ENGINE_LOCAL_MODELS_INTRO,
  ENGINE_ROUTES_INTRO,
  ENGINE_SETTINGS_INTRO,
  ENGINE_SETTINGS_NO_SERVER,
  ENGINE_SETTINGS_REFUSED_LEAD,
  ROUTE_CHOICE_OTHER,
  ROUTE_CHOICE_OTHER_HELP,
  ROUTE_CHOICE_OTHER_PLACEHOLDER,
  TEST_BEFORE_SAVE_WORDS,
  capabilityClassWords,
  capabilityWords,
  localRouteWords,
  nameAModelWords,
  offerButtonWords,
  routeWords,
  unavailableGroups,
  unavailableNoticeWords,
  unavailableOfferWords,
  upstreamCredentialField,
  upstreamFieldWords,
  upstreamRouteWords,
  upstreamStateWords,
  upstreamTestedWords,
  upstreamWordsLeading,
} from '../settings/components/crucible-words';
import {
  DEFAULT_VLM_CONCURRENCY,
  describeVlmEndpointCheck,
  resolveVlmRouteWithVenue,
  vlmRouteLabel,
  type VlmRoute,
  type VlmVenue,
} from '@shared/vlm/conversion';

/**
 * AI Setup wizard (WS2). One page, two sources of AI for OCR cleanup:
 *   • Bundled local AI (llama.cpp) — download a Cogito model, hardware-recommended.
 *   • Crucible — a server from Settings → Crucible Servers, and a model that is
 *     already RESIDENT on it. The provider has existed in `ai-bridge.ts` since
 *     phase 2 with no way to select it; this card is that way.
 *
 * IT OFFERED FOUR UNTIL 2026-09-14. The Ollama card and the cloud-keys card
 * are gone: Anthropic, OpenAI and Ollama are UPSTREAMS the engine forwards to
 * on the operator's account, configured on the engine, and this app holds no
 * key and talks to no daemon.
 *
 * Reachable from the nav rail (/ai-setup) and surfaced on first run by
 * onboarding. AI is optional — cleanup can always be skipped.
 */
@Component({
  selector: 'app-ai-setup-wizard',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="wizard" [class.embedded]="embedded()">
      @if (!embedded()) {
        <header class="wizard-head">
          <div class="head-icon">&#129302;</div>
          <div>
            <h1>Set up AI</h1>
            <p class="sub">
              AI cleanup is optional — it tidies OCR text before narration. Pick one
              source below. You can always skip cleanup entirely.
            </p>
          </div>
        </header>
      }

      <!-- Availability banner -->
      <div class="status-banner" [class.ok]="ai.available()">
        @if (ai.available()) {
          <span class="dot ok"></span>
          <span>AI route configured. {{ activeSummary() }}</span>
        } @else {
          <span class="dot"></span>
          <span>No AI configured yet. Set up one of the options below.</span>
        }
      </div>

      <!-- ── Bundled local AI ── -->
      @if (!wizard()) {
      <section class="card">
        <div class="card-head">
          <h2>&#128187; Bundled local AI</h2>
          <span class="tag">Runs offline · free · private</span>
        </div>

        @if (localStatus()?.binaryPresent === false) {
          <p class="muted">
            The local AI engine isn't included in this build. Use a GPU engine (Crucible)
            below, or install a build that bundles the engine.
          </p>
        } @else {
          @if (sysInfo(); as info) {
            <p class="muted hw">
              This machine: {{ info.totalRamGB }} GB RAM<!--
              -->@if (info.cuda) {, {{ info.cudaName || 'GPU' }} ({{ info.vramGB }} GB VRAM)}.
              Recommended: <strong>{{ modelName(info.recommendedModelId) }}</strong>.
            </p>
          }

          <div class="models">
            @for (m of models(); track m.id) {
              <div class="model" [class.active]="m.isActive" [class.too-big]="!m.fits">
                <div class="model-info">
                  <div class="model-name">
                    {{ m.name }}
                    @if (m.recommended) { <span class="badge rec">Recommended</span> }
                    @if (m.isActive) { <span class="badge active">In use</span> }
                    @if (!m.fits) { <span class="badge warn">Large for your hardware</span> }
                  </div>
                  <div class="model-meta">{{ m.sizeGB }} GB · needs ~{{ m.minRAM }} GB RAM · {{ m.description }}</div>
                  @if (!m.fits) {
                    <div class="model-warn">⚠ Bigger than this machine can fully fit — it’ll run partly on the CPU and be slow. You can still use it.</div>
                  }

                  @if (progressFor(m.id); as p) {
                    <div class="progress">
                      <div class="bar"><div class="fill" [style.width.%]="p.pct"></div></div>
                      <div class="progress-meta">
                        {{ p.pct }}%@if (p.speed) { · {{ p.speed }}}@if (p.eta) { · {{ p.eta }} left}
                      </div>
                    </div>
                  }
                </div>

                <div class="model-actions">
                  @if (progressFor(m.id)) {
                    <desktop-button variant="ghost" size="sm" (click)="cancel(m.id)">Cancel</desktop-button>
                  } @else if (m.downloaded) {
                    @if (!m.isActive) {
                      <desktop-button variant="primary" size="sm" (click)="useModel(m.id)">Use</desktop-button>
                    }
                    <desktop-button variant="ghost" size="sm" (click)="remove(m.id)">Delete</desktop-button>
                  } @else {
                    <desktop-button variant="primary" size="sm" [disabled]="anyDownloading()" (click)="download(m.id)">
                      Download
                    </desktop-button>
                  }
                </div>
              </div>
            }
          </div>

          @if (localStatus()?.anyModelDownloaded && !usingLocal()) {
            <div class="use-row">
              <desktop-button variant="primary" (click)="setProvider('local')">Use local AI for cleanup</desktop-button>
            </div>
          }

          @if (downloadedModels().length > 0) {
            <div class="danger-row">
              @if (confirmDeleteModels()) {
                <span class="danger-confirm">
                  Delete {{ downloadedModels().length }} downloaded model{{ downloadedModels().length === 1 ? '' : 's' }}?
                  <desktop-button variant="ghost" size="sm" (click)="deleteAllModels()">Delete</desktop-button>
                  <desktop-button variant="ghost" size="sm" (click)="confirmDeleteModels.set(false)">Cancel</desktop-button>
                </span>
              } @else {
                <button class="link-danger" (click)="confirmDeleteModels.set(true)">Delete all downloaded models</button>
              }
            </div>
          }
        }
      </section>
      }

      <!-- ── Crucible ── -->
      <section class="card">
        <div class="card-head">
          <h2>&#128225; Crucible</h2>
          <span class="tag">One inference server, this machine's or another's</span>
        </div>

        @if (crucibleServers().length === 0) {
          <p class="muted">
            No Crucible server is enabled for this machine. Add one — or enable one — in
            the previous setup step or Settings &rarr; Crucible Servers.
          </p>
        } @else {
          <p class="muted">
            Crucible manages local models and configured Ollama or cloud routes. Choose the routes
            below; setup prepares the required models once, shared with Foundry.
          </p>

          <div class="setting-row">
            <label class="setting-label">Server</label>
            <select class="key-input" [disabled]="engineBusy()" [value]="crucibleServer()" (change)="setCrucibleServer($any($event.target).value)">
              <option value="">Choose a server…</option>
              @for (name of crucibleServers(); track name) {
                <option [value]="name">{{ name }}</option>
              }
            </select>
            <desktop-button variant="ghost" size="sm" [disabled]="!crucibleServer() || crucibleTesting()" (click)="testCrucible()">
              {{ crucibleTesting() ? 'Testing…' : 'Test' }}
            </desktop-button>
          </div>

          @if (crucibleServer() && !wizard()) {
            <div class="setting-row">
              <label class="setting-label">Model</label>
              <select class="key-input" [value]="crucibleModel()" (change)="setCrucibleModel($any($event.target).value)">
                <option value="">Choose a model…</option>
                @for (m of crucibleModels(); track m.id) {
                  <option [value]="m.id">{{ m.id }} — {{ modelState(m) }}</option>
                }
              </select>
            </div>
            @if (chosenModel(); as m) {
              @if (!m.resident) {
                <p class="vlm-status bad">
                  {{ m.id }} is not resident on {{ crucibleServer() }}, so a cleanup run will refuse
                  by name. @if (!m.loadable) { The server says: {{ m.reason }} } @else { Load it in
                  Settings &rarr; Crucible Servers. }
                </p>
              }
            }
          }

          <!--
            THE FOUR ACT ROWS MOVED to the Engine settings card below, and they
            gained a control on the way. They were a READ here — "the server's
            own answer", with a paragraph saying this app does not choose it —
            and that paragraph stopped being true on 2026-09-14 (crucible
            PHASE15 §5.2): the engine's settings document is writable, this app
            draws a window onto it, and a row that shows where a job runs
            without offering to change it would be half of the contract.
          -->

          @if (crucibleStatus(); as status) {
            <p class="vlm-status" [class.bad]="!status.ok">{{ status.message }}</p>
          }

          @if (crucibleServer() && (wizard() ? managedCleanupModel() : crucibleModel()) && !usingCrucible()) {
            <div class="use-row">
              <desktop-button variant="primary" (click)="useCrucible()">Use this Crucible for cleanup</desktop-button>
            </div>
          }
        }
      </section>

      <!-- ── Reading pages (Convert to EPUB) ── -->
      <section class="card">
        <div class="card-head">
          <h2>&#128441; Reading pages</h2>
          <span class="tag">Convert to EPUB · document vision model</span>
        </div>

        @if (localReadingRefusal(); as refusal) {
          <p class="muted warn-note">{{ refusal }}</p>
        } @else {
          <p class="muted">
            Convert to EPUB reads every page picture with a document vision model. This machine can
            do that itself (Apple Silicon, MLX) — leave the server URL empty and it will. Point it
            at an OpenAI-compatible server (vLLM) instead when that machine has the faster GPU;
            nothing switches by itself, and the conversion says which one it used.
          </p>
          <!--
            THE MACHINE, NAMED. Read from the same decision the run makes, so
            this line cannot say "this machine's GPU (WSL)" for a conversion
            about to go to a Crucible somewhere else.
          -->
          @if (pagesRouteLabel(); as where) {
            <p class="muted">
              Pages would be read on <strong>{{ where }}</strong> — that is the card this app will
              take for the length of a conversion. Change it in Settings &#8594; Crucible Servers.
            </p>
          }
        }

        <div class="setting-row">
          <label class="setting-label">Server URL</label>
          <input
            class="key-input"
            type="text"
            [value]="vlmUrl()"
            (change)="setVlmUrl($any($event.target).value)"
            placeholder="http://127.0.0.1:8000/v1"
          />
          <desktop-button variant="ghost" size="sm" [disabled]="vlmTesting()" (click)="testVlmEndpoint()">
            {{ vlmTesting() ? 'Testing…' : 'Test' }}
          </desktop-button>
        </div>

        @if (vlmUrl().trim()) {
          <div class="setting-row">
            <label class="setting-label">Model name</label>
            <input
              class="key-input"
              type="text"
              [value]="vlmModel()"
              (change)="setVlmModel($any($event.target).value)"
              placeholder="the name the server was started with"
            />
          </div>
          <div class="setting-row">
            <label class="setting-label">Pages at once</label>
            <input
              class="key-input narrow"
              type="number"
              min="0"
              [value]="vlmConcurrency()"
              (change)="setVlmConcurrency($any($event.target).value)"
              [placeholder]="defaultConcurrency"
            />
            <span class="muted inline-note">0 = foundry’s default of {{ defaultConcurrency }}</span>
          </div>
        }

        @if (vlmStatus(); as status) {
          <p class="vlm-status" [class.bad]="!status.ok">{{ status.message }}</p>
        }
      </section>

      <!--
        ── THE ENGINE'S OWN SETTINGS, DRAWN AS A WINDOW ────────────────────
        crucible docs/PHASE15-HOST.md §5.2. Every control here is a request to
        the selected engine and every answer is re-read from it; there is no
        Save button for the panel, because there is no app-side copy to save.
        The card that stood here said all of that in a paragraph and offered
        nothing to press — which was the right sentence and the wrong screen.
      -->
      <section class="card">
        <div class="card-head">
          <h2>&#9881; Engine settings</h2>
          <span class="tag">Held by the engine · written straight through</span>
        </div>

        @if (!crucibleServer()) {
          <p class="muted">{{ noServerWords }}</p>
        } @else {
          <p class="muted">{{ settingsIntroWords }}</p>

          @if (panelRefusal(); as refusal) {
            <!--
              THE CODE IS ON THE SCREEN, and that is the correction (2026-09-15).
              This panel showed refusal.message alone, so route_bad_model,
              route_upstream_unconfigured, upstream_in_use, unknown_upstream and
              upstream_bad_field reached a person as prose with no name on it —
              and "refused by name" is only true where the name is visible. The
              other Crucible panels in this app already draw it this way.
            -->
            <p class="vlm-status bad">
              {{ refusedLeadWords }} <span class="code">{{ refusal.code }}</span> {{ refusal.message }}
            </p>
          }

          @if (engineSettings(); as doc) {

            <!-- ── Where each job runs ── -->
            <h3 class="cru-acts-head">Where each job runs</h3>
            <p class="muted">{{ routesIntroWords }}</p>

            @for (act of textActs; track act) {
              <div class="setting-row">
                <label class="setting-label">{{ classWords(act) }}</label>
                <select
                  class="key-input"
                  [value]="routeSelectValue(act)"
                  [disabled]="engineBusy()"
                  (change)="chooseRoute(act, $any($event.target).value)"
                >
                  <option [value]="LOCAL_ROUTE">{{ localOptionFor(act) }}</option>
                  @for (id of upstreamModelChoices(); track id) {
                    <option [value]="id">{{ upstreamOptionFor(id) }}</option>
                  }
                  <option [value]="OTHER_ROUTE">{{ otherRouteWords }}</option>
                </select>
              </div>
              <p class="act-model">{{ runsOnNow(act) }}</p>

              @if (routeSelectValue(act) === OTHER_ROUTE) {
                <div class="setting-row">
                  <label class="setting-label"></label>
                  <input
                    class="key-input"
                    type="text"
                    [value]="routeDraft(act)"
                    (input)="setRouteDraft(act, $any($event.target).value)"
                    [attr.list]="'bf-upstream-models'"
                    [placeholder]="otherRoutePlaceholder"
                  />
                  <desktop-button
                    variant="primary"
                    size="sm"
                    [disabled]="engineBusy() || routeDraft(act).trim().length === 0"
                    (click)="setRouteFromDraft(act)"
                  >Set</desktop-button>
                </div>
                <p class="act-model">{{ otherRouteHelpWords }}</p>
              }

              <!-- THE REFUSAL SITS BESIDE THE CONTROL ITS OWN FIELD NAMES. That
                   is what the dotted path is for (§3.2): routes.translate
                   belongs under the translate row, not at the top of a page
                   with four rows on it. -->
              @if (refusalFor('routes.' + act); as r) {
                <p class="vlm-status bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
              }
            }

            <!-- ── Which model does each job ── -->
            <h3 class="cru-acts-head">Which model does each job</h3>
            @if (localClasses().length === 0) {
              <p class="muted">{{ capabilityUndecidedWords }}</p>
            } @else {
              <p class="muted">{{ localModelsIntroWords }}</p>

              @for (capability of localClasses(); track capability) {
                <div class="setting-row">
                  <label class="setting-label">{{ classWords(capability) }}</label>
                  <select
                    class="key-input"
                    [value]="localSelectValue(capability)"
                    [disabled]="engineBusy()"
                    (change)="chooseLocalModel(capability, $any($event.target))"
                  >
                    <option [value]="AUTOMATIC_MODEL">Let the engine choose</option>
                    <!-- A MODEL THE ENGINE SAYS DOES NOT FIT IS STILL OFFERED.
                         The estimate excludes the context cache, so it is not a
                         verdict; the person may be about to free memory or
                         change the desktop allowance; and the engine refuses by
                         name with local_model_does_not_fit if they are wrong.
                         Hiding the row would make this app a second, worse copy
                         of a rule the engine already owns, and the model would
                         simply vanish with nothing said. -->
                    @for (choice of localChoices(capability); track choice.id) {
                      <option [value]="choice.id">{{ localChoiceWords(choice) }}</option>
                    }
                  </select>
                </div>

                @if (refusalFor('local_models.' + capability); as r) {
                  <p class="vlm-status bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
                }
              }

              <!-- ONCE, under the rows. Per row it reads as a warning about
                   that model; it is a property of the measurement, and true of
                   every one of them. -->
              <p class="muted">{{ fitCaveatWords }}</p>
            }

            <!-- ── The three accounts ── -->
            <h3 class="cru-acts-head">Accounts this engine can send work to</h3>
            <p class="muted">{{ keysIntroWords }}</p>
            <p class="muted">{{ testBeforeSaveWords }}</p>

            @for (name of upstreamNames; track name) {
              <div class="upstream">
                <div class="upstream-head">
                  <strong>{{ upstreamTitle(name) }}</strong>
                  <span class="act-model">{{ upstreamState(name, doc) }}</span>
                </div>
                <div class="setting-row">
                  <label class="setting-label">{{ fieldLabel(name) }}</label>
                  <!-- EMPTY ON EVERY DRAW. A key is write-only: the engine
                       never sends one back, so there is nothing to put in
                       this box, and upstreamDrafts is cleared by the same
                       function that redraws the document. -->
                  <input
                    class="key-input"
                    [type]="fieldType(name)"
                    autocomplete="off"
                    spellcheck="false"
                    [value]="draftFor(name)"
                    (input)="setDraft(name, $any($event.target).value)"
                    [placeholder]="fieldPlaceholder(name)"
                  />
                  <!-- TEST COMES BEFORE SAVE, in the template and in the act:
                       Test sends what was typed WITHOUT storing it. -->
                  <desktop-button
                    variant="ghost"
                    size="sm"
                    [disabled]="engineBusy()"
                    (click)="testUpstreamAccount(name)"
                  >Test</desktop-button>
                  <desktop-button
                    variant="primary"
                    size="sm"
                    [disabled]="engineBusy() || draftFor(name).trim().length === 0"
                    (click)="saveUpstream(name)"
                  >Save</desktop-button>
                  @if (doc.upstreams[name].configured) {
                    <desktop-button
                      variant="ghost"
                      size="sm"
                      [disabled]="engineBusy()"
                      (click)="removeUpstream(name)"
                    >Remove</desktop-button>
                  }
                </div>
                @if (testedWordsFor(name); as line) {
                  <p class="act-model">{{ line }}</p>
                }
                @if (refusalForUpstream(name); as r) {
                  <p class="vlm-status bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
                }
              </div>
            }

            <!-- The ids a person picks from are the ones their own account
                 answered with, seconds ago. BookForge ships no cloud model
                 list, so this is empty until a Test fills it. -->
            <datalist id="bf-upstream-models">
              @for (id of upstreamModelChoices(); track id) {
                <option [value]="id"></option>
              }
            </datalist>

            <!-- ── The wizard's own step: what this engine cannot do, once ── -->
            @if (wizard()) {
              @for (group of unavailableOffers(); track group.reason) {
                <div class="offer">
                  @if (group.routable.length > 0) {
                    <p class="muted">{{ offerWords(group.routable) }}</p>
                  } @else {
                    <p class="muted">{{ noticeWords(group.capabilities) }}</p>
                  }
                  <!-- THE ENGINE'S OWN REASON, ONCE FOR THE WHOLE GROUP. Five
                       classes answering with one sentence is the contract's
                       doing (§3.3, "so an app shows it once") and
                       unavailableGroups is what collapses them. -->
                  <p class="act-model">{{ group.reason }}</p>

                  @for (act of group.routable; track act) {
                    <div class="setting-row">
                      <label class="setting-label">{{ classWords(act) }}</label>
                      <select
                        class="key-input"
                        [value]="offerUpstream(act)"
                        [disabled]="engineBusy()"
                        (change)="setOfferUpstream(act, $any($event.target).value)"
                      >
                        @for (name of upstreamNames; track name) {
                          <option [value]="name">{{ upstreamTitle(name) }}</option>
                        }
                      </select>
                      <!-- THE SAME DRAFT THE CARD ABOVE HOLDS, on purpose: it
                           is one fact (the key for this account), and typing
                           it in either place is typing it once. Absent when
                           the account is already set up, because then the one
                           press is a route and nothing else. -->
                      @if (!doc.upstreams[offerUpstream(act)].configured) {
                        <input
                          class="key-input"
                          [type]="fieldType(offerUpstream(act))"
                          autocomplete="off"
                          spellcheck="false"
                          [value]="draftFor(offerUpstream(act))"
                          (input)="setDraft(offerUpstream(act), $any($event.target).value)"
                          [placeholder]="fieldPlaceholder(offerUpstream(act))"
                        />
                      }
                      <input
                        class="key-input"
                        type="text"
                        [value]="offerModel(act)"
                        (input)="setOfferModel(act, $any($event.target).value)"
                        [attr.list]="'bf-upstream-models'"
                        [placeholder]="offerModelPlaceholder"
                      />
                      <desktop-button
                        variant="primary"
                        size="sm"
                        [disabled]="engineBusy()"
                        (click)="connectAndRoute(act)"
                      >{{ offerButton(act) }}</desktop-button>
                    </div>
                    @if (refusalFor('routes.' + act); as r) {
                      <p class="vlm-status bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
                    }
                  }
                </div>
              }
            }
          }
        }
      </section>

      @if (!embedded()) {
        <footer class="wizard-foot">
          <desktop-button variant="ghost" (click)="close()">Done</desktop-button>
        </footer>
      }
    </div>
  `,
  styles: [`
    .wizard { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 3rem; overflow-y: auto; height: 100%; }
    .wizard.embedded { padding: 0; max-width: none; height: auto; overflow: visible; }
    .setting-row { display: flex; align-items: center; gap: 0.5rem; margin: 0.5rem 0 0.75rem; }
    /* The server's own answer for one class: read, never a control. */
    .act-model { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.45; margin: 0 0 0.5rem 7rem; }
    /* One account the engine can send work to. */
    .upstream { border: 1px solid var(--border-default); border-radius: 8px; padding: 0.6rem 0.75rem; margin: 0 0 0.75rem; }
    .upstream-head { display: flex; align-items: baseline; gap: 0.75rem; }
    .upstream-head strong { color: var(--text-primary); font-size: 0.9rem; }
    .upstream-head .act-model { margin: 0; }
    /* The wizard's "this engine cannot, so send it there instead" block. */
    .offer { border: 1px solid var(--border-default); border-radius: 8px; padding: 0.6rem 0.75rem; margin: 0.75rem 0 0; }
    .cru-acts-head { font-size: 0.95rem; font-weight: 600; color: var(--text-primary); margin: 1.25rem 0 0.4rem; }
    .setting-label { flex: none; color: var(--text-secondary); font-size: 0.85rem; min-width: 6.5rem; }
    .key-input.narrow { max-width: 7rem; }
    .inline-note { font-size: 0.8rem; margin: 0; }
    .warn-note { color: var(--warning, #d08b1e); }
    .vlm-status { font-size: 0.85rem; color: var(--text-secondary); margin: 0.25rem 0 0; }
    .vlm-status.bad { color: var(--error, #d05a5a); }
    .wizard-head { display: flex; gap: 1rem; align-items: flex-start; margin-bottom: 1.5rem; }
    .head-icon { font-size: 2.5rem; }
    h1 { font-size: 1.5rem; font-weight: 600; color: var(--text-primary); margin: 0 0 0.25rem; }
    .sub { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.5; margin: 0; }

    .status-banner {
      display: flex; align-items: center; gap: 0.6rem;
      padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1.5rem;
      background: var(--bg-subtle); border: 1px solid var(--border-default);
      font-size: 0.875rem; color: var(--text-secondary);
    }
    .status-banner.ok { border-color: var(--success); }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-tertiary, #888); flex: none; }
    .dot.ok { background: var(--success); }

    .card {
      background: var(--bg-elevated); border: 1px solid var(--border-default);
      border-radius: 10px; padding: 1.25rem; margin-bottom: 1.25rem;
    }
    .card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: 0.75rem; }
    .card-head h2 { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); margin: 0; }
    .tag { font-size: 0.75rem; color: var(--text-tertiary, #888); }
    .muted { color: var(--text-secondary); font-size: 0.85rem; line-height: 1.5; margin: 0 0 0.75rem; }
    .muted.hw { background: var(--bg-subtle); border-radius: 6px; padding: 0.5rem 0.75rem; }
    code { font-family: var(--font-mono, monospace); background: var(--bg-subtle); padding: 0.1rem 0.35rem; border-radius: 4px; }

    .models { display: flex; flex-direction: column; gap: 0.6rem; }
    .model {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      padding: 0.75rem; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-subtle);
    }
    .model.active { border-color: var(--accent); }
    /* Models too big for this machine: dimmed but still usable. */
    .model.too-big { opacity: 0.6; }
    .model.too-big:hover { opacity: 0.85; }
    .model-warn { color: #f59e0b; font-size: 0.74rem; margin-top: 0.25rem; }
    .badge.warn { background: color-mix(in srgb, #f59e0b 20%, transparent); color: #f59e0b; }
    .model-info { flex: 1; min-width: 0; }
    .model-name { color: var(--text-primary); font-weight: 600; font-size: 0.9rem; display: flex; align-items: center; gap: 0.5rem; }
    .model-meta { color: var(--text-secondary); font-size: 0.78rem; margin-top: 0.2rem; }
    .badge { font-size: 0.68rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 4px; }
    .badge.rec { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
    .badge.active { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
    .model-actions { display: flex; gap: 0.4rem; flex: none; }

    .progress { margin-top: 0.5rem; }
    .bar { height: 6px; border-radius: 3px; background: var(--border-default); overflow: hidden; }
    .fill { height: 100%; background: var(--accent); transition: width 0.2s; }
    .progress-meta { font-size: 0.72rem; color: var(--text-secondary); margin-top: 0.2rem; }

    .use-row { margin-top: 1rem; }

    /* .card-actions, .key-item, .key-provider, .key-mask and .key-saved-tag
       went with the Ollama card and the key rows. */
    .key-input {
      flex: 1; padding: 0.5rem 0.6rem; border: 1px solid var(--border-default); border-radius: 6px;
      background: var(--bg-base); color: var(--text-primary); font-size: 0.85rem;
    }
    .wizard-foot { display: flex; justify-content: flex-end; margin-top: 0.5rem; }

    .danger-row { display: flex; justify-content: flex-end; margin-top: 0.75rem; }
    .danger-confirm { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; color: var(--text-secondary); }
    .link-danger {
      background: none; border: none; cursor: pointer; padding: 0.2rem 0;
      font-size: 0.8rem; color: var(--error, #d9534f);
    }
    .link-danger:hover { text-decoration: underline; }
  `]
})
export class AiSetupWizardComponent implements OnInit, OnDestroy {
  readonly ai = inject(AiService);
  private readonly settings = inject(SettingsService);
  private readonly router = inject(Router);
  private readonly electron = inject(ElectronService);

  readonly models = signal<LocalModel[]>([]);
  readonly sysInfo = signal<LocalSystemInfo | null>(null);
  readonly localStatus = this.ai.localStatus;
  private readonly _progress = signal<Record<string, LocalModelProgress>>({});

  /** Embedded mode (rendered inside Settings → AI): hide the page header/footer. */
  readonly embedded = input(false);

  /**
   * MOUNTED AS THE FIRST-RUN WIZARD'S AI STEP, rather than as Settings → AI.
   *
   * Both hosts pass `embedded`, so that input cannot tell them apart, and
   * crucible `docs/PHASE15-HOST.md` §5.2 asks for one extra thing from the
   * wizard only: *"the wizard's AI step reads capability; for each llm class
   * that is `enabled: false` locally it says the class's reason and offers
   * 'run it through Anthropic / OpenAI / an Ollama server instead'."* That is
   * setting-up advice — the right thing to put in front of somebody who has
   * never configured this machine, and noise on a settings page somebody
   * opened to change one route. So it is one input, false by default, and the
   * rest of the panel is identical in both places on purpose: two screens
   * teaching two different things about one document is the shape §5.2 exists
   * to prevent.
   */
  readonly wizard = input(false);

  /*
   * `apiProviders`, `keyDrafts`, `hasKey`, `saveKey`, `deleteKey`,
   * `clearAllKeys`, `anyKeySaved` and `confirmClearKeys` ARE ALL DELETED
   * (2026-09-14). They were BookForge's own Claude/OpenAI key store, in the
   * renderer's localStorage under `aiConfig`.
   *
   * Cloud keys have ONE owner (Owen's ruling, docs/CRUCIBLE_ROLLOUT_PLAN.md
   * section 3): Foundry's cloud card, hosted too, whose record in
   * `app-settings.json` holds the kind, the key, the model and the address —
   * and whose Test button asks the PROVIDER'S OWN listing, which is what
   * section 2a.2 requires and what a compiled three-item list could never be.
   * BookForge's main process reads that record
   * (`electron/cloud-credentials.ts`), exactly as the clean door already reads
   * `cleanTextModel` out of the same file.
   */

  private unsub?: () => void;

  readonly usingLocal = computed(() => this.settings.getAIConfig().provider === 'local');
  readonly anyDownloading = computed(() =>
    Object.values(this._progress()).some((p) => p.phase === 'download')
  );

  readonly activeSummary = computed(() => {
    const parts: string[] = [];
    if (this.ai.localUsable()) parts.push('local model');
    const cfg = this.settings.getAIConfig();
    // No cloud line and no Ollama line: this page holds no key and talks to no
    // daemon. Whether an upstream is configured is the engine's own answer,
    // shown where the engine's settings are.
    if (this.ai.crucibleConfigured()) parts.push(`Crucible ${cfg.crucible?.server}/${cfg.crucible?.model}`);
    return parts.length ? `Detected: ${parts.join(', ')}.` : '';
  });

  // ── "Delete all" actions (per the bare-bones reset model) ──
  /** Downloaded local models a "delete all" would remove. */
  readonly downloadedModels = computed(() => this.models().filter((m) => m.downloaded));
  readonly confirmDeleteModels = signal(false);

  /** Remove every downloaded local LLM. Touches nothing on an engine. */
  async deleteAllModels(): Promise<void> {
    for (const m of this.downloadedModels()) {
      await this.ai.deleteModel(m.id);
    }
    this.confirmDeleteModels.set(false);
    await this.reload();
  }

  async ngOnInit(): Promise<void> {
    // Which routes are open, asked once. A failure to ask is reported as a
    // refusal naming the failure rather than left as "available": this value
    // decides whether the card tells the user a conversion can happen, and
    // guessing yes is the guess that wastes their time.
    void this.electron.vlmReaderStatus().then((s) => {
      this.wslReaderRefusal.set(
        s.success
          ? s.wslRefusal
          : `BookForge could not check the WSL page reader: ${s.error}`
      );
      // And WHICH MACHINE a conversion would go to. Without it this card drew a
      // route from three local facts and would say "this machine's GPU (WSL)"
      // for a run about to happen on a Crucible somewhere else.
      this.pagesVenue.set(s.success ? s.venue : null);
      this.pagesVenueRefusal.set(s.success ? s.venueRefusal : null);
    });

    this.unsub = this.ai.onModelProgress((p) => {
      this._progress.update((map) => {
        const next = { ...map };
        if (p.phase === 'download') {
          next[p.modelId] = p;
        } else {
          delete next[p.modelId];
        }
        return next;
      });
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') {
        void this.reload();
      }
    });
    await this.reload();
    await this.loadCrucibleServers();
    await this.loadCapability();
    // The engine's settings document, read on arrival and cached nowhere.
    await this.loadEngineSettings();
    this.sysInfo.set(await this.ai.systemInfo());
  }

  ngOnDestroy(): void {
    this.unsub?.();
  }

  private async reload(): Promise<void> {
    this.models.set(await this.ai.listLocalModels());
    await this.ai.refresh();
  }

  progressFor(id: string): LocalModelProgress | undefined {
    return this._progress()[id];
  }

  modelName(id: string): string {
    return this.models().find((m) => m.id === id)?.name ?? id;
  }

  /** Warn (but don't block) before committing to a model too big for this machine. */
  private async confirmIfTooBig(id: string, verb: string): Promise<boolean> {
    const m = this.models().find((x) => x.id === id);
    if (!m || m.fits) return true;
    const { confirmed } = await this.electron.showConfirmDialog({
      type: 'warning',
      title: `${m.name} is large for your hardware`,
      message: `${m.name} needs about ${m.minRAM} GB but this machine has less to spare.`,
      detail: 'It will still work, but it runs partly on the CPU and will be noticeably slower. The model marked "Recommended" fits your hardware and runs fast.',
      confirmLabel: `${verb} anyway`,
      cancelLabel: 'Cancel',
    });
    return confirmed;
  }

  async download(id: string): Promise<void> {
    if (this.wizard()) throw new Error('First-run model downloads are managed by Crucible.');
    if (!(await this.confirmIfTooBig(id, 'Download'))) return;
    // Seed an immediate 0% bar so the UI reacts before the first progress tick.
    this._progress.update((m) => ({ ...m, [id]: { modelId: id, pct: 0, receivedBytes: 0, totalBytes: 0, phase: 'download' } }));
    await this.ai.downloadModel(id);
  }

  async cancel(id: string): Promise<void> {
    await this.ai.cancelDownload(id);
  }

  async useModel(id: string): Promise<void> {
    if (!(await this.confirmIfTooBig(id, 'Use'))) return;
    await this.ai.setActiveModel(id);
    this.setProvider('local');
    await this.reload();
  }

  async remove(id: string): Promise<void> {
    await this.ai.deleteModel(id);
    await this.reload();
  }

  setProvider(provider: 'local'): void {
    this.settings.updateAIConfig({ provider });
  }

  // ── Crucible: a server from the registry, and a model that is RESIDENT ────
  //
  // The two pickers are separate facts with separate owners: the server list is
  // Settings → Crucible Servers' (enabled entries only — a disabled server is
  // one the queue may not use, and offering it here would be offering work to a
  // machine the operator switched off), and the model list is the SERVER's, with
  // its own four facts per row. Neither is defaulted: a server name is whatever
  // this machine called that machine, and a model id is whatever that host has
  // manifests for.
  //
  // RULING OWED: a queue ROW does not carry a Crucible server yet — the job
  // configs still carry provider + model + credentials and nothing else, so a
  // queued cleanup cannot yet name one. That field is 2.5's (`waitFor` per row,
  // crucible docs/PHASE7-LANES.md §4.2.1), and until it lands this choice is the
  // app's standing AI selection, honoured by the doors that take an
  // AIProviderConfig directly.

  /** Enabled servers, in rank order. Disabled ones are not offered. */
  readonly crucibleServers = signal<string[]>([]);
  readonly crucibleModels = signal<CrucibleModelRow[]>([]);
  readonly crucibleStatus = signal<{ ok: boolean; message: string } | null>(null);
  readonly crucibleTesting = signal(false);

  readonly usingCrucible = computed(() => this.settings.getAIConfig().provider === 'crucible');
  readonly managedCleanupModel = computed(() => {
    const clean = this.capability()?.classes.find((row) => row.capability === 'clean');
    return clean?.enabled ? clean.selected : '';
  });

  crucibleServer(): string { return this.settings.getAIConfig().crucible?.server ?? ''; }
  crucibleModel(): string { return this.settings.getAIConfig().crucible?.model ?? ''; }

  /** The chosen model's row, so the card can say what is wrong with it. */
  readonly chosenModel = computed<CrucibleModelRow | null>(() => {
    const id = this.settings.getAIConfig().crucible?.model;
    if (!id) return null;
    return this.crucibleModels().find((m) => m.id === id) ?? null;
  });

  /** The four facts, as one phrase. Never collapsed into "available". */
  modelState(m: CrucibleModelRow): string {
    if (m.resident) return 'resident';
    if (!m.backendSupported) return `not supported on this backend — ${m.reason ?? 'no reason given'}`;
    if (!m.installed) return `not installed — ${m.reason ?? 'no reason given'}`;
    if (!m.loadable) return `installed, not loadable — ${m.reason ?? 'no reason given'}`;
    return 'installed, loadable — not resident';
  }

  /** The enabled servers, from the same record the Servers row edits. */
  private async loadCrucibleServers(): Promise<void> {
    const res = await this.electron.crucible.servers();
    if (!res.success || !res.data) {
      // Not "no servers": that is a different sentence with a different fix.
      this.crucibleStatus.set({
        ok: false,
        message: res.error ?? 'The Crucible server list could not be read, and nothing said why.',
      });
      return;
    }
    this.crucibleServers.set(res.data.routing.ranked.filter((row) => row.enabled).map((row) => row.name));
    let chosen = this.settings.getAIConfig().crucible?.server;
    if (!chosen && this.wizard() && this.crucibleServers().length > 0) {
      chosen = this.crucibleServers()[0];
      this.settings.updateAIConfig({ crucible: { server: chosen, model: '' } });
    }
    if (chosen) await this.loadCrucibleModels(chosen);
  }

  private async loadCrucibleModels(server: string): Promise<void> {
    const res = await this.electron.crucible.models(server);
    if (server !== this.crucibleServer()) return;
    if (!res.success || !res.data) {
      this.crucibleModels.set([]);
      this.crucibleStatus.set({
        ok: false,
        message: res.error ?? `Asking "${server}" for its models failed and said nothing about why.`,
      });
      return;
    }
    if (res.data.outcome !== 'ok') {
      this.crucibleModels.set([]);
      this.crucibleStatus.set({ ok: false, message: res.data.message });
      return;
    }
    this.crucibleModels.set(res.data.models);
  }

  setCrucibleServer(server: string): void {
    if (this.engineBusy()) return;
    const current = this.settings.getAIConfig().crucible;
    // The model belongs to the server it was listed from, so changing the server
    // clears it rather than carrying an id the new machine may not have.
    this.settings.updateAIConfig({ crucible: { server, model: server === current?.server ? (current?.model ?? '') : '' } });
    this.crucibleStatus.set(null);
    this.crucibleModels.set([]);
    // The capability record belongs to the server too — a 24 GB box and a
    // 12 GB box answer differently — so it is re-asked, never carried over.
    this.capability.set(null);
    // AND SO DOES THE SETTINGS DOCUMENT, which is even less transferable: it
    // holds another machine's routes and another operator's accounts. Dropped
    // here through the one draw function, which also empties the key boxes —
    // a key typed for one engine must not be sitting in a field pointed at a
    // different one.
    this.redrawEngineSettings(null);
    this.testedModels.set({});
    if (server) {
      void this.loadCrucibleModels(server);
      void this.loadCapability();
      void this.loadEngineSettings();
    }
  }

  setCrucibleModel(model: string): void {
    const server = this.settings.getAIConfig().crucible?.server ?? '';
    this.settings.updateAIConfig({ crucible: { server, model } });
    this.crucibleStatus.set(null);
  }

  // ── A model per TEXT ACT (docs/CRUCIBLE_ROLLOUT_PLAN.md item 2.6) ─────────
  //
  // A SEPARATE RECORD FROM THE ONE ABOVE, and the separation is the point. The
  // picker above is the app's AI provider — the cleanup pass's own chat calls
  // through `ai-bridge.ts`, chosen per provider and stored with the rest of the
  // AI config. THESE four are what the FOUNDRY ENGINE is told with `--model`
  // when BookForge spawns it for clean / translate / simplify / analysis.
  //
  // WHICH MODEL IS STILL NOT CHOSEN HERE, and that has not changed
  // (2026-09-14). `<userData>/crucible-models.json` is deleted and
  // `GET /v1/capability` is the owner: `crucible install` probes the card and
  // picks the largest candidate each class fits on, so the mapping is a
  // per-HOST fact, and an id chosen in this app was a second opinion about a
  // decision that server had already made and might have refused (Owen's
  // ruling with Foundry, docs/CRUCIBLE_ROLLOUT_PLAN.md section 3).
  //
  // WHAT *IS* CHOSEN HERE, SINCE PHASE 15, IS **WHERE** — the route (§3.2):
  // this engine's own card, or an account it forwards to. Those are two
  // different questions with two different owners, and the Engine settings
  // panel below is careful to draw the first (`runsOnNow`, read-only, in the
  // engine's words) beside a control for the second. A screen that let
  // somebody pick a local model id would be the deleted record coming back.

  readonly textActs = CRUCIBLE_TEXT_ACT_NAMES;

  /** `GET /v1/capability` on the chosen server. Null until it has been asked. */
  readonly capability = signal<CrucibleCapabilityView | null>(null);

  private async loadCapability(): Promise<void> {
    const server = this.crucibleServer();
    if (!server) { this.capability.set(null); return; }
    const res = await this.electron.crucible.capability(server);
    if (server !== this.crucibleServer()) return;
    if (!res.success || !res.data) {
      // Never an empty record on failure: an empty class list reads as "this
      // server serves nothing", which is a different and false claim.
      this.capability.set(null);
      this.crucibleStatus.set({
        ok: false,
        message: res.error ?? `crucible "${server}" could not be asked what it can serve.`,
      });
      return;
    }
    this.capability.set(res.data);
    if (this.wizard() && this.managedCleanupModel()
      && (this.usingCrucible() || !this.ai.localUsable())) {
      this.useCrucible();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // THE ENGINE'S OWN SETTINGS — a window, not a copy (PHASE15 §3.1/§3.2/§5.2)
  // ─────────────────────────────────────────────────────────────────────────
  //
  // ── WHAT IS AND IS NOT STORED HERE ───────────────────────────────────────
  //
  // Nothing. There is no `SettingsService` field behind any of this, no
  // localStorage entry, no app-settings key and no cache: `engineSettings` is
  // what the selected engine answered on the last read, replaced by whatever
  // the next PUT answers with, and dropped the moment the server changes.
  // §0 is the reason — *"settings live in the engine and nowhere else"* — and
  // `tools/test-no-cloud-doors.js` is what keeps it true rather than this
  // paragraph.
  //
  // ── WHY EVERY WRITE RE-DRAWS FROM THE ANSWER ─────────────────────────────
  //
  // §3.2: the response to a `PUT` is the WHOLE document after the write. So a
  // control never draws what it sent; it draws what the engine ended up
  // holding. The two differ more often than it sounds — a route to `local` is
  // stored as an absent key and comes back with the model that class actually
  // selected, which nothing on this side could have known.
  //
  // ── AND WHY CAPABILITY IS RE-READ WITH IT ────────────────────────────────
  //
  // §2: the engine RECOMPUTES capability in-process on every settings write
  // that touches a route, because the route is part of the capability answer
  // (§3.3). The line under each row is drawn from capability, so a write that
  // did not re-read it would leave a row saying where the job used to run.

  /** The three names the contract gives the accounts. Never a free string. */
  readonly upstreamNames = CRUCIBLE_UPSTREAM_NAMES;

  /** The select's two sentinel values. A model id always has a slash, so neither can collide. */
  readonly LOCAL_ROUTE = 'local';
  readonly OTHER_ROUTE = '__other__';

  /** The wording file's sentences, exposed for the template and composed nowhere else. */
  readonly settingsIntroWords = ENGINE_SETTINGS_INTRO;
  readonly routesIntroWords = ENGINE_ROUTES_INTRO;
  readonly keysIntroWords = ENGINE_KEYS_INTRO;
  readonly localModelsIntroWords = ENGINE_LOCAL_MODELS_INTRO;
  readonly capabilityUndecidedWords = ENGINE_CAPABILITY_UNDECIDED;
  readonly fitCaveatWords = ENGINE_FIT_CAVEAT;

  /**
   * The option value that means "hand the choice back to the engine".
   *
   * A `<select>` speaks strings and `null` is what the wire carries, so the two
   * need a spelling between them. It is a SENTINEL and never a model id: the
   * engine's ids come out of the catalog and none of them is this.
   */
  readonly AUTOMATIC_MODEL = '__automatic__';
  readonly testBeforeSaveWords = TEST_BEFORE_SAVE_WORDS;
  readonly noServerWords = ENGINE_SETTINGS_NO_SERVER;
  readonly refusedLeadWords = ENGINE_SETTINGS_REFUSED_LEAD;
  readonly otherRouteWords = ROUTE_CHOICE_OTHER;
  readonly otherRouteHelpWords = ROUTE_CHOICE_OTHER_HELP;
  readonly otherRoutePlaceholder = ROUTE_CHOICE_OTHER_PLACEHOLDER;
  readonly offerModelPlaceholder = ROUTE_CHOICE_OTHER_PLACEHOLDER;

  /** `GET /v1/settings` for the selected server. Null until it has been read. */
  readonly engineSettings = signal<CrucibleEngineSettings | null>(null);

  /**
   * A refusal the engine gave that names NO control.
   *
   * `settings_door_absent`, `settings_unreachable`, a document this build
   * cannot read: none of those is about a field, so none of them goes beside
   * one. A refusal that DOES carry a `details.field` goes to
   * {@link fieldRefusals} instead and is drawn under the control it names —
   * which is the whole reason the server sends a dotted path.
   */
  readonly panelRefusal = signal<CrucibleEngineSettingsRefusal | null>(null);

  /** Dotted path → the engine's sentence about that control. */
  readonly fieldRefusals = signal<Record<string, { code: string; message: string }>>({});

  /**
   * WHAT IS TYPED IN A CREDENTIAL BOX, PER ACCOUNT, AND ONLY UNTIL THE NEXT
   * DRAW.
   *
   * §5.2: *"A key field is empty on every draw (write-only) with the hint
   * beside it."* {@link redrawEngineSettings} clears this, and it is the only
   * function that puts a document on the screen, so a key cannot survive a
   * successful Save, a refusal, a re-read or a change of server. It reaches
   * `settings.service.ts` nowhere: this signal and the one request that
   * carries it are the whole of its life in this process.
   */
  private readonly upstreamDrafts = signal<Record<string, string>>({});

  /** A typed upstream model id, per act, for the free-text route choice. */
  private readonly routeDrafts = signal<Record<string, string>>({});

  /** Which select option each act is showing — only ever `OTHER_ROUTE` or unset. */
  private readonly routeChoices = signal<Record<string, string>>({});

  /** Per act: which account the wizard's one-press offer would use. */
  private readonly offerUpstreams = signal<Record<string, CrucibleUpstreamName>>({});
  /** Per act: the model id that offer would route to. */
  private readonly offerModels = signal<Record<string, string>>({});

  /**
   * WHAT EACH ACCOUNT ANSWERED THE LAST TEST WITH.
   *
   * This is the only model list in the app. §2: *"the server does not ship a
   * cloud model list"*, and neither does BookForge — a hardcoded three-item
   * array was the audit's third finding. These ids came back from the
   * operator's own account through the engine, seconds before they were
   * shown, and they are gone when the panel is.
   */
  private readonly testedModels = signal<Record<string, string[]>>({});

  /** A request is in flight. Every control is disabled, so two cannot race. */
  readonly engineBusy = signal(false);

  // ── Reading, and the one function that puts a document on the screen ─────

  private async loadEngineSettings(): Promise<void> {
    const server = this.crucibleServer();
    if (!server) { this.redrawEngineSettings(null); return; }
    const res = await this.electron.crucible.engineSettings(server);
    if (server !== this.crucibleServer()) return;
    if (!res.success || !res.data) {
      this.redrawEngineSettings(null);
      this.placeRefusal(res.refusal, res.error);
      return;
    }
    this.redrawEngineSettings(res.data);
  }

  /**
   * THE ONE DRAW. Every path onto the screen goes through here, which is what
   * makes "the key box is empty on every draw" a property of the code rather
   * than a discipline: there is nowhere else to put a document.
   */
  private redrawEngineSettings(doc: CrucibleEngineSettings | null): void {
    this.engineSettings.set(doc);
    this.panelRefusal.set(null);
    this.fieldRefusals.set({});
    this.upstreamDrafts.set({});
    this.routeChoices.set({});
    this.routeDrafts.set({});
  }

  /**
   * A NO, PUT WHERE IT BELONGS.
   *
   * §3.2 pins `details.field` as a dotted path — `routes.translate`,
   * `upstreams.anthropic.key` — precisely so a panel can say the sentence
   * beside the control instead of at the top of a page with eight controls on
   * it. A refusal with no field has nowhere particular to go and goes to the
   * top, which is the truth about it and not a gap being filled.
   */
  private placeRefusal(refusal: CrucibleEngineSettingsRefusal | undefined, error?: string): void {
    if (refusal === undefined) {
      // A failed call with no named refusal: the door itself did not answer.
      // Shown at the top with whatever main said, never swallowed.
      this.panelRefusal.set({
        code: 'unnamed',
        message: error ?? 'The engine could not be reached, and nothing said why.',
        field: null,
        classes: null,
      });
      return;
    }
    // `upstream_in_use` carries the classes still routed to the account
    // somebody tried to remove. They are named, because "re-route those first"
    // is the fix and a message without them does not say which.
    const classes = refusal.classes === null || refusal.classes === undefined || refusal.classes.length === 0
      ? ''
      : ` Still routed there: ${refusal.classes.map(capabilityClassWords).join(', ')}.`;
    const message = `${refusal.message}${classes}`;
    if (refusal.field === null || refusal.field === undefined || refusal.field === '') {
      this.panelRefusal.set({ ...refusal, message });
      return;
    }
    this.fieldRefusals.update((map) => ({
      ...map,
      [refusal.field as string]: { code: refusal.code, message },
    }));
  }

  /**
   * The refusal for one dotted path, or undefined. Drawn under that control.
   *
   * CODE AND SENTENCE, not just the sentence. §3.2's names are the contract
   * between this app and the engine, and a person who reads
   * `route_upstream_unconfigured` on their screen can be told what it means by
   * somebody who has never seen this build.
   */
  refusalFor(field: string): { code: string; message: string } | undefined {
    return this.fieldRefusals()[field];
  }

  /**
   * The sentence for one account's card, whichever of its two field paths the
   * engine named. `upstreams.anthropic.key` and `upstreams.anthropic` are the
   * same card, and a refusal about one that appeared nowhere because it was
   * spelled as the other would be a silent no.
   */
  refusalForUpstream(name: CrucibleUpstreamName): { code: string; message: string } | undefined {
    const map = this.fieldRefusals();
    for (const [field, refusal] of Object.entries(map)) {
      if (field === `upstreams.${name}` || field.startsWith(`upstreams.${name}.`)) return refusal;
    }
    return undefined;
  }

  // ── Writing: one PUT, then re-draw from the answer ───────────────────────

  /**
   * Send one patch and re-draw from what came back.
   *
   * Answers whether it took, so a caller that wanted to do something after a
   * successful write can — and so a refusal is never mistaken for a save.
   */
  private async writeEngineSettings(patch: CrucibleEngineSettingsPatch): Promise<boolean> {
    const server = this.crucibleServer();
    if (!server) return false;
    this.engineBusy.set(true);
    try {
      const res = await this.electron.crucible.writeEngineSettings(server, patch);
      if (server !== this.crucibleServer()) return false;
      if (!res.success || !res.data) {
        // NOTHING WAS APPLIED (§3.2: "a refusal applies nothing"), so the
        // document on the screen is still true and is left alone. Only the
        // refusal is placed.
        this.placeRefusal(res.refusal, res.error);
        return false;
      }
      this.redrawEngineSettings(res.data);
      // The engine recomputed capability as part of the write; re-read it so
      // the line under each row is about where the job runs NOW.
      await this.loadCapability();
      return true;
    } finally {
      this.engineBusy.set(false);
    }
  }

  // ── Which model does each job ─────────────────────────────────────────────
  //
  // Owen's Ollama ruling (2026-09-16): every Crucible setting is configured
  // through the apps. The engine computes what may serve each class — it ships
  // these models for this class on this backend, and measures them against its
  // own budget — and this draws that and writes a choice back. Nothing here
  // ranks, filters or validates: `local_model_unknown`,
  // `local_model_not_selectable`, `local_model_does_not_fit` and
  // `capability_undecided` are the ENGINE's refusals and they arrive with
  // `field: local_models.<capability>`, which puts each one under its own row.

  /** The classes this engine offers a choice for, in its own order. */
  readonly localClasses = computed<string[]>(() => {
    const models = this.engineSettings()?.localModels;
    if (!models) return [];
    return Object.keys(models.choices).sort();
  });

  localChoices(capability: string): CrucibleLocalModelChoice[] {
    return this.engineSettings()?.localModels?.choices[capability] ?? [];
  }

  /**
   * What the control shows: the engine's selection, or the automatic sentinel.
   *
   * `null` is a DECISION — "you choose" — so it maps to the sentinel rather
   * than to an empty control. A class missing from `selected` entirely would be
   * a document this app cannot read, and `projectLocalModels` has already
   * refused that, so it cannot arrive here.
   */
  localSelectValue(capability: string): string {
    const selected = this.engineSettings()?.localModels?.selected[capability];
    return selected === null || selected === undefined ? this.AUTOMATIC_MODEL : selected;
  }

  /** `qwen3.5-9b — 19.5 GiB` , or `… — 52.5 GiB, larger than this card`. */
  localChoiceWords(choice: CrucibleLocalModelChoice): string {
    const size = `${(choice.memoryBytesEstimate / 1024 ** 3).toFixed(1)} GiB`;
    const parts = [size];
    if (!choice.fits) parts.push('larger than this card');
    if (!choice.installed) parts.push('not downloaded yet');
    return `${choice.id} — ${parts.join(', ')}`;
  }

  /**
   * Write the choice, and PUT THE CONTROL BACK if the engine refuses it.
   *
   * A refusal applies nothing, so the engine still holds what it held — but the
   * `<select>` is by then showing the value the person picked, and the bound
   * `[value]` will not put it back because the document it reads never changed.
   * The control and the machine would disagree silently, and the next write
   * would patch from a baseline that was never true. So the element is reset
   * from the document by hand. (Foundry hit this first; its card does the same.)
   */
  async chooseLocalModel(capability: string, element: HTMLSelectElement): Promise<void> {
    const chosen = element.value;
    const wrote = await this.writeEngineSettings({
      localModels: { [capability]: chosen === this.AUTOMATIC_MODEL ? null : chosen },
    });
    if (!wrote) element.value = this.localSelectValue(capability);
  }

  // ── The four route rows ──────────────────────────────────────────────────

  /** A class's name for a person: `translating`, not `translate`. */
  classWords(act: string): string { return capabilityClassWords(act); }

  /**
   * WHERE THIS CLASS RUNS RIGHT NOW, in the engine's own words.
   *
   * The `??` is a COMPOSITION OF TWO ANSWERS and not a fallback for a missing
   * one. {@link routeWords} answers `null` on purpose for a class that runs on
   * the engine's own card — "there is nothing extra to say about the ordinary
   * case", its own comment — and the ordinary case is exactly what
   * {@link capabilityWords} states: the model, or the server's reason it has
   * none. Neither function can fail to answer, so nothing is being papered
   * over; what is being done is asking the more specific question first.
   *
   * Both live in the one wording file, where Settings → Pipeline Defaults and
   * the translation panel read them too — two screens composing this sentence
   * separately is the one-fact-two-owners shape the audit exists to prevent.
   */
  runsOnNow(act: CrucibleTextActName): string {
    return routeWords(this.capability(), act) ?? capabilityWords(this.capability(), act);
  }

  /** `this engine — qwen3.5-9b`, or `this engine — nothing on it fits`. */
  localOptionFor(act: CrucibleTextActName): string {
    const doc = this.engineSettings();
    if (doc === null) return localRouteWords(null);
    const row = doc.routes[act];
    // The local model for a class that is CURRENTLY routed upstream is not in
    // the document — §3.1 puts the selected local model on a `local` row only
    // — so the honest answer there is the capability record's, which keeps the
    // local sentence after "the local answer would be:".
    return row.route === 'local' ? localRouteWords(row) : localRouteWords(null);
  }

  /** `Anthropic — claude-sonnet-5`, from an id the operator or an account gave. */
  upstreamOptionFor(id: string): string { return upstreamRouteWords(id); }

  /**
   * EVERY UPSTREAM MODEL ID THIS PANEL CAN OFFER, and where each came from.
   *
   * Two sources, both of them facts rather than a catalog: the ids the
   * document's own routes already name (so routing a second class to the model
   * a first one uses needs no typing), and the ids a Test got back from the
   * account itself. There is no third source, because a third source would be
   * BookForge shipping a cloud model list.
   */
  upstreamModelChoices(): string[] {
    const ids = new Set<string>();
    const doc = this.engineSettings();
    if (doc !== null) {
      for (const act of this.textActs) {
        const row = doc.routes[act];
        if (row.route === 'upstream' && row.model !== null) ids.add(row.model);
      }
    }
    for (const [name, models] of Object.entries(this.testedModels())) {
      for (const model of models) ids.add(`${name}/${model}`);
    }
    return [...ids].sort();
  }

  /** Which option the select is showing: the routed id, `local`, or the free-text one. */
  routeSelectValue(act: CrucibleTextActName): string {
    if (this.routeChoices()[act] === this.OTHER_ROUTE) return this.OTHER_ROUTE;
    const doc = this.engineSettings();
    if (doc === null) return this.LOCAL_ROUTE;
    const row = doc.routes[act];
    return row.route === 'upstream' && row.model !== null ? row.model : this.LOCAL_ROUTE;
  }

  routeDraft(act: CrucibleTextActName): string { return this.routeDrafts()[act] ?? ''; }

  setRouteDraft(act: CrucibleTextActName, value: string): void {
    this.routeDrafts.update((map) => ({ ...map, [act]: value }));
  }

  /** Picking an option IS the write, except for the one that opens a box. */
  async chooseRoute(act: CrucibleTextActName, value: string): Promise<void> {
    if (value === this.OTHER_ROUTE) {
      this.routeChoices.update((map) => ({ ...map, [act]: this.OTHER_ROUTE }));
      return;
    }
    this.routeChoices.update((map) => ({ ...map, [act]: '' }));
    await this.writeEngineSettings({ routes: { [act]: value } });
  }

  /**
   * The free-text id, sent AS TYPED.
   *
   * Nothing here checks the shape first. `route_bad_model` is the engine's
   * refusal for an id with no slash or an account it does not know, it arrives
   * with `field: routes.<act>` and lands under this box — and a second
   * validator on this side would be a second opinion about which ids are
   * legal, disagreeing with the engine the first time either of them changes.
   */
  async setRouteFromDraft(act: CrucibleTextActName): Promise<void> {
    const id = this.routeDraft(act).trim();
    if (id.length === 0) return;
    await this.writeEngineSettings({ routes: { [act]: id } });
  }

  // ── The three account cards ──────────────────────────────────────────────

  upstreamTitle(name: CrucibleUpstreamName): string { return upstreamWordsLeading(name); }

  /** `Set up — …k3A9`, with the hint rendered exactly as the engine sent it. */
  upstreamState(name: CrucibleUpstreamName, doc: CrucibleEngineSettings): string {
    return upstreamStateWords(name, doc.upstreams[name]);
  }

  fieldLabel(name: CrucibleUpstreamName): string { return upstreamFieldWords(name).label; }
  fieldPlaceholder(name: CrucibleUpstreamName): string { return upstreamFieldWords(name).placeholder; }
  /**
   * A key is masked while it is typed; an address is not a secret.
   *
   * WHICH of the two an account takes is {@link upstreamCredentialField}'s to
   * say, not this file's: §3.2 gives each upstream exactly one field and
   * refuses the other by name, and a `name === 'ollama'` here would be this
   * panel knowing a vendor — the first shape `tools/test-no-cloud-doors.js`
   * calls provider code coming back.
   */
  fieldType(name: CrucibleUpstreamName): string {
    return upstreamCredentialField(name) === 'url' ? 'text' : 'password';
  }

  draftFor(name: CrucibleUpstreamName): string { return this.upstreamDrafts()[name] ?? ''; }

  setDraft(name: CrucibleUpstreamName, value: string): void {
    this.upstreamDrafts.update((map) => ({ ...map, [name]: value }));
  }

  /** What the last Test found for this account, as a sentence, or null. */
  testedWordsFor(name: CrucibleUpstreamName): string | null {
    const models = this.testedModels()[name];
    return models === undefined ? null : upstreamTestedWords(name, models);
  }

  /**
   * ONE UPSTREAM PROBE, BUILT FROM WHAT IS TYPED.
   *
   * An empty draft is an EMPTY PROBE, which the contract gives its own meaning
   * (§3.2): test what is already configured. So "press Test with nothing
   * typed" checks the stored key rather than sending a blank one, which is
   * what somebody pressing it on a configured card means.
   */
  private probeFor(name: CrucibleUpstreamName): CrucibleUpstreamProbe {
    const typed = this.draftFor(name).trim();
    if (typed.length === 0) return {};
    return upstreamCredentialField(name) === 'url' ? { url: typed } : { key: typed };
  }

  /**
   * TEST, WHICH STORES NOTHING.
   *
   * The probe crosses to the engine, the engine calls the account with it, and
   * the account's own model listing comes back. Nothing is written on the way
   * — which is what makes Test-before-Save a fact rather than a label, and is
   * pinned by `tools/test-crucible-settings-seam.js` against a fake that is
   * capable of storing one.
   */
  async testUpstreamAccount(name: CrucibleUpstreamName): Promise<void> {
    const server = this.crucibleServer();
    if (!server) return;
    this.engineBusy.set(true);
    try {
      const res = await this.electron.crucible.testUpstream(server, name, this.probeFor(name));
      if (server !== this.crucibleServer()) return;
      if (!res.success || !res.data) { this.placeRefusal(res.refusal, res.error); return; }
      if (!res.data.ok) {
        // The ACCOUNT's own no — a rejected key, an address nothing answers
        // at. It belongs beside the field, and the engine says which field.
        this.placeRefusal(res.data.refusal, undefined);
        return;
      }
      this.fieldRefusals.update((map) => {
        const next = { ...map };
        delete next[`upstreams.${name}.key`];
        delete next[`upstreams.${name}.url`];
        delete next[`upstreams.${name}`];
        return next;
      });
      this.testedModels.update((map) => ({ ...map, [name]: (res.data as { ok: true; models: string[] }).models }));
    } finally {
      this.engineBusy.set(false);
    }
  }

  /** Save: one PUT that configures this account and changes no route. */
  async saveUpstream(name: CrucibleUpstreamName): Promise<void> {
    const typed = this.draftFor(name).trim();
    if (typed.length === 0) return;
    const probe = this.probeFor(name);
    await this.writeEngineSettings({
      upstreams: { [name]: probe as { key: string } | { url: string } },
    });
  }

  /**
   * Remove: `null` for that account, which the engine refuses with
   * `upstream_in_use` while a route still names it — and names the classes, so
   * the fix is on the screen rather than in a manual.
   */
  async removeUpstream(name: CrucibleUpstreamName): Promise<void> {
    await this.writeEngineSettings({ upstreams: { [name]: null } });
  }

  // ── The wizard's step: what this engine cannot do, and the one press ─────

  /**
   * THE CLASSES THIS ENGINE CANNOT SERVE, GROUPED BY THE REASON IT GAVE.
   *
   * {@link unavailableGroups} is what collapses them, and the collapse is the
   * contract's (§3.3): on a `llama-windows` engine the five Python-job classes
   * answer with one identical sentence *"so an app shows it once"*. Each group
   * also carries the subset of its classes that CAN be routed to an account —
   * only `clean translate simplify analysis` can (§1), everything else is
   * refused `route_not_routable` — so the offer is only made where it is real.
   */
  unavailableOffers(): { reason: string; capabilities: string[]; routable: CrucibleTextActName[] }[] {
    const acts = new Set<string>(this.textActs);
    return unavailableGroups(this.capability()).map((group) => ({
      ...group,
      routable: group.capabilities.filter((c) => acts.has(c)) as CrucibleTextActName[],
    }));
  }

  offerWords(capabilities: readonly string[]): string { return unavailableOfferWords(capabilities); }
  noticeWords(capabilities: readonly string[]): string { return unavailableNoticeWords(capabilities); }

  /**
   * Which account the offer would use. The first of the three until somebody
   * says otherwise — a starting position for a select, not a route: nothing is
   * written until the button is pressed.
   */
  offerUpstream(act: CrucibleTextActName): CrucibleUpstreamName {
    return this.offerUpstreams()[act] ?? this.upstreamNames[0];
  }

  setOfferUpstream(act: CrucibleTextActName, name: string): void {
    this.offerUpstreams.update((map) => ({ ...map, [act]: name as CrucibleUpstreamName }));
  }

  offerModel(act: CrucibleTextActName): string { return this.offerModels()[act] ?? ''; }

  setOfferModel(act: CrucibleTextActName, value: string): void {
    this.offerModels.update((map) => ({ ...map, [act]: value }));
  }

  offerButton(act: CrucibleTextActName): string {
    return offerButtonWords(this.offerUpstream(act), act);
  }

  /**
   * ENTER A KEY AND ROUTE A CLASS TO IT, IN ONE PRESS.
   *
   * §5.2, verbatim: *"entering a key calls `test`, then one `PUT` that
   * configures the upstream AND sets the route, then capability is re-read and
   * the step shows the new answer."* So:
   *
   *   1. **Test first, with what was typed.** A key that the account rejects
   *      must never be stored, and testing after saving would store it and
   *      then complain. A refusal here writes nothing and lands beside the
   *      field the engine named.
   *   2. **The account's own model list is remembered**, which is what fills
   *      the suggestion box. It is also why step 3 can be honest about not
   *      knowing which model to use.
   *   3. **No model named: stop, and say so.** The engine will not guess which
   *      of an account's models a job should run on, and neither will this —
   *      picking the first id in a list is this app choosing a model again,
   *      which is the exact second opinion the capability record exists to
   *      end. Nothing was saved; the press is repeated with a model in the box
   *      and then it is one press.
   *   4. **ONE PUT carrying BOTH.** `{upstreams, routes}` together: the engine
   *      applies upstreams, then routes, then validates, and a refusal applies
   *      nothing (§3.2) — so there is no window in which the key is stored and
   *      the route is not, and no half-configured engine to clean up after.
   *   5. **Capability is re-read** by {@link writeEngineSettings}, because the
   *      engine recomputed it and the step's answer is drawn from it.
   */
  async connectAndRoute(act: CrucibleTextActName): Promise<void> {
    const server = this.crucibleServer();
    if (!server) return;
    const name = this.offerUpstream(act);
    const probe = this.probeFor(name);

    this.engineBusy.set(true);
    let models: string[];
    try {
      const test = await this.electron.crucible.testUpstream(server, name, probe);
      if (server !== this.crucibleServer()) return;
      if (!test.success || !test.data) { this.placeRefusal(test.refusal, test.error); return; }
      if (!test.data.ok) { this.placeRefusal(test.data.refusal, undefined); return; }
      models = test.data.models;
      this.testedModels.update((map) => ({ ...map, [name]: models }));
    } finally {
      this.engineBusy.set(false);
    }

    const model = this.offerModel(act).trim();
    if (model.length === 0) {
      /*
       * NOT A REFUSAL FROM THE ENGINE — the engine was never asked. Nobody
       * typed a model id, so this app is the one saying no, and it says so
       * under its own name rather than borrowing one of §3.2's: a person who
       * searched for `route_bad_model` because they saw it here would find a
       * refusal about a slash, which is not what happened.
       */
      this.fieldRefusals.update((map) => ({
        ...map,
        [`routes.${act}`]: {
          code: 'no_model_named',
          message: `${upstreamTestedWords(name, models)} ${nameAModelWords(name)}`,
        },
      }));
      return;
    }

    // ONE PATCH. The probe is included only when something was typed: an
    // account that is already set up is routed to without its key being
    // re-sent, because there is nothing to re-send.
    const patch: CrucibleEngineSettingsPatch = { routes: { [act]: `${name}/${model}` } };
    if (Object.keys(probe).length > 0) {
      patch.upstreams = { [name]: probe as { key: string } | { url: string } };
    }
    await this.writeEngineSettings(patch);
  }

  /**
   * The connection check, through the provider itself — ping, then the model
   * list over the bearer token, which is what tells "wrong address" from "wrong
   * token" and reports only what is RESIDENT.
   */
  async testCrucible(): Promise<void> {
    const server = this.crucibleServer();
    if (!server) return;
    this.crucibleTesting.set(true);
    try {
      const answer = await this.electron.checkAIConnection('crucible', server);
      if (server !== this.crucibleServer()) return;
      this.crucibleStatus.set({
        ok: answer.available,
        message: answer.available
          ? (answer.models && answer.models.length > 0
            ? `"${server}" is serving ${answer.models.join(', ')}.`
            : `"${server}" answered, and nothing is resident on it — a cleanup would be refused until a model is loaded.`)
          : (answer.error ?? 'The check failed and said nothing about why.'),
      });
      await this.loadCrucibleModels(server);
    } finally {
      this.crucibleTesting.set(false);
    }
  }

  /** Make this the app's AI. The model must be resident when a run starts. */
  useCrucible(): void {
    const server = this.crucibleServer();
    const model = this.wizard() ? this.managedCleanupModel() : this.crucibleModel();
    if (!server || !model) return;
    this.settings.updateAIConfig({ provider: 'crucible', crucible: { server, model } });
    void this.ai.refresh();
  }

  /*
   * `ollamaUrl`, `setOllamaUrl` and `testOllama` ARE DELETED (2026-09-14),
   * with the card that used them. An Ollama server is an UPSTREAM the engine
   * is configured with, not a provider this app talks to, so its address is
   * the engine's setting and the reachability question is the engine's to
   * answer.
   */

  // ── Reading pages: MLX here, or a server somewhere else ───────────────────
  //
  // The setting the Convert to EPUB action carries to main on every run
  // (shared/vlm/conversion.ts). Written straight through to settings on change,
  // there is no Save button on this card and a
  // draft that looked saved but was not would be discovered ninety minutes into
  // a conversion.

  /** foundry's own default pages-in-flight, shown as the placeholder. */
  readonly defaultConcurrency = String(DEFAULT_VLM_CONCURRENCY);

  /** The last Test result, as a sentence. */
  readonly vlmStatus = signal<{ ok: boolean; message: string } | null>(null);
  readonly vlmTesting = signal(false);

  /**
   * Why the WSL page reader is unavailable, as main last reported it.
   *
   * `undefined` while the answer has not arrived yet, which is NOT the same as
   * "available": a card that rendered "ready" for the first frame and then
   * corrected itself would be worse than one that says nothing for a moment.
   */
  readonly wslReaderRefusal = signal<string | null | undefined>(undefined);

  /**
   * Why no machine can read the pages, or null when one can.
   *
   * The SAME function main refuses a conversion with, given the same facts — so
   * the card cannot promise a route the run will then deny. Note it resolves to
   * null as soon as ANY route is open, including the WSL one, which is why this
   * no longer says "needs an Apple Silicon Mac" on a correctly configured PC.
   */
  /** Which machine main has routed page reading to, and its refusal if it could not decide. */
  readonly pagesVenue = signal<VlmVenue | null>(null);
  readonly pagesVenueRefusal = signal<string | null>(null);

  /** The route this card describes — the same three questions the run asks. */
  readonly pagesRoute = computed<VlmRoute | null>(() => {
    const wsl = this.wslReaderRefusal();
    if (wsl === undefined) return null;
    return resolveVlmRouteWithVenue({
      platform: this.electron.platform,
      arch: this.electron.arch,
      endpoint: this.settings.getVlmEndpointConfig().url.trim().length > 0
        ? this.settings.getVlmEndpointConfig()
        : null,
      wslReaderRefusal: wsl,
      venue: this.pagesVenue(),
      venueRefusal: this.pagesVenueRefusal(),
    });
  });

  readonly localReadingRefusal = computed(() => {
    const route = this.pagesRoute();
    return route !== null && route.kind === 'refused' ? route.reason : null;
  });

  /**
   * WHICH GPU READS THE PAGES, in the card's own words — the line that tells
   * somebody which machine is unavailable for the next ninety minutes.
   *
   * Null while the answer has not arrived; a card that guessed would be naming
   * a machine on no evidence.
   */
  readonly pagesRouteLabel = computed<string | null>(() => {
    const route = this.pagesRoute();
    if (route === null || route.kind === 'refused') return null;
    return vlmRouteLabel(route);
  });

  vlmUrl(): string { return this.settings.getVlmEndpointConfig().url; }
  vlmModel(): string { return this.settings.getVlmEndpointConfig().model; }
  vlmConcurrency(): number { return this.settings.getVlmEndpointConfig().concurrency; }

  setVlmUrl(url: string): void {
    this.settings.updateVlmEndpointConfig({ url: url.trim() });
    this.vlmStatus.set(null);
  }

  setVlmModel(model: string): void {
    this.settings.updateVlmEndpointConfig({ model: model.trim() });
    this.vlmStatus.set(null);
  }

  /**
   * Pages in flight. A blank box means "foundry's default", which is 0 here —
   * never the remembered number, so clearing the field cannot leave a value
   * behind that the placeholder denies.
   */
  setVlmConcurrency(value: string): void {
    const trimmed = (value ?? '').trim();
    if (trimmed.length === 0) {
      this.settings.updateVlmEndpointConfig({ concurrency: 0 });
      this.vlmStatus.set(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      this.vlmStatus.set({
        ok: false,
        message: `"${trimmed}" is not a whole number of pages. Leave it empty for foundry's `
          + `default of ${DEFAULT_VLM_CONCURRENCY}.`,
      });
      return;
    }
    this.settings.updateVlmEndpointConfig({ concurrency: n });
    this.vlmStatus.set(null);
  }

  /** GET the server's model list and say exactly what came back. */
  async testVlmEndpoint(): Promise<void> {
    const config = this.settings.getVlmEndpointConfig();
    if (!config.url.trim()) {
      this.vlmStatus.set({
        ok: !this.localReadingRefusal(),
        message: this.localReadingRefusal()
          ?? 'No server set — the pages are read on this machine with MLX.',
      });
      return;
    }
    this.vlmTesting.set(true);
    try {
      const answer = await this.electron.checkVlmEndpoint(config);
      if (!answer.success || !answer.check) {
        this.vlmStatus.set({ ok: false, message: answer.error || 'The check failed and said nothing about why.' });
        return;
      }
      const { check } = answer;
      this.vlmStatus.set({
        ok: check.reachable && check.modelMissing === undefined,
        message: describeVlmEndpointCheck(config.url.trim(), check),
      });
    } finally {
      this.vlmTesting.set(false);
    }
  }


  // `openExternal` went with the Ollama card's "Get Ollama" button — the only
  // thing on this page that ever sent somebody to a download.

  goSettings(): void {
    void this.router.navigate(['/settings']);
  }

  close(): void {
    void this.router.navigate(['/studio']);
  }
}
