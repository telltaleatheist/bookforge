import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { PdfPickerComponent } from '../../../pdf-picker/pdf-picker.component';

/**
 * EditorWindow - Standalone editor window for PDF/EPUB editing
 *
 * This component is loaded in a separate Electron window and provides
 * the full PdfPicker experience for editing a project. When the user
 * clicks Finalize, the EPUB is saved to the project folder.
 *
 * Receives project path via query param: /editor?project=<encoded-path>
 */
@Component({
  selector: 'app-editor-window',
  standalone: true,
  imports: [CommonModule, PdfPickerComponent],
  template: `
    <div class="editor-window">
      @if (projectPath()) {
        <app-pdf-picker
          [embedded]="true"
          [bfpPath]="projectPath()!"
          [overrideSourcePath]="sourcePath()"
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

    app-pdf-picker {
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

  readonly projectPath = signal<string | null>(null);
  readonly sourcePath = signal<string | null>(null);  // Optional: specific version to load
  readonly error = signal<string | null>(null);
  readonly toastMessage = signal<string | null>(null);
  readonly toastType = signal<'success' | 'error'>('success');
  private toastTimeout: ReturnType<typeof setTimeout> | null = null;

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
      } else {
        this.error.set('No project path provided');
      }
    });
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
