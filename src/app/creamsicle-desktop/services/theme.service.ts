import { Injectable, signal, effect } from '@angular/core';

export type DesktopTheme = 'light' | 'dark' | 'system';
export type UiSize = 'small' | 'medium' | 'large';

@Injectable({
  providedIn: 'root'
})
export class DesktopThemeService {
  private readonly STORAGE_KEY = 'creamsicle-desktop-theme';
  private readonly SIZE_STORAGE_KEY = 'creamsicle-desktop-ui-size';

  currentTheme = signal<DesktopTheme>('system');
  resolvedTheme = signal<'light' | 'dark'>('light');
  uiSize = signal<UiSize>('large');

  private mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

  constructor() {
    // Listen for system theme changes
    this.mediaQuery.addEventListener('change', (e) => {
      if (this.currentTheme() === 'system') {
        this.resolvedTheme.set(e.matches ? 'dark' : 'light');
        this.applyTheme();
      }
    });

    // Apply theme whenever it changes
    effect(() => {
      this.applyTheme();
    });

    // Apply UI size whenever it changes
    effect(() => {
      this.applyUiSize();
    });
  }

  initializeTheme() {
    const stored = localStorage.getItem(this.STORAGE_KEY) as DesktopTheme | null;
    if (stored && ['light', 'dark', 'system'].includes(stored)) {
      this.currentTheme.set(stored);
    }

    const storedSize = localStorage.getItem(this.SIZE_STORAGE_KEY) as UiSize | null;
    if (storedSize && ['small', 'medium', 'large'].includes(storedSize)) {
      this.uiSize.set(storedSize);
    }

    this.updateResolvedTheme();
    this.applyTheme();
    this.applyUiSize();
  }

  setTheme(theme: DesktopTheme) {
    this.currentTheme.set(theme);
    localStorage.setItem(this.STORAGE_KEY, theme);
    this.updateResolvedTheme();
  }

  toggleTheme() {
    const current = this.currentTheme();
    if (current === 'light') {
      this.setTheme('dark');
    } else if (current === 'dark') {
      this.setTheme('system');
    } else {
      this.setTheme('light');
    }
  }

  private updateResolvedTheme() {
    const theme = this.currentTheme();
    if (theme === 'system') {
      this.resolvedTheme.set(this.mediaQuery.matches ? 'dark' : 'light');
    } else {
      this.resolvedTheme.set(theme);
    }
  }

  private applyTheme() {
    const resolved = this.resolvedTheme();
    document.documentElement.setAttribute('data-theme', resolved);
  }

  setUiSize(size: UiSize) {
    this.uiSize.set(size);
    localStorage.setItem(this.SIZE_STORAGE_KEY, size);
  }

  cycleUiSize() {
    const current = this.uiSize();
    if (current === 'small') {
      this.setUiSize('medium');
    } else if (current === 'medium') {
      this.setUiSize('large');
    } else {
      this.setUiSize('small');
    }
  }

  private applyUiSize() {
    const size = this.uiSize();
    document.documentElement.setAttribute('data-ui-size', size);
  }
}
