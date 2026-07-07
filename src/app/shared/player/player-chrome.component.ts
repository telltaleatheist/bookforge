import {
  ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect,
  input, output, signal, viewChild, OnDestroy,
} from '@angular/core';
import { IconComponent } from '../icon.component';

/** One line of synced text (a VTT cue or a streamed sentence). */
export interface ChromeCue { index: number; text: string; }
/** A chapter row for the chapters sheet + nav pill. */
export interface ChromeChapter { id: string; title: string; label: string; }
/** A saved bookmark row. */
export interface ChromeBookmark { id: string; title: string; sub: string; }

/**
 * PlayerChromeComponent — the shared "web player" surface used by BOTH desktop
 * players (finished-audiobook and live-TTS stream). It owns the entire visual
 * language ported from the bookshelf web player: topbar, Sentences/Cover toggle,
 * segment-card transcript with follow-scroll, a big round transport, a rich
 * scrubber (accent fill + chapter notches), a speed sheet, a sleep timer
 * (button + sheet + full-screen countdown), and chapters/bookmarks bottom sheets.
 *
 * It is purely presentational: every unit-specific concern (audio SECONDS vs
 * sentence INDEX) is normalized by the host via inputs (scrubMin/Max/Value,
 * heardPercent, labels) and reported back via outputs (seek, skip, pickCue…).
 * Host-specific chrome (version pills, voice picker, TTS-server button, buffer
 * ring, search bar) is projected through named content slots so neither player
 * loses functionality:
 *   [player-topbar-left] [player-topbar-right] [player-status] [player-above-list]
 */
@Component({
  selector: 'app-player-chrome',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="player">
      <header class="topbar">
        <div class="topbar-slot left"><ng-content select="[player-topbar-left]" /></div>
        <div class="topbar-spacer"></div>
        <div class="topbar-slot right"><ng-content select="[player-topbar-right]" /></div>
      </header>

      <!-- Title/author on their own centered line under the bar (was in the bar);
           the Sentences/Cover switch moved down to the control row. -->
      <div class="title-row">
        <div class="t-title">{{ title() || 'Player' }}</div>
        @if (author()) { <div class="t-author">{{ author() }}</div> }
      </div>

      <div class="status-slot"><ng-content select="[player-status]" /></div>

      <div class="above-list-slot"><ng-content select="[player-above-list]" /></div>

      <div class="player-body">
        @if (sleepModeOpen()) {
          <div class="sleep-screen">
            <button class="sleep-show-text" (click)="sleepModeOpen.set(false)">Show text</button>
            <div class="sleep-main">
              <div class="sleep-count">{{ fmt(sleepRemaining()) }}</div>
              <div class="sleep-sub">{{ sleepMode() === 'chapter' ? 'until end of chapter' : 'until playback stops' }}</div>
              @if (sleepMode() === 'timer') {
                <div class="sleep-circles">
                  <button class="sleep-circle" (click)="addSleepMinutes(-15)"><span class="c-big">−15</span><span class="c-sm">min</span></button>
                  <button class="sleep-circle" (click)="addSleepMinutes(15)"><span class="c-big">+15</span><span class="c-sm">min</span></button>
                </div>
              }
            </div>
            <button class="sleep-cancel" (click)="cancelSleep()">Cancel timer</button>
          </div>
        } @else if (showText()) {
          <div class="text-area" #textArea [class.no-follow]="!followText()"
               (wheel)="onUserScroll()" (touchmove)="onUserScroll()">
            @for (cue of renderedCues(); track cue.index) {
              @if (chapterStartMap().get(cue.index); as chapterTitle) {
                <div class="chapter-header">{{ chapterTitle }}</div>
              }
              <div class="segment"
                   [class.active]="cue.index === activeIndex()"
                   [class.past]="cue.index < activeIndex()"
                   [attr.data-index]="cue.index"
                   (click)="pickCue.emit(cue.index)">
                <p>{{ cue.text }}</p>
              </div>
            }
          </div>
        } @else {
          <div class="no-text cover-area">
            @if (coverSrc(); as src) { <img class="big-cover" [src]="src" alt="Cover" /> }
            @else { <div class="cover-placeholder">🎧</div> }
          </div>
        }

        <div class="controls">
          @if (chapters().length > 0) {
            <div class="chapter-nav">
              <button class="ch-arrow" (click)="prevChapter.emit()" [disabled]="!canPrevChapter()" title="Previous chapter"><app-icon name="chevron-left" [size]="24" /></button>
              <button class="now-chapter" (click)="chaptersOpen.set(true)" title="Chapters"><span class="nc-label">{{ currentChapterTitle() }}</span><app-icon name="chevron-down" [size]="14" /></button>
              <button class="ch-arrow" (click)="nextChapter.emit()" [disabled]="!canNextChapter()" title="Next chapter"><app-icon name="chevron-right" [size]="24" /></button>
            </div>
          }

          <div class="scrub">
            <div class="scrub-track"><span class="heard-seg" [style.width.%]="heardPercent()"></span></div>
            @for (n of chapterNotches(); track $index) {
              <span class="notch" [style.left.%]="n"></span>
            }
            <input class="scrubber bare" type="range" [min]="scrubMin()" [max]="scrubMax()" step="1"
                   [value]="scrubValue()" [disabled]="scrubDisabled()"
                   (input)="onScrubInput($event)" (change)="onScrubCommit($event)" />
            <!-- Position dot painted above the chapter notches (native thumb hidden).
                 z-index 3 > notch z-index 2 so a notch never cuts through it. -->
            <span class="scrub-dot" [style.left.%]="scrubPercent()"></span>
          </div>
          <div class="scrub-labels">
            <span class="time">{{ leftLabel() }}</span>
            @if (centerLabel()) { <span class="ch-count">{{ centerLabel() }}</span> }
            <span class="time">{{ rightLabel() }}</span>
          </div>

          <div class="transport" [class.grid5]="skipKind() === 'time10'">
            @if (skipKind() === 'time10') {
              <button class="t-btn skip-btn min" (click)="skipBig.emit('back')" [disabled]="!canSkipBack()" title="Back 5 min">
                <app-icon name="replay" [size]="30" /><span class="skip-num">5m</span>
              </button>
            }
            <button class="t-btn skip-btn" (click)="skip.emit('back')" [disabled]="!canSkipBack()" [title]="skipKind() === 'time10' ? 'Back 10s' : 'Previous'">
              @if (skipKind() === 'time10') { <app-icon name="replay" [size]="30" /><span class="skip-num">10</span> }
              @else { <app-icon name="prev" [size]="28" /> }
            </button>
            <button class="t-btn play" (click)="togglePlay.emit()" [title]="isPlaying() ? 'Pause' : 'Play'">
              @if (busy()) { <span class="btn-spin"></span> }
              @else { <app-icon [name]="isPlaying() ? 'pause' : 'play'" [size]="30" /> }
            </button>
            <button class="t-btn skip-btn" [class.fwd]="skipKind() === 'time10'" (click)="skip.emit('forward')" [disabled]="!canSkipForward()" [title]="skipKind() === 'time10' ? 'Forward 10s' : 'Next'">
              @if (skipKind() === 'time10') { <app-icon name="replay" [size]="30" /><span class="skip-num">10</span> }
              @else { <app-icon name="next" [size]="28" /> }
            </button>
            @if (skipKind() === 'time10') {
              <button class="t-btn skip-btn min fwd" (click)="skipBig.emit('forward')" [disabled]="!canSkipForward()" title="Forward 5 min">
                <app-icon name="replay" [size]="30" /><span class="skip-num">5m</span>
              </button>
            }
          </div>

          <div class="tool-row" [class.grid5]="skipKind() === 'time10'">
            <button class="tool speed-pill" (click)="speedOpen.set(true)" title="Playback speed">{{ speedLabel() }}</button>
            <button class="tool" [class.on]="bookmarksOpen()" (click)="bookmarksOpen.set(!bookmarksOpen())" title="Bookmarks"><app-icon name="bookmark" [size]="18" /></button>
            <button class="tool" [class.on]="sleepActive()" (click)="onTimerButton()" title="Sleep timer">
              @if (sleepActive()) { <span class="tool-count">{{ fmt(sleepRemaining()) }}</span> }
              @else { <app-icon name="timer" [size]="18" /> }
            </button>
            <!-- Follow + Sentences are ALWAYS rendered — disabled (not hidden) when
                 the book has no synced text. Hiding them would drop the bug out of
                 sight and collapse the 5-column control grid; an audio-only book
                 shows them greyed out instead of missing. -->
            <button class="tool" [class.on]="followText()" [disabled]="!hasText()"
                    (click)="toggleFollow()"
                    [title]="!hasText() ? 'No synced text for this audiobook' : (followText() ? 'Following text' : 'Follow text')">
              <app-icon name="follow" [size]="18" />
            </button>
            <!-- Sentences toggle: on = transcript, off = cover. Enabled whenever the
                 book has text (mirrors the web/iOS player); toggling with no cover
                 art just falls back to the placeholder. -->
            <button class="tool" [class.on]="showText()" [disabled]="!hasText()"
                    (click)="setViewMode(showText() ? 'cover' : 'text')"
                    [title]="!hasText() ? 'No synced text for this audiobook' : (showText() ? 'Showing sentences — tap for cover' : 'Show sentences')">
              <app-icon name="article" [size]="18" />
            </button>
          </div>
        </div>
      </div>

      @if (chaptersOpen()) {
        <div class="sheet-backdrop" (click)="chaptersOpen.set(false)"></div>
        <div class="sheet">
          <div class="sheet-head"><span>Chapters</span><button class="icon-btn sm" (click)="chaptersOpen.set(false)">✕</button></div>
          <div class="sheet-body">
            @for (ch of chapters(); track ch.id; let i = $index) {
              <button class="row-item" [class.active]="ch.id === currentChapterId()" (click)="onPickChapter(ch.id)">
                <span class="row-num">{{ i + 1 }}</span>
                <span class="row-title">{{ ch.title }}</span>
                <span class="row-time">{{ ch.label }}</span>
              </button>
            } @empty {
              <p class="sheet-empty">No chapters.</p>
            }
          </div>
        </div>
      }

      @if (bookmarksOpen()) {
        <div class="sheet-backdrop" (click)="bookmarksOpen.set(false)"></div>
        <div class="sheet">
          <div class="sheet-head"><span>Bookmarks</span><button class="icon-btn sm" (click)="bookmarksOpen.set(false)">✕</button></div>
          <div class="sheet-body">
            @for (bm of bookmarks(); track bm.id) {
              <div class="row-item bm">
                <button class="bm-jump" (click)="onPickBookmark(bm.id)">
                  <span class="bm-auto"><app-icon name="bookmark" [size]="14" /></span>
                  <span class="bm-text">
                    <span class="row-title">{{ bm.title }}</span>
                    @if (bm.sub) { <span class="bm-when">{{ bm.sub }}</span> }
                  </span>
                </button>
                <button class="bm-del" (click)="deleteBookmark.emit(bm.id)" title="Delete">✕</button>
              </div>
            } @empty {
              <p class="sheet-empty">No bookmarks yet.</p>
            }
          </div>
          <button class="sheet-action" (click)="addBookmark.emit()">+ Bookmark this spot</button>
        </div>
      }

      @if (speedOpen()) {
        <div class="sheet-backdrop" (click)="speedOpen.set(false)"></div>
        <div class="sheet">
          <div class="sheet-head"><span>Playback speed</span><button class="icon-btn sm" (click)="speedOpen.set(false)">✕</button></div>
          <div class="sheet-body pad">
            <div class="ctl-head"><span class="ctl-title">Speed</span><span class="ctl-val">{{ speedLabel() }}</span></div>
            <input class="speed-slider wide" type="range" [min]="speedMin()" [max]="speedMax()" step="0.05"
                   [value]="displaySpeed() ?? speed()" (input)="onSpeedInput($event)" (change)="onSpeedCommit($event)" />
            <div class="preset-row">
              <button class="round-btn" (click)="bumpSpeed(-0.05)" title="Slower"><app-icon name="minus" [size]="18" /></button>
              <div class="preset-grid">
                @for (p of speedPresets(); track p) {
                  <button class="preset" [class.on]="isSpeed(p)" (click)="setPreset(p)">{{ p }}×</button>
                }
              </div>
              <button class="round-btn" (click)="bumpSpeed(0.05)" title="Faster"><app-icon name="plus" [size]="18" /></button>
            </div>
          </div>
        </div>
      }

      @if (timerOpen()) {
        <div class="sheet-backdrop" (click)="timerOpen.set(false)"></div>
        <div class="timer-sheet" role="dialog" aria-label="Sleep timer">
          <div class="sheet-grabber"></div>
          <div class="ts-title">Sleep Timer</div>
          @if (chapterRemaining() !== null) {
            <button class="ts-eoc" (click)="startEndOfChapter()">
              <span class="ts-eoc-icon"><app-icon name="moon" [size]="18" /></span>
              <span class="ts-eoc-label">End of chapter</span>
              <app-icon name="chevron-right" [size]="18" />
            </button>
          }
          <div class="ts-chips">
            @for (m of presets; track m) {
              <button class="ts-chip" (click)="startTimer(m)"><span class="ts-chip-num">{{ m }}</span><span class="ts-chip-unit">min</span></button>
            }
          </div>
          <div class="ts-custom">
            <button class="ts-step" (click)="stepCustom(-5)" [disabled]="customMinutes() <= 5" aria-label="Less"><app-icon name="minus" [size]="20" /></button>
            <div class="ts-custom-mid"><span class="ts-custom-val">{{ customLabel() }}</span><span class="ts-custom-cap">Custom</span></div>
            <button class="ts-step" (click)="stepCustom(5)" [disabled]="customMinutes() >= 480" aria-label="More"><app-icon name="plus" [size]="20" /></button>
          </div>
          <button class="ts-start" (click)="startTimer(customMinutes())">Start Timer</button>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { display: flex; flex-direction: column; flex: 1; min-height: 0; height: 100%; }
    .player {
      /* Match the bookshelf web / iOS player palette (iOS systemIndigo) instead of
         the desktop app's cyan theme, so the player looks identical across desktop,
         web, and phone. These custom properties cascade to everything inside the
         player — including the projected controls. Default is Midnight (seamless
         pure black: base == surface, panels melt into the body); light below. */
      --accent: #5e5ce6;
      --accent-primary: #5e5ce6;
      --accent-hover: #7d7aff;
      --bg-base: #000000;
      --bg-surface: #000000;
      --bg-elevated: #161618;
      --bg-hover: #232325;
      --text-primary: #ffffff;
      --text-secondary: rgba(235, 235, 245, 0.6);
      --text-tertiary: rgba(235, 235, 245, 0.42);
      --text-muted: rgba(235, 235, 245, 0.42);
      --border-default: rgba(84, 84, 88, 0.55);
      --border-subtle: rgba(84, 84, 88, 0.6);
      --border-strong: rgba(84, 84, 88, 0.9);
      --border-input: transparent;
      --bg-input: rgba(118, 118, 128, 0.24);
      --error: #ff453a;
      /* One surface color throughout (top bar, body, controls) so the panel is
         seamless and the transcript edge-fade reveals that same color — black in
         Midnight, white in Light — not the theme's (different) base as a band. */
      position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; overflow: hidden; background: var(--bg-surface); color: var(--text-primary);
    }
    :host-context([data-theme='light']) .player {
      --accent: #5856d6;
      --accent-primary: #5856d6;
      --accent-hover: #6d6ae8;
      --bg-base: #f2f2f7;
      --bg-surface: #ffffff;
      /* Elevated must stay off-white now that the panel itself is white (surface),
         or tool chips + the scrub track would disappear into it. */
      --bg-elevated: #e8e8ed;
      --bg-hover: #dcdce1;
      --text-primary: #000000;
      --text-secondary: rgba(60, 60, 67, 0.6);
      --text-tertiary: rgba(60, 60, 67, 0.42);
      --text-muted: rgba(60, 60, 67, 0.42);
      --border-default: rgba(60, 60, 67, 0.29);
      --border-subtle: rgba(60, 60, 67, 0.29);
      --border-strong: rgba(60, 60, 67, 0.5);
      --bg-input: rgba(118, 118, 128, 0.12);
      --error: #ff3b30;
    }

    /* No border-bottom: the top stack (bar -> title -> body) is divider-free so it
       reads as one surface (seamless in Midnight, where surface == base). */
    .topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0; padding: 8px; background: var(--bg-surface); }
    .topbar-slot { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .topbar-spacer { flex: 1; min-width: 0; }
    .title-row { flex-shrink: 0; padding: 2px 12px 8px; text-align: center; background: var(--bg-surface); }
    .t-title { font-size: 15px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t-author { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .status-slot:empty, .above-list-slot:empty, .topbar-slot:empty { }
    .above-list-slot { flex-shrink: 0; }

    .player-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }

    /* Transcript scroll region. Top/bottom edges fade to transparent (revealing the
       seamless surface behind) so lines dissolve in/out instead of a hard cut. The
       mask is fixed to the box, so rows scroll under it. */
    .text-area { flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 12px 22px; scroll-behavior: smooth;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.12) 24px, rgba(0,0,0,0.5) 56px, #000 96px, #000 calc(100% - 96px), rgba(0,0,0,0.5) calc(100% - 56px), rgba(0,0,0,0.12) calc(100% - 24px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.12) 24px, rgba(0,0,0,0.5) 56px, #000 96px, #000 calc(100% - 96px), rgba(0,0,0,0.5) calc(100% - 56px), rgba(0,0,0,0.12) calc(100% - 24px), transparent 100%); }
    .chapter-header { padding: 18px 6px 8px; font-size: 15px; font-weight: 700; color: var(--accent); border-bottom: 1px solid var(--border-subtle); margin-bottom: 8px; }
    .chapter-header:first-child { padding-top: 4px; }
    .segment { padding: 10px 12px; margin-bottom: 6px; border-radius: 8px; background: var(--bg-surface); border: 2px solid transparent;
      cursor: pointer; transition: opacity 0.7s ease, border-color 0.3s ease, background 0.3s ease; opacity: 0.62; }
    .segment:hover { background: var(--bg-hover); }
    .segment.past { opacity: 0.4; }
    .segment.active { opacity: 1; border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
    .text-area.no-follow .segment { opacity: 1; }
    .segment p { margin: 0; font-size: 16px; line-height: 1.6; color: var(--text-primary); }

    /* Cover view: locked to the visible area, NEVER scrolls (overflow hidden), and
       carries no fade mask — the artwork stays crisp and fills the space. */
    .cover-area { overflow: hidden; }
    .no-text { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 16px; }
    .big-cover { border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); background: var(--bg-elevated); max-width: 100%; max-height: 100%; width: auto; height: auto; min-height: 0; flex: 0 1 auto; object-fit: contain; }
    .cover-placeholder { font-size: 96px; opacity: 0.35; user-select: none; }

    /* No border-top: controls share the surface and fade in from the body. */
    .controls { flex-shrink: 0; padding: 10px 16px 12px; background: var(--bg-surface); }

    .chapter-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .ch-arrow { flex-shrink: 0; width: 34px; height: 34px; border: none; border-radius: 50%; background: transparent; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .ch-arrow:disabled { opacity: 0.28; }
    .now-chapter { min-width: 0; max-width: 62%; display: flex; align-items: center; gap: 6px; margin: 0; padding: 5px 14px; border: none; border-radius: 15px;
      background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 13px; font-weight: 600; cursor: pointer; }
    .nc-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .scrub { position: relative; display: flex; align-items: center; height: 22px; }
    .scrub-track { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden; pointer-events: none; }
    .heard-seg { position: absolute; left: 0; top: 0; bottom: 0; background: var(--accent); }
    .notch { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 2px; height: 4px; background: var(--bg-surface); pointer-events: none; z-index: 2; }
    .scrubber.bare { position: relative; z-index: 1; background: transparent; }
    .scrubber.bare::-webkit-slider-runnable-track { background: transparent; }
    .scrubber.bare::-moz-range-track { background: transparent; }
    /* Native thumb hidden (still draggable); .scrub-dot is the visible indicator. */
    .scrubber.bare::-webkit-slider-thumb { background: transparent; box-shadow: none; }
    .scrubber.bare::-moz-range-thumb { background: transparent; box-shadow: none; }
    .scrub-dot { position: absolute; top: 50%; width: 15px; height: 15px; border-radius: 50%; background: var(--accent);
      transform: translate(-50%, -50%); box-shadow: 0 0 0 2px var(--bg-surface), 0 1px 3px rgba(0,0,0,0.5); pointer-events: none; z-index: 3; }
    .scrubber { -webkit-appearance: none; appearance: none; width: 100%; display: block; height: 4px; border-radius: 2px; outline: none; cursor: pointer; }
    .scrubber:disabled { cursor: default; }
    .scrubber::-webkit-slider-thumb { -webkit-appearance: none; width: 15px; height: 15px; margin-top: -5.5px; border-radius: 50%; background: var(--accent); border: none; box-shadow: 0 0 0 2px var(--bg-surface), 0 1px 3px rgba(0,0,0,0.5); }
    .scrubber::-moz-range-thumb { width: 15px; height: 15px; border: none; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg-surface); }

    .scrub-labels { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
    .ch-count { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; }
    .time { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; min-width: 44px; }

    /* 5-button transport (time players) + tool row share a 5-column grid so each
       tool lines up under its transport button. On the 3-button (sentence) players
       there's no .grid5, so it stays centered flex. */
    .transport { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 14px 0 8px; max-width: 340px; margin-left: auto; margin-right: auto; }
    .transport.grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; justify-items: center; }
    .t-btn { position: relative; min-width: 52px; width: 52px; height: 52px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .t-btn:disabled { opacity: 0.3; cursor: default; }
    /* Outer ±5-minute buttons: same size as the ±10s (just a muted color); the "5m"
       label is shrunk to fit the glyph (the 'm' is wider than "10"). */
    .t-btn.min { color: var(--text-secondary); }
    .skip-num { position: absolute; top: 54%; left: 50%; transform: translate(-50%, -50%); font-size: 10px; font-weight: 700; pointer-events: none; }
    .t-btn.min .skip-num { font-size: 7.5px; letter-spacing: -0.2px; }
    .t-btn.fwd app-icon { transform: scaleX(-1); }
    .t-btn.play { width: 64px; height: 64px; background: var(--accent); color: #fff; }
    .btn-spin { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.35); border-top-color: #fff; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .tool-row { display: flex; align-items: center; justify-content: space-around; gap: 8px; margin: 10px auto 0; max-width: 340px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
    .tool-row.grid5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; justify-items: center; }
    .tool { flex-shrink: 0; width: 46px; height: 46px; padding: 0; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; }
    .tool.on { background: var(--accent); color: #fff; }
    .tool:disabled { opacity: 0.3; cursor: default; }
    .tool.speed-pill { font-variant-numeric: tabular-nums; }
    .tool-count { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }

    /* Sleep screen */
    .sleep-screen { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
    .sleep-show-text { position: absolute; top: 8px; right: 10px; z-index: 1; border: none; background: transparent; color: var(--text-tertiary); font-size: 12px; cursor: pointer; padding: 6px 8px; }
    .sleep-main { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: clamp(14px, 4vmin, 30px); }
    .sleep-count { font-size: clamp(44px, 13vmin, 74px); font-weight: 200; font-variant-numeric: tabular-nums; color: var(--text-primary); letter-spacing: -2px; line-height: 1; }
    .sleep-sub { font-size: 13px; color: var(--text-tertiary); margin-top: -10px; }
    .sleep-circles { display: flex; gap: clamp(16px, 6vmin, 44px); }
    .sleep-circle { width: clamp(92px, 22vmin, 140px); height: clamp(92px, 22vmin, 140px); border-radius: 50%; border: none; background: var(--accent); color: #fff; cursor: pointer;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; box-shadow: 0 12px 34px -8px color-mix(in srgb, var(--accent) 70%, transparent); }
    .sleep-circle:active { transform: scale(0.97); }
    .sleep-circle .c-big { font-size: clamp(26px, 8vmin, 40px); font-weight: 700; line-height: 1; }
    .sleep-circle .c-sm { font-size: 13px; opacity: 0.85; }
    .sleep-cancel { flex-shrink: 0; width: min(360px, 92%); margin: 0 auto 6px; padding: 15px; border-radius: 16px; border: 1px solid var(--border-strong); background: var(--bg-elevated); color: var(--text-secondary); font-size: 15px; font-weight: 600; cursor: pointer; }
    .sleep-cancel:active { background: var(--bg-hover); }

    /* Bottom sheets */
    .icon-btn.sm { width: 30px; height: 30px; font-size: 14px; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
    .sheet-backdrop { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,0.5); }
    .sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 11; max-height: 72%; display: flex; flex-direction: column; background: var(--bg-elevated); border-radius: 16px 16px 0 0; animation: sheetUp 0.2s ease-out; }
    @keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
    .sheet-body { overflow-y: auto; overscroll-behavior: contain; padding: 6px; }
    .sheet-body.pad { padding: 16px 18px 12px; }
    .sheet-empty { padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 13px; }
    .sheet-action { margin: 4px 10px 10px; padding: 12px; border: 1px solid var(--accent); border-radius: 10px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 14px; font-weight: 600; cursor: pointer; }
    .row-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .row-item:hover { background: var(--bg-hover); }
    .row-item.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
    .row-item.bm { padding: 0; }
    .bm-jump { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .bm-auto { flex-shrink: 0; display: inline-flex; color: var(--accent); }
    .bm-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .bm-when { font-size: 11px; color: var(--text-tertiary); }
    .bm-del { flex-shrink: 0; width: 36px; height: 36px; margin-right: 6px; border: none; background: transparent; color: var(--text-tertiary); font-size: 13px; cursor: pointer; border-radius: 8px; }
    .bm-del:hover { color: var(--error); }
    .row-num { flex-shrink: 0; width: 24px; font-size: 12px; color: var(--text-tertiary); text-align: right; }
    .row-title { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-time { flex-shrink: 0; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }

    /* Speed sheet */
    .ctl-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
    .ctl-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
    .ctl-val { font-size: 15px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
    .speed-slider { -webkit-appearance: none; appearance: none; height: 4px; background: var(--bg-hover); border-radius: 2px; outline: none; cursor: pointer; }
    .speed-slider.wide { width: 100%; display: block; }
    .speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 18px; height: 18px; border-radius: 50%; background: var(--accent); border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
    .speed-slider::-moz-range-thumb { width: 18px; height: 18px; border: none; border-radius: 50%; background: var(--accent); }
    .preset-row { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
    /* 8 presets (1×–2.75×) in two rows of four, flanked by the ± fine-adjust buttons. */
    .preset-grid { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .preset { height: 40px; border: none; border-radius: 20px; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .preset.on { background: var(--accent); color: #fff; }
    .round-btn { flex-shrink: 0; width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }

    /* Sleep-timer sheet */
    .timer-sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 11; display: flex; flex-direction: column; gap: 12px; padding: 8px 16px 16px;
      background: var(--bg-elevated); border-top: 0.5px solid var(--border-subtle); border-radius: 16px 16px 0 0; box-shadow: 0 -8px 30px rgba(0,0,0,0.35); animation: sheetUp 0.25s ease-out; }
    .sheet-grabber { width: 36px; height: 5px; border-radius: 3px; background: var(--text-tertiary); opacity: 0.5; align-self: center; margin: 2px 0 4px; }
    .ts-title { font-size: 17px; font-weight: 600; color: var(--text-primary); text-align: center; margin: -2px 0 2px; }
    .ts-eoc { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 13px 14px; border: none; border-radius: 12px; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; }
    .ts-eoc-icon { flex-shrink: 0; width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .ts-eoc-label { flex: 1; min-width: 0; font-size: 15px; font-weight: 500; }
    .ts-eoc app-icon:last-child { color: var(--text-tertiary); }
    .ts-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .ts-chip { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; padding: 12px 0; border: none; border-radius: 14px; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; }
    .ts-chip-num { font-size: 22px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
    .ts-chip-unit { font-size: 11px; color: var(--text-tertiary); }
    .ts-custom { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-radius: 14px; background: var(--bg-hover); }
    .ts-step { flex-shrink: 0; width: 44px; height: 44px; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .ts-step:disabled { opacity: 0.3; }
    .ts-custom-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 1px; }
    .ts-custom-val { font-size: 24px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; line-height: 1.1; }
    .ts-custom-cap { font-size: 11px; color: var(--text-tertiary); }
    .ts-start { width: 100%; padding: 15px; border: none; border-radius: 14px; background: var(--accent); color: #fff; font-size: 16px; font-weight: 600; cursor: pointer; }
  `],
})
export class PlayerChromeComponent implements OnDestroy {
  // ── Meta ────────────────────────────────────────────────────────────────
  readonly title = input('');
  readonly author = input('');
  readonly coverSrc = input<string | null>(null);

  // ── Transcript ──────────────────────────────────────────────────────────
  readonly cues = input<ChromeCue[]>([]);
  readonly activeIndex = input(0);
  readonly chapterStartMap = input<Map<number, string>>(new Map());
  /** Whether this player has synced text at all. false → an audio-only
   *  audiobook (no VTT): show the cover, hide the Sentences/Follow controls.
   *  Defaults true so every existing caller is unaffected. */
  readonly hasText = input(true);

  // ── Transport ───────────────────────────────────────────────────────────
  readonly isPlaying = input(false);
  readonly busy = input(false);
  readonly skipKind = input<'time10' | 'sentence'>('time10');
  readonly canSkipBack = input(true);
  readonly canSkipForward = input(true);

  // ── Scrubber (normalized by the host) ───────────────────────────────────
  readonly scrubMin = input(0);
  readonly scrubMax = input(0);
  readonly scrubValue = input(0);
  readonly heardPercent = input(0);
  readonly chapterNotches = input<number[]>([]);
  readonly leftLabel = input('');
  readonly rightLabel = input('');
  readonly centerLabel = input('');
  readonly scrubDisabled = input(false);
  /** true → seek live while dragging (cheap audio seek); false → seek on release
   *  only (the stream regenerates on every seek, so mid-drag ticks would thrash). */
  readonly seekLive = input(true);

  // ── Speed ───────────────────────────────────────────────────────────────
  readonly speed = input(1);
  readonly speedPresets = input<number[]>([1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75]);
  readonly speedMin = input(0.5);
  readonly speedMax = input(5);
  /** Same live/commit trade-off as seekLive, for the speed slider. */
  readonly speedLive = input(true);

  // ── Chapters ────────────────────────────────────────────────────────────
  readonly chapters = input<ChromeChapter[]>([]);
  readonly currentChapterId = input<string | null>(null);
  readonly canPrevChapter = input(false);
  readonly canNextChapter = input(false);

  // ── Bookmarks ───────────────────────────────────────────────────────────
  readonly bookmarks = input<ChromeBookmark[]>([]);

  // ── Sleep timer — seconds left in the current chapter (null hides EoC) ───
  readonly chapterRemaining = input<number | null>(null);

  // ── Outputs ─────────────────────────────────────────────────────────────
  readonly togglePlay = output<void>();
  readonly skip = output<'back' | 'forward'>();
  /** The outer ±5-minute skip buttons (time-based players only). */
  readonly skipBig = output<'back' | 'forward'>();
  readonly seek = output<number>();
  readonly pickCue = output<number>();
  readonly prevChapter = output<void>();
  readonly nextChapter = output<void>();
  readonly pickChapter = output<string>();
  readonly addBookmark = output<void>();
  readonly pickBookmark = output<string>();
  readonly deleteBookmark = output<string>();
  readonly speedChange = output<number>();
  readonly sleepExpired = output<void>();

  private readonly textAreaRef = viewChild<ElementRef<HTMLDivElement>>('textArea');

  // ── Local UI state ──────────────────────────────────────────────────────
  readonly viewMode = signal<'text' | 'cover'>('text');
  readonly followText = signal(true);
  readonly speedOpen = signal(false);
  /** Local speed shown on the label/thumb while dragging (before the host commits). */
  readonly displaySpeed = signal<number | null>(null);
  readonly chaptersOpen = signal(false);
  readonly bookmarksOpen = signal(false);
  readonly timerOpen = signal(false);
  readonly sleepModeOpen = signal(false);
  readonly sleepMode = signal<'off' | 'timer' | 'chapter'>('off');
  readonly sleepRemaining = signal(0);
  readonly customMinutes = signal(45);
  readonly presets = [5, 10, 15, 30, 45, 60];

  // Progressive transcript reveal: a full audiobook is thousands of cues, and
  // building them all in one synchronous pass freezes the window on open. We
  // render a small first window (controls are usable instantly) and grow it over
  // animation frames so the main thread never blocks.
  private static readonly INITIAL_RENDER = 60;
  private static readonly GROW_CHUNK = 150;
  readonly visibleCount = signal(PlayerChromeComponent.INITIAL_RENDER);
  private growHandle: number | null = null;
  readonly renderedCues = computed(() => {
    const all = this.cues();
    const n = this.visibleCount();
    return n >= all.length ? all : all.slice(0, n);
  });

  readonly showText = computed(() => this.hasText() && (!this.coverSrc() || this.viewMode() === 'text'));
  readonly sleepActive = computed(() => this.sleepMode() !== 'off');
  /** Scrub position as a % of the range — drives the .scrub-dot above the notches. */
  readonly scrubPercent = computed(() => {
    const span = this.scrubMax() - this.scrubMin();
    if (span <= 0) return 0;
    return Math.max(0, Math.min(100, ((this.scrubValue() - this.scrubMin()) / span) * 100));
  });
  readonly currentChapterTitle = computed(() =>
    this.chapters().find((c) => c.id === this.currentChapterId())?.title ?? '',
  );

  private sleepTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Keep the active line centered while following. Depends on visibleCount too,
    // so if the active line hasn't been revealed yet (e.g. a deep bookmark while
    // the window is still growing), this re-runs and scrolls once it exists.
    effect(() => {
      const idx = this.activeIndex();
      this.visibleCount();
      if (this.followText() && this.showText()) requestAnimationFrame(() => this.scrollToActive(idx));
    });

    // Reset + progressively grow the render window whenever the cue list changes
    // (new book, or search filter applied/cleared). Growth always runs to the
    // full transcript — just chunked across frames so it never blocks.
    effect(() => {
      const total = this.cues().length;
      this.visibleCount.set(Math.min(PlayerChromeComponent.INITIAL_RENDER, total));
      this.scheduleGrow(total);
    });
  }

  ngOnDestroy(): void {
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    if (this.growHandle !== null) cancelAnimationFrame(this.growHandle);
  }

  /** Grow the render window one chunk per animation frame until the whole
   *  transcript is materialized — yields to the browser between chunks so the
   *  UI stays responsive instead of freezing on a single giant render. */
  private scheduleGrow(total: number): void {
    if (this.growHandle !== null) cancelAnimationFrame(this.growHandle);
    const step = () => {
      const cur = this.visibleCount();
      if (cur >= total) { this.growHandle = null; return; }
      this.visibleCount.set(Math.min(total, cur + PlayerChromeComponent.GROW_CHUNK));
      this.growHandle = requestAnimationFrame(step);
    };
    this.growHandle = requestAnimationFrame(step);
  }

  fmt(seconds: number): string {
    if (!seconds || seconds < 0 || isNaN(seconds)) return '0:00';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /** Spacebar toggles play/pause — unless the user is typing or focused on a
   *  button/control that Space would otherwise activate. */
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.key !== ' ' && e.code !== 'Space') return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    e.preventDefault();
    this.togglePlay.emit();
  }

  setViewMode(mode: 'text' | 'cover'): void {
    this.viewMode.set(mode);
    if (mode === 'text') requestAnimationFrame(() => this.scrollToActive(this.activeIndex()));
  }

  onScrubInput(event: Event): void {
    if (this.seekLive()) this.seek.emit(parseFloat((event.target as HTMLInputElement).value));
  }
  onScrubCommit(event: Event): void {
    if (!this.seekLive()) this.seek.emit(parseFloat((event.target as HTMLInputElement).value));
  }

  onPickChapter(id: string): void {
    this.chaptersOpen.set(false);
    this.pickChapter.emit(id);
  }

  onPickBookmark(id: string): void {
    this.bookmarksOpen.set(false);
    this.pickBookmark.emit(id);
  }

  // ── Follow-text ───────────────────────────────────────────────────────────
  onUserScroll(): void { if (this.followText()) this.followText.set(false); }
  toggleFollow(): void {
    const on = !this.followText();
    this.followText.set(on);
    if (on) requestAnimationFrame(() => this.scrollToActive(this.activeIndex()));
  }

  private scrollToActive(index: number): void {
    const container = this.textAreaRef()?.nativeElement;
    if (!container) return;
    const el = container.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
    if (!el) return;
    // Native center-in-scrollport: the browser measures it, so the active line
    // lands in the MIDDLE of the transcript (clear of the top/bottom fade) rather
    // than drifting low from stale manual scrollTop/rect math during playback.
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }

  // ── Speed ───────────────────────────────────────────────────────────────
  isSpeed(v: number): boolean { return Math.abs(this.speed() - v) < 0.001; }
  speedLabel(): string { return `${Math.round((this.displaySpeed() ?? this.speed()) * 100) / 100}×`; }
  onSpeedInput(event: Event): void {
    const v = parseFloat((event.target as HTMLInputElement).value);
    this.displaySpeed.set(v);
    if (this.speedLive()) this.speedChange.emit(v);
  }
  onSpeedCommit(event: Event): void {
    const v = parseFloat((event.target as HTMLInputElement).value);
    this.displaySpeed.set(v);
    if (!this.speedLive()) this.speedChange.emit(v);
  }
  setPreset(v: number): void { this.displaySpeed.set(v); this.speedChange.emit(v); }
  bumpSpeed(delta: number): void {
    const base = this.displaySpeed() ?? this.speed();
    const v = Math.min(this.speedMax(), Math.max(this.speedMin(), Math.round((base + delta) * 20) / 20));
    this.displaySpeed.set(v);
    this.speedChange.emit(v);
  }

  // ── Sleep timer ───────────────────────────────────────────────────────────
  onTimerButton(): void {
    if (this.sleepMode() === 'off') this.timerOpen.set(true);
    else this.sleepModeOpen.set(!this.sleepModeOpen());
  }
  startTimer(min: number): void {
    this.sleepMode.set('timer');
    this.sleepRemaining.set(min * 60);
    this.timerOpen.set(false);
    this.sleepModeOpen.set(true);
    this.runSleepTick();
  }
  startEndOfChapter(): void {
    this.sleepMode.set('chapter');
    this.sleepRemaining.set(Math.max(0, this.chapterRemaining() ?? 0));
    this.timerOpen.set(false);
    this.sleepModeOpen.set(true);
    this.runSleepTick();
  }
  addSleepMinutes(delta: number): void {
    if (this.sleepMode() !== 'timer') return;
    this.sleepRemaining.set(Math.max(0, this.sleepRemaining() + delta * 60));
  }
  cancelSleep(): void {
    this.sleepMode.set('off');
    this.sleepRemaining.set(0);
    this.sleepModeOpen.set(false);
    if (this.sleepTimer) { clearInterval(this.sleepTimer); this.sleepTimer = null; }
  }
  private runSleepTick(): void {
    if (this.sleepTimer) clearInterval(this.sleepTimer);
    this.sleepTimer = setInterval(() => {
      if (this.sleepMode() === 'chapter') {
        this.sleepRemaining.set(Math.max(0, this.chapterRemaining() ?? 0));
      } else {
        this.sleepRemaining.set(Math.max(0, this.sleepRemaining() - 1));
      }
      if (this.sleepRemaining() <= 0) {
        this.cancelSleep();
        this.sleepExpired.emit();
      }
    }, 1000);
  }

  // ── Custom stepper ────────────────────────────────────────────────────────
  stepCustom(delta: number): void {
    this.customMinutes.set(Math.min(480, Math.max(5, this.customMinutes() + delta)));
  }
  customLabel(): string {
    const m = this.customMinutes();
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h && rem) return `${h} h ${rem} m`;
    if (h) return `${h} h`;
    return `${m} min`;
  }
}
