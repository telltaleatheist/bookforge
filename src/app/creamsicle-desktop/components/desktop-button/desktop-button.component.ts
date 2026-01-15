import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

export type DesktopButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type DesktopButtonSize = 'xs' | 'sm' | 'md' | 'lg';

@Component({
  selector: 'desktop-button',
  standalone: true,
  imports: [CommonModule],
  template: `
    <button
      [type]="type"
      [disabled]="disabled || loading"
      [class]="'btn btn-' + variant + ' btn-' + size"
      [class.icon-only]="iconOnly"
      [class.loading]="loading"
      [class.full-width]="fullWidth"
    >
      @if (loading) {
        <span class="spinner"></span>
      } @else {
        @if (icon) {
          <span class="btn-icon">{{ icon }}</span>
        }
        @if (!iconOnly) {
          <span class="btn-label">
            <ng-content></ng-content>
          </span>
        }
        @if (iconRight) {
          <span class="btn-icon-right">{{ iconRight }}</span>
        }
      }
    </button>
  `,
  styles: [`
    @use 'sass:color';
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    :host {
      display: inline-flex;
    }

    .btn {
      @include button-base;
      gap: $spacing-1-5;
      font-family: $font-body;
      position: relative;
      overflow: hidden;

      // Subtle gradient overlay for depth
      &::before {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, rgba(255,255,255,0.08) 0%, transparent 50%);
        pointer-events: none;
        opacity: 0;
        transition: opacity $duration-fast $ease-out;
      }

      &:hover::before {
        opacity: 1;
      }

      // =====================================================================
      // SIZES
      // =====================================================================

      &.btn-xs {
        height: 22px;
        padding: 0 $spacing-2;
        font-size: $font-size-xs;
        border-radius: $radius-sm;
        gap: $spacing-1;

        &.icon-only {
          width: 22px;
          padding: 0;
        }
      }

      &.btn-sm {
        height: 26px;
        padding: 0 $spacing-2-5;
        font-size: $font-size-sm;
        border-radius: $radius-sm;

        &.icon-only {
          width: 26px;
          padding: 0;
        }
      }

      &.btn-md {
        height: 32px;
        padding: 0 $spacing-3;
        font-size: $font-size-base;
        border-radius: $radius-md;

        &.icon-only {
          width: 32px;
          padding: 0;
        }
      }

      &.btn-lg {
        height: 40px;
        padding: 0 $spacing-5;
        font-size: $font-size-md;
        border-radius: $radius-md;
        gap: $spacing-2;

        &.icon-only {
          width: 40px;
          padding: 0;
        }
      }

      // =====================================================================
      // VARIANTS
      // =====================================================================

      &.btn-primary {
        background: var(--accent);
        color: $white;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);

        &:hover:not(:disabled) {
          background: var(--accent-hover);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.1);
        }

        &:active:not(:disabled) {
          background: var(--accent-active);
          transform: scale(0.98);
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.2);
        }

        &:focus-visible {
          box-shadow: var(--focus-ring), 0 1px 2px rgba(0, 0, 0, 0.1);
        }
      }

      &.btn-secondary {
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        color: var(--text-primary);

        &:hover:not(:disabled) {
          background: var(--hover-bg);
          border-color: var(--border-strong);
        }

        &:active:not(:disabled) {
          background: var(--active-bg);
          transform: scale(0.98);
        }

        &:focus-visible {
          box-shadow: var(--focus-ring);
        }
      }

      &.btn-ghost {
        background: transparent;
        color: var(--text-primary);

        &:hover:not(:disabled) {
          background: var(--hover-bg);
        }

        &:active:not(:disabled) {
          background: var(--active-bg);
          transform: scale(0.98);
        }

        &:focus-visible {
          box-shadow: var(--focus-ring);
        }

        &::before {
          display: none;
        }
      }

      &.btn-danger {
        background: var(--error);
        color: $white;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);

        &:hover:not(:disabled) {
          background: #{$error-600};
        }

        &:active:not(:disabled) {
          background: color.adjust($error-600, $lightness: -8%);
          transform: scale(0.98);
        }

        &:focus-visible {
          box-shadow: var(--focus-ring-error);
        }
      }

      &.btn-success {
        background: var(--success);
        color: $white;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);

        &:hover:not(:disabled) {
          background: #{$success-600};
        }

        &:active:not(:disabled) {
          background: color.adjust($success-600, $lightness: -8%);
          transform: scale(0.98);
        }

        &:focus-visible {
          box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.4);
        }
      }

      // =====================================================================
      // STATES
      // =====================================================================

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        transform: none !important;
      }

      &.loading {
        pointer-events: none;
      }

      &.full-width {
        width: 100%;
      }
    }

    // =====================================================================
    // INTERNAL ELEMENTS
    // =====================================================================

    .btn-icon,
    .btn-icon-right {
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.1em;
      line-height: 1;
      flex-shrink: 0;
    }

    .btn-label {
      @include truncate;
    }

    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid currentColor;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `]
})
export class DesktopButtonComponent {
  @Input() variant: DesktopButtonVariant = 'secondary';
  @Input() size: DesktopButtonSize = 'md';
  @Input() type: 'button' | 'submit' | 'reset' = 'button';
  @Input() icon?: string;
  @Input() iconRight?: string;
  @Input() iconOnly = false;
  @Input() disabled = false;
  @Input() loading = false;
  @Input() fullWidth = false;
}
