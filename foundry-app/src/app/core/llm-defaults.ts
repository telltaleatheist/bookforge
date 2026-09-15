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
 *
 * ── AND THE SEED IS RESOLVED AGAINST THE MACHINE, NOT READ FROM A TAG ──────
 *
 * Each of these asks for a CLASS, because main answers with the model that act
 * should open with rather than the tag the wizard once stored: a stored choice
 * that can still serve the class wins, a stale one is replaced by the largest
 * installed model that can (`openingModelFor`, electron/llm-catalog.ts). The
 * class is passed because the floors differ — translate and simplify need a
 * 27B, analysis has none — so one answer for all three would be wrong for at
 * least one of them on a card between the two.
 *
 * ── THE THIRD FIELD IS GONE, AND SO IS THE THING IT SEEDED ─────────────────
 *
 * A `server?: WritableSignal<LlmServerKind>` used to come back on the same
 * answer, because it was the same decision: under vLLM the model was a served id
 * and the URL was a different port, and a dialog that took two of the three from
 * Settings and guessed the third composed a job that could not run. Wave 61
 * retired that setting (docs/SLOTS.md): the local slot is Ollama, and any other
 * server is a REGISTERED CRUCIBLE whose model and address are read from the
 * server itself at the spawn rather than carried from a dialog.
 *
 * So what these two fields seed is exactly the LOCAL slot's answers — which is
 * what they always looked like, and is now what they are. The special case that
 * set an EMPTY model deliberately went with the setting: empty meant "whatever
 * that server is serving", and nothing on this side asks that question any more.
 */
import type { WritableSignal } from '@angular/core';

import type { ModelClass } from '@shared/types';

import { api } from './foundry';

function seed(
  cls: ModelClass,
  chosen: (defaults: { model: string; cleanModel: string }) => string,
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
): void {
  if (!api) return;
  void api.llm.defaults(cls).then((defaults) => {
    const wanted = chosen(defaults);
    if (wanted.trim().length > 0) model.set(wanted);
    if (defaults.ollama.trim().length > 0) ollama.set(defaults.ollama);
  });
}

export function seedLlmDefaults(
  cls: ModelClass,
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
): void {
  seed(cls, (defaults) => defaults.model, model, ollama);
}

/** The same read, taking `cleanTextModel` — for the Clean text dialog alone. */
export function seedCleanDefaults(
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
): void {
  seed('clean', (defaults) => defaults.cleanModel, model, ollama);
}
