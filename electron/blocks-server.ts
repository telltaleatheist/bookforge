/**
 * blocks-server — runs the block-category model on the BUNDLED llama-server.
 *
 * The Detect path used to require Ollama: the user had to install it, then
 * `ollama create` the model from a Modelfile by hand. That is not a thing to ask
 * of someone who wants to make an audiobook, and it meant the model could not be
 * shipped as a download. llama-server already comes with the app for local AI
 * cleanup, so pointing a second instance at the blocks GGUF removes the external
 * dependency entirely.
 *
 * The lifecycle — spawn on first use, idle-shutdown, GPU arbitration, and the
 * raw /completion contract that keeps the prompt VERBATIM — lives in
 * llama-model-server.ts. What is blocks's own is here: which catalog it reads,
 * how much context a page needs, and its arbiter identity.
 *
 * The GGUF itself is FOUNDRY'S — same file, same directory, same download (see
 * blocks-models.ts). This server is BookForge's own llama-server instance over
 * it, because Detect drives the model page by page from the editor and needs it
 * resident between pages; `foundry blocks` spawns its own for a batch run.
 */
import * as fs from 'fs';

import { blocksModelPath, isBlocksModelPresent, getBlocksModelDef } from './blocks-models';
import { LlamaModelServer, type LlamaGenerateResult } from './llama-model-server';

/** Owner label for the arbiter — distinct from llama:cleanup, same device. */
export const GPU_OWNER_BLOCKS = 'llama:blocks';

/**
 * 12288, explicitly, and it is sized against the CORPUS, not guessed.
 *
 * This was 8192 when the longest real page measured 6,529 tokens. v4's
 * split-only segmentation cuts dense pages far finer — the longest page now
 * measures 10,404 tokens (measured with the real Qwen3 tokenizer over the whole
 * v4 SFT corpus), plus roughly 400 for the answer. At 8192 those pages were
 * silently truncated before the model ever saw them, and truncation lands on the
 * END of the block list, so the model simply stops answering for blocks it was
 * never shown. That reads as "the new model dropped blocks" rather than "the
 * server cut the prompt", which is the wrong place to go looking.
 *
 * Still not left to the model's own 40960: the KV cache would be several times
 * larger for context nothing uses. RE-MEASURE THIS WHENEVER SEGMENTATION
 * CHANGES — it is a property of how finely pages get cut, not of the model.
 */
const CONTEXT = 12288;

/** Port for the blocks server. Distinct from llama-bridge's, since both may run. */
const PORT = 8769;

/**
 * VRAM needed for full offload: ~2.4 GB of Q4_K_M weights plus a ~1.1 GB KV
 * cache at 8k, rounded up for the compute buffers. Under this, run on CPU
 * rather than fail to allocate. See computeNgl.
 *
 * STALE AGAINST THE SHIPPING WEIGHTS AND KNOWN TO BE — the catalog's one entry is
 * an f16 checkpoint at 8.05 GB, not a 2.4 GB Q4_K_M, so this threshold lets the
 * model attempt a full offload on cards that cannot hold it. It has been left at
 * the measured number rather than raised on arithmetic: what the right value is
 * depends on how llama.cpp splits the layers, and changing it silently moves
 * users between GPU and CPU. Re-measure before touching it.
 */
const NEEDED_VRAM_MB = 4608;

export type BlocksGenerateResult = LlamaGenerateResult;

export const blocksServer = new LlamaModelServer({
  logTag: 'blocks',
  modelLabel: 'page-layout model',
  port: PORT,
  contextSize: CONTEXT,
  neededVramMB: NEEDED_VRAM_MB,
  gpuOwner: GPU_OWNER_BLOCKS,
  // A page is a few hundred tokens of answer; this is a runaway backstop.
  maxPredict: 2048,
  resolveModel: (modelId) => {
    const def = getBlocksModelDef(modelId);
    if (!def) return null;
    return {
      name: def.name,
      path: blocksModelPath(modelId),
      present: isBlocksModelPresent(modelId),
    };
  },
});

/** Stop the server — for quit, and for deleting the model it has open. */
export async function stopBlocksServer(): Promise<void> {
  await blocksServer.stop();
}

/** Whether a GGUF for `modelId` is on disk (re-exported for the IPC layer). */
export function blocksModelInstalled(modelId: string): boolean {
  try {
    return isBlocksModelPresent(modelId) && fs.existsSync(blocksModelPath(modelId));
  } catch {
    return false;
  }
}
