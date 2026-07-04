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
   *  them for offline playback. No-op if already downloaded. */
  async download(book: Audiobook): Promise<void> {
    const serverId = book.originServerId ?? '';
    if (this.isDownloaded(serverId, book.downloadPath)) return;
    const id = crypto.randomUUID();

    // Audio — the essential asset. cfg.url() carries any per-server access key.
    const audioUrl = this.cfg.url(`/api/audio?path=${encodeURIComponent(book.downloadPath)}`, serverId);
    const audioRes = await fetch(audioUrl);
    if (!audioRes.ok) throw new Error(`Download failed (server error ${audioRes.status})`);
    const audioBlob = await audioRes.blob();
    await this.storeAsset(id, 'main', audioBlob);

    // Cover — best effort; the /api/cover endpoint returns a data URL.
    let hasCover = false;
    try {
      const params = new URLSearchParams();
      if (book.projectId) params.set('projectId', book.projectId);
      if (book.downloadPath) params.set('downloadPath', book.downloadPath);
      const coverRes = await fetch(this.cfg.url(`/api/cover?${params.toString()}`, serverId));
      const coverData = (await coverRes.json())?.cover as string | undefined;
      if (coverData) {
        const coverBlob = await (await fetch(coverData)).blob();
        await this.storeAsset(id, 'cover', coverBlob);
        hasCover = true;
      }
    } catch { /* no cover — fine */ }

    const item: OfflineItem = {
      id, serverId, downloadPath: book.downloadPath,
      title: book.title, author: book.author || '',
      size: audioBlob.size, duration: book.duration, hasCover,
      dateAdded: Date.now(),
    };
    this.items.update(list => [item, ...list]);
    this.saveIndex();
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
