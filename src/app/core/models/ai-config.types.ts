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
 * ONE PROVIDER SINCE 2026-09-17 (Owen: *"pipeline defaults has bundled (local)
 * or crucible as options. remove that. it will always be crucible. the app
 * doesnt function without a crucible server"*).
 *
 * `local` was the bundled llama.cpp of the legacy spawn layer. It is retired
 * the way Orpheus was: removed from the CHOICE, not from the build — the spawn
 * layer dies with the rest of the legacy path, and nothing offers or selects it
 * in the meantime.
 *
 * IT WAS ALSO A LIVE DEFECT. `local` was the DEFAULT provider, so a machine
 * that had never chosen anything resolved a server named "local" — a name
 * retired months ago (`electron/crucible/retire-reserved-name.ts`) — and the
 * registry refused it: *no crucible server named "local" is registered (known:
 * mac, crucible@example-pc-wsl)*. Owen hit that twice in one session. Deleting
 * the provider is what makes those two messages unreachable rather than handled.
 */
export type AIProvider = 'crucible';

/** Is this string the provider this build has? */
export function isAIProvider(value: unknown): value is AIProvider {
  return value === 'crucible';
}

/**
 * The providers that LEFT, kept only so a stored value can be NAMED when it is
 * repaired. Nothing offers them and nothing runs them.
 *
 * `ollama`, `claude`, `openai` went on 2026-09-14 — they became UPSTREAMS a
 * Crucible forwards to. `local` went on 2026-09-17 and is a different story: it
 * did not move anywhere, it stopped being a thing this app does.
 */
export const RETIRED_AI_PROVIDERS = ['ollama', 'claude', 'openai', 'local'] as const;

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
      note: value === 'local'
        ? 'Saved AI provider "local" was the bundled model, retired on 2026-09-17: every AI '
          + 'pass runs on a Crucible server now. Migrating the saved default to "crucible". '
          + 'Pick a server in Settings → AI — there is no default, because a server name is '
          + 'whatever this machine called that machine.'
        : `Saved AI provider "${value}" left BookForge on 2026-09-14 — Anthropic, OpenAI and `
          + 'Ollama are now upstreams a GPU engine (Crucible) forwards to, configured on the '
          + `engine. Migrating the saved default to "${DEFAULT_AI_CONFIG.provider}", and `
          + 'resetting the model that was paired with it.',
    };
  }
  throw new Error(
    `Saved settings name an AI provider this build has never had: "${value}". `
    + 'This build runs: crucible.',
  );
}

export interface LocalConfig {
  /** Active model id is owned by the main process; informational here. */
  model?: string;
}

/**
 * A Crucible inference server, chosen in Settings → AI.
 *
 * `server` NAMES an entry in the registry — it is not a URL, and there is no
 * default: a server name is whatever this machine called that machine. It is
 * the ONLY thing this app stores about AI; see `model` below for what left.
 */
export interface CrucibleConfig {
  server: string;
  /**
   * THE MODEL IS NOT A SETTING ANY MORE (2026-09-17). It is a STAMP.
   *
   * It used to be chosen in Settings and sent with every run, which made it a
   * SECOND owner of a decision the engine already makes per capability class.
   * The two disagreed silently and the app's copy won: a model pinned here
   * overrode anything chosen for the `clean` class on the AI page, so a person
   * could pick a model, watch it save, and have a different one do the work.
   *
   * What writes it now is `stampCrucibleModelForRun` in `electron/ai-bridge.ts`,
   * onto the in-memory config of ONE run, from that server's own capability
   * record — which is what that file's comments have said all along: *"the
   * model is the SERVER's decision (GET /v1/capability), stamped onto the
   * config once at the start of the run; a chat never picks one."*
   *
   * So it is OPTIONAL and no settings page writes it. A stored config that
   * still carries one from before this date is harmless — `pickServer` in the
   * AI panel writes the server without it, which drops it — and leaving the
   * field on the type is what lets such a config parse instead of throwing.
   */
  model?: string;
}

/**
 * THE SERVER NAME `local`, WHICH IS RETIRED AND STILL ON DISK.
 *
 * Owen hit this on 2026-09-17 with the new AI page open: *"The engine would
 * not answer for its settings: unnamed no crucible server named "local" is
 * registered (known: mac, crucible@example-pc-wsl)"*.
 *
 * `local` used to be a RESERVED server name meaning "the engine on this
 * machine". It was retired months ago — a local Crucible is an ordinary
 * registry row under whatever name the operator typed (Owen: *"a local
 * crucible server shouldnt be treated any differently than a remote crucible
 * server"*) — and `electron/crucible/retire-reserved-name.ts` rewrites every
 * place main can reach: the registry, the queue's `waitFor`, the venue tables.
 *
 * IT CANNOT REACH THIS ONE. The AI config is the RENDERER's, in localStorage,
 * and main has no copy of it. So a machine that chose the local engine before
 * the retirement still asks for a server called "local" on every settings
 * read, and gets the registry's refusal naming a server the person has never
 * heard of.
 *
 * THE REPAIR IS TO DROP IT, not to substitute one. Which registry row means
 * "this machine" is not guessable — on this PC it is `crucible@example-pc-wsl`
 * and on another it is whatever that operator typed — and picking one would be
 * this app choosing somebody's inference machine for them. With no server the
 * page says "pick a server", which is a sentence a person can act on.
 */
export const RETIRED_CRUCIBLE_SERVER_NAME = 'local';

export interface SavedCrucibleServerResolution {
  /** The name to use, or undefined when the stored one was retired. */
  server?: string;
  /** Present exactly when the stored name was dropped. */
  note?: string;
}

export function resolveSavedCrucibleServer(value: string): SavedCrucibleServerResolution {
  if (value !== RETIRED_CRUCIBLE_SERVER_NAME) return { server: value };
  return {
    note:
      'Saved settings name a Crucible server called "local". That was a reserved name meaning '
      + '"the engine on this machine" and it was retired — a local engine is an ordinary row '
      + 'under the name its operator typed. Dropping it, because which row means this machine '
      + 'is not guessable. Pick a server in Settings → AI.',
  };
}

export interface AIConfig {
  provider: AIProvider;
  /**
   * The bundled llama.cpp's config. RETIRED 2026-09-17 and kept OPTIONAL so a
   * config written before then still parses — dropping the field would make
   * every stored config a parse error, which is a worse answer than an ignored
   * key. Nothing reads it.
   */
  local?: LocalConfig;
  // A Crucible server. Optional and NOT defaulted: neither half is guessable,
  // so a config that has never chosen one has no entry rather than an empty one.
  crucible?: CrucibleConfig;
}

/**
 * THE DEFAULT IS INCOMPLETE ON PURPOSE, and that is the honest shape.
 *
 * `crucible` is the only provider, but it needs a server NAME and no name is
 * guessable — it is whatever this machine called that machine. So a fresh
 * install has a provider and no server, and the run doors refuse it BY NAME
 * (`crucible_server_not_named`) until somebody picks one in Settings → AI.
 *
 * The previous default, `local`, avoided that by running a bundled model. It
 * also meant a machine that had chosen nothing silently resolved a server named
 * "local" that has not existed since the reserved name was retired, and the
 * refusal a person actually saw was the registry's, naming a server they had
 * never heard of. A refusal that says "pick a server" beats one that says
 * "no crucible server named local is registered".
 */
export const DEFAULT_AI_CONFIG: AIConfig = {
  provider: 'crucible',
};

// Provider availability check results
export interface ProviderStatus {
  available: boolean;
  error?: string;
  models?: string[];
}
