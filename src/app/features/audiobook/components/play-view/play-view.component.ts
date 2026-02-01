import {
  Component,
  input,
  signal,
  computed,
  OnInit,
  OnDestroy,
  inject,
  ElementRef,
  ViewChild,
  effect
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DesktopButtonComponent } from '../../../../creamsicle-desktop';
import { ElectronService } from '../../../../core/services/electron.service';
import { EpubService } from '../../services/epub.service';
import { PlayTextService } from '../../services/play-text.service';
import { AudioPlayerService } from '../../services/audio-player.service';
import {
  PlayableChapter,
  PlayableSentence,
  PlaySettings,
  PlaybackState,
  SessionState,
  AVAILABLE_VOICES,
  SPEED_OPTIONS
} from '../../models/play.types';

@Component({
  selector: 'app-play-view',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  template: `
    <div class="play-view">
      <!-- Loading Modal Overlay -->
      @if (showLoadingModal()) {
        <div class="loading-modal-overlay">
          <div class="loading-modal">
            <div class="loading-spinner"></div>
            <h3>{{ loadingTitle() }}</h3>
            <p class="loading-message">{{ loadingMessage() }}</p>
            @if (loadingError()) {
              <p class="loading-error">{{ loadingError() }}</p>
              <desktop-button variant="secondary" (click)="dismissError()">
                Dismiss
              </desktop-button>
            }
          </div>
        </div>
      }

      <!-- Main content (visible when not in loading modal) -->
      <div class="main-content" [class.hidden]="showLoadingModal()">
        <!-- Settings bar -->
        <div class="settings-bar">
          <div class="setting">
            <label>Voice</label>
            <select
              [ngModel]="selectedVoice()"
              (ngModelChange)="onVoiceChange($event)"
              [disabled]="!isReady() || isPlaying()"
            >
              @for (voice of voices; track voice.id) {
                <option [value]="voice.id">{{ voice.name }}</option>
              }
            </select>
          </div>

          <div class="setting">
            <label>Speed</label>
            <select
              [ngModel]="selectedSpeed()"
              (ngModelChange)="onSpeedChange($event)"
              [disabled]="!isReady() || playbackState() === 'playing'"
            >
              @for (speed of speeds; track speed.value) {
                <option [value]="speed.value">{{ speed.label }}</option>
              }
            </select>
          </div>

          <div class="setting chapter-select">
            <label>Chapter</label>
            <select
              [ngModel]="selectedChapterId()"
              (ngModelChange)="onChapterChange($event)"
              [disabled]="chaptersLoading() || chapters().length === 0"
            >
              @for (chapter of chapters(); track chapter.id) {
                <option [value]="chapter.id">{{ chapter.title }}</option>
              }
            </select>
          </div>
        </div>

        <!-- Text display -->
        <div class="text-pane" #textPane>
          @if (currentChapter()) {
            <div class="chapter-content">
              @for (sentence of currentChapter()!.sentences; track sentence.index) {
                <span
                  class="sentence"
                  [class.active]="sentence.index === currentSentenceIndex()"
                  [class.played]="sentence.index < currentSentenceIndex()"
                  (click)="onSentenceClick(sentence)"
                  [attr.data-index]="sentence.index"
                >{{ sentence.text }} </span>
              }
            </div>
          } @else if (chaptersLoading()) {
            <div class="loading-state">
              <div class="spinner"></div>
              <span>Loading chapter...</span>
            </div>
          } @else {
            <div class="empty-state">
              <p>No chapters available</p>
            </div>
          }
        </div>

        <!-- Playback controls -->
        <div class="controls">
          <div class="control-group">
            <!-- Prev chapter - always visible -->
            <desktop-button
              variant="ghost"
              size="sm"
              [disabled]="!canGoPrevChapter()"
              (click)="prevChapter()"
              title="Previous Chapter"
            >
              &#9198;
            </desktop-button>

            @if (!isReady()) {
              <!-- Not ready - show Start TTS button -->
              <desktop-button
                variant="primary"
                size="lg"
                (click)="startSession()"
                [disabled]="chaptersLoading()"
                class="play-btn"
              >
                Start TTS Engine
              </desktop-button>
            } @else {
              <!-- Ready - show playback controls -->
              @if (isPlaying()) {
                <desktop-button
                  variant="primary"
                  size="lg"
                  (click)="pause()"
                  title="Pause"
                  class="play-btn"
                >
                  &#9208; Pause
                </desktop-button>
              } @else {
                <desktop-button
                  variant="primary"
                  size="lg"
                  (click)="play()"
                  title="Play"
                  class="play-btn"
                >
                  &#9654; Play
                </desktop-button>
              }

              <desktop-button
                variant="ghost"
                size="sm"
                [disabled]="playbackState() === 'idle'"
                (click)="stop()"
                title="Stop"
              >
                &#9209;
              </desktop-button>
            }

            <!-- Next chapter - always visible -->
            <desktop-button
              variant="ghost"
              size="sm"
              [disabled]="!canGoNextChapter()"
              (click)="nextChapter()"
              title="Next Chapter"
            >
              &#9197;
            </desktop-button>
          </div>

          <div class="playback-info">
            @if (currentChapter()) {
              <span class="chapter-indicator">
                Ch {{ currentChapterIndex() + 1 }}/{{ chapters().length }}
              </span>
              @if (isReady()) {
                <span class="sentence-indicator">
                  {{ currentSentenceIndex() + 1 }}/{{ currentChapter()!.sentences.length }}
                </span>
              }
            }
            @if (isGenerating()) {
              <span class="generating-indicator">Generating...</span>
            }
          </div>

          @if (isReady()) {
            <desktop-button variant="ghost" size="sm" (click)="endSession()">
              End Session
            </desktop-button>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }

    .play-view {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
      background: var(--surface-0);
      position: relative;
    }

    /* Loading Modal */
    .loading-modal-overlay {
      position: absolute;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }

    .loading-modal {
      background: var(--surface-1);
      border-radius: 12px;
      padding: 32px 48px;
      text-align: center;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }

    .loading-spinner {
      width: 48px;
      height: 48px;
      border: 3px solid var(--border-default);
      border-top-color: var(--accent-primary);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 16px;
    }

    .loading-modal h3 {
      margin: 0 0 8px;
      font-size: 18px;
      color: var(--text-primary);
    }

    .loading-message {
      margin: 0;
      color: var(--text-secondary);
      font-size: 14px;
    }

    .loading-error {
      margin: 16px 0;
      color: var(--accent-danger);
      font-size: 13px;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    /* Main content */
    .main-content {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    .main-content.hidden {
      visibility: hidden;
    }

    .settings-bar {
      display: flex;
      gap: 16px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--surface-1);
      align-items: center;
      flex-wrap: wrap;
    }

    .setting {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .setting label {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .setting select {
      padding: 6px 8px;
      border: 1px solid var(--border-default);
      border-radius: 4px;
      background: var(--surface-0);
      color: var(--text-primary);
      font-size: 13px;
      min-width: 140px;
    }

    .setting select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .chapter-select {
      flex: 1;
      min-width: 200px;
    }

    .chapter-select select {
      width: 100%;
    }

    .text-pane {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 24px 32px;
      line-height: 1.8;
      font-size: 16px;
    }

    .chapter-content {
      max-width: 700px;
      margin: 0 auto;
    }

    .sentence {
      cursor: pointer;
      transition: background-color 0.15s ease;
      border-radius: 2px;
      padding: 0 2px;
      margin: 0 -2px;
    }

    .sentence:hover {
      background: var(--surface-2);
    }

    .sentence.played {
      color: var(--text-secondary);
    }

    .sentence.active {
      background: rgba(255, 200, 0, 0.3);
      color: var(--text-primary);
    }

    .loading-state,
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 12px;
      color: var(--text-secondary);
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 2px solid var(--border-default);
      border-top-color: var(--accent-primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .controls {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 16px;
      padding: 16px;
      border-top: 1px solid var(--border-subtle);
      background: var(--surface-1);
      min-height: 72px;
    }

    .start-prompt {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
    }

    .start-hint {
      font-size: 12px;
      color: var(--text-tertiary);
    }

    .control-group {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .play-btn {
      min-width: 120px;
    }

    .playback-info {
      display: flex;
      gap: 12px;
      font-size: 12px;
      color: var(--text-secondary);
      margin-left: auto;
    }

    .generating-indicator {
      color: var(--accent-primary);
      animation: pulse 1s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
  `]
})
export class PlayViewComponent implements OnInit, OnDestroy {
  // Inputs
  readonly epubPath = input.required<string>();

  // Services
  private readonly electronService = inject(ElectronService);
  private readonly epubService = inject(EpubService);
  private readonly playTextService = inject(PlayTextService);
  private readonly audioPlayer = inject(AudioPlayerService);

  // View refs
  @ViewChild('textPane') textPane!: ElementRef<HTMLDivElement>;

  // Constants
  readonly voices = AVAILABLE_VOICES;
  readonly speeds = SPEED_OPTIONS;

  // Loading modal state
  readonly showLoadingModal = signal(false);
  readonly loadingTitle = signal('');
  readonly loadingMessage = signal('');
  readonly loadingError = signal<string | null>(null);

  // Session state
  readonly sessionState = signal<SessionState>('inactive');
  readonly isReady = computed(() => this.sessionState() === 'ready');

  // Chapter state
  readonly chaptersLoading = signal(false);
  readonly chapters = signal<PlayableChapter[]>([]);
  readonly selectedChapterId = signal<string>('');
  readonly currentChapter = computed(() =>
    this.chapters().find(c => c.id === this.selectedChapterId()) || null
  );
  readonly currentChapterIndex = computed(() =>
    this.chapters().findIndex(c => c.id === this.selectedChapterId())
  );

  // Playback state
  readonly playbackState = signal<PlaybackState>('idle');
  readonly isPlaying = computed(() =>
    this.playbackState() === 'playing' || this.playbackState() === 'buffering'
  );
  readonly isGenerating = signal(false);
  readonly selectedVoice = signal<string>('ScarlettJohansson');
  readonly selectedSpeed = signal<number>(1.25);
  readonly currentSentenceIndex = signal<number>(0);

  // Computed
  readonly canGoPrevChapter = computed(() => this.currentChapterIndex() > 0);
  readonly canGoNextChapter = computed(() =>
    this.currentChapterIndex() < this.chapters().length - 1
  );

  // Private
  private generateAbortController?: AbortController;
  private unsubscribeSessionEnd?: () => void;

  constructor() {
    // Sync playback state from audio player
    effect(() => {
      const state = this.audioPlayer.playbackState();
      this.playbackState.set(state);
    });

    // Sync sentence index from audio player
    effect(() => {
      const index = this.audioPlayer.currentSentenceIndex();
      if (index >= 0) {
        this.currentSentenceIndex.set(index);
        this.scrollToSentence(index);
      }
    });
  }

  ngOnInit() {
    this.loadChapters();

    // Handle session end from main process
    this.unsubscribeSessionEnd = this.electronService.onPlaySessionEnded(() => {
      this.sessionState.set('inactive');
      this.stop();
    });

    // Audio player callbacks
    this.audioPlayer.onPlaybackEnd(() => {
      // Check if there are more sentences to generate
      const chapter = this.currentChapter();
      if (chapter && this.currentSentenceIndex() < chapter.sentences.length - 1) {
        // Continue playing - the generation loop should still be running
        return;
      }

      // Auto-advance to next chapter
      if (this.canGoNextChapter()) {
        this.nextChapter();
        setTimeout(() => this.play(), 300);
      }
    });
  }

  ngOnDestroy() {
    this.unsubscribeSessionEnd?.();
    this.generateAbortController?.abort();
    this.audioPlayer.destroy();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Session management
  // ─────────────────────────────────────────────────────────────────────────────

  async startSession() {
    this.showLoadingModal.set(true);
    this.loadingTitle.set('Starting TTS Engine');
    this.loadingMessage.set('Initializing...');
    this.loadingError.set(null);
    this.sessionState.set('starting');

    try {
      // Start the Python process
      this.loadingMessage.set('Starting Python process...');
      const startResult = await this.electronService.playStartSession();

      if (!startResult.success) {
        throw new Error(startResult.error || 'Failed to start session');
      }

      // Load the voice model
      this.loadingMessage.set('Loading voice model (this may take a minute)...');
      const voiceResult = await this.electronService.playLoadVoice(this.selectedVoice());

      if (!voiceResult.success) {
        throw new Error(voiceResult.error || 'Failed to load voice');
      }

      // Ready!
      this.sessionState.set('ready');
      this.showLoadingModal.set(false);

    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.loadingError.set(message);
      this.loadingMessage.set('Failed to start TTS engine');
      this.sessionState.set('error');
    }
  }

  dismissError() {
    this.showLoadingModal.set(false);
    this.loadingError.set(null);
    this.sessionState.set('inactive');
  }

  async endSession() {
    this.stop();
    await this.electronService.playEndSession();
    this.sessionState.set('inactive');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Playback controls
  // ─────────────────────────────────────────────────────────────────────────────

  async play() {
    if (!this.isReady() || !this.currentChapter()) return;

    await this.audioPlayer.initialize();

    // If we're paused (with or without audio in queue), just resume
    if (this.playbackState() === 'paused') {
      this.audioPlayer.play();
      return;
    }

    // If generation is already running and we have audio, just play
    if (this.isGenerating() && this.audioPlayer.getQueueLength() > 0) {
      this.audioPlayer.play();
      return;
    }

    // Start fresh - clear any stale audio and always start from sentence 0
    this.audioPlayer.clearQueue();
    this.currentSentenceIndex.set(0);

    // Start generating audio in background
    this.generateAndPlay(0);
  }

  pause() {
    // Audio player handles both playing and buffering states
    this.audioPlayer.pause();
  }

  stop() {
    this.generateAbortController?.abort();
    this.audioPlayer.stop();
    this.audioPlayer.clearQueue();
    this.isGenerating.set(false);
    this.currentSentenceIndex.set(0);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chapter navigation
  // ─────────────────────────────────────────────────────────────────────────────

  onChapterChange(chapterId: string) {
    this.stop();
    this.selectedChapterId.set(chapterId);
    this.currentSentenceIndex.set(0);
  }

  prevChapter() {
    const index = this.currentChapterIndex();
    if (index > 0) {
      this.stop();
      this.selectedChapterId.set(this.chapters()[index - 1].id);
      this.currentSentenceIndex.set(0);
    }
  }

  nextChapter() {
    const index = this.currentChapterIndex();
    if (index < this.chapters().length - 1) {
      this.stop();
      this.selectedChapterId.set(this.chapters()[index + 1].id);
      this.currentSentenceIndex.set(0);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────────────────────

  async onVoiceChange(voice: string) {
    this.selectedVoice.set(voice);

    if (this.isReady()) {
      this.showLoadingModal.set(true);
      this.loadingTitle.set('Switching Voice');
      this.loadingMessage.set(`Loading ${voice}...`);
      this.loadingError.set(null);

      const result = await this.electronService.playLoadVoice(voice);

      if (result.success) {
        this.showLoadingModal.set(false);
      } else {
        this.loadingError.set(result.error || 'Failed to load voice');
        this.loadingMessage.set('Voice switch failed');
      }
    }
  }

  onSpeedChange(speed: number) {
    const newSpeed = Number(speed);
    const oldSpeed = this.selectedSpeed();
    this.selectedSpeed.set(newSpeed);

    // If speed changed while paused, restart from current position with new settings
    if (newSpeed !== oldSpeed && this.playbackState() === 'paused') {
      const currentIndex = this.currentSentenceIndex();
      this.stop();
      this.currentSentenceIndex.set(currentIndex);
      // User will manually click play to resume with new speed
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sentence interaction
  // ─────────────────────────────────────────────────────────────────────────────

  onSentenceClick(sentence: PlayableSentence) {
    if (!this.isReady()) return;

    // Stop current playback and restart from clicked sentence
    this.stop();
    this.currentSentenceIndex.set(sentence.index);
    this.play();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────────

  private async loadChapters() {
    this.chaptersLoading.set(true);

    try {
      const structure = await this.epubService.open(this.epubPath());
      if (!structure) {
        console.error('Failed to parse EPUB:', this.epubService.error());
        return;
      }

      const chapters: PlayableChapter[] = [];

      for (const chapter of structure.chapters) {
        const text = await this.epubService.getChapterText(chapter.id);
        if (text) {
          const parsed = this.playTextService.parseChapter(
            chapter.id,
            chapter.title,
            text
          );
          parsed.sentences = this.playTextService.optimizeForTTS(parsed.sentences);
          chapters.push(parsed);
        }
      }

      this.chapters.set(chapters);

      if (chapters.length > 0) {
        this.selectedChapterId.set(chapters[0].id);
      }
    } catch (error) {
      console.error('Failed to load chapters:', error);
    } finally {
      this.chaptersLoading.set(false);
    }
  }

  // Mutex for enqueue synchronization
  private enqueueLock = Promise.resolve();

  private async generateAndPlay(startIndex: number) {
    const chapter = this.currentChapter();
    if (!chapter) return;

    this.generateAbortController = new AbortController();
    const signal = this.generateAbortController.signal;

    const settings: PlaySettings = {
      voice: this.selectedVoice(),
      speed: this.selectedSpeed()
    };

    this.isGenerating.set(true);
    this.playbackState.set('buffering');

    // Generation settings
    const NUM_WORKERS = 3;  // Number of parallel workers
    const BUFFER_AHEAD = 10;  // Generate this many sentences ahead of playback
    const BUFFER_BEFORE_PLAY = 4;  // Start playback after this many sentences buffered

    // Completed audio storage (may complete out of order, enqueue in order)
    const completedAudio: Map<number, { data: string; duration: number; sampleRate: number } | null> = new Map();
    let nextToEnqueue = startIndex;  // Next sentence to add to audio queue (in order)
    let playbackStarted = false;

    // Task queue for workers (thread-safe via single-threaded JS)
    const taskQueue: number[] = [];  // Sentence indices to generate
    let generationComplete = false;

    // Initialize task queue with first batch
    const totalSentences = chapter.sentences.length;
    for (let i = startIndex; i < Math.min(startIndex + BUFFER_AHEAD + NUM_WORKERS, totalSentences); i++) {
      taskQueue.push(i);
    }
    let highestQueued = taskQueue.length > 0 ? taskQueue[taskQueue.length - 1] : startIndex - 1;

    // Get next task from queue (returns undefined if empty)
    const getNextTask = (): number | undefined => {
      return taskQueue.shift();
    };

    // Add more tasks as playback progresses
    const maybeAddMoreTasks = () => {
      // Keep BUFFER_AHEAD sentences queued ahead of what's been enqueued
      while (highestQueued < totalSentences - 1 && highestQueued < nextToEnqueue + BUFFER_AHEAD + NUM_WORKERS) {
        highestQueued++;
        taskQueue.push(highestQueued);
      }
    };

    // Enqueue completed audio in order
    const enqueueInOrder = async () => {
      while (completedAudio.has(nextToEnqueue)) {
        const audio = completedAudio.get(nextToEnqueue);
        completedAudio.delete(nextToEnqueue);

        if (audio) {
          await this.audioPlayer.enqueueAudio(audio, nextToEnqueue);
          console.log('[PlayView] Enqueued sentence', nextToEnqueue, 'queue size:', this.audioPlayer.getQueueLength());
        } else {
          console.warn('[PlayView] Skipping failed sentence', nextToEnqueue);
        }

        nextToEnqueue++;

        // Add more tasks as we progress
        maybeAddMoreTasks();

        // Start playback once we have enough buffered
        if (!playbackStarted && this.audioPlayer.getQueueLength() >= BUFFER_BEFORE_PLAY) {
          console.log('[PlayView] Starting playback with', this.audioPlayer.getQueueLength(), 'sentences buffered');
          this.audioPlayer.play();
          playbackStarted = true;
        }
      }
    };

    try {
      console.log('[PlayView] Starting generation from sentence', startIndex,
        'total:', totalSentences, 'workers:', NUM_WORKERS);

      let activeWorkers = 0;
      let resolveAllDone: () => void;
      const allDonePromise = new Promise<void>(resolve => { resolveAllDone = resolve; });

      // Worker function: get task, generate, repeat until no more tasks
      const worker = async (workerId: number) => {
        while (!signal.aborted) {
          const sentenceIndex = getNextTask();
          if (sentenceIndex === undefined) {
            // No more tasks
            break;
          }

          const sentence = chapter.sentences[sentenceIndex];
          console.log(`[PlayView W${workerId}] Generating sentence`, sentenceIndex);

          const result = await this.electronService.playGenerateSentence(
            sentence.text,
            sentence.index,
            settings
          );

          if (signal.aborted) break;

          if (result.success && result.audio) {
            console.log(`[PlayView W${workerId}] Got audio for sentence`, sentenceIndex, 'duration:', result.audio.duration?.toFixed(2) + 's');
            completedAudio.set(sentenceIndex, result.audio);
          } else {
            console.error(`[PlayView W${workerId}] Failed sentence`, sentenceIndex, result.error);
            completedAudio.set(sentenceIndex, null);
          }

          // Enqueue any completed audio in order
          await enqueueInOrder();
        }

        // Worker done
        activeWorkers--;
        if (activeWorkers === 0) {
          generationComplete = true;
          resolveAllDone!();
        }
      };

      // Start workers
      for (let i = 0; i < NUM_WORKERS; i++) {
        activeWorkers++;
        worker(i);  // Don't await - run in parallel
      }

      // Wait for all workers to complete
      await allDonePromise;

      // Final enqueue pass
      await enqueueInOrder();

    } finally {
      this.isGenerating.set(false);
      this.audioPlayer.generationComplete();
    }
  }

  private scrollToSentence(index: number) {
    if (!this.textPane) return;

    const pane = this.textPane.nativeElement;
    const sentenceEl = pane.querySelector(`[data-index="${index}"]`) as HTMLElement;

    if (sentenceEl) {
      const paneRect = pane.getBoundingClientRect();
      const sentenceRect = sentenceEl.getBoundingClientRect();

      if (sentenceRect.top < paneRect.top || sentenceRect.bottom > paneRect.bottom) {
        sentenceEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
}
