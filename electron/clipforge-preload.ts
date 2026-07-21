/**
 * ClipForge preload — exposes a focused `window.clipforge` bridge to the
 * ClipForge renderer only.
 *
 * The main BookForge window uses electron/preload.ts (window.electron, a huge
 * API surface). ClipForge is a SEPARATE app and must not inherit that surface,
 * so it gets its own minimal, dedicated preload wiring exactly the `clipforge:*`
 * channels registered in electron/clipforge-bridge.ts. contextIsolation stays
 * on; no Node primitives are leaked to the page.
 *
 * NO FALLBACKS: these are thin ipcRenderer.invoke wrappers. Any error thrown in
 * the main handler rejects the returned promise so the UI can surface it — the
 * renderer must never swallow it into a default.
 */

import { contextBridge, ipcRenderer } from 'electron';

// Mirrors of the bridge's exported shapes (kept in sync by hand — the renderer
// has its own copy in projects/clipforge/src/app/models/types.ts).
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

export interface ClipforgeRecipeStep {
  engine: string;
  settings: Record<string, unknown>;
}

export interface ClipforgeRecipe {
  recipeVersion: number;
  name: string;
  steps: ClipforgeRecipeStep[];
}

export interface ClipforgeRunStage {
  index: number;
  engine: string;
  settings: Record<string, unknown>;
  ffmpegFilter: string;
  filename: string;
  outputDurationSeconds: number;
  outputSizeBytes: number;
}

export interface ClipforgeRun {
  id: string;
  createdAt: string;
  recipeName: string;
  recipeVersion: number;
  recipe: ClipforgeRecipe;
  sourceId: string | null;
  probeId: string | null;
  inputFilename: string;
  outputFilename: string;
  provenanceFilename: string;
  stages: ClipforgeRunStage[];
}

export interface ClipforgeManifest {
  name: string;
  clipforgeVersion: number;
  createdAt: string;
  sources: ClipforgeSource[];
  probes: ClipforgeProbe[];
  runs: ClipforgeRun[];
}

export interface ClipforgeCollectionSummary {
  name: string;
  path: string;
  createdAt: string;
  sourceCount: number;
  probeCount: number;
}

const clipforgeApi = {
  // Collections root (user-chosen; no silent default).
  getRoot: (): Promise<string | null> => ipcRenderer.invoke('clipforge:get-root'),
  chooseRoot: (): Promise<string | null> => ipcRenderer.invoke('clipforge:choose-root'),

  // Collections
  listCollections: (): Promise<ClipforgeCollectionSummary[]> =>
    ipcRenderer.invoke('clipforge:list-collections'),
  createCollection: (name: string): Promise<ClipforgeManifest> =>
    ipcRenderer.invoke('clipforge:create-collection', name),
  openCollection: (name: string): Promise<ClipforgeManifest> =>
    ipcRenderer.invoke('clipforge:open-collection', name),

  // Sources (upload = COPY-in with ffprobe + hash)
  addSources: (collectionName: string): Promise<{ manifest: ClipforgeManifest; added: string[]; skipped: string[] }> =>
    ipcRenderer.invoke('clipforge:add-sources', collectionName),

  // Probes (1-minute native-rate extract)
  extractProbe: (
    collectionName: string,
    sourceId: string,
    startSeconds: number,
    durationSeconds: number,
  ): Promise<{ manifest: ClipforgeManifest; probe: ClipforgeProbe }> =>
    ipcRenderer.invoke('clipforge:extract-probe', collectionName, sourceId, startSeconds, durationSeconds),

  // Playback: resolve absolute media paths (wrapped in bookforge-audio:// by the UI)
  sourceMediaPath: (collectionName: string, sourceId: string): Promise<string> =>
    ipcRenderer.invoke('clipforge:source-media-path', collectionName, sourceId),
  probeMediaPath: (collectionName: string, probeId: string): Promise<string> =>
    ipcRenderer.invoke('clipforge:probe-media-path', collectionName, probeId),

  // Chain runs (shared chain engine): run a recipe over a probe OR source, with
  // per-stage intermediates + provenance written into probes/, recorded in runs[].
  runRecipe: (
    collectionName: string,
    target: { probeId?: string | null; sourceId?: string | null },
    recipe: ClipforgeRecipe,
  ): Promise<{ manifest: ClipforgeManifest; run: ClipforgeRun }> =>
    ipcRenderer.invoke('clipforge:run-recipe', collectionName, target, recipe),
  runMediaPath: (collectionName: string, runId: string, which: string): Promise<string> =>
    ipcRenderer.invoke('clipforge:run-media-path', collectionName, runId, which),
};

export type ClipforgeApi = typeof clipforgeApi;

contextBridge.exposeInMainWorld('clipforge', clipforgeApi);
