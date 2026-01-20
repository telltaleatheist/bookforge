/**
 * Queue Success Modal - Shared modal shown after adding a job to the queue
 * Used by both AI Cleanup and TTS Settings components
 * Styled to match Creamsicle design system
 */

import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';

@Component({
  selector: 'app-queue-success-modal',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  template: `
    @if (show()) {
      <div class="modal-backdrop" (click)="onContinue()">
        <div class="modal-window" (click)="$event.stopPropagation()">
          <!-- Close button -->
          <button class="close-btn" (click)="onContinue()" title="Close">
            <span>&#10005;</span>
          </button>

          <!-- Icon -->
          <div class="modal-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>

          <!-- Content -->
          <div class="modal-content">
            <h3>{{ title() }}</h3>
            <p>{{ message() }}</p>
          </div>

          <!-- Actions -->
          <div class="modal-actions">
            <desktop-button variant="primary" [fullWidth]="true" (click)="onViewQueue()">
              View Queue
            </desktop-button>
            <desktop-button variant="ghost" [fullWidth]="true" (click)="onContinue()">
              Continue Editing
            </desktop-button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(24, 23, 21, 0.6);
      backdrop-filter: blur(4px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 400;
      animation: fadeIn 0.15s cubic-bezier(0, 0, 0.2, 1);
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(12px) scale(0.98);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .modal-window {
      position: relative;
      width: 320px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 12px;
      box-shadow:
        0 0 0 1px rgba(24, 23, 21, 0.05),
        0 4px 16px rgba(24, 23, 21, 0.12),
        0 12px 40px rgba(24, 23, 21, 0.1);
      animation: slideUp 0.2s cubic-bezier(0, 0, 0.2, 1);
      overflow: hidden;
    }

    .close-btn {
      position: absolute;
      top: 10px;
      right: 10px;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--text-tertiary);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.1s cubic-bezier(0, 0, 0.2, 1);

      &:hover {
        background: var(--hover-bg);
        color: var(--text-primary);
      }

      &:active {
        background: var(--active-bg);
      }
    }

    .modal-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 24px 12px;

      svg {
        width: 48px;
        height: 48px;
        padding: 10px;
        border-radius: 50%;
        background: color-mix(in srgb, var(--success) 12%, transparent);
        color: var(--success);
      }
    }

    .modal-content {
      padding: 0 24px 20px;
      text-align: center;

      h3 {
        margin: 0 0 6px 0;
        font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 16px;
        font-weight: 600;
        line-height: 1.2;
        letter-spacing: -0.025em;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        font-size: 13px;
        font-weight: 400;
        line-height: 1.5;
        color: var(--text-secondary);
      }
    }

    .modal-actions {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 0 24px 24px;
    }
  `]
})
export class QueueSuccessModalComponent {
  // Inputs
  readonly show = input<boolean>(false);
  readonly title = input<string>('Added to Queue');
  readonly message = input<string>('Your job has been added to the processing queue.');

  // Outputs
  readonly close = output<void>();
  readonly viewQueue = output<void>();

  onViewQueue(): void {
    this.viewQueue.emit();
  }

  onContinue(): void {
    this.close.emit();
  }
}
