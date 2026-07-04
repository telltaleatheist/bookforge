import { computed, inject, Injectable, signal } from '@angular/core';
import { Audiobook, Ebook } from '../models/types';
import { NativeFileService } from './native-file.service';

/**
 * The device's own on-device library — the "This device" synthetic server. Your
 * OWN finished media (M4B/MP3 audiobooks, EPUBs) lives here, self-contained and
 * offline, with no BookForge server involved. See MULTI_SERVER.md → Phone as a
 * local server.
 *
 * Storage is browser-native (IndexedDB): file BYTES are stored as Blobs and
 * played/read from object URLs, so this works in the desktop web app AND in
 * mobile Safari — anywhere a browser runs. (The Capacitor iOS shell can later
 * swap the IndexedDB backend for a native-file one behind the same interface;
 * nothing above this service needs to change.)
 *
 * The synthetic server's id is the literal string `local` — every consumer keys
 * off `originServerId === LOCAL_SERVER_ID` to route to this service instead of
 * HTTP. Local book ids are surfaced through the normal `downloadPath` /
 * `relativePath` fields prefixed `local:` so existing routing (open/read/play)
 * carries them without new plumbing.
 */

export const LOCAL_SERVER_ID = 'local';
const LOCAL_PREFIX = 'local:';
const META_KEY = 'bookshelf-local-library';

const DB_NAME = 'bookshelf-local';
const DB_STORE = 'files';
const DB_VERSION = 1;

/** True for a path/ref that belongs to the on-device library. */
export function isLocalPath(pathOrRef: string | undefined | null): boolean {
  return !!pathOrRef && pathOrRef.includes(LOCAL_PREFIX);
}

/** Pull the bare local id out of a `local:<id>` path, an `e:local:<id>` ref, etc. */
export function localIdOf(pathOrRef: string): string {
  const i = pathOrRef.indexOf(LOCAL_PREFIX);
  return i < 0 ? pathOrRef : pathOrRef.slice(i + LOCAL_PREFIX.length);
}

/** Persisted metadata for one on-device book (bytes live separately in IndexedDB). */
export interface LocalBook {
  id: string;
  kind: 'audiobook' | 'ebook';
  title: string;
  author: string;
  format: string;       // 'm4b' | 'mp3' | 'epub' | …
  size: number;
  dateAdded: number;
  duration?: number;    // audiobooks (seconds), filled at import when derivable
  hasCover: boolean;
}

@Injectable({ providedIn: 'root' })
export class LocalLibraryService {
  readonly serverId = LOCAL_SERVER_ID;

  // On native iOS, audio must live on the real filesystem (AVPlayer can't read a
  // blob: URL). This bridge writes there; it's a no-op on the web, where the
  // IndexedDB blob URLs below are used instead.
  private readonly nativeFile = inject(NativeFileService);

  /** Reactive index of on-device books (metadata only). */
  readonly books = signal<LocalBook[]>(this.loadMeta());
  readonly count = computed(() => this.books().length);

  private db: Promise<IDBDatabase> | null = null;
  // Cache of live object URLs so the same asset isn't re-materialized every render;
  // revoked when the book is removed.
  private readonly urls = new Map<string, string>();

  // ── shelf projections ──────────────────────────────────────────────────────
  /** On-device audiobooks shaped as the shelf's Audiobook rows. */
  audiobooks(): Audiobook[] {
    return this.books().filter(b => b.kind === 'audiobook').map(b => ({
      projectId: '',
      title: b.title,
      author: b.author,
      type: 'audiobook',
      size: b.size,
      duration: b.duration,
      downloadPath: LOCAL_PREFIX + b.id,
      coverPath: b.hasCover ? LOCAL_PREFIX + b.id : undefined,
      dateAdded: new Date(b.dateAdded).toISOString(),
      source: 'external',
      originServerId: LOCAL_SERVER_ID,
    }));
  }

  /** On-device ebooks shaped as the shelf's Ebook rows. */
  ebooks(): Ebook[] {
    return this.books().filter(b => b.kind === 'ebook').map(b => ({
      relativePath: LOCAL_PREFIX + b.id,
      title: b.title,
      authorFull: b.author,
      format: b.format,
      fileSize: b.size,
      dateAdded: b.dateAdded,
      filename: `${b.title}.${b.format}`,
      projectType: 'book',
      originServerId: LOCAL_SERVER_ID,
    }));
  }

  book(id: string): LocalBook | undefined {
    return this.books().find(b => b.id === id);
  }

  // ── asset access ────────────────────────────────────────────────────────────
  /** A playable/readable URL for a stored asset (cached + reused). On native the
   *  audio main asset resolves to its on-disk `file://` URL (AVPlayer-friendly);
   *  everything else materializes a blob object URL from IndexedDB. */
  async assetUrl(id: string, asset: 'main' | 'cover' = 'main'): Promise<string | null> {
    const key = `${id}:${asset}`;
    const existing = this.urls.get(key);
    if (existing) return existing;
    // Native audio lives on the filesystem, not IndexedDB — hand back its file URL.
    const nativeUrl = await this.nativeFile.getUrl(id, asset);
    if (nativeUrl) { this.urls.set(key, nativeUrl); return nativeUrl; }
    const blob = await this.getBlob(key);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(key, url);
    return url;
  }

  /** Raw bytes of the stored file (epub.js opens the main asset from these). */
  async bytes(id: string, asset: 'main' | 'cover' = 'main'): Promise<ArrayBuffer | null> {
    const blob = await this.getBlob(`${id}:${asset}`);
    return blob ? blob.arrayBuffer() : null;
  }

  // ── import / remove ──────────────────────────────────────────────────────────
  /** Bring a finished file into the on-device library. EPUB metadata + cover are
   *  extracted client-side; audio duration is read from the decoded blob. */
  async importFile(file: File): Promise<LocalBook> {
    const format = (file.name.split('.').pop() || '').toLowerCase();
    const kind: LocalBook['kind'] = format === 'epub' ? 'ebook' : 'audiobook';
    const id = crypto.randomUUID();

    // Audiobooks on native go to the filesystem (AVPlayer needs a file:// URL
    // with a real extension — it can't identify extension-less containers);
    // if that write isn't available (web) they fall back to IndexedDB like ebooks.
    const wroteNative = kind === 'audiobook' && !!(await this.nativeFile.write(id, 'main', file, format));
    if (!wroteNative) await this.putBlob(`${id}:main`, file);

    let title = file.name.replace(/\.[^.]+$/, '');
    let author = '';
    let duration: number | undefined;
    let hasCover = false;

    if (kind === 'ebook' && format === 'epub') {
      const extracted = await this.extractEpubMeta(await file.arrayBuffer(), id);
      title = extracted.title || title;
      author = extracted.author || '';
      hasCover = extracted.hasCover;
    } else {
      duration = await this.probeAudioDuration(file).catch(() => undefined);
    }

    const meta: LocalBook = {
      id, kind, title, author, format, size: file.size,
      dateAdded: Date.now(), duration, hasCover,
    };
    this.books.update(list => [meta, ...list]);
    this.saveMeta();
    return meta;
  }

  /** Delete an on-device book: its bytes, cover, cached URLs and metadata. */
  async remove(id: string): Promise<void> {
    await this.deleteBlob(`${id}:main`);
    await this.deleteBlob(`${id}:cover`);
    await this.nativeFile.remove(id); // native audio files, if any
    for (const asset of ['main', 'cover'] as const) {
      const key = `${id}:${asset}`;
      const url = this.urls.get(key);
      // Only object URLs need revoking; native file:// URLs are plain paths.
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      this.urls.delete(key);
    }
    this.books.update(list => list.filter(b => b.id !== id));
    this.saveMeta();
  }

  // ── epub / audio metadata extraction ─────────────────────────────────────────
  private async extractEpubMeta(buf: ArrayBuffer, id: string): Promise<{ title: string; author: string; hasCover: boolean }> {
    try {
      // Dynamic import keeps epub.js (~360 kB) out of the main bundle — it loads
      // only when a local EPUB is actually imported or read.
      const ePub = (await import('epubjs')).default;
      const book = ePub(buf as unknown as ArrayBuffer);
      await book.ready;
      const meta = await book.loaded.metadata;
      let hasCover = false;
      try {
        const coverUrl = await book.coverUrl();
        if (coverUrl) {
          const blob = await fetch(coverUrl).then(r => r.blob());
          await this.putBlob(`${id}:cover`, blob);
          hasCover = true;
        }
      } catch { /* no cover — fine */ }
      book.destroy();
      return { title: (meta?.title || '').trim(), author: (meta?.creator || '').trim(), hasCover };
    } catch {
      return { title: '', author: '', hasCover: false };
    }
  }

  private probeAudioDuration(file: File): Promise<number | undefined> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const el = new Audio();
      const done = (d?: number) => { URL.revokeObjectURL(url); resolve(d && isFinite(d) ? d : undefined); };
      el.preload = 'metadata';
      el.onloadedmetadata = () => done(el.duration);
      el.onerror = () => done(undefined);
      el.src = url;
    });
  }

  // ── metadata persistence (localStorage) ──────────────────────────────────────
  private loadMeta(): LocalBook[] {
    try {
      const raw = localStorage.getItem(META_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }

  private saveMeta(): void {
    localStorage.setItem(META_KEY, JSON.stringify(this.books()));
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
