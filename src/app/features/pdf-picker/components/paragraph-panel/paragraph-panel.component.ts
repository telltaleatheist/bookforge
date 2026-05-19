import { Component, input, output, signal, effect, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { DetectionConfig, DetectionStats, DocumentBaselines, getDefaultConfig } from '../../services/paragraph-detector';

@Component({
  selector: 'app-paragraph-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Paragraphs</h3>
      @if (paragraphFixMode()) {
        <desktop-button variant="primary" size="xs" (click)="finishFix.emit()">Save & Done</desktop-button>
      } @else {
        <desktop-button variant="ghost" size="xs" (click)="done.emit()">Done</desktop-button>
      }
    </div>

    <div class="panel-content">
      <!-- Detect Section -->
      <div class="section">
        <div class="section-header">Detect</div>
        @if (paragraphFixMode()) {
          <p class="hint">Review the detected paragraph breaks. Adjust parameters and re-detect, or click Save & Done.</p>
        } @else {
          <p class="hint">Place some breaks first, then detect to fill in the rest.</p>
        }
        <desktop-button
          variant="primary"
          size="sm"
          [disabled]="!paragraphFixMode() && paragraphBreaks().size < 1"
          (click)="onDetect()"
        >
          {{ detectionStats() ? 'Re-detect Paragraphs' : 'Detect Paragraphs' }}
        </desktop-button>

        @if (detectionStats()) {
          <div class="stats-box">
            <div class="stat-row">
              <span class="stat-label">Paragraphs found</span>
              <span class="stat-value">{{ detectionStats()!.paragraphBreaks }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Line continuations</span>
              <span class="stat-value">{{ detectionStats()!.continuations }}</span>
            </div>
          </div>
        }
      </div>

      <!-- Parameters Section -->
      <div class="section">
        <div class="section-header">Parameters</div>

        <div class="subsection-header">Feature Weights</div>
        <div class="threshold-row">
          <label class="threshold-label">Gap</label>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="weightGap()"
            (ngModelChange)="onParamChange('weightGap', $event)"
          />
          <span class="threshold-value">{{ weightGap() | number:'1.2-2' }}</span>
        </div>
        <div class="threshold-row">
          <label class="threshold-label">Indent</label>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="weightIndent()"
            (ngModelChange)="onParamChange('weightIndent', $event)"
          />
          <span class="threshold-value">{{ weightIndent() | number:'1.2-2' }}</span>
        </div>
        <div class="threshold-row">
          <label class="threshold-label">Short line</label>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="weightShortLine()"
            (ngModelChange)="onParamChange('weightShortLine', $event)"
          />
          <span class="threshold-value">{{ weightShortLine() | number:'1.2-2' }}</span>
        </div>

        <div class="subsection-header">Thresholds</div>
        <div class="threshold-row">
          <label class="threshold-label">Detection</label>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="threshold()"
            (ngModelChange)="onParamChange('threshold', $event)"
          />
          <span class="threshold-value">{{ threshold() | number:'1.2-2' }}</span>
        </div>
        <div class="threshold-row">
          <label class="threshold-label">Indent cutoff</label>
          <input type="range" min="0.5" max="3.0" step="0.1"
            [ngModel]="indentationCutoff()"
            (ngModelChange)="onParamChange('indentationCutoff', $event)"
          />
          <span class="threshold-value">{{ indentationCutoff() | number:'1.1-1' }}</span>
        </div>
        <div class="threshold-row">
          <label class="threshold-label">Gap multiplier</label>
          <input type="range" min="1.0" max="5.0" step="0.1"
            [ngModel]="gapMultiplier()"
            (ngModelChange)="onParamChange('gapMultiplier', $event)"
          />
          <span class="threshold-value">{{ gapMultiplier() | number:'1.1-1' }}</span>
        </div>
        <div class="threshold-row">
          <label class="threshold-label">Short-line dead zone</label>
          <input type="range" min="50" max="100" step="1"
            [ngModel]="shortLineDeadZonePct()"
            (ngModelChange)="onParamChange('shortLineDeadZonePct', $event)"
          />
          <span class="threshold-value">{{ shortLineDeadZonePct() | number:'1.0-0' }}%</span>
        </div>

        <div class="subsection-header">Rules</div>
        <label class="checkbox-row">
          <input type="checkbox"
            [ngModel]="sentenceEndingOverride()"
            (ngModelChange)="onParamChange('sentenceEndingOverride', $event)"
          />
          <span class="checkbox-label">No sentence ending = continuation</span>
        </label>

        @if (userHasEdited()) {
          <desktop-button variant="ghost" size="xs" (click)="onReset()">
            Reset to Auto
          </desktop-button>
        }
      </div>

      <!-- Document Info Section -->
      @if (baselines()) {
        <div class="section">
          <div class="section-header">Document Info</div>
          <div class="stats-box">
            <div class="stat-row">
              <span class="stat-label">Body size</span>
              <span class="stat-value">{{ baselines()!.bodySize | number:'1.1-1' }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Body margin</span>
              <span class="stat-value">{{ baselines()!.bodyMarginX | number:'1.1-1' }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Line width</span>
              <span class="stat-value">{{ baselines()!.expectedLineWidth | number:'1.0-0' }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Gap ratio</span>
              <span class="stat-value">{{ baselines()!.typicalGapRatio | number:'1.2-2' }}</span>
            </div>
          </div>
        </div>
      }

      <!-- Review Section -->
      <div class="section">
        <div class="section-header">Review</div>
        <p class="hint">Click between blocks to place breaks. Drag to reposition. Click X to remove.</p>
        @if (paragraphBreaks().size > 0) {
          <div class="stats-box">
            <div class="stat-row">
              <span class="stat-label">Paragraph breaks</span>
              <span class="stat-value">{{ paragraphBreaks().size }}</span>
            </div>
          </div>
          <desktop-button
            variant="ghost"
            size="sm"
            (click)="clearAll.emit()"
          >
            Clear All
          </desktop-button>
        } @else {
          <div class="empty-hint">No paragraph breaks yet</div>
        }
      </div>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-bottom: 1px solid var(--border-subtle);
    }

    .panel-title {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
      margin: 0;
    }

    .panel-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--ui-spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-lg);
    }

    .section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
    }

    .section-header {
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .subsection-header {
      font-size: 10px;
      color: var(--text-tertiary);
      margin-top: var(--ui-spacing-xs);
    }

    .hint {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      margin: 0;
      line-height: 1.4;
    }

    .empty-hint {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      text-align: center;
      padding: var(--ui-spacing-sm);
    }

    .stats-box {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-md;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
    }

    .stat-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .stat-label {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
    }

    .stat-value {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
    }

    .threshold-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      height: 28px;

      .threshold-label {
        flex: 0 0 110px;
        font-size: 10px;
        color: var(--text-secondary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      input[type="range"] {
        flex: 1;
        height: 4px;
        cursor: pointer;
        min-width: 60px;
      }

      .threshold-value {
        flex: 0 0 60px;
        font-size: 10px;
        color: var(--text-primary);
        font-family: monospace;
        text-align: right;
      }
    }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      cursor: pointer;

      input[type="checkbox"] {
        cursor: pointer;
      }

      .checkbox-label {
        font-size: var(--ui-font-xs);
        color: var(--text-secondary);
      }
    }
  `]
})
export class ParagraphPanelComponent {
  // Inputs
  paragraphBreaks = input.required<Set<string>>();
  detectionStats = input<DetectionStats | null>(null);
  detectionConfig = input<DetectionConfig | null>(null);
  baselines = input<DocumentBaselines | null>(null);
  paragraphFixMode = input<boolean>(false);

  // Outputs
  detect = output<void>();
  clearAll = output<void>();
  done = output<void>();
  finishFix = output<void>();
  configChange = output<DetectionConfig>();

  // Editable parameter signals
  readonly weightGap = signal(0.5);
  readonly weightIndent = signal(0.3);
  readonly weightShortLine = signal(0.2);
  readonly threshold = signal(0.4);
  readonly indentationCutoff = signal(1.5);
  readonly gapMultiplier = signal(2.5);
  readonly shortLineDeadZonePct = signal(92);
  readonly sentenceEndingOverride = signal(true);
  readonly userHasEdited = signal(false);

  constructor() {
    // Sync from detectionConfig input — only auto-populate when user hasn't manually edited
    effect(() => {
      const cfg = this.detectionConfig();
      if (!cfg || this.userHasEdited()) return;
      this.weightGap.set(cfg.weights.verticalGap);
      this.weightIndent.set(cfg.weights.indentation);
      this.weightShortLine.set(cfg.weights.lastLineWidth);
      this.threshold.set(cfg.threshold);
      this.indentationCutoff.set(cfg.indentationCutoff);
      this.gapMultiplier.set(cfg.gapMultiplier);
      this.shortLineDeadZonePct.set(Math.round(cfg.shortLineDeadZone * 100));
      this.sentenceEndingOverride.set(cfg.sentenceEndingOverride);
    });
  }

  onParamChange(param: string, value: number | boolean | string): void {
    this.userHasEdited.set(true);
    // Range inputs emit strings via ngModel — coerce to number
    const num = typeof value === 'string' ? parseFloat(value) : value as number;
    switch (param) {
      case 'weightGap': this.weightGap.set(num as number); break;
      case 'weightIndent': this.weightIndent.set(num as number); break;
      case 'weightShortLine': this.weightShortLine.set(num as number); break;
      case 'threshold': this.threshold.set(num as number); break;
      case 'indentationCutoff': this.indentationCutoff.set(num as number); break;
      case 'gapMultiplier': this.gapMultiplier.set(num as number); break;
      case 'shortLineDeadZonePct': this.shortLineDeadZonePct.set(num as number); break;
      case 'sentenceEndingOverride': this.sentenceEndingOverride.set(value as boolean); break;
    }
  }

  buildConfig(): DetectionConfig {
    return {
      weights: {
        verticalGap: this.weightGap(),
        indentation: this.weightIndent(),
        lastLineWidth: this.weightShortLine(),
        fontSizeChange: 0,
        fontNameChange: 0,
        boldChange: 0,
        italicChange: 0,
      },
      threshold: this.threshold(),
      indentationCutoff: this.indentationCutoff(),
      gapMultiplier: this.gapMultiplier(),
      shortLineDeadZone: this.shortLineDeadZonePct() / 100,
      sentenceEndingOverride: this.sentenceEndingOverride(),
    };
  }

  onDetect(): void {
    this.configChange.emit(this.buildConfig());
    this.detect.emit();
  }

  onReset(): void {
    this.userHasEdited.set(false);
    // On next detect, auto-populate will kick in from the detectionConfig input.
    // If there's a current config, immediately sync from it.
    const cfg = this.detectionConfig();
    if (cfg) {
      this.weightGap.set(cfg.weights.verticalGap);
      this.weightIndent.set(cfg.weights.indentation);
      this.weightShortLine.set(cfg.weights.lastLineWidth);
      this.threshold.set(cfg.threshold);
      this.indentationCutoff.set(cfg.indentationCutoff);
      this.gapMultiplier.set(cfg.gapMultiplier);
      this.shortLineDeadZonePct.set(Math.round(cfg.shortLineDeadZone * 100));
      this.sentenceEndingOverride.set(cfg.sentenceEndingOverride);
    } else {
      const defaults = getDefaultConfig();
      this.weightGap.set(defaults.weights.verticalGap);
      this.weightIndent.set(defaults.weights.indentation);
      this.weightShortLine.set(defaults.weights.lastLineWidth);
      this.threshold.set(defaults.threshold);
      this.indentationCutoff.set(defaults.indentationCutoff);
      this.gapMultiplier.set(defaults.gapMultiplier);
      this.shortLineDeadZonePct.set(Math.round(defaults.shortLineDeadZone * 100));
      this.sentenceEndingOverride.set(defaults.sentenceEndingOverride);
    }
  }
}
