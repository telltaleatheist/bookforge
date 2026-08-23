import { Injectable, computed, inject } from '@angular/core';

import { typeLabel } from '@shared/documents';
import { fold } from '@shared/original';
import { JOB_RESOURCE, LANES, SLOTS, laneOf, type JobResource, type Lane } from '@shared/queue-board';
import type { Job } from '@shared/types';

import { OpenDocumentsService } from './documents.service';
import { NoticeService } from './notice.service';
import { ProjectsService } from './projects.service';
import { QueueService } from './queue.service';
import { api } from './foundry';

/**
 * THE QUEUE AS IT IS DRAWN — one description of the board, read by both surfaces
 * that draw it.
 *
 * ── Why this file exists at all ─────────────────────────────────────────────
 *
 * Every sentence in here used to be a protected method on the queue shelf, which
 * was fine while the shelf was the only place a job was ever shown. Owen asked
 * for two places (his ruling is quoted in full at the head of the queue bar):
 * a dropdown you click open from the top-right corner, and a whole page behind a
 * *More info* button. Two surfaces onto one queue is exactly the arrangement
 * BookForge landed on — its tray and its queue page both read one service, and
 * its own note about that is the argument for this one: *"Both read
 * `shared/queue/bench.ts` now, so there is one description of the queue and one
 * set of words for it."* Before that they *"spoke different dialects"*.
 *
 * So the shelf's own answers moved here rather than being copied into two
 * components. Copying them would have been a drift machine with a two-week fuse:
 * the day somebody fixes the failure sentence, or teaches `made()` a new kind, or
 * changes which lane the aggregate bar follows, they fix it in the surface they
 * happened to have open and the other one goes on saying the old thing. A queue
 * that says two different things about one job in two places is worse than
 * either sentence alone, because now the user has to work out which to believe.
 *
 * ── WHAT IT IS NOT ──────────────────────────────────────────────────────────
 *
 * It is not a second queue. `QueueService` is the mirror of main's list and this
 * reads it; nothing here writes a job, guesses a state, or holds anything of its
 * own between renders. Every computed below is a pure function of
 * `queue.jobs()`, and the three methods that DO something (`open`, `reveal`,
 * `saveCopy`) are the same one-line hand-offs the shelf made — they are here
 * because they belong to a row, and a row is drawn in two places now.
 *
 * It is also not a scheduler. The lanes, the slot counts and the resource of
 * each kind are `shared/queue-board.ts` — the same table `electron/job-queue.ts`
 * rations by — read and never second-guessed, so the lane a row is DRAWN in
 * cannot disagree with the lane the pump holds it against.
 */
@Injectable({ providedIn: 'root' })
export class QueueViewService {
  private readonly queue = inject(QueueService);
  private readonly documents = inject(OpenDocumentsService);
  private readonly notices = inject(NoticeService);
  /** Only ever asked what a book is called, and what it filed. See `label`. */
  private readonly projects = inject(ProjectsService);

  /**
   * WHAT THE CHIP MEASURES — the GPU lane's run, or the first one going.
   *
   * The bar has room for one fraction and the machine can be running three
   * jobs, so the choice has to be made somewhere and this is where. The GPU
   * lane wins because it is the lane that costs hours: a person glancing at the
   * corner is asking how the reading is getting on, and a bar that tracked a
   * thirty-second compile would answer a question nobody asked and then jump
   * back. Null when nothing is running at all, which is what draws the ✓ or the
   * ! in the chip.
   */
  readonly leading = computed(() => {
    const active = this.queue.runningJobs();
    return active.find((job) => laneOf(job.kind) === 'gpu') ?? active[0] ?? null;
  });

  /**
   * The chip's one line: what is running, and how many are waiting behind it.
   *
   * "3 QUEUED" IS STILL A WAIT AND NOT A PARALLELISM, but it is no longer a
   * wait behind ONE job — the board runs up to three at once (one GPU, two
   * CPU), so the count of other live runs is said out loud rather than left for
   * somebody to discover by opening the panel. The lead run names itself; the
   * rest are a number, because three book titles in a chip is three ellipses.
   */
  readonly headline = computed(() => {
    const active = this.leading();
    const alsoRunning = this.queue.runningJobs().length - 1;
    const waiting = this.queue.queued().length;
    const held = this.queue.held().length;
    if (active) {
      const name = this.label(active);
      const behind = [
        alsoRunning > 0 ? `${alsoRunning} more running` : null,
        waiting > 0 ? `${waiting} queued` : null,
        held > 0 ? `${held} held` : null,
      ].filter((part) => part !== null);
      return behind.length > 0 ? `${name} · ${behind.join(', ')}` : name;
    }
    /*
     * A HELD BATCH IS THE HEADLINE WHEN NOTHING IS RUNNING, and it outranks the
     * finished count deliberately: the chip is the queue's whole face most of
     * the time, and one reading "3 finished" over three jobs that are sitting
     * there waiting to be started is the one state where the summary would
     * actively mislead — it says the work is done when none of it has begun.
     */
    if (held > 0) return `${held} waiting for Start`;
    const failed = this.queue.failed().length;
    if (failed > 0) return `${failed} failed`;
    const done = this.queue.finished().length;
    /*
     * AND AN EMPTY QUEUE SAYS ITS OWN NAME. The shelf never had to answer this
     * — it was not drawn at all with no jobs — and the chip is always there, so
     * "0 finished" would be the corner of the window reporting a number about
     * nothing. BookForge's own empty chip says "Queue", for the same reason.
     */
    if (done === 0) return 'Queue';
    return `${done} finished`;
  });

  /**
   * THE BOARD AS THE PANEL DRAWS IT — the lanes, in order, each with its rows.
   *
   * ── The one rule that decides whether there are heads at all ────────────────
   *
   * While every row in the queue wants the same resource, this returns ONE
   * section with no head and the whole list in it, and the panel is exactly the
   * list the shelf always was. That is the common case by a mile: a batch of
   * readings, or one export. Heads appear the moment the board holds work of two
   * kinds — and then BOTH lanes draw even if one of them is empty, because at
   * that point the interesting fact is as often what is free as what is busy.
   * An empty lane is a head and one grey line, which is cheap; two heads over
   * one lonely job would not be.
   *
   * ── The two sections that are not lanes ─────────────────────────────────────
   *
   * An install holds every slot and a mint holds none (shared/queue-board.ts),
   * so neither has an occupancy to report and neither draws when it has no rows.
   * They are named for what they DO to the board rather than by what they are,
   * because that is the fact a person reading a queue needs: one of them is why
   * nothing else is moving, and the other is why something is moving that no
   * lane accounts for.
   *
   * ORDER WITHIN A LANE IS QUEUE ORDER, untouched. Grouping is not sorting: the
   * panel shows the order somebody added things in, Start releases in that
   * order, and the pump takes them in that order.
   */
  readonly board = computed<BoardSection[]>(() => {
    const rows = this.queue.jobs();
    const grouped = new Map<JobResource, Job[]>();
    for (const job of rows) {
      const resource = JOB_RESOURCE[job.kind];
      const held = grouped.get(resource);
      if (held === undefined) grouped.set(resource, [job]);
      else held.push(job);
    }
    if (grouped.size <= 1) return [{ key: 'all', head: null, slots: '', hint: '', rows }];

    const sections: BoardSection[] = [];
    for (const lane of LANES) {
      sections.push({
        key: lane,
        head: lane === 'gpu' ? 'GPU' : 'CPU',
        slots: this.occupancy(lane),
        hint: LANE_HINT[lane],
        rows: grouped.get(lane) ?? [],
      });
    }
    for (const resource of OFF_LANE) {
      const held = grouped.get(resource);
      if (held === undefined || held.length === 0) continue;
      sections.push({
        key: resource,
        head: resource === 'exclusive' ? 'The whole machine' : 'Beside the lanes',
        slots: '',
        hint: LANE_HINT[resource],
        rows: held,
      });
    }
    return sections;
  });

  /**
   * THE BENCH — one card per SLOT, occupied or free, always all three.
   *
   * ── Why the page counts slots where the panel groups rows ───────────────────
   *
   * They are two readings of one table and the difference is room. The dropdown
   * is a list with lane rules across it, which is what fits in a panel you have
   * clicked open for a glance. The page has the width to draw the thing the
   * board actually IS: three slots, and what is standing in each. That is
   * BookForge's own centre of gravity on its queue page — *"the THREE SLOTS,
   * always all three, occupied or free… allocating one GPU slot and two CPU
   * slots is the entire job of the scheduler, and until this redesign no surface
   * drew them"* — and the sentence is true here for exactly the same reason.
   *
   * ── AND IT INVENTS NOTHING ABOUT WHICH SLOT IS WHICH ────────────────────────
   *
   * The scheduler does not tell this window which of the two CPU slots a job
   * landed in, and this does not pretend to know: the running rows of a lane are
   * dealt into that lane's slots IN QUEUE ORDER, and the fact being drawn is the
   * one main really does guarantee — that at most `SLOTS[lane]` of them run at
   * once. So "CPU · slot 2 of 2" means "the second of the two CPU runs", which
   * is the honest reading, and a slot that is empty is a slot that is genuinely
   * free. Nothing about the scheduler is asked to change to draw this; the
   * board's own table is the whole of the arithmetic.
   */
  readonly slots = computed<SlotView[]>(() => {
    const out: SlotView[] = [];
    for (const lane of LANES) {
      const busy = this.queue.runningJobs().filter((job) => laneOf(job.kind) === lane);
      const total = SLOTS[lane];
      for (let index = 0; index < total; index += 1) {
        out.push({
          key: `${lane}-${index}`,
          lane,
          index: index + 1,
          of: total,
          hint: LANE_HINT[lane],
          occupant: busy[index] ?? null,
        });
      }
    }
    return out;
  });

  /** How many of the counted slots have somebody in them — the bench's heading. */
  readonly busySlots = computed(() => this.slots().filter((slot) => slot.occupant !== null).length);

  /**
   * WHAT IS WAITING, GROUPED BY THE BOOK IT IS ABOUT — the page's *Up next*.
   *
   * BookForge groups its waiting steps by book and draws each book's chain, and
   * the grouping is worth reproducing for the reason it works there: a person
   * assembling a batch adds work a BOOK at a time, so a flat list of eleven rows
   * is eleven readings of the same four titles, and the question being asked of
   * the screen ("what have I actually lined up?") is answered by the titles.
   *
   * THERE IS NO PER-BOOK START AND THIS DOES NOT DRAW ONE. BookForge's group
   * header carries *"▶ Start this book"* because its engine can release one
   * plan; Foundry's Start releases THE WHOLE HELD BATCH (`queue.start()`, and
   * main's `start` is the same one gesture), so a button under a title promising
   * to start that title would start four other books as well. The one Start
   * there is stays where it has always been — one control, with the count of
   * what it commits — and this grouping is presentation only. Naming the gap
   * rather than papering it with a button that lies.
   *
   * Groups come out in first-appearance order, and rows within a group in queue
   * order, because that is the order Start will release them in.
   */
  readonly waitingBooks = computed<BookGroup[]>(() => {
    const groups: BookGroup[] = [];
    const byName = new Map<string, BookGroup>();
    for (const job of this.queue.jobs()) {
      if (job.state !== 'held' && job.state !== 'queued') continue;
      const name = this.label(job);
      let group = byName.get(name);
      if (group === undefined) {
        group = { key: name, title: name, rows: [] };
        byName.set(name, group);
        groups.push(group);
      }
      group.rows.push(job);
    }
    return groups;
  });

  /** "1 of 1 running", or what is free — the right-hand side of a lane head. */
  occupancy(lane: Lane): string {
    const busy = this.queue.runningJobs().filter((job) => laneOf(job.kind) === lane).length;
    const total = SLOTS[lane];
    if (busy > 0) return `${busy} of ${total} running`;
    return total === 1 ? '1 slot free' : `${total} slots free`;
  }

  /** What the Start button says to a screen reader, and on hover. */
  readonly startLabel = computed(() => {
    const held = this.queue.held().length;
    if (held === 0) return 'Nothing is waiting to start';
    return held === 1 ? 'Start the 1 job waiting' : `Start the ${held} jobs waiting`;
  });

  /** True when the bar has a real fraction behind it. */
  determinate(job: Job): boolean {
    if (job.kind === 'env-install') return job.envProgress?.phase === 'download';
    return (job.progress?.total ?? 0) > 0;
  }

  percent(job: Job): number {
    if (job.kind === 'env-install') return job.envProgress?.percent ?? 0;
    const p = job.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(100, Math.round((p.page / p.total) * 100));
  }

  /**
   * HOW FAR — the count, and nothing else on the line.
   *
   * It used to carry the engine's last sentence too, appended after a dot and
   * cut at eighty characters, because the row had one line to say everything in.
   * The step is what Owen asked to be able to see, so it moved to a line of its
   * own (`stepDetail`) and this one went back to being the measurement.
   */
  stepLine(job: Job): string {
    if (job.kind === 'env-install') {
      const phase = job.envProgress?.phase;
      const verb = phase === 'download' ? 'Downloading'
        : phase === 'verify' ? 'Verifying'
          : phase === 'unpack' ? 'Unpacking'
            : phase === 'configure' ? 'Configuring'
              : 'Starting';
      return `${verb} · ${job.message ?? ''}`;
    }
    const p = job.progress;
    if (!p) return job.message ?? 'Starting…';
    /*
     * A translation counts PARAGRAPHS, and the noun has to change with the
     * number. "Translating 412 / 2,081 pages" for a 300-page book is a
     * measurement of the wrong thing, and the counts are grouped because the
     * right-hand side of this fraction reaches four digits on a real book —
     * which is also the honest signal that this job runs for hours.
     */
    if (p.phase === 'translate') {
      return `Translating ${p.page.toLocaleString()} / ${p.total.toLocaleString()} blocks`;
    }
    const verb = p.phase === 'render' ? 'Rendering' : 'Reading';
    return `${verb} ${p.page} / ${p.total} pages`;
  }

  /**
   * WHAT THE ENGINE IS ACTUALLY DOING — the step, under the count.
   *
   * ── Why a count alone cannot tell working from wedged ───────────────────────
   *
   * A block that draws a sixteen-thousand-character answer takes two minutes, is
   * rejected, and is asked twice more: six minutes on one fraction with the
   * engine talking the whole time. A row showing the fraction and nothing else
   * is precisely what a hung job looks like, and a person watching a job they
   * believe is hung kills it — an hour of GPU thrown away by the progress
   * display. `Job.note` is the last thing said that was NOT a count, cleared by
   * the next one, so it reads as "since the count last moved": empty on a run
   * that is simply progressing, and full of exactly the right sentence on one
   * that is retrying, falling back, or naming a block it could not do.
   *
   * NOTHING WITHOUT A COUNT, which is the one rule that keeps this from
   * repeating the line above it: a job with no progress yet already shows its
   * message there — "Starting the reading server…", "Writing the record onto
   * it…" — and an install's line is composed from its phase. Saying either
   * twice would be furniture.
   *
   * THE ENGINE'S OWN WORDS, merely shortened and stripped of the command prefix
   * every line carries (the row already says which job this is). Paraphrasing a
   * diagnostic is how a queue ends up saying something the log does not.
   *
   * `room` IS THE CALLER'S, AND THAT IS THE ONE THING THAT CHANGED IN THE MOVE.
   * The shelf was 320 pixels wide and cut this at 160 characters; the dropdown
   * is wider and the page is a page. One rule with the width passed in beats two
   * copies of the rule with two constants in them — the truncation is the same
   * truncation, it simply knows how much room it has been given.
   */
  stepDetail(job: Job, room = DETAIL_CHARS): string {
    if (job.kind === 'env-install' || job.progress === null) return '';
    const said = (job.note ?? '').trim();
    if (said.length === 0) return '';
    const bare = said.replace(/^(translate|vlm-convert|vlm-read|vlm-book):\s*/, '');
    return bare.length > room ? `${bare.slice(0, room - 1)}…` : bare;
  }

  /**
   * An env install names itself; everything else is named by the BOOK it is
   * about.
   *
   * IT WAS THE INPUT'S BASENAME, and for the job that matters most that was the
   * worst possible answer: a reading's input is the archived original
   * (`WorkspacePlan.sourcePath`), so the queue named the one copy of the three
   * on disk that the user has certainly never seen, in the spelling a filesystem
   * needed. The project's title is what Home and the document list call this
   * book, and the whole point of asking the library rather than the path is that
   * all three now say the same thing.
   *
   * A JOB WHOSE FILE NO PROJECT CLAIMS still gets a name rather than nothing:
   * `spokenName` is the file said aloud, which is the last resort everywhere
   * else in this app too.
   */
  label(job: Job): string {
    return job.title ?? this.projects.nameFor(job.inputPath);
  }

  /**
   * WHAT THIS JOB MADE, in the same few words the rest of the app uses for a
   * document. An install made no document at all and never reaches here, and
   * neither does a translation any more: what that one makes is a file of
   * answers about paragraphs, so its row says what a reading's says — the thing
   * itself happened, and the book follows.
   *
   * ── "EPUB" MEANS FINISHED, AND THE CAST BOOK IS NOT FINISHED ───────────────
   *
   * The user: *"im thinking we shouldnt call the working files 'epub' until we
   * export."* The word belongs to the two places a finished article is named —
   * the export modal's card and an export's row — and everywhere else the
   * evolving thing you read, curate and translate is the Book
   * (docs/WORKBENCH.md §6c, Naming).
   *
   * THE TWO ARE TOLD APART BY ASKING THE CATALOGUE, never by reading the output
   * path for a directory name. An export is a `ProjectFinal` row the moment it
   * lands (electron/job-queue.ts), so "is this file one of the project's
   * exports" is a question the library listing already answers — and it is the
   * same question the left nav asks to decide whether to draw a row for it.
   * Whole paths, folded, never a last segment: a project holds several copies of
   * one book's name at once, which is this codebase's oldest house rule.
   *
   * A JOB WHOSE OUTPUT NO PROJECT CLAIMS — or one whose landing this window has
   * not been told about yet — reads as the book, which is the safer of the two
   * wrong answers: it under-claims rather than announcing a finished article
   * that may not have been filed.
   */
  made(job: Job): string {
    if (job.kind === 'epub' && !this.filed(job)) return 'the book';
    if (job.kind === 'epub' || job.kind === 'pdf' || job.kind === 'txt') return typeLabel(job.kind);
    return 'done';
  }

  /** Whether what this job wrote was filed as one of its project's exports. */
  filed(job: Job): boolean {
    const project = this.projects.projectFor(job.outputPath);
    if (project === null) return false;
    const at = fold(job.outputPath);
    return project.exports.some((row) => fold(`${project.dir}/${row.file}`) === at);
  }

  /**
   * The two files a job touched, for the one hover a month somebody spends
   * asking where its output actually went.
   *
   * BOTH, because they are different questions and the interesting one changes
   * with the state: a job that is waiting is about what it will read, a job that
   * has landed is about what it wrote. A reading writes no document — its
   * product is the bank — so it names only its input.
   */
  paths(job: Job): string {
    if (job.kind === 'read' || job.kind === 'env-install') return job.inputPath;
    return `${job.inputPath}\n→ ${job.outputPath}`;
  }

  /**
   * What actually went wrong, out of the engine's whole stderr.
   *
   * THE FIRST LINE IS NEVER THE ANSWER, and showing it was a bug that hid every
   * failure this app can have. `job.error` is the engine's ENTIRE stderr, and
   * foundry's first line is always a configuration echo — which endpoint it is
   * using and which file said so. Every failed conversion therefore reported
   * the same harmless sentence, whatever had actually happened, and the real
   * message sat at the far end of a string nobody could see.
   *
   * The engine's contract makes the right line findable: `src/cli.ts` prints a
   * fatal as `foundry: <message>` and exits, so the LAST line beginning that
   * way is the failure. A run that died without one — killed, or a crash in a
   * child — has no such line, and then the last thing it managed to say is the
   * most informative thing there is.
   *
   * The whole stderr stays in the row's `title`, because the sentence is the
   * headline and the progress above it is often the context that explains it.
   */
  failureLine(error: string | undefined): string {
    const lines = (error ?? '').split('\n').map((line) => line.trim()).filter((l) => l.length > 0);
    if (lines.length === 0) return 'Failed';
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i]!;
      if (line.startsWith('foundry:')) return line.slice('foundry:'.length).trim() || line;
    }
    return lines[lines.length - 1]!;
  }

  reveal(job: Job): void {
    void api?.reveal(job.outputPath);
  }

  /** The OS save dialog over the export — a copy in the hand, not a hunt. */
  async saveCopy(job: Job): Promise<void> {
    try {
      await api?.saveExport(job.outputPath);
    } catch (err) {
      this.notices.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Open a finished conversion in a tab.
   *
   * `managed: true` — the book is still only in the workspace, so the tab gets
   * the unsaved dot. Re-opening one that is already open just focuses its tab
   * (OpenDocumentsService), so this button is safe to press twice.
   */
  open(job: Job): void {
    void this.documents.openFile(job.outputPath, true);
  }
}

/** One lane of the board, or the whole list when there are no lanes to draw. */
export interface BoardSection {
  /** `@for`'s identity: a resource, or `all` for the undivided list. */
  key: string;
  /** The lane's name, or null when this section is the flat list. */
  head: string | null;
  /** The occupancy, for the sections that have slots to count. */
  slots: string;
  /** What the head means, on hover — the one place the rule is spelled out. */
  hint: string;
  rows: Job[];
}

/** One slot on the bench, and whoever is standing in it. See `slots`. */
export interface SlotView {
  key: string;
  lane: Lane;
  /** 1-based, and only ever "the nth run in this lane" — see `slots`. */
  index: number;
  of: number;
  hint: string;
  occupant: Job | null;
}

/** The waiting rows of one book, in queue order. See `waitingBooks`. */
export interface BookGroup {
  key: string;
  title: string;
  rows: Job[];
}

/**
 * The two resources that are not lanes, drawn after them. Named here rather
 * than inline so the order they draw in is a fact with a place to live.
 */
const OFF_LANE: readonly JobResource[] = ['exclusive', 'unscheduled'];

/**
 * WHY A LANE IS WHAT IT IS, in a sentence, on hover.
 *
 * The board's numbers are Owen's ruling and the reasons behind them are real
 * constraints (one card, one Python), so a person wondering why their export is
 * waiting can find out without leaving the panel. No filenames and no jargon:
 * these are the same sentences the contract argues, said shorter.
 */
const LANE_HINT: Readonly<Record<string, string>> = {
  gpu: 'One at a time: the graphics card is one, and two models on it is two runs that each take twice as long.',
  cpu: 'Two at a time: compiling and reprinting are disk work, and two books at once contend for nothing.',
  exclusive: 'An installation replaces the environment every other job runs in, so nothing runs beside it and nothing behind it starts first.',
  unscheduled: 'Assembled in this window rather than by the engine, so it takes no slot and holds nothing up.',
};

/**
 * How much of the engine's sentence fits under the count by default. Two lines
 * of an eleven-pixel face in the dropdown; past that it is a log, and the
 * terminal is where a log belongs. The whole line is on the hover either way,
 * and a surface with more room passes its own number — see `stepDetail`.
 */
const DETAIL_CHARS = 160;
