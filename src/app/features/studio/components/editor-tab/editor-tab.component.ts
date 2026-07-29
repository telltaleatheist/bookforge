import { Component, input, output, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../../../core/services/electron.service';
import { StudioItem } from '../../models/studio.types';
import { PdfPickerComponent } from '../../../pdf-picker/pdf-picker.component';
import { EpubFlowComponent } from '../../../pdf-picker/components/epub-flow/epub-flow.component';
import { EditorRouteService } from '../../services/editor-route.service';

/**
 * EditorTab - Source document editor tab for Studio
 *
 * Books get one of two editors, chosen by EditorRouteService from
 * `manifest.source.type`:
 *  - **PDF** → the embedded PdfPicker (page images, blocks, chapters)
 *  - **EPUB** → the document-flow editor, which reads the book's own elements so
 *    export can preserve its markup
 *
 * This tab and the standalone editor window MUST agree on that choice, which is
 * why it lives in the service. When the EPUB editor was first added only the
 * window learned about it, so opening a book from this tab silently kept the old
 * picker — hence the shared route.
 */
@Component({
  selector: 'app-editor-tab',
  standalone: true,
  imports: [CommonModule, PdfPickerComponent, EpubFlowComponent],
  template: `
    <div class="editor-tab">
      @if (routeError()) {
        <div class="editor-placeholder">
          <p>Unable to open this project's editor.</p>
          <p>{{ routeError() }}</p>
        </div>
      } @else if (item() && item()!.type === 'book' && epubFlowPath()) {
        <app-epub-flow
          [epubPath]="epubFlowPath()!"
          [initialExcluded]="initialExcluded()"
          (selectionAccepted)="onEpubSelectionAccepted($event)"
        />
      } @else if (item() && item()!.type === 'book' && getEditorPath() && resolved()) {
        <!-- Embedded PdfPicker for books -->
        <app-pdf-picker
          [embedded]="true"
          [bfpPath]="getEditorPath()!"
          (finalized)="onFinalized($event)"
          (exitRequested)="onExitRequested()"
        />
      } @else if (item() && item()!.type === 'book' && !resolved()) {
        <div class="editor-placeholder"><p>Opening editor…</p></div>
      } @else if (item() && item()!.type === 'book') {
        <!-- Book without any path - show message -->
        <div class="editor-placeholder">
          <p>No source file found for this book.</p>
          <p>The book needs a PDF or EPUB source file to edit.</p>
        </div>
      } @else {
        <!-- Non-book item -->
        <div class="editor-placeholder">
          <p>Editor is only available for books (PDF/EPUB sources).</p>
          <p>Select a book from the list to edit its source document.</p>
        </div>
      }
    </div>

    <!-- Toast notification -->
    @if (toastMessage()) {
      <div class="toast" [class]="'toast-' + toastType()">
        {{ toastMessage() }}
      </div>
    }
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
    }

    .editor-tab {
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    app-pdf-picker,
    app-epub-flow {
      flex: 1;
      min-height: 0;
    }

    .editor-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      color: var(--text-secondary);
      gap: 0.5rem;

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
export class EditorTabComponent {
  private readonly electronService = inject(ElectronService);
  private readonly editorRoute = inject(EditorRouteService);

  /** The selected studio item */
  readonly item = input<StudioItem | null>(null);

  /** Emitted when the editor makes changes (e.g., finalize completes) */
  readonly changed = output<void>();

  // Toast state
  readonly toastMessage = signal<string | null>(null);
  readonly toastType = signal<'success' | 'error'>('success');
  private toastTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Null until the route is known — neither editor renders before then. */
  readonly resolved = signal(false);
  readonly epubFlowPath = signal<string | null>(null);
  readonly initialExcluded = signal<string[]>([]);
  readonly routeError = signal<string | null>(null);
  /** Resolved by the main process, not assembled from the item's fields. */
  readonly resolvedProjectDir = signal<string | null>(null);

  constructor() {
    // The selected item changes as the user clicks around the library, so the
    // route has to be recomputed per item, not once on construction.
    effect(() => {
      const item = this.item();
      this.resolved.set(false);
      this.epubFlowPath.set(null);
      this.initialExcluded.set([]);
      this.routeError.set(null);
      this.resolvedProjectDir.set(null);

      // Either is a valid thing to point the editor at — the main process works
      // out which, so a book with no bfpPath still routes from its source file.
      const target = item?.bfpPath || item?.epubPath;
      if (!item || item.type !== 'book' || !target) {
        this.resolved.set(true);
        return;
      }

      void this.editorRoute.resolve(target).then((route) => {
        if (route.kind === 'error') {
          this.routeError.set(route.message);
        } else if (route.kind === 'epub-flow') {
          this.epubFlowPath.set(route.epubPath);
          this.initialExcluded.set(route.excluded);
          this.resolvedProjectDir.set(route.projectDir);
        }
        this.resolved.set(true);
      });
    });
  }

  /**
   * The user saved a set of blocks to exclude. Write source/exported.epub as the
   * original minus exactly those elements, and record the selection.
   */
  async onEpubSelectionAccepted(excludedIds: string[]): Promise<void> {
    const projectDir = this.resolvedProjectDir();
    const epubPath = this.epubFlowPath();
    if (!projectDir || !epubPath) return;

    const result = await this.editorRoute.applySelection(projectDir, epubPath, excludedIds);
    if (!result.success) {
      this.showToast(result.error || 'Export failed', 'error');
      return;
    }
    this.showToast('Exported to exported.epub', 'success');
    this.changed.emit();
  }

  /**
   * Get the path to use for the editor.
   * Prefers bfpPath (existing project), falls back to epubPath (source file).
   */
  getEditorPath(): string | null {
    const item = this.item();
    if (!item) return null;

    // Prefer BFP project file if available
    if (item.bfpPath) {
      return item.bfpPath;
    }

    // Fall back to source EPUB/PDF path
    if (item.epubPath) {
      return item.epubPath;
    }

    return null;
  }

  /**
   * Handle finalization result from PdfPicker
   */
  onFinalized(result: { success: boolean; epubPath?: string; error?: string }): void {
    if (result.success) {
      this.showToast('Project finalized successfully!', 'success');
      this.changed.emit();
    } else {
      this.showToast(result.error || 'Finalization failed', 'error');
    }
  }

  /**
   * Handle exit request from embedded PdfPicker
   */
  onExitRequested(): void {
    // In embedded mode, we don't navigate away - just emit changed
    // The parent can decide what to do
    this.changed.emit();
  }

  /**
   * Show in Finder
   */
  async showInFinder(): Promise<void> {
    const item = this.item();
    if (!item?.bfpPath) return;

    await this.electronService.showInFolder(item.bfpPath);
  }

  /**
   * Show a toast notification
   */
  private showToast(message: string, type: 'success' | 'error'): void {
    // Clear existing timeout
    if (this.toastTimeout) {
      clearTimeout(this.toastTimeout);
    }

    this.toastMessage.set(message);
    this.toastType.set(type);

    // Auto-hide after 3 seconds
    this.toastTimeout = setTimeout(() => {
      this.toastMessage.set(null);
    }, 3000);
  }
}
