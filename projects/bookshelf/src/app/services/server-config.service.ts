import { computed, Injectable, signal } from '@angular/core';

const KEY_SERVERS = 'bookshelf-servers';
const KEY_ACTIVE = 'bookshelf-active-server';
const KEY_LEGACY_URL = 'bookshelf-server-url'; // pre-multi-server single URL

/** A BookForge library server the app knows about. The app stays "connected" to
 *  every entry at once; `enabled` only shows/hides its books. Removal is via the
 *  X in the server menu, never by unchecking. A `local` entry is the phone's own
 *  on-device library (no url, no analytics). */
export interface ServerEntry {
  id: string;
  label: string;
  /** Base origin, e.g. http://host:8765. '' = same-origin (web build). */
  url: string;
  enabled: boolean;
  local?: boolean;
  /** True while the label is auto-derived (host/served-name) — cleared once the
   *  user renames it, so a fetched server name never overrides a manual name. */
  autoLabel?: boolean;
  /** Optional shared access key ("password to connect"). When the server has one
   *  configured, it must ride on every request; sent as an `accessKey` query param
   *  so raw <img>/<audio> src work too. See MULTI_SERVER.md → Identity & analytics. */
  accessKey?: string;
  /** What this server said it can do, from its /api/health `capabilities`. A
   *  NAS-hosted mirror reports a reduced set (no `render` — it has no TTS
   *  engine), and the UI disables those controls rather than hiding them.
   *  `undefined` means we have not asked yet, or the server predates the field —
   *  which is NOT the same as "cannot"; see supports(). */
  capabilities?: string[];
}

/** A capability a server may or may not serve; mirrors BOOKSHELF_CAPABILITIES
 *  in electron/bookshelf-server.ts. Only the ones the client reasons about. */
export type ServerCapability = 'library' | 'reader' | 'pdf' | 'render' | 'ingest' | 'edit' | 'queue' | 'mutate';

/**
 * Where the Bookshelf API lives. Historically a single paired server; now a
 * LIST of servers whose libraries are merged into one shelf (see
 * projects/bookshelf/MULTI_SERVER.md).
 *
 * The single-server accessors — baseUrl()/url()/wsUrl()/setBaseUrl()/clear()/
 * configured()/promptOpen — are preserved and back onto the *active* server, so
 * every existing caller behaves identically when there's one server. Per-server
 * routing is done by passing a serverId to url()/wsUrl().
 *
 * In a browser the app is SERVED by its server, so that entry's base is '' and
 * requests stay relative. In the native app (Capacitor) the bundle loads from
 * capacitor://localhost, so each server carries its absolute http(s) origin.
 */
@Injectable({ providedIn: 'root' })
export class ServerConfigService {
  /** True inside the Capacitor shell. Detected via the window global the native
   *  runtime injects, so web builds take no dependency on @capacitor/core. */
  readonly isNative = !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

  readonly servers = signal<ServerEntry[]>(this.load());
  readonly activeId = signal<string>(localStorage.getItem(KEY_ACTIVE) ?? this.servers()[0]?.id ?? '');

  /** Servers whose books should currently show on the shelf. */
  readonly enabledServers = computed(() => this.servers().filter(s => s.enabled));

  /** The server backing the single-server accessors (import default, reader
   *  token, the legacy baseUrl effect). First choice is the explicit active
   *  entry, else the first enabled, else the first known. */
  readonly activeServer = computed<ServerEntry | null>(() => {
    const list = this.servers();
    return list.find(s => s.id === this.activeId())
      ?? list.find(s => s.enabled)
      ?? list[0]
      ?? null;
  });

  /** Active server's base — '' for same-origin web or when nothing is paired. */
  readonly baseUrl = computed(() => this.activeServer()?.url ?? '');

  /** Native needs a paired (non-local) server before remote books can load; the
   *  web is always served by one. Deliberately independent of which entry is
   *  ACTIVE: opening an on-device book makes `local` (url '') the active server,
   *  which must not "un-configure" the app and blank the shelf. */
  readonly configured = computed(() => !this.isNative || this.servers().some(s => !!s.url));

  /** Whether the "Connect to a server" screen is open. Raised on demand from the
   *  empty-state CTA, the server menu, or the account menu — not a startup gate. */
  readonly promptOpen = signal(false);

  constructor() {
    // Web build: the app is always served by a server (the origin) — name that
    // library by the server's own name once, on startup.
    if (!this.isNative) void this.refreshOriginName();
  }

  openPrompt(): void { this.promptOpen.set(true); }
  closePrompt(): void { this.promptOpen.set(false); }

  /** Absolute (native) or same-origin relative (web) URL for an API path.
   *  Pass a serverId to route to a specific server; defaults to the active one.
   *  A configured access key is appended so every request (fetch AND raw src) is
   *  authorized through this one chokepoint. */
  url(path: string, serverId?: string): string {
    return this.withKey(`${this.baseFor(serverId)}${path}`, serverId);
  }

  /** ws(s):// form of url(), for the reader-stream WebSocket. */
  wsUrl(path: string, serverId?: string): string {
    const base = this.baseFor(serverId);
    let full: string;
    if (!base) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      full = `${proto}//${location.host}${path}`;
    } else {
      full = base.replace(/^http/, 'ws') + path;
    }
    return this.withKey(full, serverId);
  }

  /** Append the target server's access key as a query param, if it has one. */
  private withKey(full: string, serverId?: string): string {
    const key = this.keyFor(serverId);
    if (!key) return full;
    const sep = full.includes('?') ? '&' : '?';
    return `${full}${sep}accessKey=${encodeURIComponent(key)}`;
  }

  private keyFor(serverId?: string): string {
    if (!serverId) return this.activeServer()?.accessKey ?? '';
    return this.servers().find(s => s.id === serverId)?.accessKey ?? '';
  }

  /** Store/replace a server's access key (from the connect gate or a key prompt). */
  setAccessKey(id: string, key: string): void {
    this.patch(id, { accessKey: key.trim() || undefined });
  }

  // ---- capabilities ------------------------------------------------------

  /** Record what a server reported it can do (its /api/health `capabilities`). */
  setCapabilities(id: string, capabilities: string[] | undefined): void {
    this.patch(id, { capabilities });
  }

  /**
   * Whether a server serves `cap`.
   *
   * A server that has NOT been asked, or that predates the capabilities field,
   * reports `undefined` — and that is not a "no". Every server before this
   * existed could do everything, so the honest reading of silence is "full", and
   * the request itself remains the authority (it answers 501 if not). Only an
   * explicit list that omits the capability disables a control.
   */
  supports(cap: ServerCapability, serverId?: string): boolean {
    const s = serverId ? this.servers().find(x => x.id === serverId) : this.activeServer();
    if (!s) return false;
    if (s.local) return cap === 'library'; // the on-device library is files, not a server
    if (!s.capabilities) return true;
    return s.capabilities.includes(cap);
  }

  /** Why a control is disabled, for a tooltip/label. Empty when it isn't. */
  unsupportedReason(cap: ServerCapability, serverId?: string): string {
    if (this.supports(cap, serverId)) return '';
    const s = serverId ? this.servers().find(x => x.id === serverId) : this.activeServer();
    if (s?.local) return 'On-device books are files on this device — there is no server to do that.';
    return `${s?.label || 'This server'} is a library-only mirror: it serves the library but cannot ${
      cap === 'render' ? 'read books aloud' : `do that (${cap})`}.`;
  }

  /**
   * Ask a server what it is: its name and its capabilities, in one /api/health.
   * Called after a server answers a shelf load, so a mirror's controls are
   * disabled by the time its books are on screen. Failure is left alone — an
   * unreachable server is already handled as offline by the caller, and
   * overwriting known capabilities with nothing would re-enable dead controls.
   */
  async refreshHealth(serverId?: string): Promise<void> {
    const s = serverId ? this.servers().find(x => x.id === serverId) : this.activeServer();
    if (!s || s.local) return;
    try {
      const res = await fetch(this.url('/api/health', s.id));
      if (!res.ok) return;
      const body = await res.json() as { name?: unknown; capabilities?: unknown };
      const delta: Partial<ServerEntry> = {};
      if (Array.isArray(body.capabilities)) delta.capabilities = body.capabilities.map(String);
      // The name only wins while the label is still auto-derived, so a manual
      // rename is never clobbered (same rule refreshOriginName has always had).
      if (s.autoLabel !== false && typeof body.name === 'string' && body.name.trim()) {
        delta.label = body.name.trim();
        delta.autoLabel = true;
      }
      if (Object.keys(delta).length) this.patch(s.id, delta);
    } catch { /* offline — the caller already shows that */ }
  }

  // ---- server list management -------------------------------------------

  /** Add a server (or re-enable/activate an existing one with the same URL) and
   *  make it active. Accepts "host:port" shorthand. Returns its id. */
  addServer(rawUrl: string, label?: string, accessKey?: string): string {
    const url = this.normalize(rawUrl);
    const key = accessKey?.trim() || undefined;
    // On the web the app is already served by its own library (the synthetic
    // `origin` entry, url ''). Adding that SAME host by its explicit URL would make
    // a second entry for one backend — the classic "every book twice" cause, which
    // the url-string match below can't catch ('' ≠ 'http://thishost'). Fold it into
    // origin instead of minting a twin.
    if (!this.isNative && url) {
      let sameHost = false;
      try { sameHost = new URL(url).host === location.host; } catch { /* unparseable → normal add */ }
      const origin = sameHost ? this.servers().find(s => s.url === '') : undefined;
      if (origin) {
        this.patch(origin.id, { enabled: true, ...(key !== undefined ? { accessKey: key } : {}) });
        this.activeId.set(origin.id);
        this.persistActive();
        return origin.id;
      }
    }
    const existing = this.servers().find(s => s.url === url);
    if (existing) {
      // Re-pairing an existing entry refreshes its key if a new one was supplied.
      this.patch(existing.id, { enabled: true, ...(key !== undefined ? { accessKey: key } : {}) });
      this.activeId.set(existing.id);
      this.persistActive();
      return existing.id;
    }
    const entry: ServerEntry = {
      id: crypto.randomUUID(),
      label: label?.trim() || this.hostLabel(url),
      url,
      enabled: true,
      accessKey: key,
    };
    this.servers.update(list => [...list, entry]);
    this.persist();
    this.activeId.set(entry.id);
    this.persistActive();
    return entry.id;
  }

  /** Remove a server entirely (the X in the menu). Re-points the active server.
   *  The on-device "This device" library is intrinsic — it can be hidden
   *  (unchecked) but not removed. */
  removeServer(id: string): void {
    if (this.servers().find(s => s.id === id)?.local) return;
    this.servers.update(list => list.filter(s => s.id !== id));
    this.persist();
    if (this.activeId() === id) {
      this.activeId.set(this.activeServer()?.id ?? '');
      this.persistActive();
    }
  }

  /** Show/hide a server's books. Toggles if `enabled` is omitted. */
  toggleServer(id: string, enabled?: boolean): void {
    const cur = this.servers().find(s => s.id === id);
    if (!cur) return;
    this.patch(id, { enabled: enabled ?? !cur.enabled });
  }

  setActive(id: string): void {
    if (!this.servers().some(s => s.id === id)) return;
    this.activeId.set(id);
    this.persistActive();
  }

  // ---- single-server compatibility --------------------------------------

  /** Pair with a server and make it active (used by the connect gate). Accepts
   *  "host:port" shorthand. Preserved from the single-server API. */
  setBaseUrl(raw: string, accessKey?: string, label?: string): void {
    this.addServer(raw, label, accessKey);
    this.promptOpen.set(false); // paired — dismiss the connect screen
  }

  /** Rename a server (any entry, including the same-origin served library). Empty
   *  falls back to the host-derived default so a label is never blank. */
  setServerLabel(id: string, label: string): void {
    const s = this.servers().find(x => x.id === id);
    if (!s) return;
    // autoLabel:false so a later server-name fetch won't clobber the manual name.
    this.patch(id, { label: label.trim() || this.hostLabel(s.url), autoLabel: false });
  }

  /** Name the same-origin served library by the server that serves it (its
   *  /api/health `name`), unless the user has renamed it — and learn what that
   *  server can do while we are asking. Web build only. */
  async refreshOriginName(): Promise<void> {
    const origin = this.servers().find(s => s.url === '' && !s.local);
    if (!origin) return;
    await this.refreshHealth(origin.id);
  }

  /** Forget the active server (native settings: "switch server"). Preserved from
   *  the single-server API; now removes just the active entry. */
  clear(): void {
    const id = this.activeServer()?.id;
    if (id) this.removeServer(id);
  }

  // ---- internals --------------------------------------------------------

  private baseFor(serverId?: string): string {
    if (!serverId) return this.baseUrl();
    return this.servers().find(s => s.id === serverId)?.url ?? this.baseUrl();
  }

  private patch(id: string, delta: Partial<ServerEntry>): void {
    this.servers.update(list => list.map(s => s.id === id ? { ...s, ...delta } : s));
    this.persist();
  }

  private persist(): void {
    localStorage.setItem(KEY_SERVERS, JSON.stringify(this.servers()));
  }

  private persistActive(): void {
    localStorage.setItem(KEY_ACTIVE, this.activeId());
  }

  /** Load the server list, migrating the pre-multi-server single URL if present.
   *  On web (served by its own server) a same-origin entry is always present. */
  private load(): ServerEntry[] {
    const raw = localStorage.getItem(KEY_SERVERS);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ServerEntry[];
        if (Array.isArray(parsed)) return this.withOrigin(parsed);
      } catch { /* fall through to migration */ }
    }

    const list: ServerEntry[] = [];
    const legacy = this.isNative ? localStorage.getItem(KEY_LEGACY_URL) : null;
    if (legacy) {
      const url = this.normalize(legacy);
      list.push({ id: crypto.randomUUID(), label: this.hostLabel(url), url, enabled: true });
      localStorage.removeItem(KEY_LEGACY_URL);
    }
    const seeded = this.withOrigin(list);
    if (seeded.length) localStorage.setItem(KEY_SERVERS, JSON.stringify(seeded));
    return seeded;
  }

  /** The web build is served by one server (base ''); guarantee an entry for it
   *  so the shelf/menu have something to show. Native has no implicit server.
   *  Both platforms always get the synthetic on-device "This device" library. */
  private withOrigin(list: ServerEntry[]): ServerEntry[] {
    let out = list;
    // Same-origin server entry (web only; it IS the served library).
    if (!this.isNative && !out.some(s => s.url === '')) {
      out = [{ id: 'origin', label: this.originDefaultLabel(), url: '', enabled: true, autoLabel: true }, ...out];
    }
    // On-device library — not a real server, just a pointer to imported files
    // played locally (see LocalLibraryService). Appended last so a real server
    // stays the default active entry.
    if (!out.some(s => s.local)) {
      out = [...out, { id: 'local', label: this.isNative ? 'This iPhone' : 'This device', url: '', enabled: true, local: true }];
    }
    return out;
  }

  private normalize(raw: string): string {
    let v = raw.trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\//i.test(v)) v = `http://${v}`;
    return v;
  }

  private hostLabel(url: string): string {
    if (!url) return this.originDefaultLabel();
    try { return new URL(url).hostname.split('.')[0] || url; }
    catch { return url; }
  }

  /** Default name for the same-origin served library: the serving host's short
   *  name when it's meaningful (e.g. "owens-mac-studio"), else a neutral
   *  placeholder the user renames to "Owen's Mac" etc. */
  private originDefaultLabel(): string {
    try {
      const h = new URL(location.href).hostname.split('.')[0];
      if (h && h !== 'localhost' && !/^\d+$/.test(h)) return h;
    } catch { /* no location (SSR/tests) */ }
    return 'This library';
  }
}
