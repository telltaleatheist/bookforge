/**
 * The jobs one narration run is made of: read the book aloud, enhance the voice,
 * assemble the audiobook.
 *
 * ── Why these are built here rather than where they are ordered ─────────────
 *
 * Because they are ordered from two places now. The Process page has always
 * composed them out of its own controls; the TTS copy's Process button opens a
 * modal that composes the same three jobs out of the same choices, against a
 * file it was handed rather than one it looked up. Two callers writing the same
 * object literals is two answers to "what does a narration run consist of", and
 * they drift the day one of them gains a field — which is precisely how a run
 * ends up rendering at a default voice nobody chose.
 *
 * So the request shapes live here, once, and both callers ASK for them. Nothing
 * in this file queues anything or reads a signal: it is a description of work,
 * and whoever is submitting decides where it lands (behind a pass chain, under a
 * master row of its own) and stamps the workflow.
 *
 * ── Everything that can fail, fails before anything is queued ───────────────
 *
 * A workflow half in the queue cannot be retried without double-queueing it. So
 * this refuses BY NAME — throwing, with nothing built — rather than emitting a
 * request with a hole in it. A missing voice is the case that matters: the queue
 * would otherwise fall back to a stock one and hand back an audiobook in the
 * wrong voice after an hour of GPU.
 *
 * ── What it deliberately does NOT cover ─────────────────────────────────────
 *
 * Resuming a partial session, reassembling a cached one, and the optional video.
 * Each of those is a run ABOUT something that already exists on disk — a session
 * the wizard found — rather than a run about a book, and the Process page owns
 * finding them. They stay in ll-wizard.component.ts, and are the seam a later
 * pass has to close before that page can go.
 */
import type { CreateJobRequest, TtsConversionConfig } from '../models/queue.types';

/** The RVC pass, when the user asked for one. */
export interface NarrationRvcSettings {
  readonly voiceId: string;
  readonly indexRate: number;
  readonly protectRate: number;
  readonly nSemitones: number;
}

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
  readonly temperature: number;
  readonly topP: number;
  readonly repetitionPenalty: number;
  readonly speed: number;
  readonly workers: number;
  /** The library's audiobooks folder — where the finished M4B is filed. */
  readonly outputDir: string;
  readonly finalDenoise: boolean;
  readonly applyDeRing: boolean;
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
}

/**
 * `topK` is not a control anywhere in the app and never has been — it is stated
 * here so the one value both callers send is written down once instead of twice.
 */
const TOP_K = 50;

/** Refuse a run that cannot be described, naming the field that is missing. */
function requireRun(book: NarrationRunBook, settings: NarrationRunSettings): void {
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
  if (!settings.voice) {
    throw new Error(
      'No voice is selected, so this run would be rendered in whatever voice the queue happened to '
      + 'default to. Pick a voice.'
    );
  }
  if (!settings.ttsEngine) {
    throw new Error('No TTS engine is selected, so there is nothing to render this book with.');
  }
}

/** Where the assembled audiobook is written, inside the project. */
function assemblyOutputDir(projectDir: string): string {
  return `${projectDir.replace(/\\/g, '/')}/output`;
}

/** What the audiobook rows call themselves. One derivation, three jobs. */
function audiobookMetadata(book: NarrationRunBook) {
  return {
    title: book.title,
    author: book.author,
    ...(book.year ? { year: book.year } : {}),
  };
}

/**
 * Read the book aloud.
 *
 * `skipAssembly` is TRUE whenever an assembly job follows: e2a would otherwise
 * combine the sentences itself, and BookForge reassembles them with its own
 * metadata, chapter markers and optional passes.
 */
export function narrationTtsRequest(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  assembleAfter: boolean,
): CreateJobRequest {
  requireRun(book, settings);
  const config: Partial<TtsConversionConfig> = {
    type: 'tts-conversion',
    device: settings.device,
    language: settings.language,
    ttsEngine: settings.ttsEngine,
    fineTuned: settings.voice,
    temperature: settings.temperature,
    topP: settings.topP,
    topK: TOP_K,
    repetitionPenalty: settings.repetitionPenalty,
    speed: settings.speed,
    enableTextSplitting: true,
    useParallel: true,
    parallelMode: 'sentences',
    parallelWorkers: settings.workers,
    outputDir: settings.outputDir,
    skipAssembly: assembleAfter,
    // Only consumed when this job assembles inline, i.e. when nothing follows it.
    finalDenoise: settings.finalDenoise,
    startFresh: settings.startFresh,
  };
  return {
    type: 'tts-conversion',
    epubPath: book.epubPath,
    ...(book.isArticle ? { projectDir: book.projectDir } : { bfpPath: book.projectDir }),
    metadata: {
      title: 'TTS',
      bookTitle: book.title,
      author: book.author,
      ...(book.year ? { year: book.year } : {}),
      ...(book.coverPath ? { coverPath: book.coverPath } : {}),
      outputFilename: book.outputFilename,
    },
    config,
  };
}

/**
 * Re-render the sentences through an RVC voice model, before assembly.
 *
 * Its own queue row rather than a flag on the assembly, so it shows a distinct
 * job with a per-sentence ETA. The session fields are empty on purpose: this job
 * runs after the narration, and the queue discovers the session the narration
 * actually wrote rather than a path guessed an hour earlier.
 *
 * Denoise rides HERE rather than on the assembly so it runs first — denoise, then
 * conversion, then assembly — and the assembly sees a pre-enhanced set.
 */
export function narrationRvcRequest(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
): CreateJobRequest | null {
  if (settings.rvc === null) return null;
  requireRun(book, settings);
  if (!settings.rvc.voiceId) {
    throw new Error(
      'RVC enhancement is on but no enhancement voice is selected. Pick a voice or turn RVC off.'
    );
  }
  return {
    type: 'rvc-enhancement',
    bfpPath: book.projectDir,
    config: {
      type: 'rvc-enhancement',
      // Filled at run time by session discovery — see the doc comment above.
      sessionId: '', sessionDir: '', processDir: '',
      voiceId: settings.rvc.voiceId,
      indexRate: settings.rvc.indexRate,
      protectRate: settings.rvc.protectRate,
      nSemitones: settings.rvc.nSemitones,
      finalDenoise: settings.finalDenoise,
    },
    metadata: audiobookMetadata(book),
  };
}

/** Combine the rendered sentences into the M4B, with its chapters and its cover. */
export function narrationReassemblyRequest(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
): CreateJobRequest {
  requireRun(book, settings);
  return {
    type: 'reassembly',
    bfpPath: book.projectDir,
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
      // Two opt-in assembly passes, both default OFF.
      finalDenoise: settings.finalDenoise,
      applyDeRing: settings.applyDeRing,
    },
    metadata: audiobookMetadata(book),
  };
}

/**
 * The whole run, in the order it must execute: narration, enhancement, assembly.
 *
 * They carry no workflow or parent: whoever queues them stamps that, because
 * where they land is the submitting caller's decision, not this file's.
 */
export function buildNarrationJobs(
  book: NarrationRunBook,
  settings: NarrationRunSettings,
  what: { narrate: boolean; assemble: boolean },
): CreateJobRequest[] {
  if (!what.narrate && !what.assemble) {
    throw new Error('There is nothing to queue: no narration and no assembly.');
  }
  const jobs: CreateJobRequest[] = [];
  if (what.narrate) jobs.push(narrationTtsRequest(book, settings, what.assemble));
  if (what.assemble) {
    const rvc = narrationRvcRequest(book, settings);
    if (rvc !== null) jobs.push(rvc);
    jobs.push(narrationReassemblyRequest(book, settings));
  }
  return jobs;
}
