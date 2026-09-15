/**
 * video-assembly — render a subtitle video from the finished audiobook.
 *
 * It carries no m4bPath/vttPath, deliberately: this step is queued BEHIND the
 * assembly that produces those files, so at queue time they do not exist and
 * cannot be verified. `resolveOutputPaths` finds both under the project's output
 * directory at RUN time and names that directory when they are not there — which
 * is why the renderer's old habit of inventing `${bfpPath}/output/audiobook.m4b`
 * was wrong for the monolingual pipeline, where the assembler writes "{title}.m4b".
 */
import { onBridgeEvent, waitForBridgeEvent } from '../bridge-events';
import { cancelVideoAssembly, startVideoAssembly } from '../video-assembly-bridge';
import type { StepModule, StepRunContext } from '../queue-engine';
import type { ArtifactRef } from '../../shared/queue/engine-types';
import { queueMainWindow } from './runtime';

interface VideoProgressEvent {
  jobId: string; phase: string; percentage: number; message: string;
}
interface VideoCompleteEvent {
  jobId: string; success: boolean; outputPath?: string; error?: string;
}

interface VideoStepConfig {
  projectId: string;
  bfpPath: string;
  mode: 'bilingual' | 'monolingual';
  sentencePairsPath?: string;
  title: string;
  sourceLang: string;
  targetLang?: string;
  resolution: '480p' | '720p' | '1080p';
  outputFilename?: string;
}

export const videoAssemblyStep: StepModule = {
  type: 'video-assembly',
  consumes: null,
  produces: 'video',
  /**
   * CPU — AND THIS IS THE COMMENT THAT WAS MISSING.
   *
   * It said `gpu` with no reason given since before the slot sets existed, which
   * charged it to the legacy local-narrator set (`shared/queue/slot-sets.ts`):
   * a video mux waited for the 3090 Ti, and a render waited behind a video mux.
   * Measured end to end 2026-09-15 (`electron/video-assembly-bridge.ts`):
   *
   *  - frames are drawn in an OFFSCREEN BrowserWindow and read back with
   *    `capturePage()` into PNG buffers on disk — page layout, not a model;
   *  - the mux is `ffmpeg -f concat … -vf scale=…,format=yuv420p -c:v libx264
   *    -preset medium -crf 23 -c:a aac` — a SOFTWARE x264 encode. No NVENC, no
   *    `-hwaccel`, no encoder selection of any kind;
   *  - nothing here loads weights, and no VRAM is held across the run.
   *
   * Owen's boundary is MODEL INFERENCE vs DETERMINISTIC work, not GPU vs CPU —
   * an encoder block would not change this answer either, because an ASIC on the
   * card is not the SM and VRAM a model holds, and drawing subtitles onto frames
   * is never inference. So this is work BookForge does itself, and it charges
   * `local-work` beside assembly and muxing.
   *
   * No `machines()`, and that is now the honest omission rather than a silent
   * one: a CPU step is never sent to a server (`SERVER_CPU_SLOTS` is 0), and
   * Crucible has no job of this shape to send it to.
   */
  resource: () => 'cpu',

  async run(ctx: StepRunContext): Promise<ArtifactRef> {
    const config = ctx.step.config as unknown as VideoStepConfig;
    if (!config?.bfpPath) {
      throw new Error('This video row names no project, so it cannot find the audiobook to render.');
    }
    const win = queueMainWindow();
    if (!win) {
      throw new Error(
        'Video rendering draws its frames in a hidden window and BookForge has none open, '
        + 'so it cannot run.',
      );
    }

    const unsubscribe = onBridgeEvent<VideoProgressEvent>('video-assembly:progress', (event) => {
      if (event.jobId !== ctx.stepId) return;
      ctx.report({ percent: event.percentage, message: event.message });
    });
    const finished = waitForBridgeEvent<VideoCompleteEvent>(
      'video-assembly:complete', (e) => e.jobId === ctx.stepId,
    );

    try {
      await startVideoAssembly(ctx.stepId, win, {
        projectId: config.projectId,
        bfpPath: config.bfpPath,
        mode: config.mode,
        sentencePairsPath: config.sentencePairsPath,
        title: config.title,
        sourceLang: config.sourceLang,
        targetLang: config.targetLang,
        resolution: config.resolution,
        outputFilename: config.outputFilename,
      } as never);

      const result = await finished;
      if (!result.success || !result.outputPath) {
        throw new Error(result.error || 'Video rendering failed and gave no reason.');
      }
      return { kind: 'video', path: result.outputPath };
    } finally {
      unsubscribe();
    }
  },

  cancel(stepId: string): void {
    cancelVideoAssembly(stepId);
  },
};
