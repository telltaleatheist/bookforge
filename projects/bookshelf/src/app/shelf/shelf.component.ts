import { Component, computed, effect, ElementRef, inject, OnDestroy, OnInit, signal, untracked } from '@angular/core';
import { UpperCasePipe, NgTemplateOutlet } from '@angular/common';
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
import { LocalLibraryService, LOCAL_SERVER_ID } from '../services/local-library.service';
import { OfflineStoreService, OfflineItem } from '../services/offline-store.service';
import { BookActionsService } from '../services/book-actions.service';
import { AnalyticsComponent } from '../analytics/analytics.component';
import { Audiobook, AudiobookVersion, Ebook, EbookVersion, QueueData, QueueJob } from '../models/types';

type Tab = 'audiobooks' | 'ebooks' | 'articles' | 'queue' | 'analytics';
type Sort = 'title' | 'date';
type Narration = 'all' | 'professional';

/** One target of the grid book context menu (long-press / right-click a card). */
interface BookMenu {
  kind: 'audiobook' | 'ebook';
  title: string;
  audiobook?: Audiobook;
  ebook?: Ebook;
  isLocal: boolean;
}

@Component({
  selector: 'app-shelf',
  standalone: true,
  imports: [VisibleDirective, UpperCasePipe, NgTemplateOutlet, IconComponent, AnalyticsComponent],
  template: `
    <!-- The navbar and the download progress strip stick together at the top so
         the strip stays visible while the shelf scrolls under them. -->
    <div class="topbar-sticky">
    <nav class="navbar">
      <div class="nav-title">
        <h1>Bookshelf</h1>
      </div>
      <div class="nav-controls">
        <!-- Servers: the multi-server library switcher. Each row is a server the
             app stays connected to; tapping toggles its books (row lights up when
             showing), the ✕ removes it entirely. Enabling one that's asleep spins,
             then flips to "offline" if it can't be reached. Shown once there's more
             than one library to juggle (or always on native, where you pair remotes). -->
        @if (cfg.isNative || cfg.servers().length > 1) {
          <div class="account">
            <button class="theme-toggle" (click)="serverMenuOpen.set(!serverMenuOpen())"
                    title="Libraries" aria-label="Libraries">
              <app-icon name="server" [size]="18" />
            </button>
            @if (serverMenuOpen()) {
              <div class="menu-backdrop" (click)="serverMenuOpen.set(false)"></div>
              <div class="account-menu server-menu" role="menu">
                <div class="menu-caption">Libraries</div>
                @for (s of orderedServers(); track s.id; let i = $index) {
                  @if (i === deviceCount() && deviceCount() > 0) { <div class="menu-divider"></div> }
                  <div class="server-row">
                    @if (editingServer() === s.id) {
                      <input class="server-rename" [value]="editServerLabel()" autofocus
                             placeholder="Name this library"
                             (input)="editServerLabel.set($any($event.target).value)"
                             (keydown.enter)="saveServerLabel(s)"
                             (keydown.escape)="editingServer.set(null)"
                             (blur)="saveServerLabel(s)" />
                    } @else {
                      <button class="server-toggle" role="menuitemcheckbox"
                              [class.on]="s.enabled"
                              [attr.aria-checked]="s.enabled" (click)="toggleServer(s)">
                        <span class="server-label" [title]="s.url || 'This device'">{{ s.label }}</span>
                        @if (serverStatus().get(s.id) === 'loading') {
                          <span class="server-state spin">⟳</span>
                        } @else if (serverStatus().get(s.id) === 'offline') {
                          <span class="server-state off">offline</span>
                        }
                      </button>
                      <!-- Local "This device" is a fixed label; servers (incl. the served
                           library) are renameable. -->
                      @if (!s.local) {
                        <button class="server-edit" (click)="startRenameServer(s)" aria-label="Rename"><app-icon name="edit" [size]="14" /></button>
                      }
                      @if (!s.local) {
                        <button class="server-x" (click)="removeServer(s, $event)" aria-label="Remove server">×</button>
                      }
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
                    <app-icon name="server" [size]="17" />
                    <span>{{ cfg.baseUrl() ? 'Switch server' : 'Connect to a server' }}</span>
                  </button>
                }
              </div>
            }
          </div>
        }
        <button class="theme-toggle" (click)="theme.cycle()" [title]="'Theme: ' + theme.label() + ' (tap to change)'">
          {{ theme.icon() }}
        </button>
      </div>
    </nav>

    </div>

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
        @if (tab() === 'audiobooks' && downloadedCount() > 0) {
          <button class="dl-filter" [class.active]="downloadedOnly()" (click)="downloadedOnly.set(!downloadedOnly())"
                  [title]="downloadedOnly() ? 'Showing downloaded only — tap to show all' : 'Show only downloaded'">
            <app-icon name="download" [size]="14" />
            <span>{{ downloadedCount() }}</span>
          </button>
        }
      </div>

      @if (tags().length > 0) {
        <div class="category-bar">
          <button class="category-pill" [class.active]="activeTag() === 'all'" (click)="setTag('all')">All ({{ totalForTab() }})</button>
          @for (t of tags(); track t) {
            <button class="category-pill" [class.active]="activeTag() === t" (click)="setTag(t)">{{ t }}</button>
          }
        </div>
      }

      @if (tab() === 'audiobooks') {
        <div class="category-bar narration-bar" role="group" aria-label="Filter by narration">
          <button class="category-pill" [class.active]="narration() === 'all'" (click)="setNarration('all')">All</button>
          <button class="category-pill" [class.active]="narration() === 'professional'" (click)="setNarration('professional')">Professional</button>
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

    <main class="content" [class.has-mini]="player.book() || readerState.session()"
      (touchstart)="onPullStart($event)" (touchmove)="onPullMove($event)"
      (touchend)="onPullEnd()" (touchcancel)="onPullEnd()">
      <!-- Pull-to-refresh: a spacer that grows with the drag; releasing past the
           trigger busts the server cache (backgrounded, so the shelf stays up). -->
      <div class="pull-refresh" [class.pulling]="pulling()" [style.height.px]="refreshing() ? 46 : pullY()">
        <span class="pull-spinner" [class.ready]="pullY() >= 70 || refreshing()" [class.spin]="refreshing()"
          [style.transform]="'rotate(' + (pullY() * 3) + 'deg)'">⟳</span>
      </div>
      @if (!cfg.configured() && audiobooks().length === 0 && ebooks().length === 0) {
        <!-- Native app, not yet paired with a library server AND nothing imported
             on-device. The app no longer blocks on a server picker at launch —
             this centered CTA (and the top-right account menu) is how you
             connect. Once anything is on the shelf (even a local import), the
             shelf renders normally and pairing stays in the menus. -->
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
        <!-- The audiobook card, defined once and rendered in both the "On this
             device" grid and the "All audiobooks" grid so the two never drift. -->
        <ng-template #audioCard let-book>
          <div class="book-card" [class.external]="book.source === 'external'" [class.downloaded]="isDownloadedCard(book)" [class.professional]="book.hasProfessional" (click)="openPlayer(book)"
               (contextmenu)="onCardContextMenu(audioMenu(book), $event)"
               (pointerdown)="onCardPointerDown(audioMenu(book), $event)"
               (pointermove)="onRowPointerMove($event)"
               (pointerup)="onRowPointerEnd()"
               (pointercancel)="onRowPointerEnd()"
               (pointerleave)="onRowPointerEnd()">
            <div class="book-cover"
              appVisible (visible)="loadAudioCover(book)">
              @if (covers().get(akey(book)); as src) {
                <img class="cover-bg" [src]="src" aria-hidden="true" />
                <img class="cover-fg" [src]="src" alt="Cover" />
              } @else {
                <span class="placeholder">🎧</span>
              }
              <!-- Offline download in progress: an iOS-style ring over a dimmed
                   cover that fills as bytes arrive (a static, pulsing track while
                   queued), with a stop square in the middle to cancel. The dim
                   layer is click-through (pointer-events:none); only the center
                   button is interactive, so a tap elsewhere still opens the book.
                   The finished book sheds the overlay and lights up fully. -->
              @if (dlOverlay(book); as dl) {
                <div class="dl-cover-overlay" [class.queued]="dl.state === 'queued'">
                  <svg class="dl-ring" viewBox="0 0 36 36" aria-hidden="true">
                    <circle class="dl-ring-track" cx="18" cy="18" r="16"></circle>
                    <circle class="dl-ring-fill" cx="18" cy="18" r="16"
                      [style.stroke-dasharray]="ringCirc" [style.stroke-dashoffset]="ringOffset(dl.percent)"></circle>
                  </svg>
                  <button class="dl-stop" (click)="onCoverDownloadTap(book, $event)"
                    [attr.aria-label]="dl.state === 'queued' ? 'Remove from download queue' : 'Cancel download'">
                    <span class="dl-stop-square"></span>
                  </button>
                </div>
              }
              @if (badgeIcon(book); as ic) {
                <span class="book-type-badge badge-icon m4b" [title]="badge(book)"><app-icon [name]="ic" [size]="13" /></span>
              } @else {
                <span class="book-type-badge m4b">{{ badge(book) }}</span>
              }
              <button class="cover-menu-btn" (click)="openMenuFor(audioMenu(book), $event)" aria-label="More actions">
                <app-icon name="more" [size]="18" />
              </button>
            </div>
            <div class="book-info">
              <div class="book-title" [title]="book.title">{{ book.title }}</div>
              @if (book.author) { <div class="book-author">{{ book.author }}</div> }
              <div class="book-size">{{ sizeAndDuration(book) }}</div>
            </div>
          </div>
        </ng-template>

        @if (downloadedAudiobooks().length > 0) {
          <div class="shelf-section-head downloaded-head">
            <app-icon name="download" [size]="15" />
            <span>On this device</span>
            <span class="count-chip">{{ downloadedAudiobooks().length }}</span>
          </div>
          <div class="books-grid">
            @for (book of downloadedAudiobooks(); track akey(book)) {
              <ng-container *ngTemplateOutlet="audioCard; context: { $implicit: book }"></ng-container>
            }
          </div>
        }
        <!-- One section per source server, headed by that library's name, so you
             can see which server each book streams from. -->
        @for (group of otherAudiobookGroups(); track group.serverId) {
          <div class="shelf-section-head">
            <span>{{ group.label }}</span>
          </div>
          <div class="books-grid">
            @for (book of group.books; track akey(book)) {
              <ng-container *ngTemplateOutlet="audioCard; context: { $implicit: book }"></ng-container>
            }
          </div>
        }
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
              <div class="book-cover"
                appVisible (visible)="loadEbookCover(book)">
                @if (covers().get(ekey(book)); as src) {
                  <img class="cover-bg" [src]="src" aria-hidden="true" />
                  <img class="cover-fg" [src]="src" alt="Cover" />
                } @else {
                  <span class="placeholder">📖</span>
                }
                <span class="book-type-badge" [class]="'format-' + book.format">{{ (book.format || 'epub') | uppercase }}</span>
                <button class="cover-menu-btn" (click)="openMenuFor(ebookMenu(book), $event)" aria-label="More actions">
                  <app-icon name="more" [size]="18" />
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
                <span class="picker-title">@if (v.professionallyRead) {<span class="picker-pro" title="Professionally read">★ </span>}{{ versionLabel(v) }}</span>
                <span class="picker-meta">{{ versionSub(v) }}</span>
              </span>
            </button>
          }
        </div>
      </div>
    }

    <!-- Version picker in DOWNLOAD mode: choose which version to save offline. -->
    @if (downloadPickerBook(); as db) {
      <div class="picker-backdrop" (click)="closePicker()"></div>
      <div class="picker-sheet" [class.above-mini]="!!player.book()" role="dialog" aria-label="Download a version">
        <div class="picker-head">
          <span>Download a version</span>
          <button class="picker-close" (click)="closePicker()" aria-label="Close">×</button>
        </div>
        <div class="picker-sub">{{ db.title }}</div>
        <div class="picker-body">
          @for (v of db.versions; track v.downloadPath) {
            <button class="picker-item" (click)="chooseDownloadVersion(db, v)">
              <span class="picker-icon">{{ v.type === 'bilingual' ? '🌐' : '🎧' }}</span>
              <span class="picker-info">
                <span class="picker-title">@if (v.professionallyRead) {<span class="picker-pro" title="Professionally read">★ </span>}{{ versionLabel(v) }}</span>
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
          <!-- Straight file download to the user's OS — unrelated to the library
               or offline playback (that lives on the player's download button). -->
          @if (!bm.isLocal) {
            <button class="action-btn" [disabled]="menuBusy()" (click)="doDownloadFile(bm)">
              <app-icon name="download" [size]="20" />
              <span>Download file</span>
            </button>
          }
          <!-- Offline copy: download / cancel-in-progress / remove. Remove works
               even when the origin server is off, so a download is always removable. -->
          @if (bm.kind === 'audiobook' && bm.audiobook && !bm.isLocal) {
            @if (isMenuDownloading(bm)) {
              <button class="action-btn" (click)="doCancelDownload(bm)">
                <app-icon name="close" [size]="20" />
                <span>Cancel download{{ menuDlPct(bm) !== null ? ' (' + menuDlPct(bm) + '%)' : '' }}</span>
              </button>
            } @else if (isMenuQueued(bm)) {
              <button class="action-btn" (click)="doCancelDownload(bm)">
                <app-icon name="close" [size]="20" />
                <span>Cancel (queued)</span>
              </button>
            } @else if (isDownloadedBook(bm.audiobook)) {
              <button class="action-btn destructive" [disabled]="menuBusy()" (click)="doRemoveDownload(bm)">
                <app-icon name="trash" [size]="20" />
                <span>{{ menuBusy() ? 'Removing…' : 'Remove download' }}</span>
              </button>
            } @else {
              <button class="action-btn" (click)="doDownloadOffline(bm)">
                <app-icon name="download" [size]="20" />
                <span>Download for offline</span>
              </button>
            }
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

    <!-- ＋ import sheet. Importing NEVER uploads to a server — adding books to a
         library permanently is BookForge desktop's job. "Import a file" copies
         the file into the phone's own on-device library (LocalLibraryService);
         "Paste a URL" fetches an article to read/listen. -->
    @if (importOpen()) {
      <div class="sheet-backdrop" (click)="closeImport()"></div>
      <div class="import-sheet" [class.above-mini]="!!player.book()" role="dialog" aria-label="Add to library">
        <div class="sheet-grabber"></div>
        <div class="import-head">Add to this device</div>

        <!-- Option 1: import a file into the on-device library (label wraps the
             hidden <input>). Audiobooks play from local storage; EPUBs open in
             the reader. Stays on the phone — never sent to a server. -->
        <label class="opt-row" [class.busy]="localBusy()">
          <span class="opt-icon"><app-icon name="file" [size]="22" /></span>
          <span class="opt-text">
            <b>Import a file</b>
            <small>M4B, MP3, EPUB… kept on this device</small>
          </span>
          <input type="file" accept=".m4b,.m4a,.mp3,.aac,.flac,.ogg,.opus,.wav,.epub" hidden
                 [disabled]="localBusy()" (change)="onImportLocalFile($event)" />
        </label>
        @if (localBusy()) { <p class="sheet-note">Adding to this device…</p> }

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
    /* When a book is minimized, lift the sheet above BOTH the nav rail and the
       mini-player (matching the picker/action sheets) so it never tucks behind it. */
    .import-sheet.above-mini { bottom: calc(var(--bf-nav-h) + var(--bf-mini-h) + env(safe-area-inset-bottom)); }
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
    .url-go { flex-shrink: 0; background: var(--accent); color: var(--text-on-accent); border: none; border-radius: 10px; padding: 0 20px; font-size: 15px; font-weight: 600; cursor: pointer; }
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
    .picker-pro { color: var(--professional); }
    .picker-meta { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* The navbar + download strip stick together; the wrapper provides the
       stickiness while the navbar sits in normal flow inside it. Kept
       TRANSPARENT so the navbar's backdrop-filter blurs the scrolling content
       (a solid background here would flatten its translucent glass look); the
       navbar and strip each carry their own background and fully cover it. */
    .topbar-sticky { position: sticky; top: 0; z-index: 100; }
    .navbar { position: relative; display: flex; align-items: center; justify-content: space-between;
      padding: calc(12px + env(safe-area-inset-top)) 16px 12px;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent); border-bottom: 0.5px solid var(--border-subtle);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%); gap: 8px; }
    .nav-title { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; }
    .navbar h1 { font-size: 19px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .nav-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
    .theme-toggle { width: 40px; height: 40px; border: none; background: var(--bg-elevated); border-radius: 8px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; font-size: 18px; color: var(--text-primary); }
    /* The button color drives the icon (currentColor); without it the glyph was
       near-invisible on the dark button in dark/midnight. */
    .theme-toggle app-icon { color: var(--text-primary); }
    .account { position: relative; display: flex; }
    .reader-chip { width: 32px; height: 32px; flex-shrink: 0; border: none; border-radius: 50%; cursor: pointer;
      background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: var(--text-on-accent); font-size: 13px; font-weight: 700;
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
    .server-row { display: flex; align-items: center; gap: 4px; }
    .server-row + .server-row { margin-top: 4px; }
    /* Separates "This device" (top) from the remote servers below it. */
    .menu-divider { height: 1px; margin: 8px 6px; background: var(--border-subtle); }
    /* Selector cards: a showing library lights up (accent border + tint), a
       hidden one sits flat and borderless — the BookForge option-card look. */
    .server-toggle { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; text-align: left;
      padding: 10px 12px; border: 1.5px solid transparent; border-radius: 10px; background: transparent;
      color: var(--text-secondary); font-size: 14px; font-weight: 500; cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease; }
    .server-toggle:hover { background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .server-toggle.on { background: color-mix(in srgb, var(--accent) 14%, transparent);
      border-color: var(--accent); color: var(--text-primary); }
    .server-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .server-state { flex-shrink: 0; font-size: 11px; font-weight: 600; }
    .server-state.off { color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.3px; }
    .server-state.spin { color: var(--accent); animation: spin 0.8s linear infinite; }
    .server-x { flex-shrink: 0; width: 28px; height: 28px; border: none; background: transparent; color: var(--text-tertiary);
      font-size: 20px; line-height: 1; border-radius: 8px; cursor: pointer; }
    .server-x:hover { background: var(--bg-hover); color: var(--error); }
    .server-edit { flex-shrink: 0; width: 28px; height: 28px; border: none; background: transparent; color: var(--text-tertiary);
      display: flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; }
    .server-edit:hover { background: var(--bg-hover); color: var(--text-primary); }
    .server-rename { flex: 1; min-width: 0; padding: 9px 12px; font-size: 14px; color: var(--text-primary);
      background: var(--bg-surface); border: 1.5px solid var(--accent); border-radius: 10px; outline: none; }
    .add-server { margin-top: 4px; border-top: 0.5px solid var(--border-subtle); border-radius: 0 0 8px 8px; color: var(--accent); }
    .add-server app-icon { color: var(--accent); }
    .tab-toggle { display: flex; background: var(--bg-elevated); border-radius: 8px; padding: 2px; gap: 2px; }
    .tab-btn { padding: 6px 10px; border: none; background: transparent; color: var(--text-tertiary); font-size: 12px; font-weight: 500;
      border-radius: 6px; cursor: pointer; white-space: nowrap; }
    .tab-btn.active { background: var(--accent); color: var(--text-on-accent); }
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
    .category-pill.active { background: var(--accent); border-color: var(--accent); color: var(--text-on-accent); }
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

    /* Pull-to-refresh indicator: a top spacer whose height tracks the drag. */
    .pull-refresh { display: flex; align-items: center; justify-content: center; overflow: hidden; height: 0;
      margin: -16px -16px 0; transition: height 0.25s cubic-bezier(0.22,1,0.36,1); }
    .pull-refresh.pulling { transition: none; } /* follow the finger 1:1 while dragging */
    .pull-spinner { font-size: 20px; color: var(--text-tertiary); opacity: 0.6; transition: color 0.15s, opacity 0.15s; }
    .pull-spinner.ready { color: var(--accent); opacity: 1; }
    .pull-spinner.spin { animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .content.has-mini { padding-bottom: calc(var(--bf-nav-h) + var(--bf-mini-h) + 28px + env(safe-area-inset-bottom)); }
    .loading-indicator { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 48px; color: var(--text-secondary); }
    .empty-state { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 48px; color: var(--text-secondary); text-align: center; }
    .empty-icon { font-size: 48px; }
    /* First-run "connect to a server" call-to-action (native, unpaired). */
    .connect-cta { gap: 14px; }
    .connect-title { font-size: 17px; font-weight: 600; color: var(--text-primary); margin: 0; }
    .connect-btn { padding: 12px 22px; border: none; border-radius: 10px; background: var(--accent); color: var(--text-on-accent);
      font-size: 15px; font-weight: 600; cursor: pointer; }
    .connect-btn:active { opacity: 0.8; }
    .connect-hint { font-size: 13px; color: var(--text-tertiary); }
    /* 3-up on phones: minmax low enough that a 390px viewport fits three columns
       (390 − 2×16 padding − 2×10 gaps = 338 → 112px each). */
    .books-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
    .book-card { display: flex; flex-direction: column; background: var(--card-bg); border-radius: 12px; overflow: hidden; cursor: pointer;
      transition: transform 0.2s, box-shadow 0.2s;
      /* A mild outline on every book in every theme. A spread-only box-shadow
         (not the outline property) hugs the rounded corners and is exactly uniform
         all the way around — outline+offset rendered unevenly over the full-bleed
         cover vs the text area. */
      box-shadow: 0 0 0 1px var(--border-subtle);
      /* Allow vertical scroll while a long-press (context menu) is being detected;
         suppress the iOS long-press callout + text selection so the app's own
         menu appears instead of the card getting highlighted/selected. */
      touch-action: pan-y; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
    .book-card:active { transform: scale(0.97); }
    /* On-device ring — any book that lives on the system (locally imported OR
       downloaded for offline) gets the same colored border + soft glow. Books
       that are remote-only keep just the faint hairline above. */
    .book-card.external,
    .book-card.downloaded { box-shadow: 0 0 0 2px var(--downloaded), 0 3px 14px color-mix(in srgb, var(--downloaded) 35%, transparent); }
    /* Professionally-read ring — gold. Overrides the purple downloaded ring: the
       .downloaded.professional rule (specificity 0,3,0) beats .downloaded (0,2,0). */
    .book-card.professional { box-shadow: 0 0 0 2px var(--professional), 0 3px 14px color-mix(in srgb, var(--professional) 35%, transparent); }
    .book-card.downloaded.professional { box-shadow: 0 0 0 2px var(--professional), 0 3px 14px color-mix(in srgb, var(--professional) 35%, transparent); }
    /* Shelf section header ("On this device" / "All audiobooks"). */
    .shelf-section-head { display: flex; align-items: center; gap: 8px; margin: 14px 4px 8px;
      font-size: 13px; font-weight: 700; letter-spacing: .02em; color: var(--text-secondary); text-transform: uppercase; }
    .shelf-section-head.downloaded-head { color: var(--downloaded); }
    .shelf-section-head .count-chip { display: inline-flex; align-items: center; justify-content: center; min-width: 20px;
      height: 20px; padding: 0 6px; border-radius: 10px; background: var(--downloaded); color: var(--text-on-accent);
      font-size: 12px; font-weight: 700; letter-spacing: 0; }
    /* Download progress strip under the top bar. */
    /* Offline-download ring over a book cover (iOS app-download style). */
    .dl-cover-overlay { position: absolute; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.55); pointer-events: none; }
    .dl-ring { width: 48%; max-width: 76px; height: auto; transform: rotate(-90deg); }
    .dl-ring-track { fill: none; stroke: rgba(255, 255, 255, 0.28); stroke-width: 2.5; }
    .dl-ring-fill { fill: none; stroke: #fff; stroke-width: 2.5; stroke-linecap: round; transition: stroke-dashoffset 0.25s ease; }
    /* Queued: no fill yet — a gently pulsing track says "waiting its turn". */
    .dl-cover-overlay.queued .dl-ring { animation: dl-pulse 1.4s ease-in-out infinite; }
    @keyframes dl-pulse { 0%, 100% { opacity: 0.45; } 50% { opacity: 0.9; } }
    .dl-stop { position: absolute; display: flex; align-items: center; justify-content: center;
      width: 30%; max-width: 46px; aspect-ratio: 1; background: none; border: none; padding: 0;
      pointer-events: auto; cursor: pointer; color: #fff; }
    .dl-stop:active { transform: scale(0.88); }
    .dl-stop-square { width: 42%; aspect-ratio: 1; background: #fff; border-radius: 3px; }
    /* "Downloaded" filter toggle in the stats bar. */
    .dl-filter { display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid var(--border-default);
      background: var(--bg-elevated); color: var(--text-secondary); border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; }
    .dl-filter.active { background: var(--downloaded); border-color: var(--downloaded); color: var(--text-on-accent); }
    .book-cover { position: relative; overflow: hidden; aspect-ratio: 1 / 1; background: var(--bg-elevated); display: flex; align-items: center; justify-content: center; }
    /* Square frame: the whole cover (contained) over a zoomed, blurred copy of
       itself that fills the empty sides. Square covers fill it exactly (backfill
       invisible); tall 6×9 covers sit centered with blurred fill on the sides. */
    .book-cover .cover-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; filter: blur(14px); transform: scale(1.15); }
    .book-cover .cover-fg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .book-cover .placeholder { font-size: 36px; color: var(--text-tertiary); }
    .corner-btn { position: absolute; top: 6px; left: 6px; width: 30px; height: 30px; border: none; border-radius: 8px;
      background: rgba(0,0,0,0.62); color: var(--text-on-accent); cursor: pointer; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    .corner-btn:active { transform: scale(0.92); }
    .corner-btn:disabled { opacity: 0.5; }
    /* ⋯ actions button, top-right of every cover — opens the same menu a
       long-press / right-click does. */
    .cover-menu-btn { position: absolute; top: 6px; right: 6px; width: 30px; height: 30px; border: none; border-radius: 8px;
      background: rgba(0,0,0,0.62); color: var(--text-on-accent); cursor: pointer; display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: 2; }
    .cover-menu-btn:active { transform: scale(0.92); }
    /* Second corner action (reclassify), bottom-left so it clears the download btn. */
    .move-btn { top: auto; bottom: 6px; font-size: 15px; }
    /* Read & listen, bottom-right. */
    .listen-btn { top: auto; bottom: 6px; left: auto; right: 6px; font-size: 15px; }
    .toast { position: fixed; left: 50%; transform: translateX(-50%); z-index: 400;
      bottom: calc(var(--bf-nav-h) + 16px + env(safe-area-inset-bottom));
      background: var(--bg-elevated); color: var(--text-primary); border: 1px solid var(--border-subtle);
      border-radius: 10px; padding: 10px 16px; font-size: 13px; max-width: 80%; text-align: center;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4); animation: pkFade 0.15s ease; }
    /* Badge sits top-left so the ⋯ actions button can own the top-right corner. */
    .book-type-badge { position: absolute; top: 6px; left: 6px; max-width: calc(100% - 44px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      padding: 2px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase;
      background: rgba(0,0,0,0.7); color: var(--text-on-accent); border-radius: 4px; }
    /* Icon-only corner mark (audiobook = headphones, on-device = download). */
    .book-type-badge.badge-icon { padding: 3px; display: inline-flex; align-items: center; justify-content: center; line-height: 0; }
    .book-type-badge.m4b { background: color-mix(in srgb, var(--accent) 90%, transparent); }
    .book-type-badge.format-epub { background: color-mix(in srgb, var(--success) 90%, transparent); }
    .book-type-badge.format-pdf { background: color-mix(in srgb, var(--error) 90%, transparent); }
    .book-type-badge.format-azw3, .book-type-badge.format-mobi { background: color-mix(in srgb, var(--warning) 90%, transparent); }
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
    .queue-job-status.status-processing { background: var(--accent); color: var(--text-on-accent); }
    .queue-job-status.status-complete { background: var(--success); color: var(--text-on-accent); }
    .queue-job-status.status-error { background: var(--error); color: var(--text-on-accent); }
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
    .bn-plus { width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: var(--text-on-accent);
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
       adds columns as the window widens, filling the full content width
       edge-to-edge (no max-width cap). */
    @media (min-width: 768px) { .books-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 20px; } }
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

  // Libraries menu order: "This device" (the on-device local library) first, then
  // a divider, then every server — including the web-origin served library, which
  // has no url but is a real server, not the device. Grouping on `local` (not on
  // the absence of a url) keeps the device as the sole anchor above the divider
  // and puts named servers below it with their pencil/X, just above "Add a server".
  readonly orderedServers = computed(() => {
    const s = this.cfg.servers();
    return [...s.filter((x) => x.local), ...s.filter((x) => !x.local)];
  });
  readonly deviceCount = computed(() => this.cfg.servers().filter((x) => x.local).length);
  private readonly offline = inject(OfflineStoreService);
  private readonly actions = inject(BookActionsService);
  private readonly router = inject(Router);

  readonly tab = signal<Tab>(this.readStoredTab());
  readonly sort = signal<Sort>((localStorage.getItem('bookshelf-sort') as Sort) || 'date');
  readonly search = signal('');
  readonly activeTag = signal<string>('all');
  // "Downloaded" filter (audiobooks tab): show only books cached for offline.
  readonly downloadedOnly = signal(false);
  // Narration filter (audiobooks tab): "Professional" shows only books with ≥1
  // audiobook variant flagged professionally read.
  readonly narration = signal<Narration>((localStorage.getItem('bookshelf-narration') as Narration) || 'all');
  readonly loading = signal(false);
  readonly refreshing = signal(false);
  readonly loadError = signal<string | null>(null);

  // Books as fetched, one entry per (server, book) — the same title on two
  // servers appears twice here, and locally-imported books ride along tagged with
  // originServerId === LOCAL_SERVER_ID. The shelf-facing `audiobooks` splits these
  // into the on-device and server sets; see onDeviceAudiobooks / serverAudiobooks.
  // Seeded from the local catalog cache so the shelf renders instantly on open;
  // the background reconcile (initialLoad, non-forced) then overwrites with the
  // fresh server list and lazily pulls only the covers/durations it's missing.
  private readonly rawAudiobooks = signal<Audiobook[]>(ShelfComponent.readCatalog<Audiobook>('bookshelf-cat-audio'));
  // Every card the shelf shows, on-device copies first then server copies. A
  // downloaded-and-server-enabled book appears in BOTH: its on-device copy (plays
  // the cache) and its server copy (`stream`, streams). Computeds so a download/
  // remove or a server toggle re-splits reactively — they depend on
  // offline.items(), so no re-fetch is needed to reflect either.
  readonly audiobooks = computed<Audiobook[]>(() => [
    ...this.onDeviceAudiobooks(),
    ...this.serverAudiobooks(),
  ]);
  readonly ebooks = signal<Ebook[]>([]);
  readonly covers = signal<Map<string, string>>(ShelfComponent.readStoredCovers());
  private readonly requestedCovers = new Set<string>();
  // Last-seen offline downloads, so the constructor effect can tell which ones were
  // just removed and refresh their (now-dead blob:) covers. See that effect.
  private downloadedSnapshot: { id: string; serverId: string; downloadPath: string }[] = [];

  // Server (libraries) menu: open state + per-server fetch status for the row
  // spinner / "offline" label.
  readonly serverMenuOpen = signal(false);
  readonly serverStatus = signal<Map<string, 'loading' | 'ok' | 'offline'>>(new Map());
  // Inline server rename (the pencil in the Libraries menu).
  readonly editingServer = signal<string | null>(null);
  readonly editServerLabel = signal('');

  /** Stable per-card key for the @for track and the cover cache. Keyed on the
   *  resolved origin + path. The on-device copy and the streaming mirror of a
   *  downloaded book share that origin+path, so the `stream` mirror carries a
   *  distinct prefix — otherwise the two cards would collide (one wouldn't render,
   *  and their covers would clash in the covers map). */
  akey(b: Audiobook): string {
    const base = `${b.originServerId ?? ''}::${b.downloadPath}`;
    return b.stream ? `stream::${base}` : base;
  }
  ekey(b: Ebook): string { return `${b.originServerId ?? ''}::${b.relativePath}`; }

  /** Cross-server identity of an audiobook: the output filename. downloadPath is
   *  absolute (differs between synced mirrors and across drive letters), but its
   *  basename is the m4b name — identical on every mirror, and identical to the
   *  path the offline cache stored — so this one key collapses the same book from
   *  two servers AND matches its offline copy. Two distinct books colliding here
   *  would need the same "Title. Author (Year).m4b", i.e. be the same book. */
  private audioIdentity(downloadPath: string): string {
    return (downloadPath.split(/[/\\]/).pop() || downloadPath).toLowerCase();
  }

  /** "On this device": every offline download (played from the on-device cache)
   *  plus every locally-imported book. Independent of which servers are enabled —
   *  a download stays here even with its origin server off, the one thing a
   *  download must never lose. Each entry is flagged `onDevice` so the section
   *  split, the "downloaded" badge, and the "downloaded only" filter key off the
   *  card's flavor rather than the shared basename identity. */
  private readonly onDeviceAudiobooks = computed<Audiobook[]>(() => {
    const out: Audiobook[] = [];
    const items = this.offline.items();
    // In-flight + queued downloads come first, so everything the user is fetching is
    // visible and cancelable in ONE place (each card carries its own ring). Skip any
    // that just landed in items (finished) to avoid a one-frame duplicate.
    const doneIds = new Set(items.map((i) => this.audioIdentity(i.downloadPath)));
    for (const b of this.offline.pendingDownloads()) {
      if (!doneIds.has(this.audioIdentity(b.downloadPath))) out.push({ ...b, onDevice: true });
    }
    // Existing downloads predate the stored `hasProfessional` flag — when the origin
    // server is reachable, enrich the on-device card from the live book so the gold
    // border shows without a re-download. (Fresh downloads already carry it.)
    const serverByIdentity = new Map<string, Audiobook>();
    for (const b of this.rawAudiobooks()) {
      const id = this.audioIdentity(b.downloadPath);
      if (!serverByIdentity.has(id)) serverByIdentity.set(id, b);
    }
    for (const item of items) {
      const card = this.offlineAsAudiobook(item);
      if (card.hasProfessional === undefined) {
        const server = serverByIdentity.get(this.audioIdentity(item.downloadPath));
        if (server?.hasProfessional !== undefined) card.hasProfessional = server.hasProfessional;
      }
      out.push({ ...card, onDevice: true });
    }
    for (const b of this.rawAudiobooks()) {
      if (b.originServerId === LOCAL_SERVER_ID) out.push({ ...b, onDevice: true });
    }
    return out;
  });

  /** "All audiobooks": every SERVER book, collapsed to ONE card per basename
   *  identity across mirrors (the first reachable server wins as representative,
   *  so playback/covers route to a live library). A book that is ALSO downloaded
   *  is flagged `stream` so tapping this card streams from the server instead of
   *  the cache — its on-device copy is shown separately in the on-device set.
   *  Local imports are excluded; they live in the on-device set only. */
  private readonly serverAudiobooks = computed<Audiobook[]>(() => {
    const byId = new Map<string, Audiobook>();
    for (const b of this.rawAudiobooks()) {
      if (b.originServerId === LOCAL_SERVER_ID) continue;
      const id = this.audioIdentity(b.downloadPath);
      if (!byId.has(id)) byId.set(id, b);
    }
    const downloaded = this.downloadedIds();
    const pending = this.pendingIds();
    // A downloaded OR currently-downloading book streams from its server card — its
    // on-device card owns the offline copy / the progress ring — so flag it stream
    // to avoid rendering the same book as a duplicate plain card.
    return [...byId].map(([id, b]) => (downloaded.has(id) || pending.has(id) ? { ...b, stream: true } : b));
  });

  /** Identity set of every queued/in-flight download, so a book that's mid-download
   *  is marked a stream mirror in the server list (its on-device pending card carries
   *  the ring) instead of showing twice. */
  private readonly pendingIds = computed(() => {
    const set = new Set<string>();
    for (const b of this.offline.pendingDownloads()) set.add(this.audioIdentity(b.downloadPath));
    return set;
  });

  /** A shelf card for an offline-only book (origin server off/unreachable). Keeps
   *  the real originServerId + downloadPath so resolveAudioSrc/getCover find the
   *  cached bytes; `offline` drives the "downloaded" badge. Delegates to the store
   *  so the shelf and the player build the same offline book object. */
  private offlineAsAudiobook(item: OfflineItem): Audiobook {
    return this.offline.itemAsAudiobook(item);
  }

  /** Identity set of every downloaded book, so a card can answer "am I downloaded?"
   *  in O(1) regardless of which server ended up its representative. */
  readonly downloadedIds = computed(() => {
    const set = new Set<string>();
    for (const i of this.offline.items()) set.add(this.audioIdentity(i.downloadPath));
    return set;
  });
  isDownloadedBook(book: Audiobook): boolean {
    const ids = this.downloadedIds();
    // A book is "downloaded" if ANY of its editions is on device — not just the
    // representative. Otherwise a downloaded non-representative version (e.g. the
    // card's representative is a different edition) shows no badge and its
    // "Remove download" is hidden, stranding it (see reconcileStaleDownloads).
    if (ids.has(this.audioIdentity(book.downloadPath))) return true;
    return (book.versions || []).some(v => !!v.downloadPath && ids.has(this.audioIdentity(v.downloadPath)));
  }
  /** True when THIS card is the on-device downloaded copy — as opposed to the
   *  streaming mirror of the same (downloaded) book, which shares its basename
   *  identity but must NOT wear the "downloaded" badge/border. Keys off the card's
   *  `stream` flavor so the badge follows the entry, not the identity. */
  isDownloadedCard(book: Audiobook): boolean {
    return !book.stream && this.isDownloadedBook(book);
  }
  readonly downloadedCount = computed(() => this.downloadedIds().size);

  // Circumference of the cover ring (r=16 in the 36×36 viewBox), so the fill's
  // stroke-dasharray/offset can be driven from a percent.
  readonly ringCirc = 2 * Math.PI * 16;

  /** Download-ring state for a card, or null when there's nothing to show — idle, or
   *  already fully downloaded (a finished book is fully lit with no overlay, marked
   *  by its "downloaded" border). The streaming mirror of a downloading book never
   *  wears the ring; its on-device pending card does. */
  dlOverlay(book: Audiobook): { state: 'downloading' | 'queued'; percent: number } | null {
    if (book.stream) return null;
    const state = this.actions.downloadStatus(book);
    if (!state) return null;
    const pr = this.actions.downloadProgress(book);
    const percent = pr && pr.total ? Math.min(100, Math.round((pr.received / pr.total) * 100)) : 0;
    return { state, percent };
  }

  /** stroke-dashoffset for a percent — 0% hides the fill, 100% completes the ring. */
  ringOffset(percent: number): number {
    return this.ringCirc * (1 - Math.max(0, Math.min(100, percent)) / 100);
  }

  /** The stop square at the center of a cover ring: cancel the download (abort it if
   *  streaming, drop it from the queue if waiting). Stops the tap from also opening
   *  the book. */
  onCoverDownloadTap(book: Audiobook, ev: Event): void {
    ev.stopPropagation();
    ev.preventDefault();
    this.actions.cancelDownload(book);
  }

  /** Collapse an ebook that came back from several enabled servers into one card.
   *  relativePath is relative to the library root, so it's identical across synced
   *  mirrors and across the same backend reached by two URLs. (Ebooks have no
   *  offline cache, so there's nothing to fold in.) */
  private dedupeEbooks(fromServers: Ebook[]): Ebook[] {
    const byId = new Map<string, Ebook>();
    for (const b of fromServers) {
      const id = b.relativePath.toLowerCase();
      if (!byId.has(id)) byId.set(id, b);
    }
    return [...byId.values()];
  }

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
      // Recency is keyed by basename identity (audioIdentity), not the absolute
      // downloadPath — so a book's last-played time survives a mirror swap where
      // its representative server (and thus its absolute path) changed. This is
      // the same key PlayerService writes with (PlayerService.recencyIdentity).
      const recency = (b: Audiobook): number => {
        let ms = b.dateAdded ? Date.parse(b.dateAdded) || 0 : 0;
        ms = Math.max(ms, played.get(this.audioIdentity(b.downloadPath)) ?? 0);
        for (const v of b.versions || []) ms = Math.max(ms, played.get(this.audioIdentity(v.downloadPath)) ?? 0);
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

  /** Distinct-book count of an audiobook card list. A downloaded-and-server-
   *  enabled book renders TWO cards (on-device + stream) but is ONE book, so the
   *  header/tag counts collapse by basename identity rather than counting cards. */
  private uniqueAudioCount(list: Audiobook[]): number {
    return new Set(list.map(b => this.audioIdentity(b.downloadPath))).size;
  }

  readonly totalForTab = computed(() => {
    const t = this.tab();
    return t === 'audiobooks' ? this.uniqueAudioCount(this.audiobooks()) : t === 'articles' ? this.sortedArticles().length : this.sortedEbooks().length;
  });

  readonly filteredAudiobooks = computed(() => {
    const q = this.search().trim();
    const tag = this.activeTag();
    const dl = this.downloadedOnly();
    const n = this.narration();
    return this.sortedAudiobooks().filter((b) => {
      if (dl && !this.isOnDevice(b)) return false;
      if (tag !== 'all' && !(b.tags || []).includes(tag)) return false;
      if (n === 'professional' && !b.hasProfessional) return false;
      if (!q) return true;
      return looseMatch(`${b.title} ${b.author || ''}`, q);
    });
  });

  /** This CARD's audio lives on this device — an offline download or a local
   *  import. Keys off the entry's `onDevice` flavor, NOT the shared basename
   *  identity, so the streaming mirror of a downloaded book (same identity, but
   *  built from the server) is correctly treated as a server card. Drives the
   *  "On this device" section + "downloaded only" filter. */
  isOnDevice(b: Audiobook): boolean {
    return !!b.onDevice;
  }

  /** On-device audiobooks (downloads + local imports) — the "On this device"
   *  section, shown first. */
  readonly downloadedAudiobooks = computed(() =>
    this.filteredAudiobooks().filter(b => this.isOnDevice(b)));
  /** The server cards — "All audiobooks". A downloaded-and-server-enabled book's
   *  streaming mirror lands here (it's not on-device). Empty when the "downloaded
   *  only" filter is on (that toggle simply hides this section). */
  readonly otherAudiobooks = computed(() =>
    this.downloadedOnly() ? [] : this.filteredAudiobooks().filter(b => !this.isOnDevice(b)));

  /** The server cards, grouped by the library each book streams from, so the
   *  section header names the source server ("Owen's Mac Studio") instead of a
   *  generic "All audiobooks". Preserves the shelf sort within each group; orders
   *  the groups active-server-first, then the rest alphabetically by label — both
   *  deterministic. A server whose entry can't be resolved falls back to a plain
   *  "Server" label so its books still surface. */
  readonly otherAudiobookGroups = computed<{ serverId: string; label: string; books: Audiobook[] }[]>(() => {
    const groups = new Map<string, Audiobook[]>();
    for (const b of this.otherAudiobooks()) {
      const sid = b.originServerId ?? '';
      (groups.get(sid) ?? groups.set(sid, []).get(sid)!).push(b);
    }
    const servers = this.cfg.servers();
    const activeId = this.cfg.activeServer()?.id;
    const label = (sid: string) => servers.find(s => s.id === sid)?.label || 'Server';
    return [...groups.entries()]
      .map(([serverId, books]) => ({ serverId, label: label(serverId), books }))
      .sort((a, b) => {
        if (a.serverId === activeId) return -1;
        if (b.serverId === activeId) return 1;
        return a.label.localeCompare(b.label);
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
    return t === 'audiobooks' ? this.uniqueAudioCount(this.filteredAudiobooks()) : t === 'articles' ? this.filteredArticles().length : this.filteredEbooks().length;
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
  // baseUrl, not the enabled set) does NOT trigger a shelf reload. Runs even
  // when no real server is paired: the on-device library ('local') is always in
  // the fan-out, so imported books load without a server.
  private lastServerKey: string | null = null;

  constructor() {
    // Cards restored from the cover cache shouldn't re-fetch on scroll — mark
    // them already-requested so only covers we're actually missing get pulled.
    for (const key of this.covers().keys()) this.requestedCovers.add(key);

    effect(() => {
      const key = this.cfg.enabledServers().map((s) => `${s.id}@${s.url}`).join(','); // tracked
      untracked(() => {
        if (this.lastServerKey !== null && this.lastServerKey !== key) {
          // Server set changed — clear the ebook list so a disabled server's books
          // drop on the next load. Covers are deliberately NOT wiped: they're keyed
          // per card and stay valid, and wiping them left already-visible cards
          // blank, because the lazy cover-load only re-fires when a card scrolls
          // into view (a persisted, still-visible card never re-requested).
          this.ebooks.set([]);
        }
        this.lastServerKey = key;
        void this.initialLoad();
      });
    });

    // Keep covers correct when an offline download is REMOVED — wherever the
    // removal happens (the shelf's own menu OR the player's download button).
    // While a book is downloaded, its cover is cached as an offline blob: URL
    // (keyed per card). Removing the download revokes that URL, but the cached
    // entry survives and requestedCovers blocks a re-fetch, so the card would
    // render a broken cover until a full app reload. Watching offline.items()
    // here — rather than patching each removal site — catches every path.
    effect(() => {
      const items = this.offline.items(); // tracked: fires whenever a download is added/removed
      untracked(() => {
        const nowIds = new Set(items.map((i) => i.id));
        const removed = this.downloadedSnapshot.filter((i) => !nowIds.has(i.id));
        this.downloadedSnapshot = items.map((i) => ({ id: i.id, serverId: i.serverId, downloadPath: i.downloadPath }));
        for (const it of removed) {
          // A self-contained data: cover (fetched from the server earlier and
          // persisted) OUTLIVES the download that was removed — only the offline
          // copy's now-revoked blob: URL is actually dead. Evicting a good data:
          // cover would blank the server card for nothing, and the re-fetch can't
          // recover it while the origin server is unreachable — which is exactly
          // when downloads get pruned. So keep data: covers; only drop the dead
          // blob: ones (and re-fetch them for any visible card).
          const durable = (key: string) => (this.covers().get(key) ?? '').startsWith('data:');
          // The exact card key this download rendered under while offline-only
          // (its origin server may have been disabled) — evict even if no card
          // is currently visible for it, so a later re-enable re-fetches cleanly.
          const offlineKey = `${it.serverId ?? ''}::${it.downloadPath}`;
          if (!durable(offlineKey)) this.evictCover(offlineKey);
          // And any card currently on the shelf for the same book — its live
          // server may now be its representative under a different path/key.
          const identity = this.audioIdentity(it.downloadPath);
          for (const b of this.audiobooks()) {
            if (this.audioIdentity(b.downloadPath) === identity) {
              const key = this.akey(b);
              if (durable(key)) continue; // durable cover survives the removal — leave it
              this.evictCover(key);
              this.loadAudioCover(b).catch(() => {}); // best-effort: a failed refetch must not throw
            }
          }
        }
      });
    });

    // Surface a failed download once — its partial bytes are already discarded and it
    // has left the queue (see OfflineStore.runDownload) — then clear it, so nothing
    // corrupt or half-done lingers on the shelf.
    effect(() => {
      const errs = this.offline.errors();
      if (errs.size === 0) return;
      untracked(() => {
        for (const [path, msg] of errs) {
          this.flash(msg);
          this.offline.clearError(path);
        }
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

  setNarration(n: Narration): void {
    this.narration.set(n);
    localStorage.setItem('bookshelf-narration', n);
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

  /** "Import a file" → copy an M4B/MP3/EPUB into the on-device library and
   *  surface it under "On this device". No server, no processing — putting books
   *  on a server permanently is BookForge desktop's job, not Bookshelf's. */
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

  /** Ingest a pasted URL into blocks, then hand off to the editor (blocks via
   *  router state). URLs default to the Article tag. (File import is on-device
   *  only — see onImportLocalFile — so this is the sheet's only server path.) */
  async startImport(src: { url: string }): Promise<void> {
    const token = this.readerSvc.token();
    if (!token) { this.importError.set('Sign in as a reader to import.'); return; }
    this.importBusy.set(true);
    this.importError.set(null);
    try {
      const res = await this.api.ingestReader(token, src);
      const blocks = (res.blocks || []).map((t, i) => ({ id: `b${i}`, text: t }));
      if (!blocks.length) { this.importError.set('No readable text found.'); return; }
      this.importOpen.set(false);
      await this.router.navigate(['/edit'], { state: { title: res.title || '', blocks, defaultTag: 'article', url: src.url } });
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
    // Token AND host must both be the book's ORIGIN server (the shelf's active
    // server may differ) — otherwise it's the origin token against the wrong host.
    const token = this.readerSvc.token(book.originServerId);
    if (!token) { this.deleteTarget.set(null); this.flash('Sign in to manage your library.'); return; }
    this.deleting.set(true);
    try {
      await this.api.deleteProject(token, book.projectId, book.originServerId);
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
    return { kind: 'audiobook', title: book.title, audiobook: book, isLocal: this.actions.isLocal(book) };
  }
  ebookMenu(book: Ebook): BookMenu {
    return { kind: 'ebook', title: book.title, ebook: book, isLocal: this.actions.isLocal(book) };
  }

  /** ⋯ button on a cover → open the same menu a long-press / right-click does. */
  openMenuFor(menu: BookMenu, event: Event): void {
    event.stopPropagation(); // don't also open the book
    this.clearLongPress();
    this.bookMenu.set(menu);
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

  /** "Download file" → a plain browser file save of the actual m4b/ebook to the
   *  user's OS. Nothing to do with the library or offline playback (that's the
   *  player's download button). Routed to the book's origin server. */
  doDownloadFile(bm: BookMenu): void {
    const href = bm.kind === 'audiobook' && bm.audiobook
      ? this.api.downloadUrl(bm.audiobook.downloadPath, bm.audiobook.outputFilename, bm.audiobook.originServerId)
      : bm.ebook
        ? this.api.ebookDownloadUrl(bm.ebook.relativePath, bm.ebook.originServerId)
        : '';
    if (!href) return;
    const name = bm.kind === 'audiobook'
      ? (bm.audiobook!.outputFilename || bm.audiobook!.downloadPath.split(/[/\\]/).pop() || 'audiobook.m4b')
      : (bm.ebook!.filename || 'book');
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    this.bookMenu.set(null);
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

  // ── Offline download actions (audiobook card menu) ─────────────────────────────
  /** True while this book's offline save is in flight (drives the menu label). */
  isMenuDownloading(bm: BookMenu): boolean {
    return !!bm.audiobook && this.actions.isDownloading(bm.audiobook);
  }
  /** True while this book is waiting its turn in the download queue. */
  isMenuQueued(bm: BookMenu): boolean {
    return !!bm.audiobook && this.actions.isQueued(bm.audiobook);
  }
  /** 0–100 for an in-flight download shown in the menu, or null. */
  menuDlPct(bm: BookMenu): number | null {
    if (!bm.audiobook) return null;
    const pr = this.actions.downloadProgress(bm.audiobook);
    if (!pr || !pr.total) return null;
    return Math.min(100, Math.round((pr.received / pr.total) * 100));
  }

  /** Start an offline save. Closes the menu immediately — the top strip and the
   *  card's badge/border show it working; a failure surfaces as a flash. When the
   *  book has more than one version, pops the version picker in DOWNLOAD mode first
   *  so the reader downloads the edition they want (not just the representative
   *  variant); a single-version book downloads straight away as before. */
  doDownloadOffline(bm: BookMenu): void {
    const b = bm.audiobook;
    if (!b) return;
    this.bookMenu.set(null);
    if (b.versions && b.versions.length > 1) {
      this.downloadPickerBook.set(b);
      return;
    }
    this.startDownload(b);
  }

  /** A reader chose a specific version to DOWNLOAD from the picker. Resolve that
   *  version onto the book (its downloadPath/size/descriptor/… ) so the download —
   *  and the resulting on-device card's label — is that exact edition. */
  chooseDownloadVersion(book: Audiobook, version: AudiobookVersion): void {
    this.closePicker();
    this.startDownload(this.resolveVersion(book, version));
  }

  /** Queue the offline save for a fully-resolved book. Fire-and-forget: progress
   *  shows on the cover ring, and any failure surfaces via the offline.errors()
   *  effect in the constructor. */
  private startDownload(b: Audiobook): void {
    this.actions.downloadAudiobook(b);
  }

  doCancelDownload(bm: BookMenu): void {
    if (bm.audiobook) this.actions.cancelDownload(bm.audiobook);
    this.bookMenu.set(null);
  }

  /** Remove a book's offline copy. Works whether or not its origin server is
   *  connected, so a downloaded book is always removable. */
  async doRemoveDownload(bm: BookMenu): Promise<void> {
    const b = bm.audiobook;
    if (!b) return;
    this.menuBusy.set(true);
    try {
      await this.actions.removeDownload(b);
      this.bookMenu.set(null);
      this.flash('Download removed.');
      // The cover refresh is handled centrally by the offline.items() effect in the
      // constructor, so it covers removal from the player's download button too.
    } catch (err) {
      this.flash(err instanceof Error ? err.message : 'Could not remove that download.');
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
    // Raw, per-server results; the shelf's `audiobooks` computed collapses dupes
    // across servers and folds in offline downloads.
    const fresh = perServer.flat();
    this.rawAudiobooks.set(fresh);
    if (servers.length > 0 && !anyOk) this.loadError.set('Could not reach the server. Tap ⟳ to retry.');
    this.loading.set(false);
    // Snapshot for the next cold start — but only when at least one server
    // actually answered (or there are no servers at all). A total failure must
    // not overwrite the offline cache with an empty list.
    if (servers.length === 0 || anyOk) this.persistAudiobooks();
    // Durations are computed server-side in the background (the list returns
    // before every M4B header is parsed) — poll briefly to fill in the lengths.
    this.scheduleDurationEnrichment();
    // Now that we have fresh server sizes, reconcile any downloaded copies that
    // went stale (e.g. a book re-embedded with a transcript after it was saved).
    if (anyOk) void this.reconcileStaleDownloads(fresh);
    // A cover/transcript that FAILED to load because its server was unreachable
    // (the classic "removed a download while offline" case) is cached as
    // "attempted" and, without this, only recovers on a full app restart. Now that
    // a server has answered, re-attempt the shelf covers still missing and heal the
    // open player's sidecars, so a pull-to-refresh actually brings them back.
    if (anyOk) {
      this.retryMissingCovers();
      void this.player.reloadSidecars();
    }
  }

  // Downloads already reconciled this session, keyed by downloadPath, so a repeat
  // shelf load (⟳ / tab switch) doesn't re-trigger a refresh that's already done.
  private readonly reconciled = new Set<string>();

  /** Compare each downloaded book against the fresh server listing and heal stale
   *  copies. The common case — the aligner re-embedded a transcript into an
   *  otherwise-unchanged m4b (`-c copy` audio) — only needs the tiny sidecars, so
   *  we refresh those and leave the on-device audio alone. A genuine audio change
   *  (different DURATION) can't be patched that way, so it takes a full re-download.
   *  Best-effort and fully background: failures are logged, never surfaced. */
  private async reconcileStaleDownloads(fresh: Audiobook[]): Promise<void> {
    const byIdentity = new Map<string, Audiobook>();
    for (const b of fresh) {
      if (b.downloadPath) byIdentity.set(this.audioIdentity(b.downloadPath), b);
      // Also index every VERSION, not just the representative. A book's default
      // downloadPath is only its representative variant (which can be an unrelated
      // edition — e.g. when primaryVariantId points at the EPUB, so versions[0]
      // wins). A downloaded NON-representative edition would otherwise never match
      // here and its stale cover/transcript could never be healed.
      for (const v of b.versions || []) {
        if (v.downloadPath) byIdentity.set(this.audioIdentity(v.downloadPath), this.resolveVersion(b, v));
      }
    }
    for (const item of this.offline.items()) {
      const server = byIdentity.get(this.audioIdentity(item.downloadPath));
      if (!server || !server.size) continue;                       // origin not in this listing
      if (server.size === this.offline.reconciledSize(item)) continue;  // up to date
      if (this.reconciled.has(item.downloadPath)) continue;        // already handled this session
      this.reconciled.add(item.downloadPath);
      const dp = item.downloadPath;
      const book = { ...server, originServerId: server.originServerId ?? '' };
      // Same duration (or unknown) ⇒ audio bytes unchanged ⇒ sidecar-only refresh.
      // A known, materially different duration ⇒ audio was re-rendered ⇒ full copy.
      const audioChanged = item.duration != null && server.duration != null
        && Math.abs(item.duration - server.duration) > 2;
      const heal = audioChanged ? this.offline.redownload(book) : this.offline.refreshSidecars(book).then(() => undefined);
      // Un-mark on failure so a later shelf load (⟳) can retry the heal.
      void heal.catch(err => {
        console.error('[Shelf] stale download heal failed', dp, err);
        this.reconciled.delete(dp);
      });
    }
  }

  // The server returns the book list immediately with durations only for files it
  // had cached, and parses the rest off the request path. After a load, poll the
  // now-warming cache a few times (with backoff) to fill in cards still missing a
  // length, then stop. Cheap: these are cache-served /api/books calls.
  private durationPollTimer?: ReturnType<typeof setTimeout>;
  private scheduleDurationEnrichment(triesLeft = 5, delay = 1200): void {
    clearTimeout(this.durationPollTimer);
    if (triesLeft <= 0 || !this.rawAudiobooks().some(b => b.duration == null)) return;
    this.durationPollTimer = setTimeout(async () => {
      const servers = this.cfg.enabledServers();
      const fresh = (await Promise.all(servers.map(async (s) => {
        try { return (await this.api.getBooks(false, s.id)).map(b => ({ ...b, originServerId: s.id })); }
        catch { return [] as Audiobook[]; }
      }))).flat();
      const byKey = new Map(fresh.map(b => [this.akey(b), b]));
      let changed = false;
      const merged = this.rawAudiobooks().map((b) => {
        if (b.duration != null) return b;
        const f = byKey.get(this.akey(b));
        if (f && f.duration != null) { changed = true; return { ...b, duration: f.duration, versions: f.versions ?? b.versions }; }
        return b;
      });
      if (changed) { this.rawAudiobooks.set(merged); this.persistAudiobooks(); }
      this.scheduleDurationEnrichment(triesLeft - 1, Math.min(Math.round(delay * 1.5), 5000));
    }, delay);
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
    this.ebooks.set(this.dedupeEbooks(perServer.flat()));
    if (servers.length > 0 && !anyOk) this.loadError.set('Could not reach the server. Tap ⟳ to retry.');
    this.loading.set(false);
  }

  // ── Pull-to-refresh (drag down from the top) ───────────────────────────────
  private readonly host = inject(ElementRef<HTMLElement>);
  readonly pullY = signal(0);
  readonly pulling = signal(false);
  private pullStartY = 0;
  private pullActive = false;
  private static readonly PULL_TRIGGER = 70; // px of pull needed to fire a refresh
  private static readonly PULL_MAX = 120;

  onPullStart(e: TouchEvent): void {
    // Only from the very top of the scroll view, one finger, not mid-refresh.
    if (e.touches.length !== 1 || this.refreshing() || this.host.nativeElement.scrollTop > 0) return;
    this.pullStartY = e.touches[0].clientY;
    this.pullActive = true;
  }

  onPullMove(e: TouchEvent): void {
    if (!this.pullActive) return;
    const dy = e.touches[0].clientY - this.pullStartY;
    if (dy <= 0) { this.pulling.set(false); this.pullY.set(0); return; } // pulling up = normal scroll
    this.pulling.set(true);
    e.preventDefault(); // take over from native overscroll/bounce
    // Resist: raw drag maps to a damped pull distance with a hard cap.
    this.pullY.set(Math.min(ShelfComponent.PULL_MAX, dy * 0.5));
  }

  onPullEnd(): void {
    if (!this.pullActive) return;
    this.pullActive = false;
    const fire = this.pulling() && this.pullY() >= ShelfComponent.PULL_TRIGGER;
    this.pulling.set(false);
    this.pullY.set(0);
    if (fire) void this.refresh();
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
    this.persistCoversDebounced();
  }

  /** Re-attempt covers that were requested earlier but never resolved — e.g. the
   *  origin server was unreachable when they were first tried (removing a download
   *  while offline evicts the card's cover, then the immediate re-fetch fails and
   *  stays gated in requestedCovers). loadAudioCover marks a key requested BEFORE
   *  the fetch and never clears it on failure, so such a cover otherwise recovers
   *  only on an app restart (which rebuilds requestedCovers from the persisted
   *  covers). Called after a refresh reaches a server, so pull-to-refresh brings
   *  those covers back. A key present in requestedCovers but absent from covers is
   *  precisely one that was tried and failed. */
  private retryMissingCovers(): void {
    const covers = this.covers();
    const stuck = (key: string) => this.requestedCovers.has(key) && !covers.has(key);
    for (const b of this.audiobooks()) {
      const key = this.akey(b);
      if (stuck(key)) { this.requestedCovers.delete(key); void this.loadAudioCover(b); }
    }
    for (const b of this.ebooks()) {
      const key = this.ekey(b);
      if (stuck(key)) { this.requestedCovers.delete(key); void this.loadEbookCover(b); }
    }
  }

  // ── Local catalog cache (instant shelf on open; reconcile in the background) ──
  private static readCatalog<T>(key: string): T[] {
    try { const raw = localStorage.getItem(key); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  /** Restore persisted covers — only data: URLs survive a relaunch (offline
   *  blob: URLs are minted per-session and would be dead links). */
  private static readStoredCovers(): Map<string, string> {
    try {
      const raw = localStorage.getItem('bookshelf-covers');
      if (!raw) return new Map();
      const entries = JSON.parse(raw) as [string, string][];
      return new Map(entries.filter(([, v]) => typeof v === 'string' && v.startsWith('data:')));
    } catch { return new Map(); }
  }
  private persistAudiobooks(): void {
    try { localStorage.setItem('bookshelf-cat-audio', JSON.stringify(this.rawAudiobooks())); }
    catch { /* quota — the shelf still works, just without an instant cold start */ }
  }
  private coverPersistTimer?: ReturnType<typeof setTimeout>;
  private persistCoversDebounced(): void {
    clearTimeout(this.coverPersistTimer);
    this.coverPersistTimer = setTimeout(() => {
      try {
        const entries = [...this.covers()].filter(([, v]) => v.startsWith('data:'));
        localStorage.setItem('bookshelf-covers', JSON.stringify(entries));
      } catch { try { localStorage.removeItem('bookshelf-covers'); } catch { /* ignore */ } }
    }, 1500);
  }

  /** Forget a card's cached cover so the next loadAudioCover/loadEbookCover
   *  re-fetches it. Needed when the cached URL goes stale — e.g. removing an
   *  offline download revokes the blob: URL the cover cache was pointing at. */
  private evictCover(key: string): void {
    this.requestedCovers.delete(key);
    if (this.covers().has(key)) {
      const next = new Map(this.covers());
      next.delete(key);
      this.covers.set(next);
    }
  }

  // ── Navigation / actions ──────────────────────────────────────────────────────
  readonly pickerBook = signal<Audiobook | null>(null);

  /** Point the single-server accessors (audio/position/analytics/reader token) at
   *  the server a book came from, so the existing one-book-at-a-time playback and
   *  reader code just works against the right library. A no-op with one server. */
  private useOriginServer(id?: string): void {
    // Never make the local pseudo-server active. The reader accessors (token/
    // reader/supported) key off activeId, so flipping to 'local' would blank the
    // real server's token — turning the profile chip into the guest glyph and
    // blocking import — even though a real server with a valid token is still
    // connected. Local/imported books need no server (they resolve from the
    // on-device offline cache), so leave the active server as whatever real
    // server was selected.
    if (id && id !== LOCAL_SERVER_ID) this.cfg.setActive(id);
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

  /** The version picker in DOWNLOAD mode: a book whose version the reader is
   *  choosing to DOWNLOAD (not play). Kept separate from `pickerBook` (play mode)
   *  so tapping a cover and choosing "Download for offline" never cross-wire —
   *  the two share the picker sheet UI but drive different actions. */
  readonly downloadPickerBook = signal<Audiobook | null>(null);

  closePicker(): void { this.pickerBook.set(null); this.pickerEbook.set(null); this.downloadPickerBook.set(null); }

  /** A reader chose a specific version from the picker. */
  choosePlayerVersion(book: Audiobook, version: AudiobookVersion): void {
    this.closePicker();
    this.playVersionOf(book, version);
  }

  /** A single-variant Audiobook resolved from one of a book's versions: spreads the
   *  version's downloadPath/size/duration/langPair/cover + its descriptor+variantId
   *  onto the book, so playback, download, and the on-device label all key off the
   *  chosen edition rather than the representative variant. */
  private resolveVersion(book: Audiobook, version: AudiobookVersion): Audiobook {
    return {
      ...book,
      type: version.type,
      langPair: version.langPair,
      downloadPath: version.downloadPath,
      coverPath: version.coverPath ?? book.coverPath,
      size: version.size,
      duration: version.duration,
      dateAdded: version.dateAdded ?? book.dateAdded,
      descriptor: version.descriptor,
      variantId: version.variantId,
    };
  }

  /** Navigate to the player for a specific version (or the book's default). Each
   *  version has its own downloadPath, so bookmarks/position are per-version. */
  private playVersionOf(book: Audiobook, version?: AudiobookVersion): void {
    const b: Audiobook = version ? this.resolveVersion(book, version) : book;
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
    // Token AND host must both be the book's ORIGIN server (see confirmDeleteArticle).
    const token = this.readerSvc.token(book.originServerId);
    if (!token) { this.flash('Sign in to organize your library.'); return; }
    // On the Articles tab → mark back as Ebook; anywhere else → mark as Article.
    const type: 'book' | 'article' = this.tab() === 'articles' ? 'book' : 'article';
    this.moving.set(book.projectId);
    try {
      await this.api.reclassifyEbook(token, book.projectId, type, book.originServerId);
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
  /** Checkbox: show/hide a library's books. Hiding is instant. Enabling is now
   *  optimistic — no up-front health probe (which stalled up to 8s on a sleepy
   *  server). The row spins while the shelf load fans out; loadAudiobooks()'s own
   *  per-server try/catch marks it "offline" if unreachable. Re-tapping retries. */
  async toggleServer(s: ServerEntry): Promise<void> {
    if (s.enabled) { this.cfg.toggleServer(s.id, false); return; }
    if (s.local) { this.setServerStatus(s.id, 'ok'); this.cfg.toggleServer(s.id, true); return; }
    this.setServerStatus(s.id, 'loading');
    this.cfg.toggleServer(s.id, true); // → effect fans the shelf; the load marks it ok/offline
  }

  /** ✕: forget a server entirely (not the same as hiding it). */
  removeServer(s: ServerEntry, event: Event): void {
    event.stopPropagation();
    this.cfg.removeServer(s.id);
  }

  /** Pencil: inline-rename a server (or the served library). */
  startRenameServer(s: ServerEntry): void {
    this.editServerLabel.set(s.label);
    this.editingServer.set(s.id);
  }
  saveServerLabel(s: ServerEntry): void {
    if (this.editingServer() !== s.id) return; // guard blur+enter double-fire
    this.editingServer.set(null);
    this.cfg.setServerLabel(s.id, this.editServerLabel());
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
    if (this.isDownloadedCard(book)) return 'downloaded';
    if (book.source === 'external') return 'imported';
    return book.type === 'bilingual' ? `bilingual ${book.langPair || ''}`.trim() : 'audiobook';
  }

  /**
   * Corner-mark icon for an audiobook card, or null when the badge should stay
   * text. On-device books (downloaded or locally imported) get the universal
   * download glyph; plain audiobooks get headphones. Bilingual stays as text so
   * its language pair is still shown.
   */
  badgeIcon(book: Audiobook): string | null {
    if (this.isDownloadedCard(book) || book.source === 'external') return 'download';
    if (book.type === 'bilingual') return null;
    return 'headphones';
  }

  sizeAndDuration(book: Audiobook): string {
    const dur = formatDuration(book.duration);
    const base = dur ? `${formatSize(book.size)} · ${dur}` : formatSize(book.size);
    // On-device cards carry the downloaded version's descriptor so two downloaded
    // versions of one book read distinctly. Server/multi-version cards have no
    // top-level descriptor (they carry versions[] instead), so they're unchanged.
    const desc = book.descriptor?.trim();
    return desc ? `${base} · ${desc}` : base;
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
