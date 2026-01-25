import { Component, output, signal, OnInit, inject, ChangeDetectionStrategy, computed, HostListener, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PdfService } from '../../services/pdf.service';
import { ElectronService } from '../../../../core/services/electron.service';

export interface ProjectFile {
  name: string;
  path: string;
  sourcePath: string;
  sourceName: string;
  fileHash?: string;
  deletedCount: number;
  createdAt: string;
  modifiedAt: string;
  size: number;
  coverImage?: string;   // Saved cover from project metadata
  thumbnail?: string;    // Rendered thumbnail (fallback)
  selected?: boolean;
}

@Component({
  selector: 'app-library-view',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="library-container"
         tabindex="0"
         [class.drag-active]="isDragActive()"
         [class.marquee-selecting]="marqueeActive()"
         (dragenter)="onDragEnter($event)"
         (dragover)="onDragOver($event)"
         (dragleave)="onDragLeave($event)"
         (drop)="onDrop($event)"
         (mousedown)="onMarqueeStart($event)"
         (mousemove)="onMarqueeMove($event)"
         (mouseup)="onMarqueeEnd($event)"
         (mouseleave)="onMarqueeEnd($event)">
      <div class="library-header">
        <h1>Projects</h1>
        <div class="header-actions">
          @if (selectedCount() > 0) {
            <span class="selection-badge">{{ selectedCount() }} selected</span>
          }
          <desktop-button variant="ghost" size="md" icon="📥" (click)="importProjects()">
            Import
          </desktop-button>
          <desktop-button variant="primary" size="md" icon="📂" (click)="openFile.emit()">
            Open File
          </desktop-button>
        </div>
      </div>

      <!-- Size slider bar -->
      <div class="toolbar-bar">
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

      <!-- Library content -->
      <div class="library-content">
        @if (loading() && projects().length === 0) {
          <div class="empty-library loading">
            <div class="empty-icon loading-spinner">⏳</div>
            <h2>Loading Projects...</h2>
            <p>Please wait while your library is loaded</p>
          </div>
        } @else if (projects().length === 0) {
          <div class="empty-library">
            <div class="empty-icon">📚</div>
            <h2>No Projects Yet</h2>
            <p>Drop a PDF here or click Open PDF to create a new project</p>
            <desktop-button variant="ghost" size="md" icon="📥" (click)="importProjects()">
              Import Projects
            </desktop-button>
          </div>
        } @else {
          <div class="file-grid" [style.--card-size.px]="cardSize()">
            @for (project of projects(); track project.path; let i = $index) {
              <div
                class="file-card"
                [class.selected]="project.selected"
                (click)="onProjectClick($event, project, i)"
                (dblclick)="onProjectDoubleClick(project)"
                (contextmenu)="onContextMenu($event, project)"
                [title]="project.sourceName"
              >
                <div class="card-thumbnail">
                  @if (project.coverImage) {
                    <img [src]="project.coverImage" alt="{{ project.name }}" />
                  } @else if (project.thumbnail && project.thumbnail !== 'loading') {
                    <img [src]="project.thumbnail" alt="{{ project.name }}" />
                  } @else if (project.thumbnail === 'loading') {
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
                  <span class="card-title" [title]="project.name">{{ project.name }}</span>
                  <span class="card-meta">
                    {{ project.deletedCount }} edits · {{ formatDateString(project.modifiedAt) }}
                  </span>
                </div>
              </div>
            }
          </div>
        }
      </div>

      <!-- Marquee selection box -->
      @if (marqueeActive()) {
        <div
          class="marquee-box"
          [style.left.px]="marqueeRect().left"
          [style.top.px]="marqueeRect().top"
          [style.width.px]="marqueeRect().width"
          [style.height.px]="marqueeRect().height"
        ></div>
      }

      <!-- Context menu -->
      @if (contextMenuVisible()) {
        <div
          class="context-menu"
          [style.left.px]="contextMenuX()"
          [style.top.px]="contextMenuY()"
          (click)="$event.stopPropagation()"
          (mousedown)="$event.stopPropagation()"
        >
          <button class="context-menu-item" (click)="onContextMenuOpen()">
            <span class="context-icon">📂</span>
            Open
          </button>
          <button class="context-menu-item" (click)="onContextMenuProcessLightweight()">
            <span class="context-icon">⚡</span>
            Process without rendering...
          </button>
          <div class="context-divider"></div>
          <button class="context-menu-item" (click)="onContextMenuTransferToAudiobook()">
            <span class="context-icon">🎧</span>
            Transfer to Audiobook Producer
          </button>
          <div class="context-divider"></div>
          <button class="context-menu-item" (click)="onContextMenuClearCache()">
            <span class="context-icon">🧹</span>
            Clear Rendered Data
          </button>
          <div class="context-divider"></div>
          <button class="context-menu-item danger" (click)="onContextMenuDelete()">
            <span class="context-icon">🗑️</span>
            Delete
          </button>
        </div>
      }

      <!-- Drag overlay -->
      @if (isDragActive()) {
        <div class="drag-overlay">
          <div class="drag-content">
            <span class="drag-icon">📄</span>
            <p>Drop PDF to create new project</p>
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
      outline: none;

      &:focus {
        outline: none;
      }
    }

    // Prevent text selection during marquee drag
    .marquee-selecting {
      user-select: none;
      cursor: crosshair;
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
      align-items: center;
      gap: var(--ui-spacing-sm);
    }

    .selection-badge {
      padding: var(--ui-spacing-xs) var(--ui-spacing-md);
      background: var(--accent);
      color: white;
      border-radius: $radius-full;
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
    }

    .toolbar-bar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      padding: var(--ui-spacing-sm) 0;
      margin-bottom: var(--ui-spacing-md);
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

    .library-content {
      flex: 1;
      overflow-y: auto;
    }

    .file-grid {
      --card-size: 147px;
      display: flex;
      flex-wrap: wrap;
      gap: var(--ui-spacing-lg);
      align-content: flex-start;
    }

    .file-card {
      position: relative;
      width: var(--card-size);
      background: var(--bg-elevated);
      border: 2px solid transparent;
      border-radius: $radius-lg;
      overflow: hidden;
      cursor: pointer;
      transition: width 0.25s ease-out, transform $duration-fast $ease-out, box-shadow $duration-fast $ease-out, border-color $duration-fast $ease-out, background-color $duration-fast $ease-out;
      animation: cardFadeIn $duration-normal $ease-out both;

      &:hover:not(.selected) {
        border-color: var(--border-default);
        box-shadow: var(--shadow-md);
        transform: translateY(-4px);
      }

      &:active {
        transform: translateY(-2px) scale(0.98);
      }

      // Creamsicle selection style - orange box with orange border
      &.selected {
        background-color: var(--selected-bg-muted);
        border-color: var(--accent);
        box-shadow: 0 0 0 1px var(--accent);

        .card-info {
          background: var(--selected-bg-muted);
        }
      }
    }

    @for $i from 1 through 20 {
      .file-card:nth-child(#{$i}) {
        animation-delay: #{$i * 30}ms;
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
      transition: background-color $duration-fast $ease-out;
    }

    .card-title {
      font-size: var(--ui-font-sm);
      font-weight: $font-weight-medium;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .card-meta {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
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

        &.loading-spinner {
          animation: spin 1.5s linear infinite;
          opacity: 0.7;
        }
      }

      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
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

    // Context menu
    .context-menu {
      position: fixed;
      min-width: 160px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-md;
      box-shadow: var(--shadow-lg);
      padding: var(--ui-spacing-xs);
      z-index: 1000;
      animation: contextMenuFadeIn $duration-fast $ease-out;
    }

    @keyframes contextMenuFadeIn {
      from {
        opacity: 0;
        transform: scale(0.95);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .context-menu-item {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      width: 100%;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border: none;
      background: transparent;
      color: var(--text-primary);
      font-size: var(--ui-font-sm);
      text-align: left;
      cursor: pointer;
      border-radius: $radius-sm;
      transition: background $duration-fast $ease-out;

      &:hover {
        background: var(--hover-bg);
      }

      &.danger {
        color: var(--error);

        &:hover {
          background: rgba(255, 68, 68, 0.1);
        }
      }

      .context-icon {
        font-size: var(--ui-font-base);
      }
    }

    .context-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: var(--ui-spacing-xs) 0;
    }

    // Marquee selection box
    .marquee-box {
      position: absolute;
      background: var(--selected-bg-muted);
      border: 2px solid var(--accent);
      pointer-events: none;
      z-index: 50;
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
  private readonly elementRef = inject(ElementRef);

  openFile = output<void>();
  fileSelected = output<string>();
  projectSelected = output<string>();
  // New output for opening multiple projects
  projectsSelected = output<string[]>();
  // Output for clearing rendered cache
  clearCache = output<string[]>(); // Array of file hashes
  // Output for when projects are deleted (so main component can clear state)
  projectsDeleted = output<string[]>(); // Array of deleted project paths
  // Output for error messages
  error = output<string>();
  // Output for transferring to audiobook
  transferToAudiobook = output<ProjectFile[]>();
  // Output for lightweight processing (without rendering)
  processWithoutRendering = output<ProjectFile[]>();

  readonly projects = signal<ProjectFile[]>([]);
  readonly loading = signal(true);  // Start with loading = true
  readonly isDragActive = signal(false);
  readonly cardSize = signal(147);

  // Context menu state
  readonly contextMenuVisible = signal(false);
  readonly contextMenuX = signal(0);
  readonly contextMenuY = signal(0);

  // Marquee selection state
  readonly marqueeActive = signal(false);
  readonly marqueeStart = signal({ x: 0, y: 0 });
  readonly marqueeEnd = signal({ x: 0, y: 0 });

  // Selection tracking
  private lastSelectedIndex = -1;

  readonly selectedProjects = computed(() => this.projects().filter(p => p.selected));
  readonly selectedCount = computed(() => this.selectedProjects().length);

  // Computed marquee rectangle (handles negative dimensions from drag direction)
  readonly marqueeRect = computed(() => {
    const start = this.marqueeStart();
    const end = this.marqueeEnd();
    return {
      left: Math.min(start.x, end.x),
      top: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
  });

  private readonly SIZE_KEY = 'bookforge-card-size';
  private lastRenderedScale = 0.5;
  private thumbnailDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dragCounter = 0;

  ngOnInit(): void {
    this.loadCardSize();
    this.loadProjects();
  }

  // Keyboard shortcuts
  @HostListener('document:keydown', ['$event'])
  onKeyDown(event: KeyboardEvent): void {
    // Close context menu on Escape
    if (event.key === 'Escape') {
      this.contextMenuVisible.set(false);
      return;
    }

    // Only handle other keys if we have selection
    if (this.selectedCount() === 0) return;

    // Enter or double-click opens selected projects
    if (event.key === 'Enter') {
      event.preventDefault();
      this.openSelectedProjects();
      return;
    }

    // Delete or Backspace removes selected projects
    if (event.key === 'Delete' || event.key === 'Backspace') {
      // Don't delete if user is typing in an input
      if ((event.target as HTMLElement).tagName === 'INPUT') return;
      event.preventDefault();
      this.deleteSelectedProjects();
      return;
    }

    // Cmd/Ctrl+A selects all
    if ((event.metaKey || event.ctrlKey) && event.key === 'a') {
      event.preventDefault();
      this.selectAll();
      return;
    }
  }

  // Close context menu when clicking outside
  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    if (!this.contextMenuVisible()) return;

    // Check if click is inside context menu
    const contextMenu = this.elementRef.nativeElement.querySelector('.context-menu');
    if (contextMenu && contextMenu.contains(event.target as Node)) {
      return; // Don't close if clicking inside menu
    }

    this.contextMenuVisible.set(false);
  }

  // Marquee selection handlers
  onMarqueeStart(event: MouseEvent): void {
    // Only start marquee on left click and on empty space
    if (event.button !== 0) return;

    const target = event.target as HTMLElement;
    const isEmptySpace = target.classList.contains('library-content') ||
                         target.classList.contains('file-grid') ||
                         target.classList.contains('library-container');

    if (!isEmptySpace) return;

    // Get position relative to the container
    const container = this.elementRef.nativeElement.querySelector('.library-container');
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left + container.scrollLeft;
    const y = event.clientY - rect.top + container.scrollTop;

    this.marqueeStart.set({ x, y });
    this.marqueeEnd.set({ x, y });
    this.marqueeActive.set(true);

    // Clear selection unless holding shift/cmd
    if (!event.shiftKey && !event.metaKey && !event.ctrlKey) {
      this.clearSelection();
    }

    event.preventDefault();
  }

  onMarqueeMove(event: MouseEvent): void {
    if (!this.marqueeActive()) return;

    const container = this.elementRef.nativeElement.querySelector('.library-container');
    const rect = container.getBoundingClientRect();
    const x = event.clientX - rect.left + container.scrollLeft;
    const y = event.clientY - rect.top + container.scrollTop;

    this.marqueeEnd.set({ x, y });

    // Select cards that intersect with marquee
    this.selectCardsInMarquee();
  }

  onMarqueeEnd(event: MouseEvent): void {
    if (!this.marqueeActive()) return;
    this.marqueeActive.set(false);
  }

  private selectCardsInMarquee(): void {
    const marquee = this.marqueeRect();
    const container = this.elementRef.nativeElement.querySelector('.library-container');
    const containerRect = container.getBoundingClientRect();
    const cards = container.querySelectorAll('.file-card');

    const projectList = this.projects();
    const newSelection = projectList.map((project, index) => {
      const card = cards[index] as HTMLElement;
      if (!card) return project;

      const cardRect = card.getBoundingClientRect();
      // Convert card rect to container-relative coordinates
      const cardLeft = cardRect.left - containerRect.left + container.scrollLeft;
      const cardTop = cardRect.top - containerRect.top + container.scrollTop;
      const cardRight = cardLeft + cardRect.width;
      const cardBottom = cardTop + cardRect.height;

      // Check if card intersects with marquee
      const intersects =
        cardLeft < marquee.left + marquee.width &&
        cardRight > marquee.left &&
        cardTop < marquee.top + marquee.height &&
        cardBottom > marquee.top;

      return { ...project, selected: intersects };
    });

    this.projects.set(newSelection);
  }

  onProjectClick(event: MouseEvent, project: ProjectFile, index: number): void {
    event.stopPropagation();

    if (event.shiftKey && this.lastSelectedIndex >= 0) {
      // Shift+click: range selection
      const start = Math.min(this.lastSelectedIndex, index);
      const end = Math.max(this.lastSelectedIndex, index);
      this.projects.update(all =>
        all.map((p, i) => ({
          ...p,
          selected: i >= start && i <= end
        }))
      );
    } else if (event.metaKey || event.ctrlKey) {
      // Cmd/Ctrl+click: toggle selection
      this.projects.update(all =>
        all.map((p, i) => i === index ? { ...p, selected: !p.selected } : p)
      );
      this.lastSelectedIndex = index;
    } else {
      // Regular click: select only this one
      this.projects.update(all =>
        all.map((p, i) => ({ ...p, selected: i === index }))
      );
      this.lastSelectedIndex = index;
    }
  }

  onProjectDoubleClick(project: ProjectFile): void {
    // Open this project (and any others that are selected)
    if (!project.selected) {
      // If double-clicking an unselected project, open just that one
      this.projectSelected.emit(project.path);
    } else {
      // If double-clicking a selected project, open all selected
      this.openSelectedProjects();
    }
  }

  onContextMenu(event: MouseEvent, project: ProjectFile): void {
    event.preventDefault();
    event.stopPropagation();

    // If right-clicking an unselected project, select it
    if (!project.selected) {
      this.projects.update(all =>
        all.map(p => ({ ...p, selected: p.path === project.path }))
      );
    }

    this.contextMenuX.set(event.clientX);
    this.contextMenuY.set(event.clientY);
    this.contextMenuVisible.set(true);
  }

  onContextMenuOpen(): void {
    this.contextMenuVisible.set(false);
    // Use setTimeout to ensure menu closes before navigation
    setTimeout(() => this.openSelectedProjects(), 0);
  }

  onContextMenuDelete(): void {
    this.contextMenuVisible.set(false);
    setTimeout(() => this.deleteSelectedProjects(), 0);
  }

  onContextMenuClearCache(): void {
    this.contextMenuVisible.set(false);
    const selected = this.selectedProjects();
    const hashes = selected
      .map(p => p.fileHash)
      .filter((h): h is string => !!h);
    if (hashes.length > 0) {
      this.clearCache.emit(hashes);
    }
  }

  onContextMenuTransferToAudiobook(): void {
    this.contextMenuVisible.set(false);
    const selected = this.selectedProjects();
    if (selected.length > 0) {
      this.transferToAudiobook.emit(selected);
    }
  }

  onContextMenuProcessLightweight(): void {
    this.contextMenuVisible.set(false);
    const selected = this.selectedProjects();
    if (selected.length > 0) {
      this.processWithoutRendering.emit(selected);
    }
  }

  openSelectedProjects(): void {
    const selected = this.selectedProjects();
    if (selected.length === 0) return;

    if (selected.length === 1) {
      this.projectSelected.emit(selected[0].path);
    } else {
      // Emit all selected project paths for multi-tab opening
      this.projectsSelected.emit(selected.map(p => p.path));
    }
  }

  selectAll(): void {
    this.projects.update(all => all.map(p => ({ ...p, selected: true })));
  }

  clearSelection(): void {
    this.projects.update(all => all.map(p => ({ ...p, selected: false })));
    this.lastSelectedIndex = -1;
  }

  async loadProjects(): Promise<void> {
    this.loading.set(true);
    const result = await this.electronService.projectsList();
    if (result.success) {
      const projectFiles: ProjectFile[] = result.projects.map(p => ({
        ...p,
        selected: false,
        // Only show loading indicator if no saved cover image
        thumbnail: p.coverImage ? undefined : 'loading'
      }));
      this.projects.set(projectFiles);
      this.loading.set(false);

      // Load thumbnails only for projects without a saved cover image
      for (const project of projectFiles) {
        // Skip if project already has a cover image
        if (project.coverImage) continue;

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
    } else {
      this.loading.set(false);
    }
  }

  async deleteSelectedProjects(): Promise<void> {
    this.contextMenuVisible.set(false);
    const selected = this.selectedProjects();
    if (selected.length === 0) return;

    const paths = selected.map(p => p.path);
    const result = await this.electronService.projectsDelete(paths);

    if (result.success) {
      const deletedSet = new Set(result.deleted);
      this.projects.update(all => all.filter(p => !deletedSet.has(p.path)));
      // Notify parent component so it can close any open tabs and clear state
      if (result.deleted.length > 0) {
        this.projectsDeleted.emit(result.deleted);
      }
      // Report any failures
      if (result.failed && result.failed.length > 0) {
        const failedNames = result.failed.map((f: { path: string; error: string }) =>
          f.path.split('/').pop() || f.path
        );
        this.error.emit(`Failed to delete: ${failedNames.join(', ')}`);
      }
    } else {
      this.error.emit(result.error || 'Failed to delete projects');
    }
  }

  async importProjects(): Promise<void> {
    const result = await this.electronService.projectsImport();
    if (result.success && result.imported.length > 0) {
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

    const projectList = this.projects();
    for (const project of projectList) {
      // Skip if project has a saved cover image
      if (project.coverImage) continue;

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

  formatDateString(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;

    return date.toLocaleDateString();
  }

  onDragEnter(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter++;

    // Check if dragging files (not text or other content)
    if (event.dataTransfer?.types.includes('Files')) {
      this.isDragActive.set(true);
    }
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    // Set dropEffect to show it's a valid drop target
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter--;

    // Only deactivate when truly leaving the container
    if (this.dragCounter === 0) {
      this.isDragActive.set(false);
    }
  }

  async onDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    this.dragCounter = 0;
    this.isDragActive.set(false);

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = (file as any).path;
        if (!filePath) continue;

        const fileName = file.name.toLowerCase();

        // Check if it's a native format (PDF/EPUB)
        if (fileName.endsWith('.pdf') || fileName.endsWith('.epub')) {
          this.fileSelected.emit(filePath);
          return;
        }

        // Check if it's a convertible format (AZW3, MOBI, etc.)
        const formatInfo = await this.electronService.isEbookConvertible(filePath);
        if (formatInfo.convertible) {
          // Check if ebook-convert is available
          const available = await this.electronService.isEbookConvertAvailable();
          if (available) {
            console.log('[Library] Converting', fileName, 'to EPUB...');
            const result = await this.electronService.convertEbookToLibrary(filePath);
            if (result.success && result.outputPath) {
              console.log('[Library] Conversion successful:', result.outputPath);
              this.fileSelected.emit(result.outputPath);
              return;
            } else {
              console.error('[Library] Conversion failed:', result.error);
            }
          } else {
            console.log('[Library] ebook-convert not available, cannot convert', fileName);
          }
        }
      }
    }
  }
}
