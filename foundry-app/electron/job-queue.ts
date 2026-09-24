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
 * ONE GPU PER MACHINE, AND THERE CAN BE MORE THAN ONE MACHINE (Wave 61,
 * Package G). "One card, one owner" was written when this app knew of one card;
 * a registered Crucible is a second, and Owen ruled what follows from that
 * (docs/SLOTS.md §1): *"if there are more than one servers connected, there will
 * be more than one GPU slot listed in the queue that can be filled… an emergent
 * property of having multiple servers configured is the distributed load."* So
 * the GPU side of the board is one lane PER COMPUTE SLOT, derived from the slot
 * list in the one place both programs read it from (`computeLanes`,
 * shared/queue-board.ts). The card's rule is unchanged and is simply said once
 * per card: a translation on the Mac and a cleanup on this desk are two runs on
 * two machines, and nothing about them was ever a reason to make the second wait
 * three hours for the first. The CPU lane is untouched — a compile is this
 * machine's disk however many rooms away the models are.
 *
 * A job that reads through the LOCAL page reader waits for that server first
 * (electron/page-reader.ts). The wait is part of the job, not a thing that
 * happens beside it: the shelf says "Starting the reading server…", and a
 * server that will not start fails THAT job with the server's own log tail.
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
 * `enqueueTextPass`, `cancel`, `remove`, `start`, `clearFinished` — these route
 * when a host queue is registered) or a door FOUNDRY ITSELF reached for
 * (`enqueueHere`, `cancelHere`, `enqueueEnvInstall`, `runJob`, `runNow` — these
 * never route). Nothing below the doors consults anything: `pump`, `executeJob`
 * and every landing are the same code in both worlds, so there is no flag for a
 * function to forget.
 *
 * ── AND ONE KIND OF JOB NEVER WAITS AT ALL ───────────────────────────────────
 *
 * An EXPORT ordered from the Export dialog runs the moment it is asked for and
 * reports back to the dialog that asked (`runNow`). The queue is for work that
 * costs something — hours of GPU, a model held for a book — and an export is
 * seconds of offline arithmetic a person is actively waiting on; parking it in
 * a list beside the readings made the list the place you went to learn whether
 * a button worked. The row still exists for the length of the run (the guards
 * and the landings are built on rows), and it leaves the list the moment it
 * settles, because a shelf of finished exports is a history nobody asked for.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readAppSettings } from './app-settings';
import { materializeTextPass } from './book';
import {
  parseProgressLine, parseUsageLine, runEngine, stampMintMetadata, writeBookFile,
} from './engine';
import { ENV_SPECS } from './env-catalog';
import { destFor, installEnv } from './env-install';
import { foundryHost, type FoundryHostQueue, hostMintMeta } from './host';
import {
  bookAtPosition,
  cleanTriageFileFor,
  generatedRoleFor,
  completionMarkerFor,
  imagesDirFor,
  ledgerOf,
  metadataForProduct,
  positionStepId,
  projectDirOf,
  readManifest,
  readStepLedger,
  recordAnalysis,
  recordFinal,
  recordGenerated,
  recordReading,
  recordTextPass,
  restoreFinalRotation,
  restoreRotation,
  rotateFinal,
  rotateGenerated,
  type FinalRotation,
  type Rotation,
} from './projects';
/*
 * THE PLANS' SPAWN HALVES, FOR THE MATERIALISE AND FOR NOTHING ELSE (`materializeAtSpawn`).
 *
 * A one-way edge: `electron/workspace.ts` composes plans out of the project's
 * catalogue and has never heard of a queue, so importing it here adds no cycle and
 * takes nothing out of that module's reach. It is the same direction `mount.ts`
 * already runs in — it holds both — and the alternative was a third module whose
 * only content would be four `await` lines.
 */
import {
  identifyExport,
  materializeAnalysis,
  materializeCleanTriage,
  materializeCleanup,
  materializeExport,
  materializeSimplification,
  materializeTranslation,
} from './workspace';
import { exportNodeId, type HostMintMeta } from '../shared/host-ops';
import { ancestry, REWRITE_LABELS } from '../shared/ledger';
import { inheritMintMeta, type MintMeta } from '../shared/mint-meta';
import { fold } from '../shared/original';
import { rowMinting } from '../shared/pending';
import type { LlmServerKind } from '../shared/pipeline';
import {
  CPU_LANE_SLOTS, JOB_RESOURCE, computeLanes, localLane, type ComputeLane, type JobResource,
} from '../shared/queue-board';
import type {
  AnalyzeRequest, CleanRequest, CleanTriageRequest, ConversionKind, DeferredPlan, EnvInstallRequest,
  ExportLanding, ExportMintMetadata, FoundryJobRow, Job, JobKind, JobRequest, RunOutcome,
  RunPlacement, RunVenue, SimplifyRequest, TextPassRequest, TranslateRequest,
} from '../shared/types';
import { ENGINE_PARKED_EXIT, isResumableStop } from '../shared/types';
/*
 * WHERE A JOB'S COMPUTE GOES, and the two modules that answer it (docs/SLOTS.md
 * §6, Package C). A one-way edge exactly like the plans above: neither has ever
 * heard of a queue, and the dispatcher's whole surface is one function that
 * takes a kind and a `waitFor` and answers `go`, `wait` or `refuse`.
 */
import { computeSlots, waitForOfNewJob } from './crucible-registry';
import {
  capabilityClassOf, placeJob, placesOnASlot, CRUCIBLE_READS, UNPLACED,
  type LaneClaim, type Lease, type Placement, type PlacementWait,
} from './crucible-dispatch';
import { ANY_SLOT } from '../shared/slots';

/**
 * The three things that become an engine child.
 *
 * They share `requests`, `pump()` and the whole run-and-report path because
 * from here they are the same job: spawn foundry, read its stderr, report what
 * it wrote. Only `argsFor` and the reading-server wait can tell them apart.
 *
 * FOUR NOW, and the fourth is the cleanup's triage (`CleanTriageRequest`): a
 * model pass over the materialised book, like the analysis, that lands no step
 * at all. It is not a text pass — it writes no records and names no step — so it
 * is its own member rather than a fourth arm of `TextPassRequest`, whose every
 * reader wants a records file and a step id this shape does not have.
 */
type EngineRequest = JobRequest | TextPassRequest | AnalyzeRequest | CleanTriageRequest;

/**
 * IS THIS ONE OF THE THREE TEXT PASSES — the queue's own half of
 * `TEXT_PASS_ACTIONS` (shared/ledger.ts).
 *
 * A predicate rather than three comparisons at each of the eight places that ask,
 * and it narrows: every one of those places wants `recordsPath`, `bookPath` or
 * `seedRecords`, which none of the other request shapes has. It was one comparison
 * — `kind === 'translate'` — when a simplify wore the translation's name, and the
 * split would otherwise have turned each of those eight into a two- or three-arm
 * condition that a fourth pass would have to find again.
 */
function isTextPassRequest(request: EngineRequest): request is TextPassRequest {
  return request.kind === 'translate' || request.kind === 'simplify' || request.kind === 'clean';
}

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
 * - **AN ANALYSIS PRODUCES ITS REPORT**, which is `outputPath` already and
 *   therefore needs no line of its own below. It is named here anyway, because
 *   this list is what somebody reads to find out whether their job's product is
 *   the ordinary case, and "it happens to fall through" is not an answer.
 * - **A CLEANUP'S TRIAGE PRODUCES ITS VERDICTS**, which are `outputPath` too and
 *   fall through on the analysis's terms: one file, no document, and the file is
 *   what two presses of one triaged cleanup collide on.
 * - **EVERYTHING ELSE PRODUCES ITS OUTPUT**, which is the ordinary case and
 *   needs no argument.
 *
 * ── WHY THIS IS A FUNCTION AND NOT THREE CORRECT COPIES ─────────────────────
 *
 * It was three, and all three were right: `enqueueHere`, `enqueueTextPass` and
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
 * `enqueueTextPass` only ever a `TextPassRequest`, and narrowing the parameter
 * to fit either one would put the fork back where it came from.
 */
function productOf(request: EngineRequest): string {
  if (request.kind === 'read') return request.readingsPath;
  // EVERY TEXT PASS PRODUCES ITS RECORDS, and the test is the family's rather than
  // the translation's: a simplify and a cleanup each write one file of per-block
  // answers and no document, exactly as a translation does, so the records file is
  // what collides, what is worth showing and what the row is.
  if (isTextPassRequest(request)) return request.recordsPath;
  return request.outputPath;
}

/**
 * THE PROJECT A REQUEST NAMES OUTRIGHT, or null — `ConversionRequest.home`,
 * for a product a host asked to have written outside every project. Every
 * caller below asks this FIRST and the path second: `homeOf(request) ??
 * projectDirOf(outputPath)`. For every request this app composes it is null and
 * the path answers, exactly as it always did.
 */
function homeOf(request: JobRequest | EngineRequest): string | null {
  return 'home' in request && typeof request.home === 'string' ? request.home : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The promised chain — what a row will land, and what it has to wait for
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The layer an export lands in, spelled here so `mintsOf` can compose the exact
 * name the catalogue will file (`filedDocuments`, electron/projects.ts, prefixes
 * `final/`). `electron/workspace.ts` and `electron/projects.ts` each keep their own
 * constant for their own purposes; a third one here is this file naming the fact it
 * actually uses rather than importing a name for a string.
 */
const FINAL_LAYER = 'final';

/**
 * WHAT THIS ROW WILL PUT IN THE TREE — `Job.mints`, decided in the one place that
 * can see the request.
 *
 * ── Why main answers this and not the window ────────────────────────────────
 *
 * Because the answer turns on `export: true`, which is a field of the REQUEST and
 * never reaches a `Job`. The tree can tell an EPUB export from a per-step cast by
 * nothing at all — `kind` says `epub` for both, and the other difference is a
 * filename, which is the one thing this codebase never reads facts out of. So main
 * says it once, on the row, and the tree draws whatever it is told.
 *
 * A TEXT PASS MINTS A STEP, and the id is the one the plan already minted and put
 * on the request (`TranslateRequest.stepId`). That id existed so the records file
 * could be named after a step that will not exist for hours; this is the second
 * thing it buys, and it costs nothing.
 *
 * AN EXPORT MINTS A FILE, and its id is the same `export:<file>` an export ROW
 * already hands the host (`exportNodeId`, shared/host-ops.ts). Composing it here
 * from the layer and the basename rather than waiting for `recordFinal` is what
 * makes the promise and the landed row the SAME node: a narration chained onto the
 * promise comes back parented on an id that is still correct after the file lands,
 * so nothing has to be re-parented and the tree needs no second join.
 *
 * EVERYTHING ELSE ANSWERS `undefined`, which is the filter Owen's ruling implies
 * rather than states: a reading, an analysis, a mint and an environment install all
 * have surfaces of their own, and a Generate's cast is deliberately uncatalogued
 * (`GenerateRequest.forStep`). None of them puts a card in the tree, so none of them
 * has a promise to draw.
 */
function mintsOf(request: EngineRequest): string | undefined {
  if (isTextPassRequest(request)) return request.stepId;
  // A TRIAGE MINTS NOTHING: the cleanup behind it is the step, and a grayed card
  // for the question in front of the answer would be two cards for one act.
  if (request.kind === 'read' || request.kind === 'analysis' || request.kind === 'clean-triage') {
    return undefined;
  }
  if (request.export !== true) return undefined;
  return exportNodeId(`${FINAL_LAYER}/${path.basename(request.outputPath)}`);
}

/**
 * THE DEFERRAL A REQUEST CARRIES, or undefined — asked in one place so the two
 * shapes that cannot carry one (a reading, an analysis) are narrowed away once
 * rather than at every reader.
 */
function deferralOf(request: EngineRequest): DeferredPlan | undefined {
  if (request.kind === 'read' || request.kind === 'analysis') return undefined;
  return request.deferred;
}

/**
 * THE ROW THIS ONE MUST WAIT BEHIND — `Job.after`, composed at the enqueue.
 *
 * ── Why main composes it and the plan does not ──────────────────────────────
 *
 * The plan names a STEP (`deferred.from`), because a plan is about a book. The
 * scheduler needs a ROW, because a queue is about work, and which row is going to
 * land a given step is a fact about a list that only exists at the moment of the
 * press. Hosted it is not even Foundry's list: `shelfJobs()` is the host's rows
 * mirrored, so the id this answers is one the host minted and one the host's own
 * pump understands — which is exactly what makes `after` forwardable across the
 * seam at all.
 *
 * ASKED OF `shelfJobs()` AND NOT `jobs`, and that is the load-bearing line. The
 * promise the person clicked was drawn from the shelf, so the row behind it is in
 * the shelf's list; looking in Foundry's own `jobs` would answer `undefined`
 * hosted for every chain there is, and an undefined `after` means "start whenever
 * the board has room" — the export would run against the position and file the
 * wrong book.
 *
 * UNDEFINED WHEN THE ROW HAS ALREADY GONE, which is a real state and not an error:
 * the parent may have landed and been cleared between the plan and the enqueue.
 * `reconcileChains` is what tells that apart from a row that was lost, because it
 * is the only place that can — by asking the ledger.
 *
 * ── A LINK THE DOOR ALREADY NAMED WINS, AND THAT IS THE WHOLE RULE ─────────
 *
 * `request.after` set before this is asked means main composed the link itself,
 * at the press, from a row it had just minted — the cleanup behind its own triage
 * (`enqueueTriagedCleanup`), the one pair this app orders as a pair. That link is
 * a stronger fact than the deferral's: a deferred cleanup is still made from the
 * promised step, but it waits behind the TRIAGE, which itself waits behind the
 * promise, because a row has one parent. Reading the deferral first would chain
 * the cleanup past its own triage and run the two side by side.
 *
 * SO `Job.after` HAS ONE SOURCE, which is this answer: every door mints its row's
 * link from here (`promisedBy`), and every door that forwards to a host puts the
 * same answer on the request it hands over. There is no second path by which an
 * explicit link reaches a standalone row, and the pump's gate (`chainVerdict`) is
 * the same gate for both — it reads a row id and never asks how the id got there.
 *
 * A REQUEST IN THE STORE CARRIES THE LINK IT WAS FILED WITH, so a Retry that
 * re-sends it re-asks this and gets the same row back. If that row has left the
 * list by then, the link reads `unknown` and `reconcileChains` settles it against
 * the ledger, which is the path a parent that landed and was cleared already takes.
 */
function chainedBehind(request: EngineRequest): string | undefined {
  if ('after' in request && request.after !== undefined) return request.after;
  const deferred = deferralOf(request);
  if (deferred === undefined) return undefined;
  return rowMinting(shelfJobs(), deferred.from)?.id;
}

/**
 * The promised-chain fields, spread onto a row by all three doors.
 *
 * ONE SPREAD BECAUSE THREE DOORS MINT A ROW — `enqueueHere`, `enqueueTextPass` and
 * `runJob` — and `runJob`'s own docblock already names the hazard: *"a second way
 * of building one would be a second answer to what a job is."* The fields would be
 * copied correctly into all three today and into two of them the day a fourth
 * request shape arrives.
 *
 * ── AND TWO OF THEM ARE FOR THE CARD RATHER THAN THE SCHEDULER ──────────────
 *
 * `into` and `mode` say WHICH translation and WHICH rewrite this row is, so the
 * grayed card the tree draws from it can read "Translated into German" instead of
 * "Translated". They belong here rather than beside `titleForTextPass` because
 * that function composes the SHELF's sentence and this one composes the promise —
 * and `Job.into` exists precisely so that the tree never has to read a fact back
 * out of a sentence. Both come off the request verbatim; a host copies them across
 * the seam like the other two (docs/BOOKFORGE-HANDOFF.md §8b).
 */
function promisedBy(request: EngineRequest): Pick<Job, 'mints' | 'after' | 'into' | 'mode'> {
  const mints = mintsOf(request);
  const after = chainedBehind(request);
  const into = request.kind === 'translate' ? request.to : undefined;
  const mode = request.kind === 'simplify' ? request.rewrite : undefined;
  return {
    ...(mints !== undefined ? { mints } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(into !== undefined ? { into } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

/**
 * WHICH SLOT THIS ROW WILL WAIT FOR — decided at the PRESS, not at the spawn.
 *
 * ── Why the press, which is `Job.parentStep`'s argument again ──────────────
 *
 * A row can sit in the queue for an afternoon. Reading the standing preference
 * at the spawn would mean a batch queued before somebody added a second server
 * ran somewhere nobody chose, and reading "whichever is ranked first" at the
 * spawn would mean a drag in the settings screen moved four queued books onto
 * another machine — which docs/SLOTS.md §3 rules against in as many words:
 * *"queued rows do NOT move when servers are re-ranked."* So the ANSWER is
 * written onto the row here, and the only thing that changes it afterwards is a
 * person changing it (`setWaitFor`).
 *
 * ── Absent for everything that does not meet a model ───────────────────────
 *
 * An export, a mint, an environment install: no capability class, no placement,
 * no picker. A READING USED TO BE ABSENT TOO and no longer is: `CRUCIBLE_READS`
 * is true (crucible-dispatch.ts) and a reading is dispatched like any other act,
 * so it gets the picker every placed row gets. The guard below stays, because it
 * is the constant that decides it and not a fact about the kind — the day
 * anything turns it back off, the picker goes with it rather than becoming a
 * control that does nothing.
 *
 * ALSO ABSENT WHEN THERE IS NOTHING TO CHOOSE — no slots, or one — which is the
 * friend with a GPU and no Crucible, and every hosted window whose host offers
 * no slot list. `waitForOfNewJob` decides that, once, so the picker's "is there
 * anything to pick" and the row's "what did I pick" cannot disagree.
 */
function placedBy(kind: JobKind, chosen?: string): Pick<Job, 'waitFor'> {
  /*
   * ── A SCHEDULER'S CHOICE WINS, AND ITS LOSS IS NEVER SILENT ───────────────
   *
   * Hosted, the person picked a machine on the HOST's row, and this app's
   * default is not an answer to that question — it is an answer to a question
   * nobody asked. So `chosen` is taken as given when a placement is possible
   * at all. What it cannot override is whether there IS a placement: an export
   * or a mint puts nothing in front of a model, and a reading stays on this
   * machine while `CRUCIBLE_READS` is false. Both of those drop the name, and
   * both say so, because a control that quietly does nothing is the defect
   * this seam exists to remove.
   */
  if (capabilityClassOf(kind) === null) {
    if (chosen !== undefined) {
      console.error(
        `[slots] a scheduler asked for "${chosen}" on a ${kind} job, which puts nothing in `
        + 'front of a model. The name was dropped.',
      );
    }
    return {};
  }
  if (kind === 'read' && !CRUCIBLE_READS) {
    if (chosen !== undefined) {
      console.error(
        `[slots] a scheduler asked for "${chosen}" on a page reading, which runs on this `
        + 'machine while remote reads are switched off. The name was dropped.',
      );
    }
    return {};
  }
  if (chosen !== undefined) return { waitFor: chosen };
  /*
   * ── HOSTED, A SILENCE IS `any` AND NEVER THIS APP'S SETTING ───────────────
   *
   * Owen, 2026-09-19: *"the server is chosen when it's in the queue. if it isnt
   * chosen or cant be for some reason, it should be 'any'."*
   *
   * THE DEFECT HE HIT. A hosted read arrived with no machine named, fell through
   * to `waitForOfNewJob`, and was answered by `newJobsWaitFor` — which clamps to
   * `top`, so the row was stamped with the NAME of the top-ranked slot. BookForge
   * drew it in the Mac Studio's lane, an engine he had switched off, while the
   * card's own progress line read `crucible@example-pc-wsl` and the PC slot said
   * "Free · Nothing queued wants this slot". Both screens were telling the truth:
   * the row was filed on one machine and the work ran on another.
   *
   * THIS IS THE OTHER HALF OF THE SENTENCE FOUR LINES UP. A host that registers
   * `hostQueue` does the DECIDING (electron/mount.ts; docs/PLAN.md Wave 16: *"we
   * need to centralize the queue in bookforge"*), and that argument does not stop
   * applying because the host happened to say nothing — a setting on a screen
   * nobody opened is no more an answer to the host's question when the host is
   * silent than when it is not. `any` is the reserved word that means *"decide
   * later"*, which is the truth: nobody has chosen, the walk will, and `ranOn`
   * will say where it went. A NAME here is the only answer that can be WRONG.
   *
   * AND UN-HOSTED IS UNTOUCHED, because there the setting is not a stray default
   * — it is the person's own answer, given on the Servers card, to exactly this
   * question. `waitForOfNewJob` carries the rest of that argument, including why
   * `top` becomes a name at the press rather than travelling as the word.
   */
  if (hostQueue() !== null) return { waitFor: ANY_SLOT };
  const waitFor = waitForOfNewJob();
  return waitFor === undefined ? {} : { waitFor };
}

/**
 * The request without its deferral — a copy, so the stored request is untouched
 * until the caller decides to replace it.
 *
 * `delete` RATHER THAN `deferred: undefined`, because the two are different claims
 * and this codebase reads absence as the answer everywhere: `identityOf`'s own rule
 * (*"a bag written `{rewrite: undefined}` said nothing"*), and here it decides
 * whether `argsFor` is about to be handed a request that still thinks it is waiting
 * for something.
 */
function withoutDeferral<T extends { deferred?: DeferredPlan }>(request: T): T {
  const copy = { ...request };
  delete copy.deferred;
  return copy;
}

/**
 * THE ROW FOLLOWS ITS PRODUCT WHEN THE RE-PLAN MOVES IT — or the row is refused,
 * because something else is already writing the file it just resolved onto.
 *
 * ── Why a row can be renamed at all, when nothing else in this queue is ─────
 *
 * `Job.outputPath` is settled at the enqueue for every job this app has ever run,
 * and it should be: it is the identity `pendingFor` dedupes on and the thing a
 * person is pointed at. A DEFERRED text pass is the one exception, and it is not a
 * loophole — it is the consequence of Owen's ruling that a chain picks its settings
 * up *"from the last step after it finishes"*. Some of what a records file is named
 * after is not knowable until then: the language a rewrite happens in, and whether
 * this ask turns out to be a re-run of a step that only exists once the parent
 * lands. See `materializeAtSpawn`.
 *
 * ── THE DEDUPE IS ASKED AGAIN, AND IT IS THE WHOLE POINT OF THE FUNCTION ────
 *
 * The press dedupes on a name that was provisional, so two rewrites ordered from
 * one promise are two rows that resolve to ONE file — and the queue's own rule is
 * that a file has one live writer. Two engines appending answers to one records
 * file is not a collision that shows up as a crash; it is six hours of a model and
 * a file with two runs' answers interleaved in it. So the second row FAILS BY NAME,
 * which is the shape every unmakeable plan in this app takes, and the sentence
 * names the row that has the file.
 *
 * A ROW IN ANY OTHER STATE IS NOT A CLASH (`pendingFor` matches held, queued and
 * running only): a run that finished an hour ago is history, and refusing a re-run
 * because of it would make the shelf's own record the reason the work is impossible.
 *
 * ── AND IT ANNOUNCES, because the shelf is drawing the old path ─────────────
 *
 * The row's tooltip, its Reveal and the tree's project filter all read this field
 * (`queue-view.service.ts`, `ledger.service.ts`), and a rename nobody was told
 * about is a shelf pointing at a file that will never exist.
 */
function renameProduct(job: Job, resolved: EngineRequest): void {
  const product = productOf(resolved);
  if (samePath(product, job.outputPath)) return;
  const clash = pendingFor(product);
  if (clash !== undefined && clash.id !== job.id) {
    throw new Error(
      'This work was ordered from a step that had not finished yet, and now that it has, the answers '
      + 'it would write belong in a file another job in the queue is already writing — so running it '
      + 'would put two runs into one file. Nothing was written. Wait for that job to finish, then '
      + 'order this again from the step it lands.',
    );
  }
  job.outputPath = product;
  changed();
}

/**
 * THE MATERIALISE AT SPAWN — the request as the engine will be handed it, or a
 * refusal naming the step it was to be made from.
 *
 * ── What this replaced, and why (PK6) ──────────────────────────────────────
 *
 * It was `materializeDeferred`, and it ran for exactly one kind of row: a pass
 * ordered from a step that had not landed. Every other row's book, seed and
 * generation were composed AT THE PRESS and persisted on the request.
 *
 * That split had the lifetimes backwards. A derived book is unlinked by
 * `sweepDerivedBook` at EVERY ending and by `sweepStaleDerived` after a day; a
 * request outlives its row's first run — Retry re-sends it byte for byte, a
 * resumable Stop leaves it on the step, and hosted it is persisted in somebody
 * else's queue file across restarts. So the path was always the shorter-lived
 * half, and `--book … (ENOENT)` was the reliable consequence (BookForge's
 * 2026-09-20 hunt, F1; F5 is the same defect met through Start). The seed had the
 * same shape with a quieter failure: a file the press named and a Start-over
 * removed was copied by nobody and the run silently paid full price (F8).
 *
 * SO EVERY ROW MATERIALISES HERE, AND A DEFERRAL IS NO LONGER A SPECIAL CASE: it
 * is simply an `at` that did not exist when the button was pressed. One function,
 * one seeding rule, one same-language refusal, one place that can fail by name.
 *
 * ── AND IT IS STILL NOT "THE POSITION" ─────────────────────────────────────
 *
 * The family's standing rule is untouched: *a pointer move made while the job
 * waited must not silently produce a different book*. The row is pinned at the
 * press (`request.at`, or `deferred.from` for a promise) and this resolves THAT
 * id. What is re-asked at spawn is only what had to be read off a chain.
 *
 * ── THE REFUSAL IS THE CASCADE'S LAST LINE ─────────────────────────────────
 *
 * *"if i then remove the cleanup step from the queue, or it otherwise gets lost
 * along the way, everything under that grayed out chain also gets removed."* The
 * queue's own cascade catches the removals and failures it can see
 * (`cascadeFrom`); this catches everything else — a row that succeeded without
 * landing, a step deleted between the landing and this spawn, a host that ran a
 * chained row out of order. Running against the position instead would be the
 * silent wrong answer: an export of the book WITHOUT the cleanup, filed under the
 * name the cleaned one was going to have.
 *
 * ── AND THE DEFERRED HALF IT KEPT ──────────────────────────────────────────
 *
 * `stepId` is KEPT, always, and is the one field this never takes from the
 * re-plan: the tree drew a card with that id and a person chained work behind it,
 * so landing under a freshly minted id would orphan every child at the moment its
 * parent succeeded. It is handed BACK IN (`recordsForTextPass`'s `minted`), which
 * is what makes the two askings agree about one step rather than merely one path.
 * The RECORDS PATH is taken from the re-plan for a deferred row only — a
 * placeholder resolving, or a re-run that could not match at the press because
 * nothing is parented to a promise — and `renameProduct` moves the row with it.
 */
async function materializeAtSpawn(
  request: EngineRequest,
  /**
   * THE ROW THIS REQUEST BELONGS TO, because a name is not only a fact about a
   * request. `Job.outputPath` is what the shelf reveals, what the dedupe compares
   * and what the landing files as a payload, so a re-plan that moves the file has
   * to move the row with it and say so (`changed()`).
   */
  job: Job,
): Promise<EngineRequest> {
  /*
   * A READING MAKES NO BOOK, and it is the one kind that never did: it puts pages
   * in front of a model and fills a bank. Nothing here has anything to say about
   * it, and asking the ledger about a project mid-import would be work for an
   * answer nobody reads.
   */
  if (request.kind === 'read') return request;
  const deferred = deferralOf(request);
  const dir = homeOf(request) ?? projectDirOf(productOf(request));
  /*
   * WHICH ROW, AND THE TWO WAYS A REQUEST NAMES ONE. `deferred.from` is the
   * promise's parent — the row that had to land first — and `at` is the row the
   * press was standing on or clicked. Both are ids; neither is "the position now".
   *
   * NULL IS AN ANSWER AND NOT AN ABSENCE: a project that held no steps when the
   * button was pressed has the reading's own book file, which is exactly what
   * `materializeBook` answers for a null row.
   */
  const named = deferred !== undefined ? deferred.from : request.at ?? null;
  if (dir === null) {
    /*
     * ── A FILE OUTSIDE EVERY PROJECT, AND THE TWO THINGS THAT CAN MEAN ───────
     *
     * NOTHING WAS NAMED. There is no chain to replay and nothing that was ever
     * going to be replayed: a rendering aimed at a path this library does not
     * hold, which the landing already says so about (`landReadProducts`) and
     * which the CLI's own doors reach. The request stands as it is, and a run
     * that needed a book meets `bookOf`'s refusal at its command line.
     *
     * A ROW WAS NAMED AND CANNOT BE FOUND. That is a claim about a project, made
     * by a request that outlived it, and it is refused here rather than run
     * against whatever is nearest.
     */
    if (named === null) return request;
    throw new Error(
      'This work was to be made from a step in a project this library no longer holds — so the '
      + 'book it was to read cannot be made, and there is nothing to run it against.',
    );
  }
  const ledger = ledgerOf(await readManifest(dir));
  const step = named === null ? null : ledger.steps.find((row) => row.id === named) ?? null;
  if (named !== null && step === null) {
    throw new Error(
      'The step this was to be made from never landed, so there is nothing to make it out of. '
      + 'Whatever was going to produce it left the queue — order this again from a step that exists.',
    );
  }
  if (isTextPassRequest(request)) {
    /*
     * THE SAME THREE MAKERS THE PRESS'S THREE IDENTIFIERS ARE PAIRED WITH.
     * `materializeSimplification` can still refuse here (a book that never declared
     * a language) and `materializeTranslation` carries the same-language refusal
     * that a deferred pass could not be given at the press. Either way the throw
     * becomes a failed row wearing main's own sentence.
     */
    const plan = request.kind === 'translate'
      ? await materializeTranslation(request.inputPath, request.to, step, request.stepId)
      : request.kind === 'simplify'
        ? await materializeSimplification(request.inputPath, request.rewrite, step, request.stepId)
        : await materializeCleanup(request.inputPath, step, request.stepId);
    const next = withoutDeferral(request);
    next.bookPath = plan.bookPath;
    /*
     * THE SEED IS TAKEN WHOLE, PRESENT OR ABSENT. A stale one left on the request
     * would be a path the copy skips in silence, which is the defect (F8) this
     * whole move exists to end — so an absent answer DELETES rather than leaving
     * what the press believed.
     */
    if (plan.seedRecords !== undefined) next.seedRecords = plan.seedRecords;
    else delete next.seedRecords;
    if (plan.generation !== undefined) next.generation = plan.generation;
    if (deferred !== undefined) {
      /*
       * ── THE NAME THE CHAIN CAN FINALLY SAY ──────────────────────────────────
       *
       * Only for a promise, because only a promise's name was provisional. See the
       * header: a placeholder resolving, or a re-run that can match now that the
       * parent exists. The STAMP travels with it — a cleanup's stamp is NAMED FROM
       * the records file and nothing else, so leaving it behind would hand the
       * compile a receipt for a file nobody wrote.
       */
      next.recordsPath = plan.recordsPath;
      if (next.kind === 'clean' && plan.stampPath !== undefined) next.stampPath = plan.stampPath;
      /*
       * AND THE LANGUAGE, WHICH FOR A REWRITE IS BOTH ENDS. `--from` is the chain's
       * source language and a cleanup has none to carry. A rewrite also takes its
       * `to` from here, which is the half Owen's chain-anything ruling added: both
       * ends of a rewrite are one fact and a deferred one had no way to state it.
       * A translation's `to` was typed by a person and is never touched.
       */
      if (next.kind !== 'clean' && plan.from !== undefined) next.from = plan.from;
      if (next.kind === 'simplify' && plan.from !== undefined) next.to = plan.from;
      renameProduct(job, next);
    }
    return next;
  }
  if (request.kind === 'analysis') {
    // AN ANALYSIS IS NEVER DEFERRED — `analysis` has no `deferred` field at all
    // (`AnalyzeRequest`), because no tile in this app chains one behind a promise.
    // So the copy is a plain one and the row's name never moves.
    const next = { ...request };
    next.bookPath = (await materializeAnalysis(dir, step)).bookPath;
    return next;
  }
  if (request.kind === 'clean-triage') {
    /*
     * ── A TRIAGE MAKES THE CLEANUP'S BOOK, AND NOTHING ELSE ───────────────────
     *
     * Its own branch, and it has to be: falling through would reach the rendering
     * arm below, which narrows a narration stamp and composes a rendering's inputs
     * for a run that writes neither. What it needs is the book at the row the press
     * pinned — the same row its cleanup carries — so the two read one content
     * (`materializeCleanTriage`, electron/workspace.ts).
     *
     * IT CAN BE DEFERRED, where an analysis cannot: a cleanup pressed on a greyed
     * card orders its triage deferred on the same promise, and `named` above has
     * already resolved that promise to the step it landed. The deferral is dropped
     * from the copy because it is spent; the NAME never moves — the verdicts file
     * was fixed at the press, and the cleanup behind this row is already carrying
     * it (`CleanRequest.triagePath`).
     */
    const next = withoutDeferral(request);
    next.bookPath = (await materializeCleanTriage(dir, step)).bookPath;
    return next;
  }
  /*
   * A RENDERING, AND THE ONE EXTRA ASKING A PROMISED ONE NEEDS. The chain facts an
   * export reads — which records, which language, whose stamp — could not be
   * composed at the press of a promise, so they are composed now at the landed row
   * before the book is made from it. An ordinary export composed them at the press
   * and keeps them; only the BOOK and the narrowing were ever spawn work.
   */
  const next = withoutDeferral(request);
  let claimed = request.narrationStamp;
  if (deferred !== undefined) {
    const plan = await identifyExport(request.inputPath, request.kind, step);
    if (plan.narrationStamp !== undefined) next.narrationStamp = plan.narrationStamp;
    if (plan.records !== undefined) next.records = plan.records;
    if (plan.language !== undefined) next.language = plan.language;
    claimed = plan.narrationStamp;
  }
  const made = await materializeExport(dir, request.kind, step, claimed);
  if (made.bookPath !== undefined) next.bookPath = made.bookPath;
  /*
   * AND THE CLAIM IS NARROWED OR WITHDRAWN. An empty narrowing drops the field
   * rather than carrying a path of no characters, exactly as the plan did when it
   * owned this: no reader of a `GenerateRequest` has to know that the empty string
   * means anything.
   */
  if (claimed !== undefined) {
    if (made.narrationStamp !== undefined) next.narrationStamp = made.narrationStamp;
    else delete next.narrationStamp;
  }
  return next;
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
  /**
   * WHICH COMPUTE LANE THIS RUN HOLDS — a slot's name, or null for a run that
   * holds none.
   *
   * ── The field Package G added, and the three states it has ────────────────
   *
   * The GPU side of the board is one lane per compute slot now
   * (`computeLanes`, shared/queue-board.ts), so "how many GPU runs are going" is
   * no longer the question the scheduler asks — it asks WHICH MACHINE each one is
   * on, and this is the answer.
   *
   *   * A NAME, set the moment the row is picked (`laneAtPick`) when the answer
   *     is already knowable: a run that is never placed holds the local lane, and
   *     a row pinned to a slot holds the one it named. Reserving before the first
   *     await is what stops two rows in ONE synchronous pump pass from both
   *     seeing the same lane free — the same argument the slot map itself makes.
   *   * A NAME, set later by the walk, when the row said `any` and the walk chose
   *     (`LaneClaim`, electron/crucible-dispatch.ts). It moves as the walk steps
   *     past a busy machine, because a run holds exactly one lane and claiming
   *     the next candidate gives the last one back.
   *   * NULL, for a run that holds no compute lane at all: every CPU row, and an
   *     install, which holds the whole board by a different rule.
   *
   * A NAME THAT IS IN NO LANE LIST IS LEGITIMATE and is the point of keeping a
   * string rather than a reference: a row pinned to a server that was switched
   * off holds a lane nothing else can want, gets picked, and gets dispatch's
   * sentence about what it is waiting for — which is how a person finds out.
   */
  on: string | null;
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
 * A LANE PER MACHINE DID NOT CHANGE IT EITHER (Package G), and the temptation
 * there is larger: a host that offers a slot list is naming machines this app can
 * now count, so filing the host's runs against them looks like bookkeeping. It
 * would be the same mistake wearing better clothes — the host's queue decides
 * what runs on its own machines, and a claim of ours against one of them would
 * refuse a row somebody's host had already committed to. So a detached run claims
 * no lane at all: `placeRun` hands the walk a claim that says yes to everything.
 *
 * What they are for is the same two things the slot is for: a ✕, and a quit. So
 * `cancelHere` looks here when the slot is not this row, and `shutdown` stops
 * every one of them.
 *
 * NO LONGER EMPTY STANDALONE. It was — nothing ran detached without a host
 * queue to have scheduled it — until exports started running under the dialog
 * that asked for them (`runNow`), which goes through `runDetached` in both worlds
 * for the same reason a host's run does: the deciding already happened, at the
 * button. Every reader of this map wants exactly that run counted — the drain
 * holds while it lives, its ✕ reaches it, and `shutdown` stops it.
 */
const detachedRuns = new Map<string, () => void>();

/**
 * Rows whose ending was a host's RESUMABLE STOP rather than a cancel.
 *
 * Recorded at the abort, because that is the only moment the gesture exists
 * (`RESUMABLE_STOP`, shared/types.ts): `RunOptions` is handed over before the
 * engine spawns and cannot know which button a person will press. Read once, at
 * the one branch that destroys anything, and cleared by `settled` — the one
 * ending every path in this file reaches — so a row id cannot carry a stale
 * promise into whatever runs next.
 *
 * ABSENT MEANS CANCEL, which is the default the whole feature turns on: the ✕,
 * an internal cancel and a host that says nothing all keep today's behaviour.
 */
const resumableStops = new Set<string>();
/**
 * THE RUNS THAT ARE LANDING — the window in which a row's ending is the RUN's to
 * say and nobody else's, by row id.
 *
 * ── The one thing it decides ────────────────────────────────────────────────
 *
 * `cancelHere` settles a `running` row that has no live child of its own, and it
 * has to: a job waiting for the reading server is `running` for minutes before
 * there is anything to kill, and a ✕ that did nothing there would leave the
 * button dead for all of them. But there is a SECOND way a running row has no
 * child, and it is the opposite case — the child has already exited, the product
 * is on disk, and `carry` is between `wires.release()` and the line that writes
 * the row's outcome, removing the intermediate and the derived book. Two real
 * disk operations, both awaits.
 *
 * A cancel landing in there settled the row `cancelled`, swept the derived book
 * out from under the landing and told every listener — and then the landing
 * wrote `done` over it and settled it again. TWO ENDINGS FOR ONE RUN, which is
 * exactly what `onJobSettled` promises never happens (`exportEpubFromStep`
 * resolves on the first and rejects on the second), plus a cascade that cancels
 * the chain behind a job whose product had just landed.
 *
 * So this is the ordering, said out loud: the run owns the ending from the
 * moment its engine is gone, and a ✕ that arrives after that is a gesture about
 * work that is already done. Entered beside `wires.release()` and left in
 * `executeJob`'s `finally`, so it cannot outlive the run that made it.
 */
const landings = new Set<string>();
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
 * THE CHAIN'S OWN LANGUAGE — the newest `read` on the path that produced the
 * export, or nothing. Asked only where the request itself carried no language
 * (an untranslated position: the plan sets one for every translated export),
 * and lenient end to end, because a language the settle cannot work out is a
 * stamp that falls back to the form's answer rather than a mint that fails.
 */
/**
 * THE PROJECT'S DECLARATION WITH THE HOST'S RECORD UNDERNEATH — what an EPUB
 * export nobody confirmed at a form is stamped with. `inheritMintMeta` holds
 * the precedence; this is only the two reads it needs, both lenient: a
 * catalogue that will not parse and a host that throws are each "no record",
 * because the book is made and a stamp is the last thing that happens to it.
 */
async function inheritedMintMetaFor(dir: string): Promise<MintMeta | null> {
  let stored: MintMeta | undefined;
  try {
    stored = (await readManifest(dir)).meta;
  } catch {
    stored = undefined;
  }
  let seed: HostMintMeta | null;
  try {
    seed = await hostMintMeta(dir);
  } catch (err) {
    // The export is made and filed whatever the host says; what is lost is
    // the author on the package, which is worth a named line and not a
    // failed job (the modal's door lets the same throw reach the form).
    console.error(`[queue] ${path.basename(dir)}: ${err instanceof Error ? err.message : String(err)}`);
    seed = null;
  }
  return inheritMintMeta(stored ?? null, seed);
}

async function chainLanguageOf(
  outputPath: string,
  parentStep: string | null,
  /** The request's own project, for a file written outside it (`homeOf`). */
  home: string | null = null,
): Promise<string | undefined> {
  if (parentStep === null) return undefined;
  const dir = home ?? projectDirOf(outputPath);
  if (dir === null) return undefined;
  try {
    const ledger = ledgerOf(await readManifest(dir));
    const chain = ancestry(ledger, parentStep);
    for (let at = chain.length - 1; at >= 0; at -= 1) {
      const step = chain[at]!;
      if (step.action !== 'read') continue;
      const language = step.params?.['language'];
      return typeof language === 'string' && language.length > 0 ? language : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
function settled(
  job: Job,
  /**
   * DID THIS ENDING LEAVE NOTHING BEHIND — the question the cascade turns on.
   *
   * ── Why the cascade hangs off this function and not off three arms ─────────
   *
   * Because this is the ONE place every ending in this file passes through: the
   * three failure arms of `executeJob`, the cancel, the removal, the mint's settle
   * and the ordinary landing all call it, and a cascade spelled at each of them is
   * a cascade missing from whichever arm is added next. Owen's ruling says *"or it
   * otherwise gets lost along the way"*, which is precisely a rule that must not be
   * enumerated.
   *
   * DEFAULTED FROM THE STATE, because for five of the six callers the state IS the
   * answer: `failed` and `cancelled` leave nothing, `done` leaves the thing the
   * chain was waiting for. The sixth is `remove`, where the row is still `held` or
   * `queued` when it leaves the list — it never ran, so its state never moved — and
   * that caller says so by hand. It is the one ending whose loss is invisible in
   * the row itself, and it is Owen's own headline case (*"if i then remove the
   * cleanup step from the queue"*).
   */
  lost: boolean = job.state === 'failed' || job.state === 'cancelled',
): void {
  /*
   * THE WAIT LEDGER IS CLEARED HERE FOR THE SAME REASON THE CASCADE LIVES HERE:
   * this is the one place every ending in this file passes through, and a
   * backoff count left behind on a removed row would be handed to the next job
   * that happened to be minted with the same id — which cannot happen today,
   * because ids are uuids, and would be a silent one-in-nothing bug the day
   * anything about that changed. See `parkedUntil`.
   */
  forgetPark(job.id);
  /*
   * ── AND THE LEASE ON SOMEBODY ELSE'S CARD IS GIVEN BACK, HERE, FOR THE SAME
   * REASON ──────────────────────────────────────────────────────────────────
   *
   * A Crucible placement holds a claim on the resident model for the length of
   * the run (`Lease`, electron/crucible-dispatch.ts), and a claim that outlives
   * its run is a card nobody else can load onto until the TTL expires. The
   * requirement is that it be released on SUCCESS, FAILURE AND CANCEL alike —
   * which is exactly the set of endings that reach this function, and is why the
   * release lives here rather than in a `finally` around the spawn: there are
   * three arms in `executeJob` that settle without ever reaching one.
   *
   * FIRE AND FORGET, AFTER THE STOP. `release()` clears its own heartbeat
   * synchronously and only then awaits the DELETE, so nothing is still beating by
   * the time this line returns; the network half is allowed to finish on its own
   * because a settle must not wait on somebody else's server, and a release that
   * fails logs itself and expires.
   */
  const lease = leases.get(job.id);
  if (lease !== undefined) {
    leases.delete(job.id);
    /*
     * HELD, THOUGH STILL NOT AWAITED. The settle goes on without it — a run must
     * not wait on somebody else's server to be over — but the promise is kept in
     * `releasing` so a QUIT can wait for it, which is the one moment the DELETE
     * landing matters more than this row finishing (BookForge P9).
     */
    const given = lease.release();
    releasing.add(given);
    void given.finally(() => { releasing.delete(given); });
  }
  /*
   * AND THE GESTURE THAT ENDED IT IS FORGOTTEN HERE, for the lease's own reason
   * one line up: this is the one ending every path in this file reaches, and a
   * row id left in that set would hand its promise to whatever is minted next.
   */
  resumableStops.delete(job.id);
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
  if (lost) cascadeFrom(job);
}

/**
 * EVERYTHING CHAINED BEHIND A ROW THAT IS NOT COMING — cancelled and removed, by
 * name, transitively.
 *
 * ── The half of the ruling the derivation cannot do ─────────────────────────
 *
 * *"if that item is removed from the queue, anything under it also disappears."*
 *
 * The TREE half is free: a promise is drawn only where its parent is a real step or
 * another live promise, so the chain leaves the screen in the same repaint
 * (`admitPending`, shared/pending.ts). This is the QUEUE half, and it is real work
 * with a real request behind it: an export chained behind a cleanup that was just
 * removed is still a row the pump will happily start, and starting it would compile
 * the book WITHOUT the cleanup and file it under the name the cleaned one was going
 * to have. Repainting a tree does not stop an engine.
 *
 * ── REMOVED RATHER THAN LEFT AS A CANCELLED ROW ─────────────────────────────
 *
 * `remove`'s own argument, applied to a row nobody pressed anything on: *"a job
 * that never started spent nothing and produced nothing, and a `cancelled` row for
 * it is residue."* Owen's word is *disappears*, and a shelf that answered a removal
 * by growing three grey rows about it would be the app arguing with the gesture.
 *
 * THE REASON IS SAID ANYWAY, in the row's own `error`, before it goes. Nothing
 * draws it — the row is gone — but `settled` publishes the copy, which is how
 * `exportEpubFromStep` learns why the export it is awaiting will never arrive
 * (`unfiled` reads it). A host that asked for a book and gets "the cleanup it was
 * to be made from was removed from the queue" can say something true to its own
 * user; "was taken out of the queue before it ran" could not.
 *
 * A ROW ALREADY OVER IS LEFT ALONE. A done child is a thing that happened, and a
 * failed one has its own account of why — overwriting either with the parent's
 * story would be this app editing a record of something it did not cause.
 */
function cascadeFrom(job: Job): void {
  const doomed: Job[] = [];
  const frontier = [job.id];
  while (frontier.length > 0) {
    const parent = frontier.pop()!;
    for (const row of jobs) {
      if (row.after !== parent) continue;
      if (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled') continue;
      if (doomed.includes(row)) continue;
      doomed.push(row);
      frontier.push(row.id);
    }
  }
  if (doomed.length === 0) return;
  const why = job.title ?? path.basename(job.outputPath);
  for (const row of doomed) {
    /*
     * A CASUALTY THAT HAS ALREADY GONE IS SKIPPED, and the case is real rather than
     * defensive. `settled` below re-enters this function for each row it settles, so
     * a grandchild is reached twice: once by the inner call, which cancels it, and
     * once by this loop, which collected it up front. Without this guard the second
     * pass would settle it a second time — two endings published for one row, which
     * is precisely what `onJobSettled` promises never happens, and which
     * `exportEpubFromStep` would resolve and then reject on.
     */
    if (row.state === 'done' || row.state === 'failed' || row.state === 'cancelled') continue;
    /*
     * A RUNNING CASUALTY IS STOPPED THE WAY THE ✕ STOPS ONE. It cannot happen
     * through the pump — a row whose `after` is unfinished never starts — but it
     * can through `runJob`, where somebody else's scheduler chose the order. The
     * child is killed and the close handler settles the row, so this arm files
     * nothing itself and deliberately does not remove the row either: a run that
     * spent GPU is a `cancelled` record rather than residue, which is `remove`'s own
     * distinction.
     */
    if (row.state === 'running') {
      row.error = `“${why}” did not finish, so this could not be made from it.`;
      const stop = slots.get(row.id)?.cancel ?? detachedRuns.get(row.id);
      if (stop !== undefined) {
        stop();
        continue;
      }
    }
    row.state = 'cancelled';
    row.error = `“${why}” left the queue, so this had nothing left to be made from.`;
    row.finishedAt = Date.now();
    void sweepDerivedBook(requests.get(row.id));
    const index = jobs.indexOf(row);
    if (index >= 0) jobs.splice(index, 1);
    requests.delete(row.id);
    envRequests.delete(row.id);
    // The copy goes out with the reason on it, and the recursion finds nothing:
    // this row's own children were collected above and are already settled by the
    // time their turn comes.
    settled(row);
  }
  changed();
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
 * THE ROWS OF OURS THAT ARE A HOST'S ROW SEEN FROM THE INSIDE — the twins, and
 * the one thing a hosted shelf must not draw beside the host's own list.
 *
 * ── What a twin is ─────────────────────────────────────────────────────────
 *
 * `runJob` is the seam door (electron/mount.ts): the host's pump has chosen one
 * of ITS rows and asks this app to run it now, and this app mints a row of its
 * own for it because the landings, the settle, the guards and the ✕ are all
 * things a ROW carries (`runJob` argues it at length). That row is not a second
 * piece of work. It is the host's row seen from the side that spawns the engine,
 * and the host is already publishing the other half of it through
 * `setHostQueueRows` — so the two are one job filed in two lists, which is
 * exactly the shape `shelfJobs`' never-a-merge rule exists to keep off a screen.
 *
 * ── The night it was drawn twice ───────────────────────────────────────────
 *
 * Between 2026-09-08 (`shelfJobs` began drawing every LIVE row of ours, for the
 * deferred export that was visible in neither window) and this line, the twin
 * passed that filter. ONE Clean text ordered in BookForge drew TWO grayed
 * "Cleaned for narration" cards under one step, both running, both 4% (Owen,
 * 2026-09-11). They were identical by construction: the tree keys a promised
 * card on `Job.mints` and `promisedBy` copies that onto the twin verbatim, and
 * `admitPending` (shared/pending.ts) skips a promise whose step has LANDED —
 * never one that is already promised by another row.
 *
 * ── KEYED ON THE ROW ITSELF, so the mark cannot outlive what it is about ────
 *
 * A set of ids would have to be swept at all five places a row leaves `jobs`,
 * and the sixth one added later would leak a mark that no row answers for. This
 * queue mutates rows in place and never replaces one — `copyOf` exists precisely
 * so that what leaves this module is a copy — so a row's identity is as durable
 * as its id, and a WeakSet forgets the mark in the same breath the row is
 * forgotten.
 */
const hostScheduled = new WeakSet<Job>();

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
 * ── THE EXCEPTION, AND IT IS AN EXCEPTION THAT CANNOT DISAGREE ─────────────
 *
 * Our own LIVE rows are appended — the env install BookForge asked for after
 * seeing one vanish from the shelf mid-download (*"an install is real work with
 * real progress and the shelf is the window's answer to what is this machine
 * doing"*), the mint, and the export a host ordered through `exportEpubFromStep`
 * that waits behind its parent. What makes that safe is structural rather than
 * careful: NONE OF THEM HAS A ROW IN THE HOST'S LIST. An install never routes
 * (16e), a mint never routes, and an export the host ordered through the mount
 * seam was never filed in the host's queue at all — so each exists in exactly
 * one of the two lists and no row can be drawn twice.
 *
 * THE ROWS THAT CAN BE IN BOTH LISTS ARE THE TWINS `runJob` MINTS, and they are
 * filtered out by name (`hostScheduled`, where the argument and the night it was
 * drawn twice both live). So the rule above is unchanged for everything it was
 * written about: every row that CAN be in both lists is drawn from the host's
 * alone. What is added is only work the host's list has never heard of.
 */
export function shelfJobs(): Job[] {
  if (hostQueue() === null) return listJobs();
  const rows: Job[] = [];
  for (const held of hostRowsByProject.values()) rows.push(...held.map(copyOf));
  /*
   * AND EVERY ROW OF OURS THAT IS STILL ALIVE — not just the never-routed kinds.
   *
   * A mint is minutes long and drawing nothing for it while hosted would leave a
   * person watching an app that looks idle while it works; that was the original
   * reason and it is unchanged. What it missed is the door the HOST orders work
   * through: `exportEpubFromStep` enqueues here rather than routing (mount.ts's
   * header says why), and while that only ever meant "an export that runs at
   * once" the row was gone before anybody could have looked for it. A deferred
   * one waits — Owen's narrate on a running cleanup orders an EPUB that sits
   * behind it for as long as the cleanup takes — and until this line it sat
   * there invisible in both windows and reachable by no gesture at all: six of
   * them were queued on the Mac before anyone could see one (2026-09-08).
   *
   * ALIVE ONLY, which keeps `runNow`'s rule intact: a settled row leaves this
   * app's list at the settle and does not accumulate in anybody's shelf. What is
   * drawn is work this app is doing or is about to, which is exactly what a
   * queue is for.
   *
   * AND NEVER A TWIN. The rows `runJob` mints for work the HOST scheduled are
   * the host's rows seen from the inside — the host is publishing its half
   * through `setHostQueueRows` and this would publish ours beside it, which is
   * one job drawn twice and is how one Clean text became two identical grayed
   * cards (`hostScheduled`, 2026-09-11). They stay in `jobs`, where every reader
   * that counts real work goes on counting them: `listJobs`, `foundryBusy` and
   * the delete guards, `clearFinished`, the chain verdicts. This is about what is
   * DRAWN. A gesture cannot land on an undrawn row, and the host's own row keeps
   * the ✕ that reaches the host.
   */
  const alive = jobs.filter(
    (job) => !hostScheduled.has(job)
      && (NEVER_ROUTED[job.kind]
        || job.state === 'held' || job.state === 'queued' || job.state === 'running'),
  );
  return [...rows, ...alive.map(copyOf)];
}

/**
 * EVERY ROW ABOUT ONE BOOK, from whichever list is scheduling — the shelf's answer,
 * narrowed to a project.
 *
 * ── Why it is here and not spelled at each caller ──────────────────────────
 *
 * Two places in main derive the promised chain: the IPC doors, which resolve what a
 * plan is aimed at and what a host act is downstream of, and the mount seam, which
 * exports from a step that may not have landed. Both need the same list and both
 * would compose it the same wrong way if left to themselves — `listJobs()`, which
 * hosted holds only the rows Foundry ordered for itself and would answer empty for
 * every chain a person actually made.
 *
 * FOLDED, WHOLE PATH AGAINST WHOLE PATH, through `projectDirOf`. The shelf is one
 * global list across every book on the machine, and this codebase's oldest house
 * rule forbids matching a project by a path's last segment.
 */
export function shelfJobsFor(projectDir: string): Job[] {
  const key = fold(projectDir);
  return shelfJobs().filter((job) => {
    const dir = projectDirOf(job.outputPath);
    return dir !== null && fold(dir) === key;
  });
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
  // The other two text passes, on translate's clause: engine work on the GPU lane,
  // ordered by a person, filed by whoever is scheduling. A cleanup in particular
  // is only ever ordered in a hosted window, so its rows are the host's by
  // construction as well as by this table.
  simplify: false,
  clean: false,
  // Engine work on the GPU lane, ordered by a person. It routes for translate's
  // reason: the host chose when it ran.
  analysis: false,
  // The cleanup's triage, on the cleanup's own clause: ordered in a hosted window
  // with its cleanup behind it, and filed by whoever is scheduling the pair.
  'clean-triage': false,
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
/**
 * IS THIS ROW OURS — the test the two gestures route on, and it is the row's
 * OWNERSHIP rather than its kind.
 *
 * It was `NEVER_ROUTED[job.kind]`, which answered for the mint and the install
 * and nothing else, because nothing else of ours was ever drawn hosted. Now the
 * shelf draws every live row of ours (`shelfJobs`), and a ✕ on one of those has
 * to reach the row it is drawn on: forwarding it to the host would hand a host
 * queue an id from a list it has never seen, which is a button that does
 * nothing. Ours are `randomUUID`s and a host's are its own step ids, so the
 * lists cannot collide; being IN this list is the whole of the question.
 */
function ourRow(id: string): boolean {
  return jobs.some((job) => job.id === id);
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
  /*
   * ── AND THE PUSH IS NEWS, WHICH MEANS IT IS A REASON TO LOOK ───────────────
   *
   * `changed()` NOTIFIES; it does not schedule. So a row of ours waiting on one
   * of the host's — which is every deferred export ordered from a promised step
   * — sat in `queued` after its parent went `done`, because the only thing that
   * had happened was a push, and nothing in this module wakes on one. It would
   * start on the next unrelated thing that pumped: a press in the window, or one
   * of our own jobs settling. For somebody who pressed Narrate and walked away
   * that is never, and Owen watched an EPUB that takes seconds sit for two
   * minutes and stopped it (2026-09-08).
   *
   * A HOST'S PUSH IS THE ONE ANNOUNCEMENT THAT A DEPENDENCY MAY HAVE SETTLED, so
   * it is exactly the moment to reconsider. `pump` re-runs `reconcileChains`
   * first, which is what re-reads `chainVerdict` against the rows that just
   * arrived — and that is also what frees a row whose parent has finished AND
   * been cleared away, and cancels one whose parent is never coming.
   *
   * ONLY WHEN WE ARE HOLDING SOMETHING, because a push arrives for every progress
   * tick of every row the host owns, and `reconcileChains` reads a manifest per
   * waiting row it cannot decide from memory. With nothing of ours queued there
   * is nothing for a pass to start or to cancel, so the guard costs one array
   * scan and saves a disk read on news that cannot concern us.
   */
  if (jobs.some((job) => job.state === 'queued')) void pump();
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
 * The page reader's lifetime hangs off queue drain (`noteQueueIdle`,
 * electron/page-reader.ts) and `keepServerWarmMinutes` DEFAULTS TO 0
 * (electron/app-settings.ts), which is not a short timer — it is an immediate
 * `stopPageReader`. Under a host queue this app's own list is empty between
 * every pair of the host's rows, because the rows live in the host's list until
 * the moment each one runs. Deriving drain from our list would therefore tear
 * the server down after every job and a batch of N readings would pay N model
 * loads, which is three gigabytes loaded N times to read one shelf of books.
 *
 * SO THE HOST SAYS IT, AFTER ITS OWN PUMP HAS CHOSEN — it is the only side that
 * knows whether anything is still coming. BUSY STAYS OURS, because every job
 * start already says so from inside `executeJob`, through `runJob` as much as
 * through `pump`, and a busy signal always beats a pending idle timer.
 */
/**
 * THE RULES ABOUT WHERE WORK MAY GO HAVE CHANGED — the live queue's dial moved.
 *
 * ── Why every park is forgotten and not just one ──────────────────────────
 *
 * `setWaitFor` forgets ONE row's park, because one row was re-pointed. The dial
 * is the other control (`GPU_DIAL_ANY`, shared/slots.ts) and it applies to the
 * whole board: turning it from "3090 Ti" to Any can free every row that was
 * parked for disagreeing with it, and turning it TO a machine can park rows that
 * were about to run. So the backoff every parked row is sitting out is now a
 * timer counting down against a question that has changed, and making somebody
 * wait thirty seconds for a decision they made with a click is the app arguing
 * with the gesture — `setWaitFor`'s own reasoning, one control along.
 *
 * ── AND THE STALE SENTENCE GOES WITH IT ───────────────────────────────────
 *
 * A parked row wears the reason it was turned away ("the queue's GPU dial is set
 * to X"). Leaving that on a row after the dial moved would be the shelf
 * reporting a wait that has been resolved — the defect `setWaitFor` deletes
 * `job.message` to avoid. The next pass writes a true one, or starts the row.
 */
export function venueRulesChanged(): void {
  let woke = false;
  for (const job of jobs) {
    if (job.state !== 'queued') continue;
    forgetPark(job.id);
    if (job.message !== undefined) {
      delete job.message;
      woke = true;
    }
  }
  if (woke) changed();
  if (jobs.some((job) => job.state === 'queued')) void pump();
}

export function hostQueueDrained(): void {
  // AND IT IS NEWS TOO, on `setHostQueueRows`' reasoning and more sharply: the
  // host having nothing left means every parent a row of ours was waiting on has
  // either landed or gone, which is precisely the pair `reconcileChains` exists
  // to tell apart. Same guard, and drained is rare enough that it hardly matters.
  if (jobs.some((job) => job.state === 'queued')) void pump();
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
  // A PRODUCT PATH THAT IS NOT ABSOLUTE IS REFUSED BY NAME, before either queue
  // sees it. Main resolves a relative path against its own working directory,
  // which is nowhere a person chose — a renderer that built the path with the
  // wrong separator once had a whole EPUB written into the host app's repo
  // (2026-09-07). The renderer is the only place such a string can be minted,
  // and this is the one door every request passes through.
  const product = productOf(request);
  if (!path.isAbsolute(product)) {
    throw new Error(
      `The ${request.kind} request names its output as "${product}", which is not an absolute `
      + 'path on this machine, so it would be written relative to the app\'s working directory. '
      + 'Nothing was queued. (A path with backslashes on macOS/Linux is one relative segment.)',
    );
  }
  const host = hostQueue();
  if (host !== null) {
    // THE CHAIN LINK RIDES ON THE REQUEST — `enqueueTextPass` carries the whole
    // argument. A reading is never deferred (`deferralOf` narrows it away), so
    // the guard here is the compiler's rather than a second rule.
    const after = chainedBehind(request);
    return host.enqueue(
      after !== undefined && request.kind !== 'read' ? { ...request, after } : request,
      parentStep,
    );
  }
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
    /*
     * AN IMPLIED EXPORT SAYS WHAT IT IS FOR, in the host's own words for it.
     * `home` is set by exactly one caller — `exportEpubFromStep(…, { to })`, the
     * EPUB a host makes because somebody pressed Narrate and there was no file
     * (shared/types.ts, `ConversionRequest.home`) — so this is not a guess about
     * intent. BookForge's landing row calls itself "Book for narration", and two
     * rows for one act saying it in different words would be worse than either
     * (their session's request, 2026-09-08). Every other export keeps the
     * filename the shelf has always shown it under.
     */
    ...(homeOf(request) !== null
      ? { title: `Book for narration — ${path.basename(outputPath)}` }
      : {}),
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
    // WHAT THIS ROW WILL PUT IN THE TREE, AND WHAT IT WAITS FOR — see
    // `promisedBy`. Absent for everything but an export and a text pass, which is
    // every row this door has minted since it existed.
    ...placedBy(request.kind),
    ...promisedBy(request),
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
/**
 * THE ROW ALREADY WAITING TO MAKE THIS, WHEN "THIS" IS CHAINED ON A PROMISE.
 *
 * ── Why the product path is not enough for a chained pass ───────────────────
 *
 * `pendingFor` dedupes on the product, and for an ordinary press the product is
 * the identity: two presses of "translate to German" from one step name one
 * records file, and the second press finds the first row. A pass chained on a
 * PROMISE breaks that in one case — a deferred simplify carries a PLACEHOLDER
 * product minted fresh at every press (`pendingRecordsFileFor`, shared/ledger.ts,
 * where the eight characters are the step id's), because the real name needs a
 * language the promised chain cannot yet state. Two presses, two placeholders,
 * two rows, and once the parent landed both would resolve to ONE file and the
 * second would fail at spawn with `renameProduct`'s sentence — a refusal an hour
 * late for a mistake made in a second.
 *
 * So a chained pass is deduped on WHAT IT IS rather than on what it will be
 * called: the row it waits on, the act, and the one setting that makes the act
 * this act — the target language of a translation, the mode of a rewrite (a
 * cleanup has neither). Those are exactly the facts `promisedBy` puts on the row
 * (`Job.after`, `Job.into`, `Job.mode`), so the question is asked of the rows
 * and not of the requests, which is what lets it be asked of a HOST's rows the
 * same way — BookForge was asked to key promised passes on the same three
 * (2026-09-07), so both queues answer a double press with one row.
 *
 * ORDINARY PRESSES ARE UNTOUCHED: a request with no `after` is not chained, and
 * this answers undefined before `pendingFor` is asked, exactly as before.
 */
function pendingChained(request: TextPassRequest): Job | undefined {
  const after = request.after;
  if (after === undefined) return undefined;
  const into = request.kind === 'translate' ? request.to : undefined;
  const mode = request.kind === 'simplify' ? request.rewrite : undefined;
  return jobs.find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && job.after === after
      && job.kind === request.kind
      && job.into === into
      && job.mode === mode,
  );
}

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
 * WHAT THE SHELF CALLS A TEXT-PASS ROW, or nothing at all for the one that keeps
 * its book's name.
 *
 * ── The rule, which is older than the third pass ────────────────────────────
 *
 * A row falls back to the project's title, and that is the right answer while a
 * book can only be in the queue for one reason. It stopped being one the moment
 * two different buttons produced the same kind of job about the same book:
 * somebody who queued a rewrite and a translation of one book would be looking at
 * two identically named rows deciding which to Start.
 *
 * SO THE ACT WINS OVER THE BOOK, for every row that has a choice to explain. What
 * is on screen is a short list of things somebody is about to spend a night of GPU
 * on, and "Clean text" is the fact they are checking; the book is one hover away
 * in the row's paths, where every filename in this shelf already lives.
 *
 * A TRANSLATION IS THE ONE THAT SAYS NOTHING, and that is deliberate rather than
 * an omission. It is the ordinary case — the row that has been named for its book
 * since this queue existed — and the two that speak are the two that would
 * otherwise be indistinguishable from it.
 *
 * "Clean text" IS OWEN'S OWN WORD, said the same in all three places a person
 * meets it (2026-09-05): the tile, this row, and — as *"Cleaned for narration"* —
 * the step in the history, which is read later and by somebody else.
 *
 * ONE FUNCTION BECAUSE TWO DOORS COMPOSE A ROW. `enqueueTextPass` and `runJob`
 * both build one, and the title was spread inline in both — two correct copies of
 * a rule, which `productOf`'s own header calls a defect with a delay on it.
 */
function titleForTextPass(request: TextPassRequest): { title: string } | Record<string, never> {
  if (request.kind === 'simplify') return { title: `Simplify — ${REWRITE_LABELS[request.rewrite]}` };
  if (request.kind === 'clean') return { title: 'Clean text' };
  return {};
}

/**
 * WHAT THE SHELF CALLS A CLEANUP'S TRIAGE ROW — the act first, on
 * `titleForTextPass`'s rule, and the act is Clean text's.
 *
 * The two rows sit together in the list, one behind the other, and a person
 * reading them is checking two things: that this is the cleanup they asked for,
 * and which half of it is running. "Clean text — triage" says both, in the shape
 * the rewrite's row already reads in ("Simplify — plain terms"): the act somebody
 * pressed, then what this row of it is. A constant because two doors mint a
 * triage row (`enqueueCleanTriage`, `runDetached`) and a title spelled twice is
 * `productOf`'s defect with a delay on it.
 */
const CLEAN_TRIAGE_TITLE = 'Clean text — triage';

/**
 * Put a TEXT PASS in the queue — a translation, a rewrite or a narration cleanup.
 *
 * Behind whatever is already running, always. The engine holds an Ollama model
 * for the length of a book and a conversion holds a vision model for the length
 * of another; running both means two models resident on one GPU, which on the
 * hardware this is built for is an out-of-memory failure four hours in.
 *
 * IT ROUTES LIKE `enqueue`, and it has no `…Here` twin for one reason: nothing
 * inside this app orders a text pass. Every one of them in Foundry's history
 * arrived from a person filling in a dialog, so this door has exactly one caller
 * per dialog and the branch below IS the door deciding. A second, unrouted door
 * would be a name nobody could prove the need for.
 *
 * ── ONE DOOR FOR THREE KINDS, WHICH IS THE SHAPE OF THE SPLIT ───────────────
 *
 * This was `enqueueTranslate` and it took a `TranslateRequest`, because a rewrite
 * was a translation wearing a mode. Three actions now (Owen, 2026-09-05: *"it
 * isnt a translate job … translate, simplify, and cleanup are all three similar
 * steps"*) and still ONE door, because everything this function does is the same
 * for all three: route to the host if there is one, dedupe on the records file,
 * hold the row, name the act. Three doors with one body is the defect
 * `productOf`'s header is about, arriving at the enqueue instead of at the
 * dedupe.
 *
 * ── AND WHAT ROUTING A `clean` HOSTED MEANS, SAID OUT LOUD ──────────────────
 *
 * It hands the host a request shape whose `kind` its VENDORED SNAPSHOT of
 * `shared/api.ts` may predate (docs/BOOKFORGE-HANDOFF.md §8). That is deliberate
 * and it is not `enqueueAnalysis`'s case: an analysis is refused hosted because
 * nothing over there wants one, where a cleanup exists ONLY on BookForge's behalf
 * (Owen: *"cleanup will only ever be done on behalf of bookforge"*) — the tile is
 * drawn nowhere else, so the only window this door is ever reached from is one
 * whose host asked for the feature. It goes live on the re-vendor, with the
 * handoff doc carrying the note.
 */
export function enqueueTextPass(
  request: TextPassRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): Job {
  const host = hostQueue();
  /*
   * ── THE CHAIN LINK IS COMPOSED BEFORE THE ROUTING, AND HAS TO BE ───────────
   *
   * `chainedBehind` reads `shelfJobs()`, which hosted is the HOST's rows — so the
   * id it answers is one the host minted and one the host's own pump can schedule
   * against. It is put on the REQUEST rather than passed as a third argument
   * because `FoundryHostQueue.enqueue` takes two, and widening a seam somebody
   * else's vendored snapshot declares is a re-vendor; a field on a request shape
   * they already destructure is not (`FoundryJobRow` carries the note).
   *
   * A HOST THAT IGNORES IT gets today's behaviour, which for a promised chain is
   * wrong in the one way that matters — the cleanup and its export race — and is
   * exactly why the handoff doc names the two fields rather than leaving them to be
   * discovered.
   */
  const after = chainedBehind(request);
  const chained: TextPassRequest = after === undefined ? request : { ...request, after };
  if (host !== null) return host.enqueue(chained, parentStep);
  /*
   * WHAT THIS JOB PRODUCES, which for every text pass is the RECORDS — the same
   * question `enqueueHere` asks about a reading and its bank, asked of the same
   * function so the two can never answer it differently. See `productOf`.
   */
  const outputPath = productOf(request);
  const already = pendingChained(chained) ?? pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    // THE KIND IS THE REQUEST'S OWN, where it used to be the literal `'translate'`
    // for all of them. The row is what the shelf lanes, labels and counts, and a
    // cleanup filed as a translation is a row telling the truth only as far as its
    // own title (`JobKind`, shared/types.ts).
    kind: request.kind,
    state: 'held',
    progress: null,
    ...titleForTextPass(request),
    /*
     * A TRANSLATION IS THE STEP THIS FIELD WAS BUILT FOR. It is the one action a
     * person routinely runs from an earlier row — translate from the reading,
     * click back, translate again into another language — and it is the one that
     * runs for hours, which is exactly the window in which a pointer moves. The
     * user's own scenario in the design document is this job twice.
     */
    parentStep,
    // The step this row will land, and the row it waits behind. See `promisedBy`.
    ...placedBy(chained.kind),
    ...promisedBy(chained),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, chained);
  changed();
  // Held, like every other engine job. See this file's header.
  return job;
}

/**
 * THE ROW ALREADY WAITING TO WRITE THIS FILE, IN WHICHEVER QUEUE OWNS THE SHELF.
 *
 * `pendingFor`'s question asked of `shelfJobs()` rather than `jobs`, because the
 * one caller has to ask it BEFORE it knows which queue it is talking to: hosted,
 * `jobs` holds none of the host's rows, and a triaged cleanup already sitting in
 * BookForge's queue would be invisible to the other function. Standalone the two
 * lists are the same array and the two answers are the same row.
 */
function liveOnTheShelf(product: string): Job | undefined {
  return shelfJobs().find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && samePath(job.outputPath, product),
  );
}

/**
 * Put a cleanup's TRIAGE in the queue — the inner door, one row, routed.
 *
 * `enqueueTextPass`'s arrangement exactly: the link composed first and carried on
 * the request, the host handed the request if there is one, and otherwise a HELD
 * row of our own, deduped on its product. Held because it is expensive in the way
 * everything held is — a model on a card for the length of a book — and because
 * the cleanup behind it is held too, so Start commits to the pair together.
 *
 * NOT EXPORTED. Nothing orders a triage on its own: its whole purpose is the
 * cleanup behind it, and a triage row with no cleanup chained to it would spend a
 * model writing a file nothing reads. {@link enqueueTriagedCleanup} is the door.
 */
function enqueueCleanTriage(request: CleanTriageRequest, parentStep: string | null): Job {
  const host = hostQueue();
  // The promise the triage waits on, when its cleanup was pressed on a greyed
  // card — the same composition `enqueueTextPass` makes, for its reason.
  const after = chainedBehind(request);
  const chained: CleanTriageRequest = after === undefined ? request : { ...request, after };
  if (host !== null) return host.enqueue(chained, parentStep);
  const outputPath = productOf(chained);
  const already = pendingFor(outputPath);
  if (already) return already;
  const job: Job = {
    id: randomUUID(),
    inputPath: chained.inputPath,
    outputPath,
    kind: 'clean-triage',
    state: 'held',
    progress: null,
    title: CLEAN_TRIAGE_TITLE,
    parentStep,
    ...placedBy('clean-triage'),
    ...promisedBy(chained),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, chained);
  changed();
  return job;
}

/**
 * PUT A TRIAGED CLEANUP IN THE QUEUE — the triage, then the cleanup chained
 * behind it, as one gesture.
 *
 * ── The ruling (Owen, 2026-09-23) ───────────────────────────────────────────
 *
 * *"we create a list of blocks that need to be cleaned with snap and then we bring
 * snap down and load the full normal cleaning logic."* Two rows, in that order,
 * each on its own model: the triage holds a small `decide` model and writes the
 * verdicts; the cleanup waits behind it and hands the verdicts to `clean-text
 * --triage`, which asks its big model only about what was flagged.
 *
 * ── Why ONE door for the pair, and not the text-pass door twice ────────────
 *
 * Because the pair is only correct if three facts agree, and all three are main's:
 * the verdicts path (named from the cleanup's records file, `cleanTriageFileFor`),
 * the row the book is made from (the same `at`, or the same promise, on both), and
 * the link (the cleanup's `after` is the triage's ROW id, which exists only once
 * the triage is enqueued). A window composing two requests and a link between two
 * IPC calls would be the renderer naming a file and minting a chain — two things
 * this app has only ever let main do — with a moment between the calls in which a
 * Start could release a cleanup chained to nothing. So the window sends the
 * cleanup it already composes, and main makes the pair in one turn.
 *
 * IT IS NOT `queue:enqueue-translate` WITH A FLAG ON IT, either. That door answers
 * with ONE row, and the dialog has to hold both: a server picked in the dialog is
 * pinned on BOTH rows and Start releases BOTH, and a door that returned only the
 * cleanup would leave the triage parked with nobody holding its id.
 *
 * ── A DEFERRED CLEANUP DEFERS ITS TRIAGE ON THE SAME PROMISE ───────────────
 *
 * A cleanup pressed on a greyed card is made from a step that has not landed. Its
 * triage must read that step's book too, so it carries the same `deferred` and
 * waits behind the promising row; the cleanup waits behind the TRIAGE, not the
 * promise, because a row has one parent and the triage's parent already is that
 * promise. The chain is promise → triage → cleanup, and a loss anywhere in it
 * takes everything after it (`cascadeFrom`, or the host's own cascade).
 *
 * ── A CLEANUP ALREADY WAITING TO WRITE THESE ANSWERS IS THE ANSWER ─────────
 *
 * Asked FIRST, before a triage is minted, because a triage minted in front of a
 * cleanup that is not chained to it would spend a model on a file nothing reads.
 * The row already making these records is the work the person asked for — pressed
 * earlier, with or without a triage — and it comes back with whatever triage it
 * waits behind, so the dialog can say "already queued" and watch the real rows.
 *
 * HOSTED, THE HOST'S QUEUE IS THE ONE ASKED, by the same doors: `host.enqueue`
 * twice, the cleanup carrying the host's own id for the triage row as its `after`.
 * A host that honours `after` has implemented the whole of this; one that ignores
 * it runs the two side by side and the cleanup finds no verdicts file, which the
 * engine refuses by name — docs/BOOKFORGE-HANDOFF.md carries the note.
 */
export function enqueueTriagedCleanup(
  request: CleanRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): { triage: Job | null; clean: Job } {
  const standing = liveOnTheShelf(request.recordsPath);
  if (standing !== undefined) {
    const behind = standing.after === undefined
      ? undefined
      : shelfJobs().find((row) => row.id === standing.after && row.kind === 'clean-triage');
    return { triage: behind ?? null, clean: standing };
  }
  const verdicts = cleanTriageFileFor(request.recordsPath);
  const triage = enqueueCleanTriage(
    {
      kind: 'clean-triage',
      inputPath: request.inputPath,
      outputPath: verdicts,
      // THE SAME ROW THE CLEANUP'S BOOK IS MADE FROM, so the two books are one
      // content. Copied as the request states it: an absent `at` stays absent,
      // because absence and null are different claims (`CleanRequest.at`).
      ...(request.at !== undefined ? { at: request.at } : {}),
      ...(request.deferred !== undefined ? { deferred: request.deferred } : {}),
    },
    parentStep,
  );
  const clean = enqueueTextPass({ ...request, triagePath: verdicts, after: triage.id }, parentStep);
  return { triage, clean };
}

/**
 * Put an analysis in the queue.
 *
 * `enqueueTextPass`'s shape, line for line, and the same three decisions:
 *
 *   IT ROUTES, and it has no `…Here` twin. Nothing inside this app orders an
 *   analysis — every one of them arrives from a person filling in the Analysis
 *   dialog — so this door has exactly one caller and the branch below IS the door
 *   deciding. A second, unrouted door would be a name nobody could prove the need
 *   for.
 *
 *   IT IS HELD, like everything expensive. An analysis is minutes of entailment
 *   over every sentence in the book followed by one Ollama call per surviving
 *   passage; a person who queued one and a translation wants to look them both
 *   over and press Start once (docs/ANALYSIS.md §7).
 *
 *   IT DEDUPES ON THE REPORT, which is `productOf`'s answer and therefore the
 *   same rule the reading's bank and the translation's records obey. Two analyses
 *   of one book against one checklist from one step are one job, and the file they
 *   would both write is what says so — and it matters more here than anywhere
 *   else, because that file is also the CACHE: two runs appending verdicts into
 *   one report would interleave two processes' answers into one line-delimited
 *   file.
 */
export function enqueueAnalysis(
  request: AnalyzeRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): Job {
  /*
   * ── IT DOES NOT ROUTE, AND THAT IS SAID HERE RATHER THAN HALF-WIRED ───────
   *
   * `FoundryHostQueue.enqueue` takes the two request shapes the host's own
   * vendored copy of `shared/api.ts` declares, and an analysis is a third one it
   * has never heard of (docs/BOOKFORGE-HANDOFF.md §8 — `app/` is a sealed
   * snapshot laid down at a named commit and never hand-edited on that side). A
   * request pushed at a queue whose types predate it would be a row the host
   * cannot label, cannot lane and cannot spell a command line for.
   *
   * SO THE TILE IS GATED OFF HOSTED (`canAnalyse`, action-menu.component.ts) and
   * the door refuses by name (`queue:enqueue-analysis`, electron/ipc.ts) — two
   * halves of one rule, because a summons with nobody home and a home nobody can
   * summon are how a feature ends up half-built. Running it in Foundry's own
   * queue instead would be worse than refusing: hosted there is no Foundry queue
   * surface at all (Owen, 2026-08-21), so the job would start, hold the card for
   * an hour and be invisible in both windows.
   *
   * This reaches BookForge by the normal re-vendor (docs/ANALYSIS.md §9), and the
   * function that will route it is this one, with a `hostQueue()` branch at the
   * top exactly like `enqueueTextPass`'s.
   */
  const outputPath = productOf(request);
  const already = pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    kind: 'analysis',
    state: 'held',
    progress: null,
    /*
     * THE ROW NAMES THE ACT, on the rewrite's argument one door up. A book can be
     * in this queue for several reasons at once — read it, translate it, analyse
     * it — and a row falling back to the project's title would leave somebody
     * looking at two identically named rows deciding which to Start. What is on
     * screen is a short list of things about to spend a night of GPU, and which
     * act each one is is the fact being checked; the book is one hover away in
     * the row's paths, where every filename in this shelf already lives.
     */
    title: 'Analysis',
    /*
     * THE STEP THE REPORT WILL BE FILED UNDER. An analysis is ordered from a row
     * and runs for an hour, which is exactly the window in which a pointer moves
     * — and where somebody is standing when it lands is nobody's decision, so the
     * press is what the landing appends against.
     */
    parentStep,
    // AND WHICH SLOT IT WILL WAIT FOR, resolved at the press for the same
    // reason `parentStep` is — see `placedBy`.
    ...placedBy('analysis'),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
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
 * RELEASE ONE HELD ROW BY NAME, and nothing else.
 *
 * ── Why this exists beside {@link start} rather than inside it ─────────────
 *
 * Start is a commitment to a BATCH somebody has just looked over — it releases
 * everything held at that moment, which is right for the shelf's own button and
 * wrong for a dialog. Owen, 2026-09-17, on the modals: *"the user can hit
 * 'start', 'add to queue', or 'cancel'. if they hit start, progress shows in the
 * modal live."* A dialog's Start means THIS run. Routing it through `start()`
 * would let go of every other row a person had deliberately parked, which is a
 * batch nobody pressed anything for — the exact failure `start`'s own comment
 * guards against one step further out.
 *
 * ANSWERS WHETHER IT LET GO, and false is not an error: the row may have been
 * released already, may have started, or may have been removed while the dialog
 * was open. All three mean "there is nothing here to release", and a caller that
 * is watching the run finds out what happened from the row itself.
 *
 * HOSTED IT FORWARDS, exactly as Start does, and answers false — zero of
 * FOUNDRY's rows were released because hosted there are none.
 */
export function release(id: string): boolean {
  /*
   * ── HOSTED, THERE IS NOTHING HERE TO RELEASE, AND NOTHING TO FORWARD ─────
   *
   * This first forwarded to `host.start()`, copying what `start()` does one
   * function up. That was wrong in the one way this door exists to avoid: the
   * host's Start releases the host's WHOLE held batch, so a dialog committing
   * to its own book would have let go of every row somebody had parked in
   * BookForge. Worse than the bug it was written to prevent, because the rows
   * belong to another app.
   *
   * It does not need forwarding at all. A hosted enqueue hands the request to
   * the host and answers with the HOST's row (see `enqueue`), and the host's own
   * pump decides when that runs — nobody presses Start for it. So the honest
   * answer is "no row of mine was released", which is the literal truth, and the
   * dialog watches the host's row regardless.
   */
  if (hostQueue() !== null) return false;
  const job = jobs.find((row) => row.id === id);
  if (job === undefined || job.state !== 'held') return false;
  job.state = 'queued';
  changed();
  void pump();
  return true;
}

/**
 * A ROUTING GESTURE THIS QUEUE WILL NOT PERFORM, with the reason as a NAME.
 *
 * The name is the contract and the sentence is the surface: BookForge throws the
 * same `venue_fixed_at_admission` from its own `setWaitFor`, agreed 2026-09-15,
 * so two queues refusing one state refuse it with one word. A caller that wants
 * to branch reads `code`; a caller that wants to tell somebody prints `message`,
 * which is already a whole sentence and needs nothing added to it.
 *
 * IT IS A THROW rather than a returned union because every OTHER outcome of
 * `setWaitFor` is "it happened", and an `{outcome}` union would make all three
 * callers unwrap a success they cannot act on. The two doors that a person
 * drives catch it; the push door does not, because there is nobody there to
 * tell (electron/ipc.ts says so at the handler).
 */
export class QueueRoutingRefusal extends Error {
  constructor(readonly code: 'venue_fixed_at_admission' | 'already_finished', message: string) {
    super(message);
    this.name = 'QueueRoutingRefusal';
  }
}

/** What the shelf calls a row — `labelFor`'s fallback, in one place. */
function rowName(job: Job): string {
  return job.title ?? path.basename(job.outputPath);
}

/**
 * SEND THIS ROW SOMEWHERE ELSE — the picker's one gesture.
 *
 * ── Only a row that has not started ────────────────────────────────────────
 *
 * docs/SLOTS.md §3: *"jobs never start on one slot and finish on another. its
 * atomic."* A `running` row has an engine talking to a server, a records file
 * filling up with that server's answers, and a stamp about to record the model
 * that produced them; moving it would mean one book translated by two machines
 * and one file claiming both.
 *
 * ── IT USED TO REFUSE SILENTLY, AND THE RACE IS WHY THAT WAS WRONG ─────────
 *
 * The argument for silence was *"the picker is not drawn on a running row, and
 * this is the door behind that"* — a guard behind a control nobody is offered.
 * That holds for a row somebody can see is running. It does NOT hold for the one
 * case that actually reaches here: the picker IS drawn on a `queued` row, and
 * since `3b13392` a start *"marks running before its first await"*, so the pump
 * can admit that row between the frame a person read and the message their click
 * sent. The edit then vanished — no change, no sentence, and a picker still
 * showing the machine they had just chosen.
 *
 * So a row that has started refuses BY NAME, and the name is BookForge's:
 * `venue_fixed_at_admission`, agreed 2026-09-15 so that two queues describe one
 * state with one word. Their sentence says the three things a person needs —
 * what took it, that nothing was altered, and the way out — and this says the
 * same three in Foundry's vocabulary.
 *
 * A FINISHED ROW GETS ITS OWN SENTENCE rather than that one. "A GPU took it
 * before your change arrived" is false about a row that ran an hour ago, and a
 * refusal that misdescribes why is worse than none.
 *
 * ── A PARKED ROW IS FREED THE MOMENT IT IS REASSIGNED ──────────────────────
 *
 * The backoff is about the server that turned this row away, and the person has
 * just named a different one. Making them wait out a thirty-second timer for a
 * decision they made with a click would be the app arguing with the gesture, so
 * `forgetPark` runs and the pump looks again immediately.
 *
 * ── Hosted, the row is the host's ──────────────────────────────────────────
 *
 * `remove`'s rule exactly: the id came off a row the host pushed, and there is
 * no row of ours by that name. Nothing is forwarded, because the host's queue
 * has its own placement and its own picker — Foundry does not have an opinion
 * about where somebody else's scheduler sends its work.
 */
export function setWaitFor(id: string, waitFor: string): void {
  const job = jobs.find((row) => row.id === id);
  if (job === undefined) return;
  if (job.state === 'running') {
    throw new QueueRoutingRefusal(
      'venue_fixed_at_admission',
      `"${rowName(job)}" was taken by a GPU on ${job.ranOn ?? 'a server'} before this change `
      + 'arrived, and a book finishes on the machine it started on. Nothing has been '
      + 'altered. Cancel it and add it again to send it somewhere else.',
    );
  }
  if (job.state !== 'held' && job.state !== 'queued') {
    throw new QueueRoutingRefusal(
      'already_finished',
      `"${rowName(job)}" has already ${job.state === 'cancelled' ? 'been cancelled' : 'finished'}, `
      + 'so there is nowhere left to send it. Add it again to run it somewhere else.',
    );
  }
  const wanted = waitFor.trim();
  if (wanted.length === 0 || wanted === job.waitFor) return;
  /*
   * A NAME THAT IS NOT A SLOT IS REFUSED, and `any` is the one reserved word
   * that is not a slot and is always allowed.
   *
   * The picker can offer a STALE name — a row waiting for a server that was
   * switched off keeps it in the list so the select does not silently show
   * something else — but choosing it again is the no-op above, so nothing
   * legitimate reaches here with an unknown name. What this refuses is a message
   * that did not come from a picker, and refusing it is the conservative
   * direction: a typo'd name would be a row that waits forever for nothing.
   */
  if (wanted !== ANY_SLOT && !computeSlots().some((slot) => slot.name === wanted)) return;
  job.waitFor = wanted;
  /*
   * THE SENTENCE ABOUT THE OLD SLOT GOES WITH IT. `message` was "waiting for the
   * Mac, which is switched off"; leaving that on a row that is now waiting for
   * something else would be the shelf reporting a wait that has been resolved.
   */
  if (job.state === 'queued' && job.message !== undefined) delete job.message;
  forgetPark(id);
  changed();
  void pump();
}

/**
 * EVERY ROW OF OURS THAT NAMES THIS SLOT — what the Servers card shows somebody
 * before it changes anything.
 *
 * Owen's rule for a server being switched off is that the rows naming it are
 * SURFACED, never moved: *"told, never moved silently"*. So this answers the
 * question and does nothing about it, and the one-click fix in the card is
 * `setWaitFor` called once per row with {@link ANY_SLOT} — which is a gesture
 * with a person behind it, like every other thing that changes a row.
 *
 * RUNNING ROWS ARE NOT INCLUDED, on `setWaitFor`'s rule: they cannot be moved
 * and offering them in a list of things about to be moved would be a lie about
 * what the button does. A run against a server somebody just switched off
 * finishes against it; switching a server off in a settings card is not a
 * cancel, and the row's ✕ is where a cancel lives.
 */
export function rowsWaitingFor(slotName: string): Job[] {
  return jobs.filter(
    (job) => job.waitFor === slotName && (job.state === 'held' || job.state === 'queued'),
  ).map(copyOf);
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
  if (host !== null && !ourRow(id)) {
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
  /*
   * The row is gone rather than finished, and anybody waiting on it has to hear
   * that too — see `onJobSettled`, which counts this as an ending because for a
   * waiter it is the only one it will ever get.
   *
   * `true` IS OWEN'S HEADLINE CASE. The row is still `held` or `queued` here — it
   * never ran, so its state never moved — which makes this the one ending whose
   * loss cannot be read off the row. *"if i then remove the cleanup step from the
   * queue … everything under that grayed out chain also gets removed."* See
   * `settled`'s second parameter and `cascadeFrom`.
   */
  settled(job, true);
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
  // A row of ours is ours however this window is hosted, and its ✕ is reachable
  // in the hosted shelf because that shelf now draws it — see `ourRow`.
  if (host !== null && !ourRow(id)) {
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
  if (landings.has(id)) {
    /*
     * THE RUN IS LANDING, SO THE ENDING IS ALREADY ITS OWN — `landings` carries
     * the whole argument. There is nothing to stop: the engine has exited, the
     * product is where the row says it will be, and the row is a moment away
     * from settling with what actually happened. Said out loud rather than
     * silently, because a person who pressed ✕ and got a finished job is owed an
     * account of why somewhere.
     */
    console.log(
      `[queue] the ✕ on ${path.basename(job.outputPath)} arrived after the engine had finished; `
      + 'the run is filing what it made and will settle with that.',
    );
    return;
  }
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
 * A CANCELLED READING KEEPS NOTHING — the pages go with the press.
 *
 * ── Owen's ruling, 2026-09-18 ───────────────────────────────────────────────
 *
 * *"when i fully cancel a read, i want nothing kept — back to Pending, same
 * settings, start over from page one."* Put to him with the cost stated plainly
 * (a stop on page 140 of 156 re-buys the whole book, and there is no undo) and
 * reaffirmed. So this is the ending that destroys, and it is the only one in this
 * file that does.
 *
 * A FAILURE IS NOT A CANCEL AND IS NOT TOUCHED. `--fresh` aside, the whole bank
 * lifecycle exists so that a run that DIED leaves its pages resumable
 * (docs/BANK-LIFECYCLE.md §2: *"a dead run leaves the old bank untouched and the
 * pending file as resumable debris. That is the entire point."*). A crashed read
 * that threw away three hours because the engine segfaulted would be the same
 * defect this feature is meant to fix, pointed the other way. Only `cancelled`
 * reaches here, which is a person's press and nothing else.
 *
 * ── THE TWO GUARDS, AND WHY THEY ARE NOT PARANOIA ───────────────────────────
 *
 * A re-read with the same params does NOT write a new bank — `bankForReading`
 * aims it at the existing step's payload and the engine protects the finished
 * answers by writing a PENDING bank beside them and swapping on success
 * (docs/BANK-LIFECYCLE.md §2.2). So at the moment a re-read is cancelled there
 * are two banks on disk and exactly one of them is this run's. Deleting by the
 * name on the request would destroy a COMPLETED reading somebody already paid
 * hours for, to satisfy a gesture about the run that had not finished.
 *
 * So: A PENDING FILE MEANS THE REAL BANK IS SOMEBODY ELSE'S FINISHED WORK. Only
 * the pending pair goes, and the completed reading is left exactly as it was —
 * which is also precisely what "start over from page one" means in that case,
 * because the next re-read opens a fresh pending.
 *
 * AND A COMPLETION MARKER WITH NO PENDING IS A FINISHED BANK THIS RUN WAS NOT
 * WRITING. That pair should be unreachable — §2.2 sends every re-read of a
 * completed bank down the pending path — so it is a state this file does not
 * understand, and the answer to not understanding the disk is to touch none of
 * it and say so. The cost of being wrong in the other direction is somebody's
 * book.
 *
 * ── THE PATH IS THE REQUEST'S AND IS NEVER COMPOSED ─────────────────────────
 *
 * `request.readingsPath`, resolved at the plan by `bankForReading`. Composing
 * `readings/<key>.jsonl` here is the exact defect `readingBank` exists to fix —
 * a project holds two banks the moment a re-read branches — and composing it in
 * order to DELETE it is that bug with the consequence turned up.
 *
 * Best effort and never a throw: the row has already settled as cancelled, and a
 * file that will not unlink must not turn a person's stop into a failure.
 */
async function discardCancelledReading(request: EngineRequest | undefined): Promise<void> {
  if (request === undefined || request.kind !== 'read') return;
  const bank = request.readingsPath;
  /*
   * `<bank>.jsonl.pending` and its sidecar — the ENGINE's spelling
   * (`pendingPath`/`pendingRequestPath`, src/vlm/readings.ts), mirrored here on
   * `shared/records.ts`' grow-together rule because the app never imports the
   * engine. Suffixed rather than renamed so a pending file can never be mistaken
   * for a bank; if that spelling moves, it moves in the same commit as this.
   */
  const pending = `${bank}.pending`;
  const pendingRequest = `${pending}.request`;

  try {
    if (existsSync(pending) || existsSync(pendingRequest)) {
      await fsp.rm(pending, { force: true });
      await fsp.rm(pendingRequest, { force: true });
      console.log(
        `[queue] the cancelled re-reading's pending pages were discarded; the finished reading at `
        + `${path.basename(bank)} is untouched, because that one is not what was cancelled.`,
      );
      return;
    }
    if (existsSync(completionMarkerFor(bank))) {
      console.error(
        `[queue] ${path.basename(bank)} carries a completion marker and has no pending beside it, `
        + 'so a finished reading is sitting where this cancelled run was supposed to be writing. '
        + 'Nothing was discarded — that state is one this build does not understand, and the '
        + 'cautious answer is the only safe one.',
      );
      return;
    }
    await fsp.rm(bank, { force: true });
    await fsp.rm(completionMarkerFor(bank), { force: true });
    await fsp.rm(imagesDirFor(bank), { force: true, recursive: true });
    console.log(
      `[queue] the cancelled reading kept nothing: ${path.basename(bank)}, its marker and its page `
      + 'crops are gone, and the next read starts at page one (Owen, 2026-09-18).',
    );
  } catch (err) {
    console.error(
      `[queue] the cancelled reading's pages could not all be discarded `
      + `(${err instanceof Error ? err.message : String(err)}). A re-read will resume from `
      + 'whatever survived rather than starting over.',
    );
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
  /*
   * AN ANALYSIS LEAVES A SECOND SCRATCH FILE and it goes at the same moment, for
   * the same reason: the checklist beside the report was written at the spawn so
   * a path could be put on the command line, and once the run has settled nothing
   * will ever mention it again. It is a pure function of the step's own params,
   * remade for nothing whenever it is wanted, and leaving it would put an
   * unnamed file in a retained-payload folder — the one thing the `analysis/`
   * layer's own docblock says must not happen there.
   */
  if (request.kind === 'analysis') {
    try {
      await fsp.rm(categoriesFileFor(request), { force: true });
    } catch (err) {
      console.error(`[job] the analysis checklist could not be removed: ${(err as Error).message}`);
    }
  }
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
  /*
   * AND THE NARROWED STAMP THAT WAS WRITTEN BESIDE IT, when one was
   * (`narrowedStamp`, electron/workspace.ts): it is named after the derived book
   * and is scratch on exactly the same terms — one export's withdrawal of a claim
   * over the blocks a merge composed, meaningless the moment that book is gone.
   * The CLEANUP'S OWN stamp is never this path: it lives in `readings/` beside the
   * answers it is a receipt for, and this only ever names a file under the derived
   * directory, because that is the only place this app composes the name.
   */
  const narrowed = `${request.bookPath.slice(0, -'.book.jsonl'.length)}.stamp.json`;
  if (!request.bookPath.endsWith('.book.jsonl')) return;
  try {
    await fsp.rm(narrowed, { force: true });
  } catch (err) {
    console.error(
      `[job] the narrowed narration stamp ${narrowed} could not be removed: `
      + `${(err as Error).message}`,
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
      if (chainStillLive(job.id)) continue;
      requests.delete(job.id);
      envRequests.delete(job.id);
      jobs.splice(i, 1);
    }
  }
  changed();
}

/**
 * IS ANYTHING STILL CHAINED BEHIND THIS ROW — the one row Clear finished leaves.
 *
 * ── Why a done row can still be load-bearing ────────────────────────────────
 *
 * A finished cleanup with a promised export behind it is over as work and NOT over
 * as a chain: the export's `after` names it, and `chainVerdict` reads that name off
 * the list. Sweep the parent and the link goes `unknown`, which sends the export
 * through `reconcileChains` and a ledger read to learn what the row it just lost
 * could have told it for nothing. That path is correct — it is exactly the case it
 * was written for — but paying a file read to answer a question the shelf was
 * holding is the wrong way round, and the window between the sweep and the
 * reconcile is one in which the chain's state is unresolved.
 *
 * AND THE PERSON SHOULD SEE THE CHAIN WHOLE. This is the reason that survives the
 * mechanics. Somebody who cleaned a book and queued its export and its narration is
 * looking at a chain of three; a Clear that took the finished cleanup out would
 * leave two rows describing work whose reason had just been swept off the screen.
 * The tree draws the promises either way — it derives their place from the step id
 * on the row, not from the parent's presence — but the SHELF is where the person
 * watches the batch run, and a batch is a thing you watch whole.
 *
 * IT MIRRORS BOOKFORGE'S OWN RULE, which is worth saying because the two lists are
 * drawn in one window: a settled row is swept only when everything chained under it
 * has settled too. Two queues with two Clear rules would make the same press behave
 * differently depending on which of them happened to own the parent.
 */
function chainStillLive(id: string): boolean {
  const reached = new Set([id]);
  for (;;) {
    let grew = false;
    for (const row of jobs) {
      if (row.after === undefined || !reached.has(row.after) || reached.has(row.id)) continue;
      if (row.state === 'held' || row.state === 'queued' || row.state === 'running') return true;
      reached.add(row.id);
      grew = true;
    }
    if (!grew) return false;
  }
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
 * EVERY LIVE RUN, AND EVERY LEASE IT IS GIVING BACK — the promise a quit can wait on.
 *
 * ── The deadline that was never used (BookForge P9) ────────────────────────
 *
 * `shutdown()` above is synchronous: it kill-trees the children and returns. The
 * host's quit chain wraps `stopFoundry()` in a 45-second budget, and
 * `stopFoundry` answered `Promise.resolve()` — so the budget bounded nothing, and
 * the app went on to exit while the settle that RELEASES THE CRUCIBLE LEASE was
 * still a continuation nobody was holding. A lease left behind is a card no other
 * client can load onto until its TTL expires.
 *
 * ── What it waits for, and why it is two sets ──────────────────────────────
 *
 * THE RUNS. One entry per `executeJob`, added at the top and removed in its
 * `finally`, so it covers the pump's rows and a host's detached ones with one
 * rule — the same reason `executeJob` is one function.
 *
 * THE RELEASES. `settled` fires the DELETE and does not await it, deliberately:
 * a settle must not wait on somebody else's server. That is right while the app
 * is alive and wrong at the moment it exits, which is the only moment this
 * function is called — so the release promises are held here and awaited too.
 *
 * NEVER THROWS, and it is a loop rather than one `Promise.all` because a run that
 * settles may start nothing but may still ADD a release. Settling is what both
 * sets do, so the loop terminates; the caller's own deadline is what bounds a
 * machine that has stopped answering.
 */
export async function drained(): Promise<void> {
  while (liveRuns.size > 0 || releasing.size > 0) {
    await Promise.allSettled([...liveRuns, ...releasing]);
  }
}

/**
 * ONE PROMISE PER LIVE RUN, and one per lease still being given back.
 *
 * Sets of promises rather than counters because `drained()` has to WAIT, and a
 * counter can only be polled. Both are self-emptying: the entry is deleted in the
 * `finally` that put it there.
 */
const liveRuns = new Set<Promise<void>>();
const releasing = new Set<Promise<void>>();

/**
 * WHERE AN ANALYSIS RUN'S CHECKLIST IS WRITTEN — the report's own path plus a
 * suffix, and never a rename of it.
 *
 * ── One derivation, three readers ───────────────────────────────────────────
 *
 * `argsFor` puts it on the command line, the spawn writes it, and the settle
 * removes it. Three places that must agree about one path, which is exactly the
 * shape `productOf` one screen up exists to stop being three correct copies — so
 * it is a function, and the three ask.
 *
 * A SUFFIX ON THE WHOLE PATH, `pendingReportPath`'s own spelling (src/analyze/
 * report.ts): a name composed by replacing an extension is a name that can
 * collide with a real file the day somebody's report is called something else,
 * and appending cannot.
 */
function categoriesFileFor(request: AnalyzeRequest): string {
  return `${path.resolve(request.outputPath)}.categories.json`;
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
/**
 * THE BOOK ON THE COMMAND LINE, or a refusal naming what is missing — the LAST
 * line, not the maker.
 *
 * ── Why the field can be absent at all, and why this guard exists ──────────
 *
 * Since PK6 NO plan makes the book: `materializeAtSpawn` does, inside the run,
 * because a derived book's lifetime is spawn → settle and a path minted at the
 * press outlives its file the moment a row is retried or restored (BookForge's
 * F1/F5, and `TranslateRequest.at` carries the argument). By the time a command
 * line is being assembled the field is therefore always there — and "always" is
 * where this codebase's expensive failures live. A `translate` spelled with no
 * `--book` is a job about no book at all, and the engine's own refusal would name
 * a flag rather than the materialise that never ran.
 *
 * IT THROWS, AND THE CALLER TURNS THAT INTO A FAILED ROW with this sentence on it
 * — the same ending every unmakeable plan in this app has always had.
 */
function bookOf(request: { bookPath?: string }): string {
  if (request.bookPath === undefined) {
    throw new Error(
      'The book this run was to read was never made, so there is nothing to hand the model. That '
      + 'is a fault in this app rather than in the book: the run reached its command line without '
      + 'the materialise that happens the moment it starts.',
    );
  }
  return request.bookPath;
}

/**
 * THE LANGUAGE ON THE COMMAND LINE, or a refusal in main's own words —
 * `bookOf`'s twin, for the field a rewrite can promise but not state.
 *
 * A translation's `--to` was typed by a person and is required on the shape. A
 * REWRITE's is read off the chain (`SimplifyRequest.to`), and a rewrite ordered
 * from a promised translation cannot read it until that translation lands — so
 * `materializeAtSpawn` fills it in when the run starts, and this is the guard that says so if
 * it ever did not. A `--rewrite` with a blank `--to` is a run with nothing to tell
 * the model to write in, which is six hours of a model being asked the wrong
 * question rather than a crash.
 */
function languageOf(request: TranslateRequest | SimplifyRequest): string {
  const said = request.to?.trim() ?? '';
  if (said.length === 0) {
    throw new Error(
      'This rewrite was ordered from a step that had not finished yet, and the language it was to be '
      + 'written in was never resolved — so there is nothing to tell the model to write. Order it '
      + 'again from a step that exists.',
    );
  }
  return said;
}

/**
 * `--model`, `--server` AND `--endpoint`, composed together because they are ONE
 * decision: which machine this act runs on, and in which dialect.
 *
 * ── The three flags used to be spelled in three places, and were one answer ─
 *
 * Each of the branches below spelled `'--endpoint', request.ollama` itself and
 * called `modelArgs` for the other two. That was harmless while the endpoint was
 * always the request's own; with slots it is not — a Crucible placement replaces
 * the endpoint AND the model AND the door together, and three call sites each
 * remembering to apply two thirds of a placement is a translation that runs
 * against the right server with the wrong model. So the placement is applied
 * once, here.
 *
 * ── Where each value comes from ────────────────────────────────────────────
 *
 * The placement wins where it says anything, and null means "the request's own".
 * A Crucible placement carries the server's `<url>/openai` and the model its own
 * capability record selected, and that is now the ONLY thing that ever reaches a
 * real run: `request.model` and `request.ollama` are the declared defaults every
 * dialog fills in, and with no engine connected a text act is refused rather than
 * placed (Owen, 2026-09-15: *"if theres no connected crucible server then tiles
 * should be disabled"*). The null branch survives for the DRY RUN, which has no
 * server to ask — see `argsFor`.
 *
 * ── Why the model can be missing ────────────────────────────────────────────
 *
 * On the OpenAI door a blank field is the ANSWER: the server holds exactly one
 * resident model, and an empty `--model` tells the engine to ask the server, use
 * what it is serving and record that name (src/translate/vllm.ts). Passing
 * `--model ""` would be this file inventing an empty name; leaving the flag off
 * says what is meant. On the Ollama door it is never blank — the request carries
 * a declared default, because an Ollama holds a library and the engine refuses a
 * run that does not say which model it means.
 *
 * ── And `--server` only when it is not the engine's default ─────────────────
 *
 * `openai` is the engine's default (docs/SLOTS.md §2), so writing the flag out
 * for it would put a new word on thousands of command lines to say what they
 * already said. `ollama` is spelled, and so is `anthropic` — the third door
 * (docs/VLLM.md §2), which a CLOUD slot whose provider is Anthropic places onto.
 * A cloud provider of the OpenAI kind places onto the default door and therefore
 * spells nothing, which is right: OpenAI's own API is an OpenAI-compatible
 * server and the only thing that distinguishes it from a vLLM on this line is
 * the endpoint.
 *
 * THE MAPPING IS OVER THE WHOLE UNION AND NOT A TEST FOR ONE VALUE, which is why
 * it is a switch rather than the two ternaries it replaced: the engine refuses
 * an unknown `--server` by name (`--server takes openai, ollama or anthropic,
 * not "x"`), so a fourth door added to `LlmServerKind` without a line here must
 * fail the typecheck rather than silently spawn against the default.
 *
 * NOTHING SECRET IS ON THIS LINE, and that is a rule rather than an observation.
 * A Crucible's token and a provider's API key both travel in the spawn's
 * ENVIRONMENT (`Placement.env`) and never in argv, because argv is spelled into
 * the terminal by `executeJob`, pasted into bug reports, and listed by the
 * process table.
 */
function doorArgs(
  request: { model: string; ollama: string; concurrency?: number },
  placement: Placement,
): string[] {
  const model = (placement.model ?? request.model).trim();
  return [
    ...(model.length > 0 ? ['--model', model] : []),
    ...serverArgs(placement.door),
    '--endpoint', placement.endpoint ?? request.ollama,
    ...concurrencyArgs(request, placement),
  ];
}

/**
 * `--concurrency`, ON EVERY TEXT ACT THAT MEETS A PLACED SERVER.
 *
 * ── Why it is here and not on three command lines ──────────────────────────
 *
 * It was on ONE: the clean branch pushed it from `request.concurrency`, and
 * translate, simplify and analyse never spelled it at all — so the two longest
 * runs in the app took the engine's own default of twelve, against a Crucible
 * chat door that serves one request at a time. That is BookForge's F3a, and the
 * fix is that the answer travels with the PLACEMENT (see `Placement.concurrency`)
 * through the one function every act's door already goes through.
 *
 * THE PLACEMENT WINS. A depth stated by the server that answered is a fact about
 * that machine; a number on the request is a preference about somebody else's
 * backend, and it survives only where there is no placement to overrule it —
 * which is a dry run (`argsFor` defaults to {@link UNPLACED}) and nothing else.
 *
 * A NON-INTEGER OR A ZERO IS NOT A DEPTH, so it is dropped rather than passed on
 * for the engine to argue with; with neither side saying anything the flag is off
 * the line entirely and the engine's own default stands, which is exactly what a
 * `--dry-run` with no server should print.
 */
function concurrencyArgs(
  request: { concurrency?: number },
  placement: Placement,
): string[] {
  const said = placement.concurrency ?? request.concurrency;
  return typeof said === 'number' && Number.isInteger(said) && said > 0
    ? ['--concurrency', String(said)]
    : [];
}

/** `--server`, or nothing at all for the engine's default. See `doorArgs`. */
function serverArgs(door: LlmServerKind): string[] {
  switch (door) {
    case 'openai': return [];
    case 'ollama': return ['--server', 'ollama'];
    case 'anthropic': return ['--server', 'anthropic'];
  }
}

/**
 * EXPORTED FOR ONE CALLER AND ONE PURPOSE: a headless door that wants to print the
 * command line a request WOULD spawn without spawning it (BookForge's
 * `cli/clean-step.js --dry-run`). A dry run that composed its own argv would be a
 * second answer to "what does this request run", and the first time the two drifted
 * the dry run would be reassuring about a command that no longer exists.
 *
 * Nothing here runs anything: it is a pure function of the request.
 */
export function argsFor(
  request: EngineRequest,
  /**
   * The merged metadata patch this product carries, for the ONE route that puts
   * it on the command line rather than stamping it on afterwards — see the
   * compile branch below. Empty for every other job, and for a project whose
   * ancestry recorded nothing.
   */
  metadata: Record<string, string> = {},
  /**
   * WHERE THIS RUN'S COMPUTE GOES — resolved by `executeJob` immediately before
   * the spawn (`placeJob`, electron/crucible-dispatch.ts).
   *
   * DEFAULTED, AND THE DEFAULT IS THE OLD BEHAVIOUR EXACTLY. `UNPLACED` says
   * "Ollama, the request's own endpoint, the request's own model", which is what
   * every line this function composed before slots existed. That keeps the one
   * external caller — BookForge's `cli/clean-step.js --dry-run`, which prints
   * the command a request WOULD spawn — correct without a re-vendor: a dry run
   * has no server to ask and no model to make resident, so the local line is the
   * honest thing for it to print.
   */
  placement: Placement = UNPLACED,
): string[] {
  if (request.kind === 'analysis') {
    /*
     * ── READING THE BOOK AGAINST THE CATEGORIES ───────────────────────────────
     *
     * `foundry analyze --book X --out Y [--categories C] [--model M]
     * [--endpoint U]`. It writes a report and no document at all — a header, one
     * row per candidate passage, and its own question-keyed cache of every rank
     * score and every verdict it paid for (docs/ANALYSIS.md §6).
     *
     * `--endpoint`, `--model` and `--server` ARE ALL `doorArgs`' NOW, and the
     * reason they moved is that they are one answer: where this run's compute
     * goes (docs/SLOTS.md §3). The engine's own settings fallback must never be
     * what decides which machine a job runs on, which is why the flag is always
     * on the line whichever slot won.
     *
     * NO `--nli-python`, AND IT IS AN OMISSION THIS APP CHOSE. The interpreter
     * the entailment worker runs under is resolved by the engine from its own
     * named candidates and `FOUNDRY_NLI_PYTHON`, and a miss ends the run naming
     * every path it tried — which the shelf already shows as the job's error, in
     * the engine's own words. A flag here would be a second place to configure a
     * machine (docs/ANALYSIS.md §9).
     *
     * NO `--fresh`. It exists to throw away answers somebody has already paid
     * for, and there is no gesture in this app that means that: a re-analysis
     * from the same step refreshes the report it already has, and every question
     * whose answer is in there is worth exactly what it cost.
     */
    const args = [
      'analyze',
      /*
       * THE POSITION'S OWN BOOK, materialised by main with every op on the way to
       * it replayed in (`planAnalysis`, electron/workspace.ts). A struck row is
       * not in it and a retyped paragraph is in it as the person left it — which
       * is what makes the report's character offsets agree with the paper the
       * panel draws them over.
       */
      '--book', bookOf(request),
      '--out', request.outputPath,
      ...doorArgs(request, placement),
    ];
    /*
     * THE CHECKLIST, AS A FILE BESIDE THE REPORT — written by `spawnOf` at the
     * moment the child starts rather than composed onto this line.
     *
     * It cannot be a flag value: the engine's `--categories` takes a PATH to a
     * JSON list, and the list carries a name and an enabled flag per entry
     * (`buildPlan`, src/analyze/plan.ts). And it must not be written at plan
     * time, on `seedRecords`' rule: a held job that is removed must leave the
     * project exactly as it found it, and a file written at the plan would sit
     * there named by no step.
     */
    if (request.categories.length > 0) args.push('--categories', categoriesFileFor(request));
    return args;
  }
  if (request.kind === 'clean-triage') {
    /*
     * ── WHICH BLOCKS NEED CLEANING AT ALL ─────────────────────────────────────
     *
     *   foundry clean-triage --book X --out V --endpoint <crucible> --model M
     *
     * NOT `doorArgs`, and the difference is the whole of this branch. `doorArgs`
     * spells a CHAT door — `<engine>/openai`, a `--server` dialect, the request's
     * own model and endpoint when nothing was placed. The triage asks none of
     * those: it POSTs Crucible's `/v1/decide`, which reads the resident model's
     * belief in two letters, so it needs the ENGINE'S BASE ADDRESS
     * (`Placement.origin`) and the id of the model the placement made resident
     * and leased. There is no dialect to name and no default to fall back on.
     *
     * AN UNPLACED TRIAGE IS REFUSED BY NAME, which is the one thing this branch
     * decides. `UNPLACED` is what a dry run hands this function, and for every
     * other act it prints the request's own pair; a triage has no pair of its own
     * (`CleanTriageRequest` carries no model and no endpoint, deliberately), so a
     * line composed without a Crucible would be a command pointed at nothing.
     *
     * `--concurrency` ONLY FROM THE REQUEST. The placement's number is a CHAT
     * door's admission (`Placement.concurrency`) and says nothing about the
     * decide door, which bounds its own questions.
     *
     * THE CREDENTIAL IS IN `placement.env` AND NEVER HERE, on the rule every
     * placed line in this file keeps: the engine reads `FOUNDRY_ENDPOINT_HEADERS`.
     */
    if (placement.origin === null || placement.model === null) {
      throw new Error(
        'This check of which blocks need cleaning was not placed on a Crucible server, so there is '
        + 'no model to ask. It runs only on a Crucible that can judge text; add or switch on one '
        + 'under Settings › Crucible Servers.',
      );
    }
    return [
      'clean-triage',
      '--book', bookOf(request),
      '--out', request.outputPath,
      '--endpoint', placement.origin,
      '--model', placement.model,
      ...concurrencyArgs(request, UNPLACED),
    ];
  }
  if (request.kind === 'clean') {
    /*
     * ── SAYING THE BOOK AGAIN SO A NARRATOR CAN READ IT ───────────────────────
     *
     *   foundry clean-text --book X --records Y --stamp Z [--endpoint U] [--model M]
     *
     * A THIRD COMMAND RATHER THAN A FOURTH FLAG ON `translate`, and the engine's
     * side made that decision: what a cleanup does to a paragraph is not a
     * translation's prompt with different words in it — it normalises punctuation
     * and typography against a spec, and it refuses an edit that changes what the
     * sentence says. A run that can REFUSE ITS OWN ANSWER on grounds a translation
     * has never heard of is a different command.
     *
     * `--book` IS THE POSITION'S OWN, materialised by main with every op replayed
     * in (`planCleanup`, electron/workspace.ts) — the same route `--book` takes on
     * the two lines below this one, and for the same reason: a struck row is not in
     * it, so nothing about a strike crosses the boundary and the records that come
     * back are keyed by the ROWS' OWN IDS.
     *
     * `--records` IS THE CACHE AS WELL AS THE PRODUCT, exactly as it is for a
     * translation: an unchanged block's question is already answered in there and
     * is never asked twice, and every answer is appended the moment it is accepted.
     * A cleanup interrupted at block 900 of 2,000 resumes for the price of the
     * remaining 1,100.
     *
     * `--stamp` IS THE ONE FLAG NO OTHER COMMAND IN THIS FILE HAS. It writes what
     * the run WAS — normaliser version, punctuation spec, model, hour, and whether
     * any edit was refused — beside the answers, so the EPUB compiled from them can
     * carry it into the OPF (`--narration-stamp`, the compile branch below) and a
     * narrator can tell a cleaned book from an uncleaned one without asking this
     * app anything.
     *
     * `--endpoint` AND NOT `--ollama`, which USED TO BE the one place this line
     * differed from its siblings' spelling for the same fact. The engine's own
     * command declares it that way, every text act declares it that way now, and
     * `doorArgs` spells it once for all three — a flag renamed on the way through
     * would be this file having an opinion about somebody else's CLI.
     *
     * NO `--to`, NO `--from`, NO `--rewrite`. A cleanup goes into no language and
     * asks no mode — see `PARAMS_OF.clean` (shared/ledger.ts) for the ledger half
     * of the same sentence.
     */
    const args = [
      'clean-text',
      '--book', bookOf(request),
      '--records', request.recordsPath,
      '--stamp', request.stampPath,
      ...doorArgs(request, placement),
    ];
    /*
     * `--triage` WHEN A TRIAGE RAN IN FRONT OF THIS ROW (`CleanRequest.triagePath`).
     * Only the flagged blocks are asked; the rest are recorded as examined and
     * clean. Absent is today's run exactly — every block put to the cleaner.
     */
    if (request.triagePath !== undefined) args.push('--triage', request.triagePath);
    /*
     * `--concurrency` IS `doorArgs`' NOW, with the endpoint and the model it
     * belongs beside — see `concurrencyArgs`. It was pushed here and on no other
     * text line, which is how translate and simplify came to run twelve deep
     * against a serial door.
     */
    /*
     * NO `--keep-model` ANY MORE. The engine neither loads nor unloads a model
     * since Owen's ruling of 2026-09-13 — the operator owns what is resident —
     * so the flag is gone from the engine and a line carrying it would die at
     * its argument parser before a block was read.
     */
    /*
     * The reading these answers are about, written into every row and read by
     * nobody in the engine — `Overlay.generation`'s contract, exactly as the
     * translate line below carries it.
     */
    if (request.generation !== undefined && request.generation.length > 0) {
      args.push('--generation', request.generation);
    }
    return args;
  }
  if (request.kind === 'translate' || request.kind === 'simplify') {
    /*
     * A translation shares nothing with a conversion's command line but the
     * program name. No `--format` and no `--out`: this run writes RECORDS, one
     * row per flowing block keyed by the block's own position in the reading
     * bank, and the engine refuses an `--out` beside `--records` by name because
     * the EPUB it would write is a book nobody would ever open.
     *
     * `--endpoint`, `--model` and `--server` are `doorArgs`' — one answer about
     * where this run's compute goes, applied once (docs/SLOTS.md §3). The
     * engine's settings fallback must never decide which machine a job runs on,
     * so the flag is on the line whichever slot won.
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
      '--book', bookOf(request),
      '--records', request.recordsPath,
      '--to', languageOf(request),
      ...doorArgs(request, placement),
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
     *
     * IT IS THE KIND THAT DECIDES IT NOW, where it used to be the presence of a
     * field: `SimplifyRequest.rewrite` is required, so the flag is on this line
     * exactly when the job is a rewrite and never because a mode was left over on
     * a request somebody built by spreading another one.
     */
    if (request.kind === 'simplify') args.push('--rewrite', request.rewrite);
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
    /*
     * ── A READING THAT WAS PLACED ON A CRUCIBLE SAYS SO ON THE LINE ──────────
     *
     * The note above this function said *"No `--vlm-endpoint`. The settings
     * screen owns which backend reads the pages"*, and that was the whole truth
     * while `CRUCIBLE_READS` was false: there was one reader, the settings file
     * named it, and the engine read the same file. Owen's ruling made pages a
     * dispatched class like any other (crucible-dispatch.ts), so there is a
     * SECOND owner of that question now — the placement — and it wins for the
     * one run it is about. Without these two flags the engine would fall back to
     * `backend.endpointUrl` and post the pages to this machine's own reader,
     * which is a placement nothing honoured and a card nothing accounted for.
     *
     * THE TEXT DOOR'S `--endpoint` AND THIS ONE ARE SPELLED DIFFERENTLY BY THE
     * ENGINE, and that is why `/v1` is appended here rather than stored on the
     * placement. `normaliseVllmEndpoint` (src/translate/vllm.ts) adds the version
     * prefix for the text path; `--vlm-endpoint` is used exactly as given
     * (src/vlm/endpoint.ts composes `<it>/chat/completions`), which is why the
     * local reader's own URL is `http://localhost:8000/v1`. One placement, two
     * dialects, and the difference is said here instead of silently working on
     * one path and 404ing on the other.
     *
     * THE TOKEN IS NOT ON THIS LINE. It is in `placement.env`, as it is for every
     * other act, and `resolveEndpointHeaders` (src/backend/endpoint-headers.ts)
     * is what the reading path already reads it through.
     */
    if (placement.endpoint !== null) {
      args.push('--vlm-endpoint', `${placement.endpoint.replace(/\/+$/, '')}/v1`);
      if (placement.model !== null && placement.model.length > 0) {
        args.push('--vlm-endpoint-model', placement.model);
      }
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
    /*
     * ── AND THE RECEIPT, WHEN THESE WORDS WERE CLEANED FOR A NARRATOR ─────────
     *
     * `--narration-stamp <that step's stamp.json>` puts `bookforge:narration-text`
     * into the OPF of the EPUB this run writes, so the FILE says what was done to
     * it and a narrator opening it months later needs nothing from this app.
     *
     * COMPOSED BY THE PLAN AND NEVER HERE (`planRendering`, electron/workspace.ts),
     * off `cleanupInEffect` at the step this rendering is about — which is the
     * position for a press and the named row for a host's export. Deciding it here
     * would mean this function walking a ledger it does not have, at spawn time,
     * about a position that may have moved since the button.
     *
     * IT RIDES THE COMPILE ROUTE BECAUSE THAT IS WHERE THE EPUBS ARE. Every epub
     * and txt export materialises and compiles (`planRendering`'s `compiles`), so
     * this branch is the only one that writes a book from a position a cleanup can
     * be in effect at — the branch below reprints a scan's photographed pages,
     * which is a facsimile and has no narration in it.
     *
     * A `.txt` COMPILE CARRIES IT TOO AND IT COSTS NOTHING: there is no OPF in a
     * text file, the engine writes nothing, and withholding the flag from one of
     * the two formats would be this file deciding which products the engine's own
     * command applies to.
     */
    if (request.narrationStamp !== undefined && request.narrationStamp.length > 0) {
      args.push('--narration-stamp', request.narrationStamp);
    }
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
  /** The request's own project, for a file written outside it (`homeOf`). */
  home: string | null = null,
): Promise<Record<string, string>> {
  const dir = home ?? projectDirOf(outputPath);
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

/*
 * `endpointFor()` WENT WITH THE FALLBACK IT FED (2026-09-17).
 *
 * It answered the settings file's `backend.endpointUrl`, in `endpoint` mode
 * only, and its one caller used that to decide whether to start Foundry's own
 * page reader for a reading with no placement. Owen: *"there sohuldnt be a
 * local system. foundry does all ai work through crucible."* With no local
 * reader to start, a URL in that file names nothing this app would dial, and a
 * reader with no caller is a question nobody asks.
 */

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
 * WHICH LANE THIS ROW WILL HOLD, when that is knowable before the walk — or null
 * for a row the walk decides for, and for every row that holds no compute lane.
 *
 * ── Two of the three answers are knowable, and reserving them is the point ──
 *
 * `pump` picks rows in a SYNCHRONOUS loop, so two rows can be chosen before
 * either of them has reached its first await. If the lane were only ever claimed
 * inside the walk, two readings would both be picked against one free local lane
 * and the second would discover the collision minutes later, park, and wear a
 * sentence about a machine it was never going to get. So the answers that do not
 * need a server are settled here, before the pick:
 *
 *   * A ROW THAT IS NEVER PLACED holds the LOCAL lane — `placesOnASlot` is that
 *     test and lives beside the switch that decides half of it. An export never
 *     gets here (it is not a GPU row at all); what does is a job whose dispatch
 *     this app does not route, and if it held no lane the board would start a
 *     translation on the same card.
 *   * A BOARD WITH ONE LANE holds it, whatever the row says. One machine and one
 *     answer: the walk would claim the same lane, and reserving it before the
 *     pick is what keeps two rows in ONE synchronous pump pass apart. This is
 *     every hosted window (`computeLanes` answers an empty slot list with the
 *     local lane) and every desk with no Crucible.
 *   * EVERYTHING ELSE answers null: the walk picks, and the walk claims.
 *
 * ── A PINNED ROW USED TO RESERVE HERE, AND NO LONGER CAN (Wave 62) ─────────
 *
 * It returned `job.waitFor`, which was right while a slot was one lane. A
 * Crucible slot is TWO now — its card, and the `[cloud]` lane an upstream-routed
 * act takes (`upstreamLaneName`, shared/queue-board.ts) — and WHICH of them a row
 * belongs in is a fact only that server's capability row knows. Reserving the
 * card here would hold a GPU for the length of a network read that was going to
 * end somewhere else entirely, and then keep holding it for the whole run. So the
 * pinned path claims where the `any` path claims: inside the walk, after the
 * route is read (`placeOn`, electron/crucible-dispatch.ts, whose note argues the
 * move in full).
 *
 * WHAT THAT COSTS is that two rows pinned to one machine can both be picked in
 * one pass. The second reaches the claim, is refused, and parks with the walk's
 * own sentence and the ordinary backoff — which is exactly what two `any` rows
 * have always done. What still cannot happen is two runs on one card.
 */
function laneAtPick(job: Job, lanes: readonly ComputeLane[]): string | null {
  if (JOB_RESOURCE[job.kind] !== 'gpu') return null;
  /*
   * A GPU ROW THAT IS NEVER PLACED TAKES THIS MACHINE'S CARD, when one of the
   * lanes IS this machine's card — which since Wave 66 means a Crucible
   * registered at a loopback address, there being no local slot any more. NULL
   * when there is none: there is no lane to reserve, and inventing a name for one
   * would be a reservation against a machine the board does not have.
   *
   * THE ARM IS UNREACHABLE WHILE `CRUCIBLE_READS` IS TRUE and is kept for the
   * reason it was written: it is the constant that decides it, not a fact about
   * the kind. Every GPU kind has a capability class today, so `placesOnASlot` is
   * true for all of them; the day a reading goes back on the local path, this is
   * the line that keeps two of them off one card.
   */
  if (!placesOnASlot(job.kind)) return localLane(lanes)?.name ?? null;
  if (lanes.length === 1) return lanes[0]!.name;
  return null;
}

/** Is any run holding that lane right now? The occupancy, asked by name. */
function laneTaken(lane: string): boolean {
  for (const slot of slots.values()) if (slot.on === lane) return true;
  return false;
}

/**
 * IS THERE ROOM FOR THIS ROW RIGHT NOW — the whole of the rationing.
 *
 * ── The four answers, and why an install is not simply another lane ─────────
 *
 * The CPU LANE has room when fewer than `CPU_LANE_SLOTS` are held. The GPU side
 * is not a lane but a LANE PER COMPUTE SLOT (`computeLanes`,
 * shared/queue-board.ts): a row may start when there is a lane it could take,
 * which is why this takes the row and not just its resource — a row pinned to the
 * Mac and a row pinned to this desk are asking two different questions, and the
 * answer to one of them is not the answer to the other. That is the whole of
 * Package G in the scheduler: before it, a busy local card stopped a queued row
 * that was only ever going to run in another room.
 *
 * AN INSTALL needs the whole board, because a conversion that starts against a
 * Python being replaced is the one failure the shared queue was built to prevent
 * — see the header. And `unscheduled` cannot get here from a queued row at all (a
 * mint is born `running`); it answers true so that a row which somehow arrived in
 * that state fails loudly through the missing-request branch, exactly as it did
 * when the pump took any queued row it found, rather than sitting in the list
 * forever and holding the drain open with it.
 *
 * ── THE COUNT AND THE NAME ARE BOTH ASKED, and neither alone is enough ──────
 *
 * A row whose lane is knowable is refused when that lane is taken. A row the walk
 * decides for is refused when every lane is spoken for — counted rather than
 * named, because a walking row's lane is not settled yet. The count is sound
 * without being exact: at worst one more row is admitted than there is room for,
 * it finds every candidate claimed, and it parks with the backoff every other
 * wait uses. What cannot happen is two runs on one machine, and that is the
 * claim's job rather than this one's (`LaneClaim`).
 */
function canStart(job: Job, lanes: readonly ComputeLane[]): boolean {
  const resource = JOB_RESOURCE[job.kind];
  if (resource === 'unscheduled') return true;
  for (const slot of slots.values()) {
    // An install holds every lane while it runs, so nothing joins it.
    if (slot.resource === 'exclusive') return false;
  }
  if (resource === 'exclusive') return slots.size === 0;
  let held = 0;
  for (const slot of slots.values()) if (slot.resource === resource) held += 1;
  if (resource === 'cpu') return held < CPU_LANE_SLOTS;
  /*
   * ── A BOARD WITH NO GPU LANE ADMITS THE ROW SO IT CAN BE REFUSED ──────────
   *
   * Since Wave 66 the GPU side is one lane per registered Crucible and nothing
   * else (Owen: *"there should be no local gpu listed in the queue"*), so a
   * machine with no server registered has NO GPU lane. The ceiling below would
   * then be zero and every GPU row would sit queued for ever, unstarted and
   * unexplained — *"a row that neither fails nor finishes is worse than either"*.
   *
   * So the row is let through, and the PLACEMENT refuses it by name one step
   * later (`placeJob`, electron/crucible-dispatch.ts: *"no GPU engine is
   * connected — add one in Settings › Servers"*). It reserves nothing on the way:
   * `laneAtPick` has no lane to give it, and the walk it is about to enter has no
   * candidate to claim.
   */
  if (lanes.length === 0) return true;
  /*
   * THE CEILING IS THE SUM OF THE LANES' CAPACITIES, not the number of lanes.
   * It was the count while every lane took one run; a server's `[cloud]` lane
   * takes two (Wave 62, `UPSTREAM_LANE_CAPACITY`), and counting lanes would hold
   * the second forwarded job behind a board that has room for it.
   */
  let ceiling = 0;
  for (const lane of lanes) ceiling += lane.capacity;
  if (held >= ceiling) return false;
  const wants = laneAtPick(job, lanes);
  return wants === null || !laneTaken(wants);
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
 *
 * ── THE LANES ARE THE CALLER'S, READ ONCE PER PASS ──────────────────────────
 *
 * `computeSlots()` reads the settings file (and, hosted, calls into the host), so
 * asking it per row would be a file read per queued row per pump. `pump` reads it
 * once and hands it down, which is also the more correct shape: every row in one
 * pass is rationed against one picture of the board, where a list that changed
 * halfway down would mean two rows of the same queue answered by two boards.
 */
function nextStartable(lanes: readonly ComputeLane[]): Job | null {
  for (const job of jobs) {
    if (job.state !== 'queued') continue;
    /*
     * A ROW THAT ALREADY HOLDS A SLOT HAS BEEN PICKED, whatever its state says.
     * The slot is set the moment `pump` chooses a row, and `runInSlot` marks the
     * row running before its first await — but the slot is the claim, and the
     * picker reads the claim rather than trusting that every start path will
     * always flip the state in time. Without this line the queue spun the host
     * to death twice on 2026-09-11: a CPU-lane row (two lanes) was picked, its
     * slot held, and its start awaited `materializeDeferred` before anything set
     * `running`, so the synchronous `for (;;)` in `pump` — inside which no
     * microtask ever runs — saw the same queued row, the same one free lane, and
     * picked it again, forever, one `runInSlot` promise per turn until the heap
     * hit 8 GB. The GPU side escaped only because it had ONE lane at the time,
     * which made `canStart` false after the first pick — it has one per machine
     * now (Package G), so it would spin exactly the same way and this line is the
     * only thing that stops either of them.
     */
    if (slots.has(job.id)) continue;
    /*
     * ── AND A ROW PARKED WAITING FOR A SERVER IS SKIPPED UNTIL ITS TIME ──────
     *
     * A row whose slot was busy is back in this list wearing the reason, and it
     * is skipped rather than held because the two are opposites on a board: a
     * hold would stop every row behind it on somebody else's narration, and this
     * one concerns nobody but itself. The timestamp is what keeps it from being
     * a poll — see `parkedUntil`, which argues the whole shape.
     *
     * BEFORE THE CHAIN CHECK, because it is cheaper and answers more often: a
     * parked row is parked whatever its parent is doing.
     */
    const until = parkedUntil.get(job.id);
    if (until !== undefined && Date.now() < until) continue;
    /*
     * ── AND A ROW WAITING ON A PROMISE IS SKIPPED, NOT BLOCKED ────────────────
     *
     * `Job.after` names the row this one is downstream of, and the board is
     * precisely the thing that would otherwise get it wrong: an export is a CPU
     * row and the cleanup it is an export OF is a GPU row, so without this the
     * export steps straight past its own parent into the free lane, compiles the
     * book WITHOUT the cleanup, and files it in `final/` under the name the cleaned
     * one was going to have. Silent, plausible, and discovered in a narration.
     *
     * SKIPPED RATHER THAN A BARRIER, which is the opposite of the install rule two
     * paragraphs up and is right for the opposite reason. An install stops the walk
     * because everything behind it would run against the environment it is
     * replacing; a promised chain concerns nobody but itself, and holding the whole
     * queue behind one cleanup would make a person's unrelated reading wait on it.
     *
     * `chainVerdict` ANSWERS `wait` FOR AN UNRESOLVED LINK AS WELL, which is the
     * safe direction: `reconcileChains` runs at the top of every pump and turns
     * every unresolved link into `go` or into a cascade, so a row that is still
     * unresolved here is one this pass could not decide and the next pass will.
     */
    if (chainVerdict(job) !== 'go') continue;
    if (JOB_RESOURCE[job.kind] === 'exclusive') return canStart(job, lanes) ? job : null;
    if (canStart(job, lanes)) return job;
  }
  return null;
}

/**
 * WHAT THE ROW THIS ONE WAITS BEHIND IS DOING — the queue's half of the answer.
 *
 * `go` — nothing to wait for, or the parent has landed.
 * `wait` — the parent is still in the list and has not finished.
 * `lost` — the parent is in the list and ended without producing anything.
 * `unknown` — there is no such row, and only the LEDGER can say why.
 *
 * ── `unknown` IS THE CASE THAT HAD TO BE ADDED, AND IT IS NOT AN EDGE ───────
 *
 * An absent parent row is NOT a lost parent. The obvious reading — no row, no
 * parent, cancel the chain — is wrong in the ordinary case: the cleanup finished an
 * hour ago and somebody pressed Clear finished, or a host swept its own list, and
 * the step is sitting in the ledger exactly where it was promised. Treating that as
 * a loss would cancel an export whose parent had SUCCEEDED. So the queue answers
 * "I cannot tell" and `reconcileChains` asks the ledger, which is the only place
 * the difference is recorded.
 */
function chainVerdict(job: Job): 'go' | 'wait' | 'lost' | 'unknown' {
  if (job.after === undefined) return 'go';
  /*
   * THE SAME SHELF `chainedBehind` COMPOSED `after` FROM — `shelfJobs()`, which
   * hosted is the HOST's rows and standalone is our own. This read `jobs`, our
   * own list only, and hosted that list never holds the row a chain waits on:
   * the clean was queued on BookForge's engine, its row crossed as a host row,
   * `after` named that row's id, and this lookup answered undefined → 'unknown'
   * → the ledger was asked → "never landed" → the export was cancelled with
   * "nothing in the queue is going to make it" while the queue was making it
   * (Owen, the Mac, 2026-09-08). A host row carries `state`, which is all the
   * verdict reads.
   */
  const parent = shelfJobs().find((row) => row.id === job.after);
  if (parent === undefined) return 'unknown';
  if (parent.state === 'done') return 'go';
  if (parent.state === 'failed' || parent.state === 'cancelled') return 'lost';
  return 'wait';
}

/**
 * EVERY UNRESOLVED CHAIN LINK, SETTLED AGAINST THE LEDGER — run at the top of every
 * pump, before anything is chosen.
 *
 * ── The question, and why the ledger is the only place it is answered ───────
 *
 * A row waiting on an id that is in nobody's list is in one of exactly two states,
 * and they demand opposite answers:
 *
 *   THE PARENT LANDED AND WAS CLEARED. The step is in the ledger; this row's whole
 *   reason to wait is discharged; it should run. `after` is dropped rather than
 *   satisfied-and-kept, because the link's other job is the cascade and there is
 *   nothing left to cascade from — the parent is a fact now, not a promise.
 *
 *   THE PARENT WAS LOST. No row, no step: whatever was going to make it left the
 *   queue between the press and now. This is Owen's *"or it otherwise gets lost
 *   along the way"*, and the answer is the same as a removal's.
 *
 * WHAT IS ASKED FOR IS THE STEP AND NOT THE ROW. `deferred.from` where the request
 * carries one, and `Job.parentStep` otherwise — the second is the host seam's case,
 * where Foundry chained an export behind a row it did not plan (`exportEpubFromStep`
 * with a promised step). A row that names neither has nothing to check and is let
 * through, which is the honest answer: it was chained behind something, that
 * something is gone, and nothing here can say whether it succeeded.
 *
 * ── ASYNC, WHICH IS WHY IT IS NOT INSIDE `nextStartable` ────────────────────
 *
 * Reading a ledger is reading a file, and the chooser is synchronous by
 * construction: `pump()`'s loop reserves a slot BETWEEN two calls to it, and an
 * await in there would let two passes choose the same row. So the file reads happen
 * once, before the loop, and the chooser sees only the queue.
 *
 * IT NEVER THROWS. An unreadable manifest, a project that has moved, a ledger this
 * build refuses — none of those is a reason to wedge the whole scheduler, and the
 * row keeps waiting (its `after` is left alone) rather than being cancelled on the
 * strength of a file that would not open. The console keeps the record.
 */
async function reconcileChains(): Promise<void> {
  const waiting = jobs.filter(
    (job) => job.after !== undefined && (job.state === 'queued' || job.state === 'held'),
  );
  for (const job of waiting) {
    if (chainVerdict(job) !== 'unknown') continue;
    const request = requests.get(job.id);
    const wanted = (request === undefined ? undefined : deferralOf(request)?.from)
      ?? job.parentStep ?? null;
    if (wanted === null) {
      delete job.after;
      continue;
    }
    // The request's own project first: a host's implied export lies outside
    // every project and would otherwise be un-chained here as an orphan.
    const dir = (request === undefined ? null : homeOf(request)) ?? projectDirOf(job.outputPath);
    if (dir === null) {
      delete job.after;
      continue;
    }
    let landed: boolean;
    try {
      landed = ledgerOf(await readManifest(dir)).steps.some((step) => step.id === wanted);
    } catch (err) {
      console.error(
        `[queue] ${dir} could not be asked whether "${wanted}" landed `
        + `(${err instanceof Error ? err.message : String(err)}); the row goes on waiting.`,
      );
      continue;
    }
    if (landed) {
      delete job.after;
      continue;
    }
    /*
     * NEITHER IN THE QUEUE NOR IN THE LEDGER — the loss. Cancelled and removed with
     * its own chain behind it, by the same hand a removal uses, so a person sees the
     * whole promised subtree go at once rather than one row per pump.
     */
    job.state = 'cancelled';
    job.error = 'The step this was to be made from never landed, and nothing in the queue is going '
      + 'to make it.';
    job.finishedAt = Date.now();
    void sweepDerivedBook(requests.get(job.id));
    const index = jobs.indexOf(job);
    if (index >= 0) jobs.splice(index, 1);
    requests.delete(job.id);
    settled(job);
  }
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
  /**
   * THE SAME LINES, FOR THE LOG — and it is not a duplicate of `watch`.
   *
   * `watch` is the row's reporter: a host parses counts out of it and draws a
   * bar, and a reporter with a bug in it throws. `line` is the copy that goes to
   * a FILE, called in the reporter's `finally`, so a listener's throw cannot cost
   * the log the line that explains the failure — which is exactly what happened
   * on 2026-09-19, when a night of hosted failures left `grep -c '[job]'` over
   * every log answering 0 (BookForge P5/F7).
   */
  line?(line: string): void;
  /**
   * WHERE THIS RUN WAS PLACED, once, BEFORE the engine is spawned.
   *
   * The host writes it into its own in-flight ledger so a hard kill has something
   * to release the Crucible LEASE with — the one thing the startup sweep could not
   * cover, because the lease is taken in here and recorded nowhere (BookForge P8).
   * Announced before the spawn for that reason: a record written after the child
   * exists is a record that can be missed by the kill it is for.
   */
  placed?(placement: RunPlacement): void;
}

/**
 * THE ENGINE'S LAST WORDS, kept for the one caller that is not the row.
 *
 * `next.error` carries the whole stderr for a failed run and always has; what it
 * cannot carry is the case where the row is then STOPPED, which erases it
 * (BookForge P6). A host's outcome is handed the tail separately so its own log
 * has a copy that nothing on this side can overwrite. Keyed by job id, written at
 * the one arm that knows the stderr, and consumed by `runDetached` — a map rather
 * than a field on the row because it is not a fact about the row, it is a fact
 * about the child that has just exited.
 */
const lastEngineStderr = new Map<string, string>();

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
  /*
   * ── THE CHAINS FIRST, BECAUSE THE CHOOSER CANNOT ASK A DISK ────────────────
   *
   * A row waiting on a parent that is in nobody's list is either free to run (the
   * parent landed and was cleared) or lost (the parent never landed), and only the
   * ledger knows which — see `reconcileChains`. It runs here, once, awaited, before
   * a single slot is reserved: `nextStartable` must stay synchronous or two passes
   * of the loop below would choose the same row.
   *
   * IT IS ALSO WHY THE LOOP SEES A SETTLED PICTURE. Anything this resolves is
   * resolved before the first `nextStartable`, so a chain freed by a landing that
   * happened while the queue was quiet starts on this pass rather than on the next
   * thing that happens to call `pump`.
   */
  await reconcileChains();
  /*
   * THE BOARD, AS THE WHOLE OF THIS PASS SEES IT. Read after the await and
   * before the first pick, once — see `nextStartable`, which argues why the
   * list is a parameter rather than something each row asks for itself.
   */
  const lanes = computeLanes(computeSlots());
  for (;;) {
    const next = nextStartable(lanes);
    if (next === null) break;
    /*
     * THE LANE IS RESERVED IN THE SAME BREATH AS THE SLOT, and for the same
     * reason: both are claims, and both have to be visible to the next turn of
     * this synchronous loop. `laneAtPick` answers null for a row whose lane the
     * walk decides — see `Slot.on`, which argues the three states.
     */
    const slot: Slot = {
      id: next.id,
      resource: JOB_RESOURCE[next.kind],
      on: laneAtPick(next, lanes),
      cancel: null,
    };
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
   * follows the queue's (electron/page-reader.ts) and `keepServerWarmMinutes`
   * DEFAULTS TO 0 — which is not a short timer, it is `stopPageReader` now, with
   * no window for a busy signal to beat it. An early drain therefore does not
   * waste a little warmth; it pulls the model out from under whatever is still
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
  /*
   * A ROW BEHIND AN UNFINISHED PROMISE DOES NOT HOLD THE DRAIN OPEN, and the line
   * is `held`'s own distinction reaching a row that is spelled `queued`.
   *
   * An export ordered from a promised cleanup is enqueued `queued`, because a
   * rendering never waits for a person (`enqueueHere`) — but this one does: its
   * cleanup is `held` until somebody finds the shelf and presses Start, which can be
   * tomorrow. Counting it as work the board is about to do would keep the page
   * reader resident for exactly as long, with `keepServerWarmMinutes`
   * defaulting to 0 and nothing left running to justify it. What it is waiting for
   * is a PERSON, which is the one thing the drain has never counted.
   */
  /*
   * THE DRAIN USED TO ARM A COUNTDOWN AND NOW TELLS NOBODY.
   *
   * noteQueueIdle(minutes) kept the local reading server warm for a while after
   * the last job so the next book did not pay the load. There is no local
   * server to keep warm (2026-09-17), and the engines that do the work hold
   * their own models on their own terms -- so the whole computation went with
   * it, the `waiting` test included, which existed only to decide whether the
   * countdown should be armed over a row that was waiting on a PERSON.
   */
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
    const held = requests.get(job.id);
    if (held === undefined) {
      job.state = 'failed';
      job.error = 'The job lost its configuration before it started.';
      changed();
      settled(job);
      return;
    }
    /*
     * ── THE PROMISE BECOMES A REQUEST, HERE AND IN `runJob` AND NOWHERE ELSE ──
     *
     * The two doors onto `executeJob` are the two moments a job actually starts, so
     * they are the two places a deferred plan can be made real — and `executeJob`
     * itself is deliberately not one of them: it is the shared body, and putting a
     * plan call in there would make a hosted run and a standalone run two behaviours
     * again (its own header forbids exactly that).
     *
     * THE STORED REQUEST IS REPLACED, not merely the local one, because two other
     * readers of it outlive this line: `sweepDerivedBook` has to know about the book
     * the re-plan just materialised or it will leave it in the temp directory
     * forever, and `cancelHere` reads the same map when the ✕ arrives mid-run.
     *
     * A REFUSAL IS A FAILED ROW WITH MAIN'S OWN SENTENCE, which is the shape every
     * unmakeable plan in this app already takes — the same arm the missing-request
     * branch above uses, for the same reason: there is nothing to spawn and the
     * person is owed the reason.
     */
    /*
     * MARKED RUNNING BEFORE THE FIRST AWAIT, and that ordering is the point. Until
     * Wave 56 (688c888) `executeJob` did this as the first synchronous thing after
     * the pick, and everything that reads state — the picker, `remove`, which
     * splices a QUEUED row out from under whatever holds it — could take "queued"
     * to mean "nobody has this". `materializeDeferred` put an await in front of
     * that mark, and for as long as it was pending the row was both claimed and
     * queued: `remove` would take it away while its start went on to run it, and
     * the picker would choose it again (see `nextStartable`, which now also reads
     * the slot). Materialising a deferred request is a ledger read and a plan,
     * which is work on this row's behalf; "Starting…" is the honest word for it,
     * and the message `executeJob` writes a moment later is the same one.
     */
    job.state = 'running';
    job.startedAt = Date.now();
    job.message = `Starting ${path.basename(job.inputPath)}…`;
    changed();
    /*
     * ── AND THE MATERIALISE IS NOT HERE ANY MORE (PK6) ──────────────────────
     *
     * It was: `materializeDeferred(held, job)` ran between the mark and
     * `executeJob`, and its throw was caught and filed here — in BOTH doors, which
     * is two copies of one ending. It has moved inside the run (`carry`, beside the
     * seed copy and the checklist) for the rule those two state about themselves: a
     * row that turns out to be waiting for a busy card must leave the project
     * exactly as it found it, and a book materialised before the placement is a
     * file written on the way to a wait. `executeJob`'s own boundary files the
     * throw now, which is the ending every other unmakeable plan already had.
     */
    await executeJob(job, held, {
      claim: (cancel) => { slot.cancel = cancel; },
      release: () => { slot.cancel = null; },
    });
  } finally {
    slots.delete(job.id);
    void pump();
  }
}

/**
 * ── THE WAIT LEDGER: WHEN A PARKED ROW MAY BE LOOKED AT AGAIN ──────────────
 *
 * A row whose slot is busy goes BACK TO `queued` wearing the reason, and that is
 * the whole shape of waiting for a server in this app. The alternative — holding
 * the lane while the Mac finishes a narration — would mean one unreachable
 * server stopping every other job on the board: a lane is one machine
 * (`computeLanes`, shared/queue-board.ts), a row sitting in it is a row nothing
 * can run beside, and a row waiting for a machine it has not got is a row holding
 * a lane it is not using. Package G made that worse rather than better, which is
 * worth saying: a row parked on the Mac's lane would now be blocking the Mac
 * specifically, so a person watching the bench would see an idle card with a job
 * apparently in it.
 *
 * WHICH MAKES A TIMESTAMP NECESSARY. `pump` re-picks any `queued` row it can,
 * synchronously, in a loop — so a row parked and immediately re-picked would be
 * a poll as tight as the CPU allows, hammering somebody else's server with
 * capability reads. This map is the only thing standing between that and a
 * denial of service against a machine that is merely busy.
 *
 * NOT ON THE ROW, deliberately. It is scheduling state, it is meaningless to a
 * host mirroring rows, and a wire field that ticked would make every renderer
 * repaint on a clock. What the person sees is `Job.message`, which already says
 * the sentence.
 */
const parkedUntil = new Map<string, number>();

/**
 * RUNS THE ENGINE PARKED — the park sentence by job id, from the arm that read
 * exit `ENGINE_PARKED_EXIT` to the door that has to say it.
 *
 * A pump-driven row never lands here: the arm re-queues it itself, after the
 * settle, with `parkedUntil`. A detached run (`runJob` at the host's seam, or the
 * dialog's own) has no pump to come back to, so the sentence is left for
 * `runDetached` to pick up and answer with as `parked` — the fifth outcome, and
 * the one that keeps a stale socket from being filed as a failed row.
 */
const parkedRuns = new Map<string, string>();

/**
 * HOW LONG A PUMP-DRIVEN ROW SITS OUT AFTER THE ENGINE PARKED — one minute.
 *
 * Not `parkDelay`'s three-seconds-doubling: that backoff is for a placement that
 * was refused before anything ran, and the engine has just spent about eight
 * minutes of its own budget waiting on the same server. A minute is long enough
 * that the next attempt is not the ninth try at a socket that has been dead for
 * nine, and short enough that a proxy that came back is used while somebody is
 * still watching.
 */
const PARK_AFTER_WEATHER_MS = 60_000;

/**
 * THE LEASE EACH RUNNING ROW HOLDS ON A CRUCIBLE'S RESIDENT MODEL.
 *
 * Off the row for `parkedUntil`'s reason and one stronger: a lease is a live
 * object with a timer in it, and `Job` is a wire shape that crosses the preload
 * and is copied to a host. Keyed by job id here, taken out and released in
 * `settled`, which is the one place every ending in this file passes through.
 */
const leases = new Map<string, Lease>();

/** How many times each parked row has been turned away. Drives the backoff. */
const parkCount = new Map<string, number>();

/**
 * THE BACKOFF — a few seconds, doubling, capped at half a minute.
 *
 * The cap is what makes the whole thing honest rather than clever: a server that
 * has been narrating for an hour is checked twice a minute forever, which costs
 * nothing and means the row starts within thirty seconds of the card coming
 * free. An unbounded backoff would eventually be a row that waits hours after
 * the thing it was waiting for ended.
 */
function parkDelay(id: string): number {
  const seen = (parkCount.get(id) ?? 0) + 1;
  parkCount.set(id, seen);
  return Math.min(30_000, 3_000 * 2 ** (seen - 1));
}

/** This row is no longer waiting for anything. Called on every settle. */
function forgetPark(id: string): void {
  parkedUntil.delete(id);
  parkCount.delete(id);
}

/**
 * RESOLVE WHERE THIS RUN GOES, or take the row out of this call's hands.
 *
 * Returns the placement when the job may start now. Returns NULL when it may
 * not, having already published what happened — which is one of two endings:
 *
 *   * PARKED. The row is `queued` again, wearing the sentence about what it is
 *     waiting for, and `parkedUntil` holds the picker off until the backoff is
 *     up. `runInSlot`'s `finally` gives the lane back and pumps, so the board
 *     carries on with everything else while this one waits.
 *   * FAILED. The refusal would be the same on every machine — an unknown model,
 *     a class this build's servers do not have — so it is said once, on the row,
 *     and the row is settled like any other refusal.
 *
 * ── A run nobody scheduled waits IN PLACE, and that is not a special case ──
 *
 * `runJob` (a host's scheduler) and `runNow` (the Export dialog) both reach
 * `executeJob` without taking a lane, and both have a caller awaiting a SETTLED
 * row — `executeJob`'s own contract. Parking one would resolve that caller with
 * a queued row it has no pump to rescue, so those wait here instead, with the
 * same backoff and the same sentence on the row. `slots.has` is what tells them
 * apart, and it is the truth rather than a proxy for it: the lane IS the pump's
 * claim on this row.
 *
 * ── AND IT IS WHAT DECIDES WHETHER THE WALK MAY CLAIM A LANE ───────────────
 *
 * The same one fact, read a second time. A run this scheduler picked has a slot
 * record, and the walk's claim writes the machine it settled on into it
 * ({@link LaneClaim}); a run nobody here scheduled has none, and its claim says
 * yes to everything — a host's queue rations its own machine and a queue that
 * second-guessed it would be holding the host's row against a board the host
 * cannot see (see `detachedRuns`, which argues the whole posture).
 */
/**
 * ONE LINE, OUT TO WHOEVER IS LISTENING — the row's reporter, then the log.
 *
 * ── Why the log is in the reporter's `finally` ─────────────────────────────
 *
 * They are the same lines and they are not the same listener. `watch` is a
 * caller's PARSER — a host reads counts out of it and draws a bar — and a parser
 * has bugs; `line` is a copy going to a FILE. Called in sequence, a throw from
 * the first would take the second with it, and the line that explains the failure
 * is exactly the line a broken parser is most likely to throw on.
 *
 * So the log is written whatever the reporter does, and the reporter's throw is
 * logged rather than raised: `settled`'s rule, one listener's bug is not another's
 * engine.
 */
function sayOutward(line: string, about: string, wires: RunWires): void {
  try {
    wires.watch?.(line);
  } catch (err) {
    console.error(
      `[queue] a progress listener threw for ${about}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    try {
      wires.line?.(line);
    } catch { /* a log that throws is never worth a run */ }
  }
}

type Placed =
  | { go: true; placement: Placement }
  /**
   * NOT THIS CALL'S ANY MORE. `wait` is non-null only for a run NOBODY HERE
   * SCHEDULED — a host's row, which has a scheduler of its own to hand it back
   * to. For a row on this board the park has already happened and this is null.
   */
  | { go: false; wait: PlacementWait | null };

async function placeRun(
  next: Job,
  request: EngineRequest,
  wires: RunWires,
  /**
   * THE RUN'S ONE ENDING, borrowed from the boundary — `executeJob`, which owns
   * the counting. A refusal here is an ending like any other, and it is counted
   * with the rest for the same reason: there is one `settled` per run, and the
   * catch one function out has to know whether it has already happened.
   */
  settle: () => void,
): Promise<Placed> {
  const held = slots.get(next.id) ?? null;
  /*
   * ONE LANE PER RUN, so taking the next candidate gives the last one back: the
   * field is a single name and the claim overwrites it. A lane this run already
   * holds — the pump reserved it, or the walk claimed it on an earlier pass of
   * the backoff — is granted again rather than refused by its own reservation.
   *
   * ── AND A LANE'S WIDTH IS NOT ALWAYS ONE ANY MORE (Wave 62) ──────────────
   *
   * A card lane takes one run; a server's `[cloud]` lane takes two, because
   * nothing of ours is on that machine's GPU and what is being rationed is an
   * account's rate limit rather than a card (`UPSTREAM_LANE_CAPACITY`,
   * shared/queue-board.ts, which argues the number). So the holders are COUNTED
   * against the lane's own capacity instead of the first one refusing everybody.
   *
   * THE BOARD IS RE-READ HERE rather than threaded down from `pump`, and that is
   * a deliberate second read: `placeRun` is reached again on every pass of the
   * backoff, minutes apart, and a capacity taken from the list as it was when the
   * row was first picked would be this run rationing itself against a board
   * somebody has since edited. A lane the list no longer carries is width one,
   * which is the honest reading of a machine that has left.
   */
  const lanesNow = computeLanes(computeSlots());
  const claim: LaneClaim = (lane) => {
    if (held === null) return true;
    if (held.on === lane) return true;
    const capacity = lanesNow.find((entry) => entry.name === lane)?.capacity ?? 1;
    let taken = 0;
    for (const other of slots.values()) {
      if (other.id !== held.id && other.on === lane) taken += 1;
    }
    if (taken >= capacity) return false;
    held.on = lane;
    return true;
  };
  const say = (line: string): void => {
    if (next.state === 'cancelled') return;
    next.message = line;
    changed();
    // The placement's own lines go out with the engine's: "Loading dots-ocr on
    // <server>" is a thing this run said, and a log that only has the engine's
    // half cannot explain the twenty minutes before it spawned.
    sayOutward(line, next.outputPath, wires);
  };
  /*
   * ── ONE ASKING, AND NO LOOP (PK6) ─────────────────────────────────────────
   *
   * This was `for (;;)` with a backoff inside it, and for a row on this board it
   * still parks and is re-picked — that part is the pump's and is unchanged. What
   * it also did was SPIN for a run nobody here scheduled: a detached `runJob`
   * holds no lane to give back, so the loop re-asked with a growing delay, capped
   * at 30 s, for as long as the card stayed busy, and the host's row sat in
   * `running` with no way to say why.
   *
   * That is a second scheduler with a 30-second opinion, inside a function whose
   * whole contract is that somebody else decides when. So a detached run's wait
   * is RETURNED, typed, the moment the placement says it — and the host parks its
   * own row, on its own clock, with the holder's own sentence on it.
   */
  {
    const placementAbort = new AbortController();
    wires.claim(() => {
      placementAbort.abort();
      // No child exists yet. Drop this callback before the normal cancel path
      // marks and settles the row, otherwise cancelHere calls it again.
      wires.release();
      cancelHere(next.id);
    });
    let outcome: Awaited<ReturnType<typeof placeJob>>;
    try {
      outcome = await placeJob(request.kind, next.waitFor, say, claim, placementAbort.signal);
    } finally {
      wires.release();
    }
    // Placement can wait for a remote model load for minutes. A cancellation
    // in that interval has already settled this row; never revive it, and give
    // back a lease that arrived after the settle could see it.
    if (next.state === 'cancelled') {
      if (outcome.verdict === 'go' && outcome.placement.lease !== null) {
        await outcome.placement.lease.release();
      }
      return { go: false, wait: null };
    }
    if (outcome.verdict === 'go') {
      forgetPark(next.id);
      /*
       * WHERE IT ACTUALLY WENT, beside where it was told to wait. `waitFor` is
       * the person's choice and must not be overwritten by a walk's answer — a
       * row pinned to `any` that happened to land on the Mac is still a row that
       * will take whatever is free next time. This is the other half of the
       * sentence, and it is what the shelf shows while the run is alive.
       */
      /*
       * A PLACEMENT WITH NO SLOT RECORDS NO MACHINE. Since Wave 66 that is a job
       * which never meets a model — an export, a compile, a mint — and it runs on
       * this machine's cores by the ruling that keeps the CPU lane local. An
       * absent `ranOn` is what every reader already understands as "here"
       * (`laneOfRun`, shared/queue-board.ts); writing the name of a slot the list
       * no longer carries would be a sentence about a machine nothing else names.
       */
      if (outcome.placement.slot !== null) next.ranOn = outcome.placement.slot.name;
      else delete next.ranOn;
      /*
       * AND WHETHER IT WAS FORWARDED, which is the other half of "where it went"
       * and the thing that puts the row in the server's `[cloud]` lane rather
       * than on its card (`laneOfRun`, shared/queue-board.ts). `ranOn` stays the
       * MACHINE — it is what the shelf says out loud — and this is the upstream's
       * name beside it. Absent is a run on a card, which is every run this app
       * has ever recorded.
       */
      if (outcome.placement.via !== null) next.ranVia = outcome.placement.via;
      else delete next.ranVia;
      /*
       * THE LEASE GOES WHERE THE SETTLE CAN FIND IT, immediately, before anything
       * can throw. `settled` is the one ending every path in this file reaches,
       * and a lease the map never learned about would be a claim on somebody's
       * card that nothing releases until it expires.
       */
      if (outcome.placement.lease !== null) leases.set(next.id, outcome.placement.lease);
      changed();
      return { go: true, placement: outcome.placement };
    }
    if (outcome.verdict === 'refuse') {
      forgetPark(next.id);
      next.state = 'failed';
      next.error = outcome.reason;
      next.finishedAt = Date.now();
      changed();
      settle();
      return { go: false, wait: null };
    }
    const delay = parkDelay(next.id);
    if (held !== null) {
      next.state = 'queued';
      next.message = outcome.reason;
      next.note = null;
      /*
       * `startedAt` GOES BACK, because this row did not start. Leaving it set
       * would make the shelf's elapsed clock count the waiting as run time, and
       * a person reading "3h 12m" off a job that has not spoken to a model yet
       * would reasonably conclude it was wedged.
       */
      delete next.startedAt;
      parkedUntil.set(next.id, Date.now() + delay);
      changed();
      /*
       * NOTHING WAKES THE PUMP ON ITS OWN. It runs when a row ends and when one
       * is enqueued, and a board that has gone quiet with one parked row on it
       * would sit there until somebody pressed something. One timer per park,
       * armed for the backoff, is what closes that.
       */
      const timer = setTimeout(() => { void pump(); }, delay);
      timer.unref?.();
      return { go: false, wait: null };
    }
    /*
     * A RUN NOBODY HERE SCHEDULED HANDS THE WAIT BACK. The sentence is the
     * holder's own and `standing` says whether time alone will ever fix it, which
     * is the difference between a card somebody is using and a class this machine
     * cannot serve. Both are waits; only one of them is worth re-asking on a clock.
     *
     * `forgetPark` because this row is not parked HERE: the backoff ledger belongs
     * to the board, and a count left behind would be handed to the next attempt as
     * though this one had been waiting on our own clock.
     */
    forgetPark(next.id);
    say(outcome.reason);
    return { go: false, wait: outcome };
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
 *
 * ── AND THAT LAST SENTENCE IS ENFORCED NOW, RATHER THAN ASSERTED ───────────
 *
 * It was a promise this function made about itself and nothing kept. Every
 * landing in `carry` below is an unguarded await AFTER `placeRun` has recorded a
 * lease — `recordReading`, `landReadProducts`, `recordAnalysis`, `recordFinal`
 * and the rest — and so is `runEngine` itself, whose `engineCommand()` throws by
 * design when the app folder has no engine bundle (engine.ts). Neither caller catches: `runInSlot`'s `finally`
 * frees the slot and pumps, `runDetached`'s drops the abort listener, and both
 * let the rejection past. So a throw left the row `running` for ever, and
 * because the only `clearInterval` on the lease heartbeat lives inside
 * `release()` — which only `settled` calls — the beat went on renewing a
 * two-minute claim on somebody's card for the life of this process. A card
 * nothing can load onto, on behalf of a run that ended. `exportEpubFromStep`
 * (electron/mount.ts), which awaits the ending, never resolved either.
 *
 * THE BOUNDARY IS HERE AND NOT IN THE CALLERS, for the reason this function is
 * one function at all: there are two schedulers and there must not be two
 * answers to "what happens when a run blows up". A catch in `runInSlot` would
 * have to be written again in `runDetached`, and the next door onto this
 * function would be the third place to forget it.
 *
 * IT IS NOT A SWALLOW. The console gets the whole error — object and all, so a
 * stack survives — and the row gets the error's own message, which is the shape
 * every deliberate failure arm in `carry` already uses.
 */
async function executeJob(
  next: Job,
  request: EngineRequest,
  wires: RunWires,
): Promise<PlacementWait | null> {
  /*
   * ── THE ONE ENDING, SAID ONCE, WHOEVER SAYS IT ────────────────────────────
   *
   * `carry` reaches `settled` down ten different arms and the catch below is an
   * eleventh, so the idempotence cannot live at any one of them. It lives here,
   * in the closure both sides call: the first caller wins and every caller after
   * it is a no-op. That matters for exactly one reachable case — `settled` itself
   * runs `cascadeFrom`, which is somebody else's code and can throw after the
   * listeners have already been told — and the wrong answer there is a second
   * ending for a job that has already had one.
   *
   * `over` IS READ BY THE CATCH TOO, and not only through this function: a row
   * that has already settled `done` must not be rewritten to `failed` behind the
   * back of the listeners that were handed it.
   */
  /*
   * THIS RUN, WRITTEN DOWN WHILE IT IS ALIVE — see `drained`, which is what a
   * quit waits on. Registered before the first await and dropped in the `finally`
   * below, so the set is exactly the runs that have not finished.
   */
  let over = false;
  let ended = (): void => undefined;
  const live = new Promise<void>((resolve) => { ended = resolve; });
  liveRuns.add(live);
  const settle = (): void => {
    if (over) return;
    over = true;
    settled(next);
  };
  try {
    return await carry(next, request, wires, settle);
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    /*
     * WHOLE, AND WITH THE ERROR OBJECT BESIDE IT. A throw out of here is a
     * defect rather than an engine's refusal, so the stack is the useful half
     * and a message-only line would throw it away. The terminal is where
     * somebody is already looking — the same argument the engine-failed line
     * below in `carry` makes for printing stderr in full.
     */
    console.error(
      `\n[job] ${next.kind} THREW — ${path.basename(next.inputPath)} — ${said}\n`,
      err,
    );
    /*
     * THE ROW IS ONLY REWRITTEN IF NOTHING HAS ENDED IT, and there are two ways
     * something already has.
     *
     * `over` is this run's own ending, said down one of `carry`'s arms; reaching
     * here with it set means the throw came out of `settled` itself, after every
     * listener had been handed a row, and turning that row into a `failed` one
     * now would make the shelf and the waiters disagree about what happened.
     *
     * A `cancelled` ROW IS THE OTHER, AND IT IS SOMEBODY ELSE'S. `cancelHere`
     * settles a row that has no live child of its own, which is every moment
     * BEFORE the spawn — the minutes a job spends waiting for the reading
     * server, and the file preparation after it — so the ending is already out
     * and it is not this one. (While the child is alive the ✕ kills it and the
     * close handler says what happened; from the moment it exits the row is
     * landing and the ✕ is refused — `landings`, which is what makes this
     * sentence true rather than hopeful.) A cancel is a person taking their GPU
     * back, and filing it as a failure is how a host's retry restarts work they
     * just stopped (`runJob`, which argues the three states).
     */
    if (!over && next.state !== 'cancelled') {
      next.state = 'failed';
      next.error = said;
      next.finishedAt = Date.now();
      changed();
      settle();
    }
    // A THROW IS NOT A WAIT. The row has its ending; there is nothing for a
    // scheduler to re-ask.
    return null;
  } finally {
    /*
     * AND THE LANDING MARK GOES, ON EVERY WAY OUT — the rotation's `finally` one
     * function down, for its reason: a mark left behind is a row whose ✕ is dead
     * for ever, and the alternative is clearing it at each of the arms that end
     * a run plus whichever is added next. `carry` enters it beside
     * `wires.release()`; this is the one place it can be left from.
     */
    landings.delete(next.id);
    liveRuns.delete(live);
    ended();
  }
}

/**
 * WHAT A JOB DOES, from the placement to the landing — `executeJob`'s body, and
 * the only reason it is a second function is that a boundary cannot catch what
 * it is inside of.
 *
 * `settle` IS THE CALLER'S, and every ending below goes through it rather than
 * through `settled` directly: see `executeJob`, which owns the counting.
 */
async function carry(
  next: Job,
  /**
   * THE REQUEST AS IT WAS STORED — identity only. The book, the seed and the
   * generation are made from it INSIDE this function (`materializeAtSpawn`), which
   * is why this is a `let` in all but name: what the engine is handed is the
   * resolved copy, and `requests` is updated to it so the settle sweeps the file
   * this run actually made.
   */
  request: EngineRequest,
  wires: RunWires,
  settle: () => void,
): Promise<PlacementWait | null> {
  if (next.state === 'cancelled') return null;
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
  const rendering: ConversionKind | null = request.kind !== 'read'
    // NO TEXT PASS IS EVER AN EXPORT — the family, where this named the
    // translation alone: none of the three writes a document, so there is
    // nothing to file in the tray and nothing to rotate aside for.
    && !isTextPassRequest(request)
    // AN ANALYSIS IS NEVER AN EXPORT, and the line is here rather than left to
    // the `export` field's absence because the narrowing this const performs is
    // what every reader below depends on. A report is not a rendering: nothing
    // is filed in the tray, no metadata is stamped onto it and no document is
    // rotated aside for it.
    && request.kind !== 'analysis'
    // NOR A CLEANUP'S TRIAGE, on the analysis's argument exactly: its verdicts
    // file is not a document, and nothing about it belongs in the tray.
    && request.kind !== 'clean-triage'
    && request.export === true
    ? request.kind
    : null;
  /*
   * ── ONE EXPRESSION, TWO FACTS: IS THIS AN EXPORT, AND IN WHAT FORMAT ──────
   *
   * It was a boolean, and the narrowing it performed was what every reader below
   * depended on. The materialise further down replaces `request` with the resolved
   * copy, and an assignment ends the compiler's narrowing — so the FORMAT is taken
   * here, while the shape is still narrow, and the boolean is derived from it.
   * Null is every kind that has no format at all: a reading, the three text passes,
   * an analysis, and a rendering nobody asked to export.
   */
  const exporting = rendering !== null;

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
   * two-stage job — which meant a plain Generate still stood up the whole
   * reading backend and waited for a server it would never address. Pressing a
   * button labelled with a file format lit up the GPU, and the shelf said
   * "Starting the reading server…" over a job that is arithmetic; the user
   * reasonably read that as the model being run again. The exceptions were the
   * majority, so the rule is stated the other way round: the job that reads
   * waits, and nothing else does.
   *
   * WHAT COMES BACK IS TWO FLAGS FOR THE COMMAND LINE, and they are collected
   * here because this is the only moment anything in this app knows them. The
   * served model id is whatever `/v1/models` actually answered — our own
   * llama-server says `dots.ocr` because `--alias` told it to, an adopted vLLM
   * says `rednote-hilab/dots.ocr` — and handing the engine the wrong one would
   * refuse a working server by name in `confirmServedModel`. The concurrency is
   * ours only when the server is: see `PAGE_READER_CONCURRENCY`.
   *
   * ── AND IT HAPPENS AFTER THE PLACEMENT NOW (Wave 62, Package K) ───────────
   *
   * It used to be the first thing a reading did, before `placeRun` had been
   * called at all — which was correct while `CRUCIBLE_READS` was false and every
   * reading ran on this desk. It is not correct now that a reading is dispatched
   * like any other act (crucible-dispatch.ts, whose note carries Owen's ruling):
   * starting first would pull three gigabytes onto this card for a reading that
   * was about to be sent to another machine, and then leave them there.
   *
   * SO THE TEST IS THE PLACEMENT'S, not the settings file's. `placement.endpoint`
   * is null exactly when the run goes through the request's own endpoint — the
   * local slot, and every job this app never placed — and non-null when a
   * Crucible answered. Only the first of those may start a server here.
   */

  /*
   * ── WHERE THIS RUN'S COMPUTE GOES, DECIDED HERE AND ONCE ──────────────────
   *
   * docs/SLOTS.md §3: *"jobs never start on one slot and finish on another. its
   * atomic."* This is that sentence as code — one resolution, and nothing
   * downstream may ask again. A placement that could be re-derived at the
   * metadata stage or after a retry would be a book whose first half was
   * translated by one model and whose second half was translated by another,
   * with one records file claiming both.
   *
   * BEFORE THE SEED COPY AND THE CHECKLIST, deliberately, and on the rule those
   * two state about themselves: a job that has not committed must leave the
   * project exactly as it found it. A row that turns out to be waiting for a
   * server somebody is narrating on goes back to the queue, and it must not have
   * left a seeded records file behind on the way. It is before the READING SERVER
   * for the same rule one turn further out: a parked row must not have loaded a
   * model onto this card on its way to waiting.
   *
   * NULL MEANS THE ROW IS NO LONGER THIS CALL'S — parked back in the queue, or
   * failed with the reason on it. `placeRun` has already said so and published.
   */
  const placed = await placeRun(next, request, wires, settle);
  if (!placed.go) return placed.wait;
  const { placement } = placed;
  /*
   * ── AND WHERE IT WENT IS ANNOUNCED, ONCE, BEFORE ANYTHING SPAWNS ─────────
   *
   * See `RunWires.placed`: the host writes this into its in-flight ledger so a
   * hard kill has something to release the LEASE with. Before the spawn, because
   * a record written after the child exists can be missed by the kill it is for;
   * and its throw is not this run's problem, on `settled`'s rule.
   */
  if (wires.placed !== undefined) {
    try {
      wires.placed({
        server: placement.slot?.name ?? '',
        model: placement.model ?? '',
        leaseId: placement.lease?.id ?? null,
        concurrency: placement.concurrency ?? 0,
      });
    } catch (err) {
      console.error(
        `[queue] a placement listener threw for ${next.outputPath}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /*
   * ── A READING WITH NOWHERE TO READ REFUSES, AND SAYS SO ─────────────────
   *
   * What stood here started a model on this computer. If a read had no
   * placement endpoint it fell back to `backend.endpointUrl`, and when that
   * named Foundry's own llama.cpp copy of dots.ocr it printed "Starting the
   * reading server…" and brought one up.
   *
   * Owen, 2026-09-17: *"foundry shouldnt assume there even is a local system.
   * there sohuldnt be a local system. foundry does all ai work through
   * crucible."* So the fallback is gone, and what replaces it is a REFUSAL BY
   * NAME rather than nothing: `placeRun` answering with no endpoint for a
   * reading is now a contradiction — the placement came from a server that
   * said it serves `pages` — and a contradiction that fails quietly is one
   * nobody ever finds. The tile is dark without such a server
   * (electron/act-gates.ts), so reaching this is a defect upstream, and the
   * sentence says which.
   */
  if (next.kind === 'read' && placement.endpoint === null) {
    next.state = 'failed';
    next.error = 'This reading was placed on a server that did not give an address to read '
      + 'through, so there is nowhere to send the pages. Every act that meets a model runs on a '
      + 'Crucible server; Foundry has no reader of its own. Check that the server in Settings › '
      + 'Crucible Servers still serves page reading.';
    next.finishedAt = Date.now();
    changed();
    settle();
    return null;
  }

  /*
   * ── THE BOOK, THE SEED AND THE GENERATION, MADE NOW ──────────────────────
   *
   * HERE — after the placement and before the rotation — and the position is the
   * whole argument. `materializeAtSpawn` writes a derived book into the OS temp
   * directory and resolves a seed off the ledger, and both are work on this row's
   * behalf: a row that turns out to be waiting for a busy card must leave the
   * project, and the temp directory, exactly as it found it. It is also before the
   * rotation, because a deferred pass may RENAME its product here and the rotation
   * moves the file that name points at.
   *
   * THE STORED REQUEST IS REPLACED, because `sweepDerivedBook` at the settle reads
   * `requests` to find the file to unlink, and a sweep that looked at the press's
   * copy would leave the book this run actually made lying in the temp directory
   * for a day.
   *
   * A THROW IS `executeJob`'s BOUNDARY, which is the ending every unmakeable plan
   * in this app already has: the row lands `failed` wearing main's own sentence —
   * "the step this was to be made from never landed" — and nothing is spawned.
   */
  request = await materializeAtSpawn(request, next);
  requests.set(next.id, request);

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
  const merged = rendering !== null
    ? await recordFor(next.outputPath, rendering, next.parentStep ?? null, homeOf(request))
    : {};
  const record = rendering !== null && rendering !== 'txt'
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
      settle();
      return null;
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
   * rename and the first byte written is one spawn — and that window is covered
   * by the `finally` this rotation sits inside, which puts the rotation back
   * unless a product was filed, so the invariant is flat: A RUN THAT PRODUCES
   * NOTHING LEAVES THE CATALOGUE EXACTLY AS IT WAS.
   *
   * IT IS ENFORCED BY STRUCTURE NOW, AND IT USED TO BE ENFORCED BY REMEMBERING.
   * The put-back was written by hand on two arms — the cancel and the engine's
   * non-zero exit — and every other way out of this function left the book in
   * `generated/archived-<stamp>/` with nothing live at all: the refusals that
   * settle and return, and above all a THROW, which `engineCommand()` raises by
   * design when the app folder has no engine bundle, one statement below this
   * one. That throw reaches `executeJob`'s boundary, which fails the row
   * correctly and cannot see these three locals at all. So the restore is one
   * `finally` at the bottom of this function rather than a call an arm can be
   * added without.
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
  /**
   * DID THIS RUN PUT A PRODUCT WHERE THE ROTATION MADE ROOM — the one question
   * the restore below turns on, and the reason it is not simply unconditional.
   *
   * Said at the engine's zero exit, which is the moment the file exists at
   * `outputPath` and therefore the moment the rotation was FOR something. Every
   * landing arm is under it and none of them may put back: the old copy dragged
   * home over a new one is the destruction `restoreRotation` refuses to perform
   * (it checks the live slot itself), and asking it to is how a guard somebody
   * relaxes later becomes a lost book.
   *
   * IT IS NOT THE ROW'S STATE. A landing that throws afterwards — a catalogue
   * write that fails, a listener with a bug in it — ends `failed`, and its
   * product is on disk all the same; a run that produced something is not a run
   * that produced nothing, whatever the shelf ends up saying about it.
   */
  let landed = false;
  try {
    /*
     * A TRIAGE ROTATES NOTHING, and it is named here rather than left to the
     * basename's absence from `generated/`. Its verdicts live in `readings/` beside
     * the cleanup's records, on the reading's and the text passes' terms above, and
     * a rotation keyed on a basename would be `rotateGenerated` — or, for anything
     * that reached `exporting`, `rotateFinal` — asked to move a file that means
     * something else in a folder this run never writes.
     */
    if (request.kind !== 'read' && !isTextPassRequest(request) && request.kind !== 'clean-triage') {
      const projectDir = projectDirOf(request.outputPath);
      if (projectDir !== null) {
        rotatedIn = projectDir;
        try {
          if (exporting) {
            filedRotation = await rotateFinal(projectDir, path.basename(request.outputPath), next.id);
          } else {
            rotation = await rotateGenerated(projectDir, path.basename(request.outputPath), next.id);
          }
        } catch (err) {
          next.state = 'failed';
          next.error = err instanceof Error ? err.message : String(err);
          next.finishedAt = Date.now();
          changed();
          settle();
          return null;
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
    if (isTextPassRequest(request)
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
     * ── THE ANALYSIS CHECKLIST, WRITTEN AT THE SPAWN ──────────────────────────
     *
     * `--categories` takes a PATH to a JSON list, so the checklist cannot ride the
     * command line as a value; it has to be a file, and this is the moment to make
     * one. The seed copy above is here for the same reason and it is the same rule:
     * a plan is not a commitment, and a held job somebody removes must leave the
     * project exactly as it found it. A checklist written at plan time would sit in
     * the analysis folder named by no step, invisible to every sweep, forever.
     *
     * BESIDE THE REPORT AND NAMED FROM IT (`categoriesFileFor`), so a person
     * looking at a run in a terminal can see what it was asked for — and so the
     * settle can remove it without composing a second opinion about where it went.
     *
     * THE WHOLE SET IS WRITTEN, unticked entries and all, which is the spelling
     * `buildPlan` documents itself as accepting from this app: a list composed by
     * DROPPING names is indistinguishable from a list of the only categories this
     * build has heard of, and the day the engine grows an eleventh the two readings
     * diverge in silence.
     *
     * A FAILURE HERE IS NOT SWALLOWED AND IS NOT A THROW. Without the file the
     * engine refuses the run by name, which is the honest outcome and lands in the
     * row's error where somebody will read it; a console line says which write
     * failed so the cause is not a mystery.
     *
     * THE ENTRY IS REBUILT FIELD BY FIELD rather than spread, and that is the one
     * detail this write cannot get wrong. `parseCategoriesJson` (src/analyze/plan.ts)
     * REFUSES an entry carrying a field it does not read — deliberately, because a
     * typo accepted in silence is a hand-written hypothesis that never reached the
     * model and an hour spent looking fine — so anything this app grows on its own
     * request shape would end the run the day it was added. Three fields are
     * spelled here because three are the ones over there: `name`, `enabled`, and
     * `description` where the category has one (a user's own; a built-in never
     * does, and an empty one is omitted rather than written as "").
     */
    if (request.kind === 'analysis' && request.categories.length > 0) {
      const where = categoriesFileFor(request);
      const asked = request.categories.map((one) => {
        const description = (one.description ?? '').trim();
        const label = (one.label ?? '').trim();
        return {
          name: one.name,
          enabled: one.enabled,
          ...(description.length > 0 ? { description } : {}),
          // The words the person reads for this category, carried so the report's
          // `names` header shows every device the label the desktop shows —
          // including a custom category exactly as its author typed it.
          ...(label.length > 0 ? { label } : {}),
        };
      });
      try {
        await fsp.mkdir(path.dirname(where), { recursive: true });
        await fsp.writeFile(where, `${JSON.stringify(asked, null, 2)}\n`, 'utf8');
      } catch (err) {
        console.error(`[job] the analysis checklist could not be written to ${where}:`, err);
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
      || isTextPassRequest(request)
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
      /*
       * WHAT THE RUN SPENT, off the same stderr the counts come off.
       *
       * The engine prints one usage line at the very end of a text act
       * (`usageLine`, src/translate/transport.ts) and only when the server it
       * talked to counted — so this fires once per run at most, and never on a
       * local Ollama, which reports nothing. Read BEFORE the progress parse and
       * kept out of it, because it is not progress: see `parseUsageLine`.
       *
       * IT DOES NOT CLEAR THE NOTE AND IS NOT SWALLOWED. The line stays the
       * message and becomes the note like any other non-count line, because it is
       * a real thing the engine said and a person reading the row's last line
       * should see it. What this adds is the STRUCTURED copy, which is what the
       * finished row and the bench card draw from.
       */
      const spent = parseUsageLine(line);
      if (spent !== null) next.usage = spent;
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
      sayOutward(line, next.outputPath, wires);
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
    /*
     * A COMMAND THAT CANNOT BE SPELLED IS A FAILED ROW WITH THE REASON ON IT, and
     * not a rejected promise nobody catches. `argsFor` refuses exactly one thing —
     * a text pass whose book was never materialised, which is a promise that reached
     * the spawn without its parent (`bookOf`) — and this is the arm that turns that
     * into the ending every other unmakeable job in this file gets: the row settles,
     * the shelf shows main's sentence, and anybody awaiting it hears.
     */
    let args: string[];
    try {
      args = argsFor(spawned, merged, placement);
    } catch (err) {
      next.state = 'failed';
      next.error = err instanceof Error ? err.message : String(err);
      next.finishedAt = Date.now();
      changed();
      settle();
      return null;
    }
    /*
     * THE LINE IS SAFE TO PRINT AND THAT IS A PROPERTY OF THE DESIGN, not luck. A
     * Crucible's token is in `placement.env` and never in argv, so the command
     * this prints is the whole command and carries no credential — which is what
     * makes it something a person can paste into a terminal and into a bug report.
     * Anything that ever puts a secret on this line has broken the contract
     * `Placement.env` states.
     *
     * ── THE TWO FLAGS THE LOCAL PAGE READER ADDS, AND WHY NOT IN `argsFor` ─────
     *
     * `argsFor` is a pure function of the REQUEST: the same request spells the
     * same command line whenever it is asked, which is what lets the shelf, the
     * log line and a re-run all agree. Neither of these is a property of the
     * request. Both are properties of the server that answered a moment ago —
     * which model it says it holds, and whether it is one this app started — and
     * a pure function cannot know either without probing a socket.
     *
     * A zero concurrency means "say nothing", which is how an ADOPTED server keeps
     * the engine's own measured default of twelve.
     */
    // File preparation above also awaits. Cancelling before the child exists
    // must never turn into a late spawn after the cancellation was acknowledged.
    if (jobs.find((job) => job.id === next.id)?.state === 'cancelled') return null;
    console.log(`[job] ${next.kind} ${args.join(' ')}`);
    let handle = runEngine(args, watch, placement.env);
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
    /*
     * AND THE ENDING BECOMES THIS RUN'S, in the same breath and for the same
     * fact: the child is gone. The two lines are together because the gap
     * between them is the defect — a ✕ arriving in it finds a `running` row with
     * nothing to kill and settles it itself, while the landing below goes on to
     * settle it again. `landings` holds the argument in full.
     */
    landings.add(next.id);
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
      // THE PRODUCT IS AT `outputPath` FROM HERE ON, so the rotation this run
      // made was made for something and the restore below must not undo it.
      // See `landed`, which every arm under this line depends on and none of
      // them has to remember.
      landed = true;
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
        /*
         * ── AND THE READING IS OVER, WHICH THIS BRANCH NEVER SAID ───────────────
         *
         * Every other landing in this function ends on the settle and this one
         * ended on `return`. It was not noticed for as long as a reading's ending
         * cost nothing: the branch used to call `void pump()` itself, which kept the
         * queue moving, and when `runInSlot`'s `finally` took the pump over that line
         * was removed with nothing put in its place (338027b → d1dd5b6). A reading
         * finished, the row went `done`, and the one function that says a job is
         * over was never called for it.
         *
         * WHAT THAT COST, measured 2026-09-18: a reading of a book ended at 02:22:10
         * and `dots-ocr` — twelve gigabytes — was still on the card at 02:29, because
         * `settled` is the ONE place a Crucible lease is given back. The lease is not
         * best-effort tidying; while it is open the server refuses to clear the card
         * (crucible/settle.py, fact 2 of four), so a lease nothing releases is a
         * resident model nothing can unload. Worse than a leak: the heartbeat timer
         * lives in the same object, so it beat every forty seconds for the life of
         * this process and, answered `unknown_lease`, went on trying to TAKE THE
         * CARD BACK on behalf of a run that ended minutes ago (`takeLease`,
         * electron/crucible-dispatch.ts).
         *
         * The lease is only the loudest of the three. `forgetPark` never ran for a
         * reading either, and nothing waiting on `onJobSettled` ever heard a
         * successful one end — the promise that function's own docstring makes.
         *
         * LAST, AFTER THE PRODUCTS, which is that promise and not an accident of
         * where the line sits: a waiter has to see the bank and the book file before
         * it hears the job is over, or it reads a reading that worked as an ending
         * with nothing in it.
         */
        settle();
        return null;
      }
      /*
       * ── A TRANSLATION LANDED, AND WHAT IT LEFT IS ANSWERS ────────────────────
       *
       * The same shape as the reading above it, which is the shape it should always
       * have had: this run produced no document at all. It wrote
       * `readings/<key>.<tag>[.<id8>].records.jsonl` — one row per flowing block —
       * and the step that keeps what those hours cost names THAT file as its payload
       * (`recordTextPass`, electron/projects.ts), exactly as a read step names its
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
       * untranslated book's language goes (`recordTextPass` argues it in full).
       *
       * AND THEN THE BOOK, WITHOUT BEING ASKED. A records file is not a thing a
       * person reads, so the row would have nothing to show until somebody ordered a
       * rendering by file format — which is the exact gap the automatic cast after a
       * reading was built to close, one action later. It is the same cast: free,
       * offline, seconds, and fired and forgotten so that a translation that landed
       * is never reported as a failure because the book after it could not be planned.
       */
      /*
       * ── AN ANALYSIS LANDED, AND WHAT IT LEFT IS A REPORT ─────────────────────
       *
       * The same shape as the two above it and the shortest of the three, because
       * an analysis owes the book nothing. There is no document to catalogue, no
       * bank to displace, no derived book to materialise afterwards and no chain to
       * resolve: the run measured a book and wrote down what it found, and the step
       * that keeps the report names that file as its payload (`recordAnalysis`,
       * electron/projects.ts).
       *
       * THE ONE FACT THE JOB HANDS OVER is the one nothing on disk can answer
       * afterwards: which categories were actually asked for. The report's header
       * lists them, and reading a step's params back out of its payload is what this
       * codebase's oldest house rule forbids — so the run that asked says what it
       * asked for, exactly as a translation says which language. The model rides
       * with it, in the answer pile (`MINTED_BY_THE_RUN`).
       *
       * AND NOTHING FOLLOWS IT. A translation lands and materialises a book,
       * because a records file is not a thing a person reads; a report is drawn by
       * a panel straight out of the file, so there is nothing to make and nothing
       * to open. The pointer stays where it was (`RETAINED_BESIDE_YOU`), which is
       * the whole of what an analysis does to a project's position.
       */
      /*
       * ── A TRIAGE LANDED, AND WHAT IT LEFT IS A LIST ─────────────────────────
       *
       * The shortest landing in the file, because a triage owes the project
       * nothing: no step, no document, no book to make afterwards. The verdicts are
       * on disk where the press named them, and the cleanup chained behind this row
       * reads them when the pump lets it start — which is this settle, since
       * `chainVerdict` answers `go` for a parent that is `done`.
       *
       * NO LEDGER WRITE, and that is the difference from the analysis below: a
       * report is something a person opens, so it is a step; a verdicts file is
       * something the next run reads, so it is not.
       */
      if (request.kind === 'clean-triage') {
        next.message = `Checked which blocks of ${path.basename(next.inputPath)} need cleaning.`;
        changed();
        settle();
        return null;
      }
      if (request.kind === 'analysis') {
        await recordAnalysis(next.outputPath, {
          parentStep: next.parentStep ?? null,
          categories: request.categories.filter((one) => one.enabled).map((one) => one.name),
          model: request.model,
          ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
        });
        next.message = `Analysed ${path.basename(next.inputPath)} — the report is on its step.`;
        changed();
        settle();
        return null;
      }
      if (isTextPassRequest(request)) {
        /*
         * ── ONE LANDING FOR THREE PASSES, AND THE ACTION IS THE THING IT CARRIES ──
         *
         * `recordTextPass` appends a step whose action is this job's kind, which is
         * the whole of what the split changed here: a rewrite used to land as
         * `translate` wearing `params.rewrite`, and a cleanup would have had to do
         * the same. Owen ended it — *"it isnt a translate job"* — so the row says
         * what the button said.
         *
         * WHAT THE JOB HANDS OVER IS WHAT NOTHING ON DISK CAN ANSWER AFTERWARDS: the
         * language a translation went into and the mode a rewrite was asked in. Both
         * are legible only in the records file's NAME, and reading a fact back out of
         * a filename is what this codebase's oldest house rule forbids. A CLEANUP
         * HANDS OVER NEITHER, because it has neither — `PARAMS_OF.clean` is empty,
         * and the run's own facts are on the stamp beside its answers.
         */
        await recordTextPass(next.outputPath, {
          action: request.kind,
          parentStep: next.parentStep ?? null,
          /*
           * A CLEANUP GOES INTO NO LANGUAGE, and a rewrite's is resolved at spawn
           * (`SimplifyRequest.to`) — so this asks whether there is one rather than
           * asserting there is. An absent one here is unreachable and not guarded
           * against: `languageOf` refuses the command line without it, so a run that
           * reached this landing was spawned with a language and carries it still.
           */
          ...(request.kind === 'clean' || request.to === undefined ? {} : { language: request.to }),
          ...(request.stepId !== undefined ? { stepId: request.stepId } : {}),
          ...(request.kind === 'simplify' ? { rewrite: request.rewrite } : {}),
        });
        /*
         * "the book follows" IS TRUE OF ALL THREE and is the sentence the shelf has
         * always ended a text pass with: the records are on disk and the book is
         * materialised from them in the next few lines, for nothing.
         */
        const said = request.kind === 'translate'
          ? 'Translated'
          : request.kind === 'simplify' ? 'Simplified' : 'Cleaned';
        next.message = `${said} ${path.basename(next.inputPath)} — the book follows.`;
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
        await materializeTextPass(next.outputPath);
        settle();
        return null;
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
        /*
         * ── THE MINT'S DECLARATION, STAMPED AND THEN ANNOUNCED ──────────────────
         *
         * `request.mintMeta` is what the modal confirmed at the press
         * (JobRequest.mintMeta carries the why). The LANGUAGE follows the step's
         * own chain over the form: the request's language where the plan set one
         * (a translated position), the reading's language otherwise, and only
         * where the chain is silent does the form's answer stand — an
         * auto-export of a German step must say de whatever the person last
         * typed. Stamped into the file first, announced second, both out of ONE
         * composed block, which is `madeFrom`'s own one-variable rule two
         * comments up. A stamp that fails is a console line and never a failed
         * job: the book is made and filed, and a metadata splice can be pressed
         * again from the tile in seconds.
         *
         * ── AND A MINT NOBODY CONFIRMED INHERITS, the way the modal would have ──
         *
         * A host-ordered export (`exportEpubFromStep`, electron/mount.ts) has no
         * modal in front of it, and used to carry the project's stored block or
         * nothing. A hosted project minted from a bare document has no stored
         * block until somebody confirms a mint, so BookForge's narrate-on-a-step
         * produced an EPUB whose `dc:title` was the tray file's stem and whose
         * `dc:creator` was absent — while BookForge's own shelf knew the author
         * (bookforge-pc-1, 2026-09-07). The modal asked the host for exactly that
         * record (`mintMetaFor`) and merged it under the stored block; the
         * unattended route never did. Now it asks the same question through the
         * same function (`inheritMintMeta`, shared/mint-meta.ts): the request's
         * confirmed block first, the stored block over the host's record next,
         * and nothing at all only when neither side has a record — the
         * standalone first mint, which is what it always was.
         *
         * A BLOCK WITH NO TITLE IS NOT STAMPED. The splice writes `Untitled` for
         * an empty one, and a title the compile already took from the scan is
         * strictly better than that word over it.
         */
        /*
         * WHERE IT LANDED, AND WHOSE IT IS — two questions since a host may ask
         * for the file OUTSIDE every project (`ConversionRequest.home`). The
         * project answers for the mint block and the announcement; the path
         * answers for whether anything of this app's filed it, and a file filed
         * nowhere is announced as `unfiled` so the mount answers its awaiting
         * caller without telling the host's shelf about a version that is not one.
         */
        const filedIn = projectDirOf(next.outputPath);
        const projectDir = homeOf(request) ?? filedIn;
        let minted: ExportMintMetadata | undefined;
        const inherited = request.kind === 'epub' && request.mintMeta === undefined && projectDir !== null
          ? await inheritedMintMetaFor(projectDir)
          : null;
        const confirmed = request.kind === 'epub'
          ? request.mintMeta ?? (inherited !== null && inherited.title.trim().length > 0 ? inherited : undefined)
          : undefined;
        if (request.kind === 'epub' && confirmed !== undefined) {
          const meta = confirmed;
          const declared = request.language
            ?? await chainLanguageOf(next.outputPath, madeFrom, homeOf(request))
            ?? meta.language;
          minted = {
            title: meta.title,
            contributors: meta.contributors,
            filename: filed,
            ...(meta.subtitle !== undefined ? { subtitle: meta.subtitle } : {}),
            ...(meta.year !== undefined ? { year: meta.year } : {}),
            ...(declared !== undefined ? { language: declared } : {}),
          };
          const stamped = await stampMintMetadata(next.outputPath, meta, declared);
          if (!stamped.ok) {
            console.error(
              `[queue] the mint metadata could not be stamped onto ${next.outputPath}: ${stamped.reason}`,
            );
          }
        }
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
              // And the mint's declaration, the same block the stamp just wrote —
              // absent means "minted before the modal existed", never "no
              // metadata" (`ExportLanding.metadata`).
              ...(minted !== undefined ? { metadata: minted } : {}),
              ...(filedIn === null ? { unfiled: true as const } : {}),
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
        settle();
        return null;
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
        settle();
        return null;
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
       * records translation lands where its answers land (`recordTextPass`), and
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
        // The row's id, which is what names the archive folder if this promotion
        // rotates a live PDF aside — the same id the rotation above used.
        next.id,
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
      /*
       * AND A CANCELLED READING KEEPS NOTHING — Owen's ruling, and the one ending
       * in this file that destroys. `discardCancelledReading` carries the whole
       * argument, including the two guards that keep a finished reading out of it.
       * Awaited so the row does not settle while its pages are still on disk: a
       * re-read enqueued the instant the ✕ lands must not find them.
       *
       * UNLESS THE HOST SAID THIS WAS A STOP. BookForge's "Stop this step" and its
       * "Cancel this book" arrive here as the same -1 (`engine.ts` resolves -1 for
       * any cancel), and the first of the two promises in its own tooltip to keep
       * what it has already read. Destroying the bank under that button would be a
       * lie the person only discovers by pressing Start and watching page one go
       * past. `RESUMABLE_STOP` (shared/types.ts) is how a host says which gesture
       * it was; absent means cancel, so nothing about the ✕ changes.
       */
      if (resumableStops.has(next.id)) {
        console.log(
          `[queue] the reading was STOPPED rather than cancelled, so its pages stay banked and `
          + 'Start resumes from where it left off.',
        );
      } else {
        await discardCancelledReading(request);
      }
      // Nothing was written, so nothing moved: `landed` is still false and the
      // `finally` below brings the previous output home and points the chain
      // back at it. See `restoreRotation` for what "nothing" has to include —
      // the file, the working tree, and both of their catalogue rows. The tray
      // obeys the same invariant through its own receipt: a cancelled export
      // leaves the document somebody filed earlier exactly where it was.
    } else if (result.code === ENGINE_PARKED_EXIT) {
      /*
       * THE ENGINE PARKED, AND A PARK IS NOT A FAILURE (2026-09-21).
       *
       * Exit 75 is the page reader saying the model server's weather -- a
       * 502 over a stale proxy socket, a busy card, a connect timeout --
       * outlasted its stated retry budget. Nothing is lost: every page that
       * landed is in the readings bank, and the same request run again
       * resumes from them. Filing this as `failed` is exactly what turned one
       * stale socket into a released lease, an unloaded engine and eleven
       * thrown-away pages (Bookforge-Mac-1's finding, Everyday Denazification
       * page 32).
       *
       * THE ROW GOES BACK TO QUEUED, wearing the engine's own sentence -- the
       * last stderr line, which names the endpoint and the page and says the
       * resume is free. Who runs it again depends on who ordered it: a
       * pump-driven row sits out `PARK_AFTER_WEATHER_MS` on `parkedUntil` and
       * the pump takes it back (wired after the settle below, because
       * `settled` forgets every park); a detached run is answered through
       * `parkedRuns` and the host, or the dialog, decides.
       *
       * THE READINGS ARE KEPT, as after a resumable stop and unlike a cancel:
       * the bank is the whole reason a park costs nothing.
       */
      const line = result.stderr.trim().split(/\r?\n/).reverse().find((one) => /^foundry: parked:/.test(one));
      const sentence = (line ?? '').replace(/^foundry: /, '')
        || result.stderr.trim()
        || `The engine parked (exit ${result.code}) with nothing to say.`;
      next.state = 'queued';
      next.message = sentence;
      next.note = null;
      delete next.startedAt;
      parkedRuns.set(next.id, sentence);
      lastEngineStderr.set(next.id, result.stderr);
      console.log(`\n[job] ${next.kind} PARKED — ${path.basename(next.inputPath)}\n${sentence}\n`);
    } else {
      next.state = 'failed';
      // foundry's own stderr is the message a user needs — it names the missing
      // Python, the model it could not load, the page it choked on. Never
      // paraphrased, and never replaced with an exit code.
      next.error = result.stderr.trim() || `The engine exited ${result.code} with nothing to say.`;
      /*
       * AND A COPY THE ROW CANNOT LOSE. `next.error` is erased by a resumable stop
       * on the host's side (BookForge P6), and a host's log is the only place a
       * night of failures survives the window being reloaded. Consumed by
       * `runDetached`; a row nobody detached simply leaves it and the next line
       * clears it.
       */
      lastEngineStderr.set(next.id, result.stderr);
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
  } finally {
    /*
     * ── AND WHATEVER WAS MOVED ASIDE COMES HOME, ON EVERY WAY OUT ────────────
     *
     * The invariant the rotation block states about itself, kept by the one
     * construct that cannot be reached past: a return, a refusal that settles,
     * a cancel, an engine's non-zero exit and a THROW all arrive here. Two
     * hand-placed calls used to stand for this and covered the last two of
     * those five; `engineCommand()`'s refusal — an app folder with no engine
     * bundle — went straight past them to `executeJob`'s
     * boundary, which settles the row correctly and cannot reach these locals.
     *
     * BEFORE THE `settle()` BELOW, which is why the tail of this function sits
     * outside the `try` rather than inside it: `onJobSettled` promises that
     * nothing else is coming from this job, and a listener told a run is over
     * while its book is still in an archive folder would be reading the
     * catalogue mid-rotation. The arms that settle and return say their own
     * ending first and are the exception — they filed nothing either way, and a
     * rotation put back a moment late is still a rotation put back.
     *
     * `putBack` IS A NO-OP BEFORE THE ROTATION HAPPENS — `rotatedIn` is null
     * until the block above sets it — so the `try` may start wherever the
     * locals are in scope.
     */
    if (!landed) {
      try {
        await putBack(rotatedIn, rotation, filedRotation);
      } catch (err) {
        /*
         * NOT EXPECTED, AND CAUGHT ANYWAY, for one reason: a throw out of a
         * `finally` REPLACES the error that is already in flight, so an
         * unguarded restore would swap the engine's own refusal for a rename
         * error and the run would be reported as something it was not. Both
         * restores name their own failures and return (`restoreRotation`,
         * `restoreFinalRotation`), so what reaches here is a defect in the
         * restore itself — which gets a line naming the document and where the
         * rotation put it, because a book in an archive folder that nothing
         * says is there is exactly the silence this whole block exists to end.
         */
        console.error(
          `[job] ${path.basename(next.outputPath)} was moved aside in ${rotatedIn} for a run `
          + `that produced nothing, and putting it back threw: `
          + `${err instanceof Error ? err.message : String(err)}. The generated rotation was `
          + `${rotation === null ? 'none' : rotation.movedTo} and the filed rotation was `
          + `${filedRotation === null ? 'none' : filedRotation.movedTo}; nothing was deleted.`,
        );
      }
    }
  }
  changed();
  // The three arms above return before this line, each saying it for itself
  // after whatever that landing produced; what reaches here is a cancel, a
  // failure, a park, and the rendering whose landing is a catalogue row.
  settle();
  /*
   * A PUMP-DRIVEN ROW THE ENGINE PARKED GOES BACK ON THE BOARD, after the
   * settle and not before: `settled` gives the lease back and FORGETS every
   * park on the row, so a `parkedUntil` set in the arm above would be gone by
   * here. `slots` still names the row -- the pump's own `finally` clears it
   * only once this returns -- which is how a pump-driven run is told from a
   * detached one, whose sentence stays in `parkedRuns` for `runDetached`.
   */
  const parkedSentence = parkedRuns.get(next.id);
  if (parkedSentence !== undefined && slots.has(next.id)) {
    parkedRuns.delete(next.id);
    lastEngineStderr.delete(next.id);
    parkedUntil.set(next.id, Date.now() + PARK_AFTER_WEATHER_MS);
    const timer = setTimeout(() => { void pump(); }, PARK_AFTER_WEATHER_MS);
    timer.unref?.();
    changed();
  }
  // NOTHING WAS WAITED FOR: this run ran. See `Placed`, and `runDetached`, which
  // is the only caller that can do anything with the other answer.
  return null;
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
export async function runJob(request: EngineRequest, opts: RunOptions = {}): Promise<RunOutcome> {
  /*
   * EVERY CALLER OF THIS DOOR IS THE HOST, BY CONSTRUCTION, and that is what
   * lets the row below be marked as the host's twin without anybody being asked.
   * It is exported for electron/mount.ts and reached from nowhere inside this
   * app: `runNow`, the other detached door, calls `runDetached` itself and says
   * there that its run is nobody's twin. So "a host scheduled this" is a fact
   * about WHICH DOOR WAS OPENED rather than a claim passed in and trusted.
   */
  const { job, wait, parked, stderrTail } = await runDetached(request, opts, true);
  /*
   * ── THE FIVE ANSWERS, AND WHY THEY ARE FIVE ───────────────────────────────
   *
   * A WAIT IS NOT A ROW. Nothing ran, nothing was spent, and the row minted for
   * the attempt has already been discarded (`runDetached`) — so handing one back
   * would be handing over residue and inviting the host to draw it. What the host
   * needs is the holder's own sentence and whether time alone will fix it.
   *
   * A PARK IS NOT A ROW EITHER, and it is not a failure (2026-09-21). The engine
   * ran, the model server's weather outlasted its retry budget, and it exited
   * `ENGINE_PARKED_EXIT` with the pages it read banked. The row is discarded the
   * way a wait's is; what the host needs is the engine's sentence to re-queue by,
   * and the stderr for its log, which holds every weather line before the park.
   *
   * THE OTHER THREE ARE THE ROW, exactly as this door has always answered, and
   * `cancelled` stays distinct from `failed` for the reason it always was:
   * somebody spent GPU and took it back, and filing that as a failure is how a
   * retry restarts work a person just stopped.
   *
   * THE STDERR TRAVELS SEPARATELY on a failure. `row.error` is the engine's own
   * sentence and the host puts it on the row; the tail is for the host's LOG,
   * which is the copy that survives a Stop erasing the row's error (BookForge P6).
   */
  if (wait !== null) {
    return { outcome: 'wait', busyLine: wait.reason, standing: wait.standing };
  }
  if (parked !== null) return { outcome: 'parked', reason: parked, stderrTail };
  if (job.state === 'cancelled') return { outcome: 'cancelled', row: job };
  if (job.state === 'failed') {
    return {
      outcome: 'failed',
      row: job,
      error: job.error ?? 'Foundry did not say why this run failed.',
      stderrTail,
    };
  }
  return { outcome: 'done', row: job };
}

/**
 * WHAT WHOEVER SCHEDULED A DETACHED RUN HANDS IT — named once, because two doors
 * spell it: the seam's (`runJob`) and the dialog's (`runNow`).
 */
interface RunOptions {
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
   * THE SAME LINES, FOR THE CALLER'S LOG — see `RunWires.line`.
   *
   * It is called in `onProgress`'s own `finally`, so a reporter that throws
   * cannot cost the log the line that explains the failure. A host that tees this
   * to a file is the reason a hosted run's words survive the window being
   * reloaded and the row being stopped (BookForge P5/F7).
   */
  onLine?: (line: string) => void;
  /**
   * WHERE THIS RUN WAS PLACED, once, before the spawn — see `RunWires.placed` and
   * `RunPlacement`. The host records it so a hard kill can release the lease.
   */
  onPlaced?: (placement: RunPlacement) => void;
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
  /**
   * THE CARD THE SCHEDULER ALREADY ADMITTED THIS RUN TO — see {@link RunVenue}.
   *
   * It was `waitFor?: string`, and the change is what the word means rather than
   * what it carries. `waitFor` was a PREFERENCE that the placement was free to
   * re-decide; a venue is a DECISION already taken, with a poll, a lease
   * reservation and a slot charged behind it (BookForge's rulings 7 and 9 of
   * 2026-09-20). So the placement places there and nowhere else.
   *
   * Absent or null means the caller has no machine to name — a rendering, a
   * compile, an install — and this app's own default decides, which is what
   * `runNow` wants. The name is not validated here: a slot that has gone is a
   * wait with the placement's own sentence on it, which is where a name can be
   * checked against a list that is current.
   */
  venue?: RunVenue | null;
}

/**
 * ONE RUN, OFF THE BOARD — everything `runJob` above says, and the body the
 * dialog's door (`runNow`) shares with it.
 *
 * The two doors differ in exactly one thing, and it is not what the run DOES:
 * whether the work was scheduled by a host, which decides whether the row minted
 * here is a twin of a row the host is drawing already. Everything else — the
 * mint, the abort, the deferral, `executeJob`, the landing — is one path,
 * deliberately, on the rule this file states everywhere else: a hosted run and a
 * standalone run are the same run.
 */
async function runDetached(
  request: EngineRequest,
  opts: RunOptions,
  /**
   * DID SOMEBODY ELSE'S SCHEDULER ORDER THIS — true at the seam, false at the
   * dialog, and it decides one thing only: whether the row below is marked as the
   * host's own row seen from the inside (`hostScheduled`) and therefore left out
   * of the hosted shelf, which is already drawing the host's half of it. A run the
   * dialog asked for is nobody's twin — no list anywhere else holds a row for it —
   * so it is marked nothing and stays drawn for as long as it lasts.
   */
  viaHost: boolean,
): Promise<{ job: Job; wait: PlacementWait | null; parked: string | null; stderrTail: string }> {
  const parentStep = opts.parentStep ?? null;
  /*
   * THE ROW, BORN RUNNING. Every field is composed exactly as `enqueueHere` and
   * `enqueueTextPass` compose theirs — the same output identity (asked of
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
    // THE ROW'S NAME, out of the one function both doors ask — see
    // `titleForTextPass`, where the rule and its exception live.
    ...(isTextPassRequest(request) ? titleForTextPass(request) : {}),
    ...(request.kind === 'clean-triage' ? { title: CLEAN_TRIAGE_TITLE } : {}),
    ...(request.kind !== 'read' && !isTextPassRequest(request) && request.kind !== 'analysis'
      && request.kind !== 'clean-triage'
      && request.forStep !== undefined
      ? { forStep: request.forStep }
      : {}),
    parentStep,
    /*
     * WHAT THIS ROW WILL LAND, AND WHAT IT WAS CHAINED BEHIND — the third door
     * spreading `promisedBy`, on this function's own rule that a row is a row
     * however it was scheduled.
     *
     * `after` IS RECORDED AND NOT OBEYED HERE, which is the honest shape: by
     * calling this the host has already decided that now is the moment, exactly as
     * `runJob`'s no-dedupe paragraph argues. Foundry does not second-guess a
     * scheduler; what it does is refuse to RUN work whose parent never landed, and
     * that refusal is `materializeAtSpawn`'s, inside the run, where it can name
     * the step rather than the row.
     */
    ...placedBy(request.kind, opts.venue?.server),
    ...promisedBy(request),
    createdAt: Date.now(),
  };
  jobs.push(job);
  /*
   * AND IT IS THE HOST'S ROW SEEN FROM THE INSIDE, when the host is the one that
   * scheduled it. Marked HERE, at the mint, because this is the only moment
   * anything can tell — a row carries no record of which door minted it, and by
   * the time the shelf is composed the twin is indistinguishable from a row this
   * app ordered for itself. `hostScheduled` holds the whole of why the shelf must
   * draw one of the two and not both.
   */
  if (viaHost) hostScheduled.add(job);
  requests.set(job.id, request);
  changed();

  /*
   * THE ABORT IS ARMED BEFORE THE RUN, not inside it, so a signal that is already
   * aborted — or that fires while the reading server is coming up, minutes before
   * there is a child to kill — reaches the same `cancelHere` the ✕ reaches. The
   * listener is dropped in `finally`: a host that keeps one controller per row
   * would otherwise leave this queue holding a reference to every row it ever ran.
   */
  const abort = (): void => {
    /*
     * WHICH GESTURE THIS WAS, read here and nowhere else. The host's Stop and its
     * Cancel are one abort by the time `cancelHere` runs and one exit code by the
     * time the discard decides, so the reason is captured at the only instant it
     * is still distinguishable. See `RESUMABLE_STOP`, shared/types.ts.
     */
    if (isResumableStop(opts.signal?.reason)) resumableStops.add(job.id);
    cancelHere(job.id);
  };
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
    return { job: copyOf(job), wait: null, parked: null, stderrTail: '' };
  }

  /*
   * ── AND THE MATERIALISE IS NOT HERE ANY MORE (PK6) ─────────────────────────
   *
   * `materializeDeferred` used to run between the mint and `executeJob`, in BOTH
   * doors, each with its own copy of the failed-row ending. It has moved inside
   * the run (`carry`), which is where the seed copy and the analysis checklist
   * already were and for their rule: a row that turns out to be waiting for a busy
   * card must leave the project exactly as it found it. Its refusal — a chained
   * row whose parent never landed — is unchanged and still lands as a failed row
   * with main's sentence on it, through `executeJob`'s own boundary.
   */
  let waited: PlacementWait | null = null;
  try {
    waited = await executeJob(job, request, {
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
      ...(opts.onLine !== undefined ? { line: opts.onLine } : {}),
      ...(opts.onPlaced !== undefined ? { placed: opts.onPlaced } : {}),
    });
  } finally {
    opts.signal?.removeEventListener('abort', abort);
    detachedRuns.delete(job.id);
  }
  /*
   * ── A WAIT LEAVES NO ROW BEHIND ───────────────────────────────────────────
   *
   * `remove`'s own rule, applied to a row that never started: *"a job that never
   * started spent nothing and produced nothing, and a `cancelled` row for it is
   * residue."* The scheduler that called will ask again when the card is free, and
   * that asking mints its own row; leaving this one would accumulate one grey row
   * per re-ask for the life of the process, in a list the hosted window cannot
   * even reach.
   *
   * NOT `settled`, deliberately: nothing ended. A settle would publish an ending
   * to every listener and cascade this row's chain away over a card being busy.
   */
  if (waited !== null) discardUnrun(job);
  /*
   * AND A PARK LEAVES THE SAME WAY A WAIT DOES: nothing landed, the row is
   * discarded, and the caller gets the engine's sentence to re-queue by. The
   * readings bank, not the row, is what the resume is made from.
   */
  const parked = parkedRuns.get(job.id) ?? null;
  if (parked !== null) {
    parkedRuns.delete(job.id);
    discardUnrun(job);
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
   * immediate `stopPageReader`, not a countdown. A batch of ten readings would pay
   * ten model loads for a queue that never actually went quiet. Drain hosted is
   * the host's to declare, once, when its own pump has nothing left
   * (`hostQueueDrained`).
   */
  /*
   * THE STDERR IS CONSUMED HERE, so the map holds at most the rows that are
   * between their engine's exit and this line. Left to accumulate it would be a
   * copy of every failed run's output for the life of the process.
   */
  const stderrTail = lastEngineStderr.get(job.id) ?? '';
  lastEngineStderr.delete(job.id);
  return { job: copyOf(job), wait: waited, parked, stderrTail };
}

/**
 * TAKE A ROW OUT OF THE LIST WITHOUT ENDING IT — for the one case that is neither.
 *
 * A detached run that met a busy card never started: no engine, no lease, no
 * product, nothing to sweep. `settled` is the wrong door (it publishes an ending
 * and cascades the chain away) and so is leaving the row (it accumulates). This
 * is the third thing, and it exists exactly once.
 */
function discardUnrun(job: Job): void {
  const index = jobs.indexOf(job);
  if (index >= 0) jobs.splice(index, 1);
  requests.delete(job.id);
  hostScheduled.delete(job);
  forgetPark(job.id);
  changed();
}

/**
 * RUN THIS EXPORT NOW, UNDER THE DIALOG THAT ASKED — the person-facing door onto
 * `runJob`, and the reason an export is not a queue row any more.
 *
 * ── Why an export does not wait ─────────────────────────────────────────────
 *
 * The queue exists for work that costs something: a reading is hours of GPU
 * against pages nobody has seen, a translation holds a model for the length of
 * a book. An export is neither — it is seconds of offline arithmetic over
 * answers already on the disk, and the person who pressed Export is standing in
 * front of the dialog waiting for exactly this file. Filing it in a list beside
 * the readings meant the dialog closed on a promise and the queue page was
 * where you went to find out whether the button worked. So the run happens
 * HERE, while the dialog holds the question open, and the settled row is the
 * answer it draws from.
 *
 * ── What is the same, which is everything that matters ──────────────────────
 *
 * It goes through `runJob`, so a row is minted for the length of the run — the
 * delete guards and `foundryBusy` count it, the ✕ can reach it through
 * `cancelHere`, and the landing is `executeJob`'s own: the `final/` rotation,
 * `recordFinal`, the host's `onExport` announcement, the settle. Nothing about
 * WHAT an export does moved; only the waiting is gone.
 *
 * ── The row leaves the list when it settles ─────────────────────────────────
 *
 * Whatever state it settled in. The dialog this answers is the surface that
 * reports the outcome — the engine's own words for a failure, the filed name
 * for a success — and a copy of that report parked in the shelf would be the
 * old behaviour back under a different door: a queue accumulating rows for work
 * that never waited. `settled` has already fired by then, so nothing that
 * listens for endings misses one.
 *
 * ── It never routes, and hosted the row is ours rather than the host's ──────
 *
 * A host queue takes over the DECIDING, and there is nothing here to decide:
 * the export runs at the press, exactly as `exportEpubFromStep` (the host's own
 * unattended door) has always stayed internal. So no row for this exists in the
 * host's list, which is why it is `runDetached(…, false)` and not `runJob`: it is
 * nobody's twin, and the hosted shelf draws it for the seconds it lasts with its
 * ✕ reaching it through `ourRow` (2026-09-08). What it must never be is marked
 * `hostScheduled`, which would hide a row that nothing else is drawing.
 *
 * ── The dedupe stays at this door ───────────────────────────────────────────
 *
 * `runJob` deliberately never dedupes — a host that scheduled a run is not to
 * be overruled — but this door IS the scheduler for what comes through it, so
 * it keeps `enqueueHere`'s rule: a row already waiting or running to write this
 * file is handed back as it stands, pending, and the caller reads the state to
 * tell "already being made" from a settle. Two runs writing one file is still
 * the worst outcome available.
 *
 * A READING IS REFUSED BY NAME. Nothing in the app sends one here, and nothing
 * ever should: hours of GPU under a dialog's spinner is the exact thing the
 * hold was built to prevent.
 */
export async function runNow(
  request: JobRequest,
  /** The position at the press — `enqueueHere`'s argument, for its reasons. */
  parentStep: string | null = null,
): Promise<Job> {
  if (request.kind === 'read') {
    throw new Error(
      'A reading is hours of GPU — it is queued and held for Start, never run under a dialog.',
    );
  }
  /*
   * AND A PROMISE IS REFUSED BY NAME, for the reading's reason said the other way
   * round. This door runs the work NOW, under a dialog somebody is watching; a
   * request carrying `deferred` cannot be run now by definition — the step it is
   * made from has not landed, so there is no book to compile and no chain to
   * replay. It belongs in the queue, behind the row that will land it, which is
   * what the export card does with it (`plan.deferred`, export-dialog).
   */
  if (deferralOf(request) !== undefined) {
    throw new Error(
      'This export is of a step that has not finished yet, so there is nothing to make it from '
      + 'right now. It belongs in the queue, behind the work it comes from.',
    );
  }
  const already = pendingFor(productOf(request));
  if (already) return copyOf(already);

  // NOT `runJob`: that door is the seam's and marks its row as a host's twin.
  // This run was decided here, at the button, and nothing anywhere else holds a
  // row for it — see the paragraph above and `hostScheduled`.
  const { job, wait, parked } = await runDetached(request, { parentStep }, false);
  /*
   * ── A WAIT HERE IS A FAILED EXPORT, BY NAME ───────────────────────────────
   *
   * This door has no queue behind it: the person is standing in front of the
   * dialog waiting for a file, and there is nobody to park the row for. It is also
   * close to unreachable — an export, a compile and a mint all take {@link
   * UNPLACED} (`capabilityClassOf` says they meet no model), so no placement of
   * theirs can wait — and "close to" is where the expensive failures live. So the
   * holder's own sentence becomes the dialog's answer rather than a promise that
   * never resolves.
   *
   * A PARK ANSWERS THE SAME WAY, for the same reason: nobody is here to re-queue
   * it, and the engine's sentence already says the pages are banked and the
   * same press resumes.
   */
  if (wait !== null || parked !== null) {
    return {
      ...job,
      state: 'failed',
      error: wait?.reason ?? parked ?? 'The run was parked.',
      finishedAt: Date.now(),
    };
  }

  /*
   * OUT OF THE LIST, NOW THAT EVERYTHING READ FROM IT. The landings, the
   * announcements and the settle all happened inside `runJob`; what remains is
   * a settled row whose whole account is about to be handed to the dialog that
   * is waiting on this return. `changed()` because the row WAS published while
   * it ran — the shelf that drew it running must hear that it is gone.
   */
  const index = jobs.findIndex((row) => row.id === job.id);
  if (index >= 0) {
    jobs.splice(index, 1);
    requests.delete(job.id);
    changed();
  }

  /*
   * RE-ASK THE DRAIN, STANDALONE ONLY. `runJob` ends without pumping so that a
   * host's back-to-back rows cannot tear the reading server down between every
   * pair (its own essay). Standalone there is no host to declare drain and this
   * run's `noteQueueBusy` cancelled whatever idle countdown was armed — so
   * without this, an export run over a warm server would leave it warm forever.
   * `pump()`'s nothing-to-do branch is the one place drain is declared, and its
   * three facts are all true again by here: the run is out of `detachedRuns`
   * before `runJob` returns.
   */
  if (hostQueue() === null) void pump();
  return job;
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
