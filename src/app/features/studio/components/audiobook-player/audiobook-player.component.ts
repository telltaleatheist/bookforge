import {
  Component,
  input,
  output,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ElementRef,
  ViewChild,
  effect,
  inject
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ElectronService } from '../../../../core/services/electron.service';
import { VttParserService, VttCue } from '../../../../shared/services/vtt-parser.service';
import { PlayerChapterDrawerComponent } from '../../../../shared/player/player-chapter-drawer.component';
import { BookmarkService } from '../../../../shared/player/bookmark.service';
import type { PlayerChapter, TransportAction } from '../../../../shared/player/player.types';
import type { NamedBookmark } from '../../../../core/models/manifest.types';

export interface AudiobookData {
  id: string;
  title: string;
  author?: string;
  audiobookPath?: string;
  vttPath?: string;
  epubPath?: string;
  // Bilingual audio paths (separate from traditional)
  bilingualAudioPath?: string;
  bilingualVttPath?: string;
}

type AudioVersion = 'traditional' | 'bilingual';

/**
 * AudiobookPlayerComponent - VTT-synced audio player for mono-lingual audiobooks
 *
 * Features:
 * - Plays m4b/audio files with VTT text sync
 * - Chapter navigation via sidebar drawer
 * - Bookmark persistence (auto-saves position)
 * - Playback controls and speed adjustment
 */
@Component({
  selector: 'app-audiobook-player',
  standalone: true,
  imports: [
    CommonModule,
    PlayerChapterDrawerComponent
  ],
  template: `
    <div class="audiobook-player" [class.fullscreen]="fullscreen()">
      @if (!audiobook()) {
        <div class="no-selection">
          <div class="icon">🎧</div>
          <p>Select an audiobook to play</p>
        </div>
      } @else if (error()) {
        <div class="error-state">
          <div class="icon">⚠️</div>
          <p>{{ error() }}</p>
          <button class="btn-retry" (click)="loadAudioData()">Retry</button>
        </div>
      } @else if (isLoading()) {
        <div class="loading-state">
          <div class="spinner"></div>
          <p>Loading audiobook...</p>
        </div>
      } @else {
        <div class="player-content" [class.drawer-open]="chapterDrawerOpen()">
          <!-- Header bar: buttons + title + close -->
          <div class="player-header-bar">
            <div class="header-left">
              @if (chapters().length > 0) {
                <button
                  class="btn-header-icon"
                  [class.active]="chapterDrawerOpen()"
                  (click)="chapterDrawerOpen.set(!chapterDrawerOpen())"
                  title="Chapters"
                >
                  ☰
                </button>
              }
              <button
                class="btn-header-icon"
                [class.active]="bookmarkDrawerOpen()"
                (click)="bookmarkDrawerOpen.set(!bookmarkDrawerOpen())"
                title="Bookmarks"
              >
                🔖
              </button>
            </div>
            @if (displayedChapter()) {
              <span class="header-chapter">{{ displayedChapter()!.title }}</span>
            }
            <div class="header-center">
              <span class="header-title">{{ audiobook()!.title }}</span>
              @if (audiobook()!.author) {
                <span class="header-author">{{ audiobook()!.author }}</span>
              }
            </div>
            <div class="header-right">
              @if (hasBothVersions()) {
                <button
                  class="version-btn"
                  [class.active]="selectedVersion() === 'traditional'"
                  (click)="selectVersion('traditional')"
                >Trad</button>
                <button
                  class="version-btn"
                  [class.active]="selectedVersion() === 'bilingual'"
                  (click)="selectVersion('bilingual')"
                >Bilingual</button>
              }
              @if (fullscreen()) {
                <button class="btn-header-icon" (click)="closeFullscreen.emit()" title="Exit fullscreen">✕</button>
              } @else {
                <button class="btn-header-icon" (click)="requestFullscreen.emit()" title="Fullscreen">⛶</button>
              }
            </div>
          </div>
          <!-- Bookmark popup -->
          @if (bookmarkDrawerOpen()) {
            <div class="bookmark-popup">
              <div class="bookmark-popup-header">
                <span>Bookmarks</span>
                <button class="bookmark-popup-close" (click)="bookmarkDrawerOpen.set(false)">✕</button>
              </div>
              <div class="bookmark-popup-content">
                @if (savedBookmarks().length === 0) {
                  <p class="bookmark-empty">No bookmarks yet. Click + to save current position.</p>
                } @else {
                  @for (bm of savedBookmarks(); track bm.createdAt) {
                    <div class="bookmark-item">
                      <button class="bookmark-jump" (click)="jumpToBookmark(bm)">
                        <span class="bookmark-name">{{ bm.name }}</span>
                        <span class="bookmark-time">{{ formatTime(bm.position) }}</span>
                      </button>
                      <button class="bookmark-delete" (click)="deleteNamedBookmark(bm)" title="Delete">✕</button>
                    </div>
                  }
                }
              </div>
              <button class="bookmark-add" (click)="addNamedBookmark()">+ Save current position</button>
            </div>
          }

          <!-- Search bar -->
          <div class="search-bar">
            <input type="text" placeholder="Search text..."
              [value]="searchTerm()"
              (input)="searchTerm.set($any($event.target).value)" />
            @if (searchTerm()) {
              <button class="search-clear" (click)="searchTerm.set('')">&times;</button>
              <span class="search-count">{{ filteredCues().length }} / {{ vttCues().length }}</span>
            }
          </div>

          <!-- Scrollable text container -->
          <div class="text-container" #textContainer (scroll)="onTextScroll()">
            @for (cue of filteredCues(); track cue.index) {
              @if (chapterStartMap().get(cue.index); as chapterTitle) {
                <div class="chapter-header">{{ chapterTitle }}</div>
              }
              <div
                class="text-segment"
                [class.active]="cue.index === currentCueIndex()"
                [class.past]="cue.index < currentCueIndex()"
                [attr.data-index]="cue.index"
                (click)="seekToCue(cue.index)"
              >
                <p>{{ cue.text }}</p>
              </div>
            }
          </div>

          <!-- Progress bar (full width) -->
          <div class="progress-row">
            <div class="bar-progress" (click)="onBarProgressClick($event)">
              <div class="bar-progress-fill" [style.width.%]="progressPercent()"></div>
              <input type="range" class="bar-progress-slider" [min]="0" [max]="duration()" [value]="currentTime()" (input)="onBarSliderInput($event)" />
            </div>
            <span class="bar-percent">{{ Math.round(progressPercent()) }}%</span>
          </div>
          <!-- Time display (centered) -->
          <div class="time-row">
            <span class="bar-time">{{ formatTime(currentTime()) }} / {{ formatTime(duration()) }}</span>
            @if (bookmarkStatus()) {
              <span class="bookmark-status">{{ bookmarkStatus() }}</span>
            }
          </div>
          <!-- Transport + speed on same line -->
          <div class="controls-row">
            <div class="transport-group">
              <button class="bar-btn" (click)="onTransport('previous')" [disabled]="!canPrevious()" title="Previous">⏮</button>
              <button class="bar-btn bar-btn-play" (click)="onTransport(isPlaying() ? 'pause' : 'play')" [title]="isPlaying() ? 'Pause' : 'Play'">
                <span class="play-icon">{{ isPlaying() ? '⏸' : '▶' }}</span>
              </button>
              <button class="bar-btn" (click)="onTransport('next')" [disabled]="!canNext()" title="Next">⏭</button>
            </div>
            <div class="speed-group">
              <button class="bar-btn bar-btn-bookmark" (click)="addNamedBookmark()" title="Add bookmark">🔖</button>
              <input
                type="range"
                class="speed-slider"
                min="0.5"
                max="2"
                step="0.05"
                [value]="playbackSpeed()"
                (input)="onSpeedSliderInput($event)"
              />
              <span class="speed-value">{{ playbackSpeed().toFixed(2) }}x</span>
            </div>
          </div>

          <!-- Hidden audio element -->
          <audio
            #audioElement
            (timeupdate)="onTimeUpdate()"
            (loadedmetadata)="onLoadedMetadata()"
            (ended)="onEnded()"
            (play)="onPlay()"
            (pause)="onPause()"
            (error)="onAudioError($event)"
          ></audio>

          <!-- Chapter drawer -->
          <app-player-chapter-drawer
            [chapters]="chapters()"
            [currentChapter]="currentChapter()"
            [isOpen]="chapterDrawerOpen()"
            (chapterSelect)="onChapterSelect($event)"
            (close)="chapterDrawerOpen.set(false)"
          />
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      height: 100%;
    }

    .audiobook-player {
      height: 100%;
      display: flex;
      flex-direction: column;

      &.fullscreen {
        .player-content {
          padding-top: 44px;
        }
      }
    }

    .no-selection, .loading-state, .error-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);

      .icon {
        font-size: 48px;
        margin-bottom: 16px;
        opacity: 0.5;
      }

      p {
        font-size: 14px;
        margin: 0;
      }
    }

    .error-state p {
      color: var(--color-error);
      max-width: 300px;
      text-align: center;
    }

    .btn-retry {
      margin-top: 16px;
      padding: 8px 16px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-primary);
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 16px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .player-content {
      position: relative;
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 16px;
      min-height: 0;
      overflow: hidden;
    }

    .player-header-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 0 8px;
      flex-shrink: 0;
      -webkit-app-region: no-drag;
    }

    .header-left, .header-right {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }

    .header-chapter {
      font-size: 11px;
      font-weight: 500;
      color: var(--accent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      flex-shrink: 1;
      min-width: 0;
      padding: 3px 8px;
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      border-radius: 4px;
    }

    .header-center {
      flex: 1;
      min-width: 0;
      text-align: center;
      overflow: hidden;
    }

    .header-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-author {
      font-size: 11px;
      color: var(--text-secondary);
      margin-left: 8px;

      &::before {
        content: '— ';
      }
    }

    .btn-header-icon {
      -webkit-app-region: no-drag;
      width: 30px;
      height: 30px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
    }

    .version-btn {
      padding: 4px 10px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover:not(.active) {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
    }

    .bookmark-popup {
      position: absolute;
      top: 42px;
      left: 16px;
      z-index: 20;
      width: 240px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: column;
      max-height: 300px;
    }

    .bookmark-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-subtle);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .bookmark-popup-close {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .bookmark-popup-content {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }

    .bookmark-empty {
      padding: 12px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
      margin: 0;
    }

    .bookmark-item {
      display: flex;
      align-items: center;
      gap: 2px;
      border-radius: 6px;
      transition: background 0.15s;

      &:hover {
        background: var(--bg-hover);

        .bookmark-delete {
          opacity: 1;
        }
      }
    }

    .bookmark-jump {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-width: 0;
      padding: 8px 4px 8px 10px;
      border: none;
      border-radius: 6px 0 0 6px;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      text-align: left;
      font-size: 12px;
    }

    .bookmark-delete {
      width: 24px;
      height: 24px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted);
      font-size: 10px;
      cursor: pointer;
      flex-shrink: 0;
      opacity: 0;
      transition: opacity 0.15s, color 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 4px;

      &:hover {
        color: var(--color-error, #ef4444);
      }
    }

    .bookmark-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bookmark-time {
      color: var(--text-muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      margin-left: 8px;
      flex-shrink: 0;
    }

    .bookmark-add {
      padding: 8px 12px;
      border: none;
      border-top: 1px solid var(--border-subtle);
      background: transparent;
      color: var(--accent);
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      text-align: left;

      &:hover {
        background: var(--bg-hover);
      }
    }

    .search-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      flex-shrink: 0;

      input {
        flex: 1;
        padding: 6px 10px;
        border: 1px solid var(--border-input);
        border-radius: 6px;
        background: var(--bg-input);
        color: var(--text-primary);
        font-size: 13px;
        outline: none;
        transition: border-color 0.15s;

        &::placeholder {
          color: var(--text-muted);
        }

        &:focus {
          border-color: var(--accent);
        }
      }
    }

    .search-clear {
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 50%;
      background: var(--bg-muted);
      color: var(--text-secondary);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }

    .search-count {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      flex-shrink: 0;
    }

    .text-container {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 8px 0;
      scroll-behavior: smooth;
    }

    .chapter-header {
      padding: 16px 16px 8px;
      margin-top: 12px;
      font-size: 14px;
      font-weight: 700;
      color: var(--accent);
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 8px;

      &:first-child {
        margin-top: 0;
      }
    }

    .text-segment {
      padding: 8px 12px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: var(--bg-surface);
      border: 2px solid transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      opacity: 0.6;

      &:hover {
        background: var(--bg-hover);
      }

      &.past {
        opacity: 0.4;
      }

      &.active {
        opacity: 1;
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, var(--bg-surface));
      }

      p {
        margin: 0;
        font-size: 15px;
        line-height: 1.6;
        color: var(--text-primary);
      }
    }

    .progress-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 0 2px;
      flex-shrink: 0;
    }

    .bar-progress {
      position: relative;
      flex: 1;
      height: 6px;
      background: color-mix(in srgb, var(--accent) 20%, transparent);
      border-radius: 3px;
      cursor: pointer;
      overflow: hidden;
    }

    .bar-progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 3px;
      transition: width 0.1s;
      pointer-events: none;
    }

    .bar-progress-slider {
      position: absolute;
      top: -6px;
      left: 0;
      width: 100%;
      height: 18px;
      opacity: 0;
      cursor: pointer;
      margin: 0;
    }

    .bar-percent {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      flex-shrink: 0;
      font-variant-numeric: tabular-nums;
      min-width: 32px;
      text-align: right;
    }

    .time-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 2px 0;
      flex-shrink: 0;
    }

    .bar-time {
      font-size: 11px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }

    .bookmark-status {
      font-size: 10px;
      color: var(--accent);
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .controls-row {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px 0 6px;
      flex-shrink: 0;
    }

    .transport-group {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .bar-btn {
      width: 28px;
      height: 28px;
      border: none;
      border-radius: 50%;
      background: var(--bg-hover);
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s;

      &:hover:not(:disabled) {
        background: var(--bg-muted);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .bar-btn-play {
      width: 32px;
      height: 32px;
      background: var(--accent);
      color: white;
      font-size: 13px;

      .play-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        /* Nudge play arrow right to visually center it (triangle vs circle) */
        padding-left: 2px;
      }

      &:hover {
        filter: brightness(1.1);
      }
    }

    .bar-btn-bookmark {
      font-size: 14px;
    }

    .speed-group {
      position: absolute;
      right: 16px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .speed-slider {
      width: 80px;
      height: 20px;
      -webkit-appearance: none;
      appearance: none;
      background: transparent;
      cursor: pointer;

      &::-webkit-slider-runnable-track {
        height: 4px;
        background: color-mix(in srgb, var(--accent) 25%, transparent);
        border-radius: 2px;
      }

      &::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
        margin-top: -4px;
      }

      &::-moz-range-track {
        height: 4px;
        background: color-mix(in srgb, var(--accent) 25%, transparent);
        border-radius: 2px;
      }

      &::-moz-range-thumb {
        width: 12px;
        height: 12px;
        border: none;
        border-radius: 50%;
        background: var(--accent);
        cursor: pointer;
      }
    }

    .speed-value {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      min-width: 38px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `]
})
export class AudiobookPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('audioElement') audioElementRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('textContainer') textContainerRef!: ElementRef<HTMLDivElement>;

  private readonly electronService = inject(ElectronService);
  private readonly vttParser = inject(VttParserService);
  private readonly bookmarkService = inject(BookmarkService);

  // Inputs
  readonly audiobook = input<AudiobookData | null>(null);
  readonly fullscreen = input<boolean>(false);

  // Outputs
  readonly requestFullscreen = output<void>();
  readonly closeFullscreen = output<void>();

  // Loading/Error state
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // Bookmark status (shown briefly after save/restore)
  readonly bookmarkStatus = signal<string | null>(null);
  private bookmarkStatusTimer: ReturnType<typeof setTimeout> | null = null;

  // Audio state
  readonly isPlaying = signal<boolean>(false);
  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly playbackSpeed = signal<number>(1);

  // VTT cues
  readonly vttCues = signal<VttCue[]>([]);
  readonly currentCueIndex = signal<number>(0);

  // Search
  readonly searchTerm = signal<string>('');

  readonly filteredCues = computed(() => {
    const term = this.searchTerm().toLowerCase().trim();
    const cues = this.vttCues();
    if (!term) return cues;
    return cues.filter(c => c.text.toLowerCase().includes(term));
  });

  // Version selection (traditional vs bilingual)
  readonly selectedVersion = signal<AudioVersion>('traditional');

  // Chapter state
  readonly chapters = signal<PlayerChapter[]>([]);
  readonly chapterDrawerOpen = signal<boolean>(false);

  // Bookmark drawer state
  readonly bookmarkDrawerOpen = signal<boolean>(false);
  readonly savedBookmarks = signal<NamedBookmark[]>([]);

  // Scroll-based chapter tracking
  readonly scrollChapter = signal<PlayerChapter | null>(null);
  private scrollRafId: number | null = null;

  // Template access to Math
  readonly Math = Math;

  // Track last loaded book to avoid resetting version on same book
  private lastLoadedBookId: string | null = null;
  private lastBookDataHash: string | null = null;

  // Bookmark auto-save interval
  private bookmarkInterval: ReturnType<typeof setInterval> | null = null;

  // Computed: current chapter based on playback position
  readonly currentChapter = computed<PlayerChapter | null>(() => {
    const chaps = this.chapters();
    if (chaps.length === 0) return null;
    const time = this.currentTime();
    // Find last chapter whose startTime <= current time
    for (let i = chaps.length - 1; i >= 0; i--) {
      if (time >= chaps[i].startTime) return chaps[i];
    }
    return chaps[0];
  });

  // Displayed chapter: prefer scroll-detected chapter when paused, audio-based when playing
  readonly displayedChapter = computed<PlayerChapter | null>(() => {
    if (this.isPlaying()) return this.currentChapter();
    return this.scrollChapter() ?? this.currentChapter();
  });

  readonly canPreviousChapter = computed(() => {
    const cur = this.currentChapter();
    if (!cur) return false;
    return cur.order > 0;
  });

  readonly canNextChapter = computed(() => {
    const cur = this.currentChapter();
    const chaps = this.chapters();
    if (!cur || chaps.length === 0) return false;
    return cur.order < chaps.length - 1;
  });

  // When chapters exist, prev/next skips chapters; otherwise skips cues
  readonly canPrevious = computed(() => {
    if (this.chapters().length > 0) return this.canPreviousChapter();
    return this.currentCueIndex() > 0;
  });

  readonly canNext = computed(() => {
    if (this.chapters().length > 0) return this.canNextChapter();
    return this.currentCueIndex() < this.vttCues().length - 1;
  });

  // Map of cue index → chapter title for inline headers
  readonly chapterStartMap = computed<Map<number, string>>(() => {
    const map = new Map<number, string>();
    for (const ch of this.chapters()) {
      map.set(ch.startCueIndex, ch.title);
    }
    return map;
  });

  // Computed: check if both versions are available
  readonly hasBothVersions = computed(() => {
    const book = this.audiobook();
    if (!book) return false;
    const hasTraditional = !!book.audiobookPath && !!book.vttPath;
    const hasBilingual = !!book.bilingualAudioPath && !!book.bilingualVttPath;
    return hasTraditional && hasBilingual;
  });

  // Computed: get current audio path based on selected version
  readonly currentAudioPath = computed(() => {
    const book = this.audiobook();
    if (!book) return undefined;
    if (this.selectedVersion() === 'bilingual' && book.bilingualAudioPath) {
      return book.bilingualAudioPath;
    }
    return book.audiobookPath;
  });

  // Computed: get current VTT path based on selected version
  readonly currentVttPath = computed(() => {
    const book = this.audiobook();
    if (!book) return undefined;
    if (this.selectedVersion() === 'bilingual' && book.bilingualVttPath) {
      return book.bilingualVttPath;
    }
    return book.vttPath;
  });

  constructor() {
    // React to audiobook changes
    effect(() => {
      const book = this.audiobook();
      if (book) {
        const dataHash = JSON.stringify([
          book.audiobookPath,
          book.vttPath,
          book.bilingualAudioPath,
          book.bilingualVttPath
        ]);
        const isNewBook = this.lastLoadedBookId !== book.id;
        const dataChanged = this.lastBookDataHash !== dataHash;

        if (isNewBook) {
          this.lastLoadedBookId = book.id;
          const hasTraditional = !!book.audiobookPath && !!book.vttPath;
          const hasBilingual = !!book.bilingualAudioPath && !!book.bilingualVttPath;
          if (!hasTraditional && hasBilingual) {
            this.selectedVersion.set('bilingual');
          } else {
            this.selectedVersion.set('traditional');
          }
        }

        if (isNewBook || dataChanged) {
          this.lastBookDataHash = dataHash;
          this.loadAudioData();
        }
      } else {
        this.lastLoadedBookId = null;
        this.lastBookDataHash = null;
        this.reset();
      }
    });
  }

  selectVersion(version: AudioVersion): void {
    if (this.selectedVersion() !== version) {
      this.pause();
      this.selectedVersion.set(version);
      this.loadAudioData();
    }
  }

  ngOnInit(): void {
    // Initial load handled by effect
  }

  ngOnDestroy(): void {
    this.saveBookmarkImmediate();
    this.pause();
    this.stopBookmarkInterval();
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Transport events from shared controls
  // ─────────────────────────────────────────────────────────────────────────

  onTransport(action: TransportAction): void {
    switch (action) {
      case 'play': this.play(); break;
      case 'pause': this.pause(); break;
      case 'previous':
        if (this.chapters().length > 0) this.previousChapter();
        else this.previousCue();
        break;
      case 'next':
        if (this.chapters().length > 0) this.nextChapter();
        else this.nextCue();
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Audio Loading
  // ─────────────────────────────────────────────────────────────────────────

  private pendingAudioDataUrl: string | null = null;

  async loadAudioData(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    const audioPath = this.currentAudioPath();
    const vttPath = this.currentVttPath();
    const version = this.selectedVersion();

    this.isLoading.set(true);
    this.error.set(null);
    this.pendingAudioDataUrl = null;

    try {
      if (!audioPath) {
        throw new Error(`No ${version} audio file linked to this audiobook`);
      }
      if (!vttPath) {
        throw new Error(`No ${version} subtitles file available`);
      }

      // Read VTT content
      const vttContent = await this.electronService.readTextFile(vttPath);
      if (!vttContent) {
        throw new Error('Failed to read subtitles file');
      }

      // Parse VTT
      const cues = this.vttParser.parseVtt(vttContent);
      if (cues.length === 0) {
        throw new Error('No cues found in subtitles file');
      }
      this.vttCues.set(cues);

      // Load audio as data URL
      console.log(`[AudiobookPlayer] Loading ${version} audio file:`, audioPath);
      const audioResult = await this.electronService.readAudioFile(audioPath);
      if (!audioResult.success || !audioResult.dataUrl) {
        throw new Error(audioResult.error || 'Failed to load audio file');
      }
      console.log(`[AudiobookPlayer] Loaded ${version} audio: ${audioResult.size} bytes`);

      this.pendingAudioDataUrl = audioResult.dataUrl;
      this.currentTime.set(0);
      this.currentCueIndex.set(0);

      // Detect chapters (non-blocking)
      this.detectChapters(book, vttPath, cues);

      // Load named bookmarks
      this.loadNamedBookmarks(book.id);

    } catch (err) {
      console.error('Failed to load audiobook:', err);
      this.error.set((err as Error).message);
    } finally {
      this.isLoading.set(false);

      if (this.pendingAudioDataUrl) {
        setTimeout(() => {
          const audio = this.audioElementRef?.nativeElement;
          if (audio) {
            audio.src = this.pendingAudioDataUrl!;
            audio.load();
          }
        }, 50);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chapter Detection
  // ─────────────────────────────────────────────────────────────────────────

  private async detectChapters(book: AudiobookData, vttPath: string, cues: VttCue[]): Promise<void> {
    const epubPath = book.epubPath;
    if (!epubPath) {
      this.chapters.set([]);
      return;
    }

    try {
      const electron = (window as any).electron;
      if (!electron?.chapterRecovery?.detectChapters) {
        this.chapters.set([]);
        return;
      }

      const result = await electron.chapterRecovery.detectChapters(epubPath, vttPath);
      if (!result.success || !result.chapters) {
        this.chapters.set([]);
        return;
      }

      // Convert ChapterMatch[] to PlayerChapter[]
      const detected = result.chapters
        .filter((ch: any) => ch.detectedSeconds != null)
        .sort((a: any, b: any) => a.detectedSeconds - b.detectedSeconds);

      const audioDuration = this.duration() || cues[cues.length - 1]?.endTime || 0;

      const playerChapters: PlayerChapter[] = detected.map((ch: any, idx: number) => {
        const startTime = ch.detectedSeconds;
        const endTime = idx < detected.length - 1
          ? detected[idx + 1].detectedSeconds
          : audioDuration;

        // Find first cue at or after chapter start (approximate - may be off
        // because chapter detection uses a 5-cue sliding window)
        let startCueIndex = 0;
        for (let i = 0; i < cues.length; i++) {
          if (cues[i].startTime >= startTime) {
            startCueIndex = i;
            break;
          }
        }

        // Refine: scan forward up to 5 cues to find the one that actually
        // contains the chapter title/opening text (the sliding window in
        // chapter detection means detectedSeconds may point to the window
        // start rather than the actual chapter cue)
        const titleWords = ch.title.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w: string) => w.length > 3);
        const openingWords = ch.openingText ? ch.openingText.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w: string) => w.length > 3) : [];
        const searchWords = titleWords.length > 0 ? titleWords : openingWords;

        if (searchWords.length > 0) {
          let bestScore = 0;
          let bestIdx = startCueIndex;
          const scanEnd = Math.min(startCueIndex + 6, cues.length);
          for (let i = startCueIndex; i < scanEnd; i++) {
            const cueText = cues[i].text.toLowerCase();
            let score = 0;
            for (const word of searchWords) {
              if (cueText.includes(word)) score++;
            }
            if (score > bestScore) {
              bestScore = score;
              bestIdx = i;
            }
          }
          if (bestScore > 0) {
            startCueIndex = bestIdx;
          }
        }

        // Find last cue before next chapter
        let endCueIndex = cues.length - 1;
        for (let i = cues.length - 1; i >= 0; i--) {
          if (cues[i].startTime < endTime) {
            endCueIndex = i;
            break;
          }
        }

        return {
          id: ch.id,
          title: ch.title,
          order: idx,
          startTime: cues[startCueIndex]?.startTime ?? startTime,
          endTime,
          startCueIndex,
          endCueIndex
        };
      });

      this.chapters.set(playerChapters);
      console.log(`[AudiobookPlayer] Detected ${playerChapters.length} chapters`);
    } catch (err) {
      console.warn('[AudiobookPlayer] Chapter detection failed:', err);
      this.chapters.set([]);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scroll-based Chapter Detection
  // ─────────────────────────────────────────────────────────────────────────

  onTextScroll(): void {
    // Throttle via requestAnimationFrame to avoid excessive work
    if (this.scrollRafId) return;
    this.scrollRafId = requestAnimationFrame(() => {
      this.scrollRafId = null;
      this.detectScrollChapter();
    });
  }

  private detectScrollChapter(): void {
    const container = this.textContainerRef?.nativeElement;
    if (!container) return;

    const chaps = this.chapters();
    if (chaps.length === 0) return;

    // Find chapter headers in the DOM and determine which is the last one
    // that's scrolled past (above or at the top of the container viewport)
    const headers = container.querySelectorAll('.chapter-header');
    if (headers.length === 0) return;

    const containerTop = container.getBoundingClientRect().top;
    let lastTitle: string | null = null;

    for (let i = 0; i < headers.length; i++) {
      const rect = (headers[i] as HTMLElement).getBoundingClientRect();
      if (rect.top <= containerTop + 60) {
        lastTitle = (headers[i] as HTMLElement).textContent?.trim() ?? null;
      } else {
        break;
      }
    }

    // If no header is above the viewport top yet, use the first chapter
    if (!lastTitle) {
      this.scrollChapter.set(chaps[0]);
      return;
    }

    const chapter = chaps.find(c => c.title === lastTitle);
    if (chapter && chapter.id !== this.scrollChapter()?.id) {
      this.scrollChapter.set(chapter);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chapter Navigation
  // ─────────────────────────────────────────────────────────────────────────

  onChapterSelect(chapter: PlayerChapter): void {
    this.seekToTime(chapter.startTime);
    this.chapterDrawerOpen.set(false);
  }

  previousChapter(): void {
    const cur = this.currentChapter();
    const chaps = this.chapters();
    if (!cur || cur.order <= 0) return;
    const prev = chaps.find(c => c.order === cur.order - 1);
    if (prev) this.seekToTime(prev.startTime);
  }

  nextChapter(): void {
    const cur = this.currentChapter();
    const chaps = this.chapters();
    if (!cur) return;
    const next = chaps.find(c => c.order === cur.order + 1);
    if (next) this.seekToTime(next.startTime);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bookmarks
  // ─────────────────────────────────────────────────────────────────────────

  private getBookmarkKey(): string {
    return this.selectedVersion() === 'bilingual' ? 'bilingual' : 'audiobook';
  }

  private showBookmarkStatus(message: string): void {
    this.bookmarkStatus.set(message);
    if (this.bookmarkStatusTimer) clearTimeout(this.bookmarkStatusTimer);
    this.bookmarkStatusTimer = setTimeout(() => this.bookmarkStatus.set(null), 3000);
  }

  saveBookmarkManual(): void {
    this.saveBookmarkImmediate();
    this.showBookmarkStatus('Position saved');
  }

  private async restoreBookmark(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    const bookmark = await this.bookmarkService.loadBookmark(book.id, this.getBookmarkKey());
    if (!bookmark || bookmark.position <= 0) return;

    console.log(`[AudiobookPlayer] Restoring bookmark at ${bookmark.position}s`);
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.currentTime = bookmark.position;
      this.currentTime.set(bookmark.position);
      this.updateCurrentCue(bookmark.position);
    }
    if (bookmark.speed) {
      this.setSpeed(bookmark.speed);
    }
    this.showBookmarkStatus(`Resumed from ${this.formatTime(bookmark.position)}`);
  }

  private saveBookmarkDebounced(): void {
    const book = this.audiobook();
    if (!book) return;
    this.bookmarkService.saveBookmarkDebounced(book.id, this.getBookmarkKey(), {
      position: this.currentTime(),
      chapterId: this.currentChapter()?.id,
      cueIndex: this.currentCueIndex(),
      speed: this.playbackSpeed(),
      lastPlayedAt: new Date().toISOString()
    });
  }

  private saveBookmarkImmediate(): void {
    const book = this.audiobook();
    if (!book || this.currentTime() <= 0) return;
    this.bookmarkService.saveBookmarkImmediate(book.id, this.getBookmarkKey(), {
      position: this.currentTime(),
      chapterId: this.currentChapter()?.id,
      cueIndex: this.currentCueIndex(),
      speed: this.playbackSpeed(),
      lastPlayedAt: new Date().toISOString()
    });
  }

  private async loadNamedBookmarks(projectId: string): Promise<void> {
    const list = await this.bookmarkService.loadNamedBookmarks(projectId, this.getBookmarkKey());
    this.savedBookmarks.set(list);
  }

  private startBookmarkInterval(): void {
    this.stopBookmarkInterval();
    this.bookmarkInterval = setInterval(() => {
      if (this.isPlaying()) {
        this.saveBookmarkDebounced();
      }
    }, 10_000);
  }

  private stopBookmarkInterval(): void {
    if (this.bookmarkInterval) {
      clearInterval(this.bookmarkInterval);
      this.bookmarkInterval = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Playback Controls
  // ─────────────────────────────────────────────────────────────────────────

  reset(): void {
    this.pause();
    this.vttCues.set([]);
    this.currentCueIndex.set(0);
    this.currentTime.set(0);
    this.duration.set(0);
    this.chapters.set([]);
    this.chapterDrawerOpen.set(false);
    this.bookmarkDrawerOpen.set(false);
    this.savedBookmarks.set([]);
    this.searchTerm.set('');
    this.error.set(null);
  }

  play(): void {
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.play().catch(err => {
        console.error('Failed to play audio:', err);
        this.error.set('Failed to play audio');
      });
    }
  }

  pause(): void {
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.pause();
    }
  }

  previousCue(): void {
    const current = this.currentCueIndex();
    if (current > 0) {
      this.seekToCue(current - 1);
    }
  }

  nextCue(): void {
    const current = this.currentCueIndex();
    const total = this.vttCues().length;
    if (current < total - 1) {
      this.seekToCue(current + 1);
    }
  }

  seekToCue(cueIndex: number): void {
    const cues = this.vttCues();
    if (cueIndex < cues.length) {
      const cue = cues[cueIndex];
      this.seekToTime(cue.startTime);
    }
  }

  seekToTime(time: number): void {
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.currentTime = time;
      this.currentTime.set(time);
      this.updateCurrentCue(time);
    }
  }

  setSpeed(speed: number): void {
    this.playbackSpeed.set(Number(speed));
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.playbackRate = Number(speed);
    }
  }

  progressPercent(): number {
    const d = this.duration();
    if (d === 0) return 0;
    return (this.currentTime() / d) * 100;
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
      return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  onBarSliderInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.seekToTime(parseFloat(input.value));
  }

  onBarProgressClick(event: MouseEvent): void {
    const bar = event.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    this.seekToTime(percent * this.duration());
  }

  onSpeedSliderInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.setSpeed(parseFloat(input.value));
  }

  async addNamedBookmark(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    const chapter = this.currentChapter();
    const timeStr = this.formatTime(this.currentTime());
    const name = chapter ? `${chapter.title} — ${timeStr}` : timeStr;

    try {
      const list = await this.bookmarkService.addNamedBookmark(book.id, this.getBookmarkKey(), {
        name,
        position: this.currentTime(),
        chapterId: chapter?.id,
        createdAt: new Date().toISOString()
      });
      console.log('[AudiobookPlayer] Named bookmark saved, total:', list.length);
      this.savedBookmarks.set(list);
      this.showBookmarkStatus('Bookmark saved');
    } catch (err) {
      console.error('[AudiobookPlayer] Failed to save named bookmark:', err);
    }
  }

  async deleteNamedBookmark(bm: NamedBookmark): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    try {
      const list = await this.bookmarkService.removeNamedBookmark(book.id, this.getBookmarkKey(), bm.name);
      this.savedBookmarks.set(list);
    } catch (err) {
      console.error('[AudiobookPlayer] Failed to delete named bookmark:', err);
    }
  }

  jumpToBookmark(bm: NamedBookmark): void {
    this.seekToTime(bm.position);
    this.bookmarkDrawerOpen.set(false);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Audio Events
  // ─────────────────────────────────────────────────────────────────────────

  onTimeUpdate(): void {
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      const time = audio.currentTime;
      this.currentTime.set(time);
      this.updateCurrentCue(time);
    }
  }

  private updateCurrentCue(time: number): void {
    const cues = this.vttCues();
    if (cues.length === 0) return;

    const cueIndex = this.vttParser.findCueAtTime(cues, time);
    if (cueIndex >= 0 && cueIndex !== this.currentCueIndex()) {
      this.currentCueIndex.set(cueIndex);
      this.scrollToCurrentCue();
    }
  }

  private scrollToCurrentCue(): void {
    if (this.searchTerm()) return;

    const container = this.textContainerRef?.nativeElement;
    if (!container) return;

    const cueIndex = this.currentCueIndex();
    const cueElement = container.querySelector(`[data-index="${cueIndex}"]`) as HTMLElement;

    if (cueElement) {
      const containerRect = container.getBoundingClientRect();
      const elementRect = cueElement.getBoundingClientRect();
      const elementRelativeTop = elementRect.top - containerRect.top + container.scrollTop;
      const containerHeight = container.clientHeight;
      const elementHeight = cueElement.offsetHeight;
      const scrollTop = elementRelativeTop - (containerHeight / 2) + (elementHeight / 2);

      container.scrollTo({
        top: Math.max(0, scrollTop),
        behavior: 'smooth'
      });
    }
  }

  onLoadedMetadata(): void {
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      this.duration.set(audio.duration);
      audio.playbackRate = this.playbackSpeed();

      // Restore bookmark after metadata is loaded (we know the duration now)
      this.restoreBookmark();

      // Update chapter endTime for last chapter if duration wasn't known during detection
      const chaps = this.chapters();
      if (chaps.length > 0) {
        const last = chaps[chaps.length - 1];
        if (last.endTime === 0 || last.endTime < last.startTime) {
          const updated = [...chaps];
          updated[updated.length - 1] = { ...last, endTime: audio.duration };
          this.chapters.set(updated);
        }
      }
    }
  }

  onEnded(): void {
    this.isPlaying.set(false);
    this.saveBookmarkImmediate();
  }

  onPlay(): void {
    this.isPlaying.set(true);
    this.startBookmarkInterval();
  }

  onPause(): void {
    this.isPlaying.set(false);
    this.stopBookmarkInterval();
    this.saveBookmarkImmediate();
  }

  onAudioError(event: Event): void {
    const audio = event.target as HTMLAudioElement;
    const error = audio?.error;
    console.error('Audio error:', event);

    let errorMsg = 'Failed to load audio file.';
    if (error) {
      switch (error.code) {
        case MediaError.MEDIA_ERR_ABORTED:
          errorMsg = 'Audio loading aborted.';
          break;
        case MediaError.MEDIA_ERR_NETWORK:
          errorMsg = 'Network error loading audio.';
          break;
        case MediaError.MEDIA_ERR_DECODE:
          errorMsg = 'Audio format not supported or file corrupted.';
          break;
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
          errorMsg = 'Audio source not supported.';
          break;
      }
    }
    this.error.set(errorMsg);
  }
}
