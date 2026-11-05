import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ANY_SLOT, GPU_DIAL_ANY } from '@owen/foundry-core/shared/slots';
import type { Job } from '@owen/foundry-core/shared/types';

import { NoticeService } from '../../core/notice.service';
import { QueueService } from '../../core/queue.service';
import { QueueViewService, type SlotView } from '../../core/queue-view.service';
import { api, hosted } from '../../core/foundry';

/**
 * ONE BLOCK OF THE SLOT PICKER'S OPTION LIST — see `pickerGroups`.
 *
 * `label: null` is the ungrouped block and is not the same as an empty label: an
 * `<optgroup label="">` draws an indented, headed section with nothing written
 * over it, which is worse than no grouping at all. The `key` exists only so
 * `@for`'s `track` has something stable to hold; the label is what a person
 * reads and one of them is deliberately absent.
 */
interface PickerGroup {
  key: string;
  label: string | null;
  options: string[];
}

/**
 * THE QUEUE PAGE — the whole board, with room to breathe.
 *
 * Owen asked for it in the same breath as the bar (his ruling is quoted in full
 * at the head of `QueueBarComponent`): *"put a button in it for 'more info'
 * thatll take me to a queue page that looks like bookforge's queue page"*. So
 * this is BookForge's queue page's ANATOMY, drawn with Foundry's facts and in
 * Foundry's tokens — its structures reproduced, none of its code imported, and
 * nothing invented that this app's queue does not really know.
 *
 * ── The bands, in BookForge's own order ─────────────────────────────────────
 *
 *   Needs you    — failures, with the engine's own sentence. Not drawn when
 *                  there are none, which is almost always, and therefore worth
 *                  reading when it is.
 *   On the bench — the slots, always all of them, occupied or free: a card per
 *                  MACHINE (one per compute slot, Package G) and then the two
 *                  CPU slots. This is the page's centre of gravity, and the
 *                  reason the page exists at all: rationing those slots is the
 *                  whole job of the scheduler, and the dropdown has room to
 *                  group rows by lane but not to draw the slots themselves.
 *   Up next      — everything waiting, GROUPED BY BOOK, each row saying why it
 *                  is still.
 *   Finished     — today's work as history, in a table, rather than as more rows
 *                  that look live.
 *
 * A band with nothing in it is not drawn, so the page is short when the queue is
 * quiet and long only when there is genuinely that much to say.
 *
 * ── It is a bigger window onto the same facts, and nothing more ─────────────
 *
 * Every signal on this page comes from `QueueViewService`, which is the same
 * service the dropdown reads — BookForge's own lesson, learned the hard way and
 * written into its page's header: before it had one, its two queue surfaces
 * *"spoke different dialects"* and its page showed a step only once it had
 * started. There is one description of this queue and one set of words for it.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * BookForge's page carries covers, ETAs, card temperatures, per-stage bars, a
 * Pause-the-engine control, a Retry, and a per-book Start. Foundry's queue knows
 * none of those things, and a page that drew a slot for an ETA it cannot compute
 * would be furniture that never fills. Two are worth naming rather than merely
 * omitting:
 *
 *   NO RETRY on a failed row. Nothing in main re-runs a settled job; the honest
 *   gesture is to order the work again from the tool that ordered it, and a
 *   button here promising otherwise would be a door onto nothing.
 *
 *   NO PER-BOOK START, though the grouping invites one. `queue.start()` releases
 *   the WHOLE held batch — that is the engine-level semantics Owen fenced off —
 *   so a Start under one title would silently start four other books. The one
 *   Start there is stays in the page head, carrying the count of what it
 *   commits, exactly as it does in the dropdown.
 *
 * ── Hosted, this page cannot be reached ────────────────────────────────────
 *
 * The route itself refuses hosted (`app.routes.ts`), which is the real gate; the
 * `@if` below is the second half of the same rule, kept for the reason the
 * shelf's summons and the shelf's render were both gated: a door with nobody
 * behind it and a room with no door are two halves of one promise, and neither
 * side should have to trust the other to remember it.
 */
@Component({
  selector: 'app-queue-page',
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './queue-page.component.html',
  styleUrl: './queue-page.component.scss',
})
export class QueuePageComponent {
  /** The route already refuses hosted; this is the other half. See the header. */
  protected readonly hosted = hosted;
  private readonly notices = inject(NoticeService);

  /*
   * ── THE LIVE QUEUE'S DIAL (Owen, 2026-09-15) ─────────────────────────────
   *
   * Read from the registry's own view rather than from `view.slots()`, because
   * the dial names a CRUCIBLE SERVER and the slot list is wider than that — it
   * carries a `[cloud]` lane per server and, when there are cloud providers, a
   * slot for each. A dial offering "Anthropic" would be a control that parks
   * every GPU row on a lane no card belongs to.
   *
   * ENABLED ROWS ONLY in the picker, and that is not the same as refusing a
   * disabled one in the file: main deliberately KEEPS a dial naming a server
   * somebody has switched off (see the door in electron/ipc.ts), because
   * switching a server off must not silently re-point the whole queue. So the
   * stored value is added back below if it is not in the list — the select
   * shows what the queue is actually using, which is the state somebody needs
   * to see in order to leave it.
   */
  protected readonly dial = signal(GPU_DIAL_ANY);
  private readonly dialServers = signal<readonly string[]>([]);
  protected readonly dialOptions = computed(() => {
    const names = [GPU_DIAL_ANY, ...this.dialServers()];
    const current = this.dial();
    return names.includes(current) ? names : [...names, current];
  });

  protected readonly queue = inject(QueueService);
  protected readonly view = inject(QueueViewService);

  /**
   * ── THE SLOT PICKER — WHERE, not when ─────────────────────────────────────
   *
   * docs/SLOTS.md §3. A slot is a place a job's compute can go: a registered
   * Crucible server, or a cloud provider somebody configured. It used to include
   * this computer's own GPU and no longer does — Owen, Wave 66: *"one gpu slot in
   * the queue per connected crucible server. including the local crucible, which
   * is indistinguishable from the remote crucible server."*
   *
   * THE LIST IS THE SERVICE'S NOW, and it is the same move this whole page is:
   * the bench draws a card per slot, the picker draws a name per slot, and two
   * reads of `slots:list` would be two answers that can differ for a frame — in
   * one window, side by side. It is still read ONCE, for the reason it always
   * was (a settings fact, changed on another screen); the argument now lives on
   * `QueueViewService.computeSlots` with the rest of the board's vocabulary.
   *
   * ONE ENTRY DRAWS NO PICKER, and so does none: there is nothing to choose
   * between in either case. Owen's sentence for it was *"a friend with no
   * Crucible sees ONE slot, their local GPU, and never meets the picker"* — the
   * slot is a Crucible now rather than a local GPU, and the half about the picker
   * is unchanged. Every `@if (picking(job))` in the template above is that
   * sentence.
   */
  protected readonly slots = this.view.computeSlots;
  protected readonly anySlot = ANY_SLOT;

  /**
   * WHOSE MACHINE A BENCH CARD IS, in two words under the name — or the empty
   * string, which is every CPU card and every machine that has left the list.
   *
   * The kinds are the board's (`ComputeSlotKind`), said in a person's words: a
   * `crucible` slot is a server somebody registered and a `cloud` slot is a
   * provider with a bill attached. There used to be a third, the local slot,
   * which said nothing because its name already said it; it is gone (Wave 66,
   * Owen: *"there should be no local gpu listed in the queue"*), and every GPU
   * card on this bench is now somebody's server.
   *
   * A CPU CARD SAYS NOTHING, and neither does a card that is `leaving` — its
   * hover says the whole story, and a kind beside a name that is no longer
   * offered would read as a claim the list no longer makes.
   */
  protected whose(slot: SlotView): string {
    if (slot.leaving || slot.kind === null) return '';
    return slot.kind === 'cloud' ? 'cloud' : 'crucible';
  }

  /**
   * Is there a picker on this row at all?
   *
   * Three noes, each its own fact: there is nothing to choose between, this row
   * never meets a model (an export, a mint — `waitFor` is absent and always will
   * be), or it has started, and a started job stays where it is.
   */
  protected picking(job: Job): boolean {
    if (this.slots().length < 2) return false;
    if (job.waitFor === undefined) return false;
    return job.state === 'held' || job.state === 'queued';
  }

  /**
   * The names this row may be sent to, in rank order, with `any` first — IN TWO
   * GROUPS, because one of them costs money.
   *
   * ── Why the cloud slots are drawn apart and not merely listed ─────────────
   *
   * docs/SLOTS.md §3: a cloud provider is *"a deliberate per-job choice, never
   * something `any` falls through to"*. Every mechanism that enforces that is in
   * main — the `any` walk steps past them, `New jobs wait for: top` cannot name
   * one — and all of it is invisible here. What is visible is this dropdown, and
   * a provider sitting in the same flat list as somebody's Mac would read as one
   * more machine. The `<optgroup>` is where the difference is SAID: "Cloud —
   * costs credits", once, above the names it applies to.
   *
   * A STORED NAME THAT IS NO LONGER A SLOT IS KEPT IN THE LIST, at the end of
   * the machines, and that is deliberate: the row IS waiting for it, a select
   * whose value is not among its options would silently show the first option
   * instead, and the person would read the picker as saying something about
   * their job that is not true. It goes with the machines rather than with the
   * cloud because a slot that is gone has no kind any more, and guessing one
   * would be the picker inventing a bill. The Servers card is where such a row
   * gets rescued in a batch; this keeps the one-row story honest meanwhile.
   */
  protected pickerGroups(job: Job): PickerGroup[] {
    const slots = this.slots();
    const names = slots.map((slot) => slot.name);
    const stored = job.waitFor;
    const stale = stored !== undefined && stored !== ANY_SLOT && !names.includes(stored)
      ? [stored]
      : [];
    const machines = slots.filter((slot) => slot.kind !== 'cloud').map((slot) => slot.name);
    const cloud = slots.filter((slot) => slot.kind === 'cloud').map((slot) => slot.name);
    const groups: PickerGroup[] = [
      { key: 'machines', label: null, options: [ANY_SLOT, ...machines, ...stale] },
    ];
    if (cloud.length > 0) {
      groups.push({ key: 'cloud', label: 'Cloud — costs credits', options: cloud });
    }
    return groups;
  }

  protected optionLabel(option: string): string {
    if (option === ANY_SLOT) return 'Any — first one free';
    return this.slots().some((slot) => slot.name === option) ? option : `${option} (not available)`;
  }

  /**
   * AND THE REFUSAL IS SPOKEN, because the only way to reach one is a race a
   * person cannot see.
   *
   * The picker is not drawn on a running row, so a refusal here means the pump
   * admitted this row between the frame that was read and the click that was
   * sent (electron/job-queue.ts `setWaitFor` argues it). Dropping that left the
   * select showing a machine the row is not going to, with nothing to say so.
   * Main's sentence already names what took it and what to do instead, so it is
   * printed as it arrives rather than summarised.
   */
  constructor() {
    /*
     * HOSTED, THE REGISTRY IS THE HOST'S and so is the dial — this window does
     * not add, remove or re-point somebody else's servers (docs/SLOTS.md §3).
     * Reading nothing leaves `dialOptions()` at one entry, which is what hides
     * the control, so there is no second hosted branch in the template.
     */
    if (!api || hosted()) return;
    void api.crucible.settings().then((view) => {
      this.dialServers.set(view.servers.filter((row) => row.enabled).map((row) => row.name));
      this.dial.set(view.queueGpuDial);
    });
  }

  /** "Any machine", or the server's own name. */
  protected dialLabel(option: string): string {
    if (option === GPU_DIAL_ANY) return 'Any machine';
    return this.dialServers().includes(option) ? option : `${option} (not available)`;
  }

  /**
   * Answered with what main STORED, not with what was sent — the clamp tidies
   * the name, and a select redrawn from its own argument would show a dial the
   * queue is not using.
   */
  protected setDial(dial: string): void {
    if (!api || dial === this.dial()) return;
    void api.crucible.setQueueGpuDial(dial).then((stored) => { this.dial.set(stored); });
  }

  protected sendTo(job: Job, waitFor: string): void {
    if (waitFor === (job.waitFor ?? ANY_SLOT)) return;
    void this.queue.setWaitFor(job.id, waitFor).catch((err: unknown) => {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    });
  }

  /** How many rows are waiting, across every book — the band's own count. */
  protected waitingCount(): number {
    return this.queue.held().length + this.queue.queued().length;
  }

  /**
   * WHAT KIND OF WORK THIS IS, in the words the rest of the app uses.
   *
   * The row above it already says which BOOK, so this line answers the other
   * half of "what is this" — and it is the column BookForge calls "Act". No
   * filenames and no job kinds spelled the way the wire spells them: a person
   * ordered a reading, or an export, and that is what they should read back.
   *
   * THE THREE TEXT PASSES ARE THREE KINDS ON THE WIRE NOW, and this column tells
   * them apart. It used to say they were one — *"a simplify is a rewrite prompt on
   * the translate command … the row's own title already does"* — which was true of
   * the wire and was exactly what Owen overturned (2026-09-05): *"it isnt a
   * translate job. naming it translate is deceptive."* The title still carries the
   * mode a rewrite was asked in, because a kind cannot; what the kind carries is
   * which act it is, which is what this column exists to say.
   */
  protected kindLine(job: Job): string {
    switch (job.kind) {
      case 'read': return 'Reading the pages';
      case 'translate': return 'Translating';
      case 'simplify': return 'Simplifying';
      /*
       * "Cleaning the text for narration" and not "Cleaning", because the word
       * alone says nothing about what is being done to somebody's book — the
       * argument the analysis row below makes about itself, one act along. This
       * column is where a person scanning a queue of expensive rows finds out what
       * each of them is FOR, and what this one is for is a narrator.
       */
      case 'clean': return 'Cleaning the text for narration';
      /*
       * WHAT THE TRIAGE IS FOR, on the cleanup's own argument one line up: the
       * word alone ("Triage") says nothing about somebody's book, and what this
       * row does is find the paragraphs the cleanup behind it will work on.
       */
      case 'clean-triage': return 'Finding the text that needs cleaning';
      /*
       * THE ANALYSIS'S RANKING, on the triage's argument: what this row does is
       * score every sentence of the book against the checklist, so the check
       * behind it knows which passages to read.
       */
      case 'analysis-rank': return 'Scoring the sentences against the categories';
      case 'epub': return 'Casting the book';
      case 'pdf': return 'Reprinting';
      case 'txt': return 'Plain text';
      case 'mint': return 'Assembling the photographs';
      /*
       * "Reading against the categories" and not "Analysing", because the word
       * alone says nothing about what is being done to somebody's book — and this
       * column is the one place a person scanning a queue of expensive rows finds
       * out what each of them is FOR. It is the book being read a second time,
       * against a checklist (docs/ANALYSIS.md §1), which is exactly the sentence.
       */
      case 'analysis': return 'Reading against the categories';
    }
  }

  /**
   * WHAT BECAME OF IT — the finished table's outcome column.
   *
   * A job names what it DID, not what it wrote: a reading's product is the bank
   * and the book follows from it, so "Read · the book follows" is the true
   * sentence where a filename would be this app showing somebody a name out of
   * its own bookkeeping. The same words the dropdown's done rows use, from the
   * same `made()`, for the reason both surfaces share one service at all.
   */
  protected outcome(job: Job): string {
    if (job.state === 'failed') return this.view.failureLine(job.error);
    if (job.state === 'cancelled') return 'Cancelled';
    if (job.kind === 'read') return 'Read · the book follows';
    if (job.kind === 'translate') return 'Translated · the book follows';
    if (job.kind === 'simplify') return 'Simplified · the book follows';
    if (job.kind === 'clean') return 'Cleaned · the book follows';
    if (job.kind === 'clean-triage') return 'Checked · the cleanup follows';
    if (job.kind === 'analysis-rank') return 'Ranked · the check follows';
    return this.view.made(job);
  }

  /**
   * A book's waiting rows, counted and told apart by what they are waiting on.
   *
   * The group header is the one place the shape of the batch is visible — "3
   * steps, all waiting for Start" is what somebody assembling a batch is
   * checking — and the two waits are never added together, because they are the
   * two different facts this queue is built around.
   */
  protected groupLine(rows: readonly Job[]): string {
    const held = rows.filter((job) => job.state === 'held').length;
    const queued = rows.length - held;
    const parts = [
      held > 0 ? `${held} waiting for Start` : null,
      queued > 0 ? `${queued} queued` : null,
    ].filter((part) => part !== null);
    return parts.join(' · ');
  }

  /**
   * One waiting row's state, for the off-lane sections that have no chain.
   *
   * THE ESTIMATE IS ON THIS LINE TOO, and it is not a special case: these
   * sections hold the install and the mint, and a mint counts photographs being
   * rectified in this very window (`noteMintPage`) — which is a count like any
   * other and the one job in the app whose progress is nobody's process to ask.
   * An install has no fraction at all (it counts megabytes in a field of its
   * own) so it simply never has one to draw, which is the same silence every
   * other row gets before its count has moved.
   */
  protected stateLine(job: Job): string {
    if (job.state === 'held') return 'Waiting for Start';
    if (job.state === 'running') {
      const left = this.view.timeLeft(job);
      const line = this.view.stepLine(job);
      return left === '' ? line : `${line} · ${left}`;
    }
    if (job.state === 'queued') return job.message ?? 'Queued';
    return this.outcome(job);
  }
}
