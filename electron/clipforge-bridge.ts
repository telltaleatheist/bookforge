/**
 * ClipForge Bridge — main-process IPC for the ClipForge training-audio prep app.
 *
 * ClipForge is a SECOND Angular app in the BookForge workspace (bookshelf
 * precedent). Phase 1 scope: collections (create/list/open) under a
 * user-chosen root, upload (COPY-in) of source audio with ffprobe metadata +
 * content hash, and 1-minute probe extraction. Everything else in
 * CLIPFORGE_PLAN.md is a later phase.
 *
 * HARD RULES honoured here (project law):
 *  - NO FALLBACKS: an unset root, a missing collection, or a failed ffprobe is a
 *    loud thrown error surfaced to the UI — never a silent default or skip.
 *  - The app NEVER modifies sources: uploads are fs.copyFile'd into sources/,
 *    the original is left untouched.
 *  - Windows-safe: backslash fs paths, reserved-name rejection, and the 255-char
 *    path-COMPONENT cap enforced on collection + probe names.
 *
 * IPC channels are all namespaced `clipforge:*` and registered from main.ts via
 * registerClipforgeIpc().
 */

import { ipcMain, dialog, BrowserWindow, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { getConfig, updateConfig, getFfprobePath, getFfmpegPath } from './tool-paths';
import { runChain, Recipe, validateRecipe, StepRecord } from './clipforge-chain';

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Data model (persisted in <root>/<collection>/manifest.json)
// ─────────────────────────────────────────────────────────────────────────────

// v2 adds the `runs: []` array (chain runs). v1 manifests are MIGRATED on load
// (the array is added and the file rewritten with the new version — a real
// migration, not a read-time fallback).
const CLIPFORGE_MANIFEST_VERSION = 2;

/** Fixed sub-directory layout of a collection (CLIPFORGE_PLAN.md → Data model). */
const COLLECTION_SUBDIRS = ['sources', 'probes', 'recipes', 'clipmaps', 'qc', 'output'] as const;

/** Audio containers ClipForge accepts as sources. */
const SOURCE_EXTENSIONS = ['wav', 'flac', 'mp3', 'm4b'] as const;

export interface ClipforgeSource {
  id: string;
  filename: string;          // basename inside sources/
  originalPath: string;      // where it was copied FROM (provenance)
  addedAt: string;           // ISO
  sizeBytes: number;
  sha256: string;            // content hash of the copied bytes
  sampleRate: number;        // native, as probed — never silently resampled
  channels: number;
  durationSeconds: number;
  codec: string;
}

export interface ClipforgeProbe {
  id: string;
  filename: string;          // basename inside probes/
  sourceId: string;          // the source it was extracted from
  sourceFilename: string;    // denormalized for display
  startSeconds: number;
  durationSeconds: number;
  createdAt: string;         // ISO
  sampleRate: number;        // preserved from the source (no silent resample)
  channels: number;
}

/** A per-stage summary within a recorded chain run (basenames are relative to probes/). */
export interface ClipforgeRunStage {
  index: number;
  engine: string;
  settings: Record<string, unknown>;
  ffmpegFilter: string;
  filename: string;              // stage WAV basename inside probes/
  outputDurationSeconds: number;
  outputSizeBytes: number;
}

/**
 * A recorded chain run. The recipe is stored verbatim (provenance), and every
 * produced artifact (final output, per-stage intermediates, provenance JSON)
 * lives in probes/ under a recipe-tagged basename.
 */
export interface ClipforgeRun {
  id: string;
  createdAt: string;             // ISO
  recipeName: string;
  recipeVersion: number;
  recipe: Recipe;                // verbatim
  // Exactly one of sourceId / probeId identifies the input.
  sourceId: string | null;
  probeId: string | null;
  inputFilename: string;         // basename of the input (in sources/ or probes/)
  outputFilename: string;        // final output basename inside probes/
  provenanceFilename: string;    // provenance JSON basename inside probes/
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

/** Lightweight collection summary for the left rail. */
export interface ClipforgeCollectionSummary {
  name: string;
  path: string;              // absolute directory path
  createdAt: string;
  sourceCount: number;
  probeCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Root resolution (NO silent default — the user must choose it explicitly)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The configured collections root, or null when the user hasn't chosen one yet.
 * Persisted in tool-paths.json (`clipforgeRoot`) — the same store BookForge uses
 * for every other path setting. There is deliberately NO default location: a
 * missing root is an explicit "not configured" state the UI must resolve, never
 * a silent write into some guessed folder.
 */
function getRoot(): string | null {
  const configured = getConfig().clipforgeRoot;
  if (configured && configured.trim()) return configured;
  return null;
}

/** getRoot() but throws the loud, user-facing error when unset (NO FALLBACK). */
function requireRoot(): string {
  const root = getRoot();
  if (!root) {
    throw new Error(
      'ClipForge collections root is not set. Choose a folder for your collections first ' +
      '(ClipForge → Choose collections folder).'
    );
  }
  if (!fsSync.existsSync(root)) {
    throw new Error(`ClipForge collections root does not exist: ${root}`);
  }
  return root;
}

// ─────────────────────────────────────────────────────────────────────────────
// Name validation (Windows-safe; NO FALLBACK sanitisation that hides collisions)
// ─────────────────────────────────────────────────────────────────────────────

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Validate a user-supplied collection name. Rejects (loudly) anything that would
 * be an unsafe path component rather than quietly rewriting it — a silently
 * mangled name is exactly the kind of surprise the NO-FALLBACK rule forbids.
 */
function validateCollectionName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('Collection name cannot be empty.');
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new Error('Collection name cannot contain any of \\ / : * ? " < > |');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Collection name cannot be "." or "..".');
  }
  if (WINDOWS_RESERVED.has(trimmed.toUpperCase())) {
    throw new Error(`"${trimmed}" is a reserved name on Windows and cannot be used.`);
  }
  // Windows caps a single path COMPONENT at 255 chars; the manifest/probe files
  // live one level deeper, so keep headroom.
  if (trimmed.length > 200) {
    throw new Error('Collection name is too long (max 200 characters).');
  }
  return trimmed;
}

// ─────────────────────────────────────────────────────────────────────────────
// ffprobe / ffmpeg helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ProbedAudio {
  sampleRate: number;
  channels: number;
  durationSeconds: number;
  codec: string;
}

/**
 * Probe an audio file's native properties with ffprobe. A failure here (no
 * audio stream, unreadable file, missing fields) THROWS — the caller must not
 * record a source it couldn't measure (NO FALLBACK to guessed 44100/2/…).
 */
async function probeAudio(filePath: string): Promise<ProbedAudio> {
  const ffprobe = getFfprobePath();
  let stdout: string;
  try {
    const res = await execFileAsync(
      ffprobe,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-select_streams', 'a',
        filePath,
      ],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    stdout = res.stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`ffprobe failed for ${path.basename(filePath)} (using ${ffprobe}): ${msg}`);
  }

  let parsed: {
    streams?: Array<{ codec_type?: string; sample_rate?: string; channels?: number; codec_name?: string; duration?: string }>;
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`ffprobe returned unparseable JSON for ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) {
    throw new Error(`No audio stream found in ${path.basename(filePath)}.`);
  }

  const sampleRate = audio.sample_rate ? parseInt(audio.sample_rate, 10) : NaN;
  const channels = typeof audio.channels === 'number' ? audio.channels : NaN;
  const codec = audio.codec_name;
  const durationRaw = parsed.format?.duration ?? audio.duration;
  const durationSeconds = durationRaw ? parseFloat(durationRaw) : NaN;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error(`ffprobe could not determine the sample rate of ${path.basename(filePath)}.`);
  }
  if (!Number.isFinite(channels) || channels <= 0) {
    throw new Error(`ffprobe could not determine the channel count of ${path.basename(filePath)}.`);
  }
  if (!codec) {
    throw new Error(`ffprobe could not determine the codec of ${path.basename(filePath)}.`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe could not determine the duration of ${path.basename(filePath)}.`);
  }

  return { sampleRate, channels, durationSeconds, codec };
}

/** Streaming sha256 of a file's bytes — provenance for a copied source. */
function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsSync.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Manifest read / write
// ─────────────────────────────────────────────────────────────────────────────

function collectionDir(root: string, name: string): string {
  return path.join(root, name);
}

function manifestPath(root: string, name: string): string {
  return path.join(collectionDir(root, name), 'manifest.json');
}

async function readManifest(root: string, name: string): Promise<ClipforgeManifest> {
  const mp = manifestPath(root, name);
  let raw: string;
  try {
    raw = await fs.readFile(mp, 'utf-8');
  } catch (err) {
    throw new Error(`Collection "${name}" has no readable manifest.json (${mp}): ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: ClipforgeManifest;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Collection "${name}" manifest.json is corrupt: ${err instanceof Error ? err.message : String(err)}`);
  }
  // Defensive shape — a manifest missing its arrays is corrupt, not "empty".
  if (!Array.isArray(parsed.sources) || !Array.isArray(parsed.probes)) {
    throw new Error(`Collection "${name}" manifest.json is missing its sources/probes arrays.`);
  }

  // MIGRATION (v1 → v2): older manifests predate the runs[] array. Add it and
  // rewrite the file with the bumped version immediately. This is a real
  // migration — an explicit, persisted upgrade — NOT a read-time fallback that
  // silently masks a missing field on every load.
  if (!Array.isArray(parsed.runs)) {
    if (parsed.clipforgeVersion !== 1) {
      throw new Error(
        `Collection "${name}" manifest.json is v${parsed.clipforgeVersion} but has no runs[] array ` +
        `(expected on v1 only). Refusing to guess its shape.`,
      );
    }
    parsed.runs = [];
    parsed.clipforgeVersion = CLIPFORGE_MANIFEST_VERSION;
    await writeManifest(root, name, parsed);
  }
  return parsed;
}

/** Atomic manifest write (temp-in-same-dir + rename) so a crash never truncates it. */
async function writeManifest(root: string, name: string, manifest: ClipforgeManifest): Promise<void> {
  const mp = manifestPath(root, name);
  const dir = path.dirname(mp);
  const tmp = path.join(dir, `.clipforge-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
    await fs.rename(tmp, mp);
  } catch (err) {
    try { await fs.unlink(tmp); } catch { /* ignore cleanup failure */ }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

async function listCollections(): Promise<ClipforgeCollectionSummary[]> {
  const root = requireRoot();
  const entries = await fs.readdir(root, { withFileTypes: true });
  const summaries: ClipforgeCollectionSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const mp = path.join(dir, 'manifest.json');
    if (!fsSync.existsSync(mp)) continue; // not a ClipForge collection
    try {
      const manifest = await readManifest(root, entry.name);
      summaries.push({
        name: manifest.name,
        path: dir,
        createdAt: manifest.createdAt,
        sourceCount: manifest.sources.length,
        probeCount: manifest.probes.length,
      });
    } catch {
      // A corrupt manifest is surfaced when the user opens that collection;
      // it must not take down the whole list.
      summaries.push({ name: entry.name, path: dir, createdAt: '', sourceCount: -1, probeCount: -1 });
    }
  }
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

async function createCollection(rawName: string): Promise<ClipforgeManifest> {
  const root = requireRoot();
  const name = validateCollectionName(rawName);
  const dir = collectionDir(root, name);
  if (fsSync.existsSync(dir)) {
    throw new Error(`A collection named "${name}" already exists.`);
  }
  await fs.mkdir(dir, { recursive: false });
  for (const sub of COLLECTION_SUBDIRS) {
    await fs.mkdir(path.join(dir, sub), { recursive: false });
  }
  const manifest: ClipforgeManifest = {
    name,
    clipforgeVersion: CLIPFORGE_MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    sources: [],
    probes: [],
    runs: [],
  };
  await writeManifest(root, name, manifest);
  return manifest;
}

async function openCollection(name: string): Promise<ClipforgeManifest> {
  const root = requireRoot();
  return readManifest(root, name);
}

/**
 * Copy one or more chosen audio files INTO a collection's sources/ dir, probing
 * each with ffprobe and recording a content hash. The originals are never
 * touched. A file whose sha256 already exists in the collection is skipped
 * (returned in `skipped`) rather than duplicated.
 */
async function addSources(event: IpcMainInvokeEvent, collectionName: string): Promise<{ manifest: ClipforgeManifest; added: string[]; skipped: string[] }> {
  const root = requireRoot();
  const manifest = await readManifest(root, collectionName);
  const parentWindow = BrowserWindow.fromWebContents(event.sender);

  const dialogOpts: Electron.OpenDialogOptions = {
    title: 'Add source audio',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Audio', extensions: [...SOURCE_EXTENSIONS] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
  const pick = parentWindow
    ? await dialog.showOpenDialog(parentWindow, dialogOpts)
    : await dialog.showOpenDialog(dialogOpts);
  if (pick.canceled || pick.filePaths.length === 0) {
    return { manifest, added: [], skipped: [] };
  }

  const sourcesDir = path.join(collectionDir(root, collectionName), 'sources');
  const added: string[] = [];
  const skipped: string[] = [];

  for (const originalPath of pick.filePaths) {
    const ext = path.extname(originalPath).slice(1).toLowerCase();
    if (!(SOURCE_EXTENSIONS as readonly string[]).includes(ext)) {
      throw new Error(`Unsupported source type ".${ext}" (${path.basename(originalPath)}). Allowed: ${SOURCE_EXTENSIONS.join(', ')}.`);
    }

    // Hash the ORIGINAL first so we can dedupe before copying anything.
    const sha256 = await hashFile(originalPath);
    if (manifest.sources.some((s) => s.sha256 === sha256)) {
      skipped.push(path.basename(originalPath));
      continue;
    }

    const filename = path.basename(originalPath);
    // Guard the 255-char component cap on the destination name.
    if (filename.length > 255) {
      throw new Error(`Source filename is too long for the filesystem (${filename.length} chars): ${filename}`);
    }
    const destPath = path.join(sourcesDir, filename);
    if (fsSync.existsSync(destPath)) {
      // Same name, different bytes (hash wasn't a match above) — refuse rather
      // than overwrite or silently rename.
      throw new Error(`sources/ already contains a different file named "${filename}". Rename the incoming file and try again.`);
    }

    // COPY (never move). COPYFILE_EXCL makes the copy fail rather than clobber.
    await fs.copyFile(originalPath, destPath, fsSync.constants.COPYFILE_EXCL);

    let probed: ProbedAudio;
    try {
      probed = await probeAudio(destPath);
    } catch (err) {
      // Don't leave an unmeasured file lying in the collection.
      try { await fs.unlink(destPath); } catch { /* ignore */ }
      throw err;
    }

    const stat = await fs.stat(destPath);
    manifest.sources.push({
      id: crypto.randomUUID(),
      filename,
      originalPath,
      addedAt: new Date().toISOString(),
      sizeBytes: stat.size,
      sha256,
      sampleRate: probed.sampleRate,
      channels: probed.channels,
      durationSeconds: probed.durationSeconds,
      codec: probed.codec,
    });
    added.push(filename);
  }

  if (added.length > 0) {
    await writeManifest(root, collectionName, manifest);
  }
  return { manifest, added, skipped };
}

/**
 * Extract a 1-minute (configurable) probe WAV from a source at a chosen start
 * position, preserving the source's native sample rate + channel count (no
 * silent resample), saved into probes/ and recorded in the manifest.
 */
async function extractProbe(
  collectionName: string,
  sourceId: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<{ manifest: ClipforgeManifest; probe: ClipforgeProbe }> {
  const root = requireRoot();
  const manifest = await readManifest(root, collectionName);
  const source = manifest.sources.find((s) => s.id === sourceId);
  if (!source) {
    throw new Error(`Source ${sourceId} not found in collection "${collectionName}".`);
  }
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new Error(`Invalid probe start position: ${startSeconds}.`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`Invalid probe duration: ${durationSeconds}.`);
  }
  if (startSeconds >= source.durationSeconds) {
    throw new Error(
      `Probe start (${startSeconds.toFixed(1)}s) is past the end of the source ` +
      `(${source.durationSeconds.toFixed(1)}s).`,
    );
  }

  const collDir = collectionDir(root, collectionName);
  const sourcePath = path.join(collDir, 'sources', source.filename);
  const probesDir = path.join(collDir, 'probes');
  const base = path.basename(source.filename, path.extname(source.filename));
  const probeFilename = `${base}__t${Math.round(startSeconds)}s_${Math.round(durationSeconds)}s_${Date.now()}.wav`;
  if (probeFilename.length > 255) {
    throw new Error(`Generated probe filename is too long (${probeFilename.length} chars). Use a source with a shorter name.`);
  }
  const probePath = path.join(probesDir, probeFilename);

  const ffmpeg = getFfmpegPath();
  const args = [
    '-y',
    '-ss', String(startSeconds),   // fast seek before -i
    '-i', sourcePath,
    '-t', String(durationSeconds),
    '-vn',
    '-ar', String(source.sampleRate),   // == native → no resample
    '-ac', String(source.channels),     // == native → no downmix
    '-c:a', 'pcm_s16le',
    '-f', 'wav',
    probePath,
  ];
  try {
    await execFileAsync(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    try { await fs.unlink(probePath); } catch { /* ignore */ }
    throw new Error(`ffmpeg probe extraction failed (using ${ffmpeg}): ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!fsSync.existsSync(probePath)) {
    throw new Error('ffmpeg reported success but no probe file was produced.');
  }

  const probe: ClipforgeProbe = {
    id: crypto.randomUUID(),
    filename: probeFilename,
    sourceId: source.id,
    sourceFilename: source.filename,
    startSeconds,
    durationSeconds,
    createdAt: new Date().toISOString(),
    sampleRate: source.sampleRate,
    channels: source.channels,
  };
  manifest.probes.push(probe);
  await writeManifest(root, collectionName, manifest);
  return { manifest, probe };
}

/** Absolute path of a source's copied file (for the audio protocol). */
function sourceMediaPath(root: string, collectionName: string, sourceId: string, manifest: ClipforgeManifest): string {
  const source = manifest.sources.find((s) => s.id === sourceId);
  if (!source) throw new Error(`Source ${sourceId} not found.`);
  return path.join(collectionDir(root, collectionName), 'sources', source.filename);
}

// ─────────────────────────────────────────────────────────────────────────────
// Chain runs (shared chain engine → probes/ with recipe-tagged names)
// ─────────────────────────────────────────────────────────────────────────────

/** Slugify a recipe name into a filesystem-safe, recipe-tagged basename fragment. */
function recipeSlug(name: string): string {
  const slug = name.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!slug) throw new Error(`Recipe name "${name}" has no filesystem-safe characters.`);
  return slug.slice(0, 60);
}

/**
 * Run a recipe over one probe OR source through the SHARED chain engine, writing
 * the final output, every per-stage intermediate, and the provenance JSON into
 * the collection's probes/ dir under recipe-tagged names, then record the run in
 * the manifest's runs[] array. Intermediates are always kept (the UI solos them).
 */
async function runRecipe(
  collectionName: string,
  target: { probeId?: string | null; sourceId?: string | null },
  rawRecipe: unknown,
): Promise<{ manifest: ClipforgeManifest; run: ClipforgeRun }> {
  const root = requireRoot();
  const manifest = await readManifest(root, collectionName);
  const collDir = collectionDir(root, collectionName);
  const probesDir = path.join(collDir, 'probes');

  // Resolve the input — exactly one of probeId / sourceId (no silent preference).
  const probeId = target.probeId ?? null;
  const sourceId = target.sourceId ?? null;
  if ((probeId && sourceId) || (!probeId && !sourceId)) {
    throw new Error('runRecipe: pass exactly one of probeId or sourceId.');
  }
  let inputPath: string;
  let inputFilename: string;
  if (probeId) {
    const probe = manifest.probes.find((p) => p.id === probeId);
    if (!probe) throw new Error(`Probe ${probeId} not found in collection "${collectionName}".`);
    inputFilename = probe.filename;
    inputPath = path.join(probesDir, probe.filename);
  } else {
    const source = manifest.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error(`Source ${sourceId} not found in collection "${collectionName}".`);
    inputFilename = source.filename;
    inputPath = path.join(collDir, 'sources', source.filename);
  }
  if (!fsSync.existsSync(inputPath)) {
    throw new Error(`Input file for the run is missing on disk: ${inputPath}`);
  }

  // validateRecipe throws loudly on any malformed recipe (unknown engine, bad shape).
  const recipe: Recipe = validateRecipe(rawRecipe);

  const runId = crypto.randomUUID();
  const shortId = runId.slice(0, 8);
  const inputBase = path.basename(inputFilename, path.extname(inputFilename));
  const tag = `${recipeSlug(recipe.name)}__${inputBase}__${shortId}`;
  const outputFilename = `${tag}.wav`;
  if (outputFilename.length > 200) {
    // Stage names extend this further; keep headroom under the 255-char cap.
    throw new Error(`Recipe-tagged output name is too long (${outputFilename.length} chars). Use a shorter recipe or source name.`);
  }
  const outputPath = path.join(probesDir, outputFilename);

  const result = await runChain({
    inputPath,
    recipe,
    outputPath,
    workDir: probesDir,        // intermediates land in probes/ …
    stagePrefix: tag,          // … under recipe-tagged basenames
    keepStages: true,          // the UI solos per-stage renders
  });

  const stages: ClipforgeRunStage[] = result.provenance.steps.map((s: StepRecord) => ({
    index: s.index,
    engine: s.engine,
    settings: s.settings,
    ffmpegFilter: s.ffmpegFilter,
    filename: path.basename(s.outputPath),
    outputDurationSeconds: s.outputDurationSeconds,
    outputSizeBytes: s.outputSizeBytes,
  }));

  const run: ClipforgeRun = {
    id: runId,
    createdAt: result.provenance.timestamp,
    recipeName: recipe.name,
    recipeVersion: recipe.recipeVersion,
    recipe,
    sourceId,
    probeId,
    inputFilename,
    outputFilename,
    provenanceFilename: path.basename(result.provenancePath),
    stages,
  };
  manifest.runs.push(run);
  await writeManifest(root, collectionName, manifest);
  return { manifest, run };
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC registration
// ─────────────────────────────────────────────────────────────────────────────

let registered = false;

export function registerClipforgeIpc(): void {
  if (registered) return; // idempotent — safe if main.ts calls twice
  registered = true;

  // Root config -------------------------------------------------------------
  ipcMain.handle('clipforge:get-root', () => getRoot());

  ipcMain.handle('clipforge:choose-root', async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender);
    const dialogOpts: Electron.OpenDialogOptions = {
      title: 'Choose ClipForge collections folder',
      properties: ['openDirectory', 'createDirectory'],
    };
    const pick = parentWindow
      ? await dialog.showOpenDialog(parentWindow, dialogOpts)
      : await dialog.showOpenDialog(dialogOpts);
    if (pick.canceled || pick.filePaths.length === 0) return getRoot();
    const chosen = pick.filePaths[0];
    updateConfig({ clipforgeRoot: chosen });
    return chosen;
  });

  // Collections -------------------------------------------------------------
  ipcMain.handle('clipforge:list-collections', () => listCollections());
  ipcMain.handle('clipforge:create-collection', (_e, name: string) => createCollection(name));
  ipcMain.handle('clipforge:open-collection', (_e, name: string) => openCollection(name));

  // Sources -----------------------------------------------------------------
  ipcMain.handle('clipforge:add-sources', (event, collectionName: string) => addSources(event, collectionName));

  // Probes ------------------------------------------------------------------
  ipcMain.handle(
    'clipforge:extract-probe',
    (_e, collectionName: string, sourceId: string, startSeconds: number, durationSeconds: number) =>
      extractProbe(collectionName, sourceId, startSeconds, durationSeconds),
  );

  // Playback path resolution — returns the absolute file path the renderer
  // wraps in the existing range-capable `bookforge-audio://` protocol. Paths are
  // resolved from the collection manifest, never accepted raw from the renderer.
  ipcMain.handle('clipforge:source-media-path', async (_e, collectionName: string, sourceId: string) => {
    const root = requireRoot();
    const manifest = await readManifest(root, collectionName);
    return sourceMediaPath(root, collectionName, sourceId, manifest);
  });

  ipcMain.handle('clipforge:probe-media-path', async (_e, collectionName: string, probeId: string) => {
    const root = requireRoot();
    const manifest = await readManifest(root, collectionName);
    const probe = manifest.probes.find((p) => p.id === probeId);
    if (!probe) throw new Error(`Probe ${probeId} not found in collection "${collectionName}".`);
    return path.join(collectionDir(root, collectionName), 'probes', probe.filename);
  });

  // Chain runs -------------------------------------------------------------
  ipcMain.handle(
    'clipforge:run-recipe',
    (_e, collectionName: string, target: { probeId?: string | null; sourceId?: string | null }, recipe: unknown) =>
      runRecipe(collectionName, target, recipe),
  );

  // Resolve the absolute path of a run artifact (final output, a stage, or the
  // provenance JSON) for playback / copy-out. Paths come from the manifest.
  ipcMain.handle('clipforge:run-media-path', async (_e, collectionName: string, runId: string, which: string) => {
    const root = requireRoot();
    const manifest = await readManifest(root, collectionName);
    const run = manifest.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`Run ${runId} not found in collection "${collectionName}".`);
    const probesDir = path.join(collectionDir(root, collectionName), 'probes');
    if (which === 'output') return path.join(probesDir, run.outputFilename);
    if (which === 'provenance') return path.join(probesDir, run.provenanceFilename);
    const stage = run.stages.find((s) => `stage:${s.index}` === which || String(s.index) === which);
    if (!stage) throw new Error(`Run ${runId} has no artifact "${which}" (use "output", "provenance", or a stage index).`);
    return path.join(probesDir, stage.filename);
  });
}
