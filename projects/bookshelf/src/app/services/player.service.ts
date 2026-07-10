import { computed, inject, Injectable, signal } from '@angular/core';
import { ApiService } from './api.service';
import { OfflineStoreService } from './offline-store.service';
import { ReaderService } from './reader.service';
import { AnalyticsQueueService } from './analytics-queue.service';
import { VttCue, VttParserService } from './vtt-parser.service';
import { Audiobook, Chapter } from '../models/types';
import { AudioBackend, createAudioBackend } from './audio-backend';

export type BookmarkKind = 'manual' | 'open' | 'resume' | 'hour' | 'chapter' | 'sleep' | 'jump' | 'arrive';

export interface Bookmark {
  id: string;
  position: number; // seconds
  label: string;
  createdAt: number; // ms epoch — shown as date/time in the list
  kind?: BookmarkKind; // 'manual' unless auto-dropped (open/chapter/sleep/jump/arrive)
}

/**
 * Singleton playback engine. Owns the HTMLAudioElement and all player state so
 * audio keeps playing while the user navigates away from the full player (the
 * full-screen view and the mini-bar are both just views over this service).
 */
@Injectable({ providedIn: 'root' })
export class PlayerService {
  private readonly api = inject(ApiService);
  private readonly offline = inject(OfflineStoreService);
  private readonly reader = inject(ReaderService);
  private readonly analyticsQueue = inject(AnalyticsQueueService);
  private readonly vtt = inject(VttParserService);

  // The audio lives in the service, not a component template, so navigation
  // never tears it down. On native iOS this is an AVPlayer bridge (no lock
  // "blip", arbitrary speeds); on web it's the browser audio element. Same
  // surface either way — see audio-backend.ts.
  private readonly audio: AudioBackend = createAudioBackend();

  readonly book = signal<Audiobook | null>(null);
  readonly cues = signal<VttCue[]>([]);
  readonly chapters = signal<Chapter[]>([]);
  readonly coverSrc = signal<string | null>(null);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);

  // Last-played timestamp (ms epoch) per book/variant downloadPath. Powers the
  // shelf's "Recent" sort so a book you're actively listening to floats to the
  // top even if it was TTS'd long ago. Seeded from the persisted position cache
  // and bumped on every position save — a signal so the always-mounted shelf
  // re-sorts live as you listen.
  readonly playedAt = signal<Map<string, number>>(PlayerService.loadPlayedAt());

  readonly isPlaying = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly speed = signal(1);
  readonly volume = signal(1);
  readonly currentCueIndex = signal(0);
  readonly bookmarks = signal<Bookmark[]>([]);

  // "Drag the mini-player up to expand" gesture. Driven by the mini bar, read by
  // the full player: expandY is how far (px) the player panel is translated DOWN
  // (0 = fully open, viewport height = hidden below). null when no expand drag is
  // in progress. expandDragging is true while the finger is down (transition off
  // so the panel tracks 1:1; on release it animates to open or back down).
  readonly expandY = signal<number | null>(null);
  readonly expandDragging = signal(false);
  /** The rest offset (px): where the panel sits before the drag — the top of the
   *  mini bar, above the nav rail — so the slide originates there, not off the
   *  very bottom of the screen. The scrim fade scales to this travel. */
  readonly expandRest = signal(0);
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
  // Set when the user makes a big jump (see armArrivalBookmark). Once they settle
  // and listen continuously for HEARD_MIN_RUN seconds, a breadcrumb is dropped at
  // the spot they landed on — the companion to the 'jump' departure breadcrumb.
  private arrivalArmed = false;

  // ── Sleep timer ───────────────────────────────────────────────────────────────
  // 'time' pauses at a wall-clock target (real minutes, correct at any speed);
  // 'chapter' pauses at the current chapter's end (audio time). Checked on every
  // timeupdate, so it fires even when backgrounded/locked. Auto-drops breadcrumb
  // bookmarks at start, every 15 min, and at expiry.
  readonly sleepMode = signal<'off' | 'time' | 'chapter'>('off');
  readonly sleepRemaining = signal(0); // seconds left, for display
  private sleepTargetMs: number | null = null;   // wall-clock target ('time')
  private sleepChapterEnd: number | null = null;  // audio-second target ('chapter')
  private sleepStartMs: number | null = null;      // when the timer began
  private sleepNextBookmarkMs: number | null = null; // wall-clock of next breadcrumb
  private static readonly SLEEP_BOOKMARK_INTERVAL = 15 * 60 * 1000;
  private lastChapterIdx = -1; // for auto "finished chapter" bookmarks

  // Bumped on discrete seeks (chapter/skip) so the full-player view can scroll
  // the transcript to the new spot even while paused.
  readonly scrollTick = signal(0);

  private posSaveTimer: ReturnType<typeof setInterval> | null = null;
  // Resolved in open() (newer of local/server), applied once audio metadata loads.
  private pendingStart = 0;
  // Self-contained data: URI of the current book's cover, for the OS lock screen
  // (see toArtworkDataUrl). Distinct from coverSrc, which may be a WebView-scoped
  // blob:/file: URL the media service can't fetch. Null when there's no cover.
  private artworkUrl: string | null = null;
  // Set in open() so playback starts as soon as metadata loads. Tapping a book is a
  // user gesture and (when switching from another book) the element is already
  // unlocked, so play() succeeds; on a cold deep-link with no gesture it's rejected
  // and we settle as paused.
  private pendingAutoplay = false;
  // The user's intent. When true but the element pauses without going through our
  // controls (e.g. AirPods removed → route change), we try to resume on the new
  // output. Real pauses (tap / lock-screen / AirPod tap → media-session handler)
  // set this false first, so they're respected.
  private wantPlaying = false;
  private lastAutoResume = 0;

  // Listening-time tracking: measured from AUDIO PROGRESS (audio.currentTime),
  // so paused/buffering/backgrounded time is never counted. The anchor is the
  // currentTime at the last flush; each flush takes the forward delta played
  // since and divides it by the playback speed to get REAL time spent (2× for
  // half an hour credits 15 min). Seeks re-anchor (see seekTo) so skipped spans
  // don't count; setSpeed re-anchors so each segment uses its own speed.
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private listenAudioAnchor: number | null = null;
  // A single flush shouldn't exceed real playback since the last one. Foreground
  // that's ~20s; a backgrounded tab whose timer was frozen can legitimately catch
  // up more, but a delta beyond this is a missed seek re-anchor — drop it.
  private static readonly LISTEN_MAX_FLUSH_SECONDS = 6 * 3600;
  // Don't record analytics (time OR the book itself) until a book session passes
  // this threshold — brief/accidental opens shouldn't count. Buffered locally
  // until qualified, then the whole session so far is recorded at once.
  private static readonly ANALYTICS_MIN_SECONDS = 30;
  private pendingSeconds = 0;
  private sessionQualified = false;
  /** Real listened seconds accrued toward the next hourly safety bookmark. */
  private playedSinceBookmark = 0;

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
    // WebKit only treats a media element as Now Playing-eligible (Control
    // Center/lock-screen entry + allowed to keep playing when the screen locks
    // or Safari is backgrounded) when the element is CONNECTED to the document.
    // A detached new Audio() plays fine in the foreground, but iOS classifies
    // it as page sound effects: no media controls anywhere, and playback is
    // suspended with the page on lock/app-switch — every time. A controls-less
    // <audio> renders nothing, so attaching it is invisible.
    this.audio.setAttribute('aria-hidden', 'true');
    // The DOM-connection trick (below) only applies to a real media element; the
    // native AVPlayer backend has no node to attach and doesn't need it.
    if (this.audio instanceof HTMLMediaElement) document.body.appendChild(this.audio);
    // Tell iOS/WebKit this is long-form playback: keeps audio going with the
    // screen locked / app backgrounded and ignores the hardware mute switch —
    // the closest thing to native AVAudioSession control from the web. No-op on
    // browsers without it (Android/Chrome uses the media session + element).
    this.setPlaybackAudioSession();
    this.setupRemotePlayback();
    // Native backend: lock-screen / Control Center commands arrive here instead
    // of via navigator.mediaSession (wired once; survives book changes).
    this.audio.nativeControls?.onCommand((action) => this.handleRemoteCommand(action));
    // Native lock-screen skip/scrub/chapter jumps (the plugin already seeked the
    // AVPlayer) — do seekTo()'s bookkeeping without re-issuing the seek.
    this.audio.nativeControls?.onSeeked((time) => this.handleNativeSeeked(time));
    this.audio.addEventListener('loadedmetadata', () => this.onLoadedMetadata());
    this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
    this.audio.addEventListener('play', () => {
      this.isPlaying.set(true);
      this.setPlaybackState('playing');
      this.startPosTimer();
      this.startHeartbeat();
      // Re-arm the native sleep backstop on every (re)start: a reacquire (read-aloud
      // stole then we resumed the player) tore down the plugin's sleep timer/observer,
      // and a reacquire always resumes via play(). armNativeSleep recomputes afterMs
      // from sleepTargetMs (fresh, not stale) and is a safe no-op (clearSleep) when no
      // timer is set.
      this.armNativeSleep();
      // Safety bookmark on entering playback (open-autoplay or resume). The 1s
      // dedup in addBookmark collapses this with the 'Opened the book' mark and
      // with route-change auto-resumes at the same spot, so it only really lands
      // when the user resumes at a genuinely new position.
      this.addBookmark('Resumed playback', 'resume');
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

    // iOS suspends web audio when the page/webview is backgrounded or the phone
    // locks; play() rejections while hidden settle us as paused. If the user
    // never asked for that pause (wantPlaying is still true), pick playback back
    // up the moment the app returns to the foreground. A user pause — tap,
    // lock-screen control, AirPod tap — clears wantPlaying first, so it's never
    // overridden here.
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState !== 'visible') return;
      if (!this.book()) return;
      // The WebView was likely frozen while backgrounded, so the JS time mirror is
      // stale — repair it from the live native position BEFORE anything (the 5s
      // save timer, auto-resume) can write the stale value back over the real one.
      await this.audio.syncFromNative?.();
      if (this.wantPlaying && this.audio.paused && !this.audio.ended && this.book()) {
        this.setPlaybackAudioSession();
        this.audio.play().catch(() => { /* stays paused; the transport already shows it */ });
      }
    });
    this.audio.addEventListener('error', () => {
      if (!this.loading()) this.error.set('Audio failed to load.');
    });

    const s = parseFloat(localStorage.getItem('bookshelf-speed') || '1');
    if (s >= 0.5 && s <= 5) { this.speed.set(s); this.audio.playbackRate = s; }
    const v = parseFloat(localStorage.getItem('bookshelf-volume') || '1');
    if (v >= 0 && v <= 1) { this.volume.set(v); this.audio.volume = v; }
  }

  // ── Loading ──────────────────────────────────────────────────────────────────
  private static readonly LAST_BOOK_KEY = 'bookshelf-last-book';

  /**
   * Load a book for playback and (by default) start playing once its metadata
   * loads. No-op if that book is already loaded (so reopening from the mini-bar
   * never restarts or re-plays it). Auto-play is best-effort: on a cold deep-link
   * with no prior user gesture the browser may reject play(), and we settle as
   * paused. Pass `{ autoplay: false }` to restore a book silently (see restoreLast).
   */
  async open(downloadPath: string, book?: Audiobook | null, opts?: { autoplay?: boolean }): Promise<void> {
    if (this.book()?.downloadPath === downloadPath) return;
    const autoplay = opts?.autoplay !== false;
    // A fresh book should start playing. Assert intent now so a stray 'pause' from
    // swapping src (which fires no 'pause' event but leaves isPlaying stale) can't
    // leave the transport showing "playing" while silent.
    this.pendingAutoplay = autoplay;
    this.wantPlaying = autoplay;
    // Remember it so a page refresh can bring the mini-player back (see restoreLast).
    localStorage.setItem(PlayerService.LAST_BOOK_KEY, downloadPath);

    this.loading.set(true);
    this.error.set(null);
    try {
      let b = book && book.downloadPath === downloadPath ? book : null;
      // A downloaded book must open with EVERY server offline. Resolve it from the
      // on-device cache first: getBooks() below hits the active server's /api/books
      // and THROWS when it's unreachable, which used to sink restoreLast() (mini-
      // player restore on launch) and any shelf tap made while the origin server
      // was down — even though the audio was sitting on disk.
      if (!b) b = this.offline.asAudiobook(undefined, downloadPath);
      if (!b) {
        // Not downloaded → it's a remote book, so the network is required anyway.
        // Still don't let a transient failure throw past here.
        try {
          const all = await this.api.getBooks();
          b = all.find((x) => x.downloadPath === downloadPath) ?? null;
        } catch { /* offline & not cached — fall through to "not found" */ }
      }
      if (!b) {
        this.error.set('Audiobook not found');
        return;
      }

      this.book.set(b);
      // Tell the native backend which key to persist this book's position under
      // (no-op on web). The native side keeps saving while the WebView is frozen
      // in the background, so its saved position becomes a resume candidate below.
      this.audio.setPersistKey?.(b.downloadPath);
      this.cues.set([]);
      this.chapters.set([]);
      this.coverSrc.set(null);
      this.artworkUrl = null;
      this.currentCueIndex.set(0);
      this.currentTime.set(0);
      this.duration.set(0);
      // New book → new analytics session (must re-earn the 30s threshold).
      this.pendingSeconds = 0;
      this.sessionQualified = false;
      this.playedSinceBookmark = 0;
      this.heard.set([]);
      this.provisional.set(null);
      this.heardTick = null;
      this.runStart = null;
      this.cancelSleep();
      this.loadBookmarks(b.downloadPath);

      const [chapters, vttText, cover, serverPos, nativePos, heard] = await Promise.all([
        this.api.getChapters(b.downloadPath, b.originServerId),
        this.api.getVttText(b.projectId, b.langPair, b.downloadPath, b.originServerId),
        this.api.getCover(b),
        this.loadServerPosition(b),
        // Native-saved position (iOS): progress made while the WebView was frozen,
        // which local/server can't have. Resolves null on web / when nothing saved.
        this.audio.getSavedPosition?.(b.downloadPath) ?? Promise.resolve(null),
        this.loadHeard(b),
      ]);
      this.chapters.set(chapters);
      this.coverSrc.set(cover);
      // Lock-screen artwork is fetched OUTSIDE this WebView (by iOS's media
      // service for the web mediaSession, or by the native AVPlayer bridge), so
      // a downloaded book's blob:/file: cover — scoped to this WebView — can't be
      // loaded there and the lock screen kept the PREVIOUS book's picture. Inline
      // the bytes as a self-contained data: URI so the art always matches the
      // book that's actually playing. Awaited here so setupMediaSession() below
      // has it ready. Inlining is best-effort like the rest of the cover path: a
      // failure is logged (not swallowed) and leaves no art, never sinking the
      // book load over a picture.
      this.artworkUrl = await this.toArtworkDataUrl(cover).catch((e) => {
        console.error('[PlayerService] could not inline cover for lock screen', e);
        return null;
      });
      this.heard.set(heard);
      if (vttText) this.cues.set(this.vtt.parseVtt(vttText));

      // Resolve the start position (newest of local, server, native) before
      // loading, so onLoadedMetadata seeks to it.
      this.pendingStart = this.pickStart(this.loadLocalPosition(), serverPos, nativePos);

      // Local books resolve to an on-device blob URL; remote books to the HTTP
      // audio endpoint of their origin server.
      this.audio.src = await this.api.resolveAudioSrc(b.downloadPath, b.originServerId);
      this.audio.playbackRate = this.speed();
      this.audio.load();

      // Hand chapter boundaries to the native backend so the lock-screen prev/next
      // buttons can seek them while the WebView is frozen (no-op on web). MUST come
      // AFTER load(): load() runs acquire() (so this facade is now the owner and the
      // owner-gated setChapters actually reaches the plugin) and its teardownPlayer()
      // clears the plugin's chapterTimes — a push before load() would be dropped or
      // wiped.
      this.audio.setChapters?.(chapters.map((c) => c.start));

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
    this.audio.play().catch((e) => {
      console.error('play failed', e);
      // Rejected (e.g. autoplay blocked on a cold deep-link) — the element is
      // paused, so make the transport agree instead of showing a stale "playing".
      this.wantPlaying = false;
      this.isPlaying.set(false);
      this.setPlaybackState('paused');
    });
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
    this.playedSinceBookmark = 0;
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
    this.audio.setChapters?.([]); // drop native chapter boundaries on unload
    this.cancelSleep();
    this.coverSrc.set(null);
    this.artworkUrl = null;
    localStorage.removeItem(PlayerService.LAST_BOOK_KEY); // fully closed → nothing to restore
  }

  /**
   * On app boot, bring back the last-open book (as the paused mini-player) so a
   * page refresh doesn't lose it. Loads silently — no autoplay — because a cold
   * load has no user gesture (the browser would block play() anyway) and we don't
   * want to override the paused/playing state the reader left it in. No-op if a
   * book is already loaded or nothing was open.
   */
  async restoreLast(): Promise<void> {
    if (this.book()) return;
    const last = localStorage.getItem(PlayerService.LAST_BOOK_KEY);
    if (!last) return;
    await this.open(last, null, { autoplay: false });
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
    // Re-anchor listening time too, so the jumped-over span isn't credited as
    // "listened" on the next heartbeat flush.
    if (this.listenAudioAnchor != null) this.listenAudioAnchor = clamped;
    this.lastChapterIdx = -1; // a seek isn't a natural chapter finish
    // End-of-chapter sleep is a content-position boundary; a seek moves us relative
    // to it, so re-arm the native observer at the (unchanged) target from the new
    // position. Wall-clock 'time' mode is unaffected by seeks — leave it armed.
    if (this.sleepMode() === 'chapter') this.armNativeSleep();
    if (scrollToText) this.scrollTick.update((v) => v + 1);
  }

  /** A lock-screen skip/scrub/chapter jump the native plugin ALREADY performed on
   *  the AVPlayer (via the 'seeked' event). Run seekTo()'s bookkeeping WITHOUT
   *  re-issuing the seek — crucially, re-anchor listenAudioAnchor so the jumped-over
   *  span isn't credited as listening. This is the key difference from a plain
   *  'timeupdate' forward-jump, which is real background playback JS missed while
   *  frozen and MUST keep counting. (A 'seeked' emitted while JS is frozen is
   *  dropped, so a skip done while locked still slightly inflates by the ±15/30s
   *  interval — acceptable; the awake case is fully corrected here.) */
  private handleNativeSeeked(time: number): void {
    this.currentTime.set(time);
    this.updateCue(time);
    this.heardTick = time;
    this.runStart = null;
    this.provisional.set(null);
    if (this.listenAudioAnchor != null) this.listenAudioAnchor = time;
    this.lastChapterIdx = -1;
    if (this.sleepMode() === 'chapter') this.armNativeSleep();
    this.scrollTick.update((v) => v + 1);
  }

  /** Drop a breadcrumb at the spot the user is leaving, so an accidental jump is
   *  always recoverable. Call BEFORE the seek, with the pre-jump position. */
  markJumpFrom(fromSec: number): void {
    this.addBookmark('Jumped from here', 'jump', fromSec);
  }

  /** Arm the "arrival" breadcrumb after a deliberate jump. Once the user settles
   *  and listens continuously for HEARD_MIN_RUN seconds, a bookmark is dropped at
   *  the spot they landed on (see trackHeard). Call alongside markJumpFrom. */
  armArrivalBookmark(): void {
    this.arrivalArmed = true;
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

  /** Within the first 5 minutes you're close enough to the start that a rewind
   *  means "take me to the beginning" — so both back buttons (−5m and −10s) just
   *  jump to 0 there, instead of −10s nudging to 4:50. Past 5 min, normal skip. */
  private static readonly NEAR_START_SECONDS = 300;
  skipBack(delta: number): void {
    if (this.currentTime() < PlayerService.NEAR_START_SECONDS) this.seekTo(0, true);
    else this.seekTo(this.currentTime() + delta, true);
  }

  prevChapter(): void {
    const chs = this.chapters();
    const cur = this.currentChapter();
    if (!cur) return;
    const i = chs.indexOf(cur);
    const from = this.currentTime();
    // >3s into the chapter restarts it; otherwise step back.
    if (this.currentTime() - cur.start > 3) { this.markJumpFrom(from); this.seekTo(cur.start, true); }
    else if (i > 0) { this.markJumpFrom(from); this.seekTo(chs[i - 1].start, true); }
  }

  nextChapter(): void {
    const chs = this.chapters();
    const cur = this.currentChapter();
    if (!cur) return;
    const i = chs.indexOf(cur);
    if (i < chs.length - 1) { this.markJumpFrom(this.currentTime()); this.seekTo(chs[i + 1].start, true); }
  }

  setSpeed(v: number): void {
    // Credit the segment played so far at the OLD speed before switching, so the
    // real-time conversion in flushListening() uses the right divisor per segment.
    this.flushListening();
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
  addBookmark(label: string, kind: BookmarkKind = 'manual', position = this.currentTime()): void {
    const b = this.book();
    // Auto-bookmark dedup: the automatic kinds (e.g. "Opened the book") fire every
    // session, so closing + reopening at an unchanged spot would stack duplicates.
    // If ANY bookmark — auto, or a manual/renamed one the user placed — already
    // sits at this exact position (within 1s), don't auto-add another on top of
    // it. Manual/explicit adds are never blocked.
    if (kind !== 'manual' &&
        this.bookmarks().some((x) => Math.abs(x.position - position) < 1)) {
      return;
    }
    const bm: Bookmark = {
      id: `${Date.now()}-${Math.round(Math.random() * 1e6)}`,
      position,
      label,
      createdAt: Date.now(),
      kind,
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

  /** Rename a bookmark's label ("Went to sleep", "Leaving the gym"). Naming one
   *  makes it the user's: its kind becomes 'manual', so it renders with the
   *  manual icon and is never deduped away. Empty/whitespace names are ignored.
   *  Persisted locally and upserted to the server via op:'add' (the store folds
   *  latest-per-id), so the new name syncs across devices. */
  renameBookmark(id: string, label: string): void {
    const trimmed = label.trim();
    if (!trimmed) return;
    let updated: Bookmark | undefined;
    this.bookmarks.set(this.bookmarks().map((b) => {
      if (b.id !== id) return b;
      updated = { ...b, label: trimmed, kind: 'manual' };
      return updated;
    }));
    if (!updated) return;
    this.saveBookmarks();
    const b = this.book();
    const token = this.reader.token();
    if (token && b) this.api.postBookmark(token, { bookPath: b.downloadPath, op: 'add', bookmark: updated as unknown as { id: string } & Record<string, unknown> });
  }

  seekToBookmark(bm: Bookmark): void {
    this.seekTo(bm.position, true);
  }

  // ── Sleep timer controls ──────────────────────────────────────────────────────
  setSleepMinutes(min: number): void {
    this.setSleepSeconds(min * 60);
  }

  setSleepSeconds(sec: number): void {
    this.sleepMode.set('time');
    this.sleepTargetMs = Date.now() + sec * 1000;
    this.sleepChapterEnd = null;
    this.beginSleep();
  }

  setSleepEndOfChapter(): void {
    const ch = this.currentChapter();
    if (!ch) return; // no chapters — caller should hide this option
    this.sleepMode.set('chapter');
    this.sleepChapterEnd = ch.end;
    this.sleepTargetMs = null;
    this.beginSleep();
  }

  /** Add (or subtract) minutes on the running timer — the −15/+15 circles.
   *  Converts an end-of-chapter timer to a time timer, and never goes below 0. */
  addSleepMinutes(min: number): void {
    const now = Date.now();
    if (this.sleepMode() === 'chapter' && this.sleepChapterEnd != null) {
      const remainingRealMs = Math.max(0, (this.sleepChapterEnd - this.currentTime()) / (this.speed() || 1)) * 1000;
      this.sleepTargetMs = now + remainingRealMs + min * 60_000;
      this.sleepChapterEnd = null;
      this.sleepMode.set('time');
    } else if (this.sleepMode() === 'time' && this.sleepTargetMs != null) {
      this.sleepTargetMs = Math.max(this.sleepTargetMs, now) + min * 60_000;
    } else {
      if (min > 0) this.setSleepMinutes(min); // off → start fresh
      return;
    }
    if (this.sleepTargetMs != null && this.sleepTargetMs < now) this.sleepTargetMs = now;
    this.updateSleepRemaining();
    this.armNativeSleep(); // target changed (extended, or chapter→time) — re-arm native
  }

  cancelSleep(): void {
    this.sleepMode.set('off');
    this.sleepTargetMs = null;
    this.sleepChapterEnd = null;
    this.sleepStartMs = null;
    this.sleepNextBookmarkMs = null;
    this.sleepRemaining.set(0);
    this.audio.clearSleep?.(); // disarm the native backstop (no-op on web / if unarmed)
  }

  private beginSleep(): void {
    this.sleepStartMs = Date.now();
    this.sleepNextBookmarkMs = Date.now() + PlayerService.SLEEP_BOOKMARK_INTERVAL;
    this.addBookmark('Sleep timer started', 'sleep');
    this.updateSleepRemaining();
    this.armNativeSleep();
  }

  /** Arm (or re-arm) the native sleep backstop to match the current JS target.
   *  The JS timer (checkSleep) can't fire while the WebView is frozen on the lock
   *  screen, so the native side pauses at the same moment: a wall-clock delay for
   *  'time', a content-position boundary for 'chapter'. JS stays the authority —
   *  it computes the target and re-arms whenever the target changes. No-op on web. */
  private armNativeSleep(): void {
    if (this.sleepMode() === 'time' && this.sleepTargetMs != null) {
      this.audio.armSleep?.({ afterMs: Math.max(0, this.sleepTargetMs - Date.now()) });
    } else if (this.sleepMode() === 'chapter' && this.sleepChapterEnd != null) {
      this.audio.armSleep?.({ atPosition: this.sleepChapterEnd });
    } else {
      this.audio.clearSleep?.();
    }
  }

  private checkSleep(): void {
    if (this.sleepMode() === 'off') return;
    const now = Date.now();
    // Breadcrumb every 15 min while playing: "15 minutes into sleep timer", etc.
    if (this.sleepNextBookmarkMs != null && this.sleepStartMs != null && now >= this.sleepNextBookmarkMs) {
      const mins = Math.round((now - this.sleepStartMs) / 60_000);
      this.addBookmark(`${mins} minutes into sleep timer`, 'sleep');
      this.sleepNextBookmarkMs += PlayerService.SLEEP_BOOKMARK_INTERVAL;
    }
    const expired =
      (this.sleepMode() === 'time' && this.sleepTargetMs != null && now >= this.sleepTargetMs) ||
      (this.sleepMode() === 'chapter' && this.sleepChapterEnd != null && this.currentTime() >= this.sleepChapterEnd);
    if (expired) {
      this.addBookmark('Sleep timer ended', 'sleep');
      this.wantPlaying = false; // intentional stop — don't auto-resume
      this.audio.pause();
      this.cancelSleep();
      return;
    }
    this.updateSleepRemaining();
  }

  private updateSleepRemaining(): void {
    if (this.sleepMode() === 'time' && this.sleepTargetMs != null) {
      this.sleepRemaining.set(Math.max(0, Math.round((this.sleepTargetMs - Date.now()) / 1000)));
    } else if (this.sleepMode() === 'chapter' && this.sleepChapterEnd != null) {
      this.sleepRemaining.set(Math.max(0, Math.round(this.sleepChapterEnd - this.currentTime())));
    } else {
      this.sleepRemaining.set(0);
    }
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
    this.lastChapterIdx = -1; // re-init chapter tracking for this book
    this.addBookmark('Opened the book', 'open');
    if (this.pendingAutoplay) {
      this.pendingAutoplay = false;
      this.play();
    }
  }

  /** Auto-bookmark when playback naturally crosses into the next chapter. Seeks
   *  reset the tracker (see seekTo), so only genuine listen-throughs are marked. */
  private checkChapterFinish(): void {
    const chs = this.chapters();
    if (!chs.length) return;
    const cur = this.currentChapter();
    const idx = cur ? chs.indexOf(cur) : -1;
    if (this.lastChapterIdx < 0) { this.lastChapterIdx = idx; return; }
    if (idx === this.lastChapterIdx + 1 && cur && this.currentTime() - cur.start < 5) {
      const finished = chs[this.lastChapterIdx];
      if (finished) this.addBookmark(`Finished “${finished.title}”`, 'chapter');
    }
    this.lastChapterIdx = idx;
  }

  private onTimeUpdate(): void {
    const t = this.audio.currentTime;
    this.currentTime.set(t);
    this.updateCue(t);
    this.trackHeard(t);
    this.checkSleep();
    this.checkChapterFinish();
    const dur = this.duration();
    // The native backend keeps its own Now Playing position (MPNowPlayingInfo);
    // only the web mediaSession needs feeding here.
    if (!this.audio.nativeControls && dur > 0 && 'mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
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
      // The user jumped, then settled here and listened for 10s straight → drop a
      // breadcrumb at the spot they landed on (once per jump, at the settle point).
      if (this.arrivalArmed) {
        this.arrivalArmed = false;
        this.addBookmark('Resumed here', 'arrive', this.runStart);
      }
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
  private static readonly POS_PREFIX = 'bookshelf-pos:';
  private posKey(): string { return `${PlayerService.POS_PREFIX}${this.book()?.downloadPath ?? ''}`; }
  private lastServerPosAt = 0;

  /** Scan the persisted position cache for every book's last-played time, so the
   *  shelf's "Recent" sort reflects prior sessions on first paint (before any
   *  save this session). Legacy raw-number records carry no timestamp → skipped. */
  private static loadPlayedAt(): Map<string, number> {
    const map = new Map<string, number>();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(PlayerService.POS_PREFIX)) continue;
      const path = key.slice(PlayerService.POS_PREFIX.length);
      try {
        const at = Number(JSON.parse(localStorage.getItem(key) || '')?.at) || 0;
        if (path && at > 0) map.set(path, at);
      } catch { /* legacy raw number → no timestamp to sort by */ }
    }
    return map;
  }

  private savePosition(force = false): void {
    this.saveHeard(force);
    const t = this.currentTime();
    const b = this.book();
    if (t <= 0 || !b) return;
    const now = Date.now();
    localStorage.setItem(this.posKey(), JSON.stringify({ v: t, at: now }));
    this.playedAt.update((m) => new Map(m).set(b.downloadPath, now));
    // Route to the book's ORIGIN server. Local books have no server token → skip
    // (position still persists in localStorage above, so resume works offline).
    const token = this.reader.token(b.originServerId);
    if (!token) return;
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
    const token = this.reader.token(b.originServerId);
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
    const token = this.reader.token(b.originServerId);
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
    const token = this.reader.token(b.originServerId);
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
    const token = this.reader.token(b.originServerId);
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

  /** Start position = the most recently written candidate. Later arguments win
   *  ties (>=), so the call order (local, server, native) keeps "server beats
   *  local on ties" and lets native — the live-most source, saved even while the
   *  WebView was frozen — beat both. Returns 0 when every candidate is null. */
  private pickStart(...cands: Array<{ v: number; at: number } | null>): number {
    let best: { v: number; at: number } | null = null;
    for (const c of cands) {
      if (c && (!best || c.at >= best.at)) best = c;
    }
    return best?.v ?? 0;
  }

  private startPosTimer(): void {
    if (!this.posSaveTimer) this.posSaveTimer = setInterval(() => this.savePosition(), 5000);
  }

  // ── Listening-time heartbeat ───────────────────────────────────────────────
  private startHeartbeat(): void {
    this.listenAudioAnchor = this.audio.currentTime;
    if (!this.heartbeatTimer) this.heartbeatTimer = setInterval(() => this.flushListening(), 20_000);
  }

  private stopHeartbeat(): void {
    this.flushListening();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.listenAudioAnchor = null;
  }

  /**
   * Record REAL listening time elapsed since the last flush — but only once this
   * book session has passed ANALYTICS_MIN_SECONDS. Below the threshold the time
   * is buffered locally and nothing is sent, so short opens leave no trace; on
   * crossing it, the whole buffered session is recorded in one go.
   *
   * The raw delta is audio progress (audio.currentTime), which at N× speed
   * advances N× faster than the wall clock. Dividing by the playback speed
   * converts it back to real time spent: burning an 18h book at 2× credits 9h.
   * setSpeed() flushes before changing the rate, so each contiguous segment is
   * divided by the speed it was actually played at.
   */
  private flushListening(): void {
    const book = this.book();
    // Route analytics to the book's ORIGIN server, with that server's token.
    const token = this.reader.token(book?.originServerId);
    if (!token || !book || this.listenAudioAnchor == null) return;
    const cur = this.audio.currentTime;
    const progress = cur - this.listenAudioAnchor;
    this.listenAudioAnchor = cur;
    // Only forward, contiguous playback counts. Non-positive = paused/seek-back;
    // an implausibly large jump = a seek that slipped past re-anchoring. Either
    // way, credit nothing and let the next flush resume from the new anchor.
    if (progress <= 0.5 || progress > PlayerService.LISTEN_MAX_FLUSH_SECONDS) return;
    // Audio progress → real time spent at the current playback speed.
    const seconds = progress / (this.speed() || 1);

    // Drop a safety bookmark every hour of real listening so a lost session
    // never costs the user their place. Reuses this segment time, which already
    // handles pauses (heartbeat stops), seeks (excluded above) and speed.
    this.playedSinceBookmark += seconds;
    if (this.playedSinceBookmark >= 3600) {
      this.playedSinceBookmark -= 3600;
      this.addBookmark('One hour of listening', 'hour');
    }

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
    // Persist-then-send: the durable queue survives an offline/flaky connection
    // and flushes on reconnect. The stable event id makes the server write
    // idempotent, so a replay never double-counts.
    this.analyticsQueue.enqueue(book.originServerId, token, {
      bookPath: book.downloadPath,
      title: book.title,
      author: book.author || '',
      seconds,
      id: crypto.randomUUID(),
    });
  }

  // ── Lock-screen / background controls ─────────────────────────────────────────
  // On the NATIVE backend these two are hard no-ops: the plugin owns the
  // AVAudioSession and lock screen, and the page itself plays no media. Poking
  // WebKit's mediaSession/audioSession anyway makes WebKit re-arbitrate the
  // app-wide AVAudioSession — on "paused" it DEACTIVATES the session (notifying
  // other apps) about a second later, which hands the Now Playing slot, and the
  // AirPods play button, back to the previously-playing app (Apple Music…).
  // That was the "pause, hit play, some other app starts" bug.
  private setPlaybackState(state: MediaSessionPlaybackState): void {
    if (this.audio.nativeControls) return;
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  /** WebKit-only AVAudioSession bridge; feature-detected. */
  private setPlaybackAudioSession(): void {
    if (this.audio.nativeControls) return;
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

  /** Route a lock-screen / Control Center command (native backend) to the same
   *  handlers the web mediaSession uses.
   *
   *  play/pause are the exception: the plugin already acted on AVPlayer BEFORE
   *  this event reached JS (toggles arrive pre-resolved), because transport must
   *  work even while the WebView is suspended — iOS freezes it within minutes of
   *  backgrounding while paused, and a lock-screen play that round-trips through
   *  frozen JS plays nothing. Here we only record the user's intent so the
   *  route-change auto-resume in the 'pause' listener respects a deliberate
   *  pause (the plugin sends 'command' before 'state', so intent lands first).
   *
   *  Skips, scrubbing, and chapter jumps are NO LONGER handled here — the plugin
   *  performs those seeks natively (they must work while this WebView is frozen on
   *  the lock screen) and JS re-syncs its position from the resulting 'time'
   *  events, so there are no cases for them and nothing to replay in a burst when
   *  JS thaws. In-app UI buttons still call skip()/seekTo()/next-prevChapter()
   *  directly — only the lock-screen path changed. */
  private handleRemoteCommand(action: string): void {
    switch (action) {
      case 'play': this.wantPlaying = true; break;
      case 'pause': this.wantPlaying = false; break;
      case 'sleep':
        // The native sleep backstop fired (JS was likely frozen). Clear intent
        // BEFORE the paired 'pause' state event arrives so the auto-resume policy
        // respects the stop, and tear down the JS-side timer/UI state.
        this.wantPlaying = false;
        this.cancelSleep();
        break;
    }
  }

  /** Turn a resolved cover URL into a self-contained data: URI for the lock
   *  screen. A server cover already arrives as `data:` (passed through); a
   *  downloaded book's cover is a WebView-scoped blob:/file: URL, which the OS
   *  media service and the native AVPlayer bridge can't fetch — so we read the
   *  bytes here (fetch works INSIDE the WebView) and inline them as base64.
   *  Returns null when there's no cover or the read fails, so the caller clears
   *  the artwork rather than leaving the previous book's picture up. */
  private async toArtworkDataUrl(cover: string | null): Promise<string | null> {
    if (!cover) return null;
    if (cover.startsWith('data:')) return cover;
    const res = await fetch(cover);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error ?? new Error('cover read failed'));
      r.readAsDataURL(blob);
    });
  }

  /** MIME type declared by a data: URI (e.g. "image/png"), for MediaImage.type. */
  private dataUrlMime(dataUrl: string): string {
    const m = /^data:([^;,]+)/.exec(dataUrl);
    return m ? m[1] : 'image/jpeg';
  }

  private setupMediaSession(): void {
    const book = this.book();
    if (!book) return;

    // Native backend: push metadata to the OS lock screen; commands are already
    // wired in the constructor. (WKWebView may lack navigator.mediaSession, so
    // this must run before that guard.)
    const nc = this.audio.nativeControls;
    if (nc) {
      nc.setMetadata({ title: book.title, artist: book.author || '', artworkUrl: this.artworkUrl ?? undefined });
      return;
    }

    if (!('mediaSession' in navigator)) return;

    const artwork = this.artworkUrl
      ? [{ src: this.artworkUrl, sizes: '512x512', type: this.dataUrlMime(this.artworkUrl) }]
      : [];
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
