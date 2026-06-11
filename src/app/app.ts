import { Component, OnInit, inject, computed, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import {
  WindowChromeComponent,
  StatusBarComponent,
  DesktopThemeService
} from './creamsicle-desktop';
import { NavRailComponent, NavRailItem } from './components/nav-rail/nav-rail.component';
import { OnboardingComponent } from './components/onboarding/onboarding.component';
import { LibraryService } from './core/services/library.service';
import { ElectronService } from './core/services/electron.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    WindowChromeComponent,
    StatusBarComponent,
    NavRailComponent,
    OnboardingComponent
  ],
  template: `
    <!-- Onboarding wizard (shown on first launch) -->
    @if (!libraryService.isConfigured() && !libraryService.loading()) {
      <app-onboarding (complete)="onOnboardingComplete()" />
    }

    <div class="app-container" [attr.data-theme]="themeService.resolvedTheme()">
      <desktop-window
        [showTitlebar]="true"
        [showToolbar]="false"
        [showStatusBar]="true"
        [frameless]="true"
      >
        <!-- Titlebar Left (for macOS-style placement) -->
        <ng-container titlebar-left>
          <div class="titlebar-spacer"></div>
          @if (ttsEngineRunning() && !isStandaloneWindow()) {
            <button
              class="tts-pill"
              (click)="stopTtsEngine()"
              title="The stream TTS engine is running (~5 GB RAM). Click to shut it down."
            >
              <span class="tts-dot"></span>
              TTS engine
              <span class="tts-off">⏻</span>
            </button>
          }
        </ng-container>

        <!-- Main content area with nav rail -->
        <div class="app-layout">
          <!-- Navigation Rail (hidden on standalone alignment window) -->
          @if (libraryService.isConfigured() && !isStandaloneWindow()) {
            <app-nav-rail [items]="navItems" />
          }

          <!-- Router Outlet - features manage their own headers -->
          <div class="app-content">
            <router-outlet />
          </div>
        </div>

        <!-- Status Bar -->
        <ng-container statusbar>
          <desktop-status-bar
            [leftItems]="[]"
            [rightItems]="[]"
          />
        </ng-container>
      </desktop-window>
    </div>
  `,
  styles: [`
    .app-container {
      height: 100vh;
      width: 100vw;
      display: flex;
      background: var(--bg-base);
      overflow: hidden;
    }

    desktop-window {
      width: 100%;
      height: 100%;
    }

    .titlebar-spacer {
      width: 70px; // Space for traffic lights on macOS
    }

    .tts-pill {
      -webkit-app-region: no-drag;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 3px 10px;
      border: 1px solid color-mix(in srgb, var(--accent-primary, #06b6d4) 50%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, var(--accent-primary, #06b6d4) 12%, transparent);
      color: var(--text-primary);
      font-size: 11px;
      cursor: pointer;
      transition: background 0.15s;

      &:hover {
        background: color-mix(in srgb, var(--accent-primary, #06b6d4) 25%, transparent);
      }
    }

    .tts-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--accent-primary, #06b6d4);
      animation: ttsPulse 1.6s ease-in-out infinite;
    }

    .tts-off {
      opacity: 0.7;
    }

    @keyframes ttsPulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.35; }
    }

    .app-layout {
      display: flex;
      flex: 1;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }

    .app-content {
      flex: 1;
      min-width: 0; // Allow flex shrinking
      height: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    // Make routed components fill the content area
    :host ::ng-deep router-outlet + * {
      flex: 1;
      width: 100%;
      height: 100%;
    }
  `]
})
export class App implements OnInit {
  readonly themeService = inject(DesktopThemeService);
  readonly libraryService = inject(LibraryService);
  private readonly router = inject(Router);
  private readonly electronService = inject(ElectronService);

  /** Global truth pill: the stream TTS engine is running somewhere */
  readonly ttsEngineRunning = signal(false);

  // Hide nav rail for standalone popup windows (alignment, editor, etc.)
  // App uses hash routing, so the route is in the hash fragment, not pathname
  readonly isStandaloneWindow = computed(() => {
    const hash = window.location.hash;
    return hash.startsWith('#/alignment') || hash.startsWith('#/editor') || hash.startsWith('#/listen');
  });

  // Navigation items for the nav rail
  readonly navItems: NavRailItem[] = [
    {
      // Unified Library + Studio: Browse grid + production Workspace in one view.
      id: 'library',
      icon: '\u{1F4DA}', // Books emoji
      label: 'Library',
      route: '/studio'
    },
    {
      id: 'queue',
      icon: '\u{23F3}', // Hourglass emoji
      label: 'Queue',
      route: '/queue'
    },
    {
      id: 'settings',
      icon: '\u{2699}', // Gear emoji
      label: 'Settings',
      route: '/settings'
    }
  ];

  ngOnInit() {
    this.themeService.initializeTheme();

    // TTS engine status pill: event-driven, with an initial check and a slow
    // polling fallback in case an event is ever missed.
    void this.refreshTtsStatus();
    this.electronService.onPlaySessionStarted(() => this.ttsEngineRunning.set(true));
    this.electronService.onPlaySessionEnded(() => this.ttsEngineRunning.set(false));
    setInterval(() => void this.refreshTtsStatus(), 30_000);
  }

  private async refreshTtsStatus(): Promise<void> {
    try {
      const result = await this.electronService.playIsSessionActive();
      if (result.success) {
        this.ttsEngineRunning.set(!!result.active);
      }
    } catch { /* not in electron */ }
  }

  async stopTtsEngine(): Promise<void> {
    await this.electronService.playEndSession();
    this.ttsEngineRunning.set(false);
  }

  onOnboardingComplete(): void {
    // Onboarding complete - the view will update automatically
    // because libraryService.isConfigured() is a computed signal
  }
}
