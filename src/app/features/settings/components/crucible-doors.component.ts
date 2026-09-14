import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type { CrucibleProbeResult } from '@shared/crucible/settings-wire';
import type {
  CrucibleHostRefusal,
  CrucibleInstallPlan,
} from '@shared/crucible/install-wire';

/**
 * THE THREE DOORS — how a person gets a Crucible, in Owen's words:
 * *"offer to install Crucible, or to point at one elsewhere"*.
 *
 * ── WHY IT IS ONE COMPONENT AND NOT TWO COPIES ─────────────────────────────
 *
 * The same three doors appear in two places: the first-run wizard, where
 * somebody is deciding whether they want any of this, and Settings → Crucible
 * Servers, where somebody who skipped it has come back. They are the same three
 * doors and they must stay the same three — a wizard offering a "Connect" the
 * settings row spelled differently would be two screens teaching two different
 * things about one registry. So this is one component with two hosts. The
 * hosted Foundry built the same component on its side for the same reason
 * (`foundry-app/src/app/components/crucible-doors`), which is what makes the
 * two apps behave alike rather than merely look alike.
 *
 * It owns NO STATE beyond what is being typed. Every door ends in a call to
 * `electron.crucible.*`, main answers, and the host re-reads through its own
 * door — `changed` is the whole of what this emits, because a component that
 * handed its parent a server list would be a second copy of a list main has
 * already answered with.
 *
 * ── THE THREE, AND WHY THEY ARE IN THIS ORDER ──────────────────────────────
 *
 * 1. **Connect to one elsewhere.** First because it needs nothing installed
 *    anywhere — somebody whose Mac already runs one is three fields away. Test
 *    before Add, and the test goes through `crucible:test-address`, which
 *    WRITES NOTHING: adding a server in order to find out whether it is a
 *    server leaves a dead entry behind every failure. Ping then info, because
 *    ping is unauthenticated and info is not, so the pair tells "nothing there"
 *    from "not a Crucible" from "wrong token".
 *
 * 2. **Use the one on this machine.** Reads that server's own `config.toml`
 *    rather than asking anybody to copy a token, so the file stays the token's
 *    single owner and a later `crucible init --force` needs no action at all.
 *    There is nothing to press: the reserved name `local` already resolves to
 *    it, so this door REPORTS — its name, address and job types, or the named
 *    reason there is none.
 *
 * 3. **Install one here.** Last, because it is the longest, and today it is a
 *    DOCUMENT: the measured machine, the exact sequence in order, and the
 *    commands that need elevation listed apart because this app cannot obtain
 *    elevation on somebody's behalf. The button that will run it is present and
 *    DISABLED, wearing main's own sentence — and the door behind it refuses
 *    with the same one, because a disabled control over an open door is a
 *    decoration.
 *
 * ── NOTHING HERE IS A STEP ANYBODY HAS TO TAKE ─────────────────────────────
 *
 * Every door is closed until it is opened, and the wizard step around this one
 * is skippable like every other. A laptop that only ever renders on the Mac is
 * not broken, and neither is one that renders nowhere yet.
 */
@Component({
  selector: 'app-crucible-doors',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="doors">
      <!-- ── 1. Connect to one elsewhere ───────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('connect')">
        <span class="door-name">Connect to a Crucible on another machine</span>
        <span class="door-note">
          One already running somewhere else — another desk, another room. Nothing is installed here.
        </span>
      </button>
      @if (open() === 'connect') {
        <div class="panel">
          <p class="hint">
            Get its token by running <code>crucible token --show</code> on that machine. Test first:
            it writes nothing, so a wrong address leaves nothing behind.
          </p>
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
        </div>
      }

      <!-- ── 2. Use the one on this machine ────────────────────────────── -->
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
              <p class="ok">
                <strong>{{ l.serverName }}</strong> at {{ l.url }}
              </p>
              <p class="hint">
                Read from <code>{{ l.configPath }}</code>{{ l.via === 'wsl' ? ' inside WSL' : '' }}
                every time this app asks — no copy is kept here, so
                <code>crucible init --force</code> needs no action at all. It is already the
                reserved server <code>local</code> in the list above; there is nothing to add.
              </p>
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
              <div class="actions">
                <desktop-button variant="ghost" size="sm" [disabled]="busy() !== null" (click)="testLocal()">
                  {{ busy() === 'local' ? 'Testing…' : 'Test it' }}
                </desktop-button>
              </div>
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

      <!-- ── 3. Install one here ───────────────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('install')">
        <span class="door-name">Install a Crucible on this machine</span>
        <span class="door-note">
          The full sequence, measured against this machine. Several gigabytes, once.
        </span>
      </button>
      @if (open() === 'install') {
        <div class="panel">
          @if (plan(); as p) {
            <p class="machine">{{ p.machine }}</p>

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

            <h5 class="group">Run these, in order</h5>
            <p class="hint">
              {{ p.platform === 'win32'
                ? 'Each line runs inside the WSL guest. Crucible’s backend is Linux — Windows is never one.'
                : 'Each line runs in a terminal on this machine.' }}
              BookForge asks for {{ p.jobTypes.join(', ') }} because its pipeline uses all six.
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

            <p class="hint">
              The argument behind all of it: <code>{{ p.readme }}</code>
            </p>
          } @else if (error(); as e) {
            <p class="bad">{{ e }}</p>
          } @else {
            <p class="hint">Measuring this machine…</p>
          }
        </div>
      }
    </div>
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
    .flabel { font-size: 12px; color: var(--text-secondary); min-width: 70px; }
    .field input {
      flex: 1; padding: 6px 8px; border-radius: 6px; font-size: 13px;
      border: 1px solid var(--border-default); background: var(--bg-input, var(--surface-1));
      color: var(--text-primary);
    }
    .actions { display: flex; gap: 8px; align-items: center; }
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
    code { font-family: var(--font-mono, monospace); background: var(--bg-surface, var(--surface-1)); padding: 0 4px; border-radius: 3px; }
  `],
})
export class CrucibleDoorsComponent {
  private readonly electron = inject(ElectronService);

  /** Something landed that changes what the host's own list would say. */
  readonly changed = output<void>();

  readonly open = signal<'connect' | 'local' | 'install' | null>(null);
  readonly busy = signal<'test' | 'add' | 'local' | 'install' | null>(null);
  readonly error = signal<string | null>(null);

  draftName = '';
  draftUrl = '';
  draftToken = '';
  readonly probe = signal<CrucibleProbeResult | null>(null);
  readonly localProbe = signal<CrucibleProbeResult | null>(null);

  readonly plan = signal<CrucibleInstallPlan | null>(null);
  readonly installRefusal = signal<CrucibleHostRefusal | null>(null);

  /** The local half of the measured facts — door 2's whole answer. */
  readonly localFacts = computed(() => this.plan()?.host.local ?? null);

  /**
   * Open one door, close the others, and measure on demand.
   *
   * The install plan is NOT loaded in the constructor: composing it spawns
   * `wsl.exe -l -v` and an `nvidia-smi` query, and a settings page that probed
   * a cold WSL VM every time it was opened would cost a second of somebody's
   * time to answer a question they did not ask. Door 2 needs the same read, so
   * both load it.
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
      this.probe.set(null);
      this.open.set(null);
      this.changed.emit();
    } finally {
      this.busy.set(null);
    }
  }

  // ── Door 2 ───────────────────────────────────────────────────────────────

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

  // ── Door 3 ───────────────────────────────────────────────────────────────

  /**
   * Press the guided install. It refuses today — see `electron/crucible/
   * install.ts` — and the refusal is drawn with its code and its command, the
   * same shape `@crucible/bootstrap` will hand back when it is the one
   * refusing.
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
        return;
      }
      if (res.refusal) {
        this.installRefusal.set(res.refusal);
        return;
      }
      this.error.set(res.error ?? 'The install refused and said nothing about why.');
    } finally {
      this.busy.set(null);
    }
  }
}
