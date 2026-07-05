import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ReaderService } from '../../../../core/services/reader.service';

/**
 * ListenProfilePickerComponent — the "who's listening" control shown top-right of
 * the player. Picking a profile attributes listening + bookmarks to that reader
 * (via ReaderService → the in-process store); "Guest" keeps everything local.
 * Self-contained: it reads/writes ReaderService directly, so it can be dropped
 * (projected) into any player's top bar.
 */
@Component({
  selector: 'app-listen-profile-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="profile-bar">
      <button class="profile-btn" (click)="open.set(!open())" [title]="reader.active()?.name || 'Guest — not tracked'">
        @if (reader.active(); as r) {
          <span class="avatar">{{ initial(r.name) }}</span>
        } @else {
          <span class="avatar guest">👤</span>
        }
      </button>
      @if (open()) {
        <div class="backdrop" (click)="open.set(false)"></div>
        <div class="menu">
          <div class="menu-head">Who's listening?</div>
          @for (r of reader.readers(); track r.id) {
            <button class="menu-item" [class.active]="r.id === reader.activeId()" (click)="pick(r.id)">
              <span class="avatar sm">{{ initial(r.name) }}</span>
              <span class="menu-name">{{ r.name }}</span>
            </button>
          } @empty {
            <div class="menu-empty">No profiles yet — add one in the app.</div>
          }
          <button class="menu-item guest-row" [class.active]="!reader.activeId()" (click)="pick(null)">
            <span class="avatar sm guest">👤</span>
            <span class="menu-name">Guest <span class="menu-sub">not tracked</span></span>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    .profile-bar { position: relative; display: flex; align-items: center; }
    .profile-btn { width: 40px; height: 40px; border: none; background: transparent; padding: 0; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .avatar {
      width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
      background: var(--accent); color: #fff; font-size: 13px; font-weight: 700;
    }
    .avatar.guest { background: var(--bg-elevated); color: var(--text-secondary); font-size: 15px; }
    .avatar.sm { width: 26px; height: 26px; font-size: 12px; }
    .backdrop { position: fixed; inset: 0; z-index: 90; }
    .menu {
      position: absolute; top: calc(100% + 4px); right: 0; z-index: 91;
      min-width: 220px; max-height: 60vh; overflow-y: auto;
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: 12px; padding: 6px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
    }
    .menu-head { padding: 8px 10px 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
    .menu-empty { padding: 10px; font-size: 12px; color: var(--text-tertiary); }
    .menu-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 8px 10px; border: none; border-radius: 8px; background: transparent; color: var(--text-primary);
      cursor: pointer; text-align: left; font-size: 13px;
    }
    .menu-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .menu-item.active { background: color-mix(in srgb, var(--accent) 22%, transparent); }
    .guest-row { margin-top: 4px; border-top: 1px solid var(--border-subtle); border-radius: 0 0 8px 8px; }
    .menu-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .menu-sub { color: var(--text-tertiary); font-size: 11px; margin-left: 4px; }
  `],
})
export class ListenProfilePickerComponent {
  readonly reader = inject(ReaderService);
  readonly open = signal(false);

  initial(name: string): string {
    return (name.trim()[0] || '?').toUpperCase();
  }

  pick(id: string | null): void {
    this.open.set(false);
    this.reader.select(id);
  }
}
