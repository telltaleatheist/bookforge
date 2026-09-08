/**
 * The assembly's PREPARE stage, read off narrator's stdout.
 *
 * Owen pressed Assemble on Mutineer's Moon and the card showed nothing for four
 * minutes. Underneath, narrator was reading 847 sentence FLACs over SMB and
 * writing ~1,700 faded copies and silences back — real work, entirely invisible,
 * because the first line the bridge could map to a stage
 * (`[ASSEMBLE] Chapter N: sentences X-Y`) is not printed until every chapter has
 * been planned. Owen: "if its actually doing something, it needs to show the user
 * that its working so they dont think its stalled."
 *
 * narrator now says so (assemble/chapters.py, assemble/run.py):
 *
 *     [ASSEMBLE] Preparing sentences 412/847
 *     [ASSEMBLE] Prepared 847 sentences in 63.4s
 *
 * This module is the ONLY place those two lines are understood. It is pure so it
 * can be tested without a subprocess, an ffmpeg or a library —
 * `tools/test-assembly-prepare-progress.js` reads the format strings out of
 * narrator's own source, pushes the lines they produce through here, and so fails
 * on THIS side when somebody renames a line on THAT side.
 *
 * A CHUNK, NOT A LINE. `proc.stdout.on('data')` hands the bridge whatever the
 * pipe had, which can be several lines at once, so the parser scans the whole
 * chunk and reports the LAST position in it — a bar that reports the oldest
 * number in a burst is a bar that lags for no reason. The closing "Prepared"
 * line wins over any progress line in the same chunk, because it is the later
 * event.
 */

/** Where preparation has got to, as one stdout chunk describes it. */
export interface AssemblyPrepareProgress {
  /** Sentences prepared so far. Equals `total` on the closing line. */
  done: number;
  /** Sentences in the whole book — a manifest fact, known before any file is read. */
  total: number;
  /** 0-100 WITHIN the prepare stage. */
  pct: number;
  /** What the card should say. */
  message: string;
  /** True only for the closing `Prepared N sentences in Xs` line. */
  finished: boolean;
  /** Wall seconds the whole step took. Present only when `finished`. */
  seconds?: number;
}

/** `[ASSEMBLE] Preparing sentences <done>/<total>` */
const PREPARING_RE = /\[ASSEMBLE\] Preparing sentences (\d+)\/(\d+)/g;

/** `[ASSEMBLE] Prepared <total> sentences in <seconds>s` */
const PREPARED_RE = /\[ASSEMBLE\] Prepared (\d+) sentences in ([\d.]+)s/g;

/** The last match of a global regex in `text`, or null. */
function lastMatch(re: RegExp, text: string): RegExpExecArray | null {
  re.lastIndex = 0;
  let found: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found = m;
  return found;
}

/**
 * Read one stdout chunk as a position in the prepare stage, or null when it
 * carries neither line.
 *
 * A book with no sentences at all reports null rather than a 0/0 bar: there is no
 * honest fraction in it, and narrator's own `validate()` refuses that manifest
 * long before this could matter.
 */
export function parseAssemblyPrepare(chunk: string): AssemblyPrepareProgress | null {
  const done = lastMatch(PREPARED_RE, chunk);
  if (done) {
    const total = parseInt(done[1], 10);
    if (total <= 0) return null;
    const seconds = parseFloat(done[2]);
    return {
      done: total,
      total,
      pct: 100,
      message: `Prepared ${total} sentences in ${seconds.toFixed(1)}s`,
      finished: true,
      seconds,
    };
  }

  const at = lastMatch(PREPARING_RE, chunk);
  if (!at) return null;
  const prepared = parseInt(at[1], 10);
  const total = parseInt(at[2], 10);
  if (total <= 0) return null;
  const clamped = Math.max(0, Math.min(prepared, total));
  return {
    done: clamped,
    total,
    pct: (clamped / total) * 100,
    message: `Preparing ${clamped} of ${total} sentences...`,
    finished: false,
  };
}
