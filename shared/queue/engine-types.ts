/**
 * The shape of the queue, as MAIN owns it.
 *
 * ── Why these types live in shared/ ─────────────────────────────────────────
 *
 * The queue used to be a renderer service that persisted its own blob, so its
 * types lived beside the component that drew them and main knew nothing about
 * them. That is upside down: a renderer reload could orphan ninety minutes of
 * GPU, every extra window booted a second scheduler, and `queue.json` was
 * written by whichever of them saved last. Main owns the queue now, the renderer
 * holds a MIRROR, and both sides read the shape from HERE so they cannot drift.
 *
 * ── A job is a CHAIN OF STEPS with explicit lineage ─────────────────────────
 *
 * Every step names its parent. `parentStepId` is either another step's id or the
 * literal SOURCE — a step that reads a file the user picked rather than a file
 * an earlier step wrote. That single field replaces the old pair of
 * (`workflowId`, `parentJobId`) plus an ordering rule that read "no earlier
 * sibling may be incomplete", which could only express a straight line and
 * inferred the line from array position.
 *
 * Naming the parent is what makes APPENDING A STEP TO WORK THAT HAS NOT RUN a
 * first-class act rather than a race. The user chains Assemble onto a narration
 * that is still queued; the assemble step is `waiting` until its parent is
 * `done`, and when the parent lands the engine resolves the child's input from
 * the parent's OUTPUT. Under the old model the child had to be given its input
 * paths at enqueue time, before they existed — which is why reassembly rows
 * carried an empty `sessionId` and re-discovered it at runtime with a retry
 * ladder.
 *
 * ── The job's status is DERIVED ─────────────────────────────────────────────
 *
 * There is no job status field. A job is running when a step of it is running,
 * failed when one failed, done when they all are — see `jobStatus`. A stored
 * status is a second copy of a fact the steps already carry, and the two used to
 * disagree: the old master row could sit 'processing' forever because the child
 * that would have updated it had thrown instead of returning.
 */

/** Job types this queue can run. Retired vocabulary is listed separately below. */
export type JobType =
  | 'tts-conversion'
  | 'translation'
  | 'rvc-enhancement'
  /**
   * THE ROFORMER PASS OVER A SESSION'S SENTENCES, on its own row.
   *
   * It was a flag on `reassembly` until 2026-08-29, which made the whole assembly
   * a GPU step — the card was held through the chapter combine and the AAC
   * encode, neither of which touches it. Its own row is what lets the assembly
   * contend for the cpu pool while the GPU moves on.
   */
  | 'final-denoise'
  | 'reassembly'
  | 'bilingual-cleanup'
  | 'bilingual-translation'
  | 'bilingual-assembly'
  | 'video-assembly'
  | 'book-analysis'
  | 'generate-sentences'
  | 'simplify'
  | 'translate-pass'
  | 'footnote-refs'
  /**
   * THE NARRATION TEXT CLEANUP — punctuation, then the number rules, then the
   * model on whatever digits are left, written into the book and stamped on it.
   *
   * A pass row like the three above it, and NOT part of a narration run: it edits
   * the book on the chain, once, and every render afterwards reads the result.
   * The Narrate button offers it when the file it is about to read carries no
   * stamp; the render door reads the stamp for what it says, not for permission.
   */
  | 'narration-text'
  | 'vlm-convert'
  /**
   * WORK ORDERED INSIDE THE HOSTED FOUNDRY WINDOW — read the pages, render the
   * book, translate it. Owen's ruling of 2026-08-18: "we need to centralize the
   * queue in bookforge. foundry has their own queue but things shouldnt be
   * queued in foundry's queue from within bookforge."
   *
   * ONE TYPE FOR ALL OF IT, with the kind on the config, because what differs
   * between a read and a rendering is what the engine is asked — not how this
   * queue treats the row. `resource()` is where the difference that matters to
   * THIS engine lives: a read is the GPU, a rendering is arithmetic over a bank
   * already on disk.
   *
   * Foundry still EXECUTES it. This engine decides when (see
   * electron/queue-steps/foundry-job.ts, and foundry-host-queue.ts for the seam).
   */
  | 'foundry-job';

/** The job types that are processing passes, for a runtime membership test. */
export const PASS_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'simplify', 'translate-pass', 'footnote-refs', 'narration-text',
]);

/**
 * What a step is doing.
 *
 * `held`   — composed, in the list, and released by nothing yet. The user has not
 *            pressed Start for it. A user STOP also lands here: a stopped step is
 *            precisely one that is present, will not be auto-picked, and needs an
 *            explicit gesture to run again. (It carries `wasInterrupted`, so the
 *            renderer can say "stopped" rather than "not started yet".)
 * `queued` — released; runnable the moment its parent is done and a slot frees.
 * `waiting`— released, but its parent has not produced the thing it reads.
 * `running`— holding a resource slot right now.
 * `done` / `failed` / `cancelled` — terminal.
 */
export type StepStatus =
  | 'held' | 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'cancelled';

/** Terminal states, for a membership test that cannot go stale. */
export const TERMINAL_STEP_STATUSES: ReadonlySet<StepStatus> =
  new Set<StepStatus>(['done', 'failed', 'cancelled']);

/**
 * Which pool a step contends for.
 *
 * `gpu` is the exclusive local resource — one at a time, whatever it is. e2a
 * workers, RVC, whisper, the document vision model and an Ollama-backed pass all
 * belong to it, because they all end up on the same card.
 *
 * `cpu` is the small pool for work that contends for nothing local: a pass whose
 * provider is a hosted API is network latency and nothing else, and making it
 * wait behind a nine-hour narration was the queue punishing a job for the
 * company it kept.
 */
export type StepResource = 'gpu' | 'cpu';

/** How many steps of each resource may run at once. */
export const RESOURCE_SLOTS: Readonly<Record<StepResource, number>> = {
  gpu: 1,
  cpu: 2,
};

/**
 * What a step reads and what it writes.
 *
 * Typed rather than "a path", so a chain that would hand an M4B to a step that
 * reads EPUBs is refused when it is COMPOSED instead of failing an hour later
 * inside a Python process.
 */
export type ArtifactKind =
  | 'epub'
  | 'audio-session'
  | 'sentences'
  | 'm4b'
  | 'video'
  | 'vtt'
  | 'report'
  | 'bilingual-epubs'
  /** The step writes nothing another step can read. Not "unknown" — none. */
  | 'none';

export interface ArtifactRef {
  kind: ArtifactKind;
  /** The file or directory, absolute, when the artifact IS one. */
  path?: string;
  /** e2a session identity. Present exactly on kind 'audio-session'. */
  sessionId?: string;
  sessionDir?: string;
  processDir?: string;
  /**
   * Identity the PRODUCING step declared and a consumer may read — the two EPUBs
   * and the pairing file of a bilingual translation, the variant a transcript
   * describes. Never invented on the reading side.
   */
  detail?: Record<string, unknown>;
}

/** `parentStepId` for a step that reads what the user picked, not what a step wrote. */
export const SOURCE_PARENT = 'source';

/**
 * Per-stage progress for a step that reports one. Rendered as stacked bars, one
 * per stage, each 0-100 within itself — see electron/job-stages.ts for the
 * weighted-master model these come from.
 */
export type JobStageStatus = 'pending' | 'running' | 'complete';
export interface JobStageProgress {
  name: string;
  label: string;
  /** 0-100 within this stage. */
  pct: number;
  status: JobStageStatus;
  /**
   * Normalized share of the whole run (all stages sum to 1), when the bridge
   * declares relative stage costs. Absent on stage lists derived from a step's
   * phase fields, which carry no such information — those are equal-cost.
   */
  weight?: number;
}

/**
 * Progress WITHIN the MLX batch a TTS worker is decoding right now. Mirrors
 * ActiveBatchProgress in electron/mlx-batch-progress.ts.
 *
 * On Mac, Orpheus renders ~96 chunks as ONE atomic 5-7 minute decode whose files
 * all land at the end, so the chunk bar is frozen for the whole batch. This is
 * what moves during that window. Every field is what the engine actually
 * reported — nothing is defaulted, and the whole object is absent when no batch
 * is decoding.
 */
export interface ActiveBatchProgress {
  rowsTotal: number;
  rowsDone?: number;
  tokenStep: number;
  tokenCap?: number;
  /** 0-1, monotone within a batch. Absent when the engine gave no basis for one. */
  fraction?: number;
  batchNo?: number;
  batchCount?: number;
  /**
   * When THIS batch's decode began (epoch ms). Timed separately from the step:
   * the step's elapsed folds in the model load and every batch before this one,
   * so it cannot say whether the decode running right now is on its usual
   * cadence. Absent against an engine build that reported no batch.
   */
  startedAt?: number;
}

/**
 * Counted work inside the PREPARING stage, before e2a has been spawned at all.
 *
 * Today that is the number-normalization pass: it walks the narration copy
 * paragraph by paragraph through a local model, which can run for minutes on a
 * long book. The preparing stage's own bar cannot move during it — nothing has
 * been prepped yet — so this is the only thing that moves, exactly the situation
 * `activeBatch` exists for one stage further along.
 *
 * Absent means absent. A job with no counted prep work reports no bar rather
 * than a fabricated zero.
 */
export interface PrepSubProgress {
  /** What the pass is doing, in the pass's own words ("Normalizing numbers"). */
  label: string;
  done: number;
  total: number;
}

/** Per-worker progress for a parallel TTS render. */
export type ParallelWorkerStatus = 'pending' | 'running' | 'complete' | 'error';
export interface ParallelWorkerProgress {
  id: number;
  sentenceStart: number;
  sentenceEnd: number;
  completedSentences: number;
  status: ParallelWorkerStatus;
  error?: string;
  /** Sentences assigned to this worker — less than the range on a resume. */
  totalAssigned?: number;
  /** TTS conversions actually performed (a resume skips what is already there). */
  actualConversions?: number;
}

/** What a running step is SHOWING. */
export interface StepProgress {
  /** 0-100. Absent before the step has said anything. */
  percent?: number;
  message?: string;
  /**
   * What the running STAGE is doing when its own percentage cannot move for
   * minutes — "Rendering 21 sentences together · 2,949 tokens".
   */
  detail?: string;
  stages?: JobStageProgress[];
  /**
   * Live progress inside the MLX batch being decoded. Unlike `stages` this is
   * BLANKED when the bridge reports none — a finished batch must not leave a
   * full secondary bar sitting under the chunk bar.
   */
  activeBatch?: ActiveBatchProgress;
  /**
   * Counted work inside the preparing stage. Blanked when the bridge reports
   * none, for `activeBatch`'s reason: a finished pass must not leave a full
   * secondary bar under a bar that has started moving.
   */
  prep?: PrepSubProgress;
  /**
   * Why ADMISSION refused to start this step, in the sentence the scheduler
   * composed — external training holds the lock, or another process holds the
   * card. Present only while the refusal stands.
   *
   * Separate from `message`, which also carries it, because a reader has to be
   * able to tell "the queue is being held off the GPU" from "a step is saying
   * what it is doing", and prose cannot be asked which one it is. A surface that
   * inferred a hold from the presence of a message would call a narration's own
   * status line a blockage the first time one arrived on a queued row.
   */
  admissionHold?: string;
  /**
   * Foundry rows only: which pass the counts in `metrics` are counting.
   *
   * It travels because the quantity changes with it — a read and a rendering
   * count PAGES, a translate counts BLOCKS — and their shelf, which draws these
   * rows back to the person who ordered them, says which. A bar that silently
   * changed units mid-run would be the same lie as a bar that changed scale.
   *
   * Its ABSENCE is also load-bearing: nothing has been counted yet, which is a
   * different statement from a count of zero, and `progressOf` returns null on
   * it rather than sending a progress with no numbers in it.
   */
  foundryPhase?: 'render' | 'read' | 'translate' | 'rank' | 'verify';
}

/**
 * What the step has MEASURED, as opposed to what it is showing.
 *
 * Kept apart from StepProgress because these are the inputs to the throughput
 * and ETA arithmetic, and mixing a measurement with a caption is how a display
 * string came to be parsed for a number.
 */
export interface StepMetrics {
  currentChunk?: number;
  totalChunks?: number;
  currentChapter?: number;
  totalChapters?: number;
  chunksCompletedInJob?: number;
  totalChunksInJob?: number;
  /** Real sentences across the whole book (a chunk holds a variable number). */
  totalRawSentencesInJob?: number;
  totalRawWordsInJob?: number;
  totalRawCharsInJob?: number;
  /** Timestamp (ms) of the last chunk completion. */
  chunkCompletedAt?: number;
  /**
   * Timestamp (ms) of the FIRST chunk completion OF THIS RUN, and the session
   * chunk count at that instant. Rate is measured over [stamp, now] containing
   * (done - chunksAtFirstStamp) completions: measuring from startedAt would fold
   * in model load, and measuring from the stamp WITHOUT its count assumes
   * progress arrives one chunk at a time, which batched engines make false.
   */
  firstChunkCompletedAt?: number;
  chunksAtFirstStamp?: number;
  /** Counts for THIS session only — a resume must not divide prior work by new time. */
  chunksDoneInSession?: number;
  rawSentencesDoneInSession?: number;
  rawWordsDoneInSession?: number;
  rawCharsDoneInSession?: number;
  /**
   * Seconds of audio produced per character of text, sampled from this session's
   * rendered FLACs. Times the measured chars/min it gives the realtime factor.
   */
  audioSecondsPerChar?: number;
  parallelWorkers?: ParallelWorkerProgress[];
  /** Mirrors AggregatedProgress.phase in parallel-tts-bridge. */
  ttsPhase?: 'preparing' | 'converting' | 'assembling' | 'complete' | 'error' | 'stopped';
  ttsConversionProgress?: number;
  assemblyProgress?: number;
  assemblySubPhase?: 'combining' | 'vtt' | 'encoding' | 'metadata';
  /** Cleanup pass-1 phase; 'analyzing' is pre-chunk planning. */
  cleanupPhase?: 'loading' | 'analyzing' | 'processing' | 'saving' | 'complete' | 'error';
  /** Orpheus memory level this run resolved to, shown as a badge. Sticky. */
  orpheusMemoryLevel?: string;
  /** Sentences already rendered before a resume began. */
  resumeCompletedSentences?: number;
  resumeMissingSentences?: number;
  /** Copyright / refusal counts an AI pass reported. */
  copyrightIssuesDetected?: boolean;
  copyrightChunksAffected?: number;
  contentSkipsDetected?: boolean;
  contentSkipsAffected?: number;
  translationFailedChunks?: number;
  skippedChunksPath?: string;
}

export interface QueueStep {
  id: string;
  type: JobType;
  /** The row's heading — "Narrate", "Assemble", "Simplify". */
  label: string;
  /**
   * The job-type configuration, verbatim as the caller built it. The engine
   * never re-derives one: a config rebuilt on this side could disagree with the
   * plan the user was shown.
   */
  config: Record<string, unknown>;
  /** Another step's id, or SOURCE_PARENT. */
  parentStepId: string;
  /** What this step reads when its parent is SOURCE_PARENT. Required there. */
  sourceRef?: ArtifactRef;
  resource: StepResource;
  status: StepStatus;
  progress: StepProgress;
  metrics: StepMetrics;
  /** What the step wrote. Present exactly when status is 'done'. */
  output?: ArtifactRef;
  /** Why it failed / was cancelled. Present exactly on 'failed' and 'cancelled'. */
  error?: string;
  /**
   * What a SUCCESSFUL step still owes the user in whole sentences — a ledger
   * refusal, a narration-carry note. A step with these is complete, not failed.
   */
  completionNotes?: string[];
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /**
   * This step's work was cut short and can be picked up from what is on disk —
   * a user stop, or an app exit mid-run. It is what tells TTS to resume rather
   * than render from sentence zero.
   */
  wasInterrupted?: boolean;
  /** Whatever the run produced for the analytics ledger, verbatim. */
  analytics?: unknown;
  /** The output path, as a string, for rows whose artifact is a file. */
  outputPath?: string;
}

/**
 * A run FOUNDRY ORDERED — which project, and which step of its ledger.
 *
 * ── Why the queue carries a fact about another application ──────────────────
 *
 * Because it is the only place the thread survives. The user pressed Narrate on
 * a step of a book's provenance tree; that press became a job here, and the rows
 * BookForge pushes back onto that tree (electron/foundry-host-nodes.ts) have to
 * name the step they hang under. Nothing else in the chain remembers it: the
 * modal closes, the window may close, and the run outlives both.
 *
 * BOTH FIELDS ARE FOUNDRY'S OWN SPELLING, recorded verbatim and never derived.
 * `projectDir` is the folder Foundry handed to `invoke` (its own path, its own
 * casing — Foundry folds the key on its side and re-spelling it here would be
 * this side guessing at that fold), and `parentStepId` is a LEDGER step id from
 * that project. Neither means anything to the engine, which is the point: it
 * stores them and hands them back.
 *
 * ABSENT IS THE ORDINARY STATE. A narration started from the versions page has
 * no foundry lineage and appears on no tree.
 */
export interface FoundryJobLineage {
  /** The Foundry project folder, absolute, exactly as the invoke named it. */
  projectDir: string;
  /** The ledger step the act was ordered from. Foundry's id, never ours. */
  parentStepId: string;
}

/**
 * Something the queue has to say about work it did NOT accept.
 *
 * `StepFinished` is news about a step that ran; this is news about a run that
 * never became one. The tone is what decides whether it can time out: a failure
 * toast does not auto-dismiss, because news the user was not looking at must not
 * be able to disappear unseen.
 */
export interface QueueNotice {
  tone: 'success' | 'failure';
  /** The small uppercase line — "Nothing was queued". */
  kicker: string;
  title: string;
  /** The sentence saying what happened and what to do about it. */
  message: string;
}

export interface QueueJob {
  id: string;
  /** The project directory this run is about. Absent for runs about no project. */
  projectId?: string;
  /** Set when Foundry ordered this run. See {@link FoundryJobLineage}. */
  foundry?: FoundryJobLineage;
  title: string;
  /** The document the run is about, as the user knows it. */
  documentPath?: string;
  documentLabel?: string;
  steps: QueueStep[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/**
 * What the graphics card reported while a GPU step was running.
 *
 * Sampled by main (nvidia-smi, ~20s cadence), recorded onto the engine, carried
 * on the snapshot, and NEVER persisted — a temperature is a fact about now.
 *
 * `throttleActive` is the DRIVER'S OWN verdict (the thermal bits of
 * clocks_event_reasons.active), not a threshold this app invented. That is the
 * difference between "the card says it is slowing itself down" and "we think
 * 84° sounds hot" — the first is a measurement; found live on 2026-08-19, when
 * a narration ran ~15% under its band at 86° with SW thermal slowdown active
 * and a fan already at 96%.
 */
export interface GpuThermalReading {
  tempC: number;
  fanPct?: number;
  powerW?: number;
  clocksMhz?: number;
  clocksMaxMhz?: number;
  /** The driver reports a THERMAL slowdown in force right now. */
  throttleActive: boolean;
  /**
   * Thermal slowdown held across CONSECUTIVE samples — the one the UI warns on.
   *
   * The instantaneous bit blips: at 76-77° core the driver raises SW thermal
   * slowdown for a moment (the GDDR6X memory junction grazing its limit — the
   * core's own 83° target is nowhere near), and a single 20s sample painted the
   * "Running hot" banner over a run that was not meaningfully throttled (Owen,
   * 2026-08-29; a minute of hand-sampling showed only the power cap). One
   * sample is a blip; two in a row is a card actually held down. Analytics
   * keep counting `throttleActive` seconds — the blips are real time, just not
   * worth a banner.
   */
  throttleSustained: boolean;
  /** ISO timestamp of the sample. */
  at: string;
}

/** What a whole run experienced thermally, merged into its analytics at settle. */
export interface GpuThermalSummary {
  samples: number;
  maxTempC: number;
  avgTempC: number;
  /** Seconds of the run the driver spent in thermal slowdown. */
  throttledSeconds: number;
}

/** The engine's whole published state. */
export interface QueueSnapshot {
  jobs: QueueJob[];
  /**
   * Whether the engine is claiming work. Pause stops it claiming; it never stops
   * a step that is already running (you stop those one at a time, deliberately).
   */
  running: boolean;
  /**
   * The card's latest reading while a GPU step runs; absent otherwise. Absent is
   * the answer when nothing samples (no GPU step, or no nvidia-smi on this
   * machine) — never a stale reading and never an invented one.
   */
  gpuThermal?: GpuThermalReading;
}

/**
 * A job's status, read off its steps.
 *
 * Order matters and each rung is a different fact:
 *  - one step running ⇒ the job is running, whatever the others are doing.
 *  - one step failed ⇒ the job failed, even if later steps were cancelled after
 *    it (they were cancelled BECAUSE of it, and naming the cancellation instead
 *    would hide the failure that caused it).
 *  - everything terminal with a cancellation and no failure ⇒ cancelled.
 *  - everything done ⇒ done.
 *  - otherwise it has not started: `queued` if anything is released, else `held`.
 */
export function jobStatus(job: QueueJob): StepStatus {
  const steps = job.steps;
  if (steps.length === 0) {
    throw new Error(`Queue job ${job.id} has no steps, so it has no status to read.`);
  }
  if (steps.some((s) => s.status === 'running')) return 'running';
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  const allTerminal = steps.every((s) => TERMINAL_STEP_STATUSES.has(s.status));
  if (allTerminal) {
    if (steps.some((s) => s.status === 'cancelled')) return 'cancelled';
    return 'done';
  }
  const live = steps.filter((s) => !TERMINAL_STEP_STATUSES.has(s.status));
  if (live.every((s) => s.status === 'held')) return 'held';
  if (live.some((s) => s.status === 'waiting') && !live.some((s) => s.status === 'queued')) {
    return 'waiting';
  }
  return 'queued';
}

/** The job's overall percentage: the mean of its steps, a terminal step counting 100. */
export function jobPercent(job: QueueJob): number {
  const steps = job.steps;
  if (steps.length === 0) return 0;
  let total = 0;
  for (const step of steps) {
    if (step.status === 'done') total += 100;
    else if (step.status === 'running') total += step.progress.percent ?? 0;
    // failed / cancelled / not-started contribute what they got to, which for a
    // step that never ran is nothing. A failed step is NOT credited 100.
    else if (step.status === 'failed' || step.status === 'cancelled') {
      total += step.progress.percent ?? 0;
    }
  }
  return Math.round(total / steps.length);
}

/**
 * Job types this build will not run, and what to tell the user about each.
 *
 * The queue is persisted, so a queue written by an older build outlives the code
 * that understood it. A row whose type no longer exists cannot be reasoned about
 * — nothing knows what it would do — so it is FAILED on load with the sentence
 * that explains it, never left waiting in a queue that silently steps over it.
 */
export const RETIRED_JOB_TYPES: ReadonlyMap<string, string> = new Map([
  ['document-get-text', 'Get Text is gone: BookForge no longer casts a working PDF with '
    + 'Tesseract. Converting a PDF to a book is one act now — Convert to EPUB. Remove this row.'],
  ['document-blocks', 'Detect blocks is gone: the block model and the layout pipeline it '
    + 'labelled for were retired when Convert to EPUB became the only PDF→EPUB conversion. '
    + 'Remove this row.'],
  ['document-reflow', 'Build the book is gone: Convert to EPUB writes the book directly from the '
    + 'pages, so there is no working document to reflow. Remove this row.'],
  ['foundry-footnotes', 'The AI footnote pass is gone. Digits-only footnote references are now '
    + 'removed deterministically as the narration copy is written, so nothing needs to be queued. '
    + 'Remove this row.'],
  ['foundry-scan', 'Tesseract is no longer part of this app: the pages are read by the document '
    + 'vision model Convert to EPUB runs. Remove this row.'],
  ['foundry-ocr-correct', 'OCR correction is gone with the Tesseract pipeline it repaired. '
    + 'Remove this row.'],
  ['foundry-ocr', 'OCR correction is gone with the Tesseract pipeline it repaired. Remove this '
    + 'row.'],
  ['foundry-detect', 'Detection is gone with the Tesseract pipeline it labelled. Remove this '
    + 'row.'],
  // The language-learning pipeline (removed 2026-09-05). Its three steps were a
  // chain: clean the source text, translate it sentence-by-sentence, then
  // interleave two voices into one audiobook. A queue written before then can
  // hold any of the three.
  ['bilingual-cleanup', 'The language-learning pipeline is gone, and this was its AI cleanup '
    + 'step. Run AI cleanup on the book itself instead — it is a pass on the Process tab. '
    + 'Remove this row.'],
  ['bilingual-translation', 'The language-learning pipeline is gone, and this was its '
    + 'sentence-by-sentence translation. A whole-book translation is a pass on the Process tab '
    + 'now. Remove this row.'],
  ['bilingual-assembly', 'Dual-voice bilingual audiobooks are gone: assembly interleaved a '
    + 'source and a target rendering, and nothing produces the pair any more. Narrate the book '
    + 'in one voice instead. Remove this row.'],
  // The master container row. It never executed anything: it existed to group a
  // workflow, which is the job itself now.
  ['audiobook', 'This row was a container for the steps below it. Runs are one row with their '
    + 'steps inside now, so it has nothing to do. Remove this row.'],
]);

/**
 * Minimum span, in seconds, before a chunk-rate window is reported at all.
 *
 * Batched engines emit progress in bursts of 64, and consecutive bursts can land
 * only ~25s apart when two batches' emits coalesce — timing that single gap
 * gives 143 chunks/min for a job actually running at ~70. A window shorter than
 * roughly one batch cycle cannot average out that quantization, so it is not
 * shown.
 */
export const RATE_WINDOW_MIN_SECONDS = 45;
