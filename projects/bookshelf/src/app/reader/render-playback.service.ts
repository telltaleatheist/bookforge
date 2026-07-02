/**
 * RenderPlaybackService — playback for "TTS entire book" mode. Unlike the
 * streaming ReaderPlaybackService (live WS, ephemeral), this plays a project's
 * sentences from the persistent on-disk render cache produced by the main-process
 * BookRenderService: it kicks the render, then plays sentence WAVs in reading order
 * from `/api/render/sentence`, showing a buffering state until the next sentence is
 * on disk. It reports the playhead so the renderer prioritises from where the
 * listener is (forward-from-playhead + wrap). When the whole book is rendered the
 * server assembles an m4b that shows up on the audiobook page.
 *
 * One <audio> element, gapless-ish sequential playback (load next on `ended`).
 * Low memory: only the current sentence's bytes are held by the element.
 */

import { Injectable, inject, signal } from '@angular/core';
import { ReaderService } from '../services/reader.service';

export type RenderPlaybackState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

const POLL_MS = 1000;

@Injectable({ providedIn: 'root' })
export class RenderPlaybackService {
  private readonly reader = inject(ReaderService);

  // ── Reactive surface ────────────────────────────────────────────────────────
  readonly state = signal<RenderPlaybackState>('idle');
  readonly sentenceIndex = signal(-1);   // global sentence being played
  readonly blockIndex = signal(-1);      // active display block (via sentenceBlock)
  readonly rendered = signal(0);
  readonly total = signal(0);
  readonly done = signal(false);         // m4b assembled
  readonly errorMessage = signal<string | null>(null);
  readonly rateSig = signal(1);
  readonly paused = signal(false);

  private readonly audio = new Audio();
  private projectId = '';
  private sentenceBlock: number[] = [];
  private idx = 0;
  private coverage: boolean[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private rate = 1;
  private disposed = false;

  constructor() {
    this.audio.preload = 'auto';
    this.rate = parseFloat(localStorage.getItem('bookshelf-reader-rate') || '1') || 1;
    this.rateSig.set(this.rate);
    this.audio.addEventListener('ended', () => this.onEnded());
    this.audio.addEventListener('error', () => this.onAudioError());
  }

  private token(): string { return this.reader.token() || ''; }

  private sentenceUrl(i: number): string {
    return `/api/render/sentence?projectId=${encodeURIComponent(this.projectId)}&index=${i}&token=${encodeURIComponent(this.token())}`;
  }

  /** Begin (or resume) full-book playback from a sentence index. */
  async open(projectId: string, sentenceBlock: number[], startIndex: number): Promise<void> {
    this.disposed = false;
    this.projectId = projectId;
    this.sentenceBlock = sentenceBlock;
    this.idx = Math.max(0, startIndex);
    this.errorMessage.set(null);
    this.paused.set(false);
    this.state.set('buffering');

    try {
      const res = await fetch('/api/render/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Reader-Token': this.token() },
        body: JSON.stringify({ projectId, startIndex: this.idx }),
      });
      if (!res.ok) {
        const detail = res.status === 404 ? 'this endpoint is missing — update the app' : `server error ${res.status}`;
        throw new Error(detail);
      }
      const data = await res.json();
      this.total.set(data.total || 0);
    } catch (err) {
      this.errorMessage.set(err instanceof Error ? err.message : 'Could not start rendering.');
      this.state.set('error');
      return;
    }

    // Let the status poll drive the first play once sentence `idx` is on disk — this
    // avoids a race where we'd try to fetch a sentence the renderer hasn't produced.
    this.reportPlayhead(this.idx);
    this.startPolling();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    const tick = async () => {
      if (this.disposed) return;
      try {
        const res = await fetch(
          `/api/render/status?projectId=${encodeURIComponent(this.projectId)}&token=${encodeURIComponent(this.token())}`,
        );
        if (!res.ok) return;
        const s = await res.json();
        this.rendered.set(s.rendered || 0);
        if (s.total) this.total.set(s.total);
        this.done.set(!!s.done || !!s.m4b);
        this.coverage = Array.isArray(s.coverage) ? s.coverage : this.coverage;
        if (s.done || s.m4b) this.done.set(true);
        // Kick/resume playback once the sentence we're waiting on is on disk.
        const waiting = this.state() === 'buffering' || this.state() === 'idle';
        if (waiting && !this.paused() && this.isReady(this.idx)) this.tryPlayCurrent();
      } catch { /* transient */ }
    };
    void tick();
    this.pollTimer = setInterval(tick, POLL_MS);
  }

  private isReady(i: number): boolean {
    // A covered sentence always has a file on disk (the renderer writes even failed
    // ones as short silence), so coverage is authoritative. Before the first status
    // poll arrives coverage is empty → treat as not-ready and wait for the poll.
    return this.coverage.length > i && !!this.coverage[i];
  }

  private tryPlayCurrent(): void {
    if (this.disposed || this.paused()) return;
    if (this.idx >= this.total() && this.total() > 0) { this.state.set('ended'); return; }
    this.sentenceIndex.set(this.idx);
    this.blockIndex.set(this.sentenceBlock[this.idx] ?? -1);
    this.reportPlayhead(this.idx);
    if (!this.isReady(this.idx)) { this.state.set('buffering'); return; }
    this.audio.src = this.sentenceUrl(this.idx);
    this.audio.playbackRate = this.rate;
    (this.audio as { preservesPitch?: boolean }).preservesPitch = true;
    void this.audio.play().then(() => this.state.set('playing')).catch(() => { /* autoplay race; user can tap */ });
  }

  private onEnded(): void {
    if (this.disposed) return;
    this.idx += 1;
    this.tryPlayCurrent();
  }

  private onAudioError(): void {
    if (this.disposed || !this.audio.src) return;
    // Most likely the sentence 404'd because it isn't rendered yet — wait for the
    // poll to see it ready, then resume.
    if (!this.isReady(this.idx)) this.state.set('buffering');
  }

  private reportPlayhead(i: number): void {
    fetch('/api/render/playhead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': this.token() },
      body: JSON.stringify({ projectId: this.projectId, index: i }),
      keepalive: true,
    }).catch(() => { /* best effort */ });
  }

  // ── Transport ───────────────────────────────────────────────────────────────
  togglePause(): void {
    if (this.paused()) {
      this.paused.set(false);
      if (this.audio.src && this.isReady(this.idx)) void this.audio.play().then(() => this.state.set('playing')).catch(() => {});
      else this.tryPlayCurrent();
    } else {
      this.paused.set(true);
      this.audio.pause();
      this.state.set('paused');
    }
  }

  seekToSentence(i: number): void {
    this.idx = Math.max(0, i);
    this.paused.set(false);
    this.audio.pause();
    this.tryPlayCurrent();
  }

  /** Start playback at the block's first sentence. */
  seekToBlock(blockIndex: number): void {
    const first = this.sentenceBlock.findIndex((b) => b === blockIndex);
    if (first >= 0) this.seekToSentence(first);
  }

  setRate(r: number): void {
    this.rate = r;
    this.audio.playbackRate = r;
    localStorage.setItem('bookshelf-reader-rate', String(r));
    this.rateSig.set(r);
  }

  stop(): void {
    this.disposed = true;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch { /* ignore */ }
    this.state.set('idle');
    this.sentenceIndex.set(-1);
    this.blockIndex.set(-1);
  }
}
