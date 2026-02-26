import { Component, input, output, signal, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface ImportMetadata {
  title: string;
  author: string;
  year: string;
  language: string;
}

@Component({
  selector: 'app-import-metadata-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="modal-backdrop" (click)="cancel.emit()">
      <div class="modal-content" (click)="$event.stopPropagation()">
        <div class="modal-header">
          <h2>Confirm Book Details</h2>
          <button class="btn-close" (click)="cancel.emit()">&times;</button>
        </div>

        <div class="modal-body">
          <div class="metadata-layout">
            @if (coverData()) {
              <div class="cover-section">
                <img [src]="coverData()" alt="Book cover" class="cover-image" />
              </div>
            }
            <div class="fields-section">
              <div class="field">
                <label for="meta-title">Title</label>
                <input
                  id="meta-title"
                  type="text"
                  [(ngModel)]="titleValue"
                  (keydown.enter)="onConfirm()"
                  class="field-input"
                  autofocus
                />
              </div>
              <div class="field">
                <label for="meta-author">Author</label>
                <input
                  id="meta-author"
                  type="text"
                  [(ngModel)]="authorValue"
                  (keydown.enter)="onConfirm()"
                  class="field-input"
                />
              </div>
              <div class="field-row">
                <div class="field">
                  <label for="meta-year">Year</label>
                  <input
                    id="meta-year"
                    type="text"
                    [(ngModel)]="yearValue"
                    (keydown.enter)="onConfirm()"
                    class="field-input"
                    placeholder="e.g. 2024"
                  />
                </div>
                <div class="field">
                  <label for="meta-language">Language</label>
                  <select
                    id="meta-language"
                    [(ngModel)]="languageValue"
                    class="field-input"
                  >
                    <option value="en">English</option>
                    <option value="es">Spanish</option>
                    <option value="fr">French</option>
                    <option value="de">German</option>
                    <option value="it">Italian</option>
                    <option value="pt">Portuguese</option>
                    <option value="nl">Dutch</option>
                    <option value="ru">Russian</option>
                    <option value="zh">Chinese</option>
                    <option value="ja">Japanese</option>
                    <option value="ko">Korean</option>
                    <option value="ar">Arabic</option>
                    <option value="hi">Hindi</option>
                    <option value="sv">Swedish</option>
                    <option value="no">Norwegian</option>
                    <option value="da">Danish</option>
                    <option value="fi">Finnish</option>
                    <option value="pl">Polish</option>
                    <option value="cs">Czech</option>
                    <option value="tr">Turkish</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="modal-footer">
          <button class="btn-cancel" (click)="cancel.emit()">Cancel</button>
          <button class="btn-confirm" (click)="onConfirm()" [disabled]="!titleValue.trim()">Import</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .modal-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1001;
      animation: fadeIn 0.15s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .modal-content {
      background: var(--bg-surface);
      border-radius: 12px;
      width: 520px;
      max-width: 90vw;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      animation: slideIn 0.2s ease-out;
    }

    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(-20px) scale(0.95);
      }
      to {
        opacity: 1;
        transform: translateY(0) scale(1);
      }
    }

    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid var(--border-subtle);

      h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary);
      }
    }

    .btn-close {
      background: none;
      border: none;
      font-size: 24px;
      color: var(--text-secondary);
      cursor: pointer;
      padding: 0;
      line-height: 1;

      &:hover {
        color: var(--text-primary);
      }
    }

    .modal-body {
      padding: 24px;
    }

    .metadata-layout {
      display: flex;
      gap: 20px;
    }

    .cover-section {
      flex-shrink: 0;
    }

    .cover-image {
      width: 120px;
      height: auto;
      max-height: 180px;
      object-fit: contain;
      border-radius: 4px;
      border: 1px solid var(--border-subtle);
    }

    .fields-section {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      flex: 1;

      label {
        font-size: 12px;
        font-weight: 500;
        color: var(--text-secondary);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
    }

    .field-row {
      display: flex;
      gap: 12px;
    }

    .field-input {
      padding: 8px 10px;
      border: 1px solid var(--border-input);
      border-radius: 6px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 14px;
      outline: none;
      width: 100%;
      box-sizing: border-box;

      &:focus {
        border-color: var(--accent);
        box-shadow: 0 0 0 2px rgba(6, 182, 212, 0.15);
      }
    }

    select.field-input {
      cursor: pointer;
    }

    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      padding: 16px 24px;
      border-top: 1px solid var(--border-subtle);
    }

    .btn-cancel {
      padding: 8px 16px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: transparent;
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .btn-confirm {
      padding: 8px 20px;
      border: none;
      border-radius: 6px;
      background: var(--color-primary);
      color: white;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;

      &:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  `]
})
export class ImportMetadataModalComponent implements OnInit {
  readonly initialMetadata = input.required<ImportMetadata>();
  readonly coverData = input<string | null>(null);

  readonly confirm = output<ImportMetadata>();
  readonly cancel = output<void>();

  titleValue = '';
  authorValue = '';
  yearValue = '';
  languageValue = 'en';

  ngOnInit(): void {
    const meta = this.initialMetadata();
    this.titleValue = meta.title;
    this.authorValue = meta.author;
    this.yearValue = meta.year;
    this.languageValue = meta.language || 'en';
  }

  @HostListener('document:keydown.escape')
  onEscapeKey(): void {
    this.cancel.emit();
  }

  onConfirm(): void {
    if (!this.titleValue.trim()) return;
    this.confirm.emit({
      title: this.titleValue.trim(),
      author: this.authorValue.trim() || 'Unknown',
      year: this.yearValue.trim(),
      language: this.languageValue,
    });
  }
}
