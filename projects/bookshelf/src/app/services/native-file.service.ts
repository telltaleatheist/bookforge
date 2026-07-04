import { Injectable } from '@angular/core';

/**
 * On-device FILE storage for the native iOS shell, used ONLY where a `blob:`
 * object URL won't do: audiobook playback goes through the native AVPlayer
 * (see audio-backend.ts / NativeAudioPlugin.swift), and AVPlayer cannot load a
 * `blob:` URL — it needs a real `file://` on disk. Covers (shown via <img>) and
 * EPUB bytes (read as ArrayBuffers by epub.js) work fine straight from
 * IndexedDB inside the WebView, so those stay there; only the audio main asset
 * is mirrored to the native filesystem.
 *
 * On the web (and anywhere the native bridge is absent) every method is a no-op
 * that reports "not stored" (write → null, getUrl → null), so LocalLibraryService
 * transparently falls back to its IndexedDB blob URLs. Mirrors the native-plugin
 * detection in audio-backend.ts (window.Capacitor.nativePromise), since this app
 * does not bundle @capacitor/core.
 */

interface CapBridge {
  isNativePlatform?: () => boolean;
  nativePromise?: (plugin: string, method: string, options?: unknown) => Promise<unknown>;
}

const PLUGIN = 'NativeFile';

@Injectable({ providedIn: 'root' })
export class NativeFileService {
  private readonly cap = (window as unknown as { Capacitor?: CapBridge }).Capacitor;

  /** True only inside the native shell, where the file bridge is available. */
  get available(): boolean {
    return !!this.cap?.isNativePlatform?.() && typeof this.cap.nativePromise === 'function';
  }

  private call<T>(method: string, options?: unknown): Promise<T> {
    return this.cap!.nativePromise!(PLUGIN, method, options) as Promise<T>;
  }

  /** Persist a book asset to native storage; returns its `file://` URL, or null
   *  when there's no native bridge (web) so callers fall back to IndexedDB.
   *
   *  Streams the blob to native in slices. Base64-ing a whole audiobook into one
   *  JS string (and shipping it across the bridge) momentarily holds ~1.3–2.6× the
   *  file in the WebView, which OOM-reloads WKWebView mid-save on a large book —
   *  the download's bytes never reach the offline index. Slicing keeps peak heap
   *  at ~one chunk, mirroring the file-backed streaming on the read side
   *  (offline-store readWithProgress). First slice truncates; the rest append.
   *
   *  A genuine native failure THROWS (not null): null means "not stored natively"
   *  only for the web path. A silent IndexedDB fallback here would be shadowed at
   *  playback anyway (getUrl is consulted before IndexedDB), so a half-written
   *  native file is dropped and the error surfaces. */
  async write(id: string, asset: 'main' | 'cover', blob: Blob): Promise<string | null> {
    if (!this.available) return null;
    const CHUNK = 4 * 1024 * 1024; // 4 MiB → ~5.3 MiB base64 per bridge call
    try {
      let url: string | null = null;
      let wroteAnySlice = false;
      for (let offset = 0; offset < blob.size; offset += CHUNK) {
        const data = await NativeFileService.blobToBase64(blob.slice(offset, offset + CHUNK));
        const res = await this.call<{ url?: string }>('write', { id, asset, data, append: wroteAnySlice });
        url = res?.url ?? url;
        wroteAnySlice = true;
      }
      if (!wroteAnySlice) {
        // Zero-byte asset: still create the (empty) file so getUrl finds it.
        const res = await this.call<{ url?: string }>('write', { id, asset, data: '', append: false });
        url = res?.url ?? null;
      }
      return url;
    } catch (err) {
      // Drop any partial file so it can't shadow an IndexedDB copy at playback.
      try { await this.call('remove', { id }); } catch { /* best effort */ }
      throw err;
    }
  }

  /** The `file://` URL of a stored asset, or null if not on native / not present. */
  async getUrl(id: string, asset: 'main' | 'cover'): Promise<string | null> {
    if (!this.available) return null;
    try {
      const res = await this.call<{ url?: string | null }>('getUrl', { id, asset });
      return res?.url ?? null;
    } catch {
      return null;
    }
  }

  /** Delete every stored asset for a book. No-op off native. */
  async remove(id: string): Promise<void> {
    if (!this.available) return;
    try { await this.call('remove', { id }); } catch { /* best effort */ }
  }

  /** Blob → bare base64 (no data: prefix), for the Capacitor string bridge. */
  private static blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.readAsDataURL(blob);
    });
  }
}
