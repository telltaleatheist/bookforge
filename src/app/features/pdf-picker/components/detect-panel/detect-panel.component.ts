import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

export type DetectBackend = 'ollama' | 'service';

export interface DetectRunState {
  readonly running: boolean;
  /** Pages classified so far, for the progress line. */
  readonly done: number;
  readonly total: number;
  /** Non-empty when the last run failed; shown verbatim, never swallowed. */
  readonly error: string;
  /** Blocks currently predicted (0 = nothing loaded). */
  readonly predicted: number;
  /** Which adapter answered, as reported by the service. */
  readonly adapter: string;
}

/**
 * Detect panel — run the fine-tuned category model over the open book and draw
 * its predictions on the page.
 *
 * This is a PREVIEW. Predictions live in memory and are painted with the same
 * colours Label mode uses, but they are never written to `category_corrections`
 * and never touch the project file. That is deliberate while the model is being
 * evaluated: looking at its output must not risk the hand-labelling the model
 * is being trained from.
 */
@Component({
  selector: 'app-detect-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel-header">
      <h3 class="panel-title">Detect Categories</h3>
      <desktop-button variant="ghost" size="xs" (click)="done.emit()">Done</desktop-button>
    </div>

    <div class="panel-content">
      <div class="intro">
        Runs the trained category model over every page and paints what it
        predicts. Nothing is saved — this is a look at the model, not an edit.
      </div>

      <div class="field">
        <label class="field-label">Where the model runs</label>
        <div class="backend-toggle">
          <button
            type="button"
            class="backend-option"
            [class.active]="backend() === 'ollama'"
            [disabled]="state().running"
            (click)="backendChange.emit('ollama')"
          >Ollama (local)</button>
          <button
            type="button"
            class="backend-option"
            [class.active]="backend() === 'service'"
            [disabled]="state().running"
            (click)="backendChange.emit('service')"
          >Remote GPU</button>
        </div>
      </div>

      @if (backend() === 'ollama') {
        <div class="field">
          <label class="field-label" for="detect-model">Ollama model</label>
          <input
            id="detect-model"
            class="field-input"
            type="text"
            [ngModel]="model()"
            (ngModelChange)="modelChange.emit($event)"
            [disabled]="state().running"
            placeholder="blockcat-v2"
          />
        </div>
      }

      <div class="field">
        <label class="field-label" for="detect-endpoint">Endpoint</label>
        <input
          id="detect-endpoint"
          class="field-input"
          type="text"
          [ngModel]="endpoint()"
          (ngModelChange)="endpointChange.emit($event)"
          [disabled]="state().running"
          [placeholder]="backend() === 'ollama' ? 'http://localhost:11434' : 'http://owens-pc:8770'"
        />
      </div>

      <div class="actions">
        <desktop-button
          variant="primary"
          size="sm"
          [disabled]="state().running || !endpoint() || (backend() === 'ollama' && !model())"
          (click)="loadCategories.emit()"
        >
          {{ state().running ? 'Loading…' : 'Load categories' }}
        </desktop-button>
        @if (state().predicted > 0 && !state().running) {
          <desktop-button variant="secondary" size="sm" (click)="clear.emit()">
            Clear
          </desktop-button>
        }
      </div>

      @if (state().running) {
        <div class="status-box info">
          Classifying page {{ state().done }} of {{ state().total }}…
        </div>
      }

      @if (state().error) {
        <div class="status-box error">{{ state().error }}</div>
      }

      @if (state().predicted > 0 && !state().running) {
        <div class="status-box success">
          {{ state().predicted }} blocks predicted
          @if (state().adapter) {
            <div class="adapter">{{ state().adapter }}</div>
          }
        </div>
        <div class="hint">
          Colours match the Label palette. Switch to Label mode to correct
          anything the model got wrong — corrections there are saved, these are
          not.
        </div>
      }
    </div>
  `,
  styles: [`
    .panel-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; border-bottom: 1px solid var(--border-subtle, #2a2a2a);
    }
    .panel-title { margin: 0; font-size: 13px; font-weight: 600; }
    .panel-content { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
    .intro { font-size: 12px; line-height: 1.5; color: var(--text-secondary, #999); }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
      color: var(--text-secondary, #999); }
    .field-input {
      background: var(--bg-input, #1a1a1a); border: 1px solid var(--border-subtle, #333);
      border-radius: 4px; color: inherit; font-size: 12px; padding: 6px 8px;
    }
    .field-input:disabled { opacity: 0.5; }
    .actions { display: flex; gap: 8px; }
    .backend-toggle { display: flex; gap: 0; }
    .backend-option {
      flex: 1; background: var(--bg-input, #1a1a1a); color: inherit; cursor: pointer;
      border: 1px solid var(--border-subtle, #333); font-size: 11px; padding: 5px 8px;
    }
    .backend-option:first-child { border-radius: 4px 0 0 4px; }
    .backend-option:last-child { border-radius: 0 4px 4px 0; border-left: none; }
    .backend-option.active { background: var(--accent, #e8833a); color: #111; font-weight: 600; }
    .backend-option:disabled { opacity: 0.5; cursor: default; }
    .status-box { border-radius: 4px; font-size: 12px; line-height: 1.45; padding: 8px 10px; }
    .status-box.info { background: rgba(33,150,243,0.12); color: #64b5f6; }
    .status-box.success { background: rgba(76,175,80,0.12); color: #81c784; }
    .status-box.error { background: rgba(244,67,54,0.12); color: #e57373;
      white-space: pre-wrap; word-break: break-word; }
    .adapter { font-size: 11px; opacity: 0.75; margin-top: 3px; word-break: break-all; }
    .hint { font-size: 11px; line-height: 1.5; color: var(--text-secondary, #999); }
  `],
})
export class DetectPanelComponent {
  readonly state = input.required<DetectRunState>();
  readonly endpoint = input.required<string>();
  readonly backend = input.required<DetectBackend>();
  readonly model = input.required<string>();

  readonly endpointChange = output<string>();
  readonly backendChange = output<DetectBackend>();
  readonly modelChange = output<string>();
  readonly loadCategories = output<void>();
  readonly clear = output<void>();
  readonly done = output<void>();
}
