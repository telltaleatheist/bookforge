import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import type {
  DoctorReport,
  EnvTooling,
  ServerStatus,
  SettingsView,
  SetupLogEvent,
  SetupResult,
  SetupRoute,
  WslFacts,
} from '@shared/types';

import { api } from '../../core/foundry';

/**
 * vLLM in WSL — the one backend on Windows that this app can actually build.
 *
 * Three states, and the screen is never in more than one of them:
 *
 *   **There is an environment.** Show which distro and which interpreter, and
 *   give the server a Start and a Stop with a live status beside them. A server
 *   that was already answering when we looked is marked as such and its Stop is
 *   disabled — it is not ours to kill.
 *
 *   **There is WSL but no environment.** Offer to build one: a distro to build
 *   it in, what that distro has to build it WITH, and a Run that streams every
 *   line of a multi-minute, two-gigabyte install into the pane below. No
 *   spinner, no fake percentage, no fallback from the route that was chosen.
 *
 *   **There is no WSL.** One sentence saying so, one saying local Windows
 *   reading is not implemented in the engine, and a pointer at the endpoint
 *   field for a server somewhere else. No greyed-out buttons for things that
 *   cannot happen — an option that cannot be taken is worse than no option.
 */
@Component({
  selector: 'app-wsl-backend',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card wsl">
      <div class="card-head">
        <span class="dot" [attr.data-ok]="haveEnv()"></span>
        <span class="card-title">vLLM in WSL</span>
        @if (wsl().available && haveEnv() && !showSetup()) {
          <button class="ghost tiny" (click)="showSetup.set(true)">Set up again</button>
        }
      </div>

      @if (!wsl().available) {
        <!-- ── Nothing to build in ─────────────────────────────────────── -->
        <p class="detail">{{ wsl().reason ?? 'WSL was not detected on this machine.' }}</p>
        <p class="detail">
          Local reading on Windows without WSL is not implemented in the engine — the native tier
          reports as much. Point <strong>Endpoint URL</strong> above at an OpenAI-compatible server
          running somewhere else (another machine's vLLM, or a hosted one) and set the mode to
          <strong>endpoint</strong>.
        </p>
      } @else {
        <!-- ── The environment ─────────────────────────────────────────── -->
        @if (haveEnv()) {
          <p class="detail">{{ tierDetail() }}</p>
          @if (settings()?.backend?.vllmPython; as py) {
            <p class="mono small">{{ settings()?.backend?.wslDistro ?? distro() }} · {{ py }}</p>
          }

          <!-- ── The server ────────────────────────────────────────────── -->
          <div class="server">
            <span class="dot" [attr.data-state]="status()?.state ?? 'stopped'"></span>
            <span class="state">{{ stateWord() }}</span>
            @if (status()?.external) { <span class="badge">not ours</span> }
            <span class="spacer"></span>
            <button class="ghost tiny" [disabled]="serverBusy() || status()?.state === 'ready'"
                    (click)="startServer()">
              {{ serverBusy() && status()?.state !== 'ready' ? 'Starting…' : 'Start server' }}
            </button>
            <button class="ghost tiny"
                    [disabled]="serverBusy() || status()?.external || status()?.state !== 'ready'"
                    (click)="stopServer()">
              Stop
            </button>
          </div>
          @if (status(); as s) {
            <pre class="detail pre">{{ s.detail }}</pre>
            <p class="small mono">{{ s.url }} · {{ s.model }}</p>
          }

          <!-- The server's lifetime follows the queue: stopped when it drains.
               This knob buys it minutes past that, never indefinitely. -->
          <label class="keepwarm">
            <span>After the queue empties, keep the server warm for</span>
            <input type="number" min="0" max="240" step="1" name="keepWarm"
                   [ngModel]="keepWarm()" (ngModelChange)="saveKeepWarm($event)">
            <span>min <span class="muted">(0 = stop immediately)</span></span>
          </label>
        } @else {
          <p class="detail">
            WSL is here, but nothing in it can import vllm yet. Build an environment and the engine
            will read pages through it.
          </p>
        }

        <!-- ── Building one ────────────────────────────────────────────── -->
        @if (showSetup() || !haveEnv()) {
          <div class="setup">
            <label class="field">
              <span class="label">Distro</span>
              <select [ngModel]="distro()" (ngModelChange)="distro.set($event)"
                      [disabled]="setupRunning()" name="distro">
                @for (name of wsl().distros; track name) {
                  <option [value]="name">{{ name }}</option>
                }
              </select>
            </label>

            <p class="detail">{{ tooling()?.detail ?? 'Looking at what that distro has…' }}</p>

            <div class="routes">
              <label class="radio" [class.off]="!tooling()?.conda">
                <input type="radio" name="route" value="conda" [disabled]="setupRunning() || !tooling()?.conda"
                       [ngModel]="route()" (ngModelChange)="route.set($event)">
                <span>conda — a new <code>foundry-vllm</code> env</span>
              </label>
              <label class="radio" [class.off]="!tooling()?.venv">
                <input type="radio" name="route" value="venv" [disabled]="setupRunning() || !tooling()?.venv"
                       [ngModel]="route()" (ngModelChange)="route.set($event)">
                <span>venv — <code>~/.venvs/foundry-vllm</code></span>
              </label>
            </div>

            <div class="actions">
              @if (setupRunning()) {
                <button class="ghost" (click)="cancelSetup()">Cancel</button>
                <span class="muted">Installing — roughly 2 GB of wheels. This takes minutes.</span>
              } @else {
                <button class="primary" [disabled]="!canRun()" (click)="run()">
                  Set up vLLM in WSL
                </button>
                @if (haveEnv()) {
                  <button class="ghost" (click)="showSetup.set(false)">Close</button>
                }
              }
            </div>

            @if (setupResult(); as result) {
              <p [class.warn]="!result.ok" [class.ok-note]="result.ok">{{ result.detail }}</p>
            }

            @if (log().length > 0) {
              <div class="log" #logPane>
                @for (entry of log(); track $index) {
                  <div class="line" [attr.data-stream]="entry.stream">{{ entry.line }}</div>
                }
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .card {
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 12px 14px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; flex: 1; }

    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--error); flex-shrink: 0; }
    .dot[data-ok="true"] { background: var(--ok); }
    .dot[data-state="ready"] { background: var(--ok); }
    .dot[data-state="starting"] { background: var(--warn); }
    .dot[data-state="stopped"] { background: var(--text-tertiary); }
    .dot[data-state="failed"] { background: var(--error); }

    .detail { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); word-break: break-word; }
    .pre { white-space: pre-wrap; font-family: var(--font-mono); font-size: 11px; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 4px 0 0; }
    .muted { color: var(--text-tertiary); font-size: 12px; }
    .warn { color: var(--warn); font-size: 12px; margin: 8px 0 0; }
    .ok-note { color: var(--ok); font-size: 12px; margin: 8px 0 0; }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--warn); background: var(--warn-soft); border-radius: 999px; padding: 2px 8px;
    }

    .server { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
    .server .state { font-size: 12px; }
    .spacer { flex: 1; }

    .keepwarm {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      margin-top: 10px; font-size: 12px; color: var(--text-secondary);
    }
    .keepwarm input {
      width: 64px; height: 26px; padding: 0 8px;
      background: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-default); border-radius: var(--radius-sm);
      font-size: 12px;
    }

    .setup {
      margin-top: 12px; padding-top: 12px;
      border-top: 1px solid var(--border-subtle);
      display: flex; flex-direction: column; gap: 10px;
    }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }
    .routes { display: flex; flex-direction: column; gap: 6px; }
    .radio { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .radio.off { opacity: 0.45; }
    .radio input { width: auto; accent-color: var(--accent-strong); }
    .radio code { font-family: var(--font-mono); font-size: 11px; }

    .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 32px; padding: 0 16px;
      border-radius: var(--radius-md);
      font-size: 13px; font-weight: 500; line-height: 1;
      cursor: pointer;
      transition: background-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  border-color 100ms cubic-bezier(0, 0, 0.2, 1),
                  transform 100ms cubic-bezier(0, 0, 0.2, 1);
    }
    .primary {
      border: none;
      background: var(--accent); color: var(--text-inverse);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.1);
    }
    .primary:hover:not(:disabled) { background: var(--accent-hover); }
    .primary:active:not(:disabled) { background: var(--accent-active); transform: scale(0.98); }
    .primary:disabled { opacity: 0.5; cursor: not-allowed; }
    .ghost {
      height: 26px; padding: 0 12px; font-size: 12px;
      background: var(--bg-input);
      border: 1px solid var(--border-default);
      color: var(--text-primary);
    }
    .ghost.tiny { height: 22px; padding: 0 8px; font-size: 11px; }
    .ghost:hover:not(:disabled) { background: var(--bg-hover); border-color: var(--border-strong); }
    .ghost:disabled { opacity: 0.5; cursor: not-allowed; }

    .log {
      max-height: 280px; overflow-y: auto;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle); border-radius: var(--radius-md);
      padding: 8px 10px;
      font-family: var(--font-mono); font-size: 11px; line-height: 1.5;
    }
    .line { white-space: pre-wrap; word-break: break-all; color: var(--text-secondary); }
    .line[data-stream="step"] { color: var(--accent); }
    .line[data-stream="stderr"] { color: var(--text-tertiary); }
  `],
})
export class WslBackendComponent {
  /** The engine's own measurement. Null while probing, or when there is none. */
  readonly report = input<DoctorReport | null>(null);
  /** Fired when the environment changed, so the page re-runs doctor. */
  readonly changed = output<void>();

  private readonly logPane = viewChild<ElementRef<HTMLElement>>('logPane');

  protected readonly probedFacts = signal<WslFacts | null>(null);
  protected readonly settings = signal<SettingsView | null>(null);
  protected readonly tooling = signal<EnvTooling | null>(null);
  protected readonly distro = signal('');
  protected readonly route = signal<SetupRoute>('conda');
  protected readonly setupRunning = signal(false);
  protected readonly setupResult = signal<SetupResult | null>(null);
  protected readonly log = signal<SetupLogEvent[]>([]);
  protected readonly status = signal<ServerStatus | null>(null);
  protected readonly serverBusy = signal(false);
  protected readonly showSetup = signal(false);
  protected readonly keepWarm = signal(0);

  /**
   * The doctor's `wsl` block when the engine carries one, our own probe when it
   * does not. Older engine builds have no such block, and "the engine is too old
   * to tell us" is not a reason to show the user no distros.
   */
  protected readonly wsl = computed<WslFacts>(() => {
    const fromDoctor = this.report()?.wsl;
    const probed = this.probedFacts();
    if (fromDoctor && fromDoctor.available) {
      return { available: true, distros: fromDoctor.distros, reason: null };
    }
    if (probed) return probed;
    if (fromDoctor) return { available: false, distros: [], reason: null };
    return { available: false, distros: [], reason: null };
  });

  /** The engine's verdict on the tier — the only thing that says "there is an env". */
  private readonly tier = computed(() => this.report()?.tiers.find((t) => t.id === 'wsl-vllm') ?? null);
  protected readonly haveEnv = computed(() => this.tier()?.available === true);
  protected readonly tierDetail = computed(() => this.tier()?.detail ?? '');

  protected readonly canRun = computed(() => {
    const tooling = this.tooling();
    if (!tooling || this.distro().length === 0) return false;
    return this.route() === 'conda' ? tooling.conda !== null : tooling.venv;
  });

  constructor() {
    if (api) {
      api.backendSetup.onLog((event) => {
        // Bounded: a pip install of torch is thousands of lines and this is a
        // window on a running job, not a transcript to keep.
        this.log.update((lines) => [...lines, event].slice(-600));
      });
      api.vllmServer.onStatus((status) => this.status.set(status));
      // Settings BEFORE facts: the distro an environment already lives in is
      // the one to preselect, and facts cannot prefer it if it has not arrived.
      void this.loadSettings().then(() => this.loadFacts());
      void api.vllmServer.status().then((status) => this.status.set(status));
      void api.vllmServer.keepWarm().then((minutes) => this.keepWarm.set(minutes));
    }

    // A distro was chosen (or the list arrived): ask what it has to build with.
    effect(() => {
      const name = this.distro();
      if (!api || name.length === 0) return;
      void api.wsl.tooling(name).then((tooling) => {
        this.tooling.set(tooling);
        // Default to the route that can actually run, without ever SWITCHING a
        // route the user picked: this only fires when the distro changed.
        if (!tooling.conda && tooling.venv) this.route.set('venv');
        else if (tooling.conda) this.route.set('conda');
      });
    });

    // Follow the log to its end, the way a terminal does.
    effect(() => {
      this.log();
      const el = this.logPane()?.nativeElement;
      if (el) setTimeout(() => { el.scrollTop = el.scrollHeight; }, 0);
    });
  }

  protected stateWord(): string {
    switch (this.status()?.state) {
      case 'ready': return 'Reading server is up';
      case 'starting': return 'Reading server is starting';
      case 'failed': return 'Reading server failed to start';
      default: return 'Reading server is stopped';
    }
  }

  private async loadFacts(): Promise<void> {
    if (!api) return;
    const facts = await api.wsl.facts();
    this.probedFacts.set(facts);
    const first = facts.distros[0];
    if (this.distro().length === 0 && first) {
      // The distro the environment already lives in wins over the first listed.
      const configured = this.settings()?.backend.wslDistro;
      this.distro.set(configured && facts.distros.includes(configured) ? configured : first);
    }
  }

  private async loadSettings(): Promise<void> {
    if (!api) return;
    this.settings.set(await api.settings.read());
  }

  protected async run(): Promise<void> {
    if (!api || !this.canRun()) return;
    this.setupRunning.set(true);
    this.setupResult.set(null);
    this.log.set([]);
    try {
      const result = await api.backendSetup.run({ distro: this.distro(), route: this.route() });
      this.setupResult.set(result);
      if (result.ok) {
        await this.loadSettings();
        this.showSetup.set(false);
        // The engine re-measures: this app does not get to declare a tier
        // available on the strength of having just built one.
        this.changed.emit();
      }
    } catch (err) {
      this.setupResult.set({
        ok: false,
        pythonPath: null,
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.setupRunning.set(false);
    }
  }

  protected async cancelSetup(): Promise<void> {
    if (!api) return;
    await api.backendSetup.cancel();
  }

  protected async startServer(): Promise<void> {
    if (!api) return;
    this.serverBusy.set(true);
    try {
      this.status.set(await api.vllmServer.start());
    } catch (err) {
      // The rejection carries the guest's log tail. Shown whole — a server that
      // ran out of VRAM has said so, and paraphrasing it loses the only clue.
      this.status.set({
        state: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        url: this.status()?.url ?? '',
        model: this.status()?.model ?? '',
        external: false,
      });
    } finally {
      this.serverBusy.set(false);
    }
  }

  protected async stopServer(): Promise<void> {
    if (!api) return;
    this.serverBusy.set(true);
    try {
      this.status.set(await api.vllmServer.stop());
    } finally {
      this.serverBusy.set(false);
    }
  }

  /**
   * Saved on every change, and the STORED value is what the field then shows:
   * main clamps (0..240, whole minutes), and a field that displayed the number
   * the user typed while the file holds another would be a quiet lie.
   */
  protected async saveKeepWarm(minutes: number | null): Promise<void> {
    if (!api) return;
    const stored = await api.vllmServer.setKeepWarm(typeof minutes === 'number' ? minutes : 0);
    this.keepWarm.set(stored);
  }
}
