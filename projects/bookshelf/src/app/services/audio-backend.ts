/**
 * Playback backend abstraction for the audiobook player AND the reader's
 * read-aloud (RenderPlaybackService).
 *
 * On the web (and Android WebView) this is just the browser `HTMLAudioElement`
 * — one per service, so web behaviour is fully independent and unchanged.
 * Inside the native iOS shell it's an AVPlayer bridge (the `NativeAudio`
 * Capacitor plugin), which plays through the native audio stack instead of the
 * WKWebView. That removes the ~0.5s "blip" when the phone locks (the WebView is
 * suspended-and-resumed; AVPlayer is not) and unlocks arbitrary playback rates
 * (2x, 3x…) with pitch correction — see NativeAudioPlugin.swift.
 *
 * ── Ownership arbitration (native only) ──────────────────────────────────────
 * The plugin is a process-wide SINGLETON with exactly ONE AVPlayer, but two
 * services want it: PlayerService (audiobooks) and RenderPlaybackService (reader
 * read-aloud). Each still calls `createAudioBackend()` and gets its OWN facade
 * (own mirrors, own listeners, own Now Playing metadata) — but only one facade
 * may drive the shared AVPlayer at a time.
 *
 * A module-level arbiter enforces this. It subscribes to the plugin's event
 * stream ONCE (the native side broadcasts every event to every JS listener, so
 * per-facade subscriptions would cross the streams — both services would react
 * to each other's audio) and dispatches each event to the CURRENT OWNER only.
 *
 * Whichever facade `load()`s or `play()`s last becomes the owner; the previous
 * owner is EJECTED — cleanly paused, its owning service told to drop its resume
 * intent. Eject fires the owning service's command('pause') BEFORE the 'pause'
 * event (mirroring the plugin's own remote-command ordering) so a service whose
 * policy auto-resumes on external pauses sees the deliberate pause first and
 * can't fight to steal the player back. The arbiter needn't call plugin.pause()
 * — the incoming `load()` tears the old item down.
 *
 * An ejected facade keeps its mirrors, so when its service plays again it
 * REACQUIRES: reloads its source, seeks back to the mirrored position, restores
 * rate + Now Playing metadata, and resumes exactly where it left off. That
 * reload's 'ready' is swallowed (duration mirror updated, but NO 'loadedmetadata'
 * emitted) — otherwise PlayerService would re-run its metadata handler and seek
 * to a stale pendingStart.
 *
 * The web element already implements the media surface natively;
 * `NativeAudioBackend` reimplements it over the plugin.
 */

/** Native lock-screen controls, present only on the native backend. When
 *  `undefined` (web), the service uses `navigator.mediaSession` instead. */
export interface NativeControls {
  /** Push Now Playing metadata (title/author/artwork) to the lock screen. */
  setMetadata(m: { title: string; artist: string; artworkUrl?: string }): void;
  /** Receive lock-screen / Control Center commands. `value` carries the target
   *  time for the 'seek' action (scrubbing on the lock screen).
   *  'play'/'pause' arrive AFTER the plugin has already acted on AVPlayer
   *  (toggles come pre-resolved) — they're intent signals, not requests; the
   *  matching 'state' event follows. Skips/chapters/seek are still requests
   *  for JS to perform. */
  onCommand(cb: (action: string, value?: number) => void): void;
}

/** The subset of HTMLMediaElement that PlayerService actually touches. */
export interface AudioBackend {
  preload: string;
  src: string;
  currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  playbackRate: number;
  volume: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: (ev?: Event) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (ev?: Event) => void): void;
  /** Remote Playback API (AirPlay/Cast) — web only; undefined on native. */
  readonly remote?: RemotePlayback;
  /** Present only on the native backend. */
  readonly nativeControls?: NativeControls;

  // ── Native position persistence (absent on the web <audio> element) ──────────
  // The WebView is frozen while backgrounded, so its JS position saver stops
  // while native audio plays on for hours. These let the native side own
  // persistence and feed it back. Callers MUST use optional calls (`?.`).
  /** Set the key (book downloadPath) the native side saves progress under. */
  setPersistKey?(key: string): void;
  /** The position the native side saved for `key` (null when none/unavailable). */
  getSavedPosition?(key: string): Promise<{ v: number; at: number } | null>;
  /** Re-read the live native position into the JS time mirror after a wake, so
   *  the stale mirror doesn't get saved back over the real position. */
  syncFromNative?(): Promise<void>;
}

interface NativePlugin {
  load(o: { url: string; key?: string }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { time: number }): Promise<void>;
  setRate(o: { rate: number }): Promise<void>;
  setVolume(o: { volume: number }): Promise<void>;
  setNowPlaying(o: { title: string; artist: string; artworkUrl?: string }): Promise<void>;
  /** Fetch the position the native side saved while the WebView was frozen (empty
   *  object when nothing is stored for this key). See getPosition in the plugin. */
  getPosition(o: { key: string }): Promise<{ time?: number; at?: number }>;
  destroy(): Promise<void>;
  addListener(event: string, cb: (data: Record<string, unknown>) => void): unknown;
}

interface CapBridge {
  isNativePlatform?: () => boolean;
  /** Present only when the @capacitor/core MODULE is bundled. This app isn't, so
   *  on-device we drive the native bridge primitives below instead. */
  registerPlugin?: (name: string) => unknown;
  /** Injected by native-bridge.js: call a plugin method, get a Promise. */
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
  /** Injected by native-bridge.js: subscribe to a plugin event. */
  addListener?: (plugin: string, event: string, cb: (data: Record<string, unknown>) => void) => unknown;
}

const PLUGIN = 'NativeAudio';

/** The native runtime injects `window.Capacitor`; web builds take no dependency
 *  on @capacitor/core (mirrors ServerConfigService's detection). The injected
 *  global exposes `nativePromise`/`addListener` but NOT `registerPlugin` (that
 *  lives in the core module we don't bundle), so build the plugin adapter from
 *  the bridge primitives directly. */
function getNativeAudio(): NativePlugin | null {
  const cap = (window as unknown as { Capacitor?: CapBridge }).Capacitor;
  if (!cap?.isNativePlatform?.()) return null;

  // If @capacitor/core is ever bundled, prefer its proper proxy.
  if (typeof cap.registerPlugin === 'function') {
    try { return cap.registerPlugin(PLUGIN) as NativePlugin; } catch { /* fall through */ }
  }

  if (typeof cap.nativePromise === 'function' && typeof cap.addListener === 'function') {
    const nativePromise = cap.nativePromise.bind(cap);
    const addListener = cap.addListener.bind(cap);
    const call = (m: string, o?: unknown) => nativePromise(PLUGIN, m, o) as Promise<void>;
    return {
      load: (o) => call('load', o),
      play: () => call('play'),
      pause: () => call('pause'),
      seek: (o) => call('seek', o),
      setRate: (o) => call('setRate', o),
      setVolume: (o) => call('setVolume', o),
      setNowPlaying: (o) => call('setNowPlaying', o),
      getPosition: (o) => nativePromise(PLUGIN, 'getPosition', o) as Promise<{ time?: number; at?: number }>,
      destroy: () => call('destroy'),
      addListener: (event, cb) => addListener(PLUGIN, event, cb),
    };
  }
  return null;
}

type NowPlaying = { title: string; artist: string; artworkUrl?: string };

// ── Module-level ownership arbiter ───────────────────────────────────────────
// The plugin is a singleton; `currentOwner` is the one facade currently driving
// its AVPlayer. `arbiterPlugin` guards one-time event subscription. See the
// header for the full ownership model.
let arbiterPlugin: NativePlugin | null = null;
let currentOwner: NativeAudioBackend | null = null;

/** Subscribe to the plugin's event stream exactly once, dispatching each event
 *  to the current owner only. Native `notifyListeners` broadcasts to every JS
 *  subscriber, so registering per-facade would deliver every facade another
 *  facade's events — hence a single arbiter that routes by ownership. */
function ensureArbiter(plugin: NativePlugin): void {
  if (arbiterPlugin) return;
  arbiterPlugin = plugin;
  plugin.addListener('ready', (d) => currentOwner?.handleReady((d['duration'] as number) ?? 0));
  plugin.addListener('time', (d) => currentOwner?.handleTime((d['currentTime'] as number) ?? 0));
  plugin.addListener('state', (d) => currentOwner?.handleState(d['state'] as string));
  plugin.addListener('error', () => currentOwner?.handleError());
  plugin.addListener('command', (d) => currentOwner?.handleCommand(d['action'] as string, d['time'] as number | undefined));
}

/** Make `next` the sole owner and eject the previous one. The owner pointer is
 *  switched SYNCHRONOUSLY first, so any trailing plugin events from the outgoing
 *  item route to the new owner (which dedupes them against its own mirrors)
 *  rather than back to the facade we're ejecting. */
function acquire(next: NativeAudioBackend): void {
  if (currentOwner === next) return; // already own it — nothing to eject
  const prev = currentOwner;
  currentOwner = next;
  prev?.eject();
}

/** AVPlayer-backed implementation, mirroring the media-element surface. State is
 *  mirrored locally and kept in sync (for the current owner) by the arbiter's
 *  dispatch of the plugin event stream. */
class NativeAudioBackend implements AudioBackend {
  preload = 'auto';
  private _src = '';
  private _currentTime = 0;
  private _duration = 0;
  private _paused = true;
  private _ended = false;
  private _rate = 1;
  private _volume = 1;
  private _nowPlaying: NowPlaying | null = null;
  // The key (book downloadPath) the native side persists this book's position
  // under. Empty ⇒ no key sent, so the plugin skips persistence — that's how
  // RenderPlaybackService (read-aloud) shares this class without saving positions.
  private persistKey = '';
  private readonly listeners = new Map<string, Set<(ev?: Event) => void>>();
  private commandCb: ((action: string, value?: number) => void) | null = null;
  // Set while a reacquire reload is in flight, so its 'ready' restores state
  // (seek/rate/metadata/play) and resolves the play() promise instead of being
  // reported to listeners as a fresh 'loadedmetadata'.
  private reacquirePending: { at: number; resolve: () => void; reject: (e: unknown) => void } | null = null;

  constructor(private readonly plugin: NativePlugin) {}

  // ── Owner-only view of the plugin. Setters mirror state locally always, but
  //    touch the shared AVPlayer only when we're the owner. ──────────────────
  private get isOwner(): boolean { return currentOwner === this; }

  get src(): string { return this._src; }
  set src(v: string) { this._src = v; }
  get currentTime(): number { return this._currentTime; }
  set currentTime(v: number) { this._currentTime = v; if (this.isOwner) void this.plugin.seek({ time: v }); }
  get duration(): number { return this._duration; }
  get paused(): boolean { return this._paused; }
  get ended(): boolean { return this._ended; }
  get playbackRate(): number { return this._rate; }
  set playbackRate(v: number) { this._rate = v; if (this.isOwner) void this.plugin.setRate({ rate: v }); }
  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = v; if (this.isOwner) void this.plugin.setVolume({ volume: v }); }

  play(): Promise<void> {
    if (this.isOwner) {
      return Promise.resolve(this.plugin.play()).then(() => { this._paused = false; });
    }
    // Ejected (another service holds the player) but we still have a source →
    // reacquire and resume from our mirrored position. No source = nothing to
    // resume; stay put.
    if (!this._src) return Promise.resolve();
    return this.reacquire();
  }

  pause(): void {
    this._paused = true;
    if (this.isOwner) void this.plugin.pause();
  }

  load(): void {
    if (!this._src) return; // matches the web element: load() with no src is a no-op
    // A fresh load supersedes any in-flight reacquire. Leaving it pending would
    // make this load's 'ready' run the reacquire branch instead: seek to a stale
    // position, auto-play, and swallow the 'loadedmetadata' the service is
    // waiting on for its own start-position seek.
    this.settleReacquire(new Error('superseded by load'));
    this._ended = false;
    this._currentTime = 0;
    acquire(this); // taking (or keeping) the player; ejects the previous owner
    // Apply our mirrored volume before the load: the setter is owner-gated, so a
    // volume chosen while another facade owned the player (e.g. PlayerService's
    // saved preference set in its constructor, before any book was loaded) was
    // only mirrored, never pushed. The plugin carries self.vol across loads, so
    // one push here restores it for this and subsequent (reacquire) loads.
    void this.plugin.setVolume({ volume: this._volume });
    void this.plugin.load({ url: this._src, key: this.persistKey || undefined });
  }

  setPersistKey(key: string): void { this.persistKey = key; }

  /** Ask the native side for the position it saved for `key` (progress the JS
   *  saver missed while the WebView was frozen). Maps the plugin's {time, at} to
   *  the {v, at} candidate shape; null when nothing is stored or the call fails. */
  async getSavedPosition(key: string): Promise<{ v: number; at: number } | null> {
    try {
      const p = await this.plugin.getPosition({ key });
      if (p?.time == null) return null;
      return { v: p.time, at: p.at ?? 0 };
    } catch {
      return null;
    }
  }

  /** Repair the JS time mirror from the live native position after a wake. While
   *  the WebView is frozen the AVPlayer plays on but its periodic 'time' events
   *  don't reach JS, so `_currentTime` is stale on resume; if left uncorrected the
   *  5s save timer would write it back over the real position. Owner-only, no-op
   *  without a key, never throws. */
  async syncFromNative(): Promise<void> {
    if (!this.isOwner || !this.persistKey) return;
    try {
      const p = await this.plugin.getPosition({ key: this.persistKey });
      const t = p?.time;
      if (typeof t === 'number' && Number.isFinite(t) && Math.abs(t - this._currentTime) > 1) {
        this._currentTime = t;
        this.emit('timeupdate');
      }
    } catch { /* leave the mirror as-is */ }
  }

  setAttribute(): void { /* DOM-only; no-op natively */ }
  removeAttribute(): void {
    // PlayerService.close() / RenderPlaybackService.stop() call removeAttribute('src')
    // to unload. Only the OWNER tears the shared player down and clears the lock
    // screen; a non-owner just drops its own mirrors — the plugin belongs to the
    // other service now and must not be touched.
    this._src = '';
    this._currentTime = 0;
    this._duration = 0;
    this._ended = false;
    this._paused = true;
    if (this.isOwner) {
      currentOwner = null;
      void this.plugin.destroy();
    }
  }

  addEventListener(type: string, listener: (ev?: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(listener);
  }
  removeEventListener(type: string, listener: (ev?: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  private emit(type: string): void { this.listeners.get(type)?.forEach((l) => l()); }

  // ── Arbiter-dispatched plugin events (called only while this is the owner) ──
  handleReady(duration: number): void {
    this._duration = duration;
    this._ended = false;
    const rq = this.reacquirePending;
    if (rq) {
      // This 'ready' is our own reacquire reload: restore position/rate/metadata
      // and resume WITHOUT emitting 'loadedmetadata' (that would make PlayerService
      // re-run onLoadedMetadata and seek to a stale pendingStart). Duration mirror
      // is refreshed above so callers still see the right length.
      this.reacquirePending = null;
      void this.plugin.seek({ time: rq.at });
      void this.plugin.setRate({ rate: this._rate });
      if (this._nowPlaying) void this.plugin.setNowPlaying(this._nowPlaying);
      Promise.resolve(this.plugin.play()).then(() => { this._paused = false; rq.resolve(); }, rq.reject);
      return;
    }
    this.emit('loadedmetadata');
  }
  handleTime(time: number): void { this._currentTime = time; this.emit('timeupdate'); }
  handleState(state: string): void {
    switch (state) {
      case 'playing': this._paused = false; this._ended = false; this.emit('play'); break;
      case 'paused': this._paused = true; this.emit('pause'); break;
      case 'ended': this._paused = true; this._ended = true; this.emit('ended'); break;
    }
  }
  handleError(): void {
    this.settleReacquire(new Error('reacquire load failed'));
    this.emit('error');
  }

  /** Reject-and-clear a pending reacquire (load failed / superseded / ejected),
   *  so its 'ready' can never be misattributed to a later load. */
  private settleReacquire(reason: Error): void {
    const rq = this.reacquirePending;
    if (!rq) return;
    this.reacquirePending = null;
    rq.reject(reason);
  }
  handleCommand(action: string, value?: number): void { this.commandCb?.(action, value); }

  /** Take the player back and resume mid-item from the mirrored position. The
   *  actual seek/rate/metadata/play run when the reload's 'ready' arrives (see
   *  handleReady), so this returns a promise that settles once we're playing. */
  private reacquire(): Promise<void> {
    acquire(this);
    const at = this._currentTime;
    return new Promise<void>((resolve, reject) => {
      this.reacquirePending = { at, resolve, reject };
      void this.plugin.load({ url: this._src, key: this.persistKey || undefined });
    });
  }

  /** Called by the arbiter when another facade takes the player. Send the owning
   *  service the command('pause') FIRST so it clears its resume intent, THEN the
   *  'pause' event — same ordering the plugin uses for real remote commands, so a
   *  service that auto-resumes on external pauses respects this deliberate one.
   *  We don't touch the plugin: the incoming load() already tore our item down. */
  eject(): void {
    // Being ejected mid-reacquire means we lost the race for the player — the
    // reload's 'ready' will route to the new owner, so settle our promise now
    // (the rejection lands in the service's play() error path, which parks it
    // as paused — exactly the ejected state).
    this.settleReacquire(new Error('ejected during reacquire'));
    this.commandCb?.('pause');
    this._paused = true;
    this.emit('pause');
  }

  readonly nativeControls: NativeControls = {
    // Stash the metadata so a reacquire can re-push it; forward to the lock screen
    // only while we own the player (a non-owner would clobber the other service's
    // Now Playing card).
    setMetadata: (m) => { this._nowPlaying = m; if (this.isOwner) void this.plugin.setNowPlaying(m); },
    onCommand: (cb) => { this.commandCb = cb; },
  };
}

/** One backend per service call: on native, a facade over the shared AVPlayer
 *  bridge (arbitrated for single ownership); on web, an independent browser
 *  audio element (which structurally satisfies AudioBackend). */
export function createAudioBackend(): AudioBackend {
  const plugin = getNativeAudio();
  if (plugin) {
    ensureArbiter(plugin);
    return new NativeAudioBackend(plugin);
  }
  return new Audio() as unknown as AudioBackend;
}
