import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type {
  CrucibleDiscoveryVia, CrucibleProbeResult, CrucibleServersView,
} from '@shared/crucible/settings-wire';
import type { CrucibleCoordinationState } from '@shared/crucible/coordinate-wire';
import { coordinationWords, sizeWords } from './crucible-words';
import type {
  CrucibleHostRefusal,
  CrucibleInstallPlan,
} from '@shared/crucible/install-wire';
import type { CrucibleUninstallPlan } from '@shared/crucible/uninstall-wire';
import type { CruciblePairingPrompt } from '@shared/crucible/connect-wire';
import { CrucibleEngineControlsComponent } from './crucible-engine-controls.component';
import { CrucibleInstallProgressComponent } from './crucible-install-progress.component';

/**
 * HOW A PERSON GETS A CRUCIBLE — and, since PHASE13, how little of that is
 * BookForge's to draw.
 *
 * ── WHAT CHANGED, 2026-09-14 ───────────────────────────────────────────────
 *
 * Crucible serves its OWN operator page (PHASE13-OPERATOR.md §0, §4).
 * Everything a person does to a server after it exists happens there: install a
 * job type, pull weights, watch the progress, read the token. What that deletes
 * here is most of door 3 — the printed step list for the parts a page can do,
 * and the pull list, which was BookForge restating six weight ids the crucible
 * manifests own. What it leaves is two doors and one button:
 *
 *   1. **Connect** — ONE field, the address (PHASE19 §3).
 *   2. **Get one on this machine** — the pre-server minute, the chicken-and-egg
 *      a page cannot do for itself.
 *
 * ── AND SINCE PHASE19, NO TOKEN AND NO COMMAND ANYWHERE ON IT ─────────────
 *
 * Owen, 2026-09-18: *"we removed tokens. this system is supposed to work like
 * ollama, which doesn't require a token request/approval to connect. its
 * protection is the system firewall."* Deleted with that ruling: the
 * `crucible://` paste box, the Name / Address / Access key triple, Test and
 * Add, and — with *"we should assume they have no idea how to do it and it
 * should do it automatically"* — the "Show what it does" step list and the
 * "Commands BookForge cannot run for you" list beneath it. **Nobody is ever
 * shown a command**, and the steps are the progress list now.
 *
 * ── ONE KIND OF SERVER (Owen's ruling, 2026-09-15) ──────────────────────
 *
 * *"a local crucible server shouldnt be treated any differently than a remote
 * crucible server. it should all be entered the exact same way."* There is no
 * reserved name here any more and no door that adds a different sort of thing.
 * Door 2 used to say "use the engine on this machine", meaning a row the app
 * manufactured out of a config file; it now says **add** it, and what it adds
 * is a registry entry under a name the operator typed, through the same
 * `addServer` every other door ends in. The only thing that makes it its own
 * door is that the address and the key are already known, so nobody has to
 * copy them out of a file inside a WSL guest.
 *
 * ── THE TWO FACES THIS COMPONENT HAS, AND WHY ──────────────────────────────
 *
 * `mode = 'doors'` is Settings → Crucible Servers: three collapsed doors,
 * nothing measured until one is opened, because composing the install plan
 * spawns `wsl.exe -l -v` and an `nvidia-smi` query and a settings page must not
 * cost a second of somebody's time to answer a question they did not ask.
 *
 * `mode = 'probing'` is the WIZARD's Crucible step (§5.5). It PROBES ON ENTRY
 * and shows exactly ONE of three faces — connected / install here / connect
 * only — because a person setting the app up for the first time is being asked
 * "which server", not "read these three options and work out which applies to
 * you". The decision itself is main's (`hostabilityOf`, on the plan as
 * `hostable`): the renderer draws a verdict rather than making a second one out
 * of the same nulls.
 *
 * ── THERE IS NO "SET UP FOR BOOKFORGE" BUTTON ─────────────────────
 *
 * It was deleted on 2026-09-14 (crucible `docs/PHASE14-ENVPACKS.md` §4a, Owen:
 * *"if its present, bookforge should coordinate with the installed crucible to
 * make sure it has what it needs"*). Presence of the app is the request, so
 * what these faces draw is the coordination STATE — checking, preparing,
 * waiting with the holder named, or the named refusal — and the only button on
 * the wizard's connected face is the wizard's own Next.
 *
 * A `server_busy` held by a LEASE shows the HOLDER, verbatim, because that
 * means another app on that machine is mid-run: somebody shown a dead screen
 * with no name concludes the app is broken.
 *
 * It owns NO STATE beyond what is being typed and what the running task has
 * said. Every door ends in a call to `electron.crucible.*`, main answers, and
 * the host re-reads through its own door — `changed` is the whole of what this
 * emits.
 */
@Component({
  selector: 'app-crucible-doors',
  standalone: true,
  imports: [
    CommonModule, FormsModule, DesktopButtonComponent,
    CrucibleEngineControlsComponent, CrucibleInstallProgressComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mode() === 'probing') {
      <!-- ══ THE WIZARD'S STEP: ONE FACE, CHOSEN BY A PROBE ═══════════════ -->
      <div class="doors">
        @if (plan(); as p) {
          @if (face() === 'connected') {
            <!-- ── Connected: at least one engine is registered ─────────── -->
            <div class="panel">
              <p class="ok">
                {{ serverCount() === 1 ? 'One engine is connected' : serverCount() + ' engines are connected' }}:
                <strong>{{ serverNames() }}</strong>
              </p>
              <p class="hint">
                @if (coordinationDeferred() === 'first-run') {
                  Choose your AI routes on the next step. Models are prepared when you finish setup.
                } @else if (coordinationDeferred() === 'install') {
                  This computer is still setting up its faster Linux engine. What BookForge needs is
                  installed onto whichever engine is left standing, not onto the one being replaced.
                } @else {
                BookForge is checking and preparing these engines for your projects.
                Progress appears below. Which one a book goes to is the order in
                Settings → Crucible Servers.
                }
              </p>
              <!--
                NOTHING TO PRESS. Coordination is not a decision (the brief of
                2026-09-14 §4, crucible PHASE14 §4a): the engine is registered,
                BookForge has already told it what it needs, and the only button
                on this step is Next, which belongs to the wizard.
              -->
              <ng-container [ngTemplateOutlet]="coordinationState" />
              @if (registeredHere(); as name) {
                <app-crucible-engine-controls [server]="name" />
              }
            </div>
          } @else if (face() === 'adopt') {
            <!-- ── There is one on this computer; it just is not added ──── -->
            @if (discovered(); as d) {
              @if (d.present) {
                <div class="panel">
                  <p class="ok"><strong>{{ d.serverName }}</strong> at {{ d.url }}</p>
                  <p class="hint">
                    {{ discoveredSourceWords(d.via) }} <code>{{ d.configPath }}</code>. Add it and
                    BookForge will use it like any other engine.
                  </p>
                  <ng-container [ngTemplateOutlet]="adoptForm" />
                </div>
              }
            }
          } @else if (face() === 'install') {
            <!-- ── This machine can host one (or nothing says it cannot) ── -->
            <!--
              ONE SENTENCE, NOT A COMMAND LIST (the brief §4). A person meeting
              this app for the first time is being asked WHICH ENGINE, and a
              wizard that answered with eight shell commands has handed the
              question back. The printed sequence still exists for a terminal
              person — behind "Show the manual steps" in Settings → Crucible
              Servers — and the driven installer arrives with the next release.
            -->
            <div class="panel">
              <p class="machine">{{ p.machine }}</p>
              <p class="hint">{{ p.hostableWhy }}</p>
              <div class="driven">
                <desktop-button variant="primary" size="sm" [disabled]="!p.driven || busy() !== null" (click)="runInstall()">
                  {{ busy() === 'install' ? 'Installing Crucible…' : 'Install Crucible (recommended)' }}
                </desktop-button>
                <!--
                  THE REASON COMES FROM MAIN, NOT FROM HERE. A sentence written
                  into the template is a second owner of "can this machine have
                  one", and the two said different things for a day: this one
                  claimed the installer had not shipped while the plan already
                  knew whether the platform had a backend at all.
                -->
                @if (!p.driven && p.drivenWhy) { <span class="driven-why">{{ p.drivenWhy }}</span> }
              </div>
              @if (installRefusal(); as r) {
                <p class="bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
                @if (r.command) { <pre class="cmd">{{ r.command }}</pre> }
                @if (r.detail) { <p class="detail">{{ r.detail }}</p> }
              }
              <!--
                ONE LIST, NOT TWO (PHASE19 §2.8). The coordination state is an
                INPUT to the progress list rather than a second block beneath
                it: "installing what BookForge needs" and "downloading models"
                are the last rows of the same sequence.
              -->
              <ng-container [ngTemplateOutlet]="installProgress" />
              <ng-container [ngTemplateOutlet]="connectForm" />
            </div>
          } @else {
            <!-- ── Not hostable: connect only, and say why by name ──────── -->
            <div class="panel">
              <p class="machine">{{ p.machine }}</p>
              <p class="bad">{{ p.hostableWhy }}</p>
              <p class="hint">
                That is a state, not a fault. A laptop that renders on another machine is a laptop
                with one engine somewhere else, and BookForge reaches it the same way either way.
              </p>
              <ng-container [ngTemplateOutlet]="connectForm" />
            </div>
          }
        } @else if (error(); as e) {
          <p class="bad">{{ e }}</p>
        } @else {
          <p class="hint">Looking for a Crucible…</p>
        }
      </div>
    } @else {
      <!-- ══ SETTINGS: THE DOORS, CLOSED UNTIL ONE IS OPENED ══════════════ -->
      <div class="doors">
        <!-- ── 1. Connect to one elsewhere ─────────────────────────────── -->
        <button class="door" type="button" (click)="toggle('connect')">
          <span class="door-name">Connect to an engine on another machine</span>
          <span class="door-note">
            One already running somewhere else — another desk, another room. Nothing is installed here.
          </span>
        </button>
        @if (open() === 'connect') {
          <div class="panel">
            <ng-container [ngTemplateOutlet]="connectForm" />
          </div>
        }

        <!-- ── 2. Add the one already on this computer ─────────────────── -->
        <button class="door" type="button" (click)="toggle('here')">
          <span class="door-name">Add the engine already on this computer</span>
          <span class="door-note">
            Its address and key are already here, so there is nothing to paste — only a name to
            choose.
          </span>
        </button>
        @if (open() === 'here') {
          <div class="panel">
            @if (discovered(); as d) {
              @if (d.present) {
                <p class="ok"><strong>{{ d.serverName }}</strong> at {{ d.url }}</p>
                <p class="hint">
                  {{ discoveredSourceWords(d.via) }} <code>{{ d.configPath }}</code>{{ d.via === 'wsl' ? ' inside WSL' : '' }},
                  key {{ d.tokenMasked }}.
                </p>
                @if (d.registeredAs; as name) {
                  <p class="hint">
                    Already added, as <strong>{{ name }}</strong>. It is a row in the list above
                    like any other engine — rank it, switch it off, remove it — and BookForge has
                    already made sure it has what it needs.
                  </p>
                  <!--
                    "OPEN ENGINE CONSOLE" IS GONE (2026-09-17), with its twin in
                    the servers panel. Owen: *"no more opening a crucible page in
                    bookforge settings."* What it was for is in Settings, AI now
                    - models per class, downloads, voices - and the engine still
                    serves its own page at its own address for anyone who wants
                    it. Test it stays: proving the thing answers is this door's
                    own job and belongs to the door.
                  -->
                  <div class="actions">
                    <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="testHere(name)">
                      {{ busy() === 'here' ? 'Testing…' : 'Test it' }}
                    </desktop-button>
                  </div>
                  @if (hereProbe(); as p) {
                    @if (p.outcome === 'ok') {
                      <p class="ok">
                        Answering — v{{ p.facts.version ?? 'not stated' }} · {{ p.facts.backend ?? 'backend not stated' }} ·
                        {{ p.facts.gpu?.name ?? 'GPU not stated' }} · job types {{ p.facts.jobTypes.join(', ') }}
                      </p>
                    } @else {
                      <p class="bad"><span class="code">{{ p.outcome }}</span> {{ p.message }}</p>
                    }
                  }
                  <ng-container [ngTemplateOutlet]="coordinationState" />
                } @else {
                  <ng-container [ngTemplateOutlet]="adoptForm" />
                }
              } @else {
                <p class="bad"><span class="code">{{ d.code }}</span> {{ d.reason }}</p>
                <p class="hint">
                  That is a state, not a fault — a machine that only ever renders on another one
                  has no engine of its own and does not need one. The third door sets one up here.
                </p>
              }
            } @else {
              <p class="hint">Looking for a Crucible on this computer…</p>
            }
          </div>
        }

        <!-- ── 3. Get one on this machine ──────────────────────────────── -->
        <button class="door" type="button" (click)="toggle('install')">
          <span class="door-name">Set an engine up on this machine</span>
          <span class="door-note">
            Install the shared engine and connect it automatically. BookForge manages its
            settings and the models your projects need.
          </span>
        </button>
        @if (open() === 'install') {
          <div class="panel">
            @if (plan(); as p) {
              <p class="machine">{{ p.machine }}</p>
              <p class="hint">{{ p.hostableWhy }}</p>
              <ng-container [ngTemplateOutlet]="installBody" [ngTemplateOutletContext]="{ p: p }" />
            } @else if (error(); as e) {
              <p class="bad">{{ e }}</p>
            } @else {
              <p class="hint">Measuring this machine…</p>
            }
          </div>
        }

        <!-- ── 4. Take it off again ────────────────────────────────────── -->
        <!--
          THE DOOR IS DRAWN ONLY WHEN THERE IS SOMETHING TO REMOVE, and only
          for THIS MACHINE's engine (ruling 2026-09-15, taken with Foundry so
          both apps draw the same door). A remote row never grows this button:
          crucible uninstall deletes a service, a home directory and possibly
          tens of gigabytes, and a door that could reach the Mac Studio from a
          laptop is a door that will. Main refuses uninstall_not_local as
          well — by comparing the named row's URL with the address of the
          Crucible found here, not by trusting a name — because a disabled
          control over an open door is a decoration.

          It needs the engine to be REGISTERED, because the door names a row.
          An engine sitting on this computer that nobody has added has no name
          to uninstall by; add it first, or uninstall it where it lives.
        -->
        @if (registeredHere() !== null) {
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
                THE DRY RUN IS SHOWN FIRST AND IS NOT OPTIONAL. It is the SAME
                plan object the real run performs — Crucible's own rule, which
                is the only definition of "dry run" that cannot drift — so what
                is on the screen is what will happen, step by step, with the
                size of every path.
              -->
              <label class="check">
                <input type="checkbox" [(ngModel)]="purgeWeights" name="cruPurge" (change)="uninstallPlan.set(null)" />
                <span>
                  Also delete the downloaded models — tens of gigabytes, and a reinstall downloads
                  every byte again. Off, they are kept and the next install finds them.
                </span>
              </label>
              @if (canWslToo()) {
                <label class="check">
                  <input type="checkbox" [(ngModel)]="wslToo" name="cruWslToo" (change)="uninstallPlan.set(null)" />
                  <span>
                    Also remove the WSL2 engine inside the guest. The distro itself is never
                    unregistered — every other distro on this machine is yours, and so is that
                    decision.
                  </span>
                </label>
              }
              <div class="actions">
                <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="loadUninstallPlan()">
                  {{ busy() === 'uninstall-plan' ? 'Checking…' : 'Show me what would go' }}
                </desktop-button>
                @if (uninstallPlan(); as u) {
                  @if (u.dryRun) {
                    <desktop-button variant="danger" size="sm" [disabled]="busy() !== null" (click)="runUninstall()">
                      {{ busy() === 'uninstall' ? 'Removing…' : 'Remove it' }}
                    </desktop-button>
                  }
                }
              </div>
              @if (uninstallRefusal(); as r) {
                <p class="bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
                @if (r.command) { <pre class="cmd">{{ r.command }}</pre> }
                @if (r.detail) { <p class="detail">{{ r.detail }}</p> }
              }
              @if (uninstallPlan(); as u) {
                <p class="hint">
                  Through <code>{{ u.ranThrough }}</code> — {{ u.mechanism }}, home
                  <code>{{ u.home }}</code>{{ u.backendKind ? ', backend ' + u.backendKind : '' }}.
                </p>
                <ol class="steps">
                  @for (st of u.steps; track st.name) {
                    <li class="step" [class.done]="st.done">
                      <div class="step-head">
                        <span class="code">{{ st.action }}</span>
                        <span class="step-title">{{ st.what }}</span>
                        @if (st.bytes !== null) { <span class="tick">{{ sizeOf(st.bytes) }}</span> }
                        @if (st.done) { <span class="tick">&#10003; done</span> }
                      </div>
                      <p class="detail"><code>{{ st.target }}</code></p>
                      @if (st.refused; as ref) {
                        <p class="bad"><span class="code">{{ ref.code }}</span> {{ ref.message }}</p>
                      }
                    </li>
                  }
                </ol>
                <p class="hint">
                  @if (u.dryRun) {
                    Nothing has been touched. Kept: {{ sizeOf(u.keptWeightsBytes) }} of models
                    @if (u.keptPaths.length > 0) { <span>in {{ u.keptPaths.length }} folder(s)</span> }.
                  } @else {
                    Freed {{ sizeOf(u.removedBytes) }}. Kept {{ sizeOf(u.keptWeightsBytes) }} of
                    models @if (u.keptPaths.length > 0) { <span>in {{ u.keptPaths.length }} folder(s)</span> }.
                  }
                </p>
                @if (!u.ok) {
                  <p class="bad">
                    A step refused, above, by name. Everything that DID finish is gone; nothing is
                    half-removed silently.
                  </p>
                }
              }
              @if (uninstallLine(); as l) { <pre class="cmd">{{ l }}</pre> }
            </div>
          }
        }
      </div>
    }

    <!-- ══ THE PIECES, WRITTEN ONCE AND USED BY BOTH FACES ════════════════ -->

    <ng-template #connectForm>
      <label class="field">
        <span class="flabel">Other computer's IP address or hostname</span>
        <input type="text" placeholder="192.0.2.20" [(ngModel)]="draftAddress" name="cruPairAddress"
          [disabled]="busy() !== null" (keyup.enter)="connectAddress()" />
      </label>
      <div class="actions">
        <desktop-button variant="primary" size="sm" [disabled]="busy() !== null || !draftAddress.trim()" (click)="connectAddress()">
          {{ busy() === 'pair' ? 'Waiting for approval…' : 'Connect' }}
        </desktop-button>
        @if (busy() === 'pair') {
          <desktop-button variant="ghost" size="sm" (click)="cancelPairing()">Cancel</desktop-button>
        }
      </div>
      <!--
        THE PAIRING COPY IS FOUNDRY'S (PHASE19 §4, §5).

        It used to say "Match this code … Waiting for approval…", which was the
        shape of a system that had tokens and approvals. Owen, 2026-09-18: *"we
        removed tokens. this system is supposed to work like ollama, which
        doesn't require a token request/approval to connect. its protection is
        the system firewall."* Pairing is OPEN, so the ordinary case is
        connected in two seconds and no code is ever seen. The code line stays
        for the one case that earns it — an operator who set
        "open_pairing = false" on that engine — and it is theirs to have chosen.
      -->
      @if (pairPrompt(); as request) {
        @if (pairStatus() === 'pending') {
          <p class="ok">Connecting to {{ request.name }}…
            If that computer asks anyone to approve this, the code is
            <strong>{{ request.userCode }}</strong>.</p>
        } @else if (pairStatus() === 'approved') {
          <p class="ok">Connected to {{ request.name }}.</p>
        } @else {
          <p class="bad">Pairing {{ pairStatus() }}. Connect again to request a new code.</p>
        }
      }
      @if (error(); as e) { <p class="bad">{{ e }}</p> }
    </ng-template>

    <!--
      THE SAME ADD, WITH NOTHING TO TYPE AT ALL.

      THE NAME FIELD IS GONE (PHASE19 §4). It used to be one control — "Call
      it" — prefilled from discovery, and that made three things claim to name
      one engine: the pairing file, whatever was in the box, and "/v1/info"'s
      "server.name", which is the only one the engine itself answers with and
      the one "auto-connect.ts" already verifies against. So the name is READ
      FROM THE ENGINE, in main, over the connection this button is about to
      save, and this door is one button. The address and the key came off this
      computer already and the key never reaches this component at all.
    -->
    <ng-template #adoptForm>
      <p class="hint">
        It is added under the name it calls itself, which is what every other computer on your
        network will see it as. Rank it, switch it off or remove it in the list above, like any
        other engine.
      </p>
      <div class="actions">
        <desktop-button
          variant="primary"
          size="sm"
          [disabled]="busy() !== null"
          (click)="adopt()"
        >
          {{ busy() === 'adopt' ? 'Adding…' : 'Add it' }}
        </desktop-button>
      </div>
      @if (error(); as e) { <p class="bad">{{ e }}</p> }
    </ng-template>

    <ng-template #installBody let-p="p">
      <!-- Every null carries a named refusal with the command that clears it. -->
      @if (p.host.refusals.length > 0) {
        <div class="refusals">
          @for (r of p.host.refusals; track r.code) {
            <div class="refusal">
              <p class="bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
              @if (r.command) { <pre class="cmd">{{ r.command }}</pre> }
              @if (r.detail) { <p class="detail">{{ r.detail }}</p> }
            </div>
          }
        </div>
      }

      <!--
        THE BUTTON IS DISABLED AND SAYS WHY. It is drawn at all because the
        sentence it wears is the honest state of the thing — a screen that
        simply omitted the guided install would not tell anybody that one
        exists and is coming.
      -->
      <div class="driven">
        <desktop-button variant="primary" size="sm" [disabled]="!p.driven || busy() !== null" (click)="runInstall()">
          {{ busy() === 'install' ? 'Installing Crucible…' : 'Install Crucible' }}
        </desktop-button>
        @if (!p.driven && p.drivenWhy) { <span class="driven-why">{{ p.drivenWhy }}</span> }
      </div>
      @if (installRefusal(); as r) {
        <p class="bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
        @if (r.command) { <pre class="cmd">{{ r.command }}</pre> }
        @if (r.detail) { <p class="detail">{{ r.detail }}</p> }
      }
      <ng-container [ngTemplateOutlet]="installProgress" />
      <!--
        "SHOW WHAT IT DOES" IS GONE, WITH THE STEP LIST AND THE ELEVATED LIST
        BEHIND IT (PHASE19 §3, §4).

        It was a disclosure that unfolded into "What the button will do, in
        order" and, under it, "Commands BookForge cannot run for you" with a
        "sudo loginctl" line in it. Owen, 2026-09-18: *"we should assume the
        user doesn't know how to do it and it should do it automatically."*
        **Nobody is ever shown a command.** A command a person could run is a
        step the app should be running, and where the app truly cannot the
        sentence says what to change and where — which is the "cannot"
        verdict's job, above, not a printed list's.

        The steps are the PROGRESS LIST now: "installProgress" is them as they
        happen, which is what a person actually wanted when they opened this.
      -->
    </ng-template>

    <!--
      GETTING A CRUCIBLE, AS ONE LIST (crucible PHASE19 §3.1).

      It used to be three loose rows this component kept — the WSL state, the
      step, the last line — which was the right shape for an install THIS APP
      drove and the wrong one for a move the orchestrator starts by itself at
      login. "app-crucible-install-progress" reads the install DOOR, so it
      shows a move that began before this window existed, and it carries the
      two controls a person can genuinely press.

      The coordination state goes IN, rather than being drawn after: §2.8 makes
      "installing what BookForge needs" and "downloading models" the LAST TWO
      ROWS of the same list, because they are where the gigabytes are and a
      list that said "done" before them would be lying about what is left.
    -->
    <ng-template #installProgress>
      <app-crucible-install-progress [coordination]="coordination()" />
    </ng-template>

    <!--
      WHAT BOOKFORGE IS DOING WITH THIS ENGINE, and nothing to press
      (crucible docs/PHASE14-ENVPACKS.md §4a). Every word of it comes from
      crucible-words.ts, which is the only file in the app that turns a job
      type into “the narration engine”.
    -->
    <ng-template #coordinationState>
      @if (setupError(); as e) { <p class="bad">{{ e }}</p> }
      @if (coordination(); as c) {
        <div class="module">
          <p class="hint"><strong>{{ words(c) }}</strong></p>
          @if (c.phase === 'preparing') {
            @if (c.progress.line) { <pre class="cmd">{{ c.progress.line }}</pre> }
            @if (c.progress.state === 'failed') {
              <p class="detail">
                Everything that finished is still on that machine. BookForge picks up where it
                stopped the next time it reaches this engine.
              </p>
            }
            @if (c.progress.state === 'running' && c.progress.taskId) {
              <div class="actions">
                <desktop-button variant="ghost" size="sm" (click)="cancelSetUp(c.server, c.progress.taskId)">Stop</desktop-button>
              </div>
            }
          }
        </div>
      }
    </ng-template>
  `,
  styles: [`
    .doors { display: flex; flex-direction: column; gap: 8px; max-width: 820px; }
    .door {
      display: flex; flex-direction: column; gap: 2px; text-align: left;
      padding: 10px 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid var(--border-subtle, var(--border-default));
      background: var(--bg-surface, var(--surface-1)); color: var(--text-primary);
    }
    .door:hover { border-color: var(--accent, var(--accent-primary)); }
    .door-name { font-size: 13px; font-weight: 600; }
    .door-note { font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
    .panel {
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px; border-radius: 8px; margin: -2px 0 6px;
      border: 1px solid var(--border-subtle, var(--border-default));
      background: var(--bg-elevated, var(--surface-2));
    }
    .field { display: flex; align-items: center; gap: 8px; }
    .flabel { font-size: 12px; color: var(--text-secondary); min-width: 130px; }
    .field input {
      flex: 1; padding: 6px 8px; border-radius: 6px; font-size: 13px;
      border: 1px solid var(--border-default); background: var(--bg-input, var(--surface-1));
      color: var(--text-primary);
    }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .hint, .detail { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
    .detail { color: var(--text-tertiary, var(--text-secondary)); }
    .machine { margin: 0; font-size: 12px; color: var(--text-primary); font-weight: 500; }
    .ok { margin: 0; font-size: 12px; line-height: 1.45; color: var(--text-secondary); }
    .bad { margin: 0; font-size: 12px; line-height: 1.45; color: var(--error, #d05a5a); }
    .code {
      font-family: var(--font-mono, monospace); font-size: 11px; padding: 0 4px;
      border-radius: 3px; margin-right: 5px;
      background: color-mix(in srgb, var(--error, #d05a5a) 18%, transparent);
    }
    .group { margin: 8px 0 0; font-size: 13px; font-weight: 700; color: var(--text-primary); }
    .steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 10px; }
    .step { display: flex; flex-direction: column; gap: 3px; }
    .step.done { opacity: 0.65; }
    .step-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .step-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
    .tick { font-size: 11px; color: var(--success, #4caf50); }
    /* A command box scrolls sideways rather than wrapping: a wrapped command is
       a command somebody pastes with a line break in the middle of it. */
    .cmd {
      margin: 2px 0 0; padding: 6px 8px; border-radius: 6px; overflow-x: auto;
      font-family: var(--font-mono, monospace); font-size: 11.5px; line-height: 1.5;
      background: var(--bg-surface, var(--surface-1)); color: var(--text-primary);
      border: 1px solid var(--border-subtle, var(--border-default)); white-space: pre;
    }
    .driven { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
    .driven-why { font-size: 12px; line-height: 1.45; color: var(--text-secondary); flex: 1; min-width: 240px; }
    .door.manual { margin-top: 4px; }
    .refusals { display: flex; flex-direction: column; gap: 8px; }
    .refusal { display: flex; flex-direction: column; gap: 2px; }
    .module {
      display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 6px;
      border: 1px solid var(--border-subtle, var(--border-default));
      background: var(--bg-surface, var(--surface-1));
    }
    code { font-family: var(--font-mono, monospace); background: var(--bg-surface, var(--surface-1)); padding: 0 4px; border-radius: 3px; }
  `],
})
export class CrucibleDoorsComponent {
  private readonly electron = inject(ElectronService);
  private readonly destroyRef = inject(DestroyRef);

  /**
   * `doors` (Settings) or `probing` (the wizard's step, §5.5).
   *
   * The difference is not cosmetic: `probing` MEASURES ON ENTRY and shows one
   * face, `doors` measures only when a door is opened. Both cost the same
   * `wsl.exe -l -v`, and the wizard is the one place somebody is already
   * waiting to be told what to do.
   */
  readonly mode = input<'doors' | 'probing'>('doors');

  /** Something landed that changes what the host's own list would say. */
  readonly changed = output<void>();

  readonly open = signal<'connect' | 'here' | 'install' | 'uninstall' | null>(null);
  readonly busy = signal<
    'adopt' | 'here' | 'install' | 'pair' | 'uninstall-plan' | 'uninstall' | null
  >(null);
  readonly error = signal<string | null>(null);

  draftAddress = '';
  readonly pairPrompt = signal<CruciblePairingPrompt | null>(null);
  /**
   * WHERE THAT CONNECTION GOT TO, which is a different fact from whether one
   * is in flight (Foundry's wording, PHASE19 §5). It survives the end of the
   * poll on purpose: "Connected to mac." is the sentence a person wants after
   * pressing Connect, and clearing the prompt to say it would leave the space
   * blank at the one moment it has news.
   */
  readonly pairStatus = signal<'pending' | 'approved' | 'denied' | 'expired'>('pending');
  private pairTimer: ReturnType<typeof setTimeout> | null = null;
  private pairGeneration = 0;
  readonly hereProbe = signal<CrucibleProbeResult | null>(null);

  readonly plan = signal<CrucibleInstallPlan | null>(null);
  readonly installRefusal = signal<CrucibleHostRefusal | null>(null);

  /**
   * WHERE COORDINATION WITH THE ENGINE ON THIS COMPUTER STANDS.
   *
   * Named by {@link registeredHere}, never by a reserved word: the faces that
   * draw it are about the engine this computer has, and that engine is a
   * registry row under whatever the operator called it. Every other server's
   * state belongs to its row in the servers panel.
   */
  readonly coordination = signal<CrucibleCoordinationState | null>(null);
  /**
   * WHY coordination has not happened yet, or null when nothing is holding it.
   *
   * TWO DEFERRALS, NOT ONE FLAG (PHASE19 §2.8). First-run holds it because the
   * AI routes are not chosen; an install holds it because this machine is
   * still moving to the Linux engine and the gigabytes would land on the
   * engine about to be replaced. They are different sentences, and a boolean
   * made the first-run one the answer to both.
   */
  readonly coordinationDeferred = signal<'first-run' | 'install' | null>(null);
  /** A stop that refused. Its own line, because it is about the STOP. */
  readonly setupError = signal<string | null>(null);
  /** Has the connected face already asked? One ask per mount, not one per paint. */
  private coordinateAsked = false;

  /**
   * WHAT THIS PAGE KNOWS ABOUT SERVERS — every registered one, the rank record,
   * and the OFFER of a Crucible found on this computer.
   *
   * Read here rather than taken from the install plan: the plan measures a
   * MACHINE (`wsl.exe -l -v`, `nvidia-smi`) and this is a question about a
   * registry, which is two file reads. It is also the only place that can say
   * whether the engine here has already been added, which is the difference
   * between an offer and a row.
   */
  readonly servers = signal<CrucibleServersView | null>(null);

  /** The offer, or the named reason there is none. Door 2's whole answer. */
  readonly discovered = computed(() => this.servers()?.discovered ?? null);

  /**
   * The NAME the engine on this computer is registered under, or null when it
   * is not registered. The only handle any door here has on it — there is no
   * reserved word to fall back on.
   */
  readonly registeredHere = computed<string | null>(() => {
    const found = this.discovered();
    return found !== null && found.present ? found.registeredAs : null;
  });

  readonly serverCount = computed<number>(() => this.servers()?.servers.length ?? 0);
  readonly serverNames = computed<string>(
    () => (this.servers()?.servers ?? []).map((row) => row.name).join(', '),
  );

  /**
   * WHICH ONE FACE the wizard's step shows (§5.5), from main's own verdict.
   *
   * `unknown` draws the INSTALL face deliberately: on Windows the card question
   * cannot be asked until there is a guest to ask it in, and the install
   * document's first step is the thing that settles it. Sending a machine with
   * an unmeasured card to "connect only" would be a wrong answer stated
   * confidently.
   */
  readonly face = computed<'connected' | 'adopt' | 'install' | 'connect-only' | null>(() => {
    const view = this.servers();
    if (view === null) return null;
    /*
     * CONNECTED MEANS "THERE IS AN ENGINE TO WORK ON", and since 2026-09-15
     * that is a registry question rather than a question about this machine.
     * A laptop pointed at the Mac Studio is connected; a PC with a Crucible
     * sitting on it that nobody has added is NOT, which is the `adopt` face —
     * one field and one button, because the address and the key are in hand.
     */
    if (view.servers.length > 0) return 'connected';
    if (view.discovered.present) return 'adopt';
    const plan = this.plan();
    if (plan === null) return null;
    return plan.hostable === 'no' ? 'connect-only' : 'install';
  });

  constructor() {
    this.destroyRef.onDestroy(() => this.cancelPairing());
    // The wizard's step measures on arrival; the settings page does not. One
    // effect rather than a lifecycle hook, because `mode` is a signal input and
    // a host could in principle change it.
    effect(() => {
      if (this.mode() === 'probing' && this.plan() === null && this.error() === null) {
        void this.loadPlan();
      }
    });

    // The registry read is cheap on every mount, and every face needs it.
    void this.loadServers();

    /*
     * THE WIZARD'S STEP LANDING ON "CONNECTED" IS A CONNECT (crucible
     * PHASE14 §4a), so it coordinates — and it is the same run app start
     * already began, because `coordinateServer` joins one in flight rather
     * than starting a second. That is why this can be unconditional: the
     * alternative, a screen deciding whether coordination is needed, is a
     * second opinion about something main already owns (R1).
     */
    effect(() => {
      const here = this.registeredHere();
      if (this.face() === 'connected' && here !== null && !this.coordinateAsked) {
        this.coordinateAsked = true;
        void this.coordinateHere(here);
      }
    });

    void this.readCoordination();
    const stop = this.electron.crucible.onCoordination((state) => {
      if (state.server === this.registeredHere()) {
        this.coordinationDeferred.set(null);
        this.coordination.set(state);
      }
    });
    this.destroyRef.onDestroy(stop);

    /*
     * THE INSTALL SUBSCRIPTION MOVED (PHASE19 §2.6). It used to live here and
     * keep three signals off `crucible:install-progress` — the state, the step
     * and the last line — which could only ever report an install THIS window
     * started. The move to the Linux engine is the orchestrator's and starts
     * at login, so watching it belongs to the thing that draws it:
     * `app-crucible-install-progress` reads the install DOOR.
     */

    const stopUninstall = this.electron.crucible.onUninstallProgress((line) => {
      this.uninstallLine.set(line.text);
    });
    this.destroyRef.onDestroy(stopUninstall);
  }

  /**
   * Open one door, close the others, and measure on demand.
   *
   * The install plan is NOT loaded in the constructor for `doors`: composing it
   * spawns `wsl.exe -l -v` and an `nvidia-smi` query, and a settings page that
   * probed a cold WSL VM every time it was opened would cost a second of
   * somebody's time to answer a question they did not ask. Door 2 needs the
   * same read, so both load it.
   */
  toggle(door: 'connect' | 'here' | 'install' | 'uninstall'): void {
    this.error.set(null);
    const next = this.open() === door ? null : door;
    this.open.set(next);
    if ((next === 'install' || next === 'here') && this.plan() === null) void this.loadPlan();
    /*
     * CLOSING THE UNINSTALL DOOR FORGETS ITS PLAN. A dry run is a measurement
     * of a machine at one moment; reopening the door half an hour later and
     * seeing yesterday's sizes over a live "Remove it" button is the one thing
     * this door must not do.
     */
    if (next !== 'uninstall') {
      this.uninstallPlan.set(null);
      this.uninstallRefusal.set(null);
      this.uninstallLine.set(null);
    }
  }

  async connectAddress(): Promise<void> {
    if (this.busy() !== null || !this.draftAddress.trim()) return;
    const generation = ++this.pairGeneration;
    this.error.set(null);
    this.busy.set('pair');
    try {
      const result = await this.electron.crucible.pairStart(this.draftAddress.trim());
      if (generation !== this.pairGeneration) return;
      if (!result.success || !result.data) throw new Error(result.error ?? 'Crucible did not return a connection request.');
      this.pairStatus.set('pending');
      this.pairPrompt.set(result.data);
      this.schedulePairPoll(generation, result.data);
    } catch (error) {
      if (generation !== this.pairGeneration) return;
      this.error.set((error as Error).message);
      this.cancelPairing();
    }
  }

  /**
   * STOP ASKING, AND KEEP WHAT WAS SAID. The prompt stays so the sentence
   * about it has a name in it; only the polling and the busy flag end.
   */
  private stopPolling(): void {
    ++this.pairGeneration;
    if (this.pairTimer !== null) clearTimeout(this.pairTimer);
    this.pairTimer = null;
    if (this.busy() === 'pair') this.busy.set(null);
  }

  cancelPairing(): void {
    this.stopPolling();
    this.pairPrompt.set(null);
    void this.electron.crucible.pairCancel();
  }

  private schedulePairPoll(generation: number, request: CruciblePairingPrompt): void {
    this.pairTimer = setTimeout(async () => {
      this.pairTimer = null;
      try {
        const result = await this.electron.crucible.pairPoll(request.requestId);
        if (generation !== this.pairGeneration) return;
        if (!result.success || !result.data) throw new Error(result.error ?? 'The connection check failed.');
        if (result.data.status === 'pending') { this.schedulePairPoll(generation, request); return; }
        /*
         * THE OUTCOME IS SAID WHERE THE ATTEMPT WAS (Foundry's wording,
         * PHASE19 §4). `stopPolling` rather than `cancelPairing`: cancelling
         * clears the prompt, and "Connected to mac." needs the name that was
         * in it. The door does NOT close itself on success any more either —
         * a panel that vanished the moment it worked would take its own good
         * news with it.
         */
        this.stopPolling();
        this.pairStatus.set(result.data.status);
        if (result.data.status === 'approved') {
          await this.loadServers();
          this.changed.emit();
        }
      } catch (error) {
        if (generation !== this.pairGeneration) return;
        this.error.set((error as Error).message);
        this.cancelPairing();
      }
    }, request.interval * 1000);
  }

  private async loadPlan(): Promise<void> {
    const res = await this.electron.crucible.installPlan();
    if (!res.success || !res.data) {
      // Never an empty plan on failure: an empty step list reads as "nothing to
      // do", and "this machine could not be measured" is a different sentence.
      this.error.set(res.error ?? 'This machine could not be measured, and nothing said why.');
      return;
    }
    this.plan.set(res.data);
  }

  /*
   * ── DOOR 1 IS ONE FIELD AND ONE BUTTON NOW (PHASE19 §3, §4) ──────────────
   *
   * `onPaste`, `readPairing`, `test` and `add` are DELETED with the controls
   * they served: the `crucible://` paste box, the Name/Address/Access key
   * triple, and Test/Add. Owen, 2026-09-18: *"we removed tokens. this system
   * is supposed to work like ollama, which doesn't require a token
   * request/approval to connect. its protection is the system firewall."*
   * Pairing is OPEN, so an address is the whole of what a person can be
   * expected to know, and `connectAddress()` above is the door.
   *
   * Nothing here parsed a pairing line by hand — that was main's, through the
   * SDK — so nothing is left orphaned by their going.
   */

  // ── Door 2, and the operator door beside it ──────────────────────────────

  /** Every registered server, plus whether the engine here is one of them. */
  private async loadServers(): Promise<void> {
    const res = await this.electron.crucible.servers();
    if (!res.success || !res.data) {
      // NOT an empty view: "there are no servers" and "the list could not be
      // read" are different sentences, and only one of them has a fix.
      this.error.set(res.error ?? 'The list of engines could not be read, and nothing said why.');
      return;
    }
    this.servers.set(res.data);
  }

  /**
   * ADD THE ENGINE ON THIS COMPUTER, UNDER THE NAME IT CALLS ITSELF.
   *
   * Ends in the same `addServer` the connect door does, with the same refusals
   * shown the same way. NOTHING crosses the seam now: the key may not
   * (`shared/crucible/settings-wire.ts`) and the name is read from `/v1/info`
   * in main, which is the one owner of what an engine is called (PHASE19 §4).
   */
  async adopt(): Promise<void> {
    this.busy.set('adopt');
    this.error.set(null);
    try {
      const res = await this.electron.crucible.addDiscovered();
      if (!res.success || !res.data) {
        this.error.set(res.error ?? 'It could not be added, and nothing said why.');
        return;
      }
      await this.loadServers();
      this.open.set(null);
      this.changed.emit();
    } finally {
      this.busy.set(null);
    }
  }

  async testHere(name: string): Promise<void> {
    this.busy.set('here');
    this.error.set(null);
    try {
      const res = await this.electron.crucible.test(name);
      if (!res.success || !res.data) {
        this.error.set(res.error ?? 'The test failed and said nothing about why.');
        return;
      }
      this.hereProbe.set(res.data);
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Open that server's own page (§5.3). The token is read in MAIN from the one
   * owner of it and never reaches this component.
   */
  /** The one sentence about coordination. Every word of it is in one file. */
  /**
   * WHICH OF THE TWO DOORS THE CRUCIBLE ON THIS COMPUTER CAME THROUGH.
   *
   * Since phase 15 there are two (crucible docs/PHASE15-HOST.md section 3.6):
   * the connect code the engine, or the Windows host, wrote beside its config,
   * and the config.toml itself - read directly on macOS and Linux, and through
   * wsl.exe on Windows. They are different artefacts written by different
   * parts of the system, so the row says which one answered rather than
   * calling both "read from".
   */
  discoveredSourceWords(via: CrucibleDiscoveryVia): string {
    if (via === 'pairing') return 'Found the connect code this engine left at';
    if (via === 'wsl') return 'Read, inside WSL, from';
    return 'Read from';
  }

  words(state: CrucibleCoordinationState): string {
    return coordinationWords(state);
  }

  /** Whatever main already knows about the engine on this computer. */
  private async readCoordination(): Promise<void> {
    const here = this.registeredHere();
    if (here === null) return;
    const res = await this.electron.crucible.coordination();
    if (!res.success || !res.data) return;
    const state = res.data[here];
    if (state !== undefined) this.coordination.set(state);
  }

  /**
   * Make sure this machine's engine has what BookForge needs.
   *
   * NOT A BUTTON and never called by one: it is what "BookForge found an
   * engine" means. It joins the run app start began rather than starting a
   * second one, so calling it on arrival costs a promise and nothing else.
   */
  private async coordinateHere(name: string): Promise<void> {
    const res = await this.electron.crucible.coordinate(name);
    // Spelled out rather than `?? null`: an ABSENT field means "nothing is
    // holding it", which is a fact, and a coalesce reads like a default.
    this.coordinationDeferred.set(res.deferred === undefined ? null : res.deferred);
    if (!res.success) {
      this.setupError.set(res.error
        ?? 'BookForge could not tell this machine\u2019s engine what it needs, and nothing said why.');
      return;
    }
    if (res.data) this.coordination.set(res.data);
    this.changed.emit();
  }

  /** Stop the work this engine is doing for BookForge. */
  async cancelSetUp(name: string, taskId: string | null): Promise<void> {
    if (taskId === null) return;
    const res = await this.electron.crucible.cancelSetUp(name, taskId);
    if (!res.success) {
      this.setupError.set(res.error ?? 'Stopping that refused and said nothing about why.');
    }
  }

  // ── Door 3 ───────────────────────────────────────────────────────────────

  /**
   * Press the guided install. It refuses today — see `electron/crucible/
   * install.ts` — and the refusal is drawn with its code and its command, the
   * same shape `@crucible/bootstrap` will hand back when it is the one
   * refusing.
   *
   * WHEN IT SUCCEEDS IT POSTS THE MODULE (§5.5, rollout §0b C2). The driven
   * install ends with a server that answers and holds nothing — no job
   * environments, no weights — and leaving somebody there with a second button
   * to find would be handing them the install story back in two halves.
   */
  async runInstall(): Promise<void> {
    this.busy.set('install');
    this.error.set(null);
    this.installRefusal.set(null);
    try {
      const res = await this.electron.crucible.install();
      if (res.success) {
        this.changed.emit();
        await this.loadPlan();
        this.busy.set(null);
        // Main verifies and registers the installed engine before reporting success.
        await this.loadServers();
        return;
      }
      if (res.refusal) {
        this.installRefusal.set(res.refusal);
        return;
      }
      this.error.set(res.error ?? 'The install refused and said nothing about why.');
    } finally {
      if (this.busy() === 'install') this.busy.set(null);
    }
  }

  // ── Door 4: take it off again ────────────────────────────────────────────

  /**
   * THE TWO CHOICES, AND BOTH DEFAULT TO THE SAFE ANSWER.
   *
   * Weights are KEPT unless somebody says otherwise — that is Crucible's own
   * default and this door does not quietly hold a different one. A reinstall
   * that finds 40 GB of models already there is minutes; one that re-downloads
   * them is an evening.
   */
  purgeWeights = false;
  wslToo = false;

  readonly uninstallPlan = signal<CrucibleUninstallPlan | null>(null);
  readonly uninstallRefusal = signal<
    { code: string; message: string; command: string | null; detail: string | null } | null
  >(null);
  /** The last line the uninstall printed. The transcript goes to main's console. */
  readonly uninstallLine = signal<string | null>(null);

  /**
   * Is "also remove the WSL2 engine" a thing on this machine?
   *
   * Only on Windows, and only where the plan actually saw a WSL2 distro. It is
   * a flag of the Windows HOST's CLI — it runs the guest's own uninstall first
   * — and offering it anywhere else would be offering a choice that main
   * refuses by name (`uninstall_wsl_too_needs_host`).
   */
  readonly canWslToo = computed(() => {
    const plan = this.plan();
    if (plan === null || plan.platform !== 'win32') return false;
    return (plan.host.wsl?.distros ?? []).some((d) => d.version === 2);
  });

  sizeOf(bytes: number): string {
    return sizeWords(bytes);
  }

  /** The dry run. Touches nothing, and is the same plan the real run performs. */
  async loadUninstallPlan(): Promise<void> {
    this.busy.set('uninstall-plan');
    this.uninstallRefusal.set(null);
    this.uninstallLine.set(null);
    try {
      const here = this.registeredHere();
      if (here === null) {
        // The door is not drawn in this state, so reaching it is a bug rather
        // than a thing to explain away with a default name.
        this.error.set('The engine on this computer is not in the list, so there is no row to '
          + 'uninstall by. Add it first, in the door above.');
        return;
      }
      const res = await this.electron.crucible.uninstallPlan(here, {
        purgeWeights: this.purgeWeights,
        wslToo: this.wslToo,
      });
      if (res.success && res.data) {
        this.uninstallPlan.set(res.data);
        return;
      }
      // NEVER AN EMPTY PLAN ON FAILURE: an empty step list reads as "nothing
      // to remove", which is a different sentence from "this could not be
      // measured" and would sit under a live Remove button.
      this.uninstallPlan.set(null);
      if (res.refusal) {
        this.uninstallRefusal.set(res.refusal);
        return;
      }
      this.error.set(res.error ?? 'Checking what would go refused and said nothing about why.');
    } finally {
      if (this.busy() === 'uninstall-plan') this.busy.set(null);
    }
  }

  /**
   * The real run, and the ONE thing that happens after it: the plan is
   * re-read.
   *
   * `loadServers()` is what closes the door — with the engine gone, discovery
   * finds nothing, `registeredHere()` is null and the door is not drawn at all.
   * Nothing here decides that; it is the same read every other face uses. The
   * registry ROW is left alone: uninstalling the software and forgetting the
   * address are two acts, and the second one is the list's Remove button.
   */
  async runUninstall(): Promise<void> {
    this.busy.set('uninstall');
    this.uninstallRefusal.set(null);
    try {
      const here = this.registeredHere();
      if (here === null) {
        this.error.set('The engine on this computer is not in the list, so there is no row to '
          + 'uninstall by. Add it first, in the door above.');
        return;
      }
      const res = await this.electron.crucible.uninstall(here, {
        purgeWeights: this.purgeWeights,
        wslToo: this.wslToo,
      });
      if (res.success && res.data) {
        this.uninstallPlan.set(res.data);
        this.changed.emit();
        await this.loadPlan();
        await this.loadServers();
        return;
      }
      if (res.refusal) {
        this.uninstallRefusal.set(res.refusal);
        return;
      }
      this.error.set(res.error ?? 'Removing it refused and said nothing about why.');
    } finally {
      if (this.busy() === 'uninstall') this.busy.set(null);
    }
  }
}
