import { inject, Injectable } from '@angular/core';
import { ApiService } from './api.service';
import { ReaderService } from './reader.service';
import { PlayerService } from './player.service';
import { LocalLibraryService, LOCAL_SERVER_ID, isLocalPath, localIdOf } from './local-library.service';
import { OfflineStoreService } from './offline-store.service';
import { Audiobook, Ebook } from '../models/types';

/**
 * The verbs behind the book context menu (long-press / right-click a card):
 * Start over, Mark as finished, Erase history, Remove from device. Each acts on
 * an ARBITRARY book identified only by its path — it does NOT need the book open
 * in the player/reader — so it drives localStorage AND the origin server directly
 * (mirroring what PlayerService/BookReader write for the open book).
 *
 * Progress lives in two mirrors, newest-write-wins on open:
 *  - localStorage: instant + offline (keys below match the player/reader exactly)
 *  - the book's ORIGIN server (via that server's reader token) — skipped for
 *    on-device `local` books, which have no server token.
 *
 * When an action targets the very book currently loaded in the player, the live
 * player state is updated too so the change is visible without a reopen.
 */
@Injectable({ providedIn: 'root' })
export class BookActionsService {
  private readonly api = inject(ApiService);
  private readonly reader = inject(ReaderService);
  private readonly player = inject(PlayerService);
  private readonly local = inject(LocalLibraryService);
  private readonly offline = inject(OfflineStoreService);

  // localStorage keys — MUST match PlayerService / BookReaderComponent.
  private posKey(downloadPath: string): string { return `bookshelf-pos:${downloadPath}`; }
  private heardKey(downloadPath: string): string { return `bookshelf-heard:${downloadPath}`; }
  private audioBmKey(downloadPath: string): string { return `bookshelf-bm:${downloadPath}`; }
  private epubPosKey(ref: string): string { return `bookshelf-read-epub:${ref}`; }
  private pdfPosKey(ref: string): string { return `bookshelf-read-pdf:${ref}`; }
  private readBmKey(ref: string): string { return `bookshelf-read-bm:${ref}`; }

  /** `e:<relativePath>` — the reader ref for an Ebooks-tab file. */
  private ebookRef(book: Ebook): string { return `e:${book.relativePath}`; }

  // ── Audiobooks (keyed by downloadPath) ─────────────────────────────────────
  /** Reset an audiobook to the beginning: clear saved position + listened
   *  coverage, locally and on its origin server. */
  audioStartOver(book: Audiobook): void {
    // If it's the open book, let the player do the live reset (seeks to 0 + wipes
    // its in-memory heard/position and pushes to the server).
    if (this.player.book()?.downloadPath === book.downloadPath) {
      this.player.resetProgress();
      return;
    }
    localStorage.removeItem(this.posKey(book.downloadPath));
    localStorage.setItem(this.heardKey(book.downloadPath), JSON.stringify([]));
    const token = this.reader.token(book.originServerId);
    if (token) {
      this.api.postPosition(token, { bookPath: book.downloadPath, kind: 'audio', value: 0 });
      this.api.postHeard(token, { bookPath: book.downloadPath, intervals: [] });
    }
  }

  /** True only when we can place the "finished" marker precisely (need duration). */
  canMarkFinished(book: Audiobook): boolean {
    return !!book.duration && book.duration > 0;
  }

  /** Mark an audiobook finished: park the position at the end and paint the whole
   *  book as listened, so it reads as complete everywhere progress is shown. */
  audioMarkFinished(book: Audiobook): void {
    const dur = book.duration ?? 0;
    if (dur <= 0) return;
    const full: Array<[number, number]> = [[0, dur]];
    localStorage.setItem(this.posKey(book.downloadPath), JSON.stringify({ v: dur, at: Date.now() }));
    localStorage.setItem(this.heardKey(book.downloadPath), JSON.stringify(full));
    // Reflect immediately if this book is the one on screen.
    if (this.player.book()?.downloadPath === book.downloadPath) {
      this.player.heard.set(full);
    }
    const token = this.reader.token(book.originServerId);
    if (token) {
      this.api.postPosition(token, { bookPath: book.downloadPath, kind: 'audio', value: dur });
      this.api.postHeard(token, { bookPath: book.downloadPath, intervals: full });
    }
  }

  /** Erase everything the app remembers about an audiobook: analytics entry on the
   *  origin server, plus the local position / listened / bookmark caches. */
  async audioEraseHistory(book: Audiobook): Promise<void> {
    localStorage.removeItem(this.posKey(book.downloadPath));
    localStorage.removeItem(this.heardKey(book.downloadPath));
    localStorage.removeItem(this.audioBmKey(book.downloadPath));
    if (this.player.book()?.downloadPath === book.downloadPath) {
      this.player.heard.set([]);
      this.player.bookmarks.set([]);
    }
    const token = this.reader.token(book.originServerId);
    if (!token) return; // local book: nothing server-side to erase
    // Clear durable position + coverage too, then drop the analytics row.
    this.api.postPosition(token, { bookPath: book.downloadPath, kind: 'audio', value: 0 });
    this.api.postHeard(token, { bookPath: book.downloadPath, intervals: [] });
    await this.api.removeAnalyticsBook(token, book.downloadPath, book.originServerId);
  }

  // ── Ebooks (keyed by reader ref) ────────────────────────────────────────────
  /** Reset a book back to its first page: clear the epub CFI / pdf page position,
   *  locally and on the origin server. */
  ebookStartOver(book: Ebook): void {
    const ref = this.ebookRef(book);
    localStorage.removeItem(this.epubPosKey(ref));
    localStorage.removeItem(this.pdfPosKey(ref));
    const token = this.reader.token(book.originServerId);
    if (token) {
      // Kind matches what the reader stores; an empty value moves it to the start.
      const kind = (book.format || '').toLowerCase() === 'pdf' ? 'pdf' : 'epub';
      this.api.postPosition(token, { ref, kind, value: kind === 'pdf' ? 0 : '' });
    }
  }

  /** Erase a book's reading history: position + bookmark caches. (Ebooks post no
   *  listening analytics, so there's no analytics row to remove.) */
  ebookEraseHistory(book: Ebook): void {
    const ref = this.ebookRef(book);
    localStorage.removeItem(this.epubPosKey(ref));
    localStorage.removeItem(this.pdfPosKey(ref));
    localStorage.removeItem(this.readBmKey(ref));
    const token = this.reader.token(book.originServerId);
    if (token) {
      const kind = (book.format || '').toLowerCase() === 'pdf' ? 'pdf' : 'epub';
      this.api.postPosition(token, { ref, kind, value: kind === 'pdf' ? 0 : '' });
    }
  }

  // ── Offline downloads (remote audiobooks) ───────────────────────────────────
  /** True when a REMOTE audiobook can be saved for offline (not local, not
   *  already downloaded). */
  canDownload(book: Audiobook): boolean {
    return !this.isLocal(book) && !this.offline.isDownloaded(book.originServerId, book.downloadPath);
  }

  /** True when a book already has an offline copy cached. */
  isDownloaded(book: Audiobook): boolean {
    return this.offline.isDownloaded(book.originServerId, book.downloadPath);
  }

  /** Cache a remote audiobook's bytes for offline playback. */
  downloadAudiobook(book: Audiobook): Promise<void> {
    return this.offline.download(book);
  }

  /** Drop a book's offline copy (it stays on its origin server, re-streamable). */
  removeDownload(book: Audiobook): Promise<void> {
    return this.offline.remove(book.originServerId, book.downloadPath);
  }

  // ── On-device library ───────────────────────────────────────────────────────
  /** True when a book lives in the on-device "This device" library (removable). */
  isLocal(book: Pick<Audiobook, 'originServerId' | 'downloadPath'> | Pick<Ebook, 'originServerId' | 'relativePath'>): boolean {
    const path = 'downloadPath' in book ? book.downloadPath : book.relativePath;
    return book.originServerId === LOCAL_SERVER_ID || isLocalPath(path);
  }

  /** Delete an on-device book's bytes + metadata. Also drops its progress caches. */
  async removeLocalAudiobook(book: Audiobook): Promise<void> {
    localStorage.removeItem(this.posKey(book.downloadPath));
    localStorage.removeItem(this.heardKey(book.downloadPath));
    localStorage.removeItem(this.audioBmKey(book.downloadPath));
    if (this.player.book()?.downloadPath === book.downloadPath) this.player.close();
    await this.local.remove(localIdOf(book.downloadPath));
  }

  async removeLocalEbook(book: Ebook): Promise<void> {
    const ref = this.ebookRef(book);
    localStorage.removeItem(this.epubPosKey(ref));
    localStorage.removeItem(this.pdfPosKey(ref));
    localStorage.removeItem(this.readBmKey(ref));
    await this.local.remove(localIdOf(book.relativePath));
  }
}
