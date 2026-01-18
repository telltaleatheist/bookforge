/**
 * AI Configuration Types
 *
 * Supports multiple AI providers for OCR cleanup:
 * - Ollama (local, free)
 * - Claude (Anthropic API)
 * - OpenAI (ChatGPT API)
 */

export type AIProvider = 'ollama' | 'claude' | 'openai';

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

export interface AIConfig {
  provider: AIProvider;
  ollama: OllamaConfig;
  claude: ClaudeConfig;
  openai: OpenAIConfig;
}

export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'ollama',
  ollama: {
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2'
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

// Available models per provider
export const OLLAMA_MODELS = [
  { value: 'llama3.2', label: 'Llama 3.2' },
  { value: 'llama3.1', label: 'Llama 3.1' },
  { value: 'llama3', label: 'Llama 3' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'gemma2', label: 'Gemma 2' },
  { value: 'phi3', label: 'Phi-3' }
];

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
