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
export function stagesFor(job: QueueJob): JobStageProgress[] {
  switch (job.type) {
    // Bridge-reported. The bridge knows which optional passes this run performed;
    // an empty result means it hasn't reported yet, and inventing bars would be a lie.
    case 'generate-sentences':
    case 'reassembly':
      return job.stages ?? [];

    // The OCR unit is one job over several foundry stages — render the pages,
    // read them with Tesseract, repair the text, label the blocks — and MAIN
    // reports which of them this run is on, with that stage's own unit (pages,
    // lines, blocks). A stage the run skipped because the book already had it is
    // reported complete, which is what verifying and skipping it is.
    case 'foundry-ocr-correct':
      return job.stages ?? [];

    // Bridge-reported when available (parallel-tts-bridge knows the model-load
    // boundary and, on Mac/MLX, reads completions off disk a batch earlier than
    // stdout reports them); the phase-derived list covers the first tick and any
    // session restored from disk before the bridge has spoken.
    case 'tts-conversion':
      return job.stages ?? deriveTtsStages(job);

    case 'bilingual-assembly':
      return deriveBilingualAssemblyStages(job);

    default:
      return [];
  }
}
