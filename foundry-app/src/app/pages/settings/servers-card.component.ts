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
import { CrucibleInstallOutcomeComponent } from '../../components/crucible-doors/install-outcome.component';
import { NoticeService } from '../../core/notice.service';
import { cardWords, coordinationWords } from '../../core/crucible-words';
import type { CrucibleCoordinationMap } from '@owen/foundry-core/shared/coordinate-wire';
import { ANY_SLOT } from '@owen/foundry-core/shared/slots';
import type {
  ComputeSlot,
  CrucibleProbe,
  CrucibleServerEdit,
  CrucibleServerView,
  NewJobsWaitFor,
} from '@owen/foundry-core/shared/slots';
import type { Job } from '@owen/foundry-core/shared/types';
import { api } from '../../core/foundry';
import { QueueService } from '../../core/queue.service';
import { ServerRepairComponent } from '../../components/crucible-doors/server-repair.component';

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
  imports: [FormsModule, CrucibleDoorsComponent, CrucibleInstallOutcomeComponent, ServerRepairComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './servers-card.component.html',
  styleUrl: './servers-card.component.scss',
})
export class ServersCardComponent {
  /*
   * THE TWO APPROVAL HANDLERS WENT WITH THE LIST THEY FED (2026-09-17).
   * `incomingPairingRequests` and `decidePairing` are still doors on the main
   * process and still doors on the engine — an operator with
   * `[auth] open_pairing = false` needs them — but nothing in Foundry calls
   * them any more, and a handler kept "in case" is the shim this house does not
   * keep. If the approval face returns it returns with its template.
   */
  private readonly notices = inject(NoticeService);

  private readonly queue = inject(QueueService);

  /** The words file's, exposed because a template cannot call a bare import. */
  protected readonly cardWords = cardWords;

  protected readonly rows = signal<EditableServer[]>([]);
  protected readonly reinstallNeeded = signal(false);
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

  /*
   * `add()` COMPOSED THE BLANK ROW and went with its button (Owen: *"add row by
   * hand seem superfluous"*). Every engine now arrives through the address
   * door, which is the only path that also pairs; a row this method made had a
   * name nobody had typed, no address and no token, so it could not be tested,
   * could not be opened, and was not yet a server.
   */

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
