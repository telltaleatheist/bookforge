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
import { DEFAULT_OLLAMA_ENDPOINT, DEFAULT_TRANSLATE_MODEL } from '../shared/pipeline';
import {
  ANALYSIS_CATEGORY_IDS,
  CUSTOM_CATEGORY_DESCRIPTION_MAX,
  CUSTOM_CATEGORY_NAME_MAX,
  customCategoryId,
  type CustomAnalysisCategory,
} from '../shared/analysis-categories';

export interface AppSettings {
  /**
   * Minutes an app-started vLLM server stays up after the queue drains.
   *
   * 0 — the default — stops it as soon as the queue is empty. The ceiling
   * exists because "never indefinite" needs a number to be true: whatever is
   * written here, an idle server always has a scheduled end.
   */
  keepServerWarmMinutes: number;
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
  /**
   * THE OLLAMA MODEL EVERY LANGUAGE JOB STARTS FROM — translate, simplify,
   * analyse.
   *
   * `qwen3.8:27b` was ruled the standard for every task (Owen, 2026-08-22) and
   * remains the fallback when this is unset, so nothing about an existing
   * machine changes by adding this field. What it buys is the machine that
   * CANNOT run it: 27b wants seventeen gigabytes of weights, an 8 GB card is an
   * ordinary card, and a default nobody's hardware can honour is a default that
   * makes the app look broken on first use. Setup measures the machine and
   * writes the largest Qwen 3.5 that fits here.
   *
   * IT IS A SEED, NOT A LOCK. The three dialogs still show the model in an
   * editable field and still send whatever is in it; this decides what is in it
   * when the dialog opens. Somebody who types a different model for one book
   * gets that model for that book and this is untouched — a per-run choice is
   * not a change of mind about the default.
   */
  defaultLlmModel: string;
  /**
   * Where ollama is. Its own default port unless somebody moved it.
   *
   * Here rather than in the engine's settings.json for the reason that file's
   * header gives about server lifecycle: foundry never starts, stops or
   * configures ollama, and the engine is handed the URL on the command line for
   * every run. This is the app remembering what to hand it.
   */
  ollamaUrl: string;
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

export const KEEP_WARM_MAX_MINUTES = 240;

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
const DEFAULTS = { keepServerWarmMinutes: 0 };

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

/** A finite number of minutes in [0, max]; anything else is the fallback. */
export function clampKeepWarm(value: unknown, fallback = DEFAULTS.keepServerWarmMinutes): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(KEEP_WARM_MAX_MINUTES, Math.max(0, Math.round(value)));
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
 * A model tag, or the standing default.
 *
 * NOT VALIDATED AGAINST A LIST, and that is on purpose: the lineup this app
 * knows about (electron/llm-catalog.ts) is what setup OFFERS, not what ollama
 * can run. Somebody who has pulled a model of their own and typed its name has
 * said something true about their machine that a hardcoded table cannot know,
 * and refusing it would make the setting less useful than the text field it
 * seeds. The shape check is all there is: a non-empty single token.
 */
export function clampModelTag(value: unknown, fallback = DEFAULT_TRANSLATE_MODEL): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return fallback;
  return trimmed;
}

/** An http(s) origin, or ollama's own. Anything unparsable is the default. */
export function clampOllamaUrl(value: unknown, fallback = DEFAULT_OLLAMA_ENDPOINT): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return fallback;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return trimmed;
  } catch {
    return fallback;
  }
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
    keepServerWarmMinutes: clampKeepWarm(raw?.['keepServerWarmMinutes']),
    libraryDir: clampLibraryDir(hostedLibraryDir() ?? raw?.['libraryDir']),
    analysisCategories: clampAnalysisCategories(raw?.['analysisCategories']),
    defaultLlmModel: clampModelTag(raw?.['defaultLlmModel']),
    ollamaUrl: clampOllamaUrl(raw?.['ollamaUrl']),
    setupCompleted: raw?.['setupCompleted'] === true,
    setupSkipped: clampSkipped(raw?.['setupSkipped']),
  };
}

export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const root: Record<string, unknown> = readRaw() ?? {};
  if (patch.keepServerWarmMinutes !== undefined) {
    root['keepServerWarmMinutes'] = clampKeepWarm(patch.keepServerWarmMinutes);
  }
  if (patch.libraryDir !== undefined) {
    root['libraryDir'] = clampLibraryDir(patch.libraryDir);
  }
  if (patch.analysisCategories !== undefined) {
    root['analysisCategories'] = clampAnalysisCategories(patch.analysisCategories);
  }
  if (patch.defaultLlmModel !== undefined) {
    root['defaultLlmModel'] = clampModelTag(patch.defaultLlmModel);
  }
  if (patch.ollamaUrl !== undefined) {
    root['ollamaUrl'] = clampOllamaUrl(patch.ollamaUrl);
  }
  if (patch.setupCompleted !== undefined) {
    root['setupCompleted'] = patch.setupCompleted === true;
  }
  if (patch.setupSkipped !== undefined) {
    root['setupSkipped'] = clampSkipped(patch.setupSkipped);
  }
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
  return readAppSettings();
}
