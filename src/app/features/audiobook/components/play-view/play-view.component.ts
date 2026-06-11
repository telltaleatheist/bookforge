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
  AVAILABLE_VOICES
} from '../../models/play.types';

/** A saved position in the stream (sentence-based, since there is no global timeline) */
interface StreamBookmark {
  name: string;
  chapterId: string;
  sentenceIndex: number;
  createdAt: number;
}

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
        <!-- Header bar (matches the Play player) -->
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
          @if (currentChapter()) {
            <span class="header-chapter">{{ currentChapter()!.title }}</span>
          }
          <div class="header-center">
            <span class="header-title">Stream preview</span>
            @if (isGenerating()) {
              <span class="generating-indicator">Generating…</span>
            }
          </div>
          <div class="header-right">
            <select
              class="voice-select"
              [ngModel]="selectedVoice()"
              (ngModelChange)="onVoiceChange($event)"
              [disabled]="isPlaying()"
              title="Voice"
            >
              @for (voice of voices; track voice.id) {
                <option [value]="voice.id">{{ voice.name }}</option>
              }
            </select>
            @if (isReady()) {
              <button class="btn-header-icon" (click)="endSession()" title="End TTS session">⏻</button>
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
              @if (bookmarks().length === 0) {
                <p class="bookmark-empty">No bookmarks yet. Click + to save current position.</p>
              } @else {
                @for (bm of bookmarks(); track bm.createdAt) {
                  <div class="bookmark-item">
                    <button class="bookmark-jump" (click)="jumpToBookmark(bm)">
                      <span class="bookmark-name">{{ bm.name }}</span>
                      <span class="bookmark-pos">#{{ bm.sentenceIndex + 1 }}</span>
                    </button>
                    <button class="bookmark-delete" (click)="deleteBookmark(bm)" title="Delete">✕</button>
                  </div>
                }
              }
            </div>
            <button class="bookmark-add" (click)="addBookmark()">+ Save current position</button>
          </div>
        }

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

        <!-- Progress through current chapter (sentence-based) -->
        <div class="progress-row">
          <div class="bar-progress">
            <div class="bar-progress-fill" [style.width.%]="progressPercent()"></div>
            <input
              type="range"
              class="bar-progress-slider"
              [min]="0"
              [max]="Math.max(totalSentences() - 1, 0)"
              [value]="currentSentenceIndex()"
              (change)="onProgressChange($event)"
              [disabled]="!currentChapter()"
            />
          </div>
          <span class="bar-percent">{{ Math.round(progressPercent()) }}%</span>
        </div>

        <!-- Position display (centered) -->
        <div class="time-row">
          @if (currentChapter()) {
            <span class="bar-time">
              Ch {{ currentChapterIndex() + 1 }}/{{ chapters().length }}
              · Sentence {{ currentSentenceIndex() + 1 }}/{{ totalSentences() }}
            </span>
          }
          @if (bookmarkStatus()) {
            <span class="bookmark-status">{{ bookmarkStatus() }}</span>
          }
        </div>

        <!-- Transport + speed on same line (matches the Play player) -->
        <div class="controls-row">
          <div class="transport-group">
            <button class="bar-btn" (click)="prevChapter()" [disabled]="!canGoPrevChapter()" title="Previous chapter">⏮</button>
            <button class="bar-btn" (click)="skipSentence(-1)" [disabled]="!currentChapter() || currentSentenceIndex() === 0" title="Back one sentence">⏪</button>
            @if (!isReady()) {
              <button class="start-btn" (click)="startSession()" [disabled]="chaptersLoading()">
                Start TTS Engine
              </button>
            } @else {
              <button class="bar-btn bar-btn-play" (click)="isPlaying() ? pause() : play()" [title]="isPlaying() ? 'Pause' : 'Play'">
                <span class="play-icon">{{ isPlaying() ? '⏸' : '▶' }}</span>
              </button>
              <button class="bar-btn" (click)="stop()" [disabled]="playbackState() === 'idle'" title="Stop">⏹</button>
            }
            <button class="bar-btn" (click)="skipSentence(1)" [disabled]="!currentChapter() || currentSentenceIndex() >= totalSentences() - 1" title="Forward one sentence">⏩</button>
            <button class="bar-btn" (click)="nextChapter()" [disabled]="!canGoNextChapter()" title="Next chapter">⏭</button>
          </div>
          <div class="speed-group">
            <button class="bar-btn bar-btn-bookmark" (click)="addBookmark()" title="Add bookmark">🔖</button>
            <input
              type="range"
              class="speed-slider"
              min="0.5"
              max="2"
              step="0.05"
              [value]="selectedSpeed()"
              (change)="onSpeedSlider($event)"
              title="TTS speed (applies from the current sentence)"
            />
            <span class="speed-value">{{ selectedSpeed().toFixed(2) }}x</span>
          </div>
        </div>

        <!-- Chapter drawer -->
        @if (chapterDrawerOpen()) {
          <div class="chapter-drawer">
            <div class="drawer-header">
              <h3>Chapters</h3>
              <button class="btn-close" (click)="chapterDrawerOpen.set(false)" title="Close">✕</button>
            </div>
            <div class="chapter-list">
              @for (chapter of chapters(); track chapter.id; let i = $index) {
                <button
                  class="chapter-item"
                  [class.active]="chapter.id === selectedChapterId()"
                  (click)="onChapterChange(chapter.id)"
                >
                  <span class="chapter-order">{{ i + 1 }}</span>
                  <div class="chapter-info">
                    <span class="chapter-title">{{ chapter.title }}</span>
                    <span class="chapter-meta">{{ chapter.sentences.length }} sentences</span>
                  </div>
                </button>
              }
            </div>
          </div>
        }
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
      position: relative;
      padding: 8px 16px 0;
    }

    .main-content.hidden {
      visibility: hidden;
    }

    /* Header bar (player style) */
    .player-header-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 0 8px;
      flex-shrink: 0;
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
      color: var(--accent, var(--accent-primary));
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      flex-shrink: 1;
      min-width: 0;
      padding: 3px 8px;
      background: color-mix(in srgb, var(--accent, var(--accent-primary)) 12%, transparent);
      border-radius: 4px;
    }

    .header-center {
      flex: 1;
      min-width: 0;
      text-align: center;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .header-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .generating-indicator {
      font-size: 11px;
      color: var(--accent-primary);
      animation: pulse 1s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .btn-header-icon {
      width: 30px;
      height: 30px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      color: var(--text-secondary);
      font-size: 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s;
      flex-shrink: 0;
    }

    .btn-header-icon:hover {
      background: var(--bg-hover, var(--surface-2));
      color: var(--text-primary);
    }

    .btn-header-icon.active {
      background: var(--accent, var(--accent-primary));
      border-color: var(--accent, var(--accent-primary));
      color: white;
    }

    .voice-select {
      padding: 5px 8px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      color: var(--text-primary);
      font-size: 12px;
      max-width: 160px;
    }

    .voice-select:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    /* Bookmark popup (player style) */
    .bookmark-popup {
      position: absolute;
      top: 42px;
      left: 16px;
      z-index: 20;
      width: 260px;
      background: var(--bg-elevated, var(--surface-1));
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
    }

    .bookmark-popup-close:hover {
      background: var(--bg-hover, var(--surface-2));
      color: var(--text-primary);
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
    }

    .bookmark-item:hover {
      background: var(--bg-hover, var(--surface-2));
    }

    .bookmark-item:hover .bookmark-delete {
      opacity: 1;
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

    .bookmark-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .bookmark-pos {
      color: var(--text-muted);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      margin-left: 8px;
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
    }

    .bookmark-delete:hover {
      color: var(--color-error, #ef4444);
    }

    .bookmark-add {
      border: none;
      border-top: 1px solid var(--border-subtle);
      background: transparent;
      color: var(--accent, var(--accent-primary));
      font-size: 12px;
      font-weight: 500;
      padding: 10px;
      cursor: pointer;
      border-radius: 0 0 8px 8px;
    }

    .bookmark-add:hover {
      background: var(--bg-hover, var(--surface-2));
    }

    /* Text pane */
    .text-pane {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 16px 16px 24px;
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

    /* Progress bar (player style, sentence-based) */
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
      background: color-mix(in srgb, var(--accent, var(--accent-primary)) 20%, transparent);
      border-radius: 3px;
      cursor: pointer;
      overflow: hidden;
    }

    .bar-progress-fill {
      height: 100%;
      background: var(--accent, var(--accent-primary));
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
      color: var(--accent, var(--accent-primary));
      animation: fadeIn 0.2s ease;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /* Transport row (player style) */
    .controls-row {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4px 0 10px;
      flex-shrink: 0;
      position: relative;
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
      background: var(--bg-hover, var(--surface-2));
      color: var(--text-primary);
      font-size: 12px;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: background 0.15s;
    }

    .bar-btn:hover:not(:disabled) {
      background: var(--bg-muted, var(--surface-2));
      filter: brightness(1.15);
    }

    .bar-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .bar-btn-play {
      width: 32px;
      height: 32px;
      background: var(--accent, var(--accent-primary));
      color: white;
      font-size: 13px;
    }

    .bar-btn-play .play-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      padding-left: 2px;
    }

    .bar-btn-play:hover {
      filter: brightness(1.1);
    }

    .start-btn {
      padding: 7px 18px;
      border: none;
      border-radius: 16px;
      background: var(--accent, var(--accent-primary));
      color: white;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }

    .start-btn:hover:not(:disabled) {
      filter: brightness(1.1);
    }

    .start-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .speed-group {
      position: absolute;
      right: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .bar-btn-bookmark {
      font-size: 11px;
    }

    .speed-slider {
      width: 90px;
      accent-color: var(--accent, var(--accent-primary));
    }

    .speed-value {
      font-size: 11px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      min-width: 38px;
    }

    /* Chapter drawer (player style) */
    .chapter-drawer {
      position: absolute;
      top: 42px;
      right: 16px;
      bottom: 90px;
      z-index: 20;
      width: 280px;
      background: var(--bg-elevated, var(--surface-1));
      border: 1px solid var(--border-default);
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .drawer-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .drawer-header h3 {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .btn-close {
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      cursor: pointer;
    }

    .btn-close:hover {
      background: var(--bg-hover, var(--surface-2));
      color: var(--text-primary);
    }

    .chapter-list {
      flex: 1;
      overflow-y: auto;
      padding: 4px;
    }

    .chapter-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: var(--text-primary);
      cursor: pointer;
      text-align: left;
      transition: background 0.15s;
    }

    .chapter-item:hover {
      background: var(--bg-hover, var(--surface-2));
    }

    .chapter-item.active {
      background: color-mix(in srgb, var(--accent, var(--accent-primary)) 18%, transparent);
    }

    .chapter-order {
      font-size: 11px;
      color: var(--text-muted);
      min-width: 18px;
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .chapter-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .chapter-title {
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .chapter-meta {
      font-size: 10px;
      color: var(--text-muted);
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
  readonly Math = Math;

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

  // Player chrome state
  readonly chapterDrawerOpen = signal(false);
  readonly bookmarkDrawerOpen = signal(false);
  readonly bookmarks = signal<StreamBookmark[]>([]);
  readonly bookmarkStatus = signal<string | null>(null);

  // Computed
  readonly canGoPrevChapter = computed(() => this.currentChapterIndex() > 0);
  readonly canGoNextChapter = computed(() =>
    this.currentChapterIndex() < this.chapters().length - 1
  );
  readonly totalSentences = computed(() => this.currentChapter()?.sentences.length ?? 0);
  readonly progressPercent = computed(() => {
    const total = this.totalSentences();
    if (total === 0) return 0;
    return ((this.currentSentenceIndex() + 1) / total) * 100;
  });

  // Private
  private generateAbortController?: AbortController;
  private unsubscribeSessionEnd?: () => void;
  private bookmarkStatusTimer?: ReturnType<typeof setTimeout>;

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
    this.loadBookmarks();

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
    if (this.bookmarkStatusTimer) clearTimeout(this.bookmarkStatusTimer);
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

    // Start fresh from the current position (sentence clicks / skips set it)
    const startIndex = Math.min(this.currentSentenceIndex(), Math.max(this.totalSentences() - 1, 0));
    this.audioPlayer.clearQueue();
    this.currentSentenceIndex.set(startIndex);

    // Start generating audio in background
    this.generateAndPlay(startIndex);
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

  /** Move to a sentence; if audio was active, regenerate from there. */
  private async jumpToSentence(index: number) {
    const total = this.totalSentences();
    if (total === 0) return;
    const clamped = Math.max(0, Math.min(index, total - 1));

    const wasActive = this.isPlaying() || this.isGenerating() || this.playbackState() === 'paused';
    this.generateAbortController?.abort();
    this.audioPlayer.stop();
    this.audioPlayer.clearQueue();
    this.isGenerating.set(false);

    this.currentSentenceIndex.set(clamped);
    this.scrollToSentence(clamped);

    if (wasActive && this.isReady()) {
      await this.audioPlayer.initialize();
      this.generateAndPlay(clamped);
    }
  }

  skipSentence(delta: number) {
    void this.jumpToSentence(this.currentSentenceIndex() + delta);
  }

  onProgressChange(event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    void this.jumpToSentence(value);
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

  /** Speed is a TTS generation setting — restart from the current sentence so it applies now. */
  onSpeedSlider(event: Event) {
    const newSpeed = Number((event.target as HTMLInputElement).value);
    if (newSpeed === this.selectedSpeed()) return;
    this.selectedSpeed.set(newSpeed);

    if (this.isPlaying() || this.isGenerating()) {
      void this.jumpToSentence(this.currentSentenceIndex());
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Bookmarks (sentence positions, persisted per EPUB)
  // ─────────────────────────────────────────────────────────────────────────────

  private bookmarkStorageKey(): string {
    return `bookforge-stream-bookmarks:${this.epubPath()}`;
  }

  private loadBookmarks() {
    try {
      const raw = localStorage.getItem(this.bookmarkStorageKey());
      this.bookmarks.set(raw ? JSON.parse(raw) : []);
    } catch {
      this.bookmarks.set([]);
    }
  }

  private saveBookmarks() {
    try {
      localStorage.setItem(this.bookmarkStorageKey(), JSON.stringify(this.bookmarks()));
    } catch { /* storage full/unavailable */ }
  }

  addBookmark() {
    const chapter = this.currentChapter();
    if (!chapter) return;
    const index = this.currentSentenceIndex();
    const bookmark: StreamBookmark = {
      name: `${chapter.title} · sentence ${index + 1}`,
      chapterId: chapter.id,
      sentenceIndex: index,
      createdAt: Date.now(),
    };
    this.bookmarks.update(list => [bookmark, ...list]);
    this.saveBookmarks();
    this.flashBookmarkStatus('Bookmark saved');
  }

  jumpToBookmark(bm: StreamBookmark) {
    if (!this.chapters().some(c => c.id === bm.chapterId)) return;
    this.stop();
    this.selectedChapterId.set(bm.chapterId);
    this.currentSentenceIndex.set(bm.sentenceIndex);
    this.bookmarkDrawerOpen.set(false);
    setTimeout(() => this.scrollToSentence(bm.sentenceIndex), 50);
  }

  deleteBookmark(bm: StreamBookmark) {
    this.bookmarks.update(list => list.filter(b => b.createdAt !== bm.createdAt));
    this.saveBookmarks();
  }

  private flashBookmarkStatus(message: string) {
    this.bookmarkStatus.set(message);
    if (this.bookmarkStatusTimer) clearTimeout(this.bookmarkStatusTimer);
    this.bookmarkStatusTimer = setTimeout(() => this.bookmarkStatus.set(null), 2000);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Sentence interaction
  // ─────────────────────────────────────────────────────────────────────────────

  onSentenceClick(sentence: PlayableSentence) {
    if (!this.isReady()) {
      // No session yet — just move the position marker
      this.currentSentenceIndex.set(sentence.index);
      return;
    }
    void this.jumpToSentence(sentence.index);
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
