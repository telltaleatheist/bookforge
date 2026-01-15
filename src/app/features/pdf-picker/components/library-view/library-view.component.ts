import { Component, output, signal, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PdfService } from '../../services/pdf.service';
import { ElectronService } from '../../../../core/services/electron.service';

export interface RecentFile {
  path: string;
  name: string;
  timestamp: number;
  thumbnail?: string;
}

export interface ProjectFile {
  name: string;
  path: string;
  sourcePath: string;
  sourceName: string;
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
  thumbnail?: string;
  selected?: boolean;
}

type TabType = 'recent' | 'projects';

@Component({
  selector: 'app-library-view',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    <div class="library-container"
         [class.drag-active]="isDragActive()"
         (dragover)="onDragOver($event)"
         (dragleave)="onDragLeave($event)"
         (drop)="onDrop($event)">
      <div class="library-header">
        <h1>Library</h1>
        <div class="header-actions">
          @if (activeTab() === 'projects') {
            <desktop-button variant="ghost" size="md" icon="📥" (click)="importProjects()">
              Import
            </desktop-button>
            @if (selectedProjects().length > 0) {
              <desktop-button variant="danger" size="md" icon="🗑️" (click)="deleteSelectedProjects()">
                Delete ({{ selectedProjects().length }})
              </desktop-button>
            }
          }
          <desktop-button variant="primary" size="md" icon="📂" (click)="openFile.emit()">
            Open PDF
          </desktop-button>
        </div>
      </div>

      <!-- Tabs -->
      <div class="tabs">
        <button
          class="tab"
          [class.active]="activeTab() === 'recent'"
          (click)="setActiveTab('recent')"
        >
          <span class="tab-icon">📄</span>
          Recent
          @if (recentFiles().length > 0) {
            <span class="tab-count">{{ recentFiles().length }}</span>
          }
        </button>
        <button
          class="tab"
          [class.active]="activeTab() === 'projects'"
          (click)="setActiveTab('projects')"
        >
          <span class="tab-icon">📁</span>
          Projects
          @if (projects().length > 0) {
            <span class="tab-count">{{ projects().length }}</span>
          }
        </button>
      </div>

      <!-- Tab content with slide animation -->
      <div class="tab-content">
        <div class="tab-panels" [class.show-projects]="activeTab() === 'projects'">
          <!-- Recent Tab Panel -->
          <div class="tab-panel">
            @if (recentFiles().length > 0) {
              <div class="section">
                <div class="section-header">
                  <h2>Recent Files</h2>
                  <div class="size-slider">
                    <span class="slider-icon small">🔹</span>
                    <input
                      type="range"
                      min="80"
                      max="750"
                      [value]="cardSize()"
                      (input)="onCardSizeChange(+$any($event.target).value)"
                    />
                    <span class="slider-icon large">🔷</span>
                  </div>
                </div>
                <div class="file-grid" [style.--card-size.px]="cardSize()">
                  @for (file of recentFiles(); track file.path) {
                    <div class="file-card" (click)="onFileClick(file)" [title]="file.path">
                      <div class="card-thumbnail">
                        @if (file.thumbnail && file.thumbnail !== 'loading') {
                          <img [src]="file.thumbnail" alt="{{ file.name }}" />
                        } @else if (file.thumbnail === 'loading') {
                          <div class="thumbnail-loading">
                            <span class="loading-icon">⏳</span>
                          </div>
                        } @else {
                          <div class="thumbnail-placeholder">
                            <span>📄</span>
                          </div>
                        }
                      </div>
                      <div class="card-info">
                        <span class="card-title" [title]="file.name">{{ file.name }}</span>
                        <span class="card-date">{{ formatDate(file.timestamp) }}</span>
                      </div>
                      <button class="card-remove" (click)="removeFile($event, file)" title="Remove from recent">×</button>
                    </div>
                  }
                </div>
              </div>
            } @else {
              <div class="empty-library">
                <div class="empty-icon">📚</div>
                <h2>No Recent Files</h2>
                <p>Drop a PDF here or click Open PDF to get started</p>
              </div>
            }
          </div>

          <!-- Projects Tab Panel -->
          <div class="tab-panel">
            @if (projects().length > 0) {
              <div class="section">
                <div class="section-header">
                  <h2>
                    Saved Projects
                    @if (selectedProjects().length > 0) {
                      <span class="selection-info">({{ selectedProjects().length }} selected)</span>
                    }
                  </h2>
                  <div class="section-actions">
                    @if (projects().length > 0) {
                      <desktop-button
                        variant="ghost"
                        size="sm"
                        (click)="toggleSelectAll()"
                      >
                        {{ allSelected() ? 'Deselect All' : 'Select All' }}
                      </desktop-button>
                    }
                    <div class="size-slider">
                      <span class="slider-icon small">🔹</span>
                      <input
                        type="range"
                        min="80"
                        max="750"
                        [value]="cardSize()"
                        (input)="onCardSizeChange(+$any($event.target).value)"
                      />
                      <span class="slider-icon large">🔷</span>
                    </div>
                  </div>
                </div>
                <div class="file-grid" [style.--card-size.px]="cardSize()">
                  @for (project of projects(); track project.path) {
                    <div
                      class="file-card project-card"
                      [class.selected]="project.selected"
                      (click)="onProjectClick($event, project)"
                      [title]="project.path"
                    >
                      <div class="card-checkbox" (click)="toggleProjectSelection($event, project)">
                        @if (project.selected) {
                          <span>✓</span>
                        }
                      </div>
                      <div class="card-thumbnail">
                        @if (project.thumbnail && project.thumbnail !== 'loading') {
                          <img [src]="project.thumbnail" alt="{{ project.name }}" />
                        } @else if (project.thumbnail === 'loading') {
                          <div class="thumbnail-loading">
                            <span class="loading-icon">⏳</span>
                          </div>
                        } @else {
                          <div class="thumbnail-placeholder project-placeholder">
                            <span>📁</span>
                          </div>
                        }
                      </div>
                      <div class="card-info">
                        <span class="card-title" [title]="project.name">{{ project.name }}</span>
                        <span class="card-subtitle" [title]="project.sourceName">{{ project.sourceName }}</span>
                        <span class="card-meta">
                          {{ project.deletedCount }} edits · {{ formatDateString(project.modifiedAt) }}
                        </span>
                      </div>
                    </div>
                  }
                </div>
              </div>
            } @else {
              <div class="empty-library">
                <div class="empty-icon">📁</div>
                <h2>No Saved Projects</h2>
                <p>Projects are saved automatically to ~/Documents/BookForge/</p>
                <desktop-button variant="ghost" size="md" icon="📥" (click)="importProjects()">
                  Import Projects
                </desktop-button>
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Drag overlay -->
      @if (isDragActive()) {
        <div class="drag-overlay">
          <div class="drag-content">
            <span class="drag-icon">📄</span>
            <p>Drop PDF to open</p>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      overflow: auto;
      background: var(--bg-sunken);
    }

    .library-container {
      position: relative;
      display: flex;
      flex-direction: column;
      padding: var(--ui-spacing-xl);
      width: 100%;
      height: 100%;
      box-sizing: border-box;
    }

    .library-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--ui-spacing-lg);

      h1 {
        margin: 0;
        font-size: var(--ui-font-xl);
        font-weight: $font-weight-bold;
        color: var(--text-primary);
      }
    }

    .header-actions {
      display: flex;
      gap: var(--ui-spacing-sm);
    }

    .tabs {
      display: flex;
      gap: 0;
      margin-bottom: 0;
      border-bottom: 1px solid var(--border-subtle);
    }

    .tab {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-md) var(--ui-spacing-lg);
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: var(--ui-font-base);
      font-weight: $font-weight-medium;
      cursor: pointer;
      border-radius: 0;
      transition: all $duration-fast $ease-out;
      position: relative;

      .tab-icon {
        font-size: var(--ui-font-lg);
      }

      .tab-count {
        font-size: var(--ui-font-xs);
        padding: 2px 8px;
        background: var(--bg-surface);
        border-radius: $radius-full;
        margin-left: var(--ui-spacing-xs);
      }

      &:hover {
        color: var(--text-primary);
        background: var(--hover-bg);
      }

      &.active {
        color: var(--accent);
        background: var(--accent-subtle);

        &::after {
          content: '';
          position: absolute;
          bottom: -1px;
          left: 0;
          right: 0;
          height: 3px;
          background: var(--accent);
        }

        .tab-count {
          background: var(--accent);
          color: white;
        }
      }
    }

    .tab-content {
      flex: 1;
      overflow: hidden;
      position: relative;
    }

    .tab-panels {
      display: flex;
      width: 200%;
      transition: transform $duration-normal $ease-out;

      &.show-projects {
        transform: translateX(-50%);
      }
    }

    .tab-panel {
      width: 50%;
      flex-shrink: 0;
      padding: var(--ui-spacing-lg) 0;
      overflow-y: auto;
      max-height: calc(100vh - 200px);
    }

    .section {
      margin-bottom: var(--ui-spacing-xl);

      h2 {
        margin: 0;
        font-size: var(--ui-font-lg);
        font-weight: $font-weight-semibold;
        color: var(--text-secondary);

        .selection-info {
          font-size: var(--ui-font-sm);
          font-weight: $font-weight-regular;
          color: var(--accent);
        }
      }
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: var(--ui-spacing-lg);
    }

    .section-actions {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-md);
    }

    .size-slider {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);

      .slider-icon {
        font-size: var(--ui-font-xs);
        opacity: 0.6;

        &.small { font-size: 10px; }
        &.large { font-size: 16px; }
      }

      input[type="range"] {
        width: 100px;
        height: 4px;
        -webkit-appearance: none;
        appearance: none;
        background: var(--border-default);
        border-radius: 2px;
        cursor: pointer;

        &::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          cursor: pointer;
          transition: transform $duration-fast $ease-out;

          &:hover {
            transform: scale(1.2);
          }
        }

        &:focus {
          outline: none;

          &::-webkit-slider-thumb {
            box-shadow: var(--focus-ring);
          }
        }
      }
    }

    .file-grid {
      --card-size: 140px;
      display: flex;
      flex-wrap: wrap;
      gap: var(--ui-spacing-lg);
      align-content: flex-start;
    }

    .file-card {
      position: relative;
      width: var(--card-size);
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: $radius-lg;
      overflow: hidden;
      cursor: pointer;
      transition: width 0.25s ease-out, transform $duration-fast $ease-out, box-shadow $duration-fast $ease-out, border-color $duration-fast $ease-out;
      animation: cardFadeIn $duration-normal $ease-out both;

      &:hover {
        border-color: var(--border-default);
        box-shadow: var(--shadow-md);
        transform: translateY(-6px);

        .card-remove {
          opacity: 1;
        }

        .card-checkbox {
          opacity: 1;
        }
      }

      &:active {
        transform: translateY(-2px) scale(0.98);
      }

      &.selected {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px var(--accent-subtle);

        .card-checkbox {
          opacity: 1;
          background: var(--accent);
          border-color: var(--accent);
          color: white;
        }
      }
    }

    .card-checkbox {
      position: absolute;
      top: var(--ui-spacing-sm);
      left: var(--ui-spacing-sm);
      width: 20px;
      height: 20px;
      border: 2px solid var(--border-default);
      border-radius: $radius-sm;
      background: var(--bg-elevated);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: bold;
      opacity: 0;
      transition: opacity $duration-fast $ease-out, background $duration-fast $ease-out;
      z-index: 2;
    }

    @for $i from 1 through 20 {
      .file-card:nth-child(#{$i}) {
        animation-delay: #{$i * 50}ms;
      }
    }

    @keyframes cardFadeIn {
      from {
        opacity: 0;
        transform: translateY(20px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .card-thumbnail {
      aspect-ratio: 8.5 / 11;
      background: white;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;

      img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
    }

    .thumbnail-placeholder,
    .thumbnail-loading {
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-surface);

      span {
        font-size: var(--ui-icon-size);
        opacity: 0.3;
      }
    }

    .project-placeholder {
      background: linear-gradient(135deg, var(--bg-surface) 0%, var(--bg-elevated) 100%);

      span {
        font-size: calc(var(--ui-icon-size) * 1.5);
      }
    }

    .thumbnail-loading .loading-icon {
      animation: pulse 1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.3; }
      50% { opacity: 0.6; }
    }

    .card-info {
      padding: var(--ui-spacing-md);
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .card-title {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-subtitle {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-date,
    .card-meta {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
    }

    .card-remove {
      position: absolute;
      top: var(--ui-spacing-sm);
      right: var(--ui-spacing-sm);
      width: var(--ui-btn-height-xs);
      height: var(--ui-btn-height-xs);
      border: none;
      border-radius: $radius-full;
      background: rgba(0, 0, 0, 0.6);
      color: white;
      font-size: var(--ui-font-sm);
      cursor: pointer;
      opacity: 0;
      transition: opacity $duration-fast $ease-out;
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2;

      &:hover {
        background: rgba(255, 68, 68, 0.8);
      }
    }

    .empty-library {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: calc(var(--ui-spacing-xl) * 2);
      color: var(--text-secondary);
      min-height: 300px;

      .empty-icon {
        font-size: calc(var(--ui-icon-size) * 2);
        opacity: 0.5;
        margin-bottom: var(--ui-spacing-lg);
      }

      h2 {
        margin: 0 0 var(--ui-spacing-sm) 0;
        font-size: var(--ui-font-xl);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }

      p {
        margin: 0 0 var(--ui-spacing-lg) 0;
        font-size: var(--ui-font-base);
      }
    }

    .drag-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
      border-radius: $radius-lg;
      animation: overlayFadeIn $duration-fast $ease-out forwards;
    }

    .drag-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xl);
      border: 3px dashed var(--accent);
      border-radius: $radius-lg;
      background: var(--bg-elevated);
      animation: dragContentPop $duration-fast $ease-out forwards;

      .drag-icon {
        font-size: calc(var(--ui-icon-size) * 2);
        animation: iconBounce 0.6s ease-in-out infinite;
      }

      p {
        margin: 0;
        font-size: var(--ui-font-lg);
        font-weight: $font-weight-semibold;
        color: var(--text-primary);
      }
    }

    @keyframes overlayFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes dragContentPop {
      from {
        opacity: 0;
        transform: scale(0.8);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    @keyframes iconBounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-8px); }
    }
  `]
})
export class LibraryViewComponent implements OnInit {
  private readonly pdfService = inject(PdfService);
  private readonly electronService = inject(ElectronService);

  openFile = output<void>();
  fileSelected = output<string>();
  projectSelected = output<string>();

  readonly activeTab = signal<TabType>('recent');
  readonly recentFiles = signal<RecentFile[]>([]);
  readonly projects = signal<ProjectFile[]>([]);
  readonly isDragActive = signal(false);
  readonly cardSize = signal(140);

  private readonly STORAGE_KEY = 'bookforge-recent-files';
  private readonly SIZE_KEY = 'bookforge-card-size';
  private lastRenderedScale = 0.5;
  private thumbnailDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    this.loadCardSize(); // Load card size FIRST so thumbnails use correct scale
    this.loadRecentFiles();
    this.loadProjects();
  }

  setActiveTab(tab: TabType): void {
    this.activeTab.set(tab);
    if (tab === 'projects') {
      this.loadProjects();
    }
  }

  // Computed: selected projects
  selectedProjects(): ProjectFile[] {
    return this.projects().filter(p => p.selected);
  }

  allSelected(): boolean {
    const all = this.projects();
    return all.length > 0 && all.every(p => p.selected);
  }

  toggleSelectAll(): void {
    const shouldSelect = !this.allSelected();
    this.projects.update(all =>
      all.map(p => ({ ...p, selected: shouldSelect }))
    );
  }

  toggleProjectSelection(event: Event, project: ProjectFile): void {
    event.stopPropagation();
    this.projects.update(all =>
      all.map(p => p.path === project.path ? { ...p, selected: !p.selected } : p)
    );
  }

  onProjectClick(event: MouseEvent, project: ProjectFile): void {
    // If holding shift/ctrl/cmd, toggle selection
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      this.toggleProjectSelection(event, project);
      return;
    }

    // Otherwise, open the project
    this.projectSelected.emit(project.path);
  }

  async loadProjects(): Promise<void> {
    const result = await this.electronService.projectsList();
    if (result.success) {
      const projectFiles: ProjectFile[] = result.projects.map(p => ({
        ...p,
        selected: false,
        thumbnail: 'loading'
      }));
      this.projects.set(projectFiles);

      // Load thumbnails for each project's source PDF
      for (const project of projectFiles) {
        try {
          const scale = this.getScaleForSize(this.cardSize());
          const thumbnail = await this.pdfService.renderPage(0, scale, project.sourcePath);
          if (thumbnail) {
            this.projects.update(all =>
              all.map(p => p.path === project.path ? { ...p, thumbnail } : p)
            );
          }
        } catch {
          this.projects.update(all =>
            all.map(p => p.path === project.path ? { ...p, thumbnail: undefined } : p)
          );
        }
      }
    }
  }

  async deleteSelectedProjects(): Promise<void> {
    const selected = this.selectedProjects();
    if (selected.length === 0) return;

    const paths = selected.map(p => p.path);
    const result = await this.electronService.projectsDelete(paths);

    if (result.success) {
      // Remove deleted projects from list
      const deletedSet = new Set(result.deleted);
      this.projects.update(all => all.filter(p => !deletedSet.has(p.path)));
    }
  }

  async importProjects(): Promise<void> {
    const result = await this.electronService.projectsImport();
    if (result.success && result.imported.length > 0) {
      // Reload projects list
      this.loadProjects();
    }
  }

  private loadCardSize(): void {
    try {
      const stored = localStorage.getItem(this.SIZE_KEY);
      if (stored) {
        const size = parseInt(stored, 10);
        if (size >= 80 && size <= 750) {
          this.cardSize.set(size);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  onCardSizeChange(size: number): void {
    this.cardSize.set(size);
    try {
      localStorage.setItem(this.SIZE_KEY, size.toString());
    } catch {
      // Ignore errors
    }

    const neededScale = this.getScaleForSize(size);
    if (neededScale > this.lastRenderedScale) {
      if (this.thumbnailDebounceTimer) {
        clearTimeout(this.thumbnailDebounceTimer);
      }
      this.thumbnailDebounceTimer = setTimeout(() => {
        this.reloadThumbnailsAtScale(neededScale);
      }, 300);
    }
  }

  private getScaleForSize(size: number): number {
    if (size <= 150) return 0.5;
    if (size <= 300) return 1.0;
    if (size <= 500) return 1.5;
    return 2.0;
  }

  private async reloadThumbnailsAtScale(scale: number): Promise<void> {
    this.lastRenderedScale = scale;

    // Reload recent files thumbnails
    const files = this.recentFiles();
    for (const file of files) {
      try {
        const thumbnail = await this.pdfService.renderPage(0, scale, file.path);
        if (thumbnail) {
          this.recentFiles.update(all =>
            all.map(f => f.path === file.path ? { ...f, thumbnail } : f)
          );
        }
      } catch {
        // Ignore errors
      }
    }

    // Reload project thumbnails
    const projectList = this.projects();
    for (const project of projectList) {
      try {
        const thumbnail = await this.pdfService.renderPage(0, scale, project.sourcePath);
        if (thumbnail) {
          this.projects.update(all =>
            all.map(p => p.path === project.path ? { ...p, thumbnail } : p)
          );
        }
      } catch {
        // Ignore errors
      }
    }
  }

  private loadRecentFiles(): void {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const files = JSON.parse(stored) as RecentFile[];
        this.recentFiles.set(files);
        this.loadThumbnails(files);
      }
    } catch {
      // Ignore errors
    }
  }

  private async loadThumbnails(files: RecentFile[]): Promise<void> {
    const scale = this.getScaleForSize(this.cardSize());
    this.lastRenderedScale = scale;

    for (const file of files) {
      this.recentFiles.update(all =>
        all.map(f => f.path === file.path ? { ...f, thumbnail: 'loading' } : f)
      );

      try {
        const thumbnail = await this.pdfService.renderPage(0, scale, file.path);
        if (thumbnail) {
          this.recentFiles.update(all =>
            all.map(f => f.path === file.path ? { ...f, thumbnail } : f)
          );
        }
      } catch {
        this.recentFiles.update(all =>
          all.map(f => f.path === file.path ? { ...f, thumbnail: undefined } : f)
        );
      }
    }
  }

  formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;

    return date.toLocaleDateString();
  }

  formatDateString(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;

    return date.toLocaleDateString();
  }

  onFileClick(file: RecentFile): void {
    this.fileSelected.emit(file.path);
  }

  removeFile(event: Event, file: RecentFile): void {
    event.stopPropagation();

    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const files = JSON.parse(stored) as RecentFile[];
        const filtered = files.filter(f => f.path !== file.path);
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(filtered));
        this.recentFiles.set(filtered);
      }
    } catch {
      // Ignore errors
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragActive.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragActive.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragActive.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.name.toLowerCase().endsWith('.pdf')) {
          const filePath = (file as any).path;
          if (filePath) {
            this.fileSelected.emit(filePath);
            return;
          }
        }
      }
    }
  }
}
