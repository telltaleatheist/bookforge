/**
 * foundry-interim-config — the ONE place that knows where foundry's weights and
 * (in development) its binary live on this machine.
 *
 * ── WHY THIS FILE EXISTS AND WHEN IT DIES ────────────────────────────────────
 *
 * foundry resolves its own models from a catalog (`src/models/catalog.ts`) keyed
 * to published HuggingFace URLs. **That catalog is empty**: none of the three
 * fine-tunes has been published yet. foundry says so honestly — every model
 * stage stops at resolution with "the weights are not published" — and offers
 * `--base-model <file.gguf>` as an explicit OVERRIDE for someone holding local
 * weights.
 *
 * BookForge is that someone. This file is the override, gathered into one
 * module so that the day the weights publish, deleting it is a single deletion
 * rather than a hunt through three call sites for three hard-coded paths.
 *
 * Everything here is INTERIM and this is the marker. It is Mac-local by
 * construction (the paths are where the training runs put them on the owner's
 * machine); the environment variables exist so another machine can run the same
 * build without editing code.
 *
 * ── NO FALLBACKS ─────────────────────────────────────────────────────────────
 *
 * A missing GGUF is an error naming the file, the stage that wanted it, and the
 * variable that overrides it. It is never "run the stage without the model" and
 * never "quietly use a different one": a stage answering from the wrong weights
 * produces a book that is subtly worse, which is exactly the failure mode both
 * programs are built to refuse.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { sharedSubdir } from './shared-paths';

/** The model stages foundry runs. `scan` needs no weights (it is Tesseract). */
export type FoundryModelStage = 'boxes' | 'ocr' | 'footnotes';

interface ModelSlot {
  /** Environment variable that overrides the path outright. */
  readonly envVar: string;
  /** Where the training run left it on the owner's machine. */
  readonly defaultPath: () => string;
  /** Said in the error, so a reader knows what the file is supposed to be. */
  readonly what: string;
}

const SLOTS: Record<FoundryModelStage, ModelSlot> = {
  boxes: {
    envVar: 'FOUNDRY_MODEL_BOXES',
    // The rubric family — the page-layout model. Shared with BookForge's own
    // Detect path, which is why it sits in the OwenMorgan shared dir.
    defaultPath: () => path.join(sharedSubdir('rubric-models'), 'rubric-v5-4b-f16.gguf'),
    what: 'the block-categorisation (rubric) model',
  },
  ocr: {
    envVar: 'FOUNDRY_MODEL_OCR',
    // The galley family — OCR repair. Still a training export rather than a
    // published artifact, and the CHECKPOINT CHOICE IS NOT FINAL: keep this
    // swappable, that is the whole reason it is a named constant.
    defaultPath: () => path.join(os.homedir(), 'rubric-export', 'galley-v11-ep5910-f16.gguf'),
    what: 'the OCR-repair (galley) model',
  },
  footnotes: {
    envVar: 'FOUNDRY_MODEL_FOOTNOTES',
    defaultPath: () => path.join(sharedSubdir('dagger-models'), 'dagger-v1-0.6b-f16.gguf'),
    what: 'the footnote-marker remover (dagger) model',
  },
};

/** The path a stage WOULD use, whether or not it exists. */
export function foundryModelPath(stage: FoundryModelStage): string {
  const slot = SLOTS[stage];
  const override = process.env[slot.envVar]?.trim();
  return override ? path.resolve(override) : slot.defaultPath();
}

/**
 * The GGUF for a stage, or an error naming exactly what is missing.
 *
 * The message carries the stage, the file, and the variable that moves it —
 * because "model not found" with no path is a message that costs the reader a
 * grep through the source to act on.
 */
export function requireFoundryModel(stage: FoundryModelStage): string {
  const file = foundryModelPath(stage);
  if (!fs.existsSync(file)) {
    const slot = SLOTS[stage];
    throw new Error(
      `foundry's ${stage} stage needs ${slot.what}, and it is not on this machine:\n`
      + `  ${file}\n`
      + `Set ${slot.envVar} to the GGUF, or put it at that path. `
      + `foundry's own model catalog is still empty (the weights are unpublished), `
      + `so BookForge passes --base-model explicitly — there is nothing to download yet.`
    );
  }
  return file;
}

/** Every stage's path plus whether it is there — for a settings/diagnostics view. */
export function foundryModelReport(): Array<{
  stage: FoundryModelStage;
  path: string;
  present: boolean;
  envVar: string;
}> {
  return (Object.keys(SLOTS) as FoundryModelStage[]).map((stage) => ({
    stage,
    path: foundryModelPath(stage),
    present: fs.existsSync(foundryModelPath(stage)),
    envVar: SLOTS[stage].envVar,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// The binary, in development
// ─────────────────────────────────────────────────────────────────────────────

/** Where a dev checkout of foundry compiles its host binary. */
const DEV_CLI_CANDIDATES = [
  path.join('/Volumes/Callisto/Projects/foundry', 'dist', `foundry-${process.platform}-${process.arch}`),
  path.join(os.homedir(), 'Projects', 'foundry', 'dist', `foundry-${process.platform}-${process.arch}`),
];

/**
 * In a dev run, point `FOUNDRY_CLI_PATH` at the locally-built binary — unless
 * the developer already set it, in which case theirs wins untouched.
 *
 * This is deliberately a nudge to the ENVIRONMENT and not a third branch inside
 * `foundry-bridge.resolveFoundryPath`. The bridge's rule — env var, then the
 * installed component, and no PATH search — is a rule about not running an
 * unknown build, and it stays exactly two sources. What this does is spare the
 * owner from prefixing every `npm run electron:dev` with a path, which is the
 * kind of friction that ends with someone testing yesterday's binary.
 *
 * It logs whichever way it goes. A silent environment mutation is worse than no
 * convenience at all: the one question that matters when a run behaves oddly is
 * *which binary answered*, and it must be in the log.
 *
 * Packaged builds do not call this — there the component (or the user's own
 * FOUNDRY_CLI_PATH) is the only source, which is what shipping demands.
 */
export function primeFoundryDevCliPath(): void {
  const existing = process.env['FOUNDRY_CLI_PATH']?.trim();
  if (existing) {
    console.log(`[foundry] FOUNDRY_CLI_PATH already set: ${existing}`);
    return;
  }
  for (const candidate of DEV_CLI_CANDIDATES) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      process.env['FOUNDRY_CLI_PATH'] = candidate;
      console.log(`[foundry] dev binary: ${candidate}`);
      return;
    } catch {
      /* not this one */
    }
  }
  console.warn(
    '[foundry] No foundry binary found for development. Checked:\n'
    + DEV_CLI_CANDIDATES.map((c) => `  ${c}`).join('\n')
    + '\nBuild one with `tools/release-build.sh host` in the foundry checkout, '
    + 'or set FOUNDRY_CLI_PATH. OCR will report this rather than falling back.'
  );
}
