/**
 * Playback backend abstraction for the audiobook player.
 *
 * On the web (and Android WebView) this is just the browser `HTMLAudioElement`.
 * Inside the native iOS shell it's an AVPlayer bridge (the `NativeAudio`
 * Capacitor plugin), which plays through the native audio stack instead of the
 * WKWebView. That removes the ~0.5s "blip" when the phone locks (the WebView is
 * suspended-and-resumed; AVPlayer is not) and unlocks arbitrary playback rates
 * (2x, 3x…) with pitch correction — see NativeAudioPlugin.swift.
 *
 * `PlayerService` holds exactly one of these as `this.audio` and drives it
 * through the same small surface either way. The web element already implements
 * that surface natively; `NativeAudioBackend` reimplements it over the plugin.
 */

/** Native lock-screen controls, present only on the native backend. When
 *  `undefined` (web), the service uses `navigator.mediaSession` instead. */
export interface NativeControls {
  /** Push Now Playing metadata (title/author/artwork) to the lock screen. */
  setMetadata(m: { title: string; artist: string; artworkUrl?: string }): void;
  /** Receive lock-screen / Control Center commands. `value` carries the target
   *  time for the 'seek' action (scrubbing on the lock screen). */
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
}

interface NativePlugin {
  load(o: { url: string }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(o: { time: number }): Promise<void>;
  setRate(o: { rate: number }): Promise<void>;
  setVolume(o: { volume: number }): Promise<void>;
  setNowPlaying(o: { title: string; artist: string; artworkUrl?: string }): Promise<void>;
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
      destroy: () => call('destroy'),
      addListener: (event, cb) => addListener(PLUGIN, event, cb),
    };
  }
  return null;
}

/** AVPlayer-backed implementation, mirroring the media-element surface. State is
 *  mirrored locally and kept in sync by the plugin's event stream. */
class NativeAudioBackend implements AudioBackend {
  preload = 'auto';
  private _src = '';
  private _currentTime = 0;
  private _duration = 0;
  private _paused = true;
  private _ended = false;
  private _rate = 1;
  private _volume = 1;
  private readonly listeners = new Map<string, Set<(ev?: Event) => void>>();
  private commandCb: ((action: string, value?: number) => void) | null = null;

  constructor(private readonly plugin: NativePlugin) {
    plugin.addListener('ready', (d) => {
      this._duration = (d['duration'] as number) ?? 0;
      this._ended = false;
      this.emit('loadedmetadata');
    });
    plugin.addListener('time', (d) => {
      this._currentTime = (d['currentTime'] as number) ?? 0;
      this.emit('timeupdate');
    });
    plugin.addListener('state', (d) => {
      switch (d['state']) {
        case 'playing': this._paused = false; this._ended = false; this.emit('play'); break;
        case 'paused': this._paused = true; this.emit('pause'); break;
        case 'ended': this._paused = true; this._ended = true; this.emit('ended'); break;
      }
    });
    plugin.addListener('error', () => this.emit('error'));
    plugin.addListener('command', (d) => {
      this.commandCb?.(d['action'] as string, d['time'] as number | undefined);
    });
  }

  get src(): string { return this._src; }
  set src(v: string) { this._src = v; }
  get currentTime(): number { return this._currentTime; }
  set currentTime(v: number) { this._currentTime = v; void this.plugin.seek({ time: v }); }
  get duration(): number { return this._duration; }
  get paused(): boolean { return this._paused; }
  get ended(): boolean { return this._ended; }
  get playbackRate(): number { return this._rate; }
  set playbackRate(v: number) { this._rate = v; void this.plugin.setRate({ rate: v }); }
  get volume(): number { return this._volume; }
  set volume(v: number) { this._volume = v; void this.plugin.setVolume({ volume: v }); }

  play(): Promise<void> {
    return Promise.resolve(this.plugin.play()).then(() => { this._paused = false; });
  }
  pause(): void { void this.plugin.pause(); }
  load(): void {
    if (!this._src) return;
    this._ended = false;
    this._currentTime = 0;
    void this.plugin.load({ url: this._src });
  }
  setAttribute(): void { /* DOM-only; no-op natively */ }
  removeAttribute(): void {
    // PlayerService.close() calls removeAttribute('src') to unload — tear the
    // native player down and clear the lock screen.
    this._src = '';
    void this.plugin.destroy();
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

  readonly nativeControls: NativeControls = {
    setMetadata: (m) => { void this.plugin.setNowPlaying(m); },
    onCommand: (cb) => { this.commandCb = cb; },
  };
}

/** One backend per platform: native AVPlayer bridge on iOS, else the browser
 *  audio element (which structurally satisfies AudioBackend). */
export function createAudioBackend(): AudioBackend {
  const plugin = getNativeAudio();
  if (plugin) return new NativeAudioBackend(plugin);
  return new Audio() as unknown as AudioBackend;
}
