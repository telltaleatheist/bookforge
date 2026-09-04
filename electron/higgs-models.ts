/**
 * The Higgs narration voice catalog — loader, refusals, and the env a Higgs job
 * is rendered with.
 *
 * ── Why this is not orpheus-models.ts with the names changed ────────────────
 *
 * `orpheus-models.ts` is two things at once: a FILESYSTEM SCANNER (it walks the
 * models dir, classifies folders as merged voices / adapters / a shared base,
 * reconciles what it finds against a per-machine `models.json`) and a TUNING
 * OVERLAY (the repo catalog that owns render behaviour). It has to be, because
 * an Orpheus voice is discovered by dropping a folder somewhere.
 *
 * A Higgs voice is not discovered. It is either the served model's own zero-shot
 * voice — which needs nothing on disk at all — or an artifact this repo's catalog
 * names explicitly. So there is no scanner half here, no runtime manifest, and no
 * reconcile fallback: `electron/data/higgs-models.json` is the whole roster, and a
 * voice that is not in it is REFUSED BY NAME. That refusal is the same one
 * `pushVoiceArgs` applies to an unresolvable non-stock Orpheus voice and exists for
 * the same measured reason: a served TTS stack asked for a voice it does not have
 * does not error, it renders the ENTIRE book in its default voice, and on Higgs v3
 * that default is a genuinely different speaker (ECAPA cosine 0.093 against the
 * narrator, 12% of his own ceiling). A fallback here is an hour of audio in the
 * wrong voice with a console warning nobody read.
 *
 * ── What the caller gets ────────────────────────────────────────────────────
 *
 * `resolveHiggsModel(id)` — the catalog entry, or a throw naming the id.
 * `higgsVoiceCapsForModel(model)` — the measured knobs, absent-means-absent.
 * `higgsSpawnEnv(model)` — the HIGGS_* environment the narrator backend reads.
 *
 * ── The HIGGS_* environment is a CONTRACT WITH NARRATOR, and BookForge defined
 *    it first ────────────────────────────────────────────────────────────────
 *
 * `python/narrator/engine/higgs/v3_served.py` (registry id `higgs-v3`) had not
 * landed on `feat/narrator` when this was written — the branch has
 * `engine/orpheus/**` and the plan documents, and no `engine/higgs` directory at
 * all. Rather than guess at names that do not exist yet, the names below are
 * DECLARED HERE, deliberately mirroring the ORPHEUS_* set the narrator side
 * already reads (`ORPHEUS_MAX_CHARS`, `ORPHEUS_TEMPERATURE`, `ORPHEUS_TOP_P`,
 * `ORPHEUS_GPU_MEM_UTIL` …) so the two halves of one program spell the same idea
 * the same way. If narrator's backend lands with different names, THIS FILE
 * changes and the catalog data does not — which is the point of putting the
 * mapping in one function. See docs/HIGGS_ENGINE.md, "Open contracts".
 */

import * as path from 'path';
import * as fs from 'fs';

/**
 * Which artifact form conditions the voice.
 *
 * `adapter` — a LoRA adapter dir or a merged checkpoint dir, WSL-native. The
 *   voice lives in the weights and the prompt is TEXT-ONLY (no reference clip).
 * `clips` — zero-shot cloning: the reference audio travels in the request. An
 *   EMPTY clips array is not a degenerate case, it is the served model's own
 *   default voice: the request carries no `references` field, which is exactly
 *   the condition the levers document measures as "no reference".
 */
export type HiggsVoiceKind = 'adapter' | 'clips';

/** One reference clip. The transcript is REQUIRED — see `refuseUntranscribedClips`. */
export interface HiggsReferenceClip {
  /** WSL-native path to the wav. */
  path: string;
  /**
   * What is actually said in the clip, BOOK-EXACT.
   *
   * The training-text doctrine ("epub book-truth, NEVER bare ASR") applies to a
   * reference transcript for the same reason it applies to a training corpus:
   * vllm-omni frames the clone prompt as `<|ref_text|> {transcript} <|ref_audio|>`,
   * so a transcript that disagrees with the audio teaches the model that those
   * words sound like that, and the error lands in every sentence it conditions.
   */
  transcript: string;
}

export type HiggsVoiceRef =
  | { kind: 'adapter'; path: string }
  | { kind: 'clips'; clips: HiggsReferenceClip[] };

/**
 * The measured knobs a Higgs voice declares for the SERVED backend.
 *
 * Absent means absent — there is no invented default here, exactly as
 * `OrpheusVoiceCaps` documents. The one difference in spirit: on Orpheus an
 * absent cap means "let e2a apply its own documented default", while here an
 * absent cap means "the served stack's own shipped default applies", and both
 * are real answers rather than a fallback.
 */
export interface HiggsServedCaps {
  /** PREP packing cap in chars (→ HIGGS_MAX_CHARS). MEASURED per fine-tune. */
  maxChars?: number;
  /**
   * Assembly-time fades on every chunk. Higgs emits no pads of its own, so the
   * decoded chunk ends at a hard sample boundary and joins click without these.
   */
  edgeFadeMs?: { in: number; out: number };
  /** Sampling, sent inside `extra_params` — NEVER at the request top level. */
  sampling?: { temperature?: number; topP?: number; topK?: number };
  /** Hard server limit on total reference audio, in seconds. */
  referenceSecondsCap?: number;
  /**
   * Inline control tokens this voice may be sent, as an ALLOWLIST.
   *
   * Empty means none, and that is a safety rule: a control token outside
   * `get_added_vocab()` is read aloud as words and derails generation into a
   * degenerate loop (ASR coverage 0.000). An empty allowlist means no engine
   * ever has to get the validation right.
   */
  allowedControls?: string[];
}

/** The serving stack a model's `engineVersion` selects. */
export interface HiggsServingSpec {
  engineVersion: string;
  model: string;
  env: string;
  condaEnvName: string;
  launchScript: string;
  servedModelName: string;
  host: string;
  port: number;
  endpoint: string;
  gpuMemoryUtilization: number;
  maxModelLen: number;
  maxNumSeqs: number;
  attentionBackend: string;
  coldStartSeconds: number;
  patches: HiggsPatchSpec[];
}

/**
 * A site-packages patch the serving stack does not work without.
 *
 * `marker` is what the doctor greps for in `target` to decide whether the patch
 * is applied — a string the patch introduces and the pristine file cannot
 * contain. Both patches must be RE-APPLIED after any pip upgrade in the env,
 * which is why the doctor reports them by name rather than lumping them into
 * one "env looks wrong".
 */
export interface HiggsPatchSpec {
  id: string;
  script: string;
  target: string;
  marker: string;
  why: string;
}

export interface HiggsModel {
  id: string;
  label: string;
  engineVersion: string;
  voice: HiggsVoiceRef;
  license: string;
  commercialUse: boolean;
  sampleRate: number;
  addedAt: string;
  backends?: { served?: HiggsServedCaps };
  /** Present ⇒ the voice's artifact is not installed yet and it is REFUSED. */
  _pendingNote?: string;
  note?: string;
  /** A model may declare its own serving block, used INSTEAD of the shared one. */
  serving?: HiggsServingSpec;
}

interface HiggsCatalog {
  version: number;
  engine: string;
  serving: HiggsServingSpec;
  models: HiggsModel[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read the catalog fresh.
 *
 * The file ships next to this module in the dist build (`build:electron` copies
 * `electron/data`), so it resolves off `__dirname` the way the Orpheus catalog
 * and the prompts data do. It is a LOCAL repo file — never a `\\wsl$` path — so
 * unlike a runtime manifest it reads even when the WSL VM is wedged, and none of
 * the main-thread-blocking precautions `orpheus-models.ts` needs apply here.
 *
 * A missing or malformed catalog is a PACKAGING BUG and fails loud. There is no
 * inline default to fall back to, and inventing one would mean a build that
 * shipped without its data still offered voices.
 *
 * Read on every call (the file is a few KB) so editing tuning and re-running
 * takes effect without an app restart — the same rule the Orpheus catalog has.
 */
function loadCatalog(): HiggsCatalog {
  const dataPath = path.join(__dirname, 'data', 'higgs-models.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  } catch (err) {
    throw new Error(
      `Failed to load the Higgs voice catalog from ${dataPath}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const cat = parsed as Partial<HiggsCatalog> | null;
  if (!cat || !Array.isArray(cat.models)) {
    throw new Error(`Higgs voice catalog is malformed (expected {models:[...]}): ${dataPath}`);
  }
  if (!cat.serving || typeof cat.serving !== 'object') {
    throw new Error(`Higgs voice catalog is malformed (missing the shared 'serving' block): ${dataPath}`);
  }
  return cat as HiggsCatalog;
}

/**
 * Every voice in the catalog, offerable or not.
 *
 * `listHiggsModels()` is what a PICKER reads, so it includes a voice whose
 * artifact has not landed — the alternative is a dropdown that silently omits
 * the voice everyone is waiting for, with nothing anywhere saying why. What it
 * does NOT do is let that voice render: `resolveHiggsModel` refuses it by name.
 * Offering-and-refusing is the honest pair; hiding-and-forgetting is not.
 */
export function listHiggsModels(): HiggsModel[] {
  return loadCatalog().models;
}

/** The voices that can actually render today — the pending ones removed. */
export function listRenderableHiggsModels(): HiggsModel[] {
  return listHiggsModels().filter((m) => !m._pendingNote);
}

/** True when this id names a catalog voice at all (pending included). */
export function isHiggsVoice(id: string): boolean {
  return listHiggsModels().some((m) => m.id === id);
}

/**
 * The catalog entry for `id`, or a throw that names it.
 *
 * THREE REFUSALS, each of which would otherwise be an hour of audio in the wrong
 * voice:
 *
 *  1. Unknown id — the served stack would answer in its default voice.
 *  2. A voice carrying `_pendingNote` — its artifact is not installed, so the
 *     server would load nothing and, again, answer in its default voice.
 *  3. A `clips` voice with an untranscribed clip — see the transcript field.
 */
export function resolveHiggsModel(id: string | undefined | null): HiggsModel {
  const requested = (id || '').trim();
  if (!requested) {
    throw new Error('No Higgs voice was selected — refusing to render in the served default voice.');
  }
  const models = listHiggsModels();
  const model = models.find((m) => m.id === requested);
  if (!model) {
    throw new Error(
      `Higgs voice "${requested}" is not in the catalog. ` +
        `Known voices: ${models.map((m) => m.id).join(', ') || '(none)'}. ` +
        `Refusing to render — an unknown voice serves the model's own default speaker, ` +
        `which is a different narrator, not a weak clone.`,
    );
  }
  if (model._pendingNote) {
    throw new Error(
      `Higgs voice "${model.id}" is not installed yet: ${model._pendingNote.split('.')[0]}. ` +
        `Refusing to render — see electron/data/higgs-models.json for what it is waiting on.`,
    );
  }
  refuseUntranscribedClips(model);
  return model;
}

/**
 * A reference clip without a transcript is refused, loudly.
 *
 * vllm-omni frames the clone prompt as `<|ref_text|> {transcript} <|ref_audio|>`.
 * Sending an empty `<|ref_text|>` does not disable conditioning; it asserts that
 * this audio is silence, and the mismatch lands in every sentence the reference
 * conditions. The training-text doctrine's reason for refusing bare ASR in a
 * corpus is the same reason for refusing a blank transcript here.
 */
function refuseUntranscribedClips(model: HiggsModel): void {
  if (model.voice.kind !== 'clips') return;
  const bad = model.voice.clips.filter((c) => !c.transcript || !c.transcript.trim());
  if (bad.length === 0) return;
  throw new Error(
    `Higgs voice "${model.id}" has ${bad.length} reference clip(s) with no transcript ` +
      `(${bad.map((c) => path.basename(c.path)).join(', ')}). ` +
      `A reference clip must carry its BOOK-EXACT text — refusing to send it untranscribed.`,
  );
}

/** The serving stack this model runs on: its own block, else the shared one. */
export function higgsServingFor(model: HiggsModel): HiggsServingSpec {
  if (model.serving) return model.serving;
  const shared = loadCatalog().serving;
  if (shared.engineVersion !== model.engineVersion) {
    throw new Error(
      `Higgs voice "${model.id}" declares engineVersion "${model.engineVersion}" but the catalog's ` +
        `shared serving block is for "${shared.engineVersion}", and the voice declares no serving block ` +
        `of its own. Refusing to serve it on the wrong stack.`,
    );
  }
  return shared;
}

/** The shared serving stack, for callers that have no model in hand (the doctor). */
export function higgsServingSpec(): HiggsServingSpec {
  return loadCatalog().serving;
}

// ─────────────────────────────────────────────────────────────────────────────
// Caps and the spawn environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The measured knobs for the backend that will actually render.
 *
 * `served` is the only Higgs backend BookForge has — v3 runs behind vllm-omni,
 * and v2 (the transformers/in-process one) was dropped on 2026-09-04. The
 * per-backend shape is kept anyway, exactly as `orpheusVoiceCapsForModel` has a
 * vllm/mlx split, so adding a second backend does not mean re-shaping the data
 * for every voice at once.
 *
 * Absent fields stay absent. A caller can tell "this voice declares nothing"
 * from "this voice declares 600".
 */
export function higgsVoiceCapsForModel(model: HiggsModel): HiggsServedCaps {
  const served = model.backends?.served;
  if (!served) return {};
  const caps: HiggsServedCaps = {};
  if (served.maxChars !== undefined) caps.maxChars = served.maxChars;
  if (served.edgeFadeMs !== undefined) caps.edgeFadeMs = served.edgeFadeMs;
  if (served.sampling !== undefined) caps.sampling = served.sampling;
  if (served.referenceSecondsCap !== undefined) caps.referenceSecondsCap = served.referenceSecondsCap;
  if (served.allowedControls !== undefined) caps.allowedControls = served.allowedControls;
  return caps;
}

/**
 * The HIGGS_* environment a narrator spawn is handed for this voice.
 *
 * Every value is a string because that is what a spawn env is; a number that did
 * not survive the round trip would be a silent zero on the other side.
 *
 * `HIGGS_REF_CLIPS` carries the clips array as JSON rather than as parallel
 * `HIGGS_REF_PATH_1` / `HIGGS_REF_TEXT_1` variables: a transcript is prose, it
 * contains quotes and punctuation, and pairing it with its path positionally
 * across two env vars is exactly the sort of off-by-one that renders a book in a
 * plausible-sounding wrong voice. One JSON value cannot come apart. It is emitted
 * ONLY for a clips voice with at least one clip — an empty array would be
 * indistinguishable from "the caller forgot", and the server's default voice is
 * requested by sending no `references` field at all.
 */
export function higgsSpawnEnv(model: HiggsModel): Record<string, string> {
  const serving = higgsServingFor(model);
  const caps = higgsVoiceCapsForModel(model);
  const env: Record<string, string> = {
    HIGGS_ENGINE_VERSION: model.engineVersion,
    HIGGS_VOICE: model.id,
    HIGGS_VOICE_KIND: model.voice.kind,
    HIGGS_SERVED_URL: `http://${serving.host}:${serving.port}`,
    HIGGS_SERVED_ENDPOINT: serving.endpoint,
    HIGGS_SERVED_MODEL: serving.servedModelName,
    HIGGS_GPU_MEM_UTIL: String(serving.gpuMemoryUtilization),
    HIGGS_MAX_MODEL_LEN: String(serving.maxModelLen),
    HIGGS_COLD_START_SECONDS: String(serving.coldStartSeconds),
    HIGGS_SAMPLE_RATE: String(model.sampleRate),
  };

  if (model.voice.kind === 'adapter') {
    env.HIGGS_ADAPTER_DIR = model.voice.path;
  } else if (model.voice.clips.length > 0) {
    env.HIGGS_REF_CLIPS = JSON.stringify(model.voice.clips);
  }

  if (caps.maxChars !== undefined) env.HIGGS_MAX_CHARS = String(caps.maxChars);
  if (caps.edgeFadeMs !== undefined) {
    env.HIGGS_EDGE_FADE_IN_MS = String(caps.edgeFadeMs.in);
    env.HIGGS_EDGE_FADE_OUT_MS = String(caps.edgeFadeMs.out);
  }
  if (caps.sampling?.temperature !== undefined) env.HIGGS_TEMPERATURE = String(caps.sampling.temperature);
  if (caps.sampling?.topP !== undefined) env.HIGGS_TOP_P = String(caps.sampling.topP);
  if (caps.sampling?.topK !== undefined) env.HIGGS_TOP_K = String(caps.sampling.topK);
  if (caps.referenceSecondsCap !== undefined) {
    env.HIGGS_REFERENCE_SECONDS_CAP = String(caps.referenceSecondsCap);
  }
  // Always emitted, empty included: an empty allowlist is a real instruction
  // ("send no control tokens"), and an absent variable would read as "no rule".
  if (caps.allowedControls !== undefined) {
    env.HIGGS_ALLOWED_CONTROLS = caps.allowedControls.join(',');
  }
  return env;
}

/**
 * The narration picker's view of the catalog: `{value,label}` rows, with a
 * voice that cannot render yet marked in its LABEL rather than dropped.
 *
 * Mirrors `mergeOrpheusVoices`' output shape so the modal's dropdown code is the
 * same for both engines.
 */
export function higgsNarrationVoices(): { value: string; label: string }[] {
  return listHiggsModels().map((m) => ({
    value: m.id,
    label: m._pendingNote ? `${m.label} — not installed yet` : m.label,
  }));
}
