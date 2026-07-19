import {
  Component,
  Input,
  Output,
  EventEmitter,
  HostListener,
  ChangeDetectionStrategy,
  AfterViewInit,
  ViewChild,
  ElementRef,
} from '@angular/core';
import { CommonModule } from '@angular/common';

export type DesktopDialogType = 'none' | 'info' | 'success' | 'warning' | 'error' | 'question';

/**
 * Creamsicle-styled modal dialog used by {@link DialogService} to replace the
 * native JS `alert()` / `confirm()` pop-ups. Presentational only — the service
 * wires inputs/outputs and mounts it on the DOM.
 */
@Component({
  selector: 'desktop-dialog',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="dlg-backdrop" (click)="onCancel()"></div>
    <div
      class="dlg"
      role="dialog"
      aria-modal="true"
      [attr.aria-label]="title"
      (click)="$event.stopPropagation()"
    >
      <div class="dlg-body">
        @if (type !== 'none') {
          <div class="dlg-icon" [class]="'icon-' + type" aria-hidden="true">
            @switch (type) {
              @case ('success') {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              }
              @case ('error') {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              }
              @case ('warning') {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              }
              @default {
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
              }
            }
          </div>
        }
        <div class="dlg-text">
          @if (title) {
            <h2 class="dlg-title">{{ title }}</h2>
          }
          <p class="dlg-message">{{ message }}</p>
          @if (detail) {
            <p class="dlg-detail">{{ detail }}</p>
          }
          @if (showInput) {
            <input
              #inputEl
              type="text"
              class="dlg-input"
              [value]="inputValue"
              [placeholder]="inputPlaceholder"
              (input)="inputValue = $any($event.target).value"
            />
          }
          @if (showCheckbox) {
            <label class="dlg-checkbox">
              <input
                type="checkbox"
                [checked]="checkboxChecked"
                (change)="checkboxChecked = $any($event.target).checked"
              />
              <span>{{ checkboxLabel }}</span>
            </label>
          }
        </div>
      </div>

      <div class="dlg-actions">
        @if (showCancel) {
          <button type="button" class="dlg-btn dlg-btn-secondary" (click)="onCancel()">
            {{ cancelLabel }}
          </button>
        }
        <button
          type="button"
          class="dlg-btn"
          [class.dlg-btn-danger]="type === 'error' || type === 'warning'"
          [class.dlg-btn-primary]="type !== 'error' && type !== 'warning'"
          (click)="onConfirm()"
          #confirmBtn
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    @use '../../styles/variables' as *;
    @use '../../styles/mixins' as *;

    :host {
      position: fixed;
      inset: 0;
      z-index: $z-modal;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .dlg-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur($blur-sm);
      -webkit-backdrop-filter: blur($blur-sm);
      animation: fadeIn 0.12s $ease-out;
    }

    .dlg {
      position: relative;
      width: 100%;
      max-width: 420px;
      margin: $spacing-4;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: $radius-xl;
      box-shadow:
        0 10px 15px -3px rgba(0, 0, 0, 0.2),
        0 20px 40px -10px rgba(0, 0, 0, 0.35);
      animation: scaleIn 0.14s $ease-bounce;
      overflow: hidden;
    }

    .dlg-body {
      display: flex;
      gap: $spacing-3;
      padding: $spacing-5 $spacing-5 $spacing-4;
    }

    .dlg-icon {
      flex-shrink: 0;
      width: 40px;
      height: 40px;
      border-radius: $radius-full;
      @include flex-center;

      svg { width: 22px; height: 22px; }

      &.icon-info { background: rgba(59, 130, 246, 0.12); color: var(--info); }
      &.icon-success { background: rgba(34, 197, 94, 0.12); color: var(--success); }
      &.icon-warning { background: rgba(245, 158, 11, 0.14); color: var(--warning); }
      &.icon-error { background: rgba(239, 68, 68, 0.12); color: var(--error); }
      &.icon-question { background: var(--accent-subtle, rgba(255,107,53,0.12)); color: var(--accent); }
    }

    .dlg-text { min-width: 0; flex: 1; }

    .dlg-title {
      @include text-heading;
      font-size: $font-size-lg;
      color: var(--text-primary);
      margin: 0 0 $spacing-1;
    }

    .dlg-message {
      @include text-body;
      color: var(--text-primary);
      margin: 0;
      white-space: pre-wrap;
    }

    .dlg-detail {
      @include text-body;
      font-size: $font-size-sm;
      color: var(--text-secondary);
      margin: $spacing-2 0 0;
      white-space: pre-wrap;
    }

    .dlg-input {
      width: 100%;
      margin-top: $spacing-3;
      height: 34px;
      padding: 0 $spacing-3;
      font-family: $font-body;
      font-size: $font-size-base;
      color: var(--text-primary);
      background: var(--bg-input, var(--bg-surface));
      border: 1px solid var(--border-input, var(--border-default));
      border-radius: $radius-md;
      transition: border-color $duration-fast $ease-out, box-shadow $duration-fast $ease-out;

      &::placeholder { color: var(--text-muted); }

      &:focus {
        outline: none;
        border-color: var(--accent);
        box-shadow: var(--focus-ring);
      }
    }

    .dlg-checkbox {
      display: flex;
      align-items: center;
      gap: $spacing-2;
      margin-top: $spacing-3;
      cursor: pointer;
      @include text-body;
      font-size: $font-size-sm;
      color: var(--text-secondary);

      input[type="checkbox"] { cursor: pointer; margin: 0; }
    }

    .dlg-actions {
      display: flex;
      justify-content: flex-end;
      gap: $spacing-2;
      padding: $spacing-3 $spacing-5 $spacing-5;
    }

    .dlg-btn {
      @include button-base;
      @include focus-ring;
      height: 32px;
      padding: 0 $spacing-4;
      font-size: $font-size-base;

      &.dlg-btn-primary {
        background: var(--accent);
        color: $white;
        &:hover { background: var(--accent-hover); }
        &:active { background: var(--accent-active); transform: scale(0.98); }
      }

      &.dlg-btn-danger {
        background: var(--error);
        color: $white;
        &:hover { background: #{$error-600}; }
        &:active { transform: scale(0.98); }
      }

      &.dlg-btn-secondary {
        background: var(--bg-surface);
        border: 1px solid var(--border-default);
        color: var(--text-primary);
        &:hover { background: var(--hover-bg); border-color: var(--border-strong); }
        &:active { background: var(--active-bg); transform: scale(0.98); }
      }
    }

    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes scaleIn {
      from { opacity: 0; transform: scale(0.94); }
      to { opacity: 1; transform: scale(1); }
    }
  `],
})
export class DesktopDialogComponent implements AfterViewInit {
  @Input() title = '';
  @Input() message = '';
  @Input() detail?: string;
  @Input() type: DesktopDialogType = 'info';
  @Input() confirmLabel = 'OK';
  @Input() cancelLabel = 'Cancel';
  @Input() showCancel = false;

  /** When true, renders a single-line text field; its value is read back via
   *  {@link inputValue} (used by DialogService.prompt). */
  @Input() showInput = false;
  @Input() inputValue = '';
  @Input() inputPlaceholder = '';

  /** When true, renders a checkbox below the message; its state is read back via
   *  {@link checkboxChecked} (used by DialogService.confirmWithCheckbox). */
  @Input() showCheckbox = false;
  @Input() checkboxLabel = '';
  @Input() checkboxChecked = false;

  @Output() confirm = new EventEmitter<void>();
  @Output() cancel = new EventEmitter<void>();

  @ViewChild('inputEl') inputEl?: ElementRef<HTMLInputElement>;

  ngAfterViewInit(): void {
    // Focus + select the prompt field so the user can type/overwrite immediately.
    if (this.showInput && this.inputEl) {
      const el = this.inputEl.nativeElement;
      el.focus();
      el.select();
    }
  }

  onConfirm(): void {
    this.confirm.emit();
  }

  onCancel(): void {
    this.cancel.emit();
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    // Escape resolves as a cancel (or a dismiss for plain alerts).
    this.cancel.emit();
  }

  @HostListener('document:keydown.enter')
  onEnter(): void {
    this.confirm.emit();
  }
}
