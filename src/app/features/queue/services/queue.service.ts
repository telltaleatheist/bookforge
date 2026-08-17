/**
 * QueueService — a MIRROR of the queue, which lives in main.
 *
 * ── What this used to be ────────────────────────────────────────────────────
 *
 * 5,373 lines: the scheduler, two-lane concurrency, persistence, a 1,590-line
 * `runJob` ladder with one branch per job type, and eight per-bridge progress
 * subscriptions each with its own wire shape. All of it in a process that can be
 * reloaded, closed, or opened twice — which is how a renderer reload came to
 * orphan the GPU, and how every extra Listen window booted a second scheduler
 * that wrote its own `queue.json` over the one the user was watching.
 *
 * ── What it is now ──────────────────────────────────────────────────────────
 *
 * Seed from `queue:list`, replace on `queue:changed`, and turn what the
 * components ask for into an IPC call. NO scheduling, NO persistence, NO
 * progress parsing. The second-window hazard is gone by construction: a mirror
 * that never writes cannot overwrite anything, so a Listen window showing the
 * queue is a second VIEW rather than a second scheduler.
 *
 * ── Why it still speaks in the old shape ────────────────────────────────────
 *
 * The engine's model is a JOB with a CHAIN OF STEPS. The queue tab's model is a
 * flat list of rows where a run is a master row plus children carrying
 * `parentJobId`/`workflowId`. Those are the same thing said twice, and this file
 * is where the translation lives (`projectJobs`) — one function, so the tab, the
 * ETA service and the stage bars keep working unchanged while the truth moved
 * processes. A row's `id` is a STEP id; a master row's is the job's.
 */

import { Injectable, inject, signal, computed, DestroyRef, NgZone } from '@angular/core';

import {
  QueueJob,
  JobType,
  JobStatus,
  CreateJobRequest,
  JobConfig,
  TtsConversionConfig,
  ProcessingPassJobConfig,
  PASS_JOB_TYPES,
} from '../models/queue.types';
import type {
  ArtifactRef,
  QueueJob as EngineJob,
  QueueSnapshot,
  QueueStep as EngineStep,
  StepStatus,
} from '@shared/queue/engine-types';
import { jobPercent, jobStatus, SOURCE_PARENT } from '@shared/queue/engine-types';
import type { PassJobResult, ProcessingChainPlan, ProcessingChainRequest } from '@shared/processing/pass-types';
import { passResultNotes } from '@shared/processing/pass-notes';
import { buildConversionConfig, type VlmConvertJobConfig } from '../jobs/vlm-convert-job';
import { isExplodedBookPath, WORKING_COPY_SUFFIX } from '@shared/document/book-path';
import { StudioService } from '../../studio/services/studio.service';
import { ElectronService } from '../../../core/services/electron.service';

/**
 * What a pass run performed HERE came to — `runProcessingRunNow`.
 *
 * Three outcomes and they are genuinely different, so none is folded into
 * another: the planner refused (nothing ran), a pass failed partway (the ones
 * before it really did rewrite the book), or every one of them ran.
 */
export interface DirectPassRunResult {
  success: boolean;
  /** The passes that finished, oldest first, by label. */
  ran: string[];
  /** The pass that failed and why, or null when every one of them ran. */
  failure: { label: string; error: string } | null;
  /** A refusal from the PLANNER — nothing ran, and this says why. */
  error?: string;
  /** What the passes that RAN had to say beyond succeeding, each named by its pass. */
  notes: string[];
}

/** One step, as the engine takes it. Mirrors electron/queue-engine.ts StepSpec. */
interface StepSpec {
  type: JobType;
  label: string;
  config: Record<string, unknown>;
  parentIndex?: number;
  sourceRef?: ArtifactRef;
}

interface AppendStepSpec {
  type: JobType;
  label: string;
  config: Record<string, unknown>;
  parentStepId: string;
  sourceRef?: ArtifactRef;
}

interface QueueBridge {
  list(): Promise<{ success: boolean; data?: QueueSnapshot; error?: string }>;
  enqueue(spec: unknown): Promise<{ success: boolean; data?: EngineJob; error?: string }>;
  appendStep(jobId: string, spec: AppendStepSpec): Promise<{ success: boolean; data?: EngineStep; error?: string }>;
  release(target?: { jobId?: string; stepId?: string }): Promise<{ success: boolean; error?: string }>;
  start(target?: { jobId?: string; stepId?: string }): Promise<{ success: boolean; error?: string }>;
  pause(): Promise<{ success: boolean; error?: string }>;
  cancel(target: { jobId?: string; stepId?: string }, reason?: string): Promise<{ success: boolean; error?: string }>;
  retry(target: { jobId?: string; stepId?: string }): Promise<{ success: boolean; error?: string }>;
  remove(jobId: string): Promise<{ success: boolean; error?: string }>;
  reorder(jobId: string, beforeJobId: string | null): Promise<{ success: boolean; error?: string }>;
  clearFinished(): Promise<{ success: boolean; error?: string }>;
  updateStepConfig(stepId: string, patch: Record<string, unknown>): Promise<{ success: boolean; error?: string }>;
  onChanged(cb: (snapshot: QueueSnapshot) => void): () => void;
  onStepFinished(cb: (event: StepFinishedEvent) => void): () => void;
}

interface StepFinishedEvent {
  jobId: string;
  stepId: string;
  type: JobType;
  label: string;
  projectId?: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  analytics?: { jobId: string; [key: string]: unknown };
}

declare global {
  interface Window {
    electron?: {
      queue?: QueueBridge;
      processing?: {
        runPass: (jobId: string, config: unknown) => Promise<{ success: boolean; data?: unknown; error?: string }>;
      };
      audiobook?: {
        linkAudio?: (projectDir: string, audioPath: string) => Promise<{ success: boolean; error?: string }>;
        appendAnalytics?: (
          projectDir: string, jobType: string, analytics: { jobId: string; [k: string]: unknown },
        ) => Promise<{ success: boolean; error?: string }>;
      };
    };
  }
}

/** The job types whose analytics the project ledger accepts. */
const ANALYTICS_JOB_TYPES: ReadonlySet<string> = new Set([
  'tts-conversion', 'reassembly', 'video-assembly', 'rvc', 'translation',
]);

/**
 * A step's status, in the vocabulary the queue tab was written against.
 *
 * `held` splits: a step that has never run is waiting for Start ('pending'); one
 * that HAS run and was interrupted is 'stopped', which is the state the per-row ▶
 * exists for. That distinction is the whole reason `wasInterrupted` is carried.
 */
function legacyStatus(step: EngineStep): JobStatus {
  switch (step.status) {
    case 'running': return 'processing';
    case 'done': return 'complete';
    case 'failed': return 'error';
    case 'cancelled': return 'error';
    case 'held': return step.wasInterrupted ? 'stopped' : 'pending';
    case 'queued': return 'pending';
    case 'waiting': return 'pending';
    default: return 'pending';
  }
}

function legacyJobStatus(status: StepStatus): JobStatus {
  switch (status) {
    case 'running': return 'processing';
    case 'done': return 'complete';
    case 'failed': case 'cancelled': return 'error';
    default: return 'pending';
  }
}

function asDate(iso: string | undefined): Date | undefined {
  return iso ? new Date(iso) : undefined;
}

/**
 * The file a queue row NAMES, as the user knows that file.
 *
 * An exploded working copy is named as the BOOK it holds: taking the basename
 * verbatim put ".working" in front of the user wherever `epubFilename` is read,
 * and the container a book happens to be kept in read as its format. This is a
 * LABEL and only a label — nothing resolves a path from it.
 */
function jobFileLabel(documentPath: string): string {
  const parts = documentPath.replace(/\\/g, '/').split('/');
  const name = parts[parts.length - 1];
  return isExplodedBookPath(name)
    ? `${name.slice(0, -WORKING_COPY_SUFFIX.length)}.epub`
    : name;
}

/** One engine step → the row the queue tab draws. */
function projectStep(job: EngineJob, step: EngineStep, multi: boolean): QueueJob {
  const m = step.metrics;
  return {
    id: step.id,
    type: step.type,
    epubPath: step.sourceRef?.path ?? job.documentPath,
    epubFilename: job.documentLabel,
    status: legacyStatus(step),
    progress: step.progress.percent,
    stages: step.progress.stages,
    stageDetail: step.progress.detail,
    activeBatch: step.progress.activeBatch,
    error: step.error,
    outputPath: step.outputPath ?? step.output?.path,
    addedAt: new Date(step.addedAt),
    startedAt: asDate(step.startedAt),
    completedAt: asDate(step.finishedAt),
    metadata: { title: step.label },
    projectDir: job.projectId,
    parentJobId: multi ? job.id : undefined,
    workflowId: multi ? job.id : undefined,
    config: step.config as unknown as JobConfig,
    currentChunk: m.currentChunk,
    totalChunks: m.totalChunks,
    currentChapter: m.currentChapter,
    totalChapters: m.totalChapters,
    chunksCompletedInJob: m.chunksCompletedInJob,
    totalChunksInJob: m.totalChunksInJob,
    totalRawSentencesInJob: m.totalRawSentencesInJob,
    totalRawWordsInJob: m.totalRawWordsInJob,
    totalRawCharsInJob: m.totalRawCharsInJob,
    chunkCompletedAt: m.chunkCompletedAt,
    firstChunkCompletedAt: m.firstChunkCompletedAt,
    chunksAtFirstStamp: m.chunksAtFirstStamp,
    progressMessage: step.progress.message,
    cleanupPhase: m.cleanupPhase,
    parallelWorkers: m.parallelWorkers,
    isResumeJob: m.resumeCompletedSentences !== undefined,
    resumeCompletedSentences: m.resumeCompletedSentences,
    resumeMissingSentences: m.resumeMissingSentences,
    chunksDoneInSession: m.chunksDoneInSession,
    rawSentencesDoneInSession: m.rawSentencesDoneInSession,
    rawWordsDoneInSession: m.rawWordsDoneInSession,
    rawCharsDoneInSession: m.rawCharsDoneInSession,
    audioSecondsPerChar: m.audioSecondsPerChar,
    copyrightIssuesDetected: m.copyrightIssuesDetected,
    copyrightChunksAffected: m.copyrightChunksAffected,
    contentSkipsDetected: m.contentSkipsDetected,
    contentSkipsAffected: m.contentSkipsAffected,
    translationFailedChunks: m.translationFailedChunks,
    skippedChunksPath: m.skippedChunksPath,
    bfpPath: job.projectId,
    analytics: step.analytics,
    ttsPhase: m.ttsPhase,
    ttsConversionProgress: m.ttsConversionProgress,
    assemblyProgress: m.assemblyProgress,
    assemblySubPhase: m.assemblySubPhase,
    wasInterrupted: step.wasInterrupted,
    orpheusMemoryLevel: m.orpheusMemoryLevel,
    completionNotes: step.completionNotes,
  };
}

/**
 * The engine's runs → the flat master/child list the tab draws.
 *
 * A run with one step is ONE row and has no master: a master with a single child
 * is a container around nothing, which is what the retired 'audiobook' job type
 * was and why it is now a row the migration explicitly fails with a sentence.
 */
function projectJobs(jobs: EngineJob[]): QueueJob[] {
  const rows: QueueJob[] = [];
  for (const job of jobs) {
    const multi = job.steps.length > 1;
    if (multi) {
      rows.push({
        id: job.id,
        type: 'audiobook',
        epubPath: job.documentPath,
        epubFilename: job.documentLabel,
        status: legacyJobStatus(jobStatus(job)),
        progress: jobPercent(job),
        addedAt: new Date(job.createdAt),
        startedAt: asDate(job.startedAt),
        completedAt: asDate(job.finishedAt),
        metadata: { title: job.title },
        projectDir: job.projectId,
        bfpPath: job.projectId,
        workflowId: job.id,
        config: { type: 'audiobook' },
      });
    }
    for (const step of job.steps) rows.push(projectStep(job, step, multi));
  }
  return rows;
}

@Injectable({ providedIn: 'root' })
export class QueueService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly ngZone = inject(NgZone);
  private readonly studioService = inject(StudioService);
  private readonly electron = inject(ElectronService);

  private readonly _snapshot = signal<QueueSnapshot>({ jobs: [], running: false });

  /** The queue as the tab reads it: master rows and their steps, in order. */
  readonly jobs = computed(() => projectJobs(this._snapshot().jobs));
  readonly isRunning = computed(() => this._snapshot().running);

  readonly currentJob = computed(() =>
    this.jobs().find(j => j.status === 'processing' && j.type !== 'audiobook') ?? null);

  readonly pendingJobs = computed(() => this.jobs().filter(j => j.status === 'pending'));

  getChildJobs(masterJobId: string): QueueJob[] {
    return this.jobs().filter(j => j.parentJobId === masterJobId);
  }

  /**
   * Runs COMPOSED here that the engine has not been told about yet.
   *
   * `addJob` is called once for the master and once per child — the narration
   * modal and the LL wizard both do this — and the engine will not take a run
   * with no steps, because a run with no steps has no status to read. So a master
   * `addJob` opens a composition and returns a row with a local id; the first
   * child creates the real job; every later child appends to it. The local id is
   * swapped for the engine's the moment there is one, so a caller holding the
   * master's id can still address the run.
   */
  private readonly compositions = new Map<string, { jobId?: string; lastStepId?: string; spec: CreateJobRequest }>();

  constructor() {
    void this.seed();

    const bridge = window.electron?.queue;
    if (bridge) {
      const stopChanged = bridge.onChanged((snapshot) => {
        this.ngZone.run(() => this._snapshot.set(snapshot));
      });
      const stopFinished = bridge.onStepFinished((event) => {
        this.ngZone.run(() => { void this.onStepFinished(event); });
      });
      this.destroyRef.onDestroy(() => { stopChanged(); stopFinished(); });
    }
  }

  private async seed(): Promise<void> {
    const bridge = window.electron?.queue;
    if (!bridge) return;
    const result = await bridge.list();
    if (result.success && result.data) this._snapshot.set(result.data);
  }

  private requireBridge(): QueueBridge {
    const bridge = window.electron?.queue;
    if (!bridge) {
      throw new Error('The queue lives in the BookForge desktop app, which is not running here.');
    }
    return bridge;
  }

  /** Main's own refusal, said out loud. Never swallowed into a silent no-op. */
  private static settle(result: { success: boolean; error?: string }, what: string): void {
    if (!result?.success) throw new Error(result?.error || `${what} failed and gave no reason.`);
  }

  // ── Post-completion effects ───────────────────────────────────────────────
  //
  // Filing the audio against the project, recording its analytics and reloading
  // the shelf are LIBRARY acts, and the handlers that perform them
  // (`audiobook:link-audio`, `audiobook:append-analytics`) are the ones every
  // other library surface calls. They hang off the engine's step-finished event
  // rather than off a diff of two snapshots, so they happen exactly once.

  private async onStepFinished(event: StepFinishedEvent): Promise<void> {
    if (!event.success || !event.projectId) return;
    const electron = window.electron;

    if (event.analytics && ANALYTICS_JOB_TYPES.has(event.type)) {
      try {
        await electron?.audiobook?.appendAnalytics?.(
          event.projectId, event.type, event.analytics);
      } catch (err) {
        console.error('[QUEUE] Could not record this run in the project ledger:', err);
      }
    }

    if (event.outputPath?.endsWith('.m4b')) {
      try {
        await electron?.audiobook?.linkAudio?.(event.projectId, event.outputPath);
      } catch (err) {
        console.error('[QUEUE] Could not link the finished audio to its project:', err);
      }
      try {
        await this.studioService.reloadItem(event.projectId);
      } catch (err) {
        console.error('[QUEUE] Could not refresh the shelf after the audio landed:', err);
      }
    }
  }

  // ── Composition ───────────────────────────────────────────────────────────

  /**
   * Add a job. The shape callers already speak, translated into the engine's.
   *
   * A `type: 'audiobook'` request is a CONTAINER and always was: it ran nothing,
   * it existed to group the rows under it. It opens a composition here and
   * queues nothing, which is why the retired-type table now fails one that is
   * found in an old queue file.
   */
  async addJob(request: CreateJobRequest): Promise<QueueJob> {
    if (request.type === 'audiobook') {
      const token = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      this.compositions.set(token, { spec: request });
      return {
        id: token,
        type: 'audiobook',
        epubPath: request.epubPath,
        epubFilename: request.epubPath ? jobFileLabel(request.epubPath) : undefined,
        status: 'pending',
        addedAt: new Date(),
        metadata: request.metadata,
        workflowId: token,
        bfpPath: request.bfpPath,
        projectDir: request.projectDir,
      };
    }

    const bridge = this.requireBridge();
    const config = this.buildJobConfig(request);
    const label = request.metadata?.title ?? request.type;
    const sourceRef: ArtifactRef = {
      kind: 'epub',
      path: request.epubPath,
    };

    const parentToken = request.parentJobId;
    const composition = parentToken ? this.compositions.get(parentToken) : undefined;

    if (composition) {
      if (!composition.jobId) {
        const master = composition.spec;
        const created = await bridge.enqueue({
          title: master.metadata?.title ?? label,
          projectId: master.bfpPath ?? master.projectDir ?? request.bfpPath ?? request.projectDir,
          documentPath: master.epubPath ?? request.epubPath,
          documentLabel: (master.epubPath ?? request.epubPath)
            ? jobFileLabel((master.epubPath ?? request.epubPath)!) : undefined,
          steps: [{ type: request.type, label, config, sourceRef } as StepSpec],
        });
        QueueService.settle(created, 'Queueing this run');
        composition.jobId = created.data!.id;
        composition.lastStepId = created.data!.steps[0].id;
        return this.rowFor(created.data!.steps[0].id) ?? projectStep(created.data!, created.data!.steps[0], false);
      }
      const appended = await bridge.appendStep(composition.jobId, {
        type: request.type,
        label,
        config,
        parentStepId: composition.lastStepId ?? SOURCE_PARENT,
        ...(composition.lastStepId ? {} : { sourceRef }),
      });
      QueueService.settle(appended, `Adding ${label} to this run`);
      composition.lastStepId = appended.data!.id;
      return this.rowFor(appended.data!.id) ?? this.stubRow(appended.data!, request);
    }

    // A row of its own. `parentJobId` naming a run the engine already knows is
    // an append onto that run's last step — that is what chaining onto work
    // which has not run yet MEANS, and it is a first-class act now.
    if (parentToken) {
      const parentJob = this._snapshot().jobs.find(j => j.id === parentToken);
      if (parentJob) {
        const last = parentJob.steps[parentJob.steps.length - 1];
        const appended = await bridge.appendStep(parentJob.id, {
          type: request.type,
          label,
          config,
          parentStepId: last ? last.id : SOURCE_PARENT,
          ...(last ? {} : { sourceRef }),
        });
        QueueService.settle(appended, `Adding ${label} to this run`);
        return this.rowFor(appended.data!.id) ?? this.stubRow(appended.data!, request);
      }
    }

    const created = await bridge.enqueue({
      title: label,
      projectId: request.bfpPath ?? request.projectDir,
      documentPath: request.epubPath,
      documentLabel: request.epubPath ? jobFileLabel(request.epubPath) : undefined,
      steps: [{ type: request.type, label, config, sourceRef } as StepSpec],
    });
    QueueService.settle(created, 'Queueing this job');
    return this.rowFor(created.data!.steps[0].id)
      ?? projectStep(created.data!, created.data!.steps[0], false);
  }

  /** The mirrored row for a step id, once `queue:changed` has landed. */
  private rowFor(stepId: string): QueueJob | undefined {
    return this.jobs().find(j => j.id === stepId);
  }

  /** The row as the engine just described it, for the beat before the push lands. */
  private stubRow(step: EngineStep, request: CreateJobRequest): QueueJob {
    return {
      id: step.id,
      type: step.type,
      epubPath: request.epubPath,
      status: 'pending',
      addedAt: new Date(step.addedAt),
      metadata: request.metadata,
      config: step.config as unknown as JobConfig,
      bfpPath: request.bfpPath,
      projectDir: request.projectDir,
    };
  }

  /**
   * The config a job runs with, validated at the door.
   *
   * A pass config is passed through UNTOUCHED: it came from planProcessingChain,
   * which is the only thing allowed to decide what a pass does, and a config
   * re-derived here could disagree with the plan the user was shown.
   */
  private buildJobConfig(request: CreateJobRequest): Record<string, unknown> {
    if (PASS_JOB_TYPES.has(request.type)) {
      const config = request.config as ProcessingPassJobConfig | undefined;
      if (!config?.kind || !config.projectDir || !config.stageRelDir) {
        throw new Error(
          `A ${request.type} job was created without a planned config. Pass jobs come from `
          + 'processing:submit-chain; nothing else may build one.',
        );
      }
      return { ...config, type: request.type } as unknown as Record<string, unknown>;
    }

    if (request.type === 'vlm-convert') {
      const built = buildConversionConfig(request.config as Partial<VlmConvertJobConfig>);
      if (!built) {
        throw new Error(
          'This conversion request does not say which book it is for, so the queue would show a '
          + 'row nobody can identify.',
        );
      }
      return built as unknown as Record<string, unknown>;
    }

    const config = { ...(request.config ?? {}) } as Record<string, unknown>;
    config['type'] = request.type;
    // Where a job is filed and what its finished file is called travel WITH the
    // config now: main has no `job.metadata` to consult, and a step module that
    // re-derived either would be inventing a path.
    if (request.bfpPath) config['bfpPath'] = request.bfpPath;
    if (request.metadata) config['metadata'] = request.metadata;

    if (request.resumeInfo && request.type === 'tts-conversion') {
      const tts = config as unknown as TtsConversionConfig;
      tts.resumeInfo = {
        sessionId: request.resumeInfo.sessionId!,
        sessionDir: request.resumeInfo.sessionDir!,
        processDir: request.resumeInfo.processDir!,
        totalSentences: request.resumeInfo.totalSentences!,
        totalChapters: request.resumeInfo.totalChapters!,
        chapters: request.resumeInfo.chapters ?? [],
        language: tts.language,
        voice: tts.fineTuned,
        ttsEngine: tts.ttsEngine,
        createdAt: new Date().toISOString(),
      };
      config['missingRanges'] = request.resumeInfo.missingRanges;
    }
    return config;
  }

  /** Patch a step's config before it runs — the one door the details panel uses. */
  async updateJobConfig(jobId: string, configUpdate: Record<string, unknown>): Promise<void> {
    const result = await this.requireBridge().updateStepConfig(jobId, configUpdate);
    QueueService.settle(result, 'Changing this row\'s settings');
  }

  // ── Control ───────────────────────────────────────────────────────────────

  async startQueue(): Promise<void> {
    QueueService.settle(await this.requireBridge().start(), 'Starting the queue');
  }

  async pauseQueue(): Promise<void> {
    QueueService.settle(await this.requireBridge().pause(), 'Pausing the queue');
  }

  /**
   * Stop the queue AND what it is running.
   *
   * Pause alone leaves the current run going, which is right for "let this finish
   * and stop after it". Stop is the other gesture: you are taking the GPU back.
   */
  async stopQueue(): Promise<void> {
    const bridge = this.requireBridge();
    QueueService.settle(await bridge.pause(), 'Pausing the queue');
    for (const row of this.jobs()) {
      if (row.status !== 'processing' || row.type === 'audiobook') continue;
      QueueService.settle(await bridge.cancel({ stepId: row.id }), `Stopping ${row.metadata?.title ?? row.type}`);
    }
  }

  /** Resume ONE stopped row — the per-row ▶, which is the explicit gesture it needs. */
  async resumeStoppedJob(jobId: string): Promise<void> {
    QueueService.settle(await this.requireBridge().start({ stepId: jobId }), 'Resuming this job');
  }

  async cancelJob(jobId: string): Promise<boolean> {
    const target = this.targetFor(jobId);
    QueueService.settle(await this.requireBridge().cancel(target), 'Stopping this job');
    return true;
  }

  async retryJob(jobId: string): Promise<boolean> {
    QueueService.settle(await this.requireBridge().retry(this.targetFor(jobId)), 'Retrying');
    return true;
  }

  async removeJob(jobId: string): Promise<boolean> {
    const jobIdOfRow = this.jobIdOf(jobId);
    if (!jobIdOfRow) return false;
    const target = this.targetFor(jobId);
    if (target.stepId) {
      // Removing ONE step of a multi-step run cancels it; the run itself stays,
      // because the steps beside it are other work the user still wants.
      const run = this._snapshot().jobs.find(j => j.id === jobIdOfRow);
      if (run && run.steps.length > 1) {
        QueueService.settle(await this.requireBridge().cancel(target, 'Removed from the queue.'),
          'Removing this step');
        return true;
      }
    }
    QueueService.settle(await this.requireBridge().remove(jobIdOfRow), 'Removing this run');
    return true;
  }

  /**
   * Run one row NOW.
   *
   * It used to mean "start this beside the queue, in its own lane". With one GPU
   * slot that was never true of GPU work — two e2a worker sets on one card is
   * two runs each taking twice as long — so it now means RELEASE this row and
   * start the queue: it goes first among what is runnable, and shares the same
   * slot rules as everything else.
   */
  async runJobStandalone(jobId: string): Promise<boolean> {
    QueueService.settle(await this.requireBridge().start(this.targetFor(jobId)), 'Running this job');
    return true;
  }

  async clearCompleted(): Promise<void> {
    QueueService.settle(await this.requireBridge().clearFinished(), 'Clearing finished runs');
  }

  async clearAll(): Promise<void> {
    const bridge = this.requireBridge();
    QueueService.settle(await bridge.pause(), 'Pausing the queue');
    for (const run of [...this._snapshot().jobs]) {
      QueueService.settle(await bridge.remove(run.id), 'Removing a run');
    }
  }

  /** Drag-and-drop, at RUN level: a step's position inside its run is its lineage. */
  async reorderJobsById(fromId: string, toId: string): Promise<boolean> {
    const from = this.jobIdOf(fromId);
    const to = this.jobIdOf(toId);
    if (!from || !to || from === to) return false;
    QueueService.settle(await this.requireBridge().reorder(from, to), 'Reordering the queue');
    return true;
  }

  /** Re-read the truth. Cheap, and the answer is always current — main holds it. */
  async refreshFromBackend(): Promise<void> {
    await this.seed();
  }

  /** Which run a row belongs to, whether the row is a master or a step. */
  private jobIdOf(rowId: string): string | undefined {
    for (const job of this._snapshot().jobs) {
      if (job.id === rowId) return job.id;
      if (job.steps.some(s => s.id === rowId)) return job.id;
    }
    return undefined;
  }

  private targetFor(rowId: string): { jobId?: string; stepId?: string } {
    const isRun = this._snapshot().jobs.some(j => j.id === rowId);
    return isRun ? { jobId: rowId } : { stepId: rowId };
  }

  // ── Processing runs ───────────────────────────────────────────────────────

  /**
   * THE way to queue a pass run from the UI: main plans and validates it, and
   * `followOn` — narrate, enhance, assemble — is queued behind it in the same
   * run, chained to the last pass.
   *
   * The follow-on jobs must be fully built BEFORE this is called: anything that
   * can fail while building them (a resume check, a missing voice) has to fail
   * with nothing queued, not halfway through a run.
   */
  async submitProcessingRun(
    request: ProcessingChainRequest,
    followOn: CreateJobRequest[] = [],
  ): Promise<{ success: boolean; plan?: ProcessingChainPlan; error?: string }> {
    const specs: StepSpec[] = followOn.map(job => ({
      type: job.type,
      label: job.metadata?.title ?? job.type,
      config: this.buildJobConfig(job),
    }));
    return this.electron.submitProcessingChain(request, specs);
  }

  /**
   * Run a pass chain NOW, in place, without a queue row.
   *
   * NOT a second implementation of a pass. It plans through the SAME planner and
   * runs each planned job through the SAME main-process handler the step module
   * invokes, with the same config object. A synchronous re-implementation of a
   * pass is exactly what was deleted on 2026-08-10, and this must never become
   * one.
   *
   * In ORDER, stopping at the first failure: each pass rewrites the book the next
   * one reads, so continuing would apply pass three to text pass two failed to
   * produce. What ran is reported with what did not.
   */
  async runProcessingRunNow(request: ProcessingChainRequest): Promise<DirectPassRunResult> {
    const processing = window.electron?.processing;
    if (!processing?.runPass) {
      throw new Error('Processing passes are not available (no Electron bridge)');
    }
    const planned = await this.electron.planProcessingChain(request);
    if (!planned.success || !planned.plan) {
      return { success: false, ran: [], failure: null, notes: [], error: planned.error };
    }

    const ran: string[] = [];
    const notes: string[] = [];
    for (const job of planned.plan.jobs) {
      const jobId = `direct-${Date.now()}-${ran.length}`;
      const result = await processing.runPass(jobId, job.config);
      const data = (result?.data ?? null) as PassJobResult | null;
      const ok = data?.success ?? result?.success ?? false;
      for (const note of passResultNotes(data ?? undefined)) notes.push(`${job.label}: ${note}`);
      if (!ok) {
        return {
          success: false,
          ran,
          notes,
          failure: {
            label: job.label,
            error: data?.error || result?.error || `${job.label} failed and gave no reason.`,
          },
        };
      }
      ran.push(job.label);
    }
    return { success: true, ran, failure: null, notes };
  }
}
