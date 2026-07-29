import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { PdfPickerComponent } from '../../../pdf-picker/pdf-picker.component';
import { EpubFlowComponent } from '../../../pdf-picker/components/epub-flow/epub-flow.component';
import { ElectronService } from '../../../../core/services/electron.service';

/**
 * EditorWindow - Standalone editor window for PDF/EPUB editing
 *
 * This component is loaded in a separate Electron window and provides
 * the full PdfPicker experience for editing a project. When the user
 * clicks Finalize, the EPUB is saved to the project folder.
 *
 * TWO PATHS, chosen by what the project was imported FROM (manifest.source.type):
 *
 *  - **PDF** → the picker, unchanged. A PDF has to be reconstructed from
 *    positioned glyphs, so it needs page images, bounding boxes, regions and the
 *    category learner to work out what is prose.
 *  - **EPUB** → the document-flow editor. An EPUB already states its structure;
 *    running it back through a page layout destroyed it (measured: ~1,300 authored
 *    paragraphs came out as a couple dozen blobs). Reading the book's own elements
 *    lets export copy it verbatim minus the excluded ones, so `<sup>` markers,
 *    headings, lists and emphasis all survive.
 *
 * Receives project path via query param: /editor?project=<encoded-path>
 */
@Component({
  selector: 'app-editor-window',
  standalone: true,
  imports: [CommonModule, PdfPickerComponent, EpubFlowComponent],
  template: `
    <div class="editor-window">
      @if (projectPath() && sourceKind() === 'epub' && archiveEpubPath()) {
        <app-epub-flow
          [epubPath]="archiveEpubPath()!"
          [initialExcluded]="initialExcluded()"
          (selectionAccepted)="onEpubSelectionAccepted($event)"
        />
      } @else if (projectPath() && sourceKind() !== null) {
        <app-pdf-picker
          [embedded]="true"
          [bfpPath]="projectPath()!"
          [overrideSourcePath]="sourcePath()"
          [librarySourcePath]="libraryMode() ? projectPath() : null"
          (finalized)="onFinalized($event)"
          (exitRequested)="onExitRequested()"
        />
      } @else if (error()) {
        <div class="error-state">
          <h2>Unable to open project</h2>
          <p>{{ error() }}</p>
        </div>
      } @else {
        <div class="loading-state">
          <p>Loading project...</p>
        </div>
      }
    </div>

    @if (toastMessage()) {
      <div class="toast" [class]="'toast-' + toastType()">
        {{ toastMessage() }}
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100vh;
      width: 100vw;
      overflow: hidden;
    }

    .editor-window {
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    app-pdf-picker,
    app-epub-flow {
      flex: 1;
      min-height: 0;
    }

    .error-state,
    .loading-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--text-secondary);
      gap: 1rem;

      h2 {
        margin: 0;
        color: var(--text-primary);
      }

      p {
        margin: 0;
      }
    }

    .toast {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      padding: 12px 24px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      animation: slideUp 0.3s ease;
    }

    .toast-success {
      background: var(--accent-success);
      color: white;
    }

    .toast-error {
      background: var(--accent-danger);
      color: white;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateX(-50%) translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
    }
  `]
})
export class EditorWindowComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly electron = inject(ElectronService);

  readonly projectPath = signal<string | null>(null);
  readonly sourcePath = signal<string | null>(null);  // Optional: specific version to load
  readonly libraryMode = signal(false);
  readonly error = signal<string | null>(null);
  readonly toastMessage = signal<string | null>(null);
  readonly toastType = signal<'success' | 'error'>('success');
  private toastTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * What the project was IMPORTED from — manifest.source.type, verbatim. Null
   * until the manifest has been read, which is why the template renders neither
   * editor until then: guessing from the file extension would send an EPUB
   * project that is currently pointing at exported.epub down the wrong path.
   */
  readonly sourceKind = signal<string | null>(null);
  readonly archiveEpubPath = signal<string | null>(null);
  readonly initialExcluded = signal<string[]>([]);

  ngOnInit(): void {
    // Get project path and optional source path from query params
    this.route.queryParams.subscribe(params => {
      const project = params['project'];
      const source = params['source'];

      if (project) {
        // Decode the paths
        const decodedPath = decodeURIComponent(project);
        this.projectPath.set(decodedPath);

        if (source) {
          const decodedSource = decodeURIComponent(source);
          this.sourcePath.set(decodedSource);
        }

        if (params['mode'] === 'library') {
          this.libraryMode.set(true);
        }

        void this.resolveSourceKind(decodedPath);
      } else {
        this.error.set('No project path provided');
      }
    });
  }

  /**
   * Decide which editor this project gets, from the manifest rather than from the
   * currently-selected file. A project imported from an EPUB stays an EPUB project
   * forever, even once every later stage is working on exported.epub.
   */
  private async resolveSourceKind(projectDir: string): Promise<void> {
    const projectId = projectDir.split(/[\\/]/).filter(Boolean).pop()!;
    const result = await this.electron.manifestGet(projectId);

    if (!result.success || !result.manifest) {
      // Fall through to the picker rather than blocking the user: it is what every
      // project used before this split existed, and it can open both formats.
      console.warn('[EditorWindow] Could not read manifest, using the picker:', result.error);
      this.sourceKind.set('pdf');
      return;
    }

    const manifest = result.manifest;
    const kind = manifest.source?.type ?? null;

    if (kind === 'epub') {
      // The document-flow editor reads the PRISTINE archived original — that is the
      // only copy that still carries the publisher's markup. exported.epub is a
      // derivative and would defeat the point.
      const original = (manifest.archive ?? []).find(
        (a: { role?: string; format?: string }) => a.role === 'original' && /epub/i.test(a.format ?? ''),
      );
      if (original?.path) {
        this.archiveEpubPath.set(`${projectDir}/${original.path}`);
        this.initialExcluded.set(manifest.source?.deletedBlockIds ?? []);
      } else {
        console.warn('[EditorWindow] EPUB project has no archived original; using the picker.');
      }
    }

    this.sourceKind.set(kind ?? 'pdf');
  }

  /**
   * The user accepted a set of blocks to exclude. Write source/exported.epub as the
   * original book minus exactly those elements, and record the selection so
   * reopening the editor restores it.
   */
  async onEpubSelectionAccepted(excludedIds: string[]): Promise<void> {
    const projectDir = this.projectPath();
    const epubPath = this.archiveEpubPath();
    if (!projectDir || !epubPath) return;

    const outputPath = `${projectDir}/source/exported.epub`;
    const result = await this.electron.exportEpubWithDeletedBlocks(epubPath, excludedIds, outputPath);

    if (!result.success) {
      this.showToast(result.error || 'Export failed', 'error');
      return;
    }

    const projectId = projectDir.split(/[\\/]/).filter(Boolean).pop()!;
    const saved = await this.electron.manifestUpdate({
      projectId,
      source: { deletedBlockIds: excludedIds },
    });
    if (!saved.success) {
      // The EPUB is on disk and correct; only the remembered selection failed. Say
      // so plainly rather than reporting a clean success.
      this.showToast(`Exported, but the selection could not be saved: ${saved.error}`, 'error');
      return;
    }

    this.onFinalized({ success: true, epubPath: outputPath });
  }

  /**
   * Handle finalization result from PdfPicker
   */
  onFinalized(result: { success: boolean; epubPath?: string; error?: string }): void {
    if (result.success) {
      this.showToast('Project finalized successfully!', 'success');
      // Close the window after a short delay so user sees the success message
      setTimeout(() => {
        window.close();
      }, 1500);
    } else {
      this.showToast(result.error || 'Finalization failed', 'error');
    }
  }

  /**
   * Handle exit request from PdfPicker
   */
  onExitRequested(): void {
    // Close the window
    window.close();
  }

  /**
   * Show a toast notification
   */
  private showToast(message: string, type: 'success' | 'error'): void {
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }

    this.toastMessage.set(message);
    this.toastType.set(type);

    this.toastTimeout = setTimeout(() => {
      this.toastMessage.set(null);
    }, 3000);
  }
}
