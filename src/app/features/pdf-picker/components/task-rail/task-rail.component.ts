import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  TaskId,
  PanelId,
  TaskGroup,
  TaskStatus,
  TASK_LABELS,
  STATUS_GLYPH,
} from '../../tasks/task.model';

/**
 * Left task-checklist rail — also the viewer's mode switcher.
 *
 * Every entry is one row: for the source file the modes (Select / Crop) in the
 * first group and then the remaining tasks grouped by stage; for the book, the
 * text passes that rewrite it. Which of the two it is showing is decided by the
 * shell and arrives as `groups` — this component renders what it is given and
 * asks no questions about the artifact.
 *
 * Each row carries a live factual status glyph + detail line, and the rail ends
 * with an "Analysis & search" tool entry and a projected [rail-footer] slot for
 * the Rendering controls.
 *
 * Exactly one row is current at a time: the open panel, or — when no panel is
 * open — the pointer interaction. Merging the two into one list is deliberate;
 * a separate mode toggle beside a checklist gave the user two places to look
 * for "where am I", and they could disagree.
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
    <!-- Modes + task groups -->
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
              [class.attention]="needsAttention(task)"
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
              <span class="digit-hint">{{ shortcut(task) }}</span>
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
        [class.active]="current() === 'analysis'"
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

    /* The next thing to do. Kept quiet when that row is already open — the
       user is looking straight at it, so the glow has nothing left to say. */
    .task-item.attention:not(.active) {
      border-color: var(--warning);
      background: color-mix(in srgb, var(--warning) 10%, transparent);
    }
    .task-item.attention:not(.active) .task-name { color: var(--warning); }
    .task-item.attention:not(.active) .task-detail { color: var(--text-secondary); }

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
  /**
   * The single current row: the open panel, or the pointer interaction when no
   * panel is open. One input, so the rail cannot show two rows as current.
   */
  readonly current = input.required<PanelId>();
  /**
   * The key hint each row shows, for the rail that is on screen.
   *
   * An input rather than a constant because the digits run over the rows the
   * user can SEE (see `railShortcutsFor`): a rail whose first row is hinted "4"
   * is a rail advertising keys 1–3 that do nothing here.
   */
  readonly shortcuts = input.required<Readonly<Partial<Record<TaskId, string>>>>();
  readonly disabledTasks = input.required<Map<TaskId, string>>();
  readonly collapsedGroups = input.required<ReadonlySet<string>>();

  readonly panelClick = output<PanelId>();
  readonly groupToggle = output<string>();

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

  shortcut(task: TaskId): string {
    const key = this.shortcuts()[task];
    if (key === undefined) {
      throw new Error(`task-rail: task "${task}" has no keyboard shortcut`);
    }
    return key;
  }

  isActive(task: TaskId): boolean {
    return this.current() === task;
  }

  /**
   * Draw the eye to the one thing that still has to happen before export.
   * Only 'required-missing' qualifies: making every merely-suggested task glow
   * would leave nothing standing out.
   */
  needsAttention(task: TaskId): boolean {
    return !this.isDisabled(task) && this.statusFor(task).kind === 'required-missing';
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
