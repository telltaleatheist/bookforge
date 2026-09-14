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
 * ── THE THREE DOORS, AND WHY THEY ARE IN THIS ORDER ─────────────────────────
 *
 * 1. **Connect to a Crucible server.** First because it is the one that needs
 *    nothing installed anywhere — a person whose Mac already runs one is two
 *    fields away from using it. Test before Add, and the test goes through
 *    `testAt`, which does NOT write anything: adding a server in order to find
 *    out whether it is a server would leave a dead entry behind every failure.
 *
 * 2. **Use the Crucible on this machine.** Reads that server's own config.toml
 *    rather than asking anybody to copy a token, so the file stays the token's
 *    single owner and a later `crucible init --force` is fixed by pressing the
 *    button again (crucible-registry.ts argues this at length).
 *
 * 3. **Install Crucible here.** Last, because it is the longest, and today it is
 *    a DOCUMENT: the exact sequence, in order, with the commands that need
 *    elevation listed apart because this app cannot obtain elevation on somebody's
 *    behalf. The button that will run it is present and disabled, wearing main's
 *    own sentence — see `CrucibleInstallPlan.drivenWhy` and
 *    electron/crucible-install.ts, which says what turning it on costs.
 *
 * ── NOTHING HERE IS A STEP ANYBODY HAS TO TAKE ──────────────────────────────
 *
 * Owen: *"foundry should work if they have no idea what theyre doing and they
 * just want to convert PDFs to EPUB. but if they do know what theyre doing and
 * they want access to speed, they can use crucible."* Every door is closed until
 * it is opened, and the wizard's step around this one is skippable like every
 * other. The Ollama path is untouched and remains the beginner's path.
 */
import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import type { CrucibleInstallPlan, CrucibleProbe } from '@shared/slots';
import { api } from '../../core/foundry';

/** Which door is open. `null` is all three closed, which is how it starts. */
type DoorId = 'connect' | 'local' | 'install';

@Component({
  selector: 'app-crucible-doors',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="doors">
      <!-- ── 1. Connect ────────────────────────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('connect')">
        <span class="door-name">Connect to a Crucible server</span>
        <span class="door-note">One running somewhere else — another desk, another room.</span>
      </button>
      @if (open() === 'connect') {
        <div class="panel">
          <label class="field">
            <span class="label">Name</span>
            <input type="text" name="cName" placeholder="Mac Studio"
                   [ngModel]="name()" (ngModelChange)="name.set($event)">
          </label>
          <label class="field">
            <span class="label">Address</span>
            <input type="text" name="cUrl" placeholder="http://192.168.1.20:7100"
                   [ngModel]="url()" (ngModelChange)="url.set($event)">
          </label>
          <label class="field">
            <span class="label">Token</span>
            <input type="password" name="cToken" placeholder="crucible token --show, on that machine"
                   [ngModel]="token()" (ngModelChange)="token.set($event)">
          </label>
          <div class="actions">
            <button class="ghost" type="button" [disabled]="busy()" (click)="test()">
              {{ busy() === 'test' ? 'Testing…' : 'Test' }}
            </button>
            <button class="primary" type="button" [disabled]="busy()" (click)="add()">
              {{ busy() === 'add' ? 'Adding…' : 'Add' }}
            </button>
          </div>
          @if (probe(); as result) {
            @if (result.outcome === 'ok') {
              <p class="small ok">
                {{ result.serverName }} {{ result.version }} — {{ result.backend }}, {{ result.gpu }}
              </p>
            } @else {
              <p class="small warn">{{ result.message }}</p>
            }
          }
        </div>
      }

      <!-- ── 2. This machine ───────────────────────────────────────────── -->
      <button class="door" type="button" (click)="toggle('local')">
        <span class="door-name">Use the Crucible on this machine</span>
        <span class="door-note">
          One that is already installed here. Its token is read from its own config file.
        </span>
      </button>
      @if (open() === 'local') {
        <div class="panel">
          @if (isWindows) {
            <!--
              NO DEFAULT DISTRO, deliberately: "the default" is whatever
              "wsl --set-default" last said, and a token read out of the wrong
              guest is a wrong token. (NO BACKTICKS ANYWHERE IN THIS TEMPLATE —
              it is a template literal and one would end it mid-comment.)
            -->
            <label class="field">
              <span class="label">WSL distro</span>
              <input type="text" name="cDistro" placeholder="Ubuntu"
                     [ngModel]="distro()" (ngModelChange)="distro.set($event)"
                     (blur)="saveDistro()">
            </label>
            <p class="small">
              Crucible's backend is Linux, so on Windows the server lives inside WSL. Name the
              distribution it is installed in — there is no default on purpose.
            </p>
          }
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
                <button class="primary" type="button" [disabled]="!it.driven" (click)="drive()">
                  Install it for me
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

  protected readonly isWindows = api?.platform === 'win32';
  protected readonly open = signal<DoorId | null>(null);
  protected readonly name = signal('');
  protected readonly url = signal('');
  protected readonly token = signal('');
  protected readonly distro = signal('');
  protected readonly probe = signal<CrucibleProbe | null>(null);
  protected readonly plan = signal<CrucibleInstallPlan | null>(null);
  protected readonly localNote = signal<string | null>(null);
  protected readonly localFailed = signal(false);
  protected readonly installSaid = signal<string | null>(null);

  /** Which call is in flight, so the right button says so and the others are off. */
  protected readonly busy = signal<'test' | 'add' | 'local' | 'install' | null>(null);

  constructor() {
    if (!api) return;
    // The stored WSL distro, so opening door 2 on a machine that has answered
    // this before shows the answer rather than an empty box.
    void api.crucible.settings().then((view) => this.distro.set(view.wslDistro));
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
    // The install plan is read the first time that door is opened and not
    // before: it spawns wsl.exe, and a wizard step that probed WSL on arrival
    // would be doing work for somebody who is about to press Skip.
    if (this.open() === 'install' && this.plan() === null) void this.loadPlan();
  }

  private async loadPlan(): Promise<void> {
    if (!api) return;
    this.plan.set(await api.crucible.installPlan());
  }

  /**
   * Test what is in the boxes, WITHOUT saving it.
   *
   * The failure is a RESULT carrying the SDK's own sentence (crucible-registry.ts
   * says why that sentence is never reworded here), so there is nothing to catch:
   * both outcomes are drawn, and neither is an exception.
   */
  protected async test(): Promise<void> {
    if (!api) return;
    this.busy.set('test');
    this.probe.set(null);
    try {
      this.probe.set(await api.crucible.testAt(this.url(), this.token()));
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * Add it. Main refuses a bad name, address or token BY NAME, and the refusal
   * lands in the same place a failed test does — one sentence, one place to look,
   * whichever of the two buttons produced it.
   */
  protected async add(): Promise<void> {
    if (!api) return;
    this.busy.set('add');
    try {
      await api.crucible.add(this.name(), this.url(), this.token());
      this.probe.set(null);
      this.token.set('');
      this.open.set(null);
      this.changed.emit();
    } catch (err) {
      this.probe.set({
        outcome: 'failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.busy.set(null);
    }
  }

  protected async saveDistro(): Promise<void> {
    if (!api) return;
    this.distro.set(await api.crucible.setWslDistro(this.distro()));
  }

  /**
   * Read the local server's own config and register it.
   *
   * Pressing this a second time after `crucible init --force` is the supported
   * fix for a stale token — the entry is replaced in place, keeping its rank —
   * and the note says so, because otherwise the only way to learn it is to hit
   * the 401 first.
   */
  protected async addLocal(): Promise<void> {
    if (!api) return;
    this.busy.set('local');
    this.localNote.set(null);
    try {
      const answer = await api.crucible.addLocal('This machine');
      if (answer.outcome === 'added') {
        this.localFailed.set(false);
        this.localNote.set(
          `Added ${answer.serverName} at ${answer.url}, read from ${answer.configPath}. `
          + 'Its token stays that file\'s — press this again after "crucible init" to refresh it.',
        );
        this.changed.emit();
      } else {
        this.localFailed.set(true);
        this.localNote.set(answer.message);
      }
    } finally {
      this.busy.set(null);
    }
  }

  /**
   * The driven install — and the button above is disabled, so pressing this is
   * not something that happens today.
   *
   * It is written anyway, and it catches, because the day
   * `@crucible/bootstrap` lands this is the call site: main's refusal (or its
   * `BootstrapStepFailed`, which names the step that did not finish) is printed
   * where the person pressed, exactly as every other Crucible sentence in this
   * app is.
   */
  protected async drive(): Promise<void> {
    if (!api) return;
    this.busy.set('install');
    this.installSaid.set(null);
    try {
      await api.crucible.install();
      await this.loadPlan();
      this.changed.emit();
    } catch (err) {
      this.installSaid.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(null);
    }
  }
}
