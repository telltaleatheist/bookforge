import { computed, Injectable, signal } from '@angular/core';

export type ThemeName = 'midnight' | 'dark' | 'light';

/** Persists the theme choice and applies it to <html data-theme>.
 *  Cycle order: Midnight (seamless black) → Dark (iOS system) → Light. */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private static readonly ORDER: ThemeName[] = ['midnight', 'dark', 'light'];
  private static readonly LABELS: Record<ThemeName, string> = { midnight: 'Midnight', dark: 'Dark', light: 'Light' };
  private static readonly ICONS: Record<ThemeName, string> = { midnight: '🌑', dark: '🌙', light: '☀️' };
  // Bumped key (was `bookshelf-theme`): introduces Midnight as the default and
  // resets everyone onto it once, so the old pure-black player look is now the
  // whole app. A deliberate re-pick still persists under the new key.
  private static readonly KEY = 'bookshelf-theme-v2';

  readonly theme = signal<ThemeName>('midnight');
  readonly label = computed(() => ThemeService.LABELS[this.theme()]);
  readonly icon = computed(() => ThemeService.ICONS[this.theme()]);

  init(): void {
    const saved = localStorage.getItem(ThemeService.KEY) as ThemeName | null;
    this.apply(saved && ThemeService.ORDER.includes(saved) ? saved : 'midnight');
  }

  /** Advance to the next theme in the cycle. */
  cycle(): void {
    const i = ThemeService.ORDER.indexOf(this.theme());
    this.apply(ThemeService.ORDER[(i + 1) % ThemeService.ORDER.length]);
  }

  set(t: ThemeName): void {
    this.apply(t);
  }

  private apply(t: ThemeName): void {
    this.theme.set(t);
    document.documentElement.setAttribute('data-theme', t);
    localStorage.setItem(ThemeService.KEY, t);
  }
}
