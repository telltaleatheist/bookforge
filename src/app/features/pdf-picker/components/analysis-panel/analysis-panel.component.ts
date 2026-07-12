import { Component, input, output, computed, signal, effect, inject, ElementRef, Pipe, PipeTransform, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { TextBlock } from '../../services/pdf.service';
import { PanelShellComponent } from '../panel-shell/panel-shell.component';

@Pipe({ name: 'safeHtml', standalone: true })
class SafeHtmlPipe implements PipeTransform {
  private sanitizer = inject(DomSanitizer);
  transform(value: string): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(value);
  }
}

interface AnalysisFlag {
  categoryId: string;
  categoryName: string;
  categoryColor: string;
  quote: string;
  description: string;
  severity: 'low' | 'medium' | 'high';
  chapterId: string;
  chapterTitle: string;
  page?: number;
}

interface AnalysisCategory {
  id: string;
  name: string;
  color: string;
  enabled: boolean;
  flagCount: number;
}

/**
 * Statusless analysis & search tool (the old categories-panel `analysisOnly`
 * branch). Flags tab: color legend + chronological, expandable flag list.
 * Search tab: phrase/phonetic text search over blocks with highlighted,
 * navigable results. All search state is local to this panel.
 */
@Component({
  selector: 'app-analysis-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, PanelShellComponent, SafeHtmlPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-panel-shell title="Analysis & search" (close)="close.emit()">
      <div class="analysis-tabs">
        <button
          class="analysis-tab"
          [class.active]="analysisTab() === 'flags'"
          (click)="analysisTab.set('flags')"
        >
          Flags
          @if (flags().length > 0) {
            <span class="tab-badge">{{ flags().length }}</span>
          }
        </button>
        <button
          class="analysis-tab"
          [class.active]="analysisTab() === 'search'"
          (click)="analysisTab.set('search')"
        >
          Search
          @if (searchResults().length > 0) {
            <span class="tab-badge">{{ searchResults().length }}</span>
          }
        </button>
      </div>

      @if (analysisTab() === 'flags') {
        <div class="analysis-section">
          @if (flags().length > 0) {
            <div class="analysis-legend">
              @for (cat of analysisCategories(); track cat.id) {
                @if (cat.flagCount > 0) {
                  <div class="legend-item">
                    <span class="legend-color" [style.background]="cat.color"></span>
                    <span class="legend-name">{{ cat.name }}</span>
                    <span class="legend-count">{{ cat.flagCount }}</span>
                  </div>
                }
              }
            </div>

            @for (flag of sortedFlags(); track $index) {
              <div
                class="analysis-flag"
                [class.expanded]="expandedFlagIndex() === $index"
                [class.clickable]="flag.page !== undefined"
                [class.selected]="flag === selectedFlag()"
                [style.border-left-color]="flag.categoryColor"
                (click)="onFlagItemClick(flag, $index)"
              >
                <div class="flag-header">
                  <span class="category-dot" [style.background]="flag.categoryColor"></span>
                  <span class="flag-category-label">{{ flag.categoryName }}</span>
                  <span class="flag-chapter">{{ flag.chapterTitle }}</span>
                  @if (flag.page !== undefined) {
                    <span class="flag-page">p.{{ flag.page + 1 }}</span>
                  }
                </div>
                @if (expandedFlagIndex() === $index) {
                  <div class="flag-quote-full">"{{ flag.quote }}"</div>
                  <div class="flag-description-full">{{ flag.description }}</div>
                } @else {
                  <div class="flag-quote">"{{ flag.quote.length > 80 ? flag.quote.substring(0, 80) + '...' : flag.quote }}"</div>
                }
              </div>
            }
          } @else {
            <div class="empty-state">
              <p>No analysis results</p>
              <p class="empty-hint">Run content analysis from the version picker to see flags here</p>
            </div>
          }
        </div>
      } @else {
        <div class="search-section">
          <div class="search-input-wrapper">
            <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/>
              <path d="M21 21l-4.35-4.35"/>
            </svg>
            <input
              type="text"
              class="search-input"
              placeholder="Search text..."
              [ngModel]="searchQuery()"
              (ngModelChange)="onSearchQueryChange($event)"
            />
            @if (searchQuery()) {
              <button class="clear-search" (click)="clearSearch()">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 6L6 18M6 6l12 12"/>
                </svg>
              </button>
            }
          </div>
          <div class="search-options">
            <label class="search-option" title="Match words consecutively as a phrase">
              <input type="checkbox" [ngModel]="searchPhraseMode()" (ngModelChange)="searchPhraseMode.set($event)" />
              Phrase
            </label>
            <label class="search-option" title="Match similar-sounding words (Soundex + Levenshtein)">
              <input type="checkbox" [ngModel]="searchPhoneticMode()" (ngModelChange)="searchPhoneticMode.set($event)" />
              Phonetic
            </label>
          </div>
          @if (searchQuery()) {
            <div class="search-status">
              {{ searchResults().length }} {{ searchResults().length === 1 ? 'match' : 'matches' }}
            </div>
          }
          <div class="search-results-list">
            @for (result of searchResults().slice(0, 200); track $index) {
              <div class="search-result clickable" (click)="onSearchResultClick(result)">
                <span class="result-page">p.{{ result.page + 1 }}</span>
                <span class="result-text" [innerHTML]="result.highlightedText | safeHtml"></span>
              </div>
            }
            @if (searchResults().length > 200) {
              <div class="search-more">...and {{ searchResults().length - 200 }} more</div>
            }
          </div>
        </div>
      }
    </app-panel-shell>
  `,
  styles: [`
    @use '../../../../creamsicle-desktop/styles/variables' as *;

    :host { display: contents; }

    ::ng-deep mark {
      background: rgba(255, 213, 79, 0.4);
      color: inherit;
      padding: 0 1px;
      border-radius: 2px;
    }

    .analysis-tabs {
      display: flex;
      border-bottom: 1px solid var(--border-subtle);
      margin: calc(-1 * var(--ui-spacing-lg)) calc(-1 * var(--ui-spacing-lg)) var(--ui-spacing-sm);
      position: sticky;
      top: calc(-1 * var(--ui-spacing-lg));
      background: var(--bg-surface);
      z-index: 1;
    }

    .analysis-tab {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border: none;
      background: transparent;
      color: var(--text-secondary);
      font-size: var(--ui-font-sm);
      font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: all 0.15s ease;

      &:hover {
        color: var(--text-primary);
        background: var(--hover-bg);
      }

      &.active {
        color: var(--accent);
        border-bottom-color: var(--accent);
      }

      .tab-badge {
        font-size: 10px;
        padding: 1px 6px;
        background: var(--bg-subtle);
        border-radius: 8px;
        font-weight: 600;
      }

      &.active .tab-badge {
        background: var(--accent-subtle);
        color: var(--accent);
      }
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--text-tertiary);
      font-size: var(--ui-font-sm);
      text-align: center;
    }

    .empty-hint {
      font-size: var(--ui-font-xs);
      color: var(--text-tertiary);
      margin-top: 4px;
    }

    .analysis-section {
      padding-top: var(--ui-spacing-xs);
    }

    .analysis-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 6px var(--ui-spacing-md);
      padding: var(--ui-spacing-sm) 0;
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: var(--ui-spacing-xs);
    }

    .legend-item {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--text-secondary);
    }

    .legend-color {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .legend-name { white-space: nowrap; }

    .legend-count {
      color: var(--text-tertiary);
      font-weight: 600;
    }

    .analysis-flag {
      padding: var(--ui-spacing-sm) var(--ui-spacing-md);
      border-left: 3px solid transparent;
      cursor: pointer;
      transition: background 0.1s ease;

      &:hover { background: var(--hover-bg); }

      &.selected {
        background: var(--accent-subtle);
        box-shadow: inset 0 0 0 1px var(--accent);
      }

      &.expanded {
        background: var(--bg-elevated);
        border-left-width: 4px;
        padding-bottom: var(--ui-spacing-md);
      }

      & + .analysis-flag {
        border-top: 1px solid var(--border-subtle);
      }
    }

    .flag-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 3px;
    }

    .category-dot {
      width: 8px;
      height: 8px;
      border-radius: 2px;
      flex-shrink: 0;
    }

    .flag-category-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .flag-chapter {
      font-size: 10px;
      color: var(--text-tertiary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .flag-page {
      margin-left: auto;
      font-size: 9px;
      color: var(--accent);
      font-weight: 600;
      flex-shrink: 0;
    }

    .flag-quote {
      font-size: 11px;
      color: var(--text-secondary);
      font-style: italic;
      line-height: 1.4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .flag-quote-full {
      font-size: 12px;
      color: var(--text-primary);
      font-style: italic;
      line-height: 1.5;
      margin: var(--ui-spacing-xs) 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .flag-description-full {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .search-section { padding-top: var(--ui-spacing-xs); }

    .search-input-wrapper {
      position: relative;
      display: flex;
      align-items: center;

      .search-icon {
        position: absolute;
        left: 8px;
        color: var(--text-tertiary);
        pointer-events: none;
      }

      .search-input {
        width: 100%;
        padding: var(--ui-spacing-sm) var(--ui-spacing-sm) var(--ui-spacing-sm) 30px;
        border: 1px solid var(--border-default);
        border-radius: $radius-sm;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: var(--ui-font-sm);

        &:focus {
          outline: none;
          border-color: var(--accent);
        }

        &::placeholder { color: var(--text-tertiary); }
      }

      .clear-search {
        position: absolute;
        right: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        border: none;
        background: var(--bg-subtle);
        border-radius: 50%;
        cursor: pointer;
        color: var(--text-secondary);
        padding: 0;

        &:hover {
          background: var(--hover-bg);
          color: var(--text-primary);
        }
      }
    }

    .search-options {
      display: flex;
      gap: var(--ui-spacing-md);
      padding: var(--ui-spacing-xs) 0;
    }

    .search-option {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      cursor: pointer;

      input[type="checkbox"] {
        width: 13px;
        height: 13px;
        margin: 0;
        accent-color: var(--accent);
        cursor: pointer;
      }
    }

    .search-status {
      font-size: var(--ui-font-xs);
      color: var(--text-secondary);
      padding: var(--ui-spacing-xs) 0;
    }

    .search-results-list { margin-top: var(--ui-spacing-xs); }

    .search-result {
      display: flex;
      gap: var(--ui-spacing-sm);
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      font-size: 11px;
      border-bottom: 1px solid var(--border-subtle);
      align-items: flex-start;

      &:last-child { border-bottom: none; }

      &.clickable {
        cursor: pointer;
        &:hover { background: var(--accent-subtle); }
      }

      .result-page {
        color: var(--accent);
        font-weight: 600;
        flex-shrink: 0;
        width: 32px;
        padding-top: 1px;
      }

      .result-text {
        color: var(--text-primary);
        line-height: 1.4;
        word-break: break-word;
      }
    }

    .search-more {
      padding: var(--ui-spacing-xs) var(--ui-spacing-sm);
      font-size: 10px;
      color: var(--text-tertiary);
      font-style: italic;
    }
  `],
})
export class AnalysisPanelComponent {
  readonly flags = input.required<AnalysisFlag[]>();
  readonly analysisCategories = input.required<AnalysisCategory[]>();
  readonly blocks = input.required<TextBlock[]>();
  readonly selectedFlagIndex = input<number>(-1);

  readonly close = output<void>();
  readonly navigateToFlag = output<{
    page: number;
    categoryId?: string;
    color?: string;
    blockText?: string;
  }>();

  private readonly el = inject(ElementRef);

  readonly analysisTab = signal<'flags' | 'search'>('flags');
  readonly expandedFlagIndex = signal<number>(-1);

  // Search state — local to this panel.
  readonly searchQuery = signal('');
  readonly searchPhraseMode = signal(false);
  readonly searchPhoneticMode = signal(false);
  private readonly debouncedSearchQuery = signal('');
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  readonly sortedFlags = computed(() => {
    const flags = this.flags();
    if (!flags.length) return flags;
    return [...flags].sort((a, b) => {
      const pa = a.page ?? Infinity;
      const pb = b.page ?? Infinity;
      return pa - pb;
    });
  });

  readonly selectedFlag = computed(() => {
    const idx = this.selectedFlagIndex();
    if (idx < 0) return null;
    return this.flags()[idx] ?? null;
  });

  private readonly scrollToFlagEffect = effect(() => {
    const flag = this.selectedFlag();
    if (!flag) return;
    const sorted = this.sortedFlags();
    const sortedIdx = sorted.indexOf(flag);
    if (sortedIdx >= 0) {
      this.expandedFlagIndex.set(sortedIdx);
    }
    setTimeout(() => {
      const el = this.el.nativeElement.querySelector('.analysis-flag.selected');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 0);
  });

  readonly searchResults = computed(() => {
    const query = this.debouncedSearchQuery().trim();
    if (!query) return [];

    const blocks = this.blocks();
    if (!blocks.length) return [];

    const results: Array<{ page: number; text: string; highlightedText: string }> = [];
    for (const block of blocks) {
      if (!block.text) continue;
      if (this.matchesQuery(query, block.text)) {
        results.push({
          page: block.page,
          text: block.text,
          highlightedText: this.highlightMatch(query, block.text),
        });
      }
    }
    return results;
  });

  onFlagItemClick(flag: { page?: number; categoryId?: string; categoryColor?: string }, index: number): void {
    if (this.expandedFlagIndex() === index) {
      this.expandedFlagIndex.set(-1);
    } else {
      this.expandedFlagIndex.set(index);
      if (flag.page !== undefined) {
        this.navigateToFlag.emit({ page: flag.page, categoryId: flag.categoryId, color: flag.categoryColor });
      }
    }
  }

  // --- Search ---

  onSearchQueryChange(value: string): void {
    this.searchQuery.set(value);
    if (this.searchDebounceTimer) clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = setTimeout(() => {
      this.searchDebounceTimer = null;
      this.debouncedSearchQuery.set(value);
    }, 200);
  }

  clearSearch(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
    }
    this.searchQuery.set('');
    this.debouncedSearchQuery.set('');
  }

  onSearchResultClick(result: { page: number; text: string }): void {
    this.navigateToFlag.emit({ page: result.page, blockText: result.text, color: '#FFD54F' });
  }

  matchesQuery(query: string, text: string): boolean {
    if (!query || !text) return false;
    const trimmed = query.trim();
    if (!trimmed) return false;

    if (/\s+(AND|OR|NOT)\s+/.test(trimmed)) {
      return this.evaluateBooleanQuery(trimmed, text);
    } else if (this.searchPhraseMode()) {
      return this.matchesPhrase(trimmed, text);
    } else {
      return this.matchesAnyWord(trimmed, text);
    }
  }

  private matchesAnyWord(query: string, text: string): boolean {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    for (const searchWord of words) {
      if (textLower.includes(searchWord)) return true;
      if (this.searchPhoneticMode() && searchWord.length >= 3) {
        for (const textWord of textWords) {
          if (this.wordsMatchPhonetically(searchWord, textWord)) return true;
        }
      }
    }
    return false;
  }

  private matchesPhrase(query: string, text: string): boolean {
    const textLower = text.toLowerCase();
    const textWords = textLower.split(/\s+/).filter(w => w.length > 0);

    const exactMatch = query.match(/^"([^"]+)"$/);
    if (exactMatch) {
      return textLower.includes(exactMatch[1].toLowerCase());
    }

    const searchWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    if (searchWords.length === 0) return false;

    for (let start = 0; start <= textWords.length - searchWords.length; start++) {
      let allMatch = true;
      for (let i = 0; i < searchWords.length; i++) {
        const tw = textWords[start + i];
        const sw = searchWords[i];
        if (this.searchPhoneticMode()) {
          if (!this.wordsMatchPhonetically(sw, tw)) { allMatch = false; break; }
        } else {
          if (!tw.includes(sw)) { allMatch = false; break; }
        }
      }
      if (allMatch) return true;
    }
    return false;
  }

  private wordsMatchPhonetically(search: string, text: string): boolean {
    if (text === search) return true;
    if (search.length <= 2) return text === search;
    if (search.length >= 3 && text.includes(search)) return true;

    if (this.searchPhoneticMode() && search.length >= 3) {
      const ss = this.soundex(search);
      const ts = this.soundex(text);
      if (ss && ts && ss === ts && ss !== '0000') return true;

      const maxDist = Math.max(1, Math.floor(search.length / 3));
      if (this.levenshteinDistance(search, text) <= maxDist) return true;
    }
    return false;
  }

  private evaluateBooleanQuery(query: string, line: string): boolean {
    let processed = query;

    const orPattern = /("?[\w]+"?)\s+OR\s+("?[\w]+"?)/g;
    for (const match of [...query.matchAll(orPattern)]) {
      const a = this.termMatches(match[1], line);
      const b = this.termMatches(match[2], line);
      processed = processed.replace(match[0], (a || b) ? 'TRUE' : 'FALSE');
    }

    const andPattern = /("?[\w]+"?)\s+AND\s+("?[\w]+"?)/g;
    for (const match of [...processed.matchAll(andPattern)]) {
      const a = match[1] === 'TRUE' || match[1] === 'FALSE' ? match[1] === 'TRUE' : this.termMatches(match[1], line);
      const b = match[2] === 'TRUE' || match[2] === 'FALSE' ? match[2] === 'TRUE' : this.termMatches(match[2], line);
      processed = processed.replace(match[0], (a && b) ? 'TRUE' : 'FALSE');
    }

    const notPattern = /("?[\w]+"?)\s+NOT\s+("?[\w]+"?)/g;
    for (const match of [...processed.matchAll(notPattern)]) {
      const a = match[1] === 'TRUE' || match[1] === 'FALSE' ? match[1] === 'TRUE' : this.termMatches(match[1], line);
      const b = match[2] === 'TRUE' || match[2] === 'FALSE' ? match[2] === 'TRUE' : this.termMatches(match[2], line);
      processed = processed.replace(match[0], (a && !b) ? 'TRUE' : 'FALSE');
    }

    if (!/\s+(AND|OR|NOT)\s+/.test(query)) {
      return this.termMatches(query, line);
    }
    return processed.includes('TRUE');
  }

  private termMatches(term: string, text: string): boolean {
    const clean = term.replace(/"/g, '').toLowerCase();
    return text.toLowerCase().includes(clean);
  }

  private soundex(word: string): string {
    if (!word || word.length === 0) return '0000';
    const clean = word.toUpperCase().replace(/[^A-Z]/g, '');
    if (clean.length === 0) return '0000';

    const codes: Record<string, string> = {
      'B': '1', 'F': '1', 'P': '1', 'V': '1',
      'C': '2', 'G': '2', 'J': '2', 'K': '2', 'Q': '2', 'S': '2', 'X': '2', 'Z': '2',
      'D': '3', 'T': '3',
      'L': '4',
      'M': '5', 'N': '5',
      'R': '6',
    };

    let result = clean[0];
    let prevCode = codes[clean[0]] || '';

    for (let i = 1; i < clean.length && result.length < 4; i++) {
      const code = codes[clean[i]];
      if (code && code !== prevCode) {
        result += code;
        prevCode = code;
      } else if (!code) {
        prevCode = '';
      }
    }
    return (result + '000').substring(0, 4);
  }

  private levenshteinDistance(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    let prev = Array(n + 1).fill(0).map((_, i) => i);
    let curr = Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      [prev, curr] = [curr, prev];
    }
    return prev[n];
  }

  private highlightMatch(query: string, text: string): string {
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const maxLen = 120;
    const truncated = escaped.length > maxLen ? escaped.substring(0, maxLen) + '...' : escaped;

    const terms = query.replace(/"/g, '').split(/\s+/).filter(w => w.length > 0 && !['AND', 'OR', 'NOT'].includes(w));
    let result = truncated;
    for (const term of terms) {
      const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      result = result.replace(regex, '<mark>$&</mark>');
    }
    return result;
  }
}
