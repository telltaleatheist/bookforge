import { Component, OnInit, OnDestroy, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../core/services/electron.service';
import { SettingsService } from '../../core/services/settings.service';
import { LibraryService } from '../../core/services/library.service';
import { QueueService } from '../queue/services/queue.service';
import { DesktopButtonComponent } from '../../creamsicle-desktop';
import { Router } from '@angular/router';

interface AudioFile {
  name: string;
  path: string;
  size: number;
  modifiedAt: Date;
  format: string;
  selected?: boolean;
}

interface EnhanceProgress {
  phase: 'starting' | 'converting' | 'enhancing' | 'finalizing' | 'complete' | 'error';
  percentage: number;
  message: string;
  error?: string;
}

type OutputMode = 'same-folder' | 'custom' | 'replace';

@Component({
  selector: 'app-post-processing',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="post-processing">
      <header class="header">
        <h1>Post-Processing</h1>
        <p class="subtitle">Enhance audio files using Resemble Enhance</p>
      </header>

      @if (checkingAvailability()) {
        <div class="loading-screen">
          <div class="loading-spinner"></div>
          <p>Checking Resemble Enhance availability...</p>
        </div>
      } @else {
      <div class="content">
        <!-- Drop Zone -->
        <section
          class="drop-zone"
          [class.dragover]="isDragging()"
          [class.has-files]="files().length > 0"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave($event)"
          (drop)="onDrop($event)"
        >
          @if (files().length === 0) {
            <div class="drop-content">
              <div class="drop-icon">&#127911;</div>
              <p>Drop audio files here</p>
              <p class="hint">or</p>
              <desktop-button variant="secondary" (click)="pickFiles()">
                Browse Files...
              </desktop-button>
              <p class="formats">Supported: M4B, M4A, MP3, WAV, FLAC, OGG, OPUS</p>
            </div>
          } @else {
            <!-- File List -->
            <div class="file-list-container">
              <div class="file-list-header">
                <span>{{ files().length }} file{{ files().length === 1 ? '' : 's' }} loaded</span>
                <div class="header-actions">
                  <desktop-button variant="ghost" size="sm" (click)="pickFiles()">
                    Add More
                  </desktop-button>
                  <desktop-button variant="ghost" size="sm" (click)="clearFiles()">
                    Clear All
                  </desktop-button>
                </div>
              </div>
              <div class="file-grid">
                @for (file of files(); track file.path) {
                  <div
                    class="file-card"
                    [class.selected]="file.selected"
                    (click)="toggleFile(file)"
                  >
                    <div class="file-icon">{{ getFormatIcon(file.format) }}</div>
                    <div class="file-info">
                      <div class="file-name" [title]="file.name">{{ file.name }}</div>
                      <div class="file-meta">
                        <span class="format">{{ file.format }}</span>
                        <span class="size">{{ formatSize(file.size) }}</span>
                      </div>
                    </div>
                    <div class="checkbox">
                      @if (file.selected) {
                        <span class="check">&#10003;</span>
                      }
                    </div>
                  </div>
                }
              </div>
            </div>
          }
        </section>

        <!-- Output Configuration -->
        @if (files().length > 0) {
          <section class="output-section">
            <h3>Output Location</h3>
            <div class="output-options">
              <label class="output-option" [class.selected]="outputMode() === 'replace'">
                <input
                  type="radio"
                  name="outputMode"
                  [value]="'replace'"
                  [checked]="outputMode() === 'replace'"
                  (change)="setOutputMode('replace')"
                />
                <div class="option-content">
                  <strong>Replace original</strong>
                  <span>Overwrite the original file with the enhanced version</span>
                </div>
              </label>
              <label class="output-option" [class.selected]="outputMode() === 'same-folder'">
                <input
                  type="radio"
                  name="outputMode"
                  [value]="'same-folder'"
                  [checked]="outputMode() === 'same-folder'"
                  (change)="setOutputMode('same-folder')"
                />
                <div class="option-content">
                  <strong>Same folder with suffix</strong>
                  <span>Save as filename_enhanced.ext in the same folder</span>
                </div>
              </label>
              <label class="output-option" [class.selected]="outputMode() === 'custom'">
                <input
                  type="radio"
                  name="outputMode"
                  [value]="'custom'"
                  [checked]="outputMode() === 'custom'"
                  (change)="setOutputMode('custom')"
                />
                <div class="option-content">
                  <strong>Custom directory</strong>
                  <span>Save enhanced files to a specific folder</span>
                </div>
              </label>
            </div>

            @if (outputMode() === 'custom') {
              <div class="custom-output-path">
                <input
                  type="text"
                  [value]="customOutputPath()"
                  (input)="customOutputPath.set($any($event.target).value)"
                  placeholder="Select output folder..."
                  readonly
                />
                <desktop-button variant="secondary" size="sm" (click)="browseOutputFolder()">
                  Browse...
                </desktop-button>
              </div>
            }

            @if (outputMode() === 'replace') {
              <div class="warning-message">
                <strong>Warning:</strong> Original files will be permanently replaced.
                Make sure you have backups if needed.
              </div>
            }
          </section>

          <!-- Actions -->
          <section class="actions-section">
            <div class="selection-info">
              {{ selectedCount() }} file{{ selectedCount() === 1 ? '' : 's' }} selected
            </div>

            <div class="action-buttons">
              <desktop-button
                variant="primary"
                [disabled]="selectedCount() === 0 || !isAvailable() || (outputMode() === 'custom' && !customOutputPath())"
                (click)="addToQueue()"
              >
                Add to Queue
              </desktop-button>
            </div>

            @if (queuedCount() > 0) {
              <div class="success-message">
                Added {{ queuedCount() }} file{{ queuedCount() === 1 ? '' : 's' }} to queue.
                <a href="javascript:void(0)" (click)="goToQueue()">View Queue</a>
              </div>
            }

            @if (lastError()) {
              <div class="error-message">
                {{ lastError() }}
              </div>
            }
          </section>
        }

        <!-- Info Panel -->
        <section class="info-section">
          <h3>About Resemble Enhance</h3>
          <p>
            Resemble Enhance is a deep learning audio enhancement tool that removes
            reverb, echo, and improves speech quality. It works especially well for
            TTS artifacts like the baked-in reverb in Orpheus output.
          </p>
          @if (deviceInfo()) {
            <p class="device-info">
              <strong>Device:</strong> {{ deviceInfo() }}
            </p>
          }
          @if (!isAvailable()) {
            <p class="error">
              <strong>Not Available:</strong> {{ availabilityError() || 'Resemble Enhance is not installed.' }}
              See AUDIO_ENHANCEMENT.md for setup instructions.
            </p>
          }
        </section>

        <!-- Enhancement Settings -->
        <section class="info-section">
          <h3>Enhancement Settings</h3>
          <div class="enhance-options">
            <!-- Engine Selector -->
            <div class="engine-selector">
              <label class="engine-option" [class.selected]="engine() === 'ffmpeg'" (click)="setEngine('ffmpeg')">
                <input type="radio" name="engine" value="ffmpeg" [checked]="engine() === 'ffmpeg'" />
                <div class="option-content">
                  <strong>FFmpeg Spectral Denoise</strong>
                  <span>Frequency-domain noise gate. No neural artifacts, preserves voice naturally. Best for voice recordings with echo/reverb.</span>
                </div>
              </label>
              <label class="engine-option" [class.selected]="engine() === 'resemble'" (click)="setEngine('resemble')">
                <input type="radio" name="engine" value="resemble" [checked]="engine() === 'resemble'" />
                <div class="option-content">
                  <strong>Resemble Enhance</strong>
                  <span>Neural audio enhancement. More powerful but can introduce artifacts. Requires conda environment.</span>
                </div>
              </label>
            </div>

            <!-- FFmpeg afftdn Settings -->
            @if (engine() === 'ffmpeg') {
              <div class="enhance-slider">
                <label>
                  <strong>Noise Reduction</strong>
                  <span class="slider-value">{{ ffmpegNr() }} dB</span>
                </label>
                <input type="range" min="1" max="60" step="1" [ngModel]="ffmpegNr()" (ngModelChange)="setFfmpegNr($event)" />
                <div class="slider-labels"><span>1 dB - Subtle</span><span>60 dB - Aggressive</span></div>
                <span class="slider-hint">
                  How many decibels of noise to remove. Higher values remove more echo/reverb but may start to affect voice clarity.
                  Start at 20 and increase until the echo is gone. If the voice starts sounding thin, back off.
                </span>
              </div>

              <div class="enhance-slider">
                <label>
                  <strong>Noise Floor</strong>
                  <span class="slider-value">{{ ffmpegNf() }} dB</span>
                </label>
                <input type="range" min="-80" max="-20" step="1" [ngModel]="ffmpegNf()" (ngModelChange)="setFfmpegNf($event)" />
                <div class="slider-labels"><span>-80 dB - Only quiet noise</span><span>-20 dB - Aggressive</span></div>
                <span class="slider-hint">
                  Audio below this level is treated as noise. Raise it to catch louder echo/reverb tails.
                  If set too high, quiet parts of speech will be treated as noise and removed.
                </span>
              </div>

              <!-- FFmpeg Advanced -->
              <div class="advanced-accordion">
                <button class="accordion-header" (click)="ffmpegAdvancedOpen.set(!ffmpegAdvancedOpen())">
                  <span class="accordion-arrow" [class.open]="ffmpegAdvancedOpen()">&#9654;</span>
                  <span>Advanced Settings</span>
                </button>
                @if (ffmpegAdvancedOpen()) {
                  <div class="accordion-body">
                    <div class="enhance-slider">
                      <label>
                        <strong>Residual Floor</strong>
                        <span class="slider-value">{{ ffmpegRf() }} dB</span>
                      </label>
                      <input type="range" min="-80" max="-20" step="1" [ngModel]="ffmpegRf()" (ngModelChange)="setFfmpegRf($event)" />
                      <div class="slider-labels"><span>-80 dB - Full removal</span><span>-20 dB - Keep residual</span></div>
                      <span class="slider-hint">
                        Floor level for the residual noise after processing. Lower values remove more completely
                        but can create unnatural silence. Higher values leave a small amount of ambient noise for natural sound.
                      </span>
                    </div>

                    <div class="enhance-slider">
                      <label>
                        <strong>Adaptivity</strong>
                        <span class="slider-value">{{ ffmpegAd() }}</span>
                      </label>
                      <input type="range" min="0" max="1" step="0.05" [ngModel]="ffmpegAd()" (ngModelChange)="setFfmpegAd($event)" />
                      <div class="slider-labels"><span>0 - Static profile</span><span>1 - Fully adaptive</span></div>
                      <span class="slider-hint">
                        How quickly the noise profile adapts to changes in the audio.
                        Higher values track changing noise better but may occasionally affect speech.
                      </span>
                    </div>

                    <label class="enhance-option">
                      <input type="checkbox" [ngModel]="ffmpegTn()" (ngModelChange)="setFfmpegTn($event)" />
                      <div>
                        <strong>Track Noise</strong>
                        <span class="option-desc">
                          Continuously analyze and update the noise profile as the audio plays.
                          Enable this for recordings where the background noise or echo level varies.
                        </span>
                      </div>
                    </label>
                  </div>
                }
              </div>
            }

            <!-- Resemble Enhance Settings -->
            @if (engine() === 'resemble') {
              <label class="enhance-option">
                <input type="checkbox" [ngModel]="denoiseOnly()" (ngModelChange)="setDenoiseOnly($event)" />
                <div>
                  <strong>Denoise Only</strong>
                  <span class="option-desc">
                    Runs only the denoiser model. Faster, but limited echo/reverb removal.
                    Uncheck to use the full enhancement pipeline with configurable denoise strength and neural upsampling.
                  </span>
                </div>
              </label>

              @if (denoiseOnly()) {
                <div class="enhance-slider">
                  <label>
                    <strong>Denoise Passes</strong>
                    <span class="slider-value">{{ passes() }}</span>
                  </label>
                  <input type="range" min="1" max="5" step="1" [ngModel]="passes()" (ngModelChange)="setPasses($event)" />
                  <div class="slider-labels"><span>1 - Single pass</span><span>5 - Maximum</span></div>
                  <span class="slider-hint">
                    Runs the denoiser multiple times in sequence.
                    Each pass feeds the previous output back through the model, progressively removing residual echo and reverb.
                  </span>
                </div>
              }

              @if (!denoiseOnly()) {
                <div class="enhance-slider">
                  <label>
                    <strong>Denoise Strength (lambda)</strong>
                    <span class="slider-value">{{ lambd() }}</span>
                  </label>
                  <input type="range" min="0" max="1" step="0.05" [ngModel]="lambd()" (ngModelChange)="setLambd($event)" />
                  <div class="slider-labels"><span>0 - Original signal</span><span>1 - Full denoise</span></div>
                  <span class="slider-hint">
                    Controls how much of the denoised signal is blended with the original.
                    Higher values remove more echo/reverb but may alter the voice character.
                  </span>
                </div>

                <div class="enhance-slider">
                  <label>
                    <strong>Enhancement Temperature (tau)</strong>
                    <span class="slider-value">{{ tau() }}</span>
                  </label>
                  <input type="range" min="0" max="1" step="0.05" [ngModel]="tau()" (ngModelChange)="setTau($event)" />
                  <div class="slider-labels"><span>0 - Conservative</span><span>1 - Aggressive</span></div>
                  <span class="slider-hint">
                    Controls how aggressively the neural upsampler reshapes the audio.
                    Lower values preserve the original character. Higher values can introduce underwater-like distortion.
                  </span>
                </div>

                <div class="advanced-accordion">
                  <button class="accordion-header" (click)="advancedOpen.set(!advancedOpen())">
                    <span class="accordion-arrow" [class.open]="advancedOpen()">&#9654;</span>
                    <span>Advanced Settings</span>
                  </button>
                  @if (advancedOpen()) {
                    <div class="accordion-body">
                      <div class="enhance-slider">
                        <label>
                          <strong>CFM Steps (NFE)</strong>
                          <span class="slider-value">{{ nfe() }}</span>
                        </label>
                        <input type="range" min="4" max="128" step="4" [ngModel]="nfe()" (ngModelChange)="setNfe($event)" />
                        <div class="slider-labels"><span>4 - Fast / rough</span><span>128 - Slow / refined</span></div>
                        <span class="slider-hint">
                          Number of steps the neural flow model takes to transform the audio.
                          64 is the default. Values below 16 may sound noticeably worse.
                        </span>
                      </div>

                      <div class="enhance-select">
                        <label>
                          <strong>ODE Solver</strong>
                        </label>
                        <div class="select-row">
                          <select [ngModel]="solver()" (ngModelChange)="setSolver($event)">
                            <option value="midpoint">Midpoint (default)</option>
                            <option value="rk4">RK4 (Runge-Kutta 4th order)</option>
                            <option value="euler">Euler (fastest)</option>
                          </select>
                        </div>
                        <span class="slider-hint">
                          The numerical method used to solve the flow matching equation.
                          Midpoint is a good balance. RK4 is most accurate but slowest.
                        </span>
                      </div>
                    </div>
                  }
                </div>
              }
            }
          </div>
        </section>
      </div>
      }
    </div>
  `,
  styles: [`
    .post-processing {
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--border-default);
      background: var(--bg-subtle);

      h1 {
        margin: 0 0 0.25rem;
        font-size: 1.5rem;
        font-weight: 600;
      }

      .subtitle {
        margin: 0;
        color: var(--text-secondary);
        font-size: 0.875rem;
      }
    }

    .loading-screen {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      color: var(--text-secondary);

      p {
        margin: 0;
        font-size: 0.875rem;
      }
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 2rem;
      display: flex;
      flex-direction: column;
      gap: 2rem;
    }

    .drop-zone {
      min-height: 200px;
      border: 2px dashed var(--border-default);
      border-radius: 12px;
      transition: all 0.2s ease;

      &.dragover {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }

      &.has-files {
        border-style: solid;
        border-color: var(--border-default);
      }
    }

    .drop-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      text-align: center;
      color: var(--text-secondary);

      .drop-icon {
        font-size: 3rem;
        margin-bottom: 1rem;
      }

      p {
        margin: 0 0 0.5rem;
      }

      .hint {
        font-size: 0.75rem;
        margin: 0.75rem 0;
      }

      .formats {
        margin-top: 1rem;
        font-size: 0.75rem;
        color: var(--text-muted);
      }
    }

    .file-list-container {
      padding: 1rem;
    }

    .file-list-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1rem;
      padding-bottom: 0.75rem;
      border-bottom: 1px solid var(--border-default);

      span {
        font-weight: 500;
        color: var(--text-primary);
      }

      .header-actions {
        display: flex;
        gap: 0.5rem;
      }
    }

    .file-grid {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      max-height: 300px;
      overflow-y: auto;
    }

    .file-card {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1rem;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
        background: var(--bg-subtle);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }
    }

    .file-icon {
      font-size: 1.5rem;
      width: 40px;
      text-align: center;
    }

    .file-info {
      flex: 1;
      min-width: 0;

      .file-name {
        font-weight: 500;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .file-meta {
        display: flex;
        gap: 1rem;
        font-size: 0.75rem;
        color: var(--text-secondary);
        margin-top: 0.25rem;
      }
    }

    .checkbox {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border-default);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-default);

      .check {
        color: var(--accent-primary);
        font-weight: bold;
      }
    }

    .file-card.selected .checkbox {
      border-color: var(--accent-primary);
      background: var(--accent-primary);

      .check {
        color: white;
      }
    }

    .output-section {
      h3 {
        margin: 0 0 1rem;
        font-size: 1rem;
        font-weight: 600;
      }
    }

    .output-options {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .output-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 1rem;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }

      input[type="radio"] {
        margin-top: 0.25rem;
      }

      .option-content {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;

        strong {
          font-size: 0.875rem;
        }

        span {
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
      }
    }

    .custom-output-path {
      display: flex;
      gap: 0.5rem;
      margin-top: 1rem;

      input {
        flex: 1;
        padding: 0.5rem 0.75rem;
        border: 1px solid var(--border-default);
        border-radius: 6px;
        background: var(--bg-default);
        color: var(--text-primary);
        font-size: 0.875rem;
      }
    }

    .warning-message {
      margin-top: 1rem;
      padding: 0.75rem 1rem;
      background: var(--warning-bg, #fff3cd);
      color: var(--warning-text, #856404);
      border-radius: 6px;
      font-size: 0.8125rem;
    }

    .actions-section {
      padding: 1.5rem;
      background: var(--bg-subtle);
      border-radius: 8px;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      align-items: center;

      .selection-info {
        font-size: 0.875rem;
        color: var(--text-secondary);
      }

      .action-buttons {
        display: flex;
        gap: 0.75rem;
      }
    }

    .error-message {
      padding: 0.75rem 1rem;
      background: var(--danger-bg, #f8d7da);
      color: var(--danger-text, #721c24);
      border-radius: 6px;
      font-size: 0.875rem;
    }

    .success-message {
      padding: 0.75rem 1rem;
      background: var(--success-bg, #d4edda);
      color: var(--success-text, #155724);
      border-radius: 6px;
      font-size: 0.875rem;

      a {
        color: var(--accent-primary);
        text-decoration: underline;
        margin-left: 0.5rem;
      }
    }

    .info-section {
      padding: 1.5rem;
      background: var(--bg-subtle);
      border-radius: 8px;

      h3 {
        margin: 0 0 0.75rem;
        font-size: 1rem;
        font-weight: 600;
      }

      p {
        margin: 0 0 0.5rem;
        font-size: 0.875rem;
        color: var(--text-secondary);
        line-height: 1.5;
      }

      .device-info {
        color: var(--text-primary);
      }

      .error {
        margin-top: 1rem;
        padding: 0.75rem;
        background: var(--danger-bg, #f8d7da);
        border-radius: 4px;
        color: var(--danger-text, #721c24);
      }
    }

    .engine-selector {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      margin-bottom: 0.5rem;
    }

    .engine-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-default);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        border-color: var(--border-hover);
      }

      &.selected {
        border-color: var(--accent-primary);
        background: var(--accent-subtle);
      }

      input[type="radio"] {
        margin-top: 3px;
      }

      .option-content {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;

        strong {
          font-size: 0.875rem;
        }

        span {
          font-size: 0.75rem;
          color: var(--text-secondary);
        }
      }
    }

    .enhance-options {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .enhance-option {
      display: flex;
      align-items: flex-start;
      gap: 0.75rem;
      cursor: pointer;

      input[type="checkbox"] {
        margin-top: 3px;
        width: 16px;
        height: 16px;
        accent-color: var(--accent-primary);
        cursor: pointer;
      }

      strong {
        display: block;
        font-size: 0.875rem;
        color: var(--text-primary);
      }

      .option-desc {
        display: block;
        font-size: 0.75rem;
        color: var(--text-secondary);
        margin-top: 2px;
      }
    }

    .enhance-slider {
      label {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 0.875rem;
        margin-bottom: 4px;

        strong {
          color: var(--text-primary);
        }

        .slider-value {
          font-size: 0.75rem;
          color: var(--text-secondary);
          font-family: monospace;
        }
      }

      input[type="range"] {
        width: 100%;
        height: 4px;
        accent-color: var(--accent-primary);
        cursor: pointer;
      }

      .slider-labels {
        display: flex;
        justify-content: space-between;
        font-size: 0.7rem;
        color: var(--text-tertiary);
        margin-top: 2px;
      }

      .slider-hint {
        display: block;
        font-size: 0.7rem;
        color: var(--text-tertiary);
        margin-top: 4px;
        line-height: 1.4;
      }
    }

    .enhance-select {
      label {
        display: block;
        font-size: 0.875rem;
        margin-bottom: 6px;

        strong {
          color: var(--text-primary);
        }
      }

      .select-row {
        margin-bottom: 4px;
      }

      select {
        width: 100%;
        padding: 6px 10px;
        border: 1px solid var(--border-default);
        border-radius: 6px;
        background: var(--bg-default);
        color: var(--text-primary);
        font-size: 0.8125rem;
        cursor: pointer;

        &:focus {
          outline: none;
          border-color: var(--accent-primary);
        }
      }

      .slider-hint {
        display: block;
        font-size: 0.7rem;
        color: var(--text-tertiary);
        margin-top: 4px;
        line-height: 1.4;
      }
    }

    .advanced-accordion {
      border: 1px solid var(--border-default);
      border-radius: 8px;
      overflow: hidden;

      .accordion-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.75rem 1rem;
        background: var(--bg-default);
        border: none;
        color: var(--text-secondary);
        font-size: 0.8125rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s ease;

        &:hover {
          background: var(--bg-subtle);
        }
      }

      .accordion-arrow {
        font-size: 0.6rem;
        transition: transform 0.2s ease;
        display: inline-block;

        &.open {
          transform: rotate(90deg);
        }
      }

      .accordion-body {
        padding: 1rem;
        border-top: 1px solid var(--border-default);
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }
    }
  `]
})
export class PostProcessingComponent implements OnInit, OnDestroy {
  private readonly electron = inject(ElectronService);
  private readonly settings = inject(SettingsService);
  private readonly libraryService = inject(LibraryService);
  private readonly queueService = inject(QueueService);
  private readonly router = inject(Router);
  private unsubscribeProgress?: () => void;

  // State
  readonly isAvailable = signal(false);
  readonly availabilityError = signal<string | null>(null);
  readonly deviceInfo = signal<string | null>(null);
  readonly checkingAvailability = signal(true);
  readonly files = signal<AudioFile[]>([]);
  readonly isDragging = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly queuedCount = signal(0);

  // Output configuration - default to same-folder mode with _enhanced suffix
  // (replace mode should only be used from the book panel's Enhance tab)
  readonly outputMode = signal<OutputMode>('same-folder');
  readonly customOutputPath = signal('');

  // Enhancement settings (persisted via tool-paths.json)
  readonly engine = signal<'resemble' | 'ffmpeg'>('resemble');
  readonly denoiseOnly = signal(false);
  readonly passes = signal(1);
  readonly lambd = signal(0.9);
  readonly tau = signal(0.0);
  readonly nfe = signal(64);
  readonly solver = signal<'midpoint' | 'rk4' | 'euler'>('midpoint');
  readonly advancedOpen = signal(false);

  // FFmpeg afftdn settings
  readonly ffmpegNr = signal(20);
  readonly ffmpegNf = signal(-40);
  readonly ffmpegRf = signal(-38);
  readonly ffmpegAd = signal(0.5);
  readonly ffmpegTn = signal(true);
  readonly ffmpegAdvancedOpen = signal(false);

  // Computed
  readonly selectedCount = computed(() =>
    this.files().filter(f => f.selected).length
  );

  readonly selectedFiles = computed(() =>
    this.files().filter(f => f.selected)
  );

  ngOnInit(): void {
    this.checkAvailability();
    this.setupProgressListener();
    this.loadEnhanceSettings();
  }

  ngOnDestroy(): void {
    this.unsubscribeProgress?.();
  }

  private async checkAvailability(): Promise<void> {
    console.log('[PostProcessing] Checking Resemble Enhance availability...');
    this.checkingAvailability.set(true);
    const result = await this.electron.resembleCheckAvailable();
    console.log('[PostProcessing] Availability result:', JSON.stringify(result));
    this.isAvailable.set(result.available);
    this.availabilityError.set(result.error || null);
    this.checkingAvailability.set(false);

    // Set device info
    if (result.available && result.device) {
      const deviceName = result.device.toUpperCase();
      const wslSuffix = result.usingWsl ? ' (WSL)' : '';
      this.deviceInfo.set(`${deviceName}${wslSuffix}`);
    }
  }

  private setupProgressListener(): void {
    this.unsubscribeProgress = this.electron.onResembleProgress((progress) => {
      // Progress is now handled by the queue system
      // This listener is kept for backwards compatibility
      console.log('[PostProcessing] Progress:', progress);
    });
  }

  // Drag and drop handlers
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const supportedExtensions = ['m4b', 'm4a', 'mp3', 'wav', 'flac', 'ogg', 'opus'];
    const newFiles: AudioFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.split('.').pop()?.toLowerCase() || '';

      if (supportedExtensions.includes(ext)) {
        // Get the file path - this works in Electron
        const filePath = (file as any).path;
        if (filePath) {
          newFiles.push({
            name: file.name,
            path: filePath,
            size: file.size,
            modifiedAt: new Date(file.lastModified),
            format: ext.toUpperCase(),
            selected: true
          });
        }
      }
    }

    if (newFiles.length > 0) {
      // Add to existing files, avoiding duplicates
      const existingPaths = new Set(this.files().map(f => f.path));
      const uniqueNewFiles = newFiles.filter(f => !existingPaths.has(f.path));
      this.files.update(files => [...files, ...uniqueNewFiles]);
    }
  }

  async pickFiles(): Promise<void> {
    const result = await this.electron.resemblePickFiles();
    if (result.success && result.data && result.data.length > 0) {
      // Add picked files to the list, avoiding duplicates
      const existingPaths = new Set(this.files().map(f => f.path));
      const newFiles = result.data
        .filter(f => !existingPaths.has(f.path))
        .map(f => ({ ...f, selected: true }));

      if (newFiles.length > 0) {
        this.files.update(files => [...files, ...newFiles]);
      }
    }
  }

  clearFiles(): void {
    this.files.set([]);
    this.queuedCount.set(0);
    this.lastError.set(null);
  }

  toggleFile(file: AudioFile): void {
    this.files.update(files =>
      files.map(f =>
        f.path === file.path ? { ...f, selected: !f.selected } : f
      )
    );
  }

  setOutputMode(mode: OutputMode): void {
    this.outputMode.set(mode);
  }

  async browseOutputFolder(): Promise<void> {
    const result = await this.electron.openFolderDialog();
    if (result.success && result.folderPath) {
      this.customOutputPath.set(result.folderPath);
    }
  }

  async addToQueue(): Promise<void> {
    const selected = this.selectedFiles();
    if (selected.length === 0) return;

    this.lastError.set(null);
    let addedCount = 0;

    try {
      for (const file of selected) {
        // Determine output path based on mode
        let outputPath: string | undefined;
        const mode = this.outputMode();

        if (mode === 'same-folder') {
          // Add _enhanced suffix before extension
          const filePathNorm = file.path.replace(/\\/g, '/');
          const dir = filePathNorm.substring(0, filePathNorm.lastIndexOf('/'));
          const ext = filePathNorm.substring(filePathNorm.lastIndexOf('.'));
          const basename = filePathNorm.substring(filePathNorm.lastIndexOf('/') + 1, filePathNorm.lastIndexOf('.'));
          outputPath = `${dir}/${basename}_enhanced${ext}`;
        } else if (mode === 'custom') {
          const customDir = this.customOutputPath();
          if (!customDir) {
            this.lastError.set('Please select an output folder');
            return;
          }
          outputPath = `${customDir}/${file.name}`;
        }
        // For 'replace' mode, outputPath stays undefined (will replace original)

        await this.queueService.addJob({
          type: 'resemble-enhance',
          epubPath: file.path, // Using epubPath field for the audio file path
          config: {
            type: 'resemble-enhance',
            inputPath: file.path,
            outputPath,
            replaceOriginal: mode === 'replace'
          },
          metadata: {
            title: file.name
          }
        });

        addedCount++;
      }

      this.queuedCount.set(addedCount);

      // Deselect queued files
      this.files.update(files =>
        files.map(f => ({ ...f, selected: false }))
      );

    } catch (err) {
      console.error('[PostProcessing] Failed to add jobs to queue:', err);
      this.lastError.set(err instanceof Error ? err.message : 'Failed to add to queue');
    }
  }

  goToQueue(): void {
    this.router.navigate(['/queue']);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  private async loadEnhanceSettings(): Promise<void> {
    const result = await this.electron.toolPathsGetConfig();
    if (result.success && result.data) {
      const data = result.data as any;
      if (data.resembleEngine !== undefined) this.engine.set(data.resembleEngine);
      if (data.resembleDenoiseOnly !== undefined) this.denoiseOnly.set(!!data.resembleDenoiseOnly);
      if (data.resemblePasses !== undefined) this.passes.set(Number(data.resemblePasses));
      if (data.resembleLambd !== undefined) this.lambd.set(Number(data.resembleLambd));
      if (data.resembleTau !== undefined) this.tau.set(Number(data.resembleTau));
      if (data.resembleNfe !== undefined) this.nfe.set(Number(data.resembleNfe));
      if (data.resembleSolver !== undefined) this.solver.set(data.resembleSolver);
      if (data.ffmpegNoiseReduction !== undefined) this.ffmpegNr.set(Number(data.ffmpegNoiseReduction));
      if (data.ffmpegNoiseFloor !== undefined) this.ffmpegNf.set(Number(data.ffmpegNoiseFloor));
      if (data.ffmpegResidualFloor !== undefined) this.ffmpegRf.set(Number(data.ffmpegResidualFloor));
      if (data.ffmpegAdaptivity !== undefined) this.ffmpegAd.set(Number(data.ffmpegAdaptivity));
      if (data.ffmpegTrackNoise !== undefined) this.ffmpegTn.set(!!data.ffmpegTrackNoise);
    }
  }

  async setEngine(value: 'resemble' | 'ffmpeg'): Promise<void> {
    this.engine.set(value);
    await this.electron.toolPathsUpdateConfig({ resembleEngine: value } as any);
  }

  async setDenoiseOnly(value: boolean): Promise<void> {
    this.denoiseOnly.set(value);
    await this.electron.toolPathsUpdateConfig({ resembleDenoiseOnly: value } as any);
  }

  async setPasses(value: number): Promise<void> {
    const num = Math.round(parseInt(String(value), 10));
    this.passes.set(num);
    await this.electron.toolPathsUpdateConfig({ resemblePasses: num } as any);
  }

  async setLambd(value: number): Promise<void> {
    const num = parseFloat(String(value));
    this.lambd.set(num);
    await this.electron.toolPathsUpdateConfig({ resembleLambd: num } as any);
  }

  async setTau(value: number): Promise<void> {
    const num = parseFloat(String(value));
    this.tau.set(num);
    await this.electron.toolPathsUpdateConfig({ resembleTau: num } as any);
  }

  async setNfe(value: number): Promise<void> {
    const num = parseInt(String(value), 10);
    this.nfe.set(num);
    await this.electron.toolPathsUpdateConfig({ resembleNfe: num } as any);
  }

  async setSolver(value: string): Promise<void> {
    const solver = value as 'midpoint' | 'rk4' | 'euler';
    this.solver.set(solver);
    await this.electron.toolPathsUpdateConfig({ resembleSolver: solver } as any);
  }

  async setFfmpegNr(value: number): Promise<void> {
    const num = Math.round(parseFloat(String(value)));
    this.ffmpegNr.set(num);
    await this.electron.toolPathsUpdateConfig({ ffmpegNoiseReduction: num } as any);
  }

  async setFfmpegNf(value: number): Promise<void> {
    const num = Math.round(parseFloat(String(value)));
    this.ffmpegNf.set(num);
    await this.electron.toolPathsUpdateConfig({ ffmpegNoiseFloor: num } as any);
  }

  async setFfmpegRf(value: number): Promise<void> {
    const num = Math.round(parseFloat(String(value)));
    this.ffmpegRf.set(num);
    await this.electron.toolPathsUpdateConfig({ ffmpegResidualFloor: num } as any);
  }

  async setFfmpegAd(value: number): Promise<void> {
    const num = parseFloat(String(value));
    this.ffmpegAd.set(num);
    await this.electron.toolPathsUpdateConfig({ ffmpegAdaptivity: num } as any);
  }

  async setFfmpegTn(value: boolean): Promise<void> {
    this.ffmpegTn.set(value);
    await this.electron.toolPathsUpdateConfig({ ffmpegTrackNoise: value } as any);
  }

  getFormatIcon(format: string): string {
    switch (format.toUpperCase()) {
      case 'M4B':
      case 'M4A':
        return '\uD83C\uDFA7'; // Headphones
      case 'MP3':
        return '\uD83C\uDFB5'; // Musical note
      case 'WAV':
      case 'FLAC':
        return '\uD83C\uDF9B'; // Control knobs
      default:
        return '\uD83D\uDCBE'; // Floppy disk
    }
  }
}
