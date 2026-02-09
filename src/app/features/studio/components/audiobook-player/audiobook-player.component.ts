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
import { FormsModule } from '@angular/forms';
import { ElectronService } from '../../../../core/services/electron.service';
import { VttParserService, VttCue } from '../../../language-learning/services/vtt-parser.service';

interface AudiobookData {
  id: string;
  title: string;
  author?: string;
  audiobookPath?: string;
  vttPath?: string;
  // Bilingual audio paths (separate from traditional)
  bilingualAudioPath?: string;
  bilingualVttPath?: string;
}

type AudioVersion = 'traditional' | 'bilingual';

/**
 * AudiobookPlayerComponent - VTT-synced audio player for mono-lingual audiobooks
 *
 * Features:
 * - Plays m4b/audio files
 * - Syncs text display with VTT cues
 * - Click on text to seek
 * - Playback controls and speed adjustment
 */
@Component({
  selector: 'app-audiobook-player',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="audiobook-player">
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
          <!-- Title and Version Selector -->
          <div class="player-header">
            <h2>{{ audiobook()!.title }}</h2>
            @if (audiobook()!.author) {
              <p class="author">by {{ audiobook()!.author }}</p>
            }
            @if (hasBothVersions()) {
              <div class="version-selector">
                <button
                  class="version-btn"
                  [class.active]="selectedVersion() === 'traditional'"
                  (click)="selectVersion('traditional')"
                >
                  Traditional
                </button>
                <button
                  class="version-btn"
                  [class.active]="selectedVersion() === 'bilingual'"
                  (click)="selectVersion('bilingual')"
                >
                  Bilingual
                </button>
              </div>
            }
          </div>

          <!-- Scrollable text container -->
          <div class="text-container" #textContainer>
            @for (cue of vttCues(); track cue.index) {
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

          <!-- Progress indicator -->
          <div class="cue-progress">
            <span>{{ currentCueIndex() + 1 }} of {{ vttCues().length }}</span>
          </div>

          <!-- Audio controls -->
          <div class="audio-controls">
            <button class="btn-control" (click)="previousCue()" [disabled]="currentCueIndex() <= 0" title="Previous">
              ⏮
            </button>
            <button class="btn-play" (click)="togglePlayPause()" [title]="isPlaying() ? 'Pause' : 'Play'">
              {{ isPlaying() ? '⏸' : '▶' }}
            </button>
            <button class="btn-control" (click)="nextCue()" [disabled]="currentCueIndex() >= vttCues().length - 1" title="Next">
              ⏭
            </button>
          </div>

          <!-- Progress bar -->
          <div class="progress-bar-container">
            <div class="progress-bar" (click)="onProgressClick($event)">
              <div class="progress-fill" [style.width.%]="progressPercent()"></div>
              <input
                type="range"
                class="progress-slider"
                [min]="0"
                [max]="duration()"
                [value]="currentTime()"
                (input)="onSeek($event)"
              />
            </div>
            <div class="time-display">
              <span>{{ formatTime(currentTime()) }}</span>
              <span>{{ formatTime(duration()) }}</span>
            </div>
          </div>

          <!-- Speed control -->
          <div class="speed-control">
            <label>Speed</label>
            <select [ngModel]="playbackSpeed()" (ngModelChange)="setSpeed($event)">
              <option [value]="0.5">0.5x</option>
              <option [value]="0.75">0.75x</option>
              <option [value]="1">1x</option>
              <option [value]="1.25">1.25x</option>
              <option [value]="1.5">1.5x</option>
              <option [value]="2">2x</option>
            </select>
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
        </div>
      }
    </div>
  `,
  styles: [`
    .audiobook-player {
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
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 24px;
      min-height: 0;
    }

    .player-header {
      text-align: center;
      margin-bottom: 20px;
      flex-shrink: 0;

      h2 {
        margin: 0 0 4px;
        font-size: 18px;
        color: var(--text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .author {
        margin: 0;
        font-size: 14px;
        color: var(--text-secondary);
      }

      .version-selector {
        display: flex;
        justify-content: center;
        gap: 8px;
        margin-top: 12px;

        .version-btn {
          padding: 6px 16px;
          border: 1px solid var(--border-default);
          border-radius: 16px;
          background: var(--bg-surface);
          color: var(--text-secondary);
          font-size: 12px;
          cursor: pointer;
          transition: all 0.15s;

          &:hover:not(.active) {
            background: var(--bg-hover);
            color: var(--text-primary);
          }

          &.active {
            background: var(--color-primary);
            border-color: var(--color-primary);
            color: white;
          }
        }
      }
    }

    .text-container {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 8px 0;
      scroll-behavior: smooth;
    }

    .text-segment {
      padding: 12px 16px;
      margin-bottom: 8px;
      border-radius: 8px;
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

      p {
        margin: 0;
        font-size: 15px;
        line-height: 1.6;
        color: var(--text-primary);
      }
    }

    .cue-progress {
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
      padding: 12px 0;
      flex-shrink: 0;
    }

    .audio-controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      margin-bottom: 20px;
      flex-shrink: 0;
    }

    .btn-control {
      width: 44px;
      height: 44px;
      border: none;
      border-radius: 50%;
      background: var(--bg-hover);
      color: var(--text-primary);
      font-size: 18px;
      cursor: pointer;
      transition: background 0.15s;

      &:hover:not(:disabled) {
        background: var(--bg-muted);
      }

      &:disabled {
        opacity: 0.3;
        cursor: not-allowed;
      }
    }

    .btn-play {
      width: 64px;
      height: 64px;
      border: none;
      border-radius: 50%;
      background: var(--color-primary);
      color: white;
      font-size: 24px;
      cursor: pointer;
      transition: transform 0.15s, background 0.15s;

      &:hover {
        transform: scale(1.05);
      }
    }

    .progress-bar-container {
      max-width: 500px;
      margin: 0 auto;
      width: 100%;
      flex-shrink: 0;
    }

    .progress-bar {
      position: relative;
      height: 6px;
      background: var(--bg-muted);
      border-radius: 3px;
      overflow: visible;
      cursor: pointer;
    }

    .progress-fill {
      height: 100%;
      background: var(--color-primary);
      border-radius: 3px;
      transition: width 0.1s;
      pointer-events: none;
    }

    .progress-slider {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      cursor: pointer;
      margin: 0;
    }

    .time-display {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 8px;
    }

    .speed-control {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      margin-top: 16px;
      flex-shrink: 0;

      label {
        font-size: 12px;
        color: var(--text-muted);
      }

      select {
        padding: 6px 12px;
        border: 1px solid var(--border-default);
        border-radius: 6px;
        background: var(--bg-surface);
        color: var(--text-primary);
        font-size: 13px;
        cursor: pointer;

        &:focus {
          outline: none;
          border-color: var(--color-primary);
        }
      }
    }
  `]
})
export class AudiobookPlayerComponent implements OnInit, OnDestroy {
  @ViewChild('audioElement') audioElementRef!: ElementRef<HTMLAudioElement>;
  @ViewChild('textContainer') textContainerRef!: ElementRef<HTMLDivElement>;

  private readonly electronService = inject(ElectronService);
  private readonly vttParser = inject(VttParserService);

  // Inputs
  readonly audiobook = input<AudiobookData | null>(null);

  // Loading/Error state
  readonly isLoading = signal<boolean>(false);
  readonly error = signal<string | null>(null);

  // Audio state
  readonly isPlaying = signal<boolean>(false);
  readonly currentTime = signal<number>(0);
  readonly duration = signal<number>(0);
  readonly playbackSpeed = signal<number>(1);

  // VTT cues
  readonly vttCues = signal<VttCue[]>([]);
  readonly currentCueIndex = signal<number>(0);

  // Version selection (traditional vs bilingual)
  readonly selectedVersion = signal<AudioVersion>('traditional');

  // Track last loaded book to avoid resetting version on same book
  private lastLoadedBookId: string | null = null;
  // Track book data to detect when paths change (e.g., bilingual audio added)
  private lastBookDataHash: string | null = null;

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

  // Computed
  readonly progressPercent = computed(() => {
    const d = this.duration();
    if (d === 0) return 0;
    return (this.currentTime() / d) * 100;
  });

  constructor() {
    // React to audiobook changes
    effect(() => {
      const book = this.audiobook();
      if (book) {
        // Create a hash of all path data to detect changes
        const dataHash = JSON.stringify([
          book.audiobookPath,
          book.vttPath,
          book.bilingualAudioPath,
          book.bilingualVttPath
        ]);
        const isNewBook = this.lastLoadedBookId !== book.id;
        const dataChanged = this.lastBookDataHash !== dataHash;

        // Only reset version when switching to a different book
        if (isNewBook) {
          this.lastLoadedBookId = book.id;
          // Determine initial version based on what's available
          const hasTraditional = !!book.audiobookPath && !!book.vttPath;
          const hasBilingual = !!book.bilingualAudioPath && !!book.bilingualVttPath;
          if (!hasTraditional && hasBilingual) {
            this.selectedVersion.set('bilingual');
          } else {
            this.selectedVersion.set('traditional');
          }
        }

        // Only reload if it's a new book or paths have changed
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

  /**
   * Switch between traditional and bilingual versions
   */
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
    this.pause();
  }

  // Store loaded audio data URL to set after component renders
  private pendingAudioDataUrl: string | null = null;

  async loadAudioData(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    // Get paths based on selected version
    const audioPath = this.currentAudioPath();
    const vttPath = this.currentVttPath();
    const version = this.selectedVersion();

    this.isLoading.set(true);
    this.error.set(null);
    this.pendingAudioDataUrl = null;

    try {
      // Check if audio file exists
      if (!audioPath) {
        throw new Error(`No ${version} audio file linked to this audiobook`);
      }

      // Check if VTT file exists
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

      // Load audio as data URL (more reliable than HTTP in Electron)
      console.log(`[AudiobookPlayer] Loading ${version} audio file:`, audioPath);
      const audioResult = await this.electronService.readAudioFile(audioPath);
      if (!audioResult.success || !audioResult.dataUrl) {
        throw new Error(audioResult.error || 'Failed to load audio file');
      }
      console.log(`[AudiobookPlayer] Loaded ${version} audio: ${audioResult.size} bytes`);

      // Store the data URL to set after isLoading becomes false and element renders
      this.pendingAudioDataUrl = audioResult.dataUrl;
      // Reset position for version switches
      this.currentTime.set(0);
      this.currentCueIndex.set(0);

    } catch (err) {
      console.error('Failed to load audiobook:', err);
      this.error.set((err as Error).message);
    } finally {
      this.isLoading.set(false);

      // Wait for Angular to render the audio element, then set the source
      if (this.pendingAudioDataUrl) {
        setTimeout(() => {
          const audio = this.audioElementRef?.nativeElement;
          if (audio) {
            console.log('[AudiobookPlayer] Setting audio source...');
            audio.src = this.pendingAudioDataUrl!;
            audio.load();
            console.log('[AudiobookPlayer] Audio load() called');
          } else {
            console.error('[AudiobookPlayer] Audio element not found!');
          }
        }, 50); // Give Angular time to render
      }
    }
  }

  reset(): void {
    this.pause();
    this.vttCues.set([]);
    this.currentCueIndex.set(0);
    this.currentTime.set(0);
    this.duration.set(0);
    this.error.set(null);
  }

  togglePlayPause(): void {
    if (this.isPlaying()) {
      this.pause();
    } else {
      this.play();
    }
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
    this.playbackSpeed.set(speed);
    const audio = this.audioElementRef?.nativeElement;
    if (audio) {
      audio.playbackRate = speed;
    }
  }

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
    }
  }

  onEnded(): void {
    this.isPlaying.set(false);
  }

  onPlay(): void {
    this.isPlaying.set(true);
  }

  onPause(): void {
    this.isPlaying.set(false);
  }

  onAudioError(event: Event): void {
    console.error('Audio error:', event);
    this.error.set('Failed to load audio file. Make sure the file exists.');
  }

  onSeek(event: Event): void {
    const input = event.target as HTMLInputElement;
    const time = parseFloat(input.value);
    this.seekToTime(time);
  }

  onProgressClick(event: MouseEvent): void {
    const bar = event.currentTarget as HTMLElement;
    const rect = bar.getBoundingClientRect();
    const percent = (event.clientX - rect.left) / rect.width;
    const time = percent * this.duration();
    this.seekToTime(time);
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
}
