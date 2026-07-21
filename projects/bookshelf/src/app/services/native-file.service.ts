import { Injectable } from '@angular/core';

/**
 * On-device FILE storage for the native iOS shell. Two reasons an asset lives on
 * the native filesystem rather than the WebView's IndexedDB:
 *   1. `blob:` won't do — audiobook playback goes through native AVPlayer (see
 *      audio-backend.ts / NativeAudioPlugin.swift), which cannot load a `blob:`
 *      URL; it needs a real `file://` on disk. That's the audio `main` asset.
 *   2. DURABILITY — WKWebView EVICTS IndexedDB under storage pressure or after
 *      periods of inactivity, while files under Documents/ survive. A downloaded
 *      book kept its 590 MB audio (native) but silently lost its cover + synced
 *      transcript + chapters (IDB) "out of nowhere," repeatedly, and the shelf
 *      never re-healed a size-matched copy. So the sidecars are mirrored here
 *      too — they're small, and survival matters more than the few KB.
 *
 * On the web (and anywhere the native bridge is absent) every method is a no-op
 * that reports "not stored" (write → null, getUrl → null, read → null), so
 * OfflineStore/LocalLibrary transparently fall back to their IndexedDB blobs.
 * Mirrors the native-plugin detection in audio-backend.ts
 * (window.Capacitor.nativePromise), since this app does not bundle @capacitor/core.
 */

/** Every asset kind mirrored to native storage. `main` is the audio; the rest are
 *  the small sidecars made durable so they outlive a WKWebView IndexedDB eviction.
 *  The Swift side is asset-name-agnostic (`<id>-<asset>[.<ext>]`), so adding a kind
 *  here needs no native change. */
export type NativeAsset = 'main' | 'cover' | 'vtt' | 'chapters';

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

  /** Persist a whole in-memory asset to native storage; returns its `file://`
   *  URL, or null when there's no native bridge (web) so callers fall back to
   *  IndexedDB. For assets too big to hold in memory (downloaded audiobooks),
   *  use writeSlice() per network chunk instead — see OfflineStoreService.
   *
   *  `ext` is the asset's real file extension ("m4b", "mp3"): AVPlayer decides
   *  the container format of a local file:// URL from the path extension and
   *  rejects extension-less files with "Cannot Open", so audio must carry one.
   *
   *  A genuine native failure THROWS (not null): null means "not stored natively"
   *  only for the web path. A silent IndexedDB fallback here would be shadowed at
   *  playback anyway (getUrl is consulted before IndexedDB), so a half-written
   *  native file is dropped and the error surfaces. */
  async write(id: string, asset: NativeAsset, blob: Blob, ext?: string): Promise<string | null> {
    if (!this.available) return null;
    try {
      return await this.writeSlice(id, asset, blob, true, ext);
    } catch (err) {
      // Drop any partial file so it can't shadow an IndexedDB copy at playback.
      try { await this.call('remove', { id }); } catch { /* best effort */ }
      throw err;
    }
  }

  /** Append one slice of a streamed write (first=true creates/truncates the
   *  file). Ships the bytes across the bridge in ≤4 MiB base64 chunks so the
   *  WebView never holds more than ~one chunk — base64-ing a whole audiobook
   *  (or even holding it as a Blob assembled from a JS stream, which WKWebView
   *  does NOT back with a file) balloons the web process until iOS jetsam-kills
   *  it and the page reloads mid-save. Callers streaming multiple slices own
   *  cleanup of the partial file if a slice throws (see OfflineStoreService's
   *  discardAsset); write() handles it for whole-blob writes. */
  async writeSlice(id: string, asset: NativeAsset, blob: Blob, first: boolean, ext?: string): Promise<string | null> {
    if (!this.available) return null;
    const CHUNK = 4 * 1024 * 1024; // 4 MiB → ~5.3 MiB base64 per bridge call
    if (blob.size === 0) {
      if (!first) return null; // nothing to append
      // Zero-byte asset: still create the (empty) file so getUrl finds it.
      const res = await this.call<{ url?: string }>('write', { id, asset, data: '', append: false, ext });
      return res?.url ?? null;
    }
    let url: string | null = null;
    let append = !first;
    for (let offset = 0; offset < blob.size; offset += CHUNK) {
      const data = await NativeFileService.blobToBase64(blob.slice(offset, offset + CHUNK));
      const res = await this.call<{ url?: string }>('write', { id, asset, data, append, ext });
      url = res?.url ?? url;
      append = true;
    }
    return url;
  }

  /** The `file://` URL of a stored asset, or null if not on native / not present.
   *  A genuine bridge failure THROWS (see write): swallowing it here would make a
   *  natively-stored book silently stream from the network instead. */
  async getUrl(id: string, asset: NativeAsset): Promise<string | null> {
    if (!this.available) return null;
    const res = await this.call<{ url?: string | null }>('getUrl', { id, asset });
    return res?.url ?? null;
  }

  /** The bytes of a stored asset as a Blob, or null off-native / not present.
   *  For small sidecars (cover/vtt/chapters) read straight through the bridge —
   *  the WebView cannot `fetch()` a `file://` URL, so covers use getUrl()+<img>
   *  but VTT/chapters (parsed as text/JSON in JS) come back as bytes here.
   *  Whole-asset read only; never call it on `main` (a 590 MB base64 round-trip
   *  would OOM the WebView — audio is played by native AVPlayer via getUrl). */
  async read(id: string, asset: NativeAsset, type?: string): Promise<Blob | null> {
    if (!this.available) return null;
    const res = await this.call<{ data?: string | null }>('read', { id, asset });
    const b64 = res?.data;
    if (typeof b64 !== 'string' || !b64) return null;
    return NativeFileService.base64ToBlob(b64, type);
  }

  /** Filenames currently in the native storage dir (`bookshelf-local/`), for
   *  orphan reconciliation on startup. Empty off native; a genuine bridge
   *  failure THROWS (no silent fallback — the caller decides how loud to be). */
  async list(): Promise<string[]> {
    if (!this.available) return [];
    const res = await this.call<{ files?: string[] }>('list', {});
    return res?.files ?? [];
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

  /** Bare base64 (no data: prefix) → Blob, for the read() bridge. */
  private static base64ToBlob(b64: string, type?: string): Blob {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], type ? { type } : undefined);
  }
}
