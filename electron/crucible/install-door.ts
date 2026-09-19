/**
 * THE ONE SEAM BETWEEN THIS APP AND THE ORCHESTRATOR'S INSTALL DOOR.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.6. The door is three verbs —
 * `GET /install`, `GET /install/events`, `POST /install` — and
 * `@crucible/bootstrap` wraps them as `installStatus()` and `watchInstall()`.
 * Everything in BookForge that wants to know how the move is going asks
 * {@link CrucibleInstallDoor} and nothing else, so the day the SDK carrying
 * those calls is pinned, ONE implementation is swapped in this file and no
 * renderer, no IPC channel and no component changes.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PRE-SDK SEAM — READ THIS BEFORE BELIEVING THE OUTCOME
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * {@link preSdkInstallDoor} is a STOPGAP, and it is labelled as one because it
 * is one. The bootstrap SDK pinned in `package.json` today has no
 * `installStatus()` and no `watchInstall()`; the orchestrator door it would
 * call does not exist in the release this app installs. So until PART 2 pins
 * the new pack, the door is implemented over the ONLY install this app can
 * actually see: the one it starts itself, whose events already flow through
 * `crucible:install-progress`.
 *
 * What that stopgap CAN and CANNOT say, stated rather than papered over:
 *
 *   * It sees only moves THIS PROCESS ran. A tray that installed the Linux
 *     engine before BookForge was opened leaves `outcome: null` here — which
 *     is "nothing has happened yet", and is why {@link
 *     installOutcomeIsTerminal} is a null check rather than a sixth state.
 *     With the real door, `installStatus()` reads `wsl-outcome.json` and
 *     answers for the machine.
 *   * It cannot produce `reboot-pending`. The vendored SDK's host-event action
 *     union is `run | run-elevated | instruct | link` — there is no `reboot`
 *     in it — so a machine that Windows asked to restart is not distinguishable
 *     here from one that failed. Nothing invents it: the state is in the type
 *     because PART 2 produces it, and this implementation never returns it.
 *   * It cannot produce `declined`. That is `[orchestrator] wsl = "never"` in
 *     Crucible's own config, read by the tray, and no app writes or reads it.
 *   * `attempts` counts what this process started. The real file counts what
 *     the machine has been through.
 *
 * None of those is a fallback: each is an absence reported as an absence.
 */
import type {
  CrucibleInstallDoorEvent,
  CrucibleInstallDoorStatus,
  CrucibleInstallOutcome,
} from '../../shared/crucible/install-door-wire';
import type { CrucibleInstallProgress } from '../../shared/crucible/install-wire';

/**
 * THE DOOR. Three verbs, and the app knows no other way to ask about a move.
 *
 * `watch` returns its own unsubscribe rather than taking a token, because
 * every caller in this app is a window that can be destroyed and the
 * unsubscribe is the thing they hold.
 */
export interface CrucibleInstallDoor {
  /** `GET /install` — is a move running, and what did the last one come to? */
  status(): Promise<CrucibleInstallDoorStatus>;
  /**
   * `GET /install/events` — every event of the running move, from where it is
   * now. Returns the unsubscribe.
   */
  watch(onEvent: (event: CrucibleInstallDoorEvent) => void): () => void;
  /**
   * `POST /install` — **Try again**, and nothing else. §2.5: this is the apps'
   * ONE WSL control, shown only when the outcome is `cannot` or `failed`.
   */
  start(): Promise<void>;
}

/**
 * The install this app can actually run, injected so the stopgap does not
 * import main's IPC body and PART 2's implementation does not need it at all.
 */
export interface PreSdkInstallRunner {
  /** Run one install to its ending. Resolves when it is over, however it ended. */
  run(): Promise<void>;
}

/**
 * THE STOPGAP, fed by `crucible:install-progress`.
 *
 * It is a class rather than a closure because main holds one of these for the
 * life of the process and feeds it from two places — the Install button's IPC
 * handler and Try again — and a thing with a name is easier to find when the
 * SDK replaces it.
 */
export class PreSdkInstallDoor implements CrucibleInstallDoor {
  private readonly watchers = new Set<(event: CrucibleInstallDoorEvent) => void>();
  private running = false;
  private outcome: CrucibleInstallOutcome | null = null;
  private attempts = 0;
  /**
   * THE LAST STATE-TABLE ANSWER THIS MACHINE GAVE, kept because the partition
   * of §1 — `instruct`/`link` is *cannot*, everything else is *can* — is
   * carried on the `state` event and NOT on the refusal that follows it. With
   * the real door the partition is a column in `wsl-states.ts`; here it is the
   * same fact read off the same event, one step earlier.
   */
  private lastState: { code: string; sentence: string; action: string } | null = null;

  constructor(private readonly runner: PreSdkInstallRunner) {}

  async status(): Promise<CrucibleInstallDoorStatus> {
    return { running: this.running, outcome: this.outcome };
  }

  watch(onEvent: (event: CrucibleInstallDoorEvent) => void): () => void {
    this.watchers.add(onEvent);
    return () => { this.watchers.delete(onEvent); };
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.runner.run();
  }

  /** A run began. Called by whoever starts one, before the first event. */
  began(): void {
    this.running = true;
    this.attempts += 1;
    this.lastState = null;
  }

  /** A run ended, however it ended. The outcome stands as the record of it. */
  ended(): void {
    this.running = false;
  }

  /**
   * ONE PROGRESS EVENT OF THE APP'S OWN INSTALL, TRANSLATED.
   *
   * The translation is a rename and nothing more — `kind` → `event`, `done`/
   * `total` → `bytes_done`/`bytes_total` — except at the two terminal kinds,
   * where the outcome is COMPOSED, because the pre-SDK install has no outcome
   * file to read one from. Every field of that composition is traceable to an
   * event that arrived; nothing is guessed.
   */
  record(progress: CrucibleInstallProgress): void {
    if (progress.kind === 'state') {
      this.lastState = {
        code: progress.code, sentence: progress.sentence, action: progress.action,
      };
      this.emit({
        event: 'state',
        code: progress.code,
        sentence: progress.sentence,
        action: progress.action,
      });
      return;
    }
    if (progress.kind === 'step') {
      this.emit({
        event: 'step',
        name: progress.step,
        index: progress.index,
        total: progress.total,
        detail: progress.detail,
      });
      return;
    }
    if (progress.kind === 'progress') {
      this.emit({
        event: 'progress',
        file: progress.file,
        bytes_done: progress.done,
        bytes_total: progress.total,
      });
      return;
    }
    if (progress.kind === 'line') {
      this.emit({
        event: 'line', step: progress.step, stream: progress.stream, text: progress.text,
      });
      return;
    }
    if (progress.kind === 'done') {
      this.outcome = {
        state: 'done',
        code: null,
        sentence: null,
        at: new Date().toISOString(),
        release: progress.release,
        attempts: this.attempts,
      };
      this.emit({ event: 'done', outcome: this.outcome });
      return;
    }
    /*
     * A FAILURE IS `cannot` OR `failed`, AND THE STATE EVENT SAYS WHICH (§1).
     *
     * A machine whose last word from the state table was `instruct` or `link`
     * is one where a PERSON has to change something — virtualization in the
     * BIOS, a disk — and telling them "it failed, try again" would be telling
     * them to press a button that will fail again. Anything else is a `failed`
     * the tray retries, and its words are the refusing owner's own.
     */
    const stopped = this.lastState;
    const cannot = stopped !== null && (stopped.action === 'instruct' || stopped.action === 'link');
    this.outcome = {
      state: cannot ? 'cannot' : 'failed',
      code: cannot ? stopped.code : progress.refusal.code,
      sentence: cannot ? stopped.sentence : progress.refusal.message,
      at: new Date().toISOString(),
      release: null,
      attempts: this.attempts,
    };
    this.emit({ event: 'error', outcome: this.outcome });
  }

  private emit(event: CrucibleInstallDoorEvent): void {
    for (const watcher of this.watchers) watcher(event);
  }
}
