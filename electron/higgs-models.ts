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
 *   NARRATOR_HIGGS3_MLX_MODEL        the BASE weights, for the in-process Mac backend
 *
 * ── AND THE LAUNCH SCRIPT'S OWN SET, WHICH IS NOT NARRATOR'S ────────────────
 *
 * `serve_higgs_v3.sh` is an OPERATOR'S script that narrator runs rather than
 * reimplements, and it is configured the only way a script can be: through the
 * environment. Those variables are `HIGGS_*`, they are NOT narrator's, and the
 * distinction is exactly the one the note above draws — an earlier draft
 * invented a `HIGGS_*` set as a guess at narrator's names, and these are a real
 * set belonging to a real reader:
 *
 *   HIGGS_ENV                 the conda prefix the server runs out of
 *   HIGGS_HOST / HIGGS_PORT   where it binds — and where narrator polls
 *   HIGGS_GPU_MEM_UTIL        stage 0 (talker) share of the card
 *   HIGGS_CODEC_GPU_MEM_UTIL  stage 1 (codec) share of the card; they ADD
 *   HIGGS_MAX_MODEL_LEN       stage 0 context length
 *   HIGGS_MAX_NUM_SEQS        stage 0 batch width — AND narrator's own
 *   HIGGS_DEPLOY_CONFIG       a vllm-omni deploy profile, as an ABSOLUTE guest
 *                             path — a bare file name in the catalog is
 *                             resolved to `<HIGGS_ENV>/bin/<file>`
 *
 * ── AND SINCE 2026-09-06, A SECOND STACK WITH ITS OWN SET ───────────────────
 *
 * `serving.stack` selects between vllm-omni and SGLang-Omni (see
 * `HiggsServingStack` for the measurements that produced the second one). The
 * stack itself travels as `HIGGS_STACK` on EVERY arm and EVERY phase, exactly
 * as `HIGGS_MAX_NUM_SEQS` does and for the same reason: narrator refuses by name
 * when it is unset, because the two stacks are not interchangeable.
 *
 * On the SGLang arm the launch script is `serve_higgs_sgl.sh` and its knobs are
 * a DIFFERENT SET, not a subset:
 *
 *   NARRATOR_HIGGS_SGL_SERVE_SCRIPT  the launcher (its own name, so a stale
 *                                    NARRATOR_HIGGS3_* cannot cross the stacks)
 *   HIGGS_SGL_ENV                    the `sglomni` conda prefix
 *   HIGGS_SGL_HOST / HIGGS_SGL_PORT  where it binds (8200, never 8095)
 *   HIGGS_SGL_MEM_FRACTION           ONE fraction for the whole engine
 *   HIGGS_SGL_CUDA_GRAPH_MAX_BS      the graph capture budget
 *   HIGGS_SGL_MAX_NEW_TOKENS         the engine's own generation ceiling
 *   HIGGS_MAX_NUM_SEQS               shared: `max_running_requests` AND
 *                                    narrator's batch width
 *
 * Every one of them comes from the catalog's `serving` block (`higgsServingFor`)
 * and NONE of them reached the script until 2026-09-05: the block declared a
 * configuration and the server ran on the script's built-in defaults. The one
 * that is set on EVERY arm and every phase is HIGGS_MAX_NUM_SEQS, because
 * narrator reads it too (`serve_concurrency`, which refuses when it is unset).
 * HIGGS_MODEL_DIR is the exception in the other direction: narrator exports it
 * per voice from the voice document, so BookForge must not.
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
 *   'clips'       a zero-shot clone: the BASE weights plus one reference clip
 *                 (both stacks take exactly one), with its book-exact transcript
 *                 and a declared duration. OFFERED since 2026-09-06, labelled
 *                 "Zero-shot" so it is never mistaken for a fine-tune; the four
 *                 shipped ones read their clip from the models area,
 *                 `<userData>/runtime/higgs-models/refs/`.
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
 * The kinds the narration dropdown offers: all three.
 *
 * Owen, 2026-09-04, ruled production fine-tuned voices only — a clone recovers
 * 92 % of the narrator's speaker identity and none of his phrasing (2.01
 * pauses/100 chars against his 1.39; pitch std 5.17 st against 4.36), which is
 * the gap a fine-tune exists to close — and `clips` was kept out of this set so
 * a clone was never picked for a book by accident.
 *
 * Owen, 2026-09-06, asked for a ZERO-SHOT OPTION on the narration modal: base
 * Higgs v3 plus one reference clip, for the two voices that have no Higgs
 * fine-tune at all (thirdreich, owen-morgan) and, as a different product beside
 * the fine-tune, for deathstalker and mistborn. So `clips` is offered — with the
 * word "Zero-shot" in every such label, which is what keeps the 09-04 concern
 * honest: the dropdown says what it is, rather than hiding it.
 *
 * `default` stays because it is the one voice that needs nothing staged, so it
 * is what a machine auditions the serving stack with before any checkpoint
 * exists.
 */
const SELECTABLE_VOICE_KINDS: ReadonlySet<HiggsVoiceKind> =
  new Set(['default', 'checkpoint', 'clips']);

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
   * The wav. TWO SPELLINGS, told apart by `path.isAbsolute`:
   *
   *   RELATIVE — a file NAME in the models area, `<userData>/runtime/higgs-models/
   *     refs/` (`higgsRefsDir`), beside `runtime/higgs-models/base` and the
   *     Mac's checkpoints, and next door to `runtime/orpheus-models`. Owen,
   *     2026-09-06: "ref clips can be saved permanently in the same area where
   *     models are saved." NOT in the repo: a clip is a voice artifact, staged
   *     per machine like a checkpoint, and the catalog names it the way it
   *     names a darwin checkpoint — relative, resolved with the userData
   *     directory the app passes in. No `..` and no separators: a name, not a
   *     path — `refuseMisshapedClipPath`.
   *   ABSOLUTE — HOST-NATIVE, the form the machine BookForge is running on
   *     uses. For a clip that lives anywhere else.
   *
   * Either way it is translated for the guest at document-write time, per
   * spawn arm (`higgsVoicesDocument`), not stored pre-translated: a WSL-native
   * path is right on the Windows+WSL arm by accident and meaningless on
   * macOS/Linux, where there is no guest for it to be native to. A NAME must
   * EXIST in the models area — `refuseMissingReferenceClip`, at document-write
   * time, before any server is started, naming the folder to copy into. (The
   * picker checks the SHAPE only, the same as it does for a darwin checkpoint:
   * the catalog module imports no Electron and does not know where userData
   * is — except through `refuseAbsentArtifact`, which the app calls WITH it.)
   * An ABSOLUTE path is written through as given and narrator's own
   * `load_voices` is what refuses a missing one (`os.path.isfile` on every
   * clip, at engine load, before any server is launched) — the host has
   * nothing to add to that refusal but a second copy of it.
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
   * THE CHUNK SIZE THE CODE PACKS TO on this arm, in characters. Owen,
   * 2026-09-05: "maxChars is what the model was trained to do, and targetChars
   * can be what the system actually uses. maxChars is informative, targetChars
   * is used by the code directly." The prep's cap and merge floor in one
   * number. PER ARM, beside the arm's `maxChars`, because a certificate is per
   * (directory, backend) and the served and MLX arms of one checkpoint have
   * measured different safe lengths (1200 vs 900 for deathstalker) — one
   * model-level number would have to be the lower arm's on both. Set by the
   * trainer after training, from the training clips' text lengths; until the
   * retrain states it, Owen's interim rule (2026-09-05): each arm's certified
   * maximum. `null` on a fine-tune = the prep refuses by name. Never above this
   * arm's `maxChars` — refused by name on both sides.
   */
  targetChars?: number | null;
  /** Provenance of `targetChars`, in the style of `maxCharsSource`. */
  targetCharsSource?: string | null;
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

/**
 * The serving stack a model's `engineVersion` selects.
 *
 * ── EVERY FIELD HERE REACHES THE LAUNCH SCRIPT ──────────────────────────────
 *
 * Until 2026-09-05 none of them did. The block declared a bind address, two
 * memory fractions, a context length and a batch width, and `higgsSpawnEnv`
 * emitted only the `NARRATOR_*` set — so `serve_higgs_v3.sh` ran on its own
 * built-in defaults and the catalog's numbers were documentation of a
 * configuration nothing applied. Editing `maxNumSeqs` here changed nothing at
 * all, which is worse than having no field: it is a lever that reports success.
 *
 * They travel as the `HIGGS_*` variables the script reads (see
 * `higgsSpawnEnv`), and narrator re-exports the three it also has an opinion
 * about (HIGGS_HOST, HIGGS_PORT, HIGGS_MAX_NUM_SEQS) into the wrapper it
 * launches, so the pair that binds and the pair that is polled cannot drift.
 */
/**
 * WHICH SERVING STACK a catalog's `serving` block selects.
 *
 * TWO NOW, and the second one exists because of a measurement rather than a
 * preference. Same 50 packed chunks of a real book, same merged checkpoint
 * (ckpt-1080), same sampling, one seed, scored by ASR coverage / skipped words /
 * insertion rate / early stop, with 3 s ECAPA windows for mid-chunk voice
 * switches (training side, 2026-09-05, HIGGS_FIELD_NOTES §4n):
 *
 *   engine, in flight       early stops  damaged/50  sustained switches  chars/min
 *   vllm-omni 0.28.0, 1          0            5              0             1,064
 *   vllm-omni 0.28.0, 16         4           13              6            10,752
 *   SGLang-Omni 0.1.4, 16        0            5              0            26,666
 *   SGLang-Omni 0.1.4, 1         1            7              0             2,636
 *
 * vllm-omni's damage is its BATCHED TALKER: at width 1 the same build is clean,
 * and the corruption lands on the newest batch row. The truncations Owen heard,
 * the gibberish, and the sustained voice switches are all that one defect.
 * SGLang-Omni is clean at 16 wide and 2.5x the throughput.
 *
 * THE FIELD IS REQUIRED AND HAS NO DEFAULT. `higgsServingStack` refuses a block
 * that does not carry it. A default would make "nobody decided" and "we chose
 * vllm-omni" the same catalog — and the two stacks are not interchangeable in
 * any of the places it matters (sampling placement, the frame-cap field, an
 * 8192- vs a hard-coded 4096-token context, whether reference clips work at
 * all), so the decision has to be written down.
 */
export type HiggsServingStack = 'vllm-omni' | 'sglang-omni';

/** The stacks, as a value, for validation and for messages that list them. */
export const HIGGS_SERVING_STACKS: readonly HiggsServingStack[] =
  ['vllm-omni', 'sglang-omni'] as const;

/**
 * THE SGLang-Omni HALF of a serving block — its own env, its own port, its own
 * knobs. Present alongside the vllm-omni fields rather than instead of them, so
 * flipping `stack` is a one-word edit and neither stack's measured
 * configuration is lost when the other is selected.
 *
 * EVERY FIELD REACHES `serve_higgs_sgl.sh`, as a `HIGGS_SGL_*` variable (except
 * the concurrency, which is `HIGGS_MAX_NUM_SEQS` — see `maxRunningRequests`).
 * That is the lesson the vllm-omni block learned the hard way: until 2026-09-05
 * its numbers reached nothing and editing them reported success while changing
 * the server not at all.
 */
export interface HiggsSglangSpec {
  /** The conda env prefix name. A SEPARATE env from `higgs3` and it must be: */
  /* python 3.12 + torch 2.13.0+cu130 + sglang 0.5.18 cannot share an
   * environment with python 3.11 + vllm 0.28.0. */
  condaEnvName: string;
  /** The launcher the installer deploys into `<env>/bin/`. */
  launchScript: string;
  /** The installer that builds that env (Settings → Higgs runs it). */
  installScript: string;
  /**
   * `--model-name`, the `model` field of every request, and the id
   * `/v1/models` reports. DELIBERATELY NOT vllm-omni's `higgs-v3`: a name that
   * differs is one more way a leftover server on the wrong port is caught.
   */
  servedModelName: string;
  host: string;
  /** 8200, so a server on this stack is never confused with vllm-omni's 8095. */
  port: number;
  /**
   * `--mem-fraction-static`. ONE FRACTION, NOT TWO: sgl-omni takes a single
   * number for the whole engine, where vllm-omni is two vLLM stages that each
   * apply the global flag (hence this catalog's separate
   * `gpuMemoryUtilization` / `codecGpuMemoryUtilization` pair). MEASURED: 0.60
   * holds ~19 GB of a 24.5 GB card at 16 in flight, healthy in ~110 s, CUDA
   * graphs captured on sm_86.
   */
  memFractionStatic: number;
  /**
   * `--tts_engine.factory.max_running_requests`, AND the width of narrator's own
   * batch. It travels as `HIGGS_MAX_NUM_SEQS` — the same variable the vllm-omni
   * arm uses — because `serve_concurrency()` reads exactly that name and there
   * must be ONE answer to "how wide is this render" per job.
   */
  maxRunningRequests: number;
  /**
   * `--tts_engine.factory.cuda_graph_max_bs`. A CAPTURE budget, not a scheduling
   * limit: graphs are captured up to this size at startup and cost VRAM. Ships
   * equal to `maxRunningRequests` (that is what was measured) and is a separate
   * field because they are separate things.
   */
  cudaGraphMaxBs: number;
  /**
   * `--tts_engine.factory.max_new_tokens`, applied by the scheduler adapter as
   * `min(request, this)`. NOT the effective per-request cap: the real ceiling is
   * `contextTokens`, and narrator sizes every request against it.
   */
  maxNewTokens: number;
  /**
   * THE HARD CONTEXT, recorded so a refusal can cite it. `sglang_omni/models/
   * higgs_tts/engine_builder.py` sets `HiggsTtsEngineBuilder.context_length =
   * 4096` as a class attribute; there is no flag and no config path. Prompt
   * tokens + `max_new_tokens` over 4,095 is an HTTP 500 from inside the
   * scheduler, so narrator refuses a chunk that cannot fit BY NAME before
   * sending (python/narrator/engine/higgs/sgl_served.py `frame_cap`).
   *
   * It is in the catalog and not only in the python because BookForge is where
   * a voice's `targetChars` is chosen, and this is the number that bounds it.
   */
  contextTokens: number;
  /** Measured launch-to-health on owens-pc: ~110 s. */
  coldStartSeconds: number;
}

export interface HiggsServingSpec {
  engineVersion: string;
  /**
   * WHICH STACK SERVES THIS MODEL. Required — see `HiggsServingStack`.
   * `higgsServingStack()` is the only reader, and it refuses a block without it
   * rather than assuming the older one.
   */
  stack: HiggsServingStack;
  /** The SGLang-Omni half, read when `stack` is `'sglang-omni'`. */
  sglang?: HiggsSglangSpec;
  model: string;
  env: string;
  condaEnvName: string;
  launchScript: string;
  servedModelName: string;
  host: string;
  port: number;
  endpoint: string;
  /**
   * STAGE 0, THE TALKER — its KV CACHE BUDGET, as a fraction of the WHOLE CARD
   * (`HIGGS_GPU_MEM_UTIL`).
   *
   * IT IS A BUDGET ON TOP OF THE WEIGHTS, NOT A CAP ON THE STAGE. The server's
   * own log at 0.35 (owens-pc, RTX 3090 Ti 24.5 GB, vllm-omni 0.28.0,
   * 2026-09-05): "Desired GPU memory utilization is (0.35, 8.4 GiB). Actual
   * usage is 7.72 GiB", "Available KV cache memory: 8.4 GiB", "GPU KV cache
   * size: 61,120 tokens" — so stage 0 holds 7.72 GiB of weights AND 8.4 GiB of
   * cache. Nor is it the server's total: the codec decoder is a second stage
   * with its own fraction, and the two ADD.
   *
   * 0.35 is measured, not conservative: 0.55 + 0.15 held 24.0 GB and paged on
   * WDDM, while 0.35 + 0.10 holds 18.7-19.2 GB at IDENTICAL throughput —
   * 11,387-11,584 chars/min over three runs at 16 concurrent.
   */
  gpuMemoryUtilization: number;
  /**
   * STAGE 1, THE CODEC DECODER — its own fraction of the whole card
   * (`HIGGS_CODEC_GPU_MEM_UTIL`).
   *
   * SEPARATE BECAUSE vllm-omni APPLIES A GLOBAL FLAG TO EVERY STAGE. A single
   * `--gpu-memory-utilization 0.60` reserved 0.60 TWICE — measured 24.2 GB of a
   * 24.5 GB card on 2026-09-05 — which is why the launch script passes both
   * through `--stage-overrides` instead.
   *
   * 0.25 is the codec's value in vllm-omni's own deploy profile
   * (`higgs_multimodal_qwen3.yaml`) and 0.10 is what BookForge ships: at
   * 0.35 + 0.10 the card sits at 18.7-19.2 GB and the render is no slower than
   * it was at 0.55 + 0.15, which filled it (measured 2026-09-05).
   */
  codecGpuMemoryUtilization: number;
  maxModelLen: number;
  maxNumSeqs: number;
  /**
   * A vllm-omni DEPLOY PROFILE — a FILE NAME or a full path, or `null`.
   *
   * A bare file name (no separator) is one of OUR profiles, deployed into
   * `<env>/bin/` by the installer, and `resolveDeployConfig` turns it into the
   * absolute guest path `HIGGS_DEPLOY_CONFIG` carries. A value with a separator
   * is passed through verbatim. A bare profile NAME with no `.yaml`/`.yml` is
   * REFUSED here — vllm-omni answers "Deploy config not found" for one, 297 s
   * into a cold start.
   *
   * IT IS NOT null ANY MORE, and the reason is a ceiling rather than a
   * preference: stage 0's `default_sampling_params.max_tokens` in the profile is
   * a hard cap on the audio length of every render (the served speech endpoint
   * ignores a per-request `max_tokens`), and the auto-discovered
   * `higgs_multimodal_qwen3.yaml` sets it to 2048 frames = 81.92 s. Anything
   * longer is cut mid-sentence. `higgs_default_frames7500.yaml` is that file
   * with 7500 (300 s) and nothing else changed.
   *
   * `null` remains meaningful — "let vllm-omni auto-discover its own profile" —
   * and the key is REQUIRED, because an absent key would make "nobody has
   * decided" and "we chose the default" the same catalog.
   */
  deployConfig: string | null;
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
  /**
   * WHERE A MACHINE CAN DOWNLOAD A `checkpoint` VOICE FROM — a HuggingFace repo,
   * private under Owen's account like the Orpheus voice repos. Settings → Higgs
   * offers a Download for every checkpoint voice that names one, into THIS
   * ARM's `voice.checkpoint` path (`higgs-hf-install.ts`). Absent = the
   * artifact is staged by hand, and the panel says so.
   */
  source?: HiggsSource;
}

export interface HiggsSource {
  type: 'hf';
  /** `<user>/<repo>` on huggingface.co. */
  ref: string;
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
export function higgsVoiceUnavailableReason(model: HiggsModel, userDataDir: string): string | null {
  if (model._pendingNote) return model._pendingNote;
  try {
    refuseRetiredCheckpointDir(model);
    refuseMalformedVoice(model);
    refuseUntranscribedClips(model);
    const arm = thisMachineArm();
    refuseUnstagedCheckpoint(model);
    refuseUnmeasuredAdapter(model, arm);
    refuseOversizedReference(model, arm);
    refuseAbsentArtifact(model, arm, userDataDir);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * THE ARTIFACT MUST BE ON THE DISK, not just in the catalog. Found on the Mac,
 * 2026-09-06: the mistborn fine-tune names a darwin checkpoint the copy of
 * which had not landed, and the picker offered it as available — every check
 * above asks what the catalog SAYS, and none asked whether the directory is
 * there. The row was selectable and the render died at document write, which
 * is exactly the "offered then refused" pair the picker exists to prevent.
 *
 * WHAT THIS CAN SEE. The host's own filesystem: a darwin checkpoint under
 * userData, and a models-area clip (`higgsRefsDir`) on either arm. A WSL
 * checkpoint lives in the guest's ext4, which the host cannot stat without a
 * `wsl.exe` round trip — a picker is not the place for one, so that arm's
 * existence is the doctor's question and narrator's refusal at launch. Stated
 * rather than approximated.
 */
function refuseAbsentArtifact(
  model: HiggsModel,
  arm: HiggsCheckpointArm,
  userDataDir: string,
): void {
  if (!userDataDir || !userDataDir.trim()) {
    throw new Error(
      `Higgs voice "${model.id}": the picker was asked whether this voice is on this machine ` +
        "with no userData directory. Pass app.getPath('userData') — the darwin checkpoints " +
        'and the reference clips are resolved under it, and without it nothing can be checked.',
    );
  }
  if (model.kind === 'clips') {
    refuseMissingReferenceClip(model, userDataDir);
    return;
  }
  if (model.kind === 'checkpoint' && arm === 'darwin') {
    const dir = higgsCheckpointDirFor(model, arm, userDataDir);
    if (!fs.existsSync(dir)) {
      throw new Error(
        `Higgs voice "${model.id}" is staged for the Mac at ${dir} in the catalog, but that ` +
          'directory is not there — the copy of the merged checkpoint has not landed on this ' +
          'machine. Offering it would start a render that dies at the voice document.',
      );
    }
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
export function listRenderableHiggsModels(userDataDir: string): HiggsModel[] {
  return listHiggsModels().filter((m) => higgsVoiceUnavailableReason(m, userDataDir) === null);
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
  refuseMalformedSource(model);
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
  for (const clip of clips ?? []) refuseMisshapedClipPath(model, clip);
}

/**
 * A `source` is well-formed or absent — never half-written. Checked with the
 * shape because a source with a blank ref is a Download button that fails
 * after the token prompt rather than a catalog that fails to load.
 */
function refuseMalformedSource(model: HiggsModel): void {
  const source = model.source;
  if (source === undefined) return;
  if (!source || typeof source !== 'object' || source.type !== 'hf'
      || typeof source.ref !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(source.ref.trim())) {
    throw new Error(
      `Higgs voice "${model.id}" has a malformed source ${JSON.stringify(source)}. The shape is ` +
        '{type: "hf", ref: "<user>/<repo>"}.',
    );
  }
  if (model.kind !== 'checkpoint') {
    throw new Error(
      `Higgs voice "${model.id}" is kind '${model.kind}' and names a download source. Only a ` +
        'merged checkpoint is downloaded; the base weights ship with the environment and a ' +
        'reference clip lives in the models area.',
    );
  }
}

/**
 * WHERE THE REFERENCE CLIPS LIVE: the models area. `runtime/higgs-models/refs`
 * under the app's userData, beside `runtime/higgs-models/base` (the Mac's base
 * weights) and the Mac's checkpoints, and next to `runtime/orpheus-models`.
 * Owen, 2026-09-06: "ref clips can be saved permanently in the same area where
 * models are saved."
 */
export function higgsRefsDir(userDataDir: string): string {
  return path.join(userDataDir, 'runtime', 'higgs-models', 'refs');
}

/**
 * A relative clip path is a NAME under `higgsRefsDir()` — nothing else. A
 * relative path with a directory in it would resolve somewhere that is not
 * the models area and still "work" on the machine that happened to have the
 * file, which is the cross-machine failure the one folder exists to remove.
 */
function refuseMisshapedClipPath(model: HiggsModel, clip: HiggsReferenceClip): void {
  const raw = (clip.path || '').trim();
  if (!raw) {
    throw new Error(`Higgs voice "${model.id}" has a reference clip with no path.`);
  }
  if (path.isAbsolute(raw)) return;
  if (raw !== path.basename(raw) || raw === '.' || raw === '..') {
    throw new Error(
      `Higgs voice "${model.id}" names reference clip ${JSON.stringify(raw)}, which is ` +
        `relative but not a bare file name. A relative clip is a file in the models area ` +
        `(<userData>/runtime/higgs-models/refs/) and is written as its name alone; a clip ` +
        `anywhere else is an absolute, host-native path.`,
    );
  }
}

/**
 * The clip's path ON THIS MACHINE: a name resolved against `higgsRefsDir`, an
 * absolute path as written. `userDataDir` is REQUIRED for a name and refused
 * as missing rather than guessed — the same rule as `higgsCheckpointDirFor`.
 */
export function higgsReferenceClipPath(
  model: HiggsModel,
  clip: HiggsReferenceClip,
  userDataDir?: string,
): string {
  const raw = (clip.path || '').trim();
  if (path.isAbsolute(raw)) return raw;
  if (!userDataDir || !userDataDir.trim()) {
    throw new Error(
      `Higgs voice "${model.id}": reference clip ${JSON.stringify(raw)} is a name in the ` +
        "models area (<userData>/runtime/higgs-models/refs/), and no userData directory " +
        "was given. Pass app.getPath('userData') — there is no default and no search.",
    );
  }
  return path.join(higgsRefsDir(userDataDir), raw);
}

/**
 * A clip NAMED in the models area must be THERE. narrator's `load_voices`
 * checks every clip (`os.path.isfile`) at engine load, before any server is
 * launched — but in the guest, against the translated path, with a message
 * that names the translated path and nothing about where the file belongs.
 * This is the host's refusal for the one spelling the host owns the location
 * of: it names the folder to copy into. An absolute path is narrator's to
 * refuse; the host would only be repeating it.
 */
function refuseMissingReferenceClip(model: HiggsModel, userDataDir?: string): void {
  for (const clip of model.voice.clips ?? []) {
    if (path.isAbsolute((clip.path || '').trim())) continue;
    const resolved = higgsReferenceClipPath(model, clip, userDataDir);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `Higgs voice "${model.id}" names reference clip ${clip.path}, which is not on this ` +
          `machine (looked at ${resolved}). Copy the clip into the models area, ` +
          "runtime/higgs-models/refs/ under the app's userData — it is a voice artifact " +
          'staged per machine, like a checkpoint.',
      );
    }
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

/**
 * WHICH SERVING STACK a block selects — or a refusal naming the block.
 *
 * REQUIRED, WITH NO DEFAULT. An absent key would make "nobody has decided" look
 * exactly like "we chose vllm-omni", and the choice is not cosmetic: the two
 * stacks place sampling differently (vllm-omni inside `extra_params`, SGLang at
 * the request top level, where a missing top_k means the untruncated codebook
 * tail), size the frame cap against an 8192- or a hard-coded 4096-token context,
 * name the cap field differently, and disagree about whether a reference-clone
 * voice can render at all. Reading the wrong one is a book at sampling nobody
 * chose, or an HTTP 500 per chunk.
 */
export function higgsServingStack(serving: HiggsServingSpec): HiggsServingStack {
  const value = (serving as { stack?: unknown }).stack;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(
      'The Higgs serving block declares no `stack`. It names the serving stack the '
      + `server runs on — one of ${HIGGS_SERVING_STACKS.join(', ')} — and there is no `
      + 'default, because the two are not interchangeable: they place sampling in '
      + 'different parts of the request, size the frame cap against different context '
      + 'windows (8192 vs a hard-coded 4096), and only one of them can render a '
      + 'reference-clone voice. Write it in electron/data/higgs-models.json.',
    );
  }
  if (!(HIGGS_SERVING_STACKS as readonly string[]).includes(value)) {
    throw new Error(
      `The Higgs serving block's stack is ${JSON.stringify(value)}, which is not a stack `
      + `BookForge serves. The stacks are ${HIGGS_SERVING_STACKS.join(' and ')}.`,
    );
  }
  return value as HiggsServingStack;
}

/**
 * The SGLang half of a serving block, VALIDATED — or a refusal naming the field.
 *
 * Asked only when `stack` selects it. Every number here lands on an `sgl-omni`
 * command line inside a WSL guest, roughly two minutes before anything can be
 * heard, so a missing one is refused here rather than defaulted: a substituted
 * `maxRunningRequests` is a server that comes up at the wrong width and renders
 * a whole book that way, and narrator sizes its own batch from the same number.
 */
export function higgsSglangFor(serving: HiggsServingSpec): HiggsSglangSpec {
  const block = serving.sglang;
  if (!block || typeof block !== 'object') {
    throw new Error(
      'The Higgs serving block selects the sglang-omni stack but carries no `sglang` '
      + 'block. That block is where its conda env, launcher, bind address, memory '
      + 'fraction, batch width and context window live, and every one of them reaches '
      + 'serve_higgs_sgl.sh as a HIGGS_SGL_* variable. Fix it in '
      + 'electron/data/higgs-models.json.',
    );
  }
  for (const field of ['condaEnvName', 'launchScript', 'installScript',
                       'servedModelName', 'host'] as const) {
    const value = block[field];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `The Higgs serving block's sglang.${field} is ${JSON.stringify(value)}, which is `
        + 'not a name. There is no default here — a guessed env, launcher or served '
        + 'model name is a server started somewhere nobody looked.',
      );
    }
  }
  for (const field of ['port', 'maxRunningRequests', 'cudaGraphMaxBs', 'maxNewTokens',
                       'contextTokens', 'coldStartSeconds'] as const) {
    const value = block[field];
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(
        `The Higgs serving block's sglang.${field} is ${JSON.stringify(value)}, which is `
        + 'not a positive integer. Fix it in electron/data/higgs-models.json.',
      );
    }
  }
  if (block.port > 65535) {
    throw new Error(`The Higgs serving block's sglang.port is ${block.port}, which is not a port number.`);
  }
  const fraction = block.memFractionStatic;
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)
      || fraction <= 0 || fraction >= 1) {
    throw new Error(
      `The Higgs serving block's sglang.memFractionStatic is ${JSON.stringify(fraction)}, `
      + 'which is not a fraction in (0, 1). It is `--mem-fraction-static`, ONE number for '
      + 'the whole engine (unlike vllm-omni, which is two stages that each apply the '
      + 'global flag), and sgl-omni refuses a value outside that range itself. 0.60 is '
      + 'the measured value: ~19 GB of a 24.5 GB card at 16 in flight.',
    );
  }
  return block;
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
  if (served.targetChars !== undefined) caps.targetChars = served.targetChars;
  if (served.targetCharsSource !== undefined) caps.targetCharsSource = served.targetCharsSource;
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
   * checkpoint's catalog path is relative to it, and on EVERY arm for a clips
   * voice whose clip is a name in the models area (`higgsRefsDir`).
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
    // The name becomes this machine's absolute path FIRST (models area +
    // userData), is proved to exist, and only then gets the guest's spelling:
    // narrator opens the file itself (base64 into the request), so the document
    // must name it as the SPAWN sees it.
    refuseMissingReferenceClip(model, target.userDataDir);
    entry.clips = (model.voice.clips ?? []).map((c) => ({
      path: translatePath(higgsReferenceClipPath(model, c, target.userDataDir)),
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
  // THE TRAINER'S TARGET travels beside the cap. Refused here, before the
  // spawn, when it contradicts this arm's cap; narrator's loader refuses the
  // same thing by name, so the two never disagree about what a target may be.
  if (caps.targetChars !== undefined && caps.targetChars !== null) {
    if (!Number.isInteger(caps.targetChars) || caps.targetChars <= 0) {
      throw new Error(
        `Higgs voice '${model.id}' (${target.arm}) declares targetChars ${JSON.stringify(caps.targetChars)}, `
        + 'which is not a positive whole number of characters.',
      );
    }
    if (typeof caps.maxChars === 'number' && caps.targetChars > caps.maxChars) {
      throw new Error(
        `Higgs voice '${model.id}' declares targetChars ${caps.targetChars} above its `
        + `${target.arm} cap of ${caps.maxChars}. The cap is the measured safe chunk length; `
        + 'lower the target or re-certify the cap.',
      );
    }
    entry.targetChars = caps.targetChars;
    if (caps.targetCharsSource) entry.targetCharsSource = caps.targetCharsSource;
  }
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

/**
 * A SERVING NUMBER, REFUSED BY NAME RATHER THAN DEFAULTED.
 *
 * These land on a vllm-omni command line inside a WSL guest, five minutes before
 * anything can be heard. A missing `maxNumSeqs` substituted with a plausible 2
 * is not a smaller failure than a crash — it is a server that comes up at the
 * wrong width and renders a whole book that way, and the catalog says 16.
 */
function servingFraction(serving: HiggsServingSpec, field: 'gpuMemoryUtilization' | 'codecGpuMemoryUtilization'): number {
  const value = serving[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      `The Higgs serving block's ${field} is ${JSON.stringify(value)}, which is not a fraction in ` +
        '(0, 1]. It is a share of the WHOLE CARD passed to vllm-omni through --stage-overrides ' +
        '(talker + codec ADD, so the two together must leave the card headroom), and ' +
        'serve_higgs_v3.sh refuses a non-number itself. Fix it in ' +
        'electron/data/higgs-models.json — there is no default here, because a guessed ' +
        'utilization is a server that either OOMs or leaves half the card idle.',
    );
  }
  return value;
}

function servingCount(serving: HiggsServingSpec, field: 'maxModelLen' | 'maxNumSeqs' | 'port'): number {
  const value = serving[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(
      `The Higgs serving block's ${field} is ${JSON.stringify(value)}, which is not a positive ` +
        'integer. Fix it in electron/data/higgs-models.json — every one of these reaches ' +
        'vllm-omni through serve_higgs_v3.sh, and narrator sizes its own batch from ' +
        'maxNumSeqs (`serve_concurrency`), so a substituted value would make BookForge and the ' +
        'server disagree about how wide the render is.',
    );
  }
  if (field === 'port' && value > 65535) {
    throw new Error(`The Higgs serving block's port is ${value}, which is not a port number.`);
  }
  return value;
}

/**
 * THE DEPLOY PROFILE, AS AN ABSOLUTE PATH INSIDE THE GUEST.
 *
 * ── Why a bare file name is resolved rather than passed on ──────────────────
 *
 * `--deploy-config` takes a FILE NAME or a full path (a bare profile name — no
 * extension — is "Deploy config not found", measured 2026-09-05 on vllm-omni
 * 0.28.0: `config_factory._load_user_deploy_config` joins it to the deploy dir
 * without appending `.yaml`). A bare FILE NAME does resolve, but it resolves
 * against vllm-omni's OWN `deploy/` directory inside site-packages — which is
 * not where the installer puts ours. `higgs_default_frames7500.yaml` is copied
 * into `<env>/bin/`, beside the launcher, so the name alone would either miss it
 * or, worse, find an upstream file of a similar name and start a
 * differently-configured server five minutes later.
 *
 * So the catalog names the FILE and this resolves it against the env prefix,
 * using the SAME `<prefix>/bin/<file>` derivation `higgsEnvExtras` already uses
 * for the launcher itself. One derivation, three variables: the two say where
 * the installer's copies are, and they cannot drift apart.
 *
 * A value that already carries a path separator is the caller having said
 * exactly where the file is — passed through verbatim, including a path to one
 * of vllm-omni's own profiles.
 *
 * ── Why the extension is refused here and not only in bash ──────────────────
 *
 * `serve_higgs_v3.sh` refuses a bare name too, and it is right to. But it does
 * so INSIDE the guest, after the spawn — the failure arrives as a dead worker
 * rather than as a sentence about the catalog. This is the same rule asked
 * before anything is started.
 */
function resolveDeployConfig(profile: string, envPrefix: string): string {
  if (profile.includes('/') || profile.includes('\\')) return profile;
  if (!profile.endsWith('.yaml') && !profile.endsWith('.yml')) {
    throw new Error(
      `The Higgs serving block's deployConfig is ${JSON.stringify(profile)}, which is a bare ` +
        'profile NAME. vllm-omni resolves only a file name (with its .yaml/.yml extension) or a ' +
        'full path — a bare name is "Deploy config not found" at startup, which costs a 297 s ' +
        'cold start to discover. Write the file name, e.g. higgs_default_frames7500.yaml, and ' +
        "BookForge resolves it to the installer's copy in the env.",
    );
  }
  return `${envPrefix}/bin/${profile}`;
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
    /**
     * The conda env prefix the launch script runs out of (`HIGGS_ENV`), in the
     * SPAWN's filesystem — `<conda base>/envs/<higgs env>` inside the guest.
     *
     * REQUIRED WHENEVER `serveScriptPath` IS GIVEN, and refused when it is not:
     * the script derives CUDA_HOME, PATH, LD_LIBRARY_PATH and the `vllm-omni`
     * binary itself from it. Its own default is a hardcoded
     * `$HOME/anaconda3/envs/higgs3`, which is true on the machine the script was
     * transcribed from and a guess everywhere else — that default exists so the
     * script runs by hand, not so BookForge can leave it unsaid.
     */
    condaEnvPrefix?: string;
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

  const serving = higgsServingFor(model);
  const stack = higgsServingStack(serving);
  const sglang = stack === 'sglang-omni' ? higgsSglangFor(serving) : null;

  const env: Record<string, string> = {
    NARRATOR_HIGGS_VOICES: opts.voicesPath,
  };

  // ── ON EVERY ARM AND EVERY PHASE ──────────────────────────────────────────
  //
  // TWO CONTRACT VARIABLES, and narrator refuses BY NAME when either is unset.
  //
  // `serving_stack()` reads HIGGS_STACK: it decides where sampling rides in the
  // request, which context window the frame cap is sized against, and which
  // backend class is built. `serve_concurrency()` reads HIGGS_MAX_NUM_SEQS: it
  // is the server's admission width AND the width of narrator's own batch.
  //
  // Both are set on prep, worker, assembly, retake and serve alike. The doors
  // that do not render read them for nothing, which costs nothing, while a door
  // that DOES render and finds one missing dies after the session is already
  // built.
  env.HIGGS_STACK = stack;
  // ONE VARIABLE, TWO SOURCES, because it is one question. On vllm-omni the
  // width is stage 0's `max_num_seqs`; on SGLang-Omni it is
  // `--tts_engine.factory.max_running_requests`. narrator's `serve_concurrency()`
  // reads exactly this name on both, so a job cannot end up with the server at
  // one width and the client at another.
  env.HIGGS_MAX_NUM_SEQS = String(
    sglang ? sglang.maxRunningRequests : servingCount(serving, 'maxNumSeqs'));

  if (opts.mlxModelDir) env.NARRATOR_HIGGS3_MLX_MODEL = opts.mlxModelDir;
  // ATTACH, PER STACK. The two backends read DIFFERENT variables on purpose:
  // pointing an SGLang engine at a vllm-omni server would find `/health` and
  // `/v1/models` in the right shapes and then send a body that stack drops
  // fields from. One name per stack means a leftover variable cannot do that.
  if (opts.baseUrl) {
    env[sglang ? 'NARRATOR_HIGGS_SGL_URL' : 'NARRATOR_HIGGS3_URL'] = opts.baseUrl;
  }
  // ONE DISTRO VARIABLE: one machine, one guest, and both stacks launch into it.
  if (opts.wslDistro) env.NARRATOR_HIGGS3_WSL_DISTRO = opts.wslDistro;

  // ── THE LAUNCH SCRIPT'S OWN KNOBS ─────────────────────────────────────────
  //
  // Emitted with the script and never without it. They configure a vllm-omni
  // server, and the only arm that starts one is the served (WSL) arm — on the
  // Mac the engine samples in-process and there is no process for a bind
  // address or a memory fraction to mean anything to. Setting them there would
  // be five variables that look like levers and are read by nothing.
  if (opts.serveScriptPath) {
    const prefix = (opts.condaEnvPrefix ?? '').trim();
    if (!prefix) {
      throw new Error(
        'A Higgs spawn that names the launch script must also name the conda env prefix it runs ' +
          'out of (HIGGS_ENV on the vllm-omni stack, HIGGS_SGL_ENV on the SGLang one). Either ' +
          'launcher builds CUDA_HOME, PATH, LD_LIBRARY_PATH and the path to its server binary ' +
          'from it, and each has a hardcoded $HOME/anaconda3/envs/<name> of its own to fall back ' +
          'on — right on the machine it was transcribed from and a wrong-env server start ' +
          'anywhere else. Pass condaEnvPrefix (see higgsEnvExtras).',
      );
    }

    // ── THE SGLang-OMNI ARM ─────────────────────────────────────────────────
    //
    // A DIFFERENT VARIABLE SET, not a subset of the other one, because it
    // configures a different program. NARRATOR_HIGGS_SGL_SERVE_SCRIPT rather
    // than NARRATOR_HIGGS3_SERVE_SCRIPT is load-bearing: each backend reads its
    // OWN attach/launch names, so a stale NARRATOR_HIGGS3_URL in an environment
    // can never silently point an SGLang engine at a vllm-omni server.
    //
    // NOTHING FROM THE vllm-omni HALF COMES ALONG. No HIGGS_ENV (that names the
    // higgs3 prefix), no HIGGS_GPU_MEM_UTIL / HIGGS_CODEC_GPU_MEM_UTIL (sgl-omni
    // takes one fraction for the whole engine), no HIGGS_MAX_MODEL_LEN (the
    // context is hard-coded at 4096 and no flag changes it), and no
    // HIGGS_DEPLOY_CONFIG (there is no deploy profile on this stack — which is
    // also why sampling MUST ride on every request).
    if (sglang) {
      env.NARRATOR_HIGGS_SGL_SERVE_SCRIPT = opts.serveScriptPath;
      env.HIGGS_SGL_ENV = prefix;
      env.HIGGS_SGL_HOST = sglang.host;
      env.HIGGS_SGL_PORT = String(sglang.port);
      env.HIGGS_SGL_MEM_FRACTION = String(sglang.memFractionStatic);
      env.HIGGS_SGL_CUDA_GRAPH_MAX_BS = String(sglang.cudaGraphMaxBs);
      env.HIGGS_SGL_MAX_NEW_TOKENS = String(sglang.maxNewTokens);
      return env;
    }

    env.NARRATOR_HIGGS3_SERVE_SCRIPT = opts.serveScriptPath;
    env.HIGGS_ENV = prefix;
    const host = (serving.host || '').trim();
    if (!host) {
      throw new Error(
        "The Higgs serving block names no host. It is where the server BINDS and where narrator " +
          'polls /health and posts renders (narrator re-exports it into the wrapper), so it is ' +
          'stated rather than inherited. Fix it in electron/data/higgs-models.json.',
      );
    }
    env.HIGGS_HOST = host;
    env.HIGGS_PORT = String(servingCount(serving, 'port'));
    env.HIGGS_GPU_MEM_UTIL = String(servingFraction(serving, 'gpuMemoryUtilization'));
    env.HIGGS_CODEC_GPU_MEM_UTIL = String(servingFraction(serving, 'codecGpuMemoryUtilization'));
    env.HIGGS_MAX_MODEL_LEN = String(servingCount(serving, 'maxModelLen'));

    // A DECLARED null MEANS "vllm-omni's auto-discovered profile" and emits
    // nothing; an ABSENT key means the catalog never decided, and is refused.
    if (serving.deployConfig === undefined) {
      throw new Error(
        "The Higgs serving block declares no deployConfig. It selects vllm-omni's deploy " +
          'profile, and the choice is load-bearing: the auto-discovered ' +
          'higgs_multimodal_qwen3.yaml keeps stage 0 in enforce_eager (no CUDA graphs on the ' +
          'talker) while higgs_multimodal_qwen3_low_latency turns them on. Write `null` to mean ' +
          'the auto-discovered one — a missing key would make "nobody decided" look like a ' +
          'decision.',
      );
    }
    if (serving.deployConfig !== null) {
      const profile = serving.deployConfig.trim();
      if (!profile) {
        throw new Error(
          'The Higgs serving block\'s deployConfig is an empty string. A profile that is not ' +
            "chosen is `null` — an empty name says \"chosen, and it is called nothing\".",
        );
      }
      env.HIGGS_DEPLOY_CONFIG = resolveDeployConfig(profile, prefix);
    }
  } else if (opts.condaEnvPrefix) {
    throw new Error(
      'A Higgs spawn named a conda env prefix (HIGGS_ENV) but no launch script. HIGGS_ENV is ' +
        'read by serve_higgs_v3.sh and by nothing else, so on an arm that launches no server it ' +
        'is a variable with no reader — which is how a Mac spawn ends up looking like a served ' +
        'one.',
    );
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
export function higgsNarrationVoices(userDataDir: string): {
  value: string; label: string; unavailable?: string;
}[] {
  // Every kind, since 2026-09-06 (see SELECTABLE_VOICE_KINDS for the ruling
  // and the one it superseded). A clips voice's LABEL says "Zero-shot", and the
  // catalog is refused if it does not: the 2026-09-04 concern was a clone taken
  // for a fine-tune, and the label is what answers it.
  return listHiggsModels()
    .map((m) => {
      if (m.kind === 'clips' && !/zero-shot/i.test(m.label)) {
        throw new Error(
          `Higgs voice "${m.id}" is a zero-shot clone but its label (${JSON.stringify(m.label)}) ` +
            'does not say "Zero-shot". The dropdown lists clones beside fine-tunes, and the ' +
            'label is the one thing that tells a person which is which.',
        );
      }
      return m;
    })
    .filter((m) => SELECTABLE_VOICE_KINDS.has(m.kind))
    .map((m) => {
      // TWO WAYS TO BE UNAVAILABLE, said differently, because they send a person
      // to different places. `_pendingNote` is "this artifact does not exist yet,
      // anywhere" — wait for the training side. Anything else this returns is
      // "it exists and this MACHINE cannot render it", which since 2026-09-05
      // is most often "the merged directory is staged on the other arm".
      const reason = higgsVoiceUnavailableReason(m, userDataDir);
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
