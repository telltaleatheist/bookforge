import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { AiSetupWizardComponent } from '../ai-setup/ai-setup-wizard.component';
import { VoicesPanelComponent } from '../settings/components/voices-panel.component';
import { LanguagesPanelComponent } from '../settings/components/languages-panel.component';
import { AddOnsPanelComponent } from '../settings/components/add-ons-panel.component';
import { AiService } from '../../core/services/ai.service';
import { RuntimeService } from '../../core/services/runtime.service';
import { ComponentService } from '../../core/services/component.service';
import { SetupDownloadService } from '../../core/services/setup-download.service';

interface SetupStep {
  id: 'ai' | 'voices' | 'languages' | 'tools' | 'download';
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
    AddOnsPanelComponent
  ],
  template: `
    <div class="setup-page">
      <div class="setup-card">
        <header class="card-head">
          <div class="head-row">
            <h1>Set up BookForge</h1>
            <button type="button" class="skip-all" (click)="complete()">Skip setup</button>
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

        <!-- Non-blocking runtime status: the engine unpacks in the background
             while the user configures. Voice/language downloads light up when
             it's ready (see ComponentService gate). -->
        @if (!runtime.ready()) {
          <div class="engine-banner preparing">
            <span class="engine-spinner"></span>
            <span>Audiobook engine is still setting up — keep going; voice &amp; language downloads will start as soon as it’s ready.</span>
          </div>
        } @else {
          <div class="engine-banner ready">
            <span class="engine-check">&#10003;</span>
            <span>Audiobook engine ready.</span>
          </div>
        }

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
          <button
            type="button"
            class="btn ghost"
            [disabled]="currentStep() === 0"
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
        </footer>
      </div>
    </div>
  `,
  styles: [`
    .setup-page {
      display: flex;
      justify-content: center;
      align-items: flex-start;
      padding: 32px 16px;
      min-height: 100%;
      box-sizing: border-box;
      background: var(--bg-base, #1a1a1a);
    }

    .setup-card {
      width: 100%;
      max-width: 720px;
      background: var(--bg-elevated, #242424);
      border: 1px solid var(--border-default, #333);
      border-radius: 12px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
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

    .skip-all {
      background: none;
      border: none;
      color: var(--text-secondary, #9a9a9a);
      font-size: 13px;
      cursor: pointer;
      padding: 4px 6px;
      border-radius: 6px;
    }
    .skip-all:hover {
      color: var(--text-primary, #f0f0f0);
      text-decoration: underline;
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

    .engine-banner {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0 0 16px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .engine-banner.preparing {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-default));
      color: var(--text-secondary);
    }
    .engine-banner.ready {
      background: color-mix(in srgb, #22c55e 10%, transparent);
      border: 1px solid color-mix(in srgb, #22c55e 30%, var(--border-default));
      color: var(--text-secondary);
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
      max-height: 52vh;
      overflow-y: auto;
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

  back(): void {
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
   *  The dock collapses to the corner so the user sees it shrink as they leave. */
  finishWithDownloads(): void {
    void this.sel.start();
    this.sel.collapse();
    void this.router.navigate(['/studio']);
  }

  complete(): void {
    void this.router.navigate(['/studio']);
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }
}
