/**
 * queue-view.board — the queue arranged as a board: who is running where, and what waits.
 */
import { computed } from '@angular/core';
import { CPU_LANE_SLOTS, JOB_RESOURCE, LANES, computeLanes, laneOf, laneOfRun, slotOfLane, type JobResource, type Lane } from '@owen/foundry-core/shared/queue-board';
import type { Job } from '@owen/foundry-core/shared/types';
import { QueueEtaService } from './queue-eta.service';
import { BoardSection, SlotView, BookGroup, OFF_LANE, LANE_HINT, LEAVING_HINT, UPSTREAM_HINT } from './queue-view.model';
import type { QueueViewService } from './queue-view.service';

/**
 * The chip's one line: what is running, and how many are waiting behind it.
 *
 * "3 QUEUED" IS STILL A WAIT AND NOT A PARALLELISM, but it is no longer a
 * wait behind ONE job — the board runs several at once (two CPU, and one per
 * machine on the GPU side), so the count of other live runs is said out loud
 * rather than left for somebody to discover by opening the panel. The lead run
 * names itself; the rest are a number, because three book titles in a chip is
 * three ellipses.
 */
export function headline(this: QueueViewService) {
  return computed(() => {
  const active = this.leading();
  const alsoRunning = this.queue.runningJobs().length - 1;
  const waiting = this.queue.queued().length;
  const held = this.queue.held().length;
  if (active) {
    const name = this.label(active);
    /*
     * THE ESTIMATE RIDES IN THE CHIP, next to the name, and it is the one
     * number this line carries. Owen asked for the ETA in the queue and the
     * chip is the only part of the queue that is on screen without being
     * clicked — an estimate a person has to open a panel to see would answer
     * "is it actually working" only for somebody who already went looking.
     *
     * It is not the count and never becomes one: the count and the bar are
     * what the panel is for, and a fraction here would be the furniture the
     * chip's own note (queue-bar.component.ts) argues against. Absent for most
     * of a job's life, by design — see QueueEtaService's honesty rules — so
     * this list is built the same way the one below it is, out of the parts
     * that have something to say.
     */
    const left = this.eta.forJob(active);
    const behind = [
      alsoRunning > 0 ? `${alsoRunning} more running` : null,
      waiting > 0 ? `${waiting} queued` : null,
      held > 0 ? `${held} held` : null,
    ].filter((part) => part !== null);
    const tail = behind.length > 0 ? behind.join(', ') : null;
    const parts = [name, left, tail].filter((part) => part !== null);
    return parts.join(' · ');
  }
  /*
   * A HELD BATCH IS THE HEADLINE WHEN NOTHING IS RUNNING, and it outranks the
   * finished count deliberately: the chip is the queue's whole face most of
   * the time, and one reading "3 finished" over three jobs that are sitting
   * there waiting to be started is the one state where the summary would
   * actively mislead — it says the work is done when none of it has begun.
   */
  if (held > 0) return `${held} waiting for Start`;
  const failed = this.queue.failed().length;
  if (failed > 0) return `${failed} failed`;
  const done = this.queue.finished().length;
  /*
   * AND AN EMPTY QUEUE SAYS ITS OWN NAME. The shelf never had to answer this
   * — it was not drawn at all with no jobs — and the chip is always there, so
   * "0 finished" would be the corner of the window reporting a number about
   * nothing. BookForge's own empty chip says "Queue", for the same reason.
   */
  if (done === 0) return 'Queue';
  return `${done} finished`;
});
}

/**
 * THE BOARD AS THE PANEL DRAWS IT — the lanes, in order, each with its rows.
 *
 * ── The one rule that decides whether there are heads at all ────────────────
 *
 * While every row in the queue wants the same resource, this returns ONE
 * section with no head and the whole list in it, and the panel is exactly the
 * list the shelf always was. That is the common case by a mile: a batch of
 * readings, or one export. Heads appear the moment the board holds work of two
 * kinds — and then BOTH lanes draw even if one of them is empty, because at
 * that point the interesting fact is as often what is free as what is busy.
 * An empty lane is a head and one grey line, which is cheap; two heads over
 * one lonely job would not be.
 *
 * ── The two sections that are not lanes ─────────────────────────────────────
 *
 * An install holds every slot and a mint holds none (shared/queue-board.ts),
 * so neither has an occupancy to report and neither draws when it has no rows.
 * They are named for what they DO to the board rather than by what they are,
 * because that is the fact a person reading a queue needs: one of them is why
 * nothing else is moving, and the other is why something is moving that no
 * lane accounts for.
 *
 * ORDER WITHIN A LANE IS QUEUE ORDER, untouched. Grouping is not sorting: the
 * panel shows the order somebody added things in, Start releases in that
 * order, and the pump takes them in that order.
 */
export function board(this: QueueViewService) {
  return computed<BoardSection[]>(() => {
  const rows = this.queue.jobs();
  const grouped = new Map<JobResource, Job[]>();
  for (const job of rows) {
    const resource = JOB_RESOURCE[job.kind];
    const held = grouped.get(resource);
    if (held === undefined) grouped.set(resource, [job]);
    else held.push(job);
  }
  if (grouped.size <= 1) return [{ key: 'all', head: null, slots: '', hint: '', rows }];

  const sections: BoardSection[] = [];
  for (const lane of LANES) {
    sections.push({
      key: lane,
      head: lane === 'gpu' ? 'GPU' : 'CPU',
      slots: this.occupancy(lane),
      hint: LANE_HINT[lane],
      rows: grouped.get(lane) ?? [],
    });
  }
  for (const resource of OFF_LANE) {
    const held = grouped.get(resource);
    if (held === undefined || held.length === 0) continue;
    sections.push({
      key: resource,
      head: resource === 'exclusive' ? 'The whole machine' : 'Beside the lanes',
      slots: '',
      hint: LANE_HINT[resource],
      rows: held,
    });
  }
  return sections;
});
}

/**
 * THE BENCH — one card per SLOT, occupied or free, always all of them.
 *
 * ── Why the page counts slots where the panel groups rows ───────────────────
 *
 * They are two readings of one table and the difference is room. The dropdown
 * is a list with lane rules across it, which is what fits in a panel you have
 * clicked open for a glance. The page has the width to draw the thing the
 * board actually IS: the slots, and what is standing in each. That is
 * BookForge's own centre of gravity on its queue page — *"the THREE SLOTS,
 * always all three, occupied or free… allocating one GPU slot and two CPU
 * slots is the entire job of the scheduler, and until this redesign no surface
 * drew them"* — and the sentence is true here for exactly the same reason,
 * with our own number in place of their three: BookForge rations one machine,
 * and this app rations however many somebody has registered.
 *
 * ── ONE CARD PER MACHINE, WHICH IS WHAT A GPU SLOT NOW IS (Package G) ──────
 *
 * It drew "GPU · slot 1 of 1" and a small "on <slot>" tag beside whatever was
 * running, which was the board saying *one card* while the scheduler was being
 * asked to believe in several. A compute slot IS a lane now
 * (`computeLanes`, shared/queue-board.ts), so each one gets its own card with
 * its own name at the top, and the count in the band head counts machines and
 * CPU slots together, because that is genuinely how many things may be going
 * at once. The friend with one Crucible sees one GPU card, headed with the name
 * they gave that server — including when the server is on this very desk, which
 * since Wave 66 is the only way this machine's card appears here at all.
 *
 * A CARD SAYS WHAT IS WAITING FOR IT, in dispatch's own sentence. A row parked
 * on a busy Mac already carries the reason it is parked (`Job.message`,
 * electron/crucible-dispatch.ts renders every one of them), and the card is
 * where that sentence answers the question a person is actually asking, which
 * is why the OTHER thing is not moving.
 *
 * ── AND IT STILL INVENTS NOTHING ABOUT WHICH SLOT IS WHICH ─────────────────
 *
 * The GPU cards are no longer a guess: `Job.ranOn` is where the run actually
 * went, and `laneOfRun` maps it onto the board as it stands. The CPU lane IS
 * still a guess and is still drawn as one — the scheduler does not say which of
 * the two CPU slots a job landed in, so its running rows are dealt in QUEUE
 * ORDER and "CPU · slot 2 of 2" means "the second of the two CPU runs", which
 * is the fact main really does guarantee.
 *
 * A RUN ON A MACHINE THAT HAS LEFT THE LIST KEEPS ITS CARD, at the end,
 * marked. Switching a server off never moves a running job (docs/SLOTS.md §3 —
 * *"its atomic"*), so the run is still going on a machine the list no longer
 * mentions; dropping the card would be the bench reporting a slot free while
 * somebody's book is being translated on it.
 */
export function slots(this: QueueViewService) {
  return computed<SlotView[]>(() => {
  const lanes = this.lanes();
  const running = this.queue.runningJobs();
  const onCards = running.filter((job) => laneOf(job.kind) === 'gpu');
  const out: SlotView[] = [];
  for (const lane of lanes) {
    const here = onCards.filter(
      (job) => laneOfRun(job.ranOn, lanes, job.ranVia)?.name === lane.name,
    );
    /*
     * ── AN EMPTY UPSTREAM LANE IS NOT DRAWN (Wave 62) ────────────────────
     *
     * Every Crucible slot has two lanes now: its card, and the `[cloud]` one an
     * upstream-routed act takes (`computeLanes`, shared/queue-board.ts). The
     * SCHEDULER needs both to exist always — a lane list that appeared and
     * vanished as somebody edited a remote server's routes would be a board
     * whose size changes under a fifteen-second cache. The BENCH does not: two
     * permanently empty cards per server, on the machine of somebody who has
     * routed nothing upstream and never will, is the bench answering a question
     * nobody asked and taking the space of the one they did.
     *
     * So the cloud lane is drawn WHEN SOMETHING IS IN IT, and then it is drawn
     * whole — both of its places, so "1 of 2" says what the second one is for.
     * The card lane is always drawn, exactly as it always was.
     */
    if (lane.route === 'upstream' && here.length === 0) continue;
    for (let index = 0; index < lane.capacity; index += 1) {
      out.push({
        key: `slot:${lane.name}:${index}`,
        lane: 'gpu',
        /*
         * THE MACHINE'S NAME, AND THE WORD FOR WHICH OF ITS LANES THIS IS.
         * `slotOfLane` is why the head does not read "mac-studio:cloud": that
         * string is an identity the scheduler and the walk compare by, not a
         * sentence anybody should have to parse off a card.
         */
        title: lane.route === 'upstream'
          ? `${slotOfLane(lane)} · sent on · ${index + 1} of ${lane.capacity}`
          : lane.capacity === 1 ? lane.name : `${lane.name} · ${index + 1} of ${lane.capacity}`,
        kind: lane.kind,
        hint: lane.route === 'upstream' ? UPSTREAM_HINT : LANE_HINT['gpu'],
        occupant: here[index] ?? null,
        waiting: index === 0 ? this.waitingFor(lane.name) : '',
        leaving: false,
      });
    }
  }
  /*
   * THE MACHINES THAT ARE ON THEIR WAY OUT — a run whose `ranOn` matches no
   * lane. `laneOfRun` answers null for exactly that, and for an absent `ranOn`
   * on a board where no lane is this machine's card (`localLane`); the second
   * cannot be a GPU row, because since Wave 66 a GPU row is always placed on a
   * named slot or refused.
   */
  for (const job of onCards) {
    if (laneOfRun(job.ranOn, lanes, job.ranVia) !== null) continue;
    out.push({
      key: `leaving:${job.id}`,
      lane: 'gpu',
      title: job.ranOn ?? '',
      kind: null,
      hint: LEAVING_HINT,
      occupant: job,
      waiting: '',
      leaving: true,
    });
  }
  const cpu = running.filter((job) => laneOf(job.kind) === 'cpu');
  for (let index = 0; index < CPU_LANE_SLOTS; index += 1) {
    out.push({
      key: `cpu:${index}`,
      lane: 'cpu',
      title: `CPU · slot ${index + 1} of ${CPU_LANE_SLOTS}`,
      kind: null,
      hint: LANE_HINT['cpu'],
      occupant: cpu[index] ?? null,
      waiting: '',
      leaving: false,
    });
  }
  return out;
});
}

/**
 * WHY SOMETHING IS WAITING FOR THIS MACHINE, in the words dispatch put on the
 * row — or the empty string, which is every machine nothing is queued for.
 *
 * THE FIRST SUCH ROW AND NOT ALL OF THEM. Four books queued for the Mac while
 * it narrates are four copies of one sentence about the Mac; the card is
 * answering "why is nothing starting over there", and the answer is the same
 * whichever row is asked. The rows themselves are in *Up next*, where the
 * question is about the books.
 *
 * ONLY A `queued` ROW, because only a queued row has been TURNED AWAY. A held
 * row naming this machine is waiting for a person to press Start, which is not
 * a fact about the machine and would read on the card as though it were.
 */
export function waitingFor(this: QueueViewService, name: string): string {
  for (const job of this.queue.jobs()) {
    if (job.state !== 'queued' || job.waitFor !== name) continue;
    const said = (job.message ?? '').trim();
    if (said.length > 0) return said;
  }
  return '';
}

/** How many of the counted slots have somebody in them — the bench's heading. */
export function busySlots(this: QueueViewService) {
  return computed(() => this.slots().filter((slot) => slot.occupant !== null).length);
}

/**
 * WHAT IS WAITING, GROUPED BY THE BOOK IT IS ABOUT — the page's *Up next*.
 *
 * BookForge groups its waiting steps by book and draws each book's chain, and
 * the grouping is worth reproducing for the reason it works there: a person
 * assembling a batch adds work a BOOK at a time, so a flat list of eleven rows
 * is eleven readings of the same four titles, and the question being asked of
 * the screen ("what have I actually lined up?") is answered by the titles.
 *
 * THERE IS NO PER-BOOK START AND THIS DOES NOT DRAW ONE. BookForge's group
 * header carries *"▶ Start this book"* because its engine can release one
 * plan; Foundry's Start releases THE WHOLE HELD BATCH (`queue.start()`, and
 * main's `start` is the same one gesture), so a button under a title promising
 * to start that title would start four other books as well. The one Start
 * there is stays where it has always been — one control, with the count of
 * what it commits — and this grouping is presentation only. Naming the gap
 * rather than papering it with a button that lies.
 *
 * Groups come out in first-appearance order, and rows within a group in queue
 * order, because that is the order Start will release them in.
 */
export function waitingBooks(this: QueueViewService) {
  return computed<BookGroup[]>(() => {
  const groups: BookGroup[] = [];
  const byName = new Map<string, BookGroup>();
  for (const job of this.queue.jobs()) {
    if (job.state !== 'held' && job.state !== 'queued') continue;
    const name = this.label(job);
    let group = byName.get(name);
    if (group === undefined) {
      group = { key: name, title: name, rows: [] };
      byName.set(name, group);
      groups.push(group);
    }
    group.rows.push(job);
  }
  return groups;
});
}

/**
 * "1 of 1 running", or what is free — the right-hand side of a lane head.
 *
 * THE GPU TOTAL IS THE NUMBER OF CARDS THE BENCH DRAWS, which is the number of
 * machines plus whatever upstream work is actually going. ZERO, for a person
 * with no engine registered — the honest number since Wave 66, and the one the
 * empty-board sentence beside it explains; two, for somebody with two servers.
 *
 * IT WAS `lanes().length` AND CANNOT BE ANY MORE (Wave 62). Every Crucible slot
 * carries a second, upstream lane the scheduler always rations by and the bench
 * draws only when something is in it (see `slots`). Counting the lane list here
 * would say "5 slots free" over a bench showing two cards, which is the board
 * being confidently wrong about itself — the one thing docs/QUEUE-BOARD.md asks
 * it never to be. So both numbers come off the same list.
 */
export function occupancy(this: QueueViewService, lane: Lane): string {
  const busy = this.queue.runningJobs().filter((job) => laneOf(job.kind) === lane).length;
  const total = lane === 'gpu'
    ? this.slots().filter((slot) => slot.lane === 'gpu' && !slot.leaving).length
    : CPU_LANE_SLOTS;
  if (busy > 0) return `${busy} of ${total} running`;
  /*
   * ZERO IS NOT "0 slots free", WHICH WOULD BE ARITHMETIC IN PLACE OF A FACT.
   * A GPU side with no lanes is a machine with no engine registered (Wave 66),
   * and the band head is the first place a person meets that; the sentence
   * under the cards says what to do about it.
   */
  if (total === 0) return 'no engine connected';
  return total === 1 ? '1 slot free' : `${total} slots free`;
}
