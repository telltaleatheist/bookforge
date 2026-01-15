import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'desktop-window',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div
      class="window"
      [class.focused]="focused()"
      [class.maximized]="maximized()"
      [class.frameless]="frameless"
      [class.with-titlebar]="showTitlebar"
    >
      <!-- Title Bar (optional - Electron handles native controls) -->
      @if (showTitlebar) {
        <div class="titlebar" (dblclick)="onMaximize()">
          <div class="titlebar-left">
            <ng-content select="[titlebar-left]"></ng-content>
          </div>

          <div class="title">
            @if (icon) {
              <span class="title-icon">{{ icon }}</span>
            }
            @if (title) {
              <span class="title-text">{{ title }}</span>
            }
          </div>

          <div class="titlebar-right">
            <ng-content select="[titlebar-right]"></ng-content>
          </div>
        </div>
      }

      <!-- Toolbar (optional) -->
      @if (showToolbar) {
        <div class="toolbar">
          <ng-content select="[toolbar]"></ng-content>
        </div>
      }

      <!-- Main Content Area -->
      <div class="window-body">
        <ng-content></ng-content>
      </div>

      <!-- Status Bar (optional) -->
      @if (showStatusBar) {
        <div class="statusbar">
          <ng-content select="[statusbar]"></ng-content>
        </div>
      }
    </div>
  `,
  styleUrl: './window-chrome.component.scss'
})
export class WindowChromeComponent {
  @Input() title = '';
  @Input() icon?: string;
  @Input() showTitlebar = true;
  @Input() showToolbar = false;
  @Input() showStatusBar = false;
  @Input() frameless = false;

  @Output() closeWindow = new EventEmitter<void>();
  @Output() minimizeWindow = new EventEmitter<void>();
  @Output() maximizeWindow = new EventEmitter<void>();

  focused = signal(true);
  maximized = signal(false);
  width = signal<number | null>(null);
  height = signal<number | null>(null);

  onClose() {
    this.closeWindow.emit();
  }

  onMinimize() {
    this.minimizeWindow.emit();
  }

  onMaximize() {
    this.maximized.update(v => !v);
    this.maximizeWindow.emit();
  }
}
