/**
 * WHO OWNS THE MAC'S GPU RIGHT NOW — the pure half of the refusal.
 *
 * On Apple Silicon there is ONE GPU and its memory is the machine's memory. Two
 * Orpheus/MLX renders at once do not split the machine in half; they each take
 * ~7 GB of weights plus a KV cache and a batch, and the third one takes the
 * desktop down with it. That is not a theory: on Sep 1 2026 an orphaned
 * `worker.py` (its parent Electron had been Ctrl-C'd out from under it, so
 * `killAllWorkers` never ran) kept rendering for 1h31m while the app launched a
 * second worker on top of it and a CLI run from another machine launched a
 * third — 55-60 GB wired, the renderer OOM-killed, every throughput number from
 * that night worthless.
 *
 * So before the FIRST worker of a session is spawned on darwin/Orpheus, the
 * bridge reads `ps` and asks this module whether anyone else is already
 * rendering. If someone is, we REFUSE. A warning would be wrong: the run that
 * would follow is both slow and destructive, and its measurements are garbage.
 *
 * Everything here is pure — a `ps` snapshot in, a list of foreign renders out —
 * so the selection rules are testable without a GPU, a worker, or an app.
 * `electron/parallel-tts-bridge.ts` supplies the snapshot and throws.
 *
 * WHAT COUNTS AS A FOREIGN RENDER
 *   worker.py                 e2a's lightweight batch worker — the process that
 *                             actually holds the model. Every route to the GPU
 *                             ends in one of these, which is why the guard
 *                             cannot be fooled by a caller it doesn't know.
 *   app.py --worker_mode      e2a's full batch worker (useLightweightWorker=false).
 *   orpheus-batch-render.js   the CLI's headless render (renderRangeHeadless).
 *   bookforge-tts.py          the CLI front end that drives the above.
 *
 * WHAT DOES NOT
 *   narrator.serve            the resident Listen/extension server. It has always
 *                             coexisted with audiobook renders — it holds one
 *                             model and yields between requests — and calling it
 *                             a fault would refuse every render on a machine
 *                             where the reader is switched on.
 *   this session's own pids   anything whose command carries `--session <ours>`.
 *   our own ancestor chain    the CLI is `bookforge-tts.py` -> `node
 *                             orpheus-batch-render.js` -> (this code). Both of
 *                             those match the patterns above and both of them
 *                             ARE the caller. A guard that refuses to run
 *                             because its own parent exists is a guard that
 *                             never lets the CLI run at all.
 */

/**
 * The resident Listen/extension server, as it appears in `ps`.
 *
 * `shared/` cannot import from `electron/`, so this is spelled out rather than
 * taken from `narrator-spawn.ts`'s `SERVE_PROCESS_RE` — and it is a LITERAL, not
 * a regex, because `mentionsScript` escapes what it is given and anchors it to
 * whole whitespace-delimited components.
 */
const SERVE_MODULE = 'narrator.serve';

/** One row of `ps -Ao pid,ppid,etime,command`. */
export interface PsRow {
  pid: number;
  ppid: number;
  /** `ps` ELAPSED, verbatim: `04:12`, `01:31:07`, `24-03:25:14`. */
  etime: string;
  command: string;
}

export type ForeignRenderKind =
  | 'e2a-worker'        // worker.py
  | 'e2a-app-worker'    // app.py --worker_mode
  | 'cli-batch-render'  // orpheus-batch-render.js
  | 'cli-tts';          // bookforge-tts.py

export interface ForeignRender extends PsRow {
  kind: ForeignRenderKind;
  /** The script name that matched (`worker.py`, `orpheus-batch-render.js`, …).
   *  The refusal quotes the command FROM here, not from argv[0]: the first 100
   *  characters of a real command line are the interpreter's absolute path
   *  (`/Users/…/Application Support/BookForge/runtime/e2a-env/bin/python`) and
   *  name nothing at all. */
  script: string;
}

export interface GpuOwnershipQuery {
  /** The pid asking. It and every ancestor of it are excluded. */
  selfPid: number;
  /** This session's e2a session id; a command carrying `--session <id>` is ours. */
  sessionId?: string | null;
}

/** How much of a command line the refusal quotes. Enough to name the voice and
 *  the book; not so much that a Chrome-sized argv buries the pid. */
export const COMMAND_PREVIEW_CHARS = 100;

/**
 * `ps` prints a header and pads its columns, and a command can contain anything
 * (spaces, tabs, quotes), so only the FIRST THREE fields are delimited — the
 * rest of the line is the command, verbatim.
 */
export function parsePsRows(psOutput: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const rawLine of psOutput.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue; // the header, and anything else that isn't a process row
    const command = m[4].trim();
    if (!command) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), etime: m[3], command });
  }
  return rows;
}

/**
 * `pid` and every ancestor of it, from the same snapshot the selection uses —
 * so the chain cannot disagree with the process list because it was read a
 * moment later. Cycle-safe (a corrupt snapshot must not hang the guard).
 */
export function ancestorPids(rows: PsRow[], pid: number): number[] {
  const byPid = new Map<number, PsRow>();
  for (const row of rows) byPid.set(row.pid, row);
  const chain: number[] = [pid];
  const seen = new Set<number>([pid]);
  let cur = byPid.get(pid);
  while (cur && cur.ppid > 0 && !seen.has(cur.ppid)) {
    chain.push(cur.ppid);
    seen.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return chain;
}

/** `worker.py`, `app.py`, `foo.js` as a whole path component — never as a
 *  suffix of a longer name. `separator_worker.py` is not `worker.py`. */
function mentionsScript(command: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s/\\\\])${escaped}(?=$|\\s)`).test(command);
}

/** `--session <id>` or `--session=<id>`, with the id matched whole. */
function carriesSession(command: string, sessionId: string): boolean {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`--session(?:_dir)?[=\\s]\\S*${escaped}`).test(command);
}

function classify(command: string): { kind: ForeignRenderKind; script: string } | null {
  // The resident streaming server is not a fault — check it first so nothing
  // below can claim it. Its command line became `python -u -m narrator.serve`
  // with the phase-2 cut-over; `mentionsScript` matches the module token exactly
  // as it matched a script name, because both are whole whitespace-delimited
  // components. Leaving the old literal here would not throw — the server would
  // simply stop being recognised, and every render on a machine with the reader
  // switched on would be refused as a foreign job.
  if (mentionsScript(command, SERVE_MODULE)) return null;
  if (mentionsScript(command, 'worker.py')) return { kind: 'e2a-worker', script: 'worker.py' };
  if (mentionsScript(command, 'orpheus-batch-render.js')) {
    return { kind: 'cli-batch-render', script: 'orpheus-batch-render.js' };
  }
  if (mentionsScript(command, 'bookforge-tts.py')) return { kind: 'cli-tts', script: 'bookforge-tts.py' };
  // `app.py` on its own is far too common a filename to treat as evidence. e2a's
  // batch worker is `app.py --worker_mode --session ...`, and that is what we
  // are looking for.
  if (mentionsScript(command, 'app.py')
    && (/(?:^|\s)--worker_mode(?=$|\s)/.test(command) || /(?:^|\s)--session(?=$|[\s=])/.test(command))) {
    return { kind: 'e2a-app-worker', script: 'app.py' };
  }
  return null;
}

/**
 * The foreign renders in this `ps` snapshot, in pid order. Empty means the GPU
 * is ours to take.
 */
export function findForeignRenders(psOutput: string, query: GpuOwnershipQuery): ForeignRender[] {
  const rows = parsePsRows(psOutput);
  const ours = new Set(ancestorPids(rows, query.selfPid));
  const sessionId = query.sessionId?.trim() || '';

  const found: ForeignRender[] = [];
  for (const row of rows) {
    if (ours.has(row.pid)) continue;
    if (sessionId && carriesSession(row.command, sessionId)) continue;
    const hit = classify(row.command);
    if (!hit) continue;
    found.push({ ...row, kind: hit.kind, script: hit.script });
  }
  return found.sort((a, b) => a.pid - b.pid);
}

/**
 * The readable part of a command line: everything from the script that matched,
 * capped. Starting at argv[0] would spend the whole budget on an interpreter
 * path — the packaged Orpheus python alone is 87 characters — and tell the user
 * nothing about which render this is.
 */
export function previewCommand(command: string, script: string): string {
  const at = script ? command.indexOf(script) : -1;
  const from = at > 0 ? at : 0;
  const body = command.slice(from);
  const head = from > 0 ? '…' : '';
  return body.length > COMMAND_PREVIEW_CHARS
    ? `${head}${body.slice(0, COMMAND_PREVIEW_CHARS)}…`
    : `${head}${body}`;
}

/** The line for one offender: pid, how long it has been running, what it is. */
export function describeForeignRender(proc: ForeignRender): string {
  return `  pid ${proc.pid}  running ${proc.etime}  ${previewCommand(proc.command, proc.script)}`;
}

/** The env var that turns the refusal into a note. */
export const ALLOW_SHARED_GPU_ENV = 'ORPHEUS_ALLOW_SHARED_GPU';

/**
 * The refusal, verbatim. It names every offender and both ways out, because a
 * message that only says "the GPU is busy" leaves the user hunting for a
 * process they cannot see (the one that started this was an ORPHAN — nothing on
 * screen had a stop button for it).
 */
export function gpuOwnershipRefusal(found: ForeignRender[]): string {
  const lines = [
    found.length === 1
      ? 'Another Orpheus render is already using this Mac\'s GPU:'
      : `${found.length} other Orpheus renders are already using this Mac's GPU:`,
    '',
    ...found.map(describeForeignRender),
    '',
    'This Mac has one GPU and its memory is the machine\'s memory, so a second',
    'MLX render would be slow, would make both sets of timings meaningless, and',
    'can take the desktop down with it.',
    '',
    'Stop that render first (quit whatever started it, or kill the pid above),',
    `or set ${ALLOW_SHARED_GPU_ENV}=1 to start anyway.`,
  ];
  return lines.join('\n');
}

/** The same list, as a note, when the override is set. */
export function gpuOwnershipOverrideNote(found: ForeignRender[]): string {
  const lines = [
    `${ALLOW_SHARED_GPU_ENV}=1 — starting anyway, on top of ${found.length} other render(s):`,
    ...found.map(describeForeignRender),
  ];
  return lines.join('\n');
}
