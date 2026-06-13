import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

import { AiSetupWizardComponent } from '../ai-setup/ai-setup-wizard.component';
import { VoicesPanelComponent } from '../settings/components/voices-panel.component';
import { LanguagesPanelComponent } from '../settings/components/languages-panel.component';
import { AddOnsPanelComponent } from '../settings/components/add-ons-panel.component';
import { AiService } from '../../core/services/ai.service';
import { RuntimeService } from '../../core/services/runtime.service';

interface SetupStep {
  id: 'ai' | 'voices' | 'languages' | 'tools';
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
              <app-voices-panel />
            }
            @case ('languages') {
              <app-languages-panel />
            }
            @case ('tools') {
              <app-add-ons-panel />
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
          <button type="button" class="btn ghost" (click)="next()">Skip</button>
          <button type="button" class="btn primary" (click)="next()">
            {{ isLast() ? 'Finish' : 'Next' }}
          </button>
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
      background: var(--accent-primary, #ff8a3d);
      opacity: 0.5;
    }
    .dot.active {
      background: var(--accent-primary, #ff8a3d);
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
      background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent-primary) 30%, var(--border-default));
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
      border: 2px solid color-mix(in srgb, var(--accent-primary) 30%, transparent);
      border-top-color: var(--accent-primary);
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
      background: color-mix(in srgb, var(--accent-primary, #ff8a3d) 14%, transparent);
      border: 1px solid color-mix(in srgb, var(--accent-primary, #ff8a3d) 40%, transparent);
      border-radius: 8px;
      padding: 6px 12px;
    }
    .ai-ready-note .check {
      color: var(--accent-primary, #ff8a3d);
      font-weight: 700;
    }

    .step-body {
      padding: 8px 24px 16px;
      max-height: 52vh;
      overflow-y: auto;
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
      background: var(--accent-primary, #ff8a3d);
      color: #1a1a1a;
      font-weight: 600;
    }
    .btn.primary:hover {
      background: color-mix(in srgb, var(--accent-primary, #ff8a3d) 88%, #fff);
    }
  `]
})
export class FirstRunSetupComponent {
  private router = inject(Router);
  protected ai = inject(AiService);
  protected runtime = inject(RuntimeService);

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
        'Calibre and Tesseract improve EPUB conversion and OCR. Install them from their official sites, then locate them here. Skip if you don’t need them.'
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

  complete(): void {
    void this.router.navigate(['/studio']);
  }
}
