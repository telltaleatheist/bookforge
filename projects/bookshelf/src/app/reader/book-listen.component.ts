/**
 * BookListenComponent — the Read&Listen view for a project book. Renders the
 * book's text as blocks (like the Listen surface) and offers two playback modes:
 *
 *   - Follow along: live streaming via ReaderPlaybackService with a ~45s moving
 *     read-ahead window. Ephemeral (nothing saved); click a sentence to start there.
 *   - TTS entire book: the persistent whole-book render via RenderPlaybackService —
 *     renders every sentence to disk (forward from where you are, then wraps),
 *     plays from that cache, and at 100% the server compiles an m4b that appears on
 *     the audiobook page.
 *
 * The reading view is mode-agnostic: it highlights the active block (and, in
 * follow-along, the active sentence within it) from whichever service is driving.
 */

import { ChangeDetectionStrategy, Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';
import { ReaderPlaybackService, ReaderItem } from './reader-playback.service';
import { RenderPlaybackService } from './render-playback.service';
import { ServerConfigService } from '../services/server-config.service';

interface Block { id: string; text: string; chapterStart: boolean; chapterTitle?: string; }

type Mode = 'pick' | 'follow' | 'full';

@Component({
  selector: 'app-book-listen',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bl">
      <header class="bar-top">
        <button class="icon" (click)="close()" aria-label="Close">✕</button>
        <span class="title">{{ title() || 'Listen' }}</span>
      </header>

      @if (loading()) {
        <div class="center"><div class="spinner"></div><span>Loading…</span></div>
      } @else if (loadError()) {
        <div class="center err">{{ loadError() }}</div>
      } @else if (mode() === 'pick') {
        <div class="pick">
          <h2>{{ title() }}</h2>
          <p class="sub">{{ blocks().length }} sections · How would you like to listen?</p>
          <button class="choice" (click)="startFollow(0)">
            <span class="ci">🎧</span>
            <span class="ct"><b>Follow along</b><small>Streams as you read. Nothing saved — great for a quick listen.</small></span>
          </button>
          <button class="choice" (click)="startFull(0)">
            <span class="ci">📚</span>
            <span class="ct"><b>TTS the entire book</b><small>Renders the whole book in the background → saves an audiobook (m4b) on the Audio tab.</small></span>
          </button>
          @if (alreadyRendered() > 0) {
            <p class="note">Resuming — {{ alreadyRendered() }} sections already rendered.</p>
          }
        </div>
      } @else {
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

        <footer class="transport">
          <button class="icon big" (click)="togglePause()" aria-label="Play/pause">{{ playGlyph() }}</button>
          <select class="speed" [value]="rate()" (change)="setRate(+$any($event.target).value)">
            @for (r of speeds; track r) { <option [value]="r">{{ r }}×</option> }
          </select>
          <span class="status" [class.working]="isWorking()">{{ statusText() }}</span>
          @if (mode() === 'full') {
            <div class="prog"><div class="fill" [style.width.%]="progressPct()"></div></div>
          }
        </footer>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary, #eee); display: flex; flex-direction: column; }
    .bl { display: flex; flex-direction: column; height: 100%; }
    .bar-top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
    .bar-top .title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .icon { background: var(--bg-elevated); color: inherit; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 15px; }
    .icon.big { min-width: 56px; font-size: 18px; }
    .center { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 60px 16px; opacity: .8; }
    .center.err { color: #e66; }
    .spinner { width: 28px; height: 28px; border: 3px solid var(--border-subtle); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .pick { padding: 24px 16px; max-width: 560px; margin: 0 auto; width: 100%; box-sizing: border-box; }
    .pick h2 { margin: 0 0 4px; }
    .pick .sub { opacity: .7; margin: 0 0 20px; }
    .choice { display: flex; gap: 14px; align-items: center; width: 100%; text-align: left; padding: 16px; margin-bottom: 12px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-elevated); color: inherit; cursor: pointer; }
    .choice:active { transform: scale(.99); }
    .choice .ci { font-size: 26px; }
    .choice .ct { display: flex; flex-direction: column; gap: 3px; }
    .choice .ct b { font-size: 16px; }
    .choice .ct small { font-size: 12.5px; opacity: .7; line-height: 1.4; }
    .note { font-size: 13px; color: var(--accent); }
    .reading { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 20px 16px 120px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; line-height: 1.7; }
    .chap { display: flex; align-items: center; gap: 10px; margin: 22px 0 10px; }
    .chap span { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent); font-weight: 700; }
    .chap::after { content: ''; flex: 1; height: 1px; background: color-mix(in srgb, var(--accent) 35%, transparent); }
    .block { margin: 0 0 14px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
    .block.active { background: var(--bg-elevated); }
    .block.past { opacity: .5; }
    .sent.cur { background: var(--accent); color: #fff; border-radius: 3px; }
    .transport { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); background: var(--bg-toolbar, var(--bg-elevated)); border-top: 1px solid var(--border-subtle); }
    .speed { background: var(--bg-input); color: inherit; border: 1px solid var(--border-input); border-radius: 8px; padding: 6px; }
    .status { font-size: 13px; opacity: .85; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status.working { color: var(--accent); }
    .prog { position: absolute; left: 0; right: 0; top: 0; height: 3px; background: transparent; }
    .prog .fill { height: 100%; background: var(--accent); transition: width .4s ease; }
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
  private sentenceBlock: number[] = [];
  private projectId = '';

  readonly speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];

  readonly activeId = computed(() =>
    this.mode() === 'full'
      ? (this.blocks()[this.rp.blockIndex()]?.id ?? null)
      : this.pb.currentId(),
  );

  readonly rate = computed(() => (this.mode() === 'full' ? this.rp.rateSig() : this.pb.rateSig()));

  readonly playGlyph = computed(() => {
    if (this.mode() === 'full') {
      const s = this.rp.state();
      if (this.rp.paused()) return '▶';
      return s === 'playing' ? '⏸' : s === 'buffering' ? '…' : '▶';
    }
    const s = this.pb.state();
    if (this.pb.paused()) return '▶';
    return s === 'playing' ? '⏸' : (s === 'buffering' || s === 'connecting' || s === 'starting-engine') ? '…' : '▶';
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
    this.pb.playSequence(this.toItems(from));
  }

  startFull(from: number): void {
    this.pb.stop();
    this.mode.set('full');
    void this.rp.open(this.projectId, this.sentenceBlock, from);
  }

  // ── Reading interactions ──────────────────────────────────────────────────
  onBlock(i: number): void {
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

  statusText(): string {
    if (this.mode() === 'full') {
      if (this.rp.state() === 'error') return this.rp.errorMessage() || 'Error';
      if (this.rp.done()) return 'Audiobook ready — see the Audio tab ↗';
      const t = this.rp.total();
      return t ? `Rendering ${this.rp.rendered()}/${t}…` : 'Preparing…';
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
