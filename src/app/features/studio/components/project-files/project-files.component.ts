import { Component, input, output, signal, inject, OnInit, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../../../core/services/electron.service';
import { ManifestService } from '../../../../core/services/manifest.service';
import { StudioService } from '../../services/studio.service';

interface ProjectFile {
  name: string;
  path: string;
  size: number | null;
  type: 'file' | 'directory';
  editable: boolean;        // can open in EPUB editor (.epub)
  viewable: boolean;        // can open in viewer (.pdf, .docx, etc.)
  fileCount?: number;       // for directories (TTS language folders)
  sectionLabel: string;     // which pipeline section this file belongs to
  diffCacheFor?: string;    // originalPath from .diff.json (if cache exists for this file)
}

interface FileSection {
  label: string;
  dirPath: string;
  files: ProjectFile[];
  exists: boolean;
  deletable: boolean;
  deleteLabel?: string;
  importable?: boolean;
}

interface DiffTarget {
  name: string;
  path: string;
  sectionLabel: string;
  cached: boolean;       // pre-computed .diff.json exists for this exact pair
  predecessor: boolean;  // this is the pipeline predecessor (the file it was derived from)
}

export interface DiffRequest {
  originalPath: string;
  changedPath: string;
  label: string;            // e.g. "cleaned.epub vs exported.epub"
}

@Component({
  selector: 'app-project-files',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="project-files">
      <div class="section-header-main">
        <span class="section-title-main">Project Files</span>
      </div>

      @if (scanning()) {
        <div class="scanning-state">Scanning files...</div>
      } @else {
        @for (section of sections(); track section.label) {
          <div class="file-section">
            <div class="section-header" (click)="toggleSection(section.label)">
              <span class="section-chevron" [class.expanded]="expandedSections()[section.label]">
                &#9654;
              </span>
              <span class="section-label">{{ section.label }}</span>

              @if (!section.exists) {
                <span class="section-badge empty">empty</span>
              }

              <span class="section-actions">
                @if (section.importable) {
                  <button
                    class="btn-section-action"
                    (click)="importSourceFile($event)"
                    title="Import a source file into this project"
                  >Import File</button>
                }
                @if (section.deletable && section.exists && section.files.length > 0) {
                  <button
                    class="btn-section-action danger"
                    (click)="deleteStage($event, section)"
                    title="{{ section.deleteLabel }}"
                  >{{ section.deleteLabel }}</button>
                }
              </span>
            </div>

            @if (expandedSections()[section.label]) {
              <div class="section-content">
                @if (!section.exists || section.files.length === 0) {
                  <div class="no-files">No files</div>
                } @else {
                  @for (file of section.files; track file.path) {
                    <div class="file-row">
                      <span class="file-icon">{{ file.type === 'directory' ? '&#128193;' : '&#128196;' }}</span>
                      <span class="file-name" [title]="file.path">{{ file.name }}</span>
                      @if (file.type === 'directory' && file.fileCount !== undefined) {
                        <span class="file-meta">({{ file.fileCount }} files)</span>
                      }
                      @if (file.type === 'file' && file.size !== null) {
                        <span class="file-size">{{ formatSize(file.size) }}</span>
                      }
                      <span class="file-actions">
                        @if (file.editable) {
                          <button
                            class="btn-file-action diff"
                            [class.active]="diffPickerFile()?.path === file.path"
                            (click)="toggleDiffPicker(file)"
                            title="Compare against another file"
                          >Diff</button>
                        }
                        <button
                          class="btn-file-action"
                          (click)="showInExplorer(file.path)"
                          title="Show in file explorer"
                        >Show</button>
                        @if (file.editable || file.viewable) {
                          <button
                            class="btn-file-action accent"
                            (click)="onEditFile(file.path)"
                            title="Open in editor"
                          >Edit</button>
                        }
                        @if (isOriginalSource(file)) {
                          <button
                            class="btn-file-action"
                            (click)="replaceSourceFile($event, file)"
                            title="Replace with a new source file"
                          >Replace</button>
                        }
                        @if (isDeletableSourceFile(file)) {
                          <button
                            class="btn-file-action danger"
                            (click)="deleteSourceFile($event, file)"
                            title="Delete this file"
                          >Delete</button>
                        }
                      </span>
                    </div>
                    @if (diffPickerFile()?.path === file.path) {
                      <div class="diff-picker">
                        <div class="diff-picker-label">Compare against:</div>
                        @for (target of getDiffTargets(file); track target.path) {
                          <button
                            class="diff-picker-option"
                            [class.predecessor]="target.predecessor"
                            [class.cached]="target.cached && !target.predecessor"
                            (click)="selectDiffTarget(file, target)"
                          >
                            <span class="diff-target-name" [class.bold]="target.predecessor">{{ target.name }}</span>
                            @if (target.predecessor) {
                              <span class="diff-tag source">source</span>
                            }
                            @if (target.cached) {
                              <span class="diff-tag cached">cached</span>
                            }
                            <span class="diff-target-section">{{ target.sectionLabel }}</span>
                          </button>
                        }
                        @if (getDiffTargets(file).length === 0) {
                          <div class="diff-picker-empty">No other EPUB files to compare against</div>
                        }
                      </div>
                    }
                  }
                }
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .project-files {
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      overflow: hidden;
      background: var(--bg-base);
      margin-top: 16px;
    }

    .section-header-main {
      padding: 10px 14px;
      background: var(--bg-elevated);
      border-bottom: 1px solid var(--border-subtle);
    }

    .section-title-main {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .scanning-state {
      padding: 20px 14px;
      color: var(--text-muted);
      font-size: 13px;
      text-align: center;
    }

    .file-section {
      border-bottom: 1px solid var(--border-subtle);

      &:last-child {
        border-bottom: none;
      }
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      background: var(--bg-surface);
      cursor: pointer;
      user-select: none;
      transition: background 0.1s;

      &:hover {
        background: var(--bg-hover, var(--bg-elevated));
      }
    }

    .section-chevron {
      font-size: 10px;
      color: var(--text-muted);
      transition: transform 0.15s;
      display: inline-block;

      &.expanded {
        transform: rotate(90deg);
      }
    }

    .section-label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .section-badge {
      font-size: 11px;
      padding: 1px 6px;
      border-radius: 4px;
      font-weight: 500;

      &.empty {
        background: var(--bg-sunken);
        color: var(--text-muted);
      }
    }

    .section-actions {
      margin-left: auto;
      display: flex;
      gap: 6px;
    }

    .btn-section-action {
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid var(--border-default);
      border-radius: 4px;
      background: var(--bg-base);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-elevated);
        color: var(--text-primary);
      }

      &.danger {
        color: var(--text-danger, #ef4444);
        border-color: var(--text-danger, #ef4444);

        &:hover {
          background: var(--text-danger, #ef4444);
          color: white;
        }
      }
    }

    .section-content {
      background: var(--bg-base);
    }

    .no-files {
      padding: 8px 14px 8px 36px;
      color: var(--text-muted);
      font-size: 12px;
      font-style: italic;
    }

    .file-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 14px 4px 36px;
      min-height: 30px;
      transition: background 0.1s;

      &:hover {
        background: var(--bg-hover, var(--bg-surface));
      }
    }

    .file-icon {
      font-size: 14px;
      flex-shrink: 0;
      width: 18px;
      text-align: center;
    }

    .file-name {
      font-size: 13px;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }

    .file-meta {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
    }

    .file-size {
      font-size: 12px;
      color: var(--text-secondary);
      white-space: nowrap;
      margin-left: auto;
    }

    .file-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
      margin-left: auto;
    }

    .file-size + .file-actions {
      margin-left: 8px;
    }

    .btn-file-action {
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 500;
      border: 1px solid var(--border-default);
      border-radius: 3px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;
      opacity: 0;

      .file-row:hover & {
        opacity: 1;
      }

      &:hover {
        background: var(--bg-elevated);
        color: var(--text-primary);
      }

      &.accent {
        color: var(--accent);
        border-color: var(--accent);

        &:hover {
          background: var(--accent);
          color: white;
        }
      }

      &.danger {
        color: var(--text-danger, #ef4444);
        border-color: var(--text-danger, #ef4444);

        &:hover {
          background: var(--text-danger, #ef4444);
          color: white;
        }
      }

      &.diff {
        color: #8b5cf6;
        border-color: #8b5cf6;

        &:hover {
          background: #8b5cf6;
          color: white;
        }

        &.active {
          background: #8b5cf6;
          color: white;
          opacity: 1;
        }
      }
    }

    /* Diff picker dropdown */
    .diff-picker {
      padding: 4px 14px 8px 54px;
      background: var(--bg-sunken);
      border-top: 1px solid var(--border-subtle);
      border-bottom: 1px solid var(--border-subtle);
    }

    .diff-picker-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 4px;
    }

    .diff-picker-option {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 10px;
      border: none;
      border-radius: 4px;
      background: transparent;
      cursor: pointer;
      transition: background 0.1s;
      text-align: left;

      &:hover {
        background: var(--bg-hover, var(--bg-surface));
      }

      &.predecessor {
        background: color-mix(in srgb, var(--accent) 8%, transparent);

        &:hover {
          background: color-mix(in srgb, var(--accent) 16%, transparent);
        }
      }

      &.cached {
        background: color-mix(in srgb, #22c55e 6%, transparent);

        &:hover {
          background: color-mix(in srgb, #22c55e 12%, transparent);
        }
      }
    }

    .diff-target-name {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-primary);

      &.bold {
        font-weight: 700;
        color: var(--accent);
      }
    }

    .diff-tag {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 5px;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      flex-shrink: 0;

      &.source {
        background: color-mix(in srgb, var(--accent) 15%, transparent);
        color: var(--accent);
      }

      &.cached {
        background: color-mix(in srgb, #22c55e 15%, transparent);
        color: #22c55e;
      }
    }

    .diff-target-section {
      font-size: 11px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .diff-picker-empty {
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
      padding: 4px 0;
    }
  `]
})
export class ProjectFilesComponent implements OnInit, OnChanges {
  readonly projectDir = input.required<string>();
  readonly projectId = input.required<string>();

  readonly fileChanged = output<void>();
  readonly editFile = output<string>();
  readonly diffFiles = output<DiffRequest>();

  readonly sections = signal<FileSection[]>([]);
  readonly scanning = signal<boolean>(false);
  readonly expandedSections = signal<Record<string, boolean>>({});
  readonly diffPickerFile = signal<ProjectFile | null>(null);

  // Pipeline predecessor tracking — best EPUB at each stage for predecessor inference
  private bestSourceEpub: string | null = null;
  private bestCleanupEpub: string | null = null;

  private readonly electronService = inject(ElectronService);
  private readonly manifestService = inject(ManifestService);
  private readonly studioService = inject(StudioService);

  ngOnInit(): void {
    this.scanFiles();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['projectDir'] && !changes['projectDir'].firstChange) {
      this.scanFiles();
    }
  }

  async scanFiles(): Promise<void> {
    const dir = this.projectDir();
    if (!dir) return;

    this.scanning.set(true);
    this.diffPickerFile.set(null);
    this.bestSourceEpub = null;
    this.bestCleanupEpub = null;

    const sectionDefs = [
      { label: 'Source', subPath: 'source', deletable: false, importable: true },
      { label: 'AI Cleanup', subPath: 'stages/01-cleanup', deletable: true, deleteLabel: 'Delete Stage' },
      { label: 'Translation', subPath: 'stages/02-translate', deletable: true, deleteLabel: 'Delete Stage' },
      { label: 'TTS Cache', subPath: 'stages/03-tts/sessions', deletable: true, deleteLabel: 'Delete Cache' },
      { label: 'Output', subPath: 'output', deletable: true, deleteLabel: 'Delete Output' },
    ];

    const results: FileSection[] = [];

    for (const def of sectionDefs) {
      const sectionPath = `${dir}/${def.subPath}`;
      const section: FileSection = {
        label: def.label,
        dirPath: sectionPath,
        files: [],
        exists: false,
        deletable: def.deletable,
        deleteLabel: def.deleteLabel,
        importable: def.importable,
      };

      try {
        const exists = await this.electronService.fsExists(sectionPath);
        section.exists = exists;

        if (exists) {
          const browseResult = await this.electronService.browse(sectionPath);
          const items = browseResult.items || [];

          if (def.label === 'TTS Cache') {
            // For TTS, show language subdirectories with file counts
            for (const item of items) {
              if (item.type === 'directory') {
                let fileCount = 0;
                try {
                  const subBrowse = await this.electronService.browse(item.path);
                  fileCount = (subBrowse.items || []).length;
                } catch {
                  // can't read subdirectory
                }
                section.files.push({
                  name: `${item.name}/`,
                  path: item.path,
                  size: null,
                  type: 'directory',
                  editable: false,
                  viewable: false,
                  fileCount,
                  sectionLabel: def.label,
                });
              }
            }
          } else {
            // Track which .diff.json files exist in this directory
            const itemNames = new Set(items.map(i => i.name.toLowerCase()));
            const diffCacheLoads: Promise<void>[] = [];

            for (const item of items) {
              if (item.type === 'directory') continue;
              const lowerName = item.name.toLowerCase();
              const isEpub = lowerName.endsWith('.epub');
              const isPdf = lowerName.endsWith('.pdf');

              const file: ProjectFile = {
                name: item.name,
                path: item.path,
                size: item.size,
                type: 'file',
                editable: isEpub,
                viewable: isPdf,
                sectionLabel: def.label,
              };

              // Track best source/cleanup EPUBs for predecessor inference
              if (def.label === 'Source' && isEpub) {
                if (lowerName === 'exported.epub') {
                  this.bestSourceEpub = item.path;
                } else if (lowerName === 'original.epub' && !this.bestSourceEpub) {
                  this.bestSourceEpub = item.path;
                }
              }
              if (def.label === 'AI Cleanup' && isEpub) {
                if (lowerName === 'simplified.epub') {
                  this.bestCleanupEpub = item.path;
                } else if (lowerName === 'cleaned.epub' && !this.bestCleanupEpub) {
                  this.bestCleanupEpub = item.path;
                }
              }

              // Check if this EPUB has a .diff.json cache
              if (isEpub) {
                const diffJsonName = item.name.replace(/\.epub$/i, '.diff.json');
                if (itemNames.has(diffJsonName.toLowerCase())) {
                  diffCacheLoads.push(
                    this.electronService.loadCachedDiffFile(item.path).then(result => {
                      if (result.success && result.data) {
                        file.diffCacheFor = (result.data as any).originalPath || undefined;
                      }
                    }).catch(() => {})
                  );
                }
              }

              section.files.push(file);
            }

            // Load all diff cache metadata concurrently
            await Promise.all(diffCacheLoads);
          }
        }
      } catch {
        section.exists = false;
      }

      results.push(section);
    }

    this.sections.set(results);
    this.scanning.set(false);

    // Auto-expand sections that have files, on first scan
    const expanded = this.expandedSections();
    if (Object.keys(expanded).length === 0) {
      const initial: Record<string, boolean> = {};
      for (const s of results) {
        initial[s.label] = s.exists && s.files.length > 0;
      }
      this.expandedSections.set(initial);
    }

    // Pre-compute diffs for common pipeline pairs in the background
    this.precomputeCommonDiffs(results);
  }

  /**
   * Identify common diff pairs and pre-generate .diff.json caches in the background.
   * Pairs: source->cleanup, source->translation, cleanup->translation
   */
  private precomputeCommonDiffs(sections: FileSection[]): void {
    const epubsBySection: Record<string, string[]> = {};
    for (const section of sections) {
      const epubs = section.files
        .filter(f => f.editable)
        .map(f => f.path);
      if (epubs.length > 0) {
        epubsBySection[section.label] = epubs;
      }
    }

    const sourceEpubs = epubsBySection['Source'] || [];
    const cleanupEpubs = epubsBySection['AI Cleanup'] || [];
    const translationEpubs = epubsBySection['Translation'] || [];

    // For each downstream EPUB, pre-compute diff against all upstream EPUBs
    const pairs: Array<[string, string]> = [];

    for (const target of cleanupEpubs) {
      for (const source of sourceEpubs) {
        pairs.push([source, target]);
      }
    }
    for (const target of translationEpubs) {
      for (const source of sourceEpubs) {
        pairs.push([source, target]);
      }
      for (const cleanup of cleanupEpubs) {
        pairs.push([cleanup, target]);
      }
    }

    // Fire and forget — these run in the background on the main process
    for (const [original, target] of pairs) {
      this.electronService.precomputeDiffPair(original, target).catch(() => {});
    }
  }

  toggleSection(label: string): void {
    const current = { ...this.expandedSections() };
    current[label] = !current[label];
    this.expandedSections.set(current);
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  async showInExplorer(filePath: string): Promise<void> {
    await this.electronService.showItemInFolder(filePath);
  }

  onEditFile(filePath: string): void {
    this.editFile.emit(filePath);
  }

  // ── Diff picker ────────────────────────────────────────────────────────

  toggleDiffPicker(file: ProjectFile): void {
    if (this.diffPickerFile()?.path === file.path) {
      this.diffPickerFile.set(null);
    } else {
      this.diffPickerFile.set(file);
    }
  }

  /** Returns all other EPUBs in the project that can be compared against this file. */
  getDiffTargets(file: ProjectFile): DiffTarget[] {
    // Determine the pipeline predecessor for this file
    let predecessorPath: string | null = null;
    if (file.sectionLabel === 'AI Cleanup') {
      predecessorPath = this.bestSourceEpub;
    } else if (file.sectionLabel === 'Translation') {
      predecessorPath = this.bestCleanupEpub || this.bestSourceEpub;
    }

    // If the .diff.json has an originalPath, use that as the definitive predecessor
    if (file.diffCacheFor) {
      predecessorPath = file.diffCacheFor;
    }

    const targets: DiffTarget[] = [];
    for (const section of this.sections()) {
      for (const f of section.files) {
        if (f.path === file.path) continue;
        if (!f.editable) continue;

        const isPredecessor = predecessorPath !== null &&
          this.normalizePath(f.path) === this.normalizePath(predecessorPath);
        const isCached = file.diffCacheFor !== undefined &&
          this.normalizePath(f.path) === this.normalizePath(file.diffCacheFor);

        targets.push({
          name: f.name,
          path: f.path,
          sectionLabel: section.label,
          cached: isCached,
          predecessor: isPredecessor,
        });
      }
    }

    // Sort: predecessor first, then cached, then rest
    targets.sort((a, b) => {
      if (a.predecessor !== b.predecessor) return a.predecessor ? -1 : 1;
      if (a.cached !== b.cached) return a.cached ? -1 : 1;
      return 0;
    });

    return targets;
  }

  /** User picked a target from the diff dropdown. The clicked file is the "changed" side. */
  selectDiffTarget(file: ProjectFile, target: DiffTarget): void {
    this.diffPickerFile.set(null);
    this.diffFiles.emit({
      originalPath: target.path,
      changedPath: file.path,
      label: `${file.name} vs ${target.name}`,
    });
  }

  // ── File operations ────────────────────────────────────────────────────

  async importSourceFile(event: Event): Promise<void> {
    event.stopPropagation();

    const result = await this.electronService.openPdfDialog();
    if (!result.success || !result.filePath) return;

    const importResult = await this.manifestService.importSourceFile(
      this.projectId(),
      result.filePath,
    );

    if (importResult.success) {
      await this.scanFiles();
      this.fileChanged.emit();
    }
  }

  async deleteStage(event: Event, section: FileSection): Promise<void> {
    event.stopPropagation();

    const { confirmed } = await this.electronService.showConfirmDialog({
      title: section.deleteLabel || 'Delete',
      message: `Delete all files in "${section.label}"?`,
      detail: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      type: 'warning',
    });

    if (!confirmed) return;

    const electron = (window as any).electron;
    const projectDir = this.projectDir();

    switch (section.label) {
      case 'AI Cleanup':
        if (!electron?.pipeline) return;
        await electron.pipeline.deleteCleanup(projectDir);
        break;
      case 'Translation':
        if (!electron?.pipeline) return;
        await electron.pipeline.deleteTranslation(projectDir);
        break;
      case 'TTS Cache':
        if (!electron?.pipeline) return;
        await electron.pipeline.deleteTtsCache(projectDir);
        break;
      case 'Output':
        // Delete each file in the output directory individually
        for (const file of section.files) {
          await this.electronService.deleteFile(file.path);
        }
        break;
      default:
        return;
    }

    await this.scanFiles();
    this.fileChanged.emit();
  }

  // ── Source file operations ─────────────────────────────────────────────

  /** original.epub (or original source) can be replaced */
  isOriginalSource(file: ProjectFile): boolean {
    return file.sectionLabel === 'Source' && file.name.toLowerCase() === 'original.epub';
  }

  /** exported.epub and other non-original source files can be deleted */
  isDeletableSourceFile(file: ProjectFile): boolean {
    return file.sectionLabel === 'Source' && file.name.toLowerCase() !== 'original.epub';
  }

  async replaceSourceFile(event: Event, file: ProjectFile): Promise<void> {
    event.stopPropagation();

    const result = await this.electronService.openPdfDialog();
    if (!result.success || !result.filePath) return;

    const { confirmed } = await this.electronService.showConfirmDialog({
      title: 'Replace Source File',
      message: `Replace "${file.name}" with the selected file?`,
      detail: 'The current source file will be overwritten. Downstream stages (cleanup, translation, TTS) will not be affected until re-run.',
      confirmLabel: 'Replace',
      type: 'warning',
    });
    if (!confirmed) return;

    const importResult = await this.manifestService.importSourceFile(
      this.projectId(),
      result.filePath,
      'original.epub',
    );

    if (importResult.success) {
      await this.scanFiles();
      this.fileChanged.emit();
    }
  }

  async deleteSourceFile(event: Event, file: ProjectFile): Promise<void> {
    event.stopPropagation();

    const { confirmed } = await this.electronService.showConfirmDialog({
      title: 'Delete File',
      message: `Delete "${file.name}"?`,
      detail: 'This action cannot be undone.',
      confirmLabel: 'Delete',
      type: 'warning',
    });
    if (!confirmed) return;

    await this.electronService.deleteFile(file.path);
    await this.scanFiles();
    this.fileChanged.emit();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  private normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }
}
