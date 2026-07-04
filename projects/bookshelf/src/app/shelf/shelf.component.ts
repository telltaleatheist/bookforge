import { Component, computed, effect, inject, OnDestroy, OnInit, signal, untracked } from '@angular/core';
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
import { ServerConfigService, ServerEntry } from '../services/server-config.service';
import { LocalLibraryService } from '../services/local-library.service';
import { BookActionsService } from '../services/book-actions.service';
import { AnalyticsComponent } from '../analytics/analytics.component';
import { Audiobook, AudiobookVersion, Ebook, EbookVersion, QueueData, QueueJob } from '../models/types';

type Tab = 'audiobooks' | 'ebooks' | 'articles' | 'queue' | 'analytics';
type Sort = 'title' | 'date';

/** One target of the grid book context menu (long-press / right-click a card). */
interface BookMenu {
  kind: 'audiobook' | 'ebook';
  title: string;
  audiobook?: Audiobook;
  ebook?: Ebook;
  isLocal: boolean;
  canDownload: boolean;   // remote audiobook, not yet cached offline
  isDownloaded: boolean;  // has an offline copy
}

@Component({
  selector: 'app-shelf',
  standalone: true,
  imports: [VisibleDirective, UpperCasePipe, IconComponent, AnalyticsComponent],
  template: `
    <nav class="navbar">
      <div class="nav-title">
        <h1>Bookshelf</h1>
      </div>
      <div class="nav-controls">
        <!-- Servers: the multi-server library switcher. Each row is a server the
             app stays connected to; the checkbox shows/hides its books, the ✕
             removes it entirely. Enabling one that's asleep spins, then flips to
             "offline" if it can't be reached. Shown once there's more than one
             library to juggle (or always on native, where you pair remotes). -->
        @if (cfg.isNative || cfg.servers().length > 1) {
          <div class="account">
            <button class="theme-toggle" (click)="serverMenuOpen.set(!serverMenuOpen())"
                    title="Libraries" aria-label="Libraries">
              <app-icon name="airplay" [size]="18" />
            </button>
            @if (serverMenuOpen()) {
              <div class="menu-backdrop" (click)="serverMenuOpen.set(false)"></div>
              <div class="account-menu server-menu" role="menu">
                <div class="menu-caption">Libraries</div>
                @for (s of cfg.servers(); track s.id) {
                  <div class="server-row">
                    <button class="server-toggle" role="menuitemcheckbox"
                            [attr.aria-checked]="s.enabled" (click)="toggleServer(s)">
                      <span class="server-check" [class.on]="s.enabled">
                        @if (s.enabled) { <app-icon name="check" [size]="13" /> }
                      </span>
                      <span class="server-label" [title]="s.url || 'This device'">{{ s.label }}</span>
                      @if (serverStatus().get(s.id) === 'loading') {
                        <span class="server-state spin">⟳</span>
                      } @else if (serverStatus().get(s.id) === 'offline') {
                        <span class="server-state off">offline</span>
                      }
                    </button>
                    @if (s.url) {
                      <button class="server-x" (click)="removeServer(s, $event)" aria-label="Remove server">×</button>
                    }
                  </div>
                }
                <button class="menu-item add-server" role="menuitem" (click)="addServerPrompt()">
                  <app-icon name="plus" [size]="16" />
                  <span>Add a server</span>
                </button>
              </div>
            }
          </div>
        }
        <!-- Account: the profile initial when signed in, a neutral person glyph
             otherwise. Tapping opens a small menu to switch profile / switch (or
             connect to a) server. Shown whenever there's an action to offer:
             always on native, and on the web once the server supports profiles. -->
        @if (cfg.isNative || readerSvc.supported()) {
          <div class="account">
            <button class="reader-chip" [class.guest]="!readerSvc.reader()"
                    (click)="accountMenuOpen.set(!accountMenuOpen())"
                    [title]="readerSvc.reader()?.name || 'Account'" aria-label="Account">
              @if (readerSvc.reader(); as r) {
                {{ initial(r.name) }}
              } @else {
                <app-icon name="user" [size]="18" />
              }
            </button>
            @if (accountMenuOpen()) {
              <div class="menu-backdrop" (click)="accountMenuOpen.set(false)"></div>
              <div class="account-menu" role="menu">
                @if (readerSvc.supported()) {
                  <button class="menu-item" role="menuitem" (click)="chooseProfile()">
                    <app-icon name="user" [size]="17" />
                    <span>{{ readerSvc.reader() ? 'Switch profile' : 'Choose profile' }}</span>
                  </button>
                }
                @if (cfg.isNative) {
                  <button class="menu-item" role="menuitem" (click)="switchServer()">
                    <app-icon name="airplay" [size]="17" />
                    <span>{{ cfg.baseUrl() ? 'Switch server' : 'Connect to a server' }}</span>
                  </button>
                }
              </div>
            }
          </div>
        }
        <button class="theme-toggle" (click)="theme.toggle()" title="Toggle theme">
          {{ theme.theme() === 'dark' ? '☀️' : '🌙' }}
        </button>
      </div>
    </nav>

    @if (tab() === 'audiobooks' || tab() === 'ebooks' || tab() === 'articles') {
      <div class="stats-bar">
        <div class="stat">
          <span class="stat-value">{{ visibleCount() }}</span>
          <span class="stat-label">{{ tab() === 'audiobooks' ? 'Audiobooks' : tab() === 'articles' ? 'Articles' : 'Ebooks' }}</span>
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
        <input class="search-box" type="text" [placeholder]="tab() === 'audiobooks' ? 'Search audiobooks...' : tab() === 'articles' ? 'Search articles...' : 'Search ebooks...'"
          [value]="search()" (input)="search.set($any($event.target).value)" />
        @if (search()) {
          <button class="clear-search" (click)="search.set('')">✕</button>
        }
      </div>
    }

    <main class="content" [class.has-mini]="player.book() || readerState.session()">
      @if (!cfg.configured()) {
        <!-- Native app, not yet paired with a library server. The app no longer
             blocks on a server picker at launch — this centered CTA (and the
             top-right account menu) is how you connect. -->
        <div class="empty-state connect-cta">
          <span class="empty-icon">📚</span>
          <p class="connect-title">Your library is empty</p>
          <button class="connect-btn" (click)="cfg.openPrompt()">Connect to a server</button>
          <small class="connect-hint">Add books in BookForge on your computer</small>
        </div>
      } @else if (tab() === 'analytics') {
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
          @for (book of filteredAudiobooks(); track akey(book)) {
            <div class="book-card" [class.external]="book.source === 'external'" (click)="openPlayer(book)"
                 (contextmenu)="onCardContextMenu(audioMenu(book), $event)"
                 (pointerdown)="onCardPointerDown(audioMenu(book), $event)"
                 (pointermove)="onRowPointerMove($event)"
                 (pointerup)="onRowPointerEnd()"
                 (pointercancel)="onRowPointerEnd()"
                 (pointerleave)="onRowPointerEnd()">
              <div class="book-cover" [class.square-cover]="squareCovers().has(akey(book))"
                appVisible (visible)="loadAudioCover(book)">
                @if (covers().get(akey(book)); as src) {
                  <img [src]="src" alt="Cover" (load)="onCoverLoad(akey(book), $event)" />
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
      } @else if (tab() === 'articles') {
        <!-- Articles have no covers worth showing → an iOS grouped list of rows
             (title, author/domain + date, chevron). Long-press or right-click a
             row to reveal delete. Tapping a row keeps the reader/listen behavior. -->
        <div class="article-list">
          @for (book of filteredArticles(); track ekey(book)) {
            <div class="article-row"
                 (click)="onArticleRowClick(book)"
                 (contextmenu)="onRowContextMenu(book, $event)"
                 (pointerdown)="onRowPointerDown(book, $event)"
                 (pointermove)="onRowPointerMove($event)"
                 (pointerup)="onRowPointerEnd()"
                 (pointercancel)="onRowPointerEnd()"
                 (pointerleave)="onRowPointerEnd()">
              <div class="article-row-main">
                <div class="article-row-title" [title]="book.title">{{ book.title }}</div>
                <div class="article-row-sub">{{ articleSubtitle(book) }}</div>
              </div>
              @if (book.projectId) {
                <button class="article-row-more" (click)="openArticleActions(book, $event)" aria-label="More actions">
                  <app-icon name="more" [size]="20" />
                </button>
              }
            </div>
          }
        </div>
      } @else {
        <div class="books-grid">
          @for (book of filteredEbooks(); track ekey(book)) {
            <div class="book-card" (click)="openEbook(book)"
                 (contextmenu)="onCardContextMenu(ebookMenu(book), $event)"
                 (pointerdown)="onCardPointerDown(ebookMenu(book), $event)"
                 (pointermove)="onRowPointerMove($event)"
                 (pointerup)="onRowPointerEnd()"
                 (pointercancel)="onRowPointerEnd()"
                 (pointerleave)="onRowPointerEnd()">
              <div class="book-cover" [class.square-cover]="squareCovers().has(ekey(book))"
                appVisible (visible)="loadEbookCover(book)">
                @if (covers().get(ekey(book)); as src) {
                  <img [src]="src" alt="Cover" (load)="onCoverLoad(ekey(book), $event)" />
                } @else {
                  <span class="placeholder">📖</span>
                }
                <span class="book-type-badge" [class]="'format-' + book.format">{{ (book.format || 'epub') | uppercase }}</span>
                <button class="corner-btn" (click)="downloadEbook(book, $event)" title="Download">
                  <app-icon name="download" [size]="15" />
                </button>
                @if (book.projectId) {
                  <button class="corner-btn move-btn" [disabled]="moving() === book.projectId"
                    (click)="reclassify(book, $event)"
                    [title]="tab() === 'articles' ? 'Mark as Ebook' : 'Mark as Article'">
                    {{ tab() === 'articles' ? '📖' : '📰' }}
                  </button>
                  <button class="corner-btn listen-btn" (click)="openListen(book, $event)" title="Read &amp; listen">🎧</button>
                }
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

    @if (notice(); as msg) {
      <div class="toast">{{ msg }}</div>
    }

    <!-- iOS action sheet: revealed by long-press / right-click on an article row.
         A destructive Delete action + Cancel. No native confirm(). -->
    @if (deleteTarget(); as dt) {
      <div class="sheet-backdrop" (click)="closeDelete()"></div>
      <div class="action-sheet" [class.above-mini]="!!player.book()" role="dialog" aria-label="Delete article">
        <div class="action-group">
          <div class="action-caption">{{ dt.title }}</div>
          <button class="action-btn destructive" [disabled]="deleting()" (click)="confirmDeleteArticle()">
            <app-icon name="trash" [size]="20" />
            <span>{{ deleting() ? 'Deleting…' : 'Delete Article' }}</span>
          </button>
        </div>
        <button class="action-cancel" [disabled]="deleting()" (click)="closeDelete()">Cancel</button>
      </div>
    }

    <!-- Book context menu: long-press / right-click a grid card. Acts on the book
         wherever it lives — progress/history writes go to its origin server (or
         just localStorage for on-device books). Mirrors the article action sheet. -->
    @if (bookMenu(); as bm) {
      <div class="sheet-backdrop" (click)="closeBookMenu()"></div>
      <div class="action-sheet" [class.above-mini]="!!player.book()" role="dialog" aria-label="Book actions">
        <div class="action-group">
          <div class="action-caption">{{ bm.title }}</div>
          @if (bm.kind === 'audiobook' && bm.canDownload) {
            <button class="action-btn" [disabled]="menuBusy()" (click)="doDownload(bm)">
              <app-icon name="download" [size]="20" />
              <span>{{ menuBusy() ? 'Downloading…' : 'Download for offline' }}</span>
            </button>
          }
          @if (bm.kind === 'audiobook' && bm.isDownloaded) {
            <button class="action-btn" [disabled]="menuBusy()" (click)="doRemoveDownload(bm)">
              <app-icon name="close" [size]="20" />
              <span>Remove download</span>
            </button>
          }
          @if (bm.kind === 'audiobook' && canMarkFinished(bm)) {
            <button class="action-btn" [disabled]="menuBusy()" (click)="doMarkFinished(bm)">
              <app-icon name="check" [size]="20" />
              <span>Mark as finished</span>
            </button>
          }
          <button class="action-btn" [disabled]="menuBusy()" (click)="doStartOver(bm)">
            <app-icon name="replay" [size]="20" />
            <span>Start over</span>
          </button>
          <button class="action-btn" [disabled]="menuBusy()" (click)="doEraseHistory(bm)">
            <app-icon name="undo" [size]="20" />
            <span>{{ bm.kind === 'audiobook' ? 'Erase listening history' : 'Erase reading history' }}</span>
          </button>
          @if (bm.isLocal) {
            <button class="action-btn destructive" [disabled]="menuBusy()" (click)="doRemoveLocal(bm)">
              <app-icon name="trash" [size]="20" />
              <span>{{ menuBusy() ? 'Removing…' : 'Remove from this device' }}</span>
            </button>
          }
        </div>
        <button class="action-cancel" [disabled]="menuBusy()" (click)="closeBookMenu()">Cancel</button>
      </div>
    }

    <!-- ＋ import sheet: bring anything into the library. A file (pdf/epub/txt) or
         a pasted URL is ingested → edited → finalized into a persisted project.
         iOS bottom sheet: dimmed backdrop, grabber, two tappable option rows. -->
    @if (importOpen()) {
      <div class="sheet-backdrop" (click)="closeImport()"></div>
      <div class="import-sheet" role="dialog" aria-label="Add to library">
        <div class="sheet-grabber"></div>
        <div class="import-head">Add to your library</div>

        <!-- Option 1: import a file (label wraps the hidden <input>). -->
        <label class="opt-row" [class.busy]="importBusy()">
          <span class="opt-icon"><app-icon name="file" [size]="22" /></span>
          <span class="opt-text">
            <b>Import a file</b>
            <small>PDF, EPUB, or text from your device</small>
          </span>
          <input type="file" accept=".pdf,.epub,.txt,.htm,.html" hidden
                 [disabled]="importBusy()" (change)="onImportFile($event)" />
        </label>

        <!-- Option 2: paste a URL. Tapping expands an inline input + Go. -->
        <button class="opt-row" [class.busy]="importBusy()" (click)="toggleUrlInput()">
          <span class="opt-icon"><app-icon name="link" [size]="22" /></span>
          <span class="opt-text">
            <b>Paste a URL</b>
            <small>Fetch an article from the web</small>
          </span>
        </button>

        @if (urlExpanded()) {
          <div class="url-field">
            <input type="url" [value]="importUrl()" (input)="importUrl.set($any($event.target).value)"
                   placeholder="https://…" autocomplete="off" [disabled]="importBusy()"
                   (keyup.enter)="importUrl().trim() && startImport({ url: importUrl().trim() })" />
            <button class="url-go" [disabled]="!importUrl().trim() || importBusy()"
                    (click)="startImport({ url: importUrl().trim() })">
              {{ importBusy() ? '…' : 'Go' }}
            </button>
          </div>
        }

        @if (importBusy()) { <p class="sheet-note">Fetching &amp; preparing…</p> }
        @if (importError()) { <p class="sheet-err">{{ importError() }}</p> }

        <!-- Option 3: add a finished file to THIS DEVICE — no server, plays/reads
             locally from on-device storage (see LocalLibraryService). -->
        <label class="opt-row" [class.busy]="localBusy()">
          <span class="opt-icon"><app-icon name="headphones" [size]="22" /></span>
          <span class="opt-text">
            <b>Add to this device</b>
            <small>Play an M4B/MP3 or read an EPUB you already have</small>
          </span>
          <input type="file" accept=".m4b,.m4a,.mp3,.epub" hidden
                 [disabled]="localBusy()" (change)="onImportLocalFile($event)" />
        </label>
        @if (localBusy()) { <p class="sheet-note">Adding to this device…</p> }

        <button class="sheet-quick" (click)="quickListen()">Or just paste text to listen →</button>
      </div>
    }

    <!-- Constant bottom nav rail: a centered, adjacent button group with the ＋
         (streaming) dead-center. Odd count (5) so ＋ is truly central; all buttons
         are the same size. The mini-player attaches directly above it; focused
         overlays (player/reader/listen, z-index 500) cover it. -->
    <nav class="bottom-nav">
      <button class="bn-item" [class.active]="tab() === 'audiobooks'" (click)="setTab('audiobooks')" aria-label="Audiobooks">
        <app-icon name="headphones" [size]="24" /><span class="bn-label">Audio</span>
      </button>
      <button class="bn-item" [class.active]="tab() === 'ebooks'" (click)="setTab('ebooks')" aria-label="Ebooks">
        <app-icon name="book" [size]="24" /><span class="bn-label">Books</span>
      </button>
      <button class="bn-item bn-center" (click)="openImport()" aria-label="Add to library">
        <span class="bn-plus"><app-icon name="plus" [size]="20" /></span><span class="bn-label">Add</span>
      </button>
      <button class="bn-item" [class.active]="tab() === 'articles'" (click)="setTab('articles')" aria-label="Articles">
        <app-icon name="article" [size]="24" /><span class="bn-label">Articles</span>
      </button>
      <button class="bn-item" [class.active]="tab() === 'analytics'" (click)="setTab('analytics')" aria-label="Analytics">
        <app-icon name="stats" [size]="24" /><span class="bn-label">Stats</span>
      </button>
    </nav>
  `,
  styles: [`
    :host { display: block; width: 100%; height: 100%; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    /* Version picker (bottom sheet) */
    .picker-backdrop { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.5); animation: pkFade 0.15s ease; }
    @keyframes pkFade { from { opacity: 0; } to { opacity: 1; } }
    /* Sits above the constant nav rail. */
    .picker-sheet { position: fixed; left: 0; right: 0; bottom: calc(var(--bf-nav-h) + env(safe-area-inset-bottom)); z-index: 301; max-height: 70%; display: flex; flex-direction: column;
      background: var(--bg-elevated); border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 30px rgba(0,0,0,0.35); animation: pkUp 0.2s ease-out; }
    /* When the mini-player is on screen, start the sheet above BOTH it and the nav rail. */
    .picker-sheet.above-mini { bottom: calc(var(--bf-nav-h) + var(--bf-mini-h) + env(safe-area-inset-bottom)); }
    @keyframes pkUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .picker-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px 4px; font-weight: 600; }
    .picker-close { border: none; background: transparent; color: var(--text-tertiary); font-size: 24px; line-height: 1; cursor: pointer; width: 32px; height: 32px; border-radius: 8px; }
    .picker-sub { padding: 0 16px 10px; color: var(--text-tertiary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-bottom: 1px solid var(--border-subtle); }
    .picker-body { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 6px; }
    /* ── Shared translucent bottom-sheet chrome (＋ import + delete action sheet) ──
       Dimmed backdrop tap-to-dismiss; sheet anchored to the bottom above the nav
       rail, translucent+blurred, 16px top corners, slides up. */
    .sheet-backdrop { position: fixed; inset: 0; z-index: 320; background: rgba(0,0,0,0.4); animation: pkFade 0.2s ease; }
    /* ＋ import sheet */
    .import-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 321;
      display: flex; flex-direction: column; gap: 10px;
      padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-top: 0.5px solid var(--border-subtle); border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 30px rgba(0,0,0,0.35); animation: sheetUp 0.25s ease-out; }
    @keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    /* 36×5 grabber handle, centered at the top. */
    .sheet-grabber { width: 36px; height: 5px; border-radius: 3px; background: var(--text-tertiary); opacity: 0.5; align-self: center; margin: 2px 0 6px; }
    .import-head { font-size: 15px; font-weight: 600; color: var(--text-primary); padding: 0 2px 2px; }
    /* Tappable option row: icon tile + title/description. */
    .opt-row { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
      padding: 12px 14px; border: none; border-radius: 12px; background: var(--bg-elevated);
      color: var(--text-primary); cursor: pointer; }
    .opt-row:active { opacity: 0.6; }
    .opt-row.busy { opacity: .5; pointer-events: none; }
    .opt-icon { flex-shrink: 0; width: 38px; height: 38px; border-radius: 10px; display: flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .opt-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .opt-text b { font-size: 15px; font-weight: 600; }
    .opt-text small { font-size: 12px; color: var(--text-tertiary); }
    /* Inline URL field revealed under the "Paste a URL" row. */
    .url-field { display: flex; gap: 8px; }
    .url-field input { flex: 1; min-width: 0; background: var(--bg-input); color: var(--text-primary); border: 1px solid var(--border-input); border-radius: 10px; padding: 11px 12px; font: inherit; outline: none; }
    .url-field input:focus { border-color: var(--accent); }
    .url-go { flex-shrink: 0; background: var(--accent); color: #fff; border: none; border-radius: 10px; padding: 0 20px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .url-go:active { opacity: 0.6; }
    .url-go:disabled { opacity: .4; }
    .sheet-note { font-size: 13px; color: var(--accent); margin: 0; padding: 0 2px; }
    .sheet-err { font-size: 13px; color: var(--error); margin: 0; padding: 0 2px; }
    .sheet-quick { align-self: flex-start; background: none; border: none; color: var(--text-secondary); font-size: 13px; cursor: pointer; padding: 4px 2px; }
    .sheet-quick:active { opacity: 0.6; }
    /* ── Delete action sheet (iOS) ────────────────────────────────────────────── */
    /* Anchored above the nav rail (not the raw screen bottom), so Delete/Cancel
       never slide up behind it. With the mini-player on screen, start above that
       too — the sheet slides up from the top of the player. Mirrors .picker-sheet. */
    .action-sheet { position: fixed; left: 0; right: 0; bottom: calc(var(--bf-nav-h) + env(safe-area-inset-bottom)); z-index: 321;
      display: flex; flex-direction: column; gap: 8px;
      padding: 8px 10px 10px;
      animation: sheetUp 0.25s ease-out; }
    .action-sheet.above-mini { bottom: calc(var(--bf-nav-h) + var(--bf-mini-h) + env(safe-area-inset-bottom)); }
    .action-group, .action-cancel { border-radius: 14px; overflow: hidden;
      background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
    .action-caption { padding: 12px 16px; font-size: 13px; color: var(--text-tertiary); text-align: center;
      border-bottom: 0.5px solid var(--border-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .action-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%;
      padding: 15px 16px; border: none; background: transparent; font-size: 17px; font-weight: 500; cursor: pointer; }
    .action-btn:active { background: var(--bg-hover); }
    .action-btn:disabled { opacity: 0.5; }
    .action-btn.destructive { color: var(--error); }
    .action-cancel { width: 100%; padding: 15px 16px; border: none; font-size: 17px; font-weight: 700; color: var(--accent); cursor: pointer; }
    .action-cancel:active { background: var(--bg-hover); }
    .action-cancel:disabled { opacity: 0.5; }
    /* ── Articles list (iOS grouped list) ─────────────────────────────────────── */
    .article-list { display: flex; flex-direction: column; background: var(--bg-surface); border-radius: 12px; overflow: hidden; }
    .article-row { display: flex; align-items: center; gap: 10px; padding: 13px 14px; cursor: pointer;
      border-bottom: 0.5px solid var(--border-subtle); -webkit-user-select: none; user-select: none; -webkit-touch-callout: none;
      touch-action: pan-y; }
    .article-row:last-child { border-bottom: none; }
    .article-row:active { background: var(--bg-hover); }
    .article-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .article-row-title { font-size: 15px; font-weight: 500; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .article-row-sub { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* iOS tertiary icon button: 34×34 tap target, no fill, dims on press. Replaces
       the old chevron — the whole row is tappable, this reveals the action sheet. */
    .article-row-more { flex-shrink: 0; width: 34px; height: 34px; margin-right: -6px; border: none; background: transparent;
      color: var(--text-tertiary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .article-row-more:active { opacity: 0.6; }
    .picker-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .picker-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .picker-icon { font-size: 20px; flex-shrink: 0; }
    .picker-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .picker-title { font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .picker-meta { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .navbar { position: sticky; top: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between;
      padding: calc(12px + env(safe-area-inset-top)) 16px 12px;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent); border-bottom: 0.5px solid var(--border-subtle);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); gap: 8px; }
    .nav-title { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
    .navbar h1 { font-size: 19px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nav-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .theme-toggle { width: 40px; height: 40px; border: none; background: var(--bg-elevated); border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 18px; }
    .account { position: relative; display: flex; }
    .reader-chip { width: 32px; height: 32px; flex-shrink: 0; border: none; border-radius: 50%; cursor: pointer;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: #fff; font-size: 13px; font-weight: 700;
      display: flex; align-items: center; justify-content: center; }
    /* Signed-out / guest: neutral chip with a person glyph, not the accent gradient. */
    .reader-chip.guest { background: var(--bg-elevated); color: var(--text-secondary); border: 1px solid var(--border-subtle); }
    /* Transparent full-screen catcher so an outside tap closes the menu. */
    .menu-backdrop { position: fixed; inset: 0; z-index: 400; }
    .account-menu { position: absolute; top: calc(100% + 8px); right: 0; z-index: 401; min-width: 190px;
      display: flex; flex-direction: column; padding: 6px; gap: 2px;
      background: var(--bg-elevated); border: 1px solid var(--border-subtle); border-radius: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.28); animation: pkFade 0.12s ease; }
    .menu-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
      padding: 10px 12px; border: none; border-radius: 8px; background: transparent;
      color: var(--text-primary); font-size: 14px; font-weight: 500; cursor: pointer; }
    .menu-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .menu-item app-icon { color: var(--text-secondary); }
    /* ── Server (libraries) menu ─────────────────────────────────────────────── */
    .server-menu { min-width: 230px; }
    .menu-caption { padding: 4px 12px 6px; font-size: 11px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.4px; color: var(--text-tertiary); }
    .server-row { display: flex; align-items: center; gap: 2px; }
    .server-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; text-align: left;
      padding: 9px 10px; border: none; border-radius: 8px; background: transparent; color: var(--text-primary);
      font-size: 14px; font-weight: 500; cursor: pointer; }
    .server-toggle:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    /* Checkbox: filled accent when the library is showing, hollow when hidden. */
    .server-check { flex-shrink: 0; width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--border-subtle);
      display: flex; align-items: center; justify-content: center; color: #fff; }
    .server-check.on { background: var(--accent); border-color: var(--accent); }
    .server-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .server-state { flex-shrink: 0; font-size: 11px; font-weight: 600; }
    .server-state.off { color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.3px; }
    .server-state.spin { color: var(--accent); animation: spin 0.8s linear infinite; }
    .server-x { flex-shrink: 0; width: 28px; height: 28px; border: none; background: transparent; color: var(--text-tertiary);
      font-size: 20px; line-height: 1; border-radius: 8px; cursor: pointer; }
    .server-x:hover { background: var(--bg-hover); color: var(--error); }
    .add-server { margin-top: 4px; border-top: 0.5px solid var(--border-subtle); border-radius: 0 0 8px 8px; color: var(--accent); }
    .add-server app-icon { color: var(--accent); }
    .tab-toggle { display: flex; background: var(--bg-elevated); border-radius: 8px; padding: 2px; gap: 2px; }
    .tab-btn { padding: 6px 10px; border: none; background: transparent; color: var(--text-tertiary); font-size: 12px; font-weight: 500;
      border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .tab-btn.active { background: var(--accent); color: #fff; }
    .stats-bar { display: flex; align-items: center; gap: 24px; padding: 12px 16px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle); }
    .refresh-btn { width: 36px; height: 36px; border: 1px solid var(--accent); background: color-mix(in srgb, var(--accent) 15%, var(--bg-elevated));
      border-radius: 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; color: var(--accent); }
    .refresh-btn.spinning svg { animation: spin 0.6s linear infinite; }
    /* iOS segmented control: gray track, raised selected segment. */
    .sort-toggle { display: flex; background: var(--seg-bg); border-radius: 9px; padding: 2px; margin-left: auto; }
    .sort-btn { padding: 5px 14px; border: none; background: transparent; color: var(--text-primary); font-size: 13px; font-weight: 500; border-radius: 7px; cursor: pointer; }
    .sort-btn.active { background: var(--seg-active); box-shadow: 0 1px 4px rgba(0,0,0,0.16); }
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
    /* iOS search-field look: gray fill, no border. */
    .search-box { width: 100%; padding: 10px 40px 10px 14px; font-size: 16px; background: var(--bg-input); border: 1px solid transparent;
      border-radius: 10px; color: var(--text-primary); outline: none; }
    .search-box:focus { border-color: var(--accent); }
    .clear-search { position: absolute; right: 28px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; border: none;
      background: var(--bg-hover); border-radius: 50%; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
    /* Always leave room for the constant bottom nav rail; add the mini-player's
       height on top when it's on screen. Heights come from the shell's vars. */
    .content { padding: 16px; padding-bottom: calc(var(--bf-nav-h) + 28px + env(safe-area-inset-bottom)); }
    .content.has-mini { padding-bottom: calc(var(--bf-nav-h) + var(--bf-mini-h) + 28px + env(safe-area-inset-bottom)); }
    .loading-indicator { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 48px; color: var(--text-secondary); }
    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px; color: var(--text-secondary); text-align: center; }
    .empty-icon { font-size: 48px; }
    /* First-run "connect to a server" call-to-action (native, unpaired). */
    .connect-cta { gap: 14px; }
    .connect-title { font-size: 17px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .connect-btn { padding: 12px 22px; border: none; border-radius: 10px; background: var(--accent); color: #fff;
      font-size: 15px; font-weight: 600; cursor: pointer; }
    .connect-btn:active { opacity: 0.8; }
    .connect-hint { font-size: 13px; color: var(--text-tertiary); }
    /* 3-up on phones: minmax low enough that a 390px viewport fits three columns
       (390 − 2×16 padding − 2×10 gaps = 338 → 112px each). */
    .books-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
    .book-card { display: flex; flex-direction: column; background: var(--card-bg); border-radius: 12px; overflow: hidden; cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      /* Allow vertical scroll while a long-press (context menu) is being detected;
         suppress the iOS long-press callout so the app's own menu is what appears. */
      touch-action: pan-y; -webkit-touch-callout: none; }
    .book-card:active { transform: scale(0.97); }
    .book-card.external { outline: 2px solid #7c4dff; outline-offset: -2px; }
    .book-cover { position: relative; aspect-ratio: 2 / 3; background: var(--bg-elevated); display: flex; align-items: center; justify-content: center; }
    .book-cover img { width: 100%; height: 100%; object-fit: cover; }
    /* Audiobook art is usually square — give those cards a square frame so the
       cover fills it edge-to-edge instead of being letterboxed in a 2:3 box. */
    .book-cover.square-cover { aspect-ratio: 1 / 1; }
    .book-cover.square-cover img { object-fit: cover; }
    .book-cover .placeholder { font-size: 36px; color: var(--text-tertiary); }
    .corner-btn { position: absolute; top: 6px; left: 6px; width: 30px; height: 30px; border: none; border-radius: 8px;
      background: rgba(0,0,0,0.62); color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    .corner-btn:active { transform: scale(0.92); }
    .corner-btn:disabled { opacity: 0.5; }
    /* Second corner action (reclassify), bottom-left so it clears the download btn. */
    .move-btn { top: auto; bottom: 6px; font-size: 15px; }
    /* Read & listen, bottom-right. */
    .listen-btn { top: auto; bottom: 6px; left: auto; right: 6px; font-size: 15px; }
    .toast { position: fixed; left: 50%; transform: translateX(-50%); z-index: 400;
      bottom: calc(var(--bf-nav-h) + 16px + env(safe-area-inset-bottom));
      background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-subtle);
      border-radius: 10px; padding: 10px 16px; font-size: 13px; max-width: 80%; text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4); animation: pkFade 0.15s ease; }
    .book-type-badge { position: absolute; top: 6px; right: 6px; padding: 2px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase;
      background: rgba(0,0,0,0.7); color: #fff; border-radius: 4px; }
    .book-type-badge.m4b { background: #8b5cf6; }
    .book-type-badge.format-epub { background: rgba(46,125,50,0.9); }
    .book-type-badge.format-pdf { background: rgba(198,40,40,0.9); }
    .book-type-badge.format-azw3, .book-type-badge.format-mobi { background: rgba(255,143,0,0.9); }
    .book-info { padding: 8px; }
    .book-title { font-size: 12px; font-weight: 500; color: var(--text-primary); line-height: 1.3; display: -webkit-box;
      -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .book-author { font-size: 10px; color: var(--text-tertiary); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .book-size { font-size: 10px; color: var(--text-tertiary); margin-top: 3px; }

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

    /* ── Constant bottom nav rail (iOS tab bar) ──────────────────────────────
       Fixed to the viewport bottom, always present while browsing. A centered,
       adjacent button group with the ＋ dead-center. z-index 100: below the
       mini-player (200) and focused overlays (player/reader/listen, 500).
       IMPORTANT: --bf-nav-h is the CONTENT height; with border-box sizing the
       total height must ADD the safe-area inset, otherwise the home-indicator
       padding eats the button space and everything anchored to
       calc(nav-h + inset) floats above the rail's real top edge. */
    .bottom-nav { position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
      height: calc(var(--bf-nav-h) + env(safe-area-inset-bottom));
      padding-bottom: env(safe-area-inset-bottom); display: flex; align-items: stretch; justify-content: center;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      border-top: 0.5px solid var(--border-subtle);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); }
    /* Equal-size buttons sitting next to each other; capped width on desktop, and
       they shrink to fit narrow phones (5 × min(20vw,84px)). iOS tinting: inactive
       is secondary gray, active is the tint color — no opacity tricks. */
    .bn-item { flex: 0 0 auto; width: min(20vw, 84px); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      background: none; border: none; cursor: pointer; color: var(--text-secondary); padding: 2px 0 0; }
    .bn-item:active { opacity: 0.6; }
    .bn-item.active { color: var(--accent); }
    /* The center ＋ is a raised accent circle — the tab bar's primary action. */
    .bn-plus { width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: #fff;
      display: flex; align-items: center; justify-content: center; }
    .bn-center { color: var(--text-secondary); }
    .bn-label { font-size: 10px; font-weight: 500; letter-spacing: 0.1px; }
    /* Roomier rail + buttons on desktop (the rail height itself comes from the
       shell's --bf-nav-h media query). */
    @media (min-width: 768px) {
      .bn-item { width: 108px; gap: 4px; }
      .bn-item:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
      .bn-label { font-size: 12px; }
    }

    /* Desktop fills the width with more, smaller cards (3-up is only for the
       narrow phone / mobile-web layout). auto-fill keeps card size steady and
       adds columns as the window widens; the cap just stops it going edge-to-edge
       on very wide monitors. */
    @media (min-width: 768px) { .books-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; max-width: 1200px; margin: 0 auto; } }
    @media (max-width: 480px) { .tab-btn { padding: 5px 7px; font-size: 11px; } }
  `],
})
export class ShelfComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  readonly theme = inject(ThemeService);
  readonly player = inject(PlayerService);
  readonly readerSvc = inject(ReaderService);
  readonly readerState = inject(ReaderStateService);
  readonly cfg = inject(ServerConfigService);
  readonly local = inject(LocalLibraryService);
  private readonly actions = inject(BookActionsService);
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
  // Covers / squareCovers are keyed by a per-server composite (see akey/ekey), so
  // the same Syncthing-synced book on two servers keeps distinct rows + covers.
  readonly covers = signal<Map<string, string>>(new Map());
  readonly squareCovers = signal<Set<string>>(new Set());
  private readonly requestedCovers = new Set<string>();

  // Server (libraries) menu: open state + per-server fetch status for the row
  // spinner / "offline" label.
  readonly serverMenuOpen = signal(false);
  readonly serverStatus = signal<Map<string, 'loading' | 'ok' | 'offline'>>(new Map());

  /** Per-server row key so synced duplicates across servers don't collide the
   *  @for track (which throws on duplicate keys) or share a cover cache slot. */
  akey(b: Audiobook): string { return `${b.originServerId ?? ''}::${b.downloadPath}`; }
  ekey(b: Ebook): string { return `${b.originServerId ?? ''}::${b.relativePath}`; }

  readonly queue = signal<QueueData | null>(null);
  private queueTimer: ReturnType<typeof setInterval> | null = null;

  readonly round = Math.round;
  readonly formatSize = formatSize;

  // ── Derived lists ──────────────────────────────────────────────────────────
  private readonly sortedAudiobooks = computed(() => {
    const list = [...this.audiobooks()];
    if (this.sort() === 'date') {
      // "Recent" = the newer of when it was TTS'd (dateAdded) and when it was
      // last played. So a book you're actively listening to on this device rises
      // to the top even if it was rendered long ago. Playback is keyed per
      // variant, so consider every version's downloadPath, not just the card's.
      const played = this.player.playedAt();
      const recency = (b: Audiobook): number => {
        let ms = b.dateAdded ? Date.parse(b.dateAdded) || 0 : 0;
        ms = Math.max(ms, played.get(b.downloadPath) ?? 0);
        for (const v of b.versions || []) ms = Math.max(ms, played.get(v.downloadPath) ?? 0);
        return ms;
      };
      list.sort((a, b) => recency(b) - recency(a));
    } else {
      list.sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  });

  // "Article" is a tag on the owning project (projectType). Loose ebook files have
  // no project and are always treated as ebooks.
  private isArticle(b: Ebook): boolean {
    return b.projectType === 'article';
  }

  private sortEbookList(list: Ebook[]): Ebook[] {
    const out = [...list];
    if (this.sort() === 'date') out.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
    else out.sort((a, b) => a.title.localeCompare(b.title));
    return out;
  }

  // Ebooks tab EXCLUDES the Articles category; the Articles tab is only that category.
  private readonly sortedEbooks = computed(() => this.sortEbookList(this.ebooks().filter((b) => !this.isArticle(b))));
  private readonly sortedArticles = computed(() => this.sortEbookList(this.ebooks().filter((b) => this.isArticle(b))));

  readonly tags = computed(() => {
    const set = new Set<string>();
    const t = this.tab();
    const source = t === 'audiobooks' ? this.audiobooks() : t === 'articles' ? this.sortedArticles() : this.sortedEbooks();
    for (const b of source) for (const tag of b.tags || []) set.add(tag);
    return [...set].sort();
  });

  readonly totalForTab = computed(() => {
    const t = this.tab();
    return t === 'audiobooks' ? this.audiobooks().length : t === 'articles' ? this.sortedArticles().length : this.sortedEbooks().length;
  });

  readonly filteredAudiobooks = computed(() => {
    const q = this.search().trim();
    const tag = this.activeTag();
    return this.sortedAudiobooks().filter((b) => {
      if (tag !== 'all' && !(b.tags || []).includes(tag)) return false;
      if (!q) return true;
      return looseMatch(`${b.title} ${b.author || ''}`, q);
    });
  });

  private filterEbookList(list: Ebook[]): Ebook[] {
    const q = this.search().trim();
    const tag = this.activeTag();
    return list.filter((b) => {
      if (tag !== 'all' && !(b.tags || []).includes(tag)) return false;
      if (!q) return true;
      const author = b.authorFull || b.authorLast || '';
      return looseMatch(`${b.title} ${author}`, q);
    });
  }

  readonly filteredEbooks = computed(() => this.filterEbookList(this.sortedEbooks()));
  readonly filteredArticles = computed(() => this.filterEbookList(this.sortedArticles()));

  readonly visibleCount = computed(() => {
    const t = this.tab();
    return t === 'audiobooks' ? this.filteredAudiobooks().length : t === 'articles' ? this.filteredArticles().length : this.filteredEbooks().length;
  });

  readonly activeJobs = computed(() => {
    const jobs = this.queue()?.jobs ?? [];
    // Minimal view: show standalone + child jobs that are pending/processing/error.
    return jobs.filter((j) => j.status === 'pending' || j.status === 'processing' || j.status === 'error');
  });

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  private readStoredTab(): Tab {
    const t = localStorage.getItem('bookshelf-tab');
    return t === 'ebooks' || t === 'articles' || t === 'queue' || t === 'analytics' || t === 'audiobooks' ? t : 'audiobooks';
  }

  // Reload whenever the SET of enabled servers changes (add / remove / toggle a
  // library). Only that set is a tracked dependency — the load itself runs
  // untracked so setting the active server when a book is opened (which changes
  // baseUrl, not the enabled set) does NOT trigger a shelf reload. On the web
  // configured() is always true and this runs once at construction.
  private lastServerKey: string | null = null;

  constructor() {
    effect(() => {
      const key = this.cfg.enabledServers().map((s) => `${s.id}@${s.url}`).join(','); // tracked
      untracked(() => {
        if (!this.cfg.configured()) return;
        if (this.lastServerKey !== null && this.lastServerKey !== key) {
          // Server set changed — drop caches so lists/covers rebuild cleanly.
          this.ebooks.set([]);
          this.covers.set(new Map());
          this.squareCovers.set(new Set());
          this.requestedCovers.clear();
        }
        this.lastServerKey = key;
        void this.initialLoad();
      });
    });
  }

  ngOnInit(): void { /* boot is driven by the configured() effect above */ }

  private async initialLoad(): Promise<void> {
    // Audiobooks stay loaded regardless (covers, mini-player); then honor the
    // restored tab so a refresh lands where the reader left off.
    await this.loadAudiobooks();
    const t = this.tab();
    if (t === 'ebooks' || t === 'articles') await this.loadEbooks();
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
    if ((tab === 'ebooks' || tab === 'articles') && this.ebooks().length === 0) await this.loadEbooks();
  }

  setSort(sort: Sort): void {
    this.sort.set(sort);
    localStorage.setItem('bookshelf-sort', sort);
  }

  // ── ＋ import sheet ─────────────────────────────────────────────────────────
  readonly importOpen = signal(false);
  readonly importUrl = signal('');
  readonly importBusy = signal(false);
  readonly importError = signal<string | null>(null);
  readonly urlExpanded = signal(false); // "Paste a URL" row expands to an inline input
  readonly localBusy = signal(false);   // "Add to this device" is importing

  /** Center "+" on the nav rail → the iOS import bottom sheet (file / URL). */
  openImport(): void {
    this.importError.set(null);
    this.importUrl.set('');
    this.urlExpanded.set(false);
    this.importOpen.set(true);
  }

  closeImport(): void {
    if (this.importBusy()) return; // don't yank the sheet mid-ingest
    this.importOpen.set(false);
  }

  /** "Paste a URL" row → reveal / collapse the inline URL field. */
  toggleUrlInput(): void {
    if (this.importBusy()) return;
    this.urlExpanded.update((v) => !v);
  }

  async onImportFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file later
    if (file) await this.startImport({ file });
  }

  /** "Add to this device" → copy a finished M4B/MP3/EPUB into the on-device
   *  library and surface it under "This device". No server, no processing. */
  async onImportLocalFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importError.set(null);
    this.localBusy.set(true);
    try {
      const meta = await this.local.importFile(file);
      this.importOpen.set(false);
      if (meta.kind === 'audiobook') { this.setTab('audiobooks'); await this.loadAudiobooks(true); }
      else { this.setTab('ebooks'); await this.loadEbooks(true); }
    } catch (err) {
      console.error('[Shelf] local import failed', err);
      this.importError.set('Could not add that file to this device.');
    } finally {
      this.localBusy.set(false);
    }
  }

  /** Ingest a URL/file into blocks, then hand off to the editor (blocks via
   *  router state). URL defaults to the Article tag; a file defaults to Ebook. */
  async startImport(src: { url?: string; file?: File }): Promise<void> {
    const token = this.readerSvc.token();
    if (!token) { this.importError.set('Sign in as a reader to import.'); return; }
    this.importBusy.set(true);
    this.importError.set(null);
    try {
      // A PDF opens in the page-crop editor (mupdf-style); everything else goes
      // straight to the flow (block-list) editor.
      if (src.file && /\.pdf$/i.test(src.file.name)) {
        const pdf = await this.api.ingestPdfForEdit(token, src.file);
        if (!pdf.pages?.length) { this.importError.set('No pages found in that PDF.'); return; }
        this.importOpen.set(false);
        await this.router.navigate(['/edit-pdf'], { state: { docId: pdf.docId, title: pdf.title, pages: pdf.pages, defaultTag: 'book' } });
        return;
      }
      const res = await this.api.ingestReader(token, src);
      const blocks = (res.blocks || []).map((t, i) => ({ id: `b${i}`, text: t }));
      if (!blocks.length) { this.importError.set('No readable text found.'); return; }
      const defaultTag: 'book' | 'article' = src.url ? 'article' : 'book';
      this.importOpen.set(false);
      await this.router.navigate(['/edit'], { state: { title: res.title || '', blocks, defaultTag, url: src.url || null } });
    } catch (err) {
      this.importError.set(err instanceof Error ? err.message : 'Could not read that source.');
    } finally {
      this.importBusy.set(false);
    }
  }

  /** The "paste text to listen" shortcut → the ephemeral Listen surface. */
  quickListen(): void {
    this.importOpen.set(false);
    this.router.navigate(['/listen']);
  }

  /** 🎧 on a project-backed card → the Read&Listen view (stream or TTS the book). */
  openListen(book: Ebook, event?: Event): void {
    event?.stopPropagation();
    if (book.projectId) {
      this.useOriginServer(book.originServerId); // route the listen surface to its server
      this.router.navigate(['/book', book.projectId]);
    }
  }

  // ── Article list rows (list view + long-press/right-click delete) ──────────────
  /** Secondary line under an article title: author (if any) + when it was added. */
  articleSubtitle(book: Ebook): string {
    const author = this.ebookAuthor(book);
    const date = book.dateAdded ? new Date(book.dateAdded).toLocaleDateString() : '';
    return [author, date].filter(Boolean).join(' · ');
  }

  /** Tapping a row opens the reader — unless a long-press just fired the delete
   *  sheet, in which case we swallow the trailing click. */
  onArticleRowClick(book: Ebook): void {
    if (this.suppressRowClick) { this.suppressRowClick = false; return; }
    this.openEbook(book);
  }

  // Long-press bookkeeping: a ~500ms hold without significant movement reveals the
  // delete sheet; any real movement (a scroll) cancels it.
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private pressStart: { x: number; y: number } | null = null;
  private suppressRowClick = false;

  onRowPointerDown(book: Ebook, event: PointerEvent): void {
    if (event.button === 2) return; // right-click handled by contextmenu
    this.clearLongPress();
    this.pressStart = { x: event.clientX, y: event.clientY };
    this.longPressTimer = setTimeout(() => {
      this.suppressRowClick = true; // the ensuing click must not open the reader
      this.deleteTarget.set(book);
      this.clearLongPress();
    }, 500);
  }

  onRowPointerMove(event: PointerEvent): void {
    if (!this.pressStart) return;
    const dx = Math.abs(event.clientX - this.pressStart.x);
    const dy = Math.abs(event.clientY - this.pressStart.y);
    if (dx > 10 || dy > 10) this.clearLongPress(); // treat as a scroll/drag
  }

  onRowPointerEnd(): void {
    this.clearLongPress();
  }

  private clearLongPress(): void {
    if (this.longPressTimer) { clearTimeout(this.longPressTimer); this.longPressTimer = null; }
    this.pressStart = null;
  }

  /** Visible ⋯ button → same delete affordance as long-press/right-click. Stops
   *  propagation so the row's own click doesn't also open the reader. */
  openArticleActions(book: Ebook, event: Event): void {
    event.stopPropagation();
    this.clearLongPress();
    this.deleteTarget.set(book);
  }

  /** Right-click → same delete affordance (no browser context menu). */
  onRowContextMenu(book: Ebook, event: Event): void {
    event.preventDefault();
    this.clearLongPress();
    this.suppressRowClick = true;
    this.deleteTarget.set(book);
  }

  // ── Delete an article (action sheet → DELETE /api/project) ─────────────────────
  readonly deleteTarget = signal<Ebook | null>(null);
  readonly deleting = signal(false);

  closeDelete(): void {
    if (this.deleting()) return;
    this.deleteTarget.set(null);
  }

  async confirmDeleteArticle(): Promise<void> {
    const book = this.deleteTarget();
    if (!book?.projectId) { this.deleteTarget.set(null); return; }
    const token = this.readerSvc.token();
    if (!token) { this.deleteTarget.set(null); this.flash('Sign in to manage your library.'); return; }
    this.deleting.set(true);
    try {
      await this.api.deleteProject(token, book.projectId);
      // Drop it from the loaded list so the row disappears without a full reload.
      this.ebooks.update((list) => list.filter((b) => b.projectId !== book.projectId));
      this.deleteTarget.set(null);
      this.flash('Article deleted.');
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      this.deleting.set(false);
    }
  }

  setTag(tag: string): void {
    this.activeTag.set(tag);
  }

  // ── Book context menu (long-press / right-click a grid card) ───────────────────
  readonly bookMenu = signal<BookMenu | null>(null);
  readonly menuBusy = signal(false);

  audioMenu(book: Audiobook): BookMenu {
    return {
      kind: 'audiobook', title: book.title, audiobook: book,
      isLocal: this.actions.isLocal(book),
      canDownload: this.actions.canDownload(book),
      isDownloaded: this.actions.isDownloaded(book),
    };
  }
  ebookMenu(book: Ebook): BookMenu {
    return {
      kind: 'ebook', title: book.title, ebook: book,
      isLocal: this.actions.isLocal(book), canDownload: false, isDownloaded: false,
    };
  }

  /** Long-press a card (~500ms, no scroll) → open its action menu; the ensuing
   *  click is swallowed so the book doesn't also open. Reuses the article row's
   *  long-press bookkeeping (timer / move-cancel / suppress flag). */
  onCardPointerDown(menu: BookMenu, event: PointerEvent): void {
    if (event.button === 2) return; // right-click handled by contextmenu
    this.clearLongPress();
    this.pressStart = { x: event.clientX, y: event.clientY };
    this.longPressTimer = setTimeout(() => {
      this.suppressRowClick = true;
      this.bookMenu.set(menu);
      this.clearLongPress();
    }, 500);
  }

  /** Right-click a card → same menu, no browser context menu. */
  onCardContextMenu(menu: BookMenu, event: Event): void {
    event.preventDefault();
    this.clearLongPress();
    this.suppressRowClick = true;
    this.bookMenu.set(menu);
  }

  closeBookMenu(): void {
    if (this.menuBusy()) return;
    this.bookMenu.set(null);
  }

  canMarkFinished(bm: BookMenu): boolean {
    return bm.kind === 'audiobook' && !!bm.audiobook && this.actions.canMarkFinished(bm.audiobook);
  }

  async doDownload(bm: BookMenu): Promise<void> {
    if (!bm.audiobook) return;
    this.menuBusy.set(true);
    try {
      await this.actions.downloadAudiobook(bm.audiobook);
      this.bookMenu.set(null);
      this.flash('Saved for offline.');
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Download failed.');
    } finally {
      this.menuBusy.set(false);
    }
  }

  async doRemoveDownload(bm: BookMenu): Promise<void> {
    if (!bm.audiobook) return;
    this.menuBusy.set(true);
    try {
      await this.actions.removeDownload(bm.audiobook);
      this.bookMenu.set(null);
      this.flash('Offline copy removed.');
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Could not remove the download.');
    } finally {
      this.menuBusy.set(false);
    }
  }

  doMarkFinished(bm: BookMenu): void {
    if (bm.audiobook) this.actions.audioMarkFinished(bm.audiobook);
    this.bookMenu.set(null);
    this.flash('Marked as finished.');
  }

  doStartOver(bm: BookMenu): void {
    if (bm.kind === 'audiobook' && bm.audiobook) this.actions.audioStartOver(bm.audiobook);
    else if (bm.ebook) this.actions.ebookStartOver(bm.ebook);
    this.bookMenu.set(null);
    this.flash('Back to the beginning.');
  }

  async doEraseHistory(bm: BookMenu): Promise<void> {
    this.menuBusy.set(true);
    try {
      if (bm.kind === 'audiobook' && bm.audiobook) await this.actions.audioEraseHistory(bm.audiobook);
      else if (bm.ebook) this.actions.ebookEraseHistory(bm.ebook);
      this.bookMenu.set(null);
      this.flash('History erased.');
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Could not erase history.');
    } finally {
      this.menuBusy.set(false);
    }
  }

  async doRemoveLocal(bm: BookMenu): Promise<void> {
    this.menuBusy.set(true);
    try {
      if (bm.kind === 'audiobook' && bm.audiobook) {
        await this.actions.removeLocalAudiobook(bm.audiobook);
        await this.loadAudiobooks(true);
      } else if (bm.ebook) {
        await this.actions.removeLocalEbook(bm.ebook);
        await this.loadEbooks(true);
      }
      this.bookMenu.set(null);
      this.flash('Removed from this device.');
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Could not remove that.');
    } finally {
      this.menuBusy.set(false);
    }
  }

  // ── Data loading ─────────────────────────────────────────────────────────────
  private setServerStatus(id: string, status: 'loading' | 'ok' | 'offline'): void {
    const next = new Map(this.serverStatus());
    next.set(id, status);
    this.serverStatus.set(next);
  }

  // Fan a load across every enabled server, tag each result with its origin, and
  // merge. A server that can't be reached contributes nothing and is marked
  // "offline" in the menu (its row spins while in flight). Only when EVERY server
  // fails do we show the full-screen error — one reachable server still renders.
  private async loadAudiobooks(force = false): Promise<void> {
    const servers = this.cfg.enabledServers();
    if (this.audiobooks().length === 0) this.loading.set(true);
    this.loadError.set(null);
    let anyOk = false;
    const perServer = await Promise.all(servers.map(async (s) => {
      this.setServerStatus(s.id, 'loading');
      try {
        const books = await this.api.getBooks(force, s.id);
        this.setServerStatus(s.id, 'ok');
        anyOk = true;
        return books.map((b) => ({ ...b, originServerId: s.id }));
      } catch (err) {
        console.error(`[Shelf] audiobooks from ${s.label} failed`, err);
        this.setServerStatus(s.id, 'offline');
        return [] as Audiobook[];
      }
    }));
    this.audiobooks.set(perServer.flat());
    if (servers.length > 0 && !anyOk) this.loadError.set('Could not reach the server. Tap ⟳ to retry.');
    this.loading.set(false);
  }

  private async loadEbooks(force = false): Promise<void> {
    const servers = this.cfg.enabledServers();
    if (this.ebooks().length === 0) this.loading.set(true);
    this.loadError.set(null);
    let anyOk = false;
    const perServer = await Promise.all(servers.map(async (s) => {
      this.setServerStatus(s.id, 'loading');
      try {
        const books = await this.api.getEbooks(force, s.id);
        this.setServerStatus(s.id, 'ok');
        anyOk = true;
        return books.map((b) => ({ ...b, originServerId: s.id }));
      } catch (err) {
        console.error(`[Shelf] ebooks from ${s.label} failed`, err);
        this.setServerStatus(s.id, 'offline');
        return [] as Ebook[];
      }
    }));
    this.ebooks.set(perServer.flat());
    if (servers.length > 0 && !anyOk) this.loadError.set('Could not reach the server. Tap ⟳ to retry.');
    this.loading.set(false);
  }

  async refresh(): Promise<void> {
    this.refreshing.set(true);
    try {
      if (this.tab() === 'audiobooks') await this.loadAudiobooks(true);
      else if (this.tab() === 'ebooks' || this.tab() === 'articles') await this.loadEbooks(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  // ── Covers ───────────────────────────────────────────────────────────────────
  async loadAudioCover(book: Audiobook): Promise<void> {
    const key = this.akey(book);
    if (this.requestedCovers.has(key)) return;
    this.requestedCovers.add(key);
    const cover = await this.api.getCover(book); // routes to book.originServerId
    if (cover) this.setCover(key, cover);
  }

  async loadEbookCover(book: Ebook): Promise<void> {
    const key = this.ekey(book);
    if (this.requestedCovers.has(key)) return;
    this.requestedCovers.add(key);
    const cover = await this.api.getEbookCover(book.relativePath, book.originServerId);
    if (cover) this.setCover(key, cover);
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

  /** Point the single-server accessors (audio/position/analytics/reader token) at
   *  the server a book came from, so the existing one-book-at-a-time playback and
   *  reader code just works against the right library. A no-op with one server. */
  private useOriginServer(id?: string): void {
    if (id) this.cfg.setActive(id);
  }

  openPlayer(book: Audiobook): void {
    // A long-press just opened the context menu → swallow the trailing click.
    if (this.suppressRowClick) { this.suppressRowClick = false; return; }
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
    this.useOriginServer(book.originServerId); // route playback to the book's server
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
    if (this.suppressRowClick) { this.suppressRowClick = false; return; }
    if (book.versions && book.versions.length > 1) {
      this.pickerEbook.set(book);
      return;
    }
    this.openEbookRef(book.relativePath, book.format, book.title, this.ebookAuthor(book), book.originServerId);
  }

  chooseEbookVersion(book: Ebook, v: EbookVersion): void {
    this.closePicker();
    this.openEbookRef(v.relativePath, v.format, v.title, v.authorFull || this.ebookAuthor(book), book.originServerId);
  }

  /** Open a specific ebook file in the reader (epub/pdf) or download it. Each
   *  version's relativePath keys its own reader position/bookmarks. */
  private openEbookRef(relativePath: string, format: string, title: string, author: string, originServerId?: string): void {
    this.useOriginServer(originServerId); // route the reader to the book's server
    const fmt = (format || '').toLowerCase();
    if (fmt === 'epub' || fmt === 'pdf') {
      this.router.navigate(['/read', encodePathId(`e:${relativePath}`)], {
        state: { title, author, cover: this.covers().get(`${originServerId ?? ''}::${relativePath}`) ?? null },
      });
    } else {
      const a = document.createElement('a');
      a.href = this.api.ebookDownloadUrl(relativePath, originServerId);
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
    a.href = this.api.ebookDownloadUrl(book.relativePath, book.originServerId);
    a.download = book.filename || 'book';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ── Reclassify (Ebook ⇆ Article tag on the project) ────────────────────────────
  readonly moving = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  async reclassify(book: Ebook, event?: Event): Promise<void> {
    event?.stopPropagation(); // don't also open the reader
    if (!book.projectId) return; // only project-backed items carry a tag
    const token = this.readerSvc.token();
    if (!token) { this.flash('Sign in to organize your library.'); return; }
    // On the Articles tab → mark back as Ebook; anywhere else → mark as Article.
    const type: 'book' | 'article' = this.tab() === 'articles' ? 'book' : 'article';
    this.moving.set(book.projectId);
    try {
      await this.api.reclassifyEbook(token, book.projectId, type);
      await this.loadEbooks(true); // the item leaves this tab / joins the other
      this.flash(type === 'article' ? 'Marked as Article.' : 'Marked as Ebook.');
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Failed.');
    } finally {
      this.moving.set(null);
    }
  }

  private flash(msg: string): void {
    this.notice.set(msg);
    setTimeout(() => this.notice.set(null), 3500);
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

  // ── Server (libraries) menu ────────────────────────────────────────────────────
  /** Checkbox: show/hide a library's books. Hiding is instant. Enabling PROBES the
   *  server first (its row spins); on success it's checked and the enabledServers
   *  effect reloads the merged shelf, on failure it stays unchecked and shows
   *  "offline" — re-tapping is the retry. */
  async toggleServer(s: ServerEntry): Promise<void> {
    if (s.enabled) { this.cfg.toggleServer(s.id, false); return; }
    // The on-device library is always "reachable" — no server to ping.
    if (s.local) { this.setServerStatus(s.id, 'ok'); this.cfg.toggleServer(s.id, true); return; }
    this.setServerStatus(s.id, 'loading');
    if (await this.api.ping(s.id)) {
      this.setServerStatus(s.id, 'ok');
      this.cfg.toggleServer(s.id, true); // → effect fans the shelf across servers
    } else {
      this.setServerStatus(s.id, 'offline'); // stays unchecked
    }
  }

  /** ✕: forget a server entirely (not the same as hiding it). */
  removeServer(s: ServerEntry, event: Event): void {
    event.stopPropagation();
    this.cfg.removeServer(s.id);
  }

  /** "Add a server" → the connect gate (verifies /api/health, then joins the list). */
  addServerPrompt(): void {
    this.serverMenuOpen.set(false);
    this.cfg.openPrompt();
  }

  // ── Account menu (top-right) ──────────────────────────────────────────────────
  readonly accountMenuOpen = signal(false);

  /** Re-open the "Who's reading?" picker to switch (or first choose) a profile. */
  chooseProfile(): void {
    this.accountMenuOpen.set(false);
    this.readerSvc.switchReader();
  }

  /** Open the connect screen to pair with a different (or the first) server. The
   *  actual reader reset happens in App's effect once the server actually changes,
   *  so cancelling here leaves the current session untouched. */
  switchServer(): void {
    this.accountMenuOpen.set(false);
    this.cfg.openPrompt();
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
