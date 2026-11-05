/**
 * THE ONE VIEW OF A REPAIR, for this machine's Crucible and for one on another machine.
 *
 * A local repair (`@crucible/bootstrap`'s `repair()`) also looks after the server and
 * its service, which cannot repair themselves; a remote one is only the server's own
 * `repair` task. Both end in the same `RepairResult`, so one reducer and one panel
 * read both. Compiled into the renderer, so the SDK's shapes are written out here;
 * `electron/crucible/repair.ts` has an identity function that fails to compile if they
 * ever differ.
 *
 * THE VIEW NEVER IMPLIES MORE THAN WAS CHECKED. `healthy` is the server's word, and it
 * is only ever said beside what was looked at and what was not.
 */

export interface CrucibleRepairSubject { readonly kind: string; readonly id: string }
export interface CrucibleRepairFinding { readonly subject: CrucibleRepairSubject; readonly was: string }
export interface CrucibleRepairFailure {
  readonly subject: CrucibleRepairSubject; readonly code: string; readonly message: string;
}
export interface CrucibleRepairUnverified { readonly subject: CrucibleRepairSubject; readonly why: string }
export interface CrucibleRepairNotHashChecked {
  readonly subject: CrucibleRepairSubject; readonly files: readonly string[]; readonly why: string;
}

export interface CrucibleRepairResult {
  readonly healthy: boolean;
  readonly verifyOnly: boolean;
  readonly checked: readonly CrucibleRepairSubject[];
  readonly broken: readonly CrucibleRepairFinding[];
  readonly repaired: readonly CrucibleRepairFinding[];
  readonly failed: readonly CrucibleRepairFailure[];
  readonly unverified: readonly CrucibleRepairUnverified[];
  readonly notHashChecked: readonly CrucibleRepairNotHashChecked[];
  readonly bytesHashed: number;
  readonly bytesSkippedVerified: number;
}

export type CrucibleRepairStep = 'plan' | 'verify' | 'wait' | 'rebuild' | 'repull';
export type CrucibleRepairFrameState = 'running' | 'ok' | 'broken' | 'repaired' | 'failed' | 'unverified';

/** What the door pushes, in order, for one repair of one server. */
export type CrucibleRepairEvent =
  | { readonly kind: 'started'; readonly server: string; readonly verifyOnly: boolean; readonly local: boolean; readonly taskId: string | null }
  | { readonly kind: 'task'; readonly server: string; readonly taskId: string }
  /** Local only: the server and its service, before the task. */
  | { readonly kind: 'host-step'; readonly server: string; readonly name: string; readonly status: 'running' | 'ok' | 'failed'; readonly detail: string }
  | {
    readonly kind: 'frame'; readonly server: string; readonly step: CrucibleRepairStep;
    readonly state: CrucibleRepairFrameState; readonly subject: CrucibleRepairSubject | null;
    readonly detail: string | null; readonly bytesToCheck: number | null;
  }
  | { readonly kind: 'progress'; readonly server: string; readonly bytesDone: number; readonly bytesTotal: number | null; readonly file: string }
  | { readonly kind: 'done'; readonly server: string; readonly result: CrucibleRepairResult; readonly hostNote: string | null }
  /** It could not run or finish. `needsUpdate`: the server is too old to have the task. */
  | {
    readonly kind: 'refused'; readonly server: string; readonly code: string; readonly message: string;
    readonly command: string | null; readonly needsUpdate: boolean;
  };

export interface CrucibleRepairView {
  readonly phase: 'running' | 'done' | 'refused';
  readonly verifyOnly: boolean;
  readonly local: boolean;
  readonly taskId: string | null;
  /** The step last reported, which decides what Stop can promise. */
  readonly step: CrucibleRepairStep | null;
  /** The newest thing said about what is happening right now. */
  readonly line: string | null;
  /** A `wait` frame is standing: something this repair needs is in use. */
  readonly waiting: string | null;
  readonly bytesToCheck: number | null;
  readonly bytesDone: number | null;
  readonly bytesTotal: number | null;
  readonly file: string | null;
  readonly result: CrucibleRepairResult | null;
  readonly hostNote: string | null;
  readonly refusal: { readonly code: string; readonly message: string; readonly command: string | null; readonly needsUpdate: boolean } | null;
}

/**
 * The engine on this computer when no row names it: it may be too broken to answer, and
 * its config may be unreadable, which is why it has no row. A key, never shown. The
 * colon makes it an invalid server name (`validateServerName`), so no row can have it.
 */
export const CRUCIBLE_REPAIR_HERE = ':this-computer';

const subjectWords = (s: CrucibleRepairSubject | null): string => (s === null ? '' : `${s.kind} ${s.id}`);

const STEP_WORDS: Readonly<Record<CrucibleRepairStep, string>> = {
  plan: 'Working out what to check',
  verify: 'Checking',
  wait: 'Waiting for',
  rebuild: 'Rebuilding',
  repull: 'Downloading again',
};

/** One event onto the view. Pure, so the keeper can run a whole repair through it. */
export function reduceCrucibleRepair(view: CrucibleRepairView | null, event: CrucibleRepairEvent): CrucibleRepairView {
  if (event.kind === 'started') {
    return {
      phase: 'running', verifyOnly: event.verifyOnly, local: event.local, taskId: event.taskId, step: null,
      line: event.verifyOnly ? 'Starting the check…' : 'Starting the repair…', waiting: null,
      bytesToCheck: null, bytesDone: null, bytesTotal: null, file: null,
      result: null, hostNote: null, refusal: null,
    };
  }
  const base: CrucibleRepairView = view ?? {
    phase: 'running', verifyOnly: false, local: false, taskId: null, step: null, line: null, waiting: null,
    bytesToCheck: null, bytesDone: null, bytesTotal: null, file: null,
    result: null, hostNote: null, refusal: null,
  };
  switch (event.kind) {
    case 'task':
      return { ...base, taskId: event.taskId };
    case 'host-step':
      return { ...base, line: event.detail };
    case 'frame': {
      const about = subjectWords(event.subject);
      const said = event.detail ?? `${STEP_WORDS[event.step]}${about === '' ? '' : ` ${about}`}`;
      if (event.step === 'wait') {
        return { ...base, waiting: event.state === 'running' ? said : null, line: said };
      }
      return {
        ...base,
        step: event.step,
        waiting: null,
        line: said,
        bytesToCheck: event.bytesToCheck ?? base.bytesToCheck,
      };
    }
    case 'progress':
      return { ...base, bytesDone: event.bytesDone, bytesTotal: event.bytesTotal, file: event.file };
    case 'done':
      return { ...base, phase: 'done', waiting: null, line: null, result: event.result, hostNote: event.hostNote };
    case 'refused':
      return {
        ...base, phase: 'refused', waiting: null, line: null,
        refusal: { code: event.code, message: event.message, command: event.command, needsUpdate: event.needsUpdate },
      };
  }
}

/**
 * The one sentence a finished repair ends on. It says what was looked at, and never
 * "everything is fine": a subject that could not be hash-checked or verified is named
 * in the same breath as the verdict.
 */
export function crucibleRepairHeadline(result: CrucibleRepairResult): string {
  const looked = `${result.checked.length} item${result.checked.length === 1 ? '' : 's'} checked`;
  const notFully = result.unverified.length + result.notHashChecked.length;
  const caveat = notFully === 0 ? '' : `; ${notFully} could not be fully verified`;
  if (result.failed.length > 0) {
    return `${result.failed.length} could not be repaired (${looked}${caveat}).`;
  }
  if (result.verifyOnly) {
    return result.broken.length > 0
      ? `${result.broken.length} broken, nothing changed (${looked}${caveat}). Repair puts them back.`
      : `Nothing broken found (${looked}${caveat}). Nothing was changed.`;
  }
  return result.repaired.length > 0
    ? `${result.repaired.length} repaired (${looked}${caveat}).`
    : `Nothing needed repairing (${looked}${caveat}).`;
}

/**
 * WHAT STOP WILL ACTUALLY DO, said before it is pressed. A hash stops within about a
 * megabyte and between subjects at the next one, so those need no words; a rebuild is
 * not interrupted. On this computer the server and its service come first, and they
 * cannot be stopped: Stop appears when the server's own task begins.
 */
export function crucibleRepairStopWords(view: CrucibleRepairView): string | null {
  if (view.phase !== 'running') return null;
  if (view.local && view.taskId === null) return 'Stop appears once the server starts checking.';
  if (view.step === 'rebuild') return 'Stop takes effect after this environment finishes.';
  if (view.step === 'repull') return 'Stop halts the download; the next repair finishes it.';
  return null;
}

/** "12.4 GB", for the bars and the summary. */
export function crucibleRepairBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
