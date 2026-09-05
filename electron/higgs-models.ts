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
 * `higgsVoicesDocument(model)` — narrator's voice document, as JSON.
 * `higgsSpawnEnv(model, opts)` — the NARRATOR_* environment its backend reads.
 *
 * ── The environment is NARRATOR'S contract, and this file was corrected to it ─
 *
 * An earlier draft of this module invented a `HIGGS_*` variable set, because
 * `engine/higgs/v3_served.py` had not landed on `feat/narrator` yet and guessing
 * at names that mirrored `ORPHEUS_*` seemed better than guessing at nothing. It
 * has landed, it uses different names, and THOSE ARE THE NAMES — every invented
 * one is gone:
 *
 *   NARRATOR_HIGGS_VOICES            a PATH to a JSON voice document
 *   NARRATOR_HIGGS3_URL              attach to an already-running server
 *   NARRATOR_HIGGS3_SERVE_SCRIPT     the launch script, when narrator must start one
 *   NARRATOR_HIGGS3_ADAPTER_STRATEGY 'lora-modules' | 'merged-dir'
 *   NARRATOR_HIGGS3_WSL_DISTRO       the distro to launch in, on Windows
 *
 * The caps do NOT travel as environment variables at all. narrator's
 * `higgs_v3_config_from_worker_kwargs` REFUSES a `caps` payload by name — those
 * are Orpheus's knobs (eosBoost, eosFloor, maxCharsPerSec) and v3 implements
 * none of them, so accepting them would suggest they applied. What Higgs's caps
 * are actually for is BookForge's own two jobs: sizing the prep packer
 * (`maxChars`) and assembling (`edgeFadeMs`). They stay on this side.
 *
 * ── A voice is CLIPS, and clips come from a file ────────────────────────────
 *
 * Orpheus's voice is a token that rides in the prompt, so its whole
 * configuration is a string on a command line. A Higgs voice is reference clips
 * WITH BOOK-EXACT TRANSCRIPTS — too much for a command line, and not something
 * to guess at — so narrator reads a JSON document and the command line carries
 * only `--higgs_voice <id>`, an index into it. `higgsVoicesDocument()` builds
 * that document from this catalog.
 */

import * as os from 'os';
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
/**
 * Which of BookForge's TWO RULE SETS a voice falls under.
 *
 * NOT a wire-format distinction. In narrator's voice document a Higgs voice is
 * ALWAYS clips, and a fine-tune is an `adapterDir` riding on that same object —
 * there is no adapter kind on that side. This discriminator exists because the
 * two kinds have genuinely different REQUIREMENTS here:
 *
 *   'clips'    zero-shot. May carry the engine's measured placeholder cap (600).
 *   'adapter'  a fine-tune. `maxChars` is REQUIRED and must come from THIS
 *              model's own length sweep — see `refuseUnmeasuredAdapter`.
 *
 * and because a picker has to be able to tell a person which one they are
 * choosing. `higgsVoicesDocument()` translates to narrator's shape; that is the
 * only place the two meet.
 */
export type HiggsVoiceKind = 'adapter' | 'clips';

/**
 * One reference clip, in narrator's document spelling.
 *
 * ONE PER VOICE, AT MOST. vllm-omni refuses multi-shot cloning, so "two clips"
 * means one PRE-JOINED wav (0.35 s of silence between them) with the transcripts
 * joined in the same order. The joining happens when a voice is staged, never at
 * render time, and this catalog stores the joined result.
 */
export interface HiggsReferenceClip {
  /** WSL-native path to the wav. */
  path: string;
  /**
   * What is actually said in the clip, BOOK-EXACT.
   *
   * The training-text doctrine ("epub book-truth, NEVER bare ASR") applies here
   * for the same reason it applies to a corpus: vllm-omni frames the clone
   * prompt as `<|ref_text|> {transcript} <|ref_audio|>`, so a transcript that
   * disagrees with the audio teaches the model that those words sound like that,
   * and the error lands in every sentence it conditions.
   */
  transcript: string;
  /**
   * The clip's duration, DECLARED.
   *
   * Required, and not because it is hard to measure — because narrator's
   * `v3_served.reference_seconds` refuses a clip that does not carry one rather
   * than opening the file. A missing duration is therefore not a warning: it is
   * a render that dies AFTER the server has spent five minutes coming up.
   */
  seconds: number;
}

/**
 * A Higgs voice, in narrator's document spelling.
 *
 * One shape, not a union — `adapterDir` is what makes a voice a fine-tune, and
 * it sits ON the clips object. An adapter voice with an empty `clips` array is
 * the normal case: the voice is in the weights and the prompt is text-only.
 */
export interface HiggsVoiceRef {
  clips: HiggsReferenceClip[];
  /** A fine-tune. Its serving strategy is a WHOLE-SERVER concern — see below. */
  adapterDir?: string;
  /** v2-only chat role. Present for shape parity; v3 has no scene mechanism. */
  scene?: string;
}

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
  /**
   * The PREP packing cap, in characters. Consumed by BookForge, never sent to
   * narrator (see the header on why caps do not travel).
   *
   * `null` is a DECLARED ABSENCE — "this voice needs a measured cap and does not
   * have one yet" — and it is the reason this is `number | null | undefined`
   * rather than an optional number. `undefined` says the voice declares nothing
   * (fine for a zero-shot voice); `null` says it declares that it is UNMEASURED,
   * which for an adapter is a refusal. See `refuseUnmeasuredAdapter`.
   */
  maxChars?: number | null;
  /**
   * WHERE `maxChars` came from. Provenance, in the style the Orpheus catalog
   * carries its `_eosFloorNote`.
   *
   * Required alongside a real `maxChars` on an adapter voice, because the number
   * is only meaningful with its method: a length sweep verified by ASR alignment
   * is evidence, and a duration ratio is not — a v3 render measured ratio 0.99
   * while dropping 22 % of its text.
   */
  maxCharsSource?: string | null;
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
  /** Which of BookForge's rule sets applies. See HiggsVoiceKind. */
  kind: HiggsVoiceKind;
  engineVersion: string;
  voice: HiggsVoiceRef;
  license: string;
  commercialUse: boolean;
  sampleRate: number;
  addedAt: string;
  backends?: { served?: HiggsServedCaps };
  /**
   * How a fine-tune is served: 'lora-modules' or 'merged-dir'.
   *
   * ABSENT UNTIL SOMEONE HAS ACTUALLY LOADED ONE. How vllm-omni takes a LoRA for
   * `higgs_multimodal_qwen3` has never been exercised — the deathstalker
   * fine-tune was rendered through the trainer's own `generate_audio`, never
   * through the served stack — and BOTH strategies require a server restart, so
   * there is no cheap way to find out at run time. narrator refuses an unknown
   * strategy rather than guessing, and the reason is worth repeating: the wrong
   * one is a server that comes up serving the BASE voice and renders an entire
   * book in it while reporting success.
   */
  adapterStrategy?: 'lora-modules' | 'merged-dir';
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
  refuseUnmeasuredAdapter(model);
  refuseOversizedReference(model);
  return model;
}

/**
 * A reference clip without a transcript, or without a declared duration, is
 * refused — loudly, and naming the file.
 *
 * TRANSCRIPT. vllm-omni frames the clone prompt as
 * `<|ref_text|> {transcript} <|ref_audio|>`. Sending an empty `<|ref_text|>` does
 * not disable conditioning; it asserts that this audio is silence, and the
 * mismatch lands in every sentence the reference conditions. The training-text
 * doctrine's reason for refusing bare ASR in a corpus is this reason.
 *
 * SECONDS. narrator's `v3_served.reference_seconds` refuses a clip that does not
 * declare one rather than opening the file to find out. So a missing duration is
 * not a cheap warning — it is a render that dies AFTER the server has already
 * spent five minutes coming up.
 */
function refuseUntranscribedClips(model: HiggsModel): void {
  const bad = model.voice.clips.filter((c) => !c.transcript || !c.transcript.trim());
  if (bad.length > 0) {
    throw new Error(
      `Higgs voice "${model.id}" has ${bad.length} reference clip(s) with no transcript ` +
        `(${bad.map((c) => path.basename(c.path)).join(', ')}). ` +
        `A reference clip must carry its BOOK-EXACT text — refusing to send it untranscribed.`,
    );
  }
  const unmeasured = model.voice.clips.filter(
    (c) => typeof c.seconds !== 'number' || !(c.seconds > 0),
  );
  if (unmeasured.length > 0) {
    throw new Error(
      `Higgs voice "${model.id}" has ${unmeasured.length} reference clip(s) with no declared ` +
        `duration (${unmeasured.map((c) => path.basename(c.path)).join(', ')}). narrator ` +
        `refuses a clip without \`seconds\` rather than probing the file, so this would fail ` +
        `only after the server had already spent ~5 minutes starting.`,
    );
  }
}

/**
 * ONE reference clip, and no more than the server's 30-second cap.
 *
 * vllm-omni refuses multi-shot cloning outright, so a catalog entry with two
 * clips is not "slightly wrong" — it is a request the server rejects. The
 * supported way to use two recordings is ONE pre-joined wav (0.35 s of silence
 * between them) with the transcripts joined in the same order, produced when the
 * voice is STAGED. Saying that here beats letting an HTTP 400 say it five
 * minutes later.
 *
 * The 30 s cap is the server's own (42 s returns HTTP 400 "Reference audio too
 * long"), and the declared `seconds` are what make it checkable before launch.
 */
function refuseOversizedReference(model: HiggsModel): void {
  const clips = model.voice.clips;
  if (clips.length > 1) {
    throw new Error(
      `Higgs voice "${model.id}" declares ${clips.length} reference clips. vllm-omni accepts ` +
        `EXACTLY ONE — join them into a single wav (0.35 s of silence between) with the ` +
        `transcripts joined in the same order, and declare that one clip.`,
    );
  }
  const cap = higgsVoiceCapsForModel(model).referenceSecondsCap;
  if (cap === undefined || clips.length === 0) return;
  const total = clips.reduce((sum, c) => sum + c.seconds, 0);
  if (total > cap) {
    throw new Error(
      `Higgs voice "${model.id}" declares ${total.toFixed(1)} s of reference audio, over the ` +
        `server's ${cap} s cap — it would return HTTP 400 "Reference audio too long".`,
    );
  }
}

/**
 * A FINE-TUNE MUST CARRY ITS OWN MEASURED `maxChars`. No default, and nothing
 * inherited from the zero-shot figure.
 *
 * This is not tidiness. A fine-tuned Higgs adapter's stop length tracks its
 * TRAINING CLIP LENGTH rather than the length of the text it is given: the
 * training side measured a 30-minute adapter trained on 8-22 s clips stopping
 * after ~6-10 s of audio on ANY prompt over ~150 characters. So the zero-shot
 * 600 is not merely imprecise for an adapter — it is wrong by roughly a factor
 * of four, in the direction that LOSES TEXT, and it loses it while every
 * duration check still looks plausible.
 *
 * Hence: the cap comes from THAT model's own length sweep, and `maxCharsSource`
 * is required beside it, because the number without its method is not evidence.
 * A duration ratio in particular is not a coverage proxy on this family — a v3
 * render measured ratio 0.99 while dropping 22 % of its text.
 */
function refuseUnmeasuredAdapter(model: HiggsModel): void {
  if (model.kind !== 'adapter') return;
  const caps = higgsVoiceCapsForModel(model);
  if (typeof caps.maxChars === 'number' && caps.maxChars > 0 && caps.maxCharsSource) return;
  throw new Error(
    `Higgs fine-tune "${model.id}" has no MEASURED maxChars (got ` +
      `${JSON.stringify(caps.maxChars ?? null)}, source ${JSON.stringify(caps.maxCharsSource ?? null)}). ` +
      `An adapter's stop length follows its TRAINING CLIP LENGTH, not the text — one trained ` +
      `on 8-22 s clips stops after ~6-10 s on any prompt over ~150 chars — so the zero-shot ` +
      `600 would silently lose most of every chunk. Run a length sweep on this model, verify ` +
      `it by ASR alignment (never by duration ratio), and record the number with its ` +
      `maxCharsSource in electron/data/higgs-models.json.`,
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
  if (served.maxCharsSource !== undefined) caps.maxCharsSource = served.maxCharsSource;
  if (served.edgeFadeMs !== undefined) caps.edgeFadeMs = served.edgeFadeMs;
  if (served.sampling !== undefined) caps.sampling = served.sampling;
  if (served.referenceSecondsCap !== undefined) caps.referenceSecondsCap = served.referenceSecondsCap;
  if (served.allowedControls !== undefined) caps.allowedControls = served.allowedControls;
  return caps;
}

/**
 * narrator's VOICE DOCUMENT for this voice — the JSON its
 * `engine/higgs/config.py:load_voices` reads.
 *
 * ONE VOICE PER DOCUMENT, deliberately. The format holds a map, and it would be
 * easy to write the whole catalog into it and let `--higgs_voice` pick. That
 * would also mean every render carries every other voice's clip paths, and
 * `load_voices` VALIDATES ALL OF THEM — `os.path.isfile` on each clip — so one
 * voice whose reference has been moved would fail every OTHER voice's render
 * with an error naming a file the user did not ask for. A document of one cannot
 * do that.
 *
 * A voice with no clips (the served default, or a text-only fine-tune) is a
 * legitimate entry with an empty array; narrator's loader requires the `clips`
 * KEY, not a non-empty list.
 */
export function higgsVoicesDocument(model: HiggsModel): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    clips: model.voice.clips.map((c) => ({
      path: c.path,
      transcript: c.transcript,
      seconds: c.seconds,
    })),
  };
  if (model.voice.adapterDir) entry.adapterDir = model.voice.adapterDir;
  if (model.voice.scene) entry.scene = model.voice.scene;
  const caps = higgsVoiceCapsForModel(model);
  if (caps.allowedControls !== undefined) entry.allowedControls = caps.allowedControls;
  if (caps.referenceSecondsCap !== undefined) entry.maxReferenceSeconds = caps.referenceSecondsCap;
  return { [model.id]: entry };
}

/**
 * Write the voice document somewhere a spawn can name, and return that path.
 *
 * A FILE RATHER THAN AN ENVIRONMENT VALUE because that is what narrator reads:
 * `NARRATOR_HIGGS_VOICES` is a PATH. It is also the right shape independently —
 * a transcript is prose with quotes and newlines in it, and a JSON blob of them
 * inside an exported shell variable is one quoting bug away from a voice that
 * loads with the wrong text.
 *
 * Written per job, under the OS temp dir, named for the voice so a post-mortem
 * can tell which render it belonged to.
 */
export function writeHiggsVoicesDocument(model: HiggsModel, jobId: string): string {
  const dir = path.join(os.tmpdir(), 'bookforge-higgs-voices');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobId}-${model.id}.json`);
  fs.writeFileSync(file, JSON.stringify(higgsVoicesDocument(model), null, 2), 'utf-8');
  return file;
}

/**
 * The environment a narrator Higgs spawn is handed.
 *
 * EVERY NAME HERE IS NARRATOR'S. An earlier draft invented a `HIGGS_*` set
 * because the backend had not landed; it has, and these are the names it reads
 * (`engine/higgs/v3_served.py`, `engine/higgs/config.py`). The measured CAPS are
 * deliberately NOT here: narrator's `higgs_v3_config_from_worker_kwargs` refuses
 * a `caps` payload by name, because those are Orpheus's knobs and v3 implements
 * none of them. Higgs's caps are BookForge's own business — sizing the prep
 * packer and fading at assembly — and they stay on this side.
 *
 * `voicesPath` is passed in rather than computed here so the caller can hand
 * over a path in the filesystem the SPAWN will see: a WSL-native `/mnt/c/...`
 * for a WSL spawn, the Windows path for a native one. Computing it here would
 * mean this module deciding where a process it does not spawn is going to run.
 */
export function higgsSpawnEnv(
  model: HiggsModel,
  opts: {
    /** Path to the voice document, in the SPAWN's filesystem. */
    voicesPath: string;
    /** Path to the launch script, in the SPAWN's filesystem. */
    serveScriptPath?: string;
    /** Attach to an already-running server instead of launching one. */
    baseUrl?: string;
    /** The WSL distro to launch in, on Windows. */
    wslDistro?: string;
  },
): Record<string, string> {
  // Validate before we hand anything over, so a bad voice fails here rather than
  // five minutes into a server start.
  refuseUntranscribedClips(model);
  refuseOversizedReference(model);
  refuseUnmeasuredAdapter(model);

  const env: Record<string, string> = {
    NARRATOR_HIGGS_VOICES: opts.voicesPath,
  };
  if (opts.serveScriptPath) env.NARRATOR_HIGGS3_SERVE_SCRIPT = opts.serveScriptPath;
  if (opts.baseUrl) env.NARRATOR_HIGGS3_URL = opts.baseUrl;
  if (opts.wslDistro) env.NARRATOR_HIGGS3_WSL_DISTRO = opts.wslDistro;

  // The adapter strategy is only meaningful for a fine-tune, and there is NO
  // default: narrator refuses an unknown strategy rather than guessing, and it is
  // right to — the wrong one is a server that comes up serving the BASE voice and
  // renders an entire book in it while reporting success. A voice that has not
  // established its strategy is already refused by refuseUnmeasuredAdapter above,
  // so reaching here without one means the catalog gained a strategy field it did
  // not have; emitting nothing lets narrator produce that refusal.
  const strategy = model.adapterStrategy;
  if (model.voice.adapterDir && strategy) {
    env.NARRATOR_HIGGS3_ADAPTER_STRATEGY = strategy;
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
