import { computed, inject, Injectable, signal } from '@angular/core';
import { ServerConfigService } from './server-config.service';
import { NativeFileService, NativeAsset } from './native-file.service';
import { Audiobook } from '../models/types';

/** Fixed native-file extension per sidecar. Fixed (not sniffed from bytes) so the
 *  filename is deterministic — a refresh overwrites the same `<id>-<asset>.<ext>`
 *  instead of leaving a stale second copy findExisting() could pick. None of these
 *  are extension-sensitive at read time (covers render in <img> by content sniff;
 *  vtt/chapters are read as bytes) — only the audio `main` asset needs a real ext. */
const SIDECAR_EXT: Record<'cover' | 'vtt' | 'chapters', string> = { cover: 'jpg', vtt: 'vtt', chapters: 'json' };

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
  // The project this book belongs to on its origin server. Recorded at download
  // so a later sidecar refresh can re-fetch /api/vtt (which REQUIRES projectId)
  // without a live server listing. Absent on pre-existing downloads (fall back to
  // the server book passed into refreshSidecars).
  projectId?: string;
  // The server-side file size this download is RECONCILED to. Equal to `size` on a
  // fresh download; after a sidecar-only refresh it advances to the server's new
  // size (whose extra bytes are the re-embedded transcript, not new audio) so the
  // shelf's staleness check stops re-firing while the on-device audio stays put.
  contentSize?: number;
  // Which version this download is (free-text edition/language label, e.g.
  // "Unabridged" / "German"). Recorded at download time from the chosen version
  // so the on-device card can distinguish two downloaded versions of one book.
  // Absent for single-version books (nothing to disambiguate).
  descriptor?: string;
  variantId?: string;
  // Whether this book has a professionally-read audio version (drives the gold
  // border). Captured at download so a downloaded book shows the marker with no
  // network. Absent on pre-existing downloads → falls back to server data when online.
  hasProfessional?: boolean;
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

  constructor() {
    // Reclaim byte stores stranded by a hard-kill (jetsam/force-quit) or a failed
    // save mid-download — native files (reconcileNativeStorage) and web IndexedDB
    // blobs (reconcileIdbStorage). Best-effort at startup: a failure here must not
    // break the service, but it IS logged (no silent swallow).
    void this.reconcileNativeStorage().catch(err =>
      console.error('[OfflineStore] native storage reconcile failed', err));
    void this.reconcileIdbStorage().catch(err =>
      console.error('[OfflineStore] IDB storage reconcile failed', err));
    // Ask WebKit not to evict our IndexedDB (best-effort). The sidecars that still
    // live there — pre-migration copies, or the web build with no native FS — are
    // the exact bytes an eviction takes; persistence reduces that risk.
    void this.requestPersistentStorage();
    // Move sidecars that are still in IndexedDB onto the durable native filesystem,
    // so a later WKWebView eviction can't take a downloaded book's cover/sentences.
    // Best-effort and only helps copies not YET evicted — already-lost ones heal
    // from the server (shelf loadAudioCover / refreshSidecars) when it's reachable.
    void this.migrateSidecarsToNative().catch(err =>
      console.error('[OfflineStore] sidecar→native migration failed', err));
  }

  /** Best-effort request that the browser keep our IndexedDB across eviction
   *  sweeps. Supported to varying degrees across engines; a rejection or a missing
   *  API is fine — the native-FS mirror is the real durability guarantee. */
  private async requestPersistentStorage(): Promise<void> {
    try {
      const s = navigator.storage;
      if (s?.persist && s.persisted && !(await s.persisted())) await s.persist();
    } catch { /* not supported — the native mirror covers durability */ }
  }

  /** One-time sweep (safe to re-run) that copies any downloaded book's sidecars
   *  still sitting in IndexedDB onto the native filesystem, then drops the IDB
   *  copy. Skips a sidecar already on the FS and one already evicted (nothing to
   *  copy). No-op on web (IDB IS the store there). */
  private async migrateSidecarsToNative(): Promise<void> {
    if (!this.nativeFile.available) return;
    for (const item of this.items()) {
      for (const asset of ['cover', 'vtt', 'chapters'] as const) {
        try {
          if (await this.nativeFile.getUrl(item.id, asset)) continue;   // already durable
          const blob = await this.getBlob(`${item.id}:${asset}`);
          if (!blob) continue;                                          // gone or never had it
          const url = await this.nativeFile.write(item.id, asset, blob, SIDECAR_EXT[asset]);
          if (url) await this.deleteBlob(`${item.id}:${asset}`).catch(() => { /* leave the IDB copy */ });
        } catch (err) {
          console.error('[OfflineStore] migrate sidecar failed', item.id, asset, err);
        }
      }
    }
  }

  /** Sweep the native storage dir for files orphaned by a hard-kill mid-download.
   *  A download's uuid is only written to the index AFTER the whole stream + save
   *  succeeds, so a crash/force-quit/jetsam mid-stream strands `<uuid>-main.<ext>`
   *  in bookshelf-local/ with no index entry and no way to reclaim it. On init we
   *  list the dir and delete every file whose uuid is not referenced by a current
   *  index entry. No-op off native (web has no such files). Never touches a file
   *  whose uuid IS in the index, and is safe when nothing is orphaned. */
  private async reconcileNativeStorage(): Promise<void> {
    if (!this.nativeFile.available) return;
    const names = await this.nativeFile.list();
    if (!names.length) return;
    const known = new Set(this.items().map(i => i.id));
    // Native filenames are `<uuid>-<asset>[.<ext>]`, asset ∈ {main, cover, vtt,
    // chapters}. Extract the uuid; anything whose uuid isn't in the index is an orphan.
    const orphans = new Set<string>();
    for (const name of names) {
      const m = /^(.+)-(?:main|cover|vtt|chapters)(?:\.[^.]+)?$/.exec(name);
      if (!m) continue;                  // unrecognized shape — leave it alone
      const uuid = m[1];
      if (!known.has(uuid)) orphans.add(uuid);
    }
    // remove(uuid) drops every `<uuid>-*` asset; only orphan uuids reach here.
    for (const uuid of orphans) await this.nativeFile.remove(uuid);
  }

  /** Web counterpart to reconcileNativeStorage: drop IndexedDB blobs stranded by a
   *  hard-kill or failed save mid-download — a `<uuid>:<asset>` blob whose uuid is
   *  in no current index entry. No-op on native (bytes live on the filesystem
   *  there, swept above) and when nothing is orphaned. Best-effort at startup. */
  private async reconcileIdbStorage(): Promise<void> {
    if (this.nativeFile.available) return;
    const keys = await this.withDb(db =>
      this.txResult<IDBValidKey[]>(db, 'readonly', store => store.getAllKeys()));
    if (!keys || !keys.length) return;
    const known = new Set(this.items().map(i => i.id));
    for (const k of keys) {
      if (typeof k !== 'string') continue;   // our keys are all `<uuid>:<asset>` strings
      const uuid = k.split(':')[0];
      if (uuid && !known.has(uuid)) {
        try { await this.deleteBlob(k); } catch { /* already gone — fine */ }
      }
    }
  }

  // How many downloads stream at once. Sequential (1) is deliberate: big
  // audiobooks are memory-heavy on iOS (see download()), and a true queue reads
  // clearest — one book fills its ring while the rest wait their turn.
  private static readonly MAX_CONCURRENT = 1;

  // In-flight downloads: live byte progress keyed by the book's downloadPath, so
  // each cover can show its own progress ring. A signal so every surface reacts as
  // bytes arrive.
  readonly downloading = signal<Map<string, { received: number; total: number }>>(new Map());
  private readonly controllers = new Map<string, AbortController>();
  // The download QUEUE: books waiting or actively streaming, in FIFO order, so the
  // shelf can list them all under "On this device" as they come down. A book stays
  // here until it finishes (→ items), is cancelled, or fails (→ dropped). Held in
  // memory only — a relaunch starts clean (no half-finished ghosts to resume).
  readonly queue = signal<Audiobook[]>([]);
  // Transient per-book failure messages (keyed by downloadPath), drained by the UI
  // into a toast. A failed download is otherwise CLEANED UP: its partial bytes are
  // discarded and it leaves the queue, so nothing corrupt or half-done lingers.
  readonly errors = signal<Map<string, string>>(new Map());

  /** Is this book actively streaming right now? */
  isDownloading(downloadPath: string): boolean { return this.downloading().has(downloadPath); }
  /** Is this book in the queue at all (waiting OR streaming)? */
  isPending(downloadPath: string): boolean { return this.queue().some(b => b.downloadPath === downloadPath); }
  /** Is this book waiting its turn in the queue (queued but not yet streaming)? */
  isQueued(downloadPath: string): boolean { return this.isPending(downloadPath) && !this.isDownloading(downloadPath); }
  /** Every queued/in-flight download, in order — the "On this device" pending list. */
  pendingDownloads(): Audiobook[] { return this.queue(); }
  /** Bytes so far / expected for an in-flight download, or null if not running. */
  progressFor(downloadPath: string): { received: number; total: number } | null {
    return this.downloading().get(downloadPath) ?? null;
  }
  /** Last failure message for a book, or null. */
  errorFor(downloadPath: string): string | null { return this.errors().get(downloadPath) ?? null; }

  /** Cancel a download: abort it if it's streaming (the partial is discarded), or
   *  just drop it from the queue if it's still waiting. Either way it leaves the
   *  "On this device" pending list. */
  cancel(downloadPath: string): void {
    const ctrl = this.controllers.get(downloadPath);
    if (ctrl) { ctrl.abort(); return; }   // in-flight → runDownload's catch cleans up + dequeues
    this.removeFromQueue(downloadPath);   // still waiting → just drop it
  }

  private setError(downloadPath: string, message: string): void {
    const next = new Map(this.errors());
    next.set(downloadPath, message);
    this.errors.set(next);
  }
  /** Drop a book's failure message (after the UI has shown it). */
  clearError(downloadPath: string): void {
    if (!this.errors().has(downloadPath)) return;
    const next = new Map(this.errors());
    next.delete(downloadPath);
    this.errors.set(next);
  }
  private removeFromQueue(downloadPath: string): void {
    if (this.isPending(downloadPath)) this.queue.update(q => q.filter(b => b.downloadPath !== downloadPath));
  }

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
      descriptor: item.descriptor,
      variantId: item.variantId,
      hasProfessional: item.hasProfessional,
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
    const blob = await this.readAsset(item.id, 'vtt', 'text/vtt');
    return blob ? blob.text() : null;
  }

  /** Cached chapter metadata for a downloaded book, or null. */
  async chapters(serverId: string | undefined, downloadPath: string): Promise<unknown[] | null> {
    const item = this.find(serverId, downloadPath);
    if (!item) return null;
    const blob = await this.readAsset(item.id, 'chapters', 'application/json');
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
  /** Queue a remote audiobook for offline download. Returns immediately; the queue
   *  streams books MAX_CONCURRENT at a time and publishes per-book byte progress so
   *  each cover shows its own ring. No-op if already downloaded or already queued.
   *  Re-queuing a book that just failed clears its error and tries again. */
  enqueue(book: Audiobook): void {
    const serverId = book.originServerId ?? '';
    const path = book.downloadPath;
    if (this.isDownloaded(serverId, path) || this.isPending(path)) return;
    this.clearError(path);
    this.queue.update(q => [...q, book]);
    this.pump();
  }

  /** Start as many queued downloads as the concurrency budget allows. Safe to call
   *  repeatedly — each completion calls it again to pull the next. runDownload sets
   *  its progress synchronously (before its first await), so this.downloading()
   *  already reflects a just-started download on the next loop turn: no over-spawn. */
  private pump(): void {
    while (this.downloading().size < OfflineStoreService.MAX_CONCURRENT) {
      const next = this.queue().find(b => !this.isDownloading(b.downloadPath));
      if (!next) break;
      void this.runDownload(next);
    }
  }

  /** Fetch a queued audiobook's bytes (+ sidecars) from its origin server and cache
   *  them for offline playback, publishing byte progress as they stream. On success
   *  the book joins the offline index; on failure or cancel its partial bytes are
   *  discarded and it leaves the queue (a failure also records an error message for
   *  the UI to surface). Never throws — the queue drives it fire-and-forget. */
  private async runDownload(book: Audiobook): Promise<void> {
    const serverId = book.originServerId ?? '';
    const path = book.downloadPath;
    if (this.isDownloaded(serverId, path)) { this.removeFromQueue(path); return; }
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

      // Guard against a truncated body: a server can close the connection
      // cleanly but EARLY (short EOF, no stream error), leaving fewer bytes than
      // Content-Length promised. Committing that as a finished download is a trap
      // — downloaded books never re-consult the server, so playback just cuts off
      // with no recovery. When we know the expected length, require an exact
      // match; on a shortfall discard the partial and fail loud so the download is
      // NOT committed and the UI surfaces the failure. (total === 0 means the
      // server sent no Content-Length — we cannot verify length, so we don't
      // fabricate a check.)
      if (total > 0 && audioSize !== total) {
        await this.discardAsset(id);
        throw new Error(`Download incomplete for "${book.title}": received ${audioSize} of ${total} bytes (server closed the connection early). Partial file discarded.`);
      }

      // Sidecars (cover, transcript, chapters) make a downloaded book fully
      // self-contained so it renders chapters/art and the Sentences view with
      // ZERO network at playback — see the offline-first path in
      // ApiService.getCover/getVttText/getChapters. They're fetched right after
      // the audio finishes, from the SAME server that just streamed the audio, so
      // the realistic failure is a transient blip or the app being backgrounded/
      // suspended mid-download. cacheSidecars() RETRIES to ride those out (the old
      // single-shot fetch here is why some books ended up audio-only, with no
      // chapters/cover). A sidecar that still can't be reached is skipped, not
      // fatal: the 590 MB audio is the expensive, essential asset and must not be
      // thrown away over a missing cover — the book still plays. A user cancel
      // (AbortError) DOES propagate, to discard the whole partial download.
      const { hasCover } = await this.cacheSidecars(id, book, serverId, controller.signal);

      const item: OfflineItem = {
        id, serverId, downloadPath: path,
        title: book.title, author: book.author || '',
        size: audioSize, duration: book.duration, hasCover,
        dateAdded: Date.now(),
        projectId: book.projectId || undefined,
        contentSize: book.size || audioSize,
        descriptor: book.descriptor, variantId: book.variantId,
        hasProfessional: book.hasProfessional,
      };
      this.items.update(list => [item, ...list]);
      this.saveIndex();
      this.removeFromQueue(path); // finished → out of the pending list, now in items
    } catch (err) {
      await this.discardAsset(id); // drop any partial bytes we managed to store
      this.removeFromQueue(path);  // clean up: a failed/cancelled download never lingers
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error('[OfflineStore] download failed for', path, err);
        this.setError(path, err instanceof Error ? err.message : 'Download failed');
      }
    } finally {
      this.clearProgress(path);
      this.pump(); // pull the next queued book (if any)
    }
  }

  /** Replace an existing download whose AUDIO changed server-side (a re-render, not
   *  just a re-embed): drop the stale copy, then download the current one afresh.
   *  Reserved for the rare duration-changed case — a transcript re-embed keeps the
   *  audio and is handled by the far cheaper refreshSidecars(). No-op if a download
   *  for this path is already in flight. */
  async redownload(book: Audiobook): Promise<void> {
    const serverId = book.originServerId ?? '';
    if (this.isPending(book.downloadPath)) return;
    await this.remove(serverId, book.downloadPath);
    this.enqueue(book);
  }

  /** Fetch the cover/transcript/chapters for a book and store each as its own IDB
   *  blob under `${id}:<asset>`, overwriting any existing one. Shared by the initial
   *  download() and by refreshSidecars(). Each asset is independent and best-effort:
   *  a fetch that fails (transient) is retried by fetchSidecar and then skipped, so a
   *  missing cover never sinks the transcript. A user cancel (AbortError) propagates.
   *  Returns whether a cover blob was written this pass. */
  private async cacheSidecars(id: string, book: Audiobook, serverId: string, signal: AbortSignal): Promise<{ hasCover: boolean }> {
    const path = book.downloadPath;
    // Cover — the /api/cover endpoint returns a data URL.
    let hasCover = false;
    try {
      const params = new URLSearchParams();
      if (book.projectId) params.set('projectId', book.projectId);
      if (path) params.set('downloadPath', path);
      const coverRes = await this.fetchSidecar(this.cfg.url(`/api/cover?${params.toString()}`, serverId), signal);
      const coverData = coverRes.ok ? ((await coverRes.json())?.cover as string | undefined) : undefined;
      if (coverData) {
        const coverBlob = await (await fetch(coverData)).blob();
        await this.putAsset(id, 'cover', coverBlob, SIDECAR_EXT.cover);
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
        const vttRes = await this.fetchSidecar(this.cfg.url(`/api/vtt?${params.toString()}`, serverId), signal);
        if (vttRes.ok && vttRes.status !== 204) {
          const text = await vttRes.text();
          if (text) await this.putAsset(id, 'vtt', new Blob([text], { type: 'text/vtt' }), SIDECAR_EXT.vtt);
        }
      }
    } catch (err) { this.rethrowIfAbort(err); /* no transcript — fine */ }

    // Chapter metadata.
    try {
      const chRes = await this.fetchSidecar(this.cfg.url(`/api/chapters?path=${encodeURIComponent(path)}`, serverId), signal);
      if (chRes.ok && (chRes.headers.get('content-type') || '').includes('application/json')) {
        const chapters = (await chRes.json())?.chapters;
        if (Array.isArray(chapters) && chapters.length) {
          await this.putAsset(id, 'chapters', new Blob([JSON.stringify(chapters)], { type: 'application/json' }), SIDECAR_EXT.chapters);
        }
      }
    } catch (err) { this.rethrowIfAbort(err); /* no chapters — fine */ }

    return { hasCover };
  }

  // Books whose sidecars are being refreshed right now, keyed by downloadPath, so
  // the shelf's reconcile pass never launches a second refresh over the first.
  private readonly refreshing = new Set<string>();

  /** Re-fetch ONLY the sidecars (transcript, cover, chapters) for an already-
   *  downloaded book and overwrite them in place — the on-device audio blob is
   *  never touched. This is the cheap half of staleness recovery: when a book was
   *  re-embedded server-side (e.g. the aligner adds a transcript via `-c copy`, so
   *  the audio bytes are unchanged), the phone only needs the new ~1 MB transcript,
   *  not a fresh 400 MB download. `book` is the CURRENT server listing (carries the
   *  projectId that /api/vtt requires and the new file size to reconcile to).
   *  Returns true when a refresh ran (found + online), false otherwise. */
  async refreshSidecars(book: Audiobook): Promise<boolean> {
    const serverId = book.originServerId ?? '';
    const path = book.downloadPath;
    const item = this.find(serverId, path);
    if (!item) return false;                       // not downloaded — nothing to refresh
    if (this.refreshing.has(path) || this.isDownloading(path)) return false;
    this.refreshing.add(path);
    try {
      // A never-aborted signal: a background refresh has no Cancel affordance, and
      // a partial refresh is harmless (each asset is written atomically per key).
      const signal = new AbortController().signal;
      const { hasCover } = await this.cacheSidecars(item.id, { ...book, projectId: book.projectId || item.projectId || '' }, serverId, signal);
      this.items.update(list => list.map(i => i.id === item.id
        ? { ...i,
            hasCover: hasCover || i.hasCover,
            projectId: book.projectId || i.projectId,
            // The audio is unchanged, so the server's duration is authoritative for
            // the on-device file — backfill it (an older audio-only download may have
            // saved it as undefined, which leaves the player's timeline broken).
            duration: book.duration ?? i.duration,
            // Reconcile to the server's current size so the shelf stops flagging this
            // copy as stale — the audio on disk is still the pre-embed bytes.
            contentSize: book.size || i.contentSize || i.size }
        : i));
      // Drop any cached cover object URL so the shelf rebinds to the new bytes.
      const coverKey = `${item.id}:cover`;
      const url = this.urls.get(coverKey);
      if (url && url.startsWith('blob:')) URL.revokeObjectURL(url);
      this.urls.delete(coverKey);
      this.saveIndex();
      return true;
    } catch (err) {
      console.error('[OfflineStore] sidecar refresh failed for', path, err);
      return false;
    } finally {
      this.refreshing.delete(path);
    }
  }

  /** The server file size an offline copy is reconciled to (see OfflineItem.contentSize).
   *  Falls back to the recorded download size for copies made before this field existed. */
  reconciledSize(item: OfflineItem): number { return item.contentSize ?? item.size; }

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
    // Best-effort on the IDB sidecars: a dead/closing connection shouldn't strand
    // the download. Try to drop each blob, but always continue to remove the
    // native files and the index entry so "Remove download" reliably completes.
    for (const asset of ['main', 'cover', 'vtt', 'chapters']) {
      try {
        await this.deleteBlob(`${item.id}:${asset}`);
      } catch (err) {
        console.warn('[OfflineStore] could not delete blob', asset, 'for', item.id, err);
      }
    }
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
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // iOS/WKWebView closes idle IndexedDB connections when the app is
        // backgrounded/suspended. Drop the cached handle when that happens (or on
        // a version change) so the next call re-opens instead of using a dead
        // connection — whose db.transaction() throws "Failed to execute
        // 'transaction' on 'IDBDatabase': The database connection is closing."
        db.onclose = () => { if (this.db === opening) this.db = null; };
        db.onversionchange = () => { db.close(); if (this.db === opening) this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    // Don't cache a rejected open — let the next call retry from scratch.
    opening.catch(() => { if (this.db === opening) this.db = null; });
    this.db = opening;
    return this.db;
  }

  /** DOMExceptions WKWebView throws once it has closed our cached connection. */
  private isClosedConnectionError(err: unknown): boolean {
    const name = (err as { name?: string } | null)?.name;
    return name === 'InvalidStateError' || name === 'TransactionInactiveError';
  }

  /** Run an IDB operation, transparently re-opening the connection once if iOS
   *  closed the cached one (db.transaction() throws synchronously in that case). */
  private async withDb<T>(exec: (db: IDBDatabase) => Promise<T>): Promise<T> {
    try {
      return await exec(await this.openDb());
    } catch (err) {
      if (!this.isClosedConnectionError(err)) throw err;
      this.db = null;
      return await exec(await this.openDb());
    }
  }

  private putBlob(key: string, blob: Blob): Promise<void> {
    return this.withDb(db => this.tx(db, 'readwrite', store => store.put(blob, key)));
  }

  /** Persist a downloaded book's sidecar durably: native filesystem on the iOS
   *  shell (survives a WKWebView IndexedDB eviction — the whole point), IndexedDB
   *  on web. A native write that fails or reports "not stored" falls back to IDB so
   *  a sidecar is never lost over a filesystem hiccup; on a durable native write we
   *  drop any stale IDB copy so it can't shadow the fresh bytes or waste quota. */
  private async putAsset(id: string, asset: NativeAsset, blob: Blob, ext?: string): Promise<void> {
    if (this.nativeFile.available) {
      try {
        const url = await this.nativeFile.write(id, asset, blob, ext);
        if (url) { await this.deleteBlob(`${id}:${asset}`).catch(() => { /* nothing to drop */ }); return; }
      } catch (err) {
        console.error('[OfflineStore] native sidecar write failed, falling back to IDB', asset, err);
      }
    }
    await this.putBlob(`${id}:${asset}`, blob);
  }

  /** Read a downloaded book's sidecar bytes — native filesystem first (durable),
   *  then the IndexedDB blob (web, or a copy not yet migrated to native). */
  private async readAsset(id: string, asset: NativeAsset, type?: string): Promise<Blob | null> {
    if (this.nativeFile.available) {
      const native = await this.nativeFile.read(id, asset, type);
      if (native) return native;
    }
    return this.getBlob(`${id}:${asset}`);
  }

  private getBlob(key: string): Promise<Blob | null> {
    return this.withDb(db => this.txResult<Blob | null>(db, 'readonly', store => store.get(key)))
      .then(v => (v as Blob) ?? null);
  }

  private deleteBlob(key: string): Promise<void> {
    return this.withDb(db => this.tx(db, 'readwrite', store => store.delete(key)));
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
