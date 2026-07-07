/**
 * BookListenComponent — the Read&Listen view for a project book. Renders the
 * book's text as blocks (like the Listen surface) and offers two playback modes:
 *
 *   - Stream / follow-along: live streaming via ReaderPlaybackService with a ~45s
 *     moving read-ahead window. Ephemeral (nothing saved); tap a sentence to start
 *     there.
 *   - TTS entire book: the persistent whole-book render via RenderPlaybackService —
 *     renders every sentence to disk (forward from where you are, then wraps),
 *     plays from that cache, and at 100% the server compiles an m4b that appears on
 *     the Audio tab.
 *
 * The mode is a first-class choice: a big two-card picker on entry AND an always-
 * visible iOS segmented control at the top of playback so it can be switched at any
 * time (switching restarts playback in the new mode from the current block). The
 * reading view is mode-agnostic: it highlights the active block (and, in follow-
 * along, the active sentence within it) from whichever service is driving.
 */

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';
import { ReaderPlaybackService, ReaderItem } from './reader-playback.service';
import { RenderPlaybackService } from './render-playback.service';
import { ServerConfigService } from '../services/server-config.service';
import { IconComponent } from '../shared/icon.component';

interface Block { id: string; text: string; chapterStart: boolean; chapterTitle?: string; }

type Mode = 'pick' | 'follow' | 'full';

@Component({
  selector: 'app-book-listen',
  standalone: true,
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bl">
      <!-- ── Translucent sticky top bar ────────────────────────────────────── -->
      <header class="bar-top">
        <button class="glass-btn" (click)="close()" aria-label="Close"><app-icon name="close" [size]="20" /></button>
        <span class="title">{{ title() || 'Listen' }}</span>
        <span class="spacer"></span>
      </header>

      @if (loading()) {
        <div class="center"><div class="spinner"></div><span>Loading…</span></div>
      } @else if (loadError()) {
        <div class="center err">{{ loadError() }}</div>
      } @else if (mode() === 'pick') {
        <!-- ── Mode picker ─────────────────────────────────────────────────── -->
        <div class="pick">
          <h2>{{ title() }}</h2>
          <p class="sub">{{ blocks().length }} sections · How would you like to listen?</p>

          <button class="choice" (click)="startFollow(0)">
            <span class="ci"><app-icon name="headphones" [size]="24" /></span>
            <span class="ct"><b>Stream &amp; follow along</b><small>Reads aloud as you go, live. Nothing is saved — great for a quick listen.</small></span>
          </button>

          <button class="choice" (click)="startFull(0)">
            <span class="ci"><app-icon name="book" [size]="24" /></span>
            <span class="ct"><b>TTS the entire book</b><small>Renders the whole book in the background and saves an audiobook to your Audio tab.</small></span>
          </button>

          @if (voices().length > 0) {
            <button class="voice-row" (click)="voiceOpen.set(true)">
              <span class="vi"><app-icon name="voice" [size]="18" /></span>
              <span class="vt">Voice</span>
              <span class="vv">{{ voiceLabel() }}</span>
              <app-icon name="chevron-right" [size]="16" />
            </button>
          }

          @if (alreadyRendered() > 0) {
            <p class="note">Resuming — {{ alreadyRendered() }} sections already rendered.</p>
          }
        </div>
      } @else {
        <!-- ── Segmented mode switch (always visible during playback) ───────── -->
        <div class="seg-bar">
          <div class="seg">
            <button [class.on]="mode() === 'follow'" (click)="switchMode('follow')">
              <app-icon name="headphones" [size]="16" /><span>Stream</span>
            </button>
            <button [class.on]="mode() === 'full'" (click)="switchMode('full')">
              <app-icon name="book" [size]="16" /><span>TTS book</span>
            </button>
          </div>
        </div>

        <!-- ── Reading surface ─────────────────────────────────────────────── -->
        <div class="reading">
          @for (b of blocks(); track b.id; let i = $index) {
            @if (b.chapterStart) { <div class="chap"><span>{{ b.chapterTitle || 'Chapter' }}</span></div> }
            <p class="block" [class.active]="b.id === activeId()" [class.past]="isPast(i)" (click)="onBlock(i)">
              @if (mode() === 'follow' && b.id === activeId() && pb.sentences().length) {
                @for (s of pb.sentences(); track $index) {
                  <span class="sent" [class.cur]="$index === pb.sentenceIndex()"
                        (click)="onSentence($event, $index)">{{ s }} </span>
                }
              } @else {
                {{ b.text }}
              }
            </p>
          }
        </div>

        <!-- ── Translucent sticky transport ────────────────────────────────── -->
        <footer class="transport">
          @if (mode() === 'full') {
            <div class="prog"><div class="fill" [style.width.%]="progressPct()"></div></div>
          }

          @if (mode() === 'full' && rp.state() === 'error') {
            <!-- Render aborted server-side (engine/model failed). Surface + retry. -->
            <div class="err-row">
              <span class="err-text">{{ rp.errorMessage() || 'Rendering failed.' }}</span>
              <button class="pill retry" (click)="retry()"><app-icon name="replay" [size]="15" /><span>Retry</span></button>
            </div>
          } @else {
            <div class="controls">
              <div class="play-wrap">
                <button class="play" (click)="togglePause()" aria-label="Play/pause">
                  <app-icon [name]="playIcon()" [size]="26" />
                </button>
                @if (isWorking()) { <span class="ring" aria-hidden="true"></span> }
              </div>

              <button class="pill speed" (click)="cycleSpeed()" aria-label="Playback speed">{{ rate() }}×</button>

              @if (voices().length > 0) {
                <button class="pill" (click)="voiceOpen.set(true)" aria-label="Voice">
                  <app-icon name="voice" [size]="14" /><span class="pill-voice">{{ voiceLabel() }}</span>
                </button>
              }

              <span class="status" [class.working]="isWorking()">{{ statusText() }}</span>

              @if (mode() === 'full' && !rp.done() && rp.total() > 0) {
                <span class="counter">{{ rp.rendered() }}/{{ rp.total() }}</span>
              }
              @if (mode() === 'full' && rp.done()) {
                <button class="pill ready" (click)="goToAudio()"><app-icon name="headphones" [size]="15" /><span>Audio tab</span></button>
              }
            </div>
          }
        </footer>
      }

      <!-- ── Voice picker: iOS bottom sheet, checkmark on the selection ─────── -->
      @if (voiceOpen()) {
        <div class="v-backdrop" (click)="voiceOpen.set(false)"></div>
        <div class="v-sheet" role="dialog" aria-label="Choose a voice">
          <div class="v-grabber"></div>
          <div class="v-title">Voice</div>
          <div class="v-list">
            @for (v of voices(); track v) {
              <button class="v-row" (click)="pickVoice(v)">
                <span class="v-name">{{ prettyVoice(v) }}</span>
                @if (v === voice()) { <app-icon name="check" [size]="18" /> }
              </button>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary); display: flex; flex-direction: column; }
    .bl { display: flex; flex-direction: column; height: 100%; }

    /* ── Translucent bars (iOS): frosted surface + hairline ── */
    .bar-top {
      display: flex; align-items: center; gap: 12px;
      padding: calc(10px + env(safe-area-inset-top)) 14px 10px;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-bottom: 0.5px solid var(--border-subtle); flex-shrink: 0; position: sticky; top: 0; z-index: 3;
    }
    .bar-top .title { font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bar-top .spacer { flex: 1; }
    .glass-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 34px; height: 34px; border-radius: 999px; flex-shrink: 0;
      background: var(--bg-input); color: var(--text-primary); border: none; cursor: pointer;
    }
    .glass-btn:active { opacity: .6; }

    .seg-bar {
      padding: 8px 14px;
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-bottom: 0.5px solid var(--border-subtle);
      position: sticky; top: 0; z-index: 2; flex-shrink: 0;
    }
    /* iOS segmented control: gray track, raised selected segment. */
    .seg { display: flex; background: var(--seg-bg); border-radius: 9px; padding: 2px; max-width: 420px; margin: 0 auto; }
    .seg button { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
      border: none; background: transparent; color: var(--text-primary); padding: 7px 12px; border-radius: 7px;
      cursor: pointer; font-size: 14px; font-weight: 500; }
    .seg button.on { background: var(--seg-active); box-shadow: 0 1px 4px rgba(0,0,0,0.16); }
    .seg button:active { opacity: .6; }

    /* ── Loading / error ── */
    .center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 60px 16px; color: var(--text-secondary); }
    .center.err { color: var(--error); }
    .spinner { width: 28px; height: 28px; border: 3px solid var(--border-subtle); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Mode picker ── */
    .pick { padding: 24px 16px calc(24px + env(safe-area-inset-bottom)); max-width: 560px; margin: 0 auto; width: 100%; box-sizing: border-box; }
    .pick h2 { margin: 0 0 4px; font-size: 22px; }
    .pick .sub { color: var(--text-secondary); margin: 0 0 20px; }
    .choice { display: flex; gap: 14px; align-items: center; width: 100%; text-align: left; padding: 16px; margin-bottom: 12px;
      border: 0.5px solid var(--border-subtle); border-radius: 14px; background: var(--bg-surface); color: inherit; cursor: pointer; }
    .choice:active { opacity: .6; }
    .choice .ci { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; flex-shrink: 0;
      border-radius: 12px; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .choice .ct { display: flex; flex-direction: column; gap: 3px; }
    .choice .ct b { font-size: 16px; }
    .choice .ct small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; }
    .note { font-size: 13px; color: var(--accent); }

    /* ── Reading surface ── */
    .reading { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
      padding: 18px 16px calc(150px + env(safe-area-inset-bottom)); max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; line-height: 1.7; }
    .chap { display: flex; align-items: center; gap: 10px; margin: 22px 0 10px; }
    .chap span { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 700; }
    .chap::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 35%, transparent); }
    .block { margin: 0 0 14px; padding: 6px 8px; border-radius: 8px; cursor: pointer; }
    .block.active { background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .block.past { opacity: .5; }
    .block:active { opacity: .6; }
    .sent { border-radius: 4px; }
    .sent.cur { background: color-mix(in srgb, var(--accent) 30%, transparent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 30%, transparent); }

    /* ── Transport ── */
    .transport { position: fixed; left: 0; right: 0; bottom: 0;
      padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-top: 0.5px solid var(--border-subtle); }
    .controls { display: flex; align-items: center; gap: 12px; }
    .prog { position: absolute; left: 0; right: 0; top: 0; height: 2px; background: var(--bg-input); }
    .prog .fill { height: 100%; background: var(--accent); transition: width .4s ease; }

    .play-wrap { position: relative; width: 52px; height: 52px; flex-shrink: 0; }
    .play { position: absolute; inset: 0; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%; border: none; background: var(--accent); color: var(--text-on-accent); cursor: pointer; }
    .play:active { opacity: .6; }
    /* Buffering ring: spins around the play button while we wait on audio. */
    .ring { position: absolute; inset: -3px; border-radius: 50%; pointer-events: none;
      border: 2.5px solid transparent; border-top-color: var(--accent); animation: spin .8s linear infinite; }

    .pill { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0;
      border: none; border-radius: 999px; padding: 7px 12px; font-size: 13px; font-weight: 600; cursor: pointer;
      background: var(--bg-input); color: var(--text-primary); font-variant-numeric: tabular-nums; }
    .pill:active { opacity: .6; }
    .pill.ready { background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
    .pill.retry { background: color-mix(in srgb, var(--error) 16%, transparent); color: var(--error); }

    .status { font-size: 13px; color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status.working { color: var(--accent); }
    .counter { font-size: 12px; color: var(--text-tertiary); font-variant-numeric: tabular-nums; flex-shrink: 0; }

    .err-row { display: flex; align-items: center; gap: 10px; }
    .err-text { flex: 1; font-size: 13px; color: var(--error); overflow: hidden; text-overflow: ellipsis; }

    /* Voice pill label: keep it short so the transport row fits a phone. */
    .pill-voice { max-width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: capitalize; }

    /* Voice row on the mode picker. */
    .voice-row { display: flex; align-items: center; gap: 10px; width: 100%; padding: 13px 16px; margin-top: 4px;
      border: 0.5px solid var(--border-subtle); border-radius: 14px; background: var(--bg-surface); color: inherit; cursor: pointer; }
    .voice-row:active { opacity: .6; }
    .voice-row .vi { display: inline-flex; color: var(--accent); }
    .voice-row .vt { font-size: 15px; font-weight: 500; }
    .voice-row .vv { flex: 1; text-align: right; font-size: 14px; color: var(--text-secondary); text-transform: capitalize;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* ── Voice sheet (iOS bottom sheet) ── */
    .v-backdrop { position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,0.4); animation: vFade 0.15s ease; }
    @keyframes vFade { from { opacity: 0; } to { opacity: 1; } }
    .v-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 21; max-height: 60%;
      display: flex; flex-direction: column;
      padding: 8px 10px calc(12px + env(safe-area-inset-bottom));
      background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
      backdrop-filter: blur(20px) saturate(180%); -webkit-backdrop-filter: blur(20px) saturate(180%);
      border-top: 0.5px solid var(--border-subtle); border-radius: 16px 16px 0 0;
      box-shadow: 0 -8px 30px rgba(0,0,0,0.35); animation: vUp 0.22s ease-out; }
    @keyframes vUp { from { transform: translateY(100%); } to { transform: translateY(0); } }
    .v-grabber { width: 36px; height: 5px; border-radius: 3px; background: var(--text-tertiary); opacity: 0.5; align-self: center; margin: 2px 0 8px; }
    .v-title { font-size: 15px; font-weight: 600; text-align: center; padding-bottom: 8px; }
    .v-list { overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
    .v-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
      padding: 13px 14px; border: none; background: transparent; color: var(--text-primary);
      font-size: 16px; text-align: left; cursor: pointer; border-bottom: 0.5px solid var(--border-subtle); }
    .v-row:last-child { border-bottom: none; }
    .v-row:active { opacity: .6; }
    .v-row app-icon { color: var(--accent); }
    .v-name { text-transform: capitalize; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `],
})
export class BookListenComponent implements OnInit, OnDestroy {
  readonly pb = inject(ReaderPlaybackService);
  readonly rp = inject(RenderPlaybackService);
  private readonly api = inject(ApiService);
  private readonly cfg = inject(ServerConfigService);
  private readonly reader = inject(ReaderService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly title = signal('');
  readonly blocks = signal<Block[]>([]);
  readonly mode = signal<Mode>('pick');
  readonly alreadyRendered = signal(0);
  readonly voices = signal<string[]>([]);
  readonly voice = signal(localStorage.getItem('bookshelf-reader-voice') || '');
  readonly voiceOpen = signal(false);
  private sentenceBlock: number[] = [];
  private projectId = '';

  readonly speeds = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75];

  readonly activeId = computed(() =>
    this.mode() === 'full'
      ? (this.blocks()[this.rp.blockIndex()]?.id ?? null)
      : this.pb.currentId(),
  );

  readonly rate = computed(() => (this.mode() === 'full' ? this.rp.rateSig() : this.pb.rateSig()));

  /** The transport's play/pause glyph — the buffering ring conveys the wait state. */
  readonly playIcon = computed(() => {
    if (this.mode() === 'full') return this.rp.state() === 'playing' && !this.rp.paused() ? 'pause' : 'play';
    return this.pb.state() === 'playing' && !this.pb.paused() ? 'pause' : 'play';
  });

  readonly isWorking = computed(() => {
    if (this.mode() === 'full') return this.rp.state() === 'buffering';
    const s = this.pb.state();
    return s === 'connecting' || s === 'starting-engine' || s === 'buffering';
  });

  readonly progressPct = computed(() => {
    const t = this.rp.total();
    return t > 0 ? Math.round((this.rp.rendered() / t) * 100) : 0;
  });

  async ngOnInit(): Promise<void> {
    this.projectId = this.route.snapshot.paramMap.get('id') || '';
    const token = this.reader.token();
    if (!token) { this.loadError.set('Sign in as a reader to listen.'); this.loading.set(false); return; }
    // Pre-warm the TTS engine the moment the view opens: the cold start (~1 min
    // worst case) runs while the user is still on the mode picker, so tapping
    // play usually hits a warm engine and audio starts in seconds.
    this.api.warmTts(token, this.voice() || undefined);
    void this.api.getTtsVoices(token).then((v) => {
      this.voices.set(v.voices || []);
      if (!this.voice()) this.voice.set(v.defaultVoice || v.current || '');
    }).catch(() => { /* picker just stays hidden */ });
    try {
      const data = await this.api.getProjectReader(token, this.projectId);
      this.title.set(data.title);
      this.sentenceBlock = data.sentenceBlock || [];
      // Attach chapter titles to chapter-start blocks (for dividers). Mirror the
      // server's chapter indexing: a chapter begins at the first block OR at any
      // chapterStart marker, so its index tracks chapterTitles[].
      let ci = -1;
      const blocks: Block[] = data.blocks.map((b) => {
        if (b.chapterStart || ci < 0) ci += 1;
        return b.chapterStart ? { ...b, chapterTitle: data.chapterTitles[ci] } : b;
      });
      this.blocks.set(blocks);
      // Peek at any existing render progress to hint "resume".
      try {
        const res = await fetch(this.cfg.url(`/api/render/status?projectId=${encodeURIComponent(this.projectId)}&token=${encodeURIComponent(token)}`));
        if (res.ok) { const s = await res.json(); this.alreadyRendered.set(s.rendered || 0); }
      } catch { /* ignore */ }
    } catch (err) {
      this.loadError.set(err instanceof Error ? err.message : 'Could not open that book.');
    } finally {
      this.loading.set(false);
    }
  }

  ngOnDestroy(): void {
    this.pb.stop();
    this.rp.stop();
  }

  // ── Mode entry ────────────────────────────────────────────────────────────
  private toItems(from: number): ReaderItem[] {
    return this.blocks().slice(from).map((b) => ({
      id: b.id,
      label: b.text.length > 60 ? b.text.slice(0, 57) + '…' : b.text,
      text: b.text,
    }));
  }

  startFollow(from: number): void {
    this.rp.stop();
    this.mode.set('follow');
    this.pb.setReadAhead(45); // ±45s moving window
    if (this.voice()) this.pb.setVoice(this.voice());
    this.pb.playSequence(this.toItems(from));
  }

  startFull(from: number): void {
    this.pb.stop();
    this.mode.set('full');
    void this.rp.open(this.projectId, this.sentenceBlock, from, this.voice() || undefined, this.title() || undefined);
  }

  // ── Voice picker ──────────────────────────────────────────────────────────
  /** Display name for the pill/rows — strip a custom-model path down to a word. */
  prettyVoice(v: string): string {
    return (v.split(/[/\\]/).pop() || v).replace(/[_-]+/g, ' ');
  }

  voiceLabel(): string {
    const v = this.voice();
    return v ? this.prettyVoice(v) : 'Default';
  }

  /** Apply a voice everywhere: persist it, and restart whichever mode is live
   *  from the current block so the change is heard immediately. */
  pickVoice(v: string): void {
    this.voiceOpen.set(false);
    if (v === this.voice()) return;
    this.voice.set(v);
    this.pb.setVoice(v);
    const m = this.mode();
    if (m === 'follow') this.pb.playSequence(this.toItems(this.currentBlockIndex()));
    else if (m === 'full') void this.rp.setVoice(v);
  }

  /** Flip between Stream and TTS-book without leaving your spot: restart the new
   *  mode from whichever block is currently active. */
  switchMode(next: 'follow' | 'full'): void {
    if (next === this.mode()) return;
    const from = this.currentBlockIndex();
    if (next === 'follow') this.startFollow(from);
    else this.startFull(from);
  }

  private currentBlockIndex(): number {
    const id = this.activeId();
    if (!id) return 0;
    const i = this.blocks().findIndex((b) => b.id === id);
    return i >= 0 ? i : 0;
  }

  // ── Reading interactions ──────────────────────────────────────────────────
  onBlock(i: number): void {
    // Tap a block → start there. Full mode also steers the background render's
    // playhead so it prioritises around the new position.
    if (this.mode() === 'full') this.rp.seekToBlock(i);
    else this.pb.playSequence(this.toItems(i));
  }

  onSentence(ev: Event, idx: number): void {
    ev.stopPropagation();
    if (this.mode() === 'follow') this.pb.seekToSentence(idx);
  }

  isPast(i: number): boolean {
    const id = this.activeId();
    if (!id) return false;
    const cur = this.blocks().findIndex((b) => b.id === id);
    return cur >= 0 && i < cur;
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  togglePause(): void { this.mode() === 'full' ? this.rp.togglePause() : this.pb.togglePause(); }

  setRate(r: number): void { this.mode() === 'full' ? this.rp.setRate(r) : this.pb.setRate(r); }

  /** Tap the speed pill to cycle through the presets (iOS-style, no dropdown). */
  cycleSpeed(): void {
    const cur = this.rate();
    const i = this.speeds.indexOf(cur);
    this.setRate(this.speeds[(i + 1) % this.speeds.length] ?? 1);
  }

  retry(): void { void this.rp.retry(); }

  /** After a full render completes, jump the shelf to the Audio tab and close. */
  goToAudio(): void {
    try { localStorage.setItem('bookshelf-tab', 'audiobooks'); } catch { /* ignore */ }
    this.close();
  }

  statusText(): string {
    if (this.mode() === 'full') {
      if (this.rp.state() === 'error') return this.rp.errorMessage() || 'Rendering failed.';
      if (this.rp.done()) return 'Saved to your Audiobooks';
      switch (this.rp.state()) {
        case 'buffering': return this.rp.total() ? 'Buffering…' : 'Preparing…';
        case 'paused': return 'Paused';
        case 'ended': return 'Finished';
        case 'playing': return 'Rendering as you listen…';
        default: return 'Preparing…';
      }
    }
    switch (this.pb.state()) {
      case 'connecting': return 'Connecting…';
      case 'starting-engine': return 'Starting engine (~1 min)…';
      case 'buffering': return 'Buffering…';
      case 'paused': return 'Paused';
      case 'ended': return 'Done';
      case 'error': return this.pb.errorMessage() || 'Error';
      default: return this.pb.note() || '';
    }
  }

  close(): void {
    this.pb.stop();
    this.rp.stop();
    void this.router.navigateByUrl('/');
  }
}
