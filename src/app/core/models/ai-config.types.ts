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

// Available models per provider.
//
// There is deliberately NO Ollama list here: Ollama's models are whatever the
// user has pulled, so every picker asks the daemon (`GET {baseUrl}/api/tags`).
// A hardcoded list drifts the moment someone pulls a model — it hid cogito:32b
// and cogito:70b from Settings → Pipeline defaults until Aug 2026.
export const CLAUDE_MODELS = [
  { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet' },
  { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku' },
  { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' }
];

export const OPENAI_MODELS = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
  { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' }
];

// Provider availability check results
export interface ProviderStatus {
  available: boolean;
  error?: string;
  models?: string[];
}
