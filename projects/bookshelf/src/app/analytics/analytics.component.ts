import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';
import { ServerConfigService } from '../services/server-config.service';
import { formatDuration } from '../shared/format';
import { AnalyticsBook, AnalyticsData } from '../models/types';

type Range = 'day' | 'week' | 'month' | 'year';

interface Bar {
  key: string;
  seconds: number;
  label: string; // label under the bar: M/D (day/week), M/YY (month), YYYY (year)
  title: string; // tooltip descriptor ("Week of Jul 1" / "July 2026")
}

interface YTick {
  value: number;   // tick value in seconds
  label: string;   // "2h" / "30m"
  pct: number;     // 0–100, position from the bottom of the plot
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

      <div class="section-head">
        <div class="section-title">Listening per {{ range() }}</div>
        <div class="seg">
          <button [class.on]="range() === 'day'" (click)="range.set('day')">Daily</button>
          <button [class.on]="range() === 'week'" (click)="range.set('week')">Weekly</button>
          <button [class.on]="range() === 'month'" (click)="range.set('month')">Monthly</button>
          <button [class.on]="range() === 'year'" (click)="range.set('year')">Yearly</button>
        </div>
      </div>
      <div class="chart">
        <div class="plot">
          <div class="gridlines">
            @for (t of yTicks(); track t.value) {
              <div class="gridline" [style.bottom.%]="t.pct"></div>
            }
          </div>
          <div class="y-axis">
            @for (t of yTicks(); track t.value) {
              <span class="y-tick" [style.bottom.%]="t.pct">{{ t.label }}</span>
            }
          </div>
          <div class="bars-scroll">
            <div class="bars">
              @for (b of bars(); track b.key) {
                <div class="bar-col" [title]="b.title + ' · ' + (b.seconds ? dur(b.seconds) : 'nothing')">
                  <div class="bar-wrap">
                    <div class="bar" [class.empty]="b.seconds === 0" [style.height.%]="barPct(b.seconds)"></div>
                  </div>
                  <span class="bar-label">{{ b.label }}</span>
                </div>
              }
            </div>
          </div>
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

    .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 8px 0 12px; }
    .section-head .section-title { margin: 0; }
    .seg { display: inline-flex; background: var(--seg-bg); border-radius: 8px; padding: 2px; gap: 2px; flex-shrink: 0; }
    .seg button { border: none; background: transparent; color: var(--text-secondary); font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 6px; cursor: pointer; }
    .seg button.on { background: var(--seg-active); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0,0,0,0.16); }

    .chart { background: var(--card-bg); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 16px 12px 10px; margin-bottom: 24px; }
    .plot { position: relative; display: flex; align-items: flex-start; }
    .y-axis { position: relative; width: 40px; height: 140px; flex-shrink: 0; }
    .y-tick { position: absolute; right: 8px; transform: translateY(50%); font-size: 9px; line-height: 1; color: var(--text-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .gridlines { position: absolute; left: 40px; right: 0; top: 0; height: 140px; pointer-events: none; }
    .gridline { position: absolute; left: 0; right: 0; border-top: 1px solid var(--border-subtle); opacity: 0.6; }
    .bars-scroll { flex: 1; min-width: 0; overflow-x: auto; }
    .bars { display: flex; align-items: flex-end; gap: 6px; }
    .bar-col { display: flex; flex-direction: column; align-items: center; gap: 4px; min-width: 24px; flex: 1; }
    .bar-wrap { height: 140px; width: 100%; display: flex; align-items: flex-end; justify-content: center; position: relative; z-index: 1; }
    .bar { width: 70%; max-width: 22px; min-height: 2px; border-radius: 4px 4px 0 0; background: linear-gradient(180deg, var(--accent-hover), var(--accent)); transition: height 0.3s ease; }
    .bar.empty { background: var(--bg-elevated); }
    .bar-label { font-size: 9px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }

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
  private readonly cfg = inject(ServerConfigService);

  readonly data = signal<AnalyticsData | null>(null);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly removing = signal<string | null>(null); // bookPath currently being removed

  readonly dur = formatDuration;

  /** Chart granularity: last 14 days / 12 weeks / 12 months / 12 years. */
  readonly range = signal<Range>('day');

  readonly bars = computed<Bar[]>(() => {
    const d = this.data();
    if (!d) return [];
    switch (this.range()) {
      case 'day': return this.buildDays(d.daily);
      case 'week': return this.buildWeeks(d.daily);
      case 'month': return this.buildMonths(d.daily);
      case 'year': return this.buildYears(d.daily);
    }
  });

  /** Nice, zero-based Y-axis: ~4 ticks in whole hours or minutes, auto-picked by
   *  magnitude. Bar heights scale against the axis top so they line up with the
   *  gridlines. */
  readonly yTicks = computed<YTick[]>(() => this.buildAxis().ticks);

  private readonly axisTopSeconds = computed(() => this.buildAxis().topSeconds);

  readonly todaySeconds = computed(() => {
    const d = this.data();
    return d ? (d.daily[this.todayKey()] || 0) : 0;
  });

  readonly streakBestSeconds = computed(() =>
    Math.max(0, ...Object.values(this.data()?.daily ?? {}))
  );

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  /** Enabled servers this device is signed into, with their tokens. Analytics are
   *  fetched from each and merged, so "you" is your combined reading across every
   *  connected library. */
  private signedInServers(): { id: string; token: string }[] {
    return this.cfg.enabledServers()
      .map((s) => ({ id: s.id, token: this.reader.token(s.id) }))
      .filter((s): s is { id: string; token: string } => !!s.token);
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    const servers = this.signedInServers();
    if (!servers.length) { this.error.set('Not signed in'); this.loading.set(false); return; }
    try {
      const parts = (await Promise.all(
        servers.map((s) => this.api.getAnalytics(s.token, s.id).catch(() => null)),
      )).filter((p): p is AnalyticsData => !!p);
      if (!parts.length) throw new Error('unreachable');
      this.data.set(this.mergeAnalytics(parts));
    } catch {
      this.error.set('Could not load analytics.');
    } finally {
      this.loading.set(false);
    }
  }

  /** Combine per-server analytics into one view: sum totals + per-day, merge the
   *  same book (by bookPath) across servers into one row. Reading a title on two
   *  servers is genuinely more reading, so summing is correct — this is not the
   *  local↔server double-count case (see MULTI_SERVER.md). */
  private mergeAnalytics(parts: AnalyticsData[]): AnalyticsData {
    const daily: Record<string, number> = {};
    const books = new Map<string, AnalyticsBook>();
    let totalSeconds = 0;
    let firstAt: string | null = null;
    let lastAt: string | null = null;
    for (const p of parts) {
      totalSeconds += p.totalSeconds || 0;
      for (const [day, s] of Object.entries(p.daily || {})) daily[day] = (daily[day] || 0) + s;
      for (const b of p.books || []) {
        const cur = books.get(b.bookPath);
        if (cur) {
          cur.seconds += b.seconds;
          if (b.lastAt > cur.lastAt) { cur.lastAt = b.lastAt; if (b.title) cur.title = b.title; if (b.author) cur.author = b.author; }
        } else {
          books.set(b.bookPath, { ...b });
        }
      }
      if (p.firstAt && (!firstAt || p.firstAt < firstAt)) firstAt = p.firstAt;
      if (p.lastAt && (!lastAt || p.lastAt > lastAt)) lastAt = p.lastAt;
    }
    const r = this.reader.reader();
    return {
      reader: r ? { id: r.id, name: r.name } : parts[0].reader,
      totalSeconds,
      firstAt,
      lastAt,
      daily,
      books: [...books.values()].sort((a, b) => b.seconds - a.seconds),
    };
  }

  /** Erase one book's listening history from analytics across every signed-in
   *  server, then refresh the combined totals. */
  async removeBook(bk: AnalyticsBook): Promise<void> {
    if (this.removing()) return;
    const servers = this.signedInServers();
    if (!servers.length) return;
    const name = bk.title || this.bookName(bk.bookPath);
    if (!confirm(`Remove “${name}” from your analytics? Its ${this.dur(bk.seconds)} of listening will be erased.`)) return;
    this.removing.set(bk.bookPath);
    try {
      await Promise.all(
        servers.map((s) => this.api.removeAnalyticsBook(s.token, bk.bookPath, s.id).catch(() => { /* absent there */ })),
      );
      await this.reload();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not remove that book. Try again.');
    } finally {
      this.removing.set(null);
    }
  }

  barPct(seconds: number): number {
    const top = this.axisTopSeconds();
    return top > 0 ? Math.round((seconds / top) * 100) : 0;
  }

  /** Build a zero-based axis: work in hours if the tallest bar is ≥ 1h, else
   *  minutes; pick a nice step so we land ~4–5 gridlines. Floors the range at
   *  1 minute so a sparse chart still gets a sane axis. */
  private buildAxis(): { topSeconds: number; ticks: YTick[] } {
    const maxSeconds = Math.max(60, ...this.bars().map((b) => b.seconds));
    const useHours = maxSeconds >= 3600;
    const unit = useHours ? 3600 : 60; // seconds per axis unit
    const step = this.niceStep(maxSeconds / unit / 4); // in units
    const topUnits = Math.ceil(maxSeconds / unit / step) * step;
    const topSeconds = topUnits * unit;
    const ticks: YTick[] = [];
    for (let v = 0; v <= topUnits + 1e-9; v += step) {
      const clean = Number.isInteger(v) ? String(v) : v.toFixed(1);
      ticks.push({
        value: Math.round(v * unit),
        label: `${clean}${useHours ? 'h' : 'm'}`,
        pct: (v / topUnits) * 100,
      });
    }
    return { topSeconds, ticks };
  }

  /** Round up to a "nice" step (1, 2, 2.5, 5, 10 × 10ⁿ) for axis gridlines. */
  private niceStep(x: number): number {
    if (x <= 0) return 1;
    const exp = Math.floor(Math.log10(x));
    const base = Math.pow(10, exp);
    const f = x / base;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * base;
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

  private static readonly MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** Last 14 days, one bar per day, read straight from the daily map (0 if none). */
  private buildDays(daily: Record<string, number>): Bar[] {
    const months = AnalyticsComponent.MONTHS;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const out: Bar[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(start);
      d.setDate(d.getDate() - i);
      out.push({
        key: this.dateKey(d),
        seconds: daily[this.dateKey(d)] || 0,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        title: `${months[d.getMonth()]} ${d.getDate()}`,
      });
    }
    return out;
  }

  /** Last 12 weeks, one bar per week (Monday-start), summed from the daily map. */
  private buildWeeks(daily: Record<string, number>): Bar[] {
    const months = AnalyticsComponent.MONTHS;
    const weekStart = new Date();
    weekStart.setHours(0, 0, 0, 0);
    // Rewind to the Monday of the current week (getDay(): Sun=0 → Mon=0).
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

    const out: Bar[] = [];
    for (let i = 11; i >= 0; i--) {
      const ws = new Date(weekStart);
      ws.setDate(ws.getDate() - i * 7);
      let seconds = 0;
      const cur = new Date(ws);
      for (let d = 0; d < 7; d++) {
        seconds += daily[this.dateKey(cur)] || 0;
        cur.setDate(cur.getDate() + 1);
      }
      out.push({
        key: this.dateKey(ws),
        seconds,
        label: `${ws.getMonth() + 1}/${ws.getDate()}`,
        title: `Week of ${months[ws.getMonth()]} ${ws.getDate()}`,
      });
    }
    return out;
  }

  /** Last 12 months, one bar per calendar month, summed from the daily map. */
  private buildMonths(daily: Record<string, number>): Bar[] {
    const months = AnalyticsComponent.MONTHS;
    const now = new Date();
    const out: Bar[] = [];
    for (let i = 11; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const y = m.getFullYear();
      const mo = m.getMonth();
      let seconds = 0;
      for (const [k, s] of Object.entries(daily)) {
        const [ky, km] = k.split('-').map(Number);
        if (ky === y && km === mo + 1) seconds += s;
      }
      out.push({
        key: `${y}-${mo}`,
        seconds,
        label: `${mo + 1}/${String(y).slice(-2)}`,
        title: `${months[mo]} ${y}`,
      });
    }
    return out;
  }

  /** Last 12 years, one bar per calendar year, summed from the daily map. */
  private buildYears(daily: Record<string, number>): Bar[] {
    const nowYear = new Date().getFullYear();
    const out: Bar[] = [];
    for (let i = 11; i >= 0; i--) {
      const y = nowYear - i;
      let seconds = 0;
      for (const [k, s] of Object.entries(daily)) {
        if (Number(k.slice(0, 4)) === y) seconds += s;
      }
      out.push({
        key: String(y),
        seconds,
        label: String(y),
        title: String(y),
      });
    }
    return out;
  }
}
