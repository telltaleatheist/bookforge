import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterOutlet } from '@angular/router';
import {
  WindowChromeComponent,
  StatusBarComponent,
  StatusBarItem,
  DesktopButtonComponent,
  DesktopThemeService
} from './creamsicle-desktop';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    CommonModule,
    RouterOutlet,
    WindowChromeComponent,
    StatusBarComponent,
    DesktopButtonComponent
  ],
  template: `
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

        <!-- Titlebar Right -->
        <ng-container titlebar-right>
          <desktop-button variant="ghost" size="xs" [iconOnly]="true" (click)="toggleTheme()">
            {{ themeService.resolvedTheme() === 'dark' ? '☀' : '☾' }}
          </desktop-button>
        </ng-container>

        <!-- Router Outlet - features manage their own headers -->
        <router-outlet />

        <!-- Status Bar -->
        <ng-container statusbar>
          <desktop-status-bar
            [leftItems]="statusLeftItems"
            [rightItems]="statusRightItems"
            centerText="Ready"
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

    // Make routed components fill the window body
    :host ::ng-deep router-outlet + * {
      flex: 1;
      width: 100%;
      height: 100%;
    }
  `]
})
export class App implements OnInit {
  themeService = inject(DesktopThemeService);

  statusLeftItems: StatusBarItem[] = [
    { id: 'version', text: 'v1.0.0' },
  ];

  statusRightItems: StatusBarItem[] = [
    { id: 'theme', text: 'System', icon: '🎨', clickable: true },
  ];

  ngOnInit() {
    this.themeService.initializeTheme();
  }

  toggleTheme() {
    this.themeService.toggleTheme();
  }
}
