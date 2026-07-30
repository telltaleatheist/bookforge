/**
 * dagger-server — runs the footnote-marker remover on the BUNDLED llama-server.
 *
 * Same machinery as the page-layout model (see llama-model-server.ts): the raw
 * /completion endpoint so the prompt arrives VERBATIM, spawn on first use, idle
 * shutdown, and a distinct GPU arbiter identity so the two fine-tunes are
 * sequenced instead of both trying to sit on the device.
 *
 * Its own PORT, because "both may run" is not theoretical here — a book can be
 * detected and cleaned in the same sitting, and two llama-servers on one port
 * means the second binds nothing and the first answers with the wrong model's
 * weights, which is far worse than a startup error.
 */
import * as fs from 'fs';

import { daggerModelPath, isDaggerModelPresent, getDaggerModelDef } from './dagger-models';
import { LlamaModelServer, type LlamaGenerateResult } from './llama-model-server';

/** Owner label for the arbiter — distinct from llama:cleanup and llama:rubric. */
export const GPU_OWNER_DAGGER = 'llama:dagger';

/**
 * 2048. The longest example in the training corpus measured 442 tokens end to
 * end, and dagger's answer is its input minus a handful of characters, so a
 * request is bounded at roughly twice the passage. Anything larger is KV cache
 * bought for context nothing sends. RE-MEASURE if the passage size the caller
 * chunks to ever grows.
 */
const CONTEXT = 2048;

/** Distinct from llama-bridge's and rubric's — all three can want to be up. */
const PORT = 8770;

/**
 * VRAM for full offload: ~1.2 GB of f16 weights plus a small KV cache at 2k,
 * rounded up for compute buffers. Under this, run on CPU rather than fail to
 * allocate — a 0.6B model on CPU is slow but perfectly usable.
 */
const NEEDED_VRAM_MB = 2048;

export type DaggerGenerateResult = LlamaGenerateResult;

export const daggerServer = new LlamaModelServer({
  logTag: 'dagger',
  modelLabel: 'footnote-marker model',
  port: PORT,
  contextSize: CONTEXT,
  neededVramMB: NEEDED_VRAM_MB,
  gpuOwner: GPU_OWNER_DAGGER,
  // The answer is the passage back; the context is the real ceiling.
  maxPredict: 1024,
  // Unlike rubric, this one does not wait forever for the GPU. At 1.2 GB it can
  // co-reside with almost anything, so blocking cleanup behind another tenant's
  // five-minute idle timer would cost more than the placement is worth. The
  // arbiter's timeout path proceeds without the lock and logs that it did.
  gpuAcquireTimeoutMs: 60_000,
  resolveModel: (modelId) => {
    const def = getDaggerModelDef(modelId);
    if (!def) return null;
    return {
      name: def.name,
      path: daggerModelPath(modelId),
      present: isDaggerModelPresent(modelId),
    };
  },
});

/** Stop the server — for quit, and for deleting the model it has open. */
export async function stopDaggerServer(): Promise<void> {
  await daggerServer.stop();
}

/** Whether a GGUF for `modelId` is on disk (re-exported for the IPC layer). */
export function daggerModelInstalled(modelId: string): boolean {
  try {
    return isDaggerModelPresent(modelId) && fs.existsSync(daggerModelPath(modelId));
  } catch {
    return false;
  }
}
