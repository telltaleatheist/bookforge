import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';
import { formatDuration } from '../shared/format';
import { AnalyticsBook, AnalyticsData } from '../models/types';

interface DayBar {
  key: string;      // YYYY-MM-DD
  seconds: number;
  weekday: string;  // M T W ...
  dayNum: number;
  monthDay: string; // "Jul 1"
}

/**
 * Reading analytics for the current reader: totals, a per-day listening
 * timeline (bar chart), and a per-book breakdown. Data comes from the server
 * keyed by the reader's token.
 */
@Component({
  selector: 'app-analytics',
  standalone: true,
  template: `
    @if (loading()) {
      <div class="state"><div class="spinner"></div></div>
    } @else if (error()) {
      <div class="state"><span class="icon">⚠️</span><p>{{ error() }}</p></div>
    } @else if (!data() || data()!.totalSeconds === 0) {
      <div class="state"><span class="icon">📊</span><p>No listening yet. Play a book and your stats will appear here.</p></div>
    } @else {
      <div class="summary">
        <div class="stat-card"><span class="v">{{ dur(data()!.totalSeconds) }}</span><span class="l">Total listened</span></div>
        <div class="stat-card"><span class="v">{{ data()!.books.length }}</span><span class="l">Books</span></div>
        <div class="stat-card"><span class="v">{{ dur(todaySeconds()) }}</span><span class="l">Today</span></div>
        <div class="stat-card"><span class="v">{{ dur(streakBestSeconds()) }}</span><span class="l">Best day</span></div>
      </div>

      <div class="section-title">Listening per day</div>
      <div class="chart">
        <div class="bars">
          @for (b of days(); track b.key) {
            <div class="bar-col" [title]="b.monthDay + ' · ' + (b.seconds ? dur(b.seconds) : 'nothing')">
              <div class="bar-wrap">
                <div class="bar" [class.empty]="b.seconds === 0" [style.height.%]="barPct(b.seconds)"></div>
              </div>
              <span class="bar-day">{{ b.weekday }}</span>
              <span class="bar-date">{{ b.dayNum }}</span>
            </div>
          }
        </div>
      </div>

      <div class="section-title">By book</div>
      <div class="book-list">
        @for (bk of data()!.books; track bk.bookPath) {
          <div class="book-row">
            <div class="book-meta">
              <span class="book-title">{{ bk.title || bookName(bk.bookPath) }}</span>
              @if (bk.author) { <span class="book-author">{{ bk.author }}</span> }
            </div>
            <div class="book-bar-wrap"><div class="book-bar" [style.width.%]="bookPct(bk.seconds)"></div></div>
            <span class="book-time">{{ dur(bk.seconds) }}</span>
            <button class="book-remove" [disabled]="removing() === bk.bookPath"
              (click)="removeBook(bk)" [title]="'Remove ' + (bk.title || bookName(bk.bookPath)) + ' from analytics'"
              aria-label="Remove from analytics">✕</button>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px 24px; color: var(--text-secondary); text-align: center; }
    .state .icon { font-size: 44px; }

    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .stat-card { background: var(--card-bg); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
    .stat-card .v { font-size: 20px; font-weight: 700; color: var(--accent); }
    .stat-card .l { font-size: 12px; color: var(--text-secondary); }

    .section-title { font-size: 13px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; margin: 8px 0 12px; }

    .chart { background: var(--card-bg); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 16px 12px 10px; margin-bottom: 24px; overflow-x: auto; }
    .bars { display: flex; align-items: flex-end; gap: 6px; min-height: 160px; }
    .bar-col { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 26px; flex: 1; }
    .bar-wrap { height: 140px; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
    .bar { width: 70%; max-width: 22px; min-height: 2px; border-radius: 4px 4px 0 0; background: linear-gradient(180deg, var(--accent-hover), var(--accent)); transition: height 0.3s ease; }
    .bar.empty { background: var(--bg-elevated); }
    .bar-day { font-size: 10px; color: var(--text-secondary); }
    .bar-date { font-size: 9px; color: var(--text-tertiary); }

    .book-list { display: flex; flex-direction: column; gap: 8px; }
    .book-row { display: flex; align-items: center; gap: 12px; background: var(--card-bg); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 12px 14px; }
    .book-meta { flex: 0 0 40%; min-width: 0; }
    .book-title { display: block; font-size: 14px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .book-author { display: block; font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .book-bar-wrap { flex: 1; height: 8px; background: var(--bg-elevated); border-radius: 4px; overflow: hidden; }
    .book-bar { height: 100%; background: var(--accent); border-radius: 4px; }
    .book-time { flex-shrink: 0; font-size: 12px; font-weight: 600; color: var(--text-secondary); font-variant-numeric: tabular-nums; min-width: 56px; text-align: right; }
    .book-remove { flex-shrink: 0; width: 26px; height: 26px; border: none; border-radius: 6px; background: transparent; color: var(--text-tertiary);
      font-size: 13px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .book-remove:hover { background: color-mix(in srgb, var(--error) 15%, transparent); color: var(--error); }
    .book-remove:disabled { opacity: 0.4; cursor: default; }
  `],
})
export class AnalyticsComponent implements OnInit {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);

  readonly data = signal<AnalyticsData | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly removing = signal<string | null>(null); // bookPath currently being removed

  readonly dur = formatDuration;

  readonly days = computed<DayBar[]>(() => {
    const d = this.data();
    if (!d) return [];
    return this.buildDays(d.daily, d.firstAt);
  });

  private readonly maxDaySeconds = computed(() =>
    Math.max(1, ...this.days().map((b) => b.seconds))
  );

  readonly todaySeconds = computed(() => {
    const d = this.data();
    return d ? (d.daily[this.todayKey()] || 0) : 0;
  });

  readonly streakBestSeconds = computed(() =>
    Math.max(0, ...Object.values(this.data()?.daily ?? {}))
  );

  async ngOnInit(): Promise<void> {
    const token = this.reader.token();
    if (!token) { this.error.set('Not signed in'); this.loading.set(false); return; }
    try {
      this.data.set(await this.api.getAnalytics(token));
    } catch {
      this.error.set('Could not load analytics.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Erase one book's listening history from analytics, then refresh totals. */
  async removeBook(bk: AnalyticsBook): Promise<void> {
    const token = this.reader.token();
    if (!token || this.removing()) return;
    const name = bk.title || this.bookName(bk.bookPath);
    if (!confirm(`Remove “${name}” from your analytics? Its ${this.dur(bk.seconds)} of listening will be erased.`)) return;
    this.removing.set(bk.bookPath);
    try {
      await this.api.removeAnalyticsBook(token, bk.bookPath);
      this.data.set(await this.api.getAnalytics(token));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not remove that book. Try again.');
    } finally {
      this.removing.set(null);
    }
  }

  barPct(seconds: number): number {
    return Math.round((seconds / this.maxDaySeconds()) * 100);
  }

  bookPct(seconds: number): number {
    const max = Math.max(1, ...(this.data()?.books ?? []).map((b) => b.seconds));
    return Math.round((seconds / max) * 100);
  }

  bookName(path: string): string {
    return path.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') || 'Unknown';
  }

  private todayKey(): string {
    return this.dateKey(new Date());
  }

  private dateKey(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** Continuous day series from the first recorded day (or 14 days ago) to today. */
  private buildDays(daily: Record<string, number>, firstAt: string | null): DayBar[] {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let start: Date;
    if (firstAt) {
      const [y, m, d] = firstAt.split('-').map(Number);
      start = new Date(y, m - 1, d);
    } else {
      start = new Date(today);
      start.setDate(start.getDate() - 13);
    }
    // Cap the span so a very long history stays scrollable but bounded per render.
    const maxDays = 365;
    const spanDays = Math.round((today.getTime() - start.getTime()) / 86_400_000);
    if (spanDays > maxDays) start.setDate(today.getDate() - maxDays);

    const wk = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const out: DayBar[] = [];
    const cur = new Date(start);
    while (cur.getTime() <= today.getTime()) {
      const key = this.dateKey(cur);
      out.push({
        key,
        seconds: daily[key] || 0,
        weekday: wk[cur.getDay()],
        dayNum: cur.getDate(),
        monthDay: `${months[cur.getMonth()]} ${cur.getDate()}`,
      });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }
}
