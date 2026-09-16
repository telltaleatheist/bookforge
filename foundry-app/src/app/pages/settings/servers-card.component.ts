/**
 * servers-card — the Crucible servers this machine knows about, in the order it
 * will try them.
 *
 * ── What this card is, in Owen's words ─────────────────────────────────────
 *
 * *"foundry should work if they have no idea what theyre doing and they just
 * want to convert PDFs to EPUB. but if they do know what theyre doing and they
 * want access to speed, they can use crucible."* It was the opt-in half of the
 * app, and a person who never opened it still had one slot — their own GPU.
 *
 * THAT IS NO LONGER TRUE AND THE CARD SAYS SO. Owen, Wave 66: *"everything goes
 * through a crucible server now, including local… there should be no local gpu
 * listed in the queue"*, and 2026-09-15: *"if theres no connected crucible server
 * then tiles should be disabled."* A person who never opens this card has NO GPU
 * slot, and the empty state below tells them what cannot run rather than
 * promising it will run here.
 *
 * ── THE ORDER IS THE SETTING, which is why a drag is a save ────────────────
 *
 * There is no rank field; the array position IS the rank (`CrucibleServerView`,
 * shared/slots.ts). A row whose `waitFor` is "any" walks this list top to bottom
 * and takes the first server that will start the job. Dragging a row therefore
 * changes what "any" means, and it does NOT change any row already in the queue
 * — docs/SLOTS.md §3: *"queued rows do NOT move when servers are re-ranked."*
 *
 * ── THE TOKEN FIELD IS WRITE-ONLY AND THAT IS NOT A UI FLOURISH ────────────
 *
 * This card has never been told a token and cannot be: `CrucibleServerView`
 * carries a boolean where the stored entry carries a secret, and the save sends
 * `token: null` for every row nobody retyped, which main reads as "keep what is
 * stored". So the box shows "set" or "not set", and typing in it is the only way
 * a token ever moves — one direction, once.
 *
 * ── SWITCHING ONE OFF TELLS YOU WHAT IT WAS HOLDING ────────────────────────
 *
 * Owen's rule is that the rows waiting for a server that has just been disabled
 * are SURFACED, never moved: told, never moved silently. So the save asks which
 * rows named it and offers one press that reassigns them to "any" — a gesture
 * with a person behind it, like everything else that changes a row. Running rows
 * are not in that list and are not touched; switching a server off in a settings
 * card is not a cancel.
 *
 * ── THE THREE DOORS ARE A CHILD, AND THEY ARE THE WIZARD'S THREE ───────────
 *
 * Owen's *"offer to install Crucible, or to point at one elsewhere"* is three
 * doors — connect, use the one here, install one — and they appear both on this
 * card and in the first-run wizard. They live in `app-crucible-doors` so the two
 * screens cannot drift apart; this card keeps the LIST, which is a different
 * job: editing, ranking and switching off servers that already exist.
 *
 * So the button that used to read "Add the Crucible on this machine" is gone
 * from this card and is door 2 of that child. Two buttons doing one thing on one
 * screen is how somebody learns that one of them must do something else.
 *
 * ── HOSTED, THE LIST IS SOMEBODY ELSE'S ────────────────────────────────────
 *
 * The vendored app takes its slot list from the host (docs/SLOTS.md §3), because
 * one machine's GPU needs one owner. The card draws the slots read-only and says
 * where they came from; main refuses the write as well, because a card that only
 * HIDES a control has decorated a door rather than locked it.
 */
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { CrucibleDoorsComponent } from '../../components/crucible-doors/crucible-doors.component';
import { NoticeService } from '../../core/notice.service';
import { cardWords, coordinationWords } from '../../core/crucible-words';
import type { CrucibleCoordinationMap } from '@shared/coordinate-wire';
import { ANY_SLOT } from '@shared/slots';
import type {
  ComputeSlot,
  CrucibleProbe,
  CrucibleServerEdit,
  CrucibleServerView,
  NewJobsWaitFor,
} from '@shared/slots';
import type { Job } from '@shared/types';
import { api } from '../../core/foundry';
import { QueueService } from '../../core/queue.service';

/**
 * One row as this card edits it: the view, plus the token somebody may have
 * typed and a local id so `@for`'s `track` survives a reorder.
 *
 * THE LOCAL ID IS NOT THE NAME. Tracking by name would destroy and rebuild the
 * input somebody is typing in the moment they change the first character of it,
 * which loses the caret and, on a slow frame, the keystroke.
 */
interface EditableServer extends CrucibleServerView {
  key: number;
  /** A NEW token, or null. Never the stored one — see the module note. */
  token: string | null;
}

@Component({
  selector: 'app-servers-card',
  imports: [FormsModule, CrucibleDoorsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="card">
      <div class="card-head">
        <span class="card-title">Servers</span>
        @if (saved()) { <span class="badge">saved</span> }
      </div>

      @if (hosted()) {
        <p class="detail">
          The slots below belong to the application Foundry is running inside. Change them there.
        </p>
        @for (slot of slots(); track slot.name) {
          <p class="small mono">{{ slot.name }}@if (slot.url) { — {{ slot.url }} }</p>
        } @empty {
          <p class="small">The host has offered no slots, so every job runs the way it always did.</p>
        }
      } @else {
        <!--
          FIRST MENTION IS "GPU engine (Crucible)", AND EVERY MENTION AFTER IT
          IS "engine" — the copy rule of 2026-09-14, kept here and in
          core/crucible-words.ts so that Foundry and BookForge say the same
          words about the same machine. The card's TITLE stays "Servers",
          because that is what somebody is looking for when they know the word
          already.
        -->
        <p class="detail">
          A GPU engine (Crucible) is a separate program that serves models over the network.
          These are the engines this machine can send translation, simplification, analysis,
          narration cleanup and page reading to, and jobs are tried in this order. Every one of
          them is a GPU slot in the queue — including an engine running on this computer, which
          is a server like any other. Without an engine there is no GPU slot at all, and that
          work has nowhere to run; exports and compiles are unaffected.
        </p>

        @for (row of rows(); track row.key) {
          <div class="server" draggable="true"
               (dragstart)="dragFrom.set($index)"
               (dragover)="$event.preventDefault()"
               (drop)="dropOn($index)">
            <div class="server-top">
              <span class="grip" title="Drag to change the order">⠿</span>
              <input class="name" type="text" placeholder="Mac Studio"
                     [ngModel]="row.name" [name]="'name' + row.key"
                     (ngModelChange)="edit(row.key, { name: $event })">
              <label class="toggle">
                <input type="checkbox" [ngModel]="row.enabled" [name]="'on' + row.key"
                       (ngModelChange)="edit(row.key, { enabled: $event })">
                <span>On</span>
              </label>
              <button class="ghost" (click)="drop(row.key)">Remove</button>
            </div>
            <input class="url" type="text" placeholder="http://192.168.1.20:7100"
                   [ngModel]="row.url" [name]="'url' + row.key"
                   (ngModelChange)="edit(row.key, { url: $event })">
            <div class="server-top">
              <input class="url" type="password"
                     [placeholder]="row.tokenSet ? 'Token: set — type to replace' : 'Token: not set'"
                     [ngModel]="row.token ?? ''" [name]="'tok' + row.key"
                     (ngModelChange)="edit(row.key, { token: $event })">
              <button class="ghost" [disabled]="testing() === row.name || !row.tokenSet"
                      (click)="test(row.name)">
                {{ testing() === row.name ? 'Testing…' : 'Test connection' }}
              </button>
              <!--
                THE SERVER'S OWN CONSOLE. Administering an engine belongs to the
                engine (Owen, 2026-09-14), so this is where a person goes to
                install a job type, pull weights or read what is resident.
                Disabled until a token is stored, because the page is opened
                with one; a saved row is the only kind that has one.
              -->
              <button class="ghost" [disabled]="!row.tokenSet || row.token !== null"
                      (click)="openUi(row.name)">Open engine console</button>
            </div>
            @if (probes()[row.name]; as probe) {
              @if (probe.outcome === 'ok') {
                <p class="small ok">
                  {{ probe.serverName }} {{ probe.version }} — {{ probe.backend }}, {{ cardWords(probe) }}
                </p>
                <!--
                  Reached through an orchestrator (crucible
                  PHASE17-ORCHESTRATOR.md §6), which is a SUCCESS and is the
                  shape of a Windows machine with WSL: the tray answers the
                  address in this row and the engine that did the answering
                  above is behind it. "Open engine console" still opens the
                  address in the row — see openCrucibleUi, which says why.
                -->
                @if (probe.via; as via) {
                  <p class="small">{{ via }}</p>
                }
              } @else {
                <p class="small warn">{{ probe.message }}</p>
              }
            }
            <!--
              AND WHAT FOUNDRY HAS ALREADY SAID TO IT, without anybody asking.
              crucible docs/PHASE14-ENVPACKS.md §4a: connecting to an engine is
              the request, so there is no button here and never was one — the
              row says what happened. A server nothing has asked about yet has
              no state and draws no line, because "idle" written out would be a
              card announcing the absence of news.
            -->
            @if (coordinationOf(row.name); as said) {
              <p class="small">{{ said }}</p>
            }
            <!--
              THE SENTENCE THAT WAS HERE SAID *"This is the engine on this
              machine, so it replaces the local GPU slot rather than sitting
              beside it"*, and Owen's ruling made every clause of it false:
              *"one gpu slot in the queue per connected crucible server.
              including the local crucible, which is indistinguishable from the
              remote crucible server."* There is no local GPU slot for a loopback
              engine to replace, and nothing about this row is special — so it is
              drawn like every other row, and the card says nothing rather than
              explaining a difference that no longer exists.
            -->
          </div>
        } @empty {
          <!--
            THE EMPTY STATE IS NOW A REAL ONE. It read *"No servers. Everything
            runs on this computer."* — true while this machine's own GPU was a
            slot, and false since Owen's ruling deleted it. No engine means no GPU
            slot, so it says what cannot run rather than promising it will run
            here.
          -->
          <p class="small">
            No engines. Translation, simplification, cleanup, analysis and page reading have
            nowhere to run until one is added; exports and compiles are unaffected.
          </p>
        }

        <div class="actions">
          <button class="ghost" (click)="add()">Add a row by hand</button>
          <button class="primary" [disabled]="saving()" (click)="save()">
            {{ saving() ? 'Saving…' : 'Save' }}
          </button>
        </div>
        @if (problem(); as why) { <p class="warn">{{ why }}</p> }

        <!--
          THE THREE DOORS. The same child the first-run wizard mounts, so the two
          screens offer one set of choices — see the module note. The WSL distro
          field lives inside door 2, beside the button that needs it.
        -->
        <!--
          AND THE FOURTH DOOR, THE WAY OUT, drawn only here. The child takes an
          input for it and the first-run wizard does not pass one: offering to
          remove Crucible to somebody who has not installed it yet is a screen
          teaching the wrong thing. crucible docs/INSTALL-UNINSTALL.md section
          6.1 decides the rest — the door appears only for a server main can
          PROVE is this machine's, and never for a registry row.
        -->
        <app-crucible-doors [canUninstall]="true" (changed)="load()" />

        <!--
          WHAT A NEW ROW STARTS AS. It is resolved to a slot NAME at the press,
          never carried as the word "top" — see AppSettings.newJobsWaitFor.
        -->
        <label class="field">
          <span class="label">New jobs wait for</span>
          <select name="newJobs" [ngModel]="newJobsWaitFor()"
                  (ngModelChange)="setNewJobsWaitFor($event)">
            <option value="top">The top-ranked slot</option>
            <option value="any">Any — whichever is free first</option>
          </select>
        </label>

        @if (slots().length > 1) {
          <p class="small">
            Slots, in order: {{ slotNames() }}. Every queued job can be sent to one of them, or
            to "any", from its own row on the queue page.
          </p>
        }

        @if (orphans().length > 0) {
          <!--
            TOLD, NEVER MOVED SILENTLY. These rows named a server that is now off
            or gone; nothing has happened to them and nothing will until this is
            pressed.
          -->
          <p class="warn">
            {{ orphans().length }} waiting
            {{ orphans().length === 1 ? 'job is' : 'jobs are' }} still set to a server that is
            switched off or no longer here.
          </p>
          <div class="actions">
            <button class="ghost" (click)="freeOrphans()">Send them to any slot</button>
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
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-head { display: flex; align-items: center; gap: 8px; }
    .card-title { font-family: var(--font-display); font-weight: 600; font-size: 13px; flex: 1; }
    .badge {
      font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--ok); background: var(--ok-soft); border-radius: 999px; padding: 2px 8px;
    }
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .small { font-size: 11px; color: var(--text-tertiary); margin: 0; }
    .mono { font-family: var(--font-mono); word-break: break-all; }
    .warn { color: var(--warn); font-size: 12px; margin: 0; }
    .ok { color: var(--ok); }

    .server {
      display: flex; flex-direction: column; gap: 6px;
      border: 1px solid var(--border-subtle); border-radius: var(--radius-sm);
      padding: 8px;
    }
    .server-top { display: flex; align-items: center; gap: 6px; }
    .grip { cursor: grab; color: var(--text-tertiary); font-size: 13px; }
    .name { flex: 1; min-width: 0; }
    .url { flex: 1; min-width: 0; }
    .toggle { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; }

    .field { display: flex; flex-direction: column; gap: 6px; }
    .label {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.08em; color: var(--text-tertiary);
    }

    .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .primary, .ghost {
      display: inline-flex; align-items: center; justify-content: center;
      height: 26px; padding: 0 12px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500; line-height: 1;
      cursor: pointer;
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
export class ServersCardComponent {
  private readonly notices = inject(NoticeService);

  private readonly queue = inject(QueueService);

  /** The words file's, exposed because a template cannot call a bare import. */
  protected readonly cardWords = cardWords;

  protected readonly rows = signal<EditableServer[]>([]);
  protected readonly slots = signal<ComputeSlot[]>([]);
  protected readonly newJobsWaitFor = signal<NewJobsWaitFor>('top');
  protected readonly hosted = signal(false);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly problem = signal<string | null>(null);
  protected readonly testing = signal<string | null>(null);
  protected readonly probes = signal<Record<string, CrucibleProbe>>({});
  protected readonly orphans = signal<Job[]>([]);
  protected readonly dragFrom = signal<number | null>(null);
  /**
   * What Foundry has said to each engine, by the name the REGISTRY stored.
   *
   * Keyed by stored name and not by the name in the input box, which is why the
   * line disappears for as long as somebody is halfway through retyping one: a
   * sentence about "Mac Stud" would be a sentence about a server nobody has
   * ever spoken to.
   */
  protected readonly coordination = signal<CrucibleCoordinationMap>({});

  protected readonly slotNames = computed(() => this.slots().map((slot) => slot.name).join(', '));

  private nextKey = 1;

  constructor() {
    if (!api) return;
    void this.load();
    /*
     * THE MAP ON LOAD, AND EVERY CHANGE AFTER IT — both, because neither is the
     * whole picture on its own. Coordination begins at APP START, long before
     * this card is built, so a card that only listened would draw nothing about
     * a server that was already `stocked` before Settings was opened; and a
     * card that only read once would freeze mid-download.
     */
    void this.loadCoordination();
    const stop = api.crucible.onCoordination((state) => {
      this.coordination.update((all) => ({ ...all, [state.server]: state }));
    });
    inject(DestroyRef).onDestroy(stop);
  }

  /**
   * The whole card, re-read from main.
   *
   * PROTECTED rather than private because the three doors below call it: any of
   * them can add a server, and the list, the slot preview and the orphan check
   * are all downstream of that. They emit rather than hand a list over — main
   * answered with the registry as stored, and this is the one reader of it.
   */
  protected async load(): Promise<void> {
    if (!api) return;
    const view = await api.crucible.settings();
    this.rows.set(view.servers.map((server) => ({ ...server, key: this.nextKey++, token: null })));
    this.slots.set(view.slots);
    this.newJobsWaitFor.set(view.newJobsWaitFor);
    this.hosted.set(view.hosted);
    void this.refreshOrphans();
  }

  private async loadCoordination(): Promise<void> {
    if (!api) return;
    this.coordination.set(await api.crucible.coordination());
  }

  /**
   * The one sentence this card draws about coordination, or null.
   *
   * EVERY WORD OF IT IS `core/crucible-words.ts`'s. Main sends facts — which
   * phase, what is missing, who holds the card — and the copy is composed in
   * one file so that this card, the wizard and BookForge's own row cannot come
   * to describe one machine three ways (crucible ARCHITECTURE.md R1).
   */
  protected coordinationOf(name: string): string | null {
    const state = this.coordination()[name];
    return state === undefined ? null : coordinationWords(state);
  }

  protected edit(key: number, patch: Partial<EditableServer>): void {
    this.saved.set(false);
    this.rows.update((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  protected add(): void {
    this.saved.set(false);
    this.rows.update((rows) => [
      ...rows,
      { key: this.nextKey++, name: '', url: '', enabled: true, tokenSet: false, loopback: false, token: null },
    ]);
  }

  protected drop(key: number): void {
    this.saved.set(false);
    this.rows.update((rows) => rows.filter((row) => row.key !== key));
  }

  /**
   * The drag's other half. A move within one array rather than a swap, because a
   * swap would make dragging a row from the bottom to the top exchange two
   * machines' ranks instead of putting one first.
   */
  protected dropOn(to: number): void {
    const from = this.dragFrom();
    this.dragFrom.set(null);
    if (from === null || from === to) return;
    this.saved.set(false);
    this.rows.update((rows) => {
      const next = [...rows];
      const [moved] = next.splice(from, 1);
      if (moved !== undefined) next.splice(to, 0, moved);
      return next;
    });
  }

  /**
   * Save the whole list, in order — see the module note on why this is one door.
   *
   * ANSWERED WITH WHAT WAS STORED, and the rows are rebuilt from that answer
   * rather than from what was typed: main drops an entry it cannot store and
   * normalises a URL that carried `/v1`, and a card that went on showing the
   * typed text would be showing something the next job will not use.
   */
  protected async save(): Promise<void> {
    if (!api) return;
    this.saving.set(true);
    this.problem.set(null);
    try {
      const edits: CrucibleServerEdit[] = this.rows().map((row) => ({
        name: row.name,
        url: row.url,
        enabled: row.enabled,
        token: row.token,
      }));
      const view = await api.crucible.save(edits);
      this.rows.set(view.servers.map((server) => ({ ...server, key: this.nextKey++, token: null })));
      this.slots.set(view.slots);
      this.saved.set(true);
      /*
       * AND THEN THE ROWS THAT WERE NAMING A SERVER THAT IS NO LONGER A SLOT.
       * Asked AFTER the save, because the question is about the list as it now
       * stands — a row naming a server that is still enabled is not an orphan,
       * and asking before the save would have used yesterday's list.
       */
      await this.refreshOrphans();
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  /**
   * Open a server's own operator page.
   *
   * BY NAME, and only for a row whose token is STORED rather than typed: main
   * reads the credential from the registry, so a row still being edited has
   * nothing there to read. The failure is drawn beside the row exactly as a
   * failed test is — it is the same kind of news, about the same server.
   */
  protected async openUi(name: string): Promise<void> {
    if (api === null) return;
    try {
      await api.crucible.open(name);
    } catch (err) {
      this.problem.set(err instanceof Error ? err.message : String(err));
    }
  }

  protected async test(name: string): Promise<void> {
    if (!api || name.trim().length === 0) return;
    this.testing.set(name);
    try {
      const probe = await api.crucible.test(name);
      this.probes.update((all) => ({ ...all, [name]: probe }));
    } finally {
      this.testing.set(null);
    }
  }

  protected async setNewJobsWaitFor(choice: NewJobsWaitFor): Promise<void> {
    if (!api) return;
    this.newJobsWaitFor.set(await api.crucible.setNewJobsWaitFor(choice));
  }

  /**
   * Every waiting row whose slot is not in the list any more.
   *
   * DERIVED FROM THE QUEUE THIS WINDOW ALREADY MIRRORS rather than asked of
   * main per name: the queue service holds every row and the slot list is right
   * here, so this is a filter over two things the card already has. `api.slots
   * .rowsWaitingFor` exists for the caller that has neither and is not that
   * caller.
   */
  private async refreshOrphans(): Promise<void> {
    const live = new Set(this.slots().map((slot) => slot.name));
    this.orphans.set(
      [...this.queue.held(), ...this.queue.queued()].filter((job) => (
        job.waitFor !== undefined
        && job.waitFor !== ANY_SLOT
        && !live.has(job.waitFor)
      )),
    );
  }

  /**
   * One press, one row at a time, each through the same door the picker uses.
   *
   * ── A ROW THAT CANNOT BE MOVED MUST NOT STOP THE ONES THAT CAN ───────────
   *
   * `setWaitFor` refuses a row a GPU has already taken (`QueueRoutingRefusal`,
   * electron/job-queue.ts), and in a LOOP that refusal is likely rather than
   * exotic: this press exists because a server was switched off, which is
   * exactly when the other slots are picking work up. An unguarded `await` would
   * abort on the first such row and silently leave every row after it pinned to
   * a machine that is gone — the press half-done, reporting success.
   *
   * So each row is caught on its own and the ones that would not move are
   * COUNTED and named. Owen's rule for a server going away is *"told, never
   * moved silently"*, and a row that is mid-run on another machine is a row the
   * person should be told about rather than one this press should keep trying.
   */
  protected async freeOrphans(): Promise<void> {
    if (!api) return;
    const stuck: string[] = [];
    for (const job of this.orphans()) {
      try {
        await api.queue.setWaitFor(job.id, ANY_SLOT);
      } catch (err) {
        stuck.push(err instanceof Error ? err.message : String(err));
      }
    }
    if (stuck.length > 0) this.notices.notice.set(stuck.join(' '));
    await this.refreshOrphans();
  }
}
