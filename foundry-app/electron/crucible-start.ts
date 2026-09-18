/** Crucible owns local discovery and lifecycle; Foundry only offers the action. */
import { localStatus, startLocal } from '@crucible/bootstrap';
import type { CrucibleStartResult } from '../shared/slots';
import { hosted } from './host';

/**
 * WHICH OF THE THREE FAULTS AN INSTALLATION HAS — the only states that earn the
 * word "repair". The SDK's own words, kept rather than renamed, so a line in the
 * log can be read against `crucible local status --json` without a translation
 * table in between.
 */
export type CrucibleFault = 'wrong_service' | 'unauthorized' | 'broken';

/**
 * WHAT THE LOCAL CRUCIBLE IS DOING — in the distinctions this app acts on.
 *
 * ── Why this is no longer three states and a bucket ────────────────────────
 *
 * It was `running | stopped | absent | problem | not-ours`, with the SDK's five
 * other states — `unreachable`, `wrong_service`, `unauthorized`, `unhealthy`,
 * `broken` — folded into `problem`, and `problem` drew a card at startup saying
 * *"Open Crucible to repair its local installation or connection."*
 *
 * Owen met that card on 2026-09-17 with the engine running perfectly. What had
 * actually happened is the narrowest fault there is. `crucible local status`
 * asks `/v1/ping`, gets it, then asks `/v1/info` — and `/v1/info` composes its
 * document by enumerating every model and every voice the engine holds, against
 * a THREE SECOND timeout (crucible/local.py `request`). On that run it took
 * longer. Python's `str(TimeoutError)` is the two words `timed out`, and
 * crucible/local.py:148 passes the exception through as `detail` unwrapped where
 * its neighbour four lines up wraps it. So the card read:
 *
 *     Crucible needs attention
 *     timed out
 *     Open Crucible to repair its local installation or connection.
 *
 * Three lines, none of them true of that machine, and the last one sending
 * somebody to repair an installation with nothing wrong with it. That is the
 * failure Owen named on 2026-09-16 — *"this should be idiot proof … it shouldnt
 * talk about crucible unless it needs to"* — arriving as an alarm box with one
 * Close button, over a healthy engine, on startup.
 *
 * ── THE FOLD IS GONE BECAUSE THE QUESTIONS HAVE DIFFERENT ANSWERS ─────────
 *
 *   * **Is there something to start?** `stopped`, and `unreachable` too: the
 *     engine is installed and nothing is answering, and `crucible local start`
 *     is exactly the press that fixes it. Offering it is the idiot-proof move,
 *     and it is idempotent against an engine that is merely still coming up.
 *   * **Is it up, and merely slow to finish a sentence?** `unhealthy`. Ping
 *     answered, so there is nothing to start; and no button in this app repairs
 *     a slow document. Foundry says NOTHING, and the Servers card — which probes
 *     each registered engine continuously, on Foundry's own terms — stays the
 *     one voice on that machine's health, rather than being shouted over by a
 *     three-second sample taken once at launch.
 *   * **Is the installation itself at fault?** `wrong_service`, `unauthorized`,
 *     `broken`. Only these three are a `problem`, so by the time that word is
 *     drawn on a screen it is true of the thing it is drawn about.
 */
export type CrucibleRunState =
  | { kind: 'running'; url: string | null; name: string | null }
  | { kind: 'stopped'; url: string | null }
  | { kind: 'absent'; why: string }
  /** Installed, and nothing answered at all. There IS something to start. */
  | { kind: 'unreachable'; why: string }
  /** It answered ping and not the rest. Nothing to start, nothing to repair. */
  | { kind: 'unhealthy'; why: string }
  | { kind: 'problem'; fault: CrucibleFault; why: string }
  | { kind: 'not-ours' };

export async function crucibleRunState(): Promise<CrucibleRunState> {
  if (hosted()) return { kind: 'not-ours' };
  try {
    const status = await localStatus();
    switch (status.state) {
      case 'running': return { kind: 'running', url: status.url, name: status.name };
      case 'stopped': return { kind: 'stopped', url: status.url };
      case 'absent': return { kind: 'absent', why: status.detail };
      case 'unreachable': return { kind: 'unreachable', why: status.detail };
      case 'unhealthy': return { kind: 'unhealthy', why: status.detail };
      case 'wrong_service':
      case 'unauthorized':
      case 'broken':
        return { kind: 'problem', fault: status.state, why: status.detail };
      /*
       * A WORD THIS BUILD HAS NOT HEARD OF IS NAMED, not swallowed — the same
       * rule the catalog kinds follow (crucible-models.ts). Reaching here means
       * the installed Crucible is newer than this app, which is a fact worth
       * putting on a screen rather than an error to launder into "broken".
       * Unreachable by the SDK's types today, and that is the point: the types
       * are this build's, and the process on the other side is not.
       */
      default: return {
        kind: 'problem', fault: 'broken',
        why: 'Crucible reported a state this version of Foundry does not know: '
          + `"${String(status.state)}". Foundry may be older than the Crucible on this computer.`,
      };
    }
  } catch (err) {
    /*
     * `localStatus` answers `broken` rather than throwing for every fault it
     * anticipated, so a throw is a status document that could not be OBTAINED —
     * an unreadable home, a reply that is not the shape a status document has.
     * Which is `broken` too, and the message says which one it was.
     */
    return {
      kind: 'problem', fault: 'broken',
      why: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * THE THREE FAULTS, EACH IN ITS OWN WORDS.
 *
 * One title and one pair of paragraphs per fault rather than one for all three,
 * for the reason crucible-models.ts gives about the four remove refusals: each
 * is a different thing for a person to DO. *"Open Crucible to repair its local
 * installation or connection"* is the sentence somebody writes when they have
 * not worked out which of them happened — it names two possibilities and then an
 * action that only fits one of them.
 *
 * LIVES HERE RATHER THAN AT THE DOOR because the vocabulary and the words for it
 * are one thing: a fourth member of {@link CrucibleFault} fails to compile until
 * somebody has said what to tell a person about it.
 */
export function crucibleFaultWords(fault: CrucibleFault): { title: string; detail: string[] } {
  switch (fault) {
    case 'wrong_service': return {
      title: 'Something else is answering on Crucible’s address',
      detail: [
        'Another program is using the address Crucible was paired on, so Foundry cannot reach '
        + 'the engine and cannot tell whether it is running.',
        'Open Crucible and let it pair again, or stop the other program first.',
      ],
    };
    case 'unauthorized': return {
      title: 'Crucible would not accept this computer',
      detail: [
        'The engine is running and refused the credentials stored here. That happens when '
        + 'Crucible has been reinstalled, or paired afresh, since Foundry last spoke to it.',
        'Open Crucible and pair this computer with it again.',
      ],
    };
    case 'broken': return {
      title: 'Crucible needs attention',
      detail: [
        'Crucible is on this computer, but the record it publishes for other programs to drive '
        + 'it by is missing, unreadable, or written by a version Foundry cannot read.',
        'Open Crucible and let its installer repair it. Nothing in Foundry can do it from here.',
      ],
    };
  }
}

export async function startCrucible(): Promise<CrucibleStartResult> {
  if (hosted()) {
    return { started: false, detail: 'The servers belong to the application Foundry is running inside.' };
  }
  try {
    const status = await startLocal();
    return { started: status.state === 'running', detail: status.detail };
  } catch (err) {
    return { started: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
