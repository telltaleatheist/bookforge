/**
 * THE CATALOG — every subject a server could hold, and the two acts on it.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * Owen, 2026-09-17, on what the AI settings page should be: *"i think this
 * page should be a big set of AI options that are applied to the crucible
 * server the user has selected … there should be a translation and a simplify
 * option that lets me pick which model is used for that. it can pick from a
 * list of available models, maybe with a more button that lets the user
 * download other models to the crucible server if they want to use that one
 * instead."* And the same for voices.
 *
 * THREE OF THOSE FOUR THINGS ALREADY HAD A DOOR. Which model serves a class is
 * `localModels` on the engine's settings document; what fits is the capability
 * record; both already cross this app's IPC. The one with NO door was the list
 * of everything else — the models and voices a server COULD have and does not
 * — and without it a model picker can only ever offer what is already on the
 * disk. `GET /v1/catalog` is that list, `POST /v1/tasks` with a `pull` is how a
 * subject gets onto the machine, and `DELETE /v1/catalog/{kind}/{id}` is how it
 * leaves.
 *
 * ── The HuggingFace question, answered honestly ────────────────────────────
 *
 * Owen asked for the voice list to be "connected to hugging face". It is, and
 * this is the whole of how: every row's {@link CrucibleCatalogRow.source} is
 * `hf:<repo>` — the repo the bytes come from — and a pull fetches that repo
 * onto the server. What this is NOT is a SEARCH of HuggingFace: Crucible serves
 * the subjects its manifests declare, there is no endpoint that queries the
 * Hub, and a box that appeared to search it would be a box that cannot.
 * A row here is always something this machine could really have.
 *
 * ── Nothing here is stored ─────────────────────────────────────────────────
 *
 * Same rule as the settings document (PHASE15 §0): the catalog is READ from
 * the server every time it is drawn. There is no `<userData>` copy, because a
 * cached "what is installed" is a claim about somebody else's disk.
 */
import type { CrucibleModuleProgress } from './settings-wire';

/**
 * The SIX things a subject can be.
 *
 * A HAND-WRITTEN MIRROR OF THE SDK'S `SubjectKind`, and the SDK's own comment
 * says what happens to those: Foundry wrote a five-member mirror from a prose
 * sentence that said "five" after the union had grown to six, and shipped an
 * engine that could not fetch its own llama.cpp. So this one is not trusted to
 * be right by reading — `electron/crucible/catalog.ts` assigns the SDK's union
 * to this one and this one to the SDK's, in both directions, so the compiler
 * fails the build the day they differ.
 */
export const CRUCIBLE_SUBJECT_KINDS = [
  'model', 'voice', 'rvc', 'rvc-base', 'denoise', 'engine',
] as const;

export type CrucibleSubjectKind = (typeof CRUCIBLE_SUBJECT_KINDS)[number];

/** One row of `GET /v1/catalog`. */
export interface CrucibleCatalogRow {
  kind: CrucibleSubjectKind;
  id: string;
  /** The manifest's display name, or null where a manifest carries none. */
  name: string | null;
  /**
   * Which job type it belongs to: `llm`, `tts`, `asr`, `align`, … — or null
   * where the server did not say (Crucible 1.0.25 reads an absent
   * informational field as null; Owen 2026-09-24, any Crucible that answers).
   */
  jobType: string | null;
  installed: boolean;
  /** Bytes on disk, or null when it is not installed. */
  installedBytes: number | null;
  /**
   * What a pull will fetch, where the manifest declares it — `rvc`, `rvc-base`
   * and `denoise`, whose weights are named files with pinned digests. **Null
   * for models and voices**, whose weights are a whole-repo snapshot no
   * manifest sizes. Never an estimate, so a screen must say "size unknown"
   * rather than invent one.
   */
  expectedBytes: number | null;
  /**
   * The capability classes this model is the FLOOR for. Only ever on a model.
   * Null = the server did not say, which is not the same as "none".
   */
  floors: string[] | null;
  /** `hf:<repo>` — where the bytes come from, or null where the server did not say. */
  source: string | null;
  /** Is this the thing on the card right now? */
  resident: boolean;
}

export interface CrucibleCatalogView {
  /** The registry name this was read from. Rows are only true of that server. */
  server: string;
  rows: CrucibleCatalogRow[];
}

/**
 * A pull in flight.
 *
 * The task half is {@link CrucibleModuleProgress} VERBATIM rather than a
 * parallel shape, because a pull and a module post are the same SSE contract
 * read by the same follower — `followTask` in `electron/crucible/module-setup.ts`.
 * A second progress type would be a second reading of one stream, and the two
 * would drift on the first event kind that got added.
 *
 * What is added is WHICH SUBJECT, which the stream does not carry: the events
 * name files, not subjects, so a page with two rows downloading could not tell
 * which row a frame belonged to.
 */
export interface CruciblePullProgress {
  kind: CrucibleSubjectKind;
  id: string;
  task: CrucibleModuleProgress;
}

/**
 * What a removal would take with it, answered BEFORE anything is deleted.
 *
 * Owen's ruling via crucible `docs/MODEL-CHOICE.md` §7 is that an app may call
 * the delete door, *"behind a confirm that names the SIZE — deciding about
 * 17.3 GB is a different decision from deciding about 'a file'"*. So the size
 * is a field rather than something the confirm dialog goes and works out, and
 * `null` means the server did not say — which is drawn as "size unknown", not
 * as zero.
 */
export interface CrucibleRemovalPrompt {
  kind: CrucibleSubjectKind;
  id: string;
  name: string | null;
  installedBytes: number | null;
  /** True when the weights are on the card right now: removing means unloading. */
  resident: boolean;
}
