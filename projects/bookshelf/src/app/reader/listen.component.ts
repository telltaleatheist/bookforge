/**
 * ListenComponent — the Bookshelf "Listen to anything" surface. An overlay (route
 * `listen`, rendered over the shelf like the player/reader) that takes arbitrary
 * text — pasted, or fetched from a URL / uploaded file via /api/reader/ingest — and
 * streams it through the TTS engine using ReaderPlaybackService.
 *
 * The playback brain (streaming, cache, prefetch, transport) lives in the service;
 * this component is just the input + the rendered reading view + the transport bar,
 * bound to the service's signals. Because we render the text ourselves, each sentence
 * of the active block is its own span (highlight by index, click to seek) — no DOM
 * range-matching like the extension needed.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService } from '../services/api.service';
import { ReaderService } from '../services/reader.service';
import { ReaderPlaybackService, ReaderItem } from './reader-playback.service';

@Component({
  selector: 'app-listen',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="listen">
      <header class="bar-top">
        <button class="icon" (click)="close()" aria-label="Close">✕</button>
        <span class="title">Listen</span>
      </header>

      @if (blocks().length === 0) {
        <div class="intro">
          <p class="hint">Paste text, or point a URL or file at it, and it reads aloud — live.</p>

          <label class="field">
            <span>Paste text</span>
            <textarea [value]="pasted()" (input)="pasted.set($any($event.target).value)"
                      rows="6" placeholder="Paste an article, a chapter, anything…"></textarea>
          </label>
          <button class="primary" [disabled]="!pasted().trim()" (click)="readPasted()">Read this</button>

          <label class="field">
            <span>From a URL</span>
            <input type="url" [value]="url()" (input)="url.set($any($event.target).value)"
                   placeholder="https://…" />
          </label>
          <button class="primary" [disabled]="!url().trim() || working()" (click)="readUrl()">
            {{ working() ? 'Fetching…' : 'Fetch & read' }}
          </button>

          <label class="field">
            <span>From a file (PDF / EPUB / TXT / HTML)</span>
            <input type="file" accept=".pdf,.epub,.txt,.htm,.html"
                   (change)="onFile($event)" />
          </label>

          @if (ingestError()) { <p class="err">{{ ingestError() }}</p> }
        </div>
      } @else {
        <div class="reading">
          @if (title()) { <h2 class="doc-title">{{ title() }}</h2> }
          @for (b of blocks(); track b.id; let i = $index) {
            <p class="block" [class.active]="b.id === pb.currentId()"
               [class.past]="isPast(i)" (click)="startFrom(i)">
              @if (b.id === pb.currentId() && pb.sentences().length) {
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
          <button class="icon" (click)="pb.seek(-10)" [disabled]="pb.position() <= 0.3" aria-label="Back 10s">« 10</button>
          <button class="icon big" (click)="pb.togglePause()" aria-label="Play/pause">{{ playGlyph() }}</button>
          <button class="icon" (click)="pb.seek(10)" aria-label="Forward 10s">10 »</button>
          <button class="icon" (click)="pb.skip()" aria-label="Next block">⏭</button>
          <span class="counter">{{ counter() }}</span>
          <select class="speed" [value]="pb.rateSig()" (change)="pb.setRate(+$any($event.target).value)">
            @for (r of speeds; track r) { <option [value]="r">{{ r }}×</option> }
          </select>
          <span class="status" [class.working]="isWorking()">{{ statusText() }}</span>
          <button class="icon" (click)="close()" aria-label="Stop">■</button>
        </footer>
      }
    </div>
  `,
  styles: [`
    :host { position: fixed; inset: 0; z-index: 500; background: var(--bg-base); color: var(--text-primary, #eee); display: flex; flex-direction: column; }
    .bar-top { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border-subtle); }
    .bar-top .title { font-weight: 600; }
    .icon { background: var(--bg-elevated); color: inherit; border: 1px solid var(--border-subtle); border-radius: 8px; padding: 8px 12px; cursor: pointer; font-size: 15px; }
    .icon:disabled { opacity: .4; cursor: default; }
    .icon.big { min-width: 56px; font-size: 18px; }
    .intro { padding: 20px 16px; max-width: 640px; margin: 0 auto; width: 100%; overflow-y: auto; }
    .intro .hint { opacity: .7; margin-bottom: 20px; }
    .field { display: block; margin: 16px 0 8px; }
    .field > span { display: block; font-size: 13px; opacity: .7; margin-bottom: 6px; }
    textarea, input[type=url] { width: 100%; box-sizing: border-box; background: var(--bg-input); color: inherit; border: 1px solid var(--border-input); border-radius: 8px; padding: 10px; font: inherit; }
    .primary { margin-top: 8px; background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 10px 16px; cursor: pointer; font-size: 15px; }
    .primary:disabled { opacity: .4; cursor: default; }
    .err { color: #e66; margin-top: 12px; }
    .reading { flex: 1; overflow-y: auto; padding: 20px 16px 120px; max-width: 720px; margin: 0 auto; width: 100%; box-sizing: border-box; line-height: 1.7; }
    .doc-title { margin: 0 0 20px; }
    .block { margin: 0 0 14px; padding: 4px 8px; border-radius: 6px; cursor: pointer; }
    .block.active { background: var(--bg-elevated); }
    .block.past { opacity: .5; }
    .sent.cur { background: var(--accent); color: #fff; border-radius: 3px; }
    .transport { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: var(--bg-toolbar, var(--bg-elevated)); border-top: 1px solid var(--border-subtle); flex-wrap: wrap; justify-content: center; }
    .counter { font-variant-numeric: tabular-nums; opacity: .8; min-width: 54px; text-align: center; }
    .speed { background: var(--bg-input); color: inherit; border: 1px solid var(--border-input); border-radius: 8px; padding: 6px; }
    .status { font-size: 13px; opacity: .8; }
    .status.working { color: var(--accent); }
  `],
})
export class ListenComponent {
  readonly pb = inject(ReaderPlaybackService);
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);
  private readonly router = inject(Router);

  readonly pasted = signal('');
  readonly url = signal('');
  readonly working = signal(false);
  readonly ingestError = signal<string | null>(null);
  readonly title = signal<string | null>(null);
  readonly blocks = signal<ReaderItem[]>([]);

  readonly speeds = [0.75, 1, 1.25, 1.5, 1.75, 2];

  readonly playGlyph = computed(() => {
    const s = this.pb.state();
    if (this.pb.paused()) return '▶';
    return s === 'playing' ? '⏸' : s === 'buffering' || s === 'connecting' || s === 'starting-engine' ? '…' : '▶';
  });

  readonly counter = computed(() => {
    const n = this.pb.sentenceCount();
    const i = this.pb.sentenceIndex();
    return n > 0 && i >= 0 ? `${i + 1}/${n}` : '';
  });

  readonly isWorking = computed(() => {
    const s = this.pb.state();
    return s === 'connecting' || s === 'starting-engine' || s === 'buffering';
  });

  statusText(): string {
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

  isPast(i: number): boolean {
    const curId = this.pb.currentId();
    if (!curId) return false;
    const curIdx = this.blocks().findIndex((b) => b.id === curId);
    return curIdx >= 0 && i < curIdx;
  }

  // ── Inputs → blocks ──────────────────────────────────────────────────────
  private toBlocks(paragraphs: string[]): ReaderItem[] {
    return paragraphs
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((text, i) => ({ id: `b${i}`, label: text.length > 60 ? text.slice(0, 57) + '…' : text, text }));
  }

  readPasted(): void {
    const items = this.toBlocks(this.pasted().split(/\n\s*\n/));
    if (!items.length) return;
    this.title.set(null);
    this.blocks.set(items);
    this.pb.playSequence(items);
  }

  async readUrl(): Promise<void> {
    const u = this.url().trim();
    if (!u) return;
    await this.ingest({ url: u });
  }

  async onFile(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) await this.ingest({ file });
    input.value = '';
  }

  private async ingest(src: { url?: string; file?: File }): Promise<void> {
    this.working.set(true);
    this.ingestError.set(null);
    try {
      const token = this.reader.token();
      if (!token) { this.ingestError.set('Sign in as a reader to use Listen.'); return; }
      const res = await this.api.ingestReader(token, src);
      const items = this.toBlocks(res.blocks);
      if (!items.length) { this.ingestError.set('No readable text found.'); return; }
      this.title.set(res.title || null);
      this.blocks.set(items);
      this.pb.playSequence(items);
    } catch (err) {
      this.ingestError.set(err instanceof Error ? err.message : 'Could not read that source.');
    } finally {
      this.working.set(false);
    }
  }

  // ── Reading view interactions ─────────────────────────────────────────────
  startFrom(i: number): void {
    const run = this.blocks().slice(i);
    if (run.length) this.pb.playSequence(run);
  }

  onSentence(ev: Event, idx: number): void {
    ev.stopPropagation();
    this.pb.seekToSentence(idx);
  }

  close(): void {
    this.pb.stop();
    this.blocks.set([]);
    void this.router.navigateByUrl('/');
  }
}
