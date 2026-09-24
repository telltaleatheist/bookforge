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

// Type-only, and deliberately one-way at runtime: `slot-sets.ts` owns the slot
// vocabulary and imports the queue's shapes from here, so the back-reference
// must erase. It does — nothing below imports a VALUE from that module.
import type { SlotSet } from './slot-sets';
import type { StopReason } from './stop-reason';

/** Job types this queue can run. Retired vocabulary is listed separately below. */
export type JobType =
  /**
   * PACK THE BOOK INTO GENERATION CHUNKS — narrator's prep, on this machine's
   * CPU, before any card is asked for.
   *
   * Owen, 2026-09-19: *"Prepare can be its own CPU step… we could start the CPU
   * prep the moment a free CPU slot is open and an item enters the active (and
   * unpaused) queue."* It was the first minutes of the `tts-conversion` step
   * until then, which had two costs and one of them was a defect: the row held
   * a GPU slot while it extracted and split a book (no card involved at all),
   * and a render refused `409 server_busy` had ALREADY prepped — minutes on a
   * long book — into a scratch session the next attempt did not match, so the
   * prep was paid again (bug hunt 2026-09-19, finding A2).
   *
   * It travels nowhere: `machines()` is absent, so the pump admits it the
   * moment a `local-work` CPU slot is free, with no server decided and no lease
   * reserved. Those are asked for once the chunks exist.
   */
  | 'prepare'
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
  /**
   * FORCE-ALIGN THE RENDERED CHUNKS AGAINST THE TEXT THEY WERE GIVEN, and write
   * the coverage report assembly reads out. It REPORTS — the row succeeds
   * whatever the chunks said, and the assembly behind it runs (Owen,
   * 2026-09-05).
   *
   * A row of its own for the reason the denoise is: it is a distinct act with a
   * distinct duration (CPU minutes, RTF ~0.08 — a five-hour book is a few
   * minutes) and its own way of failing, and a run that folded it into the
   * render would report "narrating" while it aligned.
   *
   * It exists because an ENFORCED engine — Higgs v3 — has no duration guard
   * worth the name: a chunk measured a duration ratio of 0.99 while dropping
   * 22 % of its text. `assemble/coverage_gate.py` refuses such a book, and
   * refuses just as loudly when nobody checked. This is the step that checks.
   * See `shared/queue/coverage-policy.ts` for which engines it runs for.
   */
  | 'align'
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
  | 'foundry-job'
  /**
   * HAND A FOUNDRY EXPORT TO THE NARRATION WHEN IT LANDS.
   *
   * Owen, 2026-09-07: "i can click the grayed out exported epub and click
   * narrate. then send narration and assembly to the queue." The export does not
   * exist when Narrate is pressed, so the run cannot name the file it will read;
   * this row sits UNDER the export's Foundry row and, once that lands, finds the
   * version the library filed for it (`registerFoundryExportLanding`) and hands
   * the narration an `epub` artifact — the same thing a pressed export row would
   * have been. CPU, seconds, no engine: it waits and it looks up.
   */
  | 'foundry-export-landing';

/** The job types that are processing passes, for a runtime membership test. */
export const PASS_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'simplify', 'translate-pass', 'footnote-refs', 'narration-text',
]);

/**
 * WHAT "ADDING A BOOK" MEANS, for the Pending band — and why it is this narrow.
 *
 * Owen's ruling of 2026-09-15 (`docs/PENDING-QUEUE-AND-GPU-DIAL.md` §1):
 * *"Adding a book puts it in PENDING, not in the live queue."* A run that
 * carries one of these is that act; a run that does not is not staged and
 * behaves exactly as it did before.
 *
 * ── Why not simply "every run that can travel" ──────────────────────────────
 *
 * That was the first cut and it was wrong, and the keeper suite said so: the
 * `foundry-export-landing` row a pending-export narrate hangs from is not an
 * act anybody chooses a machine for, and neither is a pass ordered from the
 * Process tab as part of a chain. The test is not "does it travel" but WHETHER
 * THERE IS A VENUE TO CHOOSE and whether the press was the moment to choose it.
 *
 * ── A HOSTED FOUNDRY ACT STAGES TOO (Owen, 2026-09-18) ──────────────────────
 *
 * *"when i add something to the queue in the vendored copy of foundry, it
 * doesnt add it to the pending section, where i can pick the GPU. it just
 * throws it right into the queue. it should add it to pending so i can
 * configure the gpu it should go to."*
 *
 * This reverses the narrower reading that stood here until that date, and the
 * reason it can is that ITS PREMISE STOPPED BEING TRUE. The argument was that
 * staging a Foundry-ordered text act *"put a Send to queue gate in front of a
 * button pressed in ANOTHER APPLICATION'S window — where there is no Pending
 * band to press it in"*. Foundry is hosted INSIDE BookForge: the queue that
 * holds the row and the Pending band that releases it are in the same
 * application as the button, one tab away, and the row is drawn on Foundry's
 * own shelf as `held` — which their shelf already words as *waiting for you*.
 *
 * And the other half of that argument — that a text act means *do this now* and
 * *"the machine it lands on is not a decision anybody was making"* — was simply
 * not so. A clean over a whole book is a model reading every block of it, which
 * is the same question a render asks: WHICH CARD. Sending it wherever the dial
 * happened to point, with no moment to say otherwise, is the defect.
 *
 * ── WHAT THIS DOES NOT STAGE, AND WHY THAT IS NOT AN OMISSION ───────────────
 *
 * `jobIsStageable` requires `travels === true` as well as membership here, and
 * for a `foundry-job` that is decided by kind (`machines()`,
 * electron/queue-steps/foundry-job.ts): every GPU act travels — clean,
 * translate, simplify AND **read** — while a RENDERING does not, because it
 * asks no model at all.
 *
 * A READ STAGES SINCE 2026-09-19, and the note that used to stand here is the
 * reason it did not before: *"it is the VLM door and still spawns a local python
 * env, so there is no venue to pick … Making a read travel is a Foundry-side
 * change (crucible `docs/PHASE7-LANES.md` §8.1); the moment it is one, it stages
 * here with no further edit, because the two facts are already asked
 * separately."*
 *
 * That moment came, and the prediction held exactly: the vendored Foundry maps
 * `capabilityClassOf('read') → 'pages'` and places a read on a Crucible slot, so
 * the picker is no longer empty — and this list needed no edit, only `machines()`
 * did. What the old note could not foresee is what the gap COST while it stood:
 * with no venue picked here, the read went out with `waitFor` absent and
 * Foundry's own `newJobsWaitFor` chose the machine, so the bench drew a read on
 * a switched-off Mac while it ran on the PC.
 *
 * A CHAINED REQUEST IS NOT STAGED EITHER, and that is `enqueue`'s doing rather
 * than this list's: a request naming `after` is appended onto the run that owns
 * the row it follows (electron/foundry-host-queue.ts), so it joins that run's
 * decision instead of asking the same question twice about one book.
 *
 * A SET rather than a comparison, for `PASS_JOB_TYPES`' reason: when a second
 * long-form render act exists it joins the list here and nothing else moves.
 */
export const STAGED_JOB_TYPES: ReadonlySet<JobType> = new Set<JobType>([
  'tts-conversion',
  'foundry-job',
]);

/**
 * What a step is doing.
 *
 * `held`   — composed, in the list, and released by nothing yet. The user has not
 *            pressed Start for it. A user STOP also lands here: a stopped step is
 *            precisely one that is present, will not be auto-picked, and needs an
 *            explicit gesture to run again. (It carries `wasInterrupted`, so the
 *            renderer can say "stopped" rather than "not started yet", and
 *            {@link QueueStep.stopReason}, which says WHOSE gesture it was —
 *            only a user's keeps the row here through an untargeted Start.)
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
 * workers, RVC, whisper, the document vision model and a pass on the bundled
 * local model all belong to it, because they all end up on the same card.
 *
 * `cpu` is the small pool for work that contends for nothing local: a pass whose
 * provider is a hosted API is network latency and nothing else, and making it
 * wait behind a nine-hour narration was the queue punishing a job for the
 * company it kept.
 */
/**
 * WHICH BENCH A STEP OCCUPIES WHILE IT RUNS.
 *
 * `gpu` and `cpu` are WORKERS: a step holding one is doing arithmetic nobody
 * else can do at the same time, which is why there are so few of them.
 *
 * `wait` is not a worker and does not belong on the bench. A step declares it
 * when its whole job is to sit until something outside this queue happens —
 * today, `foundry-export-landing` waiting for an EPUB Foundry's own queue is
 * writing. Owen, 2026-09-08, watching one of those hold a CPU slot: *"the epub
 * generation step is supposed to be rapid. it happens in seconds. but its
 * sitting in the cpu slot doing nothing for two minutes now"*. The waiting was
 * a symptom of a bug on the other side of the seam; holding a worker WHILE
 * waiting was this side's own, and it would have starved a real render behind
 * it even when the wait is the second it is meant to be.
 *
 * `benchLanes` draws `gpu` and `cpu` only, so a waiting step is absent from the
 * bench and present in the queue's own list — which is the truth: it is queued
 * work that is using nothing.
 */
export type StepResource = 'gpu' | 'cpu' | 'wait';

/*
 * `RESOURCE_SLOTS` USED TO BE HERE, and it was one global number per resource.
 *
 * It is gone rather than adjusted, because a single `gpu: 1` for the whole
 * application meant a book rendering on the Mac held THIS machine's only GPU
 * slot — so two books could never render on two machines at once, which is the
 * entire reason a second server is registered. Capacity is per MACHINE now:
 * `shared/queue/slot-sets.ts`, crucible `docs/PHASE7-LANES.md` §2.4. The wait
 * cap moved there too (`WAIT_STEP_CAP`), so nothing has two owners.
 */

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
  /**
   * A SESSION PACKED AND NOT YET READ ALOUD — what the `prepare` step writes.
   *
   * Its own kind rather than `audio-session`, because the difference is the
   * whole point: a prepared session holds `session-state.json` and its chunk
   * texts and NOT ONE `.flac`. Declaring it as an audio session would let a
   * denoise, a voice conversion or an assembly be composed straight behind the
   * prep — `checkLineage` would say yes — and each of them would find an empty
   * `chapters/sentences` and either fail deep or produce silence.
   */
  | 'prepared-session'
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
  /**
   * e2a session identity. Present on kind 'audio-session' and on the
   * 'prepared-session' the `prepare` step writes — the same three names, one
   * step earlier, before a single chunk has been read aloud.
   *
   * `sessionDir` is the `ebook-<uuid>` folder and `processDir` the directory
   * inside it holding `chapters/` and `session-state.json` — the two arguments
   * every assembly, denoise, conversion and align bridge takes. A producer
   * states the DURABLE pair (the project cache), never e2a's scratch, which the
   * startup sweep clears: `tts-conversion` named the scratch session and no
   * processDir at all until 2026-09-12, and the assembly chained behind it could
   * not read its own input.
   */
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
 * On Mac, Orpheus renders ~96 chunks as ONE 5-7 minute decode whose files all
 * land at the end — but its ROWS retire one at a time, and the engine counts
 * them. Since 2026-09-11 the bridge folds `rowsRetiredInCall` into the chunk
 * count, so the chunk bar ticks off rows as they exit the batch (the way the
 * PC's does) and the desktop UI draws no second bar. The object stays on the
 * wire for the Bookshelf queue view, which still draws one. Every field is what
 * the engine actually reported — nothing is defaulted, and the whole object is
 * absent when no batch is decoding.
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
   * Rows retired across the whole engine call — this batch's `rowsDone` plus the
   * sub-batches before it ("batch 1/2", "batch 2/2"), which each restart their
   * own count at 0. This is the number the chunk count is folded from. Absent on
   * an object restored from a queue.json written before the field existed.
   */
  rowsRetiredInCall?: number;
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
   * full secondary bar sitting under the chunk bar on a surface that draws one
   * (today only the Bookshelf queue view; the desktop UI folds the batch's
   * retired rows into the chunk bar instead — see ActiveBatchProgress).
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
   * count PAGES, a translate and a `clean` count BLOCKS — and their shelf, which
   * draws these rows back to the person who ordered them, says which. A bar that
   * silently changed units mid-run would be the same lie as a bar that changed
   * scale.
   *
   * Its ABSENCE is also load-bearing: nothing has been counted yet, which is a
   * different statement from a count of zero, and `progressOf` returns null on
   * it rather than sending a progress with no numbers in it.
   *
   * `clean` arrived with foundry 9f4ee4e — the narration text pass, which counts
   * the blocks it asks the model about (`clean-text: 412/2081`). It is a MIRROR
   * of their `JobProgress.phase` and every member of it is theirs, so this list
   * moves when that one does and never on its own account.
   */
  foundryPhase?: 'render' | 'read' | 'translate' | 'clean' | 'rank' | 'verify';
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
   * Timestamp (ms) of the END of this run's FIRST BURST of chunk completions,
   * and the session chunk count at that instant. Rate is measured over
   * [stamp, last landing] containing (done - chunksAtFirstStamp) completions:
   * measuring from startedAt would fold in model load, and measuring from the
   * stamp WITHOUT its count assumes progress arrives one chunk at a time, which
   * batched engines make false. `shared/queue/rate-window.ts` (`rateAnchor`)
   * owns how both are chosen.
   */
  firstChunkCompletedAt?: number;
  chunksAtFirstStamp?: number;
  /**
   * When the anchoring burst began, and — by its PRESENCE — that the burst is
   * still open and the anchor may still slide to its end.
   *
   * Cleared at the first real gap between landings, and never set again for this
   * run: after that the anchor is fixed, so a later batch cannot re-open the
   * window and throw away everything measured since. It also bounds the slide,
   * for an engine whose chunks land closer together than the gap for ever —
   * a stream with no bursts anchors at its first landing, as it always did.
   */
  anchorBurstOpenSince?: number;
  /**
   * When the RENDER settled — the last chunk landed and the step moved on to
   * whatever it still owes (publishing the session into the library, and for an
   * inline run the assembly).
   *
   * The row's Elapsed ends here rather than at the step's own completion, and
   * every per-minute figure in `job-analytics.json` is measured to the same
   * instant. Owen, 2026-09-20: *"it should zero out when it finishes rendering,
   * not give the idea that its still rendering … if its doing a different action
   * it should say its doing that."*
   */
  renderSettledAt?: number;
  /**
   * THE NAME OF THE SERIES THESE COUNTS BELONG TO, for a step that counts more
   * than one thing in a row.
   *
   * A Crucible alignment is the case it exists for: two passes over one book —
   * the server places every word, then this machine measures the book from the
   * items it placed — each counting the SAME chunks from zero against the same
   * total. A count that restarts is a new measurement, not a continuation, and
   * the engine drops the rate anchor when this changes (`applyReport`, rule in
   * `shared/queue/rate-window.ts` → `rateSeriesChanged`).
   *
   * ABSENT IS "NO OPINION" and is every other step in the queue: one series per
   * run, the anchor behaves exactly as it always has.
   */
  rateSeries?: string;
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
  /**
   * WHETHER THIS STEP HAS BEEN TAUGHT TO TRAVEL (crucible
   * `docs/PHASE7-LANES.md` §4: `machines()`, defaulting to `local`).
   *
   * True exactly when the step's module says it can run on a Crucible server —
   * today only `tts-conversion`. Everything else keeps behaving as it does now:
   * a VLM page read, an RVC pass and a bundled-local pass all spawn something
   * on THIS machine, and handing one of them a remote server would either fail
   * on a path that does not exist or, far worse, run locally while occupying a
   * remote slot.
   *
   * DERIVED, like `resource`, and re-asked from the module on every load: the
   * module is the authority, this is the copy the renderer can read (it is what
   * decides whether the queue page draws a server picker on the row). A build
   * that teaches a step to travel must be able to say so about work already in
   * the queue.
   */
  travels?: boolean;
  /**
   * THE CAPABILITY CLASS THIS STEP ASKS A CRUCIBLE FOR — `pages`, `clean`,
   * `translate`, `simplify`, `analysis` — or absent when its module names none.
   *
   * DERIVED, like `travels` and `resource`, and re-asked from the module on
   * every load (`StepModule.crucibleClass`): the module is the authority, this
   * is the copy the scheduler reads inside a synchronous pump and the copy the
   * bench reads to refuse a drop onto an engine that cannot serve it (Owen's
   * pages-refused report, 2026-09-21). It is what a server's `GET /v1/capability`
   * decision is matched against — a book routed to a server that published
   * `enabled: false` for this class holds rather than landing and being refused.
   */
  crucibleClass?: string;
  /**
   * WHERE THIS STEP'S WORK ACTUALLY WENT — a registered server's name, a cloud
   * lane, or `local-longform-align` for the one GPU act that cannot travel.
   *
   * Written by the pump at the moment the step is admitted, and changed
   * afterwards by exactly ONE act: the GPU HAND-OFF, which clears it back to
   * this machine's local work (`StepRunContext.releaseGpu`,
   * electron/queue-engine.ts). A step that has given the card back is no longer
   * work on that machine — the rest of it is a file copy here — and leaving the
   * server's name standing would charge that engine's pool for it and draw the
   * row on its lane. The pair is written together there for the same reason
   * admission writes it together: venue and resource are one fact about where a
   * step's work is happening, and they cannot be allowed to disagree.
   * {@link QueueJob.waitForResolved} is NOT touched by the hand-off — §4.3 still
   * rules that the run stays assigned to the machine it started on.
   *
   * It is the SLOT SET the step occupies while it runs
   * (`shared/queue/slot-sets.ts`), which is why it has to be on the step rather
   * than only on the run: a run can hold two GPU steps whose venues differ
   * while the migration is half done — a render already sent to the Mac and an
   * RVC pass whose module has not been taught to travel and therefore spawns
   * here.
   *
   * NOT A SECOND ROUTING LEVEL, and §4.4 still rules that one book is one GPU:
   * {@link QueueJob.waitFor} is what the operator asked for, `waitForResolved`
   * is what the run was assigned, and this is what one step of it did. A record,
   * three scopes, no instruction among them.
   */
  venue?: string;
  status: StepStatus;
  progress: StepProgress;
  metrics: StepMetrics;
  /** What the step wrote. Present exactly when status is 'done'. */
  output?: ArtifactRef;
  /** Why it failed / was cancelled. Present exactly on 'failed' and 'cancelled'. */
  error?: string;
  /**
   * THE ACCOUNT OF THE ATTEMPT BEFORE THIS ONE — kept when `error` is cleared,
   * never read as state.
   *
   * A stop and a Retry both put a step back in play, and both used to write
   * `error = undefined` (bug hunt 2026-09-20, P6/F7). That erased the only
   * durable copy of a failure's reason: the Foundry engine's stdout/stderr is
   * accumulated in memory and lost with the process, a progress line
   * overwrites, and `error` was the one field persisted to `queue-engine.json`
   * — so the stderr of a clean that died on an ENOENT was gone the moment
   * somebody pressed Retry on it, before anyone had read it. Live: a `held`,
   * `wasInterrupted` row with an empty `progress` whose four descendants still
   * said *"Skipped: … failed"* — the children remembering a failure the row
   * denied.
   *
   * SEPARATE FROM `error` because `error` is what the bench draws red and what
   * *Needs you* is filtered on: a retried row must not be red, and a stopped
   * one is not broken. This is history, shown as a secondary line at most, and
   * it is overwritten by the NEXT failure's account rather than accumulating.
   */
  lastError?: string;
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
  /**
   * WHOSE GESTURE STOPPED IT — `'user'` (Stop was pressed) or `'closed'` (the
   * app ended while it was running). Present exactly when `wasInterrupted` is.
   *
   * ── Why the flag was not enough (bug hunt 2026-09-20, S12) ────────────────
   *
   * `wasInterrupted` says the work can be picked up; it does not say who ended
   * it, and the two answers are treated differently at both ends of the row.
   * The SENTENCE differs — a quit that borrowed the Stop button's words told
   * Owen he had stopped two renders he had not touched — and so does what
   * pressing Running means: a row the close interrupted is one nobody asked to
   * stop, so the person pressing Running is asking for it back, while a row
   * they stopped by hand stays held until they press its own ▶.
   *
   * ABSENT ON AN OLD ROW, and `closedInterrupted` (shared/queue/stop-reason.ts)
   * reads that as `'closed'` — see its docstring for why that is the safe half.
   */
  stopReason?: StopReason;
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
  /**
   * WHICH CRUCIBLE SERVER THIS BOOK SHOULD WAIT FOR — a registered server's
   * name, or `any` (crucible `docs/PHASE7-LANES.md` §4.2.1).
   *
   * ONE field, on the JOB, because §4.4 rules that one book is one GPU: a
   * dependency chain gets one machine choice and every step of it follows.
   * There is no per-step override and no modifier — see `shared/queue/wait-for.ts`
   * for why each of those was removed rather than merely discouraged.
   *
   * Written at enqueue from the routing record's `newJobsWaitFor` setting
   * (§4.2.1a), VISIBLY: `top-ranked` writes the top-ranked server's NAME and
   * `any` writes `any`. It is absent in exactly two honest cases — a queue file
   * written before this field existed, and a run queued while this machine had
   * no server to name — and admission then HOLDS and says so (`holdNoAnswer`).
   * It is never defaulted at read time: a fabricated name is an instruction
   * nobody gave.
   *
   * Present only on runs that carry a step which can travel ({@link QueueStep.travels}).
   */
  waitFor?: string;
  /**
   * THIS RUN IS STAGED, NOT QUEUED — it is in Pending and nothing about it is
   * committed.
   *
   * Owen's ruling of 2026-09-15 (`docs/PENDING-QUEUE-AND-GPU-DIAL.md` §1):
   * *"Adding a book puts it in PENDING, not in the live queue. Nothing about a
   * pending item is committed."* You choose its server there, and then press
   * **Send to queue**.
   *
   * ── Why a flag on the run and not a second store ────────────────────────────
   *
   * Because a pending item IS a run — a title, a chain of steps, a `waitFor` —
   * and the queue already persists exactly that, survives a restart with it, and
   * refuses a chain that cannot read itself at the moment it is COMPOSED rather
   * than an hour later. A parallel store of un-validated job specs would defer
   * every one of those checks to the press, which is the "an hour later" failure
   * this engine was built to remove. So Pending is a STATE of a run, the run is
   * in `jobs[]` like every other, and `queue-engine.json` is what makes it
   * survive the app closing (§"Persistence": *"A book staged but not sent must
   * not vanish because the app closed"*).
   *
   * ── What "nothing is committed" means, enforced ─────────────────────────────
   *
   * Its steps are `held`, `pump` skips the whole run BY NAME, `release` will not
   * release it, and nothing ever writes `waitForResolved` for it. So it holds no
   * slot, names no venue, and turning the dial or re-pointing the book costs
   * nothing.
   *
   * ── Which runs get it ───────────────────────────────────────────────────────
   *
   * The ones that carry a step which can TRAVEL — a book being narrated. A run
   * of passes, assemblies and Foundry reads has no Crucible server to choose and
   * no dial acting on it, so a Pending section for one would be a press that
   * decides nothing (the same argument `waitFor` itself is gated by: §4.2.3's
   * representable states).
   *
   * Absent means "in the live queue", which is every run written before this
   * existed and every run that has been sent.
   */
  pending?: boolean;
  /**
   * WHERE THIS BOOK'S GPU WORK WAS ACTUALLY SENT — a server's name. A queue
   * written before 2026-09-15 can also carry `legacy-local-narrator`, which is
   * refused by name rather than honoured (`shared/queue/wait-for.ts`).
   *
   * Written once, at the first GPU admission, and never changed: §4.3, a job is
   * atomic, so a book that started on a machine finishes on that machine, and a
   * resume after an app restart goes back to the same one. It is a RECORD, not
   * a second routing level — `waitFor` is what the operator asked for and this
   * is what happened, which is why a re-rank, a disable, or the legacy switch
   * flipping mid-book cannot move work already assigned.
   */
  waitForResolved?: string;
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

/**
 * WHETHER ONE REGISTERED CRUCIBLE SERVER IS ANSWERING, as the scheduler last
 * observed it — published so a surface can say so without asking again.
 *
 * ── Why it is on the snapshot ──────────────────────────────────────────────
 *
 * The scheduler has always known this: `askReach` pings a server when a queued
 * row needs one, and the answer decides whether the row is held or sent. But it
 * kept the answer to itself, so the queue page drew each engine's lane with its
 * on/off switch and NO idea whether the machine behind it was up. An operator
 * whose Mac was asleep saw a lane that looked exactly like a working one, with
 * their books simply not starting — and the reason was in a cache one process
 * away.
 *
 * It is an OBSERVATION and never an instruction. `enabled` is the operator's
 * standing choice about that hardware and is theirs alone to change; `reach` is
 * what the address did when it was last asked. A surface that wrote one from
 * the other would switch a machine off because it was asleep, and the operator
 * would come back to a card nobody had told them was disabled.
 */
export interface ServerReach {
  /** The registered name — the key everything else about this machine uses. */
  readonly name: string;
  /** The operator's switch (`routing.disabled` inverted), not a state of health. */
  readonly enabled: boolean;
  /**
   * What it last said. `unknown` is a real answer and not a missing one: nobody
   * has asked yet, or the last answer has aged out of its TTL and the next
   * sweep will ask again. A disabled server stays `unknown` forever, because
   * the queue does not ping a machine the operator switched off.
   */
  readonly reach: 'unknown' | 'ready' | 'unreachable' | 'busy';
  /**
   * The sentence behind the answer — the transport's own words for
   * `unreachable`, the server's `busyLine` for `busy` — and `null` when there
   * is nothing to add (`ready`, `unknown`).
   */
  readonly detail: string | null;
  /**
   * WHICH CAPABILITY CLASSES THIS ENGINE HAS PUBLISHED A DECISION ABOUT —
   * class → `enabled`, straight from its `GET /v1/capability`.
   *
   * For the bench, which refuses a drop onto a lane whose server cannot serve
   * the book's class (`shared/queue/bench.ts`, `BenchLane.servedClasses`; the
   * page's `pinRefusal`). A class ABSENT from this map is `unknown`, which is
   * CAPABLE — the drop is allowed, matching the scheduler (`crucible/routes.ts`,
   * `crucibleServesClass`). Empty for an engine nobody has read yet, so nothing
   * is refused on a fresh launch (Owen's pages-refused report, 2026-09-21).
   */
  readonly servedClasses: Readonly<Record<string, boolean>>;
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
  /**
   * EVERY SLOT SET THAT EXISTS RIGHT NOW — one per enabled Crucible server, the
   * legacy narrator spawn while its switch is on, any set still holding work of
   * ours, and `local-work` last (`shared/queue/slot-sets.ts`).
   *
   * On the snapshot because the bench is PURE and the set list is not derivable
   * from the jobs: it comes from the routing record, which only main can read.
   * The engine composes it on every snapshot so a server enabled a second ago
   * has its lane before the next pump.
   */
  slotSets: SlotSet[];
  /*
   * A `gpuDial` RODE HERE and it is gone (Owen, 2026-09-19: *"that works for
   * me"*). It was the queue-wide GPU dial's value, drawn by a control the
   * per-slot enable switches had already replaced — a scheduler input with no
   * owner on screen (docs/QUEUE-CRUCIBLE-BUG-HUNT-2026-09-19.md, A4). Which
   * machines may be used is `slotSets` + the enable switch; which machine a
   * book wants is `QueueJob.waitFor`.
   */
  /**
   * EVERY REGISTERED CRUCIBLE SERVER AND WHETHER IT IS ANSWERING — see
   * {@link ServerReach}.
   *
   * On the snapshot for `slotSets`' reason: it comes from a record and a cache
   * only main has, and the page draws it. In rank order, disabled servers
   * included, so the list lines up one-to-one with the lanes the bench builds.
   *
   * EMPTY when no routing host is wired (a headless run, a keeper with no
   * scripted record) — which is the truthful answer there, because nothing can
   * be asked. It is never a partial list: a server the record names but nobody
   * has pinged is present as `unknown`.
   */
  servers: ServerReach[];
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
 *  - otherwise it has not started: `queued` if anything is released, else the
 *    rung that says WHO the run is waiting on — `held` ahead of `waiting`.
 *
 * ── WHY `held` OUTRANKS `waiting` (bug hunt 2026-09-20, Q8) ────────────────
 *
 * The two answer different questions and only one of them is actionable. A
 * `waiting` step is waiting on a PARENT, which the queue will finish by
 * itself; a `held` step is waiting on a PERSON. A chain of [held narrate,
 * waiting align, waiting assemble] filed itself under `waiting` because a
 * `waiting` row was seen first — so a run that needed a press was drawn as one
 * that was getting on with it, next to the bench's own suppressed "Start this
 * book". The held row is the one nothing else will move, so it is the run's
 * status.
 *
 * A live `queued` row still outranks both: the scheduler has that row and will
 * start it the moment a slot opens, which is neither of the two waits.
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
  if (!live.some((s) => s.status === 'queued')) {
    if (live.some((s) => s.status === 'held')) return 'held';
    if (live.some((s) => s.status === 'waiting')) return 'waiting';
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
 * The rate window lives in ./rate-window with the arithmetic that uses it — one
 * definition, so the engine, the renderer and the host-node readout cannot drift
 * apart on how long a window has to be. Re-exported here for the callers that
 * already read it off this module.
 */
export { RATE_WINDOW_MIN_SECONDS } from './rate-window';
