import { Component, OnInit, inject, computed, signal, effect } from '@angular/core';
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
import { ElectronService } from './core/services/electron.service';
import { StudioService } from './features/studio/services/studio.service';

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
    <!-- First-run setup overlay: blocks ONLY on a setup ERROR (needs attention).
         The normal unpack no longer blocks — the user stays on the guided Setup
         page with a bottom progress bar (see setup-progress below); the queue
         defers job start until ready and env-dependent downloads gate on
         runtime.ready(). -->
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
          }
        </div>
      </div>
    }

    <!-- Onboarding wizard (shown on first launch). Latched open via showOnboarding
         so it survives the moment the library is created (which flips isConfigured
         true) — otherwise the wizard would vanish on its "ready" step before the
         user hits Finish, skipping the guided /setup navigation. -->
    @if (showOnboarding()) {
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

    <!-- First-run engine setup: slim progress bar pinned to the bottom while the
         bundled runtime unpacks. The user is kept on the Setup page (redirect in
         the constructor) so they have something to do; this shows live progress. -->
    @if (setupPreparing()) {
      <div class="setup-progress" role="status" aria-live="polite">
        <div class="setup-progress-track">
          <div class="setup-progress-fill" [style.width.%]="runtime.setupProgress()"></div>
        </div>
        <div class="setup-progress-label">
          <span class="setup-progress-spinner"></span>
          <span class="setup-progress-text">Setting up the audiobook engine — {{ runtime.status().message }}</span>
          <span class="setup-progress-pct">{{ runtime.setupProgress() }}%</span>
        </div>
      </div>
    }
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

    /* First-run engine-setup progress bar (pinned to the bottom of the window). */
    .setup-progress {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9000;
      background: var(--bg-elevated, #1e1e1e);
      border-top: 1px solid var(--border-subtle, rgba(255, 255, 255, 0.12));
      box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.25);
    }

    .setup-progress-track {
      height: 3px;
      width: 100%;
      background: var(--border-subtle, rgba(255, 255, 255, 0.12));
      overflow: hidden;
    }

    .setup-progress-fill {
      height: 100%;
      background: var(--accent, #29b6f6);
      transition: width 0.6s ease;
    }

    .setup-progress-label {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      font-size: 12px;
      color: var(--text-secondary, #c0c0c0);
    }

    .setup-progress-text {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .setup-progress-pct {
      margin-left: auto;
      flex: none;
      font-variant-numeric: tabular-nums;
      color: var(--text-tertiary, #888);
    }

    .setup-progress-spinner {
      flex: none;
      width: 12px;
      height: 12px;
      border: 2px solid var(--border-subtle, rgba(255, 255, 255, 0.2));
      border-top-color: var(--accent, #29b6f6);
      border-radius: 50%;
      animation: setup-spin 0.8s linear infinite;
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
  private readonly electron = inject(ElectronService);
  private readonly studio = inject(StudioService);

  // Lets the user dismiss the setup overlay (only reachable in the error state).
  private readonly setupDismissed = signal(false);

  // Onboarding visibility, latched. Creating the library flips isConfigured true
  // mid-wizard (on the "ready" step), so we can't gate the wizard on isConfigured
  // directly or it unmounts before Finish → the /setup navigation never fires.
  // The effect below turns it on once when needed; onOnboardingComplete turns it off.
  readonly showOnboarding = signal(false);
  private readonly onboardingGate = effect(() => {
    if (this.libraryService.loading()) return;
    if (!this.libraryService.isConfigured() && !this.onboardingDone) {
      this.showOnboarding.set(true);
    }
  });
  private onboardingDone = false;

  // Environment-based first-run: when the bundled engine was created from scratch
  // this launch (fresh install / post-"Remove all data"), the guided setup was
  // never done for THIS install — even if a stale localStorage onboarding flag
  // survived an uninstall and makes the app look "configured". Route to /setup
  // instead of dumping the user on the home screen with an unset-up engine. The
  // no-library case is handled by onboardingGate (onboarding → /setup); this
  // covers the stale-flag case where onboarding was wrongly skipped.
  private firstRunRouted = false;
  private readonly firstRunGate = effect(() => {
    if (this.firstRunRouted) return;
    if (!this.runtime.freshInstall()) return;
    if (this.isStandaloneWindow() || this.libraryService.loading()) return;
    if (this.showOnboarding()) return;              // onboarding owns this case
    if (this.libraryService.isConfigured()) {
      this.firstRunRouted = true;
      void this.router.navigate(['/setup']);
    }
  });

  // The full-screen overlay now blocks ONLY on a setup ERROR (needs attention).
  // During the normal first-run unpack we no longer black out the app — instead
  // we keep the user on the guided Setup page (something to do) and show a slim
  // progress bar pinned to the bottom (setupPreparing / setupProgress below).
  readonly showSetupOverlay = computed(() => {
    if (this.isStandaloneWindow()) return false;
    return !!this.runtime.errorStatus() && !this.setupDismissed();
  });

  // True while the bundled runtime is still unpacking, the library is configured
  // (past onboarding), and this isn't a standalone popup. Drives the slim bottom
  // progress bar — an ambient indicator while the user moves around the app. The
  // guided Setup page shows its own prominent progress + auto-advances home when
  // the user finishes before the engine is ready (FirstRunSetupComponent).
  readonly setupPreparing = computed(() =>
    this.runtime.preparing()
    && this.libraryService.isConfigured()
    && !this.isStandaloneWindow()
  );

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
      // Labelled "Configuration" in the rail; the first-run flow is still "setup".
      id: 'setup',
      icon: '\u{1F9F0}', // Toolbox emoji
      label: 'Configuration',
      route: '/setup'
    }
    // AI Setup is reached from Settings → AI and from first-run onboarding /
    // the cleanup-page overlay — intentionally not a top-level nav item.
  ];

  ngOnInit() {
    this.themeService.initializeTheme();
  }

  async onOnboardingComplete(): Promise<void> {
    // Close the wizard for good, then walk the user through the guided setup
    // (AI → voices → language packs → optional tools → home).
    this.onboardingDone = true;
    this.showOnboarding.set(false);
    void this.seedDefaultBook();
    await this.ai.refresh();
    void this.router.navigate(['/setup']);
  }

  /** First run only: copy the bundled public-domain book OUT of app resources and
   *  INTO the chosen library, set up as the user's first book. Best-effort — never
   *  blocks setup. The "done" flag is only set once the book is actually imported,
   *  so a transient failure can still seed on a later attempt (and a build that
   *  ships no seed book never burns the flag). */
  private async seedDefaultBook(): Promise<void> {
    const KEY = 'bookforge-seed-book-added';
    if (localStorage.getItem(KEY)) return;
    try {
      const path = await this.electron.getSeedBookPath();
      if (!path) return; // no bundled book (dev / not shipped) — leave the flag unset
      const result = await this.studio.addBook(path);
      if (result?.success) {
        localStorage.setItem(KEY, '1'); // only mark once it's really in the library
      }
    } catch (err) {
      console.warn('[App] Seeding the default book failed:', err);
    }
  }
}
