/**
 * Confirm Modal - Reusable confirmation dialog for delete/destructive actions
 */

import { Component, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (show()) {
      <div class="modal-backdrop" (click)="onCancel()">
        <div class="modal-window" (click)="$event.stopPropagation()">
          <!-- Close button -->
          <button class="close-btn" (click)="onCancel()" title="Close">
            <span>&#10005;</span>
          </button>

          <!-- Icon -->
          <div class="modal-icon" [class.danger]="variant() === 'danger'">
            @if (variant() === 'danger') {
              <span class="icon-text">&#9888;</span>
            } @else {
              <span class="icon-text">?</span>
            }
          </div>

          <!-- Content -->
          <div class="modal-content">
            <h3>{{ title() }}</h3>
            <p>{{ message() }}</p>
          </div>

          <!-- Actions -->
          <div class="modal-actions">
            <button
              class="btn btn-cancel"
              (click)="onCancel()"
            >
              {{ cancelText() }}
            </button>
            <button
              class="btn"
              [class.btn-danger]="variant() === 'danger'"
              [class.btn-primary]="variant() !== 'danger'"
              (click)="onConfirm()"
            >
              {{ confirmText() }}
            </button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
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
      width: 340px;
      background: var(--bg-elevated, #1a1a1a);
      border: 1px solid var(--border-default, #333);
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
      animation: slideUp 0.2s ease-out;
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
      color: var(--text-muted, #666);
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover, #333);
        color: var(--text-primary, #fff);
      }
    }

    .modal-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px 24px 12px;

      .icon-text {
        width: 48px;
        height: 48px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        font-size: 24px;
        background: var(--bg-muted, #2a2a2a);
        color: var(--text-secondary, #999);
      }

      &.danger .icon-text {
        background: color-mix(in srgb, var(--status-error, #ef4444) 15%, transparent);
        color: var(--status-error, #ef4444);
      }
    }

    .modal-content {
      padding: 0 24px 20px;
      text-align: center;

      h3 {
        margin: 0 0 8px 0;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary, #fff);
      }

      p {
        margin: 0;
        font-size: 13px;
        line-height: 1.5;
        color: var(--text-secondary, #999);
      }
    }

    .modal-actions {
      display: flex;
      gap: 12px;
      padding: 0 24px 24px;
    }

    .btn {
      flex: 1;
      padding: 10px 16px;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;

      &:hover {
        filter: brightness(1.1);
      }

      &:active {
        transform: scale(0.98);
      }
    }

    .btn-cancel {
      background: var(--bg-muted, #2a2a2a);
      color: var(--text-primary, #fff);
      border: 1px solid var(--border-default, #333);

      &:hover {
        background: var(--bg-hover, #333);
        filter: none;
      }
    }

    .btn-primary {
      background: var(--accent, #3b82f6);
      color: white;
    }

    .btn-danger {
      background: var(--status-error, #ef4444);
      color: white;
    }
  `]
})
export class ConfirmModalComponent {
  // Inputs
  readonly show = input<boolean>(false);
  readonly title = input<string>('Confirm');
  readonly message = input<string>('Are you sure?');
  readonly confirmText = input<string>('Confirm');
  readonly cancelText = input<string>('Cancel');
  readonly variant = input<'default' | 'danger'>('default');

  // Outputs
  readonly confirm = output<void>();
  readonly cancel = output<void>();

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancel.emit();
  }
}
