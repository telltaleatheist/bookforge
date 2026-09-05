import {
  Component, ChangeDetectionStrategy, OnInit, OnDestroy, signal, computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { DesktopButtonComponent } from '../../../creamsicle-desktop';

/** One check from the Higgs doctor. Mirrors preload's HiggsDoctorResult rows. */
interface HiggsCheck {
  id:
    | 'distro' | 'env' | 'vllm-omni' | 'patch' | 'launcher'
    | 'toggle'
    | 'python' | 'mlx' | 'mlx-audio' | 'narrator' | 'weights'
    | 'platform';
  label: string;
  ok: boolean;
  detail?: string;
}

/**
 * TWO ARMS, ONE SHAPE — see electron/higgs-doctor.ts. `arm` says which backend
 * was examined ('wsl' = the vLLM-Omni server reached through WSL, 'mlx' = the
 * in-process macOS backend, 'none' = a platform with neither), and `remedy` is
 * what to do about a failure on that arm.
 */
interface HiggsDoctorResult {
  valid: boolean;
  arm: 'wsl' | 'mlx' | 'none';
  remedy: string;
  checks: HiggsCheck[];
  notes?: string[];
  envPrefix?: string;
}

/** One catalog voice. Mirrors preload's HiggsModelDto. */
interface HiggsCatalogVoice {
  id: string;
  label: string;
  engineVersion: string;
  kind: 'default' | 'clips' | 'checkpoint';
  voice: {
    clips?: Array<{ path: string; transcript: string; seconds: number }>;
    checkpointDir?: string;
  };
  license: string;
  commercialUse: boolean;
  sampleRate: number;
  backends?: { served?: { maxChars?: number | null; maxCharsSource?: string | null; referenceSecondsCap?: number } };
  _pendingNote?: string;
  note?: string;
}

/**
 * Higgs voices panel — the Settings → Higgs page, beside the Orpheus one.
 *
 * ── Why this is a DOCTOR first and a voice list second ──────────────────────
 *
 * The Orpheus panel is mostly a download manager: voices arrive from HuggingFace
 * and the engine either is or is not installed. Higgs inverts that. The roster is
 * a repo file, so there is nothing to download and nothing can be missing from
 * it — while the ENVIRONMENT is five separate things that can each be
 * independently wrong, two of which (the site-packages patches) revert silently
 * whenever pip upgrades anything in the env. So the question this page exists to
 * answer is "will a Higgs render work", and that question has five parts, each of
 * which is shown with its own reason.
 *
 * A green tick that hides which of the five it is would be worse than no page:
 * "the sentinel-filter patch is missing" and "there is no WSL distro" are both
 * `valid: false` and have nothing else in common.
 *
 * ── The rows are the DOCTOR'S, whichever arm ran ────────────────────────────
 *
 * This page renders whatever checks come back rather than a fixed list, which is
 * what let the macOS arm land here for free: on a Mac the doctor is the MLX one
 * (env, python, mlx, mlx-audio, the narrator backend module, the base weights)
 * and its rows display exactly like the WSL ones. Only three things are
 * arm-aware — the heading, the explainer sentence, and the Install/Repair button,
 * which builds the WSL environment and is therefore offered on the WSL arm alone.
 */
@Component({
  selector: 'app-higgs-voices-panel',
  standalone: true,
  imports: [CommonModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="higgs-panel">
      <div class="explainer">
        <p>
          <strong>Higgs Audio v3</strong> clones a narrator from up to 30&nbsp;seconds of
          reference audio, or renders from a fine-tuned checkpoint.
          @if (hostArm() === 'mlx') {
            On this Mac it runs <strong>in-process on mlx-audio</strong>, in the
            <code>narrator-mlx</code> environment — there is no server and no WSL.
          } @else {
            On Windows it narrates through a served vLLM-Omni endpoint inside WSL.
          }
        </p>
        <p class="licence-warning">
          <strong>Licence:</strong> Higgs&nbsp;v3 is <em>research and non-commercial</em>,
          and a fine-tune of it inherits that. It is enabled here for personal use;
          shipping a commercial build with it needs a separate licence from Boson&nbsp;AI.
        </p>
      </div>

      <!-- ── The environment ─────────────────────────────────────────────── -->
      <div class="section">
        <div class="section-head">
          <h4>{{ hostArm() === 'mlx' ? 'Rendering environment' : 'Serving environment' }}</h4>
          <div class="head-actions">
            <desktop-button size="sm" variant="secondary"
                            [disabled]="busy()" (clicked)="runDoctor()">
              {{ checking() ? 'Checking…' : 'Re-check' }}
            </desktop-button>
            <!--
              THE INSTALLER IS THE WSL ONE, so it is offered on the WSL arm and
              nowhere else. There is no macOS installer: the narrator-mlx env is
              built from packaging/env/narrator-mlx.yml by hand, and a button that
              spawned wsl.exe on a Mac would look like a broken app rather than a
              button that does not apply. The remedy line below says what to do
              instead — it comes from the doctor, which knows which arm it ran.

              KEYED ON THE HOST, NOT ON THE DOCTOR'S ANSWER. The doctor's reply
              is null while the first check is in flight AND after a check that
              FAILED — and a Windows machine whose doctor cannot answer is exactly
              the one whose owner needs Install/Repair. Gating the button on the
              reply would take the repair door away at the moment it is wanted.
            -->
            @if (hostArm() === 'wsl') {
              <desktop-button size="sm" variant="primary"
                              [disabled]="busy()" (clicked)="install()">
                {{ installing() ? 'Installing…' : (doctor()?.valid ? 'Repair' : 'Install') }}
              </desktop-button>
            }
          </div>
        </div>

        @if (hostArm() === null) {
          <p class="check-fail">
            This build did not report which platform it is running on, so this page cannot say
            which Higgs backend applies. The check rows below are still the doctor's own.
          </p>
        }

        @if (doctorError(); as err) {
          <p class="check-fail">Could not run the check: {{ err }}</p>
        }

        @if (doctor(); as d) {
          <ul class="checks">
            @for (c of d.checks; track c.label) {
              <li class="check" [class.ok]="c.ok">
                <span class="check-mark">{{ c.ok ? '✓' : '✗' }}</span>
                <span class="check-label">{{ c.label }}</span>
                @if (c.detail) { <span class="check-detail">{{ c.detail }}</span> }
              </li>
            }
          </ul>
          @if (d.envPrefix) { <p class="env-prefix">{{ d.envPrefix }}</p> }
          @if (!d.valid) { <p class="remedy">{{ d.remedy }}</p> }
          @if (d.notes?.length) {
            <ul class="notes">
              @for (n of d.notes; track n) { <li>{{ n }}</li> }
            </ul>
          }
        } @else if (!doctorError()) {
          <p class="muted">Checking the Higgs environment…</p>
        }

        @if (log(); as text) {
          <pre class="install-log">{{ text }}</pre>
        }
      </div>

      <!-- ── The voices ──────────────────────────────────────────────────── -->
      <div class="section">
        <h4>Voices</h4>
        @if (voicesError(); as err) {
          <p class="check-fail">Could not load the voice catalog: {{ err }}</p>
        }
        @for (v of voices(); track v.id) {
          <div class="voice" [class.pending]="!!v._pendingNote">
            <div class="voice-head">
              <span class="voice-label">{{ v.label }}</span>
              <span class="voice-kind">{{ kindLabel(v) }}</span>
              @if (v._pendingNote) { <span class="voice-badge">not installed yet</span> }
            </div>
            <div class="voice-meta">
              <span>v{{ v.engineVersion }}</span>
              <span>{{ v.sampleRate / 1000 }} kHz</span>
              <span>{{ capLabel(v) }}</span>
              <span class="licence">{{ v.license }}</span>
            </div>
            @if (v._pendingNote) { <p class="voice-note pending-note">{{ v._pendingNote }}</p> }
            @else if (v.note) { <p class="voice-note">{{ v.note }}</p> }
          </div>
        }
        @if (voices().length === 0 && !voicesError()) {
          <p class="muted">No Higgs voices in the catalog.</p>
        }
      </div>
    </div>
  `,
  styles: [`
    .higgs-panel { display: flex; flex-direction: column; gap: 1.25rem; }
    .explainer p { margin: 0 0 0.5rem; font-size: 0.8125rem; color: var(--text-secondary); }
    .licence-warning {
      padding: 0.5rem 0.625rem;
      background: var(--bg-sunken);
      border-left: 3px solid var(--warning);
      border-radius: 3px;
    }
    .section { display: flex; flex-direction: column; gap: 0.5rem; }
    .section-head { display: flex; align-items: center; justify-content: space-between; }
    .section h4 { margin: 0; font-size: 0.875rem; color: var(--text-primary); }
    .head-actions { display: flex; gap: 0.375rem; }

    .checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
    .check {
      display: grid;
      grid-template-columns: 1rem minmax(0, max-content) minmax(0, 1fr);
      gap: 0.5rem;
      align-items: baseline;
      font-size: 0.75rem;
    }
    .check-mark { color: var(--error); font-weight: 600; }
    .check.ok .check-mark { color: var(--success); }
    .check-label { color: var(--text-primary); white-space: nowrap; }
    .check-detail { color: var(--text-secondary); }
    .check-fail { font-size: 0.75rem; color: var(--error); margin: 0; }
    .remedy {
      margin: 0.375rem 0 0;
      padding: 0.4375rem 0.5rem;
      font-size: 0.75rem;
      color: var(--text-primary);
      background: var(--bg-sunken);
      border-left: 3px solid var(--warning);
      border-radius: 3px;
    }
    .notes {
      list-style: none;
      margin: 0.375rem 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.125rem;
      font-size: 0.6875rem;
      color: var(--text-tertiary);
    }
    .env-prefix { font-size: 0.6875rem; color: var(--text-tertiary); margin: 0.25rem 0 0; font-family: monospace; }
    .muted { font-size: 0.75rem; color: var(--text-tertiary); margin: 0; }

    .install-log {
      max-height: 14rem;
      overflow: auto;
      margin: 0.5rem 0 0;
      padding: 0.5rem;
      background: var(--bg-sunken);
      border: 1px solid var(--border-subtle);
      border-radius: 4px;
      font-size: 0.6875rem;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .voice {
      padding: 0.5rem 0.625rem;
      background: var(--bg-elevated);
      border: 1px solid var(--border-subtle);
      border-radius: 5px;
    }
    .voice.pending { opacity: 0.75; border-style: dashed; }
    .voice-head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
    .voice-label { font-size: 0.8125rem; font-weight: 500; color: var(--text-primary); }
    .voice-kind { font-size: 0.6875rem; color: var(--text-secondary); }
    .voice-badge {
      font-size: 0.625rem;
      padding: 0.0625rem 0.3125rem;
      border-radius: 3px;
      background: var(--bg-sunken);
      border: 1px solid var(--warning);
      color: var(--warning);
    }
    .voice-meta {
      display: flex; gap: 0.625rem; flex-wrap: wrap;
      margin-top: 0.1875rem;
      font-size: 0.6875rem;
      color: var(--text-tertiary);
    }
    .voice-meta .licence { font-family: monospace; }
    .voice-note { margin: 0.375rem 0 0; font-size: 0.6875rem; color: var(--text-secondary); }
    .pending-note { color: var(--warning); }
  `],
})
export class HiggsVoicesPanelComponent implements OnInit, OnDestroy {
  readonly doctor = signal<HiggsDoctorResult | null>(null);
  readonly doctorError = signal<string | null>(null);
  readonly voices = signal<HiggsCatalogVoice[]>([]);
  readonly voicesError = signal<string | null>(null);
  readonly checking = signal(false);
  readonly installing = signal(false);
  readonly log = signal<string | null>(null);

  readonly busy = computed(() => this.checking() || this.installing());

  /**
   * WHICH ARM THIS MACHINE IS — from the host, not from the doctor's reply.
   *
   * The two are the same answer (`higgsDoctor()` dispatches on the same
   * `process.platform`), but they are not available at the same times: the
   * doctor's reply is absent while the first check runs and absent again after a
   * check that FAILED, and a Windows machine whose doctor cannot answer is
   * precisely the one whose owner wants Install/Repair. So the page's own
   * layout — heading, explainer, which buttons exist — keys on the host, and only
   * the CHECK ROWS come from the doctor.
   *
   * `null` when this build did not report a platform at all. That is not a
   * platform to guess at, and the template says so instead of quietly deciding
   * this is not Windows.
   */
  readonly hostArm = computed<'wsl' | 'mlx' | 'none' | null>(() => {
    const platform = (window as any).electron?.platform;
    if (typeof platform !== 'string' || !platform) return null;
    if (platform === 'win32') return 'wsl';
    if (platform === 'darwin') return 'mlx';
    return 'none';
  });

  private unsubscribe: (() => void) | null = null;

  ngOnInit(): void {
    // The installer streams; subscribe BEFORE anything can start it so the first
    // lines of a long pip install are not the ones that get lost.
    const api = (window as any).electron?.higgsModels;
    if (api?.onInstallProgress) {
      this.unsubscribe = api.onInstallProgress((text: string) =>
        this.log.set((this.log() ?? '') + text),
      );
    }
    void this.runDoctor();
    void this.loadVoices();
  }

  ngOnDestroy(): void {
    this.unsubscribe?.();
  }

  async runDoctor(): Promise<void> {
    this.checking.set(true);
    this.doctorError.set(null);
    try {
      const api = (window as any).electron?.higgsModels;
      if (!api?.doctor) throw new Error('This build has no Higgs support.');
      const res = await api.doctor();
      if (!res?.success) throw new Error(res?.error || 'The check returned no result.');
      this.doctor.set(res.data as HiggsDoctorResult);
    } catch (err) {
      this.doctor.set(null);
      this.doctorError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.checking.set(false);
    }
  }

  private async loadVoices(): Promise<void> {
    this.voicesError.set(null);
    try {
      const api = (window as any).electron?.higgsModels;
      if (!api?.listCatalog) throw new Error('This build has no Higgs support.');
      const res = await api.listCatalog();
      if (!res?.success) throw new Error(res?.error || 'The catalog returned no result.');
      this.voices.set(res.data as HiggsCatalogVoice[]);
    } catch (err) {
      this.voices.set([]);
      this.voicesError.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Build the environment. Deliberately a manual action with a fresh log each
   * time — this downloads several GB and, on a repair, rewrites files inside
   * site-packages, so it should never be something the page did on its own while
   * someone was reading it.
   */
  async install(): Promise<void> {
    this.installing.set(true);
    this.log.set('');
    try {
      const api = (window as any).electron?.higgsModels;
      const res = await api.installEnv();
      if (!res?.success) {
        this.log.set((this.log() ?? '') + `\n[failed] ${res?.error || `exit ${res?.code}`}\n`);
      }
    } finally {
      this.installing.set(false);
      // Re-check rather than assume: the installer's own exit code says whether
      // it thinks it finished, and the doctor says whether the result actually
      // serves. Those are different claims and only the second one matters.
      await this.runDoctor();
    }
  }

  kindLabel(v: HiggsCatalogVoice): string {
    // 'clips' is labelled as the diagnostic it is: the panel LISTS every catalog
    // entry (it is the page you go to to find out what exists), while the
    // narration dropdown offers only fine-tunes and the served default.
    if (v.kind === 'checkpoint') return 'fine-tune (merged checkpoint)';
    if (v.kind === 'default') return "the model's own voice (no reference)";
    const secs = v.voice.clips?.[0]?.seconds;
    return secs === undefined
      ? 'zero-shot clone · diagnostic only'
      : `zero-shot clone · ${secs.toFixed(1)} s reference · diagnostic only`;
  }

  /**
   * The chunk cap as a person should read it — including the case that matters
   * most, which is that a fine-tune has not been measured yet. Showing a blank
   * cell there would read as "no cap"; it is the opposite.
   */
  capLabel(v: HiggsCatalogVoice): string {
    const cap = v.backends?.served?.maxChars;
    if (typeof cap !== 'number') return 'chunk cap not measured';
    const src = v.backends?.served?.maxCharsSource;
    return src ? `${cap} chars/chunk (${src})` : `${cap} chars/chunk`;
  }
}
