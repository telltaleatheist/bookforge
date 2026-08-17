/**
 * The bottom-right toast stack.
 *
 * Mounted once in the shell, so it is present in every window — which one
 * actually SPEAKS is decided by `shouldAnnounceHere()` where the toast is
 * raised, not here.
 *
 * The download dock also lives bottom-right (`app-setup-download-dock`), so the
 * stack sits above it rather than on top of it: toasts are transient and the
 * dock is not, and covering a running download with news about a finished run
 * would hide the thing still happening.
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';

import { Toast, ToastService } from '../../core/services/toast.service';

@Component({
  selector: 'app-toast-host',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (toasts.toasts().length > 0) {
      <div class="toast-stack" role="status" aria-live="polite">
        @for (toast of toasts.toasts(); track toast.id) {
          <div
            class="toast"
            [class.failure]="toast.tone === 'failure'"
            [class.clickable]="!!toast.action"
            [attr.role]="toast.action ? 'button' : null"
            [attr.tabindex]="toast.action ? 0 : null"
            (click)="activate(toast)"
            (keydown.enter)="activate(toast)"
            (keydown.space)="activate(toast); $event.preventDefault()"
          >
            @if (toast.cover) {
              <img class="toast-cover" [src]="toast.cover" alt="" />
            } @else {
              <span class="toast-cover toast-cover-blank" aria-hidden="true"></span>
            }

            <div class="toast-body">
              <div class="toast-kicker">{{ toast.kicker }}</div>
              <div class="toast-title">{{ toast.title }}</div>
              <div class="toast-meta">{{ toast.meta }}</div>
            </div>

            <button
              type="button"
              class="toast-close"
              aria-label="Dismiss"
              (click)="dismiss($event, toast.id)"
            >×</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .toast-stack {
      position: fixed;
      right: 16px;
      /* Clear of the download dock, which owns the very bottom-right corner. */
      bottom: 96px;
      z-index: 9500;
      display: flex;
      flex-direction: column;
      gap: 10px;
      align-items: flex-end;
      pointer-events: none;
    }

    .toast {
      pointer-events: auto;
      display: flex;
      gap: 10px;
      align-items: flex-start;
      width: 340px;
      padding: 10px 12px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-left: 3px solid var(--success);
      border-radius: 10px;
      box-shadow: var(--shadow-lg);
      color: var(--text-primary);
      animation: toast-in 180ms ease-out;
    }

    .toast.failure {
      border-left-color: var(--color-danger);
    }

    .toast.clickable {
      cursor: pointer;
    }

    .toast.clickable:hover {
      border-color: var(--border-strong);
    }

    .toast.clickable:focus-visible {
      outline: none;
      box-shadow: var(--focus-ring), var(--shadow-lg);
    }

    @keyframes toast-in {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: none; }
    }

    @media (prefers-reduced-motion: reduce) {
      .toast { animation: none; }
    }

    .toast-cover {
      flex: none;
      width: 34px;
      height: 50px;
      border-radius: 4px;
      object-fit: cover;
      background: var(--bg-input);
    }

    .toast-cover-blank {
      display: block;
      border: 1px solid var(--border-subtle);
    }

    .toast-body {
      flex: 1;
      min-width: 0;
    }

    .toast-kicker {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.8px;
      text-transform: uppercase;
      color: var(--success);
    }

    .toast.failure .toast-kicker {
      color: var(--color-danger);
    }

    .toast-title {
      margin: 2px 0;
      font-size: 12.5px;
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toast-meta {
      font-size: 11px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .toast-close {
      flex: none;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
    }

    .toast-close:hover {
      background: var(--hover-bg);
      color: var(--text-primary);
    }
  `],
})
export class ToastHostComponent {
  readonly toasts = inject(ToastService);

  activate(toast: Toast): void {
    if (!toast.action) return;
    toast.action.run();
    this.toasts.dismiss(toast.id);
  }

  dismiss(event: Event, id: number): void {
    event.stopPropagation();
    this.toasts.dismiss(id);
  }
}
