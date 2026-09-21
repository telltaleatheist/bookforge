/**
 * What stage bars does a given job show?
 *
 * Two sources, never mixed:
 *
 *  - Bridge-supplied (`job.stages`). generate-sentences and reassembly report a real
 *    per-run stage list over IPC, including which optional passes they actually ran.
 *    Nothing here second-guesses it: no stages reported means no bars, not invented ones.
 *
 *  - Derived. TTS and bilingual-assembly predate the stage model and report their
 *    phases as separate scalar fields. Those fields ARE a stage list, just spelled
 *    differently, so they're translated here — once — instead of every template
 *    growing its own copy of the phase logic.
 *
 * The switch is exhaustive by job type on purpose. A job type that has neither
 * bridge stages nor a derivation gets an empty list and renders its single overall
 * bar, which is the honest answer rather than a fabricated breakdown.
 */

import { JobStageProgress, JobStageStatus, QueueJob } from './queue.types';

/** Percentage bands each bilingual-assembly sub-phase occupies in the job's overall %. */
const BILINGUAL_ASSEMBLY_BANDS: ReadonlyArray<{ name: string; label: string; start: number; end: number }> = [
  { name: 'combining', label: 'Combining audio', start: 0, end: 70 },
  { name: 'vtt', label: 'Building subtitles', start: 70, end: 85 },
  { name: 'encoding', label: 'Encoding M4B', start: 85, end: 95 },
  { name: 'metadata', label: 'Writing metadata', start: 95, end: 100 },
];

/** Stage status from a fraction: 0 hasn't started, 100 is done, between is running. */
function statusFor(pct: number): JobStageStatus {
  if (pct >= 100) return 'complete';
  return pct > 0 ? 'running' : 'pending';
}

function clampPct(pct: number | undefined): number {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

/**
 * FALLBACK for a TTS job whose bridge hasn't reported stages yet — the first tick of
 * a run, or a session restored from disk after a restart. parallel-tts-bridge now
 * sends a real four-stage list (see buildTtsStages), which `stagesFor` prefers.
 *
 * This derivation can't do better than three bars because `ttsPhase` alone can't see
 * the difference between "loading 6.9 GB of weights" and "converting": both report
 * phase 'converting' from the moment a worker spawns, which is exactly why Preparing
 * used to flip to 100% while the genuinely slow part sat at 0%.
 *
 * Assembly is skipped entirely in dual-voice bilingual workflows (a separate
 * bilingual-assembly job does it), so that bar is omitted rather than left at 0.
 */
function deriveTtsStages(job: QueueJob): JobStageProgress[] {
  if (!job.ttsPhase) return [];

  const skipAssembly = (job.config as { skipAssembly?: boolean } | undefined)?.skipAssembly === true;
  const pastPreparing = job.ttsPhase !== 'preparing';
  const convertPct = clampPct(job.ttsConversionProgress);

  const stages: JobStageProgress[] = [
    {
      name: 'preparing',
      label: 'Preparing session',
      pct: pastPreparing ? 100 : 0,
      status: pastPreparing ? 'complete' : 'running',
    },
    {
      name: 'converting',
      label: 'Converting sentences',
      pct: convertPct,
      status: job.ttsPhase === 'converting' ? 'running' : statusFor(convertPct),
    },
  ];

  if (!skipAssembly) {
    const assemblyPct = clampPct(job.assemblyProgress);
    stages.push({
      name: 'assembling',
      label: 'Assembling audiobook',
      pct: assemblyPct,
      status: job.ttsPhase === 'assembling' ? 'running' : statusFor(assemblyPct),
    });
  }

  return stages;
}

/**
 * bilingual-assembly reports one overall percentage plus the sub-phase it's in.
 * Each sub-phase owns a fixed band of that percentage, so the job's overall % maps
 * back onto per-stage fractions.
 */
function deriveBilingualAssemblyStages(job: QueueJob): JobStageProgress[] {
  const overall = clampPct(job.progress);
  const done = job.status === 'complete';

  return BILINGUAL_ASSEMBLY_BANDS.map(band => {
    if (done || overall >= band.end) {
      return { name: band.name, label: band.label, pct: 100, status: 'complete' as JobStageStatus };
    }
    if (overall <= band.start) {
      return { name: band.name, label: band.label, pct: 0, status: 'pending' as JobStageStatus };
    }
    const pct = ((overall - band.start) / (band.end - band.start)) * 100;
    return { name: band.name, label: band.label, pct, status: 'running' as JobStageStatus };
  });
}

/** The stage bars to render under a job's own progress bar. Empty = no breakdown. */
/**
 * The noun the throughput readouts name a unit of work by — "page" for a page
 * read (a dots convert, or a hosted Foundry render/read), "chunk" for everything
 * else (TTS chunks, translate blocks). A convert's chunk IS a page, so calling it
 * a chunk read right but landed in the wrong vocabulary; this is the one place
 * that decides which word the lane, the rate and the count all use.
 */
export function readUnitNoun(job: QueueJob | null | undefined): 'page' | 'chunk' {
  if (!job) return 'chunk';
  if (job.type === 'vlm-convert') return 'page';
  if (job.type === 'foundry-job' && (job.foundryPhase === 'read' || job.foundryPhase === 'render')) {
    return 'page';
  }
  return 'chunk';
}

export function stagesFor(job: QueueJob): JobStageProgress[] {
  switch (job.type) {
    // Bridge-reported. The bridge knows which optional passes this run performed;
    // an empty result means it hasn't reported yet, and inventing bars would be a lie.
    case 'generate-sentences':
    case 'reassembly':
      return job.stages ?? [];

    // Two passes over the book on the endpoint route — every page drawn with
    // PyMuPDF, then every picture posted to the model, at rates an order of
    // magnitude apart. The MLX route reads each page as it draws it and reports
    // NO stages, which renders as the single overall bar: one phase, one bar.
    case 'vlm-convert':
      return job.stages ?? [];

    // Two passes over one book on the Crucible route — the server places every
    // word, then this machine measures the book from the items it placed, at
    // rates a factor apart (`electron/queue-steps/align.ts`). Bridge-reported:
    // a legacy local align is ONE pass, reports no stages, and renders as the
    // single overall bar.
    case 'align':
      return job.stages ?? [];

    // Hosted Foundry work (`foundry-job`). A conversion on the endpoint route
    // reports a render bar and a read bar (see `queue-steps/foundry-job.ts`); a
    // single-phase act (translate / clean / analyze) reports none and renders as
    // the single overall bar. Bridge-reported either way — an empty result is
    // "not yet", never an invented breakdown.
    case 'foundry-job':
      return job.stages ?? [];

    // Bridge-reported when available (parallel-tts-bridge knows the model-load
    // boundary and, on Mac/MLX, reads completions off disk a batch earlier than
    // stdout reports them); the phase-derived list covers the first tick and any
    // session restored from disk before the bridge has spoken.
    case 'tts-conversion':
      return job.stages ?? deriveTtsStages(job);

    /*
     * ONE ACT, ONE BAR. The prepare row is narrator's prep and nothing else:
     * extract, split, pack. It has no phases to break down — the number
     * normalization inside it reports its own `prep` sub-bar, which the row
     * draws separately — and the step module deliberately does NOT forward the
     * bridge's stage list, because that list describes the whole RENDER and
     * three of its four bars would sit at 0 % under a row that never reaches
     * them (`electron/queue-steps/prepare.ts`).
     *
     * Listed rather than left to `default`, so the decision is written down
     * where somebody adding bars would look for it.
     */
    case 'prepare':
      return [];

    case 'bilingual-assembly':
      return deriveBilingualAssemblyStages(job);

    default:
      return [];
  }
}
