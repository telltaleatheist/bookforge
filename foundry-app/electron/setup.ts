/**
 * setup — first run: what has been done, and what this machine should be offered.
 *
 * A thin composition layer over four things that already exist and one that is
 * new. `system-probe.ts` measures the machine, `ollama.ts` asks whether ollama
 * is here, `llm-catalog.ts` turns those two into a lineup with one row badged,
 * `app-settings.ts` remembers the answers. This file is where they meet, so the
 * IPC layer has one door per question instead of four calls and a join.
 *
 * ── THE MARKER IS "ASKED", NOT "SUCCEEDED" ───────────────────────────────────
 *
 * `setupCompleted` goes true when somebody reaches the end of the wizard OR
 * dismisses it, and every step is optional. That is deliberate and it is the
 * opposite of a gate: the app runs without ollama (you can still convert and
 * read), without the analysis worker (you can still translate), and without any
 * of it on a machine that is being looked at rather than used. A first-run
 * screen that refused to go away until five gigabytes had been downloaded would
 * be a screen that has decided what the person came here to do.
 *
 * WHAT IS SKIPPED IS REMEMBERED so the settings screen can name it — "the
 * analysis worker was skipped" is something a person can act on, and "setup was
 * not completed" is not.
 */
import { readAppSettings, writeAppSettings } from './app-settings';
import { localCrucibleTakeover, refreshCrucibleFacts } from './crucible-provider';
import { eligibleFor, fitsOn, lineupFor, suggestedTag } from './llm-catalog';
import { probeOllama } from './ollama';
import { probeSystem } from './system-probe';
import type { LlmChoices, SetupState, SystemProfile, TranslateFloorMiss } from '../shared/types';

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

/**
 * The model step's whole world: this machine, ollama's state, the lineup, and
 * what jobs use today.
 *
 * The hardware probe is cached for the process; the ollama probe is NOT (see
 * its header — it is the one fact that changes while the app is open, because
 * changing it is what the user is doing in the other window).
 *
 * AND THE CRUCIBLE ON THIS MACHINE, IF THERE IS ONE. A class it serves is a
 * class the wizard must not pull a second copy of into Ollama (docs/SLOTS.md
 * §5b), so the fact travels with the lineup rather than being asked for
 * separately — one read, one picture, no frame in which the rows and the reason
 * they are disabled disagree. `refreshCrucibleFacts` is awaited beside the other
 * two probes, which is what makes the answer a measurement rather than whatever
 * was cached the last time a tooltip was drawn.
 */
/**
 * Can anything that fits this machine translate here?
 *
 * ASKED OF THE CATALOG, not of a number written down twice: `eligibleFor` is
 * the floor and `fitsOn` is the fit, and both are the ones the act gate reads
 * (electron/act-gates.ts). A machine that clears the floor gets null and the
 * step says nothing extra; one that does not is told which model it would
 * need, because "translation needs a bigger card than this" is the single most
 * useful thing that screen can say to somebody about to download six
 * gigabytes.
 */
function translateFloorMiss(profile: SystemProfile): TranslateFloorMiss | null {
  const eligible = eligibleFor('translate');
  if (eligible.some((row) => fitsOn(row, profile))) return null;
  const floor = eligible[0];
  if (floor === undefined) return null;
  return { needs: floor.label, needsGB: floor.local.needsGB.value };
}

export async function llmChoices(): Promise<LlmChoices> {
  const settings = readAppSettings();
  const [profile, ollama] = await Promise.all([
    probeSystem(),
    probeOllama(settings.ollamaUrl),
    refreshCrucibleFacts(),
  ]);
  const options = lineupFor(profile, ollama.models);
  return {
    profile,
    ollama,
    options,
    suggested: suggestedTag(options),
    translateFloorMiss: translateFloorMiss(profile),
    current: settings.defaultLlmModel,
    crucible: localCrucibleTakeover(),
  };
}
