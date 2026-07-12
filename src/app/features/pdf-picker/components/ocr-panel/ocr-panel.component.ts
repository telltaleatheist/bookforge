import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';
import { TaskStatus } from '../../tasks/task.model';

/**
 * OCR task panel. Replaces the old fake `ocr` editor mode that only opened a
 * modal: OCR is now a first-class panel showing factual status. The actual
 * settings + run flow still lives in the existing ocr-settings-modal, opened
 * via (openSettings).
 */
@Component({
  selector: 'app-ocr-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent, PanelShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell
      title="OCR text"
      [statusLine]="status().detail"
      (close)="close.emit()"
    >
      <div class="ocr-body">
        @if (jobRunning()) {
          <div class="ocr-note running">
            <span class="ocr-spinner"></span>
            OCR is running — new text blocks appear as pages finish.
          </div>
        } @else if (pagesWithoutText() > 0) {
          <div class="ocr-note">
            {{ pagesWithoutText() }} {{ pagesWithoutText() === 1 ? 'page has' : 'pages have' }} no
            recognized text. Run OCR to extract text from scanned pages.
          </div>
        } @else {
          <div class="ocr-note">
            Extract text from scanned pages. Every page already has recognized text.
          </div>
        }
      </div>

      <div footer>
        <desktop-button
          variant="primary"
          size="sm"
          [disabled]="jobRunning()"
          (click)="openSettings.emit()"
        >
          Run OCR…
        </desktop-button>
      </div>
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    .ocr-body {
      display: flex;
      flex-direction: column;
      gap: var(--ui-spacing-md);
    }

    .ocr-note {
      font-size: var(--ui-font-sm);
      color: var(--text-secondary);
      line-height: 1.5;
    }

    .ocr-note.running {
      display: flex;
      align-items: center;
      gap: var(--ui-spacing-sm);
      color: var(--text-primary);
    }

    .ocr-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-strong);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: ocr-spin 0.8s linear infinite;
      flex-shrink: 0;
    }

    @keyframes ocr-spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class OcrPanelComponent {
  readonly status = input.required<TaskStatus>();
  readonly pagesWithoutText = input.required<number>();
  readonly jobRunning = input.required<boolean>();

  readonly close = output<void>();
  readonly openSettings = output<void>();
}
