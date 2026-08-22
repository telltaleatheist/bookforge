/**
 * job-queue — the conversions, owned by MAIN.
 *
 * It lives here and not in the renderer for the same reason BookForge's stages
 * do: an ng-serve reload, or a user navigating to Settings, must not be able to
 * kill ninety minutes of GPU. The renderer holds a MIRROR, pushed on every
 * change; it never holds the truth.
 *
 * A BOARD OF SLOTS, AND IT WAS ONE SLOT UNTIL WAVE 35. The engine loads a
 * document vision model and holds a GPU for the length of a book; two of THOSE
 * on one machine is two runs that each take twice as long, or an out-of-memory
 * failure at page 200. That is a fact about the CARD, and for a year it was
 * enforced by there being exactly one slot in this file — which also meant a
 * thirty-second EPUB compile sat behind a three-hour reading for no reason at
 * all, because the compile wants a disk and never goes near the model.
 *
 * So the invariant is stated as what it always was: ONE GPU, because the card
 * is one, and TWO CPU RUNS, because Owen said two and because two engine
 * processes writing two different books contend for nothing this app has not
 * already serialised (docs/QUEUE-BOARD.md §2). Which lane a job waits in is a
 * fact about its KIND, declared once in shared/queue-board.ts and read by the
 * scheduler here and by the shelf that draws the board. `pump()` starts the
 * next queued job whose lane has a free slot; nothing preempts, nothing
 * reorders, and a lane that is full is a lane whose rows wait exactly as the
 * whole queue used to.
 *
 * A job that reads through the LOCAL vLLM endpoint waits for that server first
 * (electron/vllm-server.ts). The wait is part of the job, not a thing that
 * happens beside it: the shelf says "Starting the reading server…", and a
 * server that will not start fails THAT job with the guest's own log tail.
 *
 * ── Nothing EXPENSIVE starts until the user says so ──────────────────────────
 *
 * A READING is enqueued HELD. It sits in the list, in order, visible, and does
 * nothing until `start()` releases it. `pump()` only ever claims a `queued` job,
 * so the gate is the state itself rather than a flag anything has to remember to
 * check.
 *
 * THE POINT IS THE BATCH. Enqueueing used to pump immediately, which made the
 * moment of configuring the moment of commitment: the first conversion was
 * already reading pages before the second book could be chosen, so "queue these
 * four and let them run overnight" was not a thing this app could do. `start()`
 * releases everything held AT THAT MOMENT and nothing else — a job added after
 * the press is held again, because Start means "run what is here" and a button
 * that silently also armed the future would make the next enqueue a surprise.
 *
 * A RENDERING IS NOT HELD, and the exception is the rule stated properly. The
 * hold exists so that hours of GPU are never spent by the act of configuring
 * them. A `vlm-convert --reuse-readings` over a finished bank spends no GPU at
 * all: it is arithmetic over answers already on the disk, it is offline, it
 * takes seconds, and it can be asked for again as often as somebody likes. There
 * is nothing to commit to, so there is nothing for Start to mean — and a person
 * who pressed Generate and then had to find this shelf and press another button
 * would be confirming a decision they had already made. It is still QUEUED
 * rather than run beside whatever is going: the number of engines this machine
 * runs at once is a fact about the machine, and it holds however cheap the job
 * is. What CHANGED in Wave 35 is only the number — a cheap rendering waits for a
 * CPU slot rather than for the card, so it no longer sits behind a reading it
 * has nothing in common with.
 *
 * ── NO JOB IN HERE STARTS ANOTHER ONE ────────────────────────────────────────
 *
 * Every row in this queue arrives from a person pressing something. A reading
 * that lands makes ONE document nobody asked for — its book file — and even that
 * is not a job: `vlm-book` is arithmetic over a bank already on the disk, no
 * model, no GPU, no server, so `landReadProducts` spawns it and awaits it inside
 * the settle, which is the same posture `loadBook` (electron/book.ts) takes when
 * a pane opens a book nothing has reflowed. The user: "from that bank, we
 * create an html page of the document - a proto epub. that's the step that appears
 * automatically the moment i OCR something."
 *
 * THE FACSIMILE USED TO ARRIVE HERE TOO, enqueued by the read arm the instant a
 * bank was marked complete, and it was there as insurance rather than as a
 * convenience. It dates from before the bank was kept unconditionally: a
 * page-for-page reprint already on the disk was the one record of a reading that
 * nothing downstream could invalidate. The bank is now kept whatever happens, so
 * the thing that reprint was standing in for is the thing that survives, and
 * making the reprint again is seconds of offline arithmetic over answers that are
 * still there. That turns it into a document somebody ASKS for — Export →
 * Facsimile PDF, or any other door onto `planRendering` — rather than one a
 * landing leaves in a folder, and it leaves this queue with nothing in it that
 * starts a job of its own.
 *
 * ── Environment installs share this queue, and are NOT held ──────────────────
 *
 * An `env-install` row is not a conversion, but it belongs here rather than
 * beside here. It is long, it is cancellable, and — the reason that decides it —
 * a conversion that needs the environment must wait BEHIND it. One serial queue
 * gave that ordering for free, where a downloader running alongside would let a
 * run start against the Python it is halfway through replacing.
 *
 * A BOARD DOES NOT GIVE IT FOR FREE, SO THE BOARD SAYS IT OUT LOUD. An install
 * is `exclusive` (shared/queue-board.ts): it starts only when every slot is
 * free, nothing starts beside it, and nothing queued behind it starts before it
 * does. That is the serial queue's ordering written as a rule instead of
 * inherited from there having been only one slot — and it had to be written,
 * because the alternative on a two-lane board is exactly the race the paragraph
 * above forbids.
 *
 * IT STARTS ON ITS OWN, WHICH IS THE ONE EXCEPTION TO THE RULE ABOVE, and the
 * reason is that it ALREADY HAD ITS START GESTURE. An install arrives from a
 * user pressing Install in Settings, or from the startup provisioner deciding
 * the app cannot work without it — both are explicit, and neither leaves a
 * person wondering what they are waiting for. Holding one would put a second
 * button between somebody and a download they just asked for, and would let the
 * startup provisioner queue five gigabytes that then sat there until a shelf the
 * user has never opened was expanded and pressed. The batch this file exists to
 * make possible is a batch of BOOKS; an install is plumbing.
 *
 * ── A HOST MAY OWN THE SCHEDULING, AND THIS FILE SPLITS IN TWO FOR IT ────────
 *
 * Owen ruled it (docs/PLAN.md, Wave 16): *"we need to centralize the queue in
 * bookforge."* One machine's GPU needs one owner, and hosted there are two
 * schedulers — this one and the host's, which knows nothing about it.
 *
 * So the file has always been two things in one body: a SCHEDULER that decides
 * which row goes next, and an EXECUTOR that turns a row into an engine run and a
 * landing. They are two functions now. `pump()` is the scheduler and is
 * unchanged in what it does; `executeJob()` is everything that used to happen
 * after the row was chosen, and `runJob()` is the second door onto it — execute
 * THIS, now, because somebody else did the deciding.
 *
 * THE DIVISION IS: THEY DECIDE WHEN, WE STILL DO THE WORK. A host's queue never
 * reimplements the ledger writes, the bank, the rotations or the export landings,
 * because two copies of that bookkeeping is how two apps start disagreeing about
 * what a book is. A job ordered by the host is minted as a row here, runs through
 * the same `executeJob`, lands the same products and publishes the same
 * announcements. What disappears in hosted mode is the WAITING — the row is born
 * `running`, because the waiting already happened in somebody else's list.
 *
 * ROUTED VERSUS INTERNAL IS A DOOR, NOT A FLAG. Every exported gesture in this
 * file is either a door a PERSON reached through the window (`enqueue`,
 * `enqueueTranslate`, `cancel`, `remove`, `start`, `clearFinished` — these route
 * when a host queue is registered) or a door FOUNDRY ITSELF reached for
 * (`enqueueHere`, `cancelHere`, `enqueueEnvInstall`, `runJob` — these never
 * route). Nothing below the doors consults anything: `pump`, `executeJob` and
 * every landing are the same code in both worlds, so there is no flag for a
 * function to forget.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readAppSettings } from './app-settings';
import { materializeTranslation } from './book';
import { parseProgressLine, runEngine, writeBookFile } from './engine';
import { ENV_SPECS } from './env-catalog';
import { destFor, installEnv } from './env-install';
import { foundryHost, type FoundryHostQueue } from './host';
import {
  bookAtPosition,
  generatedRoleFor,
  imagesDirFor,
  metadataForProduct,
  positionStepId,
  projectDirOf,
  readStepLedger,
  recordFinal,
  recordGenerated,
  recordReading,
  recordTranslation,
  restoreFinalRotation,
  restoreRotation,
  rotateFinal,
  rotateGenerated,
  type FinalRotation,
  type Rotation,
} from './projects';
import { readSettings } from './settings';
import { ensureServer, isLocalVllmEndpoint, noteQueueBusy, noteQueueIdle } from './vllm-server';
import { REWRITE_LABELS } from '../shared/ledger';
import { fold } from '../shared/original';
import { JOB_RESOURCE, SLOTS, type JobResource } from '../shared/queue-board';
import type {
  ConversionKind, EnvInstallRequest, ExportLanding, FoundryJobRow, Job, JobKind, JobRequest,
  TranslateRequest,
} from '../shared/types';

/**
 * The two things that become an engine child.
 *
 * They share `requests`, `pump()` and the whole run-and-report path because
 * from here they are the same job: spawn foundry, read its stderr, report what
 * it wrote. Only `argsFor` and the reading-server wait can tell them apart.
 */
type EngineRequest = JobRequest | TranslateRequest;

/**
 * WHAT THIS REQUEST PRODUCES — the one answer, in one place.
 *
 * A row's `outputPath` is three things at once: the file Reveal shows, the
 * identity `pendingFor` dedupes on, and the thing a person asking "where did
 * that go?" is pointed at. For most jobs it is the document the run writes. For
 * the two whose real product is not a document it is that product instead:
 *
 * - **A READING PRODUCES ITS BANK.** `vlm-read` writes no document at all —
 *   `readings/<key>.jsonl` is the expensive, irreplaceable thing the hours of
 *   GPU bought, and everything a person eventually reads is generated from it
 *   afterwards for nothing.
 * - **A TRANSLATION PRODUCES ITS RECORDS.** Since D2 a translate run writes
 *   per-block answers rather than a book; the book is materialised from them by
 *   a cast that costs seconds. So the records file is what collides, what is
 *   worth showing, and what the row is.
 * - **EVERYTHING ELSE PRODUCES ITS OUTPUT**, which is the ordinary case and
 *   needs no argument.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THREE CORRECT COPIES ─────────────────────
 *
 * It was three, and all three were right: `enqueueHere`, `enqueueTranslate` and
 * `runJob` each spelled as much of the rule as its own argument type could
 * reach. Three correct copies of one rule is a defect with a delay on it — the
 * day the rule gains a fourth kind, or one copy is edited under time pressure,
 * the copies stop agreeing and NOTHING FAILS LOUDLY. The failure is a dedupe
 * that quietly matches the wrong row.
 *
 * That is not a hypothetical. BookForge — Foundry's host, over the same queue
 * shape — shipped exactly this defect: `readingsPath ?? outputPath`, which made
 * every rendering dedupe against the READ that fills the same bank, so a person
 * pressing Generate got handed the hours-long reading row instead of a
 * conversion. Their own diagnosis, kept here in their words because it is the
 * whole reason this function exists: *"I had written the correct rule once and
 * the wrong rule twice, three functions apart."*
 *
 * So the rule lives here, the three callers ask, and there is no second place
 * for it to be true in a slightly different way. It takes the WIDE request type
 * on purpose — `enqueueHere` can only ever hand it a `JobRequest` and
 * `enqueueTranslate` only ever a `TranslateRequest`, and narrowing the parameter
 * to fit either one would put the fork back where it came from.
 */
function productOf(request: EngineRequest): string {
  if (request.kind === 'read') return request.readingsPath;
  if (request.kind === 'translate') return request.recordsPath;
  return request.outputPath;
}

const jobs: Job[] = [];
/**
 * ONE JOB THIS SCHEDULER HAS RUNNING, AND THE GESTURE THAT STOPS IT.
 *
 * Deliberately not a `RunHandle`: an engine child and an in-process download
 * have nothing in common except that both must stop when the row's ✕ is
 * pressed.
 *
 * ── Why `cancel` is nullable, and what null MEANS here ──────────────────────
 *
 * A slot is taken the moment `pump()` chooses the row, which is BEFORE there is
 * a child to kill: a reading waits minutes for its server first. So null is
 * "this job holds its slot but has spawned nothing yet", which is exactly the
 * state the old code expressed by leaving `running` null through the wait — and
 * `cancelHere` reads it the same way it always did, falling through to settle
 * the row itself rather than calling a cancel that does not exist.
 *
 * It goes back to null at `release()`, when the last child of the run has
 * exited and the landings are still ahead. That, too, is what the single slot
 * did: `running = null` fired at the same point.
 */
interface Slot {
  readonly id: string;
  /**
   * WHAT THIS JOB IS HOLDING, resolved from its kind at the moment it started.
   *
   * Kept on the slot rather than re-derived from the row, so a lane's
   * occupancy is counted from what is actually held. `unscheduled` cannot
   * legitimately appear (a mint is born `running` and this scheduler only ever
   * claims a `queued` row) and is admitted anyway, because the alternative is a
   * cast asserting to the compiler something only a comment can promise.
   */
  readonly resource: JobResource;
  cancel: (() => void) | null;
}

/**
 * THE BOARD, AS OF NOW — every job this scheduler is running, keyed by row id.
 *
 * ── It replaces one variable, and the shape of the replacement is the point ──
 *
 * This was `running: {id, cancel} | null`, and beside it lived a `starting`
 * flag covering the gap between choosing a row and its child existing. Both
 * are gone into this map, and the flag is gone rather than generalised: a slot
 * is TAKEN at the moment of choosing, so the window `starting` existed to
 * cover — a second `pump()` seeing an empty slot during the reading server's
 * minutes-long wait and putting two engines on one card — is closed by the
 * occupancy itself instead of by a second variable that every path had to
 * remember to clear. There is one fact now, and it is the one the drain, the
 * cancel, the shutdown and the lane counts all read.
 *
 * EMPTY IS THE WHOLE OF "NOTHING IS RUNNING HERE", which is what makes the
 * drain test below one line. `detachedRuns` is the other half and is
 * deliberately not in this map — see its own note.
 */
const slots = new Map<string, Slot>();
/**
 * THE RUNS NOBODY HERE SCHEDULED — one entry per live `runJob`, keyed by row id.
 *
 * ── Why they are beside the slot rather than in it ──────────────────────────
 *
 * `slots` is the pump's BOARD and its meaning is "what the internal queue is
 * running". A job the host's scheduler chose must not take a slot on it, in
 * either direction: it must not WAIT for one (the host said now, and `runJob`
 * that waited would hang the host's pump on a queue it cannot see), and it must
 * not HOLD one (a host that calls `exportEpubFromStep` and awaits the answer while
 * a three-hour reading runs would be waiting for that reading — a deadlock built
 * out of two correct-looking rules).
 *
 * THE LANES DID NOT CHANGE THIS, and it is worth saying because a two-lane
 * board looks like somewhere a host's run could be filed. It is not: the lanes
 * are this scheduler's account of what IT decided to run, and a host's
 * scheduler cannot see them, so a host run counted into a lane would be this
 * app rationing slots against a decision it was told about rather than asked
 * for. What a detached run DOES hold is the drain, for the reason at `pump`.
 *
 * What they are for is the same two things the slot is for: a ✕, and a quit. So
 * `cancelHere` looks here when the slot is not this row, and `shutdown` stops
 * every one of them.
 *
 * EMPTY STANDALONE, ALWAYS. Nothing calls `runJob` without a host queue to have
 * scheduled it, so every reader of this map answers exactly as it did before the
 * map existed.
 */
const detachedRuns = new Map<string, () => void>();
let notify: (jobs: Job[]) => void = () => { /* set by main */ };

/** Where the queue publishes. Called on every mutation, with the whole list. */
export function onQueueChanged(listener: (jobs: Job[]) => void): void {
  notify = listener;
}

/**
 * The other thing this queue publishes: an export, the moment it is filed.
 *
 * ── Why it is a registration and not an import ──────────────────────────────
 *
 * Because the queue must not know what a HOST is. Hosted, an export landing is
 * the moment BookForge's versions page gains a row (docs/BOOKFORGE-HANDOFF.md
 * §8) — but this module's business is spawning the engine and reporting what it
 * wrote, and a queue that imported the mount seam to tell it so would be the
 * bottom of the graph reaching for the top. So it is `onQueueChanged`'s shape,
 * for the same reason: main wires it, and main is the only side that knows
 * whether anybody is listening.
 *
 * ONE LISTENER, replaced rather than appended, exactly like the one above. There
 * is one host per process and the alternative — a list — would invite a second
 * subscriber whose failure the first one would have to survive.
 */
let exportLanded: (landing: ExportLanding) => void = () => { /* set by main */ };

export function onExportLanded(listener: (landing: ExportLanding) => void): void {
  exportLanded = listener;
}

/**
 * The third thing this queue publishes: ONE JOB IS OVER — settled in whatever
 * state, or taken out of the list before it ever ran.
 *
 * ── What could not be learned without it ────────────────────────────────────
 *
 * A job that FAILS announces nothing. `onExportLanded` above fires only where
 * there is something to file, which is exactly right for a landing and useless
 * to anybody waiting for an answer: an unattended export ordered from outside
 * this window (`exportEpubFromStep`, electron/mount.ts) has to hear "the engine
 * refused" as surely as it hears "here is the file", or the caller waits for a
 * landing that is never coming. The alternative was a poll over `listJobs`,
 * which is a loop asking a question this module already knows the answer to.
 *
 * ── It fires LAST, and that ordering is the contract ────────────────────────
 *
 * After the tray row, after the announcement, after everything a settle
 * produces. A waiter matching a landing must see the landing FIRST or it would
 * reject a job that succeeded — so "settled" here means "and nothing else is
 * coming from this job", which is the only reading that makes it usable as an
 * ending. `changed()` cannot carry this for the same reason: it fires the
 * instant a state is written, with the landing still ahead of it.
 *
 * ── A ROW REMOVED COUNTS, and that is not a stretched definition ────────────
 *
 * `remove` takes a held or queued job out of the list entirely — it never
 * settles, it is simply gone — and a caller waiting on it would wait forever.
 * What it hears is this, with the row's own state on it, which is honest: this
 * job left the queue without producing anything.
 *
 * MANY LISTENERS, unlike the two above, and they unsubscribe. Each waiter is
 * about ONE job and lives for as long as that job does, so a single slot would
 * mean two unattended exports fighting over it; the returned function is how a
 * waiter stops listening the moment its own job is over.
 */
const settleListeners = new Set<(job: Job) => void>();

export function onJobSettled(listener: (job: Job) => void): () => void {
  settleListeners.add(listener);
  return () => { settleListeners.delete(listener); };
}

/**
 * Say that this job is over — see `onJobSettled` for what that promises.
 *
 * A COPY, on `listJobs`' rule: a listener outside this module must not be handed
 * the row itself. AND EVERY LISTENER RUNS whatever the last one did, because one
 * waiter's bug is not another waiter's ending — the same posture the export
 * announcement takes one call up.
 */
function settled(job: Job): void {
  const row = copyOf(job);
  for (const listener of [...settleListeners]) {
    try {
      listener(row);
    } catch (err) {
      console.error(
        `[queue] a settle listener threw for ${job.outputPath}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** One row as anything outside this module may hold it: deep enough to be safe. */
function copyOf(job: Job): Job {
  return {
    ...job,
    progress: job.progress ? { ...job.progress } : null,
    envProgress: job.envProgress ? { ...job.envProgress } : null,
  };
}

export function listJobs(): Job[] {
  // A copy: the renderer's mirror must not be able to reach back into the truth.
  return jobs.map(copyOf);
}

// ─────────────────────────────────────────────────────────────────────────────
// The host's queue, when there is one — the routing, and the mirrored shelf
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ONE QUESTION THE DOORS ASK, and the only place anything in this file asks
 * it.
 *
 * ── Why it is a function and not a flag ─────────────────────────────────────
 *
 * Because a flag would have to be SET, which means a mount-order bug is a
 * silently unrouted queue. The host record is written once by `mountFoundry`
 * (electron/host.ts) and read here on every call, so the answer cannot go stale
 * and there is nothing to keep in step.
 *
 * ── And why nothing beneath the doors calls it ──────────────────────────────
 *
 * The routing decision belongs to the DOOR somebody came through, and by the
 * time a job is executing the decision has been made — twice over, because a
 * routed job comes back through `runJob` having been chosen by the host. If
 * `executeJob` or a landing asked this question, a hosted run and a standalone
 * run would be two behaviours in one body, which is exactly the drift the split
 * exists to prevent. Grep this name: it appears in the six routed doors, in the
 * drain, and in the two functions that mirror the host's rows. Nowhere else.
 */
function hostQueue(): FoundryHostQueue | null {
  return foundryHost()?.hostQueue ?? null;
}

/**
 * EVERY ROW THE HOST HOLDS, KEYED BY THE FOLDED PROJECT DIRECTORY.
 *
 * ── Why per project going in and one list coming out ────────────────────────
 *
 * The host pushes per project, because that is how it knows its own work — a
 * queue row is about a book. The SHELF is one global list across every project
 * (app/src/app/core/queue.service.ts holds a single signal, set from
 * `queue:changed`), and hosted it must draw the host's work for the whole
 * machine rather than only the book that happens to be open. So the pushes
 * accumulate here and flatten on the way out.
 *
 * FOLDED, on the house rule every path key in this app obeys: on Windows one
 * directory arrives spelled three ways, and a host pushing under
 * `E:\Bookforge\projects\Twain-a1b2` while another push says `e:/bookforge/...`
 * would be two spellings of one project holding two sets of rows. Whole paths,
 * never basenames.
 *
 * AN EMPTY PUSH IS THE ONE PIECE OF NEWS THE MIRROR CANNOT INFER, and it is kept
 * as a real statement rather than deleted: a project whose last row finished
 * says so once, on the falling edge, and the entry stays holding an empty list.
 * `setHostNodes`' rule exactly, one socket along.
 */
const hostRowsByProject = new Map<string, readonly FoundryJobRow[]>();

/**
 * WHAT A WINDOW DRAWS — the host's rows where there is a host queue, ours where
 * there is not.
 *
 * ── Never a merge, and that is the point ────────────────────────────────────
 *
 * Hosted, a job a person pressed for is filed in the host's list and comes back
 * to us only when the host decides to run it — at which moment `runJob` mints a
 * row of our own for it, because the landings, the settle and the export
 * announcement are all things a ROW carries. Publishing both lists would put the
 * host's row for that work beside ours, and the two would disagree the instant
 * one of them moved: two cards for one book, one of them stale. So there is one
 * answer to "what is in the queue" and it is the answer belonging to whoever is
 * doing the scheduling.
 *
 * OUR ROWS ARE STILL THERE AND STILL TRUE — `listJobs` is what `foundryBusy`
 * (electron/mount.ts) and the delete guards read, and they must go on counting a
 * host-ordered run that is writing into a folder somebody is about to erase.
 * This is about what is DRAWN, not about what is known.
 *
 * ── THE ONE EXCEPTION, AND IT IS AN EXCEPTION THAT CANNOT DISAGREE ──────────
 *
 * An env install is appended. BookForge asked for it after seeing one vanish
 * from the shelf mid-download — *"an install is real work with real progress and
 * the shelf is the window's answer to what is this machine doing"* — and it is
 * safe for a reason that is structural rather than careful: AN ENV INSTALL NEVER
 * ROUTES (16e — it is a precondition of the engine running at all, not GPU work,
 * and sending one through a host queue would deadlock the first install behind a
 * job that needs it). So an install exists in exactly one of the two lists, by
 * construction, and no row can be drawn twice — which is the entire hazard the
 * never-a-merge rule above exists to prevent. That rule is unchanged for
 * everything it was written about: every row that CAN be in both lists is drawn
 * from the host's alone.
 */
export function shelfJobs(): Job[] {
  if (hostQueue() === null) return listJobs();
  const rows: Job[] = [];
  for (const held of hostRowsByProject.values()) rows.push(...held.map(copyOf));
  // Every row of ours that never routed, not just the installs: a mint is
  // minutes long and drawing nothing for it while hosted would leave a person
  // watching an app that looks idle while it works.
  return [...rows, ...jobs.filter((job) => NEVER_ROUTED[job.kind]).map(copyOf)];
}

/**
 * THE ONE ID IN A HOSTED SHELF THAT DID NOT COME FROM THE HOST — and the reason
 * drawing a row is never only about drawing it.
 *
 * ── What making a row visible costs ─────────────────────────────────────────
 *
 * `cancel` and `remove` route hosted, unconditionally, because until now every id
 * a hosted shelf could hand back came off a row the HOST had pushed — that
 * premise is written into `remove`'s own docblock. `shelfJobs` appending the env
 * installs makes it false: the shelf draws an install, the shelf's ✕ is bound to
 * that row (`queue.remove` while it is queued, `queue.cancel` once it is
 * running), and a press would forward one of OUR ids into a list that has never
 * heard of it. The download would go on downloading and the button would look
 * broken, which is a worse defect than the invisible row 17c set out to fix.
 *
 * ── Why the test is the KIND and not "is it in our list" ────────────────────
 *
 * Because our list also holds the rows `runJob` mints for work the HOST
 * scheduled, and a cancel of one of those belongs to the host: it chose when that
 * job ran and its own list is what the shelf is drawing. The thing that makes an
 * install different is not where its row is kept, it is that IT NEVER ROUTED —
 * 16e, an install is a precondition of the engine running rather than GPU work.
 * A gesture must go back through the same door the work went out of, and for an
 * install that door was always the internal one. This is `cancelEnvInstalls`'
 * rule (which has always refused to send an install's id to the host) reaching
 * the two gestures a person can now actually press.
 *
 * An id belonging to no row of ours answers false and routes, which is the
 * ordinary case and the whole of the host's queue.
 */
/**
 * Which kinds of row NEVER went out through the host, and are therefore ours
 * to draw and ours to stop.
 *
 * ── A TABLE, BECAUSE THE LAST SPELLING OF THIS WAS A LITERAL AND IT AGED ────
 *
 * This test used to be `kind === 'env-install'`, written when an install was
 * the only work this process did on its own. A MINT is the second: it is
 * rasterized by the renderer under somebody’s hands, it never routes, and the
 * host has never heard of its id. Three sites asked the old question and all
 * three were wrong for a mint — two would have forwarded our id into a list
 * that does not contain it (the work carries on, the button looks broken), and
 * `shelfJobs` would have drawn no row at all for a minutes-long operation while
 * hosted, leaving no progress and nothing to press.
 *
 * As a `Record<JobKind, …>` the compiler names every kind the day one is added,
 * which is the same reason the ledger’s per-action tables are tables. A literal
 * could not, and did not.
 *
 * THE QUESTION IS "DID IT ROUTE", NOT "IS IT IN OUR LIST" — the distinction the
 * old docblock drew and it still holds: our list also holds rows `runJob` mints
 * for work the HOST scheduled, and a gesture on one of those belongs to the
 * host. A gesture must go back through the same door the work went out of.
 */
const NEVER_ROUTED: Readonly<Record<JobKind, boolean>> = {
  // Engine work. It routes: the host chose when it ran.
  epub: false,
  txt: false,
  pdf: false,
  read: false,
  translate: false,
  // A precondition of the engine running rather than GPU work (16e).
  'env-install': true,
  // Renderer-driven and interactive. It never entered the host’s queue and
  // never took the serial slot, so nothing over there can stop it or draw it.
  mint: true,
};

/**
 * Is this id one of OUR rows — one that never routed?
 *
 * An id belonging to no row of ours answers false and routes, which is the
 * ordinary case and the whole of the host’s queue.
 */
function neverRouted(id: string): boolean {
  return jobs.some((job) => job.id === id && NEVER_ROUTED[job.kind]);
}

/**
 * THE PUSH DOOR: these are the host's rows for this project, as of now.
 *
 * `setHostNodes`'s mechanics deliberately — the whole set every time, no diffs,
 * nothing validated on this side — for that door's reasons: a diff protocol
 * between two processes goes wrong silently and stays wrong, and a queue is a
 * handful of rows.
 *
 * THE EMPTY LIST IS AGREED AND IS SENT EXACTLY ONCE, on the falling edge: a
 * project that loses its last row. Without it a global mirror could never learn
 * that a project it was told about has gone quiet, because every other push is
 * about a project that still has something in it.
 *
 * NOTHING IS VALIDATED. A row naming a file in no project of ours, a state this
 * app would never write, a row for a book the window has never opened: all drawn
 * as given. Foundry cannot know what the host's queue holds, and a correction
 * here would be this app overruling the only side that does.
 */
export function setHostQueueRows(projectDir: string, rows: readonly FoundryJobRow[]): void {
  hostRowsByProject.set(fold(projectDir), rows.map(copyOf));
  changed();
}

/**
 * THE FIRST PAINT, asked when a window draws a book.
 *
 * `hostNodesFor`'s reason exactly: every push after this one arrives on its own,
 * and a window that opened after the host's last push would otherwise be drawing
 * a queue it was never told about. Asked of the host, stored through the same
 * door the pushes use, so there is one place a row can come from.
 *
 * A HOST THAT OFFERS NO `rows` IS NOT AN ERROR and is not a fallback: it has said
 * its queue is push-only, and the window will draw its work as soon as something
 * moves. A THROW is caught, because this rides on an unrelated question the tree
 * asks (`host-ops:nodes`) and a host's mistake here must not break the tree.
 */
export function seedHostQueueRows(projectDir: string): void {
  const host = hostQueue();
  if (host?.rows === undefined) return;
  try {
    setHostQueueRows(projectDir, host.rows(projectDir));
  } catch (err) {
    console.error(
      `[queue] the host could not say what it holds for ${projectDir}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * THE HOST'S QUEUE HAS DRAINED OF FOUNDRY WORK — the drain signal, when the
 * deciding is not ours.
 *
 * ── Why this has to exist rather than be derived ────────────────────────────
 *
 * The reading server's lifetime hangs off queue drain (`noteQueueIdle`,
 * electron/vllm-server.ts) and `keepServerWarmMinutes` DEFAULTS TO 0
 * (electron/app-settings.ts), which is not a short timer — it is an immediate
 * `stopServer`. Under a host queue this app's own list is empty between every
 * pair of the host's rows, because the rows live in the host's list until the
 * moment each one runs. Deriving drain from our list would therefore tear the
 * server down after every job and a batch of N readings would pay N model
 * starts, which is twenty gigabytes loaded N times to read one shelf of books.
 *
 * SO THE HOST SAYS IT, AFTER ITS OWN PUMP HAS CHOSEN — it is the only side that
 * knows whether anything is still coming. BUSY STAYS OURS, because every job
 * start already says so from inside `executeJob`, through `runJob` as much as
 * through `pump`, and a busy signal always beats a pending idle timer.
 */
export function hostQueueDrained(): void {
  noteQueueIdle(readAppSettings().keepServerWarmMinutes);
}

function changed(): void {
  notify(shelfJobs());
}

/**
 * A PERSON PRESSED SOMETHING IN THIS WINDOW AND IT WANTS A CONVERSION.
 *
 * ── This is the routed door, and `enqueueHere` is the internal one ──────────
 *
 * With a host queue registered, this hands the request to the host and answers
 * with the host's own row: nothing is minted here, nothing is held here, and the
 * host's pump decides when. With no host queue — standalone Foundry, and every
 * host that has not moved — it is `enqueueHere` and the behaviour below is
 * exactly what it has always been.
 *
 * ── ONLY WHAT A PERSON PRESSED ROUTES, AND THE LINE MATTERS ─────────────────
 *
 * The whole of the rule is written where it is easiest to get wrong — at
 * `exportEpubFromStep`'s enqueue in electron/mount.ts, which calls `enqueueHere`
 * and must never call this. What reaches THIS function is the `queue:*` IPC
 * doors: a person, in the hosted window, pressing Read or Export or Generate.
 *
 * THE ANSWER IS THE HOST'S ROW, UNINSPECTED. It is a `Job` because the host
 * mints it in our shape (`FoundryHostQueue.enqueue`), and it goes straight back
 * out over `queue:enqueue` to the renderer, which compares its id against the
 * mirror to tell an added row from a duplicate. That comparison works on the
 * host's ids for the same reason it works on ours: the mirror is the host's list
 * hosted, so both sides of the comparison come from one place.
 */
export function enqueue(request: JobRequest, parentStep: string | null = null): Job {
  const host = hostQueue();
  if (host !== null) return host.enqueue(request, parentStep);
  return enqueueHere(request, parentStep);
}

/**
 * Put a conversion in the queue, HELD.
 *
 * THE INTERNAL DOOR: it never routes, whoever is hosting. Foundry's own
 * unattended work comes through here — an export the host ORDERED through the
 * mount seam, which by ordering it has already scheduled — and so does every
 * enqueue when nobody has registered a queue of their own.
 *
 * Returns the EXISTING row when one is already waiting or running to write the
 * same file, which is `enqueueEnvInstall`'s rule applied to the thing it
 * actually protects: two rows writing one output is the worst outcome
 * available — the second run overwrites the first while the first is still
 * reading, and the file on disk ends up neither. The OUTPUT is the identity
 * because that is what collides; the same book converted to an EPUB and to a
 * PDF is two different files and therefore two honest rows.
 */
export function enqueueHere(
  request: JobRequest,
  /**
   * The project's position, RESOLVED BY THE CALLER BEFORE IT CALLED.
   *
   * ── Why it is an argument rather than read in here ──────────────────────────
   *
   * Reading a position means reading a catalogue off the disk, and this function
   * is synchronous on purpose: it returns the row the shelf draws, immediately,
   * so pressing Add cannot leave a moment where nothing has appeared. Making it
   * async to fetch one field would put a file read between a person's click and
   * its own feedback, for a fact the IPC handler is already awaiting things to
   * compose.
   *
   * WHAT MATTERS IS THE MOMENT, AND THE MOMENT IS THE SAME ONE. The handler
   * resolves the position and enqueues in one turn, so this is the position at
   * the press — which is the whole point (`Job.parentStep`). Null for a project
   * with no history yet, and for every caller that has nothing to say.
   */
  parentStep: string | null = null,
): Job {
  /*
   * WHAT THIS JOB PRODUCES, which for a reading is the BANK — asked of
   * `productOf`, which is the only place that rule is written down. The argument
   * for why it is a function rather than the ternary that used to stand here is
   * at `productOf` itself.
   */
  const outputPath = productOf(request);
  const already = pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    kind: request.kind,
    /*
     * ── THE HOLD IS FOR THE EXPENSIVE ONE ONLY ──────────────────────────────
     *
     * A reading is held, for every reason the hold was built for: it is hours of
     * GPU against a file the user picked in a dialog they may have picked wrong,
     * and holding is what makes a BATCH possible — queue four books, look them
     * over, press Start once.
     *
     * A RENDERING RUNS THE MOMENT IT IS ASKED FOR, and making it wait would be
     * the hold applied to the thing it was never about. It is arithmetic over
     * answers already on the disk: seconds, offline, no model, no server, and
     * repeatable as often as somebody likes. There is nothing to commit to and
     * nothing to review — and a person who pressed Generate and then had to find
     * a shelf and press Start would be pressing a second button to confirm a
     * decision they made by pressing the first.
     *
     * It still goes THROUGH the queue and still waits behind whatever is
     * running. That is the machine being busy rather than the person being
     * asked, which is the distinction `held` and `queued` have always drawn.
     *
     * A TRANSLATED RENDERING IS STILL A RENDERING, and it did not used to be.
     * This line held a Generate standing under a translation, honestly: that job
     * ran the TRANSLATOR as its second stage, and a seeded bank made it cheap
     * rather than free — text edited since the translation was re-asked of a
     * model, and a cold Ollama made it a translation run in everything but the
     * button that started it. There is no second stage now. A translated book is
     * one `vlm-convert` with the records substituted into the blocks: no model,
     * no socket, seconds, and repeatable as often as somebody likes. So it is
     * queued like every other rendering, and the hold goes back to meaning what
     * it has always meant — nothing expensive starts until the user says so.
     */
    state: request.kind === 'read' ? 'held' : 'queued',
    progress: null,
    parentStep,
    /*
     * CARRIED ONTO THE PUBLIC SHAPE, which almost nothing on a request is. The
     * shelf's row is everything the renderer knows about a job, and this is the
     * one fact that distinguishes a save's own book from the two `epub` jobs a
     * person asks for — which matters there because a finished one opens itself.
     * See `Job.forStep`.
     */
    ...(request.kind !== 'read' && request.forStep !== undefined
      ? { forStep: request.forStep }
      : {}),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  if (job.state === 'queued') void pump();
  return job;
}

/**
 * A job already waiting or running to write this file, if there is one.
 *
 * `done`, `failed` and `cancelled` rows are deliberately NOT matched: those are
 * a record of something that already happened, and refusing to re-run a
 * conversion because it failed an hour ago would make the shelf's own history
 * the reason the retry is impossible.
 */
function pendingFor(outputPath: string): Job | undefined {
  const key = path.resolve(outputPath).toLowerCase();
  return jobs.find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && path.resolve(job.outputPath).toLowerCase() === key,
  );
}

/**
 * Is a live job producing this file right now?
 *
 * Asked by main before "edit transformed text" rewrites a records file whole: a
 * translation appends to that file for hours, and a whole-file swap made in the
 * middle of its run would drop every answer the run lands between the read and
 * the rename. The check and the write are not one atom — a job could start in
 * the millisecond between — but the whole window a run is actually open is
 * caught here, and the sentence names the honest way out: wait, or cancel the
 * run.
 */
export function producing(outputPath: string): boolean {
  return pendingFor(outputPath) !== undefined;
}

/**
 * One spelling for a path, so Windows' three become one.
 *
 * It came from electron/workspace.ts with the translate rotation, and it is the
 * fold `pendingFor` above spells inline for the same reason it spells it inline:
 * that one hoists the key out of a loop over every job, this one compares exactly
 * two paths. The house pattern is a fold beside whoever needs it rather than a
 * shared path module — electron/recents.ts and electron/overlays.ts each keep
 * their own — because the answer is a fact about the filesystem underneath, and
 * app/shared is compiled into the renderer where there is no `node:path` at all.
 */
function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** The full request, kept beside the job — the job itself is the PUBLIC shape. */
const requests = new Map<string, EngineRequest>();
const envRequests = new Map<string, EnvInstallRequest>();

/**
 * Put a translation in the queue.
 *
 * Behind whatever is already running, always. The engine holds an Ollama model
 * for the length of a book and a conversion holds a vision model for the length
 * of another; running both means two models resident on one GPU, which on the
 * hardware this is built for is an out-of-memory failure four hours in.
 *
 * IT ROUTES LIKE `enqueue`, and it has no `…Here` twin for one reason: nothing
 * inside this app orders a translation. Every translation in Foundry's history
 * arrived from a person filling in the Translate dialog, so this door has exactly
 * one caller and the branch below IS the door deciding. A second, unrouted door
 * would be a name nobody could prove the need for.
 */
export function enqueueTranslate(
  request: TranslateRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): Job {
  const host = hostQueue();
  if (host !== null) return host.enqueue(request, parentStep);
  /*
   * WHAT THIS JOB PRODUCES, which for a translation is now the RECORDS — the same
   * question `enqueueHere` asks about a reading and its bank, asked of the same
   * function so the two can never answer it differently. See `productOf`.
   */
  const outputPath = productOf(request);
  const already = pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    kind: 'translate',
    state: 'held',
    progress: null,
    /*
     * A REWRITE NAMES ITSELF IN THE SHELF, and a translation goes on naming its
     * book.
     *
     * The row falls back to the project's title, which is the right answer while
     * a book can only be in the queue for one reason — and it stopped being one
     * the moment two different buttons produced the same kind of job about the
     * same book. Somebody who queued a rewrite and a translation of one book, or
     * queued a rewrite and came back an hour later, would be looking at two rows
     * with one name on them, deciding which to Start.
     *
     * SO THE ACT WINS OVER THE BOOK, for the row that has a choice to explain.
     * What is on screen is a short list of things somebody is about to spend a
     * night of GPU on, and "Simplify — natural voice" is the fact they are
     * checking; the book is one hover away in the row's paths, where every
     * filename in this shelf already lives.
     */
    ...(request.rewrite !== undefined ? { title: `Simplify — ${REWRITE_LABELS[request.rewrite]}` } : {}),
    /*
     * A TRANSLATION IS THE STEP THIS FIELD WAS BUILT FOR. It is the one action a
     * person routinely runs from an earlier row — translate from the reading,
     * click back, translate again into another language — and it is the one that
     * runs for hours, which is exactly the window in which a pointer moves. The
     * user's own scenario in the design document is this job twice.
     */
    parentStep,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  // Held, like every other engine job. See this file's header.
  return job;
}

/**
 * ONE GESTURE OFF THE SHELF, HANDED TO WHOEVER OWNS THE ROW.
 *
 * The four gestures below (`start`, `remove`, `cancel`, `clearFinished`) name a
 * row by id, and hosted those ids are the HOST's — off the host's own rows, which
 * are what the shelf drew. So there is nothing here to do locally and nothing to
 * fall back to: this app cannot cancel a row it never minted.
 *
 * AN ABSENT GESTURE IS SAID OUT LOUD. Each member of `FoundryHostQueue` past
 * `enqueue` is optional, so a host may offer a queue whose rows this window
 * cannot cancel — which is a complete thing for a host to say, and is not the
 * same as Foundry quietly cancelling something of its own instead. The console
 * line is the honest record of a press that had nowhere to go.
 */
function forwardToHost(gesture: string, act: (() => void) | undefined): void {
  if (act === undefined) {
    console.error(
      `[queue] the app Foundry is running inside keeps its own queue and offers no ${gesture} `
      + 'for its rows, so that press did nothing here.',
    );
    return;
  }
  act();
}

/**
 * Release everything held, in the order it was added, and let the queue drain.
 *
 * EVERYTHING HELD AT THIS MOMENT, and nothing after it. A job enqueued while
 * these are running is held again and waits for the next press — Start is a
 * commitment to a batch somebody has just looked over, and a button that also
 * armed whatever arrived later would make the NEXT enqueue start a run nobody
 * pressed anything for.
 *
 * Returns how many it let go, so the caller can say so. Ordering is the array's,
 * which is insertion order, which is what the shelf shows: releasing is a state
 * change and never a reshuffle.
 *
 * HOSTED, IT IS THE HOST'S BATCH BEING RELEASED and the answer is 0 — which is
 * the literal truth rather than a shrug: zero of FOUNDRY's rows were released,
 * because hosted there are none to release. The count is used by the door to say
 * so in the shelf's own words, and the shelf hosted is drawing the host's list,
 * which the host's own push will correct a moment later.
 */
export function start(): number {
  const host = hostQueue();
  if (host !== null) {
    forwardToHost('Start', host.start?.bind(host));
    return 0;
  }
  let released = 0;
  for (const job of jobs) {
    if (job.state !== 'held') continue;
    job.state = 'queued';
    released += 1;
  }
  if (released === 0) return 0;
  changed();
  void pump();
  return released;
}

/**
 * Take a row out of the list entirely. Held and queued only.
 *
 * NOT A CANCEL, AND THE DIFFERENCE IS THE WHOLE REASON THIS EXISTS. `cancel`
 * settles a job as `cancelled`, which is the right record of a run that was
 * stopped — somebody spent GPU on it and then took it back. A job that never
 * started spent nothing and produced nothing, and a `cancelled` row for it is
 * residue: it sits in the shelf, it counts towards "finished", and it has to be
 * cleared by hand to make the list readable again. Removing an unwanted batch
 * item should leave the shelf looking like it was never added, because it was
 * never anything.
 *
 * A RUNNING job is refused here. There is a child holding a GPU, and the gesture
 * for that is `cancel` — which stops it and then, correctly, files it.
 *
 * "IT WAS NEVER ANYTHING" IS NOW TRUE OF THE DISK AS WELL, and it was not always.
 * A held translation had already moved the project's previous edition into
 * `generated/archived-<stamp>/` — at plan time, before this row existed — so
 * removing it left the catalogue pointing into an archive folder for a run that
 * never spawned, and this function had nothing to put back because nothing
 * remembered the move. Both rotations happen in `pump()` now, one line before the
 * engine starts, so a row removed from here has touched no file at all and there
 * is nothing for a removal to undo.
 *
 * HOSTED, THE ROW IS THE HOST'S AND SO IS THE REMOVAL. The id came off a row the
 * host pushed; there is no row of ours by that name, and searching for one would
 * be this app answering a question about somebody else's list. WITH ONE
 * EXCEPTION AS OF 17c, and it is an exception to the premise rather than to the
 * rule: a hosted shelf also draws the rows that never routed -- our env
 * installs, and now our mints -- so an id off that shelf can be one of ours
 * after all. `neverRouted` is the whole of the test and carries the argument.
 */
export function remove(id: string): void {
  const host = hostQueue();
  if (host !== null && !neverRouted(id)) {
    forwardToHost('remove', host.remove === undefined ? undefined : () => { host.remove?.(id); });
    return;
  }
  const index = jobs.findIndex((job) => job.id === id);
  if (index < 0) return;
  const job = jobs[index]!;
  if (job.state !== 'held' && job.state !== 'queued') return;
  jobs.splice(index, 1);
  requests.delete(id);
  envRequests.delete(id);
  changed();
  // The row is gone rather than finished, and anybody waiting on it has to hear
  // that too — see `onJobSettled`, which counts this as an ending because for a
  // waiter it is the only one it will ever get.
  settled(job);
  /*
   * Removing can be the thing that empties the queue, and the drain signal lives
   * in pump()'s nothing-to-do branch — which nothing else would visit. Same
   * reasoning as `cancel`'s trailing pump, and the same consequence if it is
   * left out: the reading server stays up with nothing to read for it.
   */
  void pump();
}

/**
 * Put an environment install in the queue.
 *
 * Returns the EXISTING row when one for the same target is already waiting or
 * running: the startup provisioner and a user's Install button can easily arrive
 * at the same conclusion seconds apart, and two rows downloading five gigabytes
 * into one directory is the worst outcome available.
 *
 * ── IT NEVER ROUTES TO A HOST QUEUE, whoever is hosting ─────────────────────
 *
 * An install is not GPU work being scheduled: it is the PRECONDITION of the
 * engine running at all, and half of them are ordered by the startup provisioner
 * before anybody has pressed anything. Filing one in a host's queue would put it
 * behind whatever that queue is holding — including, in the ordinary case, the
 * very job that cannot run until the install has finished. The queue this app
 * keeps for itself is exactly the size of that argument: installs, and the
 * unattended exports a host asks for by name.
 */
export function enqueueEnvInstall(request: EnvInstallRequest, reason?: string): Job {
  const pending = jobs.find(
    (job) => job.kind === 'env-install'
      && envRequests.get(job.id)?.target === request.target
      && (job.state === 'held' || job.state === 'queued' || job.state === 'running'),
  );
  if (pending) return pending;

  const spec = ENV_SPECS[request.target];
  const job: Job = {
    id: randomUUID(),
    // An install has no document; these two carry what it is and where it goes,
    // so the shelf's title attribute and the reveal button still mean something.
    inputPath: request.target,
    outputPath: destFor(request),
    kind: 'env-install',
    title: spec.label,
    // `queued`, not `held`: an install already had its start gesture. The
    // header says why this is the one exception.
    state: 'queued',
    progress: null,
    envProgress: null,
    message: reason,
    createdAt: Date.now(),
  };
  jobs.push(job);
  envRequests.set(job.id, request);
  changed();
  void pump();
  return job;
}

/**
 * Cancel: kill the child if it is this job's, drop it from the queue if it is
 * not. Both end as `cancelled`, because from the shelf they are one gesture.
 *
 * A HELD JOB IS NOT CANCELLABLE AND FALLS THROUGH HERE DOING NOTHING, which is
 * deliberate rather than an oversight. Nothing was started, so there is nothing
 * to stop and no record worth keeping; the gesture for a batch item somebody has
 * changed their mind about is `remove`, which leaves no row behind. The shelf
 * routes accordingly and this stays the operation for a run that is under way.
 *
 * THE ROUTED DOOR, with `cancelHere` below it. Hosted, the ✕ names one of the
 * host's rows and the host is the only side that can stop it — even for work
 * that is running through `runJob` at this moment, because the host asked for
 * that run and holds the row people are looking at. Foundry's own gestures on
 * its own rows (`cancelEnvInstalls`, and the abort signal a `runJob` carries)
 * go to `cancelHere` and cannot be routed away.
 */
export function cancel(id: string): void {
  const host = hostQueue();
  // A row that never routed is ours however this window is hosted, and its ✕ is
  // reachable in the hosted shelf now that it draws the row — see `neverRouted`.
  if (host !== null && !neverRouted(id)) {
    forwardToHost('cancel', host.cancel === undefined ? undefined : () => { host.cancel?.(id); });
    return;
  }
  cancelHere(id);
}

/**
 * Cancel one of FOUNDRY's OWN rows, whoever is hosting — the internal door.
 *
 * ── The two live children, and why the lookup has two halves ────────────────
 *
 * `slots` is the pump's board: the jobs THIS scheduler decided to run, each
 * holding a lane. A run started by `runJob` is NOT on it — it was scheduled by
 * somebody else and must not wait behind, or be waited behind by, the internal
 * queue — so its cancel lives in `detachedRuns` beside it. Both are "the child
 * this row is", and a cancel asks for whichever one this row has. Standalone
 * `detachedRuns` is always empty and this reads exactly as it always did.
 *
 * A SLOT WITH NO CHILD IN IT ANSWERS NULL AND FALLS THROUGH, which is the same
 * answer the single slot gave by being null at the same two moments: while a
 * reading waits for its server, and after the last child has exited with the
 * landings still running. `??` treats that null exactly as it treated an absent
 * slot, so the branch below settles the row itself — which is what keeps the ✕
 * alive through the minutes a server takes to come up.
 */
/*
 * ── THE MINT ROW, WHICH IS A ROW AND NOT A JOB THE PUMP RUNS ────────────────
 *
 * A mint is minutes of work and it belongs on the shelf with progress and a
 * cancel, exactly like a read. It must NEVER occupy a slot.
 *
 * WHY NOT, PRECISELY. `pump` rations the lanes because the engine is a process
 * against a card and a disk: two reads at once are slower than two reads in a
 * row. A mint is neither — the rasterizing happens in the RENDERER, driven by a
 * person who is watching it, and main only assembles what arrives. Putting it in
 * a lane would mean a read queued behind somebody cropping photographs waits for
 * them to finish, and a mint queued behind a full lane cannot start until that
 * lane frees, which for an interactive stage reads as the button being broken.
 * The table says so in its own words: a mint is `unscheduled`
 * (shared/queue-board.ts).
 *
 * THE MECHANISM IS THE STATE AND NOT A FLAG. `pump` selects `state === queued`
 * and nothing else, so a row born `running` is invisible to it — no exclusion
 * list to keep up to date, no second gate to remember. The same trick the hold
 * uses in reverse, and it means a mint and a read genuinely run at once.
 *
 * `env-install` is the precedent for a row the OCR panel never enqueued, and
 * this departs from it in exactly one way: an install DOES take slots — every
 * one of them (`pump` dispatches it as `exclusive`), because an install and a
 * read compete for the same disk, the same network and the same Python. A mint
 * competes with nothing.
 */
export function beginMint(projectDir: string, title: string, pages: number): string {
  const job: Job = {
    id: randomUUID(),
    // No document exists yet — that is what this row is making. The project
    // directory is what the shelf can usefully reveal.
    inputPath: projectDir,
    outputPath: projectDir,
    kind: 'mint',
    title,
    // BORN RUNNING. See above: `queued` would put it in the pump's path, and
    // `held` would wait for a start gesture that already happened.
    state: 'running',
    // `render` because that is literally the pass: the renderer is rasterizing
    // page quads, and the shelf already knows how to say "page 3/27: rendered".
    progress: { page: 0, total: pages, phase: 'render' },
    envProgress: null,
    createdAt: Date.now(),
  };
  jobs.push(job);
  changed();
  return job.id;
}

/** One more page is in the book. */
export function noteMintPage(id: string, page: number): void {
  const job = jobs.find((row) => row.id === id);
  if (job === undefined || job.state !== 'running') return;
  job.progress = { page, total: job.progress?.total ?? page, phase: 'render' };
  changed();
}

/**
 * Has somebody pressed the ✕ on this mint?
 *
 * THE MINT ASKS RATHER THAN BEING TOLD, because the work is happening on the
 * other side of the bridge: `cancelHere` can set this row to `cancelled` in a
 * microsecond, but the renderer is midway through rasterizing a page and will
 * keep sending. So the session checks this as each page arrives and refuses the
 * next one — the cancel takes effect within one page rather than instantly, and
 * nothing has to reach into the renderer to stop it.
 */
export function mintCancelled(id: string): boolean {
  const job = jobs.find((row) => row.id === id);
  return job === undefined || job.state === 'cancelled';
}

/** The mint finished, or it did not. */
export function settleMint(id: string, outcome: { file: string } | { error: string }): void {
  const job = jobs.find((row) => row.id === id);
  if (job === undefined || job.state !== 'running') return;
  if ('file' in outcome) {
    job.state = 'done';
    job.outputPath = outcome.file;
    job.progress = { page: job.progress?.total ?? 0, total: job.progress?.total ?? 0, phase: 'render' };
  } else {
    job.state = 'failed';
    job.error = outcome.error;
  }
  job.finishedAt = Date.now();
  changed();
  settled(job);
}
export function cancelHere(id: string): void {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  if (job.state === 'running') {
    const stop = slots.get(id)?.cancel ?? detachedRuns.get(id);
    if (stop !== undefined) {
      stop();
      return; // the close handler settles the state
    }
  }
  // Queued, or running-but-not-yet-spawned: a job waiting for the reading
  // server to come up is `running` with no child of its own, and a cancel that
  // did nothing there would leave the button dead for the minutes that takes.
  if (job.state === 'queued' || job.state === 'running') {
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    // The derived book this export was going to be compiled from, if it never
    // got as far as the settle that normally sweeps it. Nothing else will ever
    // mention that file again — see `sweepDerivedBook`.
    void sweepDerivedBook(requests.get(job.id));
    changed();
    settled(job);
    // A cancel can be the thing that empties the queue, and the drain signal
    // lives in pump()'s nothing-to-do branch — which nothing else would visit.
    void pump();
  }
}

/**
 * The book main materialised for an export, removed.
 *
 * ── Why it goes, and why it goes on failure too ─────────────────────────────
 *
 * It is scratch: a pure function of the reading's own book file and a chain in
 * the ledger, made when the button was pressed and remade for nothing whenever it
 * is wanted again (docs/RENDERER.md §4 — derived book files are `regenerable`
 * retention). Nothing catalogues it, nothing can open it twice, and its name is a
 * uuid in a temp directory.
 *
 * KEEPING THE FAILED ONE IS DELIBERATELY NOT DONE. The engine's refusal names
 * the block it choked on, in words, in the terminal that is already open — that is
 * what somebody debugs from, and a copy of a book under a uuid is not.
 *
 * BEST EFFORT AND NEVER A THROW: an export that produced a book is not a failure
 * because a scratch file would not unlink, and a cancel is not a failure at all.
 */
async function sweepDerivedBook(request: EngineRequest | undefined): Promise<void> {
  if (request === undefined || request.kind === 'read') return;
  // A TRANSLATION HAS ONE TOO, and it always has one: the book it read is the
  // position materialised (`TranslateRequest.bookPath`), scratch on exactly the
  // terms an export's is. It was excluded here while a translation read a cast.
  if (request.bookPath === undefined) return;
  try {
    await fsp.rm(request.bookPath, { force: true });
  } catch (err) {
    console.error(
      `[job] the derived book ${request.bookPath} could not be removed: ${(err as Error).message}`,
    );
  }
}

/**
 * Stop whichever environment install is going, from anywhere.
 *
 * Routed through `cancelHere` rather than reaching into the installer, because
 * the queue is what decides a row's final STATE: an abort that bypassed it
 * settled the install as `failed` with "Cancelled." as its error — technically
 * true, and a red exclamation mark in the shelf for something the user themselves
 * asked to stop.
 *
 * `cancelHere` AND NOT `cancel`, and this is the line that proves the internal
 * doors were worth having. An install is never in a host's queue (see
 * `enqueueEnvInstall`), so a cancel that routed would send one of OUR ids into a
 * list that has never heard of it — and the download would go on running while
 * the app reported it stopped.
 */
export function cancelEnvInstalls(): void {
  for (const job of [...jobs]) {
    if (job.kind === 'env-install' && (job.state === 'running' || job.state === 'queued')) {
      cancelHere(job.id);
    }
  }
}

/**
 * Clear everything that has stopped. The running job, the queue and the HELD
 * batch all survive.
 *
 * `held` joins `queued` and `running` on the survivor list for the obvious
 * reason and one less obvious one: a held job has not stopped, so it is not
 * "finished" by any reading — and it is also the only state a user can be
 * accumulating deliberately. A Clear that swept away the batch somebody was
 * halfway through assembling would be the most expensive button in the app.
 *
 * ── HOSTED IT DOES BOTH, WHICH IS NOT A FALLBACK ────────────────────────────
 *
 * The press is forwarded, because the rows on screen are the host's and clearing
 * them is the host's to do. And then Foundry's own finished rows are cleared as
 * well — not as a second guess at the same list, but because there IS a second
 * list hosted and it is invisible: every job the host runs through `runJob` mints
 * a row here, and those rows would otherwise accumulate for the life of the
 * process with nothing in the window able to reach them. One press, two lists,
 * neither of them the other's answer.
 */
export function clearFinished(): void {
  const host = hostQueue();
  if (host !== null) {
    forwardToHost('Clear finished', host.clearFinished?.bind(host));
  }
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (job && job.state !== 'held' && job.state !== 'queued' && job.state !== 'running') {
      requests.delete(job.id);
      envRequests.delete(job.id);
      jobs.splice(i, 1);
    }
  }
  changed();
}

/**
 * Quit, or a window closing on us: nothing is left holding a GPU.
 *
 * BOTH KINDS OF LIVE CHILD, because there are two: whatever this scheduler has
 * on the board and whatever a host's scheduler has running through `runJob`. A
 * quit that stopped only the first would leave the host's reading holding twenty
 * gigabytes with nothing left to report to — which is the exact hazard this
 * function exists for, arriving through the newer door.
 *
 * EVERY SLOT, NOT THE SLOT. This used to be one `running?.cancel()` because
 * there was one slot; a board that stopped only the first row it found would
 * leave a second engine writing into a project while the app disappeared from
 * around it. A slot whose child has not spawned yet holds null and is skipped —
 * there is nothing to kill, and the process is going away regardless.
 */
export function shutdown(): void {
  for (const slot of [...slots.values()]) slot.cancel?.();
  slots.clear();
  for (const stop of [...detachedRuns.values()]) stop();
  detachedRuns.clear();
}

/**
 * The command line, assembled in ONE place.
 *
 * `--readings` is passed on EVERY job — electron/workspace.ts names the bank,
 * and there is no switch that turns it off. It is what makes an interrupted
 * 300-page run resumable, and foundry decides for itself whether a bank beside a
 * completion marker is a resume or a re-read (README §Reading the pages
 * somewhere else, and only once). This app does not second-guess it.
 *
 * No `--vlm-endpoint`. The settings screen owns which backend reads the pages,
 * the engine reads that same settings.json for itself, and a per-job override
 * here was a second opinion about a decision that has one owner.
 */
function argsFor(
  request: EngineRequest,
  /**
   * The merged metadata patch this product carries, for the ONE route that puts
   * it on the command line rather than stamping it on afterwards — see the
   * compile branch below. Empty for every other job, and for a project whose
   * ancestry recorded nothing.
   */
  metadata: Record<string, string> = {},
): string[] {
  if (request.kind === 'translate') {
    /*
     * A translation shares nothing with a conversion's command line but the
     * program name. No `--format` and no `--out`: this run writes RECORDS, one
     * row per flowing block keyed by the block's own position in the reading
     * bank, and the engine refuses an `--out` beside `--records` by name because
     * the EPUB it would write is a book nobody would ever open.
     *
     * `--ollama` IS passed — unlike the reading backend, which the settings
     * screen owns and which the engine reads for itself. Ollama has no settings
     * screen here because it is not a server this app manages.
     *
     * `--records` IS THE CACHE AS WELL AS THE PRODUCT, which is why there is no
     * `--bank` on this line any more and why the engine refuses the pair. It was
     * the exact counterpart of `--readings` on a conversion — both hours of a
     * model held as answers — and it stopped being optional the day a 456-block
     * book was killed at block 152 having written nothing at all. Nothing about
     * that is weakened: an unchanged block's question is already answered in the
     * records file and is never asked twice, and every answer is appended the
     * moment it is accepted.
     */
    const args = [
      'translate',
      /*
       * THE BOOK, AND NOT A RENDERING OF IT. `--epub` used to be here, pointed at
       * the position's cast, and everything about that was one hop too far: the
       * words came back out of markup they had been written into, and each block
       * was named by the `data-bf-src` stamped on it rather than by the name it
       * already had. This is the position's book file with its whole chain of
       * changes replayed into it by main (`materializeBook`, electron/book.ts) —
       * so a struck row is not in it, and the records that come back are keyed by
       * the ROWS' OWN IDS, which is what the derived book in the target language
       * is materialised against when this lands (docs/RENDERER.md §4).
       *
       * NO `--source-records` ANY MORE, and the engine refuses it beside this
       * flag: a book file at a position under a translation already holds the
       * parent's words, so a chain is a fact about the file rather than a second
       * path on the command line.
       */
      '--book', request.bookPath,
      '--records', request.recordsPath,
      '--to', request.to,
      '--model', request.model,
      '--ollama', request.ollama,
    ];
    /*
     * ── THE CHAIN, WHICH IS NOW ONE FLAG AND NO MACHINERY AT ALL ──────────────
     *
     * `--from` says which language the words in that book file are in, and the
     * words themselves are the parent translation's because the file IS its
     * derived book. Composed by the plan off the ledger (`planTranslation`,
     * electron/workspace.ts): nothing reads a language out of a file of
     * sentences, and a guess would put "German → Hungarian" on a prompt holding
     * English.
     */
    if (request.from && request.from.trim().length > 0) args.push('--from', request.from.trim());
    /*
     * ── AND THE ONE FLAG THAT MAKES THIS A REWRITE INSTEAD ────────────────────
     *
     * `--rewrite` swaps the prompt and touches nothing else on this line: the same
     * book, the same records file, the same model, the same endpoint. `--to`
     * carries the book's OWN language beside it and the engine is content with a
     * pair that matches, because a rewrite is same-language by design — which is
     * the one thing about this command that would look like a mistake to somebody
     * reading it in a terminal, and is not one.
     */
    if (request.rewrite !== undefined) args.push('--rewrite', request.rewrite);
    /*
     * The reading these answers are about, written into every row and read by
     * nobody in the engine — `Overlay.generation`'s contract, one folder over. It
     * is what lets the app tell records made against THIS pass over the pages from
     * records left beside a book that has since been read again.
     */
    if (request.generation !== undefined && request.generation.length > 0) {
      args.push('--generation', request.generation);
    }
    if (request.instructions && request.instructions.trim().length > 0) {
      args.push('--instructions', request.instructions.trim());
    }
    return args;
  }
  /*
   * ── READING THE PAGES ────────────────────────────────────────────────────
   *
   * `foundry vlm-read --pdf X --readings Y`. It fills the bank, drops the
   * completion marker beside it, and writes no document at all.
   *
   * ── ONE FLAG (Wave 41), AND THE ENGINE STILL HAS TWO ───────────────────────
   *
   * This chose between `--pdf` and `--pages` off `ReadRequest.inputKind`, because
   * a captured project's archive was a folder of photographs and the engine had
   * learned to read one at Wave 21. Owen ended the choice: *"if we're building
   * the bank from the images anyway maybe we should just build it from the pdf.
   * why not? it would help maintain provenance, and nothing will be lost."* The
   * mint writes the PDF, so there is one input and one story — bank ← PDF ←
   * pages — and `planReading` states the provenance argument in full.
   *
   * `vlm-read --pages` IS UNTOUCHED AND STAYS. It is a capability of the command
   * and works from a terminal exactly as it did; what retired is the app's
   * selection of it. The engine's own *"a reading is of exactly one thing"*
   * refusal for a run naming both is now unreachable from here twice over.
   *
   * NO `--out` AND NO `--format`, which is the whole of the split on the command
   * line: this run has no opinion about what the book will eventually be, and it
   * cannot be given one. The person who ordered it may generate an EPUB tonight
   * and plain text next week, and neither of those decisions is a fact about the
   * reading — so neither can be asked for while it is being configured.
   */
  if (request.kind === 'read') {
    const args = ['vlm-read', '--pdf', request.inputPath, '--readings', request.readingsPath];
    if (request.skipPages && request.skipPages.trim().length > 0) {
      args.push('--skip-pages', request.skipPages.trim());
    }
    if (request.language && request.language.trim().length > 0) {
      args.push('--language', request.language.trim());
    }
    return args;
  }

  /*
   * ── COMPILING THE BOOK SOMEBODY EDITED ───────────────────────────────────
   *
   * `foundry vlm-compile --book <derived> --out <product>`, and it is a different
   * command rather than a flag on the one below because it takes a different
   * INPUT: not the bank and a curation, but the book itself, with this position's
   * whole chain of changes already replayed into it by main (`materializeBook`,
   * electron/book.ts). The engine has never heard of the op grammar and never
   * will — the replay lives once, in this process, because the renderer draws
   * from it too (docs/RENDERER.md §9) — so what crosses the boundary is a
   * document and the engine's job is to compile what it is handed.
   *
   * NO `--reuse-readings` and NO `--final`. The first is about
   * a bank this run never opens. The third is about a choice this command does
   * not have: there is no cast to write from a book file, so the edition's rules
   * are the compile's constants (see `vlm-compile`'s own help).
   *
   * THE FACSIMILE NEVER REACHES HERE, and that is by construction rather than by
   * a test: `--format pdf` reprints the scan's own photographed lines from the
   * raw bank, so `planExport` never materialises a book for one and the field
   * that would send it down this branch is absent (docs/RENDERER.md §6).
   */
  if (request.bookPath !== undefined) {
    const args = ['vlm-compile', '--book', request.bookPath, '--out', request.outputPath];
    /*
     * THE FIGURES, WHICH ARE THE READING'S AND NOT THE BOOK FILE'S. A row names
     * its crop by NAME and the directory is composed from the bank the figures
     * were cut beside (`imagesDirFor`, electron/projects.ts) — the same
     * composition the pane serves them through. Passed only when it is there: the
     * engine refuses a directory it cannot open, and a book with no pictures in
     * it has none to be given.
     */
    const figures = imagesDirFor(request.readingsPath);
    if (existsSync(figures)) args.push('--images', figures);
    /*
     * AND THE RECORD THE PERSON TYPED, ON THE PACKAGE ITSELF. The bank route
     * takes its title from the PDF and has the metadata stamped on afterwards;
     * this route has no PDF to ask, so the merged patch reaches the book while it
     * is being made. The stamp still happens after it for an EPUB — the same two
     * commands, unchanged — and this is what makes a compiled `.txt` carry the
     * corrected title too, which nothing before could.
     */
    if (metadata['title'] !== undefined) args.push('--title', metadata['title']);
    if (metadata['creator'] !== undefined) args.push('--author', metadata['creator']);
    return args;
  }

  /*
   * ── RENDERING THE BOOK ───────────────────────────────────────────────────
   *
   * `--reuse-readings` IS THE FLAG THAT MAKES THIS FREE, and it is passed on
   * every generate without a switch anywhere that could turn it off. The bank is
   * complete — nothing reaches this branch until a reading has landed — and
   * without the flag the engine would treat a completed bank beside a marker as
   * a book to read AGAIN, which is three hours of GPU in answer to somebody
   * pressing a button labelled with a file format.
   */
  const args = [
    'vlm-convert',
    '--pdf', request.inputPath,
    '--out', request.outputPath,
    '--readings', request.readingsPath,
    '--reuse-readings',
  ];
  /*
   * ── AND THE TRANSLATION'S OWN WORDS, WHICH IS THE WHOLE OF THE SECOND STAGE ─
   *
   * A rendering standing under a translation used to be TWO spawns: this one into
   * a nameless EPUB in the temp directory, then `translate` reading that file and
   * writing the real one. It is one spawn and two flags now. `--records` puts the
   * translation's per-block answers into the blocks as the book is assembled, and
   * `--language` declares what comes out — a records file is a file of sentences
   * and does not say what language it is in, so without it `dc:language` and every
   * `xml:lang` would keep the source book's answer and the product would lie about
   * itself to every reader that asked.
   *
   * NOT TESTED FOR EXISTENCE, and that is deliberate. An absent records file means
   * the answers this product is MADE OF are gone, and a run that quietly wrote the book in its original language while the
   * row said Hungarian is the worst outcome available here. The engine refuses a
   * `--records` it cannot open, by name, and that refusal is the right one.
   *
   * THEY TRAVEL TOGETHER OR NOT AT ALL — `planRendering` composes both or neither
   * — so a book cast in a language it does not hold is not a state this app can
   * construct.
   */
  if (request.records !== undefined && request.records.length > 0) {
    args.push('--records', request.records);
    if (request.language !== undefined && request.language.length > 0) {
      args.push('--language', request.language);
    }
  }
  // Passed only when it is not the default, so an EPUB job's command line is the
  // one it has always been and a diff of two runs shows what actually differed.
  // The extension the plan chose already agrees with it; the engine
  // refuses the pair outright if it ever stops agreeing.
  if (request.kind !== 'epub') args.push('--format', request.kind);
  /*
   * ── AN EXPORT ASKS FOR THE EDITION, AND A GENERATE NEVER DOES ─────────────
   *
   * `generated/` is the workbench and `final/` is where a finished book is filed
   * (docs/WORKBENCH.md §8), and the two want different documents out of the same
   * bank. The cast keeps its marks because the person curating has to see what
   * they struck: a struck footnote is still in the book wearing `data-bf-cut`,
   * and every element still carries the attributes select mode addresses it by.
   * The edition has none of that — the struck note is not written, its reference
   * numbers keep the digit the page printed and lose their link, and the editing
   * attributes are not emitted at all.
   *
   * ONE FLAG, DECIDED OFF THE ONE FIELD THAT SAYS WHERE THE FILE IS GOING —
   * `export`, the same field `pump()` resolves into `exporting` for the rotation
   * and the landing. It is asked here of the REQUEST THIS FUNCTION WAS HANDED,
   * which is the stored one for every job except an export carrying a metadata
   * record: that one is handed a copy aimed at a temp file, and the copy carries
   * the flag exactly as the stored request does.
   *
   * A CAST'S COMMAND LINE IS UNTOUCHED: no `export`, no flag, and the engine's
   * default is the book it has always written.
   *
   * A TRANSLATED EXPORT GETS IT LIKE ANY OTHER, WHICH IT COULD NOT BEFORE. That
   * job used to be three runs — render, translate, then `epub-final` to tidy what
   * came back — because `translate` reads the very stamps this flag withholds
   * (FINAL_NEEDS_STAMPS, src/translate/book.ts), so the edition could only be made
   * AFTER the translation, from a finished book. Records are substituted at the
   * assembly, upstream of everything `--final` decides, so the edition and the
   * translation are made by one run and the tidy stage is gone.
   */
  if (request.export === true) args.push('--final');
  /*
   * NOTHING ELSE. `--skip-pages` and `--language` used to be here and are gone
   * from this branch: both are statements about READING the book, they were
   * answered when the pages were read, and a rendering that could be handed a
   * different page-skip from the reading it renders would be a rendering of a
   * book nobody read. `--strip-note-markers` went with them — it is BookForge's
   * narration flag and this app has never exposed it (see the OCR dialog).
   */
  return args;
}

/**
 * THE RECORD A PRODUCT SHOULD CARRY, or nothing at all.
 *
 * Two lines over `projectDirOf` and `metadataForProduct`: the module that knows
 * where a project's files live answers the question, and this is the bridge from
 * a path a job holds to that answer. A product outside every project — there is no such export today, and
 * the type system cannot say so — carries nothing, which is the honest answer for
 * a file with no ledger behind it.
 *
 * ASKED OF THE STEP THE JOB CAPTURED, never of the position now. A pointer move
 * made while an export waited in the queue must not change which corrections the
 * book that comes out of it carries — the same rule `readingsPath` obeys one layer
 * up, and `metadataInEffect` falls back to the position for a captured step that
 * has since been deleted.
 */
async function recordFor(
  outputPath: string,
  kind: ConversionKind,
  parentStep: string | null,
): Promise<Record<string, string>> {
  const dir = projectDirOf(outputPath);
  if (dir === null) return {};
  return metadataForProduct(dir, kind === 'pdf' ? 'pdf' : 'epub', parentStep);
}

/**
 * A merged patch as flags — `--title "…" --creator "…"`, in the order the engine
 * declares its fields.
 *
 * ONE LINE PER FIELD AND NO INTERPRETATION. Both metadata commands take exactly
 * this shape, and both refuse a blank value by name (an empty `dc:title` is a book
 * claiming to be called nothing) — so an empty one is dropped here rather than
 * turned into a failed export. `mergedMetadata` has already dropped them; this is
 * the second half of one rule stated where the command line is composed, because
 * this is the last place anything can still be wrong.
 */
function metaFlagsFor(record: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    flags.push(`--${field}`, value);
  }
  return flags;
}

/*
 * `withoutExport` USED TO LIVE HERE and went with the first stage of a
 * translate-descended export.
 *
 * That job was three runs: render the book into a nameless EPUB, translate it,
 * then tidy the translation into an edition. The middle run reads the very stamps
 * an edition withholds (FINAL_NEEDS_STAMPS, src/translate/book.ts), so the FIRST
 * run had to be handed a copy of the request with `export` taken off it — visible
 * to the settle that files the product, invisible to the `argsFor` that would have
 * asked the engine for an edition it was about to hand the translator.
 *
 * One run makes both now: the records go into the blocks at the assembly, upstream
 * of everything `--final` decides, so the stored request reaches `argsFor` exactly
 * as it was stored and there is nothing left to hide from anybody.
 */

/**
 * The endpoint this job will actually read through, or null when the run does
 * not go through one at all.
 *
 * The settings file's, and ONLY in `endpoint` mode. Under `auto` the engine
 * picks its own tier and may well choose `wsl-vllm`, which it serves for
 * itself — starting a server here because the file happens to hold a URL would
 * spend twenty gigabytes on a backend the run was never going to use.
 */
function endpointFor(): string | null {
  const settings = readSettings();
  if (settings.backend.mode !== 'endpoint') return null;
  return settings.backend.endpointUrl?.trim() || null;
}

/*
 * `starting` USED TO LIVE HERE, and the board is why it does not any more.
 *
 * It was a boolean, true from the moment `pump()` chose a row until its engine
 * child was recorded in `running` — because the reading server's wait sits
 * between those two points as an await, and it was the one window in which a
 * second `pump()` could see an empty slot, find the next queued job, and put two
 * engines on one card. A slot is taken at the moment of CHOOSING now, before any
 * await, so that window is closed by the occupancy that the next pump reads
 * anyway. One fact instead of two that had to agree, and one less variable for
 * an early-return path to leave set.
 */

/**
 * IS THERE ROOM FOR THIS RESOURCE RIGHT NOW — the whole of the rationing.
 *
 * ── The three answers, and why an install is not simply a third lane ────────
 *
 * A LANE has room when fewer than its slot count are held (`SLOTS`,
 * shared/queue-board.ts) and no install is running. An INSTALL needs the whole
 * board, because a conversion that starts against a Python being replaced is
 * the one failure the shared queue was built to prevent — see the header. And
 * `unscheduled` cannot get here from a queued row at all (a mint is born
 * `running`); it answers true so that a row which somehow arrived in that state
 * fails loudly through the missing-request branch, exactly as it did when the
 * pump took any queued row it found, rather than sitting in the list forever
 * and holding the drain open with it.
 */
function canStart(resource: JobResource): boolean {
  if (resource === 'unscheduled') return true;
  for (const slot of slots.values()) {
    // An install holds every lane while it runs, so nothing joins it.
    if (slot.resource === 'exclusive') return false;
  }
  if (resource === 'exclusive') return slots.size === 0;
  let held = 0;
  for (const slot of slots.values()) if (slot.resource === resource) held += 1;
  return held < SLOTS[resource];
}

/**
 * THE NEXT ROW THAT MAY START, or null when the board can take nothing.
 *
 * ── FIFO within a lane, and lanes do not queue behind each other ────────────
 *
 * The list is walked in QUEUE ORDER and the first startable row wins, so within
 * one lane the order is exactly the order somebody added the jobs in — no
 * priorities, nothing preempts, and releasing a batch is still a state change
 * rather than a reshuffle (`start`). A CPU job DOES pass a GPU job that is
 * waiting for the card, and that is the entire point of a board: they are not
 * waiting for the same thing, and making the cheap one wait for the expensive
 * one is what Wave 35 exists to end.
 *
 * ── AN INSTALL IS A BARRIER, AND THAT IS NOT AN OPTIMISATION ────────────────
 *
 * A queued install stops the walk whether or not it can start. Without that,
 * a stream of cheap CPU rows would step over it indefinitely — and every one of
 * them would be running against the environment the install is waiting to
 * replace. One serial queue gave "a conversion that needs the environment waits
 * BEHIND it" for free (header, 16e); on a board it has to be said, and this
 * line is where it is said.
 */
function nextStartable(): Job | null {
  for (const job of jobs) {
    if (job.state !== 'queued') continue;
    const resource = JOB_RESOURCE[job.kind];
    if (resource === 'exclusive') return canStart(resource) ? job : null;
    if (canStart(resource)) return job;
  }
  return null;
}

/**
 * ONE RUN'S TWO WIRES OUT — who holds its cancel, and who hears it talk.
 *
 * ── Why the executor takes these rather than deciding for itself ────────────
 *
 * `executeJob` is the whole of what a job DOES, and there are two callers with
 * two different answers to exactly two questions. `pump()` puts the live child in
 * the slot it took for this row on the board; `runJob` puts it in `detachedRuns`,
 * because it was scheduled elsewhere and must neither wait for a slot nor hold
 * one. `pump()` has nobody to report progress to beyond the row; `runJob` has a
 * caller that asked for the lines.
 *
 * EVERYTHING ELSE IS THE SAME CODE — the rotations, the server wait, the seeding,
 * the metadata stamp, the landings, the sweeps, the announcements. That is the
 * point of the split: a job the host scheduled and a job somebody pressed Start
 * on are the same job, and if this interface ever grows a third member that
 * changes what a run DOES, the split has gone wrong.
 */
interface RunWires {
  /**
   * The live engine child, the moment it exists — and the cancel that stops it.
   * Called ONCE per run: `handle` is reassigned for the metadata stamp and this
   * closure reads it, so the ✕ follows whichever engine is actually running.
   */
  claim(cancel: () => void): void;
  /** The last child has exited, whichever way. */
  release(): void;
  /** Every line the engine wrote, for a caller watching from outside the row. */
  watch?(line: string): void;
}

/**
 * THE SCHEDULER: fill every slot that can be filled, then say whether the board
 * has gone quiet.
 *
 * ── It starts as many as it can, where it used to start one ─────────────────
 *
 * This was `if (something is running) return;` followed by one row and one
 * `await`, and the await meant the scheduler's own call stack held the job for
 * its entire life. A board cannot work that way — two CPU rows have to be
 * started from ONE pass, or the second waits for the first — so the loop
 * dispatches and does not await, and `runInSlot` calls back here when its row is
 * over. The recursion is one level deep per ending, and every path through it is
 * `void`ed, because nobody has ever awaited this function.
 *
 * THE SLOT IS TAKEN INSIDE THE LOOP, SYNCHRONOUSLY, BEFORE THE NEXT LOOK. That
 * is the line the whole thing turns on: `runInSlot` reaches an await within
 * microseconds and would otherwise still be invisible when `nextStartable` ran
 * again, so the same row would be chosen twice and the same lane counted empty
 * twice. Reserving here rather than inside the run is also what let `starting`
 * be deleted.
 *
 * `queued` ONLY, which is the whole of the hold: a `held` job is invisible to
 * `nextStartable` until `start()` changes its state, so the gate is the data
 * rather than a flag every path through this function would have to consult.
 */
async function pump(): Promise<void> {
  for (;;) {
    const next = nextStartable();
    if (next === null) break;
    const slot: Slot = { id: next.id, resource: JOB_RESOURCE[next.kind], cancel: null };
    slots.set(next.id, slot);
    void runInSlot(next, slot);
  }

  /*
   * ── THE DRAIN, WHICH IS THREE FACTS AND HAS ALWAYS BEEN THREE FACTS ────────
   *
   * Nothing on the board, nothing waiting, and no live detached run. It used to
   * read as "no row could be chosen, and nothing is running" because a single
   * slot made those one question; on a board they are counted, and the count is
   * the same three facts it always was (docs/QUEUE-BOARD.md §3).
   *
   * TREAT ANY CHANGE HERE AS A CORRECTNESS CHANGE. The reading server's lifetime
   * follows the queue's (electron/vllm-server.ts) and `keepServerWarmMinutes`
   * DEFAULTS TO 0 — which is not a short timer, it is `stopServer` now, with no
   * window for a busy signal to beat it. An early drain therefore does not waste
   * a little warmth; it pulls twenty gigabytes out from under whatever is still
   * reading. On a board that hazard is LARGER than it was, because a CPU export
   * finishing while a GPU reading posts pages is now an ordinary Tuesday: the
   * export's ending calls this function, and if the test were "did I find
   * anything to start" the answer would be no and the server would go. It is not
   * that test. The reading holds its slot, `slots.size` is 1, and nothing is
   * declared.
   *
   * ── AND THIS QUEUE IS NOT THE ONLY QUEUE ────────────────────────────────────
   *
   * Under a host queue the internal list holds only what Foundry orders for
   * itself — the unattended exports a host asks for by name, and environment
   * installs — while every job a person pressed for is in the host's list and
   * arrives one at a time through `runJob`. So an empty board here is NOT the
   * machine going quiet, and the host says when its own queue has drained of
   * Foundry work (`hostQueueDrained`).
   *
   * WHICH IS WHY `runJob` ENDS WITHOUT PUMPING — see the essay at its return. If
   * it pumped, this would be reached between every pair of the host's rows and
   * would stop the reading server after each one. What still reaches here under a
   * host queue is the internal path going quiet: an environment install
   * finishing, or an export the host ordered by name.
   *
   * BOTH SIGNALS ARE SAFE TOGETHER, because busy always beats idle: every job
   * start says `noteQueueBusy` from inside `executeJob`, however it was
   * scheduled, and that cancels whatever countdown was armed. The `detachedRuns`
   * clause is what closes the one crossing a busy signal cannot cover, for the
   * `noteQueueIdle(0)` reason above: a live run holds the drain, whoever
   * scheduled it.
   *
   * A MINT HOLDS NOTHING AND HOLDS NO DRAIN, unchanged from before the board. It
   * takes no slot (`unscheduled`), it spawns no engine and it never addresses the
   * reading server, so a capture being assembled while the queue empties declares
   * drain exactly as it always did.
   */
  const waiting = jobs.some((job) => job.state === 'queued');
  if (slots.size === 0 && !waiting && detachedRuns.size === 0) {
    noteQueueIdle(readAppSettings().keepServerWarmMinutes);
  }
}

/**
 * ONE ROW, IN THE SLOT THE SCHEDULER ALREADY TOOK FOR IT.
 *
 * ── Why the slot is given rather than taken ─────────────────────────────────
 *
 * Because the taking is the scheduling. `pump()` reserved it before this
 * function existed for this row (see its loop), and handing it down means there
 * is exactly one place a slot can be claimed and exactly one place it can be
 * given up — the `finally` below, whichever way the row ended, including the
 * two early returns that used to each have to remember to pump.
 *
 * THE PUMP AT THE END IS THE ONE THAT USED TO SIT IN EVERY LANDING ARM (16f).
 * It is here rather than inside `executeJob` because `executeJob` is shared with
 * `runJob`, which must NOT pump — the essay at its return says why in full.
 *
 * THE SLOT OUTLIVES THE CHILD, DELIBERATELY. `release()` nulls the cancel when
 * the last engine child exits, but the slot itself is held through the landings
 * — the catalogue writes, the book file, the announcements — and is given up
 * only when the whole run returns. That is what the single slot did (the pump
 * did not look again until `executeJob` had returned), and it matters more now:
 * a lane freed at the child's exit would let the next row's rotation start
 * while the previous row's landing was still moving files in the same folder.
 */
async function runInSlot(job: Job, slot: Slot): Promise<void> {
  try {
    if (job.kind === 'env-install') {
      await runEnvInstall(job, slot);
      return;
    }
    const request = requests.get(job.id);
    if (request === undefined) {
      job.state = 'failed';
      job.error = 'The job lost its configuration before it started.';
      changed();
      settled(job);
      return;
    }
    await executeJob(job, request, {
      claim: (cancel) => { slot.cancel = cancel; },
      release: () => { slot.cancel = null; },
    });
  } finally {
    slots.delete(job.id);
    void pump();
  }
}

/**
 * RUN THIS JOB — the executor, and the whole of what a job DOES.
 *
 * ── What it is, and what it deliberately is not ─────────────────────────────
 *
 * It was the second half of `pump()` and it is a function because there are two
 * ways to decide that a job should run now: this app's own serial queue, and a
 * host's scheduler calling `runJob` (docs/PLAN.md, Wave 16). It does not choose,
 * it does not wait, it does not pump: it takes a row that is about to be running
 * and carries it all the way to its landing.
 *
 * NOTHING IN HERE ASKS WHO SCHEDULED IT. There is no host test in this function
 * or in anything it calls, which is what makes a hosted run and a standalone run
 * the same run — the two differences are the two members of `RunWires`.
 *
 * IT RETURNS WHEN THE ROW IS SETTLED, and the row itself is the answer: mutated
 * in place, exactly as it always was, so a caller can read `state` and `error`
 * off it afterwards. Nothing is thrown from here — an engine that refuses is a
 * `failed` row with the engine's own words on it, which is what every reader of
 * this queue already understands.
 */
async function executeJob(next: Job, request: EngineRequest, wires: RunWires): Promise<void> {
  /*
   * ── THE JOB THAT LANDS IN THE TRAY INSTEAD OF THE WORKSHOP ────────────────
   *
   * Everything below this line — the server wait, the spawn, the cancel, the
   * progress — is the same for an export as for any other rendering, because an
   * export IS a rendering (`planExport`). What it changes is the two ends: which
   * file the rotation moves aside, and what the settle records.
   *
   * DECIDED ONCE, HERE, because the narrowing that reaches `request.export` is
   * only available on a `GenerateRequest`, and three separate places re-deriving
   * it is three places for one of them to go on treating an export as a generate —
   * which would rotate the project's cast book aside to make room for a file that
   * is not going anywhere near it.
   */
  const exporting = request.kind !== 'read'
    && request.kind !== 'translate'
    && request.export === true;

  next.state = 'running';
  next.startedAt = Date.now();
  next.message = `Starting ${path.basename(next.inputPath)}…`;
  changed();

  /*
   * Whatever idle countdown was armed, a conversion is starting — and not only
   * an endpoint-mode one: under `auto` the ENGINE probes port 8000 for itself
   * and will happily read through a still-warm server this app owns, so a
   * timer allowed to keep ticking here could pull the backend out from under a
   * running book.
   *
   * BUSY STAYS FOUNDRY'S EVEN WHEN THE DECIDING IS NOT. It is said from in here
   * rather than from the scheduler above, so a job the host chose says it as
   * surely as one the pump chose — which is the half of the drain rule that does
   * not move when a host takes the queue over (`hostQueueDrained`).
   */
  noteQueueBusy();

  /*
   * The reading server, before the engine that will post pages to it. A remote
   * endpoint is used exactly as given — only the local one is ours to start.
   *
   * ONLY A READING WAITS FOR IT, and that is the whole rule. `vlm-read` is the
   * one job in this app that puts a page in front of a model; every other job
   * either uses a model this app does not own or uses none at all.
   *
   * A RENDERING READS NOTHING. `argsFor` passes `--reuse-readings` on every
   * conversion, without a switch anywhere that could turn it off, so the engine
   * replays the completed bank: it loads no model, opens no socket, and leaves
   * the bank byte for byte as it found it (`readings.ts`, `openReadingsBank`).
   * That is as true of a TRANSLATED rendering as of any other — the translation's
   * words come out of a file on disk, not out of a model. A translation's own
   * model is Ollama's, which this app does not start.
   *
   * This used to be worded as a list of exceptions — translate, and the piped
   * two-stage job — which meant a plain Generate still stood up twenty
   * gigabytes of vLLM and waited five minutes for a server it would never
   * address. Pressing a button labelled with a file format lit up the GPU, and
   * the shelf said "Starting the reading server…" over a job that is
   * arithmetic; the user reasonably read that as the model being run again.
   * The exceptions were the majority, so the rule is stated the other way
   * round: the job that reads waits, and nothing else does.
   */
  const endpoint = next.kind === 'read' ? endpointFor() : null;
  if (endpoint !== null && isLocalVllmEndpoint(endpoint)) {
    next.message = 'Starting the reading server…';
    changed();
    try {
      await ensureServer();
    } catch (err) {
      // The server's own log tail, whole. A conversion that failed because vLLM
      // ran out of VRAM must say so here, not "the engine exited 1".
      next.state = 'failed';
      next.error = err instanceof Error ? err.message : String(err);
      next.finishedAt = Date.now();
      changed();
      settled(next);
      return;
    }
    // Cancelled while the server was coming up — see `cancel`. Re-read rather
    // than test `next.state`, which the compiler still believes is 'running'.
    if (jobs.find((job) => job.id === next.id)?.state === 'cancelled') {
      return;
    }
  }

  /*
   * ── THE TWO INTERMEDIATES THAT USED TO BE HERE, AND WHY THEY ARE GONE ──────
   *
   * A Generate standing under a translation wrote a whole EPUB nobody asked for
   * into the OS temp directory, so that the second stage had something to read;
   * a translate-descended EXPORT wrote a second one, because the tidy that makes
   * an edition refuses an `--out` equal to its `--epub`. Both existed because a
   * translation was a FILE and the only way to get a translated book carrying
   * this position's decisions was to make the book and give it away.
   *
   * A translated book is CAST now — one `vlm-convert`, the records substituted
   * into the blocks as it writes, the edition rules applied by the same run — so
   * there is no half-book to name, no directory this app does not own to put it
   * in, and no stage between the engine and the product. What is left is the
   * ONE intermediate that has nothing to do with translation: the file a run
   * writes when a metadata record is going on afterwards, because both metadata
   * commands refuse to write over their own input.
   */
  /*
   * ── AN EXPORT CARRIES THE RECORD THE PERSON TYPED ─────────────────────────
   *
   * A metadata edit is a step, and the reason it had to become one is exactly
   * this: an export is cast fresh from the bank, the corrections went into the
   * OPF of a working tree, and the working tree is not one of a cast's inputs —
   * so a title corrected in the dialog was silently ABSENT from the book that
   * landed in `final/`. The chain of patches on this position's ancestry is
   * merged (`metadataForProduct`, electron/projects.ts) and applied to the
   * product as the last thing that happens to it.
   *
   * ── Why a stage after, and not a flag on the run that makes the book ──────
   *
   * `vlm-convert` builds the package from the bank and has no notion of a record
   * somebody typed a fortnight later; teaching it one would put the ledger inside
   * the engine. `epub-meta` and `pdf-meta` already do exactly this to a finished
   * file, are already how the dialog writes, and are the same two commands whose
   * refusals the user has already seen.
   *
   * ── Which makes AN intermediate, and it is not avoidable ──────────────────
   *
   * Both commands refuse to write over their input, and both are right to:
   * `pdf-meta` re-emits the whole document through pdf-lib, so an `--out` equal to
   * `--pdf` would destroy the file being read while it was being read. So the
   * engine aims here and the metadata stage lands the destination — which also
   * means a run that gets this far and then cannot stamp the record leaves NO file
   * in the tray, rather than one the user would reasonably believe carries their
   * corrections.
   *
   * NULL FOR EVERY GENERATE, and for an export whose ancestry recorded nothing.
   * `generated/` is the workbench and its casts are re-made constantly; stamping
   * one would be bookkeeping applied to a file nobody keeps.
   *
   * PLAIN TEXT CARRIES NO RECORD AT ALL and is skipped by name: a `.txt` has
   * nowhere to put a title, and there is no third command that would pretend
   * otherwise.
   */
  /*
   * THE PATCH ITSELF, READ ONCE. It used to be read straight into flags for the
   * stamping stage, which is still where it goes for an EPUB or a PDF — but the
   * COMPILE route puts the title and the author into the package as it writes it
   * (`argsFor`), because a book file has no PDF behind it to take a title from,
   * and a plain-text export has no stamping stage at all and therefore had no way
   * to carry a corrected title before this. One read of the ledger, two consumers,
   * and neither of them re-derives the other's answer.
   */
  const merged = exporting
    ? await recordFor(next.outputPath, request.kind, next.parentStep ?? null)
    : {};
  const record = exporting && request.kind !== 'txt'
    ? {
      // The command follows the PRODUCT and not the position: a facsimile export
      // takes the Info dictionary's four fields whatever kind of document the
      // project started from. Carried as the kind rather than read back off the
      // extension later, so the composition below names one fact once.
      kind: request.kind === 'pdf' ? 'pdf' as const : 'epub' as const,
      flags: metaFlagsFor(merged),
    }
    : null;
  /*
   * The file the engine writes when a record is going on afterwards — named for
   * the job under a `foundry` subdirectory of the OS temp directory, because a
   * temp folder is shared and files loose in it belong to nobody, and with the
   * product's own extension because both metadata commands read the format they
   * are given.
   */
  const unstamped = record === null || record.flags.length === 0
    ? null
    : path.join(os.tmpdir(), 'foundry', `${next.id}.unstamped${path.extname(next.outputPath)}`);
  if (unstamped !== null) {
    try {
      await fsp.mkdir(path.dirname(unstamped), { recursive: true });
    } catch (err) {
      next.state = 'failed';
      next.error = `The temporary folder for this job could not be made: ${(err as Error).message}`;
      next.finishedAt = Date.now();
      changed();
      settled(next);
      return;
    }
  }

  /*
   * ── THE PREVIOUS OUTPUT MOVES ASIDE **NOW**, and not a moment earlier ──────
   *
   * `generated/` is never overwritten: a second rendering of a book moves the
   * first into `generated/archived-<stamp>/` rather than replacing it. That
   * rotation used to happen when the job was PLANNED — before it was enqueued,
   * let alone run — and the new file was recorded only if the run succeeded. So
   * a rendering that failed, or was cancelled, or was removed from the queue
   * without ever starting, left the previous output in an archive folder with
   * the catalogue's chain pointing at it and nothing live at all. The row went
   * on listing and opening, and what it opened was silently the run before last,
   * forever.
   *
   * Here, the engine is the next thing that happens. The window between this
   * rename and the first byte written is one spawn — and even that window is
   * covered, because a settle that is not a success puts the rotation back
   * (`restoreRotation`), so the invariant is flat: A RUN THAT PRODUCES NOTHING
   * LEAVES THE CATALOGUE EXACTLY AS IT WAS.
   *
   * NEITHER OF THE TWO JOBS THAT WRITE INTO `readings/` ROTATES, and that is now
   * one rule rather than a reading's exception. A reading fills its BANK and a
   * translation fills its RECORDS; both live beside each other in a directory this
   * block has no business in, both are named per step so nothing is ever
   * overwritten, and both have the engine's own replace-on-success rule underneath
   * them (docs/BANK-LIFECYCLE.md §2). Rotating on their basename would move a file
   * out of `readings/` on the strength of a name that means something else there.
   *
   * THE TRANSLATION USED TO ROTATE, and losing that is losing nothing: what it
   * rotated was the EPUB it was about to overwrite, and it does not write an EPUB
   * any more. The self-overwrite case went with it — a re-translation into the
   * language a document already was named one path twice, so the run read the copy
   * the rotation had moved aside — because a records file is never also the book
   * being read.
   *
   * A refusal here fails the job with its own sentence. Both plans ask the same
   * question while the dialog is still on screen, so this is reached only when a
   * tab was opened on the previous output in between — which is the case only the
   * second answer can authorize.
   *
   * AN EXPORT ROTATES ITS OWN FOLDER, and getting this wrong would be the worst
   * outcome in the file. `rotateGenerated` takes a BASENAME and looks for it in
   * `generated/` — and an export of the book is called `<stem>.epub`, which is
   * exactly the name the project's cast book already has one folder over. Handed
   * to the wrong rotation, asking for a copy of your book would file the book
   * itself into an archive folder and unpack nothing in its place. So the layer
   * decides the rotation, off the one flag that was resolved above, and `final/`
   * gets its own pair (`rotateFinal` / `restoreFinalRotation`) rather than a
   * parameter on this one — the two put back different things.
   */
  let rotation: Rotation | null = null;
  let filedRotation: FinalRotation | null = null;
  let rotatedIn: string | null = null;
  if (request.kind !== 'read' && request.kind !== 'translate') {
    const projectDir = projectDirOf(request.outputPath);
    if (projectDir !== null) {
      rotatedIn = projectDir;
      try {
        if (exporting) {
          filedRotation = await rotateFinal(projectDir, path.basename(request.outputPath));
        } else {
          rotation = await rotateGenerated(projectDir, path.basename(request.outputPath));
        }
      } catch (err) {
        next.state = 'failed';
        next.error = err instanceof Error ? err.message : String(err);
        next.finishedAt = Date.now();
        changed();
        settled(next);
        return;
      }
    }
  }

  /*
   * ── A BRANCH'S RECORDS START AS A COPY OF ITS PARENT'S ────────────────────
   *
   * Here, and not at plan time, because this is the first moment the job is a
   * commitment rather than a row somebody can still remove: a held translation
   * that is deleted from the shelf must leave `readings/` exactly as it found it,
   * and a file seeded at the plan would sit there named by no step, invisible to
   * the sweep, forever.
   *
   * WHY A BRANCH WANTS ITS PARENT'S ANSWERS AT ALL: translating from a save made
   * under a translation branches, and a branch owns its own file — but an EMPTY
   * one would make that first run a full re-translation of a book that is already
   * translated. The rows are keyed by the blocks' own text, so the parent's
   * answers are exactly as true in the branch as they were at home: the stricken
   * blocks are never looked up, and only text somebody edited since is re-asked.
   *
   * AN EXISTING FILE IS NEVER OVERWRITTEN. A retried job has its own answers in
   * there by now and they are newer than the seed; a replace of a row that already
   * has records carries no seed at all.
   *
   * IT COVERS EVERY TRANSLATION, WHICH IS THE FIX. This copy used to sit inside
   * the stage loop of a two-stage Generate, so it ran for a branch ordered by
   * standing on a save and pressing Generate and NEVER for one ordered from the
   * Translate dialog — which set no seed in the first place. A dialog-ordered
   * branch therefore started empty and paid full model price for a book whose
   * translation was one row up. One rule, one spawn, both doors.
   */
  if (request.kind === 'translate'
    && request.seedRecords !== undefined
    && !existsSync(request.recordsPath)
    && existsSync(request.seedRecords)) {
    try {
      await fsp.mkdir(path.dirname(request.recordsPath), { recursive: true });
      copyFileSync(request.seedRecords, request.recordsPath);
    } catch (err) {
      console.error(`[job] could not seed ${request.recordsPath} from ${request.seedRecords}:`, err);
    }
  }

  /*
   * ── THE ONE RUN THIS JOB IS ───────────────────────────────────────────────
   *
   * It was one for everything this app queued except a Generate standing under a
   * translation, which was two: `vlm-convert` into a temp EPUB, then `translate`
   * out of it. A translated book is cast by the first of those alone now, so the
   * stage list, the loop that walked it and the `handle` reassigned between its
   * spawns are gone with it.
   *
   * AIMED AT THE INTERMEDIATE WHEN A RECORD IS GOING ON AFTER IT. `unstamped` is
   * non-null only for an export whose ancestry recorded metadata (see it, above,
   * for the whole argument), and both metadata commands refuse to write over their
   * own input. Everything else about this spawn is the request as it was stored —
   * the stored one is what the row, the rotation and the landing are about, and
   * only the child process sees this substitution.
   *
   * The `read` and `translate` arms are unreachable — neither is ever an export
   * and neither has a record to carry — and they are written out because the
   * alternative is a cast asserting that to the compiler, which is a promise
   * rather than a fact.
   */
  const spawned: EngineRequest = unstamped === null
    || request.kind === 'read'
    || request.kind === 'translate'
    ? request
    : { ...request, outputPath: unstamped };

  /*
   * ── THE LAST RUN: THE RECORD THE PERSON TYPED, PUT ON WHAT WAS MADE ───────
   *
   * `foundry epub-meta` or `foundry pdf-meta` over the finished product, into the
   * file the row is about. It is the same command the metadata dialog writes
   * with — the same refusals, in the same words, about the same fields — applied
   * to a book that has just been assembled out of a bank that never knew the
   * title had been corrected.
   *
   * SPELLED HERE RATHER THAN MADE A REQUEST SHAPE: the three shapes are what this
   * app QUEUES, each with a row, a landing and a settle, and this is a step inside
   * one job rather than a job. A fourth would have to be threaded through the
   * plans, the shelf and every settle path to be used in one place. The flags are
   * `metaFlagsFor`'s, which is one line and refuses to put an empty value on a
   * command line.
   *
   * NULL FOR EVERY JOB THAT IS NOT AN EXPORT WITH SOMETHING TO SAY, which is
   * nearly all of them.
   */
  const stamping: string[] | null = unstamped === null || record === null
    ? null
    : record.kind === 'pdf'
      ? ['pdf-meta', '--pdf', unstamped, '--out', next.outputPath, ...record.flags]
      : ['epub-meta', '--epub', unstamped, '--out', next.outputPath, ...record.flags];

  const watch = (line: string): void => {
    next.message = line;
    const progress = parseProgressLine(line);
    /*
     * A count clears the note; anything else becomes it. So `note` reads as
     * "what the engine has said SINCE the last count", which is empty on a run
     * that is simply progressing and full of exactly the right sentence on one
     * that is retrying, falling back, or naming a block it could not do.
     */
    next.note = progress ? null : line;
    if (progress) {
      // The rasterising pass finishes the instant reading starts: foundry draws
      // the whole book before it posts the first page, but a book with pages
      // skipped never reaches its own page count, so the render bar would stop
      // short of work it had actually finished.
      if (progress.phase === 'read' && next.progress?.phase === 'render') {
        next.progress = { ...next.progress, page: next.progress.total };
      }
      next.progress = progress;
    }
    changed();
    /*
     * AND OUT TO WHOEVER ASKED TO HEAR IT, after the row has been updated and
     * published. A caller watching from outside (`runJob`'s `onProgress`) is
     * reading the same lines the shelf is drawing, so it must not see one the
     * mirror has not been told about — and its throw is not this run's problem,
     * on `settled`'s rule: one listener's bug is not another's engine.
     */
    if (wires.watch !== undefined) {
      try {
        wires.watch(line);
      } catch (err) {
        console.error(
          `[queue] a progress listener threw for ${next.outputPath}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  /*
   * The command, once, before it runs.
   *
   * A failure that names a flag is only useful beside the flags it was given —
   * "--out and --format contradict each other" means nothing without the pair,
   * and the paths this app composes are exactly the ones nobody typed and
   * therefore nobody can check. One line, at the start, in the terminal that is
   * already open — and one PER RUN, because a job that is a spawn followed by a
   * metadata stamp is exactly the case where a single line would leave somebody
   * reading the wrong command.
   */
  const args = argsFor(spawned, merged);
  console.log(`[job] ${next.kind} ${args.join(' ')}`);
  let handle = runEngine(args, watch);
  /*
   * THE CANCEL FOLLOWS THE LIVE CHILD. `handle` is reassigned before the metadata
   * stamp and the closure reads it, so the ✕ kills whichever engine is actually
   * running rather than a child that has already exited — and whoever is holding
   * this run holds it across the gap between them, so no second `pump()` can slip
   * a job in beside this one and put two engines on one GPU.
   *
   * HANDED OUT RATHER THAN STORED, because the two schedulers hold it in two
   * places: the pump's serial slot, or `detachedRuns` for a run the host's queue
   * chose. See `RunWires`.
   */
  wires.claim(() => handle.cancel());

  let result = await handle.done;
  /*
   * ── AND THE RECORD, WHICH IS NOW THE LAST THING THAT HAPPENS ──────────────
   *
   * Only for an export whose ancestry recorded metadata, only when the run before
   * it succeeded, and it is what actually writes the file the row is about — the
   * engine wrote into the temp directory. `handle` is reassigned, so the ✕ still
   * kills the child that is running.
   *
   * A FAILURE HERE FAILS THE JOB, in the engine's own words, and that is the
   * conservative answer rather than the harsh one. The alternative is filing a
   * book in the tray and reporting success while the corrections the person made
   * are missing from it — which is the exact silence this whole unit exists to
   * end, reintroduced one stage later.
   */
  if (stamping !== null && result.code === 0) {
    next.message = 'Writing the record onto it…';
    next.note = null;
    changed();
    console.log(`[job] ${next.kind} ${stamping.join(' ')}`);
    handle = runEngine(stamping, watch);
    result = await handle.done;
  }
  // No child of this job's is alive from here on: the slot, or the detached
  // registry, gives it up. See `RunWires`.
  wires.release();
  next.finishedAt = Date.now();

  /*
   * THE INTERMEDIATE GOES NOW, whichever way this ended. A run that failed while
   * writing leaves a whole book in the temp directory, and the next one writes a
   * fresh one under its own job id — so keeping it would be hoarding half-books
   * nobody can name against a directory this app does not own.
   *
   * THERE USED TO BE THREE OF THEM: the untranslated cast a two-stage Generate
   * made for its translator, the untidied translation an export made for its
   * edition, and this one. Both of the others were the cost of a translation being
   * a FILE; a translated book is cast by the run that assembles it now, so the
   * only scratch file left is the one the metadata stamp reads, and it exists
   * because both metadata commands refuse to write over their own input.
   *
   * BEST EFFORT, AND NEVER A THROW. A leftover temp file is a console line; the
   * job it belonged to succeeded or failed on its own merits, and reporting three
   * hours of GPU as a failure because a scratch file would not unlink would be
   * the bookkeeping deciding what happened to the book. `force` so an
   * already-absent file — the ordinary case when the run never got that far — is
   * silence rather than an error.
   */
  if (unstamped !== null) {
    try {
      await fsp.rm(unstamped, { force: true });
    } catch (err) {
      console.error(`[job] the intermediate ${unstamped} could not be removed: ${(err as Error).message}`);
    }
  }

  // And the book main materialised for this export or this translation,
  // whichever way it ended — `sweepDerivedBook` carries the whole argument. It
  // is swept BEFORE the landings below and that is safe by construction: what
  // the run read is not what the landing writes, and the translation's own
  // derived book is built from the ledger and the records rather than from this
  // scratch copy of them.
  await sweepDerivedBook(request);

  if (result.code === 0) {
    next.state = 'done';
    /*
     * A READING LANDED, which is the moment the whole front door turns on.
     *
     * `recordReading` stamps the catalogue: when it finished, how many pages the
     * bank holds, and — through `generationForLanding`, the landing half of the
     * rule in shared/ledger.ts — the reading GENERATION every overlay and its
     * undo ledger are bound to.
     * That is why the mint belongs here rather than at the first correction: this
     * is the only moment anything in this app can honestly say a bank is a
     * different bank from the one that was there before.
     *
     * It also puts the light out on Home. A project with a scan and no reading
     * shows OCR as its waiting next step; from this line on, that project has
     * been read.
     */
    if (request.kind === 'read') {
      /*
       * NO CAPTURED PARENT GOES WITH IT, AND THAT IS NOT AN OVERSIGHT.
       *
       * `next.parentStep` is where the user was standing when they pressed Add,
       * and it is what a translation is filed against. A READING IS THE ONE
       * ACTION THAT IS NOT MADE FROM A STEP: it reads the pixels in `archive/`,
       * which `planReading` resolves for itself precisely because the document
       * the person was looking at may be a real-text reprint with none of the ink
       * in it. So its parent is the project's import, settled by what it read
       * rather than by where anybody was standing — see `originOf` in
       * shared/ledger.ts for what parenting it at the position would cost.
       */
      /*
       * WHAT IT ASKED FOR GOES WITH IT, THOUGH — which is the other half of the
       * same rule and the opposite conclusion.
       *
       * The parent is settled by what a reading READS; the identity is settled by
       * what it was ASKED. `--skip-pages` and `--language` are the whole of what
       * the OCR dialog lets somebody choose (`ReadRequest`), and they decide
       * whether the next reading of this book replaces this step or branches
       * beside it. Nothing on disk can answer that afterwards: a bank does not
       * record which pages it was told to leave out. So the job hands them over,
       * exactly as a translation hands over its `--to` rather than leaving the
       * language legible only in a filename.
       */
      /*
       * AND THE STEP THE BANK IS NAMED AFTER, which is the third thing that has
       * to survive the wait.
       *
       * A branching re-read writes `readings/<key>.<id8>.jsonl`, and that `id8` is
       * the front of the step's uuid — minted at the plan, before the row even
       * appeared in the shelf, because the engine is handed one path and fills it
       * for three hours. Minting a fresh id here would leave the bank named after a
       * step nobody created. It is spent only if this lands as an append; a replace
       * swaps into the step that is already there and throws it away.
       */
      await recordReading(
        next.outputPath,
        {
          ...(request.skipPages !== undefined ? { skipPages: request.skipPages } : {}),
          ...(request.language !== undefined ? { language: request.language } : {}),
        },
        request.stepId,
      );
      next.message = `Read ${path.basename(next.inputPath)} — the answers are banked.`;
      changed();
      /*
       * ── AND THE ONE DOCUMENT THE BANK IS FOR, WHICH IS NOT A STEP ────────────
       *
       * The book file, recorded as this reading's product (docs/RENDERER.md §6).
       *
       * IT IS AWAITED AND IT CANNOT FAIL THE READING. Every way it can go wrong
       * is a console line inside it: the bank is on disk, it is complete, and the
       * reflow is made from it for nothing whenever it is asked for.
       *
       * TWO OTHER LINES USED TO BE HERE AND BOTH ARE GONE. `ensureCast` cast the
       * project's flowing book — an EPUB in `generated/` that the app unpacked so
       * a pane had files to show — and the pane reads the book file directly now
       * (docs/RENDERER.md §7). The facsimile was the other, and it left for a
       * different reason: it was protecting a reading against a re-read that could
       * take its answers away, and banks are kept now, so the protection is the
       * bank and the reprint is something a person asks for.
       */
      await landReadProducts(next.outputPath, next.inputPath);
      return;
    }
    /*
     * ── A TRANSLATION LANDED, AND WHAT IT LEFT IS ANSWERS ────────────────────
     *
     * The same shape as the reading above it, which is the shape it should always
     * have had: this run produced no document at all. It wrote
     * `readings/<key>.<tag>[.<id8>].records.jsonl` — one row per flowing block —
     * and the step that keeps what those hours cost names THAT file as its payload
     * (`recordTranslation`, electron/projects.ts), exactly as a read step names its
     * bank.
     *
     * IT USED TO GO THROUGH `recordGenerated`, because the product was an EPUB in
     * `generated/` and that function is where a finished document is catalogued.
     * Nothing about a records translation fits there: there is no document to put
     * on a type's chain, nothing to promote to the project's live PDF, and the file
     * is not in `generated/` at all — the landing would have refused it by name.
     *
     * THE ONE FACT THE JOB HANDS OVER is the one nothing on disk can answer
     * afterwards: which language was asked for. Reading it back out of a filename
     * is what this codebase's oldest house rule forbids, so the job that asked says
     * which. WHETHER THIS WAS A CHAIN IS NOT HANDED OVER, deliberately: it is a
     * fact about the row this step hangs from, the landing is holding the ledger,
     * and this request's `--from` is also where a person's typed guess about an
     * untranslated book's language goes (`recordTranslation` argues it in full).
     *
     * AND THEN THE BOOK, WITHOUT BEING ASKED. A records file is not a thing a
     * person reads, so the row would have nothing to show until somebody ordered a
     * rendering by file format — which is the exact gap the automatic cast after a
     * reading was built to close, one action later. It is the same cast: free,
     * offline, seconds, and fired and forgotten so that a translation that landed
     * is never reported as a failure because the book after it could not be planned.
     */
    if (request.kind === 'translate') {
      await recordTranslation(next.outputPath, {
        parentStep: next.parentStep ?? null,
        language: request.to,
        ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
        /*
         * AND WHICH REWRITE, WHEN IT WAS ONE — the second fact nothing on disk can
         * answer, for the language's own reason. The step's params are what
         * `labelFor` reads to say "Simplified — natural voice (de)" and what
         * `reRunTarget` compares hours from now, so a mode that stopped here at
         * the command line would leave a row calling itself a translation and a
         * second rewrite in another mode swapping its answers into it.
         */
        ...(request.rewrite !== undefined ? { rewrite: request.rewrite } : {}),
      });
      next.message = request.rewrite === undefined
        ? `Translated ${path.basename(next.inputPath)} — the book follows.`
        : `Simplified ${path.basename(next.inputPath)} — the book follows.`;
      changed();
      /*
       * AND THE BOOK OF IT, WHICH IS THE PART THAT IS NOT A RENDERING. *"When a
       * translate lands, main materializes parent book file + chain ops + records
       * → readings/<key>.<lang>.book.jsonl."* (docs/RENDERER.md §4.) It is made
       * HERE, at the landing, rather than at the first open, for the reason every
       * derived file in this app is made where its inputs are known to be
       * settled: the records have just been written, the step naming them exists,
       * and the row the translation was made FROM is what the book is materialised
       * over — a fact about the ledger that is answered once, now, rather than
       * re-derived by every pane that ever draws this step.
       *
       * AND IT IS THE ONLY ONE NOW. There was a cast after this — an EPUB made
       * from the records so the old viewer had a file to open — and standing on a
       * translate row shows the derived book on the proof sheet instead, which is
       * the document this line writes. It is not fatal to a landing that has
       * already put hours of GPU safely on disk, and it says so in the terminal
       * in its own words.
       */
      await materializeTranslation(next.outputPath);
      settled(next);
      return;
    }
    /*
     * ── AN EXPORT IS FILED AND NOTHING ELSE HAPPENS TO IT ─────────────────────
     *
     * `recordGenerated` below does three things to a finished rendering: it puts a
     * step on that type's chain, it can promote the result to the project's live
     * PDF, and it announces the library. Every one of those is about a document
     * OTHER WORK WILL BE MADE FROM, and an export is the one rendering in this app
     * that nothing is ever made from — the user's ruling, verbatim: "it wont go
     * into the working files as a step because it isnt the base for new steps. its
     * a terminal step. so its an export."
     *
     * So the landing is one row in the tray. `recordFinal` never throws and
     * announces the library itself, which is what puts the export under its project
     * in the left nav; the tab opens itself from the shelf exactly as a Generate's
     * does (`OPENS_ITSELF`), because somebody who asked for a book wants to look at
     * it. No documents row, no ledger step, no live-PDF refresh, and no rotation to
     * undo beyond the one `rotateFinal` already made.
     */
    if (exporting) {
      /*
       * THE STEP THE JOB CAPTURED GOES INTO THE TRAY ROW, so that a host reading
       * `project.json` afterwards learns what a host listening at this instant
       * learns from the announcement below. `next.parentStep` is where the person
       * was standing when they pressed Export — held all along so a pointer move
       * during the wait cannot change which corrections the book carries — and it
       * is the same value both halves record, out of one variable, because two
       * derivations of one provenance is how the event and the catalogue come to
       * disagree.
       */
      const madeFrom = next.parentStep ?? null;
      await recordFinal(next.outputPath, madeFrom);
      const filed = path.basename(next.outputPath);
      next.message = `Wrote ${filed}`;
      changed();
      /*
       * ── AND WHOEVER IS HOSTING US IS TOLD, LAST ───────────────────────────
       *
       * After the file is in `final/` and after the tray has recorded it, so a
       * host that files this into a versions list is describing something that
       * exists on disk and is already in the catalogue this app would answer
       * with. Announcing it any earlier would be inviting the host to race the
       * manifest.
       *
       * THE NAME IS THE ONE THE SHELF JUST SAID. A version row and a job row are
       * two views of one landing, and a second derivation of "what to call it"
       * is how the two come to disagree about what was made.
       *
       * A THROW HERE MUST NOT REACH THE SETTLE. The work is done — hours of it,
       * sometimes — and a host whose handler has a bug in it does not get to
       * turn a landed export into a failed job. `mountFoundry` catches it too,
       * and this is the second catch rather than the same one written twice: a
       * listener registered by anything else — a test, a future caller — reaches
       * this line and not that one.
       */
      const projectDir = projectDirOf(next.outputPath);
      if (projectDir !== null) {
        try {
          exportLanded({
            projectDir,
            path: next.outputPath,
            kind: request.kind,
            title: filed,
            // See `ExportLanding.stepId`: absent for a job with no position
            // behind it, which a host must read as "unknown" and not as "none".
            ...(madeFrom !== null ? { stepId: madeFrom } : {}),
          });
        } catch (err) {
          console.error(
            `[queue] the export-landed listener threw for ${next.outputPath}: `
            + `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      /*
       * AND ANYBODY WAITING ON THIS JOB IS TOLD AFTER THE HOST IS, which is the
       * ordering `onJobSettled` promises rather than an accident of where the
       * line sits. A waiter watching for the landing of this file has to have
       * SEEN that landing before it hears the job is over, or it would read a
       * successful export as an ending with nothing in it.
       */
      settled(next);
      return;
    }
    /*
     * ── A STEP'S OWN DOCUMENT IS FILED NOWHERE, AND THAT IS THE POINT ────────
     *
     * It is a RENDERING of a payload that is already a step — the snapshot in
     * `curations/` for a save, the records in `readings/` for a translation, the
     * BANK for a reading's facsimile — so it is free to make again and there is
     * nothing here for a catalogue to own. Cataloguing it would do active harm
     * rather than merely being redundant: Home's document rows would grow one
     * entry per landing, and the
     * facsimile would land on the PDF's chain beside the scan and be offered as the
     * document this app edits.
     *
     * Which leaves the file's disposal, and it is not left to chance: the step
     * delete composes the same name and sweeps it, along with any working tree
     * unpacked from it (`planStepSweep`).
     *
     * NO LEDGER STEP EITHER, for the reason above it: the step this is the document
     * of already exists, and minting a second one for the rendering would put a
     * filename where an action belongs.
     *
     * THE SENTENCE FOLLOWS THE PRODUCT, because these two are not the same thing to
     * the person reading the shelf: one is the book at a row in the history, the
     * other is the pages of a reading reprinted. Decided off the format, which is
     * the whole of the difference — a per-step cast is an EPUB and a facsimile is
     * the only PDF this app ever makes with a step on it.
     */
    if (request.forStep !== undefined) {
      next.message = request.kind === 'pdf'
        ? 'The facsimile of those pages is ready.'
        : 'The book at that step is ready.';
      changed();
      settled(next);
      return;
    }
    /*
     * The catalogue learns about the origin HERE, when it exists.
     *
     * Not at plan time, which is only an intention: a run that dies at page 200
     * would leave `project.json` listing a book Home would then offer and
     * nothing could open. `recordGenerated` never throws — a row it could not
     * write is a named console line, because losing a catalogue entry is not a
     * reason to report three hours of GPU as a failure.
     *
     * ONE ARGUMENT LIGHTER THAN IT WAS, and the whole of the difference is that a
     * translation does not come through here any more. This call used to carry the
     * language, the bank and the step id, because the run that produced a
     * translation ended in `generated/` and its landing was a ledger step; a
     * records translation lands where its answers land (`recordTranslation`), and
     * what reaches this function from a translated position is the BOOK cast from
     * those records — which carries `forStep` and returns above, uncatalogued.
     *
     * The REQUEST's kind, not the job row's: `JobKind` also admits `env-install`,
     * which never reaches this branch but which the compiler cannot know that
     * about, and a cast here would be a promise made to the type system rather
     * than a fact. The request is the narrower shape — narrowed by the two arms
     * above, which return — and it is the same decision.
     *
     * ── A BOOK MADE OF A TRANSLATION'S WORDS IS FILED AS A TRANSLATION ────────
     *
     * `records` is the whole test, and it has to be here rather than implied. The
     * roles are not four names for one thing: a `cast` sitting directly in
     * `generated/` used to be THE PROJECT'S FLOWING BOOK, which every read row and
     * save row resolved to. So a
     * Hungarian book filed as a cast would quietly become what the German rows
     * show — the exact confusion the per-step cast was built to end, arrived at
     * from the other side.
     *
     * The old two-stage pipeline said this same sentence about its own second
     * stage (`piped !== null ? 'translation'`). There is no second stage now; what
     * makes a rendering a translation is that the words in its blocks came out of
     * a records file, and that is one field on the request.
     */
    const live = await recordGenerated(
      next.outputPath,
      request.records !== undefined ? 'translation' : generatedRoleFor(request.kind),
    );
    /*
     * WHERE THE FINISHED ROW POINTS, when the catalogue made a live copy of what
     * the engine wrote. Everything downstream reads `outputPath`: the tab that
     * opens itself when the run lands, and the shelf's Reveal — and both of them
     * want the file the user is meant to have, not the bookkeeping original.
     *
     * Nothing promotes a conversion to the live PDF today (`recordGenerated`),
     * so this is inert and kept rather than deleted: the branch costs a
     * comparison, and the alternative is a queue that silently points at the
     * wrong file the first time something is promoted again.
     */
    if (live !== null) next.outputPath = live;
    // Said after the row settles on its final path, so the line names the file
    // the Reveal button will actually show.
    next.message = `Wrote ${path.basename(next.outputPath)}`;
  } else if (result.code === -1) {
    next.state = 'cancelled';
    next.message = 'Cancelled.';
    // Nothing was written, so nothing moved: the previous output comes home and
    // the chain points back at it. See `restoreRotation` for what "nothing" has
    // to include — the file, the working tree, and both of their catalogue rows.
    // The tray obeys the same invariant through its own receipt: a cancelled
    // export leaves the document somebody filed earlier exactly where it was.
    await putBack(rotatedIn, rotation, filedRotation);
  } else {
    next.state = 'failed';
    await putBack(rotatedIn, rotation, filedRotation);
    // foundry's own stderr is the message a user needs — it names the missing
    // Python, the model it could not load, the page it choked on. Never
    // paraphrased, and never replaced with an exit code.
    next.error = result.stderr.trim() || `The engine exited ${result.code} with nothing to say.`;
    /*
     * AND IT GOES TO THE CONSOLE, WHOLE.
     *
     * Until now a failure existed in exactly one place a person could reach: a
     * tooltip on one row of the shelf. So a job that failed while the window
     * was reloading, or whose row was cleared, took its only account of itself
     * with it — which is precisely what happened twice tonight, and the second
     * time there was nothing left to read at all.
     *
     * The terminal running the app is where somebody is already looking when
     * something goes wrong, it survives every reload of the window, and it can
     * be scrolled back and copied. The full stderr rather than a summary: the
     * lines above the failure are usually the context that explains it, and
     * this is a diagnostic rather than a notification.
     */
    console.error(
      `\n[job] ${next.kind} FAILED — exit ${result.code} — ${path.basename(next.inputPath)}\n`
      + `${next.error}\n`,
    );
  }
  changed();
  // The three arms above return before this line, each saying it for itself
  // after whatever that landing produced; what reaches here is a cancel, a
  // failure, and the rendering whose landing is a catalogue row.
  settled(next);
}

/**
 * RUN THIS JOB NOW, BECAUSE SOMEBODY ELSE'S SCHEDULER SAYS SO — the second door
 * onto `executeJob`, and the mount seam's own (electron/mount.ts).
 *
 * ── What it is for ──────────────────────────────────────────────────────────
 *
 * A host that keeps its own queue (`FoundryHostQueue`) takes over the DECIDING
 * and nothing else. Its pump reaches this: here is a request, here is the
 * position it was ordered from, run it. There is no waiting, no hold, no place
 * in this app's list — the waiting already happened, in a list this app cannot
 * see, and asking a person to press Start twice would be the hold applied to a
 * commitment somebody already made.
 *
 * ── IT STILL MINTS A ROW, AND THAT IS THE LOAD-BEARING PART ─────────────────
 *
 * The obvious shortcut — spawn the engine, resolve — would break the host's own
 * narrate. A ROW is what carries `parentStep` into the landing, what
 * `onExportLanded` is composed from, what `onJobSettled` publishes, what
 * `exportEpubFromStep` awaits, and what the delete guards and `foundryBusy` count
 * when somebody asks whether a folder is safe to erase. So a job the host
 * scheduled gets exactly the same row a job somebody pressed for gets — born
 * `running`, because that is the one thing that is genuinely different about it.
 *
 * ── The answer is the ROW, and it is the row for a reason ───────────────────
 *
 * Two written contracts disagreed here before either side built against them: a
 * `Settled` type that does not exist in this codebase, and a `{ok} | {ok,error}`
 * result reasonably derived from it. BOTH ARE WRONG THE SAME WAY — neither can
 * say CANCELLED. `JobState` (shared/types.ts) distinguishes `done`, `failed` and
 * `cancelled` deliberately: a cancel is somebody spending GPU and then taking it
 * back, not a failure, and filing one as a failure is how a host's retry restarts
 * work a person just stopped. The row already spells all three, plus the engine's
 * own words in `error` — and it is the very shape the host mints going in and
 * pushes back through `setHostQueueRows`, so there is ONE account of what happened
 * rather than two that can drift.
 *
 * IT RESOLVES RATHER THAN REJECTS, whatever the state. A failed run is not an
 * exception here: it is a fact about a row, reported the way this queue has always
 * reported it.
 */
export async function runJob(
  request: EngineRequest,
  opts: {
    /**
     * The project's position at the moment the person pressed — carried by the
     * host from its own `enqueue` and handed straight back, never re-read here.
     * `Job.parentStep` holds the whole argument: a pointer that moves while a row
     * waits must not change what the run is recorded as being made from, and
     * hosted the waiting is longer, not shorter.
     */
    parentStep?: string | null;
    /** Every line the engine writes, as it writes it. The row gets them too. */
    onProgress?: (line: string) => void;
    /**
     * STOP THIS RUN — mapped onto exactly what the ✕ does to a running job.
     *
     * It is `cancelHere` and not `cancel`, deliberately: this row is Foundry's
     * own, and a cancel that routed would hand our id to the host's list, which
     * has never heard of it, while the engine went on reading. An abort that
     * arrives before the child exists is the same gesture the shelf makes on a
     * job waiting for the reading server — the row settles `cancelled` and the
     * run notices at the next checkpoint.
     */
    signal?: AbortSignal;
  } = {},
): Promise<Job> {
  const parentStep = opts.parentStep ?? null;
  /*
   * THE ROW, BORN RUNNING. Every field is composed exactly as `enqueueHere` and
   * `enqueueTranslate` compose theirs — the same output identity (asked of
   * `productOf`, which all three now share rather than each spelling as much of
   * the rule as its own argument type could reach), the same rewrite title, the
   * same `forStep` — because a row is what the shelf, the landings and the guards
   * all read, and a second way of building one would be a second answer to what a
   * job is.
   *
   * NO DEDUPE, and that is the one deliberate difference. `enqueueHere` hands
   * back an existing row rather than let two runs write one file, and that rule
   * belongs to whoever is SCHEDULING: a host with its own queue has already
   * decided that this should run now, and answering "no, have this other row
   * instead" would be Foundry overruling a decision it was told about rather than
   * asked for. What protects the file is the same thing that protects it there —
   * one scheduler.
   */
  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: productOf(request),
    kind: request.kind,
    state: 'running',
    progress: null,
    ...(request.kind === 'translate' && request.rewrite !== undefined
      ? { title: `Simplify — ${REWRITE_LABELS[request.rewrite]}` }
      : {}),
    ...(request.kind !== 'read' && request.kind !== 'translate' && request.forStep !== undefined
      ? { forStep: request.forStep }
      : {}),
    parentStep,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();

  /*
   * THE ABORT IS ARMED BEFORE THE RUN, not inside it, so a signal that is already
   * aborted — or that fires while the reading server is coming up, minutes before
   * there is a child to kill — reaches the same `cancelHere` the ✕ reaches. The
   * listener is dropped in `finally`: a host that keeps one controller per row
   * would otherwise leave this queue holding a reference to every row it ever ran.
   */
  const abort = (): void => { cancelHere(job.id); };
  opts.signal?.addEventListener('abort', abort, { once: true });
  /*
   * A SIGNAL THAT WAS ALREADY ABORTED SPAWNS NOTHING, and it is worth the four
   * lines: a host whose user cancelled between its own pump choosing this row and
   * this call arriving would otherwise get a full engine run out of a request it
   * had already withdrawn. The row is settled `cancelled` by the same gesture the
   * ✕ makes and handed straight back, so the answer is the honest one rather than
   * a run nobody wanted.
   */
  if (opts.signal?.aborted === true) {
    abort();
    opts.signal.removeEventListener('abort', abort);
    return copyOf(job);
  }

  try {
    await executeJob(job, request, {
      /*
       * OFF THE BOARD, which is `detachedRuns`' whole argument: this run was
       * scheduled by somebody who cannot see the board, so it must neither wait
       * for a slot nor hold one. The internal queue goes on doing its own work
       * beside this — an environment install, an export the host asked for by
       * name — and one machine's GPU has one owner because the HOST is scheduling,
       * not because this file is rationing two lists it cannot compare.
       */
      claim: (cancel) => { detachedRuns.set(job.id, cancel); },
      release: () => { detachedRuns.delete(job.id); },
      ...(opts.onProgress !== undefined ? { watch: opts.onProgress } : {}),
    });
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    detachedRuns.delete(job.id);
  }
  /*
   * ── AND IT DOES NOT PUMP, WHICH IS THE LINE THE READING SERVER LIVES ON ────
   *
   * Every other ending in this file calls `pump()`, because every other ending is
   * a slot coming free. This one is not: a detached run never took a slot, so
   * nothing on the board was ever waiting on it — an install or a host-ordered
   * export enqueued while this ran started immediately, on its own enqueue's
   * pump, subject only to the board's own occupancy.
   *
   * WHAT A PUMP HERE WOULD DO IS STOP THE READING SERVER. `pump()` declares drain
   * in its nothing-to-do branch, the internal list is empty between every pair of
   * the host's rows, and `keepServerWarmMinutes` defaults to 0 — which is an
   * immediate `stopServer`, not a countdown. A batch of ten readings would pay ten
   * model loads for a queue that never actually went quiet. Drain hosted is the
   * host's to declare, once, when its own pump has nothing left
   * (`hostQueueDrained`).
   */
  return copyOf(job);
}

/**
 * Whichever rotation this job made, undone — because the run wrote nothing.
 *
 * ONE CALL AT BOTH SETTLES, and the two receipts are deliberately separate types
 * rather than one with a layer field on it. What a `generated/` rotation has to
 * put back is a file, a working tree, a step's location in a chain and that tree's
 * catalogue row; what a `final/` one has to put back is a file and a row. A shape
 * that carried both would be half-empty at every call site and would invite a
 * restore that reached for a working tree an export never had.
 *
 * At most one of them is ever non-null: `pump()` chooses the rotation by the same
 * flag that chooses the landing, so this reads as "put back whatever happened".
 */
async function putBack(
  dir: string | null,
  rotation: Rotation | null,
  filed: FinalRotation | null,
): Promise<void> {
  if (dir === null) return;
  if (rotation !== null) await restoreRotation(dir, rotation);
  if (filed !== null) await restoreFinalRotation(dir, filed);
}

/**
 * Everything `bookAtPosition` answers, named once so the two halves of a read
 * landing hand each other one shape rather than five arguments. Inferred rather
 * than declared, because the shape is electron/projects.ts's and a copy of it
 * here would be a second declaration of somebody else's answer.
 */
type BookAtPosition = Awaited<ReturnType<typeof bookAtPosition>>;

/**
 * A READING LANDED, SO ITS ONE DOCUMENT CAN EXIST — the book file. It is not a
 * step; it is recorded as this reading's product (docs/RENDERER.md §6).
 *
 * ── WHICH READING, PROVEN RATHER THAN ASSUMED ───────────────────────────────
 *
 * `recordReading` has just stamped the catalogue and left the pointer standing on
 * the row it landed — a read is not retained beside you (`RETAINED_BESIDE_YOU`),
 * and a replace swaps into the step it re-ran and stands there too — so
 * `bookAtPosition` reads back exactly the reading this job just made: its bank,
 * the language it was asked in, and the archived pages the figures are cut out
 * of — a document or a folder of photographs. That is one source for facts that
 * would otherwise be composed
 * here from a request and a filename.
 *
 * AND IT IS CHECKED, because `recordReading` NEVER THROWS. A catalogue it could
 * not write is a console line of its own and a bank that is still on disk — and
 * the position then still names the reading BEFORE this one, whose book file is
 * about a different pass over the pages. Remaking that would quietly re-cut
 * another reading's figures on the strength of this run finishing. So the two
 * answers are put side by side: the position must name a reading at all, and that
 * reading's bank must be the file this run filled. Anything else is a sentence in
 * the terminal and nothing touched — which is a refusal, not a fallback: there is
 * no second guess at which reading this is, and the reflow stays as it was until
 * somebody opens the book, which ensures it (`loadBook`).
 */
async function landReadProducts(bankPath: string, readFrom: string): Promise<void> {
  const dir = projectDirOf(bankPath);
  if (dir === null) {
    console.error(`[job] ${bankPath} was filled outside any project, so no book file was made `
      + 'from it.');
    return;
  }
  let at: BookAtPosition;
  try {
    at = await bookAtPosition(dir);
  } catch (err) {
    console.error(
      `[job] the reading of ${path.basename(readFrom)} landed, but ${dir} could not say which `
      + `reading is in effect (${err instanceof Error ? err.message : String(err)}), so no book `
      + 'was made from it.',
    );
    return;
  }
  if (at.reading === null || !samePath(at.bank, bankPath)) {
    console.error(
      `[job] the reading that filled ${bankPath} is not the one ${dir} now stands on `
      + `(${at.reading === null ? 'no reading is recorded there' : at.bank}), so nothing was `
      + 'remade from it — the bank is complete and the book is free to make from it whenever it '
      + 'is asked for.',
    );
    return;
  }
  await remakeBookFile(at);
}

/**
 * THE BOOK FILE, REMADE BECAUSE THE READING LANDED — the one door the contract
 * allows to rebuild one, taken as an announced action.
 *
 * ── Why it overwrites, and why that is the safe direction ───────────────────
 *
 * A book file is a pure function of the receipt (docs/BOOK-FILE.md §1) and is
 * regenerated ONLY deliberately, never silently on open, because ops are keyed to
 * the ids in it. This is the deliberate moment: a NEW BANK has just landed at this
 * path, so a book file sitting beside it is the reflow of answers that no longer
 * exist — stale by definition, and the loader would refuse it by name on the next
 * open (`bankSha`, electron/book.ts). Rebuilding it here is what turns that
 * refusal into a book somebody can read, and the log line is the announcement §2
 * asks for.
 *
 * THE FIGURES COME WITH IT AND ARE NOT THIS SIDE'S BUSINESS. The archived
 * original is passed as `--pdf` and the engine sweeps `readings/<key>.images/`,
 * re-cutting only the pages that carry Picture blocks (src/vlm/book-run.ts). A
 * project whose original is an EPUB has no pages to cut and the engine says so —
 * an ordinary answer, not a hole.
 *
 * THE PAGES FACE WAS WAVE 37 AND IS GONE FROM THIS SIDE AT WAVE 41. It was a
 * real hole: this call passed `--pdf` or nothing, so a captured project — whose
 * archive was a FOLDER — landed its reading and reflowed with no source at all,
 * cutting none of its figures; the book was valid, opened fine, and refused every
 * picture at export months later. Wave 37 gave the engine `--pages` to close it;
 * Wave 41 closed it one layer further back, by making a captured project's
 * archive a PDF, so both faces of this call are one face again.
 *
 * A REFUSAL IS THE ENGINE'S OWN WORDS TO THE TERMINAL AND NOTHING ELSE. The bank
 * is real, it is complete, and it is what those hours bought; reporting the
 * reading as a failure because the reflow after it would not run would be this
 * app calling somebody's GPU time lost over a file it can make again in seconds.
 * The next open of the book makes it (`loadBook`), which is the same command with
 * the same arguments.
 */
async function remakeBookFile(at: BookAtPosition): Promise<void> {
  console.log(
    `[job] the reading landed, so ${at.book} is being remade from ${at.bank}`
    + `${at.pdf === null ? ' (nothing archived to cut figures from)' : ''}.`,
  );
  const made = await writeBookFile(at.bank, at.book, {
    pdfPath: at.pdf,
    language: at.language,
  });
  if (!made.ok) {
    console.error(
      `[job] ${at.bank} could not be reflowed into ${at.book}: ${made.reason ?? ''}\n`
      + 'The bank is complete and the reading stands; opening the book makes it again.',
    );
  }
}

/**
 * The env-install branch, holding the WHOLE BOARD rather than one lane of it.
 *
 * ── Why it is exclusive, in one line each ───────────────────────────────────
 *
 * It replaces the Python every other job spawns, so nothing may run beside it;
 * it is a download and a disk, so it does not belong to a lane; and a conversion
 * that needs the environment must wait behind it, which is the whole reason an
 * install is in this queue at all (the header, and 16e). `canStart` is where
 * those three become a rule; this function is just the work.
 *
 * IT TAKES THE SLOT IT WAS GIVEN, exactly as `executeJob` does — the cancel goes
 * into the slot the scheduler already reserved, and `runInSlot`'s `finally` gives
 * it up. It used to set the serial slot and clear it itself, and it used to pump
 * on the way out of both endings; both of those now happen in one place for both
 * kinds of row.
 *
 * Every way this ends — not published, no distro chosen, a bad sha256, a
 * cancel — comes back as an `EnvInstallResult` with a sentence, because
 * `installEnv` never throws. The row's failure text is that sentence verbatim:
 * "download this later" and "your download was corrupt" are different problems
 * with different fixes and a shared exit code would hide both.
 */
async function runEnvInstall(job: Job, slot: Slot): Promise<void> {
  const request = envRequests.get(job.id);
  if (!request) {
    job.state = 'failed';
    job.error = 'The install lost its configuration before it started.';
    changed();
    settled(job);
    return;
  }

  job.state = 'running';
  job.startedAt = Date.now();
  job.message = `Installing ${job.title ?? request.target}…`;
  changed();

  let cancelled = false;
  const handle = installEnv(request, (progress) => {
    job.envProgress = progress;
    job.message = progress.detail;
    changed();
  });
  slot.cancel = () => { cancelled = true; handle.cancel(); };

  const result = await handle.done;
  slot.cancel = null;
  job.finishedAt = Date.now();

  if (result.ok) {
    job.state = 'done';
    job.message = result.detail;
  } else if (cancelled) {
    job.state = 'cancelled';
    job.message = 'Cancelled.';
  } else {
    job.state = 'failed';
    job.error = result.detail;
  }
  changed();
  settled(job);
  // NO PUMP HERE. It used to be this function's last line, back when it also
  // owned the slot; `runInSlot`'s `finally` gives the slot up and pumps for
  // both kinds of row, and a pump from here would ask the board a question
  // while this install still held every lane of it.
}
