import { Component, input, output, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  TaskId,
  PanelId,
  TaskGroup,
  TaskStatus,
  TASK_LABELS,
  TASK_ORDER,
  STATUS_GLYPH,
} from '../../tasks/task.model';

/**
 * Left task-checklist rail. Replaces the old cryptic mode toolbox.
 *
 * Shows a pointer-interaction toggle (Select / Edit), tasks grouped by stage
 * with a live factual status glyph + detail line, an "Analysis & search" tool
 * entry, and a projected [rail-footer] slot for the Rendering controls.
 *
 * Purely presentational: all state derivation and side effects live in the
 * shell. It throws if asked to render a task that has no derived status —
 * silence there would hide a broken status pipeline.
 */
@Component({
  selector: 'app-task-rail',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Pointer interaction -->
    <div class="rail-section">
      <div class="rail-label">Pointer</div>
      <div class="interaction-toggle" role="group" aria-label="Pointer interaction">
        <button
          type="button"
          class="interaction-btn"
          [class.active]="interaction() === 'select'"
          title="Select and delete blocks (S)"
          (click)="interactionChange.emit('select')"
        >Select<span class="digit-hint">S</span></button>
        <button
          type="button"
          class="interaction-btn"
          [class.active]="interaction() === 'edit'"
          title="Edit text, reorder/delete pages (E)"
          (click)="interactionChange.emit('edit')"
        >Edit<span class="digit-hint">E</span></button>
      </div>
    </div>

    <div class="rail-divider"></div>

    <!-- Task groups -->
    @for (group of groups(); track group.id) {
      <div class="rail-section">
        <button
          type="button"
          class="group-header"
          (click)="groupToggle.emit(group.id)"
        >
          <span class="group-chevron">{{ isCollapsed(group.id) ? '▸' : '▾' }}</span>
          <span class="group-label">{{ group.label }}</span>
        </button>

        @if (!isCollapsed(group.id)) {
          @for (task of group.tasks; track task) {
            <button
              type="button"
              class="task-item"
              [class.active]="isActive(task)"
              [class.disabled]="isDisabled(task)"
              [class]="'status-' + statusFor(task).kind"
              [disabled]="isDisabled(task)"
              [title]="taskTooltip(task)"
              (click)="panelClick.emit(task)"
            >
              <span class="task-glyph">{{ glyphFor(task) }}</span>
              <span class="task-body">
                <span class="task-name">{{ label(task) }}</span>
                <span class="task-detail">{{ statusFor(task).detail }}</span>
              </span>
              <span class="digit-hint">{{ digit(task) }}</span>
            </button>
          }
        }
      </div>
    }

    <div class="rail-divider"></div>

    <!-- Analysis & search tool (status-less) -->
    <div class="rail-section">
      <button
        type="button"
        class="task-item tool-item"
        [class.active]="activePanel() === 'analysis'"
        title="Analysis flags & text search (A)"
        (click)="panelClick.emit('analysis')"
      >
        <span class="task-glyph">🔬</span>
        <span class="task-body">
          <span class="task-name">Analysis &amp; search</span>
        </span>
        <span class="digit-hint">A</span>
      </button>
    </div>

    <!-- Projected rendering controls -->
    <div class="rail-footer-slot">
      <ng-content select="[rail-footer]"></ng-content>
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-sm);
      overflow-y: auto;
    }

    .rail-section {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .rail-label {
      font-size: var(--ui-font-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-tertiary);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
    }

    .rail-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: var(--ui-spacing-xs) var(--ui-spacing-sm);
    }

    /* Pointer interaction toggle */
    .interaction-toggle {
      display: flex;
      gap: 2px;
      padding: 0 var(--ui-spacing-sm);
    }

    .interaction-btn {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      border: 1px solid var(--border-default);
      background: var(--bg-input);
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      border-radius: 4px;
      cursor: pointer;
    }

    .interaction-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--text-inverse);
    }

    .interaction-btn:hover:not(.active) {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    /* Group header */
    .group-header {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-xs);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-tertiary);
      font-size: var(--ui-font-xs);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .group-header:hover { color: var(--text-secondary); }
    .group-chevron { color: var(--text-tertiary); }

    /* Task item */
    .task-item {
      display: flex;
      align-items: flex-start;
      gap: var(--ui-spacing-sm);
      width: 100%;
      padding: var(--ui-spacing-sm);
      background: none;
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      text-align: left;
      color: var(--text-primary);
    }

    .task-item:hover:not(.disabled) {
      background: var(--bg-hover);
    }

    .task-item.active {
      background: var(--accent-subtle);
      border-color: var(--border-accent);
    }

    .task-item.disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .task-glyph {
      flex-shrink: 0;
      width: 1.2em;
      text-align: center;
      line-height: 1.3;
    }

    /* Status glyph colors — theme tokens only */
    .status-done .task-glyph { color: var(--success); }
    .status-suggested .task-glyph { color: var(--accent); }
    .status-untouched .task-glyph { color: var(--text-tertiary); }
    .status-required-missing .task-glyph { color: var(--warning); }

    .task-body {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
      flex: 1;
    }

    .task-name {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
    }

    .task-detail {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .digit-hint {
      flex-shrink: 0;
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      border: 1px solid var(--border-subtle);
      border-radius: 3px;
      padding: 0 4px;
      line-height: 1.4;
      align-self: flex-start;
    }

    .tool-item .task-glyph { color: var(--text-secondary); }

    .rail-footer-slot {
      margin-top: var(--ui-spacing-sm);
    }
  `]
})
export class TaskRailComponent {
  readonly groups = input.required<readonly TaskGroup[]>();
  readonly statuses = input.required<Map<TaskId, TaskStatus>>();
  readonly activePanel = input.required<PanelId | null>();
  readonly disabledTasks = input.required<Map<TaskId, string>>();
  readonly collapsedGroups = input.required<ReadonlySet<string>>();
  readonly interaction = input.required<'select' | 'edit'>();

  readonly panelClick = output<PanelId>();
  readonly interactionChange = output<'select' | 'edit'>();
  readonly groupToggle = output<string>();

  private readonly digitOrder = computed(() => {
    const map = new Map<TaskId, number>();
    TASK_ORDER.forEach((id, i) => map.set(id, i + 1));
    return map;
  });

  label(task: TaskId): string {
    return TASK_LABELS[task];
  }

  statusFor(task: TaskId): TaskStatus {
    const status = this.statuses().get(task);
    if (!status) {
      throw new Error(`task-rail: no derived status for task "${task}"`);
    }
    return status;
  }

  glyphFor(task: TaskId): string {
    return STATUS_GLYPH[this.statusFor(task).kind];
  }

  digit(task: TaskId): number {
    const d = this.digitOrder().get(task);
    if (d === undefined) {
      throw new Error(`task-rail: task "${task}" is not in TASK_ORDER`);
    }
    return d;
  }

  isActive(task: TaskId): boolean {
    return this.activePanel() === task;
  }

  isDisabled(task: TaskId): boolean {
    return this.disabledTasks().has(task);
  }

  isCollapsed(groupId: string): boolean {
    return this.collapsedGroups().has(groupId);
  }

  taskTooltip(task: TaskId): string {
    const reason = this.disabledTasks().get(task);
    if (reason) return reason;
    return this.statusFor(task).detail;
  }
}
