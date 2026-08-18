/**
 * foundry-host-status — what BookForge is doing, in the hosted Foundry's chrome.
 *
 * ── The socket's second push door, and how it differs from the first ────────
 *
 * `setHostNodes` (electron/foundry-host-nodes.ts) says what this app is making
 * OF A PARTICULAR BOOK, and its rows land on that book's provenance tree.
 * `setHostStatus` says what this app is doing AT ALL, and it lands once, in the
 * top corner of the Foundry window, whichever book is open. So there is ONE
 * value for the process rather than one per project: the queue is one queue, and
 * a chip that went blank when somebody opened a second book would go blank at
 * precisely the moment they wanted to know what was still running.
 *
 * ── The words are ours and Foundry composes none of them ────────────────────
 *
 * Foundry draws `headline` verbatim, reads it for LENGTH and for nothing else,
 * and knows nothing about queues, narration or books. That makes the wording
 * this file's whole responsibility — and it is why nothing here is invented.
 * The line is the one BookForge's own title-bar chip says, composed the same way
 * out of the same table (`JOB_GERUND` in shared/queue/job-words.ts, moved there
 * for exactly this): a person looking at two windows of one application must not
 * be told two different things about one run.
 *
 * ── NULL IS A STATEMENT, and it is the idle one ─────────────────────────────
 *
 * An empty queue pushes `null`, the chip leaves Foundry's chrome entirely, and
 * the window looks as it looks with no host at all. That is not an absence of an
 * answer standing in for one — it is the answer, and it is what makes the chip
 * conditional by construction rather than by a flag somebody has to remember.
 *
 * ── Why the mapping is a pure function ──────────────────────────────────────
 *
 * `hostStatusOf` takes a queue snapshot and gives back the value to push,
 * importing nothing from Electron and nothing from the engine's mutable state.
 * So every decision it makes — which run the chip names, what the second line
 * adds, when a percentage may be claimed and when the whole chip goes away — is
 * reachable from a keeper with a hand-built snapshot rather than only by running
 * two applications. See tools/test-foundry-host-status.js.
 */
import { jobStatus, type QueueJob, type QueueSnapshot } from '../shared/queue/engine-types';
import { JOB_GERUND } from '../shared/queue/job-words';

// ────────────────────────────────────────────────────────────────────────────
// The socket's shape, declared on OUR side
// ────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE HOST IS DOING RIGHT NOW — the one surface of Foundry's chrome a host
 * may draw in.
 *
 * DECLARED, NOT IMPORTED, for the reason every other shape of this socket is
 * (electron/main.ts, "the hosted Foundry" block, and electron/foundry-host-nodes.ts):
 * `foundry-app/` is built output of a separate program with its own tsconfig, and
 * a static import would drag the sealed subtree into BookForge's type program.
 * This is the published spelling from foundry-app/shared/host-ops.ts, and a
 * change on their side shows up here as a compile error naming the field.
 *
 * EVERY FIELD BUT THE HEADLINE IS OPTIONAL, and absent is drawn as absent rather
 * than as empty: no detail is no second line, no `pending` is no badge, and no
 * `percent` is no bar — NOT a bar sitting at nothing. That is what makes
 * omission the honest answer to a number we cannot measure yet.
 */
export interface HostStatus {
  /** One line: the verb and the book, exactly as our own chip says them. */
  readonly headline: string;
  /** A second, dimmer line. Omitted when it would only echo the headline. */
  readonly detail?: string;
  /** 0–100, and only when the running step has reported one. */
  readonly percent?: number;
  /** How many runs wait behind the one being named. Omitted when none do. */
  readonly pending?: number;
}

// ────────────────────────────────────────────────────────────────────────────
// The reading of a snapshot
// ────────────────────────────────────────────────────────────────────────────

/**
 * A run that has not ended — the same set the title-bar chip counts.
 *
 * `jobStatus` is the engine's own reading of a job off its steps, so "ended"
 * here means what it means everywhere else in the app rather than a second
 * opinion assembled from step statuses in this file.
 */
function isLive(job: QueueJob): boolean {
  const status = jobStatus(job);
  return status !== 'done' && status !== 'failed' && status !== 'cancelled';
}

/**
 * The value to push, or null when there is nothing to say.
 *
 * ── Which run the chip names ────────────────────────────────────────────────
 *
 * The FIRST live run with a step in flight, and the first such step within it —
 * QueueTrayService's own choice, followed rather than re-decided, because the
 * pools admit three steps at once and any other pick would have this window and
 * that one naming different work at the same instant.
 *
 * ── What `pending` counts, and why it is not "everything else" ──────────────
 *
 * Live runs that are NOT running, counted off each job's own status. A SECOND
 * job that is running is not pending — it is happening — and counting it would
 * report work in flight as work in a queue. That is the tray's rule verbatim.
 *
 * ── The second line ─────────────────────────────────────────────────────────
 *
 * A one-step run's label is the headline's verb by construction ("Assembling
 * Twain" over a step called "Assemble"), so it is omitted: a dimmer line
 * repeating the brighter one above it is noise wearing the shape of information.
 * A run of several steps has a fact the headline cannot carry — WHICH of them is
 * under way, and how far through the run that is — and that is what the detail
 * says, in the step's own label.
 *
 * ── NO FALLBACKS, and the one thing that is genuinely optional ──────────────
 *
 * A percentage is omitted when the step has not reported one, because "no
 * measurement yet" is a true state of a run that has just started and an omitted
 * bar says it exactly. A TITLE is not like that: every run in this queue is
 * about a book, the title is how a person recognises which one, and a run
 * carrying none is a job composed wrongly somewhere upstream. So it throws,
 * naming the run, rather than drawing a chip that says "Narrating " to somebody.
 */
export function hostStatusOf(snapshot: QueueSnapshot): HostStatus | null {
  const live = snapshot.jobs.filter(isLive);
  const pending = live.filter((job) => jobStatus(job) !== 'running').length;
  const running = live.find((job) => job.steps.some((s) => s.status === 'running'));

  if (running === undefined) {
    if (pending === 0) return null;
    return {
      headline: `${pending} run${pending === 1 ? '' : 's'} waiting`,
      pending,
    };
  }

  const index = running.steps.findIndex((s) => s.status === 'running');
  const step = running.steps[index]!;
  const title = running.title.trim();
  if (title === '') {
    throw new Error(
      `The queue run "${running.id}" is under way with no title recorded for the book, so there `
      + 'is nothing to name it by. A run is composed with the book it is about; this one was not.',
    );
  }
  const percent = step.progress.percent;
  const detail = running.steps.length === 1
    ? undefined
    : `${step.label} · step ${index + 1} of ${running.steps.length}`;

  // Spread rather than assigned, on `hostNodeSets`'s rule: the whole value
  // crosses the seam, and an explicit `percent: undefined` is a key Foundry
  // would read as present.
  return {
    headline: `${JOB_GERUND[step.type]} ${title}`,
    ...(detail === undefined ? {} : { detail }),
    ...(percent === undefined ? {} : { percent: Math.round(percent) }),
    ...(pending === 0 ? {} : { pending }),
  };
}
