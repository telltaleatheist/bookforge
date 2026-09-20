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
// The venue decision's SHAPES only. The modules themselves are imported lazily
// inside `runCoverageAlign`, so `coverageAlignArgs` stays loadable by the argv
// keepers without the routing record, the registry or the network behind it.
import type { VenueHost } from './crucible/generation-venue';
import type { RunVenue, StepVenue } from './crucible/step-venue';
import { describeRunVenue, sameRunVenue } from './crucible/step-venue';

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
  /**
   * THE RUN'S ALREADY-RESOLVED VENUE, when the caller has it — a queue row's
   * `waitForResolved`. The session's own record (`session_state.json`,
   * `settings.crucible.server`, what the render bridge persists) is read here
   * regardless; the two must agree. A later step FOLLOWS its run and decides
   * only when the run has no venue yet — see `venueForRunStep`.
   */
  runVenue?: RunVenue;
  /**
   * THE CALLER'S OWN INSTRUCTION: the NAME of a Crucible server (or `local`),
   * when the caller chose one (the CLI's `--crucible-server`). Must agree with
   * the run's venue when there is one. Absent, and with no run venue, the
   * routing record decides (`decideWhereGenerationRuns`: the legacy switch,
   * then rank) — the same decision, in the same order, that places a render.
   */
  crucible?: { server: string };
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
  /**
   * WHERE the alignment ran and WHY — `origin: 'the run'` when it followed the
   * venue the render already had, `'decided here'` when the run had none.
   * Absent only when the run failed before the decision (no session on disk,
   * no authorship, two venues that disagree).
   */
  venue?: StepVenue;
  /**
   * Present exactly on a Crucible `server_busy`: the SDK's holder line
   * ("GPU busy: foundry, tts 62% done"), so the queue step can HOLD the row
   * on it rather than fail the book (crucible ARCHITECTURE.md §3).
   */
  busyLine?: string;
  /**
   * Present exactly on a Crucible refusal worth WAITING OUT rather than
   * failing the book — an unreachable server, a 5xx (Contract 1 of the
   * 2026-09-20 bug hunt). The pair travels beside `busyLine` and for the same
   * reason: this job ANSWERS rather than throwing, so a step seam that could
   * only read a thrown refusal would lose the wait here and send a book to
   * *Needs you* over a Crucible that was asleep.
   */
  transient?: boolean;
  /** The sentence a parked row shows. Present exactly when `transient`. */
  transientLine?: string;
  /**
   * On a Crucible run: where the model's items landed (`<processDir>/alignment.json`)
   * — present even when `success` is false for the owed narrator door, because
   * the GPU half is done and R6 says partial work survives.
   */
  alignmentPath?: string;
}

/**
 * Test seams for `runCoverageAlign`, and nothing the app passes: the routing
 * record and the network behind the venue decision. A keeper drives every branch
 * with neither a server nor a card.
 */
export interface CoverageAlignDeps {
  venueHost?: VenueHost;
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
/** Live Crucible align jobs, keyed the same way: a cancel DELETEs the job on the server. */
const activeCrucibleAligns = new Map<string, AbortController>();
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

/*
 * ── `coverageAlignPython` AND `coverageAlignRefusal` ARE GONE (2026-09-19) ──
 *
 * They were the PLAN-TIME GATE: "can THIS machine align?", answered by
 * resolving the local `qwen-align` conda env, and asked in two places — in
 * front of the post-render alignment phase (`parallel-tts-bridge`) and in front
 * of the CLI's align door (`cli/coverage-align.js`).
 *
 * Both were asking about the wrong machine, and the bug hunt of 2026-09-19
 * (finding B2) measured what it cost: `runCoverageAlign` dispatches the model
 * to a CRUCIBLE server and then measures the book here in the TOOLS env, which
 * is native on every platform. There is no local qwen interpreter in that path
 * at all. So a Mac — where `align` is off because qwen3-aligner has no
 * mlx-darwin block — shipped an unaligned transcript from a render that had
 * just finished on a machine that would have aligned it perfectly.
 *
 * A gate that refuses work the machine can actually do is worse than no gate:
 * it is a refusal that names the wrong thing. What is left is the refusal the
 * RUN makes, once, from inside `runCoverageAlign` — and every one of those
 * names something a person can repair.
 *
 * `runCoverageAlignLocally`'s own `fromAlignment === undefined` arm still
 * resolves the local env, because that arm IS the local spawn; it is reached by
 * nothing in the app today and is the legacy answer, never a fallback.
 */

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
  } | {
    reportPath: string;
    /**
     * A CRUCIBLE `align` ARTIFACT — the model's items per chunk, already
     * computed on a server's card. Its presence is what makes this the OTHER
     * argv, and the difference is subtraction: `--device`, `--python`,
     * `--workers` and `--backend` are all about loading and running a model,
     * and this run loads none. narrator refuses the first two by name beside
     * `--alignment` rather than ignoring them, so passing them would not be
     * harmless; and the BACKEND is the document's own, because its items are
     * scored under the rules of the model that made them (`backend_for_alignment`,
     * python/narrator/align/run.py). Stating `--backend` here would pin this
     * door to qwen3 the day Crucible's aligner changes, and narrator would
     * refuse the disagreement — correctly, and for a reason nobody on this side
     * intended.
     */
    alignmentPath: string;
  },
): string[] {
  const { reportPath } = spawnInputs;
  if ('alignmentPath' in spawnInputs) {
    return [
      'align',
      '--session-dir', config.processDir,
      '--report', reportPath,
      '--language', config.language,
      '--alignment', spawnInputs.alignmentPath,
      // THE SAME RULER, for the same reason as below: these cues are sealed into
      // the m4b, and a transcript measured at a gap the assembly does not leave
      // drifts by one gap per chapter boundary with nothing to say so.
      '--chapter-gap', String(resolveChapterGap(config.chapterGap)),
    ];
  }
  const { device, alignEnv } = spawnInputs;
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
 *
 * ── WHERE IT RUNS (2026-09-14) ──────────────────────────────────────────────
 *
 * Decided once, here, by the SAME decision that places a render and a Listen
 * (`electron/crucible/generation-venue.ts`: the caller's server, else the
 * legacy switch, else the routing record) — so the machine that measures a
 * book is chosen the way the machine that rendered it was. There is no second
 * switch and no fallback: with the legacy switch off and no server reachable,
 * the run fails naming the server it could not reach.
 *
 * The legacy answer is {@link runCoverageAlignLocally}, the spawn this file has
 * always made. The Crucible answer is {@link runCoverageAlignOnCrucible}: the
 * GPU half travels (`electron/crucible/align.ts`), `alignment.json` lands in the
 * session, and the run then FAILS BY NAME for the narrator door that turns the
 * model's items into `coverage.json` — owed, and named in the message. That is
 * a dated partial, not a fallback; see align.ts's header for the two shapes the
 * door can take and why neither is built tonight.
 *
 * The result carries `venue` either way, so the row and the post-render log
 * say which machine measured the book.
 */
export async function runCoverageAlign(
  stepId: string,
  config: CoverageAlignConfig,
  mainWindow: BrowserWindow | null,
  deps: CoverageAlignDeps = {},
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

  /*
   * THE RUN'S VENUE FIRST, THEN A DECISION — never the other way round.
   *
   * Found live, 2026-09-14: a render sent to `mac` was followed by this step
   * deciding its own venue (top-ranked → `local`) and loading the aligner on
   * the PC's card, which somebody else owned. A later step FOLLOWS its run
   * (PHASE7-LANES.md §4.4, one book = one GPU). Two sources of the run's
   * venue: the session's own record — what the render bridge persisted, and
   * the one the post-render phase (which passes no venue) reaches — and the
   * caller's `runVenue` (a queue row's `waitForResolved`). They must agree.
   */
  let sessionVenue: RunVenue | undefined;
  try {
    sessionVenue = readSessionRunVenue(config.processDir);
  } catch (err) {
    const error = `${err instanceof Error ? err.message : String(err)} The rendered audio is intact.`;
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }
  if (sessionVenue !== undefined && config.runVenue !== undefined && !sameRunVenue(sessionVenue, config.runVenue)) {
    const error = 'crucible_align_venue_disagrees: this alignment\'s row says its run went to '
      + `${describeRunVenue(config.runVenue)}, but the session's own record (session_state.json) says `
      + `${describeRunVenue(sessionVenue)}. One book, one GPU: two answers for one run are refused, not `
      + 'ranked. The rendered audio is intact.';
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }
  const runVenue = sessionVenue ?? config.runVenue;
  const runVenueSource = sessionVenue !== undefined ? 'session_state.json' : 'the queue row';

  const { processVenueHost } = await import('./crucible/generation-venue.js');
  const { venueForRunStep } = await import('./crucible/step-venue.js');
  const host = deps.venueHost ?? processVenueHost();
  let venue: StepVenue;
  try {
    venue = await venueForRunStep({
      ...(runVenue === undefined ? {} : { runVenue, runVenueSource }),
      ...(config.crucible === undefined ? {} : { callerNamed: config.crucible }),
      host,
    });
  } catch (err) {
    // `run_venue_disagrees` / `no_enabled_server` / `no_reachable_server` /
    // `crucible_server_not_named`, in the decision's own words. This job never
    // throws (the post-render phase's contract), so the refusal is a RESULT.
    const code = err instanceof Error && typeof (err as { code?: unknown }).code === 'string'
      ? ` (${(err as unknown as { code: string }).code})` : '';
    const error = `This alignment has nowhere to run${code}: ${err instanceof Error ? err.message : String(err)}`;
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }
  console.log(`[COVERAGE-ALIGN] venue: crucible "${venue.server}" — ${venue.origin}: ${venue.because}`);

  const result = await runCoverageAlignOnCrucible(stepId, config, mainWindow, venue.server);
  return { ...result, venue };
}

/**
 * The venue this session's render was given, out of the session's own record —
 * `<processDir>/session_state.json` → `settings.crucible.server`, which
 * `parallel-tts-bridge.decideAndRememberVenue` writes for every render. Absent
 * file or absent field is "the run has no recorded venue" — a session rendered
 * before venues were recorded, or by the deleted local narrator; a
 * present-but-malformed field is refused by name.
 *
 * This is the source the POST-RENDER phase reaches: it calls `runCoverageAlign`
 * with no venue of its own, and the session is the run.
 */
export function readSessionRunVenue(processDir: string): RunVenue | undefined {
  const file = path.join(processDir, 'session_state.json');
  if (!fs.existsSync(file)) return undefined;
  let state: { settings?: { crucible?: unknown } };
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so this run's venue cannot be read: ${
      err instanceof Error ? err.message : String(err)}`);
  }
  const crucible = state?.settings?.crucible;
  if (crucible === undefined) return undefined;
  const server = (crucible as { server?: unknown })?.server;
  if (typeof server !== 'string' || server.trim() === '') {
    throw new Error(`${file} carries settings.crucible without a server name (${JSON.stringify(crucible)}); `
      + 'the run\'s venue is unreadable and is not guessed.');
  }
  return { where: 'crucible', server: server.trim() };
}

/*
 * `sameRunVenue` and `describeRunVenue` LIVED HERE and are now
 * `electron/crucible/step-venue.ts`'s — the second job that had to compare two
 * records of one venue (the RVC pass, 2026-09-14) would have been a second
 * copy of both, and one of them spelling a refusal differently is exactly the
 * drift R1 is about.
 */

/**
 * THE CRUCIBLE HALF: upload the session's chunk audio, align it on `server`,
 * land `alignment.json`, and then say — by name — that the narrator half is
 * owed. `success` is false because no coverage report was written, which is
 * the one meaning that field has; `alignmentPath` is set because the GPU work
 * is done and on disk (R6).
 *
 * RULING OWED: a row queued for the CPU (`device: 'cpu'` — the user's choice
 * to align beside the assembly, off the card) has no Crucible answer: a
 * Crucible has only the card. Refused by name rather than quietly run on a GPU
 * the operator chose not to take. The post-render phase asks for the GPU and
 * is unaffected.
 */
async function runCoverageAlignOnCrucible(
  stepId: string,
  config: CoverageAlignConfig,
  mainWindow: BrowserWindow | null,
  server: string,
): Promise<CoverageAlignResult> {
  const fail = (error: string, extra: Partial<CoverageAlignResult> = {}): CoverageAlignResult => {
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error, ...extra };
  };
  if (config.device !== 'gpu') {
    return fail(
      `crucible_align_cpu_row: this alignment was queued to run on the CPU beside the assembly, and `
      + `its venue is crucible "${server}", which has only the card. Queue it on the GPU. The `
      + 'rendered audio is intact.',
    );
  }

  const {
    BOOKFORGE_ALIGN_BACKEND, CrucibleAlignRefused,
    runCrucibleAlign, sessionAlignChunks,
  } = await import('./crucible/align.js');
  const { CrucibleJobRefused, CrucibleJobCancelled } = await import('./crucible/job.js');

  let selection: ReturnType<typeof sessionAlignChunks>;
  try {
    selection = sessionAlignChunks(config.processDir);
  } catch (err) {
    return fail(`${err instanceof Error ? err.message : String(err)} The rendered audio is intact.`);
  }
  if (selection.skipped.length > 0) {
    console.log(`[COVERAGE-ALIGN] ${selection.skipped.length} chunk(s) not sent: `
      + selection.skipped.slice(0, 20).map((s) => `${s.index} (${s.reason})`).join(', ')
      + (selection.skipped.length > 20 ? ', …' : ''));
  }
  if (selection.chunks.length === 0) {
    return fail(
      'crucible_align_no_chunks: every chunk of this session is marker-only or has no audio, so there '
      + 'is nothing to align.',
    );
  }

  const controller = new AbortController();
  activeCrucibleAligns.set(stepId, controller);
  const startedAt = Date.now();
  const total = selection.chunks.length;
  sendProgress(mainWindow, stepId, {
    phase: 'preparing', percentage: 0, processed: 0, total,
    message: `Uploading ${total} chunk(s) to crucible "${server}"…`,
  });
  try {
    const outcome = await runCrucibleAlign({
      server,
      processDir: config.processDir,
      language: config.language,
      backend: BOOKFORGE_ALIGN_BACKEND,
      chunks: selection.chunks,
      signal: controller.signal,
      onLog: (line) => console.log(`[COVERAGE-ALIGN] ${line}`),
      onProgress: (p) => {
        if (p.stage === 'warming') {
          sendProgress(mainWindow, stepId, {
            phase: 'preparing', percentage: 0, processed: 0, total,
            message: `Loading the aligner on crucible "${server}"… ${p.message}`,
          });
          return;
        }
        const processed = p.processed ?? Math.round(p.fraction * total);
        sendProgress(mainWindow, stepId, {
          phase: 'aligning',
          percentage: Math.round(p.fraction * 100),
          processed,
          total: p.total ?? total,
          message: `Aligning on crucible "${server}"… (chunk ${processed}/${p.total ?? total})`,
        });
      },
    });
    const minutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
    console.log(`[COVERAGE-ALIGN] crucible "${server}" aligned ${outcome.chunks} chunk(s) in ${minutes} min, `
      + `${outcome.failed.length} failed; items at ${outcome.alignmentPath}`);
    /*
     * AND NOW NARRATOR'S HALF, HERE — `align.ts`'s shape (a), built 2026-09-18.
     *
     * Until that date this returned `narratorDoorOwedMessage`: the items were on
     * disk and nothing could turn them into `coverage.json` and the sentence
     * VTT, so every remote alignment failed at its last step and the book was
     * sealed with an ESTIMATED transcript. That was a dated partial and it is
     * closed; the gap it named was never in Crucible's half, which returns
     * exactly what it always did.
     *
     * The GPU lane is finished and released BEFORE this runs (the `finally`
     * below drops the controller as this call is made, and this pass takes no
     * card at all), so a second book's alignment can have the server while this
     * one measures. What follows is CPU: decode each chunk, map the items onto
     * narrator's own words, derive the scores, cut the cues, write the report.
     */
    activeCrucibleAligns.delete(stepId);
    console.log('[COVERAGE-ALIGN] the server is done; measuring the book here from its items.');
    /*
     * ITS OWN TRY, because its failures are NOT the Crucible job's. Inside the
     * outer catch, a missing tools env came back as "The Crucible alignment did
     * not finish: The tools Python environment is not installed" — which sends
     * the reader to the server that did its half perfectly.
     */
    let measured: CoverageAlignResult;
    try {
      measured = await runCoverageAlignLocally(
        stepId, config, mainWindow, { alignmentPath: outcome.alignmentPath });
    } catch (err) {
      const error = 'The server placed every word, but this machine could not measure the book '
        + `from them: ${err instanceof Error ? err.message : String(err)} The items are kept at `
        + `${outcome.alignmentPath}, so a retry costs no GPU time. The rendered audio is intact.`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      measured = { success: false, error };
    }
    /*
     * THE ITEMS ARE ON DISK EITHER WAY, and the result says so either way. A
     * measurement that fails here has not wasted the card: the GPU half is a
     * file, and a retry reads it rather than aligning the book again. Dropping
     * this on the failure path would make a re-run look like the only option.
     */
    return { ...measured, alignmentPath: outcome.alignmentPath };
  } catch (err) {
    if (err instanceof CrucibleJobCancelled) {
      const error = 'Alignment cancelled';
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      return { success: false, error, wasStopped: true };
    }
    if (err instanceof CrucibleJobRefused) {
      // A refusal READS AS A REFUSAL, and says what it costs: no measurement, so
      // the audiobook carries the proportional sentence transcript exactly as a
      // session with no coverage report always has (`sentence_vtt.proportional_cues`).
      // The Mac is the live case — `align` is off there (qwen3-aligner has no
      // mlx-darwin block), so a Mac-bound run's alignment lands here by name.
      return fail(
        `${err.message} The rendered audio is intact; no coverage report was written, and the `
        + 'audiobook is assembled with the proportional sentence transcript, as it is for any session '
        + 'without one.',
        {
          ...(err.busyLine === undefined ? {} : { busyLine: err.busyLine }),
          /*
           * AND THE TRANSIENT PAIR, THE SAME WAY (Contract 1, 2026-09-20). An
           * unreachable server used to arrive here as a plain fail, so align's
           * opening `GET /v1/info` against a closed socket turned a sleeping
           * Crucible into a red row and stopped assembly — while the identical
           * wait on a BUSY card parked and came back on its own. Forwarded as a
           * pair rather than composed here, because the sentence belongs to the
           * door that saw the socket (`crucible/job.ts crucibleTransientLine`).
           */
          ...(err.transientLine === undefined
            ? {}
            : { transient: true, transientLine: err.transientLine }),
        });
    }
    if (err instanceof CrucibleAlignRefused) {
      return fail(`${err.message} The rendered audio is intact.`);
    }
    return fail(`The Crucible alignment did not finish: ${err instanceof Error ? err.message : String(err)}. `
      + 'The rendered audio is intact.');
  } finally {
    activeCrucibleAligns.delete(stepId);
  }
}

/**
 * THE LOCAL SPAWN — `narrator align --backend qwen3` in this machine's qwen
 * env, exactly as this file has always run it. The legacy answer of
 * {@link runCoverageAlign}; never a fallback.
 */
export async function runCoverageAlignLocally(
  stepId: string,
  config: CoverageAlignConfig,
  mainWindow: BrowserWindow | null,
  /**
   * NARRATOR'S HALF OVER ITEMS A SERVER ALREADY PRODUCED — `electron/crucible/
   * align.ts` shape (a), built 2026-09-18.
   *
   * With it, this is the same door doing the same work with the model's half
   * subtracted: no qwen env to resolve (there is no model to import), no torch
   * device to pick (nothing runs on one), and the parent interpreter is the one
   * it always was — the tools env, which is native on every platform. That is
   * what makes the remote aligner usable from a Mac at all: `align` is off on
   * this machine because qwen3-aligner has no mlx-darwin block, and it never
   * needed to be on to read a document.
   *
   * The spawn, the progress lines, the cancel and the close handling below are
   * shared rather than copied, because two implementations of "run narrator
   * align and report what it said" is how the two arms start disagreeing about
   * what a failure means.
   */
  fromAlignment?: { alignmentPath: string },
): Promise<CoverageAlignResult> {
  const reportPath = coverageReportPath(config.processDir);
  let alignEnv: { python: string; viaWsl?: boolean; wslEnvName?: string } | null = null;
  let device = 'the server that aligned it';

  if (fromAlignment === undefined) {
    // The same refusal the CLI raises at plan time, said again here because a row
    // can outlive the machine state that composed it: a queue restored after the
    // add-on was uninstalled must say WHICH add-on rather than "python not found".
    const resolvedEnv = resolveQwenAlignEnv();
    if (!resolvedEnv.ok) {
      const error = `${resolvedEnv.error} The rendered audio is intact.`;
      sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
      return { success: false, error };
    }
    alignEnv = resolvedEnv.env;

    const resolved = await resolveAlignDevice(config.device);
    if (!resolved.ok) {
      sendProgress(mainWindow, stepId, {
        phase: 'error', percentage: 0, error: resolved.error, message: resolved.error,
      });
      return { success: false, error: resolved.error };
    }
    device = resolved.name;
  } else if (!fs.existsSync(fromAlignment.alignmentPath)) {
    // Said before anything spawns: narrator would refuse it too, but this side
    // knows the path is one IT chose and can say so as a fact about the run.
    const error = `The alignment this measurement reads (${fromAlignment.alignmentPath}) is not on `
      + 'disk, so there are no items to place the words with. The rendered audio is intact.';
    sendProgress(mainWindow, stepId, { phase: 'error', percentage: 0, error, message: error });
    return { success: false, error };
  }

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
  const args = fromAlignment !== undefined
    ? coverageAlignArgs(config, { reportPath, alignmentPath: fromAlignment.alignmentPath })
    : coverageAlignArgs(config, { reportPath, device, alignEnv: alignEnv! });

  const plan = buildNarratorSpawn({
    // No engine: this is a tools-env door. `PHASE_ENGINE.align` is 'refused',
    // so naming one here would be a compile-time-legal, runtime-refused mistake.
    phase: 'align',
    args,
    // WHERE NARRATOR'S OWN HALF RUNS. Native everywhere except the machine whose
    // qwen env lives in WSL: there the interpreter above is a guest path, so the
    // whole spawn crosses and `buildNarratorSpawn` translates every path in the
    // argv. See the header, and `narrator-spawn.ts`'s `wslCondaEnv`.
    //
    // NEITHER APPLIES OVER A PRECOMPUTED ALIGNMENT: there is no qwen interpreter
    // in the argv to cross for, and HF_HOME points at a checkpoint cache nothing
    // is going to read. Passing them anyway would work and would be a lie about
    // what this run does.
    ...(fromAlignment === undefined && alignEnv?.viaWsl
      ? { wslCondaEnv: alignEnv.wslEnvName } : {} as const),
    envExtras: fromAlignment === undefined ? { HF_HOME: hfHome } : {},
    // No cwdHint: narrator reads cwd for nothing, every path in this argv is
    // absolute, and the default (userData) always exists and is always writable.
  });
  console.log('[COVERAGE-ALIGN] →', plan.describe());

  const startedAt = Date.now();
  sendProgress(mainWindow, stepId, {
    phase: 'preparing', percentage: 0,
    message: fromAlignment === undefined
      ? `Loading the aligner (${device})…`
      : 'Measuring the book against the items the server placed…',
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
          message: fromAlignment === undefined
            ? `Aligning ${total} chunk(s) against the book on ${device}…`
            : `Measuring ${total} chunk(s) against the items the server placed…`,
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
  // A Crucible job: the abort sends DELETE /v1/jobs/{id} and the stream runs
  // on to its `cancelled` frame (job.ts). Abandoning it would leave the aligner
  // holding that server's lane for the rest of the book.
  const remote = activeCrucibleAligns.get(stepId);
  if (remote) {
    console.log(`[COVERAGE-ALIGN] Cancelling Crucible alignment ${stepId}`);
    remote.abort();
    return;
  }
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
