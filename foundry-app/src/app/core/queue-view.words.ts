/**
 * queue-view.words — what a row says: its progress, its time left, what it made and what it spent.
 */
import { signal } from '@angular/core';
import { typeLabel } from '@owen/foundry-core/shared/documents';
import { fold } from '@owen/foundry-core/shared/original';
import type { Job, JobProgress } from '@owen/foundry-core/shared/types';
import { QueueEtaService } from './queue-eta.service';
import { StageBar, STAGE_ORDER, STAGE_LABEL, STAGE_NOUN, stageCount, DETAIL_CHARS } from './queue-view.model';
import type { QueueViewService } from './queue-view.service';

/**
 * HOW FAR — the count, and nothing else on the line.
 *
 * It used to carry the engine's last sentence too, appended after a dot and
 * cut at eighty characters, because the row had one line to say everything in.
 * The step is what Owen asked to be able to see, so it moved to a line of its
 * own (`stepDetail`) and this one went back to being the measurement.
 */
export function stepLine(this: QueueViewService, job: Job): string {
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
  /*
   * A CLEANUP COUNTS THE SAME NOUN AND IS NOT THE SAME SENTENCE, which is the
   * whole reason it is a phase of its own rather than a reuse of the one above.
   * Blocks are blocks — that is the fact that made reusing it tempting — but
   * "Translating 412 / 2,081 blocks" over a run nobody asked to translate
   * anything is a surface reporting the wrong act, and this line is the one
   * place a person watching a night of GPU finds out what it is doing.
   *
   * A SIMPLIFY IS DELIBERATELY NOT A PHASE. It spawns `translate --rewrite` and
   * the engine counts on its own `translate:` line, so the words above are the
   * engine's own account of what is happening; what tells a rewrite from a
   * translation on the shelf is the ROW's title, which says the mode as well.
   * A phase invented on this side to relabel somebody else's counting line
   * would be this app narrating a run it is only watching.
   */
  if (p.phase === 'clean') {
    return `Cleaning ${p.page.toLocaleString()} / ${p.total.toLocaleString()} blocks`;
  }
  /*
   * THE QUESTION BEFORE A CLEANUP, in the same noun and a different verb, for
   * the reason the cleanup has a sentence of its own one line up: the row after
   * this one is the cleaning, and two rows both saying "Cleaning" would read as
   * one run that started over.
   */
  if (p.phase === 'triage') {
    return `Checking ${p.page.toLocaleString()} / ${p.total.toLocaleString()} blocks`;
  }
  /*
   * AN ANALYSIS COUNTS TWO DIFFERENT THINGS AND THIS LINE NAMES THE ONE IT IS
   * COUNTING NOW. It said "Analysing 3 / 20" for both halves while the phase
   * was one member, on the argument that no other wording was true of both —
   * and the fix was not a better sentence but a truer field: the stage reaches
   * `JobProgress.phase` now, so the line can say which pass this is and what it
   * is counting. 141 sentences becoming 20 verify calls is an ordinary book
   * (docs/ANALYSIS.md §2), and the nouns are what keep the two from reading as
   * one measurement that jumped.
   *
   * THE NOUN THAT MUST NEVER APPEAR HERE IS `pages`: a sentence is not a page
   * and a passage is not a page. Both nouns are declared once, in `STAGE_NOUN`
   * below, so this line and the stage bars can never disagree about them.
   */
  if (p.phase === 'rank' || p.phase === 'verify') {
    return `${STAGE_LABEL[p.phase]} ${stageCount(p.phase, p)}`;
  }
  const verb = p.phase === 'render' ? 'Rendering' : 'Reading';
  return `${verb} ${p.page} / ${p.total} pages`;
}

/**
 * THE TWO STAGES OF AN ANALYSIS, AS TWO BARS — or null for every other row in
 * this queue, which is all of them.
 *
 * ── The complaint, and why a wording could not answer it ────────────────────
 *
 * Owen, 2026-08-25: *"right now it looks like it does the first pass, 1-100,
 * and the same progress bar starts over for the 27b run at 0% and goes to
 * 100%. could be good to have two different smaller progress bars, after the
 * bookforge queue model."* A run ranks every sentence on a small decide model
 * and then verifies the ranked passages with the large one (docs/ANALYSIS.md
 * §2) — two rows since 2026-09-25, but the same two stages, and one bar drawn over both is a measurement that
 * completes and then un-completes — which is what a glitch looks like, no
 * matter what the sentence under it says.
 *
 * ── What it is derived from, and what it deliberately is not ────────────────
 *
 * THE PHASE, AND NOTHING ELSE. `kind === 'analysis'` names the same set of rows
 * — nothing else in this app emits either phase — but the phase says which of
 * the two is counting as well as that there are two, so asking BOTH questions
 * would be two facts that can disagree about one row, and the day they did the
 * bars would draw for a job whose stage nobody could name. One question.
 *
 * NOTHING IS WRITTEN AND NOTHING IS REMEMBERED. The full bar 1 under a `verify`
 * count is not a stored fact about the run — it is arithmetic, and it is sound
 * because verification cannot begin until ranking has finished. That is the
 * same move `job-queue.ts`'s watcher makes when a `read` count arrives over a
 * `render` one (it snaps the render bar to its total), except that this one
 * happens at the drawing rather than on the row, because the renderer never
 * edits a job.
 *
 * NULL UNTIL THE FIRST COUNT, which is a few seconds of every run: the row
 * falls through to the single indeterminate bar every other job gets before it
 * has a fraction, because two empty bars labelled with stages that have not
 * started is a display asserting a shape it cannot yet measure.
 */
export function stageBars(this: QueueViewService, job: Job): StageBar[] | null {
  const p = job.progress;
  if (p === null || p.total <= 0) return null;
  if (p.phase !== 'rank' && p.phase !== 'verify') return null;
  const here = Math.min(100, Math.round((p.page / p.total) * 100));
  return STAGE_ORDER.map((key) => {
    const active = key === p.phase;
    // Ranking is finished the moment a verify count exists. See above.
    const done = key === 'rank' && p.phase === 'verify';
    return {
      key,
      label: STAGE_LABEL[key],
      percent: done ? 100 : active ? here : 0,
      active,
      done,
      count: active ? stageCount(key, p) : '',
    };
  });
}

/**
 * HOW MUCH LONGER — "~3m left", or the empty string when nothing true can be
 * said about it yet.
 *
 * THE MEASUREMENT IS `QueueEtaService`'s and the whole argument lives there:
 * a rate over a sliding window of the counts as they arrived, restarted at
 * every phase boundary, retired when the count stops moving. This is the one
 * line the surfaces call, and the empty string is what lets them draw it with
 * `@if` and nothing else — a row that has no estimate draws no estimate, and
 * neither surface has to know why.
 *
 * IT IS BESIDE THE COUNT AND NEVER INSTEAD OF IT. The fraction is a
 * measurement of what has happened; this is a forecast of what has not, and
 * the tilde is the whole of the difference a person needs. An estimate that
 * replaced the count would be this app trading the fact it knows for the guess
 * it made.
 */
export function timeLeft(this: QueueViewService, job: Job): string {
  return this.eta.forJob(job) ?? '';
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
export function stepDetail(this: QueueViewService, job: Job, room = DETAIL_CHARS): string {
  if (job.progress === null) return '';
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
export function label(this: QueueViewService, job: Job): string {
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
export function made(this: QueueViewService, job: Job): string {
  if (job.kind === 'epub' && !this.filed(job)) return 'the book';
  if (job.kind === 'epub' || job.kind === 'pdf' || job.kind === 'txt') return typeLabel(job.kind);
  /*
   * AN ANALYSIS MADE A REPORT AND SAYS SO, where a reading and a translation
   * say "done" — and the difference is that those two are followed by something
   * a person opens (the book follows from a bank; a book is cast from records),
   * so their rows would be claiming the wrong product. A report is the whole of
   * what an analysis makes, and it is on its step waiting to be read.
   */
  if (job.kind === 'analysis') return 'the report';
  return 'done';
}

/**
 * WHAT THE RUN SPENT, in tokens — or the empty string, which is nearly always.
 *
 * ── The two numbers, and the one that is deliberately missing ─────────────
 *
 * `1,203,441 in / 388,120 out`. There is no price on it and there will not be
 * one: docs/VLLM.md §2a rules that *"foundry does not price it"* — prices
 * change weekly and differ per key and per tier, so a figure invented in this
 * app would be wrong in a way that looks authoritative. The counts are what the
 * provider itself reported, and a person who wants dollars has them on a page
 * the provider keeps.
 *
 * ── Empty is the ordinary case and means "nothing counted" ────────────────
 *
 * `Job.usage` is set only when the engine printed its usage line, which it does
 * only when the server counted. An Ollama door does not count, so a run routed
 * through one has no usage at all — and an empty string is what every surface here
 * already draws for a fact a row does not have. The request count rides in the
 * tooltip rather than the line: three numbers in a row on a card is a table,
 * and the two that answer "what did this cost" are the tokens.
 *
 * ONE COMPOSER, TWO SURFACES — the bench card and the finished table, which is
 * why it is here and not on the page. The dropdown panel does not draw it: it
 * has room for one line about a running row and that line is progress.
 */
export function spent(this: QueueViewService, job: Job): string {
  const usage = job.usage;
  if (usage === undefined) return '';
  const n = (value: number): string => value.toLocaleString();
  return `${n(usage.tokensIn)} in / ${n(usage.tokensOut)} out`;
}

/** The same fact said longer, for a hover — the request count belongs here. */
export function spentDetail(this: QueueViewService, job: Job): string {
  const usage = job.usage;
  if (usage === undefined) return '';
  const n = (value: number): string => value.toLocaleString();
  return `${n(usage.requests)} requests, ${n(usage.tokensIn)} tokens in, `
    + `${n(usage.tokensOut)} out. Foundry does not price this — the provider does.`;
}

/** Whether what this job wrote was filed as one of its project's exports. */
export function filed(this: QueueViewService, job: Job): boolean {
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
export function paths(this: QueueViewService, job: Job): string {
  if (job.kind === 'read') return job.inputPath;
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
export function failureLine(this: QueueViewService, error: string | undefined): string {
  const lines = (error ?? '').split('\n').map((line) => line.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return 'Failed';
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (line.startsWith('foundry:')) return line.slice('foundry:'.length).trim() || line;
  }
  return lines[lines.length - 1]!;
}
