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

export interface ClipforgeEngineInfo {
  engine: string;
  available: boolean;
  description: string;
}

export interface ClipforgeRecipeFile {
  filename: string;
  name: string;
  recipe: ClipforgeRecipe | null;
  error: string | null;
}

export interface ClipforgeSaveRecipeResult {
  filename: string;
  path: string;
  alreadyExisted: boolean;
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

export interface RunRecipeResult {
  manifest: ClipforgeManifest;
  run: ClipforgeRun;
}

/** Exactly one of probeId / sourceId identifies the run input. */
export interface RunTarget {
  probeId?: string | null;
  sourceId?: string | null;
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

  // Chain runs
  runRecipe(collectionName: string, target: RunTarget, recipe: ClipforgeRecipe): Promise<RunRecipeResult>;
  runMediaPath(collectionName: string, runId: string, which: string): Promise<string>;

  // Engine introspection + recipes-as-files + copy-for-Claude
  listEngines(): Promise<ClipforgeEngineInfo[]>;
  saveRecipe(collectionName: string, recipe: ClipforgeRecipe): Promise<ClipforgeSaveRecipeResult>;
  listRecipes(collectionName: string): Promise<ClipforgeRecipeFile[]>;
  readProvenance(collectionName: string, runId: string): Promise<string>;
}

declare global {
  interface Window {
    clipforge: ClipforgeBridge;
  }
}
