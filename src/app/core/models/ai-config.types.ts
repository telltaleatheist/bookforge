/**
 * AI Configuration Types
 *
 * Two providers, and that is the whole list (Owen, 2026-09-14): *"bookforge/
 * foundry gain a simple contract: send commands to the crucible server.
 * period. they dont have ollama fallbacks or cloud anything at all."*
 * Anthropic, OpenAI and Ollama did not become unavailable — they moved. They
 * are UPSTREAMS a Crucible forwards to on the operator's account
 * (`CRUCIBLE_UPSTREAM_NAMES` in `@shared/crucible/settings-wire`), chosen on
 * that server before any request is made, and this app stores no key for any
 * of them anywhere.
 */

/**
 * Who runs an AI pass.
 *
 * This is the renderer's copy of `AIProvider` in `electron/ai-bridge.ts` — one
 * fact with two spellings (crucible `docs/ARCHITECTURE.md`, R1), re-declared
 * here only because the bridge's own module reaches for `electron` at load and
 * a renderer cannot import it. The two lists must stay identical.
 *
 * `local` is the bundled llama.cpp of the legacy local spawn layer, which is
 * deleted separately after Owen's in-app pass; until then it is the only
 * provider that works with nothing configured.
 */
export type AIProvider = 'crucible' | 'local';

/** Is this string one of the two providers this build has? */
export function isAIProvider(value: unknown): value is AIProvider {
  return value === 'crucible' || value === 'local';
}

/**
 * The three providers that LEFT on 2026-09-14, kept only so a stored value can
 * be NAMED when it is repaired. Nothing offers them and nothing runs them.
 */
export const RETIRED_AI_PROVIDERS = ['ollama', 'claude', 'openai'] as const;

export type RetiredAIProvider = (typeof RETIRED_AI_PROVIDERS)[number];

export interface SavedAIProviderResolution {
  provider: AIProvider;
  /** Absent when the stored value was already a provider this build has. */
  migratedFrom?: RetiredAIProvider;
  /** Why it was repaired, in full. Present exactly when `migratedFrom` is. */
  note?: string;
}

/**
 * A provider read back out of a settings blob, resolved.
 *
 * The same shape `resolveSavedTtsEngine` uses for a retired narration engine,
 * and for the same reason: a stored DEFAULT is the seed for the next run, shown
 * in a picker before anything is rendered, so repairing it loudly is safe in
 * the way repairing a queued run would not be. Without the repair a machine
 * that had chosen Ollama would open Settings with NOTHING selected in the
 * provider picker and no way to see why.
 *
 * It is not a fallback: the repair names what it changed and the caller is
 * expected to print the note. A string this build has never had throws.
 */
export function resolveSavedAIProvider(value: string): SavedAIProviderResolution {
  if (isAIProvider(value)) return { provider: value };
  if ((RETIRED_AI_PROVIDERS as readonly string[]).includes(value)) {
    return {
      provider: DEFAULT_AI_CONFIG.provider,
      migratedFrom: value as RetiredAIProvider,
      note:
        `Saved AI provider "${value}" left BookForge on 2026-09-14 — Anthropic, OpenAI and `
        + 'Ollama are now upstreams a GPU engine (Crucible) forwards to, configured on the '
        + `engine. Migrating the saved default to "${DEFAULT_AI_CONFIG.provider}", and `
        + 'resetting the model that was paired with it.',
    };
  }
  throw new Error(
    `Saved settings name an AI provider this build has never had: "${value}". `
    + 'This build runs: crucible, local.',
  );
}

export interface LocalConfig {
  /** Active model id is owned by the main process; informational here. */
  model?: string;
}

/**
 * A Crucible inference server, chosen in Settings → AI.
 *
 * `server` NAMES an entry in the registry (or the reserved `local`) — it is not
 * a URL, and there is no default: a server name is whatever this machine called
 * that machine. `model` is a Crucible model id, and it must ALREADY BE RESIDENT
 * when the run starts — a cleanup never loads a model on somebody's card, so a
 * model that is merely installed is refused by name (`crucible_model_not_resident`).
 * Making one resident is an operator's act, in Settings → Crucible Servers.
 */
export interface CrucibleConfig {
  server: string;
  model: string;
}

export interface AIConfig {
  provider: AIProvider;
  // Bundled llama.cpp. Optional so configs persisted before WS2 still parse.
  local?: LocalConfig;
  // A Crucible server. Optional and NOT defaulted: neither half is guessable,
  // so a config that has never chosen one has no entry rather than an empty one.
  crucible?: CrucibleConfig;
}

/**
 * `provider: 'local'` because it is the only one that works with nothing
 * configured — a Crucible needs a server name, and a server name is whatever
 * this machine called that machine, which nobody can guess on a fresh install.
 */
export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'local',
};

// Provider availability check results
export interface ProviderStatus {
  available: boolean;
  error?: string;
  models?: string[];
}
