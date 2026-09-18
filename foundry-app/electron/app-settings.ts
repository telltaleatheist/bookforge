/**
 * app-settings — the APP's own knobs, in the app's own file.
 *
 * `userData/app-settings.json`, deliberately NOT the engine's settings.json:
 * that file's schema belongs to the engine, is read by every `vlm-convert` on
 * the machine (BookForge's included), and describes WHERE reading happens.
 * Server lifecycle is nobody's concern but this app's — the engine neither
 * starts nor stops servers — so its knob lives here, where no other consumer
 * of the engine can trip over it.
 *
 * Same forgiveness rules as the engine-settings module: unknown keys in the
 * file are preserved on write and ignored on read, and out-of-range values
 * clamp to something legal rather than throwing — a hand-edited "999999" is a
 * user asking for "a long time", not a corrupt installation.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { app } from 'electron';

import { hostedLibraryDir } from './host';
import { readJson } from '../shared/json';
import {
  ANY_SLOT,
  GPU_DIAL_ANY,
  slotNameRefusal,
  tidySlotName,
  type CloudProviderKind,
  type NewJobsWaitFor,
} from '../shared/slots';
import {
  ANALYSIS_CATEGORY_IDS,
  CUSTOM_CATEGORY_DESCRIPTION_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  customCategoryId,
  type CustomAnalysisCategory,
} from '../shared/analysis-categories';

/**
 * ONE REGISTERED CRUCIBLE, AS IT IS STORED — the only shape in this app that
 * holds a token.
 *
 * It is declared here rather than in `shared/` on the rule that keeps secrets
 * out of the renderer by construction: `shared/` is compiled into the browser
 * bundle, and a type that lives there is a type somebody can reach for on the
 * other side of the preload without noticing. The renderer's shape is
 * `CrucibleServerView` (shared/slots.ts), which has a boolean where this has a
 * secret.
 */
export interface CrucibleServerEntry {
  /** What the picker calls it, and what a row's `waitFor` names. Unique. */
  name: string;
  /** The base URL WITHOUT `/v1`, which is what the SDK wants. No trailing slash. */
  url: string;
  /** The bearer token `crucible token --show` prints on that host. Never logged. */
  token: string;
  /** Off is not a slot at all: no picker entry, no `any` candidate. */
  enabled: boolean;
}

/** How many a person may register. A ceiling so "a list" cannot become a corpus. */
export const CRUCIBLE_SERVER_MAX = 8;

/**
 * ONE CONFIGURED CLOUD PROVIDER, AS IT IS STORED — the second shape in this app
 * that holds a secret, and it is here for the first one's reason exactly.
 *
 * `shared/` is compiled into the browser bundle, so a type carrying an `apiKey`
 * declared there is a type somebody can reach for on the far side of the
 * preload without noticing. The renderer's shape is `CloudProviderView`
 * (shared/slots.ts), which has a boolean where this has a credential.
 *
 * ── WHY THE MODEL IS ON THE ENTRY WHERE A CRUCIBLE HAS NONE ────────────────
 *
 * A Crucible ANSWERS which model it will serve a class with — `GET
 * /v1/capability` probes the card and selects, so a model field on a registry
 * entry would be a second opinion about a decision that has an owner. A provider
 * holds a catalog and has no opinion at all: the engine REFUSES a cloud run with
 * no `--model` (`MODEL_REQUIRED_ON_ANTHROPIC`, and the same argument on the
 * OpenAI door against a listing of dozens), so the id has to come from somewhere
 * and the only thing that knows it is the person paying for it.
 */
export interface CloudProviderEntry {
  /** What the picker calls it, and what a row's `waitFor` names. Unique. */
  name: string;
  /** Which engine door — and therefore which credential header. */
  kind: CloudProviderKind;
  /** The key. Never logged, never in argv, never across an IPC payload. */
  apiKey: string;
  /** The provider's own model id. Not validated against a list — see below. */
  model: string;
  /**
   * An OpenAI-compatible host, or EMPTY for the provider's own address
   * (`CLOUD_PROVIDER_ENDPOINT`). Empty is a real value and is not filled in at
   * rest: resolving it at the placement means a provider that moves its API is
   * one line of this build rather than a migration of everybody's settings file.
   */
  endpoint: string;
  /** Off is not a slot at all: no picker entry, nothing lit in the dock. */
  enabled: boolean;
}

/**
 * And its ceiling, {@link CRUCIBLE_SERVER_MAX}'s reason. Four is smaller than
 * eight because two providers exist and a person with more than a couple of keys
 * for them is doing something this card was not built for.
 */
export const CLOUD_PROVIDER_MAX = 4;

export interface AppSettings {
  /*
   * `keepServerWarmMinutes` AND `pageReaderRemoved` WERE HERE.
   *
   * One held the local reading server alive for a few minutes after the queue
   * drained, so the next book did not pay the model load; the other was the
   * receipt for an automatic removal -- a Crucible on this machine took over
   * page reading, so Foundry deleted its own copy and said so on a card.
   *
   * There is no local reading server and nothing of ours on the disk to
   * remove (2026-09-17). A stored key nothing reads is not harmless: it is a
   * setting somebody can find in the JSON, change, and watch do nothing.
   */

  /**
   * The folder this app treats as the user's library.
   *
   * `<libraryDir>/workspace` is where every conversion lands, and it is what
   * the Save pickers open on. It is under Documents rather than under userData
   * because a finished book is the user's property: userData is where an app
   * keeps its own bookkeeping, and a folder a person is expected to open,
   * back up and sync does not belong there.
   *
   * Changing it affects NEW work only. Nothing is migrated and nothing is
   * rewritten — recents hold absolute paths, and moving a hundred books because
   * a text field changed is not a thing a settings screen should do behind
   * somebody's back.
   */
  libraryDir: string;
  /**
   * THE CATEGORIES THIS PERSON WROTE — added in the analysis dialog, kept for
   * every book they ever analyse.
   *
   * Owen, 2026-08-25: *"maybe the user can add more categories - even
   * one-sentence descriptive ones. and they check off which ones they want to
   * search for in this document."* Two different questions, and they are stored
   * in two different places on purpose. WHAT CATEGORIES EXIST is a fact about
   * the reader — somebody who has decided a claim is worth hunting for wants it
   * on the checklist of the next book too — so it lives here, app-level, beside
   * the library folder. WHICH ONES ARE TICKED is a fact about one run, decided
   * in the dialog each time and travelling to the engine in that run's own
   * categories file; nothing about a tick is remembered here, because a
   * remembered tick is a run somebody paid an hour for without choosing to.
   *
   * IT IS NOT A MIRROR OF THE BUILT-INS. `ANALYSIS_CATEGORIES`
   * (shared/analysis-categories.ts) is the engine's own list and is never
   * written here; this holds only the additions, so an engine that grows a
   * thirteenth built-in does not have to reconcile itself with a file.
   */
  analysisCategories: CustomAnalysisCategory[];
  /*
   * ── THREE MODEL SETTINGS STOOD HERE, AND ALL THREE ARE DELETED ────────────
   *
   * `defaultLlmModel` (what Translate, Simplify and Analyse opened with),
   * `cleanTextModel` (Clean text's own, because the cleanup has its own
   * economy — ~9 blocks/min on the 27b against ~50 on the 9b-q8_0) and
   * `ollamaUrl` (where Ollama is).
   *
   * Owen, 2026-09-15: *"we dont have any local models. crucible handles all
   * model orchestration. if theres no connected crucible server then tiles
   * should be disabled."* The model a run uses is named by the ENGINE's own
   * capability record and applied at the spawn, so all three were settings that
   * could not affect a run. The cleanup's measured ratios moved to
   * `DEFAULT_CLEAN_TEXT_MODEL`'s own note (shared/pipeline.ts), which is where
   * the constant they argue for lives.
   *
   * THE ENGINE'S OLLAMA IS A DIFFERENT FACT AND IT SURVIVES: crucible
   * docs/PHASE15-HOST.md §3.2 keeps `upstreams.ollama.url` in the ENGINE's own
   * settings, written through `crucible:engine-settings`. This file's copy was
   * the duplicate, and a duplicate of somebody else's setting is the kind that
   * goes stale silently.
   */
  /**
   * ── THE SERVER REGISTRY — one entry per Crucible, IN PRIORITY ORDER ────────
   *
   * docs/SLOTS.md §3 and §6 (Package C). Each entry becomes one SLOT: a place a
   * compute-heavy job can go, beside the machine's own GPU. A person with none
   * of these never meets a picker at all — Owen: *"foundry should work if they
   * have no idea what theyre doing… but if they do know what theyre doing and
   * they want access to speed, they can use crucible."*
   *
   * THE ARRAY POSITION IS THE RANK. There is no `rank` field and there must not
   * be one; see `CrucibleServerView` (shared/slots.ts) for why two owners of one
   * ordering is a bug rather than a redundancy. A drag rewrites the array.
   *
   * THE TOKEN IS STORED HERE AND NOWHERE ELSE, and it never leaves the main
   * process: the settings card is told only whether one is set, the engine is
   * handed it in a per-spawn environment variable, and no log line, no command
   * line and no IPC payload carries it. The one exception to "stored here" is
   * the LOCAL server, whose token belongs to its own `config.toml` — and even
   * that one is copied into an entry at the moment somebody presses "Add local
   * Crucible", because a registry with a hole in it would mean two code paths
   * for every read below. What is not kept is a SECOND copy: the entry is the
   * copy, it is visible, and it can be replaced by pressing the button again.
   *
   * ── WHAT THIS REPLACED, AND THE MIGRATION, WHICH IS A DELETION ────────────
   *
   * Three keys are retired with this one, and none of them is read any more:
   *
   *   `llmServer: 'ollama' | 'vllm'` — the machine-wide choice of which door the
   *     three language acts spoke to. It is gone because the question moved: the
   *     LOCAL slot is Ollama, always (docs/SLOTS.md §2 — model required, unloaded
   *     always), and an OpenAI-compatible server is now a registry entry rather
   *     than a mode this app can be put into.
   *   `vllmUrl` — where that server was. A stored one becomes NOTHING. It is not
   *     migrated into an entry, and that is Owen's ruling rather than laziness:
   *     *"the plan is to leave VLLM to crucible only"*. An entry minted from this
   *     key would be a bare vLLM with no token, no capability record and no
   *     model listing — every read below would fail on it, and the failure would
   *     look like a broken registry rather than a setting that no longer exists.
   *   `vllmModel` — the served id that went with it. Nothing selects a model by
   *     hand on a Crucible slot: the capability record does (docs/SLOTS.md §5).
   *
   * A hand-edited file may still hold all three. They are simply not read, and
   * `writeAppSettings` preserves unknown keys, so nothing is destroyed by a
   * build that no longer understands them — which is what makes going back to an
   * older build a checkout rather than a restore.
   */
  crucibleServers: CrucibleServerEntry[];
  /**
   * ── THE CLOUD PROVIDERS — one entry per key somebody has connected ─────────
   *
   * docs/SLOTS.md §3 (Package F). Owen: *"give them the option of connecting an
   * api key for openai or claude instead of using the 27b or the 9b… for weaker
   * systems."* Each ENABLED entry becomes one SLOT, after every Crucible slot,
   * and it is never what `any` falls through to — a cloud run costs money, so
   * choosing one is a gesture with a person behind it.
   *
   * THE ORDER IS NOT A RANK here, unlike `crucibleServers`, and the difference is
   * worth naming rather than leaving to be discovered: the rank exists because
   * `any` walks the list, and `any` never reaches these. The array order is
   * simply the order the card draws them in.
   *
   * THE KEY IS STORED HERE AND NOWHERE ELSE, and it never leaves the main
   * process — `crucibleServers`' rule, one array along, with the same three
   * consequences: the card is told only whether one is set, the engine is handed
   * it in a per-spawn environment variable (`FOUNDRY_ENDPOINT_HEADERS`), and no
   * log line, no command line and no IPC payload carries it.
   */
  cloudProviders: CloudProviderEntry[];
  /**
   * WHAT A NEW ROW'S `waitFor` STARTS AS — Owen's *"New jobs wait for: (•)
   * top-ranked slot ( ) any"*.
   *
   * `top` resolves to a slot NAME at the press and writes that name on the row.
   * It deliberately does not write the word "top": a row that said "whatever is
   * ranked first" would change machines when somebody reorders the list while it
   * waits, and docs/SLOTS.md §3 rules the other way — *"queued rows do NOT move
   * when servers are re-ranked."*
   */
  newJobsWaitFor: NewJobsWaitFor;
  /**
   * THE LIVE QUEUE'S OWN MACHINE — Owen's *"global crucible server option"*, a
   * registered server's name or {@link GPU_DIAL_ANY}.
   *
   * ── Why it is here and not in a file of its own ──────────────────────────
   *
   * BookForge keeps theirs in `queue-gpu-dial.json`. This app has ONE settings
   * file with ONE clamping reader, and the dial is the same KIND of fact as the
   * field above it — a standing choice about where work goes, made once, read by
   * the queue. A second file would be a second place to look, a second corrupt-
   * file story and a second migration, for one string.
   *
   * ── AN UNKNOWN NAME IS KEPT, NOT DROPPED, AND THAT IS THE HARD PART ──────
   *
   * {@link clampQueueGpuDial} cannot ask the registry — this module IS the
   * registry's storage and a clamp that read the server list would be a cycle.
   * So a name that is not a server survives the read, and the PLACEMENT says so
   * by name. That is the right division anyway: a dial naming a server somebody
   * has temporarily switched off must keep its value (BookForge accepts a
   * disabled server for exactly this reason — refusing here would force somebody
   * to resolve two controls in one particular order), and "switched off" and
   * "never existed" are not distinguishable at the moment of a file read.
   */
  queueGpuDial: string;
  /**
   * WHICH WSL GUEST THE LOCAL CRUCIBLE LIVES IN — Windows only, and read for
   * exactly one thing: `cat`ting that server's own `config.toml`.
   *
   * Here rather than in the engine's `settings.json` because it stopped being
   * the engine's business. `backend.wslDistro` was the distro a vLLM was
   * launched in, by this app, through a launcher that no longer exists
   * (docs/SLOTS.md §6, Package B); this is the app remembering where to look for
   * a file. Two different facts that happened to share a guest.
   *
   * THERE IS NO DEFAULT AND AN EMPTY VALUE IS REFUSED AT THE READ, not filled
   * in. "The default distro" is whatever `wsl --set-default` last said, and a
   * server read out of the wrong guest is a wrong server — with a wrong token,
   * which is a 401 nobody can explain.
   */
  wslDistro: string;
  /**
   * TRUE ONCE SOMEBODY HAS BEEN THROUGH FIRST-RUN SETUP — finished OR dismissed.
   *
   * The absence of app-settings.json would have served as a first-run signal
   * and it is deliberately not the one used: the file is written the first time
   * anybody changes the library folder or adds an analysis category, so on the
   * machine where somebody poked at settings before setup ran, "no file" would
   * already be false and the wizard would never appear. An explicit marker says
   * the thing that is actually being asked.
   *
   * DISMISSING SETS IT. A wizard that came back every launch until it was
   * completed would be a wizard that punishes somebody for wanting to look at
   * the app first, and every step it offers is re-offered from the settings
   * screen, so nothing is lost by letting it go.
   */
  setupCompleted: boolean;
  /**
   * The steps that were moved past without doing the thing.
   *
   * Kept so the settings screen can say WHICH ones — "you skipped the analysis
   * worker" is actionable and "setup was not completed" is not. Free-form
   * strings rather than a union: a step id that no longer exists is a stale
   * entry the reader ignores, and a schema that refused it would turn renaming
   * a wizard step into a migration.
   */
  setupSkipped: string[];

}


/** How many a person may keep. A ceiling so "a list" cannot become a corpus. */
export const CUSTOM_CATEGORY_MAX = 40;

/** `~/Documents/Foundry`. Created on demand, never at startup. */
export function defaultLibraryDir(): string {
  return path.join(os.homedir(), 'Documents', 'Foundry');
}

/**
 * The fixed part of the defaults. `libraryDir`'s default is a FUNCTION
 * (`defaultLibraryDir`) rather than a constant because it reads the home
 * directory, and a module-level constant would freeze whatever HOME happened to
 * be when this file was first imported.
 */

function settingsFile(): string {
  return path.join(app.getPath('userData'), 'app-settings.json');
}

/** Whatever the file holds, as an object; null when absent or unreadable. */
function readRaw(): Record<string, unknown> | null {
  try {
    const parsed: unknown = readJson(fs.readFileSync(settingsFile(), 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Absent, unreadable or unparsable all read as defaults. Unlike the
    // engine's file this one has no other writers whose intent could be lost,
    // so there is nothing to protect by refusing.
    return null;
  }
}

/**
 * An absolute directory path, or the default.
 *
 * ABSOLUTE is the whole check: a relative path in this field would be resolved
 * against whatever the process's working directory happens to be — the install
 * directory when launched from the Start menu, and something else entirely when
 * launched from a terminal — so the same setting would name two folders.
 */
export function clampLibraryDir(value: unknown, fallback = defaultLibraryDir()): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) return fallback;
  return path.normalize(trimmed);
}

/**
 * ── THE HOST'S LIBRARY WINS, AND IT WINS HERE RATHER THAN AT EACH READER ────
 *
 * Hosted, the books live inside the host's own data directory
 * (docs/BOOKFORGE-HANDOFF.md §8) and `libraryDir` stops being a preference: it
 * is a fact about somebody else's folder layout. The obvious place to honour
 * that was `projectsDir()`, which is what actually composes
 * `<libraryDir>/projects` — but it is not the only reader. The Save-a-copy
 * dialog opens on the library, and `library:dir` answers the settings screen
 * with it, and a version of this that only fixed `projectsDir` would leave those
 * two naming a folder nothing in the app writes to any more.
 *
 * So the override is at the SETTING, and every reader is right for free. It goes
 * through `clampLibraryDir` exactly as a value out of the file does: a host that
 * hands over a relative path gets the same refusal a hand-edited file gets,
 * because the reason — the same setting naming two folders depending on where
 * the process was launched from — has nothing to do with who wrote it.
 *
 * WRITES ARE NOT REDIRECTED, and they do not need to be: the two IPC doors that
 * change this refuse outright while a host is mounted (`library:set`), so what
 * is in the file stays the standalone app's own answer, waiting unharmed for the
 * next time Foundry is run on its own.
 */
/**
 * The user's own categories, cleaned rather than refused.
 *
 * ── CLAMPING AND NOT VALIDATING, which is THIS file's philosophy ────────────
 *
 * The engine's settings.json refuses a write it cannot understand, because that
 * file has other writers whose intent could be destroyed. This one has exactly
 * one writer and no schema anybody else depends on, so the module header's rule
 * applies: *"out-of-range values clamp to something legal rather than
 * throwing"*. An entry with no name or no description is DROPPED rather than
 * throwing the whole list away — a hand-edited file with one bad row should cost
 * that row, not every category the person ever wrote.
 *
 * THREE THINGS ARE ENFORCED AND EACH IS LOAD-BEARING:
 *
 *   * The id is RE-DERIVED from the name and never taken from the file. It is
 *     what the engine is handed and what a report row will say for as long as
 *     the report exists, so it has to be the spelling `customCategoryId`
 *     produces and not whatever a hand edit left there.
 *   * A collision with a BUILT-IN is dropped. `buildPlan` refuses a name asked
 *     for twice (src/analyze/plan.ts) — two plans for one name would score it
 *     twice and file it twice — and a custom "hate" would reach the engine as
 *     exactly that, an hour into a run.
 *   * A collision with an EARLIER CUSTOM one is dropped, first writing wins, for
 *     the same reason and one more: the panel's legend keys off the id, and two
 *     rows sharing one would toggle each other.
 */
export function clampAnalysisCategories(value: unknown): CustomAnalysisCategory[] {
  if (!Array.isArray(value)) return [];
  const built = new Set(ANALYSIS_CATEGORY_IDS);
  const seen = new Set<string>();
  const out: CustomAnalysisCategory[] = [];
  for (const raw of value) {
    if (out.length >= CUSTOM_CATEGORY_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry['name'] === 'string'
      ? entry['name'].replace(/\s+/g, ' ').trim().slice(0, CUSTOM_CATEGORY_NAME_MAX)
      : '';
    const description = typeof entry['description'] === 'string'
      ? entry['description'].replace(/\s+/g, ' ').trim().slice(0, CUSTOM_CATEGORY_DESCRIPTION_MAX)
      : '';
    if (name.length === 0 || description.length === 0) continue;
    const id = customCategoryId(name);
    if (id.length === 0 || built.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, description });
  }
  return out;
}

/**
 * One of the two answers, or `top`. A word this build does not know is not one.
 */
export function clampNewJobsWaitFor(value: unknown): NewJobsWaitFor {
  return value === ANY_SLOT ? ANY_SLOT : 'top';
}

/**
 * THE LIVE QUEUE'S DIAL, or {@link GPU_DIAL_ANY} for anything unreadable.
 *
 * A MISSING RECORD IS "ANY", which is the only safe default: a dial that
 * defaulted to a machine would silently pin every row on a fresh install to
 * whichever server happened to be named, and nobody would have chosen it.
 *
 * The name is put through {@link tidySlotName} so the stored dial is comparable
 * to a stored server name by the same rule the registry stores one under — a
 * dial carrying trailing whitespace would match no slot and park every row with
 * a sentence naming a server that looks exactly right.
 */
export function clampQueueGpuDial(value: unknown): string {
  if (typeof value !== 'string') return GPU_DIAL_ANY;
  const tidied = tidySlotName(value);
  return tidied.length === 0 ? GPU_DIAL_ANY : tidied;
}

/**
 * A WSL distro name, or empty. Empty is a real answer — see `AppSettings`.
 *
 * Whitespace inside is allowed because a distro genuinely may have it
 * (`Ubuntu 22.04` is what `wsl -l -q` prints on plenty of machines) and it is
 * passed as one argv element, never through a shell. What is refused is a value
 * that would make the argument array something other than one name: a leading
 * dash would be read by `wsl.exe` as a flag of its own.
 */
export function clampWslDistro(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, 120);
  if (trimmed.length === 0 || trimmed.startsWith('-')) return '';
  return trimmed;
}

/**
 * THE REGISTRY, CLEANED RATHER THAN REFUSED — this file's philosophy, applied to
 * the one list in it that can strand a job.
 *
 * A row is DROPPED, and every drop is a row that could otherwise be picked in a
 * `waitFor` and then fail at the spawn with something unreadable:
 *
 *   * No name, no URL or no token. A Crucible has no anonymous mode, so an entry
 *     without a token is not a server this app could ever reach; storing it
 *     would put a dead name in the picker.
 *   * A URL that is not http(s), or that already carries `/v1`. The SDK is
 *     explicit that its `url` is the base WITHOUT the version prefix and refuses
 *     one that has it — better to drop the row here, where the settings card can
 *     say so, than to mint a client that throws a config error at dispatch.
 *   * A name `slotNameRefusal` (shared/slots.ts) has something to say about —
 *     too long, a control character, a `:`, a `/` or a `\`, or one of the two
 *     names the queue has already spent. THAT FUNCTION IS THE RULE AND THIS IS
 *     ONE OF ITS TWO READERS: it used to be two rules, a writer that checked no
 *     length beside this clamp's silent `.slice(0, 60)`, so a long name was
 *     refused by nobody and shortened on the way to disk into something the card
 *     was no longer showing. Dropped here rather than truncated, because a
 *     truncation is a name nobody chose.
 *   * A name already used by an earlier entry, first writing wins — the picker
 *     keys off the name and two rows sharing one would be one row the person
 *     cannot choose between.
 */
export function clampCrucibleServers(value: unknown): CrucibleServerEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CrucibleServerEntry[] = [];
  for (const raw of value) {
    if (out.length >= CRUCIBLE_SERVER_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = tidySlotName(entry['name']);
    const url = clampCrucibleUrl(entry['url']);
    const token = typeof entry['token'] === 'string' ? entry['token'].trim() : '';
    if (slotNameRefusal(name, 'server') !== null || url === null || token.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url, token, enabled: entry['enabled'] !== false });
  }
  return out;
}

/**
 * THE CLOUD PROVIDERS, CLEANED RATHER THAN REFUSED — `clampCrucibleServers`'
 * philosophy, applied to the other list that can strand a job.
 *
 * A row is DROPPED when it could not be used, and every drop is a row that would
 * otherwise be pickable in a `waitFor` and then fail at the spawn:
 *
 *   * No name, no key, or no model. A provider has no anonymous mode and holds a
 *     catalog rather than one resident model, so an entry missing either is not
 *     something the engine could ever be spawned against — `--model` is REQUIRED
 *     on both cloud doors and the run would die at the argument parser.
 *   * A `kind` this build does not know. The kind decides the credential header
 *     and the `--server` word; a value read leniently would put an
 *     `Authorization` on a wire that wants `x-api-key`.
 *   * An `endpoint` that is not http(s). Empty is kept as empty, which MEANS the
 *     provider's own address and is the ordinary case.
 *   * A name `slotNameRefusal` (shared/slots.ts) has something to say about, by
 *     `clampCrucibleServers`' argument and through the same one function: the
 *     two lists feed ONE picker and one lane string, so a name legal in one card
 *     and not the other would be a rule a person has to learn twice.
 *   * A name that collides with an earlier cloud entry, or with a registered
 *     Crucible — the picker keys off the name and a slot list with two rows
 *     called one thing is a row the person cannot choose between. THE CRUCIBLE
 *     HALF OF THAT TEST IS NOT
 *     HERE: this function is handed one array and `clampCrucibleServers` is
 *     handed the other, so neither can see the other's names at the clamp. The
 *     refusal is at the two WRITERS (electron/cloud-providers.ts and
 *     electron/crucible-registry.ts), which read both lists, and `computeSlots`
 *     drops a duplicate as its last word.
 */
export function clampCloudProviders(value: unknown): CloudProviderEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CloudProviderEntry[] = [];
  for (const raw of value) {
    if (out.length >= CLOUD_PROVIDER_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = tidySlotName(entry['name']);
    const kind = entry['kind'] === 'openai' || entry['kind'] === 'anthropic'
      ? entry['kind']
      : null;
    const apiKey = typeof entry['apiKey'] === 'string' ? entry['apiKey'].trim() : '';
    const model = clampCloudModel(entry['model']);
    const endpoint = clampCloudEndpoint(entry['endpoint']);
    if (slotNameRefusal(name, 'provider') !== null) continue;
    if (kind === null || apiKey.length === 0 || model.length === 0) continue;
    if (endpoint === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind, apiKey, model, endpoint, enabled: entry['enabled'] !== false });
  }
  return out;
}

/**
 * A provider model id, or empty when there is not one.
 *
 * NOT VALIDATED AGAINST A LIST — hosted
 * line-ups change monthly, so a table compiled into this build would refuse the
 * model somebody is paying for. The shape check is all there is — a non-empty
 * single token — and the PROOF is the Test button, which lists the provider's
 * own `/v1/models` and says whether this id is among them.
 *
 * EMPTY RATHER THAN A FALLBACK: there is no sensible
 * default model for somebody else's account, and an entry with no model is one
 * `clampCloudProviders` drops rather than one that spawns a run the engine
 * refuses by name.
 */
export function clampCloudModel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return '';
  return trimmed.slice(0, 120);
}

/**
 * A provider endpoint: empty (meaning the provider's own), or an http(s) base.
 *
 * NULL IS "NOT AN ADDRESS AT ALL" and drops the row — `clampCrucibleUrl`'s
 * posture, for its reason: there is no default address for somebody else's
 * gateway, and inventing one would point a key at a server nobody named. Unlike
 * that function, `/v1` is NOT stripped: the OpenAI door wants it and adds it
 * back when it is missing, so a person who pasted the URL their provider prints
 * gets exactly what they pasted.
 */
export function clampCloudEndpoint(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * A Crucible base URL, or null when it is not one.
 *
 * NULL RATHER THAN A FALLBACK, which is the one place this file departs from its
 * clamping habit and has to: there is no default address for somebody else's
 * machine. A URL that cannot be understood is an entry that cannot exist, and
 * the caller drops the row instead of inventing a server.
 *
 * The trailing slash and the `/v1` suffix are both normalised away rather than
 * refused for the suffix, because pasting the URL a person has in their
 * clipboard — the one the CLI prints, with `/v1` on it — is the ordinary
 * mistake, and the SDK's own refusal of it is a config error with no card to
 * show it on.
 */
export function clampCrucibleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * ARE THESE TWO ENTRIES THE SAME ADDRESS? The registry's one duplicate rule.
 *
 * ── The fact it guards ────────────────────────────────────────────────────
 *
 * Since the slot wave, EVERY enabled entry draws its own GPU lane
 * (electron/crucible-registry.ts `slotsFrom`). Two enabled rows at one address
 * therefore tell the queue it has two cards when it has one, and it schedules
 * both lanes onto the same GPU — the machine is oversubscribed and nothing on
 * screen says so, because two rows is exactly what two machines looks like.
 *
 * ── Why the string compare it replaces was not enough ─────────────────────
 *
 * {@link clampCrucibleUrl} answers the TRIMMED ORIGINAL, not a normal form: it
 * drops a trailing slash and a `/v1`, and stops. So `http://LOCALHOST:7100` and
 * `http://localhost:7100` are two different strings and were two different
 * servers. `URL.origin` settles the rest for free — it lower-cases the host and
 * drops a port that is the scheme's default, so `http://host:80` and
 * `http://host` are one address.
 *
 * ── `localhost` AND `127.0.0.1` ARE DELIBERATELY NOT FOLDED ───────────────
 *
 * They can genuinely differ — a hosts-file entry, a server bound to IPv6 only —
 * and folding them would be this app making a guess about somebody's machine
 * and then refusing a row on the strength of it. BookForge took the same
 * decision for the same reason (bookforge e70f30f6), so one registry rule holds
 * across both apps. The ordinary version of that mistake is caught anyway: it
 * arrives under the same name, and the name rule has always refused it.
 *
 * ── ON ADD, NEVER ON READ ─────────────────────────────────────────────────
 *
 * Nothing calls this while loading a settings file, and nothing re-validates
 * one at startup. A registry that ALREADY holds a duplicate keeps working
 * exactly as it did — badly, with two lanes over one card, but unchanged — and
 * no file becomes unopenable because this rule arrived. That is what makes the
 * rule additive rather than a migration: fixing the registries that already
 * have one is the lane half, which is a separate decision.
 */
export function sameCrucibleAddress(a: string, b: string): boolean {
  const origin = (value: string): string | null => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const left = origin(a);
  const right = origin(b);
  // An address neither side can parse is compared as written. Both doors clamp
  // before they get here, so reaching this means something stored a row this
  // build cannot read, and guessing two of those are the same machine is worse
  // than letting a duplicate through.
  if (left === null || right === null) return a === b;
  return left === right;
}

/** Step ids, deduplicated and capped. A stale id is harmless; a corpus is not. */
export function clampSkipped(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim().slice(0, 40);
    if (id.length === 0) continue;
    seen.add(id);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

export function readAppSettings(): AppSettings {
  const raw = readRaw();
  return {
    libraryDir: clampLibraryDir(hostedLibraryDir() ?? raw?.['libraryDir']),
    analysisCategories: clampAnalysisCategories(raw?.['analysisCategories']),
    crucibleServers: clampCrucibleServers(raw?.['crucibleServers']),
    cloudProviders: clampCloudProviders(raw?.['cloudProviders']),
    newJobsWaitFor: clampNewJobsWaitFor(raw?.['newJobsWaitFor']),
    queueGpuDial: clampQueueGpuDial(raw?.['queueGpuDial']),
    wslDistro: clampWslDistro(raw?.['wslDistro']),
    setupCompleted: raw?.['setupCompleted'] === true,
    setupSkipped: clampSkipped(raw?.['setupSkipped']),
  };
}

/**
 * The removal receipt, read defensively.
 *
 * NULL FOR ANYTHING THAT IS NOT A COMPLETE ONE, including a half-written record
 * from a version that stored it differently. This value is printed at a person
 * in a sentence about their disk; a partial one would produce "Foundry removed
 * undefined on undefined", and no record at all is a better sentence than that —
 * the disk is measured either way, so nothing is lost but the explanation.
 */
export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const root: Record<string, unknown> = readRaw() ?? {};
  if (patch.libraryDir !== undefined) {
    root['libraryDir'] = clampLibraryDir(patch.libraryDir);
  }
  if (patch.analysisCategories !== undefined) {
    root['analysisCategories'] = clampAnalysisCategories(patch.analysisCategories);
  }
  if (patch.crucibleServers !== undefined) {
    root['crucibleServers'] = clampCrucibleServers(patch.crucibleServers);
  }
  if (patch.cloudProviders !== undefined) {
    root['cloudProviders'] = clampCloudProviders(patch.cloudProviders);
  }
  if (patch.newJobsWaitFor !== undefined) {
    root['newJobsWaitFor'] = clampNewJobsWaitFor(patch.newJobsWaitFor);
  }
  if (patch.wslDistro !== undefined) {
    root['wslDistro'] = clampWslDistro(patch.wslDistro);
  }
  if (patch.setupCompleted !== undefined) {
    root['setupCompleted'] = patch.setupCompleted === true;
  }
  if (patch.setupSkipped !== undefined) {
    root['setupSkipped'] = clampSkipped(patch.setupSkipped);
  }
  /*
   * NULL IS A VALUE HERE and clears the receipt — which is what re-installing
   * the page reader does. `undefined` still means "not in this patch", so the
   * two are genuinely different and the check has to be on `undefined` rather
   * than on truthiness.
   */
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return readAppSettings();
}
