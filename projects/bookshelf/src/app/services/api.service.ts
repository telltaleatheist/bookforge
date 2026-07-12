import { inject, Injectable } from '@angular/core';
import { AnalyticsData, Audiobook, Chapter, Ebook, QueueData, ReadInfo, ReaderSummary } from '../models/types';
import { ServerConfigService } from './server-config.service';
import { LocalLibraryService, LOCAL_SERVER_ID, isLocalPath, localIdOf } from './local-library.service';
import { OfflineStoreService } from './offline-store.service';

/**
 * Thin typed wrapper over the Bookshelf HTTP API. The web app runs in a phone
 * browser, so everything goes over fetch — there is no Electron IPC here.
 * Every URL is built through ServerConfigService so the native (Capacitor)
 * app can point the same code at a remote server.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly cfg = inject(ServerConfigService);
  // The on-device "This device" library isn't a real server — read paths for the
  // synthetic `local` serverId are served from here instead of HTTP.
  private readonly local = inject(LocalLibraryService);
  // Offline copies of remote books — playback/cover prefer the cached bytes.
  private readonly offline = inject(OfflineStoreService);

  /** API path → absolute (native) or same-origin relative (web) URL. Pass a
   *  serverId to route to a specific server (multi-server shelf); defaults to the
   *  active one. */
  private u(path: string, serverId?: string): string {
    return this.cfg.url(path, serverId);
  }

  /** Reachability probe for a server (used before enabling one in the menu). */
  async ping(serverId?: string): Promise<boolean> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(this.u('/api/health', serverId), { signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok;
    } catch {
      return false;
    }
  }

  async getBooks(forceRefresh = false, serverId?: string): Promise<Audiobook[]> {
    if (serverId === LOCAL_SERVER_ID) return this.local.audiobooks();
    const res = await fetch(this.u(forceRefresh ? '/api/books?refresh=true' : '/api/books', serverId));
    // An HTTP error or a malformed body must THROW, never read as "this server
    // has zero books": the shelf treats a returned [] as a healthy empty catalog
    // and persists it over the offline localStorage cache. Throwing routes into
    // the per-server catch in shelf.loadAudiobooks, which marks the server
    // offline and keeps the cache intact.
    if (!res.ok) throw new Error(`/api/books failed (HTTP ${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data.books)) throw new Error('/api/books returned a malformed body (no books array)');
    return data.books;
  }

  async getEbooks(forceRefresh = false, serverId?: string): Promise<Ebook[]> {
    if (serverId === LOCAL_SERVER_ID) return this.local.ebooks();
    const res = await fetch(this.u(forceRefresh ? '/api/ebooks?refresh=true' : '/api/ebooks', serverId));
    // Same contract as getBooks: an error response is NOT an empty library.
    if (!res.ok) throw new Error(`/api/ebooks failed (HTTP ${res.status})`);
    const data = await res.json();
    if (!Array.isArray(data.ebooks)) throw new Error('/api/ebooks returned a malformed body (no ebooks array)');
    return data.ebooks;
  }

  async getQueue(): Promise<QueueData> {
    const res = await fetch(this.u('/api/queue'));
    return res.json();
  }

  async sendQueueControl(action: 'start' | 'pause'): Promise<void> {
    await fetch(this.u(`/api/queue/${action}`), { method: 'POST' });
  }

  async getCover(book: Pick<Audiobook, 'projectId' | 'downloadPath' | 'originServerId'>): Promise<string | null> {
    if (book.originServerId === LOCAL_SERVER_ID || isLocalPath(book.downloadPath)) {
      return this.local.assetUrl(localIdOf(book.downloadPath), 'cover');
    }
    // Prefer an offline-cached cover so a downloaded book renders with no network.
    const offCover = await this.offline.coverUrl(book.originServerId, book.downloadPath);
    if (offCover) return offCover;
    // A DOWNLOADED book is self-contained and never consults the server: if the
    // cover wasn't cached at download time, it simply shows none. We don't paper
    // over an incomplete download with a live fetch — no fallbacks (that would
    // hide the download bug and re-introduce a server dependency after download).
    if (this.offline.isDownloaded(book.originServerId, book.downloadPath)) return null;
    const params = new URLSearchParams();
    if (book.projectId) params.set('projectId', book.projectId);
    if (book.downloadPath) params.set('downloadPath', book.downloadPath);
    // Remote (not downloaded) book: fetch from its origin server. Still swallow a
    // network throw so a flaky server renders no art instead of sinking the load.
    try {
      const res = await fetch(this.u(`/api/cover?${params.toString()}`, book.originServerId));
      const data = await res.json();
      return data.cover ?? null;
    } catch {
      return null;
    }
  }

  async getEbookCover(relativePath: string, serverId?: string): Promise<string | null> {
    if (serverId === LOCAL_SERVER_ID || isLocalPath(relativePath)) {
      return this.local.assetUrl(localIdOf(relativePath), 'cover');
    }
    const res = await fetch(this.u(`/api/ebook-cover?path=${encodeURIComponent(relativePath)}`, serverId));
    const data = await res.json();
    return data.cover ?? null;
  }

  /** Resolve the audio source for playback. Local books materialize a blob URL
   *  from on-device storage; remote books use the HTTP audio endpoint. Pass
   *  `{ stream: true }` to FORCE the server stream even when a downloaded copy
   *  exists — the shelf's "All audiobooks" mirror of a downloaded book (see the
   *  `stream` flag on Audiobook). A truly local (imported) book has no server
   *  copy, so `stream` is ignored there. */
  async resolveAudioSrc(downloadPath: string, serverId?: string, opts?: { stream?: boolean }): Promise<string> {
    if (isLocalPath(downloadPath)) return (await this.local.assetUrl(localIdOf(downloadPath), 'main')) || '';
    // A downloaded copy plays offline and skips the network entirely — unless the
    // caller explicitly wants the server stream (the shelf's stream mirror card).
    if (!opts?.stream) {
      const offline = await this.offline.audioUrl(serverId, downloadPath);
      if (offline) return offline;
    }
    return this.audioUrl(downloadPath, serverId);
  }

  async getChapters(downloadPath: string, serverId?: string): Promise<Chapter[]> {
    // A downloaded book's cached chapters work with no network.
    const offline = await this.offline.chapters(serverId, downloadPath);
    if (offline) return offline as Chapter[];
    // A DOWNLOADED book never consults the server (see getCover): uncached → none.
    if (this.offline.isDownloaded(serverId, downloadPath)) return [];
    // Remote book. Chapters are OPTIONAL metadata; any failure degrades to "no
    // chapters", never sinks the player's Promise.all as "Failed to load
    // audiobook":
    //   - a flaky origin server makes fetch() THROW (not !res.ok);
    //   - an older/mismatched server without this route serves the SPA index.html
    //     (200, text/html) instead of JSON, so guard on content-type;
    //   - a bad body makes res.json() throw, so swallow parse errors too.
    try {
      const res = await fetch(this.u(`/api/chapters?path=${encodeURIComponent(downloadPath)}`, serverId));
      if (!res.ok) return [];
      if (!(res.headers.get('content-type') || '').includes('application/json')) return [];
      const data = await res.json();
      return data.chapters ?? [];
    } catch {
      return [];
    }
  }

  /** Fetch the synced transcript. Returns null when no VTT exists (imported m4b).
   *  `downloadPath` resolves the transcript of the SPECIFIC opened variant when a
   *  project has several audiobook versions. */
  async getVttText(projectId: string, langPair?: string, downloadPath?: string, serverId?: string): Promise<string | null> {
    // A downloaded book's cached transcript works with no network.
    if (downloadPath) {
      const offline = await this.offline.vttText(serverId, downloadPath);
      if (offline) return offline;
      // A DOWNLOADED book never consults the server (see getCover): uncached (or an
      // imported m4b that has no transcript at all) → none, no live fetch.
      if (this.offline.isDownloaded(serverId, downloadPath)) return null;
    }
    if (!projectId) return null;
    const params = new URLSearchParams({ projectId });
    if (langPair) params.set('langPair', langPair);
    if (downloadPath) params.set('path', downloadPath);
    // The transcript is optional (imported m4bs have none) and, like chapters and
    // cover, must never block playback: a downloaded book whose VTT wasn't cached
    // makes this fetch() THROW against an offline origin server. Swallow it and
    // fall back to "no transcript" rather than sinking the player's Promise.all.
    try {
      const res = await fetch(this.u(`/api/vtt?${params.toString()}`, serverId));
      if (res.status === 204 || !res.ok) return null;
      return res.text();
    } catch {
      return null;
    }
  }

  audioUrl(downloadPath: string, serverId?: string): string {
    return this.u(`/api/audio?path=${encodeURIComponent(downloadPath)}`, serverId);
  }

  downloadUrl(downloadPath: string, displayName?: string, serverId?: string): string {
    const name = displayName || downloadPath.split(/[/\\]/).pop() || 'audiobook.m4b';
    return this.u(`/api/download?path=${encodeURIComponent(downloadPath)}&filename=${encodeURIComponent(name)}`, serverId);
  }

  ebookDownloadUrl(relativePath: string, serverId?: string): string {
    return this.u(`/api/ebook-download?path=${encodeURIComponent(relativePath)}`, serverId);
  }

  /** Tag a project as an ebook or an article (the shelf lists by this tag). */
  async reclassifyEbook(token: string, projectId: string, type: 'book' | 'article', serverId?: string): Promise<void> {
    const res = await fetch(this.u('/api/ebooks/reclassify', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify({ projectId, type }),
    });
    if (!res.ok) {
      const detail = res.status === 404 ? 'this endpoint is missing — update the app' : `server error ${res.status}`;
      throw new Error(`Move failed (${detail})`);
    }
  }

  /** Delete a project outright (removes its whole folder server-side). Used by the
   *  shelf's article delete affordance. */
  async deleteProject(token: string, projectId: string, serverId?: string): Promise<void> {
    const res = await fetch(this.u(`/api/project?projectId=${encodeURIComponent(projectId)}`, serverId), {
      method: 'DELETE',
      headers: { 'X-Reader-Token': token },
    });
    if (!res.ok) {
      const detail = res.status === 404 ? 'this endpoint is missing — update the app' : `server error ${res.status}`;
      throw new Error(`Delete failed (${detail})`);
    }
  }

  // ── TTS engine (voices + warmup) ──────────────────────────────────────────────
  /** Voices the active streaming engine can use, plus the default/current one. */
  async getTtsVoices(token: string): Promise<{
    voices: string[]; current: string | null; defaultVoice: string; engine: string; state: string;
  }> {
    const res = await fetch(this.u('/api/tts/voices'), { headers: { 'X-Reader-Token': token } });
    if (!res.ok) throw new Error('voices unavailable');
    return res.json();
  }

  /** Fire-and-forget engine warmup — called when a listen surface opens so the
   *  cold start is paid before the user taps play. Errors are ignored (the real
   *  failure path surfaces on the actual play). */
  warmTts(token: string, voice?: string): void {
    fetch(this.u('/api/tts/warm'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(voice ? { voice } : {}),
    }).catch(() => { /* best effort */ });
  }

  /** Ingest a PDF for the page-crop editor: caches the file server-side and returns
   *  its pages with per-block boxes. */
  async ingestPdfForEdit(
    token: string,
    file: File,
  ): Promise<{
    docId: string; title: string; pageCount: number;
    pages: Array<{ index: number; width: number; height: number; blocks: Array<{ id: string; page: number; x: number; y: number; w: number; h: number; text: string; region: string; isImage: boolean }> }>;
  }> {
    const res = await fetch(this.u('/api/edit/ingest-pdf'), {
      method: 'POST',
      headers: { 'X-Reader-Token': token, 'X-File-Name': file.name, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      const detail = res.status === 404 ? 'this endpoint is missing — update the app' : (await res.json().catch(() => ({}))).error || `server error ${res.status}`;
      throw new Error(`Couldn't read that PDF (${detail})`);
    }
    return res.json();
  }

  /** URL of a rasterized page of a cached edit-PDF (token in the query for <img>). */
  editPageUrl(token: string, docId: string, page: number, scale = 1.5): string {
    return this.u(`/api/edit/page?docId=${encodeURIComponent(docId)}&page=${page}&scale=${scale}&token=${encodeURIComponent(token)}`);
  }

  // ── In-app reader ─────────────────────────────────────────────────────────────
  // `ref` names the book: `p:<projectId>` (archived source) or `e:<relativePath>`
  // (a standalone Ebooks-tab file).
  /** Returns the book's format/metadata, or null if there's nothing readable. */
  async getReadInfo(ref: string): Promise<ReadInfo | null> {
    if (isLocalPath(ref)) {
      const b = this.local.book(localIdOf(ref));
      return b ? { format: 'epub', filename: `${b.title}.${b.format}` } : null;
    }
    const res = await fetch(this.u(`/api/read-info?ref=${encodeURIComponent(ref)}`));
    if (!res.ok) return null;
    return res.json();
  }

  /** URL of the book's raw bytes (epub.js fetches this as an ArrayBuffer). */
  readFileUrl(ref: string): string {
    return this.u(`/api/read-file?ref=${encodeURIComponent(ref)}`);
  }

  /** URL of a rasterized PDF page (0-indexed). */
  readPageUrl(ref: string, page: number, scale: number): string {
    return this.u(`/api/read-page?ref=${encodeURIComponent(ref)}&page=${page}&scale=${scale}`);
  }

  // ── Reader ("Listen to anything") ingestion ───────────────────────────────────
  /** Turn a URL or an uploaded file into readable blocks for the Listen surface.
   *  URL goes as JSON; a file goes as multipart. Returns paragraph-ish blocks. */
  async ingestReader(
    token: string,
    src: { url?: string; file?: File },
  ): Promise<{ docId?: string; title?: string; blocks: string[] }> {
    let res: Response;
    if (src.file) {
      // Send raw bytes (not multipart) so the server needs no upload library; the
      // filename rides in a header and express.raw() hands the server a Buffer.
      res = await fetch(this.u('/api/reader/ingest'), {
        method: 'POST',
        headers: {
          'X-Reader-Token': token,
          'X-File-Name': src.file.name,
          'Content-Type': 'application/octet-stream',
        },
        body: src.file,
      });
    } else {
      res = await fetch(this.u('/api/reader/ingest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
        body: JSON.stringify({ url: src.url }),
      });
    }
    if (!res.ok) {
      const detail = res.status === 404
        ? 'this endpoint is missing — update the app'
        : (await res.json().catch(() => ({}))).error || `server error ${res.status}`;
      throw new Error(`Couldn't read that source (${detail})`);
    }
    return res.json();
  }

  // ── Import → edit → finalize ──────────────────────────────────────────────────
  /** Turn edited blocks (+ chapter markers) into a persisted project. Returns the
   *  new projectId and a reader ref (`p:<projectId>`). */
  async finalizeImport(
    token: string,
    payload: {
      title: string;
      author?: string;
      language?: string;
      projectType: 'book' | 'article';
      url?: string;
      blocks: Array<{ text: string; chapterStart?: boolean }>;
    },
  ): Promise<{ projectId: string; ref: string }> {
    const res = await fetch(this.u('/api/edit/finalize'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = res.status === 404
        ? 'this endpoint is missing — update the app'
        : (await res.json().catch(() => ({}))).error || `server error ${res.status}`;
      throw new Error(`Couldn't save that (${detail})`);
    }
    return res.json();
  }

  /** Project reader payload for the Read&Listen view (display blocks + chapter map). */
  async getProjectReader(
    token: string,
    projectId: string,
  ): Promise<{
    title: string; author?: string;
    blocks: Array<{ id: string; text: string; chapterStart: boolean }>;
    chapterTitles: string[]; sentenceBlock: number[]; totalSentences: number;
  }> {
    const res = await fetch(this.u(`/api/project/reader?projectId=${encodeURIComponent(projectId)}`), {
      headers: { 'X-Reader-Token': token },
    });
    if (!res.ok) {
      const detail = res.status === 404 ? 'no readable text for this book' : `server error ${res.status}`;
      throw new Error(`Couldn't open that book (${detail})`);
    }
    return res.json();
  }

  // ── Readers + analytics ───────────────────────────────────────────────────────
  // Reader identity is PER SERVER — each of these takes an optional serverId so
  // the app can hold a distinct login on every connected server at once.
  async listReaders(serverId?: string): Promise<ReaderSummary[]> {
    const res = await fetch(this.u('/api/readers', serverId));
    const data = await res.json();
    return data.readers ?? [];
  }

  async createReader(name: string, pin?: string, serverId?: string): Promise<{ token: string; reader: ReaderSummary }> {
    const res = await fetch(this.u('/api/readers', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin: pin || undefined }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create reader');
    return res.json();
  }

  async loginReader(id: string, pin?: string, serverId?: string): Promise<{ token: string; reader: ReaderSummary }> {
    const res = await fetch(this.u('/api/readers/login', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, pin: pin || undefined }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to sign in');
    return res.json();
  }

  async getMe(token: string, serverId?: string): Promise<ReaderSummary | null> {
    const res = await fetch(this.u('/api/readers/me', serverId), { headers: { 'X-Reader-Token': token } });
    if (!res.ok) return null;
    return (await res.json()).reader ?? null;
  }

  /** Record listening time. `id` (a stable per-event uuid) makes the write
   *  idempotent server-side, so the offline queue can replay it without
   *  double-counting. `serverId` routes to the book's origin server.
   *
   *  Returns TRUE when the event should be DROPPED from the durable queue —
   *  delivered (2xx) or genuinely unprocessable (400/404/422 poison that can
   *  never succeed) — and FALSE when it's worth a RETRY: auth/transient rejects
   *  (401/403 — incl. the server's `!storeReady` startup window and stale
   *  tokens), other 4xx, 5xx, or an offline/network error. The analytics queue
   *  uses this to decide whether to drop or re-send. */
  async postHeartbeat(
    token: string,
    payload: { bookPath: string; title: string; author: string; seconds: number; id?: string },
    serverId?: string,
  ): Promise<boolean> {
    try {
      const res = await fetch(this.u('/api/analytics/heartbeat', serverId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
        body: JSON.stringify(payload),
        keepalive: true, // let it complete if the page is unloading
      });
      if (res.ok) return true; // 2xx — delivered (or idempotent duplicate) → drop.
      // A 4xx splits two ways and the distinction matters for the durable queue:
      //  - Genuinely UNPROCESSABLE (400 Bad Request, 404 Not Found, 422) — a
      //    malformed/poison payload, or a route that doesn't exist on this server.
      //    Retrying will NEVER succeed, so drop it rather than wedge the queue.
      if (res.status === 400 || res.status === 404 || res.status === 422) return true;
      //  - AUTH / TRANSIENT (401, 403, plus any other 4xx like 408/429) — the
      //    server refuses us RIGHT NOW but the event is perfectly valid. In
      //    particular the server answers 401 during its `!storeReady` startup
      //    window and for a momentarily-stale token; dropping here would silently
      //    lose valid listening time forever. Keep it queued to retry later.
      //  5xx (server error) is likewise transient. → retry (keep).
      return false;
    } catch {
      return false; // offline / network error → retry (keep).
    }
  }

  async getAnalytics(token: string, serverId?: string): Promise<AnalyticsData> {
    const res = await fetch(this.u('/api/analytics', serverId), { headers: { 'X-Reader-Token': token } });
    if (!res.ok) throw new Error('Failed to load analytics');
    return res.json();
  }

  /** Erase a book's listening history from analytics (the per-book ✕). `bookKey`
   *  is the `bookPath` returned by getAnalytics. */
  async removeAnalyticsBook(token: string, bookKey: string, serverId?: string): Promise<void> {
    const res = await fetch(this.u('/api/analytics/remove', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify({ bookKey }),
    });
    if (!res.ok) {
      // 404 = the running app predates this endpoint (rebuild + restart needed);
      // anything else is a real server-side failure worth surfacing.
      const detail = res.status === 404 ? 'this endpoint is missing — update the app' : `server error ${res.status}`;
      throw new Error(`Remove failed (${detail})`);
    }
  }

  // ── Durable position (server-side, merged across devices) ─────────────────────
  /** Latest saved position for a book. `ref` for the reader, `bookPath` for audio. */
  async getPosition(token: string, params: { ref?: string; bookPath?: string }, serverId?: string): Promise<{ kind?: string; value?: unknown; at?: string }> {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.bookPath) q.set('bookPath', params.bookPath);
    const res = await fetch(this.u(`/api/position?${q.toString()}`, serverId), { headers: { 'X-Reader-Token': token } });
    if (!res.ok) return {};
    return res.json();
  }

  postPosition(token: string, body: { ref?: string; bookPath?: string; kind: string; value: unknown }, serverId?: string): void {
    fetch(this.u('/api/position', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(body),
      keepalive: true, // survive page unload
    }).catch(() => { /* offline; localStorage still holds it */ });
  }

  // ── Durable bookmarks (server-side, merged across devices) ────────────────────
  async getBookmarks<T = unknown>(token: string, params: { ref?: string; bookPath?: string }, serverId?: string): Promise<T[]> {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.bookPath) q.set('bookPath', params.bookPath);
    const res = await fetch(this.u(`/api/bookmarks?${q.toString()}`, serverId), { headers: { 'X-Reader-Token': token } });
    // Throw (rather than return []) on an unreachable/old server so callers keep
    // their local list instead of wiping it.
    if (!res.ok) throw new Error('bookmarks unavailable');
    return (await res.json()).bookmarks ?? [];
  }

  postBookmark(token: string, body: { ref?: string; bookPath?: string; op: 'add' | 'del'; bookmark: { id: string } & Record<string, unknown> }, serverId?: string): void {
    fetch(this.u('/api/bookmarks', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* offline; localStorage still holds it */ });
  }

  // ── Durable "listened" coverage (server-side, per reader) ─────────────────────
  // Returns the merged coverage AND the reset tombstone (`resetAt`, ISO or null):
  // the client discards a local cache older than resetAt so an offline device
  // rejoining after a reset can't resurrect the erased coverage.
  async getHeard(token: string, params: { ref?: string; bookPath?: string }, serverId?: string): Promise<{ intervals: Array<[number, number]>; resetAt: string | null }> {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.bookPath) q.set('bookPath', params.bookPath);
    const res = await fetch(this.u(`/api/heard?${q.toString()}`, serverId), { headers: { 'X-Reader-Token': token } });
    if (!res.ok) throw new Error('heard unavailable');
    const data = await res.json();
    return { intervals: data.intervals ?? [], resetAt: data.resetAt ?? null };
  }

  postHeard(token: string, body: { ref?: string; bookPath?: string; intervals: Array<[number, number]>; reset?: boolean }, serverId?: string): void {
    fetch(this.u('/api/heard', serverId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* offline; localStorage cache still holds it */ });
  }
}
