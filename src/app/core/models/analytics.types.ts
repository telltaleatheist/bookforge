/**
 * Analytics Types for TTS and AI Cleanup Jobs
 */

/*
 * ── `crucibleServer`: WHERE THE WORK ACTUALLY RAN ───────────────────────────
 *
 * Owen, 2026-09-15: *"the analytics data should contain which crucible server
 * was used"*. Every rate in these records — chars/min, chunks/min, chars per
 * minute of cleanup — is a property of the MACHINE as much as of the book, and
 * without the machine's name two runs of the same book on two different cards
 * are indistinguishable rows. That is exactly the comparison the figures exist
 * to support, so the venue is part of the measurement, not context around it.
 *
 * THREE RULES, the same three the counted figures in `TTSJobAnalytics` follow:
 *
 * 1. **It is the RESOLVED venue, never the request.** What a caller asked for
 *    and where the job landed are two facts; this is the second one, read off
 *    the decision the run was actually placed by (`GenerationVenue.server` for
 *    a render, the provider block's `crucible.server` for a text pass). A run
 *    is atomic — it finishes where it started — so there is exactly one answer
 *    per record and it is known by the time the record is written.
 *
 * 2. **It is a registry NAME, verbatim.** Whatever
 *    `<userData>/crucible-servers.json` calls that entry — "3090 Ti", "M1
 *    Ultra" — is what goes in. No name is special-cased, nothing is normalised,
 *    and there is no display-label indirection: the operator named these
 *    machines and the record repeats them.
 *
 * 3. **Absent means it was not known, and is never repaired.** A record without
 *    the field is a record written before the field existed, or a run whose
 *    step genuinely had no Crucible venue (the bundled local llama arm; the
 *    urvc spawn — see `RvcJobAnalytics`). Both are honest answers. A reader
 *    must draw the absence as unknown and MUST NOT default it to a machine, to
 *    "local", or to whichever server happens to be configured now — a guess
 *    here would be indistinguishable from a recorded fact, which is the one
 *    thing these records are built not to do.
 */

export interface TTSJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;       // GENERATION CHUNKS for the whole book, not sentences
  /** Real sentence count across all chunks of the book. Optional (absent on old runs). */
  totalRawSentences?: number;
  totalChapters: number;

  // Worker metrics
  workerCount: number;

  // Performance metrics
  /**
   * CHUNKS per minute over the WHOLE job, model load and prep included — which is why it
   * reads lower than the rate the queue showed while running (`chunksPerMinute` below
   * divides by render time only).
   *
   * Was named `sentencesPerMinute` while holding chunks. Readers that trusted the name
   * reported chunks as sentences, which is the same class of error the sentences/min
   * readout itself turned out to be. Records written before the rename carry the old key;
   * see `legacySentencesPerMinute`.
   */
  chunksPerMinuteOverall?: number;
  /**
   * @deprecated The pre-rename key, holding the SAME chunks-per-minute figure. Present
   * only on records written before the rename; new records never set it. Reading it is
   * not a fallback for a missing measurement — it IS the measurement under its former
   * name, so readers take whichever key the record actually carries.
   */
  sentencesPerMinute?: number;
  audioDurationSeconds?: number;  // Duration of output audio

  /**
   * ── Measured throughput ──────────────────────────────────────────────────
   *
   * How many real sentences a chunk holds is a property of THIS run's packing, not a
   * constant: raising the packer's character budget moved it from ~1.5 to ~2.7 on real
   * books, and individual chunks range from 1 to 9. So none of these are derived from an
   * assumed ratio — each is counted from the work the run actually did, which is what
   * keeps them correct the next time the packing changes.
   *
   * All optional: runs recorded before this existed have none of them, and the panel
   * falls back to the whole-book ratio for those rather than inventing values.
   */

  /** Chunks rendered in THIS session. */
  chunksInSession?: number;
  /** EXACT real sentences in those chunks — summed per chunk, never chunks × average. */
  rawSentencesInSession?: number;
  /**
   * Seconds spent actually rendering: measured from the first completed chunk, so model
   * load and prep are excluded. `durationSeconds` includes them, which is why a rate
   * derived from it reads lower than the throughput the queue showed while running.
   */
  workSeconds?: number;
  /** EXACT words and characters in those chunks — summed per chunk, same as sentences. */
  rawWordsInSession?: number;
  rawCharsInSession?: number;
  /** Chunks per minute over workSeconds. */
  chunksPerMinute?: number;
  /** Real sentences per minute over workSeconds. Measured, not scaled from a ratio. */
  rawSentencesPerMinute?: number;
  /**
   * Words and characters per minute over workSeconds.
   *
   * Both are comparable across books in a way sentences/min is not: a chunk is packed to
   * a character budget, so a dense author's chunk holds ~1.9 sentences where a sparse
   * one holds ~4.4, and sentences/min halves between two runs of identical throughput.
   * Words are the legible unit for display; characters are the one that predicts audio
   * duration best and that the ETA divides.
   */
  wordsPerMinute?: number;
  charsPerMinute?: number;
  /**
   * Seconds of AUDIO produced per character of text, sampled from this run's own rendered
   * FLACs, and the realtime factor built from it (audio seconds produced per wall second).
   *
   * The realtime factor is the ONLY throughput figure comparable across books AND voices,
   * because audio is the actual unit of work: measured across three jobs, sentences/min
   * ranged 92–188 while the realtime factor held at 12.0–14.0×. It also exposes what the
   * text rates hide — a voice that narrates at 145 wpm against another's 170 produces ~17%
   * more audio from the same book, so it genuinely takes longer at identical efficiency.
   */
  audioSecondsPerChar?: number;
  realtimeFactor?: number;

  /**
   * The Crucible server this render's generation step ran on, by registry name.
   * See the three rules at the top of this file. Absent on every record written
   * before 2026-09-15, and on a session that generated nothing (assembly-only),
   * which has no venue to report.
   */
  crucibleServer?: string;

  // Settings used
  settings: {
    /*
     * NO `device` SINCE 2026-09-19. It recorded the modal's Auto/GPU/Metal/CPU
     * choice — a statement about THIS box's hardware for a render that happened
     * on a Crucible server, which is why every row read "AUTO" no matter which
     * machine did the work. `crucibleServer` above is the fact it was standing
     * in for. An analytics file written before that date still carries the key
     * and still parses; nothing reads it.
     */
    language: string;
    ttsEngine: string;
    fineTuned?: string;
  };

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;

  // Resume info (if this was a resume job)
  isResumeJob?: boolean;
  sentencesProcessedInSession?: number;

  // Cancellation info (if job was cancelled)
  wasCancelled?: boolean;
  completedSentencesAtCancel?: number;

  /**
   * WHAT THE ENGINE'S GUARD DECIDED ABOUT THIS RENDER'S CHUNKS (2026-09-13).
   *
   * Built by `electron/chunk-guard-ledger.ts`, which is the one sink both render
   * paths feed — the local worker's `[…_GUARD_EVENT]` stdout lines and a remote
   * Crucible `tts` job's per-chunk `guard`. Before it, the only record of a
   * truncation, a re-roll or an accepted-off-length take was a WARN line in a
   * shared per-day text log, which nothing counted
   * (crucible/docs/ARCHITECTURE.md R4: a log line is never load-bearing).
   *
   * Optional because every record written before that date has none, and an
   * absent field here means "this run predates the ledger" — which is itself a
   * third kind of not-knowing and must not be drawn as a clean render.
   *
   * TWO RULES FOR ANY READER OF THIS:
   *
   * 1. `unknown` is NOT `clean`. It is counted separately and deliberately kept
   *    out of `byVerdict`. A chunk whose verdict never reached us is a chunk we
   *    know nothing about; folding it in would report a whole book rendered
   *    through a pin that cannot speak the field as flawless.
   * 2. `byVerdict` is an OPEN map. Its keys are narrator's retake-ladder
   *    vocabulary — `clean`, `short`, `long`, `hole`, `rerolled`, `resplit`,
   *    `accepted-off-length` today — and the ladder is free to grow one. Render
   *    whatever keys are there; do not switch on a list held on this side, which
   *    would make the renderer a second owner of words it does not define.
   */
  guard?: {
    /** How many chunks the ledger heard anything at all about. */
    chunks: number;
    /** Verdict word → chunk count. Open map; see rule 2 above. */
    byVerdict: Record<string, number>;
    /** Chunks with no verdict. Never inside `byVerdict`; see rule 1 above. */
    unknown: number;
    /**
     * Why they are unknown, by name — `narrator-did-not-say` (the server looked
     * and the engine had nothing), `events-only` (the local stdout channel
     * carries take records and never the conclusion) or `sdk-drops-the-field`
     * (the pinned @crucible/client discards `guard` before the app sees it).
     * Sums to `unknown`.
     */
    unknownBy: Record<string, number>;
    /** Which channels fed this render: `narrator-stdout`, `crucible-chunk`. */
    sources: string[];
  };
}

export interface CleanupJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalChapters: number;
  totalChunks: number;
  totalCharacters: number;

  // Performance metrics
  chunksPerMinute: number;
  charactersPerMinute: number;

  // Model info
  model: string;

  /**
   * The Crucible server this cleanup ran on, by registry name. See the three
   * rules at the top of this file.
   *
   * `model` has carried the server inside a composite string
   * (`crucible/<server>/<id>`) since before this field existed, for the same
   * reason this field exists — a chars/min figure is unreadable next to another
   * machine's. That string stays as it is (old records are full of it and it is
   * what the panel prints); this is the same fact as its own field, so a reader
   * comparing machines does not have to parse a display string to get one.
   *
   * Absent on the bundled local llama arm, which has no server, and on the
   * deterministic TTS-prep pass, which runs no model at all.
   */
  crucibleServer?: string;

  // Outcome
  success: boolean;
  chaptersProcessed: number;

  // Issues
  copyrightChunksAffected: number;
  contentSkipsAffected: number;
  skippedChunksPath?: string;

  error?: string;
}

export interface ReassemblyJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalChapters: number;

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface RvcJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;

  // Performance metrics
  sentencesPerMinute: number;

  /*
   * NO `crucibleServer` HERE, AND THAT IS THE MEASUREMENT, NOT AN OMISSION.
   *
   * The only thing that writes this record is the RVC pass inside a TTS session
   * (`parallel-tts-bridge.ts`), and that pass runs `enhanceSentences`
   * (`electron/rvc-bridge.ts`) — the local urvc spawn on THIS machine's card.
   * It has no Crucible venue to report, so there is nothing to record and a
   * field here would be permanently absent, which reads as "old record" and
   * would be a lie about why.
   *
   * The Crucible `rvc` door (`electron/crucible/rvc.ts`, reached by the
   * standalone `rvc-enhancement` queue step through `electron/rvc-job.ts`) DOES
   * know its venue — it logs it — but it files no analytics record at all, so
   * there is no row to put it on. Give that step a record and its venue goes on
   * it; until then this interface has one producer and one honest answer.
   */

  // RVC settings
  modelName: string;       // urvc voice-model folder name
  voiceLabel?: string;     // friendly label (e.g. "US Female 1")
  indexRate: number;
  protectRate?: number;

  // Outcome
  success: boolean;
  outputPath?: string;     // enhanced sentences dir
  error?: string;
}

export interface TranslationJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Input metrics
  totalSentences: number;       // sentences/paragraphs translated
  totalCharacters?: number;

  // Performance metrics
  sentencesPerMinute: number;

  // Settings
  // A recorded run's provider, so history keeps whatever it actually used —
  // 'crucible' or 'local' now; 'ollama', 'claude' or 'openai' on a row written
  // before 2026-09-14, when those three left BookForge.
  provider: string;
  model: string;
  /**
   * The Crucible server this translation ran on, by registry name. See the
   * three rules at the top of this file. Absent when `provider` is not
   * 'crucible' — the bundled local arm has no server — and on every record
   * written before 2026-09-15.
   */
  crucibleServer?: string;
  sourceLang?: string;
  targetLang: string;
  mode: 'mono' | 'bilingual';   // whole-book vs sentence-aligned

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;

  // Issues: chunks that failed translation and kept original (untranslated) text
  failedChunkCount?: number;
  skippedChunksPath?: string;
}

export interface VideoAssemblyJobAnalytics {
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationSeconds: number;

  // Settings
  resolution: string;
  mode: string;

  // Outcome
  success: boolean;
  outputPath?: string;
  error?: string;
}

export interface ProjectAnalytics {
  ttsJobs: TTSJobAnalytics[];
  cleanupJobs: CleanupJobAnalytics[];
  reassemblyJobs?: ReassemblyJobAnalytics[];
  videoAssemblyJobs?: VideoAssemblyJobAnalytics[];
  rvcJobs?: RvcJobAnalytics[];
  translationJobs?: TranslationJobAnalytics[];
}
