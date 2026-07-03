import { computed, Injectable, signal } from '@angular/core';

const KEY = 'bookshelf-server-url';

/**
 * Where the Bookshelf API lives. In a browser the app is SERVED by that same
 * server, so the base is '' and every request stays relative — unchanged
 * behavior. In the native app (Capacitor) the bundle loads from
 * capacitor://localhost, so the user pairs with a server once and every
 * request/WS/media URL is prefixed with its absolute http(s) origin.
 */
@Injectable({ providedIn: 'root' })
export class ServerConfigService {
  /** True inside the Capacitor shell. Detected via the window global the native
   *  runtime injects, so web builds take no dependency on @capacitor/core. */
  readonly isNative = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

  readonly baseUrl = signal<string>(this.isNative ? localStorage.getItem(KEY) ?? '' : '');

  /** Native needs a paired server before anything can load; the web never does. */
  readonly configured = computed(() => !this.isNative || !!this.baseUrl());

  /** Whether the "Connect to a server" screen is open. No longer a hard startup
   *  gate — the app opens straight to the (empty) library and this is raised
   *  on demand from the empty-state CTA or the top-right account menu. */
  readonly promptOpen = signal(false);

  openPrompt(): void { this.promptOpen.set(true); }
  closePrompt(): void { this.promptOpen.set(false); }

  /** Absolute (native) or same-origin relative (web) URL for an API path. */
  url(path: string): string {
    return `${this.baseUrl()}${path}`;
  }

  /** ws(s):// form of url(), for the reader-stream WebSocket. */
  wsUrl(path: string): string {
    const base = this.baseUrl();
    if (!base) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}${path}`;
    }
    return base.replace(/^http/, 'ws') + path;
  }

  /** Pair with a server. Accepts "host:port" shorthand (assumes http://). */
  setBaseUrl(raw: string): void {
    let v = raw.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`;
    this.baseUrl.set(v);
    localStorage.setItem(KEY, v);
    this.promptOpen.set(false); // paired — dismiss the connect screen
  }

  /** Forget the paired server (native settings: "switch server"). */
  clear(): void {
    this.baseUrl.set('');
    localStorage.removeItem(KEY);
  }
}
