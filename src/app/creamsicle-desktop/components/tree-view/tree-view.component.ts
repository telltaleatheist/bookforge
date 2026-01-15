import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

export interface TreeNode {
  id: string;
  label: string;
  icon?: string;
  iconExpanded?: string;
  children?: TreeNode[];
  data?: any;
  disabled?: boolean;
}

@Component({
  selector: 'desktop-tree-view',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="tree-view" role="tree">
      @for (node of nodes; track node.id) {
        <ng-container *ngTemplateOutlet="nodeTemplate; context: { node: node, level: 0 }"></ng-container>
      }
    </div>

    <ng-template #nodeTemplate let-node="node" let-level="level">
      <div
        class="tree-node"
        [class.selected]="selectedId() === node.id"
        [class.disabled]="node.disabled"
        [class.has-children]="node.children?.length"
        [style.padding-left.px]="level * indentSize + 8"
        role="treeitem"
        [attr.aria-expanded]="node.children?.length ? isExpanded(node.id) : null"
        [attr.aria-selected]="selectedId() === node.id"
      >
        <!-- Expand/Collapse Arrow -->
        <button
          class="node-toggle"
          [class.expanded]="isExpanded(node.id)"
          [class.hidden]="!node.children?.length"
          (click)="toggleNode(node.id, $event)"
          tabindex="-1"
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <path d="M3 2L7 5L3 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>

        <!-- Node Content -->
        <button
          class="node-content"
          [disabled]="node.disabled"
          (click)="selectNode(node)"
          (dblclick)="onNodeDoubleClick(node)"
        >
          @if (node.icon) {
            <span class="node-icon">
              {{ isExpanded(node.id) && node.iconExpanded ? node.iconExpanded : node.icon }}
            </span>
          }
          <span class="node-label">{{ node.label }}</span>
        </button>
      </div>

      <!-- Children -->
      @if (node.children?.length && isExpanded(node.id)) {
        <div class="tree-children" role="group">
          @for (child of node.children; track child.id) {
            <ng-container *ngTemplateOutlet="nodeTemplate; context: { node: child, level: level + 1 }"></ng-container>
          }
        </div>
      }
    </ng-template>
  `,
  styles: [`
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    :host {
      display: block;
      height: 100%;
    }

    .tree-view {
      @include scrollbar-thin;
      height: 100%;
      overflow-y: auto;
      padding: $spacing-2 0;
      user-select: none;
    }

    .tree-node {
      display: flex;
      align-items: center;
      height: $row-height;
      padding-right: $spacing-3;
      gap: $spacing-1;

      &.selected .node-content {
        background: var(--selected-bg);
        color: var(--selected-text);

        .node-icon {
          opacity: 1;
        }
      }

      &.disabled {
        opacity: 0.4;
        pointer-events: none;
      }
    }

    .node-toggle {
      @include button-reset;
      @include flex-center;
      width: 18px;
      height: 18px;
      color: var(--text-muted);
      border-radius: $radius-sm;
      transition: $transition-all-fast;
      flex-shrink: 0;

      &:hover {
        background: var(--hover-bg);
        color: var(--text-secondary);
      }

      &.expanded svg {
        transform: rotate(90deg);
      }

      &.hidden {
        visibility: hidden;
      }

      svg {
        transition: transform $duration-fast $ease-out;
      }
    }

    .node-content {
      @include button-reset;
      @include flex-start;
      @include focus-ring;
      flex: 1;
      gap: $spacing-2;
      height: 24px;
      padding: 0 $spacing-2;
      border-radius: $radius-md;
      color: var(--text-primary);
      font-family: $font-body;
      font-size: $font-size-base;
      text-align: left;
      overflow: hidden;
      transition: $transition-colors;

      &:hover {
        background: var(--hover-bg);
      }
    }

    .node-icon {
      font-size: 15px;
      line-height: 1;
      opacity: 0.75;
      flex-shrink: 0;
    }

    .node-label {
      @include truncate;
    }

    .tree-children {
      // Animation for expand/collapse could be added here
    }
  `]
})
export class TreeViewComponent {
  @Input() nodes: TreeNode[] = [];
  @Input() indentSize = 18;

  @Output() nodeSelected = new EventEmitter<TreeNode>();
  @Output() nodeDoubleClicked = new EventEmitter<TreeNode>();
  @Output() nodeExpanded = new EventEmitter<{ node: TreeNode; expanded: boolean }>();

  selectedId = signal<string | null>(null);
  expandedNodes = signal<Set<string>>(new Set());

  isExpanded(nodeId: string): boolean {
    return this.expandedNodes().has(nodeId);
  }

  toggleNode(nodeId: string, event: MouseEvent) {
    event.stopPropagation();
    const node = this.findNode(nodeId, this.nodes);

    this.expandedNodes.update(set => {
      const newSet = new Set(set);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return newSet;
    });

    if (node) {
      this.nodeExpanded.emit({ node, expanded: this.isExpanded(nodeId) });
    }
  }

  selectNode(node: TreeNode) {
    if (node.disabled) return;
    this.selectedId.set(node.id);
    this.nodeSelected.emit(node);
  }

  onNodeDoubleClick(node: TreeNode) {
    if (node.disabled) return;

    // If has children, expand/collapse
    if (node.children?.length) {
      this.toggleNode(node.id, new MouseEvent('click'));
    }

    this.nodeDoubleClicked.emit(node);
  }

  private findNode(id: string, nodes: TreeNode[]): TreeNode | null {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children) {
        const found = this.findNode(id, node.children);
        if (found) return found;
      }
    }
    return null;
  }

  // Programmatic methods
  expandAll() {
    const allIds = this.collectNodeIds(this.nodes);
    this.expandedNodes.set(new Set(allIds));
  }

  collapseAll() {
    this.expandedNodes.set(new Set());
  }

  private collectNodeIds(nodes: TreeNode[]): string[] {
    const ids: string[] = [];
    for (const node of nodes) {
      if (node.children?.length) {
        ids.push(node.id);
        ids.push(...this.collectNodeIds(node.children));
      }
    }
    return ids;
  }
}
