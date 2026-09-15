/**
 * llm-catalog — the vendored model catalogue, and the one fact still read off it.
 *
 * ── WHAT THIS FILE STOPPED BEING, AND WHY ───────────────────────────────────
 *
 * It was "the model lineup, and which of it this machine can run": a merged
 * table of Crucible's manifests and Foundry's own Ollama rows, with a memory
 * fit test, a floor per class, a recommendation for the wizard and a resolver
 * that picked the largest installed model an act could open with.
 *
 * Owen, 2026-09-15: *"we dont have any local models. crucible handles all model
 * orchestration. if theres no connected crucible server then tiles should be
 * disabled. crucible is a service that foundry installs locally and connects
 * to."* Every model lives on an engine, the ENGINE chooses which one (its
 * capability record's `selected`, crucible docs/PHASE15-HOST.md §3.3), and
 * Foundry sends work to it. So there is no machine to measure here, no floor
 * for this app to enforce, no model for it to recommend and nothing for it to
 * pull — and `model-lineup-local.json`, which existed only to give the wizard
 * smaller Ollama tags to offer, is deleted rather than kept as a table nobody
 * reads.
 *
 * ── WHAT IS LEFT, AND WHO READS IT ──────────────────────────────────────────
 *
 * `app/shared/model-lineup.json` is **Crucible's own `foundry-lineup.json`**,
 * vendored byte for byte (docs/SLOTS.md §4: *"Crucible's manifests are the
 * catalog of record"*). It stays, and it has exactly two readers:
 *
 *   1. {@link pagesForm} — the page reader's GGUF pair. `page-reader.ts` is the
 *      ONE path to an EPUB on a machine that cannot install WSL, it downloads
 *      those two files itself, and this table is the one owner of "which
 *      weights is the reader" (see that function).
 *   2. {@link LINEUP_PROVENANCE} — the line the "Models on this machine" card
 *      prints so a stale vendored copy is eventually caught by a person.
 *
 * Nothing here edits the vendored file: a keeper compares OUR copy against a
 * fresh generator emission BY CONTENT, which is only possible while nothing
 * here edits it.
 *
 * ── THE ORDER IS STILL COMPUTED, AND IT IS NOW ONLY A TIE-BREAK ─────────────
 *
 * The merged list used to be sorted smallest-first because a floor was a
 * POSITION in it and `lineupFor` walked it forward. Neither exists any more, so
 * the sort survives for one narrow reason: `pagesForm` takes the FIRST `pages`
 * row, and a generator that emitted two would otherwise hand a different answer
 * between two re-vendors of the same manifests. Sorted by `needsGB.value` with
 * the id breaking ties, the answer cannot wobble.
 */
import type { ModelClass } from '../shared/types';

/*
 * THE VENDORED TABLE. `resolveJsonModule` is on in tsconfig.electron.json, and
 * `rootDir` is `app/`, so tsc copies it to `dist/shared/` beside the emitted
 * JavaScript and electron-builder's `dist/shared/**` picks it up. The RENDERER
 * never imports it — its tsconfig has no `resolveJsonModule`, and it has no
 * business holding a catalog: everything it needs off this table arrives
 * already decided, over IPC.
 */
import lineupFile from '../shared/model-lineup.json';

/** Where a `needsGB` came from: somebody measured it, or somebody computed it. */
export interface ModelNeeds {
  value: number;
  basis: 'measured' | 'declared';
}

/** The model as ollama holds it: one tag, pulled through ollama's own library. */
export interface OllamaForm {
  kind: 'ollama';
  tag: string;
  downloadGB: number;
  needsGB: ModelNeeds;
}

/**
 * The model as llama.cpp holds it: a GGUF, and — for a vision model — the
 * separate projector `--mmproj` takes. Two files, because that is how llama.cpp
 * serves a vision tower; see page-reader.ts, which downloads exactly this pair
 * AND TAKES THESE FOUR FIELDS FROM HERE rather than from constants of its own
 * (`pagesForm()` below). One owner for "which weights is the reader".
 *
 * `revision` IS A COMMIT AND NOT A BRANCH on Crucible's row, and both the index
 * read and the download URL use it, so a repository re-cut upstream cannot
 * change what a machine fetches under a checksum recorded against something
 * else.
 */
export interface GgufForm {
  kind: 'gguf';
  hf_repo: string;
  revision: string;
  file: string;
  mmproj: string;
  downloadGB: number;
  needsGB: ModelNeeds;
}

export type LocalForm = OllamaForm | GgufForm;

/**
 * One row of the vendored catalog, as the file declares it.
 *
 * THE FIELDS MIRROR THE FILE RATHER THAN THE READERS, on purpose: this is the
 * shape of somebody else's generated document, and a type that quietly dropped
 * the members nothing here asks about would stop being a description of it. So
 * `classes`, `minimum` and `minimumFor` are all here and only `classes` is
 * read — `minimum` and `minimumFor` were the floor, which was this app deciding
 * which model an act needs, and the engine decides that now.
 *
 * `crucible: boolean` STOOD HERE and is gone with the second file: it recorded
 * which of two catalogs a row came out of, and there is one catalog.
 */
export interface LineupRow {
  /** Crucible's own model id. */
  id: string;
  classes: readonly ModelClass[];
  label: string;
  description: string;
  local: LocalForm;
  minimum: boolean;
  minimumFor: readonly ModelClass[];
}

/** The vendored file's shape, as far as anything here needs to know it. */
interface LineupFile {
  generated_from: string;
  models: readonly LineupRow[];
}

/**
 * ★ THE LINEUP ★ — the vendored rows, ordered smallest first. See the header
 * for why the sort survived the readers that needed it.
 *
 * ONE CAST, AND IT IS NOT A SHRUG. `resolveJsonModule` widens every string in a
 * JSON file to `string`, so `"ollama"` does not arrive as the literal `'ollama'`
 * and no amount of annotation makes the assignment check itself. The alternative
 * is a validator that runs at module load and throws — which would mean the app
 * refusing to start because a file that ships INSIDE it is malformed, a state
 * that cannot survive one run of the build. So the shape is asserted here and
 * proved by the keeper that compares this file against Crucible's generator
 * output, which is where a shape disagreement actually originates.
 */
const CATALOG = lineupFile as unknown as LineupFile;

export const MODEL_LINEUP: readonly LineupRow[] = [...CATALOG.models].sort((a, b) => (
  a.local.needsGB.value - b.local.needsGB.value || a.id.localeCompare(b.id)
));

/**
 * WHEN FOUNDRY TOOK THIS COPY — a fact about THIS repository, which Crucible's
 * generated file does not carry and must never be edited to carry.
 *
 * It lived in `model-lineup-local.json`'s `vendoredWith` block, beside Foundry's
 * own rows, and that file is deleted. A hand-written const is the right new home
 * for the same reason the block was never merged into the vendored file: a
 * hand-edited copy of a generated document silently loses the hand edits on the
 * next re-vendor. `generated_from` is NOT repeated here — the vendored file
 * states it itself, and two copies of one commit hash is the drift this const
 * exists to avoid.
 *
 * UPDATED BY HAND WHEN THE FILE BESIDE IT IS RE-VENDORED, in the same commit.
 */
export const VENDORED_WITH = {
  file: 'foundry-lineup.json',
  repo: 'telltaleatheist/crucible',
  branch: 'feat/phase6-remote-render',
  commit: '3de1671',
  at: '2026-09-15',
} as const;

/**
 * Where the table came from, for the settings row to print.
 *
 * `generatedBy` NAMES CRUCIBLE'S COMMIT and the manifests it was generated
 * from; `generatedAt` is the date this app VENDORED it. It no longer counts
 * "plus N of Foundry's own rows", because there are none.
 */
export const LINEUP_PROVENANCE: { generatedBy: string; generatedAt: string } = {
  generatedBy: `crucible ${VENDORED_WITH.file} @ ${VENDORED_WITH.commit} `
    + `(generated from ${CATALOG.generated_from.slice(0, 12)})`,
  generatedAt: VENDORED_WITH.at,
};

/**
 * THE PAGE READER'S WEIGHTS, as the catalog names them — the `pages` row's local
 * form, and the ONE OWNER of "which GGUF pair is the reader".
 *
 * page-reader.ts held its own `HF_REPO`/`MODEL_FILE`/`MMPROJ_FILE` constants
 * until Wave 61 package E, and two owners of that fact is how a re-vendored
 * catalog silently disagrees with what the installer actually fetches. It reads
 * them from here now. NULL is possible — a catalog with no `pages` row at all —
 * and the reader treats it as "this build cannot install a reader", which is an
 * honest refusal rather than a fallback to a repository nothing named.
 */
export function pagesForm(): GgufForm | null {
  const row = MODEL_LINEUP.find(
    (entry) => entry.classes.includes('pages') && entry.local.kind === 'gguf',
  );
  return row === undefined ? null : row.local as GgufForm;
}
