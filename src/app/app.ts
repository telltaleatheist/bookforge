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
import { SetupDownloadDockComponent } from './components/setup-download-dock/setup-download-dock.component';
import { LibraryService } from './core/services/library.service';
import { RuntimeService } from './core/services/runtime.service';
import { AiService } from './core/services/ai.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    WindowChromeComponent,
    StatusBarComponent,
    NavRailComponent,
    OnboardingComponent,
    SetupDownloadDockComponent
  ],
  template: `
    <!-- First-run setup overlay: only blocks on a setup ERROR (needs attention).
         While the runtime unpacks we DON'T block — the user runs onboarding /
         guided setup in the meantime; the queue defers job start until ready and
         env-dependent downloads gate on runtime.ready(). -->
    @if (showSetupOverlay()) {
      <div class="setup-overlay">
        <div class="setup-card">
          @if (runtime.errorStatus(); as err) {
            <h2>Setup didn't finish</h2>
            <p class="setup-message">{{ err.message }}</p>
            @if (err.error) {
              <p class="setup-error">{{ err.error }}</p>
            }
            <button class="setup-dismiss" (click)="dismissSetup()">Continue anyway</button>
          } @else {
            <div class="setup-spinner"></div>
            <h2>Setting up the audiobook engine…</h2>
            <p class="setup-message">{{ runtime.status().message }}</p>
            <p class="setup-hint">This one-time setup takes a minute. You can leave this window open.</p>
          }
        </div>
      </div>
    }

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

    <!-- Persistent download-progress widget: survives navigation away from
         first-run setup so the batch keeps running, visible in a corner. -->
    <app-setup-download-dock />
  `,
  styles: [`
    .setup-overlay {
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-base, #1a1a1a);
      -webkit-app-region: drag; // let the user move the frameless window
    }

    .setup-card {
      max-width: 460px;
      padding: 40px 48px;
      text-align: center;
      color: var(--text-primary, #f0f0f0);
      -webkit-app-region: no-drag;
    }

    .setup-card h2 {
      margin: 16px 0 8px;
      font-size: 18px;
      font-weight: 600;
    }

    .setup-message {
      margin: 4px 0;
      color: var(--text-secondary, #c0c0c0);
      font-size: 14px;
    }

    .setup-hint {
      margin-top: 16px;
      color: var(--text-tertiary, #888);
      font-size: 12px;
    }

    .setup-error {
      margin: 8px 0;
      color: var(--color-danger, #e06c75);
      font-size: 12px;
      font-family: var(--font-mono, monospace);
      word-break: break-word;
    }

    .setup-spinner {
      width: 36px;
      height: 36px;
      margin: 0 auto;
      border: 3px solid var(--border-subtle, rgba(255, 255, 255, 0.15));
      border-top-color: var(--color-accent, #ff7a45);
      border-radius: 50%;
      animation: setup-spin 0.8s linear infinite;
    }

    @keyframes setup-spin {
      to { transform: rotate(360deg); }
    }

    .setup-dismiss {
      margin-top: 16px;
      padding: 8px 20px;
      border: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.2));
      border-radius: 6px;
      background: transparent;
      color: var(--text-primary, #f0f0f0);
      font-size: 13px;
      cursor: pointer;
    }

    .setup-dismiss:hover {
      background: var(--bg-hover, rgba(255, 255, 255, 0.08));
    }

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
  readonly runtime = inject(RuntimeService);
  private readonly router = inject(Router);
  private readonly ai = inject(AiService);

  // Lets the user dismiss the setup overlay (only reachable in the error state).
  private readonly setupDismissed = signal(false);

  // Current route (hash) mirrored into a signal so the overlay reacts to
  // navigation — kept in sync from Router events in ngOnInit.
  private readonly currentUrl = signal('');

  // When to block the app behind the setup splash:
  //  • a setup ERROR always blocks (needs attention; dismissable), OR
  //  • the bundled runtime is still unpacking AND the user has finished
  //    onboarding/guided setup and moved into the app. The first-run unpack
  //    (~40 s) normally completes while they pick a library and set up AI, so
  //    this is the safety net for when they outpace it: the engine isn't usable
  //    until 'ready', and landing on a half-ready runtime wedges TTS workers.
  // The guided setup route (/setup) stays interactive — AI keys and voice
  // picking don't need the runtime — so we never cover it; we only block once
  // they leave it for the rest of the app.
  readonly showSetupOverlay = computed(() => {
    if (this.isStandaloneWindow()) return false;
    if (this.runtime.errorStatus()) return !this.setupDismissed();
    return this.runtime.preparing()
      && this.libraryService.isConfigured()
      && !this.currentUrl().startsWith('/setup');
  });

  dismissSetup(): void {
    this.setupDismissed.set(true);
  }

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
    },
    {
      // Reopen the guided setup (AI, voices, language packs, optional tools) to
      // add or remove components without digging through the Settings panels.
      id: 'setup',
      icon: '\u{1F9F0}', // Toolbox emoji
      label: 'Setup',
      route: '/setup'
    }
    // AI Setup is reached from Settings → AI and from first-run onboarding /
    // the cleanup-page overlay — intentionally not a top-level nav item.
  ];

  ngOnInit() {
    this.themeService.initializeTheme();

    // Mirror the active route into a signal so showSetupOverlay re-evaluates on
    // navigation (e.g. leaving /setup for /studio should reveal the splash if
    // the runtime is still unpacking).
    this.currentUrl.set(this.router.url);
    this.router.events.subscribe(() => this.currentUrl.set(this.router.url));
  }

  async onOnboardingComplete(): Promise<void> {
    // First run: after the library is set, walk the user through the guided
    // setup (AI → voices → language packs → optional tools → home).
    await this.ai.refresh();
    void this.router.navigate(['/setup']);
  }
}
