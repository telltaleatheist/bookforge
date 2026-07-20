import { Injectable } from '@angular/core';
import {
  AddSourcesResult,
  ClipforgeBridge,
  ClipforgeCollectionSummary,
  ClipforgeManifest,
  ExtractProbeResult,
} from '../models/types';

/**
 * Thin renderer-side wrapper over `window.clipforge` (the preload bridge).
 *
 * NO FALLBACKS: if the bridge is missing (the app was somehow loaded outside its
 * Electron window) that is a hard error, not a stubbed no-op — surfacing it is
 * the only honest behaviour. Every method forwards the main-process rejection
 * untouched so the UI shows the real error text.
 */
@Injectable({ providedIn: 'root' })
export class ClipforgeApiService {
  private get bridge(): ClipforgeBridge {
    const bridge = window.clipforge;
    if (!bridge) {
      throw new Error(
        'ClipForge bridge is unavailable (window.clipforge is undefined). ' +
        'This window must be launched by BookForge with the ClipForge preload.',
      );
    }
    return bridge;
  }

  getRoot(): Promise<string | null> {
    return this.bridge.getRoot();
  }

  chooseRoot(): Promise<string | null> {
    return this.bridge.chooseRoot();
  }

  listCollections(): Promise<ClipforgeCollectionSummary[]> {
    return this.bridge.listCollections();
  }

  createCollection(name: string): Promise<ClipforgeManifest> {
    return this.bridge.createCollection(name);
  }

  openCollection(name: string): Promise<ClipforgeManifest> {
    return this.bridge.openCollection(name);
  }

  addSources(collectionName: string): Promise<AddSourcesResult> {
    return this.bridge.addSources(collectionName);
  }

  extractProbe(
    collectionName: string,
    sourceId: string,
    startSeconds: number,
    durationSeconds: number,
  ): Promise<ExtractProbeResult> {
    return this.bridge.extractProbe(collectionName, sourceId, startSeconds, durationSeconds);
  }

  sourceMediaPath(collectionName: string, sourceId: string): Promise<string> {
    return this.bridge.sourceMediaPath(collectionName, sourceId);
  }

  probeMediaPath(collectionName: string, probeId: string): Promise<string> {
    return this.bridge.probeMediaPath(collectionName, probeId);
  }

  /**
   * Build a `bookforge-audio://` URL for a resolved absolute file path. Reuses
   * BookForge's existing range-capable audio protocol (registered globally in
   * the main process) so seeking works without loading the whole file into
   * memory. Mirrors electron.service.ts#enhanceAudioUrl EXACTLY: backslashes →
   * forward slashes, `?v=` cache-buster; the protocol handler re-derives the
   * Windows drive path. (URLs always use forward slashes — never fs backslashes.)
   */
  toAudioUrl(absPath: string): string {
    return `bookforge-audio:///${absPath.replace(/\\/g, '/')}?v=${Date.now()}`;
  }
}
