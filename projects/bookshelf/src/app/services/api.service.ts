import { Injectable } from '@angular/core';
import { AnalyticsData, Audiobook, Chapter, Ebook, QueueData, ReaderSummary } from '../models/types';

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

  /** Fetch the synced transcript. Returns null when no VTT exists (imported m4b). */
  async getVttText(projectId: string, langPair?: string): Promise<string | null> {
    if (!projectId) return null;
    const params = new URLSearchParams({ projectId });
    if (langPair) params.set('langPair', langPair);
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
}
