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
  private find(serverId: string | undefined, downloadPath: string): OfflineItem | undefined {
    return this.items().find(i => i.serverId === (serverId ?? '') && i.downloadPath === downloadPath);
  }

  /** Sync: is this remote book already cached for offline? (for shelf rendering) */
  isDownloaded(serverId: string | undefined, downloadPath: string): boolean {
    return !!this.find(serverId, downloadPath);
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
      const audioBlob = await this.readWithProgress(audioRes, path, total, controller.signal);
      await this.storeAsset(id, 'main', audioBlob);

      // Cover — best effort; the /api/cover endpoint returns a data URL.
      let hasCover = false;
      try {
        const params = new URLSearchParams();
        if (book.projectId) params.set('projectId', book.projectId);
        if (path) params.set('downloadPath', path);
        const coverRes = await fetch(this.cfg.url(`/api/cover?${params.toString()}`, serverId), { signal: controller.signal });
        const coverData = (await coverRes.json())?.cover as string | undefined;
        if (coverData) {
          const coverBlob = await (await fetch(coverData)).blob();
          await this.storeAsset(id, 'cover', coverBlob);
          hasCover = true;
        }
      } catch { /* no cover — fine */ }

      const item: OfflineItem = {
        id, serverId, downloadPath: path,
        title: book.title, author: book.author || '',
        size: audioBlob.size, duration: book.duration, hasCover,
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

  /** Stream a response body into a Blob, publishing byte progress. Aborting the
   *  controller cancels the reader → surfaces as AbortError to download().
   *
   *  Bytes flow through a counting pass-through and are collected by
   *  Response.blob(), which WebKit backs with a temp FILE for a payload this large
   *  — NOT the JS heap. Accumulating chunks in a JS array (the previous approach)
   *  ballooned memory on a phone and reloaded the WebView mid-save, so the
   *  download silently never committed. Here peak heap stays ~one chunk. */
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

  /** Best-effort cleanup of a half-written download (both assets, both stores). */
  private async discardAsset(id: string): Promise<void> {
    try {
      await this.deleteBlob(`${id}:main`);
      await this.deleteBlob(`${id}:cover`);
      await this.nativeFile.remove(id);
    } catch { /* nothing to clean / already gone */ }
  }

  /** Drop the offline cache for a book (bytes + cover + index entry). */
  async remove(serverId: string | undefined, downloadPath: string): Promise<void> {
    const item = this.find(serverId, downloadPath);
    if (!item) return;
    await this.deleteBlob(`${item.id}:main`);
    await this.deleteBlob(`${item.id}:cover`);
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

  /** Native audio → filesystem (AVPlayer-friendly); else IndexedDB. */
  private async storeAsset(id: string, asset: 'main' | 'cover', blob: Blob): Promise<void> {
    if (asset === 'main') {
      const wrote = await this.nativeFile.write(id, 'main', blob);
      if (wrote) return;
    }
    await this.putBlob(`${id}:${asset}`, blob);
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
