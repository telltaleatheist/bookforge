import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SplitPaneComponent,
  SidebarComponent,
  SidebarSection,
  TreeViewComponent,
  TreeNode,
  DesktopButtonComponent
} from '../../creamsicle-desktop';

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [
    CommonModule,
    SplitPaneComponent,
    SidebarComponent,
    TreeViewComponent,
    DesktopButtonComponent
  ],
  template: `
    <desktop-split-pane [primarySize]="240" [minSize]="180" [maxSize]="360">
      <!-- Sidebar -->
      <ng-container pane-primary>
        <desktop-sidebar
          [sections]="sidebarSections"
          [showSearch]="true"
          [resizable]="false"
          [width]="240"
          (itemSelected)="onSidebarSelect($event)"
        />
      </ng-container>

      <!-- Content Area -->
      <ng-container pane-secondary>
        <desktop-split-pane direction="horizontal" [primarySize]="300" [minSize]="220">
          <ng-container pane-primary>
            <div class="tree-panel">
              <div class="panel-header">
                <span class="header-title">Files</span>
                <desktop-button variant="ghost" size="xs" icon="✚" [iconOnly]="true" />
              </div>
              <desktop-tree-view
                [nodes]="treeNodes"
                (nodeSelected)="onNodeSelect($event)"
              />
            </div>
          </ng-container>

          <ng-container pane-secondary>
            <div class="content-panel">
              <div class="panel-header">
                <span class="header-title">Details</span>
              </div>
              <div class="content-body">
                @if (selectedNode()) {
                  <div class="detail-card">
                    <div class="detail-icon">{{ selectedNode()?.icon }}</div>
                    <div class="detail-info">
                      <div class="detail-name">{{ selectedNode()?.label }}</div>
                      <div class="detail-meta">Selected item</div>
                    </div>
                  </div>

                  <div class="detail-actions">
                    <desktop-button variant="primary" size="sm">Open</desktop-button>
                    <desktop-button variant="secondary" size="sm">Rename</desktop-button>
                    <desktop-button variant="ghost" size="sm">Delete</desktop-button>
                  </div>
                } @else {
                  <div class="empty-state">
                    <div class="empty-icon">📂</div>
                    <div class="empty-text">Select an item to view details</div>
                  </div>
                }
              </div>
            </div>
          </ng-container>
        </desktop-split-pane>
      </ng-container>
    </desktop-split-pane>
  `,
  styles: [`
    @use '../../creamsicle-desktop/styles/variables' as *;
    @use '../../creamsicle-desktop/styles/mixins' as *;

    :host {
      display: flex;
      flex: 1;
      height: 100%;
    }

    .tree-panel,
    .content-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-content);
    }

    .panel-header {
      @include flex-between;
      padding: $spacing-2 $spacing-3;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-sunken);
      flex-shrink: 0;
    }

    .header-title {
      @include text-caps;
      color: var(--text-tertiary);
    }

    .content-body {
      flex: 1;
      padding: $spacing-4;
      overflow-y: auto;
    }

    .detail-card {
      display: flex;
      align-items: center;
      gap: $spacing-4;
      padding: $spacing-4;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-lg;
      margin-bottom: $spacing-4;
    }

    .detail-icon {
      font-size: 40px;
      line-height: 1;
    }

    .detail-info {
      flex: 1;
    }

    .detail-name {
      font-family: $font-display;
      font-size: $font-size-lg;
      font-weight: $font-weight-semibold;
      color: var(--text-primary);
      margin-bottom: $spacing-1;
    }

    .detail-meta {
      font-size: $font-size-sm;
      color: var(--text-tertiary);
    }

    .detail-actions {
      display: flex;
      gap: $spacing-2;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-tertiary);
    }

    .empty-icon {
      font-size: 56px;
      margin-bottom: $spacing-4;
      opacity: 0.4;
    }

    .empty-text {
      font-size: $font-size-base;
    }
  `]
})
export class HomeComponent {
  selectedNode = signal<TreeNode | null>(null);

  sidebarSections: SidebarSection[] = [
    {
      id: 'favorites',
      title: 'Favorites',
      items: [
        { id: 'desktop', label: 'Desktop', icon: '🖥' },
        { id: 'documents', label: 'Documents', icon: '📄' },
        { id: 'downloads', label: 'Downloads', icon: '⬇' },
        { id: 'applications', label: 'Applications', icon: '📦' },
      ]
    },
    {
      id: 'locations',
      title: 'Locations',
      collapsible: true,
      items: [
        { id: 'home', label: 'Home', icon: '🏠' },
        { id: 'computer', label: 'Local Disk', icon: '💾' },
        { id: 'network', label: 'Network', icon: '🌐' },
      ]
    },
    {
      id: 'tags',
      title: 'Tags',
      collapsible: true,
      items: [
        { id: 'red', label: 'Important', icon: '🔴' },
        { id: 'orange', label: 'Work', icon: '🟠' },
        { id: 'green', label: 'Personal', icon: '🟢' },
      ]
    }
  ];

  treeNodes: TreeNode[] = [
    {
      id: 'projects',
      label: 'Projects',
      icon: '📁',
      iconExpanded: '📂',
      children: [
        {
          id: 'creamsicle',
          label: 'creamsicle-desktop',
          icon: '📁',
          iconExpanded: '📂',
          children: [
            { id: 'src', label: 'src', icon: '📁', iconExpanded: '📂', children: [
              { id: 'app', label: 'app', icon: '📁', iconExpanded: '📂' },
              { id: 'styles', label: 'styles.scss', icon: '🎨' },
              { id: 'main', label: 'main.ts', icon: '📄' },
            ]},
            { id: 'package', label: 'package.json', icon: '📦' },
            { id: 'readme', label: 'README.md', icon: '📝' },
          ]
        },
        {
          id: 'other',
          label: 'other-project',
          icon: '📁',
          iconExpanded: '📂',
        }
      ]
    },
    {
      id: 'documents',
      label: 'Documents',
      icon: '📁',
      iconExpanded: '📂',
      children: [
        { id: 'notes', label: 'notes.txt', icon: '📝' },
        { id: 'todo', label: 'todo.md', icon: '✅' },
      ]
    }
  ];

  onSidebarSelect(item: any) {
    console.log('Sidebar selected:', item);
  }

  onNodeSelect(node: TreeNode) {
    this.selectedNode.set(node);
  }
}
