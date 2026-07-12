import { Component, input, output, linkedSignal, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';
import { DetectionConfig, DetectionStats, DocumentBaselines, getDefaultConfig } from '../../services/paragraph-detector';

/** Flattened, editable form state derived from a DetectionConfig. */
interface ParagraphForm {
  weightGap: number;
  weightIndent: number;
  weightShortLine: number;
  threshold: number;
  indentationCutoff: number;
  gapMultiplier: number;
  shortLineDeadZonePct: number;
  sentenceEndingOverride: boolean;
  /** True once the user touched a control — latches out incoming config updates. */
  edited: boolean;
}

@Component({
  selector: 'app-paragraph-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent, PanelShellComponent, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell title="Paragraphs" [hasAdvanced]="true" (close)="onClose()">
      <!-- Plain actions first -->
      <div class="section">
        @if (paragraphFixMode()) {
          <p class="hint">Review the detected paragraph breaks. Adjust parameters and re-detect, or save when they look right.</p>
        } @else {
          <p class="hint">Place some breaks first, then detect to fill in the rest.</p>
        }
        <desktop-button
          variant="primary"
          size="sm"
          [disabled]="!paragraphFixMode() && paragraphBreaks().size < 1"
          (click)="onDetect()"
        >
          {{ detectionStats() ? 'Re-detect paragraphs' : 'Detect paragraphs' }}
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

      <div class="section">
        <div class="section-header">Breaks</div>
        <p class="hint">Click between blocks to place breaks. Drag to reposition. Click X to remove.</p>
        @if (paragraphBreaks().size > 0) {
          <div class="stats-box">
            <div class="stat-row">
              <span class="stat-label">Paragraph breaks</span>
              <span class="stat-value">{{ paragraphBreaks().size }}</span>
            </div>
          </div>
          <desktop-button variant="ghost" size="sm" (click)="clearAll.emit()">
            Clear all
          </desktop-button>
        } @else {
          <div class="empty-hint">No paragraph breaks yet</div>
        }
      </div>

      @if (baselines(); as bl) {
        <div class="section">
          <div class="section-header">Document info</div>
          <div class="stats-box">
            <div class="stat-row">
              <span class="stat-label">Body size</span>
              <span class="stat-value">{{ bl.bodySize | number:'1.1-1' }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Body margin</span>
              <span class="stat-value">{{ bl.bodyMarginX | number:'1.1-1' }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Line width</span>
              <span class="stat-value">{{ bl.expectedLineWidth | number:'1.0-0' }}</span>
            </div>
            <div class="stat-row">
              <span class="stat-label">Gap ratio</span>
              <span class="stat-value">{{ bl.typicalGapRatio | number:'1.2-2' }}</span>
            </div>
          </div>
        </div>
      }

      <!-- Advanced: the raw detection knobs, with plain-language labels -->
      <div advanced>
        <div class="param">
          <div class="param-head">
            <label>Gap weight</label>
            <span class="param-value">{{ form().weightGap | number:'1.2-2' }}</span>
          </div>
          <p class="param-hint">How much vertical space between lines matters.</p>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="form().weightGap"
            (ngModelChange)="onParamChange('weightGap', $event)"
          />
        </div>

        <div class="param">
          <div class="param-head">
            <label>Indent weight</label>
            <span class="param-value">{{ form().weightIndent | number:'1.2-2' }}</span>
          </div>
          <p class="param-hint">How much a first-line indent matters.</p>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="form().weightIndent"
            (ngModelChange)="onParamChange('weightIndent', $event)"
          />
        </div>

        <div class="param">
          <div class="param-head">
            <label>Short line weight</label>
            <span class="param-value">{{ form().weightShortLine | number:'1.2-2' }}</span>
          </div>
          <p class="param-hint">How much a short previous line matters.</p>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="form().weightShortLine"
            (ngModelChange)="onParamChange('weightShortLine', $event)"
          />
        </div>

        <div class="param">
          <div class="param-head">
            <label>Detection threshold</label>
            <span class="param-value">{{ form().threshold | number:'1.2-2' }}</span>
          </div>
          <p class="param-hint">How confident before inserting a break.</p>
          <input type="range" min="0" max="1" step="0.01"
            [ngModel]="form().threshold"
            (ngModelChange)="onParamChange('threshold', $event)"
          />
        </div>

        <div class="param">
          <div class="param-head">
            <label>Indent cutoff</label>
            <span class="param-value">{{ form().indentationCutoff | number:'1.1-1' }}</span>
          </div>
          <p class="param-hint">Minimum indent (pt) that counts.</p>
          <input type="range" min="0.5" max="3.0" step="0.1"
            [ngModel]="form().indentationCutoff"
            (ngModelChange)="onParamChange('indentationCutoff', $event)"
          />
        </div>

        <div class="param">
          <div class="param-head">
            <label>Gap multiplier</label>
            <span class="param-value">{{ form().gapMultiplier | number:'1.1-1' }}</span>
          </div>
          <p class="param-hint">How much larger than normal a gap must be.</p>
          <input type="range" min="1.0" max="5.0" step="0.1"
            [ngModel]="form().gapMultiplier"
            (ngModelChange)="onParamChange('gapMultiplier', $event)"
          />
        </div>

        <div class="param">
          <div class="param-head">
            <label>Short-line cutoff</label>
            <span class="param-value">{{ form().shortLineDeadZonePct | number:'1.0-0' }}%</span>
          </div>
          <p class="param-hint">% of full width that counts as short.</p>
          <input type="range" min="50" max="100" step="1"
            [ngModel]="form().shortLineDeadZonePct"
            (ngModelChange)="onParamChange('shortLineDeadZonePct', $event)"
          />
        </div>

        <label class="checkbox-row">
          <input type="checkbox"
            [ngModel]="form().sentenceEndingOverride"
            (ngModelChange)="onParamChange('sentenceEndingOverride', $event)"
          />
          <span class="checkbox-body">
            <span class="checkbox-label">Lines without sentence-ending punctuation continue</span>
            <span class="param-hint">A block that doesn't end in . ? or ! is treated as part of the next paragraph.</span>
          </span>
        </label>

        @if (form().edited) {
          <desktop-button variant="ghost" size="xs" (click)="onReset()">
            Reset to auto
          </desktop-button>
        }
      </div>

      <!-- Footer keeps the Save & Done / Done distinction -->
      <div footer>
        @if (paragraphFixMode()) {
          <desktop-button variant="primary" size="sm" (click)="finishFix.emit()">Save &amp; Done</desktop-button>
        } @else {
          <desktop-button variant="ghost" size="sm" (click)="done.emit()">Done</desktop-button>
        }
      </div>
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host { display: contents; }

    .section {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-sm);
      margin-bottom: var(--ui-spacing-lg);
    }

    .section-header {
      font-size: var(--ui-font-xs);
      font-weight: $font-weight-semibold;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
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

    .param {
      margin-bottom: var(--ui-spacing-md);

      input[type="range"] {
        width: 100%;
        height: 4px;
        cursor: pointer;
        accent-color: var(--accent);
      }
    }

    .param-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;

      label {
        font-size: var(--ui-font-sm);
        color: var(--text-primary);
        font-weight: $font-weight-medium;
      }

      .param-value {
        font-size: var(--ui-font-xs);
        color: var(--text-primary);
        font-family: monospace;
      }
    }

    .param-hint {
      font-size: 10px;
      color: var(--text-tertiary);
      margin: 2px 0 var(--ui-spacing-xs);
      line-height: 1.3;
    }

    .checkbox-row {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      cursor: pointer;
      margin-bottom: var(--ui-spacing-md);

      input[type="checkbox"] {
        cursor: pointer;
        margin-top: 2px;
        accent-color: var(--accent);
      }

      .checkbox-body {
        display: flex;
        flex-direction: column;
      }

      .checkbox-label {
        font-size: var(--ui-font-sm);
        color: var(--text-primary);
      }

      .param-hint {
        margin: 2px 0 0;
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

  /**
   * Editable form derived from the `detectionConfig` input.
   *
   * `linkedSignal` replaces the old 8 shadow signals + imperative sync `effect`
   * + `userHasEdited` guard. The computation preserves the exact previous
   * semantics: an incoming config update flows into the form ONLY while the form
   * is pristine; once the user edits a control (`edited` latches true), later
   * config changes are ignored until "Reset to auto" re-derives from source.
   * A null config yields getDefaultConfig() values (matching the old initial
   * shadow-signal defaults).
   */
  readonly form = linkedSignal<DetectionConfig | null, ParagraphForm>({
    source: this.detectionConfig,
    computation: (cfg, prev) => {
      if (prev && prev.value.edited) return prev.value;
      return this.formFrom(cfg);
    },
  });

  private formFrom(cfg: DetectionConfig | null): ParagraphForm {
    const c = cfg ?? getDefaultConfig();
    return {
      weightGap: c.weights.verticalGap,
      weightIndent: c.weights.indentation,
      weightShortLine: c.weights.lastLineWidth,
      threshold: c.threshold,
      indentationCutoff: c.indentationCutoff,
      gapMultiplier: c.gapMultiplier,
      shortLineDeadZonePct: Math.round(c.shortLineDeadZone * 100),
      sentenceEndingOverride: c.sentenceEndingOverride,
      edited: false,
    };
  }

  onParamChange(param: keyof ParagraphForm, value: number | boolean | string): void {
    // Range inputs emit strings via ngModel — coerce numeric params.
    const coerced: number | boolean =
      param === 'sentenceEndingOverride'
        ? (value as boolean)
        : (typeof value === 'string' ? parseFloat(value) : (value as number));
    this.form.update(f => ({ ...f, [param]: coerced, edited: true }));
  }

  buildConfig(): DetectionConfig {
    const f = this.form();
    return {
      weights: {
        verticalGap: f.weightGap,
        indentation: f.weightIndent,
        lastLineWidth: f.weightShortLine,
        fontSizeChange: 0,
        fontNameChange: 0,
        boldChange: 0,
        italicChange: 0,
      },
      threshold: f.threshold,
      indentationCutoff: f.indentationCutoff,
      gapMultiplier: f.gapMultiplier,
      shortLineDeadZone: f.shortLineDeadZonePct / 100,
      sentenceEndingOverride: f.sentenceEndingOverride,
    };
  }

  onDetect(): void {
    this.configChange.emit(this.buildConfig());
    this.detect.emit();
  }

  onReset(): void {
    // Re-derive from the current config (or defaults) and clear the edit latch.
    this.form.set(this.formFrom(this.detectionConfig()));
  }

  onClose(): void {
    // The header close mirrors the footer's mode-specific action: in fix mode
    // it saves (finish), otherwise it just closes.
    if (this.paragraphFixMode()) {
      this.finishFix.emit();
    } else {
      this.done.emit();
    }
  }
}
