/**
 * llm-defaults — one line that seeds a language dialog's two fields.
 *
 * WHY A FUNCTION AND NOT THREE COPIES. Translate, Simplify and Analyse all open
 * with a model and an ollama URL, and all three had them seeded from the same
 * pair of constants. Now that the pair is a stored setting rather than a
 * constant, three hand-written copies of "read it, and fall back to the
 * constant if there is no bridge" is three chances for one of them to drift —
 * which for a model name means one dialog quietly running a different model
 * from the other two on the same machine.
 *
 * THE CONSTANTS ARE STILL THE FLOOR, and the signals are already holding them
 * when this is called: `api` is null in a plain browser (an `ng serve` with no
 * Electron under it), and a dialog that blanked its model field there would be
 * a dialog that cannot be looked at. So this only ever overwrites with an
 * answer main actually gave.
 *
 * CLEAN TEXT TAKES A DIFFERENT MODEL, NOT NO MODEL. `defaultLlmModel` is the
 * seed for translate, simplify and analyse; the narration cleanup has its own
 * stored setting, `cleanTextModel`, defaulting to `DEFAULT_CLEAN_TEXT_MODEL`
 * (Owen, 2026-09-08). It arrives on the same `llm:defaults` answer as
 * `cleanModel`, so `seedCleanDefaults` is the same read reaching for the other
 * half rather than a second hand-written copy of the read.
 *
 * AND THAT SHARED READ IS LOAD-BEARING BEYOND THIS FILE: hosted, BookForge's
 * Clean text press reads `cleanTextModel` out of the very same
 * `app-settings.json`, so one file decides what both doors run.
 */
import type { WritableSignal } from '@angular/core';

import type { LlmServerKind } from '@shared/pipeline';
import { api } from './foundry';

/*
 * AND THE THIRD FACT: WHICH KIND OF SERVER. It arrives on the same answer
 * because it is the same decision — under vLLM the model is a served id and the
 * URL is a different port, and a dialog that took two of the three from Settings
 * and guessed the third would compose a job that cannot run. The signal is
 * OPTIONAL because Analyse has no vLLM route yet and passes none; every dialog
 * that puts `server` on its request passes one.
 *
 * A MODEL THAT COMES BACK EMPTY IS SET ANYWAY WHEN THE SERVER IS vLLM, which is
 * the one place this differs from the two lines above it: empty MEANS something
 * there — "whatever that server is serving" — and leaving the constant in the
 * field would put an Ollama tag on a vLLM job (`AppSettings.vllmModel`).
 */
function seed(
  chosen: (defaults: { model: string; cleanModel: string }) => string,
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
  server?: WritableSignal<LlmServerKind>,
): void {
  if (!api) return;
  void api.llm.defaults().then((defaults) => {
    const wanted = chosen(defaults);
    if (wanted.trim().length > 0 || defaults.server === 'vllm') model.set(wanted);
    if (defaults.ollama.trim().length > 0) ollama.set(defaults.ollama);
    server?.set(defaults.server);
  });
}

export function seedLlmDefaults(
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
  server?: WritableSignal<LlmServerKind>,
): void {
  seed((defaults) => defaults.model, model, ollama, server);
}

/** The same read, taking `cleanTextModel` — for the Clean text dialog alone. */
export function seedCleanDefaults(
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
  server?: WritableSignal<LlmServerKind>,
): void {
  seed((defaults) => defaults.cleanModel, model, ollama, server);
}
