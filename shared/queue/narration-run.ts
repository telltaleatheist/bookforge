/**
 * WHAT A NARRATION RUN IS MADE OF — read the book aloud, enhance the voice,
 * assemble the audiobook — declared once, for every process that composes one.
 *
 * ── Why this moved out of the renderer ──────────────────────────────────────
 *
 * It was written where its two callers were: the Process page and the TTS copy's
 * Process modal, both in `src/`. Its own header said why it existed at all —
 * "two callers writing the same object literals is two answers to 'what does a
 * narration run consist of', and they drift the day one of them gains a field,
 * which is precisely how a run ends up rendering at a default voice nobody
 * chose."
 *
 * A THIRD CALLER ARRIVED IN MAIN, and it is not a renderer at all. Foundry's own
 * window can now ask for a narration (`bookforge.narrate`, electron/main.ts): the
 * dialog is drawn over there out of a field description, the answers come back
 * to our main process, and the run has to be composed with no renderer in the
 * conversation. Composing it beside the modal was never possible; composing it
 * AGAIN in main would be exactly the drift this file was written to prevent. So
 * the description moved to `shared/`, which both programs already compile
 * against, and nothing about it changed on the way.
 *
 * ── What it is, and what it deliberately is not ─────────────────────────────
 *
 * It is a DESCRIPTION OF WORK. Nothing here queues anything, reads a signal,
 * touches disk or knows what a job id is: it takes a book and a set of choices
 * and gives back the steps, in the order they must execute. Whoever is
 * submitting decides where they land — the renderer wraps each plan in the
 * `CreateJobRequest` its queue service speaks, main turns the first into a
 * `JobSpec` and appends the rest — because that wrapper is a fact about the
 * caller's door and not about the run.
 *
 * ── Everything that can fail, fails before anything is queued ───────────────
 *
 * A workflow half in the queue cannot be retried without double-queueing it. So
 * this refuses BY NAME — throwing, with nothing built — rather than emitting a
 * plan with a hole in it. A missing voice is the case that matters: the queue
 * would otherwise fall back to a stock one and hand back an audiobook in the
 * wrong voice after an hour of GPU.
 *
 * ── What it deliberately does NOT cover ─────────────────────────────────────
 *
 * Resuming a NAMED partial session, and the optional video. Both are runs about
 * a session the wizard found and can point at by path, and the Process page owns
 * finding them.
 *
 * Reassembling a cached session, and converting one through an RVC voice, ARE
 * covered — since the stage flags became three (2026-08-26). Those runs name no
 * session either: they say "this project's cached one", the steps resolve it
 * when they run, and that is a run about a BOOK like any other here.
 */

import type { ArtifactRef } from './engine-types';

/** The RVC pass, when the user asked for one. */
export interface NarrationRvcSettings {
  readonly voiceId: string;
  readonly indexRate: number;
  /**
   * Consonant/breath protection, and it reads BACKWARDS from every doc.
   *
   * urvc's pipeline gates the whole protection block on `if protect < 0.5:`
   * (ultimate_rvc/rvc/infer/pipeline.py), so LOWER protects MORE and 0.5 turns
   * protection off entirely. It is also a NO-OP at index rate 0, because the
   * un-retrieved features it blends back are only cloned when retrieval runs.
   */
  readonly protectRate: number;
  readonly nSemitones: number;
  /**
   * Pitch-extraction method — 'rmvpe', 'crepe' or 'crepe-tiny'.
   *
   * OPTIONAL MEANS "urvc's own default", which is the one shape of absence this
   * description allows: there is a real engine answer for the question, so
   * declining to answer it is a choice rather than a missing value. When the UI
   * has a concrete choice it sends it.
   */
  readonly f0Method?: string;
  /**
   * f0 analysis hop, in samples. Only the crepe family reads it — rmvpe ignores
   * it entirely — so it travels beside `f0Method` and means nothing without one.
   * Optional in the same sense: absent is urvc's own default.
   */
  readonly hopLength?: number;
}

/**
 * WHICH ACTS THIS RUN PERFORMS.
 *
 * Three independent facts rather than a mode, because the combinations are not a
 * ladder: a run can read the book and stop, and a run can enhance sentences that
 * were rendered weeks ago without reading anything. The pair this replaced
 * (`{narrate, assemble}`) could not say the difference between "narrate, then
 * enhance, then assemble" and "narrate, then assemble" — enhancement was implied
 * by `settings.rvc` being non-null, so turning the pass off meant erasing its
 * settings, and a cache-only enhancement could not be asked for at all.
 */
export interface NarrationRunStages {
  /** Read the book aloud. False means the sentences already exist. */
  readonly narrate: boolean;
  /**
   * RUN THE ENHANCEMENT PASSES — at least one of them.
   *
   * It was `rvc` until Owen's ruling of 2026-08-29 moved the denoise onto the
   * same tab: "not a casual click — it takes real GPU work", same as the
   * conversion. There are now TWO passes behind this one flag, and WHICH of them
   * run is the settings' answer (`finalDenoise`, `rvc`) rather than the stage's —
   * exactly as which VOICE is the settings' answer and not the stage's. The stage
   * says whether the enhancement happens at all, which is what the tab's own
   * checkbox has always meant.
   */
  readonly enhance: boolean;
  /** Combine the sentences into the M4B. */
  readonly assemble: boolean;
}

/**
 * WHICH ENHANCEMENT PASS GOES FIRST, when the run performs both.
 *
 * Owen, 2026-08-29: the user usually wants one of the two, both together must
 * remain allowed, and when both are chosen the USER PICKS THE ORDER.
 *
 * 'denoise-first' is the default and the recommendation: RVC extracts f0 and
 * content features from whatever it is handed and noise corrupts that
 * extraction, while the roformer is proven to leave clean audio unchanged — so
 * denoising first is the composition that cannot make things worse. The reverse
 * is the user's right rather than a second recommendation.
 */
export type NarrationEnhancementOrder = 'denoise-first' | 'rvc-first';

/** One enhancement pass, named as the step it becomes. */
export type NarrationEnhancementPass = 'denoise' | 'rvc';

/** WHICH file is narrated, and what the audiobook is called. */
export interface NarrationRunBook {
  /**
   * THE document this run reads — absolute.
   *
   * Owen's law, 2026-08-09: "the tts pipeline knows exactly which file its
   * working with because the user came to the tts page FROM the button on that
   * document." It is carried here rather than derived, and it is checked,
   * because a run that narrated the wrong file would look completely normal
   * until somebody listened to it.
   */
  readonly epubPath: string;
  /** The project the session, the enhancement and the assembly belong to. */
  readonly projectDir: string;
  /**
   * WHICH VERSION of the book this document is — carried for the same reason
   * the path is, and checked for the same reason.
   *
   * Owen, 2026-08-10: "if the user wants to process a specific TTS document then
   * they click the process button next to it. no ambiguity, no confusion." A
   * project may hold several versions of one book; the path says which FILE, and
   * this says which of the project's version RECORDS that file is. It is the
   * manifest variant id — the row the Process button was pressed on.
   */
  readonly variantId: string;
  readonly title: string;
  readonly author: string;
  /** '' when the book states none — passed through as absent, never invented. */
  readonly year: string;
  readonly coverPath: string;
  /** The M4B's filename, derived by the caller from the project's own record. */
  readonly outputFilename: string;
  /**
   * An article rather than a book.
   *
   * The two carry the project directory in different fields — an article's jobs
   * take `projectDir` and a book's take `bfpPath` — and that is not cosmetic:
   * they are what the bridges resolve a session and an output folder from.
   */
  readonly isArticle: boolean;
}

/** Everything the user chose about HOW it is read and assembled. */
export interface NarrationRunSettings {
  readonly language: string;
  readonly ttsEngine: string;
  /** The voice. Empty is refused by name rather than defaulted. */
  readonly voice: string;
  readonly device: 'auto' | 'gpu' | 'mps' | 'cpu';
  readonly speed: number;
  readonly workers: number;
  /** The library's audiobooks folder — where the finished M4B is filed. */
  readonly outputDir: string;
  /**
   * RUN THE ROFORMER DENOISE — one of the two enhancement passes.
   *
   * It was an assembly option until 2026-08-29 and is now a pass of its own,
   * chosen on the same tab as the conversion, because it is the same kind of
   * thing: an hour of GPU over the whole book. Only read when
   * `NarrationRunStages.enhance` is on.
   */
  readonly finalDenoise: boolean;
  /**
   * Which of the two enhancement passes runs first. Only read when BOTH of them
   * do; stated always, because a run that could not say it would be composed in
   * whichever order this file happened to write, which is a choice with the
   * user's name on it.
   */
  readonly enhancementOrder: NarrationEnhancementOrder;
  readonly applyDeRing: boolean;
  /**
   * Seconds of silence to normalize BETWEEN sentences at assembly, or absent to
   * let the session's own provenance decide.
   *
   * Absent is a real answer and the ordinary one: an Orpheus session normalizes
   * to its voice's tuned value (or the visible 0.6 s default for an untested
   * model), and a non-Orpheus session normalizes not at all, because the pad
   * this strips is one only Orpheus bakes. A number here OVERRIDES that, which
   * is why it is only ever set from a control the user actually moved.
   */
  readonly sentenceGap?: number;
  /** The enhancement pass, or null for none. */
  readonly rvc: NarrationRvcSettings | null;
  /**
   * Clear whatever half-rendered session is cached for this project first.
   *
   * TRUE exactly when the user was shown a Continue/Start-fresh choice and chose
   * fresh. A run that was never offered the choice sends false, because clearing
   * a cache nobody mentioned is an hour of GPU thrown away silently.
   */
  readonly startFresh: boolean;
  /**
   * WHETHER THE NARRATION TEXT CLEANUP IS REQUIRED OF THIS RUN.
   *
   * Owen, 2026-09-05: *"make it so i dont HAVE to run cleanup. give me a skip
   * button on that cleanup modal that appears."* So the cleanup gate is a
   * question with three answers now — run it, skip it, or don't narrate — and
   * this is the third of them travelling with the run.
   *
   * `'required'` is the ordinary answer and means exactly today's behaviour: the
   * render door reads the book's stamp and REFUSES an unstamped book by name.
   * `'skipped'` is set ONLY when the user was shown the offer and chose to
   * narrate the book as printed; the door then says so, loudly, in the job log
   * and in the prep provenance, and reads the digits as they stand.
   *
   * Stated always, never defaulted downstream. A run that could not say which
   * of the two it is would be deciding, in whichever direction some `??`
   * happened to lean, whether an hour of GPU reads "1933" or "nineteen
   * thirty-three".
   */
  readonly textCleanup: NarrationTextCleanupChoice;
}

/**
 * The two answers a run can carry about the narration text cleanup.
 *
 * Declared once, here, because the same word travels from the modal through the
 * queue's job config into `prepareNarrationInput`'s options, and a second
 * spelling of it anywhere on that path is a second answer to the same question.
 */
export type NarrationTextCleanupChoice = 'required' | 'skipped';

// ────────────────────────────────────────────────────────────────────────────
// The configs
// ────────────────────────────────────────────────────────────────────────────
//
// Each is declared as the EXACT set of fields this description sets, rather than
// as a Partial of the queue's own union. That is what keeps the two callers'
// type checks honest: the renderer assigns these into `Partial<JobConfig>` and
// main hands them to the engine as a step config, and a field whose type drifts
// on either side is a compile error here rather than a value that arrives
// somewhere as a string nobody reads.

/** What e2a is told to do with the book. */
export interface NarrationTtsConfig {
  readonly type: 'tts-conversion';
  readonly device: 'auto' | 'gpu' | 'mps' | 'cpu';
  readonly language: string;
  readonly ttsEngine: string;
  /** The voice. `fine_tuned` on e2a's side, which is where the name comes from. */
  readonly fineTuned: string;
  readonly speed: number;
  readonly enableTextSplitting: boolean;
  readonly useParallel: boolean;
  readonly parallelMode: 'sentences';
  readonly parallelWorkers: number;
  readonly outputDir: string;
  readonly skipAssembly: boolean;
  readonly finalDenoise: boolean;
  readonly startFresh: boolean;
  /**
   * The user's answer about the cleanup, carried all the way to the door.
   *
   * `startParallelConversion` hands it to `prepareNarrationInput`, which either
   * consults the book's stamp (`'required'`) or announces the skip and reads the
   * book as printed (`'skipped'`). Not optional: see
   * {@link NarrationRunSettings.textCleanup}.
   */
  readonly textCleanup: NarrationTextCleanupChoice;
}

/** Re-render the sentences through an RVC model. */
export interface NarrationRvcConfig {
  readonly type: 'rvc-enhancement';
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly processDir: string;
  readonly voiceId: string;
  readonly indexRate: number;
  readonly protectRate: number;
  readonly nSemitones: number;
  /** Absent = urvc's own default. See `NarrationRvcSettings.f0Method`. */
  readonly f0Method?: string;
  /** Absent = urvc's own default; read only by the crepe family. */
  readonly hopLength?: number;
  /*
   * NO `finalDenoise` HERE ANY MORE. The conversion used to denoise its own
   * input, which is how "denoise before RVC" was realised before the order
   * became the user's choice. It is a separate row now, in whichever position
   * was chosen, and a conversion config that still carries the flag is REFUSED
   * by the job (electron/rvc-job.ts) rather than ignored — so it must not be
   * set, not merely left false.
   */
  /**
   * The inter-sentence gap, when the user moved the control — SET ONLY WHEN THIS
   * PASS READS THE RAW SENTENCES, i.e. when the conversion is the first
   * enhancement pass of the run.
   *
   * The gap pass must see the raw sentences and their exactly-zero trailing pad,
   * which both a roformer and a conversion destroy, so it is baked in by
   * whichever pass touches them first. When a denoise runs in front of this one,
   * that denoise owns the gap and this config carries none.
   */
  readonly sentenceGap?: number;
}

/**
 * DENOISE THE SENTENCES — the roformer pass, on its own row.
 *
 * It was a flag on the assembly until 2026-08-29. That made the assembly a GPU
 * step for its whole duration, so the card stayed held through the chapter
 * combine and the AAC encode — the long tail, and pure CPU. Its own row is what
 * lets the assembly contend for the cpu pool while the GPU moves to the next run.
 *
 * IT IS QUEUED ALONGSIDE THE CONVERSION when the run performs both, in the order
 * the user chose. It used to be suppressed then — the conversion denoised its own
 * input — which is exactly the coupling the ordering ruling removed: two passes,
 * two rows, each a clean transform of its parent's output.
 *
 * WHAT IT READS is not stated here. First in the run it reads the session; behind
 * a conversion it reads that conversion's output, and the queue hands it over as
 * the parent's artifact. A path written here at compose time would name a
 * directory the pass in front of it has not produced yet.
 */
export interface NarrationDenoiseConfig {
  readonly type: 'final-denoise';
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly processDir: string;
  /**
   * Absent = the session's provenance decides — and absent ALWAYS when a
   * conversion runs in front of this pass, because by then the gap is baked in
   * and the pad it is detected by is gone. See `NarrationRvcConfig`.
   */
  readonly sentenceGap?: number;
}

/** Combine the rendered sentences into the M4B. */
export interface NarrationReassemblyConfig {
  readonly type: 'reassembly';
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly processDir: string;
  readonly outputDir: string;
  readonly metadata: {
    readonly title: string;
    readonly author: string;
    readonly coverPath?: string;
    readonly year?: string;
    readonly outputFilename: string;
  };
  readonly excludedChapters: number[];
  /*
   * NO `finalDenoise` HERE ANY MORE. The denoise is its own step, and an assembly
   * config that still carries the flag is REFUSED by the bridge rather than
   * ignored (electron/reassembly-bridge.ts) — so it must not be set, not merely
   * left false.
   */
  readonly applyDeRing: boolean;
  /**
   * Absent = the session's provenance decides. See `NarrationRunSettings`.
   *
   * Set only when NOTHING UPSTREAM bakes the gap in. A denoise or a conversion in
   * front of this assembly hands it a set the gap is already applied to, and the
   * assembly skips its own gap pass on a supplied set — so carrying the number
   * here as well would state a knob twice and answer it in only one place.
   */
  readonly sentenceGap?: number;
  /**
   * FILE THIS AS A SECOND AUDIOBOOK RATHER THAN AS THE PROJECT'S ONE AUDIOBOOK.
   *
   * True exactly when this run enhanced sentences it did not render — the book
   * already has an audiobook made from those same sentences, and overwriting it
   * would destroy the original to produce its alternative. A run that rendered
   * the sentences itself produced ONE audiobook however many passes it took, so
   * it files into the base slot as every narration always has.
   *
   * Stated rather than inferred downstream: the assembler cannot tell a
   * cache-only enhancement from a fresh chain by looking at what it was handed —
   * both arrive as a directory of sentences.
   */
  readonly registerAsNewVariant: boolean;
  /**
   * The RVC voice the sentences were converted through, when one was. It NAMES
   * the second audiobook — its variant id, its file and its narrator tag are all
   * this voice — so re-running the same voice replaces that version and a
   * different voice mints another beside it.
   */
  readonly rvcVoiceId?: string;
}

/** What the queue row calls itself and what the M4B is tagged with. */
export interface NarrationRunMetadata {
  readonly title: string;
  readonly bookTitle?: string;
  readonly author: string;
  readonly year?: string;
  readonly coverPath?: string;
  readonly outputFilename?: string;
}

/**
 * ONE STEP OF THE RUN, as far as this description goes.
 *
 * The project directory appears twice with two names and that is not a
 * duplication: `projectDir` is what an ARTICLE's jobs are resolved from and
 * `bfpPath` is what a BOOK's are, and exactly one of them is set. The renderer's
 * request shape and main's step config both read the pair the same way, so the
 * choice is made here, once, rather than in each caller's mapping.
 */
export interface NarrationStepPlan {
  readonly type: 'tts-conversion' | 'final-denoise' | 'rvc-enhancement' | 'reassembly';
  readonly config:
    | NarrationTtsConfig
    | NarrationDenoiseConfig
    | NarrationRvcConfig
    | NarrationReassemblyConfig;
  readonly metadata: NarrationRunMetadata;
  /** Set on the step that READS the book. The later two read a session. */
  readonly epubPath?: string;
  readonly variantId: string;
  readonly bfpPath?: string;
  readonly projectDir?: string;
  /**
   * WHAT THIS STEP READS WHEN NOTHING IN THE RUN PRECEDES IT — set on the first
   * step of the plan and on no other.
   *
   * The queue engine refuses a chain whose first step reads a kind its source
   * does not provide, at COMPOSE time (`checkLineage`, electron/queue-engine.ts),
   * and both doors used to hand it the document unconditionally. That is right
   * for a run that starts by reading the book and wrong for one that starts by
   * converting sentences: an enhancement pointed at an EPUB is refused before it
   * can explain itself. So the description says which, because it is the side
   * that knows which act comes first.
   *
   * A cache-only run's ref carries a KIND AND NO PATH on purpose. The session it
   * reads is whichever one this project has cached, and that is a question about
   * the disk at the moment the step runs — the steps resolve it themselves
   * (`getBfpCachedSession`), and a path guessed at compose time would name a
   * directory a later narration had already replaced.
   */
  readonly sourceRef?: ArtifactRef;
}

/** Refuse a run that cannot be described, naming the field that is missing. */
export function requireNarrationRun(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
): void {
  if (!book.epubPath) {
    throw new Error(
      'This narration run names no document, so there is nothing to read. The file comes from the '
      + 'button that started the run and is never looked up.'
    );
  }
  if (!book.projectDir) {
    throw new Error(
      `Cannot queue narration for ${book.epubPath}: it has no project directory, so there is `
      + 'nowhere to put the rendered sentences or the finished audiobook.'
    );
  }
  if (!book.variantId) {
    throw new Error(
      `Cannot queue narration for ${book.epubPath}: it does not say which version of the book it `
      + 'is. The version comes from the Process button on that row, exactly as the file does — a '
      + 'run that could not name it would ask the project about "the book" and act on whichever '
      + 'version the code reached first.'
    );
  }
  if (!settings.voice) {
    throw new Error(
      'No voice is selected, so this run would be rendered in whatever voice the queue happened to '
      + 'default to. Pick a voice.'
    );
  }
  if (!settings.ttsEngine) {
    throw new Error('No TTS engine is selected, so there is nothing to render this book with.');
  }
  // Checked at RUNTIME as well as in the types, because one caller is an IPC
  // door (main's `bookforge.narrate`, ordered from the hosted Foundry window)
  // and a field that arrived as undefined there would reach the render door as
  // neither answer — where the only remaining behaviours are "refuse the book"
  // and "read the digits as printed", and picking either silently is a decision
  // nobody made.
  if (settings.textCleanup !== 'required' && settings.textCleanup !== 'skipped') {
    throw new Error(
      `Cannot queue narration for ${book.epubPath}: the run does not say whether the narration `
      + `text cleanup is required of it (got ${JSON.stringify(settings.textCleanup)}). It is `
      + "'required' unless the user was shown the cleanup offer and chose to narrate the book as "
      + 'printed.'
    );
  }
}

/** Where the assembled audiobook is written, inside the project. */
function assemblyOutputDir(projectDir: string): string {
  return `${projectDir.replace(/\\/g, '/')}/output`;
}

/**
 * A STEP'S NAME IS ITS ACT, and the book rides beside it.
 *
 * These rows used to call themselves by the BOOK's title, and Owen read the
 * result off the queue card of his first Foundry-pressed narration
 * (2026-08-17): an assembly step labelled "Flashpoint Of Revival" — *"it
 * should say 'assembly' or something instead of the name of the book, so the
 * user knows which step is happening."* A row's `title` is what every queue
 * surface prints as its label, so it names the WORK, exactly as the TTS step
 * always has; the book's name travels in `bookTitle`, the same slot the TTS
 * step carries it in, for any surface that wants to say both.
 */
function actMetadata(book: NarrationRunBook, act: string): NarrationRunMetadata {
  return {
    title: act,
    bookTitle: book.title,
    author: book.author,
    ...(book.year ? { year: book.year } : {}),
  };
}

/**
 * Read the book aloud.
 *
 * `skipAssembly` is TRUE whenever an assembly step follows: e2a would otherwise
 * combine the sentences itself, and BookForge reassembles them with its own
 * metadata, chapter markers and optional passes.
 */
export function narrationTtsStep(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  assembleAfter: boolean,
): NarrationStepPlan {
  requireNarrationRun(book, settings);
  return {
    type: 'tts-conversion',
    epubPath: book.epubPath,
    // It reads the document, whether or not anything precedes it — and nothing
    // ever does, since narration is the first act of any run that performs it.
    sourceRef: { kind: 'epub', path: book.epubPath },
    // The version travels with the file, all the way to the row in the queue. It
    // is the only thing that says which of a project's versions this render is.
    variantId: book.variantId,
    ...(book.isArticle ? { projectDir: book.projectDir } : { bfpPath: book.projectDir }),
    metadata: {
      title: 'TTS',
      bookTitle: book.title,
      author: book.author,
      ...(book.year ? { year: book.year } : {}),
      ...(book.coverPath ? { coverPath: book.coverPath } : {}),
      outputFilename: book.outputFilename,
    },
    config: {
      type: 'tts-conversion',
      device: settings.device,
      language: settings.language,
      ttsEngine: settings.ttsEngine,
      fineTuned: settings.voice,
      speed: settings.speed,
      enableTextSplitting: true,
      useParallel: true,
      parallelMode: 'sentences',
      parallelWorkers: settings.workers,
      outputDir: settings.outputDir,
      skipAssembly: assembleAfter,
      // Only consumed when this step assembles inline, i.e. when nothing follows it.
      finalDenoise: settings.finalDenoise,
      startFresh: settings.startFresh,
      textCleanup: settings.textCleanup,
    },
  };
}

/**
 * Re-render the sentences through an RVC voice model, before assembly.
 *
 * Its own row rather than a flag on the assembly, so it shows a distinct job with
 * a per-sentence ETA.
 *
 * THE SESSION FIELDS ARE EMPTY ON PURPOSE, and for two different reasons now.
 * Behind a narration, the queue discovers the session that narration actually
 * wrote rather than a path guessed an hour earlier. FIRST in a run — converting
 * sentences this project already has — there is no earlier step to ask, and the
 * step resolves the project's cached session itself when it runs
 * (`getBfpCachedSession`). Both are "ask the disk at the time", which is why one
 * empty field serves both.
 *
 * IT NO LONGER DENOISES ITS OWN INPUT. The denoise is a row of its own, before
 * or after this one as the user chose, and this step is a clean transform of
 * whatever its parent wrote.
 *
 * `readsRawSentences` says whether this pass is the FIRST enhancement of the run,
 * which is the only thing that decides whether it carries the gap: the gap is
 * baked in by whichever pass touches the raw sentences, and touching them is what
 * being first means. A parameter rather than something read off the settings,
 * because only the whole-run builder knows the shape of the run.
 */
export function narrationRvcStep(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  readsRawSentences: boolean,
): NarrationStepPlan | null {
  if (settings.rvc === null) return null;
  requireNarrationRun(book, settings);
  if (!settings.rvc.voiceId) {
    throw new Error(
      'RVC enhancement is on but no enhancement voice is selected. Pick a voice or turn RVC off.'
    );
  }
  return {
    type: 'rvc-enhancement',
    bfpPath: book.projectDir,
    variantId: book.variantId,
    // NAMED, not "Enhance": two enhancement rows can now sit in one run, and a
    // pair of rows the user cannot tell apart is a queue that says nothing.
    metadata: actMetadata(book, 'Voice conversion'),
    config: {
      type: 'rvc-enhancement',
      // Filled at run time by session discovery — see the doc comment above.
      sessionId: '', sessionDir: '', processDir: '',
      voiceId: settings.rvc.voiceId,
      indexRate: settings.rvc.indexRate,
      protectRate: settings.rvc.protectRate,
      nSemitones: settings.rvc.nSemitones,
      // Spread rather than sent as undefined: absent MEANS urvc's own default,
      // and a key present with no value is a different statement to a step
      // config that a later reader has to guess the meaning of.
      ...(settings.rvc.f0Method === undefined ? {} : { f0Method: settings.rvc.f0Method }),
      ...(settings.rvc.hopLength === undefined ? {} : { hopLength: settings.rvc.hopLength }),
      // The gap rides with whichever pass reads the RAW sentences, which is this
      // one exactly when it is first. Absent leaves the session's provenance in
      // charge, as everywhere else — and absent is the ONLY legal answer when a
      // denoise runs in front, which the job refuses rather than ignores.
      ...(readsRawSentences && settings.sentenceGap !== undefined
        ? { sentenceGap: settings.sentenceGap } : {}),
    },
  };
}

/**
 * Denoise the rendered sentences.
 *
 * Its own row for the same reason the conversion has one — a distinct job with a
 * distinct ETA — and for one more: the assembly behind it is then CPU work, and
 * the GPU is free the moment the roformer finishes rather than at the end of the
 * AAC encode.
 *
 * Null when the run does not denoise. It is NOT suppressed by the conversion any
 * more: the two are separate passes in a user-chosen order, and the one that
 * runs second reads the other's output.
 *
 * `readsRawSentences` carries the same meaning as it does on `narrationRvcStep`.
 * The session fields are empty on purpose — same reason, same place.
 */
export function narrationDenoiseStep(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  readsRawSentences: boolean,
): NarrationStepPlan | null {
  if (!settings.finalDenoise) return null;
  requireNarrationRun(book, settings);
  return {
    type: 'final-denoise',
    bfpPath: book.projectDir,
    variantId: book.variantId,
    metadata: actMetadata(book, 'Denoise'),
    config: {
      type: 'final-denoise',
      // Filled at run time by session discovery — see `narrationRvcStep`.
      sessionId: '', sessionDir: '', processDir: '',
      ...(readsRawSentences && settings.sentenceGap !== undefined
        ? { sentenceGap: settings.sentenceGap } : {}),
    },
  };
}

/**
 * THE ENHANCEMENT PASSES THIS RUN PERFORMS, IN THE ORDER THEY EXECUTE.
 *
 * The whole of the ordering ruling, in one function. WHETHER there is any
 * enhancement is the stage's answer; WHICH passes is the settings'; and the ORDER
 * is the settings' too, but only consulted when both passes are on — with one
 * pass there is no order to have, and reading the field then would let a stale
 * value look like a decision.
 */
export function narrationEnhancementPasses(
  settings: NarrationRunSettings,
  stages: NarrationRunStages,
): NarrationEnhancementPass[] {
  if (!stages.enhance) return [];
  const denoise = settings.finalDenoise;
  const rvc = settings.rvc !== null;
  if (denoise && rvc) {
    if (settings.enhancementOrder === 'rvc-first') return ['rvc', 'denoise'];
    if (settings.enhancementOrder === 'denoise-first') return ['denoise', 'rvc'];
    throw new Error(
      `This run performs both enhancement passes but says its order is `
      + `"${String(settings.enhancementOrder)}", which is neither "denoise-first" nor `
      + '"rvc-first". The two orders produce different audio, so neither is assumed.'
    );
  }
  if (denoise) return ['denoise'];
  if (rvc) return ['rvc'];
  return [];
}

/**
 * Combine the rendered sentences into the M4B, with its chapters and its cover.
 *
 * `registerAsNewVariant` is a PARAMETER rather than something read off the
 * settings, because it is a fact about the RUN — did this run also render the
 * sentences it is assembling — and the settings describe how, not what. Its one
 * true case is computed once, in `buildNarrationSteps`; a caller that composes
 * its own chain (the language-learning wizard) states its answer at the call.
 */
export function narrationReassemblyStep(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  registerAsNewVariant: boolean,
  /**
   * A step in front of this one already baked the inter-sentence gap in — a
   * denoise or a conversion. A PARAMETER for the same reason as the flag above:
   * it is a fact about the shape of the run, and only the whole-run builder sees
   * the shape. When true the assembly is handed a finished sentence set and runs
   * no gap pass of its own, so stating the number here would be a knob with no
   * hand on it.
   */
  gapBakedUpstream: boolean,
): NarrationStepPlan {
  requireNarrationRun(book, settings);
  if (registerAsNewVariant && settings.rvc === null) {
    throw new Error(
      'This assembly is meant to be filed as a second audiobook, but the run names no '
      + 'voice-conversion pass — so there is nothing to tell the two versions apart. This is a bug '
      + 'in the page that composed the run.'
    );
  }
  return {
    type: 'reassembly',
    bfpPath: book.projectDir,
    variantId: book.variantId,
    metadata: actMetadata(book, 'Assembly'),
    config: {
      type: 'reassembly',
      // Filled at run time by session discovery, as above.
      sessionId: '', sessionDir: '', processDir: '',
      outputDir: assemblyOutputDir(book.projectDir),
      metadata: {
        title: book.title || '',
        author: book.author || '',
        ...(book.coverPath ? { coverPath: book.coverPath } : {}),
        ...(book.year ? { year: book.year } : {}),
        outputFilename: book.outputFilename,
      },
      excludedChapters: [],
      // The one opt-in pass assembly still performs itself: de-ring is an ffmpeg
      // filter at the final encode, not a model, so it belongs to the encode.
      applyDeRing: settings.applyDeRing,
      // Absent stays absent: that is what leaves provenance in charge of the gap.
      ...(gapBakedUpstream || settings.sentenceGap === undefined
        ? {} : { sentenceGap: settings.sentenceGap }),
      registerAsNewVariant,
      // Carried only when it names something: the voice is what the second
      // audiobook is called, and an assembly filing into the base slot has no
      // use for it.
      ...(registerAsNewVariant ? { rvcVoiceId: settings.rvc!.voiceId } : {}),
    },
  };
}

/**
 * REFUSE A SET OF STAGES THAT CANNOT BE A RUN, by name, before anything is built.
 *
 * Five combinations are runs; the rest are not, and each is refused for its own
 * reason rather than by a rule about counts:
 *
 *  - NOTHING AT ALL leaves the user watching a queue they added nothing to.
 *  - ENHANCEMENT WITHOUT ASSEMBLY spends an hour of GPU per pass and ends with
 *    nothing to listen to. The sets it derives are durable and would be reused by
 *    a later assembly, but "make an audiobook" is what this dialog is for, and a
 *    run that produces none is not a smaller version of that.
 *  - ENHANCEMENT WITH NEITHER PASS CHOSEN is a checked tab with nothing behind
 *    it. Checked is the user's answer to "do this"; which passes is a separate
 *    question and it has not been answered.
 *  - ENHANCEMENT WITH NO VOICE has nothing to convert through. That one is
 *    checked here as well as in the step builder because the stage flag and the
 *    settings can disagree, and the flag is the user's answer to "do this".
 */
export function requireNarrationStages(
  stages: NarrationRunStages,
  settings: NarrationRunSettings,
): void {
  if (!stages.narrate && !stages.enhance && !stages.assemble) {
    throw new Error(
      'There is nothing to queue: this run neither reads the book, nor enhances its sentences, '
      + 'nor assembles an audiobook. Turn one of them on.'
    );
  }
  if (stages.enhance && !stages.assemble) {
    throw new Error(
      'Enhancing the sentences without assembling them would spend the whole pass on the GPU and '
      + 'leave nothing to listen to. Turn assembly on as well, or turn the enhancement off.'
    );
  }
  if (stages.enhance && !settings.finalDenoise && settings.rvc === null) {
    throw new Error(
      'This run is set to enhance its sentences, but neither enhancement pass is turned on. '
      + 'Choose the denoise, the voice conversion, or both — or turn the enhancement off.'
    );
  }
}

/**
 * The whole run, in the order it must execute: narration, enhancement, assembly.
 *
 * The steps carry no workflow, no parent and no ids: where they land is the
 * submitting caller's decision, not this file's.
 *
 * ── WHERE THE AUDIOBOOK IS FILED IS DECIDED HERE, ONCE ──────────────────────
 *
 * `registerAsNewVariant = converts && !narrate`. A run that RENDERED the sentences it
 * converts produced one audiobook — the conversion is a pass inside it, not a
 * second edition — so it files into the project's audiobook slot exactly as
 * every narration always has. A run that converted sentences ALREADY ON DISK is
 * making an alternative to an audiobook the book already has, and overwriting
 * the original to produce its alternative is the destruction Owen's ruling
 * exists to prevent.
 *
 * A CACHE RUN THAT ONLY DENOISES still files into the base slot, and that is the
 * answer it has always had: a denoise is the same narration with its hiss bed
 * taken out, not a different edition, and there is nothing to name a second
 * version after. Only the conversion mints one, because the voice is what tells
 * the two versions apart.
 *
 * Computed here rather than in the assembly builder because it is a fact about
 * the SHAPE OF THE RUN, and this is the only function that sees the whole shape.
 */
export function buildNarrationSteps(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  stages: NarrationRunStages,
): NarrationStepPlan[] {
  requireNarrationStages(stages, settings);
  const steps: NarrationStepPlan[] = [];
  /*
   * THE NARRATION NEVER ASSEMBLES ITSELF HERE — `true` unconditionally, not
   * `stages.assemble`.
   *
   * e2a will combine the sentences on its own unless told to skip it, and that
   * inline assembly is invisible to this description: it produces an audiobook
   * no `reassembly` step planned, with none of BookForge's own metadata, chapter
   * markers or optional passes, filed straight into the project's audiobook slot.
   *
   * Passing `stages.assemble` through made narrate-only do exactly that. The run
   * the user asked for was "read the book and stop" — the dialog says so in as
   * many words, and it is the point of separating the stages at all: render the
   * sentences overnight, audition a conversion against them later, assemble once
   * when the voice is right. Handing back a finished audiobook instead is not a
   * smaller version of that, it is the opposite of it, and it overwrites whatever
   * audiobook the book already had on the way.
   *
   * So assembly happens in EXACTLY ONE place — the reassembly step below, when
   * `stages.assemble` — and the narration always stops at the cached sentences.
   * The parameter stays on `narrationTtsStep` because the language-learning
   * wizard is a caller that composes its own chain and still answers it for
   * itself; this is the answer for a run described BY STAGES.
   */
  if (stages.narrate) steps.push(narrationTtsStep(book, settings, true));
  /*
   * THE ENHANCEMENT IS ONE ROW PER PASS, IN THE USER'S ORDER.
   *
   * Both passes cost about an hour of GPU over a book and both are chosen on the
   * same tab, so both are rows: the queue shows two ETAs rather than one job that
   * silently does twice the work. Each reads what the row in front of it wrote —
   * the first reads the session, the second reads the first's sentence set — and
   * the assembly behind them reads the last one's, which is what it has always
   * done with an enhanced set.
   *
   * THE GAP GOES ON THE FIRST PASS AND NOWHERE ELSE. It has to be applied to the
   * raw sentences (it detects e2a's pad by its exactly-zero samples), so it
   * belongs to whichever pass touches them first. `readsRawSentences` is that
   * fact, and it is the index being zero.
   */
  const passes = narrationEnhancementPasses(settings, stages);
  for (const [index, pass] of passes.entries()) {
    const readsRaw = index === 0;
    const step = pass === 'denoise'
      ? narrationDenoiseStep(book, settings, readsRaw)
      : narrationRvcStep(book, settings, readsRaw);
    if (step === null) {
      // Unreachable: `narrationEnhancementPasses` names a pass only when its
      // settings are there, and null is exactly the case where they are not.
      // Said out loud rather than asserted away, so a future change to either
      // rule fails here instead of dropping a pass the user asked for.
      throw new Error(
        `The ${pass === 'denoise' ? 'denoise' : 'voice-conversion'} pass was asked for and could `
        + "not be described. This is a bug in BookForge's run description."
      );
    }
    steps.push(step);
  }
  if (stages.assemble) {
    steps.push(narrationReassemblyStep(
      book,
      settings,
      stages.enhance && settings.rvc !== null && !stages.narrate,
      // Any enhancement pass in front of the assembly has already baked the gap
      // in — the first of them did, and the assembly is handed its output.
      passes.length > 0,
    ));
  }
  /*
   * The first step reads something nothing in this run produced, and the queue
   * checks that at compose time. A run that begins by narrating reads the
   * document (the TTS step says so itself); a run that begins with a conversion
   * or an assembly reads the session this project has cached — named by KIND
   * with no path, because which session that is, is a question about the disk at
   * the moment the step runs.
   */
  const first = steps[0]!;
  if (first.sourceRef === undefined) {
    steps[0] = { ...first, sourceRef: { kind: 'audio-session' } };
  }
  return steps;
}
