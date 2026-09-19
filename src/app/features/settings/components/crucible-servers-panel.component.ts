import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
// `FormsModule` went with the manual-add form (PHASE19 §4): with the paste box
// and the Name / Address / Access key triple gone there is no `ngModel` left on
// this panel at all.

import { DesktopButtonComponent } from '../../../creamsicle-desktop';
import { ElectronService } from '../../../core/services/electron.service';
import { CrucibleDoorsComponent } from './crucible-doors.component';
import { CrucibleEngineControlsComponent } from './crucible-engine-controls.component';
import type {
  CrucibleActivityView,
  CrucibleModelRow,
  CrucibleProbeResult,
  CrucibleServersView,
  RankedServerRow,
  WaitForDefault,
} from '@shared/crucible/settings-wire';
import type {
  CrucibleCoordinationMap,
  CrucibleCoordinationState,
} from '@shared/crucible/coordinate-wire';
import { coordinationWords } from './crucible-words';

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
 * **ONE LIST, ONE KIND OF ROW** (Owen's ruling, 2026-09-15: *"a local crucible
 * server shouldnt be treated any differently than a remote crucible server"*).
 * This page used to open with a card of its own for the engine on this machine
 * — a card the app manufactured from a config file, with a badge, no Remove
 * button and a sentence explaining why. It is gone. Every server is a row,
 * every row ranks, disables, tests, opens and removes the same way, and
 * nothing here asks where a machine is.
 *
 * What is left of the old card is an OFFER, and it lives in the Connect door
 * below with the other ways of adding a server: *there is a Crucible on this
 * computer — add it?* Refusing it is an ordinary state, not a broken app.
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
  imports: [CommonModule, DesktopButtonComponent, CrucibleDoorsComponent, CrucibleEngineControlsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cru">
      <!--
        THE FIRST MENTION, and the only one in this panel that spells the
        product out. Everything below says "engine" (the brief of 2026-09-14,
        §3): the code keeps its names, the copy stops using them.
      -->
      <p class="cru-intro">
        A <strong>model engine (Crucible)</strong> is one piece of software that runs the models
        every app on a machine needs — narration, transcription, text. BookForge uses the engine
        on this machine and any you connect to below, over the network, the same way either way.
        When it connects to one it makes sure that engine has what BookForge needs, without
        asking you anything.
      </p>

      @if (loadError(); as err) {
        <p class="cru-error">{{ err }}</p>
      }

      <!-- ── Rank, enablement, and the queue's default ──────────────────── -->
      <div class="cru-group-row">
        <h4 class="cru-group">Engines the queue may use</h4>
        <!-- Ask again. Nothing here is on a timer, and a machine that has just
             had a Crucible installed or started is one press away from showing. -->
        <desktop-button variant="ghost" size="sm" (click)="recheck()">Re-check</desktop-button>
      </div>
      <p class="cru-sub">
        Drag to set the order — the first one that is free gets the work. The order IS the
        priority; there are no rank numbers. A newly connected engine starts at the bottom.
        Switching one off is how you say “not that one”: BookForge then asks it for nothing at
        all.
      </p>

      @if (ranked().length === 0) {
        <p class="cru-meta">No engine yet. Connect to one below.</p>
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
            <span class="cru-spacer"></span>
            <!--
              THE "MAINTENANCE CONSOLE" BUTTON IS GONE (2026-09-17). Owen:
              *"no more opening a crucible page in bookforge settings. we're
              putting the settings right there in the settings tab of bookforge
              and configuring crucible there in settings."*

              It was here on PHASE13-OPERATOR.md section 5.3's reasoning — that
              the server's own page is where everything about a server happens:
              install a job type, pull weights, watch the task, read the token.
              Three of those four are in this app now and the fourth never
              needed the console:

                * pull weights, and remove them - Settings, AI, per class, with
                  the engine's own candidate list and the size in the confirm.
                * which model serves each class - Settings, AI, written through
                  to that engine's own settings document.
                * install a job type - BookForge posts its module to every
                  engine it connects to (PHASE14-ENVPACKS.md section 4a); the
                  row below says where that got to.
                * read the token - NOBODY reads a token any more (PHASE19 §0).
                  The "Copy connect code" button that used to be two controls
                  along is deleted with the rest of them.

              The page still EXISTS and is still served by the engine at its own
              address; what is gone is BookForge opening it. A person who wants
              it has a browser.
            -->
            <!--
              THERE IS NO "SET UP FOR BOOKFORGE" BUTTON — crucible
              docs/PHASE14-ENVPACKS.md §4a. Presence of the app is the request:
              BookForge coordinates with every engine it connects to, and this
              row shows where that got to (below) instead of offering a thing
              to press. What is drawn is the coordination state for this row.
            -->
            <!--
              "COPY CONNECT CODE" IS GONE (PHASE19 §3, 2026-09-19).

              It put a "crucible://name@host:port/#token" line on the
              clipboard, which is a TOKEN, and Owen ruled the whole shape away
              on 2026-09-18: *"we removed tokens. this system is supposed to
              work like ollama, which doesn't require a token request/approval
              to connect. its protection is the system firewall."* Pairing is
              open, so another app on the network connects by ADDRESS in two
              seconds and has no use for a line copied out of here. Nothing is
              shown a token and nothing offers to hand one over.
            -->
            <desktop-button variant="ghost" size="sm" [disabled]="busy()[row.name] === true" (click)="test(row.name)">
              {{ busy()[row.name] ? 'Testing…' : 'Test' }}
            </desktop-button>
            <desktop-button variant="ghost" size="sm" [disabled]="busy()[row.name] === true" (click)="refreshServer(row.name)">
              Refresh
            </desktop-button>
            <!--
              EVERY ROW IS REMOVABLE. The engine on this machine used to be the
              one that was not, because it was not a registry entry at all.
              Removing a row forgets an address and a key; it never uninstalls
              anything, which is a different door further down.
            -->
            @if (confirmRemove() === row.name) {
              <span class="cru-confirm">
                Forget {{ row.name }}?
                <desktop-button variant="ghost" size="sm" (click)="remove(row.name)">Remove</desktop-button>
                <desktop-button variant="ghost" size="sm" (click)="confirmRemove.set(null)">Cancel</desktop-button>
              </span>
            } @else {
              <desktop-button variant="ghost" size="sm" (click)="confirmRemove.set(row.name)">Remove</desktop-button>
            }
          </div>

          @if (urlOf(row.name); as url) {
            <p class="cru-meta">{{ url }} · token {{ maskOf(row.name) }}</p>
          }
          <app-crucible-engine-controls [server]="row.name" [enabled]="row.enabled" />

          <!--
            QUEUED ROWS THAT NAME THIS SERVER (crucible docs/PHASE7-LANES.md
            §4.2.1a). Shown always, loudly when the switch is off: a named
            server is an instruction, so those books HOLD rather than moving,
            and the one click that moves them is here beside the switch that
            stopped them.
          -->
          @if (queuedFor(row.name) > 0) {
            <p class="cru-queued" [class.warn]="!row.enabled">
              {{ queuedFor(row.name) }}
              queued {{ queuedFor(row.name) === 1 ? 'book is' : 'books are' }} waiting for
              {{ row.name }}@if (!row.enabled) {, which is now disabled}.
              @if (!row.enabled) {
                They hold until it is enabled again — nothing is re-routed on its own.
              }
              <desktop-button
                variant="ghost"
                size="sm"
                [disabled]="bulkBusy()"
                (click)="releaseQueuedFrom(row.name)"
              >Change them to Any</desktop-button>
            </p>
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

          <!--
            WHERE COORDINATION WITH THIS ENGINE GOT TO (PHASE14 §4a). One
            sentence, composed in crucible-words.ts, which is the only file
            in the app that turns a job type into "the narration engine". A
            A server_busy held by a LEASE is drawn as a WAIT with the holder's
            own words, never as a failure: a lease means another app on that
            machine is mid-run, which is the system working.
          -->
          @if (coordination()[row.name]; as c) {
            <div class="cru-module" [class.bad]="c.phase === 'refused'">
              <p class="cru-meta"><strong>{{ words(c) }}</strong></p>
              @if (c.phase === 'preparing') {
                @if (c.progress.line) { <p class="cru-meta mono">{{ c.progress.line }}</p> }
                @if (c.progress.state === 'failed') {
                  <p class="cru-meta">
                    Everything that finished is still on that machine. BookForge picks up where
                    it stopped the next time it reaches this engine.
                  </p>
                }
                @if (c.progress.state === 'running' && c.progress.taskId) {
                  <desktop-button
                    variant="ghost"
                    size="sm"
                    (click)="cancelSetUp(row.name, c.progress.taskId)"
                  >Stop</desktop-button>
                }
              }
            </div>
          }
          @if (rowSetupError()[row.name]; as err) {
            <p class="cru-refusal">{{ err }}</p>
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
          <span>the top-ranked engine</span>
        </label>
        <label class="cru-radio">
          <input type="radio" name="cru-waitfor" [checked]="waitFor() === 'any'" (change)="setWaitFor('any')" />
          <span>Any</span>
        </label>
      </div>
      <p class="cru-sub">
        A book that names an engine waits for that engine, even when another is free — the
        machines are not interchangeable. “Any” is for a night's work: each job takes the first
        engine that will have it, preferring this order. Books already queued are never re-routed.
      </p>

      <!--
        THE LEGACY CHECKBOX IS GONE, and so is the layer behind it.

        "Run renders and text passes with the local engines instead" spawned
        narrator here and ran a text act against the local text server. That
        whole layer is deleted (docs/LEGACY-REMOVAL.md): an audiobook's
        generation step and the four text acts run on a server above, or they
        fail saying which server they could not reach. Nothing takes this
        machine's card by accident, and there is no switch that would make it.
      -->

      <!-- ── Get a Crucible: the three doors ────────────────────────────── -->
      <!--
        THE SAME COMPONENT THE FIRST-RUN WIZARD MOUNTS, and that is the point:
        a wizard offering a "Connect" this page spelled differently would be two
        screens teaching two different things about one registry. Connect to one
        elsewhere · use the one on this machine · install one here.
      -->
      <h4 class="cru-group">Get an engine</h4>
      <app-crucible-doors (changed)="recheck()"></app-crucible-doors>

      <!--
        "ADVANCED MANUAL CONNECTION" IS GONE (PHASE19 §3, §4, 2026-09-19).

        It was a disclosure holding a "crucible://name@host:port/#token" paste
        box and a Name / Address / Access key triple with Test and Add — the
        operator's door, kept on the argument that somebody repairing an entry
        works from an address and a token they already have. Owen removed the
        premise on 2026-09-18: there are no tokens to have. *"we removed
        tokens. this system is supposed to work like ollama, which doesn't
        require a token request/approval to connect. its protection is the
        system firewall."* So the Connect door above — one field, the address —
        is the whole of how an engine elsewhere is reached, and there is
        nothing an "advanced" form could do that it cannot.
      -->
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
    /* The queued-rows count. Quiet while the server is on, loud when it is not:
       the count is information until the switch makes it a blockage. */
    .cru-queued {
      margin: 6px 0 0; font-size: 12px; line-height: 1.45;
      color: var(--text-secondary); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    }
    .cru-queued.warn { color: var(--warning-text, var(--text-primary)); font-weight: 500; }
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
    .cru-legacy {
      display: flex; flex-direction: column; gap: 4px; margin-top: 6px;
      padding: 10px 12px; border: 1px dashed var(--border-subtle, var(--border-default));
      border-radius: 8px;
    }
    .cru-waitfor-label { font-size: 13px; color: var(--text-primary); font-weight: 600; }
    .cru-add { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .cru-input {
      flex: 1; min-width: 120px; padding: 6px 8px; border-radius: 6px;
      border: 1px solid var(--border-default); background: var(--bg-input, var(--surface-1));
      color: var(--text-primary); font-size: 13px;
    }
    .cru-input.wide { flex: 2; min-width: 200px; }
    .cru-module.bad { border-color: var(--error, #d05a5a); }
    .cru-module {
      display: flex; flex-direction: column; gap: 3px; margin-top: 6px;
      padding: 8px 10px; border-radius: 6px;
      border: 1px solid var(--border-subtle, var(--border-default));
      background: var(--bg-elevated, var(--surface-2));
    }
    /* pip's own output: shown, never branched on (crucible ARCHITECTURE.md R4). */
    .cru-meta.mono { font-family: var(--font-mono, monospace); font-size: 11.5px; white-space: pre; overflow-x: auto; }
    code { font-family: var(--font-mono, monospace); background: var(--bg-elevated, var(--surface-2)); padding: 0 4px; border-radius: 3px; }
  `],
})
export class CrucibleServersPanelComponent {
  private readonly electron = inject(ElectronService);

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

  /**
   * WHERE COORDINATION STANDS, PER SERVER (crucible PHASE14 §4a).
   *
   * Read once on arrival and kept level by the push, because coordination
   * starts at APP START — before this panel exists — and a screen that only
   * listened would draw nothing about a run that finished while it was closed.
   * A server absent from the map is one nothing has asked yet, and the row
   * draws no coordination line at all: "idle" as a printed state would be the
   * panel announcing the absence of news.
   */
  readonly coordination = signal<CrucibleCoordinationMap>({});
  /** A cancel that refused. Its own line, because it is about the STOP. */
  readonly rowSetupError = signal<Record<string, string>>({});

  private readonly dragging = signal<string | null>(null);
  readonly dragName = this.dragging.asReadonly();

  constructor() {
    void this.reload();
    void this.reloadWaitForCounts();
    void this.reloadCoordination();
    // Every coordination state change, filed under the server it names — so a
    // row draws its own engine's news and nobody else's.
    const stop = this.electron.crucible.onCoordination((state) => {
      this.coordination.update((all) => ({ ...all, [state.server]: state }));
    });
    inject(DestroyRef).onDestroy(stop);
  }

  // ── The list ───────────────────────────────────────────────────────────

  /**
   * Ask again. Nothing on this page is on a timer: a server that has just been
   * started, or a Crucible just installed on this computer, appears when
   * somebody asks rather than at some unpredictable moment of its own.
   */
  async recheck(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    const res = await this.electron.crucible.servers();
    if (!res.success || !res.data) {
      // Never an empty list on failure: an empty list means "no servers", and
      // "we could not read the registry" is a different sentence with a fix.
      this.loadError.set(res.error ?? 'The list of engines could not be read, and nothing said why.');
      return;
    }
    this.loadError.set(null);
    this.view.set(res.data);
  }

  /** One row's URL, whatever machine it is on. */
  urlOf(name: string): string | null {
    return this.view()?.servers.find((row) => row.name === name)?.url ?? null;
  }

  maskOf(name: string): string {
    return this.view()?.servers.find((row) => row.name === name)?.tokenMasked ?? '';
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

  /*
   * `copyCode` IS DELETED (PHASE19 §3, 2026-09-19), with the button that
   * called it. It put a "crucible://name@host:port/#token" line on the
   * clipboard; there are no tokens to put anywhere now, and an app that
   * offered one would be teaching a door that no longer exists. Main's
   * `crucible:copy-connect-code` channel is left where it is: `connect-code.ts`
   * is the CLI's too, and deleting a main-process door is not this phase's.
   */

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
    // The whole point of the count: it appears the moment a switch goes off.
    await this.reloadWaitForCounts();
  }

  // ── Queued books that name a server (crucible §4.2.1a) ─────────────────
  //
  // "12 rows are waiting for this PC, which is now disabled." They are TOLD,
  // never moved — a named server is an instruction, and re-routing twenty
  // books onto slower hardware without being asked is the failure the whole
  // section exists to prevent. The bulk button is the one click that moves
  // them, and it is a person pressing it.

  readonly waitForCounts = signal<Record<string, number>>({});
  readonly bulkBusy = signal(false);

  private async reloadWaitForCounts(): Promise<void> {
    const res = await this.electron.queueRouting.counts();
    // No counts is a real answer (an empty queue) and so is a failure; neither
    // is worth an error banner on a settings row about servers, and the rows
    // themselves say why they are holding.
    this.waitForCounts.set(res.success && res.data ? res.data.counts : {});
  }

  /** How many queued books name this server. Zero draws nothing. */
  queuedFor(name: string): number {
    return this.waitForCounts()[name] ?? 0;
  }

  /** Move every queued book that names this server onto `any`. */
  async releaseQueuedFrom(name: string): Promise<void> {
    this.bulkBusy.set(true);
    try {
      const res = await this.electron.queueRouting.bulk(name, 'any');
      if (!res.success) {
        this.setRowError(name, res.error ?? 'Those rows could not be changed, and nothing said why.');
        return;
      }
      await this.reloadWaitForCounts();
    } finally {
      this.bulkBusy.set(false);
    }
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

  /*
   * ── THE MANUAL ADD IS DELETED (PHASE19 §3, §4, 2026-09-19) ───────────
   *
   * `testAddress`, `add`, `onPaste` and `readPairing` went with the
   * "Advanced manual connection" disclosure they served — the paste box for a
   * `crucible://` line and the Name / Address / Access key triple. There are
   * no tokens to paste any more (Owen, 2026-09-18), so connecting to an engine
   * elsewhere is its address and nothing else, through the Connect door in
   * `app-crucible-doors` above. Nothing else in this panel called them.
   */

  // ── The operator door: Open, and what coordination is doing ───────────

  /**
   * Open that server's own page (PHASE13 §5.3).
   *
   * A window with no preload, in its own session, pinned to that server's
   * origin. The token is read in MAIN from the registry; nothing about it
   * crosses this seam, and no external browser gets the `#token=` fragment into
   * its history.
   */
  /** The row's one sentence about coordination. Every word of it is in one file. */
  words(state: CrucibleCoordinationState): string {
    return coordinationWords(state);
  }

  /**
   * The states main already holds, read once on arrival.
   *
   * There is nothing to press here and no run to start: coordination happens
   * when BookForge CONNECTS to an engine (app start, a server added, a server
   * switched back on), and this panel is a reader of it.
   */
  private async reloadCoordination(): Promise<void> {
    const res = await this.electron.crucible.coordination();
    if (!res.success || !res.data) {
      // Never an empty map on failure: empty means "nothing has been asked
      // yet", which is a different thing from "we could not ask main".
      this.loadError.set(res.error ?? 'What each engine is preparing could not be read, and nothing said why.');
      return;
    }
    this.coordination.set(res.data);
  }

  /** Stop a module task that is running on this engine. */
  async cancelSetUp(name: string, taskId: string): Promise<void> {
    const res = await this.electron.crucible.cancelSetUp(name, taskId);
    if (!res.success) {
      this.rowSetupError.update((all) => ({
        ...all,
        [name]: res.error ?? `Stopping the work on "${name}" refused and said nothing about why.`,
      }));
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
