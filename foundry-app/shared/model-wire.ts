/**
 * THE MODEL PANEL'S WIRE — what an engine holds, what it could fetch, and how a
 * fetch is getting on.
 *
 * ── The ruling ─────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-16 (*"the Ollama standard"*, crucible `docs/INTENT.md`):
 * Crucible is set-and-forget, and **all configuration happens through BookForge
 * and Foundry**. A person's only direct contact with Crucible is the tray icon
 * and the installer. That reverses PHASE13's ruling of two days earlier, which
 * moved the pull list onto Crucible's own operator page and deleted it from both
 * apps.
 *
 * ── EVERY FIGURE HERE IS THE SERVER'S, AND SOME OF THEM ARE ABSENT ────────
 *
 * The rule this file is written to, and it is the same one the fit estimate
 * follows: **the side that can see the thing at the moment it matters is the
 * side that says so.** So nothing here is computed on the app side — not a
 * download size, not a disk check, not a verdict about whether a pull will fit.
 * Where the server declares no number, this wire carries `null` and the screen
 * says it is not known. Inventing one would be this app answering a question it
 * cannot see the answer to, in a place a person would reasonably trust.
 */

/**
 * WHICH KIND OF SUBJECT A CATALOG ROW IS — the server's own six words.
 *
 * SIX, NOT FIVE. The SDK's own doc comment says *"The five things a subject can
 * be"* and then lists six: `engine` was added for the llama.cpp binaries a
 * `llama-windows` server runs its GGUF models with (PHASE15-HOST.md §3.10), and
 * the sentence above it did not move. Counted from the union rather than from
 * the prose, because the prose is wrong — which is exactly why this list is
 * spelled out here and checked, rather than trusted.
 *
 * SPELLED OUT RATHER THAN `string`, and rather than re-exported from the SDK.
 * The SDK's own union is the HTTP truth and this is the IPC truth
 * (`engine-settings.ts` argues the division); typing it `string` would let a
 * renderer send a word no server has and have it refused three layers away,
 * with the sentence naming an SDK type nobody on this side can see.
 *
 * A KIND THIS BUILD HAS NEVER HEARD OF IS REFUSED BY NAME at the seam
 * (`crucible-models.ts`), not silently cast: reaching that means the engine is
 * newer than this app, which is a fact worth saying out loud rather than an
 * error to launder into a failed pull.
 */
export type CrucibleSubjectKind =
  | 'model' | 'voice' | 'rvc' | 'rvc-base' | 'denoise' | 'engine';

/** The six, as a list, so the seam can check a word against them. */
export const SUBJECT_KINDS: readonly CrucibleSubjectKind[] =
  ['model', 'voice', 'rvc', 'rvc-base', 'denoise', 'engine'];

/**
 * ONE THING AN ENGINE HOLDS OR COULD FETCH — `GET /v1/catalog`, mirrored.
 *
 * A MIRROR RATHER THAN A RE-EXPORT, for `engine-settings.ts`'s reason one wire
 * along: this crosses the preload, and a renderer type whose definition lives in
 * `node_modules` is a renderer whose shapes change when a tarball is
 * re-vendored, silently.
 */
export interface CrucibleCatalogRow {
  kind: CrucibleSubjectKind;
  id: string;
  /** The manifest's display name, or null where a manifest carries none. */
  name: string | null;
  /** `llm`, `asr`, `align`, `tts` … — which job type this belongs to. */
  jobType: string;
  installed: boolean;
  /** Bytes on disk, or null when it is not installed. */
  installedBytes: number | null;
  /**
   * WHAT A PULL WILL FETCH, OR NULL — AND NULL IS THE ORDINARY ANSWER FOR A
   * MODEL.
   *
   * The contract is explicit: the manifest declares this for `rvc`, `rvc-base`
   * and `denoise`, whose weights are named files with pinned digests, and it is
   * *"**Null for models and voices**, whose weights are a whole-repo snapshot no
   * manifest sizes. **Never an estimate.**"*
   *
   * So the model panel — which is about models — will draw "size not known
   * until it runs" on nearly every row it shows, and that is the honest
   * sentence. The temptation is to fill it from the resident figure of a similar
   * model, or from the fit estimate, and both would be this app inventing a
   * download size for somebody about to spend it.
   */
  expectedBytes: number | null;
  /** The classes this model is the FLOOR for. Only ever non-empty on a model. */
  floors: string[];
  /** `hf:<repo>` — where the bytes come from. */
  source: string;
}

/**
 * HOW A PULL IS GETTING ON.
 *
 * A pull's own shape rather than the module task's, even though one loop
 * produces both (`followTask`, electron/crucible-coordinate.ts). A module
 * carries two fields a pull never has — the job types a `reload` step made
 * reachable, and the classes an engine could not serve — and handing those to
 * the model panel would be handing it fields that are null forever, which a
 * reader has to discover is not a bug.
 */
export interface CruciblePullProgress {
  server: string;
  taskId: string;
  /** Which row this is about, so a card with several pulls can place it. */
  kind: CrucibleSubjectKind;
  id: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  /** Which step of how many, when the server names one. */
  step: { name: string; index: number; total: number } | null;
  /**
   * Bytes of the file being fetched. `total` is null where the server did not
   * state one — see {@link CrucibleCatalogRow.expectedBytes}: for a model it
   * usually will not, so a bar drawn from this has to survive having no
   * denominator rather than inventing a percentage.
   */
  bytes: { done: number; total: number | null; file: string } | null;
  /** Why the server did nothing — already installed, most often. */
  skipped: string | null;
  /** The server's own refusal. Steps that completed STAY (ARCHITECTURE.md R6). */
  error: { code: string; message: string } | null;
}
