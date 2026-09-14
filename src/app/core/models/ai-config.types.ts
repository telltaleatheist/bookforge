/**
 * AI Configuration Types
 *
 * Supports multiple AI providers for OCR cleanup:
 * - Ollama (local, free)
 * - Claude (Anthropic API)
 * - OpenAI (ChatGPT API)
 */

/**
 * Who runs an AI pass.
 *
 * `crucible` matches `AIProvider` in `electron/ai-bridge.ts`, which has had the
 * provider since phase 2 while this enum did not — so the bridge could run a
 * cleanup on a Crucible and Settings could not select one. The two lists are
 * one fact with two spellings (crucible `docs/ARCHITECTURE.md`, R1), and this
 * is the side that was wrong.
 */
export type AIProvider = 'ollama' | 'claude' | 'openai' | 'local' | 'crucible';

export interface OllamaConfig {
  baseUrl: string;
  model: string;
}

/**
 * A cloud provider, as this app's persisted `aiConfig` still shapes it.
 *
 * **NEITHER FIELD IS WRITTEN OR READ BY THIS APP ANY MORE** (2026-09-14). The
 * key and the model both come from FOUNDRY'S cloud card, read in the main
 * process by `electron/cloud-credentials.ts`; the Settings rows that used to
 * fill these are deleted, and `electron/ai-bridge.ts` ignores whatever a
 * record still carries. They stay on the type so a config persisted before
 * this change still PARSES — a settings blob that threw would take every other
 * preference with it — and they are emptied by nobody, because rewriting
 * somebody's stored key on upgrade is not this change's business.
 */
export interface ClaudeConfig {
  apiKey: string;
  model: string;
}

export interface OpenAIConfig {
  apiKey: string;
  model: string;
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
  ollama: OllamaConfig;
  claude: ClaudeConfig;
  openai: OpenAIConfig;
  // Bundled llama.cpp. Optional so configs persisted before WS2 still parse.
  local?: LocalConfig;
  // A Crucible server. Optional and NOT defaulted: neither half is guessable,
  // so a config that has never chosen one has no entry rather than an empty one.
  crucible?: CrucibleConfig;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'ollama',
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'cogito:14b'
  },
  claude: {
    apiKey: '',
    model: 'claude-3-5-sonnet-20241022'
  },
  openai: {
    apiKey: '',
    model: 'gpt-4o'
  }
};

/*
 * `CLAUDE_MODELS` AND `OPENAI_MODELS` ARE DELETED (2026-09-14).
 *
 * The comment that stood here already contained the argument against them, and
 * applied it only to Ollama: *"There is deliberately NO Ollama list here:
 * Ollama's models are whatever the user has pulled, so every picker asks the
 * daemon. A hardcoded list drifts the moment someone pulls a model — it hid
 * cogito:32b and cogito:70b from Settings → Pipeline defaults until Aug
 * 2026."* The two cloud lists below it were doing exactly that, with three
 * stale Claude ids and three stale OpenAI ids shipped as the only choices, and
 * they directly contradicted Owen's ruling (docs/CRUCIBLE_ROLLOUT_PLAN.md
 * §2a.2): **the key picks the models — the app calls the provider's own
 * listing with it, and the dropdown is what came back.**
 *
 * That listing already exists, done properly, in FOUNDRY'S cloud card: kind,
 * model, address, key, and a Test that asks the provider. BookForge's job is
 * to offer the door, not a second key store or a second catalog. Its main
 * process reads that record through `electron/cloud-credentials.ts`.
 */

// Provider availability check results
export interface ProviderStatus {
  available: boolean;
  error?: string;
  models?: string[];
}
