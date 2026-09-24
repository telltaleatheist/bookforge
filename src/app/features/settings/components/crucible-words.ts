/**
 * THE WORDS. Every sentence a person reads about a Crucible is composed here,
 * and nothing in `electron/` or `shared/` composes one.
 *
 * ── Why the code and the copy disagree on purpose ──────────────────────────
 *
 * The code says `server`, `job type`, `subject`, `task`, `module` because those
 * are the contract's names and a file that renamed them would be describing a
 * system nobody else can talk about. A person reading the app has no use for
 * any of them: they have a **GPU engine**, it **prepares** things, and it is
 * **ready** or it is **busy**. So the translation lives in exactly one file,
 * the renderer's, and the wire (`shared/crucible/coordinate-wire.ts`) carries
 * facts rather than sentences (crucible ARCHITECTURE.md R1 — one owner, and
 * the owner of the wording is the screen).
 *
 * The four rules, from the brief of 2026-09-14:
 *
 *   1. **GPU engine (Crucible)** on first mention in a panel, **engine** after.
 *      The Settings SECTION keeps the title "Crucible Servers", because that is
 *      what somebody is looking for when they know the word already.
 *   2. The pairing line is a **connect code** — "Show connect code", "Paste a
 *      connect code". Nobody has ever called a URL with a fragment a "pairing
 *      line" except this contract.
 *   3. "Open Crucible" is **Open engine console**.
 *   4. **Job types, subjects, tasks and modules never appear.** What is being
 *      prepared is said in a person's words, and the names come from the
 *      catalog rows the server itself returns ({@link subjectWords}).
 */
import type {
  CrucibleCoordinationState,
  CrucibleMissingEntry,
  CrucibleUnmetClass,
} from '@shared/crucible/coordinate-wire';
import type {
  CrucibleCapabilityView,
  CrucibleRouteRow,
  CrucibleTextActName,
  CrucibleUpstreamName,
  CrucibleUpstreamRow,
} from '@shared/crucible/settings-wire';
import { CRUCIBLE_UPSTREAM_NAMES } from '@shared/crucible/settings-wire';

/** The product name, for the one place per panel that earns a first mention. */
export const ENGINE_FIRST = 'GPU engine (Crucible)';

/**
 * What BookForge uses each job type FOR, in a person's words.
 *
 * Not a translation of Crucible's vocabulary — Crucible does not know what an
 * audiobook is — but a statement of what this app asks that environment to do.
 * That is why it lives in BookForge and why it may name things Crucible never
 * would ("narration", "proof-listening").
 *
 * `tools/test-crucible-coordinate.js` checks that every job type in
 * `shared/crucible/bookforge.module.json` has an entry here, so a module that
 * grows a sixth job type makes a keeper red rather than printing a bare `rvc`
 * at somebody.
 */
const JOB_TYPE_WORDS: Readonly<Record<string, string>> = {
  llm: 'the text engine',
  asr: 'the transcription engine',
  tts: 'the narration engine',
  align: 'the alignment engine',
  rvc: 'the voice-matching engine',
  denoise: 'the noise remover',
};

/** What each kind of weights is, for somebody who has never heard of a subject. */
const SUBJECT_KIND_WORDS: Readonly<Record<string, string>> = {
  model: 'the text model',
  voice: 'the narration voice',
  rvc: 'the voice-matching model',
  'rvc-base': 'the voice-matching basics',
  denoise: 'the noise remover',
};

/** Is this a job type this app has words for? Used by the keeper, not by a view. */
export function hasJobTypeWords(jobType: string): boolean {
  return Object.prototype.hasOwnProperty.call(JOB_TYPE_WORDS, jobType);
}

function jobTypeWords(jobType: string): string {
  const known = JOB_TYPE_WORDS[jobType];
  // A job type this build has no words for is NAMED rather than hidden. The
  // keeper above is what makes that case a red test instead of a surprise, so
  // reaching it means the server offered something newer than this app.
  return known === undefined ? `the ${jobType} engine` : known;
}

/**
 * One missing thing, as a person would say it.
 *
 * A subject's name is the manifest's display name where there is one, and the
 * id where there is not — the id IS the name in that case (PHASE13 §3.2 makes
 * `name` nullable precisely because not every manifest carries one), so this is
 * not a fallback standing in for a value that went missing.
 */
export function missingWords(entry: CrucibleMissingEntry): string {
  if (entry.what === 'job-type') return jobTypeWords(entry.jobType);
  /*
   * A CLASS SAYS WHAT BOOKFORGE ASKED FOR, then what that engine picked: "the
   * model for cleaning up text (qwen3.5-9b)". The CLASS is the half a person
   * understands and the id is the machine's — crucible
   * `docs/PHASE15-HOST.md` §5.3a is exactly the ruling that those are two
   * facts with two owners — so the sentence carries both rather than reaching
   * for `kind`, which would say "the text model" for `pages` on a
   * `llama-windows` engine, where the class resolves to the llama.cpp binaries
   * (§3.10, fact 1). That one kind is the only other thing a class can resolve
   * to, and it is named rather than called a model.
   */
  if (entry.what === 'class') {
    const thing = entry.kind === 'engine' ? 'the engine' : 'the model';
    return `${thing} for ${capabilityClassWords(entry.class)} (${subjectWords(entry)})`;
  }
  return `${subjectKindWords(entry.kind)} ${subjectWords(entry)}`;
}

/**
 * "Not on this engine: reading pages — no mlx-darwin block for dots-ocr."
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a, which is the whole reason this
 * sentence exists: a class the engine has disabled *"is not a refusal"*, so it
 * must not be drawn as one. It is a fact about that machine, said plainly,
 * with the engine's OWN reason after the dash — the row said why, and putting
 * a word of ours there is how a fixable shortfall becomes a mystery.
 *
 * The class is named with {@link capabilityClassWords}, which is the word this
 * app already has for "what a capability class is for" and is what the wizard
 * uses to say the same thing about the same classes.
 *
 * `null` WHEN NOTHING IS UNMET, because a row reading "Not on this engine:
 * nothing" would be announcing the absence of news — the same rule the
 * coordination map keeps about a server it has not asked.
 */
export function unmetWords(unmet: readonly CrucibleUnmetClass[]): string | null {
  if (unmet.length === 0) return null;
  const parts = unmet.map((entry) => `${capabilityClassWords(entry.class)} — ${entry.reason}`);
  return `Not on this engine: ${joinWords(parts)}`;
}

function subjectKindWords(kind: string): string {
  const known = SUBJECT_KIND_WORDS[kind];
  return known === undefined ? kind : known;
}

/** A subject's own name: the manifest's, or its id when the manifest has none. */
export function subjectWords(
  entry: Extract<CrucibleMissingEntry, { what: 'subject' | 'class' }>,
): string {
  return entry.name === null ? entry.id : entry.name;
}

/** "8.5 GB", or "size not declared" — never "0 GB", which nobody measured. */
/**
 * A capability row's reason, verbatim — or the sentence saying the engine gave
 * none (Crucible 1.0.25 reads an absent `reason` as null), never "null".
 */
export function reasonWords(reason: string | null): string {
  return reason === null ? 'the engine did not say why' : reason;
}

/** ` — <holder>` when the server named who holds the card; nothing when it did not. */
function whoWords(who: string | null): string {
  return who === null ? '' : ` — ${who}`;
}

export function sizeWords(bytes: number | null): string {
  if (bytes === null) return 'size not declared';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * HOW FAR A DOWNLOAD HAS GOT, in the one form a person reads.
 *
 * NO PERCENTAGE WHEN THE TOTAL IS NOT KNOWN, and the total genuinely is not
 * known for the first moments of a pack fetch (the installer's `bytes_total`
 * is null until the server answers with a length). A bar at 0% that jumps to
 * 60% is a lie about the first half; "3.4 GB so far" is not.
 */
export function bytesWords(done: number, total: number | null): string {
  const gb = (value: number): string => `${(value / 1024 ** 3).toFixed(1)} GB`;
  return total === null ? `${gb(done)} so far` : `${gb(done)} of ${gb(total)}`;
}

/** A list, with an "and" where a person would put one. */
export function joinWords(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * WHICH MODEL RUNS ONE TEXT ACT, in the server's own words.
 *
 * THREE DIFFERENT ANSWERS AND THREE DIFFERENT SENTENCES. A class this server
 * has never measured is "undecided", which is deliberately not the same news
 * as "off"; a class that is off carries the server's reason and the shortfall
 * that turned it off, which is a fact about the card and not something a
 * screen argues with; an enabled class names the model. The rule is the
 * record's own: branch on `enabled`, never on the emptiness of `selected`.
 *
 * `null` for the record means it has not been asked for yet, which is a real
 * state and not an absent one — a screen that rendered "not served here"
 * before the answer arrived would be accusing a working server.
 *
 * Every screen that shows a per-act model calls THIS (Settings → AI, Pipeline
 * Defaults, the translation panel, the analysis modal). Three of them grew
 * their own sentence for it first; this is the one that survived.
 */
export function capabilityWords(
  record: CrucibleCapabilityView | null,
  act: CrucibleTextActName,
): string {
  if (record === null) return 'asking the engine…';
  const row = record.classes.find((c) => c.capability === act);
  if (row === undefined) {
    return 'not measured yet — install a job type from the engine\'s own page to write its '
      + 'capability record';
  }
  // A reason or shortfall the server did not state is said to be missing or
  // left out — never drawn as "null" or as zero (Crucible 1.0.25).
  const why = reasonWords(row.reason);
  if (!row.enabled) {
    const short = row.shortfallBytes !== null && row.shortfallBytes > 0
      ? ` (short by ${(row.shortfallBytes / 1024 ** 3).toFixed(1)} GB)`
      : '';
    return `not served here — ${why}${short}`;
  }
  return row.selected === '' ? `enabled, and names no model — ${why}` : row.selected;
}

/**
 * WHERE A CLASS ACTUALLY RUNS, when it is not on the engine's own card.
 *
 * crucible `docs/PHASE15-HOST.md` §3.3: an engine can be configured to forward
 * one of the four text classes to Anthropic, OpenAI or a remote Ollama on the
 * operator's account, and `selected` is then the upstream model id
 * (`anthropic/claude-sonnet-5`). A screen that printed that id raw would be
 * showing somebody a slash and a vendor name where every other row shows a
 * model; this says the thing in a sentence, and keeps the id.
 *
 * `null` for a class that runs on the engine itself — there is nothing extra
 * to say about the ordinary case, and a row reading "runs here" beside every
 * local class would be a screen announcing the absence of news.
 */
export function routeWords(record: CrucibleCapabilityView | null, act: CrucibleTextActName): string | null {
  if (record === null) return null;
  const row = record.classes.find((c) => c.capability === act);
  if (row === undefined || row.route !== 'upstream') return null;
  const slash = row.selected.indexOf('/');
  if (slash <= 0) return `sent elsewhere — ${row.selected}`;
  const upstream = row.selected.slice(0, slash);
  return `sent to ${UPSTREAM_WORDS[upstream] ?? upstream} — ${row.selected.slice(slash + 1)}`;
}

/** The three upstreams, as a person writes them rather than as a config key. */
const UPSTREAM_WORDS: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  ollama: 'an Ollama server',
};

/**
 * One upstream's name, for a sentence. `an Ollama server` reads as a phrase on
 * purpose: Anthropic and OpenAI are one company each and an Ollama is whichever
 * machine the operator pointed the engine at, so naming it like a brand would
 * suggest there is only one of them.
 */
export function upstreamWords(name: CrucibleUpstreamName): string {
  return UPSTREAM_WORDS[name];
}

/**
 * The same name where a sentence needs it CAPITALISED at the front, because
 * "an Ollama server" mid-sentence becomes "An Ollama server" at the start and
 * an app that shipped one string for both positions gets one of them wrong.
 */
export function upstreamWordsLeading(name: CrucibleUpstreamName): string {
  const words = upstreamWords(name);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ENGINE'S SETTINGS, IN A PERSON'S WORDS (crucible PHASE15 §3.1, §5.2)
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── Why these paragraphs are here and not in the component ────────────────
 *
 * The same rule as everything above it: the screen owns the wording, and it
 * owns it in ONE file so that the settings section and the wizard's AI step —
 * which are literally the same component mounted twice (§5.2 asks for exactly
 * that) — cannot drift into two explanations of one door.
 *
 * They all say the same thing in different lengths, and it is the thing §5.2
 * is about: the engine holds these settings, this screen is a window onto
 * them, and a press here is a request to the engine rather than a note in a
 * file that gets synced later.
 */

/** The settings panel's opening paragraph. The panel's ONE first mention. */
export const ENGINE_SETTINGS_INTRO =
  `These settings belong to the ${ENGINE_FIRST}, not to BookForge. This panel reads them from `
  + 'the server picked above and writes straight back to it, so there is no Save button for the '
  + 'panel as a whole and nothing to keep in step: what you see is what that engine is holding, '
  + 'and every other app pointed at the same engine sees the same thing.';

/** Above the four route rows. */
export const ENGINE_ROUTES_INTRO =
  'Cleaning up text, translating, simplifying and analysing a book are four separate jobs, and '
  + 'each can run somewhere different. Left alone they run on the engine\'s own card, on whichever '
  + 'model that machine measured itself and picked. Point one at Anthropic, OpenAI or an Ollama '
  + 'server instead and it goes there from then on — chosen now, not reached for later when '
  + 'something fails.';

/** Above the local-model rows. */
export const ENGINE_LOCAL_MODELS_INTRO =
  'A job that runs on the engine\'s own card runs on a model that engine chose for itself. These '
  + 'rows are where you choose instead — and where you can hand the choice back. The list is the '
  + 'engine\'s: it ships these models for this class on this backend, and BookForge neither adds '
  + 'to it nor takes anything out of it.';

/**
 * The fit caveat, said ONCE under the rows.
 *
 * Per row it would read as a warning about that model. It is not: it is one
 * property of how the number is measured, and it is true of every row.
 *
 * MEASURED 2026-09-16 on Owen's PC, and this is the case that makes it real:
 * `qwen3.8-27b-4bit` reports 20.15 GiB against roughly 21 GiB available and
 * says it fits — under a gigabyte of headroom before any cache at all, while a
 * 16k context on a 27B model is several gigabytes of keys and values. So the
 * engine can say a model fits and then fail to load it.
 */
export const ENGINE_FIT_CAVEAT =
  'The sizes are the weights only. A model also needs room for the context it is holding, which '
  + 'is not counted here and can be several gigabytes on a large model — so "fits" is an estimate, '
  + 'not a promise, and one near the limit may still fail to load.';

/** When the engine has not measured its own card yet. */
export const ENGINE_CAPABILITY_UNDECIDED =
  'This engine has not measured its card yet, so it has no candidates to offer and no budget to '
  + 'measure them against. It decides that on its first run.';

/** Above the three upstream cards. */
export const ENGINE_KEYS_INTRO =
  'Keys and addresses live on the engine. BookForge never stores one, never reads one back and '
  + 'has no list of what any of these accounts sell — a key you type here goes to the engine and '
  + 'the engine is what calls the account.';

/** Beside the Test and Save pair, once per panel. */
export const TEST_BEFORE_SAVE_WORDS =
  'Test first: it sends what you typed without storing it and answers with the models that '
  + 'account can actually reach. Save writes it to the engine.';

/** The state of the panel before a server has been picked. */
export const ENGINE_SETTINGS_NO_SERVER =
  'Pick a server above and its settings appear here.';

/** In front of the engine\'s own refusal, which is then shown verbatim. */
export const ENGINE_SETTINGS_REFUSED_LEAD =
  'The engine would not answer for its settings:';

/** The option that reveals the free-text box, in the route select. */
export const ROUTE_CHOICE_OTHER = 'an upstream model…';

/** Beside the free-text box. */
export const ROUTE_CHOICE_OTHER_HELP =
  'Type the model id exactly as the account spells it — Test an account below and its own list '
  + 'fills this box\'s suggestions.';

/**
 * The free-text box's placeholder.
 *
 * DELIBERATELY NOT A REAL MODEL ID. §2: the engine ships no cloud model list
 * and neither does this app, and a placeholder naming a particular model is
 * the smallest possible version of shipping one — it would go stale on
 * somebody else's release schedule and read as a recommendation nobody made.
 */
export const ROUTE_CHOICE_OTHER_PLACEHOLDER = '<account>/<model id>';

/**
 * THE `local` OPTION, WHICH NAMES THE MODEL IT WOULD USE.
 *
 * "nothing fits" is the document's own answer (a `null` model on a `local`
 * route, §3.1) and it is shown rather than hidden, because a person choosing
 * between "the engine" and "Anthropic" needs to know that the first of those
 * has nothing to offer for this job. A bare "local" would let somebody pick
 * the option that cannot run.
 */
export function localRouteWords(row: CrucibleRouteRow | null): string {
  if (row === null || row.model === null) return 'this engine — nothing on it fits';
  return `this engine — ${row.model}`;
}

/**
 * An upstream model id as a choice: `Anthropic — claude-sonnet-5`.
 *
 * A raw `anthropic/claude-sonnet-5` in a list beside `qwen3.5-9b` shows
 * somebody a slash and a vendor prefix where every other row shows a model.
 * The id itself is kept, because it is what the operator typed and what the
 * engine will send.
 */
export function upstreamRouteWords(modelId: string): string {
  const slash = modelId.indexOf('/');
  if (slash <= 0) return modelId;
  const name = modelId.slice(0, slash);
  const known = (CRUCIBLE_UPSTREAM_NAMES as readonly string[]).includes(name);
  return `${known ? upstreamWordsLeading(name as CrucibleUpstreamName) : name} — ${modelId.slice(slash + 1)}`;
}

/**
 * WHICH OF THE TWO FIELDS AN ACCOUNT TAKES — `key` or `url`.
 *
 * Not wording, and it lives here anyway, because it is the one place in the
 * renderer that is allowed to know a vendor by name. §3.2: each upstream takes
 * exactly one of the two and the engine refuses the other by name
 * (`upstream_bad_field`), *"because a request carrying the other one is a
 * request about a different upstream than the one it named"*. A screen with
 * its own `name === 'ollama'` would be a second author of that rule and the
 * first thing `tools/test-no-cloud-doors.js` would call provider code coming
 * back; one function here keeps the whole panel free of vendor names.
 */
export function upstreamCredentialField(name: CrucibleUpstreamName): 'key' | 'url' {
  return name === 'ollama' ? 'url' : 'key';
}

/** What one upstream card's field is called, and what goes in it. */
export function upstreamFieldWords(
  name: CrucibleUpstreamName,
): { label: string; placeholder: string } {
  if (upstreamCredentialField(name) === 'url') {
    // The port is deliberately not spelled: `tools/test-no-cloud-doors.js`
    // treats naming it as this app dialling one, and it is right to — the
    // engine is what reaches that server, and a placeholder is not worth an
    // exception in the keeper that proves BookForge no longer talks to it.
    return { label: 'Address', placeholder: 'http://<host>:<port>' };
  }
  return { label: 'API key', placeholder: 'paste a key — it is sent to the engine, not kept here' };
}

/**
 * WHETHER THIS UPSTREAM IS SET UP, AND THE HINT **VERBATIM**.
 *
 * `keyHint` arrives with its leading ellipsis already on it (`…k3A9`, crucible
 * `c5482ff`) and is interpolated here without a character being added or
 * removed. A screen that stripped the ellipsis and re-added its own would be
 * the second author of one string, and the day the engine lengthens the hint
 * the two would disagree about what a person is looking at.
 *
 * The field is EMPTY on every draw whatever this says — a key is write-only,
 * so there is nothing to put back in the box, and this line is the whole of
 * what a person gets to recognise the stored one by.
 */
export function upstreamStateWords(name: CrucibleUpstreamName, row: CrucibleUpstreamRow | null): string {
  // Null = the engine's settings document does not describe this upstream at
  // all (Crucible 1.0.25; Owen 2026-09-24, any Crucible that answers). That is
  // not "not set up" — it is an engine that cannot say.
  if (row === null) return `This engine does not describe ${upstreamWords(name)}.`;
  if (!row.configured) {
    return `Not set up — this engine cannot send anything to ${upstreamWords(name)} yet.`;
  }
  if (name === 'ollama') {
    return row.url === null
      ? 'Set up, and the engine did not say at which address.'
      : `Set up — ${row.url}`;
  }
  return row.keyHint === null
    ? 'Set up, and the engine gave no hint at which key.'
    : `Set up — ${row.keyHint}`;
}

/**
 * WHAT A TEST FOUND, as the line that replaces a hardcoded model list.
 *
 * §2: *"the server does not ship a cloud model list"* — and neither does this
 * app. These ids came back from the account itself, seconds ago, which is the
 * only list that can be true for a particular person's key.
 */
export function upstreamTestedWords(name: CrucibleUpstreamName, models: readonly string[]): string {
  if (models.length === 0) {
    return `That ${upstreamWords(name) === 'an Ollama server' ? 'server' : 'account'} answered, `
      + 'and listed no models at all.';
  }
  return `That account reaches ${models.length} model${models.length === 1 ? '' : 's'}: `
    + `${joinWords(models)}.`;
}

/**
 * THE ONE-PRESS OFFER'S ANSWER WHEN IT HAS NOWHERE TO ROUTE TO YET.
 *
 * Pressing "use Anthropic for translating" with no model named tests the key
 * and stops there, deliberately: the engine will not guess which of an
 * account's models a job should run on, and a press that picked the first id
 * in a list would be this app choosing a model again — the exact second
 * opinion the capability record exists to end.
 */
export function nameAModelWords(name: CrucibleUpstreamName): string {
  return `Nothing was saved. Put one of those model ids in the box beside the key and press `
    + `again, and that one press sets up ${upstreamWords(name)} and sends this job there.`;
}

/**
 * CLASSES THIS ENGINE CANNOT SERVE, AND THE WAY OUT — the wizard's own line.
 *
 * §5.2: *"for each llm class that is `enabled: false` locally it says the
 * class's reason and offers 'run it through Anthropic / OpenAI / an Ollama
 * server instead'."* The offer names all three every time, because which of
 * them is set up is a thing the cards below say and not a thing to filter this
 * sentence by — a person with no account anywhere still needs to know these
 * are the three.
 */
export function unavailableOfferWords(capabilities: readonly string[]): string {
  const what = joinWords(capabilities.map(capabilityClassWords));
  const upstreams = joinWords(CRUCIBLE_UPSTREAM_NAMES.map((n) => upstreamWords(n)));
  return `This engine cannot do ${what} on its own card. Run ${capabilities.length === 1 ? 'it' : 'them'} `
    + `through ${upstreams} instead.`;
}

/** The button that does it, one press: `Use Anthropic for translating`. */
export function offerButtonWords(name: CrucibleUpstreamName, capability: string): string {
  return `Use ${upstreamWords(name)} for ${capabilityClassWords(capability)}`;
}

/**
 * A GROUP WITH NOTHING TO OFFER, still said once.
 *
 * Narration, transcription, alignment, voice matching and noise removal cannot
 * be sent to an account — §1: only the four text classes route upstream, and
 * everything else is refused `route_not_routable`. So a group of those gets
 * the news and the engine's own reason and no button, which is honest; the fix
 * for that group is on the engine's console, not on this page.
 */
export function unavailableNoticeWords(capabilities: readonly string[]): string {
  const what = joinWords(capabilities.map(capabilityClassWords));
  return `This engine does not do ${what}.`;
}

/**
 * CLASSES THIS ENGINE CANNOT SERVE FOR ONE AND THE SAME REASON, grouped.
 *
 * ── Why grouping is the contract's, not a nicety ──────────────────────────
 *
 * crucible `docs/PHASE15-HOST.md` §3.3, amended 2026-09-14 (`56cfe37`):
 * Windows IS a backend — `llama-windows`, llama.cpp children over GGUF — and
 * it serves the text classes and page reading. What it does not serve is the
 * five Python job types, and every one of those answers with **the same
 * sentence**: *"this job type needs the WSL2 engine (vLLM/SGLang); install it
 * from the console."* The contract says why it is the same sentence in all
 * five: *"so an app shows it once."*
 *
 * So this is what a panel calls instead of iterating rows: identical reasons
 * collapse into one entry carrying the classes it covers, and five copies of
 * one line become one line with five names beside it. A reason that really is
 * particular to one class — a shortfall on the card — comes back as a group of
 * one, which is the honest shape and needs no branch at the call site.
 *
 * Order is the record's, which is the server's report order, so the list does
 * not reshuffle between reads.
 */
export function unavailableGroups(
  record: CrucibleCapabilityView | null,
): { reason: string; capabilities: string[] }[] {
  if (record === null) return [];
  const groups: { reason: string; capabilities: string[] }[] = [];
  for (const row of record.classes) {
    if (row.enabled) continue;
    const reason = reasonWords(row.reason);
    const existing = groups.find((g) => g.reason === reason);
    if (existing === undefined) groups.push({ reason, capabilities: [row.capability] });
    else existing.capabilities.push(row.capability);
  }
  return groups;
}

/**
 * What BookForge uses a CAPABILITY CLASS for, in a person's words.
 *
 * Beside {@link missingWords}, which does the same for a job type, and for the
 * same reason: `rvc` and `asr` are the contract's names and nobody else's.
 * Used by {@link unavailableGroups}' callers to name the five classes a
 * Windows engine cannot serve without saying "denoise" at anybody.
 */
export function capabilityClassWords(capability: string): string {
  const known: Readonly<Record<string, string>> = {
    clean: 'cleaning up text',
    translate: 'translating',
    simplify: 'simplifying',
    analysis: 'analysing a book',
    pages: 'reading pages',
    tts: 'narration',
    asr: 'transcription',
    align: 'alignment',
    rvc: 'voice matching',
    denoise: 'noise removal',
  };
  return known[capability] ?? capability;
}

/**
 * THE ROW'S SENTENCE, one per coordination state.
 *
 * This is the whole of what replaced the old set-up button: the row
 * says what is happening instead of offering a thing to press.
 *
 * THE UNMET SENTENCE IS APPENDED TO WHATEVER THE PHASE SAID, once, here. The
 * classes an engine does not serve are true of it while it downloads, while it
 * waits half an hour on somebody else's chat, and when it is ready — so
 * hanging the sentence off the state rather than writing it into three phase
 * sentences is what stops the three from drifting apart (crucible
 * ARCHITECTURE.md R1).
 */
export function coordinationWords(state: CrucibleCoordinationState): string {
  const head = phaseWords(state);
  const unmet = unmetOf(state);
  return unmet === null ? head : `${head} ${unmet}`;
}

/**
 * THE ENGINE'S OWN ANSWER WHERE THERE IS ONE, this app's prediction until then.
 *
 * Both are read off the same capability record a second apart, so they should
 * agree — and where they do not, the ENGINE is right, because it is the thing
 * that resolved the classes (crucible PHASE9: the capability record is the one
 * place a class is resolved). `progress.unmet` is null for the whole of a
 * running task, which is why the prediction is what a person reads while the
 * download is happening rather than nothing at all.
 */
function unmetOf(state: CrucibleCoordinationState): string | null {
  if (state.phase === 'preparing' && state.progress.unmet !== null) {
    return unmetWords(state.progress.unmet);
  }
  return 'unmet' in state ? unmetWords(state.unmet) : null;
}

function phaseWords(state: CrucibleCoordinationState): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking what this engine has…';

    case 'stocked':
      /*
       * TWO SENTENCES FOR ONE PHASE, because `stocked` means "nothing is
       * missing" and that is not the same claim as "this engine can do
       * everything". An engine with a class unmet has nothing left to
       * download — which is why coordination posts no task and the phase is
       * this one — and telling somebody it has everything BookForge needs, a
       * clause before naming a class it cannot serve, would be the row
       * arguing with itself.
       */
      return state.unmet.length === 0
        ? 'Ready — this engine has everything BookForge needs.'
        : 'Ready — there is nothing left to download for this engine.';

    case 'preparing':
      return preparingWords(state);

    case 'waiting':
      // §5.4: the holder is shown VERBATIM and never as a generic failure. A
      // person told only "busy" concludes the app is broken; a person told who
      // has it concludes the system is working, which it is.
      // A server that did not name the holder says only the fact (§5.4 still
      // holds: the fact is the server's, and nothing is made up in its place).
      return state.stopped
        ? `Still busy after half an hour (${state.holder.fact})${whoWords(state.holder.who)}. `
          + 'BookForge stopped asking; it will try again the next time it reaches this engine.'
        : `Waiting: another app is using this engine (${state.holder.fact})${whoWords(state.holder.who)}. `
          + 'BookForge carries on as soon as it lands.';

    case 'refused':
      return `This engine refused what BookForge asked for (${state.code}): ${state.message}`;

    case 'unreachable':
      return state.message;
  }
}

/**
 * "Preparing narration engine — downloading deathstalker 3.2 of 8.5 GB".
 *
 * WHAT is being prepared comes from the MISSING list — the comparison this app
 * made against the server's own catalog — and not from the task's step names,
 * which are the server's spelling of its own steps and would put `tts` and
 * `rvc-base` in front of somebody (R4: a line is drawn, never read).
 *
 * The moving part comes from the `bytes` frame, which is the only thing in a
 * task's stream that carries a denominator.
 */
function preparingWords(
  state: Extract<CrucibleCoordinationState, { phase: 'preparing' }>,
): string {
  const { progress } = state;
  const what = joinWords(state.missing.map(missingWords));

  if (progress.state === 'done') {
    return `Preparation finished for ${what}.`;
  }
  if (progress.state === 'cancelled') {
    return `Stopped preparing ${what}. Everything that finished is still there.`;
  }
  if (progress.state === 'failed' && progress.error !== null) {
    return `Preparing ${what} stopped (${progress.error.code}): ${progress.error.message}`;
  }

  const head = `Preparing ${what}`;
  if (progress.bytes === null) return `${head}…`;
  const done = (progress.bytes.done / 1024 ** 3).toFixed(1);
  const total = progress.bytes.total === null
    ? null
    : (progress.bytes.total / 1024 ** 3).toFixed(1);
  // A server that did not name the file is shown downloading, not downloading "null".
  const file = progress.bytes.file === null ? '' : ` ${progress.bytes.file}`;
  return total === null
    ? `${head} — downloading${file} ${done} GB`
    : `${head} — downloading${file} ${done} of ${total} GB`;
}
