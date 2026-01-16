import { Component, input, output, signal, effect, inject, ChangeDetectionStrategy, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { ElectronService } from '../../../../core/services/electron.service';
import { PluginService } from '../../../../core/services/plugin.service';

export type OcrEngine = 'tesseract' | 'surya';
export type OcrScope = 'all' | 'current' | 'selected' | 'range';

export interface OcrSettings {
  engine: OcrEngine;
  language: string;
  tesseractPsm: number;
}

export interface OcrJob {
  scope: OcrScope;
  pages?: number[];  // For 'selected' or 'range' scope
  rangeStart?: number;
  rangeEnd?: number;
}

export interface OcrTextLine {
  text: string;
  confidence: number;
  bbox: [number, number, number, number];  // [x1, y1, x2, y2]
}

export interface OcrPageResult {
  page: number;
  text: string;
  confidence: number;
  textLines?: OcrTextLine[];  // Text lines with bounding boxes
}

@Component({
  selector: 'app-ocr-settings-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="modal-overlay" (click)="close.emit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>OCR - Text Recognition</h2>
          <button class="close-btn" (click)="close.emit()">×</button>
        </div>

        <div class="modal-body">
          <!-- Engine Selection -->
          <div class="section">
            <h3 class="section-title">OCR Engine</h3>
            <div class="engine-cards">
              @for (engine of engines(); track engine.id) {
                <div
                  class="engine-card"
                  [class.selected]="settings().engine === engine.id"
                  [class.unavailable]="!checkingEngines() && !engine.available"
                  [class.checking]="checkingEngines()"
                  (click)="!checkingEngines() && engine.available && selectEngine(engine.id)"
                >
                  <div class="engine-header">
                    <span class="engine-icon">
                      @if (engine.id === 'tesseract') { 🔤 }
                      @else if (engine.id === 'surya') { 🌅 }
                    </span>
                    <span class="engine-name">{{ engine.name }}</span>
                  </div>
                  <div class="engine-status">
                    @if (checkingEngines()) {
                      <span class="status-checking">Checking...</span>
                    } @else if (engine.available) {
                      <span class="status-available">✓ v{{ engine.version }}</span>
                    } @else {
                      <span class="status-unavailable">Not installed</span>
                    }
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- Language (Tesseract) -->
          @if (settings().engine === 'tesseract' && engineAvailable()) {
            <div class="section">
              <h3 class="section-title">Language</h3>
              <select
                class="select-input"
                [ngModel]="settings().language"
                (ngModelChange)="updateSetting('language', $event)"
              >
                @for (lang of availableLanguages(); track lang) {
                  <option [value]="lang">{{ getLanguageName(lang) }}</option>
                }
              </select>
            </div>
          }

          <!-- Scope Selection -->
          <div class="section">
            <h3 class="section-title">Pages to OCR</h3>
            <div class="scope-options">
              <label class="radio-option">
                <input
                  type="radio"
                  name="scope"
                  value="all"
                  [checked]="scope() === 'all'"
                  (change)="scope.set('all')"
                />
                <span class="radio-label">
                  <strong>All Pages</strong>
                  <span class="radio-hint">{{ totalPages() }} pages</span>
                </span>
              </label>

              <label class="radio-option">
                <input
                  type="radio"
                  name="scope"
                  value="current"
                  [checked]="scope() === 'current'"
                  (change)="scope.set('current')"
                />
                <span class="radio-label">
                  <strong>Current Page</strong>
                  <span class="radio-hint">Page {{ currentPage() + 1 }}</span>
                </span>
              </label>

              <label class="radio-option">
                <input
                  type="radio"
                  name="scope"
                  value="range"
                  [checked]="scope() === 'range'"
                  (change)="scope.set('range')"
                />
                <span class="radio-label">
                  <strong>Page Range</strong>
                </span>
              </label>

              @if (scope() === 'range') {
                <div class="range-inputs">
                  <input
                    type="number"
                    class="range-input"
                    [min]="1"
                    [max]="totalPages()"
                    [ngModel]="rangeStart()"
                    (ngModelChange)="rangeStart.set($event)"
                    placeholder="From"
                  />
                  <span class="range-separator">to</span>
                  <input
                    type="number"
                    class="range-input"
                    [min]="1"
                    [max]="totalPages()"
                    [ngModel]="rangeEnd()"
                    (ngModelChange)="rangeEnd.set($event)"
                    placeholder="To"
                  />
                </div>
              }
            </div>
          </div>

          <!-- Progress -->
          @if (running()) {
            <div class="section">
              <h3 class="section-title">Progress</h3>
              <div class="progress-container">
                <div class="progress-bar" [class.indeterminate]="processingPage()">
                  <div class="progress-fill" [style.width.%]="progressPercent()"></div>
                </div>
                <div class="progress-status">
                  <span class="progress-text">{{ progressText() }}</span>
                  <span class="elapsed-time">{{ elapsedTimeText() }}</span>
                </div>
                @if (processingPage()) {
                  <div class="processing-hint">
                    <span class="spinner"></span>
                    <span>{{ settings().engine === 'surya' ? 'Running Surya OCR (this may take a moment)...' : 'Processing with Tesseract...' }}</span>
                  </div>
                }
              </div>
              @if (currentPageText()) {
                <div class="preview-box">
                  <div class="preview-label">Page {{ currentProcessingPage() + 1 }} preview:</div>
                  <pre class="preview-text">{{ currentPageText() }}</pre>
                </div>
              }
            </div>
          }

          <!-- Results Summary -->
          @if (completed() && results().length > 0) {
            <div class="section">
              <h3 class="section-title">Results</h3>
              <div class="results-summary">
                <div class="result-stat">
                  <span class="stat-value">{{ results().length }}</span>
                  <span class="stat-label">pages processed</span>
                </div>
                <div class="result-stat">
                  <span class="stat-value">{{ getTotalCharCount() | number }}</span>
                  <span class="stat-label">characters extracted</span>
                </div>
              </div>
              <div class="results-actions">
                <desktop-button variant="secondary" size="sm" (click)="copyAllText()">
                  Copy All Text
                </desktop-button>
                <desktop-button variant="secondary" size="sm" (click)="exportText()">
                  Export as TXT
                </desktop-button>
              </div>
            </div>
          }

          <!-- Error -->
          @if (error()) {
            <div class="error-box">
              <span class="error-icon">⚠</span>
              <span class="error-text">{{ error() }}</span>
            </div>
          }
        </div>

        <div class="modal-footer">
          @if (!running()) {
            <desktop-button variant="ghost" (click)="close.emit()">
              {{ completed() ? 'Done' : 'Cancel' }}
            </desktop-button>
            @if (!completed()) {
              <desktop-button
                variant="primary"
                [disabled]="!canStart()"
                (click)="startOcr()"
              >
                Start OCR
              </desktop-button>
            } @else {
              <desktop-button variant="primary" (click)="applyResults()">
                Apply to Document
              </desktop-button>
            }
          } @else {
            <desktop-button variant="danger" (click)="cancelOcr()">
              Cancel
            </desktop-button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
    }

    .modal-content {
      background: var(--bg-surface);
      border-radius: $radius-lg;
      box-shadow: $shadow-xl;
      width: 90%;
      max-width: 500px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
    }

    .modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-lg);
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: var(--ui-font-xl);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      .close-btn {
        width: 32px;
        height: 32px;
        border: none;
        background: transparent;
        color: var(--text-secondary);
        font-size: 24px;
        cursor: pointer;
        border-radius: $radius-sm;

        &:hover {
          background: var(--bg-hover);
        }
      }
    }

    .modal-body {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-lg);
    }

    .section {
      margin-bottom: var(--ui-spacing-lg);

      &:last-child {
        margin-bottom: 0;
      }
    }

    .section-title {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin: 0 0 var(--ui-spacing-sm) 0;
    }

    .engine-cards {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: var(--ui-spacing-sm);
    }

    .engine-card {
      padding: var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 2px solid var(--border-subtle);
      border-radius: $radius-md;
      cursor: pointer;
      transition: all $duration-fast $ease-out;

      &:hover:not(.unavailable) {
        border-color: var(--accent-muted);
      }

      &.selected {
        border-color: var(--accent);
        background: var(--accent-muted);
      }

      &.unavailable {
        opacity: 0.5;
        cursor: not-allowed;
      }

      &.checking {
        cursor: wait;
      }
    }

    .engine-header {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-xs);
    }

    .engine-icon {
      font-size: 18px;
    }

    .engine-name {
      font-size: var(--ui-font-base);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .engine-status {
      font-size: var(--ui-font-xs);
    }

    .status-available {
      color: var(--success);
    }

    .status-unavailable {
      color: var(--text-tertiary);
    }

    .status-checking {
      color: var(--accent);
      font-style: italic;
    }

    .select-input {
      width: 100%;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
      color: var(--text-primary);
      font-size: var(--ui-font-base);

      &:focus {
        outline: none;
        border-color: var(--accent);
      }

      option {
        background: var(--bg-surface);
      }
    }

    .scope-options {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
    }

    .radio-option {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--bg-elevated);
      border-radius: $radius-md;
      cursor: pointer;
      transition: background $duration-fast $ease-out;

      &:hover {
        background: var(--bg-hover);
      }

      input[type="radio"] {
        margin-top: 3px;
        accent-color: var(--accent);
      }
    }

    .radio-label {
      display: flex;
      flex-direction: column;
      gap: 2px;

      strong {
        color: var(--text-primary);
        font-size: var(--ui-font-base);
      }

      .radio-hint {
        color: var(--text-tertiary);
        font-size: var(--ui-font-sm);
      }
    }

    .range-inputs {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      margin-left: 24px;
      margin-top: var(--ui-spacing-sm);
    }

    .range-input {
      width: 80px;
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-sm;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      text-align: center;

      &:focus {
        outline: none;
        border-color: var(--accent);
      }
    }

    .range-separator {
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
    }

    .progress-container {
      margin-bottom: var(--ui-spacing-md);
    }

    .progress-bar {
      height: 8px;
      background: var(--bg-elevated);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: var(--ui-spacing-xs);
    }

    .progress-fill {
      height: 100%;
      background: var(--accent);
      transition: width 0.3s ease-out;
    }

    .progress-bar.indeterminate .progress-fill {
      width: 30% !important;
      animation: indeterminate 1.5s infinite ease-in-out;
    }

    @keyframes indeterminate {
      0% {
        transform: translateX(-100%);
      }
      100% {
        transform: translateX(400%);
      }
    }

    .progress-status {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--ui-spacing-sm);
    }

    .progress-text {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
    }

    .elapsed-time {
      font-size: var(--ui-font-sm);
      color: var(--text-tertiary);
      font-variant-numeric: tabular-nums;
    }

    .processing-hint {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      background: var(--accent-muted);
      border-radius: $radius-md;
      font-size: var(--ui-font-sm);
      color: var(--accent);
    }

    .spinner {
      width: 16px;
      height: 16px;
      border: 2px solid var(--accent);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    .preview-box {
      background: var(--bg-elevated);
      border-radius: $radius-md;
      overflow: hidden;
    }

    .preview-label {
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: var(--bg-hover);
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      border-bottom: 1px solid var(--border-subtle);
    }

    .preview-text {
      margin: 0;
      padding: var(--ui-spacing-sm);
      font-family: monospace;
      font-size: var(--ui-font-xs);
      color: var(--text-primary);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 100px;
      overflow-y: auto;
    }

    .results-summary {
      display: flex;
      gap: var(--ui-spacing-lg);
      margin-bottom: var(--ui-spacing-md);
    }

    .result-stat {
      display: flex;
      flex-direction: column;

      .stat-value {
        font-size: var(--ui-font-xl);
        font-weight: $font-weight-bold;
        color: var(--accent);
      }

      .stat-label {
        font-size: var(--ui-font-sm);
        color: var(--text-tertiary);
      }
    }

    .results-actions {
      display: flex;
      gap: var(--ui-spacing-sm);
    }

    .error-box {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md);
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      border-radius: $radius-md;
      color: var(--error);
    }

    .error-icon {
      font-size: 18px;
    }

    .error-text {
      font-size: var(--ui-font-sm);
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-lg);
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-elevated);
    }
  `]
})
export class OcrSettingsModalComponent implements OnDestroy {
  // Inputs
  currentSettings = input<OcrSettings>({
    engine: 'tesseract',
    language: 'eng',
    tesseractPsm: 3
  });
  totalPages = input<number>(0);
  currentPage = input<number>(0);
  getPageImage = input.required<(page: number) => string | null>();

  // Outputs
  close = output<void>();
  ocrCompleted = output<OcrPageResult[]>();

  // Services
  private readonly electronService = inject(ElectronService);
  private readonly pluginService = inject(PluginService);

  // State
  readonly settings = signal<OcrSettings>({
    engine: 'tesseract',
    language: 'eng',
    tesseractPsm: 3
  });

  readonly checkingEngines = signal(true);  // Loading state while checking availability

  readonly engines = signal<Array<{
    id: OcrEngine;
    name: string;
    available: boolean;
    version: string | null;
  }>>([
    { id: 'tesseract', name: 'Tesseract', available: false, version: null },
    { id: 'surya', name: 'Surya', available: false, version: null }
  ]);

  readonly availableLanguages = signal<string[]>(['eng']);
  readonly scope = signal<OcrScope>('all');
  readonly rangeStart = signal<number>(1);
  readonly rangeEnd = signal<number>(1);

  // Progress state
  readonly running = signal(false);
  readonly completed = signal(false);
  readonly cancelled = signal(false);
  readonly currentProcessingPage = signal(0);
  readonly processedCount = signal(0);
  readonly totalToProcess = signal(0);
  readonly currentPageText = signal('');
  readonly results = signal<OcrPageResult[]>([]);
  readonly error = signal<string | null>(null);
  readonly processingPage = signal(false);  // True while actively processing a page
  private startTime: number = 0;
  readonly elapsedSeconds = signal(0);
  private elapsedTimer: ReturnType<typeof setInterval> | null = null;

  // Language names
  private readonly languageNames: Record<string, string> = {
    'eng': 'English',
    'fra': 'French',
    'deu': 'German',
    'spa': 'Spanish',
    'ita': 'Italian',
    'por': 'Portuguese',
    'rus': 'Russian',
    'chi_sim': 'Chinese (Simplified)',
    'chi_tra': 'Chinese (Traditional)',
    'jpn': 'Japanese',
    'kor': 'Korean',
    'ara': 'Arabic'
  };

  constructor() {
    effect(() => {
      this.settings.set({ ...this.currentSettings() });
      this.rangeEnd.set(this.totalPages());
    }, { allowSignalWrites: true });

    this.checkEngines();
  }

  ngOnDestroy(): void {
    this.stopElapsedTimer();
  }

  private async checkEngines(): Promise<void> {
    this.checkingEngines.set(true);

    try {
      // Check Tesseract
      const status = await this.electronService.ocrIsAvailable();
      const languages = await this.electronService.ocrGetLanguages();

      // Check Surya via plugin service
      const suryaAvailability = await this.pluginService.checkAvailability('surya-ocr');

      this.engines.update(engines => engines.map(e => {
        if (e.id === 'tesseract') {
          return { ...e, available: status.available, version: status.version };
        }
        if (e.id === 'surya') {
          return {
            ...e,
            available: suryaAvailability.available,
            version: suryaAvailability.version || null
          };
        }
        return e;
      }));

      this.availableLanguages.set(languages);
    } finally {
      this.checkingEngines.set(false);
    }
  }

  engineAvailable(): boolean {
    const engine = this.engines().find(e => e.id === this.settings().engine);
    return engine?.available ?? false;
  }

  canStart(): boolean {
    return !this.checkingEngines() && this.engineAvailable() && !this.running() && this.totalPages() > 0;
  }

  selectEngine(engineId: OcrEngine): void {
    this.settings.update(s => ({ ...s, engine: engineId }));
  }

  updateSetting<K extends keyof OcrSettings>(key: K, value: OcrSettings[K]): void {
    this.settings.update(s => ({ ...s, [key]: value }));
  }

  getLanguageName(code: string): string {
    return this.languageNames[code] || code;
  }

  progressPercent(): number {
    const total = this.totalToProcess();
    if (total === 0) return 0;
    return (this.processedCount() / total) * 100;
  }

  progressText(): string {
    if (this.processingPage()) {
      return `Processing page ${this.currentProcessingPage() + 1} of ${this.totalToProcess()}...`;
    }
    return `Completed ${this.processedCount()} of ${this.totalToProcess()} pages`;
  }

  elapsedTimeText(): string {
    const seconds = this.elapsedSeconds();
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  private startElapsedTimer(): void {
    this.startTime = Date.now();
    this.elapsedSeconds.set(0);
    this.elapsedTimer = setInterval(() => {
      this.elapsedSeconds.set(Math.floor((Date.now() - this.startTime) / 1000));
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
  }

  getTotalCharCount(): number {
    return this.results().reduce((sum, r) => sum + r.text.length, 0);
  }

  getPageList(): number[] {
    switch (this.scope()) {
      case 'all':
        return Array.from({ length: this.totalPages() }, (_, i) => i);
      case 'current':
        return [this.currentPage()];
      case 'range':
        const start = Math.max(0, this.rangeStart() - 1);
        const end = Math.min(this.totalPages(), this.rangeEnd());
        return Array.from({ length: end - start }, (_, i) => start + i);
      default:
        return [];
    }
  }

  async startOcr(): Promise<void> {
    const pages = this.getPageList();
    if (pages.length === 0) return;

    this.running.set(true);
    this.completed.set(false);
    this.cancelled.set(false);
    this.error.set(null);
    this.results.set([]);
    this.processedCount.set(0);
    this.totalToProcess.set(pages.length);
    this.startElapsedTimer();

    const getImage = this.getPageImage();
    const engine = this.settings().engine;

    for (const pageNum of pages) {
      if (this.cancelled()) break;

      this.currentProcessingPage.set(pageNum);
      this.currentPageText.set('');
      this.processingPage.set(true);

      try {
        const imageData = getImage(pageNum);
        if (!imageData) {
          console.warn(`No image for page ${pageNum + 1}, skipping`);
          this.processedCount.update(c => c + 1);
          this.processingPage.set(false);
          continue;
        }

        let result: { text: string; confidence: number } | null = null;

        let textLines: OcrTextLine[] | undefined;

        if (engine === 'surya') {
          // Use Surya plugin
          const suryaResult = await this.pluginService.runOcr('surya-ocr', imageData);
          if (suryaResult.success && suryaResult.text) {
            result = { text: suryaResult.text, confidence: suryaResult.confidence || 0.9 };
            textLines = suryaResult.textLines;
          } else if (suryaResult.error) {
            throw new Error(suryaResult.error);
          }
        } else {
          // Use Tesseract
          result = await this.electronService.ocrRecognize(imageData);
        }

        this.processingPage.set(false);

        if (result) {
          this.currentPageText.set(result.text.substring(0, 200) + (result.text.length > 200 ? '...' : ''));
          this.results.update(r => [...r, {
            page: pageNum,
            text: result!.text,
            confidence: result!.confidence,
            textLines: textLines
          }]);
        }
      } catch (err) {
        this.processingPage.set(false);
        console.error(`OCR failed for page ${pageNum + 1}:`, err);
        this.error.set(`Failed on page ${pageNum + 1}: ${(err as Error).message}`);
      }

      this.processedCount.update(c => c + 1);
    }

    this.stopElapsedTimer();
    this.running.set(false);
    this.completed.set(true);
    this.currentPageText.set('');
    this.processingPage.set(false);
  }

  cancelOcr(): void {
    this.cancelled.set(true);
  }

  copyAllText(): void {
    const text = this.results()
      .sort((a, b) => a.page - b.page)
      .map(r => `--- Page ${r.page + 1} ---\n${r.text}`)
      .join('\n\n');

    navigator.clipboard.writeText(text);
  }

  exportText(): void {
    const text = this.results()
      .sort((a, b) => a.page - b.page)
      .map(r => `--- Page ${r.page + 1} ---\n${r.text}`)
      .join('\n\n');

    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ocr-results.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  applyResults(): void {
    this.ocrCompleted.emit(this.results());
    this.close.emit();
  }
}
