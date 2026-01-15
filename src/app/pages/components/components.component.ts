import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  SidebarComponent,
  SidebarSection,
  ToolbarComponent,
  ToolbarItem,
  StatusBarComponent,
  StatusBarItem,
  SplitPaneComponent,
  TreeViewComponent,
  TreeNode,
  DesktopButtonComponent,
  CascadeListComponent,
  CascadeGroup,
  CascadeItem
} from '../../creamsicle-desktop';

@Component({
  selector: 'app-components',
  standalone: true,
  imports: [
    CommonModule,
    SidebarComponent,
    ToolbarComponent,
    StatusBarComponent,
    SplitPaneComponent,
    TreeViewComponent,
    DesktopButtonComponent,
    CascadeListComponent
  ],
  template: `
    <div class="components-page">
      <div class="components-sidebar">
        <div class="sidebar-header">Components</div>
        <nav class="component-nav">
          @for (item of componentList; track item.id) {
            <button
              class="nav-item"
              [class.active]="activeSection() === item.id"
              (click)="scrollToSection(item.id)"
            >
              <span class="nav-icon">{{ item.icon }}</span>
              <span class="nav-label">{{ item.label }}</span>
            </button>
          }
        </nav>
      </div>

      <div class="components-content" #scrollContainer>
        <!-- Buttons Section -->
        <section id="buttons" class="component-section">
          <h2 class="section-title">Buttons</h2>
          <p class="section-desc">Versatile button components for desktop applications.</p>

          <div class="demo-card">
            <h3>Variants</h3>
            <div class="demo-row">
              <desktop-button variant="primary">Primary</desktop-button>
              <desktop-button variant="secondary">Secondary</desktop-button>
              <desktop-button variant="ghost">Ghost</desktop-button>
              <desktop-button variant="danger">Danger</desktop-button>
              <desktop-button variant="success">Success</desktop-button>
            </div>
          </div>

          <div class="demo-card">
            <h3>Sizes</h3>
            <div class="demo-row">
              <desktop-button variant="primary" size="xs">Extra Small</desktop-button>
              <desktop-button variant="primary" size="sm">Small</desktop-button>
              <desktop-button variant="primary" size="md">Medium</desktop-button>
              <desktop-button variant="primary" size="lg">Large</desktop-button>
            </div>
          </div>

          <div class="demo-card">
            <h3>With Icons</h3>
            <div class="demo-row">
              <desktop-button variant="primary" icon="✚">Add Item</desktop-button>
              <desktop-button variant="secondary" icon="📁">Open</desktop-button>
              <desktop-button variant="ghost" icon="⚙" [iconOnly]="true"></desktop-button>
              <desktop-button variant="danger" icon="🗑">Delete</desktop-button>
            </div>
          </div>

          <div class="demo-card">
            <h3>States</h3>
            <div class="demo-row">
              <desktop-button variant="primary" [disabled]="true">Disabled</desktop-button>
              <desktop-button variant="primary" [loading]="true">Loading</desktop-button>
              <desktop-button variant="secondary" [fullWidth]="false">Normal Width</desktop-button>
            </div>
          </div>
        </section>

        <!-- Toolbar Section -->
        <section id="toolbar" class="component-section">
          <h2 class="section-title">Toolbar</h2>
          <p class="section-desc">Application toolbar with buttons, toggles, and dropdowns.</p>

          <div class="demo-card">
            <h3>Standard Toolbar</h3>
            <div class="demo-toolbar">
              <desktop-toolbar [items]="toolbarItems" />
            </div>
          </div>

          <div class="demo-card">
            <h3>With Search</h3>
            <div class="demo-toolbar">
              <desktop-toolbar [items]="toolbarWithSearch" />
            </div>
          </div>
        </section>

        <!-- Sidebar Section -->
        <section id="sidebar" class="component-section">
          <h2 class="section-title">Sidebar</h2>
          <p class="section-desc">Collapsible sidebar with grouped sections.</p>

          <div class="demo-card">
            <h3>With Sections</h3>
            <div class="demo-sidebar">
              <desktop-sidebar
                [sections]="demoSidebarSections"
                [showSearch]="true"
                [resizable]="false"
                [width]="220"
              />
            </div>
          </div>
        </section>

        <!-- Tree View Section -->
        <section id="tree-view" class="component-section">
          <h2 class="section-title">Tree View</h2>
          <p class="section-desc">Hierarchical tree for files and folders.</p>

          <div class="demo-card">
            <h3>File Tree</h3>
            <div class="demo-tree">
              <desktop-tree-view [nodes]="demoTreeNodes" />
            </div>
          </div>
        </section>

        <!-- Split Pane Section -->
        <section id="split-pane" class="component-section">
          <h2 class="section-title">Split Pane</h2>
          <p class="section-desc">Resizable split panels for layouts.</p>

          <div class="demo-card">
            <h3>Horizontal Split</h3>
            <div class="demo-split">
              <desktop-split-pane [primarySize]="150" [minSize]="100" [maxSize]="250">
                <div pane-primary class="demo-pane">Left Panel</div>
                <div pane-secondary class="demo-pane">Right Panel</div>
              </desktop-split-pane>
            </div>
          </div>

          <div class="demo-card">
            <h3>Vertical Split</h3>
            <div class="demo-split">
              <desktop-split-pane direction="vertical" [primarySize]="100" [minSize]="60" [maxSize]="200">
                <div pane-primary class="demo-pane">Top Panel</div>
                <div pane-secondary class="demo-pane">Bottom Panel</div>
              </desktop-split-pane>
            </div>
          </div>
        </section>

        <!-- Status Bar Section -->
        <section id="status-bar" class="component-section">
          <h2 class="section-title">Status Bar</h2>
          <p class="section-desc">Bottom status bar for application info.</p>

          <div class="demo-card">
            <h3>Standard Status Bar</h3>
            <div class="demo-statusbar">
              <desktop-status-bar
                [leftItems]="statusLeftItems"
                [rightItems]="statusRightItems"
                centerText="Ready"
              />
            </div>
          </div>
        </section>

        <!-- Cascade List Section -->
        <section id="cascade-list" class="component-section">
          <h2 class="section-title">Cascade List</h2>
          <p class="section-desc">Virtualized list with groups, selection, and context menus.</p>

          <div class="demo-card">
            <h3>Grouped List</h3>
            <div class="demo-cascade">
              <desktop-cascade-list
                [groups]="demoCascadeGroups"
                [showStatusIndicator]="true"
                [showIcon]="true"
                emptyIcon="📋"
                emptyTitle="No items"
                emptyMessage="Add items to see them here"
                (itemDoubleClick)="onCascadeItemDoubleClick($event)"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  `,
  styles: [`
    @use '../../creamsicle-desktop/styles/variables' as *;
    @use '../../creamsicle-desktop/styles/mixins' as *;

    :host {
      display: flex;
      flex: 1;
      height: 100%;
      overflow: hidden;
    }

    .components-page {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .components-sidebar {
      width: 200px;
      background: var(--bg-sidebar);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .sidebar-header {
      @include text-caps;
      padding: $spacing-4 $spacing-4 $spacing-2;
      color: var(--text-tertiary);
    }

    .component-nav {
      flex: 1;
      padding: 0 $spacing-2 $spacing-2;
      overflow-y: auto;
    }

    .nav-item {
      @include button-reset;
      display: flex;
      align-items: center;
      gap: $spacing-2;
      width: 100%;
      padding: $spacing-2 $spacing-2-5;
      border-radius: $radius-md;
      color: var(--text-primary);
      font-size: $font-size-sm;
      text-align: left;
      transition: $transition-colors;

      &:hover {
        background: var(--hover-bg);
      }

      &.active {
        background: var(--selected-bg-muted);
        color: var(--text-accent);
      }
    }

    .nav-icon {
      font-size: 14px;
      line-height: 1;
      opacity: 0.75;
    }

    .components-content {
      flex: 1;
      padding: $spacing-6 $spacing-8;
      overflow-y: auto;
      background: var(--bg-content);
    }

    .component-section {
      margin-bottom: $spacing-12;
    }

    .section-title {
      font-family: $font-display;
      font-size: $font-size-xl;
      font-weight: $font-weight-bold;
      color: var(--text-primary);
      margin-bottom: $spacing-2;
    }

    .section-desc {
      font-size: $font-size-base;
      color: var(--text-secondary);
      margin-bottom: $spacing-5;
    }

    .demo-card {
      @include surface-card;
      padding: $spacing-4;
      margin-bottom: $spacing-4;

      h3 {
        @include text-caps;
        margin-bottom: $spacing-3;
      }
    }

    .demo-row {
      display: flex;
      gap: $spacing-2;
      flex-wrap: wrap;
      align-items: center;
    }

    .demo-toolbar {
      background: var(--bg-sunken);
      border-radius: $radius-md;
      overflow: hidden;
    }

    .demo-sidebar {
      height: 320px;
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      overflow: hidden;
    }

    .demo-tree {
      height: 280px;
      background: var(--bg-sunken);
      border-radius: $radius-md;
      overflow: hidden;
    }

    .demo-split {
      height: 200px;
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      overflow: hidden;
    }

    .demo-pane {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      background: var(--bg-sunken);
      color: var(--text-secondary);
      font-size: $font-size-sm;
    }

    .demo-statusbar {
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      overflow: hidden;
    }

    .demo-cascade {
      height: 320px;
      border: 1px solid var(--border-default);
      border-radius: $radius-lg;
      overflow: hidden;
    }
  `]
})
export class ComponentsComponent {
  activeSection = signal('buttons');

  componentList = [
    { id: 'buttons', label: 'Buttons', icon: '🔘' },
    { id: 'toolbar', label: 'Toolbar', icon: '🔧' },
    { id: 'sidebar', label: 'Sidebar', icon: '📋' },
    { id: 'tree-view', label: 'Tree View', icon: '🌳' },
    { id: 'split-pane', label: 'Split Pane', icon: '⬜' },
    { id: 'status-bar', label: 'Status Bar', icon: '📊' },
    { id: 'cascade-list', label: 'Cascade List', icon: '📜' },
  ];

  toolbarItems: ToolbarItem[] = [
    { id: 'back', type: 'button', icon: '←', tooltip: 'Back' },
    { id: 'forward', type: 'button', icon: '→', tooltip: 'Forward' },
    { id: 'divider1', type: 'divider' },
    { id: 'view', type: 'dropdown', icon: '☰', label: 'View', items: [
      { id: 'icons', label: 'Icons', icon: '▦' },
      { id: 'list', label: 'List', icon: '☰' },
      { id: 'columns', label: 'Columns', icon: '|||' },
    ]},
    { id: 'spacer', type: 'spacer' },
    { id: 'action', type: 'button', icon: '⚡', label: 'Action' },
  ];

  toolbarWithSearch: ToolbarItem[] = [
    { id: 'back', type: 'button', icon: '←' },
    { id: 'forward', type: 'button', icon: '→' },
    { id: 'spacer', type: 'spacer' },
    { id: 'search', type: 'search' },
  ];

  demoSidebarSections: SidebarSection[] = [
    {
      id: 'favorites',
      title: 'Favorites',
      items: [
        { id: 'desktop', label: 'Desktop', icon: '🖥' },
        { id: 'documents', label: 'Documents', icon: '📄' },
        { id: 'downloads', label: 'Downloads', icon: '⬇' },
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

  demoTreeNodes: TreeNode[] = [
    {
      id: 'src',
      label: 'src',
      icon: '📁',
      iconExpanded: '📂',
      children: [
        { id: 'app', label: 'app', icon: '📁', iconExpanded: '📂', children: [
          { id: 'components', label: 'components', icon: '📁' },
          { id: 'services', label: 'services', icon: '📁' },
        ]},
        { id: 'main', label: 'main.ts', icon: '📄' },
        { id: 'styles', label: 'styles.scss', icon: '🎨' },
      ]
    },
    { id: 'package', label: 'package.json', icon: '📦' },
    { id: 'readme', label: 'README.md', icon: '📝' },
  ];

  statusLeftItems: StatusBarItem[] = [
    { id: 'items', text: '12 items' },
    { id: 'selected', text: '3 selected' },
  ];

  statusRightItems: StatusBarItem[] = [
    { id: 'sync', text: 'Synced', icon: '✓' },
    { id: 'disk', text: '234 GB available' },
  ];

  demoCascadeGroups: CascadeGroup[] = [
    {
      label: 'Recent',
      items: [
        { id: '1', name: 'Project Proposal.docx', subtitle: 'Modified yesterday', icon: '📄', status: 'complete', metadata: '2.4 MB' },
        { id: '2', name: 'Budget 2024.xlsx', subtitle: 'Modified 2 days ago', icon: '📊', status: 'complete', metadata: '1.1 MB' },
        { id: '3', name: 'Meeting Notes.md', subtitle: 'Modified today', icon: '📝', status: 'active', metadata: '24 KB' },
      ]
    },
    {
      label: 'Downloads',
      items: [
        { id: '4', name: 'installer.dmg', subtitle: 'Downloading...', icon: '💿', status: 'active', metadata: '45%' },
        { id: '5', name: 'update-v2.0.zip', subtitle: 'Pending', icon: '📦', status: 'pending', metadata: '128 MB' },
        { id: '6', name: 'backup-failed.tar', subtitle: 'Error occurred', icon: '⚠️', status: 'error', metadata: 'Failed' },
      ]
    },
    {
      label: 'Archives',
      expanded: false,
      items: [
        { id: '7', name: 'old-project.zip', subtitle: 'Created Jan 2024', icon: '📁', status: 'complete', metadata: '45 MB' },
        { id: '8', name: 'photos-2023.zip', subtitle: 'Created Dec 2023', icon: '🖼', status: 'complete', metadata: '2.1 GB' },
      ]
    }
  ];

  scrollToSection(sectionId: string) {
    this.activeSection.set(sectionId);
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  }

  onCascadeItemDoubleClick(item: CascadeItem) {
    console.log('Double-clicked:', item);
  }
}
