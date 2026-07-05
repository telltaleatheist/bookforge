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
import { ElectronService } from '../../../../core/services/electron.service';
import { VttParserService, VttCue } from '../../../../shared/services/vtt-parser.service';
import { BookmarkService } from '../../../../shared/player/bookmark.service';
import { ReaderService } from '../../../../core/services/reader.service';
import { PlayerChromeComponent, ChromeCue, ChromeChapter, ChromeBookmark } from '../../../../shared/player/player-chrome.component';
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
  imports: [PlayerChromeComponent],
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
        <app-player-chrome
          [title]="audiobook()!.title"
          [author]="audiobook()!.author || ''"
          [coverSrc]="coverSrc()"
          [cues]="chromeCues()"
          [hasText]="vttCues().length > 0"
          [activeIndex]="currentCueIndex()"
          [chapterStartMap]="chapterStartMap()"
          [isPlaying]="isPlaying()"
          skipKind="time10"
          [canSkipBack]="currentTime() > 0.3"
          [scrubMin]="0"
          [scrubMax]="duration()"
          [scrubValue]="currentTime()"
          [heardPercent]="progressPercent()"
          [chapterNotches]="chapterNotches()"
          [leftLabel]="formatTime(currentTime())"
          [rightLabel]="formatTime(duration())"
          [centerLabel]="chapterCenterLabel()"
          [speed]="playbackSpeed()"
          [chapters]="chromeChapters()"
          [currentChapterId]="currentChapter()?.id ?? null"
          [canPrevChapter]="canPreviousChapter()"
          [canNextChapter]="canNextChapter()"
          [bookmarks]="chromeBookmarks()"
          [chapterRemaining]="chapterRemaining()"
          (togglePlay)="onTransport(isPlaying() ? 'pause' : 'play')"
          (skip)="onSkip($event)"
          (skipBig)="onSkipBig($event)"
          (seek)="seekToTime($event)"
          (pickCue)="seekToCue($event)"
          (prevChapter)="previousChapter()"
          (nextChapter)="nextChapter()"
          (pickChapter)="onPickChapterId($event)"
          (addBookmark)="addNamedBookmark()"
          (pickBookmark)="onPickBookmarkId($event)"
          (deleteBookmark)="onDeleteBookmarkId($event)"
          (speedChange)="setSpeed($event)"
          (sleepExpired)="pause()"
        >
          <!-- Source + profile pickers projected from the Listen window. -->
          <ng-content select="[listen-source]" ngProjectAs="[player-topbar-left]" />
          <ng-content select="[listen-profile]" ngProjectAs="[player-topbar-right]" />
          @if (hasBothVersions()) {
            <div player-topbar-left class="version-pills">
              <button class="version-btn" [class.active]="selectedVersion() === 'traditional'" (click)="selectVersion('traditional')">Trad</button>
              <button class="version-btn" [class.active]="selectedVersion() === 'bilingual'" (click)="selectVersion('bilingual')">Bilingual</button>
            </div>
          }
          @if (fullscreen()) {
            <button player-topbar-right class="btn-header-icon" (click)="closeFullscreen.emit()" title="Exit fullscreen">✕</button>
          } @else {
            <button player-topbar-right class="btn-header-icon" (click)="requestFullscreen.emit()" title="Fullscreen">⛶</button>
          }
          <div player-above-list class="search-bar">
            <input type="text" placeholder="Search text..."
              [value]="searchTerm()"
              (input)="searchTerm.set($any($event.target).value)" />
            @if (searchTerm()) {
              <button class="search-clear" (click)="searchTerm.set('')">&times;</button>
              <span class="search-count">{{ filteredCues().length }} / {{ vttCues().length }}</span>
            }
          </div>
        </app-player-chrome>

        <!-- Hidden audio element (kept in the wrapper so this component owns playback) -->
        <audio
          #audioElement
          (timeupdate)="onTimeUpdate()"
          (loadedmetadata)="onLoadedMetadata()"
          (ended)="onEnded()"
          (play)="onPlay()"
          (pause)="onPause()"
          (error)="onAudioError($event)"
        ></audio>
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

    /* Projected chrome (version pills, header icons, search bar) — the rest of
       the player UI now lives in PlayerChromeComponent. */
    .version-btn {
      padding: 4px 10px;
      border: 1px solid var(--border-default);
      border-radius: 12px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 11px;
      cursor: pointer;
      transition: all 0.15s;
    }
    .version-pills { display: flex; align-items: center; gap: 6px; }
    .version-btn:hover:not(.active) { background: var(--bg-hover); color: var(--text-primary); }
    .version-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }

    .btn-header-icon {
      width: 34px;
      height: 34px;
      border: none;
      border-radius: 8px;
      background: var(--bg-elevated);
      color: var(--text-secondary);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s;
    }
    .btn-header-icon:hover { background: var(--bg-hover); color: var(--text-primary); }

    .search-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
    }
    .search-bar input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border-input);
      border-radius: 8px;
      background: var(--bg-input);
      color: var(--text-primary);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }
    .search-bar input::placeholder { color: var(--text-muted); }
    .search-bar input:focus { border-color: var(--accent); }
    .search-clear {
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 50%;
      background: var(--bg-hover);
      color: var(--text-secondary);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .search-clear:hover { color: var(--text-primary); }
    .search-count { font-size: 11px; color: var(--text-muted); white-space: nowrap; flex-shrink: 0; }
  `]
})
export class AudiobookPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('audioElement') audioElementRef!: ElementRef<HTMLAudioElement>;

  private readonly electronService = inject(ElectronService);
  private readonly vttParser = inject(VttParserService);
  private readonly bookmarkService = inject(BookmarkService);
  private readonly reader = inject(ReaderService);

  // Inputs
  readonly audiobook = input<AudiobookData | null>(null);
  readonly fullscreen = input<boolean>(false);
  /** Optional cover art (data URL) — enables the Sentences/Cover toggle. */
  readonly coverSrc = input<string | null>(null);

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

  // Track last loaded book to avoid resetting version on same book
  private lastLoadedBookId: string | null = null;
  private lastBookDataHash: string | null = null;

  // Bookmark auto-save interval
  private bookmarkInterval: ReturnType<typeof setInterval> | null = null;

  // Per-reader listening analytics: accumulate wall-clock seconds actually played
  // (from timeupdate deltas, so pauses/seeks don't inflate it) and flush to the
  // in-process reader store in ~20s batches. Only credited when a real profile is
  // selected — "Guest" listening is not tracked.
  private listenAccum = 0;
  private lastTickTime: number | null = null;
  // Reader that the currently-accumulating seconds belong to — captured when the
  // batch starts so switching profile mid-batch credits the right reader.
  private accumReaderId: string | null = null;

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

  // ── Bindings for the shared PlayerChromeComponent ──────────────────────────
  readonly chromeCues = computed<ChromeCue[]>(() =>
    this.filteredCues().map((c) => ({ index: c.index, text: c.text })),
  );
  readonly chromeChapters = computed<ChromeChapter[]>(() =>
    this.chapters().map((ch) => ({ id: ch.id, title: ch.title, label: this.formatTime(ch.startTime) })),
  );
  readonly chromeBookmarks = computed<ChromeBookmark[]>(() =>
    this.savedBookmarks().map((bm) => ({ id: bm.createdAt, title: bm.name, sub: this.formatTime(bm.position) })),
  );
  /** Chapter-boundary tick positions (%) for the scrubber. */
  readonly chapterNotches = computed<number[]>(() => {
    const dur = this.duration();
    if (dur <= 0) return [];
    return this.chapters()
      .map((c) => (c.startTime / dur) * 100)
      .filter((pct) => pct > 0.5 && pct < 99.5);
  });
  /** "Chapter X of N" label under the scrubber. */
  readonly chapterCenterLabel = computed<string>(() => {
    const chaps = this.chapters();
    const cur = this.currentChapter();
    if (!cur || chaps.length === 0) return '';
    return `Chapter ${cur.order + 1} of ${chaps.length}`;
  });
  /** Seconds left in the current chapter (for the End-of-chapter sleep option). */
  readonly chapterRemaining = computed<number | null>(() => {
    const cur = this.currentChapter();
    if (!cur) return null;
    return Math.max(0, cur.endTime - this.currentTime());
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
    this.flushListening();
    this.saveBookmarkImmediate();
    this.pause();
    this.stopBookmarkInterval();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chrome event adapters
  // ─────────────────────────────────────────────────────────────────────────

  /** ±10s time skip from the chrome transport. */
  onSkip(direction: 'back' | 'forward'): void {
    const delta = direction === 'back' ? -10 : 10;
    this.seekToTime(Math.max(0, Math.min(this.duration(), this.currentTime() + delta)));
  }

  /** ±5min time skip (the outer transport buttons). */
  onSkipBig(direction: 'back' | 'forward'): void {
    const delta = direction === 'back' ? -300 : 300;
    this.seekToTime(Math.max(0, Math.min(this.duration(), this.currentTime() + delta)));
  }

  onPickChapterId(id: string): void {
    const chapter = this.chapters().find((c) => c.id === id);
    if (chapter) this.onChapterSelect(chapter);
  }

  onPickBookmarkId(id: string): void {
    const bm = this.savedBookmarks().find((b) => b.createdAt === id);
    if (bm) this.jumpToBookmark(bm);
  }

  onDeleteBookmarkId(id: string): void {
    const bm = this.savedBookmarks().find((b) => b.createdAt === id);
    if (bm) this.deleteNamedBookmark(bm);
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

      // Synced text is optional. An uploaded audiobook with no VTT plays
      // audio-only: cues stay empty, the chrome shows the cover, and chapter
      // navigation still comes from the file's embedded chapter markers (read
      // from the audio itself in detectChapters, independent of the VTT).
      let cues: VttCue[] = [];
      if (vttPath) {
        const vttContent = await this.electronService.readTextFile(vttPath);
        if (!vttContent) {
          throw new Error('Failed to read subtitles file');
        }
        cues = this.vttParser.parseVtt(vttContent);
        if (cues.length === 0) {
          throw new Error('No cues found in subtitles file');
        }
      }
      this.vttCues.set(cues);

      // Load audio as data URL
      console.log(`[AudiobookPlayer] Loading ${version} audio file:`, audioPath);
      const audioResult = await this.electronService.readAudioFile(audioPath);
      if (!audioResult.success || !audioResult.dataUrl) {
        throw new Error(audioResult.error || 'Failed to load audio file');
      }
      console.log(`[AudiobookPlayer] Loaded ${version} audio: ${audioResult.size} bytes`);

      // Credit any pending listening to the previous book before switching.
      this.flushListening();
      this.lastTickTime = null;

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

  /** Map ffprobe's embedded chapter markers to PlayerChapter[], resolving each
   *  chapter's cue-index span against the VTT for inline headers + scroll. */
  private embeddedToPlayerChapters(
    embedded: Array<{ title: string; start: number; end: number }>,
    cues: VttCue[],
  ): PlayerChapter[] {
    return embedded.map((ch, idx) => {
      let startCueIndex = 0;
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].startTime >= ch.start) { startCueIndex = i; break; }
      }
      let endCueIndex = cues.length - 1;
      for (let i = cues.length - 1; i >= 0; i--) {
        if (cues[i].startTime < ch.end) { endCueIndex = i; break; }
      }
      return {
        id: `embch${idx}`,
        title: ch.title,
        order: idx,
        startTime: ch.start,
        endTime: ch.end,
        startCueIndex,
        endCueIndex,
      };
    });
  }

  private async detectChapters(book: AudiobookData, vttPath: string | undefined, cues: VttCue[]): Promise<void> {
    // Prefer the chapter markers embedded in the audio file — the same authoritative,
    // curated source the bookshelf web player reads via ffprobe. Only fall back to
    // EPUB-based detection when the file has NO embedded chapters (that fuzzy recovery
    // over-produces — e.g. ~500 chapters for an EPUB split into many small sections).
    const audioPath = this.currentAudioPath();
    const cr = (window as any).electron?.chapterRecovery;
    console.log('[AudiobookPlayer] chapter source check — audioPath:', audioPath, '| probeChapters available:', !!cr?.probeChapters);
    if (audioPath && cr?.probeChapters) {
      try {
        const embedded = await cr.probeChapters(audioPath);
        console.log('[AudiobookPlayer] probeChapters returned', Array.isArray(embedded) ? embedded.length : embedded, 'embedded chapters:', embedded);
        if (Array.isArray(embedded) && embedded.length > 0) {
          this.chapters.set(this.embeddedToPlayerChapters(embedded, cues));
          console.log(`[AudiobookPlayer] Using ${embedded.length} embedded chapters`);
          return;
        }
        console.warn('[AudiobookPlayer] No embedded chapters returned — falling back to EPUB detection');
      } catch (err) {
        console.warn('[AudiobookPlayer] Embedded chapter probe threw (handler missing? restart the app) — falling back:', err);
      }
    }

    // EPUB-based recovery needs the VTT to map detected chapter text onto audio
    // time. With no synced text there's nothing to align against, so an audio-only
    // audiobook with no embedded chapters simply has no chapter nav.
    const epubPath = book.epubPath;
    if (!epubPath || !vttPath) {
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

  async addNamedBookmark(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    const chapter = this.currentChapter();
    const position = this.currentTime();

    // Dedup: if a bookmark already exists at this exact spot (within 1s), don't
    // stack another. This covers the close/reopen case where auto-bookmarks would
    // otherwise pile up at the same unchanged position every session.
    if (this.savedBookmarks().some((b) => Math.abs(b.position - position) < 1)) {
      this.showBookmarkStatus('Already bookmarked here');
      return;
    }

    const timeStr = this.formatTime(position);
    const name = chapter ? `${chapter.title} — ${timeStr}` : timeStr;
    const createdAt = new Date().toISOString();

    try {
      const list = await this.bookmarkService.addNamedBookmark(book.id, this.getBookmarkKey(), {
        name,
        position,
        chapterId: chapter?.id,
        createdAt,
      });
      console.log('[AudiobookPlayer] Named bookmark saved, total:', list.length);
      this.savedBookmarks.set(list);
      this.mirrorBookmark('add', { id: createdAt, name, position, chapterId: chapter?.id, createdAt });
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
      this.mirrorBookmark('del', { id: bm.createdAt, name: bm.name, position: bm.position });
    } catch (err) {
      console.error('[AudiobookPlayer] Failed to delete named bookmark:', err);
    }
  }

  /** Mirror a bookmark add/remove to the selected reader's server store so it
   *  propagates + stays in sync across devices. No-op for Guest. */
  private mirrorBookmark(op: 'add' | 'del', bm: Record<string, unknown> & { id: string }): void {
    const readerId = this.reader.activeId();
    const bookPath = this.currentAudioPath();
    if (!readerId || !bookPath) return;
    void (window as any).electron?.reader?.saveBookmark({ readerId, bookPath, op, bookmark: bm });
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
      this.accumulateListening(time);
      this.currentTime.set(time);
      this.updateCurrentCue(time);
    }
  }

  // ── Per-reader listening analytics ───────────────────────────────────────────
  /** Credit forward playback progress (ignoring pauses, seeks, and rate) toward
   *  the selected reader's listening time; flush in ~20s batches. */
  private accumulateListening(time: number): void {
    if (!this.isPlaying()) { this.lastTickTime = time; return; }
    if (this.lastTickTime !== null) {
      const delta = time - this.lastTickTime;
      // Only count small forward steps (normal playback ticks ~0.25s). A backward
      // step or a big jump is a seek, not listening.
      if (delta > 0 && delta < 5) {
        // A profile switch mid-batch: credit what's accumulated to the old reader
        // first, then start a fresh batch for the new one.
        if (this.listenAccum > 0 && this.accumReaderId !== this.reader.activeId()) {
          this.flushListening();
        }
        if (this.listenAccum === 0) this.accumReaderId = this.reader.activeId();
        this.listenAccum += delta;
      }
    }
    this.lastTickTime = time;
    if (this.listenAccum >= 20) this.flushListening();
  }

  /** Send accumulated listening seconds to the reader that earned them. */
  private flushListening(): void {
    const seconds = this.listenAccum;
    const readerId = this.accumReaderId;
    this.listenAccum = 0;
    const book = this.audiobook();
    const bookPath = this.currentAudioPath();
    if (seconds <= 0 || !readerId || !book || !bookPath) return;
    void (window as any).electron?.reader?.recordListening({
      readerId,
      bookPath,
      title: book.title,
      author: book.author || '',
      seconds,
    });
  }

  private updateCurrentCue(time: number): void {
    const cues = this.vttCues();
    if (cues.length === 0) return;

    // The chrome component owns follow-scroll (it watches activeIndex), so this
    // just keeps the highlighted cue in sync with playback.
    const cueIndex = this.vttParser.findCueAtTime(cues, time);
    if (cueIndex >= 0 && cueIndex !== this.currentCueIndex()) {
      this.currentCueIndex.set(cueIndex);
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
    this.flushListening();
    this.lastTickTime = null;
    this.saveBookmarkImmediate();
  }

  onPlay(): void {
    this.isPlaying.set(true);
    this.lastTickTime = this.currentTime();
    this.startBookmarkInterval();
  }

  onPause(): void {
    this.isPlaying.set(false);
    this.flushListening();
    this.lastTickTime = null;
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
