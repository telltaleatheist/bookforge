import { Component, inject, signal, computed, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { LibraryService } from '../../core/services/library.service';
import { ElectronService } from '../../core/services/electron.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';

type OnboardingStep = 'welcome' | 'library' | 'ready';
const STEP_ORDER: OnboardingStep[] = ['welcome', 'library', 'ready'];

@Component({
  selector: 'app-onboarding',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="onboarding-overlay">
      <div class="onboarding-modal">
        <!-- Step indicator -->
        <div class="step-indicator">
          <div class="step" [class.active]="stepIndex() === 0" [class.completed]="stepIndex() > 0">
            <div class="step-dot">1</div>
            <span>Welcome</span>
          </div>
          <div class="step-line" [class.completed]="stepIndex() > 0"></div>
          <div class="step" [class.active]="stepIndex() === 1" [class.completed]="stepIndex() > 1">
            <div class="step-dot">2</div>
            <span>Library</span>
          </div>
          <div class="step-line" [class.completed]="stepIndex() > 1"></div>
          <div class="step" [class.active]="stepIndex() === 2">
            <div class="step-dot">3</div>
            <span>Ready</span>
          </div>
        </div>

        <!-- Welcome Step -->
        @if (currentStep() === 'welcome') {
          <div class="step-content">
            <div class="icon-large">&#128218;</div>
            <h1>Welcome to BookForge</h1>
            <p class="description">
              BookForge helps you create audiobooks from PDFs and EPUBs.
              Extract text, clean it with AI, and convert to high-quality audiobooks.
            </p>
            <div class="features">
              <div class="feature">
                <span class="feature-icon">&#128196;</span>
                <div>
                  <strong>PDF Editor</strong>
                  <p>Extract and clean text from PDFs</p>
                </div>
              </div>
              <div class="feature">
                <span class="feature-icon">&#127911;</span>
                <div>
                  <strong>Audiobook Producer</strong>
                  <p>Convert EPUBs to M4B audiobooks</p>
                </div>
              </div>
            </div>
            <div class="actions">
              <desktop-button variant="primary" (click)="nextStep()">
                Get Started
              </desktop-button>
            </div>
          </div>
        }

        <!-- Library Setup Step -->
        @if (currentStep() === 'library') {
          <div class="step-content">
            <div class="icon-large">&#128194;</div>
            <h1>Set Up Your Library</h1>
            <p class="description">
              Choose where BookForge stores your projects and files.
              You can use the default location or pick a custom folder.
            </p>

            @if (error()) {
              <div class="error-message">
                {{ error() }}
              </div>
            }

            <div class="library-options">
              <button
                class="library-option"
                [class.selected]="selectedOption() === 'default'"
                (click)="selectOption('default')"
              >
                <span class="option-icon">&#127968;</span>
                <div class="option-content">
                  <strong>Use Default Location</strong>
                  <p>~/Documents/BookForge</p>
                </div>
                <span class="option-check" [class.visible]="selectedOption() === 'default'">&#10003;</span>
              </button>

              <button
                class="library-option"
                [class.selected]="selectedOption() === 'custom'"
                (click)="browseForFolder()"
              >
                <span class="option-icon">&#128193;</span>
                <div class="option-content">
                  <strong>Choose Custom Location</strong>
                  <p>{{ customPath() || 'Select a folder...' }}</p>
                </div>
                <span class="option-check" [class.visible]="selectedOption() === 'custom'">&#10003;</span>
              </button>
            </div>

            <div class="actions">
              <desktop-button variant="ghost" (click)="prevStep()">
                Back
              </desktop-button>
              <desktop-button
                variant="primary"
                [disabled]="isCreating()"
                (click)="createLibrary()"
              >
                {{ isCreating() ? 'Setting up...' : 'Continue' }}
              </desktop-button>
            </div>
          </div>
        }

        <!-- You're Ready Step -->
        @if (currentStep() === 'ready') {
          <div class="step-content">
            <div class="icon-large">&#10024;</div>
            <h1>You're ready to go</h1>
            <p class="description">
              BookForge is set up. It already ships with one voice, so you can make
              an audiobook right now. Here's where to find more when you want it.
            </p>
            <div class="features">
              <div class="feature">
                <span class="feature-icon">&#127908;</span>
                <div>
                  <strong>More voices</strong>
                  <p>Settings → Add-ons &amp; Models: download premium voices or add your own.</p>
                </div>
              </div>
              <div class="feature">
                <span class="feature-icon">&#129513;</span>
                <div>
                  <strong>Optional tools</strong>
                  <p>Settings → Add-ons &amp; Models: Calibre and Tesseract for more formats and OCR.</p>
                </div>
              </div>
              <div class="feature">
                <span class="feature-icon">&#129302;</span>
                <div>
                  <strong>AI cleanup (optional)</strong>
                  <p>Tidy OCR text before narration with a bundled local model, Ollama, or an API key. The AI Setup wizard walks you through it — or skip it entirely.</p>
                </div>
              </div>
            </div>
            <div class="actions">
              <desktop-button variant="ghost" (click)="finishAndSetupAi()">
                Set up AI
              </desktop-button>
              <desktop-button variant="primary" (click)="finish()">
                Start using BookForge
              </desktop-button>
            </div>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .onboarding-overlay {
      position: fixed;
      inset: 0;
      background: var(--bg-base);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .onboarding-modal {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 520px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .step-indicator {
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 2rem;
      gap: 0.5rem;
    }

    .step {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.5rem;
      opacity: 0.5;
      transition: opacity 0.2s;

      &.active, &.completed {
        opacity: 1;
      }

      span {
        font-size: 0.75rem;
        color: var(--text-secondary);
      }
    }

    .step-dot {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--bg-subtle);
      border: 2px solid var(--border-default);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-secondary);
      transition: all 0.2s;

      .active & {
        background: var(--accent-primary);
        border-color: var(--accent-primary);
        color: white;
      }

      .completed & {
        background: var(--accent-success);
        border-color: var(--accent-success);
        color: white;
      }
    }

    .step-line {
      width: 60px;
      height: 2px;
      background: var(--border-default);
      margin: 0 0.5rem;
      margin-bottom: 1.5rem;
      transition: background 0.2s;

      &.completed {
        background: var(--accent-success);
      }
    }

    .step-content {
      text-align: center;
    }

    .icon-large {
      font-size: 4rem;
      margin-bottom: 1rem;
    }

    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      color: var(--text-primary);
      margin: 0 0 0.5rem 0;
    }

    .description {
      color: var(--text-secondary);
      font-size: 0.9375rem;
      line-height: 1.5;
      margin: 0 0 1.5rem 0;
    }

    .features {
      display: flex;
      flex-direction: column;
      gap: 1rem;
      margin-bottom: 2rem;
      text-align: left;
    }

    .feature {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      .feature-icon {
        font-size: 1.5rem;
      }

      strong {
        display: block;
        color: var(--text-primary);
        margin-bottom: 0.25rem;
      }

      p {
        margin: 0;
        color: var(--text-secondary);
        font-size: 0.875rem;
      }
    }

    .error-message {
      background: color-mix(in srgb, var(--accent-danger) 10%, transparent);
      border: 1px solid var(--accent-danger);
      color: var(--accent-danger);
      padding: 0.75rem 1rem;
      border-radius: 6px;
      margin-bottom: 1rem;
      font-size: 0.875rem;
    }

    .library-options {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-bottom: 2rem;
    }

    .library-option {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: var(--bg-subtle);
      border: 2px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
      transition: all 0.2s;

      &:hover:not(:disabled) {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .option-icon {
        font-size: 1.5rem;
      }

      .option-content {
        flex: 1;

        strong {
          display: block;
          color: var(--text-primary);
          margin-bottom: 0.25rem;
        }

        p {
          margin: 0;
          color: var(--text-secondary);
          font-size: 0.8125rem;
          font-family: monospace;
        }
      }

      .option-check {
        font-size: 1.25rem;
        color: var(--accent-primary);
        opacity: 0;
        transition: opacity 0.2s;

        &.visible {
          opacity: 1;
        }
      }
    }

    .actions {
      display: flex;
      justify-content: center;
      gap: 1rem;
    }
  `]
})
export class OnboardingComponent {
  private readonly libraryService = inject(LibraryService);
  private readonly electronService = inject(ElectronService);
  private readonly router = inject(Router);

  // State
  readonly currentStep = signal<OnboardingStep>('welcome');
  readonly stepIndex = computed(() => STEP_ORDER.indexOf(this.currentStep()));
  readonly selectedOption = signal<'default' | 'custom'>('default');
  readonly customPath = signal<string>('');
  readonly isCreating = signal(false);
  readonly error = signal<string>('');

  // Events
  readonly complete = output<void>();

  nextStep(): void {
    if (this.currentStep() === 'welcome') {
      this.currentStep.set('library');
    }
  }

  prevStep(): void {
    if (this.currentStep() === 'library') {
      this.currentStep.set('welcome');
      this.error.set('');
    }
  }

  selectOption(option: 'default' | 'custom'): void {
    this.selectedOption.set(option);
  }

  async browseForFolder(): Promise<void> {
    const result = await this.electronService.openFolderDialog();
    if (result.success && result.folderPath) {
      this.customPath.set(result.folderPath);
      this.selectedOption.set('custom');
    }
  }

  async createLibrary(): Promise<void> {
    this.isCreating.set(true);
    this.error.set('');

    try {
      let result: { success: boolean; error?: string };

      if (this.selectedOption() === 'default') {
        result = await this.libraryService.useDefaultLibrary();
      } else {
        result = await this.libraryService.setLibraryPath(this.customPath());
      }

      if (result.success) {
        // Show the "you're ready" step rather than closing immediately, so the
        // user learns where to find voices, add-ons, and AI setup.
        this.currentStep.set('ready');
      } else {
        this.error.set(result.error || 'Failed to create library');
      }
    } catch (e) {
      this.error.set((e as Error).message);
    } finally {
      this.isCreating.set(false);
    }
  }

  finish(): void {
    this.complete.emit();
  }

  /** Close onboarding and open the AI Setup wizard (first-run AI guidance). */
  finishAndSetupAi(): void {
    this.complete.emit();
    void this.router.navigate(['/ai-setup']);
  }
}
