import { Component, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { NoticeService } from '../../core/services/notice.service';

/**
 * The main window's notice stack: dismissible lines, pinned bottom-left, that
 * say what finished without stopping the user to acknowledge it.
 *
 * Deliberately the same shape and weight as the update toast on the other
 * corner — one visual language for "here is a fact", so a modal keeps meaning
 * "something needs you".
 */
@Component({
  selector: 'app-notice-banner',
  standalone: true,
  imports: [CommonModule],
  template: `
    @if (visible().length) {
      <div class="notice-stack" role="status" aria-live="polite">
        @for (notice of visible(); track notice.id) {
          <div class="notice-card">
            <span class="notice-text">{{ notice.text }}</span>
            <button
              class="notice-dismiss"
              type="button"
              aria-label="Dismiss"
              (click)="notices.dismiss(notice.id)"
            >Dismiss</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .notice-stack {
      position: fixed;
      left: 16px;
      bottom: 16px;
      z-index: 9400;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: 360px;
      max-width: calc(100vw - 32px);
      -webkit-app-region: no-drag;
    }

    .notice-card {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--bg-elevated, #1e1e1e);
      /* A REAL border, accent-toned: the card has to read as a notification
         against whatever is behind it, not as furniture (Owen, 2026-08-10:
         "give them a border so theyre more obvious"). */
      border: 1.5px solid var(--accent, #ff6b35);
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
      color: var(--text-primary, #f0f0f0);
      font-size: 13px;
      line-height: 1.45;
    }

    .notice-text { flex: 1; color: var(--text-secondary, #c8c8c8); }

    .notice-dismiss {
      flex: none;
      border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.18));
      background: transparent;
      color: var(--text-tertiary, #888);
      font-size: 12px;
      padding: 3px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .notice-dismiss:hover { color: var(--text-primary, #f0f0f0); }
  `]
})
export class NoticeBannerComponent {
  readonly notices = inject(NoticeService);

  /** Newest on top: the thing that just happened should be the thing read first. */
  readonly visible = computed(() => [...this.notices.notices()].reverse());
}
