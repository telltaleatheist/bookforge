/**
 * TTS engine capability registry, as this window asks it.
 *
 * ── The table itself moved ──────────────────────────────────────────────────
 *
 * It is `@shared/tts/engine-caps` now, and that file's header says why: the
 * Foundry Narrate dialog is composed in BookForge's MAIN process, which decides
 * out of these very flags whether to ask a run for a temperature, and main cannot
 * compile anything under `src/`. This file's own header used to claim it was pure
 * data "so the Electron main process can import the same definitions" — it never
 * could, and now something does.
 *
 * WHAT IS RE-EXPORTED IS THE WHOLE PUBLIC API this file has always had, so the
 * wizard, the pipeline-defaults panel and the narration modal import exactly what
 * they imported before. One table, in one place, read from two programs.
 *
 * ── What stayed ────────────────────────────────────────────────────────────
 *
 * `selectableEngines`, because it is not a fact about the engines: it is a fact
 * about what this MACHINE has installed, asked through a component service that
 * only the renderer has. A capability table that knew about Angular services
 * would be a table main could not read, which is the problem this split exists to
 * end.
 */

import { TTS_ENGINES, narrationEngineOrder, type TtsEngineCaps } from '@shared/tts/engine-caps';

export {
  TTS_ENGINES,
  engineCaps,
  isTtsEngine,
  isRunnableTtsEngine,
  assertRunnableTtsEngine,
  engineDisplayName,
  narrationEngineOrder,
} from '@shared/tts/engine-caps';
export type {
  TTSEngine,
  TtsEngineId,
  RetiredTtsEngine,
  TtsEngineRetirement,
  TtsDevice,
  TtsVoiceModel,
  TtsSamplingControls,
  TtsEngineCaps,
} from '@shared/tts/engine-caps';

/**
 * Engines selectable right now, in display order. `isInstalled` gates engines that
 * require an optional component (the Orpheus env, the Higgs WSL env); a bundled
 * engine always passes. Pass `componentService.isInstalled` bound to its service.
 *
 * THE ORDER IS NO LONGER WRITTEN HERE. It used to be a literal
 * `['xtts', 'f5', 'orpheus', 'voxtral']` on this line, which made this file a
 * second place an engine could be listed or forgotten — and the retirement of
 * XTTS is exactly the change that would have gone wrong that way, because the
 * capability table and this array would each have had to be edited to agree.
 * `narrationEngineOrder()` is the one list, beside the table it indexes.
 */
export function selectableEngines(isInstalled: (componentId: string) => boolean): TtsEngineCaps[] {
  return narrationEngineOrder()
    .map((id) => TTS_ENGINES[id])
    .filter((c) => c.requiresComponent === null || isInstalled(c.requiresComponent));
}
