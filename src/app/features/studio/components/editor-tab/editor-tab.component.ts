import { Component, input, output, inject, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../../../core/services/electron.service';
import { StudioItem } from '../../models/studio.types';
import { PdfPickerComponent } from '../../../pdf-picker/pdf-picker.component';
import { EditorRouteService } from '../../services/editor-route.service';

/**
 * EditorTab - Source document editor tab for Studio
 *
 * All books open in the embedded PdfPicker; EditorRouteService decides which
 * FILE it points at. EPUB projects open their archived original
 * (`archive/<Book>.epub`, via `overrideSourcePath`) so export can preserve the
 * book's own markup — see the service doc for why.
 *
 * This tab and the standalone editor window MUST agree on that choice, which is
 * why it lives in the service. When a routing change once landed only in the
 * window, opening a book from this tab silently behaved differently — hence the
 * shared route.
 */
@Component({
  selector: 'app-editor-tab',
  standalone: true,
  imports: [CommonModule, PdfPickerComponent],
  template: `
    <div class="editor-tab">
      @if (routeError()) {
        <div class="editor-placeholder">
          <p>Unable to open this project's editor.</p>
          <p>{{ routeError() }}</p>
        </div>
      } @else if (item() && item()!.type === 'book' && getEditorPath() && resolved()) {
        <!-- Embedded PdfPicker for books -->
        <app-pdf-picker
          [embedded]="true"
          [bfpPath]="getEditorPath()!"
          [overrideSourcePath]="epubArchivePath()"
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

    app-pdf-picker {
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

  /** Null until the route is known — the picker does not render before then. */
  readonly resolved = signal(false);
  /** Archived original EPUB the picker should open, resolved by the main process. */
  readonly epubArchivePath = signal<string | null>(null);
  readonly routeError = signal<string | null>(null);

  constructor() {
    // The selected item changes as the user clicks around the library, so the
    // route has to be recomputed per item, not once on construction.
    effect(() => {
      const item = this.item();
      this.resolved.set(false);
      this.epubArchivePath.set(null);
      this.routeError.set(null);

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
        } else {
          this.epubArchivePath.set(route.epubArchivePath);
        }
        this.resolved.set(true);
      });
    });
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
