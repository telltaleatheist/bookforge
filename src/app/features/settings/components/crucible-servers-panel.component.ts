import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import type {
  CrucibleActivityView,
  CrucibleModelRow,
  CrucibleProbeResult,
  CrucibleServersView,
  RankedServerRow,
  WaitForDefault,
} from '@shared/crucible/settings-wire';

/** The reserved name for the server on this machine. Never a registry entry. */
const LOCAL = 'local';

/**
 * Settings → Crucible Servers.
 *
 * **The first BookForge UI Crucible has ever justified**, and the reason is
 * written down rather than assumed (crucible `docs/PHASE7-LANES.md` section 7):
 * every phase so far held the line at "no UI, no IPC, no settings row", because
 * the CLI proved each seam without moving the app. A server registry Owen edits
 * by hand in a JSON file under `<userData>` is not a feature, so this is where
 * the line is deliberately crossed.
 *
 * ── What is on this page, and which contract each part comes from ──────────
 *
 * **The local server first.** It is never in the registry: its token lives in
 * its own `config.toml` and is read from there on every call (§7.1.1). When
 * there is none that is a NAMED STATE with its fix — `no_local_config`,
 * `no_wsl_distro` — shown as a state rather than an error, because a laptop that
 * only ever renders on the Mac is not broken.
 *
 * **Add, with a Test that calls `ping` then `info`** (PHASE5-APPS.md section 2).
 * The two-step is the point: `ping` is unauthenticated and `info` is not, so the
 * pair tells "nothing there" from "not a Crucible" from "wrong token", and each
 * has a different fix. Adding refuses exactly as the registry refuses and shows
 * the registry's own sentence — there is no second copy of those rules here.
 *
 * **Drag to rank; a switch to enable** (§4.2.2). The list's order IS the rank,
 * so there are no rank numbers, and a newly added server lands at the BOTTOM —
 * adding a droplet at midnight is not a statement that it outranks the 3090 Ti.
 * **New jobs wait for: the top-ranked server / Any** is §4.2.1a's one setting,
 * and it exists so that a default never manufactures an instruction nobody gave.
 *
 * **Activity is drawn honestly** (§5, §5.1). A job has a denominator and gets a
 * percentage; a streaming session never will — its rows arrive one `say` at a
 * time — so it gets counts and no bar. A foreign job (one this app did not
 * submit) is drawn as somebody else's work, with no cancel button.
 *
 * **Load / unload are OPERATOR verbs** (PHASE5-APPS.md section 2), which is why
 * they are two-step here: each submits a job that takes that machine's card, and
 * nothing on this page does it unasked.
 */
@Component({
  selector: 'app-crucible-servers-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, DesktopButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cru">
      <p class="cru-intro">
        A Crucible is one inference server for every app on a machine: it runs models and returns
        bytes. BookForge reaches the server on this machine and any you add here over HTTP —
        the same code path either way.
      </p>

      @if (loadError(); as err) {
        <p class="cru-error">{{ err }}</p>
      }

      <!-- ── The server on this machine ─────────────────────────────────── -->
      <div class="cru-group-row">
        <h4 class="cru-group">This machine</h4>
        <!-- Re-read the config. The first wsl.exe call on a cold VM can fail
             (wsl_read_failed) while it boots, and the fix is to ask again. -->
        <desktop-button variant="ghost" size="sm" (click)="recheck()">Re-check</desktop-button>
      </div>
      @if (view(); as v) {
        @if (v.local.present) {
          <div class="cru-card">
            <div class="cru-card-head">
              <div>
                <span class="cru-name">{{ v.local.serverName }}</span>
                <span class="cru-badge local">local</span>
              </div>
              <span class="cru-url">{{ v.local.url }}</span>
            </div>
            <p class="cru-meta">
              Token {{ v.local.tokenMasked }}, read from
              <code>{{ v.local.configPath }}</code>
              {{ v.local.via === 'wsl' ? '(inside WSL)' : '' }} every time — this app keeps no copy.
            </p>
          </div>
        } @else {
          <div class="cru-card state">
            <span class="cru-badge muted">{{ v.local.code }}</span>
            <p class="cru-meta">{{ v.local.reason }}</p>
          </div>
        }
      } @else {
        <p class="cru-meta">Reading this machine's Crucible config…</p>
      }

      <!-- ── Rank, enablement, and the queue's default ──────────────────── -->
      <h4 class="cru-group">Servers the queue may use</h4>
      <p class="cru-sub">
        Drag to set the order — the first one that is free gets the work. The order IS the
        priority; there are no rank numbers. A newly added server starts at the bottom.
      </p>

      @if (ranked().length === 0) {
        <p class="cru-meta">No Crucible server yet. Add one below.</p>
      }

      @for (row of ranked(); track row.name) {
        <div
          class="cru-row"
          [class.disabled]="!row.enabled"
          [class.dragging]="dragName() === row.name"
          draggable="true"
          (dragstart)="onDragStart(row.name)"
          (dragover)="onDragOver($event, row.name)"
          (dragend)="onDragEnd()"
          (drop)="onDrop($event)"
        >
          <div class="cru-row-head">
            <span class="cru-grip" title="Drag to re-order">⠿</span>
            <label class="cru-toggle" [title]="row.enabled ? 'The queue may use this server' : 'The queue will not use this server'">
              <input type="checkbox" [checked]="row.enabled" (change)="setEnabled(row.name, $any($event.target).checked)" />
              <span>{{ row.enabled ? 'Enabled' : 'Disabled' }}</span>
            </label>
            <span class="cru-name">{{ row.name }}</span>
            @if (row.name === localName) {
              <span class="cru-badge local">this machine</span>
            }
            @if (staleOf(row.name)) {
              <span class="cru-badge stale">stale — a copy of this machine's own token</span>
            }
            <span class="cru-spacer"></span>
            <desktop-button variant="ghost" size="sm" [disabled]="busy()[row.name] === true" (click)="test(row.name)">
              {{ busy()[row.name] ? 'Testing…' : 'Test' }}
            </desktop-button>
            <desktop-button variant="ghost" size="sm" [disabled]="busy()[row.name] === true" (click)="refreshServer(row.name)">
              Refresh
            </desktop-button>
            @if (row.name !== localName) {
              @if (confirmRemove() === row.name) {
                <span class="cru-confirm">
                  Forget {{ row.name }}?
                  <desktop-button variant="ghost" size="sm" (click)="remove(row.name)">Remove</desktop-button>
                  <desktop-button variant="ghost" size="sm" (click)="confirmRemove.set(null)">Cancel</desktop-button>
                </span>
              } @else {
                <desktop-button variant="ghost" size="sm" (click)="confirmRemove.set(row.name)">Remove</desktop-button>
              }
            } @else {
              <span class="cru-note">Not removable — it is this machine's config, not an entry.</span>
            }
          </div>

          @if (urlOf(row.name); as url) {
            <p class="cru-meta">{{ url }} · token {{ maskOf(row.name) }}</p>
          }

          <!-- What it says about itself -->
          @if (probe()[row.name]; as p) {
            @if (p.outcome === 'ok') {
              <p class="cru-facts">
                <strong>{{ p.facts.serverName }}</strong> v{{ p.facts.version }} · {{ p.facts.backend }} ·
                {{ p.facts.gpu.name }} ({{ gb(p.facts.gpu.vramBytes) }}) · lane {{ p.facts.health }}@if (p.facts.queueDepth > 0) {, {{ p.facts.queueDepth }} queued}
              </p>
              <p class="cru-meta">Job types: {{ p.facts.jobTypes.join(', ') }}</p>
              <p class="cru-meta">
                @if (p.facts.residentModels.length > 0) {
                  Resident ({{ p.facts.residentKind }}): {{ p.facts.residentModels.join(', ') }}
                } @else {
                  Nothing is resident — an idle Crucible holds no VRAM at all.
                }
              </p>
            } @else {
              <p class="cru-refusal"><span class="cru-badge bad">{{ p.outcome }}</span> {{ p.message }}</p>
            }
          }

          <!-- What it is doing right now -->
          @if (activity()[row.name]; as a) {
            <div class="cru-activity">
              <p class="cru-meta">
                Up {{ hours(a.uptimeS) }} · lane {{ a.slot.busy }}/{{ a.slot.of }}@if (a.slot.queueDepth > 0) {, {{ a.slot.queueDepth }} queued} ·
                {{ a.slot.acceptsWork ? 'accepting work' : 'not accepting work' }}
                @if (a.warming) { · warming {{ a.warming }} }
                @if (a.claimedBy) { · claimed by {{ a.claimedBy }} }
              </p>
              @for (job of a.running; track job.jobId) {
                <div class="cru-job">
                  <span class="cru-job-name">{{ job.type }}@if (job.model) { · {{ job.model }}}</span>
                  <span class="cru-bar"><span class="cru-fill" [style.width.%]="job.progress * 100"></span></span>
                  <span class="cru-pct">{{ (job.progress * 100).toFixed(0) }}%</span>
                  <span class="cru-job-msg">{{ job.message }}</span>
                  @if (!isOurs(job.client)) { <span class="cru-badge muted">{{ job.client || 'another client' }}</span> }
                </div>
              }
              @for (job of a.queued; track job.jobId) {
                <div class="cru-job"><span class="cru-job-name">{{ job.type }}</span><span class="cru-job-msg">queued</span></div>
              }
              @if (a.streaming; as s) {
                <!-- No percentage, ever: a reader's rows arrive one at a time, so a
                     bar would be a fraction of whatever has arrived (§5.1). -->
                <div class="cru-job">
                  <span class="cru-job-name">streaming · {{ s.voice }}</span>
                  <span class="cru-job-msg">
                    {{ s.finished }} of {{ s.said }} said, {{ s.inFlight }} in flight, {{ s.seconds.toFixed(0) }}s of audio
                    — no percentage: a listener never handed over the whole of the work.
                  </span>
                  @if (!isOurs(s.client)) { <span class="cru-badge muted">{{ s.client || 'another client' }}</span> }
                </div>
              }
              @if (a.chatInFlight > 0) {
                <p class="cru-meta">{{ a.chatInFlight }} chat completion(s) in flight.</p>
              }
              @if (a.running.length === 0 && a.queued.length === 0 && !a.streaming && a.chatInFlight === 0) {
                <p class="cru-meta">Idle.</p>
              }
            </div>
          }

          <!-- Models, and the two operator verbs -->
          @if (models()[row.name]; as rows) {
            <div class="cru-models">
              @for (m of rows; track m.id) {
                <div class="cru-model">
                  <span class="cru-model-id">{{ m.id }}</span>
                  <span class="cru-badge" [class.good]="m.resident" [class.muted]="!m.resident">
                    {{ m.resident ? 'resident' : (m.installed ? 'installed' : 'not installed') }}
                  </span>
                  @if (!m.loadable && !m.resident) {
                    <span class="cru-note">{{ m.reason }}</span>
                  }
                  <span class="cru-spacer"></span>
                  @if (m.resident) {
                    @if (confirmOp() === row.name + '/unload/' + m.id) {
                      <span class="cru-confirm">
                        Take {{ m.id }} off {{ row.name }}'s card?
                        <desktop-button variant="ghost" size="sm" (click)="unloadModel(row.name, m.id)">Unload</desktop-button>
                        <desktop-button variant="ghost" size="sm" (click)="confirmOp.set(null)">Cancel</desktop-button>
                      </span>
                    } @else {
                      <desktop-button variant="ghost" size="sm" (click)="confirmOp.set(row.name + '/unload/' + m.id)">Unload</desktop-button>
                    }
                  } @else if (m.loadable) {
                    @if (confirmOp() === row.name + '/load/' + m.id) {
                      <span class="cru-confirm">
                        Load {{ m.id }} onto {{ row.name }}'s card?
                        <desktop-button variant="ghost" size="sm" (click)="loadModel(row.name, m.id)">Load</desktop-button>
                        <desktop-button variant="ghost" size="sm" (click)="confirmOp.set(null)">Cancel</desktop-button>
                      </span>
                    } @else {
                      <desktop-button variant="ghost" size="sm" (click)="confirmOp.set(row.name + '/load/' + m.id)">Load</desktop-button>
                    }
                  }
                </div>
              }
              @if (rows.length === 0) {
                <p class="cru-meta">This server has no model manifests.</p>
              }
            </div>
          }

          @if (rowError()[row.name]; as err) {
            <p class="cru-refusal">{{ err }}</p>
          }
          @if (rowNote()[row.name]; as note) {
            <p class="cru-meta">{{ note }}</p>
          }
        </div>
      }

      <!-- Names the rank record holds that no server answers to. Reported, never pruned. -->
      @for (name of unknown(); track name) {
        <div class="cru-row stale-row">
          <span class="cru-name">{{ name }}</span>
          <span class="cru-note">
            is ranked here but is not one of this machine's servers any more. Its rank is kept in
            case it comes back.
          </span>
          <span class="cru-spacer"></span>
          <desktop-button variant="ghost" size="sm" (click)="forget(name)">Forget it</desktop-button>
        </div>
      }

      <!-- The one setting that keeps a default from writing an instruction (§4.2.1a) -->
      <div class="cru-waitfor">
        <span class="cru-waitfor-label">New jobs wait for:</span>
        <label class="cru-radio">
          <input type="radio" name="cru-waitfor" [checked]="waitFor() === 'top-ranked'" (change)="setWaitFor('top-ranked')" />
          <span>the top-ranked server</span>
        </label>
        <label class="cru-radio">
          <input type="radio" name="cru-waitfor" [checked]="waitFor() === 'any'" (change)="setWaitFor('any')" />
          <span>Any</span>
        </label>
      </div>
      <p class="cru-sub">
        A row that names a server waits for that server, even when another is free — the machines
        are not interchangeable. “Any” is for a night's work: each job takes the first server that
        will have it, preferring this order. Rows already queued are never re-routed.
      </p>

      <!-- ── Add ────────────────────────────────────────────────────────── -->
      <h4 class="cru-group">Add a Crucible server</h4>
      <p class="cru-sub">
        Only servers on OTHER machines are added here. The one on this machine is read from its own
        config. Get its token by running <code>crucible token --show</code> on that host.
      </p>
      <div class="cru-add">
        <input class="cru-input" type="text" placeholder="Name (e.g. mac)" [(ngModel)]="draftName" />
        <input class="cru-input wide" type="text" placeholder="http://host:7100" [(ngModel)]="draftUrl" />
        <input class="cru-input" type="password" autocomplete="off" placeholder="Bearer token" [(ngModel)]="draftToken" />
        <desktop-button variant="ghost" size="sm" [disabled]="addBusy()" (click)="testAddress()">
          {{ addBusy() ? 'Testing…' : 'Test' }}
        </desktop-button>
        <desktop-button variant="primary" size="sm" [disabled]="addBusy()" (click)="add()">Add</desktop-button>
      </div>
      @if (addProbe(); as p) {
        @if (p.outcome === 'ok') {
          <p class="cru-facts">
            OK — <strong>{{ p.facts.serverName }}</strong> v{{ p.facts.version }} · {{ p.facts.backend }} ·
            {{ p.facts.gpu.name }} ({{ gb(p.facts.gpu.vramBytes) }}) · job types {{ p.facts.jobTypes.join(', ') }} ·
            @if (p.facts.residentModels.length > 0) { resident: {{ p.facts.residentModels.join(', ') }} } @else { nothing resident }
          </p>
        } @else {
          <p class="cru-refusal"><span class="cru-badge bad">{{ p.outcome }}</span> {{ p.message }}</p>
        }
      }
      @if (addError(); as err) {
        <p class="cru-refusal">{{ err }}</p>
      }
    </div>
  `,
  styles: [`
    .cru { display: flex; flex-direction: column; gap: 12px; max-width: 820px; }
    .cru-intro, .cru-sub { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); }
    .cru-sub { font-size: 12px; }
    .cru-group { margin: 10px 0 0; font-size: 13px; font-weight: 700; color: var(--text-primary); }
    .cru-group-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .cru-meta { margin: 2px 0 0; font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); line-height: 1.45; }
    .cru-note { font-size: 12px; color: var(--text-tertiary, var(--text-secondary)); }
    .cru-error, .cru-refusal { margin: 4px 0 0; font-size: 12px; color: var(--error, #d05a5a); line-height: 1.45; }
    .cru-facts { margin: 6px 0 0; font-size: 12px; color: var(--text-secondary); line-height: 1.45; }
    .cru-card, .cru-row {
      display: flex; flex-direction: column; gap: 4px;
      padding: 10px 12px; border: 1px solid var(--border-subtle, var(--border-default));
      border-radius: 8px; background: var(--bg-surface, var(--surface-1));
    }
    .cru-card.state { border-style: dashed; }
    .cru-card-head, .cru-row-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .cru-row.disabled { opacity: 0.6; }
    .cru-row.dragging { border-color: var(--accent, var(--accent-primary)); }
    .cru-row.stale-row { flex-direction: row; align-items: center; border-style: dashed; }
    .cru-grip { cursor: grab; color: var(--text-tertiary, #888); font-size: 14px; user-select: none; }
    .cru-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
    .cru-url { font-size: 12px; color: var(--text-secondary); }
    .cru-spacer { flex: 1; }
    .cru-badge { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--bg-elevated, var(--surface-2)); color: var(--text-secondary); }
    .cru-badge.local { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
    .cru-badge.good { background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); }
    .cru-badge.bad, .cru-badge.stale { background: color-mix(in srgb, var(--error, #d05a5a) 18%, transparent); color: var(--error, #d05a5a); }
    .cru-toggle, .cru-radio { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
    .cru-confirm { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); }
    .cru-activity, .cru-models { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .cru-job, .cru-model { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary); }
    .cru-job-name, .cru-model-id { font-weight: 600; color: var(--text-primary); }
    .cru-job-msg { color: var(--text-tertiary, var(--text-secondary)); }
    .cru-bar { width: 120px; height: 6px; border-radius: 3px; background: var(--border-default); overflow: hidden; }
    .cru-fill { display: block; height: 100%; background: var(--accent, var(--accent-primary)); }
    .cru-pct { min-width: 34px; text-align: right; }
    .cru-waitfor { display: flex; align-items: center; gap: 14px; margin-top: 6px; }
    .cru-waitfor-label { font-size: 13px; color: var(--text-primary); font-weight: 600; }
    .cru-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .cru-input {
      flex: 1; min-width: 120px; padding: 6px 8px; border-radius: 6px;
      border: 1px solid var(--border-default); background: var(--bg-input, var(--surface-1));
      color: var(--text-primary); font-size: 13px;
    }
    .cru-input.wide { flex: 2; min-width: 200px; }
    code { font-family: var(--font-mono, monospace); background: var(--bg-elevated, var(--surface-2)); padding: 0 4px; border-radius: 3px; }
  `],
})
export class CrucibleServersPanelComponent {
  private readonly electron = inject(ElectronService);

  readonly localName = LOCAL;

  readonly view = signal<CrucibleServersView | null>(null);
  readonly loadError = signal<string | null>(null);

  readonly ranked = computed<RankedServerRow[]>(() => this.view()?.routing.ranked ?? []);
  readonly unknown = computed<string[]>(() => this.view()?.routing.unknown ?? []);
  readonly waitFor = computed<WaitForDefault | null>(() => this.view()?.routing.newJobsWaitFor ?? null);

  /** Per-server probe / activity / model answers, each asked for on demand. */
  readonly probe = signal<Record<string, CrucibleProbeResult>>({});
  readonly activity = signal<Record<string, CrucibleActivityView>>({});
  readonly models = signal<Record<string, CrucibleModelRow[]>>({});
  readonly rowError = signal<Record<string, string>>({});
  readonly rowNote = signal<Record<string, string>>({});
  readonly busy = signal<Record<string, boolean>>({});

  readonly confirmRemove = signal<string | null>(null);
  readonly confirmOp = signal<string | null>(null);

  draftName = '';
  draftUrl = '';
  draftToken = '';
  readonly addBusy = signal(false);
  readonly addProbe = signal<CrucibleProbeResult | null>(null);
  readonly addError = signal<string | null>(null);

  private readonly dragging = signal<string | null>(null);
  readonly dragName = this.dragging.asReadonly();

  constructor() {
    void this.reload();
  }

  // ── The list ───────────────────────────────────────────────────────────

  /**
   * Ask again. The local server's config is read through `wsl.exe` on Windows,
   * and the first call against a cold VM can fail while it boots — that is
   * `wsl_read_failed`, a real answer, and asking again is the fix rather than a
   * retry loop nobody can see.
   */
  async recheck(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const res = await this.electron.crucible.servers();
    if (!res.success || !res.data) {
      // Never an empty list on failure: an empty list means "no servers", and
      // "we could not read the registry" is a different sentence with a fix.
      this.loadError.set(res.error ?? 'The Crucible server list could not be read, and nothing said why.');
      return;
    }
    this.loadError.set(null);
    this.view.set(res.data);
  }

  /** A remote's URL, or the local server's. */
  urlOf(name: string): string | null {
    const v = this.view();
    if (!v) return null;
    if (name === LOCAL) return v.local.present ? v.local.url : null;
    return v.remotes.find((row) => row.name === name)?.url ?? null;
  }

  maskOf(name: string): string {
    const v = this.view();
    if (!v) return '';
    if (name === LOCAL) return v.local.present ? v.local.tokenMasked : '';
    return v.remotes.find((row) => row.name === name)?.tokenMasked ?? '';
  }

  staleOf(name: string): boolean {
    return this.view()?.remotes.find((row) => row.name === name)?.stale === 'loopback_duplicates_local';
  }

  /** Did WE submit this? A foreign job is drawn as somebody else's (§5). */
  isOurs(client: string | null): boolean {
    return client !== null && client.startsWith('bookforge');
  }

  gb(bytes: number): string {
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  hours(seconds: number): string {
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} h`;
  }

  // ── Probing ────────────────────────────────────────────────────────────

  /** Ping, then info: the two-step that tells the three failures apart. */
  async test(name: string): Promise<void> {
    this.setBusy(name, true);
    try {
      const res = await this.electron.crucible.test(name);
      if (!res.success || !res.data) {
        this.setRowError(name, res.error ?? 'The test failed and said nothing about why.');
        return;
      }
      this.probe.update((map) => ({ ...map, [name]: res.data as CrucibleProbeResult }));
      this.setRowError(name, null);
    } finally {
      this.setBusy(name, false);
    }
  }

  /** Test + activity + models, which is what "what does this machine have" means. */
  async refreshServer(name: string): Promise<void> {
    await this.test(name);
    await this.refreshActivity(name);
    await this.refreshModels(name);
  }

  async refreshActivity(name: string): Promise<void> {
    const res = await this.electron.crucible.activity(name);
    if (!res.success || !res.data) {
      this.setRowError(name, res.error ?? 'Asking what that server is doing failed and said nothing about why.');
      return;
    }
    if (res.data.outcome !== 'ok') {
      this.setRowError(name, res.data.message);
      return;
    }
    this.activity.update((map) => ({ ...map, [name]: (res.data as { activity: CrucibleActivityView }).activity }));
  }

  async refreshModels(name: string): Promise<void> {
    const res = await this.electron.crucible.models(name);
    if (!res.success || !res.data) {
      this.setRowError(name, res.error ?? 'Asking that server for its models failed and said nothing about why.');
      return;
    }
    if (res.data.outcome !== 'ok') {
      this.setRowError(name, res.data.message);
      return;
    }
    this.models.update((map) => ({ ...map, [name]: (res.data as { models: CrucibleModelRow[] }).models }));
  }

  // ── Rank, enablement, the default ──────────────────────────────────────

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const res = await this.electron.crucible.setEnabled(name, enabled);
    if (!res.success || !res.data) {
      this.setRowError(name, res.error ?? 'That switch could not be saved, and nothing said why.');
      return;
    }
    this.applyRouting(res.data);
  }

  async setWaitFor(value: WaitForDefault): Promise<void> {
    const res = await this.electron.crucible.setWaitFor(value);
    if (!res.success || !res.data) {
      this.loadError.set(res.error ?? 'That setting could not be saved, and nothing said why.');
      return;
    }
    this.applyRouting(res.data);
  }

  async forget(name: string): Promise<void> {
    const res = await this.electron.crucible.forget(name);
    if (!res.success || !res.data) {
      this.loadError.set(res.error ?? `"${name}" could not be forgotten, and nothing said why.`);
      return;
    }
    this.applyRouting(res.data);
  }

  private applyRouting(routing: CrucibleServersView['routing']): void {
    this.loadError.set(null);
    this.view.update((v) => (v === null ? v : { ...v, routing }));
  }

  // ── Drag to re-order. The list's order IS the rank. ────────────────────

  onDragStart(name: string): void {
    this.dragging.set(name);
  }

  /**
   * Reorder as the pointer passes, which is what makes the list feel like the
   * rank. The move is local until the drag ends; `onDragEnd` is what persists.
   */
  onDragOver(event: DragEvent, over: string): void {
    event.preventDefault();
    const held = this.dragging();
    if (held === null || held === over) return;
    const order = this.ranked().map((row) => row.name);
    const from = order.indexOf(held);
    const to = order.indexOf(over);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, ...order.splice(from, 1));
    this.view.update((v) => {
      if (v === null) return v;
      const byName = new Map(v.routing.ranked.map((row) => [row.name, row]));
      const reordered = order
        .map((name) => byName.get(name))
        .filter((row): row is RankedServerRow => row !== undefined);
      return { ...v, routing: { ...v.routing, ranked: reordered } };
    });
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
  }

  /** Persist what the drag produced, and take the main process's answer back. */
  async onDragEnd(): Promise<void> {
    if (this.dragging() === null) return;
    this.dragging.set(null);
    const order = this.ranked().map((row) => row.name);
    const res = await this.electron.crucible.setOrder(order);
    if (!res.success || !res.data) {
      // The list on screen is now a lie; re-read rather than leave it.
      this.loadError.set(res.error ?? 'The new order could not be saved, and nothing said why.');
      await this.reload();
      return;
    }
    this.applyRouting(res.data);
  }

  // ── Add / remove ───────────────────────────────────────────────────────

  async testAddress(): Promise<void> {
    this.addBusy.set(true);
    this.addError.set(null);
    try {
      const res = await this.electron.crucible.testAddress(this.draftUrl, this.draftToken);
      if (!res.success || !res.data) {
        this.addError.set(res.error ?? 'The test failed and said nothing about why.');
        return;
      }
      this.addProbe.set(res.data);
    } finally {
      this.addBusy.set(false);
    }
  }

  /**
   * Record the remote. The registry's refusals are shown verbatim — the reserved
   * name, a loopback URL (that is this machine, read from its own config), a
   * duplicate name, a URL carrying `/v1`, an empty token. None of those rules is
   * re-implemented here, so none of them can drift.
   */
  async add(): Promise<void> {
    this.addBusy.set(true);
    this.addError.set(null);
    try {
      const res = await this.electron.crucible.add({
        name: this.draftName,
        url: this.draftUrl,
        token: this.draftToken,
      });
      if (!res.success) {
        this.addError.set(res.error ?? 'The server could not be added, and nothing said why.');
        return;
      }
      // The token is never echoed back into the field: it is in the registry now
      // and this page can only ever show it masked.
      this.draftName = '';
      this.draftUrl = '';
      this.draftToken = '';
      this.addProbe.set(null);
      await this.reload();
    } finally {
      this.addBusy.set(false);
    }
  }

  async remove(name: string): Promise<void> {
    this.confirmRemove.set(null);
    const res = await this.electron.crucible.remove(name);
    if (!res.success) {
      this.setRowError(name, res.error ?? `"${name}" could not be removed, and nothing said why.`);
      return;
    }
    await this.reload();
  }

  // ── The two operator verbs ─────────────────────────────────────────────

  /**
   * Make a model resident. This TAKES THE CARD on that machine, so it happens
   * only from this button — and the job id it returns is the honest answer: the
   * load runs on the server, and the activity row is where it is watched.
   */
  async loadModel(name: string, model: string): Promise<void> {
    this.confirmOp.set(null);
    const res = await this.electron.crucible.loadModel(name, model);
    await this.afterOperate(name, res, `Asked ${name} to load ${model}`);
  }

  async unloadModel(name: string, model: string): Promise<void> {
    this.confirmOp.set(null);
    const res = await this.electron.crucible.unloadModel(name, model);
    await this.afterOperate(name, res, `Asked ${name} to unload ${model}`);
  }

  private async afterOperate(
    name: string,
    res: { success: boolean; data?: { outcome: 'ok'; jobId: string } | { outcome: string; message: string }; error?: string },
    what: string,
  ): Promise<void> {
    if (!res.success || !res.data) {
      this.setRowError(name, res.error ?? 'That request failed and said nothing about why.');
      return;
    }
    if (res.data.outcome !== 'ok') {
      this.setRowError(name, (res.data as { message: string }).message);
      return;
    }
    this.setRowError(name, null);
    this.rowNote.update((map) => ({ ...map, [name]: `${what} — job ${(res.data as { jobId: string }).jobId}. Refresh to watch it.` }));
    await this.refreshActivity(name);
    await this.refreshModels(name);
  }

  // ── Small state helpers ────────────────────────────────────────────────

  private setBusy(name: string, value: boolean): void {
    this.busy.update((map) => ({ ...map, [name]: value }));
  }

  private setRowError(name: string, message: string | null): void {
    this.rowError.update((map) => {
      const next = { ...map };
      if (message === null) delete next[name];
      else next[name] = message;
      return next;
    });
  }
}
