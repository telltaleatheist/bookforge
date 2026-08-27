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
 */
import type { WritableSignal } from '@angular/core';

import { api } from './foundry';

export function seedLlmDefaults(
  model: WritableSignal<string>,
  ollama: WritableSignal<string>,
): void {
  if (!api) return;
  void api.llm.defaults().then((defaults) => {
    if (defaults.model.trim().length > 0) model.set(defaults.model);
    if (defaults.ollama.trim().length > 0) ollama.set(defaults.ollama);
  });
}
