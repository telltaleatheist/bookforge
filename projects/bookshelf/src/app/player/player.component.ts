import {
  Component, computed, effect, ElementRef, inject, OnDestroy, OnInit, signal, viewChild,
} from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { PlayerService } from '../services/player.service';
import { BookActionsService } from '../services/book-actions.service';
import { IconComponent } from '../shared/icon.component';
import { formatTime } from '../shared/format';
import { decodePathId } from '../shared/path-id';
import { Audiobook, Chapter } from '../models/types';

/**
 * Full-screen player view. State and audio live in PlayerService, so the
 * "down" button just navigates away — playback continues and the mini-bar
 * takes over. This component owns only the transcript scrolling and the
 * chapter / bookmark sheets.
 */
@Component({
  selector: 'app-player',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="scrim" (click)="minimize()"></div>
    <div class="player">
      <header class="topbar">
        <button class="icon-btn" (click)="minimize()" title="Minimize"><app-icon name="chevron-down" [size]="24" /></button>
        <div class="topbar-title">
          <div class="t-title">{{ p.book()?.title || 'Player' }}</div>
          @if (p.book()?.author) { <div class="t-author">{{ p.book()!.author }}</div> }
        </div>
        @if (p.airplayAvailable()) {
          <button class="icon-btn" (click)="p.showRemotePicker()" title="AirPlay / Cast"><app-icon name="airplay" [size]="20" /></button>
        }
        <!-- Download to this device: caches the audiobook so it plays offline.
             Not shown for on-device books (already local). Once saved the button
             turns purple and swaps to a trash icon — tap again to remove the
             offline copy and go back to streaming from the server. -->
        @if (showDownload()) {
          <button class="icon-btn dl-btn" [class.done]="isDownloaded()" [class.busy]="downloading()"
                  (click)="onDownloadButton()" [title]="downloadTitle()">
            @if (downloading()) {
              <span class="dl-pct">{{ dlPercent() !== null ? dlPercent() + '%' : '…' }}</span>
            } @else if (isDownloaded()) {
              <app-icon name="trash" [size]="20" />
            } @else {
              <app-icon name="download" [size]="20" />
            }
          </button>
        }
        <button class="icon-btn close" (click)="closeFully()" title="Close">✕</button>
      </header>

      <!-- Download progress: a thin strip right under the top bar while a save is
           in flight, so a long download visibly works instead of just spinning. -->
      @if (downloading()) {
        <div class="dl-strip" [title]="'Downloading ' + (dlPercent() ?? 0) + '%'">
          <div class="dl-strip-fill" [style.width.%]="dlPercent() ?? 6"></div>
        </div>
      }
      @if (dlError(); as e) {
        <div class="dl-error" role="alert" (click)="dlError.set(null)">{{ e }} — tap to dismiss</div>
      }

      <!-- Sentences / Cover switch: only offered when this audiobook actually has
           synced text. Without a transcript there's nothing to switch to, so the
           control is hidden and the body falls back to the cover by default. -->
      @if (hasText()) {
        <div class="view-toggle-row">
          <div class="seg" role="tablist">
            <button class="seg-btn" role="tab" [class.on]="viewMode() === 'text'" [attr.aria-selected]="viewMode() === 'text'"
                    (click)="setViewMode('text')">
              <app-icon name="article" [size]="16" /><span>Sentences</span>
            </button>
            <button class="seg-btn" role="tab" [class.on]="viewMode() === 'cover'" [attr.aria-selected]="viewMode() === 'cover'"
                    (click)="setViewMode('cover')">
              <app-icon name="image" [size]="16" /><span>Cover</span>
            </button>
          </div>
        </div>
      }

      @if (p.error()) {
        <div class="state"><div class="icon">⚠️</div><p>{{ p.error() }}</p></div>
      } @else if (p.loading()) {
        <div class="state"><div class="spinner"></div><p>Loading…</p></div>
      } @else {
        <div class="player-body">
        @if (sleepModeOpen()) {
          <div class="sleep-screen">
            <button class="sleep-show-text" (click)="sleepModeOpen.set(false)">Show text</button>
            <div class="sleep-main">
              <div class="sleep-count">{{ fmt(p.sleepRemaining()) }}</div>
              <div class="sleep-sub">{{ p.sleepMode() === 'chapter' ? 'until end of chapter' : 'until playback stops' }}</div>
              <div class="sleep-circles">
                <button class="sleep-circle" (click)="p.addSleepMinutes(-15)"><span class="c-big">−15</span><span class="c-sm">min</span></button>
                <button class="sleep-circle" (click)="p.addSleepMinutes(15)"><span class="c-big">+15</span><span class="c-sm">min</span></button>
              </div>
            </div>
            <button class="sleep-cancel" (click)="cancelTimer()">Cancel timer</button>
          </div>
        } @else {
        <div class="text-area" #textArea [class.no-follow]="!followText()"
          (wheel)="onUserScroll()" (touchmove)="onUserScroll()">
          @if (showText()) {
            @for (cue of p.cues(); track cue.index) {
              @if (p.chapterStartMap().get(cue.index); as chapterTitle) {
                <div class="chapter-header">{{ chapterTitle }}</div>
              }
              <div class="segment"
                [class.active]="cue.index === p.currentCueIndex()"
                [class.past]="cue.index < p.currentCueIndex()"
                [attr.data-index]="cue.index"
                (click)="pickSentence(cue.index)">
                <p>{{ cue.text }}</p>
              </div>
            }
          } @else {
            <div class="no-text">
              @if (p.coverSrc(); as src) { <img class="big-cover" [src]="src" alt="Cover" /> }
              @else { <div class="big-cover placeholder">🎧</div> }
              <div class="nt-title">{{ p.book()?.title }}</div>
              @if (p.book()?.author) { <div class="nt-author">{{ p.book()!.author }}</div> }
              @if (!hasText()) {
                <p class="nt-note">No synced text for this audiobook — chapter navigation only.</p>
              }
            </div>
          }
        </div>
        }

        <div class="controls">
          @if (p.currentChapter(); as ch) {
            <div class="chapter-nav">
              <button class="ch-arrow" (click)="p.prevChapter()" [disabled]="!p.canPrevChapter()" title="Previous chapter"><app-icon name="chevron-left" [size]="24" /></button>
              <button class="now-chapter" (click)="chaptersOpen.set(true)" title="Chapters"><span class="nc-label">{{ ch.title }}</span><app-icon name="chevron-down" [size]="14" /></button>
              <button class="ch-arrow" (click)="p.nextChapter()" [disabled]="!p.canNextChapter()" title="Next chapter"><app-icon name="chevron-right" [size]="24" /></button>
            </div>
          }

          <div class="scrub">
            <div class="scrub-track">
              @for (seg of heardSegs(); track $index) {
                <span class="heard-seg" [style.left.%]="seg.left" [style.width.%]="seg.width"></span>
              }
            </div>
            @for (n of chapterNotches(); track $index) {
              <span class="notch" [style.left.%]="n"></span>
            }
            <input class="scrubber wide bare" type="range" [min]="scrubMin()" [max]="scrubMax()" step="1"
              [value]="p.currentTime()" (input)="onScrub($event)"
              (pointerdown)="onScrubStart()" (pointerup)="onScrubEnd()" (pointercancel)="onScrubEnd()" (change)="onScrubEnd()" />
            <!-- Position dot painted above the chapter notches (the native thumb is
                 hidden). z-index 3 > notch z-index 2 so it's never cut by a notch. -->
            <span class="scrub-dot" [style.left.%]="scrubPercent()"></span>
          </div>
          <div class="scrub-labels" [class.toggleable]="p.chapters().length > 0" (click)="toggleTimelineMode()">
            <span class="time">{{ fmt(leftTime()) }}</span>
            @if (p.chapters().length > 0) { <span class="ch-count">{{ timelineLabel() }}</span> }
            <span class="time">{{ fmt(rightTime()) }}</span>
          </div>

          <div class="transport">
            <button class="t-btn skip-btn min" (click)="p.skip(-300)" title="Back 5 min">
              <app-icon name="replay" [size]="26" /><span class="skip-num">5m</span>
            </button>
            <button class="t-btn skip-btn" (click)="p.skip(-10)" title="Back 10s">
              <app-icon name="replay" [size]="30" /><span class="skip-num">10</span>
            </button>
            <button class="t-btn play" (click)="p.togglePlay()" [title]="p.isPlaying() ? 'Pause' : 'Play'">
              <app-icon [name]="p.isPlaying() ? 'pause' : 'play'" [size]="30" />
            </button>
            <button class="t-btn skip-btn fwd" (click)="p.skip(10)" title="Forward 10s">
              <app-icon name="replay" [size]="30" /><span class="skip-num">10</span>
            </button>
            <button class="t-btn skip-btn min fwd" (click)="p.skip(300)" title="Forward 5 min">
              <app-icon name="replay" [size]="26" /><span class="skip-num">5m</span>
            </button>
          </div>

          <div class="tool-row">
            <button class="tool speed-pill" (click)="speedOpen.set(true)" title="Playback speed">{{ speedLabel() }}</button>
            <button class="tool" [class.on]="bookmarksOpen()" (click)="bookmarksOpen.set(!bookmarksOpen())" title="Bookmarks"><app-icon name="bookmark" [size]="18" /></button>
            <button class="tool" [class.on]="p.sleepMode() !== 'off'" (click)="onTimerButton()" title="Sleep timer">
              @if (p.sleepMode() !== 'off') { <span class="tool-count">{{ fmt(p.sleepRemaining()) }}</span> }
              @else { <app-icon name="timer" [size]="18" /> }
            </button>
            <button class="tool" [class.on]="followText()" (click)="toggleFollow()" [title]="followText() ? 'Following text' : 'Follow text'"><app-icon name="follow" [size]="18" /></button>
          </div>
        </div>
        </div>

        @if (chaptersOpen()) {
          <div class="sheet-backdrop" (click)="closeChapters()"></div>
          <div class="sheet">
            <div class="sheet-head"><span>Chapters</span><button class="icon-btn sm" (click)="closeChapters()">✕</button></div>
            <div class="sheet-body">
              @for (ch of p.chapters(); track ch.start; let i = $index) {
                <button class="row-item" [class.active]="ch === p.currentChapter()" (click)="pickChapter(ch)">
                  <span class="row-num">{{ i + 1 }}</span>
                  <span class="row-title">{{ ch.title }}</span>
                  <span class="row-time">{{ fmt(ch.start) }}</span>
                </button>
              } @empty {
                <p class="sheet-empty">No chapters in this audiobook.</p>
              }
            </div>
            <button class="sheet-action danger" (click)="tapReset()">
              {{ resetArmed() ? 'Tap again to reset — clears listened progress' : '↺ Reset progress' }}
            </button>
          </div>
        }

        @if (bookmarksOpen()) {
          <div class="sheet-backdrop" (click)="bookmarksOpen.set(false)"></div>
          <div class="sheet">
            <div class="sheet-head"><span>Bookmarks</span><button class="icon-btn sm" (click)="bookmarksOpen.set(false)">✕</button></div>
            <div class="sheet-body">
              @for (bm of p.bookmarks(); track bm.id) {
                <div class="row-item bm">
                  <button class="bm-jump" (click)="pickBookmark(bm)">
                    <span class="bm-auto" [class.manual]="(bm.kind ?? 'manual') === 'manual'"><app-icon [name]="bmIcon(bm.kind)" [size]="14" /></span>
                    <span class="bm-text">
                      <span class="row-title">{{ bm.label }}</span>
                      <span class="bm-when">{{ fmtWhen(bm.createdAt) }}</span>
                    </span>
                    <span class="row-time">{{ fmt(bm.position) }}</span>
                  </button>
                  <button class="bm-del" (click)="p.removeBookmark(bm.id)" title="Delete">✕</button>
                </div>
              } @empty {
                <p class="sheet-empty">No bookmarks yet.</p>
              }
            </div>
            <button class="sheet-action" (click)="addBookmark()">+ Bookmark this spot</button>
          </div>
        }

        @if (speedOpen()) {
          <div class="sheet-backdrop" (click)="speedOpen.set(false)"></div>
          <div class="sheet">
            <div class="sheet-head"><span>Playback speed</span><button class="icon-btn sm" (click)="speedOpen.set(false)">✕</button></div>
            <div class="sheet-body pad">
              <div class="ctl-head"><span class="ctl-title">Speed</span><span class="ctl-val">{{ speedLabel() }}</span></div>
              <input class="speed-slider wide" type="range" min="0.5" max="4" step="0.05" [value]="p.speed()" (input)="onSpeed($event)" />
              <div class="preset-row">
                <button class="round-btn" (click)="bumpSpeed(-0.05)" title="Slower"><app-icon name="minus" [size]="18" /></button>
                <button class="preset" [class.on]="isSpeed(1.25)" (click)="setSpeed(1.25)">1.25×</button>
                <button class="preset" [class.on]="isSpeed(1.5)" (click)="setSpeed(1.5)">1.5×</button>
                <button class="preset" [class.on]="isSpeed(1.75)" (click)="setSpeed(1.75)">1.75×</button>
                <button class="preset" [class.on]="isSpeed(2)" (click)="setSpeed(2)">2×</button>
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

            @if (p.chapters().length > 0) {
              <button class="ts-eoc" (click)="startEndOfChapter()">
                <span class="ts-eoc-icon"><app-icon name="moon" [size]="18" /></span>
                <span class="ts-eoc-label">End of chapter</span>
                <app-icon name="chevron-right" [size]="18" />
              </button>
            }

            <div class="ts-chips">
              @for (m of presets; track m) {
                <button class="ts-chip" (click)="startTimer(m)">
                  <span class="ts-chip-num">{{ m }}</span>
                  <span class="ts-chip-unit">min</span>
                </button>
              }
            </div>

            <div class="ts-custom">
              <button class="ts-step" (click)="stepCustom(-5)" [disabled]="customMinutes() <= 5" aria-label="Less">
                <app-icon name="minus" [size]="20" />
              </button>
              <div class="ts-custom-mid">
                <span class="ts-custom-val">{{ customLabel() }}</span>
                <span class="ts-custom-cap">Custom</span>
              </div>
              <button class="ts-step" (click)="stepCustom(5)" [disabled]="customMinutes() >= 480" aria-label="More">
                <app-icon name="plus" [size]="20" />
              </button>
            </div>

            <button class="ts-start" (click)="startCustomTimer()">Start Timer</button>
          </div>
        }

      }
    </div>
  `,
  styles: [`
    /* Overlay layer: covers the viewport, centers the player panel over the
       (blurred) shelf. */
    :host { position: fixed; inset: 0; z-index: 500; display: flex; align-items: center; justify-content: center; }
    .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }

    /* The panel. Full-screen on phones; a floating, rounded, glowing pop-up on desktop. */
    .player { position: relative; z-index: 1; display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; background: var(--bg-base); }
    /* Floating pop-up only on a genuinely large viewport. The min-height guard
       keeps a phone in landscape (wide but short) full-screen instead of a
       floating panel with a blurred backdrop. */
    @media (min-width: 768px) and (min-height: 601px) {
      .player {
        width: min(720px, 94vw);
        height: min(1200px, 95vh);
        border-radius: 20px;
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), 0 0 60px -14px color-mix(in srgb, var(--accent) 55%, transparent);
      }
    }

    .topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0;
      padding: calc(8px + env(safe-area-inset-top)) 8px 8px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle); }
    .topbar-title { flex: 1; min-width: 0; text-align: center; }
    .t-title { font-size: 14px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t-author { font-size: 11px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-btn { width: 40px; height: 40px; flex-shrink: 0; border: none; background: var(--bg-elevated); border-radius: 8px; color: var(--text-primary);
      font-size: 22px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; text-decoration: none; }
    .icon-btn.sm { width: 30px; height: 30px; font-size: 14px; background: transparent; color: var(--text-tertiary); }
    .icon-btn.on { background: var(--accent); color: #fff; }
    .icon-btn.close { font-size: 16px; color: var(--text-secondary); }
    /* Download button: purple fill once the book is saved offline (swaps to a
       trash icon) to signal "saved here — tap to delete and use the server". */
    .dl-btn.done { background: var(--downloaded); border-color: var(--downloaded); color: #fff; }
    .dl-btn.busy { background: color-mix(in srgb, var(--accent) 22%, var(--bg-elevated)); }
    .dl-btn app-icon.flip { display: inline-flex; transform: rotate(180deg); }
    .dl-btn:disabled { opacity: 0.6; }
    .dl-pct { font-size: 11px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
    .dl-spin { display: inline-block; font-size: 18px; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    /* Download strip: sits right under the top bar; the fill grows with bytes. */
    .dl-strip { flex-shrink: 0; height: 3px; background: var(--bg-elevated); overflow: hidden; }
    .dl-strip-fill { height: 100%; background: var(--accent); transition: width 0.2s ease; }
    .dl-error { flex-shrink: 0; padding: 8px 12px; font-size: 12px; text-align: center; cursor: pointer;
      background: color-mix(in srgb, #e5484d 18%, var(--bg-surface)); color: var(--text-primary); border-bottom: 1px solid var(--border-subtle); }

    /* Sentences / Cover segmented switch, stretched full-width under the top bar. */
    .view-toggle-row { flex-shrink: 0; display: flex; padding: 5px 12px; background: var(--bg-surface); border-bottom: 1px solid var(--border-subtle); }
    .seg { display: flex; width: 100%; padding: 2px; gap: 2px; border-radius: 9px; background: var(--bg-elevated); }
    .seg-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 4px 10px; border: none; border-radius: 7px;
      background: transparent; color: var(--text-secondary); font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s ease, color 0.15s ease; }
    .seg-btn.on { background: var(--accent); color: #fff; }
    .seg-btn app-icon { line-height: 0; }

    .state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: var(--text-secondary); }
    .state .icon { font-size: 44px; }

    /* Body wraps the transcript + controls. Portrait: vertical stack (transcript
       grows, controls pinned below). Phone landscape: two columns — controls on
       the LEFT (narrower), transcript on the RIGHT (wider), ~2:3. */
    .player-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    @media (orientation: landscape) and (max-height: 600px) {
      /* row-reverse puts .controls (2nd in DOM) on the left, .text-area on the right.
         All rules are scoped under .player-body so they out-specify the base
         (portrait) rules that appear later in the sheet. */
      .player-body { flex-direction: row-reverse; }
      .player-body .text-area { flex: 3 1 0; min-width: 0; }
      .player-body .controls { flex: 2 1 0; min-width: 0; overflow-y: auto; border-top: none; border-right: 1px solid var(--border-subtle); align-self: stretch;
        display: flex; flex-direction: column; justify-content: safe center; padding: 6px 12px calc(6px + env(safe-area-inset-bottom)); }
      /* Tighten the control cluster so it fits the short landscape height. */
      .player-body .chapter-nav { margin-bottom: 2px; }
      .player-body .scrub-labels { margin-top: 2px; }
      .player-body .transport { gap: 18px; padding: 6px 0 4px; }
      .player-body .t-btn { width: 44px; height: 44px; min-width: 44px; }
      .player-body .t-btn.play { width: 52px; height: 52px; }
      .player-body .tool-row { margin-top: 6px; padding-top: 8px; }
      .player-body .tool { width: 40px; height: 40px; }
    }

    .text-area { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 12px 14px; scroll-behavior: smooth; }
    .chapter-header { padding: 18px 6px 8px; font-size: 15px; font-weight: 700; color: var(--accent); border-bottom: 1px solid var(--border-subtle); margin-bottom: 8px; }
    .chapter-header:first-child { padding-top: 4px; }
    .segment { padding: 10px 12px; margin-bottom: 6px; border-radius: 8px; background: var(--bg-surface); border: 2px solid transparent;
      cursor: pointer; transition: opacity 0.7s ease, border-color 0.3s ease, background 0.3s ease; opacity: 0.62; }
    .segment.past { opacity: 0.4; }
    .segment.active { opacity: 1; border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
    /* When not following, dimming just hurts readability — light everything up
       (the current sentence keeps its accent outline for reference). */
    .text-area.no-follow .segment { opacity: 1; }
    .segment p { margin: 0; font-size: 17px; line-height: 1.6; color: var(--text-primary); }

    .no-text { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 24px; }
    /* Size to the cover's natural aspect (square audiobook art or 6×9) instead of
       forcing 2:3 — no cropping or letterboxing. */
    .big-cover { border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); background: var(--bg-elevated); }
    img.big-cover { max-width: 58vw; max-height: 38vh; width: auto; height: auto; object-fit: contain; }
    .big-cover.placeholder { width: 220px; max-width: 64vw; aspect-ratio: 2/3; display: flex; align-items: center; justify-content: center; font-size: 72px; color: var(--text-tertiary); }
    .nt-title { font-size: 18px; font-weight: 600; margin-top: 12px; }
    .nt-author { font-size: 14px; color: var(--text-tertiary); }
    .nt-note { font-size: 13px; color: var(--text-tertiary); margin-top: 12px; }

    .controls { flex-shrink: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--bg-surface); border-top: 1px solid var(--border-subtle); }

    /* Chapter nav: ‹ current chapter › — arrows pinned to the far edges (stationary
       regardless of title length), pill centered between them. */
    .chapter-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
    .ch-arrow { flex-shrink: 0; width: 34px; height: 34px; border: none; border-radius: 50%; background: transparent; color: var(--text-secondary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .ch-arrow:disabled { opacity: 0.28; }
    .now-chapter { min-width: 0; max-width: 62%; display: flex; align-items: center; gap: 6px; margin: 0; padding: 5px 14px; border: none; border-radius: 15px;
      background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); font-size: 13px; font-weight: 600; cursor: pointer; }
    .nc-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .scrub-labels { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
    .scrub-labels.toggleable { cursor: pointer; }
    .scrub-labels.toggleable .ch-count { color: var(--accent); }
    .ch-count { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 8px; }
    .time { font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; min-width: 44px; }

    /* Scrubber with a "listened" overlay: heard segments painted on the track,
       the range thumb on top showing current position. */
    .scrub { position: relative; display: flex; align-items: center; height: 22px; }
    .scrub-track { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden; pointer-events: none; }
    .heard-seg { position: absolute; top: 0; bottom: 0; background: var(--accent); }
    /* Chapter-boundary notches (whole-book mode): ticks that cut the track, exactly track-height. */
    /* z-index 2 keeps the notches above the range input (z-index 1): iOS WKWebView
       composites native form controls into a layer that paints over lower siblings,
       which hid the notches on-device. pointer-events:none still lets drags through. */
    .notch { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 2px; height: 4px; background: var(--bg-surface); pointer-events: none; z-index: 2; }
    .scrubber.bare { position: relative; z-index: 1; background: transparent; }
    .scrubber.bare::-webkit-slider-runnable-track { background: transparent; }
    .scrubber.bare::-moz-range-track { background: transparent; }
    /* Native thumb is invisible (still draggable) — the .scrub-dot below is the
       visible position indicator, painted above the chapter notches. */
    .scrubber.bare::-webkit-slider-thumb { background: transparent; box-shadow: none; }
    .scrubber.bare::-moz-range-thumb { background: transparent; box-shadow: none; }
    .scrub-dot { position: absolute; top: 50%; width: 15px; height: 15px; border-radius: 50%; background: var(--accent);
      transform: translate(-50%, -50%); box-shadow: 0 0 0 2px var(--bg-surface), 0 1px 3px rgba(0,0,0,0.5); pointer-events: none; z-index: 3; }

    /* Shared range styling so the scrubber + speed slider match the UI. */
    .scrubber, .speed-slider { -webkit-appearance: none; appearance: none; height: 4px; background: var(--bg-elevated); border-radius: 2px; outline: none; cursor: pointer; }
    .scrubber.wide, .speed-slider.wide { width: 100%; display: block; }
    .scrubber::-webkit-slider-thumb, .speed-slider::-webkit-slider-thumb { -webkit-appearance: none; width: 15px; height: 15px; margin-top: -5.5px; border-radius: 50%; background: var(--accent); border: none; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
    .scrubber::-moz-range-thumb, .speed-slider::-moz-range-thumb { width: 15px; height: 15px; border: none; border-radius: 50%; background: var(--accent); }
    .scrubber::-webkit-slider-runnable-track, .speed-slider::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: var(--bg-elevated); }
    .scrubber::-moz-range-track, .speed-slider::-moz-range-track { height: 4px; border-radius: 2px; background: var(--bg-elevated); }

    .transport { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 14px 0 8px; }
    .t-btn { position: relative; min-width: 52px; width: 52px; height: 52px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .t-btn:disabled { opacity: 0.3; }
    /* Outer ±5-minute buttons: slightly smaller than the ±10s buttons. */
    .t-btn.min { min-width: 44px; width: 44px; height: 44px; color: var(--text-secondary); }
    .skip-num { position: absolute; top: 54%; left: 50%; transform: translate(-50%, -50%); font-size: 10px; font-weight: 700; pointer-events: none; }
    .t-btn.min .skip-num { font-size: 9px; }
    .t-btn.fwd app-icon { transform: scaleX(-1); }
    .t-btn.play { width: 64px; height: 64px; background: var(--accent); color: #fff; }

    /* Bottom tool row: four identical round buttons (speed, bookmark, timer, follow).
       A divider separates it from the transport row above. */
    .tool-row { display: flex; align-items: center; justify-content: space-around; gap: 8px; margin-top: 10px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
    .tool { flex-shrink: 0; width: 46px; height: 46px; padding: 0; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-secondary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; }
    .tool.on { background: var(--accent); color: #fff; }
    .tool.speed-pill { font-variant-numeric: tabular-nums; }
    .tool-count { font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -0.3px; }

    /* 36×5 grabber handle, centered at the top of the timer sheet. */
    .sheet-grabber { width: 36px; height: 5px; border-radius: 3px; background: var(--text-tertiary); opacity: 0.5; align-self: center; margin: 2px 0 4px; }

    /* Sleep screen: replaces the sentence area (controls stay below), so you can
       still skip around at night. A huge countdown, a big +15 circle in the
       center, and a big square Cancel. Sizes use vmin so they shrink in landscape. */
    .sleep-screen { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 12px; }
    .sleep-show-text { position: absolute; top: 8px; right: 10px; z-index: 1; border: none; background: transparent; color: var(--text-tertiary); font-size: 12px; cursor: pointer; padding: 6px 8px; }
    .sleep-main { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: clamp(14px, 4vmin, 30px); }
    .sleep-count { font-size: clamp(44px, 13vmin, 74px); font-weight: 200; font-variant-numeric: tabular-nums; color: var(--text-primary); letter-spacing: -2px; line-height: 1; }
    .sleep-sub { font-size: 13px; color: var(--text-tertiary); margin-top: -10px; }
    .sleep-circles { display: flex; gap: clamp(16px, 6vmin, 44px); }
    .sleep-circle { width: clamp(92px, 25vmin, 150px); height: clamp(92px, 25vmin, 150px); border-radius: 50%; border: none; background: var(--accent); color: #fff;
      cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
      box-shadow: 0 12px 34px -8px color-mix(in srgb, var(--accent) 70%, transparent); }
    .sleep-circle:active { transform: scale(0.97); }
    .sleep-circle .c-big { font-size: clamp(26px, 8vmin, 42px); font-weight: 700; line-height: 1; }
    .sleep-circle .c-sm { font-size: 13px; opacity: 0.85; }
    /* Rectangular Cancel pinned just above the control panel. */
    .sleep-cancel { flex-shrink: 0; width: min(360px, 92%); margin: 0 auto 6px; padding: 15px; border-radius: 16px; border: 1px solid var(--border-strong);
      background: var(--bg-elevated); color: var(--text-secondary); font-size: 15px; font-weight: 600; cursor: pointer; }
    .sleep-cancel:active { background: var(--bg-hover); }

    /* ── Sleep-timer sheet (native iOS bottom sheet) ─────────────────────────────
       Translucent frosted surface anchored to the panel bottom, grabber pill,
       centered title, chip presets, and a keyboard-free custom stepper. */
    .timer-sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 11;
      display: flex; flex-direction: column; gap: 12px;
      padding: 8px 16px calc(16px + env(safe-area-inset-bottom));
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-top: 0.5px solid var(--border-subtle); border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 30px rgba(0,0,0,0.35); animation: sheetUp 0.25s ease-out; }
    .ts-title { font-size: 17px; font-weight: 600; color: var(--text-primary); text-align: center; margin: -2px 0 2px; }
    /* Full-width iOS list row for "End of chapter". */
    .ts-eoc { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left;
      padding: 13px 14px; border: none; border-radius: 12px; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; }
    .ts-eoc:active { opacity: 0.6; }
    .ts-eoc-icon { flex-shrink: 0; width: 34px; height: 34px; border-radius: 9px; display: flex; align-items: center; justify-content: center;
      background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .ts-eoc-label { flex: 1; min-width: 0; font-size: 15px; font-weight: 500; }
    .ts-eoc app-icon:last-child { color: var(--text-tertiary); }
    /* Preset chips: 3 across, big number + small unit. */
    .ts-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .ts-chip { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px;
      padding: 12px 0; border: none; border-radius: 14px; background: var(--bg-elevated); color: var(--text-primary); cursor: pointer; }
    .ts-chip:active { opacity: 0.6; }
    .ts-chip-num { font-size: 22px; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; }
    .ts-chip-unit { font-size: 11px; color: var(--text-tertiary); }
    /* Custom stepper row: − [ value / Custom ] +. */
    .ts-custom { display: flex; align-items: center; gap: 14px; padding: 10px 14px; border-radius: 14px; background: var(--bg-elevated); }
    .ts-step { flex-shrink: 0; width: 44px; height: 44px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .ts-step:active { opacity: 0.6; }
    .ts-step:disabled { opacity: 0.3; }
    .ts-custom-mid { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 1px; }
    .ts-custom-val { font-size: 24px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; line-height: 1.1; }
    .ts-custom-cap { font-size: 11px; color: var(--text-tertiary); }
    /* Full-width accent Start button. */
    .ts-start { width: 100%; padding: 15px; border: none; border-radius: 14px; background: var(--accent); color: #fff;
      font-size: 16px; font-weight: 600; cursor: pointer; }
    .ts-start:active { opacity: 0.6; }
    .bm-auto { flex-shrink: 0; display: inline-flex; color: var(--accent); }
    .bm-auto.manual { color: var(--text-tertiary); }
    .bm-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .bm-when { font-size: 11px; color: var(--text-tertiary); }

    /* Advanced controls sheet */
    .sheet-body.pad { padding: 16px 18px 8px; }
    .ctl-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
    .ctl-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
    .ctl-val { font-size: 15px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
    .ctl-note { font-size: 12px; color: var(--text-tertiary); margin: 12px 0 0; line-height: 1.5; }
    .ctl-divider { height: 1px; background: var(--border-subtle); margin: 22px 0 16px; }
    .preset-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 14px; }
    .preset { flex: 1; height: 40px; border: none; border-radius: 20px; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .preset.on { background: var(--accent); color: #fff; }
    .round-btn { flex-shrink: 0; width: 40px; height: 40px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; display: flex; align-items: center; justify-content: center; }

    /* Sheets are contained within the panel (absolute), so they slide up inside
       the pop-up and clip to its rounded corners rather than the whole viewport. */
    .sheet-backdrop { position: absolute; inset: 0; z-index: 10; background: rgba(0,0,0,0.5); }
    .sheet { position: absolute; left: 0; right: 0; bottom: 0; z-index: 11; max-height: 70%; display: flex; flex-direction: column;
      background: var(--bg-elevated); border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom); animation: sheetUp 0.2s ease-out; transition: bottom 0.2s ease; }
    @keyframes sheetUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .sheet-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; font-weight: 600; border-bottom: 1px solid var(--border-subtle); }
    .sheet-body { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 6px; }
    .sheet-empty { padding: 24px; text-align: center; color: var(--text-tertiary); font-size: 13px; }
    .sheet-action { margin: 4px 10px 10px; padding: 12px; border: 1px solid var(--accent); border-radius: 10px; background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent); font-size: 14px; font-weight: 600; cursor: pointer; }
    .sheet-action.danger { border-color: var(--error); color: var(--error); background: color-mix(in srgb, var(--error) 12%, transparent); }
    .row-item { display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary);
      text-align: left; cursor: pointer; border-radius: 8px; }
    .row-item.active { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--accent); }
    .row-item.bm { padding: 0; }
    .bm-jump { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; padding: 12px 10px; border: none; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; border-radius: 8px; }
    .bm-del { flex-shrink: 0; width: 36px; height: 36px; margin-right: 6px; border: none; background: transparent; color: var(--text-tertiary); font-size: 13px; cursor: pointer; border-radius: 8px; }
    .bm-del:hover { color: var(--error); }
    .row-num { flex-shrink: 0; width: 24px; font-size: 12px; color: var(--text-tertiary); text-align: right; }
    .row-title { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-time { flex-shrink: 0; font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
  `],
})
export class PlayerComponent implements OnInit, OnDestroy {
  readonly p = inject(PlayerService);
  private readonly actions = inject(BookActionsService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  private readonly textAreaRef = viewChild<ElementRef<HTMLDivElement>>('textArea');

  readonly chaptersOpen = signal(false);
  readonly bookmarksOpen = signal(false);
  readonly speedOpen = signal(false);
  readonly timerOpen = signal(false);
  readonly sleepModeOpen = signal(false);
  readonly presets = [5, 10, 15, 30, 45, 60];
  // Keyboard-free custom-duration stepper (minutes, 5-min steps, 5m…8h). Last used
  // value is remembered so the sheet reopens where you left it.
  readonly customMinutes = signal(this.readCustomMinutes());
  readonly resetArmed = signal(false);

  // Timeline scope: 'chapter' (default) scales the scrubber + purple to the
  // current chapter; 'book' shows the whole book. Toggled by tapping the labels.
  readonly timelineMode = signal<'chapter' | 'book'>(
    (localStorage.getItem('bookshelf-timeline-mode') as 'chapter' | 'book') || 'chapter',
  );
  private readonly scrubBounds = computed(() => {
    const ch = this.p.currentChapter();
    if (this.timelineMode() === 'chapter' && ch) return { lo: ch.start, hi: ch.end };
    return { lo: 0, hi: this.p.duration() || 0 };
  });
  readonly scrubMin = computed(() => this.scrubBounds().lo);
  readonly scrubMax = computed(() => this.scrubBounds().hi);
  readonly leftTime = computed(() => this.p.currentTime() - this.scrubBounds().lo);
  readonly rightTime = computed(() => this.scrubBounds().hi - this.scrubBounds().lo);
  /** Current position as a % of the visible scrub range — drives the .scrub-dot. */
  readonly scrubPercent = computed(() => {
    const { lo, hi } = this.scrubBounds();
    if (hi <= lo) return 0;
    return Math.max(0, Math.min(100, ((this.p.currentTime() - lo) / (hi - lo)) * 100));
  });
  readonly timelineLabel = computed(() =>
    this.timelineMode() === 'book' ? 'Whole book' : `Chapter ${this.chapterIndex()} of ${this.p.chapters().length}`,
  );
  /** Chapter-boundary tick positions (%), only in whole-book mode. */
  readonly chapterNotches = computed(() => {
    if (this.timelineMode() !== 'book') return [];
    const dur = this.p.duration();
    if (dur <= 0) return [];
    return this.p.chapters()
      .map((c) => (c.start / dur) * 100)
      .filter((pct) => pct > 0.5 && pct < 99.5); // skip the very ends
  });
  /** Purple segments scaled to the current view (clipped to the scrubber bounds). */
  readonly heardSegs = computed(() => {
    const { lo, hi } = this.scrubBounds();
    const span = hi - lo;
    if (span <= 0) return [];
    const intervals = [...this.p.heard()];
    const prov = this.p.provisional();
    if (prov) intervals.push(prov); // show the in-progress run too
    const out: { left: number; width: number }[] = [];
    for (const [s, e] of intervals) {
      const cs = Math.max(s, lo);
      const ce = Math.min(e, hi);
      if (ce <= cs) continue;
      out.push({ left: ((cs - lo) / span) * 100, width: ((ce - cs) / span) * 100 });
    }
    return out;
  });
  // On by default each time the player opens (fresh component instance): the
  // transcript auto-scrolls to (and stays on) the current spot. Toggle in the
  // controls row to read/scroll freely.
  readonly followText = signal(true);

  // Player body view: the synced transcript ('text') or the book cover ('cover').
  // Only meaningful when the book has synced text — without it the body always
  // shows the cover and the switch is hidden. Persisted so the choice sticks.
  readonly viewMode = signal<'text' | 'cover'>(
    localStorage.getItem('bookshelf-player-view') === 'cover' ? 'cover' : 'text',
  );
  /** True when this audiobook has a synced transcript (VTT cues). */
  readonly hasText = computed(() => this.p.cues().length > 0);
  /** Show the transcript only when it exists AND the user hasn't chosen the cover. */
  readonly showText = computed(() => this.hasText() && this.viewMode() === 'text');

  readonly fmt = formatTime;

  // Download-to-device (offline) state for the header button. Reads the offline
  // store's signal via BookActionsService, so it lights up the moment a save
  // completes. Hidden for on-device books (nothing to download).
  readonly dlError = signal<string | null>(null);
  readonly showDownload = computed(() => {
    const b = this.p.book();
    return !!b && !this.actions.isLocal(b);
  });
  readonly isDownloaded = computed(() => {
    const b = this.p.book();
    return !!b && this.actions.isDownloaded(b);
  });
  /** Live during a download — drives the button's Cancel state and the strip. */
  readonly downloading = computed(() => {
    const b = this.p.book();
    return !!b && this.actions.isDownloading(b);
  });
  /** 0–100 for the in-flight download, or null before the size is known. */
  readonly dlPercent = computed(() => {
    const b = this.p.book();
    const pr = b ? this.actions.downloadProgress(b) : null;
    if (!pr || !pr.total) return null;
    return Math.min(100, Math.round((pr.received / pr.total) * 100));
  });
  downloadTitle(): string {
    if (this.downloading()) return 'Downloading — tap to cancel';
    return this.isDownloaded()
      ? 'Saved on this device — tap to delete and use the server instead'
      : 'Download to this device (play offline)';
  }

  /** Tri-state download control: cancel an in-flight download, remove an existing
   *  offline copy, or start a new one. Failures surface as a dismissible banner
   *  (not a silent console log) so a stuck/failed save is visible. */
  async onDownloadButton(): Promise<void> {
    const b = this.p.book();
    if (!b) return;
    if (this.actions.isDownloading(b)) { this.actions.cancelDownload(b); return; }
    if (this.actions.isDownloaded(b)) { await this.actions.removeDownload(b); return; }
    this.dlError.set(null);
    try {
      await this.actions.downloadAudiobook(b);
    } catch (err) {
      this.dlError.set(err instanceof Error ? err.message : 'Download failed');
    }
  }

  constructor() {
    // When "follow text" is on, keep the active line centered as playback moves.
    effect(() => {
      const idx = this.p.currentCueIndex();
      if (!this.followText()) return;
      this.scrollCueIntoView(idx);
    });
    // Discrete seeks (chapter/skip/bookmark) scroll even while paused/not following.
    effect(() => {
      this.p.scrollTick();
      requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
    });
    // Close Sleep Mode when the timer ends (expiry or cancel).
    effect(() => {
      if (this.p.sleepMode() === 'off') this.sleepModeOpen.set(false);
    });
    // Keep the screen awake while Sleep Mode is on the screen (so the countdown
    // stays visible and the +15 button is tappable without the phone locking).
    effect(() => {
      if (this.sleepModeOpen()) void this.acquireWakeLock();
      else this.releaseWakeLock();
    });
  }

  /** Switch the body between the synced transcript and the cover, and remember it.
   *  Returning to text re-centers on the current spot so it doesn't land scrolled away. */
  setViewMode(mode: 'text' | 'cover'): void {
    this.viewMode.set(mode);
    localStorage.setItem('bookshelf-player-view', mode);
    if (mode === 'text') requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
  }

  toggleFollow(): void {
    const on = !this.followText();
    this.followText.set(on);
    // Turning it on jumps to where playback currently is.
    if (on) requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
  }

  /** A user scroll gesture (wheel/touch) turns off follow so it stops fighting
   *  them. Programmatic auto-scroll never fires wheel/touchmove, so it's safe. */
  onUserScroll(): void {
    if (this.followText()) this.followText.set(false);
  }

  /** Tapping a sentence jumps playback there and re-enables follow. */
  pickSentence(index: number): void {
    this.p.seekToCue(index);
    this.followText.set(true);
    requestAnimationFrame(() => this.scrollCueIntoView(index));
  }

  async ngOnInit(): Promise<void> {
    const downloadPath = decodePathId(this.route.snapshot.paramMap.get('id') ?? '');
    if (!downloadPath) {
      this.p.error.set('No audiobook specified');
      return;
    }
    await this.p.open(downloadPath, (history.state?.book as Audiobook | undefined) ?? null);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  ngOnDestroy(): void {
    // Intentionally do NOT stop audio — it keeps playing under the mini-bar.
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.releaseWakeLock();
  }

  // ── Keep screen awake during Sleep Mode ───────────────────────────────────────
  private wakeLock: any = null;
  private readonly onVisibility = (): void => {
    // The OS drops the lock when the tab is hidden; re-acquire if Sleep Mode is still up.
    if (document.visibilityState === 'visible' && this.sleepModeOpen() && !this.wakeLock) void this.acquireWakeLock();
  };
  private async acquireWakeLock(): Promise<void> {
    const wl = (navigator as unknown as { wakeLock?: { request(type: string): Promise<any> } }).wakeLock;
    if (!wl || this.wakeLock) return;
    try {
      this.wakeLock = await wl.request('screen');
      this.wakeLock.addEventListener?.('release', () => { this.wakeLock = null; });
    } catch { /* denied, or tab not visible */ }
  }
  private releaseWakeLock(): void {
    try { this.wakeLock?.release(); } catch { /* already released */ }
    this.wakeLock = null;
  }

  /** Down button: leave the full view; audio keeps playing and the mini-bar appears. */
  minimize(): void {
    if (history.length > 1) this.location.back();
    else this.router.navigate(['/']);
  }

  /** Fully stop + unload the book (the ✕), then leave the player. */
  closeFully(): void {
    this.p.close();
    this.router.navigate(['/']);
  }

  pickChapter(ch: Chapter): void {
    this.chaptersOpen.set(false);
    this.resetArmed.set(false);
    this.p.seekToChapter(ch);
  }

  closeChapters(): void {
    this.chaptersOpen.set(false);
    this.resetArmed.set(false);
  }

  /** Two-tap guard: first tap arms, second tap actually resets. */
  // ── Sleep timer ─────────────────────────────────────────────────────────────
  onTimerButton(): void {
    if (this.p.sleepMode() === 'off') this.timerOpen.set(true);
    else this.sleepModeOpen.set(!this.sleepModeOpen()); // running → toggle the timer screen
  }
  startTimer(min: number): void {
    this.p.setSleepMinutes(min);
    this.timerOpen.set(false);
    this.sleepModeOpen.set(true); // straight to the timer screen
  }
  startEndOfChapter(): void {
    this.p.setSleepEndOfChapter();
    this.timerOpen.set(false);
    this.sleepModeOpen.set(true);
  }
  /** Persisted custom-stepper start value, clamped to the 5m…8h range. */
  private readCustomMinutes(): number {
    const v = parseInt(localStorage.getItem('bookshelf-sleep-custom') ?? '', 10);
    return Number.isFinite(v) && v >= 5 && v <= 480 ? v : 45;
  }
  /** ± button: step the custom duration by 5 minutes, clamped 5m…8h. */
  stepCustom(delta: number): void {
    const v = Math.min(480, Math.max(5, this.customMinutes() + delta));
    this.customMinutes.set(v);
    localStorage.setItem('bookshelf-sleep-custom', String(v));
  }
  /** Human label for the stepper, e.g. "45 min", "1 h", "1 h 15 m". */
  customLabel(): string {
    const m = this.customMinutes();
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h && rem) return `${h} h ${rem} m`;
    if (h) return `${h} h`;
    return `${m} min`;
  }
  /** "Start Timer": arm a custom sleep countdown and jump to the sleep screen. */
  startCustomTimer(): void {
    this.p.setSleepSeconds(this.customMinutes() * 60);
    this.timerOpen.set(false);
    this.sleepModeOpen.set(true);
  }

  /** Date + time a bookmark was created, e.g. "Jul 1, 9:47 PM". */
  fmtWhen(ms: number): string {
    if (!ms) return '';
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  bmIcon(kind?: string): string {
    return kind === 'open' ? 'book' : kind === 'chapter' ? 'next' : kind === 'sleep' ? 'timer' : kind === 'jump' ? 'replay' : kind === 'arrive' ? 'follow' : 'bookmark';
  }
  cancelTimer(): void {
    this.p.cancelSleep();
    this.sleepModeOpen.set(false);
  }

  tapReset(): void {
    if (!this.resetArmed()) { this.resetArmed.set(true); return; }
    this.p.resetProgress();
    this.resetArmed.set(false);
    this.chaptersOpen.set(false);
  }

  pickBookmark(bm: { position: number }): void {
    this.bookmarksOpen.set(false);
    this.p.seekTo(bm.position, true);
  }

  addBookmark(): void {
    const ch = this.p.currentChapter();
    const t = this.fmt(this.p.currentTime());
    this.p.addBookmark(ch ? `${ch.title} · ${t}` : t);
  }

  private scrubbing = false;
  private scrubFromPos = 0;
  onScrubStart(): void { this.scrubbing = true; this.scrubFromPos = this.p.currentTime(); }
  onScrubEnd(): void {
    // A big drag leaves a breadcrumb at where they were (recoverable), and arms an
    // "arrival" breadcrumb dropped once they settle here and listen for 10s.
    if (this.scrubbing && Math.abs(this.p.currentTime() - this.scrubFromPos) > 30) {
      this.p.markJumpFrom(this.scrubFromPos);
      this.p.armArrivalBookmark();
    }
    this.scrubbing = false;
  }

  onScrub(event: Event): void {
    let v = parseFloat((event.target as HTMLInputElement).value);
    if (this.scrubbing) v = this.snapToMarks(v);
    this.p.seekTo(v);
  }

  /** Magnetize a drag to the nearest listened-segment edge or chapter boundary,
   *  so you can land exactly on a meaningful spot. Passing the band scrubs freely.
   *  Band scales to the visible span, so it feels the same in chapter/book mode. */
  private snapToMarks(v: number): number {
    const span = this.scrubMax() - this.scrubMin();
    if (span <= 0) return v;
    const band = span * 0.01; // ~a few px near a mark
    const marks: number[] = [];
    for (const [s, e] of this.p.heard()) marks.push(s, e); // purple edges
    const chs = this.p.chapters();
    for (const c of chs) marks.push(c.start); // chapter boundaries
    if (chs.length) marks.push(chs[chs.length - 1].end);
    let best = v;
    let bestDist = band;
    for (const m of marks) {
      const d = Math.abs(v - m);
      if (d <= bestDist) { bestDist = d; best = m; }
    }
    return best;
  }

  onSpeed(event: Event): void {
    this.p.setSpeed(parseFloat((event.target as HTMLInputElement).value));
  }

  setSpeed(v: number): void { this.p.setSpeed(v); }
  isSpeed(v: number): boolean { return Math.abs(this.p.speed() - v) < 0.001; }

  /** Compact speed label, e.g. "1×", "1.25×", "1.5×" (no rounding surprises). */
  speedLabel(): string {
    return `${Math.round(this.p.speed() * 100) / 100}×`;
  }

  /** Step speed by ±delta (clamped 0.5×–4×), snapped to the slider's step. */
  bumpSpeed(delta: number): void {
    const v = Math.min(4, Math.max(0.5, Math.round((this.p.speed() + delta) * 20) / 20));
    this.p.setSpeed(v);
  }

  /** 1-based index of the current chapter (0 when none). */
  chapterIndex(): number {
    const chs = this.p.chapters();
    const cur = this.p.currentChapter();
    return cur ? chs.indexOf(cur) + 1 : 0;
  }

  toggleTimelineMode(): void {
    if (this.p.chapters().length === 0) return; // nothing to scope to
    const next = this.timelineMode() === 'chapter' ? 'book' : 'chapter';
    this.timelineMode.set(next);
    localStorage.setItem('bookshelf-timeline-mode', next);
  }

  private scrollCueIntoView(index: number): void {
    const container = this.textAreaRef()?.nativeElement;
    if (!container) return;
    const el = container.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
    if (!el) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const relTop = elRect.top - containerRect.top + container.scrollTop;
    const top = relTop - container.clientHeight / 2 + el.offsetHeight / 2;
    container.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

}
