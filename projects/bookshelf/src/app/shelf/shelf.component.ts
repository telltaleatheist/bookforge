import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { UpperCasePipe } from '@angular/common';
import { Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ThemeService } from '../services/theme.service';
import { VisibleDirective } from '../shared/visible.directive';
import { IconComponent } from '../shared/icon.component';
import { formatDuration, formatSize } from '../shared/format';
import { looseMatch } from '../shared/search';
import { encodePathId } from '../shared/path-id';
import { PlayerService } from '../services/player.service';
import { ReaderService } from '../services/reader.service';
import { ReaderStateService } from '../services/reader-state.service';
import { AnalyticsComponent } from '../analytics/analytics.component';
import { Audiobook, AudiobookVersion, Ebook, EbookVersion, QueueData, QueueJob } from '../models/types';

type Tab = 'audiobooks' | 'ebooks' | 'queue' | 'analytics';
type Sort = 'title' | 'date';

@Component({
  selector: 'app-shelf',
  standalone: true,
  imports: [VisibleDirective, UpperCasePipe, IconComponent, AnalyticsComponent],
  template: `
    <nav class="navbar">
      <div class="nav-title">
        <span class="logo">📚</span>
        <h1>Bookshelf</h1>
      </div>
      <div class="nav-controls">
        <div class="tab-toggle">
          <button class="tab-btn" [class.active]="tab() === 'audiobooks'" (click)="setTab('audiobooks')">Audiobooks</button>
          <button class="tab-btn" [class.active]="tab() === 'ebooks'" (click)="setTab('ebooks')">Ebooks</button>
          <button class="tab-btn" [class.active]="tab() === 'queue'" (click)="setTab('queue')">Queue</button>
          @if (readerSvc.supported()) {
            <button class="tab-btn" [class.active]="tab() === 'analytics'" (click)="setTab('analytics')">Analytics</button>
          }
        </div>
        @if (readerSvc.reader(); as r) {
          <button class="reader-chip" (click)="readerSvc.switchReader()" [title]="'Switch reader (' + r.name + ')'">
            {{ initial(r.name) }}
          </button>
        }
        <button class="theme-toggle" (click)="theme.toggle()" title="Toggle theme">
          {{ theme.theme() === 'dark' ? '☀️' : '🌙' }}
        </button>
      </div>
    </nav>

    @if (tab() === 'audiobooks' || tab() === 'ebooks') {
      <div class="stats-bar">
        <div class="stat">
          <span class="stat-value">{{ visibleCount() }}</span>
          <span class="stat-label">{{ tab() === 'audiobooks' ? 'Audiobooks' : 'Ebooks' }}</span>
        </div>
        <button class="refresh-btn" [class.spinning]="refreshing()" (click)="refresh()" title="Refresh">
          <svg viewBox="0 0 24 24" width="16" height="16"><path d="M17.65 6.35A7.96 7.96 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" fill="currentColor"/></svg>
        </button>
        <div class="sort-toggle">
          <button class="sort-btn" [class.active]="sort() === 'title'" (click)="setSort('title')">A-Z</button>
          <button class="sort-btn" [class.active]="sort() === 'date'" (click)="setSort('date')">Recent</button>
        </div>
      </div>

      @if (tags().length > 0) {
        <div class="category-bar">
          <button class="category-pill" [class.active]="activeTag() === 'all'" (click)="setTag('all')">All ({{ totalForTab() }})</button>
          @for (t of tags(); track t) {
            <button class="category-pill" [class.active]="activeTag() === t" (click)="setTag(t)">{{ t }}</button>
          }
        </div>
      }

      <div class="search-container">
        <input class="search-box" type="text" [placeholder]="tab() === 'audiobooks' ? 'Search audiobooks...' : 'Search ebooks...'"
          [value]="search()" (input)="search.set($any($event.target).value)" />
        @if (search()) {
          <button class="clear-search" (click)="search.set('')">✕</button>
        }
      </div>
    }

    <main class="content" [class.has-mini]="player.book() || readerState.session()">
      @if (tab() === 'analytics') {
        <app-analytics />
      } @else if (tab() === 'queue') {
        <!-- Minimal queue view: a flat status list. Rebuilt with richer features later. -->
        <div class="queue-bar">
          <div class="queue-controls">
            @if (queue()?.isRunning) {
              <button class="queue-ctrl-btn" (click)="queueControl('pause')" title="Pause queue">⏸</button>
            } @else {
              <button class="queue-ctrl-btn" (click)="queueControl('start')" title="Start queue">▶</button>
            }
          </div>
          <div class="stat">
            <span class="stat-value">{{ activeJobs().length }}</span>
            <span class="stat-label">Active jobs</span>
          </div>
        </div>
        @if (activeJobs().length === 0) {
          <div class="empty-state"><span class="empty-icon">📋</span><p>No active jobs</p></div>
        } @else {
          <div class="queue-jobs">
            @for (job of activeJobs(); track job.id) {
              <div class="queue-job" [class]="'status-' + job.status">
                <div class="queue-job-header">
                  <span class="queue-job-title">{{ job.title || job.epubFilename || job.id }}</span>
                  <span class="queue-job-status" [class]="'status-' + job.status">{{ job.status }}</span>
                </div>
                <div class="queue-job-progress">
                  <div class="queue-progress-bar"><div class="queue-progress-fill" [style.width.%]="job.progress || 0"></div></div>
                  <span class="queue-progress-pct">{{ round(job.progress || 0) }}%</span>
                </div>
                @if (jobMessage(job)) { <div class="queue-job-message">{{ jobMessage(job) }}</div> }
              </div>
            }
          </div>
        }
      } @else if (loading()) {
        <div class="loading-indicator"><div class="spinner"></div><span>Loading…</span></div>
      } @else if (loadError()) {
        <div class="empty-state"><span class="empty-icon">⚠️</span><p>{{ loadError() }}</p></div>
      } @else if (visibleCount() === 0) {
        <div class="empty-state"><span class="empty-icon">📭</span><p>Nothing here yet</p></div>
      } @else if (tab() === 'audiobooks') {
        <div class="books-grid">
          @for (book of filteredAudiobooks(); track book.downloadPath) {
            <div class="book-card" [class.external]="book.source === 'external'" (click)="openPlayer(book)">
              <div class="book-cover" [class.square-cover]="squareCovers().has(book.downloadPath)"
                appVisible (visible)="loadAudioCover(book)">
                @if (covers().get(book.downloadPath); as src) {
                  <img [src]="src" alt="Cover" (load)="onCoverLoad(book.downloadPath, $event)" />
                } @else {
                  <span class="placeholder">🎧</span>
                }
                <span class="book-type-badge m4b">{{ badge(book) }}</span>
              </div>
              <div class="book-info">
                <div class="book-title" [title]="book.title">{{ book.title }}</div>
                @if (book.author) { <div class="book-author">{{ book.author }}</div> }
                <div class="book-size">{{ sizeAndDuration(book) }}</div>
              </div>
            </div>
          }
        </div>
      } @else {
        <div class="books-grid">
          @for (book of filteredEbooks(); track book.relativePath) {
            <div class="book-card" (click)="openEbook(book)">
              <div class="book-cover" [class.square-cover]="squareCovers().has(book.relativePath)"
                appVisible (visible)="loadEbookCover(book)">
                @if (covers().get(book.relativePath); as src) {
                  <img [src]="src" alt="Cover" (load)="onCoverLoad(book.relativePath, $event)" />
                } @else {
                  <span class="placeholder">📖</span>
                }
                <span class="book-type-badge" [class]="'format-' + book.format">{{ (book.format || 'epub') | uppercase }}</span>
                <button class="corner-btn" (click)="downloadEbook(book, $event)" title="Download">
                  <app-icon name="download" [size]="15" />
                </button>
              </div>
              <div class="book-info">
                <div class="book-title" [title]="book.title">{{ book.title }}</div>
                @if (ebookAuthor(book)) { <div class="book-author">{{ ebookAuthor(book) }}</div> }
                <div class="book-size">{{ formatSize(book.fileSize) }}{{ book.year ? ' · ' + book.year : '' }}</div>
              </div>
            </div>
          }
        </div>
      }
    </main>

    <!-- Version picker: shown when a tapped book has more than one version. -->
    @if (pickerBook(); as pb) {
      <div class="picker-backdrop" (click)="closePicker()"></div>
      <div class="picker-sheet" [class.above-mini]="!!player.book()" role="dialog" aria-label="Choose a version">
        <div class="picker-head">
          <span>Choose a version</span>
          <button class="picker-close" (click)="closePicker()" aria-label="Close">×</button>
        </div>
        <div class="picker-sub">{{ pb.title }}</div>
        <div class="picker-body">
          @for (v of pb.versions; track v.downloadPath) {
            <button class="picker-item" (click)="choosePlayerVersion(pb, v)">
              <span class="picker-icon">{{ v.type === 'bilingual' ? '🌐' : '🎧' }}</span>
              <span class="picker-info">
                <span class="picker-title">{{ versionLabel(v) }}</span>
                <span class="picker-meta">{{ versionSub(v) }}</span>
              </span>
            </button>
          }
        </div>
      </div>
    }

    @if (pickerEbook(); as pe) {
      <div class="picker-backdrop" (click)="closePicker()"></div>
      <div class="picker-sheet" [class.above-mini]="!!player.book()" role="dialog" aria-label="Choose a version">
        <div class="picker-head">
          <span>Choose a version</span>
          <button class="picker-close" (click)="closePicker()" aria-label="Close">×</button>
        </div>
        <div class="picker-sub">{{ pe.title }}</div>
        <div class="picker-body">
          @for (v of pe.versions; track v.relativePath) {
            <button class="picker-item" (click)="chooseEbookVersion(pe, v)">
              <span class="picker-icon">📖</span>
              <span class="picker-info">
                <span class="picker-title">{{ ebookVersionLabel(v) }}</span>
                <span class="picker-meta">{{ ebookVersionSub(v) }}</span>
              </span>
            </button>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    /* Version picker (bottom sheet) */
    .picker-backdrop { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.5); animation: pkFade 0.15s ease; }
    @keyframes pkFade { from { opacity: 0; } to { opacity: 1; } }
    .picker-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 301; max-height: 70%; display: flex; flex-direction: column;
      background: var(--bg-elevated); border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom);
      box-shadow: 0 -8px 30px rgba(0,0,0,0.35); animation: pkUp 0.2s ease-out; }
    /* When the mini-player is on screen, start the sheet above it so it isn't
       hidden behind the bar (mini-player height ≈ 83px + safe area). */
    .picker-sheet.above-mini { bottom: calc(83px + env(safe-area-inset-bottom)); padding-bottom: 0; }
    @keyframes pkUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .picker-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; font-weight: 600; }
    .picker-close { border: none; background: transparent; color: var(--text-tertiary); font-size: 24px; line-height: 1; cursor: pointer; width: 32px; height: 32px; border-radius: 8px; }
    .picker-sub { padding: 0 16px 10px; color: var(--text-tertiary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--border-subtle); }
    .picker-body { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 6px; }
    .picker-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .picker-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .picker-icon { font-size: 20px; flex-shrink: 0; }
    .picker-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .picker-title { font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .picker-meta { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .navbar { position: sticky; top: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between;
      padding: calc(12px + env(safe-area-inset-top)) 16px 12px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle);
      backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); gap: 8px; }
    .nav-title { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
    .logo { font-size: 24px; }
    .navbar h1 { font-size: 18px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nav-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .theme-toggle { width: 40px; height: 40px; border: none; background: var(--bg-elevated); border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 18px; }
    .reader-chip { width: 32px; height: 32px; flex-shrink: 0; border: none; border-radius: 50%; cursor: pointer;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: #fff; font-size: 13px; font-weight: 700;
      display: flex; align-items: center; justify-content: center; }
    .tab-toggle { display: flex; background: var(--bg-elevated); border-radius: 8px; padding: 2px; gap: 2px; }
    .tab-btn { padding: 6px 10px; border: none; background: transparent; color: var(--text-tertiary); font-size: 12px; font-weight: 500;
      border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .tab-btn.active { background: var(--accent); color: #fff; }
    .stats-bar { display: flex; align-items: center; gap: 24px; padding: 12px 16px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle); }
    .refresh-btn { width: 36px; height: 36px; border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 15%, var(--bg-elevated));
      border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--accent); }
    .refresh-btn.spinning svg { animation: spin 0.6s linear infinite; }
    .sort-toggle { display: flex; background: var(--bg-elevated); border-radius: 8px; padding: 2px; gap: 2px; margin-left: auto; }
    .sort-btn { padding: 6px 14px; border: none; background: transparent; color: var(--text-tertiary); font-size: 13px; font-weight: 500; border-radius: 6px; cursor: pointer; }
    .sort-btn.active { background: var(--accent); color: #fff; }
    .stat { display: flex; align-items: baseline; gap: 6px; }
    .stat-value { font-size: 20px; font-weight: 700; color: var(--accent); }
    .stat-label { font-size: 13px; color: var(--text-secondary); }
    .category-bar { display: flex; gap: 8px; padding: 10px 16px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle);
      overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
    .category-bar::-webkit-scrollbar { display: none; }
    .category-pill { flex-shrink: 0; padding: 5px 12px; border: 1px solid var(--border-subtle); background: transparent; color: var(--text-secondary);
      font-size: 12px; font-weight: 500; border-radius: 16px; cursor: pointer; white-space: nowrap; }
    .category-pill.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .search-container { position: relative; padding: 12px 16px; background: var(--bg-surface); }
    .search-box { width: 100%; padding: 12px 40px 12px 16px; font-size: 16px; background: var(--bg-elevated); border: 1px solid var(--border-subtle);
      border-radius: 8px; color: var(--text-primary); outline: none; }
    .search-box:focus { border-color: var(--accent); }
    .clear-search { position: absolute; right: 28px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; border: none;
      background: var(--bg-hover); border-radius: 50%; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
    .content { padding: 16px; padding-bottom: calc(16px + env(safe-area-inset-bottom)); }
    .content.has-mini { padding-bottom: calc(104px + env(safe-area-inset-bottom)); }
    .loading-indicator { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 48px; color: var(--text-secondary); }
    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px; color: var(--text-secondary); text-align: center; }
    .empty-icon { font-size: 48px; }
    .books-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 12px; }
    .book-card { display: flex; flex-direction: column; background: var(--card-bg); border-radius: 8px; overflow: hidden; cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s; }
    .book-card:active { transform: scale(0.97); }
    .book-card.external { outline: 2px solid #7c4dff; outline-offset: -2px; }
    .book-cover { position: relative; aspect-ratio: 2 / 3; background: var(--bg-elevated); display: flex; align-items: center; justify-content: center; }
    .book-cover img { width: 100%; height: 100%; object-fit: cover; }
    /* Audiobook art is usually square — give those cards a square frame so the
       cover fills it edge-to-edge instead of being letterboxed in a 2:3 box. */
    .book-cover.square-cover { aspect-ratio: 1 / 1; }
    .book-cover.square-cover img { object-fit: cover; }
    .book-cover .placeholder { font-size: 48px; color: var(--text-tertiary); }
    .corner-btn { position: absolute; top: 6px; left: 6px; width: 30px; height: 30px; border: none; border-radius: 8px;
      background: rgba(0,0,0,0.62); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    .corner-btn:active { transform: scale(0.92); }
    .book-type-badge { position: absolute; top: 6px; right: 6px; padding: 2px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase;
      background: rgba(0,0,0,0.7); color: #fff; border-radius: 4px; }
    .book-type-badge.m4b { background: #8b5cf6; }
    .book-type-badge.format-epub { background: rgba(46,125,50,0.9); }
    .book-type-badge.format-pdf { background: rgba(198,40,40,0.9); }
    .book-type-badge.format-azw3, .book-type-badge.format-mobi { background: rgba(255,143,0,0.9); }
    .book-info { padding: 10px; }
    .book-title { font-size: 13px; font-weight: 500; color: var(--text-primary); line-height: 1.3; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .book-author { font-size: 11px; color: var(--text-tertiary); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .book-size { font-size: 10px; color: var(--text-tertiary); margin-top: 4px; }

    .queue-bar { display: flex; align-items: center; gap: 16px; padding: 4px 0 16px; }
    .queue-controls { display: flex; gap: 4px; }
    .queue-ctrl-btn { width: 34px; height: 34px; border: 1px solid var(--border-subtle); border-radius: 8px; background: var(--bg-elevated);
      color: var(--text-secondary); cursor: pointer; font-size: 14px; }
    .queue-jobs { display: flex; flex-direction: column; gap: 8px; }
    .queue-job { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; background: var(--card-bg); border-radius: 8px; border: 1px solid var(--border-subtle); }
    .queue-job-header { display: flex; align-items: center; gap: 10px; }
    .queue-job-title { font-size: 14px; font-weight: 500; color: var(--text-primary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .queue-job-status { flex-shrink: 0; padding: 2px 8px; font-size: 10px; font-weight: 600; text-transform: uppercase; border-radius: 10px; }
    .queue-job-status.status-pending { background: var(--bg-elevated); color: var(--text-tertiary); }
    .queue-job-status.status-processing { background: var(--accent); color: #fff; }
    .queue-job-status.status-complete { background: var(--success); color: #fff; }
    .queue-job-status.status-error { background: var(--error); color: #fff; }
    .queue-job-progress { display: flex; align-items: center; gap: 10px; }
    .queue-progress-bar { flex: 1; height: 6px; background: var(--bg-elevated); border-radius: 3px; overflow: hidden; }
    .queue-progress-fill { height: 100%; background: var(--accent); border-radius: 3px; transition: width 0.3s ease; }
    .queue-job.status-complete .queue-progress-fill { background: var(--success); }
    .queue-job.status-error .queue-progress-fill { background: var(--error); }
    .queue-progress-pct { font-size: 12px; font-weight: 600; color: var(--text-secondary); min-width: 36px; text-align: right; }
    .queue-job-message { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    @media (min-width: 768px) { .books-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 16px; } }
    @media (max-width: 480px) { .navbar h1 { display: none; } .tab-btn { padding: 5px 7px; font-size: 11px; } }
  `],
})
export class ShelfComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  readonly theme = inject(ThemeService);
  readonly player = inject(PlayerService);
  readonly readerSvc = inject(ReaderService);
  readonly readerState = inject(ReaderStateService);
  private readonly router = inject(Router);

  readonly tab = signal<Tab>(this.readStoredTab());
  readonly sort = signal<Sort>((localStorage.getItem('bookshelf-sort') as Sort) || 'date');
  readonly search = signal('');
  readonly activeTag = signal<string>('all');
  readonly loading = signal(false);
  readonly refreshing = signal(false);
  readonly loadError = signal<string | null>(null);

  readonly audiobooks = signal<Audiobook[]>([]);
  readonly ebooks = signal<Ebook[]>([]);
  readonly covers = signal<Map<string, string>>(new Map());
  readonly squareCovers = signal<Set<string>>(new Set());
  private readonly requestedCovers = new Set<string>();

  readonly queue = signal<QueueData | null>(null);
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  readonly round = Math.round;
  readonly formatSize = formatSize;

  // ── Derived lists ──────────────────────────────────────────────────────────
  private readonly sortedAudiobooks = computed(() => {
    const list = [...this.audiobooks()];
    if (this.sort() === 'date') list.sort((a, b) => (b.dateAdded || '').localeCompare(a.dateAdded || ''));
    else list.sort((a, b) => a.title.localeCompare(b.title));
    return list;
  });

  private readonly sortedEbooks = computed(() => {
    const list = [...this.ebooks()];
    if (this.sort() === 'date') list.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
    else list.sort((a, b) => a.title.localeCompare(b.title));
    return list;
  });

  readonly tags = computed(() => {
    const set = new Set<string>();
    const source = this.tab() === 'audiobooks' ? this.audiobooks() : this.ebooks();
    for (const b of source) for (const t of b.tags || []) set.add(t);
    return [...set].sort();
  });

  readonly totalForTab = computed(() => (this.tab() === 'audiobooks' ? this.audiobooks().length : this.ebooks().length));

  readonly filteredAudiobooks = computed(() => {
    const q = this.search().trim();
    const tag = this.activeTag();
    return this.sortedAudiobooks().filter((b) => {
      if (tag !== 'all' && !(b.tags || []).includes(tag)) return false;
      if (!q) return true;
      return looseMatch(`${b.title} ${b.author || ''}`, q);
    });
  });

  readonly filteredEbooks = computed(() => {
    const q = this.search().trim();
    const tag = this.activeTag();
    return this.sortedEbooks().filter((b) => {
      if (tag !== 'all' && !(b.tags || []).includes(tag)) return false;
      if (!q) return true;
      const author = b.authorFull || b.authorLast || '';
      return looseMatch(`${b.title} ${author}`, q);
    });
  });

  readonly visibleCount = computed(() =>
    this.tab() === 'audiobooks' ? this.filteredAudiobooks().length : this.filteredEbooks().length
  );

  readonly activeJobs = computed(() => {
    const jobs = this.queue()?.jobs ?? [];
    // Minimal view: show standalone + child jobs that are pending/processing/error.
    return jobs.filter((j) => j.status === 'pending' || j.status === 'processing' || j.status === 'error');
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  private readStoredTab(): Tab {
    const t = localStorage.getItem('bookshelf-tab');
    return t === 'ebooks' || t === 'queue' || t === 'analytics' || t === 'audiobooks' ? t : 'audiobooks';
  }

  async ngOnInit(): Promise<void> {
    // Audiobooks stay loaded regardless (covers, mini-player); then honor the
    // restored tab so a refresh lands where the reader left off.
    await this.loadAudiobooks();
    const t = this.tab();
    if (t === 'ebooks') await this.loadEbooks();
    else if (t === 'queue') this.startQueuePolling();
  }

  ngOnDestroy(): void {
    this.stopQueuePolling();
  }

  // ── Tab / sort / tag ─────────────────────────────────────────────────────────
  async setTab(tab: Tab): Promise<void> {
    this.tab.set(tab);
    localStorage.setItem('bookshelf-tab', tab); // remembered across refreshes
    this.search.set('');
    this.activeTag.set('all');
    this.loadError.set(null);
    if (tab === 'queue') {
      this.startQueuePolling();
      return;
    }
    this.stopQueuePolling();
    if (tab === 'audiobooks' && this.audiobooks().length === 0) await this.loadAudiobooks();
    if (tab === 'ebooks' && this.ebooks().length === 0) await this.loadEbooks();
  }

  setSort(sort: Sort): void {
    this.sort.set(sort);
    localStorage.setItem('bookshelf-sort', sort);
  }

  setTag(tag: string): void {
    this.activeTag.set(tag);
  }

  // ── Data loading ─────────────────────────────────────────────────────────────
  private async loadAudiobooks(force = false): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.audiobooks.set(await this.api.getBooks(force));
    } catch (err) {
      console.error('[Shelf] failed to load audiobooks', err);
      this.loadError.set('Could not reach the server. Tap ⟳ to retry.');
    } finally {
      this.loading.set(false);
    }
  }

  private async loadEbooks(force = false): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      this.ebooks.set(await this.api.getEbooks(force));
    } catch (err) {
      console.error('[Shelf] failed to load ebooks', err);
      this.loadError.set('Could not reach the server. Tap ⟳ to retry.');
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      if (this.tab() === 'audiobooks') await this.loadAudiobooks(true);
      else if (this.tab() === 'ebooks') await this.loadEbooks(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  // ── Covers ───────────────────────────────────────────────────────────────────
  async loadAudioCover(book: Audiobook): Promise<void> {
    if (this.requestedCovers.has(book.downloadPath)) return;
    this.requestedCovers.add(book.downloadPath);
    const cover = await this.api.getCover(book);
    if (cover) this.setCover(book.downloadPath, cover);
  }

  async loadEbookCover(book: Ebook): Promise<void> {
    if (this.requestedCovers.has(book.relativePath)) return;
    this.requestedCovers.add(book.relativePath);
    const cover = await this.api.getEbookCover(book.relativePath);
    if (cover) this.setCover(book.relativePath, cover);
  }

  private setCover(key: string, src: string): void {
    const next = new Map(this.covers());
    next.set(key, src);
    this.covers.set(next);
  }

  onCoverLoad(key: string, event: Event): void {
    const img = event.target as HTMLImageElement;
    if (img.naturalWidth / img.naturalHeight > 0.85) {
      const next = new Set(this.squareCovers());
      next.add(key);
      this.squareCovers.set(next);
    }
  }

  // ── Navigation / actions ──────────────────────────────────────────────────────
  readonly pickerBook = signal<Audiobook | null>(null);

  openPlayer(book: Audiobook): void {
    // More than one audiobook version → let the reader pick which to open.
    if (book.versions && book.versions.length > 1) {
      this.pickerBook.set(book);
      return;
    }
    this.playVersionOf(book, book.versions?.[0]);
  }

  readonly pickerEbook = signal<Ebook | null>(null);

  closePicker(): void { this.pickerBook.set(null); this.pickerEbook.set(null); }

  /** A reader chose a specific version from the picker. */
  choosePlayerVersion(book: Audiobook, version: AudiobookVersion): void {
    this.closePicker();
    this.playVersionOf(book, version);
  }

  /** Navigate to the player for a specific version (or the book's default). Each
   *  version has its own downloadPath, so bookmarks/position are per-version. */
  private playVersionOf(book: Audiobook, version?: AudiobookVersion): void {
    const b: Audiobook = version
      ? {
          ...book,
          type: version.type,
          langPair: version.langPair,
          downloadPath: version.downloadPath,
          coverPath: version.coverPath ?? book.coverPath,
          size: version.size,
          duration: version.duration,
          dateAdded: version.dateAdded ?? book.dateAdded,
        }
      : book;
    // Pass the full entry via router state for an instant load; the param (the
    // download path) makes the URL deep-linkable / reload-safe.
    this.router.navigate(['/play', encodePathId(b.downloadPath)], { state: { book: b } });
  }

  versionLabel(v: AudiobookVersion): string {
    if (v.descriptor && v.descriptor.trim()) return v.descriptor.trim();
    if (v.type === 'bilingual') return `Bilingual${v.langPair ? ' · ' + v.langPair : ''}`;
    return 'Audiobook';
  }

  versionSub(v: AudiobookVersion): string {
    const dur = formatDuration(v.duration);
    const name = v.downloadPath.split(/[/\\]/).pop() || '';
    const left = dur ? `${formatSize(v.size)} · ${dur}` : formatSize(v.size);
    return name ? `${left} · ${name}` : left;
  }

  /** Ebooks tab: >1 version pops a picker; epub/pdf open in the reader; other
   *  formats just download. */
  openEbook(book: Ebook): void {
    if (book.versions && book.versions.length > 1) {
      this.pickerEbook.set(book);
      return;
    }
    this.openEbookRef(book.relativePath, book.format, book.title, this.ebookAuthor(book));
  }

  chooseEbookVersion(book: Ebook, v: EbookVersion): void {
    this.closePicker();
    this.openEbookRef(v.relativePath, v.format, v.title, v.authorFull || this.ebookAuthor(book));
  }

  /** Open a specific ebook file in the reader (epub/pdf) or download it. Each
   *  version's relativePath keys its own reader position/bookmarks. */
  private openEbookRef(relativePath: string, format: string, title: string, author: string): void {
    const fmt = (format || '').toLowerCase();
    if (fmt === 'epub' || fmt === 'pdf') {
      this.router.navigate(['/read', encodePathId(`e:${relativePath}`)], {
        state: { title, author, cover: this.covers().get(relativePath) ?? null },
      });
    } else {
      const a = document.createElement('a');
      a.href = this.api.ebookDownloadUrl(relativePath);
      a.download = relativePath.split(/[/\\]/).pop() || 'book';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }

  ebookVersionLabel(v: EbookVersion): string {
    if (v.descriptor && v.descriptor.trim()) return v.descriptor.trim();
    return (v.format || 'ebook').toUpperCase();
  }

  ebookVersionSub(v: EbookVersion): string {
    const name = v.relativePath.split(/[/\\]/).pop() || '';
    const left = `${formatSize(v.fileSize)} · ${(v.format || '').toUpperCase()}`;
    return name ? `${left} · ${name}` : left;
  }

  downloadEbook(book: Ebook, event?: Event): void {
    event?.stopPropagation(); // don't also open the reader
    const a = document.createElement('a');
    a.href = this.api.ebookDownloadUrl(book.relativePath);
    a.download = book.filename || 'book';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ── Queue (minimal) ───────────────────────────────────────────────────────────
  private startQueuePolling(): void {
    void this.pollQueue();
    this.queueTimer = setInterval(() => void this.pollQueue(), 3000);
  }

  private stopQueuePolling(): void {
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
  }

  private async pollQueue(): Promise<void> {
    try {
      this.queue.set(await this.api.getQueue());
    } catch { /* transient */ }
  }

  async queueControl(action: 'start' | 'pause'): Promise<void> {
    await this.api.sendQueueControl(action);
    await this.pollQueue();
  }

  // ── Display helpers ───────────────────────────────────────────────────────────
  initial(name: string): string {
    return (name.trim()[0] || '?').toUpperCase();
  }

  badge(book: Audiobook): string {
    if (book.source === 'external') return 'imported';
    return book.type === 'bilingual' ? `bilingual ${book.langPair || ''}`.trim() : 'audiobook';
  }

  sizeAndDuration(book: Audiobook): string {
    const dur = formatDuration(book.duration);
    return dur ? `${formatSize(book.size)} · ${dur}` : formatSize(book.size);
  }

  ebookAuthor(book: Ebook): string {
    return book.authorFull || (book.authorLast ? `${book.authorLast}, ${book.authorFirst || ''}`.trim() : '');
  }

  jobMessage(job: QueueJob): string {
    if (job.status === 'error' && job.error) return job.error;
    if (job.ttsPhase === 'converting' && job.ttsConversionProgress != null) return `Converting: ${Math.round(job.ttsConversionProgress)}%`;
    if (job.ttsPhase === 'assembling' && job.assemblyProgress != null) return `Assembling: ${Math.round(job.assemblyProgress)}%`;
    return job.progressMessage || '';
  }
}
