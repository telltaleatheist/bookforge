import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';

/** One station on the audiobook-prep path shown in the bottom control bar. */
export interface PipelineStation {
  id: string;
  /** Short label shown in the chip, e.g. "Remove blocks". */
  label: string;
  /**
   * done    — visited / satisfied (✓)
   * current — where the user is right now (●)
   * todo    — not yet visited, reachable
   * locked  — not yet reachable (gated until earlier required stations are visited)
   */
  state: 'done' | 'current' | 'todo' | 'locked';
}

/**
 * Bottom control bar for the embedded audiobook-prep pipeline.
 *
 * Three zones, read left → right:
 *   [ ← Back ]  [ chip strip + context line ]  [ primary action → ]
 *
 * The chip strip is the source of truth for "where am I / what's left"; chips
 * are clickable for free movement. The primary button always points at the next
 * thing to do and is what carries a first-time user down the path.
 */
@Component({
  selector: 'app-pipeline-bar',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pipeline-bar">
      <!-- Zone 1: Back -->
      <button
        class="pb-back"
        [disabled]="backDisabled() || busy()"
        (click)="back.emit()"
        title="Go back to fix something earlier"
      >
        <span class="pb-arrow">←</span>
        <span class="pb-back-label">Back</span>
      </button>

      <!-- Zone 2: the path -->
      <div class="pb-path">
        <div class="pb-chips">
          @for (s of stations(); track s.id; let i = $index) {
            @if (i > 0) {
              <span class="pb-connector" [class.filled]="s.state === 'done' || s.state === 'current'"></span>
            }
            <button
              class="pb-chip"
              [class.done]="s.state === 'done'"
              [class.current]="s.state === 'current'"
              [class.locked]="s.state === 'locked'"
              [disabled]="s.state === 'locked' || busy()"
              (click)="stationClick.emit(s.id)"
              [title]="s.state === 'locked' ? 'Visit earlier steps first' : s.label"
            >
              <span class="pb-marker">
                @switch (s.state) {
                  @case ('done') { ✓ }
                  @case ('current') { ● }
                  @case ('locked') { 🔒 }
                  @default { ○ }
                }
              </span>
              <span class="pb-chip-label">{{ s.label }}</span>
            </button>
          }
        </div>
        @if (contextLine()) {
          <div class="pb-context">{{ contextLine() }}</div>
        }
      </div>

      <!-- Zone 3: primary action -->
      <button
        class="pb-primary"
        [class.busy]="busy()"
        [disabled]="primaryDisabled() || busy()"
        (click)="primary.emit()"
      >
        @if (busy()) {
          <span class="pb-spinner"></span>
        }
        <span class="pb-primary-label">{{ primaryLabel() }}</span>
      </button>
    </div>
  `,
  styles: [`
    :host { display: block; flex: 0 0 auto; }

    .pipeline-bar {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-lg);
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      background: var(--bg-elevated);
      border-top: 1px solid var(--border-default);
      flex: 0 0 auto;
      min-height: 56px;
      box-sizing: border-box;
    }

    /* Zone 1 — Back */
    .pb-back {
      display: inline-flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      background: transparent;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      color: var(--text-secondary);
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      font-size: var(--ui-font-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    .pb-back:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .pb-back:disabled { opacity: 0.35; cursor: default; }
    .pb-arrow { font-size: var(--ui-font-lg); line-height: 1; }

    /* Zone 2 — the path */
    .pb-path {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      flex: 1 1 auto;
      min-width: 0;
    }
    .pb-chips { display: flex; align-items: center; gap: 0; }
    .pb-connector {
      width: 28px;
      height: 2px;
      background: var(--border-default);
      flex: 0 0 auto;
    }
    .pb-connector.filled { background: var(--accent); }

    .pb-chip {
      display: inline-flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      background: var(--bg-surface);
      border: 1px solid var(--border-default);
      border-radius: 999px;
      color: var(--text-secondary);
      padding: 4px var(--ui-spacing-md);
      font-size: var(--ui-font-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    .pb-chip:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
    .pb-chip.done { color: var(--text-primary); border-color: var(--accent); }
    .pb-chip.done .pb-marker { color: var(--accent); }
    .pb-chip.current {
      color: var(--text-primary);
      border-color: var(--accent);
      background: var(--bg-selected);
      box-shadow: 0 0 0 1px var(--accent);
    }
    .pb-chip.locked { opacity: 0.45; cursor: default; }
    .pb-marker { font-size: var(--ui-font-sm); line-height: 1; }

    .pb-context {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      text-align: center;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Zone 3 — primary */
    .pb-primary {
      display: inline-flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      background: var(--accent);
      border: 1px solid var(--accent);
      border-radius: 6px;
      color: #fff;
      padding: var(--ui-spacing-sm) var(--ui-spacing-lg);
      font-size: var(--ui-font-sm);
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .pb-primary:hover:not(:disabled) { filter: brightness(1.08); }
    .pb-primary:disabled { opacity: 0.5; cursor: default; }

    .pb-spinner {
      width: 13px;
      height: 13px;
      border: 2px solid rgba(255, 255, 255, 0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: pb-spin 0.7s linear infinite;
    }
    @keyframes pb-spin { to { transform: rotate(360deg); } }
  `]
})
export class PipelineBarComponent {
  readonly stations = input.required<PipelineStation[]>();
  readonly contextLine = input<string>('');
  readonly primaryLabel = input.required<string>();
  readonly primaryDisabled = input<boolean>(false);
  readonly backDisabled = input<boolean>(false);
  readonly busy = input<boolean>(false);

  readonly back = output<void>();
  readonly primary = output<void>();
  readonly stationClick = output<string>();
}
