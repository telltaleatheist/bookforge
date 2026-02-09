import { Component, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SUPPORTED_LANGUAGES, SupportedLanguage } from '../../models/language-learning.types';

@Component({
  selector: 'app-language-selector',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="language-selector">
      <div class="selector-header">
        <h3>Target Language</h3>
        <p>Select the language you want to learn</p>
      </div>

      <div class="language-grid">
        @for (lang of languages; track lang.code) {
          <button
            class="language-option"
            [class.selected]="selectedLang() === lang.code"
            (click)="selectLanguage(lang.code)"
          >
            <span class="lang-flag" [style.background]="getFlagCss(lang.code)"></span>
            <span class="lang-name">{{ lang.name }}</span>
          </button>
        }
      </div>

      <div class="source-language">
        <span class="label">Source Language:</span>
        <span class="value">English (auto-detected)</span>
      </div>
    </div>
  `,
  styles: [`
    .language-selector {
      padding: 24px;
    }

    .selector-header {
      margin-bottom: 20px;

      h3 {
        margin: 0 0 4px;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary);
      }

      p {
        margin: 0;
        font-size: 13px;
        color: var(--text-secondary);
      }
    }

    .language-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }

    .language-option {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border: 1px solid var(--border-default);
      border-radius: 8px;
      background: var(--bg-surface);
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        border-color: var(--color-primary);
        background: var(--bg-hover);
      }

      &.selected {
        border-color: var(--color-primary);
        background: var(--color-primary-bg);
      }
    }

    .lang-flag {
      display: inline-block;
      width: 28px;
      height: 18px;
      border-radius: 3px;
      border: 1px solid rgba(255, 255, 255, 0.15);
      flex-shrink: 0;
    }

    .lang-name {
      font-size: 14px;
      color: var(--text-primary);
    }

    .source-language {
      padding: 12px 16px;
      background: var(--bg-muted);
      border-radius: 6px;
      font-size: 13px;

      .label {
        color: var(--text-secondary);
      }

      .value {
        color: var(--text-primary);
        margin-left: 8px;
      }
    }
  `]
})
export class LanguageSelectorComponent {
  // Inputs
  readonly value = input<string>('de');

  // Outputs
  readonly valueChange = output<string>();

  // Languages
  readonly languages = SUPPORTED_LANGUAGES;

  // Selected language (local signal for immediate UI update)
  readonly selectedLang = signal<string>('de');

  constructor() {
    // Initialize from input
    const initial = this.value();
    if (initial) {
      this.selectedLang.set(initial);
    }
  }

  selectLanguage(code: string): void {
    this.selectedLang.set(code);
    this.valueChange.emit(code);
  }

  getFlagCss(code: string): string {
    const flags: Record<string, string> = {
      'de': 'linear-gradient(to bottom, #000 33.3%, #DD0000 33.3% 66.6%, #FFCE00 66.6%)',
      'es': 'linear-gradient(to bottom, #AA151B 25%, #F1BF00 25% 75%, #AA151B 75%)',
      'fr': 'linear-gradient(to right, #002395 33.3%, #FFF 33.3% 66.6%, #ED2939 66.6%)',
      'it': 'linear-gradient(to right, #008C45 33.3%, #F4F5F0 33.3% 66.6%, #CD212A 66.6%)',
      'pt': 'linear-gradient(to right, #006600 40%, #FF0000 40%)',
      'nl': 'linear-gradient(to bottom, #AE1C28 33.3%, #FFF 33.3% 66.6%, #21468B 66.6%)',
      'pl': 'linear-gradient(to bottom, #FFF 50%, #DC143C 50%)',
      'ru': 'linear-gradient(to bottom, #FFF 33.3%, #0039A6 33.3% 66.6%, #D52B1E 66.6%)',
      'ja': 'radial-gradient(circle, #BC002D 25%, #FFF 25%)',
      'zh': 'radial-gradient(circle at 28% 35%, #FFDE00 8%, #DE2910 8%)',
      'ko': 'radial-gradient(circle at 50% 40%, #CD2E3A 18%, transparent 18%), radial-gradient(circle at 50% 60%, #0047A0 18%, transparent 18%), linear-gradient(#FFF, #FFF)',
    };
    return flags[code] || 'linear-gradient(#666, #666)';
  }
}
