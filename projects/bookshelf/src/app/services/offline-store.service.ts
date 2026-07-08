import { computed, inject, Injectable, signal } from '@angular/core';
import { ServerConfigService } from './server-config.service';
import { NativeFileService } from './native-file.service';
import { Audiobook } from '../models/types';

/**
 * Offline copies of REMOTE books — the "Download for offline" half of the book
 * context menu. Distinct from LocalLibraryService (the "This device" library of
 * files you imported yourself): a downloaded book KEEPS its real identity
 * (`originServerId` + `downloadPath`), still belongs to its origin server, and
 * stays re-streamable; the offline copy is just a cache so it plays with no
 * network. "Remove download" drops the cache without touching the server.
 *
 * Bytes live the same way LocalLibraryService stores them — IndexedDB blobs on
 * the web, native filesystem on iOS (AVPlayer needs a `file://`, see
 * NativeFileService) — keyed by a per-download uuid. A small metadata index
 * (persisted to localStorage, exposed as a signal) lets the shelf ask
 * `isDownloaded()` synchronously while rendering.
 */

const INDEX_KEY = 'bookshelf-offline-index';
const DB_NAME = 'bookshelf-offline';
const DB_STORE = 'files';
const DB_VERSION = 1;

/** Metadata for one downloaded remote book (bytes stored separately by `id`). */
export interface OfflineItem {
  id: string;              // uuid → IndexedDB / native-file key
  serverId: string;        // origin server id (NOT 'local')
  downloadPath: string;    // the book's path on its origin server
  title: string;
  author: string;
  size: number;
  duration?: number;
  hasCover: boolean;
  dateAdded: number;
}

@Injectable({ providedIn: 'root' })
export class OfflineStoreService {
  private readonly cfg = inject(ServerConfigService);
  private readonly nativeFile = inject(NativeFileService);

  /** Reactive index of downloaded books (metadata only). */
  readonly items = signal<OfflineItem[]>(this.loadIndex());
  readonly count = computed(() => this.items().length);

  private db: Promise<IDBDatabase> | null = null;
  private readonly urls = new Map<string, string>(); // cached object URLs (web)

  // In-flight downloads: live byte progress keyed by the book's downloadPath, so
  // the shelf strip and the player button can show a bar and offer Cancel. A
  // signal so both surfaces react as bytes arrive.
  readonly downloading = signal<Map<string, { received: number; total: number }>>(new Map());
  private readonly controllers = new Map<string, AbortController>();

  /** Is this book currently downloading? */
  isDownloading(downloadPath: string): boolean { return this.downloading().has(downloadPath); }
  /** Bytes so far / expected for an in-flight download, or null if not running. */
  progressFor(downloadPath: string): { received: number; total: number } | null {
    return this.downloading().get(downloadPath) ?? null;
  }
  /** Abort an in-flight download (the Cancel affordance). */
  cancel(downloadPath: string): void { this.controllers.get(downloadPath)?.abort(); }

  private setProgress(downloadPath: string, received: number, total: number): void {
    const next = new Map(this.downloading());
    next.set(downloadPath, { received, total });
    this.downloading.set(next);
  }
  private clearProgress(downloadPath: string): void {
    const next = new Map(this.downloading());
    next.delete(downloadPath);
    this.downloading.set(next);
    this.controllers.delete(downloadPath);
  }

  // ── lookup ────────────────────────────────────────────────────────────────
  /** Cross-server identity of a download: the audio filename (basename), lowercased.
   *  Matches ShelfComponent.audioIdentity so offline resolution agrees with the
   *  shelf's "downloaded" badge even when a book's representative server/path
   *  differs from the one it was downloaded from. */
  private identity(downloadPath: string): string {
    return (downloadPath.split(/[/\\]/).pop() || downloadPath).toLowerCase();
  }

  private find(serverId: string | undefined, downloadPath: string): OfflineItem | undefined {
    const key = this.identity(downloadPath);
    const matches = this.items().filter(i => this.identity(i.downloadPath) === key);
    if (matches.length <= 1) return matches[0];
    // More than one download shares this basename: prefer an exact
    // (serverId, downloadPath) match, otherwise fall back to the first.
    return matches.find(i => i.serverId === (serverId ?? '') && i.downloadPath === downloadPath) ?? matches[0];
  }

  /** Sync: is this remote book already cached for offline? (for shelf rendering) */
  isDownloaded(serverId: string | undefined, downloadPath: string): boolean {
    return !!this.find(serverId, downloadPath);
  }

  /** A self-contained Audiobook synthesized from the offline cache, or null if
   *  this book isn't downloaded. Lets playback/restore resolve a downloaded book
   *  with EVERY server offline — no `/api/books` round-trip that throws when the
   *  origin is unreachable. `projectId` is '' (a server-only field); every asset
   *  the player then needs resolves from the on-device cache, not the network.
   *  The single source of truth for "offline book object" — ShelfComponent's card
   *  builder delegates here so the shelf and the player agree. */
  asAudiobook(serverId: string | undefined, downloadPath: string): Audiobook | null {
    const item = this.find(serverId, downloadPath);
    return item ? this.itemAsAudiobook(item) : null;
  }

  /** Build an Audiobook from a specific cached item (see asAudiobook). */
  itemAsAudiobook(item: OfflineItem): Audiobook {
    return {
      projectId: '',
      title: item.title,
      author: item.author,
      type: 'audiobook',
      size: item.size,
      duration: item.duration,
      downloadPath: item.downloadPath,
      originServerId: item.serverId,
      dateAdded: new Date(item.dateAdded).toISOString(),
      offline: true,
    };
  }

  /** A playable URL for the offline audio, or null if this book isn't cached.
   *  Native → the on-disk file URL; web → an IndexedDB object URL. */
  async audioUrl(serverId: string | undefined, downloadPath: string): Promise<string | null> {
    const item = this.find(serverId, downloadPath);
    if (!item) return null;
    return this.assetUrl(item.id, 'main');
  }

  /** An object URL for the offline cover, or null. */
  async coverUrl(serverId: string | undefined, downloadPath: string): Promise<string | null> {
    const item = this.find(serverId, downloadPath);
    if (!item || !item.hasCover) return null;
    return this.assetUrl(item.id, 'cover');
  }

  /** The cached synced-transcript VTT for a downloaded book, or null — so the
   *  Sentences view works with no network. Cached best-effort at download time. */
  async vttText(serverId: string | undefined, downloadPath: string): Promise<string | null> {
    const item = this.find(serverId, downloadPath);
    if (!item) return null;
    const blob = await this.getBlob(`${item.id}:vtt`);
    return blob ? blob.text() : null;
  }

  /** Cached chapter metadata for a downloaded book, or null. */
  async chapters(serverId: string | undefined, downloadPath: string): Promise<unknown[] | null> {
    const item = this.find(serverId, downloadPath);
    if (!item) return null;
    const blob = await this.getBlob(`${item.id}:chapters`);
    if (!blob) return null;
    try {
      const parsed = JSON.parse(await blob.text());
      return Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }

  private async assetUrl(id: string, asset: 'main' | 'cover'): Promise<string | null> {
    const key = `${id}:${asset}`;
    const existing = this.urls.get(key);
    if (existing) return existing;
    const nativeUrl = await this.nativeFile.getUrl(id, asset);
    if (nativeUrl) { this.urls.set(key, nativeUrl); return nativeUrl; }
    const blob = await this.getBlob(key);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }

  // ── download / remove ───────────────────────────────────────────────────────
  /** Fetch a remote audiobook's bytes (+ cover) from its origin server and cache
   *  them for offline playback, publishing byte progress as they stream so the UI
   *  can show a bar and offer Cancel. No-op if already downloaded or in flight.
   *  Throws on a genuine failure (surfaced to the user); returns quietly on cancel
   *  after discarding the partial bytes. */
  async download(book: Audiobook): Promise<void> {
    const serverId = book.originServerId ?? '';
    const path = book.downloadPath;
    if (this.isDownloaded(serverId, path) || this.isDownloading(path)) return;
    const id = crypto.randomUUID();
    const controller = new AbortController();
    this.controllers.set(path, controller);
    this.setProgress(path, 0, book.size || 0);
    try {
      // Audio — the essential asset. cfg.url() carries any per-server access key.
      const audioUrl = this.cfg.url(`/api/audio?path=${encodeURIComponent(path)}`, serverId);
      const audioRes = await fetch(audioUrl, { signal: controller.signal });
      if (!audioRes.ok) throw new Error(`Download failed (server error ${audioRes.status})`);
      const total = Number(audioRes.headers.get('content-length')) || book.size || 0;
      // Native: append slices to the on-device file AS BYTES ARRIVE, never
      // materializing the audiobook in the WebView. Collecting it into a Blob
      // first (the old approach) held the whole file in the web process —
      // WKWebView does not file-back a blob assembled from a JS stream — so on
      // a big book iOS jetsam-killed the page mid-download and the save
      // silently vanished with the reload. Web: IndexedDB blob as before.
      let audioSize: number;
      if (this.nativeFile.available) {
        audioSize = await this.streamToNative(id, audioRes, path, total, controller.signal, this.audioExt(path));
      } else {
        const audioBlob = await this.readWithProgress(audioRes, path, total, controller.signal);
        await this.putBlob(`${id}:main`, audioBlob);
        audioSize = audioBlob.size;
      }

      // Sidecars (cover, transcript, chapters) make a downloaded book fully
      // self-contained so it renders chapters/art and the Sentences view with
      // ZERO network at playback — see the offline-first path in
      // ApiService.getCover/getVttText/getChapters. They're fetched right after
      // the audio finishes, from the SAME server that just streamed the audio, so
      // the realistic failure is a transient blip or the app being backgrounded/
      // suspended mid-download. fetchSidecar() RETRIES to ride those out (the old
      // single-shot fetch here is why some books ended up audio-only, with no
      // chapters/cover). A sidecar that still can't be reached is skipped, not
      // fatal: the 590 MB audio is the expensive, essential asset and must not be
      // thrown away over a missing cover — the book still plays. A user cancel
      // (AbortError) DOES propagate, to discard the whole partial download.

      // Cover — the /api/cover endpoint returns a data URL.
      let hasCover = false;
      try {
        const params = new URLSearchParams();
        if (book.projectId) params.set('projectId', book.projectId);
        if (path) params.set('downloadPath', path);
        const coverRes = await this.fetchSidecar(this.cfg.url(`/api/cover?${params.toString()}`, serverId), controller.signal);
        const coverData = coverRes.ok ? ((await coverRes.json())?.cover as string | undefined) : undefined;
        if (coverData) {
          const coverBlob = await (await fetch(coverData)).blob();
          await this.putBlob(`${id}:cover`, coverBlob);
          hasCover = true;
        }
      } catch (err) { this.rethrowIfAbort(err); /* no cover — fine */ }

      // Synced transcript (VTT). Mirrors ApiService.getVttText (not injected here:
      // ApiService depends on this service).
      try {
        if (book.projectId) {
          const params = new URLSearchParams({ projectId: book.projectId });
          if (book.langPair) params.set('langPair', book.langPair);
          if (path) params.set('path', path);
          const vttRes = await this.fetchSidecar(this.cfg.url(`/api/vtt?${params.toString()}`, serverId), controller.signal);
          if (vttRes.ok && vttRes.status !== 204) {
            const text = await vttRes.text();
            if (text) await this.putBlob(`${id}:vtt`, new Blob([text], { type: 'text/vtt' }));
          }
        }
      } catch (err) { this.rethrowIfAbort(err); /* no transcript — fine */ }

      // Chapter metadata.
      try {
        const chRes = await this.fetchSidecar(this.cfg.url(`/api/chapters?path=${encodeURIComponent(path)}`, serverId), controller.signal);
        if (chRes.ok && (chRes.headers.get('content-type') || '').includes('application/json')) {
          const chapters = (await chRes.json())?.chapters;
          if (Array.isArray(chapters) && chapters.length) {
            await this.putBlob(`${id}:chapters`, new Blob([JSON.stringify(chapters)], { type: 'application/json' }));
          }
        }
      } catch (err) { this.rethrowIfAbort(err); /* no chapters — fine */ }

      const item: OfflineItem = {
        id, serverId, downloadPath: path,
        title: book.title, author: book.author || '',
        size: audioSize, duration: book.duration, hasCover,
        dateAdded: Date.now(),
      };
      this.items.update(list => [item, ...list]);
      this.saveIndex();
    } catch (err) {
      await this.discardAsset(id); // drop any partial bytes we managed to store
      if (err instanceof DOMException && err.name === 'AbortError') return; // cancelled — expected
      throw err;
    } finally {
      this.clearProgress(path);
    }
  }

  /** Fetch a small sidecar asset (cover/vtt/chapters) during a download, retrying
   *  transient NETWORK failures so a momentary blip mid-download doesn't leave the
   *  offline copy missing metadata. A user cancel (AbortError) is never retried —
   *  it rethrows so the whole download aborts. Any HTTP RESPONSE (even an error
   *  status) ends the retries: the server was reached, so its answer is
   *  authoritative (the book simply has no such asset). */
  private async fetchSidecar(url: string, signal: AbortSignal, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fetch(url, { signal });
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        lastErr = err;
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Rethrow a user-cancel so it aborts the whole download; swallow anything else
   *  (a sidecar we couldn't fetch is skipped, never fatal — the audio still plays). */
  private rethrowIfAbort(err: unknown): void {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
  }

  /** The audio file's real extension (from its server path), so the native copy
   *  can carry it — AVPlayer refuses extension-less local files ("Cannot Open"). */
  private audioExt(downloadPath: string): string | undefined {
    const m = /\.([a-z0-9]{1,8})$/.exec(this.identity(downloadPath));
    return m ? m[1] : undefined;
  }

  /** Stream a response body straight into the native on-device file, appending
   *  ≤4 MiB slices as they arrive and publishing byte progress. Returns total
   *  bytes written. The WebView never holds more than ~two slices, no matter how
   *  large the audiobook — this is the WKWebView-safe path (see download()).
   *  Aborting the controller cancels the reader → surfaces as AbortError to
   *  download(), whose catch discards the partial native file. */
  private async streamToNative(id: string, res: Response, path: string, total: number, signal: AbortSignal, ext?: string): Promise<number> {
    if (!res.body) {
      // No streaming support — should not happen on WKWebView, but stay correct.
      const blob = await res.blob();
      await this.nativeFile.writeSlice(id, 'main', blob, true, ext);
      this.setProgress(path, blob.size, total || blob.size);
      return blob.size;
    }
    const CHUNK = 4 * 1024 * 1024;
    const reader = res.body.getReader();
    const onAbort = () => { reader.cancel(new DOMException('Aborted', 'AbortError')).catch(() => {}); };
    signal.addEventListener('abort', onAbort);
    try {
      let received = 0;
      let first = true;
      let buffered: BlobPart[] = [];
      let bufferedBytes = 0;
      const flush = async () => {
        const slice = new Blob(buffered);
        buffered = []; bufferedBytes = 0;
        await this.nativeFile.writeSlice(id, 'main', slice, first, ext);
        first = false;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered.push(value);
        bufferedBytes += value.byteLength;
        received += value.byteLength;
        this.setProgress(path, received, total || received);
        if (bufferedBytes >= CHUNK) await flush();
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // Tail slice — also creates the (empty) file for a zero-byte response.
      if (bufferedBytes > 0 || first) await flush();
      return received;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Stream a response body into a Blob, publishing byte progress — the WEB
   *  path only (bytes then go to IndexedDB). On iOS this would balloon the web
   *  process (a blob built from a JS stream is heap-backed there), which is why
   *  the native path streams to disk via streamToNative() instead. Aborting the
   *  controller cancels the reader → surfaces as AbortError to download(). */
  private async readWithProgress(res: Response, path: string, total: number, signal: AbortSignal): Promise<Blob> {
    if (!res.body) {
      const blob = await res.blob();
      this.setProgress(path, blob.size, total || blob.size);
      return blob;
    }
    const reader = res.body.getReader();
    let received = 0;
    const onAbort = () => { reader.cancel(new DOMException('Aborted', 'AbortError')).catch(() => {}); };
    signal.addEventListener('abort', onAbort);
    const counted = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        received += value.byteLength;
        this.setProgress(path, received, total || received);
        controller.enqueue(value);
      },
      cancel: (reason) => { reader.cancel(reason).catch(() => {}); },
    });
    try {
      const type = res.headers.get('content-type') || 'audio/mp4';
      const blob = await new Response(counted, { headers: { 'Content-Type': type } }).blob();
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      return blob;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** Best-effort cleanup of a half-written download (all assets, both stores). */
  private async discardAsset(id: string): Promise<void> {
    try {
      for (const asset of ['main', 'cover', 'vtt', 'chapters']) await this.deleteBlob(`${id}:${asset}`);
      await this.nativeFile.remove(id);
    } catch { /* nothing to clean / already gone */ }
  }

  /** Drop the offline cache for a book (bytes + cover + transcript + index entry). */
  async remove(serverId: string | undefined, downloadPath: string): Promise<void> {
    const item = this.find(serverId, downloadPath);
    if (!item) return;
    for (const asset of ['main', 'cover', 'vtt', 'chapters']) await this.deleteBlob(`${item.id}:${asset}`);
    await this.nativeFile.remove(item.id);
    for (const asset of ['main', 'cover'] as const) {
      const key = `${item.id}:${asset}`;
      const url = this.urls.get(key);
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      this.urls.delete(key);
    }
    this.items.update(list => list.filter(i => i.id !== item.id));
    this.saveIndex();
  }

  // ── index persistence (localStorage) ─────────────────────────────────────────
  private loadIndex(): OfflineItem[] {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  private saveIndex(): void {
    localStorage.setItem(INDEX_KEY, JSON.stringify(this.items()));
  }

  // ── IndexedDB blob store ─────────────────────────────────────────────────────
  private openDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async putBlob(key: string, blob: Blob): Promise<void> {
    const db = await this.openDb();
    await this.tx(db, 'readwrite', store => store.put(blob, key));
  }

  private async getBlob(key: string): Promise<Blob | null> {
    const db = await this.openDb();
    return this.txResult<Blob | null>(db, 'readonly', store => store.get(key)).then(v => (v as Blob) ?? null);
  }

  private async deleteBlob(key: string): Promise<void> {
    const db = await this.openDb();
    await this.tx(db, 'readwrite', store => store.delete(key));
  }

  private tx(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = db.transaction(DB_STORE, mode);
      op(t.objectStore(DB_STORE));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  private txResult<T>(db: IDBDatabase, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = db.transaction(DB_STORE, mode);
      const req = op(t.objectStore(DB_STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }
}
