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
  resource: () => 'gpu',

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
