/**
 * queue-view.model — the board's shapes, its fixed words, and the stage tables.
 */
import { type JobResource, type Lane } from '@owen/foundry-core/shared/queue-board';
import type { ComputeSlotKind } from '@owen/foundry-core/shared/slots';
import type { Job, JobProgress } from '@owen/foundry-core/shared/types';

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
  /**
   * WHAT THE CARD IS HEADED WITH — a machine's name on a GPU card, and "CPU ·
   * slot 1 of 2" on a CPU one.
   *
   * One string rather than the old `index`/`of` pair, because the two sides of
   * the bench are no longer counted the same way: a compute card is a PLACE and
   * says its name, and a CPU card is one of two interchangeable runs and says
   * which. A surface that had to assemble that from a lane and two numbers would
   * be deciding the vocabulary in the template.
   */
  title: string;
  /** Whose machine, for the line under the name. Null on a CPU card. */
  kind: ComputeSlotKind | null;
  hint: string;
  occupant: Job | null;
  /** Why a row is parked for this machine, in dispatch's own words. */
  waiting: string;
  /** A machine that has left the list with a run of ours still on it. */
  leaving: boolean;
}

/**
 * ONE STAGE OF A TWO-STAGE RUN, as the surfaces draw it. See `stageBars`, which
 * is the only thing that makes one.
 *
 * `active` and `done` are both carried and are never both true: `active` is the
 * stage the engine is counting now and `done` is a stage it has finished, and a
 * stage that is neither is one that has not started — which is the state a
 * surface draws dimmed. A single tri-state would say the same thing and would
 * have to be read through a comparison at every use site.
 */
export interface StageBar {
  /** `@for`'s identity, and the phase this stage IS. */
  key: 'rank' | 'verify';
  /** The stage in one word: "Ranking", "Verifying". Never a model name. */
  label: string;
  /** 0–100. Full on a finished stage, the live fraction on the counting one. */
  percent: number;
  /** True on the one stage the engine is counting. */
  active: boolean;
  /** True on a stage the run has moved past — drawn full. */
  done: boolean;
  /** "141 / 141 sentences", on the active stage only; empty on the others. */
  count: string;
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
export const OFF_LANE: readonly JobResource[] = ['exclusive', 'unscheduled'];

/**
 * WHY A LANE IS WHAT IT IS, in a sentence, on hover.
 *
 * The board's numbers are Owen's ruling and the reasons behind them are real
 * constraints (one card, one Python), so a person wondering why their export is
 * waiting can find out without leaving the panel. No filenames and no jargon:
 * these are the same sentences the contract argues, said shorter.
 */
export const LANE_HINT: Readonly<Record<string, string>> = {
  gpu: 'One at a time PER MACHINE: a graphics card is one, and two models on it is two runs that each take twice as long. A second machine is a second slot.',
  cpu: 'Two at a time: compiling and reprinting are disk work, and two books at once contend for nothing.',
  exclusive: 'An installation replaces the environment every other job runs in, so nothing runs beside it and nothing behind it starts first.',
  unscheduled: 'Assembled in this window rather than by the engine, so it takes no slot and holds nothing up.',
};

/**
 * THE CARD FOR A MACHINE THAT IS NO LONGER OFFERED, and why it is still drawn.
 *
 * A job never moves once it has started (docs/SLOTS.md §3), so switching a server
 * off while it is translating leaves the run exactly where it was. The card goes
 * when the run does.
 */
export const LEAVING_HINT
  = 'This server was switched off or removed while this run was going. A job never moves once it has started, so it finishes here.';

/**
 * THE CARD FOR WORK A SERVER IS FORWARDING, and why it is beside the machine's
 * own card rather than on it.
 *
 * crucible docs/PHASE15-HOST.md §3.3/§3.4: a text class on a server can be routed
 * to Anthropic, OpenAI or an Ollama server, and the server makes that call on the
 * operator's account — *"no lease, no lane … nothing was on the card"*. So this
 * work is not contending for that machine's GPU at all, and two of it may go at
 * once (`UPSTREAM_LANE_CAPACITY`, shared/queue-board.ts).
 */
export const UPSTREAM_HINT
  = 'Sent on by this server to the service its settings name, so it is not on that machine\'s card — two at a time, and the bill is the account\'s.';

/**
 * THE TWO STAGES OF AN ANALYSIS, IN THE ORDER THEY HAPPEN — which is also the
 * order the bars are stacked in, and the reason this is an array rather than a
 * pair of fields: the drawing walks it, so the stacking cannot get out of step
 * with the running.
 */
export const STAGE_ORDER: readonly ('rank' | 'verify')[] = ['rank', 'verify'];

/**
 * WHAT EACH STAGE IS CALLED, in words a reader owes nothing to.
 *
 * NOT MODEL NAMES, and that is the rule rather than a preference. The stages are
 * a small decide model and `qwen3.8:27b`, and a bar labelled "27b" tells a
 * person reading their own book's progress precisely nothing — it is this app's
 * bookkeeping wearing the costume of a status. What they are DOING is ranking
 * the sentences and then verifying the passages that survived, so that is what
 * the labels say (docs/ANALYSIS.md §2).
 */
export const STAGE_LABEL: Readonly<Record<'rank' | 'verify', string>> = {
  rank: 'Ranking',
  verify: 'Verifying',
};

/**
 * AND WHAT EACH OF THEM IS COUNTING — the half of the fraction that stops two
 * unrelated totals reading as one number that jumped.
 *
 * Ranking counts SENTENCES: every sentence in the book (a short one read with the
 * next), scored by the decide model. Verifying counts PASSAGES: the ranked
 * windows, one model call apiece. The engine prints the counts bare
 * (`analyze: rank 141/141`, `analyze: verify 3/20 (hate)`); the nouns are this
 * app's words for what they count, and the words the panel and the docs use.
 *
 * NEITHER OF THEM IS EVER `pages`. That noun belongs to a reading, and a queue
 * that spent it here would be measuring somebody's book in the wrong unit.
 */
export const STAGE_NOUN: Readonly<Record<'rank' | 'verify', string>> = {
  rank: 'sentences',
  verify: 'passages',
};

/**
 * The fraction and its noun — "3 / 20 passages".
 *
 * The counts are grouped for `stepLine`'s own reason: the right-hand side reaches
 * four digits on a real book, and a number that long unpunctuated is read as a
 * different number. The stage is passed rather than read off `p` so the caller's
 * narrowing is what picks the noun — there is one table and one lookup.
 */
export function stageCount(stage: 'rank' | 'verify', p: JobProgress): string {
  return `${p.page.toLocaleString()} / ${p.total.toLocaleString()} ${STAGE_NOUN[stage]}`;
}

/**
 * How much of the engine's sentence fits under the count by default. Two lines
 * of an eleven-pixel face in the dropdown; past that it is a log, and the
 * terminal is where a log belongs. The whole line is on the hover either way,
 * and a surface with more room passes its own number — see `stepDetail`.
 */
export const DETAIL_CHARS = 160;
