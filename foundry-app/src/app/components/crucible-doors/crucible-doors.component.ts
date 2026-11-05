/**
 * crucible-doors — the three ways a person gets a Crucible, in Owen's words:
 * *"offer to install Crucible, or to point at one elsewhere"*.
 *
 * ── WHY IT IS A COMPONENT AND NOT TWO COPIES ────────────────────────────────
 *
 * The same three doors appear in two places: the first-run wizard, where
 * somebody is deciding whether they want any of this, and Settings → Servers,
 * where somebody who skipped it has come back. They are the same three doors and
 * they must stay the same three — a wizard that offered a "Connect" the settings
 * card spelled differently would be two screens teaching two different things
 * about one registry. So this is one component with two hosts.
 *
 * It owns NO STATE OF ITS OWN beyond what is being typed. Every door ends in a
 * call to `api.crucible.*`, main answers with the registry as stored, and the
 * host re-reads through its own door — `changed` is the whole of what this emits,
 * because a component that handed its parent a server list would be a second
 * copy of a list main has already answered with.
 *
 * ── THE DOORS, AND WHY THEY ARE IN THIS ORDER ───────────────────────────────
 *
 * THE ORDER IS THE CONTRACT'S, NOT A LAYOUT CHOICE. crucible
 * `docs/PHASE15-HOST.md` §5.1 — *"Connect: three ways, in this order, all
 * automatic"* — names the pairing file first, a pasted connect code second, and
 * getting one installed here last, and the reason is that each is more work for
 * the person than the one above it. A screen that offered them in another order
 * would be asking somebody to type a token they never needed to see.
 *
 * 0. **An engine that left a connect code here, found on its own.** No door at
 *    all in the ordinary case: main reads the connect code Crucible left at
 *    `<CRUCIBLE_HOME>/pairing` at start and registers it under THE NAME THE LINE
 *    CARRIES, exactly as a pasted code is registered — there is no reserved name
 *    and no "this machine" identity, per Owen's ruling *"it shouldnt be named
 *    'local' anywhere. it might not be local"*
 *    (§3.6; electron/ipc.ts `adoptPairingFile`). What is here is the SECOND
 *    CHANCE §3.6 asks for — "Look again on this machine", for an engine
 *    installed AFTER this app opened, which is exactly what happens when
 *    somebody runs Crucible's installer with Foundry already up.
 *
 * 1. **Connect to a Crucible server**, and the first thing in it is the PASTED
 *    CONNECT CODE (§5.1 way 2, PHASE13-OPERATOR.md §5.1): one field instead of
 *    three, and nobody transcribes a 43-character secret. The three boxes below
 *    it are unchanged and still work by hand, for a server whose operator page
 *    nobody can reach. Test before Add either way, and the test does NOT write
 *    anything: adding a server in order to find out whether it is a server would
 *    leave a dead entry behind every failure.
 *
 * 2. **Use the Crucible on this machine.** Reads that server's own config.toml
 *    rather than asking anybody to copy a token, so the file stays the token's
 *    single owner and a later `crucible init --force` is fixed by pressing the
 *    button again (crucible-registry.ts argues this at length). §3.6 keeps this
 *    door alive until the Windows host ships — it is how Owen's PC registers its
 *    WSL server — and says it is DELETED then, not before.
 *
 * 3. **Install Crucible here.** Last, because it is the longest, and it RUNS —
 *    this door was a printed document with a disabled button until
 *    `@crucible/bootstrap` landed, and the comment saying so outlived the change
 *    by long enough to be worth naming. `driven` is true on win32, darwin and
 *    linux when this window is not hosted; main streams the installer's own
 *    output line by line, then VERIFIES the service and REGISTERS the engine
 *    before it reports success, so somebody who presses it ends the step
 *    connected rather than being sent to another screen to finish. `drivenWhy`
 *    carries main's sentence for the two cases where it is not driven — hosted,
 *    and a platform Crucible does not support.
 *
 * 4. **Remove the engine from this computer.** The way OUT, and it is drawn on
 *    the Servers card only: `canUninstall` is an input, the first-run wizard
 *    does not pass one, and offering to remove Crucible to somebody who has not
 *    installed it is a screen teaching the wrong thing. Beyond that the door is
 *    main's to allow — crucible `docs/INSTALL-UNINSTALL.md` §6.1 and Owen's
 *    ruling with it: *the door only for a server the app can prove is this
 *    machine's; never a registry entry.* This component does not reason about
 *    loopback addresses or ports, because §6.1 is explicit that none of those
 *    is a proof: *"a tailnet, a port-forward or an SSH tunnel all put
 *    `127.0.0.1:7100` in front of somebody else's card."* It asks, and draws
 *    nothing when the answer is no.
 *
 *    The order holds here too: it is LAST because it is the only one that takes
 *    something away. Its sequence is §6.4's — the dry run first, read, then the
 *    real run with the same flags — and a fatal step is ONE RED ROW and never
 *    "uninstall failed", because §6.3 says a fatal step does not stop the run
 *    and *"a UI that says 'uninstall failed' and implies nothing happened is
 *    wrong."* Its words are BookForge's verbatim, agreed 2026-09-15: two apps
 *    that remove one engine must not describe it two ways.
 *
 * ── THE WORD IS "CONNECT CODE", EVERYWHERE A PERSON READS IT ────────────────
 *
 * BookForge says connect code and so does this. Crucible's own documents call
 * the thing a "pairing line", because that is what the PRODUCER calls the
 * format; a person pasting one is not reading those documents, and two words for
 * one thing across two apps is how somebody concludes they have two things.
 *
 * ── IT WAS OPTIONAL, AND IT IS NOT ANY MORE ────────────────────────────────
 *
 * Owen: *"foundry should work if they have no idea what theyre doing and they
 * just want to convert PDFs to EPUB. but if they do know what theyre doing and
 * they want access to speed, they can use crucible."* That held while Ollama on
 * this machine was the beginner's path. It is not: *"we dont have any local
 * models. crucible handles all model orchestration. if theres no connected
 * crucible server then tiles should be disabled"* (2026-09-15). Converting a PDF
 * to an EPUB still needs none of this; everything that meets a model needs one of
 * these doors. The wizard's step around it is still skippable, because a person
 * is allowed to look at the app before furnishing it.
 */
import { ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { CrucibleInstallPlan, CrucibleProbe } from '@owen/foundry-core/shared/slots';
import { applyInstallEvent, initialInstallRows } from '@owen/foundry-core/shared/crucible-install-wire';
import type {
  CrucibleInstallChildRow,
  CrucibleInstallOutcome,
  CrucibleInstallRow,
  CrucibleInstallStatus,
} from '@owen/foundry-core/shared/crucible-install-wire';
import type { RemotePairingProgress } from '@owen/foundry-core/shared/remote-pairing';
import type {
  CrucibleUninstallAvailability,
  CrucibleUninstallPlan,
} from '@owen/foundry-core/shared/uninstall-wire';
import { cardWords, diskWords, jobTypeWords, sizeWords } from '../../core/crucible-words';
import { api } from '../../core/foundry';
import type { LocalCruciblePresence } from '@owen/foundry-core/shared/slots';
import { ServerRepairComponent } from './server-repair.component';

/** Which door is open. `null` is all three closed, which is how it starts. */
type DoorId = 'connect' | 'local' | 'install' | 'uninstall';

@Component({
  selector: 'app-crucible-doors',
  imports: [FormsModule, ServerRepairComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './crucible-doors.component.html',
  styleUrl: './crucible-doors.component.scss',
})
export class CrucibleDoorsComponent {
  /**
   * THE REGISTRY MOVED. Emitted after any door that wrote one, and never with a
   * payload: main answered with the registry as stored and the host re-reads
   * through its own door, so a list travelling on this event would be a second
   * copy of something that already has an owner.
   */
  readonly changed = output<void>();
  /**
   * MAY THE FOURTH DOOR BE OFFERED HERE AT ALL — the Servers card passes true
   * and the first-run wizard passes nothing.
   *
   * A HOST'S CHOICE, not main's. Main decides whether the door may exist on this
   * MACHINE (section 6.1's proof); this decides whether it belongs on this
   * SCREEN, and the two are different questions. Somebody stepping through
   * first-run has not installed anything yet, and a "Remove the engine" row
   * under "Install Crucible here" is a wizard arguing with itself.
   */
  readonly canUninstall = input(false);
  /** Repair has said installing again is the only cure, so Install comes back on a machine with a Crucible. */
  readonly offerInstall = input(false);
  /** Whether this machine has a Crucible; null until it has answered. */
  protected readonly presence = signal<LocalCruciblePresence | null>(null);
  protected readonly reinstallNeeded = signal(false);
  /**
   * A door already open stays: an install in flight makes this machine a machine
   * with a Crucible, and its progress must not vanish because of that.
   */
  protected readonly showInstall = computed(() =>
    this.presence()?.state === 'absent' || this.offerInstall() || this.reinstallNeeded() || this.open() === 'install');


  /** The words file's, exposed because a template cannot call a bare import. */
  protected readonly cardWords = cardWords;

  protected readonly open = signal<DoorId | null>(null);
  protected readonly plan = signal<CrucibleInstallPlan | null>(null);
  /**
   * §3.1's ROWS, seeded from the plan's skeleton and filled in by the door.
   *
   * The skeleton is main's because the platform decides which rows exist; the
   * STATE of each is the reducer's, in shared/crucible-install-wire.ts, so the
   * same translation runs whichever door is behind the preload.
   */
  protected readonly rows = signal<CrucibleInstallRow[]>([]);
  /** §2.6's `GET /install`. Null outcome means nothing has said — not "fine". */
  protected readonly status = signal<CrucibleInstallStatus | null>(null);
  /** The backend the last `done` event named, for §3.1's closing sentence. */
  protected readonly finishedOn = signal<string | null | undefined>(undefined);
  protected readonly localNote = signal<string | null>(null);
  protected readonly localFailed = signal(false);
  protected readonly installSaid = signal<string | null>(null);
  protected readonly remoteAddress = signal('');
  protected readonly remotePairing = signal<RemotePairingProgress | null>(null);
  protected readonly remotePairingError = signal<string | null>(null);
  private readonly destroyRef = inject(DestroyRef);
  private remotePollTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteGeneration = 0;

  protected async beginRemotePairing(): Promise<void> {
    if (!api) return;
    const generation = ++this.remoteGeneration;
    this.busy.set('pairing');
    this.remotePairingError.set(null);
    this.remotePairing.set(null);
    try {
      const progress = await api.crucible.beginRemotePairing(this.remoteAddress());
      if (generation !== this.remoteGeneration) return;
      this.remotePairing.set(progress);
      this.scheduleRemotePoll(progress, generation);
    } catch (error) {
      if (generation === this.remoteGeneration) this.remotePairingError.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.remoteGeneration) this.busy.set(null);
    }
  }

  private scheduleRemotePoll(progress: RemotePairingProgress, generation: number): void {
    this.remotePollTimer = setTimeout(async () => {
      if (!api || generation !== this.remoteGeneration) return;
      try {
        const next = await api.crucible.pollRemotePairing(progress.id);
        if (generation !== this.remoteGeneration) return;
        this.remotePairing.set(next);
        if (next.status === 'pending') this.scheduleRemotePoll(next, generation);
        else if (next.status === 'approved') this.changed.emit();
      } catch (error) {
        if (generation !== this.remoteGeneration) return;
        this.remotePairing.set(null);
        this.remotePairingError.set(error instanceof Error ? error.message : String(error));
      }
    }, progress.pollAfterMs);
  }

  protected cancelRemotePairing(): void {
    ++this.remoteGeneration;
    if (this.remotePollTimer !== null) clearTimeout(this.remotePollTimer);
    this.remotePollTimer = null;
    this.remotePairing.set(null);
    this.busy.set(null);
    void api?.crucible.cancelRemotePairing();
  }

  // ── The fourth door ──────────────────────────────────────────────────────

  /**
   * MAIN'S PROOF, asked once when this component is built and again after a real
   * run. Null means it has not answered yet and the door is not drawn; false
   * means it answered no and the door is not drawn either — a machine with no
   * local engine is simply a machine with three doors.
   */
  protected readonly uninstall = signal<CrucibleUninstallAvailability | null>(null);
  /** The dry run. Cleared whenever a box moves — see the template's note. */
  protected readonly uninstallPlan = signal<CrucibleUninstallPlan | null>(null);
  /** The performed plan, once there is one. Never the same object as the dry run. */
  protected readonly removed = signal<CrucibleUninstallPlan | null>(null);
  protected readonly unregistered = signal<string | null>(null);
  protected readonly purgeWeights = signal(false);
  protected readonly wslToo = signal(false);
  protected readonly uninstallRefusal = signal<string | null>(null);

  protected readonly size = diskWords;

  /** The performed plan once there is one, else the dry run. One list, twice. */
  protected readonly shownPlan = computed(() => this.removed() ?? this.uninstallPlan());

  /**
   * The `pack:server` or `pack:host` row, quoted by name in the door's last line.
   *
   * Section 6.2: *"An app that needs a machine-readable answer calls the verb; an
   * app that wants the machine clean runs the wrapper."* Foundry calls the verb,
   * so the pack and the home stay — and the plan already names the row that says
   * so, which is what is quoted rather than a sentence of ours about a directory.
   */
  protected readonly packRow = computed(
    () => this.shownPlan()?.steps.find((step) => step.name.startsWith('pack:'))?.name ?? null,
  );

  /**
   * ONE SENTENCE, AND IT IS BOOKFORGE'S VERBATIM (2026-09-15).
   *
   * Two apps that remove one engine off one machine must not describe it two
   * ways, so the words are agreed rather than each app's own. The dry run says
   * nothing was touched; the real run prices what went and what stayed.
   */
  protected readonly uninstallSaid = computed(() => {
    const plan = this.shownPlan();
    if (plan === null) return '';
    const kept = `Kept${plan.dryRun ? ':' : ''} ${sizeWords(plan.kept.weightsBytes)} of models in `
      + `${plan.kept.paths.length} folder(s).`;
    return plan.dryRun
      ? `Nothing has been touched. ${kept}`
      : `Freed ${sizeWords(plan.removedBytes)}. ${kept}`;
  });



  /** Which call is in flight, so the right button says so and the others are off. */
  protected readonly busy = signal<
    'local' | 'install' | 'pairing' | 'uninstall-plan' | 'uninstall-run' | null
  >(null);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.cancelRemotePairing();
      this.detachInstallEvents?.();
      this.detachInstallEvents = null;
    });
    if (!api) return;
    /*
     * AND MAIN'S PROOF FOR DOOR 4, once. It is a read — a file test, and one
     * wsl.exe call only on the machine that has Crucible in a guest and no
     * Windows host. The wizard asks it too and throws the answer away, because
     * `canUninstall` is false there and nothing is drawn either way; making the
     * call conditional would put the decision in two places.
     */
    void this.askUninstall();
    void this.askPresence();
  }

  /**
   * "Use the existing one" is the default: on a machine with a Crucible not yet
   * in the registry, that door opens by itself, unless somebody already chose.
   */
  private async askPresence(): Promise<void> {
    if (!api) return;
    const [presence, view] = await Promise.all([api.crucible.localPresence(), api.crucible.settings()]);
    this.presence.set(presence);
    if (presence.state === 'present' && this.open() === null && !view.servers.some((server) => server.loopback)) {
      this.open.set('local');
    }
  }

  /**
   * One door at a time.
   *
   * Not an accordion for tidiness: the three are alternatives to each other, and
   * two open at once would be a screen offering somebody a choice it has already
   * shown them making twice.
   */
  protected toggle(door: DoorId): void {
    this.open.update((current) => (current === door ? null : door));
    if (this.open() !== 'connect' && this.remotePairing()?.status === 'pending') this.cancelRemotePairing();
    // The install plan is read the first time that door is opened and not
    // before: it spawns wsl.exe, and a wizard step that probed WSL on arrival
    // would be doing work for somebody who is about to press Skip.
    if (this.open() === 'install' && this.plan() === null) void this.loadPlan();
    // Reopening a door whose plan is already read re-asks nothing, so the
    // listening is settled here too — and closing it is what detaches.
    this.syncInstallListening();
    /*
     * CLOSING DOOR 4 THROWS ITS PLAN AWAY. A plan is a statement about a machine
     * at a moment, and a door reopened an hour later over yesterday's rows with
     * a live Remove button under them would be a confirmation of something
     * nobody read. Reopening asks again, which costs one dry run.
     */
    if (this.open() !== 'uninstall') this.forgetPlan();
  }

  /** The two runs' state, and nothing else this component holds. */
  private forgetPlan(): void {
    this.uninstallPlan.set(null);
    this.removed.set(null);
    this.unregistered.set(null);
    this.uninstallRefusal.set(null);
  }

  /**
   * The plan, the rows it seeds, and where the install already got to.
   *
   * ASKED TOGETHER, because they are one picture: a window opened halfway
   * through a move must not draw an empty list under a status that says a move
   * is running. §2.6 exists precisely so the second question has an answer.
   */
  private async loadPlan(): Promise<void> {
    if (!api) return;
    const plan = await api.crucible.installPlan();
    this.plan.set(plan);
    /*
     * THE SKELETON IS SEEDED ONCE AND NOT AGAIN. This is also called at the END
     * of a run, to re-read the outcome, and re-seeding there would wipe the
     * finished list the person is looking at and replace it with five waiting
     * rows under the word "Done".
     */
    if (this.rows().length === 0) {
      this.rows.set(initialInstallRows(plan.steps.map((step) => ({ id: step.id, label: step.title }))));
    }
    /*
     * A DOOR THAT WILL NOT ANSWER IS SAID, NOT SWALLOWED.
     *
     * `installStatus` reaches the tray on `:7101`, and a host that is
     * installed and not running refuses `host_unreachable` by name. That is a
     * real fact about this machine and it belongs on screen — but it must not
     * blank the install door, which is exactly where somebody goes to fix it.
     * So the plan above is already drawn and this adds the sentence beside it.
     */
    try {
      this.status.set(await api.crucible.installStatus());
    } catch (err) {
      this.status.set(null);
      this.installSaid.set(err instanceof Error ? err.message : String(err));
    }
    // The ask above is also main's attach, so by here there may be a stream.
    this.syncInstallListening();
  }

  // ── §3.1's words. Composed HERE, because the screen owns the wording ──────

  /** "1.2 GB of 4.0 GB", or nothing at all when the step cannot count. */
  protected bytesWords(row: CrucibleInstallRow): string | null {
    if (row.bytesDone === null) return null;
    return row.bytesTotal === null
      ? diskWords(row.bytesDone)
      : `${diskWords(row.bytesDone)} of ${diskWords(row.bytesTotal)}`;
  }

  /**
   * One job type, in a person's words — never the wire's name.
   *
   * crucible-words.ts rule 4: *"Job types, subjects, tasks and modules never
   * appear."* So `llm` is "the text engine" here, and a type this build has no
   * words for is still named rather than left as a gap.
   */
  protected childWords(child: CrucibleInstallChildRow): string {
    return child.state === 'done'
      ? `Installed ${jobTypeWords(child.jobType)}.`
      : `Installing ${jobTypeWords(child.jobType)}…`;
  }

  /**
   * §3.1's refusal line. The SENTENCE IS THE OUTCOME'S, verbatim — §2.2 says
   * so, and a sentence this app rewrote would be a second opinion about a
   * machine only the state table looked at.
   */
  protected cannotWords(outcome: CrucibleInstallOutcome): string {
    const said = outcome.sentence ?? 'Crucible did not say why.';
    return outcome.state === 'cannot'
      ? `This computer can't run the Linux engine: ${said}`
      : said;
  }

  /**
   * "Done — running on the Linux engine", and it is MEASURED.
   *
   * The backend comes off the `done` event, which main read from the engine
   * that answered (`verifyInstalled`). `undefined` is "no run has finished in
   * this window"; `null` is "a run finished and nothing measured which engine",
   * which happens on the already-registered arm and is said plainly rather than
   * guessed from the platform.
   */
  protected doneWords(): string | null {
    const backend = this.finishedOn();
    if (backend === undefined) return null;
    if (backend === null) return 'Done — Crucible is running and connected.';
    if (backend === 'cuda-linux') return 'Done — running on the Linux engine.';
    if (backend === 'llama-windows') return 'Done — running on the Windows engine.';
    return `Done — running on ${backend}.`;
  }

  /** §2.5's Try again: the same run, through the door that owns it. */
  protected tryAgain(): Promise<void> {
    return this.runInstall(() => api!.crucible.installRetry());
  }

  /**
   * §2.3's Restart now. Nothing is saved first and nothing needs to be: the
   * move's own progress lives in Crucible's outcome file, and this app's state
   * is on disk before any of this is drawn.
   */
  protected async restartNow(): Promise<void> {
    if (!api) return;
    try {
      await api.crucible.restartWindows();
    } catch (err) {
      this.installSaid.set(err instanceof Error ? err.message : String(err));
    }
  }

  /*
   * ── FOUR HANDLERS WENT WITH THE MARKUP THAT CALLED THEM (2026-09-17) ─────
   *
   * `test()`, `onCode()`, `lookAgain()` and `add()`, and with them the signals
   * they owned: `name`, `url`, `token`, `probe`, `code`, `codeRefusal`,
   * `hasCode`, `pairingNote`, `pairingFailed`.
   *
   * All four served the pre-open-pairing way in: paste a crucible:// code or
   * type an address and a token, prove it with Test, then Add — plus the button
   * that re-swept this machine for an engine installed mid-session. Owen retired
   * the lot on 2026-09-17 (*"we dont use tokens anymore ... we use ip addresses
   * to connect to crucible servers"*, *"look again on this machine ... seem
   * superfluous"*). `beginRemotePairing` is the one way in now.
   *
   * DELETED RATHER THAN LEFT UNREACHABLE. Every one of them was verified to
   * have no caller outside this block before it went; the main-process doors
   * they drove (`crucible:add`, `crucible:test-at`, `crucible:add-connect-code`,
   * `crucible:pair-local`) are untouched and still answer — this app simply has
   * no screen that asks them any more.
   */
  /**
   * Read that server's own config and register it.
   *
   * Pressing this a second time after `crucible init --force` is the supported
   * fix for a stale token — the entry is replaced in place, keeping its rank —
   * and the note says so, because otherwise the only way to learn it is to hit
   * the 401 first.
   *
   * THE NAME IS SENT EMPTY, WHICH MEANS "THE SERVER'S OWN". It used to send
   * "This machine", which was this app naming a server after where it happened
   * to find it. Owen's ruling retires that: *"a local crucible server shouldnt
   * be treated any differently than a remote crucible server. it should all be
   * entered the exact same way."* `addLocalCrucible` (electron/crucible-
   * registry.ts) already falls back to the `[server] name` in that config.toml,
   * which is the same source the other two doors take a name from — the line
   * the server printed about itself.
   */
  protected async addLocal(): Promise<void> {
    if (!api) return;
    this.busy.set('local');
    this.localNote.set(null);
    try {
      const answer = await api.crucible.addLocal('');
      if (answer.outcome === 'added') {
        this.localFailed.set(false);
        this.localNote.set(
          `Added ${answer.serverName} at ${answer.url}, read from ${answer.configPath}. `
          + 'Its token stays that file\'s — press this again after "crucible init" to refresh it.',
        );
        this.changed.emit();
      } else {
        /*
         * `already_registered` IS NOT A FAILURE ON THIS DOOR. The door asks for
         * the engine on this machine to be connected; a registry that already
         * holds its address is that request already satisfied, and painting it
         * red tells somebody a working setup is broken. Every other code is a
         * genuine refusal — no config file, a file that will not parse, a WSL
         * read that failed — and keeps the colour.
         */
        this.localFailed.set(answer.code !== 'already_registered');
        this.localNote.set(answer.message);
      }
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * The driven install. It runs, and the day it did not is over.
   *
   * Main's refusal — or `BootstrapStepFailed`, which names the step that did not
   * finish — is printed where the person pressed, exactly as every other
   * Crucible sentence in this app is.
   */
  protected drive(): Promise<void> {
    return this.runInstall(() => api!.crucible.install());
  }

  /**
   * ONE RUN, TWO BUTTONS — Install and §2.5's Try again.
   *
   * ── Why the events are subscribed around the call and not at start ────────
   *
   * Because attaching is what makes the wait legible and detaching is what
   * stops a closed door accumulating rows nobody is looking at. A move that
   * outlives this window is not lost by detaching: §2.6's `GET /install` is
   * asked again the next time the door opens, which is the whole reason it
   * exists.
   *
   * The reducer is shared/crucible-install-wire.ts's, so main, this door and
   * any keeper read one stream the same way.
   */
  private async runInstall(call: () => Promise<void>): Promise<void> {
    if (!api) return;
    this.busy.set('install');
    this.installSaid.set(null);
    this.finishedOn.set(undefined);
    this.syncInstallListening();
    try {
      await call();
      await this.loadPlan();
      this.changed.emit();
    } catch (err) {
      this.installSaid.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
      this.syncInstallListening();
    }
  }

  /** This window's detach, or null when it is not listening. */
  private detachInstallEvents: (() => void) | null = null;

  /**
   * LISTEN EXACTLY WHILE THERE IS SOMETHING TO HEAR, and it is two cases now.
   *
   * The first is the old one: a run this window pressed a button for. The
   * second is §2.3's, which this window used to be deaf to — the TRAY started
   * the move, and a person opening this door lands in the middle of it. Main
   * joins that stream when it is asked for the status (electron/ipc.ts's
   * `crucible:install-status`); without this the events then arrived in a
   * window that had subscribed to nothing, and the list stayed five waiting
   * rows under a status line that said a move was running.
   *
   * A CLOSED DOOR STILL DETACHES, which is the rule the press path was already
   * keeping: rows nobody is looking at are not worth accumulating, and §2.6's
   * `GET /install` is asked again the next time the door opens — which is what
   * re-attaches.
   */
  private syncInstallListening(): void {
    if (!api) return;
    const wanted = this.busy() === 'install'
      || (this.open() === 'install' && this.status()?.running === true);
    if (!wanted) {
      this.detachInstallEvents?.();
      this.detachInstallEvents = null;
      return;
    }
    if (this.detachInstallEvents !== null) return;
    this.detachInstallEvents = api.crucible.onInstallEvent((event) => {
      this.rows.update((rows) => applyInstallEvent(rows, event));
      if (event.event === 'done') this.finishedOn.set(event.backend);
    });
  }
  // ── The fourth door's four acts ──────────────────────────────────────────

  /**
   * MAIN'S PROOF, and anything thrown leaves it null so the door is not drawn.
   *
   * A proof that could not be taken is not a proof, and the safe direction is
   * the one where the button that removes an engine appears only on an answer
   * that said yes.
   */
  private async askUninstall(): Promise<void> {
    if (!api) return;
    try {
      this.uninstall.set(await api.crucible.uninstallAvailability());
    } catch {
      this.uninstall.set(null);
    }
  }

  protected isFatal(refusal: { fatal: boolean } | null): boolean {
    return refusal !== null && refusal.fatal;
  }

  /** "Show me what would go" — the dry run, section 6.4 step 1. Touches nothing. */
  protected showPlan(): Promise<void> {
    return this.readPlan();
  }

  protected setPurgeWeights(on: boolean): void {
    this.purgeWeights.set(on);
    this.uninstallPlan.set(null);
  }

  protected setWslToo(on: boolean): void {
    this.wslToo.set(on);
    this.uninstallPlan.set(null);
  }

  /*
   * A BOX MOVED: the plan on screen is thrown away, and NOT asked for again.
   *
   * Clearing is what stops a Remove button sitting over rows that were priced
   * for other flags. The re-ask is deliberately the person's next press of
   * "Show me what would go" — RULED with BookForge, 2026-09-15: a dry run spawns
   * a process on this machine, and the press is the consent to that; a checkbox
   * that spawned one on its own would be a control doing work nobody asked for.
   * Section 6.4's "re-runs the dry run so the number moves" is satisfied by the
   * press, and the kept figure is still the server's, never recomputed here.
   */

  private async readPlan(): Promise<void> {
    if (!api || this.busy() !== null) return;
    this.busy.set('uninstall-plan');
    this.uninstallRefusal.set(null);
    try {
      this.uninstallPlan.set(await api.crucible.uninstallDryRun({
        purgeWeights: this.purgeWeights(),
        wslToo: this.wslToo(),
      }));
    } catch (err) {
      this.uninstallRefusal.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * "Remove it" — the real run, THE SAME FLAGS, section 6.4 step 2.
   *
   * The same flags and not a fresh read of the boxes, because the rows on screen
   * were priced against these two and confirming something other than what was
   * read is the one thing a confirmation exists to prevent. (They cannot have
   * moved: changing either clears the plan, and this button is only drawn while
   * there is one.)
   */
  protected async removeIt(): Promise<void> {
    if (!api || this.busy() !== null) return;
    this.busy.set('uninstall-run');
    this.uninstallRefusal.set(null);
    try {
      const run = await api.crucible.uninstall({
        purgeWeights: this.purgeWeights(),
        wslToo: this.wslToo(),
      });
      this.removed.set(run.plan);
      this.unregistered.set(run.unregistered);
      this.changed.emit();
    } catch (err) {
      this.uninstallRefusal.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Cancel or Close — the door shuts, its plan goes, and MAIN IS ASKED AGAIN.
   *
   * After a real run the answer has usually changed: the pairing file went with
   * the uninstall. Re-asking is what makes the door disappear rather than offer
   * to remove a Crucible that is no longer there.
   */
  protected closeUninstall(): void {
    this.open.set(null);
    this.forgetPlan();
    this.purgeWeights.set(false);
    this.wslToo.set(false);
    void this.askUninstall();
  }
}
