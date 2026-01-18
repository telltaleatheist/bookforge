import { Component, input, output, signal, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export interface TTSSettings {
  device: 'gpu' | 'mps' | 'cpu';
  language: string;
  voice: string;
  temperature: number;
  speed: number;
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
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
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
            <label for="voice">Voice Model</label>
            <select
              id="voice"
              [ngModel]="settings().voice"
              (ngModelChange)="updateSetting('voice', $event)"
            >
              @for (voice of availableVoices(); track voice.id) {
                <option [value]="voice.id">{{ voice.name }}</option>
              }
            </select>
          </div>
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

        <!-- Estimated Time -->
        <div class="estimate-section">
          <div class="estimate-label">Estimated Conversion Time</div>
          <div class="estimate-value">{{ estimatedTime() }}</div>
          <div class="estimate-note">Based on EPUB size and device selection</div>
        </div>

        <!-- Start Button -->
        <div class="actions">
          <desktop-button
            variant="primary"
            size="lg"
            [disabled]="!ttsAvailable()"
            (click)="startConversion.emit()"
          >
            Start Conversion
          </desktop-button>
        </div>
      }
    </div>
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

    .estimate-section {
      text-align: center;
      padding: 1.5rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      .estimate-label {
        font-size: 0.75rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.02em;
        margin-bottom: 0.5rem;
      }

      .estimate-value {
        font-size: 1.5rem;
        font-weight: 600;
        color: var(--text-primary);
      }

      .estimate-note {
        margin-top: 0.5rem;
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .actions {
      display: flex;
      justify-content: center;
    }
  `]
})
export class TtsSettingsComponent implements OnInit {
  // Inputs
  readonly settings = input<TTSSettings>({
    device: 'mps',
    language: 'en',
    voice: 'en_default',
    temperature: 0.75,
    speed: 1.0
  });

  // Outputs
  readonly settingsChange = output<TTSSettings>();
  readonly startConversion = output<void>();

  // State
  readonly ttsAvailable = signal(false);
  readonly checkingStatus = signal(true);
  readonly showAdvanced = signal(false);
  readonly availableVoices = signal<VoiceOption[]>([
    { id: 'en_default', name: 'Default English', language: 'en' },
    { id: 'en_male', name: 'English Male', language: 'en' },
    { id: 'en_female', name: 'English Female', language: 'en' }
  ]);

  // Computed estimated time
  readonly estimatedTime = signal('~45 minutes');

  ngOnInit(): void {
    this.checkStatus();
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
    this.updateEstimate(updated);
  }

  private updateEstimate(settings: TTSSettings): void {
    // Simple estimate based on device
    let baseTime = 60; // minutes for a typical book
    switch (settings.device) {
      case 'mps':
        baseTime = 45;
        break;
      case 'gpu':
        baseTime = 30;
        break;
      case 'cpu':
        baseTime = 120;
        break;
    }
    // Adjust for speed
    baseTime = Math.round(baseTime / settings.speed);

    if (baseTime < 60) {
      this.estimatedTime.set(`~${baseTime} minutes`);
    } else {
      const hours = Math.floor(baseTime / 60);
      const mins = baseTime % 60;
      this.estimatedTime.set(`~${hours}h ${mins}m`);
    }
  }
}
