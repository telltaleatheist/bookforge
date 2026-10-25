/**
 * WHAT A JOB'S MODEL DROPDOWN OFFERS (Owen, 2026-10-25).
 *
 * Verbatim, in order:
 *  - *"bookforge should make the decision about which model is used for cleanup
 *    … maximum of 27b. but whatever is the biggest model we can get up to that
 *    point."*
 *  - *"they should be able to go to claude … put the option the user can pick in
 *    a dropdown on the modal that configures the job"*
 *  - *"cloud accounts should be listed as an option in every model dropdown if
 *    its available, just like 27b or 9b or anything else. however, bookforge
 *    should use the last used model as the default. the ideal is that the user
 *    wont need to use cloud models because theyre expensive. but it should be
 *    there if their system is too weak to run a local model"*
 *
 * So one list, three kinds of row, in this order:
 *
 *  1. AUTOMATIC — the server's own pick, the biggest chat model that fits its
 *     card at or under {@link JOB_MODEL_CEILING_B}. Its value is `''`, which a
 *     request carries as "no `chosenModel`". It is the first-run default.
 *  2. LOCAL — every chat model that server has installed and can load, at or
 *     under the ceiling, biggest first.
 *  3. CLOUD — every model a configured upstream account serves
 *     (`GET /v1/openai/models`, Crucible 2.0.31), sent as `<upstream>/<model>`
 *     and forwarded by the server on that account.
 *
 * The default is the last value used for that kind of job, when the list still
 * offers it; otherwise AUTOMATIC. That is a logical default, not a fallback that
 * hides a fault: a model chosen on one server is simply not on another.
 *
 * THIS FILE IS MIRRORED, byte for byte below the header, in BookForge
 * (`shared/crucible/job-models.ts`), because the two apps build separately and
 * BookForge's own modals offer the same list. Change both.
 */

/** The ceiling, in billions of parameters, for every chat act. Owen: *"keep it at 27b as the max right now"*. */
export const JOB_MODEL_CEILING_B = 27;

/** The value AUTOMATIC carries: no `chosenModel` on the request. */
export const AUTOMATIC_JOB_MODEL = '';

/** The four kinds of job a person picks a model for. */
export type JobModelKind = 'clean' | 'translate' | 'simplify' | 'analysis';

export interface JobModelChoice {
  /** What the request carries as `chosenModel`; `''` is AUTOMATIC. */
  readonly value: string;
  readonly kind: 'automatic' | 'local' | 'cloud';
  /** The row's text, e.g. "qwen3.8-27b-4bit (27B, 4-bit)" or "Claude: claude-sonnet-5-5". */
  readonly label: string;
  /** A second line, e.g. "billed to the anthropic account", or null. */
  readonly detail: string | null;
}

export interface JobModelChoices {
  /** The server the list was read from, by its registry name. */
  readonly server: string;
  readonly choices: readonly JobModelChoice[];
  /**
   * A sentence about the cloud rows when they could not be read fresh — a
   * vendor that did not answer (the server's last list, marked stale), or the
   * list could not be read at all. Null when there is nothing to say.
   */
  readonly cloudNote: string | null;
}

/** The two facts a local row is built from, as the SDK's `ModelInfo` names them. */
export interface LocalModelFacts {
  readonly id: string;
  readonly paramsB: number;
  readonly installed: boolean;
  readonly loadable: boolean;
  readonly backendSupported: boolean;
  readonly verbs: readonly string[] | null;
  readonly modalities: readonly string[];
}

/** One upstream row, as the SDK's `UpstreamModel` names it. */
export interface CloudModelFacts {
  readonly id: string;
  readonly upstream: string;
}

/** One upstream's list status, as the SDK's `UpstreamListStatus` names it. */
export interface CloudListStatus {
  readonly stale: boolean;
  readonly error: { readonly code: string; readonly message: string } | null;
}

/**
 * THE LIST, out of what the server said. PURE, so a keeper drives every branch
 * without a server, and so the two apps cannot disagree about it.
 *
 * `cloud` is null when the upstream list could not be read at all; the local
 * rows are still offered, and `cloudNote` says why there are no cloud rows.
 */
export function jobModelChoices(
  server: string,
  local: readonly LocalModelFacts[],
  cloud: { readonly models: readonly CloudModelFacts[]; readonly upstreams: Readonly<Record<string, CloudListStatus>> } | null,
  cloudUnreadable: string | null,
): JobModelChoices {
  const choices: JobModelChoice[] = [{
    value: AUTOMATIC_JOB_MODEL,
    kind: 'automatic',
    label: `Automatic — the biggest that fits, up to ${JOB_MODEL_CEILING_B}B`,
    detail: `On ${server}'s own card.`,
  }];
  const chat = local
    .filter((m) => m.installed && m.loadable && m.backendSupported
      && m.modalities.includes('text')
      && (m.verbs ?? []).includes('generate')
      && m.paramsB <= JOB_MODEL_CEILING_B)
    .slice()
    .sort((a, b) => b.paramsB - a.paramsB || a.id.localeCompare(b.id));
  for (const m of chat) {
    choices.push({ value: m.id, kind: 'local', label: `${m.id} (${m.paramsB}B)`, detail: `On ${server}'s own card.` });
  }
  let cloudNote: string | null = null;
  if (cloud === null) {
    cloudNote = `The cloud models ${server} can forward to could not be read: ${cloudUnreadable ?? 'no reason given'}.`;
  } else {
    for (const m of cloud.models) {
      const bare = m.id.startsWith(`${m.upstream}/`) ? m.id.slice(m.upstream.length + 1) : m.id;
      choices.push({
        value: m.id,
        kind: 'cloud',
        label: `${cloudAccountName(m.upstream)}: ${bare}`,
        detail: `Billed to the ${m.upstream} account set up on ${server}.`,
      });
    }
    const stale = Object.entries(cloud.upstreams).filter(([, s]) => s.stale || s.error !== null);
    if (stale.length > 0) {
      cloudNote = stale.map(([name, s]) => `${cloudAccountName(name)}'s list is from earlier`
        + (s.error === null ? '' : ` (${s.error.message})`)).join('; ') + '.';
    }
  }
  return { server, choices, cloudNote };
}

/**
 * THE DEFAULT ROW: the last value used for this kind of job when the list still
 * offers it, else AUTOMATIC. See the header for why that is a default and not a
 * fallback.
 */
export function defaultJobModel(choices: JobModelChoices, lastUsed: string | undefined): string {
  if (lastUsed !== undefined && choices.choices.some((c) => c.value === lastUsed)) return lastUsed;
  return AUTOMATIC_JOB_MODEL;
}

function cloudAccountName(upstream: string): string {
  if (upstream === 'anthropic') return 'Claude';
  if (upstream === 'openai') return 'OpenAI';
  if (upstream === 'ollama') return 'Ollama';
  return upstream;
}
