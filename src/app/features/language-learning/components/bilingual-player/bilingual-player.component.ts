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
import { VttParserService, VttCue } from '../../services/vtt-parser.service';

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
  path?: string;        // From completed list
  epubPath?: string;
  vttPath?: string;
  createdAt?: string;   // From completed list
  sentencePairs?: SentencePair[];
}

@Component({
  selector: 'app-bilingual-player',
  standalone: true,
  imports: [CommonModule],
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
          </div>

          <!-- Scrollable sentences container -->
          <div class="sentences-container" #sentencesContainer>
            @for (pair of sentencePairs(); track pair.index) {
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

          <!-- Audio controls -->
          <div class="audio-controls">
            <button class="btn-control" (click)="previousSentence()" [disabled]="currentPairIndex() <= 0" title="Previous sentence">
              ⏮
            </button>
            <button class="btn-play" (click)="togglePlayPause()" [title]="isPlaying() ? 'Pause' : 'Play'">
              {{ isPlaying() ? '⏸' : '▶' }}
            </button>
            <button class="btn-control" (click)="nextSentence()" [disabled]="currentPairIndex() >= sentencePairs().length - 1" title="Next sentence">
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
    }

    .sentences-container {
      flex: 1;
      overflow-y: auto;
      min-height: 0;
      padding: 8px 0;
      scroll-behavior: smooth;
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
  readonly sourceSpeed = signal<number>(1);
  readonly targetSpeed = signal<number>(1);

  // Sentence tracking
  readonly sentencePairs = signal<SentencePair[]>([]);
  readonly vttCues = signal<VttCue[]>([]);
  readonly currentPairIndex = signal<number>(0);
  readonly isSourceSpeaking = signal<boolean>(true);

  // Audio path
  readonly audioPath = signal<string>('');

  // Computed
  readonly progressPercent = computed(() => {
    const d = this.duration();
    if (d === 0) return 0;
    return (this.currentTime() / d) * 100;
  });

  // Language name mapping
  private readonly langNames: Record<string, string> = {
    'en': 'English',
    'de': 'German',
    'es': 'Spanish',
    'fr': 'French',
    'it': 'Italian',
    'pt': 'Portuguese',
    'nl': 'Dutch',
    'pl': 'Polish',
    'ru': 'Russian',
    'ja': 'Japanese',
    'zh': 'Chinese',
    'ko': 'Korean',
  };

  private readonly shortLangNames: Record<string, string> = {
    'en': 'EN',
    'de': 'DE',
    'es': 'ES',
    'fr': 'FR',
    'it': 'IT',
    'pt': 'PT',
    'nl': 'NL',
    'pl': 'PL',
    'ru': 'RU',
    'ja': 'JA',
    'zh': 'ZH',
    'ko': 'KO',
  };

  constructor() {
    // React to audiobook changes
    effect(() => {
      const book = this.audiobook();
      if (book) {
        this.loadAudioData();
      } else {
        this.reset();
      }
    });
  }

  ngOnInit(): void {
    // Initial load handled by effect
  }

  ngOnDestroy(): void {
    this.pause();
  }

  async loadAudioData(): Promise<void> {
    const book = this.audiobook();
    if (!book) return;

    this.isLoading.set(true);
    this.error.set(null);

    try {
      // Load audio as data URL (more reliable than custom protocols)
      const audioResult = await this.electronService.languageLearningGetAudioData(book.id);
      if (!audioResult.success || !audioResult.dataUrl) {
        throw new Error(audioResult.error || 'Audio file not found');
      }
      console.log(`[PLAYER] Loaded audio: ${audioResult.size} bytes`);

      // Load VTT file
      const vttResult = await this.electronService.languageLearningReadVtt(book.id);
      if (!vttResult.success || !vttResult.content) {
        throw new Error(vttResult.error || 'Subtitles not available');
      }

      // Load sentence pairs
      const pairsResult = await this.electronService.languageLearningReadSentencePairs(book.id);
      if (!pairsResult.success || !pairsResult.pairs) {
        throw new Error(pairsResult.error || 'Sentence pairs not found');
      }

      // Parse VTT
      const cues = this.vttParser.parseVtt(vttResult.content);
      this.vttCues.set(cues);

      // Set sentence pairs
      this.sentencePairs.set(pairsResult.pairs);

      // Validate: VTT cues should be 2x sentence pairs
      const expectedCues = pairsResult.pairs.length * 2;
      if (cues.length !== expectedCues) {
        console.warn(`VTT cue count mismatch: ${cues.length} cues for ${pairsResult.pairs.length} pairs (expected ${expectedCues})`);
      }

      // Set audio source using data URL
      this.audioPath.set(audioResult.dataUrl!);

      // Wait a tick for the audio element to be ready
      setTimeout(() => {
        const audio = this.audioElementRef?.nativeElement;
        if (audio) {
          console.log('[PLAYER] Setting audio source...');
          audio.src = audioResult.dataUrl!;
          audio.load();
          console.log('[PLAYER] Audio load() called');
        } else {
          console.error('[PLAYER] Audio element not found!');
        }
      }, 0);

    } catch (err) {
      console.error('Failed to load audio data:', err);
      this.error.set((err as Error).message);
    } finally {
      this.isLoading.set(false);
    }
  }

  reset(): void {
    this.pause();
    this.sentencePairs.set([]);
    this.vttCues.set([]);
    this.currentPairIndex.set(0);
    this.isSourceSpeaking.set(true);
    this.currentTime.set(0);
    this.duration.set(0);
    this.audioPath.set('');
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
    // Each pair has 2 cues (source and target)
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
    // If currently playing source, update playback rate immediately
    if (this.isSourceSpeaking()) {
      const audio = this.audioElementRef?.nativeElement;
      if (audio) {
        audio.playbackRate = speed;
      }
    }
  }

  setTargetSpeed(event: Event): void {
    const input = event.target as HTMLInputElement;
    const speed = parseFloat(input.value);
    this.targetSpeed.set(speed);
    // If currently playing target, update playback rate immediately
    if (!this.isSourceSpeaking()) {
      const audio = this.audioElementRef?.nativeElement;
      if (audio) {
        audio.playbackRate = speed;
      }
    }
  }

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

      // Only update and scroll if pair changed
      if (pairIndex !== this.currentPairIndex()) {
        this.currentPairIndex.set(pairIndex);
        this.scrollToCurrentPair();
      }

      // Track previous speaking state to detect language switches
      const wasSource = this.isSourceSpeaking();
      this.isSourceSpeaking.set(isSource);

      // When language switches, update playback rate
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
      // Use getBoundingClientRect for accurate positioning relative to container
      const containerRect = container.getBoundingClientRect();
      const elementRect = pairElement.getBoundingClientRect();

      // Calculate element's position relative to container's visible area
      const elementRelativeTop = elementRect.top - containerRect.top + container.scrollTop;

      // Center the element in the container
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
      // Apply initial playback speed (starts with source language)
      audio.playbackRate = this.sourceSpeed();
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
    this.error.set('Failed to load audio file');
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

  getLangName(code: string): string {
    return this.langNames[code] || code.toUpperCase();
  }

  getShortLangName(code: string): string {
    return this.shortLangNames[code] || code.toUpperCase();
  }

  formatTime(seconds: number): string {
    if (!seconds || isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}
