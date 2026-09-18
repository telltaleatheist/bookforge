import { Component, DestroyRef, inject, signal, computed, effect, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { AiSetupWizardComponent } from '../ai-setup/ai-setup-wizard.component';
import { AddOnsPanelComponent } from '../settings/components/add-ons-panel.component';
import { CrucibleDoorsComponent } from '../settings/components/crucible-doors.component';
import { AiService } from '../../core/services/ai.service';
import { RuntimeService } from '../../core/services/runtime.service';
import { ComponentService } from '../../core/services/component.service';
import { SetupDownloadService } from '../../core/services/setup-download.service';
import { LibraryService } from '../../core/services/library.service';
import { ElectronService } from '../../core/services/electron.service';
import { StudioService } from '../studio/services/studio.service';
import type { CrucibleCoordinationState } from '@shared/crucible/coordinate-wire';
import { coordinationWords } from '../settings/components/crucible-words';

interface SetupStep {
  id: 'library' | 'ai' | 'crucible' | 'review';
  title: string;
  subtitle: string;
}

/**
 * First-run guided setup — FOUR STEPS since 2026-09-14.
 *
 * Shown once, immediately after library onboarding completes (app.ts →
 * onOnboardingComplete), and reachable later from Settings → General → Guided
 * setup, where it is titled "Configuration" and has a close button.
 *
 * ── THE RULE THE SHAPE FOLLOWS ─────────────────────────────────────────────
 *
 * `docs/SETUP-AND-SETTINGS-AROUND-CRUCIBLE.md` §6: **a setup step exists only
 * for something the app itself owns.** Files, credentials, and which server.
 * Everything about a model, a voice, an engine environment or a card belongs to
 * Crucible's own page, reached with one button.
 *
 *   1. **Library** — where your books live. The one step nobody may skip, and
 *      (since this rework) the one step you can go BACK to.
 *   2. **AI and cloud keys** — which Crucible does the reading and writing.
 *      Cloud keys are Foundry's, said in one sentence and not re-implemented.
 *   3. **Crucible** — where the GPU work happens. PROBES ON ENTRY and shows one
 *      of three faces (PHASE13-OPERATOR.md §5.5).
 *   4. **Review** — what was chosen, plus the three small local tools.
 *
 * ── WHAT WAS DELETED, AND WHY IT WAS ONE STEP AND NOT FOUR ────────────────
 *
 * Orpheus, Higgs, Voice enhancement and the engine half of Optional tools.
 * Each of them stood up a LOCAL copy of an engine: a conda env, a CUDA pack, a
 * multi-gigabyte checkpoint — ~250 GB between them (rollout §0b A2). Every one
 * is a Crucible job type or a subject a Crucible holds ONCE PER MACHINE
 * (rollout §2 ruling 1), so four screens that each installed a private engine
 * collapse into one question: which server. Orpheus additionally is DEPRECATED
 * (Owen, 2026-09-14) and Higgs is the one narration engine.
 *
 * The multi-worker toggle went with the Tools step and was not re-homed: it
 * persisted nowhere and its only implementation is an explicit no-op
 * (`orpheus-worker-pool.ts` `setStreamWorkerConfig`), so it was a control that
 * reported success and changed nothing.
 */
@Component({
  selector: 'app-first-run-setup',
  standalone: true,
  imports: [
    CommonModule,
    AiSetupWizardComponent,
    AddOnsPanelComponent,
    CrucibleDoorsComponent
  ],
  template: `
    <div class="setup-page">
      <div class="setup-card" [class.compact]="isLast() || finishing()">
        <header class="card-head">
          <div class="head-row">
            <h1>{{ firstRun() ? 'Set up BookForge' : 'Configuration' }}</h1>
            <div class="head-right">
              <!-- Engine status as a compact inline pill (not a full-width banner
                   repeated on every step) — declutters the body. -->
              <span class="engine-pill" [class.ready]="runtime.ready()">
                @if (runtime.ready()) {
                  <span class="engine-check">&#10003;</span> Local tools ready
                } @else {
                  <span class="engine-spinner"></span> Local tools setting up…
                }
              </span>
              <!-- First run is mandatory — no skip. Reopened later as
                   "Configuration" it gets a close (X) instead. -->
              @if (!firstRun()) {
                <button type="button" class="close-x" (click)="closeConfig()" aria-label="Close" title="Close">&#10005;</button>
              }
            </div>
          </div>

          <!-- Step indicator -->
          <div class="steps-indicator">
            <span class="step-count">Step {{ currentStep() + 1 }} of {{ steps.length }}</span>
            <div class="dots">
              @for (s of steps; track s.id; let i = $index) {
                <span
                  class="dot"
                  [class.done]="i < currentStep()"
                  [class.active]="i === currentStep()"
                ></span>
              }
            </div>
          </div>
        </header>

        @if (modelPreparing()) {
          <div class="finishing" role="status" aria-live="polite">
            <span class="engine-spinner big"></span>
            <h2>Preparing your models</h2>
            <p>BookForge and Foundry are preparing your selected capabilities. Setup finishes after they are verified ready.</p>
            @for (state of modelProgress(); track state.server) {
              <p><strong>{{ state.server }}</strong>: {{ modelProgressWords(state) }}</p>
            }
            <p>You can close BookForge and resume setup later.</p>
          </div>
        } @else if (finishing()) {
          <!-- Finishing view: the user hit Done/Finish but the engine is still
               unpacking. Sit here with prominent progress; the effect navigates
               to Studio automatically once it's ready. Back returns to configuring. -->
          <div class="finishing">
            <span class="engine-spinner big"></span>
            <h2>This will take a while…</h2>
            <p class="finishing-sub">
              We’re downloading the audiobook engine, the default voice, and the
              English language pack. BookForge will open automatically the moment
              it’s done — you don’t need to wait here.
            </p>
            <div class="finish-bar">
              <div class="finish-bar-fill" [style.width.%]="runtime.setupProgress()"></div>
            </div>
            @if (runtime.downloadEtaLabel(); as eta) {
              <p class="finish-stage">{{ runtime.downloadSizeLabel() }} · {{ eta }}</p>
            } @else {
              <p class="finish-stage">{{ runtime.status().message }} · {{ runtime.setupProgress() }}%</p>
            }
          </div>
          <footer class="card-foot">
            <button type="button" class="btn ghost" (click)="back()">Back to settings</button>
            <div class="spacer"></div>
            <span class="finishing-hint"><span class="engine-spinner"></span> Opening when ready…</span>
          </footer>
        } @else {
        <!-- Per-step heading -->
        <div class="step-head">
          <h2>{{ active().title }}</h2>
          <p class="sub">{{ active().subtitle }}</p>

          @if (active().id === 'ai' && ai.available()) {
            <div class="ai-ready-note">
              <span class="check">&#10003;</span>
              AI is already set up — you can continue.
            </div>
          }
        </div>

        <!-- Embedded panel body -->
        <div class="step-body">
          @switch (active().id) {
            @case ('library') {
              <div class="library-step">
                @if (libraryError()) {
                  <div class="library-error">{{ libraryError() }}</div>
                }
                <button
                  type="button"
                  class="lib-option"
                  [class.selected]="libOption() === 'default'"
                  (click)="selectLibOption('default')"
                >
                  <span class="lib-icon">&#127968;</span>
                  <div class="lib-text">
                    <strong>Use the default folder</strong>
                    <span class="lib-path">Documents / BookForge</span>
                  </div>
                  @if (libOption() === 'default') { <span class="lib-pick">&#10003;</span> }
                </button>

                <button
                  type="button"
                  class="lib-option"
                  [class.selected]="libOption() === 'custom'"
                  (click)="browseForLibrary()"
                >
                  <span class="lib-icon">&#128193;</span>
                  <div class="lib-text">
                    <strong>Choose a custom folder</strong>
                    <span class="lib-path">{{ customLibPath() || 'Select a folder…' }}</span>
                  </div>
                  @if (libOption() === 'custom') { <span class="lib-pick">&#10003;</span> }
                </button>
              </div>
            }
            @case ('ai') {
              <!--
                THE ONE SENTENCE THIS STEP OWNS ABOUT CLOUD, AND NOTHING ELSE.
                Cloud keys have ONE owner (Owen's evening ruling of 2026-09-14,
                which overruled that morning's): the ENGINE holds them and
                forwards on the operator's account. BookForge deleted its own
                Claude/OpenAI key rows and its hardcoded model lists, so what
                belongs here is the door, not a second key store.
              -->
              <p class="step-note">
                This step is which engine does the reading and writing. Anthropic, OpenAI and
                Ollama keys and addresses are the engine’s, set on the engine — BookForge
                stores none of them, and a route to one is chosen before anything runs rather
                than reached for when something fails.
              </p>
              <!-- The wizard input turns on the one thing this step has that
                   Settings → AI does not (crucible PHASE15 §5.2): for each
                   text job the engine cannot do on its own card, the engine's
                   reason and an offer to run it through Anthropic, OpenAI or
                   an Ollama server instead — one press, which tests the key
                   and then writes the account AND the route together. Both
                   hosts pass embedded, so that input cannot tell them apart;
                   everything else on the panel is identical here and in
                   Settings on purpose. -->
              @if (firstRun()) {
                <p>Choose where AI jobs run, including any models you already use through Ollama.
                  BookForge prepares the required local models after you finish setup.</p>
              }
              <app-ai-setup-wizard [embedded]="true" [wizard]="true" />
            }
            @case ('crucible') {
              <!-- The SAME component Settings → Crucible Servers mounts, in its
                   PROBING face (PHASE13-OPERATOR.md §5.5): it measures on entry
                   and shows exactly one of connected / install here / connect
                   only. One component, two hosts — a wizard that offered a
                   "Connect" the settings row spelled differently would be two
                   screens teaching two different things about one registry. -->
              <app-crucible-doors mode="probing" />
            }
            @case ('review') {
              <div class="review">
                <!--
                  WHAT WAS CHOSEN. Read back from the services that own each
                  fact, never from a copy this page kept as the user advanced.
                -->
                <ul class="review-list chosen">
                  <li>
                    <span class="rl-name">Library</span>
                    <span class="rl-size">{{ library.libraryPath() || 'not set' }}</span>
                  </li>
                  <li>
                    <span class="rl-name">AI for cleanup</span>
                    <span class="rl-size">{{ ai.available() ? 'set up' : 'not set up yet' }}</span>
                  </li>
                </ul>

                <!--
                  THE ONLY DOWNLOADS BOOKFORGE STILL OWNS. Calibre and Tesseract
                  are CPU tools the user installs; foundry-cli is an engine
                  binary. Every other row this panel used to offer — the conda
                  envs, the CUDA packs, the voice and whisper weights — is a job
                  environment or a subject a Crucible holds once per machine
                  (rollout §2 ruling 1), reached from the previous step.
                -->
                <h3 class="review-head">Small local tools</h3>
                <app-add-ons-panel [selectionMode]="true" [only]="localToolIds" />

                @if (sel.count() === 0) {
                  <p class="review-empty">
                    Nothing extra selected, and there is nothing you have to select. Click Done to
                    start using BookForge.
                  </p>
                } @else {
                  <p class="review-intro">
                    <strong>{{ sel.count() }}</strong> add-on{{ sel.count() === 1 ? '' : 's' }}
                    ({{ formatBytes(selTotalBytes()) }}) {{ sel.count() === 1 ? 'is' : 'are' }} already
                    downloading — one at a time so your connection isn’t overloaded. Track them in the
                    corner ↘; you can leave now and they keep running.
                  </p>
                  <ul class="review-list">
                    @for (s of selectedStatuses(); track s.component.id) {
                      <li>
                        <span class="rl-name">{{ s.component.name }}</span>
                        <span class="rl-size">{{ formatBytes(s.component.sizeBytes) }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>
            }
          }
        </div>

        <!-- Footer controls -->
        @if (completionError()) { <p role="alert">{{ completionError() }}</p> }
        <footer class="card-foot">
          @if (active().id === 'library') {
            <!-- On a true first run the library is a one-way gate: a folder must be
                 chosen before the rest of setup is usable, so only Continue (which
                 creates the library) advances. But when a library already exists
                 (re-opened from Configuration), let the user keep it and skip past
                 without re-picking. -->
            <div class="spacer"></div>
            @if (hasExistingLibrary()) {
              <button type="button" class="btn ghost" (click)="next()">Keep current library</button>
            }
            <button
              type="button"
              class="btn primary"
              [disabled]="!canContinueLibrary() || creatingLibrary()"
              (click)="createLibraryAndAdvance()"
            >
              {{ creatingLibrary() ? 'Setting up…' : 'Continue' }}
            </button>
          } @else {
          <!--
            The guard is "currentStep() <= 0", NOT "<= 1" (audit §6). The old
            one made the LIBRARY step
            unreachable the moment it was passed: from AI, Back was disabled, so
            the one step nobody may skip was also the one step nobody could
            revisit. Step 0 draws its own footer (with no Back), so this guard
            only ever governs steps 1 and up.
          -->
          <button
            type="button"
            class="btn ghost"
            [disabled]="currentStep() <= 0 || aiSaving()"
            (click)="back()"
          >
            Back
          </button>
          <div class="spacer"></div>
          @if (!isLast()) {
            <button type="button" class="btn ghost" [disabled]="aiSaving()" (click)="next()">Skip</button>
            <button type="button" class="btn primary" [disabled]="aiSaving()" (click)="next()">Next</button>
          } @else {
            <!-- Add-ons already started downloading as the user advanced; the last
                 page is just an acknowledgement. -->
            <button type="button" class="btn primary" (click)="complete()">
              {{ completionError() ? 'Retry setup' : runtime.ready() ? 'Done' : 'Finish' }}
            </button>
          }
          }
        </footer>
        }
      </div>
    </div>
  `,
  styles: [`
    .setup-page {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      /* Bottom padding clears the app shell's fixed first-run progress bar
         (position:fixed; bottom:0) so the card's footer is never hidden behind it. */
      padding: 24px 16px 84px;
      height: 100%;
      box-sizing: border-box;
      overflow: hidden;
      background: var(--bg-base, #1a1a1a);
    }

    .setup-card {
      width: 100%;
      max-width: 720px;
      /* Fill the actual content area (the router outlet), NOT the whole viewport:
         the setup page renders inside the app shell (titlebar + status bar + the
         fixed bottom progress bar), so 100vh overran the bottom and hid the Next
         button. height:100% of .setup-page (minus its padding) keeps the Back /
         Skip / Next footer pinned just above the progress bar on every step; the
         body (flex: 1, overflow-y: auto) absorbs per-step size changes. */
      height: 100%;
      max-height: 100%;
      background: var(--bg-elevated, #242424);
      border: 1px solid var(--border-default, #333);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Last step (Review & download) / finishing view have little content, so
       shrink to fit and vertically center instead of stretching to full height
       with the footer pinned far below an ocean of empty space. */
    .setup-card.compact {
      height: auto;
      margin-top: auto;
      margin-bottom: auto;
    }

    .card-head {
      padding: 20px 24px 16px;
      border-bottom: 1px solid var(--border-default, #333);
    }

    .head-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    .head-row h1 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: var(--text-primary, #f0f0f0);
    }

    .close-x {
      background: none;
      border: none;
      color: var(--text-secondary, #9a9a9a);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 6px;
    }
    .close-x:hover {
      color: var(--text-primary, #f0f0f0);
      background: color-mix(in srgb, var(--text-secondary, #9a9a9a) 14%, transparent);
    }

    .steps-indicator {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 14px;
    }

    .step-count {
      font-size: 12px;
      color: var(--text-secondary, #9a9a9a);
      white-space: nowrap;
    }

    .dots {
      display: flex;
      gap: 6px;
      flex: 1;
    }

    .dot {
      height: 4px;
      flex: 1;
      border-radius: 2px;
      background: var(--border-default, #333);
      transition: background 0.15s ease;
    }
    .dot.done {
      background: var(--accent);
      opacity: 0.5;
    }
    .dot.active {
      background: var(--accent);
    }

    .head-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    /* Compact engine-status pill in the header — replaces the old full-width
       banner that repeated on every step. */
    .engine-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      white-space: nowrap;
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-default));
      color: var(--text-secondary);
    }
    .engine-pill.ready {
      background: color-mix(in srgb, #22c55e 12%, transparent);
      border-color: color-mix(in srgb, #22c55e 35%, var(--border-default));
    }
    .engine-check { color: #22c55e; font-weight: 700; }
    .engine-spinner {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      border: 2px solid color-mix(in srgb, var(--accent) 30%, transparent);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: engineSpin 0.8s linear infinite;
    }
    @keyframes engineSpin { to { transform: rotate(360deg); } }

    /* Prominent "finishing — engine still preparing" view. */
    .finishing {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: 12px;
      padding: 40px 32px 28px;
    }
    .engine-spinner.big {
      width: 32px;
      height: 32px;
      border-width: 3px;
    }
    .finishing h2 {
      margin: 4px 0 0;
      font-size: 18px;
      font-weight: 600;
      color: var(--text-primary, #f0f0f0);
    }
    .finishing-sub {
      margin: 0;
      max-width: 440px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary, #9a9a9a);
    }
    .finish-bar {
      width: 100%;
      max-width: 420px;
      height: 8px;
      margin-top: 8px;
      border-radius: 999px;
      background: var(--border-default, #333);
      overflow: hidden;
    }
    .finish-bar-fill {
      height: 100%;
      border-radius: 999px;
      background: var(--accent);
      transition: width 0.6s ease;
    }
    .finish-stage {
      margin: 0;
      font-size: 12px;
      color: var(--text-tertiary, #888);
      font-variant-numeric: tabular-nums;
    }
    .finishing-hint {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: var(--text-secondary, #9a9a9a);
    }

    .step-head {
      padding: 18px 24px 10px;
    }
    .step-head h2 {
      margin: 0 0 6px;
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary, #f0f0f0);
    }
    .step-head .sub {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary, #9a9a9a);
    }

    .ai-ready-note {
      margin-top: 12px;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      color: var(--text-primary, #f0f0f0);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
      border-radius: 8px;
      padding: 6px 12px;
    }
    .ai-ready-note .check {
      color: var(--accent);
      font-weight: 700;
    }

    .step-body {
      padding: 8px 24px 16px;
      /* Fill the space between the (fixed) header and footer and scroll inside,
         so steps with little content don't shrink the card and shift the footer. */
      flex: 1 1 auto;
      min-height: 0;
      overflow-y: auto;
      /* Reserve the scrollbar gutter so it never sits over the row checkboxes. */
      scrollbar-gutter: stable;
    }


    /* The one sentence the AI step owns about cloud keys — see the template. */
    .step-note {
      margin: 0 0 12px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary, #9a9a9a);
    }

    .review { display: flex; flex-direction: column; gap: 12px; }
    .review-head {
      margin: 8px 0 0;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-primary, #f0f0f0);
    }
    .review-list.chosen .rl-size {
      white-space: normal;
      text-align: right;
      overflow-wrap: anywhere;
    }
    .review-empty, .review-intro {
      margin: 0;
      font-size: 13px;
      line-height: 1.5;
      color: var(--text-secondary, #9a9a9a);
    }
    .review-intro strong { color: var(--text-primary, #f0f0f0); }
    .review-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .review-list li {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 8px 0;
      border-bottom: 1px solid var(--border-subtle, #2c2c2c);
      font-size: 13px;
    }
    .review-list li:last-child { border-bottom: none; }
    .rl-name { color: var(--text-primary, #f0f0f0); }
    .rl-size { color: var(--text-tertiary, #888); font-size: 12px; white-space: nowrap; }
    .review-started {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--accent);
    }

    /* Library step: full-box options that light up on click, matching the
       voice/language selection boxes elsewhere in setup. */
    .library-step { display: flex; flex-direction: column; gap: 10px; }
    .library-error {
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      background: color-mix(in srgb, var(--color-danger, #e06c75) 12%, transparent);
      border: 1px solid color-mix(in srgb, var(--color-danger, #e06c75) 40%, transparent);
      color: var(--color-danger, #e06c75);
    }
    .lib-option {
      display: flex;
      align-items: center;
      gap: 14px;
      width: 100%;
      text-align: left;
      padding: 14px 16px;
      border: 1px solid var(--border-default, #333);
      border-radius: 10px;
      background: transparent;
      color: var(--text-primary, #f0f0f0);
      cursor: pointer;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    .lib-option:hover { border-color: var(--text-tertiary, #888); }
    .lib-option.selected {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
      border-color: var(--accent);
    }
    .lib-icon { font-size: 22px; flex: 0 0 auto; }
    .lib-text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
    .lib-text strong { font-size: 14px; font-weight: 600; }
    .lib-path {
      font-size: 12px;
      color: var(--text-secondary, #9a9a9a);
      font-family: var(--font-mono, monospace);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lib-option.selected .lib-text strong { color: var(--accent); }
    .lib-pick { flex: 0 0 auto; color: var(--accent); font-weight: 700; font-size: 16px; }

    .card-foot {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 24px;
      border-top: 1px solid var(--border-default, #333);
    }
    .card-foot .spacer {
      flex: 1;
    }

    .btn {
      font-size: 13px;
      font-weight: 500;
      padding: 8px 16px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: background 0.15s ease, border-color 0.15s ease;
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .btn.ghost {
      background: transparent;
      border-color: var(--border-default, #333);
      color: var(--text-secondary, #9a9a9a);
    }
    .btn.ghost:not(:disabled):hover {
      color: var(--text-primary, #f0f0f0);
      border-color: var(--text-secondary, #9a9a9a);
    }
    .btn.primary {
      background: var(--accent);
      color: #1a1a1a;
      font-weight: 600;
    }
    .btn.primary:hover {
      background: color-mix(in srgb, var(--accent) 88%, #fff);
    }
  `]
})
export class FirstRunSetupComponent {
  private router = inject(Router);
  protected ai = inject(AiService);
  protected runtime = inject(RuntimeService);
  private components = inject(ComponentService);
  protected sel = inject(SetupDownloadService);
  // `protected`, not private: the Review step reads the chosen path back out of
  // the service that owns it rather than out of a copy this page kept.
  protected library = inject(LibraryService);
  private electron = inject(ElectronService);
  private studio = inject(StudioService);

  // ── Library step (first run) ───────────────────────────────────────────────
  // The picker that used to live in the separate onboarding modal now opens setup
  // as step 0, so library choice + engine setup + the rest happen as one flow.
  protected readonly libOption = signal<'default' | 'custom'>('default');
  protected readonly customLibPath = signal('');
  protected readonly creatingLibrary = signal(false);
  protected readonly libraryError = signal('');

  /** Continue is enabled once a usable choice exists (default always is; a
   *  custom folder must be picked first). */
  protected readonly canContinueLibrary = computed(
    () => this.libOption() === 'default' || !!this.customLibPath(),
  );

  /** A library is already configured (re-entering setup from Configuration, not a
   *  true first run). The library step is only a one-way gate on first run; when
   *  one exists the user can keep it and skip straight past, without re-picking. */
  protected readonly hasExistingLibrary = computed(() => !!this.library.libraryPath());

  /** The catalog statuses for every checked component (for the review list). */
  protected readonly selectedStatuses = computed(() => {
    const ids = this.sel.selected();
    return this.components
      .components()
      .filter((c) => ids.has(c.component.id))
      .sort((a, b) => a.component.name.localeCompare(b.component.name));
  });

  /** Total download size of the current selection. */
  protected readonly selTotalBytes = computed(() =>
    this.selectedStatuses().reduce((sum, s) => sum + (s.component.sizeBytes || 0), 0),
  );

  /**
   * FOUR STEPS, and the rule the shape follows (audit §6): **a setup step
   * exists only for something the app itself owns.** Files, credentials, and
   * which server. Everything about a model, a voice, an engine environment or
   * a card belongs to Crucible's own page, reached with one button.
   *
   * THE FOUR THAT WENT, and why they were one step and not four: Orpheus,
   * Higgs, Voice enhancement and the engine half of Optional tools each
   * installed a conda env or pulled a weight — ~250 GB between them (rollout
   * §0b A2) — and every one of those is a job type or a subject a Crucible
   * holds ONCE PER MACHINE. Four screens that each stood up a private copy of
   * somebody else's engine become one question: which server.
   */
  protected readonly steps: SetupStep[] = [
    {
      id: 'library',
      title: 'Choose your library',
      subtitle:
        'Pick where BookForge keeps your books, projects, and finished audiobooks. You can use the default folder or choose your own — these are your files and stay put if you ever uninstall.'
    },
    {
      // WHERE THE GPU WORK HAPPENS. Not an optional aside any more: once the
      // legacy local-engine layer is deleted, this is the step that decides
      // whether anything renders at all. It PROBES ON ENTRY and shows one face
      // (PHASE13-OPERATOR.md §5.5).
      id: 'crucible',
      title: 'Set up model processing',
      subtitle:
        'BookForge uses the shared Crucible engine for narration, transcription, alignment and '
        + 'text cleanup. Install it on this computer or connect to another computer. You can '
        + 'skip this step and connect an engine later in Settings.'
    },
    {
      // It was titled "AI and cloud keys" until 2026-09-14. There are no cloud
      // keys in this app any more — they are the engine's, set on the engine —
      // so a step that promised them was a door onto a room that had moved.
      id: 'ai',
      title: 'AI',
      subtitle:
        'Which engine does the reading and writing. Pick the model engine (Crucible) that runs '
        + 'the text work, or use the model BookForge ships. Skippable — a machine with no text '
        + 'model still narrates.'
    },
    {
      id: 'review',
      title: 'Review',
      subtitle:
        'What was chosen, and the three small local tools if you want them. No progress bars for '
        + 'gigabytes, because there are none left to download here — a server’s environments and '
        + 'weights are its own, installed from its page.'
    }
  ];

  /**
   * THE ONLY DOWNLOADS BOOKFORGE STILL OWNS.
   *
   * Calibre and Tesseract are CPU tools with nothing to do with a card;
   * `foundry-cli` is an engine binary that rasterises and drives text acts
   * against a Crucible endpoint, and is not itself a model. Everything else the
   * wizard used to offer — `orpheus`, `rvc-env`, `whisperx-env`,
   * `qwen-align-env`, the whisper models, the RVC voices and the three CUDA
   * packs — is a job environment or a subject Crucible installs and holds once
   * per machine (rollout §2 ruling 1). (`resemble-env` was on that list until
   * the Enhance tab was deleted; Resemble Enhance is gone from this app.)
   */
  protected readonly localToolIds = ['calibre', 'foundry-cli'];

  protected readonly currentStep = signal(0);
  protected readonly active = computed(() => this.steps[this.currentStep()]);
  protected readonly isLast = computed(() => this.currentStep() === this.steps.length - 1);

  /** First-run (mandatory setup) vs reopened later as "Configuration" (closable).
   *  Tied to whether the env was created fresh this launch. */
  protected readonly firstRun = computed(() => this.runtime.freshInstall());

  // The user finished/skipped setup but the engine is still unpacking. We sit on
  // the last page showing prominent progress instead of dropping them onto a
  // half-ready home; the effect below sends them to Studio the moment it's ready.
  protected readonly finishing = signal(false);
  private readonly aiWizard = viewChild(AiSetupWizardComponent);
  protected readonly aiSaving = computed(() => this.aiWizard()?.engineBusy() === true);
  protected readonly completionError = signal('');
  protected readonly modelPreparing = signal(false);
  protected readonly modelProgress = signal<CrucibleCoordinationState[]>([]);
  protected readonly modelProgressWords = coordinationWords;
  private completing = false;

  constructor() {
    const stop = this.electron.crucible.onCoordination((state) => {
      this.modelProgress.update((states) => [...states.filter((row) => row.server !== state.server), state]);
    });
    inject(DestroyRef).onDestroy(stop);
    // Auto-advance to the home page once the engine finishes preparing, if the
    // user already hit Finish while it was still working. Selected add-ons are
    // already downloading in the corner (queued on each step) — nothing to start here.
    effect(() => {
      if (this.finishing() && this.runtime.ready()) {
        this.finishing.set(false);
        this.leaveForStudio();
      }
    });
  }

  back(): void {
    if (this.aiSaving()) return;
    // Backing out of the "finishing" wait returns to configuring — let the user
    // revisit earlier steps while the engine keeps preparing in the background.
    if (this.finishing()) this.finishing.set(false);
    if (this.currentStep() > 0) {
      this.currentStep.update(s => s - 1);
    }
  }

  /** Next / Skip / Finish — advance, or complete on the last step. Leaving a step
   *  immediately queues that step's selected add-ons (they download in the corner),
   *  so by the last page everything is already in flight. */
  next(): void {
    if (this.aiSaving()) return;
    this.sel.enqueueSelected();
    if (this.isLast()) {
      this.complete();
    } else {
      this.currentStep.update(s => s + 1);
    }
  }

  /** Finish: head to Studio. Selected add-ons are already downloading in the
   *  corner; if the engine itself is still preparing, wait on the last page first
   *  (the effect above leaves once it's ready). */
  async complete(): Promise<void> {
    if (this.completing) return;
    this.completing = true;
    this.modelPreparing.set(true);
    this.completionError.set('');
    try {
      await this.runtime.completeSetup();
    } catch (error) {
      this.completionError.set((error as Error).message);
      return;
    } finally {
      this.completing = false;
      this.modelPreparing.set(false);
    }
    this.sel.enqueueSelected(); // catch anything picked on the final step
    if (!this.runtime.ready()) { this.enterFinishing(); return; }
    this.leaveForStudio();
  }

  /** Configuration mode (not first run): close the page and return to the app. */
  closeConfig(): void {
    void this.router.navigate(['/studio']);
  }

  /** Sit on the last page with prominent progress until the engine is ready. */
  private enterFinishing(): void {
    this.currentStep.set(this.steps.length - 1);
    this.finishing.set(true);
  }

  /** Leave for Studio. The add-on queue keeps running in the corner dock. */
  private leaveForStudio(): void {
    this.sel.collapse(); // tuck the (still-running) queue into the corner
    void this.router.navigate(['/studio']);
  }

  // ── Library step actions ────────────────────────────────────────────────────

  selectLibOption(opt: 'default' | 'custom'): void {
    this.libraryError.set('');
    this.libOption.set(opt);
  }

  async browseForLibrary(): Promise<void> {
    const result = await this.electron.openFolderDialog();
    if (result.success && result.folderPath) {
      this.customLibPath.set(result.folderPath);
      this.libOption.set('custom');
      this.libraryError.set('');
    }
  }

  /** Create/confirm the chosen library, seed the first book + refresh AI, then
   *  advance to the rest of setup. The only way past the (one-way) library step. */
  async createLibraryAndAdvance(): Promise<void> {
    if (this.creatingLibrary()) return;
    this.creatingLibrary.set(true);
    this.libraryError.set('');
    try {
      const result =
        this.libOption() === 'default'
          ? await this.library.useDefaultLibrary()
          : await this.library.setLibraryPath(this.customLibPath());
      if (!result.success) {
        this.libraryError.set(result.error || 'Could not set up the library folder.');
        return;
      }
      // Best-effort, non-blocking: seed the finished sample project into the new (empty)
      // library and refresh AI availability so the AI step reflects reality.
      void this.seedStarterLibrary();
      await this.ai.refresh();
      this.currentStep.update((s) => s + 1);
    } catch (err) {
      this.libraryError.set((err as Error).message);
    } finally {
      this.creatingLibrary.set(false);
    }
  }

  /** First run only: seed the finished public-domain sample project ("The Mysterious Stranger")
   *  into the chosen library — but ONLY when that library is brand-new and empty. The download
   *  (~550 MB) is verified by sha256 and runs in the background; the globally-mounted update
   *  banner shows progress. The main-process installer hard-guards on emptiness, so this never
   *  overwrites an existing library; re-running into an already-seeded library simply no-ops. */
  private async seedStarterLibrary(): Promise<void> {
    try {
      const api = (window as unknown as { electron?: { update?: {
        getStarterStatus?: () => Promise<{ available: boolean; alreadyPresent: boolean }>;
        installStarter?: () => Promise<unknown>;
      } } }).electron?.update;
      if (!api?.getStarterStatus || !api.installStarter) return; // older bridge / web build
      const status = await api.getStarterStatus();
      if (!status?.available || status.alreadyPresent) return;   // none advertised, or library not empty
      void api.installStarter(); // fire-and-forget; progress surfaces in the update banner
    } catch (err) {
      console.warn('[Setup] Seeding the starter library failed:', err);
    }
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}
