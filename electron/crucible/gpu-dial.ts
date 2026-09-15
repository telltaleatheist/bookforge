/**
 * THE QUEUE'S GPU DIAL — where its value lives.
 *
 * Owen, 2026-09-15 (`docs/PENDING-QUEUE-AND-GPU-DIAL.md`): *"the queue itself
 * carries a GPU dial: `any`, or one named server"*, turnable while work is
 * moving. It DEFERS and never overrides — the precedence table and the reason
 * are on `GPU_DIAL_ANY` in `shared/queue/wait-for.ts`, which is the only thing
 * that may apply it.
 *
 * ── Why a record of its own, and not a key in an existing one ───────────────
 *
 *   <userData>/queue-gpu-dial.json
 *   { "dial": "3090 Ti" }
 *
 * `crucible-routing.json` was the obvious place and is the wrong one. That
 * record is the operator's STANDING preference about hardware — the rank order,
 * the enable switches, what a new row defaults to — and every one of those is a
 * thing you set in Settings and forget. The dial is the opposite: a live lever
 * on the queue page that a person turns three times in an evening while watching
 * a render. Folding a moment-to-moment control into the file that holds standing
 * preferences means every flick of it rewrites the record that holds the ranks,
 * and a half-written file there loses every preference at once (that file's own
 * header says so). Two facts, two lifetimes, two owners — crucible
 * `docs/ARCHITECTURE.md` R1.
 *
 * ── Why it is persisted at all ─────────────────────────────────────────────
 *
 * Because it is an INSTRUCTION, not a session mood. "Everything goes to the Mac
 * tonight" has to still be true after the app restarts in the middle of the
 * night, or the queue quietly resumes taking whatever card it likes — which is
 * the thing the dial exists to stop.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────
 *
 * It never reads the queue and it never decides anything. It stores a string and
 * refuses a bad one by name; `queue-ipc.ts` hands it to the engine as a FACT and
 * `decideWaitFor` is the single place the precedence table is enforced. That is
 * what keeps `shared/queue/wait-for.ts` and `shared/queue/slot-sets.ts` pure
 * enough for a keeper to drive with no engine, no registry and no network.
 *
 * Written temp-and-rename like the registry and the routing record, for the same
 * reason: a half-written file is the one shape that loses the answer entirely.
 */
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { GPU_DIAL_ANY } from '../../shared/queue/wait-for';
import { knownServers } from './routing';

/** The record on disk. One field, because it answers one question. */
export interface GpuDialRecord {
  /** `any`, or a registered server's name. Never empty, never absent. */
  dial: string;
}

export type CrucibleGpuDialErrorCode =
  /** The record exists and is not the record. Refused, never replaced. */
  | 'corrupt_gpu_dial'
  /** A name that is not one of this machine's Crucible servers. */
  | 'unknown_server';

export class CrucibleGpuDialError extends Error {
  readonly code: CrucibleGpuDialErrorCode;

  constructor(code: CrucibleGpuDialErrorCode, message: string) {
    super(message);
    this.name = 'CrucibleGpuDialError';
    this.code = code;
  }
}

/** `<userData>/queue-gpu-dial.json`. Resolved at CALL time, like the registry. */
export function gpuDialPath(): string {
  return path.join(app.getPath('userData'), 'queue-gpu-dial.json');
}

/**
 * The dial, over one file. Every method takes the servers that exist right now,
 * so a keeper drives it with a scripted set and the doors below bind it to the
 * real registry.
 */
export class GpuDial {
  constructor(private readonly file: string) {}

  /**
   * What the dial is set to.
   *
   * A MISSING FILE IS `any`, and that is not a fallback: `any` is the state of a
   * dial nobody has turned, and it is the state in which the dial changes
   * nothing about where a book goes. The distinction matters — a defaulted
   * SERVER NAME would be an instruction nobody gave, which is exactly what
   * §4.2.1a refuses to manufacture for a row.
   *
   * A file that exists and is not the record is REFUSED. It holds a standing
   * instruction about somebody's hardware, and starting over silently would send
   * tonight's books to a machine the operator had steered them away from.
   */
  read(): string {
    const file = this.file;
    if (!fs.existsSync(file)) return GPU_DIAL_ANY;

    let parsed: unknown;
    const raw = fs.readFileSync(file, 'utf-8');
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new CrucibleGpuDialError(
        'corrupt_gpu_dial',
        `${file} is not valid JSON (${(err as Error).message}). It records which GPU the queue is `
          + 'steering work to, so nothing here will replace it — repair or delete the file by hand.',
      );
    }
    const record = parsed as Partial<GpuDialRecord> | null;
    const dial = record?.dial;
    if (typeof dial !== 'string' || dial === '') {
      throw new CrucibleGpuDialError(
        'corrupt_gpu_dial',
        `${file}: "dial" must be "${GPU_DIAL_ANY}" or a server's name, not `
          + `${JSON.stringify(dial)}. Repair or delete the file by hand.`,
      );
    }
    /*
     * A NAME THE REGISTRY NO LONGER HAS IS KEPT AND HONOURED, not pruned here.
     *
     * The same argument `routing.ts` makes about a removed machine's rank: the
     * record is the operator's, and silently turning their dial back to `any`
     * because a server was renamed would start sending books to cards they had
     * steered away from, with nothing saying so. The hold `decideWaitFor`
     * produces for it NAMES the missing server and lists the ones that exist
     * (`holdUnknownServer`), which is a sentence a person can act on.
     */
    return dial;
  }

  /**
   * Turn the dial. Refused by name for a server this machine does not have,
   * because accepting it would park every `any` book behind a machine that does
   * not exist and the row could only say so an hour later.
   *
   * A DISABLED server is deliberately ACCEPTED. Disabling is §4.2.2's capacity
   * switch — standing state about hardware — and a dial pointed at a disabled
   * machine is an honest, readable state: the rows park with
   * `holdDisabled`'s sentence, which names the switch and where to flip it.
   * Refusing here would make the operator resolve the two controls in one
   * particular order for no reason.
   */
  set(value: string, known: readonly string[]): string {
    if (value !== GPU_DIAL_ANY && !known.includes(value)) {
      throw new CrucibleGpuDialError(
        'unknown_server',
        `"${value}" is not one of this machine's Crucible servers `
          + `(${known.length === 0 ? 'there are none' : known.join(', ')}). The queue's GPU dial `
          + `is "${GPU_DIAL_ANY}" or one of those.`,
      );
    }
    const file = this.file;
    const temp = `${file}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temp, `${JSON.stringify({ dial: value } as GpuDialRecord, null, 2)}\n`, 'utf-8');
    fs.renameSync(temp, file);
    return value;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The app's dial: <userData>/queue-gpu-dial.json over the real server set
// ─────────────────────────────────────────────────────────────────────────────

function store(): GpuDial {
  return new GpuDial(gpuDialPath());
}

/** What the queue's GPU dial is set to: `any`, or a server's name. */
export function readGpuDial(): string {
  return store().read();
}

/** Turn the queue's GPU dial. Refuses an unknown server BY NAME. */
export function setGpuDial(value: string): string {
  return store().set(value, knownServers());
}
