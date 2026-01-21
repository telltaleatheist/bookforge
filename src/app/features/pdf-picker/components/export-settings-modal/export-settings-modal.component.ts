import { Component, output, input, signal, computed, ChangeDetectionStrategy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export type ExportFormat = 'pdf' | 'epub' | 'txt' | 'audiobook';

export interface ExportSettings {
  format: ExportFormat;
  quality: 'low' | 'medium' | 'high' | 'maximum';
  removeBackgrounds: boolean;
}

export interface ExportResult {
  confirmed: boolean;
  settings?: ExportSettings;
}

@Component({
  selector: 'app-export-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-backdrop" (click)="cancel()">
      <div class="export-window" (click)="$event.stopPropagation()">
        <!-- Title bar -->
        <div class="title-bar">
          <span class="title">Export</span>
          <button class="close-btn" (click)="cancel()">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </button>
        </div>

        <!-- Content area -->
        <div class="content-area">
          <div class="settings-section">
            <!-- Format selection -->
            <div class="format-selector">
              @if (isFormatAvailable('pdf')) {
                <button
                  class="format-btn"
                  [class.active]="format() === 'pdf'"
                  (click)="format.set('pdf')"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <path d="M9 15v-2h2a1 1 0 0 1 0 2H9zm0 0v2"/>
                    <path d="M13 13h1.5a1.5 1.5 0 0 1 0 3H13v-3z"/>
                  </svg>
                  <span>PDF</span>
                </button>
              }
              @if (isFormatAvailable('epub')) {
                <button
                  class="format-btn"
                  [class.active]="format() === 'epub'"
                  (click)="format.set('epub')"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                  </svg>
                  <span>EPUB</span>
                </button>
              }
              @if (isFormatAvailable('txt')) {
                <button
                  class="format-btn"
                  [class.active]="format() === 'txt'"
                  (click)="format.set('txt')"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="8" y1="13" x2="16" y2="13"/>
                    <line x1="8" y1="17" x2="12" y2="17"/>
                  </svg>
                  <span>TXT</span>
                </button>
              }
              @if (isFormatAvailable('audiobook')) {
                <button
                  class="format-btn"
                  [class.active]="format() === 'audiobook'"
                  (click)="format.set('audiobook')"
                >
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="12" r="10"/>
                    <circle cx="12" cy="12" r="4"/>
                    <path d="M12 8v4l3 3"/>
                  </svg>
                  <span>Audiobook Producer</span>
                </button>
              }
            </div>

            <!-- Audiobook info -->
            @if (format() === 'audiobook') {
              <div class="setting-row audiobook-info">
                <div class="setting-info">
                  <label>Export to Audiobook Producer</label>
                  <p>Creates an EPUB with chapters and adds it to your Audiobook Producer queue for TTS conversion.</p>
                </div>
              </div>
            }

            <!-- Quality setting (only shown for PDF when backgrounds are removed) -->
            @if (format() === 'pdf' && removeBackgrounds()) {
              <div class="setting-row">
                <div class="setting-info">
                  <label>Export Quality</label>
                  <p>Higher quality produces larger files but sharper images</p>
                </div>
                <select
                  class="select-input"
                  [value]="quality()"
                  (change)="quality.set($any($event.target).value)"
                >
                  <option value="low">Low (1x) - Smallest file</option>
                  <option value="medium">Medium (1.5x)</option>
                  <option value="high">High (2x) - Recommended</option>
                  <option value="maximum">Maximum (3x) - Best quality</option>
                </select>
              </div>
            }

            <!-- File info -->
            <div class="info-card">
              <div class="info-row">
                <span class="info-label">Source</span>
                <span class="info-value">{{ pdfName() }}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Pages</span>
                <span class="info-value">{{ totalPages() }}</span>
              </div>
              @if (format() === 'pdf' && removeBackgrounds()) {
                <div class="info-row status">
                  <span class="info-label">Backgrounds</span>
                  <span class="info-value removed">Removed</span>
                </div>
              }
              <div class="info-row">
                <span class="info-label">Output</span>
                <span class="info-value">{{ getOutputFilename() }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Footer with buttons -->
        <div class="footer">
          <span class="shortcut-hint">⌘E</span>
          <div class="footer-buttons">
            <desktop-button variant="ghost" (click)="cancel()">
              Cancel
            </desktop-button>
            <desktop-button variant="primary" (click)="confirm()">
              {{ format() === 'audiobook' ? 'Send to Audiobook Producer' : 'Export ' + format().toUpperCase() }}
            </desktop-button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 9999;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .export-window {
      width: 420px;
      max-width: 90vw;
      background: var(--bg-base);
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: slideUp 0.2s ease-out;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .title-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px 16px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      position: relative;
    }

    .title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .close-btn {
      position: absolute;
      left: 12px;
      width: 24px;
      height: 24px;
      border: none;
      background: var(--bg-elevated);
      border-radius: 6px;
      color: var(--text-tertiary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;

      &:hover {
        background: var(--error);
        color: white;
      }
    }

    .content-area {
      padding: 20px;
    }

    .settings-section {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .format-selector {
      display: flex;
      gap: 8px;
      padding: 4px;
      background: var(--bg-surface);
      border-radius: 10px;
    }

    .format-btn {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      padding: 12px 16px;
      background: transparent;
      border: 2px solid transparent;
      border-radius: 8px;
      color: var(--text-tertiary);
      cursor: pointer;
      transition: all 0.15s;

      svg {
        opacity: 0.6;
        transition: opacity 0.15s;
      }

      span {
        font-size: 12px;
        font-weight: 600;
      }

      &:hover {
        background: var(--bg-elevated);
        color: var(--text-secondary);

        svg {
          opacity: 0.8;
        }
      }

      &.active {
        background: var(--bg-base);
        border-color: var(--accent);
        color: var(--accent);

        svg {
          opacity: 1;
          stroke: var(--accent);
        }
      }
    }

    .setting-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
      background: var(--bg-surface);
      border-radius: 8px;
    }

    .setting-info {
      flex: 1;

      label {
        display: block;
        font-size: 14px;
        font-weight: 500;
        color: var(--text-primary);
        margin-bottom: 4px;
      }

      p {
        margin: 0;
        font-size: 12px;
        color: var(--text-tertiary);
        line-height: 1.4;
      }
    }

    .select-input {
      padding: 8px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
      min-width: 180px;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }

      option {
        background: var(--bg-surface);
      }
    }

    .info-card {
      background: var(--bg-surface);
      border-radius: 8px;
      padding: 14px 16px;
    }

    .info-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;

      &:not(:last-child) {
        border-bottom: 1px solid var(--border-subtle);
      }

      &.status .info-value.removed {
        color: var(--success);
        font-weight: 600;
      }
    }

    .info-label {
      font-size: 12px;
      color: var(--text-tertiary);
    }

    .info-value {
      font-size: 13px;
      color: var(--text-primary);
      font-weight: 500;
      max-width: 240px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 20px;
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
    }

    .shortcut-hint {
      font-size: 11px;
      color: var(--text-tertiary);
      padding: 4px 8px;
      background: var(--bg-elevated);
      border-radius: 4px;
      font-family: monospace;
    }

    .footer-buttons {
      display: flex;
      gap: 8px;
    }
  `]
})
export class ExportSettingsModalComponent implements OnInit {
  pdfName = input.required<string>();
  totalPages = input.required<number>();
  removeBackgrounds = input<boolean>(false);
  availableFormats = input<ExportFormat[]>(['pdf', 'epub', 'txt', 'audiobook']);

  result = output<ExportResult>();

  readonly format = signal<ExportFormat>('pdf');
  readonly quality = signal<'low' | 'medium' | 'high' | 'maximum'>('high');

  // Computed to check if format is available
  isFormatAvailable(format: ExportFormat): boolean {
    return this.availableFormats().includes(format);
  }

  // Set initial format to first available
  ngOnInit(): void {
    const available = this.availableFormats();
    if (available.length > 0 && !available.includes(this.format())) {
      this.format.set(available[0]);
    }
  }

  getOutputFilename(): string {
    const baseName = this.pdfName().replace(/\.[^.]+$/, '');
    const ext = this.format();
    if (ext === 'pdf' && this.removeBackgrounds()) {
      return `${baseName}_clean.pdf`;
    }
    if (ext === 'audiobook') {
      return `${baseName}.epub → Audiobook Queue`;
    }
    return `${baseName}_exported.${ext}`;
  }

  cancel(): void {
    this.result.emit({ confirmed: false });
  }

  confirm(): void {
    this.result.emit({
      confirmed: true,
      settings: {
        format: this.format(),
        quality: this.quality(),
        removeBackgrounds: this.removeBackgrounds()
      }
    });
  }
}
