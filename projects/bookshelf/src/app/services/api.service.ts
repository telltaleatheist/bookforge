import { Injectable } from '@angular/core';
import { AnalyticsData, Audiobook, Chapter, Ebook, QueueData, ReadInfo, ReaderSummary } from '../models/types';

/**
 * Thin typed wrapper over the Bookshelf HTTP API. The web app runs in a phone
 * browser, so everything goes over fetch — there is no Electron IPC here.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  async getBooks(forceRefresh = false): Promise<Audiobook[]> {
    const res = await fetch(forceRefresh ? '/api/books?refresh=true' : '/api/books');
    const data = await res.json();
    return data.books ?? [];
  }

  async getEbooks(forceRefresh = false): Promise<Ebook[]> {
    const res = await fetch(forceRefresh ? '/api/ebooks?refresh=true' : '/api/ebooks');
    const data = await res.json();
    return data.ebooks ?? [];
  }

  async getQueue(): Promise<QueueData> {
    const res = await fetch('/api/queue');
    return res.json();
  }

  async sendQueueControl(action: 'start' | 'pause'): Promise<void> {
    await fetch(`/api/queue/${action}`, { method: 'POST' });
  }

  async getCover(book: Pick<Audiobook, 'projectId' | 'downloadPath'>): Promise<string | null> {
    const params = new URLSearchParams();
    if (book.projectId) params.set('projectId', book.projectId);
    if (book.downloadPath) params.set('downloadPath', book.downloadPath);
    const res = await fetch(`/api/cover?${params.toString()}`);
    const data = await res.json();
    return data.cover ?? null;
  }

  async getEbookCover(relativePath: string): Promise<string | null> {
    const res = await fetch(`/api/ebook-cover?path=${encodeURIComponent(relativePath)}`);
    const data = await res.json();
    return data.cover ?? null;
  }

  async getChapters(downloadPath: string): Promise<Chapter[]> {
    const res = await fetch(`/api/chapters?path=${encodeURIComponent(downloadPath)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.chapters ?? [];
  }

  /** Fetch the synced transcript. Returns null when no VTT exists (imported m4b).
   *  `downloadPath` resolves the transcript of the SPECIFIC opened variant when a
   *  project has several audiobook versions. */
  async getVttText(projectId: string, langPair?: string, downloadPath?: string): Promise<string | null> {
    if (!projectId) return null;
    const params = new URLSearchParams({ projectId });
    if (langPair) params.set('langPair', langPair);
    if (downloadPath) params.set('path', downloadPath);
    const res = await fetch(`/api/vtt?${params.toString()}`);
    if (res.status === 204 || !res.ok) return null;
    return res.text();
  }

  audioUrl(downloadPath: string): string {
    return `/api/audio?path=${encodeURIComponent(downloadPath)}`;
  }

  downloadUrl(downloadPath: string, displayName?: string): string {
    const name = displayName || downloadPath.split(/[/\\]/).pop() || 'audiobook.m4b';
    return `/api/download?path=${encodeURIComponent(downloadPath)}&filename=${encodeURIComponent(name)}`;
  }

  ebookDownloadUrl(relativePath: string): string {
    return `/api/ebook-download?path=${encodeURIComponent(relativePath)}`;
  }

  // ── In-app reader ─────────────────────────────────────────────────────────────
  // `ref` names the book: `p:<projectId>` (archived source) or `e:<relativePath>`
  // (a standalone Ebooks-tab file).
  /** Returns the book's format/metadata, or null if there's nothing readable. */
  async getReadInfo(ref: string): Promise<ReadInfo | null> {
    const res = await fetch(`/api/read-info?ref=${encodeURIComponent(ref)}`);
    if (!res.ok) return null;
    return res.json();
  }

  /** URL of the book's raw bytes (epub.js fetches this as an ArrayBuffer). */
  readFileUrl(ref: string): string {
    return `/api/read-file?ref=${encodeURIComponent(ref)}`;
  }

  /** URL of a rasterized PDF page (0-indexed). */
  readPageUrl(ref: string, page: number, scale: number): string {
    return `/api/read-page?ref=${encodeURIComponent(ref)}&page=${page}&scale=${scale}`;
  }

  // ── Readers + analytics ───────────────────────────────────────────────────────
  async listReaders(): Promise<ReaderSummary[]> {
    const res = await fetch('/api/readers');
    const data = await res.json();
    return data.readers ?? [];
  }

  async createReader(name: string, pin?: string): Promise<{ token: string; reader: ReaderSummary }> {
    const res = await fetch('/api/readers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin: pin || undefined }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to create reader');
    return res.json();
  }

  async loginReader(id: string, pin?: string): Promise<{ token: string; reader: ReaderSummary }> {
    const res = await fetch('/api/readers/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, pin: pin || undefined }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to sign in');
    return res.json();
  }

  async getMe(token: string): Promise<ReaderSummary | null> {
    const res = await fetch('/api/readers/me', { headers: { 'X-Reader-Token': token } });
    if (!res.ok) return null;
    return (await res.json()).reader ?? null;
  }

  async postHeartbeat(token: string, payload: { bookPath: string; title: string; author: string; seconds: number }): Promise<void> {
    await fetch('/api/analytics/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(payload),
      keepalive: true, // let it complete if the page is unloading
    });
  }

  async getAnalytics(token: string): Promise<AnalyticsData> {
    const res = await fetch('/api/analytics', { headers: { 'X-Reader-Token': token } });
    if (!res.ok) throw new Error('Failed to load analytics');
    return res.json();
  }

  /** Erase a book's listening history from analytics (the per-book ✕). `bookKey`
   *  is the `bookPath` returned by getAnalytics. */
  async removeAnalyticsBook(token: string, bookKey: string): Promise<void> {
    const res = await fetch('/api/analytics/remove', {
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
  async getPosition(token: string, params: { ref?: string; bookPath?: string }): Promise<{ kind?: string; value?: unknown; at?: string }> {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.bookPath) q.set('bookPath', params.bookPath);
    const res = await fetch(`/api/position?${q.toString()}`, { headers: { 'X-Reader-Token': token } });
    if (!res.ok) return {};
    return res.json();
  }

  postPosition(token: string, body: { ref?: string; bookPath?: string; kind: string; value: unknown }): void {
    fetch('/api/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(body),
      keepalive: true, // survive page unload
    }).catch(() => { /* offline; localStorage still holds it */ });
  }

  // ── Durable bookmarks (server-side, merged across devices) ────────────────────
  async getBookmarks<T = unknown>(token: string, params: { ref?: string; bookPath?: string }): Promise<T[]> {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.bookPath) q.set('bookPath', params.bookPath);
    const res = await fetch(`/api/bookmarks?${q.toString()}`, { headers: { 'X-Reader-Token': token } });
    // Throw (rather than return []) on an unreachable/old server so callers keep
    // their local list instead of wiping it.
    if (!res.ok) throw new Error('bookmarks unavailable');
    return (await res.json()).bookmarks ?? [];
  }

  postBookmark(token: string, body: { ref?: string; bookPath?: string; op: 'add' | 'del'; bookmark: { id: string } & Record<string, unknown> }): void {
    fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* offline; localStorage still holds it */ });
  }

  // ── Durable "listened" coverage (server-side, per reader) ─────────────────────
  async getHeard(token: string, params: { ref?: string; bookPath?: string }): Promise<Array<[number, number]>> {
    const q = new URLSearchParams();
    if (params.ref) q.set('ref', params.ref);
    if (params.bookPath) q.set('bookPath', params.bookPath);
    const res = await fetch(`/api/heard?${q.toString()}`, { headers: { 'X-Reader-Token': token } });
    if (!res.ok) throw new Error('heard unavailable');
    return (await res.json()).intervals ?? [];
  }

  postHeard(token: string, body: { ref?: string; bookPath?: string; intervals: Array<[number, number]> }): void {
    fetch('/api/heard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Reader-Token': token },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => { /* offline; localStorage cache still holds it */ });
  }
}
