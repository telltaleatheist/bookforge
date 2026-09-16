/**
 * setup — first run: what has been done, and what was declined.
 *
 * ── IT USED TO BE MORE THAN THIS ────────────────────────────────────────────
 *
 * It also composed the model step's whole world: the hardware probe, Ollama's
 * state, the lineup with one row badged, and the floor a card had to clear to be
 * offered translation at all. Owen deleted the subject on 2026-09-15 — *"we dont
 * have any local models. crucible handles all model orchestration"* — so there
 * is no machine for this file to measure and no model for it to recommend, and
 * `llmChoices` went with the wizard step that asked it.
 *
 * What is left is the marker and nothing else.
 *
 * ── THE MARKER IS "ASKED", NOT "SUCCEEDED" ───────────────────────────────────
 *
 * `setupCompleted` goes true when somebody reaches the end of the wizard OR
 * dismisses it, and every step is optional. That is deliberate and it is the
 * opposite of a gate: the app runs without an engine (you can still convert and
 * read), without the analysis worker, and without any of it on a machine that is
 * being looked at rather than used. A first-run screen that refused to go away
 * until five gigabytes had been downloaded would be a screen that has decided
 * what the person came here to do.
 *
 * WHAT IS SKIPPED IS REMEMBERED so the settings screen can name it — "the
 * analysis worker was skipped" is something a person can act on, and "setup was
 * not completed" is not.
 */
import { readAppSettings, writeAppSettings } from './app-settings';
import { foundryHost } from './host';
import type { SetupState } from '../shared/types';

export function setupState(): SetupState {
  const settings = readAppSettings();
  return { completed: settings.setupCompleted, skipped: settings.setupSkipped };
}

/**
 * Record that the wizard is over.
 *
 * `skipped` REPLACES rather than merges: a second run through the wizard is a
 * second, complete answer to the same question, and a person who went back and
 * installed the thing they skipped last time should not still be told they
 * skipped it.
 */
export function finishSetup(skipped: string[]): SetupState {
  const settings = writeAppSettings({ setupCompleted: true, setupSkipped: skipped });
  return { completed: settings.setupCompleted, skipped: settings.setupSkipped };
}

/** Discovery is free; model preparation starts after existing setup choices. */
export function modelPreparationReady(): boolean {
  const host = foundryHost();
  if (host !== null) return host.modelPreparationReady === undefined || host.modelPreparationReady();
  const settings = readAppSettings();
  return settings.setupCompleted && !settings.setupSkipped.includes('routes');
}
