import { Component, OnInit, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import {
  WindowChromeComponent,
  StatusBarComponent,
  DesktopThemeService
} from './creamsicle-desktop';
import { NavRailComponent, NavRailItem } from './components/nav-rail/nav-rail.component';
import { OnboardingComponent } from './components/onboarding/onboarding.component';
import { LibraryService } from './core/services/library.service';

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
        </ng-container>

        <!-- Main content area with nav rail -->
        <div class="app-layout">
          <!-- Navigation Rail -->
          @if (libraryService.isConfigured()) {
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

  // Navigation items for the nav rail
  readonly navItems: NavRailItem[] = [
    {
      id: 'library',
      icon: '\u{1F4DA}', // Books emoji
      label: 'Library',
      route: '/library'
    },
    {
      id: 'audiobook',
      icon: '\u{1F3A7}', // Headphones emoji
      label: 'Audiobook Producer',
      route: '/audiobook'
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
  }

  onOnboardingComplete(): void {
    // Onboarding complete - the view will update automatically
    // because libraryService.isConfigured() is a computed signal
  }
}
