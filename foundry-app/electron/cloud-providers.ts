/**
 * THE CLOUD PROVIDERS — the keys somebody has connected, and the one request
 * this app makes to a provider on its own account.
 *
 * docs/SLOTS.md §3 and §7 (Package F, app half). Owen, 2026-09-14: *"give them
 * the option of connecting an api key for openai or claude instead of using the
 * 27b or the 9b. if the user wants to they can use usage credits from a cloud
 * model… for weaker systems."*
 *
 * This module is `crucible-registry.ts`'s shape one list along, and it owns
 * exactly two things:
 *
 *   1. the configured providers, read out of and written into the app's own
 *      settings file;
 *   2. `Test` — a plain `GET` of the provider's model listing, which is the only
 *      request this app ever makes to a provider. Everything else goes through
 *      the ENGINE, spawned with the key in its environment.
 *
 * WHAT IS NOT HERE IS THE PLACEMENT. Deciding that a row goes to a provider,
 * refusing a page reading on one, and composing the spawn is
 * `crucible-dispatch.ts` — the same division the Crucible half keeps, and for
 * the same reason: this module reads and writes, that one acts on a row somebody
 * is watching.
 *
 * ── The key, and the one rule it has ────────────────────────────────────────
 *
 * It never leaves this process. It is read here, held in the settings file, and
 * handed to a spawn's `env` as `FOUNDRY_ENDPOINT_HEADERS`. It is not on a
 * command line (a command line is spelled into the terminal by `job-queue.ts`,
 * pasted into bug reports, and listed by the process table), it is not in an IPC
 * payload (the renderer's shape is `CloudProviderView`, which has a boolean
 * where this has a credential), and it is in no log line — including the ones
 * that report a failure involving it. The two `fetch`es below put it in a header
 * and nothing else reads it.
 *
 * ── Why there is no capability read, no residency and no lease ──────────────
 *
 * Because a provider has none of those facts. Nothing is resident, so nothing
 * can be evicted and there is nothing to lease; it is never BUSY in the sense a
 * Crucible is, because the queue on the other side is somebody else's and a
 * 429 is waited out by the engine rather than reported here (docs/VLLM.md §2a).
 * The only thing that can be wrong before a run starts is the key or the model
 * name, and `Test` asks both in one unbilled request.
 */
import { hosted } from './host';
import {
  CLOUD_PROVIDER_MAX,
  readAppSettings,
  writeAppSettings,
  clampCloudEndpoint,
  clampCloudModel,
  type CloudProviderEntry,
} from './app-settings';
import {
  CLOUD_PROVIDER_ENDPOINT,
  CLOUD_PROVIDER_LABEL,
  slotNameRefusal,
  tidySlotName,
  type CloudProbe,
  type CloudProviderEdit,
  type CloudProviderKind,
  type CloudProviderView,
} from '../shared/slots';

/**
 * THE DIALECT HEADER ANTHROPIC REQUIRES, and the one place this app spells it.
 *
 * The ENGINE adds it to every request it makes (`ANTHROPIC_DIALECT_HEADERS`,
 * src/translate/anthropic.ts) because it is a property of the dialect rather
 * than of the endpoint — so the placement's header map deliberately does NOT
 * carry it. This constant exists for the other caller: the `Test` below, which
 * is this app talking to the provider directly and gets no engine to add it.
 *
 * Kept in step with the engine's own value by hand, because the app cannot
 * import from `src/`. A version the provider has retired answers 400 naming the
 * field, which is the failure the card prints verbatim.
 */
const ANTHROPIC_VERSION = '2023-06-01';

/** How long a listing may take before it is a dead address. See `probeCloud`. */
const PROBE_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────────
// The list
// ─────────────────────────────────────────────────────────────────────────────

/** Every configured provider, in card order. The stored shape, key and all. */
export function cloudProviders(): CloudProviderEntry[] {
  return readAppSettings().cloudProviders;
}

/** The ones that are slots. Off is not a slot at all — see `AppSettings`. */
export function enabledCloudProviders(): CloudProviderEntry[] {
  return cloudProviders().filter((entry) => entry.enabled);
}

/** One entry by name, or null. Case-insensitive, because the picker is. */
export function cloudProviderNamed(name: string): CloudProviderEntry | null {
  const key = name.trim().toLowerCase();
  return cloudProviders().find((entry) => entry.name.toLowerCase() === key) ?? null;
}

/** The list as the renderer is allowed to see it. */
export function cloudProviderViews(): CloudProviderView[] {
  return cloudProviders().map(viewOf);
}

function viewOf(entry: CloudProviderEntry): CloudProviderView {
  return {
    name: entry.name,
    kind: entry.kind,
    model: entry.model,
    endpoint: entry.endpoint,
    enabled: entry.enabled,
    keySet: entry.apiKey.length > 0,
  };
}

/**
 * WHERE THIS ENTRY'S REQUESTS GO — the entry's own address, or the provider's.
 *
 * Resolved HERE and not at rest, so that a provider moving its API is a change
 * to `CLOUD_PROVIDER_ENDPOINT` rather than a migration of everybody's settings
 * file. Two readers: the placement, which puts it on `--endpoint`, and the probe
 * below, which asks the same server the run will ask.
 */
export function cloudEndpointOf(entry: CloudProviderEntry): string {
  return entry.endpoint.length > 0 ? entry.endpoint : CLOUD_PROVIDER_ENDPOINT[entry.kind];
}

/**
 * THE HEADER MAP FOR ONE SPAWN, as the JSON the engine reads — and NOTHING
 * ELSE IS IN IT.
 *
 * No `X-Crucible-*`: those three headers are what a Crucible's own log and its
 * busy line are keyed by (`headerMapFor`, crucible-dispatch.ts), and sending
 * them to OpenAI would be this app naming somebody else's product on a wire that
 * has never heard of it. No `anthropic-version` either — the engine adds that
 * one itself, because it is a property of the dialect and the engine is what
 * speaks the dialect.
 *
 * NEVER LOGGED, and this function is small and single-purpose for that reason:
 * the string it produces is a credential, and the only thing ever done with it
 * is putting it in a child's environment.
 */
export function cloudHeaderMapFor(entry: CloudProviderEntry): string {
  return JSON.stringify(
    entry.kind === 'anthropic'
      ? { 'x-api-key': entry.apiKey }
      : { Authorization: `Bearer ${entry.apiKey}` },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * REPLACE THE WHOLE LIST — add, remove, rename, re-model and enable, at once.
 *
 * `writeCrucibleServers`' argument word for word: four of the five edits are the
 * same operation on an array, the card holds the array it is editing and sends
 * it whole, and the last write wins. The KEY is carried by its ABSENCE —
 * `apiKey: null` means "keep what is stored", matched by NAME against the stored
 * list, which is why a rename and a new key in one gesture is the one case the
 * card must send a key for.
 *
 * ── THE ONE REFUSAL THAT READS THE OTHER LIST ──────────────────────────────
 *
 * A slot list with two rows called one thing is a row nobody can choose between,
 * and the two registries are two arrays with two clamps that cannot see each
 * other. So the name check against the CRUCIBLE servers is here, at the writer,
 * where both lists are readable — and it is a refusal by name rather than a
 * silent drop, because somebody who typed "Mac Studio" into this card meant
 * something by it and deserves to be told what is already called that.
 */
export function writeCloudProviders(edits: readonly CloudProviderEdit[]): CloudProviderView[] {
  const stored = new Map(cloudProviders().map((entry) => [entry.name.toLowerCase(), entry]));
  const crucibles = new Set(
    readAppSettings().crucibleServers.map((entry) => entry.name.toLowerCase()),
  );
  const next: CloudProviderEntry[] = [];
  for (const edit of edits.slice(0, CLOUD_PROVIDER_MAX)) {
    const name = tidySlotName(edit.name);
    /*
     * ONE NAME RULE FOR BOTH LISTS — `slotNameRefusal` (shared/slots.ts), which
     * `writeCrucibleServers` consults for the same reason: these two arrays feed
     * ONE picker and one lane string, and a name that was legal on this card and
     * not on that one would be a rule somebody has to learn twice.
     */
    const wrongName = slotNameRefusal(name, 'provider');
    if (wrongName !== null) throw new Error(wrongName);
    if (crucibles.has(name.toLowerCase())) {
      throw new Error(
        `"${name}" is already the name of a Crucible server. Two slots with one name is a row `
        + 'nobody can choose between — give this one a different name.',
      );
    }
    if (edit.kind !== 'openai' && edit.kind !== 'anthropic') {
      throw new Error(`"${name}" must be an OpenAI or an Anthropic provider.`);
    }
    const model = clampCloudModel(edit.model);
    if (model.length === 0) {
      throw new Error(
        `"${name}" needs a model id — a provider holds a catalog and there is no default to fall `
        + `back on. Press Test to see what this key can use (e.g. `
        + `${CLOUD_PROVIDER_LABEL[edit.kind]}'s own listing).`,
      );
    }
    const endpoint = clampCloudEndpoint(edit.endpoint);
    if (endpoint === null) {
      throw new Error(
        `"${name}" needs an address like https://example.com/v1, or nothing at all for `
        + `${CLOUD_PROVIDER_ENDPOINT[edit.kind]}.`,
      );
    }
    const carried = stored.get(name.toLowerCase());
    const apiKey = typeof edit.apiKey === 'string' && edit.apiKey.trim().length > 0
      ? edit.apiKey.trim()
      : carried?.apiKey ?? '';
    if (apiKey.length === 0) {
      throw new Error(`"${name}" needs an API key. Paste the one ${CLOUD_PROVIDER_LABEL[edit.kind]} issued.`);
    }
    next.push({ name, kind: edit.kind, apiKey, model, endpoint, enabled: edit.enabled !== false });
  }
  /*
   * THE CLAMP IS THE SECOND READER AND THE LAST WORD, `writeCrucibleServers`'
   * rule: everything above refuses by name so the card can say what to fix, and
   * `clampCloudProviders` drops what it still cannot store. The answer is read
   * back OUT of the file rather than returned from this array, on this app's
   * standing rule that a settings door answers with what was stored and never
   * with what was sent.
   */
  writeAppSettings({ cloudProviders: next });
  return cloudProviderViews();
}

/**
 * HOSTED, THE SLOTS ARE SOMEBODY ELSE'S — `refuseHostedRegistryChange`'s
 * refusal, for its reason (docs/SLOTS.md §3: *"The vendored (BookForge-hosted)
 * app takes its slot list from the host"*).
 *
 * ── AND IT NO LONGER REFUSES HOSTED, WHICH IS THE POINT OF THE RECORD ──────
 *
 * This door used to throw inside a host, on the reasoning that the slots were
 * the host's and so the providers should be too. That was wrong twice over.
 * Owen's rule is that a machine under the translate floor reaches those acts
 * through a 27B or *"an api key for Claude or OpenAI"*, and a BookForge user
 * on a laptop is exactly that machine — refusing here left them no path. And
 * the record is not the host's to hold: hosted, this app's settings file IS
 * the host's userData (app-settings.ts), so there is ONE store either way, and
 * BookForge's own doors read this record rather than keeping a second list of
 * keys and model names. One fact, one owner, and the owner is the card the
 * person typed the key into.
 *
 * WHAT IS STILL THE HOST'S IS THE CRUCIBLE REGISTRY (`crucible-registry.ts`,
 * `refuseHostedRegistryChange`). The two are not the same question: a Crucible
 * is a machine the host administers, and a cloud key is the user's own.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Test — the one request this app makes to a provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LIST THE MODELS, AND SAY WHETHER THE CHOSEN ONE IS AMONG THEM.
 *
 * ── Why the edit and not a name ────────────────────────────────────────────
 *
 * The card has one Test button and it has to work on a row that has never been
 * saved — somebody pastes a key, types a model and wants to know whether the
 * pair is right BEFORE it is written to disk. Saving first in order to find out
 * would be this app writing a credential into somebody's settings to answer a
 * question. So the whole edit crosses, and `apiKey: null` resolves against the
 * stored entry of that name exactly as the save does — which is what makes the
 * button work on an untouched row too.
 *
 * A FAILURE IS A RESULT AND NOT A REJECTION, `probeCrucible`'s rule: the card
 * prints the sentence under the row, and there is nothing to press.
 */
export async function probeCloud(edit: CloudProviderEdit): Promise<CloudProbe> {
  const kind: CloudProviderKind = edit.kind === 'anthropic' ? 'anthropic' : 'openai';
  const model = clampCloudModel(edit.model);
  const endpoint = clampCloudEndpoint(edit.endpoint);
  if (endpoint === null) {
    return {
      outcome: 'failed',
      message: `That needs to be an address like https://example.com/v1, or nothing at all for `
        + `${CLOUD_PROVIDER_ENDPOINT[kind]}.`,
    };
  }
  const stored = typeof edit.name === 'string' ? cloudProviderNamed(edit.name) : null;
  const apiKey = typeof edit.apiKey === 'string' && edit.apiKey.trim().length > 0
    ? edit.apiKey.trim()
    : stored?.apiKey ?? '';
  if (apiKey.length === 0) {
    return {
      outcome: 'failed',
      message: `There is no key to test with. Paste the one ${CLOUD_PROVIDER_LABEL[kind]} issued.`,
    };
  }
  const base = endpoint.length > 0 ? endpoint : CLOUD_PROVIDER_ENDPOINT[kind];
  try {
    const models = await listModels(kind, base, apiKey);
    return { outcome: 'ok', models, chosen: model, chosenListed: models.includes(model) };
  } catch (err) {
    /*
     * THE MESSAGE IS THE ONE `listModels` COMPOSED, which always names the URL
     * that was asked and never the key. A key is not printable and a sentence
     * that quoted part of one would be a credential in a screenshot.
     */
    return { outcome: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `GET <base>/models` at OpenAI, `GET <base>/v1/models` at Anthropic.
 *
 * ── The two routes are the two doors' own normalisation, mirrored ───────────
 *
 * The OpenAI door treats `--endpoint` as a base that already carries a version
 * and appends `/v1` when it does not (`normaliseVllmEndpoint`,
 * src/translate/vllm.ts); the Anthropic door STRIPS a trailing version and
 * composes `/v1/...` itself (`normaliseAnthropicEndpoint`). Asking the same way
 * each door will is the whole point of this function: a Test that probed a
 * different URL from the run would pass for a server the run cannot reach.
 *
 * BOTH PROVIDERS ANSWER `{"data": [{"id": …}]}`, which is why one reader serves
 * both. An answer shaped otherwise is a refusal naming the URL rather than an
 * empty list, because an empty list would read as "this key may use nothing".
 */
async function listModels(
  kind: CloudProviderKind,
  base: string,
  apiKey: string,
): Promise<string[]> {
  const url = kind === 'anthropic'
    ? `${base.replace(/\/v\d+$/, '')}/v1/models`
    : `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/models`;
  const headers: Record<string, string> = kind === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION }
    : { Authorization: `Bearer ${apiKey}` };
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers,
      /*
       * A CLOCK ON THIS ONE, unlike the dispatch path. A placement may wait —
       * there is a row on screen wearing the word "placing" — but this is a
       * button somebody pressed and is watching, and a provider behind a
       * captive-portal wifi would otherwise leave it saying "Testing…" forever.
       */
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(
      `${url} did not answer (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    /*
     * THE PROVIDER'S OWN SENTENCE WHERE THERE IS ONE — both spell a refusal as
     * `{"error": {"message": …}}`, and their messages already name what to fix
     * ("Incorrect API key provided", "model: … not found"). A word of ours in
     * place of one of those is how a fixable problem becomes an unfixable one.
     * The status is kept beside it because a 401 and a 404 are different fixes
     * and a message alone does not always say which it was.
     */
    let said = '';
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } } | null;
      if (typeof parsed?.error?.message === 'string') said = parsed.error.message;
    } catch {
      said = '';
    }
    throw new Error(`${url} answered ${response.status}: ${said || text.slice(0, 300) || '(nothing)'}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${url} answered something that is not JSON.`);
  }
  const rows = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`${url} answered without a model list, so nothing here can say what this key may use.`);
  }
  return rows.flatMap((row): string[] => {
    if (typeof row !== 'object' || row === null) return [];
    const id = (row as Record<string, unknown>)['id'];
    return typeof id === 'string' && id.length > 0 ? [id] : [];
  });
}
