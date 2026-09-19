/**
 * THE INSTALL DOOR'S WIRE — what main tells a window while Crucible arrives.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.2 (the outcome file), §2.6 (the
 * door that can be WATCHED rather than only driven) and §3.1 (the progress
 * list both apps draw). Owen, 2026-09-18: *"this should be idiot proof. we
 * should assume the user doesn't know how to do it, and we shouldn't offer to
 * let them do it themselves."* So there is no command on any screen, no token,
 * no button labelled "WSL"; there is a list of rows that fills in, and at the
 * end of it one of three sentences.
 *
 * ── THE EVENT NAMES ARE THE SDK'S, NOT THIS FILE'S ─────────────────────────
 *
 * `@crucible/bootstrap`'s `HOST_EVENT_KINDS` is `step, progress, state, line,
 * done, failed` and its `HostEvent` is the ndjson `POST /install` already
 * answers with (`crucible/host/door.py`, envelope from `crucible/tasks.py`).
 * PHASE19 §3.1 writes that set as "state|step|line|done|error|progress" in
 * prose; the wire says `failed`, and the wire wins — a fourth spelling of one
 * fact is the thing ARCHITECTURE.md R1 forbids. What this file adds is only
 * the camelCase reading of it, because every field that crosses Foundry's
 * preload is camelCase and `bytes_done` in a template would be the one
 * exception.
 *
 * ── WHY THE ROWS ARE A REDUCER AND NOT A LOG ───────────────────────────────
 *
 * The old install door printed the installer's last line into one paragraph.
 * That is honest and unreadable: a fresh machine is tens of minutes of pip and
 * curl (§2.12 measured host install ~70 s, the carry 19 s, one env 217 s), and
 * a single line that changes every second tells somebody nothing about where
 * they are. §3.1 asks for named rows in a fixed order instead, so the answer
 * to "is it stuck?" is "no, it is on row four of six". {@link applyInstallEvent}
 * is the whole of that translation and it is PURE, so a keeper can drive it
 * with a scripted stream and read the rows out.
 *
 * ── A ROW NOTHING REPORTED IS NOT DRAWN ────────────────────────────────────
 *
 * Every row starts `waiting`. A `done` event turns every row that never ran
 * into `skipped`, and the renderer draws no `skipped` row. That is one rule
 * with three uses: on a Mac there is no Windows engine and no Linux engine to
 * set up; on a Windows machine that DECLINED the move (`wsl = "never"`) the
 * three guest rows never start; and on one that `cannot` host WSL2 they stop
 * where the state table stopped. In every case a grey row sitting under the
 * word "Done" forever would be the screen lying about what it knows.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The outcome — §2.2, the ONE owner of "what happened to the move here"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five terminal words of `%LOCALAPPDATA%\Crucible\wsl-outcome.json`.
 *
 * `declined` is `[orchestrator] wsl = "never"` and no app offers to write it;
 * it is read so that a machine somebody kept native on purpose is not shown a
 * Try again button about a move it was told not to make.
 */
export const CRUCIBLE_INSTALL_OUTCOME_STATES = [
  'done', 'reboot-pending', 'cannot', 'failed', 'declined',
] as const;

export type CrucibleInstallOutcomeState = (typeof CRUCIBLE_INSTALL_OUTCOME_STATES)[number];

/** §2.2's file, field for field. `null` where the file writes null. */
export interface CrucibleInstallOutcome {
  state: CrucibleInstallOutcomeState;
  /** A state-table code or a task failure code; null on `done` and `declined`. */
  code: string | null;
  /** The 4c sentence, verbatim, and the only thing a person is shown about a refusal. */
  sentence: string | null;
  at: string;
  release: string | null;
  /** §2.2: a `failed` is retried once by the tray, and the count lives in the file. */
  attempts: number;
}

/**
 * `GET /install` on the orchestrator (§2.6), as a window reads it.
 *
 * `presence` is deliberately absent: §2.6 answers with it and no screen in
 * Foundry draws it, so carrying it across the preload would be a field with no
 * reader. It joins this shape the day something asks.
 */
export interface CrucibleInstallStatus {
  running: boolean;
  outcome: CrucibleInstallOutcome | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The events — `@crucible/bootstrap`'s HostEvent, read into camelCase
// ─────────────────────────────────────────────────────────────────────────────

/** Which named row an event is about. The ids are matched, never the labels. */
export type CrucibleInstallRowId =
  | 'install'
  | 'windows-engine'
  | 'linux-engine'
  | 'job-types'
  | 'models';

export const CRUCIBLE_INSTALL_ROW_IDS: readonly CrucibleInstallRowId[] = [
  'install', 'windows-engine', 'linux-engine', 'job-types', 'models',
];

/** `state`'s `action` kind, as `WslAction` spells it in the SDK. */
export type CrucibleInstallAction = 'run' | 'run-elevated' | 'instruct' | 'link';

export type CrucibleInstallEvent =
  /**
   * A row began. `jobType` is set ONLY on the `job-types` row, where §3.1 asks
   * for "one row per job type the module asked for" — the child rows are the
   * job types, and the row above them is their heading.
   */
  | { event: 'step'; row: CrucibleInstallRowId; jobType: string | null }
  /** Bytes, for the downloads that have a total. pip has none and sends `line`. */
  | { event: 'progress'; bytesDone: number; bytesTotal: number | null; file: string }
  /** The state table's answer for this machine, mid-move. */
  | { event: 'state'; code: string; sentence: string; action: CrucibleInstallAction }
  /** One line a step printed — pip's own output, under the row it belongs to. */
  | { event: 'line'; text: string; stream: 'stdout' | 'stderr' }
  /**
   * The run finished. `backend` is what is serving now, so §3.1's last row can
   * say "on the Linux engine" or "on the Windows engine" from a MEASURED fact
   * rather than from which rows happened to run.
   */
  | { event: 'done'; backend: string | null }
  /** The run stopped. `code` is a state-table code or a task failure code. */
  | { event: 'failed'; code: string; message: string };

// ─────────────────────────────────────────────────────────────────────────────
// The rows — §3.1's list, and the reducer that fills it in
// ─────────────────────────────────────────────────────────────────────────────

export type CrucibleInstallRowState = 'waiting' | 'running' | 'done' | 'failed' | 'skipped';

/** One job type under the `job-types` row. The LABEL is the renderer's. */
export interface CrucibleInstallChildRow {
  jobType: string;
  state: CrucibleInstallRowState;
  /** pip's last line for this job type. §2.12: pip has no total, so no bar. */
  detail: string | null;
}

export interface CrucibleInstallRow {
  id: CrucibleInstallRowId;
  /** Composed where the plan is composed (electron/crucible-install.ts). */
  label: string;
  state: CrucibleInstallRowState;
  /** The last thing this row said — a printed line, or a state sentence. */
  detail: string | null;
  /** Bytes, when the step carries them. Both null on a step that cannot count. */
  bytesDone: number | null;
  bytesTotal: number | null;
  children: CrucibleInstallChildRow[];
}

/** The skeleton, from the labels the plan carried. Every row `waiting`. */
export function initialInstallRows(
  labels: readonly { id: CrucibleInstallRowId; label: string }[],
): CrucibleInstallRow[] {
  return labels.map((it) => ({
    id: it.id, label: it.label, state: 'waiting',
    detail: null, bytesDone: null, bytesTotal: null, children: [],
  }));
}

/**
 * ONE EVENT, APPLIED. Pure: it returns new rows and mutates nothing.
 *
 * ── The three rules, and they are the whole of it ──────────────────────────
 *
 * 1. A `step` marks its row `running` and marks every row BEFORE it that was
 *    running `done`. The stream is ordered, so a later row starting is the
 *    only proof an earlier one finished — the door does not send a per-row
 *    "finished" and inventing one here would be a second opinion about it.
 * 2. `progress`, `line` and `state` land on whichever row is running. They
 *    carry no row of their own on the wire (`HostProgressData` names a FILE,
 *    `HostLineData` a stream), and the step they belong to is the last `step`
 *    event's — that sentence is the SDK's, on `HostLineData`.
 * 3. `done` and `failed` are terminal. `done` finishes what was running and
 *    SKIPS what never started; `failed` fails what was running and skips the
 *    rest, because a row after a failure did not run either.
 */
export function applyInstallEvent(
  rows: readonly CrucibleInstallRow[],
  event: CrucibleInstallEvent,
): CrucibleInstallRow[] {
  const copy = rows.map((row) => ({ ...row, children: row.children.map((child) => ({ ...child })) }));
  const running = copy.find((row) => row.state === 'running');

  switch (event.event) {
    case 'step': {
      const at = copy.findIndex((row) => row.id === event.row);
      /*
       * A ROW THIS SKELETON DOES NOT HAVE IS DROPPED, NOT APPENDED. The
       * skeleton is the platform's (a Mac has no Windows engine row), so a
       * `windows-engine` step arriving on a Mac is a door talking about a
       * machine this is not — and drawing a row for it would be this screen
       * inventing a step from a message it did not expect.
       */
      const began = copy[at];
      if (began === undefined) return copy;
      for (const earlier of copy.slice(0, at)) {
        if (earlier.state === 'running') earlier.state = 'done';
      }
      began.state = 'running';
      if (event.jobType !== null) {
        for (const child of began.children) {
          if (child.state === 'running') child.state = 'done';
        }
        const child = began.children.find((it) => it.jobType === event.jobType);
        if (child === undefined) {
          began.children.push({ jobType: event.jobType, state: 'running', detail: null });
        } else {
          child.state = 'running';
        }
      }
      return copy;
    }
    case 'progress': {
      if (running === undefined) return copy;
      running.bytesDone = event.bytesDone;
      running.bytesTotal = event.bytesTotal;
      running.detail = event.file;
      return copy;
    }
    case 'line': {
      if (running === undefined) return copy;
      const child = running.children.find((it) => it.state === 'running');
      if (child === undefined) running.detail = event.text;
      else child.detail = event.text;
      return copy;
    }
    case 'state': {
      if (running === undefined) return copy;
      running.detail = event.sentence;
      return copy;
    }
    case 'done': {
      for (const row of copy) {
        if (row.state === 'running') row.state = 'done';
        else if (row.state === 'waiting') row.state = 'skipped';
        for (const child of row.children) {
          if (child.state === 'running') child.state = 'done';
          else if (child.state === 'waiting') child.state = 'skipped';
        }
      }
      return copy;
    }
    case 'failed': {
      for (const row of copy) {
        if (row.state === 'running') { row.state = 'failed'; row.detail = event.message; }
        else if (row.state === 'waiting') row.state = 'skipped';
        for (const child of row.children) {
          if (child.state === 'running') child.state = 'failed';
          else if (child.state === 'waiting') child.state = 'skipped';
        }
      }
      return copy;
    }
  }
}
