import { Component, inject, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { AiSetupWizardComponent } from '../ai-setup/ai-setup-wizard.component';
import { VoicesPanelComponent } from '../settings/components/voices-panel.component';
import { LanguagesPanelComponent } from '../settings/components/languages-panel.component';
import { AddOnsPanelComponent } from '../settings/components/add-ons-panel.component';
import { MultiWorkerToggleComponent } from '../../components/multi-worker-toggle/multi-worker-toggle.component';
import { AiService } from '../../core/services/ai.service';
import { RuntimeService } from '../../core/services/runtime.service';
import { ComponentService } from '../../core/services/component.service';
import { SetupDownloadService } from '../../core/services/setup-download.service';
import { LibraryService } from '../../core/services/library.service';
import { ElectronService } from '../../core/services/electron.service';
import { StudioService } from '../studio/services/studio.service';

interface SetupStep {
  id: 'library' | 'ai' | 'voices' | 'languages' | 'tools' | 'download';
  title: string;
  subtitle: string;
}

/**
 * First-run guided setup. Shown once, immediately after library onboarding
 * completes (see app.ts → onOnboardingComplete). Chains the four existing setup
 * surfaces — AI, voices, language packs, optional tools — into one skippable
 * flow, then drops the user on the Studio home. Every step is optional.
 */
@Component({
  selector: 'app-first-run-setup',
  standalone: true,
  imports: [
    CommonModule,
    AiSetupWizardComponent,
    VoicesPanelComponent,
    LanguagesPanelComponent,
    AddOnsPanelComponent,
    MultiWorkerToggleComponent
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
                  <span class="engine-check">&#10003;</span> Engine ready
                } @else {
                  <span class="engine-spinner"></span> Engine setting up…
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

        @if (finishing()) {
          <!-- Finishing view: the user hit Done/Finish but the engine is still
               unpacking. Sit here with prominent progress; the effect navigates
               to Studio automatically once it's ready. Back returns to configuring. -->
          <div class="finishing">
            <span class="engine-spinner big"></span>
            <h2>Finishing setup…</h2>
            <p class="finishing-sub">
              The audiobook engine is still getting ready. BookForge will open
              automatically the moment it’s done — you don’t need to wait here.
            </p>
            <div class="finish-bar">
              <div class="finish-bar-fill" [style.width.%]="runtime.setupProgress()"></div>
            </div>
            <p class="finish-stage">{{ runtime.status().message }} · {{ runtime.setupProgress() }}%</p>
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
              <app-ai-setup-wizard [embedded]="true" />
            }
            @case ('voices') {
              <app-voices-panel [selectionMode]="true" />
            }
            @case ('languages') {
              <app-languages-panel [selectionMode]="true" />
            }
            @case ('tools') {
              <div class="mw-setup-block">
                <app-multi-worker-toggle />
              </div>
              <app-add-ons-panel [selectionMode]="true" />
            }
            @case ('download') {
              <div class="review">
                @if (sel.count() === 0) {
                  <p class="review-empty">
                    Nothing selected yet. Go back to check the voices, languages, or GPU
                    acceleration you want — or finish now and grab them anytime from Settings.
                  </p>
                } @else {
                  <p class="review-intro">
                    Ready to download <strong>{{ sel.count() }}</strong>
                    item{{ sel.count() === 1 ? '' : 's' }} (about {{ formatBytes(selTotalBytes()) }}).
                    They download one at a time so your connection isn’t overloaded — keep using
                    BookForge while they run.
                  </p>
                  <ul class="review-list">
                    @for (s of selectedStatuses(); track s.component.id) {
                      <li>
                        <span class="rl-name">{{ s.component.name }}</span>
                        <span class="rl-size">{{ formatBytes(s.component.sizeBytes) }}</span>
                      </li>
                    }
                  </ul>
                  @if (sel.phase() !== 'idle') {
                    <p class="review-started">Downloads started — track progress in the corner ↘</p>
                  }
                }
              </div>
            }
          }
        </div>

        <!-- Footer controls -->
        <footer class="card-foot">
          @if (active().id === 'library') {
            <!-- The library is a one-way gate: a folder must be chosen before the
                 rest of setup (and the app) is usable, so this step has only a
                 Continue button that creates the library and advances. -->
            <div class="spacer"></div>
            <button
              type="button"
              class="btn primary"
              [disabled]="!canContinueLibrary() || creatingLibrary()"
              (click)="createLibraryAndAdvance()"
            >
              {{ creatingLibrary() ? 'Setting up…' : 'Continue' }}
            </button>
          } @else {
          <button
            type="button"
            class="btn ghost"
            [disabled]="currentStep() <= 1"
            (click)="back()"
          >
            Back
          </button>
          <div class="spacer"></div>
          @if (!isLast()) {
            <button type="button" class="btn ghost" (click)="next()">Skip</button>
            <button type="button" class="btn primary" (click)="next()">Next</button>
          } @else {
            <button type="button" class="btn ghost" (click)="complete()">
              Finish without downloading
            </button>
            @if (sel.count() > 0) {
              <button type="button" class="btn primary" (click)="finishWithDownloads()">
                Start {{ sel.count() }} download{{ sel.count() === 1 ? '' : 's' }} &amp; finish
              </button>
            } @else {
              <button type="button" class="btn primary" (click)="complete()">Finish</button>
            }
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


    .mw-setup-block {
      padding-bottom: 16px;
      margin-bottom: 16px;
      border-bottom: 1px solid var(--border-subtle, #2c2c2c);
    }

    .review { display: flex; flex-direction: column; gap: 12px; }
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
  private library = inject(LibraryService);
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

  protected readonly steps: SetupStep[] = [
    {
      id: 'library',
      title: 'Choose your library',
      subtitle:
        'Pick where BookForge keeps your books, projects, and finished audiobooks. You can use the default folder or choose your own — these are your files and stay put if you ever uninstall.'
    },
    {
      id: 'ai',
      title: 'Set up AI',
      subtitle:
        'Optional — AI cleans up OCR text before narration. Add a bundled local model, connect Ollama, or save a Claude/OpenAI key.'
    },
    {
      id: 'voices',
      title: 'Choose voices',
      subtitle:
        'One voice ships built in. Download more premium voices now, or anytime from Settings.'
    },
    {
      id: 'languages',
      title: 'Language packs',
      subtitle:
        'Segmentation models for cleanup & translation. Common languages are bundled; download more as you need them.'
    },
    {
      id: 'tools',
      title: 'Optional tools',
      subtitle:
        'GPU acceleration (if we detect an NVIDIA card), plus Calibre and Tesseract for better EPUB conversion and OCR. Check what you want; locate BYO tools you already have.'
    },
    {
      id: 'download',
      title: 'Review & download',
      subtitle:
        'Everything you checked, downloaded together at the end so the queue isn’t overloaded. You can leave anytime — downloads keep running in the corner.'
    }
  ];

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
  // Whether the deferred finish should also kick off the selected downloads.
  private pendingDownloads = false;

  constructor() {
    // Auto-advance to the home page once the engine finishes preparing, if the
    // user already asked to finish (hit Done/Finish while it was still working).
    effect(() => {
      if (this.finishing() && this.runtime.ready()) {
        this.finishing.set(false);
        this.leaveForStudio(this.pendingDownloads);
        this.pendingDownloads = false;
      }
    });
  }

  back(): void {
    // Backing out of the "finishing" wait returns to configuring — let the user
    // revisit earlier steps while the engine keeps preparing in the background.
    if (this.finishing()) this.finishing.set(false);
    if (this.currentStep() > 0) {
      this.currentStep.update(s => s - 1);
    }
  }

  /** Next / Skip / Finish — advance, or complete on the last step. */
  next(): void {
    if (this.isLast()) {
      this.complete();
    } else {
      this.currentStep.update(s => s + 1);
    }
  }

  /** Kick off the selected batch (runs in the background) and head to Studio.
   *  If the engine is still unpacking, wait on the last page first (the effect
   *  above leaves once it's ready) — downloads need the runtime anyway. */
  finishWithDownloads(): void {
    if (!this.runtime.ready()) { this.enterFinishing(true); return; }
    this.leaveForStudio(true);
  }

  complete(): void {
    if (!this.runtime.ready()) { this.enterFinishing(false); return; }
    this.leaveForStudio(false);
  }

  /** Configuration mode (not first run): close the page and return to the app. */
  closeConfig(): void {
    void this.router.navigate(['/studio']);
  }

  /** Sit on the last page with prominent progress until the engine is ready. */
  private enterFinishing(withDownloads: boolean): void {
    this.pendingDownloads = withDownloads;
    this.currentStep.set(this.steps.length - 1);
    this.finishing.set(true);
  }

  /** Actually leave for Studio, optionally starting the selected downloads. */
  private leaveForStudio(withDownloads: boolean): void {
    if (withDownloads) {
      void this.sel.start();
      this.sel.collapse();
    }
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
      // Best-effort, non-blocking: drop the bundled book into the new library and
      // refresh AI availability so the AI step reflects reality.
      void this.seedDefaultBook();
      await this.ai.refresh();
      this.currentStep.update((s) => s + 1);
    } catch (err) {
      this.libraryError.set((err as Error).message);
    } finally {
      this.creatingLibrary.set(false);
    }
  }

  /** First run only: copy the bundled public-domain book OUT of app resources and
   *  INTO the chosen library as the user's first book. The "done" flag is set only
   *  after the book is actually imported, so a transient failure can still seed on
   *  a later attempt (and a build shipping no seed book never burns the flag). */
  private async seedDefaultBook(): Promise<void> {
    const KEY = 'bookforge-seed-book-added';
    if (localStorage.getItem(KEY)) return;
    try {
      const path = await this.electron.getSeedBookPath();
      if (!path) return; // no bundled book (dev / not shipped)
      const result = await this.studio.addBook(path);
      if (result?.success) localStorage.setItem(KEY, '1');
    } catch (err) {
      console.warn('[Setup] Seeding the default book failed:', err);
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
