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

import { TTS_ENGINES, type TTSEngine, type TtsEngineCaps } from '@shared/tts/engine-caps';

export {
  TTS_ENGINES,
  engineCaps,
  isTtsEngine,
} from '@shared/tts/engine-caps';
export type {
  TTSEngine,
  TtsDevice,
  TtsVoiceModel,
  TtsSamplingControls,
  TtsEngineCaps,
} from '@shared/tts/engine-caps';

/**
 * Engines selectable right now, in display order. `isInstalled` gates engines that
 * require an optional component (Orpheus/Voxtral/F5 envs); bundled engines always
 * pass. Pass `componentService.isInstalled` bound to its service.
 */
export function selectableEngines(isInstalled: (componentId: string) => boolean): TtsEngineCaps[] {
  const order: TTSEngine[] = ['xtts', 'f5', 'orpheus', 'voxtral'];
  return order
    .map((id) => TTS_ENGINES[id])
    .filter((c) => c.requiresComponent === null || isInstalled(c.requiresComponent));
}
