import { Component, inject, signal, input, output, effect, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StudioService } from '../../services/studio.service';
import { ElectronService } from '../../../../core/services/electron.service';
import { NoticeService } from '../../../../core/services/notice.service';
import { StudioItem } from '../../models/studio.types';
import { ImportMetadataModalComponent, ImportMetadata } from '../import-metadata-modal/import-metadata-modal.component';
import type { AdoptableFoundryProject as FoundryAdoptable } from '@shared/foundry/adopt-types';

interface ImportProgress {
  total: number;
  completed: number;
  current: string;
  errors: string[];
}

/**
 * AddModalComponent - Modal for adding EPUBs or URLs
 *
 * Features:
 * - Drag & drop multiple ebook files
 * - Browse and multi-select files
 * - Paste URL and fetch article
 */
@Component({
  selector: 'app-add-modal',
  standalone: true,
  imports: [CommonModule, FormsModule, ImportMetadataModalComponent],
  template: `
    @if (showMetadataConfirm()) {
      <app-import-metadata-modal
        [initialMetadata]="pendingMetadata()!"
        [coverData]="pendingCoverData()"
        [notice]="pendingMetadataNotice()"
        (confirm)="onMetadataConfirmed($event)"
        (cancel)="onMetadataCancelled()"
      />
    }
    <div class="modal-backdrop" (click)="close.emit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Add New Content</h2>
          <button class="btn-close" (click)="close.emit()">&times;</button>
        </div>

        <div class="modal-body">
          <!-- EPUB Drop Zone -->
          <div
            class="drop-zone"
            [class.drag-over]="isDragOver()"
            [class.loading]="isLoadingEpub()"
            (dragover)="onDragOver($event)"
            (dragleave)="onDragLeave($event)"
            (drop)="onDrop($event)"
          >
            @if (isLoadingEpub()) {
              <div class="loading-state">
                <div class="spinner"></div>
                @if (batchProgress()) {
                  <p>{{ batchProgress()!.current }}</p>
                  <div class="progress-bar">
                    <div class="progress-fill" [style.width.%]="(batchProgress()!.completed / batchProgress()!.total) * 100"></div>
                  </div>
                  <p class="progress-count">{{ batchProgress()!.completed }} / {{ batchProgress()!.total }}</p>
                } @else if (importPct() !== null) {
                  <p>{{ loadingMessage() }}</p>
                  <div class="progress-bar">
                    <div class="progress-fill" [style.width.%]="importPct()!"></div>
                  </div>
                  <p class="progress-count">{{ importPct() }}%</p>
                } @else {
                  <p>{{ loadingMessage() }}</p>
                }
              </div>
            } @else {
              <div class="drop-icon">📚</div>
              <p class="drop-text">Drop any ebooks or PDFs here</p>
              <p class="drop-hint">EPUB, PDF, MOBI, AZW3, DOCX, and more — drop multiple files at once</p>
              <button class="btn-browse" (click)="browseFiles()">
                Browse Files
              </button>
            }
          </div>
          @if (importError()) {
            <p class="import-error">{{ importError() }}</p>
          }

          <div class="divider">
            <span>or</span>
          </div>

          <!-- URL Input -->
          <div class="url-section">
            <div class="url-input-wrapper">
              <input
                type="url"
                class="url-input"
                placeholder="Paste article URL..."
                [(ngModel)]="urlValue"
                [disabled]="isLoadingUrl()"
                (keydown.enter)="fetchUrl()"
              />
              <button
                class="btn-fetch"
                [disabled]="!urlValue || isLoadingUrl()"
                (click)="fetchUrl()"
              >
                @if (isLoadingUrl()) {
                  <span class="spinner-small"></span>
                } @else {
                  Fetch
                }
              </button>
            </div>
            @if (urlError()) {
              <p class="url-error">{{ urlError() }}</p>
            }
            @if (urlWarning()) {
              <p class="url-warning">{{ urlWarning() }}</p>
            }
          </div>

          <!--
            ADOPT A FOUNDRY PROJECT.

            A book edited in standalone Foundry, or an orphan project in this
            library's own foundry/ folder that no book maps, is work that exists
            and that BookForge cannot see. This is the door: it mints the book
            from the project's own archived original and joins the two, so the
            result is exactly what importing through the Foundry window would
            have produced.

            Drawn in the modal's own idiom and nothing new: the same "or"
            divider, the same browse button, list rows built from the same
            surface/border tokens the drop zone uses.
          -->
          <div class="divider">
            <span>or</span>
          </div>

          <div class="adopt-section">
            <p class="adopt-title">Adopt a Foundry project</p>
            <p class="adopt-hint">
              Projects you made in Foundry that aren’t in your library yet. The
              original stays where it is — a copy comes in with its exports.
            </p>

            @if (adoptLoading()) {
              <p class="adopt-empty">Looking for Foundry projects…</p>
            } @else if (adoptables().length === 0) {
              <p class="adopt-empty">No Foundry projects left to adopt.</p>
            } @else {
              <ul class="adopt-list">
                @for (project of adoptables(); track project.dir) {
                  <li class="adopt-row">
                    <div class="adopt-row-text">
                      <span class="adopt-name" [title]="project.dir">{{ project.title }}</span>
                      <span class="adopt-meta">
                        {{ project.origin === 'standalone' ? 'Foundry library' : 'In this library' }}
                        · edited {{ formatAdoptDate(project.modifiedAt) }}
                        @if (project.hasExports) {
                          <span class="adopt-badge">has exports</span>
                        }
                      </span>
                    </div>
                    <button
                      class="btn-adopt"
                      [disabled]="adoptingDir() !== null"
                      (click)="adoptProject(project.dir)"
                    >
                      @if (adoptingDir() === project.dir) {
                        <span class="spinner-small"></span>
                      } @else {
                        Adopt
                      }
                    </button>
                  </li>
                }
              </ul>
            }

            <button
              class="btn-browse btn-browse-folder"
              [disabled]="adoptingDir() !== null"
              (click)="browseForFoundryProject()"
            >
              Choose a project folder…
            </button>

            @if (adoptError()) {
              <p class="import-error adopt-message">{{ adoptError() }}</p>
            }
            @for (refusal of adoptRefusals(); track refusal) {
              <p class="url-warning adopt-message">{{ refusal }}</p>
            }
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-content {
      background: var(--bg-surface);
      border-radius: 12px;
      width: 480px;
      max-width: 90vw;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-20px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-close {
      background: none;
      border: none;
      font-size: 24px;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0;
      line-height: 1;

      &:hover {
        color: var(--text-primary);
      }
    }

    .modal-body {
      padding: 24px;
    }

    .drop-zone {
      border: 2px dashed var(--border-default);
      border-radius: 8px;
      padding: 40px 20px;
      text-align: center;
      transition: all 0.2s ease;
      cursor: pointer;

      &:hover {
        border-color: var(--color-primary);
        background: var(--bg-hover);
      }

      &.drag-over {
        border-color: var(--color-primary);
        background: rgba(6, 182, 212, 0.1);
        border-style: solid;
      }

      &.loading {
        cursor: default;
        pointer-events: none;
      }
    }

    .drop-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }

    .drop-text {
      margin: 0 0 4px;
      font-size: 16px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .drop-hint {
      margin: 0 0 16px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .btn-browse {
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-primary);
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-strong);
      }
    }

    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      color: var(--text-secondary);
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--color-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .spinner-small {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border-default);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .progress-bar {
      width: 100%;
      max-width: 280px;
      height: 4px;
      background: var(--progress-track);
      border-radius: 2px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      background: var(--progress-fill);
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .progress-count {
      font-size: 12px;
      color: var(--progress-value);
      font-weight: 600;
      margin: 0;
    }

    .divider {
      display: flex;
      align-items: center;
      margin: 24px 0;
      color: var(--text-muted);
      font-size: 13px;

      &::before,
      &::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--border-subtle);
      }

      span {
        padding: 0 16px;
      }
    }

    .url-section {
      .url-input-wrapper {
        display: flex;
        gap: 8px;
      }
    }

    .url-input {
      flex: 1;
      padding: 12px 16px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 14px;
      color: var(--text-primary);
      outline: none;

      &:focus {
        border-color: var(--color-primary);
        box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.15);
      }

      &::placeholder {
        color: var(--text-muted);
      }

      &:disabled {
        opacity: 0.6;
      }
    }

    .btn-fetch {
      padding: 12px 20px;
      background: var(--color-primary);
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      color: white;
      cursor: pointer;
      transition: all 0.15s ease;
      min-width: 80px;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }

    .import-error {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--color-error);
      text-align: center;
    }

    .url-error {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--color-error);
    }

    .url-warning {
      margin: 8px 0 0;
      font-size: 13px;
      color: var(--warning-text);
    }

    /* ── Adopt a Foundry project ─────────────────────────────────────────── */

    .adopt-title {
      margin: 0 0 2px;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .adopt-hint {
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--text-secondary);
    }

    .adopt-empty {
      margin: 0 0 12px;
      font-size: 13px;
      color: var(--text-muted);
    }

    .adopt-list {
      list-style: none;
      margin: 0 0 12px;
      padding: 0;
      /* Capped rather than unbounded: a library with thirty unadopted projects
         must not turn this modal into a page. */
      max-height: 200px;
      overflow-y: auto;
      border: 1px solid var(--border-subtle);
      border-radius: 6px;
    }

    .adopt-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 12px;

      & + & {
        border-top: 1px solid var(--border-subtle);
      }

      &:hover {
        background: var(--bg-hover);
      }
    }

    .adopt-row-text {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .adopt-name {
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .adopt-meta {
      font-size: 11px;
      color: var(--text-muted);
    }

    .adopt-badge {
      display: inline-block;
      margin-left: 6px;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      color: var(--text-secondary);
    }

    .btn-adopt {
      flex-shrink: 0;
      min-width: 64px;
      padding: 6px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 6px;
      font-size: 12px;
      color: var(--text-primary);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;

      &:hover:not(:disabled) {
        background: var(--bg-hover);
        border-color: var(--border-strong);
      }

      &:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
    }

    .btn-adopt .spinner-small {
      border-top-color: var(--color-primary);
    }

    .btn-browse-folder {
      width: 100%;
    }

    .adopt-message {
      text-align: left;
    }
  `]
})
export class AddModalComponent {
  private readonly studioService = inject(StudioService);
  private readonly electronService = inject(ElectronService);
  private readonly notices = inject(NoticeService);

  // Inputs
  readonly initialFiles = input<string[]>([]);

  // Outputs
  readonly close = output<void>();
  readonly added = output<StudioItem>();

  // Auto-process files passed via initialFiles input
  private readonly initialFilesEffect = effect(() => {
    const files = this.initialFiles();
    if (files.length === 0) return;
    if (files.length === 1) {
      this.handleFile(files[0]);
    } else {
      this.handleMultipleFiles(files);
    }
  });

  // State
  readonly isDragOver = signal<boolean>(false);
  readonly isLoadingEpub = signal<boolean>(false);
  readonly isLoadingUrl = signal<boolean>(false);
  readonly loadingMessage = signal<string>('Importing...');
  readonly importError = signal<string | null>(null);
  readonly urlError = signal<string | null>(null);
  // Partial-extraction warning (page load timeout / unsolved captcha): the
  // article WAS added, but its text may be incomplete — keep the modal open so
  // the user actually sees it.
  readonly urlWarning = signal<string | null>(null);
  readonly batchProgress = signal<ImportProgress | null>(null);
  // 0..100 while an audio import (ffmpeg transcode/remux) runs; null otherwise.
  readonly importPct = signal<number | null>(null);
  readonly showMetadataConfirm = signal<boolean>(false);
  readonly pendingMetadata = signal<ImportMetadata | null>(null);
  readonly pendingCoverData = signal<string | null>(null);
  // Set when the EPUB could not be parsed and pendingMetadata is only a
  // filename guess — shown as a warning inside the confirmation modal.
  readonly pendingMetadataNotice = signal<string | null>(null);
  private pendingFilePath: string | null = null;

  // ── Adopt a Foundry project ───────────────────────────────────────────────
  //
  // Foundry projects that exist and that this library has never seen: standalone
  // Foundry's own library, and orphans in our own hosted root that no book's
  // manifest maps. Listed on open (one IPC call), adopted one press at a time.

  readonly adoptables = signal<FoundryAdoptable[]>([]);
  readonly adoptRefusals = signal<string[]>([]);
  readonly adoptLoading = signal<boolean>(true);
  /** The project currently being adopted — one at a time, so the list can't race. */
  readonly adoptingDir = signal<string | null>(null);
  readonly adoptError = signal<string | null>(null);

  urlValue = '';

  constructor() {
    void this.loadAdoptables();
  }

  private async loadAdoptables(): Promise<void> {
    // Outside Electron there is no filesystem to look in, and the door is not a
    // door. Empty rather than an error: "not running in Electron" is a sentence
    // about the harness, not about the user's Foundry projects.
    if (!this.electronService.isRunningInElectron) {
      this.adoptLoading.set(false);
      return;
    }
    this.adoptLoading.set(true);
    try {
      const result = await this.electronService.foundryHostAdoptables();
      if (result.success) {
        this.adoptables.set(result.projects ?? []);
        this.adoptRefusals.set(result.refusals ?? []);
      } else {
        // The list failing is NOT the same as an empty list, and must not look
        // like one: an empty list says "there is nothing to adopt", which would
        // be a lie about a library that could not be read.
        this.adoptables.set([]);
        this.adoptRefusals.set([]);
        this.adoptError.set(
          `Foundry projects could not be looked for: ${result.error || 'no reason given'}`);
      }
    } finally {
      this.adoptLoading.set(false);
    }
  }

  /** "17 Aug 2026" — the short form the rows want; never a raw ISO string. */
  formatAdoptDate(iso: string): string {
    const at = new Date(iso);
    if (isNaN(+at)) return 'at an unknown time';
    return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  async adoptProject(dir: string): Promise<void> {
    if (this.adoptingDir() !== null) return;
    this.adoptError.set(null);
    this.adoptingDir.set(dir);
    try {
      const response = await this.electronService.foundryHostAdopt(dir);
      const result = response.result;
      if (!result) {
        this.adoptError.set(response.error || 'The project could not be adopted.');
        return;
      }
      if (result.outcome === 'refused') {
        // A refusal is the whole answer and it is a sentence. Shown here rather
        // than as a toast, because the user is looking at the row they pressed.
        this.adoptError.set(result.reason);
        return;
      }

      this.notices.notify(result.message);
      // The row is gone from the list once the book claims it — re-asked rather
      // than spliced out, because adoption of an orphan can change what the
      // OTHER half of the list holds too.
      await this.loadAdoptables();

      // The same reload-and-find the file import does: the shelf is rebuilt from
      // the library, and the new book is handed to the parent so it can select
      // it. loadBooks builds `projectDir` with forward slashes while main returns
      // path.join(...) — backslashes on Windows — so compare separator-normalized.
      await this.studioService.loadBooks();
      const norm = (p?: string) => p?.replace(/\\/g, '/');
      const adopted = this.studioService.books().find(
        (b) => norm(b.projectDir) === norm(result.bookDir));
      if (adopted) this.added.emit(adopted);
      this.close.emit();
    } catch (err) {
      this.adoptError.set((err as Error).message);
    } finally {
      this.adoptingDir.set(null);
    }
  }

  /**
   * The fallback for a project in neither searched place — an old library, a
   * backup drive, a Foundry install whose settings file was never written.
   */
  async browseForFoundryProject(): Promise<void> {
    const picked = await this.electronService.foundryHostBrowseForProject();
    if (!picked.success || !picked.folderPath) return;
    await this.adoptProject(picked.folderPath);
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    if (this.showMetadataConfirm()) {
      // Let the metadata modal handle its own escape
      return;
    }
    this.close.emit();
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(true);
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragOver.set(false);

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const { paths, unlocatable } = this.electronService.pathsForFiles(files);
    if (unlocatable.length > 0) {
      this.notices.notify(
        `Not added — ${unlocatable.join(', ')} ${unlocatable.length === 1 ? 'is' : 'are'} ` +
        `not a file on this machine. Drop books in from a folder, not from a web page.`
      );
    }

    if (paths.length === 1) {
      this.handleFile(paths[0]);
    } else if (paths.length > 1) {
      this.handleMultipleFiles(paths);
    }
  }

  async browseFiles(): Promise<void> {
    const result = await this.electronService.openPdfDialog();
    if (!result.success) return;

    // Support multi-select: use filePaths array if available
    const filePaths: string[] = (result as any).filePaths || (result.filePath ? [result.filePath] : []);
    if (filePaths.length === 0) return;

    if (filePaths.length === 1) {
      await this.handleFile(filePaths[0]);
    } else {
      await this.handleMultipleFiles(filePaths);
    }
  }

  private static readonly AUDIO_EXT = ['.m4b', '.m4a', '.mp3', '.wav', '.flac', '.ogg', '.oga', '.aac', '.opus', '.wma', '.aiff', '.aif'];
  private isAudioFile(name: string): boolean {
    return AddModalComponent.AUDIO_EXT.some((e) => name.endsWith(e));
  }

  private async handleFile(filePath: string): Promise<void> {
    this.importError.set(null);
    const name = filePath.toLowerCase();

    if (name.endsWith('.jwpub')) {
      await this.convertJwpubAndImport(filePath);
    } else if (this.isAudioFile(name)) {
      await this.doImportAudiobook(filePath);
    } else if (name.endsWith('.epub') || name.endsWith('.pdf')) {
      await this.importFile(filePath);
    } else {
      await this.convertAndImport(filePath);
    }
  }

  private async doImportAudiobook(filePath: string): Promise<void> {
    this.isLoadingEpub.set(true);
    this.loadingMessage.set('Importing audiobook…');
    this.importPct.set(0);
    // Big m4b files are transcoded/remuxed by ffmpeg — show real progress so it
    // doesn't look frozen.
    const unsub = this.electronService.onImportProgress((p) =>
      this.importPct.set(Math.min(100, Math.round(p.fraction * 100))),
    );
    try {
      const result = await this.studioService.importAudiobook(filePath);
      if (result.success) {
        if (result.item) this.added.emit(result.item);
        this.close.emit();
      } else {
        this.importError.set(result.error || 'Failed to import audiobook');
      }
    } finally {
      unsub();
      this.importPct.set(null);
      this.isLoadingEpub.set(false);
    }
  }

  private async handleMultipleFiles(filePaths: string[]): Promise<void> {
    this.importError.set(null);
    this.isLoadingEpub.set(true);

    const progress: ImportProgress = {
      total: filePaths.length,
      completed: 0,
      current: '',
      errors: [],
    };
    this.batchProgress.set({ ...progress });

    let lastAdded: StudioItem | undefined;
    // Non-fatal problems (e.g. metadata guessed from the filename) — the books
    // still import, but the user must be told rather than shown a clean success.
    const warnings: string[] = [];

    for (const filePath of filePaths) {
      const filename = filePath.split('/').pop() || filePath;
      progress.current = `Importing ${filename}...`;
      this.batchProgress.set({ ...progress });

      try {
        const name = filePath.toLowerCase();
        let importPath = filePath;

        // Audio files import as complete audiobook projects (no conversion).
        if (this.isAudioFile(name)) {
          const audioResult = await this.studioService.importAudiobook(filePath);
          if (audioResult.success && audioResult.item) lastAdded = audioResult.item;
          else if (!audioResult.success) progress.errors.push(`${filename}: ${audioResult.error || 'Audiobook import failed'}`);
          progress.completed++;
          this.batchProgress.set({ ...progress });
          continue;
        }

        // Convert non-native formats first
        if (name.endsWith('.jwpub')) {
          progress.current = `Converting JWPUB ${filename}...`;
          this.batchProgress.set({ ...progress });
          const convertResult = await this.electronService.convertJwpub(filePath);
          if (!convertResult.success || !convertResult.outputPath) {
            progress.errors.push(`${filename}: ${convertResult.error || 'JWPUB conversion failed'}`);
            progress.completed++;
            this.batchProgress.set({ ...progress });
            continue;
          }
          importPath = convertResult.outputPath;
        } else if (!name.endsWith('.epub') && !name.endsWith('.pdf')) {
          progress.current = `Converting ${filename}...`;
          this.batchProgress.set({ ...progress });
          const convertResult = await this.electronService.convertEbook(filePath);
          if (!convertResult.success || !convertResult.outputPath) {
            progress.errors.push(`${filename}: ${convertResult.error || 'Conversion failed'}`);
            progress.completed++;
            this.batchProgress.set({ ...progress });
            continue;
          }
          importPath = convertResult.outputPath;
        }

        // For EPUBs, auto-extract metadata for better folder names
        let metadata: ImportMetadata | undefined;
        if (importPath.toLowerCase().endsWith('.epub')) {
          try {
            const extractResult = await this.electronService.extractEpubMetadata(importPath);
            if (extractResult.success && extractResult.metadata) {
              metadata = {
                title: extractResult.metadata.title,
                author: extractResult.metadata.author,
                year: extractResult.metadata.year,
                language: extractResult.metadata.language,
              };
              if (extractResult.degraded) {
                warnings.push(`${filename}: metadata could not be read from the EPUB — title/author were guessed from the filename`);
              }
            }
          } catch {
            // Extraction failed — import without metadata
          }
        }

        const result = await this.studioService.addBook(importPath, metadata);
        if (result.success) {
          // A successful import may not resolve back to a StudioItem (e.g. the
          // reloaded list hasn't surfaced it yet); that's still a success, not a
          // failure — only report an error when the import itself failed.
          if (result.item) lastAdded = result.item;
        } else {
          progress.errors.push(`${filename}: ${result.error || 'Import failed'}`);
        }
      } catch (err) {
        progress.errors.push(`${filename}: ${(err as Error).message}`);
      }

      progress.completed++;
      this.batchProgress.set({ ...progress });
    }

    this.isLoadingEpub.set(false);
    this.batchProgress.set(null);

    if (progress.errors.length > 0) {
      this.importError.set(`Failed: ${progress.errors.join('; ')}`);
    } else if (warnings.length > 0) {
      // Imports succeeded but with caveats — keep the modal open so the
      // message is actually seen instead of auto-closing over it.
      this.importError.set(`Imported with warnings — ${warnings.join('; ')}`);
    }

    if (lastAdded) {
      this.added.emit(lastAdded);
    }

    // Close modal only when everything succeeded cleanly
    if (progress.errors.length === 0 && warnings.length === 0) {
      this.close.emit();
    }
  }

  private async importFile(filePath: string): Promise<void> {
    const isPdf = filePath.toLowerCase().endsWith('.pdf');
    const isEpub = filePath.toLowerCase().endsWith('.epub');

    // For EPUBs, extract metadata and show confirmation modal
    if (isEpub) {
      this.isLoadingEpub.set(true);
      this.loadingMessage.set('Reading metadata...');
      try {
        const extractResult = await this.electronService.extractEpubMetadata(filePath);
        this.isLoadingEpub.set(false);

        if (extractResult.success && extractResult.metadata) {
          this.pendingFilePath = filePath;
          this.pendingMetadata.set({
            title: extractResult.metadata.title,
            author: extractResult.metadata.author,
            year: extractResult.metadata.year,
            language: extractResult.metadata.language,
          });
          this.pendingCoverData.set(extractResult.metadata.coverData);
          // degraded = the EPUB itself could not be parsed; the fields above are
          // only a guess from the filename. Say so instead of presenting the
          // guess as real metadata.
          this.pendingMetadataNotice.set(extractResult.degraded
            ? 'Metadata could not be read from the EPUB — these values were guessed from the filename. Please check them before importing.'
            : null);
          this.showMetadataConfirm.set(true);
        } else {
          // Extraction failed — import directly without metadata modal
          await this.doImport(filePath);
        }
      } catch {
        this.isLoadingEpub.set(false);
        await this.doImport(filePath);
      }
      return;
    }

    // PDFs and other formats: import directly
    await this.doImport(filePath);
  }

  async onMetadataConfirmed(metadata: ImportMetadata): Promise<void> {
    this.showMetadataConfirm.set(false);
    const filePath = this.pendingFilePath;
    const coverData = this.pendingCoverData();
    this.pendingFilePath = null;
    this.pendingMetadata.set(null);
    this.pendingCoverData.set(null);
    this.pendingMetadataNotice.set(null);
    if (filePath) {
      await this.doImport(filePath, metadata, coverData ?? undefined);
    }
  }

  onMetadataCancelled(): void {
    this.showMetadataConfirm.set(false);
    this.pendingFilePath = null;
    this.pendingMetadata.set(null);
    this.pendingCoverData.set(null);
    this.pendingMetadataNotice.set(null);
  }

  private async doImport(filePath: string, metadata?: ImportMetadata, coverData?: string): Promise<void> {
    this.isLoadingEpub.set(true);
    const isPdf = filePath.toLowerCase().endsWith('.pdf');
    this.loadingMessage.set(isPdf ? 'Importing PDF...' : 'Importing EPUB...');

    try {
      const metaWithCover = metadata && coverData
        ? { ...metadata, coverData }
        : metadata;
      const result = await this.studioService.addBook(filePath, metaWithCover);

      if (result.success) {
        if (result.item) {
          this.added.emit(result.item);
        }
        // An imported PDF used to throw the legacy editor window open on top of
        // the import. That window is unreachable since 2026-08-16 (Owen's
        // ruling: Foundry is the one editing surface), and an import now only
        // imports — the book lands in the library and the user chooses when to
        // edit it, from its own Edit in Foundry button.
        this.close.emit();
      } else {
        this.importError.set(result.error || 'Failed to import');
      }
    } finally {
      this.isLoadingEpub.set(false);
    }
  }

  private async convertAndImport(filePath: string): Promise<void> {
    this.isLoadingEpub.set(true);
    this.loadingMessage.set('Converting to EPUB...');

    try {
      const convertResult = await this.electronService.convertEbook(filePath);
      if (!convertResult.success || !convertResult.outputPath) {
        this.importError.set(convertResult.error || 'Conversion failed. Install Calibre for format conversion.');
        return;
      }

      this.loadingMessage.set('Importing...');
      await this.importFile(convertResult.outputPath);
    } catch (err) {
      this.importError.set('Conversion failed: ' + (err as Error).message);
    } finally {
      this.isLoadingEpub.set(false);
    }
  }

  private async convertJwpubAndImport(filePath: string): Promise<void> {
    this.isLoadingEpub.set(true);
    this.loadingMessage.set('Converting JWPUB to EPUB...');

    try {
      const convertResult = await this.electronService.convertJwpub(filePath);
      if (!convertResult.success || !convertResult.outputPath) {
        this.importError.set(convertResult.error || 'JWPUB conversion failed.');
        return;
      }

      // The converted EPUB has proper OPF metadata, so importFile will
      // extract title/author/year/language via the metadata modal as usual.
      this.loadingMessage.set('Importing...');
      await this.importFile(convertResult.outputPath);
    } catch (err) {
      this.importError.set('JWPUB conversion failed: ' + (err as Error).message);
    } finally {
      this.isLoadingEpub.set(false);
    }
  }

  async fetchUrl(): Promise<void> {
    if (!this.urlValue) return;

    this.urlError.set(null);
    this.urlWarning.set(null);
    this.isLoadingUrl.set(true);

    try {
      const result = await this.studioService.addArticle(this.urlValue);

      if (result.success && result.item) {
        this.added.emit(result.item);
        if (result.warning) {
          // Article added but possibly incomplete (load timeout / unsolved
          // captcha) — keep the modal open and show the warning instead of
          // silently closing.
          this.urlWarning.set(result.warning);
        } else {
          this.close.emit();
        }
      } else {
        this.urlError.set(result.error || 'Failed to fetch URL');
      }
    } finally {
      this.isLoadingUrl.set(false);
    }
  }
}
