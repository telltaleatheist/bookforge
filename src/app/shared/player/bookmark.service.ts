import { Injectable, inject } from '@angular/core';
import { ManifestService } from '../../core/services/manifest.service';
import type { BookmarkState, NamedBookmark } from '../../core/models/manifest.types';

const LS_PREFIX = 'bookforge-bookmarks:';

/**
 * BookmarkService - Persists playback position and named bookmarks.
 *
 * Tries manifest storage first (for unified-manifest projects).
 * Falls back to localStorage (for BFP-based books whose ID is a file path).
 */
@Injectable({
  providedIn: 'root'
})
export class BookmarkService {
  private readonly manifestService = inject(ManifestService);

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 10_000;

  // ─────────────────────────────────────────────────────────────────────────
  // Position Bookmarks
  // ─────────────────────────────────────────────────────────────────────────

  async loadBookmark(projectId: string, key: string): Promise<BookmarkState | null> {
    // Try manifest
    const result = await this.manifestService.getProject(projectId);
    if (result.success && result.manifest) {
      return result.manifest.outputs?.bookmarks?.[key] ?? null;
    }
    // Fallback: localStorage
    return this.lsGetBookmark(projectId, key);
  }

  async saveBookmarkImmediate(projectId: string, key: string, bookmark: BookmarkState): Promise<void> {
    this.clearDebounce();
    await this.writeBookmark(projectId, key, bookmark);
  }

  saveBookmarkDebounced(projectId: string, key: string, bookmark: BookmarkState): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.writeBookmark(projectId, key, bookmark);
    }, this.DEBOUNCE_MS);
  }

  async flush(projectId: string, key: string, bookmark: BookmarkState): Promise<void> {
    if (this.debounceTimer) {
      this.clearDebounce();
      await this.writeBookmark(projectId, key, bookmark);
    }
  }

  private clearDebounce(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private async writeBookmark(projectId: string, key: string, bookmark: BookmarkState): Promise<void> {
    const result = await this.manifestService.getProject(projectId);
    if (result.success && result.manifest) {
      const outputs = result.manifest.outputs ?? {};
      const bookmarks = outputs.bookmarks ?? {};
      bookmarks[key] = bookmark;
      await this.manifestService.updateProject({
        projectId,
        outputs: { ...outputs, bookmarks }
      });
      return;
    }
    // Fallback: localStorage
    this.lsSetBookmark(projectId, key, bookmark);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Named Bookmarks
  // ─────────────────────────────────────────────────────────────────────────

  async loadNamedBookmarks(projectId: string, key: string): Promise<NamedBookmark[]> {
    const result = await this.manifestService.getProject(projectId);
    if (result.success && result.manifest) {
      return result.manifest.outputs?.namedBookmarks?.[key] ?? [];
    }
    return this.lsGetNamed(projectId, key);
  }

  async addNamedBookmark(projectId: string, key: string, bookmark: NamedBookmark): Promise<NamedBookmark[]> {
    const result = await this.manifestService.getProject(projectId);
    if (result.success && result.manifest) {
      const outputs = result.manifest.outputs ?? {};
      const namedBookmarks = outputs.namedBookmarks ?? {};
      const list = [...(namedBookmarks[key] ?? []), bookmark];
      namedBookmarks[key] = list;
      await this.manifestService.updateProject({
        projectId,
        outputs: { ...outputs, namedBookmarks }
      });
      return list;
    }
    // Fallback: localStorage
    const list = [...this.lsGetNamed(projectId, key), bookmark];
    this.lsSetNamed(projectId, key, list);
    return list;
  }

  async removeNamedBookmark(projectId: string, key: string, name: string): Promise<NamedBookmark[]> {
    const result = await this.manifestService.getProject(projectId);
    if (result.success && result.manifest) {
      const outputs = result.manifest.outputs ?? {};
      const namedBookmarks = outputs.namedBookmarks ?? {};
      const list = (namedBookmarks[key] ?? []).filter(b => b.name !== name);
      namedBookmarks[key] = list;
      await this.manifestService.updateProject({
        projectId,
        outputs: { ...outputs, namedBookmarks }
      });
      return list;
    }
    // Fallback: localStorage
    const list = this.lsGetNamed(projectId, key).filter(b => b.name !== name);
    this.lsSetNamed(projectId, key, list);
    return list;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // localStorage helpers (fallback for BFP-based books)
  // ─────────────────────────────────────────────────────────────────────────

  private lsKey(projectId: string, key: string): string {
    // Hash the projectId to avoid excessively long localStorage keys (BFP paths)
    let hash = 0;
    for (let i = 0; i < projectId.length; i++) {
      hash = ((hash << 5) - hash + projectId.charCodeAt(i)) | 0;
    }
    return `${LS_PREFIX}${Math.abs(hash).toString(36)}:${key}`;
  }

  private lsGetBookmark(projectId: string, key: string): BookmarkState | null {
    try {
      const raw = localStorage.getItem(this.lsKey(projectId, key) + ':pos');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  private lsSetBookmark(projectId: string, key: string, bookmark: BookmarkState): void {
    try {
      localStorage.setItem(this.lsKey(projectId, key) + ':pos', JSON.stringify(bookmark));
    } catch { /* quota exceeded - ignore */ }
  }

  private lsGetNamed(projectId: string, key: string): NamedBookmark[] {
    try {
      const raw = localStorage.getItem(this.lsKey(projectId, key) + ':named');
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  private lsSetNamed(projectId: string, key: string, list: NamedBookmark[]): void {
    try {
      localStorage.setItem(this.lsKey(projectId, key) + ':named', JSON.stringify(list));
    } catch { /* quota exceeded - ignore */ }
  }
}
