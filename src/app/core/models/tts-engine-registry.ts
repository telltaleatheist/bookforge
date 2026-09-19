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
 * ── WHAT WAS HERE AND IS GONE ──────────────────────────────────────────────
 *
 * `selectableEngines(isInstalled)`. It stayed behind when the table moved
 * because it was "a fact about what this MACHINE has installed" — and on
 * 2026-09-19 that stopped being a fact anybody needed. Every render happens on
 * a Crucible server, so whether an engine's component is installed on the box
 * DRAWING the dialog says nothing about whether the book can be read: the
 * narration modal now intersects `narrationEngineOrder()` with the engines the
 * answering servers report (`VoicePickerDto.engines`, from each server's
 * `/v1/voices`). BookForge deciding from its own disk about another machine's
 * card is the same shape as the Device control cut the same day, and as the
 * voice list before `electron/crucible/voice-inventory.ts`.
 *
 * Nothing else read it — the Pipeline Defaults page that was its other caller
 * was deleted on 2026-09-17 — so the function went rather than lingering as a
 * second, quieter answer to "which engines may be chosen".
 */

export {
  TTS_ENGINES,
  narrationEngineOrder,
  engineCaps,
  isTtsEngine,
  isRunnableTtsEngine,
  assertRunnableTtsEngine,
  engineDisplayName,
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
