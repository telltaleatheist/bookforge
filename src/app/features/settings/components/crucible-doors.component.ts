import {
  ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type {
  CrucibleModuleProgress,
  CrucibleProbeResult,
} from '@shared/crucible/settings-wire';
import type {
  CrucibleHostRefusal,
  CrucibleInstallPlan,
} from '@shared/crucible/install-wire';

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
 *   1. **Connect** — name, address, token, or ONE pasted `crucible://` line.
 *   2. **Get one on this machine** — the pre-server minute, the chicken-and-egg
 *      a page cannot do for itself, after which the door is **Open Crucible**.
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
 * ── "SET UP FOR BOOKFORGE" ─────────────────────────────────────────────────
 *
 * §5.4. One button posts `shared/crucible/bookforge.module.json` — the
 * generated, vendored statement of what this app needs — and the task's own
 * events are drawn in place. A module is idempotent (installed entries are
 * SKIPPED), so it is safe to press on a stocked server and is the honest way to
 * find out whether one is. A `server_busy` held by a LEASE shows the HOLDER,
 * verbatim, because that means another app on that machine is mid-run: an
 * operator shown a dead button with no name concludes the button is broken and
 * presses it until it is.
 *
 * It owns NO STATE beyond what is being typed and what the running task has
 * said. Every door ends in a call to `electron.crucible.*`, main answers, and
 * the host re-reads through its own door — `changed` is the whole of what this
 * emits.
 */
@Component({
  selector: 'app-crucible-doors',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (mode() === 'probing') {
      <!-- ══ THE WIZARD'S STEP: ONE FACE, CHOSEN BY A PROBE ═══════════════ -->
      <div class="doors">
        @if (plan(); as p) {
          @if (face() === 'connected') {
            <!-- ── Connected: this machine already has one ──────────────── -->
            @if (p.host.local.present) {
              <div class="panel">
                <p class="ok">
                  <strong>{{ p.host.local.serverName }}</strong> at {{ p.host.local.url }}
                </p>
                <p class="hint">
                  Read from <code>{{ p.host.local.configPath }}</code>{{ p.host.local.via === 'wsl' ? ' inside WSL' : '' }}
                  every time this app asks, so no copy of its token is kept here. It is already the
                  reserved server <code>local</code>; there is nothing to add.
                </p>
                <div class="actions">
                  <desktop-button variant="primary" size="sm" [disabled]="busy() !== null" (click)="openUi('local')">
                    Open Crucible
                  </desktop-button>
                  <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="setUpFor('local')">
                    {{ busy() === 'module' ? 'Setting up…' : 'Set up for BookForge' }}
                  </desktop-button>
                </div>
                <ng-container [ngTemplateOutlet]="moduleState" />
              </div>
            }
          } @else if (face() === 'install') {
            <!-- ── This machine can host one (or nothing says it cannot) ── -->
            <div class="panel">
              <p class="machine">{{ p.machine }}</p>
              <p class="hint">{{ p.hostableWhy }}</p>
              <ng-container [ngTemplateOutlet]="installBody" [ngTemplateOutletContext]="{ p: p }" />
            </div>
          } @else {
            <!-- ── Not hostable: connect only, and say why by name ──────── -->
            <div class="panel">
              <p class="machine">{{ p.machine }}</p>
              <p class="bad">{{ p.hostableWhy }}</p>
              <p class="hint">
                That is a state, not a fault. A laptop that renders on another machine is a laptop
                with one remote server, and the client speaks HTTP either way.
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
          <span class="door-name">Connect to a Crucible on another machine</span>
          <span class="door-note">
            One already running somewhere else — another desk, another room. Nothing is installed here.
          </span>
        </button>
        @if (open() === 'connect') {
          <div class="panel">
            <ng-container [ngTemplateOutlet]="connectForm" />
          </div>
        }

        <!-- ── 2. Use the one on this machine ──────────────────────────── -->
        <button class="door" type="button" (click)="toggle('local')">
          <span class="door-name">Use the Crucible on this machine</span>
          <span class="door-note">
            Read from its own config.toml — name, address and token. Nothing to paste.
          </span>
        </button>
        @if (open() === 'local') {
          <div class="panel">
            @if (localFacts(); as l) {
              @if (l.present) {
                <p class="ok"><strong>{{ l.serverName }}</strong> at {{ l.url }}</p>
                <p class="hint">
                  Read from <code>{{ l.configPath }}</code>{{ l.via === 'wsl' ? ' inside WSL' : '' }}
                  every time this app asks — no copy is kept here, so
                  <code>crucible init --force</code> needs no action at all. It is already the
                  reserved server <code>local</code> in the list above; there is nothing to add.
                </p>
                <!--
                  PHASE13 §5.2: once the reserved name 'local' resolves, this door is
                  Everything it used to offer to explain is on the page that
                  button opens.
                -->
                <div class="actions">
                  <desktop-button variant="primary" size="sm" [disabled]="busy() !== null" (click)="openUi('local')">
                    Open Crucible
                  </desktop-button>
                  <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="setUpFor('local')">
                    {{ busy() === 'module' ? 'Setting up…' : 'Set up for BookForge' }}
                  </desktop-button>
                  <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="testLocal()">
                    {{ busy() === 'local' ? 'Testing…' : 'Test it' }}
                  </desktop-button>
                </div>
                @if (localProbe(); as p) {
                  @if (p.outcome === 'ok') {
                    <p class="ok">
                      Answering — v{{ p.facts.version }} · {{ p.facts.backend }} ·
                      {{ p.facts.gpu.name }} · job types {{ p.facts.jobTypes.join(', ') }}
                    </p>
                  } @else {
                    <p class="bad"><span class="code">{{ p.outcome }}</span> {{ p.message }}</p>
                  }
                }
                <ng-container [ngTemplateOutlet]="moduleState" />
              } @else {
                <p class="bad"><span class="code">{{ l.code }}</span> {{ l.reason }}</p>
                <p class="hint">
                  That is a state, not a fault — a machine that only ever renders on another one has
                  no local Crucible and does not need one. The third door installs one here.
                </p>
              }
            } @else {
              <p class="hint">Reading this machine's Crucible config…</p>
            }
          </div>
        }

        <!-- ── 3. Get one on this machine ──────────────────────────────── -->
        <button class="door" type="button" (click)="toggle('install')">
          <span class="door-name">Install a Crucible on this machine</span>
          <span class="door-note">
            The pre-server minute: a guest, a Python, the wheel, the service. Then its own page
            does the rest.
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
      </div>
    }

    <!-- ══ THE PIECES, WRITTEN ONCE AND USED BY BOTH FACES ════════════════ -->

    <ng-template #connectForm>
      <!--
        PHASE13 §5.1. The PASTED LINE IS FIRST because it is the path that
        cannot be mistyped: "crucible token --url" on the other machine prints
        it, and its operator page has a copy button beside it.
      -->
      <label class="field">
        <span class="flabel">Paste from Crucible</span>
        <input
          type="text"
          placeholder="crucible://name@host:port/#token"
          [(ngModel)]="draftPaste"
          name="cruDoorPaste"
          (paste)="onPaste()"
          (keyup.enter)="readPairing()" />
      </label>
      <div class="actions">
        <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="readPairing()">
          {{ busy() === 'paste' ? 'Reading…' : 'Read it' }}
        </desktop-button>
        <span class="hint">
          One line from that server's page (or <code>crucible token --url</code>) fills all three
          below. Nothing is saved until you press Add.
        </span>
      </div>
      @if (pairingRefusal(); as r) {
        <p class="bad"><span class="code">{{ r.code }}</span> {{ r.detail }}</p>
      }

      <label class="field">
        <span class="flabel">Name</span>
        <input type="text" placeholder="mac" [(ngModel)]="draftName" name="cruDoorName" />
      </label>
      <label class="field">
        <span class="flabel">Address</span>
        <input type="text" placeholder="http://192.168.68.20:7100" [(ngModel)]="draftUrl" name="cruDoorUrl" />
      </label>
      <label class="field">
        <span class="flabel">Token</span>
        <input type="password" autocomplete="off" placeholder="Bearer token" [(ngModel)]="draftToken" name="cruDoorToken" />
      </label>
      <div class="actions">
        <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="test()">
          {{ busy() === 'test' ? 'Testing…' : 'Test' }}
        </desktop-button>
        <desktop-button variant="primary" size="sm" [disabled]="busy() !== null" (click)="add()">
          {{ busy() === 'add' ? 'Adding…' : 'Add' }}
        </desktop-button>
        <span class="hint">Test writes nothing, so a wrong address leaves nothing behind.</span>
      </div>
      @if (probe(); as p) {
        @if (p.outcome === 'ok') {
          <p class="ok">
            OK — <strong>{{ p.facts.serverName }}</strong> v{{ p.facts.version }} ·
            {{ p.facts.backend }} · {{ p.facts.gpu.name }} · job types
            {{ p.facts.jobTypes.join(', ') }}
          </p>
        } @else {
          <p class="bad"><span class="code">{{ p.outcome }}</span> {{ p.message }}</p>
        }
      }
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
          {{ busy() === 'install' ? 'Installing…' : 'Install it for me' }}
        </desktop-button>
        @if (!p.driven) { <span class="driven-why">{{ p.drivenWhy }}</span> }
      </div>
      @if (installRefusal(); as r) {
        <p class="bad"><span class="code">{{ r.code }}</span> {{ r.message }}</p>
        @if (r.command) { <pre class="cmd">{{ r.command }}</pre> }
      }
      <ng-container [ngTemplateOutlet]="moduleState" />

      <h5 class="group">Run these, in order</h5>
      <p class="hint">
        {{ p.platform === 'win32'
          ? 'Each line runs inside the WSL guest. Crucible’s backend is Linux — Windows is never one.'
          : 'Each line runs in a terminal on this machine.' }}
        This is only the pre-server minute — a guest, a Python, the wheel, the service. The job
        environments and the weights are not here: they are one press of “Set up for BookForge”
        once the server answers.
      </p>
      <ol class="steps">
        @for (s of p.steps; track s.title) {
          <li class="step" [class.done]="s.done">
            <div class="step-head">
              <span class="step-title">{{ s.title }}</span>
              @if (s.done) { <span class="tick">&#10003; already here</span> }
            </div>
            <p class="detail">{{ s.detail }}</p>
            @for (c of s.commands; track c) {
              <pre class="cmd">{{ c }}</pre>
            }
          </li>
        }
      </ol>

      @if (p.elevated.length > 0) {
        <h5 class="group">Commands BookForge cannot run for you</h5>
        <p class="hint">
          Each needs a privilege this app does not have and must not ask for silently —
          elevation, a reboot, a sudo password. The installer draws the same line: it refuses
          by name and hands the command over rather than attempting it.
        </p>
        @for (s of p.elevated; track s.title) {
          <div class="step" [class.done]="s.done">
            <div class="step-head">
              <span class="step-title">{{ s.title }}</span>
              @if (s.done) { <span class="tick">&#10003; already here</span> }
            </div>
            <p class="detail">{{ s.detail }}</p>
            @for (c of s.commands; track c) { <pre class="cmd">{{ c }}</pre> }
          </div>
        }
      }

      <p class="hint">The argument behind all of it: <code>{{ p.readme }}</code></p>
    </ng-template>

    <ng-template #moduleState>
      @if (moduleError(); as e) { <p class="bad">{{ e }}</p> }
      @if (moduleProgress(); as m) {
        <div class="module">
          <p class="hint">
            <strong>{{ m.state === 'running' ? 'Setting up' : m.state }}</strong>
            @if (m.step) { · step {{ m.step.index }} of {{ m.step.total }}: {{ m.step.name }} }
          </p>
          @if (m.bytes) {
            <p class="detail">
              {{ m.bytes.file }} — {{ (m.bytes.done / 1048576).toFixed(0) }} MB{{ m.bytes.total ? ' of ' + (m.bytes.total / 1048576).toFixed(0) + ' MB' : '' }}
            </p>
          }
          @if (m.line) { <pre class="cmd">{{ m.line }}</pre> }
          @if (m.skipped) { <p class="detail">already here — {{ m.skipped }}</p> }
          @if (m.jobTypes) { <p class="ok">now serving {{ m.jobTypes.join(', ') }}</p> }
          @if (m.error) {
            <p class="bad"><span class="code">{{ m.error.code }}</span> {{ m.error.message }}</p>
            <p class="detail">
              Every step that finished stays done — the environments and the weights are on disk.
              Pressing again skips everything that is already true.
            </p>
          }
          @if (m.state === 'running' && m.taskId) {
            <div class="actions">
              <desktop-button variant="ghost" size="sm" (click)="cancelSetUp(m)">Cancel</desktop-button>
            </div>
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

  readonly open = signal<'connect' | 'local' | 'install' | null>(null);
  readonly busy = signal<'test' | 'add' | 'local' | 'install' | 'paste' | 'module' | null>(null);
  readonly error = signal<string | null>(null);

  draftPaste = '';
  draftName = '';
  draftUrl = '';
  draftToken = '';
  readonly pairingRefusal = signal<{ code: string; detail: string } | null>(null);
  readonly probe = signal<CrucibleProbeResult | null>(null);
  readonly localProbe = signal<CrucibleProbeResult | null>(null);

  readonly plan = signal<CrucibleInstallPlan | null>(null);
  readonly installRefusal = signal<CrucibleHostRefusal | null>(null);

  readonly moduleProgress = signal<CrucibleModuleProgress | null>(null);
  readonly moduleError = signal<string | null>(null);

  /** The local half of the measured facts — door 2's whole answer. */
  readonly localFacts = computed(() => this.plan()?.host.local ?? null);

  /**
   * WHICH ONE FACE the wizard's step shows (§5.5), from main's own verdict.
   *
   * `unknown` draws the INSTALL face deliberately: on Windows the card question
   * cannot be asked until there is a guest to ask it in, and the install
   * document's first step is the thing that settles it. Sending a machine with
   * an unmeasured card to "connect only" would be a wrong answer stated
   * confidently.
   */
  readonly face = computed<'connected' | 'install' | 'connect-only' | null>(() => {
    const plan = this.plan();
    if (plan === null) return null;
    if (plan.host.local.present) return 'connected';
    return plan.hostable === 'no' ? 'connect-only' : 'install';
  });

  constructor() {
    // The wizard's step measures on arrival; the settings page does not. One
    // effect rather than a lifecycle hook, because `mode` is a signal input and
    // a host could in principle change it.
    effect(() => {
      if (this.mode() === 'probing' && this.plan() === null && this.error() === null) {
        void this.loadPlan();
      }
    });

    const stop = this.electron.crucible.onModuleProgress((progress) => {
      this.moduleProgress.set(progress);
    });
    this.destroyRef.onDestroy(stop);
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
  toggle(door: 'connect' | 'local' | 'install'): void {
    this.error.set(null);
    const next = this.open() === door ? null : door;
    this.open.set(next);
    if ((next === 'install' || next === 'local') && this.plan() === null) void this.loadPlan();
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

  // ── Door 1 ───────────────────────────────────────────────────────────────

  /**
   * A paste into the line field reads it immediately.
   *
   * On the next tick, because the `paste` event fires BEFORE ngModel has the
   * new value — reading it here without waiting would parse whatever was in the
   * field a moment ago, which is usually the empty string.
   */
  onPaste(): void {
    setTimeout(() => { void this.readPairing(); }, 0);
  }

  /**
   * One `crucible://` line becomes the three fields, or is refused BY NAME with
   * nothing filled.
   *
   * The parsing happens in MAIN, through the SDK's `parsePairing`, which is the
   * tested inverse of crucible's own producer — a second parser here, written
   * from the format doc, would be the two-owners defect in the one place the
   * format exists to prevent it (PHASE13 §2.1).
   */
  async readPairing(): Promise<void> {
    const line = this.draftPaste.trim();
    if (line === '') return;
    this.busy.set('paste');
    this.pairingRefusal.set(null);
    this.error.set(null);
    try {
      const res = await this.electron.crucible.parsePairing(line);
      if (!res.success || !res.data) {
        this.error.set(res.error ?? 'The line could not be read, and nothing said why.');
        return;
      }
      if (!res.data.ok) {
        // VERBATIM, and NOTHING filled. A half-filled form from a line nobody
        // can read is worse than an empty one.
        this.pairingRefusal.set(res.data.refusal);
        return;
      }
      this.draftName = res.data.fields.name;
      this.draftUrl = res.data.fields.url;
      this.draftToken = res.data.fields.token;
      this.draftPaste = '';
      this.probe.set(null);
    } finally {
      this.busy.set(null);
    }
  }

  /** Ping then info, against an address that is NOT saved. Writes nothing. */
  async test(): Promise<void> {
    this.busy.set('test');
    this.error.set(null);
    try {
      const res = await this.electron.crucible.testAddress(this.draftUrl, this.draftToken);
      if (!res.success || !res.data) {
        this.error.set(res.error ?? 'The test failed and said nothing about why.');
        return;
      }
      this.probe.set(res.data);
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Record the remote. The registry's own refusals are shown verbatim — the
   * reserved name, a loopback URL (that is this machine, read from its config),
   * a duplicate name, a URL carrying `/v1`, an empty token. None of those rules
   * is re-implemented here, so none of them can drift.
   */
  async add(): Promise<void> {
    this.busy.set('add');
    this.error.set(null);
    try {
      const res = await this.electron.crucible.add({
        name: this.draftName,
        url: this.draftUrl,
        token: this.draftToken,
      });
      if (!res.success) {
        this.error.set(res.error ?? 'The server could not be added, and nothing said why.');
        return;
      }
      // The token is never echoed back into the field: it is in the registry
      // now, and every surface can only ever show it masked.
      this.draftName = '';
      this.draftUrl = '';
      this.draftToken = '';
      this.draftPaste = '';
      this.probe.set(null);
      this.pairingRefusal.set(null);
      this.open.set(null);
      this.changed.emit();
    } finally {
      this.busy.set(null);
    }
  }

  // ── Door 2, and the operator door beside it ──────────────────────────────

  async testLocal(): Promise<void> {
    this.busy.set('local');
    this.error.set(null);
    try {
      const res = await this.electron.crucible.test('local');
      if (!res.success || !res.data) {
        this.error.set(res.error ?? 'The test failed and said nothing about why.');
        return;
      }
      this.localProbe.set(res.data);
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Open that server's own page (§5.3). The token is read in MAIN from the one
   * owner of it and never reaches this component.
   */
  async openUi(name: string): Promise<void> {
    this.error.set(null);
    const res = await this.electron.crucible.openUi(name);
    if (!res.success) {
      this.error.set(res.error ?? 'The Crucible page could not be opened, and nothing said why.');
    }
  }

  /**
   * Post `shared/crucible/bookforge.module.json` and watch the task (§5.4).
   *
   * Idempotent by the server's design, so this is safe on a stocked server and
   * is the honest way to find out whether one is.
   */
  async setUpFor(name: string): Promise<void> {
    this.busy.set('module');
    this.moduleError.set(null);
    this.moduleProgress.set(null);
    try {
      const res = await this.electron.crucible.setUpModule(name);
      if (!res.success) {
        this.moduleError.set(
          res.error ?? 'The setup task refused and said nothing about why.');
        return;
      }
      if (res.data) this.moduleProgress.set(res.data);
      this.changed.emit();
    } finally {
      this.busy.set(null);
    }
  }

  async cancelSetUp(progress: CrucibleModuleProgress): Promise<void> {
    if (progress.taskId === null) return;
    const res = await this.electron.crucible.cancelSetUp(progress.server, progress.taskId);
    if (!res.success) {
      this.moduleError.set(res.error ?? 'The cancel refused and said nothing about why.');
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
        await this.setUpFor('local');
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
}
