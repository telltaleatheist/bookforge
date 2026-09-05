/**
 * WHICH narrator BATCH PROCESSES BELONG TO THIS APP.
 *
 * The global orphan sweep force-kills what it finds, so "what it finds" has to be
 * narrower than "anything on this machine running narrator". It was not: a
 * command-line match for `narrator.compat.*` also matches
 *
 *   - the headless CLI's render (`cli/orpheus-audiobook-render.js`), which people
 *     run over ssh precisely so it survives the desktop app,
 *   - a concurrent `--list_sessions` or `--resume_session` from a second window,
 *   - another developer's checkout on a shared box.
 *
 * Killing one of those on app quit destroys work this app did not start and
 * cannot see. The external-GPU-job lock covers the case where somebody REMEMBERED
 * to take it; this covers the case where nobody did, which is the normal case.
 *
 * ── Ancestry, not an environment variable ───────────────────────────────────
 *
 * Every narrator spawn carries `BOOKFORGE_OWNER_PID`, which is exactly the fact
 * needed — but WMIC cannot read another process's environment block, and reading
 * it out of process memory is not something a shutdown path should be doing. The
 * parent chain says the same thing and WMIC hands it over for free: a batch
 * process this app started is a descendant of this app, whether it is a direct
 * child or sits under a `conda run` shim two levels down.
 *
 * Pure, and separated from the WMIC call, so the ownership rule can be tested
 * against a fabricated process table instead of a live machine.
 */

/** One row of the process table: what a sweep needs to decide ownership. */
export interface ProcRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * Parse `wmic process get commandline,parentprocessid,processid /format:csv`.
 *
 * The CSV is `Node,CommandLine,ParentProcessId,ProcessId`, and A COMMAND LINE
 * CONTAINS COMMAS — every argv with a quoted path does. So the two numeric fields
 * are taken from the END and everything between the first comma and them is the
 * command, rather than splitting on ',' and hoping.
 */
export function parseWmicProcessCsv(csv: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const raw of csv.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('Node,')) continue;
    const lastComma = line.lastIndexOf(',');
    if (lastComma < 0) continue;
    const prevComma = line.lastIndexOf(',', lastComma - 1);
    if (prevComma < 0) continue;
    const pid = Number(line.slice(lastComma + 1));
    const ppid = Number(line.slice(prevComma + 1, lastComma));
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    const firstComma = line.indexOf(',');
    rows.push({ pid, ppid, command: line.slice(firstComma + 1, prevComma) });
  }
  return rows;
}

/** Is `pid` a descendant of `rootPid`? Cycle-safe and depth-bounded. */
export function isDescendantOf(rows: ProcRow[], pid: number, rootPid: number): boolean {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set<number>();
  let cur = byPid.get(pid);
  // A pid table read at one instant can contain a cycle after pid reuse, and a
  // chain on Windows is a handful of links; both are bounded here rather than
  // trusted.
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur.ppid === rootPid) return true;
    if (seen.has(cur.ppid)) return false;
    seen.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return false;
}

/**
 * The pids this app may force-kill: a narrator BATCH door, descended from us,
 * and never the resident Listen server.
 *
 * `serveRe` is passed in rather than imported so this file stays free of
 * electron/ — `narrator-spawn.ts` owns the pattern and `shared/` may not reach
 * into `electron/`.
 */
export function ownBatchPids(
  rows: ProcRow[],
  opts: { selfPid: number; batchRe: RegExp; serveRe: RegExp },
): number[] {
  return rows
    .filter((r) => opts.batchRe.test(r.command))
    .filter((r) => !opts.serveRe.test(r.command))
    .filter((r) => r.pid !== opts.selfPid)
    .filter((r) => isDescendantOf(rows, r.pid, opts.selfPid))
    .map((r) => r.pid);
}
