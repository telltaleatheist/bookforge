import { Component, inject, input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';

export interface NavRailItem {
  id: string;
  icon: string;
  label: string;
  route: string;
  badge?: number;
}

@Component({
  selector: 'app-nav-rail',
  standalone: true,
  imports: [CommonModule],
  template: `
    <nav class="nav-rail">
      <div class="nav-items">
        @for (item of items(); track item.id) {
          <button
            class="nav-item"
            [class.active]="isActive(item.route)"
            [title]="item.label"
            (click)="navigate(item.route)"
          >
            <span class="nav-icon">{{ item.icon }}</span>
            <span class="nav-label">{{ item.label }}</span>
            @if (item.badge && item.badge > 0) {
              <span class="nav-badge">{{ item.badge > 99 ? '99+' : item.badge }}</span>
            }
          </button>
        }
      </div>
    </nav>
  `,
  styles: [`
    .nav-rail {
      width: 64px;
      min-width: 64px;
      height: 100%;
      background: var(--bg-elevated);
      border-right: 1px solid var(--border-default);
      display: flex;
      flex-direction: column;
      padding: 0.5rem 0;
      position: relative;
      z-index: 50;
    }

    .nav-items {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 0.25rem;
    }

    .nav-item {
      position: relative;
      width: 48px;
      height: 48px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      background: transparent;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      color: var(--text-secondary);
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: color-mix(in srgb, var(--accent-primary) 15%, transparent);
        color: var(--accent-primary);

        .nav-icon {
          transform: scale(1.1);
        }
      }
    }

    .nav-icon {
      font-size: 1.25rem;
      line-height: 1;
      transition: transform 0.15s ease;
    }

    .nav-label {
      font-size: 0.625rem;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.02em;
      opacity: 0.8;
      white-space: nowrap;
    }

    .nav-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      background: var(--accent-danger);
      color: white;
      font-size: 0.625rem;
      font-weight: 600;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
  `]
})
export class NavRailComponent {
  private readonly router = inject(Router);

  // Default navigation items
  readonly items = input<NavRailItem[]>([
    {
      id: 'library',
      icon: '\u{1F4DA}', // Books emoji
      label: 'Library',
      route: '/library'
    },
    {
      id: 'audiobook',
      icon: '\u{1F3A7}', // Headphones emoji
      label: 'Audio',
      route: '/audiobook'
    },
    {
      id: 'queue',
      icon: '\u{23F3}', // Hourglass emoji
      label: 'Queue',
      route: '/queue'
    }
  ]);

  // Track current route
  private readonly currentRoute = signal<string>('');

  constructor() {
    // Initialize with current route
    this.currentRoute.set(this.router.url);

    // Subscribe to route changes
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd)
    ).subscribe(event => {
      this.currentRoute.set(event.urlAfterRedirects);
    });
  }

  isActive(route: string): boolean {
    const current = this.currentRoute();
    // Check if current route starts with the nav item route
    return current === route || current.startsWith(route + '/');
  }

  navigate(route: string): void {
    this.router.navigate([route]);
  }
}
