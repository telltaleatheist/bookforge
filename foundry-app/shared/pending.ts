/**
 * shared/pending — THE PROMISES THE TREE DRAWS, derived from the queue and never
 * stored.
 *
 * ── The ruling ──────────────────────────────────────────────────────────────
 *
 * Owen, 2026-09-07:
 *
 *   *"if i queue cleanup, i want a grayed out step to appear where the item will
 *   be when it finishes. i should be able to run jobs against the grayed out row.
 *   everything under it that i run will also be grayed out. if that item is
 *   removed from the queue, anything under it also disappears. so when i run ai
 *   cleanup on an 'applied changes' row, it adds it to the queue and adds a
 *   grayed out row as a step. i click the grayed out row and hit the export epub
 *   tile. the export epub tile is grayed out until ai cleanup finishes. i can
 *   click the grayed out exported epub and click narrate. then send narration and
 *   assembly to the queue. if i then remove the cleanup step from the queue, or it
 *   otherwise gets lost along the way, everything under that grayed out chain also
 *   gets removed."*
 *
 * ── NOTHING PENDING IS EVER WRITTEN TO `project.json` ───────────────────────
 *
 * That is the whole architecture of this feature and it is not a convenience. A
 * ledger step is a RECORD OF SOMETHING THAT HAPPENED — `parseLedger` refuses a
 * step whose parent is missing, `RETENTION_OF` says what its payload cost, the
 * delete confirm names what erasing it destroys, and the sweep unlinks the file it
 * points at. A promise has none of those: no payload, no cost, nothing to erase.
 * Storing one would mean every reader of a ledger learning to tell a fact from an
 * intention, and the day one of them forgot, a book's history would claim a
 * translation that never ran.
 *
 * `HostInvokeContext.cleaned` already made this argument for the host's side of
 * the seam — *"it is DERIVED and never stored"*, because a stored flag has to be
 * maintained by every act that appends a step and will be forgotten by exactly one
 * of them. This module is the same ruling applied to Foundry's OWN promises: the
 * queue rows are the record, the tree reads them, and when a row leaves the queue
 * its promise leaves the tree by construction rather than by anybody remembering
 * to tidy up.
 *
 * ── SO THE CASCADE HAS TWO HALVES AND ONLY ONE OF THEM IS CODE ──────────────
 *
 * *"if that item is removed from the queue, anything under it also disappears."*
 *
 * THE DRAWING HALF IS FREE. A pending node is drawn only where its parent is
 * either a real step or another live pending node (`admitPending` below), so a row
 * that leaves the queue takes its whole chain off the screen in the same repaint —
 * no walk, no bookkeeping, no chance of an orphan lingering.
 *
 * THE SCHEDULING HALF IS NOT, and it lives in electron/job-queue.ts: a row waiting
 * behind a parent that failed or was removed has to be cancelled by name, because
 * it is real work with a real request behind it and nothing about repainting a
 * tree stops an engine from spawning.
 *
 * ── PURE, AND OVER RECORDS RATHER THAN OVER SERVICES ────────────────────────
 *
 * `shared/stages.ts`'s rule, one module along: everything here takes a job row and
 * a ledger and reads nothing else. It is asked from BOTH sides — the tree derives
 * the nodes it draws, and main composes the same synthetic steps to answer a host's
 * `cleaned` over a chain that has not landed — and a rule spelled on both sides of
 * an IPC boundary is a rule that drifts.
 */
import { RETENTION_OF, labelFor } from './ledger';
import type { Job, JobState, LedgerStep, ProjectLedger, StepAction } from './types';

/**
 * WHAT A PLAN NEEDS TO KNOW ABOUT A PROMISE IT IS BEING ASKED TO PLAN UNDER.
 *
 * ── Why the plan is handed a record instead of an id ────────────────────────
 *
 * A plan asked "make this from step X" where X does not exist has three questions
 * and only the first is answered by the id.
 *
 * WHICH STEP WILL THIS BE FILED UNDER — `from`, and it goes straight into
 * `recordsForTextPass` as the parent, which is what makes the promised pass branch
 * rather than collide with a sibling.
 *
 * WHAT IS THE NEAREST THING THAT ACTUALLY EXISTS — `landed`, and it is what every
 * DETERMINISTIC field is composed at: the book's name in `final/`, the reading's
 * bank, the project key. Those are the same answers at every row of one chain, so
 * composing them at the last real row is composing them correctly, and it is the
 * only row a materialise could be made at in any case.
 *
 * WHAT HAPPENS IN BETWEEN — `through`, the promised actions from `landed` down to
 * `from`. One plan reads it and it earns the field on its own: a REWRITE has to
 * name the language it happens in, and a promised translation on the way down
 * changes that language without recording it anywhere this app can read (a pending
 * step carries no params — see `pendingStepOf`). So `planSimplification` refuses by
 * name in exactly that shape rather than naming a records file after the wrong
 * language.
 *
 * COMPOSED IN MAIN, AT THE DOOR, out of the ledger and the live queue — the two
 * things a renderer holds only a mirror of. See `deferralFor`.
 */
export interface Deferral {
  /** The step this work will be made FROM. No ledger holds it yet. */
  from: string;
  /**
   * The nearest ancestor of `from` that IS a step of the ledger, or null when the
   * whole chain up to the root is promises (which cannot happen today: a promise's
   * parent is either a real step or another promise, and the first promise in any
   * chain was ordered from a real one).
   */
  landed: LedgerStep | null;
  /** The promised actions between `landed` and `from`, oldest first, `from` last. */
  through: readonly StepAction[];
}

/**
 * WHICH QUEUE STATES ARE A PROMISE, and which are over.
 *
 * ── `held` IS IN, AND THE DESIGN SAID THREE STATES ──────────────────────────
 *
 * The brief named `queued | running | failed`, which is right for a HOSTED window:
 * BookForge's queue has no hold, so every row it pushes back is already one of
 * those three. Standalone Foundry holds every text pass at the enqueue —
 * *"nothing expensive starts by being enqueued"* (`JobState`) — so a cleanup
 * ordered in this app is `held` from the press until somebody finds the shelf and
 * presses Start. Drawing nothing for it would mean Owen's own gesture ("i queue
 * cleanup, i want a grayed out step to appear") produced no grayed row at all in
 * the window the feature was described in. A held row is ordered work waiting on a
 * PERSON rather than on the machine, which is a distinction the shelf draws and
 * the tree has no room for: either way the step is coming.
 *
 * `failed` IS IN FOR THE OPPOSITE REASON — the node stays so the person can see
 * WHY the chain under it went. Its children are cancelled by the scheduler's
 * cascade the moment the failure lands, so what is left on screen is one dashed
 * card wearing the engine's own sentence rather than a subtree pretending to wait.
 *
 * `done` IS OUT BECAUSE THE REAL STEP IS THERE. A landed text pass is a row of the
 * ledger and drawing the promise beside it would be two cards for one act.
 * `cancelled` is out because nothing is coming.
 *
 * A TABLE OVER `JobState` rather than a list of literals, on this codebase's
 * standing rule for per-member decisions: a seventh state is a compile error here
 * instead of a silent answer.
 */
export const PENDING_IN: Readonly<Record<JobState, boolean>> = {
  held: true,
  queued: true,
  running: true,
  failed: true,
  done: false,
  cancelled: false,
};

/**
 * THE LEDGER ACTION A QUEUE ROW WILL LAND AS, for the rows that land one.
 *
 * Three members and no more, deliberately. A reading, an analysis, a mint and an
 * environment install all have surfaces of their own — the shelf's progress, the
 * hits panel, the light table — and a promise drawn for them in the tree would be
 * a second place saying the same news. What is here is exactly the family whose
 * landing puts a card in the history: the three text passes (`TEXT_PASS_ACTIONS`,
 * shared/ledger.ts).
 *
 * AN EXPORT IS NOT IN THIS TABLE and is not missing from it: an export lands a
 * FILE in the tray rather than a step in the ledger (`GenerateRequest.export`), so
 * its promise is an export node and its id is `exportNodeId(...)` rather than a
 * step id. `Job.mints` is what tells the two apart on the wire, and
 * `exportOfNodeId` (shared/host-ops.ts) is the test.
 */
const LANDS_AS: Readonly<Partial<Record<Job['kind'], StepAction>>> = {
  translate: 'translate',
  simplify: 'simplify',
  clean: 'clean',
};

/**
 * IS THIS ROW STILL PROMISING SOMETHING — a live row that will put a node in the
 * tree.
 *
 * Both halves are asked because both can be false independently: a `done` clean
 * has landed (nothing to promise) and a queued Generate never promised anything
 * (no `mints`). Main is the side that decides the second half — it is the only one
 * that can see `export: true` on a request — and it says so once, on the row.
 */
export function promises(job: Job): boolean {
  return job.mints !== undefined && job.mints.length > 0 && PENDING_IN[job.state];
}

/**
 * ONE PENDING ROW AS THE STEP IT IS GOING TO BE — the synthetic `LedgerStep` every
 * predicate in shared/stages.ts is asked about.
 *
 * ── Why a real `LedgerStep` and not a shape of its own ──────────────────────
 *
 * Because the whole point of standing on a pending row is that the acts offered
 * there are the acts that will be offered when it lands. `canTranslateFrom`,
 * `canSimplifyFrom`, `canCleanFrom`, `canExportFrom` and `hostActPositionFrom` all
 * take a `LedgerStep | null` and read exactly two fields off it — the action and
 * the parent — so handing them the step this row is going to be makes them answer
 * the question they were written to answer, with no second implementation and no
 * `if (pending)` in any of them. A parallel shape would have meant five predicates
 * learning about promises, and the day one of them was missed a tile would light
 * on a row it cannot act from.
 *
 * ── AND `LedgerStep` GAINS NO `pending` FIELD ───────────────────────────────
 *
 * It was the obvious move and it is refused: `parseLedger` refuses a step carrying
 * a field a step does not have (`STEP_FIELDS`), so an optional marker here would
 * be a field the parser has to admit — which is a field somebody can write into a
 * `project.json`, which is a promise stored on a disk. Whether a standing is
 * pending is carried BESIDE the step (`Standing` below), which is the only shape
 * that keeps the ledger type honest.
 *
 * ── The fields, and the one that cannot be honest ───────────────────────────
 *
 * `id` is `Job.mints` — the step id the plan minted at the press and put on the
 * request, so the node the tree draws and the row the landing writes are the same
 * id from the moment the button was pressed (`TranslateRequest.stepId` argues this
 * at length; this is the second thing that id buys).
 *
 * `parent` is `Job.parentStep`, the position at the press, which is exactly where
 * the landing will file it.
 *
 * `retention` is the action's, out of the one table (`RETENTION_OF`) — so a
 * promise does not have an opinion about cost that the landed row would contradict.
 *
 * `params` IS ABSENT, and that is a refusal rather than an omission. A translation
 * is described by the language it went into and a simplify by its mode; neither is
 * on the row (`Job.title` says "Simplify — plain terms", which is a SENTENCE and
 * this codebase does not read facts back out of sentences). So the card says
 * "Translated" and "Simplified" without the parenthesis it will wear once it
 * lands, which is the honest amount for a promise to claim.
 *
 * `payload` IS THE EMPTY STRING, which is the one field a promise genuinely cannot
 * have: the file does not exist. It is not `Job.outputPath` — a payload is
 * project-relative and a reader that resolved this one would open a path that is
 * not there — and it is not omitted, because the field is required and every
 * reader of it in this app treats the empty string as "nothing to open".
 *
 * NULL FOR A ROW THAT PROMISES NO STEP: an export row (whose promise is a file),
 * a settled row, a Generate. The caller draws nothing for those, or draws an
 * export node instead.
 */
export function pendingStepOf(job: Job): LedgerStep | null {
  const action = LANDS_AS[job.kind];
  if (action === undefined || !promises(job)) return null;
  return {
    id: job.mints!,
    parent: job.parentStep ?? null,
    action,
    payload: '',
    retention: RETENTION_OF[action],
    createdAt: job.createdAt,
    label: labelFor(action),
  };
}

/**
 * WHERE THE BOOK IS STANDING, and whether that place exists yet.
 *
 * ── Why the two travel together ─────────────────────────────────────────────
 *
 * Every surface that acts on a position needs both halves and needs them to agree.
 * The TILES need the step, because that is what the possibility predicates read.
 * The DIALOGS need to know it is pending, because a plan made under a step that
 * does not exist cannot materialise a book and has to be composed as a DEFERRED
 * plan instead (`WorkspacePlan.deferred`). The TREE needs the row, because
 * chaining the new work behind the pending one means naming the row it waits on
 * (`Job.after`).
 *
 * Two separate signals would let the pair disagree for a frame — a pending step
 * with no row, a row with no step — and the way that presents is a dialog planning
 * against a landed step that was replaced a moment ago by a promise. One record,
 * or nothing.
 *
 * `pending` IS NULL FOR AN ORDINARY STANDING, which is nearly every standing there
 * has ever been: a real row of the ledger, planned against directly, exactly as
 * before this feature existed.
 */
export interface Standing {
  /** The step, real or synthetic. See `pendingStepOf` for what a synthetic one is. */
  step: LedgerStep;
  /** The queue row that is going to land it, or null when the step is already real. */
  pending: Job | null;
}

/**
 * EVERY PROMISE THIS PROJECT'S QUEUE ROWS MAKE, in queue order, with the orphans
 * dropped.
 *
 * ── The admission rule IS the cascade ───────────────────────────────────────
 *
 * *"if that item is removed from the queue, anything under it also disappears."*
 *
 * A node is admitted when its parent is a step of this ledger OR a node that has
 * already been admitted. So the walk starts from the ledger and grows outward, and
 * a row whose parent is neither — because the parent row was removed, or cancelled,
 * or belongs to a project this window is not looking at — is never admitted, and
 * neither is anything hanging off it. There is no cascade to run and nothing to
 * remember: the chain is exactly as long as the queue says it is, at every repaint.
 *
 * ── REPEATED UNTIL IT SETTLES, rather than in one pass ──────────────────────
 *
 * The queue is in press order and a chain is built in press order too, so one
 * forward pass would be right in practice for every case this feature was designed
 * from. It is not right in principle — a host's rows arrive in whatever order the
 * host pushes them, and `setHostQueueRows` validates nothing — and the failure is
 * the silent kind: a narration's parent export sitting one row later in the array
 * would take the whole chain off the screen. The loop costs a handful of passes
 * over a handful of rows and cannot be wrong about the order.
 *
 * THE ROWS ARE ALREADY THIS PROJECT'S. Filtering by project means comparing a
 * job's output path against a directory, which is a fact about a filesystem and
 * belongs to the caller that holds both (`inProject`, the tree; `projectDirOf`,
 * main). This module maps rows to nodes and reads nothing about a disk.
 */
export function admitPending(ledger: ProjectLedger | null, rows: readonly Job[]): Job[] {
  /*
   * ── WHAT THE LEDGER ALREADY HOLDS, WHICH IS NOT A PROMISE ANY MORE ─────────
   *
   * `PENDING_IN` says the intent — *"`done` IS OUT BECAUSE THE REAL STEP IS
   * THERE. A landed text pass is a row of the ledger and drawing the promise
   * beside it would be two cards for one act"* — and the row's STATE was the
   * proxy for it. The proxy has a gap: a step lands at the settle, and the row
   * that made it does not become `done` in this window's mirror until the
   * scheduler says so and, hosted, until the host's next push carries it. In
   * that window the step is in the ledger AND the row still says `running`, so
   * the tree drew both and Owen watched one cleanup listed twice, both saying
   * running (2026-09-08, Julius Streicher).
   *
   * So the question is asked of the LEDGER, which is the thing that actually
   * knows. `landed` is the ids as they were when this walk began; `known` grows
   * with admitted promises because that is a different question — who may be a
   * PARENT — and a promise still counts as one of those.
   */
  const landed = new Set((ledger?.steps ?? []).map((step) => step.id));
  const known = new Set(landed);
  const candidates = rows.filter(promises);
  const admitted: Job[] = [];
  const seen = new Set<string>();
  for (;;) {
    let grew = false;
    for (const job of candidates) {
      if (seen.has(job.id)) continue;
      if (landed.has(job.mints!)) {
        // The act it promised has happened. Never drawn, and never a reason to
        // walk again — its own children resolve against the real step's id,
        // which is in `known` already because the ledger put it there.
        seen.add(job.id);
        continue;
      }
      const parent = job.parentStep ?? null;
      if (parent === null || !known.has(parent)) continue;
      seen.add(job.id);
      admitted.push(job);
      known.add(job.mints!);
      grew = true;
    }
    if (!grew) break;
  }
  return admitted;
}

/**
 * THE LEDGER WITH THE PROMISES IN IT — the one composition every walk reads.
 *
 * ── Why a composed ledger rather than a parameter on every walk ─────────────
 *
 * `cleanupInEffect`, `textPassInEffect`, `translationInEffect` and `editsInEffect`
 * are all one walk (`nearestUpward` → `ancestry` → `stepOf`), and that walk
 * resolves a parent by looking it up in `ledger.steps`. Give the walk a ledger
 * whose steps include the promises and every one of those questions answers THROUGH
 * a pending chain with no signature changed and no call site taught anything — a
 * cleanup that has not landed is still the newest thing said about these
 * paragraphs, and a surface that said otherwise would offer to clean a book twice.
 *
 * The alternative was an `extra` parameter threaded through five exported functions
 * and their callers, which is five chances to pass it in four places and forget the
 * fifth — and the fifth is the one that renders the uncleaned words.
 *
 * A COPY, NEVER A MUTATION. The ledger this is given is the one this window is
 * mirroring from main, held by `LedgerService` and read by everything on screen;
 * appending to its array would put promises into the record every other surface
 * reads as history.
 *
 * THE ORDER IS LEDGER-FIRST, which matters for exactly one reader: `chronological`
 * would draw the promises last. Nothing composed here is ever handed to that
 * function — the tree builds its own rows — and the order is stated so that the
 * next reader does not have to work out whether it was considered.
 */
export function withPending(
  ledger: ProjectLedger,
  pending: readonly LedgerStep[],
): ProjectLedger {
  if (pending.length === 0) return ledger;
  return { ...ledger, steps: [...ledger.steps, ...pending] };
}

/**
 * THE ROW THAT IS GOING TO LAND THIS STEP, or null.
 *
 * The join every other half of this feature is built out of: the plan mints a step
 * id, the row carries it as `mints`, and everybody who has an id and wants the work
 * behind it — the scheduler composing `after`, the host seam composing
 * `pendingRow`, the door refusing an unknown `from` — asks exactly this.
 *
 * LIVE ROWS ONLY (`promises`). A row that has landed is not going to land anything
 * again, and answering with it would chain new work behind a job that is already
 * over — which reads, in the queue, as work that never starts.
 */
export function rowMinting(rows: readonly Job[], stepId: string): Job | null {
  return rows.find((job) => promises(job) && job.mints === stepId) ?? null;
}

/**
 * WHAT A DEFERRED PLAN IS ABOUT, worked out from the ledger and the live queue — or
 * null when the id names nothing at all.
 *
 * ── The three answers, in order ─────────────────────────────────────────────
 *
 * A LEDGER STEP is not a deferral and answers null. The caller plans against it
 * directly, exactly as it always has; a caller that could not tell the difference
 * would defer work that could run now.
 *
 * A LIVE PROMISE answers a `Deferral`: the id, the nearest landed ancestor, and the
 * promised actions in between. The walk is over the COMPOSED ledger
 * (`withPending`), so it does not have to know anything about queues — a promised
 * cleanup under a promised translation under a save is three hops of the same
 * `parent` pointer.
 *
 * NOTHING AT ALL answers null as well, and the CALLER says the sentence. That is
 * deliberate: what a person should be told is not "no deferral" but *"…is not a
 * step of this book and no queued work will make it"*, which is a refusal about a
 * press and belongs where the press arrived. Two nulls with one meaning would have
 * been a tri-state crossing a function boundary to say what the caller can see for
 * itself by asking `ledger.steps` first.
 */
export function deferralFor(
  ledger: ProjectLedger,
  rows: readonly Job[],
  from: string,
): Deferral | null {
  if (ledger.steps.some((step) => step.id === from)) return null;
  const promised = admitPending(ledger, rows);
  const steps = promised
    .map(pendingStepOf)
    .filter((step): step is LedgerStep => step !== null);
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (!byId.has(from)) return null;
  const real = new Map(ledger.steps.map((step) => [step.id, step]));
  const through: StepAction[] = [];
  let walker: string | null = from;
  const seen = new Set<string>();
  while (walker !== null) {
    if (seen.has(walker)) break;
    seen.add(walker);
    const landed = real.get(walker);
    if (landed !== undefined) return { from, landed, through };
    const promise = byId.get(walker);
    if (promise === undefined) break;
    through.unshift(promise.action);
    walker = promise.parent;
  }
  return { from, landed: null, through };
}
