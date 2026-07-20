import {
  AfterViewInit, Component, computed, Directive, effect, ElementRef, HostListener, inject,
  OnDestroy, OnInit, signal, viewChild,
} from '@angular/core';
import { Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import { ScrollingModule, CdkVirtualScrollViewport } from '@angular/cdk/scrolling';
import { PlayerService, Bookmark } from '../services/player.service';
import { BookActionsService } from '../services/book-actions.service';
import { IconComponent } from '../shared/icon.component';
import { VarVirtualScrollDirective } from '../shared/var-virtual-scroll';
import { formatTime } from '../shared/format';
import { decodePathId } from '../shared/path-id';
import { Audiobook, AudiobookAnalysisFinding, AudiobookAnalysisSkippedChunk, Chapter } from '../models/types';

/** Focus + select-all as soon as the element is created. For inline edit inputs
 *  revealed by a tap: the tap is a user gesture, and running focus() synchronously
 *  in that gesture's render pass is what makes iOS actually raise the keyboard
 *  (the `autofocus` attribute is ignored for nodes inserted after page load).
 *  select() highlights the existing text so typing replaces it. */
@Directive({ selector: '[appFocusSelect]', standalone: true })
export class FocusSelectDirective implements AfterViewInit {
  private readonly el = inject<ElementRef<HTMLInputElement>>(ElementRef);
  ngAfterViewInit(): void {
    const input = this.el.nativeElement;
    input.focus();
    input.select();
  }
}

/** One row of the virtualized transcript: a chapter header or a sentence cue. */
type TranscriptRow =
  | { type: 'header'; title: string; key: string }
  | { type: 'sentence'; cueIndex: number; text: string; key: string }
  // Top/bottom scroll padding: an empty row of `size` px so the first / current /
  // last sentence can sit vertically centered instead of pinned under the fade.
  | { type: 'spacer'; size: number; key: string };

/**
 * Full-screen player view. State and audio live in PlayerService, so the
 * "down" button just navigates away — playback continues and the mini-bar
 * takes over. This component owns only the transcript scrolling and the
 * chapter / bookmark sheets.
 */
@Component({
  selector: 'app-player',
  standalone: true,
  imports: [IconComponent, ScrollingModule, VarVirtualScrollDirective, FocusSelectDirective],
  template: `
    <div class="scrim" (click)="minimize()" [style.opacity]="expandScrim()"></div>
    <div class="player" [class.dragging]="isDragging() || p.expandDragging()"
         [class.analysis-open]="analysisOpen()"
         [style.transform]="panelTransform()"
         (touchstart)="onDragStart($event)" (touchmove)="onDragMove($event)"
         (touchend)="onDragEnd()" (touchcancel)="onDragEnd()">
      <header class="topbar">
        <!-- Minimize on the left, actions on the right; the Sentences/Cover
             toggle moved down to the control bar (next to Follow). -->
        <div class="topbar-side left">
          <button class="icon-btn" (click)="minimize()" title="Minimize"><app-icon name="chevron-down" [size]="24" /></button>
          @if (hasAnalysis()) {
            <button class="icon-btn analysis-toggle" [class.on]="analysisOpen()" (click)="toggleAnalysis()"
                    [title]="analysisOpen() ? 'Close analysis' : 'View analysis'"
                    [attr.aria-label]="analysisOpen() ? 'Hide analysis' : 'View analysis'"
                    [attr.aria-pressed]="analysisOpen()">
              <span class="analysis-label full">{{ analysisOpen() ? 'Hide analysis' : 'View analysis' }}</span>
              <span class="analysis-label short">Analysis</span>
              @if (!analysisOpen() && activeFindingIndexes().length > 0) { <span class="analysis-dot"></span> }
            </button>
          }
        </div>
        <div class="topbar-side right">
          @if (p.airplayAvailable()) {
            <button class="icon-btn" (click)="p.showRemotePicker()" title="AirPlay / Cast"><app-icon name="airplay" [size]="20" /></button>
          }
          <!-- Download to this device: caches the audiobook so it plays offline.
               Not shown for on-device books (already local). Once saved the button
               turns purple and swaps to a trash icon — tap again to remove the
               offline copy and go back to streaming from the server. -->
          @if (showDownload()) {
            <button class="icon-btn dl-btn" [class.done]="isDownloaded()" [class.busy]="downloading() || queued()"
                    (click)="onDownloadButton()" [title]="downloadTitle()">
              @if (downloading()) {
                <span class="dl-pct">{{ dlPercent() !== null ? dlPercent() + '%' : '…' }}</span>
              } @else if (queued()) {
                <span class="dl-pct">⋯</span>
              } @else if (isDownloaded()) {
                <app-icon name="trash" [size]="20" />
              } @else {
                <app-icon name="download" [size]="20" />
              }
            </button>
          }
          <button class="icon-btn close" (click)="closeFully()" title="Close">✕</button>
        </div>
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

      <!-- Title/author on their own centered line under the top bar. The
           Sentences/Cover switch that used to live here moved up into the top
           bar; this row has no divider so it dissolves into the body below. -->
      <div class="title-row">
        <div class="t-title">{{ p.book()?.title || 'Player' }}</div>
        @if (p.book()?.author) { <div class="t-author">{{ p.book()!.author }}</div> }
      </div>

      @if (p.error()) {
        <div class="state"><div class="icon">⚠️</div><p>{{ p.error() }}</p></div>
      } @else if (p.loading()) {
        <div class="state"><div class="spinner"></div><p>Loading…</p></div>
      } @else {
        <div class="player-body" [class.analysis-open]="analysisOpen()">
        <div class="playback-column">
        <div class="base-content">
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
        @if (showText()) {
          <!-- Virtualized transcript: only the on-screen rows exist in the DOM,
               so a 15k-sentence book scrolls smoothly. Rows are VARIABLE height
               (a cue is 1–6 lines), so we drive CDK with a per-row height estimate
               (rowSizes) via the variable-size strategy — see var-virtual-scroll.ts. -->
          <cdk-virtual-scroll-viewport class="text-area" [appVarVirtualScroll]="rowSizes()"
            [class.no-follow]="!followText()"
            (wheel)="onUserScroll()" (touchmove)="onUserScroll()">
            <div class="trow" *cdkVirtualFor="let row of rows(); trackBy: trackRow">
              @if (row.type === 'spacer') {
                <div class="tpad" [style.height.px]="row.size" aria-hidden="true"></div>
              } @else if (row.type === 'header') {
                <div class="chapter-header">{{ row.title }}</div>
              } @else {
                <div class="segment"
                  [class.active]="row.cueIndex === p.currentCueIndex()"
                  [class.past]="row.cueIndex < p.currentCueIndex()"
                  (click)="pickSentence(row.cueIndex)">
                  <p>{{ row.text }}</p>
                </div>
              }
            </div>
          </cdk-virtual-scroll-viewport>
        } @else {
          <div class="text-area cover-area">
            <div class="no-text">
              @if (p.coverSrc(); as src) { <img class="big-cover" [src]="src" alt="Cover" /> }
              @else { <div class="big-cover placeholder">🎧</div> }
              <!-- Title/author intentionally omitted here — the cover art already
                   carries them, and the top bar shows them too. -->
              @if (!hasText()) {
                <p class="nt-note">No synced text for this audiobook — chapter navigation only.</p>
              }
            </div>
          </div>
        }
        }
        </div>

        <div class="controls">
          @if (p.currentChapter(); as ch) {
            <div class="chapter-nav">
              <button class="ch-arrow" (click)="p.prevChapter()" [disabled]="!p.canPrevChapter()" title="Previous chapter"><app-icon name="chevron-left" [size]="24" /></button>
              <button class="now-chapter" (click)="chaptersOpen.set(true)" title="Chapters"><span class="nc-label">{{ ch.title }}</span><app-icon name="chevron-down" [size]="14" /></button>
              <button class="ch-arrow" (click)="p.nextChapter()" [disabled]="!p.canNextChapter()" title="Next chapter"><app-icon name="chevron-right" [size]="24" /></button>
            </div>
          }

          <!-- The whole track is the grab target: pointerdown seeks to the touch
               point and every pointer drives a live seek, so you can touch-and-drag
               from anywhere (iOS range inputs only let you grab the thumb — invisible
               here — so they merely jumped). The native <input> is kept purely for
               keyboard seeking; pointer-events are off it so the container drives touch. -->
          <div class="scrub" (pointerdown)="onScrubPointerDown($event)"
               (pointermove)="onScrubPointerMove($event)"
               (pointerup)="onScrubPointerUp($event)" (pointercancel)="onScrubPointerUp($event)">
            <div class="scrub-track">
              @for (seg of heardSegs(); track $index) {
                <span class="heard-seg" [style.left.%]="seg.left" [style.width.%]="seg.width"></span>
              }
            </div>
            @for (n of chapterNotches(); track $index) {
              <span class="notch" [style.left.%]="n"></span>
            }
            <input class="scrubber wide bare" type="range" [min]="scrubMin()" [max]="scrubMax()" step="1"
              [value]="p.currentTime()" (input)="onScrub($event)" />
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
            <button class="t-btn skip-btn min" (click)="p.skipBack(-300)" title="Back 5 min">
              <app-icon name="replay" [size]="30" /><span class="skip-num">5m</span>
            </button>
            <button class="t-btn skip-btn" (click)="p.skipBack(-10)" title="Back 10s">
              <app-icon name="replay" [size]="30" /><span class="skip-num">10</span>
            </button>
            <button class="t-btn play" (click)="p.togglePlay()" [title]="p.isPlaying() ? 'Pause' : 'Play'">
              <app-icon [name]="p.isPlaying() ? 'pause' : 'play'" [size]="30" />
            </button>
            <button class="t-btn skip-btn fwd" (click)="p.skip(10)" title="Forward 10s">
              <app-icon name="replay" [size]="30" /><span class="skip-num">10</span>
            </button>
            <button class="t-btn skip-btn min fwd" (click)="p.skip(300)" title="Forward 5 min">
              <app-icon name="replay" [size]="30" /><span class="skip-num">5m</span>
            </button>
          </div>

          <div class="tool-row">
            <button class="tool speed-pill" (click)="speedOpen.set(true)" title="Playback speed">{{ speedLabel() }}</button>
            <button class="tool" [class.on]="bookmarksOpen()" (click)="toggleBookmarks()" title="Bookmarks"><app-icon name="bookmark" [size]="18" /></button>
            <button class="tool" [class.on]="p.sleepMode() !== 'off'" (click)="onTimerButton()" title="Sleep timer">
              @if (p.sleepMode() !== 'off') { <span class="tool-count">{{ fmt(p.sleepRemaining()) }}</span> }
              @else { <app-icon name="timer" [size]="18" /> }
            </button>
            <!-- On compact analysis layouts this same control follows findings;
                 otherwise it follows synced sentences. Keeping one stable toolbar
                 affordance prevents the mobile controls from changing shape. -->
            <button class="tool" [class.on]="followControlOn()" [disabled]="followControlDisabled()"
                    (click)="toggleFollowControl()" [title]="followControlTitle()">
              <app-icon name="follow" [size]="18" />
            </button>
            <button class="tool" [class.on]="viewMode() === 'text'" [disabled]="!hasText()"
                    (click)="setViewMode(viewMode() === 'text' ? 'cover' : 'text')"
                    [title]="!hasText() ? 'Sentences — no synced text for this book' : viewMode() === 'text' ? 'Showing sentences — tap for cover' : 'Show sentences'">
              <app-icon name="article" [size]="18" />
            </button>
          </div>
        </div>
        </div>

        @if (hasAnalysis()) {
          <aside class="analysis-area"
                 (wheel)="onAnalysisUserScroll()" (touchmove)="onAnalysisUserScroll()"
                 aria-label="Audiobook analysis">
            <div class="analysis-head">
              <div>
                <div class="analysis-title">Analysis</div>
                <div class="analysis-count">
                  {{ analysisFindings().length }} finding{{ analysisFindings().length === 1 ? '' : 's' }}
                  @if (analysisSkippedChunks().length) { · {{ analysisSkippedChunks().length }} gap{{ analysisSkippedChunks().length === 1 ? '' : 's' }} }
                </div>
              </div>
              <div class="analysis-head-actions">
                <button class="analysis-follow" [class.on]="analysisFollow()" (click)="toggleAnalysisFollow()"
                        [title]="analysisFollow() ? 'Following playback' : 'Follow playback'">
                  <app-icon name="follow" [size]="16" /> Follow
                </button>
                <button class="icon-btn sm analysis-close" (click)="closeAnalysis()" title="Close analysis">✕</button>
              </div>
            </div>

            <div class="analysis-scroll" #analysisScroll [class.all-lit]="allAnalysisFindingsLit()">
              @if (analysisSkippedChunks().length) {
                <div class="analysis-gap-warning" role="status">
                  <strong>Analysis incomplete</strong>
                  <span>{{ analysisSkippedChunks().length }} transcript range{{ analysisSkippedChunks().length === 1 ? ' was' : 's were' }} skipped after recovery attempts.</span>
                </div>
              }
              <div class="finding-list">
                <div class="analysis-spacer" [style.height.px]="analysisSpacerSize()" aria-hidden="true"></div>
                @for (finding of analysisFindings(); track $index; let i = $index) {
                  <button class="finding-card list-card" type="button"
                          [attr.data-finding-index]="i"
                          [class.active]="activeFindingIndexes().includes(i)"
                          [class.past]="finding.endTime <= p.currentTime()"
                          [style.--finding-color]="categoryColor(finding)"
                          (click)="pickFinding(finding, i)">
                    <div class="finding-meta">
                      <span class="finding-category">{{ categoryName(finding) }}</span>
                      <span class="severity" [class]="'severity ' + finding.severity">{{ finding.severity }}</span>
                    </div>
                    <p class="finding-analysis">{{ finding.description }}</p>
                    <div class="finding-quote">{{ quotePreview(finding.quote) }}</div>
                    <div class="finding-foot">
                      <span class="finding-time">{{ fmt(finding.startTime) }}</span>
                      <span class="jump-label">Jump to passage</span>
                    </div>
                  </button>
                } @empty {
                  <div class="no-current">This analysis found no passages to flag.</div>
                }
                <div class="analysis-spacer" [style.height.px]="analysisSpacerSize()" aria-hidden="true"></div>
              </div>
            </div>
          </aside>
        }
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
            <div class="sheet-body" #bmBody>
              @for (bm of p.bookmarks(); track bm.id) {
                <div class="row-item bm" [attr.data-bm-id]="bm.id">
                  @if (editingBm() === bm.id) {
                    <span class="bm-auto manual"><app-icon name="bookmark" [size]="14" /></span>
                    <input class="bm-edit" [value]="editDraft()" appFocusSelect
                           placeholder="Name this bookmark"
                           (input)="editDraft.set($any($event.target).value)"
                           (keydown.enter)="commitEdit(bm.id)"
                           (keydown.escape)="cancelEdit()"
                           (blur)="commitEdit(bm.id)" />
                    <button class="bm-act commit" (click)="commitEdit(bm.id)" title="Save"><app-icon name="check" [size]="16" /></button>
                  } @else {
                    <button class="bm-jump" (click)="pickBookmark(bm)">
                      <span class="bm-auto" [class.manual]="(bm.kind ?? 'manual') === 'manual'"><app-icon [name]="bmIcon(bm.kind)" [size]="14" /></span>
                      <span class="bm-text">
                        <span class="row-title">{{ bm.label }}</span>
                        <span class="bm-when">{{ fmtWhen(bm.createdAt) }}</span>
                      </span>
                      <span class="row-time">{{ fmt(bm.position) }}</span>
                    </button>
                    <button class="bm-act" (click)="startEdit(bm)" title="Rename"><app-icon name="edit" [size]="15" /></button>
                    <button class="bm-del" (click)="p.removeBookmark(bm.id)" title="Delete">✕</button>
                  }
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
              <input class="speed-slider wide" type="range" min="0.5" max="5" step="0.05" [value]="p.speed()" (input)="onSpeed($event)" />
              <div class="preset-row">
                <button class="round-btn" (click)="bumpSpeed(-0.05)" title="Slower"><app-icon name="minus" [size]="18" /></button>
                <div class="preset-grid">
                  @for (p of speedPresets; track p) {
                    <button class="preset" [class.on]="isSpeed(p)" (click)="setSpeed(p)">{{ p }}×</button>
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

    /* The panel. Full-screen on phones; a floating, rounded, glowing pop-up on desktop.
       ONE surface color throughout (top bar, body, controls all use --bg-surface) so
       the panel is seamless and the transcript's edge fade reveals that same color —
       black in Midnight, white in Light — instead of the theme's (different) base
       peeking through as a mismatched band. */
    .player { position: relative; z-index: 1; display: flex; flex-direction: column; width: 100%; height: 100%; overflow: hidden; background: var(--bg-surface);
      transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1); will-change: transform; }
    /* While actively dragging, follow the finger with no easing lag; the class
       drops on release so the spring-back (or minimize) animates. */
    .player.dragging { transition: none; }
    /* Floating pop-up only on a genuinely large viewport. The min-height guard
       keeps a phone in landscape (wide but short) full-screen instead of a
       floating panel with a blurred backdrop. */
    @media (min-width: 768px) and (min-height: 601px) {
      .player {
        /* iPad-portrait proportions (~3:4) instead of the old narrow iPhone
           frame — wider so the transcript column breathes. The width cap tracks
           the height cap (680:920 ≈ 3:4) so the panel stays tablet-shaped rather
           than phone-tall on a big monitor. */
        width: min(680px, 94vw);
        height: min(920px, 95vh);
        border-radius: 20px;
        border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border-subtle));
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.55), 0 0 60px -14px color-mix(in srgb, var(--accent) 55%, transparent);
      }
      .player.analysis-open { width: min(1080px, 96vw); }
      .player-body.analysis-open { flex-direction: row; }
      .player-body.analysis-open .playback-column { flex: 1 1 0; min-width: 0; }
      .player-body.analysis-open .analysis-area { display: flex; flex: 0 0 min(380px, 38vw); }
    }

    /* No border-bottom: the top stack (buttons → title → body) is divider-free so
       it reads as one surface (seamless in Midnight, where surface == base). */
    .topbar { display: flex; align-items: center; gap: 8px; flex-shrink: 0;
      padding: calc(8px + env(safe-area-inset-top)) 8px 6px; background: var(--bg-surface); }
    /* Equal-weight side groups so the centered slot is centered on the whole bar,
       not just the space left over after the (variable) right-side buttons. */
    .topbar-side { display: flex; align-items: center; gap: 8px; flex: 1 1 0; min-width: 0; }
    .topbar-side.right { justify-content: flex-end; }
    /* Title/author, own centered line under the bar; no divider (dissolves into body). */
    .title-row { flex-shrink: 0; padding: 0 16px 10px; text-align: center; background: var(--bg-surface); }
    .t-title { font-size: 15px; font-weight: 600; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .t-author { font-size: 12px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon-btn { width: 40px; height: 40px; flex-shrink: 0; border: none; background: var(--bg-elevated); border-radius: 8px; color: var(--text-primary);
      font-size: 22px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; text-decoration: none; }
    .icon-btn.sm { width: 30px; height: 30px; font-size: 14px; background: transparent; color: var(--text-tertiary); }
    .icon-btn.on { background: var(--accent); color: var(--text-on-accent); }
    .icon-btn.close { font-size: 16px; color: var(--text-secondary); }
    /* Download button: purple fill once the book is saved offline (swaps to a
       trash icon) to signal "saved here — tap to delete and use the server". */
    .dl-btn.done { background: var(--downloaded); border-color: var(--downloaded); color: var(--text-on-accent); }
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
      background: color-mix(in srgb, var(--error) 18%, var(--bg-surface)); color: var(--text-primary); border-bottom: 1px solid var(--border-subtle); }


    .state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; color: var(--text-secondary); }
    .state .icon { font-size: 44px; }

    /* Body wraps the transcript + controls. Portrait: vertical stack (transcript
       grows, controls pinned below). Phone landscape: two columns — controls on
       the LEFT (narrower), transcript on the RIGHT (wider), ~2:3. */
    .player-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
    .playback-column { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .base-content { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .analysis-area { display: none; min-width: 0; min-height: 0; flex-direction: column; background: var(--bg-surface); border-left: 1px solid var(--border-subtle); }
    @media (orientation: landscape) and (max-height: 600px) {
      /* row-reverse puts .controls (2nd in DOM) on the left, .text-area on the right.
         All rules are scoped under .player-body so they out-specify the base
         (portrait) rules that appear later in the sheet. */
      .player-body { flex-direction: row-reverse; }
      /* display:contents preserves the original direct transcript/controls flex
         layout after introducing a desktop playback-column wrapper. */
      .player-body .playback-column { display: contents; }
      .player-body .base-content { flex: 3 1 0; min-width: 0; }
      .player-body .text-area { flex: 1 1 0; min-width: 0; }
      .player-body .controls { flex: 2 1 0; min-width: 0; overflow-y: auto; border-top: none; border-right: 1px solid var(--border-subtle); align-self: stretch;
        display: flex; flex-direction: column; justify-content: safe center; padding: 6px 12px calc(6px + env(safe-area-inset-bottom)); }
      /* Tighten the control cluster so it fits the short landscape height. */
      .player-body .chapter-nav { margin-bottom: 2px; }
      .player-body .scrub-labels { margin-top: 2px; }
      .player-body .transport { padding: 6px 0 4px; }
      .player-body .t-btn { width: 44px; height: 44px; min-width: 44px; }
      .player-body .t-btn.play { width: 52px; height: 52px; }
      .player-body .tool-row { margin-top: 6px; padding-top: 8px; }
      .player-body .tool { width: 40px; height: 40px; }
      /* Analysis replaces the transcript/cover on a short mobile landscape while
         preserving the existing controls-left / content-right arrangement. */
      .player-body.analysis-open { flex-direction: row; }
      .player-body.analysis-open .playback-column { display: contents; }
      .player-body.analysis-open .base-content { display: none; }
      .player-body.analysis-open .controls { order: 1; flex: 2 1 0; }
      .player-body.analysis-open .analysis-area { order: 2; display: flex; flex: 3 1 0; border-left: 1px solid var(--border-subtle); }
    }

    /* Portrait phone / narrow web: Analysis is an independent overlay state over
       the center content only. Controls remain mounted below it, and closing it
       reveals the exact Sentences/Cover choice that was underneath. */
    @media (max-width: 767px) and (orientation: portrait),
           (max-width: 767px) and (min-height: 601px) {
      .player-body.analysis-open .playback-column { display: contents; }
      .player-body.analysis-open .base-content { display: none; }
      .player-body.analysis-open .analysis-area { display: flex; order: 1; flex: 1 1 0; border-left: none; }
      .player-body.analysis-open .controls { order: 2; }
    }

    .text-area { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 12px 24px; scroll-behavior: smooth; }
    .chapter-header { padding: 18px 6px 8px; font-size: 15px; font-weight: 700; color: var(--accent); border-bottom: 1px solid var(--border-subtle); margin: 0 20px 8px; }
    .chapter-header:first-child { padding-top: 4px; }
    /* CDK viewport owns the scroll; its content wrapper spans the full column.
       Fade the top/bottom edges to transparent so sentences dissolve into the
       black backdrop as they scroll off — a soft vignette instead of a hard cut.
       The mask is fixed to the viewport, so rows scroll under it. */
    cdk-virtual-scroll-viewport.text-area { contain: strict;
      -webkit-mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.12) 24px, rgba(0,0,0,0.5) 56px, #000 96px, #000 calc(100% - 96px), rgba(0,0,0,0.5) calc(100% - 56px), rgba(0,0,0,0.12) calc(100% - 24px), transparent 100%);
      mask-image: linear-gradient(to bottom, transparent 0, rgba(0,0,0,0.12) 24px, rgba(0,0,0,0.5) 56px, #000 96px, #000 calc(100% - 96px), rgba(0,0,0,0.5) calc(100% - 56px), rgba(0,0,0,0.12) calc(100% - 24px), transparent 100%); }
    .trow { display: block; } /* one virtualized row; no box of its own */
    .tpad { display: block; pointer-events: none; } /* top/bottom scroll spacer */
    /* .segment's padding+border+margin here MUST stay in sync with
       estimateRowHeight() in the component (30px chrome + 27.2px/line), or the
       scroll estimate drifts from the real layout. */
    .segment { padding: 10px 12px; margin: 0 20px 6px; border-radius: 8px; background: var(--bg-surface); border: 2px solid transparent;
      cursor: pointer; transition: opacity 0.7s ease, border-color 0.3s ease, background 0.3s ease; opacity: 0.62; }
    .segment.past { opacity: 0.4; }
    .segment.active { opacity: 1; border-color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, var(--bg-surface)); }
    /* When not following, dimming just hurts readability — light everything up
       (the current sentence keeps its accent outline for reference). */
    .text-area.no-follow .segment { opacity: 1; }
    .segment p { margin: 0; font-size: 17px; line-height: 1.6; color: var(--text-primary); }

    /* Cover view is a plain div (NOT the cdk viewport), so it carries no fade mask —
       the artwork stays crisp edge-to-edge. It also NEVER scrolls: the cover is
       locked to fit the visible area (overflow hidden + the image shrinks to fit). */
    .cover-area { overflow: hidden; }
    .no-text { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; padding: 16px; }
    /* Size to the cover's natural aspect (square audiobook art or 6×9) instead of
       forcing 2:3 — no cropping or letterboxing. Fills the available area but
       shrinks (min-height:0 + flex-shrink) so it — and the optional note — always
       fit without scrolling. */
    .big-cover { border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,0.4); background: var(--bg-elevated); }
    img.big-cover { max-width: 100%; max-height: 100%; width: auto; height: auto; min-height: 0; flex: 0 1 auto; object-fit: contain; }
    .big-cover.placeholder { width: 300px; max-width: 100%; max-height: 100%; aspect-ratio: 2/3; flex: 0 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; font-size: 88px; color: var(--text-tertiary); }
    .nt-note { font-size: 13px; color: var(--text-tertiary); margin-top: 12px; }

    /* Verified audiobook analysis rail / mobile center view. */
    .analysis-toggle { position: relative; width: auto; min-width: 78px; padding: 0 12px; font-size: 12px; font-weight: 700; white-space: nowrap; }
    .analysis-label.short { display: none; }
    .analysis-dot { position: absolute; top: 5px; right: 5px; width: 8px; height: 8px; border-radius: 50%; background: var(--warning, #f6b73c);
      box-shadow: 0 0 0 2px var(--bg-elevated); }
    .analysis-toggle.on .analysis-dot { box-shadow: 0 0 0 2px var(--accent); }
    @media (max-width: 420px) {
      .analysis-toggle { min-width: 68px; padding: 0 9px; }
      .analysis-label.full { display: none; }
      .analysis-label.short { display: inline; }
    }
    .analysis-head { flex-shrink: 0; min-height: 58px; padding: 10px 12px 9px 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px;
      border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface); }
    .analysis-title { font-size: 16px; line-height: 1.2; font-weight: 700; color: var(--text-primary); }
    .analysis-count { margin-top: 2px; font-size: 11px; color: var(--text-tertiary); }
    .analysis-head-actions { display: flex; align-items: center; gap: 6px; }
    .analysis-follow { height: 32px; padding: 0 10px; border: 1px solid var(--border-subtle); border-radius: 16px; background: var(--bg-elevated); color: var(--text-secondary);
      display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; cursor: pointer; }
    .analysis-follow.on { border-color: color-mix(in srgb, var(--accent) 65%, var(--border-subtle)); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--bg-elevated)); }
    @media (max-width: 767px), (max-height: 600px) {
      /* The shared toolbar Follow control owns the center view on compact
         layouts, exactly as it does for Sentences. Keep one control, not two. */
      .analysis-follow { display: none; }
    }
    .analysis-close { background: transparent; }
    .analysis-scroll { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; padding: 0 14px; }
    .analysis-gap-warning { margin: 14px 0 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 3px; border: 1px solid color-mix(in srgb, var(--warning, #d69222) 55%, var(--border-subtle)); border-radius: 10px;
      background: color-mix(in srgb, var(--warning, #d69222) 10%, var(--bg-elevated)); color: var(--text-secondary); font-size: 12px; line-height: 1.4; }
    .analysis-gap-warning strong { color: var(--warning, #d69222); font-size: 12px; }
    .no-current { min-height: 58px; display: flex; align-items: center; padding: 12px; border: 1px dashed var(--border-subtle); border-radius: 10px; color: var(--text-tertiary); font-size: 13px; }
    .finding-list { display: flex; flex-direction: column; gap: 12px; }
    .analysis-spacer { flex: 0 0 auto; min-height: 80px; pointer-events: none; }
    .finding-card { --finding-color: var(--accent); position: relative; display: block; width: 100%; padding: 13px 14px 13px 16px; overflow: hidden;
      border: 1px solid var(--border-subtle); border-radius: 11px; background: var(--bg-elevated); color: var(--text-primary); text-align: left; }
    .finding-card::before { content: ''; position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--finding-color); }
    .finding-card.list-card { cursor: pointer; font: inherit; opacity: 0.62; transition: opacity 0.35s ease, border-color 0.25s ease, background 0.25s ease; }
    .finding-card.list-card.past { opacity: 0.4; }
    .finding-card.list-card.active { opacity: 1; border-color: var(--finding-color); background: color-mix(in srgb, var(--finding-color) 8%, var(--bg-elevated)); box-shadow: 0 8px 24px rgba(0,0,0,0.18); }
    .analysis-scroll.all-lit .finding-card.list-card,
    .analysis-scroll.all-lit .finding-card.list-card.past { opacity: 1; }
    .finding-meta, .finding-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .finding-category { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 700; color: var(--finding-color); }
    .finding-time { flex-shrink: 0; font-size: 11px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
    .finding-analysis { margin: 10px 0 0; font-size: 15px; line-height: 1.5; font-weight: 620; color: var(--text-primary); }
    .finding-quote { margin-top: 9px; overflow: hidden; color: var(--text-tertiary); font-size: 11px; font-style: italic; line-height: 1.4; white-space: nowrap; text-overflow: ellipsis; }
    .finding-foot { margin-top: 10px; }
    .severity { padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 800; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-secondary); background: var(--bg-surface); }
    .severity.high { color: var(--error); background: color-mix(in srgb, var(--error) 12%, var(--bg-surface)); }
    .severity.medium { color: var(--warning, #d69222); background: color-mix(in srgb, var(--warning, #d69222) 12%, var(--bg-surface)); }
    .severity.low { color: var(--text-secondary); }
    .jump-label { font-size: 11px; font-weight: 600; color: var(--accent); }

    /* No border-top: controls share the surface and fade in from the body. */
    .controls { flex-shrink: 0; padding: 10px 16px calc(10px + env(safe-area-inset-bottom)); background: var(--bg-surface); }

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
    /* touch-action:none so a slightly-diagonal drag stays with the scrubber
       instead of the WKWebView stealing it as a scroll (the old "it only jumps"
       feel). The container owns all pointer input; see onScrubPointerDown. */
    .scrub { position: relative; display: flex; align-items: center; height: 22px; touch-action: none; }
    .scrub-track { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); height: 4px; border-radius: 2px; background: var(--bg-elevated); overflow: hidden; pointer-events: none; }
    .heard-seg { position: absolute; top: 0; bottom: 0; background: var(--accent); }
    /* Chapter-boundary notches (whole-book mode): ticks that cut the track, exactly track-height. */
    /* z-index 2 keeps the notches above the range input (z-index 1): iOS WKWebView
       composites native form controls into a layer that paints over lower siblings,
       which hid the notches on-device. pointer-events:none still lets drags through. */
    .notch { position: absolute; top: 50%; transform: translate(-50%, -50%); width: 2px; height: 4px; background: var(--bg-surface); pointer-events: none; z-index: 2; }
    /* pointer-events off: the .scrub container handles touch/mouse dragging; the
       input stays in the DOM only for keyboard seeking (arrow keys still fire input). */
    .scrubber.bare { position: relative; z-index: 1; background: transparent; pointer-events: none; }
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
    /* The speed sheet's background is also --bg-elevated, so a --bg-elevated track
       was invisible (white-on-white in light theme). Give it a contrasting track. */
    .speed-slider { background: color-mix(in srgb, var(--text-primary) 22%, transparent); }
    .speed-slider::-webkit-slider-runnable-track { background: color-mix(in srgb, var(--text-primary) 22%, transparent); }
    .speed-slider::-moz-range-track { background: color-mix(in srgb, var(--text-primary) 22%, transparent); }

    /* Transport + tool row share a 5-column grid so each tool sits directly under
       its transport button (speed↔−5m, bookmark↔−10s, timer↔play, follow↔+10s,
       sentences↔+5m). Each button is centered in its column, so the play/tool
       size differences don't throw the columns off. */
    .transport { display: grid; grid-template-columns: repeat(5, 1fr); align-items: center; justify-items: center; padding: 14px 0 8px; max-width: 340px; margin-left: auto; margin-right: auto; }
    .t-btn { position: relative; min-width: 52px; width: 52px; height: 52px; border: none; border-radius: 50%; background: var(--bg-hover); color: var(--text-primary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; }
    .t-btn:disabled { opacity: 0.3; }
    /* Outer ±5-minute buttons: same size as the ±10s buttons (just a muted color). */
    .t-btn.min { color: var(--text-secondary); }
    .skip-num { position: absolute; top: 54%; left: 50%; transform: translate(-50%, -50%); font-size: 10px; font-weight: 700; pointer-events: none; }
    /* "5m" is wider than "10" (the 'm'), so shrink just this label to sit cleanly
       inside the replay glyph. */
    .t-btn.min .skip-num { font-size: 7.5px; letter-spacing: -0.2px; }
    .t-btn.fwd app-icon { transform: scaleX(-1); }
    .t-btn.play { width: 64px; height: 64px; background: var(--accent); color: var(--text-on-accent); }

    /* Bottom tool row: four identical round buttons (speed, bookmark, timer, follow).
       A divider separates it from the transport row above. */
    .tool-row { display: grid; grid-template-columns: repeat(5, 1fr); align-items: center; justify-items: center; margin: 10px auto 0; max-width: 340px; padding-top: 14px; border-top: 1px solid var(--border-subtle); }
    .tool { flex-shrink: 0; width: 46px; height: 46px; padding: 0; border: none; border-radius: 50%; background: var(--bg-elevated); color: var(--text-secondary);
      cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 600; }
    .tool.on { background: var(--accent); color: var(--text-on-accent); }
    .tool:disabled { opacity: 0.3; cursor: default; }
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
    .sleep-circle { width: clamp(92px, 25vmin, 150px); height: clamp(92px, 25vmin, 150px); border-radius: 50%; border: none; background: var(--accent); color: var(--text-on-accent);
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
    .ts-start { width: 100%; padding: 15px; border: none; border-radius: 14px; background: var(--accent); color: var(--text-on-accent);
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
    .preset-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
    /* 8 presets (1×–2.75×) in two rows of four, flanked by the ± fine-adjust buttons. */
    .preset-grid { flex: 1; display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    .preset { height: 40px; border: none; border-radius: 20px; background: var(--bg-hover); color: var(--text-primary); cursor: pointer; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .preset.on { background: var(--accent); color: var(--text-on-accent); }
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
    .bm-act { flex-shrink: 0; width: 36px; height: 36px; border: none; background: transparent; color: var(--text-tertiary); cursor: pointer; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center; }
    .bm-act:hover, .bm-act.commit { color: var(--accent); }
    .bm-edit { flex: 1; min-width: 0; margin: 6px 0; padding: 8px 10px; font-size: 14px; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--accent); border-radius: 8px; outline: none; }
    /* In edit mode the leading icon is a direct child (no .bm-jump wrapper to inset it). */
    .row-item.bm > .bm-auto { margin-left: 10px; }
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

  private readonly textViewport = viewChild(CdkVirtualScrollViewport);
  private readonly bmBody = viewChild<ElementRef<HTMLElement>>('bmBody');
  private readonly analysisScroll = viewChild<ElementRef<HTMLElement>>('analysisScroll');

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

  // Analysis is deliberately independent from Sentences/Cover. On a phone it
  // temporarily occupies the center content slot; closing it reveals the base
  // choice unchanged. On desktop CSS presents the same element as a right rail.
  readonly analysisOpen = signal(false);
  readonly analysisFollow = signal(true);
  readonly desktopAnalysisRail = signal(window.innerWidth >= 768 && window.innerHeight >= 601);
  readonly hasAnalysis = computed(() => !!this.p.analysis());
  readonly analysisFindings = computed<AudiobookAnalysisFinding[]>(() =>
    [...(this.p.analysis()?.payload.flags ?? [])].sort((a, b) => a.startTime - b.startTime),
  );
  readonly analysisSkippedChunks = computed<AudiobookAnalysisSkippedChunk[]>(() =>
    [...(this.p.analysis()?.payload.skippedChunks ?? [])].sort((a, b) => a.startTime - b.startTime),
  );
  readonly analysisSpacerSize = signal(160);
  readonly activeFindingIndexes = computed<number[]>(() => {
    const t = this.p.currentTime();
    const cue = this.p.currentCueIndex();
    const out: number[] = [];
    for (let i = 0; i < this.analysisFindings().length; i++) {
      const f = this.analysisFindings()[i];
      const hasTimeRange = Number.isFinite(f.startTime) && Number.isFinite(f.endTime) && f.endTime > f.startTime;
      const byTime = hasTimeRange && t >= f.startTime && t < f.endTime;
      const byCue = !hasTimeRange && Number.isInteger(f.cueStartIndex) && Number.isInteger(f.cueEndIndex)
        && cue >= f.cueStartIndex && cue <= f.cueEndIndex;
      if (byTime || byCue) out.push(i);
    }
    return out;
  });
  readonly primaryActiveFindingIndex = computed<number | null>(() =>
    this.activeFindingIndexes()[0] ?? null,
  );
  readonly allAnalysisFindingsLit = computed(() =>
    !this.analysisFollow() || this.primaryActiveFindingIndex() === null,
  );
  readonly followControlsAnalysis = computed(() =>
    this.analysisOpen() && !this.desktopAnalysisRail(),
  );
  readonly followControlOn = computed(() => this.followControlsAnalysis()
    ? this.analysisFollow()
    : this.hasText() && this.followText());
  readonly followControlDisabled = computed(() => this.followControlsAnalysis() ? false : !this.hasText());

  // ── Virtualized transcript ────────────────────────────────────────────────
  // The transcript can be 15k+ sentences; rendering them all stutters on the
  // phone. We virtualize with CDK, but sentences are VARIABLE height (1–6 lines),
  // so a fixed itemSize won't do — we estimate each row's height from its
  // character count and feed those to a variable-size strategy (var-virtual-scroll.ts).
  // Rows still render at their true height; only positioning uses the estimate.

  /** Chapter headers + sentence cues, flattened into one render list, wrapped in
   *  half-viewport spacers top and bottom so the first / current / last line can
   *  scroll to the vertical center rather than hiding under the edge fade. */
  readonly rows = computed<TranscriptRow[]>(() => {
    const cues = this.p.cues();
    const headers = this.p.chapterStartMap();
    const out: TranscriptRow[] = [];
    if (cues.length === 0) return out;
    const pad = this.padSize();
    out.push({ type: 'spacer', size: pad, key: 'pad-top' });
    for (const cue of cues) {
      const title = headers.get(cue.index);
      if (title) out.push({ type: 'header', title, key: `h${cue.index}` });
      out.push({ type: 'sentence', cueIndex: cue.index, text: cue.text, key: `s${cue.index}` });
    }
    out.push({ type: 'spacer', size: pad, key: 'pad-bottom' });
    return out;
  });

  /** cue index → row index, so follow/seek can scroll to a sentence's row. */
  private readonly cueRow = computed<Map<number, number>>(() => {
    const map = new Map<number, number>();
    const rows = this.rows();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (r.type === 'sentence') map.set(r.cueIndex, i);
    }
    return map;
  });

  // Panel width sets how many characters fit per wrapped line (→ how tall a cue
  // is). Seeded from the window; re-measured from the real viewport on resize
  // and when the transcript is shown (the desktop pop-up is narrower than the window).
  private readonly contentWidth = signal(Math.min(window.innerWidth, 720));

  // Transcript viewport height, measured alongside the width. Drives the size of
  // the top/bottom scroll spacers so a line can reach the exact vertical center.
  private readonly viewportHeight = signal(window.innerHeight || 800);

  /** Height of each top/bottom scroll spacer: half the viewport, so the first,
   *  current, and last line can all sit centered (the centering scroll needs a
   *  screenful of slack above the first row and below the last). */
  readonly padSize = computed(() => Math.max(120, Math.round(this.viewportHeight() / 2)));

  /** Estimated pixel height of each row, in render order — fed to the strategy. */
  readonly rowSizes = computed<number[]>(() => this.rows().map((r) => this.estimateRowHeight(r)));

  /** Prefix sums of rowSizes (row top offsets), for centering a row on scroll. */
  private readonly rowOffsets = computed<number[]>(() => {
    const sizes = this.rowSizes();
    const off = new Array<number>(sizes.length + 1);
    off[0] = 0;
    for (let i = 0; i < sizes.length; i++) off[i + 1] = off[i] + sizes[i];
    return off;
  });

  /** Chars that fit on one wrapped line inside a sentence, from the panel width. */
  private charsPerLine(): number {
    // text width = panel − segment margin (20×2) − segment padding (12×2); a
    // 17px proportional glyph averages ~8px wide. Floor at 20 for tiny screens.
    // (The viewport's own padding doesn't offset the absolutely-positioned virtual
    // rows, so the visible inset comes entirely from the segment's margin/padding.)
    const textWidth = this.contentWidth() - 40 - 24;
    return Math.max(20, Math.floor(textWidth / 8));
  }

  /** Estimate a row's rendered height (approximate is fine — see the strategy). */
  private estimateRowHeight(row: TranscriptRow): number {
    if (row.type === 'spacer') return row.size; // rendered at exactly this height
    const cpl = this.charsPerLine();
    if (row.type === 'header') {
      const lines = Math.max(1, Math.ceil(row.title.length / cpl));
      return 35 + lines * 19; // padding 26 + border 1 + margin 8, ~19px/line
    }
    const lines = Math.max(1, Math.ceil(row.text.length / cpl));
    return 30 + Math.ceil(lines * 27.2); // padding 20 + border 4 + margin 6, 27.2px/line
  }

  /** Stable identity for a transcript row (cdkVirtualFor trackBy). */
  trackRow = (_: number, row: TranscriptRow): string => row.key;

  /** Read the real panel width AND height so row-height estimates and the
   *  centering spacers match the actual layout. */
  private measureViewport(): void {
    const vp = this.textViewport();
    const w = vp ? vp.elementRef.nativeElement.clientWidth : 0;
    this.contentWidth.set(w > 0 ? w : Math.min(window.innerWidth, 720));
    const h = vp ? vp.getViewportSize() : 0;
    this.viewportHeight.set(h > 0 ? h : (window.innerHeight || 800));
  }

  private readonly onResize = (): void => {
    this.desktopAnalysisRail.set(window.innerWidth >= 768 && window.innerHeight >= 601);
    this.measureViewport();
    this.measureAnalysisViewport();
    this.textViewport()?.checkViewportSize();
  };

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
  /** Waiting its turn in the download queue (drives the button's Cancel state). */
  readonly queued = computed(() => {
    const b = this.p.book();
    return !!b && this.actions.isQueued(b);
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
    if (this.queued()) return 'Queued for download — tap to cancel';
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
    // Streaming or waiting in the queue → tapping cancels.
    if (this.actions.isDownloading(b) || this.actions.isQueued(b)) { this.actions.cancelDownload(b); return; }
    if (this.actions.isDownloaded(b)) {
      this.dlError.set(null);
      try {
        await this.actions.removeDownload(b);
      } catch (err) {
        this.dlError.set(err instanceof Error ? err.message : 'Failed to remove download');
      }
      return;
    }
    // Queued fire-and-forget; a failure surfaces as a shelf toast (offline.errors()).
    this.dlError.set(null);
    this.actions.downloadAudiobook(b);
  }

  constructor() {
    // When "follow text" is on, keep the active line centered as playback moves.
    effect(() => {
      const idx = this.p.currentCueIndex();
      if (!this.followText()) return;
      this.scrollCueIntoView(idx);
    });
    // Analysis has its own follow state: browsing findings never disables the
    // transcript's follow behavior (and vice versa).
    effect(() => {
      const idx = this.primaryActiveFindingIndex();
      if (!this.analysisOpen() || !this.analysisFollow() || idx == null) return;
      requestAnimationFrame(() => this.scrollFindingIntoView(idx));
    });
    // Discrete seeks (chapter/skip/bookmark) scroll even while paused/not following.
    effect(() => {
      this.p.scrollTick();
      requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
    });
    // Returning to the foreground re-centers on the current sentence at once (when
    // following), so opening the app mid-playback lands on the word being read
    // rather than a sentence behind. Re-measures first: the viewport may have been
    // resized (rotation, keyboard) while we were away. See PlayerService.resumeTick.
    effect(() => {
      this.p.resumeTick();
      if (!this.followText()) return;
      requestAnimationFrame(() => {
        this.measureViewport();
        this.scrollCueIntoView(this.p.currentCueIndex());
      });
    });
    // Close Sleep Mode when the timer ends (expiry or cancel).
    effect(() => {
      if (this.p.sleepMode() === 'off') this.sleepModeOpen.set(false);
    });
    // Keep the screen awake while the sleep timer is ARMED (sleepMode !== 'off'),
    // not merely while the countdown overlay is visible. The phone shouldn't sleep
    // out from under a running timer even after "Show text" dismisses the overlay.
    // On expiry or cancel, sleepMode flips to 'off' and the lock releases so the
    // phone can lock/sleep gradually as usual.
    effect(() => {
      if (this.p.sleepMode() !== 'off') void this.acquireWakeLock();
      else this.releaseWakeLock();
    });
  }

  /** Switch the body between the synced transcript and the cover, and remember it.
   *  Returning to text re-centers on the current spot so it doesn't land scrolled away. */
  setViewMode(mode: 'text' | 'cover'): void {
    this.viewMode.set(mode);
    localStorage.setItem('bookshelf-player-view', mode);
    // The viewport is (re)created by the @if when text mode turns on — let it
    // mount, size itself, and re-measure the column, then land on the current spot.
    if (mode === 'text') {
      requestAnimationFrame(() => {
        this.measureViewport();
        this.textViewport()?.checkViewportSize();
        this.scrollCueIntoView(this.p.currentCueIndex());
      });
    }
  }

  toggleFollow(): void {
    const on = !this.followText();
    this.followText.set(on);
    // Turning it on jumps to where playback currently is.
    if (on) requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
  }

  toggleFollowControl(): void {
    if (this.followControlsAnalysis()) this.toggleAnalysisFollow();
    else this.toggleFollow();
  }

  followControlTitle(): string {
    if (this.followControlsAnalysis()) {
      return this.analysisFollow() ? 'Following analysis' : 'Follow analysis';
    }
    if (!this.hasText()) return 'Follow text — no synced text for this book';
    return this.followText() ? 'Following text' : 'Follow text';
  }

  /** A user scroll gesture (wheel/touch) turns off follow so it stops fighting
   *  them. Programmatic auto-scroll never fires wheel/touchmove, so it's safe. */
  onUserScroll(): void {
    if (this.followText()) this.followText.set(false);
  }

  toggleAnalysis(): void {
    if (!this.hasAnalysis()) return;
    if (this.analysisOpen()) { this.closeAnalysis(); return; }
    this.analysisOpen.set(true);
    this.analysisFollow.set(true);
    requestAnimationFrame(() => {
      this.measureAnalysisViewport();
      const idx = this.primaryActiveFindingIndex();
      if (idx != null) this.scrollFindingIntoView(idx);
    });
  }

  closeAnalysis(): void {
    this.analysisOpen.set(false);
    // The base view was never changed; a phone returns to the same text/cover.
    if (this.showText()) requestAnimationFrame(() => this.scrollCueIntoView(this.p.currentCueIndex()));
  }

  toggleAnalysisFollow(): void {
    const on = !this.analysisFollow();
    this.analysisFollow.set(on);
    if (on) {
      const idx = this.primaryActiveFindingIndex();
      if (idx != null) requestAnimationFrame(() => this.scrollFindingIntoView(idx));
    }
  }

  onAnalysisUserScroll(): void {
    if (this.analysisFollow()) this.analysisFollow.set(false);
  }

  pickFinding(finding: AudiobookAnalysisFinding, index: number): void {
    this.p.seekTo(finding.startTime, true);
    this.analysisFollow.set(true);
    requestAnimationFrame(() => this.scrollFindingIntoView(index));
  }

  categoryName(finding: AudiobookAnalysisFinding): string {
    return this.p.analysis()?.payload.categories.find(c => c.id === finding.categoryId)?.name || finding.categoryId;
  }

  categoryColor(finding: AudiobookAnalysisFinding): string {
    return this.p.analysis()?.payload.categories.find(c => c.id === finding.categoryId)?.color || 'var(--accent)';
  }

  quotePreview(quote: string): string {
    const normalized = quote.replace(/\s+/g, ' ').trim();
    const preview = normalized.length > 50 ? `${normalized.slice(0, 50).trimEnd()}…` : normalized;
    return `“${preview}”`;
  }

  private measureAnalysisViewport(): void {
    const viewport = this.analysisScroll()?.nativeElement;
    if (!viewport || viewport.clientHeight <= 0) return;
    this.analysisSpacerSize.set(Math.max(80, Math.round(viewport.clientHeight / 2)));
  }

  private scrollFindingIntoView(index: number): void {
    const viewport = this.analysisScroll()?.nativeElement;
    const card = viewport?.querySelector(`[data-finding-index="${index}"]`) as HTMLElement | null;
    if (!viewport || !card) return;
    const viewportRect = viewport.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = cardRect.top - viewportRect.top - (viewport.clientHeight - cardRect.height) / 2;
    viewport.scrollTo({ top: Math.max(0, viewport.scrollTop + delta), behavior: 'smooth' });
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
    window.addEventListener('resize', this.onResize);
    // Once the transcript has mounted, measure the real column width (feeds the
    // row-height estimates) and land on the current spot.
    requestAnimationFrame(() => {
      this.measureViewport();
      this.scrollCueIntoView(this.p.currentCueIndex());
    });
  }

  ngOnDestroy(): void {
    // Intentionally do NOT stop audio — it keeps playing under the mini-bar.
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('resize', this.onResize);
    this.releaseWakeLock();
  }

  // ── Keep screen awake during Sleep Mode ───────────────────────────────────────
  private wakeLock: any = null;
  private readonly onVisibility = (): void => {
    // The OS drops the lock when the tab is hidden; re-acquire if Sleep Mode is still up.
    if (document.visibilityState === 'visible' && this.p.sleepMode() !== 'off' && !this.wakeLock) void this.acquireWakeLock();
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

  /** Spacebar toggles play/pause — unless the user is typing (e.g. renaming a
   *  bookmark) or focused on a button that Space would otherwise activate. */
  @HostListener('document:keydown', ['$event'])
  onKeydown(e: KeyboardEvent): void {
    if (e.key !== ' ' && e.code !== 'Space') return;
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) return;
    e.preventDefault();
    this.p.togglePlay();
  }

  /** Down button: leave the full view; audio keeps playing and the mini-bar appears. */
  minimize(): void {
    if (history.length > 1) this.location.back();
    else this.router.navigate(['/']);
  }

  // ── Swipe-down-to-minimize ─────────────────────────────────────────────────
  // Grab any "plain" surface (cover, title, top-bar/controls background) and drag
  // down to dismiss — the sheet follows the finger and minimizes past a threshold.
  // Interactive/scrollable regions are excluded so it never fights the transcript
  // scroll, the scrubber, buttons, or an open sheet.
  readonly dragY = signal(0);
  readonly isDragging = signal(false);
  private dragStartY = 0;
  private dragStartX = 0;
  private static readonly DRAG_MINIMIZE_PX = 90;

  /** Panel offset: the mini-bar's in-progress expand drag wins, else our own
   *  swipe-down-to-minimize drag, else resting (0). */
  readonly panelTransform = computed(() => {
    const ey = this.p.expandY();
    if (ey != null) return `translateY(${ey}px)`;
    const dy = this.dragY();
    return dy ? `translateY(${dy}px)` : null;
  });
  /** Fade the blurred backdrop in as the panel rises during an expand drag —
   *  scaled to the travel (rest = mini-bar position → 0 = fully open). */
  readonly expandScrim = computed(() => {
    const ey = this.p.expandY();
    if (ey == null) return null;
    const rest = this.p.expandRest() || window.innerHeight || 1;
    return Math.max(0, Math.min(1, 1 - ey / rest));
  });
  private static readonly DRAG_EXCLUDE =
    'button, input, a, .scrub, cdk-virtual-scroll-viewport, .analysis-area, .sheet, .sheet-backdrop';

  onDragStart(e: TouchEvent): void {
    if (e.touches.length !== 1) { this.isDragging.set(false); return; }
    const target = e.target as HTMLElement;
    if (target.closest(PlayerComponent.DRAG_EXCLUDE)) { this.isDragging.set(false); return; }
    this.dragStartY = e.touches[0].clientY;
    this.dragStartX = e.touches[0].clientX;
    this.isDragging.set(true);
  }

  onDragMove(e: TouchEvent): void {
    if (!this.isDragging()) return;
    const dy = e.touches[0].clientY - this.dragStartY;
    const dx = e.touches[0].clientX - this.dragStartX;
    // A clearly horizontal or upward move isn't a dismiss — bail and let it be.
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
      if (Math.abs(dx) > Math.abs(dy)) this.isDragging.set(false);
      this.dragY.set(0);
      return;
    }
    if (e.cancelable) e.preventDefault(); // suppress rubber-band while dragging
    this.dragY.set(dy);
  }

  onDragEnd(): void {
    if (!this.isDragging()) return;
    const dy = this.dragY();
    this.isDragging.set(false);
    this.dragY.set(0); // springs back (transition re-enabled) if under threshold
    if (dy > PlayerComponent.DRAG_MINIMIZE_PX) this.minimize();
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
    return kind === 'open' ? 'book' : kind === 'resume' ? 'play' : kind === 'hour' ? 'timer' : kind === 'chapter' ? 'next' : kind === 'sleep' ? 'timer' : kind === 'jump' ? 'replay' : kind === 'arrive' ? 'follow' : 'bookmark';
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

  /** Open the bookmarks sheet scrolled to the bottom — the list is position-sorted,
   *  so the newest/furthest-along bookmarks (the ones you likely just dropped) sit
   *  there. Tapping again closes it. */
  toggleBookmarks(): void {
    if (this.bookmarksOpen()) { this.bookmarksOpen.set(false); return; }
    this.bookmarksOpen.set(true);
    requestAnimationFrame(() => {
      const el = this.bmBody()?.nativeElement;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  pickBookmark(bm: { position: number }): void {
    this.bookmarksOpen.set(false);
    this.p.seekTo(bm.position, true);
  }

  // Inline bookmark rename. editingBm holds the id whose row is in edit mode;
  // editDraft is the live text. Enter / the ✓ button / blur commit; Escape
  // cancels. Kept in the sheet (no modal) so it doesn't stack over the sheet.
  readonly editingBm = signal<string | null>(null);
  readonly editDraft = signal('');

  startEdit(bm: Bookmark): void {
    this.editDraft.set(bm.label);
    this.editingBm.set(bm.id);
  }

  commitEdit(id: string): void {
    // Clearing the input (Escape/blur) fires a second blur→commit, and tapping
    // ✓ fires blur then click — both re-enter here. Guard so we save once.
    if (this.editingBm() !== id) return;
    this.editingBm.set(null);
    this.p.renameBookmark(id, this.editDraft()); // ignores empty/whitespace
  }

  cancelEdit(): void {
    this.editingBm.set(null);
  }

  addBookmark(): void {
    const before = new Set(this.p.bookmarks().map((b) => b.id));
    const ch = this.p.currentChapter();
    const t = this.fmt(this.p.currentTime());
    this.p.addBookmark(ch ? `${ch.title} · ${t}` : t);
    // Reveal the just-added bookmark (the list is position-sorted, so it may land
    // anywhere) — scroll its row into view so the user sees it was added.
    const added = this.p.bookmarks().find((b) => !before.has(b.id));
    if (added) {
      requestAnimationFrame(() => {
        const el = this.bmBody()?.nativeElement.querySelector(`[data-bm-id="${added.id}"]`) as HTMLElement | null;
        el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }

  private scrubbing = false;
  private scrubFromPos = 0;
  private scrubEl: HTMLElement | null = null;

  /** Touch/mouse down anywhere on the track: grab it and seek to the point. */
  onScrubPointerDown(e: PointerEvent): void {
    this.scrubEl = e.currentTarget as HTMLElement;
    try { this.scrubEl.setPointerCapture(e.pointerId); } catch { /* capture unsupported */ }
    this.scrubbing = true;
    this.scrubFromPos = this.p.currentTime();
    this.seekToClientX(e.clientX);
  }

  /** Every move while held drives a live seek — this is the touch-and-drag. */
  onScrubPointerMove(e: PointerEvent): void {
    if (!this.scrubbing) return;
    this.seekToClientX(e.clientX);
  }

  onScrubPointerUp(e: PointerEvent): void {
    if (!this.scrubbing) return;
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    this.onScrubEnd();
  }

  /** Map an x within the track to a time in the current scrub range, snapped to
   *  listened-edge / chapter marks, and seek there. */
  private seekToClientX(clientX: number): void {
    const el = this.scrubEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const v = this.snapToMarks(this.scrubMin() + frac * (this.scrubMax() - this.scrubMin()));
    this.p.seekTo(v);
  }

  onScrubEnd(): void {
    // A big drag leaves a breadcrumb at where they were (recoverable), and arms an
    // "arrival" breadcrumb dropped once they settle here and listen for 10s.
    if (this.scrubbing && Math.abs(this.p.currentTime() - this.scrubFromPos) > 30) {
      this.p.markJumpFrom(this.scrubFromPos);
      this.p.armArrivalBookmark();
    }
    this.scrubbing = false;
    this.scrubEl = null;
  }

  /** Keyboard seeking on the (pointer-disabled) range input — arrow keys only. */
  onScrub(event: Event): void {
    this.p.seekTo(parseFloat((event.target as HTMLInputElement).value));
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

  /** Speed presets shown in the sheet — two rows of four (1×–2.75×). */
  readonly speedPresets = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75];

  setSpeed(v: number): void { this.p.setSpeed(v); }
  isSpeed(v: number): boolean { return Math.abs(this.p.speed() - v) < 0.001; }

  /** Compact speed label, e.g. "1×", "1.25×", "1.5×" (no rounding surprises). */
  speedLabel(): string {
    return `${Math.round(this.p.speed() * 100) / 100}×`;
  }

  /** Step speed by ±delta (clamped 0.5×–5×), snapped to the slider's step. */
  bumpSpeed(delta: number): void {
    const v = Math.min(5, Math.max(0.5, Math.round((this.p.speed() + delta) * 20) / 20));
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

  /** Center the active sentence's row in the viewport. Works with virtual scroll:
   *  the target row may not be in the DOM, so we scroll by its estimated offset
   *  (rowOffsets) rather than measuring an element. */
  private scrollCueIntoView(index: number): void {
    const vp = this.textViewport();
    if (!vp) return;
    const rowIdx = this.cueRow().get(index);
    if (rowIdx == null) return;
    const top = this.rowOffsets()[rowIdx];
    const size = this.rowSizes()[rowIdx];
    const target = Math.max(0, top - vp.getViewportSize() / 2 + size / 2);
    vp.scrollToOffset(target, 'smooth');
  }

}
