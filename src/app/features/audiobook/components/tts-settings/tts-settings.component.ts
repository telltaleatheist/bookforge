import { Component, input, output, signal, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { QueueService } from '../../../queue/services/queue.service';
import { QueueSuccessModalComponent } from '../queue-success-modal/queue-success-modal.component';
import { SettingsService } from '../../../../core/services/settings.service';
import { LibraryService } from '../../../../core/services/library.service';
import { EpubService } from '../../services/epub.service';

export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  ttsEngine: string;        // e.g., 'xtts'
  fineTuned: string;        // voice model e.g., 'ScarlettJohansson'
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  speed: number;
  enableTextSplitting: boolean;
  // Parallel processing options
  useParallel?: boolean;
  parallelWorkers?: number;
  parallelMode?: 'sentences' | 'chapters'; // 'sentences' = fine-grained, 'chapters' = natural boundaries
}

export interface HardwareInfo {
  recommendedWorkers: number;
  reason: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  language: string;
  description?: string;
}

@Component({
  selector: 'app-tts-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, QueueSuccessModalComponent],
  template: `
    <div class="tts-settings">
      <!-- ebook2audiobook Status -->
      <div class="status-section" [class.available]="ttsAvailable()" [class.error]="!ttsAvailable() && !checkingStatus()">
        @if (checkingStatus()) {
          <span class="status-icon">&#8635;</span>
          <span>Checking ebook2audiobook...</span>
        } @else if (ttsAvailable()) {
          <span class="status-icon">&#10003;</span>
          <span>ebook2audiobook ready</span>
        } @else {
          <span class="status-icon">&#10007;</span>
          <span>ebook2audiobook not found</span>
          <desktop-button variant="ghost" size="xs" (click)="checkStatus()">
            Retry
          </desktop-button>
        }
      </div>

      @if (!ttsAvailable() && !checkingStatus()) {
        <div class="setup-instructions">
          <h4>Setup Instructions</h4>
          <p>ebook2audiobook needs to be installed and configured:</p>
          <ol>
            <li>Clone the repository from GitHub</li>
            <li>Install dependencies: <code>pip install -r requirements.txt</code></li>
            <li>Configure the path in Settings</li>
          </ol>
        </div>
      } @else {
        <!-- Device Selection -->
        <div class="form-group">
          <label>Processing Device</label>
          <div class="device-options">
            <label class="radio-option" [class.selected]="settings().device === 'mps'">
              <input
                type="radio"
                name="device"
                value="mps"
                [ngModel]="settings().device"
                (ngModelChange)="updateSetting('device', $event)"
              />
              <div class="radio-content">
                <span class="radio-label">MPS (Apple Silicon)</span>
                <span class="radio-desc">Fast, uses Metal Performance Shaders</span>
              </div>
            </label>

            <label class="radio-option" [class.selected]="settings().device === 'gpu'">
              <input
                type="radio"
                name="device"
                value="gpu"
                [ngModel]="settings().device"
                (ngModelChange)="updateSetting('device', $event)"
              />
              <div class="radio-content">
                <span class="radio-label">GPU (CUDA)</span>
                <span class="radio-desc">For NVIDIA graphics cards</span>
              </div>
            </label>

            <label class="radio-option" [class.selected]="settings().device === 'cpu'">
              <input
                type="radio"
                name="device"
                value="cpu"
                [ngModel]="settings().device"
                (ngModelChange)="updateSetting('device', $event)"
              />
              <div class="radio-content">
                <span class="radio-label">CPU</span>
                <span class="radio-desc">Slower but always available</span>
              </div>
            </label>
          </div>
        </div>

        <!-- Language Selection -->
        <div class="form-row">
          <div class="form-group">
            <label for="language">Language</label>
            <select
              id="language"
              [ngModel]="settings().language"
              (ngModelChange)="updateSetting('language', $event)"
            >
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="it">Italian</option>
              <option value="pt">Portuguese</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
            </select>
          </div>

          <div class="form-group">
            <label for="fineTuned">Voice Model</label>
            <select
              id="fineTuned"
              [ngModel]="settings().fineTuned"
              (ngModelChange)="updateSetting('fineTuned', $event)"
            >
              @for (voice of availableVoices(); track voice.id) {
                <option [value]="voice.id">{{ voice.name }}</option>
              }
            </select>
          </div>
        </div>

        <!-- Parallel Processing -->
        <div class="parallel-section">
          <div class="section-header">
            <span class="section-title">Parallel Processing</span>
            @if (loadingHardwareInfo()) {
              <span class="loading-badge">Detecting hardware...</span>
            } @else if (hardwareInfo()) {
              <span class="hardware-badge">{{ hardwareInfo()!.reason }}</span>
            }
          </div>

          <label class="checkbox-option" [class.selected]="settings().useParallel">
            <input
              type="checkbox"
              [ngModel]="settings().useParallel"
              (ngModelChange)="updateSetting('useParallel', $event)"
            />
            <div class="checkbox-content">
              <span class="checkbox-label">Enable parallel workers</span>
              <span class="checkbox-desc">Use multiple TTS workers simultaneously for faster conversion</span>
            </div>
          </label>

          @if (settings().useParallel) {
            <div class="form-group worker-count">
              <label>Worker Count</label>
              <div class="worker-options">
                <label class="worker-option" [class.selected]="!settings().parallelWorkers || settings().parallelWorkers === 0">
                  <input
                    type="radio"
                    name="workerCount"
                    [value]="0"
                    [ngModel]="settings().parallelWorkers || 0"
                    (ngModelChange)="updateSetting('parallelWorkers', $event)"
                  />
                  <span>Auto ({{ hardwareInfo()?.recommendedWorkers || 2 }})</span>
                </label>
                @for (count of [1, 2, 3, 4]; track count) {
                  <label class="worker-option" [class.selected]="settings().parallelWorkers === count">
                    <input
                      type="radio"
                      name="workerCount"
                      [value]="count"
                      [ngModel]="settings().parallelWorkers || 0"
                      (ngModelChange)="updateSetting('parallelWorkers', $event)"
                    />
                    <span>{{ count }}</span>
                  </label>
                }
              </div>
              <span class="hint">More workers = faster conversion but more memory usage</span>
            </div>

            <div class="form-group parallel-mode">
              <label>Division Mode</label>
              <div class="mode-options">
                <label class="mode-option" [class.selected]="!settings().parallelMode || settings().parallelMode === 'sentences'">
                  <input
                    type="radio"
                    name="parallelMode"
                    value="sentences"
                    [ngModel]="settings().parallelMode || 'sentences'"
                    (ngModelChange)="updateSetting('parallelMode', $event)"
                  />
                  <div class="mode-content">
                    <span class="mode-label">By Sentences</span>
                    <span class="mode-desc">Fine-grained division for better load balancing</span>
                  </div>
                </label>
                <label class="mode-option" [class.selected]="settings().parallelMode === 'chapters'">
                  <input
                    type="radio"
                    name="parallelMode"
                    value="chapters"
                    [ngModel]="settings().parallelMode || 'sentences'"
                    (ngModelChange)="updateSetting('parallelMode', $event)"
                  />
                  <div class="mode-content">
                    <span class="mode-label">By Chapters</span>
                    <span class="mode-desc">Natural boundaries, simpler assembly</span>
                  </div>
                </label>
              </div>
            </div>
          }
        </div>

        <!-- Advanced Settings -->
        <div class="advanced-section">
          <button class="advanced-toggle" (click)="showAdvanced.set(!showAdvanced())">
            <span class="toggle-icon">{{ showAdvanced() ? '&#9660;' : '&#9654;' }}</span>
            Advanced Settings
          </button>

          @if (showAdvanced()) {
            <div class="advanced-content">
              <div class="form-group">
                <label for="temperature">Temperature: {{ settings().temperature }}</label>
                <input
                  id="temperature"
                  type="range"
                  min="0.1"
                  max="1.0"
                  step="0.05"
                  [ngModel]="settings().temperature"
                  (ngModelChange)="updateSetting('temperature', $event)"
                />
                <span class="hint">Higher values = more expressive but less consistent</span>
              </div>

              <div class="form-group">
                <label for="speed">Speed: {{ settings().speed }}x</label>
                <input
                  id="speed"
                  type="range"
                  min="0.5"
                  max="2.0"
                  step="0.1"
                  [ngModel]="settings().speed"
                  (ngModelChange)="updateSetting('speed', $event)"
                />
                <span class="hint">Playback speed multiplier</span>
              </div>
            </div>
          }
        </div>

        <!-- Actions -->
        <div class="actions">
          <desktop-button
            variant="primary"
            size="lg"
            [disabled]="!ttsAvailable() || addingToQueue()"
            (click)="addToQueue()"
          >
            @if (addingToQueue()) {
              Adding to Queue...
            } @else {
              Add to Queue
            }
          </desktop-button>
        </div>

        <div class="queue-info">
          <p>The conversion will be added to the processing queue. You can start processing from the Queue page.</p>
        </div>
      }
    </div>

    <!-- Success Modal -->
    <app-queue-success-modal
      [show]="showSuccessModal()"
      title="Added to Queue"
      message="Your TTS conversion job has been added to the processing queue."
      (close)="closeSuccessModal()"
      (viewQueue)="goToQueue()"
    />
  `,
  styles: [`
    .tts-settings {
      display: flex;
      flex-direction: column;
      gap: 1.5rem;
    }

    .status-section {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background: var(--bg-subtle);
      border-radius: 6px;
      font-size: 0.875rem;
      color: var(--text-secondary);

      &.available {
        background: color-mix(in srgb, var(--accent-success) 10%, transparent);
        color: var(--accent-success);
      }

      &.error {
        background: color-mix(in srgb, var(--accent-danger) 10%, transparent);
        color: var(--accent-danger);
      }

      .status-icon {
        font-size: 1rem;
      }
    }

    .setup-instructions {
      padding: 1rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      h4 {
        margin: 0 0 0.5rem 0;
        font-size: 0.875rem;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 0.75rem 0;
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      ol {
        margin: 0;
        padding-left: 1.25rem;

        li {
          margin-bottom: 0.5rem;
          font-size: 0.875rem;
          color: var(--text-secondary);
        }

        code {
          background: var(--bg-elevated);
          padding: 0.125rem 0.375rem;
          border-radius: 4px;
          font-size: 0.8125rem;
        }
      }
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;

      label {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.02em;
      }

      select, input[type="text"] {
        padding: 0.5rem 0.75rem;
        background: var(--bg-subtle);
        border: 1px solid var(--border-default);
        border-radius: 6px;
        color: var(--text-primary);
        font-size: 0.875rem;

        &:focus {
          outline: none;
          border-color: var(--accent-primary);
        }
      }

      input[type="range"] {
        width: 100%;
        accent-color: var(--accent-primary);
      }

      .hint {
        font-size: 0.6875rem;
        color: var(--text-muted);
      }
    }

    .form-row {
      display: flex;
      gap: 1rem;

      .form-group {
        flex: 1;
      }
    }

    .device-options {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .radio-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg-subtle);
      border: 2px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
      }

      input[type="radio"] {
        margin-top: 0.125rem;
      }

      .radio-content {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }

      .radio-label {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .radio-desc {
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .advanced-section {
      border: 1px solid var(--border-default);
      border-radius: 6px;
      overflow: hidden;
    }

    .advanced-toggle {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--bg-subtle);
      border: none;
      color: var(--text-secondary);
      font-size: 0.8125rem;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);
      }

      .toggle-icon {
        font-size: 0.625rem;
      }
    }

    .advanced-content {
      padding: 1rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .actions {
      display: flex;
      justify-content: center;
      margin-top: 1rem;
    }

    .queue-info {
      margin-top: 1rem;
      text-align: center;

      p {
        margin: 0;
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .parallel-section {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      padding: 1rem;
      background: var(--bg-subtle);
      border-radius: 8px;
      border: 1px solid var(--border-default);
    }

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }

    .section-title {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }

    .loading-badge, .hardware-badge {
      font-size: 0.6875rem;
      padding: 0.25rem 0.5rem;
      background: var(--bg-elevated);
      border-radius: 4px;
      color: var(--text-muted);
    }

    .loading-badge {
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.6; }
      50% { opacity: 1; }
    }

    .checkbox-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem;
      background: var(--bg-elevated);
      border: 2px solid var(--border-default);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 5%, transparent);
      }

      input[type="checkbox"] {
        margin-top: 0.125rem;
      }

      .checkbox-content {
        display: flex;
        flex-direction: column;
        gap: 0.125rem;
      }

      .checkbox-label {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary);
      }

      .checkbox-desc {
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .worker-count {
      margin-top: 0.5rem;
    }

    .worker-options {
      display: flex;
      gap: 0.5rem;
    }

    .worker-option {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      padding: 0.5rem 0.75rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.8125rem;
      color: var(--text-secondary);
      transition: all 0.15s;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 10%, transparent);
        color: var(--accent-primary);
      }

      input[type="radio"] {
        display: none;
      }
    }

    .parallel-mode {
      margin-top: 0.75rem;
    }

    .mode-options {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .mode-option {
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.75rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: color-mix(in srgb, var(--accent-primary) 10%, transparent);

        .mode-label {
          color: var(--accent-primary);
        }
      }

      input[type="radio"] {
        display: none;
      }
    }

    .mode-content {
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
    }

    .mode-label {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-primary);
    }

    .mode-desc {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }
  `]
})
export class TtsSettingsComponent implements OnInit {
  private readonly queueService = inject(QueueService);
  private readonly router = inject(Router);
  private readonly settingsService = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private readonly epubService = inject(EpubService);

  // Inputs
  readonly settings = input<TTSSettings>({
    device: 'mps',
    language: 'en',
    ttsEngine: 'xtts',
    fineTuned: 'ScarlettJohansson',
    temperature: 0.7,
    topP: 0.9,
    topK: 40,
    repetitionPenalty: 2.0,
    speed: 1.0,
    enableTextSplitting: false
  });
  readonly epubPath = input<string>('');
  readonly metadata = input<{
    title?: string;
    author?: string;
    year?: string;
    coverPath?: string;      // Path to cover image file
    outputFilename?: string; // Custom output filename (e.g., "My Book.m4b")
  } | undefined>(undefined);

  // Outputs
  readonly settingsChange = output<TTSSettings>();

  // State
  readonly ttsAvailable = signal(false);
  readonly checkingStatus = signal(true);
  readonly showAdvanced = signal(false);
  readonly addingToQueue = signal(false);
  readonly showSuccessModal = signal(false);
  readonly availableVoices = signal<VoiceOption[]>([
    { id: 'ScarlettJohansson', name: 'Scarlett Johansson', language: 'en', description: 'Natural, warm female voice' },
    { id: 'DavidAttenborough', name: 'David Attenborough', language: 'en', description: 'Documentary-style narration' },
    { id: 'BobRoss', name: 'Bob Ross', language: 'en', description: 'Calm, soothing male voice' },
    { id: 'MorganFreeman', name: 'Morgan Freeman', language: 'en', description: 'Deep, authoritative male voice' },
    { id: 'internal', name: 'Default XTTS', language: 'en', description: 'Built-in XTTS voice' }
  ]);

  // Parallel processing state
  readonly loadingHardwareInfo = signal(false);
  readonly hardwareInfo = signal<HardwareInfo | null>(null);

  ngOnInit(): void {
    this.checkStatus();
    this.detectHardware();
  }

  private async detectHardware(): Promise<void> {
    const electron = (window as any).electron;
    if (!electron?.parallelTts?.detectRecommendedWorkerCount) {
      // Default fallback when not in Electron
      this.hardwareInfo.set({ recommendedWorkers: 2, reason: 'Default (2 workers)' });
      return;
    }

    this.loadingHardwareInfo.set(true);
    try {
      const result = await electron.parallelTts.detectRecommendedWorkerCount();
      if (result.success && result.data) {
        this.hardwareInfo.set({
          recommendedWorkers: result.data.count,
          reason: result.data.reason
        });
      }
    } catch (err) {
      console.error('Failed to detect hardware:', err);
      this.hardwareInfo.set({ recommendedWorkers: 2, reason: 'Default (2 workers)' });
    } finally {
      this.loadingHardwareInfo.set(false);
    }
  }

  async checkStatus(): Promise<void> {
    this.checkingStatus.set(true);
    try {
      // TODO: Check ebook2audiobook availability via tts-bridge
      await new Promise(resolve => setTimeout(resolve, 1000));
      // For now, assume it's available
      this.ttsAvailable.set(true);
    } catch {
      this.ttsAvailable.set(false);
    } finally {
      this.checkingStatus.set(false);
    }
  }

  updateSetting<K extends keyof TTSSettings>(key: K, value: TTSSettings[K]): void {
    const current = this.settings();
    const updated = { ...current, [key]: value };
    this.settingsChange.emit(updated);
  }

  async addToQueue(): Promise<void> {
    let epubPathToUse = this.epubPath();
    if (!epubPathToUse) return;

    this.addingToQueue.set(true);

    try {
      // If there are modifications (e.g., new cover), save the EPUB first
      if (this.epubService.hasModifications()) {
        // Generate a modified epub path (add _modified before .epub)
        const modifiedPath = epubPathToUse.replace(/\.epub$/i, '_modified.epub');
        console.log('[TTS] Saving modified EPUB with new cover to:', modifiedPath);
        const savedPath = await this.epubService.saveModified(modifiedPath);
        if (savedPath) {
          epubPathToUse = savedPath;
          console.log('[TTS] Using modified EPUB for conversion:', epubPathToUse);
        } else {
          console.warn('[TTS] Failed to save modified EPUB, using original');
        }
      }

      const currentSettings = this.settings();
      const meta = this.metadata();
      // Use configured output dir, or fall back to library's audiobooks folder
      const configuredDir = this.settingsService.get<string>('audiobookOutputDir');
      const outputDir = configuredDir || this.libraryService.audiobooksPath() || '';
      await this.queueService.addJob({
        type: 'tts-conversion',
        epubPath: epubPathToUse,
        metadata: meta,
        config: {
          type: 'tts-conversion',
          device: currentSettings.device,
          language: currentSettings.language,
          ttsEngine: currentSettings.ttsEngine,
          fineTuned: currentSettings.fineTuned,
          temperature: currentSettings.temperature,
          topP: currentSettings.topP,
          topK: currentSettings.topK,
          repetitionPenalty: currentSettings.repetitionPenalty,
          speed: currentSettings.speed,
          enableTextSplitting: currentSettings.enableTextSplitting,
          outputFilename: meta?.outputFilename,
          outputDir: outputDir || undefined,
          // Parallel processing options
          useParallel: currentSettings.useParallel || false,
          parallelWorkers: currentSettings.parallelWorkers
        }
      });
      this.showSuccessModal.set(true);
    } catch (err) {
      console.error('Failed to add to queue:', err);
    } finally {
      this.addingToQueue.set(false);
    }
  }

  closeSuccessModal(): void {
    this.showSuccessModal.set(false);
  }

  goToQueue(): void {
    this.closeSuccessModal();
    this.router.navigate(['/queue']);
  }
}
