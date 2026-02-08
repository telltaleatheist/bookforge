import { Component, input, output, signal, effect } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-url-input',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="url-input-panel">
      <h2>Enter Article URL</h2>
      <p class="subtitle">Paste the URL of the article you want to convert to a bilingual audiobook.</p>

      <div class="url-input-container">
        <input
          type="url"
          class="url-input"
          placeholder="https://example.com/article"
          [value]="urlValue()"
          (input)="onInput($event)"
          (keydown.enter)="onSubmit()"
          (paste)="onPaste($event)"
        />
        <button
          class="btn-primary"
          [disabled]="!isValidUrl() || isFetching()"
          (click)="onButtonClick()"
        >
          @if (isFetching()) {
            <span class="spinner"></span>
            Fetching...
          } @else {
            Fetch Article
          }
        </button>
      </div>

      @if (error()) {
        <div class="error-message">
          {{ error() }}
        </div>
      }

      <div class="tips">
        <h4>Tips for best results:</h4>
        <ul>
          <li>Use articles from major news sites (NYT, Guardian, BBC, etc.)</li>
          <li>Avoid pages with heavy JavaScript or interactive content</li>
          <li>The article should be primarily text-based</li>
          <li>Pages with paywalls may not work correctly</li>
        </ul>
      </div>
    </div>
  `,
  styles: [`
    .url-input-panel {
      padding: 32px;
      max-width: 600px;
      margin: 0 auto;
    }

    h2 {
      margin: 0 0 8px;
      font-size: 24px;
      color: var(--text-primary);
    }

    .subtitle {
      margin: 0 0 24px;
      color: var(--text-secondary);
      font-size: 14px;
    }

    .url-input-container {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
    }

    .url-input {
      flex: 1;
      padding: 12px 16px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-primary);
      font-size: 14px;
      transition: border-color 0.15s;

      &:focus {
        outline: none;
        border-color: var(--color-primary);
      }

      &::placeholder {
        color: var(--text-muted);
      }
    }

    .btn-primary {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 20px;
      border: none;
      border-radius: 6px;
      background: var(--color-primary);
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.15s;
      white-space: nowrap;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid transparent;
      border-top-color: currentColor;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .error-message {
      padding: 12px 16px;
      border-radius: 6px;
      background: var(--color-error-bg);
      color: var(--color-error);
      font-size: 14px;
      margin-bottom: 16px;
    }

    .tips {
      margin-top: 32px;
      padding: 16px;
      background: var(--bg-surface);
      border-radius: 8px;
      border: 1px solid var(--border-subtle);

      h4 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
        color: var(--text-primary);
      }

      ul {
        margin: 0;
        padding-left: 20px;
        color: var(--text-secondary);
        font-size: 13px;
        line-height: 1.6;
      }
    }
  `]
})
export class UrlInputComponent {
  // Outputs
  readonly fetch = output<string>();

  // State
  readonly urlValue = signal<string>('');
  readonly isFetching = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  readonly isValidUrl = signal<boolean>(false);

  onInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    console.log('[URL-INPUT] onInput:', input.value);
    this.urlValue.set(input.value);
    this.error.set(null);
    this.validateUrl(input.value);
  }

  onPaste(event: ClipboardEvent): void {
    // Handle paste event for immediate URL validation
    setTimeout(() => {
      const value = (event.target as HTMLInputElement).value;
      this.urlValue.set(value);
      this.validateUrl(value);
    }, 0);
  }

  private validateUrl(value: string): void {
    if (!value.trim()) {
      this.isValidUrl.set(false);
      return;
    }

    try {
      const url = new URL(value.trim());
      const isValid = url.protocol === 'http:' || url.protocol === 'https:';
      this.isValidUrl.set(isValid);
    } catch {
      this.isValidUrl.set(false);
    }
  }

  onButtonClick(): void {
    this.onSubmit();
  }

  onSubmit(): void {
    const url = this.urlValue().trim();
    if (!url || !this.isValidUrl()) {
      return;
    }

    // Set fetching state immediately so button shows loading
    this.isFetching.set(true);
    this.fetch.emit(url);
  }

  setFetching(value: boolean): void {
    this.isFetching.set(value);
  }

  setError(message: string | null): void {
    this.error.set(message);
  }

  reset(): void {
    this.urlValue.set('');
    this.isFetching.set(false);
    this.error.set(null);
    this.isValidUrl.set(false);
  }
}
