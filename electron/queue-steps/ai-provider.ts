/**
 * The AI provider block, built ONCE.
 *
 * Every AI job type stores the same fields on its config — which provider, and
 * for the legacy local engine which model — and every one of them was expanded
 * into the same nested `AIProviderConfig` object by hand, in the renderer, four
 * times over (translation, book-analysis, bilingual cleanup, bilingual
 * translation). Four copies of one mapping is four places for a change to be
 * forgotten.
 *
 * ── WHAT THIS FILE LOST IN PHASE 15, AND WHY ───────────────────────────────
 *
 * Owen, 2026-09-14: *"bookforge/foundry gain a simple contract: send commands
 * to the crucible server. period. they dont have ollama fallbacks or cloud
 * anything at all."* So `ollama`, `claude` and `openai` are gone as providers,
 * and with them the three credential columns a queue row used to carry. An
 * Ollama server, an Anthropic key and an OpenAI key are now UPSTREAMS
 * configured on the engine (crucible `docs/PHASE15-HOST.md` §2, §3.2), reached
 * by ROUTING a capability class to them — a choice the operator makes before
 * any request, on the engine, in one place, for every app.
 *
 * A row therefore carries no credential at all. `queue-engine.json` used to
 * hold `claudeApiKey` and `openaiApiKey` in plaintext per step, which is why
 * `bookshelf-server.ts` strips step configs out of its snapshot API; that
 * whole hazard is deleted rather than guarded.
 */
import type { AIProviderConfig } from '../ai-bridge';
import type { CrucibleTextAct } from '../crucible/text-acts';
import { LEGACY_LOCAL_NARRATOR, WAIT_FOR_ANY } from '../../shared/queue/wait-for';

/**
 * WHICH MACHINES AN AI STEP CAN RUN ON (crucible `docs/PHASE7-LANES.md` §4).
 *
 * Only the `crucible` provider travels, and that is not a safety default but
 * the literal truth about the other one: the bundled llama is THIS machine's
 * process, it has no Crucible server to be sent to, and handing it a remote
 * venue would occupy a slot on a machine nothing was submitted to.
 *
 * Shared by `translation.ts`, `book-analysis.ts` and `pass.ts` for the reason
 * this whole module exists: every AI step stores the same provider block, and
 * one copy of the mapping per step is one place for a change to be forgotten.
 */
export function machinesForAiStep(config: Record<string, unknown>): 'local' | 'any' {
  return config['aiProvider'] === 'crucible' ? 'any' : 'local';
}

/*
 * `crucibleModelForAiStep` IS DELETED (2026-09-14, phase 15).
 *
 * It read the row's `aiModel` and handed it to the scheduler as the id this
 * step's lease would be about. That stopped being knowable here the day the
 * capability record took ownership of the act-to-model mapping: the model is
 * `GET /v1/capability`'s `selected` for the class ON THE SERVER THE ROW WAS
 * PLACED ON, which needs a server name and a round trip, and `leasedModel` is
 * synchronous and asked BEFORE the step is placed.
 *
 * `pass.ts` had already reached this answer for `narration-text` and written
 * the argument out in full; phase 15 makes it true of every act, so all three
 * `leasedModel` hooks now answer `null` and say so in one voice. Null is a
 * real answer to "which model will this lease be about": null never equals an
 * open lease's subject, so the lease is given back at the seam, which is
 * exactly the behaviour before one-lease-per-row existed. The refusal is not
 * swallowed, only deferred — the act raises its own named refusal when it runs,
 * which is where an operator can act on it.
 *
 * A table here saying "simplify is the 27B" would be a second owner of a
 * per-HOST fact (crucible ARCHITECTURE.md R1) and would be wrong on the first
 * machine with a smaller card. OWED, and written down in
 * `docs/CRUCIBLE_ROLLOUT_PLAN.md`: an async `leasedModel` given the run's
 * venue would let a `clean` row keep its lease across a chain.
 */

/**
 * What a queue row stores about which engine does its text work.
 *
 * No credential, by construction: see the header. `aiModel` survives for the
 * legacy bundled-llama arm only, and is informational even there — llama-bridge
 * resolves the active model itself.
 */
export interface AiJobConfig {
  aiProvider: 'local' | 'crucible';
  aiModel: string;
}

/**
 * The provider block the bridges take.
 *
 * `act` is REQUIRED and is not guessable: it is the capability class this run
 * is, it decides which model the engine answers with, and it travels to the
 * server in `X-Crucible-Act` so `/v1/activity` says "translating" rather than
 * whatever act happened to be spelled first. Owen, 2026-09-13: *"they can't lie
 * to the user and say a translate job is running when it's actually a simplify
 * job."*
 */
export function providerConfigOf(
  config: AiJobConfig,
  /** The capability class this run is. Never defaulted — a wrong act is a lie. */
  act: CrucibleTextAct,
  /**
   * THE MACHINE THE QUEUE ASSIGNED THIS RUN — the row's `waitForResolved`,
   * verbatim. Only the `crucible` provider has anything to do with it.
   *
   * Passed in rather than read here for the reason this whole module exists:
   * the mapping is pure, and `ctx.job` belongs to the step. Absent is the
   * ordinary case (the legacy local arm, and any caller outside the queue) and
   * is REFUSED for `crucible` by name rather than defaulted to a machine
   * nobody chose.
   */
  assignedVenue?: string,
): AIProviderConfig {
  if (!config?.aiProvider) {
    throw new Error('This job does not say which AI provider to use.');
  }
  switch (config.aiProvider) {
    case 'local':
      /*
       * The bundled llama.cpp, and the last of the legacy local spawn layer's
       * text path. It is deleted with that layer after Owen's in-app pass
       * (crucible PHASE15 §6); until then it is a switch, not a fallback —
       * nothing selects it because something else failed.
       */
      return { provider: 'local', local: { model: config.aiModel } };
    case 'crucible': {
      /*
       * THE ROW NAMES A MACHINE, AND THE SERVER NAMES THE MODEL.
       *
       * `waitFor` landed (crucible `docs/PHASE7-LANES.md` §4.2.1) and the text
       * steps declare `machines()`, so the queue resolves a venue for this run
       * and hands it down. Nothing is guessed: with no assignment, or with the
       * legacy local-engine switch on, the refusal below names what to do
       * instead. A default here — the top-ranked server, the last used — would
       * be the manufactured instruction §4.2.1a exists to prevent.
       *
       * THE MODEL IS NOT HERE. PHASE15 §5.3: a text door sends
       * `capability.selected` for its class and nothing else. The id is read
       * from the server this run was placed on, at the door, because
       * `crucible install` probed THAT machine's card to choose it — an id
       * carried from a queue row would be this app's second opinion about a
       * decision that already has an owner.
       */
      if (assignedVenue === undefined || assignedVenue === WAIT_FOR_ANY) {
        throw new Error(
          'crucible_server_not_named: this job is set to use a Crucible server and its row was '
            + 'not assigned one. Pick a server for the book on the queue page (or Any), or queue '
            + 'it against the bundled local model.',
        );
      }
      if (assignedVenue === LEGACY_LOCAL_NARRATOR) {
        throw new Error(
          'crucible_server_not_named: this job is set to use a Crucible server, but "Run renders '
            + 'and text passes with the local engines instead" is on in Settings → Crucible '
            + 'Servers, so its row was assigned the local engines. Turn that off, or queue this '
            + 'job against the bundled local model.',
        );
      }
      return { provider: 'crucible', crucible: { server: assignedVenue, act } };
    }
    default:
      /*
       * A ROW QUEUED BEFORE PHASE 15 CAN STILL NAME ONE OF THE THREE DELETED
       * PROVIDERS, and it is told so by name rather than crashing or being
       * quietly re-pointed at a survivor. Re-pointing would be the fallback
       * this codebase forbids, and it would silently move somebody's book onto
       * a different engine and a different bill.
       */
      throw new Error(
        `ai_provider_removed: this job names "${config.aiProvider}", which BookForge no longer `
          + 'has. Ollama, Claude and OpenAI are now UPSTREAMS configured on the GPU engine '
          + '(Settings → AI), and a class is ROUTED to one there. Re-queue this job against the '
          + 'engine, or set the route and pick the engine as its provider.',
      );
  }
}
