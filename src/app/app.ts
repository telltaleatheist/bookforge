import { Component, DestroyRef, OnInit, inject, computed, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterOutlet } from '@angular/router';
import {
  WindowChromeComponent,
  StatusBarComponent,
  DesktopThemeService
} from './creamsicle-desktop';
import { NavRailComponent, NavRailItem } from './components/nav-rail/nav-rail.component';
import { SetupDownloadDockComponent } from './components/setup-download-dock/setup-download-dock.component';
import { UpdateBannerComponent } from './components/update-banner/update-banner.component';
import { ToastHostComponent } from './components/toast-host/toast-host.component';
import { QueueChipComponent } from './features/queue/components/queue-chip/queue-chip.component';
import { QueueToastsService } from './features/queue/services/queue-toasts.service';
import { isStandaloneWindow } from './core/window-role';
import { NarrationHandoffService } from './core/services/narration-handoff.service';
import { ElectronService } from './core/services/electron.service';
import { LibraryService } from './core/services/library.service';
import { RuntimeService } from './core/services/runtime.service';
import { SetupDownloadService } from './core/services/setup-download.service';
import { BookConversionService } from './features/studio/services/book-conversion.service';
import { DialogService } from './creamsicle-desktop/services/dialog.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    WindowChromeComponent,
    StatusBarComponent,
    NavRailComponent,
    SetupDownloadDockComponent,
    UpdateBannerComponent,
    ToastHostComponent,
    QueueChipComponent
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

    <!-- First launch has no separate onboarding modal anymore: the guided Setup
         page (/setup) owns the whole first run, with the library-location picker
         as its first step. The first-run gate below routes there. -->

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

        <!-- The queue's face. In EVERY window — main and the standalone
             listen/editor/alignment popups alike — because the queue is main's
             and every window mirrors it. Deliberately NOT suppressed with the
             nav rail: the rail is navigation this window has no use for, and
             this is a readout every window has a use for. It sits in the
             titlebar-right slot, which the window chrome already marks
             no-drag for its buttons. -->
        <ng-container titlebar-right>
          <app-queue-chip />
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

    <!-- App self-update toast: "update ready — restart to apply" (and download progress). -->
    <app-update-banner />

    <!-- The app's ONE notification stack: completion cards (a run's last step
         landing, or any step failing — shown in whichever window has focus,
         see QueueToastsService) and plain notice lines (NoticeService — the
         non-blocking half of the dialog vocabulary). The bottom-left notice
         banner it replaced is gone (unified 2026-08-17). -->
    <app-toast-host />

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
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly setupDownloads = inject(SetupDownloadService);
  // The two halves of "queue this book's conversion": the service that knows how
  // to describe the run, and the one that schedules it. Injected here rather
  // than reached through Studio because the request arrives from another window
  // and Studio may not be mounted — the same reason the narration hand-off is
  // left with a service instead of delivered to a listener.
  private readonly bookConversion = inject(BookConversionService);
  private readonly dialog = inject(DialogService);
  // Where a Narrate pressed on Foundry's tree is left until Studio is mounted
  // and can act on it. See NarrationHandoffService.
  private readonly narrationHandoff = inject(NarrationHandoffService);
  // Started in ngOnInit, in EVERY window: which one actually speaks is decided
  // per event by the focus rule, not by the window's kind.
  private readonly queueToasts = inject(QueueToastsService);

  // Lets the user dismiss the setup overlay (only reachable in the error state).
  private readonly setupDismissed = signal(false);

  // First-run routing. The guided Setup page (/setup) is now the entire first-run
  // experience — its first step is the library-location picker (no separate
  // onboarding modal). Route there when:
  //   • no library is configured yet (true first run), or
  //   • the library looks configured but the bundled engine was created from
  //     scratch this launch (fresh install whose localStorage onboarding flag
  //     survived an uninstall) — setup was never really done for THIS install.
  private firstRunRouted = false;
  private readonly firstRunGate = effect(() => {
    if (this.firstRunRouted) return;
    if (this.isStandaloneWindow() || this.libraryService.loading()) return;
    if (!this.libraryService.isConfigured()) {
      this.firstRunRouted = true;
      void this.router.navigate(['/setup']);
      return;
    }
    if (this.runtime.freshInstall()) {
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

  // Hide nav rail for standalone popup windows (alignment, editor, etc.).
  // The test itself lives in core/window-role.ts now: it is a fact about the
  // WINDOW, and the queue mirror needs the same answer to keep once-per-event
  // effects from running once per window.
  readonly isStandaloneWindow = computed(() => isStandaloneWindow());

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
      id: 'live-tts',
      icon: '\u{1F3A4}', // Microphone emoji
      label: 'Live TTS',
      route: '/live-tts'
    },
    {
      id: 'enhance',
      icon: '\u{2728}', // Sparkles emoji
      label: 'Enhance',
      route: '/enhance'
    },
    {
      // DEMOTED (2026-08-17). The queue tab is the DETAIL view now — the whole
      // queue is readable from the title-bar chip in every window, and the
      // tray's "Open queue details →" is the front door to this page. It kept
      // the slot directly under Library while it was the only way to see the
      // queue at all; sitting there now would say the queue is a place you go
      // to rather than something that is always on screen.
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
    // Settings is the single post-setup hub for downloads and configuration.
    // The guided setup (/setup) runs on first run and can be reopened from
    // Settings → General; it is intentionally not a top-level nav item, so
    // there is one obvious place to manage components.
    // AI Setup is reached from Settings → AI and from first-run onboarding /
    // the cleanup-page overlay — intentionally not a top-level nav item.
  ];

  ngOnInit() {
    this.themeService.initializeTheme();

    // Completion toasts. Every window listens; the focus rule decides which one
    // says it, so a Listen window in front gets the news and the main window
    // behind it stays quiet.
    this.queueToasts.start();

    // The picker was showing a project's archive PDF, which under the artifact
    // model is read-only, and the user pressed "Generate EPUB" on its banner.
    // The working copy of a PDF is what `foundry vlm-convert` writes — always,
    // even for a born-digital one, so there is one path and no converter choice —
    // and that is an hour of GPU, so it belongs in the queue.
    //
    // The hand-off used to be here because the queue was THIS WINDOW'S: a
    // renderer-side scheduler persisting through main, so a second window adding
    // a job would write its own queue file over the one being watched. That
    // hazard is gone — the queue is main's and every window enqueues into the
    // same one — and this listener is now only about SHOWING the user where the
    // run went, which is still worth doing.
    const unsubscribeConversion = this.electron.onShowBookConversion((projectDir: string) => {
      void this.queueBookConversion(projectDir);
    });
    this.destroyRef.onDestroy(unsubscribeConversion);

    // Narrate, pressed on a step of a book's provenance tree in the hosted
    // Foundry window. Main resolved which book and which exported EPUB that step
    // belongs to and raised this window; the request is LEFT WITH A SERVICE
    // rather than acted on here, because Studio is lazily routed and is usually
    // not mounted at this instant — see NarrationHandoffService. Routing is done
    // here, because the shell owns the route.
    //
    // Main window only: `app:show-narration` is sent to the main window alone,
    // and a standalone popup navigating to Studio would be a second copy of the
    // library in a window that has no rail to leave it by.
    if (!this.isStandaloneWindow()) {
      const unsubscribeNarration = this.electron.onShowNarration((request) => {
        this.narrationHandoff.request(request);
        void this.router.navigate(['/studio']);
      });
      this.destroyRef.onDestroy(unsubscribeNarration);
    }

    // The main process checks at startup whether any INSTALLED component is
    // behind what the catalog names (and whether foundry has published a release
    // newer than the pin). Listening here — in the shell, beside the dock —
    // because the upgrades run through SetupDownloadService and show in the
    // bottom-right download shelf, which outlives every route.
    //
    // Only the main window: a standalone editor/listen/alignment popup has the
    // same shell but must not start a second copy of the same downloads.
    if (!this.isStandaloneWindow()) {
      this.destroyRef.onDestroy(this.setupDownloads.watchForUpgrades());
    }
  }

  /**
   * Put this project's PDF→EPUB conversion in the queue, then show the queue.
   *
   * `prepare` is asked FIRST and its refusal is shown as a sentence, because the
   * refusals it produces are about settings — no reader configured, no GPU this
   * app can reach — and a user sent to a queue holding a job that will fail in
   * four seconds has been told nothing. That is `BookConversionService`'s own
   * rule ("asked BEFORE the modal opens"), followed here for the same reason.
   *
   * `from: 'archive'` because that is what the banner was over: the file the
   * user handed us. There is deliberately no `skipDeletedPages` — that is the
   * working-PDF path's option, and a PDF has no editable copy any more, so there
   * are no page deletions of its own to skip.
   */
  private async queueBookConversion(projectDir: string): Promise<void> {
    const refusal = await this.bookConversion.prepare({
      projectDir,
      from: 'archive',
      sourceLabel: projectDir.split(/[\\/]/).filter(Boolean).pop() ?? projectDir,
    });
    if (refusal !== null) {
      await this.dialog.alert({
        title: 'The pages cannot be read yet',
        message: refusal,
        type: 'warning',
      });
      return;
    }
    await this.bookConversion.sendToQueue(projectDir);
    await this.router.navigate(['/queue']);
  }
}
