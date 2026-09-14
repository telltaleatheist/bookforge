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
} from '@shared/crucible/coordinate-wire';
import type {
  CrucibleCapabilityView,
  CrucibleTextActName,
} from '@shared/crucible/settings-wire';

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
  return `${subjectKindWords(entry.kind)} ${subjectWords(entry)}`;
}

function subjectKindWords(kind: string): string {
  const known = SUBJECT_KIND_WORDS[kind];
  return known === undefined ? kind : known;
}

/** A subject's own name: the manifest's, or its id when the manifest has none. */
export function subjectWords(entry: Extract<CrucibleMissingEntry, { what: 'subject' }>): string {
  return entry.name === null ? entry.id : entry.name;
}

/** "8.5 GB", or "size not declared" — never "0 GB", which nobody measured. */
export function sizeWords(bytes: number | null): string {
  if (bytes === null) return 'size not declared';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
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
  if (!row.enabled) {
    const short = row.shortfallBytes > 0
      ? ` (short by ${(row.shortfallBytes / 1024 ** 3).toFixed(1)} GB)`
      : '';
    return `not served here — ${row.reason}${short}`;
  }
  return row.selected === '' ? `enabled, and names no model — ${row.reason}` : row.selected;
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
    const existing = groups.find((g) => g.reason === row.reason);
    if (existing === undefined) groups.push({ reason: row.reason, capabilities: [row.capability] });
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
 */
export function coordinationWords(state: CrucibleCoordinationState): string {
  switch (state.phase) {
    case 'checking':
      return 'Checking what this engine has…';

    case 'stocked':
      return 'Ready — this engine has everything BookForge needs.';

    case 'preparing':
      return preparingWords(state);

    case 'waiting':
      // §5.4: the holder is shown VERBATIM and never as a generic failure. A
      // person told only "busy" concludes the app is broken; a person told who
      // has it concludes the system is working, which it is.
      return state.stopped
        ? `Still busy after half an hour (${state.holder.fact}) — ${state.holder.who}. `
          + 'BookForge stopped asking; it will try again the next time it reaches this engine.'
        : `Waiting: another app is using this engine (${state.holder.fact}) — ${state.holder.who}. `
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
    return `Ready — this engine now has ${what}.`;
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
  return total === null
    ? `${head} — downloading ${progress.bytes.file} ${done} GB`
    : `${head} — downloading ${progress.bytes.file} ${done} of ${total} GB`;
}
