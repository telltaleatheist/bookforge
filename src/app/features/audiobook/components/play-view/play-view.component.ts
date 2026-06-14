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
import { ElectronService, StreamSchedulerEvent } from '../../../../core/services/electron.service';
import { TtsServerService } from '../../../../core/services/tts-server.service';
import { EpubService } from '../../services/epub.service';
import { PlayTextService } from '../../services/play-text.service';
import { AudioPlayerService } from '../../services/audio-player.service';
import {
  PlayableChapter,
  PlaySettings,
  PlaybackState,
  SessionState
} from '../../models/play.types';

// Seconds of generated-but-unplayed audio that count as a full buffer ring. Matches
// the scheduler's in-app lookahead window (main.ts stream:start, lookaheadSeconds).
const BUFFER_TARGET_SECONDS = 45;

/** One selectable voice in the dropdown (from the main-process catalog). */
interface VoiceOption {
  id: string;
  name: string;
  group: string;
}

/** A saved position in the stream (sentence-based, since there is no global timeline) */
interface StreamBookmark {
  name: string;
  chapterId: string;
  sentenceIndex: number;
  createdAt: number;
}

/** One sentence in the flattened, whole-book view */
interface StreamCue {
  chapterId: string;
  chapterTitle: string;
  localIndex: number;   // sentence index within its chapter
  globalIndex: number;  // position in the whole book
  text: string;
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
            @if (!loadingError() && ttsServer.warmupPct() !== null) {
              <div class="warmup-bar">
                <div class="warmup-fill" [style.width.%]="ttsServer.warmupPct()"></div>
              </div>
              <p class="warmup-meta">{{ ttsServer.warmupPct() }}% · {{ warmElapsed() }}s elapsed</p>
            }
            @if (loadingError()) {
              <p class="loading-error">{{ loadingError() }}</p>
              <desktop-button variant="secondary" (click)="dismissError()">
                Dismiss
              </desktop-button>
            } @else {
              <desktop-button variant="secondary" (click)="cancelStartup()">
                Cancel
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
            <span class="header-title">{{ title() || 'Stream preview' }}</span>
            @if (author()) {
              <span class="header-author">{{ author() }}</span>
            }
            @if (isGenerating()) {
              <span class="generating-indicator">Generating…</span>
            } @else if (serverLoading()) {
              <span class="generating-indicator">{{ warmupLabel() }}</span>
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
              @for (g of voiceGroups(); track g.group) {
                <optgroup [label]="g.group">
                  @for (voice of g.voices; track voice.id) {
                    <option [value]="voice.id">{{ voice.name }}</option>
                  }
                </optgroup>
              }
            </select>
            <button
              class="btn-server"
              [class.running]="ttsServer.state() === 'running'"
              [class.warming]="ttsServer.state() === 'warming'"
              [disabled]="ttsServer.state() === 'starting' || ttsServer.state() === 'warming'"
              (click)="toggleServer()"
              [title]="ttsServer.state() === 'running' ? 'Shut down the TTS server' : 'Start the TTS server and keep it running (survives closing this window)'"
            >
              @switch (ttsServer.state()) {
                @case ('running') { ⏻ Quit server }
                @case ('starting') { Starting… }
                @case ('warming') {
                  @if (ttsServer.warmupPct() !== null) { Loading model {{ ttsServer.warmupPct() }}% }
                  @else { Loading model… }
                }
                @default { ⏻ Start server }
              }
            </button>
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

        <!-- Search bar -->
        <div class="search-bar">
          <input type="text" placeholder="Search text..."
            [value]="searchTerm()"
            (input)="searchTerm.set($any($event.target).value)" />
          @if (searchTerm()) {
            <button class="search-clear" (click)="searchTerm.set('')">&times;</button>
            <span class="search-count">{{ filteredCues().length }} / {{ allCues().length }}</span>
          }
        </div>

        <!-- Scrollable text: whole book, chapter headings inline -->
        <div class="text-container" #textPane>
          @if (chaptersLoading()) {
            <div class="loading-state">
              <div class="spinner"></div>
              <span>Loading book...</span>
            </div>
          } @else if (allCues().length === 0) {
            <div class="empty-state">
              <p>No readable text found</p>
            </div>
          } @else {
            @for (cue of filteredCues(); track cue.globalIndex) {
              @if (chapterHeaderMap().get(cue.globalIndex); as chapterTitle) {
                <div class="chapter-header">{{ chapterTitle }}</div>
              }
              <div
                class="text-segment"
                [class.active]="cue.globalIndex === currentGlobalIndex()"
                [class.past]="cue.globalIndex < currentGlobalIndex()"
                [attr.data-index]="cue.globalIndex"
                (click)="jumpToCue(cue)"
              >
                <p>{{ cue.text }}</p>
              </div>
            }
          }
        </div>

        <!-- Progress bar (full width, sentence-based) -->
        <div class="progress-row">
          <div class="bar-progress">
            <div class="bar-progress-fill" [style.width.%]="progressPercent()"></div>
            <input
              type="range"
              class="bar-progress-slider"
              [min]="0"
              [max]="Math.max(allCues().length - 1, 0)"
              [value]="currentGlobalIndex()"
              (change)="onProgressChange($event)"
              [disabled]="allCues().length === 0"
            />
          </div>
          <span class="bar-percent">{{ Math.round(progressPercent()) }}%</span>
        </div>

        <!-- Position display (centered) -->
        <div class="time-row">
          @if (allCues().length > 0) {
            <span class="bar-time">{{ currentGlobalIndex() + 1 }} / {{ allCues().length }}</span>
          }
          @if (bookmarkStatus()) {
            <span class="bookmark-status">{{ bookmarkStatus() }}</span>
          }
        </div>

        <!-- Transport + speed on same line (matches the Play player) -->
        <div class="controls-row">
          <div class="transport-group">
            <button class="bar-btn" (click)="skipSentence(-1)" [disabled]="currentGlobalIndex() === 0" title="Previous sentence">⏮</button>
            <button
              class="bar-btn bar-btn-play"
              [class.loading]="serverLoading() && !isPlaying()"
              (click)="isPlaying() ? pause() : onPlayClicked()"
              [disabled]="chaptersLoading()"
              [title]="serverLoading() && !isPlaying() ? 'Loading the voice model — playback starts once it finishes' : (isPlaying() ? 'Pause' : 'Play')"
            >
              @if (serverLoading() && !isPlaying()) {
                <span class="play-spinner"></span>
              } @else {
                <span class="play-icon">{{ isPlaying() ? '⏸' : '▶' }}</span>
              }
            </button>
            <button class="bar-btn" (click)="skipSentence(1)" [disabled]="currentGlobalIndex() >= allCues().length - 1" title="Next sentence">⏭</button>
            <span class="buffer-ring-wrap" [title]="bufferTitle()">
              <span class="buffer-ring" [style.background]="bufferRingBg()"></span>
            </span>
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
              (input)="onSpeedDrag($event)"
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
                  [class.active]="chapter.id === currentChapter()?.id"
                  (click)="onChapterSelect(chapter.id)"
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

    /* Warm-up progress: the model load that happens after the worker boots. */
    .warmup-bar {
      width: 100%;
      height: 6px;
      margin: 16px 0 6px;
      background: var(--bg-sunken, rgba(127, 127, 127, 0.2));
      border-radius: 3px;
      overflow: hidden;
    }

    .warmup-fill {
      height: 100%;
      background: var(--accent, var(--accent-primary));
      border-radius: 3px;
      transition: width 0.3s ease;
    }

    .warmup-meta {
      margin: 0;
      font-size: 11px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
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
      white-space: nowrap;
    }

    .header-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .header-author {
      font-size: 11px;
      color: var(--text-secondary);
      margin-left: 8px;
    }

    .header-author::before {
      content: '— ';
    }

    .generating-indicator {
      font-size: 11px;
      color: var(--accent-primary);
      margin-left: 10px;
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

    .btn-server {
      padding: 5px 12px;
      border: 1px solid var(--border-default);
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s;
      flex-shrink: 0;
    }

    .btn-server:hover:not(:disabled) {
      background: var(--bg-hover, var(--surface-2));
      color: var(--text-primary);
    }

    .btn-server.running {
      border-color: color-mix(in srgb, #22c55e 50%, transparent);
      background: color-mix(in srgb, #22c55e 10%, transparent);
      color: #22c55e;
    }

    .btn-server.warming {
      border-color: color-mix(in srgb, #f59e0b 50%, transparent);
      background: color-mix(in srgb, #f59e0b 10%, transparent);
      color: #f59e0b;
    }

    .btn-server:disabled {
      opacity: 0.6;
      cursor: wait;
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

    /* Search bar (player style) */
    .search-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      flex-shrink: 0;
    }

    .search-bar input {
      flex: 1;
      padding: 6px 10px;
      border: 1px solid var(--border-input, var(--border-default));
      border-radius: 6px;
      background: var(--bg-input, var(--surface-1));
      color: var(--text-primary);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }

    .search-bar input::placeholder {
      color: var(--text-muted);
    }

    .search-bar input:focus {
      border-color: var(--accent, var(--accent-primary));
    }

    .search-clear {
      width: 26px;
      height: 26px;
      border: none;
      border-radius: 50%;
      background: var(--bg-muted, var(--surface-2));
      color: var(--text-secondary);
      font-size: 15px;
      line-height: 1;
      cursor: pointer;
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .search-clear:hover {
      background: var(--bg-hover, var(--surface-2));
      color: var(--text-primary);
    }

    .search-count {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      flex-shrink: 0;
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

    /* Text container (player style: block segments, whole book) */
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
      color: var(--accent, var(--accent-primary));
      border-bottom: 1px solid var(--border-subtle);
      margin-bottom: 8px;
    }

    .chapter-header:first-child {
      margin-top: 0;
    }

    .text-segment {
      padding: 8px 12px;
      margin-bottom: 4px;
      border-radius: 6px;
      background: var(--bg-surface, var(--surface-1));
      border: 2px solid transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      opacity: 0.6;
    }

    .text-segment:hover {
      background: var(--bg-hover, var(--surface-2));
    }

    .text-segment.past {
      opacity: 0.4;
    }

    .text-segment.active {
      opacity: 1;
      border-color: var(--accent, var(--accent-primary));
      background: color-mix(in srgb, var(--accent, var(--accent-primary)) 8%, var(--bg-surface, var(--surface-1)));
    }

    .text-segment p {
      margin: 0;
      font-size: 15px;
      line-height: 1.6;
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

    /* Buffer "health" ring: conic fill over a dim track, hollowed by a radial mask
       (same look as the BookForge Reader extension's transport bar). */
    .buffer-ring-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
    }

    .buffer-ring {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      -webkit-mask: radial-gradient(circle, transparent 4.5px, #000 5px);
      mask: radial-gradient(circle, transparent 4.5px, #000 5px);
      transition: background 0.3s linear;
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
      width: 36px;
      height: 36px;
      background: var(--accent, var(--accent-primary));
      color: white;
      font-size: 14px;
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

    .bar-btn-play.loading {
      cursor: wait;
    }

    /* Spinner shown inside the play button while the voice model loads, so the
       transport itself signals "not ready yet" instead of a misleading ▶. */
    .play-spinner {
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.4);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
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
  readonly title = input<string>('');
  readonly author = input<string>('');

  // Services
  private readonly electronService = inject(ElectronService);
  private readonly epubService = inject(EpubService);
  private readonly playTextService = inject(PlayTextService);
  private readonly audioPlayer = inject(AudioPlayerService);
  readonly ttsServer = inject(TtsServerService);

  // View refs
  @ViewChild('textPane') textPane!: ElementRef<HTMLDivElement>;

  // Voice catalog (loaded from the main process; available before the engine
  // starts). Grouped into optgroups by voiceGroups().
  readonly voiceCatalog = signal<VoiceOption[]>([]);
  readonly voiceGroups = computed(() => {
    const order = ['Default', 'Fine-tuned', 'Voice Library'];
    const byGroup = new Map<string, VoiceOption[]>();
    for (const v of this.voiceCatalog()) {
      const bucket = byGroup.get(v.group);
      if (bucket) bucket.push(v);
      else byGroup.set(v.group, [v]);
    }
    const ordered: Array<{ group: string; voices: VoiceOption[] }> = [];
    for (const g of order) {
      const vs = byGroup.get(g);
      if (vs) ordered.push({ group: g, voices: vs });
    }
    for (const [g, vs] of byGroup) {
      if (!order.includes(g)) ordered.push({ group: g, voices: vs });
    }
    return ordered;
  });

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
  // Chapters are a display concept only — the stream is the whole book in one
  // global index space, so the current chapter is derived from the playhead.
  readonly currentCue = computed(() => this.allCues()[this.currentGlobalIndex()] ?? null);
  readonly currentChapter = computed(() => {
    const chapters = this.chapters();
    const cue = this.currentCue();
    if (!cue) return chapters[0] ?? null;
    return chapters.find(c => c.id === cue.chapterId) ?? null;
  });

  // Playback state
  readonly playbackState = signal<PlaybackState>('idle');
  readonly isPlaying = computed(() =>
    this.playbackState() === 'playing' || this.playbackState() === 'buffering'
  );
  readonly isGenerating = signal(false);
  readonly selectedVoice = signal<string>('ScarlettJohansson');
  readonly selectedSpeed = signal<number>(1.25);

  // The engine is spawning workers ('starting') or loading the voice model into
  // memory ('warming'). In both states it CANNOT generate yet, even though the
  // worker process is alive — so the play button must show a loading state, not
  // a ready ▶. Drives the spinner + header hint.
  readonly serverLoading = computed(() => {
    const s = this.ttsServer.state();
    return s === 'warming' || s === 'starting';
  });
  /** Seconds since the current warm-up started (shown in the loading modal). */
  readonly warmElapsed = signal(0);
  private warmTimer?: ReturnType<typeof setInterval>;

  /** Header hint while the engine is loading (with live percent when known). */
  readonly warmupLabel = computed(() => {
    const pct = this.ttsServer.warmupPct();
    return pct !== null ? `Loading voice model ${pct}%…` : 'Loading voice model…';
  });

  // Buffer-health ring: fills clockwise as decoded audio accumulates ahead of the
  // playhead. Scaled to the scheduler's 45s in-app lookahead window, so a full ring
  // means the generation window is topped up (no underrun risk); also full once
  // there's nothing left to generate.
  readonly bufferFillPct = computed(() => {
    if (this.audioPlayer.generationFinished()) return 100;
    return Math.round(Math.min(1, this.audioPlayer.bufferedAhead() / BUFFER_TARGET_SECONDS) * 100);
  });
  readonly bufferRingBg = computed(() =>
    `conic-gradient(#3ec46d ${this.bufferFillPct()}%, rgba(127, 127, 127, 0.25) 0)`
  );
  readonly bufferTitle = computed(() =>
    this.audioPlayer.generationFinished()
      ? 'Fully generated'
      : `Buffer: ${Math.round(this.audioPlayer.bufferedAhead())}s ready (${this.bufferFillPct()}%)`
  );
  /** Playhead position in the whole-book sentence space (same space the stream uses) */
  readonly currentGlobalIndex = signal<number>(0);

  // Player chrome state
  readonly chapterDrawerOpen = signal(false);
  readonly bookmarkDrawerOpen = signal(false);
  readonly bookmarks = signal<StreamBookmark[]>([]);
  readonly bookmarkStatus = signal<string | null>(null);
  readonly searchTerm = signal('');

  // Whole-book flattened view
  readonly allCues = computed<StreamCue[]>(() => {
    const cues: StreamCue[] = [];
    let global = 0;
    for (const chapter of this.chapters()) {
      for (const sentence of chapter.sentences) {
        cues.push({
          chapterId: chapter.id,
          chapterTitle: chapter.title,
          localIndex: sentence.index,
          globalIndex: global++,
          text: sentence.text,
        });
      }
    }
    return cues;
  });

  readonly filteredCues = computed<StreamCue[]>(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) return this.allCues();
    return this.allCues().filter(c => c.text.toLowerCase().includes(term));
  });

  /** First visible cue of each chapter → chapter title (for inline headings) */
  readonly chapterHeaderMap = computed<Map<number, string>>(() => {
    const map = new Map<number, string>();
    const seen = new Set<string>();
    for (const cue of this.filteredCues()) {
      if (!seen.has(cue.chapterId)) {
        seen.add(cue.chapterId);
        map.set(cue.globalIndex, cue.chapterTitle);
      }
    }
    return map;
  });

  /** Global index of the first sentence of each chapter */
  private readonly chapterStartIndex = computed<Map<string, number>>(() => {
    const map = new Map<string, number>();
    for (const cue of this.allCues()) {
      if (!map.has(cue.chapterId)) map.set(cue.chapterId, cue.globalIndex);
    }
    return map;
  });

  readonly progressPercent = computed(() => {
    const total = this.allCues().length;
    if (total === 0) return 0;
    return ((this.currentGlobalIndex() + 1) / total) * 100;
  });

  // Private
  /** Monotonic id for stream sessions; events from older sessions are ignored */
  private streamRequestId = 0;
  private unsubscribeStreamEvents?: () => void;
  private unsubscribeSessionEnd?: () => void;
  private bookmarkStatusTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    // Sync playback state from audio player
    effect(() => {
      const state = this.audioPlayer.playbackState();
      this.playbackState.set(state);
    });

    // Sync the global sentence index from the audio player; report the
    // playhead to the scheduler so the generation lookahead window advances
    effect(() => {
      const index = this.audioPlayer.currentSentenceIndex();
      if (index >= 0) {
        this.currentGlobalIndex.set(index);
        this.electronService.streamReportPlayhead(this.streamRequestId, index);
        this.scrollToCurrent();
      }
    });

    // Mirror the global engine state (single source of truth in the main
    // process). Covers engines started/stopped from any window — nav rail,
    // another listen window — and re-attachment after a renderer reload.
    effect(() => {
      const state = this.ttsServer.state();
      if (state === 'running' && this.sessionState() === 'inactive') {
        this.sessionState.set('ready');
      } else if (state === 'stopped' && this.sessionState() === 'ready') {
        this.sessionState.set('inactive');
      }
    });
  }

  ngOnInit() {
    this.loadChapters();
    this.loadBookmarks();
    void this.loadVoices();

    // Audio events from the main-process stream scheduler
    this.unsubscribeStreamEvents = this.electronService.onStreamEvent(
      (event) => this.handleStreamEvent(event)
    );

    // Handle session end from main process
    this.unsubscribeSessionEnd = this.electronService.onPlaySessionEnded(() => {
      this.sessionState.set('inactive');
      this.stop();
    });

    // No onPlaybackEnd handler: the whole book streams as one session, so
    // playback flows across chapter boundaries on its own. When the book
    // ends, the playhead stays put so a bookmark can still be added.
  }

  ngOnDestroy() {
    this.unsubscribeSessionEnd?.();
    this.unsubscribeStreamEvents?.();
    this.stopStreaming();
    this.audioPlayer.destroy();
    if (this.bookmarkStatusTimer) clearTimeout(this.bookmarkStatusTimer);
    this.stopWarmTimer();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Session management
  // ─────────────────────────────────────────────────────────────────────────────

  // Bumped to invalidate an in-flight startup (or voice switch) when the user cancels
  private startAttempt = 0;

  async startSession() {
    const attempt = ++this.startAttempt;
    this.showLoadingModal.set(true);
    this.loadingTitle.set('Starting TTS Engine');
    this.loadingMessage.set('Initializing...');
    this.loadingError.set(null);
    this.sessionState.set('starting');
    this.startWarmTimer();

    try {
      // Start the Python process
      this.loadingMessage.set('Starting Python process...');
      const startResult = await this.electronService.playStartSession();

      if (attempt !== this.startAttempt) {
        // Cancelled while starting — make sure any late-spawned process dies
        void this.electronService.playEndSession();
        return;
      }
      if (!startResult.success) {
        throw new Error(startResult.error || 'Failed to start session');
      }

      // Load the voice model into memory. This is the slow part — the worker
      // reports "ready" the instant Python boots, but the ~1.8 GB checkpoint
      // only loads here, so the warm-up progress bar tracks this step.
      this.loadingMessage.set('Loading the voice model into memory (first time is slowest)…');
      const voiceResult = await this.electronService.playLoadVoice(this.selectedVoice());

      if (attempt !== this.startAttempt) {
        void this.electronService.playEndSession();
        return;
      }
      if (!voiceResult.success) {
        throw new Error(voiceResult.error || 'Failed to load voice');
      }

      // Ready!
      this.sessionState.set('ready');
      this.showLoadingModal.set(false);
      this.stopWarmTimer();

    } catch (error) {
      if (attempt !== this.startAttempt) return; // cancelled — already handled
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.loadingError.set(message);
      this.loadingMessage.set('Failed to start TTS engine');
      this.sessionState.set('error');
      this.stopWarmTimer();
    }
  }

  /** Start ticking the warm-up elapsed counter shown in the loading modal. */
  private startWarmTimer() {
    this.warmElapsed.set(0);
    const t0 = Date.now();
    this.stopWarmTimer();
    this.warmTimer = setInterval(
      () => this.warmElapsed.set(Math.round((Date.now() - t0) / 1000)),
      250,
    );
  }

  private stopWarmTimer() {
    if (this.warmTimer) {
      clearInterval(this.warmTimer);
      this.warmTimer = undefined;
    }
  }

  /** Cancel a startup (or voice switch) in progress and shut the engine down. */
  async cancelStartup() {
    this.startAttempt++;  // invalidate whatever is in flight
    this.showLoadingModal.set(false);
    this.loadingError.set(null);
    this.sessionState.set('inactive');
    this.stopWarmTimer();
    try {
      await this.electronService.playEndSession();
    } catch { /* nothing was running yet */ }
  }

  dismissError() {
    this.showLoadingModal.set(false);
    this.loadingError.set(null);
    this.sessionState.set('inactive');
    this.stopWarmTimer();
  }

  /**
   * Start/stop the TTS server (separate from play/pause). Starting from here
   * pins the engine as a resident service — it survives closing this window.
   */
  async toggleServer() {
    if (this.ttsServer.state() === 'running') {
      this.stop();
      this.sessionState.set('inactive');
      await this.ttsServer.stop();
    } else if (this.ttsServer.state() === 'stopped') {
      await this.ttsServer.start(this.selectedVoice());
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Playback controls
  // ─────────────────────────────────────────────────────────────────────────────

  /** Play button: if the engine isn't running yet, start it first (modal flow). */
  async onPlayClicked() {
    if (!this.isReady()) {
      await this.startSession();
      if (!this.isReady()) return;  // failed or cancelled
    }
    await this.play();
  }

  async play() {
    if (!this.isReady() || this.allCues().length === 0) return;

    await this.audioPlayer.initialize();

    // If we're paused (with or without audio in queue), just resume
    if (this.playbackState() === 'paused') {
      this.audioPlayer.play();
      return;
    }

    // If generation is already running and we have audio, just play
    if (this.isGenerating() && this.audioPlayer.hasBufferedAudio()) {
      this.audioPlayer.play();
      return;
    }

    // Start fresh from the current position (sentence clicks / skips set it)
    const total = this.allCues().length;
    const startIndex = Math.min(this.currentGlobalIndex(), total - 1);
    this.currentGlobalIndex.set(startIndex);

    void this.startStreaming(startIndex);
  }

  pause() {
    // Audio player handles both playing and buffering states
    this.audioPlayer.pause();
  }

  stop() {
    this.stopStreaming();
    this.audioPlayer.clearQueue();
    this.currentGlobalIndex.set(0);
  }

  /** Move to a global position; if audio was active, regenerate from there. */
  private async jumpToGlobal(globalIndex: number) {
    const cues = this.allCues();
    if (cues.length === 0) return;
    const target = Math.max(0, Math.min(globalIndex, cues.length - 1));

    const wasActive = this.isPlaying() || this.isGenerating() || this.playbackState() === 'paused';
    this.stopStreaming();
    this.audioPlayer.clearQueue();

    this.currentGlobalIndex.set(target);
    this.scrollToCurrent();

    if (wasActive && this.isReady()) {
      await this.audioPlayer.initialize();
      void this.startStreaming(target);
    }
  }

  jumpToCue(cue: StreamCue) {
    void this.jumpToGlobal(cue.globalIndex);
  }

  skipSentence(delta: number) {
    void this.jumpToGlobal(this.currentGlobalIndex() + delta);
  }

  onProgressChange(event: Event) {
    const value = Number((event.target as HTMLInputElement).value);
    void this.jumpToGlobal(value);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Chapter navigation
  // ─────────────────────────────────────────────────────────────────────────────

  onChapterSelect(chapterId: string) {
    const start = this.chapterStartIndex().get(chapterId);
    if (start === undefined) return;
    this.chapterDrawerOpen.set(false);
    void this.jumpToGlobal(start);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Settings
  // ─────────────────────────────────────────────────────────────────────────────

  async onVoiceChange(voice: string) {
    this.selectedVoice.set(voice);

    if (this.isReady()) {
      const attempt = ++this.startAttempt;
      this.showLoadingModal.set(true);
      this.loadingTitle.set('Switching Voice');
      this.loadingMessage.set(`Loading ${voice}...`);
      this.loadingError.set(null);

      const result = await this.electronService.playLoadVoice(voice);

      if (attempt !== this.startAttempt) return; // cancelled — session was shut down

      if (result.success) {
        this.showLoadingModal.set(false);
      } else {
        this.loadingError.set(result.error || 'Failed to load voice');
        this.loadingMessage.set('Voice switch failed');
      }
    }
  }

  // The speed actually in effect for generation (vs. selectedSpeed, which also
  // updates live while dragging so the "x" label tracks the thumb).
  private appliedSpeed = 1.25;

  /** Live update while dragging — moves the displayed "x" with the thumb, but
   *  does NOT restart TTS (that would thrash on every drag tick). */
  onSpeedDrag(event: Event) {
    this.selectedSpeed.set(Number((event.target as HTMLInputElement).value));
  }

  /** On release: speed is a TTS generation setting — restart from the current
   *  sentence so it applies now. */
  onSpeedSlider(event: Event) {
    const newSpeed = Number((event.target as HTMLInputElement).value);
    this.selectedSpeed.set(newSpeed);
    if (newSpeed === this.appliedSpeed) return;
    this.appliedSpeed = newSpeed;

    if (this.isPlaying() || this.isGenerating()) {
      void this.jumpToGlobal(this.currentGlobalIndex());
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
    const cue = this.currentCue();
    if (!cue) return;
    const bookmark: StreamBookmark = {
      name: `${cue.chapterTitle} · sentence ${cue.localIndex + 1}`,
      chapterId: cue.chapterId,
      sentenceIndex: cue.localIndex,
      createdAt: Date.now(),
    };
    this.bookmarks.update(list => [bookmark, ...list]);
    this.saveBookmarks();
    this.flashBookmarkStatus('Bookmark saved');
  }

  jumpToBookmark(bm: StreamBookmark) {
    const start = this.chapterStartIndex().get(bm.chapterId);
    if (start === undefined) return;
    this.bookmarkDrawerOpen.set(false);
    void this.jumpToGlobal(start + bm.sentenceIndex);
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
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────────

  /** Load the voice catalog and keep the current selection valid. */
  private async loadVoices() {
    const result = await this.electronService.playGetVoices();
    if (!result.success || !result.voices?.length) return;

    this.voiceCatalog.set(result.voices);

    const ids = new Set(result.voices.map(v => v.id));
    if (!ids.has(this.selectedVoice())) {
      const preferred =
        result.voices.find(v => v.id === 'ScarlettJohansson') ||
        result.voices.find(v => v.group === 'Default') ||
        result.voices[0];
      this.selectedVoice.set(preferred.id);
    }
  }

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
    } catch (error) {
      console.error('Failed to load chapters:', error);
    } finally {
      this.chaptersLoading.set(false);
    }
  }

  /**
   * Start main-process generation from the given global sentence index. The
   * whole book is one stream — chapters are display-only — so the scheduler's
   * lookahead window flows across chapter boundaries with no gap. It only
   * generates ~45s ahead of the playhead, so a seek doesn't waste work on
   * text that won't be heard. The scheduler streams the first sentence
   * chunk-by-chunk and batches lookahead across the worker pool; audio comes
   * back via stream:event broadcasts.
   */
  private async startStreaming(startIndex: number) {
    const cues = this.allCues();
    if (cues.length === 0) return;

    const requestId = ++this.streamRequestId;
    const settings: PlaySettings = {
      voice: this.selectedVoice(),
      speed: this.selectedSpeed()
    };

    // Workers generate with whatever voice is loaded, not the one in settings.
    // No-ops when it already matches; covers engines started elsewhere (nav
    // rail service start) that were warmed with a different voice.
    const voiceResult = await this.electronService.playLoadVoice(settings.voice);
    if (!voiceResult.success) {
      console.error('[PlayView] Voice load failed:', voiceResult.error);
      return;
    }
    if (requestId !== this.streamRequestId) return;  // superseded while loading

    this.isGenerating.set(true);
    this.audioPlayer.beginStream(startIndex);

    const sentences = cues.map(c => c.text);
    const result = await this.electronService.streamStart(sentences, startIndex, settings, requestId);

    if (!result.success) {
      console.error('[PlayView] Failed to start stream:', result.error);
      if (requestId === this.streamRequestId) {
        this.isGenerating.set(false);
        this.audioPlayer.stop();
      }
    }
  }

  private handleStreamEvent(event: StreamSchedulerEvent) {
    if (event.requestId !== this.streamRequestId) return;  // stale session

    switch (event.kind) {
      case 'chunk':
        this.audioPlayer.addChunk(event.sentenceIndex!, event.data!, event.sampleRate ?? 24000);
        break;
      case 'done':
        this.audioPlayer.markSentenceDone(event.sentenceIndex!);
        break;
      case 'failed':
        console.warn('[PlayView] Sentence failed:', event.sentenceIndex, event.error);
        this.audioPlayer.markSentenceFailed(event.sentenceIndex!);
        break;
      case 'complete':
        this.isGenerating.set(false);
        this.audioPlayer.generationComplete();
        break;
    }
  }

  /** Invalidate the current stream session (events become stale) and stop generation. */
  private stopStreaming() {
    this.streamRequestId++;
    this.isGenerating.set(false);
    void this.electronService.streamStop();
  }

  /**
   * Keep the sentence being read centered in the text pane, following it as
   * playback advances. Scrolls only the pane — never an ancestor: the old
   * el.scrollIntoView() walked every scrollable ancestor, which yanked the
   * whole view to the top whenever a clicked sentence sat partly off-screen.
   */
  private scrollToCurrent() {
    if (!this.textPane) return;

    const pane = this.textPane.nativeElement;
    const el = pane.querySelector(`[data-index="${this.currentGlobalIndex()}"]`) as HTMLElement | null;
    if (!el) return;

    // Element's top within the pane's scroll content, then back off by half the
    // leftover height so it lands centered.
    const elTopInPane =
      el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
    const target = elTopInPane - (pane.clientHeight - el.clientHeight) / 2;
    const maxScroll = pane.scrollHeight - pane.clientHeight;

    pane.scrollTo({
      top: Math.max(0, Math.min(target, maxScroll)),
      behavior: 'smooth'
    });
  }
}
