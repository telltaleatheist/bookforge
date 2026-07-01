import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { ReaderService } from './reader.service';
import { VttCue, VttParserService } from './vtt-parser.service';
import { Audiobook, Chapter } from '../models/types';

export interface Bookmark {
  id: string;
  position: number; // seconds
  label: string;
  createdAt: number;
}

/**
 * Singleton playback engine. Owns the HTMLAudioElement and all player state so
 * audio keeps playing while the user navigates away from the full player (the
 * full-screen view and the mini-bar are both just views over this service).
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);
  private readonly vtt = inject(VttParserService);

  // The audio lives in the service, not a component template, so navigation
  // never tears it down.
  private readonly audio = new Audio();

  readonly book = signal<Audiobook | null>(null);
  readonly cues = signal<VttCue[]>([]);
  readonly chapters = signal<Chapter[]>([]);
  readonly coverSrc = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly speed = signal(1);
  readonly volume = signal(1);
  readonly currentCueIndex = signal(0);
  readonly bookmarks = signal<Bookmark[]>([]);
  // Time ranges (seconds) the user has actually played through — painted as the
  // "listened" color on the scrubber. Skips/seeks don't fill the gap, so an
  // accidental jump leaves a visible unheard section to return to.
  readonly heard = signal<Array<[number, number]>>([]);
  // The current run shown as purple immediately (from second 1) but NOT yet
  // written to heard/the file — it's committed only once the run passes 10s, and
  // cleared if the user skips first.
  readonly provisional = signal<[number, number] | null>(null);
  private heardTick: number | null = null;
  private runStart: number | null = null; // start of the current contiguous run
  private static readonly HEARD_MIN_RUN = 10; // only record a run once it reaches this many seconds

  // Bumped on discrete seeks (chapter/skip) so the full-player view can scroll
  // the transcript to the new spot even while paused.
  readonly scrollTick = signal(0);

  private posSaveTimer: ReturnType<typeof setInterval> | null = null;
  // Resolved in open() (newer of local/server), applied once audio metadata loads.
  private pendingStart = 0;
  // The user's intent. When true but the element pauses without going through our
  // controls (e.g. AirPods removed → route change), we try to resume on the new
  // output. Real pauses (tap / lock-screen / AirPod tap → media-session handler)
  // set this false first, so they're respected.
  private wantPlaying = false;
  private lastAutoResume = 0;

  // Listening-time tracking: wall-clock seconds actually spent playing, flushed
  // to the server periodically and on pause/unload.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listenAnchor: number | null = null;
  // Don't record analytics (time OR the book itself) until a book session passes
  // this threshold — brief/accidental opens shouldn't count. Buffered locally
  // until qualified, then the whole session so far is recorded at once.
  private static readonly ANALYTICS_MIN_SECONDS = 30;
  private pendingSeconds = 0;
  private sessionQualified = false;

  readonly currentChapter = computed<Chapter | null>(() => {
    const chs = this.chapters();
    if (chs.length === 0) return null;
    const t = this.currentTime();
    for (let i = chs.length - 1; i >= 0; i--) {
      if (t >= chs[i].start) return chs[i];
    }
    return chs[0];
  });

  readonly canPrevChapter = computed(() => {
    const cur = this.currentChapter();
    return !!cur && this.chapters().indexOf(cur) > 0;
  });
  readonly canNextChapter = computed(() => {
    const cur = this.currentChapter();
    const chs = this.chapters();
    return !!cur && chs.indexOf(cur) < chs.length - 1;
  });

  readonly progressPercent = computed(() => {
    const d = this.duration();
    return d > 0 ? (this.currentTime() / d) * 100 : 0;
  });

  /** Heard intervals as {left%, width%} for painting the scrubber. */
  readonly heardSegments = computed(() => {
    const d = this.duration();
    if (d <= 0) return [];
    return this.heard().map(([s, e]) => ({ left: (s / d) * 100, width: ((e - s) / d) * 100 }));
  });

  /** cue index → chapter title, for inline transcript headers. */
  readonly chapterStartMap = computed<Map<number, string>>(() => {
    const map = new Map<number, string>();
    const cues = this.cues();
    if (cues.length === 0) return map;
    for (const ch of this.chapters()) {
      const idx = cues.findIndex((c) => c.startTime >= ch.start - 0.05);
      if (idx >= 0) map.set(idx, ch.title);
    }
    return map;
  });

  constructor() {
    this.audio.preload = 'auto';
    // Tell iOS/WebKit this is long-form playback: keeps audio going with the
    // screen locked / app backgrounded and ignores the hardware mute switch —
    // the closest thing to native AVAudioSession control from the web. No-op on
    // browsers without it (Android/Chrome uses the media session + element).
    this.setPlaybackAudioSession();
    this.setupRemotePlayback();
    this.audio.addEventListener('loadedmetadata', () => this.onLoadedMetadata());
    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.audio.addEventListener('play', () => {
      this.isPlaying.set(true);
      this.setPlaybackState('playing');
      this.startPosTimer();
      this.startHeartbeat();
    });
    this.audio.addEventListener('pause', () => {
      // External pause while the user wanted playback (e.g. AirPods removed):
      // resume on the new output instead of going silent. Debounced so a genuine
      // stop (backgrounded/interruption where play() is blocked) can't loop.
      if (this.wantPlaying && !this.audio.ended && Date.now() - this.lastAutoResume > 1000) {
        this.lastAutoResume = Date.now();
        this.audio.play().then(() => { /* resumed on the new route */ }, () => {
          // Couldn't resume (backgrounded/interruption) — settle as paused.
          this.isPlaying.set(false);
          this.setPlaybackState('paused');
          this.savePosition(true);
          this.stopHeartbeat();
        });
        return;
      }
      this.isPlaying.set(false);
      this.setPlaybackState('paused');
      this.savePosition(true); // flush to server on pause
      this.stopHeartbeat();
    });
    this.audio.addEventListener('ended', () => {
      this.wantPlaying = false;
      this.isPlaying.set(false);
      this.savePosition(true);
      this.stopHeartbeat();
    });

    // Best-effort final flush if the page is closed mid-listen (keepalive fetch).
    window.addEventListener('beforeunload', () => { this.savePosition(true); this.flushListening(); });
    this.audio.addEventListener('error', () => {
      if (!this.loading()) this.error.set('Audio failed to load.');
    });

    const s = parseFloat(localStorage.getItem('bookshelf-speed') || '1');
    if (s >= 0.5 && s <= 4) { this.speed.set(s); this.audio.playbackRate = s; }
    const v = parseFloat(localStorage.getItem('bookshelf-volume') || '1');
    if (v >= 0 && v <= 1) { this.volume.set(v); this.audio.volume = v; }
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  /**
   * Load a book for playback. No-op if that book is already loaded (so
   * reopening from the mini-bar never restarts it). Does not auto-play —
   * the first play() must come from a user gesture (iOS background-audio rule).
   */
  async open(downloadPath: string, book?: Audiobook | null): Promise<void> {
    if (this.book()?.downloadPath === downloadPath) return;

    this.loading.set(true);
    this.error.set(null);
    try {
      let b = book && book.downloadPath === downloadPath ? book : null;
      if (!b) {
        const all = await this.api.getBooks();
        b = all.find((x) => x.downloadPath === downloadPath) ?? null;
      }
      if (!b) {
        this.error.set('Audiobook not found');
        return;
      }

      this.book.set(b);
      this.cues.set([]);
      this.chapters.set([]);
      this.coverSrc.set(null);
      this.currentCueIndex.set(0);
      this.currentTime.set(0);
      this.duration.set(0);
      // New book → new analytics session (must re-earn the 30s threshold).
      this.pendingSeconds = 0;
      this.sessionQualified = false;
      this.heard.set([]);
      this.provisional.set(null);
      this.heardTick = null;
      this.runStart = null;
      this.loadBookmarks(b.downloadPath);

      const [chapters, vttText, cover, serverPos, heard] = await Promise.all([
        this.api.getChapters(b.downloadPath),
        this.api.getVttText(b.projectId, b.langPair),
        this.api.getCover(b),
        this.loadServerPosition(b),
        this.loadHeard(b),
      ]);
      this.chapters.set(chapters);
      this.coverSrc.set(cover);
      this.heard.set(heard);
      if (vttText) this.cues.set(this.vtt.parseVtt(vttText));

      // Resolve the start position (newer of local vs. server) before loading,
      // so onLoadedMetadata seeks to it.
      this.pendingStart = this.pickStart(this.loadLocalPosition(), serverPos);

      this.audio.src = this.api.audioUrl(b.downloadPath);
      this.audio.playbackRate = this.speed();
      this.audio.load();

      this.setupMediaSession();
    } catch (err) {
      console.error('[PlayerService] open failed', err);
      this.error.set('Failed to load audiobook');
    } finally {
      this.loading.set(false);
    }
  }

  // ── Transport ──────────────────────────────────────────────────────────────
  togglePlay(): void {
    if (this.audio.paused) {
      this.wantPlaying = true;
      this.setPlaybackAudioSession(); // (re)assert inside the tap so WebKit honors it
      this.audio.play().catch((e) => console.error('play failed', e));
    } else {
      this.wantPlaying = false; // set BEFORE pause() so onPause won't auto-resume
      this.audio.pause();
    }
  }

  play(): void {
    this.wantPlaying = true;
    this.setPlaybackAudioSession();
    this.audio.play().catch((e) => console.error('play failed', e));
  }

  /**
   * Fully stop playback and unload the book (the player's ✕). Distinct from
   * minimizing, which keeps the book loaded and playing. Persists position and
   * flushes listening time first.
   */
  close(): void {
    this.wantPlaying = false;
    this.savePosition(true);
    this.stopHeartbeat(); // flushes listening time (still needs book())
    this.pendingSeconds = 0;
    this.sessionQualified = false;
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this.isPlaying.set(false);
    this.currentTime.set(0);
    this.duration.set(0);
    this.currentCueIndex.set(0);
    this.book.set(null);
    this.cues.set([]);
    this.chapters.set([]);
    this.coverSrc.set(null);
  }

  seekTo(time: number, scrollToText = false): void {
    const clamped = Math.max(0, Math.min(time, this.duration() || time));
    this.audio.currentTime = clamped;
    this.currentTime.set(clamped);
    this.updateCue(clamped);
    // A seek/jump breaks continuity — measure the next heard range from here so
    // the skipped span stays unheard, and drop the uncommitted provisional purple.
    this.heardTick = clamped;
    this.runStart = null;
    this.provisional.set(null);
    if (scrollToText) this.scrollTick.update((v) => v + 1);
  }

  seekToCue(index: number): void {
    const cue = this.cues()[index];
    if (cue) this.seekTo(cue.startTime);
  }

  seekToChapter(ch: Chapter): void {
    this.seekTo(ch.start, true);
  }

  skip(delta: number): void {
    this.seekTo(this.currentTime() + delta, true);
  }

  prevChapter(): void {
    const chs = this.chapters();
    const cur = this.currentChapter();
    if (!cur) return;
    const i = chs.indexOf(cur);
    // >3s into the chapter restarts it; otherwise step back.
    if (this.currentTime() - cur.start > 3) this.seekTo(cur.start, true);
    else if (i > 0) this.seekTo(chs[i - 1].start, true);
  }

  nextChapter(): void {
    const chs = this.chapters();
    const cur = this.currentChapter();
    if (!cur) return;
    const i = chs.indexOf(cur);
    if (i < chs.length - 1) this.seekTo(chs[i + 1].start, true);
  }

  setSpeed(v: number): void {
    this.speed.set(v);
    this.audio.playbackRate = v;
    localStorage.setItem('bookshelf-speed', String(v));
  }

  /** 0–1. Note: iOS ignores HTMLMediaElement.volume (hardware buttons only). */
  setVolume(v: number): void {
    const clamped = Math.min(1, Math.max(0, v));
    this.volume.set(clamped);
    this.audio.volume = clamped;
    localStorage.setItem('bookshelf-volume', String(clamped));
  }

  // ── Bookmarks (localStorage cache + durable server store) ─────────────────────
  addBookmark(label: string): void {
    const b = this.book();
    const bm: Bookmark = {
      id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      position: this.currentTime(),
      label,
      createdAt: Date.now(),
    };
    this.bookmarks.set([...this.bookmarks(), bm].sort((a, b) => a.position - b.position));
    this.saveBookmarks();
    const token = this.reader.token();
    if (token && b) this.api.postBookmark(token, { bookPath: b.downloadPath, op: 'add', bookmark: bm as unknown as { id: string } & Record<string, unknown> });
  }

  removeBookmark(id: string): void {
    this.bookmarks.set(this.bookmarks().filter((b) => b.id !== id));
    this.saveBookmarks();
    const b = this.book();
    const token = this.reader.token();
    if (token && b) this.api.postBookmark(token, { bookPath: b.downloadPath, op: 'del', bookmark: { id } });
  }

  seekToBookmark(bm: Bookmark): void {
    this.seekTo(bm.position, true);
  }

  private bmKey(path: string): string { return `bookshelf-bm:${path}`; }

  private loadBookmarks(path: string): void {
    try {
      const raw = localStorage.getItem(this.bmKey(path));
      this.bookmarks.set(raw ? JSON.parse(raw) : []);
    } catch {
      this.bookmarks.set([]);
    }
    void this.mergeServerBookmarks(path);
  }

  /** Union the local list with the server's set (never drops a local bookmark),
   *  and push any local-only bookmarks up so they become durable/cross-device.
   *  On an unreachable/old server we keep the localStorage cache untouched. */
  private async mergeServerBookmarks(path: string): Promise<void> {
    const token = this.reader.token();
    if (!token) return;
    let server: Bookmark[];
    try { server = await this.api.getBookmarks<Bookmark>(token, { bookPath: path }); }
    catch { return; } // unreachable/old server → keep local cache
    if (this.book()?.downloadPath !== path) return; // book changed while fetching
    const byId = new Map<string, Bookmark>();
    for (const b of server) byId.set(b.id, b);
    const localOnly = this.bookmarks().filter((b) => !byId.has(b.id));
    for (const b of localOnly) byId.set(b.id, b);
    const merged = [...byId.values()].sort((a, b) => a.position - b.position);
    this.bookmarks.set(merged);
    localStorage.setItem(this.bmKey(path), JSON.stringify(merged));
    for (const b of localOnly) {
      this.api.postBookmark(token, { bookPath: path, op: 'add', bookmark: b as unknown as { id: string } & Record<string, unknown> });
    }
  }

  private saveBookmarks(): void {
    const b = this.book();
    if (b) localStorage.setItem(this.bmKey(b.downloadPath), JSON.stringify(this.bookmarks()));
  }

  // ── Audio event handlers ───────────────────────────────────────────────────
  private onLoadedMetadata(): void {
    this.duration.set(this.audio.duration || 0);
    this.audio.playbackRate = this.speed();
    const saved = this.pendingStart;
    if (saved > 0 && saved < (this.audio.duration || Infinity)) {
      this.audio.currentTime = saved;
      this.currentTime.set(saved);
      this.updateCue(saved);
    }
  }

  private onTimeUpdate(): void {
    const t = this.audio.currentTime;
    this.currentTime.set(t);
    this.updateCue(t);
    this.trackHeard(t);
    const dur = this.duration();
    if (dur > 0 && 'mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState({ duration: dur, playbackRate: this.speed(), position: Math.min(t, dur) });
      } catch { /* ignore */ }
    }
  }

  /** Mark [prev, t] as heard only when it reflects contiguous playback (not a
   *  seek/jump), so skipped spans stay uncovered. */
  private trackHeard(t: number): void {
    // Pausing doesn't break a run — position doesn't move, so resuming continues
    // the same run. Only a seek/skip resets it (handled in seekTo).
    if (this.audio.paused) return;
    const prev = this.heardTick;
    this.heardTick = t;
    if (prev == null) { this.runStart = t; return; }
    const delta = t - prev;
    if (delta <= 0 || delta >= 2.5) { this.runStart = t; this.provisional.set(null); return; } // seek/jump → new run, drop provisional
    if (this.runStart == null) this.runStart = prev;
    if (t - this.runStart >= PlayerService.HEARD_MIN_RUN) {
      this.addHeard(this.runStart, t); // committed to heard (persisted)
      this.provisional.set(null);      // now part of heard
    } else {
      this.provisional.set([this.runStart, t]); // visible purple, not yet recorded
    }
  }

  private addHeard(a: number, b: number): void {
    if (b <= a) return;
    const list = [...this.heard(), [a, b] as [number, number]].sort((x, y) => x[0] - y[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of list) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e); // join within 1s
      else merged.push([s, e]);
    }
    this.heard.set(merged);
  }

  private updateCue(time: number): void {
    const cues = this.cues();
    if (cues.length === 0) return;
    const idx = this.vtt.findCueAtTime(cues, time);
    if (idx >= 0 && idx !== this.currentCueIndex()) this.currentCueIndex.set(idx);
  }

  // ── Position persistence ──────────────────────────────────────────────────────
  // Saved to localStorage (instant, offline) AND the server (durable across
  // devices + survives Safari evicting localStorage). Newest write wins on open.
  private posKey(): string { return `bookshelf-pos:${this.book()?.downloadPath ?? ''}`; }
  private lastServerPosAt = 0;

  private savePosition(force = false): void {
    this.saveHeard(force);
    const t = this.currentTime();
    const b = this.book();
    if (t <= 0 || !b) return;
    localStorage.setItem(this.posKey(), JSON.stringify({ v: t, at: Date.now() }));
    const token = this.reader.token();
    if (!token) return;
    const now = Date.now();
    if (force || now - this.lastServerPosAt > 15_000) {
      this.lastServerPosAt = now;
      this.api.postPosition(token, { bookPath: b.downloadPath, kind: 'audio', value: t });
    }
  }

  // ── Listened coverage persistence (localStorage cache + durable server) ───────
  private heardKey(path: string): string { return `bookshelf-heard:${path}`; }
  private lastServerHeardAt = 0;

  private saveHeard(force = false): void {
    const b = this.book();
    if (!b) return;
    const intervals = this.heard();
    localStorage.setItem(this.heardKey(b.downloadPath), JSON.stringify(intervals));
    const token = this.reader.token();
    if (!token) return;
    const now = Date.now();
    if (force || now - this.lastServerHeardAt > 20_000) {
      this.lastServerHeardAt = now;
      this.api.postHeard(token, { bookPath: b.downloadPath, intervals });
    }
  }

  private loadLocalHeard(path: string): Array<[number, number]> {
    try { const raw = localStorage.getItem(this.heardKey(path)); return raw ? JSON.parse(raw) : []; }
    catch { return []; }
  }

  /** Server is authoritative when reachable; localStorage is the offline cache. */
  private async loadHeard(b: Audiobook): Promise<Array<[number, number]>> {
    const token = this.reader.token();
    const local = this.loadLocalHeard(b.downloadPath);
    if (!token) return local;
    try { return await this.api.getHeard(token, { bookPath: b.downloadPath }); }
    catch { return local; }
  }

  /** Clear listened coverage AND restart the book to the beginning. */
  resetProgress(): void {
    const b = this.book();
    this.heard.set([]);
    this.provisional.set(null);
    this.heardTick = null;
    this.runStart = null;
    this.seekTo(0);
    if (!b) return;
    localStorage.setItem(this.heardKey(b.downloadPath), JSON.stringify([]));
    localStorage.removeItem(this.posKey());
    const token = this.reader.token();
    if (token) {
      this.api.postHeard(token, { bookPath: b.downloadPath, intervals: [] });
      this.api.postPosition(token, { bookPath: b.downloadPath, kind: 'audio', value: 0 });
    }
  }

  private loadLocalPosition(): { v: number; at: number } | null {
    const raw = localStorage.getItem(this.posKey());
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') return { v: Number(o.v) || 0, at: Number(o.at) || 0 };
    } catch { /* legacy raw number below */ }
    const n = parseFloat(raw);
    return Number.isFinite(n) ? { v: n, at: 0 } : null;
  }

  private async loadServerPosition(b: Audiobook): Promise<{ v: number; at: number } | null> {
    const token = this.reader.token();
    if (!token) return null;
    try {
      const p = await this.api.getPosition(token, { bookPath: b.downloadPath });
      if (p && p.kind === 'audio' && p.value != null) {
        const v = Number(p.value);
        const at = p.at ? Date.parse(p.at) : 0;
        if (Number.isFinite(v) && v > 0) return { v, at };
      }
    } catch { /* offline */ }
    return null;
  }

  /** Start position = the more recently written of local vs. server. */
  private pickStart(local: { v: number; at: number } | null, server: { v: number; at: number } | null): number {
    if (local && server) return server.at >= local.at ? server.v : local.v;
    return local?.v ?? server?.v ?? 0;
  }

  private startPosTimer(): void {
    if (!this.posSaveTimer) this.posSaveTimer = setInterval(() => this.savePosition(), 5000);
  }

  // ── Listening-time heartbeat ───────────────────────────────────────────────
  private startHeartbeat(): void {
    this.listenAnchor = Date.now();
    if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => this.flushListening(), 20_000);
  }

  private stopHeartbeat(): void {
    this.flushListening();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.listenAnchor = null;
  }

  /**
   * Record wall-clock seconds elapsed since the last flush — but only once this
   * book session has passed ANALYTICS_MIN_SECONDS. Below the threshold the time
   * is buffered locally and nothing is sent, so short opens leave no trace; on
   * crossing it, the whole buffered session is recorded in one go.
   */
  private flushListening(): void {
    const token = this.reader.token();
    const book = this.book();
    if (!token || !book || this.listenAnchor == null) return;
    const now = Date.now();
    const seconds = (now - this.listenAnchor) / 1000;
    this.listenAnchor = now;
    if (seconds <= 0.5) return;

    if (!this.sessionQualified) {
      this.pendingSeconds += seconds;
      if (this.pendingSeconds < PlayerService.ANALYTICS_MIN_SECONDS) return;
      this.sessionQualified = true;
      const total = this.pendingSeconds;
      this.pendingSeconds = 0;
      this.postListening(token, book, total); // count the whole session so far
      return;
    }
    this.postListening(token, book, seconds);
  }

  private postListening(token: string, book: Audiobook, seconds: number): void {
    this.api.postHeartbeat(token, {
      bookPath: book.downloadPath,
      title: book.title,
      author: book.author || '',
      seconds,
    }).catch(() => { /* transient; next flush will catch up */ });
  }

  // ── Lock-screen / background controls ─────────────────────────────────────────
  private setPlaybackState(state: MediaSessionPlaybackState): void {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  /** WebKit-only AVAudioSession bridge; feature-detected. */
  private setPlaybackAudioSession(): void {
    const audioSession = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (audioSession) {
      try { audioSession.type = 'playback'; } catch { /* unsupported value */ }
    }
  }

  // True when an AirPlay (Safari/iOS) or Cast (Chrome/Android) target is reachable.
  readonly airplayAvailable = signal(false);

  /** Wire up AirPlay (WebKit) + Remote Playback (Cast); both feature-detected. */
  private setupRemotePlayback(): void {
    const el = this.audio as unknown as {
      webkitShowPlaybackTargetPicker?: () => void;
      addEventListener: HTMLAudioElement['addEventListener'];
    };
    // WebKit: fires as AirPlay targets appear/disappear.
    if (typeof el.webkitShowPlaybackTargetPicker === 'function') {
      el.addEventListener('webkitplaybacktargetavailabilitychanged', (e: Event) => {
        this.airplayAvailable.set((e as unknown as { availability?: string }).availability === 'available');
      });
    }
    // Standard Remote Playback API (Chromecast on Android/Chrome, some Safari).
    const remote = this.audio.remote;
    if (remote && typeof remote.watchAvailability === 'function') {
      remote.watchAvailability((available) => this.airplayAvailable.set(available))
        .catch(() => { /* not supported or disabled by policy */ });
    }
  }

  /** Show the OS route picker (AirPlay / Cast). */
  showRemotePicker(): void {
    const el = this.audio as unknown as { webkitShowPlaybackTargetPicker?: () => void };
    if (typeof el.webkitShowPlaybackTargetPicker === 'function') {
      el.webkitShowPlaybackTargetPicker();
      return;
    }
    this.audio.remote?.prompt?.().catch(() => { /* user dismissed */ });
  }

  private setupMediaSession(): void {
    if (!('mediaSession' in navigator)) return;
    const book = this.book();
    if (!book) return;

    const artwork = this.coverSrc() ? [{ src: this.coverSrc()!, sizes: '512x512', type: 'image/jpeg' }] : [];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.author || '',
      album: 'BookForge',
      artwork,
    });

    const set = (action: MediaSessionAction, handler: () => void) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
    };
    set('play', () => this.togglePlay());
    set('pause', () => this.togglePlay());
    set('seekbackward', () => this.skip(-15));
    set('seekforward', () => this.skip(30));
    set('previoustrack', () => this.prevChapter());
    set('nexttrack', () => this.nextChapter());
    try {
      navigator.mediaSession.setActionHandler('seekto', (d) => {
        if (d.seekTime != null) this.seekTo(d.seekTime, true);
      });
    } catch { /* unsupported */ }
  }
}
