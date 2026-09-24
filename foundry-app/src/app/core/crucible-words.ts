/**
 * THE WORDS. Every sentence a person reads about a Crucible's stock is composed
 * here, and nothing in `electron/` or `shared/` composes one.
 *
 * ── Why the code and the copy disagree on purpose ──────────────────────────
 *
 * The code says `server`, `job type`, `subject`, `task`, `module` because those
 * are the contract's names and a file that renamed them would be describing a
 * system nobody else can talk about. A person reading the app has no use for
 * any of them: they have a **GPU engine**, it **prepares** things, and it is
 * **ready** or it is **busy**. So the translation lives in exactly one file,
 * the renderer's, and the wire (`shared/coordinate-wire.ts`) carries facts
 * rather than sentences (crucible ARCHITECTURE.md R1 — one owner, and the owner
 * of the wording is the screen).
 *
 * The four rules, from the brief of 2026-09-14, and they are BookForge's
 * verbatim because the two apps talk to the same machines and must not tell one
 * person two stories about one of them:
 *
 *   1. **GPU engine (Crucible)** on first mention in a panel, **engine** after.
 *      The Settings section keeps the title "Servers", because that is what
 *      somebody is looking for when they know the word already.
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
} from '@shared/coordinate-wire';
import type { CrucibleProbe } from '@shared/slots';

/** The product name, for the one place per panel that earns a first mention. */
export const ENGINE_FIRST = 'GPU engine (Crucible)';

/**
 * What Foundry uses each job type FOR, in a person's words.
 *
 * Not a translation of Crucible's vocabulary — Crucible does not know what a
 * translated book is — but a statement of what this app asks that environment
 * to do. That is why it lives in Foundry and not in the SDK.
 *
 * Foundry's module (`shared/foundry.module.json`) names exactly one job type,
 * `llm`. The other rows are BookForge's and are kept here on purpose: a shared
 * server may report any of them back through a module task's `reload` step, and
 * a row that printed a bare `tts` at somebody would be this app's vocabulary
 * leaking through the one file whose job is to stop it.
 */
const JOB_TYPE_WORDS: Readonly<Record<string, string>> = {
  llm: 'the text engine',
  asr: 'the transcription engine',
  tts: 'the narration engine',
  align: 'the alignment engine',
  rvc: 'the voice-matching engine',
  denoise: 'the noise remover',
};

/**
 * What each kind of weights is, for somebody who has never heard of a subject.
 *
 * `engine` IS THE CATALOG KIND ADDED BY crucible `762484f`, and it is not
 * weights at all — it is the inference runtime a job type needs, `llama-cpp`
 * being the one that exists. It reads the OTHER WAY ROUND from the rest ("the
 * llama.cpp engine", never "the inference engine llama.cpp"), because that is
 * how a person says it; the word is still declared here, once, and
 * {@link missingWords} is where it is put after the name instead of before it.
 *
 * THE SDK'S `SubjectKind` LISTS IT NOW — the 0.6.0 re-pack from crucible
 * `e342fee` added `'engine'` to the union for §3.10's llama.cpp binaries. This
 * table was keyed by `string` before that and stays so, because
 * `CrucibleMissingEntry.kind` is the catalog's own word and a screen must be
 * able to say an unfamiliar one rather than fall through a union.
 */
const SUBJECT_KIND_WORDS: Readonly<Record<string, string>> = {
  model: 'the text model',
  voice: 'the narration voice',
  rvc: 'the voice-matching model',
  'rvc-base': 'the voice-matching basics',
  denoise: 'the noise remover',
  engine: 'engine',
};

/**
 * WHAT FOUNDRY ASKS EACH CAPABILITY CLASS FOR, in a person's words.
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a: the module names CLASSES and the engine
 * resolves each one, so a class is what this app asked for and the model id is
 * that machine's answer. These are the five in `shared/foundry.module.json`.
 *
 * `translate`, `simplify` and `analysis` all read "the text model" and that is
 * not a collision to fix: every card anyone has selects the same 27B for the
 * three of them, the classes are separate on Crucible's side so a bench cannot
 * say a translate job is running when a simplify job is (Owen, 2026-09-13), and
 * a person looking at a download does not need that distinction spelled at them.
 * `clean` is its own sentence because it really is a different, smaller model.
 */
const CLASS_WORDS: Readonly<Record<string, string>> = {
  clean: 'the narration cleanup model',
  translate: 'the text model',
  simplify: 'the text model',
  analysis: 'the text model',
  pages: 'the page reader',
};

/**
 * A class this build has no words for is NAMED rather than hidden, on
 * {@link jobTypeWords}'s argument: reaching it means the module asked for
 * something newer than this copy of the words, and a gap where a thing should be
 * is worse than an unfamiliar word.
 */
function classWords(cls: string): string {
  return CLASS_WORDS[cls] ?? `the ${cls} model`;
}

export function jobTypeWords(jobType: string): string {
  const known = JOB_TYPE_WORDS[jobType];
  // A job type this build has no words for is NAMED rather than hidden.
  // Reaching it means the server offered something newer than this app, and a
  // sentence with a gap where a thing should be is worse than an unfamiliar
  // word in it.
  return known === undefined ? `the ${jobType} engine` : known;
}

function subjectKindWords(kind: string): string {
  const known = SUBJECT_KIND_WORDS[kind];
  return known === undefined ? kind : known;
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
  // An ENGINE is named first and classed second — "the llama.cpp engine" — for
  // the reason SUBJECT_KIND_WORDS gives. Every other kind reads kind-then-name.
  if (entry.kind === 'engine') return `the ${subjectWords(entry)} ${subjectKindWords('engine')}`;
  /*
   * A CLASS SAYS WHAT FOUNDRY ASKED FOR, then what that engine picked: "the page
   * reader dots.ocr". The CLASS is the half a person understands and the id is
   * the machine's — §5.3a is exactly the ruling that those are two different
   * facts with two different owners, so the sentence carries both rather than
   * reaching for `kind`, which would say "the text model" for `pages` on a
   * Windows engine and "the text model" three times over on any other.
   */
  if (entry.what === 'class') return `${classWords(entry.class)} ${subjectWords(entry)}`;
  return `${subjectKindWords(entry.kind)} ${subjectWords(entry)}`;
}

/** A subject's own name: the manifest's, or its id when the manifest has none. */
export function subjectWords(
  entry: Extract<CrucibleMissingEntry, { what: 'subject' | 'class' }>,
): string {
  return entry.name === null ? entry.id : entry.name;
}

/**
 * "Not on this engine: the page reader — no mlx-darwin block for dots-ocr."
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a, which is the whole reason this sentence
 * exists: a class the engine has disabled *"is not a refusal"*, so it must not
 * be drawn as one. It is a fact about that machine, said plainly, with the
 * engine's OWN reason after the dash — the row said why, and putting a word of
 * ours there is how a fixable shortfall becomes a mystery.
 *
 * `null` WHEN NOTHING IS UNMET, because a row that said "Not on this engine:
 * nothing" would be announcing the absence of news — the same rule the
 * coordination map keeps about a server it has not asked.
 */
export function unmetWords(unmet: readonly CrucibleUnmetClass[]): string | null {
  if (unmet.length === 0) return null;
  const parts = unmet.map((entry) =>
    `${classWords(entry.class)} — ${entry.reason ?? 'the engine did not say why'}`);
  return `Not on this engine: ${joinWords(parts)}`;
}

/** "8.5 GB", or "size not declared" — never "0 GB", which nobody measured. */
export function sizeWords(bytes: number | null): string {
  if (bytes === null) return 'size not declared';
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * "190.6 MB", "95 bytes" — a size at whatever scale it actually is.
 *
 * BESIDE {@link sizeWords} RATHER THAN REPLACING IT, because the two answer
 * different questions. `sizeWords` prices WEIGHTS, which are always gigabytes,
 * and a fixed unit there means two engines' stock can be compared at a glance.
 * An uninstall plan's rows (crucible `docs/INSTALL-UNINSTALL.md` §6.3's
 * `steps[].bytes`) run from a 95-byte pairing file to a 190 MB interpreter, and
 * "0.0 GB" beside a file is a row that looks like a measurement failure.
 *
 * Zero is drawn as "empty" rather than "0 bytes": the plan says so about a
 * directory that is there and holds nothing, which is a fact a person can act
 * on, and "0 bytes" reads as the sum that was never taken.
 */
export function diskWords(bytes: number): string {
  if (bytes <= 0) return 'empty';
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** A list, with an "and" where a person would put one. */
export function joinWords(parts: readonly string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * THE ROW'S SENTENCE, one per coordination state.
 *
 * This is the whole of what a person is ever shown about coordination: the row
 * says what is happening instead of offering a thing to press (crucible
 * `docs/PHASE14-ENVPACKS.md` §4a — presence of the app is the request).
 *
 * THE UNMET SENTENCE IS APPENDED TO WHATEVER THE PHASE SAID, once, here. The
 * classes an engine does not serve are true of it while it downloads, while it
 * waits half an hour on somebody else's chat, and when it is ready — so hanging
 * the sentence off the state rather than writing it into three phase sentences
 * is what stops the three from drifting apart (crucible ARCHITECTURE.md R1).
 */
export function coordinationWords(state: CrucibleCoordinationState): string {
  const head = phaseWords(state);
  const unmet = unmetOf(state);
  return unmet === null ? head : `${head} ${unmet}`;
}

/**
 * THE ENGINE'S OWN ANSWER WHERE THERE IS ONE, this app's prediction until then.
 *
 * Both are read off the same capability record, a second apart, so they should
 * agree — and where they do not, the engine is right, because it is the thing
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
    case 'awaiting-setup':
      return 'Choose where text work runs in setup before models are prepared.';
    case 'checking':
      return 'Checking what this engine has…';

    case 'stocked':
      /*
       * TWO SENTENCES FOR ONE PHASE, because `stocked` means "nothing is
       * missing" and that is not the same claim as "this engine can do
       * everything". An engine with a class unmet has nothing left to download —
       * which is why coordination posts no task and the phase is this one — and
       * telling somebody it has everything Foundry needs, a clause before naming
       * a class it cannot serve, would be the row arguing with itself.
       */
      return state.unmet.length === 0
        ? 'Ready — this engine has everything Foundry needs.'
        : 'Ready — there is nothing left to download for this engine.';

    case 'preparing':
      return preparingWords(state);

    case 'waiting':
      // §5.4: the holder is shown VERBATIM and never as a generic failure. A
      // person told only "busy" concludes the app is broken; a person told who
      // has it concludes the system is working, which it is.
      // A server that named no holder is said as much — nothing is invented.
      return state.stopped
        ? `Still busy after half an hour (${state.holder.fact})${holderWords(state.holder.who)}. `
          + 'Foundry stopped asking; it will try again the next time it reaches this engine.'
        : `Waiting: another app is using this engine (${state.holder.fact})${holderWords(state.holder.who)}. `
          + 'Foundry carries on as soon as it lands.';

    case 'refused':
      return `This engine refused what Foundry asked for (${state.code}): ${state.message}`;

    case 'unreachable':
      return state.message;
  }
}

/**
 * "Preparing the text model Qwen3.5 9B — downloading model.safetensors 3.2 of
 * 8.5 GB".
 *
 * WHAT is being prepared comes from the MISSING list — the comparison this app
 * made against the server's own catalog — and not from the task's step names,
 * which are the server's spelling of its own steps and would put `llm` and
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
  const file = progress.bytes.file === null ? '' : ` ${progress.bytes.file}`;
  return total === null
    ? `${head} — downloading${file} ${done} GB`
    : `${head} — downloading${file} ${done} of ${total} GB`;
}

/** ` — <the server's words>`, or nothing where the server named no holder. */
function holderWords(who: string | null): string {
  return who === null ? '' : ` — ${who}`;
}

/*
 * ── WHAT AN ENGINE CAN AND CANNOT DO, IN THE FIVE ACTS FOUNDRY HAS ─────────
 *
 * Owen, 2026-09-15, on opening setup to a local hardware probe and a page of
 * Python: *"things the user might need to know about crucible setup: the GPU
 * it's connected to and how powerful it is, the functions that will be
 * available and the functions that wont be available because it isnt powerful
 * enough, what might need an API key to run."*
 *
 * `GET /v1/capability` already answers all three, per class, in the SERVER's
 * own sentences — *"qwen3.8-27b-4bit fits: it needs 20.1 GiB and there is 21.0
 * GiB available (24.0 GiB card less a 3.0 GiB desktop allowance)"*. So nothing
 * here re-derives a verdict or recomputes a fit; what is here is the two things
 * the server cannot know: WHICH of its classes this app has any use for, and
 * what this app calls them.
 */

/**
 * THE FIVE, IN THE ORDER A BOOK MEETS THEM, and the answer to "which rows does
 * Foundry draw".
 *
 * A current Crucible reports eleven classes — `tts`, `asr`, `align`, `rvc`,
 * `denoise` and `echo` among them. Those are BookForge's work and Owen's
 * complaint about this screen was precisely that it showed him things that were
 * not his business, so a setup page listing a voice engine under "what this can
 * do" would be the same defect in the other direction. The engine still serves
 * them and BookForge still draws them; this app has no act behind any of them.
 *
 * `pages` first because it is the one every book needs before anything else can
 * read it, then the four llm classes in the order the routes step draws them.
 */
export const FOUNDRY_ACTS = ['pages', 'clean', 'translate', 'simplify', 'analysis'] as const;

/**
 * What Foundry's menu calls the act a class serves.
 *
 * Deliberately NOT {@link CLASS_WORDS}, which names the MODEL ("the text
 * model") for a download row. This names the WORK, because a person reading
 * "what this engine can do" is looking for the thing they press, and three rows
 * all saying "the text model" would tell them nothing about which of the three
 * they are about to lose.
 */
const ACT_WORDS: Readonly<Record<string, string>> = {
  pages: 'Read the pages of a scan',
  clean: 'Clean up narration text',
  translate: 'Translate',
  simplify: 'Simplify',
  analysis: 'Analyse claims',
};

/** A class with no words here is NAMED, on {@link classWords}'s argument. */
export function actWords(capability: string): string {
  return ACT_WORDS[capability] ?? capability;
}

/**
 * How much bigger the card would have to be, as a phrase, or null when the
 * server did not say.
 *
 * `shortfall_bytes` is 0 on an enabled class AND on a class refused for a
 * reason that is not size — an absent model, a backend that cannot run it — so
 * zero is "no figure to quote" rather than "it fits by nothing". The server's
 * own `reason` is printed either way and is the sentence that actually explains
 * it; this is the part a person can act on, because it is the one that names a
 * different machine.
 */
export function shortfallWords(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  return `${sizeWords(bytes)} more video memory than this card has`;
}

/**
 * THE CARD AND ITS SIZE, on one line: "NVIDIA GeForce RTX 3090 Ti · 24.0 GB".
 *
 * Three screens say this — the wizard's engine step, Settings › Servers' test
 * result, and the connect door's test result — and they are three views of one
 * probe, so the sentence is composed once. Two of them used to print the bare
 * name, which answered "which card" and not Owen's other half of the question,
 * *"and how powerful it is"*.
 *
 * A host that declared no size draws the name alone: `vramBytes` is 0 there,
 * and "· 0.0 GB" beside a working engine reads as a card that is full rather
 * than a figure nobody reported.
 */
export function cardWords(probe: Extract<CrucibleProbe, { outcome: 'ok' }>): string {
  const card = probe.gpu ?? 'card not reported';
  return probe.vramBytes !== null && probe.vramBytes > 0 ? `${card} · ${sizeWords(probe.vramBytes)}` : card;
}
