/**
 * The AI provider block, built ONCE.
 *
 * Every AI job type stores the same five fields on its config — provider, model,
 * and one credential per provider — and every one of them was expanded into the
 * same nested `AIProviderConfig` object by hand, in the renderer, four times over
 * (translation, book-analysis, bilingual cleanup, bilingual translation). Four
 * copies of one mapping is four places for a new provider to be forgotten.
 */
import type { AIProviderConfig } from '../ai-bridge';

export interface AiJobConfig {
  aiProvider: 'ollama' | 'claude' | 'openai' | 'local';
  aiModel: string;
  ollamaBaseUrl?: string;
  claudeApiKey?: string;
  openaiApiKey?: string;
}

/**
 * The provider block the bridges take.
 *
 * A credential is NOT defaulted to an empty string: a job configured against
 * Claude with no key must fail at the door saying so, not send an empty
 * Authorization header and report whatever the API says about it.
 */
export function providerConfigOf(config: AiJobConfig): AIProviderConfig {
  if (!config?.aiProvider) {
    throw new Error('This job does not say which AI provider to use.');
  }
  switch (config.aiProvider) {
    case 'ollama':
    case 'local':
      return {
        provider: config.aiProvider,
        ollama: {
          baseUrl: config.ollamaBaseUrl || 'http://localhost:11434',
          model: config.aiModel,
        },
      };
    case 'claude':
      if (!config.claudeApiKey) {
        throw new Error('This job is set to use Claude and carries no API key.');
      }
      return { provider: 'claude', claude: { apiKey: config.claudeApiKey, model: config.aiModel } };
    case 'openai':
      if (!config.openaiApiKey) {
        throw new Error('This job is set to use OpenAI and carries no API key.');
      }
      return { provider: 'openai', openai: { apiKey: config.openaiApiKey, model: config.aiModel } };
    default:
      throw new Error(`This job names an AI provider this build does not have: ${config.aiProvider}.`);
  }
}
