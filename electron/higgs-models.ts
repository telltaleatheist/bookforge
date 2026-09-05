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
 * `higgsVoicesDocument(model, target)` — narrator's voice document, as JSON, with
 *   the ONE checkpoint directory belonging to the arm the spawn will take.
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
 * THE THREE SHAPES A HIGGS VOICE COMES IN.
 *
 * Not two, and the third is the one an earlier draft got wrong. It wrote
 * `clips: []` for the served model's own voice and called that "the served
 * default voice" — but narrator REFUSES a ClipsVoice with zero clips, and it is
 * right to: a zero-shot clone with no reference is not a degenerate clone, it is
 * a different thing entirely. Making them the same shape in the wire format is
 * how "render in the narrator's voice" and "render in whoever the base model is"
 * become indistinguishable.
 *
 *   'default'     the served model's built-in speaker. NO clips, no checkpoint.
 *                 Measures at 12 % of the deathstalker narrator's ECAPA ceiling
 *                 — a different person, which is why it is named not implied.
 *   'checkpoint'  a MERGED fine-tune directory, prompted TEXT-ONLY. The
 *                 production shape (see `higgsNarrationVoices`).
 *   'clips'       a zero-shot clone. AT LEAST ONE clip, at most one (vllm-omni
 *                 takes exactly one reference), each with a book-exact
 *                 transcript and a declared duration. DIAGNOSTIC ONLY — kept
 *                 because the document shape is real and worth being able to
 *                 hand narrator, never offered in the narration dropdown.
 *
 * WHY 'checkpoint' AND NOT 'adapter'. It was `adapter`/`adapterDir` until
 * 2026-09-04, which named the artifact we TRAIN rather than the artifact that
 * SERVES. vllm-omni cannot load a LoRA at runtime — `vllm-omni serve` has no
 * adapter flags and the `higgs_audio_v3` talker class does not implement
 * `SupportsLoRA` — so a LoRA is an archival input to a merge and never a thing
 * the catalog points at. What serves is a merged ~8.5 GB checkpoint directory,
 * and the server is started ON it, which is why a voice switch is a server
 * restart (~55 s warm / ~300 s cold) rather than a message.
 */
export type HiggsVoiceKind = 'default' | 'clips' | 'checkpoint';

/**
 * The kinds the narration dropdown offers.
 *
 * Owen, 2026-09-04: **production is fine-tuned voices only.** A clone is a
 * diagnostic — it recovers 92 % of the narrator's speaker identity and none of
 * his phrasing (2.01 pauses/100 chars against his 1.39; pitch std 5.17 st
 * against 4.36), which is the gap a fine-tune exists to close. Offering one in
 * the same list as a fine-tune invites picking it for a book.
 *
 * `default` stays because it is the one voice that needs nothing staged, so it
 * is what a machine auditions the serving stack with before any checkpoint
 * exists. The `clips` shape stays fully supported everywhere BELOW this line —
 * the loader validates it, the document emits it, the keeper drives narrator's
 * real loader with it — it is simply never offered.
 */
const SELECTABLE_VOICE_KINDS: ReadonlySet<HiggsVoiceKind> = new Set(['default', 'checkpoint']);

/**
 * One reference clip, in narrator's document spelling.
 *
 * ONE PER VOICE, AT MOST. vllm-omni refuses multi-shot cloning, so "two clips"
 * means one PRE-JOINED wav (0.35 s of silence between them) with the transcripts
 * joined in the same order. The joining happens when a voice is staged, never at
 * render time, and this catalog stores the joined result.
 */
export interface HiggsReferenceClip {
  /**
   * HOST-NATIVE path to the wav — the form the machine BookForge is running on
   * uses. It is translated for the guest at document-write time, per spawn arm
   * (`higgsVoicesDocument`), not stored pre-translated: a WSL-native path is
   * right on the Windows+WSL arm by accident and meaningless on macOS/Linux,
   * where there is no guest for it to be native to.
   */
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
 * WHICH MACHINE'S FILESYSTEM A CHECKPOINT DIRECTORY SITS IN.
 *
 * A `checkpoint` voice is ~8.5 GB of weights on disk, and the two Higgs arms
 * cannot see each other's disks: the served arm loads from inside the WSL guest
 * (ext4, reached by the launch script), the MLX arm loads from the Mac's own
 * filesystem, in the app's userData. So "where is deathstalker" has TWO answers
 * and neither is the other's — which is why this is a key rather than a single
 * `checkpointDir` string. See `HiggsCheckpointLocations`.
 *
 * ── Why these names and not `HiggsArm`'s ('wsl' | 'mlx' | 'none') ───────────
 *
 * `HiggsArm` in tool-paths.ts answers a DIFFERENT question — which BACKEND the
 * doctor examined — and its third member, `'none'`, is a machine on which no
 * checkpoint can be staged at all, so it could never be a key here. This type
 * names the FILESYSTEM the weights live on: `wsl` is the guest, `darwin` is the
 * Mac. The two vocabularies are 1:1 today (`wsl`↔`wsl`, `darwin`↔`mlx`) and the
 * ONE place that says so is `BACKEND_FOR_ARM` below; nothing else maps between
 * them, because a mapping in two places is a mapping that drifts.
 */
export type HiggsCheckpointArm = 'wsl' | 'darwin';

/**
 * WHERE A CHECKPOINT VOICE IS STAGED, PER ARM. A missing arm is not a gap to be
 * filled in from the other one — it means the voice IS NOT LOADABLE THERE, and
 * `higgsCheckpointDirFor` refuses it by name.
 *
 * THE TWO ENTRIES ARE SHAPED DIFFERENTLY, on purpose:
 *
 *   `wsl`     an ABSOLUTE GUEST PATH (`/home/telltale/higgs_v3_merged/…`). It is
 *             what the launch script receives, the guest has a fixed home, and
 *             the directory is deliberately NOT under /mnt — the 9p mount would
 *             dominate an 8.5 GB load. Refused if it is relative.
 *   `darwin`  a path RELATIVE TO THE APP'S userData DIRECTORY
 *             (`runtime/higgs-models/<dir>`), resolved to an absolute path at
 *             document-write time. A Mac's Application Support path carries the
 *             username, so an absolute `/Users/telltale/…` in a REPO-TRACKED
 *             catalog is a directory that exists on exactly one machine — which
 *             is the failure this catalog exists to prevent. The app knows its
 *             own userData; the catalog does not. Refused if it is absolute, and
 *             refused if it climbs out with `..`.
 *
 * AND A COPY IS A NEW CERTIFICATE. The same merged directory on both machines is
 * the same weights, but a cap is measured against (directory, backend), so
 * staging deathstalker on the Mac does not carry the served arm's number across
 * — see `backends` and `refuseUnmeasuredAdapter`.
 */
export interface HiggsCheckpointLocations {
  /** The WSL guest's own absolute path. */
  wsl?: string;
  /** Relative to the app's userData directory. */
  darwin?: string;
}

/**
 * A Higgs voice, as the catalog stores it. Which fields are legal is decided by
 * the entry's `kind` — see `refuseMalformedVoice`.
 */
export interface HiggsVoiceRef {
  /** kind 'clips' only: exactly one, with a transcript and a duration. */
  clips?: HiggsReferenceClip[];
  /**
   * kind 'checkpoint' only: the MERGED fine-tune directory (~8.5 GB) the server
   * is started on / the MLX backend loads, NAMED ONCE PER ARM.
   *
   * It replaced a single `checkpointDir` string on 2026-09-05 (see
   * `refuseRetiredCheckpointDir`): one string can only be one machine's path,
   * and it was the WSL guest's, so the Mac's voice document carried a
   * `/home/telltale/…` directory that does not exist there.
   */
  checkpoint?: HiggsCheckpointLocations;
  /** v2-only chat role. Present for shape parity; v3 has no scene mechanism. */
  scene?: string;
}

/**
 * The measured knobs a Higgs voice declares for ONE BACKEND.
 *
 * Absent means absent — there is no invented default here, exactly as
 * `OrpheusVoiceCaps` documents. The one difference in spirit: on Orpheus an
 * absent cap means "let e2a apply its own documented default", while here an
 * absent cap means "that backend's own shipped default applies", and both are
 * real answers rather than a fallback.
 *
 * ── A CERTIFICATE IS PER (DIRECTORY, BACKEND) ───────────────────────────────
 *
 * There is one of these per backend and they do NOT share numbers, because a cap
 * is produced by RENDERING: the served figure was measured by driving vllm-omni
 * on one merged directory with one patched stage processor, and the MLX arm is a
 * different sampler over a different runtime — mlx-audio's top-k/top-p and
 * vLLM's are different implementations, so feeding both the same three numbers
 * makes the CONFIGURATION identical and not the draws (PORT_NOTES 13.11).
 * Nothing has yet compared a Mac render against a WSL one at all, and their seeds
 * are not even comparable (`mx.random.seed` vs vLLM's).
 *
 * So copying the merged directory to the Mac copies the weights and NOT the
 * certificate. Until the MLX arm's own length sweep runs, `mlx.maxChars` is
 * `null` — a DECLARED absence — and `refuseUnmeasuredAdapter` refuses the voice
 * on darwin exactly as the served `null` refuses it on WSL.
 */
export interface HiggsBackendCaps {
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
  /**
   * A string the PATCHED file must NOT contain — the other half of the proof.
   *
   * A marker alone answers "did somebody apply something here". For the
   * sentinel filter that is not enough, because the retired `patch_tail_trim.py`
   * wrote one of the same helpers; what has to be true is that upstream's
   * ONE-FRAME TRIM is gone. `[:, :-1]` occurs twice in the pristine stage
   * processor and zero times after the filter patch (measured on the certifying
   * box, vllm-omni 0.28.0, 2026-09-05), so marker-present plus this-absent is
   * exactly "the token-identity filter is in and no trim code remains" — the
   * half of the patch's proof that can be checked without rendering anything.
   */
  absentMarker?: string;
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
  /**
   * THE MEASURED KNOBS, PER BACKEND — `served` is vllm-omni behind WSL, `mlx` is
   * the in-process mlx-audio sampler on the Mac. See `HiggsBackendCaps`: they do
   * not share numbers, because a cap is measured by rendering and the two arms
   * render through different samplers. The loader picks the block by ARM.
   */
  backends?: { served?: HiggsBackendCaps; mlx?: HiggsBackendCaps };
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

/**
 * THIS MACHINE'S CHECKPOINT ARM, or `null` where Higgs has no backend at all.
 *
 * A PLATFORM QUESTION, NOT AN INSTALLATION ONE. On Windows the only Higgs arm
 * that exists is the WSL guest — with the "WSL2 for Higgs" toggle off there is
 * no NATIVE arm to fall back to, there is simply no working environment, which
 * `higgsDoctor()` reports as its own row. So this says where a checkpoint WOULD
 * be read from on this machine, and the doctor says whether it can be read.
 *
 * `null` on Linux and everywhere else: vLLM-Omni installs natively there in
 * principle and BookForge has never built or measured it, so there is no
 * filesystem to name.
 */
export function higgsCheckpointArm(): HiggsCheckpointArm | null {
  if (process.platform === 'win32') return 'wsl';
  if (process.platform === 'darwin') return 'darwin';
  return null;
}

/** The arm, or a throw that names the platform. Used where absence is fatal. */
function thisMachineArm(): HiggsCheckpointArm {
  const arm = higgsCheckpointArm();
  if (arm) return arm;
  throw new Error(
    `Higgs has no backend on ${process.platform}. It ships two — a vLLM-Omni server ` +
      'reached through WSL on Windows, and an in-process mlx-audio backend on macOS — ' +
      `and BookForge builds neither on ${process.platform}, so there is no arm for a ` +
      'voice to be staged on.',
  );
}

/**
 * WHY THIS VOICE CANNOT RENDER ON THIS MACHINE — one sentence, or `null`.
 *
 * The picker's half of every refusal `resolveHiggsModel` throws, and it is the
 * SAME refusal rather than a second description of it: the message it returns is
 * the exception's own text. Two lists that disagree about which voices work is
 * exactly how a dropdown ends up offering a voice the run then refuses (which is
 * what `_pendingNote` was already guarding against, one reason at a time).
 */
export function higgsVoiceUnavailableReason(model: HiggsModel): string | null {
  if (model._pendingNote) return model._pendingNote;
  try {
    refuseRetiredCheckpointDir(model);
    refuseMalformedVoice(model);
    refuseUntranscribedClips(model);
    const arm = thisMachineArm();
    refuseUnstagedCheckpoint(model);
    refuseUnmeasuredAdapter(model, arm);
    refuseOversizedReference(model, arm);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * The voices that can actually render ON THIS MACHINE.
 *
 * ARM-AWARE since 2026-09-05. It used to drop only the voices carrying a
 * `_pendingNote`, which was the whole of "can this render" while a checkpoint had
 * ONE directory. It has one per arm now, so a fine-tune staged in the WSL guest
 * and not on the Mac is renderable on Windows and NOT renderable on the Mac —
 * and offering it there would serve the model's own speaker, 12 % of the
 * narrator's ECAPA ceiling.
 */
export function listRenderableHiggsModels(): HiggsModel[] {
  return listHiggsModels().filter((m) => higgsVoiceUnavailableReason(m) === null);
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
  refuseRetiredCheckpointDir(model);
  refuseMalformedVoice(model);
  refuseUntranscribedClips(model);
  refuseUnstagedCheckpoint(model);
  const arm = thisMachineArm();
  refuseUnmeasuredAdapter(model, arm);
  refuseOversizedReference(model, arm);
  return model;
}

/**
 * A CATALOG STILL WRITTEN THE OLD WAY IS REFUSED, NOT READ.
 *
 * `voice.checkpointDir` was one string for one machine, and it held the WSL
 * guest's path — so on the Mac it wrote a `/home/telltale/…` directory into the
 * voice document and the MLX backend refused it (correctly, and five minutes
 * later than here). A catalog carrying the retired key would silently lose its
 * per-arm staging under `voice.checkpoint`, so it fails loud instead. The same
 * shape of guard narrator applies to `adapterDir`.
 */
function refuseRetiredCheckpointDir(model: HiggsModel): void {
  const legacy = (model.voice as { checkpointDir?: unknown }).checkpointDir;
  if (legacy === undefined) return;
  throw new Error(
    `Higgs voice "${model.id}" names voice.checkpointDir, which is retired. A merged ` +
      'checkpoint has ONE LOCATION PER ARM — the WSL guest cannot see the Mac\'s disk ' +
      'and the Mac cannot see the guest\'s — so it is now ' +
      '`voice.checkpoint: { "wsl": "<guest absolute path>", "darwin": "<path relative ' +
      'to the app\'s userData>" }`, and an arm with no entry means the voice is not ' +
      'staged there. Refusing to guess which arm ' + JSON.stringify(legacy) + ' belongs to.',
  );
}

/**
 * A CHECKPOINT VOICE THIS MACHINE HAS NO COPY OF IS REFUSED BY NAME.
 *
 * Not "not installed" (that is `_pendingNote`, which is about the artifact
 * existing ANYWHERE) and not a search: the catalog either names a directory for
 * this arm or it does not, and the honest answer to "render deathstalker on the
 * Mac when only the WSL path is in the catalog" is a sentence saying so. The
 * alternative — handing over the other arm's path — is a load that fails deep
 * inside narrator with a path nobody on this machine has ever seen.
 */
function refuseUnstagedCheckpoint(model: HiggsModel): void {
  if (model.kind !== 'checkpoint') return;
  higgsCheckpointPathFor(model, thisMachineArm());
}

/**
 * THE ENTRY'S SHAPE MUST MATCH ITS KIND — checked before anything else, because
 * every refusal below assumes it.
 *
 * The failure this prevents is not a crash: it is `clips: []` on a voice that
 * means "the model's own speaker", which narrator refuses by name, and which
 * before that made the built-in voice and an empty clone indistinguishable in
 * the wire format.
 */
function refuseMalformedVoice(model: HiggsModel): void {
  const { clips, checkpoint } = model.voice;
  const has = (n: number | undefined) => n !== undefined && n > 0;
  const staged = Object.entries(checkpoint ?? {}).filter(([, p]) => (p || '').trim());

  if (model.kind === 'default') {
    if (has(clips?.length) || staged.length > 0) {
      throw new Error(
        `Higgs voice "${model.id}" is kind 'default' — the served model's own speaker — but ` +
          `also declares ${has(clips?.length) ? 'reference clips' : 'a checkpoint location'}. ` +
          `A default voice has neither; if it is meant to be a clone or a fine-tune, say so ` +
          `in its kind.`,
      );
    }
    return;
  }

  if (model.kind === 'checkpoint') {
    if (staged.length === 0) {
      throw new Error(
        `Higgs voice "${model.id}" is kind 'checkpoint' but names no checkpoint location on ` +
          `any arm — there is no merged fine-tune for the server to start on, or for the MLX ` +
          `backend to load. Give it a voice.checkpoint entry for at least one of: ` +
          `${CHECKPOINT_ARMS.join(', ')}.`,
      );
    }
    const unknown = staged.map(([arm]) => arm)
      .filter((arm) => !(CHECKPOINT_ARMS as readonly string[]).includes(arm));
    if (unknown.length > 0) {
      throw new Error(
        `Higgs voice "${model.id}" names checkpoint arm(s) ${unknown.join(', ')}, which are not ` +
          `arms BookForge renders on. The arms are ${CHECKPOINT_ARMS.join(' and ')} — the WSL ` +
          `guest's filesystem and the Mac's. An unrecognised key is a directory nothing will ` +
          `ever read.`,
      );
    }
    for (const arm of CHECKPOINT_ARMS) refuseMisshapedCheckpointPath(model, arm);
    if (has(clips?.length)) {
      throw new Error(
        `Higgs voice "${model.id}" is kind 'checkpoint' and also declares reference clips. A ` +
          `fine-tune is prompted TEXT-ONLY: the voice is in the weights. Sending a reference ` +
          `alongside it conditions the render on two different voices.`,
      );
    }
    return;
  }

  // kind 'clips'
  if (!has(clips?.length)) {
    throw new Error(
      `Higgs voice "${model.id}" is kind 'clips' but declares none. A zero-shot clone with no ` +
        `reference is not a clone — it is the model's own built-in speaker, which is kind ` +
        `'default' and a different voice entirely (12 % of the narrator's ECAPA ceiling).`,
    );
  }
  if (staged.length > 0) {
    throw new Error(
      `Higgs voice "${model.id}" is kind 'clips' but also names a checkpoint location ` +
        `(${staged.map(([arm]) => arm).join(', ')}). Pick one: a reference clone or a merged ` +
        `fine-tune.`,
    );
  }
}

/** The arms a checkpoint may be staged on. The catalog's whole key vocabulary. */
const CHECKPOINT_ARMS = ['wsl', 'darwin'] as const;

/**
 * WHICH `backends` BLOCK EACH ARM RENDERS THROUGH — the ONE place the two
 * vocabularies meet.
 *
 * They are different words because they answer different questions. An ARM is a
 * FILESYSTEM: which machine's disk the 8.5 GB of weights sit on. A BACKEND is a
 * RUNTIME: `served` is vllm-omni answering HTTP, `mlx` is mlx-audio sampling in
 * this process. They are 1:1 today and might not always be (vLLM-Omni installs
 * natively on Linux in principle, which would be a third arm on the `served`
 * backend), which is exactly why the mapping is a table and not a coincidence
 * two files each rely on separately.
 */
const BACKEND_FOR_ARM: Record<HiggsCheckpointArm, 'served' | 'mlx'> = {
  wsl: 'served',
  darwin: 'mlx',
};

/**
 * THE SHAPE OF ONE ARM'S PATH, checked whether or not this machine is that arm.
 *
 * Checked on BOTH arms from any machine on purpose: a Windows build is where the
 * catalog is usually edited, and a darwin entry written as `/Users/telltale/…`
 * would otherwise be discovered by the one person who cannot fix it quickly.
 * These are properties of the STRING, so they need no filesystem and no arm.
 */
function refuseMisshapedCheckpointPath(model: HiggsModel, arm: HiggsCheckpointArm): void {
  const raw = model.voice.checkpoint?.[arm];
  if (raw === undefined) return;
  const value = raw.trim();
  if (!value) {
    throw new Error(
      `Higgs voice "${model.id}" has an empty ${arm} checkpoint path. An arm that is not ` +
        'staged is left OUT — an empty string says "staged, at nowhere".',
    );
  }
  if (arm === 'wsl') {
    // GUEST-RESIDENT, in either form Windows can spell it. `/home/telltale/…` is
    // the guest's own name for the directory, and `\\wsl$\<distro>\home\…` is the
    // UNC form the Windows side uses for the same ext4 directory (tool-paths.ts
    // documents it for `orpheusModelsDir`); `toGuestPath` folds the second onto
    // the first at document-write time.
    //
    // A DRIVE PATH IS NOT AN ALTERNATIVE SPELLING — it is a different directory,
    // on the Windows disk, which the guest reads over the 9p mount. That is fine
    // for a few hundred bytes of voice document and ruinous for 8.5 GB of
    // weights, which is exactly why the merged directories live on ext4.
    const unc = /^[\\/]{2}wsl[$.](localhost)?[\\/]/i.test(value);
    if (!value.startsWith('/') && !unc) {
      throw new Error(
        `Higgs voice "${model.id}": the wsl checkpoint ${JSON.stringify(value)} is not a ` +
          'guest-resident path. The WSL entry is the directory the LAUNCH SCRIPT is started ' +
          'on INSIDE the guest, so it is either the guest\'s own absolute path ' +
          '("/home/<user>/…") or its \\\\wsl$\\<distro>\\… UNC form. A C: drive path would put ' +
          '8.5 GB of weights behind the 9p mount.',
      );
    }
    return;
  }
  // darwin
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error(
      `Higgs voice "${model.id}": the darwin checkpoint ${JSON.stringify(value)} is absolute. ` +
        "A Mac's Application Support path carries the account name, so an absolute path in a " +
        'REPO-TRACKED catalog names a directory that exists on exactly one machine — the ' +
        'failure this catalog exists to prevent. Write it relative to the app\'s userData ' +
        'directory, e.g. "runtime/higgs-models/<merged dir>", which BookForge resolves at ' +
        'document-write time.',
    );
  }
  if (value.split(/[\\/]/).some((seg) => seg === '..')) {
    throw new Error(
      `Higgs voice "${model.id}": the darwin checkpoint ${JSON.stringify(value)} climbs out of ` +
        "userData with \"..\". It names a location inside the app's own runtime directory; a " +
        'path that leaves it is not staged, it is somewhere else on the machine.',
    );
  }
}

/**
 * THE CATALOG'S PATH FOR ONE ARM, unresolved — or a refusal naming the voice and
 * the arm. The string as written, so `darwin` is still userData-relative here;
 * `higgsCheckpointDirFor` is what makes it absolute.
 */
function higgsCheckpointPathFor(model: HiggsModel, arm: HiggsCheckpointArm): string {
  if (model.kind !== 'checkpoint') {
    throw new Error(
      `Higgs voice "${model.id}" is kind '${model.kind}' and has no checkpoint directory. ` +
        "Only a fine-tune ('checkpoint') is loaded from one.",
    );
  }
  refuseMisshapedCheckpointPath(model, arm);
  const value = (model.voice.checkpoint?.[arm] ?? '').trim();
  if (value) return value;
  const other = CHECKPOINT_ARMS.filter((a) => (model.voice.checkpoint?.[a] ?? '').trim());
  throw new Error(
    `Higgs voice "${model.id}" is not staged for ${ARM_DESCRIPTION[arm]}: no ${arm} checkpoint ` +
      `in the catalog${other.length ? ` (it names only: ${other.join(', ')})` : ''}. A ` +
      'fine-tune renders from its OWN merged directory, and the two arms cannot see each ' +
      "other's disks — so the other arm's path is not an answer, it is a directory this " +
      'machine has never had. Copy the merged directory to this machine, add its location to ' +
      'electron/data/higgs-models.json, and MEASURE this arm\'s cap: a copy is the same ' +
      'weights but a new certificate.',
  );
}

/** How each arm is named to a person. The refusals read as sentences. */
const ARM_DESCRIPTION: Record<HiggsCheckpointArm, string> = {
  wsl: 'WSL',
  darwin: 'the Mac',
};

/**
 * THE DIRECTORY THIS ARM LOADS THE WEIGHTS FROM, absolute and ready to be
 * translated for a guest.
 *
 * `userDataDir` is REQUIRED on the darwin arm and refused as missing rather than
 * guessed: the catalog stores that path relative to userData precisely because
 * this module does not know where userData is, and `app.getPath('userData')` is
 * the caller's to supply (this module deliberately imports no Electron).
 */
export function higgsCheckpointDirFor(
  model: HiggsModel,
  arm: HiggsCheckpointArm,
  userDataDir?: string,
): string {
  const value = higgsCheckpointPathFor(model, arm);
  if (arm === 'wsl') return value;
  if (!userDataDir || !userDataDir.trim()) {
    throw new Error(
      `Higgs voice "${model.id}": the darwin checkpoint ${JSON.stringify(value)} is relative to ` +
        "the app's userData directory, and no userData directory was given. Pass " +
        "app.getPath('userData') — there is no default and no search, because guessing where " +
        "a Mac's Application Support lives is how a render loads 8.5 GB of the wrong weights.",
    );
  }
  return path.join(userDataDir, ...value.split(/[\\/]/));
}

/** Is this voice staged on `arm` at all? The picker's question, no throw. */
export function higgsCheckpointStagedOn(model: HiggsModel, arm: HiggsCheckpointArm): boolean {
  return !!(model.voice.checkpoint?.[arm] ?? '').trim();
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
  const clips = model.voice.clips ?? [];
  const bad = clips.filter((c) => !c.transcript || !c.transcript.trim());
  if (bad.length > 0) {
    throw new Error(
      `Higgs voice "${model.id}" has ${bad.length} reference clip(s) with no transcript ` +
        `(${bad.map((c) => path.basename(c.path)).join(', ')}). ` +
        `A reference clip must carry its BOOK-EXACT text — refusing to send it untranscribed.`,
    );
  }
  const unmeasured = clips.filter((c) => typeof c.seconds !== 'number' || !(c.seconds > 0));
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
function refuseOversizedReference(model: HiggsModel, arm: HiggsCheckpointArm): void {
  const clips = model.voice.clips ?? [];
  if (clips.length > 1) {
    throw new Error(
      `Higgs voice "${model.id}" declares ${clips.length} reference clips. vllm-omni accepts ` +
        `EXACTLY ONE — join them into a single wav (0.35 s of silence between) with the ` +
        `transcripts joined in the same order, and declare that one clip.`,
    );
  }
  const cap = higgsVoiceCapsForModel(model, arm).referenceSecondsCap;
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
 * This is not tidiness. A fine-tuned Higgs checkpoint's stop length tracks its
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
function refuseUnmeasuredAdapter(model: HiggsModel, arm: HiggsCheckpointArm): void {
  if (model.kind !== 'checkpoint') return;
  const backend = BACKEND_FOR_ARM[arm];
  const caps = higgsVoiceCapsForModel(model, arm);
  if (typeof caps.maxChars === 'number' && caps.maxChars > 0 && caps.maxCharsSource) return;
  throw new Error(
    `Higgs fine-tune "${model.id}" has no MEASURED maxChars on the ${backend} backend (got ` +
      `${JSON.stringify(caps.maxChars ?? null)}, source ${JSON.stringify(caps.maxCharsSource ?? null)}, ` +
      `from backends.${backend}). A CERTIFICATE IS PER (DIRECTORY, BACKEND): the number measured ` +
      `on the other backend does not transfer, because the two arms sample through different ` +
      `implementations of top-k/top-p over different runtimes — the same three numbers make the ` +
      `configuration identical, not the draws. ` +
      `A fine-tune's stop length follows its TRAINING CLIP LENGTH, not the text — one trained ` +
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
export function higgsVoiceCapsForModel(
  model: HiggsModel,
  arm: HiggsCheckpointArm = thisMachineArm(),
): HiggsBackendCaps {
  const served = model.backends?.[BACKEND_FOR_ARM[arm]];
  if (!served) return {};
  const caps: HiggsBackendCaps = {};
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
 * THE SHAPE FOLLOWS THE KIND, and only 'clips' carries a `clips` key. Writing
 * `clips: []` for the model's own voice — which an earlier draft did — is a
 * shape narrator refuses by name, and rightly: it makes the built-in speaker and
 * an empty clone the same object.
 *
 * `translatePath` turns a HOST-NATIVE catalog path into one the SPAWN's
 * filesystem can open. It is a parameter rather than a call to `toGuestPath`
 * here because this module has no business knowing which arm the caller is
 * about to spawn on: identity on macOS/Linux, guest translation under WSL.
 *
 * ── ONE checkpoint path, chosen by ARM ──────────────────────────────────────
 *
 * `checkpointDir` stays the WIRE NAME — narrator's `load_voices` reads exactly
 * that key and the document's shape is unchanged. What changed on 2026-09-05 is
 * where the value comes from: the catalog names the merged directory ONCE PER
 * ARM, and this writes the one belonging to `target.arm`. A voice with no entry
 * for that arm is refused here rather than written with the other arm's path,
 * which on the Mac meant a `/home/telltale/…` directory that does not exist.
 */
export interface HiggsDocumentTarget {
  /** The arm the spawn this document is written FOR will take. */
  arm: HiggsCheckpointArm;
  /**
   * The app's userData directory. REQUIRED on the darwin arm, where a
   * checkpoint's catalog path is relative to it; unused on the WSL arm.
   */
  userDataDir?: string;
  /** Guest translation, on the arm that has a guest. Identity by default. */
  translatePath?: (p: string) => string;
}

export function higgsVoicesDocument(
  model: HiggsModel,
  target: HiggsDocumentTarget,
): Record<string, unknown> {
  refuseRetiredCheckpointDir(model);
  refuseMalformedVoice(model);
  const translatePath = target.translatePath ?? ((p: string) => p);

  const entry: Record<string, unknown> = { kind: model.kind };

  if (model.kind === 'clips') {
    entry.clips = (model.voice.clips ?? []).map((c) => ({
      path: translatePath(c.path),
      transcript: c.transcript,
      seconds: c.seconds,
    }));
  }
  if (model.kind === 'checkpoint') {
    entry.checkpointDir = translatePath(
      higgsCheckpointDirFor(model, target.arm, target.userDataDir),
    );
  }
  if (model.voice.scene) entry.scene = model.voice.scene;

  // THE ARM'S OWN CAPS. A certificate is per (directory, backend), so the
  // document for the darwin arm carries the MLX block's cap and never the
  // served one — and a null there means no `maxChars` is emitted at all, which
  // narrator's `load_voices` refuses for a checkpoint entry BY NAME. Two
  // independent refusals of one unmeasured arm.
  const caps = higgsVoiceCapsForModel(model, target.arm);
  // THE CAP TRAVELS IN THE DOCUMENT, and this is the fix for the branch's worst
  // near-miss. narrator's `load_voices` raises for an adapter entry with no
  // `maxChars`, so `refuseUnmeasuredAdapter` was guarding a number that never
  // reached the engine — and the day deathstalker is promoted with its length
  // sweep the render would have been refused while the measurement sat in a JSON
  // file nobody read.
  //
  // This is per-voice DOCUMENT tuning, not an env `caps` payload, so it does not
  // trip `higgs_v3_config_from_worker_kwargs`'s refusal — that one is about
  // Orpheus knobs arriving through the load message.
  if (caps.maxChars !== undefined && caps.maxChars !== null) entry.maxChars = caps.maxChars;
  if (caps.maxCharsSource) entry.maxCharsSource = caps.maxCharsSource;
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
export function writeHiggsVoicesDocument(
  model: HiggsModel,
  jobId: string,
  target: HiggsDocumentTarget,
): string {
  const dir = path.join(os.tmpdir(), 'bookforge-higgs-voices');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${jobId}-${model.id}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(higgsVoicesDocument(model, target), null, 2),
    'utf-8',
  );
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
/**
 * THE MAC'S BASE HIGGS WEIGHTS, as `NARRATOR_HIGGS3_MLX_MODEL` must name them.
 *
 * `mlx_backend.model_dir_from_env()` reads that variable and REFUSES when it is
 * unset — "no default and no search", because an engine that guesses where its
 * weights are is one that can render a whole book in the wrong model and report
 * success. So BookForge names it, and this is the directory narrator's own
 * refusal message points at.
 *
 * `userData` IS `~/Library/Application Support/BookForge` on macOS, so this is
 * exactly the path in that message rather than a second convention.
 */
export function higgsMlxBaseDir(userDataDir: string): string {
  return path.join(userDataDir, 'runtime', 'higgs-models', 'base');
}

export function higgsSpawnEnv(
  model: HiggsModel,
  opts: {
    /** Path to the voice document, in the SPAWN's filesystem. */
    voicesPath: string;
    /**
     * The BASE weights directory, for the darwin in-process backend
     * (`NARRATOR_HIGGS3_MLX_MODEL`). Host-native: there is no guest on a Mac.
     *
     * ALWAYS THE BASE, never a voice's own checkpoint. narrator resolves
     * `model_dir = checkpoint or model_dir_from_env()`: a `checkpoint` voice's
     * weights come from `checkpointDir` in the VOICE DOCUMENT and this variable is
     * not read at all, while a `default` or `clips` voice loads the base from it.
     * Setting it per-voice would therefore be ignored where it looked meaningful
     * and load a fine-tune as "the base" where it was not.
     */
    mlxModelDir?: string;
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
  refuseRetiredCheckpointDir(model);
  refuseMalformedVoice(model);
  refuseUntranscribedClips(model);
  refuseUnstagedCheckpoint(model);
  // The spawn's arm IS this machine's arm: `checkpointArmForSpawn` in
  // higgs-spawn.ts derives it from `narratorRunsInWsl` and refuses the one case
  // where they could differ (Windows with the WSL toggle off, which has no arm at
  // all) before this is ever reached.
  const spawnArm = thisMachineArm();
  refuseOversizedReference(model, spawnArm);
  refuseUnmeasuredAdapter(model, spawnArm);

  const env: Record<string, string> = {
    NARRATOR_HIGGS_VOICES: opts.voicesPath,
  };
  if (opts.mlxModelDir) env.NARRATOR_HIGGS3_MLX_MODEL = opts.mlxModelDir;
  if (opts.serveScriptPath) env.NARRATOR_HIGGS3_SERVE_SCRIPT = opts.serveScriptPath;
  if (opts.baseUrl) env.NARRATOR_HIGGS3_URL = opts.baseUrl;
  if (opts.wslDistro) env.NARRATOR_HIGGS3_WSL_DISTRO = opts.wslDistro;

  return env;
}

/**
 * The narration picker's view of the catalog: `{value,label}` rows, with a
 * voice that cannot render yet marked in its LABEL rather than dropped.
 *
 * Mirrors `mergeOrpheusVoices`' output shape so the modal's dropdown code is the
 * same for both engines.
 */
export function higgsNarrationVoices(): {
  value: string; label: string; unavailable?: string;
}[] {
  // FINE-TUNED VOICES ONLY (plus the served default). Owen, 2026-09-04: a clone
  // is a diagnostic, and listing one beside a fine-tune invites picking it for a
  // book. The `clips` shape stays supported everywhere else — the loader
  // validates it, the document emits it, the narrator cross-check drives it —
  // it is simply not on offer here.
  return listHiggsModels()
    .filter((m) => SELECTABLE_VOICE_KINDS.has(m.kind))
    .map((m) => {
      // TWO WAYS TO BE UNAVAILABLE, said differently, because they send a person
      // to different places. `_pendingNote` is "this artifact does not exist yet,
      // anywhere" — wait for the training side. Anything else this returns is
      // "it exists and this MACHINE cannot render it", which since 2026-09-05
      // is most often "the merged directory is staged on the other arm".
      const reason = higgsVoiceUnavailableReason(m);
      if (!reason) return { value: m.id, label: m.label };
      // The picker renders this as a DISABLED option with the reason as its
      // tooltip. It used to be label-only, which meant the one voice the catalog
      // ships pending was fully selectable and the run died later at
      // `resolveHiggsModel` — defeating the whole stated point of the double
      // preflight ("turn a doomed run into a sentence someone can read while the
      // dialog is still open").
      const suffix = m._pendingNote ? 'not installed yet' : 'not on this machine';
      return { value: m.id, label: `${m.label} — ${suffix}`, unavailable: reason };
    });
}
