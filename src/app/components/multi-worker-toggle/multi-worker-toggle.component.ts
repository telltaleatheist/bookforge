import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';

import { WorkerConfigService } from '../../core/services/worker-config.service';

/**
 * The multi-worker capability control: a checkbox that, when checked, reveals a
 * 1–4 worker-count picker. Writes straight through to WorkerConfigService (the
 * single per-machine source of truth), so it behaves identically wherever it's
 * embedded — first-run setup and Settings → TTS Server.
 *
 * Deliberately framed as a rare, advanced opt-in: parallel workers only help on
 * shared-memory Apple Silicon, so the default is off (1 worker) everywhere.
 */
@Component({
  selector: 'app-multi-worker-toggle',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="mw">
      <!-- Hardware-based advice (from the machine's detected profile). -->
      <div class="mw-advice" [class]="'mw-advice ' + wc.advice().level">
        <span class="mw-advice-icon">{{ adviceIcon() }}</span>
        <span class="mw-advice-text">{{ wc.advice().message }}</span>
      </div>

      <label class="mw-check">
        <input type="checkbox" [checked]="wc.enabled()" (change)="onToggle($event)" />
        <span class="mw-text">
          <span class="mw-title">Enable multiple TTS workers (advanced)</span>
          <span class="mw-desc">
            Almost no machine benefits from this. Each extra worker loads a full
            copy of the voice model (~5&nbsp;GB RAM) — they only speed things up on
            Apple Silicon with shared memory. On a GPU or a typical PC, leave this
            off (1 worker).
          </span>
        </span>
      </label>

      @if (wc.enabled()) {
        <div class="mw-body">
          <span class="mw-label">Workers</span>
          <div class="mw-options">
            @for (n of counts(); track n) {
              <button
                type="button"
                class="mw-opt"
                [class.selected]="wc.count() === n"
                [class.recommended]="n === wc.advice().recommended"
                (click)="onCount(n)"
              >{{ n }}</button>
            }
          </div>
          <span class="mw-hint">~5&nbsp;GB RAM each. Becomes the default everywhere (TTS server, processing pipeline, browser extension); you can still adjust it per place. Workers stop helping past 4 — they compete for memory bandwidth.</span>
          @if (wc.count() > wc.advice().recommended) {
            <span class="mw-hint warn">More than this machine is likely to benefit from — {{ wc.advice().recommended }} is recommended here.</span>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .mw {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .mw-advice {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      padding: 10px 12px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.5;
      border: 1px solid var(--border-default);
      background: var(--bg-sunken, rgba(127, 127, 127, 0.08));
      color: var(--text-secondary);
    }
    .mw-advice.good {
      border-color: color-mix(in srgb, #22c55e 40%, var(--border-default));
      background: color-mix(in srgb, #22c55e 10%, transparent);
    }
    .mw-advice.discouraged {
      border-color: color-mix(in srgb, #f59e0b 40%, var(--border-default));
      background: color-mix(in srgb, #f59e0b 10%, transparent);
    }
    .mw-advice-icon { flex: 0 0 auto; }
    .mw-advice-text { flex: 1; }
    .mw-check {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      cursor: pointer;
    }
    .mw-check input {
      margin-top: 3px;
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      accent-color: var(--accent, var(--accent-primary));
      cursor: pointer;
    }
    .mw-text {
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .mw-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .mw-desc {
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-secondary);
    }
    .mw-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-left: 26px;
    }
    .mw-label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-primary);
    }
    .mw-options {
      display: flex;
      gap: 8px;
    }
    .mw-opt {
      min-width: 40px;
      padding: 6px 0;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      color: var(--text-secondary);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.15s;
    }
    .mw-opt:hover {
      color: var(--text-primary);
      border-color: var(--text-secondary);
    }
    .mw-opt.selected {
      background: var(--accent, var(--accent-primary));
      border-color: var(--accent, var(--accent-primary));
      color: #1a1a1a;
    }
    .mw-opt.recommended:not(.selected) {
      border-color: color-mix(in srgb, #22c55e 55%, transparent);
      color: var(--text-primary);
    }
    .mw-hint {
      font-size: 11px;
      line-height: 1.4;
      color: var(--text-muted);
    }
    .mw-hint.warn {
      color: #f59e0b;
    }
  `]
})
export class MultiWorkerToggleComponent {
  protected readonly wc = inject(WorkerConfigService);

  protected readonly counts = computed(() => {
    const min = this.wc.min();
    const max = this.wc.max();
    const out: number[] = [];
    for (let n = min; n <= max; n++) out.push(n);
    return out;
  });

  protected readonly adviceIcon = computed(() => {
    switch (this.wc.advice().level) {
      case 'good': return '✓';
      case 'discouraged': return '⚠';
      default: return 'ℹ';
    }
  });

  async onToggle(event: Event): Promise<void> {
    const on = (event.target as HTMLInputElement).checked;
    await this.wc.setEnabled(on);
    // Seed a sensible count the moment they opt in — the recommendation for this
    // machine (clamped to 1 when nothing here really benefits).
    if (on) {
      await this.wc.setCount(Math.max(1, this.wc.advice().recommended));
    }
  }

  onCount(n: number): void {
    void this.wc.setCount(n);
  }
}
