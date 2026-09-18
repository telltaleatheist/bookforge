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

import type { CrucibleInstallPlan, CrucibleProbe } from '@shared/slots';
import type { RemotePairingProgress } from '@shared/remote-pairing';
import type {
  CrucibleUninstallAvailability,
  CrucibleUninstallPlan,
} from '@shared/uninstall-wire';
import { cardWords, diskWords, sizeWords } from '../../core/crucible-words';
import { api } from '../../core/foundry';

/** Which door is open. `null` is all three closed, which is how it starts. */
type DoorId = 'connect' | 'local' | 'install' | 'uninstall';

@Component({
  selector: 'app-crucible-doors',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="doors">
      <!--
        ── "LOOK AGAIN ON THIS MACHINE" IS GONE ────────────────────────────

        Owen, 2026-09-17: *"look again on this machine ... seem superfluous."*
        He is right, and the reason is in the sentence that sat above it:
        Foundry already looks for an engine on this machine by itself, at start.
        The button existed for one narrow case -- an engine installed AFTER this
        window opened -- and asked a person to know that about their own app in
        order to press it. Restarting Foundry does the same thing without the
        explanation, and connecting by address below works whether or not
        anything was found automatically.

        (NO BACKTICKS ANYWHERE IN THIS TEMPLATE, not even in a comment: it is a
        template literal and one would end it mid-sentence.)
      -->

      <!-- ── 1. Connect ────────────────────────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('connect')">
        <span class="door-name">Connect to a Crucible server</span>
        <span class="door-note">One running somewhere else — another desk, another room.</span>
      </button>
      @if (open() === 'connect') {
        <div class="panel">
          <label class="field">
            <span class="label">Computer address</span>
            <input type="text" name="remoteAddress" placeholder="192.168.1.20 or mac-studio"
                   [ngModel]="remoteAddress()" (ngModelChange)="remoteAddress.set($event)"
                   [disabled]="remotePairing()?.status === 'pending'">
          </label>
          <div class="actions">
            <button class="primary" type="button" [disabled]="busy() || remotePairing()?.status === 'pending'"
                    (click)="beginRemotePairing()">Connect by address</button>
            @if (remotePairing()?.status === 'pending') {
              <button class="ghost" type="button" (click)="cancelRemotePairing()">Cancel</button>
            }
          </div>
          @if (remotePairing(); as pairing) {
            @if (pairing.status === 'pending') {
              <!--
                TRUE WHETHER OR NOT THAT ENGINE ASKS ANYONE.

                Crucible 1.0.0 opens the request ALREADY APPROVED, so this
                normally flashes past in a single poll. An engine configured
                with open_pairing = false still holds it, and there the code
                matters. The copy that was here asserted the second case
                unconditionally -- and sent people to "Settings, Servers,
                Connection requests", a list deleted the same day.

                FOUNDRY CANNOT READ WHICH CASE IT IS IN, and the reason moved
                on 2026-09-17. It used to be that the vendored SDK was 0.6.12 and
                predated the field. The SDK is 1.0.0 now and the field is STILL
                not readable: startPairing reads /v1/pairing/start and builds its
                result explicitly -- id, device_code, user_code, expires_in,
                interval -- so approval_required arrives on the wire and is
                dropped on the way out. Surfacing it belongs to the package, and
                has been asked for.

                Re-vendoring was worth doing anyway and this was not why. The
                sentence stays true of both cases rather than guessing; when the
                SDK carries the field it becomes two sentences chosen by it, and
                only this block moves.
              -->
              <p class="small">Connecting to {{ pairing.name }}…
                If that computer asks anyone to approve this, the code is
                <strong>{{ pairing.userCode }}</strong>.</p>
            } @else if (pairing.status === 'approved') {
              <p class="small ok">Connected to {{ pairing.name }}.</p>
            } @else {
              <p class="small warn">Pairing {{ pairing.status }}. Connect again to request a new code.</p>
            }
          }
          @if (remotePairingError(); as error) { <p class="small warn">{{ error }}</p> }
          <!--
            ── THE CONNECT CODE, THE TOKEN BOX, TEST AND ADD ARE GONE ──────

            Owen, 2026-09-17: *"we dont use tokens anymore so that can be
            pulled. we use ip addresses to connect to crucible servers."*

            What stood here was the whole pre-open-pairing path: paste a
            crucible:// code, or type a name, an address and a token read off
            the other machine with "crucible token --show", then Test, then Add.
            Every one of those is a thing to transcribe correctly, and Connect
            by address above now does all of it from the one fact a person
            actually has. The token still exists and still arrives -- it is
            minted by the engine and stored by main -- it simply never passes
            through a person any more.

            WHAT THIS COSTS, SAID OUT LOUD: an engine configured with
            open_pairing = false has no manual path in Foundry at all now. That
            is a deliberate consequence of the ruling rather than an oversight;
            if such an engine turns up, the door that returns is this one.
          -->
        </div>
      }

      <!-- ── 2. This machine ───────────────────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('local')">
        <span class="door-name">Use the Crucible on this machine</span>
        <span class="door-note">
          One that is already installed here. Crucible publishes the connection for Foundry.
        </span>
      </button>
      @if (open() === 'local') {
        <div class="panel">
          <p class="small">Crucible manages its engine and publishes its address and credentials here.</p>
          <div class="actions">
            <button class="primary" type="button" [disabled]="busy()" (click)="addLocal()">
              {{ busy() === 'local' ? 'Reading…' : 'Use the Crucible on this machine' }}
            </button>
          </div>
          @if (localNote(); as note) {
            <p class="small" [class.warn]="localFailed()">{{ note }}</p>
          }
        </div>
      }

      <!-- ── 3. Install ────────────────────────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('install')">
        <span class="door-name">Install Crucible here</span>
        <span class="door-note">The steps, in order. Nothing is installed without you.</span>
      </button>
      @if (open() === 'install') {
        <div class="panel">
          <!--
            WHAT PHASE15 SECTION 4.3 SAYS, AND ONLY THAT. The sequence below is
            still main's plan, unchanged; this is the sentence above it, and it
            names the installers as NAMES rather than printing a command to
            paste, because the installer is Crucible's own front door and this
            app is not its manual.
          -->
          @if (isWindows) {
            <p class="small">
              On Windows the engine is installed by Crucible's own installer, install.ps1 from
              the release. It installs a native engine and publishes a connection on this machine, and Foundry
              finds the engine through that — there is nothing to paste afterwards.
            </p>
          } @else {
            <p class="small">
              On a Mac the engine is installed by Crucible's own installer, install.sh from the
              release. It leaves a connect code on this machine, and Foundry finds the engine
              through that — there is nothing to paste afterwards.
            </p>
          }
          @if (plan(); as it) {
            <p class="small">{{ it.machine }}</p>
            @if (it.platform === 'other') {
              <p class="warn">
                Crucible's backends are CUDA on Linux and MLX on Apple Silicon. There is no
                build for this platform, so there is nothing here to install — connect to one
                elsewhere instead.
              </p>
            } @else {
              <ol class="steps">
                @for (step of it.steps; track step.title) {
                  <li>
                    <span class="step-head">
                      <span class="step-name">{{ step.title }}</span>
                      @if (step.done) { <span class="badge held">already here</span> }
                    </span>
                    <span class="small">{{ step.detail }}</span>
                    @if (step.command) { <code class="cmd">{{ step.command }}</code> }
                  </li>
                }
              </ol>

              @if (it.elevated.length > 0) {
                <p class="small">
                  These need a privilege Foundry does not have, so they are yours to run:
                </p>
                <ol class="steps">
                  @for (step of it.elevated; track step.title) {
                    <li>
                      <span class="step-name">{{ step.title }}</span>
                      <span class="small">{{ step.detail }}</span>
                      @if (step.command) { <code class="cmd">{{ step.command }}</code> }
                    </li>
                  }
                </ol>
              }

              <div class="actions">
                <button class="primary" type="button" [disabled]="!it.driven || busy() !== null" (click)="drive()">
                  {{ busy() === 'install' ? 'Installing…' : 'Install it for me' }}
                </button>
              </div>
              @if (!it.driven) { <p class="small">{{ it.drivenWhy }}</p> }
              @if (installSaid(); as said) { <p class="small warn">{{ said }}</p> }
              <p class="small">
                Crucible's own documentation, which is the argument behind every line above:
                {{ it.readme }}
              </p>
            }
          } @else {
            <p class="small">Looking at this machine…</p>
          }
        </div>
      }

      <!-- ── 4. Remove ─────────────────────────────────────────────────── -->
      @if (canUninstall() && uninstall() !== null && uninstall()!.available) {
        <button class="door" type="button" (click)="toggle('uninstall')">
          <span class="door-name">Remove the engine from this computer</span>
          <span class="door-note">
            Uninstall Crucible. Your books are never touched, and the models it downloaded are
            kept unless you say otherwise.
          </span>
        </button>
        @if (open() === 'uninstall') {
          <div class="panel">
            <!--
              BOTH BOXES DEFAULT OFF, and changing either clears the plan on
              screen before asking for a new one: a Remove button sitting over
              rows that were priced for different flags is the one thing a
              confirmation exists to prevent. The re-ask is section 6.4's own
              instruction, so the kept figure moves with the box. (NO BACKTICKS
              ANYWHERE IN THIS TEMPLATE, not even in a comment.)
            -->
            <label class="check">
              <input type="checkbox" name="uPurge" [ngModel]="purgeWeights()"
                     [disabled]="busy() !== null" (ngModelChange)="setPurgeWeights($event)">
              <span>
                Also delete the downloaded models — tens of gigabytes, and a reinstall downloads
                every byte again. Off, they are kept and the next install finds them.
              </span>
            </label>
            @if (uninstall()!.wslTooOffered) {
              <label class="check">
                <input type="checkbox" name="uWsl" [ngModel]="wslToo()"
                       [disabled]="busy() !== null" (ngModelChange)="setWslToo($event)">
                <span>
                  Also remove the WSL2 engine inside the guest. The distro itself is never
                  unregistered — every other distro on this machine is yours, and so is that
                  decision.
                </span>
              </label>
            }

            @if (shownPlan(); as it) {
              <!--
                THE ROWS, AS THE PLAN SENT THEM: the server's own sentence, its
                action word, and its size when the step has one. A size is
                absent when the target is a unit, a pid or a distro, which
                section 6.3 says is not zero.
              -->
              <div class="rows">
                @for (step of it.steps; track step.name) {
                  <div class="row" [class.fatal]="isFatal(step.refused)">
                    <span class="act">{{ step.action }}</span>
                    <span class="what">
                      {{ step.what }}
                      @if (step.refused; as no) { <span class="said">— {{ no.message }}</span> }
                    </span>
                    @if (step.bytes !== null) { <span class="size">{{ size(step.bytes) }}</span> }
                    @if (step.done) { <span class="size">done</span> }
                  </div>
                }
              </div>
              <p class="small">{{ uninstallSaid() }}</p>
              @if (!it.ok) {
                <p class="warn">
                  A step refused, above, by name. Everything that DID finish is gone; nothing is
                  half-removed silently.
                </p>
              }
              @if (removed() === null) {
                <p class="small">
                  Uninstalling removes this engine's token, so every app that was paired with it —
                  this one included — has to be paired again afterwards.
                </p>
                @if (packRow(); as pack) {
                  <p class="small">
                    Crucible's own program files stay where they are: the plan keeps them as
                    {{ pack }}, and only Crucible's own installer script removes that and the
                    folder around it.
                  </p>
                }
              } @else if (unregistered(); as gone) {
                <p class="small">
                  {{ gone }} was removed from the list above — its token went with the uninstall.
                </p>
              }
            }

            <div class="actions">
              @if (removed() !== null) {
                <button class="ghost" type="button" (click)="closeUninstall()">Close</button>
              } @else if (uninstallPlan() === null) {
                <button class="ghost" type="button" [disabled]="busy() !== null"
                        (click)="showPlan()">
                  {{ busy() === 'uninstall-plan' ? 'Checking…' : 'Show me what would go' }}
                </button>
              } @else {
                <button class="danger" type="button" [disabled]="busy() !== null"
                        (click)="removeIt()">
                  {{ busy() === 'uninstall-run' ? 'Removing…' : 'Remove it' }}
                </button>
                <button class="ghost" type="button" [disabled]="busy() !== null"
                        (click)="closeUninstall()">Cancel</button>
              }
            </div>
            @if (uninstallRefusal(); as why) { <p class="warn">{{ why }}</p> }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .doors { display: flex; flex-direction: column; gap: 6px; }

    .door {
      display: flex; flex-direction: column; gap: 2px; align-items: flex-start; text-align: left;
      width: 100%; padding: 8px 10px;
      background: var(--bg-input); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm); cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .door:hover { background: var(--bg-hover); border-color: var(--border-default); }
    .door-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .door-note { font-size: 11px; color: var(--text-tertiary); }

    /*
     * NOT A DOOR — it is the sentence above the doors, and the one control in it
     * is a retry of something the app already did. Drawn flat rather than as a
     * fourth pressable row, because a row that looked like the three below it
     * would read as a fourth alternative to them.
     */
    .blurb { display: flex; flex-direction: column; gap: 6px; padding: 0 2px 4px; }

    .panel {
      display: flex; flex-direction: column; gap: 8px;
      padding: 10px; margin-bottom: 4px;
      background: var(--bg-sunken); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
    }

    .field { display: flex; flex-direction: column; gap: 4px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; word-break: break-word; }
    .warn { color: var(--warn); margin: 0; font-size: 12px; }
    .ok { color: var(--ok); }

    .steps { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
    .steps li { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
    .step-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .step-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .cmd {
      display: block; font-family: var(--font-mono); font-size: 11px;
      background: var(--bg-input); border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm); padding: 5px 7px;
      user-select: all; word-break: break-all;
    }

    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--accent); background: var(--accent-soft); border-radius: 999px; padding: 2px 8px;
    }
    .badge.held { color: var(--ok); background: var(--ok-soft); }

    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary { border: none; background: var(--accent); color: var(--text-inverse); }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost { background: var(--bg-input); border: 1px solid var(--border-default); color: var(--text-primary); }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }
    /* The uninstall plan's rows, and the one control that is not a door. */
    .check { display: flex; align-items: flex-start; gap: 6px; font-size: 11px; color: var(--text-secondary); }
    .check input { margin-top: 2px; flex: 0 0 auto; }
    .rows { display: flex; flex-direction: column; gap: 2px; }
    .row { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--text-secondary); }
    .row.fatal, .row.fatal .act, .row.fatal .said { color: var(--warn); }
    .act {
      flex: 0 0 auto; min-width: 46px;
      font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
      letter-spacing: 0.06em; color: var(--text-tertiary);
    }
    .what { flex: 1; min-width: 0; }
    .said { color: var(--text-tertiary); }
    .size { flex: 0 0 auto; font-size: 10px; color: var(--text-tertiary); }

    .danger {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1; cursor: pointer;
      border: 1px solid var(--warn); background: transparent; color: var(--warn);
    }
    .danger:disabled { opacity: 0.5; cursor: not-allowed; }
  `],
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


  /** The words file's, exposed because a template cannot call a bare import. */
  protected readonly cardWords = cardWords;

  protected readonly isWindows = api?.platform === 'win32';
  protected readonly open = signal<DoorId | null>(null);
  protected readonly plan = signal<CrucibleInstallPlan | null>(null);
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
    this.destroyRef.onDestroy(() => this.cancelRemotePairing());
    if (!api) return;
    /*
     * AND MAIN'S PROOF FOR DOOR 4, once. It is a read — a file test, and one
     * wsl.exe call only on the machine that has Crucible in a guest and no
     * Windows host. The wizard asks it too and throws the answer away, because
     * `canUninstall` is false there and nothing is drawn either way; making the
     * call conditional would put the decision in two places.
     */
    void this.askUninstall();
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

  private async loadPlan(): Promise<void> {
    if (!api) return;
    this.plan.set(await api.crucible.installPlan());
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
   * Crucible sentence in this app is. The line subscription is what makes the
   * wait legible: an installer that fetches a release, unpacks an env pack and
   * starts a service is minutes of silence otherwise.
   */
  protected async drive(): Promise<void> {
    if (!api) return;
    this.busy.set('install');
    this.installSaid.set(null);
    const unsubscribe = api.crucible.onInstallLine((line) => this.installSaid.set(line));
    try {
      await api.crucible.install();
      this.installSaid.set('Crucible is running and connected.');
      await this.loadPlan();
      this.changed.emit();
    } catch (err) {
      this.installSaid.set(err instanceof Error ? err.message : String(err));
    } finally {
      unsubscribe();
      this.busy.set(null);
    }
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
