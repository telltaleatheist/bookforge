import { Component, inject, input, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, NavigationEnd } from '@angular/router';
import { filter } from 'rxjs/operators';
import { TtsServerService } from '../../core/services/tts-server.service';
import { BookshelfServerService } from '../../core/services/bookshelf-server.service';
import { DesktopThemeService } from '../../creamsicle-desktop/services/theme.service';

// Global log capture
const capturedLogs: string[] = [];
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
  info: console.info.bind(console),
};

// Hook console methods to capture logs
console.log = (...args: unknown[]) => {
  capturedLogs.push(`[LOG] ${new Date().toISOString()} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  originalConsole.log(...args);
};
console.warn = (...args: unknown[]) => {
  capturedLogs.push(`[WARN] ${new Date().toISOString()} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  originalConsole.warn(...args);
};
console.error = (...args: unknown[]) => {
  capturedLogs.push(`[ERROR] ${new Date().toISOString()} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  originalConsole.error(...args);
};
console.info = (...args: unknown[]) => {
  capturedLogs.push(`[INFO] ${new Date().toISOString()} ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`);
  originalConsole.info(...args);
};

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
      <div class="nav-footer">
        <button
          class="service-btn"
          [class.running]="bookshelf.state() === 'running'"
          [class.starting]="bookshelf.state() === 'starting'"
          (click)="toggleBookshelf()"
          [title]="bookshelfTitle()"
        >
          <span class="nav-icon">🌐</span>
          <span class="nav-label">
            @if (bookshelf.state() === 'starting') { Starting… } @else { Bookshelf }
          </span>
          @if (bookshelf.state() === 'running') {
            <span class="service-dot"></span>
          }
        </button>
        <div class="service-btn-wrap">
          <button
            class="service-btn"
            [class.running]="ttsServer.state() === 'running'"
            [class.starting]="ttsServer.state() === 'starting' || ttsServer.state() === 'warming'"
            (click)="toggleTtsServer()"
            (contextmenu)="openTtsSettings($event)"
          >
            <span class="nav-icon">🎙️</span>
            <span class="nav-label">
              @switch (ttsServer.state()) {
                @case ('running') { TTS On }
                @case ('starting') { Starting… }
                @case ('warming') {
                  @if (ttsServer.warmupPct() !== null) { Warming {{ ttsServer.warmupPct() }}% }
                  @else { Warming… }
                }
                @default { TTS Server }
              }
            </span>
            @if (ttsServer.state() === 'running') {
              <span class="service-dot"></span>
            }
          </button>

          <!-- Instant hover explainer: what the streaming server is for + a way
               into its settings (also reachable via right-click on the button). -->
          <div class="tts-popover" role="tooltip">
            <div class="pop-title">TTS Streaming Server</div>
            <div class="pop-state">{{ ttsServerTitle() }}</div>
            <p class="pop-desc">
              Generates speech on demand. Use it with the BookForge Reader browser
              extension, or play your audiobooks live — no need to render an M4B
              file first.
            </p>
            <button class="pop-settings" (click)="openTtsSettings($event)">⚙ Settings</button>
          </div>
        </div>
        <button class="debug-btn" (click)="themeService.toggleTheme()" [title]="themeTitle()">
          <span class="nav-icon">{{ themeIcon() }}</span>
          <span class="nav-label">{{ themeLabel() }}</span>
        </button>
        <button class="debug-btn" (click)="saveLogs()" title="Save debug logs">
          <span class="nav-icon">🐛</span>
          <span class="nav-label">Logs</span>
        </button>
      </div>
    </nav>
  `,
  styles: [`
    .nav-rail {
      width: 100px;
      min-width: 100px;
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
      width: 88px;
      height: 52px;
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
      text-align: center;
      line-height: 1.2;
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

    .nav-footer {
      margin-top: auto;
      padding-bottom: 0.5rem;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px; // keep the green "running" highlights from touching when both on
    }

    .service-btn {
      position: relative;
      width: 88px;
      height: 52px;
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

      &.running {
        background: color-mix(in srgb, #22c55e 14%, transparent);
        color: #22c55e;
      }

      &.starting {
        color: var(--accent-primary);
        animation: servicePulse 1.4s ease-in-out infinite;
      }

      .nav-icon {
        font-size: 1.25rem;
      }

      .nav-label {
        font-size: 0.625rem;
        font-weight: 500;
        text-transform: uppercase;
      }
    }

    .service-dot {
      position: absolute;
      top: 6px;
      right: 10px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      animation: servicePulse 1.6s ease-in-out infinite;
    }

    @keyframes servicePulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    /* Wrapper anchors the hover explainer to the TTS button. */
    .service-btn-wrap {
      position: relative;
      width: 88px;
      display: flex;
      justify-content: center;
    }

    .tts-popover {
      position: absolute;
      left: calc(100% - 4px);
      bottom: 0;
      width: 240px;
      padding: 12px;
      text-align: left;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.32);
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transform: translateX(-4px);
      transition: opacity 0.12s ease, transform 0.12s ease;
      pointer-events: none;
    }
    /* Show on hover/focus of the wrapper; the popover is inside it, so moving the
       mouse into the popover keeps it open and its Settings button clickable. */
    .service-btn-wrap:hover .tts-popover,
    .service-btn-wrap:focus-within .tts-popover {
      opacity: 1;
      visibility: visible;
      transform: translateX(0);
      pointer-events: auto;
    }
    .pop-title { font-weight: 600; font-size: 13px; color: var(--text-primary); margin-bottom: 4px; }
    .pop-state { font-size: 11px; color: var(--text-tertiary); margin-bottom: 8px; line-height: 1.35; }
    .pop-desc { font-size: 12px; line-height: 1.45; color: var(--text-secondary); margin: 0 0 10px; }
    .pop-settings {
      width: 100%;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 10px;
      border-radius: 6px;
      border: 1px solid var(--border-default);
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
    }
    .pop-settings:hover { background: var(--bg-hover); border-color: var(--accent); }

    .debug-btn {
      width: 88px;
      height: 52px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2px;
      background: transparent;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      color: var(--text-muted);
      transition: all 0.15s ease;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .nav-icon {
        font-size: 1.25rem;
      }

      .nav-label {
        font-size: 0.625rem;
        font-weight: 500;
        text-transform: uppercase;
      }
    }
  `]
})
export class NavRailComponent {
  private readonly router = inject(Router);
  readonly ttsServer = inject(TtsServerService);
  readonly bookshelf = inject(BookshelfServerService);
  readonly themeService = inject(DesktopThemeService);

  // Theme toggle (cycles dark → light → system). Icon/label reflect the choice.
  readonly themeIcon = computed(() => {
    switch (this.themeService.currentTheme()) {
      case 'light': return '☀️';
      case 'dark': return '🌙';
      default: return '🖥️';
    }
  });
  readonly themeLabel = computed(() => {
    switch (this.themeService.currentTheme()) {
      case 'light': return 'Light';
      case 'dark': return 'Dark';
      default: return 'Auto';
    }
  });
  readonly themeTitle = computed(() =>
    `Theme: ${this.themeLabel()} — click to switch (Dark → Light → Auto)`,
  );

  // Navigation items are provided by the host (see app.ts navItems).
  readonly items = input<NavRailItem[]>([]);

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

  toggleTtsServer(): void {
    void this.ttsServer.toggle();
  }

  toggleBookshelf(): void {
    void this.bookshelf.toggle();
  }

  /** Open the TTS streaming server's settings (hover popover button + right-click). */
  openTtsSettings(event?: Event): void {
    event?.preventDefault();
    event?.stopPropagation();
    void this.router.navigate(['/settings'], { queryParams: { section: 'tts-api' } });
  }

  bookshelfTitle(): string {
    const port = this.bookshelf.port();
    switch (this.bookshelf.state()) {
      case 'running': return `Bookshelf is sharing your library on the network (port ${port}). Click to stop it.`;
      case 'starting': return 'Bookshelf server is starting…';
      default: return `Start the Bookshelf server: browse and stream your audiobooks from any device on the network (port ${port}).`;
    }
  }

  ttsServerTitle(): string {
    switch (this.ttsServer.state()) {
      case 'running': return 'TTS server is running (~5 GB RAM/worker). Click to shut it down.';
      case 'starting': return 'TTS server is starting (spawning workers). Click to cancel.';
      case 'warming': return 'TTS server is loading the voice model into memory — it can generate once this finishes. Click to cancel.';
      default: return 'Start the TTS server: instant streaming playback, and external clients (e.g. a browser extension) can connect.';
    }
  }

  navigate(route: string): void {
    // If clicking the already-active route, add a query param to trigger "return home" behavior
    // This allows components to detect re-clicks and show their home/list view
    if (this.isActive(route)) {
      this.router.navigate([route], { queryParams: { home: Date.now() } });
    } else {
      this.router.navigate([route]);
    }
  }

  async saveLogs(): Promise<void> {
    const logContent = capturedLogs.join('\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `bookforge-logs-${timestamp}.txt`;

    // Try to save via IPC
    if ((window as any).electron?.debug?.saveLogs) {
      await (window as any).electron.debug.saveLogs(logContent, filename);
    } else {
      // Fallback: download as file in browser
      const blob = new Blob([logContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  }
}
