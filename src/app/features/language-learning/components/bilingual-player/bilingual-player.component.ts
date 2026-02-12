import {
  Component,
  input,
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
import { ManifestService } from '../../../../core/services/manifest.service';
import { VttParserService, VttCue } from '../../../../shared/services/vtt-parser.service';
import { PlayerControlsComponent } from '../../../../shared/player/player-controls.component';
import { PlayerProgressComponent } from '../../../../shared/player/player-progress.component';
import { PlayerChapterDrawerComponent } from '../../../../shared/player/player-chapter-drawer.component';
import { BookmarkService } from '../../../../shared/player/bookmark.service';
import type { PlayerChapter, TransportAction } from '../../../../shared/player/player.types';

interface SentencePair {
  index: number;
  source: string;
  target: string;
  sourceTimestamp?: number;
  targetTimestamp?: number;
}

interface AudiobookData {
  id: string;
  title: string;
  sourceLang?: string;
  targetLang?: string;
  audiobookPath?: string;
  path?: string;
  epubPath?: string;
  vttPath?: string;
  createdAt?: string;
  sentencePairs?: SentencePair[];
}

@Component({
  selector: 'app-bilingual-player',
  standalone: true,
  imports: [
    CommonModule,
    PlayerControlsComponent,
    PlayerProgressComponent,
    PlayerChapterDrawerComponent
  ],
  template: `
    <div class="bilingual-player">
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
        <div class="player-content">
          @if (chapters().length > 0) {
            <button
              class="btn-chapters"
              [class.active]="chapterDrawerOpen()"
              (click)="chapterDrawerOpen.set(!chapterDrawerOpen())"
              title="Chapters"
            >
              ☰
            </button>
          }
          <!-- Title -->
          <div class="player-header">
            <h2>{{ audiobook()!.title }}</h2>
            @if (audiobook()!.sourceLang && audiobook()!.targetLang) {
              <div class="lang-info">
                <span class="lang">{{ getLangName(audiobook()!.sourceLang!) }}</span>
                <span class="arrow">→</span>
                <span class="lang">{{ getLangName(audiobook()!.targetLang!) }}</span>
              </div>
            }
            @if (currentChapter()) {
              <p class="current-chapter">{{ currentChapter()!.title }}</p>
            }
          </div>

          <!-- Scrollable sentences container -->
          <div class="sentences-container" #sentencesContainer>
            @for (pair of sentencePairs(); track pair.index) {
              @if (chapterStartPairMap().get(pair.index); as chapterTitle) {
                <div class="chapter-header">{{ chapterTitle }}</div>
              }
              <div
                class="sentence-pair"
                [class.active]="pair.index === currentPairIndex()"
                [class.past]="pair.index < currentPairIndex()"
                [attr.data-index]="pair.index"
                (click)="seekToPair(pair.index)"
              >
                <div class="sentence source" [class.speaking]="pair.index === currentPairIndex() && isSourceSpeaking()">
                  <span class="lang-badge">{{ getShortLangName(audiobook()!.sourceLang || 'en') }}</span>
                  <p>{{ pair.source }}</p>
                </div>
                <div class="sentence target" [class.speaking]="pair.index === currentPairIndex() && !isSourceSpeaking()">
                  <span class="lang-badge">{{ getShortLangName(audiobook()!.targetLang || 'de') }}</span>
                  <p>{{ pair.target }}</p>
                </div>
              </div>
            }
          </div>

          <!-- Sentence counter -->
          <div class="sentence-progress">
            <span>Sentence {{ currentPairIndex() + 1 }} of {{ sentencePairs().length }}</span>
          </div>

          <!-- Transport controls -->
          <app-player-controls
            [isPlaying]="isPlaying()"
            [canPrevious]="canPrevious()"
            [canNext]="canNext()"
            (transport)="onTransport($event)"
          />

          <!-- Progress bar -->
          <app-player-progress
            [currentTime]="currentTime()"
            [duration]="duration()"
            (seek)="seekToTime($event)"
          />

          <!-- Speed controls - separate sliders for each language -->
          <div class="speed-controls">
            <div class="speed-control">
              <label>{{ getShortLangName(audiobook()!.sourceLang || 'en') }} Speed</label>
              <div class="slider-container">
                <input
                  type="range"
                  class="speed-slider"
                  min="0.5"
                  max="2"
                  step="0.05"
                  [value]="sourceSpeed()"
                  (input)="setSourceSpeed($event)"
                />
                <span class="speed-value">{{ sourceSpeed().toFixed(2) }}x</span>
              </div>
            </div>
            <div class="speed-control">
              <label>{{ getShortLangName(audiobook()!.targetLang || 'de') }} Speed</label>
              <div class="slider-container">
                <input
                  type="range"
                  class="speed-slider"
                  min="0.5"
                  max="2"
                  step="0.05"
                  [value]="targetSpeed()"
                  (input)="setTargetSpeed($event)"
                />
                <span class="speed-value">{{ targetSpeed().toFixed(2) }}x</span>
              </div>
            </div>
          </div>

          <!-- Hidden audio element -->
          <audio
            #audioElement
            [src]="audioPath()"
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
    .bilingual-player {
      height: 100%;
      display: flex;
      flex-direction: column;
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
      border-top-color: var(--color-primary);
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
      padding: 24px;
      min-height: 0;
      overflow: hidden;
    }

    .player-header {
      text-align: center;
      margin-bottom: 20px;
      flex-shrink: 0;

      h2 {
        margin: 0 0 8px;
        font-size: 18px;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .lang-info {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        font-size: 13px;
        color: var(--text-secondary);
      }

      .arrow {
        color: var(--text-muted);
      }

      .current-chapter {
        margin: 8px 0 0;
        font-size: 12px;
        color: var(--color-primary);
        font-weight: 500;
      }
    }

    .btn-chapters {
      position: absolute;
      top: 24px;
      right: 24px;
      z-index: 5;
      width: 32px;
      height: 32px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface);
      color: var(--text-secondary);
      font-size: 16px;
      cursor: pointer;
      transition: all 0.15s;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: white;
      }
    }

    .sentences-container {
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
      color: var(--color-primary);
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 8px;

      &:first-child {
        margin-top: 0;
      }
    }

    .sentence-pair {
      padding: 16px;
      margin-bottom: 12px;
      border-radius: 12px;
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
        border-color: var(--color-primary);
        background: color-mix(in srgb, var(--color-primary) 8%, var(--bg-surface));
      }
    }

    .sentence {
      display: flex;
      gap: 12px;
      padding: 8px 0;
      transition: all 0.2s ease;

      &.speaking {
        .lang-badge {
          background: var(--color-primary);
          color: white;
        }

        p {
          color: var(--text-primary);
          font-weight: 500;
        }
      }

      &.target {
        border-top: 1px solid var(--border-subtle);
        margin-top: 8px;
        padding-top: 12px;
      }
    }

    .lang-badge {
      flex-shrink: 0;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      background: var(--bg-muted);
      color: var(--text-secondary);
      height: fit-content;
      transition: all 0.2s ease;
    }

    .sentence p {
      margin: 0;
      font-size: 15px;
      line-height: 1.5;
      color: var(--text-secondary);
    }

    .sentence.target p {
      font-style: italic;
    }

    .sentence-progress {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      padding: 12px 0;
      flex-shrink: 0;
    }

    .speed-controls {
      display: flex;
      align-items: stretch;
      justify-content: center;
      gap: 32px;
      margin-top: 16px;
      flex-shrink: 0;
    }

    .speed-control {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: 140px;

      label {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        font-weight: 600;
        letter-spacing: 0.5px;
      }

      .slider-container {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .speed-slider {
        flex: 1;
        height: 20px;
        -webkit-appearance: none;
        appearance: none;
        background: transparent;
        cursor: pointer;

        &::-webkit-slider-runnable-track {
          height: 4px;
          background: var(--bg-muted, #444);
          border-radius: 2px;
        }

        &::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--color-primary, #06b6d4);
          cursor: pointer;
          margin-top: -5px;
          transition: transform 0.1s;

          &:hover {
            transform: scale(1.2);
          }
        }

        &::-moz-range-track {
          height: 4px;
          background: var(--bg-muted, #444);
          border-radius: 2px;
        }

        &::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border: none;
          border-radius: 50%;
          background: var(--color-primary, #06b6d4);
          cursor: pointer;
        }
      }

      .speed-value {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary);
        min-width: 42px;
        text-align: right;
        font-variant-numeric: tabular-nums;
      }
    }
  `]
})
export class BilingualPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('audioElement') audioElementRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('sentencesContainer') sentencesContainerRef!: ElementRef<HTMLDivElement>;

  private readonly electronService = inject(ElectronService);
  private readonly manifestService = inject(ManifestService);
  private readonly vttParser = inject(VttParserService);
  private readonly bookmarkService = inject(BookmarkService);

  // Inputs
  readonly audiobook = input<AudiobookData | null>(null);

  // Loading/Error state
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // Audio state
  readonly isPlaying = signal<boolean>(false);
  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly sourceSpeed = signal<number>(1);
  readonly targetSpeed = signal<number>(1);

  // Sentence tracking
  readonly sentencePairs = signal<SentencePair[]>([]);
  readonly vttCues = signal<VttCue[]>([]);
  readonly currentPairIndex = signal<number>(0);
  readonly isSourceSpeaking = signal<boolean>(true);

  // Audio path
  readonly audioPath = signal<string>('');

  // Chapter state
  readonly chapters = signal<PlayerChapter[]>([]);
  readonly chapterDrawerOpen = signal<boolean>(false);

  // Bookmark auto-save interval
  private bookmarkInterval: ReturnType<typeof setInterval> | null = null;

  // Computed: current chapter
  readonly currentChapter = computed<PlayerChapter | null>(() => {
    const chaps = this.chapters();
    if (chaps.length === 0) return null;
    const time = this.currentTime();
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

  // When chapters exist, prev/next skips chapters; otherwise skips sentences
  readonly canPrevious = computed(() => {
    if (this.chapters().length > 0) return this.canPreviousChapter();
    return this.currentPairIndex() > 0;
  });

  readonly canNext = computed(() => {
    if (this.chapters().length > 0) return this.canNextChapter();
    return this.currentPairIndex() < this.sentencePairs().length - 1;
  });

  // Map of pair index → chapter title for inline headers
  readonly chapterStartPairMap = computed<Map<number, string>>(() => {
    const map = new Map<number, string>();
    for (const ch of this.chapters()) {
      // Each pair = 2 cues, so pair index = startCueIndex / 2
      const pairIndex = Math.floor(ch.startCueIndex / 2);
      map.set(pairIndex, ch.title);
    }
    return map;
  });

  // Language name mapping
  private readonly langNames: Record<string, string> = {
    'en': 'English', 'de': 'German', 'es': 'Spanish', 'fr': 'French',
    'it': 'Italian', 'pt': 'Portuguese', 'nl': 'Dutch', 'pl': 'Polish',
    'ru': 'Russian', 'ja': 'Japanese', 'zh': 'Chinese', 'ko': 'Korean',
  };

  private readonly shortLangNames: Record<string, string> = {
    'en': 'EN', 'de': 'DE', 'es': 'ES', 'fr': 'FR',
    'it': 'IT', 'pt': 'PT', 'nl': 'NL', 'pl': 'PL',
    'ru': 'RU', 'ja': 'JA', 'zh': 'ZH', 'ko': 'KO',
  };

  constructor() {
    effect(() => {
      const book = this.audiobook();
      if (book) {
        this.loadAudioData();
      } else {
        this.reset();
      }
    });
  }

  ngOnInit(): void {}

  ngOnDestroy(): void {
    this.saveBookmarkImmediate();
    this.pause();
    this.stopBookmarkInterval();
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
        else this.previousSentence();
        break;
      case 'next':
        if (this.chapters().length > 0) this.nextChapter();
        else this.nextSentence();
        break;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Audio Loading
  // ─────────────────────────────────────────────────────────────────────────

  async loadAudioData(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    this.isLoading.set(true);
    this.error.set(null);

    try {
      const audioResult = await this.electronService.languageLearningGetAudioData(book.id);
      if (!audioResult.success || !audioResult.dataUrl) {
        throw new Error(audioResult.error || 'Audio file not found');
      }

      const vttResult = await this.electronService.languageLearningReadVtt(book.id);
      if (!vttResult.success || !vttResult.content) {
        throw new Error(vttResult.error || 'Subtitles not available');
      }

      const pairsResult = await this.electronService.languageLearningReadSentencePairs(book.id);
      if (!pairsResult.success || !pairsResult.pairs) {
        throw new Error(pairsResult.error || 'Sentence pairs not found');
      }

      const cues = this.vttParser.parseVtt(vttResult.content);
      this.vttCues.set(cues);
      this.sentencePairs.set(pairsResult.pairs);

      const expectedCues = pairsResult.pairs.length * 2;
      if (cues.length !== expectedCues) {
        console.warn(`VTT cue count mismatch: ${cues.length} cues for ${pairsResult.pairs.length} pairs (expected ${expectedCues})`);
      }

      this.audioPath.set(audioResult.dataUrl!);

      setTimeout(() => {
        const audio = this.audioElementRef?.nativeElement;
        if (audio) {
          audio.src = audioResult.dataUrl!;
          audio.load();
        }
      }, 0);

      // Detect chapters from manifest (non-blocking)
      this.loadChaptersFromManifest(book.id, cues);

    } catch (err) {
      console.error('Failed to load audio data:', err);
      this.error.set((err as Error).message);
    } finally {
      this.isLoading.set(false);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Chapter Detection (from manifest)
  // ─────────────────────────────────────────────────────────────────────────

  private async loadChaptersFromManifest(projectId: string, cues: VttCue[]): Promise<void> {
    try {
      const result = await this.manifestService.getProject(projectId);
      if (!result.success || !result.manifest || !result.manifest.chapters?.length) {
        this.chapters.set([]);
        return;
      }

      const manifestChapters = result.manifest.chapters
        .filter(ch => ch.sentences?.length > 0)
        .sort((a, b) => a.order - b.order);

      if (manifestChapters.length <= 1) {
        this.chapters.set([]);
        return;
      }

      // Each sentence has 2 cues (source + target)
      // Chapter start cue index = sum of (sentence counts * 2) for all prior chapters
      const playerChapters: PlayerChapter[] = [];
      let cumulativeCueIndex = 0;

      for (let i = 0; i < manifestChapters.length; i++) {
        const ch = manifestChapters[i];
        const startCueIndex = cumulativeCueIndex;
        const sentenceCount = ch.sentences.filter(s => !s.deleted).length;
        const endCueIndex = Math.min(startCueIndex + (sentenceCount * 2) - 1, cues.length - 1);

        const startTime = startCueIndex < cues.length ? cues[startCueIndex].startTime : 0;
        const endTime = endCueIndex < cues.length ? cues[endCueIndex].endTime : startTime;

        playerChapters.push({
          id: ch.id,
          title: ch.title,
          order: i,
          startTime,
          endTime,
          startCueIndex,
          endCueIndex
        });

        cumulativeCueIndex += sentenceCount * 2;
      }

      this.chapters.set(playerChapters);
      console.log(`[BilingualPlayer] Loaded ${playerChapters.length} chapters from manifest`);
    } catch (err) {
      console.warn('[BilingualPlayer] Failed to load chapters:', err);
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
    const book = this.audiobook();
    if (book?.sourceLang && book?.targetLang) {
      return `${book.sourceLang}-${book.targetLang}`;
    }
    return 'bilingual';
  }

  private async restoreBookmark(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    const bookmark = await this.bookmarkService.loadBookmark(book.id, this.getBookmarkKey());
    if (!bookmark || bookmark.position <= 0) return;

    console.log(`[BilingualPlayer] Restoring bookmark at ${bookmark.position}s`);
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.currentTime = bookmark.position;
      this.currentTime.set(bookmark.position);
      this.updateCurrentSentence(bookmark.position);
    }
    if (bookmark.sourceSpeed) this.sourceSpeed.set(bookmark.sourceSpeed);
    if (bookmark.targetSpeed) this.targetSpeed.set(bookmark.targetSpeed);
  }

  private saveBookmarkDebounced(): void {
    const book = this.audiobook();
    if (!book) return;
    this.bookmarkService.saveBookmarkDebounced(book.id, this.getBookmarkKey(), {
      position: this.currentTime(),
      chapterId: this.currentChapter()?.id,
      sourceSpeed: this.sourceSpeed(),
      targetSpeed: this.targetSpeed(),
      lastPlayedAt: new Date().toISOString()
    });
  }

  private saveBookmarkImmediate(): void {
    const book = this.audiobook();
    if (!book || this.currentTime() <= 0) return;
    this.bookmarkService.saveBookmarkImmediate(book.id, this.getBookmarkKey(), {
      position: this.currentTime(),
      chapterId: this.currentChapter()?.id,
      sourceSpeed: this.sourceSpeed(),
      targetSpeed: this.targetSpeed(),
      lastPlayedAt: new Date().toISOString()
    });
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
    this.sentencePairs.set([]);
    this.vttCues.set([]);
    this.currentPairIndex.set(0);
    this.isSourceSpeaking.set(true);
    this.currentTime.set(0);
    this.duration.set(0);
    this.audioPath.set('');
    this.chapters.set([]);
    this.chapterDrawerOpen.set(false);
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

  previousSentence(): void {
    const current = this.currentPairIndex();
    if (current > 0) {
      this.seekToPair(current - 1);
    }
  }

  nextSentence(): void {
    const current = this.currentPairIndex();
    const total = this.sentencePairs().length;
    if (current < total - 1) {
      this.seekToPair(current + 1);
    }
  }

  seekToPair(pairIndex: number): void {
    const cues = this.vttCues();
    const cueIndex = pairIndex * 2;
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
      this.updateCurrentSentence(time);
    }
  }

  setSourceSpeed(event: Event): void {
    const input = event.target as HTMLInputElement;
    const speed = parseFloat(input.value);
    this.sourceSpeed.set(speed);
    if (this.isSourceSpeaking()) {
      const audio = this.audioElementRef?.nativeElement;
      if (audio) audio.playbackRate = speed;
    }
  }

  setTargetSpeed(event: Event): void {
    const input = event.target as HTMLInputElement;
    const speed = parseFloat(input.value);
    this.targetSpeed.set(speed);
    if (!this.isSourceSpeaking()) {
      const audio = this.audioElementRef?.nativeElement;
      if (audio) audio.playbackRate = speed;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Audio Events
  // ─────────────────────────────────────────────────────────────────────────

  onTimeUpdate(): void {
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      const time = audio.currentTime;
      this.currentTime.set(time);
      this.updateCurrentSentence(time, audio);
    }
  }

  private updateCurrentSentence(time: number, audio?: HTMLAudioElement): void {
    const cues = this.vttCues();
    if (cues.length === 0) return;

    const cueIndex = this.vttParser.findCueAtTime(cues, time);
    if (cueIndex >= 0) {
      const { pairIndex, isSource } = this.vttParser.cueToSentencePair(cueIndex);

      if (pairIndex !== this.currentPairIndex()) {
        this.currentPairIndex.set(pairIndex);
        this.scrollToCurrentPair();
      }

      const wasSource = this.isSourceSpeaking();
      this.isSourceSpeaking.set(isSource);

      if (audio && wasSource !== isSource) {
        const newSpeed = isSource ? this.sourceSpeed() : this.targetSpeed();
        audio.playbackRate = newSpeed;
      }
    }
  }

  private scrollToCurrentPair(): void {
    const container = this.sentencesContainerRef?.nativeElement;
    if (!container) return;

    const pairIndex = this.currentPairIndex();
    const pairElement = container.querySelector(`[data-index="${pairIndex}"]`) as HTMLElement;

    if (pairElement) {
      const containerRect = container.getBoundingClientRect();
      const elementRect = pairElement.getBoundingClientRect();
      const elementRelativeTop = elementRect.top - containerRect.top + container.scrollTop;
      const containerHeight = container.clientHeight;
      const elementHeight = pairElement.offsetHeight;
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
      audio.playbackRate = this.sourceSpeed();
      this.restoreBookmark();
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
    console.error('Audio error:', event);
    this.error.set('Failed to load audio file');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  getLangName(code: string): string {
    return this.langNames[code] || code.toUpperCase();
  }

  getShortLangName(code: string): string {
    return this.shortLangNames[code] || code.toUpperCase();
  }
}
