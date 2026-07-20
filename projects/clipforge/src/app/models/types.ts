/**
 * ClipForge renderer-side data model. Mirrors the shapes returned by the
 * `clipforge:*` IPC handlers (electron/clipforge-bridge.ts) and the bridge
 * exposed on `window.clipforge` (electron/clipforge-preload.ts).
 */

export interface ClipforgeSource {
  id: string;
  filename: string;
  originalPath: string;
  addedAt: string;
  sizeBytes: number;
  sha256: string;
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  codec: string;
}

export interface ClipforgeProbe {
  id: string;
  filename: string;
  sourceId: string;
  sourceFilename: string;
  startSeconds: number;
  durationSeconds: number;
  createdAt: string;
  sampleRate: number;
  channels: number;
}

export interface ClipforgeManifest {
  name: string;
  clipforgeVersion: number;
  createdAt: string;
  sources: ClipforgeSource[];
  probes: ClipforgeProbe[];
}

export interface ClipforgeCollectionSummary {
  name: string;
  path: string;
  createdAt: string;
  sourceCount: number;
  probeCount: number;
}

export interface AddSourcesResult {
  manifest: ClipforgeManifest;
  added: string[];
  skipped: string[];
}

export interface ExtractProbeResult {
  manifest: ClipforgeManifest;
  probe: ClipforgeProbe;
}

/** The bridge contract exposed by the ClipForge preload. */
export interface ClipforgeBridge {
  getRoot(): Promise<string | null>;
  chooseRoot(): Promise<string | null>;
  listCollections(): Promise<ClipforgeCollectionSummary[]>;
  createCollection(name: string): Promise<ClipforgeManifest>;
  openCollection(name: string): Promise<ClipforgeManifest>;
  addSources(collectionName: string): Promise<AddSourcesResult>;
  extractProbe(
    collectionName: string,
    sourceId: string,
    startSeconds: number,
    durationSeconds: number,
  ): Promise<ExtractProbeResult>;
  sourceMediaPath(collectionName: string, sourceId: string): Promise<string>;
  probeMediaPath(collectionName: string, probeId: string): Promise<string>;
}

declare global {
  interface Window {
    clipforge: ClipforgeBridge;
  }
}
