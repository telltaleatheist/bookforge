/** First-run choices are durable after selected models are ready, or an explicit dismissal. */
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

let preparing = false;

/** Keep first-run durable until the selected preparation has actually succeeded. */
export async function finishPreparedSetup(
  skipped: string[], prepare: () => Promise<unknown>,
): Promise<SetupState> {
  if (preparing) throw new Error('Setup is already preparing models.');
  preparing = true;
  try {
    await prepare();
    return finishSetup(skipped);
  } finally {
    preparing = false;
  }
}

/** Discovery is free; model preparation starts after existing setup choices. */
export function modelPreparationReady(): boolean {
  const host = foundryHost();
  if (host !== null) return host.modelPreparationReady === undefined || host.modelPreparationReady();
  const settings = readAppSettings();
  return preparing || settings.setupCompleted && !settings.setupSkipped.includes('routes');
}
