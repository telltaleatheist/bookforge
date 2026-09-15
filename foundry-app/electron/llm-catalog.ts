/**
 * llm-catalog — the model lineup, and which of it this machine can run.
 *
 * ── WHY THERE IS A TABLE AT ALL ──────────────────────────────────────────────
 *
 * `qwen3.8:27b` is the standing default for every language task (Owen,
 * 2026-08-22: *"27b is the standard we'll use for every task"*), and it will not
 * run on an ordinary computer. Seventeen gigabytes of weights need a card most
 * people do not have; the concrete machine this was written for has eight. A
 * default nobody's hardware can honour is not a high standard, it is an app
 * that appears broken on the first translation somebody tries.
 *
 * So setup measures the machine and offers the LARGEST MODEL THAT ACTUALLY
 * FITS. The lineup is the shipping-model line — not the coding variants, not
 * the BF16 conversions kept for a different runtime — because every row here is
 * something a person is going to run through ollama for prose.
 *
 * ── THE TABLE IS NO LONGER A CONST IN THIS FILE, AND IS NOW TWO FILES ────────
 *
 * `app/shared/model-lineup.json` is **Crucible's own `foundry-lineup.json`**,
 * vendored byte for byte (docs/SLOTS.md §4: *"Crucible's manifests are the
 * catalog of record"*). Its generator reads the manifests' `[local]` blocks —
 * an Ollama tag, or a GGUF plus its mmproj — with a memory figure and the BASIS
 * of that figure, and emits the file; a keeper compares OUR copy against a fresh
 * emission by content, which is only possible while nothing here edits it. So
 * nothing here edits it.
 *
 * `app/shared/model-lineup-local.json` is **Foundry's own additions** and its
 * header argues the whole case. In one line: Crucible lists the three models a
 * Crucible serves, and Foundry's local path is not a Crucible — it is Ollama on
 * whatever card the person already owns, and Ollama's library carries the
 * smaller quantised Qwen tags that Crucible has no manifest for. Dropping them
 * would leave the wizard on an 8 GB laptop offering exactly one model, 17.7 GB,
 * which the same screen then marks as too big for the machine. Every id in that
 * file is prefixed `foundry/` so a row of ours can never collide with a Crucible
 * id, and `crucible: false` on the merged row records which file it came from.
 *
 * THE MERGED ORDER IS COMPUTED, NOT READ. Everything below depends on the
 * lineup being SMALLEST FIRST — `lineupFor` takes the last one that fits,
 * `eligibleFor` slices at a floor's POSITION, act-gates names "the largest
 * present one" — and neither file is sorted (Crucible's emits in manifest
 * order). So the two are concatenated and sorted by `needsGB.value`, ties broken
 * by id so the order cannot wobble between runs. Sorting here rather than asking
 * Crucible to sort keeps the vendored file comparable by content.
 *
 * Every `needsGB.basis` in both files is `"declared"` today — the download plus
 * the overhead argued below, arithmetic rather than a measurement — and the day
 * Crucible measures a model's real resident footprint that row's basis becomes
 * `"measured"` and this file does not change.
 *
 * ── THE HEADROOM IS DELIBERATELY GENEROUS, AND ERRS SMALL ────────────────────
 *
 * A declared `needsGB` is the download plus `OVERHEAD_GB`. The overhead is not a
 * fudge: a loaded model also holds a KV cache sized by the context, the runner's
 * own buffers, and whatever the desktop compositor has already taken off the
 * card. 1.5 GB is roughly what that costs at an ordinary context on an ordinary
 * machine, and being wrong in this direction costs somebody a smaller model than
 * they could have had — which they can change in one field — while being wrong
 * in the other direction costs them an hour of a translation running at a word a
 * second, or an out-of-memory failure after a seventeen-gigabyte download. Those
 * two mistakes are not the same size and the number reflects it.
 *
 * THE CONSTANT IS STILL HERE, and it is no longer what the rows are built from:
 * it is what the hand-written JSON was built WITH, and what a future row with no
 * figure at all would fall back to. The file's numbers win.
 *
 * A CONSEQUENCE, STATED SO IT IS NOT MISTAKEN FOR A BUG: an 8 GB card is
 * offered `qwen3.5:4b`, not `qwen3.5:9b`. 6.6 + 1.5 is 8.1, and 8.1 does not
 * fit in 8.0. The row is still there, still installable, and still says why it
 * is marked as not fitting.
 *
 * ── AND ONE PLACE THE RULE INVERTS: A MACHINE WITH NO GPU ───────────────────
 *
 * "Largest that fits" is the right rule only while memory is what binds. With
 * no GPU it is not — see the argument at the branch in `lineupFor` — so a
 * processor-only machine is recommended the SMALLEST model, not the largest its
 * RAM could hold.
 *
 * ── ONE ROW THE OLD CONST DID NOT HAVE, AND IT IS THE APP'S OWN DEFAULT ──────
 *
 * `qwen3.8:27b` is `DEFAULT_TRANSLATE_MODEL` (shared/pipeline.ts) and the Clean
 * text picker's largest option, and it was NOT in `QWEN_LINEUP` — so the wizard
 * could recommend, describe and pull every model except the one every dialog
 * opens with. That is a hole rather than a decision, and the vendored file
 * closes it: Crucible's `qwen3.8-27b-4bit` row names exactly that tag.
 *
 * ── AND THE FLOOR, WHICH OWEN SETTLED ON 2026-09-14 ─────────────────────────
 *
 * *"i think either they use the 27b or they use an api key for Claude or OpenAI.
 * thats probably the best solution."* So `minimumFor: [translate, simplify]`
 * sits on a 27B in BOTH files, and a machine that cannot hold one is offered
 * those two acts by a Crucible, by a cloud provider, or not at all.
 *
 * It took three passes to get there, and the wrong two are worth keeping because
 * each was a faithful reading of what was said at the time. Package D's
 * hand-written table put the floor on the 9B, from *"smaller than 9b"*.
 * Crucible's generated file first floored ANALYSIS there too, which darked a
 * tile on a 12 GB card; Owen named translate and simplify, so analysis lost its
 * floor at the source (Crucible e73467b) and now carries none in either file.
 * Then the 9B floor itself went, because *"at least the 9B"* turned out to mean
 * the 27B when he said which model he meant.
 *
 * `model-lineup-local.json` declares the floor on `qwen3.5:27b` rather than
 * leaving it to the vendored file's `qwen3.8:27b`, and the reason is arithmetic
 * rather than preference: the two are 0.7 GB apart, the smallest declared floor
 * wins, and a floor at the larger one would dark Translate on a card holding a
 * genuine 27B. If that is wrong it is a fact in Crucible's manifests and is
 * fixed there and re-vendored — the vendored file is never patched here.
 */
import type { LlmModelOption, ModelClass, SystemProfile } from '../shared/types';

/*
 * THE TWO VENDORED TABLES. `resolveJsonModule` is on in tsconfig.electron.json,
 * and `rootDir` is `app/`, so tsc copies both to `dist/shared/` beside the
 * emitted JavaScript and electron-builder's `dist/shared/**` picks them up. The
 * RENDERER never imports either — its tsconfig has no `resolveJsonModule`, and
 * it has no business holding a catalog: everything it needs off this table
 * arrives already decided, over IPC.
 */
import lineupFile from '../shared/model-lineup.json';
import localLineupFile from '../shared/model-lineup-local.json';

/** Weights plus working room, for a `declared` figure. See the header. */
export const OVERHEAD_GB = 1.5;

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

/** One row of the vendored catalog — either file's, once merged. */
export interface LineupRow {
  /**
   * The model id. Crucible's own for a row out of `model-lineup.json`, and
   * `foundry/<something>` for one of ours — see that file's header for why the
   * prefix is load-bearing rather than decorative.
   */
  id: string;
  /**
   * False for a row Crucible has no manifest for — a model that exists only as
   * an Ollama tag on this machine. DERIVED FROM WHICH FILE THE ROW CAME OUT OF
   * rather than written in either of them: the vendored file is compared by
   * content against a fresh generator emission, so a field of ours inside it
   * would fail that comparison for ever.
   */
  crucible: boolean;
  classes: readonly ModelClass[];
  label: string;
  description: string;
  local: LocalForm;
  /**
   * Whether this row is the floor for anything at all. Crucible's generator
   * emits it beside `minimumFor`, and it is exactly `minimumFor.length > 0`, so
   * NOTHING READS IT — `eligibleFor` asks the class list, because a boolean that
   * says "this is a floor" cannot say which class it is a floor for.
   */
  minimum: boolean;
  /**
   * The FLOOR this row sets for those classes — Owen: *"if their system just
   * isnt powerful enough for translation (smaller than 9b) then translation and
   * simplify is disabled."* Read by `eligibleFor`, argued there.
   */
  minimumFor: readonly ModelClass[];
}

/** Either file's shape, as far as anything here needs to know it. */
interface LineupFile {
  models: readonly LineupRow[];
}

/**
 * ★ THE LINEUP ★ — both files, merged and sorted SMALLEST FIRST, because that is
 * the order the screen reads in, because `lineupFor` walks it forward looking
 * for the last one that fits, and because a `minimumFor` floor is a POSITION in
 * this order.
 *
 * THE SORT IS BY `needsGB.value`, WHICH IS THE SAME NUMBER `fitsOn` DECIDES ON.
 * Sorting by the download size instead would put the bf16 9B (19.3 GB down,
 * 20.8 GB resident) below the 4-bit 27B (17.7 down, 19.2 resident) in the list
 * while the fit test ordered them the other way, and "the largest one that fits"
 * would then be able to pick a row that a larger machine is not offered. Ties
 * break on the id so that two rows of equal weight cannot swap places between
 * runs and move a floor with them.
 *
 * ONE CAST PER FILE, AND IT IS NOT A SHRUG. `resolveJsonModule` widens every
 * string in a JSON file to `string`, so `"ollama"` does not arrive as the
 * literal `'ollama'` and no amount of annotation makes the assignment check
 * itself. The alternative is a validator that runs at module load and throws —
 * which would mean the app refusing to start because a file that ships INSIDE it
 * is malformed, a state that cannot survive one run of the build. So the shape
 * is asserted here and proved by the keeper that compares the vendored half
 * against Crucible's generator output, which is where a shape disagreement
 * actually originates.
 */
export const MODEL_LINEUP: readonly LineupRow[] = [
  ...(lineupFile as unknown as LineupFile).models.map((row) => ({ ...row, crucible: true })),
  ...(localLineupFile as unknown as LineupFile).models.map((row) => ({ ...row, crucible: false })),
].sort((a, b) => (
  a.local.needsGB.value - b.local.needsGB.value || a.id.localeCompare(b.id)
));

/**
 * Where the table came from, for the settings row to print.
 *
 * `generatedBy` NAMES CRUCIBLE'S COMMIT rather than saying "hand-written", which
 * is what it said while package D's stopgap was in place. `generatedAt` is the
 * date this app VENDORED it — a fact Foundry owns and Crucible's file does not
 * carry — and it lives in `model-lineup-local.json`'s `vendoredWith` block,
 * beside the commit it was taken from, so the two halves of that sentence cannot
 * drift apart in two files.
 */
export const LINEUP_PROVENANCE: { generatedBy: string; generatedAt: string } = {
  generatedBy: `crucible ${localLineupFile.vendoredWith.file} @ `
    + `${localLineupFile.vendoredWith.commit} (generated from `
    + `${localLineupFile.vendoredWith.generated_from.slice(0, 12)}), plus `
    + `${(localLineupFile as unknown as LineupFile).models.length} of Foundry's own rows`,
  generatedAt: localLineupFile.vendoredWith.at,
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

/** The rows a person pulls through ollama for prose — the wizard's whole list. */
function textRows(): readonly LineupRow[] {
  return MODEL_LINEUP.filter(
    (row) => row.local.kind === 'ollama' && row.classes.includes('translate'),
  );
}

/**
 * Does ollama already hold this row?
 *
 * THE EXACT TAG, AND ONLY THE EXACT TAG. The docblock here used to claim a bare
 * name matched too — that somebody who ran `ollama pull qwen3.5` and holds
 * `qwen3.5:latest` should not be offered a download of weights they already
 * have — and the code never did it, for a reason worth writing down rather than
 * a second time deleting: `qwen3.5:latest` is ONE size, the library's default,
 * and nothing in this table says which. Matching it by bare name would mark
 * every row in the family installed, so the person with one model would be told
 * they have seven and offered no download at all. Being wrong about which one
 * they have is worse than offering a pull that ollama will answer instantly
 * from its own store.
 */
export function heldBy(row: LineupRow, held: ReadonlySet<string>): boolean {
  if (row.local.kind !== 'ollama') return false;
  return held.has(row.local.tag.toLowerCase());
}

/** The held names as a set, lowercased and trimmed, once per call rather than per row. */
export function heldSet(held: readonly string[]): Set<string> {
  return new Set(held.map((name) => name.trim().toLowerCase()));
}

/** Does this row's memory figure clear what a model can expect to have here? */
export function fitsOn(row: LineupRow, profile: SystemProfile): boolean {
  return row.local.needsGB.value <= profile.modelMemoryMB / 1024;
}

/**
 * The rows that may serve a class on this machine, in lineup order.
 *
 * ── `minimumFor` IS A FLOOR, NOT A NAME ─────────────────────────────────────
 *
 * Owen's rule is about SIZE — *"if their system just isnt powerful enough for
 * translation (smaller than 9b)"* — so a row carrying `minimumFor` marks a
 * position in the lineup and everything from there upward qualifies. Reading it
 * as "only this row lights translate" would leave a 24 GB card holding the 27B
 * and nothing else with a dark Translate tile, which is the opposite of the
 * rule's purpose. A class with no floor anywhere (clean) takes the whole list.
 *
 * ── TWO CATALOGS MAY EACH DECLARE ONE, AND THE SMALLEST WINS ────────────────
 *
 * `findIndex` takes the FIRST row in this order that names the class, which is
 * the smallest declared floor. Both files now floor translate and simplify at a
 * 27B (Owen, 2026-09-14: *"either they use the 27b or they use an api key"*),
 * and they name DIFFERENT 27Bs — Crucible serves `qwen3.8:27b` and Ollama's
 * library also carries `qwen3.5:27b`, 0.7 GB apart. Taking the smaller is what
 * admits both; taking the larger would dark Translate on a card holding a
 * genuine 27B over a rounding difference.
 *
 * What it must NEVER do is let one file lower the other below the rule. Nothing
 * mechanical enforces that — it is a property of what the two files say, and the
 * day a row here declares a floor Owen did not rule, this function will honour
 * it silently. The guard is that both floors are written down with his words
 * beside them, here and in `model-lineup-local.json`'s own note.
 *
 * ANALYSIS HAS NO FLOOR in either file and takes the whole list: he named
 * translate and simplify, and Crucible dropped analysis at the source
 * (e73467b) rather than leaving Foundry to disagree with the catalog.
 */
/**
 * The model an act should OPEN WITH on this machine — the answer to a question
 * that used to be answered by a setting written once and never revisited.
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `AppSettings.defaultLlmModel` is stamped by the first-run wizard and by the
 * Settings card, and the three language dialogs opened with it whatever else
 * happened afterwards. So: a 24 GB card runs setup, pulls the 9B, and the tag
 * is stored. Later the person pulls the 27B. The Translate TILE lights, because
 * a model at or above the floor is now installed — and the JOB still runs the
 * 9B, because that is what the tag says. The tile told the truth about the
 * machine and the run used something else, which is the gap Owen named:
 * *"i think we should be using the largest available compatible model."*
 *
 * ── WHAT IT ANSWERS, AND WHY THE STORED TAG STILL WINS SOMETIMES ────────────
 *
 * The stored tag wins when it is COMPATIBLE — installed, fitting, and at or
 * above this class's floor — because a person who picked a smaller model in
 * Settings picked it on purpose, usually for speed, and overriding a live
 * choice is not a fix. It loses only when it cannot serve the class at all,
 * and then the LARGEST that can is what opens, which is the same rule
 * `lineupFor` recommends by.
 *
 * When NOTHING qualifies the stored tag is handed back unchanged: the tile is
 * dark in that case and says why, and blanking a field underneath a refusal
 * would replace one honest sentence with an empty box.
 */
export function openingModelFor(
  cls: ModelClass,
  stored: string,
  profile: SystemProfile,
  held: ReadonlySet<string>,
): string {
  const usable = eligibleFor(cls)
    .filter((row) => fitsOn(row, profile) && heldBy(row, held));
  if (usable.length === 0) return stored;
  const wanted = stored.trim().toLowerCase();
  if (usable.some((row) => row.local.kind === 'ollama' && row.local.tag.toLowerCase() === wanted)) {
    return stored;
  }
  const best = usable[usable.length - 1]!;
  return best.local.kind === 'ollama' ? best.local.tag : stored;
}

export function eligibleFor(cls: ModelClass): readonly LineupRow[] {
  const serving = MODEL_LINEUP.filter((row) => row.classes.includes(cls));
  const floor = serving.findIndex((row) => row.minimumFor.includes(cls));
  return floor < 0 ? serving : serving.slice(floor);
}

/**
 * The lineup as this machine sees it: what fits, what is already pulled, and
 * the one row that carries the badge.
 *
 * EXACTLY ONE `recommended`, AND ONLY IF SOMETHING FITS. On a machine where
 * nothing does — no GPU and eight gigabytes of RAM, say — no row is badged, and
 * the caller's `suggested` falls to the smallest with the sentence about the
 * processor. Badging a row that does not fit would be recommending a model this
 * file has just said will not run.
 */
export function lineupFor(profile: SystemProfile, held: readonly string[]): LlmModelOption[] {
  const rows = textRows();
  const holdings = heldSet(held);

  const fitting = rows.filter((row) => fitsOn(row, profile));

  /*
   * ── WITH NO GPU, "FITS" AND "IS USABLE" COME APART ────────────────────────
   *
   * Everywhere else the recommendation is the largest thing that fits, because
   * memory is the binding constraint and a model that fits a card runs at that
   * card's speed. On a machine with no GPU at all, memory stops being the
   * binding constraint: sixteen gigabytes of system RAM will hold `qwen3.5:9b`
   * perfectly well and then generate at a word or two a second, which for a
   * three-hundred-page translation is not slow, it is not going to finish. The
   * largest that fits would be a recommendation nobody could use.
   *
   * So the CPU machine is recommended the SMALLEST, and the whole lineup is
   * still listed with its real fits/doesn't-fit against RAM, so somebody who
   * knows what they are doing and is willing to leave it running overnight can
   * pick a bigger one on purpose. The screen says the machine has no GPU in the
   * line above (`SystemProfile.detail`), which is the sentence that explains
   * why this row and not a larger one.
   *
   * THE TILES GO FURTHER AND REFUSE OUTRIGHT on that machine (act-gates.ts,
   * Owen: *"if a job is going to take an obscenely long time, like translation
   * on cpu, it should just be disabled"*). This function still lists everything,
   * because the wizard's job is to describe the machine and a list with nothing
   * in it describes nothing.
   */
  const best = profile.memoryBasis === 'ram'
    ? fitting[0] ?? null
    : fitting[fitting.length - 1] ?? null;

  return rows.map((row) => ({
    tag: row.local.kind === 'ollama' ? row.local.tag : row.id,
    label: row.label,
    downloadGB: row.local.downloadGB,
    needsGB: row.local.needsGB.value,
    description: row.description,
    fits: fitsOn(row, profile),
    recommended: best !== null && row.id === best.id,
    installed: heldBy(row, holdings),
  }));
}

/**
 * The tag the wizard preselects.
 *
 * The recommendation when there is one; the smallest model otherwise. The
 * second branch is not a fallback that hides a problem — the screen says in as
 * many words that nothing here fits and that this one will run on the
 * processor — it is the answer to "which of these is least bad on this
 * machine", which is a question with an answer even when none of them is good.
 */
export function suggestedTag(options: readonly LlmModelOption[]): string {
  const recommended = options.find((option) => option.recommended);
  if (recommended) return recommended.tag;
  const smallest = options[0]?.tag;
  if (smallest !== undefined) return smallest;
  const first = textRows()[0];
  return first !== undefined && first.local.kind === 'ollama' ? first.local.tag : '';
}
