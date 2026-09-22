/**
 * RUNNING / PAUSED — the words, for every switch that means it.
 *
 * There are two switches in this app that say the same kind of thing about
 * different scopes, and Owen asked (2026-09-22) for them to LOOK the same:
 *
 *  - **The master**, in the queue's toolbar. Paused accepts books and starts
 *    nothing, anywhere.
 *  - **One Crucible server**, on its GPU lane and on its Settings row. Paused
 *    accepts books that name it and starts nothing ON IT. It was a checkbox
 *    reading *Enabled / Disabled* until this date, which named a property of the
 *    server rather than what the queue would do with it — and read as though a
 *    switched-off server were broken or forgotten rather than resting.
 *
 * THE FACT UNDERNEATH IS UNCHANGED. A paused server is the routing record's
 * `disabled` list, exactly as before (`electron/crucible/routing.ts`), and every
 * consumer of it — venue choice, the reach sweep, prep's band, the bench cards —
 * reads the same boolean it always read. This file is the WORDS, and it exists
 * so there is one set of them: a tooltip copied into a second component is the
 * one that gets edited in a month's time and then disagrees.
 *
 * The titles say what the STATE means, not what the button does, because the one
 * you are already in is still pressable — pressing Running while running is how
 * you pick up anything that stopped.
 *
 * Wire-neutral: this compiles to a constant and is read by the renderer only.
 * It lives in shared/ because the two components that draw it are in different
 * features and neither may import out of the other.
 */

/** One side of a two-state switch. */
export interface StateSwitchSide {
  /** On the button. One word. */
  readonly label: string;
  /** Hover. What being IN this state means. */
  readonly title: string;
  /**
   * A full sentence for under the switch, where there is room for one. The
   * control names a state; the caption says what the state DOES (Owen,
   * 2026-09-20). Not every drawing has room — a lane header does not — so it is
   * the caller's to place.
   */
  readonly caption: string;
}

export interface StateSwitchWording {
  readonly running: StateSwitchSide;
  readonly paused: StateSwitchSide;
}

/**
 * THE MASTER. Moved here from `queue.component.ts` unchanged (2026-09-22) so the
 * server switch beside it cannot drift into a second dialect of the same idea.
 */
export const QUEUE_STATE_CONTROL: StateSwitchWording = {
  running: {
    label: 'Running',
    title: 'Steps start as slots free up. Pressing it while already running '
      + 'picks up anything that was stopped.',
    caption: 'Accepting books and starting them as machines free up.',
  },
  paused: {
    label: 'Paused',
    title: 'Books may still be added to the queue and reordered; nothing new '
      + 'starts until Running. Work already on a slot finishes.',
    caption: 'Accepting books; nothing new starts. Work already on a card finishes.',
  },
};

/**
 * ONE SERVER. The same two words, one scope down.
 *
 * "Work already on its card finishes" is the whole of why this is a pause and
 * not a stop, and it is the half people do not expect: pausing a server mid-book
 * does not take the book off it. Giving the card back is Stop, on the row.
 */
export const SERVER_STATE_CONTROL: StateSwitchWording = {
  running: {
    label: 'Running',
    title: 'The queue may start work on this server as its slots free up.',
    caption: 'Taking work as its slots free up.',
  },
  paused: {
    label: 'Paused',
    title: 'Nothing new starts on this server. Work already on its card '
      + 'finishes, and books that NAME it wait for it rather than going '
      + 'somewhere else.',
    caption: 'Nothing new starts here. Work already on its card finishes.',
  },
};

/**
 * Why a server that is Running still will not start anything, or null.
 *
 * THE HIERARCHY, said once. The master sits above every server switch: with the
 * queue paused, a server set to Running starts nothing either, and a control
 * that looked live while nothing could happen is the kind of lie that costs
 * fifteen minutes of staring at a card. The server's own switch is NOT rewritten
 * to say Paused — that would throw away what the operator chose, and flipping it
 * back would mean something different from what they flipped.
 */
export function serverHeldByMaster(queueRunning: boolean): string | null {
  return queueRunning
    ? null
    : 'The queue is paused, so nothing starts on any server until you press Running.';
}
