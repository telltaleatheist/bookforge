import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** One listenable thing in the project (an M4B, a bilingual pair, or a live-TTS EPUB). */
export interface ListenSource {
  id: string;
  type: 'mono-m4b' | 'bilingual-m4b' | 'epub';
  label: string;
  sublabel: string;
  /** Audio entries only: an EPUB is newer than this M4B */
  stale?: boolean;
  /** bilingual-m4b: key into item.bilingualOutputs */
  pairKey?: string;
  /** epub: absolute path to stream */
  epubPath?: string;
}

/**
 * ListenSourcePickerComponent — the compact "which source am I listening to"
 * dropdown, extracted from ListenWindowComponent so it can be re-projected into
 * the player's top bar (same row as the title + close). It owns only its open
 * state; the source list + current selection are inputs, and picking one emits.
 */
@Component({
  selector: 'app-listen-source-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="source-bar">
      <button class="source-btn" (click)="pickerOpen.set(!pickerOpen())" [title]="selectedSource()?.sublabel || 'Choose source'">
        <span class="source-icon">{{ selectedSource()?.type === 'epub' ? '📖' : '🎧' }}</span>
        <span class="source-label">{{ selectedSource()?.label || 'Choose source' }}</span>
        @if (selectedSource()?.stale) {
          <span class="stale-badge" title="An EPUB is newer than this audiobook — the book may have changed since it was produced">changed</span>
        }
        <span class="caret">▾</span>
      </button>
      @if (pickerOpen()) {
        <div class="picker-backdrop" (click)="pickerOpen.set(false)"></div>
        <div class="picker-menu">
          @if (audioSources().length > 0) {
            <div class="picker-group">Audiobook</div>
            @for (s of audioSources(); track s.id) {
              <button class="picker-item" [class.active]="s.id === selectedId()" (click)="pick(s)">
                <span class="picker-icon">🎧</span>
                <span class="picker-text">
                  <span class="picker-label">{{ s.label }}</span>
                  <span class="picker-sub">{{ s.sublabel }}</span>
                </span>
                @if (s.stale) {
                  <span class="stale-badge" title="An EPUB is newer than this audiobook — the book may have changed since it was produced">changed</span>
                }
              </button>
            }
          }
          @if (epubSources().length > 0) {
            <div class="picker-group">Text — live TTS</div>
            @for (s of epubSources(); track s.id) {
              <button class="picker-item" [class.active]="s.id === selectedId()" (click)="pick(s)">
                <span class="picker-icon">📖</span>
                <span class="picker-text">
                  <span class="picker-label">{{ s.label }}</span>
                  <span class="picker-sub">{{ s.sublabel }}</span>
                </span>
              </button>
            }
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .source-bar { position: relative; display: flex; align-items: center; }
    .source-btn {
      display: flex; align-items: center; gap: 6px; max-width: 190px;
      padding: 5px 10px; border: none; border-radius: 14px;
      background: var(--bg-elevated); color: var(--text-primary);
      font-size: 12px; cursor: pointer;
    }
    .source-btn:hover { background: var(--bg-hover); }
    .source-icon { flex-shrink: 0; }
    .source-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .caret { flex-shrink: 0; font-size: 10px; color: var(--text-secondary); }
    .stale-badge {
      flex-shrink: 0; padding: 2px 6px; border-radius: 8px;
      background: color-mix(in srgb, #f59e0b 18%, transparent);
      color: #f59e0b; font-size: 9px; white-space: nowrap;
    }
    .picker-backdrop { position: fixed; inset: 0; z-index: 90; }
    .picker-menu {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 91;
      min-width: 260px; max-height: 60vh; overflow-y: auto;
      background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: 12px; padding: 6px;
      box-shadow: 0 12px 34px rgba(0, 0, 0, 0.45);
    }
    .picker-group {
      padding: 8px 10px 4px; font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary);
    }
    .picker-item {
      display: flex; align-items: center; gap: 10px; width: 100%;
      padding: 8px 10px; border: none; border-radius: 8px;
      background: transparent; color: var(--text-primary);
      cursor: pointer; text-align: left;
    }
    .picker-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .picker-item.active { background: color-mix(in srgb, var(--accent) 22%, transparent); }
    .picker-icon { flex-shrink: 0; }
    .picker-text { display: flex; flex-direction: column; gap: 1px; flex: 1; min-width: 0; }
    .picker-label { font-size: 13px; }
    .picker-sub { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `],
})
export class ListenSourcePickerComponent {
  readonly audioSources = input<ListenSource[]>([]);
  readonly epubSources = input<ListenSource[]>([]);
  readonly selectedId = input<string>('');
  readonly select = output<ListenSource>();

  readonly pickerOpen = signal(false);
  readonly selectedSource = computed<ListenSource | null>(() =>
    [...this.audioSources(), ...this.epubSources()].find((s) => s.id === this.selectedId()) ?? null,
  );

  pick(source: ListenSource): void {
    this.pickerOpen.set(false);
    this.select.emit(source);
  }
}
