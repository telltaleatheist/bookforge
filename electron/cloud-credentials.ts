/**
 * CLOUD KEYS HAVE ONE OWNER, AND IT IS FOUNDRY'S CLOUD CARD.
 *
 * Owen's ruling, recorded in `docs/CRUCIBLE_ROLLOUT_PLAN.md` §3 (2026-09-14):
 * *"hosted, Foundry's cloud-card is editable and its record in
 * app-settings.json owns keys + models both ways; BookForge DELETES its own
 * Claude/OpenAI key rows and model lists and its OCR-cleanup AI provider reads
 * Foundry's record (as the clean door already reads `cleanTextModel`)."*
 *
 * This is that read. It is the same shape as
 * `narration-clean-text.ts`'s `cleanTextEngineSettingsIn` and for the same
 * reason: `<userData>/app-settings.json` is FOUNDRY'S file, living in OUR
 * userData because the hosted window runs in this process, and the honest way
 * to use a fact somebody else owns is to read their file rather than to keep a
 * copy of it (crucible `docs/ARCHITECTURE.md` R1).
 *
 * ── WHAT THIS DELETED ON THIS SIDE ─────────────────────────────────────────
 *
 * BookForge used to hold its own Claude and OpenAI API keys, in the renderer's
 * `localStorage` under `aiConfig`, beside its own hardcoded three-item model
 * lists (`CLAUDE_MODELS`, `OPENAI_MODELS` — three stale Claude ids and three
 * stale OpenAI ids shipped as the only choices). That was two key stores for
 * one credential and a compiled list where the audit's §2a.2 ruling says *"the
 * key picks the models: the app calls the provider's own listing"*. Both are
 * gone; Foundry's cloud card already implements the whole of it properly —
 * kind, model, address, key, and a Test that lists what the key can reach.
 *
 * ── WHY IT REFUSES BY NAME RATHER THAN DEFAULTING ──────────────────────────
 *
 * There is no cloud slot this file could invent. A run asked to use Claude on a
 * machine with no enabled Anthropic slot is a run that cannot happen, and
 * saying so — naming the file, the kind, and where the slot is edited — is the
 * only useful answer. Silently falling back to a local provider would run
 * somebody's book through different weights than they asked for.
 *
 * ── THE KEY IS READ HERE AND GOES NOWHERE ELSE ─────────────────────────────
 *
 * It is returned to a caller in this process that is about to put it in an
 * Authorization header. It is never logged, never put on an argv, never sent
 * over IPC to the renderer, and {@link CloudSlot} is deliberately NOT exported
 * through any preload surface — `describeCloudSlots()` is what a screen may
 * have, and it carries a boolean where this carries a credential (the same
 * line Foundry draws between `CloudProviderEntry` and `CloudProviderView`).
 */
import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * The two doors a cloud run can go through, spelled as FOUNDRY spells them in
 * `app-settings.json`.
 *
 * `anthropic`, not `claude`: the record is Foundry's, and reading somebody
 * else's file means using their word for the thing. BookForge's own
 * `AIProvider` says `claude`, which is the name on its own picker and on
 * records users already have — {@link cloudKindForProvider} is the one place
 * the two spellings meet.
 */
export type CloudProviderKind = 'anthropic' | 'openai';

/** One enabled cloud slot, with the credential. Never leaves the main process. */
export interface CloudSlot {
  /** What Foundry's card calls it. Shown in refusals so a person can find it. */
  name: string;
  kind: CloudProviderKind;
  /** The provider's own model id. Foundry's card is where it is typed. */
  model: string;
  /** The key. Header material, nothing else. */
  apiKey: string;
  /**
   * An OpenAI-compatible host, or EMPTY for the provider's own address.
   *
   * Empty is a REAL VALUE and is not filled in here, exactly as Foundry does
   * not fill it in at rest: resolving it at the point of use means a provider
   * that moves its API is one line of a build rather than a migration of
   * everybody's settings file.
   */
  endpoint: string;
}

/** What a SCREEN may see: the same slot with a boolean where the key was. */
export interface CloudSlotView {
  name: string;
  kind: CloudProviderKind;
  model: string;
  endpoint: string;
  /** Whether a key is stored. Never the key. */
  keySet: boolean;
}

/** Refusals from this reader, each naming what a person would do about it. */
export type CloudCredentialsErrorCode =
  /** The provider was asked for and Foundry's record holds no enabled slot of that kind. */
  | 'cloud_provider_not_configured'
  /** A slot exists and is missing the one thing only a person can supply. */
  | 'cloud_provider_incomplete';

export class CloudCredentialsError extends Error {
  readonly code: CloudCredentialsErrorCode;

  /** The code is PREFIXED onto the message, like every other named refusal here. */
  constructor(code: CloudCredentialsErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CloudCredentialsError';
    this.code = code;
  }
}

/** BookForge's provider name → Foundry's kind. The one place they meet. */
export function cloudKindForProvider(provider: string): CloudProviderKind | null {
  if (provider === 'claude') return 'anthropic';
  if (provider === 'openai') return 'openai';
  return null;
}

/** Where Foundry's record lives. It is in OUR userData; the file is theirs. */
export function cloudSettingsPath(userDataDir: string): string {
  return path.join(userDataDir, 'app-settings.json');
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Every ENABLED cloud slot in Foundry's record, in the order it stores them.
 *
 * An absent or unparsable file is an EMPTY LIST, and that is not a swallowed
 * error: Foundry itself reads such a file as its defaults (`readAppSettings`),
 * and "no cloud slots" is the true state of a machine where nobody has entered
 * a key. What must not be silent is a RUN that needed one, and that is
 * {@link requireCloudSlotIn}'s job.
 *
 * A disabled slot is not returned at all — Foundry's own rule, verbatim: *"Off
 * is not a slot at all: no picker entry, nothing lit in the dock."*
 */
export async function readCloudSlotsIn(userDataDir: string): Promise<CloudSlot[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(cloudSettingsPath(userDataDir), 'utf8'));
  } catch {
    return [];
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const entries = (raw as Record<string, unknown>)['cloudProviders'];
  if (!Array.isArray(entries)) return [];

  const slots: CloudSlot[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (record['enabled'] !== true) continue;
    const kind = str(record, 'kind');
    if (kind !== 'anthropic' && kind !== 'openai') continue;
    slots.push({
      name: str(record, 'name'),
      kind,
      model: str(record, 'model'),
      apiKey: str(record, 'apiKey'),
      endpoint: str(record, 'endpoint'),
    });
  }
  return slots;
}

/**
 * The slot a provider runs on, or a refusal naming the fix.
 *
 * THE FIRST ENABLED SLOT OF THAT KIND, and the ordering is Foundry's card's,
 * which is the order a person put them in. A second enabled Anthropic slot is
 * a deliberate act on that card and picking the first is the only rule that
 * does not need a tie-break nobody wrote down.
 */
export async function requireCloudSlotIn(
  userDataDir: string,
  kind: CloudProviderKind,
): Promise<CloudSlot> {
  const where = cloudSettingsPath(userDataDir);
  const slots = await readCloudSlotsIn(userDataDir);
  const slot = slots.find((s) => s.kind === kind);
  if (slot === undefined) {
    const others = slots.length === 0
      ? 'it holds no enabled cloud slots at all'
      : `it holds ${slots.map((s) => `${s.name} (${s.kind})`).join(', ')}`;
    throw new CloudCredentialsError(
      'cloud_provider_not_configured',
      `no enabled ${kind} cloud slot is set up, so this run has no key and no model to use `
      + `(${where}: ${others}). Cloud keys have ONE owner — Foundry's Backend settings, the `
      + '"Cloud providers" card, which is also where the key\'s own model listing is fetched. '
      + 'BookForge deliberately keeps no second key store.',
    );
  }
  if (slot.apiKey === '') {
    throw new CloudCredentialsError(
      'cloud_provider_incomplete',
      `the ${kind} cloud slot "${slot.name}" is enabled and has no API key. Add it in Foundry's `
      + 'Backend settings → Cloud providers; it is the one thing nothing here can supply.',
    );
  }
  if (slot.model === '') {
    throw new CloudCredentialsError(
      'cloud_provider_incomplete',
      `the ${kind} cloud slot "${slot.name}" names no model. A provider holds a catalog and has `
      + 'no opinion about which of it you want, so the id has to be chosen — Foundry\'s Backend '
      + 'settings → Cloud providers, where Test lists what this key can reach.',
    );
  }
  return slot;
}

// ─────────────────────────────────────────────────────────────────────────────
// The app's own userData, resolved at CALL time
// ─────────────────────────────────────────────────────────────────────────────
//
// `app.getPath` at call time rather than at import, for the reason the Crucible
// registry gives: the headless CLI stub (cli/electron-stub.js) has to be
// installed before this runs, and a keeper has to be able to point the `*In`
// functions above at a temp folder — which is why they take the directory.

/** Every enabled cloud slot Foundry's record holds, for this app's userData. */
export async function readCloudSlots(): Promise<CloudSlot[]> {
  return readCloudSlotsIn(app.getPath('userData'));
}

/** The slot a provider runs on, or a named refusal. See {@link requireCloudSlotIn}. */
export async function requireCloudSlot(kind: CloudProviderKind): Promise<CloudSlot> {
  return requireCloudSlotIn(app.getPath('userData'), kind);
}

/** The same list with the credentials replaced by a boolean. Safe for a screen. */
export async function describeCloudSlots(): Promise<CloudSlotView[]> {
  return (await readCloudSlots()).map((slot) => ({
    name: slot.name,
    kind: slot.kind,
    model: slot.model,
    endpoint: slot.endpoint,
    keySet: slot.apiKey !== '',
  }));
}
