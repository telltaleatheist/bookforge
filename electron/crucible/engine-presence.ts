/** Crucible owns its installation layout and lifecycle on every platform. */
import { localStatus, startLocal, type LocalStatus } from '@crucible/bootstrap';
import { crucibleProcessRunner } from './host-runner';

export type EnginePresence = LocalStatus;
export function readEnginePresence(): Promise<EnginePresence> {
  return localStatus({}, crucibleProcessRunner());
}
export interface EngineStartOutcome { readonly started: boolean; readonly detail: string }
export async function startEngine(): Promise<EngineStartOutcome> {
  try {
    const result = await startLocal({}, crucibleProcessRunner());
    return { started: result.state === 'running', detail: result.detail };
  } catch (error) {
    return { started: false, detail: (error as Error).message };
  }
}

/**
 * What each of the SDK's eight states means for a person at startup.
 *
 * `null` means SAY NOTHING. Everything else is shown, and being shown at launch
 * has to be earned: it interrupts, and it is read as "something you must deal
 * with before you carry on".
 *
 * `unhealthy` earns nothing, which is the correction (2026-09-17). It means
 * `/v1/ping` ANSWERED and a later call did not — so the engine is demonstrably
 * alive, and nothing here repairs a slow answer. It used to fall into a
 * catch-all that told Owen "The local Crucible installation needs attention"
 * about a perfectly healthy engine, with the detail `timed out`, because
 * `crucible local status` gave `/v1/info` the same three seconds it gives a
 * ping and that route enumerates every model and voice. Both halves of that are
 * fixed in Crucible (`INFO_TIMEOUT`, and the message is wrapped rather than a
 * bare `str(exc)`); this is the third half, which is that the app should not
 * have raised an alarm about it at all. The Servers panel watches that machine
 * continuously and is where a slow engine belongs.
 *
 * Reported by the Foundry session, which hit the identical shape and asked
 * whether this app shared it rather than assuming. It did.
 */
export interface EnginePresenceNotice {
  readonly state: LocalStatus['state'];
  /** The engine's own words. Shown as the detail line. */
  readonly detail: string;
  /** One sentence for a person, already decided. */
  readonly message: string;
  /**
   * True when pressing Start is the actual repair, so the renderer asks rather
   * than tells. False means there is nothing to press and this is just news.
   */
  readonly offerStart: boolean;
}

/**
 * Compose what to say, or null. PURE — the observation is the argument — so the
 * interesting machine (the broken one) is testable without being that machine.
 */
export function presenceNotice(observed: LocalStatus): EnginePresenceNotice | null {
  const base = { state: observed.state, detail: observed.detail };
  switch (observed.state) {
    case 'running':
    case 'absent':
    case 'unhealthy':
      return null;
    case 'stopped':
      return { ...base, offerStart: true, message: 'Crucible is stopped on this computer.' };
    case 'unreachable':
      return { ...base, offerStart: true, message: 'Crucible is installed but is not answering.' };
    case 'unauthorized':
      return {
        ...base, offerStart: false,
        message: 'BookForge is not authorised to use the Crucible on this computer. '
          + 'Re-connect it in Settings → Crucible Servers.',
      };
    case 'wrong_service':
      return {
        ...base, offerStart: false,
        message: 'Something else is answering on the port the local Crucible uses.',
      };
    case 'broken':
      return {
        ...base, offerStart: false,
        message: 'The local Crucible installation is incomplete and cannot start.',
      };
  }
}

/**
 * Report the local engine's presence TO THE RENDERER. It draws it.
 *
 * NO NATIVE DIALOGS — Owen, 2026-09-17: *"no js alerts. ever. we use custom
 * modals for that"*. This function used to call `dialog.showMessageBox` three
 * times, which is an OS-drawn box in the middle of the screen with OS buttons.
 * The app has its own: `DialogService` for a question, `NoticeService` for a
 * line on the toast stack. The main process has no business choosing between
 * them, and now does not — it sends the finding and the renderer decides how a
 * thing is said, which is where that decision has always belonged.
 *
 * Unrelated remote engines go on working regardless; this is only about the
 * Crucible on this machine.
 */
export async function reportLocalCruciblePresence(
  send: (channel: string, payload: unknown) => void,
): Promise<void> {
  const notice = presenceNotice(await readEnginePresence());
  if (notice === null) {
    return;
  }
  send('crucible:engine-presence', notice);
}
