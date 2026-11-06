/**
 * The Higgs narration voice catalog — loader and refusals.
 *
 * A Higgs voice is not discovered. It is either the served model's own zero-shot
 * voice — which needs nothing on disk at all — or an artifact this repo's catalog
 * names explicitly. So there is no scanner here, no runtime manifest, and no
 * reconcile fallback: `electron/data/higgs-models.json` is the whole roster, and a
 * voice that is not in it is REFUSED BY NAME. A served TTS stack asked for a voice
 * it does not have does not error, it renders the ENTIRE book in its default voice,
 * and on Higgs v3 that default is a genuinely different speaker (ECAPA cosine 0.093
 * against the narrator, 12% of his own ceiling). A fallback here is an hour of audio
 * in the wrong voice with a console warning nobody read.
 *
 * ── What the caller gets ───────────────────────
 *
 * `resolveHiggsModel(id)` — the catalog entry, or a throw naming the id.
 * `higgsVoiceCapsForModel(model)` — the measured knobs, absent-means-absent.
 * `higgsPrepBudget(model, band)` — the floor and cap a book is packed to.
 *
 * Serving is Crucible's: which stack, which script, which memory shares and which
 * batch width are in each voice's crucible-voice.toml on the server. BookForge sends
 * text and a voice id over HTTP. What it keeps of a voice is this catalog, the
 * picker's questions about it, and the band it packs to.
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
// Exported since 2026-09-15 so the Crucible-backed picker
// (`crucible/voice-picker.ts`) asks the SAME question rather than
// restating the rule — two lists of what is selectable is how a dropdown
// and a render come to disagree.
export const SELECTABLE_VOICE_KINDS: ReadonlySet<HiggsVoiceKind> =
  new Set(['default', 'checkpoint', 'clips']);

/**
 * Kinds a render still accepts but the narration DROPDOWN never lists.
 *
 * Owen, 2026-09-25: *"remove the higgs base model from the tts modal voice list
 * … just remove it from the dropdown. it isnt necessary, the user will never
 * render something from the base model. they might use voice cloning, but thats
 * a different logic path altogether. the fine tunes are fused models."* So the
 * `default` voice leaves both pickers (`higgsNarrationVoices` and
 * `crucible/voice-picker.ts`) and nothing else: `SELECTABLE_VOICE_KINDS` is also
 * what the render path reads, and a book or a CLI run that names `default` still
 * renders.
 */
export const PICKER_HIDDEN_VOICE_KINDS: ReadonlySet<HiggsVoiceKind> = new Set(['default']);

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
 *   `wsl`     an ABSOLUTE GUEST PATH (`/home/<user>/higgs_v3_merged/…`). It is
 *             what the launch script receives, the guest has a fixed home, and
 *             the directory is deliberately NOT under /mnt — the 9p mount would
 *             dominate an 8.5 GB load. Refused if it is relative.
 *   `darwin`  a path RELATIVE TO THE APP'S userData DIRECTORY
 *             (`runtime/higgs-models/<dir>`), resolved to an absolute path at
 *             document-write time. A Mac's Application Support path carries the
 *             username, so an absolute `/Users/<user>/…` in a REPO-TRACKED
 *             catalog is a directory that exists on exactly one machine — which
 *             is the failure this catalog exists to prevent. The app knows its
 *             own userData; the catalog does not. Refused if it is absolute, and
 *             refused if it climbs out with `..`.
 *
 * AND A COPY IS A NEW CERTIFICATE. The same merged directory on both machines is
 * the same weights, but a cap is measured against (directory, backend), so
 * staging deathstalker on the Mac does not carry the served arm's number across
 * — and since 2026-09-28 the number itself is the serving machine's, on GET /v1/voices.
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
   * `/home/<user>/…` directory that does not exist there.
   */
  checkpoint?: HiggsCheckpointLocations;
  /** v2-only chat role. Present for shape parity; v3 has no scene mechanism. */
  scene?: string;
}

/*
 * A VOICE'S PACE AND ITS GUARD BAND ARE THE SERVER'S (2026-09-28). This file kept a fine-tune's measured
 * pace ({median, p05, p99, ...}) and derived the guard band from it here - pace x 1.3 above (a take that
 * stopped early), pace / 1.3 below (one that ran on); the 1.3s were MEASURED on Shift, 2026-09-08. Owen
 * ruled the voice's facts have one owner, the machine that serves it: the pinned crucible-voice.toml's
 * pace block, which `GET /v1/voices` states with all three rates, and which every render already sends
 * back as its band (`renderBandFor`, `electron/crucible/voice-band.ts`). The seed-and-retrack rule
 * (narrator's PaceTracker re-centres on the book's own running median after ten guarded takes) is
 * unchanged; only where the seed comes from moved.
 */

/**
 * THE SILENCE INSERTED AFTER EVERY CHUNK, in seconds — this voice's own number.
 *
 * Higgs is a `pads = false` engine: it emits BARE SPEECH and the manifest's gapBefore/gapAfter
 * are what the assembler realizes as real silence. `text/prep.py` writes those into gaps.json at
 * PREP time from `text/gaps.classify_gap`, whose floor is an env override. Until this field
 * existed nothing set it per voice, so every Higgs voice shipped the same hardcoded 0.6 s.
 *
 * `injectS` IS THE INJECT, NOT THE TARGET JOIN, and the difference is the whole bug class here.
 * A join is (the model's own trailing silence + the inject). That tail is voice-specific —
 * 0.22 s measured on sigma — so:
 *
 *     injectS = targetJoinS - modelSelfTailS
 *
 * Putting the target in this field lands every join long by the tail. orpheus-models.json
 * records that exact mistake as how thirdreich ended up 0.24 s long on every join.
 *
 * A NEGATIVE result is a real answer and means inject nothing: the model's tail already exceeds
 * the target, and assembly cannot subtract silence — the remedy is the corpus tail (--tail-s).
 * Declare 0 in that case, which also disables the floor so chunks meet on the model's own pause.
 *
 * Measured by `pipeline/untreated/pause_match.py` against a scored ladder run and the training
 * corpus. RE-MEASURE AFTER A RETRAIN: tail geometry moves with the corpus.
 */
export interface HiggsChunkGap {
  /** Seconds the assembler inserts after each chunk. Net of the model's own tail. */
  injectS: number;
  /** What the join should come to: injectS + modelSelfTailS. Recorded so the sum is checkable. */
  targetJoinS: number;
  /** The trailing silence the model emits by itself, measured. */
  modelSelfTailS: number;
  /** The narrator's own inter-sentence pause in the training clips, for reference. */
  readerSentenceGapS?: number;
  /** The model's inter-sentence pause INSIDE one render — its own rhythm. */
  modelInternalGapS?: number;
  /** Which target was chosen, since the candidates disagree and it is an ear call. */
  rule: string;
  /** How the numbers were counted, stated so two gaps can be compared. */
  method: string;
  source: string;
  measuredOn: string;
}

/** A chunk gap is well-formed or absent, and its parts must add up. */
function refuseMalformedChunkGap(model: HiggsModel, gap: unknown): void {
  if (gap === undefined) return;
  const g = gap as Partial<HiggsChunkGap> | null;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const str = (v: unknown) => typeof v === 'string' && !!v.trim();
  if (!g || typeof g !== 'object' || !num(g.injectS) || !num(g.targetJoinS)
      || !num(g.modelSelfTailS) || !str(g.rule) || !str(g.method) || !str(g.source)
      || !str(g.measuredOn)) {
    throw new Error(
      `Higgs voice "${model.id}" has a malformed chunkGap ${JSON.stringify(gap)}. The shape is ` +
        '{injectS, targetJoinS, modelSelfTailS, rule, method, source, measuredOn}, ' +
        'numbers >= 0 (readerSentenceGapS and modelInternalGapS optional).',
    );
  }
  // The sum is checked because the field that matters is the one a reader is most likely to fill
  // in wrongly: injectS must be the target NET OF THE TAIL, not the target itself.
  const sum = (g.injectS as number) + (g.modelSelfTailS as number);
  if (Math.abs(sum - (g.targetJoinS as number)) > 0.011) {
    throw new Error(
      `Higgs voice "${model.id}" declares chunkGap injectS ${g.injectS} + modelSelfTailS ` +
        `${g.modelSelfTailS} = ${sum.toFixed(3)}, which is not its targetJoinS ${g.targetJoinS}. ` +
        'injectS is the inject, NET of the tail the model already emits — not the target join.',
    );
  }
}
/**
 * Where a `maxChars` came from — a CLOSED SET, mirroring narrator's
 * `MAX_CHARS_SOURCES` in `engine/protocol.py`, which refuses anything else.
 * The reasoning behind a number goes in `_maxCharsNote`, not here.
 */
export type HiggsMaxCharsSource = 'catalog' | 'placeholder' | 'length-sweep';

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
 * certificate. A FINE-TUNE's cap and band are no longer declared here at all (2026-09-28): they are
 * the server's, per arm, on `GET /v1/voices`. What remains here per arm is what this machine does
 * with the audio and the reference - edge fades, the reference cap, the allowed controls - and a
 * zero-shot voice's cap and target.
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
   * which for an adapter WAS a refusal here. A fine-tune declares no cap here at all since
   * 2026-09-28: it is the server's, and a row with none is refused as crucible_voice_states_no_cap.
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
  maxCharsSource?: HiggsMaxCharsSource | null;
  /**
   * WHY this `maxChars` is the number — prose, read by people. The catalog has
   * carried it on 17 blocks since the first length sweep; it is declared here so
   * a per-run override can state its reason in the same place the catalog does
   * (`maxCharsSource` is a CLOSED SET narrator validates, so the reasoning
   * cannot go there). No protocol reads it.
   */
  _maxCharsNote?: string;
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
   * THE SAFE BAND, in characters: the floor and the cap the prep packs
   * BETWEEN. Owen, 2026-09-09: "every chunk should fall within that range
   * unless there's an exceptional case."
   *
   * Measured the same day (orpheus-finetune field notes 4n.37.20) as the
   * TRAINING CORPUS'S INTERQUARTILE RANGE: tr_v3's IQR 532-985 predicted its
   * measured best band 600-1000 (4/80 = 5.0 % early stops [2.0-12.2], against
   * 18.8 % below 600 and 20.3 % above 1000). Pearson r = -0.64 between a
   * rung's training density and its early-stop rate.
   *
   * `safeMinChars` is the half that did not exist. Until it did, the floor and
   * the cap were ONE number (`targetChars`), and the merge rule requires the
   * RESULT to fit the cap - so two 400-char paragraphs could not combine under
   * a 700 cap and a 400-char chunk shipped. That is what Owen saw live on
   * 2026-09-09: truncations at 323, 502 and 634 characters, all of them below
   * the floor. A voice declaring neither packs exactly as it did before.
   *
   * `safeMaxChars` may never exceed this arm's `maxChars`, and the floor may
   * never reach the cap - refused on BOTH sides, here and in narrator's
   * `engine/higgs/config.py`.
   */
  safeMinChars?: number | null;
  safeMaxChars?: number | null;
  /** Provenance of the safe band, in the style of `_maxCharsNote`. */
  _safeBandNote?: string | null;
  /**
   * Assembly-time fades on every chunk. Higgs emits no pads of its own, so the
   * decoded chunk ends at a hard sample boundary and joins click without these.
   */
  edgeFadeMs?: { in: number; out: number };
  /**
   * Sampling, sent inside `extra_params` — NEVER at the request top level.
   *
   * `repetitionPenalty` is a SERVED-ARM-ONLY lever and belongs in a per-backend
   * block, never in the engine-level one. mlx-audio's `higgs_audio_v3` has no
   * repetition penalty at all — `Model.generate` takes no such argument (narrator
   * `engine/higgs/PORT_NOTES.md` 13.11) — so `HiggsV3MlxConfig.__post_init__`
   * REFUSES the key rather than accepting a lever it would silently drop. Writing
   * it at the catalog top would therefore refuse every Mac render.
   */
  sampling?: { temperature?: number; topP?: number; topK?: number; repetitionPenalty?: number };
  /** REQUIRED beside a per-backend `sampling`: the REASON it deviates from the engine-level one. */
  _samplingNote?: string;
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

export interface HiggsModel {
  id: string;
  label: string;
  /**
   * THE SPEAKER, WITHOUT THE KIND — "Third Reich", not "Zero-shot · Third Reich
   * (reference clip on base Higgs v3)". Required on a `clips` voice, where the
   * Crucible picker (`crucible/voice-picker.ts`) lists the four zero-shot
   * clones under their own "Zero-shot" heading (Owen, 2026-09-28) and the
   * heading says what `label` otherwise has to say in every row. `label` keeps
   * the word for every flat list, which is what the "Zero-shot" check in
   * `higgsNarrationVoices` still enforces.
   */
  speakerName?: string;
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
  /**
   * PRESENT ⇒ THIS MODEL IS NOT THE CATALOG'S. It was derived for ONE RUN by
   * `higgsModelForRender` from the catalog voice named in its `id`, and this is
   * who asked and why. Never written to `higgs-models.json`: an override is one
   * person at one machine, and the catalog is repo-tracked and shared by two.
   *
   * It is load-bearing in three places, not decoration: `refuseMisshapedCheckpointPath`
   * lets an ABSOLUTE darwin checkpoint through only for a derived model, the
   * voice document carries it so a post-mortem can tell an override render from
   * a catalog one, and the prep spawn logs it.
   */
  _overrideNote?: string;
  note?: string;
  /** The silence inserted after every chunk. ONE PER VOICE, shared by both arms. */
  chunkGap?: HiggsChunkGap;
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
  /** THE ENGINE-LEVEL SAMPLING every voice renders at — see higgsEngineSampling. */
  sampling: HiggsSampling;
  _samplingNote?: string;
  models: HiggsModel[];
}

export interface HiggsSampling { temperature: number; topP: number; topK: number }

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
  return cat as HiggsCatalog;
}

/*
 * THE SAFE BAND OVERLAY (`electron/data/higgs-safe-bands.json`) IS GONE, and so are a fine-tune's
 * band, pace and cap in this catalog (Owen, 2026-09-28: "single source of truth. that source should
 * be where the models are served"). A voice's band lived in five places; three redeploys in one day
 * updated the overlay and not this catalog, the overlay's consistency check threw, and the Narrate
 * picker listed no voices. The voice's truth is its pinned revision's crucible-voice.toml, surfaced
 * per server by `GET /v1/voices` (`electron/crucible/voice-band.ts`), and every door that packs or
 * guards already reads it there. `tools/test-one-fact-one-owner.js` keeps the copies from coming back.
 */

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
 * THE ONE SAMPLING every Higgs voice renders at, on both arms, for Listen
 * streaming and book renders alike — 0.7 / 0.95 / 50: measured on gibberish
 * (2026-09-09) and again on the Mac batched path (2026-09-11: a 0.6 trial fired
 * the length guard on 21 of 62 chunks against 4 at 0.7, silence loops to the
 * cap, and halved a render); 0.8 "the boson default" before that, with every
 * superseded reason kept in the catalog. Stated ONCE at the catalog's top
 * with its reason in `_samplingNote`, written into every voice document by
 * `higgsVoiceCapsForModel`, and applied by narrator over the checkpoint's own
 * generation_config.json (which says 1.0 and was not chosen). Refused, not
 * defaulted, when the catalog lacks it: the number that renders is written
 * here or nowhere.
 */
export function higgsEngineSampling(): HiggsSampling {
  const cat = loadCatalog();
  const s = cat.sampling as Partial<HiggsSampling> | undefined;
  const ok = !!s && typeof s === 'object'
    && typeof s.temperature === 'number' && s.temperature > 0
    && typeof s.topP === 'number' && s.topP > 0 && s.topP <= 1
    && Number.isInteger(s.topK) && (s.topK as number) > 0;
  if (!ok) {
    throw new Error(
      `Higgs voice catalog carries no valid engine-level sampling (${JSON.stringify(s)}); `
      + 'expected {temperature > 0, topP in (0,1], topK a positive integer} at the catalog top. '
      + 'Every voice renders at it, so it must be written.');
  }
  if (typeof cat._samplingNote !== 'string' || !/reason/i.test(cat._samplingNote)) {
    throw new Error("Higgs voice catalog's engine-level sampling has no `_samplingNote` stating its REASON; a number that deviates from the checkpoint's own file must say why.");
  }
  return { temperature: s.temperature as number, topP: s.topP as number, topK: s.topK as number };
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
  refuseOversizedReference(model, arm);
  return model;
}

/**
 * A CATALOG STILL WRITTEN THE OLD WAY IS REFUSED, NOT READ.
 *
 * `voice.checkpointDir` was one string for one machine, and it held the WSL
 * guest's path — so on the Mac it wrote a `/home/<user>/…` directory into the
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
  if (model.chunkGap !== undefined) refuseMalformedChunkGap(model, model.chunkGap);
  for (const arm of ['served', 'mlx'] as const) {
    if (model.backends?.[arm] && 'pace' in (model.backends[arm] as object)) {
      throw new Error(
        `Higgs voice "${model.id}" puts a pace on backends.${arm}. A voice's pace is the ` +
          "server's (Owen, 2026-09-28: single source of truth, where the models are served): it " +
          "lives in the voice's crucible-voice.toml and reaches BookForge on GET /v1/voices. " +
          'Remove it from electron/data/higgs-models.json.',
      );
    }
  }
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
 * catalog is usually edited, and a darwin entry written as `/Users/<user>/…`
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
    // GUEST-RESIDENT, in either form Windows can spell it. `/home/<user>/…` is
    // the guest's own name for the directory, and `\\wsl$\<distro>\home\…` is the
    // UNC form the Windows side uses for the same ext4 directory (tool-paths.ts
    // documents it for `orpheusModelsDir`); `windowsToWslPath` folds the second onto
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
  //
  // A PER-RUN OVERRIDE IS THE ONE ABSOLUTE darwin CHECKPOINT THAT IS LEGAL, and
  // the reason is the mirror of the reason the catalog's is not. The catalog is
  // REPO-TRACKED and read by two machines, so `/Users/<user>/…` in it names a
  // directory that exists on exactly one of them. An override is typed by the
  // person sitting at THIS machine, for THIS run, and is never written to the
  // catalog — so an absolute path is the only spelling it can have (there is no
  // reason a merged checkpoint under test would sit inside the app's userData).
  // `higgsModelForRender` has already proved it is a directory that exists.
  if (model._overrideNote && path.isAbsolute(value)) return;
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
  // ALREADY ABSOLUTE ⇒ ALREADY THE ANSWER. Only a per-run override gets here
  // with one (`refuseMisshapedCheckpointPath` refuses an absolute path in the
  // catalog by name), and joining userData onto it would produce a path inside
  // Application Support that has never held those weights. The userData refusal
  // below still governs every RELATIVE value, which is every catalog voice.
  if (path.isAbsolute(value)) return value;
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

/*
 * A FINE-TUNE MUST CARRY ITS OWN MEASURED CAP - still the rule, no longer this file's to enforce
 * (2026-09-28). A fine-tuned Higgs checkpoint's stop length tracks its training clip length, so the
 * zero-shot 600 would silently lose most of every chunk; the cap has to come from that model's own
 * length sweep. It lives in the voice's crucible-voice.toml now, and `GET /v1/voices` states it per
 * server: `bandFromVoiceRow` (`electron/crucible/voice-band.ts`) refuses a row with no cap as
 * `crucible_voice_states_no_cap`, by name, before anything is packed. The local check that stood here
 * (`refuseUnmeasuredAdapter`) read this catalog's copy of the number, and gated the picker on it.
 */

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
  if (served.safeMinChars !== undefined) caps.safeMinChars = served.safeMinChars;
  if (served.safeMaxChars !== undefined) caps.safeMaxChars = served.safeMaxChars;
  if (served.edgeFadeMs !== undefined) caps.edgeFadeMs = served.edgeFadeMs;
  // SAMPLING: the engine-level one (higgsEngineSampling), for every voice on
  // every arm. A block may override it only with its reason written beside it.
  if (served.sampling !== undefined) {
    if (typeof served._samplingNote !== 'string' || !/reason/i.test(served._samplingNote)) {
      throw new Error(
        `Higgs voice '${model.id}' (${BACKEND_FOR_ARM[arm]}) carries its own sampling `
        + `${JSON.stringify(served.sampling)} with no _samplingNote stating the REASON it deviates `
        + "from the engine-level sampling. Owen's rule (2026-09-06): one default everywhere; "
        + 'a deviation says why or is refused.');
    }
    caps.sampling = served.sampling;
  } else {
    caps.sampling = higgsEngineSampling();
  }
  if (served.referenceSecondsCap !== undefined) caps.referenceSecondsCap = served.referenceSecondsCap;
  if (served.allowedControls !== undefined) caps.allowedControls = served.allowedControls;
  return caps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering something the catalog has not certified
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE RUN'S DEVIATION FROM THE CATALOG — a merged checkpoint under test, or a
 * knob being swept, named by the person at the keyboard instead of by the repo.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-11: "i just tried to use the cli on a merged checkpoint as a
 * test here on the mac and it wouldnt let me … we should be able to pick any
 * model specifically, including a checkpoint we want to test." He was right and
 * the refusal was `resolveHiggsModel`'s: every Higgs door resolves a voice out of
 * `higgs-models.json`, so a directory that had not been promoted into the catalog
 * yet could not be rendered AT ALL — which is the wrong trade for a freshly
 * merged checkpoint, whose whole purpose is to be listened to before anybody
 * writes a certificate for it.
 *
 * The CLI's value is that it drives THE APP'S path (see CLAUDE.md: "CLI drives
 * the app path"), so the answer cannot be a second spawn route that skips the
 * catalog — that route would stop catching the app's bugs on the day it was
 * written. It is this: derive a model from a real catalog voice, and let every
 * door downstream keep working exactly as it does for a book.
 *
 * ── Why it travels in the VOICE DOCUMENT and not as a flag ──────────────────
 *
 * `checkpointDir` in `NARRATOR_HIGGS_VOICES` is how narrator learns a directory
 * on BOTH arms, and they use it differently: the Mac's MLX backend LOADS the
 * model from it (`mlx_backend.HiggsV3MlxConfig.model_dir`) and the PC's served
 * arm STARTS ITS SERVER on it (`v3_served.checkpoint_serve_target`,
 * `sgl_served`). So an override that lands in the document needs no per-arm code
 * here and no new narrator flag — the same mechanism a promoted voice uses.
 *
 * ── What an override does NOT buy, deliberately ─────────────────────────────
 *
 * It is DERIVED FROM A NAMED CATALOG VOICE and all of that voice's refusals
 * still apply (unknown id, not installed, untranscribed clip, unmeasured arm).
 * Its caps, pace and safe band travel unchanged unless overridden, which means a
 * checkpoint under test renders against the PRODUCTION voice's certificate. That
 * is the point rather than a shortcut: a render whose band moved with the weights
 * is not comparable to the book the band was measured on. Sweep the band by
 * saying so (`safeMinChars` / `safeMaxChars`), not by accident.
 *
 * A `clips` base is refused with a checkpoint, because narrator's shapes are not
 * additive: "the checkpoint IS the voice" (`config.load_voices`), and a clips
 * entry carrying `checkpointDir` would load the fine-tune AND condition it on a
 * zero-shot reference — a mixed condition nothing has measured, and one that
 * still renders and still reports success.
 *
 * ── `note` is required ─────────────────────────────────────────────────────
 *
 * It goes into the voice document (`_overrideNote`) and into the prep log, so a
 * post-mortem can tell an override render from a catalog one. A measurement
 * whose provenance is "someone passed a directory" is a measurement nobody can
 * repeat, and this codebase has already paid for that once: the runtime Orpheus
 * manifest's stale `maxCharsPerSec` looked authoritative and was not.
 */
export interface HiggsRenderOverride {
  /**
   * A MERGED CHECKPOINT DIRECTORY — the weights to render with.
   *
   * ABSOLUTE, and in the filesystem of the arm that will load it: a host path on
   * the Mac (proved to exist here), a GUEST-NATIVE path on the WSL arm
   * (`/home/…`, passed verbatim — the host cannot stat it, and a `C:` path would
   * drag 8.5 GB of weights through the 9p mount).
   */
  checkpointDir?: string;
  /**
   * temperature / topP / topK, any subset. MERGED over the engine-level sampling
   * rather than replacing it, because narrator takes a voice's `sampling` block
   * whole (`config._voice_sampling`: "a deviating block restates every value it
   * means to keep") and a partial block would silently drop the rest to the
   * checkpoint's own generation_config.json — 1.0, which nobody chose.
   */
  sampling?: Partial<HiggsSampling>;
  /*
   * NO CAP OR BAND (retired 2026-09-28, Owen: "crucible is now the single source of truth"). A
   * voice's cap and band are its crucible-voice.toml's, on GET /v1/voices, and a Crucible render
   * packs to those whole; an override's own had not reached a render since 2026-09-15.
   * `cli/higgs-override.js` refuses the three old fields by name.
   */
  /** WHO ASKED AND WHY. Required — see the header. */
  note: string;
}

/**
 * THE MODEL THIS RUN RENDERS WITH: the catalog's, or the catalog's with one
 * run's override derived onto it.
 *
 * With no override this IS `resolveHiggsModel(voiceId)` — same object, same
 * refusals, zero behavioural change for every existing caller. That identity is
 * the reason this is the function the render doors call rather than a branch at
 * each of them.
 *
 * The derived model is a DEEP COPY, so nothing an override patches can reach the
 * catalog object a later call reads (the catalog is re-read per call, but the
 * object it hands back is shared within one).
 */
export function higgsModelForRender(
  voiceId: string | undefined | null,
  override?: HiggsRenderOverride,
): HiggsModel {
  const base = resolveHiggsModel(voiceId);
  if (!override) return base;

  const note = (override.note || '').trim();
  if (!note) {
    throw new Error(
      'A Higgs render override carries no `note`. It is required: the note is what the voice '
      + 'document and the log say about WHY this run did not use the catalog, and an override '
      + 'render nobody can attribute is a measurement nobody can repeat. Say who asked and why.',
    );
  }

  const arm = thisMachineArm();
  const backend = BACKEND_FOR_ARM[arm];
  const dir = (override.checkpointDir || '').trim();
  const derived: HiggsModel = JSON.parse(JSON.stringify(base));
  // The id NAMES BOTH HALVES, because it is what `--higgs_voice` carries, what
  // keys the voice document, and what the session and the analytics record. A
  // bare "override" in a log six weeks later answers nothing.
  const slug = dir ? path.basename(dir.replace(/[\\/]+$/, '')) : 'override';
  derived.id = `${base.id}+${slug}`;
  derived._overrideNote = note;

  if (dir) {
    if (base.kind === 'clips') {
      throw new Error(
        `Higgs render override: voice "${base.id}" is kind 'clips' (zero-shot cloning) and a `
        + 'checkpoint cannot be derived onto it. THE CHECKPOINT IS THE VOICE — narrator says exactly '
        + 'that in engine/higgs/config.py ("the checkpoint IS the voice - there is nothing to serve '
        + 'without it") — so an entry carrying both would load the fine-tune AND '
        + 'condition it on a reference clip, which is a mixed prompt nothing has measured and which '
        + `renders anyway. Derive the override from a 'checkpoint' or 'default' voice instead `
        + `(e.g. the voice whose certificate the test should be judged against).`,
      );
    }
    if (arm === 'darwin') {
      if (!path.isAbsolute(dir)) {
        throw new Error(
          `Higgs render override: the checkpoint ${JSON.stringify(dir)} is not absolute. On the `
          + "Mac an override names a directory on THIS machine's disk, so it is an absolute host "
          + 'path — the userData-relative spelling belongs to the catalog, which is repo-tracked '
          + 'and has to work on two machines.',
        );
      }
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) {
        throw new Error(
          `Higgs render override: the checkpoint ${JSON.stringify(dir)} is not a directory on this `
          + 'Mac. Refusing to render — narrator would load nothing from it, and the MLX backend '
          + "would fall back to the base weights, which is a DIFFERENT SPEAKER (12 % of the "
          + "narrator's ECAPA ceiling) rendered as a success.",
        );
      }
    } else {
      // wsl: a GUEST path, and the host cannot check it.
      if (!dir.startsWith('/')) {
        throw new Error(
          `Higgs render override: the checkpoint ${JSON.stringify(dir)} is not a guest-resident `
          + 'path. On this arm the weights are loaded INSIDE the WSL guest, so the override is the '
          + "guest's own absolute path (\"/home/<user>/…\") and is passed verbatim — Windows "
          + 'cannot stat it to check, which is exactly why the spelling is refused here rather '
          + 'than guessed at. A C: drive path is not an alternative spelling: it is a different '
          + 'directory, read over the 9p mount, which is ruinous for 8.5 GB of weights.',
        );
      }
    }
    derived.kind = 'checkpoint';
    // ONLY THIS ARM. The other arm is not claimed: the override names a directory
    // on the machine the person is sitting at, and writing it under both arms
    // would assert a copy exists on a disk nobody has looked at.
    const checkpoint: HiggsCheckpointLocations = {};
    checkpoint[arm] = dir;
    derived.voice = { ...derived.voice, checkpoint };
  }

  const patchedBackends = derived.backends ?? (derived.backends = {});
  const block: HiggsBackendCaps = { ...(patchedBackends[backend] ?? {}) };

  if (override.sampling) {
    // THREE LAYERS, IN THE ORDER THE CODEBASE ALREADY STATES THEM: the catalog's
    // engine-level sampling (the number every voice renders at), then this arm's
    // own block if it deviates (with its reason, which `higgsVoiceCapsForModel`
    // enforces), then this run's override. Starting from the engine level rather
    // than from the block ALONE matters for a partial block: narrator's
    // `_voice_sampling` warns that a block replaces rather than merges, so a
    // block stating only `repetitionPenalty` would otherwise leave the override
    // with no temperature to validate and blame the override for the gap.
    const inherited = {
      ...higgsEngineSampling(),
      ...(higgsVoiceCapsForModel(base, arm).sampling ?? {}),
    };
    const merged = {
      ...inherited,
      ...(override.sampling.temperature !== undefined ? { temperature: override.sampling.temperature } : {}),
      ...(override.sampling.topP !== undefined ? { topP: override.sampling.topP } : {}),
      ...(override.sampling.topK !== undefined ? { topK: override.sampling.topK } : {}),
    };
    // REFUSED HERE, NOT AT THE SAMPLER. narrator validates the document too, but
    // an hour into a WSL server launch is a worse place to learn that a top_p of
    // 95 was typed where 0.95 was meant — and a temperature of 2.5 does not
    // fail, it babbles for a whole book.
    if (!Number.isFinite(merged.temperature) || (merged.temperature as number) <= 0
        || (merged.temperature as number) > 2) {
      throw new Error(
        `Higgs render override for "${base.id}": temperature ${JSON.stringify(merged.temperature)} `
        + 'is outside (0, 2]. The catalog renders at 0.8 for a measured reason (a 0.6 trial fired '
        + 'the length guard on 21 of 62 chunks, 2026-09-11); a value past 2 is not a hotter read, '
        + 'it is a book of babble that reports success.',
      );
    }
    if (!Number.isFinite(merged.topP) || (merged.topP as number) <= 0 || (merged.topP as number) > 1) {
      throw new Error(
        `Higgs render override for "${base.id}": topP ${JSON.stringify(merged.topP)} is outside `
        + '(0, 1]. top_p is a probability mass, so 95 is not 0.95.',
      );
    }
    if (!Number.isInteger(merged.topK) || (merged.topK as number) <= 0) {
      throw new Error(
        `Higgs render override for "${base.id}": topK ${JSON.stringify(merged.topK)} is not a `
        + 'positive whole number of candidates.',
      );
    }
    block.sampling = merged;
    // THE REASON IS WRITTEN BY CONSTRUCTION. `higgsVoiceCapsForModel` refuses a
    // block-level sampling whose `_samplingNote` does not state a reason (Owen's
    // rule, 2026-09-06: one default everywhere, a deviation says why), and an
    // override is exactly such a deviation — so it carries its own note rather
    // than being the one case that is exempt.
    block._samplingNote = `reason: per-run override — ${note}`;
  }

  patchedBackends[backend] = block;
  return derived;
}

/**
 * The half of `electron/crucible/voice-band.ts`'s `CrucibleVoiceBand` that a
 * voice document carries. Structural, and declared here as well as there, so
 * this module — which imports no Electron and no SDK — stays free of both.
 * `tools/test-crucible-venue-band.js` compares the two shapes rather than
 * trusting them.
 */
export interface CrucibleStatedBand {
  /** The registered server the numbers came from — goes into the document's note. */
  server: string;
  /** Crucible's voice id the row belonged to. */
  voice: string;
  /** The cap certificate for this (voice, backend) on that server. */
  maxChars: number;
  /**
   * The packing ceiling, ALREADY RESOLVED by `venuePackingCeiling` — the row's
   * `safe_max_chars` when it states one, else the cap, never above the cap. The
   * rule has one owner and it is not this module; this field is its answer.
   */
  ceilingChars: number;
  /** The merge floor the venue states (`safe_min_chars`), or null. */
  floorChars: number | null;
  /**
   * The target, ALREADY RESOLVED by `venuePackingTarget` — the server's when it
   * states one, else the local catalog's clamped to the ceiling, else null.
   */
  targetChars: number | null;
  paceCharsPerSec: number | null;
  maxCharsPerSec: number | null;
  minCharsPerSec: number | null;
}

/**
 * The base model's placeholder chunk length — what a voice with no safe band and
 * no target is packed to. It is narrator's `v3_served.MAX_CHARS` (600), which
 * `higgs_v3_prep_budget` read through `HiggsV3Defaults.MAX_CHARS` until the rule
 * moved here; `tools/test-higgs-prep-budget.js` holds the two equal while the
 * engine half is still in this repo.
 */
export const HIGGS_PREP_PLACEHOLDER_CHARS = 600;

/** The two numbers a Higgs prep packs a book between. */
export interface HiggsPrepBudget {
  /** The merge floor: short paragraphs travel together until a group reaches it. */
  floorChars: number;
  /** The packing cap: no group crosses it. */
  capChars: number;
}

/**
 * THE BAND A HIGGS PREP PACKS TO, from the rendering Crucible's numbers.
 *
 * Until 2026-11-04 this rule lived in narrator's model code
 * (`engine/higgs/v3_engine.py:higgs_v3_prep_budget`), which read the voice
 * document `higgsVoicesDocument` wrote and re-derived the band from it. Prep is
 * BookForge's text work and the engine half is leaving for Crucible
 * (docs/REORG-PLAN.md, B1), so the rule moved to the side that already holds the
 * venue's band — `CrucibleStatedBand`, from `GET /v1/voices` — and prep is
 * handed the answer as `--chunk_max_chars` / `--chunk_floor_chars`.
 *
 * The rule is the old one, branch for branch, over the same numbers the
 * document carried (`safeMinChars` = `floorChars`, `safeMaxChars` =
 * `ceilingChars`, `targetChars` = `targetChars`):
 *
 *  - a floor AND a ceiling → pack between them;
 *  - otherwise a FINE-TUNE is refused by name: its band is measured on its own
 *    training clips, and packing it at the base model's placeholder is a book
 *    rendered at someone else's length;
 *  - otherwise (the model's own voice, a zero-shot clone) the target is both
 *    floor and cap, and with no target the placeholder is;
 *  - a stated floor at or above the ceiling is not a band, and is refused.
 *
 * Note what a ceiling WITHOUT a floor does for a non-fine-tune: the target (or
 * the placeholder) wins, not the ceiling. That is what narrator did, and this
 * is a move, not a redesign.
 */
export function higgsPrepBudget(model: HiggsModel, band: CrucibleStatedBand): HiggsPrepBudget {
  const floor = band.floorChars;
  const ceiling = band.ceilingChars;
  let floorChars: number;
  let capChars: number;
  if (floor && ceiling) {
    // A STATED floor at the ceiling is not a band (narrator's loader refused it
    // as `_safe_band`): the merge rule could never end a group on the floor.
    // floor == cap is legitimate only as the single number below.
    if (floor >= ceiling) {
      throw new Error(
        `Higgs voice "${model.id}": crucible "${band.server}" states safe_min_chars ${floor} at or `
        + `above its packing ceiling ${ceiling} for voice "${band.voice}", which is not a band.`,
      );
    }
    floorChars = floor;
    capChars = ceiling;
  } else if (model.kind === 'checkpoint') {
    throw new Error(
      `Higgs voice "${model.id}" is a fine-tune and crucible "${band.server}" states no safe band `
      + `for it (safe_min_chars ${JSON.stringify(floor)}, safe_max_chars ${JSON.stringify(ceiling)} `
      + `for voice "${band.voice}" on GET /v1/voices). Its band comes from THAT model's own training `
      + `clip lengths, in its crucible-voice.toml — refusing to pack a book at the base model's `
      + `${HIGGS_PREP_PLACEHOLDER_CHARS}-char placeholder.`,
    );
  } else if (band.targetChars) {
    floorChars = capChars = band.targetChars;
  } else {
    floorChars = capChars = HIGGS_PREP_PLACEHOLDER_CHARS;
  }
  if (floorChars > capChars || capChars <= 0) {
    throw new Error(
      `Higgs voice "${model.id}" has a safe floor ${floorChars} and cap ${capChars} from crucible `
      + `"${band.server}", which is not a band the packer can pack between.`,
    );
  }
  return { floorChars, capChars };
}

/**
 * The narration picker's view of the catalog: `{value,label}` rows, with a
 * voice that cannot render yet marked in its LABEL rather than dropped.
 *
 * The voice-list shape (`NarrationVoice`) so the modal's dropdown code is the
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
    .filter((m) => SELECTABLE_VOICE_KINDS.has(m.kind) && !PICKER_HIDDEN_VOICE_KINDS.has(m.kind))
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

/**
 * THE CATALOG VOICE ONE JOB RENDERS IN — the one resolver every door shares.
 *
 * Moved here from `higgs-spawn.ts` when the local spawn layer was deleted
 * (docs/LEGACY-REMOVAL.md); it was always a CATALOG question rather than a spawn
 * one, and it sat there only because the spawn was its first caller.
 *
 * Sharing it is load-bearing. A render resolves its voice at several doors — the
 * argv, the retake ladder, the Listen path, the Crucible render — and if one of
 * them resolved the catalog voice while another resolved the per-run override,
 * the two would disagree about which voice the book is in. narrator's reaction to
 * a voice it was not given is NOT a crash: `load_voices` returns a map, the
 * lookup misses, and a whole book renders in the base model's own speaker — a
 * different person, measured at 12% of the narrator's ECAPA ceiling.
 */
export function higgsModelForJob(settings: {
  fineTuned: string;
  higgsOverride?: HiggsRenderOverride;
}): HiggsModel {
  return higgsModelForRender(settings.fineTuned, settings.higgsOverride);
}
