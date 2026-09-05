/**
 * Every job type this build can run, registered with the engine.
 *
 * The engine holds no list of its own — a module claims a type by registering,
 * and a type nobody claims is a step the engine refuses to schedule BY NAME
 * rather than one it silently steps over. That is what lets the keeper suite
 * drive the real scheduler with three fakes and no Electron.
 */
import { registerStepModule } from '../queue-engine';

import { alignStep } from './align';
import { bookAnalysisStep } from './book-analysis';
import { finalDenoiseStep } from './final-denoise';
import { generateSentencesStep } from './generate-sentences';
import { foundryJobStep } from './foundry-job';
import {
  footnoteRefsStep, narrationTextStep, simplifyStep, translatePassStep,
} from './pass';
import { reassemblyStep } from './reassembly';
import { rvcEnhancementStep } from './rvc-enhancement';
import { translationStep } from './translation';
import { ttsConversionStep } from './tts-conversion';
import { videoAssemblyStep } from './video-assembly';
import { vlmConvertStep } from './vlm-convert';

let registered = false;

export function registerAllStepModules(): void {
  if (registered) return;
  registered = true;
  for (const mod of [
    ttsConversionStep,
    alignStep,
    finalDenoiseStep,
    rvcEnhancementStep,
    reassemblyStep,
    translationStep,
    bookAnalysisStep,
    generateSentencesStep,
    videoAssemblyStep,
    vlmConvertStep,
    foundryJobStep,
    simplifyStep,
    translatePassStep,
    footnoteRefsStep,
    narrationTextStep,
  ]) {
    registerStepModule(mod);
  }
}

export { setQueueMainWindow } from './runtime';
