/**
 * THE COVERAGE ALIGNMENT, AS ITS OWN QUEUE JOB — the step that produces the
 * report assembly refuses a book without.
 *
 * ── The hole this fills ─────────────────────────────────────────────────────
 *
 * Higgs v3 has no duration guard worth the name — a chunk measured a duration
 * ratio of 0.99 while dropping 22 % of its text — so "nobody checked" and "it is
 * fine" are the same book, and only one of them is honest. This row is what
 * checks. It force-aligns every rendered chunk against the text it was given and
 * writes `coverage.json` beside the session.
 *
 * ── IT REPORTS. IT DOES NOT BLOCK ───────────────────────────────────────────
 *
 * Owen's ruling, 2026-09-05: "there will always be truncations or errors of some
 * sort. thats the nature of tts... assembly will never function, ever, if we
 * expect it to come out the other side flawless." So this row SUCCEEDS whenever
 * the run happened, whatever the chunks said, and carries the counts and the
 * retake list on its card. The assembly behind it runs, reads the same report,
 * and repeats the retake list on the finished book.
 *
 * It fails only when the run could not happen at all — the session is not on
 * disk, the aligner is not installed, the worker died. Then there is no report,
 * assembly says so, and the book is still assembled from what was rendered.
 *
 * ── THE BACKEND IS QWEN3 (Owen, 2026-09-08) ─────────────────────────────────
 *
 * *"good. go ahead and wire it up to alignment so itll be used to align the
 * chunks in app"* … *"for generate-sentences logic and for normal post-render
 * alignment"*. So this door passes `--backend qwen3` and there is no whisperx
 * arm behind it — not as a fallback, not when the qwen env is missing. A machine
 * with no qwen env does not align and is told so by name
 * (`qwen-aligner.qwenAlignRefusal`), because the two backends do not score words
 * on the same scale (`align/aligner.py`, `score_source`) and a book measured by
 * the other instrument under this label would be a silent substitution.
 *
 * WHAT BOUGHT IT, on Shift (Higgs mistborn, 16.56 h, RTX 3090 Ti in WSL), scored
 * against 1,083 known chunk starts: qwen3 395x realtime — 151 s for the whole
 * book — with 890/1083 starts inside 0.1 s once each chunk's own ~0.27 s of head
 * silence is subtracted. WhisperX on the same GPU: 18x, 39/61 inside 0.1 s, and
 * it parks ~0.9 s early in the inter-chunk gap.
 *
 * ── Two environments, one command line ──────────────────────────────────────
 *
 * narrator's half of the alignment (manifest, chunk spans, sentence cues, the
 * report) is stdlib. The ALIGNMENT itself needs torch and `qwen_asr`, which
 * narrator's interpreters do not have and must not grow (the Orpheus envs are
 * pinned to torch 2.5.1 / vLLM 0.7.3), so `narrator align --python <that env>`
 * drives it over `align/worker.py`'s JSON-lines protocol with PYTHONPATH pointed
 * back at this checkout. Nothing is installed and nothing is copied.
 *
 * THE ENV IS RESOLVED BY `qwen-aligner.ts`, not here — one ladder for this door
 * and for the whole-m4b "Generate sentences" door, because a second copy of it is
 * a second answer and the copy is the one that goes stale.
 *
 * ── ON WINDOWS THE WHOLE SPAWN CROSSES INTO THE GUEST ───────────────────────
 *
 * `qwen-asr` wants a CUDA torch env and the PC's is a WSL env, so its interpreter
 * is a `/home/...` path a Windows process cannot execute. When
 * `resolveQwenAlignEnv()` answers `viaWsl`, `buildNarratorSpawn` is given that
 * env's NAME (`wslCondaEnv`) and runs narrator's half inside the guest too, with
 * every path in the argv translated. That is also what lets the POST-RENDER call
 * (`parallel-tts-bridge`, the tail of the TTS step) align a session that is still
 * on ext4 — the guest cannot see the Z: network drive the session is copied to
 * afterwards, which is exactly why the phase runs before the copy.
 *
 * ── THE DEVICE IS THE USER'S CHOICE, MADE WHEN THE ROW WAS QUEUED ───────────
 *
 * Owen, 2026-09-07: "make it an option the user can pick when adding it to the
 * queue. GPU or CPU? defaults to CPU."
 *
 * It was `--device cpu`, always, and the default has not moved. The argument for
 * the default was measured on WhisperX (213.5 s of wall clock for 2,615 s of
 * audio, RTF 0.082, in the second cpu slot beside the assembly) and it is a
 * WEAKER argument for qwen3, which is a GPU model: 395x realtime on this PC's
 * 3090 Ti and 87x on the Mac's MPS, against a CPU rate nobody has measured
 * (float32 there, `align/aligner.py:_load_qwen3`). The default stands because
 * the queue is what it is — a CPU row runs beside the assembly, a GPU row waits
 * for the card — and because moving it is Owen's call with a measurement behind
 * it, not an inference from two GPU numbers. The POST-RENDER phase in
 * `parallel-tts-bridge.ts` asks for the GPU explicitly, and it is entitled to:
 * the TTS step already owns the gpu lane at that moment.
 *
 * 'gpu' IS RESOLVED TO A DEVICE NAME HERE, on the machine that runs the row —
 * `mps` on Apple Silicon, `cuda` where CUDA is present, and a machine with
 * neither refuses BY NAME rather than quietly aligning on the CPU the user did
 * not choose. The queue file is carried between machines; the name is not.
 *
 * The GPU row waits its turn like a render: the queue gives it the single gpu
 * slot through `gpuAdmission` (`queue-steps/align.ts`), and `align/aligner.py`
 * refuses cuda AND mps by name while BookForge's `external-gpu-job.lock` exists.
 */

import { app, BrowserWindow } from 'electron';
import { execSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { publishBridgeEvent } from './bridge-events';
import { buildNarratorSpawn } from './narrator-spawn';
import { qwenAlignCacheDir, resolveQwenAlignEnv } from './qwen-aligner';
import { COVERAGE_REPORT_NAME } from '../shared/queue/coverage-policy';
// The ONE resolver both assembly doors read the gap through — see the config
// field below, and CLAUDE.md §"Three seconds between chapters".
import { resolveChapterGap } from '../shared/audio/chapter-gap';
import { seedSessionAuthorship } from './session-authorship';
// The machine's own capability answer — see `resolveAlignDevice`.
import { systemProbe } from './components/system-probe';

export interface CoverageAlignConfig {
  /**
   * The session's HASH directory — the same string the assembly door passes as
   * `--session_dir`, and the same one `narrator align --session-dir` documents.
   *
   * NOT the `ebook-<uuid>` directory above it. `session_v1.build_manifest` opens
   * `<dir>/session-state.json` directly rather than walking for it, which is the
   * one place in narrator where the two are not interchangeable — the same trap
   * `runAssembly` records at its own `--session_dir`.
   */
  processDir: string;
  /** The language the wav2vec2 checkpoint is loaded for. Never defaulted here. */
  language: string;
  /**
   * WHICH PROCESSOR — the user's answer, carried from the queue row.
   *
   * A NAME FOR A KIND OF DEVICE, not a torch device string: 'gpu' becomes `mps`
   * or `cuda` below, on the machine that actually runs it. Every caller states
   * it; the CLI door states 'cpu', which is what the CLI has always done.
   */
  device: 'cpu' | 'gpu';
  /**
   * The book's authorship, written into the session before the spawn — see
   * session-authorship.ts. `narrator align` builds the session manifest, author
   * included, before it aligns a single chunk, so a session whose EPUB named no
   * `dc:creator` was refused HERE, not at assembly. Optional only for the CLI
   * door, which has no queue row to read it from; the queue always passes it.
   */
  metadata?: { title?: string; author?: string; year?: string };
  /**
   * SECONDS OF SILENCE THE ASSEMBLY OF THIS SESSION WILL LEAVE BETWEEN CHAPTERS.
   *
   * The aligner writes a MEASUREMENT — `<stem>.sentences.vtt`, the transcript
   * assembly seals into the m4b untouched — so it has to be measured on the same
   * ruler the audio is built on. narrator's `align` takes the same gap the
   * assembler takes, and a transcript aligned at one gap and sealed into a book
   * assembled at another drifts by the gap at every chapter boundary.
   *
   * ABSENT IS NOT ZERO. Absent means this caller did not choose, and resolves
   * through `resolveChapterGap` (shared/audio/chapter-gap.ts) to
   * `DEFAULT_CHAPTER_GAP` — the SAME resolver the two assembly doors use, so the
   * transcript and the m4b are measured on one ruler. An explicit 0 is a real
   * answer (the butt-joined book) and is honoured.
   */
  chapterGap?: number;
}

export interface CoverageAlignProgress {
  phase: 'preparing' | 'aligning' | 'complete' | 'error';
  percentage: number;
  /** Chunks aligned so far / total — drives the queue's rate-based ETA. */
  processed?: number;
  total?: number;
  message?: string;
  error?: string;
}

export interface CoverageAlignResult {
  /**
   * TRUE WHEN THE RUN HAPPENED, not when the book was perfect.
   *
   * Owen's ruling, 2026-09-05: "there will always be truncations or errors of
   * some sort. thats the nature of tts... assembly will never function, ever, if
   * we expect it to come out the other side flawless." A pass that measured
   * every chunk and doubted fourteen of them SUCCEEDED — it did exactly what it
   * was queued to do, and its answer is on the row. False is reserved for a run
   * that could not happen: no session, no aligner, a worker that died.
   */
  success: boolean;
  /** The coverage report, on success. */
  reportPath?: string;
  /** Chunks the aligner measured, for the job log. */
  chunksAligned?: number;
  /** Chunks it measured and doubted. */
  chunksFailed?: number;
  /** Chunks it could not place at all. */
  chunksErrored?: number;
  /** Those two together — what `narrator retake --indices` should be given. */
  retakeIndices?: number[];
  error?: string;
  wasStopped?: boolean;
}

/**
 * How many aligner PROCESSES a CPU alignment runs at once (`narrator align
 * --workers`).
 *
 * ONE, UNTIL IT IS MEASURED. The pool exists because of Shift (2026-09-08):
 * 11.4 chunks/min, 115 minutes of CPU for a book whose render took 37 — Owen,
 * "align is taking way too long… 3x slower than the TTS render. we have to find
 * a more efficient way of handling this." But the number that is actually
 * fastest on this machine is a measurement, not arithmetic: the aligner shares
 * the box with the assembly encode, torch's own intra-op threads already spread
 * one chunk over the cores, and the pool divides those threads between workers.
 * That measurement is Owen's, on a free CPU, and HE sets this number when it is
 * in. Until then the app spawns exactly what it has always spawned.
 *
 * The qwen3 cutover of 2026-09-08 mostly retires the problem this constant was
 * written for — the whole Shift book aligned in 151 s on the GPU — but it does
 * not retire the constant: a CPU row still exists and still has not been swept.
 */
const ALIGN_CPU_WORKERS = 1;

/** Live align children, keyed by step id, so a queue cancel can reach them. */
const activeAligns = new Map<string, ChildProcess>();
/** Step ids whose child was killed by a user stop, so the exit reads as one. */
const stoppedSteps = new Set<string>();

/**
 * Where the report for this session goes — `<processDir>/coverage.json`.
 *
 * ONE FUNCTION FOR FOUR CALLERS. The align step writes it, and both assembly
 * spawns pass it as `--coverage_report`; `coverage_gate.default_report_path`
 * looks for the same name beside the same directory when nobody names one. A
 * path spelled separately in any of those reads to the operator as "align never
 * ran", which is the one failure that looks exactly like the bug this whole step
 * was written to remove.
 */
export function coverageReportPath(processDir: string): string {
  return path.join(processDir, COVERAGE_REPORT_NAME);
}

/** What a coverage report says, in the shape a queue row can show. */
export interface CoverageSummary {
  /** Chunks the aligner measured. */
  chunksAligned: number;
  /** Chunks it measured and doubted — the audio did not say the text. */
  chunksFailed: number;
  /** Chunks it could not place at all. */
  chunksErrored: number;
  /** Both of those, sorted and de-duplicated: the retake list. */
  retakeIndices: number[];
  /** One line for the card and the log. */
  line: string;
}

/**
 * How many indices the one-line summary spells before it stops counting.
 *
 * A 1,400-chunk book can put hundreds of indices on this list, and a queue card
 * is one line high. The REPORT holds all of them; this says how many and where
 * to look.
 */
const RETAKE_INDICES_IN_LINE = 40;

/**
 * Read a coverage report and say what it found — or null when there is none.
 *
 * NOT A GATE, AND NOT A GUESS. `python/narrator/assemble/coverage_gate.py` owns
 * the refusals (a report about another book) and the full read-out; this is the
 * one line the Align row and the assembly row put on the card so an operator
 * sees the retake list without opening a JSON file.
 *
 * Returns null when the file is absent — which is a normal state, not an error:
 * an Orpheus book carries no Align row. An unreadable one is logged by name and
 * also returns null: this function's job is to SAY something, and saying nothing
 * about a broken file is better than inventing counts from it.
 */
export function summarizeCoverageReport(reportPath: string): CoverageSummary | null {
  if (!fs.existsSync(reportPath)) return null;
  let document: {
    summary?: { chunksAligned?: number };
    chunks?: { index?: number; failed?: boolean }[];
    errors?: { index?: number }[];
  };
  try {
    document = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  } catch (err) {
    console.log(`[COVERAGE-ALIGN] ${reportPath} could not be read: ${(err as Error).message}`);
    return null;
  }
  // Counted from the ARRAYS, not from the summary's own totals: the arrays are
  // what carry the indices this line exists to print, and a document whose
  // counts disagreed with its own arrays would print a count for one set and
  // the indices of another.
  const failed = (document.chunks ?? [])
    .filter((c) => c.failed === true)
    .map((c) => c.index)
    .filter((i): i is number => typeof i === 'number');
  const errored = (document.errors ?? [])
    .map((e) => e.index)
    .filter((i): i is number => typeof i === 'number');
  const retakeIndices = [...new Set([...failed, ...errored])].sort((a, b) => a - b);
  const chunksAligned = typeof document.summary?.chunksAligned === 'number'
    ? document.summary.chunksAligned : 0;

  const shown = retakeIndices.slice(0, RETAKE_INDICES_IN_LINE).join(',');
  const more = retakeIndices.length > RETAKE_INDICES_IN_LINE
    ? `,… (+${retakeIndices.length - RETAKE_INDICES_IN_LINE} more)` : '';
  const line = `${chunksAligned} aligned, ${failed.length} failed coverage, `
    + `${errored.length} could not be placed`
    + (retakeIndices.length > 0 ? ` — retake: ${shown}${more}` : '');

  return {
    chunksAligned,
    chunksFailed: failed.length,
    chunksErrored: errored.length,
    retakeIndices,
    line,
  };
}

function sendProgress(
  win: BrowserWindow | null, stepId: string, progress: CoverageAlignProgress,
): void {
  publishBridgeEvent('coverage-align:progress', { jobId: stepId, progress });
  if (!win || win.isDestroyed()) return;
  win.webContents.send('coverage-align:progress', { jobId: stepId, progress });
}

/**
 * The interpreter that can align, or null.
 *
 * Exported because the plan-time check asks the same question — the CLI refuses a
 * run whose aligner is missing BEFORE it starts, which is the only point at which
 * the answer is still cheap.
 *
 * ON WINDOWS THIS IS A GUEST PATH (`/home/.../envs/qwen-align/bin/python`) and
 * nothing on the Windows side may execute it or stat it. It is what goes on
 * `narrator align --python` inside the guest, and `runCoverageAlign` is what
 * knows which arm it is on. A caller that only wants "can this machine align"
 * should read the null-ness, not the string.
 */
export function coverageAlignPython(): string | null {
  const resolved = resolveQwenAlignEnv();
  return resolved.ok ? resolved.env.python : null;
}

/**
 * WHY this machine cannot align, or null when it can.
 *
 * The refusal text is `qwen-aligner`'s, exported through here so the CLI's
 * plan-time check and this job say the SAME sentence. The app states this
 * refusal twice on purpose — once when a row is composed, once when it runs,
 * because a row outlives the machine state that composed it — and two different
 * wordings for one fact is how an operator ends up looking for two problems.
 */
export function coverageAlignRefusal(): string | null {
  const resolved = resolveQwenAlignEnv();
  return resolved.ok ? null : resolved.error;
}

/**
 * THE TORCH DEVICE THIS MACHINE CAN GIVE THE ALIGNER, for a row that asked for
 * the GPU — or a refusal naming what is missing.
 *
 * ONE DETECTOR, NOT A SECOND ONE. `systemProbe.profile()` is the same probe the
 * add-on catalog evaluates compatibility against and the same one the renderer
 * draws its Add-ons panel from (`appleSilicon`, `cuda.available`), cached after
 * the first call. Asking torch here — importing it in a subprocess to see what
 * it can see — would be a second answer to a question this app already answers,
 * and the two would disagree the day one of them is fixed.
 *
 * NO SILENT DOWNGRADE. A machine with neither card refuses by name: the operator
 * chose the GPU, the row waited for the single GPU slot to get it, and quietly
 * aligning on the CPU instead would spend that wait for nothing and report
 * success.
 */
async function resolveAlignDevice(
  device: 'cpu' | 'gpu',
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (device !== 'gpu') return { ok: true, name: 'cpu' };
  const profile = await systemProbe.profile();
  // Apple Silicon first: on a Mac that reports both (it cannot today), Metal is
  // the card that is actually there.
  if (profile.appleSilicon) return { ok: true, name: 'mps' };
  if (profile.cuda.available) return { ok: true, name: 'cuda' };
  return {
    ok: false,
    error:
      'This alignment was queued to run on the GPU, and this machine has no GPU the aligner can '
      + 'use — no CUDA card and no Apple Silicon. Queue it on CPU instead: the aligner is '
      + 'seconds a chunk there, and it runs beside the assembly rather than waiting for a card.',
  };
}

/**
 * THE ALIGN COMMAND LINE, AS A VALUE.
 *
 * Split out of `runCoverageAlign` so the argv can be READ without spawning an
 * aligner, a GPU or an Electron app — `tools/test-chapter-gap.js` asserts the
 * chapter gap on it, and `tools/narrator-argv-extract.js` pins the whole literal.
 * Nothing else changed when it moved: the array below is the array that was
 * inside the spawn, and `runCoverageAlign` is its only caller in the app.
 */
export function coverageAlignArgs(
  config: CoverageAlignConfig,
  spawnInputs: {
    /** Where the report goes — always `coverageReportPath(config.processDir)`. */
    reportPath: string;
    /** The RESOLVED torch device name: 'cpu', 'mps' or 'cuda'. */
    device: string;
    /** The aligner env, for its interpreter. See `resolveQwenAlignEnv`. */
    alignEnv: { python: string };
  },
): string[] {
  const { reportPath, device, alignEnv } = spawnInputs;
  // ONE RESOLVER, THE ASSEMBLY'S. Absent is the house default, not zero; a
  // nonsense gap is refused by name here rather than measured.
  const chapterGap = resolveChapterGap(config.chapterGap);
  const args = [
    'align',
    '--session-dir', config.processDir,
    '--report', reportPath,
    '--language', config.language,
    // QWEN3, ALWAYS, AND NEVER RESOLVED AT RUNTIME. narrator's own
    // DEFAULT_BACKEND is still whisperx (an unchanged default is its contract);
    // the APP's door is qwen3 by Owen's ruling of 2026-09-08, so it says so.
    '--backend', 'qwen3',
    // The resolved device NAME. Stated rather than left to the CLI's own
    // default so a reader of the job log can see which processor measured the
    // book without going to look up what narrator defaults to.
    '--device', device,
    // The qwen-align interpreter. Absent, narrator refuses BY NAME rather than
    // picking one, which is the behaviour we want everywhere else and the one
    // thing this door must not leave to chance. It is passed EVEN WHEN the
    // narrator parent is already running in that env (the WSL arm): the model
    // then lives in a child process on both platforms, so `align/env.run_jobs`'s
    // named worker refusals are the same failure on both, and the argv is one
    // argv rather than two.
    '--python', alignEnv.python,
    // THE POOL IS A CPU THING. A GPU row holds the single GPU slot for one
    // model on one card, and N processes there would fight over the same
    // memory rather than over spare cores — so it says 1 out loud rather than
    // leaning on the CLI default.
    '--workers', String(device === 'cpu' ? ALIGN_CPU_WORKERS : 1),
    /*
     * THE ASSEMBLY'S CHAPTER GAP, ON THE ALIGNER'S COMMAND LINE.
     *
     * CLAUDE.md §"Three seconds between chapters": *"`narrator align` takes the
     * SAME `--chapter-gap` and must be given the same value — it writes a
     * measurement and assembly never rewrites one."* This door did not, from the
     * gap's first day (efe021a2, 2026-09-09) until 2026-09-11, and every book
     * assembled in between carries a sentence transcript that drifts by the gap
     * at every chapter boundary — the Pokemon book's cues ran 45 s short over 15
     * boundaries, and nothing said so, because assembly seals a measured
     * transcript exactly as it finds it.
     *
     * narrator spells it `--chapter-gap` on the `align` subcommand and
     * `--chapter_gap` on the assembly compat door. Two spellings, one number.
     * Unconditional, like the assembly doors': an explicit 0 is a real answer
     * and a truthiness spread would eat it.
     */
    '--chapter-gap', String(chapterGap),
  ];
  return args;
}

/**
 * Run the coverage alignment for one session. Progress flows out-of-band via
 * 'coverage-align:progress', as the denoise and reassembly jobs do.
 */
export async function runCoverageAlign(
  stepId: string,
  config: CoverageAlignConfig,
  mainWindow: BrowserWindow | null,
): Promise<CoverageAlignResult> {
  if (!fs.existsSync(config.processDir)) {
    const error = `The session this alignment was queued for is not on disk (${config.processDir}).`;
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

  if (config.metadata) {
    try {
      const seeded = seedSessionAuthorship(config.processDir, config.metadata);
      if (seeded) console.log('[COVERAGE-ALIGN] Seeded session authorship:', seeded);
    } catch (err) {
      const error = `Could not write the book's authorship into the session before aligning: ${
        err instanceof Error ? err.message : String(err)}`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      return { success: false, error };
    }
  }
  // The same refusal the CLI raises at plan time, said again here because a row
  // can outlive the machine state that composed it: a queue restored after the
  // add-on was uninstalled must say WHICH add-on rather than "python not found".
  const resolvedEnv = resolveQwenAlignEnv();
  if (!resolvedEnv.ok) {
    const error = `${resolvedEnv.error} The rendered audio is intact.`;
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }
  const alignEnv = resolvedEnv.env;

  const resolved = await resolveAlignDevice(config.device);
  if (!resolved.ok) {
    sendProgress(mainWindow, stepId, {
      phase: 'error', percentage: 0, error: resolved.error, message: resolved.error,
    });
    return { success: false, error: resolved.error };
  }
  const device = resolved.name;

  const reportPath = coverageReportPath(config.processDir);

  /*
   * BookForge's managed Hugging Face cache, so the ~1.2 GB
   * Qwen3-ForcedAligner-0.6B checkpoint is fetched once for the whole app rather
   * than once per user cache. `components/qwen-align-env.ts` DECLARES the
   * variable and sets nothing; the doors are where it is set, and it is created
   * here rather than assumed because a cache directory that does not exist is a
   * download into somewhere else.
   */
  const hfHome = qwenAlignCacheDir(app.getPath('userData'));
  fs.mkdirSync(hfHome, { recursive: true });

  /*
   * THE RULER, RESOLVED AND SAID OUT LOUD BEFORE ANYTHING SPAWNS.
   *
   * Resolved HERE as well as inside `coverageAlignArgs` (the resolver is pure, so
   * both calls are the same number) for two reasons: the log line names which
   * gap this transcript is being measured for — the fact this door was missing
   * until 2026-09-11 — and a nonsense gap is refused as a RESULT rather than as a
   * throw. `runPostRenderAlignment` states that this job never throws, and an
   * exception out of here would fail a render whose audio is intact.
   */
  let chapterGap: number;
  try {
    chapterGap = resolveChapterGap(config.chapterGap);
  } catch (err) {
    const error = `This alignment was queued with a chapter gap the assembler cannot realize, so `
      + `the transcript could not be measured for it: ${
        err instanceof Error ? err.message : String(err)}`;
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }
  console.log(
    `[COVERAGE-ALIGN] chapter gap ${chapterGap}s (${
      config.chapterGap === undefined ? 'the house default — this caller stated none' : 'stated'
    }) — the transcript is measured for an assembly at that gap.`,
  );
  const args = coverageAlignArgs(config, { reportPath, device, alignEnv });

  const plan = buildNarratorSpawn({
    // No engine: this is a tools-env door. `PHASE_ENGINE.align` is 'refused',
    // so naming one here would be a compile-time-legal, runtime-refused mistake.
    phase: 'align',
    args,
    // WHERE NARRATOR'S OWN HALF RUNS. Native everywhere except the machine whose
    // qwen env lives in WSL: there the interpreter above is a guest path, so the
    // whole spawn crosses and `buildNarratorSpawn` translates every path in the
    // argv. See the header, and `narrator-spawn.ts`'s `wslCondaEnv`.
    ...(alignEnv.viaWsl ? { wslCondaEnv: alignEnv.wslEnvName } : {} as const),
    envExtras: { HF_HOME: hfHome },
    // No cwdHint: narrator reads cwd for nothing, every path in this argv is
    // absolute, and the default (userData) always exists and is always writable.
  });
  console.log('[COVERAGE-ALIGN] →', plan.describe());

  const startedAt = Date.now();
  sendProgress(mainWindow, stepId, {
    phase: 'preparing', percentage: 0, message: `Loading the aligner (${device})…`,
  });

  return new Promise<CoverageAlignResult>((resolve) => {
    const child = spawn(plan.command, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      shell: false,
      windowsHide: true,
    });
    activeAligns.set(stepId, child);

    let total = 0;
    let aligned = 0;
    let tail = '';

    /*
     * WHAT THE ROW SHOWS, read out of the aligner's own two lines.
     *
     *   [align] 133 chunk(s) to align, 4 marker-only chunk(s) skipped; …
     *   [align] aligned 40/133 chunk(s)
     *
     * The second is a stated contract on narrator's side (`align/run.py`'s
     * `_progress_reporter`), not an incidental log line, because a bar wired to
     * an incidental log line stops the day somebody rewords it.
     */
    const TOTAL_RE = /\[align\] (\d+) chunk\(s\) to align/;
    const DONE_RE = /\[align\] aligned (\d+)\/(\d+) chunk\(s\)/;

    const readLine = (line: string): void => {
      const trimmed = line.trim();
      if (trimmed === '') return;
      console.log(`[COVERAGE-ALIGN] ${trimmed}`);
      const totalHit = TOTAL_RE.exec(trimmed);
      if (totalHit) {
        total = Number(totalHit[1]);
        sendProgress(mainWindow, stepId, {
          phase: 'aligning', percentage: 0, processed: 0, total,
          message: `Aligning ${total} chunk(s) against the book on ${device}…`,
        });
        return;
      }
      const doneHit = DONE_RE.exec(trimmed);
      if (doneHit) {
        aligned = Number(doneHit[1]);
        total = Number(doneHit[2]);
        sendProgress(mainWindow, stepId, {
          phase: 'aligning',
          percentage: total > 0 ? Math.round((aligned / total) * 100) : 0,
          processed: aligned,
          total,
          message: `Aligning… (chunk ${aligned}/${total})`,
        });
      }
    };

    let stdoutBuf = '';
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      // Kept for the failure message: narrator prints its refusals on stdout
      // (`Error: <message>`), the same asymmetry the assembly doors record.
      tail = (tail + text).slice(-4000);
      stdoutBuf += text;
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) readLine(line);
    });

    let stderr = '';
    child.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      activeAligns.delete(stepId);
      stoppedSteps.delete(stepId);
      const error = `The aligner could not be started: ${err.message}`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      resolve({ success: false, error });
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim() !== '') readLine(stdoutBuf);
      activeAligns.delete(stepId);
      const wasStopped = stoppedSteps.delete(stepId);

      if (wasStopped) {
        const error = 'Alignment cancelled';
        sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
        resolve({ success: false, error, wasStopped: true });
        return;
      }

      if (code === 0 && fs.existsSync(reportPath)) {
        /*
         * THE ROW REPORTS; IT DOES NOT FAIL. `narrator align` now audits the
         * whole book and exits 0 whatever the chunks said, so the counts and the
         * retake list are what this row has to carry — on the card, so an
         * operator sees them without opening a JSON file, and in the result, so
         * the step can put them in its artifact detail.
         */
        const found = summarizeCoverageReport(reportPath);
        // WHICH PROCESSOR, AND HOW LONG — the two facts an operator deciding
        // where to queue the NEXT one needs, and the reason the choice exists.
        const ran = `on ${device} in ${Math.max(1, Math.round((Date.now() - startedAt) / 60000))} min`;
        const message = found
          ? `Alignment complete ${ran} — ${found.line}`
          : `Alignment complete ${ran} — ${aligned} chunk(s) checked.`;
        console.log(`[COVERAGE-ALIGN] ${message}`);
        sendProgress(mainWindow, stepId, {
          phase: 'complete', percentage: 100, processed: aligned, total, message,
        });
        resolve({
          success: true,
          reportPath,
          chunksAligned: found ? found.chunksAligned : aligned,
          chunksFailed: found?.chunksFailed,
          chunksErrored: found?.chunksErrored,
          retakeIndices: found?.retakeIndices,
        });
        return;
      }

      /*
       * A NON-ZERO EXIT IS NOW ONE THING: THE RUN DID NOT HAPPEN.
       *
       * It used to be two — a chunk that would not align (the pass stopped and
       * wrote nothing) and a book that aligned but failed coverage (the report
       * WAS written, and the row failed on it anyway, which is what made a
       * 50-chunk book with 14 doubtful chunks unassemblable). Neither is an exit
       * code any more: both are audited, reported and exit 0. What is left here
       * is a session that is not on disk, an interpreter that cannot import the
       * backend, or a worker that died — and none of those has a report.
       */
      // BOTH streams. The stdout tail alone won here on 2026-09-05 and the
      // card showed six [ASSEMBLE] lines and no traceback; the traceback was
      // on stderr, dropped by the `||`.
      const detail = ([tail.trim(), stderr.trim()].filter((s) => s !== '').join('\n')
        || `exit ${code}`).slice(-1600);
      const error = `The forced alignment did not finish, so no coverage report was written. `
        + `The rendered audio is intact and can still be assembled — what is missing is the `
        + `measurement of it.\n${detail}`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      resolve({ success: false, error });
    });
  });
}

/**
 * Stop an in-flight alignment, whole tree.
 *
 * The tree matters: `narrator align --python` spawns the whisperx interpreter as
 * a CHILD, and signalling only the parent leaves that one holding the model —
 * the same orphan `cancelEpubAlign` was written for after two align trees
 * survived a queue cancel and had to be taskkill'd by hand.
 */
export function stopCoverageAlign(stepId: string): void {
  const child = activeAligns.get(stepId);
  if (!child) return;
  stoppedSteps.add(stepId);
  const pid = child.pid;
  console.log(`[COVERAGE-ALIGN] Stopping alignment ${stepId} (pid ${pid ?? 'none'})`);
  try {
    if (pid && process.platform === 'win32') {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
    } else if (pid) {
      try { process.kill(-pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Already exited — the close handler clears the registry and reports it.
  }
}
