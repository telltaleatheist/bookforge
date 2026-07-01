import { Injectable, signal } from '@angular/core';

/** Persists the dark/light choice and applies it to <html data-theme>. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  readonly theme = signal<'dark' | 'light'>('dark');

  init(): void {
    const saved = (localStorage.getItem('bookshelf-theme') as 'dark' | 'light' | null) ?? 'dark';
    this.apply(saved);
  }

  toggle(): void {
    this.apply(this.theme() === 'dark' ? 'light' : 'dark');
  }

  private apply(t: 'dark' | 'light'): void {
    this.theme.set(t);
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem('bookshelf-theme', t);
  }
}
