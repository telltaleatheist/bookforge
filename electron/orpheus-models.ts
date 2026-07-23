/**
 * Folder-discovered custom Orpheus models, backed by a local manifest.
 *
 * Models live in
 *
 *   <orpheusModelsDir>/<id>/        (config.json + a *.safetensors shard)
 *
 * and are catalogued in a `models.json` manifest in that same dir. The manifest
 * is the source of truth for the things the filesystem can't tell us — above all
 * the **prompt token** the model was fine-tuned on (e.g. `owen:`), which often
 * differs from the folder name for third-party models. It also records the source
 * (HF repo / URL) so a voice can be re-pulled, plus label/format/sample-rate.
 *
 * Discovery is manifest-first, with a reconcile fallback: any folder that is a
 * valid model but missing from the manifest is still offered (auto-imported with
 * its folder name guessed as the token), so manually-dropped folders keep working.
 *
 * The catalogue of what's *available to download* lives on HuggingFace (see
 * orpheus-hf-catalog.ts); installing a voice writes its files here and upserts a
 * manifest entry. This module only concerns what's installed locally.
 */

import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { getConfig } from './tool-paths';
import { isWslAliveCached, wslWedgedMessage, isWslWedged } from './wsl-lifecycle';

/** True when a path lives on a \\wsl$ / \\wsl.localhost UNC mount. */
function isWslUnc(p: string): boolean {
  return /^\\\\wsl(\$|\.localhost)\\/i.test(p);
}

/**
 * Every fs call in this module is SYNCHRONOUS, and the models dir is typically a
 * \\wsl$ UNC path on Windows+WSL setups. When the WSL VM is wedged (kernel-stuck),
 * a sync fs touch of \\wsl$ blocks the Electron MAIN THREAD forever — the renderer's
 * invoke()s never return and the app white-screens. So every entry point below must
 * check this gate BEFORE touching the filesystem. Uses the cached liveness probe
 * (kicks a background refresh when stale) because these call sites can't await.
 */
function orpheusDirAccessible(): boolean {
  const dir = getOrpheusModelsDir();
  if (process.platform !== 'win32' || !isWslUnc(dir)) return true;
  return isWslAliveCached();
}

/**
 * The tunable Orpheus caps a voice can declare. Used both at the voice level (flat
 * on the manifest entry / model, applying to every backend) and inside the per-backend
 * `backends` overlay (see below), where a field overrides the flat value FOR THAT
 * BACKEND ONLY. Every field is optional and "absent means unset" — NO FALLBACK, we
 * never invent a default here; e2a's own default rules when a field is absent.
 */
export interface OrpheusVoiceCaps {
  /** PREP packing cap in chars (→ ORPHEUS_MAX_CHARS). */
  maxChars?: number;
  /** GENERATION truncation-guard rate in chars/sec (→ ORPHEUS_MAX_CHARS_PER_SEC). */
  maxCharsPerSec?: number;
  /** Repetition penalty (→ ORPHEUS_REP_PENALTY). */
  repPenalty?: number;
  /**
   * EOS logit boost in logit units (→ ORPHEUS_EOS_BOOST). vLLM-only (e2a ignores
   * it on MLX). For bed-free fine-tunes with a thin greedy end-of-speech margin:
   * once generation passes eosBoostStart x the chunk's expected token count, the
   * EOS logit gets this bias (ramping with overrun). 0/absent = off. Gate any
   * value with the greedy 20-chunk probe + an endings ear-check before deploy.
   */
  eosBoost?: number;
  /** Overrun threshold as a multiple of expected tokens (→ ORPHEUS_EOS_BOOST_START, e2a default 1.2). */
  eosBoostStart?: number;
}

/** A resolved, loadable custom voice. */
export interface OrpheusModel {
  /** Dropdown value / folder id. */
  id: string;
  /** Human label, e.g. "Owen Morgan". */
  label: string;
  /** The prompt token (`--fine_tuned`). From the manifest; may differ from id. */
  voice: string;
  /** Absolute path to the model folder (`--orpheus_model_dir`). */
  dir: string;
  /**
   * Per-voice packing cap (chars) — the PREP-time sentence-packing limit for this
   * fine-tune (→ ORPHEUS_MAX_CHARS). Voice-level, ALL backends; a per-backend value
   * can override via `backends.<name>.maxChars`. Optional: absent means the voice
   * declares no cap and e2a's default applies. An EOS-weak fine-tune that runs away
   * past ~300 chars sets a smaller cap here. Only present when the manifest declares it.
   */
  maxChars?: number;
  /**
   * Per-voice generation guard threshold (chars/sec) — the truncation-guard rate
   * for this fine-tune (→ ORPHEUS_MAX_CHARS_PER_SEC). Voice-level, ALL backends;
   * override per-backend via `backends.<name>.maxCharsPerSec`. Optional: absent means
   * e2a's default (19.0) applies. A fast-reading voice (~20 ch/s natural rate) raises
   * this so honest fast reads aren't flagged as runaways. Only present when declared.
   */
  maxCharsPerSec?: number;
  /**
   * Per-voice repetition penalty (→ ORPHEUS_REP_PENALTY). Voice-level, ALL backends —
   * which is usually WRONG for this field: the silence-loop runaway it fixes is
   * vLLM-only, so prefer `backends.vllm.repPenalty` (see `backends` below). A flat
   * value here applies on MLX too and MLX pays prosody for a fix it doesn't need.
   * Optional: absent means e2a's default (1.1) applies. Probe-validated 1.15 for the
   * CoD deathstalker; 1.2+ risks early-EOS truncation instead.
   */
  repPenalty?: number;
  /**
   * Per-BACKEND cap overlay. Fields declared under the active backend override the
   * flat voice-level caps above FOR THAT BACKEND ONLY; undeclared fields fall through
   * to the flat value (and, absent that, to e2a's default). This is THE mechanism for
   * backend-scoped tuning — chiefly `backends.vllm.repPenalty`, since the silence-loop
   * runaway is vLLM-only (vLLM 0.7.3 applies repetition penalty over the WHOLE sequence
   * and locks into an infinite silence-frame loop at 1.1; MLX's 20-token window renders
   * clean at the 1.1 default — probe-proven 2026-07-14). Backend is chosen the same way
   * e2a's orpheus.py picks it: MLX on macOS, vLLM everywhere else. Only present when
   * declared. Replaces the old "keep repPenalty out of the Mac manifest" convention —
   * one manifest entry is now safely deployable to any machine.
   */
  backends?: { vllm?: OrpheusVoiceCaps; mlx?: OrpheusVoiceCaps };
  /**
   * An ffmpeg audio-filter chain (the `-filter:a` / `-af` value) applied to this
   * voice's audio during the FINAL assembly encode — a per-voice corrective pass
   * (notch/EQ/expander) for the artifacts THIS fine-tune reproduces (e.g. SNAC
   * hiss-comb notches, a firequalizer tone curve). Voice-level only (all backends);
   * there is no per-backend override — the artifacts are the model's, not the
   * backend's. Optional: absent means no post-render filtering (behavior unchanged).
   * The string may contain `|`, `:`, `/`, and single quotes; it is passed to e2a as
   * a single CLI argument (`--post_render_filter`), never interpolated into a shell
   * string. See parallel-tts-bridge (runAssembly) / reassembly-bridge (startReassembly).
   */
  postRenderFilter?: string;
  /**
   * Per-voice DEFAULT inter-sentence gap in seconds, applied at ASSEMBLY time (not at
   * render). e2a bakes an artificial trailing exact-zero pad onto every rendered
   * sentence; the assembly-time gap step strips that pad and re-applies exactly this
   * much silence, so the effective inter-sentence gap matches the human source. Absent
   * means the voice declares no gap default (assembly leaves the raw sentences unchanged
   * — legacy behavior, NO invented default). See reassembly-bridge (startReassembly) and
   * denoise-bridge (normalizeSentenceGaps).
   */
  sentenceGap?: number;
  /**
   * Reference-only: the MEASURED natural inter-sentence gap (seconds) of this voice's
   * training source, recorded so a human can pick a sensible `sentenceGap`. Never
   * consumed by the pipeline — carried through verbatim for tooling/inspection.
   */
  measuredSentenceGapS?: number;
}

/** One installed-model record in models.json. */
export interface OrpheusManifestEntry {
  /** Folder id (and dropdown value). */
  id: string;
  /** Display label. */
  label: string;
  /** The prompt token the model was fine-tuned on — the thing we can't guess. */
  token: string;
  /** Folder name under the models dir (defaults to id). */
  dir?: string;
  /** Model format. */
  format?: 'hf' | 'mlx';
  /** Native sample rate (Orpheus = 24000). */
  sampleRate?: number;
  /**
   * Per-voice PREP packing cap in chars (→ ORPHEUS_MAX_CHARS). Voice-level, all
   * backends; per-backend override via `backends.<name>.maxChars`. Optional — a lower
   * value for EOS-weak fine-tunes that run away on long chunks. Absent means "unset":
   * e2a's default applies (NO FALLBACK — we never invent one).
   */
  maxChars?: number;
  /**
   * Per-voice GENERATION truncation-guard threshold in chars/sec
   * (→ ORPHEUS_MAX_CHARS_PER_SEC). Voice-level, all backends; per-backend override via
   * `backends.<name>.maxCharsPerSec`. Optional — a higher value for genuinely
   * fast-reading voices. Absent means "unset": e2a's 19.0 default applies.
   */
  maxCharsPerSec?: number;
  /**
   * Per-voice repetition penalty (→ ORPHEUS_REP_PENALTY). Voice-level, all backends —
   * usually the WRONG scope for this field: the silence-loop runaway it fixes is
   * vLLM-only, so prefer `backends.vllm.repPenalty` instead. A flat value here applies
   * on MLX too, which doesn't need it and pays prosody for it. Optional — absent means
   * "unset": e2a's 1.1 default applies.
   */
  repPenalty?: number;
  /**
   * Per-BACKEND cap overlay: `{ vllm?: {...caps}, mlx?: {...caps} }`. Fields under the
   * active backend override the flat voice-level caps above FOR THAT BACKEND ONLY;
   * undeclared fields fall through to the flat value (and then e2a's default). This is
   * THE mechanism for backend-scoped tuning and REPLACES the old per-MACHINE manifest
   * split — one entry is now safely deployable to any machine, backend picked exactly
   * as e2a's orpheus.py picks it (MLX on macOS, vLLM everywhere else). The canonical
   * use is `backends.vllm.repPenalty`: vLLM 0.7.3's whole-sequence repetition penalty
   * locks an EOS-weak fine-tune into an infinite silence-frame loop at the 1.1 default
   * (1.15 breaks it for the CoD deathstalker; 1.2+ overshoots to early-EOS), while
   * MLX's 20-token window renders clean at 1.1 — probe-proven 2026-07-14, so MLX must
   * NOT inherit the higher value. Optional — absent fields stay unset (NO FALLBACK).
   */
  backends?: { vllm?: OrpheusVoiceCaps; mlx?: OrpheusVoiceCaps };
  /**
   * Per-voice ffmpeg audio-filter chain applied at the FINAL assembly encode
   * (→ e2a `--post_render_filter` → the export `-af` chain, before loudnorm). A
   * corrective pass for the artifacts THIS fine-tune reproduces (notch/EQ/expander).
   * Optional — absent means no post-render filtering (zero behavioral change). The
   * string may contain shell-special chars (`|`, `:`, `/`, single quotes) and is
   * always passed as a single spawn argument, never through a shell string.
   */
  postRenderFilter?: string;
  /**
   * Per-voice DEFAULT inter-sentence gap in seconds, applied at ASSEMBLY time
   * (→ the gap-normalize step in reassembly-bridge, which strips e2a's artificial
   * trailing exact-zero pad and re-applies this much silence). Optional — absent means
   * "unset": assembly leaves the raw sentences unchanged (NO FALLBACK, no invented gap).
   */
  sentenceGap?: number;
  /**
   * Reference-only measured natural inter-sentence gap (seconds) of the training source.
   * Recorded to inform a human's `sentenceGap` choice; never consumed by the pipeline.
   */
  measuredSentenceGapS?: number;
  /** Where it came from, so it can be re-pulled / updated. */
  source?: { type: 'hf' | 'url' | 'local'; ref?: string };
  license?: string;
  /** ISO date string (stamped by the installer; we never call Date in tests). */
  addedAt?: string;
}

interface OrpheusManifest {
  version: number;
  models: OrpheusManifestEntry[];
}

const MANIFEST_NAME = 'models.json';
const MANIFEST_VERSION = 1;

/**
 * The custom-Orpheus models root.
 *
 * Resolution order: BOOKFORGE_ORPHEUS_MODELS_DIR env (dev seam) → the persisted
 * Settings value (Settings → Tools → "Orpheus models directory") → the default
 * <userData>/runtime/orpheus-models. On Windows+WSL the Settings value is typically
 * a \\wsl$\... UNC path so the model loads off WSL-native ext4; the WSL spawn
 * translates the UNC path to /home/... (see isWslUncPath/uncToWslPath in the bridge).
 */
export function getOrpheusModelsDir(): string {
  const override = process.env.BOOKFORGE_ORPHEUS_MODELS_DIR?.trim();
  if (override) return override;
  const configured = getConfig().orpheusModelsDir?.trim();
  if (configured) return configured;
  return path.join(app.getPath('userData'), 'runtime', 'orpheus-models');
}

function manifestPath(): string {
  return path.join(getOrpheusModelsDir(), MANIFEST_NAME);
}

/** Read models.json (tolerant: missing/corrupt → empty manifest). */
export function readManifest(): OrpheusManifest {
  if (!orpheusDirAccessible()) {
    console.warn('[ORPHEUS-MODELS] readManifest skipped — WSL not responding (models dir is \\\\wsl$)');
    return { version: MANIFEST_VERSION, models: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8'));
    if (parsed && Array.isArray(parsed.models)) {
      return { version: parsed.version || MANIFEST_VERSION, models: parsed.models };
    }
  } catch {
    /* no manifest yet, or unreadable (e.g. WSL down for a \\wsl$ path) */
  }
  return { version: MANIFEST_VERSION, models: [] };
}

/** Write models.json (creates the dir if needed). Throws when the models dir is a
 *  \\wsl$ path and WSL isn't responding — a sync mkdir there would hang the main
 *  thread forever (the white-screen bug), and silently skipping a write would lose
 *  the manifest update. */
export function writeManifest(models: OrpheusManifestEntry[]): void {
  if (!orpheusDirAccessible()) {
    throw new Error(isWslWedged() ? wslWedgedMessage() : 'WSL is not responding — cannot write to the Orpheus models directory (\\\\wsl$).');
  }
  fs.mkdirSync(getOrpheusModelsDir(), { recursive: true });
  const data: OrpheusManifest = { version: MANIFEST_VERSION, models };
  fs.writeFileSync(manifestPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/** Insert or replace a manifest entry by id. */
export function upsertManifestEntry(entry: OrpheusManifestEntry): void {
  const models = readManifest().models;
  const i = models.findIndex((e) => e.id === entry.id);
  if (i >= 0) models[i] = entry;
  else models.push(entry);
  writeManifest(models);
}

/** Remove a manifest entry by id (does NOT delete the folder). */
export function removeManifestEntry(id: string): void {
  writeManifest(readManifest().models.filter((e) => e.id !== id));
}

/** A folder is a usable model when it has config.json + at least one safetensors shard. */
function isModelFolder(dir: string): boolean {
  try {
    if (!fs.existsSync(path.join(dir, 'config.json'))) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith('.safetensors'));
  } catch {
    return false;
  }
}

/** Prettify a folder name into a display label: "owen-morgan_v2" → "Owen Morgan V2". */
function prettyLabel(folder: string): string {
  return folder
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Installed custom Orpheus models, sorted by label. Manifest-first (so the token
 * is authoritative), with valid-but-unlisted folders auto-imported (token guessed
 * as the folder name) so manually-dropped folders still appear.
 */
export function listOrpheusModels(): OrpheusModel[] {
  if (!orpheusDirAccessible()) {
    console.warn('[ORPHEUS-MODELS] listOrpheusModels skipped — WSL not responding (models dir is \\\\wsl$); returning no custom models');
    return [];
  }
  const root = getOrpheusModelsDir();
  const manifest = readManifest();
  const listed = new Set(manifest.models.map((e) => e.id));
  const out: OrpheusModel[] = [];

  // 1) Manifest entries whose folder is actually a valid model.
  for (const e of manifest.models) {
    const dir = path.join(root, e.dir || e.id);
    if (isModelFolder(dir)) {
      out.push({
        id: e.id, label: e.label || prettyLabel(e.id), voice: e.token || e.id, dir,
        // Carry the optional per-voice caps through verbatim — only when declared,
        // so an unset field stays unset (no invented default).
        ...(e.maxChars !== undefined ? { maxChars: e.maxChars } : {}),
        ...(e.maxCharsPerSec !== undefined ? { maxCharsPerSec: e.maxCharsPerSec } : {}),
        ...(e.repPenalty !== undefined ? { repPenalty: e.repPenalty } : {}),
        ...(e.backends !== undefined ? { backends: e.backends } : {}),
        ...(e.postRenderFilter !== undefined ? { postRenderFilter: e.postRenderFilter } : {}),
        ...(e.sentenceGap !== undefined ? { sentenceGap: e.sentenceGap } : {}),
        ...(e.measuredSentenceGapS !== undefined ? { measuredSentenceGapS: e.measuredSentenceGapS } : {}),
      });
    }
  }

  // 2) Reconcile: valid folders not in the manifest (dropped by hand) — guess token.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const d of entries) {
    if (!d.isDirectory() || listed.has(d.name)) continue;
    const dir = path.join(root, d.name);
    if (!isModelFolder(dir)) continue;
    out.push({ id: d.name, label: prettyLabel(d.name), voice: d.name, dir });
  }

  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

/**
 * Resolve a selected voice id to its model dir + prompt token, or null when the id
 * is not an installed custom model (i.e. it's a built-in voice). Uses the manifest
 * token when present, else falls back to id-as-token for an unlisted folder.
 */
export function resolveOrpheusModel(id: string | undefined | null): OrpheusModel | null {
  if (!id) return null;
  // THROW rather than return null here: a null means "built-in voice", and silently
  // downgrading a custom voice to a built-in because WSL happens to be down would
  // render the whole book with the wrong voice. Fail loudly instead.
  if (!orpheusDirAccessible()) {
    throw new Error(isWslWedged() ? wslWedgedMessage() : `WSL is not responding — cannot resolve Orpheus voice '${id}' from the \\\\wsl$ models directory.`);
  }
  const root = getOrpheusModelsDir();
  const entry = readManifest().models.find((e) => e.id === id);
  const dir = path.join(root, entry?.dir || id);
  if (!isModelFolder(dir)) return null;
  return {
    id, label: entry?.label || prettyLabel(id), voice: entry?.token || id, dir,
    // Optional per-voice caps ride along only when the manifest declares them (an
    // unlisted, hand-dropped folder has no entry → no caps).
    ...(entry?.maxChars !== undefined ? { maxChars: entry.maxChars } : {}),
    ...(entry?.maxCharsPerSec !== undefined ? { maxCharsPerSec: entry.maxCharsPerSec } : {}),
    ...(entry?.repPenalty !== undefined ? { repPenalty: entry.repPenalty } : {}),
    ...(entry?.backends !== undefined ? { backends: entry.backends } : {}),
    ...(entry?.postRenderFilter !== undefined ? { postRenderFilter: entry.postRenderFilter } : {}),
    ...(entry?.sentenceGap !== undefined ? { sentenceGap: entry.sentenceGap } : {}),
    ...(entry?.measuredSentenceGapS !== undefined ? { measuredSentenceGapS: entry.measuredSentenceGapS } : {}),
  };
}

/**
 * The FINAL-encode ffmpeg audio-filter chain declared on an Orpheus voice's manifest
 * entry, or undefined when the voice declares none (or is not a resolvable custom
 * voice — a stock/hand-dropped/unknown id). This is the SHARED read-path handler for
 * the post-render filter: both assembly sites call it (parallel-tts-bridge runAssembly
 * for the direct TTS→assemble path, reassembly-bridge startReassembly for the
 * reassembly/CLI-audiobook path) so the value is resolved identically everywhere.
 * Throws (via resolveOrpheusModel) if the models dir is a \\wsl$ path and WSL is down —
 * we never silently render an artifact-laden file because the manifest couldn't be read.
 */
export function resolveOrpheusPostRenderFilter(id: string | undefined | null): string | undefined {
  return resolveOrpheusModel(id)?.postRenderFilter;
}

/**
 * The per-voice DEFAULT assembly-time inter-sentence gap (seconds) declared on an
 * Orpheus voice's manifest entry, or undefined when the voice declares none (or is not
 * a resolvable custom voice). Mirrors resolveOrpheusPostRenderFilter — the SHARED
 * read-path handler so every assembly site resolves the value identically. Throws (via
 * resolveOrpheusModel) if the models dir is a \\wsl$ path and WSL is down — we never
 * silently skip the gap step because the manifest couldn't be read.
 */
export function resolveOrpheusSentenceGap(id: string | undefined | null): number | undefined {
  return resolveOrpheusModel(id)?.sentenceGap;
}
