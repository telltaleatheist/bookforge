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
import { LEGACY_LOCAL_NARRATOR, WAIT_FOR_ANY } from '../../shared/queue/wait-for';

/**
 * WHICH MACHINES AN AI STEP CAN RUN ON (crucible `docs/PHASE7-LANES.md` §4).
 *
 * Only the `crucible` provider travels, and that is not a safety default but
 * the literal truth about the other four: Ollama and the bundled llama are
 * THIS machine's processes, and Claude and OpenAI are somebody's API — none of
 * them has a Crucible server to be sent to, and handing one a remote venue
 * would occupy a slot on a machine nothing was submitted to.
 *
 * Shared by `translation.ts` and `book-analysis.ts` for the reason this whole
 * module exists: every AI step stores the same provider block, and one copy of
 * the mapping per step is one place for a new provider to be forgotten.
 */
export function machinesForAiStep(config: Record<string, unknown>): 'local' | 'any' {
  return config['aiProvider'] === 'crucible' ? 'any' : 'local';
}

export interface AiJobConfig {
  aiProvider: 'ollama' | 'claude' | 'openai' | 'local' | 'crucible';
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
export function providerConfigOf(
  config: AiJobConfig,
  /**
   * THE MACHINE THE QUEUE ASSIGNED THIS RUN — the row's `waitForResolved`,
   * verbatim. Only the `crucible` provider has anything to do with it.
   *
   * Passed in rather than read here for the reason this whole module exists:
   * the mapping is pure, and `ctx.job` belongs to the step. Absent is the
   * ordinary case (every other provider, and any caller outside the queue) and
   * is REFUSED for `crucible` by name rather than defaulted to a machine
   * nobody chose.
   */
  assignedVenue?: string,
): AIProviderConfig {
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
    case 'crucible': {
      /*
       * THE ROW NAMES A MACHINE NOW — the RULING OWED here is answered.
       *
       * `waitFor` landed (crucible `docs/PHASE7-LANES.md` §4.2.1) and the text
       * steps declare `machines()`, so the queue resolves a venue for this run
       * and hands it down. Nothing is guessed: with no assignment, or with the
       * legacy local-engine switch on, the refusal below names what to do
       * instead. A default here — the top-ranked server, the last used — would
       * be the manufactured instruction §4.2.1a exists to prevent.
       *
       * The MODEL stays `aiModel`, which for this provider is a Crucible model
       * id that must already be RESIDENT: a queue run never loads one, because
       * a load evicts whatever is on that card (`ai-bridge.ts`'s preflight
       * refuses `crucible_model_not_resident` by name).
       */
      if (assignedVenue === undefined || assignedVenue === WAIT_FOR_ANY) {
        throw new Error(
          'crucible_server_not_named: this job is set to use a Crucible server and its row was '
            + 'not assigned one. Pick a server for the book on the queue page (or Any), or queue '
            + 'it against another provider.',
        );
      }
      if (assignedVenue === LEGACY_LOCAL_NARRATOR) {
        throw new Error(
          'crucible_server_not_named: this job is set to use a Crucible server, but "Run renders '
            + 'and text passes with the local engines instead" is on in Settings → Crucible '
            + 'Servers, so its row was assigned the local engines. Turn that off, or queue this '
            + 'job against Ollama or the bundled model.',
        );
      }
      return {
        provider: 'crucible',
        crucible: { server: assignedVenue, model: config.aiModel },
      };
    }
    default:
      throw new Error(`This job names an AI provider this build does not have: ${config.aiProvider}.`);
  }
}
